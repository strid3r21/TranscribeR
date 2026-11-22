#!/usr/bin/env bash
# Build the image locally and publish it to GHCR in a format Unraid's update checker understands.
# Requires: docker, gh (logged in with the write:packages scope), python3.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=ghcr.io/strid3r21/transcriber
SHA=$(git rev-parse --short HEAD)

gh auth token | docker login ghcr.io -u strid3r21 --password-stdin >/dev/null
trap 'docker logout ghcr.io >/dev/null' EXIT

docker build --label org.opencontainers.image.source=https://github.com/strid3r21/TranscribeR \
  -t "$REPO:latest" -t "$REPO:$SHA" .
docker push -q "$REPO:$SHA"
python3 -I scripts/oci_to_v2s2.py strid3r21/transcriber "$SHA" latest "$SHA"
echo "Published $REPO:latest ($SHA)"
