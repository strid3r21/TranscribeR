"""Model benchmarks: accuracy of different models against a reference transcript.

A benchmark is one recording plus a reference ("ground truth") transcript, taken from a reviewed
transcript in the library or uploaded/pasted. Each run transcribes the recording with one model
and is scored:

* WER  = (substitutions + deletions + insertions) / reference words, after normalising case and
  punctuation. Redacted parts of the reference match whatever the model heard there.
* CER  = the same on characters (useful for names and spelling).
* Speaker accuracy = share of aligned words attributed to the right person, after mapping the
  model's speaker labels to the reference's one-to-one (only when the reference has speakers).
* Speed = processing time / audio length (real-time factor).
"""

from __future__ import annotations

import itertools
import json
import re
import shutil
import time
import uuid
from difflib import SequenceMatcher
from pathlib import Path
from typing import Optional

import settings as cfg

BENCH_DIR = cfg.DATA_DIR / "bench"
REDACTED = "\x00r"  # placeholder token for redacted reference words
_TOKEN_RE = re.compile(r"\[REDACTED(?::[a-z0-9]+)?\]")
_SPEAKER_LINE = re.compile(r"^\s*(?:\[[^\]]*\]\s*)?([A-Z][\w .'-]{0,40}?)\s*:\s+(.+)$")
_TIMING_LINE = re.compile(r"^\s*(\d+|WEBVTT.*|NOTE.*|[\d:.,]+\s*-->\s*[\d:.,]+.*)\s*$")


# --------------------------------------------------------------------------- text


def normalize(text: str) -> list[str]:
    text = _TOKEN_RE.sub(f" {REDACTED} ", text)
    text = text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').lower()
    text = re.sub(r"[‐-―-]", " ", text)
    out = []
    for tok in text.split():
        if tok == REDACTED:
            out.append(tok)
            continue
        tok = re.sub(r"[^\w']", "", tok).strip("'")
        if tok:
            out.append(tok)
    return out


def reference_from_text(raw: str) -> dict:
    """Plain text, 'Name: text' lines, or SRT/VTT. Returns {words, speakers|None, text}."""
    words: list[str] = []
    spk: list[Optional[str]] = []
    plain: list[str] = []
    any_speaker = False
    for line in raw.splitlines():
        if not line.strip() or _TIMING_LINE.match(line):
            continue
        line = re.sub(r"</?v[^>]*>", " ", line)
        who = None
        m = _SPEAKER_LINE.match(line)
        if m:
            who, line = m.group(1).strip(), m.group(2)
            any_speaker = True
        toks = normalize(line)
        words += toks
        spk += [who] * len(toks)
        plain.append(line.strip())
    return {"words": words, "speakers": spk if any_speaker else None, "text": "\n".join(plain)}


def reference_from_transcript(t: dict) -> dict:
    names = {k: (v.get("name") or k) for k, v in (t.get("speakers") or {}).items()}
    words: list[str] = []
    spk: list[Optional[str]] = []
    lines = []
    for s in t.get("segments") or []:
        toks = normalize(s.get("text") or "")
        who = names.get(s.get("speaker") or "") if s.get("speaker") else None
        words += toks
        spk += [who] * len(toks)
        lines.append((f"{who}: " if who else "") + _TOKEN_RE.sub("[REDACTED]", s.get("text") or ""))
    has = any(spk)
    return {"words": words, "speakers": spk if has else None, "text": "\n".join(lines)}


def hypothesis_from_segments(segments: list[dict], speakers: dict) -> tuple[list[str], list[Optional[str]]]:
    words: list[str] = []
    spk: list[Optional[str]] = []
    for s in segments:
        toks = normalize(_TOKEN_RE.sub(" ", s.get("text") or ""))
        words += toks
        spk += [s.get("speaker")] * len(toks)
    return words, spk


# --------------------------------------------------------------------------- alignment


def _lev(ref: list[str], hyp: list[str]) -> list[tuple[str, Optional[int], Optional[int]]]:
    n, m = len(ref), len(hyp)
    if n * m > 4_000_000:  # too big for exact DP: pair up, then delete/insert the rest
        k = min(n, m)
        return ([("sub" if ref[i] != hyp[i] else "eq", i, i) for i in range(k)]
                + [("del", i, None) for i in range(k, n)] + [("ins", None, j) for j in range(k, m)])
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        d[i][0] = i
    for j in range(m + 1):
        d[0][j] = j
    for i in range(1, n + 1):
        ri = ref[i - 1]
        row, prev = d[i], d[i - 1]
        for j in range(1, m + 1):
            row[j] = min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (0 if ri == hyp[j - 1] or ri == REDACTED else 1))
    ops = []
    i, j = n, m
    while i or j:
        if i and j and d[i][j] == d[i - 1][j - 1] + (0 if ref[i - 1] == hyp[j - 1] or ref[i - 1] == REDACTED else 1):
            ops.append(("eq" if ref[i - 1] == hyp[j - 1] else "sub", i - 1, j - 1))
            i, j = i - 1, j - 1
        elif i and d[i][j] == d[i - 1][j] + 1:
            ops.append(("del", i - 1, None))
            i -= 1
        else:
            ops.append(("ins", None, j - 1))
            j -= 1
    return ops[::-1]


def align(ref: list[str], hyp: list[str]) -> list[tuple[str, Optional[int], Optional[int]]]:
    """Word alignment: difflib anchors on long exact matches, Levenshtein fills the gaps."""
    ops: list = []
    for tag, i1, i2, j1, j2 in SequenceMatcher(None, ref, hyp, autojunk=False).get_opcodes():
        if tag == "equal":
            ops += [("eq", i1 + k, j1 + k) for k in range(i2 - i1)]
        elif tag == "delete":
            ops += [("del", i, None) for i in range(i1, i2)]
        elif tag == "insert":
            ops += [("ins", None, j) for j in range(j1, j2)]
        else:
            ops += [(op, (i + i1) if i is not None else None, (j + j1) if j is not None else None)
                    for op, i, j in _lev(ref[i1:i2], hyp[j1:j2])]
    return ops


def _absorb_redactions(ops: list, ref: list[str]) -> list:
    """A redacted reference word matches any run of model words: those aren't errors."""
    out = []
    for k, (op, i, j) in enumerate(ops):
        if i is not None and ref[i] == REDACTED:
            out.append(("red", i, j))
            continue
        if op == "ins":
            # insertion next to a redaction (before or after) belongs to it
            prev = next((o for o in reversed(out) if o[0] != "ins"), None)
            nxt = next((o for o in ops[k + 1:] if o[0] != "ins"), None)
            if (prev and prev[0] == "red") or (nxt and nxt[1] is not None and ref[nxt[1]] == REDACTED):
                out.append(("red", None, j))
                continue
        out.append((op, i, j))
    return out


def _cer(ref: list[str], hyp: list[str]) -> Optional[float]:
    r = " ".join(w for w in ref if w != REDACTED)
    h = " ".join(hyp)
    if not r:
        return None
    if len(r) * len(h) > 25_000_000:  # long files: estimate from difflib blocks
        sm = SequenceMatcher(None, r, h, autojunk=False)
        same = sum(b.size for b in sm.get_matching_blocks())
        return round((max(len(r), len(h)) - same) / len(r), 4)
    prev = list(range(len(h) + 1))
    for a in r:
        cur = [prev[0] + 1]
        for jj, b in enumerate(h, 1):
            cur.append(min(prev[jj] + 1, cur[-1] + 1, prev[jj - 1] + (a != b)))
        prev = cur
    return round(prev[-1] / len(r), 4)


def _speaker_accuracy(pairs: list[tuple[str, str]]) -> Optional[dict]:
    if not pairs:
        return None
    counts: dict[tuple[str, str], int] = {}
    for p in pairs:
        counts[p] = counts.get(p, 0) + 1
    refs = sorted({r for r, _ in pairs})
    hyps = sorted({h for _, h in pairs})
    best, best_map = -1, {}
    if len(refs) <= 7 and len(hyps) <= 8:
        small, large, flip = (refs, hyps, False) if len(refs) <= len(hyps) else (hyps, refs, True)
        for perm in itertools.permutations(large, len(small)):
            mapping = {(a if flip else b): (b if flip else a) for a, b in zip(small, perm)}  # hyp -> ref
            score = sum(c for (r, h), c in counts.items() if mapping.get(h) == r)
            if score > best:
                best, best_map = score, mapping
    else:  # greedy for unusual speaker counts
        used_r, used_h = set(), set()
        best = 0
        for (r, h), c in sorted(counts.items(), key=lambda kv: -kv[1]):
            if r not in used_r and h not in used_h:
                best_map[h] = r
                used_r.add(r)
                used_h.add(h)
                best += c
    return {"accuracy": round(best / len(pairs), 4), "mapping": best_map, "ref_speakers": len(refs),
            "hyp_speakers": len(hyps), "words": len(pairs)}


def score(reference: dict, hyp_words: list[str], hyp_spk: list[Optional[str]]) -> tuple[dict, list]:
    ref = reference["words"]
    ops = _absorb_redactions(align(ref, hyp_words), ref)
    subs = sum(1 for o in ops if o[0] == "sub")
    dels = sum(1 for o in ops if o[0] == "del")
    ins = sum(1 for o in ops if o[0] == "ins")
    n = sum(1 for w in ref if w != REDACTED)
    pairs = []
    if reference.get("speakers"):
        rs = reference["speakers"]
        pairs = [(rs[i], hyp_spk[j]) for op, i, j in ops
                 if op in ("eq", "sub") and i is not None and j is not None and rs[i] and hyp_spk[j]]
    metrics = {
        "ref_words": n, "hyp_words": len(hyp_words), "sub": subs, "del": dels, "ins": ins,
        "wer": round((subs + dels + ins) / n, 4) if n else None,
        "cer": _cer(ref, hyp_words),
        "speakers": _speaker_accuracy(pairs),
        "redacted_words": sum(1 for w in ref if w == REDACTED),
    }
    # compact diff for display: runs of [op, ref text, hyp text]
    diff: list[list] = []
    for op, i, j in ops:
        r = "" if i is None else ("[redacted]" if ref[i] == REDACTED else ref[i])
        h = hyp_words[j] if j is not None else ""
        if diff and diff[-1][0] == op and op != "sub":
            diff[-1][1] = (diff[-1][1] + " " + r).strip()
            diff[-1][2] = (diff[-1][2] + " " + h).strip()
        else:
            diff.append([op, r, h])
    return metrics, diff


# --------------------------------------------------------------------------- storage


def bdir(bid: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{12}", bid or ""):
        raise KeyError(bid)
    return BENCH_DIR / bid


def load(bid: str) -> Optional[dict]:
    try:
        return json.loads((bdir(bid) / "bench.json").read_text())
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return None


def save(b: dict) -> None:
    d = bdir(b["id"])
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "bench.json.tmp"
    tmp.write_text(json.dumps(b, ensure_ascii=False))
    tmp.replace(d / "bench.json")


def all_benches() -> list[dict]:
    out = []
    for p in BENCH_DIR.glob("*/bench.json") if BENCH_DIR.exists() else []:
        try:
            out.append(json.loads(p.read_text()))
        except json.JSONDecodeError:
            pass
    return sorted(out, key=lambda b: b.get("created", 0), reverse=True)


def create(name: str, owner: str, audio_src: Path, duration: float, reference: dict, source: Optional[dict]) -> dict:
    bid = uuid.uuid4().hex[:12]
    d = BENCH_DIR / bid
    d.mkdir(parents=True)
    shutil.copyfile(audio_src, d / "audio.mp3")
    b = {"id": bid, "name": name.strip()[:120] or "Benchmark", "owner": owner, "created": time.time(),
         "duration": duration, "source": source, "runs": [],
         "reference": {"words": reference["words"], "speakers": reference["speakers"],
                       "word_count": sum(1 for w in reference["words"] if w != REDACTED),
                       "speaker_names": sorted({s for s in reference["speakers"] or [] if s}),
                       "text": reference["text"][:200_000]}}
    save(b)
    return b


def summary(b: dict) -> dict:
    ref = b.get("reference") or {}
    return {k: b.get(k) for k in ("id", "name", "created", "duration", "source")} | {
        "ref_words": ref.get("word_count"), "ref_speakers": ref.get("speaker_names") or [],
        "runs": [{k: r.get(k) for k in ("id", "model", "options", "status", "error", "created", "finished",
                                         "seconds", "rtf", "metrics", "device", "progress")} for r in b.get("runs", [])]}
