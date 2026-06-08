"""SQLite storage layer for the Arc Swim Rota app.

Single-file schema + thin helpers. No ORM — keeps deps minimal and the data
model easy to read. Dates are stored as ISO 'YYYY-MM-DD', times as 'HH:MM'.
"""
import sqlite3
import os
from contextlib import contextmanager

DB_PATH = os.environ.get("SWIM_DB", os.path.join(os.path.dirname(__file__), "swim_rota.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    requires_training INTEGER NOT NULL DEFAULT 0,   -- 1 = must hold in-date lifeguard training
    color       TEXT NOT NULL DEFAULT '#26358B',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS levels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    full_name       TEXT NOT NULL,
    email           TEXT,
    phone           TEXT,
    is_admin        INTEGER NOT NULL DEFAULT 0,
    training_expiry TEXT,                 -- ISO date or NULL (lifeguard training expiry)
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL
);

-- which roles a person is qualified for (a person can be teacher AND lifeguard)
CREATE TABLE IF NOT EXISTS user_roles (
    user_id     INTEGER NOT NULL,
    role_id     INTEGER NOT NULL,
    PRIMARY KEY (user_id, role_id)
);

-- default staffing per swimming level, e.g. Parents & Toddlers => 1 Teacher + 1 Assistant
CREATE TABLE IF NOT EXISTS level_staffing (
    level_id    INTEGER NOT NULL,
    role_id     INTEGER NOT NULL,
    count       INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (level_id, role_id)
);

-- recurring weekly template rows used to generate slots in advance.
-- weekday: 0=Mon .. 6=Sun. level_id NULL + lane NULL = general pool (lifeguard) duty.
CREATE TABLE IF NOT EXISTS templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    weekday     INTEGER NOT NULL,
    start_time  TEXT NOT NULL,
    end_time    TEXT NOT NULL,
    level_id    INTEGER,
    lane        INTEGER,
    role_id     INTEGER NOT NULL,
    count       INTEGER NOT NULL DEFAULT 1,
    label       TEXT,
    active      INTEGER NOT NULL DEFAULT 1
);

-- the actual bookable shifts on the calendar. One row = one person-shift.
-- status: open | requested | approved
CREATE TABLE IF NOT EXISTS slots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    date            TEXT NOT NULL,
    start_time      TEXT NOT NULL,
    end_time        TEXT NOT NULL,
    level_id        INTEGER,
    lane            INTEGER,
    role_id         INTEGER NOT NULL,
    label           TEXT,
    assigned_user_id INTEGER,
    status          TEXT NOT NULL DEFAULT 'open',
    requested_at    TEXT,
    decided_at      TEXT,
    decided_by      INTEGER,
    template_id     INTEGER,
    notes           TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    message     TEXT NOT NULL,
    link        TEXT,
    created_at  TEXT NOT NULL,
    read        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    user_id     INTEGER,
    action      TEXT NOT NULL,
    detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_slots_date ON slots(date);
CREATE INDEX IF NOT EXISTS idx_slots_status ON slots(status);
CREATE INDEX IF NOT EXISTS idx_slots_user ON slots(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_slots_tmpl ON slots(template_id, date);

CREATE TABLE IF NOT EXISTS channels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    color       TEXT NOT NULL DEFAULT '#26358B',
    created_by  INTEGER,
    created_at  TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS channel_members (
    channel_id  INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    joined_at   TEXT NOT NULL,
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id  INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    body        TEXT NOT NULL,
    sent_at     TEXT NOT NULL,
    deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id);

-- Class schedule: one row per (level × weekday × time-slot).
-- level_id NULL = pool duty (lifeguard cover session).
CREATE TABLE IF NOT EXISTS class_schedules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    level_id    INTEGER,
    weekday     INTEGER NOT NULL,  -- 0=Mon .. 6=Sun
    start_time  TEXT NOT NULL,
    end_time    TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1
);

-- Staff requirement per class_schedule slot.
-- user_id NULL = open slot; non-NULL = auto-assigned (status='approved' on generation).
CREATE TABLE IF NOT EXISTS schedule_staff (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL,
    role_id     INTEGER NOT NULL,
    user_id     INTEGER,
    count       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_cs_level ON class_schedules(level_id, weekday);
CREATE INDEX IF NOT EXISTS idx_ss_sched ON schedule_staff(schedule_id);

-- Tracks the last message each user has read per channel, for unread counts.
CREATE TABLE IF NOT EXISTS channel_reads (
    channel_id  INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
);
"""


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")    # better read/write concurrency
    conn.execute("PRAGMA busy_timeout = 8000")   # wait out brief write locks
    return conn


@contextmanager
def get_db():
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript(SCHEMA)
        # Migrations: add columns to channels if they don't exist yet
        for stmt in [
            "ALTER TABLE channels ADD COLUMN type TEXT NOT NULL DEFAULT 'channel'",
            "ALTER TABLE channels ADD COLUMN dm_user_id INTEGER",
            "ALTER TABLE roles ADD COLUMN shortcode TEXT",
            "ALTER TABLE channels ADD COLUMN role_id INTEGER",
            "ALTER TABLE channel_members ADD COLUMN via_role INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE audit ADD COLUMN category TEXT NOT NULL DEFAULT 'shifts'",
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('timezone', 'Europe/London')",
            "ALTER TABLE channels ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0",
            "UPDATE channels SET is_system=1 WHERE name='All Staff'",
            "ALTER TABLE channels ADD COLUMN deleted_at TEXT",
            "ALTER TABLE channels ADD COLUMN deleted_by INTEGER",
            "ALTER TABLE users ADD COLUMN deleted_at TEXT",
            "ALTER TABLE users ADD COLUMN deleted_by INTEGER",
        ]:
            try:
                conn.execute(stmt)
            except Exception:
                pass


def dict_rows(rows):
    return [dict(r) for r in rows]
