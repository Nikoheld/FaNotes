import { createReadStream, promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleBackupRequest, initializeBackupService } from './backup-service.mjs'
import { handleAiProxyRequest } from './ai-proxy.mjs'
import { languageForRequest, localizeExactText, localizeResponse } from './i18n.mjs'
import { createAnalyticsService } from './analytics.mjs'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC_DIR = resolve(process.env.FANOTES_PUBLIC_DIR || join(ROOT, 'public'))
const RELEASE_DIR = resolve(process.env.FANOTES_RELEASE_DIR || '/mnt/truenas/Fabio/FaNotes-Arch-x86_64')
const HOST = process.env.FANOTES_HOST || '127.0.0.1'
const PORT = Number(process.env.FANOTES_PORT || 18185)
const INTERNAL_DOWNLOAD_PREFIX = process.env.FANOTES_INTERNAL_DOWNLOAD_PREFIX || '/_fanotes_release/'
const PUBLIC_ORIGIN = process.env.FANOTES_PUBLIC_ORIGIN || 'https://fanotes.fasrv.ch'
const UPDATE_SIGNING_KEY_PATH = process.env.FANOTES_UPDATE_SIGNING_KEY || '/etc/fanotes/update-signing-private.pem'
const ANALYTICS_DIR = resolve(process.env.FANOTES_ANALYTICS_DIR || '/var/lib/fanotes-analytics')
const MAX_STATIC_BYTES = 12 * 1024 * 1024
const MAX_NEURAL_TEXT_MODEL_BYTES = 32 * 1024 * 1024
const MAX_TROCR_MODEL_BYTES = 100 * 1024 * 1024
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const DELTA_FORMAT = 'fanotes-delta-v1'
const MAX_DELTA_TO_TARGET_RATIO = 0.8
const DELTA_MAGIC = Buffer.from('FANOTESDELTA1\0\0\0', 'ascii')
const MAX_DELTA_HEADER_BYTES = 8 * 1024 * 1024

const analytics = await createAnalyticsService({ directory: ANALYTICS_DIR })

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
])

const json = (response, status, value, extraHeaders = {}, localize = true) => {
  const body = JSON.stringify(localize ? localizeResponse(value, response.fanotesLanguage || 'de') : value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  response.end(body)
}

const parseVersion = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/u.exec(value)
  if (!match) throw new Error('Ungültige Versionsnummer.')
  return {
    numbers: match.slice(1, 4).map(Number),
    beta: match[4] === undefined ? null : Number(match[4]),
  }
}

const compareSemanticVersions = (left, right) => {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = a.numbers[index] - b.numbers[index]
    if (difference) return difference
  }
  if (a.beta === b.beta) return 0
  if (a.beta === null) return 1
  if (b.beta === null) return -1
  return a.beta - b.beta
}

const isBetaVersion = (version) => parseVersion(version).beta !== null

const compareVersions = (left, right) => {
  return compareSemanticVersions(right, left)
}

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

let updateSigningMaterialPromise = null

const updateSigningMaterial = () => {
  if (!updateSigningMaterialPromise) {
    updateSigningMaterialPromise = fs.readFile(UPDATE_SIGNING_KEY_PATH, 'utf8').then((pem) => {
      const privateKey = createPrivateKey(pem)
      const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
      return {
        privateKey,
        keyId: createHash('sha256').update(publicDer).digest('hex').slice(0, 16),
      }
    })
  }
  return updateSigningMaterialPromise
}

const checksumMap = async () => {
  const text = await fs.readFile(join(RELEASE_DIR, 'SHA256SUMS'), 'utf8')
  return new Map(text.split(/\r?\n/u).flatMap((line) => {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/iu.exec(line.trim())
    return match ? [[match[2], match[1].toLowerCase()]] : []
  }))
}

const changelogFor = async (version) => {
  try {
    const text = await fs.readFile(join(RELEASE_DIR, 'CHANGELOG.md'), 'utf8')
    const lines = text.split(/\r?\n/u)
    const start = lines.findIndex((line) => line.trim() === `## ${version}`)
    if (start < 0) return []
    const nextHeading = lines.findIndex((line, index) => index > start && /^##\s+/u.test(line.trim()))
    return lines.slice(start + 1, nextHeading < 0 ? undefined : nextHeading)
      .map((line) => /^-\s+(.+)$/u.exec(line.trim())?.[1])
      .filter(Boolean)
      .slice(0, 10)
  } catch {
    return []
  }
}

const RELEASE_PLATFORMS = Object.freeze({
  linux: Object.freeze({
    manifestPlatform: 'linux',
    label: 'Arch Linux & Linux x86_64',
    match: /^FaNotes-(\d+\.\d+\.\d+(?:-beta\.\d+)?)-x86_64\.(AppImage|tar\.gz)$/u,
    fileKind: (format) => format === 'AppImage' ? 'appimage' : 'portable',
    files: Object.freeze({
      appimage: Object.freeze({ label: 'AppImage', url: '/download/appimage' }),
      portable: Object.freeze({ label: 'Portables Linux-Archiv', url: '/download/portable' }),
    }),
    installGuideUrl: '/download/install-guide',
  }),
  windows: Object.freeze({
    manifestPlatform: 'windows',
    label: 'Windows 10/11 x64',
    match: /^FaNotes-(Setup|Portable)-(\d+\.\d+\.\d+(?:-beta\.\d+)?)-x64\.exe$/u,
    fileKind: (format) => format === 'Setup' ? 'installer' : 'portable',
    files: Object.freeze({
      installer: Object.freeze({ label: 'Windows-Installer', url: '/download/windows-installer' }),
      portable: Object.freeze({ label: 'Windows Portable', url: '/download/windows-portable' }),
    }),
    installGuideUrl: '/download/windows-guide',
  }),
})

const discoverPlatformRelease = async (platform, entries, checksums, channel = 'stable') => {
  const config = RELEASE_PLATFORMS[platform]
  const candidates = new Map()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = config.match.exec(entry.name)
    if (!match) continue
    const version = platform === 'linux' ? match[1] : match[2]
    const format = platform === 'linux' ? match[2] : match[1]
    const current = candidates.get(version) || {}
    current[config.fileKind(format)] = entry.name
    candidates.set(version, current)
  }
  const requiredKinds = Object.keys(config.files)
  const version = [...candidates.keys()].sort(compareVersions)
    .find((candidate) => (
      (channel === 'beta' || !isBetaVersion(candidate)) &&
      requiredKinds.every((kind) => candidates.get(candidate)?.[kind])
    ))
  if (!version) return null

  const files = candidates.get(version)
  const described = await Promise.all(requiredKinds.map(async (kind) => {
    const fileName = files[kind]
    const stats = await fs.stat(join(RELEASE_DIR, fileName))
    return [kind, {
      kind,
      label: config.files[kind].label,
      fileName,
      sizeBytes: stats.size,
      sha256: checksums.get(fileName) || null,
      url: config.files[kind].url,
      modifiedAt: stats.mtimeMs,
    }]
  }))
  const packages = Object.fromEntries(described)
  return {
    product: 'FaNotes',
    version,
    platform: config.label,
    manifestPlatform: config.manifestPlatform,
    releasedAt: new Date(Math.max(...Object.values(packages).map((file) => file.modifiedAt))).toISOString(),
    packages,
    checksumsUrl: '/download/checksums',
    installGuideUrl: config.installGuideUrl,
    changes: await changelogFor(version),
  }
}

const discoverReleases = async (channel = 'stable') => {
  if (!['stable', 'beta'].includes(channel)) throw new Error('Unbekannter Release-Kanal.')
  const [entries, checksums] = await Promise.all([
    fs.readdir(RELEASE_DIR, { withFileTypes: true }),
    checksumMap(),
  ])
  const [linux, windows] = await Promise.all([
    discoverPlatformRelease('linux', entries, checksums, channel),
    discoverPlatformRelease('windows', entries, checksums, channel),
  ])
  if (!linux) throw new Error('Kein vollständiger FaNotes-Linux-Release gefunden.')
  return { linux, windows }
}

const discoverRelease = async () => {
  const { linux, windows } = await discoverReleases()
  return {
    product: 'FaNotes',
    version: linux.version,
    platform: windows ? 'Windows 10/11 & Linux x86_64' : linux.platform,
    releasedAt: linux.releasedAt,
    appimage: linux.packages.appimage,
    portable: linux.packages.portable,
    linux,
    windows,
    checksumsUrl: '/download/checksums',
    installGuideUrl: linux.installGuideUrl,
    changes: linux.changes,
  }
}

const readDeltaHeader = async (filePath) => {
  const stats = await fs.lstat(filePath)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < DELTA_MAGIC.length + 6) throw new Error('Das Delta-Paket ist keine sichere reguläre Datei.')
  const handle = await fs.open(filePath, 'r')
  try {
    const prefix = Buffer.alloc(DELTA_MAGIC.length + 4)
    const prefixRead = await handle.read(prefix, 0, prefix.length, 0)
    if (prefixRead.bytesRead !== prefix.length || !prefix.subarray(0, DELTA_MAGIC.length).equals(DELTA_MAGIC)) throw new Error('Das Delta-Paket besitzt keine gültige Kennung.')
    const headerBytes = prefix.readUInt32BE(DELTA_MAGIC.length)
    if (!headerBytes || headerBytes > MAX_DELTA_HEADER_BYTES || prefix.length + headerBytes >= stats.size) throw new Error('Der Kopf des Delta-Pakets ist ungültig.')
    const encoded = Buffer.alloc(headerBytes)
    const headerRead = await handle.read(encoded, 0, encoded.length, prefix.length)
    if (headerRead.bytesRead !== encoded.length) throw new Error('Der Kopf des Delta-Pakets ist unvollständig.')
    return { header: JSON.parse(encoded.toString('utf8')), stats }
  } finally {
    await handle.close()
  }
}

const deltaForRelease = async (release, currentVersion, channel = 'stable') => {
  if (!release || compareSemanticVersions(release.version, currentVersion) <= 0) return null
  const platform = release.manifestPlatform
  const fileName = `FaNotes-Delta-${platform}-x64-${currentVersion}-to-${release.version}.fndelta`
  const fullPath = join(RELEASE_DIR, fileName)
  let parsed
  try {
    parsed = await readDeltaHeader(fullPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  const { header, stats } = parsed
  const checksums = await checksumMap()
  const patchSha256 = checksums.get(fileName)
  const expectedKind = platform === 'linux' ? 'appimage' : 'app-asar'
  const expectedTargetName = platform === 'linux' ? release.packages.appimage.fileName : 'app.asar'
  if (
    header?.format !== DELTA_FORMAT || header.platform !== platform || header.baseVersion !== currentVersion || header.targetVersion !== release.version ||
    header.source?.kind !== expectedKind || header.target?.kind !== expectedKind || header.target?.fileName !== expectedTargetName ||
    !Number.isSafeInteger(header.source?.sizeBytes) || !Number.isSafeInteger(header.target?.sizeBytes) ||
    !SHA256_PATTERN.test(header.source?.sha256 || '') || !SHA256_PATTERN.test(header.target?.sha256 || '') || !patchSha256
  ) throw new Error(`Das Delta-Paket ${fileName} passt nicht zum Release.`)
  if (platform === 'linux' && (header.target.sizeBytes !== release.packages.appimage.sizeBytes || header.target.sha256 !== release.packages.appimage.sha256)) {
    throw new Error('Das Linux-Delta-Ziel stimmt nicht mit dem veröffentlichten AppImage überein.')
  }
  // A compression-format transition can technically produce a valid delta
  // that is almost as large as the complete package. Downloading that patch
  // and reconstructing the target would waste bandwidth, CPU time and battery.
  // In that one-time case, advertise the already signed full package instead.
  if (stats.size >= header.target.sizeBytes * MAX_DELTA_TO_TARGET_RATIO) return null
  return {
    format: DELTA_FORMAT,
    fileName,
    url: channel === 'beta'
      ? `${PUBLIC_ORIGIN}/download/delta/${platform}-x64/beta/${currentVersion}`
      : `${PUBLIC_ORIGIN}/download/delta/${platform}-x64/${currentVersion}`,
    sizeBytes: stats.size,
    sha256: patchSha256,
    source: {
      kind: header.source.kind,
      sizeBytes: header.source.sizeBytes,
      sha256: header.source.sha256,
    },
    target: {
      kind: header.target.kind,
      fileName: header.target.fileName,
      sizeBytes: header.target.sizeBytes,
      sha256: header.target.sha256,
    },
  }
}

const signedUpdateManifest = async (release, currentVersion, language, channel = 'stable') => {
  if (!release || Object.values(release.packages).some((candidate) => !candidate.sha256)) {
    throw new Error('Der aktuelle Release besitzt keine vollständigen SHA-256-Prüfsummen.')
  }
  const payload = {
    schemaVersion: 1,
    product: 'FaNotes',
    channel,
    platform: release.manifestPlatform,
    arch: 'x64',
    currentVersion,
    latestVersion: release.version,
    updateAvailable: compareSemanticVersions(release.version, currentVersion) > 0,
    mandatory: false,
    publishedAt: release.releasedAt,
    // Localize before signing: the transported bytes and the verified payload
    // must always describe the same manifest in every supported language.
    releaseNotes: release.changes.map((note) => localizeExactText(note, language)),
    packages: Object.fromEntries(Object.entries(release.packages).map(([kind, candidate]) => [kind, {
      fileName: candidate.fileName,
      url: `${PUBLIC_ORIGIN}${channel === 'beta' ? `/download/beta/${kind === 'appimage' ? 'appimage' : kind === 'installer' ? 'windows-installer' : release.manifestPlatform === 'windows' ? 'windows-portable' : 'portable'}` : candidate.url}`,
      sizeBytes: candidate.sizeBytes,
      sha256: candidate.sha256,
    }])),
    delta: await deltaForRelease(release, currentVersion, channel),
    websiteUrl: `${PUBLIC_ORIGIN}/`,
  }
  const { privateKey, keyId } = await updateSigningMaterial()
  return {
    ...payload,
    signature: {
      algorithm: 'ed25519',
      keyId,
      value: sign(null, Buffer.from(stableStringify(payload)), privateKey).toString('base64'),
    },
  }
}

const deltaDownload = async (request, response, platform, currentVersion, channel = 'stable') => {
  const releases = await discoverReleases(channel)
  const delta = await deltaForRelease(releases[platform], currentVersion, channel)
  if (!delta) throw new Error('Für diese Basisversion ist kein differentielles Update verfügbar.')
  response.statusCode = 200
  response.setHeader('Content-Disposition', `attachment; filename="${delta.fileName}"`)
  response.setHeader('Content-Type', 'application/vnd.fanotes.delta')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Accel-Redirect', `${INTERNAL_DOWNLOAD_PREFIX}${encodeURIComponent(delta.fileName)}`)
  response.setHeader('X-FaNotes-Version', releases[platform].version)
  response.end()
}

const releaseDownload = async (request, response, kind, channel = 'stable') => {
  const releases = await discoverReleases(channel)
  const target = kind === 'appimage'
    ? releases.linux.packages.appimage
    : kind === 'portable'
      ? releases.linux.packages.portable
      : kind === 'windows-installer'
        ? releases.windows?.packages.installer
        : kind === 'windows-portable'
          ? releases.windows?.packages.portable
          : kind === 'checksums'
            ? { fileName: 'SHA256SUMS', label: 'Prüfsummen' }
            : kind === 'windows-guide'
              ? { fileName: 'INSTALL_WINDOWS.md', label: 'Windows-Installationsanleitung' }
              : { fileName: 'INSTALL_ARCH.md', label: 'Linux-Installationsanleitung' }
  if (!target) throw new Error('Für diese Plattform ist noch kein vollständiger Release verfügbar.')
  const fullPath = join(RELEASE_DIR, target.fileName)
  const stats = await fs.stat(fullPath)
  if (!stats.isFile()) throw new Error('Download nicht gefunden.')
  const downloadName = target.fileName.replaceAll('"', '')
  const releaseVersion = kind.startsWith('windows') ? releases.windows?.version ?? releases.linux.version : releases.linux.version
  if (['appimage', 'portable', 'windows-installer', 'windows-portable'].includes(kind)) {
    await analytics.recordDownload(request, { artifact: kind, version: releaseVersion }).catch((error) => {
      console.warn('FaNotes-Downloadstatistik konnte nicht gespeichert werden:', error?.message ?? error)
    })
  }
  response.statusCode = 200
  response.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`)
  response.setHeader('Content-Type', kind === 'appimage'
    ? 'application/vnd.appimage'
    : kind === 'portable'
      ? 'application/gzip'
      : kind === 'windows-installer' || kind === 'windows-portable'
        ? 'application/vnd.microsoft.portable-executable'
        : 'text/plain; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Accel-Redirect', `${INTERNAL_DOWNLOAD_PREFIX}${encodeURIComponent(target.fileName)}`)
  response.setHeader('X-FaNotes-Version', releaseVersion)
  response.end()
}

const staticPathFor = (pathname) => {
  const decoded = decodeURIComponent(pathname)
  const requested = decoded === '/'
    ? 'index.html'
    : decoded.endsWith('/')
      ? `${decoded.replace(/^\/+/, '')}index.html`
      : decoded.replace(/^\/+/, '')
  const candidate = resolve(PUBLIC_DIR, normalize(requested))
  if (candidate !== PUBLIC_DIR && !candidate.startsWith(`${PUBLIC_DIR}${sep}`)) return null
  return candidate
}

const serveStatic = async (request, response, pathname) => {
  const filePath = staticPathFor(pathname)
  if (!filePath) return false
  let stats
  try {
    stats = await fs.stat(filePath)
  } catch {
    return false
  }
  // Only these inert, lazy OCR graphs may exceed the general static limit.
  // Keep every wider limit bound to exact paths so another oversized file can
  // never become publicly readable by accident.
  const maximumBytes = pathname === '/notes/ocr/pylaia-iam.onnx'
      ? MAX_NEURAL_TEXT_MODEL_BYTES
    : [
        '/notes/ocr/fanotes-trocr/onnx/encoder_model.onnx',
        '/notes/ocr/fanotes-trocr/onnx/decoder_model_merged.onnx',
        '/notes/ocr/fanotes-trocr-web/onnx/encoder_model.onnx',
        '/notes/ocr/fanotes-trocr-web/onnx/decoder_model_merged.onnx',
      ].includes(pathname)
      ? MAX_TROCR_MODEL_BYTES
    : MAX_STATIC_BYTES
  if (!stats.isFile() || stats.size > maximumBytes) return false
  const etag = `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304)
    response.end()
    return true
  }
  const extension = extname(filePath).toLowerCase()
  const immutable = pathname.startsWith('/assets/') || pathname.includes('/assets/')
  response.writeHead(200, {
    'Content-Type': MIME_TYPES.get(extension) || 'application/octet-stream',
    'Content-Length': stats.size,
    ETag: etag,
    'Cache-Control': immutable ? 'public, max-age=2592000, immutable' : 'no-cache',
  })
  if (request.method === 'HEAD') response.end()
  else {
    const stream = createReadStream(filePath)
    stream.once('error', (error) => {
      console.warn(`Statische Datei konnte nicht gelesen werden (${pathname}):`, error?.message ?? error)
      if (!response.destroyed) response.destroy()
    })
    stream.pipe(response)
  }
  return true
}

const server = createServer(async (request, response) => {
  try {
    response.fanotesLanguage = languageForRequest(request)
    if (!request.url) {
      json(response, 400, { error: 'Die Anfrage besitzt keine gültige Adresse.' })
      return
    }
    const url = new URL(request.url, 'http://localhost')
    if (await handleBackupRequest(request, response, url)) return
    if (await handleAiProxyRequest(request, response, url)) return
    if (url.pathname === '/api/v1/analytics/event') {
      if (request.method !== 'POST') {
        json(response, 405, { error: 'Nur POST ist für Statistikereignisse erlaubt.' }, { Allow: 'POST' })
        return
      }
      try {
        await analytics.recordPublicEvent(request)
        response.writeHead(204, { 'Cache-Control': 'no-store' })
        response.end()
      } catch (error) {
        json(response, Number(error?.statusCode) || 400, { error: error?.message || 'Ungültiges Statistikereignis.' })
      }
      return
    }
    if (!['GET', 'HEAD'].includes(request.method || '')) {
      json(response, 405, { error: 'Nur GET und HEAD sind erlaubt.' }, { Allow: 'GET, HEAD' })
      return
    }
    if (url.pathname === '/notes') {
      response.writeHead(308, { Location: '/notes/', 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    if (url.pathname === '/api/health') {
      const releases = await discoverReleases()
      json(response, 200, { status: 'ok', version: releases.linux.version, windowsVersion: releases.windows?.version ?? null })
      return
    }
    if (url.pathname === '/api/release') {
      json(response, 200, await discoverRelease())
      return
    }
    if (url.pathname === '/api/v1/analytics/summary') {
      json(response, 200, await analytics.summary(), {}, false)
      return
    }
    const updatePlatform = url.pathname === '/api/v1/updates/linux-x64'
      ? 'linux'
      : url.pathname === '/api/v1/updates/windows-x64'
        ? 'windows'
        : null
    if (updatePlatform) {
      const currentVersion = url.searchParams.get('current') || ''
      const channel = url.searchParams.get('channel') || 'stable'
      if (!VERSION_PATTERN.test(currentVersion)) {
        json(response, 400, { error: 'Der Parameter „current“ muss eine semantische Version sein.' })
        return
      }
      if (!['stable', 'beta'].includes(channel)) {
        json(response, 400, { error: 'Dieser Update-Kanal wird nicht unterstützt.' })
        return
      }
      const releases = await discoverReleases(channel)
      // A signed manifest must be emitted byte-for-byte from the object that was
      // signed. Language selection therefore happens before Ed25519 signing.
      json(response, 200, await signedUpdateManifest(releases[updatePlatform], currentVersion, response.fanotesLanguage, channel), {}, false)
      return
    }
    const deltaMatch = /^\/download\/delta\/(linux|windows)-x64\/(?:(beta)\/)?(\d+\.\d+\.\d+(?:-beta\.\d+)?)$/u.exec(url.pathname)
    if (deltaMatch) {
      await deltaDownload(request, response, deltaMatch[1], deltaMatch[3], deltaMatch[2] ? 'beta' : 'stable')
      return
    }
    const downloadMatch = /^\/download\/(?:(beta)\/)?(appimage|portable|windows-installer|windows-portable|checksums|install-guide|windows-guide)$/u.exec(url.pathname)
    if (downloadMatch) {
      await releaseDownload(request, response, downloadMatch[2], downloadMatch[1] ? 'beta' : 'stable')
      return
    }
    if (await serveStatic(request, response, url.pathname)) return
    json(response, 404, { error: 'Nicht gefunden.' })
  } catch (error) {
    console.error(new Date().toISOString(), request.method, request.url, error)
    json(response, 503, { error: 'Der aktuelle FaNotes-Release ist vorübergehend nicht verfügbar.' })
  }
})

server.keepAliveTimeout = 65_000
server.headersTimeout = 70_000
server.requestTimeout = 30_000

const backupService = await initializeBackupService()

server.listen(PORT, HOST, () => {
  console.log(`FaNotes website listening on http://${HOST}:${PORT}`)
  console.log(`Release source: ${RELEASE_DIR}`)
  console.log(`Protected backup store: ${backupService.root}`)
})

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
