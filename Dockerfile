FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini libvulkan1 libglvnd0 libegl1 libx11-6 libxext6 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Speaker diarization models (CPU, ~45 MB): pyannote segmentation 3.0 + NeMo TitaNet-small embeddings.
COPY docker/fetch_models.py /tmp/fetch_models.py
RUN python /tmp/fetch_models.py /opt/models && rm /tmp/fetch_models.py

COPY app/ /app/

# libvulkan1 lets the built-in MOSS engine use an Nvidia/AMD/Intel GPU when one is passed in
# (Unraid: --runtime=nvidia, NVIDIA_VISIBLE_DEVICES, NVIDIA_DRIVER_CAPABILITIES=all); otherwise it runs on CPU.
ENV DATA_DIR=/data \
    NVIDIA_DRIVER_CAPABILITIES=all \
    MODELS_DIR=/opt/models \
    PORT=8000 \
    PYTHONUNBUFFERED=1

VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD python -c "import urllib.request,os; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/api/health', timeout=4)" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
