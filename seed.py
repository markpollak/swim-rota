"""Seed the database with realistic dummy data for the Arc, Matlock.

Run:  python seed.py          (only seeds if empty)
      python seed.py --force  (wipes and reseeds)
"""
import sys
import random
from datetime import date, timedelta, datetime

from db import get_db, init_db, DB_PATH
from auth import hash_password
from scheduling import half_hour_blocks, monday_of, generate_slots

random.seed(7)

ROLES = [
    # name, requires_training, color
    ("Teacher", 0, "#26358B"),
    ("Lifeguard", 1, "#A4358B"),
    ("Assistant Teacher", 0, "#0E9F8E"),
]

LEVELS = ["Parents & Toddlers"] + [f"Level {i}" for i in range(1, 11)]

# default staffing per level: level -> list of (role_name, count)
STAFFING = {
    "Parents & Toddlers": [("Teacher", 1), ("Assistant Teacher", 1)],
    "Level 1": [("Teacher", 1), ("Assistant Teacher", 1)],
}
# everything else defaults to a single Teacher
DEFAULT_STAFFING = [("Teacher", 1)]

# weekday (0=Mon) -> evening plan. Different evenings run different classes.
WEEK_PLAN = {
    0: ("16:00", "19:00", ["Parents & Toddlers", "Level 1", "Level 2", "Level 3", "Level 4", "Level 5"]),
    1: ("16:00", "19:00", ["Level 1", "Level 2", "Level 3", "Level 6", "Level 7", "Level 8"]),
    2: ("16:00", "19:00", ["Parents & Toddlers", "Level 1", "Level 2", "Level 4", "Level 5", "Level 9"]),
    3: ("16:00", "18:30", ["Level 3", "Level 4", "Level 5", "Level 6", "Level 7", "Level 10"]),
    4: ("16:00", "18:00", ["Parents & Toddlers", "Level 1", "Level 2", "Level 3"]),
    5: ("09:00", "11:30", ["Parents & Toddlers", "Level 1", "Level 2", "Level 3", "Level 4", "Level 5"]),
}
LANES = 6

# username, full_name, password, is_admin, roles, training_offset_days (None=no training set)
USERS = [
    ("admin", "Sarah Hughes", "admin123", 1, ["Teacher", "Lifeguard"], 200),
    ("emma", "Emma Watson", "password", 0, ["Teacher", "Lifeguard"], 18),   # expiring soon
    ("james", "James Carter", "password", 0, ["Lifeguard"], 240),
    ("olivia", "Olivia Bennett", "password", 0, ["Teacher"], None),
    ("liam", "Liam Foster", "password", 0, ["Teacher", "Assistant Teacher"], None),
    ("sophie", "Sophie Turner", "password", 0, ["Lifeguard", "Teacher"], -12),  # EXPIRED
    ("noah", "Noah Patel", "password", 0, ["Assistant Teacher"], None),
    ("grace", "Grace Miller", "password", 0, ["Teacher", "Lifeguard"], 320),
    ("daniel", "Daniel Reed", "password", 0, ["Lifeguard"], 95),
    ("chloe", "Chloe Adams", "password", 0, ["Teacher"], None),
]


def seeded(conn):
    return conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"] > 0


def wipe(conn):
    for t in ["audit", "notifications", "slots", "templates", "level_staffing",
              "user_roles", "users", "levels", "roles",
              "messages", "channel_members", "channels",
              "channel_reads", "class_schedules", "schedule_staff"]:
        conn.execute(f"DELETE FROM {t}")
        conn.execute("DELETE FROM sqlite_sequence WHERE name = ?", (t,))


def run(force=False):
    init_db()
    with get_db() as conn:
        if seeded(conn) and not force:
            print("Database already has data; use --force to wipe and reseed.")
            return
        if force:
            wipe(conn)

        now = datetime.utcnow().isoformat(timespec="seconds")
        today = date.today()

        # roles
        role_id = {}
        for i, (name, req, color) in enumerate(ROLES):
            cur = conn.execute(
                "INSERT INTO roles (name, requires_training, color, sort_order) VALUES (?,?,?,?)",
                (name, req, color, i))
            role_id[name] = cur.lastrowid

        # levels
        level_id = {}
        for i, name in enumerate(LEVELS):
            cur = conn.execute("INSERT INTO levels (name, sort_order) VALUES (?,?)", (name, i))
            level_id[name] = cur.lastrowid

        # staffing defaults
        for lvl in LEVELS:
            for rname, cnt in STAFFING.get(lvl, DEFAULT_STAFFING):
                conn.execute(
                    "INSERT INTO level_staffing (level_id, role_id, count) VALUES (?,?,?)",
                    (level_id[lvl], role_id[rname], cnt))

        # users
        user_id = {}
        for uname, full, pw, admin, roles, toff in USERS:
            expiry = (today + timedelta(days=toff)).isoformat() if toff is not None else None
            cur = conn.execute(
                """INSERT INTO users (username, password_hash, full_name, email, phone,
                        is_admin, training_expiry, created_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (uname, hash_password(pw), full, f"{uname}@thearc-matlock.example",
                 f"07{random.randint(100,999)} {random.randint(100000,999999)}",
                 admin, expiry, now))
            user_id[uname] = cur.lastrowid
            for r in roles:
                conn.execute("INSERT INTO user_roles (user_id, role_id) VALUES (?,?)",
                             (user_id[uname], role_id[r]))

        # ---- Lifeguard cover: 06:30–21:00 every day, 2 lifeguards required per slot ----
        lg_blocks = list(half_hour_blocks("06:30", "21:00"))
        for wd in range(7):
            for s, e in lg_blocks:
                conn.execute(
                    """INSERT INTO templates (weekday, start_time, end_time, level_id, lane,
                            role_id, count, label) VALUES (?,?,?,?,?,?,?,?)""",
                    (wd, s, e, None, None, role_id["Lifeguard"], 2, "Pool Lifeguard"))

        # ---- Teaching schedule from weekly plan (no lifeguards embedded) ----
        for wd, (start, end, levels) in WEEK_PLAN.items():
            blocks = list(half_hour_blocks(start, end))
            for b, (s, e) in enumerate(blocks):
                for lane in range(1, LANES + 1):
                    lvl = levels[(b + lane - 1) % len(levels)]
                    for rname, cnt in STAFFING.get(lvl, DEFAULT_STAFFING):
                        conn.execute(
                            """INSERT INTO templates (weekday, start_time, end_time, level_id,
                                    lane, role_id, count, label) VALUES (?,?,?,?,?,?,?,?)""",
                            (wd, s, e, level_id[lvl], lane, role_id[rname], cnt, lvl))

        # materialise 4 weeks of slots from this Monday
        wk_start = monday_of(today)
        generate_slots(conn, wk_start, wk_start + timedelta(weeks=4) - timedelta(days=1))

        # --- make the demo lively: approve some, request some, leave some open ---
        qualified = {}  # role_id -> [user_id] of in-date, qualified users
        for r_name, rid in role_id.items():
            rows = conn.execute(
                """SELECT u.id, u.training_expiry FROM users u
                   JOIN user_roles ur ON ur.user_id = u.id
                   WHERE ur.role_id = ? AND u.active = 1""", (rid,)).fetchall()
            ok = []
            for u in rows:
                req = conn.execute("SELECT requires_training FROM roles WHERE id=?", (rid,)).fetchone()["requires_training"]
                if req and (not u["training_expiry"] or u["training_expiry"] < today.isoformat()):
                    continue
                ok.append(u["id"])
            qualified[rid] = ok

        # user_id -> list of (start_time, end_time) already assigned on each date
        booked = {}  # (user_id, date) -> [(start, end), ...]

        def seed_overlaps(uid, date, start, end):
            for (s, e) in booked.get((uid, date), []):
                if start < e and s < end:
                    return True
            return False

        slots = conn.execute("SELECT * FROM slots ORDER BY date, start_time").fetchall()
        for sl in slots:
            pool = qualified.get(sl["role_id"], [])
            if not pool:
                continue
            roll = random.random()
            # pick a user who doesn't already have a clashing shift
            candidates = [u for u in pool if not seed_overlaps(u, sl["date"], sl["start_time"], sl["end_time"])]
            if not candidates:
                continue
            uid = random.choice(candidates)
            if roll < 0.55:      # approved
                conn.execute(
                    """UPDATE slots SET assigned_user_id=?, status='approved',
                            requested_at=?, decided_at=?, decided_by=? WHERE id=?""",
                    (uid, now, now, user_id["admin"], sl["id"]))
                booked.setdefault((uid, sl["date"]), []).append((sl["start_time"], sl["end_time"]))
            elif roll < 0.72:    # pending approval (admin queue)
                conn.execute(
                    "UPDATE slots SET assigned_user_id=?, status='requested', requested_at=? WHERE id=?",
                    (uid, now, sl["id"]))
                booked.setdefault((uid, sl["date"]), []).append((sl["start_time"], sl["end_time"]))
            # else leave open

        # a couple of explicit pending requests + a notification for the demo
        conn.execute(
            "INSERT INTO notifications (user_id, message, link, created_at) VALUES (?,?,?,?)",
            (user_id["emma"], "Your lifeguard training expires soon — please renew.", "profile", now))

        # ---- messaging channels ----
        CHANNELS = [
            ("All Staff",       "Whole team announcements",        "#26358B",
             ["admin","emma","james","olivia","liam","sophie","noah","grace","daniel","chloe"]),
            ("Lifeguards",      "Lifeguard team chat",             "#A4358B",
             ["admin","emma","james","sophie","grace","daniel"]),
            ("Teachers",        "Teaching staff chat",             "#0E9F8E",
             ["admin","emma","olivia","liam","sophie","grace","chloe"]),
            ("Assistant Teachers","Assistant teacher channel",     "#c77700",
             ["admin","liam","noah"]),
            ("Management",      "Admin & coordinators only",       "#1b2767",
             ["admin"]),
        ]
        # Seed messages per channel for demo realism
        DEMO_MESSAGES = {
            "All Staff": [
                ("admin",  "Welcome to the Arc Swim Rota messaging! Use the relevant channel for your team. 👋"),
                ("admin",  "Reminder: please keep your training certificates up to date."),
                ("emma",   "Thanks! Looking forward to the new system 😊"),
                ("grace",  "Great stuff, much easier than the old email chain!"),
            ],
            "Lifeguards": [
                ("james",  "Anyone able to cover the 07:30–08:00 slot on Saturday?"),
                ("grace",  "I can do it, I'll request it now"),
                ("daniel", "Thanks Grace 👍"),
                ("james",  "Has everyone renewed their training certificates?"),
                ("admin",  "Sophie — yours has expired, please sort asap before we can approve any more lifeguard shifts."),
            ],
            "Teachers": [
                ("olivia", "Can anyone swap my Level 3 on Thursday 17:00?"),
                ("chloe",  "I might be able to — which lane?"),
                ("olivia", "Lane 2"),
                ("chloe",  "Yes I can cover that, let admin know"),
                ("admin",  "Done — I'll update the rota"),
                ("liam",   "Reminder that the Level 1 gala is next Saturday morning 🏆"),
            ],
            "Assistant Teachers": [
                ("liam",   "Noah, can you assist with Parents & Toddlers this Monday?"),
                ("noah",   "Yes, I'll be there for 16:00"),
                ("liam",   "Perfect, thank you!"),
            ],
            "Management": [
                ("admin",  "Staff rota system is now live. Remember to approve all requests promptly."),
            ],
        }
        ch_id = {}
        for name, desc, color, members in CHANNELS:
            cur = conn.execute(
                "INSERT INTO channels (name, description, color, created_by, created_at) VALUES (?,?,?,?,?)",
                (name, desc, color, user_id["admin"], now))
            cid = cur.lastrowid
            ch_id[name] = cid
            for uname in members:
                uid = user_id.get(uname)
                if uid:
                    conn.execute("INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?,?,?)",
                                 (cid, uid, now))
            for uname, body in DEMO_MESSAGES.get(name, []):
                uid = user_id.get(uname)
                if uid:
                    conn.execute("INSERT INTO messages (channel_id, user_id, body, sent_at) VALUES (?,?,?,?)",
                                 (cid, uid, body, now))

        print(f"Seeded {DB_PATH}")
        counts = {t: conn.execute(f"SELECT COUNT(*) c FROM {t}").fetchone()["c"]
                  for t in ["users", "roles", "levels", "templates", "slots", "channels", "messages"]}
        print("Counts:", counts)
        print("\nLogins (all demo passwords as below):")
        print("  admin / admin123   (administrator)")
        print("  emma|james|olivia|liam|sophie|noah|grace|daniel|chloe / password")


if __name__ == "__main__":
    run(force="--force" in sys.argv)
