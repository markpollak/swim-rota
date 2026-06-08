"""Concurrency tests for the shift-booking path (audit findings C1 & C2).

These spin up a real uvicorn server against a throwaway SQLite DB and fire
genuinely parallel HTTP requests (sync handlers run in uvicorn's threadpool), so
they exercise the actual race window — not a serialised TestClient.

Run:  .venv/bin/python -m pytest tests/ -v
"""
import os
import socket
import tempfile
import threading
import time
import json
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import pytest

# Throwaway DB must be set BEFORE importing the app (db.DB_PATH is read at import).
_TMP_DB = os.path.join(tempfile.mkdtemp(prefix="swimtest_"), "test.db")
os.environ["SWIM_DB"] = _TMP_DB
os.environ["SWIM_SECRET"] = "test-secret-not-for-production"

import db          # noqa: E402
import auth        # noqa: E402
import server      # noqa: E402

FUTURE = (date.today() + timedelta(days=3)).isoformat()


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


PORT = _free_port()
BASE = f"http://127.0.0.1:{PORT}"


def _seed_base():
    """Fresh schema + one non-training role. Returns role_id."""
    db.init_db()
    with db.get_db() as conn:
        for t in ["slots", "user_roles", "users", "roles"]:
            conn.execute(f"DELETE FROM {t}")
        cur = conn.execute(
            "INSERT INTO roles (name, requires_training, color, sort_order) VALUES ('Teacher',0,'#26358B',0)")
        return cur.lastrowid


def _make_users(role_id, n):
    ids = []
    with db.get_db() as conn:
        for i in range(n):
            cur = conn.execute(
                "INSERT INTO users (username, password_hash, full_name, is_admin, created_at) "
                "VALUES (?,?,?,0,?)",
                (f"u{i}", auth.hash_password("x"), f"User {i}", "2026-01-01T00:00:00"))
            uid = cur.lastrowid
            conn.execute("INSERT INTO user_roles (user_id, role_id) VALUES (?,?)", (uid, role_id))
            ids.append(uid)
    return ids


def _make_open_slot(role_id, start="10:00", end="10:30"):
    with db.get_db() as conn:
        cur = conn.execute(
            "INSERT INTO slots (date, start_time, end_time, role_id, status) VALUES (?,?,?,?, 'open')",
            (FUTURE, start, end, role_id))
        return cur.lastrowid


def _post(path, token):
    req = urllib.request.Request(BASE + path, data=b"{}", method="POST",
                                 headers={"Authorization": f"Bearer {token}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


@pytest.fixture(scope="module", autouse=True)
def live_server():
    import uvicorn
    _seed_base()  # ensure schema exists before startup runs
    config = uvicorn.Config(server.app, host="127.0.0.1", port=PORT, log_level="warning")
    srv = uvicorn.Server(config)
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    assert srv.started, "uvicorn did not start"
    yield
    srv.should_exit = True
    thread.join(timeout=5)


def _fire_parallel(calls):
    """calls: list of (path, token). Fire them all at the same instant."""
    barrier = threading.Barrier(len(calls))
    results = []

    def run(path, token):
        barrier.wait()  # release all threads together to maximise overlap
        return _post(path, token)

    with ThreadPoolExecutor(max_workers=len(calls)) as ex:
        futs = [ex.submit(run, p, t) for p, t in calls]
        results = [f.result() for f in futs]
    return results


# --------------------------------------------------------------------------- C1
def test_concurrent_request_single_winner():
    """Six staff hit the SAME open slot at once → exactly one wins (200), rest 409."""
    role = _seed_base()
    uids = _make_users(role, 6)
    slot = _make_open_slot(role)
    tokens = [auth.make_token(u) for u in uids]

    statuses = _fire_parallel([(f"/api/slots/{slot}/request", t) for t in tokens])

    assert statuses.count(200) == 1, f"expected exactly one winner, got {statuses}"
    assert statuses.count(409) == len(tokens) - 1, statuses
    # DB must show the slot claimed by exactly one of these users.
    with db.get_db() as conn:
        row = conn.execute("SELECT status, assigned_user_id FROM slots WHERE id=?", (slot,)).fetchone()
    assert row["status"] == "requested"
    assert row["assigned_user_id"] in uids


def test_sequential_claim_second_rejected():
    """Deterministic guard: a second claim on an already-claimed slot is refused."""
    role = _seed_base()
    a, b = _make_users(role, 2)
    slot = _make_open_slot(role)
    assert _post(f"/api/slots/{slot}/request", auth.make_token(a)) == 200
    assert _post(f"/api/slots/{slot}/request", auth.make_token(b)) == 409


# --------------------------------------------------------------------------- C2
def test_concurrent_double_book_prevented():
    """One user requests two OVERLAPPING slots at once → can't hold both."""
    role = _seed_base()
    (uid,) = _make_users(role, 1)
    slot_a = _make_open_slot(role, "10:00", "10:30")
    slot_b = _make_open_slot(role, "10:00", "10:30")  # same time → overlaps
    token = auth.make_token(uid)

    statuses = _fire_parallel([
        (f"/api/slots/{slot_a}/request", token),
        (f"/api/slots/{slot_b}/request", token),
    ])

    assert statuses.count(200) == 1, f"double-booking not prevented: {statuses}"
    # The user must not be holding two overlapping shifts.
    with db.get_db() as conn:
        held = conn.execute(
            "SELECT COUNT(*) c FROM slots WHERE assigned_user_id=? AND status IN ('requested','approved')",
            (uid,)).fetchone()["c"]
    assert held == 1, f"user ended up with {held} overlapping shifts"
