"""Users, passwords and sessions.

Accounts are enabled when ADMIN_USERNAME and ADMIN_PASSWORD are set (Unraid template). That admin
is (re)created from the environment on every start; other users are added on the admin page and
stored in /data/users.json with scrypt password hashes. Sessions are HMAC-signed cookies that
embed a per-user "password version", so changing a password or disabling a user logs them out.

Without ADMIN_* the app runs as before: single user, no login.
"""

from __future__ import annotations

import base64
import contextvars
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Optional

import settings as cfg

COOKIE = "tr_session"
SESSION_DAYS = 30
USERS_PATH = cfg.DATA_DIR / "users.json"
SECRET_PATH = cfg.DATA_DIR / "secret.key"
USERNAME_RE = re.compile(r"^[A-Za-z0-9._@-]{2,40}$")
LOCAL_USER = {"id": "local", "username": "local", "name": "You", "admin": True}

_lock = threading.Lock()
current: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("current_user", default=None)


def enabled() -> bool:
    return bool(cfg.ADMIN_USERNAME and cfg.ADMIN_PASSWORD)


# --------------------------------------------------------------------------- passwords


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def check_password(password: str, stored: str) -> bool:
    try:
        _, salt_b64, dk_b64 = stored.split("$")
        dk = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt_b64), n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(dk, base64.b64decode(dk_b64))
    except (ValueError, TypeError):
        return False


def password_problem(password: str) -> Optional[str]:
    if len(password) < 8:
        return "Password must be at least 8 characters"
    if len(password) > 200:
        return "Password is too long"
    return None


# --------------------------------------------------------------------------- user store


def _load() -> list[dict]:
    try:
        return json.loads(USERS_PATH.read_text()).get("users", [])
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save(users: list[dict]) -> None:
    USERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = USERS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps({"users": users}, indent=1))
    os.chmod(tmp, 0o600)
    tmp.replace(USERS_PATH)


def users() -> list[dict]:
    return _load()


def get(uid: str) -> Optional[dict]:
    return next((u for u in _load() if u["id"] == uid), None)


def by_username(username: str) -> Optional[dict]:
    key = username.strip().lower()
    return next((u for u in _load() if u["username"].lower() == key), None)


def public(u: dict) -> dict:
    return {k: u.get(k) for k in ("id", "username", "name", "admin", "disabled", "created", "last_login", "env_admin")}


def create(username: str, password: str, name: str = "", admin: bool = False) -> dict:
    username = username.strip()
    if not USERNAME_RE.match(username):
        raise ValueError("Usernames are 2–40 characters: letters, numbers, . _ @ -")
    if problem := password_problem(password):
        raise ValueError(problem)
    with _lock:
        all_users = _load()
        if any(u["username"].lower() == username.lower() for u in all_users):
            raise ValueError("That username is taken")
        u = {"id": secrets.token_hex(8), "username": username, "name": (name or username).strip()[:80],
             "admin": bool(admin), "hash": hash_password(password), "pwv": 1, "created": time.time()}
        all_users.append(u)
        _save(all_users)
    return u


def update(uid: str, **changes) -> dict:
    with _lock:
        all_users = _load()
        u = next((x for x in all_users if x["id"] == uid), None)
        if u is None:
            raise KeyError(uid)
        if "password" in changes:
            pw = changes.pop("password")
            if problem := password_problem(pw):
                raise ValueError(problem)
            u["hash"] = hash_password(pw)
            u["pwv"] = u.get("pwv", 1) + 1  # signs out existing sessions
        if changes.get("disabled"):
            u["pwv"] = u.get("pwv", 1) + 1
        for k in ("name", "admin", "disabled", "last_login"):
            if k in changes:
                u[k] = changes[k]
        _save(all_users)
        return u


def delete(uid: str) -> None:
    with _lock:
        _save([u for u in _load() if u["id"] != uid])


def ensure_env_admin() -> Optional[dict]:
    """Create/refresh the admin account defined in the container settings."""
    if not enabled():
        return None
    with _lock:
        all_users = _load()
        u = next((x for x in all_users if x.get("env_admin")), None) or next(
            (x for x in all_users if x["username"].lower() == cfg.ADMIN_USERNAME.lower()), None)
        if u is None:
            u = {"id": secrets.token_hex(8), "created": time.time(), "pwv": 1}
            all_users.append(u)
        changed_pw = not u.get("hash") or not check_password(cfg.ADMIN_PASSWORD, u["hash"])
        u.update(username=cfg.ADMIN_USERNAME, admin=True, disabled=False, env_admin=True)
        u.setdefault("name", cfg.ADMIN_USERNAME)
        if changed_pw:
            u["hash"] = hash_password(cfg.ADMIN_PASSWORD)
            u["pwv"] = u.get("pwv", 1) + 1
        _save(all_users)
        return u


# --------------------------------------------------------------------------- sessions


def _secret() -> bytes:
    if cfg.SESSION_SECRET:
        return cfg.SESSION_SECRET.encode()
    try:
        return SECRET_PATH.read_bytes()
    except FileNotFoundError:
        SECRET_PATH.parent.mkdir(parents=True, exist_ok=True)
        key = secrets.token_bytes(32)
        SECRET_PATH.write_bytes(key)
        os.chmod(SECRET_PATH, 0o600)
        return key


def make_session(u: dict) -> str:
    payload = base64.urlsafe_b64encode(json.dumps(
        {"u": u["id"], "v": u.get("pwv", 1), "e": int(time.time()) + SESSION_DAYS * 86400}).encode()).decode()
    sig = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def read_session(token: Optional[str]) -> Optional[dict]:
    if not token or "." not in token:
        return None
    payload, sig = token.rsplit(".", 1)
    if not hmac.compare_digest(sig, hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()):
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(payload.encode()))
    except (ValueError, json.JSONDecodeError):
        return None
    if data.get("e", 0) < time.time():
        return None
    u = get(data.get("u", ""))
    if not u or u.get("disabled") or u.get("pwv", 1) != data.get("v"):
        return None
    return u


# --------------------------------------------------------------------------- login throttling

_fails: dict[str, list[float]] = {}


def throttled(key: str) -> bool:
    now = time.time()
    recent = [t for t in _fails.get(key, []) if now - t < 300]
    _fails[key] = recent
    return len(recent) >= 8  # 8 failures per 5 minutes per IP


def record_failure(key: str) -> None:
    _fails.setdefault(key, []).append(time.time())


def user() -> dict:
    """The signed-in user for this request (LOCAL_USER when accounts are off)."""
    return current.get() or LOCAL_USER


def owner_id() -> str:
    return user()["id"]


def data_dir(uid: str) -> Path:
    d = cfg.DATA_DIR / "users" / re.sub(r"[^a-z0-9]", "", uid.lower())
    d.mkdir(parents=True, exist_ok=True)
    return d
