// Opt-in diagnostics, renderer side. Everything here is local until the user
// has switched a toggle on (daily report) or pressed "Jetzt Logs senden".
import { APP_VERSION } from './appVersion'
import { diagnosticListeners } from './bugReport'
import {
  COUNTER_NAME,
  DIAGNOSTICS_MAX_LOGS,
  DIAGNOSTICS_ORIGIN,
  DIAGNOSTICS_PATH,
  buildDiagnosticsPayload,
  dailySendDue,
  describeError,
  errorGroupKey,
  identityFromPath,
  newInstallId,
  type DescribedError,
  type DiagnosticsConsent,
  type DiagnosticsContext,
  type DiagnosticsPayload,
} from './diagnostics.mjs'

type Stored = { counters: Record<string, number>; errors: Record<string, number> }
type LogEntry = DescribedError & { at: number }

const KEY_ID = 'fanotes.diagnostics.installId'
const KEY_LAST = 'fanotes.diagnostics.lastSentAt'
const KEY_STORE = 'fanotes.diagnostics.counters'

let consent: DiagnosticsConsent = { usage: false, logs: false }
let store: Stored = { counters: {}, errors: {} }
let logs: LogEntry[] = []
let context: DiagnosticsContext = {}
let vault = { notes: 0, bytes: 0 }
let startupMs = 0
let installed = false
let dirty = false
let flushTimer: number | undefined

const read = (key: string) => { try { return window.localStorage.getItem(key) } catch { return null } }
const write = (key: string, value: string | null) => {
  try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value) } catch { /* private mode */ }
}

export const getInstallId = () => {
  const existing = read(KEY_ID)
  if (existing && /^[0-9a-f]{32}$/u.test(existing)) return existing
  const created = newInstallId()
  write(KEY_ID, created)
  return created
}
export const rotateInstallId = () => { const created = newInstallId(); write(KEY_ID, created); return created }

const wipeLocal = () => { store = { counters: {}, errors: {} }; logs = []; write(KEY_STORE, null) }

const flush = () => {
  flushTimer = undefined
  if (!dirty || !consent.usage) return
  dirty = false
  write(KEY_STORE, JSON.stringify(store))
}
const touch = () => {
  dirty = true
  if (flushTimer === undefined) flushTimer = window.setTimeout(flush, 30_000)
}

export const recordFeature = (name: string) => {
  if (!consent.usage || !COUNTER_NAME.test(name)) return
  store.counters[name] = (store.counters[name] ?? 0) + 1
  touch()
}

const recordError = (error: unknown, fallbackMessage = '') => {
  // Only a class, a code, bundle frames and a hash are kept. The message text is dropped here.
  const entry = describeError(error, fallbackMessage)
  if (consent.usage) {
    const key = errorGroupKey(entry)
    store.errors[key] = (store.errors[key] ?? 0) + 1
    touch()
  }
  // The ring lives in memory only. It is sent only with a toggle or an explicit click.
  logs = [...logs, { ...entry, at: Date.now() }].slice(-DIAGNOSTICS_MAX_LOGS)
}

const install = () => {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('error', (event) => recordError(event.error, event.message))
  window.addEventListener('unhandledrejection', (event) => recordError(event.reason))
  window.addEventListener('pagehide', flush)
  diagnosticListeners.add((event) => {
    if (event.kind === 'tool' && event.tool) recordFeature(`tool.${event.tool.toLowerCase().replace(/[^a-z0-9]+/gu, '-').slice(0, 30)}`)
    else if (event.kind === 'error' && event.message) recordError(null, event.message)
  })
}

export const configureDiagnostics = (next: DiagnosticsConsent, ctx: { vaultPath?: string } = {}) => {
  consent = { usage: next.usage === true, logs: next.logs === true }
  context = identityFromPath(ctx.vaultPath ?? '')
  install()
  if (consent.usage && !dirty && Object.keys(store.counters).length === 0) {
    try { const saved = JSON.parse(read(KEY_STORE) || 'null') as Stored | null; if (saved?.counters) store = { counters: saved.counters, errors: saved.errors ?? {} } } catch { /* ignore */ }
  }
  if (!consent.usage && !consent.logs) wipeLocal()
  else if (!consent.usage) { store = { counters: {}, errors: {} }; write(KEY_STORE, null) }
}

export const setDiagnosticsVault = (notes: number, bytes: number) => { vault = { notes, bytes } }
export const markStartupReady = () => { if (!startupMs && typeof performance !== 'undefined') startupMs = performance.now() }

const appInfo = () => ({
  version: APP_VERSION,
  platform: typeof window !== 'undefined' ? String(window.fanotes?.platform ?? '') : '',
  arch: '',
  language: typeof document !== 'undefined' ? document.documentElement.lang.slice(0, 2) : '',
})

/** The exact JSON that would leave the device. `assumeConsent` shows it before a toggle is on. */
export const previewDiagnostics = (options: { manual?: boolean; comment?: string; assumeConsent?: boolean } = {}): DiagnosticsPayload | null =>
  buildDiagnosticsPayload({
    consent: options.assumeConsent ? { usage: true, logs: true } : consent,
    installId: getInstallId(),
    app: appInfo(),
    usage: { counters: store.counters, errors: store.errors, perf: { startupMs }, vault },
    logs,
    comment: options.comment,
    context,
    manual: options.manual,
  })

const post = async (payload: DiagnosticsPayload) => {
  const response = await fetch(`${DIAGNOSTICS_ORIGIN}${DIAGNOSTICS_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
  return response.ok
}

/** Called on a timer; sends at most one report per day and only while a toggle is on. */
export const sendDailyIfDue = async (now = Date.now()) => {
  if (!dailySendDue(consent, Number(read(KEY_LAST)) || 0, now)) return false
  const payload = previewDiagnostics()
  if (!payload) return false
  try {
    if (!(await post(payload))) return false
  } catch {
    return false
  }
  write(KEY_LAST, String(now))
  store = { counters: {}, errors: {} }
  logs = []
  write(KEY_STORE, null)
  return true
}

/** Explicit "Jetzt Logs senden": scrubbed recent errors plus an optional comment. */
export const sendLogsNow = async (comment: string) => {
  const manualLogs = [...logs]
  const payload = buildDiagnosticsPayload({
    consent: { logs: true },
    manual: true,
    installId: getInstallId(),
    app: appInfo(),
    logs: manualLogs,
    comment,
    context,
  })
  if (!payload) return false
  try { return await post(payload) } catch { return false }
}

export const deleteMyDiagnostics = async () => {
  const id = getInstallId()
  let ok = false
  try {
    const response = await fetch(`${DIAGNOSTICS_ORIGIN}${DIAGNOSTICS_PATH}/${id}`, { method: 'DELETE', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
    ok = response.ok
  } catch { ok = false }
  wipeLocal()
  write(KEY_LAST, null)
  if (ok) rotateInstallId()
  return ok
}
