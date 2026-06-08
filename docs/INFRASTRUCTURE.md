# Arc Swim Rota — hosting & backup recommendations

For a real deployment at **The Arc** with **~60 staff**.

---

## 1. How much work is this, really?

Modelled on the app's own scheduling (pool open ~06:30–21:30, 6 lanes, after-school
weekday lessons + weekend mornings):

| Measure | Rough figure |
|---|---|
| **Lessons per lesson-day** | ~36 (6 half-hour slots × 6 lanes) |
| **Lifeguard person-shifts per day** | ~60 (30 half-hour slots × 2 guards) |
| **Teaching person-shifts per lesson-day** | ~45 |
| **Total person-shifts per day** | **~100** |
| **Per week** | ~690 |
| **Rows held (26-week horizon)** | ~18,000 → **~5 MB of SQLite** |

**Translation:** the data is tiny. SQLite handles this with room to spare. The only
thing that matters for sizing is **concurrency**, and even that is modest:

- 60 staff, but realistically **~15–30 online at once** in the burst when a new
  rota opens; a handful at any other time.
- Up to **~60 idle real-time (SSE) connections** if everyone keeps the app open —
  cheap to hold.
- The one CPU cost worth naming is **password hashing at login** (~75 ms each); 30
  simultaneous logins = a second or two of queueing on a single core.

---

## 2. Droplet recommendation

> **Recommended: Basic droplet — 1 vCPU / 2 GB RAM / 50 GB SSD (~$12/mo, London/LON1).**

- **2 GB RAM** is the real upgrade over the current $6 box: comfortable headroom for
  Docker + the app + Caddy + OS page cache, with no risk of an out-of-memory kill.
- **1 vCPU is enough** — the app runs a single worker (the in-memory messaging
  requires it), data volumes are small, and SQLite is single-writer anyway. If you
  want the login burst to feel snappier, a **2 vCPU / 2 GB ($18/mo)** is the only
  reason to go up; it is not necessary.
- The current **$6 (1 vCPU / 1 GB)** box *will* run it, but 1 GB leaves little
  margin once Docker, Caddy and a few months of logs are in play — fine for a pilot,
  worth the extra few pounds for live staff use.

**Don't over-buy.** Dedicated-CPU or 4 GB+ plans are wasted money for this workload.

### ⚠ Add a domain + HTTPS before go-live
The server is currently `SITE_ADDRESS=:80` (plain HTTP on the IP). That works, but
**a PWA can only be “installed” to a phone home screen over HTTPS.** Point a DNS
**A record** (e.g. `rota.thearc-matlock.co.uk`) at the droplet and set
`SITE_ADDRESS` to that domain — Caddy then fetches a free certificate automatically,
the security headers (incl. HSTS) start doing their job, and staff can install the
app properly.

---

## 3. Backup strategy

The whole product state is **one SQLite file** (`/data/swim_rota.db` in the
`swim-data` Docker volume) plus the **`.env`** (which holds `SWIM_SECRET` — lose it
and every staff member is logged out). Back up both. Use **two layers**:

### Layer A — DigitalOcean automated backups (the safety net)
Enable **Droplet → Backups** (+20% of the droplet cost, ~$2.40/mo). This snapshots
the entire VM weekly — one click, and it covers the “the droplet died” case. Coarse
(weekly), but zero-effort insurance.

### Layer B — nightly database backup, copied off the droplet (the precise one)
Don't just `cp` the live DB — a WAL database copied mid-write can be inconsistent.
Use SQLite's **`VACUUM INTO`**, which writes a clean, consistent snapshot even while
the app is running.

`/root/swim-rota/backup.sh` on the droplet:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /root/swim-rota
STAMP=$(date +%F)
mkdir -p backups

# Consistent snapshot via SQLite VACUUM INTO (safe with WAL, app can stay up)
docker compose exec -T app python -c \
  "import sqlite3,os; sqlite3.connect(os.environ['SWIM_DB']).execute('VACUUM INTO ?',('/data/_bk.db',))"
docker compose cp app:/data/_bk.db "backups/swim_rota-$STAMP.db"
docker compose exec -T app rm -f /data/_bk.db
cp .env "backups/env-$STAMP.bak"

# Off-site copy (object storage). Set up once: `rclone config` → a DO Spaces remote.
rclone copy "backups/swim_rota-$STAMP.db" spaces:arc-swim-backups/ || true
rclone copy "backups/env-$STAMP.bak"       spaces:arc-swim-backups/ || true

# Retention: keep 14 days locally
find backups -name 'swim_rota-*.db' -mtime +14 -delete
find backups -name 'env-*.bak'      -mtime +14 -delete
```

Schedule it (runs 02:17 daily — off the round hour):
```bash
chmod +x /root/swim-rota/backup.sh
( crontab -l 2>/dev/null; echo "17 2 * * * /root/swim-rota/backup.sh >> /var/log/swim-backup.log 2>&1" ) | crontab -
```

- **Off-site is the important part.** A backup that only lives on the same droplet
  dies with it. **DigitalOcean Spaces** (~$5/mo, S3-compatible, works with `rclone`)
  is the natural home; any S3 bucket or even a nightly `scp` to another machine works.
- **Recommended retention:** 14 daily + (optionally) keep one per month for a year on
  Spaces via a lifecycle rule.

### Restoring
```bash
cd /root/swim-rota
docker compose down
docker compose cp ./backups/swim_rota-YYYY-MM-DD.db app:/data/swim_rota.db   # with app stopped, copy into the volume
docker compose up -d
```
(If `SWIM_SECRET` was lost, restore `.env` from the matching `env-*.bak` first, or
everyone simply re-logs-in.)

> **Test a restore once.** A backup you've never restored is a hope, not a backup.

---

## TL;DR
- **Droplet:** 1 vCPU / **2 GB** / 50 GB SSD (~$12/mo), London. Add a **domain + HTTPS** so the PWA installs.
- **Backups:** DO weekly VM backups *plus* a nightly `VACUUM INTO` snapshot of the DB **and `.env`**, copied to Spaces, 14-day retention. Test a restore.
