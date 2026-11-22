"""TranscribeR - a web front end for llama-swap hosted speech-to-text models."""

from __future__ import annotations

import array
import asyncio
import json
import logging
import math
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import httpx
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# --------------------------------------------------------------------------- #
# Configuration (environment variables)
# --------------------------------------------------------------------------- #


def _env_bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
FILES_DIR = DATA_DIR / "files"
LLAMA_SWAP_URL = os.getenv("LLAMA_SWAP_URL", "http://localhost:8080").rstrip("/")
LLAMA_SWAP_API_KEY = os.getenv("LLAMA_SWAP_API_KEY", "")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "whisper")
DEFAULT_LANGUAGE = os.getenv("DEFAULT_LANGUAGE", "")  # empty = auto detect
UPSTREAM_FORMAT = os.getenv("UPSTREAM_FORMAT", "mp3").lower()  # mp3 | wav
REQUEST_TIMEOUT = float(os.getenv("REQUEST_TIMEOUT", "3600"))
UNCERTAINTY_THRESHOLD = float(os.getenv("UNCERTAINTY_THRESHOLD", "0.70"))
WORD_THRESHOLD = float(os.getenv("WORD_THRESHOLD", "0.45"))
MP3_BITRATE = os.getenv("MP3_BITRATE", "128k")
AUTO_TRANSCRIBE = _env_bool("AUTO_TRANSCRIBE", True)
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "4096"))

PEAK_BINS = 2000
ACTIVE_STATES = {"processing", "queued", "transcribing"}

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper(),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("transcriber")

queue: asyncio.Queue[tuple[str, dict]] = asyncio.Queue()

# --------------------------------------------------------------------------- #
# Storage helpers
# --------------------------------------------------------------------------- #

ID_RE = re.compile(r"^[a-f0-9]{32}$")


def fdir(fid: str) -> Path:
    if not ID_RE.match(fid):
        raise HTTPException(404, "File not found")
    return FILES_DIR / fid


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
    if meta.get("status") == "transcribing" and meta.get("started_at"):
        out["elapsed"] = round(time.time() - meta["started_at"], 1)
    return out


# --------------------------------------------------------------------------- #
# ffmpeg helpers
# --------------------------------------------------------------------------- #


async def run(*cmd: str) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate()
    return proc.returncode or 0, out, err


async def probe(path: Path) -> dict:
    code, out, err = await run("ffprobe", "-v", "error", "-print_format", "json",
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
    # Keep the decoded sample count bounded so very long files stay cheap.
    rate = int(max(200, min(4000, 8_000_000 / max(duration, 1))))
    code, out, err = await run("ffmpeg", "-v", "error", "-i", str(audio), "-ac", "1",
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
            code, _, err = await run("ffmpeg", "-y", "-v", "error", "-i", str(original), "-vn",
                                     "-map", "0:a:0", "-c:a", "libmp3lame", "-b:a", MP3_BITRATE,
                                     str(audio))
            if code != 0:
                raise RuntimeError(f"ffmpeg conversion failed: {err.decode(errors='ignore')[-300:]}")
            converted = True
        ainfo = await probe(audio)
        duration = float(ainfo.get("format", {}).get("duration") or 0)
        write_json(d / "peaks.json", await compute_peaks(audio, duration))
        if converted:
            original.unlink(missing_ok=True)  # keep storage lean; the mp3 is the canonical copy
        update_meta(fid, status="ready", duration=duration, converted=converted,
                    source_format=source_format, error=None)
        meta = load_meta(fid)
        if meta.get("auto_transcribe", AUTO_TRANSCRIBE):
            await enqueue(fid, meta.get("upload_opts") or {})
    except Exception as exc:  # noqa: BLE001
        log.exception("prepare failed for %s", fid)
        update_meta(fid, status="error", error=str(exc))


# --------------------------------------------------------------------------- #
# Transcription
# --------------------------------------------------------------------------- #


def upstream_headers() -> dict:
    return {"Authorization": f"Bearer {LLAMA_SWAP_API_KEY}"} if LLAMA_SWAP_API_KEY else {}


def _num(v: Any) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def normalize_transcript(raw: Any, duration: float) -> dict:
    """Turn whatever the backend returned into our segment format with confidence data."""
    if isinstance(raw, str):
        raw = {"text": raw}
    segments_in = raw.get("segments") or []
    top_words = raw.get("words") or []

    segments: list[dict] = []
    for i, s in enumerate(segments_in):
        start, end = _num(s.get("start")) or 0.0, _num(s.get("end")) or 0.0
        words = []
        for w in s.get("words") or []:
            text = w.get("word", w.get("text", ""))
            if not text or re.fullmatch(r"\s*\[_?[A-Z_]+_?\]\s*", text):
                continue
            words.append({"w": text, "s": _num(w.get("start")), "e": _num(w.get("end")),
                          "p": _num(w.get("probability", w.get("p")))})
        segments.append({
            "id": i, "start": start, "end": max(end, start), "text": (s.get("text") or "").strip(),
            "words": words, "avg_logprob": _num(s.get("avg_logprob")),
            "no_speech_prob": _num(s.get("no_speech_prob")),
            "compression_ratio": _num(s.get("compression_ratio")),
        })

    # OpenAI style: words are top-level, distribute them into segments by time.
    if top_words and segments and not any(seg["words"] for seg in segments):
        for w in top_words:
            ws = _num(w.get("start")) or 0.0
            for seg in segments:
                if seg["start"] - 0.05 <= ws < seg["end"] + 0.05:
                    seg["words"].append({"w": " " + w.get("word", "").strip(), "s": ws,
                                         "e": _num(w.get("end")), "p": _num(w.get("probability"))})
                    break

    if not segments:
        segments = [{"id": 0, "start": 0.0, "end": duration, "text": (raw.get("text") or "").strip(),
                     "words": [], "avg_logprob": None, "no_speech_prob": None, "compression_ratio": None}]

    prev_text = None
    for seg in segments:
        score_uncertainty(seg, prev_text)
        prev_text = seg["text"].lower()
        seg["reviewed"] = False
        seg["edited"] = False

    return {"language": raw.get("language"), "duration": _num(raw.get("duration")) or duration,
            "segments": segments}


def score_uncertainty(seg: dict, prev_text: Optional[str]) -> None:
    probs = [w["p"] for w in seg["words"] if w["p"] is not None]
    if probs:
        # Mean word probability, pulled down a little by the weakest words.
        mean = sum(probs) / len(probs)
        low = sorted(probs)[: max(1, len(probs) // 5)]
        conf = 0.75 * mean + 0.25 * (sum(low) / len(low))
    elif seg["avg_logprob"] is not None:
        conf = math.exp(seg["avg_logprob"])
    else:
        conf = None

    issues = []
    if seg["no_speech_prob"] is not None and seg["no_speech_prob"] > 0.6 and seg["text"]:
        issues.append("Possibly no speech here (noise or silence transcribed)")
    if seg["compression_ratio"] is not None and seg["compression_ratio"] > 2.4:
        issues.append("Repetitive output, possible hallucination")
    if prev_text and seg["text"] and seg["text"].lower() == prev_text and len(seg["text"]) > 8:
        issues.append("Same text as the previous segment, possible hallucination")
    if seg["end"] - seg["start"] > 1.5 and len(seg["text"].split()) / (seg["end"] - seg["start"]) > 7:
        issues.append("Unusually fast speech for this span, words may be missing or invented")
    low_words = [w["w"].strip() for w in seg["words"] if w["p"] is not None and w["p"] < WORD_THRESHOLD]
    seg["confidence"] = round(conf, 4) if conf is not None else None
    seg["issues"] = issues
    seg["low_words"] = low_words[:12]


async def call_transcription(audio: Path, opts: dict) -> Any:
    model = opts.get("model") or DEFAULT_MODEL
    base = {"model": model}
    if opts.get("language") or DEFAULT_LANGUAGE:
        base["language"] = opts.get("language") or DEFAULT_LANGUAGE
    if opts.get("prompt"):
        base["prompt"] = opts["prompt"]
    attempts = [
        {**base, "response_format": "verbose_json", "timestamp_granularities[]": ["segment", "word"]},
        {**base, "response_format": "verbose_json"},
        {**base, "response_format": "json"},
    ]
    url = f"{LLAMA_SWAP_URL}/v1/audio/transcriptions"
    mime = "audio/wav" if audio.suffix == ".wav" else "audio/mpeg"
    last_error = ""
    async with httpx.AsyncClient(timeout=httpx.Timeout(REQUEST_TIMEOUT, connect=30)) as client:
        for data in attempts:
            with audio.open("rb") as fh:
                r = await client.post(url, data=data, files={"file": (audio.name, fh, mime)},
                                      headers=upstream_headers())
            if r.status_code < 400:
                try:
                    return r.json()
                except ValueError:
                    return r.text
            last_error = f"HTTP {r.status_code}: {r.text[:500]}"
            if r.status_code not in (400, 415, 422):
                break
            log.warning("transcription attempt rejected (%s), retrying with fewer options", last_error)
    raise RuntimeError(f"Transcription backend error ({last_error})")


async def transcribe(fid: str, opts: dict) -> None:
    d = fdir(fid)
    meta = update_meta(fid, status="transcribing", started_at=time.time(), error=None,
                       model=opts.get("model") or DEFAULT_MODEL)
    audio = d / "audio.mp3"
    tmp_wav = d / "upstream.wav"
    try:
        if UPSTREAM_FORMAT == "wav":
            code, _, err = await run("ffmpeg", "-y", "-v", "error", "-i", str(audio), "-ac", "1",
                                     "-ar", "16000", "-c:a", "pcm_s16le", str(tmp_wav))
            if code != 0:
                raise RuntimeError(f"wav conversion failed: {err.decode(errors='ignore')[-300:]}")
            audio = tmp_wav
        t0 = time.time()
        raw = await call_transcription(audio, opts)
        transcript = normalize_transcript(raw, meta.get("duration") or 0)
        transcript.update(model=meta["model"], created=time.time())
        write_json(d / "transcript.orig.json", transcript)
        write_json(d / "transcript.json", transcript)
        update_meta(fid, status="done", transcribed_at=time.time(),
                    transcribe_seconds=round(time.time() - t0, 1), language=transcript.get("language"))
    except Exception as exc:  # noqa: BLE001
        log.exception("transcription failed for %s", fid)
        update_meta(fid, status="error", error=str(exc))
    finally:
        tmp_wav.unlink(missing_ok=True)


async def enqueue(fid: str, opts: dict) -> None:
    update_meta(fid, status="queued", error=None, queued_opts=opts)
    await queue.put((fid, opts))


async def worker() -> None:
    while True:
        fid, opts = await queue.get()
        try:
            if (fdir(fid) / "meta.json").exists():
                await transcribe(fid, opts)
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
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    spawn(worker())
    # Recover work interrupted by a container restart.
    for meta_path in sorted(FILES_DIR.glob("*/meta.json")):
        meta = read_json(meta_path)
        if not meta:
            continue
        if meta.get("status") == "processing":
            spawn(prepare_file(meta["id"]))
        elif meta.get("status") in ("queued", "transcribing"):
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
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{LLAMA_SWAP_URL}/v1/models", headers=upstream_headers())
            r.raise_for_status()
            models = sorted(m.get("id") for m in r.json().get("data", []) if m.get("id"))
    except Exception as exc:  # noqa: BLE001
        error = f"Could not reach llama-swap at {LLAMA_SWAP_URL}: {exc}"
    return {"models": models, "default_model": DEFAULT_MODEL, "default_language": DEFAULT_LANGUAGE,
            "uncertainty_threshold": UNCERTAINTY_THRESHOLD, "word_threshold": WORD_THRESHOLD,
            "auto_transcribe": AUTO_TRANSCRIBE, "backend": LLAMA_SWAP_URL, "backend_error": error}


@app.get("/api/files")
async def list_files() -> list[dict]:
    metas = [read_json(p) for p in FILES_DIR.glob("*/meta.json")]
    metas = [public_meta(m) for m in metas if m]
    return sorted(metas, key=lambda m: m.get("created", 0), reverse=True)


@app.post("/api/files")
async def upload(file: UploadFile = File(...), model: Optional[str] = Form(None),
                 language: Optional[str] = Form(None), prompt: Optional[str] = Form(None),
                 auto: Optional[bool] = Form(None)) -> dict:
    fid = uuid.uuid4().hex
    d = FILES_DIR / fid
    d.mkdir(parents=True)
    name = Path(file.filename or "audio").name
    ext = re.sub(r"[^a-z0-9]", "", Path(name).suffix.lower())[:8] or "bin"
    original = f"original.{ext}"
    size = 0
    limit = MAX_UPLOAD_MB * 1024 * 1024
    try:
        with (d / original).open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, f"File exceeds {MAX_UPLOAD_MB} MB limit")
                out.write(chunk)
    except BaseException:
        shutil.rmtree(d, ignore_errors=True)
        raise
    meta = {"id": fid, "name": name, "original_file": original, "size": size,
            "created": time.time(), "status": "processing", "error": None,
            "auto_transcribe": AUTO_TRANSCRIBE if auto is None else auto,
            "upload_opts": {k: v for k, v in {"model": model, "language": language,
                                              "prompt": prompt}.items() if v}}
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
    return {"ok": True}


@app.get("/api/files/{fid}/audio")
async def get_audio(fid: str) -> FileResponse:
    path = fdir(fid) / "audio.mp3"
    if not path.exists():
        raise HTTPException(404, "Audio not ready")
    return FileResponse(path, media_type="audio/mpeg")


@app.get("/api/files/{fid}/peaks")
async def get_peaks(fid: str) -> list:
    return read_json(fdir(fid) / "peaks.json", [])


class TranscribeBody(BaseModel):
    model: Optional[str] = None
    language: Optional[str] = None
    prompt: Optional[str] = None


@app.post("/api/files/{fid}/transcribe")
async def start_transcription(fid: str, body: TranscribeBody) -> dict:
    meta = load_meta(fid)
    if meta["status"] in ACTIVE_STATES:
        raise HTTPException(409, f"File is already {meta['status']}")
    if not (fdir(fid) / "audio.mp3").exists():
        raise HTTPException(409, "Audio is not ready")
    await enqueue(fid, body.model_dump(exclude_none=True))
    return public_meta(load_meta(fid))


@app.get("/api/files/{fid}/transcript")
async def get_transcript(fid: str) -> dict:
    t = read_json(fdir(fid) / "transcript.json")
    if t is None:
        raise HTTPException(404, "No transcript yet")
    return t


class SegmentIn(BaseModel):
    id: int
    start: float
    end: float
    text: str
    reviewed: bool = False
    edited: bool = False
    words: Optional[list] = None


class TranscriptIn(BaseModel):
    segments: list[SegmentIn]


@app.put("/api/files/{fid}/transcript")
async def save_transcript(fid: str, body: TranscriptIn) -> dict:
    path = fdir(fid) / "transcript.json"
    t = read_json(path)
    if t is None:
        raise HTTPException(404, "No transcript yet")
    by_id = {s["id"]: s for s in t["segments"]}
    for s in body.segments:
        seg = by_id.get(s.id)
        if seg is None:
            continue
        seg.update(text=s.text, reviewed=s.reviewed, edited=s.edited, start=s.start, end=s.end)
        if s.words is not None:
            seg["words"] = s.words
    t["segments"] = sorted(by_id.values(), key=lambda s: s["start"])
    t["updated"] = time.time()
    write_json(path, t)
    return {"ok": True, "updated": t["updated"]}


@app.post("/api/files/{fid}/transcript/revert")
async def revert_transcript(fid: str) -> dict:
    d = fdir(fid)
    orig = read_json(d / "transcript.orig.json")
    if orig is None:
        raise HTTPException(404, "No original transcript")
    write_json(d / "transcript.json", orig)
    return orig


# ---- exports -------------------------------------------------------------- #


def ts(sec: float, sep: str = ".", hours: bool = True, ms: bool = True) -> str:
    sec = max(0.0, sec)
    h, rem = divmod(int(sec), 3600)
    m, s = divmod(rem, 60)
    frac = f"{sep}{int(round((sec - int(sec)) * 1000)) % 1000:03d}" if ms else ""
    return (f"{h:02d}:" if hours or h else "") + f"{m:02d}:{s:02d}{frac}"


def render_export(t: dict, fmt: str) -> tuple[str, str, str]:
    segs = [s for s in t["segments"] if s["text"].strip()]
    if fmt == "txt":
        paras, cur, last_end = [], [], None
        for s in segs:  # start a new paragraph on long pauses
            if last_end is not None and s["start"] - last_end > 2.0 and cur:
                paras.append(" ".join(cur))
                cur = []
            cur.append(s["text"].strip())
            last_end = s["end"]
        if cur:
            paras.append(" ".join(cur))
        return "\n\n".join(paras) + "\n", "txt", "text/plain"
    if fmt == "timestamps":
        lines = [f"[{ts(s['start'], ms=False)} - {ts(s['end'], ms=False)}] {s['text'].strip()}" for s in segs]
        return "\n".join(lines) + "\n", "timestamps.txt", "text/plain"
    if fmt == "srt":
        blocks = [f"{i}\n{ts(s['start'], ',')} --> {ts(s['end'], ',')}\n{s['text'].strip()}\n"
                  for i, s in enumerate(segs, 1)]
        return "\n".join(blocks), "srt", "application/x-subrip"
    if fmt == "vtt":
        blocks = [f"{ts(s['start'])} --> {ts(s['end'])}\n{s['text'].strip()}\n" for s in segs]
        return "WEBVTT\n\n" + "\n".join(blocks), "vtt", "text/vtt"
    if fmt == "json":
        out = {"language": t.get("language"), "model": t.get("model"),
               "segments": [{"start": s["start"], "end": s["end"], "text": s["text"].strip(),
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
