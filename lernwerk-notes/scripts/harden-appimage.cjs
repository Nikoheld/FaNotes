'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { Arch } = require('builder-util')
const { getAppImageTools } = require('app-builder-lib/out/toolsets/linux')

const appImagePath = path.resolve(process.argv[2] ?? '')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const details = options.capture ? `\n${result.stderr || result.stdout}` : ''
    throw new Error(`${path.basename(command)} wurde mit Status ${result.status} beendet.${details}`)
  }
  return (result.stdout ?? '').trim()
}

async function main() {
  if (!appImagePath || !fs.existsSync(appImagePath)) {
    throw new Error('Aufruf: node scripts/harden-appimage.cjs <AppImage>')
  }

  const offsetText = run(appImagePath, ['--appimage-offset'], { capture: true })
  const offset = Number.parseInt(offsetText, 10)
  if (!Number.isSafeInteger(offset) || offset < 4096 || offset > 8 * 1024 * 1024) {
    throw new Error(`Ungültiger AppImage-Offset: ${offsetText}`)
  }

  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-appimage-'))
  const outputPath = `${appImagePath}.hardened`
  try {
    run(appImagePath, ['--appimage-extract'], { cwd: temporaryRoot, capture: true })
    const appDir = path.join(temporaryRoot, 'squashfs-root')
    const launcherPath = path.join(appDir, 'AppRun')
    const desktopPath = path.join(appDir, 'fanotes.desktop')
    const binaryPath = path.join(appDir, 'fanotes')
    if (!fs.existsSync(launcherPath) || !fs.existsSync(desktopPath) || !fs.existsSync(binaryPath)) {
      throw new Error('Das extrahierte AppImage besitzt nicht die erwartete FaNotes-Struktur.')
    }

    const launcher = `#!/usr/bin/env bash
set -euo pipefail

if [[ -z "\${APPDIR:-}" ]]; then
  APPDIR="$(dirname "$(readlink -f "$0")")"
fi

export PATH="\${APPDIR}:\${APPDIR}/usr/sbin\${PATH:+:\${PATH}}"
export XDG_DATA_DIRS="\${APPDIR}/usr/share\${XDG_DATA_DIRS:+:\${XDG_DATA_DIRS}}:/usr/share/gnome:/usr/local/share:/usr/share"
export LD_LIBRARY_PATH="\${APPDIR}/usr/lib\${LD_LIBRARY_PATH:+:\${LD_LIBRARY_PATH}}"
export GSETTINGS_SCHEMA_DIR="\${APPDIR}/usr/share/glib-2.0/schemas\${GSETTINGS_SCHEMA_DIR:+:\${GSETTINGS_SCHEMA_DIR}}"

# Sicherheit ist eine harte Anforderung: die Chromium-Sandbox bleibt aktiv.
exec "\${APPDIR}/fanotes" "$@"
`
    await fsp.writeFile(launcherPath, launcher, { mode: 0o755 })
    await fsp.chmod(launcherPath, 0o755)

    const desktop = await fsp.readFile(desktopPath, 'utf8')
    const hardenedDesktop = desktop
      .replace(/^Exec=.*$/m, 'Exec=AppRun %U')
      .replace(/^StartupWMClass=.*$/m, 'StartupWMClass=fanotes')
    if (/(?:^|\s)--no-sandbox(?:\s|$)/m.test(hardenedDesktop)) {
      throw new Error('Die Desktop-Datei enthält weiterhin --no-sandbox.')
    }
    await fsp.writeFile(desktopPath, hardenedDesktop, { mode: 0o644 })
    await fsp.chmod(desktopPath, 0o644)

    // Preserve the original type-2 AppImage runtime/header, then rebuild only
    // its SquashFS payload with deterministic root ownership. Gzip is
    // intentional: XZ makes fallback extraction on systems without FUSE burn
    // an entire CPU core for many seconds on every launch. Unused Chromium
    // locales are removed by electron-builder before this step, reducing both
    // the compressed payload and the amount of data extracted at startup.
    const sourceHandle = await fsp.open(appImagePath, 'r')
    const runtime = Buffer.alloc(offset)
    try {
      const { bytesRead } = await sourceHandle.read(runtime, 0, offset, 0)
      if (bytesRead !== offset) throw new Error('Der AppImage-Runtime-Header ist unvollständig.')
    } finally {
      await sourceHandle.close()
    }

    const { mksquashfs } = await getAppImageTools('0.0.0', Arch.x64)
    await fsp.rm(outputPath, { force: true })
    run(mksquashfs, [
      appDir,
      outputPath,
      '-offset', String(offset),
      '-all-root',
      '-noappend',
      '-no-progress',
      '-quiet',
      '-no-xattrs',
      '-no-fragments',
      '-comp', 'gzip',
    ])
    const outputHandle = await fsp.open(outputPath, 'r+')
    try {
      await outputHandle.write(runtime, 0, runtime.length, 0)
      await outputHandle.sync()
    } finally {
      await outputHandle.close()
    }
    await fsp.chmod(outputPath, 0o755)

    const verifyRoot = path.join(temporaryRoot, 'verify')
    await fsp.mkdir(verifyRoot)
    run(outputPath, ['--appimage-extract'], { cwd: verifyRoot, capture: true })
    const verifiedLauncher = await fsp.readFile(path.join(verifyRoot, 'squashfs-root', 'AppRun'), 'utf8')
    const verifiedDesktop = await fsp.readFile(path.join(verifyRoot, 'squashfs-root', 'fanotes.desktop'), 'utf8')
    if (verifiedLauncher.includes('NO_SANDBOX') || verifiedLauncher.includes('(--no-sandbox)') || /Exec=.*--no-sandbox/m.test(verifiedDesktop)) {
      throw new Error('Die Sandbox-Härtung konnte im fertigen AppImage nicht bestätigt werden.')
    }

    await fsp.rename(outputPath, appImagePath)
    process.stdout.write(`Sandbox-gehärtet: ${appImagePath}\n`)
  } finally {
    await fsp.rm(outputPath, { force: true }).catch(() => {})
    await fsp.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
