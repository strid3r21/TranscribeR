# TranscribeR

A self-hosted web front end for speech-to-text models served through [llama-swap](https://github.com/mostlygeek/llama-swap). It's built to run as a Docker container on Unraid.

- **Upload anything ffmpeg can read** (drag and drop, multiple files, video too). Files that aren't already MP3 are converted to constant-bitrate MP3 so seeking in the browser lands on the right spot.
- **File library** with status and duration. Rename files, delete them one at a time or in bulk, or delete just the audio to free space while keeping the transcript.
- **Long files just work**: audio is split at natural pauses into ~30 s chunks, transcribed one after another and stitched back together, so a 90-minute recording never exceeds the model's context window. If a chunk is still too large, it is halved and retried automatically.
- **Follow along**: words light up karaoke-style as the audio plays (spoken words bright, the current word boxed). Click any timestamp, or Alt+click a word, to jump there.
- **Speaker detection** (diarization) runs on the CPU inside the container alongside transcription. Rename speakers, reassign a line or a whole turn, add speakers, and re-run detection without losing your text edits.
- **Edit as you go**: click into any segment and type. *Pause while typing* stops playback while you type and resumes about 1 second earlier once you stop. Edits save automatically.
- **Uncertainty review**: segments with low model confidence, likely hallucinations (repeated text, implausibly fast speech, transcribed silence), and low-probability words are flagged. They show up in the review panel and as amber regions on the waveform. Jump between them with Alt+N / Alt+P and adjust the sensitivity slider live.
- **Redaction**: select text and a floating bar offers *Redact*, *Everywhere* (every occurrence in the file) and *+ Mute audio*. It's also on right-click, and Alt+X redacts the selection. Exports always show `[REDACTED]`. **Click a redaction bar to unredact it** (text and any muted audio come back; the confirmation offers *Redact again*). Right-click a bar to **Erase permanently**. Grey bars are permanent redactions; clicking one offers **Recover from audio**, which re-transcribes the audio around it and fills in just the missing words (unless that audio was muted). Until erased, the original text is kept only in the file's `redactions.json` (and muted audio in an untouched `audio.original.mp3` backup), never in the transcript or exports. Before sharing sensitive material, use ⋯ → **Erase all redactions permanently**: this destroys the hidden originals, scrubs the copy used by *Revert edits*, and writes the silence into the backup audio.
- **Markers and sections** on the timeline: *+ Marker* or Alt+M adds a point at the playhead, and Shift+drag on the waveform marks a section. Labels show on the waveform and as dividers in the transcript. Drag markers to adjust them. Export them as *Chapters* (`00:12:30 Label`, handy for show notes); they also appear as headings in the text exports.
- **Split and merge segments** (Alt+S at the cursor, Backspace at the start of a line) to fix boundaries.
- **Export** as plain text, timestamped text, SRT, WebVTT or JSON, with speaker names included.

## How it talks to llama-swap

Any model in your llama-swap config shows up in the model dropdown (from `/v1/models`). llama-swap routes each request by its `model` field. TranscribeR picks the API per model:

- **Audio LLMs on llama-server** (for example NVIDIA Nemotron Transcribe, where `/v1/models` lists `audio` in `input_modalities`) are called through `/v1/chat/completions` with the chunk as `input_audio` and `logprobs: true`. This returns per-token probabilities, which become per-word confidence and drive the uncertainty flags. These models don't return timestamps, so word times are estimated: each chunk's words are aligned to the speech between pauses, and to speaker changes when speaker detection is on. Sentence boundaries usually land within a few tenths of a second.
- **Everything else** (whisper.cpp, faster-whisper, …) gets `POST /v1/audio/transcriptions` with `response_format=verbose_json` and word timestamps, falling back to plain `json` if the backend rejects that.

Set `TRANSCRIBE_API=transcriptions` or `chat` to force one or the other.

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

Confidence flags need per-word or per-token probabilities. Chat mode and whisper.cpp/faster-whisper provide them; with only `avg_logprob`, TranscribeR uses that per segment. A model that returns plain text through `/v1/audio/transcriptions` gives you a transcript without confidence flags. Repetition and hallucination checks still apply.

### Speaker detection

Diarization uses [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) with the pyannote segmentation 3.0 model and NeMo TitaNet-small speaker embeddings (about 45 MB, baked into the image). It runs on the CPU at roughly 15× real time with 4 threads, so a 90-minute file takes about 6 minutes and runs at the same time as GPU transcription. Choose *Auto* or a fixed speaker count in the top bar. A fixed count is more reliable when you know it (for example 2 for an interview). In *Auto*, clusters with the same voice are merged and tiny clusters are folded into the nearest voice, so noisy recordings don't explode into dozens of speakers.

**Teach it who's who.** Click **Teach** in the Speakers panel, name the people in the file, play a few short clips and tag who's talking (2–3 per person is usually plenty). TranscribeR compares every line's voice fingerprint (TitaNet embedding) to your examples and relabels the whole file. Any line you later fix with the speaker menu counts as another example. Click **Update all from my corrections** to re-run. Lines where it can't tell are added to *Needs review*.

**Remembered voices.** With *Remember these voices* on, each person's voice is saved to `/data/voices.json`. Future files are labeled with their names automatically, and a remembered person needs no tagged clips in Teach.

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
| `CHUNK_SECONDS` | `30` | Target chunk length; cuts land on the nearest pause. `0` sends the whole file |
| `CHUNK_CONCURRENCY` | `1` | Chunks in flight at once (raise only if llama-server runs with `--parallel`) |
| `TRANSCRIBE_API` | `auto` | `auto`, `chat` or `transcriptions` |
| `CHAT_PROMPT` | `Transcribe the speech in this audio verbatim. Output only the transcript text.` | Instruction sent with each chunk in chat mode. Without one, some audio LLMs describe the audio instead of transcribing it |
| `DIARIZATION` | `auto` | Default for the Speakers selector: `off`, `auto` or a number |
| `DIARIZE_THREADS` | `4` | CPU threads for speaker detection |
| `DIARIZE_THRESHOLD` | `0.7` | Clustering threshold in *Auto* mode (higher = fewer speakers) |
| `REQUEST_TIMEOUT` | `1800` | Seconds to wait for one chunk |
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
| Alt+S (while editing) | Split the segment at the cursor |
| Backspace at the start of a segment | Merge it into the previous one |
| Alt+click a word | Play from that word |

## Development

```bash
pip install -r requirements.txt
cd app && DATA_DIR=../data LLAMA_SWAP_URL=http://your-host:8080 uvicorn main:app --reload
```

## Publishing the image

GitHub Actions builds the image when it can (`.github/workflows/docker.yml`). To publish from a workstation instead, run:

```bash
scripts/publish.sh
```

It builds, pushes `ghcr.io/strid3r21/transcriber:<sha>`, and rewrites the manifest as Docker v2 schema 2 for both `latest` and the sha tag. Docker's containerd image store pushes OCI manifests, and Unraid's *Check for updates* can't read them (it shows "not available").
