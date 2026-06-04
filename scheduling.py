"""Slot generation from weekly templates."""
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
    """Materialise slots from active templates across [from_date, to_date] inclusive.

    Idempotent: for each (template, date) it only tops up to the template's count,
    so re-running never duplicates existing shifts.
    """
    templates = conn.execute("SELECT * FROM templates WHERE active = 1").fetchall()
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
                    """INSERT INTO slots (date, start_time, end_time, level_id, lane,
                            role_id, label, status, template_id)
                       VALUES (?,?,?,?,?,?,?, 'open', ?)""",
                    (iso, t["start_time"], t["end_time"], t["level_id"], t["lane"],
                     t["role_id"], t["label"], t["id"]),
                )
                created += 1
        d += timedelta(days=1)
    return created
