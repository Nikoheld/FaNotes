#!/usr/bin/env bash
# Runs a bench-desktop command inside fanotes-bench:1 with Xvfb (1440x900x24).
# Both hosts run in this same container and display.
#
#   scripts/bench-desktop/run-in-container.sh [--cpus 4] [--image fanotes-bench-cef:1] [--gpu 0]
#                                             [--mount <dir>]... -- <command...>
#
# --gpu <n> passes NVIDIA GPU <n> into the container (CDI, nvidia.com/gpu=<n>).
#
# Mounts: the repository at /work (read-write: results/ is written there), the
# Tauri target dir at /target (read-only), $TMPDIR at the same path. Extra
# --mount dirs are mounted read-only at the same path. Runs as the calling user.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
cpus=4
memory=6g
mounts=()
image=fanotes-bench:1
gpu=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --cpus) cpus="$2"; shift 2 ;;
    --memory) memory="$2"; shift 2 ;;
    --mount) mounts+=(-v "$2:$2:ro"); shift 2 ;;
    --image) image="$2"; shift 2 ;;
    --gpu) gpu=(--device "nvidia.com/gpu=$2" -e NVIDIA_DRIVER_CAPABILITIES=all); shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
tmp="${TMPDIR:-/srv/agents/fanotes/.site-redesign-tools/tmp}"
target="${FANOTES_BENCH_TARGET:-/srv/agents/fanotes/.cargo-target/container-benchmarks}"
mkdir -p "$tmp"
exec sudo docker run --rm --init -u "$(id -u):$(id -g)" \
  --cpus="$cpus" --memory="$memory" --shm-size=2g \
  -e HOME=/tmp -e TMPDIR="$tmp" -e DISPLAY=:99 \
  -v "$repo:/work" -v "$target:/target:ro" -v "$tmp:$tmp" "${mounts[@]}" "${gpu[@]}" \
  -w /work/fanotes/scripts/bench-desktop \
  "$image" bash -c '
    Xvfb :99 -screen 0 1440x900x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
    for i in $(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
    exec "$@"' bash "$@"
