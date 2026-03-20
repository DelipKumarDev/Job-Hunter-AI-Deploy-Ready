#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
# generate-secrets.sh
# Job Hunter AI — Docker Secrets Generation Script
#
# Generates cryptographically strong secret values and writes
# them to files under ./secrets/ (which is .gitignored).
# These files are then mounted by docker-compose as Docker
# secrets into /run/secrets/ inside each container.
#
# Usage:
#   chmod +x infrastructure/scripts/generate-secrets.sh
#   ./infrastructure/scripts/generate-secrets.sh [--force]
#
# Options:
#   --force     Overwrite existing secret files (default: skip)
#   --swarm     Also create secrets in Docker Swarm via `docker secret create`
#   --show      Print a summary of generated files (NOT their values)
#
# After running this script:
#   1. Edit secrets/db_url and secrets/redis_url to include real hostnames
#   2. Fill secrets/gmail_client_secret from Google Cloud Console
#   3. Fill secrets/whatsapp_* from Meta Developer Portal
#   4. Fill secrets/aws_secret_access_key from AWS IAM
#   5. Run: docker compose -f docker-compose.prod.yml up -d
# ══════════════════════════════════════════════════════════════

set -euo pipefail
IFS=$'\n\t'

# ── Colours ───────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()    { echo -e "${GREEN}✓${RESET} $*"; }
warn()   { echo -e "${YELLOW}⚠${RESET} $*"; }
info()   { echo -e "${CYAN}→${RESET} $*"; }
error()  { echo -e "${RED}✗${RESET} $*" >&2; }
section(){ echo -e "\n${BOLD}$*${RESET}"; }

# ── Flags ────────────────────────────────────────────────────
FORCE=false
SWARM=false
SHOW=false
for arg in "$@"; do
  case $arg in
    --force) FORCE=true ;;
    --swarm) SWARM=true ;;
    --show)  SHOW=true  ;;
    *) error "Unknown argument: $arg"; exit 1 ;;
  esac
done

# ── Paths ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SECRETS_DIR="$REPO_ROOT/secrets"

# ── Prerequisite check ────────────────────────────────────────
if ! command -v openssl &>/dev/null; then
  error "openssl is required but not found in PATH"
  exit 1
fi

section "Job Hunter AI — Secrets Generation"
info "Secrets directory: $SECRETS_DIR"

# Create the secrets directory with restricted permissions
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

# ── Generator helpers ─────────────────────────────────────────

# Generate a URL-safe base64 string of the given byte length
gen_b64() {
  local bytes=${1:-32}
  openssl rand -base64 "$bytes" | tr -d '\n/+=' | cut -c1-$((bytes * 4 / 3))
}

# Generate a hex string of the given byte length
gen_hex() {
  local bytes=${1:-32}
  openssl rand -hex "$bytes"
}

# Write a secret file if it doesn't already exist (or --force)
write_secret() {
  local name="$1"
  local value="$2"
  local path="$SECRETS_DIR/$name"

  if [[ -f "$path" ]] && [[ "$FORCE" == "false" ]]; then
    warn "Skipping $name (already exists — use --force to overwrite)"
    return
  fi

  # Write with permissions 0400 (owner read-only)
  printf '%s' "$value" > "$path"
  chmod 400 "$path"
  log "Generated $name (${#value} chars)"
}

# Write a placeholder for secrets that must be filled in manually
write_placeholder() {
  local name="$1"
  local hint="$2"
  local path="$SECRETS_DIR/$name"

  if [[ -f "$path" ]] && [[ "$FORCE" == "false" ]]; then
    warn "Skipping $name (already exists)"
    return
  fi

  printf 'REPLACE_ME:%s' "$hint" > "$path"
  chmod 600 "$path"    # Writable so operator can edit it
  warn "Placeholder created for $name — fill in manually: $hint"
}

# ── Section 1: Auto-generated secrets ─────────────────────────
section "1/3  Auto-generated cryptographic secrets"

# JWT secrets — 64 random bytes → base64
JWT_SECRET=$(openssl rand -base64 64 | tr -d '\n')
write_secret "jwt_secret"         "$JWT_SECRET"

JWT_REFRESH=$(openssl rand -base64 64 | tr -d '\n')
write_secret "jwt_refresh_secret" "$JWT_REFRESH"

# Cookie signing key
COOKIE=$(openssl rand -base64 48 | tr -d '\n')
write_secret "cookie_secret"      "$COOKIE"

# Database password — alphanumeric only (no shell-special chars)
DB_PASS=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-32)
write_secret "postgres_password"  "$DB_PASS"

# Redis password
REDIS_PASS=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-32)
write_secret "redis_password"     "$REDIS_PASS"

# Encryption key — must be exactly 64 hex chars (32 raw bytes)
ENC_KEY=$(openssl rand -hex 32)
write_secret "encryption_key"     "$ENC_KEY"

# ── Section 2: URL secrets (include generated passwords) ──────
section "2/3  Connection URL secrets"

DB_HOST="${POSTGRES_HOST:-postgres}"
DB_PORT="${POSTGRES_PORT:-5432}"
DB_NAME="${POSTGRES_DB:-jobhunter}"
DB_USER="${POSTGRES_USER:-jhuser}"
DB_URL="postgresql://${DB_USER}:${DB_PASS}@pgbouncer:${DB_PORT}/${DB_NAME}"
write_secret "db_url" "$DB_URL"

REDIS_URL_VAL="redis://:${REDIS_PASS}@redis:6379"
write_secret "redis_url" "$REDIS_URL_VAL"

# ── Section 3: Manual secrets (placeholders) ─────────────────
section "3/3  External API secrets — fill these in manually"

write_placeholder "anthropic_api_key"      "your Anthropic key from console.anthropic.com"
write_placeholder "gmail_client_secret"    "OAuth2 client_secret from Google Cloud Console"
write_placeholder "whatsapp_access_token"  "System user token from Meta Business Manager"
write_placeholder "whatsapp_app_secret"    "App Secret from Meta Developer Portal"
write_placeholder "whatsapp_verify_token"  "webhook verify token (any random string)"
write_placeholder "aws_secret_access_key"  "IAM user secret key from AWS console"

# ── Summary ───────────────────────────────────────────────────
section "Summary"

TOTAL=$(find "$SECRETS_DIR" -maxdepth 1 -type f | wc -l | tr -d ' ')
PLACEHOLDERS=$(grep -l '^REPLACE_ME' "$SECRETS_DIR"/* 2>/dev/null | wc -l | tr -d ' ')
READY=$(( TOTAL - PLACEHOLDERS ))

echo ""
echo -e "  ${GREEN}$READY${RESET} secrets auto-generated and ready"
echo -e "  ${YELLOW}$PLACEHOLDERS${RESET} secrets need manual input (marked REPLACE_ME)"
echo ""

if [[ "$SHOW" == "true" ]]; then
  info "Files in $SECRETS_DIR:"
  for f in "$SECRETS_DIR"/*; do
    size=$(wc -c < "$f" | tr -d ' ')
    if grep -q '^REPLACE_ME' "$f" 2>/dev/null; then
      echo -e "    ${YELLOW}⚠  $(basename "$f")${RESET} — needs manual input"
    else
      echo -e "    ${GREEN}✓  $(basename "$f")${RESET} — $size bytes"
    fi
  done
  echo ""
fi

# ── Docker Swarm mode ─────────────────────────────────────────
if [[ "$SWARM" == "true" ]]; then
  section "Registering secrets in Docker Swarm"

  if ! docker info 2>/dev/null | grep -q 'Swarm: active'; then
    error "Docker Swarm is not active. Run: docker swarm init"
    exit 1
  fi

  for secret_file in "$SECRETS_DIR"/*; do
    name=$(basename "$secret_file")

    if grep -q '^REPLACE_ME' "$secret_file" 2>/dev/null; then
      warn "Skipping $name — not yet filled in"
      continue
    fi

    # Remove existing secret (Swarm doesn't support update)
    if docker secret inspect "$name" &>/dev/null; then
      if [[ "$FORCE" == "true" ]]; then
        docker secret rm "$name" &>/dev/null || true
      else
        warn "Swarm secret '$name' already exists — use --force to replace"
        continue
      fi
    fi

    docker secret create "$name" "$secret_file" > /dev/null
    log "Swarm secret created: $name"
  done
fi

# ── Security reminder ─────────────────────────────────────────
echo ""
echo -e "${BOLD}Security reminders:${RESET}"
echo -e "  • ${YELLOW}secrets/${RESET} is in .gitignore — verify before committing"
echo -e "  • File permissions are set to 400 (owner read-only)"
echo -e "  • Fill in all REPLACE_ME placeholders before starting services"
echo -e "  • Run this script again with ${CYAN}--force${RESET} to rotate secrets"
echo -e "  • After rotation: restart all affected containers"
echo ""
echo -e "Next step:"
echo -e "  ${CYAN}docker compose -f docker-compose.prod.yml up -d${RESET}"
echo ""
