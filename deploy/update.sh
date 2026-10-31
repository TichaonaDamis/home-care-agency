#!/usr/bin/env bash
# Update CareHours to the latest code on main: backup first, then pull, install and restart.
set -euo pipefail
sudo -u carehours /usr/local/bin/carehours-backup
cd /opt/carehours
sudo git fetch origin main && sudo git reset --hard origin/main
sudo npm ci --omit=dev
sudo systemctl restart carehours
sleep 2 && systemctl --no-pager status carehours | head -5
