#!/usr/bin/env bash
# Usage: cargo-in-container.sh <worktree> <target-name> <command...>
# Runs a command (e.g. "cargo check -p fanotes-tauri") in the Linux build
# image as the calling user, with the worktree at /work and a per-package
# target dir. The host cargo registry is shared read-write.
# FANOTES_TAURI_IMAGE picks the image (default fanotes-tauri-build:1).
set -euo pipefail
worktree="$(realpath "$1")"; target="$2"; shift 2
image="${FANOTES_TAURI_IMAGE:-fanotes-tauri-build:1}"
cache="/srv/agents/fanotes/.cargo-target/container-$target"
mkdir -p "$cache" "$cache-npm" "$HOME/.cargo/registry" "$HOME/.cargo/git"
exec sudo docker run --rm --init -u "$(id -u):$(id -g)" \
  --cpus=2 --memory=6g \
  -e HOME=/tmp -e CARGO_HOME=/cargo-home -e CARGO_TARGET_DIR=/target -e CARGO_BUILD_JOBS=2 -e CARGO_PROFILE_DEV_DEBUG=line-tables-only \
  -e npm_config_cache=/npm-cache -e FANOTES_SMOKE_TEST -e FANOTES_SMOKE_TIMEOUT_SECS \
  -v "$HOME/.cargo/registry:/cargo-home/registry" -v "$HOME/.cargo/git:/cargo-home/git" \
  -v "$cache:/target" -v "$cache-npm:/npm-cache" \
  -v "$worktree:/work" -w /work \
  "$image" "$@"
