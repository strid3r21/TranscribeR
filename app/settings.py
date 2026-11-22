"""Configuration from environment variables."""

import os
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
FILES_DIR = DATA_DIR / "files"
MODELS_DIR = Path(os.getenv("MODELS_DIR", "/opt/models"))

LLAMA_SWAP_URL = os.getenv("LLAMA_SWAP_URL", "http://localhost:8080").rstrip("/")
LLAMA_SWAP_API_KEY = os.getenv("LLAMA_SWAP_API_KEY", "")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "whisper")
DEFAULT_LANGUAGE = os.getenv("DEFAULT_LANGUAGE", "")  # empty = auto detect

# auto | transcriptions | chat. "auto" uses chat completions (which returns per-token
# probabilities) for audio-capable llama-server models, otherwise /v1/audio/transcriptions.
TRANSCRIBE_API = os.getenv("TRANSCRIBE_API", "auto").lower()
CHAT_PROMPT = os.getenv("CHAT_PROMPT", "Transcribe the speech in this audio verbatim. Output only the transcript text.")
UPSTREAM_FORMAT = os.getenv("UPSTREAM_FORMAT", "mp3").lower()  # mp3 | wav
REQUEST_TIMEOUT = float(os.getenv("REQUEST_TIMEOUT", "1800"))
CHUNK_SECONDS = float(os.getenv("CHUNK_SECONDS", "30"))  # 0 = send the whole file at once
CHUNK_CONCURRENCY = max(1, int(os.getenv("CHUNK_CONCURRENCY", "1")))

DIARIZATION = os.getenv("DIARIZATION", "auto").lower()  # off | auto | <number of speakers>
DIARIZE_THRESHOLD = float(os.getenv("DIARIZE_THRESHOLD", "0.7"))
DIARIZE_THREADS = int(os.getenv("DIARIZE_THREADS", "4"))

UNCERTAINTY_THRESHOLD = float(os.getenv("UNCERTAINTY_THRESHOLD", "0.70"))
WORD_THRESHOLD = float(os.getenv("WORD_THRESHOLD", "0.45"))
MP3_BITRATE = os.getenv("MP3_BITRATE", "128k")
AUTO_TRANSCRIBE = _bool("AUTO_TRANSCRIBE", True)
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "4096"))

# Built-in MOSS-Transcribe-Diarize engine (transcribe.cpp). The model downloads to /data/models on first use.
LOCAL_MOSS = _bool("LOCAL_MOSS", True)
MOSS_QUANT = os.getenv("MOSS_QUANT", "Q8_0")  # Q8_0 | Q6_K | Q5_K_M | Q4_K_M | F16
MOSS_MODEL_PATH = os.getenv("MOSS_MODEL_PATH", "")
MOSS_MODEL_URL = os.getenv("MOSS_MODEL_URL", "")
MOSS_BACKEND = os.getenv("MOSS_BACKEND", "auto").lower()  # auto | vulkan | cpu
MOSS_THREADS = int(os.getenv("MOSS_THREADS", "0"))  # 0 = all cores
MOSS_CHUNK_SECONDS = float(os.getenv("MOSS_CHUNK_SECONDS", "600"))
MOSS_REMOTE_MATCH = os.getenv("MOSS_REMOTE_MATCH", "moss")  # llama-swap model names treated as MOSS (regex)
MOSS_REMOTE_CHUNK_SECONDS = float(os.getenv("MOSS_REMOTE_CHUNK_SECONDS", "600"))
