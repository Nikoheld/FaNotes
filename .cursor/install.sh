#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for the FaNotes monorepo.
# Prepares system tools, then installs and builds the three projects:
#   /            GlyphenWerk (Vite + React), builds dist/ embedded by the web app
#   fanotes/     FaNotes React/Electron/Web app
#   fanotes-site/ Product website, update API, AI proxy and backup service (Node only)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGEMAGICK_VERSION="7.1.2-31"
IMAGEMAGICK_URL="https://github.com/ImageMagick/ImageMagick/releases/download/${IMAGEMAGICK_VERSION}/ImageMagick-${IMAGEMAGICK_VERSION}-gcc-x86_64.AppImage"

# --- System packages required by fanotes-site's backup security pipeline ---
# qpdf + clamdscan (ClamAV) are checked at server start; magick (ImageMagick 7)
# rebuilds uploaded images. Ubuntu ships ImageMagick 6 (convert only), so the
# ImageMagick 7 `magick` binary is staged separately below.
if ! command -v qpdf >/dev/null 2>&1 || ! command -v clamdscan >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq qpdf clamav clamav-daemon
fi

# Several repository check scripts spawn a browser at the hard-coded path
# /usr/bin/chromium. Point it at the image's installed Chrome when missing.
if [ ! -e /usr/bin/chromium ]; then
  CHROME_BIN="$(command -v google-chrome-stable || command -v google-chrome || true)"
  if [ -n "${CHROME_BIN}" ]; then
    sudo ln -sf "${CHROME_BIN}" /usr/bin/chromium
  fi
fi

# ImageMagick 7 (provides the `magick` dispatcher fanotes-site invokes).
if [ ! -x /opt/imagemagick7/AppRun ]; then
  TMP_IM="$(mktemp -d)"
  curl -fsSL -o "${TMP_IM}/magick.AppImage" "${IMAGEMAGICK_URL}"
  chmod +x "${TMP_IM}/magick.AppImage"
  ( cd "${TMP_IM}" && ./magick.AppImage --appimage-extract >/dev/null )
  sudo rm -rf /opt/imagemagick7
  sudo mv "${TMP_IM}/squashfs-root" /opt/imagemagick7
  rm -rf "${TMP_IM}"
fi
sudo ln -sf /opt/imagemagick7/AppRun /usr/bin/magick

# --- JavaScript dependencies and generated state ---
# Root GlyphenWerk deps, then build dist/. The FaNotes web dev server embeds
# this build via `build:glyphenwerk`, so it must exist before `dev:web` runs.
npm ci
npm run build

# FaNotes app dependencies.
( cd fanotes && npm ci )

echo "FaNotes environment ready: GlyphenWerk, FaNotes app and site dependencies installed."
