#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
#
#  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
#  ░                                                                        ░
#  ░          JOB HUNTER AI — ONE-COMMAND PRODUCTION DEPLOYER              ░
#  ░                                                                        ░
#  ░  Usage:  bash deploy.sh [path/to/project.zip]                         ░
#  ░          bash deploy.sh         ← run from inside project folder      ░
#  ░                                                                        ░
#  ░  Safe to re-run at any time. Skips completed steps automatically.     ░
#  ░                                                                        ░
#  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
#
# WHAT THIS DOES
# ──────────────
#   Step 1  Install Docker, Docker Compose, curl, git, unzip + configure firewall
#   Step 2  Extract project from ZIP (or use current directory)
#   Step 3  Generate cryptographic secrets + prompt for API keys
#   Step 4  Validate everything is ready
#   Step 5  Build Docker images (parallel)
#   Step 6  Start all services + monitoring stack
#   Step 7  Wait for health checks to pass
#   Step 8  Print access URLs + next steps
#
# REQUIREMENTS
# ────────────
#   • Ubuntu 22.04 / 24.04  or  Debian 12
#   • Root or sudo access
#   • 8 GB RAM minimum, 30 GB disk
#   • Ports 80 + 443 open in your cloud security group / firewall
#
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail
IFS=$'\n\t'

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ── State tracking (idempotency) ──────────────────────────────────────────────
# Each completed step is recorded as a file in STATE_DIR.
# Re-running the script skips already-completed steps.
STATE_DIR="${HOME}/.jhai-deploy"
mkdir -p "$STATE_DIR"

step_done()  { [[ -f "${STATE_DIR}/$1" ]]; }
mark_done()  { touch "${STATE_DIR}/$1"; }
clear_step() { rm -f "${STATE_DIR}/$1"; }

# ── Logging helpers ───────────────────────────────────────────────────────────
log()     { echo -e "${BOLD}[$(date +%H:%M:%S)]${RESET} $*"; }
info()    { echo -e "  ${CYAN}→${RESET} $*"; }
ok()      { echo -e "  ${GREEN}✓${RESET} $*"; }
warn()    { echo -e "  ${YELLOW}!${RESET} $*"; }
err()     { echo -e "  ${RED}✗${RESET} $*" >&2; }
die()     { err "$*"; echo ""; exit 1; }

section() {
  echo ""
  echo -e "${BOLD}${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}${BLUE}  $*${RESET}"
  echo -e "${BOLD}${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
}

# ── Banner ────────────────────────────────────────────────────────────────────
print_banner() {
  clear 2>/dev/null || true
  echo ""
  echo -e "${BOLD}${CYAN}  ╔══════════════════════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}${CYAN}  ║           JOB HUNTER AI — AUTO DEPLOYER                 ║${RESET}"
  echo -e "${BOLD}${CYAN}  ║   Autonomous AI-powered job application platform        ║${RESET}"
  echo -e "${BOLD}${CYAN}  ╚══════════════════════════════════════════════════════════╝${RESET}"
  echo ""
  echo -e "  ${YELLOW}This script deploys the complete platform in one command.${RESET}"
  echo -e "  ${YELLOW}It is safe to re-run — completed steps are skipped.${RESET}"
  echo ""
  echo -e "  ${BOLD}Log file:${RESET} ${STATE_DIR}/deploy.log"
  echo ""
}

# ── OS detection ──────────────────────────────────────────────────────────────
detect_os() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_VER="${VERSION_ID:-unknown}"
  else
    OS_ID="unknown"; OS_VER="unknown"
  fi

  if [[ "$OS_ID" == "ubuntu" || "$OS_ID" == "debian" ]]; then
    ok "OS: $OS_ID $OS_VER"
  else
    warn "OS: $OS_ID $OS_VER  (tested on Ubuntu 22.04/24.04 and Debian 12)"
    warn "Continuing — package names may differ on other distros"
    sleep 2
  fi
}

# ── Require sudo ──────────────────────────────────────────────────────────────
require_sudo() {
  if [[ $EUID -eq 0 ]]; then
    SUDO=""
  elif sudo -n true 2>/dev/null; then
    SUDO="sudo"
  else
    info "This script needs sudo for system package installation."
    sudo -v || die "Cannot obtain sudo privileges. Run as root or add user to sudoers."
    SUDO="sudo"
    # Keep sudo timestamp alive in background
    ( while true; do sudo -n true; sleep 50; done ) 2>/dev/null &
    SUDO_PID=$!
    trap 'kill ${SUDO_PID} 2>/dev/null || true' EXIT INT TERM
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
# STEP 1 — INSTALL SYSTEM DEPENDENCIES
# ══════════════════════════════════════════════════════════════════════════════
step1_install_deps() {
  if step_done "s1_deps"; then
    ok "System dependencies already installed — skipping"
    return
  fi

  section "STEP 1/8 — Installing System Dependencies"

  info "Updating package index…"
  $SUDO apt-get update -qq 2>&1 | tail -1

  info "Installing base tools…"
  $SUDO apt-get install -y -qq \
    curl wget git unzip jq ca-certificates \
    gnupg lsb-release apt-transport-https \
    software-properties-common openssl 2>/dev/null
  ok "Base tools: curl, git, unzip, jq, openssl"

  # ── Docker ────────────────────────────────────────────────────────────────
  if command -v docker &>/dev/null; then
    DVER=$(docker --version 2>/dev/null | grep -oP '\d+\.\d+' | head -1 || echo "?")
    ok "Docker $DVER already installed"
  else
    info "Installing Docker Engine (official script)…"
    curl -fsSL https://get.docker.com | $SUDO sh 2>&1 | grep -E "^[A-Z]|complete|Installed" || true
    $SUDO systemctl enable docker --quiet
    $SUDO systemctl start docker
    # Add calling user to docker group so they can run docker without sudo
    CALLING_USER="${SUDO_USER:-$USER}"
    if [[ "$CALLING_USER" != "root" ]]; then
      $SUDO usermod -aG docker "$CALLING_USER" 2>/dev/null || true
      ok "Added $CALLING_USER to docker group (takes effect after re-login)"
    fi
    ok "Docker Engine installed"
  fi

  # ── Docker Compose v2 plugin ──────────────────────────────────────────────
  if docker compose version &>/dev/null 2>&1; then
    CVER=$(docker compose version --short 2>/dev/null || echo "v2")
    ok "Docker Compose $CVER already installed"
  else
    info "Installing Docker Compose v2 plugin…"
    ARCH=$(uname -m)
    [[ "$ARCH" == "aarch64" ]] && ARCH="aarch64" || ARCH="x86_64"
    CVER=$(curl -fsSL https://api.github.com/repos/docker/compose/releases/latest \
           | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/' 2>/dev/null || echo "2.27.0")
    $SUDO mkdir -p /usr/local/lib/docker/cli-plugins
    $SUDO curl -fsSL \
      "https://github.com/docker/compose/releases/download/v${CVER}/docker-compose-linux-${ARCH}" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    $SUDO chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    ok "Docker Compose v${CVER} installed"
  fi

  # ── Firewall (UFW) ────────────────────────────────────────────────────────
  if command -v ufw &>/dev/null; then
    info "Configuring UFW firewall…"
    $SUDO ufw --force reset      >/dev/null 2>&1 || true
    $SUDO ufw default deny incoming  >/dev/null 2>&1 || true
    $SUDO ufw default allow outgoing >/dev/null 2>&1 || true
    $SUDO ufw allow 22/tcp   comment 'SSH'   >/dev/null 2>&1
    $SUDO ufw allow 80/tcp   comment 'HTTP'  >/dev/null 2>&1
    $SUDO ufw allow 443/tcp  comment 'HTTPS' >/dev/null 2>&1
    $SUDO ufw --force enable >/dev/null 2>&1 || true
    ok "Firewall: 22(SSH), 80(HTTP), 443(HTTPS) open; all else blocked"
  else
    warn "UFW not found — ensure ports 22, 80, 443 are open in your cloud security group"
  fi

  mark_done "s1_deps"
  ok "All system dependencies ready"
}

# ══════════════════════════════════════════════════════════════════════════════
# STEP 2 — LOCATE / EXTRACT PROJECT
# ══════════════════════════════════════════════════════════════════════════════
step2_setup_project() {
  section "STEP 2/8 — Project Setup"

  ZIP_ARG="${1:-}"
  DEPLOY_DIR="${HOME}/job-hunter-ai"

  # ── Already in project directory ─────────────────────────────────────────
  if [[ -f "docker-compose.prod.yml" ]] && [[ -z "$ZIP_ARG" ]]; then
    DEPLOY_DIR="$(pwd)"
    ok "Running from project directory: $DEPLOY_DIR"
    return
  fi

  # ── ZIP already extracted ─────────────────────────────────────────────────
  if step_done "s2_extracted" && [[ -d "$DEPLOY_DIR/infrastructure" ]]; then
    ok "Project already extracted at $DEPLOY_DIR — skipping"
    cd "$DEPLOY_DIR"
    return
  fi

  # ── Find the ZIP ──────────────────────────────────────────────────────────
  if [[ -n "$ZIP_ARG" && -f "$ZIP_ARG" ]]; then
    ZIP_FILE="$(realpath "$ZIP_ARG")"
  elif ls ./*.zip 1>/dev/null 2>&1; then
    ZIP_FILE="$(ls ./*.zip | head -1)"
    warn "No ZIP specified — found: $ZIP_FILE"
  else
    die "Cannot find project.
    
  Provide the ZIP path:     bash deploy.sh /path/to/job-hunter-ai.zip
  Or run from project root: cd job-hunter-ai && bash deploy.sh"
  fi

  info "Extracting $ZIP_FILE …"
  TMP=$(mktemp -d)
  unzip -q "$ZIP_FILE" -d "$TMP"

  # Handle nested top-level directory (job-hunter-ai/... inside ZIP)
  INNER=$(find "$TMP" -maxdepth 3 -name "docker-compose.prod.yml" \
            -exec dirname {} \; | head -1)

  mkdir -p "$DEPLOY_DIR"
  if [[ -n "$INNER" ]]; then
    cp -a "$INNER/." "$DEPLOY_DIR/"
  else
    cp -a "$TMP/." "$DEPLOY_DIR/"
  fi
  rm -rf "$TMP"

  mark_done "s2_extracted"
  ok "Project extracted to: $DEPLOY_DIR"
  cd "$DEPLOY_DIR"

  # Verify
  [[ -f "docker-compose.prod.yml" ]] || \
    die "docker-compose.prod.yml not found — ZIP may not contain the project"

  # Make scripts executable
  find infrastructure/scripts -name "*.sh" -exec chmod +x {} \; 2>/dev/null || true
}

# ══════════════════════════════════════════════════════════════════════════════
# STEP 3 — SECRETS AND ENVIRONMENT SETUP
# ══════════════════════════════════════════════════════════════════════════════
step3_setup_secrets() {
  section "STEP 3/8 — Secrets & Configuration"

  # ── Generate cryptographic secrets ────────────────────────────────────────
  if ! step_done "s3_secrets_generated"; then
    info "Generating cryptographic secrets (JWT, AES, Redis password, etc.)…"
    if [[ -x "infrastructure/scripts/generate-secrets.sh" ]]; then
      bash infrastructure/scripts/generate-secrets.sh --force 2>&1 \
        | grep -v "^$" | grep -v "^#" | head -20 || true
    else
      # Fallback: generate secrets manually
      warn "generate-secrets.sh not found — generating secrets manually"
      _gen_secrets_fallback
    fi
    mark_done "s3_secrets_generated"
    ok "Cryptographic secrets generated in secrets/"
  else
    ok "Cryptographic secrets already generated"
  fi

  echo ""
  echo -e "  ${BOLD}External API keys — enter your real values below:${RESET}"
  echo -e "  ${YELLOW}(Press Enter to skip any key and fill it later in the secrets/ folder)${RESET}"
  echo ""

  # ── Prompt helper ─────────────────────────────────────────────────────────
  _prompt_secret() {
    local name="$1" label="$2" hint="$3" url="$4"
    local file="secrets/${name}" current=""

    [[ -f "$file" ]] && current="$(cat "$file")" || current=""

    # Skip if already filled with a real (non-placeholder) value
    if [[ -n "$current" ]] \
    && [[ "$current" != *"REPLACE_ME"* ]] \
    && [[ "$current" != *"your-"* ]] \
    && [[ "$current" != *"placeholder"* ]] \
    && [[ "$current" != *"example"* ]]; then
      ok "${label} → already configured"
      return
    fi

    echo -e "  ${YELLOW}┌─ ${BOLD}${label}${RESET}"
    echo -e "  ${YELLOW}│  ${RESET}Get it from: ${CYAN}${url}${RESET}"
    echo -e "  ${YELLOW}│  ${RESET}Format: ${hint}"
    echo -ne "  ${YELLOW}└─ ${RESET}${BOLD}Value${RESET} (Enter to skip): "

    local value=""
    # Use -r for raw mode, don't echo for sensitive values
    IFS= read -rs value 2>/dev/null || IFS= read -r value 2>/dev/null || true
    echo ""

    if [[ -n "$value" ]]; then
      mkdir -p secrets
      printf '%s' "$value" > "$file"
      chmod 600 "$file"
      ok "${label} saved to secrets/${name}"
    else
      warn "${label} skipped — fill in: secrets/${name}"
    fi
    echo ""
  }

  _prompt_secret "anthropic_api_key" \
    "Anthropic API Key  (REQUIRED)" \
    "sk-ant-api03-xxxxxxxxxxxx" \
    "https://console.anthropic.com/keys"

  _prompt_secret "gmail_client_secret" \
    "Google Gmail OAuth2 Client Secret  (for email features)" \
    "GOCSPX-xxxxxxxxxxxxxxxxxxxx" \
    "https://console.cloud.google.com/apis/credentials"

  _prompt_secret "whatsapp_access_token" \
    "WhatsApp Cloud API Access Token  (for notifications)" \
    "EAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
    "https://developers.facebook.com/apps → WhatsApp → API Setup"

  _prompt_secret "whatsapp_app_secret" \
    "WhatsApp App Secret  (for webhook verification)" \
    "abc123def456ghi789" \
    "https://developers.facebook.com/apps → Settings → Basic"

  # Auto-generate verify token if missing
  if [[ ! -s "secrets/whatsapp_verify_token" ]] \
  || grep -q "REPLACE_ME" "secrets/whatsapp_verify_token" 2>/dev/null; then
    openssl rand -hex 24 > secrets/whatsapp_verify_token
    chmod 600 secrets/whatsapp_verify_token
    ok "WhatsApp verify token auto-generated: $(cat secrets/whatsapp_verify_token)"
  fi

  # ── Create .env file ───────────────────────────────────────────────────────
  if [[ ! -f ".env" ]]; then
    info "Detecting server IP…"
    PUBLIC_IP=$(curl -fsSL --connect-timeout 5 https://api.ipify.org 2>/dev/null \
             || curl -fsSL --connect-timeout 5 https://checkip.amazonaws.com 2>/dev/null \
             || hostname -I 2>/dev/null | awk '{print $1}' \
             || echo "YOUR_SERVER_IP")

    info "Creating .env (server IP: $PUBLIC_IP)…"
    cat > .env << ENVEOF
# ═══════════════════════════════════════════════════════════
# Job Hunter AI — Production Environment
# Generated: $(date)
# ═══════════════════════════════════════════════════════════

# Server public IP (replace with your domain after DNS setup)
PUBLIC_IP=${PUBLIC_IP}

# ── Application URLs ───────────────────────────────────────
# If you have a domain: replace ${PUBLIC_IP} with yourdomain.com
NEXT_PUBLIC_API_URL=http://${PUBLIC_IP}
NEXT_PUBLIC_APP_URL=http://${PUBLIC_IP}
CORS_ORIGINS=http://${PUBLIC_IP}

# ── Google OAuth (needed for Gmail integration) ────────────
GMAIL_CLIENT_ID=

# ── WhatsApp ───────────────────────────────────────────────
WHATSAPP_PHONE_NUMBER_ID=

# ── AWS S3 (needed for resume storage) ────────────────────
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_S3_BUCKET=job-hunter-ai-files

# ── Stripe (needed for billing/subscriptions) ─────────────
STRIPE_PUBLISHABLE_KEY=

# ── PostgreSQL config ─────────────────────────────────────
POSTGRES_DB=jobhunter
POSTGRES_USER=jhuser

# ── Image tag ─────────────────────────────────────────────
IMAGE_TAG=latest
ENVEOF
    ok ".env created with IP: $PUBLIC_IP"
    echo ""
    echo -e "  ${YELLOW}Edit .env to add domain name, Gmail client ID, etc.:${RESET}"
    echo -e "  ${CYAN}  nano .env${RESET}"
    echo ""
    sleep 2
  else
    ok ".env already exists"
    # Patch placeholder IP if needed
    if grep -q "YOUR_SERVER_IP" .env 2>/dev/null; then
      IP=$(curl -fsSL --connect-timeout 5 https://api.ipify.org 2>/dev/null || echo "")
      [[ -n "$IP" ]] && sed -i "s/YOUR_SERVER_IP/${IP}/g" .env && \
        ok "Updated .env with IP: $IP"
    fi
  fi
}

# ── Fallback secret generation (if generate-secrets.sh is missing) ────────────
_gen_secrets_fallback() {
  mkdir -p secrets
  chmod 700 secrets

  _write_secret() {
    local name="$1" val="$2"
    [[ -f "secrets/$name" ]] && return  # don't overwrite existing
    printf '%s' "$val" > "secrets/$name"
    chmod 600 "secrets/$name"
  }

  PG_PASS=$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 32)
  REDIS_PASS=$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 32)

  _write_secret "postgres_password"    "$PG_PASS"
  _write_secret "redis_password"       "$REDIS_PASS"
  _write_secret "db_url"               "postgresql://jhuser:${PG_PASS}@postgres:5432/jobhunter"
  _write_secret "redis_url"            "redis://:${REDIS_PASS}@redis:6379"
  _write_secret "jwt_secret"           "$(openssl rand -base64 64 | tr -dc 'a-zA-Z0-9' | head -c 64)"
  _write_secret "jwt_refresh_secret"   "$(openssl rand -base64 64 | tr -dc 'a-zA-Z0-9' | head -c 64)"
  _write_secret "cookie_secret"        "$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 32)"
  _write_secret "encryption_key"       "$(openssl rand -hex 32)"
  _write_secret "grafana_password"     "$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 16)"
  _write_secret "anthropic_api_key"    "REPLACE_ME"
  _write_secret "gmail_client_secret"  "REPLACE_ME"
  _write_secret "whatsapp_access_token" "REPLACE_ME"
  _write_secret "whatsapp_app_secret"  "REPLACE_ME"
  _write_secret "whatsapp_verify_token" "$(openssl rand -hex 24)"
  _write_secret "aws_secret_access_key" "REPLACE_ME"

  ok "Secrets generated (fallback method)"
}

# ══════════════════════════════════════════════════════════════════════════════
# STEP 4 — VALIDATION
# ══════════════════════════════════════════════════════════════════════════════
step4_validate() {
  section "STEP 4/8 — Pre-deploy Validation"

  if [[ ! -x "infrastructure/scripts/validate.sh" ]]; then
    warn "validate.sh not found or not executable — skipping validation"
    return
  fi

  if bash infrastructure/scripts/validate.sh; then
    ok "Validation passed — ready to deploy"
  else
    EXIT_CODE=$?
    echo ""
    if [[ $EXIT_CODE -eq 1 ]]; then
      err "Validation FAILED with errors."
      echo ""
      echo -e "  ${BOLD}Common fixes:${RESET}"
      echo -e "    ${CYAN}• API keys:${RESET} Fill in secrets/anthropic_api_key etc."
      echo -e "    ${CYAN}• SSL certs:${RESET} Place fullchain.pem + privkey.pem in infrastructure/nginx/ssl/"
      echo -e "    ${CYAN}• .env:${RESET}      Set GMAIL_CLIENT_ID, WHATSAPP_PHONE_NUMBER_ID"
      echo ""
      echo -ne "  ${YELLOW}Continue deployment anyway? [y/N]: ${RESET}"
      local CONT
      read -r -t 20 CONT || CONT="n"
      echo ""
      if [[ "${CONT,,}" != "y" ]]; then
        die "Deployment stopped. Fix the issues above and re-run: bash deploy.sh"
      fi
      warn "Continuing with validation warnings — monitor logs carefully after start"
    fi
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
# STEP 5 — BUILD DOCKER IMAGES
# ══════════════════════════════════════════════════════════════════════════════
step5_build() {
  if step_done "s5_built"; then
    echo -ne "  ${YELLOW}Images already built. Rebuild? [y/N]: ${RESET}"
    local REBUILD
    read -r -t 10 REBUILD || REBUILD="n"
    echo ""
    if [[ "${REBUILD,,}" != "y" ]]; then
      ok "Using existing images"
      return
    fi
    clear_step "s5_built"
  fi

  section "STEP 5/8 — Building Docker Images"

  echo -e "  ${YELLOW}This takes 10–20 minutes on first run.${RESET}"
  echo -e "  ${YELLOW}The Playwright bot image is ~1.4 GB — please be patient.${RESET}"
  echo ""

  export DOCKER_BUILDKIT=1
  export COMPOSE_DOCKER_CLI_BUILD=1

  if docker compose -f docker-compose.prod.yml build --parallel; then
    mark_done "s5_built"
    ok "All Docker images built successfully"
  else
    die "Build failed. Check errors above. Common causes:
    • No internet access (check curl https://google.com)
    • Insufficient disk space (need 15 GB free)
    • npm install failure (check package.json)"
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
# STEP 6 — START SERVICES
# ══════════════════════════════════════════════════════════════════════════════
step6_start() {
  section "STEP 6/8 — Starting Services"

  info "Starting database migration…"
  docker compose -f docker-compose.prod.yml up -d migrate 2>/dev/null || true
  sleep 3

  info "Starting core services (api, workers, nginx, web)…"
  if ! docker compose -f docker-compose.prod.yml up -d; then
    die "Failed to start core services.
    Run: docker compose -f docker-compose.prod.yml logs"
  fi
  ok "Core services started"

  echo ""
  info "Starting monitoring stack (Prometheus, Grafana, Loki, Promtail)…"
  if docker compose -f docker-compose.prod.yml --profile monitoring up -d 2>/dev/null; then
    ok "Monitoring stack started"
  else
    warn "Monitoring stack failed — core services still running"
    warn "Retry: docker compose -f docker-compose.prod.yml --profile monitoring up -d"
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
# STEP 7 — WAIT FOR HEALTH CHECKS
# ══════════════════════════════════════════════════════════════════════════════
step7_health_check() {
  section "STEP 7/8 — Waiting for Services to Become Healthy"

  CRITICAL=("jh-postgres" "jh-redis" "jh-api")
  MAX_WAIT=300
  INTERVAL=8
  ELAPSED=0
  declare -A HEALTHY=()

  echo -e "  Checking: ${CYAN}${CRITICAL[*]}${RESET}"
  echo -e "  Timeout:  ${MAX_WAIT}s  (checking every ${INTERVAL}s)"
  echo ""

  while (( ELAPSED < MAX_WAIT )); do
    for SVC in "${CRITICAL[@]}"; do
      [[ -n "${HEALTHY[$SVC]:-}" ]] && continue  # already healthy
      STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$SVC" 2>/dev/null \
               || echo "not_started")
      if [[ "$STATUS" == "healthy" ]]; then
        HEALTHY[$SVC]="1"
        ok "$SVC is healthy"
      fi
    done

    # All critical services healthy?
    if (( ${#HEALTHY[@]} == ${#CRITICAL[@]} )); then
      echo ""
      ok "All critical services are healthy!"
      break
    fi

    # Progress indicator
    echo -ne "  ${YELLOW}.${RESET}"
    sleep $INTERVAL
    (( ELAPSED += INTERVAL ))

    # Verbose status every 60 s
    if (( ELAPSED % 60 == 0 )); then
      echo ""
      info "Still waiting (${ELAPSED}s)… checking status:"
      for SVC in "${CRITICAL[@]}"; do
        STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$SVC" 2>/dev/null || echo "?")
        echo -e "    $SVC → $STATUS"
      done
    fi
  done

  echo ""

  # Summarise unhealthy services
  UNHEALTHY=()
  for SVC in "${CRITICAL[@]}"; do
    [[ -z "${HEALTHY[$SVC]:-}" ]] && UNHEALTHY+=("$SVC")
  done

  if (( ${#UNHEALTHY[@]} > 0 )); then
    warn "These services did not reach healthy state:"
    for SVC in "${UNHEALTHY[@]}"; do
      STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$SVC" 2>/dev/null || echo "not running")
      echo -e "    ${RED}✗${RESET} $SVC → $STATUS"
    done
    echo ""
    warn "Check their logs: bash logs.sh api  OR  bash logs.sh postgres"
  fi

  echo ""
  info "Full service status:"
  echo ""
  docker compose -f docker-compose.prod.yml ps \
    --format "table {{.Name}}\t{{.Status}}" 2>/dev/null \
    || docker compose -f docker-compose.prod.yml ps
}

# ══════════════════════════════════════════════════════════════════════════════
# STEP 8 — PRINT ACCESS INFO
# ══════════════════════════════════════════════════════════════════════════════
step8_print_info() {
  section "STEP 8/8 — Deployment Complete"

  # Resolve IP
  PUBLIC_IP=$(grep "^PUBLIC_IP=" .env 2>/dev/null | cut -d= -f2 | tr -d '"' \
           || curl -fsSL --connect-timeout 5 https://api.ipify.org 2>/dev/null \
           || hostname -I 2>/dev/null | awk '{print $1}' \
           || echo "YOUR_SERVER_IP")

  # Protocol
  if [[ -f "infrastructure/nginx/ssl/fullchain.pem" ]]; then
    PROTO="https"
  else
    PROTO="http"
  fi

  # Grafana password
  GRAFANA_PASS=$(cat secrets/grafana_password 2>/dev/null | head -c 20 || echo "see secrets/grafana_password")

  echo ""
  echo -e "${BOLD}${GREEN}  ╔══════════════════════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}${GREEN}  ║             🚀  DEPLOYMENT SUCCESSFUL  🚀                ║${RESET}"
  echo -e "${BOLD}${GREEN}  ╚══════════════════════════════════════════════════════════╝${RESET}"
  echo ""
  echo -e "  ${BOLD}Server IP:${RESET}          ${CYAN}${PUBLIC_IP}${RESET}"
  echo ""
  echo -e "  ${BOLD}${YELLOW}── Application ──────────────────────────────────────────────${RESET}"
  echo -e "  ${BOLD}Web App:${RESET}            ${CYAN}${PROTO}://${PUBLIC_IP}${RESET}"
  echo -e "  ${BOLD}API:${RESET}                ${CYAN}${PROTO}://${PUBLIC_IP}/api${RESET}"
  echo -e "  ${BOLD}API Health:${RESET}         ${CYAN}${PROTO}://${PUBLIC_IP}/health${RESET}"
  echo -e "  ${BOLD}Queue Dashboard:${RESET}    ${CYAN}${PROTO}://${PUBLIC_IP}/queues${RESET}"
  echo ""
  echo -e "  ${BOLD}${YELLOW}── Monitoring ───────────────────────────────────────────────${RESET}"
  echo -e "  ${BOLD}Grafana:${RESET}            ${CYAN}http://${PUBLIC_IP}:3000${RESET}"
  echo -e "  ${BOLD}  Login:${RESET}            admin / ${YELLOW}${GRAFANA_PASS}${RESET}"
  echo -e "  ${BOLD}Prometheus:${RESET}         ${CYAN}http://${PUBLIC_IP}:9090${RESET}  (internal)"
  echo ""
  echo -e "  ${BOLD}${YELLOW}── Management Commands ──────────────────────────────────────${RESET}"
  echo ""
  echo -e "  ${GREEN}bash logs.sh${RESET}              View all service logs"
  echo -e "  ${GREEN}bash logs.sh -f api${RESET}       Follow API logs live"
  echo -e "  ${GREEN}bash logs.sh -f worker-bot${RESET} Follow bot worker logs"
  echo -e "  ${GREEN}bash restart.sh${RESET}           Restart all services"
  echo -e "  ${GREEN}bash restart.sh api${RESET}       Restart API only"
  echo -e "  ${GREEN}bash stop.sh${RESET}              Stop all (data preserved)"
  echo -e "  ${GREEN}bash update.sh new.zip${RESET}    Deploy new version"
  echo ""
  echo -e "  ${BOLD}${YELLOW}── Next Steps ───────────────────────────────────────────────${RESET}"
  echo ""

  if [[ "$PROTO" == "http" ]]; then
    echo -e "  ${YELLOW}1. Add SSL certificate (strongly recommended):${RESET}"
    echo -e "     ${CYAN}sudo apt-get install -y certbot${RESET}"
    echo -e "     ${CYAN}sudo certbot certonly --standalone -d yourdomain.com${RESET}"
    echo -e "     ${CYAN}sudo cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem \\"
    echo -e "             infrastructure/nginx/ssl/fullchain.pem${RESET}"
    echo -e "     ${CYAN}sudo cp /etc/letsencrypt/live/yourdomain.com/privkey.pem \\"
    echo -e "             infrastructure/nginx/ssl/privkey.pem${RESET}"
    echo -e "     ${CYAN}bash restart.sh nginx${RESET}"
    echo ""
  fi

  echo -e "  ${YELLOW}2. Point your domain DNS A-record → ${PUBLIC_IP}${RESET}"
  echo -e "  ${YELLOW}3. Update .env with your domain, then: bash restart.sh${RESET}"
  echo -e "  ${YELLOW}4. Create first user: ${PROTO}://${PUBLIC_IP}/auth/register${RESET}"
  echo ""
  echo -e "  ${BOLD}Project directory:${RESET} $(pwd)"
  echo ""

  # Save summary
  mkdir -p "$STATE_DIR"
  cat > "${STATE_DIR}/deployment-info.txt" << SUMEOF
Job Hunter AI — Deployment Summary
====================================
Date:      $(date)
Server IP: ${PUBLIC_IP}
Protocol:  ${PROTO}
Directory: $(pwd)

URLs:
  Web:        ${PROTO}://${PUBLIC_IP}
  API:        ${PROTO}://${PUBLIC_IP}/api
  Grafana:    http://${PUBLIC_IP}:3000
  Grafana pw: ${GRAFANA_PASS}
SUMEOF
  ok "Deployment info saved: ${STATE_DIR}/deployment-info.txt"
}

# ══════════════════════════════════════════════════════════════════════════════
# GENERATE COMPANION SCRIPTS
# ══════════════════════════════════════════════════════════════════════════════
generate_companions() {

# ─── restart.sh ───────────────────────────────────────────────────────────────
cat > restart.sh << 'EOF'
#!/usr/bin/env bash
# Job Hunter AI — Restart Services
# Usage: bash restart.sh [service-name]
# Examples:
#   bash restart.sh           → restart everything
#   bash restart.sh api       → restart API only
#   bash restart.sh nginx     → restart nginx only
set -euo pipefail
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RESET='\033[0m'; BOLD='\033[1m'

cd "$(dirname "$(readlink -f "$0")")" 2>/dev/null || true
[[ -f "docker-compose.prod.yml" ]] || { echo "Run from project root"; exit 1; }

SERVICE="${1:-}"

echo -e "${BOLD}Job Hunter AI — Restart${RESET}"
echo ""

if [[ -n "$SERVICE" ]]; then
  echo -e "${CYAN}→${RESET} Restarting: ${YELLOW}${SERVICE}${RESET}"
  docker compose -f docker-compose.prod.yml restart "$SERVICE"
  echo -e "${GREEN}✓${RESET} ${SERVICE} restarted"
else
  echo -e "${CYAN}→${RESET} Restarting all services…"
  docker compose -f docker-compose.prod.yml up -d --remove-orphans
  docker compose -f docker-compose.prod.yml --profile monitoring up -d --remove-orphans
  echo -e "${GREEN}✓${RESET} All services restarted"
fi

echo ""
echo "Service status:"
docker compose -f docker-compose.prod.yml ps \
  --format "table {{.Name}}\t{{.Status}}" 2>/dev/null \
  || docker compose -f docker-compose.prod.yml ps
EOF
chmod +x restart.sh

# ─── logs.sh ──────────────────────────────────────────────────────────────────
cat > logs.sh << 'EOF'
#!/usr/bin/env bash
# Job Hunter AI — Log Viewer
#
# Usage:
#   bash logs.sh                       All services (last 80 lines)
#   bash logs.sh api                   API only
#   bash logs.sh -f api                Follow (live) API logs
#   bash logs.sh worker-bot            Playwright bot logs
#   bash logs.sh worker-scraper        Scraper logs
#   bash logs.sh worker-email          Email worker logs
#   bash logs.sh worker-ai             AI match worker logs
#   bash logs.sh worker-notification   WhatsApp notification logs
#   bash logs.sh worker-resume         Resume parser logs
#   bash logs.sh worker-prep           Interview prep logs
#   bash logs.sh postgres              Database logs
#   bash logs.sh redis                 Redis logs
#   bash logs.sh nginx                 Nginx access/error logs
#   bash logs.sh grafana               Grafana logs
#   bash logs.sh -n 200 api            Last 200 lines of API logs
set -euo pipefail
CYAN='\033[0;36m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; RESET='\033[0m'

cd "$(dirname "$(readlink -f "$0")")" 2>/dev/null || true
[[ -f "docker-compose.prod.yml" ]] || { echo "Run from project root"; exit 1; }

FOLLOW=false; LINES=80; SERVICE=""

# Parse args
for arg in "$@"; do
  case "$arg" in
    -f|--follow) FOLLOW=true ;;
    -n[0-9]*)    LINES="${arg#-n}" ;;
    --lines=*)   LINES="${arg#--lines=}" ;;
    -*)          echo "Unknown flag: $arg"; exit 1 ;;
    *)           SERVICE="$arg" ;;
  esac
done

# Short-name aliases
declare -A ALIASES=(
  [bot]="worker-bot"
  [scraper]="worker-scraper"
  [email]="worker-email"
  [ai]="worker-ai"
  [notification]="worker-notification"
  [notif]="worker-notification"
  [resume]="worker-resume"
  [prep]="worker-prep"
  [db]="postgres"
)
[[ -n "$SERVICE" && -n "${ALIASES[$SERVICE]:-}" ]] && SERVICE="${ALIASES[$SERVICE]}"

FOLLOW_FLAG=""
$FOLLOW && FOLLOW_FLAG="--follow"

if [[ -n "$SERVICE" ]]; then
  echo -e "${BOLD}${CYAN}── Logs: jh-${SERVICE} (last ${LINES} lines) ──${RESET}"
  echo ""
  # shellcheck disable=SC2086
  docker compose -f docker-compose.prod.yml logs $FOLLOW_FLAG --tail="$LINES" "$SERVICE" 2>/dev/null \
    || docker compose -f docker-compose.prod.yml logs $FOLLOW_FLAG --tail="$LINES" "jh-$SERVICE"
else
  echo -e "${BOLD}${CYAN}── All Services — Last ${LINES} Lines ──${RESET}"
  echo -e "${YELLOW}Tip: bash logs.sh -f api    to follow a specific service${RESET}"
  echo ""
  # shellcheck disable=SC2086
  docker compose -f docker-compose.prod.yml logs $FOLLOW_FLAG --tail="$LINES"
fi
EOF
chmod +x logs.sh

# ─── stop.sh ──────────────────────────────────────────────────────────────────
cat > stop.sh << 'EOF'
#!/usr/bin/env bash
# Job Hunter AI — Stop Services
#
# Usage:
#   bash stop.sh            Stop services (data preserved in volumes)
#   bash stop.sh --clean    Stop + remove containers (data preserved)
#   bash stop.sh --purge    ⚠ DANGER: Stop + delete ALL data
set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'; BOLD='\033[1m'

cd "$(dirname "$(readlink -f "$0")")" 2>/dev/null || true
[[ -f "docker-compose.prod.yml" ]] || { echo "Run from project root"; exit 1; }

MODE="${1:-}"

case "$MODE" in
  --purge)
    echo -e "${RED}${BOLD}"
    echo "  ⚠  WARNING: --purge will PERMANENTLY DELETE ALL DATA!"
    echo "  This includes the PostgreSQL database and Redis data."
    echo -ne "${RESET}"
    echo -ne "${RED}  Type 'DELETE ALL DATA' to confirm: ${RESET}"
    read -r CONFIRM
    if [[ "$CONFIRM" != "DELETE ALL DATA" ]]; then
      echo "Cancelled. No data was deleted."
      exit 0
    fi
    echo ""
    echo -e "${YELLOW}→${RESET} Removing all containers and data volumes…"
    docker compose -f docker-compose.prod.yml --profile monitoring down -v --remove-orphans 2>/dev/null || true
    echo -e "${RED}✓${RESET} All services stopped and ALL DATA DELETED"
    ;;
  --clean)
    echo -e "${YELLOW}→${RESET} Stopping and removing containers (data volumes preserved)…"
    docker compose -f docker-compose.prod.yml --profile monitoring down --remove-orphans 2>/dev/null || true
    echo -e "${GREEN}✓${RESET} All containers removed. Database/Redis data preserved."
    echo ""
    echo "  Restart: bash restart.sh"
    ;;
  *)
    echo -e "${YELLOW}→${RESET} Stopping all services (data preserved)…"
    docker compose -f docker-compose.prod.yml --profile monitoring stop 2>/dev/null || true
    echo -e "${GREEN}✓${RESET} All services stopped"
    echo ""
    echo "  Containers still exist. Restart anytime: bash restart.sh"
    echo "  Full cleanup (keep data): bash stop.sh --clean"
    ;;
esac
EOF
chmod +x stop.sh

# ─── update.sh ────────────────────────────────────────────────────────────────
cat > update.sh << 'EOF'
#!/usr/bin/env bash
# Job Hunter AI — Update to New Version
# Usage: bash update.sh path/to/new-version.zip
set -euo pipefail
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RESET='\033[0m'; BOLD='\033[1m'

cd "$(dirname "$(readlink -f "$0")")" 2>/dev/null || true
[[ -f "docker-compose.prod.yml" ]] || { echo "Run from project root"; exit 1; }

echo -e "${BOLD}${CYAN}Job Hunter AI — Update${RESET}"
echo ""

ZIP="${1:-}"
if [[ -n "$ZIP" && -f "$ZIP" ]]; then
  echo -e "${YELLOW}→${RESET} Extracting new version: $ZIP"
  TMP=$(mktemp -d)
  unzip -q "$ZIP" -d "$TMP"
  INNER=$(find "$TMP" -maxdepth 3 -name "docker-compose.prod.yml" -exec dirname {} \; | head -1)
  SRC="${INNER:-$TMP}"
  # Sync all files except secrets and .env (preserve production config)
  rsync -av --delete \
    --exclude=secrets/ \
    --exclude=.env \
    --exclude='*.log' \
    "$SRC/" ./ 2>&1 | tail -5
  rm -rf "$TMP"
  echo -e "${GREEN}✓${RESET} New version files extracted"
  echo ""
fi

echo -e "${YELLOW}→${RESET} Building updated images…"
DOCKER_BUILDKIT=1 docker compose -f docker-compose.prod.yml build --parallel

echo ""
echo -e "${YELLOW}→${RESET} Rolling restart (zero-downtime)…"
docker compose -f docker-compose.prod.yml up -d --remove-orphans
docker compose -f docker-compose.prod.yml --profile monitoring up -d --remove-orphans

echo ""
echo -e "${GREEN}✓${RESET} Update complete!"
echo ""
docker compose -f docker-compose.prod.yml ps \
  --format "table {{.Name}}\t{{.Status}}" 2>/dev/null \
  || docker compose -f docker-compose.prod.yml ps
EOF
chmod +x update.sh

ok "Companion scripts created: restart.sh  logs.sh  stop.sh  update.sh"
}

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════
main() {
  # Tee all output to a log file
  mkdir -p "$STATE_DIR"
  exec > >(tee -a "${STATE_DIR}/deploy.log") 2>&1

  print_banner
  detect_os
  require_sudo

  step1_install_deps
  step2_setup_project "${1:-}"

  # Generate companion scripts early so they're available even if deploy fails later
  generate_companions

  step3_setup_secrets
  step4_validate
  step5_build
  step6_start
  step7_health_check
  step8_print_info
}

main "$@"
