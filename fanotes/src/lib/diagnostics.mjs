// Opt-in diagnostics: pure helpers (scrubbing, payload building, schedule).
// Nothing in here touches the network, the file system or the vault.

export const DIAGNOSTICS_SCHEMA = 1
export const DIAGNOSTICS_PATH = '/api/v1/diagnostics'
export const DIAGNOSTICS_ORIGIN = 'https://fanotes.fasrv.ch'
export const DIAGNOSTICS_INTERVAL_MS = 24 * 60 * 60 * 1000
export const DIAGNOSTICS_MAX_LOGS = 60
export const DIAGNOSTICS_MAX_COUNTERS = 120
export const DIAGNOSTICS_MAX_MESSAGE = 300
export const DIAGNOSTICS_MAX_COMMENT = 1000
export const COUNTER_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/u
export const INSTALL_ID = /^[0-9a-f]{32}$/u

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

/** Name, home directory and vault words, derived from the vault path (the renderer has no other source). */
export const identityFromPath = (vaultPath) => {
  const path = typeof vaultPath === 'string' ? vaultPath : ''
  const match = /^(\/home\/([^/]+)|\/Users\/([^/]+)|[A-Za-z]:[\\/]Users[\\/]([^\\/]+))/u.exec(path)
  return { vaultPath: path, homeDir: match?.[1] ?? '', userName: match?.[2] ?? match?.[3] ?? match?.[4] ?? '' }
}

// Errors never leave as text. They leave as a class, a code, bundle file:line frames and a hash for grouping.
export const ERROR_CLASSES = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'DOMException', 'AbortError', 'NetworkError', 'QuotaExceededError', 'NotFoundError', 'SecurityError', 'NotAllowedError', 'InvalidStateError', 'DataError', 'OperationError']
export const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,39}$/u
export const ERROR_HASH = /^[0-9a-f]{12}$/u
export const BUNDLE_FILE = /^[A-Za-z0-9_]{1,40}-[A-Za-z0-9_-]{6,12}\.m?js$/u
export const ERROR_KEY = /^[A-Za-z]{2,24}\|[A-Z0-9_]{0,40}\|[0-9a-f]{12}$/u

/** cyrb53: a stable 53-bit hash, 12 hex digits, to group equal errors across installs. */
export const hashText = (text) => {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0').slice(-12)
}

export const describeError = (error, fallbackMessage = '') => {
  const source = error && typeof error === 'object' ? error : {}
  const message = typeof source.message === 'string' ? source.message : typeof error === 'string' ? error : String(fallbackMessage ?? '')
  const name = ERROR_CLASSES.includes(source.name) ? source.name : 'Error'
  const code = typeof source.code === 'string' && ERROR_CODE.test(source.code) ? source.code : ''
  const frames = []
  for (const match of String(source.stack ?? '').matchAll(/([A-Za-z0-9_.-]+\.m?js):(\d{1,7})(?::\d+)?/gu)) {
    if (BUNDLE_FILE.test(match[1])) frames.push({ file: match[1], line: Number(match[2]) })
    if (frames.length >= 3) break
  }
  const normalized = message.toLowerCase().replace(/"[^"]*"|'[^']*'|„[^“]*“|«[^»]*»/gu, '').replace(/\d+/gu, '#').replace(/\s+/gu, ' ').trim().slice(0, 300)
  return { class: name, code, frames, hash: hashText(normalized) }
}
export const errorGroupKey = (entry) => `${entry.class}|${entry.code}|${entry.hash}`

const bucketOf = (value, edges) => {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  let result = 0
  for (const edge of edges) if (number >= edge) result = edge
  return result
}
const NOTE_EDGES = [0, 1, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000]
const MB_EDGES = [0, 1, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 50000]
export const noteCountBucket = (count) => bucketOf(count, NOTE_EDGES)
export const vaultSizeBucketMb = (bytes) => bucketOf(Number(bytes) / (1024 * 1024), MB_EDGES)
export const roundMs = (ms, step = 100) => {
  const number = Number(ms)
  return Number.isFinite(number) && number >= 0 ? Math.min(600_000, Math.round(number / step) * step) : 0
}

export const newInstallId = (randomBytes) => {
  const bytes = randomBytes ?? globalThis.crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Only these (name-checked) counters leave the device. */
export const cleanCounters = (counters) => {
  const out = {}
  for (const [name, count] of Object.entries(counters && typeof counters === 'object' ? counters : {})) {
    if (!COUNTER_NAME.test(name) || !Number.isFinite(count) || count <= 0) continue
    out[name] = Math.min(1_000_000, Math.round(count))
    if (Object.keys(out).length >= DIAGNOSTICS_MAX_COUNTERS) break
  }
  return out
}

/**
 * The exact JSON that is sent. `usage` and `logs` are only included when the
 * matching consent is given; with neither (and no manual comment) there is no
 * payload at all.
 */
export const buildDiagnosticsPayload = (input) => {
  const { consent = {}, installId, app = {}, usage, logs, comment, context = {}, now = Date.now(), manual = false } = input
  if (!INSTALL_ID.test(installId || '')) return null
  const wantUsage = consent.usage === true && !manual
  const wantLogs = consent.logs === true || manual
  const payload = {
    schemaVersion: DIAGNOSTICS_SCHEMA,
    kind: manual ? 'report' : 'daily',
    installId,
    sentAt: Math.round(now / 1000) * 1000,
    app: {
      version: String(app.version ?? '').slice(0, 40),
      platform: String(app.platform ?? '').slice(0, 24),
      arch: String(app.arch ?? '').slice(0, 16),
      language: String(app.language ?? '').slice(0, 8),
    },
  }
  if (wantUsage) {
    payload.usage = {
      counters: cleanCounters(usage?.counters),
      errors: Object.fromEntries(Object.entries(usage?.errors ?? {}).filter(([key, count]) => ERROR_KEY.test(key) && Number(count) > 0).slice(0, 40).map(([key, count]) => [key, Math.min(1_000_000, Math.round(Number(count)))])),
      perf: { startupMs: roundMs(usage?.perf?.startupMs) },
      vault: { notes: noteCountBucket(usage?.vault?.notes), sizeMb: vaultSizeBucketMb(usage?.vault?.bytes) },
    }
  }
  if (wantLogs) {
    payload.logs = (Array.isArray(logs) ? logs : []).slice(-DIAGNOSTICS_MAX_LOGS).flatMap((entry) => {
      if (!ERROR_CLASSES.includes(entry?.class) || !ERROR_HASH.test(entry?.hash ?? '')) return []
      return [{
        at: Math.round(Number(entry.at) / 1000) * 1000 || 0,
        class: entry.class,
        code: ERROR_CODE.test(entry.code ?? '') ? entry.code : '',
        frames: (Array.isArray(entry.frames) ? entry.frames : []).filter((frame) => BUNDLE_FILE.test(frame?.file ?? '') && Number.isInteger(frame.line)).slice(0, 3).map((frame) => ({ file: frame.file, line: frame.line })),
        hash: entry.hash,
      }]
    })
  }
  if (manual && typeof comment === 'string' && comment.trim()) payload.comment = scrubText(comment, context, DIAGNOSTICS_MAX_COMMENT)
  if (!payload.usage && !payload.logs) return null
  return payload
}

export const dailySendDue = (consent, lastSentAt, now = Date.now()) => (
  (consent?.usage === true || consent?.logs === true)
  && (!Number.isFinite(lastSentAt) || lastSentAt <= 0 || now - lastSentAt >= DIAGNOSTICS_INTERVAL_MS || lastSentAt > now + 60_000)
)
