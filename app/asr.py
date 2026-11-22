"""Speech-to-text pipeline: silence-aware chunking, backend calls, word timing and segmentation."""

from __future__ import annotations

import asyncio
import base64
import logging
import math
import re
import time
import zlib
from bisect import bisect_right
from pathlib import Path
from typing import Any, Callable, Optional

import httpx

import settings as cfg

log = logging.getLogger("transcriber.asr")

Word = dict  # {"w": " text", "s": float, "e": float, "p": float|None, "est": bool}
SENT_END = re.compile(r"[.!?…][\"'”’)\]]*$")


# --------------------------------------------------------------------------- #
# subprocess helpers
# --------------------------------------------------------------------------- #


async def run(*cmd: str) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate()
    return proc.returncode or 0, out, err


# --------------------------------------------------------------------------- #
# Silence detection & chunk planning
# --------------------------------------------------------------------------- #


async def detect_silences(audio: Path) -> list[tuple[float, float]]:
    """Return (start, end) silent spans, using a threshold relative to the file's loudness."""
    _, _, err = await run("ffmpeg", "-nostats", "-i", str(audio), "-af", "volumedetect", "-f", "null", "-")
    m = re.search(r"mean_volume:\s*(-?[\d.]+) dB", err.decode(errors="ignore"))
    mean = float(m.group(1)) if m else -25.0
    noise = max(-55.0, min(-25.0, mean - 14.0))
    _, _, err = await run("ffmpeg", "-nostats", "-i", str(audio), "-af",
                          f"silencedetect=noise={noise:.1f}dB:d=0.3", "-f", "null", "-")
    spans, start = [], None
    for line in err.decode(errors="ignore").splitlines():
        if (m := re.search(r"silence_start: (-?[\d.]+)", line)):
            start = max(0.0, float(m.group(1)))
        elif (m := re.search(r"silence_end: ([\d.]+)", line)) and start is not None:
            spans.append((start, float(m.group(1))))
            start = None
    return spans


def plan_chunks(duration: float, silences: list[tuple[float, float]], target: float) -> list[tuple[float, float]]:
    """Cut roughly every `target` seconds, preferring the longest nearby pause."""
    if target <= 0 or duration <= target * 1.5:
        return [(0.0, duration)]
    gaps = [((a + b) / 2, b - a) for a, b in silences]
    chunks, start = [], 0.0
    while duration - start > target * 1.5:
        ideal = start + target
        cands = [(mid, width) for mid, width in gaps if start + target * 0.5 <= mid <= start + target * 1.5]
        if cands:
            cut = max(cands, key=lambda c: min(c[1], 1.5) - abs(c[0] - ideal) / target)[0]
        else:
            cut = ideal
        chunks.append((start, cut))
        start = cut
    chunks.append((start, duration))
    return chunks


def speech_regions(start: float, end: float, silences: list[tuple[float, float]]) -> list[tuple[float, float]]:
    regions, cur = [], start
    for a, b in silences:
        if b <= start or a >= end:
            continue
        a, b = max(a, start), min(b, end)
        if a - cur > 0.05:
            regions.append((cur, a))
        cur = max(cur, b)
    if end - cur > 0.05:
        regions.append((cur, end))
    total = sum(b - a for a, b in regions)
    if not regions or total < 0.25 * (end - start):
        return [(start, end)]
    return regions


def _split_regions(regions: list[tuple[float, float]], cuts: list[float]) -> list[tuple[float, float]]:
    out = []
    for a, b in regions:
        inner = sorted(c for c in cuts if a + 0.2 < c < b - 0.2)
        for c in inner:
            out.append((a, c))
            a = c
        out.append((a, b))
    return out


def _spread(words: list[Word], a: float, b: float, weights: list[float]) -> None:
    wsum = sum(weights) or 1.0
    cum = 0.0
    for w, wt in zip(words, weights):
        s = a + cum / wsum * (b - a)
        cum += wt
        w["s"], w["e"], w["est"] = round(s, 3), round(a + cum / wsum * (b - a), 3), True


def estimate_times(words: list[Word], start: float, end: float, silences: list[tuple[float, float]],
                   cuts: Optional[list[float]] = None) -> None:
    """Estimate word times when the model gives none.

    Speech between pauses (and speaker changes, if known) forms regions. A small dynamic program
    assigns consecutive runs of words to regions so that region lengths match the words' expected
    duration and region boundaries fall on punctuation. Words are then spread within each region.
    """
    if not words:
        return
    weights = [len(w["w"].strip()) + 2.0 for w in words]
    regions = _split_regions(speech_regions(start, end, silences), cuts or [])
    n, k = len(words), len(regions)
    if k == 1 or n == 1:
        a, b = regions[0][0], regions[-1][1]
        _spread(words, a, b, weights)
        return

    total_d = sum(b - a for a, b in regions)
    rate = total_d / sum(weights)  # seconds per weight unit
    prefix = [0.0]
    for wt in weights:
        prefix.append(prefix[-1] + wt)

    def boundary_penalty(j: int) -> float:  # cost of a region ending after word j-1
        if j == n:
            return 0.0
        t = words[j - 1]["w"].strip()
        if SENT_END.search(t):
            return 0.0
        if t[-1:] in ",;:—-":
            return 0.4
        return 1.5

    INF = float("inf")
    best = [[INF] * (n + 1) for _ in range(k + 1)]
    back = [[0] * (n + 1) for _ in range(k + 1)]
    best[0][0] = 0.0
    for r in range(1, k + 1):
        d = regions[r - 1][1] - regions[r - 1][0]
        max_run = int(d / rate / 3.0) + 6  # a word is >= ~3 weight units, allow slack
        for j in range(0, n + 1):
            # empty region (breath, noise, music)
            cost = best[r - 1][j] + d * 1.2
            arg = j
            for i in range(max(0, j - max_run), j):
                if best[r - 1][i] == INF:
                    continue
                exp = (prefix[j] - prefix[i]) * rate
                c = best[r - 1][i] + (d - exp) ** 2 / (exp + d + 0.5) + boundary_penalty(j)
                if c < cost:
                    cost, arg = c, i
            best[r][j], back[r][j] = cost, arg
    if best[k][n] == INF:
        _spread(words, regions[0][0], regions[-1][1], weights)
        return
    j = n
    spans = []
    for r in range(k, 0, -1):
        i = back[r][j]
        spans.append((r - 1, i, j))
        j = i
    for r, i, j in spans:
        if j > i:
            a, b = regions[r]
            _spread(words[i:j], a, b, weights[i:j])


# --------------------------------------------------------------------------- #
# Backend calls
# --------------------------------------------------------------------------- #


class ContextTooLarge(Exception):
    pass


class BackendError(Exception):
    def __init__(self, msg: str, status: int = 0):
        super().__init__(msg)
        self.status = status


def headers() -> dict:
    return {"Authorization": f"Bearer {cfg.LLAMA_SWAP_API_KEY}"} if cfg.LLAMA_SWAP_API_KEY else {}


async def list_models() -> list[dict]:
    async with httpx.AsyncClient(timeout=8) as client:
        r = await client.get(f"{cfg.LLAMA_SWAP_URL}/v1/models", headers=headers())
        r.raise_for_status()
        return [m for m in r.json().get("data", []) if m.get("id")]


async def resolve_api(model: str) -> str:
    if cfg.TRANSCRIBE_API in ("chat", "transcriptions"):
        return cfg.TRANSCRIBE_API
    try:
        for m in await list_models():
            if m["id"] == model:
                inputs = (m.get("architecture") or {}).get("input_modalities") or []
                upstream = ((m.get("meta") or {}).get("llamaswap") or {}).get("upstream")
                if "audio" in inputs and upstream == "llama-server":
                    return "chat"
    except Exception as exc:  # noqa: BLE001
        log.warning("could not inspect models: %s", exc)
    return "transcriptions"


def _check_error(r: httpx.Response) -> None:
    if r.status_code < 400:
        return
    body = r.text[:600]
    low = body.lower()
    if "context" in low and ("exceed" in low or "too long" in low or "too large" in low):
        raise ContextTooLarge(body)
    raise BackendError(f"HTTP {r.status_code}: {body}", r.status_code)


class Transcriber:
    """Sends audio chunks to llama-swap and returns timed words."""

    def __init__(self, model: str, api: str, language: Optional[str], prompt: Optional[str]):
        self.model, self.api = model, api
        self.language, self.prompt = language, prompt
        self.formats = ["verbose_json+words", "verbose_json", "json"]
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(cfg.REQUEST_TIMEOUT, connect=30))

    async def close(self) -> None:
        await self.client.aclose()

    async def transcribe(self, path: Path, start: float, end: float,
                         silences: list[tuple[float, float]]) -> tuple[list[Word], bool]:
        """Transcribe one chunk. Returns (words with absolute times, whether times are chunk-level estimates)."""
        for attempt in range(3):
            try:
                if self.api == "chat":
                    try:
                        return await self._chat(path, start, end, silences)
                    except BackendError as exc:
                        if exc.status in (400, 404, 415, 422, 501):
                            log.warning("chat mode rejected (%s); falling back to transcriptions", exc)
                            self.api = "transcriptions"
                            continue
                        raise
                return await self._transcriptions(path, start, end, silences)
            except (httpx.TransportError, BackendError) as exc:
                status = getattr(exc, "status", 0)
                if isinstance(exc, BackendError) and status and status < 500:
                    raise
                if attempt == 2:
                    raise
                log.warning("chunk %.0f-%.0fs failed (%s), retrying", start, end, exc)
                await asyncio.sleep(3 * (attempt + 1))
        raise BackendError("unreachable")

    # ---- /v1/audio/transcriptions ------------------------------------------
    async def _transcriptions(self, path: Path, start: float, end: float,
                              silences: list[tuple[float, float]]) -> tuple[list[Word], bool]:
        mime = "audio/wav" if path.suffix == ".wav" else "audio/mpeg"
        while True:
            fmt = self.formats[0]
            data: dict[str, Any] = {"model": self.model, "response_format": fmt.split("+")[0]}
            if fmt.endswith("+words"):
                data["timestamp_granularities[]"] = ["segment", "word"]
            if self.language:
                data["language"] = self.language
            if self.prompt:
                data["prompt"] = self.prompt
            with path.open("rb") as fh:
                r = await self.client.post(f"{cfg.LLAMA_SWAP_URL}/v1/audio/transcriptions", data=data,
                                           files={"file": (path.name, fh, mime)}, headers=headers())
            try:
                _check_error(r)
            except BackendError as exc:
                if exc.status in (400, 415, 422) and len(self.formats) > 1:
                    log.info("response_format %s rejected, trying %s", fmt, self.formats[1])
                    self.formats.pop(0)
                    continue
                raise
            try:
                raw = r.json()
            except ValueError:
                raw = {"text": r.text}
            has_segments = isinstance(raw, dict) and bool(raw.get("segments"))
            return words_from_transcription(raw, start, end, silences), not has_segments

    # ---- /v1/chat/completions with input_audio + logprobs --------------------
    async def _chat(self, path: Path, start: float, end: float,
                    silences: list[tuple[float, float]]) -> tuple[list[Word], bool]:
        content: list[dict] = [{"type": "input_audio", "input_audio": {
            "data": base64.b64encode(path.read_bytes()).decode(),
            "format": "wav" if path.suffix == ".wav" else "mp3"}}]
        instruction = self.prompt or cfg.CHAT_PROMPT
        if instruction:
            content.append({"type": "text", "text": instruction})
        body = {"model": self.model, "messages": [{"role": "user", "content": content}],
                "temperature": 0, "logprobs": True, "max_tokens": int((end - start) * 12) + 256}
        r = await self.client.post(f"{cfg.LLAMA_SWAP_URL}/v1/chat/completions", json=body, headers=headers())
        _check_error(r)
        choice = r.json()["choices"][0]
        text = (choice.get("message") or {}).get("content") or ""
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
        tokens = ((choice.get("logprobs") or {}).get("content")) or []
        words = words_from_logprobs(tokens, text)
        estimate_times(words, start, end, silences)
        return words, True


def words_from_logprobs(tokens: list[dict], text: str) -> list[Word]:
    """Group tokens into whitespace-delimited words; word probability = product of token probabilities."""
    def norm(s: str) -> str:
        return " ".join(s.split())

    groups: list[tuple[bytes, float]] = []
    cur, lp = b"", 0.0
    for t in tokens:
        b = bytes(t["bytes"]) if t.get("bytes") else str(t.get("token", "")).encode()
        if b[:1] in (b" ", b"\n", b"\t") and cur.strip():
            groups.append((cur, lp))
            cur, lp = b"", 0.0
        cur += b
        lp += float(t.get("logprob") or 0.0)
    if cur.strip():
        groups.append((cur, lp))
    words = [{"w": " " + g.decode("utf-8", "replace").strip(), "p": round(math.exp(l), 4)} for g, l in groups]
    if not words or norm("".join(w["w"] for w in words)) != norm(text):
        words = [{"w": " " + w, "p": None} for w in text.split()]
    return words


def _num(v: Any) -> Optional[float]:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def words_from_transcription(raw: Any, start: float, end: float,
                             silences: list[tuple[float, float]]) -> list[Word]:
    if isinstance(raw, str):
        raw = {"text": raw}
    out: list[Word] = []
    segments = raw.get("segments") or []
    top_words = raw.get("words") or []
    for seg in segments:
        s0, s1 = (_num(seg.get("start")) or 0.0) + start, (_num(seg.get("end")) or 0.0) + start
        seg_p = math.exp(seg["avg_logprob"]) if _num(seg.get("avg_logprob")) is not None else None
        words = []
        for w in seg.get("words") or []:
            t = w.get("word", w.get("text", ""))
            if not t or re.fullmatch(r"\s*\[_?[A-Z_]+_?\]\s*", t):
                continue
            ws, we = _num(w.get("start")), _num(w.get("end"))
            words.append({"w": " " + t.strip(), "s": ws + start if ws is not None else None,
                          "e": we + start if we is not None else None,
                          "p": _num(w.get("probability", w.get("p"))), "est": False})
        if not words and top_words:  # OpenAI style: words at top level
            for w in top_words:
                ws = (_num(w.get("start")) or 0.0) + start
                if s0 - 0.05 <= ws < s1 + 0.05:
                    we = _num(w.get("end"))
                    words.append({"w": " " + str(w.get("word", "")).strip(), "s": ws,
                                  "e": we + start if we is not None else ws, "p": _num(w.get("probability")), "est": False})
        if not words or any(w["s"] is None for w in words):
            words = [{"w": " " + t, "p": None} for t in (seg.get("text") or "").split()]
            estimate_times(words, s0, max(s1, s0 + 0.1), silences)
        for w in words:
            if w["p"] is None:
                w["p"] = round(seg_p, 4) if seg_p is not None else None
            w["e"] = w["e"] if w["e"] is not None else w["s"]
        if words:
            words[-1]["brk"] = True
        out.extend(words)
    if not segments:
        out = [{"w": " " + t, "p": None} for t in (raw.get("text") or "").split()]
        estimate_times(out, start, end, silences)
    return out


# --------------------------------------------------------------------------- #
# Full pipeline
# --------------------------------------------------------------------------- #


async def extract_chunk(audio: Path, start: float, end: float, dest_dir: Path, name: str) -> Path:
    wav = cfg.UPSTREAM_FORMAT == "wav"
    dest = dest_dir / f"chunk_{name}.{'wav' if wav else 'mp3'}"
    codec = ["-c:a", "pcm_s16le"] if wav else ["-c:a", "libmp3lame", "-b:a", "64k"]
    code, _, err = await run("ffmpeg", "-y", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}",
                             "-i", str(audio), "-ac", "1", "-ar", "16000", *codec, str(dest))
    if code != 0:
        raise RuntimeError(f"chunk extraction failed: {err.decode(errors='ignore')[-300:]}")
    return dest


async def transcribe_file(audio: Path, duration: float, opts: dict, work_dir: Path,
                          progress: Callable[[dict], None]) -> dict:
    model = opts.get("model") or cfg.DEFAULT_MODEL
    api = await resolve_api(model)
    progress({"stage": "analyzing", "label": "Finding pauses to split on"})
    silences = await detect_silences(audio)
    chunks = plan_chunks(duration, silences, float(opts.get("chunk_seconds") or cfg.CHUNK_SECONDS))
    log.info("transcribing %s (%.0fs) with %s via %s in %d chunks", audio, duration, model, api, len(chunks))

    tr = Transcriber(model, api, opts.get("language") or cfg.DEFAULT_LANGUAGE or None, opts.get("prompt"))
    results: list[Optional[list[tuple]]] = [None] * len(chunks)
    done = 0
    t0 = time.time()
    sem = asyncio.Semaphore(cfg.CHUNK_CONCURRENCY)
    work_dir.mkdir(parents=True, exist_ok=True)

    async def do_span(start: float, end: float, idx: str, depth: int = 0) -> list[tuple]:
        path = await extract_chunk(audio, start, end, work_dir, idx)
        try:
            words, realign = await tr.transcribe(path, start, end, silences)
            return [(start, end, words, realign)]
        except ContextTooLarge:
            if depth >= 5 or end - start < 4:
                raise
            mid = plan_chunks(end - start, [(a - start, b - start) for a, b in silences], (end - start) / 2)
            cut = start + mid[0][1] if len(mid) > 1 else (start + end) / 2
            log.info("chunk %.0f-%.0fs too large for context, splitting at %.1f", start, end, cut)
            return (await do_span(start, cut, idx + "a", depth + 1)) + (await do_span(cut, end, idx + "b", depth + 1))
        finally:
            path.unlink(missing_ok=True)

    async def worker(i: int, span: tuple[float, float]) -> None:
        nonlocal done
        async with sem:
            c0 = time.time()
            results[i] = await do_span(span[0], span[1], str(i))
            log.info("chunk %d/%d (%.0f-%.0fs) done in %.1fs", i + 1, len(chunks), span[0], span[1], time.time() - c0)
        done += 1
        elapsed = time.time() - t0
        progress({"stage": "transcribing", "done": done, "total": len(chunks),
                  "eta": round(elapsed / done * (len(chunks) - done), 1)})

    progress({"stage": "transcribing", "label": None, "done": 0, "total": len(chunks)})
    try:
        await asyncio.gather(*(worker(i, c) for i, c in enumerate(chunks)))
    finally:
        await tr.close()

    spans = [span for chunk in results for span in (chunk or [])]
    return {"spans": spans, "silences": silences, "api": tr.api, "model": model, "chunks": len(chunks)}


def finalize_words(spans: list[tuple], silences: list[tuple[float, float]],
                   turns: Optional[list[tuple[float, float, int]]] = None) -> list[Word]:
    """Flatten chunk results; re-align estimated timings using speaker changes as extra anchors."""
    cuts: list[float] = []
    if turns:
        ordered = sorted(turns)
        for prev, nxt in zip(ordered, ordered[1:]):
            if prev[2] != nxt[2]:
                cuts.append((prev[1] + nxt[0]) / 2 if nxt[0] >= prev[1] else nxt[0])
    words: list[Word] = []
    for start, end, chunk_words, realign in spans:
        if realign and cuts and chunk_words:
            estimate_times(chunk_words, start, end, silences, [c for c in cuts if start < c < end])
        words.extend(chunk_words)
    return words


# --------------------------------------------------------------------------- #
# Speakers, segmentation and uncertainty scoring
# --------------------------------------------------------------------------- #



def assign_speakers(words: list[Word], turns: list[tuple[float, float, int]]) -> dict:
    # With estimated timings a sentence is always kept with one speaker; with model timings a
    # sentence may be split when no speaker clearly dominates it.
    """Give each word a speaker label, smoothing so whole sentences stay with one speaker."""
    if not turns or not words:
        return {}
    order: dict[int, str] = {}
    for _, _, spk in sorted(turns):
        order.setdefault(spk, f"S{len(order) + 1}")
    starts = [t[0] for t in turns]

    def speaker_at(s: float, e: float) -> Optional[str]:
        i = bisect_right(starts, e)
        best, best_ov, nearest, nearest_d = None, 0.0, None, 1e9
        for j in range(max(0, i - 6), min(len(turns), i + 1)):
            a, b, spk = turns[j]
            ov = min(b, e) - max(a, s)
            if ov > best_ov:
                best, best_ov = spk, ov
            d = max(a - e, s - b, 0)
            if d < nearest_d:
                nearest, nearest_d = spk, d
        spk = best if best is not None else (nearest if nearest_d < 1.5 else None)
        return order.get(spk) if spk is not None else None

    prev = None
    for w in words:
        w["spk"] = speaker_at(w["s"], max(w["e"], w["s"] + 0.05)) or prev
        prev = w["spk"]

    # Sentence-level smoothing: estimated word times are approximate, so let the majority win.
    sent: list[Word] = []
    for i, w in enumerate(words):
        sent.append(w)
        if SENT_END.search(w["w"].strip()) or i == len(words) - 1:
            votes: dict[str, float] = {}
            for x in sent:
                if x["spk"]:
                    votes[x["spk"]] = votes.get(x["spk"], 0) + max(0.05, x["e"] - x["s"])
            if votes:
                top, share = max(votes.items(), key=lambda kv: kv[1])
                estimated = any(x.get("est") for x in sent)
                if estimated or share / sum(votes.values()) >= 0.6:
                    for x in sent:
                        x["spk"] = top
            sent = []
    return {label: {"name": f"Speaker {label[1:]}"} for label in order.values()}


def build_segments(words: list[Word], max_words: int = 40) -> list[dict]:
    segs: list[dict] = []
    cur: list[Word] = []

    def flush() -> None:
        if not cur:
            return
        text = "".join(w["w"] for w in cur).strip()
        segs.append({
            "id": len(segs), "start": cur[0]["s"], "end": max(cur[-1]["e"], cur[0]["s"]),
            "text": text, "speaker": cur[0].get("spk"),
            "words": [{"w": w["w"], "s": w["s"], "e": w["e"], "p": w.get("p"), **({"est": True} if w.get("est") else {})}
                      for w in cur],
        })
        cur.clear()

    for w in words:
        if cur and w.get("spk") != cur[-1].get("spk"):
            flush()
        cur.append(w)
        token = w["w"].strip()
        if (w.get("brk") or SENT_END.search(token)
                or (len(cur) >= max_words and token[-1:] in ",;:")
                or len(cur) >= max_words * 1.6):
            flush()
    flush()
    return segs


def score_segments(segs: list[dict]) -> None:
    prev = None
    for seg in segs:
        probs = [w["p"] for w in seg.get("words") or [] if w.get("p") is not None]
        if probs:
            mean = sum(probs) / len(probs)
            low = sorted(probs)[: max(1, len(probs) // 5)]
            conf: Optional[float] = 0.75 * mean + 0.25 * (sum(low) / len(low))
        else:
            conf = None
        text = seg["text"]
        issues = []
        if prev and text and text.lower() == prev and len(text) > 8:
            issues.append("Same text as the previous segment, possible hallucination")
        if len(text) >= 60:
            raw = text.encode()
            if len(raw) / max(1, len(zlib.compress(raw))) > 2.4:
                issues.append("Repetitive output, possible hallucination")
        estimated = any(w.get("est") for w in seg.get("words") or [])
        dur = seg["end"] - seg["start"]
        if not estimated and dur > 1.5 and len(text.split()) / dur > 7:
            issues.append("Unusually fast speech for this span, words may be missing or invented")
        seg["confidence"] = round(conf, 4) if conf is not None else None
        seg["issues"] = issues
        seg["low_words"] = [w["w"].strip() for w in seg.get("words") or []
                            if w.get("p") is not None and w["p"] < cfg.WORD_THRESHOLD][:12]
        seg.setdefault("reviewed", False)
        seg.setdefault("edited", False)
        prev = text.lower()
