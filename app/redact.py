"""Reversible redaction of transcript text (and optionally the matching audio).

A redaction replaces text with a token ``[REDACTED:<id>]``. The original text lives only in the
file's ``redactions.json`` (never in the transcript, exports or the API's transcript payload),
so it can be restored with *unredact*, or destroyed with *erase*. Erased / legacy redactions are
plain ``[REDACTED]`` and can't be undone.
"""

from __future__ import annotations

import re
import secrets
from typing import Callable, Optional

REDACTED = "[REDACTED]"
TOKEN_RE = re.compile(r"\[REDACTED(?::([a-z0-9]{6,16}))?\]")
_LEAD = "\"'“‘([{"
_TRAIL = ".,!?;:…\"'”’)]}"


def new_id() -> str:
    return secrets.token_hex(5)


def token(rid: str) -> str:
    return f"[REDACTED:{rid}]"


def plain(text: str) -> str:
    """Text for export / display: every redaction token becomes [REDACTED]."""
    return TOKEN_RE.sub(REDACTED, text)


def _norm(t: str) -> str:
    return " ".join(t.split())


def expand(text: str, a: int, b: int) -> tuple[int, int]:
    """Grow [a, b) to whole words, but leave surrounding punctuation outside the redaction."""
    a, b = max(0, a), min(len(text), b)
    while a > 0 and not text[a - 1].isspace():
        a -= 1
    while b < len(text) and not text[b].isspace():
        b += 1
    while a < b and (text[a] in _LEAD or text[a].isspace()):
        a += 1
    while b > a and (text[b - 1] in _TRAIL or text[b - 1].isspace()):
        b -= 1
    return a, b


def _overlaps_token(text: str, a: int, b: int) -> bool:
    return any(m.start() < b and m.end() > a for m in TOKEN_RE.finditer(text))


def locate(text: str, phrase: str, near: Optional[int]) -> Optional[tuple[int, int]]:
    """Find `phrase` in `text` (ignoring tokens), preferring the occurrence closest to offset `near`."""
    for flags in (0, re.I):
        hits = [m.start() for m in re.finditer(re.escape(phrase), text, flags)
                if not _overlaps_token(text, m.start(), m.end())]
        if hits:
            start = min(hits, key=lambda h: abs(h - (near or 0)))
            return start, start + len(phrase)
    return None


def _word_bounds(words: list[dict]) -> list[tuple[int, int]]:
    joined = "".join(w.get("w", "") for w in words)
    pos = -(len(joined) - len(joined.lstrip()))
    out = []
    for w in words:
        out.append((pos, pos + len(w["w"])))
        pos += len(w["w"])
    return out


def _words_ok(seg: dict) -> bool:
    words = seg.get("words") or []
    joined = "".join(w.get("w", "") for w in words)
    return bool(words) and joined.strip() == (seg.get("text") or "").strip()


def _redact_range(seg: dict, a: int, b: int, rid: str) -> Optional[dict]:
    """Replace text[a:b] with a token. Returns {id, text, span} or None."""
    text = seg.get("text") or ""
    if a >= b or _overlaps_token(text, a, b):
        return None
    original = text[a:b]
    tok = token(rid)
    new_text = text[:a] + tok + text[b:]
    span = None
    if _words_ok(seg):
        words = seg["words"]
        bounds = _word_bounds(words)
        hit = [i for i, (ws, we) in enumerate(bounds) if we > a and ws < b]
        if hit:
            first, last = hit[0], hit[-1]
            prefix = words[first]["w"][: max(0, a - bounds[first][0])]
            suffix = words[last]["w"][max(0, b - bounds[last][0]):]
            s, e = words[first].get("s"), words[last].get("e")
            merged = {"w": prefix + tok + suffix, "s": s, "e": e, "p": None}
            if any(w.get("est") for w in words[first:last + 1]):
                merged["est"] = True
            seg["words"] = words[:first] + [merged] + words[last + 1:]
            if s is not None and e is not None:
                span = [float(s), float(e)]
        if _norm("".join(w["w"] for w in seg["words"])) != _norm(new_text):
            seg["words"] = []
    else:
        seg["words"] = []
    seg["text"] = new_text
    removed = original.lower()
    seg["low_words"] = [x for x in (seg.get("low_words") or [])
                        if not (x.strip(_LEAD + _TRAIL).lower() and x.strip(_LEAD + _TRAIL).lower() in removed)]
    if span is None:  # no usable word timing: fall back to the segment's span
        span = [float(seg["start"]), float(seg["end"])]
    return {"id": rid, "text": original, "span": span, "seg_start": float(seg["start"])}


def _phrase_re(phrase: str) -> re.Pattern:
    return re.compile(r"(?<!\w)" + re.escape(phrase) + r"(?!\w)", re.I)


def redact_phrase(segs: list[dict], phrase: str, only: Optional[dict] = None, near: Optional[int] = None,
                  make_id: Callable[[], str] = new_id) -> list[dict]:
    """Redact `phrase` in one segment (`only`, at the occurrence nearest `near`) or in all segments."""
    out: list[dict] = []
    if only is not None:
        loc = locate(only.get("text") or "", phrase, near)
        if loc and (r := _redact_range(only, *expand(only["text"], *loc), make_id())):
            out.append(r)
        return out
    pattern = _phrase_re(phrase)
    for seg in segs:
        while True:
            text = seg.get("text") or ""
            m = next((m for m in pattern.finditer(text) if not _overlaps_token(text, *expand(text, m.start(), m.end()))), None)
            if not m:
                break
            r = _redact_range(seg, *expand(text, m.start(), m.end()), make_id())
            if r is None:
                break
            out.append(r)
    return out


def count_matches(segs: list[dict], phrase: str) -> int:
    pattern = _phrase_re(phrase)
    return sum(len(pattern.findall(plain(s.get("text") or ""))) for s in segs)


def _replace_token(seg: dict, tok: str, replacement: str) -> bool:
    if tok not in (seg.get("text") or ""):
        return False
    seg["text"] = seg["text"].replace(tok, replacement)
    for w in seg.get("words") or []:
        if tok in w["w"]:
            w["w"] = w["w"].replace(tok, replacement)
    if seg.get("words") and _norm("".join(w["w"] for w in seg["words"])) != _norm(seg["text"]):
        seg["words"] = []
    return True


def unredact(segs: list[dict], rid: str, original: str) -> int:
    return sum(_replace_token(s, token(rid), original) for s in segs)


def finalize(segs: list[dict], rid: str) -> int:
    """Turn a reversible token into a permanent [REDACTED]."""
    return sum(_replace_token(s, token(rid), REDACTED) for s in segs)


def token_ids(segs: list[dict]) -> set[str]:
    return {m.group(1) for s in segs for m in TOKEN_RE.finditer(s.get("text") or "") if m.group(1)}


def reapply(segs: list[dict], entries: dict) -> None:
    """Re-redact text restored from the original model output (used by Revert), keeping the same ids."""
    for rid, e in entries.items():
        if any(token(rid) in (s.get("text") or "") for s in segs):
            continue
        best = sorted(segs, key=lambda s: abs(float(s["start"]) - float(e.get("seg_start", 0))))
        for seg in best[:6]:
            loc = locate(seg.get("text") or "", e["text"], None)
            if loc and _redact_range(seg, *loc, rid):
                break


def scrub(segs: list[dict], text: str) -> None:
    """Permanently remove every occurrence of `text` (used when erasing)."""
    pattern = _phrase_re(text)
    for seg in segs:
        for _ in range(50):
            t = seg.get("text") or ""
            m = next((m for m in pattern.finditer(t) if not _overlaps_token(t, m.start(), m.end())), None)
            if not m or not _redact_range(seg, m.start(), m.end(), "erased"):
                break
        finalize([seg], "erased")


def mute_filter(spans: list, pad: float = 0.25) -> Optional[str]:
    """ffmpeg -af expression silencing the given spans (merged, padded)."""
    if not spans:
        return None
    merged: list[list[float]] = []
    for a, b in sorted((max(0.0, a - pad), b + pad) for a, b in spans):
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    expr = "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in merged)
    return f"volume=enable='{expr}':volume=0"
