# Job Hunter AI — Production Deployment Guide

## Prerequisites

- Docker Engine 24+ and Docker Compose v2
- 8 GB RAM minimum (16 GB recommended)
- Ports 80 and 443 open
- Domain DNS pointing to server

---

## PHASE 1 — First-Time Setup

### 1. Generate all secrets

```bash
chmod +x infrastructure/scripts/generate-secrets.sh
./infrastructure/scripts/generate-secrets.sh
```

This creates the `secrets/` directory with all required secret files:
`db_url`, `redis_url`, `jwt_secret`, `jwt_refresh_secret`, `cookie_secret`,
`anthropic_api_key`, `gmail_client_secret`, `whatsapp_access_token`,
`whatsapp_app_secret`, `whatsapp_verify_token`, `encryption_key`,
`aws_secret_access_key`, `postgres_password`, `redis_password`, `grafana_password`

**Fill in real values** for external services:
```bash
echo "sk-ant-xxxx" > secrets/anthropic_api_key
echo "your-gmail-client-secret" > secrets/gmail_client_secret
echo "your-wa-token" > secrets/whatsapp_access_token
# etc.
```

### 2. Configure environment variables

```bash
cp .env.example .env
# Edit .env:
#   NEXT_PUBLIC_API_URL=https://api.yourdomain.com
#   CORS_ORIGINS=https://yourdomain.com
#   WHATSAPP_PHONE_NUMBER_ID=your-phone-id
#   GMAIL_CLIENT_ID=your-oauth-client-id
#   AWS_S3_BUCKET=your-bucket
#   AWS_REGION=us-east-1
#   AWS_ACCESS_KEY_ID=your-key
#   STRIPE_PUBLISHABLE_KEY=pk_live_xxx
```

### 3. SSL certificates

Place TLS certificate files in `infrastructure/nginx/ssl/`:
- `fullchain.pem` — full certificate chain
- `privkey.pem` — private key

For Let's Encrypt (recommended):
```bash
certbot certonly --standalone -d yourdomain.com -d api.yourdomain.com
cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem infrastructure/nginx/ssl/
cp /etc/letsencrypt/live/yourdomain.com/privkey.pem infrastructure/nginx/ssl/
```

---

## PHASE 2 — Build & Deploy

### 4. Build all images

```bash
docker compose -f docker-compose.prod.yml build --parallel
```

Expected build time: 5–12 minutes (Playwright image is ~1.4 GB).

### 5. Start core services

```bash
docker compose -f docker-compose.prod.yml up -d
```

The `migrate` service runs `prisma migrate deploy` automatically before
the API and workers start (enforced via `service_completed_successfully`).

### 6. Start with monitoring

```bash
docker compose -f docker-compose.prod.yml --profile monitoring up -d
```

---

## PHASE 3 — Verify

### 7. Check all services are healthy

```bash
docker compose -f docker-compose.prod.yml ps
```

Expected output — all services show `healthy` or `running`:

| Service | Status |
|---------|--------|
| jh-nginx | running |
| jh-api | healthy |
| jh-web | healthy |
| jh-migrate | exited (0) ← expected |
| jh-worker-scraper | running |
| jh-worker-ai | running |
| jh-worker-bot | running |
| jh-worker-email | running |
| jh-worker-notification | running |
| jh-worker-resume | running |
| jh-worker-prep | running |
| jh-postgres | healthy |
| jh-pgbouncer | running |
| jh-redis | healthy |

### 8. Test health endpoints

```bash
curl -f https://api.yourdomain.com/health
# → {"status":"ok","service":"job-hunter-api","timestamp":"..."}

curl -f http://localhost:3001/health   # internal
# → {"status":"ok"}
```

### 9. Verify queue connectivity

```bash
# Check Redis queues are initialized
docker exec jh-redis redis-cli -a $(cat secrets/redis_password) keys "jhq:*" | head -20

# Check all 8 queues exist
# Expected: jhq:job-discovery-queue, jhq:ai-match-queue, jhq:job-apply-queue,
#           jhq:email-monitor-queue, jhq:followup-queue, jhq:notification-queue,
#           jhq:resume-parse-queue, jhq:interview-prep-queue, jhq:resume-tailor-queue
```

### 10. Run database seed (first deploy only)

```bash
docker compose -f docker-compose.prod.yml exec api \
  node -e "require('./packages/database/dist/seeds/index.js')"
```

---

## PHASE 4 — Smoke Tests

### End-to-end flow test

```bash
# 1. Register user
curl -X POST https://api.yourdomain.com/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test1234!","name":"Test User"}'

# 2. Login
TOKEN=$(curl -s -X POST https://api.yourdomain.com/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test1234!"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['accessToken'])")

# 3. Trigger discovery
curl -X POST https://api.yourdomain.com/api/v1/discovery/trigger \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"platforms":["linkedin"]}'

# 4. Check worker logs
docker compose -f docker-compose.prod.yml logs worker-scraper --tail=20
```

---

## Common Operations

### View logs

```bash
# All services
docker compose -f docker-compose.prod.yml logs -f

# Specific service
docker compose -f docker-compose.prod.yml logs -f worker-bot

# Error logs only
docker compose -f docker-compose.prod.yml logs | grep '"level":50'
```

### Scale workers

```bash
# Increase AI match concurrency
docker compose -f docker-compose.prod.yml up -d --scale worker-ai=2
```

### Rolling restart

```bash
docker compose -f docker-compose.prod.yml up -d --no-deps api
```

### Migrate database

```bash
docker compose -f docker-compose.prod.yml run --rm migrate \
  sh -c "npx prisma migrate deploy --schema=./prisma/schema.prisma"
```

---

## Troubleshooting

### migrate service exits non-zero

```bash
docker compose -f docker-compose.prod.yml logs migrate
```

Common causes:
- `db_url` secret has wrong credentials → check `secrets/db_url`
- Postgres not yet ready → wait and retry, or increase `start_period`

### Worker jobs not being consumed

```bash
# Check Redis keys for orphaned queues
docker exec jh-redis redis-cli -a $(cat secrets/redis_password) \
  keys "jhq:*" | grep -v "Bull"

# Verify queue name matches between producer and consumer
# All queues use format: jhq:{queue-name}
# e.g.: jhq:ai-match-queue (NOT jhq:ai-match)
```

### Bot worker crashing

```bash
docker compose -f docker-compose.prod.yml logs worker-bot | grep error
```

Common causes:
- `/tmp` not writable inside container → check `tmpfs` mounts in compose
- Chrome sandbox error → verify `cap_add: [SYS_ADMIN]` and `shm_size: 512m`
- Proxy misconfiguration → check `PROXY_POOL` env var format

### API 500 on startup

```bash
docker compose -f docker-compose.prod.yml logs api | head -50
```

Common causes:
- Secret file missing → run `generate-secrets.sh` again
- Database not migrated → check `migrate` service completed successfully
- Redis not reachable → verify `data` network includes both api and redis

### Prometheus showing no data

```bash
curl http://localhost:3001/metrics | head -20
curl http://localhost:9100/metrics | head -20  # worker metrics
```

If `/metrics` returns 404: API `metricsHandler` not wired → check `app.ts`.
If worker metrics 404: `initWorkerMetrics()` not called → check worker `index.ts`.

### Grafana shows "No datasource found"

```bash
docker compose -f docker-compose.prod.yml logs grafana | grep provision
```

Provisioning files must be at `infrastructure/monitoring/provisioning/`.
Grafana must have `GF_PATHS_PROVISIONING` env set.

---

## Startup Checklist

- [ ] `secrets/` directory populated with all 15 secret files
- [ ] Real API keys filled in (Anthropic, Gmail, WhatsApp, Stripe, AWS)
- [ ] SSL certificates in `infrastructure/nginx/ssl/`
- [ ] `.env` file configured with domain names and public keys
- [ ] `docker compose build` completes without errors
- [ ] `docker compose up -d` brings all services to healthy
- [ ] `jh-migrate` container shows `exited (0)`
- [ ] `/health` endpoint returns `{"status":"ok"}`
- [ ] Redis has 9 queue keys after API starts
- [ ] Test registration and login flow succeeds
- [ ] Grafana accessible at `https://monitor.yourdomain.com` (with monitoring profile)
