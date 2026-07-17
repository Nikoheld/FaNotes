import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, join, resolve, sep } from 'node:path'
import { localizeResponse } from './i18n.mjs'

const BACKUP_ROOT = resolve(process.env.FANOTES_BACKUP_DIR || '/var/lib/fanotes-backups')
const PUBLIC_ORIGIN = process.env.FANOTES_PUBLIC_ORIGIN || 'https://fanotes.fasrv.ch'
const ENROLLMENT_TOKEN_PATH = resolve(process.env.FANOTES_BACKUP_ENROLLMENT_TOKEN_PATH || '/etc/fanotes/backup-enrollment-token')
const CREDENTIAL_FILE = 'credential.json'
const SNAPSHOT_FILE = 'snapshot.json'
const ASSET_DIR = 'assets'
const INCOMING_DIR = '.incoming'
const MAX_VAULTS = 200
const MAX_ASSETS = 1_000
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_PDF_BYTES = 96 * 1024 * 1024
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024
const MAX_VAULT_BYTES = 512 * 1024 * 1024
const MAX_SERVER_BYTES = 8 * 1024 * 1024 * 1024
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_NOTE_BYTES = 16 * 1024 * 1024
const MAX_DRAWING_BYTES = 24 * 1024 * 1024
const MAX_TEXT_BYTES = 128 * 1024 * 1024
const MAX_TRAINING_BYTES = 256 * 1024 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const VAULT_ID_PATTERN = /^[a-f0-9]{32}$/u
const MIME_CONFIG = Object.freeze({
  'image/png': Object.freeze({ extension: 'png', maxBytes: MAX_IMAGE_BYTES }),
  'image/jpeg': Object.freeze({ extension: 'jpg', maxBytes: MAX_IMAGE_BYTES }),
  'image/webp': Object.freeze({ extension: 'webp', maxBytes: MAX_IMAGE_BYTES }),
  'image/gif': Object.freeze({ extension: 'gif', maxBytes: MAX_IMAGE_BYTES }),
  'application/pdf': Object.freeze({ extension: 'pdf', maxBytes: MAX_PDF_BYTES }),
})
const SETTING_KEYS = new Set([
  'theme', 'workspaceBackground', 'accent', 'accentSecondary', 'uiFont', 'editorFont', 'editorFontSize',
  'previewFontSize', 'lineHeight', 'readableLineLength', 'contentWidth', 'showLineNumbers', 'spellcheck',
  'vimMode', 'autosaveDelay', 'sidebarWidth', 'rightPanelWidth', 'compactMode', 'glassEffects', 'reduceMotion',
  'showWordCount', 'showOutline', 'defaultFolder', 'dailyNotesFolder', 'dateFormat', 'paperStyle', 'penColor',
  'penWidth', 'pressureEnabled', 'smoothing', 'scribbleEraseSensitivity', 'recognitionMode', 'lastRecognitionMode',
  'recognitionLanguage', 'autoOpenConversion', 'keepDrawingAfterInsert', 'autoCheckUpdates',
  'autoDownloadUpdates', 'installUpdatesOnQuit', 'updateChannel', 'lmStudioBaseUrl', 'lmStudioModel', 'customCss',
])
const rateWindows = new Map()
const activeVaults = new Set()
let enrollmentToken = null

class BackupError extends Error {
  constructor(status, publicMessage, internalMessage = publicMessage) {
    super(internalMessage)
    this.status = status
    this.publicMessage = publicMessage
  }
}

const fail = (status, publicMessage, internalMessage) => {
  throw new BackupError(status, publicMessage, internalMessage)
}

const writeJson = (response, status, value, extraHeaders = {}) => {
  const body = JSON.stringify(localizeResponse(value, response.fanotesLanguage || 'de'))
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  })
  response.end(body)
}

const clientAddress = (request) => {
  const forwarded = request.headers['x-real-ip']
  return typeof forwarded === 'string' && forwarded.length <= 64 ? forwarded : request.socket.remoteAddress || 'unknown'
}

const rateLimit = (key, maximum, windowMs) => {
  const now = Date.now()
  const current = rateWindows.get(key)
  if (!current || current.until <= now) {
    rateWindows.set(key, { count: 1, until: now + windowMs })
    return
  }
  if (current.count >= maximum) fail(429, 'Zu viele Backup-Anfragen. Bitte versuche es später erneut.')
  current.count += 1
}

const assertMutationOrigin = (request) => {
  if (!['POST', 'PUT', 'DELETE'].includes(request.method || '')) return
  if (request.headers.origin !== PUBLIC_ORIGIN) fail(403, 'Diese Backup-Anfrage stammt nicht von FaNotes.')
  if (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') {
    fail(403, 'Websiteübergreifende Backup-Anfragen sind nicht erlaubt.')
  }
}

const safeJoin = (root, ...segments) => {
  const target = resolve(root, ...segments)
  if (target !== root && !target.startsWith(`${root}${sep}`)) fail(400, 'Ungültiger Backup-Pfad.')
  return target
}

const vaultPath = (id) => safeJoin(BACKUP_ROOT, id)
const credentialPath = (id) => safeJoin(vaultPath(id), CREDENTIAL_FILE)
const snapshotPath = (id) => safeJoin(vaultPath(id), SNAPSHOT_FILE)
const assetPath = (id, digest) => safeJoin(vaultPath(id), ASSET_DIR, digest)

const atomicJson = async (path, value) => {
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await fs.rename(temporary, path)
}

const deriveSecret = (secret, salt) => new Promise((resolvePromise, rejectPromise) => {
  scrypt(secret, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
    if (error) rejectPromise(error)
    else resolvePromise(key)
  })
})

const parseAuthorization = (request) => {
  const raw = request.headers.authorization
  const match = typeof raw === 'string' ? /^FaNotes ([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/u.exec(raw) : null
  if (!match) fail(401, 'Der Backup-Schlüssel fehlt oder ist ungültig.')
  return { id: match[1], secret: match[2] }
}

const authenticate = async (request) => {
  const auth = parseAuthorization(request)
  let credential
  try {
    credential = JSON.parse(await fs.readFile(credentialPath(auth.id), 'utf8'))
  } catch {
    fail(401, 'Der Backup-Schlüssel fehlt oder ist ungültig.')
  }
  if (
    credential?.schemaVersion !== 1 || credential.id !== auth.id ||
    typeof credential.salt !== 'string' || typeof credential.secretHash !== 'string'
  ) fail(401, 'Der Backup-Schlüssel fehlt oder ist ungültig.')
  const expected = Buffer.from(credential.secretHash, 'base64url')
  const actual = await deriveSecret(auth.secret, Buffer.from(credential.salt, 'base64url'))
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    fail(401, 'Der Backup-Schlüssel fehlt oder ist ungültig.')
  }
  return { id: auth.id, credential }
}

const readJsonBody = async (request, maximumBytes) => {
  const declared = Number(request.headers['content-length'] || 0)
  if (declared > maximumBytes) fail(413, 'Die Backup-Daten sind zu groß.')
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > maximumBytes) fail(413, 'Die Backup-Daten sind zu groß.')
    chunks.push(chunk)
  }
  if (!bytes) fail(400, 'Die Backup-Daten fehlen.')
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
  } catch {
    fail(400, 'Das Backup enthält ungültiges JSON.')
  }
}

const streamRequestToFile = async (request, path, maximumBytes) => {
  const declared = Number(request.headers['content-length'] || 0)
  if (!Number.isSafeInteger(declared) || declared <= 0 || declared > maximumBytes) {
    fail(413, `Diese Datei darf höchstens ${Math.round(maximumBytes / 1024 / 1024)} MB groß sein.`)
  }
  const digest = createHash('sha256')
  let bytes = 0
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 })
  try {
    for await (const chunk of request) {
      bytes += chunk.length
      if (bytes > maximumBytes) fail(413, 'Die hochgeladene Datei ist zu groß.')
      digest.update(chunk)
      if (!output.write(chunk)) await new Promise((resolvePromise) => output.once('drain', resolvePromise))
    }
    await new Promise((resolvePromise, rejectPromise) => output.end((error) => error ? rejectPromise(error) : resolvePromise()))
  } catch (error) {
    output.destroy()
    await fs.rm(path, { force: true })
    throw error
  }
  if (bytes !== declared) {
    await fs.rm(path, { force: true })
    fail(400, 'Die hochgeladene Datei ist unvollständig.')
  }
  return { bytes, digest: digest.digest('hex') }
}

const run = (binary, args, { timeoutMs = 30_000, maxOutputBytes = 2 * 1024 * 1024 } = {}) => new Promise((resolvePromise, rejectPromise) => {
  const child = spawn(binary, args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/nonexistent',
      LANG: 'C.UTF-8',
      MAGICK_MEMORY_LIMIT: '128MiB',
      MAGICK_MAP_LIMIT: '256MiB',
      MAGICK_DISK_LIMIT: '512MiB',
      MAGICK_THREAD_LIMIT: '2',
      MAGICK_TIME_LIMIT: '45',
    },
  })
  let stdout = Buffer.alloc(0)
  let stderr = Buffer.alloc(0)
  let exceeded = false
  const append = (current, chunk) => {
    if (current.length + chunk.length > maxOutputBytes) {
      exceeded = true
      child.kill('SIGKILL')
      return current
    }
    return Buffer.concat([current, chunk])
  }
  child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
  child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  child.once('error', (error) => { clearTimeout(timer); rejectPromise(error) })
  child.once('close', (code, signal) => {
    clearTimeout(timer)
    resolvePromise({ code, signal, exceeded, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') })
  })
})

const malwareScan = async (path) => {
  const result = await run('/usr/bin/clamdscan', ['--stream', '--no-summary', path], { timeoutMs: 120_000, maxOutputBytes: 256 * 1024 })
  if (result.code === 1) fail(422, 'Die Datei wurde vom Malware-Schutz abgelehnt.', result.stdout || result.stderr)
  if (result.code !== 0 || result.exceeded) fail(503, 'Der Malware-Scan konnte nicht sicher abgeschlossen werden.', result.stdout || result.stderr)
}

const magicMatches = (bytes, mimeType) => {
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mimeType === 'image/gif') return bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a'
  if (mimeType === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  if (mimeType === 'application/pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-'
  return false
}

const validateMagic = async (path, mimeType) => {
  const handle = await fs.open(path, 'r')
  try {
    const header = Buffer.alloc(16)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (!magicMatches(header.subarray(0, bytesRead), mimeType)) {
      fail(422, 'Dateiendung, MIME-Typ und tatsächlicher Dateiinhalt stimmen nicht überein.')
    }
  } finally {
    await handle.close()
  }
}

const sanitizeImage = async (source, target, extension) => {
  const identify = await run('/usr/bin/magick', [
    'identify', '-limit', 'memory', '128MiB', '-limit', 'map', '256MiB', '-limit', 'disk', '512MiB', '-limit', 'thread', '2',
    '-format', '%w %h %n', `${source}[0]`,
  ], { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 })
  if (identify.code !== 0 || identify.exceeded) fail(422, 'Das Bild konnte nicht sicher gelesen werden.', identify.stderr)
  const [width, height, frames] = identify.stdout.trim().split(/\s+/u).map(Number)
  if (![width, height, frames].every(Number.isSafeInteger) || width < 1 || height < 1 || width > 16_384 || height > 16_384 || width * height > 100_000_000 || frames > 1_000) {
    fail(422, 'Das Bild überschreitet die sicheren Abmessungen.')
  }
  const formatOptions = extension === 'jpg' ? ['-quality', '92']
    : extension === 'webp' ? ['-define', 'webp:lossless=true']
      : extension === 'png' ? ['-define', 'png:exclude-chunks=date,time']
        : []
  const converted = await run('/usr/bin/magick', [
    '-limit', 'memory', '128MiB', '-limit', 'map', '256MiB', '-limit', 'disk', '512MiB', '-limit', 'thread', '2',
    `${source}[0]`, '-auto-orient', '-strip', ...formatOptions, target,
  ], { timeoutMs: 60_000, maxOutputBytes: 256 * 1024 })
  if (converted.code !== 0 || converted.exceeded) fail(422, 'Das Bild konnte nicht sicher neu aufgebaut werden.', converted.stderr)
}

const ACTIVE_PDF_TOKENS = /\/(?:JavaScript|JS|Launch|EmbeddedFile|Filespec|RichMedia|OpenAction|AA|XFA|AcroForm|URI|SubmitForm|GoToR|ImportData|Rendition|Sound|Movie|3D)(?![A-Za-z])/u

const sanitizePdf = async (source, target) => {
  const checked = await run('/usr/bin/qpdf', ['--check', source], { timeoutMs: 60_000, maxOutputBytes: 512 * 1024 })
  if (checked.code !== 0 || checked.exceeded) fail(422, 'Das PDF ist beschädigt oder nicht sicher lesbar.', checked.stderr)
  const encryption = await run('/usr/bin/qpdf', ['--show-encryption', source], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 })
  if (encryption.code !== 0 || !/File is not encrypted/u.test(encryption.stdout)) fail(422, 'Verschlüsselte PDFs können nicht sicher gesichert werden.')
  const normalized = await run('/usr/bin/qpdf', ['--object-streams=disable', '--stream-data=uncompress', '--decode-level=all', source, target], { timeoutMs: 90_000, maxOutputBytes: 512 * 1024 })
  if (normalized.code !== 0 || normalized.exceeded) fail(422, 'Das PDF konnte nicht sicher normalisiert werden.', normalized.stderr)
  const stats = await fs.stat(target)
  if (!stats.isFile() || stats.size > MAX_PDF_BYTES * 2) fail(422, 'Das normalisierte PDF überschreitet das sichere Größenlimit.')
  const decodedNames = (await fs.readFile(target)).toString('latin1').replace(/#([a-f0-9]{2})/giu, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
  if (ACTIVE_PDF_TOKENS.test(decodedNames)) fail(422, 'Das PDF enthält aktive Inhalte, Formulare, externe Aktionen oder eingebettete Dateien.')
  const finalCheck = await run('/usr/bin/qpdf', ['--check', target], { timeoutMs: 60_000, maxOutputBytes: 256 * 1024 })
  if (finalCheck.code !== 0 || finalCheck.exceeded) fail(422, 'Das bereinigte PDF ist nicht konsistent.', finalCheck.stderr)
}

const hashFile = async (path) => {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    hash.update(chunk)
  }
  return { digest: hash.digest('hex'), size }
}

const directoryBytes = async (root) => {
  let total = 0
  let entries
  try { entries = await fs.readdir(root, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const path = safeJoin(root, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(path)
    else if (entry.isFile()) total += (await fs.stat(path)).size
  }
  return total
}

const assertStorageCapacity = async (vaultId, extraBytes) => {
  const [vaultBytes, serverBytes, filesystem] = await Promise.all([
    directoryBytes(vaultPath(vaultId)),
    directoryBytes(BACKUP_ROOT),
    fs.statfs(BACKUP_ROOT),
  ])
  if (vaultBytes + extraBytes > MAX_VAULT_BYTES) fail(413, 'Dieses Backup überschreitet das Limit von 512 MB.')
  if (serverBytes + extraBytes > MAX_SERVER_BYTES || filesystem.bavail * filesystem.bsize - extraBytes < MIN_FREE_BYTES) {
    fail(507, 'Auf dem Backup-Server ist momentan nicht genügend sicher reservierbarer Speicher frei.')
  }
}

const normalizeVaultPath = (value, kind) => {
  const subject = kind === 'Notiz' ? 'Eine Notiz' : kind === 'Ordner' ? 'Ein Ordner' : 'Eine Datei'
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096 || value.includes('\0') || value.startsWith('/') || value.includes('\\')) {
    fail(422, `${subject} enthält einen ungültigen Pfad.`)
  }
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f]/u.test(part))) fail(422, `${subject} enthält einen ungültigen Pfad.`)
  if (kind === 'Notiz' && !value.toLocaleLowerCase('en-US').endsWith('.md')) fail(422, 'Backups dürfen nur Markdown-Notizen enthalten.')
  return value
}

const safeString = (value, label, maximum = 512) => {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(422, `${label} ist ungültig.`)
  return value
}

const safeDate = (value) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(422, 'Ein Zeitstempel im Backup ist ungültig.')
  return new Date(value).toISOString()
}

const safeJsonValue = (value, depth = 0) => {
  if (depth > 16) fail(422, 'Die Backup-Daten sind zu tief verschachtelt.')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(422, 'Das Backup enthält eine ungültige Zahl.')
    return value
  }
  if (typeof value === 'string') {
    if (value.length > 8_000_000 || value.includes('\0')) fail(422, 'Ein Textwert im Backup ist zu groß oder ungültig.')
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 100_000) fail(422, 'Eine Liste im Backup ist zu groß.')
    return value.map((entry) => safeJsonValue(entry, depth + 1))
  }
  if (!value || typeof value !== 'object') fail(422, 'Das Backup enthält einen nicht erlaubten Datentyp.')
  const entries = Object.entries(value)
  if (entries.length > 2_000) fail(422, 'Ein Objekt im Backup besitzt zu viele Felder.')
  const result = Object.create(null)
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail(422, 'Das Backup enthält einen nicht erlaubten Feldnamen.')
    result[key] = safeJsonValue(entry, depth + 1)
  }
  return result
}

const validateDrawing = (entry) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(422, 'Eine Handschriftseite ist ungültig.')
  const drawingJson = safeString(entry.drawingJson, 'Eine Handschriftseite', MAX_DRAWING_BYTES)
  let parsed
  try { parsed = JSON.parse(drawingJson) } catch { fail(422, 'Eine Handschriftseite enthält ungültiges JSON.') }
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1 || !Array.isArray(parsed.strokes) || parsed.strokes.length > 100_000) {
    fail(422, 'Eine Handschriftseite besitzt kein unterstütztes Format.')
  }
  safeJsonValue(parsed)
  return {
    id: safeString(entry.id, 'Handschrift-ID', 160),
    title: safeString(entry.title, 'Handschrift-Titel', 180),
    updatedAt: safeDate(entry.updatedAt),
    imageRelativePath: normalizeVaultPath(entry.imageRelativePath, 'Asset'),
    dataRelativePath: normalizeVaultPath(entry.dataRelativePath, 'Asset'),
    drawingJson,
  }
}

const validateWorksheet = (entry) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.schemaVersion !== 1 || !['image', 'pdf'].includes(entry.kind)) fail(422, 'Ein Arbeitsblatt ist ungültig.')
  const mimeType = safeString(entry.mimeType, 'Arbeitsblatt-MIME-Typ', 64)
  if (!MIME_CONFIG[mimeType] || (entry.kind === 'pdf') !== (mimeType === 'application/pdf')) fail(422, 'Ein Arbeitsblatt besitzt einen ungültigen Dateityp.')
  if (!Array.isArray(entry.textBoxes) || entry.textBoxes.length > 2_000) fail(422, 'Ein Arbeitsblatt enthält zu viele Textfelder.')
  return {
    schemaVersion: 1,
    id: safeString(entry.id, 'Arbeitsblatt-ID', 160),
    title: safeString(entry.title, 'Arbeitsblatt-Titel', 180),
    kind: entry.kind,
    mimeType,
    sourceRelativePath: normalizeVaultPath(entry.sourceRelativePath, 'Asset'),
    dataRelativePath: normalizeVaultPath(entry.dataRelativePath, 'Asset'),
    createdAt: safeDate(entry.createdAt),
    updatedAt: safeDate(entry.updatedAt),
    textBoxes: safeJsonValue(entry.textBoxes),
  }
}

const validateSnapshot = async (id, raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schemaVersion !== 1) fail(422, 'Diese FaNotes-Backup-Version wird nicht unterstützt.')
  if (!Array.isArray(raw.files) || raw.files.length > 10_000 || !Array.isArray(raw.folders) || raw.folders.length > 10_000 || !Array.isArray(raw.assets) || raw.assets.length > MAX_ASSETS || !Array.isArray(raw.drawings) || raw.drawings.length > 10_000 || !Array.isArray(raw.worksheets) || raw.worksheets.length > 10_000) {
    fail(422, 'Das Backup überschreitet die sicheren Datensatzlimits.')
  }
  let textBytes = 0
  const seenPaths = new Set()
  const files = raw.files.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(422, 'Eine Notiz ist ungültig.')
    const path = normalizeVaultPath(entry.path, 'Notiz')
    const content = safeString(entry.content, 'Notizinhalt', MAX_NOTE_BYTES)
    const bytes = Buffer.byteLength(content)
    if (bytes > MAX_NOTE_BYTES) fail(422, 'Eine Notiz ist größer als 16 MB.')
    textBytes += bytes
    if (seenPaths.has(path)) fail(422, 'Das Backup enthält doppelte Pfade.')
    seenPaths.add(path)
    return { path, content, modifiedAt: safeDate(entry.modifiedAt) }
  })
  if (textBytes > MAX_TEXT_BYTES) fail(422, 'Die Markdown-Inhalte überschreiten das sichere Gesamtlimit.')
  const folders = raw.folders.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(422, 'Ein Ordner ist ungültig.')
    const path = normalizeVaultPath(entry.path, 'Ordner')
    if (seenPaths.has(path)) fail(422, 'Das Backup enthält doppelte Pfade.')
    seenPaths.add(path)
    if (entry.color !== undefined && !/^#[a-f0-9]{6}$/iu.test(entry.color)) fail(422, 'Eine Ordnerfarbe ist ungültig.')
    return { path, ...(entry.color ? { color: entry.color } : {}) }
  })
  const assetPaths = new Set()
  const assets = []
  for (const entry of raw.assets) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !SHA256_PATTERN.test(entry.digest || '') || !MIME_CONFIG[entry.mimeType]) fail(422, 'Eine Asset-Referenz ist ungültig.')
    const path = normalizeVaultPath(entry.path, 'Asset')
    if (assetPaths.has(path)) fail(422, 'Das Backup enthält doppelte Asset-Pfade.')
    assetPaths.add(path)
    const stored = await fs.stat(assetPath(id, entry.digest)).catch(() => null)
    if (!stored?.isFile() || stored.isSymbolicLink() || stored.size !== entry.size || entry.size < 1 || entry.size > MIME_CONFIG[entry.mimeType].maxBytes * 2) fail(422, 'Eine referenzierte Datei fehlt oder wurde verändert.')
    assets.push({ path, digest: entry.digest, mimeType: entry.mimeType, size: entry.size })
  }
  const drawings = raw.drawings.map(validateDrawing)
  const worksheets = raw.worksheets.map(validateWorksheet)
  for (const worksheet of worksheets) if (!assetPaths.has(worksheet.sourceRelativePath)) fail(422, 'Die Quelldatei eines Arbeitsblatts fehlt im Backup.')
  const settings = Object.create(null)
  if (!raw.settings || typeof raw.settings !== 'object' || Array.isArray(raw.settings)) fail(422, 'Die Einstellungen im Backup sind ungültig.')
  for (const [key, value] of Object.entries(raw.settings)) if (SETTING_KEYS.has(key)) settings[key] = safeJsonValue(value)
  const training = raw.training === undefined ? { samples: [], labels: [], layouts: [] } : safeJsonValue(raw.training)
  if (!training || typeof training !== 'object' || !Array.isArray(training.samples) || !Array.isArray(training.labels) || !Array.isArray(training.layouts)) fail(422, 'Die Trainingsdaten im Backup sind ungültig.')
  if (Buffer.byteLength(JSON.stringify(training)) > MAX_TRAINING_BYTES) fail(422, 'Die Trainingsdaten überschreiten das sichere Gesamtlimit.')
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    files,
    folders,
    assets,
    drawings,
    worksheets,
    settings,
    onboardingComplete: raw.onboardingComplete === true,
    training,
  }
}

const withVaultLock = async (id, action) => {
  if (activeVaults.has(id)) fail(409, 'Für dieses Backup läuft bereits ein sicherer Speichervorgang.')
  activeVaults.add(id)
  try { return await action() } finally { activeVaults.delete(id) }
}

const registerBackup = async (request, response) => {
  rateLimit(`register:${clientAddress(request)}`, 4, 60 * 60 * 1_000)
  const supplied = request.headers['x-fanotes-enrollment']
  const suppliedHash = createHash('sha256').update(typeof supplied === 'string' ? supplied : '').digest()
  const expectedHash = createHash('sha256').update(enrollmentToken || '').digest()
  if (!enrollmentToken || suppliedHash.length !== expectedHash.length || !timingSafeEqual(suppliedHash, expectedHash)) {
    fail(401, 'Der private Einrichtungs-Code ist ungültig.')
  }
  if (Number(request.headers['content-length'] || 0) > 0 || request.headers['transfer-encoding']) fail(413, 'Die Einrichtungsanfrage darf keine Dateidaten enthalten.')
  await fs.mkdir(BACKUP_ROOT, { recursive: true, mode: 0o700 })
  const vaults = (await fs.readdir(BACKUP_ROOT, { withFileTypes: true })).filter((entry) => entry.isDirectory() && VAULT_ID_PATTERN.test(entry.name))
  if (vaults.length >= MAX_VAULTS) fail(503, 'Der Backup-Dienst kann momentan keine weiteren Tresore anlegen.')
  let id
  do { id = randomBytes(16).toString('hex') } while (vaults.some((entry) => entry.name === id))
  const secret = randomBytes(32).toString('base64url')
  const salt = randomBytes(16)
  const hash = await deriveSecret(secret, salt)
  const createdAt = new Date().toISOString()
  await fs.mkdir(vaultPath(id), { recursive: false, mode: 0o700 })
  await fs.mkdir(safeJoin(vaultPath(id), ASSET_DIR), { mode: 0o700 })
  await fs.mkdir(safeJoin(vaultPath(id), INCOMING_DIR), { mode: 0o700 })
  await atomicJson(credentialPath(id), { schemaVersion: 1, id, salt: salt.toString('base64url'), secretHash: hash.toString('base64url'), createdAt, lastBackupAt: null })
  writeJson(response, 201, { recoveryCode: `fanotes1_${id}_${secret}`, createdAt })
}

const backupStatus = async (response, auth) => {
  const snapshotStats = await fs.stat(snapshotPath(auth.id)).catch(() => null)
  let snapshot = null
  if (snapshotStats?.isFile()) snapshot = JSON.parse(await fs.readFile(snapshotPath(auth.id), 'utf8'))
  writeJson(response, 200, {
    enabled: true,
    lastBackupAt: auth.credential.lastBackupAt || snapshot?.createdAt || null,
    sizeBytes: snapshotStats?.size ? await directoryBytes(vaultPath(auth.id)) : 0,
    counts: snapshot ? { notes: snapshot.files.length, folders: snapshot.folders.length, drawings: snapshot.drawings.length, worksheets: snapshot.worksheets.length, assets: snapshot.assets.length } : null,
  })
}

const uploadAsset = async (request, response, auth, expectedRawDigest) => withVaultLock(auth.id, async () => {
  const mimeType = typeof request.headers['content-type'] === 'string' ? request.headers['content-type'].split(';', 1)[0].trim().toLocaleLowerCase('en-US') : ''
  const config = MIME_CONFIG[mimeType]
  if (!config) fail(415, 'Nur PNG, JPEG, WebP, GIF und PDF sind als Backup-Dateien erlaubt.')
  await assertStorageCapacity(auth.id, Number(request.headers['content-length'] || 0))
  const token = randomBytes(18).toString('hex')
  const source = safeJoin(vaultPath(auth.id), INCOMING_DIR, `${token}.upload`)
  const sanitized = safeJoin(vaultPath(auth.id), INCOMING_DIR, `${token}.${config.extension}`)
  try {
    const uploaded = await streamRequestToFile(request, source, config.maxBytes)
    if (uploaded.digest !== expectedRawDigest) fail(422, 'Die SHA-256-Prüfsumme der Datei stimmt nicht.')
    await malwareScan(source)
    await validateMagic(source, mimeType)
    if (mimeType === 'application/pdf') await sanitizePdf(source, sanitized)
    else await sanitizeImage(source, sanitized, config.extension)
    await validateMagic(sanitized, mimeType)
    await malwareScan(sanitized)
    const clean = await hashFile(sanitized)
    if (clean.size < 1 || clean.size > config.maxBytes * 2) fail(422, 'Die bereinigte Datei überschreitet das sichere Größenlimit.')
    await assertStorageCapacity(auth.id, clean.size)
    const finalPath = assetPath(auth.id, clean.digest)
    try { await fs.rename(sanitized, finalPath) } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      await fs.rm(sanitized, { force: true })
    }
    writeJson(response, 201, { digest: clean.digest, size: clean.size, mimeType })
  } finally {
    await Promise.all([fs.rm(source, { force: true }), fs.rm(sanitized, { force: true })])
  }
})

const saveSnapshot = async (request, response, auth) => withVaultLock(auth.id, async () => {
  const contentType = typeof request.headers['content-type'] === 'string' ? request.headers['content-type'].split(';', 1)[0].trim() : ''
  if (contentType !== 'application/json') fail(415, 'Backup-Metadaten müssen als JSON übertragen werden.')
  const raw = await readJsonBody(request, MAX_SNAPSHOT_BYTES)
  const snapshot = await validateSnapshot(auth.id, raw)
  const encodedBytes = Buffer.byteLength(JSON.stringify(snapshot))
  await assertStorageCapacity(auth.id, encodedBytes)
  await atomicJson(snapshotPath(auth.id), snapshot)
  const keep = new Set(snapshot.assets.map((asset) => asset.digest))
  const storedAssets = await fs.readdir(safeJoin(vaultPath(auth.id), ASSET_DIR), { withFileTypes: true })
  await Promise.all(storedAssets.filter((entry) => entry.isFile() && SHA256_PATTERN.test(entry.name) && !keep.has(entry.name)).map((entry) => fs.rm(assetPath(auth.id, entry.name), { force: true })))
  const credential = { ...auth.credential, lastBackupAt: snapshot.createdAt }
  await atomicJson(credentialPath(auth.id), credential)
  writeJson(response, 200, { savedAt: snapshot.createdAt, sizeBytes: await directoryBytes(vaultPath(auth.id)), counts: { notes: snapshot.files.length, folders: snapshot.folders.length, drawings: snapshot.drawings.length, worksheets: snapshot.worksheets.length, assets: snapshot.assets.length } })
})

const sendSnapshot = async (request, response, auth) => {
  let stats
  try { stats = await fs.stat(snapshotPath(auth.id)) } catch { fail(404, 'Für diesen Schlüssel ist noch kein Backup gespeichert.') }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_SNAPSHOT_BYTES) fail(503, 'Das gespeicherte Backup ist nicht sicher lesbar.')
  response.writeHead(200, {
    'Content-Type': 'application/vnd.fanotes.backup+json; charset=utf-8',
    'Content-Length': stats.size,
    'Content-Disposition': 'attachment; filename="fanotes-backup.json"',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  if (request.method === 'HEAD') response.end()
  else createReadStream(snapshotPath(auth.id)).pipe(response)
}

const sendAsset = async (request, response, auth, digest) => {
  const snapshot = JSON.parse(await fs.readFile(snapshotPath(auth.id), 'utf8').catch(() => fail(404, 'Für diesen Schlüssel ist noch kein Backup gespeichert.')))
  const metadata = snapshot.assets.find((asset) => asset.digest === digest)
  if (!metadata) fail(404, 'Diese Backup-Datei wurde nicht gefunden.')
  const path = assetPath(auth.id, digest)
  const stats = await fs.stat(path).catch(() => null)
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size !== metadata.size) fail(503, 'Die Backup-Datei ist nicht sicher lesbar.')
  response.writeHead(200, {
    'Content-Type': metadata.mimeType,
    'Content-Length': stats.size,
    'Content-Disposition': `attachment; filename="${digest}.${MIME_CONFIG[metadata.mimeType].extension}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  if (request.method === 'HEAD') response.end()
  else createReadStream(path).pipe(response)
}

const deleteBackup = async (response, auth) => withVaultLock(auth.id, async () => {
  await fs.rm(vaultPath(auth.id), { recursive: true, force: true })
  response.writeHead(204, { 'Cache-Control': 'no-store' })
  response.end()
})

export const handleBackupRequest = async (request, response, url) => {
  if (!url.pathname.startsWith('/api/v1/backups')) return false
  try {
    rateLimit(`all:${clientAddress(request)}`, 120, 60 * 1_000)
    assertMutationOrigin(request)
    if (url.pathname === '/api/v1/backups/register' && request.method === 'POST') {
      await registerBackup(request, response)
      return true
    }
    const auth = await authenticate(request)
    rateLimit(`vault:${auth.id}`, 90, 60 * 1_000)
    if (url.pathname === '/api/v1/backups/status' && request.method === 'GET') await backupStatus(response, auth)
    else if (url.pathname === '/api/v1/backups/snapshot' && request.method === 'PUT') await saveSnapshot(request, response, auth)
    else if (url.pathname === '/api/v1/backups/snapshot' && ['GET', 'HEAD'].includes(request.method || '')) await sendSnapshot(request, response, auth)
    else if (url.pathname === '/api/v1/backups' && request.method === 'DELETE') await deleteBackup(response, auth)
    else {
      const upload = /^\/api\/v1\/backups\/assets\/([a-f0-9]{64})$/u.exec(url.pathname)
      const asset = /^\/api\/v1\/backups\/snapshot\/assets\/([a-f0-9]{64})$/u.exec(url.pathname)
      if (upload && request.method === 'PUT') await uploadAsset(request, response, auth, upload[1])
      else if (asset && ['GET', 'HEAD'].includes(request.method || '')) await sendAsset(request, response, auth, asset[1])
      else fail(405, 'Diese Backup-Methode ist nicht erlaubt.')
    }
  } catch (error) {
    const status = error instanceof BackupError ? error.status : 503
    const message = error instanceof BackupError ? error.publicMessage : 'Der sichere Backup-Dienst ist vorübergehend nicht verfügbar.'
    if (!(error instanceof BackupError) || error.status >= 500) console.error(new Date().toISOString(), 'backup', request.method, url.pathname, error.message)
    writeJson(response, status, { error: message }, status === 401 ? { 'WWW-Authenticate': 'FaNotes realm="server-backup"' } : {})
  }
  return true
}

export const initializeBackupService = async () => {
  await fs.mkdir(BACKUP_ROOT, { recursive: true, mode: 0o700 })
  const stats = await fs.lstat(BACKUP_ROOT)
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Das Backup-Ziel ist kein sicheres lokales Verzeichnis.')
  await fs.chmod(BACKUP_ROOT, 0o700)
  const required = ['/usr/bin/clamdscan', '/usr/bin/qpdf', '/usr/bin/magick']
  for (const binary of required) {
    const binaryStats = await fs.stat(binary).catch(() => null)
    if (!binaryStats?.isFile()) throw new Error(`Sicherheitswerkzeug fehlt: ${basename(binary)}`)
  }
  enrollmentToken = (await fs.readFile(ENROLLMENT_TOKEN_PATH, 'utf8')).trim()
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(enrollmentToken)) throw new Error('Der private Backup-Einrichtungs-Code fehlt oder ist unsicher.')
  const scanner = await run('/usr/bin/clamdscan', ['--version'], { timeoutMs: 10_000, maxOutputBytes: 32 * 1024 })
  if (scanner.code !== 0) throw new Error('ClamAV ist nicht einsatzbereit; Backups bleiben geschlossen.')
  return { root: BACKUP_ROOT }
}
