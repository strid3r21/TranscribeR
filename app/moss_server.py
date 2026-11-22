#!/usr/bin/env python3
"""Minimal OpenAI-compatible transcription server for MOSS-Transcribe-Diarize (transcribe.cpp).

llama-server can't run this model, so this lets llama-swap start/stop it like any other model:

    pip install transcribe-cpp numpy        # plus ffmpeg on PATH
    python3 moss_server.py --model MOSS-Transcribe-Diarize-Q8_0.gguf --port 9000

Endpoints
    GET  /health, /v1/models
    POST /v1/audio/transcriptions   multipart: file, model, language, prompt (hotwords, comma separated),
                                    response_format = json | verbose_json | text, diarize = true|false
         json         -> {"text": "[0.48][S01]Welcome everyone[1.66]..."}  (MOSS's raw turn format)
         verbose_json -> {"text", "language", "duration",
                          "segments": [{"id", "start", "end", "speaker": "S01", "text"}]}

Audio of any format ffmpeg can read is accepted. Memory grows ~85 MB per minute of audio; send
long recordings in chunks (TranscribeR does this automatically).
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import subprocess
import threading
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import transcribe_cpp as tc

log = logging.getLogger("moss_server")
STATE: dict = {}
LOCK = threading.Lock()


def decode(data: bytes) -> np.ndarray:
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
                       input=data, capture_output=True)
    if p.returncode != 0:
        raise ValueError("could not decode audio: " + p.stderr.decode(errors="ignore")[-300:])
    return np.frombuffer(p.stdout, dtype=np.float32)


def parse_form(ctype: str, body: bytes) -> dict:
    msg = BytesParser(policy=HTTP).parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + body)
    out = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name:
            payload = part.get_payload(decode=True) or b""
            out[name] = payload if name == "file" else payload.decode("utf-8", "ignore")
    return out


def transcribe(pcm: np.ndarray, form: dict) -> dict:
    model = STATE["model"]
    kw: dict = {"diarize": "off" if str(form.get("diarize", "true")).lower() in ("0", "false", "no", "off") else "on"}
    lang = (form.get("language") or "").strip().lower()[:2]
    if lang in ("en", "zh"):
        kw["language"] = lang
    words = [w.strip() for w in (form.get("prompt") or "").split(",") if w.strip()]
    if words and model.supports("vocabulary"):
        kw["vocabulary"] = words
    truncated = False
    with LOCK, model.session(n_threads=STATE["threads"]) as s:
        try:
            r = s.run(pcm, **kw)
        except tc.OutputTruncated as exc:
            r, truncated = exc.partial_result, True
    segs = [{"id": i, "start": sg.t0_ms / 1000, "end": sg.t1_ms / 1000,
             "speaker": f"S{sg.speaker_id:02d}" if sg.speaker_id > 0 else None,
             "text": re.sub(r"\s{2,}", " ", re.sub(r"\s*\[(?:\d+(?:\.\d+)?|S\d+)\]\s*", " ", sg.text)).strip()}
            for i, sg in enumerate(r.segments) if sg.text.strip()]
    return {"text": r.text, "raw_text": r.raw_text, "language": r.language or kw.get("language"),
            "duration": len(pcm) / 16000, "segments": segs, "truncated": truncated}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, body, ctype: str = "application/json") -> None:
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):  # noqa: N802
        log.info("%s %s", self.address_string(), fmt % args)

    def do_GET(self):  # noqa: N802
        if self.path.rstrip("/") in ("/health", ""):
            self._send(200, {"status": "ok", "backend": STATE["model"].backend})
        elif self.path.startswith("/v1/models"):
            self._send(200, {"object": "list", "data": [{"id": STATE["name"], "object": "model", "owned_by": "transcribe.cpp"}]})
        else:
            self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):  # noqa: N802
        if not self.path.startswith("/v1/audio/transcriptions"):
            return self._send(404, {"error": {"message": "not found"}})
        try:
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            form = parse_form(self.headers.get("Content-Type", ""), body)
            if not form.get("file"):
                return self._send(400, {"error": {"message": "missing file"}})
            res = transcribe(decode(form["file"]), form)
        except tc.OutOfMemory as exc:
            return self._send(507, {"error": {"message": f"out of memory, send shorter audio: {exc}", "type": "out_of_memory"}})
        except (ValueError, tc.InputTooLong, tc.InputTooShort) as exc:
            return self._send(400, {"error": {"message": str(exc)}})
        except Exception as exc:  # noqa: BLE001
            log.exception("transcription failed")
            return self._send(500, {"error": {"message": str(exc)}})
        fmt = (form.get("response_format") or "json").lower()
        if fmt == "text":
            return self._send(200, res["text"], "text/plain; charset=utf-8")
        if fmt == "verbose_json":
            return self._send(200, {"task": "transcribe", **res})
        return self._send(200, {"text": res["raw_text"] or res["text"]})


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", "-m", required=True, help="path to MOSS-Transcribe-Diarize-*.gguf")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=9000)
    ap.add_argument("--name", default="moss-transcribe-diarize", help="model id reported by /v1/models")
    ap.add_argument("--backend", default="auto", help="auto | vulkan | cpu")
    ap.add_argument("--threads", type=int, default=0)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    STATE.update(model=tc.Model(a.model, backend=a.backend), name=a.name, threads=a.threads)
    log.info("MOSS loaded on %s, listening on %s:%d", STATE["model"].backend, a.host, a.port)
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
