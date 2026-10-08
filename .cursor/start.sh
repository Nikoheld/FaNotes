#!/usr/bin/env bash
# Boots the FaNotes development services. Safe to run more than once:
# a service that is already listening is left alone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# fanotes-site refuses to start until clamd answers. policy-rc.d in this image
# blocks `service`/`systemctl`, so launch the daemon directly.
if ! /usr/bin/clamdscan --ping 1 >/dev/null 2>&1; then
  sudo mkdir -p /run/clamav
  sudo chown clamav:clamav /run/clamav
  if ! pidof clamd >/dev/null 2>&1; then
    sudo -u clamav /usr/sbin/clamd
  fi
  for _ in $(seq 1 60); do
    /usr/bin/clamdscan --ping 1 >/dev/null 2>&1 && break
    sleep 1
  done
  /usr/bin/clamdscan --ping 1 >/dev/null
fi

listening() {
  local port="$1"
  local hex
  hex="$(printf '%04X' "$port")"
  grep -q ":${hex} " /proc/net/tcp /proc/net/tcp6 2>/dev/null
}

ensure_session() {
  local name="$1"
  local port="$2"
  local command="$3"
  if listening "$port"; then
    echo "${name} already listening on ${port}"
    return 0
  fi
  if /usr/bin/tmux has-session -t "$name" 2>/dev/null; then
    /usr/bin/tmux kill-session -t "$name"
  fi
  /usr/bin/tmux new-session -d -s "$name" "bash -lc $(printf '%q' "$command") > /tmp/${name}.log 2>&1"
}

ensure_session glyphenwerk 5173 "cd $(printf '%q' "$ROOT") && npm run dev -- --host 0.0.0.0 --port 5173 --strictPort"
ensure_session fanotes-web 5174 "cd $(printf '%q' "$ROOT")/fanotes && npm run dev:web"
ensure_session fanotes-site 18185 "bash $(printf '%q' "$ROOT")/.cursor/run-site.sh"

wait_http() {
  local name="$1"
  local url="$2"
  for _ in $(seq 1 90); do
    if curl -fs -o /dev/null --max-time 2 "$url"; then
      echo "${name} ready: ${url}"
      return 0
    fi
    sleep 2
  done
  echo "${name} did not become ready: ${url}" >&2
  echo "--- /tmp/${name}.log ---" >&2
  tail -n 80 "/tmp/${name}.log" >&2 || true
  return 1
}

wait_http glyphenwerk "http://127.0.0.1:5173/"
wait_http fanotes-web "http://127.0.0.1:5174/"
wait_http fanotes-site "http://127.0.0.1:18185/"
