"""Speaker diarization with sherpa-onnx (pyannote segmentation + NeMo TitaNet embeddings), CPU only."""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Callable, Optional

import settings as cfg

log = logging.getLogger("transcriber.diarize")

SEGMENTATION = cfg.MODELS_DIR / "segmentation.onnx"
EMBEDDING = cfg.MODELS_DIR / "embedding.onnx"


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


def diarize(audio: Path, num_speakers: int, progress: Callable[[float], None]) -> list[tuple[float, float, int]]:
    """Blocking. Returns (start, end, speaker_index) turns sorted by start."""
    import numpy as np
    import sherpa_onnx

    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(audio), "-ac", "1", "-ar", "16000",
                          "-f", "s16le", "-"], capture_output=True, check=True).stdout
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    del raw
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
        progress(done / max(total, 1))
        return 0

    result = sd.process(samples, callback=cb).sort_by_start_time()
    turns = [(float(r.start), float(r.end), int(r.speaker)) for r in result]
    log.info("diarization found %d speakers in %d turns", len({t[2] for t in turns}), len(turns))
    return turns
