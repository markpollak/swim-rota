#!/usr/bin/env bash
# Start the Arc Swim Rota app.
set -e
cd "$(dirname "$0")"
PY="../.venv/bin/python"
[ -x "$PY" ] || PY="python3"
"$PY" seed.py            # seeds only if the database is empty
exec "$PY" -m uvicorn server:app --host 0.0.0.0 --port 8080
