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
  const SPK_COLORS = ["#7c6cff", "#22c3d8", "#f472b6", "#34d399", "#fb923c", "#60a5fa", "#e5b80b", "#a78bfa", "#f87171", "#84cc16"];

  const S = {
    config: null,
    files: [],
    uploads: new Map(),
    current: null,
    transcript: null,
    segs: [],
    speakers: {},
    activeIdx: -1,
    activeWord: -1,
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
    selectMode: false,
    selected: new Set(),
    spkTarget: null,
    spkScope: "seg",
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
  const svg = (paths) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.innerHTML = paths; return s; };
  const ICON_FILE = '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>';
  const ICON_TRASH = '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>';

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
      const models = c.models.length ? c.models.slice() : [c.default_model];
      if (saved && !models.includes(saved)) models.unshift(saved);
      sel.innerHTML = "";
      for (const m of models) sel.append(new Option(m, m, false, m === saved));
      $("languageInput").value = store.get("language", c.default_language || "");
      $("autoToggle").checked = store.get("auto", c.auto_transcribe);
      $("speakersField").classList.toggle("hidden", !c.diarization_available);
      const spk = store.get("speakers", c.diarization_default || "auto");
      $("speakersSelect").value = [...$("speakersSelect").options].some((o) => o.value === spk) ? spk : "auto";
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
  $("speakersSelect").onchange = (e) => store.set("speakers", e.target.value);
  $("backendStatus").onclick = loadConfig;

  function transcribeOpts() {
    const o = { model: $("modelSelect").value || undefined };
    const lang = $("languageInput").value.trim();
    if (lang) o.language = lang;
    if (S.config?.diarization_available) o.speakers = $("speakersSelect").value;
    return o;
  }

  // ------------------------------------------------------------------ files
  const STATUS_LABEL = { processing: "Converting", ready: "Ready", queued: "Queued", transcribing: "Transcribing", diarizing: "Finding speakers", done: "Transcribed", error: "Error" };
  const isBusy = (f) => ["processing", "queued", "transcribing", "diarizing"].includes(f.status);

  async function loadFiles() {
    try { S.files = await api("/api/files"); } catch { return; }
    for (const id of [...S.selected]) if (!S.files.some((f) => f.id === id)) S.selected.delete(id);
    renderFiles();
    if (!S.current) return;
    const f = S.files.find((x) => x.id === S.current.id);
    if (!f) { closeFile(); return; }
    const prev = S.current;
    S.current = f;
    renderHeader();
    if (prev.status !== f.status && !S.segs.length) renderSegments();
    if (isBusy(prev) && !isBusy(f) && f.has_transcript) {
      await loadTranscript();
      if (f.status === "done") toast(prev.status === "diarizing" ? "Speakers updated" : "Transcription finished");
    }
    if (prev.status === "processing" && f.status !== "processing") loadAudio();
  }

  function renderFiles() {
    const list = $("fileList");
    list.innerHTML = "";
    for (const [tid, u] of S.uploads) {
      const li = el("li", "file");
      const ic = el("div", "ficon"); ic.append(svg(ICON_FILE));
      const body = el("div");
      body.append(el("div", "fname", u.name));
      const sub = el("div", "fsub");
      sub.append(el("span", "pill busy", u.progress < 1 ? `Uploading ${Math.round(u.progress * 100)}%` : "Finishing upload"));
      body.append(sub);
      const bar = el("div", "progress"); bar.style.width = u.progress * 100 + "%";
      li.append(ic, body, el("span"), bar);
      li.dataset.tid = tid;
      list.append(li);
    }
    for (const f of S.files) {
      const sel = S.selected.has(f.id);
      const li = el("li", "file" + (S.current && S.current.id === f.id ? " active" : "") + (sel ? " selected" : ""));
      let lead;
      if (S.selectMode) {
        lead = el("label", "fcheck");
        const cb = el("input"); cb.type = "checkbox"; cb.checked = sel;
        cb.onclick = (e) => e.stopPropagation();
        cb.onchange = () => { cb.checked ? S.selected.add(f.id) : S.selected.delete(f.id); renderFiles(); };
        lead.append(cb);
      } else { lead = el("div", "ficon"); lead.append(svg(ICON_FILE)); }
      const body = el("div");
      body.style.minWidth = "0";
      body.append(el("div", "fname", f.name));
      body.title = f.name;
      const sub = el("div", "fsub");
      let label = STATUS_LABEL[f.status] || f.status;
      if (f.status === "transcribing" && f.progress?.total) label += ` ${f.progress.done || 0}/${f.progress.total}`;
      else if (isBusy(f) && f.elapsed != null) label += " " + fmt(f.elapsed);
      const cls = f.status === "done" ? "done" : f.status === "error" ? "error" : isBusy(f) ? "busy" : "";
      sub.append(el("span", "pill " + cls, label));
      if (f.audio_deleted) sub.append(el("span", "pill gone", "no audio"));
      if (f.duration) sub.append(el("span", null, fmt(f.duration)));
      if (f.speaker_count > 1) sub.append(el("span", null, `${f.speaker_count} speakers`));
      body.append(sub);
      const del = el("button", "fdel"); del.title = "Delete"; del.append(svg(ICON_TRASH));
      del.onclick = (e) => { e.stopPropagation(); deleteFiles([f.id]); };
      li.append(lead, body, S.selectMode ? el("span") : del);
      li.onclick = () => {
        if (S.selectMode) { sel ? S.selected.delete(f.id) : S.selected.add(f.id); renderFiles(); }
        else openFile(f.id);
      };
      list.append(li);
    }
    $("fileCount").textContent = S.files.length ? S.files.length : "";
    $("selectToggle").textContent = S.selectMode ? "Done" : "Select";
    $("bulkBar").classList.toggle("hidden", !S.selectMode);
    $("bulkCount").textContent = `${S.selected.size} selected`;
    $("bulkDelete").disabled = $("bulkAudio").disabled = !S.selected.size;
  }

  // ---- deletion
  async function deleteFiles(ids, audioOnly = false) {
    if (!ids.length) return;
    const names = ids.map((id) => S.files.find((f) => f.id === id)?.name || id);
    const what = ids.length === 1 ? `"${names[0]}"` : `${ids.length} files`;
    const msg = audioOnly
      ? `Delete the audio for ${what}? Transcripts are kept and can still be edited and downloaded.`
      : `Delete ${what}? This removes the audio and the transcript.`;
    if (!confirm(msg)) return;
    if (S.current && ids.includes(S.current.id)) { clearTimeout(S.saveTimer); if (!audioOnly) S.pendingSave = false; else await flushSave(); }
    try {
      const r = await api("/api/files/delete", { method: "POST", body: JSON.stringify({ ids, audio_only: audioOnly }) });
      ids.forEach((id) => S.selected.delete(id));
      if (r.skipped.length) toast(`${r.skipped.length} file(s) are busy and were skipped`, true);
      else toast(audioOnly ? "Audio deleted" : ids.length > 1 ? `${ids.length} files deleted` : "File deleted");
      if (S.current && r.deleted.includes(S.current.id)) {
        if (audioOnly) { S.current.has_audio = false; S.current.audio_deleted = true; audio.removeAttribute("src"); audio.load(); }
        else closeFile();
      }
      await loadFiles();
      if (S.current) { renderHeader(); loadAudio(); }
    } catch (e) { toast(e.message, true); }
  }
  $("selectToggle").onclick = () => { S.selectMode = !S.selectMode; if (!S.selectMode) S.selected.clear(); renderFiles(); };
  $("bulkAll").onclick = () => { if (S.selected.size === S.files.length) S.selected.clear(); else S.files.forEach((f) => S.selected.add(f.id)); renderFiles(); };
  $("bulkDelete").onclick = () => deleteFiles([...S.selected]);
  $("bulkAudio").onclick = () => deleteFiles([...S.selected], true);

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
    if (o.speakers) fd.append("speakers", o.speakers);
    fd.append("auto", $("autoToggle").checked ? "true" : "false");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files");
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = e.loaded / e.total;
      S.uploads.get(tid).progress = p;
      const li = document.querySelector(`[data-tid="${tid}"]`);
      if (li) {
        li.querySelector(".progress").style.width = p * 100 + "%";
        li.querySelector(".pill").textContent = p < 1 ? `Uploading ${Math.round(p * 100)}%` : "Finishing upload";
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
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    if (dz.contains(e.target)) return;
    e.preventDefault();
    [...(e.dataTransfer?.files || [])].forEach(uploadFile);
  });

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
    S.transcript = null; S.segs = []; S.speakers = {};
    S.activeIdx = -1; S.activeWord = -1; S.flagCursor = -1; S.peaks = [];
    history.replaceState(null, "", "#" + id);
    $("emptyState").classList.add("hidden");
    $("workspace").classList.remove("hidden");
    renderFiles(); renderHeader(); renderSegments();
    loadAudio();
    if (f.has_transcript) await loadTranscript();
  }

  function closeFile() {
    S.current = null; S.transcript = null; S.segs = []; S.speakers = {};
    audio.removeAttribute("src"); audio.load();
    history.replaceState(null, "", location.pathname);
    $("workspace").classList.add("hidden");
    $("emptyState").classList.remove("hidden");
    renderFiles();
  }

  async function loadAudio() {
    const f = S.current;
    const usable = f && f.has_audio && f.status !== "processing";
    $("playerCard").classList.toggle("hidden", !!(f && !f.has_audio && f.status !== "processing"));
    $("audioGone").classList.toggle("hidden", !(f && f.audio_deleted));
    if (!usable) { audio.removeAttribute("src"); S.peaks = []; drawWave(); return; }
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
      S.speakers = S.transcript.speakers || {};
    } catch { S.transcript = null; S.segs = []; S.speakers = {}; }
    renderHeader(); renderSegments(); renderSpeakers();
  }

  // ------------------------------------------------------------------ header & progress
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
    if (f.transcribe_seconds) add(`took ${fmt(f.transcribe_seconds)}${f.chunks > 1 ? ` · ${f.chunks} chunks` : ""}`);
    if (S.transcript?.timing === "estimated") add("word timing estimated");

    const busy = isBusy(f);
    const tb = $("transcribeBtn");
    tb.textContent = f.has_transcript ? "Re-transcribe" : "Transcribe";
    tb.disabled = busy || !f.has_audio;
    $("downloadBtn").disabled = !S.segs.length;
    $("diarizeBtn").disabled = busy || !f.has_audio || !S.segs.length || !S.config?.diarization_available;
    $("deleteAudioBtn").disabled = busy || !f.has_audio;

    const proc = $("processing");
    const bars = $("procBars");
    bars.innerHTML = "";
    if (!busy && !f.error) { proc.classList.add("hidden"); return; }
    proc.classList.remove("hidden");
    proc.classList.toggle("error", !busy);
    const p = f.progress || {};
    if (!busy) {
      $("procTitle").textContent = "Something went wrong";
      $("procDetail").textContent = f.error || "Unknown error";
      return;
    }
    if (f.status === "processing") { $("procTitle").textContent = "Preparing audio…"; $("procDetail").textContent = "Checking the format and converting to MP3 if needed"; return; }
    if (f.status === "queued") { $("procTitle").textContent = "Queued"; $("procDetail").textContent = "Waiting for the current job to finish"; return; }
    if (f.status === "diarizing") {
      $("procTitle").textContent = "Detecting speakers…";
      $("procDetail").textContent = `${fmt(f.elapsed || 0)} elapsed · runs on the server CPU`;
    } else {
      $("procTitle").textContent = `Transcribing with ${f.model || "model"}…`;
      let detail = `${fmt(f.elapsed || 0)} elapsed`;
      if (p.label) detail += ` · ${p.label}`;
      else if (p.stage === "speakers") detail += " · matching speakers to text";
      else if (p.eta != null && p.done < p.total) detail += ` · about ${fmt(p.eta)} left`;
      else if (!p.done) detail += " · llama-swap may need to load the model first";
      $("procDetail").textContent = detail;
      if (p.total) addBar(bars, "Transcription", p.done / p.total, `${p.done}/${p.total}`);
    }
    if (p.speakers != null) addBar(bars, "Speakers", p.speakers, Math.round(p.speakers * 100) + "%");
  }
  function addBar(box, label, frac, text) {
    const row = el("div", "bar-row");
    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill"); fill.style.width = Math.max(2, Math.min(100, frac * 100)) + "%";
    track.append(fill);
    row.append(el("span", null, label), track, el("span", null, text));
    box.append(row);
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
      S.transcript = null; S.segs = []; S.speakers = {};
      renderHeader(); renderSegments(); renderSpeakers();
      await loadFiles(); schedulePoll();
    } catch (e) { toast(e.message, true); }
  };

  function bindMenu(btn) {
    $(btn).onclick = (e) => { e.stopPropagation(); const m = $(btn).parentElement; const open = m.classList.contains("open"); closeMenus(); if (!open) m.classList.add("open"); };
  }
  function closeMenus() { document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open")); hideSpkMenu(); }
  bindMenu("downloadBtn"); bindMenu("moreBtn");
  document.addEventListener("click", (e) => { if (!e.target.closest("#spkMenu")) closeMenus(); });

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
    if (!confirm("Discard all edits (text and speaker names) and restore the original transcription?")) return;
    try {
      clearTimeout(S.saveTimer); S.pendingSave = false;
      S.transcript = await api(`/api/files/${S.current.id}/transcript/revert`, { method: "POST" });
      S.segs = S.transcript.segments; S.speakers = S.transcript.speakers || {};
      renderSegments(); renderSpeakers(); toast("Transcript restored");
    } catch (e) { toast(e.message, true); }
  };
  $("diarizeBtn").onclick = async () => {
    if (!S.current) return;
    let n = $("speakersSelect").value;
    if (n === "off") n = "auto";
    if (!confirm(`Detect speakers again (${n === "auto" ? "automatic count" : n + " speakers"})? Speaker labels will be replaced; your text edits are kept.`)) return;
    try {
      await flushSave();
      S.current = await api(`/api/files/${S.current.id}/diarize`, { method: "POST", body: JSON.stringify({ speakers: n }) });
      renderHeader(); await loadFiles(); schedulePoll();
    } catch (e) { toast(e.message, true); }
  };
  $("deleteAudioBtn").onclick = () => S.current && deleteFiles([S.current.id], true);
  $("deleteBtn").onclick = () => S.current && deleteFiles([S.current.id]);

  // ------------------------------------------------------------------ speakers
  function spkColor(id) {
    const keys = Object.keys(S.speakers);
    const i = keys.indexOf(id);
    return SPK_COLORS[(i < 0 ? 0 : i) % SPK_COLORS.length];
  }
  const spkName = (id) => (id && S.speakers[id]?.name) || id || "";

  function renderSpeakers() {
    const card = $("speakersCard");
    const ids = Object.keys(S.speakers);
    card.classList.toggle("hidden", !ids.length || !S.segs.length);
    const list = $("speakerList");
    list.innerHTML = "";
    const talk = {};
    let total = 0;
    for (const s of S.segs) if (s.speaker) { talk[s.speaker] = (talk[s.speaker] || 0) + (s.end - s.start); total += s.end - s.start; }
    for (const id of ids) {
      const li = el("li");
      const sw = el("span", "sw"); sw.style.background = spkColor(id);
      const box = el("div"); box.style.minWidth = "0";
      const input = el("input"); input.value = spkName(id); input.spellcheck = false;
      input.oninput = () => {
        S.speakers[id].name = input.value || id;
        document.querySelectorAll(`.spk-chip[data-spk="${id}"]`).forEach((c) => (c.textContent = S.speakers[id].name));
        queueSave();
      };
      input.onkeydown = (e) => { if (e.key === "Enter") input.blur(); };
      const share = el("span", "share");
      share.style.background = spkColor(id);
      share.style.width = total ? Math.max(2, ((talk[id] || 0) / total) * 100) + "%" : "0";
      box.append(input, share);
      li.append(sw, box, el("small", null, `${fmt(talk[id] || 0)} · ${total ? Math.round(((talk[id] || 0) / total) * 100) : 0}%`));
      list.append(li);
    }
  }
  function newSpeakerId() {
    let n = Object.keys(S.speakers).length + 1;
    while (S.speakers["S" + n]) n++;
    return "S" + n;
  }
  $("addSpeaker").onclick = () => {
    const id = newSpeakerId();
    S.speakers[id] = { name: `Speaker ${id.slice(1)}` };
    renderSpeakers(); queueSave();
    const inputs = $("speakerList").querySelectorAll("input");
    inputs[inputs.length - 1]?.select();
  };

  function turnRange(i) {
    const spk = S.segs[i].speaker;
    let a = i, b = i;
    while (a > 0 && S.segs[a - 1].speaker === spk) a--;
    while (b < S.segs.length - 1 && S.segs[b + 1].speaker === spk) b++;
    return [a, b];
  }
  function showSpkMenu(i, anchor, isTurnStart) {
    S.spkTarget = i;
    S.spkScope = isTurnStart ? "turn" : "seg";
    const m = $("spkMenu");
    m.querySelectorAll(".spk-scope button").forEach((b) => b.classList.toggle("on", b.dataset.scope === S.spkScope));
    const list = $("spkMenuList");
    list.innerHTML = "";
    for (const id of Object.keys(S.speakers)) {
      const b = el("button", "opt" + (S.segs[i].speaker === id ? " cur" : ""));
      const dot = el("i"); dot.style.background = spkColor(id);
      b.append(dot, document.createTextNode(spkName(id)));
      b.onclick = () => assignSpeaker(id);
      list.append(b);
    }
    m.classList.remove("hidden");
    const r = anchor.getBoundingClientRect();
    const mh = m.offsetHeight, mw = m.offsetWidth;
    m.style.left = Math.min(r.left, innerWidth - mw - 8) + "px";
    m.style.top = (r.bottom + mh + 8 > innerHeight ? r.top - mh - 6 : r.bottom + 6) + "px";
  }
  function hideSpkMenu() { $("spkMenu").classList.add("hidden"); S.spkTarget = null; }
  $("spkMenu").querySelectorAll(".spk-scope button").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    S.spkScope = b.dataset.scope;
    $("spkMenu").querySelectorAll(".spk-scope button").forEach((x) => x.classList.toggle("on", x === b));
  }));
  $("spkNew").onclick = () => {
    const id = newSpeakerId();
    const name = prompt("Name for the new speaker:", `Speaker ${id.slice(1)}`);
    if (name == null) return;
    S.speakers[id] = { name: name.trim() || id };
    assignSpeaker(id);
  };
  function assignSpeaker(id) {
    const i = S.spkTarget;
    if (i == null) return;
    const [a, b] = S.spkScope === "turn" ? turnRange(i) : [i, i];
    for (let k = a; k <= b; k++) S.segs[k].speaker = id;
    hideSpkMenu();
    renderSegments(); renderSpeakers(); queueSave();
  }

  // ------------------------------------------------------------------ flags
  function isFlagged(s) {
    if (s.reviewed) return false;
    if (s.issues && s.issues.length) return true;
    return s.confidence != null && s.confidence < S.threshold;
  }
  const norm = (t) => t.replace(/\s+/g, " ").trim();
  function wordsMatch(s) {
    return !!(s.words && s.words.length) && norm(s.words.map((w) => w.w).join("")) === norm(s.text);
  }
  /** Words for display/highlighting: model words when they still match the text, else an even estimate. */
  function displayWords(s) {
    if (wordsMatch(s)) return s.words;
    if (s._ew && s._ewText === s.text) return s._ew;
    const toks = s.text.trim().split(/\s+/).filter(Boolean);
    const weights = toks.map((t) => t.length + 2);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let cum = 0;
    const span = Math.max(0.1, s.end - s.start);
    s._ew = toks.map((t, i) => {
      const st = s.start + (cum / total) * span; cum += weights[i];
      return { w: " " + t, s: st, e: s.start + (cum / total) * span, p: null, est: true };
    });
    s._ewText = s.text;
    return s._ew;
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
    if (q && s.text.toLowerCase().includes(q)) {
      const lower = s.text.toLowerCase(); let pos = 0, idx;
      while ((idx = lower.indexOf(q, pos)) !== -1) {
        node.append(document.createTextNode(s.text.slice(pos, idx)));
        node.append(el("mark", null, s.text.slice(idx, idx + q.length)));
        pos = idx + q.length;
      }
      node.append(document.createTextNode(s.text.slice(pos)));
      return;
    }
    const words = displayWords(s);
    if (!words.length) { node.textContent = s.text; return; }
    words.forEach((w, i) => {
      const txt = i === 0 ? w.w.trimStart() : w.w;
      const low = w.p != null && w.p < S.wordThreshold;
      const sp = el("span", "w" + (low ? " low" : ""), txt);
      sp.dataset.i = i;
      if (w.p != null) sp.title = `${Math.round(w.p * 100)}% confident`;
      node.append(sp);
    });
  }

  const CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>';
  const FLAG = '<svg viewBox="0 0 24 24"><path d="M12 6v8M12 18.5v.01"/></svg>';

  function renderSegments() {
    const box = $("segments");
    const scroll = box.scrollTop;
    box.innerHTML = "";
    S.activeIdx = -1; S.activeWord = -1;
    if (!S.segs.length) {
      const f = S.current;
      const msg = !f ? "" : isBusy(f) ? "The transcript will appear here when it's ready." :
        f.status === "error" ? "Transcription failed. Check the model and try again." :
        "No transcript yet. Pick a model above and click Transcribe.";
      box.append(el("div", "seg-empty", msg));
      renderFlags(); renderSpeakers(); return;
    }
    const frag = document.createDocumentFragment();
    const hasSpk = Object.keys(S.speakers).length > 0;
    S.segs.forEach((s, i) => {
      const turnStart = hasSpk && (i === 0 || S.segs[i - 1].speaker !== s.speaker);
      const row = el("div", "seg" + (turnStart ? " turn" : ""));
      row.dataset.i = i;
      if (s.speaker) { row.dataset.spk = s.speaker; row.style.setProperty("--spk", spkColor(s.speaker)); }
      const left = el("div", "seg-left");
      if (hasSpk) {
        const chip = el("button", "spk-chip" + (turnStart ? "" : " minor"), s.speaker ? spkName(s.speaker) : "Unassigned");
        if (s.speaker) chip.dataset.spk = s.speaker;
        chip.title = "Change speaker";
        chip.onclick = (e) => { e.stopPropagation(); showSpkMenu(i, chip, turnStart); };
        left.append(chip);
      }
      const t = el("button", "seg-time", fmt(s.start));
      t.title = `${fmt(s.start, true)} → ${fmt(s.end, true)} · click to play`;
      t.onclick = () => seekTo(s.start, true);
      left.append(t);
      if (s.edited) left.append(el("span", "seg-edited", "edited"));
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
      row.append(left, txt, side);
      frag.append(row);
      decorateRow(row, s);
    });
    box.append(frag);
    box.scrollTop = scroll;
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

  // ---- editing
  const segBox = $("segments");
  segBox.addEventListener("input", (e) => {
    const txt = e.target.closest(".seg-text");
    if (!txt) return;
    const row = txt.parentElement;
    const s = S.segs[+row.dataset.i];
    s.text = txt.textContent.replace(/\n/g, " ");
    if (!s.edited) {
      s.edited = true;
      row.querySelector(".seg-left").append(el("span", "seg-edited", "edited"));
    }
    if (!s.reviewed) { s.reviewed = true; decorateRow(row, s); renderFlags(); }
    queueSave();
    pauseForTyping();
  });
  segBox.addEventListener("focusout", (e) => {
    const txt = e.target.closest(".seg-text");
    if (!txt || !txt.isConnected) return;
    const s = S.segs[+txt.parentElement.dataset.i];
    if (!s) return;
    if (s.edited && s.words && s.words.length && !wordsMatch(s)) s.words = [];
    fillText(txt, s);
    if (+txt.parentElement.dataset.i === S.activeIdx) { S.activeWord = -2; updateActive(); }
  });
  segBox.addEventListener("keydown", (e) => {
    const txt = e.target.closest(".seg-text");
    if (!txt) return;
    const i = +txt.parentElement.dataset.i;
    if (e.key === "Enter") {
      e.preventDefault();
      const next = rowEl(i + 1);
      if (next) placeCaret(next.querySelector(".seg-text"), Infinity); else txt.blur();
    } else if (e.key === "Escape") txt.blur();
    else if (e.key === "Backspace" && i > 0 && caretOffset(txt) === 0 && !getSelection().toString()) {
      e.preventDefault(); mergeWithPrevious(i);
    } else if (e.altKey && e.code === "KeyS") {
      e.preventDefault(); e.stopPropagation(); splitAt(i, caretOffset(txt));
    }
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
      const word = displayWords(s)[+w.dataset.i];
      seekTo(word?.s ?? s.start, true);
    }
  });

  function caretOffset(node) {
    const sel = getSelection();
    if (!sel.rangeCount || !node.contains(sel.anchorNode)) return -1;
    const r = sel.getRangeAt(0).cloneRange();
    r.selectNodeContents(node);
    r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
    return r.toString().length;
  }
  function placeCaret(node, offset) {
    node.focus();
    const sel = getSelection();
    const r = document.createRange();
    let remaining = offset, placed = false;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = walker.nextNode())) {
      if (remaining <= t.length) { r.setStart(t, remaining); placed = true; break; }
      remaining -= t.length;
    }
    if (!placed) { r.selectNodeContents(node); r.collapse(false); }
    sel.removeAllRanges(); sel.addRange(r);
  }

  function nextId() { return S.segs.reduce((m, s) => Math.max(m, s.id), -1) + 1; }
  function splitAt(i, offset) {
    const s = S.segs[i];
    const text = s.text;
    if (offset <= 0 || offset >= text.length) { toast("Place the cursor inside the text to split"); return; }
    const a = text.slice(0, offset).trimEnd(), b = text.slice(offset).trimStart();
    if (!a || !b) return;
    // split time at the matching word boundary if timings exist, else proportionally
    const words = displayWords(s);
    let acc = 0, cut = s.start + (s.end - s.start) * (offset / text.length), wi = words.length;
    for (let k = 0; k < words.length; k++) {
      acc += (k === 0 ? words[k].w.trimStart() : words[k].w).length;
      if (acc >= offset) { wi = k + 1; cut = words[k + 1]?.s ?? cut; break; }
    }
    const matched = wordsMatch(s);
    const first = { ...s, text: a, end: cut, edited: true, words: matched ? s.words.slice(0, wi) : [] };
    const second = { ...s, id: nextId(), text: b, start: cut, edited: true, words: matched ? s.words.slice(wi) : [] };
    delete first._ew; delete second._ew;
    S.segs.splice(i, 1, first, second);
    renderSegments(); queueSave();
    placeCaret(rowEl(i + 1).querySelector(".seg-text"), 0);
  }
  function mergeWithPrevious(i) {
    const prev = S.segs[i - 1], cur = S.segs[i];
    const joinAt = prev.text.length + 1;
    const merged = {
      ...prev, text: (prev.text + " " + cur.text).trim(), end: Math.max(prev.end, cur.end), edited: true,
      words: wordsMatch(prev) && wordsMatch(cur) ? prev.words.concat(cur.words) : [],
      reviewed: prev.reviewed && cur.reviewed,
      issues: [...new Set([...(prev.issues || []), ...(cur.issues || [])])],
      low_words: [...(prev.low_words || []), ...(cur.low_words || [])],
      confidence: prev.confidence == null ? cur.confidence : cur.confidence == null ? prev.confidence : Math.min(prev.confidence, cur.confidence),
    };
    delete merged._ew;
    S.segs.splice(i - 1, 2, merged);
    renderSegments(); queueSave();
    placeCaret(rowEl(i - 1).querySelector(".seg-text"), joinAt);
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

  $("searchInput").addEventListener("input", (e) => {
    S.search = e.target.value.trim();
    S.segs.forEach((s, i) => { const r = rowEl(i); if (r) { fillText(r.querySelector(".seg-text"), s); decorateRow(r, s); } });
    S.activeWord = -2;
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
  function serialize() {
    return {
      segments: S.segs.map((s) => ({
        id: s.id, start: s.start, end: s.end, text: s.text, speaker: s.speaker ?? null,
        reviewed: !!s.reviewed, edited: !!s.edited, words: s.words || [],
        confidence: s.confidence ?? null, issues: s.issues || [], low_words: s.low_words || [],
      })),
      speakers: S.speakers,
    };
  }
  async function save() {
    if (!S.current || !S.pendingSave) return;
    if (S.saving) { S.saveTimer = setTimeout(save, 300); return; }
    S.saving = true; S.pendingSave = false;
    $("saveState").textContent = "Saving…";
    const id = S.current.id;
    try {
      await api(`/api/files/${id}/transcript`, { method: "PUT", body: JSON.stringify(serialize()) });
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
      top.append(el("span", null, `${fmt(s.start)} – ${fmt(s.end)}${s.speaker ? " · " + spkName(s.speaker) : ""}`),
        el("span", "flag-conf", s.confidence == null ? "?" : Math.round(s.confidence * 100) + "%"));
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
    seekTo(Math.max(0, S.segs[i].start - 0.6), true);
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
    if (!audio.getAttribute("src")) return;
    audio.currentTime = Math.max(0, Math.min(t, audio.duration || t));
    if (play) audio.play().catch(() => {});
    updateActive(true);
    drawWave();
  }
  function togglePlay() {
    if (!audio.getAttribute("src")) return;
    S.resumeAfterTyping = false; clearTimeout(S.typingTimer);
    if (audio.paused) audio.play().catch((e) => toast(e.message, true)); else audio.pause();
  }
  $("playBtn").onclick = togglePlay;
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

  function setWordClasses(row, wi) {
    if (!row) return;
    row.querySelectorAll(".seg-text .w").forEach((n) => {
      const k = +n.dataset.i;
      n.classList.toggle("past", k < wi);
      n.classList.toggle("now", k === wi);
    });
  }

  let lastScroll = 0;
  function updateActive(force = false) {
    const t = audio.currentTime || 0;
    $("curTime").textContent = fmt(t);
    const i = findSeg(t);
    if (i !== S.activeIdx || force) {
      const old = rowEl(S.activeIdx);
      if (old) { old.classList.remove("active"); setWordClasses(old, -1); }
      S.activeIdx = i;
      S.activeWord = -2;
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
    // karaoke-style word highlight
    const s = S.segs[i];
    let wi = -1;
    if (s && !S.search) {
      const words = displayWords(s);
      if (t > s.end + 0.4) wi = words.length; // between segments: all spoken
      else for (let k = 0; k < words.length; k++) { if (words[k].s != null && words[k].s <= t) wi = k; else if (words[k].s > t) break; }
    }
    if (wi !== S.activeWord) {
      S.activeWord = wi;
      setWordClasses(rowEl(i), wi);
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

    // speaker lanes along the top
    if (Object.keys(S.speakers).length) {
      for (const s of S.segs) {
        if (!s.speaker) continue;
        ctx.fillStyle = spkColor(s.speaker);
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x(s.start), 0, Math.max(1, x(s.end) - x(s.start)), 3);
      }
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = waveColors.warn;
    for (const i of S.flagged) {
      const s = S.segs[i];
      ctx.globalAlpha = 0.16;
      ctx.fillRect(x(s.start), 4, Math.max(2, x(s.end) - x(s.start)), h - 4);
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x(s.start), h - 3, Math.max(2, x(s.end) - x(s.start)), 3);
    }
    ctx.globalAlpha = 1;
    const act = S.segs[S.activeIdx];
    if (act) { ctx.fillStyle = waveColors.a; ctx.globalAlpha = 0.1; ctx.fillRect(x(act.start), 4, x(act.end) - x(act.start), h - 4); ctx.globalAlpha = 1; }

    const progress = x(audio.currentTime || 0);
    const bar = 2, gap = 1, n = Math.floor(w / (bar + gap));
    const mid = h / 2;
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, waveColors.a); grad.addColorStop(1, waveColors.b);
    const peaks = S.peaks;
    for (let k = 0; k < n; k++) {
      let p = 0.04;
      if (peaks.length) {
        const a = Math.floor((k / n) * peaks.length), b = Math.max(a + 1, Math.floor(((k + 1) / n) * peaks.length));
        for (let j = a; j < b && j < peaks.length; j++) p = Math.max(p, peaks[j]);
      }
      const bh = Math.max(1.5, p * (mid - 8));
      const bx = k * (bar + gap);
      ctx.fillStyle = bx < progress ? grad : waveColors.wave;
      ctx.fillRect(bx, mid - bh, bar, bh * 2);
    }
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
    const t = ((e.clientX - r.left) / r.width) * dur;
    const hov = $("waveHover");
    hov.style.left = e.clientX - r.left + "px";
    const i = findSeg(t);
    const spk = S.segs[i]?.speaker && t <= S.segs[i].end + 0.5 ? " · " + spkName(S.segs[i].speaker) : "";
    hov.textContent = fmt(t) + spk;
  });
  new ResizeObserver(() => drawWave()).observe(waveWrap);
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { waveColors = null; drawWave(); });

  // ------------------------------------------------------------------ keyboard
  document.addEventListener("keydown", (e) => {
    const inField = e.target.closest("input, select, [contenteditable=true]");
    if (e.key === "Escape") hideSpkMenu();
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
