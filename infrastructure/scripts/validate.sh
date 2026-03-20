#!/usr/bin/env bash
# ============================================================
# Job Hunter AI — Pre-Deploy Validation Script
# Checks all secrets, config, and connectivity before launch.
# Run: ./infrastructure/scripts/validate.sh
# ============================================================
set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0; WARN=0

ok()   { echo -e "  ${GREEN}✓${NC} $1"; ((PASS++)); }
fail() { echo -e "  ${RED}✗${NC} $1"; ((FAIL++)); }
warn() { echo -e "  ${YELLOW}!${NC} $1"; ((WARN++)); }

echo ""
echo "════════════════════════════════════════════"
echo "  Job Hunter AI — Deployment Validation"
echo "════════════════════════════════════════════"

# ── 1. Secrets ────────────────────────────────────────────────
echo ""
echo "► Checking secrets…"
REQUIRED_SECRETS=(
  db_url redis_url jwt_secret jwt_refresh_secret cookie_secret
  anthropic_api_key gmail_client_secret whatsapp_access_token
  whatsapp_app_secret whatsapp_verify_token encryption_key
  aws_secret_access_key postgres_password redis_password grafana_password
)
for s in "${REQUIRED_SECRETS[@]}"; do
  f="secrets/$s"
  if [ -f "$f" ] && [ -s "$f" ]; then
    val=$(cat "$f")
    if [[ "$val" == *"your-"* ]] || [[ "$val" == *"changeme"* ]] || [[ "$val" == *"PLACEHOLDER"* ]]; then
      warn "$s — contains placeholder value, fill with real secret"
    else
      ok "$s"
    fi
  else
    fail "$s — missing or empty (run generate-secrets.sh)"
  fi
done

# ── 2. SSL Certificates ───────────────────────────────────────
echo ""
echo "► Checking TLS certificates…"
if [ -f "infrastructure/nginx/ssl/fullchain.pem" ]; then
  EXPIRY=$(openssl x509 -enddate -noout -in infrastructure/nginx/ssl/fullchain.pem 2>/dev/null | cut -d= -f2 || echo "unknown")
  ok "fullchain.pem found (expires: $EXPIRY)"
else
  fail "infrastructure/nginx/ssl/fullchain.pem not found"
fi
if [ -f "infrastructure/nginx/ssl/privkey.pem" ]; then
  ok "privkey.pem found"
else
  fail "infrastructure/nginx/ssl/privkey.pem not found"
fi

# ── 3. Docker ─────────────────────────────────────────────────
echo ""
echo "► Checking Docker…"
if command -v docker &>/dev/null; then
  DOCKER_VER=$(docker --version | grep -oP '\d+\.\d+')
  ok "Docker $DOCKER_VER"
else
  fail "Docker not installed"
fi

if docker compose version &>/dev/null 2>&1; then
  ok "Docker Compose v2"
else
  fail "Docker Compose v2 not available (need: docker compose, not docker-compose)"
fi

# ── 4. docker-compose.prod.yml validity ───────────────────────
echo ""
echo "► Validating docker-compose.prod.yml…"
if docker compose -f docker-compose.prod.yml config --quiet 2>/dev/null; then
  ok "docker-compose.prod.yml is valid YAML"
else
  fail "docker-compose.prod.yml has syntax errors"
fi

SERVICE_COUNT=$(docker compose -f docker-compose.prod.yml config --services 2>/dev/null | wc -l | tr -d ' ')
ok "$SERVICE_COUNT services defined"

# ── 5. Environment ────────────────────────────────────────────
echo ""
echo "► Checking .env…"
if [ -f ".env" ]; then
  ok ".env file exists"
  for var in NEXT_PUBLIC_API_URL CORS_ORIGINS WHATSAPP_PHONE_NUMBER_ID GMAIL_CLIENT_ID; do
    if grep -q "^${var}=" .env 2>/dev/null && [ -n "$(grep "^${var}=" .env | cut -d= -f2)" ]; then
      ok "$var set"
    else
      warn "$var not set in .env"
    fi
  done
else
  warn ".env not found — copy from .env.example and fill values"
fi

# ── 6. Port availability ──────────────────────────────────────
echo ""
echo "► Checking ports…"
for port in 80 443; do
  if ss -tlnp 2>/dev/null | grep -q ":$port " || netstat -tlnp 2>/dev/null | grep -q ":$port "; then
    warn "Port $port already in use — nginx may fail to bind"
  else
    ok "Port $port available"
  fi
done

# ── 7. Disk space ─────────────────────────────────────────────
echo ""
echo "► Checking disk space…"
AVAIL_GB=$(df -BG . | awk 'NR==2{gsub("G","",$4); print $4}')
if [ "${AVAIL_GB:-0}" -ge 20 ]; then
  ok "${AVAIL_GB}GB available (need 20GB for images + data)"
elif [ "${AVAIL_GB:-0}" -ge 10 ]; then
  warn "${AVAIL_GB}GB available — tight, recommend 20GB+"
else
  fail "${AVAIL_GB}GB available — insufficient (need 20GB minimum)"
fi

# ── Summary ───────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════"
echo -e "  ${GREEN}Passed: $PASS${NC}  ${RED}Failed: $FAIL${NC}  ${YELLOW}Warnings: $WARN${NC}"
echo "════════════════════════════════════════════"
echo ""
if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}✗ Validation FAILED — fix the errors above before deploying${NC}"
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo -e "${YELLOW}! Validation PASSED with warnings — review before production${NC}"
  exit 0
else
  echo -e "${GREEN}✓ Validation PASSED — ready to deploy${NC}"
  echo ""
  echo "Run: docker compose -f docker-compose.prod.yml build --parallel"
  echo "Then: docker compose -f docker-compose.prod.yml up -d"
  exit 0
fi
