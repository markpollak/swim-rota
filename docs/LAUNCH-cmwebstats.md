# Launching Staff Pool Rota at cmwebstats.com

The app already runs on the DigitalOcean droplet **`165.232.96.67`** (Docker:
`app` + `caddy`). This guide points **cmwebstats.com** (DNS managed at Cloudflare)
at it, with HTTPS.

There are two ways to do the Cloudflare side:

- **Path A — Recommended.** Cloudflare just does DNS; Caddy gets a free,
  auto-renewing Let's Encrypt certificate. Fewest moving parts. Start here.
- **Path B — Optional hardening.** Put Cloudflare's proxy (CDN / DDoS / hidden
  origin IP) in front. More steps; do it later if you want it.

You can be live on Path A in ~10 minutes and switch to Path B any time.

---

## Pre-flight (do once)

1. **Check what's at cmwebstats.com today.** Pointing the apex (`@`) record at the
   droplet makes the website serve the rota. **Email (MX) and other records are
   untouched** — only web traffic moves. If something important is already hosted
   on the bare domain, use a subdomain instead (e.g. `rota.cmwebstats.com`) — every
   step below works identically, just substitute that hostname.

2. **Open the droplet firewall for HTTPS.** Caddy needs ports **80 and 443**:
   ```bash
   ssh root@165.232.96.67
   ufw status                      # if "inactive", nothing to do
   ufw allow 80,443/tcp            # only if ufw is active
   ```
   If you attached a **DigitalOcean Cloud Firewall**, also allow inbound TCP 80 + 443
   there (Networking → Firewalls).

---

## Path A — Recommended: Cloudflare DNS-only + automatic HTTPS

### A1. Add the DNS record (Cloudflare dashboard)
Cloudflare → select **cmwebstats.com** → **DNS → Records**:

- **Delete** any existing `A`/`AAAA`/`CNAME` record on name **`@`** that points
  somewhere else (old host).
- **Add record:** Type **A**, Name **`@`**, IPv4 **`165.232.96.67`**,
  **Proxy status: DNS only (grey cloud ☁️)**, TTL Auto. **Save.**
- *(Optional `www`)* Add record: Type **CNAME**, Name **`www`**,
  Target **`cmwebstats.com`**, **DNS only**. Save.

> **Why grey cloud:** it lets Let's Encrypt reach the droplet directly so Caddy can
> prove it owns the domain and issue a real certificate. (Orange cloud breaks that
> unless you do Path B.)

### A2. Point the app at the domain and redeploy (on the droplet)
```bash
ssh root@165.232.96.67
cd swim-rota
git pull
# set the domain in .env (creates the line if missing):
grep -q '^SITE_ADDRESS=' .env \
  && sed -i 's#^SITE_ADDRESS=.*#SITE_ADDRESS=cmwebstats.com#' .env \
  || echo 'SITE_ADDRESS=cmwebstats.com' >> .env
grep SITE_ADDRESS .env            # confirm it reads: SITE_ADDRESS=cmwebstats.com
docker compose up -d              # restart Caddy on the new address
docker compose logs -f caddy      # watch for: "certificate obtained successfully"  (Ctrl-C to stop)
```

### A3. Verify
- Wait ~1–2 min for DNS to propagate and the cert to issue, then open
  **https://cmwebstats.com**.
- From your Mac: `curl -I https://cmwebstats.com` → `HTTP/2 200`, valid cert.
- Log in as `admin` and **change the admin password immediately**
  (Profile → password).

✅ You're live with HTTPS, and the PWA is installable on phones. Day-to-day
redeploys are unchanged:
`ssh root@165.232.96.67 "cd swim-rota && git pull && docker compose build app && docker compose up -d"`.

---

## Path B — Optional: put Cloudflare's proxy in front

Only if you want Cloudflare's edge (CDN, DDoS protection, hidden origin IP). It needs
an **Origin Certificate** (so the Cloudflare→droplet hop stays encrypted) and a
**cache-bypass rule** (so staff don't get a stale app after a deploy).

### B1. SSL mode → Full (strict)
Cloudflare → **SSL/TLS → Overview → Full (strict)**.
⚠️ Do **not** use *Flexible* — it causes an infinite redirect loop with this app.

### B2. Create an Origin Certificate
Cloudflare → **SSL/TLS → Origin Server → Create Certificate** → keep defaults
(hostnames `cmwebstats.com, *.cmwebstats.com`, RSA, 15 years) → **Create**.
Copy **both** PEM blocks now — *Origin Certificate* and *Private Key*
(the key is shown only once).

### B3. Install the cert + switch Caddy (on the droplet)
```bash
ssh root@165.232.96.67
cd swim-rota
git pull
mkdir -p certs
nano certs/cmwebstats.pem      # paste the Origin Certificate block, save
nano certs/cmwebstats.key      # paste the Private Key block, save
chmod 600 certs/cmwebstats.key
# switch Caddy to the origin-cert config (creates the line if missing):
grep -q '^CADDY_CONFIG=' .env \
  && sed -i 's#^CADDY_CONFIG=.*#CADDY_CONFIG=./Caddyfile.cloudflare#' .env \
  || echo 'CADDY_CONFIG=./Caddyfile.cloudflare' >> .env
docker compose up -d
docker compose logs -f caddy   # should start clean, no ACME/cert errors
```
`certs/` is gitignored — the private key never goes near GitHub.

### B4. Turn on the orange cloud + stop stale caching
- Cloudflare → **DNS** → edit the **`@`** record → **Proxy status: Proxied (orange 🟠)**.
  Same for `www` if you added it.
- Cloudflare → **Rules → Caching rules → Create rule:**
  *When* hostname **equals** `cmwebstats.com` → *Then* **Bypass cache**. Deploy.
  (The app is tiny and already self-caches via its service worker; bypassing
  Cloudflare's cache prevents staff being served a stale `app.js` after a deploy.)
- Cloudflare → **SSL/TLS → Edge Certificates → Always Use HTTPS: On**.

### B5. Verify
- **https://cmwebstats.com** loads.
- `curl -sI https://cmwebstats.com | grep -i server` → shows `cloudflare`.
- The origin IP no longer resolves publicly (DNS now returns Cloudflare IPs).

> **Revert to direct (Path A):** set the `@` DNS record back to **DNS only**, then on
> the droplet comment out `CADDY_CONFIG` in `.env` and run `docker compose up -d`.

The day-to-day deploy command is the **same in both modes** (the mode lives in
`.env`), so nothing else changes.

---

## After launch
- **Change the `admin` password**, and any seeded demo accounts you keep, before real
  staff use it.
- **Backups** — set up the nightly DB snapshot + off-site copy from
  [INFRASTRUCTURE.md](INFRASTRUCTURE.md) before real data goes in. A backup you've
  never restored is a hope, not a backup.
- **Don't regenerate `SWIM_SECRET`** in `.env` — if it changes, every staff member is
  logged out.
</content>
