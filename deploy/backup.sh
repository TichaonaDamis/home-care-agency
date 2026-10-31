#!/usr/bin/env bash
# Nightly CareHours backup: consistent SQLite copy + integrity check, keeps 14 days locally.
# Optional off-site copy: set OFFSITE in /etc/default/carehours-backup, e.g.
#   OFFSITE="gs://your-bucket/carehours"          (Google Cloud Storage, needs gcloud CLI)
#   OFFSITE="s3://your-space/carehours"            (DigitalOcean Spaces, needs s3cmd configured)
set -euo pipefail
[[ -f /etc/default/carehours-backup ]] && source /etc/default/carehours-backup
BACKUP_DIR=/var/backups/carehours
cd /opt/carehours
DATABASE_FILE=/var/lib/carehours/carehours.sqlite node --disable-warning=ExperimentalWarning server/cli.js backup "$BACKUP_DIR"
find "$BACKUP_DIR" -name 'carehours-*.sqlite' -mtime +14 -delete
LATEST=$(ls -t "$BACKUP_DIR"/carehours-*.sqlite | head -1)
if [[ -n "${OFFSITE:-}" ]]; then
  case "$OFFSITE" in
    gs://*) gcloud storage cp "$LATEST" "$OFFSITE/" ;;
    s3://*) s3cmd put "$LATEST" "$OFFSITE/" ;;
    *) echo "Unknown OFFSITE target: $OFFSITE" >&2; exit 1 ;;
  esac
fi
echo "Backup complete: $LATEST"
