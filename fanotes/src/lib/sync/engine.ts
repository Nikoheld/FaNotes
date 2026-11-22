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
import { HOMEWORK_NOTE_PATH, mergeHomeworkMarkdownBytes } from '../homeworkStore'
import { canonicalSyncBytes, identitySyncBytes, isFamdSyncPath, noteSyncKind, withLocalPageStats, type NoteSyncKind } from '../famd'

const syncText = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
/** Sign-in, network, rate-limit and server errors concern every entry, so they end the cycle instead of skipping one file. */
const cycleWide = (error: unknown) => error instanceof SyncApiError && (error.unauthorized || error.offline || error.status === 429 || error.status >= 500)
import { pathIsSyncExcluded, RECOGNITION_MODEL_SYNC_PATH } from './folderSync'
import { judgeStoryShrink, mergeStoryFile, storyRoleOf } from '../../writing/syncMerge'
import { conflictFingerprint, groupConflicts, keptVersionPath, numberedVariant, type ConflictGroup, type ConflictKeep } from './conflicts'
import { SyncApi, SyncApiError, type SyncAccountInfo, type SyncCredential, type SyncRemoteEntry, type SyncSession } from './api'
import { SHARED_INBOX_FOLDER } from './sharedInbox'
import {
  createUserKeyPair, decryptBytes, decryptMeta, deriveFromPassword, newDeviceKey, openUserPrivateKey, usernameProblem, deriveSyncKeys, encryptBytes, encryptMeta, fileIdFor, fromBase64, importVaultSecret,
  isValidKdf, newKdf, newVaultSecret, passwordProblems, sha256Hex, toBase64, unwrapVaultSecret, wrapVaultSecret, type SyncKeys,
} from './crypto'

export type SyncStatus = 'unavailable' | 'signed-out' | 'idle' | 'syncing' | 'offline' | 'error' | 'paused'

export type SyncConflict = { path: string; copyPath: string; at: string }
/** A file that is on this device but did not reach the server, with the reason shown in the sync status. */
export type SyncFailure = { path: string; reason: string }
export type SyncLogEntry = { at: string; level: 'info' | 'warn' | 'error'; text: string }

export type SyncPublicState = {
  status: SyncStatus
  /** `email` is empty for an account without one. `credential`: 'device-key' means no password, the account is bound to this device's key. */
  account: { email: string; accountId: string; deviceId: string; username: string | null; credential: SyncCredential } | null
  /** Cloud sync of the vault. Off by default for new accounts; the account stays signed in for sharing either way. */
  vaultSync: boolean
  vaultId: string | null
  lastSyncAt: string | null
  error: string | null
  progress: { phase: 'pull' | 'scan' | 'push'; done: number; total: number } | null
  /** While `status` is 'paused' (the server throttles): when the sync goes on by itself, as epoch milliseconds. Otherwise null. */
  pausedUntil: number | null
  pendingLocal: number
  trackedFiles: number
  /** Changes from other devices that wait: the note is open with unsaved edits here, or the local file cannot be read. They are tried again every cycle. */
  heldRemote: number
  conflicts: SyncConflict[]
  /** Documents with a conflict copy in this vault, from any device. */
  openConflicts: number
  /** Files that were not uploaded in the last cycle. Empty when everything that should be on the server is. */
  failed: SyncFailure[]
  log: SyncLogEntry[]
  info: SyncAccountInfo | null
}

type LocalBase = { id: string; revision: number; sha256: string; size: number; mtimeMs: number; contentSha256?: string; blank?: boolean }
/** A remote entry that is tried again on every pull. `held`: it was put off because the note is open or unreadable here (not because its folder stays on another device). */
type SkippedEntry = SyncRemoteEntry & { held?: true }
type PersistedState = { version: 1; accountId: string; cursor: number; lastSyncAt: string | null; files: Record<string, LocalBase>; /** Status-change time of each tracked file at its last check: an external edit that restores the mtime still moves it. */ ctimes?: Record<string, number>; conflicts: SyncConflict[]; pendingDeletes: string[]; skipped: SkippedEntry[] }
/** What `applyRemote` did with one entry. `unreadable`: it was put off because the local file exists but cannot be read. */
type RemoteOutcome = { result: 'written' | 'removed' | 'conflict' | 'skipped' | 'deferred' | 'noop'; path: string | null; unreadable?: true }
type Secrets = { v: 1; accountId: string; deviceId: string; token: string; expiresAt: string; email: string; vaultSecret: string; username?: string | null; credential?: SyncCredential }
/** Device keys stand in for the password of accounts without one. They live in a separate keychain-protected file that survives sign-out. */
type DeviceKeys = { v: 1; keys: Record<string, { username: string; key: string }> }
const DEVICE_KEYS_SLOT = 'device-keys'

export type SyncEngineOptions = {
  platform: string
  deviceName: () => string
  automatic: () => boolean
  /** Whether the vault itself syncs to the cloud. Missing means yes (older hosts). */
  vaultSync?: () => boolean
  /** Called when a new account is created so that cloud sync starts off. */
  setVaultSync?: (enabled: boolean) => void
  /** True while the app holds unsaved edits for the path; remote changes to it wait for the next cycle. */
  isPathBusy?: (path: string) => boolean
  /** Folders that stay on this device. The rest of the vault still syncs. */
  excludedPrefixes?: () => readonly string[]
  /** The personal handwriting model is a separate encrypted blob. Off by default. */
  includeRecognitionModel?: () => boolean
  /** Local note history is skipped unless the user opts in. */
  includeHistory?: () => boolean
  /** Attachments (images, other files) take part. Off: notes only (md, famd, PDFs, side pages, `.fanotes/` metadata). Default on. */
  includeAttachments?: () => boolean
  /** Compare with the server's file table on start and after a reconnect. Default on; the Rust parity harness turns it off because the Rust mirror engine does not implement it. */
  reconcile?: boolean
  /** Files the engine wrote or removed on behalf of another device – the app refreshes its tree and open tabs. */
  onApplied?: (change: { written: string[]; removed: string[] }) => void
  onConflict?: (conflict: SyncConflict) => void
  onSignedOut?: (reason: string) => void
  now?: () => number
}

const AUTO_INTERVAL_MS = 60_000
const LOCAL_DEBOUNCE_MS = 2_500
const OFFLINE_RETRY_MS = 30_000
/** Without a hint from the server, a throttled cycle goes on after this long. */
const THROTTLE_RETRY_MS = 20_000
const THROTTLE_MAX_MS = 65_000
const MAX_LOG = 120
const MAX_SKIPPED = 200
const MAX_FILE_BYTES = 100 * 1024 * 1024
/**
 * Requests in flight at once. The server allows 1200 requests per minute and account (20 per second), so six
 * uploads at a time stay well inside the budget even on a fast link; a 429 still pauses the cycle.
 */
const PULL_CONCURRENCY = 4
const PUSH_CONCURRENCY = 6
/** File bytes the uploads in flight may hold at once. Each one briefly holds the file, its canonical form and the encrypted copy. */
const PUSH_BYTE_BUDGET = 32 * 1024 * 1024
/** The account details (storage use, devices) are fetched again after this long even when nothing here changed. */
const ACCOUNT_MAX_AGE_MS = 10 * 60_000

const INTERNAL_DIRECTORY = '.fanotes'
const SKIPPED_INTERNAL = new Set(['history', 'onboarding.json', 'tree-cache', 'trash'])
const SKIPPED_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

export type SyncPathOptions = {
  excludedPrefixes?: readonly string[]
  includeRecognitionModel?: boolean
  includeHistory?: boolean
  includeAttachments?: boolean
}

/** A note, PDF note or shared metadata file. Everything else is an attachment. */
export const isNoteSyncPath = (path: string) => (
  /\.(?:md|markdown|famd|pdf)$/iu.test(path) || path.startsWith('.fanotes/') || path.split('/').some((segment) => /\.story$/iu.test(segment))
)

/** Which vault paths take part in sync: notes, assets and the shared `.fanotes/` metadata, but no local caches or temp files. */
export const isSyncablePath = (path: string, options: SyncPathOptions = {}) => {
  if (!path || path.length > 1024 || path.includes('\0') || path.startsWith('/') || path.includes('//')) return false
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false
  const name = segments[segments.length - 1]
  if (SKIPPED_NAMES.has(name) || /\.tmp$/iu.test(name) || /^\.~lock\./u.test(name) || /^~\$/u.test(name)) return false
  if (path === RECOGNITION_MODEL_SYNC_PATH && !options.includeRecognitionModel) return false
  if (pathIsSyncExcluded(path, options.excludedPrefixes ?? [])) return false
  if (options.includeAttachments === false && !isNoteSyncPath(path)) return false
  // Notes other people shared with this account live in their own, separately encrypted share. They must not be copied into this account's cloud.
  if (segments[0] === SHARED_INBOX_FOLDER) return false
  if (segments[0] === INTERNAL_DIRECTORY) {
    if (segments.length < 2) return false
    if (SKIPPED_INTERNAL.has(segments[1]) && !(options.includeHistory && segments[1] === 'history')) return false
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
  const suffix = ` (Konflikt ${device} ${stamp})${extension}`
  // A long name plus the suffix can pass the 255-byte name limit: shorten the stem, keep the suffix.
  return `${directory}${takeUtf8Bytes(stem, MAX_NAME_BYTES - utf8Length(suffix))}${suffix}`
}

/** Linux and Android allow 255 bytes (UTF-8) per file or folder name. */
export const MAX_NAME_BYTES = 255
const utf8Length = (text: string) => new TextEncoder().encode(text).length

/** `text` cut to at most `maxBytes` UTF-8 bytes, never inside a character. */
export const takeUtf8Bytes = (text: string, maxBytes: number) => {
  if (utf8Length(text) <= maxBytes) return text
  let used = 0
  let result = ''
  for (const character of text) {
    const size = utf8Length(character)
    if (used + size > maxBytes) break
    used += size
    result += character
  }
  return result.trimEnd()
}

const defaultDeviceName = (platform: string) => {
  if (platform === 'web' || platform === 'browser-preview') return 'Browser'
  if (platform === 'win32') return 'Windows-Gerät'
  if (platform === 'darwin') return 'Mac'
  if (platform === 'linux') return 'Linux-Gerät'
  return 'Gerät'
}

const emptyState = (accountId: string): PersistedState => ({ version: 1, accountId, cursor: 0, lastSyncAt: null, files: {}, conflicts: [], pendingDeletes: [], skipped: [] })

/** Bases for optional paths stay saved while that setting is off, and when a folder is excluded. Trash and caches still drop. */
const PERSISTED_SYNC_PATHS: SyncPathOptions = { includeRecognitionModel: true, includeHistory: true, includeAttachments: true }

export const loadPersistedSyncState = (raw: string | null, accountId: string): PersistedState => {
  if (!raw) return emptyState(accountId)
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    if (parsed.version !== 1 || parsed.accountId !== accountId || typeof parsed.files !== 'object' || !parsed.files) return emptyState(accountId)
    const files: Record<string, LocalBase> = {}
    for (const [path, base] of Object.entries(parsed.files)) {
      if (!isSyncablePath(path, PERSISTED_SYNC_PATHS) || !base || typeof base !== 'object') continue
      const candidate = base as Partial<LocalBase>
      if (typeof candidate.id !== 'string' || typeof candidate.sha256 !== 'string') continue
      files[path] = {
        id: candidate.id,
        revision: Number(candidate.revision) || 0,
        sha256: candidate.sha256,
        size: Number(candidate.size) || 0,
        mtimeMs: Number(candidate.mtimeMs) || 0,
        ...(typeof candidate.contentSha256 === 'string' && candidate.contentSha256 ? { contentSha256: candidate.contentSha256 } : {}),
        ...(candidate.blank === true ? { blank: true } : {}),
      }
    }
    const ctimes: Record<string, number> = {}
    for (const [path, value] of Object.entries(parsed.ctimes ?? {})) if (files[path] && Number.isFinite(value) && value > 0) ctimes[path] = value
    return {
      version: 1,
      accountId,
      ctimes,
      cursor: Number.isInteger(parsed.cursor) && (parsed.cursor as number) >= 0 ? (parsed.cursor as number) : 0,
      lastSyncAt: typeof parsed.lastSyncAt === 'string' ? parsed.lastSyncAt : null,
      files,
      conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts.filter((item): item is SyncConflict => Boolean(item) && typeof item.path === 'string' && typeof item.copyPath === 'string').slice(-50) : [],
      pendingDeletes: Array.isArray(parsed.pendingDeletes) ? parsed.pendingDeletes.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 1024).slice(-500) : [],
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped.filter((item): item is SkippedEntry => Boolean(item) && typeof item.id === 'string' && typeof item.revision === 'number').slice(-MAX_SKIPPED) : [],
    }
  } catch {
    return emptyState(accountId)
  }
}

const parseState = loadPersistedSyncState

const heldCount = (state: PersistedState) => state.skipped.reduce((count, item) => count + (item.held ? 1 : 0), 0)

const parseSecrets = (raw: string | null): Secrets | null => {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<Secrets>
    if (parsed.v !== 1 || typeof parsed.accountId !== 'string' || typeof parsed.deviceId !== 'string' || typeof parsed.token !== 'string' || typeof parsed.email !== 'string' || typeof parsed.vaultSecret !== 'string') return null
    const username = typeof parsed.username === 'string' ? parsed.username : null
    const credential: SyncCredential = parsed.credential === 'device-key' ? 'device-key' : 'password'
    return { v: 1, accountId: parsed.accountId, deviceId: parsed.deviceId, token: parsed.token, expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : '', email: parsed.email, vaultSecret: parsed.vaultSecret, username, credential }
  } catch {
    return null
  }
}

/**
 * Runs `task` for every item, `limit` at a time. After the first failure no worker takes another item, and the
 * call settles only once every worker has finished the one it holds, with that first error. A cycle that failed
 * must not leave workers behind that still write files and change the sync state: the state is saved and a new
 * cycle can start right after, and a crash in between would leave new disk content with an old base.
 */
const runLimited = async <T>(items: T[], limit: number, task: (item: T) => Promise<void>, weighting?: { weight: (item: T) => number; budget: number }) => {
  let index = 0
  let failed = false
  let failure: unknown
  let held = 0
  let running = 0
  let waiters: Array<() => void> = []
  const wake = () => { const list = waiters; waiters = []; for (const resolve of list) resolve() }
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && index < items.length) {
      const item = items[index]
      const weight = weighting ? weighting.weight(item) : 0
      // A big file waits until the uploads in flight have released enough of the byte budget; it always runs alone at worst.
      if (weighting && running > 0 && held + weight > weighting.budget) {
        await new Promise<void>((resolve) => { waiters.push(resolve) })
        continue
      }
      index += 1
      held += weight
      running += 1
      try {
        await task(item)
      } catch (error) {
        if (!failed) failure = error
        failed = true
        return
      } finally {
        held -= weight
        running -= 1
        wake()
      }
    }
  })
  await Promise.all(workers)
  if (failed) throw failure
}

export class SyncEngine {
  /** Something happened (an upload, a download, a delete) that can change the account's storage numbers. */
  private accountStale = true
  private accountFetchedAt = 0
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
  /** Compare the local manifest with the server's in the next cycle: after sign-in or start, and after the connection came back. */
  private needsReconcile = true
  private failures = new Map<string, string>()
  private timer: number | null = null
  /** While the server throttles, nothing starts a request: only the scheduled resume runs, at this time (epoch ms). A manual sync waits for it too. */
  private throttledUntil = 0
  private debounce: number | null = null
  /** Local files already reported as unreadable. A file that stays unreadable is reported once, not on every cycle. */
  private readonly unreadableLogged = new Set<string>()
  private readonly cleared = new Set<string>()
  /** Server copies of story scenes this session saw (revision and plain bytes), to check uploads against without a download. */
  private readonly storyBases = new Map<string, { revision: number; bytes: Uint8Array }>()
  private rememberStoryBase(path: string, revision: number, bytes: Uint8Array) {
    if (storyRoleOf(path) !== 'scene') return
    this.storyBases.delete(path)
    this.storyBases.set(path, { revision, bytes })
    if (this.storyBases.size > 400) this.storyBases.delete(this.storyBases.keys().next().value!)
  }
  /** True from account creation until the settings round trip has stored "cloud sync off". */
  private newAccountHold = false
  private disposed = false
  private windowListeners: Array<() => void> = []
  private readonly localChangeListeners = new Set<() => void>()

  /** Other components (shares) learn about every local save. */
  onLocalChange(listener: () => void) {
    this.localChangeListeners.add(listener)
    return () => { this.localChangeListeners.delete(listener) }
  }

  private readonly syncRequestListeners = new Set<() => void>()

  /** Other components (shares) learn when the user asks for a sync or the network came back. */
  onSyncRequest(listener: () => void) {
    this.syncRequestListeners.add(listener)
    return () => { this.syncRequestListeners.delete(listener) }
  }

  constructor(api?: SyncApi) {
    this.api = api ?? new SyncApi()
    this.snapshot = { status: 'unavailable', account: null, vaultId: null, lastSyncAt: null, error: null, progress: null, pausedUntil: null, pendingLocal: 0, trackedFiles: 0, heldRemote: 0, conflicts: [], openConflicts: 0, failed: [], log: [], info: null, vaultSync: true }
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

  private pathOptions(): SyncPathOptions {
    return {
      excludedPrefixes: this.options?.excludedPrefixes?.() ?? [],
      includeRecognitionModel: this.options?.includeRecognitionModel?.() ?? false,
      includeHistory: this.options?.includeHistory?.() ?? false,
      includeAttachments: this.options?.includeAttachments?.() ?? true,
    }
  }

  private acceptsPath(path: string) {
    return isSyncablePath(path, this.pathOptions())
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
      const kick = () => { if (this.session && this.options?.automatic()) { this.needsReconcile = true; void this.syncNow('online') } }
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
      this.log('info', `Angemeldet als ${secrets.username || secrets.email}.`)
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
      this.unreadableLogged.clear()
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
    this.session = { accountId: secrets.accountId, deviceId: secrets.deviceId, token: secrets.token, expiresAt: secrets.expiresAt, email: secrets.email, username: secrets.username ?? null, credential: secrets.credential ?? 'password' }
    this.vaultId ??= await this.host.vaultId()
    this.state = parseState(await this.host.readState(this.vaultId), secrets.accountId)
    // A new session starts without the previous one's pause and without its unreadable-file reports.
    this.throttledUntil = 0
    this.needsReconcile = true
    this.failures.clear()
    this.unreadableLogged.clear()
    this.setState({
      failed: [],
      status: 'idle',
      account: { email: secrets.email, accountId: secrets.accountId, deviceId: secrets.deviceId, username: secrets.username ?? null, credential: secrets.credential ?? 'password' },
      vaultSync: this.vaultSyncOn(),
      vaultId: this.vaultId,
      lastSyncAt: this.state.lastSyncAt,
      conflicts: this.state.conflicts,
      error: null,
      pausedUntil: null,
      trackedFiles: Object.keys(this.state.files).length,
      heldRemote: heldCount(this.state),
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
    this.setState({ trackedFiles: Object.keys(this.state.files).length, heldRemote: heldCount(this.state), conflicts: this.state.conflicts, lastSyncAt: this.state.lastSyncAt })
  }

  private deviceInfo() {
    const name = (this.options?.deviceName() ?? '').trim() || defaultDeviceName(this.options?.platform ?? '')
    return { name: name.slice(0, 80), platform: (this.options?.platform ?? 'unknown').replace(/[^a-z0-9-]/giu, '').toLowerCase().slice(0, 24) || 'unknown' }
  }

  // ── Account ─────────────────────────────────────────────────────────────

  /** Cloud sync of the vault: the user's setting, unless a brand-new account has not been through the settings round trip yet. */
  private vaultSyncOn() {
    return !this.newAccountHold && (this.options?.vaultSync?.() ?? true)
  }

  /** The user switched cloud sync on or off in the settings. */
  vaultSyncChanged() {
    this.newAccountHold = false
    this.setState({ vaultSync: this.vaultSyncOn() })
    if (this.vaultSyncOn()) void this.syncNow('manual')
  }

  /** The account's own device keys. Only desktop hosts that can protect them offer this. */
  private async readDeviceKeys(): Promise<DeviceKeys> {
    try {
      const raw = await this.host?.readSecrets(DEVICE_KEYS_SLOT)
      const parsed = raw ? JSON.parse(raw) as Partial<DeviceKeys> : null
      if (parsed?.v === 1 && parsed.keys && typeof parsed.keys === 'object') return { v: 1, keys: parsed.keys }
    } catch { /* unreadable: treated as empty */ }
    return { v: 1, keys: {} }
  }

  private async writeDeviceKeys(keys: DeviceKeys) {
    await this.host?.writeSecrets(Object.keys(keys.keys).length ? JSON.stringify(keys) : null, DEVICE_KEYS_SLOT)
  }

  /** True when this host can keep a device key safe (desktop). The web build cannot, so accounts without a password are not offered there. */
  supportsDeviceKey() {
    return Boolean(this.host?.secretsProtected)
  }

  /** Accounts on this device that open with a device key instead of a password. */
  async deviceKeyAccounts(): Promise<Array<{ accountId: string; username: string }>> {
    if (!this.supportsDeviceKey()) return []
    const stored = await this.readDeviceKeys()
    return Object.entries(stored.keys).map(([accountId, entry]) => ({ accountId, username: entry.username }))
  }

  /**
   * Creates an account. Only a username is required. Without a password the account is bound to a random device
   * key held in the OS keychain: whoever loses the device loses the account and its cloud data. An e-mail address
   * is optional and only meant for a later password reset. Cloud sync starts off for every new account.
   */
  async createAccount(options: { username: string; email?: string; password?: string }) {
    this.requireHost()
    const usernameIssue = usernameProblem(options.username)
    if (usernameIssue) throw new Error(usernameIssue)
    const username = options.username.trim()
    const email = options.email?.trim().toLowerCase() || undefined
    const password = options.password || undefined
    if (password) {
      const problem = passwordProblems(password)
      if (problem) throw new Error(problem)
    } else if (!this.supportsDeviceKey()) {
      throw new Error('Ohne Passwort geht das nur in der Desktop-App, die den Gerätschlüssel sicher speichern kann.')
    }
    const credential: SyncCredential = password ? 'password' : 'device-key'
    const pendingId = `pending:${username.toLowerCase()}`
    // A device-key attempt that was cut off (timeout) may have created the account: retry with the same key.
    const earlierPending = credential === 'device-key' ? (await this.readDeviceKeys()).keys[pendingId] : undefined
    const secretText = password ?? earlierPending?.key ?? newDeviceKey()
    const kdf = newKdf()
    const { wrappingKey, authKey } = await deriveFromPassword(secretText, kdf)
    const secret = newVaultSecret()
    const vaultKeyWrap = await wrapVaultSecret(secret, wrappingKey)
    const userKey = await createUserKeyPair(await importVaultSecret(secret))
    // The device key is stored before the account exists on the server, so a crash in between cannot lock the user out of a half-made account.
    // It is keyed by username until the account id is known.
    let pendingKeys: DeviceKeys | null = null
    if (credential === 'device-key') {
      pendingKeys = await this.readDeviceKeys()
      pendingKeys.keys[`pending:${username.toLowerCase()}`] = { username, key: secretText }
      await this.writeDeviceKeys(pendingKeys)
    }
    let result: Awaited<ReturnType<SyncApi['register']>>
    try {
      result = await this.api.register({ username, ...(email ? { email } : {}), credential, publicKey: userKey.publicKey, userKeyWrap: userKey.wrap, authKey, kdf, vaultKeyWrap, device: this.deviceInfo() })
    } catch (error) {
      if (pendingKeys) {
        const unknownOutcome = !(error instanceof SyncApiError) || error.status === 0
        if (unknownOutcome) throw error // the server may have created the account: keep the key for a retry or sign-in
        if (error.status === 409 && earlierPending) {
          // Taken, and we hold a key from an earlier attempt: that attempt may be the one that made it.
          try {
            await this.loginWithDeviceKey(pendingId)
            return
          } catch { /* not our account */ }
        }
        delete pendingKeys.keys[pendingId]
        await this.writeDeviceKeys(pendingKeys).catch(() => undefined)
      }
      throw error
    }
    if (pendingKeys) {
      delete pendingKeys.keys[`pending:${username.toLowerCase()}`]
      pendingKeys.keys[result.accountId] = { username: result.username ?? username, key: secretText }
      await this.writeDeviceKeys(pendingKeys)
    }
    // A new account does not upload the vault until the user turns cloud sync on.
    this.newAccountHold = true
    this.options?.setVaultSync?.(false)
    await this.signInWith({ v: 1, accountId: result.accountId, deviceId: result.deviceId, token: result.token, expiresAt: result.expiresAt, email: result.email ?? '', username: result.username ?? username, credential, vaultSecret: toBase64(secret) })
    secret.fill(0)
    this.log('info', credential === 'device-key'
      ? 'Konto erstellt. Es ist an den Schlüssel dieses Geräts gebunden. Cloud-Sync ist aus, bis du ihn einschaltest.'
      : 'Konto erstellt. Cloud-Sync ist aus, bis du ihn einschaltest.')
  }

  /** Account with an e-mail address and a password (the original way). */
  async register(email: string, password: string) {
    this.requireHost()
    const problem = passwordProblems(password)
    if (problem) throw new Error(problem)
    const kdf = newKdf()
    const { wrappingKey, authKey } = await deriveFromPassword(password, kdf)
    const secret = newVaultSecret()
    const vaultKeyWrap = await wrapVaultSecret(secret, wrappingKey)
    const result = await this.api.register({ email: email.trim().toLowerCase(), authKey, kdf, vaultKeyWrap, device: this.deviceInfo() })
    await this.signInWith({ v: 1, accountId: result.accountId, deviceId: result.deviceId, token: result.token, expiresAt: result.expiresAt, email: email.trim().toLowerCase(), username: null, credential: 'password', vaultSecret: toBase64(secret) })
    secret.fill(0)
    this.log('info', 'Konto erstellt. Der Vault-Schlüssel wurde auf diesem Gerät erzeugt und verschlüsselt hinterlegt.')
  }

  /** `who` is a username or an e-mail address (an `@` means e-mail). */
  async login(who: string, password: string) {
    this.requireHost()
    const normalized = who.trim()
    const identifier = normalized.includes('@') ? { email: normalized.toLowerCase() } : { username: normalized }
    const { kdf } = await this.api.prelogin(identifier)
    if (!isValidKdf(kdf)) throw new Error('Der Server hat unbrauchbare Schlüsselparameter geliefert.')
    const { wrappingKey, authKey } = await deriveFromPassword(password, kdf)
    const result = await this.api.login({ ...identifier, authKey, device: this.deviceInfo() })
    const secret = await unwrapVaultSecret(result.vaultKeyWrap, wrappingKey)
    const label = result.username || result.email || normalized
    await this.signInWith({ v: 1, accountId: result.accountId, deviceId: result.deviceId, token: result.token, expiresAt: result.expiresAt, email: result.email ?? '', username: result.username ?? null, credential: result.credential, vaultSecret: toBase64(secret) })
    secret.fill(0)
    this.log('info', `Angemeldet als ${label}. Die Notizen des Kontos werden geholt.`)
  }

  /** Signs in again on a device that holds the account's device key. */
  async loginWithDeviceKey(accountId: string) {
    this.requireHost()
    const stored = (await this.readDeviceKeys()).keys[accountId]
    if (!stored) throw new Error('Auf diesem Gerät gibt es keinen Schlüssel für dieses Konto.')
    const { kdf } = await this.api.prelogin({ username: stored.username })
    if (!isValidKdf(kdf)) throw new Error('Der Server hat unbrauchbare Schlüsselparameter geliefert.')
    const { wrappingKey, authKey } = await deriveFromPassword(stored.key, kdf)
    const result = await this.api.login({ username: stored.username, authKey, device: this.deviceInfo() })
    const secret = await unwrapVaultSecret(result.vaultKeyWrap, wrappingKey)
    await this.signInWith({ v: 1, accountId: result.accountId, deviceId: result.deviceId, token: result.token, expiresAt: result.expiresAt, email: result.email ?? '', username: result.username ?? stored.username, credential: result.credential, vaultSecret: toBase64(secret) })
    secret.fill(0)
    if (accountId.startsWith('pending:')) {
      // The account exists after all: file the key under its id.
      const keys = await this.readDeviceKeys()
      delete keys.keys[accountId]
      keys.keys[result.accountId] = { username: result.username ?? stored.username, key: stored.key }
      await this.writeDeviceKeys(keys)
    }
    this.log('info', `Angemeldet als ${result.username ?? stored.username}.`)
  }

  /** The secret that proves the account: the typed password, or the stored device key for a password-less account. */
  private async accountSecret(password?: string) {
    if (!this.session) throw new Error('Nicht angemeldet.')
    if (password) return password
    if (this.session.credential === 'device-key') {
      const stored = (await this.readDeviceKeys()).keys[this.session.accountId]
      if (stored) return stored.key
      throw new Error('Der Schlüssel dieses Kontos liegt nicht auf diesem Gerät.')
    }
    throw new Error('Bitte das Passwort angeben.')
  }

  private loginIdentifier() {
    if (!this.session) throw new Error('Nicht angemeldet.')
    return this.session.username ? { username: this.session.username } : { email: this.session.email }
  }

  /** Adds a recovery e-mail to the account. The current password (or the stored device key) proves it is the owner. */
  async setEmail(email: string, password?: string) {
    if (!this.session) throw new Error('Nicht angemeldet.')
    const secret = await this.accountSecret(password)
    const { kdf } = await this.api.prelogin(this.loginIdentifier())
    const { authKey } = await deriveFromPassword(secret, kdf)
    const normalized = email.trim().toLowerCase()
    const result = await this.api.setEmail(this.session, { email: normalized, authKey })
    this.session = { ...this.session, email: result.email ?? normalized }
    await this.persistSecrets(this.currentSecrets())
    this.setState({ account: this.snapshot.account ? { ...this.snapshot.account, email: result.email ?? normalized } : null })
    await this.refreshAccount()
  }

  /** Gives an older account a username (and with it the sharing key pair). Cannot be changed afterwards. */
  async claimUsername(name: string) {
    if (!this.session || !this.vaultSecretBase64) throw new Error('Nicht angemeldet.')
    const problem = usernameProblem(name)
    if (problem) throw new Error(problem)
    const userKey = await createUserKeyPair(await importVaultSecret(fromBase64(this.vaultSecretBase64)))
    const result = await this.api.setUsername(this.session, { username: name.trim(), publicKey: userKey.publicKey, userKeyWrap: userKey.wrap })
    this.session = { ...this.session, username: result.username }
    await this.persistSecrets(this.currentSecrets())
    this.setState({ account: this.snapshot.account ? { ...this.snapshot.account, username: result.username } : null })
    this.log('info', `Benutzername ${result.username} gesetzt.`)
    await this.refreshAccount()
  }

  /**
   * The key pair other people share to. Accounts made before sharing existed get one here, once they have a
   * username. Returns null while the account has no username (nobody can share with it yet).
   */
  async sharingIdentity(): Promise<{ username: string; publicKey: string; privateKey: CryptoKey } | null> {
    if (!this.session || !this.vaultSecretBase64) return null
    const vaultSecret = await importVaultSecret(fromBase64(this.vaultSecretBase64))
    let info = this.snapshot.info
    if (!info || info.accountId !== this.session.accountId) info = await this.refreshAccount()
    if (!info?.username) return null
    if (!info.userKey) {
      const created = await createUserKeyPair(vaultSecret)
      try {
        await this.api.setUserKey(this.session, { publicKey: created.publicKey, userKeyWrap: created.wrap })
      } catch (error) {
        // Another device made the key first: use theirs.
        if (!(error instanceof SyncApiError && error.status === 409)) throw error
      }
      info = await this.refreshAccount()
      if (!info?.userKey) return null
    }
    return { username: info.username!, publicKey: info.userKey!.publicKey, privateKey: await openUserPrivateKey(info.userKey!.publicKey, info.userKey!.wrap, vaultSecret) }
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
    // The pause belonged to this session. Whoever signs in next starts with an open gate.
    this.throttledUntil = 0
    this.newAccountHold = false
    this.unreadableLogged.clear()
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
    await this.persistSecrets(null)
    if (this.host && this.vaultId) await this.host.writeState(this.vaultId, null)
    this.setState({ status: 'signed-out', account: null, info: null, progress: null, pausedUntil: null, pendingLocal: 0, trackedFiles: 0, heldRemote: 0, conflicts: [], openConflicts: 0, error: null })
  }

  /**
   * Fetches the account details (storage use, devices). With `onlyIfChanged` the call is skipped while the details
   * we have are still current: nothing was uploaded, downloaded or changed since, and they are younger than ten minutes.
   * The server sends no ETag for this route, so the engine tracks the changes that can alter the answer itself.
   */
  async refreshAccount(options: { onlyIfChanged?: boolean } = {}) {
    if (!this.session) return null
    const current = this.snapshot.info
    if (options.onlyIfChanged && current && !this.accountStale && current.accountId === this.session.accountId && Date.now() - this.accountFetchedAt < ACCOUNT_MAX_AGE_MS) return current
    try {
      this.accountStale = false
      const info = await this.api.account(this.session)
      this.accountFetchedAt = Date.now()
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
    const { kdf: currentKdf } = await this.api.prelogin(this.loginIdentifier())
    const current = await deriveFromPassword(await this.accountSecret(currentPassword || undefined), currentKdf)
    const kdf = newKdf()
    const next = await deriveFromPassword(nextPassword, kdf)
    const vaultKeyWrap = await wrapVaultSecret(fromBase64(this.vaultSecretBase64), next.wrappingKey)
    await this.api.changePassword(this.session, { authKey: current.authKey, newAuthKey: next.authKey, kdf, vaultKeyWrap })
    if (this.session.credential === 'device-key') {
      // The password replaces the device key: the account now opens anywhere with it.
      const stored = await this.readDeviceKeys()
      delete stored.keys[this.session.accountId]
      await this.writeDeviceKeys(stored)
      this.session = { ...this.session, credential: 'password' }
      this.setState({ account: this.snapshot.account ? { ...this.snapshot.account, credential: 'password' } : null })
    }
    this.log('info', 'Passwort geändert; alle anderen Geräte müssen sich neu anmelden.')
  }

  async deleteAccount(password: string) {
    if (!this.session) throw new Error('Nicht angemeldet.')
    await this.waitIdle()
    const { kdf } = await this.api.prelogin(this.loginIdentifier())
    const { authKey } = await deriveFromPassword(await this.accountSecret(password || undefined), kdf)
    const accountId = this.session.accountId
    await this.api.deleteAccount(this.session, authKey)
    const stored = await this.readDeviceKeys()
    if (stored.keys[accountId]) {
      delete stored.keys[accountId]
      await this.writeDeviceKeys(stored).catch(() => undefined)
    }
    await this.forgetSession()
    this.log('info', 'Konto und alle Daten auf dem Server gelöscht.')
  }

  getSession() { return this.session }

  private currentSecrets(): Secrets | null {
    if (!this.session || !this.vaultSecretBase64) return null
    return {
      v: 1,
      accountId: this.session.accountId,
      deviceId: this.session.deviceId,
      token: this.session.token,
      expiresAt: this.session.expiresAt,
      email: this.session.email,
      username: this.session.username ?? null,
      credential: this.session.credential ?? 'password',
      vaultSecret: this.vaultSecretBase64,
    }
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
    for (const listener of [...this.localChangeListeners]) {
      try { listener() } catch (error) { console.error('[sync] local-change listener failed', error) }
    }
    if (!this.session || !this.options?.automatic()) return
    if (this.debounce !== null) window.clearTimeout(this.debounce)
    this.debounce = window.setTimeout(() => { this.debounce = null; void this.syncNow('local-change') }, LOCAL_DEBOUNCE_MS)
  }

  /** The editor cleared this note on purpose. A blank file is not uploaded without it. */
  markCleared(path: string) {
    this.cleared.add(path)
  }

  /**
   * The user deleted or renamed this path. A missing file is not a delete:
   * only paths recorded here become tombstones.
   */
  markDeleted(path: string) {
    if (!this.state) return
    const normal = path.replace(/^\/+|\/+$/gu, '')
    if (!normal || normal.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return
    if (!this.state.pendingDeletes.includes(normal)) this.state.pendingDeletes.push(normal)
    void this.persistState()
    this.notifyLocalChange()
  }

  /** `resume`: go on with an interrupted cycle even when automatic sync is off (it was started on purpose). */
  private schedule(delay: number, resume = false) {
    if (this.disposed || !this.session) return
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      if (this.options?.automatic() || delay === 0 || resume) void this.syncNow(resume ? 'resume' : 'timer')
      else this.schedule(AUTO_INTERVAL_MS)
    }, delay)
  }

  /** Resolves once no cycle is running any more (queued follow-ups included). */
  private waitIdle(): Promise<void> {
    return this.inFlight ? this.inFlight.then(() => this.waitIdle()) : Promise.resolve()
  }

  /**
   * How long the server's pause still lasts, in milliseconds (0: no pause). A pause is never longer than the
   * server can ask for: a clock that jumped back since it began must not keep the gate shut for the size of the jump.
   */
  private pauseRemaining() {
    if (!this.throttledUntil) return 0
    const now = Date.now()
    if (this.throttledUntil - now > THROTTLE_MAX_MS) {
      this.throttledUntil = now + THROTTLE_MAX_MS
      if (this.snapshot.status === 'paused') this.setState({ pausedUntil: this.throttledUntil })
    }
    return Math.max(0, this.throttledUntil - now)
  }

  /** The status after work that runs outside a cycle: still 'paused' while the server's pause lasts. */
  private restingStatus(): SyncStatus {
    return this.pauseRemaining() > 0 ? 'paused' : 'idle'
  }

  /** Runs one full cycle; concurrent calls coalesce into at most one follow-up cycle. The promise settles when the engine is idle again. */
  syncNow(reason = 'manual'): Promise<void> {
    if (!this.session || !this.host) return Promise.resolve()
    if (reason === 'manual' || reason === 'online') for (const listener of [...this.syncRequestListeners]) { try { listener() } catch (error) { console.error('[sync] sync-request listener failed', error) } }
    if (reason !== 'resume') {
      const wait = this.pauseRemaining()
      if (wait > 0) {
        // The server throttles: no request goes out before the pause is over, then the sync goes on. A manual sync
        // asks for exactly that. Any other trigger leaves a pending timer alone; when there is none, the pause
        // swallowed the timer that keeps the periodic sync alive (a vault switch or a sign-in replaced the resume
        // timer by an immediate one) and it is armed again, or nothing would ever sync by itself.
        if (reason === 'manual' || this.timer === null) this.schedule(wait, true)
        return Promise.resolve()
      }
    }
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
    // A cycle starts outside a pause, or as its end: the server's window is over. What this cycle meets decides
    // what comes next (a new 429 sets the pause again). The file listing of an earlier cycle is out of date too.
    this.throttledUntil = 0
    this.scanCache = null
    if (!this.vaultSyncOn()) {
      // Cloud sync is off: the account stays signed in (sharing needs it), but no vault file leaves or enters this device through it.
      this.setState({ status: 'idle', error: null, progress: null, pausedUntil: null, pendingLocal: 0, vaultSync: false })
      this.schedule(AUTO_INTERVAL_MS)
      return
    }
    this.setState({ status: 'syncing', error: null, progress: null, pausedUntil: null, vaultSync: true })
    try {
      let conflicts = await this.pull()
      if (this.needsReconcile && this.options?.reconcile !== false) {
        await this.reconcileWithServer()
        this.needsReconcile = false
      }
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
      if (error instanceof SyncApiError && error.throttled) {
        // A large first sync uses up the server's request budget. What is done so far is saved,
        // so the next cycle goes on from there; this is a pause, not an error.
        const wait = Math.min(THROTTLE_MAX_MS, Math.max(1_000, error.retryAfterMs ?? THROTTLE_RETRY_MS))
        this.throttledUntil = Date.now() + wait
        this.setState({ status: 'paused', error: null, progress: null, pausedUntil: this.throttledUntil })
        this.log('info', `Der Server bremst kurz. Der Sync geht in ${Math.round(wait / 1000)} s weiter.`)
        this.schedule(wait, true)
        return
      }
      const offline = error instanceof SyncApiError && error.offline
      const message = error instanceof Error ? error.message : 'Sync fehlgeschlagen.'
      if (offline) this.needsReconcile = true
      this.setState({ status: offline ? 'offline' : 'error', error: message, progress: null })
      this.log(offline ? 'warn' : 'error', message)
      this.schedule(offline ? OFFLINE_RETRY_MS : AUTO_INTERVAL_MS)
    } finally {
      // A push that failed halfway leaves its listing of the vault behind; the next cycle must look at the vault as it is then.
      this.scanCache = null
    }
  }

  // ── Pull ────────────────────────────────────────────────────────────────

  private async localSnapshot(path: string): Promise<{ bytes: Uint8Array; sha256: string; rawSha256: string; identity: string; kind: NoteSyncKind; stat: SyncScanEntry } | null> {
    if (!this.host) return null
    try {
      const bytes = await this.host.read(path)
      const kind = noteSyncKind(path, bytes)
      if (kind === 'unreadable') return { bytes, sha256: '', rawSha256: '', identity: '', kind, stat: { path, size: bytes.byteLength, mtimeMs: 0 } }
      const identityBytes = identitySyncBytes(path, bytes)
      if (!identityBytes) return { bytes, sha256: '', rawSha256: '', identity: '', kind: 'unreadable', stat: { path, size: bytes.byteLength, mtimeMs: 0 } }
      const syncBytes = canonicalSyncBytes(path, bytes)
      const rawSha256 = await sha256Hex(bytes)
      const sha256 = syncBytes === bytes ? rawSha256 : await sha256Hex(syncBytes)
      return { bytes, sha256, rawSha256, identity: await sha256Hex(identityBytes), kind, stat: { path, size: bytes.byteLength, mtimeMs: 0 } }
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
    // The entries listed just now. The cursor moves past one only once it has been dealt with.
    const unfinished = new Set(pending)
    const seen = new Set(pending.map((entry) => entry.id))
    for (const entry of this.state.skipped) {
      if (!seen.has(entry.id)) pending.push(entry)
    }
    if (!pending.length) return 0
    this.setState({ progress: { phase: 'pull', done: 0, total: pending.length } })
    const idIndex = new Map(Object.entries(this.state.files).map(([path, base]) => [base.id, path]))
    let done = 0
    let completed = false
    try {
      await runLimited(pending, PULL_CONCURRENCY, async (entry) => {
        const { result, path, unreadable } = await this.applyRemote(entry, idIndex).catch((error: unknown): RemoteOutcome => {
          // Sign-in and network errors end the cycle. One damaged or undecryptable
          // entry must not keep every local edit on this device from uploading:
          // it waits on the skip list and is tried again on the next pull.
          if (cycleWide(error)) throw error
          this.log('warn', `Ein Eintrag konnte nicht übernommen werden und wird später erneut versucht (${error instanceof Error ? error.message : 'unbekannt'}).`)
          return { result: 'skipped', path: null }
        })
        if (result === 'conflict') conflicts += 1
        if (result === 'written' || result === 'removed' || result === 'conflict') this.accountStale = true
        if ((result === 'written' || result === 'conflict') && path) written.push(path)
        if (result === 'removed' && path) removed.push(path)
        // A change to a note that is open with unsaved edits, or to a file that cannot be read here, is put
        // off: it waits on the skip list and is tried again on every pull, while the cursor moves on. Holding
        // the cursor back instead would list everything after it again on every cycle, for as long as the
        // note stays open or locked.
        if (result === 'deferred') this.rememberSkip(entry, true)
        else if (result === 'skipped') this.rememberSkip(entry)
        else this.forgetSkip(entry.id)
        if (path && !unreadable) this.unreadableLogged.delete(path)
        unfinished.delete(entry)
        done += 1
        this.setState({ progress: { phase: 'pull', done, total: pending.length } })
      })
      completed = true
    } finally {
      if (this.state) {
        // Everything before the first entry that is still open has been dealt with. After a failure that is where
        // the next pull goes on: it neither skips an entry nor lists the finished ones again.
        let reachable = since
        for (const entry of unfinished) reachable = Math.min(reachable, entry.revision - 1)
        this.state.cursor = Math.max(this.state.cursor, reachable)
      }
      // Files written before a failure are on disk. Their bookkeeping is saved and the app is told, so the file
      // tree and open tabs show them; otherwise the next cycle sees them as unchanged and nobody refreshes, and
      // an open editor would keep the old text and save it over the newer one. After a failure the error that
      // ended the pull is the one to report, so a state that cannot be saved is reported only after a good run.
      try {
        await this.persistState()
      } catch (error) {
        if (completed) throw error
      } finally {
        if (written.length || removed.length) this.options?.onApplied?.({ written, removed })
      }
    }
    return conflicts
  }

  private async applyRemote(entry: SyncRemoteEntry, idIndex: Map<string, string>): Promise<RemoteOutcome> {
    if (!this.session || !this.host || !this.state || !this.keys) return { result: 'skipped', path: null }
    const knownPath = idIndex.get(entry.id) ?? null

    if (entry.deleted) {
      if (!knownPath) return { result: 'noop', path: null }
      const base = this.state.files[knownPath]
      if (!base || entry.revision <= base.revision) return { result: 'noop', path: knownPath }
      if (this.options?.isPathBusy?.(knownPath)) return { result: 'deferred', path: knownPath }
      const local = await this.localSnapshot(knownPath)
      if (!local && (await this.presentHere(knownPath))) return this.unreadableHere(knownPath)
      if (!local) {
        delete this.state.files[knownPath]
        idIndex.delete(entry.id)
        return { result: 'noop', path: knownPath }
      }
      if (local.kind !== 'unreadable' && (local.sha256 === base.sha256 || local.rawSha256 === base.sha256)) {
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
    if (!this.acceptsPath(path)) return { result: 'skipped', path: null }
    const base = this.state.files[path]
    // We already hold this or a newer revision (our own upload, or a re-fetch after a held cursor).
    if (base && base.id === entry.id && entry.revision <= base.revision) return { result: 'noop', path }
    if (this.options?.isPathBusy?.(path)) return { result: 'deferred', path }
    const local = await this.localSnapshot(path)
    // A file that is here but cannot be read (permissions, locked, too large) is not
    // "missing": writing the server's version would replace it without a copy.
    if (!local && (await this.presentHere(path))) return this.unreadableHere(path)
    // Match the server hash only. The stored identity says the local file still
    // matches the previous revision, which is exactly when a newer remote edit must be applied.
    if (local && local.kind !== 'unreadable' && (local.sha256 === meta.sha256 || local.rawSha256 === meta.sha256)) {
      const stat = await this.statOf(path)
      // Remember the canonical hash once the file still matches the server, so a
      // later statistics write (new size, same note) is not uploaded.
      this.state.files[path] = {
        id: entry.id,
        revision: entry.revision,
        sha256: local.sha256 || meta.sha256,
        size: stat?.size ?? local.stat.size,
        mtimeMs: stat?.mtimeMs ?? local.stat.mtimeMs,
        contentSha256: local.identity,
        ...(local.kind === 'blank' ? { blank: true } : {}),
      }
      idIndex.set(entry.id, path)
      return { result: 'noop', path }
    }
    const localChanged = Boolean(local) && (
      !base
      || local!.kind === 'unreadable'
      || (base.contentSha256
        ? local!.identity !== base.contentSha256
        : local!.sha256 !== base.sha256 && local!.rawSha256 !== base.sha256)
    )
    const download = await this.api.download(this.session, entry.id)
    if ('deleted' in download) {
      // Deleted again between the change list and the download; the tombstone arrives with the next pull.
      return { result: 'noop', path }
    }
    if (await sha256Hex(download.blob) !== download.sha256) throw new Error(`Die Datei „${path}“ kam beschädigt vom Server.`)
    const plain = await decryptBytes(this.keys, entry.id, download.blob)
    if (await sha256Hex(plain) !== meta.sha256) throw new Error(`Die Prüfsumme von „${path}“ stimmt nach dem Entschlüsseln nicht.`)
    const plainCanonical = canonicalSyncBytes(path, plain)
    const plainCanonicalSha = plainCanonical === plain ? meta.sha256 : await sha256Hex(plainCanonical)
    const plainIdentityBytes = identitySyncBytes(path, plain)
    const plainIdentity = plainIdentityBytes ? await sha256Hex(plainIdentityBytes) : ''
    if (local && local.kind !== 'unreadable' && (plainCanonicalSha === local.sha256 || (plainIdentity && plainIdentity === local.identity))) {
      // The note matches. Only page statistics or the timestamp differ, and those stay on this device.
      const stat = await this.statOf(path)
      this.state.files[path] = {
        id: entry.id,
        revision: download.revision,
        sha256: plainCanonicalSha,
        size: stat?.size ?? local.stat.size,
        mtimeMs: stat?.mtimeMs ?? 0,
        contentSha256: local.identity || plainIdentity,
        ...(local.kind === 'blank' ? { blank: true } : {}),
      }
      idIndex.set(entry.id, path)
      return { result: 'noop', path }
    }
    const remoteKind = noteSyncKind(path, plain)
    let result: 'written' | 'conflict' = 'written'
    if (path === HOMEWORK_NOTE_PATH && local && localChanged && local.kind === 'present' && remoteKind === 'present') {
      // Task-by-task merge instead of a conflict copy. The base stays the remote revision, so the next push uploads the merge.
      const merged = mergeHomeworkMarkdownBytes(local.bytes, plain)
      if (merged) {
        // The download took a while: an editor may have started on this file meanwhile (writing mode).
        if (this.options?.isPathBusy?.(path)) return { result: 'deferred', path }
        await this.host.write(path, merged, Date.now())
        // Size and mtime of the remote copy, so the push scan sees the merged file as changed.
        this.state.files[path] = {
          id: entry.id,
          revision: download.revision,
          sha256: meta.sha256,
          size: plain.byteLength,
          mtimeMs: 0,
          ...(plainIdentity ? { contentSha256: plainIdentity } : {}),
        }
        idIndex.set(entry.id, path)
        this.log('info', `„${path}“ wurde Aufgabe für Aufgabe zusammengeführt.`)
        return { result: 'written', path }
      }
    }
    let storyAdopt = false
    if (storyRoleOf(path) && local && localChanged && local.kind === 'present') {
      // Story files merge instead of becoming whole-file conflict copies (see src/writing/syncMerge.ts).
      const localStat = await this.statOf(path)
      const outcome = mergeStoryFile(path, local.bytes, plain, { localMtimeMs: localStat?.mtimeMs ?? 0, remoteMtimeMs: meta.mtimeMs || 0 })
      // The base becomes the remote revision with the remote size and no mtime, so the push uploads what stays here.
      const remoteBase = (): LocalBase => ({ id: entry.id, revision: download.revision, sha256: meta.sha256, size: plain.byteLength, mtimeMs: 0, ...(plainIdentity ? { contentSha256: plainIdentity } : {}) })
      if (outcome?.kind === 'merged' && outcome.sameAsRemote) {
        // Everything this device had is in the remote version already.
        storyAdopt = true
      } else if (outcome?.kind === 'merged') {
        // The download took a while: an editor may have started on this file meanwhile (writing mode).
        if (this.options?.isPathBusy?.(path)) return { result: 'deferred', path }
        if (!outcome.sameAsLocal) await this.host.write(path, outcome.bytes, Date.now())
        this.state.files[path] = remoteBase()
        idIndex.set(entry.id, path)
        this.log('info', outcome.conflicts
          ? `„${path}“ wurde Absatz für Absatz zusammengeführt; ${outcome.conflicts} Absatz/Absätze waren auf beiden Geräten geändert und stehen jetzt doppelt da.`
          : `„${path}“ wurde Absatz für Absatz zusammengeführt.`)
        return { result: 'written', path }
      } else if (outcome?.kind === 'keep-local' || (outcome?.kind === 'pick' && outcome.keep === 'local')) {
        // The local version keeps the path; the remote one is kept beside it (when it holds anything).
        let result: 'written' | 'conflict' = 'written'
        if (remoteKind === 'present') {
          const at = new Date(this.options?.now?.() ?? Date.now())
          const copyPath = await this.freeConflictCopyPath(path, at)
          await this.host.write(copyPath, plain, meta.mtimeMs || at.getTime())
          const conflict = { path, copyPath, at: at.toISOString() }
          this.state.conflicts = [...this.state.conflicts, conflict].slice(-50)
          this.log('warn', `Konflikt bei „${path}“: die neuere Fassung dieses Geräts bleibt, die andere liegt unter „${copyPath}“.`)
          this.options?.onConflict?.(conflict)
          result = 'conflict'
        }
        this.state.files[path] = remoteBase()
        idIndex.set(entry.id, path)
        return { result, path }
      }
    }
    if (local && !storyAdopt && (localChanged || (remoteKind === 'blank' && local.kind !== 'blank'))) {
      // The download took a while: an editor may have started on this file meanwhile (writing mode). Ask before the
      // copy is written, not after: a deferral that leaves a copy and a conflict entry behind would write a second
      // copy and a second entry for the same remote version when it is tried again.
      if (this.options?.isPathBusy?.(path)) return { result: 'deferred', path }
      const at = new Date(this.options?.now?.() ?? Date.now())
      const copyPath = await this.freeConflictCopyPath(path, at)
      await this.host.write(copyPath, local.bytes, at.getTime())
      const conflict = { path, copyPath, at: at.toISOString() }
      this.state.conflicts = [...this.state.conflicts, conflict].slice(-50)
      this.log('warn', `Konflikt bei „${path}“: die lokale Fassung liegt jetzt unter „${copyPath}“.`)
      this.options?.onConflict?.(conflict)
      result = 'conflict'
    }
    let body = plain
    if (local && isFamdSyncPath(path)) {
      const spliced = withLocalPageStats(syncText(plain), syncText(local.bytes))
      body = new TextEncoder().encode(spliced)
    }
    // The download took a while: an editor may have started on this file meanwhile (writing mode).
    if (this.options?.isPathBusy?.(path)) return { result: 'deferred', path }
    const stat = await this.host.write(path, body, meta.mtimeMs || Date.now())
    this.rememberStoryBase(path, download.revision, plain)
    const storedKind = noteSyncKind(path, body)
    const storedIdentity = identitySyncBytes(path, body)
    this.state.files[path] = {
      id: entry.id,
      revision: download.revision,
      sha256: meta.sha256,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(storedIdentity ? { contentSha256: await sha256Hex(storedIdentity) } : {}),
      ...(storedKind === 'blank' ? { blank: true } : {}),
    }
    idIndex.set(entry.id, path)
    return { result, path }
  }

  private scanCache: Map<string, SyncScanEntry> | null = null

  /** The file is listed here (the scan needs no read access), even if reading it fails. */
  private async presentHere(path: string) {
    return (await this.statOf(path)) !== null || (await this.exists(path))
  }

  /**
   * Leaves a file this device cannot read alone (retried next cycle, like a busy file). It is reported once:
   * a file that stays locked for hours would otherwise push every real message out of the log.
   */
  private unreadableHere(path: string): RemoteOutcome {
    if (!this.unreadableLogged.has(path)) {
      this.unreadableLogged.add(path)
      this.log('warn', `„${path}“ ist auf diesem Gerät vorhanden, lässt sich aber nicht lesen. Die Fassung vom Server wird nicht darübergeschrieben; der Abgleich versucht es später erneut.`)
    }
    return { result: 'deferred', path, unreadable: true }
  }

  private async statOf(path: string) {
    if (!this.host) return null
    if (!this.scanCache) this.scanCache = new Map((await this.host.scan()).map((entry) => [entry.path, entry]))
    return this.scanCache.get(path) ?? null
  }

  // ── Scan + push ─────────────────────────────────────────────────────────

  private async push(): Promise<{ uploads: number; deletes: number; conflicts: number }> {
    if (!this.session || !this.host || !this.state || !this.keys) return { uploads: 0, deletes: 0, conflicts: 0 }
    this.setState({ progress: { phase: 'scan', done: 0, total: 0 } })
    const entries = (await this.host.scan()).filter((entry) => this.acceptsPath(entry.path))
    this.scanCache = new Map(entries.map((entry) => [entry.path, entry]))
    const present = new Set(entries.map((entry) => entry.path))
    this.setState({ openConflicts: groupConflicts(present).length })
    // Deletes the user asked for before this scan. One marked while the push runs waits for the next cycle.
    const consideredDeletes = new Set(this.state.pendingDeletes)
    const changed: SyncScanEntry[] = []
    this.failures.clear()
    const ctimes = (this.state.ctimes ??= {})
    for (const entry of entries) {
      if (entry.size > MAX_FILE_BYTES) {
        this.failures.set(entry.path, `Größer als ${MAX_FILE_BYTES / 1024 / 1024} MB, das Limit des Syncs.`)
        continue
      }
      const base = this.state.files[entry.path]
      // An external tool can restore the modification time after it changed a file (cp -p, restore tools).
      // The status-change time still moves; the file is then read and compared by content.
      const touched = Boolean(base && entry.ctimeMs && ctimes[entry.path] && ctimes[entry.path] !== entry.ctimeMs)
      if (!base || base.size !== entry.size || base.mtimeMs !== entry.mtimeMs || !entry.mtimeMs || !base.sha256 || touched) changed.push(entry)
      else if (entry.ctimeMs) ctimes[entry.path] ??= entry.ctimeMs
    }
    for (const path of Object.keys(ctimes)) if (!present.has(path)) delete ctimes[path]
    const missing = Object.keys(this.state.files).filter((path) => this.acceptsPath(path) && !present.has(path) && !this.options?.isPathBusy?.(path))
    const deleted = missing.filter((path) => this.isPendingDelete(path))
    const vanished = missing.filter((path) => !this.isPendingDelete(path))
    for (const path of vanished) await this.restoreVanished(path)
    this.setState({ pendingLocal: changed.length + deleted.length, progress: { phase: 'push', done: 0, total: changed.length + deleted.length } })

    let uploads = 0
    let deletes = 0
    let conflicts = 0
    let done = 0
    const total = changed.length + deleted.length
    // Live numbers while the uploads run: files done of total, the shrinking upload queue and the tracked files.
    const tick = () => {
      done += 1
      this.setState({
        progress: { phase: 'push', done, total },
        pendingLocal: Math.max(0, total - done),
        ...(done % 5 === 0 || done === total ? { trackedFiles: Object.keys(this.state?.files ?? {}).length } : {}),
      })
    }

    await runLimited(changed, PUSH_CONCURRENCY, async (entry) => {
      try {
        const outcome = await this.uploadPath(entry)
        if (outcome === 'uploaded') uploads += 1
        if (outcome === 'conflict') conflicts += 1
        if ((outcome === 'uploaded' || outcome === 'unchanged') && entry.ctimeMs) ctimes[entry.path] = entry.ctimeMs
      } catch (error) {
        // Sign-in, network and server-wide errors end the cycle. A refusal of this one file must not keep the
        // files after it from uploading: it is reported with its reason and the rest goes on.
        if (cycleWide(error)) throw error
        const reason = error instanceof Error && error.message ? error.message : 'Der Server hat die Datei abgelehnt.'
        this.failures.set(entry.path, reason)
        this.log('error', `„${entry.path}“ wurde nicht hochgeladen: ${reason}`)
      } finally {
        tick()
      }
    }, { weight: (entry) => entry.size, budget: PUSH_BYTE_BUDGET })
    for (const path of deleted) {
      try {
        const outcome = await this.deletePath(path)
        if (outcome === 'deleted') deletes += 1
        if (outcome === 'conflict') conflicts += 1
      } catch (error) {
        if (cycleWide(error)) throw error
        this.log('error', `„${path}“ konnte nicht auf dem Server gelöscht werden: ${error instanceof Error ? error.message : 'unbekannt'}`)
      } finally {
        tick()
      }
    }
    await this.settlePendingDeletes(consideredDeletes)
    if (uploads || deletes) this.accountStale = true
    this.scanCache = null
    this.publishFailures()
    await this.persistState()
    return { uploads, deletes, conflicts }
  }

  private async uploadPath(entry: SyncScanEntry, depth = 0): Promise<'uploaded' | 'unchanged' | 'conflict' | 'skipped'> {
    if (!this.session || !this.host || !this.state || !this.keys) return 'skipped'
    let readError = ''
    const raw = await this.host.read(entry.path).catch((error: unknown) => {
      readError = error instanceof Error ? error.message : ''
      return null
    })
    if (!raw) {
      this.failures.set(entry.path, `Die Datei konnte nicht gelesen werden${readError ? ` (${readError})` : ''}.`)
      return 'skipped'
    }
    const kind = noteSyncKind(entry.path, raw)
    const baseEarly = this.state.files[entry.path]
    if (kind === 'unreadable') {
      this.log('warn', `„${entry.path}“ konnte nicht gelesen werden und wird nicht hochgeladen.`)
      this.failures.set(entry.path, 'Die Notiz ist beschädigt oder unvollständig und wird nicht hochgeladen.')
      if (baseEarly && !baseEarly.blank) return this.restoreInstead(entry, baseEarly, raw)
      return 'skipped'
    }
    const identityBytes = identitySyncBytes(entry.path, raw)
    if (!identityBytes) {
      this.failures.set(entry.path, 'Die Notiz ist beschädigt oder unvollständig und wird nicht hochgeladen.')
      if (baseEarly && !baseEarly.blank) return this.restoreInstead(entry, baseEarly, raw)
      return 'skipped'
    }
    const bytes = canonicalSyncBytes(entry.path, raw)
    const rawSha256 = await sha256Hex(raw)
    const sha256 = bytes === raw ? rawSha256 : await sha256Hex(bytes)
    const identity = await sha256Hex(identityBytes)
    const base = this.state.files[entry.path]
    if (base && (base.contentSha256 === identity || base.sha256 === sha256 || base.sha256 === rawSha256)) {
      // Touched but the same note (a statistics write, a new timestamp, or the
      // editor saved the same text): nothing to send.
      this.state.files[entry.path] = {
        ...base,
        sha256: base.sha256 || sha256,
        contentSha256: identity,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        ...(kind === 'blank' ? { blank: true } : { blank: undefined }),
      }
      this.cleared.delete(entry.path)
      return 'unchanged'
    }
    const clearing = this.cleared.has(entry.path)
    const severeShrink = Boolean(base) && !base?.blank && base!.size >= 4096 && (raw.byteLength <= 1024 || raw.byteLength * 4 < base!.size)
    const baseHoldsContent = Boolean(base) && !base?.blank && (base!.size > raw.byteLength + 64 || kind === 'blank' || severeShrink)
    // A scene or manifest that shrank a lot is checked against the server's version:
    // a cut the writer made (every paragraph still there, deleted ones as tombstones)
    // is uploaded; one that lost paragraphs is merged with the server's version first.
    const storyRole = storyRoleOf(entry.path)
    const storyShrinkable = kind === 'present' && (storyRole === 'scene' || storyRole === 'manifest')
    let storyClear = false
    if (storyRole === 'scene' && kind === 'present' && base && !base.blank && !clearing && !(severeShrink && baseHoldsContent)) {
      // Every scene upload keeps every paragraph of the server's version (deleted ones as
      // tombstones). A file that lost paragraphs without a trace is merged back first.
      const verdict = await this.judgeStoryShrink(entry, base, raw)
      if (verdict.kind === 'merge') return this.rewriteStory(entry, verdict.bytes, depth)
    }
    if (severeShrink && baseHoldsContent && !clearing && storyShrinkable && base) {
      const verdict = await this.judgeStoryShrink(entry, base, raw)
      if (verdict.kind === 'merge') return this.rewriteStory(entry, verdict.bytes, depth)
      if (verdict.kind === 'guard') return this.restoreInstead(entry, base, raw)
      // 'cut' uploads with the clear flag; 'stale' (a newer version exists) is refused as stale and merged below.
      storyClear = verdict.kind === 'cut'
    } else if ((kind === 'blank' || severeShrink) && baseHoldsContent && !clearing) {
      this.log('warn', `„${entry.path}“ ist leer und wird nicht über die vorhandene Fassung hochgeladen.`)
      return this.restoreInstead(entry, base!, raw)
    }
    const id = base?.id ?? await fileIdFor(this.keys, entry.path)
    const meta = await encryptMeta(this.keys, id, { path: entry.path, mtimeMs: entry.mtimeMs, size: bytes.byteLength, sha256 })
    const blob = await encryptBytes(this.keys, id, bytes)
    const blobSha256 = await sha256Hex(blob)
    let baseRevision = base?.revision ?? 0
    // A 409 is resolved here from the entry the server sends back. Waiting for
    // the next pull is not enough: that entry can be older than the pull cursor
    // (a tombstone from weeks ago, a change that was skipped), and then the same
    // upload would be refused on every cycle and the note would never sync.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const revision = await this.api.upload(this.session, id, baseRevision, meta, blobSha256, blob, { blank: kind === 'blank', clear: (clearing && kind === 'blank') || storyClear })
        this.cleared.delete(entry.path)
        this.rememberStoryBase(entry.path, revision, bytes)
        this.state.files[entry.path] = {
          id,
          revision,
          sha256,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          contentSha256: identity,
          ...(kind === 'blank' ? { blank: true } : {}),
        }
        return 'uploaded'
      } catch (error) {
        if (!(error instanceof SyncApiError && error.conflict)) {
          if (error instanceof SyncApiError && error.status === 507) {
            this.log('error', `„${entry.path}“ passt nicht mehr in den Speicher des Kontos: ${error.message}`)
            this.failures.set(entry.path, `Der Speicher des Kontos ist voll: ${error.message}`)
            return 'skipped'
          }
          throw error
        }
        const current = error.entry && error.entry.id === id ? error.entry : null
        // The base was current, so the server refused the body itself as empty or
        // collapsed (older servers send no reason). Sending it again cannot help:
        // keep this file beside the note and put the server copy back.
        if (error.guarded || (current && !current.deleted && current.revision === baseRevision)) {
          if (storyShrinkable && base && !storyClear && attempt === 0) {
            // The server's guard counts encrypted bytes; check the story file the same way as above.
            const verdict = await this.judgeStoryShrink(entry, { ...base, revision: current?.revision ?? base.revision }, raw)
            if (verdict.kind === 'merge') return this.rewriteStory(entry, verdict.bytes, depth)
            if (verdict.kind === 'cut') {
              storyClear = true
              continue
            }
          }
          if (base) return this.restoreInstead(entry, { ...base, revision: current?.revision ?? base.revision }, raw, 'guard')
          return 'skipped'
        }
        if (current?.deleted) {
          if (kind === 'blank') {
            // Nothing to put back over the tombstone. Track the blank file so it is not sent again.
            this.state.files[entry.path] = { id, revision: current.revision, sha256, size: entry.size, mtimeMs: entry.mtimeMs, contentSha256: identity, blank: true }
            return 'skipped'
          }
          if (attempt === 0) {
            // Deleted elsewhere, or by an older build of this app, while the file is
            // still here. A tombstone holds no content, so this copy goes back on top.
            this.log('info', `„${entry.path}“ war im Sync gelöscht, liegt hier aber noch vor – die lokale Fassung wird wieder hochgeladen.`)
            baseRevision = current.revision
            continue
          }
          return 'conflict'
        }
        if (current) {
          // A newer revision exists. Apply it now: a changed local file becomes a conflict copy.
          const idIndex = new Map(Object.entries(this.state.files).map(([filePath, known]) => [known.id, filePath]))
          try {
            const applied = await this.applyRemote(current, idIndex)
            if ((applied.result === 'written' || applied.result === 'conflict') && applied.path) this.options?.onApplied?.({ written: [applied.path], removed: [] })
            if (applied.result === 'written' && applied.path === entry.path && storyRole && depth === 0) {
              // A story file was merged with the newer version: upload the merge in this cycle.
              const fresh = (await this.host.scan()).find((item) => item.path === entry.path)
              if (fresh) {
                const again = await this.uploadPath(fresh, depth + 1)
                return again === 'uploaded' ? 'uploaded' : 'conflict'
              }
            }
          } catch (applyError) {
            if (cycleWide(applyError)) throw applyError
            this.log('warn', `„${entry.path}“ konnte nicht abgeglichen werden und wird später erneut versucht (${applyError instanceof Error ? applyError.message : 'unbekannt'}).`)
          }
          return 'conflict'
        }
        if (kind === 'blank' && base) return this.restoreInstead(entry, base, raw)
        return 'conflict'
      }
    }
    return 'conflict'
  }

  /** What the server's version says about a much smaller story file (see `judgeStoryShrink`). */
  private async judgeStoryShrink(entry: SyncScanEntry, base: LocalBase, raw: Uint8Array): Promise<{ kind: 'cut' } | { kind: 'merge'; bytes: Uint8Array } | { kind: 'guard' } | { kind: 'stale' }> {
    if (!this.session || !this.keys) return { kind: 'guard' }
    const cached = this.storyBases.get(entry.path)
    if (cached && cached.revision === base.revision) {
      const verdict = judgeStoryShrink(entry.path, raw, cached.bytes)
      if (verdict.kind === 'merge') this.log('warn', `„${entry.path}“ fehlten Absätze der Fassung auf dem Server; sie wurden wieder eingefügt.`)
      return verdict
    }
    const download = await this.api.download(this.session, base.id)
    if ('deleted' in download) return { kind: 'stale' }
    if (download.revision !== base.revision) return { kind: 'stale' }
    if (await sha256Hex(download.blob) !== download.sha256) return { kind: 'guard' }
    const plain = await decryptBytes(this.keys, base.id, download.blob)
    this.rememberStoryBase(entry.path, download.revision, plain)
    const verdict = judgeStoryShrink(entry.path, raw, plain)
    if (verdict.kind === 'cut') this.log('info', `„${entry.path}“ wurde stark gekürzt; alle Absätze sind als gelöscht vermerkt, die Kürzung wird hochgeladen.`)
    if (verdict.kind === 'merge') this.log('warn', `„${entry.path}“ fehlten Absätze der Fassung auf dem Server; sie wurden wieder eingefügt.`)
    return verdict
  }

  /** Writes a merged story file here and uploads it (once per push). The editor still holding the file waits for the next cycle. */
  private async rewriteStory(entry: SyncScanEntry, bytes: Uint8Array, depth: number): Promise<'uploaded' | 'conflict' | 'skipped' | 'unchanged'> {
    if (!this.host || this.options?.isPathBusy?.(entry.path)) return 'skipped'
    const stat = await this.host.write(entry.path, bytes, Date.now())
    this.options?.onApplied?.({ written: [entry.path], removed: [] })
    if (depth > 0) return 'conflict'
    return this.uploadPath(stat, depth + 1)
  }

  /** The blank (or, after a guard rejection, collapsed) local file is kept beside the note. The server copy is written back. */
  private async restoreInstead(entry: SyncScanEntry, base: LocalBase, localBytes: Uint8Array, why: 'blank' | 'guard' = 'blank'): Promise<'conflict' | 'skipped'> {
    if (!this.session || !this.host || !this.state || !this.keys) return 'skipped'
    // The editor still holds this note. Writing under it would be saved over again; try once it is quiet.
    if (this.options?.isPathBusy?.(entry.path)) return 'skipped'
    const download = await this.api.download(this.session, base.id)
    if ('deleted' in download) return 'conflict'
    if (await sha256Hex(download.blob) !== download.sha256) return 'skipped'
    const plain = await decryptBytes(this.keys, base.id, download.blob)
    if (noteSyncKind(entry.path, plain) !== 'present') {
      const identityBytes = identitySyncBytes(entry.path, localBytes)
      this.state.files[entry.path] = {
        ...base,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        blank: true,
        ...(identityBytes ? { contentSha256: await sha256Hex(identityBytes) } : {}),
      }
      return 'skipped'
    }
    const at = new Date(this.options?.now?.() ?? Date.now())
    const copyPath = await this.freeConflictCopyPath(entry.path, at)
    await this.host.write(copyPath, localBytes, at.getTime())
    const conflict = { path: entry.path, copyPath, at: at.toISOString() }
    this.state.conflicts = [...this.state.conflicts, conflict].slice(-50)
    this.log('warn', why === 'guard'
      ? `Der Sync-Server hat die stark gekürzte Fassung von „${entry.path}“ nicht übernommen. Die lokale Kopie liegt unter „${copyPath}“.`
      : `Leere Fassung von „${entry.path}“ wurde nicht hochgeladen. Die lokale Kopie liegt unter „${copyPath}“.`)
    this.options?.onConflict?.(conflict)
    const stat = await this.host.write(entry.path, plain, at.getTime())
    this.options?.onApplied?.({ written: [entry.path, copyPath], removed: [] })
    const identityBytes = identitySyncBytes(entry.path, plain)
    const { blank: _ignored, ...kept } = base
    this.state.files[entry.path] = {
      ...kept,
      sha256: base.sha256 || await sha256Hex(plain),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(identityBytes ? { contentSha256: await sha256Hex(identityBytes) } : {}),
    }
    return 'conflict'
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
        // A newer remote edit wins the race. It is applied; the local delete is not a tombstone.
        if (error.entry && this.state) {
          const idIndex = new Map(Object.entries(this.state.files).map(([filePath, base]) => [base.id, filePath]))
          await this.applyRemote(error.entry, idIndex)
        }
        return 'conflict'
      }
      throw error
    }
  }

  /**
   * A delete mark lives only until it has been applied. It used to stay while
   * any tracked file was left under it: after a folder delete lost the race
   * against a newer edit from another device, the restored note kept the mark,
   * and the next time that note was missing for any other reason (a linked
   * folder offline, a scan that missed it) it was deleted on every device.
   * Now a mark set before this cycle's scan is dropped once nothing tracked
   * under it is missing any more: its files were deleted, or a newer version
   * came back and is present again.
   */
  /** Publishes the files that did not upload in this cycle (status line and Settings → Sync). */
  private publishFailures() {
    this.setState({ failed: [...this.failures].map(([path, reason]) => ({ path, reason })).sort((a, b) => a.path.localeCompare(b.path, 'de')) })
  }

  /** The user asks for another attempt at the files that did not upload (also runs a full cycle). */
  retryFailed(): Promise<void> {
    this.needsReconcile = true
    return this.syncNow('manual')
  }

  /**
   * Compares the local manifest with the server's file table and forgets what the server no longer has: a
   * server restored from a backup, an account that was cleaned, an upload that never landed. The files are then
   * "new" and the push sends them. Entries that wait on the skip list (a remote delete put off while the note is
   * open) are left alone.
   */
  private async reconcileWithServer() {
    if (!this.session || !this.state) return
    const server = new Map<string, { revision: number; deleted: boolean }>()
    let since = 0
    for (let page = 0; page < 500; page += 1) {
      const changes = await this.api.changes(this.session, since)
      for (const entry of changes.entries) server.set(entry.id, { revision: entry.revision, deleted: entry.deleted })
      since = changes.nextSince
      if (!changes.more) break
    }
    const waiting = new Set(this.state.skipped.map((entry) => entry.id))
    let reset = 0
    for (const [path, base] of Object.entries(this.state.files)) {
      if (!this.acceptsPath(path) || waiting.has(base.id)) continue
      const remote = server.get(base.id)
      if (remote && !remote.deleted && remote.revision >= base.revision) continue
      if (this.isPendingDelete(path)) continue
      delete this.state.files[path]
      reset += 1
    }
    if (reset) this.log('info', `Abgleich mit dem Server: ${reset} ${reset === 1 ? 'Datei fehlt' : 'Dateien fehlen'} dort und ${reset === 1 ? 'wird' : 'werden'} erneut hochgeladen.`)
  }

  private async settlePendingDeletes(considered: ReadonlySet<string>) {
    if (!this.host || !this.state || !this.state.pendingDeletes.length) return
    const tracked = Object.keys(this.state.files)
    if (!this.state.pendingDeletes.some((entry) => considered.has(entry))) return
    const presentNow = new Set((await this.host.scan()).map((entry) => entry.path))
    this.state.pendingDeletes = this.state.pendingDeletes.filter((entry) => (
      !considered.has(entry)
      || tracked.some((candidate) => (candidate === entry || candidate.startsWith(`${entry}/`)) && !presentNow.has(candidate))
    ))
  }

  /** `conflictCopyPath`, numbered when a copy from the same minute exists, so no earlier copy is overwritten. */
  private async freeConflictCopyPath(path: string, at: Date) {
    const first = conflictCopyPath(path, this.deviceInfo().name, at)
    for (let number = 1; number < 1000; number += 1) {
      const candidate = number === 1 ? first : numberedVariant(first, number)
      if (!(await this.exists(candidate))) return candidate
    }
    return numberedVariant(first, Date.now())
  }

  private async exists(path: string) {
    if (!this.host) return false
    try {
      await this.host.read(path)
      return true
    } catch {
      return false
    }
  }

  private isPendingDelete(path: string) {
    if (!this.state) return false
    return this.state.pendingDeletes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  }

  /** `held`: a change from another device that waits because the note is open or unreadable here (it counts in `heldRemote`). */
  private rememberSkip(entry: SyncRemoteEntry, held = false) {
    if (!this.state || !entry.id) return
    const rest = this.state.skipped.filter((item) => item.id !== entry.id)
    const next: SkippedEntry[] = [...rest, {
      id: entry.id,
      revision: entry.revision,
      deleted: Boolean(entry.deleted),
      size: Number(entry.size) || 0,
      sha256: entry.sha256,
      meta: entry.meta,
      updatedAt: entry.updatedAt,
      deviceId: entry.deviceId,
      ...(held ? { held: true as const } : {}),
    }]
    // The list is capped. A held entry carries a change that must still arrive, so the oldest entries of
    // folders that stay on another device on purpose go first.
    let excess = next.length - MAX_SKIPPED
    const kept: SkippedEntry[] = []
    for (const item of next) {
      if (excess > 0 && !item.held) excess -= 1
      else kept.push(item)
    }
    this.state.skipped = excess > 0 ? kept.slice(excess) : kept
  }

  private forgetSkip(id: string) {
    if (!this.state) return
    if (!this.state.skipped.some((item) => item.id === id)) return
    this.state.skipped = this.state.skipped.filter((item) => item.id !== id)
  }

  /** A tracked file disappeared without an explicit delete. Put the server copy back. */
  private async restoreVanished(path: string): Promise<void> {
    if (!this.session || !this.host || !this.state || !this.keys) return
    const base = this.state.files[path]
    if (!base) return
    try {
      const download = await this.api.download(this.session, base.id)
      if ('deleted' in download) {
        delete this.state.files[path]
        return
      }
      if (await sha256Hex(download.blob) !== download.sha256) return
      const plain = await decryptBytes(this.keys, base.id, download.blob)
      const stat = await this.host.write(path, plain, Date.now())
      const identityBytes = identitySyncBytes(path, plain)
      this.state.files[path] = {
        ...base,
        revision: download.revision,
        sha256: await sha256Hex(plain),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ...(identityBytes ? { contentSha256: await sha256Hex(identityBytes) } : {}),
      }
    } catch {
      // Leave the tracking entry. Do not upload and do not tombstone.
    }
  }

  clearConflicts() {
    if (!this.state) return
    this.state.conflicts = []
    void this.persistState()
  }

  dismissConflict(copyPath: string) {
    if (!this.state) return
    this.state.conflicts = this.state.conflicts.filter((conflict) => conflict.copyPath !== copyPath)
    void this.persistState()
    this.setState({ conflicts: this.state.conflicts })
  }

  // ── Conflict resolution ─────────────────────────────────────────────────

  /** Runs `task` while no sync cycle runs; cycles asked for meanwhile follow afterwards. */
  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    while (this.inFlight) await this.waitIdle()
    let release!: () => void
    this.inFlight = new Promise<void>((resolve) => { release = resolve })
    this.scanCache = null
    try {
      return await task()
    } finally {
      this.scanCache = null
      this.inFlight = null
      release()
      if (this.queued && !this.disposed) {
        this.queued = false
        void this.syncNow('queued')
      }
    }
  }

  /** Every document with a conflict copy in this vault, whichever device made the copy. */
  async listConflicts(): Promise<ConflictGroup[]> {
    if (!this.host) return []
    const scanned = (await this.host.scan()).filter((entry) => this.acceptsPath(entry.path))
    const present = new Set(scanned.map((entry) => entry.path))
    const stats = new Map(scanned.map((entry) => [entry.path, { size: entry.size, mtimeMs: entry.mtimeMs }]))
    const groups = groupConflicts(present, this.state?.conflicts ?? []).map((group) => ({
      ...group,
      files: Object.fromEntries(group.pairs.flatMap((pair) => [pair.path, pair.copyPath]).flatMap((path) => (stats.has(path) ? [[path, stats.get(path)!]] : []))),
    }))
    if (this.state) {
      const kept = this.state.conflicts.filter((conflict) => present.has(conflict.copyPath))
      if (kept.length !== this.state.conflicts.length) {
        this.state.conflicts = kept
        await this.persistState()
      }
    }
    this.setState({ openConflicts: groups.length })
    return groups
  }

  /** The bytes of one side of a conflict, for the preview. Null when the file is gone. */
  async readConflictFile(path: string): Promise<Uint8Array | null> {
    if (!this.host || !this.acceptsPath(path)) return null
    try {
      return await this.host.read(path)
    } catch {
      return null
    }
  }

  /**
   * Keeps one version of a conflicted document (or both) and makes every
   * device agree. `expected` holds the SHA-256 of each file as the user saw it
   * in the preview; if any of them changed in the meantime nothing is touched
   * and the result is `changed`.
   *
   * - `original`: the conflict copy is removed (desktop: system trash). The
   *   server keeps the removed copy in its archive.
   * - `copy`: the copy's exact bytes (text, handwriting, page data) become the
   *   document. They are uploaded first, with the revision this device holds
   *   as the base, so a newer edit from another device is never replaced; only
   *   then is the local file replaced (the old one goes to the system trash on
   *   desktop, and the server archives its previous revision) and the copy removed.
   * - `both`: the copy is renamed to `Name (Fassung …).ext` and stays an ordinary file.
   *
   * `expected` maps each path to `conflictFingerprint` of the bytes shown.
   */
  async resolveConflict(group: ConflictGroup, keep: ConflictKeep, expected: Record<string, string | null>): Promise<{ status: 'resolved' | 'changed'; message: string }> {
    if (!this.session || !this.host || !this.state || !this.keys) throw new Error('Melde dich beim Sync an, um einen Konflikt zu lösen.')
    for (const pair of group.pairs) {
      for (const path of [pair.path, pair.copyPath]) {
        if (!this.acceptsPath(path)) throw new Error(`„${path}“ wird nicht synchronisiert.`)
        if (this.options?.isPathBusy?.(path)) throw new Error(`„${path}“ ist gerade geöffnet und noch nicht gespeichert. Speichere die Notiz und versuche es dann erneut.`)
      }
    }
    if (keep === 'original' && group.pairs.some((pair) => expected[pair.path] === null)) {
      throw new Error('Die Originaldatei fehlt. Behalte die Kopie oder beide Fassungen.')
    }
    const changed = { status: 'changed' as const, message: 'Eine der beiden Fassungen hat sich inzwischen geändert. Vergleiche sie bitte noch einmal.' }
    return this.exclusive(async () => {
      const session = this.session
      const host = this.host
      const keys = this.keys
      if (!session || !host || !this.state || !keys) throw new Error('Melde dich beim Sync an, um einen Konflikt zu lösen.')
      let offline = false
      try {
        // Converge first: edits made here go up, edits from other devices come down.
        // Nothing is decided on an outdated view.
        this.setState({ status: 'syncing', error: null })
        await this.pull()
        await this.push()
        const fingerprint = async (path: string) => conflictFingerprint(path, await this.readConflictFile(path))
        for (const pair of group.pairs) {
          if (await fingerprint(pair.copyPath) !== expected[pair.copyPath]) return changed
          if (await fingerprint(pair.path) !== expected[pair.path]) return changed
          if (!expected[pair.copyPath]) return changed
        }
        // A file that is replaced or removed must be on the server exactly as it is
        // here (its archive is the way back). Edits the sync could not upload, a file
        // that is too large or one the server refused, stop the resolution instead.
        for (const pair of group.pairs) {
          const leaving = keep === 'copy' ? pair.path : keep === 'original' ? pair.copyPath : null
          if (leaving && !(await this.uploadedAsIs(leaving))) {
            throw new Error(`„${leaving}“ hat Änderungen, die noch nicht im Sync sind. Beide Fassungen bleiben erhalten; versuche es nach dem nächsten erfolgreichen Abgleich erneut.`)
          }
        }
        const now = this.options?.now?.() ?? Date.now()
        const written: string[] = []
        const removed: string[] = []

        if (keep === 'copy') {
          const chosen = new Map<string, Uint8Array>()
          for (const pair of group.pairs) {
            const bytes = await host.read(pair.copyPath)
            if (noteSyncKind(pair.path, bytes) === 'unreadable') throw new Error(`„${pair.copyPath}“ ist beschädigt und kann nicht übernommen werden.`)
            chosen.set(pair.path, bytes)
          }
          // Upload every file of the document before anything local changes.
          const uploaded: Array<{ path: string; previous: LocalBase | undefined }> = []
          try {
            for (const pair of group.pairs) {
              const previous = this.state.files[pair.path] ? { ...this.state.files[pair.path] } : undefined
              await this.uploadChosen(pair.path, chosen.get(pair.path)!, now)
              uploaded.push({ path: pair.path, previous })
            }
          } catch (error) {
            if (error instanceof SyncApiError && error.conflict) {
              this.log('warn', `Konflikt bei „${group.title}“ nicht gelöst: die Datei wurde auf einem anderen Gerät erneut geändert.`)
              await this.revertChosen(uploaded, now)
              return changed
            }
            await this.revertChosen(uploaded, now)
            throw error
          }
          for (const pair of group.pairs) {
            const bytes = chosen.get(pair.path)!
            // The server archived the replaced version on upload. On desktop it also goes to the
            // system trash; the browser vault deletes for good, so there the file is overwritten in place.
            const browser = this.options?.platform === 'web' || this.options?.platform === 'browser-preview'
            if (!browser && await this.exists(pair.path)) await host.remove(pair.path)
            const stat = await host.write(pair.path, bytes, now)
            this.state.files[pair.path] = { ...this.state.files[pair.path], size: stat.size, mtimeMs: stat.mtimeMs }
            written.push(pair.path)
          }
          for (const pair of group.pairs) {
            if (await this.discardCopy(pair.copyPath)) removed.push(pair.copyPath)
          }
        } else if (keep === 'original') {
          for (const pair of group.pairs) {
            if (!this.state.files[pair.path]) throw new Error(`„${pair.path}“ ist noch nicht im Sync. Versuche es nach dem nächsten Abgleich erneut.`)
          }
          for (const pair of group.pairs) {
            if (await this.discardCopy(pair.copyPath)) removed.push(pair.copyPath)
          }
        } else {
          for (const pair of group.pairs) {
            const target = await this.freeName(keptVersionPath(pair.copyPath))
            const bytes = await host.read(pair.copyPath)
            await this.uploadChosen(target, bytes, now)
            await host.write(target, bytes, now).then((stat) => {
              this.state!.files[target] = { ...this.state!.files[target], size: stat.size, mtimeMs: stat.mtimeMs }
            })
            written.push(target)
            if (await this.discardCopy(pair.copyPath)) removed.push(pair.copyPath)
          }
        }

        const copies = new Set(group.pairs.map((pair) => pair.copyPath))
        this.state.conflicts = this.state.conflicts.filter((conflict) => !copies.has(conflict.copyPath))
        await this.persistState()
        if (written.length || removed.length) this.options?.onApplied?.({ written, removed })
        const message = keep === 'copy'
          ? `„${group.title}“: die Fassung von ${group.device ?? 'dem anderen Gerät'} gilt jetzt auf allen Geräten.`
          : keep === 'original'
            ? `„${group.title}“: die bisherige Fassung bleibt, die Konfliktkopie wurde entfernt.`
            : `„${group.title}“: beide Fassungen bleiben als eigene Dateien.`
        this.log('info', message)
        return { status: 'resolved' as const, message }
      } catch (error) {
        if (error instanceof SyncApiError && error.unauthorized) {
          await this.handleUnauthorized()
          throw new Error('Die Sync-Anmeldung ist abgelaufen. Melde dich erneut an; der Konflikt bleibt bis dahin bestehen.')
        }
        offline = error instanceof SyncApiError && error.offline
        if (offline) throw new Error('Keine Verbindung zum Sync-Server. Der Konflikt bleibt bestehen; löse ihn, sobald du online bist.')
        throw error
      } finally {
        await this.persistState().catch(() => undefined)
        const resting: SyncStatus = !this.session ? this.snapshot.status : offline ? 'offline' : this.restingStatus()
        this.setState({ status: resting, progress: null, pausedUntil: resting === 'paused' ? this.throttledUntil : null })
        void this.listConflicts().catch(() => undefined)
      }
    })
  }

  /**
   * Uploads exactly these bytes as `path`, on top of the revision this device
   * holds. A 409 means another device changed the file since; it is thrown,
   * never retried. The deliberate choice may replace a much larger version, so
   * the server's shrink guard is lifted; it archives the previous blob anyway.
   */
  private async uploadChosen(path: string, raw: Uint8Array, mtimeMs: number) {
    if (!this.session || !this.state || !this.keys) throw new Error('Nicht angemeldet.')
    const kind = noteSyncKind(path, raw)
    if (kind === 'unreadable') throw new Error(`„${path}“ ist beschädigt.`)
    const bytes = canonicalSyncBytes(path, raw)
    const sha256 = await sha256Hex(bytes)
    const identityBytes = identitySyncBytes(path, raw)
    const base = this.state.files[path]
    const id = base?.id ?? await fileIdFor(this.keys, path)
    const meta = await encryptMeta(this.keys, id, { path, mtimeMs, size: bytes.byteLength, sha256 })
    const blob = await encryptBytes(this.keys, id, bytes)
    const revision = await this.api.upload(this.session, id, base?.revision ?? 0, meta, await sha256Hex(blob), blob, { blank: kind === 'blank', clear: true })
    this.state.files[path] = {
      id,
      revision,
      sha256,
      size: raw.byteLength,
      mtimeMs,
      ...(identityBytes ? { contentSha256: await sha256Hex(identityBytes) } : {}),
      ...(kind === 'blank' ? { blank: true } : {}),
    }
  }

  /** True when the file is missing here, or the server holds exactly this content as its tracked revision. */
  private async uploadedAsIs(path: string) {
    if (!this.state) return false
    const local = await this.localSnapshot(path)
    if (!local) return !(await this.exists(path))
    const base = this.state.files[path]
    if (!base || local.kind === 'unreadable') return false
    return base.contentSha256 === local.identity || base.sha256 === local.sha256 || base.sha256 === local.rawSha256
  }

  /** Puts back what an aborted "keep the copy" already uploaded, so a note is never left half replaced. */
  private async revertChosen(uploaded: Array<{ path: string; previous: LocalBase | undefined }>, mtimeMs: number) {
    for (const { path, previous } of uploaded.reverse()) {
      try {
        const local = await this.host?.read(path)
        if (local) await this.uploadChosen(path, local, mtimeMs)
        else if (previous) this.state!.files[path] = previous
      } catch (error) {
        this.log('error', `„${path}“ konnte nach dem Abbruch nicht zurückgesetzt werden (${error instanceof Error ? error.message : 'unbekannt'}). Die Konfliktkopie bleibt erhalten.`)
      }
    }
  }

  /**
   * Removes a conflict copy everywhere. The server delete names the revision
   * this device holds, so a copy edited elsewhere in the meantime is kept.
   * The server archives the deleted blob; on desktop the local file goes to the system trash.
   */
  private async discardCopy(copyPath: string): Promise<boolean> {
    if (!this.session || !this.host || !this.state) return false
    const base = this.state.files[copyPath]
    if (base) {
      try {
        await this.api.remove(this.session, base.id, base.revision)
      } catch (error) {
        if (!(error instanceof SyncApiError && error.conflict && error.entry?.deleted)) {
          if (error instanceof SyncApiError && error.conflict) {
            this.log('warn', `„${copyPath}“ wurde auf einem anderen Gerät geändert und bleibt erhalten.`)
            return false
          }
          throw error
        }
      }
      delete this.state.files[copyPath]
    }
    await this.host.remove(copyPath)
    return true
  }

  private async freeName(path: string) {
    for (let number = 1; number < 1000; number += 1) {
      const candidate = number === 1 ? path : numberedVariant(path, number)
      if (!this.state?.files[candidate] && !(await this.exists(candidate))) return candidate
    }
    return numberedVariant(path, Date.now())
  }
}

export const syncEngine = new SyncEngine()
