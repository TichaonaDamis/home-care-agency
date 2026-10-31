#!/usr/bin/env bash
# CareHours server setup for Ubuntu 22.04 / 24.04 (DigitalOcean Droplet or Google Compute Engine VM).
# Usage (as a sudo-capable user):  sudo bash setup-ubuntu.sh your-domain.example.com
# Installs Node.js 22, Caddy (automatic HTTPS), the CareHours service, a firewall and nightly backups.
set -euo pipefail

DOMAIN="${1:-}"
REPO="${REPO:-https://github.com/TichaonaDamis/home-care-agency.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/carehours
DATA_DIR=/var/lib/carehours
BACKUP_DIR=/var/backups/carehours

if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi
if [[ -z "$DOMAIN" ]]; then echo "Usage: sudo bash setup-ubuntu.sh your-domain.example.com" >&2; exit 1; fi

echo "==> System updates and base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git ufw unattended-upgrades debian-keyring debian-archive-keyring apt-transport-https gnupg
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<13)) { console.error("Node 22.13+ required, found "+process.versions.node); process.exit(1); }'

echo "==> Caddy (HTTPS reverse proxy)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> App user and folders"
id carehours >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin carehours
mkdir -p "$DATA_DIR" "$BACKUP_DIR"
chown carehours:carehours "$DATA_DIR" "$BACKUP_DIR"
chmod 700 "$DATA_DIR" "$BACKUP_DIR"

echo "==> Application code"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch origin "$BRANCH" && git -C "$APP_DIR" checkout -q "$BRANCH" && git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  git clone --branch "$BRANCH" --depth 1 "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev
chown -R root:root "$APP_DIR"

echo "==> Service, HTTPS and backups"
install -m 644 deploy/carehours.service /etc/systemd/system/carehours.service
install -m 644 deploy/carehours-backup.service /etc/systemd/system/carehours-backup.service
install -m 644 deploy/carehours-backup.timer /etc/systemd/system/carehours-backup.timer
install -m 755 deploy/backup.sh /usr/local/bin/carehours-backup
sed "s/YOUR_DOMAIN/$DOMAIN/" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now carehours
systemctl enable --now carehours-backup.timer
systemctl reload caddy || systemctl restart caddy

echo "==> Firewall"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

sleep 3
echo
echo "CareHours is running at https://$DOMAIN (HTTPS is issued automatically once DNS points here)."
echo "First administrator login (shown only on first start):"
journalctl -u carehours --no-pager | grep -A3 "First run" || echo "  (admin already existed — use your existing password)"
