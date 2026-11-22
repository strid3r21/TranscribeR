"""TranscribeR - a web front end for llama-swap hosted speech-to-text models."""

from __future__ import annotations

import array
import asyncio
import json
import logging
import os
import re
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import asr
import diarize
import moss
import redact
import settings as cfg

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper(),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("transcriber")

PEAK_BINS = 2000
ACTIVE_STATES = {"processing", "queued", "transcribing", "diarizing"}
queue: asyncio.Queue[tuple[str, dict]] = asyncio.Queue()
PROGRESS: dict[str, dict] = {}  # live, in-memory job progress per file

# --------------------------------------------------------------------------- #
# Storage helpers
# --------------------------------------------------------------------------- #

ID_RE = re.compile(r"^[a-f0-9]{32}$")


def fdir(fid: str) -> Path:
    if not ID_RE.match(fid):
        raise HTTPException(404, "File not found")
    return cfg.FILES_DIR / fid


def write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    tmp.replace(path)


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def load_meta(fid: str) -> dict:
    meta = read_json(fdir(fid) / "meta.json")
    if meta is None:
        raise HTTPException(404, "File not found")
    return meta


def update_meta(fid: str, **changes: Any) -> dict:
    meta = load_meta(fid)
    meta.update(changes)
    write_json(fdir(fid) / "meta.json", meta)
    return meta


def public_meta(meta: dict) -> dict:
    d = fdir(meta["id"])
    out = dict(meta)
    out["has_transcript"] = (d / "transcript.json").exists()
    out["has_audio"] = (d / "audio.mp3").exists()
    if meta.get("status") in ("transcribing", "diarizing") and meta.get("started_at"):
        out["elapsed"] = round(time.time() - meta["started_at"], 1)
        out["progress"] = PROGRESS.get(meta["id"])
    return out


# --------------------------------------------------------------------------- #
# Upload preparation
# --------------------------------------------------------------------------- #


async def probe(path: Path) -> dict:
    code, out, err = await asr.run("ffprobe", "-v", "error", "-print_format", "json",
                                   "-show_format", "-show_streams", str(path))
    if code != 0:
        raise RuntimeError(f"Not a readable media file: {err.decode(errors='ignore')[-300:]}")
    return json.loads(out or b"{}")


def is_mp3(info: dict) -> bool:
    fmt = info.get("format", {}).get("format_name", "")
    audio = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    video = [s for s in info.get("streams", [])
             if s.get("codec_type") == "video" and s.get("disposition", {}).get("attached_pic") != 1]
    return "mp3" in fmt and len(audio) == 1 and audio[0].get("codec_name") == "mp3" and not video


async def compute_peaks(audio: Path, duration: float) -> list[float]:
    rate = int(max(200, min(4000, 8_000_000 / max(duration, 1))))
    code, out, _ = await asr.run("ffmpeg", "-v", "error", "-i", str(audio), "-ac", "1",
                                 "-ar", str(rate), "-f", "s16le", "-")
    if code != 0 or not out:
        return []
    samples = array.array("h")
    samples.frombytes(out[: len(out) - (len(out) % 2)])
    n = len(samples)
    bins = min(PEAK_BINS, n) or 1
    step = n / bins
    peaks = []
    for i in range(bins):
        chunk = samples[int(i * step): max(int((i + 1) * step), int(i * step) + 1)]
        peaks.append(max(max(chunk), -min(chunk)) if chunk else 0)
    top = max(peaks) or 1
    return [round(p / top, 3) for p in peaks]


async def prepare_file(fid: str) -> None:
    """Probe the upload, convert to mp3 if needed, compute waveform peaks."""
    d = fdir(fid)
    meta = load_meta(fid)
    original = d / meta["original_file"]
    audio = d / "audio.mp3"
    try:
        info = await probe(original)
        if not any(s.get("codec_type") == "audio" for s in info.get("streams", [])):
            raise RuntimeError("No audio stream found in this file")
        source_format = info.get("format", {}).get("format_long_name") or info.get("format", {}).get("format_name")
        if is_mp3(info):
            shutil.copyfile(original, audio)
            converted = False
        else:
            # Constant bit-rate so browser seeking is sample accurate.
            code, _, err = await asr.run("ffmpeg", "-y", "-v", "error", "-i", str(original), "-vn",
                                         "-map", "0:a:0", "-c:a", "libmp3lame", "-b:a", cfg.MP3_BITRATE, str(audio))
            if code != 0:
                raise RuntimeError(f"ffmpeg conversion failed: {err.decode(errors='ignore')[-300:]}")
            converted = True
        original.unlink(missing_ok=True)  # the mp3 is the canonical copy
        ainfo = await probe(audio)
        duration = float(ainfo.get("format", {}).get("duration") or 0)
        write_json(d / "peaks.json", await compute_peaks(audio, duration))
        meta = update_meta(fid, status="ready", duration=duration, converted=converted,
                           source_format=source_format, error=None)
        if meta.get("auto_transcribe", cfg.AUTO_TRANSCRIBE):
            await enqueue(fid, meta.get("upload_opts") or {})
    except Exception as exc:  # noqa: BLE001
        log.exception("prepare failed for %s", fid)
        update_meta(fid, status="error", error=str(exc))


# --------------------------------------------------------------------------- #
# Jobs
# --------------------------------------------------------------------------- #


def set_progress(fid: str, **values: Any) -> None:
    PROGRESS.setdefault(fid, {}).update(values)


VOICES_PATH = cfg.DATA_DIR / "voices.json"


def load_voices() -> list[dict]:
    return read_json(VOICES_PATH, {"voices": []}).get("voices", [])


def save_voices(voices: list[dict]) -> None:
    write_json(VOICES_PATH, {"voices": voices})


def remember_voice(name: str, vec, count: int) -> dict:
    """Create or refine a saved voice profile (running weighted average)."""
    import numpy as np

    voices = load_voices()
    v = next((v for v in voices if v["name"].strip().lower() == name.strip().lower()), None)
    if v:
        old = np.array(v["emb"], dtype=np.float32) * min(v.get("n", 1), 60)
        merged = old + vec * count
        merged /= float(np.linalg.norm(merged)) or 1.0
        v.update(emb=[round(float(x), 5) for x in merged], n=v.get("n", 1) + count, updated=time.time())
    else:
        v = {"id": uuid.uuid4().hex[:12], "name": name.strip()[:80], "n": count, "updated": time.time(),
             "emb": [round(float(x), 5) for x in vec]}
        voices.append(v)
    save_voices(voices)
    return v


def name_from_voices(speakers: dict, centroids: dict) -> dict:
    """Rename diarized speakers that match a saved voice; strips internal keys."""
    voices = load_voices()
    matched = diarize.match_voices(centroids, voices) if voices and centroids else {}
    out = {}
    for label, info in speakers.items():
        v = matched.get(info.get("_idx"))
        out[label] = {"name": v["name"], "voice": v["id"]} if v else {"name": info["name"]}
    return out


async def run_diarization(fid: str, audio: Path, num_speakers: int):
    """Returns (turns, centroids, samples)."""
    loop = asyncio.get_running_loop()
    set_progress(fid, speakers=0.0)

    def progress(frac: float) -> None:
        loop.call_soon_threadsafe(lambda: set_progress(fid, speakers=round(frac, 3)))

    def work():
        samples = diarize.load_samples(audio)
        turns = diarize.diarize(samples, num_speakers, progress)
        cents = diarize.cluster_centroids(samples, turns) if load_voices() else {}
        return turns, cents, samples

    t0 = time.time()
    turns, cents, samples = await loop.run_in_executor(None, work)
    log.info("speaker detection took %.1fs", time.time() - t0)
    set_progress(fid, speakers=1.0)
    return turns, cents, samples


async def job_transcribe(fid: str, opts: dict) -> None:
    d = fdir(fid)
    meta = update_meta(fid, status="transcribing", started_at=time.time(), error=None,
                       model=opts.get("model") or cfg.DEFAULT_MODEL)
    audio = d / "audio.mp3"
    PROGRESS[fid] = {"stage": "starting"}
    num_speakers = diarize.parse_speakers(opts.get("speakers")) if diarize.available() else None
    diar_task: Optional[asyncio.Task] = None
    try:
        t0 = time.time()
        notes: list = []
        if moss.is_local(meta["model"]) or moss.is_remote(meta["model"]):
            if moss.is_local(meta["model"]) and not moss.available():
                raise RuntimeError("The built-in MOSS engine isn't available in this container")
            # MOSS detects speakers itself (diarization models only link speakers across chunks).
            mspk = diarize.parse_speakers(opts.get("speakers"))
            result = await moss.transcribe_file(audio, meta.get("duration") or 0, opts, d / "work",
                                                lambda p: set_progress(fid, **p), mspk, bool(load_voices()))
            words, notes = result["words"], result["notes"]
            speakers = name_from_voices(result["speakers"], result["centroids"]) if result["speakers"] else {}
        else:
            if num_speakers is not None:  # CPU-bound; runs alongside the GPU transcription
                diar_task = asyncio.create_task(run_diarization(fid, audio, num_speakers))
            result = await asr.transcribe_file(audio, meta.get("duration") or 0, opts, d / "work",
                                               lambda p: set_progress(fid, **p))
            speakers = {}
            turns, cents = None, {}
            if diar_task:
                set_progress(fid, stage="speakers")
                try:
                    turns, cents, _ = await diar_task
                except Exception as exc:  # noqa: BLE001
                    log.exception("diarization failed for %s", fid)
            words = asr.finalize_words(result["spans"], result["silences"], turns)
            if turns:
                speakers = name_from_voices(asr.assign_speakers(words, turns), cents)
        segments = asr.build_segments(words)
        asr.score_segments(segments)
        for a, b, msg in notes:
            for seg in segments:
                if seg["start"] < b and seg["end"] > a:
                    seg["issues"].append(msg)
                    break
        redact.reapply(segments, load_redactions(d)["entries"])
        prev = read_json(d / "transcript.json") or {}
        transcript = {"model": result["model"], "api": result["api"], "created": time.time(),
                      "markers": prev.get("markers") or [],
                      "duration": meta.get("duration"), "speakers": speakers, "segments": segments,
                      "timing": "estimated" if any(w.get("est") for w in words) else "model"}
        write_json(d / "transcript.orig.json", transcript)
        write_json(d / "transcript.json", transcript)
        update_meta(fid, status="done", transcribed_at=time.time(), transcribe_seconds=round(time.time() - t0, 1),
                    api=result["api"], chunks=result["chunks"], speaker_count=len(speakers))
    except Exception as exc:  # noqa: BLE001
        log.exception("transcription failed for %s", fid)
        if diar_task and not diar_task.done():
            diar_task.cancel()
        msg = str(exc)
        if isinstance(exc, asr.ContextTooLarge):
            msg = f"Audio chunk too large for the model's context even after splitting: {msg[:300]}"
        update_meta(fid, status="error", error=msg)
    finally:
        PROGRESS.pop(fid, None)
        shutil.rmtree(d / "work", ignore_errors=True)


async def job_diarize(fid: str, opts: dict) -> None:
    """Re-detect speakers on an existing (possibly edited) transcript without re-transcribing."""
    d = fdir(fid)
    prev_status = "done"
    update_meta(fid, status="diarizing", started_at=time.time(), error=None)
    PROGRESS[fid] = {"stage": "speakers"}
    try:
        n = diarize.parse_speakers(opts.get("speakers") or "auto") or -1
        turns, cents, _ = await run_diarization(fid, d / "audio.mp3", n)
        t = read_json(d / "transcript.json")
        segs = t["segments"]
        # Assign per segment by majority overlap (keeps the user's segment edits intact).
        pseudo = [{"w": s["text"] + ".", "s": s["start"], "e": max(s["end"], s["start"] + 0.05)} for s in segs]
        speakers = name_from_voices(asr.assign_speakers(pseudo, turns), cents)
        # Carry user-given names over: each new speaker inherits the old speaker it overlaps most.
        old_names = {k: v.get("name") for k, v in (t.get("speakers") or {}).items()}
        overlap: dict[tuple[str, str], float] = {}
        for s, p in zip(segs, pseudo):
            if s.get("speaker") and p.get("spk"):
                key = (p["spk"], s["speaker"])
                overlap[key] = overlap.get(key, 0.0) + (s["end"] - s["start"])
        used: set[str] = set()
        for (new, old), _ in sorted(overlap.items(), key=lambda kv: -kv[1]):
            if (new in speakers and old not in used and not speakers[new].get("_named")
                    and not speakers[new].get("voice") and old_names.get(old)):
                speakers[new] = {"name": old_names[old], "_named": True}
                used.add(old)
        speakers = {k: {"name": v["name"]} for k, v in speakers.items()}
        for s, p in zip(segs, pseudo):
            s["speaker"] = p.get("spk")
            s.pop("spk_locked", None)
            s.pop("spk_conf", None)
        t["speakers"] = speakers
        write_json(d / "transcript.json", t)
        update_meta(fid, status=prev_status, speaker_count=len(speakers))
    except Exception as exc:  # noqa: BLE001
        log.exception("diarization failed for %s", fid)
        update_meta(fid, status=prev_status, error=f"Speaker detection failed: {exc}")
    finally:
        PROGRESS.pop(fid, None)


async def job_identify(fid: str, opts: dict) -> None:
    """Re-label every segment by voice, learning from the segments the user tagged."""
    d = fdir(fid)
    update_meta(fid, status="diarizing", started_at=time.time(), error=None)
    PROGRESS[fid] = {"stage": "voices", "label": "Matching voices to your examples"}
    loop = asyncio.get_running_loop()

    def progress(frac: float) -> None:
        loop.call_soon_threadsafe(lambda: set_progress(fid, speakers=round(frac, 3)))

    try:
        t = read_json(d / "transcript.json")
        cache = read_json(d / "embeddings.json", {})

        def work():
            samples = diarize.load_samples(d / "audio.mp3")
            embs = diarize.segment_embeddings(samples, t["segments"], cache, progress)
            stats = diarize.identify(t["segments"], embs, t.get("speakers") or {}, load_voices())
            return embs, stats

        embs, stats = await loop.run_in_executor(None, work)
        write_json(d / "embeddings.json", cache)
        if opts.get("remember"):
            for sid, info in (t.get("speakers") or {}).items():
                vec, n = diarize.voice_from_segments(t["segments"], embs, sid)
                if vec is not None and not info.get("name", "").lower().startswith("speaker "):
                    info["voice"] = remember_voice(info["name"], vec, min(n, 20))["id"]
        write_json(d / "transcript.json", t)
        log.info("voice identification for %s: %s", fid, stats)
        update_meta(fid, status="done", speaker_count=len(t.get("speakers") or {}),
                    last_identify={**stats, "at": time.time()})
    except ValueError as exc:
        update_meta(fid, status="done", error=str(exc))
    except Exception as exc:  # noqa: BLE001
        log.exception("identify failed for %s", fid)
        update_meta(fid, status="done", error=f"Voice matching failed: {exc}")
    finally:
        PROGRESS.pop(fid, None)


async def enqueue(fid: str, opts: dict) -> None:
    update_meta(fid, status="queued", error=None, queued_opts=opts)
    await queue.put((fid, opts))


async def worker() -> None:
    while True:
        fid, opts = await queue.get()
        try:
            if (cfg.FILES_DIR / fid / "audio.mp3").exists():
                if opts.get("job") == "diarize":
                    await job_diarize(fid, opts)
                elif opts.get("job") == "identify":
                    await job_identify(fid, opts)
                else:
                    await job_transcribe(fid, opts)
            elif (cfg.FILES_DIR / fid / "meta.json").exists():
                update_meta(fid, status="error", error="Audio file is missing")
        except Exception:  # noqa: BLE001
            log.exception("worker error")
        finally:
            queue.task_done()


_background: set[asyncio.Task] = set()


def spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    cfg.FILES_DIR.mkdir(parents=True, exist_ok=True)
    spawn(worker())
    for meta_path in sorted(cfg.FILES_DIR.glob("*/meta.json")):  # recover interrupted work
        meta = read_json(meta_path)
        if not meta:
            continue
        if meta.get("status") == "processing":
            spawn(prepare_file(meta["id"]))
        elif meta.get("status") in ("queued", "transcribing", "diarizing"):
            await enqueue(meta["id"], meta.get("queued_opts") or {})
    yield


app = FastAPI(title="TranscribeR", lifespan=lifespan)

# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #


@app.get("/api/config")
async def config() -> dict:
    models: list[str] = []
    error = None
    try:
        models = sorted(m["id"] for m in await asr.list_models())
    except Exception as exc:  # noqa: BLE001
        error = f"Could not reach llama-swap at {cfg.LLAMA_SWAP_URL}: {exc}"
    local = [moss.MODEL_ID] if moss.available() else []
    return {"models": local + [m for m in models if m not in local], "local_models": local,
            "remote_count": len(models), "default_model": cfg.DEFAULT_MODEL, "default_language": cfg.DEFAULT_LANGUAGE,
            "uncertainty_threshold": cfg.UNCERTAINTY_THRESHOLD, "word_threshold": cfg.WORD_THRESHOLD,
            "auto_transcribe": cfg.AUTO_TRANSCRIBE, "backend": cfg.LLAMA_SWAP_URL, "backend_error": error,
            "diarization_available": diarize.available(), "diarization_default": cfg.DIARIZATION}


@app.get("/api/files")
async def list_files() -> list[dict]:
    metas = [read_json(p) for p in cfg.FILES_DIR.glob("*/meta.json")]
    metas = [public_meta(m) for m in metas if m]
    return sorted(metas, key=lambda m: m.get("created", 0), reverse=True)


@app.post("/api/files")
async def upload(file: UploadFile = File(...), model: Optional[str] = Form(None),
                 language: Optional[str] = Form(None), speakers: Optional[str] = Form(None),
                 auto: Optional[bool] = Form(None)) -> dict:
    fid = uuid.uuid4().hex
    d = cfg.FILES_DIR / fid
    d.mkdir(parents=True)
    name = Path(file.filename or "audio").name
    ext = re.sub(r"[^a-z0-9]", "", Path(name).suffix.lower())[:8] or "bin"
    original = f"original.{ext}"
    size = 0
    limit = cfg.MAX_UPLOAD_MB * 1024 * 1024
    try:
        with (d / original).open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, f"File exceeds {cfg.MAX_UPLOAD_MB} MB limit")
                out.write(chunk)
    except BaseException:
        shutil.rmtree(d, ignore_errors=True)
        raise
    opts = {k: v for k, v in {"model": model, "language": language, "speakers": speakers}.items() if v}
    meta = {"id": fid, "name": name, "original_file": original, "size": size, "created": time.time(),
            "status": "processing", "error": None,
            "auto_transcribe": cfg.AUTO_TRANSCRIBE if auto is None else auto, "upload_opts": opts}
    write_json(d / "meta.json", meta)
    spawn(prepare_file(fid))
    return public_meta(meta)


@app.get("/api/files/{fid}")
async def get_file(fid: str) -> dict:
    return public_meta(load_meta(fid))


class RenameBody(BaseModel):
    name: str


@app.patch("/api/files/{fid}")
async def rename_file(fid: str, body: RenameBody) -> dict:
    name = body.name.strip()[:200]
    if not name:
        raise HTTPException(400, "Name required")
    return public_meta(update_meta(fid, name=name))


@app.delete("/api/files/{fid}")
async def delete_file(fid: str) -> dict:
    d = fdir(fid)
    if not d.exists():
        raise HTTPException(404, "File not found")
    shutil.rmtree(d, ignore_errors=True)
    PROGRESS.pop(fid, None)
    return {"ok": True}


@app.delete("/api/files/{fid}/audio")
async def delete_audio(fid: str) -> dict:
    """Free up space: remove the audio but keep the transcript."""
    meta = load_meta(fid)
    if meta["status"] in ACTIVE_STATES:
        raise HTTPException(409, f"File is {meta['status']}, try again when it has finished")
    d = fdir(fid)
    for name in ("audio.mp3", "audio.original.mp3", "peaks.json", meta.get("original_file") or ""):
        if name:
            (d / name).unlink(missing_ok=True)
    return public_meta(update_meta(fid, audio_deleted=True, size=0))


class BulkDelete(BaseModel):
    ids: list[str]
    audio_only: bool = False


@app.post("/api/files/delete")
async def bulk_delete(body: BulkDelete) -> dict:
    done, skipped = [], []
    for fid in body.ids:
        try:
            if body.audio_only:
                await delete_audio(fid)
            else:
                await delete_file(fid)
            done.append(fid)
        except HTTPException:
            skipped.append(fid)
    return {"deleted": done, "skipped": skipped}


@app.get("/api/files/{fid}/audio")
async def get_audio(fid: str) -> FileResponse:
    path = fdir(fid) / "audio.mp3"
    if not path.exists():
        raise HTTPException(404, "Audio not available")
    return FileResponse(path, media_type="audio/mpeg")


@app.get("/api/files/{fid}/peaks")
async def get_peaks(fid: str) -> list:
    return read_json(fdir(fid) / "peaks.json", [])


class TranscribeBody(BaseModel):
    model: Optional[str] = None
    language: Optional[str] = None
    prompt: Optional[str] = None
    speakers: Optional[str] = None


@app.post("/api/files/{fid}/transcribe")
async def start_transcription(fid: str, body: TranscribeBody) -> dict:
    meta = load_meta(fid)
    if meta["status"] in ACTIVE_STATES:
        raise HTTPException(409, f"File is already {meta['status']}")
    if not (fdir(fid) / "audio.mp3").exists():
        raise HTTPException(409, "Audio is not available")
    await enqueue(fid, body.model_dump(exclude_none=True))
    return public_meta(load_meta(fid))


class DiarizeBody(BaseModel):
    speakers: Optional[str] = "auto"


@app.post("/api/files/{fid}/diarize")
async def start_diarize(fid: str, body: DiarizeBody) -> dict:
    meta = load_meta(fid)
    if not diarize.available():
        raise HTTPException(501, "Speaker detection models are not installed in this image")
    if meta["status"] in ACTIVE_STATES:
        raise HTTPException(409, f"File is already {meta['status']}")
    if not (fdir(fid) / "audio.mp3").exists() or not (fdir(fid) / "transcript.json").exists():
        raise HTTPException(409, "Needs both audio and a transcript")
    await enqueue(fid, {"job": "diarize", "speakers": body.speakers or "auto"})
    return public_meta(load_meta(fid))


@app.get("/api/files/{fid}/transcript")
async def get_transcript(fid: str) -> dict:
    t = read_json(fdir(fid) / "transcript.json")
    if t is None:
        raise HTTPException(404, "No transcript yet")
    return with_redactions(fdir(fid), t)


SEG_KEYS = {"id", "start", "end", "text", "speaker", "words", "reviewed", "edited",
            "confidence", "issues", "low_words", "spk_locked", "spk_conf", "redacted"}


class TranscriptIn(BaseModel):
    segments: list[dict]
    speakers: Optional[dict] = None
    markers: Optional[list[dict]] = None


COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def clean_markers(items: list[dict]) -> list[dict]:
    out = []
    for m in items[:500]:
        try:
            t = max(0.0, float(m["t"]))
            end = float(m["end"]) if m.get("end") is not None else None
        except (KeyError, TypeError, ValueError):
            continue
        if end is not None and end <= t:
            end = None
        color = str(m.get("color") or "")
        out.append({"id": str(m.get("id") or uuid.uuid4().hex[:10])[:20], "t": round(t, 3),
                    "end": round(end, 3) if end is not None else None,
                    "label": str(m.get("label") or "")[:120], "color": color if COLOR_RE.match(color) else "#22c55e"})
    return sorted(out, key=lambda m: m["t"])


@app.put("/api/files/{fid}/transcript")
async def save_transcript(fid: str, body: TranscriptIn) -> dict:
    if load_meta(fid)["status"] in ACTIVE_STATES:
        raise HTTPException(409, "A job is running on this file; changes will be saved when it finishes")
    path = fdir(fid) / "transcript.json"
    t = read_json(path)
    if t is None:
        raise HTTPException(404, "No transcript yet")
    segs = []
    for s in body.segments:
        try:
            seg = {k: v for k, v in s.items() if k in SEG_KEYS}
            seg["start"], seg["end"] = float(seg["start"]), float(seg["end"])
            seg["text"] = str(seg.get("text", ""))
            segs.append(seg)
        except (KeyError, TypeError, ValueError):
            raise HTTPException(422, "Invalid segment") from None
    t["segments"] = sorted(segs, key=lambda s: s["start"])
    if body.markers is not None:
        t["markers"] = clean_markers(body.markers)
    if body.speakers is not None:
        t["speakers"] = {str(k): {"name": str((v or {}).get("name", k))[:80],
                                  **({"voice": v["voice"]} if (v or {}).get("voice") else {})}
                         for k, v in body.speakers.items()}
    t["updated"] = time.time()
    write_json(path, t)
    d = fdir(fid)
    store = load_redactions(d)
    gone = set(store["entries"]) - redact.token_ids(t["segments"])
    for rid in gone:  # the user deleted the bar: treat it as erased
        await _erase(fid, d, t, store, rid)
    if gone:
        save_redactions(d, store)
    return {"ok": True, "updated": t["updated"]}


@app.post("/api/files/{fid}/transcript/revert")
async def revert_transcript(fid: str) -> dict:
    d = fdir(fid)
    orig = read_json(d / "transcript.orig.json")
    if orig is None:
        raise HTTPException(404, "No original transcript")
    orig["markers"] = (read_json(d / "transcript.json") or {}).get("markers") or []
    redact.reapply(orig["segments"], load_redactions(d)["entries"])
    write_json(d / "transcript.json", orig)
    return with_redactions(d, orig)


class RedactBody(BaseModel):
    phrase: str
    segment_id: Optional[int] = None  # None = every occurrence in the file
    offset: Optional[int] = None      # character offset of the selection inside that segment
    mute_audio: bool = False


def load_redactions(d: Path) -> dict:
    store = read_json(d / "redactions.json", {}) or {}
    store.setdefault("entries", {})
    return store


def save_redactions(d: Path, store: dict) -> None:
    write_json(d / "redactions.json", store)


def with_redactions(d: Path, t: dict) -> dict:
    """Transcript payload for the browser: redaction ids/flags only, never the hidden text."""
    store = load_redactions(d)
    t = dict(t)
    t.setdefault("speakers", {})
    t.setdefault("markers", [])
    t["redactions"] = {rid: {"muted": bool(e.get("muted"))} for rid, e in store["entries"].items()}
    return t


async def _encode(src: Path, dest: Path, spans: list) -> None:
    filt = redact.mute_filter(spans)
    tmp = dest.with_name(dest.stem + ".building.mp3")
    args = ["ffmpeg", "-y", "-v", "error", "-i", str(src)] + (["-af", filt] if filt else []) + \
           ["-c:a", "libmp3lame", "-b:a", cfg.MP3_BITRATE, str(tmp)]
    code, _, err = await asr.run(*args)
    if code != 0:
        tmp.unlink(missing_ok=True)
        raise HTTPException(500, f"Audio processing failed: {err.decode(errors='ignore')[-300:]}")
    tmp.replace(dest)


async def rebuild_audio(fid: str, d: Path, store: dict) -> bool:
    """audio.mp3 = untouched backup with every currently-muted redaction silenced."""
    backup = d / "audio.original.mp3"
    if not backup.exists() or not (d / "audio.mp3").exists():
        return False
    spans = [e["span"] for e in store["entries"].values() if e.get("muted")]
    if spans:
        await _encode(backup, d / "audio.mp3", spans)
    else:
        shutil.copyfile(backup, d / "audio.mp3")
    meta = load_meta(fid)
    write_json(d / "peaks.json", await compute_peaks(d / "audio.mp3", meta.get("duration") or 0))
    (d / "embeddings.json").unlink(missing_ok=True)
    update_meta(fid, audio_version=int(meta.get("audio_version") or 0) + 1)
    return True


def _editable(fid: str) -> tuple[Path, dict]:
    meta = load_meta(fid)
    if meta["status"] in ACTIVE_STATES:
        raise HTTPException(409, f"File is {meta['status']}, try again when it has finished")
    d = fdir(fid)
    t = read_json(d / "transcript.json")
    if t is None:
        raise HTTPException(404, "No transcript yet")
    return d, t


@app.post("/api/files/{fid}/redact")
async def redact_text(fid: str, body: RedactBody) -> dict:
    d, t = _editable(fid)
    phrase = body.phrase.strip()
    if not phrase or redact.TOKEN_RE.fullmatch(phrase):
        raise HTTPException(400, "Select some text to redact")
    if body.segment_id is not None:
        seg = next((s for s in t["segments"] if s["id"] == body.segment_id), None)
        if seg is None:
            raise HTTPException(404, "Segment not found")
        done = redact.redact_phrase(t["segments"], phrase, only=seg, near=body.offset)
    else:
        done = redact.redact_phrase(t["segments"], phrase)
    if not done:
        raise HTTPException(404, "That text wasn't found (it may already be redacted)")
    store = load_redactions(d)
    mute = body.mute_audio and (d / "audio.mp3").exists()
    for r in done:
        store["entries"][r["id"]] = {"text": r["text"], "span": r["span"], "seg_start": r["seg_start"],
                                     "muted": mute, "created": time.time()}
    if mute and not (d / "audio.original.mp3").exists():
        shutil.copyfile(d / "audio.mp3", d / "audio.original.mp3")  # untouched copy, so muting is reversible
    t["updated"] = time.time()
    write_json(d / "transcript.json", t)
    save_redactions(d, store)
    muted = await rebuild_audio(fid, d, store) if mute else False
    log.info("redacted %d occurrence(s) in %s (audio muted: %s)", len(done), fid, muted)
    return {"count": len(done), "muted": muted, "transcript": with_redactions(d, t)}


@app.post("/api/files/{fid}/redactions/{rid}/unredact")
async def unredact_text(fid: str, rid: str) -> dict:
    d, t = _editable(fid)
    store = load_redactions(d)
    entry = store["entries"].get(rid)
    if entry is None:
        raise HTTPException(404, "This redaction was erased permanently and can't be undone")
    seg = next((s for s in t["segments"] if redact.token(rid) in (s.get("text") or "")), None)
    offset = seg["text"].index(redact.token(rid)) if seg else None
    redact.unredact(t["segments"], rid, entry["text"])
    del store["entries"][rid]
    t["updated"] = time.time()
    write_json(d / "transcript.json", t)
    save_redactions(d, store)
    unmuted = await rebuild_audio(fid, d, store) if entry.get("muted") else False
    return {"unmuted": unmuted, "text": entry["text"], "segment_id": seg["id"] if seg else None,
            "offset": offset, "was_muted": bool(entry.get("muted")), "transcript": with_redactions(d, t)}


class RecoverBody(BaseModel):
    bar: int = 0  # which permanent bar in the line (0 = first)


@app.post("/api/files/{fid}/segments/{sid}/recover")
async def recover_bar(fid: str, sid: int, body: RecoverBody) -> dict:
    """Recover the words behind a permanent [REDACTED] bar by re-transcribing the audio around it."""
    d, t = _editable(fid)
    seg = next((s for s in t["segments"] if s["id"] == sid), None)
    if seg is None:
        raise HTTPException(404, "Line not found")
    if not (d / "audio.mp3").exists():
        raise HTTPException(409, "The audio for this file was deleted, so the words can't be recovered")
    meta = load_meta(fid)
    model = meta.get("model") or cfg.DEFAULT_MODEL
    # Line times are partly estimated, so listen to a generous window around it.
    start = max(0.0, seg["start"] - 3.0)
    end = min(float(meta.get("duration") or seg["end"] + 3.0), seg["end"] + 3.0)
    work = d / "work"
    work.mkdir(exist_ok=True)
    if moss.is_local(model) or moss.is_remote(model):
        try:
            heard = (await moss.transcribe_window(d / "audio.mp3", start, end, model, work)).strip()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Couldn't re-transcribe the audio: {exc}") from None
        finally:
            shutil.rmtree(work, ignore_errors=True)
    else:
        tr = asr.Transcriber(model, await asr.resolve_api(model), cfg.DEFAULT_LANGUAGE or None, None)
        try:
            path = await asr.extract_chunk(d / "audio.mp3", start, end, work, f"recover{sid}")
            words, _ = await tr.transcribe(path, start, end, [])
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, f"Couldn't re-transcribe the audio: {exc}") from None
        finally:
            await tr.close()
            shutil.rmtree(work, ignore_errors=True)
        heard = "".join(w["w"] for w in words).strip()
    new_text = redact.fill_bar(seg["text"], body.bar, heard) if heard else None
    if not new_text:
        raise HTTPException(422, "Couldn't find the missing words in the audio (was this part muted?)")
    old_words = seg.get("words") or []
    seg["text"] = new_text
    if not (old_words and redact._norm("".join(w["w"] for w in old_words)) == redact._norm(new_text)):
        seg["words"] = []  # timings are re-estimated in the browser for this line
    seg["edited"] = True
    t["updated"] = time.time()
    write_json(d / "transcript.json", t)
    return {"text": new_text, "transcript": with_redactions(d, t)}


async def _erase(fid: str, d: Path, t: dict, store: dict, rid: str) -> None:
    entry = store["entries"].pop(rid, None)
    redact.finalize(t["segments"], rid)
    if entry is None:
        return
    orig = read_json(d / "transcript.orig.json")
    if orig is not None:  # so Revert can't bring it back
        redact.scrub(orig["segments"], entry["text"])
        write_json(d / "transcript.orig.json", orig)
    backup = d / "audio.original.mp3"
    if entry.get("muted") and backup.exists():  # bake the silence into the backup too
        await _encode(backup, backup, [entry["span"]])


@app.post("/api/files/{fid}/redactions/{rid}/erase")
async def erase_redaction(fid: str, rid: str) -> dict:
    d, t = _editable(fid)
    store = load_redactions(d)
    await _erase(fid, d, t, store, rid)
    write_json(d / "transcript.json", t)
    save_redactions(d, store)
    return {"transcript": with_redactions(d, t)}


@app.post("/api/files/{fid}/redactions/erase-all")
async def erase_all_redactions(fid: str) -> dict:
    d, t = _editable(fid)
    store = load_redactions(d)
    ids = list(store["entries"]) + list(redact.token_ids(t["segments"]) - set(store["entries"]))
    for rid in ids:
        await _erase(fid, d, t, store, rid)
    write_json(d / "transcript.json", t)
    save_redactions(d, store)
    return {"count": len(ids), "transcript": with_redactions(d, t)}


class IdentifyBody(BaseModel):
    remember: bool = True


@app.post("/api/files/{fid}/identify")
async def start_identify(fid: str, body: IdentifyBody) -> dict:
    meta = load_meta(fid)
    if not diarize.available():
        raise HTTPException(501, "Speaker models are not installed in this image")
    if meta["status"] in ACTIVE_STATES:
        raise HTTPException(409, f"File is already {meta['status']}")
    t = read_json(fdir(fid) / "transcript.json")
    if t is None or not (fdir(fid) / "audio.mp3").exists():
        raise HTTPException(409, "Needs both audio and a transcript")
    speakers = t.get("speakers") or {}
    if len(speakers) < 2:
        raise HTTPException(400, "Add at least two speakers first")
    voices = {v["name"].strip().lower() for v in load_voices()}
    tagged = {s.get("speaker") for s in t["segments"] if s.get("spk_locked")}
    missing = [v["name"] for k, v in speakers.items() if k not in tagged and v["name"].strip().lower() not in voices]
    if missing:
        raise HTTPException(400, "Tag at least one clip for: " + ", ".join(missing))
    await enqueue(fid, {"job": "identify", "remember": body.remember})
    return public_meta(load_meta(fid))


@app.get("/api/voices")
async def list_voices() -> list[dict]:
    return [{k: v[k] for k in ("id", "name", "n", "updated")} for v in load_voices()]


class VoiceRename(BaseModel):
    name: str


@app.patch("/api/voices/{vid}")
async def rename_voice(vid: str, body: VoiceRename) -> dict:
    voices = load_voices()
    v = next((v for v in voices if v["id"] == vid), None)
    if not v:
        raise HTTPException(404, "Voice not found")
    v["name"] = body.name.strip()[:80] or v["name"]
    save_voices(voices)
    return {k: v[k] for k in ("id", "name", "n", "updated")}


@app.delete("/api/voices/{vid}")
async def delete_voice(vid: str) -> dict:
    voices = load_voices()
    save_voices([v for v in voices if v["id"] != vid])
    return {"ok": True}


# ---- exports -------------------------------------------------------------- #


def ts(sec: float, sep: str = ".", ms: bool = True) -> str:
    sec = max(0.0, sec)
    h, rem = divmod(int(sec), 3600)
    m, s = divmod(rem, 60)
    frac = f"{sep}{int(round((sec - int(sec)) * 1000)) % 1000:03d}" if ms else ""
    return f"{h:02d}:{m:02d}:{s:02d}{frac}"


def render_export(t: dict, fmt: str) -> tuple[str, str, str]:
    segs = [{**s, "text": redact.plain(s["text"])} for s in t["segments"] if s["text"].strip()]
    names = {k: v.get("name") or k for k, v in (t.get("speakers") or {}).items()}
    markers = sorted(t.get("markers") or [], key=lambda m: m["t"])

    def marker_label(m: dict) -> str:
        return m.get("label") or "Marker"

    def headings_before(start: float, done: set) -> list[dict]:
        """Markers that fall before this segment's start and haven't been emitted yet."""
        out = [m for m in markers if m["id"] not in done and m["t"] <= start + 0.05]
        done.update(m["id"] for m in out)
        return out

    if fmt == "chapters":
        lines = [f"{ts(m['t'], ms=False)} {marker_label(m)}" + (f" (until {ts(m['end'], ms=False)})" if m.get("end") else "")
                 for m in markers]
        return ("\n".join(lines) + "\n") if lines else "No markers in this file.\n", "chapters.txt", "text/plain"

    def who(s: dict) -> Optional[str]:
        return names.get(s.get("speaker") or "", None)

    if fmt == "txt":
        paras: list[str] = []
        cur: list[str] = []
        last_end, last_spk = None, object()
        done: set = set()
        for s in segs:  # new paragraph on speaker change or long pause
            for m in headings_before(s["start"], done):
                if cur:
                    paras.append(" ".join(cur))
                    cur = []
                paras.append(f"## {marker_label(m)} [{ts(m['t'], ms=False)}]")
                last_spk = object()
            spk = who(s)
            if cur and (spk != last_spk or (last_end is not None and s["start"] - last_end > 2.0)):
                paras.append(" ".join(cur))
                cur = []
            if not cur and spk:
                cur.append(f"{spk}:")
            cur.append(s["text"].strip())
            last_end, last_spk = s["end"], spk
        if cur:
            paras.append(" ".join(cur))
        return "\n\n".join(paras) + "\n", "txt", "text/plain"
    if fmt == "timestamps":
        lines = []
        done = set()
        for s in segs:
            for m in headings_before(s["start"], done):
                lines.append(f"\n=== {marker_label(m)} [{ts(m['t'], ms=False)}] ===")
            lines.append(f"[{ts(s['start'], ms=False)} - {ts(s['end'], ms=False)}] "
                         f"{who(s) + ': ' if who(s) else ''}{s['text'].strip()}")
        return "\n".join(lines).lstrip("\n") + "\n", "timestamps.txt", "text/plain"
    if fmt == "srt":
        blocks = [f"{i}\n{ts(s['start'], ',')} --> {ts(s['end'], ',')}\n"
                  f"{'[' + who(s) + '] ' if who(s) else ''}{s['text'].strip()}\n" for i, s in enumerate(segs, 1)]
        return "\n".join(blocks), "srt", "application/x-subrip"
    if fmt == "vtt":
        blocks = [f"{ts(s['start'])} --> {ts(s['end'])}\n"
                  f"{'<v ' + who(s) + '>' if who(s) else ''}{s['text'].strip()}\n" for s in segs]
        return "WEBVTT\n\n" + "\n".join(blocks), "vtt", "text/vtt"
    if fmt == "json":
        out = {"model": t.get("model"), "speakers": names,
               "markers": [{"time": m["t"], "end": m.get("end"), "label": m.get("label")} for m in markers],
               "segments": [{"start": s["start"], "end": s["end"], "speaker": who(s), "text": s["text"].strip(),
                             "confidence": s.get("confidence"), "reviewed": s.get("reviewed", False)}
                            for s in segs]}
        return json.dumps(out, indent=2, ensure_ascii=False), "json", "application/json"
    raise HTTPException(400, "Unknown format")


@app.get("/api/files/{fid}/download")
async def download(fid: str, format: str = Query("txt")) -> Response:
    meta = load_meta(fid)
    t = read_json(fdir(fid) / "transcript.json")
    if t is None:
        raise HTTPException(404, "No transcript yet")
    body, ext, mime = render_export(t, format)
    stem = re.sub(r"[^\w\-. ]", "_", Path(meta["name"]).stem) or "transcript"
    return Response(body, media_type=f"{mime}; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{stem}.{ext}"'})


@app.get("/api/health")
async def health() -> JSONResponse:
    return JSONResponse({"ok": True, "queue": queue.qsize()})


app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
