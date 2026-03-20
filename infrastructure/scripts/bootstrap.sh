#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
# Job Hunter AI — AWS EC2 Bootstrap Script
# Provisions a fresh Ubuntu 24.04 LTS server with:
#   Docker, UFW, fail2ban, SSL certs, swap, kernel tuning,
#   AND automatic Docker secrets generation.
#
# Usage:
#   export AWS_ACCOUNT_ID=123456789012 DOMAIN=jobhunter.ai EMAIL=admin@jobhunter.ai
#   curl -sL https://...bootstrap.sh | sudo -E bash
# ══════════════════════════════════════════════════════════════

set -euo pipefail
IFS=$'\n\t'

AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-}"
AWS_REGION="${AWS_REGION:-us-east-1}"
DOMAIN="${DOMAIN:-jobhunter.ai}"
EMAIL="${EMAIL:-admin@jobhunter.ai}"
APP_DIR="/opt/job-hunter-ai"
BACKUP_DIR="/opt/backups"
SECRETS_DIR="$APP_DIR/secrets"

log()    { echo -e "\033[32m[$(date +%T)] ✓ $*\033[0m"; }
warn()   { echo -e "\033[33m[$(date +%T)] ⚠ $*\033[0m"; }
die()    { echo -e "\033[31m[$(date +%T)] ✗ $*\033[0m" >&2; exit 1; }
section(){ echo -e "\n\033[1m══ $* ══\033[0m"; }

[[ $EUID -ne 0 ]] && die "Run as root: sudo $0"

# ── 1: System updates ─────────────────────────────────────────
section "System Updates"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq
apt-get install -y -qq \
  curl wget git unzip jq vim htop \
  ca-certificates gnupg lsb-release \
  ufw fail2ban awscli certbot

# ── 2: Docker ─────────────────────────────────────────────────
section "Docker Installation"
if ! command -v docker &>/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
  usermod -aG docker ubuntu
  log "Docker installed: $(docker --version)"
else
  log "Docker already installed"
fi

# Security-hardened Docker daemon config
cat > /etc/docker/daemon.json << 'DAEMON'
{
  "log-driver": "json-file",
  "log-opts":   { "max-size": "50m", "max-file": "5" },
  "live-restore": true,
  "userland-proxy": false,
  "no-new-privileges": true
}
DAEMON
systemctl reload docker

# ── 3: AWS CLI ────────────────────────────────────────────────
section "AWS CLI Configuration"
if [[ -n "$AWS_ACCOUNT_ID" ]]; then
  # ECR login cron (token expires every 12h)
  cat > /etc/cron.d/ecr-login << CRON
0 */11 * * * ubuntu aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com 2>&1 | logger -t ecr-login
CRON
  sudo -u ubuntu aws ecr get-login-password --region "$AWS_REGION" \
    | docker login --username AWS --password-stdin \
      "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com" \
    || warn "ECR login failed — check IAM role attachment"
fi

# ── 4: Application directory structure ────────────────────────
section "Directory Setup"
mkdir -p "$APP_DIR"/{ssl,logs}
mkdir -p "$BACKUP_DIR"
chown -R ubuntu:ubuntu "$APP_DIR" "$BACKUP_DIR"

# ── 5: Docker Secrets provisioning ───────────────────────────
section "Docker Secrets Provisioning"

# The secrets directory must be owned by root and mode 700
# so only root (and Docker) can read the files.
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
chown root:root "$SECRETS_DIR"

provision_secret() {
  local name="$1"
  local value="$2"
  local path="$SECRETS_DIR/$name"
  # Write file as root, mode 400 (owner read-only)
  printf '%s' "$value" > "$path"
  chmod 400 "$path"
  chown root:root "$path"
  log "Secret provisioned: $name"
}

# Generate auto-derived secrets if they don't already exist
if [[ ! -f "$SECRETS_DIR/jwt_secret" ]]; then
  log "Generating cryptographic secrets..."

  JWT_SECRET=$(openssl rand -base64 64 | tr -d '\n')
  provision_secret "jwt_secret" "$JWT_SECRET"
  unset JWT_SECRET

  JWT_REFRESH=$(openssl rand -base64 64 | tr -d '\n')
  provision_secret "jwt_refresh_secret" "$JWT_REFRESH"
  unset JWT_REFRESH

  COOKIE=$(openssl rand -base64 48 | tr -d '\n')
  provision_secret "cookie_secret" "$COOKIE"
  unset COOKIE

  # Passwords: alphanumeric only (no shell-special chars for Redis compat)
  DB_PASS=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-32)
  provision_secret "postgres_password" "$DB_PASS"

  REDIS_PASS=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-32)
  provision_secret "redis_password" "$REDIS_PASS"

  # AES-256 encryption key: exactly 64 hex chars = 32 raw bytes
  ENC_KEY=$(openssl rand -hex 32)
  provision_secret "encryption_key" "$ENC_KEY"
  unset ENC_KEY

  # Generate Grafana password
  GRAFANA_PASS=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-24)
  provision_secret "grafana_password" "$GRAFANA_PASS"
  unset GRAFANA_PASS

  # Build connection URLs using generated passwords
  DB_HOST="${POSTGRES_HOST:-postgres}"
  DB_NAME="${POSTGRES_DB:-jobhunter}"
  DB_USER="${POSTGRES_USER:-jhuser}"
  provision_secret "db_url" "postgresql://${DB_USER}:${DB_PASS}@pgbouncer:5432/${DB_NAME}"
  provision_secret "redis_url" "redis://:${REDIS_PASS}@redis:6379"

  # Unset passwords — not needed after URL construction
  unset DB_PASS REDIS_PASS

  log "Auto-generated secrets written to $SECRETS_DIR"
else
  log "Secrets already exist — skipping auto-generation"
fi

# Ensure manually-supplied secrets have correct permissions
for secret_file in "$SECRETS_DIR"/*; do
  [[ -f "$secret_file" ]] || continue
  chmod 400 "$secret_file"
  chown root:root "$secret_file"
done

# Check which manual secrets still need filling in
NEEDS_INPUT=()
for name in anthropic_api_key gmail_client_secret \
            whatsapp_access_token whatsapp_app_secret whatsapp_verify_token \
            aws_secret_access_key; do
  if [[ ! -f "$SECRETS_DIR/$name" ]] || grep -q '^REPLACE_ME' "$SECRETS_DIR/$name" 2>/dev/null; then
    NEEDS_INPUT+=("$name")
  fi
done

if [[ ${#NEEDS_INPUT[@]} -gt 0 ]]; then
  warn "The following secrets need manual input before starting services:"
  for s in "${NEEDS_INPUT[@]}"; do
    warn "  → $SECRETS_DIR/$s"
  done
  warn "Use: echo 'your-value' | sudo tee $SECRETS_DIR/<name> && sudo chmod 400 $SECRETS_DIR/<name>"
fi

# ── 6: Firewall ───────────────────────────────────────────────
section "Firewall (UFW)"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
log "Firewall active"

# ── 7: Fail2ban ───────────────────────────────────────────────
section "Fail2ban"
cat > /etc/fail2ban/jail.local << 'FAIL2BAN'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5

[sshd]
enabled  = true
port     = ssh
maxretry = 3
bantime  = 86400
FAIL2BAN
systemctl enable --now fail2ban

# ── 8: SSL Certificates ───────────────────────────────────────
section "SSL Certificates (Let's Encrypt)"
if [[ -n "$DOMAIN" ]] && [[ -n "$EMAIL" ]]; then
  certbot certonly --standalone --non-interactive --agree-tos \
    --email "$EMAIL" \
    -d "$DOMAIN" -d "www.$DOMAIN" -d "api.$DOMAIN" \
    || warn "Certbot failed — ensure DNS A records point to this server"

  if [[ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
    mkdir -p "$APP_DIR/infrastructure/nginx/ssl"
    ln -sf "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" \
           "$APP_DIR/infrastructure/nginx/ssl/fullchain.pem"
    ln -sf "/etc/letsencrypt/live/$DOMAIN/privkey.pem" \
           "$APP_DIR/infrastructure/nginx/ssl/privkey.pem"
    log "SSL certs linked for $DOMAIN"
  fi

  # Auto-renewal cron
  echo "0 3 * * * root certbot renew --quiet \
    --post-hook 'docker exec jh-nginx nginx -s reload'" \
    > /etc/cron.d/certbot-renew
fi

# ── 9: Swap ───────────────────────────────────────────────────
section "Swap"
if [[ ! -f /swapfile ]]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl vm.swappiness=10
  echo 'vm.swappiness=10' >> /etc/sysctl.conf
  log "4GB swapfile created"
fi

# ── 10: Kernel tuning ─────────────────────────────────────────
section "Kernel Parameters"
cat >> /etc/sysctl.conf << 'SYSCTL'
net.core.somaxconn          = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_fin_timeout    = 30
fs.file-max                 = 2097152
SYSCTL
sysctl -p &>/dev/null

cat >> /etc/security/limits.conf << 'LIMITS'
ubuntu soft nofile 1048576
ubuntu hard nofile 1048576
root   soft nofile 1048576
root   hard nofile 1048576
LIMITS

# ── 11: Automated backups ─────────────────────────────────────
section "Database Backup"
cat > /opt/backup-db.sh << 'BACKUP'
#!/bin/bash
set -e
TS=$(date +%Y%m%d-%H%M%S)
OUT="/opt/backups/pg-$TS.sql.gz"
docker exec jh-postgres pg_dump -U "${POSTGRES_USER:-jhuser}" "${POSTGRES_DB:-jobhunter}" \
  | gzip > "$OUT"
aws s3 cp "$OUT" "s3://${AWS_S3_BUCKET:-jh-backups}/db/$TS.sql.gz" --storage-class STANDARD_IA
find /opt/backups -name "pg-*.sql.gz" -mtime +7 -delete
BACKUP
chmod +x /opt/backup-db.sh
echo "0 2 * * * ubuntu /opt/backup-db.sh >> /var/log/db-backup.log 2>&1" > /etc/cron.d/db-backup

# ── 12: Systemd service ───────────────────────────────────────
section "Systemd Service"
cat > /etc/systemd/system/job-hunter.service << 'SERVICE'
[Unit]
Description=Job Hunter AI Platform
Requires=docker.service
After=docker.service network-online.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/job-hunter-ai
User=ubuntu
Group=docker
ExecStart=/usr/bin/docker compose -f docker-compose.prod.yml up -d --remove-orphans
ExecStop=/usr/bin/docker compose -f docker-compose.prod.yml down
ExecReload=/usr/bin/docker compose -f docker-compose.prod.yml up -d --remove-orphans
TimeoutStartSec=300
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable job-hunter.service

# ── Done ──────────────────────────────────────────────────────
section "Bootstrap Complete"
echo ""
echo "  1. Clone:    git clone https://github.com/your-org/job-hunter-ai.git $APP_DIR"
echo "  2. Secrets:  fill in remaining secrets in $SECRETS_DIR"
echo "  3. Start:    systemctl start job-hunter"
echo ""
if [[ ${#NEEDS_INPUT[@]} -gt 0 ]]; then
  warn "Still waiting for ${#NEEDS_INPUT[@]} manual secrets — see above"
fi
log "Server ready"
