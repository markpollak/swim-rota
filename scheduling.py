"""Slot generation from templates and class_schedules."""
from datetime import date, timedelta, datetime


def half_hour_blocks(start_hhmm: str, end_hhmm: str):
    """Yield (start, end) 'HH:MM' tuples for each 30-min block in [start, end)."""
    t = datetime.strptime(start_hhmm, "%H:%M")
    end = datetime.strptime(end_hhmm, "%H:%M")
    while t < end:
        nxt = t + timedelta(minutes=30)
        yield t.strftime("%H:%M"), nxt.strftime("%H:%M")
        t = nxt


def monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def generate_slots(conn, from_date: date, to_date: date) -> int:
    """Materialise slots from active templates. Idempotent."""
    templates = conn.execute("""
        SELECT t.* FROM templates t
        LEFT JOIN levels l ON l.id = t.level_id
        WHERE t.active = 1 AND (t.level_id IS NULL OR l.active = 1)
    """).fetchall()
    created = 0
    d = from_date
    while d <= to_date:
        iso = d.isoformat()
        wd = d.weekday()
        for t in templates:
            if t["weekday"] != wd:
                continue
            existing = conn.execute(
                "SELECT COUNT(*) c FROM slots WHERE template_id = ? AND date = ?",
                (t["id"], iso),
            ).fetchone()["c"]
            need = t["count"] - existing
            for _ in range(max(0, need)):
                conn.execute(
                    """INSERT INTO slots (date, start_time, end_time, level_id,
                            role_id, label, status, template_id)
                       VALUES (?,?,?,?,?,?, 'open', ?)""",
                    (iso, t["start_time"], t["end_time"], t["level_id"],
                     t["role_id"], t["label"], t["id"]),
                )
                created += 1
        d += timedelta(days=1)
    return created


def generate_from_schedules(conn, from_date: date, to_date: date) -> int:
    """Materialise slots from class_schedules + schedule_staff. Idempotent.
    Auto-assigned staff (user_id set) get status='approved' immediately.
    """
    # Flat join: one row per (schedule × staff_row)
    rows = conn.execute("""
        SELECT cs.id schedule_id, cs.level_id, cs.weekday, cs.start_time, cs.end_time,
               l.name level_name,
               ss.role_id, ss.user_id, ss.count
        FROM class_schedules cs
        LEFT JOIN levels l ON l.id = cs.level_id
        JOIN schedule_staff ss ON ss.schedule_id = cs.id
        WHERE cs.active = 1 AND (cs.level_id IS NULL OR l.active = 1)
    """).fetchall()

    created = 0
    d = from_date
    while d <= to_date:
        iso = d.isoformat()
        wd = d.weekday()
        for r in rows:
            if r["weekday"] != wd:
                continue
            if r["user_id"]:
                # Check if this specific user already has a slot here
                if r["level_id"] is None:
                    exists = conn.execute("""
                        SELECT COUNT(*) c FROM slots
                        WHERE date=? AND start_time=? AND end_time=?
                        AND level_id IS NULL AND role_id=? AND assigned_user_id=?
                    """, (iso, r["start_time"], r["end_time"],
                          r["role_id"], r["user_id"])).fetchone()["c"]
                else:
                    exists = conn.execute("""
                        SELECT COUNT(*) c FROM slots
                        WHERE date=? AND start_time=? AND end_time=?
                        AND level_id=? AND role_id=? AND assigned_user_id=?
                    """, (iso, r["start_time"], r["end_time"],
                          r["level_id"], r["role_id"], r["user_id"])).fetchone()["c"]
                need = r["count"] - exists
                for _ in range(max(0, need)):
                    now = datetime.utcnow().isoformat(timespec="seconds")
                    conn.execute("""
                        INSERT INTO slots (date,start_time,end_time,level_id,role_id,
                            label,status,assigned_user_id,requested_at,decided_at,source_schedule_id)
                        VALUES (?,?,?,?,?,?,'approved',?,?,?,?)
                    """, (iso, r["start_time"], r["end_time"], r["level_id"],
                          r["role_id"], r["level_name"], r["user_id"], now, now, r["schedule_id"]))
                    created += 1
            else:
                # Open slot — count all existing slots at this time/level/role
                if r["level_id"] is None:
                    existing = conn.execute("""
                        SELECT COUNT(*) c FROM slots
                        WHERE date=? AND start_time=? AND end_time=?
                        AND level_id IS NULL AND role_id=?
                    """, (iso, r["start_time"], r["end_time"], r["role_id"])).fetchone()["c"]
                else:
                    existing = conn.execute("""
                        SELECT COUNT(*) c FROM slots
                        WHERE date=? AND start_time=? AND end_time=?
                        AND level_id=? AND role_id=?
                    """, (iso, r["start_time"], r["end_time"],
                          r["level_id"], r["role_id"])).fetchone()["c"]
                need = r["count"] - existing
                for _ in range(max(0, need)):
                    conn.execute("""
                        INSERT INTO slots (date,start_time,end_time,level_id,role_id,label,status,source_schedule_id)
                        VALUES (?,?,?,?,?,?,'open',?)
                    """, (iso, r["start_time"], r["end_time"], r["level_id"],
                          r["role_id"], r["level_name"], r["schedule_id"]))
                    created += 1
        d += timedelta(days=1)
    return created


def extend_to_horizon(conn, weeks: int = 26) -> int:
    """Ensure slots exist for the next `weeks` weeks (~6 months). Idempotent."""
    today = date.today()
    horizon = today + timedelta(weeks=weeks)
    # Quick check: if we already have slots that far out, skip
    furthest = conn.execute(
        "SELECT MAX(date) d FROM slots WHERE date >= ?", (today.isoformat(),)
    ).fetchone()["d"]
    if furthest and furthest >= horizon.isoformat():
        return 0
    start = monday_of(today)
    return generate_slots(conn, start, horizon) + generate_from_schedules(conn, start, horizon)
