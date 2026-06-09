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


# ===================================================================== hardening
def _api(method, path, token=None, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    if headers:
        h.update(headers)
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or "{}")
        except Exception:
            return e.code, {}


def _make_admin(username="boss", pw="admin123"):
    with db.get_db() as conn:
        cur = conn.execute(
            "INSERT INTO users (username, password_hash, full_name, is_admin, created_at) "
            "VALUES (?,?,?,1,?)",
            (username, auth.hash_password(pw), "The Boss", "2026-01-01T00:00:00"))
        return cur.lastrowid


def test_login_rate_limited_after_repeated_failures():
    """10 wrong passwords from one IP → the next attempt is 429, not 401."""
    _seed_base()
    _make_admin("boss", "rightpass1")
    ip = "203.0.113.55"  # unique bucket via X-Forwarded-For
    codes = [_api("POST", "/api/login", body={"username": "boss", "password": "nope"},
                  headers={"X-Forwarded-For": ip})[0] for _ in range(10)]
    assert codes == [401] * 10, codes
    blocked, _ = _api("POST", "/api/login", body={"username": "boss", "password": "nope"},
                      headers={"X-Forwarded-For": ip})
    assert blocked == 429
    # A different IP is unaffected.
    other, _ = _api("POST", "/api/login", body={"username": "boss", "password": "nope"},
                    headers={"X-Forwarded-For": "198.51.100.9"})
    assert other == 401


def test_bad_input_returns_400_not_500():
    role = _seed_base()
    admin = _make_admin("boss2", "rightpass1")
    tok = auth.make_token(admin)
    # create_slot with a malformed date
    s1, _ = _api("POST", "/api/slots", tok, {"date": "not-a-date", "start_time": "10:00",
                                             "end_time": "10:30", "role_id": role})
    assert s1 == 400
    # end before start
    s2, _ = _api("POST", "/api/slots", tok, {"date": FUTURE, "start_time": "11:00",
                                             "end_time": "10:00", "role_id": role})
    assert s2 == 400
    # slots/week with a garbage date
    s3, _ = _api("GET", "/api/slots/week?date=garbage", tok)
    assert s3 == 400


def test_forced_password_change_flow():
    """Default-password admin is flagged; changing it clears the flag; defaults rejected."""
    import server
    _seed_base()
    uid = _make_admin("boss3", "admin123")
    with db.get_db() as conn:
        server._flag_default_password_admins(conn)  # startup runs this; trigger it here
    tok = auth.make_token(uid)
    _, me = _api("GET", "/api/me", tok)
    assert me["must_change_password"] is True
    # too-short and default-reuse are rejected
    assert _api("PATCH", "/api/me", tok, {"password": "short"})[0] == 400
    assert _api("PATCH", "/api/me", tok, {"password": "admin123"})[0] == 400
    # a real change succeeds and clears the flag
    code, updated = _api("PATCH", "/api/me", tok, {"password": "a-better-secret"})
    assert code == 200 and updated["must_change_password"] is False


def test_public_config_hides_demo_logins_by_default():
    _seed_base()
    code, cfg = _api("GET", "/api/public-config")
    assert code == 200 and cfg["demo_logins"] is False


# ============================================================ soft-delete (S1/S2/S5)
def test_deleted_slot_excluded_from_coverage_and_unclaimable_and_restorable():
    role = _seed_base()
    admin = _make_admin("boss4", "rightpass1"); atok = auth.make_token(admin)
    (uid,) = _make_users(role, 1); utok = auth.make_token(uid)
    slot = _make_open_slot(role)

    def coverage_total():
        _, cov = _api("GET", f"/api/reports/coverage?from={FUTURE}&to={FUTURE}", atok)
        return cov["days"][0]["total"] if cov["days"] else 0

    before = coverage_total()
    assert before >= 1, before

    # delete it → drops out of the coverage count (S1)
    assert _api("DELETE", f"/api/slots/{slot}", atok)[0] == 200
    assert coverage_total() == before - 1

    # a deleted slot can't be claimed (S2) — treated as gone
    assert _api("POST", f"/api/slots/{slot}/request", utok)[0] == 404

    # it shows in the deleted list and restores cleanly (S5)
    deleted = _api("GET", "/api/slots/deleted", atok)[1]
    assert any(d["id"] == slot for d in deleted), deleted
    assert _api("POST", f"/api/slots/{slot}/restore", atok)[0] == 200
    assert coverage_total() == before  # back in the count
    # ...and is claimable again once restored
    assert _api("POST", f"/api/slots/{slot}/request", utok)[0] == 200


# ========================================================= schedule reconcile (S4)
def test_schedule_edit_reconciles_orphaned_shifts_but_spares_adhoc():
    role = _seed_base()
    admin = _make_admin("boss5", "rightpass1"); atok = auth.make_token(admin)
    (uid,) = _make_users(role, 1)
    wd = date.fromisoformat(FUTURE).weekday()
    with db.get_db() as conn:
        lvl = conn.execute("INSERT INTO levels (name, sort_order) VALUES ('TestLvl', 1)").lastrowid
        cs = conn.execute(
            "INSERT INTO class_schedules (level_id, weekday, start_time, end_time) VALUES (?,?,?,?)",
            (lvl, wd, "15:00", "15:30")).lastrowid
        conn.execute("INSERT INTO schedule_staff (schedule_id, role_id, user_id, count) VALUES (?,?,NULL,1)", (cs, role))
        # one open + one assigned slot generated from this schedule
        conn.execute("INSERT INTO slots (date,start_time,end_time,level_id,role_id,status,source_schedule_id) "
                     "VALUES (?,?,?,?,?, 'open', ?)", (FUTURE, "15:00", "15:30", lvl, role, cs))
        conn.execute("INSERT INTO slots (date,start_time,end_time,level_id,role_id,status,assigned_user_id,source_schedule_id) "
                     "VALUES (?,?,?,?,?, 'approved', ?, ?)", (FUTURE, "15:00", "15:30", lvl, role, uid, cs))
        # an AD-HOC slot (no source schedule) at a different time — must NEVER be swept up
        adhoc = conn.execute("INSERT INTO slots (date,start_time,end_time,level_id,role_id,status,source_schedule_id) "
                             "VALUES (?,?,?,?,?, 'open', NULL)", (FUTURE, "16:00", "16:30", lvl, role)).lastrowid
        server.ensure_dm_channels(conn)  # give the worker a DM channel for the cancellation message

    # remove the class's whole schedule → set_level_schedule reports the orphans
    st, resp = _api("PUT", f"/api/class-schedules/level/{lvl}", atok, {"sessions": []})
    assert st == 200, resp
    assert resp["orphans"]["total"] == 2 and resp["orphans"]["assigned"] == 1, resp["orphans"]

    # reconcile removes them (releasing + notifying the assigned worker)
    st2, rec = _api("POST", f"/api/class-schedules/level/{lvl}/reconcile", atok)
    assert st2 == 200 and rec["removed"] == 2 and rec["removed_assigned"] == 1, rec

    with db.get_db() as conn:
        alive = conn.execute("SELECT COUNT(*) c FROM slots WHERE level_id=? AND deleted_at IS NULL "
                             "AND source_schedule_id IS NOT NULL", (lvl,)).fetchone()["c"]
        assert alive == 0, "scheduled orphans should be gone"
        assert conn.execute("SELECT deleted_at FROM slots WHERE id=?", (adhoc,)).fetchone()["deleted_at"] is None, \
            "ad-hoc slot must not be touched"
        assert conn.execute("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND message LIKE '%cancelled%'",
                            (uid,)).fetchone()["c"] >= 1, "assigned worker should be notified"
        # ...and should get a DM from the admin in their messages
        assert conn.execute(
            """SELECT COUNT(*) c FROM messages m JOIN channels ch ON ch.id=m.channel_id
               WHERE ch.dm_user_id=? AND ch.type='dm' AND m.user_id=? AND m.body LIKE '%cancelled%'""",
            (uid, admin)).fetchone()["c"] >= 1, "worker should get a cancellation DM from the admin"


# ============================================= re-add a deleted class (regenerate)
def test_readd_deleted_class_regenerates():
    import scheduling
    role = _seed_base()
    admin = _make_admin("boss6", "rightpass1"); atok = auth.make_token(admin)
    wd = date.fromisoformat(FUTURE).weekday()
    fut = date.fromisoformat(FUTURE)
    with db.get_db() as conn:
        lvl = conn.execute("INSERT INTO levels (name, sort_order) VALUES ('TL', 1)").lastrowid
    sess = {"weekday": wd, "start_time": "15:00", "end_time": "15:30", "role_id": role, "user_id": None, "count": 1}

    # add class + generate one day's slot
    _api("PUT", f"/api/class-schedules/level/{lvl}", atok, {"sessions": [sess]})
    with db.get_db() as conn:
        scheduling.generate_from_schedules(conn, fut, fut)
        assert conn.execute("SELECT COUNT(*) c FROM slots WHERE level_id=? AND deleted_at IS NULL",
                            (lvl,)).fetchone()["c"] == 1

    # remove the class entirely → reconcile HARD-deletes it (no tombstone left behind)
    _api("PUT", f"/api/class-schedules/level/{lvl}", atok, {"sessions": []})
    _api("POST", f"/api/class-schedules/level/{lvl}/reconcile", atok)
    with db.get_db() as conn:
        assert conn.execute("SELECT COUNT(*) c FROM slots WHERE level_id=?", (lvl,)).fetchone()["c"] == 0, \
            "removed class should leave no slots (hard-deleted, not tombstoned)"

    # re-add the SAME class → nothing blocks it, generation works again
    _api("PUT", f"/api/class-schedules/level/{lvl}", atok, {"sessions": [sess]})
    with db.get_db() as conn:
        scheduling.generate_from_schedules(conn, fut, fut)
        assert conn.execute("SELECT COUNT(*) c FROM slots WHERE level_id=? AND deleted_at IS NULL",
                            (lvl,)).fetchone()["c"] == 1, "re-added class should regenerate"


# ============================================= reduce a class's count (excess)
def test_count_reduction_removes_open_excess_keeps_assigned():
    role = _seed_base()
    admin = _make_admin("boss7", "rightpass1"); atok = auth.make_token(admin)
    (uid,) = _make_users(role, 1)
    wd = date.fromisoformat(FUTURE).weekday()
    with db.get_db() as conn:
        lvl = conn.execute("INSERT INTO levels (name, sort_order) VALUES ('TL2', 1)").lastrowid
        cs = conn.execute("INSERT INTO class_schedules (level_id, weekday, start_time, end_time) VALUES (?,?,?,?)",
                          (lvl, wd, "15:00", "15:30")).lastrowid
        conn.execute("INSERT INTO schedule_staff (schedule_id, role_id, user_id, count) VALUES (?,?,NULL,2)", (cs, role))
        conn.execute("INSERT INTO slots (date,start_time,end_time,level_id,role_id,status,source_schedule_id) "
                     "VALUES (?,?,?,?,?, 'open', ?)", (FUTURE, "15:00", "15:30", lvl, role, cs))
        conn.execute("INSERT INTO slots (date,start_time,end_time,level_id,role_id,status,assigned_user_id,source_schedule_id) "
                     "VALUES (?,?,?,?,?, 'approved', ?, ?)", (FUTURE, "15:00", "15:30", lvl, role, uid, cs))

    # reduce count 2 -> 1
    st, resp = _api("PUT", f"/api/class-schedules/level/{lvl}", atok,
                    {"sessions": [{"weekday": wd, "start_time": "15:00", "end_time": "15:30",
                                   "role_id": role, "user_id": None, "count": 1}]})
    assert resp["orphans"]["total"] == 1 and resp["orphans"]["open"] == 1 and resp["orphans"]["approved"] == 0, resp["orphans"]
    _api("POST", f"/api/class-schedules/level/{lvl}/reconcile", atok)
    with db.get_db() as conn:
        rows = conn.execute("SELECT status, assigned_user_id FROM slots WHERE level_id=? AND deleted_at IS NULL",
                            (lvl,)).fetchall()
    assert len(rows) == 1 and rows[0]["assigned_user_id"] == uid, "keep the assigned shift, drop the open one"


# ===================================== keep-booked option on schedule reconcile
def test_reconcile_keep_booked_detaches_approved_only():
    role = _seed_base()
    admin = _make_admin("boss8", "rightpass1"); atok = auth.make_token(admin)
    u_req, u_app = _make_users(role, 2)
    wd = date.fromisoformat(FUTURE).weekday()
    with db.get_db() as conn:
        lvl = conn.execute("INSERT INTO levels (name, sort_order) VALUES ('TL3', 1)").lastrowid
        cs = conn.execute("INSERT INTO class_schedules (level_id, weekday, start_time, end_time) VALUES (?,?,?,?)",
                          (lvl, wd, "15:00", "15:30")).lastrowid
        conn.execute("INSERT INTO schedule_staff (schedule_id, role_id, user_id, count) VALUES (?,?,NULL,3)", (cs, role))

        def ins(status, uid=None):
            return conn.execute(
                "INSERT INTO slots (date,start_time,end_time,level_id,role_id,status,assigned_user_id,source_schedule_id) "
                "VALUES (?,?,?,?,?,?,?,?)", (FUTURE, "15:00", "15:30", lvl, role, status, uid, cs)).lastrowid
        s_open = ins("open")
        s_req = ins("requested", u_req)
        s_app = ins("approved", u_app)
        server.ensure_dm_channels(conn)

    # remove the schedule entirely → all three become orphans
    _api("PUT", f"/api/class-schedules/level/{lvl}", atok, {"sessions": []})

    # reconcile, keeping booked (approved) shifts
    st, rec = _api("POST", f"/api/class-schedules/level/{lvl}/reconcile?keep_booked=1", atok)
    assert st == 200 and rec["kept"] == 1 and rec["removed"] == 2, rec  # open + requested gone, approved kept

    with db.get_db() as conn:
        # open + requested are gone
        assert conn.execute("SELECT COUNT(*) c FROM slots WHERE id IN (?,?)", (s_open, s_req)).fetchone()["c"] == 0
        # approved is KEPT, detached (source NULL), still assigned to the same person
        row = conn.execute("SELECT status, assigned_user_id, source_schedule_id FROM slots WHERE id=?", (s_app,)).fetchone()
        assert row and row["assigned_user_id"] == u_app and row["source_schedule_id"] is None, dict(row) if row else None
        # the pending requester was notified their request was cancelled
        assert conn.execute("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND message LIKE '%cancelled%'",
                            (u_req,)).fetchone()["c"] >= 1


# ===================================== deactivation frees future shifts (M1)
def test_deactivating_user_releases_future_shifts():
    role = _seed_base()
    admin = _make_admin("boss9", "rightpass1"); atok = auth.make_token(admin)
    (uid,) = _make_users(role, 1)
    past = (date.today() - timedelta(days=3)).isoformat()
    with db.get_db() as conn:
        def ins(status, d, t):
            return conn.execute(
                "INSERT INTO slots (date,start_time,end_time,role_id,status,assigned_user_id) VALUES (?,?,?,?,?,?)",
                (d, t, t.replace(":0", ":3"), role, status, uid)).lastrowid
        s_app = ins("approved", FUTURE, "10:00")
        s_req = ins("requested", FUTURE, "11:00")
        s_past = ins("approved", past, "10:00")

    assert _api("PATCH", f"/api/users/{uid}", atok, {"active": False})[0] == 200

    with db.get_db() as conn:
        for sid in (s_app, s_req):
            row = conn.execute("SELECT status, assigned_user_id FROM slots WHERE id=?", (sid,)).fetchone()
            assert row["status"] == "open" and row["assigned_user_id"] is None, \
                f"future shift {sid} should be released: {dict(row)}"
        past_row = conn.execute("SELECT assigned_user_id FROM slots WHERE id=?", (s_past,)).fetchone()
        assert past_row["assigned_user_id"] == uid, "past shift should be left assigned"
    # and you can no longer assign a fresh shift to the deactivated user
    with db.get_db() as conn:
        s_new = conn.execute(
            "INSERT INTO slots (date,start_time,end_time,role_id,status) VALUES (?,?,?,?, 'open')",
            (FUTURE, "14:00", "14:30", role)).lastrowid
    assert _api("POST", f"/api/slots/{s_new}/assign", atok, {"user_id": uid})[0] == 400
