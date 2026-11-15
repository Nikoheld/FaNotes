// Opt-in diagnostics from the apps: anonymous usage counters and scrubbed error
// logs, keyed by a random install id (never an account). One JSONL file per day.
//   POST   /api/v1/diagnostics            store one payload
//   DELETE /api/v1/diagnostics/<install>  delete everything stored for an install id
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'

export const DIAGNOSTICS_MAX_BODY_BYTES = 64 * 1024
export const DIAGNOSTICS_RETENTION_DAYS = 90
export const DIAGNOSTICS_PER_INSTALL_PER_DAY = 12
export const DIAGNOSTICS_PER_IP_PER_HOUR = 60
export const DIAGNOSTICS_MAX_DIR_BYTES = 1024 ** 3
const INSTALL_ID = /^[0-9a-f]{32}$/u
const ERROR_CLASSES = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'DOMException', 'AbortError', 'NetworkError', 'QuotaExceededError', 'NotFoundError', 'SecurityError', 'NotAllowedError', 'InvalidStateError', 'DataError', 'OperationError']
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,39}$/u
const ERROR_HASH = /^[0-9a-f]{12}$/u
const ERROR_KEY = /^[A-Za-z]{2,24}\|[A-Z0-9_]{0,40}\|[0-9a-f]{12}$/u
const BUNDLE_FILE = /^[A-Za-z0-9_]{1,40}-[A-Za-z0-9_-]{6,12}\.m?js$/u
const COUNTER_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/u
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u

// scrub:begin (identical in fanotes/src/lib/diagnostics.mjs and fanotes-site/diagnostics-api.mjs; a check compares them)
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const SYSTEM_WORDS = new Set(['home', 'users', 'user', 'usr', 'var', 'mnt', 'media', 'srv', 'tmp', 'root', 'opt', 'etc', 'lib', 'bin'])
const QUOTES = /[„“”"«»‹›‚‘’'`´][^„“”"«»‹›‚‘’'`´\n]{0,300}[„“”"«»‹›‚‘’'`´]/gu

/**
 * Best-effort removal of anything identifying from free text: URI-decoded first,
 * then secrets, URLs, e-mail addresses, IP addresses, pairing codes, every quoted
 * segment, absolute and relative paths, file names and long tokens. Over-redacting
 * is intended. Free text is only ever sent when the user typed it into the report
 * comment; the client scrubber is the primary defence, the server repeats it.
 */
export const scrubText = (input, context = {}, max = 300) => {
  let text = typeof input === 'string' ? input : String(input ?? '')
  for (let pass = 0; pass < 2; pass += 1) {
    text = text.replace(/(?:%[0-9a-fA-F]{2})+/gu, (run) => { try { return decodeURIComponent(run) } catch { return run } })
  }
  const dirs = [context.homeDir, context.vaultPath].filter((value) => typeof value === 'string' && value.length >= 3).sort((a, b) => b.length - a.length)
  for (const value of dirs) {
    text = text.replace(new RegExp(escapeRegExp(value.replace(/\\/gu, '/')).replace(/\//gu, '[\\\\/]'), 'giu'), '<dir>')
  }
  const words = new Set([context.userName, ...String(context.vaultPath ?? '').split(/[\\/]/u)].filter((word) => typeof word === 'string' && word.length >= 3 && !SYSTEM_WORDS.has(word.toLowerCase())))
  text = text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gu, '<token>')
    .replace(/\b(secret|password|passwort|passwd|token|key|apikey|api[_-]key|authorization|auth|credentials?)\b[ \t]*[:=][^\n]*/giu, '$1: <redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/gu, '<token>')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b|\bsk-[A-Za-z0-9_-]{6,}|\b(?:gh[pousr]_|github_pat_|xox[abprs]-|AIza|glpat-|npm_|pk_live_|sk_live_|rk_live_)[A-Za-z0-9_-]{6,}/gu, '<token>')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)"'<>]+|\bwww\.[^\s)"'<>]+/giu, '<url>')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9._-]+/gu, '<email>')
    .replace(/\[[0-9a-f:.]{2,45}\](?::\d{1,5})?/giu, '<ip>')
    .replace(/(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){0,6}::[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){0,6}(?![\w:])/giu, '<ip>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/gu, '<ip>')
    .replace(/\b\d{3}[- ]\d{3}[- ]\d{3}\b/gu, '<code>')
    .replace(QUOTES, '<quoted>')
    .replace(/<dir>(?:[\\/][^\n,;<>|?*"]*)?/gu, '<path>')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|\/(?:home|Users|mnt|media|srv|var|tmp|root|opt|run|Volumes)\/)[^\n,;<>|?*"]*/gu, '<path>')
    .replace(/[^\s/\\<>]+(?:[\\/][^\s/\\<>]+)+[\\/]?|[\\/][^\s/\\<>]+[\\/]/gu, '<path>')
    .replace(/[^\s<>]+\.(?:md|markdown|famd|pdf|png|jpe?g|gif|webp|svg|story|json|txt|docx?|odt|mp3|wav|m4a|mp4|webm|zip|onetoc2|onepkg)\b/giu, '<file>')
    .replace(/\b[A-Fa-f0-9]{24,}\b/gu, '<hash>')
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b|\b[A-Za-z0-9_-]{40,}\b/gu, '<token>')
  for (const word of words) text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'giu'), '<name>')
  return text.replace(/\s+/gu, ' ').trim().slice(0, max)
}
// scrub:end

const int = (value, max = 1_000_000) => (Number.isFinite(value) && value >= 0 ? Math.min(max, Math.round(value)) : 0)
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')

export const validateDiagnosticsPayload = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Ungültige Nutzlast.' }
  if (body.schemaVersion !== 1) return { ok: false, error: 'Unbekannte Schemaversion.' }
  if (typeof body.installId !== 'string' || !INSTALL_ID.test(body.installId)) return { ok: false, error: 'Ungültige Installations-ID.' }
  if (body.kind !== 'daily' && body.kind !== 'report') return { ok: false, error: 'Ungültige Art.' }
  const app = body.app && typeof body.app === 'object' ? body.app : {}
  const record = {
    schemaVersion: 1,
    kind: body.kind,
    installId: body.installId,
    receivedAt: Date.now(),
    app: { version: text(app.version, 40), platform: text(app.platform, 24), arch: text(app.arch, 16), language: text(app.language, 8) },
  }
  if (body.usage !== undefined) {
    const usage = body.usage
    if (!usage || typeof usage !== 'object') return { ok: false, error: 'Ungültige Nutzungsdaten.' }
    const counters = {}
    for (const [name, count] of Object.entries(usage.counters && typeof usage.counters === 'object' ? usage.counters : {}).slice(0, 120)) {
      if (COUNTER_NAME.test(name) && Number.isFinite(count) && count > 0) counters[name] = int(count)
    }
    const errors = {}
    for (const [key, count] of Object.entries(usage.errors && typeof usage.errors === 'object' ? usage.errors : {}).slice(0, 40)) {
      if (ERROR_KEY.test(key) && Number.isFinite(count) && count > 0) errors[key] = int(count)
    }
    record.usage = {
      counters,
      errors,
      perf: { startupMs: int(usage.perf?.startupMs, 600_000) },
      vault: { notes: int(usage.vault?.notes, 10_000_000), sizeMb: int(usage.vault?.sizeMb, 10_000_000) },
    }
  }
  if (body.logs !== undefined) {
    if (!Array.isArray(body.logs)) return { ok: false, error: 'Ungültige Protokolle.' }
    record.logs = body.logs.slice(-60).flatMap((entry) => {
      if (!ERROR_CLASSES.includes(entry?.class) || !ERROR_HASH.test(entry?.hash ?? '')) return []
      return [{
        at: int(entry.at, 4e12),
        class: entry.class,
        code: typeof entry.code === 'string' && ERROR_CODE.test(entry.code) ? entry.code : '',
        frames: (Array.isArray(entry.frames) ? entry.frames : []).filter((frame) => BUNDLE_FILE.test(frame?.file ?? '') && Number.isInteger(frame.line)).slice(0, 3).map((frame) => ({ file: frame.file, line: frame.line })),
        hash: entry.hash,
      }]
    })
  }
  if (typeof body.comment === 'string' && body.comment.trim()) record.comment = scrubText(body.comment, {}, 1000)
  if (!record.usage && !record.logs) return { ok: false, error: 'Leere Nutzlast.' }
  return { ok: true, record }
}

const dayName = (ms) => new Date(ms).toISOString().slice(0, 10)

export const createDiagnosticsStore = (directory, options = {}) => {
  const root = resolve(directory)
  const now = options.now ?? (() => Date.now())
  const installWindows = new Map()
  const ipWindows = new Map()
  const limit = (map, key, maximum, windowMs) => {
    const at = now()
    const current = map.get(key)
    if (!current || current.until <= at) {
      if (map.size > 20_000) map.clear()
      map.set(key, { count: 1, until: at + windowMs })
      return true
    }
    if (current.count >= maximum) return false
    current.count += 1
    return true
  }
  const maxBytes = options.maxBytes ?? (Number(process.env.FANOTES_DIAGNOSTICS_MAX_BYTES) || DIAGNOSTICS_MAX_DIR_BYTES)
  // One promise chain per day file: appends, deletes and cleanup never interleave.
  const queues = new Map()
  const serial = (name, work) => {
    const run = (queues.get(name) ?? Promise.resolve()).then(work, work)
    queues.set(name, run.catch(() => undefined))
    return run
  }
  let sizeCache = { at: 0, bytes: 0 }
  const dirBytes = async () => {
    if (now() - sizeCache.at < 30_000 && sizeCache.at > 0) return sizeCache.bytes
    let total = 0
    for (const name of await files()) total += (await fs.stat(join(root, name)).catch(() => ({ size: 0 }))).size
    sizeCache = { at: now(), bytes: total }
    return total
  }
  const files = async () => {
    try {
      return (await fs.readdir(root)).filter((name) => DAY_FILE.test(name)).sort()
    } catch {
      return []
    }
  }
  return {
    root,
    async accept(body, ip = 'unknown') {
      if (!limit(ipWindows, ip, DIAGNOSTICS_PER_IP_PER_HOUR, 3_600_000)) return { status: 429, body: { error: 'Zu viele Anfragen.' } }
      const result = validateDiagnosticsPayload(body)
      if (!result.ok) return { status: 400, body: { error: result.error } }
      result.record.receivedAt = now()
      if (!limit(installWindows, result.record.installId, DIAGNOSTICS_PER_INSTALL_PER_DAY, 86_400_000)) return { status: 429, body: { error: 'Zu viele Anfragen.' } }
      const line = `${JSON.stringify(result.record)}\n`
      if ((await dirBytes()) + line.length > maxBytes) return { status: 507, body: { error: 'Speicher voll.' } }
      await fs.mkdir(root, { recursive: true, mode: 0o700 })
      const name = `${dayName(now())}.jsonl`
      await serial(name, () => fs.appendFile(join(root, name), line, { encoding: 'utf8', mode: 0o600 }))
      sizeCache.bytes += line.length
      return { status: 202, body: { ok: true } }
    },
    async cleanup() {
      const cutoff = dayName(now() - DIAGNOSTICS_RETENTION_DAYS * 86_400_000)
      let removed = 0
      for (const name of await files()) {
        if (name.slice(0, 10) < cutoff) { await serial(name, () => fs.rm(join(root, name), { force: true })); removed += 1 }
      }
      return removed
    },
    async deleteInstall(installId) {
      if (!INSTALL_ID.test(installId)) return { status: 400, body: { error: 'Ungültige Installations-ID.' } }
      let deleted = 0
      for (const name of await files()) {
        deleted += await serial(name, async () => {
          const target = join(root, name)
          let source
          try { source = await fs.readFile(target, 'utf8') } catch { return 0 }
          const lines = source.split('\n').filter(Boolean)
          const kept = lines.filter((line) => !line.includes(`"installId":"${installId}"`))
          if (kept.length === lines.length) return 0
          if (kept.length) {
            const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`
            await fs.writeFile(temporary, `${kept.join('\n')}\n`, { mode: 0o600 })
            await fs.rename(temporary, target)
          } else await fs.rm(target, { force: true })
          return lines.length - kept.length
        })
      }
      sizeCache.at = 0
      return { status: 200, body: { ok: true, deleted } }
    },
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
}
const writeJson = (response, status, value) => {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...CORS })
  response.end(body)
}
const readJson = async (request) => {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > DIAGNOSTICS_MAX_BODY_BYTES) throw Object.assign(new Error('Die Anfrage ist zu groß.'), { status: 413 })
    chunks.push(chunk)
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
  } catch {
    throw Object.assign(new Error('Ungültiges JSON.'), { status: 400 })
  }
}
const clientAddress = (request) => {
  const forwarded = request.headers['x-real-ip']
  return typeof forwarded === 'string' && forwarded.length <= 64 ? forwarded : request.socket.remoteAddress || 'unknown'
}

export const createDiagnosticsHandler = (store) => {
  let lastCleanup = 0
  return async (request, response, url) => {
    const match = /^\/api\/v1\/diagnostics(?:\/([0-9a-f]{32}))?$/u.exec(url.pathname)
    if (!match) return false
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { ...CORS, 'Access-Control-Max-Age': '600' })
      response.end()
      return true
    }
    try {
      if (Date.now() - lastCleanup > 6 * 3_600_000) { lastCleanup = Date.now(); void store.cleanup().catch(() => undefined) }
      if (request.method === 'POST' && !match[1]) {
        const result = await store.accept(await readJson(request), clientAddress(request))
        writeJson(response, result.status, result.body)
      } else if (request.method === 'DELETE' && match[1]) {
        const result = await store.deleteInstall(match[1])
        writeJson(response, result.status, result.body)
      } else {
        writeJson(response, 405, { error: 'Nicht erlaubt.' })
      }
    } catch (error) {
      writeJson(response, Number(error?.status) || 400, { error: error?.message || 'Ungültige Anfrage.' })
    }
    return true
  }
}

const defaultStore = createDiagnosticsStore(process.env.FANOTES_DIAGNOSTICS_DIR || '/var/lib/fanotes-diagnostics')
export const handleDiagnosticsRequest = createDiagnosticsHandler(defaultStore)
