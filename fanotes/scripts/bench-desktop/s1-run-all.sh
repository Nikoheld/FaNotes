#!/usr/bin/env bash
# Spike S1: the three runtimes back to back, same image, same Xvfb, same vault.
#   scripts/bench-desktop/s1-run-all.sh <fixture-dir> [runs] [hosts...]
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
fixture="$1"; runs="${2:-3}"; shift 2 || true
hosts=("${@:-electron cef tauri}")
targets=/srv/agents/fanotes/.cargo-target
for host in ${hosts[@]}; do
  case "$host" in
    electron) export FANOTES_BENCH_TARGET="$targets/container-w1b-cef"; app=/work/fanotes/release/linux-unpacked/fanotes ;;
    cef)      export FANOTES_BENCH_TARGET="$targets/container-w1b-cef"; app=/target/release/fanotes-tauri-cef ;;
    tauri)    export FANOTES_BENCH_TARGET="$targets/container-w1b-tauri2"; app=/target/release/fanotes-tauri ;;
  esac
  "$here/run-in-container.sh" --image fanotes-bench-trixie:1 -- \
    node run.mjs --host "$host" --app "$app" --fixture "$fixture" --runs "$runs" --out "results/s1-$host-markdown.json" \
    2>&1 | grep --line-buffered -E "^\[$host"
done
