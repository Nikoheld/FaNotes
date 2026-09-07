#!/usr/bin/env bash
# Launches the FaNotes website / API service (fanotes-site) for local development.
# Production reads fixed system paths (/var/lib, /etc, /mnt); this script points
# every path at a writable per-user data directory and mints a throwaway backup
# enrollment code so the hardened server can start without production secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${FANOTES_SITE_DATA:-$HOME/.fanotes-site-data}"
mkdir -p "${DATA}/analytics" "${DATA}/release" "${DATA}/backups"

TOKEN_FILE="${DATA}/backup-enrollment-token"
if [ ! -s "${TOKEN_FILE}" ]; then
  # Local-only dev enrollment code (never a real secret).
  head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 48 > "${TOKEN_FILE}"
fi

cd "${ROOT}/fanotes-site"
exec env \
  FANOTES_PORT="${FANOTES_PORT:-18185}" \
  FANOTES_ANALYTICS_DIR="${DATA}/analytics" \
  FANOTES_RELEASE_DIR="${DATA}/release" \
  FANOTES_BACKUP_DIR="${DATA}/backups" \
  FANOTES_BACKUP_ENROLLMENT_TOKEN_PATH="${TOKEN_FILE}" \
  node server.mjs
