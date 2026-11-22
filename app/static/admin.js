(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    });
    if (res.status === 401) { location.href = "/login.html?next=/admin.html"; throw new Error("Please sign in"); }
    if (res.status === 403) { location.href = "/"; throw new Error("Admins only"); }
    if (!res.ok) {
      let msg = res.statusText;
      try { const j = await res.json(); msg = j.detail || msg; } catch { /* ignore */ }
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return res.json();
  }
  let toastTimer;
  function toast(msg, isError = false) {
    const t = $("toast");
    t.textContent = msg; t.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = "toast"), 3500);
  }
  const fmtDur = (sec) => {
    sec = Math.round(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  };
  const fmtSize = (b) => b > 1e9 ? (b / 1e9).toFixed(1) + " GB" : b > 1e6 ? (b / 1e6).toFixed(0) + " MB" : Math.round(b / 1e3) + " KB";
  const fmtWhen = (t) => t ? new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never";
  const pct = (x, d = 1) => x == null ? "–" : (x * 100).toFixed(d) + "%";

  // ---- modals
  let openId = null;
  function openModal(id) { openId = id; $(id).classList.remove("hidden"); }
  function closeModal() { if (openId) $(openId).classList.add("hidden"); openId = null; }
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeModal));
  document.querySelectorAll(".modal").forEach((m) => {
    let down = false;
    m.addEventListener("mousedown", (e) => { down = e.target === m; });
    m.addEventListener("click", (e) => { if (e.target === m && down) closeModal(); });
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openId) closeModal(); });

  // ---- tabs
  function showTab(name) {
    document.querySelectorAll(".admin-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    document.querySelectorAll(".admin-tab").forEach((s) => s.classList.toggle("hidden", s.id !== "tab-" + name));
    history.replaceState(null, "", "#" + name);
    if (name === "bench") loadBenches();
  }
  document.querySelectorAll(".admin-tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

  // ================================================================ users
  async function loadUsers() {
    const users = await api("/api/admin/users");
    const tb = $("userTable").querySelector("tbody");
    tb.innerHTML = "";
    for (const u of users) {
      const tr = el("tr", u.disabled ? "disabled" : "");
      const who = el("td");
      const cell = el("div", "user-cell");
      const av = el("span", "acct-avatar", (u.name || u.username)[0].toUpperCase());
      const nm = el("div", "who");
      nm.append(el("b", null, u.name || u.username), el("small", "muted", "@" + u.username + (u.me ? " · you" : "")));
      cell.append(av, nm);
      who.append(cell);
      const role = el("td");
      role.append(el("span", "pill " + (u.admin ? "admin" : "user"), u.admin ? "Admin" : "User"));
      if (u.env_admin) role.append(el("small", "muted block", "from container settings"));
      if (u.disabled) role.append(el("span", "pill off", "Disabled"));
      tr.append(who, role, el("td", "num", u.files), el("td", "num", fmtDur(u.seconds)), el("td", "num", fmtSize(u.bytes)),
        el("td", "muted", fmtWhen(u.last_login)));
      const act = el("td", "row-actions");
      if (!u.env_admin) {
        act.append(btn("Reset password", () => resetPassword(u)));
        if (!u.me) {
          act.append(btn(u.admin ? "Remove admin" : "Make admin", () => patchUser(u, { admin: !u.admin })));
          act.append(btn(u.disabled ? "Enable" : "Disable", () => patchUser(u, { disabled: !u.disabled })));
          act.append(btn("Delete", () => deleteUser(u), "danger"));
        }
      } else {
        act.append(el("small", "muted", "Change via ADMIN_PASSWORD"));
      }
      tr.append(act);
      tb.append(tr);
    }
  }
  function btn(label, fn, cls = "") {
    const b = el("button", "btn sm " + cls, label);
    b.onclick = fn;
    return b;
  }
  function genPassword() {
    const a = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const r = crypto.getRandomValues(new Uint32Array(14));
    return Array.from(r, (x) => a[x % a.length]).join("");
  }
  $("addUserBtn").onclick = () => {
    $("userForm").reset(); $("umError").textContent = "";
    openModal("userModal"); setTimeout(() => $("umUser").focus(), 30);
  };
  $("umGen").onclick = () => { $("umPass").value = genPassword(); };
  $("userForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const pw = $("umPass").value;
      const u = await api("/api/admin/users", { method: "POST", body: JSON.stringify({
        username: $("umUser").value.trim(), name: $("umName").value.trim(), password: pw, admin: $("umAdmin").checked }) });
      closeModal();
      await loadUsers();
      showCredentials(u.username, pw);
    } catch (err) { $("umError").textContent = err.message; }
  };
  function showCredentials(username, pw) {
    $("credText").textContent = `TranscribeR: ${location.origin}\nUsername: ${username}\nPassword: ${pw}`;
    openModal("credModal");
  }
  $("credCopy").onclick = async () => {
    const text = $("credText").textContent;
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const r = document.createRange(); r.selectNodeContents($("credText"));
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        if (!document.execCommand("copy")) throw new Error();
      }
      toast("Copied");
    } catch { toast("Select the text and copy it", true); }
  };
  async function resetPassword(u) {
    const pw = genPassword();
    if (!confirm(`Give ${u.name || u.username} a new password? They will be signed out everywhere.`)) return;
    try { await api(`/api/admin/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ password: pw }) }); showCredentials(u.username, pw); }
    catch (e) { toast(e.message, true); }
  }
  async function patchUser(u, body) {
    try { await api(`/api/admin/users/${u.id}`, { method: "PATCH", body: JSON.stringify(body) }); await loadUsers(); }
    catch (e) { toast(e.message, true); }
  }
  async function deleteUser(u) {
    if (!confirm(`Delete ${u.name || u.username}?`)) return;
    let files = "delete";
    if (u.files) {
      files = confirm(`${u.username} has ${u.files} file(s).\n\nOK = move them to your account\nCancel = delete them permanently`) ? "transfer" : "delete";
      if (files === "delete" && !confirm(`Permanently delete ${u.files} file(s) with their audio and transcripts?`)) return;
    }
    try {
      const r = await api(`/api/admin/users/${u.id}?files=${files}`, { method: "DELETE" });
      toast(r.transferred ? `Deleted. ${r.transferred} file(s) moved to you` : "User deleted");
      await loadUsers();
    } catch (e) { toast(e.message, true); }
  }

  // ================================================================ benchmarks
  const B = { list: [], current: null, config: null, files: [], timer: null, src: "file" };
  async function loadBenches(keep = true) {
    B.list = await api("/api/admin/bench");
    renderBenchList();
    const want = keep && B.current ? B.current.id : B.list[0]?.id;
    if (want && B.list.some((b) => b.id === want)) await openBench(want); else renderDetail(null);
  }
  function renderBenchList() {
    const ul = $("benchList");
    ul.innerHTML = "";
    if (!B.list.length) ul.append(el("li", "muted empty", "No benchmarks yet"));
    for (const b of B.list) {
      const li = el("li", B.current?.id === b.id ? "on" : "");
      const best = b.runs.filter((r) => r.metrics?.wer != null).sort((x, y) => x.metrics.wer - y.metrics.wer)[0];
      li.append(el("b", null, b.name), el("small", "muted", `${fmtDur(b.duration)} · ${b.ref_words} words · ${b.runs.length} run${b.runs.length === 1 ? "" : "s"}`));
      if (best) li.append(el("small", "best", `Best: ${best.model} · ${pct(1 - best.metrics.wer)} accurate`));
      li.onclick = () => openBench(b.id);
      ul.append(li);
    }
  }
  async function openBench(id) {
    B.current = await api(`/api/admin/bench/${id}`);
    renderBenchList();
    renderDetail(B.current);
    schedule();
  }
  function schedule() {
    clearTimeout(B.timer);
    const active = B.current?.runs.some((r) => r.status === "queued" || r.status === "running");
    if (active) B.timer = setTimeout(async () => {
      try {
        const id = B.current.id;
        const b = await api(`/api/admin/bench/${id}`);
        if (B.current?.id !== id) return;
        const was = JSON.stringify(B.current.runs.map((r) => r.status));
        B.current = b;
        renderRuns();
        if (was !== JSON.stringify(b.runs.map((r) => r.status))) { B.list = await api("/api/admin/bench"); renderBenchList(); }
      } catch { /* retry */ }
      schedule();
    }, 2500);
  }

  function renderDetail(b) {
    const box = $("benchDetail");
    box.innerHTML = "";
    if (!b) { box.append(el("div", "bench-empty muted", "Create a benchmark, or pick one on the left.")); return; }
    const head = el("div", "bd-head");
    const title = el("div");
    title.append(el("h3", null, b.name));
    const src = b.source?.file ? `from "${b.source.name}"` : b.source?.upload ? `uploaded ${b.source.upload}` : "";
    const reviewed = b.source?.reference === "transcript" && b.source.segments
      ? ` · reference: its transcript (${b.source.reviewed}/${b.source.segments} lines reviewed or edited)` : " · reference: provided text";
    title.append(el("p", "muted", `${fmtDur(b.duration)} ${src}${reviewed} · ${b.ref_words} reference words` +
      (b.ref_speakers.length ? ` · speakers: ${b.ref_speakers.join(", ")}` : " · no speaker labels in the reference")));
    const del = btn("Delete benchmark", async () => {
      if (!confirm(`Delete "${b.name}" and all its results?`)) return;
      await api(`/api/admin/bench/${b.id}`, { method: "DELETE" }); B.current = null; loadBenches(false);
    }, "danger");
    head.append(title, del);
    box.append(head);

    // run form
    const form = el("div", "bd-run");
    form.append(el("div", "tr-label", "Run models"));
    const models = el("div", "bd-models");
    const local = new Set(B.config?.local_models || []);
    for (const m of B.config?.models || []) {
      const lab = el("label", "chk");
      const cb = el("input"); cb.type = "checkbox"; cb.value = m;
      cb.checked = !b.runs.some((r) => r.model === m) && (local.has(m) || /moss|transcri|whisper|parakeet|canary/i.test(m));
      lab.append(cb, el("span", null, local.has(m) ? `${m} (built-in)` : m));
      models.append(lab);
    }
    if (!(B.config?.models || []).length) models.append(el("span", "muted", "No models available"));
    form.append(models);
    const row = el("div", "bd-opts");
    const spk = el("select"); spk.id = "brSpeakers";
    for (const [v, t] of [["auto", "Speakers: auto"], ["off", "Speakers: off"], ["2", "2 speakers"], ["3", "3 speakers"], ["4", "4 speakers"], ["5", "5 speakers"], ["6", "6 speakers"]]) spk.append(new Option(t, v));
    if (b.ref_speakers.length >= 2 && b.ref_speakers.length <= 6) spk.value = String(b.ref_speakers.length);
    const lang = el("input"); lang.placeholder = "Language (auto)"; lang.id = "brLang"; lang.size = 12;
    const vocab = el("input"); vocab.placeholder = "Names / terms (optional)"; vocab.id = "brVocab";
    const go = el("button", "btn primary", "Run selected");
    go.onclick = async () => {
      const picked = [...models.querySelectorAll("input:checked")].map((x) => x.value);
      if (!picked.length) { toast("Pick at least one model", true); return; }
      try {
        B.current = await api(`/api/admin/bench/${b.id}/runs`, { method: "POST", body: JSON.stringify({
          models: picked, speakers: spk.value, language: lang.value.trim() || null, vocabulary: vocab.value.trim() || null }) });
        renderRuns(); schedule(); toast(`${picked.length} run${picked.length > 1 ? "s" : ""} queued`);
        models.querySelectorAll("input").forEach((x) => (x.checked = false));
      } catch (e) { toast(e.message, true); }
    };
    row.append(spk, lang, vocab, go);
    form.append(row);
    form.append(el("p", "muted small", "Runs use the same pipeline as normal transcription (chunking, speaker detection, your saved voices) and go through the job queue one at a time."));
    box.append(form);

    const results = el("div", "bd-results"); results.id = "bdResults";
    box.append(results);
    renderRuns();

    const ref = el("details", "bd-ref");
    ref.append(el("summary", null, "Reference transcript"));
    ref.append(el("pre", null, b.reference_text || ""));
    box.append(ref);
  }

  function renderRuns() {
    const b = B.current;
    const box = $("bdResults");
    if (!box || !b) return;
    box.innerHTML = "";
    if (!b.runs.length) { box.append(el("p", "muted", "No runs yet. Pick models above and press Run.")); return; }
    const done = b.runs.filter((r) => r.metrics?.wer != null);
    const bestWer = Math.min(...done.map((r) => r.metrics.wer));
    const bestSpk = Math.max(...done.map((r) => r.metrics.speakers?.accuracy ?? -1));
    const fastest = Math.min(...done.map((r) => r.rtf ?? Infinity));
    const table = el("table", "admin-table bench-table");
    table.innerHTML = `<thead><tr><th>Model</th><th>Accuracy <small>(1 − WER)</small></th><th class="num">WER</th>
      <th class="num" title="substitutions / deletions / insertions">S / D / I</th><th class="num" title="character error rate">CER</th>
      <th class="num" title="share of words attributed to the right person">Speakers</th><th class="num">Time</th><th class="num">Speed</th><th></th></tr></thead>`;
    const tb = el("tbody");
    const order = [...b.runs].sort((x, y) => (x.metrics?.wer ?? 9) - (y.metrics?.wer ?? 9) || (x.created - y.created));
    for (const r of order) {
      const tr = el("tr");
      const m = r.metrics;
      const name = el("td");
      name.append(el("b", null, r.model));
      const o = r.options || {};
      const bits = [o.speakers && o.speakers !== "auto" ? `${o.speakers} spk` : null, o.language, o.vocabulary ? "terms" : null, r.device?.kind].filter(Boolean);
      if (bits.length) name.append(el("small", "muted block", bits.join(" · ")));
      tr.append(name);
      if (r.status !== "done") {
        const st = el("td", "status"); st.colSpan = 7;
        if (r.status === "running") {
          const p = r.progress || {};
          const frac = p.total ? (p.done || 0) / p.total : 0;
          st.append(el("span", "pill run", "Running"), el("span", "muted", ` ${p.stage || "starting"}${p.total ? ` · ${Math.round(frac * 100)}%` : ""}`));
        } else if (r.status === "queued") st.append(el("span", "pill", "Queued"));
        else if (r.status === "error") st.append(el("span", "pill off", "Failed"), el("span", "err", " " + (r.error || "")));
        else st.append(el("span", "pill", r.status));
        tr.append(st);
      } else {
        const acc = el("td");
        const bar = el("div", "acc-bar");
        const fill = el("i"); fill.style.width = Math.max(0, (1 - m.wer) * 100) + "%";
        bar.append(fill, el("span", null, pct(Math.max(0, 1 - m.wer))));
        if (m.wer === bestWer && done.length > 1) bar.classList.add("best");
        acc.append(bar);
        const spkTd = el("td", "num" + (m.speakers && m.speakers.accuracy === bestSpk && done.length > 1 ? " good" : ""),
          m.speakers ? pct(m.speakers.accuracy) : "–");
        if (m.speakers) spkTd.title = `${m.speakers.hyp_speakers} found vs ${m.speakers.ref_speakers} in reference`;
        tr.append(acc, el("td", "num" + (m.wer === bestWer && done.length > 1 ? " good" : ""), pct(m.wer)),
          el("td", "num muted", `${m.sub} / ${m.del} / ${m.ins}`), el("td", "num", pct(m.cer)), spkTd,
          el("td", "num", fmtDur(r.seconds)),
          el("td", "num" + (r.rtf === fastest && done.length > 1 ? " good" : ""), r.rtf ? `${(1 / r.rtf).toFixed(r.rtf > 0.1 ? 1 : 0)}×` : "–"));
      }
      const act = el("td", "row-actions");
      if (r.status === "done") act.append(btn("Differences", () => showDiff(r)));
      if (r.status === "queued" || r.status === "running") act.append(btn("Stop", async () => { await api(`/api/admin/bench/${b.id}/runs/${r.id}/cancel`, { method: "POST" }); openBench(b.id); }));
      else act.append(btn("✕", async () => { B.current = await api(`/api/admin/bench/${b.id}/runs/${r.id}`, { method: "DELETE" }); renderRuns(); loadBenchesQuiet(); }, "ghost"));
      tr.append(act);
      tb.append(tr);
    }
    table.append(tb);
    box.append(table);
    box.append(el("p", "muted small", "Text is compared after lower-casing and removing punctuation, so only word choice counts. Contractions and numbers count as written (\"it's\" ≠ \"it is\", \"10\" ≠ \"ten\"). Speed is how many times faster than real time."));
  }
  async function loadBenchesQuiet() { B.list = await api("/api/admin/bench"); renderBenchList(); }

  async function showDiff(r) {
    const d = await api(`/api/admin/bench/${B.current.id}/runs/${r.id}/diff`);
    $("dfTitle").textContent = `${r.model}: ${pct(Math.max(0, 1 - r.metrics.wer))} accurate`;
    B.diff = d.diff;
    renderDiff();
    openModal("diffModal");
  }
  function renderDiff() {
    const body = $("diffBody");
    body.innerHTML = "";
    const errorsOnly = $("dfErrorsOnly").checked;
    const frag = document.createDocumentFragment();
    const items = B.diff;
    items.forEach(([op, ref, hyp], k) => {
      if (op === "eq") {
        if (!errorsOnly) frag.append(document.createTextNode(ref + " "));
        else {
          const w = ref.split(" ");
          const prevErr = k > 0, nextErr = k < items.length - 1;
          const ctx = (prevErr ? w.slice(0, 4).join(" ") : "") + (w.length > 8 ? " … " : " ") + (nextErr ? w.slice(-4).join(" ") : "");
          frag.append(el("span", "d-ctx", ctx.trim() + " "));
        }
        return;
      }
      if (op === "sub") {
        const s = el("span", "d-sub"); s.append(el("s", null, ref), el("i", null, " → " + hyp)); frag.append(s, document.createTextNode(" "));
      } else if (op === "del") frag.append(el("span", "d-del", ref), document.createTextNode(" "));
      else if (op === "ins") frag.append(el("span", "d-ins", hyp), document.createTextNode(" "));
      else if (op === "red") frag.append(el("span", "d-red", hyp ? `[redacted: ${hyp}]` : "[redacted]"), document.createTextNode(" "));
    });
    body.append(frag);
  }
  $("dfErrorsOnly").onchange = renderDiff;

  // ---- new benchmark
  document.querySelectorAll("#benchForm .seg-switch button").forEach((b) => (b.onclick = () => {
    B.src = b.dataset.src;
    document.querySelectorAll("#benchForm .seg-switch button").forEach((x) => x.classList.toggle("on", x === b));
    $("bmFromFile").classList.toggle("hidden", B.src !== "file");
    $("bmFromUpload").classList.toggle("hidden", B.src !== "upload");
    $("bmRefMore").open = B.src === "upload";
    refSummary();
  }));
  function refSummary() {
    const has = $("bmRefText").value.trim() || $("bmRefFile").files.length;
    $("bmRefSummary").textContent = has ? "provided" : B.src === "file" ? "from the recording's transcript" : "required";
  }
  $("bmRefText").oninput = refSummary;
  $("bmRefFile").onchange = refSummary;
  $("newBenchBtn").onclick = async () => {
    $("benchForm").reset(); $("bmError").textContent = "";
    B.files = (await api("/api/files")).filter((f) => f.has_audio && f.status === "done");
    const sel = $("bmFile"); sel.innerHTML = "";
    if (!B.files.length) sel.append(new Option("No transcribed files in your library", ""));
    for (const f of B.files) sel.append(new Option(`${f.name} · ${fmtDur(f.duration)} · ${f.model || ""}`, f.id));
    document.querySelector('#benchForm .seg-switch button[data-src="file"]').click();
    openModal("benchModal");
  };
  $("benchForm").onsubmit = async (e) => {
    e.preventDefault();
    $("bmError").textContent = "";
    const fd = new FormData();
    fd.append("name", $("bmName").value.trim());
    if (B.src === "file") {
      if (!$("bmFile").value) { $("bmError").textContent = "Pick a recording"; return; }
      fd.append("source_fid", $("bmFile").value);
    } else {
      if (!$("bmAudio").files.length) { $("bmError").textContent = "Choose an audio file"; return; }
      fd.append("audio", $("bmAudio").files[0]);
    }
    if ($("bmRefText").value.trim()) fd.append("reference_text", $("bmRefText").value);
    if ($("bmRefFile").files.length) fd.append("reference_file", $("bmRefFile").files[0]);
    const go = $("bmCreate"); go.disabled = true; go.textContent = "Creating…";
    try {
      const b = await api("/api/admin/bench", { method: "POST", body: fd });
      closeModal();
      B.current = { id: b.id };
      await loadBenches();
    } catch (err) { $("bmError").textContent = err.message; }
    finally { go.disabled = false; go.textContent = "Create benchmark"; }
  };

  // ---- boot
  (async () => {
    try { B.config = await api("/api/config"); } catch { B.config = { models: [] }; }
    const me = await (await fetch("/api/auth/me")).json().catch(() => ({}));
    if (!me.accounts) {
      $("addUserBtn").classList.add("hidden");
      const card = $("userTable").closest(".card");
      card.innerHTML = "";
      card.append(el("p", "accounts-off", "Accounts are off, so anyone who can open TranscribeR sees everything. To require sign-in, set Admin username and Admin password (ADMIN_USERNAME / ADMIN_PASSWORD) in the container settings and restart. Existing files will belong to that admin."));
      showTab(location.hash === "#users" ? "users" : "bench");
      return;
    }
    await loadUsers();
    showTab(location.hash === "#bench" ? "bench" : "users");
  })();
})();
