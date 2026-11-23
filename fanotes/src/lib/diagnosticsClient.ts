// Send data, renderer side. The renderer only describes events (error class, code, bundle lines, hash,
// feature names, pen latency numbers) and hands them to the Electron main process, which validates them,
// keeps the queue, and does all sending. Nothing leaves from here except an explicit "Jetzt Logs senden".
// Without the desktop bridge (web build) every record call does nothing.
import { APP_VERSION } from './appVersion'
import { diagnosticListeners } from './bugReport'
import {
  COUNTER_NAME,
  DIAGNOSTICS_MAX_LOGS,
  DIAGNOSTICS_ORIGIN,
  DIAGNOSTICS_PATH,
  buildDiagnosticsPayload,
  describeError,
  identityFromPath,
  newInstallId,
  type DescribedError,
  type DiagnosticsContext,
  type DiagnosticsPayload,
} from './diagnostics.mjs'

type LogEntry = DescribedError & { at: number }
export type SendDataConsent = { crashes: boolean; errors: boolean; perf: boolean; usage: boolean }

const KEY_ID = 'fanotes.diagnostics.installId'
const PEN_FLUSH_AT = 120

let consent: SendDataConsent = { crashes: false, errors: false, perf: false, usage: false }
let logs: LogEntry[] = []
let context: DiagnosticsContext = {}
let installed = false
let penSamples: number[] = []
let vault: { notes: number; bytes: number } | null = null
let vaultSent = ''

const bridge = () => (typeof window !== 'undefined' ? window.fanotes?.diagnostics : undefined)
const read = (key: string) => { try { return window.localStorage.getItem(key) } catch { return null } }
const write = (key: string, value: string | null) => {
  try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value) } catch { /* private mode */ }
}

/** The ID used by the explicit report: the desktop one from the main process, else a local one (web). */
const resolveInstallId = async () => {
  const status = await bridge()?.status().catch(() => null)
  if (status?.installId) return status.installId
  const existing = read(KEY_ID)
  if (existing && /^[0-9a-f]{32}$/u.test(existing)) return existing
  const created = newInstallId()
  write(KEY_ID, created)
  return created
}

const flushBuffers = () => {
  const api = bridge()
  if (!api) return
  if (consent.perf && penSamples.length) { api.record({ k: 'pen', samples: penSamples }); penSamples = [] }
  if (consent.usage && vault) {
    const key = `${vault.notes}:${Math.round(vault.bytes / 1048576)}`
    if (key !== vaultSent) { vaultSent = key; api.record({ k: 'vault', notes: vault.notes, bytes: vault.bytes }) }
  }
}

/** One main-thread stall (500 ms or more): its length and the fixed phase word. Nothing else. */
export const recordStall = (ms: number, phase: string) => {
  if (!consent.perf || !Number.isFinite(ms) || ms < 0) return
  bridge()?.record({ k: 'stall', ms: Math.round(ms), phase })
}

export const recordFeature = (name: string) => {
  if (!consent.usage || !COUNTER_NAME.test(name)) return
  bridge()?.record({ k: 'feature', name })
}

/** Pen input latency (ms from the event time stamp to our handler). Buffered; no timer. */
export const recordPenLatency = (ms: number) => {
  if (!consent.perf || !Number.isFinite(ms) || ms < 0) return
  penSamples.push(Math.round(ms * 10) / 10)
  if (penSamples.length >= PEN_FLUSH_AT) flushBuffers()
}

const recordError = (error: unknown, kind: 'crash' | 'error', type = '', fallbackMessage = '') => {
  // Only a class, a code, bundle lines and a hash are kept. The message text is dropped here.
  const entry = describeError(error, fallbackMessage)
  logs = [...logs, { ...entry, at: Date.now() }].slice(-DIAGNOSTICS_MAX_LOGS)
  if (kind === 'crash' && consent.crashes) bridge()?.record({ k: 'crash', type, ...entry })
  else if (kind === 'error' && consent.errors) bridge()?.record({ k: 'error', ...entry })
}

const install = () => {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('error', (event) => recordError(event.error, 'crash', 'renderer-error', event.message))
  window.addEventListener('unhandledrejection', (event) => recordError(event.reason, 'crash', 'renderer-rejection'))
  window.addEventListener('pagehide', flushBuffers)
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushBuffers() })
  diagnosticListeners.add((event) => {
    if (event.kind === 'tool' && event.tool) recordFeature(`tool.${event.tool.toLowerCase().replace(/[^a-z0-9]+/gu, '-').slice(0, 30)}`)
    else if (event.kind === 'error' && event.message) recordError(null, 'error', '', event.message)
  })
}

export const configureDiagnostics = (next: SendDataConsent, ctx: { vaultPath?: string } = {}) => {
  consent = { crashes: next.crashes === true, errors: next.errors === true, perf: next.perf === true, usage: next.usage === true }
  context = identityFromPath(ctx.vaultPath ?? '')
  install()
  // Older versions kept counters in localStorage; the main process owns the queue now.
  write('fanotes.diagnostics.counters', null)
  write('fanotes.diagnostics.lastSentAt', null)
  if (!consent.perf) penSamples = []
  if (!consent.usage) { vault = null; vaultSent = '' }
}

export const setDiagnosticsVault = (notes: number, bytes: number) => { if (consent.usage) vault = { notes, bytes } }

const appInfo = () => ({
  version: APP_VERSION,
  platform: typeof window !== 'undefined' ? String(window.fanotes?.platform ?? '') : '',
  arch: '',
  language: typeof document !== 'undefined' ? document.documentElement.lang.slice(0, 2) : '',
})

/** The exact JSON the next automatic batch would contain (from the main process), or null. */
export const previewQueuedDiagnostics = async () => bridge()?.preview().catch(() => null) ?? null

/** The exact JSON of an explicit report. */
export const previewManualReport = (comment = ''): DiagnosticsPayload | null =>
  buildDiagnosticsPayload({ consent: { logs: true }, manual: true, installId: read(KEY_ID) || '0'.repeat(32), app: appInfo(), logs, comment, context })

/** Explicit "Jetzt Logs senden": scrubbed recent errors plus an optional comment. */
export const sendLogsNow = async (comment: string) => {
  const payload = buildDiagnosticsPayload({ consent: { logs: true }, manual: true, installId: await resolveInstallId(), app: appInfo(), logs: [...logs], comment, context })
  if (!payload) return false
  try {
    const response = await fetch(`${DIAGNOSTICS_ORIGIN}${DIAGNOSTICS_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    return response.ok
  } catch { return false }
}

export const getInstallStatus = async () => bridge()?.status().catch(() => null) ?? null
export const rotateInstallId = async () => bridge()?.resetInstallId().catch(() => '') ?? ''

/** Deletes what the server holds for this install and everything queued here, then a new ID is used. */
export const deleteMyDiagnostics = async () => {
  logs = []
  penSamples = []
  const api = bridge()
  if (api) return api.deleteRemote().catch(() => false)
  const id = await resolveInstallId()
  try {
    const response = await fetch(`${DIAGNOSTICS_ORIGIN}${DIAGNOSTICS_PATH}/${id}`, { method: 'DELETE', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (response.ok) write(KEY_ID, newInstallId())
    return response.ok
  } catch { return false }
}
