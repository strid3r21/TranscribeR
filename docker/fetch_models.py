"""Download speaker diarization models into /opt/models at image build time."""
import io
import sys
import tarfile
import urllib.request
from pathlib import Path

BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
out = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/models")
out.mkdir(parents=True, exist_ok=True)

seg = urllib.request.urlopen(f"{BASE}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2").read()
with tarfile.open(fileobj=io.BytesIO(seg), mode="r:bz2") as tf:
    member = tf.getmember("sherpa-onnx-pyannote-segmentation-3-0/model.onnx")
    (out / "segmentation.onnx").write_bytes(tf.extractfile(member).read())

urllib.request.urlretrieve(f"{BASE}/speaker-recongition-models/nemo_en_titanet_small.onnx", out / "embedding.onnx")
print("models:", sorted(p.name for p in out.iterdir()))

# Sound events (laughter, cough, sneeze, ...): CED-mini AudioSet tagger, int8 (~10 MB).
ced = urllib.request.urlopen(f"{BASE}/audio-tagging-models/sherpa-onnx-ced-mini-audio-tagging-2024-04-19.tar.bz2").read()
with tarfile.open(fileobj=io.BytesIO(ced), mode="r:bz2") as tf:
    root = "sherpa-onnx-ced-mini-audio-tagging-2024-04-19"
    (out / "sounds.onnx").write_bytes(tf.extractfile(tf.getmember(f"{root}/model.int8.onnx")).read())
    (out / "sounds_labels.csv").write_bytes(tf.extractfile(tf.getmember(f"{root}/class_labels_indices.csv")).read())
print("models:", sorted(p.name for p in out.iterdir()))
