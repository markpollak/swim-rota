"""Authentication helpers using only the standard library.

Passwords: PBKDF2-HMAC-SHA256 with a per-user salt.
Tokens:    compact HMAC-signed "<user_id>.<expiry_ts>.<sig>" bearer tokens.
"""
import hashlib
import hmac
import os
import base64
import time

# In production set SWIM_SECRET in the environment. Falls back to a file-persisted
# random secret so tokens survive restarts during development.
_SECRET_FILE = os.path.join(os.path.dirname(__file__), ".secret")


def _load_secret() -> bytes:
    env = os.environ.get("SWIM_SECRET")
    if env:
        return env.encode()
    if os.path.exists(_SECRET_FILE):
        with open(_SECRET_FILE, "rb") as f:
            return f.read()
    secret = base64.urlsafe_b64encode(os.urandom(48))
    with open(_SECRET_FILE, "wb") as f:
        f.write(secret)
    return secret


SECRET = _load_secret()
TOKEN_TTL = 60 * 60 * 24 * 30  # 30 days


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 120_000)
    return f"pbkdf2_sha256$120000${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt_hex, hash_hex = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(iters))
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


def make_token(user_id: int) -> str:
    expiry = int(time.time()) + TOKEN_TTL
    payload = f"{user_id}.{expiry}"
    sig = hmac.new(SECRET, payload.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{payload}.{sig}"


def verify_token(token: str):
    """Return user_id if the token is valid and unexpired, else None."""
    try:
        user_id, expiry, sig = token.split(".")
        payload = f"{user_id}.{expiry}"
        expected = hmac.new(SECRET, payload.encode(), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(expected, sig):
            return None
        if int(expiry) < int(time.time()):
            return None
        return int(user_id)
    except Exception:
        return None
