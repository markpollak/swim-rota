# Arc Swim Rota — Claude Session Guide

## What this is
A mobile-first PWA for swim teachers and lifeguards at The Arc, Matlock (Freedom Leisure) to self-allocate to poolside shifts. Admins approve requests and manage the rota.

## Stack
- **Backend:** FastAPI + SQLite (`swim_rota.db`), stdlib auth (PBKDF2 + HMAC tokens)
- **Frontend:** Vanilla JS PWA (`static/`) — no build step, no bundler
- **Reverse proxy (production):** Caddy (auto-HTTPS via Let's Encrypt)
- **Containers:** Docker + docker-compose

---

## Running locally

```bash
# Server (port 8080)
/Library/Frameworks/Python.framework/Versions/3.11/bin/python3 -m uvicorn server:app \
  --host 127.0.0.1 --port 8080 --reload

# Force-reseed local DB (wipes and rebuilds demo data)
/Library/Frameworks/Python.framework/Versions/3.11/bin/python3 seed.py --force
```

Dashboard: http://localhost:8080  
Demo logins: `admin` / `admin123` — staff: any of `emma|james|olivia|liam|sophie|noah|grace|daniel|chloe` / `password`

> **Preview tip:** When testing admin views in the Claude preview browser, log in fresh from the login screen as `admin`/`admin123`. Don't try to swap tokens mid-session — it doesn't work reliably.

---

## Live server (DigitalOcean droplet)

**IP:** `165.232.96.67`  
**SSH:** `ssh root@165.232.96.67`  
**GitHub repo:** `https://github.com/markpollak/swim-rota.git`

### Deploy (after pushing to GitHub)

```bash
ssh root@165.232.96.67 "cd swim-rota && git pull && docker compose build app && docker compose up -d"
```

### Force-reseed live DB (wipes all data and rebuilds fresh demo data)

```bash
ssh root@165.232.96.67 "cd swim-rota && docker compose build app && docker compose run --rm app python seed.py --force && docker compose restart app"
```

> `seed.py --force` fails if the Docker image is stale — always rebuild (`docker compose build app`) before running it.

### Useful live server commands

```bash
# View logs
ssh root@165.232.96.67 "cd swim-rota && docker compose logs app --tail=40"

# Just restart (no reseed)
ssh root@165.232.96.67 "cd swim-rota && docker compose restart app"

# Check containers
ssh root@165.232.96.67 "cd swim-rota && docker compose ps"
```

---

## Standard deploy workflow

1. Make changes locally and test at http://localhost:8080
2. **Bump the service worker cache version** (see below — MUST do this for every static file change)
3. Commit and push:
   ```bash
   git add <files> && git commit -m "..." && git push origin master
   ```
4. Deploy to droplet:
   ```bash
   ssh root@165.232.96.67 "cd swim-rota && git pull && docker compose build app && docker compose up -d"
   ```

---

## ⚠ Service worker cache — MUST bump on every static change

The PWA caches `app.js` and `styles.css` aggressively. After editing any static file, bump the version in **three places** or changes won't load for existing users:

| File | What to change |
|------|---------------|
| `static/sw.js` | `const CACHE = "arc-swim-vN"` → increment N |
| `static/sw.js` | `?v=N` on both SHELL entries |
| `static/index.html` | `?v=N` on both `<link>` and `<script>` tags |

Current version: **v21** — increment to v22 on next static change.

---

## Architecture overview

```
static/app.js       — entire front end (~2200 lines, vanilla JS SPA)
static/styles.css   — all CSS (~500 lines)
static/sw.js        — service worker (cache-first shell, network-first API)
server.py           — FastAPI app, all API routes
db.py               — SQLite schema + init_db() with migrations
scheduling.py       — slot generation from templates + class schedules
seed.py             — demo data seeder (run with --force to wipe+reseed)
auth.py             — token helpers
```

### Key data model
- **roles** — Teacher, Lifeguard, Assistant Teacher (each has `name`, `color`, `shortcode`, `requires_training`)
- **levels** — Level 1–10, Parents & Toddlers
- **templates** — recurring weekly shift patterns → slots are materialised from these
- **slots** — one bookable person-shift: `status` = open | requested | approved
- **users / user_roles** — staff, their qualified roles, training expiry

### Auth
Token format: `{user_id}.{timestamp}.{hmac}` stored in `localStorage`. Passed as `Authorization: Bearer <token>` or `?token=` query param (WebSocket).

---

## API conventions
- All routes under `/api/`
- Admin-only routes use `admin=Depends(require_admin)`
- Slots query: `GET /api/slots?mine=1&from=YYYY-MM-DD&to=YYYY-MM-DD&pending=1`
- Bulk assign (rota builder): `POST /api/slots/bulk-assign` → returns `assigned`, `skipped`, `skipped_details`
- Release shift: `POST /api/slots/{id}/release` — body `{ reason: "..." }` — admin release sends DM to worker

---

## Frontend conventions
- Single `State` object tracks all view state (current tab, week starts, filters)
- `go(view)` switches views; `renderView()` dispatches to view functions
- `api(url, opts)` — fetch wrapper, auto-attaches token, throws on error
- `openSheet(html)` / `closeSheet()` — bottom sheet modal
- `toast(msg, type)` — brief notification ("ok" = green, "err" = red)
- `esc(str)` — HTML escape helper — always use for user-supplied strings

### Week grid (My Shifts / Home)
`weekGridHTML(slots, weekStart)` → 7-column grid, shared between home page and My Shifts view.  
`shiftBadge(slot)` → 🛟 for lifeguard duty, level code (L1, P&T) for classes.  
Shift rows: green = approved, amber = pending, red = lifeguard duty.

### Admin tabs
- Main tabs: **Approvals | Reports | Manage | Rota**
- Manage sub-tabs: People | Roles | Classes
- Rota sub-tabs: Rota (builder) | Day View
- State tracked in `State.adminTab`, `State.manageTab`, `State.rotaSubTab`

---

## Common gotchas

- **Double-booking:** `check_double_book()` is called on request, assign, approve, and bulk-assign. The seed also prevents overlaps.
- **Wipe on --force:** `seed.py wipe()` clears all tables including channels/messages. If you add new tables to the schema, add them to `wipe()` too.
- **`approve_slot` re-checks:** calls both `check_qualified` and `check_double_book` — approval can fail if the worker acquired a conflicting shift since requesting.
- **Pending clash banner:** `GET /api/slots?pending=1` returns a `clash` field for any request that conflicts with an already-approved shift — shown inline in Approvals with the approve button disabled.
- **Bulk-assign skip details:** `POST /api/slots/bulk-assign` returns `skipped_details[]` with `date`, `start_time`, `level_name`, `role_name`, `reason` — rendered as a red panel in the rota builder.
- **Role shortcodes:** stored in `roles.shortcode` (1–2 chars). Shown as coloured badges on rota tabs and inside All-view cells. Set via Manage → Roles edit sheet.
- **DMs:** use `_fanout(channel_id, payload)` to push real-time to connected clients after inserting into `messages`. See `reject_slot` or `release_slot` for the pattern.
