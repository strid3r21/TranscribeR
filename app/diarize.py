"""Speaker diarization and identification with sherpa-onnx, CPU only.

* Diarization: pyannote segmentation 3.0 + NeMo TitaNet-small embeddings (who spoke when).
* Auto speaker count is cleaned up by merging clusters whose voices are the same
  and folding tiny clusters into their nearest neighbour.
* Identification: given a few user-tagged segments (or saved voice profiles), every
  segment is assigned to the closest voice by cosine similarity of its embedding.
"""

from __future__ import annotations

import logging
import subprocess
import threading
from pathlib import Path
from typing import Callable, Optional

import settings as cfg

log = logging.getLogger("transcriber.diarize")

SEGMENTATION = cfg.MODELS_DIR / "segmentation.onnx"
EMBEDDING = cfg.MODELS_DIR / "embedding.onnx"
SR = 16000

# Measured with TitaNet-small: same speaker ~0.7-0.85 (p5 ≈ 0.57 with noise), different ≈ 0.25 (p95 ≈ 0.32).
SAME_VOICE = 0.5
UNSURE_MARGIN = 0.08


def available() -> bool:
    try:
        import sherpa_onnx  # noqa: F401
    except ImportError:
        return False
    return SEGMENTATION.exists() and EMBEDDING.exists()


def parse_speakers(value) -> Optional[int]:
    """None = off, -1 = auto, n = fixed number of speakers."""
    if value is None or value == "":
        value = cfg.DIARIZATION
    v = str(value).strip().lower()
    if v in ("off", "0", "1", "false", "no", "none"):
        return None
    if v in ("auto", "true", "yes", "-1"):
        return -1
    try:
        return max(2, int(v))
    except ValueError:
        return -1


def load_samples(audio: Path):
    import numpy as np

    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(audio), "-ac", "1", "-ar", str(SR),
                          "-f", "s16le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


# --------------------------------------------------------------------------- #
# Embeddings
# --------------------------------------------------------------------------- #

_extractor = None
_extractor_lock = threading.Lock()


def _get_extractor():
    global _extractor
    import sherpa_onnx

    with _extractor_lock:
        if _extractor is None:
            _extractor = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(EMBEDDING), num_threads=cfg.DIARIZE_THREADS))
        return _extractor


def embed(samples, start: float, end: float, min_len: float = 1.0, max_len: float = 12.0):
    """Unit-length voice embedding for [start, end]; short spans are widened, long ones trimmed to the middle."""
    import numpy as np

    total = len(samples) / SR
    dur = end - start
    if dur < min_len:
        mid = (start + end) / 2
        start, end = max(0.0, mid - min_len / 2), min(total, mid + min_len / 2)
    elif dur > max_len:
        mid = (start + end) / 2
        start, end = mid - max_len / 2, mid + max_len / 2
    chunk = samples[int(start * SR): int(end * SR)]
    if len(chunk) < SR * 0.5:
        return None
    ex = _get_extractor()
    with _extractor_lock:
        stream = ex.create_stream()
        stream.accept_waveform(SR, chunk)
        stream.input_finished()
        vec = np.array(ex.compute(stream), dtype=np.float32)
    n = float(np.linalg.norm(vec))
    return vec / n if n else None


def _unit(v):
    import numpy as np

    n = float(np.linalg.norm(v))
    return v / n if n else v


# --------------------------------------------------------------------------- #
# Diarization
# --------------------------------------------------------------------------- #


def diarize(samples, num_speakers: int, progress: Callable[[float], None]) -> list[tuple[float, float, int]]:
    """Blocking. Returns (start, end, speaker_index) turns sorted by start."""
    import sherpa_onnx

    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(SEGMENTATION)),
            num_threads=cfg.DIARIZE_THREADS),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(EMBEDDING), num_threads=cfg.DIARIZE_THREADS),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_speakers, threshold=cfg.DIARIZE_THRESHOLD),
        min_duration_on=0.3, min_duration_off=0.5)
    if not config.validate():
        raise RuntimeError("Invalid diarization config (models missing?)")
    sd = sherpa_onnx.OfflineSpeakerDiarization(config)

    def cb(done: int, total: int) -> int:
        progress(0.85 * done / max(total, 1))
        return 0

    result = sd.process(samples, callback=cb).sort_by_start_time()
    turns = [(float(r.start), float(r.end), int(r.speaker)) for r in result]
    log.info("diarization found %d speakers in %d turns", len({t[2] for t in turns}), len(turns))
    if num_speakers == -1 and len({t[2] for t in turns}) > 1:
        turns = merge_clusters(samples, turns)
    progress(1.0)
    return turns


def cluster_centroids(samples, turns, per_cluster: int = 10) -> dict:
    """Average embedding of each cluster's longest turns -> {speaker: (unit vector, seconds)}."""
    import numpy as np

    by: dict[int, list] = {}
    for a, b, s in turns:
        by.setdefault(s, []).append((a, b))
    out = {}
    for spk, spans in by.items():
        total = sum(b - a for a, b in spans)
        vecs = []
        for a, b in sorted(spans, key=lambda x: x[0] - x[1])[:per_cluster]:
            if b - a >= 0.8 and (v := embed(samples, a, b)) is not None:
                vecs.append(v * (b - a))
        out[spk] = (_unit(np.sum(vecs, axis=0)) if vecs else None, total)
    return out


def merge_clusters(samples, turns, min_share: float = 0.02) -> list[tuple[float, float, int]]:
    """Merge clusters that are the same voice; fold clusters with < min_share of talk time into the nearest."""
    import numpy as np

    cents = cluster_centroids(samples, turns, per_cluster=6)
    groups = {s: {s} for s in cents}
    vec = {s: c for s, (c, _) in cents.items()}
    secs = {s: t for s, (_, t) in cents.items()}
    total = sum(secs.values()) or 1.0

    def merge(a: int, b: int) -> None:
        if vec[a] is not None and vec[b] is not None:
            vec[a] = _unit(vec[a] * secs[a] + vec[b] * secs[b])
        elif vec[a] is None:
            vec[a] = vec[b]
        secs[a] += secs[b]
        groups[a] |= groups.pop(b)
        vec.pop(b), secs.pop(b)

    while True:  # agglomerative merge of identical voices
        keys = [k for k in vec if vec[k] is not None]
        if len(keys) < 2:
            break
        m = np.array([vec[k] for k in keys])
        sim = m @ m.T
        np.fill_diagonal(sim, -1)
        i, j = np.unravel_index(int(np.argmax(sim)), sim.shape)
        if sim[i, j] < SAME_VOICE:
            break
        a, b = keys[i], keys[j]
        merge(a, b) if secs[a] >= secs[b] else merge(b, a)

    while len(vec) > 1:  # fold tiny / unembeddable clusters into their nearest voice
        small = min(vec, key=lambda k: secs[k])
        if secs[small] / total >= min_share and vec[small] is not None:
            break
        others = [k for k in vec if k != small and vec[k] is not None]
        if not others:
            break
        target = max(others, key=lambda k: float(vec[small] @ vec[k]) if vec[small] is not None else secs[k])
        merge(target, small)

    relabel = {}
    for new, (rep, members) in enumerate(sorted(groups.items(), key=lambda kv: -secs[kv[0]])):
        for m in members:
            relabel[m] = new
    log.info("auto speaker count: %d clusters merged into %d", len(cents), len(groups))
    return [(a, b, relabel[s]) for a, b, s in turns]


def match_voices(centroids: dict, voices: list[dict]) -> dict:
    """Greedy one-to-one match of cluster centroids to saved voice profiles -> {speaker: voice}."""
    import numpy as np

    pairs = []
    for spk, (c, _) in centroids.items():
        if c is None:
            continue
        for v in voices:
            pairs.append((float(c @ np.array(v["emb"], dtype=np.float32)), spk, v["id"]))
    out, used_s, used_v = {}, set(), set()
    by_id = {v["id"]: v for v in voices}
    for sim, spk, vid in sorted(pairs, reverse=True):
        if sim < SAME_VOICE:
            break
        if spk in used_s or vid in used_v:
            continue
        out[spk] = by_id[vid]
        used_s.add(spk)
        used_v.add(vid)
    return out


# --------------------------------------------------------------------------- #
# Identification from examples
# --------------------------------------------------------------------------- #


def segment_embeddings(samples, segs: list[dict], cache: dict, progress: Callable[[float], None]) -> list:
    out = []
    for i, s in enumerate(segs):
        key = f"{s['start']:.2f}-{s['end']:.2f}"
        if key not in cache:
            v = embed(samples, s["start"], s["end"])
            cache[key] = None if v is None else [round(float(x), 5) for x in v]
        out.append(cache[key])
        if i % 20 == 0:
            progress(i / max(1, len(segs)))
    progress(1.0)
    return out


def identify(segs: list[dict], embs: list, speakers: dict, voices: list[dict]) -> dict:
    """Assign every unlocked segment to the nearest speaker voice. Mutates segs; returns stats."""
    import numpy as np

    names = {sid: (info.get("name") or sid) for sid, info in speakers.items()}
    vecs: dict[str, list] = {sid: [] for sid in speakers}
    for s, e in zip(segs, embs):
        if s.get("spk_locked") and s.get("speaker") in vecs and e is not None:
            vecs[s["speaker"]].append(np.array(e) * max(0.5, min(s["end"] - s["start"], 10)))
    cents = {}
    for sid, vs in vecs.items():
        if vs:
            cents[sid] = _unit(np.sum(vs, axis=0))
        else:  # fall back to a saved voice with the same name
            v = next((v for v in voices if v["name"].strip().lower() == names[sid].strip().lower()), None)
            if v:
                cents[sid] = np.array(v["emb"], dtype=np.float32)
    missing = [names[s] for s in speakers if s not in cents]
    if len(cents) < 1 or missing:
        raise ValueError("Tag at least one clip for: " + ", ".join(missing or names.values()))

    ids = list(cents)
    m = np.array([cents[i] for i in ids])
    changed = unsure = 0
    for s, e in zip(segs, embs):
        s["issues"] = [x for x in (s.get("issues") or []) if not x.startswith("Not sure who")]
        if s.get("spk_locked") and s.get("speaker") in cents:
            s["spk_conf"] = 1.0
            continue
        if e is None:
            s["spk_conf"] = None
            continue
        sims = m @ np.array(e, dtype=np.float32)
        order = np.argsort(-sims)
        best = ids[order[0]]
        margin = float(sims[order[0]] - sims[order[1]]) if len(ids) > 1 else float(sims[order[0]])
        if s.get("speaker") != best:
            changed += 1
        s["speaker"] = best
        s["spk_conf"] = round(margin, 3)

    # Very short / unembeddable segments follow their neighbours.
    for i, s in enumerate(segs):
        if s.get("spk_conf") is None and not s.get("spk_locked"):
            prev = segs[i - 1]["speaker"] if i > 0 else None
            nxt = segs[i + 1]["speaker"] if i + 1 < len(segs) else None
            s["speaker"] = prev or nxt or s.get("speaker")
    for i, s in enumerate(segs):
        if s.get("spk_conf") is not None and s["spk_conf"] < UNSURE_MARGIN and not s.get("spk_locked"):
            prev = segs[i - 1]["speaker"] if i > 0 else None
            nxt = segs[i + 1]["speaker"] if i + 1 < len(segs) else None
            if prev and prev == nxt and (s["end"] - s["start"]) < 2.0:
                s["speaker"] = prev  # short ambiguous interjection inside a turn
            elif not s.get("reviewed"):
                s["issues"].append("Not sure who is speaking")
                unsure += 1
    return {"changed": changed, "unsure": unsure}


def voice_from_segments(segs: list[dict], embs: list, speaker: str, limit: int = 40):
    """Centroid of a speaker's segments (tagged ones first, then most confident), plus count used."""
    import numpy as np

    cands = [(s, e) for s, e in zip(segs, embs) if s.get("speaker") == speaker and e is not None]
    cands.sort(key=lambda se: (not se[0].get("spk_locked"), -(se[0].get("spk_conf") or 0), se[0]["start"] - se[0]["end"]))
    cands = cands[:limit]
    if not cands:
        return None, 0
    return _unit(np.sum([np.array(e) * max(0.5, min(s["end"] - s["start"], 10)) for s, e in cands], axis=0)), len(cands)
