#!/bin/sh
# ============================================================
# redis-entrypoint.sh
#
# Reads the Redis password from the Docker secret file at
# /run/secrets/redis_password and passes it to redis-server
# via --requirepass.
#
# This avoids putting the password in environment variables
# or in the docker-compose command: block where it would be
# visible in `docker inspect` output.
# ============================================================
set -e

SECRET_FILE="/run/secrets/redis_password"

if [ ! -f "$SECRET_FILE" ]; then
  echo "[redis-entrypoint] ERROR: secret file not found: $SECRET_FILE" >&2
  exit 1
fi

REDIS_PASSWORD=$(cat "$SECRET_FILE")

if [ -z "$REDIS_PASSWORD" ]; then
  echo "[redis-entrypoint] ERROR: redis_password secret is empty" >&2
  exit 1
fi

echo "[redis-entrypoint] Starting Redis with password authentication"

exec redis-server \
  --requirepass        "$REDIS_PASSWORD" \
  --maxmemory          512mb \
  --maxmemory-policy   allkeys-lru \
  --save               900 1 \
  --save               300 10 \
  --save               60 10000 \
  --tcp-keepalive      300 \
  --loglevel           warning \
  --protected-mode     yes
