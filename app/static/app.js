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
    voices: [],
    stopAt: null,
    pausedByFocus: false,
    markers: [],
    ctx: null, // pending redaction target
    tr: null, // trainer state
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
  function toast(msg, isError = false, action = null) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast show" + (isError ? " error" : "") + (action ? " has-action" : "");
    if (action) {
      const b = el("button", "toast-action", action.label);
      b.onclick = () => { t.className = "toast"; action.fn(); };
      t.append(b);
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = "toast"), isError ? 6000 : action ? 8000 : 2600);
  }
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    });
    if (res.status === 401) {
      location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.hash);
      throw new Error("Please sign in");
    }
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
  const ICON_COPY = '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>';
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
      const local = new Set(c.local_models || []);
      for (const m of models) sel.append(new Option(local.has(m) ? `${m} (built-in)` : m, m, false, m === saved));
      $("languageInput").value = store.get("language", c.default_language || "");
      $("autoToggle").checked = store.get("auto", c.auto_transcribe);
      $("wizToggle").checked = store.get("wizard", true);
      $("autoToggleWrap").classList.toggle("hidden", $("wizToggle").checked);
      $("speakersField").classList.toggle("hidden", !c.diarization_available);
      const spk = store.get("speakers", c.diarization_default || "auto");
      $("speakersSelect").value = [...$("speakersSelect").options].some((o) => o.value === spk) ? spk : "auto";
      $("threshold").value = S.threshold;
      $("thresholdVal").textContent = Math.round(S.threshold * 100) + "%";
      if (c.backend_error) {
        status.className = "backend err";
        status.querySelector(".label").textContent = (c.local_models || []).length ? "llama-swap unreachable · built-in OK" : "llama-swap unreachable";
        status.title = c.backend_error;
      } else {
        status.className = "backend ok";
        status.querySelector(".label").textContent = `llama-swap · ${c.remote_count ?? c.models.length} models`;
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
  $("wizToggle").onchange = (e) => { store.set("wizard", e.target.checked); $("autoToggleWrap").classList.toggle("hidden", e.target.checked); };
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
      if (f.status === "done" && !f.error) {
        if (prev.status !== "diarizing" && teachPending(f)) teachAfter(f);
        else if (S.pendingSounds === f.id) {
          S.pendingSounds = null;
          const c = Object.entries(f.sounds || {}).sort((a, b) => b[1] - a[1]);
          toast(c.length ? `Found ${c.map(([l, n]) => `${n} ${l.toLowerCase()}`).join(", ")}` : "No laughs, coughs or other sounds found", false,
            { label: "Show stats", fn: () => $("statsBtn").click() });
        }
        else toast(prev.status === "diarizing" ? speakerToast(f) : "Transcription finished");
      }
      if (prev.status === "diarizing") loadVoices();
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
      const acts = el("div", "factions");
      const dup = el("button", "fdel fdup"); dup.title = "Duplicate (keeps this one untouched, e.g. to try another model)"; dup.append(svg(ICON_COPY));
      dup.onclick = (e) => { e.stopPropagation(); duplicateFile(f); };
      const del = el("button", "fdel"); del.title = "Delete"; del.append(svg(ICON_TRASH));
      del.onclick = (e) => { e.stopPropagation(); deleteFiles([f.id]); };
      acts.append(dup, del);
      li.append(lead, body, S.selectMode ? el("span") : acts);
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
    const guided = $("wizToggle").checked;
    fd.append("auto", !guided && $("autoToggle").checked ? "true" : "false");
    if (guided) wizAdd(tid, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files");
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = e.loaded / e.total;
      S.uploads.get(tid).progress = p;
      if (S.wiz?.items.has(tid)) wizRender();
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
        if (guided) await wizUploaded(tid, meta.id);
        if (!S.current || guided) openFile(meta.id);
      } else {
        let msg = xhr.statusText;
        try { msg = JSON.parse(xhr.responseText).detail; } catch { /* ignore */ }
        toast(`Upload failed: ${msg}`, true);
        wizDrop(tid);
        renderFiles();
      }
      schedulePoll();
    };
    xhr.onerror = () => { S.uploads.delete(tid); wizDrop(tid); renderFiles(); toast("Upload failed: network error", true); };
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
    S.transcript = null; S.segs = []; S.speakers = {}; S.markers = [];
    S.activeIdx = -1; S.activeWord = -1; S.flagCursor = -1; S.peaks = [];
    renderMarkers();
    history.replaceState(null, "", "#" + id);
    $("emptyState").classList.add("hidden");
    $("workspace").classList.remove("hidden");
    renderFiles(); renderHeader(); renderSegments();
    loadAudio();
    if (f.has_transcript) await loadTranscript();
    if (f.status === "done" && teachPending(f)) teachAfter(f);
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
    const src = `/api/files/${f.id}/audio?v=${f.audio_version || 0}`;
    if (!audio.src.endsWith(src)) {
      audio.src = src;
      audio.playbackRate = parseFloat($("rateSelect").value);
    }
    try { S.peaks = await api(`/api/files/${f.id}/peaks`); } catch { S.peaks = []; }
    drawWave();
    renderMarkers();
  }

  async function loadTranscript() {
    try {
      S.transcript = await api(`/api/files/${S.current.id}/transcript`);
      S.segs = S.transcript.segments;
      S.speakers = S.transcript.speakers || {};
      S.markers = S.transcript.markers || [];
    } catch { S.transcript = null; S.segs = []; S.speakers = {}; S.markers = []; }
    renderHeader(); renderSegments(); renderSpeakers(); renderMarkers();
    loadVersions(); loadSounds();
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
    const dev = isBusy(f) ? f.progress?.device : (f.status === "done" ? f.device : null);
    if (dev) {
      const tag = el("span", "dev-tag dev-" + dev.kind.toLowerCase().replace(/[^a-z]/g, ""), dev.kind);
      tag.title = (dev.name || dev.kind) + (dev.why ? `\nWhy not GPU: ${dev.why}` : "");
      meta.append(tag);
    }
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
    $("stopBtn").classList.toggle("hidden", !busy || f.status === "processing");
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
      $("procTitle").textContent = p.stage === "voices" ? "Matching voices…" : p.stage === "sounds" ? "Listening for laughs, coughs…" : "Detecting speakers…";
      $("procDetail").textContent = `${fmt(f.elapsed || 0)} elapsed · ${p.label || "runs on the server CPU"}`;
    } else {
      const dv = p.device;
      $("procTitle").textContent = `Transcribing with ${f.model || "model"}${dv ? (dv.kind === "llama-swap" ? " via llama-swap" : ` on ${dv.kind}`) : ""}…`;
      $("procTitle").title = dv?.name || "";
      if (dv?.kind === "CPU" && dv.why) $("procTitle").textContent += ` (no GPU: ${dv.why})`;
      let detail = `${fmt(f.elapsed || 0)} elapsed`;
      if (p.label) detail += ` · ${p.label}`;
      else if (p.stage === "speakers") detail += " · matching speakers to text";
      else if (p.eta != null && p.done < p.total) detail += ` · about ${fmt(p.eta)} left`;
      else if (!p.done) detail += (S.config?.local_models || []).includes(f.model) ? " · loading the model" : " · llama-swap may need to load the model first";
      $("procDetail").textContent = detail;
      if (p.download != null) addBar(bars, "Model download", p.download, Math.round(p.download * 100) + "%");
      if (p.total) addBar(bars, "Transcription", p.done / p.total, `${Math.floor(p.done)}/${p.total}`);
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

  $("transcribeBtn").onclick = () => openReprocess();

  $("stopBtn").onclick = async () => {
    const f = S.current;
    if (!f || !isBusy(f)) return;
    const what = f.status === "diarizing" ? "speaker detection" : f.status === "queued" ? "this queued job" : "this transcription";
    if (f.status !== "queued" && !confirm(`Stop ${what}? Progress so far is discarded${f.has_transcript ? "; the previous transcript is kept" : ""}.`)) return;
    $("stopBtn").disabled = true;
    $("stopBtn").textContent = "Stopping…";
    try {
      S.current = await api(`/api/files/${f.id}/cancel`, { method: "POST" });
      if (S.current.has_transcript) await loadTranscript(); else renderSegments();
      renderHeader();
      await loadFiles(); schedulePoll();
      toast(isBusy(S.current) ? "Stopping…" : "Stopped");
    } catch (e) { toast(e.message, true); }
    finally { $("stopBtn").textContent = "Stop"; $("stopBtn").disabled = false; }
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
      S.segs = S.transcript.segments; S.speakers = S.transcript.speakers || {}; S.markers = S.transcript.markers || [];
      renderSegments(); renderSpeakers(); renderMarkers(); toast("Transcript restored");
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
    card.classList.toggle("hidden", !S.segs.length || (!ids.length && !S.config?.diarization_available));
    $("teachBtn").classList.toggle("hidden", !S.config?.diarization_available || !S.current?.has_audio);
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
      const stat = el("small", null, `${fmt(talk[id] || 0)} · ${total ? Math.round(((talk[id] || 0) / total) * 100) : 0}%`);
      if (hasVoice(spkName(id))) { const b = el("span", "voice-badge", "VOICE SAVED"); b.title = "This voice is remembered and recognized in future files"; stat.prepend(b, document.createElement("br")); }
      li.append(sw, box, stat);
      list.append(li);
    }
    if (!ids.length) list.append(el("li", "muted", "No speakers yet. Click Teach to tag who's talking."));
    const foot = $("spkFoot");
    foot.innerHTML = "";
    const tagged = S.segs.filter((s) => s.spk_locked).length;
    const unsure = S.segs.filter((s) => (s.issues || []).some((x) => x.startsWith("Not sure who"))).length;
    const last = S.current?.last_identify;
    const upToDate = last && last.sig && last.sig === correctionsSig();
    const missing = ids.filter((id) => !S.segs.some((x) => x.spk_locked && x.speaker === id) && !hasVoice(spkName(id)));
    if (tagged && ids.length >= 2 && S.current?.has_audio && S.config?.diarization_available && !upToDate && missing.length) {
      foot.append(el("small", "id-need", `To re-label the whole file by voice, also tag at least one line for ${missing.map(spkName).join(", ")} (click a speaker chip, or use Teach).`));
    }
    if (tagged && ids.length >= 2 && S.current?.has_audio && S.config?.diarization_available && !upToDate && !missing.length) {
      const b = el("button", "btn sm primary", `Update all from my corrections (${tagged})`);
      b.title = "Re-label every line by voice, using the lines you've tagged or corrected as examples";
      b.onclick = () => runIdentify(true);
      foot.append(b);
      foot.append(el("small", null, `Uses the ${tagged} line${tagged > 1 ? "s" : ""} you tagged or fixed as voice examples, re-labels every other line by voice, and remembers the voices for future files.`));
    }
    if (last && last.at) {
      const ago = Math.max(0, Date.now() / 1000 - last.at);
      const when = ago < 90 ? "just now" : ago < 3600 ? `${Math.round(ago / 60)} min ago` : new Date(last.at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const box = el("div", "id-summary" + (upToDate ? " ok" : ""));
      box.append(el("b", null, upToDate ? "✓ Up to date with your corrections" : "Last voice update"));
      box.append(el("span", null, `${when[0].toUpperCase() + when.slice(1)}` + (last.examples ? `, from ${last.examples} example${last.examples > 1 ? "s" : ""}` : "") +
        `: ${last.changed ? `${last.changed} line${last.changed > 1 ? "s" : ""} relabeled (marked ↻)` : "every line already matched, nothing changed"}` +
        (last.unsure ? `, ${last.unsure} unclear (in Needs review)` : "") + "."));
      const marked = S.segs.filter((x) => x.spk_changed).length;
      if (marked) {
        const nav = el("button", "linklike", `Show relabeled lines (${marked})`);
        nav.onclick = () => { const k = S.segs.findIndex((x, j) => x.spk_changed && j > S.relabelCursor) ; const j = k >= 0 ? k : S.segs.findIndex((x) => x.spk_changed); S.relabelCursor = j; rowEl(j)?.scrollIntoView({ block: "center" }); rowEl(j)?.classList.add("flash"); setTimeout(() => rowEl(j)?.classList.remove("flash"), 1200); };
        const clear = el("button", "linklike", "Clear highlights");
        clear.onclick = () => { S.segs.forEach((x) => delete x.spk_changed); renderSegments(); renderSpeakers(); queueSave(); };
        const row = el("div", "id-links"); row.append(nav, clear); box.append(row);
      }
      foot.append(box);
    }
    if (unsure) foot.append(el("small", null, `${unsure} line${unsure > 1 ? "s" : ""} where the speaker is unclear are in Needs review. Fixing them teaches it more.`));
  }
  const hasVoice = (name) => !!name && S.voices.some((v) => v.name.trim().toLowerCase() === name.trim().toLowerCase());
  async function loadVoices() {
    try { S.voices = await api("/api/voices"); } catch { S.voices = []; }
    renderSpeakers();
  }
  function speakerToast(f) {
    const r = f.last_identify;
    if (r && Date.now() / 1000 - r.at < 60) return `Speakers updated: ${r.changed} line${r.changed === 1 ? "" : "s"} relabeled` + (r.unsure ? `, ${r.unsure} unclear` : "");
    return "Speakers updated";
  }
  function correctionsSig() {
    let h = 5381;
    for (const s of S.segs) if (s.spk_locked) for (const c of `${s.id}:${s.speaker};`) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
    return h.toString(36);
  }
  async function runIdentify(remember) {
    try {
      await flushSave();
      S.relabelCursor = -1;
      S.current = await api(`/api/files/${S.current.id}/identify`, { method: "POST", body: JSON.stringify({ remember, sig: correctionsSig() }) });
      renderHeader(); await loadFiles(); schedulePoll();
    } catch (e) { toast(e.message, true); }
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
  function hideSpkMenu() {
    const t = S.spkTarget != null ? S.segs[S.spkTarget] : null;
    $("spkMenu").classList.add("hidden"); S.spkTarget = null;
    if (t?._new && !t.text.trim()) dropEmptyInserted(t.id);
  }
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
    for (let k = a; k <= b; k++) {
      const s = S.segs[k];
      s.speaker = id; s.spk_locked = true; s.spk_conf = 1; delete s.spk_changed;
      s.issues = (s.issues || []).filter((x) => !x.startsWith("Not sure who"));
    }
    if (S.segs[i]?._new) S.focusSegId = S.segs[i].id;  // keep typing in the inserted line
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

  const REDACTED = "[REDACTED]";
  const TOKEN_RE = /\[REDACTED(?::([a-z0-9]{6,16}))?\]/g;
  const isToken = (s) => /^\[REDACTED(?::[a-z0-9]{6,16})?\]$/.test(s);
  /** Wrap every redaction token in an atomic, non-editable bar (the token text stays in the DOM, hidden). */
  function markRedactions(node) {
    if (!node.textContent.includes("[REDACTED")) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const texts = [];
    let t;
    while ((t = walker.nextNode())) if (t.data.includes("[REDACTED") && !t.parentElement.classList.contains("redacted")) texts.push(t);
    for (const tn of texts) {
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (const m of tn.data.matchAll(TOKEN_RE)) {
        if (m.index > pos) frag.append(document.createTextNode(tn.data.slice(pos, m.index)));
        const rid = m[1];
        const live = rid && S.transcript?.redactions?.[rid];
        const bar = el("span", "redacted" + (live ? "" : " final"), m[0]);
        bar.contentEditable = "false";
        if (live) { bar.dataset.rid = rid; bar.title = "Redacted · click to unredact (right-click for more)"; }
        else bar.title = "Permanently redacted · click to recover the words from the audio";
        frag.append(bar);
        pos = m.index + m[0].length;
      }
      if (pos < tn.data.length) frag.append(document.createTextNode(tn.data.slice(pos)));
      tn.replaceWith(frag);
    }
  }

  function fillText(node, s) {
    fillTextInner(node, s);
    markRedactions(node);
  }
  function fillTextInner(node, s) {
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
    const mks = sortedMarkers();
    let mi = 0;
    const divider = (m) => {
      const d = el("div", "mk-divider");
      d.style.setProperty("--mk", m.color);
      d.append(document.createTextNode(m.label || "Marker"), el("span", "mk-dtime", m.end != null ? `${fmt(m.t)}–${fmt(m.end)}` : fmt(m.t)));
      d.onclick = () => seekTo(m.t, true);
      return d;
    };
    S.segs.forEach((s, i) => {
      while (mi < mks.length && mks[mi].t <= s.start + 0.05) frag.append(divider(mks[mi++]));
      const turnStart = hasSpk && (i === 0 || S.segs[i - 1].speaker !== s.speaker);
      const row = el("div", "seg" + (turnStart ? " turn" : "") + (s.spk_changed ? " relabeled" : ""));
      row.dataset.i = i;
      if (s.speaker) { row.dataset.spk = s.speaker; row.style.setProperty("--spk", spkColor(s.speaker)); }
      const left = el("div", "seg-left");
      if (hasSpk) {
        const unsure = !s.spk_locked && s.spk_conf != null && s.spk_conf < 0.08;
        const chip = el("button", "spk-chip" + (turnStart && !unsure ? "" : unsure ? " unsure" : " minor"), s.speaker ? spkName(s.speaker) : "Unassigned");
        if (s.speaker) chip.dataset.spk = s.speaker;
        chip.title = s.spk_locked ? "Tagged by you · click to change" : unsure ? "Not sure who this is · click to set" : "Change speaker";
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
      if (s._new && !s.text) txt.dataset.placeholder = "Type what was said…";
      const ins = el("button", "seg-insert", "+");
      ins.title = "Insert a missed line here";
      ins.onclick = (e) => { e.stopPropagation(); insertLine(i); };
      row.append(left, txt, side, ins);
      if (i === S.segs.length - 1) {
        const after = el("button", "seg-insert after", "+");
        after.title = "Add a line at the end";
        after.onclick = (e) => { e.stopPropagation(); insertLine(i + 1); };
        row.append(after);
      }
      frag.append(row);
      decorateRow(row, s);
    });
    while (mi < mks.length) frag.append(divider(mks[mi++]));
    box.append(frag);
    box.scrollTop = scroll;
    renderFlags();
    updateActive(true);
    if (S.sounds?.events?.length) markSoundRows();
    if (S.focusSegId != null) {  // a line was just inserted (or its speaker set): keep typing in it
      const k = S.segs.findIndex((x) => x.id === S.focusSegId);
      S.focusSegId = null;
      if (k >= 0) placeCaret(rowEl(k).querySelector(".seg-text"), Infinity);
    }
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

  function rowEl(i) {  // cached index -> row element (a querySelector per call is O(lines))
    const r = S.rowEls && S.rowEls[i];
    if (r && r.isConnected && +r.dataset.i === i) return r;
    S.rowEls = [];
    for (const el of $("segments").querySelectorAll(".seg")) S.rowEls[+el.dataset.i] = el;
    return S.rowEls[i] || null;
  }

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
  segBox.addEventListener("focusin", (e) => {
    if (!e.target.closest(".seg-text") || !$("typingToggle").checked) return;
    if (!audio.paused && S.stopAt == null) {
      audio.pause();
      S.pausedByFocus = true;
      S.resumeAfterTyping = false; clearTimeout(S.typingTimer);
    }
  });
  segBox.addEventListener("focusout", (e) => {
    const txt = e.target.closest(".seg-text");
    if (!txt || !txt.isConnected) return;
    const s = S.segs[+txt.parentElement.dataset.i];
    if (!s) return;
    if (s._new) { if (!s.text.trim()) { dropEmptyInserted(s.id); return; } delete s._new; }
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
    } else if (e.key === "Escape") {
      txt.blur();
      if (S.pausedByFocus && audio.paused) {
        S.pausedByFocus = false;
        audio.currentTime = Math.max(0, audio.currentTime - 1);
        audio.play().catch(() => {});
      }
    } else if (e.altKey && e.code === "KeyX") {
      e.preventDefault(); e.stopPropagation(); redactSelection(false, false);
    } else if (e.key === "Backspace" && i > 0 && caretOffset(txt) === 0 && !getSelection().toString()) {
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
  // Insert a missed line before index i, timed in the gap between its neighbours.
  function insertLine(i) {
    if (isBusy(S.current)) { toast("Wait for the current job to finish", true); return; }
    const prev = S.segs[i - 1], next = S.segs[i];
    let start, end;
    if (prev && next) {
      if (next.start - prev.end >= 0.2) { start = prev.end; end = next.start; }  // fill the pause between them
      else { start = Math.max((prev.start + next.start) / 2, next.start - 0.05); end = next.start + 0.6; }  // no pause: sit on the boundary
    } else if (next) {
      start = Math.max(0, next.start - 2); end = next.start;
    } else {
      start = prev ? prev.end : 0; end = start + 2;
    }
    if (S.current?.duration) { start = Math.min(start, S.current.duration); end = Math.min(Math.max(end, start + 0.2), S.current.duration); }
    // likely speaker: the other person when both neighbours are the same speaker
    const ids = Object.keys(S.speakers);
    let spk = prev?.speaker ?? next?.speaker ?? ids[0] ?? null;
    if (prev && next && prev.speaker && prev.speaker === next.speaker && ids.length === 2) spk = ids.find((x) => x !== prev.speaker);
    else if (prev && next && prev.speaker !== next.speaker) spk = next.speaker;
    const seg = { id: nextId(), start: +start.toFixed(3), end: +end.toFixed(3), text: "", speaker: spk, edited: true, reviewed: true,
      words: [], issues: [], low_words: [], confidence: null, _new: true, ...(spk ? { spk_locked: true } : {}) };
    S.segs.splice(i, 0, seg);
    S.focusSegId = seg.id;
    renderSegments();
    const row = rowEl(i);
    if (ids.length) showSpkMenu(i, row.querySelector(".spk-chip") || row, false);
  }
  function dropEmptyInserted(id) {
    setTimeout(() => {
      const k = S.segs.findIndex((x) => x.id === id);
      if (k < 0) return;
      const s = S.segs[k];
      const row = rowEl(k);
      if (!s._new || s.text.trim() || S.spkTarget === k || (row && row.contains(document.activeElement))) return;
      S.segs.splice(k, 1);
      renderSegments(); queueSave();
    }, 250);
  }
  function splitAt(i, offset, askSpeaker = false) {
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
    if (askSpeaker && Object.keys(S.speakers).length) {  // who says the second part?
      const row = rowEl(i + 1);
      row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 1200);
      const chip = row.querySelector(".spk-chip");
      if (chip) showSpkMenu(i + 1, chip, false);
    }
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

  // Search: debounced, and only lines whose highlighting changes are rebuilt (others just dim/undim).
  let searchTimer = null;
  S.searchHits = new Set();
  function applySearch() {
    S.search = $("searchInput").value.trim();
    const q = S.search.toLowerCase();
    const hits = new Set();
    if (q) S.segs.forEach((s, i) => { if (s.text.toLowerCase().includes(q)) hits.add(i); });
    rowEl(0);  // refresh the row cache once
    const rows = S.rowEls || [];
    const editing = document.activeElement?.closest?.(".seg-text");
    S.segs.forEach((s, i) => {
      const r = rows[i];
      if (!r) return;
      r.classList.toggle("dim", !!q && !hits.has(i));
      if ((hits.has(i) || S.searchHits.has(i)) && r.querySelector(".seg-text") !== editing) fillText(r.querySelector(".seg-text"), s);
    });
    S.searchHits = hits;
    S.activeWord = -2;
    // every occurrence, in order: [line index, nth mark in that line]
    S.matches = [];
    for (const i of [...hits].sort((a, b) => a - b)) {
      const n = rows[i] ? rows[i].querySelectorAll(".seg-text mark").length : 0;
      for (let k = 0; k < Math.max(1, n); k++) S.matches.push([i, k]);
    }
    $("searchNav").classList.toggle("hidden", !q);
    if (!S.matches.length) { S.matchIdx = -1; updateSearchCount(); return; }
    // start at the first match at or after the line being played / viewed
    const from = Math.max(0, S.activeIdx);
    const k = S.matches.findIndex(([i]) => i >= from);
    gotoMatch(k >= 0 ? k : 0);
  }
  function updateSearchCount() {
    const n = (S.matches || []).length;
    $("searchCount").textContent = n ? `${S.matchIdx + 1} / ${n}` : "0 / 0";
    $("searchCount").classList.toggle("none", !n);
    $("searchPrev").disabled = $("searchNext").disabled = n < 2;
  }
  function gotoMatch(k) {
    const m = S.matches || [];
    if (!m.length) return;
    S.matchIdx = ((k % m.length) + m.length) % m.length;
    document.querySelectorAll(".seg-text mark.cur").forEach((x) => x.classList.remove("cur"));
    const [i, nth] = m[S.matchIdx];
    const row = rowEl(i);
    const mark = row?.querySelectorAll(".seg-text mark")[nth];
    if (mark) mark.classList.add("cur");
    (mark || row)?.scrollIntoView({ block: "center" });
    updateSearchCount();
  }
  $("searchNext").onclick = () => gotoMatch((S.matchIdx ?? -1) + 1);
  $("searchPrev").onclick = () => gotoMatch((S.matchIdx ?? 0) - 1);
  $("searchInput").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applySearch, S.segs.length > 300 ? 180 : 60);
  });
  $("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const pending = $("searchInput").value.trim() !== S.search;
      clearTimeout(searchTimer); searchTimer = null;
      if (pending) applySearch(); else gotoMatch((S.matchIdx ?? -1) + (e.shiftKey ? -1 : 1));
    } else if (e.key === "Escape" && $("searchInput").value) {
      e.preventDefault(); e.stopPropagation();
      $("searchInput").value = ""; applySearch();
    }
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
        ...(s.spk_locked ? { spk_locked: true } : {}), ...(s.spk_conf != null ? { spk_conf: s.spk_conf } : {}),
        ...(s.spk_changed ? { spk_changed: true } : {}),
      })),
      speakers: S.speakers,
      markers: S.markers.map(({ id, t, end, label, color }) => ({ id, t, end: end ?? null, label, color })),
    };
  }
  async function save() {
    if (!S.current || !S.pendingSave || !S.transcript) return;
    if (isBusy(S.current)) { S.saveTimer = setTimeout(save, 2000); return; }
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
  function seekTo(t, play = false, reveal = false) {
    if (!audio.getAttribute("src")) return;
    audio.currentTime = Math.max(0, Math.min(t, audio.duration || t));
    if (play) audio.play().catch(() => {});
    updateActive(true);
    if (reveal) revealActive();
    drawWave();
  }
  /** Scroll the line at the playhead into view (timeline clicks), even while paused. */
  function revealActive() {
    const row = rowEl(S.activeIdx);
    if (!row || document.activeElement?.classList?.contains("seg-text")) return;
    const box = $("segments");
    const rb = row.getBoundingClientRect(), bb = box.getBoundingClientRect();
    if (rb.top < bb.top + 40 || rb.bottom > bb.bottom - 40) row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 1200);
    lastScroll = Date.now();
  }
  function togglePlay() {
    if (!audio.getAttribute("src") || S.tr) return;
    S.stopAt = null;
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
  audio.addEventListener("play", () => { $("playIcon").innerHTML = PAUSE; S.pausedByFocus = false; tick(); });
  audio.addEventListener("pause", () => { $("playIcon").innerHTML = PLAY; drawWave(); if (S.tr) trPlaying(null); });
  audio.addEventListener("loadedmetadata", () => { $("durTime").textContent = fmt(audio.duration); drawWave(); });
  audio.addEventListener("timeupdate", () => { if (audio.paused) { updateActive(); drawWave(); } });
  audio.addEventListener("error", () => { if (audio.getAttribute("src")) toast("Could not load audio", true); });

  function tick() {
    if (S.stopAt != null && audio.currentTime >= S.stopAt) { audio.pause(); S.stopAt = null; trPlaying(null); }
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
    const lane = S.markers.length ? 16 : 0;
    const mid = lane + (h - lane) / 2;
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, waveColors.a); grad.addColorStop(1, waveColors.b);
    const peaks = S.peaks;
    for (let k = 0; k < n; k++) {
      let p = 0.04;
      if (peaks.length) {
        const a = Math.floor((k / n) * peaks.length), b = Math.max(a + 1, Math.floor(((k + 1) / n) * peaks.length));
        for (let j = a; j < b && j < peaks.length; j++) p = Math.max(p, peaks[j]);
      }
      const bh = Math.max(1.5, p * ((h - lane) / 2 - 8));
      const bx = k * (bar + gap);
      ctx.fillStyle = bx < progress ? grad : waveColors.wave;
      ctx.fillRect(bx, mid - bh, bar, bh * 2);
    }
    ctx.fillStyle = waveColors.b;
    ctx.fillRect(progress - 1, 0, 2, h);
    drawMarkers(w, h, x, lane);
  }
  const waveWrap = $("waveWrap");
  const waveDur = () => audio.duration || S.current?.duration || 0;
  const timeAtX = (clientX) => {
    const r = waveWrap.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * waveDur();
  };
  /** Marker edge under the pointer: {m, edge: "t" | "end"} */
  function hitMarker(clientX) {
    const r = waveWrap.getBoundingClientRect(), dur = waveDur();
    if (!dur) return null;
    let best = null, bestD = 7;
    for (const m of S.markers) {
      for (const edge of m.end != null ? ["t", "end"] : ["t"]) {
        const d = Math.abs(r.left + (m[edge] / dur) * r.width - clientX);
        if (d < bestD) { bestD = d; best = { m, edge }; }
      }
    }
    return best;
  }
  let wdrag = null;
  waveWrap.addEventListener("pointerdown", (e) => {
    if (!waveDur() || e.button !== 0) return;
    const hit = hitMarker(e.clientX);
    wdrag = hit ? { type: "move", ...hit, x0: e.clientX, moved: false }
      : e.shiftKey && canEditMarkers() ? { type: "new", t0: timeAtX(e.clientX), x0: e.clientX, m: null }
      : { type: "seek" };
    waveWrap.setPointerCapture(e.pointerId);
  });
  waveWrap.addEventListener("pointermove", (e) => {
    const dur = waveDur(); if (!dur) return;
    const r = waveWrap.getBoundingClientRect();
    const t = timeAtX(e.clientX);
    const hov = $("waveHover");
    hov.style.left = e.clientX - r.left + "px";
    const i = findSeg(t);
    const spk = S.segs[i]?.speaker && t <= S.segs[i].end + 0.5 ? " · " + spkName(S.segs[i].speaker) : "";
    const near = hitMarker(e.clientX);
    hov.textContent = fmt(t) + spk + (near ? ` · ${near.m.label || "Marker"}` : "");
    waveWrap.classList.toggle("grab", !!near || !!(wdrag && wdrag.type !== "seek"));
    if (!wdrag) return;
    if (wdrag.type === "move" && Math.abs(e.clientX - wdrag.x0) > 2) {
      wdrag.moved = true;
      const m = wdrag.m;
      if (wdrag.edge === "t") m.t = m.end != null ? Math.min(t, m.end - 0.2) : t;
      else m.end = Math.max(t, m.t + 0.2);
      drawWave();
    } else if (wdrag.type === "new" && Math.abs(e.clientX - wdrag.x0) > 4) {
      if (!wdrag.m) { wdrag.m = newMarker(wdrag.t0, wdrag.t0 + 0.2, "#ef4444"); S.markers.push(wdrag.m); }
      wdrag.m.t = Math.min(wdrag.t0, t); wdrag.m.end = Math.max(wdrag.t0, t);
      drawWave();
    }
  });
  waveWrap.addEventListener("pointerup", (e) => {
    const d = wdrag; wdrag = null;
    if (!d || !waveDur()) return;
    if (d.type === "seek") seekTo(timeAtX(e.clientX), false, true);
    else if (d.type === "move") {
      if (d.moved) { markersChanged(); } else seekTo(d.m[d.edge], false, true);
    } else if (d.type === "new") {
      if (d.m) { markersChanged(d.m); }
      else { const m = newMarker(d.t0, null); S.markers.push(m); markersChanged(m); }
    }
  });
  waveWrap.addEventListener("pointerleave", () => { if (!wdrag) waveWrap.classList.remove("grab"); });
  new ResizeObserver(() => drawWave()).observe(waveWrap);
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { waveColors = null; drawWave(); });

  // ------------------------------------------------------------------ markers
  const MK_COLORS = ["#22c55e", "#ef4444", "#f59e0b", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6"];
  const sortedMarkers = () => [...S.markers].sort((a, b) => a.t - b.t);
  function newMarker(t, end, color) {
    return { id: Math.random().toString(36).slice(2, 10), t, end: end ?? null, label: "", color: color || MK_COLORS[0] };
  }
  /** Save, redraw and (optionally) focus the label input of `focus`. */
  function markersChanged(focus) {
    S.markers.sort((a, b) => a.t - b.t);
    queueSave();
    renderMarkers();
    renderSegments();
    drawWave();
    if (focus) {
      const input = $("markerList").querySelector(`[data-id="${focus.id}"] input`);
      if (input) { input.focus(); input.select(); }
    }
  }
  function canEditMarkers() {
    if (S.current && S.transcript && !isBusy(S.current)) return true;
    toast(S.current && isBusy(S.current) ? "Markers can be added when the current job finishes" : "Markers can be added once there's a transcript");
    return false;
  }
  function addMarkerAtPlayhead() {
    if (!S.current || !waveDur() || !canEditMarkers()) return;
    const m = newMarker(audio.currentTime || 0, null);
    S.markers.push(m);
    markersChanged(m);
  }
  function drawMarkers(w, h, x, lane) {
    if (!S.markers.length) return;
    ctx.save();
    ctx.font = "600 10.5px Inter, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (const m of sortedMarkers()) {
      const x0 = x(m.t);
      if (m.end != null) {
        const x1 = x(m.end);
        ctx.globalAlpha = 0.12; ctx.fillStyle = m.color; ctx.fillRect(x0, lane, x1 - x0, h - lane);
        ctx.globalAlpha = 1; ctx.strokeStyle = m.color; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.strokeRect(x0 + 1, lane + 1, Math.max(2, x1 - x0 - 2), h - lane - 2);
        ctx.setLineDash([]);
        ctx.fillStyle = m.color; ctx.fillRect(x0 - 1, lane, 3, h - lane); ctx.fillRect(x1 - 2, lane, 3, h - lane);
      } else {
        ctx.fillStyle = m.color; ctx.fillRect(x0 - 1, lane, 3, h - lane);
      }
      // label tag in the top lane
      const text = (m.label || "Marker").slice(0, 40);
      const tw = Math.min(ctx.measureText(text).width + 10, Math.max(30, w - x0 - 2));
      const tx = Math.min(x0 - 1, w - tw);
      ctx.fillStyle = m.color;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(tx, 0, tw, 14, 4) : ctx.rect(tx, 0, tw, 14); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.save(); ctx.beginPath(); ctx.rect(tx, 0, tw, 14); ctx.clip();
      ctx.fillText(text, tx + 5, 7.5);
      ctx.restore();
    }
    ctx.restore();
  }
  function renderMarkers() {
    const card = $("markersCard");
    card.classList.toggle("hidden", !S.current || !S.current.duration);
    const list = $("markerList");
    list.innerHTML = "";
    $("markerCount").textContent = S.markers.length || "";
    if (!S.markers.length) {
      list.append(el("li", "muted", "No markers yet. Press + Marker or Alt+M while listening."));
      return;
    }
    for (const m of sortedMarkers()) {
      const li = el("li");
      li.dataset.id = m.id;
      const sw = el("button", "mk-color"); sw.style.background = m.color; sw.title = "Change color";
      sw.onclick = () => { m.color = MK_COLORS[(MK_COLORS.indexOf(m.color) + 1) % MK_COLORS.length]; markersChanged(); };
      const time = el("button", "mk-time", m.end != null ? `${fmt(m.t)}–${fmt(m.end)}` : fmt(m.t));
      time.title = "Jump here";
      time.onclick = () => seekTo(m.t, true);
      const input = el("input"); input.value = m.label; input.placeholder = m.end != null ? "Section label" : "Marker label";
      input.oninput = () => { m.label = input.value; drawWave(); queueSave(); };
      input.onchange = () => renderSegments();
      input.onkeydown = (e) => { if (e.key === "Enter" || e.key === "Escape") input.blur(); };
      const acts = el("div", "mk-actions");
      if (m.end != null) {
        const play = el("button", null, "▶"); play.title = "Play this section";
        play.onclick = () => { seekTo(m.t); S.stopAt = m.end; audio.play().catch(() => {}); };
        acts.append(play);
      } else {
        const here = el("button", null, "⇥"); here.title = "Move marker to the playhead";
        here.onclick = () => { m.t = audio.currentTime || 0; markersChanged(); };
        acts.append(here);
      }
      const del = el("button", "del", "✕"); del.title = "Delete marker";
      del.onclick = () => { S.markers = S.markers.filter((x) => x !== m); markersChanged(); };
      acts.append(del);
      li.append(sw, time, input, acts);
      list.append(li);
    }
  }
  $("addMarkerBtn").onclick = addMarkerAtPlayhead;
  $("addMarker2").onclick = addMarkerAtPlayhead;

  // ------------------------------------------------------------------ redaction
  /** The current text selection if it lies inside one segment: {i, phrase, offset}. */
  function selectionTarget() {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const a = range.startContainer.parentElement?.closest?.(".seg-text") || (range.startContainer.closest && range.startContainer.closest(".seg-text"));
    const b = range.endContainer.parentElement?.closest?.(".seg-text") || (range.endContainer.closest && range.endContainer.closest(".seg-text"));
    if (!a || a !== b) return null;
    const phrase = sel.toString().replace(/\s+/g, " ").trim();
    if (!phrase || isToken(phrase)) return null;
    const pre = range.cloneRange();
    pre.selectNodeContents(a);
    pre.setEnd(range.startContainer, range.startOffset);
    return { i: +a.parentElement.dataset.i, phrase, offset: pre.toString().length };
  }
  // ---- clicking a redaction bar: unredact / erase
  let redTarget = null, redSeg = null, redBar = 0;
  function hideRedMenu() { $("redMenu").classList.add("hidden"); redTarget = null; }
  function showRedMenu(bar) {
    hideBubble(); hideCtx();
    redTarget = bar.dataset.rid || null;
    redSeg = +bar.closest(".seg").dataset.i;
    redBar = [...bar.closest(".seg-text").querySelectorAll(".redacted.final")].indexOf(bar);
    const info = (redTarget && S.transcript?.redactions?.[redTarget]) || {};
    $("redInfo").textContent = redTarget ? (info.muted ? "Redacted text · audio muted" : "Redacted text")
      : "This was redacted permanently, so the words aren't stored anywhere";
    $("redUndoSub").textContent = info.muted ? "Restore the original text and audio" : "Restore the original text";
    $("redUndo").classList.toggle("hidden", !redTarget);
    $("redErase").classList.toggle("hidden", !redTarget);
    $("redRecover").classList.toggle("hidden", !!redTarget);
    $("redRecover").disabled = !S.current?.has_audio;
    const m = $("redMenu");
    m.classList.remove("hidden");
    const r = bar.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.max(8, Math.min(r.left, innerWidth - mw - 8)) + "px";
    m.style.top = (r.bottom + mh + 8 > innerHeight ? r.top - mh - 6 : r.bottom + 6) + "px";
  }
  segBox.addEventListener("mousedown", (e) => {
    const bar = e.target.closest(".redacted");
    if (!bar || e.button !== 0) return;
    e.preventDefault(); // don't start editing / selecting
    if (bar.dataset.rid) { hideRedMenu(); unredact(bar.dataset.rid); } // one click = unredact
    else showRedMenu(bar);
  });
  segBox.addEventListener("contextmenu", (e) => {
    const bar = e.target.closest(".redacted");
    if (!bar) return;
    e.preventDefault(); e.stopImmediatePropagation();
    showRedMenu(bar);
  }, true);
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#redMenu") && !e.target.closest(".redacted")) hideRedMenu(); });
  async function unredact(rid) {
    await redactionAction(`redactions/${rid}/unredact`, null, (r) => {
      toast(r.unmuted ? "Unredacted (text and audio restored)" : "Unredacted", false, r.segment_id != null ? {
        label: "Redact again",
        fn: () => {
          const i = S.segs.findIndex((s) => s.id === r.segment_id);
          if (i >= 0) doRedact({ i, phrase: r.text, offset: r.offset }, false, r.was_muted, true);
        },
      } : null);
    });
  }
  document.addEventListener("wheel", hideRedMenu, { passive: true });
  async function redactionAction(path, okMsg, after) {
    try {
      queueSave(); await flushSave();
      const r = await api(`/api/files/${S.current.id}/${path}`, { method: "POST" });
      S.transcript = r.transcript; S.segs = r.transcript.segments; S.speakers = r.transcript.speakers || {}; S.markers = r.transcript.markers || S.markers;
      renderSegments(); renderSpeakers();
      if (okMsg) toast(okMsg(r));
      if (after) after(r);
      if (r.unmuted) { const t = audio.currentTime; await loadFiles(); await loadAudio(); audio.currentTime = t; }
    } catch (e) { toast(e.message, true); }
  }
  $("redUndo").onclick = () => { const rid = redTarget; hideRedMenu(); if (rid) unredact(rid); };
  $("redRecover").onclick = async () => {
    const seg = S.segs[redSeg], bar = redBar; hideRedMenu();
    if (!seg) return;
    toast("Listening to the audio again…");
    try {
      queueSave(); await flushSave();
      const r = await api(`/api/files/${S.current.id}/segments/${seg.id}/recover`, { method: "POST", body: JSON.stringify({ bar }) });
      S.transcript = r.transcript; S.segs = r.transcript.segments; S.speakers = r.transcript.speakers || {}; S.markers = r.transcript.markers || S.markers;
      renderSegments(); renderSpeakers();
      toast("Words recovered from the audio. Check them, and redact again if needed");
    } catch (e) { toast(e.message, true); }
  };
  $("redErase").onclick = () => {
    const rid = redTarget; hideRedMenu();
    if (rid && confirm("Erase this redaction permanently? The original text is destroyed and it can never be unredacted.")) {
      redactionAction(`redactions/${rid}/erase`, () => "Redaction erased permanently");
    }
  };
  $("eraseAllBtn").onclick = () => {
    const n = Object.keys(S.transcript?.redactions || {}).length;
    if (!n) { toast("There are no undoable redactions in this file"); return; }
    if (confirm(`Erase all ${n} redaction${n > 1 ? "s" : ""} permanently? The hidden original text (and muted audio) is destroyed and can never be restored.`)) {
      redactionAction("redactions/erase-all", (r) => `${r.count} redaction${r.count === 1 ? "" : "s"} erased permanently`);
    }
  };

  function countEverywhere(phrase) {
    const re = new RegExp("(?<![\\p{L}\\p{N}_])" + phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\p{L}\\p{N}_])", "giu");
    return S.segs.reduce((n, s) => n + (s.text.match(re) || []).length, 0);
  }
  function hideCtx() { $("ctxMenu").classList.add("hidden"); }
  // Floating bar that appears as soon as text in a line is selected.
  function hideBubble() { $("selBubble").classList.add("hidden"); }
  function showBubble() {
    const target = selectionTarget();
    if (!target) { hideBubble(); return; }
    S.ctx = target;
    const n = countEverywhere(target.phrase);
    $("bubAll").textContent = n > 1 ? `Everywhere (${n})` : "Everywhere";
    $("bubAll").disabled = n < 2;
    $("bubMute").disabled = !S.current?.has_audio;
    const rect = getSelection().getRangeAt(0).getBoundingClientRect();
    const b = $("selBubble");
    b.classList.remove("hidden");
    const bh = b.offsetHeight, bw = b.offsetWidth;
    const below = rect.top - bh - 12 < 8;
    b.classList.toggle("below", below);
    b.style.left = Math.max(bw / 2 + 8, Math.min(rect.left + rect.width / 2, innerWidth - bw / 2 - 8)) + "px";
    b.style.top = (below ? rect.bottom + 10 : rect.top - bh - 10) + "px";
  }
  segBox.addEventListener("mouseup", () => setTimeout(() => { showBubble(); showSplit(); }, 0));
  segBox.addEventListener("keyup", (e) => {
    if (e.shiftKey || e.key === "Shift") showBubble(); else hideBubble();
    if (/^Arrow|^Home$|^End$/.test(e.key) && !e.shiftKey) showSplit(); else hideSplit();
  });
  // "Split here" appears where you click inside a line (snapped to the nearest word boundary).
  function hideSplit() { $("splitBubble").classList.add("hidden"); S.splitAt = null; }
  function showSplit() {
    hideSplit();
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed || !S.current || isBusy(S.current)) return;
    const txt = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest(".seg-text");
    if (!txt) return;
    const i = +txt.parentElement.dataset.i;
    const s = S.segs[i];
    let off = caretOffset(txt);
    if (!s || off < 0) return;
    const t = s.text;
    if (/\S/.test(t[off - 1] || "") && /\S/.test(t[off] || "")) {  // inside a word: move to its nearest edge
      let a = off, b = off;
      while (a > 0 && /\S/.test(t[a - 1])) a--;
      while (b < t.length && /\S/.test(t[b])) b++;
      off = off - a <= b - off ? a : b;
    }
    if (!t.slice(0, off).trim() || !t.slice(off).trim()) return;  // at the very start or end: nothing to split
    S.splitAt = { i, off, id: s.id };
    const r = sel.getRangeAt(0);
    const rect = r.getClientRects()[0] || r.getBoundingClientRect();
    if (!rect || (!rect.left && !rect.top)) return;
    const bub = $("splitBubble");
    bub.classList.remove("hidden");
    const bh = bub.offsetHeight, bw = bub.offsetWidth;
    const below = rect.top - bh - 12 < 8;
    bub.classList.toggle("below", below);
    bub.style.left = Math.max(bw / 2 + 8, Math.min(rect.left, innerWidth - bw / 2 - 8)) + "px";
    bub.style.top = (below ? rect.bottom + 10 : rect.top - bh - 10) + "px";
  }
  $("splitBubble").addEventListener("mousedown", (e) => e.preventDefault());
  $("splitBtn").onclick = (e) => {
    e.stopPropagation();
    const t = S.splitAt; hideSplit();
    if (!t || S.segs[t.i]?.id !== t.id) return;
    splitAt(t.i, t.off, true);
  };
  segBox.addEventListener("keydown", (e) => { if (!/^Arrow|^Home$|^End$|^Shift$|^Alt$/.test(e.key)) hideSplit(); });
  segBox.addEventListener("scroll", hideSplit);
  document.addEventListener("selectionchange", () => { const s = getSelection(); if (!s.rangeCount || s.isCollapsed) hideBubble(); });
  $("selBubble").addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection
  $("bubRedact").onclick = () => { hideBubble(); doRedact(S.ctx, false, false); };
  $("bubAll").onclick = () => { hideBubble(); doRedact(S.ctx, true, false); };
  $("bubMute").onclick = () => { hideBubble(); doRedact(S.ctx, false, true); };
  segBox.addEventListener("scroll", hideBubble);
  segBox.addEventListener("contextmenu", (e) => {
    const target = selectionTarget();
    if (!target) return; // no selection: keep the browser menu (spellcheck etc.)
    e.preventDefault();
    hideBubble();
    S.ctx = target;
    const n = countEverywhere(target.phrase);
    $("ctxCount").textContent = n > 1 ? `${n} matches of "${target.phrase.slice(0, 30)}${target.phrase.length > 30 ? "…" : ""}"` : "only this occurrence";
    $("ctxRedactAll").disabled = n < 2;
    $("ctxRedactMute").disabled = !S.current?.has_audio;
    const m = $("ctxMenu");
    m.classList.remove("hidden");
    const mw = m.offsetWidth, mh = m.offsetHeight;
    m.style.left = Math.min(e.clientX, innerWidth - mw - 8) + "px";
    m.style.top = Math.min(e.clientY, innerHeight - mh - 8) + "px";
  });
  document.addEventListener("mousedown", (e) => { if (!e.target.closest("#ctxMenu")) hideCtx(); });
  document.addEventListener("wheel", hideCtx, { passive: true });
  $("ctxRedact").onclick = () => { hideCtx(); doRedact(S.ctx, false, false); };
  $("ctxRedactAll").onclick = () => { hideCtx(); doRedact(S.ctx, true, false); };
  $("ctxRedactMute").onclick = () => { hideCtx(); doRedact(S.ctx, false, true); };
  $("ctxCopy").onclick = () => { hideCtx(); navigator.clipboard?.writeText(S.ctx?.phrase || "").catch(() => document.execCommand("copy")); };

  function redactSelection(everywhere, mute) {
    const t = selectionTarget();
    if (!t) { toast("Select the text you want to redact first"); return; }
    doRedact(t, everywhere, mute);
  }
  async function doRedact(target, everywhere, mute, quiet = false) {
    if (!target || !S.current) return;
    const seg = S.segs[target.i];
    if (!seg) return;
    if (everywhere) {
      const n = countEverywhere(target.phrase);
      if (!confirm(`Redact all ${n} occurrences of "${target.phrase}"? This can't be undone.`)) return;
    }
    if (mute && !quiet && !confirm("Also silence this part of the audio? You can unredact later to bring it back.")) return;
    // capture any in-progress edit of this line before redacting on the server
    const txt = rowEl(target.i)?.querySelector(".seg-text");
    if (txt && document.activeElement === txt) seg.text = txt.textContent.replace(/\n/g, " ");
    getSelection().removeAllRanges();
    if (document.activeElement?.classList?.contains("seg-text")) document.activeElement.blur();
    try {
      queueSave(); await flushSave();
      if (mute) toast("Redacting and muting audio…");
      const r = await api(`/api/files/${S.current.id}/redact`, {
        method: "POST",
        body: JSON.stringify({ phrase: target.phrase, segment_id: everywhere ? null : seg.id, offset: target.offset, mute_audio: mute }),
      });
      S.transcript = r.transcript; S.segs = r.transcript.segments; S.speakers = r.transcript.speakers || {}; S.markers = r.transcript.markers || S.markers;
      renderSegments(); renderSpeakers();
      $("saveState").textContent = "All changes saved";
      toast(`Redacted ${r.count} occurrence${r.count === 1 ? "" : "s"}${r.muted ? " and muted the audio" : ""}`);
      if (r.muted) { const t = audio.currentTime; await loadFiles(); await loadAudio(); audio.currentTime = t; }
    } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------------ guided upload
  // Upload -> ask how many speakers + model -> start. When it's done, open Teach with a short intro.
  const MOSS = "moss-transcribe-diarize";
  function teachList() { const v = store.get("teachAfter", {}); return v && typeof v === "object" ? v : {}; }
  function teachPending(f) { return Object.prototype.hasOwnProperty.call(teachList(), f.id); }
  function teachForget(id) { const l = teachList(); delete l[id]; store.set("teachAfter", l); }

  function wizSetup(mode) {
      S.wiz = { mode, items: new Map(), started: null };
      const sel = $("wzModel");
      sel.innerHTML = "";
      for (const o of $("modelSelect").options) sel.append(new Option(o.text, o.value));
      const local = S.config?.local_models || [];
      const want = store.get("wizModel", null);
      sel.value = [...sel.options].some((o) => o.value === want) ? want : local.includes(MOSS) ? MOSS : $("modelSelect").value;
      wizModelHint();
      wizPick(store.get("wizSpeakers", "auto"));
      $("wzTeach").checked = store.get("wizTeach", true);
      $("wzAlways").checked = true;
      $("wzLang").value = $("languageInput").value.trim();
      $("wzVocab").value = store.get("wizVocab", "");
      wizMoreSummary();
      $("wzAlwaysWrap").classList.toggle("hidden", mode !== "upload");
      $("wzKeepWrap").classList.add("hidden");
      $("wzStart").textContent = "Start transcription";
      $("wizard").classList.remove("hidden");
      setTimeout(() => $("wzStart").focus(), 50);
  }
  function wizMoreSummary() {
    const bits = [];
    if ($("wzLang").value.trim()) bits.push($("wzLang").value.trim());
    const n = $("wzVocab").value.split(/[,\n;]/).filter((x) => x.trim()).length;
    if (n) bits.push(`${n} term${n > 1 ? "s" : ""}`);
    $("wzMoreSummary").textContent = bits.length ? "· " + bits.join(" · ") : "";
  }
  $("wzLang").oninput = wizMoreSummary;
  $("wzVocab").oninput = wizMoreSummary;
  function wizAdd(tid, name) {
    if (!S.wiz) wizSetup("upload");
    S.wiz.items.set(tid, { name, fid: null });
    wizRender();
  }
  function openReprocess() {
    const f = S.current;
    if (!f || S.wiz) return;
    wizSetup("reprocess");
    S.wiz.fid = f.id;
    const prev = S.transcript?.options || {};
    if (prev.vocabulary) $("wzVocab").value = prev.vocabulary;
    if (prev.language) $("wzLang").value = prev.language;
    wizMoreSummary();
    $("wzKeepWrap").classList.toggle("hidden", !f.has_transcript);
    $("wzKeep").checked = true;
    $("wzTitle").textContent = f.has_transcript ? "Transcribe again" : "Transcribe";
    $("wzStart").textContent = f.has_transcript ? "Re-transcribe" : "Start transcription";
    const ul = $("wzFiles"); ul.innerHTML = "";
    const li = el("li");
    li.append(el("span", null, f.name), el("span", null, f.has_transcript ? `current: ${f.model || "transcript"}` : ""));
    ul.append(li);
  }
  function wizRender() {
    if (!S.wiz || S.wiz.mode !== "upload") return;
    const ul = $("wzFiles");
    ul.innerHTML = "";
    for (const [tid, it] of S.wiz.items) {
      const up = S.uploads.get(tid);
      const state = it.fid ? "uploaded" : up ? (up.progress < 1 ? `uploading ${Math.round(up.progress * 100)}%` : "finishing upload") : "";
      const li = el("li");
      li.append(el("span", null, it.name), el("span", null, state));
      ul.append(li);
    }
    $("wzTitle").textContent = S.wiz.items.size > 1 ? `Transcribe ${S.wiz.items.size} recordings` : "Transcribe your recording";
  }
  function wizPick(v) {
    const box = $("wzSpeakers");
    if (![...box.children].some((b) => b.dataset.v === v)) v = "auto";
    for (const b of box.children) b.setAttribute("aria-checked", b.dataset.v === v ? "true" : "false");
    $("wzTeach").closest("label").classList.toggle("hidden", v === "off");
  }
  function wizSpeakers() { return [...$("wzSpeakers").children].find((b) => b.getAttribute("aria-checked") === "true")?.dataset.v || "auto"; }
  function wizModelHint() {
    const m = $("wzModel").value;
    $("wzModelHint").textContent = m === MOSS && (S.config?.local_models || []).includes(MOSS)
      ? "Built in: transcribes and tells speakers apart in one pass. Downloads about 1 GB the first time."
      : /moss/i.test(m) ? "MOSS through llama-swap: transcribes and tells speakers apart in one pass."
      : "Speakers are detected separately on the server CPU.";
  }
  $("wzSpeakers").onclick = (e) => { const b = e.target.closest("button"); if (b) wizPick(b.dataset.v); };
  $("wzModel").onchange = wizModelHint;
  async function wizUploaded(tid, fid) {
    const W = S.wiz;
    if (W?.items.has(tid)) {
      W.items.get(tid).fid = fid;
      wizRender();
      return;
    }
    const pending = S.wizStarted?.get(tid);  // Start was pressed before this upload finished
    if (pending) { S.wizStarted.delete(tid); await wizTranscribe(fid, pending); }
  }
  function wizDrop(tid) {
    S.wizStarted?.delete(tid);
    if (!S.wiz) return;
    S.wiz.items.delete(tid);
    if (!S.wiz.items.size) wizClose(); else wizRender();
  }
  async function wizTranscribe(fid, o) {
    if (o.teach) { const l = teachList(); l[fid] = o.expected; store.set("teachAfter", l); }
    try {
      const meta = await api(`/api/files/${fid}/transcribe`, { method: "POST", body: JSON.stringify(o.body) });
      if (S.current?.id === fid) { S.current = meta; renderHeader(); }
    } catch (e) { toast(e.message, true); teachForget(fid); }
  }
  async function wizStart() {
    const W = S.wiz;
    if (!W) return;
    const speakers = wizSpeakers();
    const model = $("wzModel").value;
    store.set("wizSpeakers", speakers); store.set("wizModel", model); store.set("wizTeach", $("wzTeach").checked);
    store.set("wizVocab", $("wzVocab").value.trim());
    const body = { model };
    const lang = $("wzLang").value.trim();
    if (lang) body.language = lang;
    const vocab = $("wzVocab").value.trim();
    if (vocab) body.vocabulary = vocab;
    if (S.config?.diarization_available || /moss/i.test(model)) body.speakers = speakers;
    const o = { body, teach: $("wzTeach").checked && speakers !== "off", expected: parseInt(speakers, 10) || null };
    if (W.mode === "reprocess") {
      const f = S.current;
      if (!f || f.id !== W.fid) { wizClose(); return; }
      body.keep_previous = $("wzKeep").checked || !f.has_transcript;
      try {
        await flushSave();
        if (o.teach) { const l = teachList(); l[f.id] = o.expected; store.set("teachAfter", l); }
        S.current = await api(`/api/files/${f.id}/transcribe`, { method: "POST", body: JSON.stringify(body) });
        wizClose();
        toast(body.keep_previous && f.has_transcript ? "Re-transcribing. The current transcript is kept under Versions" : "Transcription started");
        renderHeader();
        await loadFiles(); schedulePoll();
      } catch (e) { toast(e.message, true); teachForget(f.id); }
      return;
    }
    S.wizStarted = S.wizStarted || new Map();
    let waiting = 0;
    for (const [tid, it] of W.items) {
      if (it.fid) await wizTranscribe(it.fid, o);
      else { S.wizStarted.set(tid, o); waiting++; }
    }
    wizClose();
    await loadFiles(); schedulePoll();
    toast(waiting ? "Transcription will start as soon as the upload finishes" : "Transcription started");
  }
  function wizLater() { wizClose(); }
  function wizClose() {
    if (S.wiz?.mode === "upload" && !$("wzAlways").checked) { store.set("wizard", false); $("wizToggle").checked = false; $("autoToggleWrap").classList.remove("hidden"); toast("Guided upload is off. Turn it back on with the Guided switch at the top."); }
    S.wiz = null;
    $("wizard").classList.add("hidden");
  }
  $("wzStart").onclick = wizStart;
  $("wzLater").onclick = wizLater;
  $("wzClose").onclick = wizLater;
  let wzDownOnBackdrop = false;
  $("wizard").addEventListener("mousedown", (e) => { wzDownOnBackdrop = e.target.id === "wizard"; });
  $("wizard").addEventListener("click", (e) => { if (e.target.id === "wizard" && wzDownOnBackdrop) wizLater(); });

  function teachAfter(f) {
    if (S.current?.id !== f.id || S.tr || !S.segs.length) return;
    const expected = teachList()[f.id] || null;
    teachForget(f.id);
    const found = Object.keys(S.speakers).length;
    if (found < 2 && !(expected >= 2)) { toast("Transcription finished"); return; }
    const n = Math.max(found, expected || 0);
    openTrainer(`<b>Transcription finished 🎉</b>We found ${found === 1 ? "one voice" : found + " speakers"}${expected && expected !== found ? ` (you expected ${expected})` : ""}. Tag a few clips for each person below, two or three each is plenty, and we'll match every line to the right speaker. Name them too, and they'll be recognized automatically next time.`, n >= 2 ? n : null);
  }

  // ------------------------------------------------------------------ teach speakers
  const PLAY_ICON = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  const STOP_ICON = '<svg viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>';

  function openTrainer(intro = null, expected = null) {
    if (!S.segs.length || !S.current?.has_audio) return;
    $("trIntro").classList.toggle("hidden", !intro);
    $("trIntro").innerHTML = intro || "";
    const existing = Object.entries(S.speakers);
    let people;
    if (existing.length >= 2 && existing.length <= 6 && !(expected && existing.length < expected)) {
      people = existing.map(([id, v]) => ({ id, name: v.name || id }));
    } else {
      const sel = expected || parseInt($("speakersSelect").value, 10);
      const n = Number.isFinite(sel) && sel >= 2 ? sel : 2;
      const saved = [...S.voices].sort((a, b) => b.n - a.n);
      people = Array.from({ length: n }, (_, k) => ({ id: "S" + (k + 1), name: saved[k]?.name || `Speaker ${k + 1}` }));
    }
    S.tr = { people, tags: new Map(), clips: [], playing: null };
    // pre-fill tags from lines the user already tagged/corrected
    S.segs.forEach((s, i) => { if (s.spk_locked && people.some((p) => p.id === s.speaker)) S.tr.tags.set(i, s.speaker); });
    S.tr.clips = [...S.tr.tags.keys()].slice(0, 6);
    addClips(8);
    $("trainer").classList.remove("hidden");
    renderTrainer();
  }
  function closeTrainer() {
    if (S.stopAt != null) { audio.pause(); S.stopAt = null; }
    S.tr = null;
    $("trainer").classList.add("hidden");
  }
  function addClips(n) {
    const T = S.tr;
    const used = new Set(T.clips);
    let pool = S.segs.map((s, i) => i).filter((i) => !used.has(i) && S.segs[i].end - S.segs[i].start >= 2.5 && S.segs[i].end - S.segs[i].start <= 15);
    if (pool.length < n) pool = S.segs.map((s, i) => i).filter((i) => !used.has(i) && S.segs[i].end - S.segs[i].start >= 1.2);
    if (!pool.length) return;
    // spread picks evenly across the recording, skipping neighbours of clips already chosen
    const picks = [];
    for (let k = 0; k < n && pool.length; k++) {
      const target = (k + 0.5 + T.clips.length * 0.37) / n % 1;
      let best = 0, bestD = Infinity;
      pool.forEach((i, j) => { const d = Math.abs(i / S.segs.length - target); if (d < bestD) { bestD = d; best = j; } });
      picks.push(pool.splice(best, 1)[0]);
      pool = pool.filter((i) => Math.abs(i - picks[picks.length - 1]) > 2);
    }
    T.clips.push(...picks.sort((a, b) => a - b));
  }
  function personColor(T, id) { return SPK_COLORS[Math.max(0, T.people.findIndex((p) => p.id === id)) % SPK_COLORS.length]; }
  function renderTrainer() {
    const T = S.tr;
    if (!T) return;
    // people
    const box = $("trPeople");
    box.innerHTML = "";
    T.people.forEach((p) => {
      const chip = el("div", "tr-person");
      const dot = el("i"); dot.style.background = personColor(T, p.id);
      const input = el("input"); input.value = p.name; input.placeholder = "Name";
      input.oninput = () => {
        p.name = input.value;
        $("trClips").querySelectorAll(`.tr-tags button[data-pid="${p.id}"]`).forEach((b) => { b.lastChild.textContent = p.name || "?"; });
        renderTrainerCounts();
      };
      const rm = el("button", null, "✕"); rm.title = "Remove";
      rm.onclick = () => {
        if (T.people.length <= 2) { toast("You need at least two people"); return; }
        T.people = T.people.filter((x) => x !== p);
        for (const [k, v] of [...T.tags]) if (v === p.id) T.tags.delete(k);
        renderTrainer();
      };
      chip.append(dot, input, rm);
      box.append(chip);
    });
    const saved = $("trSaved");
    saved.innerHTML = "";
    if (S.voices.length) {
      saved.append(document.createTextNode("Remembered voices:"));
      for (const v of S.voices) {
        const b = el("button", null, v.name);
        b.title = "Use this remembered voice";
        b.onclick = () => {
          if (T.people.some((p) => p.name.trim().toLowerCase() === v.name.trim().toLowerCase())) return;
          const generic = T.people.find((p) => /^speaker \d+$/i.test(p.name.trim()));
          if (generic) generic.name = v.name;
          else T.people.push({ id: newTrainerId(), name: v.name });
          renderTrainer();
        };
        const x = el("button", "x", "✕");
        x.title = `Forget ${v.name}'s voice`;
        x.onclick = async () => {
          if (!confirm(`Forget the saved voice "${v.name}"? Future files won't recognize it automatically.`)) return;
          await api(`/api/voices/${v.id}`, { method: "DELETE" });
          await loadVoices(); renderTrainer();
        };
        saved.append(b, x);
      }
    }
    renderTrainerCounts();
    renderTrainerClips();
  }
  function newTrainerId() {
    const T = S.tr; let n = 1;
    while (T.people.some((p) => p.id === "S" + n)) n++;
    return "S" + n;
  }
  function renderTrainerCounts() {
    const T = S.tr;
    const c = $("trCounts");
    c.innerHTML = "";
    let ready = true;
    for (const p of T.people) {
      const n = [...T.tags.values()].filter((v) => v === p.id).length;
      const ok = n >= 1 || hasVoice(p.name);
      if (!ok) ready = false;
      c.append(el("span", ok ? "ok" : "", `${p.name || "?"}: ${n}${hasVoice(p.name) ? " + saved voice" : ""}`));
    }
    const names = T.people.map((p) => p.name.trim().toLowerCase());
    if (names.some((n) => !n) || new Set(names).size !== names.length) ready = false;
    $("trApply").disabled = !ready;
    $("trApply").title = ready ? "" : "Give everyone a unique name and tag at least one clip for each person";
  }
  /** Build the clip rows once; afterwards rows are updated in place (stable click targets). */
  function renderTrainerClips() {
    const T = S.tr;
    const list = $("trClips");
    const scroll = list.closest(".modal-body")?.scrollTop;
    list.innerHTML = "";
    for (const i of T.clips) list.append(buildClipRow(i));
    if (scroll != null) list.closest(".modal-body").scrollTop = scroll;
  }
  function buildClipRow(i) {
    const T = S.tr;
    const s = S.segs[i];
    const li = el("li", "tr-clip");
    li.dataset.i = i;
    const play = el("button", "tr-play");
    play.type = "button";
    play.title = "Play this clip (Space)";
    play.onclick = () => (T.playing === i ? stopClip() : playClip(i));
    const body = el("div");
    body.append(el("div", "tr-meta", `${fmt(s.start)} – ${fmt(s.end)}`), el("div", "tr-text", s.text || "(no text)"));
    const tags = el("div", "tr-tags");
    for (const p of T.people) {
      const b = el("button");
      b.type = "button";
      b.dataset.pid = p.id;
      b.style.setProperty("--tag", personColor(T, p.id));
      const dot = el("i"); dot.style.background = personColor(T, p.id);
      b.append(dot, document.createTextNode(p.name || "?"));
      b.onclick = () => tagClip(i, p.id);
      tags.append(b);
    }
    const skip = el("button", "skip", "Skip");
    skip.type = "button";
    skip.title = "Overlapping voices, music or unsure";
    skip.onclick = () => skipClip(i);
    tags.append(skip);
    body.append(tags);
    li.append(play, body);
    updateClipRow(i, li);
    return li;
  }
  function clipRow(i) { return $("trClips").querySelector(`.tr-clip[data-i="${i}"]`); }
  function updateClipRow(i, li = clipRow(i)) {
    const T = S.tr;
    if (!T || !li) return;
    const tag = T.tags.get(i);
    li.classList.toggle("tagged", !!tag);
    li.classList.toggle("playing", T.playing === i);
    if (tag) li.style.setProperty("--tag", personColor(T, tag)); else li.style.removeProperty("--tag");
    li.querySelector(".tr-play").innerHTML = T.playing === i ? STOP_ICON : PLAY_ICON;
    li.querySelectorAll(".tr-tags button[data-pid]").forEach((b) => b.classList.toggle("on", b.dataset.pid === tag));
  }
  function tagClip(i, pid) {
    const T = S.tr;
    if (T.tags.get(i) === pid) T.tags.delete(i); else T.tags.set(i, pid);
    updateClipRow(i);
    renderTrainerCounts();
    // Only advance when tagging the clip you're listening to; tagging another clip leaves playback alone.
    if (T.tags.has(i) && (T.playing === i || (T.playing == null && T.last === i))) playNextUntagged(i);
  }
  function skipClip(i) {
    const T = S.tr;
    const wasCurrent = T.playing === i || T.last === i;
    if (T.playing === i) stopClip();
    T.tags.delete(i);
    const pos = T.clips.indexOf(i);
    T.clips = T.clips.filter((x) => x !== i);
    clipRow(i)?.remove();
    const before = new Set(T.clips);
    addClips(1);
    for (const n of T.clips.filter((x) => !before.has(x))) $("trClips").append(buildClipRow(n));
    renderTrainerCounts();
    if (wasCurrent) {
      const next = T.clips.slice(pos).find((x) => !T.tags.has(x));
      if (next != null) playClip(next);
    }
  }
  function playClip(i) {
    const T = S.tr;
    const s = S.segs[i];
    const prev = T.playing;
    T.playing = i;
    T.last = i;
    S.stopAt = s.end + 0.15;
    audio.currentTime = Math.max(0, s.start - 0.1);
    audio.play().catch(() => {});
    if (prev != null && prev !== i) updateClipRow(prev);
    updateClipRow(i);
    const row = clipRow(i), body = row?.closest(".modal-body");
    if (row && body) {  // bring it into view without animating the list under the pointer
      const r = row.getBoundingClientRect(), b = body.getBoundingClientRect();
      if (r.top < b.top || r.bottom > b.bottom) row.scrollIntoView({ block: "nearest" });
    }
  }
  function stopClip() {
    S.stopAt = null;
    audio.pause();
    trPlaying(null);
  }
  function playNextUntagged(after) {
    const T = S.tr;
    const pos = T.clips.indexOf(after);
    const next = T.clips.slice(pos + 1).find((i) => !T.tags.has(i));
    if (next != null) playClip(next); else stopClip();
  }
  function trPlaying(i) {
    const T = S.tr;
    if (!T || T.playing === i) return;
    const prev = T.playing;
    T.playing = i;
    if (prev != null) updateClipRow(prev);
    if (i != null) updateClipRow(i);
  }
  async function applyTrainer() {
    const T = S.tr;
    const speakers = {};
    for (const p of T.people) speakers[p.id] = { name: p.name.trim() };
    S.speakers = speakers;
    S.segs.forEach((s) => { if (s.spk_locked && !speakers[s.speaker]) delete s.spk_locked; });
    for (const [i, pid] of T.tags) {
      const s = S.segs[i];
      s.speaker = pid; s.spk_locked = true; s.spk_conf = 1;
    }
    const remember = $("trRemember").checked;
    closeTrainer();
    renderSegments(); renderSpeakers();
    queueSave();
    await runIdentify(remember);
  }
  $("teachBtn").onclick = openTrainer;
  $("trClose").onclick = closeTrainer;
  let trDownOnBackdrop = false;
  $("trainer").addEventListener("mousedown", (e) => { trDownOnBackdrop = e.target.id === "trainer"; });
  $("trainer").addEventListener("click", (e) => { if (e.target.id === "trainer" && trDownOnBackdrop) closeTrainer(); trDownOnBackdrop = false; });
  $("trAddPerson").onclick = () => {
    if (S.tr.people.length >= 8) return;
    const id = newTrainerId();
    S.tr.people.push({ id, name: `Speaker ${id.slice(1)}` });
    renderTrainer();
  };
  $("trMore").onclick = () => {
    const before = new Set(S.tr.clips);
    addClips(6);
    for (const n of S.tr.clips.filter((x) => !before.has(x))) $("trClips").append(buildClipRow(n));
  };
  $("trApply").onclick = applyTrainer;

  // ------------------------------------------------------------------ keyboard
  document.addEventListener("keydown", (e) => {
    if (S.modal) { if (e.key === "Escape") { e.preventDefault(); closeModal(); } return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "h" && S.current) { e.preventDefault(); openFind(); return; }
    if (S.wiz) { // guided upload dialog open
      if (e.key === "Escape") { e.preventDefault(); wizLater(); }
      else if (e.key === "Enter" && !e.target.closest("select")) { e.preventDefault(); wizStart(); }
      return;
    }
    if (S.tr) { // Teach dialog open: it owns the keyboard (no shortcuts reach the player behind it)
      if (e.key === "Escape") { e.preventDefault(); closeTrainer(); return; }
      if (e.code === "Space" && !e.target.closest("input")) {
        e.preventDefault();
        const T = S.tr;
        if (T.playing != null) stopClip();
        else if (T.last != null && T.clips.includes(T.last)) playClip(T.last);
        else { const first = T.clips.find((i) => !T.tags.has(i)) ?? T.clips[0]; if (first != null) playClip(first); }
      }
      return;
    }
    const inField = e.target.closest("input, select, [contenteditable=true]");
    if (e.key === "Escape") { hideSpkMenu(); hideRedMenu(); if (S.tr) closeTrainer(); }
    if ((e.ctrlKey || e.metaKey) && e.code === "Space") { e.preventDefault(); togglePlay(); return; }
    if (e.code === "Space" && !inField) { e.preventDefault(); togglePlay(); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const map = {
        Comma: () => seekTo(audio.currentTime - 5),
        Period: () => seekTo(audio.currentTime + 5),
        KeyX: () => redactSelection(false, false),
        KeyM: () => addMarkerAtPlayhead(),
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

  // ------------------------------------------------------------------ account
  async function loadMe() {
    try {
      const m = await (await fetch("/api/auth/me")).json();
      S.me = m.user; S.accounts = m.accounts;
      if (!m.accounts) {  // single-user mode: only the benchmark tools
        $("acctWrap").classList.remove("hidden");
        $("acctName").textContent = "Tools";
        $("acctAvatar").textContent = "⚙";
        $("adminLink").classList.remove("hidden");
        $("adminLink").href = "admin.html#bench";
        $("adminLink").querySelector("b").textContent = "Model benchmarks";
        $("adminLink").querySelector("small").textContent = "Compare how accurate your models are";
        $("pwBtn").classList.add("hidden"); $("logoutBtn").classList.add("hidden");
        return;
      }
      if (!m.user) return;
      $("acctWrap").classList.remove("hidden");
      $("acctName").textContent = m.user.name || m.user.username;
      $("acctAvatar").textContent = (m.user.name || m.user.username || "?").trim()[0].toUpperCase();
      $("adminLink").classList.toggle("hidden", !m.user.admin);
      $("pwBtn").classList.toggle("hidden", !!m.user.env_admin);
    } catch { /* single-user mode */ }
  }
  bindMenu("acctBtn");
  $("logoutBtn").onclick = async () => {
    await flushSave();
    await fetch("/api/auth/logout", { method: "POST" });
    location.href = "/login.html";
  };
  const openModal = (id) => { closeMenus(); S.modal = id; $(id).classList.remove("hidden"); };
  const closeModal = () => { if (S.modal) $(S.modal).classList.add("hidden"); S.modal = null; };
  $("pwBtn").onclick = () => { $("pwForm").reset(); $("pwError").textContent = ""; openModal("pwModal"); setTimeout(() => $("pwCurrent").focus(), 30); };
  $("pwClose").onclick = closeModal;
  $("pwForm").onsubmit = async (e) => {
    e.preventDefault();
    if ($("pwNew").value !== $("pwNew2").value) { $("pwError").textContent = "The new passwords don't match"; return; }
    try {
      await api("/api/auth/password", { method: "POST", body: JSON.stringify({ current: $("pwCurrent").value, new: $("pwNew").value }) });
      closeModal(); toast("Password changed");
    } catch (err) { $("pwError").textContent = err.message; }
  };

  // ------------------------------------------------------------------ versions
  async function loadVersions() {
    const f = S.current;
    S.versions = [];
    if (f && f.has_transcript) {
      try { S.versions = await api(`/api/files/${f.id}/versions`); } catch { S.versions = []; }
    }
    if (S.current !== f) return;
    renderVersions();
  }
  function renderVersions() {
    const v = S.versions || [];
    $("versionsWrap").classList.toggle("hidden", v.length < 2);
    $("versionsBtn").textContent = `Versions (${v.length}) ▾`;
    const box = $("versionsMenu");
    box.innerHTML = "";
    box.append(el("div", "vp-head", "Each run is kept here. Switching keeps your edits in every version."));
    for (const ver of v) {
      const row = el("div", "vp-row" + (ver.active ? " active" : ""));
      const main = el("button", "vp-main");
      const when = ver.created ? new Date(ver.created * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
      main.append(el("b", null, ver.model || "transcript"));
      const bits = [when, `${ver.words} words`, ver.speakers ? `${ver.speakers} speakers` : null, ver.edited ? "edited" : null,
        ver.options?.vocabulary ? "custom terms" : null].filter(Boolean);
      main.append(el("small", null, bits.join(" · ")));
      if (ver.active) main.append(el("span", "vp-badge", "showing"));
      main.onclick = () => activateVersion(ver);
      row.append(main);
      if (!ver.active) {
        const del = el("button", "vp-del", "✕");
        del.title = "Delete this version";
        del.onclick = (e) => { e.stopPropagation(); deleteVersion(ver); };
        row.append(del);
      }
      box.append(row);
    }
  }
  bindMenu("versionsBtn");
  async function activateVersion(ver) {
    closeMenus();
    if (ver.active || !S.current) return;
    if (isBusy(S.current)) { toast("Wait for the current job to finish", true); return; }
    try {
      await flushSave();
      const t = await api(`/api/files/${S.current.id}/versions/${ver.id}/activate`, { method: "POST" });
      S.transcript = t; S.segs = t.segments; S.speakers = t.speakers || {}; S.markers = t.markers || S.markers;
      renderSegments(); renderSpeakers(); renderMarkers();
      await loadFiles(); loadVersions();
      toast(`Showing the ${ver.model || "earlier"} transcript`);
    } catch (e) { toast(e.message, true); }
  }
  async function deleteVersion(ver) {
    if (!confirm(`Delete the ${ver.model || ""} version from ${new Date(ver.created * 1000).toLocaleString()}? This can't be undone.`)) return;
    try {
      S.versions = (await api(`/api/files/${S.current.id}/versions/${ver.id}`, { method: "DELETE" })).versions;
      renderVersions(); toast("Version deleted");
    } catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------------ file actions
  $("renameBtn").onclick = () => {
    closeMenus();
    const t = $("fileTitle"); t.focus();
    const r = document.createRange(); r.selectNodeContents(t);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  };
  async function duplicateFile(f) {
    try {
      if (S.current?.id === f.id) await flushSave();
      const m = await api(`/api/files/${f.id}/copy`, { method: "POST" });
      await loadFiles(); await openFile(m.id);
      const canRun = m.has_audio && !isBusy(m);
      toast(`Made a copy: ${m.name}`, false, canRun ? { label: "Transcribe it with another model", fn: () => openReprocess() } : null);
    } catch (e) { toast(e.message, true); }
  }
  $("copyFileBtn").onclick = () => { closeMenus(); if (S.current) duplicateFile(S.current); };
  function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    const ta = el("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.append(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error("Copy failed"));
  }
  $("copyTextBtn").onclick = async () => {
    closeMenus();
    if (!S.current || !S.transcript) return;
    try {
      await flushSave();
      const r = await fetch(`/api/files/${S.current.id}/download?format=txt`);
      if (!r.ok) throw new Error("Couldn't build the text");
      await copyToClipboard(await r.text());
      toast("Transcript copied");
    } catch (e) { toast(e.message, true); }
  };

  // ------------------------------------------------------------------ find & replace
  const TOKEN_SPLIT = /(\[REDACTED(?::[a-z0-9]+)?\])/;
  function frRegex() {
    const q = $("frFind").value;
    if (!q) return null;
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp($("frWord").checked ? `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])` : esc, "gu" + ($("frCase").checked ? "" : "i"));
  }
  function frMatches() {
    const re = frRegex();
    const out = [];
    if (!re) return out;
    S.segs.forEach((s, i) => {
      let n = 0;
      for (const part of s.text.split(TOKEN_SPLIT)) if (!TOKEN_SPLIT.test(part)) n += (part.match(re) || []).length;
      if (n) out.push({ i, n });
    });
    return out;
  }
  function frUpdate() {
    const m = frMatches();
    const total = m.reduce((a, x) => a + x.n, 0);
    $("frCount").textContent = $("frFind").value ? (total ? `${total} match${total > 1 ? "es" : ""} in ${m.length} line${m.length > 1 ? "s" : ""}` : "No matches") : "";
    $("frApply").disabled = !total;
    $("frApply").textContent = total ? `Replace ${total}` : "Replace all";
    const ul = $("frPreview"); ul.innerHTML = "";
    const re = frRegex();
    for (const { i } of m.slice(0, 6)) {
      const li = el("li");
      li.append(el("span", "fr-time", fmt(S.segs[i].start)));
      const txt = el("span");
      let last = 0; const t = S.segs[i].text.replace(/\[REDACTED(?::[a-z0-9]+)?\]/g, "[REDACTED]");
      for (const mm of t.matchAll(re)) {
        txt.append(document.createTextNode(t.slice(last, mm.index)));
        txt.append(el("mark", null, mm[0])); last = mm.index + mm[0].length;
      }
      txt.append(document.createTextNode(t.slice(last)));
      li.append(txt);
      li.onclick = () => { closeModal(); rowEl(i)?.scrollIntoView({ block: "center" }); };
      ul.append(li);
    }
    if (m.length > 6) ul.append(el("li", "muted", `…and ${m.length - 6} more lines`));
  }
  function openFind() {
    if (!S.current || !S.segs.length) return;
    if (isBusy(S.current)) { toast("Wait for the current job to finish", true); return; }
    const sel = getSelection().toString().trim();
    if (sel && sel.length < 60 && !sel.includes("\n")) $("frFind").value = sel;
    openModal("findModal"); frUpdate();
    setTimeout(() => { $("frFind").focus(); $("frFind").select(); }, 30);
  }
  $("findBtn").onclick = openFind;
  $("frClose").onclick = closeModal;
  for (const id of ["frFind", "frCase", "frWord"]) $(id).addEventListener("input", frUpdate);
  $("frReplace").addEventListener("keydown", (e) => { if (e.key === "Enter" && !$("frApply").disabled) $("frApply").click(); });
  $("frFind").addEventListener("keydown", (e) => { if (e.key === "Enter") $("frReplace").focus(); });
  $("frApply").onclick = () => {
    const re = frRegex(); if (!re) return;
    const rep = $("frReplace").value;
    let changed = 0, count = 0;
    for (const { i } of frMatches()) {
      const s = S.segs[i];
      const text = s.text.split(TOKEN_SPLIT).map((part) => TOKEN_SPLIT.test(part) ? part : part.replace(re, () => { count++; return rep; })).join("");
      if (text !== s.text) {
        s.text = text; s.edited = true;
        if (s.words?.length && s.words.map((w) => w.w).join("").trim() !== text.trim()) s.words = [];  // re-timed in the browser
        changed++;
      }
    }
    closeModal();
    renderSegments(); queueSave();
    toast(`Replaced ${count} in ${changed} line${changed === 1 ? "" : "s"}`);
  };
  for (const id of ["findModal", "pwModal"]) {
    let down = false;
    $(id).addEventListener("mousedown", (e) => { down = e.target.id === id; });
    $(id).addEventListener("click", (e) => { if (e.target.id === id && down) closeModal(); });
  }

  // ------------------------------------------------------------------ search clear
  function syncSearchClear() { $("searchClear").classList.toggle("hidden", !$("searchInput").value); }
  $("searchInput").addEventListener("input", syncSearchClear);
  $("searchClear").onclick = () => { $("searchInput").value = ""; syncSearchClear(); applySearch(); $("searchInput").focus(); };

  // ------------------------------------------------------------------ sounds (laughs, coughs …)
  S.sounds = null;
  async function loadSounds() {
    const f = S.current;
    S.sounds = null;
    if (!f) return;
    try { const r = await api(`/api/files/${f.id}/sounds`); if (S.current === f) S.sounds = r; } catch { S.sounds = null; }
    if (S.current === f) markSoundRows();
  }
  /** Small emoji badges on lines where a sound happened (click: play it). */
  function markSoundRows() {
    document.querySelectorAll(".seg-sounds").forEach((x) => x.remove());
    const ev = S.sounds?.events || [];
    if (!ev.length || !S.segs.length) return;
    const groups = S.sounds.groups || {};
    const per = new Map();
    for (const e of ev) {
      let best = -1, bd = Infinity;
      S.segs.forEach((s, i) => {
        const d = e.start > s.end ? e.start - s.end : s.start > e.end ? s.start - e.end : 0;
        if (d < bd || (d === bd && e.speaker && s.speaker === e.speaker)) { bd = d; best = i; }
      });
      if (best >= 0 && bd < 3) { if (!per.has(best)) per.set(best, []); per.get(best).push(e); }
    }
    for (const [i, list] of per) {
      const left = rowEl(i)?.querySelector(".seg-left");
      if (!left) continue;
      const box = el("span", "seg-sounds");
      for (const e of list.slice(0, 4)) {
        const b = el("button", "snd", groups[e.label]?.emoji || "•");
        b.title = `${e.label}${e.speaker ? ` · ${spkName(e.speaker)}${e.sure ? "" : " (guess)"}` : ""} at ${fmt(e.start)} · ${Math.round(e.p * 100)}% sure · click to hear it`;
        b.onclick = (x) => { x.stopPropagation(); playSpan(e.start - 0.5, e.end + 0.5); };
        box.append(b);
      }
      left.append(box);
    }
  }
  function playSpan(a, b) {
    seekTo(Math.max(0, a), true, true);
    S.stopAt = b;
  }

  // ------------------------------------------------------------------ stats
  const STOP = new Set(("a about above after again against all am an and any are aren't as at be because been before being below between both but by " +
    "can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he " +
    "he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't " +
    "my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than " +
    "that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very " +
    "was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you " +
    "you'd you'll you're you've your yours yourself yourselves yeah yes okay ok oh um uh uhm hmm mm mhm mm-hmm like just know get got go going gonna wanna gotta " +
    "really right well also one two thing things think said say says see mean kind sort lot also even still back way would could much many now then thats dont " +
    "im youre its cause 'cause ah eh huh er ya yep nope").split(" "));
  const FILLERS = ["um", "uh", "uhm", "er", "ah", "hmm", "like", "you know", "i mean", "sort of", "kind of", "basically", "literally", "actually", "right", "so yeah"];
  const WRITTEN = /\((?:laugh|laughs|laughing|laughter|chuckles?|giggles?)\)|\[(?:laugh|laughs|laughing|laughter)\]|\b(?:ha){2,}\b|\bhehe+\b|\blol\b/gi;
  const tokens = (text) => text.replace(/\[REDACTED(?::[a-z0-9]+)?\]/g, " ").toLowerCase().replace(/[’‘]/g, "'")
    .split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "")).filter(Boolean);

  function computeStats() {
    const segs = S.segs.filter((s) => s.text.trim());
    const ids = Object.keys(S.speakers);
    const sp = {};
    const blank = () => ({ talk: 0, words: 0, turns: 0, questions: 0, fillers: {}, freq: new Map(), grams: new Map(), longest: null,
      interrupts: 0, quick: 0, written: 0, longestWord: "", sounds: {} });
    for (const id of ids) sp[id] = blank();
    const allFreq = new Map(), allGrams = new Map();
    let prev = null, run = null, total = 0, longestGap = null;
    const runs = [];
    for (const s of segs) {
      const id = s.speaker || "?";
      if (!sp[id]) sp[id] = blank();
      const st = sp[id];
      const dur = Math.max(0, s.end - s.start);
      const toks = tokens(s.text);
      st.talk += dur; st.words += toks.length; total += toks.length;
      st.questions += (s.text.match(/\?/g) || []).length;
      st.written += (s.text.match(WRITTEN) || []).length;
      const joined = " " + toks.join(" ") + " ";
      for (const f of FILLERS) {
        const n = joined.split(" " + f + " ").length - 1;
        if (n) st.fillers[f] = (st.fillers[f] || 0) + n;
      }
      for (let k = 0; k < toks.length; k++) {
        const w = toks[k];
        if (w.length > st.longestWord.length && /^[\p{L}'-]+$/u.test(w) && w.length < 25) st.longestWord = w;
        if (!STOP.has(w) && w.length > 2 && !/^\d+$/.test(w)) {
          st.freq.set(w, (st.freq.get(w) || 0) + 1); allFreq.set(w, (allFreq.get(w) || 0) + 1);
        }
        for (const n of [2, 3]) {
          const g = toks.slice(k, k + n);
          if (g.length < n || g.every((x) => STOP.has(x)) || STOP.has(g[0]) && STOP.has(g[n - 1])) continue;
          const key = g.join(" ");
          st.grams.set(key, (st.grams.get(key) || 0) + 1); allGrams.set(key, (allGrams.get(key) || 0) + 1);
        }
      }
      if (prev) {
        const gap = s.start - prev.end;
        if (!longestGap || gap > longestGap.gap) longestGap = { gap, at: prev.end };
        if (prev.speaker !== s.speaker) {
          if (gap < -0.3) st.interrupts++;
          else if (gap < 0.25) st.quick++;
        }
      }
      if (run && run.id === id) { run.end = s.end; run.words += toks.length; run.n++; }
      else { if (run) runs.push(run); run = { id, start: s.start, end: s.end, words: toks.length, n: 1, text: s.text }; }
      prev = s;
    }
    if (run) runs.push(run);
    for (const r of runs) {
      const st = sp[r.id];
      st.turns++;
      if (!st.longest || r.end - r.start > st.longest.end - st.longest.start) st.longest = r;
    }
    // sounds per speaker
    for (const e of S.sounds?.events || []) {
      if (e.speaker && sp[e.speaker]) sp[e.speaker].sounds[e.label] = (sp[e.speaker].sounds[e.label] || 0) + 1;
    }
    const talkTotal = Object.values(sp).reduce((a, x) => a + x.talk, 0);
    const duration = S.current?.duration || (segs.length ? segs[segs.length - 1].end : 0);
    // busiest 5 minutes
    const bucket = 300;
    const perBucket = new Map();
    for (const s of segs) { const b = Math.floor(s.start / bucket); perBucket.set(b, (perBucket.get(b) || 0) + tokens(s.text).length); }
    let busiest = null;
    for (const [b, n] of perBucket) if (!busiest || n > busiest.n) busiest = { b, n };
    return { sp, ids: Object.keys(sp).filter((id) => sp[id].words || sp[id].talk), runs, total, talkTotal, duration, longestGap, busiest, bucket, allFreq, allGrams, segs };
  }

  function topN(map, n, min = 2) { return [...map].filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1]).slice(0, n); }
  /** Phrases this speaker says much more than the others (log-odds-ish). */
  function signature(st, all, n) {
    return [...st.grams].filter(([g, c]) => c >= 3 && g.split(" ").filter((w) => !STOP.has(w)).length >= 1)
      .map(([g, c]) => [g, c, c / ((all.get(g) || c) - c + 1)])
      .sort((a, b) => b[2] - a[2] || b[1] - a[1]).slice(0, n);
  }
  const mmss = (sec) => fmt(Math.round(sec || 0));
  function timeLink(t, label) {
    const b = el("button", "linklike", label || fmt(t));
    b.onclick = () => { closeModal(); seekTo(t, false, true); };
    return b;
  }

  function renderStats() {
    const body = $("statsBody");
    body.innerHTML = "";
    if (!S.segs.length) { body.append(el("p", "muted", "No transcript yet.")); return; }
    const X = computeStats();
    const names = (id) => (id === "?" ? "Unassigned" : spkName(id));
    const color = (id) => (id === "?" ? "var(--muted)" : spkColor(id));

    // headline tiles
    const tiles = el("div", "st-tiles");
    const tile = (v, l) => { const t = el("div", "st-tile"); t.append(el("b", null, v), el("span", null, l)); tiles.append(t); };
    tile(mmss(X.duration), "recording");
    tile(X.total.toLocaleString(), "words");
    tile(String(X.ids.length), X.ids.length === 1 ? "speaker" : "speakers");
    tile(X.duration ? Math.round((X.total / X.duration) * 60) + "" : "–", "words per minute");
    tile(String(X.runs.length), "turns");
    if (X.longestGap && X.longestGap.gap > 1) tile(X.longestGap.gap.toFixed(1) + "s", "longest silence");
    body.append(tiles);

    // awards
    if (X.ids.length >= 2) {
      const aw = el("div", "st-awards");
      const award = (emoji, title, pick, fmtv) => {
        const id = X.ids.reduce((a, b) => (pick(X.sp[b]) > pick(X.sp[a]) ? b : a));
        const v = pick(X.sp[id]);
        if (!v || X.ids.some((o) => o !== id && pick(X.sp[o]) === v)) return;  // no award for a tie
        const c = el("div", "st-award");
        const dot = el("i"); dot.style.background = color(id);
        c.append(el("span", "em", emoji), el("b", null, title));
        const who = el("span"); who.append(dot, document.createTextNode(" " + names(id) + " · " + fmtv(v, X.sp[id])));
        c.append(who); aw.append(c);
      };
      award("🗣️", "Chatterbox", (s) => s.words, (v) => `${v.toLocaleString()} words`);
      award("⚡", "Speed talker", (s) => (s.talk > 30 ? s.words / (s.talk / 60) : 0), (v) => `${Math.round(v)} wpm`);
      award("🎤", "Longest monologue", (s) => (s.longest ? s.longest.end - s.longest.start : 0), (v) => mmss(v));
      award("❓", "Question master", (s) => s.questions, (v) => `${v} question${v === 1 ? "" : "s"}`);
      award("😂", "Giggler", (s) => (s.sounds.Laughter || 0) + s.written, (v) => `${v} laugh${v === 1 ? "" : "s"}`);
      award("🤔", "Um-ometer", (s) => (s.words > 50 ? (Object.entries(s.fillers).filter(([f]) => ["um", "uh", "uhm", "er", "ah", "hmm"].includes(f)).reduce((a, [, n]) => a + n, 0) / s.words) * 100 : 0), (v) => `${v.toFixed(1)} per 100 words`);
      award("✋", "Interrupter", (s) => s.interrupts, (v) => `${v} time${v === 1 ? "" : "s"}`);
      body.append(aw);
    }

    // talk share bars + timeline
    const share = el("section", "st-section");
    share.append(el("h4", null, "Who talked"));
    for (const id of [...X.ids].sort((a, b) => X.sp[b].talk - X.sp[a].talk)) {
      const st = X.sp[id];
      const row = el("div", "st-share");
      const pct = X.talkTotal ? (st.talk / X.talkTotal) * 100 : 0;
      const bar = el("div", "st-bar");
      const fill = el("i"); fill.style.width = Math.max(1, pct) + "%"; fill.style.background = color(id);
      bar.append(fill);
      row.append(el("span", "st-name", names(id)), bar, el("span", "st-val", `${mmss(st.talk)} · ${Math.round(pct)}%`));
      share.append(row);
    }
    share.append(timelineChart(X, names, color));
    body.append(share);

    // per-speaker cards
    const cards = el("div", "st-cards");
    for (const id of X.ids) {
      const st = X.sp[id];
      const card = el("section", "st-card");
      card.style.setProperty("--spk", color(id));
      card.append(el("h4", null, names(id)));
      const dl = el("dl", "st-dl");
      const item = (k, v) => { dl.append(el("dt", null, k)); const dd = el("dd"); typeof v === "string" ? (dd.textContent = v) : dd.append(v); dl.append(dd); };
      item("Talk time", `${mmss(st.talk)} (${X.talkTotal ? Math.round((st.talk / X.talkTotal) * 100) : 0}%)`);
      item("Words", `${st.words.toLocaleString()} · ${st.talk > 5 ? Math.round(st.words / (st.talk / 60)) : "–"} per minute`);
      item("Turns", `${st.turns} · avg ${st.turns ? mmss(st.talk / st.turns) : "–"}`);
      if (st.longest) {
        const v = el("span");
        v.append(document.createTextNode(`${mmss(st.longest.end - st.longest.start)} (${st.longest.words} words) at `), timeLink(st.longest.start));
        item("Longest uninterrupted", v);
      }
      item("Questions asked", String(st.questions));
      const um = Object.entries(st.fillers).sort((a, b) => b[1] - a[1]);
      const umTotal = um.reduce((a, [, n]) => a + n, 0);
      item("Filler words", umTotal ? `${umTotal} (${((umTotal / Math.max(1, st.words)) * 100).toFixed(1)} per 100 words) · ${um.slice(0, 3).map(([f, n]) => `"${f}" ×${n}`).join(", ")}` : "none");
      if (X.ids.length > 1) item("Jumped in", `${st.interrupts} interruptions · ${st.quick} instant replies`);
      const vocab = st.freq.size;
      item("Vocabulary", `${vocab.toLocaleString()} different words` + (st.longestWord.length > 9 ? ` · biggest: "${st.longestWord}"` : ""));
      const snd = Object.entries(st.sounds).sort((a, b) => b[1] - a[1]);
      if (snd.length || st.written) {
        const g = S.sounds?.groups || {};
        item("Sounds", [...snd.map(([l, n]) => `${g[l]?.emoji || ""} ${n} ${l.toLowerCase()}${n > 1 && !/s$/.test(l) ? "s" : ""}`), st.written ? `${st.written} written laughs` : null].filter(Boolean).join(" · "));
      }
      card.append(dl);
      const words = topN(st.freq, 12);
      if (words.length) {
        card.append(el("div", "st-sub", "Most used words"));
        const chips = el("div", "st-chips");
        const max = words[0][1];
        for (const [w, n] of words) {
          const c = el("button", "st-chip");
          c.style.setProperty("--w", (0.35 + 0.65 * (n / max)).toFixed(2));
          c.append(document.createTextNode(w), el("small", null, String(n)));
          c.title = `Search for "${w}"`;
          c.onclick = () => { closeModal(); $("searchInput").value = w; syncSearchClear(); applySearch(); };
          chips.append(c);
        }
        card.append(chips);
      }
      const sig = signature(st, X.allGrams, 4);
      if (sig.length) {
        card.append(el("div", "st-sub", "Signature phrases"));
        const chips = el("div", "st-chips");
        for (const [g, n] of sig) {
          const c = el("button", "st-chip phrase");
          c.append(document.createTextNode(`“${g}”`), el("small", null, String(n)));
          c.onclick = () => { closeModal(); $("searchInput").value = g; syncSearchClear(); applySearch(); };
          chips.append(c);
        }
        card.append(chips);
      }
      cards.append(card);
    }
    body.append(cards);

    // sounds section
    const ss = el("section", "st-section");
    ss.append(el("h4", null, "Laughs, coughs & other sounds"));
    const snd = S.sounds;
    if (!snd || !snd.available) {
      ss.append(el("p", "muted small", "Sound detection isn't available in this container."));
    } else if (!snd.detected) {
      ss.append(el("p", "muted small", "Listen to the audio for laughter, coughs, sneezes, sighs, applause, music and pets, and guess who made each sound. Takes about 30 seconds per hour of audio on the CPU."));
      const go = el("button", "btn primary sm", "Detect sounds");
      go.disabled = !S.current?.has_audio || isBusy(S.current);
      go.onclick = async () => {
        try {
          S.current = await api(`/api/files/${S.current.id}/sounds`, { method: "POST" });
          S.pendingSounds = S.current.id;
          closeModal(); renderHeader(); await loadFiles(); schedulePoll();
        } catch (e) { toast(e.message, true); }
      };
      ss.append(go);
    } else {
      const counts = {};
      for (const e of snd.events) counts[e.label] = (counts[e.label] || 0) + 1;
      const order = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      if (!order.length) ss.append(el("p", "muted small", "No laughs, coughs or other sounds were detected."));
      const tl = el("div", "st-chips");
      for (const [l, n] of order) tl.append(el("span", "st-chip static", `${snd.groups[l]?.emoji || ""} ${l} ${n}`));
      ss.append(tl);
      const list = el("ul", "st-events");
      for (const e of snd.events.slice(0, 200)) {
        const li = el("li");
        li.append(el("span", "em", snd.groups[e.label]?.emoji || "•"), timeLink(e.start));
        li.append(el("span", null, e.label + (e.speaker ? ` · ${names(e.speaker)}${e.sure ? "" : " (guess)"}` : "")));
        const play = el("button", "linklike", "▶ play");
        play.onclick = () => playSpan(e.start - 0.5, e.end + 0.5);
        li.append(play);
        list.append(li);
      }
      ss.append(list);
      const again = el("button", "btn sm", "Detect again");
      again.onclick = async () => { try { S.current = await api(`/api/files/${S.current.id}/sounds`, { method: "POST" }); S.pendingSounds = S.current.id; closeModal(); renderHeader(); await loadFiles(); schedulePoll(); } catch (e) { toast(e.message, true); } };
      ss.append(el("p", "muted small", "Detected by a small sound model, so expect some misses and false alarms. Who made each sound is matched by voice when it's clear, otherwise it's whoever was talking (marked guess)."), again);
    }
    body.append(ss);
  }

  /** Stacked bars of talk time per slice of the recording, with hover details. */
  function timelineChart(X, names, color) {
    const wrap = el("div", "st-timeline");
    const n = Math.min(40, Math.max(8, Math.round(X.duration / 120)));
    const step = X.duration / n || 1;
    const slices = Array.from({ length: n }, () => ({}));
    for (const s of X.segs) {
      const id = s.speaker || "?";
      let a = s.start;
      while (a < s.end) {
        const k = Math.min(n - 1, Math.floor(a / step));
        const b = Math.min(s.end, (k + 1) * step);
        slices[k][id] = (slices[k][id] || 0) + (b - a);
        if (b <= a) break;
        a = b;
      }
    }
    const legend = el("div", "st-legend");
    for (const id of X.ids) { const l = el("span"); const d = el("i"); d.style.background = color(id); l.append(d, document.createTextNode(names(id))); legend.append(l); }
    const plot = el("div", "st-plot");
    slices.forEach((sl, k) => {
      const col = el("button", "st-col");
      const from = k * step, to = (k + 1) * step;
      for (const id of X.ids) {
        const v = sl[id] || 0;
        if (!v) continue;
        const seg = el("i"); seg.style.height = Math.min(100, (v / step) * 100) + "%"; seg.style.background = color(id);
        col.append(seg);
      }
      col.dataset.tip = `${fmt(from)}–${fmt(to)}\n` + X.ids.map((id) => `${names(id)}: ${mmss(sl[id] || 0)}`).join("\n");
      col.onmouseenter = (e) => showTip(col, col.dataset.tip);
      col.onmouseleave = hideTip;
      col.onclick = () => { closeModal(); seekTo(from, false, true); };
      plot.append(col);
    });
    const axis = el("div", "st-axis");
    axis.append(el("span", null, "0:00"), el("span", null, fmt(X.duration / 2)), el("span", null, fmt(X.duration)));
    wrap.append(el("div", "st-sub", "Talk time across the recording (click a bar to jump there)"), legend, plot, axis);
    return wrap;
  }
  function showTip(anchor, text) {
    const t = $("chartTip");
    t.textContent = text; t.classList.remove("hidden");
    const r = anchor.getBoundingClientRect();
    t.style.left = Math.min(innerWidth - t.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - t.offsetWidth / 2)) + "px";
    t.style.top = (r.top - t.offsetHeight - 8) + "px";
  }
  function hideTip() { $("chartTip").classList.add("hidden"); }

  $("statsBtn").onclick = async () => {
    if (!S.current || !S.segs.length) { toast("Transcribe the file first"); return; }
    await flushSave();
    if (!S.sounds) await loadSounds();
    renderStats();
    openModal("statsModal");
  };
  $("stClose").onclick = () => { hideTip(); closeModal(); };
  {
    let down = false;
    $("statsModal").addEventListener("mousedown", (e) => { down = e.target.id === "statsModal"; });
    $("statsModal").addEventListener("click", (e) => { if (e.target.id === "statsModal" && down) { hideTip(); closeModal(); } });
  }

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
    await loadMe();
    await loadConfig();
    loadVoices();
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
