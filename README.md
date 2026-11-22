# TranscribeR

A self-hosted web front end for speech-to-text models served through [llama-swap](https://github.com/mostlygeek/llama-swap). It's built to run as a Docker container on Unraid.

- **Upload anything ffmpeg can read** (drag and drop, multiple files, video too). Files that aren't already MP3 are converted to constant-bitrate MP3 so seeking in the browser lands on the right spot.
- **File library** with status, duration and rename/delete.
- **Synced transcript**: the current segment and word highlight as the audio plays, and you can click any timestamp (or Alt+click a word) to jump there.
- **Edit as you go**: click into any segment and type. *Pause while typing* stops playback while you type and resumes about 1 second earlier once you stop. Edits save automatically.
- **Uncertainty review**: segments with low model confidence, likely hallucinations (repeated text, implausibly fast speech, transcribed silence), and low-probability words are flagged. They show up in the review panel and as amber regions on the waveform. Jump between them with Alt+N / Alt+P and adjust the sensitivity slider live.
- **Export** as plain text, timestamped text, SRT, WebVTT or JSON.

## How it talks to llama-swap

TranscribeR calls the OpenAI-compatible `POST {LLAMA_SWAP_URL}/v1/audio/transcriptions` with `response_format=verbose_json` and word timestamps. llama-swap routes the request by the `model` field, so any model in your llama-swap config shows up in the model dropdown (from `/v1/models`). If a backend rejects those options, TranscribeR retries with simpler ones.

Example llama-swap entry for whisper.cpp:

```yaml
models:
  "whisper":
    checkEndpoint: /v1/audio/transcriptions/
    cmd: >
      /app/whisper-server
      --host 127.0.0.1 --port ${PORT}
      -m /models/ggml-large-v3-turbo-q8_0.bin
      --request-path /v1/audio/transcriptions --inference-path ""
```

Confidence flags work best when the backend returns per-word `probability` (whisper.cpp and faster-whisper do). Without it, TranscribeR falls back to `avg_logprob` per segment. If there's neither, you get a plain transcript with no flags.

## Install on Unraid

1. Copy `unraid/transcriber.xml` to `/boot/config/plugins/dockerMan/templates-user/` on your Unraid box.
2. **Docker → Add Container → Template:** pick *TranscribeR*.
3. Set **llama-swap URL** (e.g. `http://192.168.1.10:8080`) and **Default model** (the name from your llama-swap config).
4. Apply, then open the WebUI on port 8000.

The image is built by GitHub Actions and pushed to `ghcr.io/strid3r21/transcriber`. **The repo is private, so the image package is private too.** Pick one:

- **Make just the package public** (the code stays private): GitHub → your profile → Packages → `transcriber` → Package settings → Change visibility → Public.
- **Or keep it private** and log Unraid in to GHCR once, from the Unraid terminal:
  `echo <PAT with read:packages> | docker login ghcr.io -u strid3r21 --password-stdin`
- **Or build it on the server**: `git clone` the repo, then `docker build -t transcriber .` and use `transcriber` as the repository in the template.

## Docker Compose / plain Docker

```bash
docker run -d --name transcriber -p 8000:8000 \
  -v /mnt/user/appdata/transcriber:/data \
  -e LLAMA_SWAP_URL=http://192.168.1.10:8080 \
  -e DEFAULT_MODEL=whisper \
  ghcr.io/strid3r21/transcriber:latest
```

See `docker-compose.yml` for the same setup as a compose file.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LLAMA_SWAP_URL` | `http://localhost:8080` | llama-swap base URL (no `/v1`) |
| `DEFAULT_MODEL` | `whisper` | Model preselected in the UI and used by auto-transcribe |
| `LLAMA_SWAP_API_KEY` | – | Bearer token if llama-swap has `apiKeys` set |
| `DEFAULT_LANGUAGE` | auto | ISO language code |
| `AUTO_TRANSCRIBE` | `true` | Default state of the auto-transcribe toggle |
| `UPSTREAM_FORMAT` | `mp3` | Set to `wav` (16 kHz mono) if your backend can't decode MP3 |
| `REQUEST_TIMEOUT` | `3600` | Seconds to wait for one transcription |
| `UNCERTAINTY_THRESHOLD` | `0.70` | Default flag threshold (the UI slider overrides it per browser) |
| `WORD_THRESHOLD` | `0.45` | Words below this probability get underlined |
| `MP3_BITRATE` | `128k` | Bitrate for converted files |
| `MAX_UPLOAD_MB` | `4096` | Upload limit |
| `PORT` | `8000` | Port inside the container |

Data is stored as plain files in `/data/files/<id>/`: `audio.mp3`, `peaks.json`, `transcript.json` (your edits), `transcript.orig.json` (the original model output, used by "Revert edits") and `meta.json`. There's no database.

Jobs run one at a time so llama-swap isn't asked to swap models mid-job. Queued work resumes after a container restart.

> There is no authentication. Keep it on your LAN or put it behind your reverse proxy's auth.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Ctrl+Space (Space outside text) | Play / pause |
| Alt+, / Alt+. (← / → outside text) | Back / forward 5 s |
| Alt+N / Alt+P | Next / previous flagged segment |
| Alt+R | Mark the current segment reviewed (and jump to the next flag) |
| Enter (while editing) | Move to the next segment |
| Alt+click a word | Play from that word |

## Development

```bash
pip install -r requirements.txt
cd app && DATA_DIR=../data LLAMA_SWAP_URL=http://your-host:8080 uvicorn main:app --reload
```
