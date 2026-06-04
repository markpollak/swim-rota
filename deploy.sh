#!/usr/bin/env bash
# One-shot deploy/update for the Arc Swim Rota on a fresh Ubuntu droplet.
# Run this ON the droplet, from the project directory, as root (or with sudo).
#
#   git clone <repo> swim-rota && cd swim-rota
#   cp .env.example .env && nano .env      # set SITE_ADDRESS + SWIM_SECRET
#   ./deploy.sh
#
# Re-run any time to pull changes and restart.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "❌ No .env file. Run:  cp .env.example .env  and edit it first."
  exit 1
fi

# Install Docker + compose plugin if missing
if ! command -v docker >/dev/null 2>&1; then
  echo "📦 Installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi

echo "🚀 Building and starting…"
docker compose up -d --build
echo "🧹 Pruning old images…"
docker image prune -f >/dev/null 2>&1 || true

echo
echo "✅ Done. Containers:"
docker compose ps
echo
echo "Logs:    docker compose logs -f"
echo "Restart: docker compose restart"
echo "Update:  git pull && ./deploy.sh"
