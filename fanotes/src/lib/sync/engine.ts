// The sync engine: keeps a vault and the account's encrypted store on the
// server converged. It runs in the renderer (desktop and web share it) on top
// of a SyncHostApi that gives it raw access to every file in the vault.
//
// One cycle:  pull (apply remote changes newer than our cursor)
//           → scan (find files that changed locally since the last cycle)
//           → push (upload changes with the base revision we know; the server
//             rejects a stale base with 409, which sends us back to pull)
//
// Conflicts never destroy anything: when both sides changed the same file,
// the remote version takes the path and the local version is kept next to it
// as "Name (Konflikt <Gerät> <Datum>).ext", which is then uploaded as a new
// file so every device ends up with both.
import type { SyncHostApi, SyncScanEntry } from '../../types'
import { SyncApi, SyncApiError, type SyncAccountInfo, type SyncRemoteEntry, type SyncSession } from './api'
import {
  decryptBytes, decryptMeta, deriveFromPassword, deriveSyncKeys, encryptBytes, encryptMeta, fileIdFor, fromBase64, importVaultSecret,
  isValidKdf, newKdf, newVaultSecret, passwordProblems, sha256Hex, toBase64, unwrapVaultSecret, wrapVaultSecret, type SyncKeys,
} from './crypto'

export type SyncStatus = 'unavailable' | 'signed-out' | 'idle' | 'syncing' | 'offline' | 'error' | 'paused'

export type SyncConflict = { path: string; copyPath: string; at: string }
export type SyncLogEntry = { at: string; level: 'info' | 'warn' | 'error'; text: string }

export type SyncPublicState = {
  status: SyncStatus
  account: { email: string; accountId: string; deviceId: string } | null
  vaultId: string | null
  lastSyncAt: string | null
  error: string | null
  progress: { phase: 'pull' | 'scan' | 'push'; done: number; total: number } | null
  pendingLocal: number
  trackedFiles: number
  conflicts: SyncConflict[]
  log: SyncLogEntry[]
  info: SyncAccountInfo | null
}

type LocalBase = { id: string; revision: number; sha256: string; size: number; mtimeMs: number }
type PersistedState = { version: 1; accountId: string; cursor: number; lastSyncAt: string | null; files: Record<string, LocalBase>; conflicts: SyncConflict[] }
type Secrets = { v: 1; accountId: string; deviceId: string; token: string; expiresAt: string; email: string; vaultSecret: string }

export type SyncEngineOptions = {
  platform: string
  deviceName: () => string
  automatic: () => boolean
  /** True while the app holds unsaved edits for the path; remote changes to it wait for the next cycle. */
  isPathBusy?: (path: string) => boolean
  /** Files the engine wrote or removed on behalf of another device – the app refreshes its tree and open tabs. */
  onApplied?: (change: { written: string[]; removed: string[] }) => void
  onConflict?: (conflict: SyncConflict) => void
  onSignedOut?: (reason: string) => void
  now?: () => number
}

const AUTO_INTERVAL_MS = 60_000
const LOCAL_DEBOUNCE_MS = 2_500
const OFFLINE_RETRY_MS = 30_000
const MAX_LOG = 120
const MAX_FILE_BYTES = 100 * 1024 * 1024
const CONCURRENCY = 3

const INTERNAL_DIRECTORY = '.fanotes'
const SKIPPED_INTERNAL = new Set(['history', 'onboarding.json', 'tree-cache'])
const SKIPPED_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** Which vault paths take part in sync: notes, assets and the shared `.fanotes/` metadata, but no local caches or temp files. */
export const isSyncablePath = (path: string) => {
  if (!path || path.length > 1024 || path.includes('\0') || path.startsWith('/') || path.includes('//')) return false
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false
  const name = segments[segments.length - 1]
  if (SKIPPED_NAMES.has(name) || /\.tmp$/iu.test(name) || /^\.~lock\./u.test(name) || /^~\$/u.test(name)) return false
  if (segments[0] === INTERNAL_DIRECTORY) {
    if (segments.length < 2) return false
    if (SKIPPED_INTERNAL.has(segments[1])) return false
    return !segments.slice(1).some((segment) => segment.startsWith('.'))
  }
  return !segments.some((segment) => segment.startsWith('.'))
}

export const conflictCopyPath = (path: string, deviceName: string, at: Date) => {
  const slash = path.lastIndexOf('/')
  const directory = slash >= 0 ? path.slice(0, slash + 1) : ''
  const name = slash >= 0 ? path.slice(slash + 1) : path
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  const stamp = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}-${String(at.getMinutes()).padStart(2, '0')}`
  const device = deviceName.replace(/[\\/:*?"<>|\0-\x1f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 40) || 'Gerät'
  return `${directory}${stem} (Konflikt ${device} ${stamp})${extension}`
}

const defaultDeviceName = (platform: string) => {
  if (platform === 'web' || platform === 'browser-preview') return 'Browser'
  if (platform === 'win32') return 'Windows-Gerät'
  if (platform === 'darwin') return 'Mac'
  if (platform === 'linux') return 'Linux-Gerät'
  return 'Gerät'
}

const emptyState = (accountId: string): PersistedState => ({ version: 1, accountId, cursor: 0, lastSyncAt: null, files: {}, conflicts: [] })

const parseState = (raw: string | null, accountId: string): PersistedState => {
  if (!raw) return emptyState(accountId)
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    if (parsed.version !== 1 || parsed.accountId !== accountId || typeof parsed.files !== 'object' || !parsed.files) return emptyState(accountId)
    const files: Record<string, LocalBase> = {}
    for (const [path, base] of Object.entries(parsed.files)) {
      if (!isSyncablePath(path) || !base || typeof base !== 'object') continue
      const candidate = base as Partial<LocalBase>
      if (typeof candidate.id !== 'string' || typeof candidate.sha256 !== 'string') continue
      files[path] = { id: candidate.id, revision: Number(candidate.revision) || 0, sha256: candidate.sha256, size: Number(candidate.size) || 0, mtimeMs: Number(candidate.mtimeMs) || 0 }
    }
    return {
      version: 1,
      accountId,
      cursor: Number.isInteger(parsed.cursor) && (parsed.cursor as number) >= 0 ? (parsed.cursor as number) : 0,
      lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : null,
      files,
      conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts.filter((item): item is SyncConflict => Boolean(item) && typeof item.path === 'string' && typeof item.copyPath === 'string').slice(-50) : [],
    }
  } catch {
    return emptyState(accountId)
  }
}

const parseSecrets = (raw: string | null): Secrets | null => {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<Secrets>
    if (parsed.v !== 1 || typeof parsed.accountId !== 'string' || typeof parsed.deviceId !== 'string' || typeof parsed.token !== 'string' || typeof parsed.email !== 'string' || typeof parsed.vaultSecret !== 'string') return null
    return { v: 1, accountId: parsed.accountId, deviceId: parsed.deviceId, token: parsed.token, expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : '', email: parsed.email, vaultSecret: parsed.vaultSecret }
  } catch {
    return null
  }
}

const runLimited = async <T>(items: T[], limit: number, task: (item: T) => Promise<void>) => {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index]
      index += 1
      await task(item)
    }
  })
  await Promise.all(workers)
}

export class SyncEngine {
  private host: SyncHostApi | null = null
  private options: SyncEngineOptions | null = null
  private api: SyncApi
  private session: SyncSession | null = null
  private keys: SyncKeys | null = null
  private vaultSecretBase64: string | null = null
  private vaultId: string | null = null
  private state: PersistedState | null = null
  private listeners = new Set<() => void>()
  private snapshot: SyncPublicState
  private inFlight: Promise<void> | null = null
  private queued = false
  private timer: number | null = null
  private debounce: number | null = null
  private disposed = false
  private windowListeners: Array<() => void> = []

  constructor(api?: SyncApi) {
    this.api = api ?? new SyncApi()
    this.snapshot = { status: 'unavailable', account: null, vaultId: null, lastSyncAt: null, error: null, progress: null, pendingLocal: 0, trackedFiles: 0, conflicts: [], log: [], info: null }
  }

  // ── External store API ──────────────────────────────────────────────────

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getState = () => this.snapshot

  private setState(patch: Partial<SyncPublicState>) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { console.error('[sync] listener failed', error) }
    }
  }

  private log(level: SyncLogEntry['level'], text: string) {
    const entry = { at: new Date(this.options?.now?.() ?? Date.now()).toISOString(), level, text }
    this.setState({ log: [...this.snapshot.log, entry].slice(-MAX_LOG) })
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  attach(host: SyncHostApi, options: SyncEngineOptions) {
    this.host = host
    this.options = options
  }

  /** Restores a signed-in session (if any) and starts the automatic cycle. */
  async start() {
    if (!this.host || !this.options) return
    this.disposed = false
    if (typeof window !== 'undefined') {
      const kick = () => { if (this.session && this.options?.automatic()) void this.syncNow('online') }
      const focus = () => { if (this.session && this.options?.automatic()) void this.syncNow('focus') }
      window.addEventListener('online', kick)
      window.addEventListener('focus', focus)
      this.windowListeners.push(() => window.removeEventListener('online', kick), () => window.removeEventListener('focus', focus))
    }
    try {
      this.vaultId = await this.host.vaultId()
      const secrets = parseSecrets(await this.host.readSecrets())
      if (!secrets) {
        this.setState({ status: 'signed-out', vaultId: this.vaultId })
        return
      }
      await this.adoptSecrets(secrets)
      this.log('info', `Angemeldet als ${secrets.email}.`)
      this.schedule(0)
    } catch (error) {
      this.setState({ status: 'error', error: error instanceof Error ? error.message : 'Sync konnte nicht starten.' })
    }
  }

  /** Called when the app switches to another vault: state is per vault, the account stays. */
  async switchVault() {
    if (!this.host) return
    await this.waitIdle()
    this.vaultId = await this.host.vaultId()
    if (this.session) {
      this.state = parseState(await this.host.readState(this.vaultId), this.session.accountId)
      this.publishCounts()
      this.setState({ vaultId: this.vaultId, lastSyncAt: this.state.lastSyncAt })
      this.schedule(0)
    } else {
      this.setState({ vaultId: this.vaultId })
    }
  }

  dispose() {
    this.disposed = true
    if (this.timer !== null) window.clearTimeout(this.timer)
    if (this.debounce !== null) window.clearTimeout(this.debounce)
    for (const remove of this.windowListeners) remove()
    this.windowListeners = []
  }

  private async adoptSecrets(secrets: Secrets) {
    if (!this.host) throw new Error('Sync ist nicht angebunden.')
    this.keys = await deriveSyncKeys(await importVaultSecret(fromBase64(secrets.vaultSecret)))
    this.vaultSecretBase64 = secrets.vaultSecret
    this.session = { accountId: secrets.accountId, deviceId: secrets.deviceId, token: secrets.token, expiresAt: secrets.expiresAt, email: secrets.email }
    this.vaultId ??= await this.host.vaultId()
    this.state = parseState(await this.host.readState(this.vaultId), secrets.accountId)
    this.setState({
      status: 'idle',
      account: { email: secrets.email, accountId: secrets.accountId, deviceId: secrets.deviceId },
      vaultId: this.vaultId,
      lastSyncAt: this.state.lastSyncAt,
      conflicts: this.state.conflicts,
      error: null,
      trackedFiles: Object.keys(this.state.files).length,
    })
  }

  private async persistSecrets(secrets: Secrets | null) {
    if (!this.host) return
    await this.host.writeSecrets(secrets ? JSON.stringify(secrets) : null)
  }

  private async persistState() {
    if (!this.host || !this.state || !this.vaultId) return
    await this.host.writeState(this.vaultId, JSON.stringify(this.state))
    this.publishCounts()
  }

  private publishCounts() {
    if (!this.state) return
    this.setState({ trackedFiles: Object.keys(this.state.files).length, conflicts: this.state.conflicts, lastSyncAt: this.state.lastSyncAt })
  }

  private deviceInfo() {
    const name = (this.options?.deviceName() ?? '').trim() || defaultDeviceName(this.options?.platform ?? '')
    return { name: name.slice(0, 80), platform: (this.options?.platform ?? 'unknown').replace(/[^a-z0-9-]/giu, '').toLowerCase().slice(0, 24) || 'unknown' }
  }

  // ── Account ─────────────────────────────────────────────────────────────

  async register(email: string, password: string) {
    this.requireHost()
    const problem = passwordProblems(password)
    if (problem) throw new Error(problem)
    const kdf = newKdf()
    const { wrappingKey, authKey } = await deriveFromPassword(password, kdf)
    const secret = newVaultSecret()
    const vaultKeyWrap = await wrapVaultSecret(secret, wrappingKey)
    const result = await this.api.register({ email: email.trim().toLowerCase(), authKey, kdf, vaultKeyWrap, device: this.deviceInfo() })
    await this.signInWith({ v: 1, accountId: result.accountId, deviceId: result.deviceId, token: result.token, expiresAt: result.expiresAt, email: email.trim().toLowerCase(), vaultSecret: toBase64(secret) })
    secret.fill(0)
    this.log('info', 'Konto erstellt. Der Vault-Schlüssel wurde auf diesem Gerät erzeugt und verschlüsselt hinterlegt.')
  }

  async login(email: string, password: string) {
    this.requireHost()
    const normalized = email.trim().toLowerCase()
    const { kdf } = await this.api.prelogin(normalized)
    if (!isValidKdf(kdf)) throw new Error('Der Server hat unbrauchbare Schlüsselparameter geliefert.')
    const { wrappingKey, authKey } = await deriveFromPassword(password, kdf)
    const result = await this.api.login({ email: normalized, authKey, device: this.deviceInfo() })
    const secret = await unwrapVaultSecret(result.vaultKeyWrap, wrappingKey)
    await this.signInWith({ v: 1, accountId: result.accountId, deviceId: result.deviceId, token: result.token, expiresAt: result.expiresAt, email: normalized, vaultSecret: toBase64(secret) })
    secret.fill(0)
    this.log('info', `Angemeldet als ${normalized}. Die Notizen des Kontos werden geholt.`)
  }

  private async signInWith(secrets: Secrets) {
    await this.waitIdle()
    if (this.host && this.vaultId) await this.host.writeState(this.vaultId, null)
    await this.persistSecrets(secrets)
    await this.adoptSecrets(secrets)
    this.schedule(0)
  }

  async logout() {
    this.requireHost()
    await this.waitIdle()
    const session = this.session
    if (session) await this.api.logout(session).catch(() => undefined)
    await this.forgetSession()
    this.log('info', 'Abgemeldet. Die Notizen bleiben auf diesem Gerät.')
  }

  private async forgetSession() {
    this.session = null
    this.keys = null
    this.vaultSecretBase64 = null
    this.state = null
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
    await this.persistSecrets(null)
    if (this.host && this.vaultId) await this.host.writeState(this.vaultId, null)
    this.setState({ status: 'signed-out', account: null, info: null, progress: null, pendingLocal: 0, trackedFiles: 0, conflicts: [], error: null })
  }

  async refreshAccount() {
    if (!this.session) return null
    try {
      const info = await this.api.account(this.session)
      this.setState({ info })
      return info
    } catch (error) {
      if (error instanceof SyncApiError && error.unauthorized) await this.handleUnauthorized()
      throw error
    }
  }

  async removeDevice(deviceId: string) {
    if (!this.session) throw new Error('Nicht angemeldet.')
    await this.api.removeDevice(this.session, deviceId)
    await this.refreshAccount()
  }

  async changePassword(currentPassword: string, nextPassword: string) {
    if (!this.session || !this.vaultSecretBase64) throw new Error('Nicht angemeldet.')
    const problem = passwordProblems(nextPassword)
    if (problem) throw new Error(problem)
    const { kdf: currentKdf } = await this.api.prelogin(this.session.email)
    const current = await deriveFromPassword(currentPassword, currentKdf)
    const kdf = newKdf()
    const next = await deriveFromPassword(nextPassword, kdf)
    const vaultKeyWrap = await wrapVaultSecret(fromBase64(this.vaultSecretBase64), next.wrappingKey)
    await this.api.changePassword(this.session, { authKey: current.authKey, newAuthKey: next.authKey, kdf, vaultKeyWrap })
    this.log('info', 'Passwort geändert; alle anderen Geräte müssen sich neu anmelden.')
  }

  async deleteAccount(password: string) {
    if (!this.session) throw new Error('Nicht angemeldet.')
    await this.waitIdle()
    const { kdf } = await this.api.prelogin(this.session.email)
    const { authKey } = await deriveFromPassword(password, kdf)
    await this.api.deleteAccount(this.session, authKey)
    await this.forgetSession()
    this.log('info', 'Konto und alle Daten auf dem Server gelöscht.')
  }

  private requireHost() {
    if (!this.host || !this.options) throw new Error('Sync steht in dieser Umgebung nicht zur Verfügung.')
  }

  private async handleUnauthorized() {
    const reason = 'Die Anmeldung ist abgelaufen oder wurde von einem anderen Gerät beendet. Bitte erneut anmelden.'
    await this.forgetSession()
    this.setState({ error: reason })
    this.log('warn', reason)
    this.options?.onSignedOut?.(reason)
  }

  // ── Scheduling ──────────────────────────────────────────────────────────

  /** The app calls this after every local write; a short debounce batches bursts of autosaves. */
  notifyLocalChange() {
    if (!this.session || !this.options?.automatic()) return
    if (this.debounce !== null) window.clearTimeout(this.debounce)
    this.debounce = window.setTimeout(() => { this.debounce = null; void this.syncNow('local-change') }, LOCAL_DEBOUNCE_MS)
  }

  private schedule(delay: number) {
    if (this.disposed || !this.session) return
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      if (this.options?.automatic() || delay === 0) void this.syncNow('timer')
      else this.schedule(AUTO_INTERVAL_MS)
    }, delay)
  }

  /** Resolves once no cycle is running any more (queued follow-ups included). */
  private waitIdle(): Promise<void> {
    return this.inFlight ? this.inFlight.then(() => this.waitIdle()) : Promise.resolve()
  }

  /** Runs one full cycle; concurrent calls coalesce into at most one follow-up cycle. The promise settles when the engine is idle again. */
  syncNow(reason = 'manual'): Promise<void> {
    if (!this.session || !this.host) return Promise.resolve()
    if (this.inFlight) {
      this.queued = true
      return this.waitIdle()
    }
    this.inFlight = this.runCycle(reason).finally(() => {
      this.inFlight = null
      if (this.queued && !this.disposed) {
        this.queued = false
        void this.syncNow('queued')
      }
    })
    return this.waitIdle()
  }

  private async runCycle(reason: string) {
    if (!this.session || !this.host || !this.state || !this.keys) return
    this.setState({ status: 'syncing', error: null, progress: null })
    try {
      let conflicts = await this.pull()
      const pushed = await this.push()
      if (pushed.conflicts > 0) conflicts += await this.pull()
      this.state.lastSyncAt = new Date(this.options?.now?.() ?? Date.now()).toISOString()
      await this.persistState()
      this.setState({ status: 'idle', progress: null, pendingLocal: 0 })
      if (reason !== 'timer' || pushed.uploads || pushed.deletes || conflicts) this.log('info', `Sync abgeschlossen (${pushed.uploads} hochgeladen, ${pushed.deletes} gelöscht${conflicts ? `, ${conflicts} Konflikt(e)` : ''}).`)
      this.schedule(AUTO_INTERVAL_MS)
    } catch (error) {
      await this.persistState().catch(() => undefined)
      if (error instanceof SyncApiError && error.unauthorized) {
        await this.handleUnauthorized()
        return
      }
      const offline = error instanceof SyncApiError && error.offline
      const message = error instanceof Error ? error.message : 'Sync fehlgeschlagen.'
      this.setState({ status: offline ? 'offline' : 'error', error: message, progress: null })
      this.log(offline ? 'warn' : 'error', message)
      this.schedule(offline ? OFFLINE_RETRY_MS : AUTO_INTERVAL_MS)
    }
  }

  // ── Pull ────────────────────────────────────────────────────────────────

  private async localSnapshot(path: string): Promise<{ bytes: Uint8Array; sha256: string; stat: SyncScanEntry } | null> {
    if (!this.host) return null
    try {
      const bytes = await this.host.read(path)
      return { bytes, sha256: await sha256Hex(bytes), stat: { path, size: bytes.byteLength, mtimeMs: 0 } }
    } catch {
      return null
    }
  }

  private async pull(): Promise<number> {
    if (!this.session || !this.host || !this.state || !this.keys) return 0
    let conflicts = 0
    const written: string[] = []
    const removed: string[] = []
    const pending: SyncRemoteEntry[] = []
    let since = this.state.cursor
    for (let page = 0; page < 200; page += 1) {
      const changes = await this.api.changes(this.session, since)
      pending.push(...changes.entries)
      since = changes.nextSince
      if (!changes.more) break
    }
    if (!pending.length) return 0
    this.setState({ progress: { phase: 'pull', done: 0, total: pending.length } })
    const idIndex = new Map(Object.entries(this.state.files).map(([path, base]) => [base.id, path]))
    let done = 0
    // A change to a note that is being edited right now is not applied; the
    // cursor stays in front of it so the next cycle fetches it again.
    let holdCursor = Number.POSITIVE_INFINITY
    await runLimited(pending, CONCURRENCY, async (entry) => {
      const { result, path } = await this.applyRemote(entry, idIndex)
      if (result === 'conflict') conflicts += 1
      if ((result === 'written' || result === 'conflict') && path) written.push(path)
      if (result === 'removed' && path) removed.push(path)
      if (result === 'deferred') holdCursor = Math.min(holdCursor, entry.revision - 1)
      done += 1
      this.setState({ progress: { phase: 'pull', done, total: pending.length } })
    })
    this.state.cursor = Math.max(this.state.cursor, Math.min(since, holdCursor))
    await this.persistState()
    if (written.length || removed.length) this.options?.onApplied?.({ written, removed })
    return conflicts
  }

  private async applyRemote(entry: SyncRemoteEntry, idIndex: Map<string, string>): Promise<{ result: 'written' | 'removed' | 'conflict' | 'skipped' | 'deferred' | 'noop'; path: string | null }> {
    if (!this.session || !this.host || !this.state || !this.keys) return { result: 'skipped', path: null }
    const knownPath = idIndex.get(entry.id) ?? null

    if (entry.deleted) {
      if (!knownPath) return { result: 'noop', path: null }
      const base = this.state.files[knownPath]
      if (!base || entry.revision <= base.revision) return { result: 'noop', path: knownPath }
      if (this.options?.isPathBusy?.(knownPath)) return { result: 'deferred', path: knownPath }
      const local = await this.localSnapshot(knownPath)
      if (!local) {
        delete this.state.files[knownPath]
        idIndex.delete(entry.id)
        return { result: 'noop', path: knownPath }
      }
      if (local.sha256 === base.sha256) {
        await this.host.remove(knownPath)
        delete this.state.files[knownPath]
        idIndex.delete(entry.id)
        return { result: 'removed', path: knownPath }
      }
      // Edited here after another device deleted it: keep ours, it is re-uploaded on top of the tombstone.
      this.state.files[knownPath] = { ...base, revision: entry.revision, sha256: '' }
      this.log('info', `„${knownPath}“ wurde anderswo gelöscht, hier aber geändert – die lokale Fassung bleibt.`)
      return { result: 'noop', path: knownPath }
    }

    if (!entry.meta || !entry.sha256) return { result: 'skipped', path: null }
    let meta
    try {
      meta = await decryptMeta(this.keys, entry.id, entry.meta)
    } catch (error) {
      this.log('warn', `Metadaten eines Eintrags konnten nicht entschlüsselt werden (${error instanceof Error ? error.message : 'unbekannt'}).`)
      return { result: 'skipped', path: null }
    }
    const path = meta.path
    if (!isSyncablePath(path)) return { result: 'skipped', path: null }
    const base = this.state.files[path]
    // We already hold this or a newer revision (our own upload, or a re-fetch after a held cursor).
    if (base && base.id === entry.id && entry.revision <= base.revision) return { result: 'noop', path }
    if (this.options?.isPathBusy?.(path)) return { result: 'deferred', path }
    const local = await this.localSnapshot(path)
    if (local && local.sha256 === meta.sha256) {
      this.state.files[path] = { id: entry.id, revision: entry.revision, sha256: meta.sha256, size: local.stat.size, mtimeMs: (await this.statOf(path))?.mtimeMs ?? 0 }
      idIndex.set(entry.id, path)
      return { result: 'noop', path }
    }
    const localChanged = Boolean(local) && (!base || local!.sha256 !== base.sha256)
    let result: 'written' | 'conflict' = 'written'
    if (localChanged && local) {
      const at = new Date(this.options?.now?.() ?? Date.now())
      const copyPath = conflictCopyPath(path, this.deviceInfo().name, at)
      await this.host.write(copyPath, local.bytes, at.getTime())
      const conflict = { path, copyPath, at: at.toISOString() }
      this.state.conflicts = [...this.state.conflicts, conflict].slice(-50)
      this.log('warn', `Konflikt bei „${path}“: die lokale Fassung liegt jetzt unter „${copyPath}“.`)
      this.options?.onConflict?.(conflict)
      result = 'conflict'
    }
    const download = await this.api.download(this.session, entry.id)
    if ('deleted' in download) {
      // Deleted again between the change list and the download; the tombstone arrives with the next pull.
      return { result: 'noop', path }
    }
    if (await sha256Hex(download.blob) !== download.sha256) throw new Error(`Die Datei „${path}“ kam beschädigt vom Server.`)
    const plain = await decryptBytes(this.keys, entry.id, download.blob)
    if (await sha256Hex(plain) !== meta.sha256) throw new Error(`Die Prüfsumme von „${path}“ stimmt nach dem Entschlüsseln nicht.`)
    const stat = await this.host.write(path, plain, meta.mtimeMs || Date.now())
    this.state.files[path] = { id: entry.id, revision: download.revision, sha256: meta.sha256, size: stat.size, mtimeMs: stat.mtimeMs }
    idIndex.set(entry.id, path)
    return { result, path }
  }

  private scanCache: Map<string, SyncScanEntry> | null = null

  private async statOf(path: string) {
    if (!this.host) return null
    if (!this.scanCache) this.scanCache = new Map((await this.host.scan()).map((entry) => [entry.path, entry]))
    return this.scanCache.get(path) ?? null
  }

  // ── Scan + push ─────────────────────────────────────────────────────────

  private async push(): Promise<{ uploads: number; deletes: number; conflicts: number }> {
    if (!this.session || !this.host || !this.state || !this.keys) return { uploads: 0, deletes: 0, conflicts: 0 }
    this.setState({ progress: { phase: 'scan', done: 0, total: 0 } })
    const entries = (await this.host.scan()).filter((entry) => isSyncablePath(entry.path))
    this.scanCache = new Map(entries.map((entry) => [entry.path, entry]))
    const present = new Set(entries.map((entry) => entry.path))
    const changed: SyncScanEntry[] = []
    for (const entry of entries) {
      if (entry.size > MAX_FILE_BYTES) continue
      const base = this.state.files[entry.path]
      if (!base || base.size !== entry.size || base.mtimeMs !== entry.mtimeMs || !entry.mtimeMs || !base.sha256) changed.push(entry)
    }
    const deleted = Object.keys(this.state.files).filter((path) => !present.has(path))
    this.setState({ pendingLocal: changed.length + deleted.length, progress: { phase: 'push', done: 0, total: changed.length + deleted.length } })

    let uploads = 0
    let deletes = 0
    let conflicts = 0
    let done = 0
    const tick = () => { done += 1; this.setState({ progress: { phase: 'push', done, total: changed.length + deleted.length } }) }

    await runLimited(changed, CONCURRENCY, async (entry) => {
      try {
        const outcome = await this.uploadPath(entry)
        if (outcome === 'uploaded') uploads += 1
        if (outcome === 'conflict') conflicts += 1
      } finally {
        tick()
      }
    })
    for (const path of deleted) {
      try {
        const outcome = await this.deletePath(path)
        if (outcome === 'deleted') deletes += 1
        if (outcome === 'conflict') conflicts += 1
      } finally {
        tick()
      }
    }
    this.scanCache = null
    await this.persistState()
    return { uploads, deletes, conflicts }
  }

  private async uploadPath(entry: SyncScanEntry): Promise<'uploaded' | 'unchanged' | 'conflict' | 'skipped'> {
    if (!this.session || !this.host || !this.state || !this.keys) return 'skipped'
    const bytes = await this.host.read(entry.path).catch(() => null)
    if (!bytes) return 'skipped'
    const sha256 = await sha256Hex(bytes)
    const base = this.state.files[entry.path]
    if (base && base.sha256 === sha256) {
      // Touched but identical (an editor re-saved the same text): remember the new stat, nothing to send.
      this.state.files[entry.path] = { ...base, size: entry.size, mtimeMs: entry.mtimeMs }
      return 'unchanged'
    }
    const id = base?.id ?? await fileIdFor(this.keys, entry.path)
    const meta = await encryptMeta(this.keys, id, { path: entry.path, mtimeMs: entry.mtimeMs, size: bytes.byteLength, sha256 })
    const blob = await encryptBytes(this.keys, id, bytes)
    try {
      const revision = await this.api.upload(this.session, id, base?.revision ?? 0, meta, await sha256Hex(blob), blob)
      this.state.files[entry.path] = { id, revision, sha256, size: entry.size, mtimeMs: entry.mtimeMs }
      return 'uploaded'
    } catch (error) {
      if (error instanceof SyncApiError && error.conflict) {
        // Someone else moved this file on; the follow-up pull decides (same content → adopt, different → conflict copy).
        return 'conflict'
      }
      if (error instanceof SyncApiError && error.status === 507) {
        this.log('error', `„${entry.path}“ passt nicht mehr in den Speicher des Kontos: ${error.message}`)
        return 'skipped'
      }
      throw error
    }
  }

  private async deletePath(path: string): Promise<'deleted' | 'conflict' | 'skipped'> {
    if (!this.session || !this.state) return 'skipped'
    const base = this.state.files[path]
    if (!base) return 'skipped'
    try {
      await this.api.remove(this.session, base.id, base.revision)
      delete this.state.files[path]
      return 'deleted'
    } catch (error) {
      if (error instanceof SyncApiError && error.conflict) {
        // Changed elsewhere after we deleted it here: the remote version comes back with the next pull.
        delete this.state.files[path]
        return 'conflict'
      }
      throw error
    }
  }

  clearConflicts() {
    if (!this.state) return
    this.state.conflicts = []
    void this.persistState()
  }
}

export const syncEngine = new SyncEngine()
