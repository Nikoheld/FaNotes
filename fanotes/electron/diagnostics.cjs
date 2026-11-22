'use strict'

// Send data (crash reports, error diagnostics, performance stats, usage stats).
// No Electron import: main.cjs passes the Electron pieces in, so the checks run in plain Node.
// Nothing here ever reads notes, file names, vault paths, OCR text or ink. Stack traces are cut down
// to "file:line" of the app's own code plus a function name; exception messages are never sent.
// docs: fanotes/docs/DIAGNOSTICS.md

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const { randomBytes } = require('node:crypto')

const SETTINGS_VERSION = 1
const SCHEMA = 2
const ENDPOINT = 'https://fanotes.fasrv.ch/api/v1/diagnostics'
const DAY_MS = 24 * 60 * 60 * 1000
const CRASH_MIN_INTERVAL_MS = 60 * 60 * 1000
const RETRY_COOLDOWN_MS = 30 * 60 * 1000
const FORCE_SEND_AFTER_MS = 3 * DAY_MS
const IDLE_SECONDS = 30
const SEND_DELAY_MS = 20_000
const PERSIST_DELAY_MS = 30_000
const MAX_CRASH_KEYS = 30
const MAX_COUNTERS = 120
const MAX_ERROR_KEYS = 40
const MAX_LOGS = 60
const MAX_PEN_SAMPLES = 1000
const MAX_STARTUPS = 20
const MAX_QUEUE_BYTES = 256 * 1024
const MAX_BODY_BYTES = 48 * 1024

const INSTALL_ID = /^[0-9a-f]{32}$/u
const COUNTER_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/u
const ERROR_CLASSES = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'DOMException', 'AbortError', 'NetworkError', 'QuotaExceededError', 'NotFoundError', 'SecurityError', 'NotAllowedError', 'InvalidStateError', 'DataError', 'OperationError']
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,39}$/u
const ERROR_HASH = /^[0-9a-f]{12}$/u
const ERROR_KEY = /^[A-Za-z]{2,24}\|[A-Z0-9_]{0,40}\|[0-9a-f]{12}$/u
const BUNDLE_FILE = /^[A-Za-z0-9_]{1,40}-[A-Za-z0-9_-]{6,12}\.m?js$/u
const APP_FILE = /^[A-Za-z0-9_.-]{1,60}\.(?:c|m)?js$/u
const FUNCTION_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,60}(?:\.[A-Za-z_$][A-Za-z0-9_$]{0,60}){0,2}$/u
const CRASH_TYPES = ['uncaughtException', 'unhandledRejection', 'render-process-gone', 'child-process-gone', 'renderer-error', 'renderer-rejection']
const GONE_REASONS = ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction']
const CHILD_TYPES = ['Utility', 'Zygote', 'Sandbox helper', 'GPU', 'Pepper Plugin', 'Pepper Plugin Broker', 'Unknown']

// ---------------------------------------------------------------- settings

const DIAGNOSTICS_SETTING_DEFAULTS = Object.freeze({
  diagnosticsEnabled: false,
  diagnosticsCrashes: false,
  diagnosticsLogs: false,
  diagnosticsPerf: false,
  diagnosticsUsage: false,
  diagnosticsSettingsVersion: 0,
  diagnosticsNoticeSeen: false,
})

/**
 * One-time switch to "send data on" for every install that has not been migrated yet (including a
 * fresh one). The version flag makes it run exactly once: a later OFF choice has the version already
 * set and is never touched again.
 */
const migrateDiagnosticsSettings = (settings) => {
  if (!settings || typeof settings !== 'object') return settings
  if (Number(settings.diagnosticsSettingsVersion) >= SETTINGS_VERSION) return settings
  return {
    ...settings,
    diagnosticsEnabled: true,
    diagnosticsCrashes: true,
    diagnosticsLogs: true,
    diagnosticsPerf: true,
    diagnosticsUsage: true,
    diagnosticsSettingsVersion: SETTINGS_VERSION,
    diagnosticsNoticeSeen: false,
  }
}

/** A save from a renderer must never lower the version (that would let the migration run again). */
const keepDiagnosticsVersion = (next, previous) => (
  Number(next?.diagnosticsSettingsVersion) < Number(previous?.diagnosticsSettingsVersion)
    ? { ...next, diagnosticsSettingsVersion: Number(previous.diagnosticsSettingsVersion) }
    : next
)

/** The master switch gates every category. */
const policyFromSettings = (settings) => {
  const on = settings?.diagnosticsEnabled === true
  return {
    any: on && (settings.diagnosticsCrashes === true || settings.diagnosticsLogs === true || settings.diagnosticsPerf === true || settings.diagnosticsUsage === true),
    crashes: on && settings.diagnosticsCrashes === true,
    errors: on && settings.diagnosticsLogs === true,
    perf: on && settings.diagnosticsPerf === true,
    usage: on && settings.diagnosticsUsage === true,
  }
}

// ---------------------------------------------------------------- scrubbing

/** cyrb53: stable 12 hex digits to group equal crashes across installs. */
const hashText = (text) => {
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

const normalizePath = (value) => String(value ?? '').replace(/^file:\/\/\/?/u, '/').replace(/\\/gu, '/').toLowerCase()

/**
 * Frames of the app's own code only, as `{ file, line, fn }`. Paths are dropped entirely (only the base
 * name stays), frames outside the app folder (vault scripts, add-ons, other users' folders, node internals)
 * are dropped, and so is every function name that is not a plain identifier.
 */
const scrubStack = (stack, options = {}) => {
  const roots = (options.appRoots ?? []).map(normalizePath).filter((root) => root.length >= 3)
  const frames = []
  for (const rawLine of String(stack ?? '').split('\n').slice(0, 60)) {
    const match = /^\s*at\s+(?:async\s+)?(?:new\s+)?(?:(\S+)\s+\()?(.+?):(\d{1,7}):\d{1,7}\)?\s*$/u.exec(rawLine)
    if (!match) continue
    const location = normalizePath(match[2])
    const inApp = location.includes('/app.asar/') || location.includes('.asar/') || roots.some((root) => location.startsWith(root.endsWith('/') ? root : `${root}/`))
    if (!inApp) continue
    const file = path.posix.basename(String(match[2]).replace(/\\/gu, '/').replace(/^file:\/\/\/?/u, '/'))
    if (!APP_FILE.test(file)) continue
    const fn = match[1] && FUNCTION_NAME.test(match[1]) ? match[1] : ''
    frames.push({ file, line: Number(match[3]), fn })
    if (frames.length >= 4) break
  }
  return frames
}

const describeMainError = (error, options = {}) => {
  const source = error && typeof error === 'object' ? error : {}
  const name = ERROR_CLASSES.includes(source.name) ? source.name : 'Error'
  const code = typeof source.code === 'string' && ERROR_CODE.test(source.code) ? source.code : ''
  const frames = scrubStack(source.stack, options)
  // The message is deliberately not part of the hash: it can hold file names or note titles.
  const hash = hashText(`${name}|${code}|${frames.map((frame) => `${frame.file}:${frame.line}`).join('|')}`)
  return { class: name, code, frames, hash }
}

// ---------------------------------------------------------------- validation of renderer input

const clampNumber = (value, max) => (Number.isFinite(value) && value >= 0 ? Math.min(max, Math.round(value)) : 0)

const cleanFrames = (frames, pattern) => (Array.isArray(frames) ? frames : [])
  .filter((frame) => frame && typeof frame.file === 'string' && pattern.test(frame.file) && Number.isInteger(frame.line) && frame.line >= 0 && frame.line < 10_000_000)
  .slice(0, 4)
  .map((frame) => ({ file: frame.file, line: frame.line, ...(typeof frame.fn === 'string' && FUNCTION_NAME.test(frame.fn) ? { fn: frame.fn } : {}) }))

const emptyQueue = () => ({ v: 1, crashes: {}, counters: {}, errors: {}, logs: [], pen: [], startups: [], vault: null })

const percentile = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]

const buildPerf = (queue, memory) => {
  const out = {}
  const startups = [...queue.startups].sort((a, b) => a - b)
  if (startups.length) out.startup = { sessions: startups.length, medianMs: percentile(startups, 0.5), maxMs: startups[startups.length - 1] }
  const pen = [...queue.pen].sort((a, b) => a - b)
  if (pen.length >= 10) out.penLatency = { samples: pen.length, p50: percentile(pen, 0.5), p90: percentile(pen, 0.9), p99: percentile(pen, 0.99), max: pen[pen.length - 1] }
  if (memory) out.memory = memory
  return out
}

const bucketOf = (value, edges) => {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  let result = 0
  for (const edge of edges) if (number >= edge) result = edge
  return result
}
const NOTE_EDGES = [0, 1, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000]
const MB_EDGES = [0, 1, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 50000]

/**
 * The exact JSON that leaves the device. Each block exists only when its category is on and has data;
 * with nothing to say there is no payload at all.
 */
const buildBatch = ({ queue, policy, installId, app, now, includeRoutine = true, memory }) => {
  if (!INSTALL_ID.test(installId || '')) return null
  const payload = {
    schemaVersion: SCHEMA,
    kind: 'batch',
    installId,
    sentAt: Math.round(now / 60_000) * 60_000,
    app: { version: String(app?.version ?? '').slice(0, 40), platform: String(app?.platform ?? '').slice(0, 24), arch: String(app?.arch ?? '').slice(0, 16), language: String(app?.language ?? '').slice(0, 8) },
  }
  if (policy.crashes && Object.keys(queue.crashes).length) payload.crashes = Object.values(queue.crashes).map((entry) => ({ ...entry }))
  if (includeRoutine) {
    if (policy.usage || policy.errors) {
      const usage = { counters: {}, errors: {}, vault: { notes: 0, sizeMb: 0 } }
      if (policy.usage) {
        usage.counters = { ...queue.counters }
        if (queue.vault) usage.vault = { notes: bucketOf(queue.vault.notes, NOTE_EDGES), sizeMb: bucketOf(queue.vault.bytes / (1024 * 1024), MB_EDGES) }
      }
      if (policy.errors) usage.errors = { ...queue.errors }
      if (Object.keys(usage.counters).length || Object.keys(usage.errors).length || (policy.usage && queue.vault)) payload.usage = usage
    }
    if (policy.errors && queue.logs.length) payload.logs = queue.logs.slice(-MAX_LOGS)
    if (policy.perf) {
      const perf = buildPerf(queue, memory)
      if (perf.startup || perf.penLatency) payload.perf = perf
    }
  }
  if (!payload.crashes && !payload.usage && !payload.logs && !payload.perf) return null
  return payload
}

const hasRoutineData = (queue, policy) => (
  (policy.usage && (Object.keys(queue.counters).length > 0 || queue.vault))
  || (policy.errors && (Object.keys(queue.errors).length > 0 || queue.logs.length > 0))
  || (policy.perf && (queue.startups.length > 0 || queue.pen.length >= 10))
)

// ---------------------------------------------------------------- service

/**
 * options: { dir, getSettings(), appInfo(), appRoots, now(), post(url, body, headers, signal) -> Promise<{status}>,
 *            isOnline(), isIdle(), memory() -> {...}|null, setTimer(fn, ms) -> handle, clearTimer(handle) }
 */
const createDiagnosticsService = (options) => {
  const dir = options.dir
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle })
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
  const queuePath = path.join(dir, 'diagnostics-queue.json')
  const statePath = path.join(dir, 'diagnostics-state.json')

  let policy = policyFromSettings(options.getSettings?.())
  let queue = null
  let state = null
  let generation = 0
  let sendTimer = null
  let persistTimer = null
  let inflight = null
  let lastAttemptAt = 0

  const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }
  const writeJson = (file, value) => {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`
      fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
      fs.renameSync(temporary, file)
    } catch { /* diagnostics must never throw into the app */ }
  }
  const loadState = () => {
    if (state) return state
    const saved = readJson(statePath)
    state = { installId: INSTALL_ID.test(saved?.installId ?? '') ? saved.installId : '', lastSentAt: Number.isFinite(saved?.lastSentAt) ? saved.lastSentAt : 0, firstSeenAt: Number.isFinite(saved?.firstSeenAt) ? saved.firstSeenAt : now() }
    return state
  }
  const saveState = () => writeJson(statePath, state)
  const loadQueue = () => {
    if (queue) return queue
    const saved = readJson(queuePath)
    queue = saved?.v === 1 ? { ...emptyQueue(), ...saved } : emptyQueue()
    return queue
  }
  const persistNow = () => {
    if (persistTimer) { clearTimer(persistTimer); persistTimer = null }
    if (!queue || !policy.any) return
    const text = JSON.stringify(queue)
    if (text.length > MAX_QUEUE_BYTES) { queue.logs = queue.logs.slice(-10); queue.pen = queue.pen.slice(-200) }
    writeJson(queuePath, queue)
  }
  const persistLater = () => {
    if (persistTimer || !policy.any) return
    persistTimer = setTimer(() => { persistTimer = null; persistNow() }, PERSIST_DELAY_MS)
  }

  const installId = () => {
    const current = loadState()
    if (!current.installId) { current.installId = randomBytes(16).toString('hex'); saveState() }
    return current.installId
  }

  /** Stops everything and deletes whatever was collected. */
  const wipe = () => {
    generation += 1
    if (sendTimer) { clearTimer(sendTimer); sendTimer = null }
    if (persistTimer) { clearTimer(persistTimer); persistTimer = null }
    try { inflight?.abort() } catch { /* already finished */ }
    inflight = null
    queue = emptyQueue()
    try { fs.rmSync(queuePath, { force: true }) } catch { /* nothing to delete */ }
  }

  const memory = () => { try { return options.memory?.() ?? null } catch { return null } }

  const dueState = (at = now()) => {
    const current = loadState()
    const data = loadQueue()
    const since = at - (current.lastSentAt || 0)
    const routine = hasRoutineData(data, policy) && (current.lastSentAt <= 0 || since >= DAY_MS || current.lastSentAt > at + 60_000)
    const crash = policy.crashes && Object.keys(data.crashes).length > 0 && (since >= CRASH_MIN_INTERVAL_MS || current.lastSentAt > at + 60_000)
    return { routine, crash, due: routine || crash, forced: at - (current.lastSentAt || current.firstSeenAt) >= FORCE_SEND_AFTER_MS }
  }

  const schedule = () => {
    if (!policy.any || sendTimer || inflight) return
    if (!dueState().due) return
    sendTimer = setTimer(() => { sendTimer = null; void send().catch(() => undefined) }, SEND_DELAY_MS)
  }

  /** One batch: gzipped, only when something is due, the machine is idle and online. Never throws. */
  const send = async ({ ignoreIdle = false } = {}) => {
    if (!policy.any || inflight) return { sent: false, reason: policy.any ? 'busy' : 'off' }
    const at = now()
    const due = dueState(at)
    if (!due.due) return { sent: false, reason: 'not-due' }
    if (at - lastAttemptAt < RETRY_COOLDOWN_MS && lastAttemptAt > 0) return { sent: false, reason: 'cooldown' }
    if (!(options.isOnline?.() ?? true)) return { sent: false, reason: 'offline' }
    if (!ignoreIdle && !due.forced && !(options.isIdle?.() ?? true)) return { sent: false, reason: 'busy-user' }
    const taken = loadQueue()
    const payload = buildBatch({ queue: taken, policy, installId: installId(), app: options.appInfo?.() ?? {}, now: at, includeRoutine: due.routine, memory: memory() })
    if (!payload) return { sent: false, reason: 'empty' }
    const body = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 })
    if (body.length > MAX_BODY_BYTES) { queue = emptyQueue(); return { sent: false, reason: 'too-large' } }
    lastAttemptAt = at
    const startedGeneration = generation
    const controller = new AbortController()
    inflight = controller
    // What went into this payload leaves the live queue now; a retryable failure puts it back.
    const sentCrashes = payload.crashes ? taken.crashes : {}
    if (payload.crashes) taken.crashes = {}
    const routineTaken = due.routine ? { counters: taken.counters, errors: taken.errors, logs: taken.logs, pen: taken.pen, startups: taken.startups, vault: taken.vault } : null
    if (routineTaken) Object.assign(taken, { counters: {}, errors: {}, logs: [], pen: [], startups: [], vault: null })
    try {
      const response = await options.post(ENDPOINT, body, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, controller.signal)
      if (generation !== startedGeneration) return { sent: false, reason: 'off' }
      const status = Number(response?.status) || 0
      if (status >= 200 && status < 300) {
        loadState().lastSentAt = at
        saveState()
        persistNow()
        return { sent: true }
      }
      // A rejected payload (4xx other than rate limiting) is dropped; the server would refuse it again.
      if (status >= 400 && status < 500 && status !== 429) { persistNow(); return { sent: false, reason: `rejected-${status}` } }
      throw new Error(`status ${status}`)
    } catch {
      if (generation === startedGeneration) {
        // Put the unsent data back in front of whatever was collected meanwhile.
        const merged = loadQueue()
        merged.crashes = { ...sentCrashes, ...merged.crashes }
        if (routineTaken) {
          for (const [name, count] of Object.entries(routineTaken.counters)) merged.counters[name] = (merged.counters[name] ?? 0) + count
          for (const [key, count] of Object.entries(routineTaken.errors)) merged.errors[key] = (merged.errors[key] ?? 0) + count
          merged.logs = [...routineTaken.logs, ...merged.logs].slice(-MAX_LOGS)
          merged.pen = [...routineTaken.pen, ...merged.pen].slice(-MAX_PEN_SAMPLES)
          merged.startups = [...routineTaken.startups, ...merged.startups].slice(-MAX_STARTUPS)
          merged.vault = merged.vault ?? routineTaken.vault
        }
        persistLater()
      }
      return { sent: false, reason: generation === startedGeneration ? 'failed' : 'off' }
    } finally {
      if (inflight === controller) inflight = null
    }
  }

  const touch = (immediate = false) => {
    if (immediate) persistNow(); else persistLater()
    schedule()
  }

  const addCrash = (entry) => {
    if (!policy.crashes) return
    const data = loadQueue()
    const key = `${entry.type}|${entry.process}|${entry.class}|${entry.code}|${entry.reason}|${entry.hash}`
    const known = data.crashes[key]
    if (known) { known.count = Math.min(1_000_000, known.count + 1); known.lastAt = Math.round(now() / 60_000) * 60_000 }
    else if (Object.keys(data.crashes).length < MAX_CRASH_KEYS) data.crashes[key] = { ...entry, count: 1, lastAt: Math.round(now() / 60_000) * 60_000 }
    touch(true)
  }

  return {
    paths: { queuePath, statePath },
    /** Called with the saved settings after every load and save; turning everything off deletes the queue. */
    applySettings(settings) {
      const before = policy
      policy = policyFromSettings(settings)
      if (!policy.any) { if (before.any || fs.existsSync(queuePath)) wipe(); return }
      if (!policy.crashes && queue) queue.crashes = {}
      if (!policy.usage && queue) { queue.counters = {}; queue.vault = null }
      if (!policy.errors && queue) { queue.errors = {}; queue.logs = [] }
      if (!policy.perf && queue) { queue.pen = []; queue.startups = [] }
      schedule()
    },
    policy: () => policy,
    /** type: uncaughtException | unhandledRejection (main process). */
    recordMainException(type, error) {
      if (!policy.crashes || !CRASH_TYPES.includes(type)) return
      addCrash({ type, process: 'main', reason: '', exitCode: 0, ...describeMainError(error, { appRoots: options.appRoots }) })
    },
    recordProcessGone(type, details) {
      if (!policy.crashes || !['render-process-gone', 'child-process-gone'].includes(type)) return
      // Chromium kills its helpers (SIGTERM) while the app quits; received logs showed this as a "crash" in every batch.
      if (options.isQuitting?.()) return
      const reason = GONE_REASONS.includes(details?.reason) ? details.reason : 'abnormal-exit'
      if (reason === 'clean-exit') return
      const childType = CHILD_TYPES.includes(details?.type) ? details.type : 'Unknown'
      const entry = { type, process: type === 'render-process-gone' ? 'renderer' : childType, class: 'Error', code: '', reason, exitCode: clampNumber(Number(details?.exitCode), 0xffffffff), frames: [] }
      addCrash({ ...entry, hash: hashText(`${type}|${entry.process}|${reason}|${entry.exitCode}`) })
    },
    /** Events from the renderer; every field is re-validated here. */
    recordRenderer(event) {
      if (!event || typeof event !== 'object' || !policy.any) return
      const data = loadQueue()
      switch (event.k) {
        case 'crash': {
          if (!policy.crashes || !['renderer-error', 'renderer-rejection'].includes(event.type) || !ERROR_CLASSES.includes(event.class) || !ERROR_HASH.test(event.hash ?? '')) return
          addCrash({ type: event.type, process: 'renderer', class: event.class, code: ERROR_CODE.test(event.code ?? '') ? event.code : '', reason: '', exitCode: 0, frames: cleanFrames(event.frames, BUNDLE_FILE), hash: event.hash })
          return
        }
        case 'error': {
          if (!policy.errors || !ERROR_CLASSES.includes(event.class) || !ERROR_HASH.test(event.hash ?? '')) return
          const code = ERROR_CODE.test(event.code ?? '') ? event.code : ''
          const key = `${event.class}|${code}|${event.hash}`
          if (ERROR_KEY.test(key) && (data.errors[key] || Object.keys(data.errors).length < MAX_ERROR_KEYS)) data.errors[key] = Math.min(1_000_000, (data.errors[key] ?? 0) + 1)
          data.logs = [...data.logs, { at: Math.round(now() / 1000) * 1000, class: event.class, code, frames: cleanFrames(event.frames, BUNDLE_FILE), hash: event.hash }].slice(-MAX_LOGS)
          break
        }
        case 'feature': {
          if (!policy.usage || typeof event.name !== 'string' || !COUNTER_NAME.test(event.name)) return
          if (!data.counters[event.name] && Object.keys(data.counters).length >= MAX_COUNTERS) return
          data.counters[event.name] = Math.min(1_000_000, (data.counters[event.name] ?? 0) + 1)
          break
        }
        case 'pen': {
          if (!policy.perf || !Array.isArray(event.samples)) return
          for (const value of event.samples.slice(0, 500)) {
            if (Number.isFinite(value) && value >= 0 && value < 10_000) data.pen.push(Math.round(value * 10) / 10)
          }
          if (data.pen.length > MAX_PEN_SAMPLES) data.pen = data.pen.slice(-MAX_PEN_SAMPLES)
          break
        }
        case 'vault': {
          if (!policy.usage) return
          data.vault = { notes: clampNumber(Number(event.notes), 10_000_000), bytes: clampNumber(Number(event.bytes), 1e15) }
          break
        }
        default: return
      }
      touch()
    },
    recordStartup(ms) {
      if (!policy.perf) return
      const value = clampNumber(ms, 600_000)
      if (!value) return
      const data = loadQueue()
      data.startups = [...data.startups, Math.round(value / 50) * 50].slice(-MAX_STARTUPS)
      touch()
    },
    /** Quit path: write the queue once; no network. */
    flush: persistNow,
    schedule,
    send,
    dueState,
    /** The JSON that would be sent now with every category assumed on (for the in-app preview). */
    preview() {
      const all = { any: true, crashes: true, errors: true, perf: true, usage: true }
      const data = policy.any ? loadQueue() : emptyQueue()
      return buildBatch({ queue: data, policy: all, installId: installId(), app: options.appInfo?.() ?? {}, now: now(), memory: memory() })
    },
    status() {
      const current = loadState()
      return { installId: current.installId || installId(), lastSentAt: current.lastSentAt || 0, ...policy }
    },
    resetInstallId() {
      const current = loadState()
      current.installId = randomBytes(16).toString('hex')
      current.lastSentAt = 0
      saveState()
      return current.installId
    },
    async deleteRemote(del) {
      const id = installId()
      let ok = false
      try { const status = Number((await del(`${ENDPOINT}/${id}`))?.status) || 0; ok = status >= 200 && status < 300 } catch { ok = false }
      wipe()
      loadState().lastSentAt = 0
      if (ok) this.resetInstallId(); else saveState()
      return ok
    },
    wipe,
  }
}

module.exports = {
  ENDPOINT,
  SETTINGS_VERSION,
  DIAGNOSTICS_SETTING_DEFAULTS,
  migrateDiagnosticsSettings,
  keepDiagnosticsVersion,
  policyFromSettings,
  scrubStack,
  describeMainError,
  buildBatch,
  hashText,
  createDiagnosticsService,
  IDLE_SECONDS,
}
