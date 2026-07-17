'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { DELTA_FORMAT, applyDeltaPatch } = require('./delta.cjs')

const UPDATE_ORIGIN = 'https://fanotes.fasrv.ch'
const PLATFORM_RELEASES = Object.freeze({
  linux: Object.freeze({
    api: `${UPDATE_ORIGIN}/api/v1/updates/linux-x64`,
    manifestPlatform: 'linux',
    userAgentPlatform: 'Linux',
    installationKind: 'managed-appimage',
    primaryPackage: 'appimage',
    deltaPath: (version, channel = 'stable') => channel === 'beta' ? `/download/delta/linux-x64/beta/${version}` : `/download/delta/linux-x64/${version}`,
    accept: 'application/vnd.appimage, application/octet-stream;q=0.9',
    packages: Object.freeze({
      appimage: Object.freeze({ label: 'AppImage', fileName: (version) => `FaNotes-${version}-x86_64.AppImage`, pathname: (channel) => channel === 'beta' ? '/download/beta/appimage' : '/download/appimage' }),
      portable: Object.freeze({ label: 'Portable', fileName: (version) => `FaNotes-${version}-x86_64.tar.gz`, pathname: (channel) => channel === 'beta' ? '/download/beta/portable' : '/download/portable' }),
    }),
  }),
  win32: Object.freeze({
    api: `${UPDATE_ORIGIN}/api/v1/updates/windows-x64`,
    manifestPlatform: 'windows',
    userAgentPlatform: 'Windows',
    installationKind: 'windows-installer',
    primaryPackage: 'installer',
    deltaPath: (version, channel = 'stable') => channel === 'beta' ? `/download/delta/windows-x64/beta/${version}` : `/download/delta/windows-x64/${version}`,
    accept: 'application/vnd.microsoft.portable-executable, application/octet-stream;q=0.9',
    packages: Object.freeze({
      installer: Object.freeze({ label: 'Windows-Installer', fileName: (version) => `FaNotes-Setup-${version}-x64.exe`, pathname: (channel) => channel === 'beta' ? '/download/beta/windows-installer' : '/download/windows-installer' }),
      portable: Object.freeze({ label: 'Windows Portable', fileName: (version) => `FaNotes-Portable-${version}-x64.exe`, pathname: (channel) => channel === 'beta' ? '/download/beta/windows-portable' : '/download/windows-portable' }),
    }),
  }),
})
const UPDATE_API = PLATFORM_RELEASES.linux.api
const UPDATE_EVENT = 'lernwerk:update-state'
const EXPECTED_KEY_ID = '33006e5c06939bc9'
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const MAX_MANIFEST_BYTES = 512 * 1024
const MIN_PACKAGE_BYTES = 10 * 1024 * 1024
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const INITIAL_CHECK_DELAY_MS = 12_000
const DOWNLOAD_TIMEOUT_MS = 45 * 60 * 1000
const WINDOWS_INSTALLER_ARGS = Object.freeze(['/S', '--updated', '--force-run'])

const WINDOWS_DELTA_HELPER = `param(
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$Staged,
  [Parameter(Mandatory=$true)][string]$ExpectedSha,
  [Parameter(Mandatory=$true)][string]$FromVersion,
  [Parameter(Mandatory=$true)][string]$ToVersion,
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$LogFile,
  [Parameter(Mandatory=$true)][string]$MarkerFile
)

$ErrorActionPreference = 'Stop'

function Write-Log([string]$Message) {
  Add-Content -LiteralPath $LogFile -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

function File-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$temporary = "$Target.fanotes-new"
$backup = "$Target.fanotes-backup"

try {
  Write-Log "FaNotes delta update helper started"
  $deadline = (Get-Date).AddSeconds(120)
  while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $deadline) { throw 'FaNotes did not stop within 120 seconds.' }
    Start-Sleep -Milliseconds 200
  }
  if (-not (Test-Path -LiteralPath $Staged -PathType Leaf)) { throw 'The staged app.asar is missing.' }
  if ((File-Sha256 $Staged) -ne $ExpectedSha) { throw 'The staged app.asar checksum is invalid.' }

  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $Staged -Destination $temporary -Force
  if ((File-Sha256 $temporary) -ne $ExpectedSha) { throw 'The copied app.asar checksum is invalid.' }
  Move-Item -LiteralPath $Target -Destination $backup -Force
  try {
    Move-Item -LiteralPath $temporary -Destination $Target -Force
  } catch {
    Move-Item -LiteralPath $backup -Destination $Target -Force
    throw
  }

  $child = Start-Process -FilePath $Executable -ArgumentList "--fanotes-updated-from=$FromVersion" -PassThru
  Start-Sleep -Seconds 8
  if (-not $child.HasExited) {
    Remove-Item -LiteralPath $backup,$Staged -Force -ErrorAction SilentlyContinue
    $marker = @{ version = $ToVersion; installedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
    Set-Content -LiteralPath $MarkerFile -Value $marker -Encoding UTF8
    Write-Log "delta update to $ToVersion installed successfully"
    exit 0
  }

  Write-Log "updated application exited during health window; rolling back"
  Remove-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $backup -Destination $Target -Force
  Start-Process -FilePath $Executable -ArgumentList "--fanotes-update-rollback=$ToVersion"
  exit 18
} catch {
  Write-Log "delta update failed: $($_.Exception.Message)"
  if (Test-Path -LiteralPath $backup -PathType Leaf) {
    Remove-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $backup -Destination $Target -Force
    Start-Process -FilePath $Executable -ArgumentList "--fanotes-update-rollback=$ToVersion" -ErrorAction SilentlyContinue
    Write-Log "previous app.asar restored after helper failure"
  }
  exit 19
}
`

const INSTALL_HELPER = `#!/bin/sh
set -eu

parent_pid="$1"
target="$2"
staged="$3"
expected_sha="$4"
from_version="$5"
to_version="$6"
log_file="$7"
marker_file="$8"

exec >>"$log_file" 2>&1
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) FaNotes update helper started"

case "$parent_pid" in *[!0-9]*|'') echo "invalid parent pid"; exit 10;; esac
case "$expected_sha" in *[!0-9a-f]*|'') echo "invalid checksum"; exit 11;; esac

wait_count=0
while kill -0 "$parent_pid" 2>/dev/null; do
  wait_count=$((wait_count + 1))
  if [ "$wait_count" -gt 600 ]; then
    echo "application did not stop within 120 seconds"
    exit 12
  fi
  sleep 0.2
done

if [ ! -f "$staged" ] || [ -L "$staged" ]; then
  echo "staged AppImage is missing or unsafe"
  exit 13
fi

actual_sha="$(sha256sum -- "$staged" | awk '{print $1}')"
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "staged AppImage checksum mismatch"
  exit 14
fi

target_dir="$(dirname -- "$target")"
mkdir -p -- "$target_dir"
if [ -L "$target" ]; then
  echo "refusing to replace a symbolic link"
  exit 15
fi

temporary="\${target}.fanotes-new.$$"
backup="\${target}.fanotes-backup"
rm -f -- "$temporary"
cp -- "$staged" "$temporary"
chmod 0755 "$temporary"

copied_sha="$(sha256sum -- "$temporary" | awk '{print $1}')"
if [ "$copied_sha" != "$expected_sha" ]; then
  rm -f -- "$temporary"
  echo "copied AppImage checksum mismatch"
  exit 16
fi

had_previous=0
rm -f -- "$backup"
if [ -e "$target" ]; then
  mv -- "$target" "$backup"
  had_previous=1
fi

if ! mv -- "$temporary" "$target"; then
  if [ "$had_previous" -eq 1 ]; then mv -- "$backup" "$target"; fi
  echo "atomic replacement failed"
  exit 17
fi

"$target" --fanotes-updated-from="$from_version" >/dev/null 2>&1 &
new_pid=$!
sleep 8

if kill -0 "$new_pid" 2>/dev/null; then
  rm -f -- "$backup" "$staged"
  marker_tmp="\${marker_file}.tmp.$$"
  printf '{"version":"%s","installedAt":"%s"}\n' "$to_version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$marker_tmp"
  mv -- "$marker_tmp" "$marker_file"
  echo "update to $to_version installed successfully"
  exit 0
fi

echo "updated application exited during health window; rolling back"
rm -f -- "$target"
if [ "$had_previous" -eq 1 ] && [ -f "$backup" ]; then
  mv -- "$backup" "$target"
  "$target" --fanotes-update-rollback="$to_version" >/dev/null 2>&1 &
fi
exit 18
`

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

const parseVersion = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/u.exec(value)
  if (!match) throw new Error('Ungültige Versionsnummer.')
  return {
    numbers: match.slice(1, 4).map(Number),
    beta: match[4] === undefined ? null : Number(match[4]),
  }
}

const compareVersions = (left, right) => {
  if (!VERSION_PATTERN.test(left) || !VERSION_PATTERN.test(right)) throw new Error('Ungültige Versionsnummer.')
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index]
  }
  if (a.beta === b.beta) return 0
  if (a.beta === null) return 1
  if (b.beta === null) return -1
  return a.beta - b.beta
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const strictBase64 = (value) => {
  if (typeof value !== 'string' || value.length < 64 || value.length > 256 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return null
  const decoded = Buffer.from(value, 'base64')
  return decoded.toString('base64') === value ? decoded : null
}

const validatePackage = (candidate, version, kind, platformConfig, channel) => {
  const descriptor = platformConfig?.packages?.[kind]
  if (!descriptor) throw new Error('Das Update-Manifest enthält einen unbekannten Pakettyp.')
  if (!isPlainObject(candidate)) throw new Error(`Das ${descriptor.label}-Paket fehlt im Update-Manifest.`)
  const expectedName = descriptor.fileName(version)
  if (candidate.fileName !== expectedName) throw new Error(`Der ${descriptor.label}-Dateiname ist ungültig.`)
  if (!Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes < MIN_PACKAGE_BYTES || candidate.sizeBytes > MAX_PACKAGE_BYTES) {
    throw new Error(`Die ${descriptor.label}-Dateigröße ist ungültig.`)
  }
  if (typeof candidate.sha256 !== 'string' || !SHA256_PATTERN.test(candidate.sha256)) {
    throw new Error(`Die ${descriptor.label}-Prüfsumme ist ungültig.`)
  }
  let parsedUrl
  try {
    parsedUrl = new URL(candidate.url)
  } catch {
    throw new Error(`Die ${descriptor.label}-Downloadadresse ist ungültig.`)
  }
  if (
    parsedUrl.origin !== UPDATE_ORIGIN || parsedUrl.pathname !== descriptor.pathname(channel) ||
    parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash
  ) {
    throw new Error(`Die ${descriptor.label}-Downloadadresse ist nicht vertrauenswürdig.`)
  }
  return {
    fileName: candidate.fileName,
    sizeBytes: candidate.sizeBytes,
    sha256: candidate.sha256,
    url: parsedUrl.href,
  }
}

const validateDeltaFile = (candidate, label, expectedKind) => {
  if (!isPlainObject(candidate) || candidate.kind !== expectedKind) throw new Error(`Die ${label}-Beschreibung des Delta-Updates ist ungültig.`)
  if (!Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes <= 0 || candidate.sizeBytes > MAX_PACKAGE_BYTES) throw new Error(`Die ${label}-Größe des Delta-Updates ist ungültig.`)
  if (typeof candidate.sha256 !== 'string' || !SHA256_PATTERN.test(candidate.sha256)) throw new Error(`Die ${label}-Prüfsumme des Delta-Updates ist ungültig.`)
  return {
    kind: candidate.kind,
    sizeBytes: candidate.sizeBytes,
    sha256: candidate.sha256,
    ...(label === 'Zieldatei' ? { fileName: candidate.fileName } : {}),
  }
}

const validateDelta = (candidate, payload, platformConfig, packages) => {
  if (candidate == null) return null
  if (!isPlainObject(candidate) || candidate.format !== DELTA_FORMAT) throw new Error('Das Update-Manifest enthält ein unbekanntes Delta-Format.')
  const expectedFileName = `FaNotes-Delta-${payload.platform}-x64-${payload.currentVersion}-to-${payload.latestVersion}.fndelta`
  if (candidate.fileName !== expectedFileName) throw new Error('Der Dateiname des Delta-Updates ist ungültig.')
  if (!Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes < 256 || candidate.sizeBytes > MAX_PACKAGE_BYTES) throw new Error('Die Größe des Delta-Updates ist ungültig.')
  if (typeof candidate.sha256 !== 'string' || !SHA256_PATTERN.test(candidate.sha256)) throw new Error('Die Prüfsumme des Delta-Updates ist ungültig.')
  let parsedUrl
  try {
    parsedUrl = new URL(candidate.url)
  } catch {
    throw new Error('Die Adresse des Delta-Updates ist ungültig.')
  }
  if (parsedUrl.origin !== UPDATE_ORIGIN || parsedUrl.pathname !== platformConfig.deltaPath(payload.currentVersion, payload.channel) || parsedUrl.search || parsedUrl.hash || parsedUrl.username || parsedUrl.password) {
    throw new Error('Die Adresse des Delta-Updates ist nicht vertrauenswürdig.')
  }
  const expectedKind = payload.platform === 'linux' ? 'appimage' : 'app-asar'
  const source = validateDeltaFile(candidate.source, 'Quelldatei', expectedKind)
  const target = validateDeltaFile(candidate.target, 'Zieldatei', expectedKind)
  const expectedTargetName = payload.platform === 'linux' ? packages.appimage.fileName : 'app.asar'
  if (target.fileName !== expectedTargetName) throw new Error('Die Zieldatei des Delta-Updates ist ungültig.')
  if (payload.platform === 'linux' && (target.sizeBytes !== packages.appimage.sizeBytes || target.sha256 !== packages.appimage.sha256)) {
    throw new Error('Das Delta-Ziel stimmt nicht mit dem signierten AppImage überein.')
  }
  return {
    format: DELTA_FORMAT,
    fileName: candidate.fileName,
    sizeBytes: candidate.sizeBytes,
    sha256: candidate.sha256,
    url: parsedUrl.href,
    source,
    target,
  }
}

const verifyManifest = (candidate, currentVersion, publicKeyPem, targetPlatform = process.platform, expectedKeyId = EXPECTED_KEY_ID, expectedChannel = 'stable') => {
  const platformConfig = PLATFORM_RELEASES[targetPlatform]
  if (!platformConfig) throw new Error('Automatische Updates werden auf dieser Plattform nicht unterstützt.')
  if (!isPlainObject(candidate) || !isPlainObject(candidate.signature)) throw new Error('Das Update-Manifest ist ungültig.')
  const signature = candidate.signature
  if (signature.algorithm !== 'ed25519' || signature.keyId !== expectedKeyId) {
    throw new Error('Das Update-Manifest wurde mit einem unbekannten Schlüssel signiert.')
  }
  const signatureBytes = strictBase64(signature.value)
  if (!signatureBytes) throw new Error('Die Signatur des Update-Manifests ist ungültig.')
  const payload = { ...candidate }
  delete payload.signature
  let verified = false
  try {
    verified = crypto.verify(null, Buffer.from(stableStringify(payload)), publicKeyPem, signatureBytes)
  } catch {
    verified = false
  }
  if (!verified) throw new Error('Die kryptografische Signatur des Updates ist ungültig.')

  if (
    payload.schemaVersion !== 1 || payload.product !== 'FaNotes' || payload.channel !== expectedChannel || !['stable', 'beta'].includes(payload.channel) ||
    payload.platform !== platformConfig.manifestPlatform || payload.arch !== 'x64'
  ) throw new Error('Das Update-Manifest ist nicht für diese FaNotes-Ausgabe bestimmt.')
  if (payload.currentVersion !== currentVersion) throw new Error('Das Update-Manifest gehört zu einer anderen installierten Version.')
  if (typeof payload.latestVersion !== 'string' || !VERSION_PATTERN.test(payload.latestVersion)) throw new Error('Die angebotene Version ist ungültig.')
  const updateAvailable = compareVersions(payload.latestVersion, currentVersion) > 0
  if (payload.updateAvailable !== updateAvailable || typeof payload.mandatory !== 'boolean') throw new Error('Der Update-Status im Manifest ist widersprüchlich.')
  if (typeof payload.publishedAt !== 'string' || !Number.isFinite(Date.parse(payload.publishedAt))) throw new Error('Das Veröffentlichungsdatum ist ungültig.')
  if (!Array.isArray(payload.releaseNotes) || payload.releaseNotes.length > 20 || payload.releaseNotes.some((note) => typeof note !== 'string' || note.length > 4000)) {
    throw new Error('Die Release Notes sind ungültig.')
  }
  if (!isPlainObject(payload.packages)) throw new Error('Das Update enthält keine Pakete.')
  const packages = Object.fromEntries(Object.keys(platformConfig.packages).map((kind) => [
    kind,
    validatePackage(payload.packages[kind], payload.latestVersion, kind, platformConfig, payload.channel),
  ]))
  const delta = validateDelta(payload.delta, payload, platformConfig, packages)
  if (payload.websiteUrl !== `${UPDATE_ORIGIN}/`) throw new Error('Die Website-Adresse im Update-Manifest ist ungültig.')

  return {
    schemaVersion: 1,
    channel: payload.channel,
    currentVersion,
    latestVersion: payload.latestVersion,
    updateAvailable,
    mandatory: payload.mandatory,
    publishedAt: payload.publishedAt,
    releaseNotes: [...payload.releaseNotes],
    packages,
    delta,
    websiteUrl: payload.websiteUrl,
  }
}

const sha256File = async (filePath) => {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(filePath), new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      callback()
    },
  }))
  return hash.digest('hex')
}

const safeErrorMessage = (error) => {
  if (error?.name === 'AbortError') return 'Die Update-Verbindung hat zu lange nicht geantwortet.'
  const message = typeof error?.message === 'string' ? error.message : 'Unbekannter Updatefehler.'
  return Object.values(PLATFORM_RELEASES).reduce((value, config) => value.replaceAll(config.api, 'Update-Server'), message).slice(0, 900)
}

const atomicJsonWrite = async (target, value) => {
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(temporary, target)
}

const desktopEscape = (value) => {
  if (/[\0\r\n]/u.test(value)) throw new Error('Der Installationspfad kann nicht sicher in einen Desktop-Launcher geschrieben werden.')
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$')
}

function createUpdateManager({
  app,
  getWindow,
  getSettings,
  logger = console,
  fetchImpl = globalThis.fetch,
  forceSupported = false,
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  appImagePath = process.env.APPIMAGE,
  publicKeyPemOverride = null,
  expectedKeyId = EXPECTED_KEY_ID,
}) {
  const currentVersion = app.getVersion()
  const platformConfig = PLATFORM_RELEASES[platform] ?? null
  const supported = Boolean(platformConfig && (app.isPackaged || forceSupported || process.env.FANOTES_UPDATER_ALLOW_DEV === '1'))
  const fullInstallationKind = platform === 'linux' && appImagePath ? 'appimage' : (platformConfig?.installationKind ?? 'managed-appimage')
  const updaterRoot = path.join(app.getPath('userData'), 'updates')
  const persistentStatePath = path.join(updaterRoot, 'state.json')
  const markerPath = path.join(updaterRoot, 'last-installed.json')
  const publicKeyPath = path.join(__dirname, 'update-public-key.pem')
  const publicKeyPem = publicKeyPemOverride ?? fs.readFileSync(publicKeyPath, 'utf8')
  let manifest = null
  let downloadedPath = null
  let downloadedDelta = null
  let checkPromise = null
  let downloadPromise = null
  let intervalTimer = null
  let initialTimer = null
  let activeDownloadController = null
  const highestSeenVersions = { stable: null, beta: null }
  let activeChannel = 'stable'
  let installPrepared = false
  let started = false
  let state = {
    status: 'idle',
    supported,
    currentVersion,
    latestVersion: null,
    publishedAt: null,
    releaseNotes: [],
    downloadedBytes: 0,
    totalBytes: 0,
    progress: 0,
    error: null,
    checkedAt: null,
    installationKind: fullInstallationKind,
  }

  const settings = () => ({
    autoCheckUpdates: getSettings()?.autoCheckUpdates !== false,
    autoDownloadUpdates: getSettings()?.autoDownloadUpdates !== false,
    installUpdatesOnQuit: getSettings()?.installUpdatesOnQuit !== false,
    updateChannel: getSettings()?.updateChannel === 'beta' ? 'beta' : 'stable',
  })

  const snapshot = () => ({ ...state, releaseNotes: [...state.releaseNotes], ...settings() })

  const emit = (patch) => {
    state = { ...state, ...patch }
    const window = getWindow()
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(UPDATE_EVENT, snapshot())
    }
    return snapshot()
  }

  const activateConfiguredChannel = () => {
    const requestedChannel = settings().updateChannel
    if (activeChannel === requestedChannel) return requestedChannel
    activeDownloadController?.abort()
    activeChannel = requestedChannel
    manifest = null
    downloadedPath = null
    downloadedDelta = null
    installPrepared = false
    emit({
      status: 'idle',
      latestVersion: null,
      publishedAt: null,
      releaseNotes: [],
      downloadedBytes: 0,
      totalBytes: 0,
      progress: 0,
      error: null,
      checkedAt: null,
      installationKind: fullInstallationKind,
    })
    return requestedChannel
  }

  const loadPersistentState = async () => {
    try {
      const raw = await fsp.readFile(persistentStatePath, 'utf8')
      if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) return
      const parsed = JSON.parse(raw)
      for (const channel of ['stable', 'beta']) {
        const candidate = parsed?.highestSeenVersions?.[channel]
        if (VERSION_PATTERN.test(candidate || '')) highestSeenVersions[channel] = candidate
      }
      // Migrate the single-channel state written by FaNotes 2.x.
      if (!highestSeenVersions.stable && VERSION_PATTERN.test(parsed?.highestSeenVersion || '')) {
        highestSeenVersions.stable = parsed.highestSeenVersion
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn('FaNotes-Updaterstatus konnte nicht gelesen werden:', error?.message ?? error)
    }
  }

  const rememberHighestVersion = async (channel, version) => {
    const previous = highestSeenVersions[channel]
    if (previous && compareVersions(version, previous) <= 0) return
    highestSeenVersions[channel] = version
    await atomicJsonWrite(persistentStatePath, {
      schemaVersion: 2,
      highestSeenVersions,
      updatedAt: new Date().toISOString(),
    })
  }

  const resolveDeltaSource = async (delta) => {
    const candidate = platform === 'linux'
      ? (typeof appImagePath === 'string' && path.isAbsolute(appImagePath) ? path.resolve(appImagePath) : null)
      : (typeof resourcesPath === 'string' && path.isAbsolute(resourcesPath) ? path.resolve(resourcesPath, 'app.asar') : null)
    if (!candidate) throw new Error('Diese FaNotes-Installation besitzt keine sichere lokale Basis für ein differentielles Update.')
    const info = await fsp.lstat(candidate).catch(() => null)
    if (!info?.isFile() || info.isSymbolicLink() || info.size !== delta.source.sizeBytes) {
      throw new Error('Die installierte FaNotes-Datei passt nicht zur Basis des differentiellen Updates.')
    }
    if (await sha256File(candidate) !== delta.source.sha256) {
      throw new Error('Die installierte FaNotes-Datei wurde verändert. Das differentielle Update wurde zum Schutz der Installation blockiert.')
    }
    return candidate
  }

  const fetchManifest = async (channel) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 25_000)
    try {
      if (!platformConfig) throw new Error('Automatische Updates werden auf dieser Plattform nicht unterstützt.')
      const url = new URL(platformConfig.api)
      url.searchParams.set('current', currentVersion)
      url.searchParams.set('channel', channel)
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': `FaNotes/${currentVersion} ${platformConfig.userAgentPlatform} updater` },
        redirect: 'error',
        signal: controller.signal,
      })
      const advertisedLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(advertisedLength) && advertisedLength > MAX_MANIFEST_BYTES) throw new Error('Das Update-Manifest ist unerwartet groß.')
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('Das Update-Manifest ist unerwartet groß.')
      if (!response.ok) throw new Error(`Der Update-Server antwortet mit HTTP ${response.status}.`)
      let candidate
      try {
        candidate = JSON.parse(text)
      } catch {
        throw new Error('Der Update-Server hat kein gültiges JSON-Manifest geliefert.')
      }
      return verifyManifest(candidate, currentVersion, publicKeyPem, platform, expectedKeyId, channel)
    } finally {
      clearTimeout(timeout)
    }
  }

  const check = ({ manual = false } = {}) => {
    if (checkPromise) return checkPromise
    checkPromise = (async () => {
      if (!supported) {
        const next = emit({
          status: 'error',
          error: 'Automatische Updates stehen auf dieser Plattform nur in einer installierten FaNotes-Desktopausgabe zur Verfügung.',
          checkedAt: new Date().toISOString(),
        })
        return next
      }
      const requestedChannel = activateConfiguredChannel()
      emit({ status: 'checking', error: null })
      try {
        const verified = await fetchManifest(requestedChannel)
        if (requestedChannel !== settings().updateChannel) return snapshot()
        const highestSeenVersion = highestSeenVersions[requestedChannel]
        if (highestSeenVersion && compareVersions(verified.latestVersion, highestSeenVersion) < 0) {
          throw new Error('Der Update-Server bietet eine ältere als die bereits bekannte Version an. Das Update wurde zum Schutz vor einem Rollback blockiert.')
        }
        await rememberHighestVersion(requestedChannel, verified.latestVersion)
        manifest = verified
        const checkedAt = new Date().toISOString()
        if (!verified.updateAvailable) {
          downloadedPath = null
          downloadedDelta = null
          return emit({
            status: 'up-to-date',
            latestVersion: verified.latestVersion,
            publishedAt: verified.publishedAt,
            releaseNotes: verified.releaseNotes,
            downloadedBytes: 0,
            totalBytes: 0,
            progress: 0,
            error: null,
            checkedAt,
          })
        }
        const next = emit({
          status: 'available',
          latestVersion: verified.latestVersion,
          publishedAt: verified.publishedAt,
          releaseNotes: verified.releaseNotes,
          downloadedBytes: 0,
          totalBytes: verified.delta?.sizeBytes ?? verified.packages[platformConfig.primaryPackage].sizeBytes,
          progress: 0,
          installationKind: verified.delta
            ? (platform === 'win32' ? 'differential-windows' : 'differential-appimage')
            : fullInstallationKind,
          error: null,
          checkedAt,
        })
        if (settings().autoDownloadUpdates) void download().catch(() => {})
        return next
      } catch (error) {
        logger.warn(`FaNotes-Updateprüfung${manual ? ' (manuell)' : ''} fehlgeschlagen:`, error?.message ?? error)
        return emit({ status: 'error', error: safeErrorMessage(error), checkedAt: new Date().toISOString() })
      }
    })().finally(() => { checkPromise = null })
    return checkPromise
  }

  const downloadTransfer = async (transferInfo, releaseDirectory, accept) => {
    const finalPath = path.join(releaseDirectory, transferInfo.fileName)
    const partPath = `${finalPath}.part`
    const existing = await fsp.lstat(finalPath).catch(() => null)
    if (existing?.isFile() && !existing.isSymbolicLink() && existing.size === transferInfo.sizeBytes && await sha256File(finalPath) === transferInfo.sha256) return finalPath
    if (existing) await fsp.rm(finalPath, { force: true })

    let offset = 0
    const partial = await fsp.lstat(partPath).catch(() => null)
    if (partial?.isFile() && !partial.isSymbolicLink() && partial.size > 0 && partial.size < transferInfo.sizeBytes) offset = partial.size
    else if (partial) await fsp.rm(partPath, { force: true })
    emit({ status: 'downloading', downloadedBytes: offset, totalBytes: transferInfo.sizeBytes, progress: offset / transferInfo.sizeBytes, error: null })

    const controller = new AbortController()
    activeDownloadController = controller
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    try {
      const response = await fetchImpl(transferInfo.url, {
        headers: {
          Accept: accept,
          'User-Agent': `FaNotes/${currentVersion} ${platformConfig.userAgentPlatform} updater`,
          ...(offset ? { Range: `bytes=${offset}-` } : {}),
        },
        redirect: 'error',
        signal: controller.signal,
      })
      if (offset && response.status !== 206) {
        if (response.status === 200) {
          offset = 0
          await fsp.rm(partPath, { force: true })
        } else {
          throw new Error(`Der Update-Download kann nicht fortgesetzt werden (HTTP ${response.status}).`)
        }
      } else if (!offset && response.status !== 200) {
        throw new Error(`Der Update-Download antwortet mit HTTP ${response.status}.`)
      }
      if (offset) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get('content-range') || '')
        if (!range || Number(range[1]) !== offset || Number(range[3]) !== transferInfo.sizeBytes) throw new Error('Der Update-Server hat einen ungültigen Fortsetzungsbereich geliefert.')
      }
      const advertisedLength = Number(response.headers.get('content-length'))
      const expectedResponseBytes = transferInfo.sizeBytes - offset
      if (Number.isFinite(advertisedLength) && advertisedLength !== expectedResponseBytes) throw new Error('Der Update-Server hat eine unerwartete Downloadgröße angekündigt.')
      if (!response.body) throw new Error('Der Update-Server hat keine Datei geliefert.')
      let downloaded = offset
      let lastProgressAt = 0
      const progressStream = new Transform({
        transform(chunk, _encoding, callback) {
          downloaded += chunk.length
          if (downloaded > transferInfo.sizeBytes) {
            callback(new Error('Der Update-Download ist größer als angekündigt.'))
            return
          }
          const now = Date.now()
          if (now - lastProgressAt > 180 || downloaded === transferInfo.sizeBytes) {
            lastProgressAt = now
            emit({ downloadedBytes: downloaded, progress: downloaded / transferInfo.sizeBytes })
          }
          callback(null, chunk)
        },
      })
      await pipeline(
        Readable.fromWeb(response.body),
        progressStream,
        fs.createWriteStream(partPath, {
          flags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW |
            (offset ? fs.constants.O_APPEND : fs.constants.O_TRUNC),
          mode: 0o600,
        }),
      )
    } finally {
      clearTimeout(timeout)
      activeDownloadController = null
    }
    const info = await fsp.stat(partPath)
    if (!info.isFile() || info.size !== transferInfo.sizeBytes) throw new Error('Das Update wurde nicht vollständig heruntergeladen.')
    if (await sha256File(partPath) !== transferInfo.sha256) {
      await fsp.rm(partPath, { force: true })
      throw new Error('Die SHA-256-Prüfung des Downloads ist fehlgeschlagen. Die Datei wurde verworfen.')
    }
    await fsp.rename(partPath, finalPath)
    return finalPath
  }

  const download = () => {
    if (downloadPromise) return downloadPromise
    downloadPromise = (async () => {
      if (!manifest?.updateAvailable) {
        await check({ manual: true })
        if (!manifest?.updateAvailable) return snapshot()
      }
      const packageInfo = manifest.packages[platformConfig.primaryPackage]
      let delta = manifest.delta
      let deltaSource = null
      const releaseDirectory = path.join(updaterRoot, manifest.latestVersion)
      await fsp.mkdir(releaseDirectory, { recursive: true, mode: 0o700 })

      try {
        const stageSelectedUpdate = async (selectedDelta, sourcePath) => {
          const transferInfo = selectedDelta ?? packageInfo
          const targetInfo = selectedDelta?.target ?? packageInfo
          const targetPath = path.join(releaseDirectory, targetInfo.fileName)
          emit({
            totalBytes: transferInfo.sizeBytes,
            installationKind: selectedDelta
              ? (platform === 'win32' ? 'differential-windows' : 'differential-appimage')
              : fullInstallationKind,
          })
          const existingTarget = await fsp.lstat(targetPath).catch(() => null)
          if (existingTarget?.isFile() && !existingTarget.isSymbolicLink() && existingTarget.size === targetInfo.sizeBytes && await sha256File(targetPath) === targetInfo.sha256) {
            if (platform === 'linux') await fsp.chmod(targetPath, 0o700)
            return { targetPath, transferInfo }
          }
          if (existingTarget) await fsp.rm(targetPath, { force: true })

          const transferPath = await downloadTransfer(
            transferInfo,
            releaseDirectory,
            selectedDelta ? 'application/vnd.fanotes.delta, application/octet-stream;q=0.9' : platformConfig.accept,
          )
          if (selectedDelta) {
            await applyDeltaPatch({
              patchPath: transferPath,
              sourcePath,
              outputPath: targetPath,
              expected: {
                platform: platform === 'win32' ? 'windows' : 'linux',
                baseVersion: currentVersion,
                targetVersion: manifest.latestVersion,
                source: selectedDelta.source,
                target: selectedDelta.target,
              },
              signal: activeDownloadController?.signal,
            })
            await fsp.rm(transferPath, { force: true })
          }
          if (platform === 'linux') await fsp.chmod(targetPath, 0o700)
          return { targetPath, transferInfo }
        }

        if (delta) {
          try {
            deltaSource = await resolveDeltaSource(delta)
          } catch (error) {
            logger.warn('Die lokale Delta-Basis ist nicht kompatibel; FaNotes verwendet das signierte Vollpaket:', error?.message ?? error)
            delta = null
          }
        }
        let staged
        if (delta) {
          try {
            staged = await stageSelectedUpdate(delta, deltaSource)
          } catch (error) {
            logger.warn('Das Delta-Update konnte nicht sicher rekonstruiert werden; FaNotes verwendet das signierte Vollpaket:', error?.message ?? error)
            delta = null
            staged = await stageSelectedUpdate(null, null)
          }
        } else {
          staged = await stageSelectedUpdate(null, null)
        }
        downloadedPath = staged.targetPath
        downloadedDelta = delta
        return emit({
          status: 'downloaded',
          downloadedBytes: staged.transferInfo.sizeBytes,
          totalBytes: staged.transferInfo.sizeBytes,
          progress: 1,
          installationKind: delta ? (platform === 'win32' ? 'differential-windows' : 'differential-appimage') : state.installationKind,
          error: null,
        })
      } catch (error) {
        downloadedDelta = null
        logger.warn('FaNotes-Updatedownload fehlgeschlagen:', error?.message ?? error)
        return emit({ status: 'error', error: safeErrorMessage(error) })
      }
    })().finally(() => { downloadPromise = null })
    return downloadPromise
  }

  const determineInstallTarget = async () => {
    const currentAppImage = typeof appImagePath === 'string' && path.isAbsolute(appImagePath) ? path.resolve(appImagePath) : null
    if (currentAppImage) {
      try {
        const info = await fsp.lstat(currentAppImage)
        if (info.isFile() && !info.isSymbolicLink()) {
          await fsp.access(currentAppImage, fs.constants.R_OK | fs.constants.W_OK)
          await fsp.access(path.dirname(currentAppImage), fs.constants.W_OK)
          return { kind: 'appimage', target: currentAppImage }
        }
      } catch {
        // A read-only or linked AppImage is migrated to the managed location.
      }
    }
    return {
      kind: 'managed-appimage',
      target: path.join(app.getPath('home'), '.local', 'opt', 'FaNotes', 'FaNotes.AppImage'),
    }
  }

  const writeManagedDesktopEntry = async (target) => {
    const applicationsDirectory = path.join(app.getPath('home'), '.local', 'share', 'applications')
    const desktopPath = path.join(applicationsDirectory, 'fanotes.desktop')
    const iconsDirectory = path.join(app.getPath('home'), '.local', 'share', 'icons', 'hicolor', '512x512', 'apps')
    const installedIconPath = path.join(iconsDirectory, 'fanotes.png')
    let iconValue = 'fanotes'
    const packagedIconPath = typeof process.resourcesPath === 'string'
      ? path.resolve(process.resourcesPath, '..', 'fanotes.png')
      : null
    if (packagedIconPath) {
      try {
        const iconInfo = await fsp.lstat(packagedIconPath)
        if (iconInfo.isFile() && !iconInfo.isSymbolicLink() && iconInfo.size > 0 && iconInfo.size <= 4 * 1024 * 1024) {
          await fsp.mkdir(iconsDirectory, { recursive: true, mode: 0o700 })
          await fsp.copyFile(packagedIconPath, installedIconPath, fs.constants.COPYFILE_FICLONE)
          await fsp.chmod(installedIconPath, 0o644)
          iconValue = installedIconPath
        }
      } catch (error) {
        logger.warn('Das FaNotes-Symbol konnte für den Benutzer-Launcher nicht kopiert werden:', error?.message ?? error)
      }
    }
    const escapedTarget = desktopEscape(target)
    const escapedIcon = desktopEscape(iconValue)
    const content = `[Desktop Entry]\nType=Application\nName=FaNotes\nComment=Markdown-Notizen mit Handschrift\nExec="${escapedTarget}" %U\nTryExec="${escapedTarget}"\nIcon=${escapedIcon}\nTerminal=false\nCategories=Education;Office;\nStartupNotify=true\nX-FaNotes-Managed=true\n`
    await fsp.mkdir(applicationsDirectory, { recursive: true, mode: 0o700 })
    await fsp.writeFile(desktopPath, content, { encoding: 'utf8', mode: 0o644 })
  }

  const prepareInstall = async () => {
    if (installPrepared) return snapshot()
    if (!manifest?.updateAvailable || !downloadedPath || state.status !== 'downloaded') {
      throw new Error('Es ist noch kein vollständig geprüftes Update bereit.')
    }
    const packageInfo = manifest.packages[platformConfig.primaryPackage]
    const installInfo = downloadedDelta?.target ?? packageInfo
    const info = await fsp.lstat(downloadedPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== installInfo.sizeBytes || await sha256File(downloadedPath) !== installInfo.sha256) {
      downloadedPath = null
      throw new Error('Das vorbereitete Update hat die abschließende Integritätsprüfung nicht bestanden.')
    }

    if (platform === 'win32') {
      if (downloadedDelta) {
        if (typeof resourcesPath !== 'string' || !path.isAbsolute(resourcesPath)) throw new Error('Der Windows-Installationspfad ist für das Delta-Update ungültig.')
        const target = path.resolve(resourcesPath, 'app.asar')
        const executable = path.resolve(resourcesPath, '..', 'FaNotes.exe')
        const [targetInfo, executableInfo] = await Promise.all([fsp.lstat(target), fsp.lstat(executable)])
        if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || !executableInfo.isFile() || executableInfo.isSymbolicLink()) throw new Error('Die Windows-Installation kann nicht sicher differentiell aktualisiert werden.')
        await fsp.access(path.dirname(target), fs.constants.W_OK)
        const helperPath = path.join(updaterRoot, 'install-delta.ps1')
        const logPath = path.join(updaterRoot, 'install.log')
        await fsp.mkdir(updaterRoot, { recursive: true, mode: 0o700 })
        await fsp.writeFile(helperPath, WINDOWS_DELTA_HELPER, { encoding: 'utf8', mode: 0o600 })
        const child = spawn('powershell.exe', [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-File', helperPath,
          '-ParentPid', String(process.pid),
          '-Target', target,
          '-Staged', downloadedPath,
          '-ExpectedSha', installInfo.sha256,
          '-FromVersion', currentVersion,
          '-ToVersion', manifest.latestVersion,
          '-Executable', executable,
          '-LogFile', logPath,
          '-MarkerFile', markerPath,
        ], { detached: true, stdio: 'ignore', windowsHide: true })
        await new Promise((resolve, reject) => {
          child.once('spawn', resolve)
          child.once('error', reject)
        })
        child.unref()
        installPrepared = true
        stop({ abortDownload: false })
        return emit({ status: 'installing', installationKind: 'differential-windows', error: null })
      }
      const child = spawn(downloadedPath, WINDOWS_INSTALLER_ARGS, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      child.unref()
      installPrepared = true
      stop({ abortDownload: false })
      return emit({ status: 'installing', installationKind: 'windows-installer', error: null })
    }

    const destination = await determineInstallTarget()
    await fsp.mkdir(path.dirname(destination.target), { recursive: true, mode: 0o700 })
    await fsp.access(path.dirname(destination.target), fs.constants.W_OK)
    if (destination.kind === 'managed-appimage') await writeManagedDesktopEntry(destination.target)

    const helperPath = path.join(updaterRoot, 'install-update.sh')
    const logPath = path.join(updaterRoot, 'install.log')
    await fsp.mkdir(updaterRoot, { recursive: true, mode: 0o700 })
    await fsp.writeFile(helperPath, INSTALL_HELPER, { encoding: 'utf8', mode: 0o700 })
    await fsp.chmod(helperPath, 0o700)
    const child = spawn('/bin/sh', [
      helperPath,
      String(process.pid),
      destination.target,
      downloadedPath,
      installInfo.sha256,
      currentVersion,
      manifest.latestVersion,
      logPath,
      markerPath,
    ], { detached: true, stdio: 'ignore' })
    child.unref()
    installPrepared = true
    stop({ abortDownload: false })
    return emit({ status: 'installing', installationKind: destination.kind, error: null })
  }

  const shouldInstallOnQuit = () => Boolean(settings().installUpdatesOnQuit && state.status === 'downloaded' && downloadedPath)

  const schedule = () => {
    if (!started || !supported || !settings().autoCheckUpdates) return
    if (!initialTimer && !checkPromise) {
      initialTimer = setTimeout(() => {
        initialTimer = null
        void check().catch(() => {})
      }, INITIAL_CHECK_DELAY_MS)
      initialTimer.unref?.()
    }
    if (!intervalTimer) {
      intervalTimer = setInterval(() => {
        if (settings().autoCheckUpdates) void check().catch(() => {})
      }, CHECK_INTERVAL_MS)
      intervalTimer.unref?.()
    }
  }

  const configure = () => {
    const previousChannel = activeChannel
    const requestedChannel = activateConfiguredChannel()
    if (settings().autoCheckUpdates) schedule()
    else {
      if (initialTimer) clearTimeout(initialTimer)
      if (intervalTimer) clearInterval(intervalTimer)
      initialTimer = null
      intervalTimer = null
    }
    emit({})
    if (started && requestedChannel !== previousChannel && settings().autoCheckUpdates) void check().catch(() => {})
  }

  const start = async () => {
    if (started) return
    started = true
    await loadPersistentState()
    await fsp.mkdir(updaterRoot, { recursive: true, mode: 0o700 })
    activateConfiguredChannel()
    schedule()
    emit({})
  }

  const stop = ({ abortDownload = true } = {}) => {
    started = false
    if (initialTimer) clearTimeout(initialTimer)
    if (intervalTimer) clearInterval(intervalTimer)
    initialTimer = null
    intervalTimer = null
    if (abortDownload) activeDownloadController?.abort()
  }

  return {
    start,
    stop,
    configure,
    check,
    download,
    prepareInstall,
    shouldInstallOnQuit,
    getState: snapshot,
  }
}

module.exports = {
  EXPECTED_KEY_ID,
  INSTALL_HELPER,
  PLATFORM_RELEASES,
  UPDATE_API,
  UPDATE_EVENT,
  WINDOWS_DELTA_HELPER,
  WINDOWS_INSTALLER_ARGS,
  compareVersions,
  createUpdateManager,
  stableStringify,
  verifyManifest,
}
