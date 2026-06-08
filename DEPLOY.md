# Deploying Staff Pool Rota

> **Launching at cmwebstats.com (Cloudflare)?** Follow the dedicated, step-by-step
> guide in **[docs/LAUNCH-cmwebstats.md](docs/LAUNCH-cmwebstats.md)** instead — it
> covers the Cloudflare DNS + TLS specifics. This file is the general reference.

The app is a single FastAPI service + SQLite, fronted by **Caddy** (which gets you
free automatic HTTPS). Everything runs in Docker, so a deploy is one command.

> **Why HTTPS matters:** a PWA can only be "installed" to a phone's home screen
> over HTTPS. Caddy handles certificates automatically if you give it a domain.

---

## Recommended: DigitalOcean Droplet (cheapest, full control)

A **$6/month basic droplet** (1 vCPU / 1 GB RAM) is plenty for a pool of this size.

### 1. Create the droplet
- DigitalOcean → **Create → Droplets**
- Image: **Ubuntu 24.04 LTS**
- Plan: **Basic → Regular → $6/mo**
- Region: **London (LON1)**
- Authentication: **SSH key** (add the key from `~/.ssh/id_ed25519.pub`)
- Hostname: `swim-rota`
- Create, then note the **public IP**.

### 2. Point a domain at it (recommended)
Add a DNS **A record** for e.g. `cmwebstats.com` → the droplet IP.
(Skip this only for quick testing — see the IP-only note below.)

### 3. Get the code onto the droplet
SSH in: `ssh root@YOUR_DROPLET_IP`, then either:

**Option A — from a Git repo** (push this folder to GitHub first):
```bash
git clone https://github.com/<you>/swim-rota.git
cd swim-rota
```

**Option B — copy straight from your Mac** (run on your Mac, not the droplet):
```bash
rsync -av --exclude .venv --exclude '*.db*' --exclude .secret \
  ~/swim-rota/ root@YOUR_DROPLET_IP:/root/swim-rota/
```

### 4. Configure + launch
On the droplet:
```bash
cd swim-rota
cp .env.example .env
nano .env          # set SITE_ADDRESS=cmwebstats.com
                   # set SWIM_SECRET to the output of:  openssl rand -base64 48
./deploy.sh
```
`deploy.sh` installs Docker if needed, builds the image, seeds the demo data on
first run, and starts the app behind Caddy. Within ~30s of DNS resolving,
`https://cmwebstats.com` is live with a valid certificate.

### 5. First login
- Admin: `admin` / `admin123` — **change this immediately** (Profile → password,
  and in Admin → People for any real accounts).

---

### IP-only quick test (no domain)
Set `SITE_ADDRESS=:80` in `.env`, run `./deploy.sh`, and browse to
`http://YOUR_DROPLET_IP`. Works for a look-around, but the PWA won't be
installable until you're on HTTPS with a domain.

---

## Day-to-day operations

| Task | Command (in `~/swim-rota` on the droplet) |
|------|-------------------------------------------|
| View logs | `docker compose logs -f` |
| Restart | `docker compose restart` |
| Update after code change | `git pull && ./deploy.sh` (or rsync again) |
| Stop | `docker compose down` |
| **Backup the database** | `docker compose cp app:/data/swim_rota.db ./backup-$(date +%F).db` |

The database lives in the `swim-data` Docker volume and survives restarts,
rebuilds, and updates. Take periodic backups with the command above (e.g. a
weekly cron job) and copy them off the droplet.

### Resetting / re-seeding
The demo data only seeds when the database is empty. To wipe and start fresh:
```bash
docker compose down
docker volume rm swim-rota_swim-data
docker compose up -d --build
```

---

## Alternatives

- **DigitalOcean App Platform** — push to GitHub, point App Platform at the repo;
  it auto-builds the Dockerfile and gives HTTPS with no server to manage
  (~$5/mo). Add a **persistent volume** mounted at `/data` so the SQLite DB
  survives deploys, and set `SWIM_SECRET` as an env var. Good if you'd rather not
  touch a server at all.
- **Render / Railway / Fly.io** — same Dockerfile works; attach a persistent disk
  at `/data`.

## Running without Docker (systemd)
If you prefer no Docker: install Python 3.11, `pip install -r requirements.txt`,
run `python seed.py`, then serve `uvicorn server:app --port 8080` under a systemd
unit, with nginx/Caddy in front for HTTPS. Docker is simpler and recommended.
