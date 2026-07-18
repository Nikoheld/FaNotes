'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const UPDATE_API = 'https://fanotes.fasrv.ch/api/v1/updates/linux-x64'
const UPDATE_ORIGIN = 'https://fanotes.fasrv.ch'
const UPDATE_EVENT = 'fanotes:update-state'
const EXPECTED_KEY_ID = '33006e5c06939bc9'
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const MAX_MANIFEST_BYTES = 512 * 1024
const MIN_PACKAGE_BYTES = 10 * 1024 * 1024
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const INITIAL_CHECK_DELAY_MS = 12_000
const DOWNLOAD_TIMEOUT_MS = 45 * 60 * 1000

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

const compareVersions = (left, right) => {
  if (!VERSION_PATTERN.test(left) || !VERSION_PATTERN.test(right)) throw new Error('Ungültige Versionsnummer.')
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const strictBase64 = (value) => {
  if (typeof value !== 'string' || value.length < 64 || value.length > 256 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return null
  const decoded = Buffer.from(value, 'base64')
  return decoded.toString('base64') === value ? decoded : null
}

const validatePackage = (candidate, version, kind) => {
  if (!isPlainObject(candidate)) throw new Error(`Das ${kind}-Paket fehlt im Update-Manifest.`)
  const expectedName = kind === 'AppImage'
    ? `FaNotes-${version}-x86_64.AppImage`
    : `FaNotes-${version}-x86_64.tar.gz`
  if (candidate.fileName !== expectedName) throw new Error(`Der ${kind}-Dateiname ist ungültig.`)
  if (!Number.isSafeInteger(candidate.sizeBytes) || candidate.sizeBytes < MIN_PACKAGE_BYTES || candidate.sizeBytes > MAX_PACKAGE_BYTES) {
    throw new Error(`Die ${kind}-Dateigröße ist ungültig.`)
  }
  if (typeof candidate.sha256 !== 'string' || !SHA256_PATTERN.test(candidate.sha256)) {
    throw new Error(`Die ${kind}-Prüfsumme ist ungültig.`)
  }
  let parsedUrl
  try {
    parsedUrl = new URL(candidate.url)
  } catch {
    throw new Error(`Die ${kind}-Downloadadresse ist ungültig.`)
  }
  const expectedPath = kind === 'AppImage' ? '/download/appimage' : '/download/portable'
  if (
    parsedUrl.origin !== UPDATE_ORIGIN || parsedUrl.pathname !== expectedPath ||
    parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash
  ) {
    throw new Error(`Die ${kind}-Downloadadresse ist nicht vertrauenswürdig.`)
  }
  return {
    fileName: candidate.fileName,
    sizeBytes: candidate.sizeBytes,
    sha256: candidate.sha256,
    url: parsedUrl.href,
  }
}

const verifyManifest = (candidate, currentVersion, publicKeyPem) => {
  if (!isPlainObject(candidate) || !isPlainObject(candidate.signature)) throw new Error('Das Update-Manifest ist ungültig.')
  const signature = candidate.signature
  if (signature.algorithm !== 'ed25519' || signature.keyId !== EXPECTED_KEY_ID) {
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
    payload.schemaVersion !== 1 || payload.product !== 'FaNotes' || payload.channel !== 'stable' ||
    payload.platform !== 'linux' || payload.arch !== 'x64'
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
  const appimage = validatePackage(payload.packages.appimage, payload.latestVersion, 'AppImage')
  const portable = validatePackage(payload.packages.portable, payload.latestVersion, 'Portable')
  if (payload.websiteUrl !== `${UPDATE_ORIGIN}/`) throw new Error('Die Website-Adresse im Update-Manifest ist ungültig.')

  return {
    schemaVersion: 1,
    currentVersion,
    latestVersion: payload.latestVersion,
    updateAvailable,
    mandatory: payload.mandatory,
    publishedAt: payload.publishedAt,
    releaseNotes: [...payload.releaseNotes],
    packages: { appimage, portable },
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
  return message.replaceAll(UPDATE_API, 'Update-Server').slice(0, 900)
}

const atomicJsonWrite = async (target, value) => {
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(temporary, target)
}

const desktopEscape = (value) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$')

function createUpdateManager({ app, getWindow, getSettings, logger = console, fetchImpl = globalThis.fetch, forceSupported = false }) {
  const currentVersion = app.getVersion()
  const supported = process.platform === 'linux' && (app.isPackaged || forceSupported || process.env.FANOTES_UPDATER_ALLOW_DEV === '1')
  const updaterRoot = path.join(app.getPath('userData'), 'updates')
  const persistentStatePath = path.join(updaterRoot, 'state.json')
  const markerPath = path.join(updaterRoot, 'last-installed.json')
  const publicKeyPath = path.join(__dirname, 'update-public-key.pem')
  const publicKeyPem = fs.readFileSync(publicKeyPath, 'utf8')
  let manifest = null
  let downloadedPath = null
  let checkPromise = null
  let downloadPromise = null
  let intervalTimer = null
  let initialTimer = null
  let activeDownloadController = null
  let highestSeenVersion = currentVersion
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
    installationKind: process.env.APPIMAGE ? 'appimage' : 'managed-appimage',
  }

  const settings = () => ({
    autoCheckUpdates: getSettings()?.autoCheckUpdates !== false,
    autoDownloadUpdates: getSettings()?.autoDownloadUpdates !== false,
    installUpdatesOnQuit: getSettings()?.installUpdatesOnQuit !== false,
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

  const loadPersistentState = async () => {
    try {
      const raw = await fsp.readFile(persistentStatePath, 'utf8')
      if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) return
      const parsed = JSON.parse(raw)
      if (VERSION_PATTERN.test(parsed?.highestSeenVersion) && compareVersions(parsed.highestSeenVersion, highestSeenVersion) > 0) {
        highestSeenVersion = parsed.highestSeenVersion
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn('FaNotes-Updaterstatus konnte nicht gelesen werden:', error?.message ?? error)
    }
  }

  const rememberHighestVersion = async (version) => {
    if (compareVersions(version, highestSeenVersion) <= 0) return
    highestSeenVersion = version
    await atomicJsonWrite(persistentStatePath, { schemaVersion: 1, highestSeenVersion, updatedAt: new Date().toISOString() })
  }

  const fetchManifest = async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 25_000)
    try {
      const url = new URL(UPDATE_API)
      url.searchParams.set('current', currentVersion)
      url.searchParams.set('channel', 'stable')
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': `FaNotes/${currentVersion} Linux updater` },
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
      return verifyManifest(candidate, currentVersion, publicKeyPem)
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
          error: 'Automatische Updates stehen nur in der installierten Linux-Ausgabe von FaNotes zur Verfügung.',
          checkedAt: new Date().toISOString(),
        })
        return next
      }
      emit({ status: 'checking', error: null })
      try {
        const verified = await fetchManifest()
        if (compareVersions(verified.latestVersion, highestSeenVersion) < 0) {
          throw new Error('Der Update-Server bietet eine ältere als die bereits bekannte Version an. Das Update wurde zum Schutz vor einem Rollback blockiert.')
        }
        await rememberHighestVersion(verified.latestVersion)
        manifest = verified
        const checkedAt = new Date().toISOString()
        if (!verified.updateAvailable) {
          downloadedPath = null
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
          totalBytes: verified.packages.appimage.sizeBytes,
          progress: 0,
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

  const download = () => {
    if (downloadPromise) return downloadPromise
    downloadPromise = (async () => {
      if (!manifest?.updateAvailable) {
        await check({ manual: true })
        if (!manifest?.updateAvailable) return snapshot()
      }
      const packageInfo = manifest.packages.appimage
      const releaseDirectory = path.join(updaterRoot, manifest.latestVersion)
      const finalPath = path.join(releaseDirectory, packageInfo.fileName)
      const partPath = `${finalPath}.part`
      await fsp.mkdir(releaseDirectory, { recursive: true, mode: 0o700 })

      try {
        const existing = await fsp.stat(finalPath).catch(() => null)
        if (existing?.isFile() && existing.size === packageInfo.sizeBytes && await sha256File(finalPath) === packageInfo.sha256) {
          await fsp.chmod(finalPath, 0o700)
          downloadedPath = finalPath
          return emit({ status: 'downloaded', downloadedBytes: packageInfo.sizeBytes, totalBytes: packageInfo.sizeBytes, progress: 1, error: null })
        }
        if (existing) await fsp.rm(finalPath, { force: true })

        let offset = 0
        const partial = await fsp.stat(partPath).catch(() => null)
        if (partial?.isFile() && partial.size > 0 && partial.size < packageInfo.sizeBytes) offset = partial.size
        else if (partial) await fsp.rm(partPath, { force: true })

        emit({
          status: 'downloading',
          downloadedBytes: offset,
          totalBytes: packageInfo.sizeBytes,
          progress: offset / packageInfo.sizeBytes,
          error: null,
        })
        const controller = new AbortController()
        activeDownloadController = controller
        const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
        try {
          const response = await fetchImpl(packageInfo.url, {
            headers: {
              Accept: 'application/vnd.appimage, application/octet-stream;q=0.9',
              'User-Agent': `FaNotes/${currentVersion} Linux updater`,
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
            if (!range || Number(range[1]) !== offset || Number(range[3]) !== packageInfo.sizeBytes) {
              throw new Error('Der Update-Server hat einen ungültigen Fortsetzungsbereich geliefert.')
            }
          }
          if (!response.body) throw new Error('Der Update-Server hat keine Datei geliefert.')
          let downloaded = offset
          let lastProgressAt = 0
          const progressStream = new Transform({
            transform(chunk, _encoding, callback) {
              downloaded += chunk.length
              if (downloaded > packageInfo.sizeBytes) {
                callback(new Error('Der Update-Download ist größer als angekündigt.'))
                return
              }
              const now = Date.now()
              if (now - lastProgressAt > 180 || downloaded === packageInfo.sizeBytes) {
                lastProgressAt = now
                emit({ downloadedBytes: downloaded, progress: downloaded / packageInfo.sizeBytes })
              }
              callback(null, chunk)
            },
          })
          await pipeline(
            Readable.fromWeb(response.body),
            progressStream,
            fs.createWriteStream(partPath, { flags: offset ? 'a' : 'w', mode: 0o600 }),
          )
        } finally {
          clearTimeout(timeout)
          activeDownloadController = null
        }

        const info = await fsp.stat(partPath)
        if (!info.isFile() || info.size !== packageInfo.sizeBytes) throw new Error('Das Update wurde nicht vollständig heruntergeladen.')
        const actualSha256 = await sha256File(partPath)
        if (actualSha256 !== packageInfo.sha256) {
          await fsp.rm(partPath, { force: true })
          throw new Error('Die SHA-256-Prüfung des Downloads ist fehlgeschlagen. Die Datei wurde verworfen.')
        }
        await fsp.chmod(partPath, 0o700)
        await fsp.rename(partPath, finalPath)
        downloadedPath = finalPath
        return emit({ status: 'downloaded', downloadedBytes: packageInfo.sizeBytes, totalBytes: packageInfo.sizeBytes, progress: 1, error: null })
      } catch (error) {
        logger.warn('FaNotes-Updatedownload fehlgeschlagen:', error?.message ?? error)
        return emit({ status: 'error', error: safeErrorMessage(error) })
      }
    })().finally(() => { downloadPromise = null })
    return downloadPromise
  }

  const determineInstallTarget = async () => {
    const appImagePath = process.env.APPIMAGE && path.isAbsolute(process.env.APPIMAGE) ? path.resolve(process.env.APPIMAGE) : null
    if (appImagePath) {
      try {
        const info = await fsp.lstat(appImagePath)
        if (info.isFile() && !info.isSymbolicLink()) {
          await fsp.access(appImagePath, fs.constants.R_OK | fs.constants.W_OK)
          await fsp.access(path.dirname(appImagePath), fs.constants.W_OK)
          return { kind: 'appimage', target: appImagePath }
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
    const escapedTarget = desktopEscape(target)
    const content = `[Desktop Entry]\nType=Application\nName=FaNotes\nComment=Markdown-Notizen mit Handschrift\nExec="${escapedTarget}" %U\nTryExec="${escapedTarget}"\nIcon=fanotes\nTerminal=false\nCategories=Education;Office;\nStartupNotify=true\nX-FaNotes-Managed=true\n`
    await fsp.mkdir(applicationsDirectory, { recursive: true, mode: 0o700 })
    await fsp.writeFile(desktopPath, content, { encoding: 'utf8', mode: 0o644 })
  }

  const prepareInstall = async () => {
    if (installPrepared) return snapshot()
    if (!manifest?.updateAvailable || !downloadedPath || state.status !== 'downloaded') {
      throw new Error('Es ist noch kein vollständig geprüftes Update bereit.')
    }
    const packageInfo = manifest.packages.appimage
    const info = await fsp.lstat(downloadedPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== packageInfo.sizeBytes || await sha256File(downloadedPath) !== packageInfo.sha256) {
      downloadedPath = null
      throw new Error('Das vorbereitete Update hat die abschließende Integritätsprüfung nicht bestanden.')
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
      packageInfo.sha256,
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
    if (settings().autoCheckUpdates) schedule()
    else {
      if (initialTimer) clearTimeout(initialTimer)
      if (intervalTimer) clearInterval(intervalTimer)
      initialTimer = null
      intervalTimer = null
    }
    emit({})
  }

  const start = async () => {
    if (started) return
    started = true
    await loadPersistentState()
    await fsp.mkdir(updaterRoot, { recursive: true, mode: 0o700 })
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
  UPDATE_API,
  UPDATE_EVENT,
  compareVersions,
  createUpdateManager,
  stableStringify,
  verifyManifest,
}
