(() => {
  const form = document.getElementById("loginForm");
  const err = document.getElementById("loginError");
  const next = new URLSearchParams(location.search).get("next");
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  fetch("/api/auth/me").then((r) => r.json()).then((m) => { if (!m.accounts || m.user) location.replace(safeNext); }).catch(() => {});
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    const btn = document.getElementById("loginBtn");
    btn.disabled = true; btn.textContent = "Signing in…";
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: form.username.value.trim(), password: form.password.value }),
      });
      if (r.ok) { location.replace(safeNext); return; }
      const body = await r.json().catch(() => ({}));
      err.textContent = body.detail || "Sign in failed";
      form.password.select();
    } catch {
      err.textContent = "Can't reach the server";
    } finally {
      btn.disabled = false; btn.textContent = "Sign in";
    }
  });
})();
