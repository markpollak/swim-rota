FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    SWIM_DB=/data/swim_rota.db

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# /data holds the SQLite database + auth secret (mounted as a volume so it persists)
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080

# Seed on first boot (only if empty), then serve.
CMD ["sh", "-c", "python seed.py && exec uvicorn server:app --host 0.0.0.0 --port 8080 --workers 1"]
