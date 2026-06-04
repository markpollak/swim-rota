# Arc Swim Rota 🏊

A mobile-first **Progressive Web App** for swim teachers and lifeguards at
**The Arc, Matlock** (Freedom Leisure) to allocate themselves to half-hour
poolside shifts, with administrator approval.

Built with FastAPI + SQLite + vanilla JS. No build step, minimal dependencies.

![icon](static/icon-192.png)

## Features

- **Staff logins** with personal dashboard — upcoming shifts at a glance.
- **Calendar (week) view** and **list view** of shifts; tap an open slot to
  request it. Different evenings run different classes across the 6 lanes.
- **Admin approval** of every request, plus direct assignment, decline (with
  reason), and ad-hoc shifts.
- **Roles** (Teacher, Lifeguard, Assistant Teacher…) — extensible; add poolside
  roles as the team grows. Roles can be flagged as *requiring in-date training*.
- **Swimming levels** Parents & Toddlers + Level 1–10 (extensible), each with
  **configurable default staffing** (e.g. Parents & Toddlers = 1 Teacher +
  1 Assistant; everything else 1 Teacher).
- **Constant lifeguard cover** — a lifeguard shift is generated for every
  half-hour the pool is open.
- **Training expiry tracking** — lifeguards record their qualification expiry;
  the system **blocks approval/assignment of lifeguard shifts when expired or
  missing**. Teachers are unaffected.
- **Reports** — outstanding (unfilled) shifts with CSV export, daily coverage %,
  and a training-status report.
- **In-app notifications**, double-booking prevention, shift release.
- **PWA**: installable to a phone home screen, works offline (app shell cached),
  branded with Freedom Leisure's colours (deep blue `#26358B`, magenta `#A4358B`).

## Run locally

```bash
cd swim-rota
python3 -m venv .venv && source .venv/bin/activate   # or reuse an existing venv
pip install -r requirements.txt
python seed.py          # seeds demo data (only if empty)
uvicorn server:app --port 8080
# open http://localhost:8080
```

### Demo logins
| Username | Password | Who |
|----------|----------|-----|
| `admin` | `admin123` | Sarah Hughes — administrator |
| `emma` | `password` | Teacher + Lifeguard (**training expiring soon**) |
| `sophie` | `password` | Teacher + Lifeguard (**training expired**) |
| `james`, `daniel`, `grace` | `password` | Lifeguards (valid) |
| `olivia`, `chloe`, `liam`, `noah` | `password` | Teachers / Assistant |

## Deploy
See **[DEPLOY.md](DEPLOY.md)** — one-command deploy to a DigitalOcean droplet
with automatic HTTPS via Caddy.

## Project layout
```
server.py        FastAPI app: API routes + serves the PWA
db.py            SQLite schema + connection helpers
auth.py          stdlib password hashing (PBKDF2) + signed tokens
scheduling.py    weekly-template → bookable-slot generation
seed.py          realistic dummy data (staff, schedule, requests)
static/          index.html, app.js, styles.css, manifest, sw.js, icons
Dockerfile, docker-compose.yml, Caddyfile, deploy.sh   deployment
```

## Notes / future ideas
- Add students & class registers (intentionally left out for now).
- Editable weekly templates in the UI (currently seeded; ad-hoc shifts can be
  added from the calendar). Generation endpoint already exists.
- Email/push reminders for upcoming shifts and expiring training.
- Shift-swap requests between staff.
