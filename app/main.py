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
from typing import Any, Callable, Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi import Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import asr
import bench
import auth
import diarize
import docx_export
import moss
import redact
import sounds
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


def owns(meta: dict) -> bool:
    """Files belong to the user who uploaded them; nobody else sees them (admins included)."""
    if not auth.enabled():
        return True
    return (meta.get("owner") or "") == auth.owner_id()


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


def voices_path() -> Path:
    """Saved voice profiles belong to the signed-in user (or to the file owner inside jobs)."""
    uid = auth.owner_id()
    return cfg.DATA_DIR / "voices.json" if uid == "local" else auth.data_dir(uid) / "voices.json"


def load_voices() -> list[dict]:
    return read_json(voices_path(), {"voices": []}).get("voices", [])


def save_voices(voices: list[dict]) -> None:
    write_json(voices_path(), {"voices": voices})


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


HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")


def name_from_voices(speakers: dict, centroids: dict) -> dict:
    """Rename diarized speakers that match a saved voice; strips internal keys."""
    voices = load_voices()
    matched = diarize.match_voices(centroids, voices) if voices and centroids else {}
    out = {}
    for label, info in speakers.items():
        v = matched.get(info.get("_idx"))
        out[label] = ({"name": v["name"], "voice": v["id"], **({"color": v["color"]} if v.get("color") else {})}
                      if v else {"name": info["name"]})
    return out


async def run_diarization(fid, audio: Path, num_speakers: int):
    """Returns (turns, centroids, samples). `fid` is a file id or a progress callback."""
    loop = asyncio.get_running_loop()
    report = fid if callable(fid) else (lambda **kw: set_progress(fid, **kw))
    report(speakers=0.0)

    def progress(frac: float) -> None:
        loop.call_soon_threadsafe(lambda: report(speakers=round(frac, 3)))

    have_voices = bool(load_voices())

    def work():
        samples = diarize.load_samples(audio)
        turns = diarize.diarize(samples, num_speakers, progress)
        cents = diarize.cluster_centroids(samples, turns) if have_voices else {}
        return turns, cents, samples

    t0 = time.time()
    turns, cents, samples = await loop.run_in_executor(None, work)
    log.info("speaker detection took %.1fs", time.time() - t0)
    report(speakers=1.0)
    return turns, cents, samples


async def transcribe_core(audio: Path, duration: float, opts: dict, work: Path,
                          progress: Callable[..., None]) -> dict:
    """Run the full pipeline (model + speakers + scoring). Shared by jobs and benchmarks."""
    model = opts.get("model") or cfg.DEFAULT_MODEL
    report = lambda p: progress(**p)  # noqa: E731
    notes: list = []
    diar_task: Optional[asyncio.Task] = None
    try:
        if moss.is_local(model) or moss.is_remote(model):
            if moss.is_local(model) and not moss.available():
                raise RuntimeError("The built-in MOSS engine isn't available in this container")
            # MOSS detects speakers itself (diarization models only link speakers across chunks).
            mspk = diarize.parse_speakers(opts.get("speakers"))
            result = await moss.transcribe_file(audio, duration, {**opts, "model": model}, work, report, mspk,
                                                bool(load_voices()))
            words, notes = result["words"], result["notes"]
            speakers = name_from_voices(result["speakers"], result["centroids"]) if result["speakers"] else {}
        else:
            num_speakers = diarize.parse_speakers(opts.get("speakers")) if diarize.available() else None
            if num_speakers is not None:  # CPU-bound; runs alongside the GPU transcription
                diar_task = asyncio.create_task(run_diarization(progress, audio, num_speakers))
            result = await asr.transcribe_file(audio, duration, {**opts, "model": model}, work, report)
            speakers = {}
            turns, cents = None, {}
            if diar_task:
                progress(stage="speakers")
                try:
                    turns, cents, _ = await diar_task
                except Exception:  # noqa: BLE001
                    log.exception("speaker detection failed")
            words = asr.finalize_words(result["spans"], result["silences"], turns)
            if turns:
                speakers = name_from_voices(asr.assign_speakers(words, turns), cents)
    finally:
        if diar_task and not diar_task.done():  # failed or stopped by the user
            diar_task.cancel()
    segments = asr.build_segments(words)
    asr.score_segments(segments)
    for a, b, msg in notes:
        for seg in segments:
            if seg["start"] < b and seg["end"] > a:
                seg["issues"].append(msg)
                break
    return {"segments": segments, "speakers": speakers, "words": words, "result": result}


async def job_transcribe(fid: str, opts: dict) -> None:
    d = fdir(fid)
    meta = update_meta(fid, status="transcribing", started_at=time.time(), error=None, device=None,
                       model=opts.get("model") or cfg.DEFAULT_MODEL)
    PROGRESS[fid] = {"stage": "starting"}
    try:
        t0 = time.time()
        out = await transcribe_core(d / "audio.mp3", meta.get("duration") or 0, {**opts, "model": meta["model"]},
                                    d / "work", lambda **kw: set_progress(fid, **kw))
        result, segments, speakers, words = out["result"], out["segments"], out["speakers"], out["words"]
        redact.reapply(segments, load_redactions(d)["entries"])
        prev = read_json(d / "transcript.json") or {}
        if prev and opts.get("keep_previous", True):
            archive_active(d)  # keep the earlier transcript as a version
        transcript = {"model": result["model"], "api": result["api"], "created": time.time(), "version": new_vid(),
                      "options": {k: opts[k] for k in ("speakers", "language", "vocabulary") if opts.get(k)},
                      "markers": prev.get("markers") or [],
                      "duration": meta.get("duration"), "speakers": speakers, "segments": segments,
                      "timing": "estimated" if any(w.get("est") for w in words) else "model"}
        write_json(d / "transcript.orig.json", transcript)
        write_json(d / "transcript.json", transcript)
        update_meta(fid, status="done", transcribed_at=time.time(), transcribe_seconds=round(time.time() - t0, 1),
                    api=result["api"], chunks=result["chunks"], speaker_count=len(speakers),
                    device=result.get("device"), version_count=len(list_versions(d)))
    except Exception as exc:  # noqa: BLE001
        log.exception("transcription failed for %s", fid)
        msg = str(exc)
        if isinstance(exc, asr.ContextTooLarge):
            msg = f"Audio chunk too large for the model's context even after splitting: {msg[:300]}"
        update_meta(fid, status="error", error=msg)
    finally:
        PROGRESS.pop(fid, None)
        shutil.rmtree(d / "work", ignore_errors=True)


# ---- transcript versions -------------------------------------------------- #
# transcript.json (+ .orig) is the active version; earlier ones live in versions/<id>.json.


def new_vid() -> str:
    return uuid.uuid4().hex[:10]


def archive_active(d: Path) -> Optional[str]:
    t = read_json(d / "transcript.json")
    if t is None:
        return None
    vid = t.get("version") or new_vid()
    t["version"] = vid
    (d / "versions").mkdir(exist_ok=True)
    write_json(d / "versions" / f"{vid}.json", {"id": vid, "transcript": t, "orig": read_json(d / "transcript.orig.json")})
    return vid


def version_summary(t: dict, active: bool) -> dict:
    segs = t.get("segments") or []
    return {"id": t.get("version"), "model": t.get("model"), "api": t.get("api"), "created": t.get("created"),
            "updated": t.get("updated"), "edited": any(s.get("edited") for s in segs), "segments": len(segs),
            "words": sum(len((s.get("text") or "").split()) for s in segs),
            "speakers": len(t.get("speakers") or {}), "options": t.get("options") or {}, "active": active}


def list_versions(d: Path) -> list[dict]:
    out = []
    t = read_json(d / "transcript.json")
    if t is not None:
        out.append(version_summary(t, True))
    for p in (d / "versions").glob("*.json") if (d / "versions").exists() else []:
        v = read_json(p)
        if v and v.get("transcript"):
            out.append(version_summary({**v["transcript"], "version": v["id"]}, False))
    return sorted(out, key=lambda v: v.get("created") or 0, reverse=True)


def each_archived(d: Path, fn: Callable[[list], Any]) -> None:
    """Apply a redaction change to every archived version too (so nothing private lingers there)."""
    for p in (d / "versions").glob("*.json") if (d / "versions").exists() else []:
        v = read_json(p)
        if not v:
            continue
        for key in ("transcript", "orig"):
            if v.get(key):
                fn(v[key]["segments"])
        write_json(p, v)


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
        old_colors = {k: v.get("color") for k, v in (t.get("speakers") or {}).items()}
        overlap: dict[tuple[str, str], float] = {}
        for s, p in zip(segs, pseudo):
            if s.get("speaker") and p.get("spk"):
                key = (p["spk"], s["speaker"])
                overlap[key] = overlap.get(key, 0.0) + (s["end"] - s["start"])
        used: set[str] = set()
        for (new, old), _ in sorted(overlap.items(), key=lambda kv: -kv[1]):
            if (new in speakers and old not in used and not speakers[new].get("_named")
                    and not speakers[new].get("voice") and old_names.get(old)):
                speakers[new] = {"name": old_names[old], "_named": True,
                                 **({"color": old_colors[old]} if old_colors.get(old) else {})}
                used.add(old)
        speakers = {k: {"name": v["name"], **({"color": v["color"]} if v.get("color") else {}),
                        **({"voice": v["voice"]} if v.get("voice") else {})} for k, v in speakers.items()}
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

        voices = load_voices()

        def work():
            samples = diarize.load_samples(d / "audio.mp3")
            embs = diarize.segment_embeddings(samples, t["segments"], cache, progress)
            stats = diarize.identify(t["segments"], embs, t.get("speakers") or {}, voices)
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
                    last_identify={**stats, "at": time.time(), "sig": opts.get("sig"),
                                   "examples": opts.get("examples"), "lines": len(t["segments"])})
    except ValueError as exc:
        update_meta(fid, status="done", error=str(exc))
    except Exception as exc:  # noqa: BLE001
        log.exception("identify failed for %s", fid)
        update_meta(fid, status="done", error=f"Voice matching failed: {exc}")
    finally:
        PROGRESS.pop(fid, None)


RUNNING: dict[str, asyncio.Task] = {}


async def enqueue(fid: str, opts: dict) -> None:
    opts = {**opts, "_tok": uuid.uuid4().hex[:8]}  # lets a stopped job's stale queue entry be skipped
    update_meta(fid, status="queued", error=None, queued_opts=opts)
    await queue.put((fid, opts))


def settle_status(fid: str, **extra: Any) -> None:
    """Back to the resting state: 'done' if there is a transcript, else 'ready'."""
    done = (fdir(fid) / "transcript.json").exists()
    update_meta(fid, status="done" if done else "ready", queued_opts=None, **extra)


async def job_sounds(fid: str, opts: dict) -> None:
    """Find laughter, coughs, sneezes ... and who made them."""
    d = fdir(fid)
    update_meta(fid, status="diarizing", started_at=time.time(), error=None)
    PROGRESS[fid] = {"stage": "sounds", "label": "Listening for laughs, coughs and other sounds"}
    loop = asyncio.get_running_loop()

    def progress(frac: float) -> None:
        loop.call_soon_threadsafe(lambda: set_progress(fid, speakers=round(frac * 0.8, 3)))

    try:
        t = read_json(d / "transcript.json") or {"segments": []}

        def work():
            samples = diarize.load_samples(d / "audio.mp3")
            events = sounds.detect(samples, progress)
            if diarize.available() and t["segments"]:
                sounds.attribute(events, samples, t["segments"])
            return events

        events = await loop.run_in_executor(None, work)
        events = keep_sound_edits(events, (read_json(d / "sounds.json") or {}).get("events") or [])
        write_json(d / "sounds.json", {"created": time.time(), "model": "ced-mini", "events": events})
        counts = sound_counts(events)
        log.info("sounds for %s: %s", fid, counts)
        settle_status(fid, error=None, sounds=counts)
    except Exception as exc:  # noqa: BLE001
        log.exception("sound detection failed for %s", fid)
        settle_status(fid, error=f"Sound detection failed: {exc}")
    finally:
        PROGRESS.pop(fid, None)


async def run_job(fid: str, opts: dict) -> None:
    if opts.get("job") == "sounds":
        await job_sounds(fid, opts)
        return
    if opts.get("job") == "diarize":
        await job_diarize(fid, opts)
    elif opts.get("job") == "identify":
        await job_identify(fid, opts)
    else:
        await job_transcribe(fid, opts)


async def worker() -> None:
    while True:
        fid, opts = await queue.get()
        try:
            if fid.startswith("bench:"):
                await run_bench_item(fid, opts)
                continue
            meta = read_json(cfg.FILES_DIR / fid / "meta.json") or {}
            if meta.get("status") != "queued" or (meta.get("queued_opts") or {}).get("_tok") != opts.get("_tok"):
                continue  # stopped (or re-queued) while waiting
            if (cfg.FILES_DIR / fid / "audio.mp3").exists():
                owner = meta.get("owner") or "local"
                ctx = auth.current.set(auth.get(owner) or {**auth.LOCAL_USER, "id": owner})
                try:  # the job task inherits this context: voices etc. are the owner's
                    task = asyncio.create_task(run_job(fid, opts))
                finally:
                    auth.current.reset(ctx)
                RUNNING[fid] = task
                try:
                    await task
                except asyncio.CancelledError:
                    if not task.cancelled():
                        raise
                    log.info("job for %s stopped by the user", fid)
                    PROGRESS.pop(fid, None)
                    settle_status(fid, error=None, stopped_at=time.time())
                finally:
                    RUNNING.pop(fid, None)
            else:
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
    migrate_owners()
    spawn(worker())
    for meta_path in sorted(cfg.FILES_DIR.glob("*/meta.json")):  # recover interrupted work
        meta = read_json(meta_path)
        if not meta:
            continue
        if meta.get("status") == "processing":
            spawn(prepare_file(meta["id"]))
        elif meta.get("status") in ("queued", "transcribing", "diarizing"):
            await enqueue(meta["id"], meta.get("queued_opts") or {})
    for b in bench.all_benches():  # benchmark runs interrupted by a restart start again
        for r in b.get("runs", []):
            if r.get("status") in ("queued", "running"):
                r["status"] = "queued"
                await queue.put((f"bench:{b['id']}:{r['id']}", {}))
        bench.save(b)
    yield


app = FastAPI(title="TranscribeR", lifespan=lifespan)


def migrate_owners() -> None:
    """When accounts are switched on, files and voices from single-user mode go to the admin."""
    admin = auth.ensure_env_admin()
    if not admin:
        return
    moved = 0
    for meta_path in cfg.FILES_DIR.glob("*/meta.json"):
        meta = read_json(meta_path)
        if meta and meta.get("owner") in (None, "", "local"):
            meta["owner"] = admin["id"]
            write_json(meta_path, meta)
            moved += 1
    legacy = cfg.DATA_DIR / "voices.json"
    target = auth.data_dir(admin["id"]) / "voices.json"
    if legacy.exists() and not target.exists():
        shutil.move(str(legacy), target)
    if moved:
        log.info("accounts enabled: %d existing files now belong to %s", moved, admin["username"])


PUBLIC_PATHS = {"/login.html", "/login.js", "/styles.css", "/favicon.svg", "/favicon.ico", "/apple-touch-icon.png",
                "/api/auth/login", "/api/auth/me", "/api/health"}
FILE_PATH_RE = re.compile(r"^/api/files/([a-f0-9]{32})(?:/|$)")


@app.middleware("http")
async def require_login(request: Request, call_next):
    if not auth.enabled():
        return await call_next(request)
    path = request.url.path
    user = auth.read_session(request.cookies.get(auth.COOKIE))
    if user is None and path not in PUBLIC_PATHS:
        if path.startswith("/api/"):
            return JSONResponse({"detail": "Please sign in"}, status_code=401)
        nxt = path if path not in ("/", "/index.html") else ""
        return RedirectResponse("/login.html" + (f"?next={nxt}" if nxt else ""), status_code=303)
    if user and (path.startswith("/api/admin/") or path == "/admin.html") and not user.get("admin"):
        if path.startswith("/api/"):
            return JSONResponse({"detail": "Admins only"}, status_code=403)
        return RedirectResponse("/", status_code=303)
    token = auth.current.set(user)
    try:
        if user and (m := FILE_PATH_RE.match(path)):
            meta = read_json(cfg.FILES_DIR / m.group(1) / "meta.json")
            if meta is not None and not owns(meta):
                return JSONResponse({"detail": "File not found"}, status_code=404)
        return await call_next(request)
    finally:
        auth.current.reset(token)

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
    engine = moss.engine_info() if local else None
    return {"models": local + [m for m in models if m not in local], "local_models": local, "engine": engine,
            "remote_count": len(models), "default_model": cfg.DEFAULT_MODEL, "default_language": cfg.DEFAULT_LANGUAGE,
            "uncertainty_threshold": cfg.UNCERTAINTY_THRESHOLD, "word_threshold": cfg.WORD_THRESHOLD,
            "auto_transcribe": cfg.AUTO_TRANSCRIBE, "backend": cfg.LLAMA_SWAP_URL, "backend_error": error,
            "diarization_available": diarize.available(), "diarization_default": cfg.DIARIZATION}


@app.get("/api/files")
async def list_files() -> list[dict]:
    metas = [read_json(p) for p in cfg.FILES_DIR.glob("*/meta.json")]
    metas = [public_meta(m) for m in metas if m and owns(m)]
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
            "owner": auth.owner_id(),
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
        meta = read_json(cfg.FILES_DIR / fid / "meta.json") if ID_RE.match(fid) else None
        if not meta or not owns(meta):
            skipped.append(fid)
            continue
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
    vocabulary: Optional[str] = None  # names/terms to spell correctly, comma separated
    keep_previous: Optional[bool] = None  # keep the current transcript as a version (default yes)


@app.post("/api/files/{fid}/transcribe")
async def start_transcription(fid: str, body: TranscribeBody) -> dict:
    meta = load_meta(fid)
    if meta["status"] == "processing":  # still converting: start as soon as it's ready
        return public_meta(update_meta(fid, auto_transcribe=True, upload_opts=body.model_dump(exclude_none=True)))
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
    d = fdir(fid)
    t = read_json(d / "transcript.json")
    if t is None:
        raise HTTPException(404, "No transcript yet")
    if "moss" in (t.get("model") or "").lower() and not t.get("markers_cleaned"):
        # transcripts made before the fix can contain leftover turn markers like "Etsy.[600.81]"
        for name in ("transcript.json", "transcript.orig.json"):
            doc = t if name == "transcript.json" else read_json(d / name)
            if not doc:
                continue
            for seg in doc["segments"]:
                if moss.LEFTOVER_RE.search(seg.get("text") or ""):
                    seg["text"] = moss.clean_text(seg["text"])
                    words = []
                    for w in seg.get("words") or []:
                        c = moss.clean_text(w["w"])
                        if c:
                            words.append({**w, "w": (" " if w["w"][:1].isspace() else "") + c})
                    seg["words"] = words if redact._norm("".join(x["w"] for x in words)) == redact._norm(seg["text"]) else []
            doc["markers_cleaned"] = True
            write_json(d / name, doc)
    return with_redactions(d, t)


SEG_KEYS = {"id", "start", "end", "text", "speaker", "words", "reviewed", "edited", "spk_changed",
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
    before = redact.token_ids(t["segments"])
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
                                  **({"voice": v["voice"]} if (v or {}).get("voice") else {}),
                                  **({"color": v["color"].lower()} if HEX_COLOR.fullmatch(str((v or {}).get("color") or "")) else {})}
                         for k, v in body.speakers.items()}
    t["updated"] = time.time()
    write_json(path, t)
    d = fdir(fid)
    store = load_redactions(d)
    # only bars removed in this edit (another version may simply not contain a redacted phrase)
    gone = (before - redact.token_ids(t["segments"])) & set(store["entries"])
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
    each_archived(d, lambda segs: redact.unredact(segs, rid, entry["text"]))
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

    def scrub_version(segs: list) -> None:
        redact.finalize(segs, rid)
        if entry is not None:
            redact.scrub(segs, entry["text"])

    each_archived(d, scrub_version)
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
    sig: Optional[str] = None  # fingerprint of the user's corrections, so the UI knows when it's up to date


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
    examples = sum(1 for s in t["segments"] if s.get("spk_locked"))
    await enqueue(fid, {"job": "identify", "remember": body.remember, "sig": body.sig, "examples": examples})
    return public_meta(load_meta(fid))


@app.get("/api/voices")
async def list_voices() -> list[dict]:
    return [{k: v.get(k) for k in ("id", "name", "n", "updated", "color")} for v in load_voices()]


class VoiceRename(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None  # "" clears it


@app.patch("/api/voices/{vid}")
async def rename_voice(vid: str, body: VoiceRename) -> dict:
    voices = load_voices()
    v = next((v for v in voices if v["id"] == vid), None)
    if not v:
        raise HTTPException(404, "Voice not found")
    if body.name is not None:
        v["name"] = body.name.strip()[:80] or v["name"]
    if body.color is not None:
        if body.color and not HEX_COLOR.fullmatch(body.color):
            raise HTTPException(400, "Color must look like #7c6cff")
        v["color"] = body.color.lower() or None
    save_voices(voices)
    return {k: v.get(k) for k in ("id", "name", "n", "updated", "color")}


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


def render_export(t: dict, fmt: str, title: str = "Transcript") -> tuple[Any, str, str]:
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

    if fmt in ("docx", "md"):  # speaker paragraphs (new paragraph on speaker change / long pause)
        blocks: list[tuple] = []
        cur: list[str] = []
        cur_spk, cur_start, last_end = object(), 0.0, None
        done = set()

        def flush() -> None:
            if cur:
                blocks.append(("p", cur_spk if isinstance(cur_spk, str) else None, " ".join(cur), ts(cur_start, ms=False)))
                cur.clear()

        for s in segs:
            heads = headings_before(s["start"], done)
            for m in heads:
                flush()
                blocks.append(("h", f"{marker_label(m)} [{ts(m['t'], ms=False)}]"))
            spk = who(s)
            if heads or (cur and (spk != cur_spk or (last_end is not None and s["start"] - last_end > 2.0))):
                flush()
            if not cur:
                cur_spk, cur_start = spk, s["start"]
            cur.append(s["text"].strip())
            last_end = s["end"]
        flush()
        if fmt == "docx":
            return (docx_export.build(title, blocks), "docx",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        lines = [f"# {title}", ""]
        for b in blocks:
            lines += [f"## {b[1]}", ""] if b[0] == "h" else [
                (f"**{b[1]}** " if b[1] else "") + f"_[{b[3]}]_ {b[2]}", ""]
        return "\n".join(lines), "md", "text/markdown"
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
    body, ext, mime = render_export(t, format, Path(meta["name"]).stem)
    stem = re.sub(r"[^\w\-. ]", "_", Path(meta["name"]).stem) or "transcript"
    return Response(body, media_type=mime if isinstance(body, bytes) else f"{mime}; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{stem}.{ext}"'})


@app.post("/api/files/{fid}/cancel")
async def cancel_job(fid: str) -> dict:
    """Stop a queued or running job. The previous transcript (if any) is kept."""
    load_meta(fid)
    task = RUNNING.get(fid)
    if task and not task.done():
        moss.cancel_all()  # abort the native model run right away
        task.cancel()
        for _ in range(300):  # the worker resets the status once the job has unwound
            if fid not in RUNNING:
                break
            await asyncio.sleep(0.1)
    else:
        PROGRESS.pop(fid, None)
        settle_status(fid, error=None, stopped_at=time.time())
    return public_meta(load_meta(fid))


# ---- benchmarks (admin) --------------------------------------------------- #

BENCH_LOCK = asyncio.Lock()  # bench.json is read-modify-written by jobs and requests


async def bench_update_run(bid: str, rid: str, **changes: Any) -> Optional[dict]:
    async with BENCH_LOCK:
        b = bench.load(bid)
        if not b:
            return None
        r = next((r for r in b["runs"] if r["id"] == rid), None)
        if r is None:
            return None
        r.update(changes)
        bench.save(b)
        return r


async def run_bench_item(key: str, opts: dict) -> None:
    _, bid, rid = key.split(":")
    b = bench.load(bid)
    r = next((r for r in (b or {}).get("runs", []) if r["id"] == rid), None)
    if not r or r.get("status") != "queued":
        return
    owner = b.get("owner") or "local"
    ctx = auth.current.set(auth.get(owner) or {**auth.LOCAL_USER, "id": owner})
    try:
        task = asyncio.create_task(job_bench(bid, rid, r))
    finally:
        auth.current.reset(ctx)
    RUNNING[key] = task
    try:
        await task
    except asyncio.CancelledError:
        if not task.cancelled():
            raise
        await bench_update_run(bid, rid, status="stopped", progress=None)
    finally:
        RUNNING.pop(key, None)
        PROGRESS.pop(key, None)


async def job_bench(bid: str, rid: str, run: dict) -> None:
    key = f"bench:{bid}:{rid}"
    d = bench.bdir(bid)
    b = bench.load(bid)
    await bench_update_run(bid, rid, status="running", started=time.time(), error=None)
    loop = asyncio.get_running_loop()
    last = [0.0]

    def progress(**kw: Any) -> None:
        PROGRESS.setdefault(key, {}).update(kw)
        if time.time() - last[0] > 2:  # persist now and then so the admin page can show it
            last[0] = time.time()
            p = dict(PROGRESS.get(key) or {})
            loop.create_task(bench_update_run(bid, rid, progress=p))

    t0 = time.time()
    try:
        out = await transcribe_core(d / "audio.mp3", b.get("duration") or 0, run["options"], d / f"work_{rid}", progress)
        seconds = time.time() - t0
        words, spk = bench.hypothesis_from_segments(out["segments"], out["speakers"])
        metrics, diff = await loop.run_in_executor(None, bench.score, b["reference"], words, spk)
        write_json(d / f"run_{rid}.json", {"diff": diff, "segments": out["segments"], "speakers": out["speakers"]})
        await bench_update_run(bid, rid, status="done", finished=time.time(), seconds=round(seconds, 1),
                               rtf=round(seconds / max(1.0, b.get("duration") or 1), 4), metrics=metrics,
                               device=out["result"].get("device"), api=out["result"].get("api"), progress=None)
    except Exception as exc:  # noqa: BLE001
        log.exception("benchmark run %s failed", key)
        await bench_update_run(bid, rid, status="error", error=str(exc)[:500], progress=None)
    finally:
        shutil.rmtree(d / f"work_{rid}", ignore_errors=True)


@app.get("/api/admin/bench")
async def bench_list() -> list[dict]:
    return [bench.summary(b) for b in bench.all_benches()]


@app.post("/api/admin/bench")
async def bench_create(name: str = Form(""), source_fid: Optional[str] = Form(None),
                       reference_text: Optional[str] = Form(None),
                       audio: Optional[UploadFile] = File(None), reference_file: Optional[UploadFile] = File(None)) -> dict:
    tmp = cfg.DATA_DIR / "bench" / f"upload_{uuid.uuid4().hex[:8]}"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        source = None
        if source_fid:  # one of the admin's own transcribed files
            meta = load_meta(source_fid)
            if not owns(meta):
                raise HTTPException(404, "File not found")
            d = fdir(source_fid)
            if not (d / "audio.mp3").exists():
                raise HTTPException(400, "That file's audio was deleted")
            audio_path, duration = d / "audio.mp3", float(meta.get("duration") or 0)
            source = {"file": source_fid, "name": meta["name"]}
            name = name or meta["name"]
        elif audio is not None:
            raw = tmp / ("in" + Path(audio.filename or "a").suffix[:8])
            with raw.open("wb") as out:
                while chunk := await audio.read(1 << 20):
                    out.write(chunk)
            audio_path = tmp / "audio.mp3"
            code, _, err = await asr.run("ffmpeg", "-y", "-v", "error", "-i", str(raw), "-vn", "-c:a", "libmp3lame",
                                         "-b:a", cfg.MP3_BITRATE, str(audio_path))
            if code != 0:
                raise HTTPException(400, "Couldn't read that audio file")
            duration = float((await probe(audio_path)).get("format", {}).get("duration") or 0)
            source = {"upload": audio.filename}
            name = name or (audio.filename or "Benchmark")
        else:
            raise HTTPException(400, "Pick a file from your library or upload audio")
        text = reference_text or ""
        if reference_file is not None:
            text = (await reference_file.read()).decode("utf-8", "ignore")
        if text.strip():
            reference = bench.reference_from_text(text)
        elif source_fid:
            t = read_json(fdir(source_fid) / "transcript.json")
            if not t:
                raise HTTPException(400, "That file has no transcript to use as the reference")
            reference = bench.reference_from_transcript(t)
            source["reference"] = "transcript"
            source["reviewed"] = sum(1 for s in t["segments"] if s.get("reviewed") or s.get("edited"))
            source["segments"] = len(t["segments"])
        else:
            raise HTTPException(400, "Add a reference transcript (paste text or upload .txt/.srt/.vtt)")
        if len(reference["words"]) < 5:
            raise HTTPException(400, "The reference transcript is too short")
        b = bench.create(name, auth.owner_id(), audio_path, duration, reference, source)
        return bench.summary(b)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@app.get("/api/admin/bench/{bid}")
async def bench_get(bid: str) -> dict:
    b = bench.load(bid)
    if not b:
        raise HTTPException(404, "Benchmark not found")
    out = bench.summary(b)
    for r in out["runs"]:
        live = PROGRESS.get(f"bench:{bid}:{r['id']}")
        if live and r["status"] == "running":
            r["progress"] = live
    out["reference_text"] = b["reference"]["text"][:20000]
    return out


@app.delete("/api/admin/bench/{bid}")
async def bench_delete(bid: str) -> dict:
    b = bench.load(bid)
    if not b:
        raise HTTPException(404, "Benchmark not found")
    for r in b["runs"]:
        task = RUNNING.get(f"bench:{bid}:{r['id']}")
        if task and not task.done():
            moss.cancel_all()
            task.cancel()
    shutil.rmtree(bench.bdir(bid), ignore_errors=True)
    return {"ok": True}


class BenchRunBody(BaseModel):
    models: list[str]
    speakers: Optional[str] = None
    language: Optional[str] = None
    vocabulary: Optional[str] = None


@app.post("/api/admin/bench/{bid}/runs")
async def bench_run(bid: str, body: BenchRunBody) -> dict:
    if not body.models:
        raise HTTPException(400, "Pick at least one model")
    async with BENCH_LOCK:
        b = bench.load(bid)
        if not b:
            raise HTTPException(404, "Benchmark not found")
        new = []
        for model in body.models[:12]:
            opts = {"model": model, **{k: v for k, v in body.model_dump(exclude={"models"}).items() if v}}
            r = {"id": uuid.uuid4().hex[:8], "model": model, "options": opts, "status": "queued", "created": time.time()}
            b["runs"].append(r)
            new.append(r)
        bench.save(b)
    for r in new:
        await queue.put((f"bench:{bid}:{r['id']}", {}))
    return bench.summary(b)


@app.post("/api/admin/bench/{bid}/runs/{rid}/cancel")
async def bench_cancel(bid: str, rid: str) -> dict:
    task = RUNNING.get(f"bench:{bid}:{rid}")
    if task and not task.done():
        moss.cancel_all()
        task.cancel()
    else:
        await bench_update_run(bid, rid, status="stopped", progress=None)
    return {"ok": True}


@app.delete("/api/admin/bench/{bid}/runs/{rid}")
async def bench_delete_run(bid: str, rid: str) -> dict:
    task = RUNNING.get(f"bench:{bid}:{rid}")
    if task and not task.done():
        raise HTTPException(409, "Stop the run first")
    async with BENCH_LOCK:
        b = bench.load(bid)
        if not b:
            raise HTTPException(404, "Benchmark not found")
        b["runs"] = [r for r in b["runs"] if r["id"] != rid]
        bench.save(b)
    (bench.bdir(bid) / f"run_{rid}.json").unlink(missing_ok=True)
    return bench.summary(b)


@app.get("/api/admin/bench/{bid}/runs/{rid}/diff")
async def bench_diff(bid: str, rid: str) -> dict:
    try:
        data = read_json(bench.bdir(bid) / f"run_{rid}.json")
    except KeyError:
        data = None
    if not data:
        raise HTTPException(404, "No result for this run")
    return {"diff": data["diff"]}


# ---- sounds --------------------------------------------------------------- #


def sound_counts(events: list[dict]) -> dict:
    counts: dict[str, int] = {}
    for e in events:
        if not e.get("removed"):
            counts[e["label"]] = counts.get(e["label"], 0) + 1
    return counts


def keep_sound_edits(new: list[dict], old: list[dict]) -> list[dict]:
    """Re-detection keeps the user's corrections: removed sounds stay removed, changed ones stay changed."""
    edited = [e for e in old if e.get("removed") or e.get("edited") or e.get("manual")]
    out = []
    for e in new:
        match = next((o for o in edited if not o.get("_used") and o["start"] < e["end"] and o["end"] > e["start"]
                      and (o.get("orig_label") or o["label"]) == e["label"]), None)
        if match:
            match["_used"] = True
            e.update({k: match[k] for k in ("label", "speaker", "removed", "edited", "orig_label") if k in match})
            if match.get("edited"):
                e["sure"] = True
        out.append(e)
    out += [{k: v for k, v in o.items() if k != "_used"} for o in edited if o.get("manual") and not o.get("_used")]
    for o in edited:
        o.pop("_used", None)
    out.sort(key=lambda e: e["start"])
    for i, e in enumerate(out):
        e["id"] = i
    return out


class SoundPatch(BaseModel):
    speaker: Optional[str] = None  # "" = nobody in particular
    label: Optional[str] = None
    removed: Optional[bool] = None


@app.patch("/api/files/{fid}/sounds/{eid}")
async def edit_sound(fid: str, eid: int, body: SoundPatch) -> dict:
    load_meta(fid)
    d = fdir(fid)
    data = read_json(d / "sounds.json")
    e = next((x for x in (data or {}).get("events", []) if x.get("id") == eid), None)
    if e is None:
        raise HTTPException(404, "Sound not found")
    if body.label is not None:
        if body.label not in sounds.GROUPS:
            raise HTTPException(400, "Unknown sound type")
        e.setdefault("orig_label", e["label"])
        e["label"] = body.label
    if body.speaker is not None:
        e["speaker"] = body.speaker or None
        e["sure"] = True
    if body.removed is not None:
        e["removed"] = body.removed
    e["edited"] = True
    write_json(d / "sounds.json", data)
    update_meta(fid, sounds=sound_counts(data["events"]))
    return e


@app.get("/api/files/{fid}/sounds")
async def get_sounds(fid: str) -> dict:
    load_meta(fid)
    data = read_json(fdir(fid) / "sounds.json")
    return {"available": sounds.available(), "detected": data is not None,
            "groups": {g: {"emoji": v[2], "personal": g in sounds.PERSONAL} for g, v in sounds.GROUPS.items()},
            **(data or {"events": []})}


@app.post("/api/files/{fid}/sounds")
async def start_sounds(fid: str) -> dict:
    meta = load_meta(fid)
    if not sounds.available():
        raise HTTPException(501, "The sound model is not installed in this image")
    if meta["status"] in ACTIVE_STATES:
        raise HTTPException(409, f"File is {meta['status']}, try again when it has finished")
    if not (fdir(fid) / "audio.mp3").exists():
        raise HTTPException(409, "The audio for this file was deleted")
    await enqueue(fid, {"job": "sounds"})
    return public_meta(load_meta(fid))


# ---- versions & copies ---------------------------------------------------- #


@app.get("/api/files/{fid}/versions")
async def get_versions(fid: str) -> list[dict]:
    load_meta(fid)
    return list_versions(fdir(fid))


@app.post("/api/files/{fid}/versions/{vid}/activate")
async def activate_version(fid: str, vid: str) -> dict:
    d, current = _editable(fid)
    if not re.fullmatch(r"[a-f0-9]{6,32}", vid):
        raise HTTPException(404, "Version not found")
    path = d / "versions" / f"{vid}.json"
    v = read_json(path)
    if v is None:
        if current.get("version") == vid:
            return with_redactions(d, current)
        raise HTTPException(404, "Version not found")
    archive_active(d)
    t = {**v["transcript"], "version": vid, "markers": current.get("markers") or []}  # markers belong to the file
    redact.reapply(t["segments"], load_redactions(d)["entries"])
    write_json(d / "transcript.json", t)
    if v.get("orig"):
        write_json(d / "transcript.orig.json", v["orig"])
    path.unlink(missing_ok=True)
    update_meta(fid, model=t.get("model"), speaker_count=len(t.get("speakers") or {}))
    return with_redactions(d, t)


@app.delete("/api/files/{fid}/versions/{vid}")
async def delete_version(fid: str, vid: str) -> dict:
    d = fdir(fid)
    load_meta(fid)
    if not re.fullmatch(r"[a-f0-9]{6,32}", vid):
        raise HTTPException(404, "Version not found")
    path = d / "versions" / f"{vid}.json"
    if not path.exists():
        raise HTTPException(400, "Only earlier versions can be deleted; switch to another version first")
    path.unlink()
    versions = list_versions(d)
    update_meta(fid, version_count=len(versions))
    return {"versions": versions}


@app.post("/api/files/{fid}/copy")
async def copy_file(fid: str) -> dict:
    meta = load_meta(fid)
    src = fdir(fid)
    new = uuid.uuid4().hex
    dest = cfg.FILES_DIR / new
    await asyncio.get_running_loop().run_in_executor(
        None, lambda: shutil.copytree(src, dest, ignore=shutil.ignore_patterns("work", "*.tmp", "original.*")))
    stem, ext = Path(meta["name"]).stem, Path(meta["name"]).suffix
    m = {**meta, "id": new, "name": f"{stem} (copy){ext}", "created": time.time(), "owner": auth.owner_id(),
         "queued_opts": None, "copied_from": fid}
    if m.get("status") in ACTIVE_STATES:
        m["status"] = "done" if (dest / "transcript.json").exists() else ("ready" if (dest / "audio.mp3").exists() else "error")
    write_json(dest / "meta.json", m)
    return public_meta(m)


# ---- accounts ------------------------------------------------------------ #


class LoginBody(BaseModel):
    username: str
    password: str


def _client_key(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    return fwd or (request.client.host if request.client else "?")


@app.post("/api/auth/login")
async def login(body: LoginBody, request: Request) -> Response:
    if not auth.enabled():
        return JSONResponse({"ok": True, "accounts": False})
    key = _client_key(request)
    if auth.throttled(key):
        raise HTTPException(429, "Too many attempts. Wait a few minutes and try again.")
    u = auth.by_username(body.username)
    ok = await asyncio.get_running_loop().run_in_executor(
        None, lambda: bool(u) and auth.check_password(body.password, u["hash"]))
    if not ok or u.get("disabled"):
        auth.record_failure(key)
        await asyncio.sleep(0.5)
        raise HTTPException(401, "Wrong username or password" if not (ok and u.get("disabled")) else "This account is disabled")
    auth.update(u["id"], last_login=time.time())
    resp = JSONResponse({"ok": True, "user": auth.public(u)})
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    resp.set_cookie(auth.COOKIE, auth.make_session(u), max_age=auth.SESSION_DAYS * 86400, httponly=True,
                    samesite="lax", secure=secure, path="/")
    return resp


@app.post("/api/auth/logout")
async def logout() -> Response:
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE, path="/")
    return resp


@app.get("/api/auth/me")
async def me(request: Request) -> dict:
    if not auth.enabled():
        return {"accounts": False, "user": auth.public(auth.LOCAL_USER)}
    u = auth.read_session(request.cookies.get(auth.COOKIE))
    return {"accounts": True, "user": auth.public(u) if u else None}


class PasswordBody(BaseModel):
    current: str
    new: str


@app.post("/api/auth/password")
async def change_password(body: PasswordBody, request: Request) -> Response:
    u = auth.user()
    if not auth.enabled():
        raise HTTPException(400, "Accounts are not enabled")
    if u.get("env_admin"):
        raise HTTPException(400, "This admin's password is set in the container settings (ADMIN_PASSWORD)")
    if not auth.check_password(body.current, u["hash"]):
        raise HTTPException(400, "Current password is wrong")
    try:
        u = auth.update(u["id"], password=body.new)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    resp = JSONResponse({"ok": True})  # re-issue the cookie (the old one is now invalid)
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    resp.set_cookie(auth.COOKIE, auth.make_session(u), max_age=auth.SESSION_DAYS * 86400, httponly=True,
                    samesite="lax", secure=secure, path="/")
    return resp


def _usage() -> dict:
    out: dict[str, dict] = {}
    for meta_path in cfg.FILES_DIR.glob("*/meta.json"):
        meta = read_json(meta_path) or {}
        u = out.setdefault(meta.get("owner") or "", {"files": 0, "bytes": 0, "seconds": 0.0})
        u["files"] += 1
        u["seconds"] += float(meta.get("duration") or 0)
        u["bytes"] += sum(f.stat().st_size for f in meta_path.parent.rglob("*") if f.is_file())
    return out


@app.get("/api/admin/users")
async def admin_users() -> list[dict]:
    usage = await asyncio.get_running_loop().run_in_executor(None, _usage)
    me_id = auth.owner_id()
    return [{**auth.public(u), "me": u["id"] == me_id, **usage.get(u["id"], {"files": 0, "bytes": 0, "seconds": 0})}
            for u in sorted(auth.users(), key=lambda u: u.get("created", 0))]


class NewUser(BaseModel):
    username: str
    password: str
    name: str = ""
    admin: bool = False


@app.post("/api/admin/users")
async def admin_create_user(body: NewUser) -> dict:
    try:
        return auth.public(auth.create(body.username, body.password, body.name, body.admin))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


class UserPatch(BaseModel):
    name: Optional[str] = None
    admin: Optional[bool] = None
    disabled: Optional[bool] = None
    password: Optional[str] = None


@app.patch("/api/admin/users/{uid}")
async def admin_update_user(uid: str, body: UserPatch) -> dict:
    target = auth.get(uid)
    if not target:
        raise HTTPException(404, "User not found")
    changes = body.model_dump(exclude_none=True)
    if target.get("env_admin") and ({"admin", "disabled", "password"} & set(changes)):
        raise HTTPException(400, "The admin from the container settings can only be changed there")
    if uid == auth.owner_id() and (changes.get("admin") is False or changes.get("disabled")):
        raise HTTPException(400, "You can't remove your own admin access or disable yourself")
    try:
        return auth.public(auth.update(uid, **changes))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None


@app.delete("/api/admin/users/{uid}")
async def admin_delete_user(uid: str, files: str = Query("delete")) -> dict:
    target = auth.get(uid)
    if not target:
        raise HTTPException(404, "User not found")
    if target.get("env_admin") or uid == auth.owner_id():
        raise HTTPException(400, "This account can't be deleted")
    moved = removed = 0
    for meta_path in list(cfg.FILES_DIR.glob("*/meta.json")):
        meta = read_json(meta_path) or {}
        if meta.get("owner") != uid:
            continue
        if files == "transfer":
            meta["owner"] = auth.owner_id()
            write_json(meta_path, meta)
            moved += 1
        else:
            task = RUNNING.get(meta.get("id", ""))
            if task and not task.done():
                task.cancel()
            shutil.rmtree(meta_path.parent, ignore_errors=True)
            removed += 1
    shutil.rmtree(cfg.DATA_DIR / "users" / re.sub(r"[^a-z0-9]", "", uid.lower()), ignore_errors=True)
    auth.delete(uid)
    return {"ok": True, "transferred": moved, "deleted": removed}


@app.get("/api/health")
async def health() -> JSONResponse:
    return JSONResponse({"ok": True, "queue": queue.qsize()})


app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
