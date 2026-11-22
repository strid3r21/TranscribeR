"""Redaction of transcript text (and optionally the matching audio).

Redacted text is replaced by REDACTED everywhere it is stored: segment text, word timings and
low-confidence word lists. The original model output kept for "Revert edits" is scrubbed too, so
reverting can never bring redacted text back.
"""

from __future__ import annotations

import re
from typing import Optional

REDACTED = "[REDACTED]"
_LEAD = "\"'“‘([{"
_TRAIL = ".,!?;:…\"'”’)]}"


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


def locate(text: str, phrase: str, near: Optional[int]) -> Optional[tuple[int, int]]:
    """Find `phrase` in `text`, preferring the occurrence closest to the character offset `near`."""
    hits = [m.start() for m in re.finditer(re.escape(phrase), text)]
    if not hits:
        hits = [m.start() for m in re.finditer(re.escape(phrase), text, re.I)]
    if not hits:
        return None
    start = min(hits, key=lambda h: abs(h - (near or 0)))
    return start, start + len(phrase)


def _redact_range(seg: dict, a: int, b: int) -> Optional[tuple[float, float]]:
    """Replace text[a:b] with REDACTED. Returns the redacted time span (if word timings allow)."""
    text = seg.get("text") or ""
    if a >= b or text[a:b] == REDACTED:
        return None
    new_text = text[:a] + REDACTED + text[b:]
    words = seg.get("words") or []
    span = None
    joined = "".join(w.get("w", "") for w in words)
    if words and _norm(joined) == _norm(text) and joined.strip() == text.strip():
        lead = len(joined) - len(joined.lstrip())
        pos = -lead
        first = last = None
        bounds = []
        for i, w in enumerate(words):
            ws, we = pos, pos + len(w["w"])
            bounds.append((ws, we))
            if we > a and ws < b:
                first = i if first is None else first
                last = i
            pos = we
        if first is not None:
            # keep the parts of the first/last word outside the redaction (leading space, punctuation)
            prefix = words[first]["w"][: max(0, a - bounds[first][0])]
            suffix = words[last]["w"][max(0, b - bounds[last][0]):]
            piece = prefix + REDACTED + suffix
            s, e = words[first].get("s"), words[last].get("e")
            merged = {"w": piece, "s": s, "e": e, "p": None}
            if any(w.get("est") for w in words[first:last + 1]):
                merged["est"] = True
            seg["words"] = words[:first] + [merged] + words[last + 1:]
            if s is not None and e is not None:
                span = (float(s), float(e))
        if _norm("".join(w["w"] for w in seg["words"])) != _norm(new_text):
            seg["words"] = []
    else:
        seg["words"] = []
    seg["text"] = new_text
    removed = text[a:b].lower()
    seg["low_words"] = [x for x in (seg.get("low_words") or [])
                        if not (x.strip(_LEAD + _TRAIL).lower() and x.strip(_LEAD + _TRAIL).lower() in removed)]
    seg["redacted"] = int(seg.get("redacted") or 0) + 1
    if span is None:  # no usable word timing: fall back to the segment's span
        span = (float(seg["start"]), float(seg["end"]))
    return span


def redact_phrase(segs: list[dict], phrase: str, only: Optional[dict] = None,
                  near: Optional[int] = None) -> list[tuple[float, float]]:
    """Redact `phrase` in one segment (`only`, at the occurrence nearest `near`) or in all segments."""
    spans: list[tuple[float, float]] = []
    if only is not None:
        loc = locate(only.get("text") or "", phrase, near)
        if loc:
            a, b = expand(only["text"], *loc)
            if (sp := _redact_range(only, a, b)):
                spans.append(sp)
        return spans
    pattern = re.compile(r"(?<!\w)" + re.escape(phrase) + r"(?!\w)", re.I)
    for seg in segs:
        while True:
            m = next((m for m in pattern.finditer(seg.get("text") or "")), None)
            if not m:
                break
            a, b = expand(seg["text"], m.start(), m.end())
            if (sp := _redact_range(seg, a, b)) is None:
                break
            spans.append(sp)
    return spans


def count_matches(segs: list[dict], phrase: str) -> int:
    pattern = re.compile(r"(?<!\w)" + re.escape(phrase) + r"(?!\w)", re.I)
    return sum(len(pattern.findall(s.get("text") or "")) for s in segs)


def mute_filter(spans: list[tuple[float, float]], pad: float = 0.25) -> Optional[str]:
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
