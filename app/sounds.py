"""Non-speech sounds: laughter, coughs, sneezes, sighs, applause, music ...

A small AudioSet tagger (CED-mini via sherpa-onnx, CPU, ~0.5 s per minute of audio) scores 2-second
windows every second. Windows where a sound scores above its threshold are merged into events.
Each event is attributed to a speaker by voice (TitaNet embedding vs. each speaker's voice in this
file) when that is clear, otherwise to whoever is talking at that moment, flagged as a guess.
"""

from __future__ import annotations

import csv
import logging
import threading
from typing import Callable, Optional

import settings as cfg

log = logging.getLogger("transcriber.sounds")

MODEL = cfg.MODELS_DIR / "sounds.onnx"
LABELS = cfg.MODELS_DIR / "sounds_labels.csv"
SR = 16000
WIN, HOP = 2.0, 1.0

# display group -> (AudioSet labels, threshold, emoji)
GROUPS: dict[str, tuple[tuple[str, ...], float, str]] = {
    "Laughter": (("Laughter", "Giggle", "Snicker", "Belly laugh", "Chuckle, chortle", "Baby laughter"), 0.25, "😂"),
    "Cough": (("Cough",), 0.3, "😷"),
    "Sneeze": (("Sneeze",), 0.3, "🤧"),
    "Throat clearing": (("Throat clearing",), 0.35, "🗣️"),
    "Sigh": (("Sigh",), 0.35, "😮‍💨"),
    "Gasp": (("Gasp",), 0.35, "😲"),
    "Crying": (("Crying, sobbing",), 0.3, "😢"),
    "Applause": (("Applause", "Clapping"), 0.35, "👏"),
    "Singing": (("Singing", "Male singing", "Female singing", "Humming"), 0.4, "🎤"),
    "Music": (("Music",), 0.5, "🎵"),
    "Dog": (("Dog", "Bark"), 0.35, "🐶"),
    "Cat": (("Cat", "Meow"), 0.35, "🐱"),
}
PERSONAL = {"Laughter", "Cough", "Sneeze", "Throat clearing", "Sigh", "Gasp", "Crying", "Singing"}

_lock = threading.Lock()
_tagger = None


def available() -> bool:
    try:
        import sherpa_onnx  # noqa: F401
    except ImportError:
        return False
    return MODEL.exists() and LABELS.exists()


def _get():
    global _tagger
    with _lock:
        if _tagger is None:
            import sherpa_onnx as so

            n = sum(1 for _ in open(LABELS)) - 1
            _tagger = so.AudioTagging(so.AudioTaggingConfig(
                model=so.AudioTaggingModelConfig(ced=str(MODEL), num_threads=cfg.DIARIZE_THREADS, provider="cpu"),
                labels=str(LABELS), top_k=n))
        return _tagger


def _label_index() -> dict[str, str]:
    """AudioSet label -> group."""
    out = {}
    for group, (labels, _, _) in GROUPS.items():
        for lab in labels:
            out[lab] = group
    return out


def detect(samples, progress: Callable[[float], None]) -> list[dict]:
    """Returns events [{label, start, end, p}] sorted by time."""
    tagger = _get()
    to_group = _label_index()
    win, hop = int(WIN * SR), int(HOP * SR)
    hits: dict[str, list[tuple[float, float, float]]] = {g: [] for g in GROUPS}
    n = max(1, (len(samples) - win) // hop + 1)
    for k, a in enumerate(range(0, max(1, len(samples) - win + 1), hop)):
        st = tagger.create_stream()
        st.accept_waveform(SR, samples[a:a + win])
        best: dict[str, float] = {}
        for e in tagger.compute(st):
            g = to_group.get(e.name)
            if g:
                best[g] = max(best.get(g, 0.0), float(e.prob))
        for g, p in best.items():
            if p >= GROUPS[g][1]:
                t0 = a / SR
                hits[g].append((t0 + 0.25, t0 + WIN - 0.25, p))  # trim window edges a little
        if k % 50 == 0:
            progress(k / n)
    progress(1.0)
    events = []
    for g, spans in hits.items():
        cur: Optional[list] = None
        for s, e, p in spans:
            if cur and s <= cur[1] + 0.6:
                cur[1] = max(cur[1], e)
                cur[2] = max(cur[2], p)
            else:
                if cur:
                    events.append({"label": g, "start": round(cur[0], 2), "end": round(cur[1], 2), "p": round(cur[2], 3)})
                cur = [s, e, p]
        if cur:
            events.append({"label": g, "start": round(cur[0], 2), "end": round(cur[1], 2), "p": round(cur[2], 3)})
    events.sort(key=lambda e: e["start"])
    for i, e in enumerate(events):
        e["id"] = i
    return events


def attribute(events: list[dict], samples, segments: list[dict]) -> None:
    """Who laughed/coughed? Voice match when it's clear, else the person talking at that moment."""
    import numpy as np

    import diarize

    by: dict[str, list] = {}
    for s in segments:
        if s.get("speaker") and s["end"] - s["start"] >= 1.5:
            by.setdefault(s["speaker"], []).append(s)
    cents = {}
    for spk, segs in by.items():
        vecs = []
        for s in sorted(segs, key=lambda x: x["start"] - x["end"])[:12]:  # longest lines
            v = diarize.embed(samples, s["start"], s["end"])
            if v is not None:
                vecs.append(v)
        if vecs:
            m = np.mean(vecs, axis=0)
            cents[spk] = m / (np.linalg.norm(m) or 1.0)

    def talking(t0: float, t1: float) -> Optional[str]:
        best, ov = None, 0.0
        for s in segments:
            o = min(s["end"], t1) - max(s["start"], t0)
            if o > ov and s.get("speaker"):
                best, ov = s["speaker"], o
        if best:
            return best
        near = min(segments, key=lambda s: min(abs(s["start"] - t1), abs(s["end"] - t0)), default=None)
        return near.get("speaker") if near else None

    for e in events:
        e["speaker"], e["sure"] = None, False
        if e["label"] not in PERSONAL:
            continue
        guess = talking(e["start"], e["end"])
        if len(cents) >= 2 and e["end"] - e["start"] >= 0.8:
            v = diarize.embed(samples, e["start"], e["end"], min_len=0.8)
            if v is not None:
                sims = sorted(((float(v @ c), spk) for spk, c in cents.items()), reverse=True)
                if sims[0][0] - sims[1][0] >= 0.08 and sims[0][0] >= 0.3:
                    e["speaker"], e["sure"] = sims[0][1], True
                    continue
        e["speaker"] = guess
