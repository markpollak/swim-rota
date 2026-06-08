# Arc Swim Rota — Code & Deployment Audit

**Date:** 8 June 2026 (re-checked against later commits same day)
**Scope:** Full review of the application as it stands on `master` (HEAD `acd1c07`).
**Question being answered:** *Could this be deployed for real-world use? How does it behave with concurrent users? What bugs and improvements stand out?*

> **Re-audit note.** This report was first written against `c48be6d` and then re-verified against two further commits (`7f88ce4`, `acd1c07`). Both are **frontend-only** — `server.py`, `db.py`, `scheduling.py` and `auth.py` are unchanged — so the backend findings below still hold **verbatim** (the two booking races C1/C2 were confirmed present at `server.py` lines 290, 358, 416, 517). Two corrections from the re-check: finding **D3 was wrong** (the deactivation audit trail *is* fully implemented — see D3 below), and finding **D4 has widened** (service-worker cache drift is now v33-vs-v47). The two new commits are summarised in the addendum at the end.
>
> **✅ Fix applied (post-review).** Findings **C1 and C2 have since been fixed and verified** — see the resolution notes under each below and the new `tests/test_concurrency.py` (3 tests; the key one fails on the pre-fix code and passes after). This was a server-side-only change (`server.py`, `db.py`), so no service-worker version bump was required.

---

## TL;DR verdict

For its **actual** target — a single leisure-centre pool (The Arc, Matlock), ~10–50 staff, a handful of people online at once — the app is **close to production-ready and already deployed** (Docker + Caddy auto-HTTPS on a $6 droplet). The architecture is clean, the security fundamentals are sound, and the feature set is genuinely complete.

**Before real staff rely on it**, fix the two concurrency bugs in the shift-booking path (sections C1 and C2). They are small, surgical fixes, but they attack the app's core promise — *who holds which shift* — and they get **more likely exactly when the app is most useful** (everyone grabbing shifts the moment the rota opens). After that, harden the admin credential story, add login rate-limiting, and correct the timezone basis.

SQLite is a perfectly good choice at this scale. It will **not** scale to many pools / high concurrency without moving real-time messaging to a shared broker and probably swapping to Postgres — but that is a "next product" concern, not a blocker for The Arc.

| Area | Rating |
|---|---|
| Architecture & code quality | 🟢 Strong |
| Security fundamentals (authn, SQLi, XSS, secrets) | 🟢 Good, with gaps (C4–C6) |
| **Concurrency / data integrity** | 🔴 **Two real races — must fix** |
| Input validation / error handling | 🟡 Gaps (500s on bad input) |
| Feature completeness | 🟢 Excellent for the use case |
| Operability (deploy, backup, logs) | 🟢 Good |
| Testing | 🔴 None |
| Horizontal scalability | 🟡 Single-worker ceiling (by design) |

---

## A. What's good (and worth keeping)

- **Minimal, legible stack.** FastAPI + SQLite + vanilla-JS PWA, ~5,300 LOC, **no build step**. Anyone can read it end-to-end in an afternoon. For a tool one person will maintain, this is the right amount of technology.
- **Sound auth primitives.** PBKDF2-HMAC-SHA256 at 120k iterations with a per-user salt; HMAC-signed bearer tokens with a 30-day TTL (`auth.py`). No third-party auth dependency, no foot-guns.
- **No SQL injection.** Every query is parameterised. The few dynamic fragments (`UPDATE users SET {','.join(fields)}`) build column lists from **hard-coded whitelists**, never user input.
- **Consistent XSS hygiene.** The frontend routes user-supplied strings through `esc()` everywhere it matters — including chat message bodies and display names (`appendBubble`, `chRow`). I could not find an unescaped injection of user data into `innerHTML`.
- **Sensible SQLite concurrency posture.** `journal_mode = WAL`, `busy_timeout = 8000`, `timeout = 15` (`db.py`) — readers don't block the writer, and brief write locks are waited out rather than erroring.
- **Secrets handled correctly.** `swim_rota.db`, `.secret`, `.env` are in **both** `.gitignore` and `.dockerignore`. `docker-compose.yml` *requires* `SWIM_SECRET` to be set (`${SWIM_SECRET:?...}`), with a file-persisted fallback for dev only.
- **Operability.** Indices on hot columns; idempotent slot generation; one-command deploy (`deploy.sh`); documented DB backup; soft-deletes (`active=0`) that preserve history; an `audit` table plus an in-app Activity log.
- **Real product thinking.** Training-expiry enforcement, double-booking *intent*, clash warnings, coverage reports, role-scoped messaging, a PWA you can install on a phone. This is not a toy.

---

## B. Concurrency — how it behaves with multiple users

This is the section you specifically asked about, so it gets the most detail.

**Threading model.** FastAPI runs **synchronous** route handlers (`def`, e.g. `request_slot`, `approve_slot`, `assign_slot`) in a worker **threadpool**, so they execute **genuinely in parallel** across threads. SQLite (WAL) serialises *writes*, but it does **not** serialise a read-then-write *sequence* that spans two separate statements. Python's `sqlite3` only opens the implicit transaction at the first `INSERT/UPDATE/DELETE`; the `SELECT` that precedes it runs unprotected. That gap is where the bugs live.

### 🔴 C1 — Two people can "successfully" claim the same open slot (lost update / TOCTOU)

`request_slot` (`server.py`) does:

```python
s = _get_slot(conn, slot_id)            # SELECT
if s["status"] != "open": raise 409     # check
...
conn.execute("UPDATE slots SET assigned_user_id=?, status='requested' WHERE id=?", ...)  # write — NO status guard
```

Two staff requesting the same open slot at the same instant **both** read `status='open'`, **both** pass the check, **both** UPDATE. The second write silently overwrites the first. **Both clients receive `{"ok": true}`** and both believe the shift is theirs — but only the last writer actually holds it. The first person finds out only when they show up, or never.

The identical unguarded `SELECT → UPDATE` pattern appears in `assign_slot`, `approve_slot`, and `bulk_assign`.

**Fix (small):** make the write *conditional* and verify it changed a row.

```python
cur = conn.execute(
    "UPDATE slots SET assigned_user_id=?, status='requested', requested_at=? "
    "WHERE id=? AND status='open'",
    (user["id"], now_iso(), slot_id))
if cur.rowcount == 0:
    raise HTTPException(409, "That shift was just taken.")
```

Apply the same `WHERE … AND status = <expected>` guard to assign/approve/bulk-assign.

> **✅ Resolved.** `request_slot`, `approve_slot`, `assign_slot` and `bulk_assign` now run inside `db.get_db_immediate()` (BEGIN IMMEDIATE) and use status-guarded conditional `UPDATE`s with a `rowcount` check — a lost claim now returns 409 ("That shift was just taken by someone else.") instead of a false success. Covered by `tests/test_concurrency.py::test_concurrent_request_single_winner` (six users hit one slot → exactly one 200).

### 🔴 C2 — Double-booking prevention can be bypassed under concurrency

`check_double_book` reads the user's existing shifts, then the handler writes the new one. Two overlapping requests **by the same user**, fired near-simultaneously (a double-tap on two different open slots, or a flaky network retry), can **both** pass the check — because neither has committed yet — and **both** commit. The user ends up double-booked, defeating the feature that is supposed to prevent exactly this.

Note the client-side `b.disabled = true` guard only blocks re-clicking the **same** button; it does nothing for two different slots or two devices.

**Fix:** serialise the check-and-write by starting an immediate transaction so concurrent writers queue:

```python
conn.execute("BEGIN IMMEDIATE")   # take the write lock before the SELECT
check_double_book(conn, user_id, s)
# ... conditional UPDATE as in C1 ...
```

(With `BEGIN IMMEDIATE`, combined with the `busy_timeout`, the second thread waits for the first to commit and then re-evaluates against committed state.)

> **✅ Resolved.** The booking handlers now serialise via `BEGIN IMMEDIATE`, so the double-book check and the write happen atomically with respect to other writers. Covered by `tests/test_concurrency.py::test_concurrent_double_book_prevented` (one user requests two overlapping slots simultaneously → ends up holding exactly one).

> **Why this matters more than it looks:** both races are essentially harmless during quiet testing and become probable precisely at the busy moment the app exists for — the rota opening and everyone piling in. They are the difference between "a neat demo" and "staff can trust it."

---

## C. Security findings

### 🟡 C3 — Foreign keys are declared "ON" but not enforced
`PRAGMA foreign_keys = ON` is set, but **no table declares `REFERENCES`**, so there are zero enforced constraints. The hard-deletes that do exist (`DELETE FROM slots`, `templates`, `user_roles`, schedule rebuilds) can orphan related rows (`notifications`/`audit` pointing at a deleted slot, etc.). Mostly mitigated because most entities are soft-deleted. *Fix:* add real FK constraints with `ON DELETE` rules, or document the denormalisation as intentional.

### 🟡 C4 — No login rate-limiting
`/api/login` has no throttle, lockout, or backoff. PBKDF2 slows offline cracking, but the endpoint is open to online credential-stuffing. *Fix:* per-IP + per-username rate limit with exponential backoff.

### 🟡 C5 — No token revocation
Tokens are stateless 30-day HMACs. A leaked token is valid until it expires; you can't sign out a single device, and the only "log everyone out" lever is rotating `SWIM_SECRET`. Deactivating a user *is* honoured (the `active=1` check in `current_user`), which covers the most important case. *Fix (optional):* a per-user `token_epoch` mixed into the signature.

### 🟡 C6 — Demo credentials ship in the product
The admin account seeds as `admin / admin123`, and the **login screen renders the demo credentials** (`renderLogin`). Nothing forces a password change. For a real deployment this must change: env-gate the demo hint block, force a password reset for the seeded admin on first login, and don't seed demo staff in production. *(DEPLOY.md does tell the operator to change it — but "please remember" is not a control.)*

### 🟢 No CORS exposure
The API is same-origin behind Caddy with no permissive CORS middleware — correct for a first-party PWA. Worth adding a couple of security headers (HSTS, `X-Content-Type-Options`, a basic CSP) at the Caddy layer.

---

## D. Correctness & robustness

### 🟡 D1 — Timezone basis is inconsistent
Timestamps are stored as UTC (`datetime.utcnow()`) — good — but "today"/"is this shift in the past" logic uses `date.today()`, which is the **server's local date**. The container has no TZ set (defaults to UTC) while the app's configured timezone is `Europe/London`. Around midnight, and throughout BST, a shift can be mis-classified as past/future or land on the wrong day boundary. The frontend correctly converts UTC→configured-tz for *display*; the server-side *comparisons* don't. *Fix:* derive "today" from the configured timezone (`zoneinfo`) everywhere it gates behaviour.

### 🟡 D2 — Bad input returns 500 instead of 400
Several spots throw on malformed input and surface a 500:
- `int(page)` / `int(before)` in `get_activity` / `get_messages` (non-numeric query param).
- `date.fromisoformat()` in `/api/slots/week` (bad date).
- `int(level_ref)` in `set_level_schedule` (anything that isn't an int or `"duty"`).
- `create_slot` accepts arbitrary `date`/`start_time`/`end_time` strings with **no** format or logic validation (end-before-start, malformed times, overlaps).

*Fix:* validate and return 400 (Pydantic models, or guarded casts).

### ✅ D3 — "Deactivated staff audit trail" — *verified correct (correction)*
*An earlier draft of this audit flagged this as half-built; that was a stale read. It is fully wired up.* The `db.py` migrations add `users.deleted_at` / `users.deleted_by` (and the equivalents on `channels`); `update_user` sets `deleted_at = now()` and `deleted_by = admin` on deactivation and clears them on reactivation; `user_payload` resolves and returns `deleted_by_name`; and the frontend renders the "Deactivated *when* by *who*" line correctly. The same pattern backs the **deleted-channels archive** (soft-delete with `deleted_at`/`deleted_by`, message history preserved, restorable). No action needed — noted here as a strength.

### 🟢/🟡 D4 — Service-worker cache version drift (now wider)
`static/sw.js` `SHELL` still pins `?v=33` for `app.js`/`styles.css`, while `index.html` and the `CACHE` name have since climbed to **`v47`** — so the gap has *grown* across the day's commits (`CACHE` is dutifully bumped each time, but the two `SHELL` query-strings are consistently forgotten — exactly the failure mode the "bump in three places" rule in `CLAUDE.md` warns about). Because the fetch handler is network-on-miss, live users still get the v47 files (the precache just stores never-requested v33 copies), so the practical impact is near-zero — but a brand-new install that goes offline *before* its first online load could serve a stale shell. *Fix:* keep `SHELL` versions in lockstep, or — better — drop the query strings from `SHELL` and rely on the `CACHE` name alone so this can't drift again.

---

## E. Performance & scalability

- **🟡 E1 — Real-time messaging is single-worker by design.** The SSE fan-out registry (`_msg_subs`) is an in-process dict. Messaging is correct **only** with `--workers 1` (which the Dockerfile correctly pins). You cannot add workers or scale to multiple machines without a shared broker (e.g. Redis pub/sub). Also: channels created *after* an admin's SSE stream opened aren't delivered until the client reconnects. Fine for one pool; a hard ceiling beyond that.
- **🟡 E2 — `extend_to_horizon` only runs at startup.** Slots are materialised 26 weeks out when the process boots. A container that runs for months will slowly empty its far horizon until the next restart/redeploy. *Fix:* a periodic task (or generate-on-read) to keep the window rolling.
- **🟢 E3 — N+1 queries** in `list_channels` and the pending-clash loop in `list_slots`. Negligible at this scale (a few channels, a few pending requests); revisit only if volumes grow.
- **🟢 E4 — Data volumes are tiny.** ~2,600 slots per 4-week window, single-digit concurrent users. SQLite + one worker is comfortably within budget.

---

## F. Testing & maintainability

- **🔴 F1 — No automated tests.** All verification is manual. Given the concurrency-sensitive booking logic, a small `pytest` suite would be the single highest-value addition: request/approve/release happy paths, the qualification + training-expiry rules, and — crucially — concurrent-claim and double-book tests (threads hitting the same slot). These would have caught C1/C2.
- **🟡 F2 — Broad `except Exception`.** Acceptable for the idempotent `ALTER TABLE` migrations; less so in role/level creation, where *any* exception is reported as "already exists" and can mask real errors.
- **🟢 F3 — Excellent in-repo documentation.** `CLAUDE.md`, `README.md`, and `DEPLOY.md` are unusually thorough and accurate, which materially lowers maintenance risk.

---

## G. Functionality inventory (what it actually does)

**Staff**
- Personal dashboard: this week's shifts as a compact 7-day grid, plus "this week" and "open to grab" counts, and a training-expiry banner.
- Browse shifts as a **week timetable** (coverage counts per slot, colour states: covered / part-cover / pending / open; "your shift" and "requested" outlines) or a **day view**; filter by role and by class/level.
- Tap an open slot to request it; release a shift you hold (with confirmation).
- Profile: edit contact details, record lifeguard training expiry, change password.
- Messaging: role channels, an "All Staff" channel, a direct line to admins; unread badges; real-time delivery.

**Admin (everything above, plus)**
- **Approvals** queue with one-tap approve/decline (reason optional, DM'd to the worker), "approve all", inline **clash warnings** that disable approval, and filters by person / role / class.
- **Rota builder**: pick a person, tick slots across the week grid, bulk-assign with a detailed **skip report** (already-taken / unqualified / clashing, with reasons); per-role tabs and an "All roles" view; tap an assigned cell to remove it.
- **Reports**: outstanding/unfilled shifts (with **CSV export**), daily **coverage %**, **training status** (valid / expiring / expired), and a category-filtered **activity log**.
- **Manage**: people (+ deactivated section), roles (colour, shortcode, "requires training" flag), classes/levels with default staffing.
- **Messaging admin**: create/edit/archive channels, auto-membership by linked role, system channels.
- **Settings**: configurable display timezone.

**Platform**
- Installable PWA, offline app-shell, branded to Freedom Leisure colours; in-app notifications; audit trail.

---

## H. Prioritised recommendations

**Must-fix before staff depend on it**
1. ✅ **C1** *(done)* — conditional `UPDATE … WHERE status=<expected>` + `rowcount` check on request/assign/approve/bulk-assign.
2. ✅ **C2** *(done)* — check-and-write wrapped in `BEGIN IMMEDIATE` so double-book/qualification checks are race-safe.
3. ✅ **C6** *(done)* — admins still on the default password are forced to change it on next login; the login screen's demo creds are now hidden unless a `demo_logins` flag is set (off in production).

**Should-fix soon**
4. ✅ **C4** *(done)* — login rate-limiting (per-IP, 10 fails / 5 min → 429).
5. ✅ **D1** *(done)* — timezone-correct "today" on the server (`today_local()` + `tzdata`).
6. ✅ **D2** *(done)* — input validation → 400s on the endpoints that previously 500'd.
7. ✅ **F1** *(done)* — pytest suite added (`tests/`, 7 tests incl. the concurrency tests for #1/#2).

**Nice-to-have / future**
8. ✅ **E2** *(done)* rolling-horizon background job · ✅ **D4** *(done)* SW versions dropped from `SHELL` (CACHE name is now the single source of truth) · ✅ security headers added at Caddy (HSTS, CSP, nosniff, frame-deny) · ⬜ **C3** real FKs (deferred — retrofitting needs full-table rebuilds on live data; low benefit given soft-delete-dominant schema) · ⬜ **E1** Redis-backed SSE *if* you ever go multi-pool.

---

## I. Bottom line

This is a well-built, genuinely useful application that already does the job it was made for, and it's deployed. The gap between "impressive demo" and "staff can rely on it" is **narrow and specific**: close the two booking races (C1/C2) and tidy the admin-credential story (C6). Those are an afternoon's work. Everything else on the list is incremental hardening you can do at leisure — appropriate for a tool serving one pool, with a clear (and deliberately deferred) path to a bigger product if it ever needs one.

---

## J. Re-audit addendum — changes since first review

Two commits landed after the initial review, both **frontend-only**:

| Commit | Summary | Verdict |
|---|---|---|
| `7f88ce4` | **Clearer login errors** — `api()` now distinguishes a *login failure* ("Incorrect username or password") from a *session expiry*; only the latter calls `logout()`. | 🟢 Genuine bug fix. Previously every 401 — including a wrong password on the login screen — showed a misleading "session expired." Good catch. |
| `acd1c07` | **Pending-requester names** — the week timetable now surfaces *who* has already requested a not-yet-approved slot (`showWeekPendingSheet`, plus the names sheet mentions pending requesters of remaining slots). | 🟢 Nice UX. Uses `assigned_name` already returned by `SLOT_SELECT`; no backend change. |

**One interaction worth flagging:** feature `acd1c07` makes the **C1 race more visible**. The new "pending requester" panel shows whoever the *last write* recorded as the requester. Under the lost-update race in C1, if two staff request the same open slot simultaneously, the person who "lost" the write will see *someone else* named as the requester even though their own request returned success. So the feature is correct given the data — it just faithfully displays the symptom of the underlying race. **This is another reason to prioritise the C1 fix:** it now has a user-facing surface where the inconsistency can be noticed.

Re-verified unchanged and still applicable: **C1, C2** (`server.py:290/358/416/517`, unguarded `WHERE id=?`), **C4–C6**, **D1**, **D2** (`server.py:537/827/953/1235`), **E1/E2**, **F1** (still no tests). Corrected: **D3** (now confirmed fully implemented). Widened: **D4** (cache drift v33→v47).
