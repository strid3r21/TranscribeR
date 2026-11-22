/* TranscribeR front end — no build step, no dependencies. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem("tr." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("tr." + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const S = {
    config: null,
    files: [],
    uploads: new Map(), // temp id -> {name, progress}
    current: null,      // file meta
    transcript: null,
    segs: [],
    activeIdx: -1,
    flagged: [],
    flagCursor: -1,
    threshold: 0.7,
    wordThreshold: 0.45,
    peaks: [],
    saveTimer: null,
    saving: false,
    pendingSave: false,
    typingTimer: null,
    resumeAfterTyping: false,
    search: "",
    lastWordEl: null,
  };

  const audio = $("audio");
  const canvas = $("wave");
  const ctx = canvas.getContext("2d");

  // ------------------------------------------------------------------ utils
  function fmt(sec, ms = false) {
    if (!isFinite(sec)) sec = 0;
    sec = Math.max(0, sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    const base = (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
    return ms ? base + "." + String(Math.floor((sec % 1) * 10)) : base;
  }
  function fmtSize(b) {
    if (!b) return "";
    const u = ["B", "KB", "MB", "GB"]; let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return b.toFixed(i ? 1 : 0) + " " + u[i];
  }
  let toastTimer;
  function toast(msg, isError = false) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = "toast"), isError ? 6000 : 2600);
  }
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { const j = await res.json(); msg = j.detail || msg; } catch { /* ignore */ }
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return res.status === 204 ? null : res.json();
  }
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  // ------------------------------------------------------------------ config
  async function loadConfig() {
    const status = $("backendStatus");
    try {
      const c = await api("/api/config");
      S.config = c;
      S.threshold = store.get("threshold", c.uncertainty_threshold);
      S.wordThreshold = c.word_threshold;
      const sel = $("modelSelect");
      const saved = store.get("model", c.default_model);
      const models = c.models.length ? c.models : [c.default_model];
      if (!models.includes(saved) && saved) models.unshift(saved);
      sel.innerHTML = "";
      for (const m of models) sel.append(new Option(m, m, false, m === saved));
      $("languageInput").value = store.get("language", c.default_language || "");
      $("autoToggle").checked = store.get("auto", c.auto_transcribe);
      $("threshold").value = S.threshold;
      $("thresholdVal").textContent = Math.round(S.threshold * 100) + "%";
      if (c.backend_error) {
        status.className = "backend err";
        status.querySelector(".label").textContent = "llama-swap unreachable";
        status.title = c.backend_error;
      } else {
        status.className = "backend ok";
        status.querySelector(".label").textContent = `llama-swap · ${c.models.length} models`;
        status.title = c.backend;
      }
    } catch (e) {
      status.className = "backend err";
      status.querySelector(".label").textContent = "Server error";
      status.title = e.message;
    }
  }

  $("modelSelect").onchange = (e) => store.set("model", e.target.value);
  $("languageInput").onchange = (e) => store.set("language", e.target.value.trim());
  $("autoToggle").onchange = (e) => store.set("auto", e.target.checked);
  $("backendStatus").onclick = loadConfig;

  function transcribeOpts() {
    const o = { model: $("modelSelect").value || undefined };
    const lang = $("languageInput").value.trim();
    if (lang) o.language = lang;
    return o;
  }

  // ------------------------------------------------------------------ files
  const STATUS_LABEL = { processing: "Converting", ready: "Ready", queued: "Queued", transcribing: "Transcribing", done: "Transcribed", error: "Error" };
  const isBusy = (f) => ["processing", "queued", "transcribing"].includes(f.status);

  async function loadFiles() {
    try {
      S.files = await api("/api/files");
    } catch (e) { return; }
    renderFiles();
    if (S.current) {
      const f = S.files.find((x) => x.id === S.current.id);
      if (!f) { closeFile(); return; }
      const prevStatus = S.current.status;
      S.current = f;
      renderHeader();
      if (prevStatus !== f.status && !S.segs.length) renderSegments();
      if (prevStatus !== "done" && f.status === "done") {
        await loadTranscript();
        toast("Transcription finished");
      }
      if (prevStatus === "processing" && f.status !== "processing" && f.status !== "error") loadAudio();
    }
  }

  function fileIcon() {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.innerHTML = '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>';
    return s;
  }

  function renderFiles() {
    const list = $("fileList");
    list.innerHTML = "";
    for (const [tid, u] of S.uploads) {
      const li = el("li", "file");
      const ic = el("div", "ficon"); ic.append(fileIcon());
      const body = el("div");
      body.append(el("div", "fname", u.name));
      const sub = el("div", "fsub");
      const p = el("span", "pill busy", u.progress < 1 ? `Uploading ${Math.round(u.progress * 100)}%` : "Finishing upload");
      sub.append(p);
      body.append(sub);
      const bar = el("div", "progress"); bar.style.width = u.progress * 100 + "%";
      li.append(ic, body, bar);
      li.dataset.tid = tid;
      list.append(li);
    }
    for (const f of S.files) {
      const li = el("li", "file" + (S.current && S.current.id === f.id ? " active" : ""));
      const ic = el("div", "ficon"); ic.append(fileIcon());
      const body = el("div");
      body.append(el("div", "fname", f.name));
      body.title = f.name;
      const sub = el("div", "fsub");
      let label = STATUS_LABEL[f.status] || f.status;
      if (f.status === "transcribing" && f.elapsed != null) label += " " + fmt(f.elapsed);
      const cls = f.status === "done" ? "done" : f.status === "error" ? "error" : isBusy(f) ? "busy" : "";
      sub.append(el("span", "pill " + cls, label));
      if (f.duration) sub.append(el("span", null, fmt(f.duration)));
      if (f.converted) sub.append(el("span", null, "→ mp3"));
      body.append(sub);
      li.append(ic, body);
      li.onclick = () => openFile(f.id);
      list.append(li);
    }
    $("fileCount").textContent = S.files.length ? S.files.length : "";
  }

  // ---- upload
  function uploadFile(file) {
    const tid = Math.random().toString(36).slice(2);
    S.uploads.set(tid, { name: file.name, progress: 0 });
    renderFiles();
    const fd = new FormData();
    fd.append("file", file);
    const o = transcribeOpts();
    if (o.model) fd.append("model", o.model);
    if (o.language) fd.append("language", o.language);
    fd.append("auto", $("autoToggle").checked ? "true" : "false");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files");
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      S.uploads.get(tid).progress = e.loaded / e.total;
      const li = document.querySelector(`[data-tid="${tid}"]`);
      if (li) {
        li.querySelector(".progress").style.width = (e.loaded / e.total) * 100 + "%";
        li.querySelector(".pill").textContent = e.loaded < e.total ? `Uploading ${Math.round((e.loaded / e.total) * 100)}%` : "Finishing upload";
      }
    };
    xhr.onload = async () => {
      S.uploads.delete(tid);
      if (xhr.status >= 200 && xhr.status < 300) {
        const meta = JSON.parse(xhr.responseText);
        await loadFiles();
        if (!S.current) openFile(meta.id);
      } else {
        let msg = xhr.statusText;
        try { msg = JSON.parse(xhr.responseText).detail; } catch { /* ignore */ }
        toast(`Upload failed: ${msg}`, true);
        renderFiles();
      }
      schedulePoll();
    };
    xhr.onerror = () => { S.uploads.delete(tid); renderFiles(); toast("Upload failed: network error", true); };
    xhr.send(fd);
  }

  const dz = $("dropzone");
  $("fileInput").onchange = (e) => { [...e.target.files].forEach(uploadFile); e.target.value = ""; };
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => [...e.dataTransfer.files].forEach(uploadFile));
  // Allow dropping anywhere on the page too.
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    if (dz.contains(e.target)) return;
    e.preventDefault();
    [...(e.dataTransfer?.files || [])].forEach(uploadFile);
  });

  // ---- polling
  let pollTimer = null;
  function schedulePoll() {
    clearTimeout(pollTimer);
    const busy = S.files.some(isBusy) || S.uploads.size;
    pollTimer = setTimeout(async () => { await loadFiles(); schedulePoll(); }, busy ? 1500 : 10000);
  }

  // ------------------------------------------------------------------ open / close
  async function openFile(id) {
    if (S.current && S.current.id === id) return;
    await flushSave();
    const f = S.files.find((x) => x.id === id);
    if (!f) return;
    S.current = f;
    S.transcript = null;
    S.segs = [];
    S.activeIdx = -1;
    S.flagCursor = -1;
    S.peaks = [];
    history.replaceState(null, "", "#" + id);
    $("emptyState").classList.add("hidden");
    $("workspace").classList.remove("hidden");
    renderFiles();
    renderHeader();
    renderSegments();
    loadAudio();
    if (f.has_transcript) await loadTranscript();
  }

  function closeFile() {
    S.current = null;
    S.transcript = null;
    S.segs = [];
    audio.removeAttribute("src");
    audio.load();
    history.replaceState(null, "", location.pathname);
    $("workspace").classList.add("hidden");
    $("emptyState").classList.remove("hidden");
    renderFiles();
  }

  async function loadAudio() {
    const f = S.current;
    if (!f || f.status === "processing" || (f.status === "error" && !f.duration)) {
      audio.removeAttribute("src");
      drawWave();
      return;
    }
    const src = `/api/files/${f.id}/audio`;
    if (!audio.src.endsWith(src)) {
      audio.src = src;
      audio.playbackRate = parseFloat($("rateSelect").value);
    }
    try { S.peaks = await api(`/api/files/${f.id}/peaks`); } catch { S.peaks = []; }
    drawWave();
  }

  async function loadTranscript() {
    try {
      S.transcript = await api(`/api/files/${S.current.id}/transcript`);
      S.segs = S.transcript.segments;
    } catch {
      S.transcript = null; S.segs = [];
    }
    renderHeader();
    renderSegments();
  }

  // ------------------------------------------------------------------ header
  function renderHeader() {
    const f = S.current;
    if (!f) return;
    const title = $("fileTitle");
    if (document.activeElement !== title) title.textContent = f.name;
    const meta = $("fileMeta");
    meta.innerHTML = "";
    const add = (t) => meta.append(el("span", null, t));
    if (f.duration) add("⏱ " + fmt(f.duration));
    if (f.size) add(fmtSize(f.size));
    if (f.source_format) add(f.converted ? `${f.source_format} → MP3` : f.source_format);
    if (f.model && f.status === "done") add("🧠 " + f.model);
    if (f.language) add("🌐 " + f.language);
    if (f.transcribe_seconds) add(`took ${fmt(f.transcribe_seconds)}`);

    const busy = isBusy(f);
    const tb = $("transcribeBtn");
    tb.textContent = f.has_transcript ? "Re-transcribe" : "Transcribe";
    tb.disabled = busy || !f.duration;
    $("downloadBtn").disabled = !S.segs.length;

    const proc = $("processing");
    if (busy || f.status === "error") {
      proc.classList.remove("hidden");
      proc.classList.toggle("error", f.status === "error");
      if (f.status === "processing") { $("procTitle").textContent = "Preparing audio…"; $("procDetail").textContent = "Checking the format and converting to MP3 if needed"; }
      else if (f.status === "queued") { $("procTitle").textContent = "Queued"; $("procDetail").textContent = "Waiting for the transcription worker"; }
      else if (f.status === "transcribing") {
        $("procTitle").textContent = `Transcribing with ${f.model || "model"}…`;
        $("procDetail").textContent = `${fmt(f.elapsed || 0)} elapsed · llama-swap may need to load the model first`;
      } else { $("procTitle").textContent = "Something went wrong"; $("procDetail").textContent = f.error || "Unknown error"; }
    } else proc.classList.add("hidden");
  }

  $("fileTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } if (e.key === "Escape") { e.target.textContent = S.current.name; e.target.blur(); } });
  $("fileTitle").addEventListener("blur", async (e) => {
    const name = e.target.textContent.trim();
    if (!S.current || !name || name === S.current.name) { e.target.textContent = S.current?.name || ""; return; }
    try { S.current = await api(`/api/files/${S.current.id}`, { method: "PATCH", body: JSON.stringify({ name }) }); loadFiles(); }
    catch (err) { toast(err.message, true); }
  });

  $("transcribeBtn").onclick = async () => {
    const f = S.current;
    if (!f) return;
    if (f.has_transcript && !confirm("Re-transcribe this file? Your current transcript and any edits will be replaced.")) return;
    try {
      await flushSave();
      S.current = await api(`/api/files/${f.id}/transcribe`, { method: "POST", body: JSON.stringify(transcribeOpts()) });
      S.current.has_transcript = false;
      S.transcript = null; S.segs = [];
      renderHeader(); renderSegments();
      await loadFiles(); schedulePoll();
    } catch (e) { toast(e.message, true); }
  };

  // menus
  function bindMenu(btn, menu) {
    $(btn).onclick = (e) => { e.stopPropagation(); const m = $(btn).parentElement; const open = m.classList.contains("open"); closeMenus(); if (!open) m.classList.add("open"); };
  }
  function closeMenus() { document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open")); }
  bindMenu("downloadBtn"); bindMenu("moreBtn");
  document.addEventListener("click", closeMenus);

  $("downloadMenu").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-fmt]");
    if (!b) return;
    await flushSave();
    const a = document.createElement("a");
    a.href = `/api/files/${S.current.id}/download?format=${b.dataset.fmt}`;
    a.download = "";
    document.body.append(a); a.click(); a.remove();
  });
  $("revertBtn").onclick = async () => {
    if (!S.current || !S.transcript) return;
    if (!confirm("Discard all edits and restore the original transcription?")) return;
    try {
      clearTimeout(S.saveTimer); S.pendingSave = false;
      S.transcript = await api(`/api/files/${S.current.id}/transcript/revert`, { method: "POST" });
      S.segs = S.transcript.segments;
      renderSegments(); toast("Transcript restored");
    } catch (e) { toast(e.message, true); }
  };
  $("deleteBtn").onclick = async () => {
    if (!S.current || !confirm(`Delete "${S.current.name}"? This removes the audio and transcript.`)) return;
    try {
      clearTimeout(S.saveTimer); S.pendingSave = false;
      await api(`/api/files/${S.current.id}`, { method: "DELETE" });
      closeFile(); loadFiles(); toast("File deleted");
    } catch (e) { toast(e.message, true); }
  };

  // ------------------------------------------------------------------ flags
  function isFlagged(s) {
    if (s.reviewed) return false;
    if (s.issues && s.issues.length) return true;
    return s.confidence != null && s.confidence < S.threshold;
  }

  function wordsMatch(s) {
    if (!s.words || !s.words.length) return false;
    return s.words.map((w) => w.w).join("").trim() === s.text.trim();
  }

  // ------------------------------------------------------------------ segments
  function confColor(c) {
    if (c == null) return cssVar("--border-strong");
    if (c >= 0.85) return cssVar("--ok");
    if (c >= S.threshold) return cssVar("--accent-2");
    return cssVar("--warn");
  }

  function fillText(node, s) {
    node.textContent = "";
    const q = S.search.toLowerCase();
    if (wordsMatch(s) && !q) {
      const lead = s.words[0].w.length - s.words[0].w.trimStart().length;
      s.words.forEach((w, i) => {
        const txt = i === 0 ? w.w.slice(lead) : w.w;
        const sp = el("span", "w" + (w.p != null && w.p < S.wordThreshold ? " low" : ""), txt);
        sp.dataset.i = i;
        if (w.p != null) sp.title = `${Math.round(w.p * 100)}% confident`;
        node.append(sp);
      });
    } else if (q && s.text.toLowerCase().includes(q)) {
      const lower = s.text.toLowerCase(); let pos = 0, idx;
      while ((idx = lower.indexOf(q, pos)) !== -1) {
        node.append(document.createTextNode(s.text.slice(pos, idx)));
        node.append(el("mark", null, s.text.slice(idx, idx + q.length)));
        pos = idx + q.length;
      }
      node.append(document.createTextNode(s.text.slice(pos)));
    } else node.textContent = s.text;
  }

  const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>';
  const FLAG = '<svg viewBox="0 0 24 24"><path d="M12 6v8M12 18.5v.01"/></svg>';

  function renderSegments() {
    const box = $("segments");
    box.innerHTML = "";
    S.lastWordEl = null;
    if (!S.segs.length) {
      const f = S.current;
      const msg = !f ? "" : isBusy(f) ? "The transcript will appear here when it's ready." :
        f.status === "error" ? "Transcription failed. Check the model and try again." :
        "No transcript yet. Pick a model above and click Transcribe.";
      box.append(el("div", "seg-empty", msg));
      renderFlags(); return;
    }
    const frag = document.createDocumentFragment();
    S.segs.forEach((s, i) => {
      const row = el("div", "seg");
      row.dataset.i = i;
      const t = el("button", "seg-time", fmt(s.start));
      t.title = `${fmt(s.start, true)} → ${fmt(s.end, true)} · click to play`;
      t.onclick = () => seekTo(s.start, true);
      const txt = el("div", "seg-text");
      txt.contentEditable = "true";
      txt.spellcheck = true;
      fillText(txt, s);
      const side = el("div", "seg-side");
      const conf = el("div", "conf");
      const bar = el("i");
      bar.style.height = (s.confidence == null ? 100 : Math.max(8, s.confidence * 100)) + "%";
      bar.style.background = confColor(s.confidence);
      conf.append(bar);
      conf.title = s.confidence == null ? "No confidence data" : `Confidence ${Math.round(s.confidence * 100)}%`;
      const rv = el("button", "seg-review");
      rv.onclick = () => toggleReviewed(i);
      side.append(rv, conf);
      row.append(t, txt, side);
      if (s.edited) row.append(el("span", "seg-edited", "edited"));
      frag.append(row);
      decorateRow(row, s);
    });
    box.append(frag);
    renderFlags();
    updateActive(true);
  }

  function decorateRow(row, s) {
    const flagged = isFlagged(s);
    row.classList.toggle("flagged", flagged);
    row.classList.toggle("reviewed", !!s.reviewed);
    const rv = row.querySelector(".seg-review");
    rv.innerHTML = flagged ? FLAG : CHECK;
    rv.title = s.reviewed ? "Reviewed (click to undo)" : flagged ? "Flagged as uncertain. Click to mark reviewed (Alt+R)" : "Mark reviewed";
    const q = S.search.toLowerCase();
    row.classList.toggle("dim", !!q && !s.text.toLowerCase().includes(q));
  }

  function rowEl(i) { return $("segments").querySelector(`.seg[data-i="${i}"]`); }

  function toggleReviewed(i, value) {
    const s = S.segs[i];
    if (!s) return;
    s.reviewed = value ?? !s.reviewed;
    const row = rowEl(i);
    if (row) decorateRow(row, s);
    renderFlags();
    queueSave();
  }

  // editing
  const segBox = $("segments");
  segBox.addEventListener("input", (e) => {
    const txt = e.target.closest(".seg-text");
    if (!txt) return;
    const row = txt.parentElement;
    const i = +row.dataset.i;
    const s = S.segs[i];
    s.text = txt.textContent.replace(/\n/g, " ");
    if (!s.edited) {
      s.edited = true;
      row.append(el("span", "seg-edited", "edited"));
    }
    if (!s.reviewed) { s.reviewed = true; decorateRow(row, s); renderFlags(); }
    queueSave();
    pauseForTyping();
  });
  segBox.addEventListener("focusout", (e) => {
    const txt = e.target.closest(".seg-text");
    if (!txt) return;
    const s = S.segs[+txt.parentElement.dataset.i];
    if (s.edited && s.words && s.words.length && !wordsMatch(s)) s.words = [];
    fillText(txt, s);
  });
  segBox.addEventListener("keydown", (e) => {
    const txt = e.target.closest(".seg-text");
    if (!txt) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const next = rowEl(+txt.parentElement.dataset.i + 1);
      if (next) focusEnd(next.querySelector(".seg-text"));
      else txt.blur();
    } else if (e.key === "Escape") txt.blur();
  });
  segBox.addEventListener("paste", (e) => {
    if (!e.target.closest(".seg-text")) return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text").replace(/\s*\n\s*/g, " ");
    document.execCommand("insertText", false, text);
  });
  segBox.addEventListener("click", (e) => {
    const w = e.target.closest(".w");
    if (w && e.altKey) {
      e.preventDefault();
      const s = S.segs[+w.closest(".seg").dataset.i];
      const word = s.words[+w.dataset.i];
      seekTo(word?.s ?? s.start, true);
    }
  });
  function focusEnd(node) {
    node.focus();
    const r = document.createRange();
    r.selectNodeContents(node); r.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  }

  function pauseForTyping() {
    if (!$("typingToggle").checked) return;
    if (!audio.paused) { audio.pause(); S.resumeAfterTyping = true; }
    clearTimeout(S.typingTimer);
    if (S.resumeAfterTyping) {
      S.typingTimer = setTimeout(() => {
        S.resumeAfterTyping = false;
        audio.currentTime = Math.max(0, audio.currentTime - 1);
        audio.play();
      }, 1400);
    }
  }

  // search
  $("searchInput").addEventListener("input", (e) => {
    S.search = e.target.value.trim();
    S.segs.forEach((s, i) => { const r = rowEl(i); if (r) { fillText(r.querySelector(".seg-text"), s); decorateRow(r, s); } });
    const first = S.segs.findIndex((s) => S.search && s.text.toLowerCase().includes(S.search.toLowerCase()));
    if (first >= 0) rowEl(first).scrollIntoView({ block: "center" });
  });

  // ------------------------------------------------------------------ saving
  function queueSave() {
    S.pendingSave = true;
    $("saveState").textContent = "Unsaved changes";
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(save, 900);
  }
  async function save() {
    if (!S.current || !S.pendingSave) return;
    if (S.saving) { S.saveTimer = setTimeout(save, 300); return; }
    S.saving = true; S.pendingSave = false;
    $("saveState").textContent = "Saving…";
    const id = S.current.id;
    try {
      await api(`/api/files/${id}/transcript`, {
        method: "PUT",
        body: JSON.stringify({ segments: S.segs.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.text, reviewed: !!s.reviewed, edited: !!s.edited, words: s.words })) }),
      });
      if (S.current && S.current.id === id) $("saveState").textContent = "All changes saved";
    } catch (e) {
      S.pendingSave = true;
      $("saveState").textContent = "Save failed, retrying…";
      S.saveTimer = setTimeout(save, 3000);
    } finally { S.saving = false; }
  }
  async function flushSave() {
    clearTimeout(S.saveTimer);
    if (S.pendingSave) await save();
  }
  window.addEventListener("beforeunload", (e) => { if (S.pendingSave) { save(); e.preventDefault(); } });

  // ------------------------------------------------------------------ review panel
  function renderFlags() {
    S.flagged = S.segs.map((s, i) => (isFlagged(s) ? i : -1)).filter((i) => i >= 0);
    $("flagCount").textContent = S.flagged.length;
    drawWave();
    const list = $("flagList");
    list.innerHTML = "";
    const withConf = S.segs.filter((s) => s.confidence != null);
    const avg = withConf.length ? withConf.reduce((a, s) => a + s.confidence, 0) / withConf.length : null;
    const reviewed = S.segs.filter((s) => s.reviewed).length;
    $("stats").innerHTML = "";
    for (const [v, l] of [[avg == null ? "–" : Math.round(avg * 100) + "%", "avg confidence"], [S.segs.length, "segments"], [reviewed, "reviewed"]]) {
      const d = el("div", "stat"); d.append(el("b", null, v), el("span", null, l)); $("stats").append(d);
    }
    if (!S.segs.length) { list.append(el("li", "flag-done", "Flags appear here once a transcript is ready.")); return; }
    if (!S.flagged.length) {
      const li = el("li", "flag-done"); li.append(el("b", null, "✓"), document.createTextNode("Nothing left to review at this sensitivity."));
      list.append(li); return;
    }
    for (const i of S.flagged) {
      const s = S.segs[i];
      const li = el("li", "flag-item" + (S.flagged[S.flagCursor] === i ? " current" : ""));
      li.dataset.i = i;
      const top = el("div", "flag-top");
      top.append(el("span", null, `${fmt(s.start)} – ${fmt(s.end)}`), el("span", "flag-conf", s.confidence == null ? "?" : Math.round(s.confidence * 100) + "%"));
      li.append(top, el("div", "flag-text", s.text || "(empty)"));
      const reasons = el("div", "flag-reasons");
      if (s.confidence != null && s.confidence < S.threshold) reasons.append(el("span", null, "Low confidence"));
      (s.issues || []).forEach((r) => reasons.append(el("span", null, r)));
      (s.low_words || []).slice(0, 5).forEach((w) => reasons.append(el("span", "word", w)));
      if (reasons.children.length) li.append(reasons);
      li.onclick = () => jumpToFlag(S.flagged.indexOf(i));
      list.append(li);
    }
  }

  function jumpToFlag(k) {
    if (!S.flagged.length) return;
    S.flagCursor = (k + S.flagged.length) % S.flagged.length;
    const i = S.flagged[S.flagCursor];
    const s = S.segs[i];
    seekTo(Math.max(0, s.start - 0.6), true);
    const row = rowEl(i);
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
    }
    document.querySelectorAll(".flag-item").forEach((n) => n.classList.toggle("current", +n.dataset.i === i));
    document.querySelector(".flag-item.current")?.scrollIntoView({ block: "nearest" });
  }
  function nextFlag(dir) {
    if (!S.flagged.length) { toast("No flagged segments"); return; }
    const t = audio.currentTime + 0.7;
    let k;
    if (dir > 0) { k = S.flagged.findIndex((i) => S.segs[i].start > t); if (k < 0) k = 0; }
    else { k = -1; S.flagged.forEach((i, j) => { if (S.segs[i].start < t - 1.5) k = j; }); if (k < 0) k = S.flagged.length - 1; }
    jumpToFlag(k);
  }
  $("nextFlag").onclick = () => nextFlag(1);
  $("prevFlag").onclick = () => nextFlag(-1);
  $("threshold").addEventListener("input", (e) => {
    S.threshold = parseFloat(e.target.value);
    $("thresholdVal").textContent = Math.round(S.threshold * 100) + "%";
    store.set("threshold", S.threshold);
    S.segs.forEach((s, i) => { const r = rowEl(i); if (r) { decorateRow(r, s); r.querySelector(".conf i").style.background = confColor(s.confidence); } });
    renderFlags();
  });
  $("reviewAllBtn").onclick = () => {
    if (!S.flagged.length) return;
    if (!confirm(`Mark all ${S.flagged.length} flagged segments as reviewed?`)) return;
    S.flagged.slice().forEach((i) => toggleReviewed(i, true));
  };

  // ------------------------------------------------------------------ player
  function seekTo(t, play = false) {
    if (!audio.src) return;
    audio.currentTime = Math.max(0, Math.min(t, audio.duration || t));
    if (play) audio.play().catch(() => {});
    updateActive(true);
    drawWave();
  }
  const playBtn = $("playBtn");
  function togglePlay() {
    if (!audio.src) return;
    S.resumeAfterTyping = false; clearTimeout(S.typingTimer);
    if (audio.paused) audio.play().catch((e) => toast(e.message, true)); else audio.pause();
  }
  playBtn.onclick = togglePlay;
  $("backBtn").onclick = () => seekTo(audio.currentTime - 5);
  $("fwdBtn").onclick = () => seekTo(audio.currentTime + 5);
  $("rateSelect").onchange = (e) => { audio.playbackRate = parseFloat(e.target.value); store.set("rate", e.target.value); };
  $("rateSelect").value = store.get("rate", "1");
  $("volume").oninput = (e) => { audio.volume = parseFloat(e.target.value); store.set("volume", audio.volume); };
  $("volume").value = audio.volume = store.get("volume", 1);
  $("followToggle").checked = store.get("follow", true);
  $("followToggle").onchange = (e) => store.set("follow", e.target.checked);
  $("typingToggle").checked = store.get("typing", true);
  $("typingToggle").onchange = (e) => store.set("typing", e.target.checked);

  const PLAY = '<path d="M8 5v14l11-7z"/>', PAUSE = '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>';
  audio.addEventListener("play", () => { $("playIcon").innerHTML = PAUSE; tick(); });
  audio.addEventListener("pause", () => { $("playIcon").innerHTML = PLAY; drawWave(); });
  audio.addEventListener("loadedmetadata", () => { $("durTime").textContent = fmt(audio.duration); drawWave(); });
  audio.addEventListener("timeupdate", () => { if (audio.paused) { updateActive(); drawWave(); } });
  audio.addEventListener("error", () => { if (audio.getAttribute("src")) toast("Could not load audio", true); });

  function tick() {
    updateActive();
    drawWave();
    if (!audio.paused) requestAnimationFrame(tick);
  }

  function findSeg(t) {
    let lo = 0, hi = S.segs.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (S.segs[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }

  let lastScroll = 0;
  function updateActive(force = false) {
    const t = audio.currentTime || 0;
    $("curTime").textContent = fmt(t);
    const i = findSeg(t);
    if (i !== S.activeIdx || force) {
      rowEl(S.activeIdx)?.classList.remove("active");
      S.activeIdx = i;
      const row = rowEl(i);
      if (row) {
        row.classList.add("active");
        const editing = document.activeElement && document.activeElement.classList.contains("seg-text");
        if ($("followToggle").checked && !editing && !audio.paused && Date.now() - lastScroll > 250) {
          const box = $("segments");
          const rb = row.getBoundingClientRect(), bb = box.getBoundingClientRect();
          if (rb.top < bb.top + 40 || rb.bottom > bb.bottom - 40) row.scrollIntoView({ block: "center", behavior: "smooth" });
          lastScroll = Date.now();
        }
      }
    }
    // word highlight
    const s = S.segs[i];
    let wEl = null;
    if (s && s.words && s.words.length && t <= s.end + 0.3) {
      const row = rowEl(i);
      let wi = -1;
      for (let k = 0; k < s.words.length; k++) { if (s.words[k].s != null && s.words[k].s <= t) wi = k; else if (s.words[k].s > t) break; }
      if (wi >= 0 && row) wEl = row.querySelector(`.w[data-i="${wi}"]`);
    }
    if (wEl !== S.lastWordEl) {
      S.lastWordEl?.classList.remove("now");
      wEl?.classList.add("now");
      S.lastWordEl = wEl;
    }
  }

  // ------------------------------------------------------------------ waveform
  let waveColors = null;
  function drawWave() {
    const wrap = $("waveWrap");
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    if (!waveColors) waveColors = { wave: cssVar("--wave"), a: cssVar("--accent"), b: cssVar("--accent-2"), warn: cssVar("--warn") };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const dur = audio.duration || S.current?.duration || 0;
    if (!dur) return;
    const x = (t) => (t / dur) * w;

    // flagged regions
    ctx.fillStyle = waveColors.warn;
    for (const i of S.flagged) {
      const s = S.segs[i];
      ctx.globalAlpha = 0.16;
      ctx.fillRect(x(s.start), 0, Math.max(2, x(s.end) - x(s.start)), h);
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x(s.start), h - 3, Math.max(2, x(s.end) - x(s.start)), 3);
    }
    ctx.globalAlpha = 1;
    // active segment
    const act = S.segs[S.activeIdx];
    if (act) { ctx.fillStyle = waveColors.a; ctx.globalAlpha = 0.1; ctx.fillRect(x(act.start), 0, x(act.end) - x(act.start), h); ctx.globalAlpha = 1; }

    const progress = x(audio.currentTime || 0);
    const bar = 2, gap = 1, n = Math.floor(w / (bar + gap));
    const mid = h / 2 - 2;
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, waveColors.a); grad.addColorStop(1, waveColors.b);
    const peaks = S.peaks;
    for (let k = 0; k < n; k++) {
      let p = 0.04;
      if (peaks.length) {
        const a = Math.floor((k / n) * peaks.length), b = Math.max(a + 1, Math.floor(((k + 1) / n) * peaks.length));
        for (let j = a; j < b && j < peaks.length; j++) p = Math.max(p, peaks[j]);
      }
      const bh = Math.max(1.5, p * (mid - 2));
      const bx = k * (bar + gap);
      ctx.fillStyle = bx < progress ? grad : waveColors.wave;
      ctx.fillRect(bx, mid - bh, bar, bh * 2);
    }
    // playhead
    ctx.fillStyle = waveColors.b;
    ctx.fillRect(progress - 1, 0, 2, h);
  }
  const waveWrap = $("waveWrap");
  waveWrap.addEventListener("click", (e) => {
    const dur = audio.duration || 0; if (!dur) return;
    const r = waveWrap.getBoundingClientRect();
    seekTo(((e.clientX - r.left) / r.width) * dur);
  });
  waveWrap.addEventListener("mousemove", (e) => {
    const dur = audio.duration || 0; if (!dur) return;
    const r = waveWrap.getBoundingClientRect();
    const hov = $("waveHover");
    hov.style.left = e.clientX - r.left + "px";
    hov.textContent = fmt(((e.clientX - r.left) / r.width) * dur);
  });
  new ResizeObserver(() => drawWave()).observe(waveWrap);
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { waveColors = null; drawWave(); });

  // ------------------------------------------------------------------ keyboard
  document.addEventListener("keydown", (e) => {
    const inField = e.target.closest("input, select, [contenteditable=true]");
    if ((e.ctrlKey || e.metaKey) && e.code === "Space") { e.preventDefault(); togglePlay(); return; }
    if (e.code === "Space" && !inField) { e.preventDefault(); togglePlay(); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const map = {
        Comma: () => seekTo(audio.currentTime - 5),
        Period: () => seekTo(audio.currentTime + 5),
        KeyN: () => nextFlag(1),
        KeyP: () => nextFlag(-1),
        KeyR: () => {
          const ed = document.activeElement?.closest?.(".seg");
          const i = ed ? +ed.dataset.i : S.activeIdx;
          if (i >= 0) toggleReviewed(i, true);
          if (!ed) nextFlag(1);
        },
      };
      if (map[e.code]) { e.preventDefault(); map[e.code](); }
    }
    if (!inField && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (e.key === "ArrowLeft") { e.preventDefault(); seekTo(audio.currentTime - 5); }
      if (e.key === "ArrowRight") { e.preventDefault(); seekTo(audio.currentTime + 5); }
    }
  });

  // ------------------------------------------------------------------ empty state art
  (() => {
    const g = $("emptyBars");
    for (let i = 0; i < 24; i++) {
      const h = 10 + Math.abs(Math.sin(i * 0.9)) * 40;
      const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      r.setAttribute("x", i * 5); r.setAttribute("y", 30 - h / 2); r.setAttribute("width", 3); r.setAttribute("height", h); r.setAttribute("rx", 1.5);
      r.style.animationDelay = (i * 0.06) + "s";
      g.append(r);
    }
  })();

  // ------------------------------------------------------------------ boot
  (async () => {
    await loadConfig();
    await loadFiles();
    schedulePoll();
    const hash = location.hash.slice(1);
    if (hash && S.files.some((f) => f.id === hash)) openFile(hash);
  })();
  window.addEventListener("hashchange", () => {
    const hash = location.hash.slice(1);
    if (hash && S.files.some((f) => f.id === hash)) openFile(hash);
  });
})();
