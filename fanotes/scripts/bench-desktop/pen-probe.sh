#!/usr/bin/env bash
# Spike S1 pen probe in fanotes-bench-pen:1. Root and --privileged because it
# creates a uinput device and runs a real Xorg; the virtual tablet is destroyed
# when the probe exits.
#
#   scripts/bench-desktop/pen-probe.sh --host electron --app /work/fanotes/release/linux-unpacked/fanotes --out results/pen-electron.json
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
target="${FANOTES_BENCH_TARGET:-/srv/agents/fanotes/.cargo-target/container-w1b-cef}"
exec sudo docker run --rm --init --privileged --shm-size=2g \
  -e HOME=/tmp -v "$repo:/work" -v "$target:/target:ro" \
  -w /work/fanotes/scripts/bench-desktop \
  fanotes-bench-pen:1 node pen-probe.mjs "$@"
