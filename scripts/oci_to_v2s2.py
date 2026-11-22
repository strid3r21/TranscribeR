"""Re-tag a GHCR image's OCI manifest as a Docker v2 schema 2 manifest (same blobs, same layers).

Docker with the containerd image store pushes OCI manifests. Unraid's "check for updates"
only requests Docker v2 manifests and shows "not available" for OCI-only tags.

usage: oci_to_v2s2.py OWNER/REPO SOURCE_TAG TAG [TAG...]   (needs `gh` logged in with write:packages)
"""
import base64, json, subprocess, sys, urllib.request

repo, src, tags = sys.argv[1], sys.argv[2], sys.argv[3:]
gh = subprocess.check_output(["gh", "auth", "token"]).decode().strip()
basic = base64.b64encode(f"{repo.split('/')[0]}:{gh}".encode()).decode()
req = urllib.request.Request(f"https://ghcr.io/token?scope=repository:{repo}:pull,push&service=ghcr.io",
                             headers={"Authorization": f"Basic {basic}"})
token = json.load(urllib.request.urlopen(req))["token"]
H = {"Authorization": f"Bearer {token}"}

req = urllib.request.Request(f"https://ghcr.io/v2/{repo}/manifests/{src}",
                             headers={**H, "Accept": "application/vnd.oci.image.manifest.v1+json"})
m = json.load(urllib.request.urlopen(req))
assert m["mediaType"] == "application/vnd.oci.image.manifest.v1+json", m.get("mediaType")
LAYER = {"application/vnd.oci.image.layer.v1.tar+gzip": "application/vnd.docker.image.rootfs.diff.tar.gzip",
         "application/vnd.oci.image.layer.v1.tar": "application/vnd.docker.image.rootfs.diff.tar"}
out = {
    "schemaVersion": 2,
    "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
    "config": {"mediaType": "application/vnd.docker.container.image.v1+json",
               "size": m["config"]["size"], "digest": m["config"]["digest"]},
    "layers": [{"mediaType": LAYER.get(l["mediaType"], l["mediaType"]), "size": l["size"], "digest": l["digest"]} for l in m["layers"]],
}
body = json.dumps(out, indent=3).encode()
for tag in tags:
    req = urllib.request.Request(f"https://ghcr.io/v2/{repo}/manifests/{tag}", data=body, method="PUT",
                                 headers={**H, "Content-Type": out["mediaType"]})
    r = urllib.request.urlopen(req)
    print(tag, r.status, r.headers.get("Docker-Content-Digest"))
