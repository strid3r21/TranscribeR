"""Built-in MOSS-Transcribe-Diarize engine (transcribe.cpp, runs inside this container).

MOSS transcribes *and* tells speakers apart in one pass, returning turns like
``[0.48][S01]Welcome everyone[1.66]``. transcribe.cpp parses these into segments with real
start/end times and a per-request speaker number.

* GPU via Vulkan when the container can see one (Unraid: Nvidia runtime), otherwise CPU.
* Long audio is cut at pauses into chunks (memory grows ~85 MB per minute of audio); a chunk
  that runs out of memory is split in half and retried.
* MOSS numbers speakers per request, so with several chunks the speakers are linked across
  chunks by voice (TitaNet embeddings), the same way automatic speaker detection merges clusters.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Callable, Optional

import httpx

import asr
import diarize
import settings as cfg

log = logging.getLogger("transcriber.moss")

MODEL_ID = "moss-transcribe-diarize"


def available() -> bool:
    if not cfg.LOCAL_MOSS:
        return False
    try:
        import transcribe_cpp  # noqa: F401
    except Exception:  # noqa: BLE001 - missing package or native library
        return False
    return True


def is_local(model: Optional[str]) -> bool:
    return bool(model) and model == MODEL_ID and cfg.LOCAL_MOSS


def model_path() -> Path:
    if cfg.MOSS_MODEL_PATH:
        return Path(cfg.MOSS_MODEL_PATH)
    return cfg.DATA_DIR / "models" / f"MOSS-Transcribe-Diarize-{cfg.MOSS_QUANT}.gguf"


def model_url() -> str:
    return cfg.MOSS_MODEL_URL or (
        "https://huggingface.co/handy-computer/moss-transcribe-diarize-gguf/resolve/main/"
        f"MOSS-Transcribe-Diarize-{cfg.MOSS_QUANT}.gguf")


async def ensure_model(progress: Callable[[dict], None]) -> Path:
    """Download the GGUF into /data/models on first use."""
    path = model_path()
    if path.exists():
        return path
    if cfg.MOSS_MODEL_PATH:
        raise RuntimeError(f"MOSS model not found at {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    url = model_url()
    log.info("downloading %s", url)
    progress({"stage": "downloading", "label": "Downloading the MOSS model (one time, about 1 GB)", "download": 0.0})
    async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(60.0, read=300.0)) as client:
        async with client.stream("GET", url) as r:
            r.raise_for_status()
            total = int(r.headers.get("content-length") or 0)
            got, last = 0, 0.0
            with open(tmp, "wb") as f:
                async for block in r.aiter_bytes(1 << 20):
                    f.write(block)
                    got += len(block)
                    if total and time.time() - last > 0.5:
                        last = time.time()
                        progress({"download": round(got / total, 3)})
    os.replace(tmp, path)
    progress({"download": None, "label": None})
    return path


def _pcm(audio: Path, start: float, end: float):
    import numpy as np

    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", str(audio),
                          "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


TRUNCATED_NOTE = "The model stopped early here; some words may be missing"
MARKER_RE = re.compile(r"\[(\d+(?:\.\d+)?)\]\s*\[S(\d+)\]\s*(.*?)\s*\[(\d+(?:\.\d+)?)\]", re.S)


class ChunkTooBig(Exception):
    pass


def is_remote(model: Optional[str]) -> bool:
    """llama-swap models that speak MOSS's turn format (served by moss_server.py, vLLM or SGLang)."""
    return bool(model) and not is_local(model) and bool(re.search(cfg.MOSS_REMOTE_MATCH, model, re.I))


def parse_markers(text: str) -> list[tuple[float, float, int, str]]:
    """'[0.48][S01]Welcome everyone[1.66][12.26][S02]...' -> [(0.48, 1.66, 1, 'Welcome everyone'), ...]"""
    return [(float(a), float(b), int(spk), t.strip()) for a, spk, t, b in MARKER_RE.findall(text or "") if t.strip()]


class _Local:
    """Built-in engine. Loaded for the duration of a job (frees GPU memory for llama-swap afterwards)."""

    def __init__(self, path: Path):
        self.path = path
        self.model = None
        self.backend = "?"

    def _load(self) -> None:
        import transcribe_cpp as tc

        self.tc = tc
        self.model = tc.Model(str(self.path), backend=cfg.MOSS_BACKEND)
        self.backend = self.model.backend
        log.info("MOSS loaded on %s", self.backend)

    def _run(self, audio: Path, a: float, b: float, opts: dict):
        tc = self.tc
        kw = dict(diarize="on" if opts["speakers"] else "off")
        if opts["language"]:
            kw["language"] = opts["language"]
        if opts["vocabulary"] and self.model.supports("vocabulary"):
            kw["vocabulary"] = opts["vocabulary"]
        note = None
        with self.model.session(n_threads=cfg.MOSS_THREADS) as s:
            try:
                segs = s.run(_pcm(audio, a, b), **kw).segments
            except tc.OutOfMemory as exc:
                raise ChunkTooBig(str(exc)) from None
            except tc.OutputTruncated as exc:  # includes OutputRepetition
                part = getattr(exc, "partial_result", None)
                segs, note = (part.segments if part else ()), TRUNCATED_NOTE
        return [(sg.t0_ms / 1000.0, sg.t1_ms / 1000.0, max(0, sg.speaker_id), sg.text.strip()) for sg in segs], note

    async def start(self) -> None:
        await _lock_async()
        try:
            await asyncio.get_running_loop().run_in_executor(None, self._load)
        except BaseException:
            _alock.release()
            raise

    async def run(self, audio: Path, a: float, b: float, work_dir: Path, opts: dict):
        return await asyncio.get_running_loop().run_in_executor(None, self._run, audio, a, b, opts)

    async def close(self) -> None:
        try:
            if self.model is not None:
                self.model.close()
        finally:
            _alock.release()

    @property
    def label(self) -> str:
        return f"built-in ({self.backend})"


class _Remote:
    """MOSS behind llama-swap's /v1/audio/transcriptions."""

    def __init__(self, model: str):
        self.model = model
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(cfg.REQUEST_TIMEOUT, connect=30.0))
        self.label = "transcriptions (moss)"

    async def start(self) -> None:
        pass

    async def run(self, audio: Path, a: float, b: float, work_dir: Path, opts: dict):
        path = await asr.extract_chunk(audio, a, b, work_dir, f"moss{a:.0f}")
        try:
            data = {"model": self.model, "response_format": "verbose_json", "temperature": "0",
                    "diarize": "true" if opts["speakers"] else "false"}
            if opts["language"]:
                data["language"] = opts["language"]
            if opts["vocabulary"]:
                data["prompt"] = ", ".join(opts["vocabulary"])
            with open(path, "rb") as f:
                r = await self.client.post(f"{cfg.LLAMA_SWAP_URL}/v1/audio/transcriptions", headers=asr.headers(),
                                           data=data, files={"file": (path.name, f, "audio/mpeg")})
        finally:
            path.unlink(missing_ok=True)
        if r.status_code == 507 or (r.status_code >= 500 and "memory" in r.text.lower()):
            raise ChunkTooBig(r.text[:200])
        if r.status_code >= 400:
            raise asr.BackendError(f"{r.status_code}: {r.text[:300]}", r.status_code)
        body = r.json()
        note = TRUNCATED_NOTE if body.get("truncated") else None
        segs = body.get("segments") or []
        if segs and any(sg.get("speaker") is not None for sg in segs) or (segs and not opts["speakers"]):
            out = []
            for sg in segs:
                spk = str(sg.get("speaker") or "0")
                m = re.search(r"\d+", spk)
                out.append((float(sg.get("start") or 0), float(sg.get("end") or 0), int(m.group()) if m else 0,
                            (sg.get("text") or "").strip()))
            return out, note
        text = body.get("raw_text") or body.get("text") or ""
        turns = parse_markers(text)
        if turns:
            return turns, note
        if segs:  # plain segments without speakers
            return [(float(sg.get("start") or 0), float(sg.get("end") or 0), 0, (sg.get("text") or "").strip())
                    for sg in segs], note
        return ([(0.0, 0.0, 0, text.strip())] if text.strip() else []), note

    async def close(self) -> None:
        await self.client.aclose()


_alock: asyncio.Lock = None  # type: ignore[assignment]


async def _lock_async() -> None:
    global _alock
    if _alock is None:
        _alock = asyncio.Lock()
    await _alock.acquire()


def _words(text: str) -> list[dict]:
    return [{"w": " " + t, "s": 0.0, "e": 0.0, "p": None} for t in text.split()]


def _link_speakers(samples, turns: list[tuple[float, float, int]], num_speakers: int) -> list[tuple[float, float, int]]:
    """Make speaker ids consistent across chunks (and honour a fixed speaker count) by voice."""
    return diarize.merge_clusters(samples, turns, target=num_speakers if num_speakers > 0 else None)


def _language(opts: dict) -> Optional[str]:
    lang = (opts.get("language") or cfg.DEFAULT_LANGUAGE or "").strip().lower()[:2] or None
    if lang not in (None, "en", "zh"):
        log.info("MOSS only knows English and Chinese; ignoring language %r", lang)
        return None
    return lang


async def transcribe_file(audio: Path, duration: float, opts: dict, work_dir: Path,
                          progress: Callable[[dict], None], num_speakers: Optional[int],
                          have_voices: bool = False) -> dict:
    """Returns {words, speakers, centroids, notes, model, api, chunks} — words already carry speakers."""
    model = opts.get("model") or MODEL_ID
    if is_local(model):
        runner = _Local(await ensure_model(progress))
        target = cfg.MOSS_CHUNK_SECONDS
    else:
        runner = _Remote(model)
        target = cfg.MOSS_REMOTE_CHUNK_SECONDS
    progress({"stage": "analyzing", "label": "Finding pauses to split on", "download": None})
    silences = await asr.detect_silences(audio)
    chunks = asr.plan_chunks(duration, silences, target)
    want_speakers = num_speakers is not None
    ropts = {"speakers": want_speakers, "language": _language(opts),
             "vocabulary": [v.strip() for v in re.split(r"[,\n]", opts.get("prompt") or "") if v.strip()] or None}
    loop = asyncio.get_running_loop()
    log.info("transcribing %s (%.0fs) with %s (MOSS) in %d chunks", audio, duration, model, len(chunks))
    work_dir.mkdir(parents=True, exist_ok=True)

    raw: list[tuple[float, float, int, str]] = []  # (start, end, chunk-speaker, text)
    notes: list[tuple[float, float, str]] = []
    t0 = time.time()
    done_secs, runs = 0.0, 0
    progress({"stage": "transcribing", "label": None, "done": 0, "total": len(chunks)})
    await runner.start()
    try:
        pending = list(chunks)
        while pending:
            a, b = pending.pop(0)
            try:
                segs, note = await runner.run(audio, a, b, work_dir, ropts)
            except ChunkTooBig:
                if b - a < 60:
                    raise
                mid = asr.plan_chunks(b - a, [(x - a, y - a) for x, y in silences], (b - a) / 2)
                cut = a + mid[0][1] if len(mid) > 1 else (a + b) / 2
                log.info("chunk %.0f-%.0fs ran out of memory, splitting at %.1f", a, b, cut)
                pending[:0] = [(a, cut), (cut, b)]
                continue
            runs += 1
            base = runs * 100  # chunk-local speaker ids, unique per chunk
            for s, e, spk, text in segs:
                s, e = a + s, a + e
                if e <= s:  # attribution without timing
                    s, e = a, b
                if text:
                    raw.append((min(s, b), min(max(e, s + 0.1), b), base + spk, text))
            if note:
                notes.append((raw[-1][0] if raw else a, b, note))
            done_secs += b - a
            frac = done_secs / max(1.0, duration)
            el = time.time() - t0
            progress({"stage": "transcribing", "done": round(frac * len(chunks), 2), "total": len(chunks),
                      "eta": round(el / frac * (1 - frac), 1) if frac else None})
    finally:
        await runner.close()
    log.info("MOSS (%s) transcribed %.0fs in %.1fs", runner.label, duration, time.time() - t0)
    raw.sort(key=lambda r: r[0])

    turns = [(s, e, spk) for s, e, spk, _ in raw]
    centroids: dict = {}
    if want_speakers and turns and diarize.available() and (runs > 1 or num_speakers > 0 or have_voices):
        progress({"stage": "speakers", "label": "Matching speakers across the recording"})

        def link():
            samples = diarize.load_samples(audio)
            linked = _link_speakers(samples, turns, num_speakers)
            return linked, (diarize.cluster_centroids(samples, linked) if have_voices else {})

        turns, centroids = await loop.run_in_executor(None, link)

    order: dict[int, str] = {}
    words: list[dict] = []
    for (s, e, _, text), (_, _, spk) in zip(raw, turns):
        ws = _words(text)
        if not ws:
            continue
        asr.estimate_times(ws, s, e, silences)
        label = order.setdefault(spk, f"S{len(order) + 1}") if want_speakers else None
        for w in ws:
            w["spk"] = label
        ws[-1]["brk"] = True  # keep MOSS's turn boundaries as line breaks
        words.extend(ws)
    speakers = {label: {"name": f"Speaker {label[1:]}", "_idx": spk} for spk, label in order.items()}
    return {"words": words, "speakers": speakers, "centroids": centroids, "notes": notes,
            "model": model, "api": runner.label, "chunks": len(chunks)}


async def transcribe_window(audio: Path, start: float, end: float, model: str, work_dir: Path) -> str:
    """Plain text for a short window (used to recover permanently redacted words)."""
    runner = _Local(await ensure_model(lambda _p: None)) if is_local(model) else _Remote(model)
    opts = {"speakers": False, "language": _language({}), "vocabulary": None}
    work_dir.mkdir(parents=True, exist_ok=True)
    await runner.start()
    try:
        segs, _ = await runner.run(audio, start, end, work_dir, opts)
    finally:
        await runner.close()
    return " ".join(t for *_, t in segs)
