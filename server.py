"""Arc Swim Rota — FastAPI backend.

Serves the JSON API and the static PWA. Auth is stdlib-only (see auth.py),
request/response bodies are plain JSON (no multipart dependency required).
"""
import os
import io
import csv
from datetime import date, datetime, timedelta

from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles

import db
import auth
from scheduling import generate_slots, generate_from_schedules, extend_to_horizon, monday_of

HERE = os.path.dirname(__file__)
STATIC = os.path.join(HERE, "static")

app = FastAPI(title="Arc Swim Rota")


def ensure_dm_channels(conn):
    """Auto-create a DM channel for every active user (with all admins as members).
    Idempotent — safe to call repeatedly.
    """
    users = conn.execute("SELECT id, full_name FROM users WHERE active=1").fetchall()
    admins = conn.execute("SELECT id FROM users WHERE is_admin=1 AND active=1").fetchall()
    if not admins:
        return  # Nothing to create without at least one admin
    for user in users:
        existing = conn.execute(
            "SELECT id FROM channels WHERE dm_user_id=? AND type='dm'",
            (user["id"],)
        ).fetchone()
        if existing:
            cid = existing["id"]
        else:
            cur = conn.execute(
                """INSERT INTO channels (name, description, color, created_at, type, dm_user_id)
                   VALUES (?,?,?,?,?,?)""",
                (f"dm:{user['id']}", "", "#26358B", now_iso(), "dm", user["id"])
            )
            cid = cur.lastrowid
        # Ensure the user and all admins are members
        for uid in [user["id"]] + [a["id"] for a in admins]:
            conn.execute(
                "INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)",
                (cid, uid, now_iso())
            )


@app.on_event("startup")
def _startup():
    db.init_db()
    with db.get_db() as conn:
        extend_to_horizon(conn)
        ensure_dm_channels(conn)


def now_iso():
    return datetime.utcnow().isoformat(timespec="seconds")


# ----------------------------------------------------------------------------
# auth helpers
# ----------------------------------------------------------------------------
def current_user(request: Request):
    header = request.headers.get("authorization", "")
    token = header[7:] if header.lower().startswith("bearer ") else None
    if not token:
        raise HTTPException(401, "Not authenticated")
    uid = auth.verify_token(token)
    if not uid:
        raise HTTPException(401, "Invalid or expired session")
    with db.get_db() as conn:
        u = conn.execute("SELECT * FROM users WHERE id = ? AND active = 1", (uid,)).fetchone()
    if not u:
        raise HTTPException(401, "User not found")
    return dict(u)


def require_admin(user=Depends(current_user)):
    if not user["is_admin"]:
        raise HTTPException(403, "Administrator access required")
    return user


def user_payload(conn, u):
    roles = conn.execute(
        """SELECT r.id, r.name, r.color, r.requires_training FROM roles r
           JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?
           ORDER BY r.sort_order""", (u["id"],)).fetchall()
    roles = db.dict_rows(roles)
    today = date.today().isoformat()
    needs_training = any(r["requires_training"] for r in roles)
    expiry = u.get("training_expiry")
    training_status = "n/a"
    if needs_training:
        if not expiry:
            training_status = "missing"
        elif expiry < today:
            training_status = "expired"
        elif expiry < (date.today() + timedelta(days=30)).isoformat():
            training_status = "expiring"
        else:
            training_status = "valid"
    return {
        "id": u["id"], "username": u["username"], "full_name": u["full_name"],
        "email": u["email"], "phone": u["phone"], "is_admin": bool(u["is_admin"]),
        "training_expiry": expiry, "training_status": training_status,
        "roles": roles,
    }


# ----------------------------------------------------------------------------
# auth + bootstrap
# ----------------------------------------------------------------------------
@app.post("/api/login")
async def login(request: Request):
    body = await request.json()
    username = (body.get("username") or "").strip().lower()
    password = body.get("password") or ""
    with db.get_db() as conn:
        u = conn.execute("SELECT * FROM users WHERE lower(username) = ? AND active = 1",
                         (username,)).fetchone()
        if not u or not auth.verify_password(password, u["password_hash"]):
            raise HTTPException(401, "Incorrect username or password")
        token = auth.make_token(u["id"])
        return {"token": token, "user": user_payload(conn, dict(u))}


@app.get("/api/bootstrap")
def bootstrap(user=Depends(current_user)):
    with db.get_db() as conn:
        roles = db.dict_rows(conn.execute(
            "SELECT * FROM roles WHERE active = 1 ORDER BY sort_order").fetchall())
        levels = db.dict_rows(conn.execute(
            "SELECT * FROM levels WHERE active = 1 ORDER BY sort_order").fetchall())
        return {
            "user": user_payload(conn, user),
            "roles": roles, "levels": levels,
            "server_date": date.today().isoformat(),
        }


# ----------------------------------------------------------------------------
# slots
# ----------------------------------------------------------------------------
SLOT_SELECT = """
SELECT s.*, r.name role_name, r.color role_color, r.requires_training,
       l.name level_name, u.full_name assigned_name
FROM slots s
JOIN roles r ON r.id = s.role_id
LEFT JOIN levels l ON l.id = s.level_id
LEFT JOIN users u ON u.id = s.assigned_user_id
"""


def overlaps(a_start, a_end, b_start, b_end):
    return a_start < b_end and b_start < a_end


def check_double_book(conn, user_id, slot, exclude_id=None):
    rows = conn.execute(
        """SELECT start_time, end_time FROM slots
           WHERE assigned_user_id = ? AND date = ? AND status IN ('requested','approved')
           AND id != ?""",
        (user_id, slot["date"], exclude_id or -1)).fetchall()
    for r in rows:
        if overlaps(slot["start_time"], slot["end_time"], r["start_time"], r["end_time"]):
            raise HTTPException(409, "That clashes with another shift you already hold at this time.")


def check_qualified(conn, user_id, slot):
    role = conn.execute("SELECT * FROM roles WHERE id = ?", (slot["role_id"],)).fetchone()
    has = conn.execute("SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ?",
                       (user_id, slot["role_id"])).fetchone()
    if not has:
        raise HTTPException(403, f"You are not qualified as a {role['name']}.")


def notify_admins(conn, message, link="approvals"):
    admins = conn.execute("SELECT id FROM users WHERE is_admin = 1 AND active = 1").fetchall()
    for a in admins:
        conn.execute("INSERT INTO notifications (user_id, message, link, created_at) VALUES (?,?,?,?)",
                     (a["id"], message, link, now_iso()))


def notify_user(conn, uid, message, link="myshifts"):
    conn.execute("INSERT INTO notifications (user_id, message, link, created_at) VALUES (?,?,?,?)",
                 (uid, message, link, now_iso()))


@app.get("/api/slots")
def list_slots(request: Request, user=Depends(current_user)):
    q = request.query_params
    where, params = [], []
    if q.get("from"):
        where.append("s.date >= ?"); params.append(q["from"])
    if q.get("to"):
        where.append("s.date <= ?"); params.append(q["to"])
    if q.get("mine"):
        where.append("s.assigned_user_id = ?"); params.append(user["id"])
    if q.get("status"):
        where.append("s.status = ?"); params.append(q["status"])
    if q.get("pending"):
        where.append("s.status = 'requested'")
    sql = SLOT_SELECT
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY s.date, s.start_time, r.sort_order"
    with db.get_db() as conn:
        rows = db.dict_rows(conn.execute(sql, params).fetchall())
        if q.get("pending"):
            for row in rows:
                uid = row.get("assigned_user_id")
                if not uid:
                    continue
                clash = conn.execute("""
                    SELECT s2.start_time, s2.end_time, l.name level_name, r.name role_name
                    FROM slots s2
                    LEFT JOIN levels l ON l.id = s2.level_id
                    JOIN roles r ON r.id = s2.role_id
                    WHERE s2.assigned_user_id = ? AND s2.date = ?
                    AND s2.status = 'approved' AND s2.id != ?
                    AND s2.start_time < ? AND ? < s2.end_time
                """, (uid, row["date"], row["id"], row["end_time"], row["start_time"])).fetchone()
                if clash:
                    lvl = clash["level_name"] or "pool duty"
                    row["clash"] = f"{clash['role_name']}: {lvl}, {clash['start_time']}–{clash['end_time']}"
        return rows


def _get_slot(conn, slot_id):
    s = conn.execute("SELECT * FROM slots WHERE id = ?", (slot_id,)).fetchone()
    if not s:
        raise HTTPException(404, "Shift not found")
    return dict(s)


@app.post("/api/slots/{slot_id}/request")
def request_slot(slot_id: int, user=Depends(current_user)):
    with db.get_db() as conn:
        s = _get_slot(conn, slot_id)
        if s["status"] != "open":
            raise HTTPException(409, "That shift is no longer available.")
        if s["date"] < date.today().isoformat():
            raise HTTPException(409, "You cannot request a shift in the past.")
        check_qualified(conn, user["id"], s)
        check_double_book(conn, user["id"], s)
        conn.execute("UPDATE slots SET assigned_user_id=?, status='requested', requested_at=? WHERE id=?",
                     (user["id"], now_iso(), slot_id))
        notify_admins(conn, f"{user['full_name']} requested {s['label'] or 'a shift'} on {s['date']} {s['start_time']}.")
        conn.execute("INSERT INTO audit (ts, user_id, action, detail) VALUES (?,?,?,?)",
                     (now_iso(), user["id"], "request", f"slot {slot_id}"))
        return {"ok": True}


@app.post("/api/slots/{slot_id}/release")
async def release_slot(slot_id: int, request: Request, user=Depends(current_user)):
    body = await request.json() if await _has_body(request) else {}
    reason = (body.get("reason") or "").strip()
    dm_cid = dm_mid = dm_msg = None
    with db.get_db() as conn:
        s = conn.execute(
            """SELECT s.*, l.name level_name, r.name role_name
               FROM slots s LEFT JOIN levels l ON l.id=s.level_id
               JOIN roles r ON r.id=s.role_id WHERE s.id=?""", (slot_id,)).fetchone()
        if not s:
            raise HTTPException(404, "Shift not found")
        s = dict(s)
        if s["assigned_user_id"] != user["id"] and not user["is_admin"]:
            raise HTTPException(403, "That isn't your shift.")
        if s["date"] < date.today().isoformat():
            raise HTTPException(409, "You cannot release a past shift.")
        uid = s["assigned_user_id"]
        conn.execute("""UPDATE slots SET assigned_user_id=NULL, status='open',
                        requested_at=NULL, decided_at=NULL, decided_by=NULL WHERE id=?""", (slot_id,))
        conn.execute("INSERT INTO audit (ts, user_id, action, detail) VALUES (?,?,?,?)",
                     (now_iso(), user["id"], "release", f"slot {slot_id}"))
        # If an admin removed someone else's shift, DM the worker
        if user["is_admin"] and uid and uid != user["id"]:
            lvl = s["level_name"] or "Pool duty (Lifeguard)"
            # Format date as "Monday 8 June"
            from datetime import datetime as _dt
            d_obj = _dt.strptime(s["date"], "%Y-%m-%d")
            date_str = d_obj.strftime("%A %-d %B")
            reason_str = reason if reason else "none given"
            dm_msg = (f"Your shift was removed: {date_str} {s['start_time']}–{s['end_time']} "
                      f"// {s['role_name']} // {lvl} // Reason: {reason_str}")
            notify_user(conn, uid, "Your shift was removed — see your messages for details.")
            dm_ch = conn.execute(
                "SELECT id FROM channels WHERE dm_user_id=? AND type='dm' AND active=1", (uid,)
            ).fetchone()
            if dm_ch:
                ts = now_iso()
                cur = conn.execute(
                    "INSERT INTO messages (channel_id, user_id, body, sent_at) VALUES (?,?,?,?)",
                    (dm_ch["id"], user["id"], dm_msg, ts))
                dm_cid = dm_ch["id"]
                dm_mid = cur.lastrowid
        else:
            notify_admins(conn, f"{user['full_name']} released a shift on {s['date']} {s['start_time']} — now open.", "reports")
    if dm_cid and dm_mid:
        _fanout(dm_cid, {
            "id": dm_mid, "channel_id": dm_cid, "body": dm_msg,
            "sent_at": now_iso(), "user_id": user["id"],
            "full_name": user["full_name"], "username": user["username"],
        })
    return {"ok": True}


@app.post("/api/slots/{slot_id}/approve")
def approve_slot(slot_id: int, admin=Depends(require_admin)):
    with db.get_db() as conn:
        s = _get_slot(conn, slot_id)
        if s["status"] != "requested" or not s["assigned_user_id"]:
            raise HTTPException(409, "Nothing to approve on that shift.")
        check_qualified(conn, s["assigned_user_id"], s)
        check_double_book(conn, s["assigned_user_id"], s, exclude_id=slot_id)
        conn.execute("UPDATE slots SET status='approved', decided_at=?, decided_by=? WHERE id=?",
                     (now_iso(), admin["id"], slot_id))
        notify_user(conn, s["assigned_user_id"],
                    f"✅ Approved: {s['label'] or 'shift'} on {s['date']} at {s['start_time']}.")
        conn.execute("INSERT INTO audit (ts, user_id, action, detail) VALUES (?,?,?,?)",
                     (now_iso(), admin["id"], "approve", f"slot {slot_id}"))
        return {"ok": True}


@app.post("/api/slots/{slot_id}/reject")
async def reject_slot(slot_id: int, request: Request, admin=Depends(require_admin)):
    body = await request.json() if await _has_body(request) else {}
    reason = (body.get("reason") or "").strip()
    dm_cid = None
    dm_mid = None
    dm_msg = None
    with db.get_db() as conn:
        s = _get_slot(conn, slot_id)
        if s["status"] != "requested":
            raise HTTPException(409, "Nothing to reject on that shift.")
        uid = s["assigned_user_id"]
        conn.execute("""UPDATE slots SET assigned_user_id=NULL, status='open',
                        requested_at=NULL WHERE id=?""", (slot_id,))
        dm_msg = f"❌ Your shift request for {s['label'] or 'a shift'} on {s['date']} at {s['start_time']} was declined."
        if reason:
            dm_msg += f"\n\nReason: {reason}"
        notify_user(conn, uid, dm_msg.split("\n")[0])
        # Also post directly to the person's DM channel so they see it in Messages
        dm_ch = conn.execute(
            "SELECT id FROM channels WHERE dm_user_id=? AND type='dm' AND active=1", (uid,)
        ).fetchone()
        if dm_ch:
            ts = now_iso()
            cur = conn.execute(
                "INSERT INTO messages (channel_id, user_id, body, sent_at) VALUES (?,?,?,?)",
                (dm_ch["id"], admin["id"], dm_msg, ts))
            dm_cid = dm_ch["id"]
            dm_mid = cur.lastrowid
        conn.execute("INSERT INTO audit (ts, user_id, action, detail) VALUES (?,?,?,?)",
                     (now_iso(), admin["id"], "reject", f"slot {slot_id}: {reason}"))
    if dm_cid and dm_mid:
        _fanout(dm_cid, {
            "id": dm_mid, "channel_id": dm_cid, "body": dm_msg,
            "sent_at": now_iso(), "user_id": admin["id"],
            "full_name": admin["full_name"], "username": admin["username"],
        })
    return {"ok": True}


@app.post("/api/slots/{slot_id}/assign")
async def assign_slot(slot_id: int, request: Request, admin=Depends(require_admin)):
    body = await request.json()
    uid = body.get("user_id")
    if not uid:
        raise HTTPException(400, "user_id required")
    with db.get_db() as conn:
        s = _get_slot(conn, slot_id)
        check_qualified(conn, uid, s)
        check_double_book(conn, uid, s, exclude_id=slot_id)
        conn.execute("""UPDATE slots SET assigned_user_id=?, status='approved',
                        requested_at=?, decided_at=?, decided_by=? WHERE id=?""",
                     (uid, now_iso(), now_iso(), admin["id"], slot_id))
        notify_user(conn, uid, f"You've been assigned {s['label'] or 'a shift'} on {s['date']} at {s['start_time']}.")
        conn.execute("INSERT INTO audit (ts, user_id, action, detail) VALUES (?,?,?,?)",
                     (now_iso(), admin["id"], "assign", f"slot {slot_id} -> user {uid}"))
        return {"ok": True}


@app.post("/api/slots")
async def create_slot(request: Request, admin=Depends(require_admin)):
    b = await request.json()
    required = ["date", "start_time", "end_time", "role_id"]
    if not all(b.get(k) for k in required):
        raise HTTPException(400, "date, start_time, end_time, role_id are required")
    with db.get_db() as conn:
        cur = conn.execute(
            """INSERT INTO slots (date, start_time, end_time, level_id, role_id, label, notes, status)
               VALUES (?,?,?,?,?,?,?, 'open')""",
            (b["date"], b["start_time"], b["end_time"], b.get("level_id"),
             b["role_id"], b.get("label"), b.get("notes")))
        return {"ok": True, "id": cur.lastrowid}


@app.delete("/api/slots/{slot_id}")
def delete_slot(slot_id: int, admin=Depends(require_admin)):
    with db.get_db() as conn:
        s = _get_slot(conn, slot_id)
        conn.execute("DELETE FROM slots WHERE id = ?", (slot_id,))
        if s["assigned_user_id"]:
            notify_user(conn, s["assigned_user_id"],
                        f"A shift you held ({s['date']} {s['start_time']}) was removed by an administrator.")
        return {"ok": True}


async def _has_body(request: Request) -> bool:
    body = await request.body()
    return bool(body)


@app.post("/api/slots/bulk-assign")
async def bulk_assign(request: Request, admin=Depends(require_admin)):
    """Assign (and optionally auto-approve) a user to a list of slot IDs in one shot."""
    b = await request.json()
    uid = b.get("user_id")
    slot_ids = b.get("slot_ids", [])
    auto_approve = bool(b.get("auto_approve", True))
    if not uid or not slot_ids:
        raise HTTPException(400, "user_id and slot_ids required")
    assigned, skipped_details = [], []
    with db.get_db() as conn:
        u_row = conn.execute("SELECT full_name FROM users WHERE id=?", (uid,)).fetchone()
        person = (u_row["full_name"].split()[0] if u_row else "They")
        for sid in slot_ids:
            s = conn.execute(
                """SELECT s.*, l.name level_name, r.name role_name
                   FROM slots s LEFT JOIN levels l ON l.id=s.level_id
                   JOIN roles r ON r.id=s.role_id WHERE s.id=?""", (sid,)).fetchone()
            if not s:
                skipped_details.append({"slot_id": sid, "reason": "Slot not found"})
                continue
            if s["status"] != "open":
                skipped_details.append({"slot_id": sid, "date": s["date"],
                    "start_time": s["start_time"], "level_name": s["level_name"],
                    "role_name": s["role_name"], "reason": "Slot already taken"})
                continue
            try:
                check_qualified(conn, uid, dict(s))
            except HTTPException as e:
                skipped_details.append({"slot_id": sid, "date": s["date"],
                    "start_time": s["start_time"], "level_name": s["level_name"],
                    "role_name": s["role_name"], "reason": e.detail})
                continue
            try:
                check_double_book(conn, uid, dict(s))
            except HTTPException:
                clash = conn.execute(
                    """SELECT s2.start_time, s2.end_time, l.name level_name, r.name role_name
                       FROM slots s2 LEFT JOIN levels l ON l.id=s2.level_id
                       JOIN roles r ON r.id=s2.role_id
                       WHERE s2.assigned_user_id=? AND s2.date=?
                       AND s2.status IN ('approved','requested') AND s2.id!=?
                       AND s2.start_time < ? AND ? < s2.end_time""",
                    (uid, s["date"], sid, s["end_time"], s["start_time"])).fetchone()
                if clash:
                    lvl = clash["level_name"] or "pool duty"
                    reason = f"{person} is already allocated: {clash['role_name']}, {lvl} ({clash['start_time']}–{clash['end_time']})"
                else:
                    reason = f"{person} has a clashing shift at this time"
                skipped_details.append({"slot_id": sid, "date": s["date"],
                    "start_time": s["start_time"], "level_name": s["level_name"],
                    "role_name": s["role_name"], "reason": reason})
                continue
            status = "approved" if auto_approve else "requested"
            conn.execute(
                """UPDATE slots SET assigned_user_id=?, status=?, requested_at=?,
                        decided_at=?, decided_by=? WHERE id=?""",
                (uid, status, now_iso(), now_iso() if auto_approve else None,
                 admin["id"] if auto_approve else None, sid))
            assigned.append(sid)
        if assigned:
            notify_user(conn, uid,
                f"You've been assigned {len(assigned)} shift{'s' if len(assigned)>1 else ''} by {admin['full_name']}.")
            conn.execute("INSERT INTO audit (ts, user_id, action, detail) VALUES (?,?,?,?)",
                         (now_iso(), admin["id"], "bulk_assign",
                          f"user {uid}: slots {assigned}"))
    return {"ok": True, "assigned": len(assigned),
            "skipped": len(skipped_details), "skipped_details": skipped_details}


@app.get("/api/slots/week")
def slots_week(request: Request, user=Depends(current_user)):
    """Return all slots for the ISO week containing ?date=YYYY-MM-DD."""
    from datetime import date as _date
    d_str = request.query_params.get("date") or date.today().isoformat()
    d = date.fromisoformat(d_str)
    monday = d - timedelta(days=d.weekday())
    sunday = monday + timedelta(days=6)
    with db.get_db() as conn:
        rows = conn.execute(f"""{SLOT_SELECT}
            WHERE s.date >= ? AND s.date <= ?
            ORDER BY s.date, s.start_time, r.sort_order""",
            (monday.isoformat(), sunday.isoformat())).fetchall()
        return db.dict_rows(rows)


# ----------------------------------------------------------------------------
# users
# ----------------------------------------------------------------------------
@app.get("/api/users")
def list_users(admin=Depends(require_admin)):
    with db.get_db() as conn:
        users = conn.execute("SELECT * FROM users ORDER BY full_name").fetchall()
        return [user_payload(conn, dict(u)) | {"active": bool(u["active"])} for u in users]


@app.post("/api/users")
async def create_user(request: Request, admin=Depends(require_admin)):
    b = await request.json()
    uname = (b.get("username") or "").strip().lower()
    if not uname or not b.get("full_name"):
        raise HTTPException(400, "username and full_name required")
    pw = b.get("password") or "password"
    with db.get_db() as conn:
        if conn.execute("SELECT 1 FROM users WHERE lower(username)=?", (uname,)).fetchone():
            raise HTTPException(409, "That username is already taken.")
        cur = conn.execute(
            """INSERT INTO users (username, password_hash, full_name, email, phone,
                    is_admin, training_expiry, created_at) VALUES (?,?,?,?,?,?,?,?)""",
            (uname, auth.hash_password(pw), b["full_name"], b.get("email"), b.get("phone"),
             1 if b.get("is_admin") else 0, b.get("training_expiry") or None, now_iso()))
        uid = cur.lastrowid
        for rid in b.get("role_ids", []):
            conn.execute("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?,?)", (uid, rid))
            _sync_role_channel_add(conn, uid, rid)
        # Auto-create DM channel for the new user
        ensure_dm_channels(conn)
        return {"ok": True, "id": uid}


@app.patch("/api/users/{user_id}")
async def update_user(user_id: int, request: Request, admin=Depends(require_admin)):
    b = await request.json()
    with db.get_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE id=?", (user_id,)).fetchone():
            raise HTTPException(404, "User not found")
        fields, params = [], []
        for col in ["full_name", "email", "phone", "training_expiry"]:
            if col in b:
                fields.append(f"{col}=?"); params.append(b[col] or None)
        if "is_admin" in b:
            fields.append("is_admin=?"); params.append(1 if b["is_admin"] else 0)
        if "active" in b:
            fields.append("active=?"); params.append(1 if b["active"] else 0)
        if fields:
            params.append(user_id)
            conn.execute(f"UPDATE users SET {','.join(fields)} WHERE id=?", params)
        if "password" in b and b["password"]:
            conn.execute("UPDATE users SET password_hash=? WHERE id=?",
                         (auth.hash_password(b["password"]), user_id))
        if "role_ids" in b:
            old_roles = {r["role_id"] for r in conn.execute(
                "SELECT role_id FROM user_roles WHERE user_id=?", (user_id,)).fetchall()}
            new_roles = set(b["role_ids"])
            conn.execute("DELETE FROM user_roles WHERE user_id=?", (user_id,))
            for rid in new_roles:
                conn.execute("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?,?)", (user_id, rid))
            for rid in (new_roles - old_roles):
                _sync_role_channel_add(conn, user_id, rid)
            for rid in (old_roles - new_roles):
                _sync_role_channel_remove(conn, user_id, rid)
        return {"ok": True}


@app.get("/api/me")
def get_me(user=Depends(current_user)):
    with db.get_db() as conn:
        return user_payload(conn, user)


@app.patch("/api/me")
async def update_me(request: Request, user=Depends(current_user)):
    b = await request.json()
    with db.get_db() as conn:
        fields, params = [], []
        for col in ["full_name", "email", "phone", "training_expiry"]:
            if col in b:
                fields.append(f"{col}=?"); params.append(b[col] or None)
        if fields:
            params.append(user["id"])
            conn.execute(f"UPDATE users SET {','.join(fields)} WHERE id=?", params)
        if b.get("password"):
            conn.execute("UPDATE users SET password_hash=? WHERE id=?",
                         (auth.hash_password(b["password"]), user["id"]))
        return user_payload(conn, dict(conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()))


# ----------------------------------------------------------------------------
# roles + levels + staffing
# ----------------------------------------------------------------------------
@app.get("/api/roles")
def get_roles(user=Depends(current_user)):
    with db.get_db() as conn:
        return db.dict_rows(conn.execute("SELECT * FROM roles ORDER BY sort_order").fetchall())


@app.post("/api/roles")
async def add_role(request: Request, admin=Depends(require_admin)):
    b = await request.json()
    if not b.get("name"):
        raise HTTPException(400, "name required")
    with db.get_db() as conn:
        mx = conn.execute("SELECT IFNULL(MAX(sort_order),0)+1 n FROM roles").fetchone()["n"]
        try:
            cur = conn.execute(
                "INSERT INTO roles (name, requires_training, color, sort_order, shortcode) VALUES (?,?,?,?,?)",
                (b["name"], 1 if b.get("requires_training") else 0, b.get("color") or "#0E9F8E", mx, b.get("shortcode") or None))
        except Exception:
            raise HTTPException(409, "A role with that name already exists.")
        return {"ok": True, "id": cur.lastrowid}


@app.patch("/api/roles/{role_id}")
async def update_role(role_id: int, request: Request, admin=Depends(require_admin)):
    b = await request.json()
    with db.get_db() as conn:
        fields, params = [], []
        for col in ["name", "color", "shortcode"]:
            if col in b:
                fields.append(f"{col}=?"); params.append(b[col] or None)
        if "requires_training" in b:
            fields.append("requires_training=?"); params.append(1 if b["requires_training"] else 0)
        if "active" in b:
            fields.append("active=?"); params.append(1 if b["active"] else 0)
        if fields:
            params.append(role_id)
            conn.execute(f"UPDATE roles SET {','.join(fields)} WHERE id=?", params)
        return {"ok": True}


@app.post("/api/levels")
async def add_level(request: Request, admin=Depends(require_admin)):
    b = await request.json()
    if not b.get("name"):
        raise HTTPException(400, "name required")
    with db.get_db() as conn:
        mx = conn.execute("SELECT IFNULL(MAX(sort_order),0)+1 n FROM levels").fetchone()["n"]
        try:
            cur = conn.execute("INSERT INTO levels (name, sort_order) VALUES (?,?)", (b["name"], mx))
        except Exception:
            raise HTTPException(409, "A level with that name already exists.")
        lid = cur.lastrowid
        # default staffing: one Teacher
        teacher = conn.execute("SELECT id FROM roles WHERE name='Teacher'").fetchone()
        if teacher:
            conn.execute("INSERT INTO level_staffing (level_id, role_id, count) VALUES (?,?,1)",
                         (lid, teacher["id"]))
        return {"ok": True, "id": lid}


@app.patch("/api/levels/{level_id}")
async def update_level(level_id: int, request: Request, admin=Depends(require_admin)):
    b = await request.json()
    with db.get_db() as conn:
        if "name" in b:
            conn.execute("UPDATE levels SET name=? WHERE id=?", (b["name"], level_id))
        if "active" in b:
            conn.execute("UPDATE levels SET active=? WHERE id=?", (1 if b["active"] else 0, level_id))
        return {"ok": True}


@app.get("/api/staffing")
def get_staffing(user=Depends(current_user)):
    with db.get_db() as conn:
        rows = conn.execute("SELECT * FROM level_staffing").fetchall()
        out = {}
        for r in rows:
            out.setdefault(r["level_id"], []).append({"role_id": r["role_id"], "count": r["count"]})
        return out


@app.put("/api/levels/{level_id}/staffing")
async def set_staffing(level_id: int, request: Request, admin=Depends(require_admin)):
    b = await request.json()  # {"items": [{"role_id":1,"count":1}, ...]}
    with db.get_db() as conn:
        conn.execute("DELETE FROM level_staffing WHERE level_id=?", (level_id,))
        for item in b.get("items", []):
            if item.get("count", 0) > 0:
                conn.execute("INSERT INTO level_staffing (level_id, role_id, count) VALUES (?,?,?)",
                             (level_id, item["role_id"], item["count"]))
        return {"ok": True}


# ----------------------------------------------------------------------------
# templates + generation
# ----------------------------------------------------------------------------
@app.get("/api/templates")
def get_templates(admin=Depends(require_admin)):
    with db.get_db() as conn:
        rows = conn.execute("""
            SELECT t.*, r.name role_name, l.name level_name FROM templates t
            JOIN roles r ON r.id = t.role_id
            LEFT JOIN levels l ON l.id = t.level_id
            ORDER BY t.weekday, t.start_time""").fetchall()
        return db.dict_rows(rows)


@app.post("/api/templates")
async def add_template(request: Request, admin=Depends(require_admin)):
    b = await request.json()
    with db.get_db() as conn:
        cur = conn.execute(
            """INSERT INTO templates (weekday, start_time, end_time, level_id, role_id, count, label)
               VALUES (?,?,?,?,?,?,?)""",
            (b["weekday"], b["start_time"], b["end_time"], b.get("level_id"),
             b["role_id"], b.get("count", 1), b.get("label")))
        return {"ok": True, "id": cur.lastrowid}


@app.delete("/api/templates/{tid}")
def delete_template(tid: int, admin=Depends(require_admin)):
    with db.get_db() as conn:
        conn.execute("DELETE FROM templates WHERE id=?", (tid,))
        return {"ok": True}


@app.post("/api/generate")
async def generate(request: Request, admin=Depends(require_admin)):
    b = await request.json() if await _has_body(request) else {}
    weeks = int(b.get("weeks", 26))
    start = monday_of(date.today())
    end = start + timedelta(weeks=weeks) - timedelta(days=1)
    with db.get_db() as conn:
        created = generate_slots(conn, start, end) + generate_from_schedules(conn, start, end)
        return {"ok": True, "created": created, "from": start.isoformat(), "to": end.isoformat()}


# ----------------------------------------------------------------------------
# class schedules
# ----------------------------------------------------------------------------
@app.get("/api/class-schedules")
def get_class_schedules(admin=Depends(require_admin)):
    with db.get_db() as conn:
        rows = conn.execute("""
            SELECT ss.id, ss.schedule_id, cs.level_id, l.name level_name,
                   cs.weekday, cs.start_time, cs.end_time,
                   ss.role_id, r.name role_name, ss.user_id, u.full_name user_name, ss.count
            FROM schedule_staff ss
            JOIN class_schedules cs ON cs.id = ss.schedule_id
            JOIN roles r ON r.id = ss.role_id
            LEFT JOIN levels l ON l.id = cs.level_id
            LEFT JOIN users u ON u.id = ss.user_id
            WHERE cs.active = 1
            ORDER BY cs.level_id, cs.weekday, cs.start_time, r.sort_order
        """).fetchall()
        return db.dict_rows(rows)


@app.put("/api/class-schedules/level/{level_ref}")
async def set_level_schedule(level_ref: str, request: Request, admin=Depends(require_admin)):
    """Replace all class_schedule entries for a level.
    level_ref: integer level_id, or 'duty' for pool-duty (level_id=NULL).
    Body: {"sessions": [{"weekday":0,"start_time":"18:30","end_time":"19:00",
                          "role_id":2,"user_id":5,"count":1}, ...]}
    Sessions with identical (weekday, start_time, end_time) share one class_schedule row.
    """
    level_id = None if level_ref == "duty" else int(level_ref)
    b = await request.json()
    sessions = b.get("sessions", [])

    with db.get_db() as conn:
        # Delete existing schedules for this level
        if level_id is None:
            existing = [r["id"] for r in conn.execute(
                "SELECT id FROM class_schedules WHERE level_id IS NULL").fetchall()]
        else:
            existing = [r["id"] for r in conn.execute(
                "SELECT id FROM class_schedules WHERE level_id=?", (level_id,)).fetchall()]
        for sid in existing:
            conn.execute("DELETE FROM schedule_staff WHERE schedule_id=?", (sid,))
        if level_id is None:
            conn.execute("DELETE FROM class_schedules WHERE level_id IS NULL")
        else:
            conn.execute("DELETE FROM class_schedules WHERE level_id=?", (level_id,))

        # Group sessions by (weekday, start_time, end_time) → one class_schedule per slot
        slot_map: dict = {}
        for s in sessions:
            key = (s["weekday"], s["start_time"], s["end_time"])
            if key not in slot_map:
                slot_map[key] = []
            slot_map[key].append(s)

        for (wd, st, et), staff_list in slot_map.items():
            cur = conn.execute(
                "INSERT INTO class_schedules (level_id, weekday, start_time, end_time) VALUES (?,?,?,?)",
                (level_id, wd, st, et))
            sched_id = cur.lastrowid
            for s in staff_list:
                conn.execute(
                    "INSERT INTO schedule_staff (schedule_id, role_id, user_id, count) VALUES (?,?,?,?)",
                    (sched_id, s["role_id"], s.get("user_id"), s.get("count", 1)))

        return {"ok": True, "slots": len(slot_map)}


# ----------------------------------------------------------------------------
# reports
# ----------------------------------------------------------------------------
def _outstanding_rows(conn, frm, to):
    return conn.execute(f"""{SLOT_SELECT}
        WHERE s.status != 'approved' AND s.date >= ? AND s.date <= ?
        ORDER BY s.date, s.start_time""", (frm, to)).fetchall()


@app.get("/api/reports/outstanding")
def report_outstanding(request: Request, admin=Depends(require_admin)):
    q = request.query_params
    frm = q.get("from") or date.today().isoformat()
    to = q.get("to") or (date.today() + timedelta(weeks=4)).isoformat()
    with db.get_db() as conn:
        rows = db.dict_rows(_outstanding_rows(conn, frm, to))
    return {"from": frm, "to": to, "count": len(rows), "rows": rows}


@app.get("/api/reports/outstanding.csv")
def report_outstanding_csv(request: Request, admin=Depends(require_admin)):
    q = request.query_params
    frm = q.get("from") or date.today().isoformat()
    to = q.get("to") or (date.today() + timedelta(weeks=4)).isoformat()
    with db.get_db() as conn:
        rows = _outstanding_rows(conn, frm, to)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Date", "Start", "End", "Class", "Role", "Status", "Requested by"])
    for r in rows:
        w.writerow([r["date"], r["start_time"], r["end_time"], r["level_name"] or "Pool duty",
                    r["role_name"], r["status"], r["assigned_name"] or ""])
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f"attachment; filename=outstanding_{frm}_to_{to}.csv"})


@app.get("/api/reports/coverage")
def report_coverage(request: Request, admin=Depends(require_admin)):
    q = request.query_params
    frm = q.get("from") or date.today().isoformat()
    to = q.get("to") or (date.today() + timedelta(weeks=4)).isoformat()
    with db.get_db() as conn:
        rows = conn.execute("""
            SELECT date,
                   COUNT(*) total,
                   SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) approved,
                   SUM(CASE WHEN status='requested' THEN 1 ELSE 0 END) requested,
                   SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open
            FROM slots WHERE date >= ? AND date <= ?
            GROUP BY date ORDER BY date""", (frm, to)).fetchall()
        return {"from": frm, "to": to, "days": db.dict_rows(rows)}


@app.get("/api/reports/training")
def report_training(admin=Depends(require_admin)):
    today = date.today().isoformat()
    soon = (date.today() + timedelta(days=30)).isoformat()
    with db.get_db() as conn:
        rows = conn.execute("""
            SELECT DISTINCT u.id, u.full_name, u.training_expiry FROM users u
            JOIN user_roles ur ON ur.user_id = u.id
            JOIN roles r ON r.id = ur.role_id
            WHERE r.requires_training = 1 AND u.active = 1
            ORDER BY u.training_expiry IS NULL DESC, u.training_expiry""").fetchall()
        out = []
        for r in rows:
            exp = r["training_expiry"]
            if not exp:
                status = "missing"
            elif exp < today:
                status = "expired"
            elif exp < soon:
                status = "expiring"
            else:
                status = "valid"
            out.append({"id": r["id"], "full_name": r["full_name"],
                        "training_expiry": exp, "status": status})
        return {"rows": out}


# ----------------------------------------------------------------------------
# notifications
# ----------------------------------------------------------------------------
@app.get("/api/notifications")
def get_notifications(user=Depends(current_user)):
    with db.get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50",
            (user["id"],)).fetchall()
        unread = conn.execute(
            "SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0", (user["id"],)).fetchone()["c"]
        return {"unread": unread, "rows": db.dict_rows(rows)}


@app.post("/api/notifications/read-all")
def read_all(user=Depends(current_user)):
    with db.get_db() as conn:
        conn.execute("UPDATE notifications SET read=1 WHERE user_id=?", (user["id"],))
        return {"ok": True}


# ----------------------------------------------------------------------------
# messaging — channels, members, messages, SSE stream
# ----------------------------------------------------------------------------
import asyncio
import json as _json

# In-memory fan-out registry: channel_id -> list of asyncio.Queue
# Works correctly with a single uvicorn worker (default for this app).
_msg_subs: dict = {}   # {channel_id: [Queue, ...]}


def _fanout(channel_id: int, payload: dict):
    for q in list(_msg_subs.get(channel_id, [])):
        try: q.put_nowait(payload)
        except asyncio.QueueFull: pass


def _sync_role_channel_add(conn, user_id: int, role_id: int):
    ch = conn.execute("SELECT id FROM channels WHERE role_id=? AND active=1", (role_id,)).fetchone()
    if ch:
        conn.execute(
            "INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at, via_role) VALUES (?,?,?,1)",
            (ch["id"], user_id, now_iso()))


def _sync_role_channel_remove(conn, user_id: int, role_id: int):
    ch = conn.execute("SELECT id FROM channels WHERE role_id=? AND active=1", (role_id,)).fetchone()
    if ch:
        conn.execute(
            "DELETE FROM channel_members WHERE channel_id=? AND user_id=? AND via_role=1",
            (ch["id"], user_id))


def _user_channel_ids(conn, user_id: int):
    rows = conn.execute(
        "SELECT channel_id FROM channel_members WHERE user_id=?", (user_id,)).fetchall()
    return [r["channel_id"] for r in rows]


def _channel_payload(conn, ch, requesting_uid=None):
    last = conn.execute(
        """SELECT m.body, m.sent_at, u.full_name FROM messages m
           JOIN users u ON u.id=m.user_id
           WHERE m.channel_id=? AND m.deleted=0 ORDER BY m.id DESC LIMIT 1""",
        (ch["id"],)).fetchone()
    count = conn.execute(
        "SELECT COUNT(*) c FROM channel_members WHERE channel_id=?", (ch["id"],)).fetchone()["c"]

    # Unread count: messages after the user's last read
    unread = 0
    if requesting_uid:
        row = conn.execute(
            "SELECT last_read_id FROM channel_reads WHERE channel_id=? AND user_id=?",
            (ch["id"], requesting_uid)).fetchone()
        last_read_id = row["last_read_id"] if row else 0
        unread = conn.execute(
            """SELECT COUNT(*) c FROM messages
               WHERE channel_id=? AND id > ? AND deleted=0 AND user_id != ?""",
            (ch["id"], last_read_id, requesting_uid)).fetchone()["c"]

    # DM display name: "Message Admins" for the DM owner; user's full name for admins
    display_name = ch["name"]
    ch_type = ch["type"] if "type" in ch.keys() else "channel"
    dm_user_id = ch["dm_user_id"] if "dm_user_id" in ch.keys() else None
    if ch_type == "dm" and dm_user_id:
        if dm_user_id == requesting_uid:
            display_name = "Message Admins"
        else:
            dm_user = conn.execute(
                "SELECT full_name FROM users WHERE id=?", (dm_user_id,)).fetchone()
            display_name = dm_user["full_name"] if dm_user else ch["name"]

    role_id = ch["role_id"] if "role_id" in ch.keys() else None
    return {
        "id": ch["id"], "name": display_name, "description": ch["description"],
        "color": ch["color"], "member_count": count,
        "last_message": dict(last) if last else None,
        "unread": unread, "type": ch_type, "dm_user_id": dm_user_id,
        "role_id": role_id,
    }


@app.get("/api/channels")
def list_channels(user=Depends(current_user)):
    with db.get_db() as conn:
        if user["is_admin"]:
            rows = conn.execute(
                "SELECT * FROM channels WHERE active=1 ORDER BY type DESC, name"
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT c.* FROM channels c
                   JOIN channel_members cm ON cm.channel_id=c.id
                   WHERE cm.user_id=? AND c.active=1 ORDER BY c.type DESC, c.name""",
                (user["id"],)).fetchall()
        return [_channel_payload(conn, r, user["id"]) for r in rows]


@app.post("/api/channels")
async def create_channel(request: Request, admin=Depends(require_admin)):
    b = await request.json()
    if not b.get("name"): raise HTTPException(400, "name required")
    role_id = b.get("role_id") or None
    with db.get_db() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO channels (name, description, color, created_by, created_at, role_id) VALUES (?,?,?,?,?,?)",
                (b["name"], b.get("description",""), b.get("color","#26358B"), admin["id"], now_iso(), role_id))
        except Exception: raise HTTPException(409, "A channel with that name already exists.")
        cid = cur.lastrowid
        # Manual members
        for uid in b.get("member_ids", []):
            conn.execute("INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at, via_role) VALUES (?,?,?,0)",
                         (cid, uid, now_iso()))
        # Backfill role members
        if role_id:
            role_users = conn.execute("SELECT user_id FROM user_roles WHERE role_id=?", (role_id,)).fetchall()
            for ru in role_users:
                conn.execute("INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at, via_role) VALUES (?,?,?,1)",
                             (cid, ru["user_id"], now_iso()))
        return {"ok": True, "id": cid}


@app.patch("/api/channels/{cid}")
async def update_channel(cid: int, request: Request, admin=Depends(require_admin)):
    b = await request.json()
    with db.get_db() as conn:
        fields, params = [], []
        for col in ["name", "description", "color"]:
            if col in b: fields.append(f"{col}=?"); params.append(b[col])
        if "active" in b: fields.append("active=?"); params.append(1 if b["active"] else 0)

        if "role_id" in b:
            old_ch = conn.execute("SELECT role_id FROM channels WHERE id=?", (cid,)).fetchone()
            old_role_id = old_ch["role_id"] if old_ch and "role_id" in old_ch.keys() else None
            new_role_id = b["role_id"] or None
            fields.append("role_id=?"); params.append(new_role_id)
            # Remove auto-added members of the old role
            if old_role_id and old_role_id != new_role_id:
                old_users = conn.execute("SELECT user_id FROM user_roles WHERE role_id=?", (old_role_id,)).fetchall()
                for ru in old_users:
                    conn.execute("DELETE FROM channel_members WHERE channel_id=? AND user_id=? AND via_role=1",
                                 (cid, ru["user_id"]))
            # Backfill all current members of the new role
            if new_role_id:
                new_users = conn.execute("SELECT user_id FROM user_roles WHERE role_id=?", (new_role_id,)).fetchall()
                for ru in new_users:
                    conn.execute(
                        "INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at, via_role) VALUES (?,?,?,1)",
                        (cid, ru["user_id"], now_iso()))

        if fields:
            params.append(cid)
            conn.execute(f"UPDATE channels SET {','.join(fields)} WHERE id=?", params)

        if "member_ids" in b:
            new_ids = set(b["member_ids"])
            existing = conn.execute("SELECT user_id FROM channel_members WHERE channel_id=?", (cid,)).fetchall()
            for row in existing:
                if row["user_id"] not in new_ids:
                    conn.execute("DELETE FROM channel_members WHERE channel_id=? AND user_id=?",
                                 (cid, row["user_id"]))
            for uid in new_ids:
                conn.execute(
                    "INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at, via_role) VALUES (?,?,?,0)",
                    (cid, uid, now_iso()))
        return {"ok": True}


@app.delete("/api/channels/{cid}")
def delete_channel(cid: int, admin=Depends(require_admin)):
    with db.get_db() as conn:
        conn.execute("UPDATE channels SET active=0 WHERE id=?", (cid,))
        return {"ok": True}


@app.get("/api/channels/{cid}/members")
def channel_members(cid: int, user=Depends(current_user)):
    with db.get_db() as conn:
        rows = conn.execute(
            """SELECT u.id, u.full_name, u.username, cm.via_role FROM users u
               JOIN channel_members cm ON cm.user_id=u.id
               WHERE cm.channel_id=? ORDER BY u.full_name""", (cid,)).fetchall()
        return db.dict_rows(rows)


@app.get("/api/channels/{cid}/messages")
def get_messages(cid: int, request: Request, user=Depends(current_user)):
    before = request.query_params.get("before")  # message id for pagination
    with db.get_db() as conn:
        # Check membership (admins can always read)
        if not user["is_admin"]:
            if not conn.execute(
                "SELECT 1 FROM channel_members WHERE channel_id=? AND user_id=?",
                (cid, user["id"])).fetchone():
                raise HTTPException(403, "You are not a member of this channel.")
        extra = "AND m.id < ?" if before else ""
        params = [cid] + ([int(before)] if before else [])
        rows = conn.execute(
            f"""SELECT m.id, m.body, m.sent_at, m.deleted,
                       u.id user_id, u.full_name, u.username
                FROM messages m JOIN users u ON u.id=m.user_id
                WHERE m.channel_id=? {extra} AND m.deleted=0
                ORDER BY m.id DESC LIMIT 60""", params).fetchall()
        msgs = list(reversed(db.dict_rows(rows)))
        # Mark channel as read up to the latest message fetched
        if msgs and not before:
            max_id = msgs[-1]["id"]
            conn.execute(
                """INSERT OR REPLACE INTO channel_reads (channel_id, user_id, last_read_id)
                   VALUES (?,?,?)""",
                (cid, user["id"], max_id))
        return msgs


@app.post("/api/channels/{cid}/messages")
async def post_message(cid: int, request: Request, user=Depends(current_user)):
    b = await request.json()
    body = (b.get("body") or "").strip()
    if not body: raise HTTPException(400, "body required")
    if len(body) > 2000: raise HTTPException(400, "Message too long (max 2000 chars)")
    with db.get_db() as conn:
        if not user["is_admin"]:
            if not conn.execute(
                "SELECT 1 FROM channel_members WHERE channel_id=? AND user_id=?",
                (cid, user["id"])).fetchone():
                raise HTTPException(403, "You are not a member of this channel.")
        sent_at = now_iso()
        cur = conn.execute(
            "INSERT INTO messages (channel_id, user_id, body, sent_at) VALUES (?,?,?,?)",
            (cid, user["id"], body, sent_at))
        mid = cur.lastrowid
    payload = {
        "id": mid, "channel_id": cid, "body": body, "sent_at": sent_at,
        "user_id": user["id"], "full_name": user["full_name"], "username": user["username"],
    }
    _fanout(cid, payload)
    return {"ok": True, "id": mid}


@app.post("/api/channels/{cid}/read")
def mark_channel_read(cid: int, user=Depends(current_user)):
    with db.get_db() as conn:
        max_id = conn.execute(
            "SELECT COALESCE(MAX(id),0) m FROM messages WHERE channel_id=? AND deleted=0", (cid,)
        ).fetchone()["m"]
        conn.execute(
            """INSERT OR REPLACE INTO channel_reads (channel_id, user_id, last_read_id)
               VALUES (?,?,?)""",
            (cid, user["id"], max_id))
        return {"ok": True}


@app.delete("/api/channels/{cid}/messages/{mid}")
def delete_message(cid: int, mid: int, user=Depends(current_user)):
    with db.get_db() as conn:
        msg = conn.execute("SELECT * FROM messages WHERE id=? AND channel_id=?", (mid, cid)).fetchone()
        if not msg: raise HTTPException(404, "Message not found")
        if msg["user_id"] != user["id"] and not user["is_admin"]:
            raise HTTPException(403, "Can only delete your own messages")
        conn.execute("UPDATE messages SET deleted=1 WHERE id=?", (mid,))
        _fanout(cid, {"deleted": True, "id": mid, "channel_id": cid})
        return {"ok": True}


@app.get("/api/messages/stream")
async def message_stream(request: Request):
    """SSE endpoint. Auth via ?token= query param (EventSource can't set headers)."""
    token = request.query_params.get("token", "")
    uid = auth.verify_token(token)
    if not uid: raise HTTPException(401, "Invalid token")
    with db.get_db() as conn:
        u = conn.execute("SELECT * FROM users WHERE id=? AND active=1", (uid,)).fetchone()
        if not u: raise HTTPException(401, "User not found")
        channel_ids = _user_channel_ids(conn, uid)
        if u["is_admin"]:
            all_ch = conn.execute("SELECT id FROM channels WHERE active=1").fetchall()
            channel_ids = list({r["id"] for r in all_ch} | set(channel_ids))

    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    for cid in channel_ids:
        _msg_subs.setdefault(cid, []).append(q)

    async def generate():
        yield "retry: 3000\n\n"
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=25.0)
                    yield f"data: {_json.dumps(msg)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            for cid in channel_ids:
                try: _msg_subs[cid].remove(q)
                except (KeyError, ValueError): pass

    from fastapi.responses import StreamingResponse as SR
    return SR(generate(), media_type="text/event-stream",
              headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ----------------------------------------------------------------------------
# static / PWA
# ----------------------------------------------------------------------------
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/sw.js")
def service_worker():
    return FileResponse(os.path.join(STATIC, "sw.js"), media_type="application/javascript")


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(os.path.join(STATIC, "manifest.webmanifest"), media_type="application/manifest+json")


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC, "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8080, reload=False)
