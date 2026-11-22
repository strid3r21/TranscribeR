"""Assemble the CUDA build of transcribe.cpp for the built-in MOSS engine.

Downloads the official release tarball (sha256 checked) and copies in the CUDA runtime and
cuBLAS libraries from NVIDIA's pip wheels (already downloaded to WHEELS). libggml-cuda.so has
RUNPATH=$ORIGIN, so everything lives in one directory. libcuda.so.1 comes from the host driver
(Nvidia container runtime) at run time.

usage: python fetch_cuda.py DEST WHEELS
"""

import hashlib
import io
import shutil
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

VERSION = "0.4.2"
URL = (f"https://github.com/handy-computer/transcribe.cpp/releases/download/v{VERSION}/"
       f"transcribe-native-{VERSION}-linux-x86_64-cuda.tar.gz")
SHA256 = "5ed163385367b7f128502935cc00a995246c7a9cdfe5aaa233746093eed9a9d4"
KEEP_FROM_WHEELS = {"libcudart.so.12", "libcublas.so.12", "libcublasLt.so.12"}


def main() -> None:
    dest, wheels = Path(sys.argv[1]), Path(sys.argv[2])
    dest.mkdir(parents=True, exist_ok=True)
    data = urllib.request.urlopen(URL, timeout=600).read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != SHA256:
        sys.exit(f"checksum mismatch for {URL}: {digest}")
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for m in tar.getmembers():
            name = Path(m.name).name
            if m.isfile() and (name.endswith(".so") or name == "contract.json"):
                if name == "libggml-vulkan.so":
                    continue  # CUDA build: Vulkan is covered by the default package
                with tar.extractfile(m) as src, open(dest / name, "wb") as out:
                    shutil.copyfileobj(src, out)
    found = set()
    for whl in wheels.glob("*.whl"):
        with zipfile.ZipFile(whl) as z:
            for n in z.namelist():
                base = Path(n).name
                if base in KEEP_FROM_WHEELS:
                    with z.open(n) as src, open(dest / base, "wb") as out:
                        shutil.copyfileobj(src, out)
                    found.add(base)
    missing = KEEP_FROM_WHEELS - found
    if missing:
        sys.exit(f"missing from wheels: {sorted(missing)}")
    for p in sorted(dest.iterdir()):
        print(f"{p.stat().st_size / 1e6:8.1f} MB  {p.name}")


if __name__ == "__main__":
    main()
