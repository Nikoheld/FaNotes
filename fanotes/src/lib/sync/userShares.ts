// Shares between FaNotes users. A note or a folder is shared with another
// account by username, end-to-end encrypted (see crypto.ts "Sharing keys" and
// fanotes-site/user-shares.mjs). This manager:
//   - keeps a push channel (Server-Sent Events) open while the app runs, so a
//     share, an acceptance, a change or a revocation shows up at once;
//   - turns accepted incoming shares into files under "Mit mir geteilt/<person>/<name>";
//   - pushes the owner's files (and the recipient's edits when the share
//     allows editing) and pulls the other side's changes;
//   - removes the local copy the moment a share is revoked.
// It is independent of vault cloud sync: it works with that switched off. The
// per-share change feed and the event stream are the base a later live
// collaboration can build on.
import type { SyncHostApi, SyncScanEntry } from '../../types'
import { SyncApi, SyncApiError, type SharePermission, type ShareStatus, type SyncSession, type UserShareIncoming, type UserShareOutgoing } from './api'
import {
  decryptBytes, decryptMeta, decryptShareTitle, deriveShareKeys, encryptBytes, encryptMeta, encryptShareTitle, fileIdFor, keyFingerprint, newShareKey, sha256Hex, unwrapShareKey, wrapShareKey,
  type ShareTitle, type SyncKeys,
} from './crypto'
import { isSyncablePath, type SyncEngine } from './engine'
import { SHARED_INBOX_FOLDER } from './sharedInbox'

export type UserShareView = {
  id: string
  role: 'owner' | 'recipient'
  kind: 'note' | 'folder'
  permission: SharePermission
  status: ShareStatus
  /** Decrypted title; empty when this device could not open the share key. */
  name: string
  /** The other person's username. */
  peer: string
  /** Recipient only: where the share lives in the vault once accepted. */
  localRoot: string | null
  /** Owner only: the shared path in the vault. */
  sourcePath: string | null
  createdAt: string
  problem: string | null
}

export type UserSharesState = {
  /** False while the account has no username: nobody can share with it yet. */
  ready: boolean
  /** The push channel is open. */
  live: boolean
  shares: UserShareView[]
  blocked: string[]
  /** Incoming shares that wait for the user to accept or decline. */
  pending: UserShareView[]
  error: string | null
}

type FileBase = { rel: string; revision: number; sha256: string; size: number; mtimeMs: number }
type ShareLocal = { cursor: number; files: Record<string, FileBase>; localRoot?: string }
type PersistedShares = { v: 1; accountId: string; shares: Record<string, ShareLocal> }

export type UserShareHooks = {
  onApplied?: (change: { written: string[]; removed: string[] }) => void
  isPathBusy?: (path: string) => boolean
  /** A share from somebody arrived and waits for a decision (or was accepted automatically). */
  onIncoming?: (share: UserShareView) => void
  /** A share this device had was revoked or left. */
  onGone?: (share: UserShareView, why: 'revoked' | 'left') => void
  now?: () => number
}

const LOCAL_DEBOUNCE_MS = 1_500
const SAFETY_REFRESH_MS = 90_000
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const MAX_FILE_BYTES = 50 * 1024 * 1024

const emptyState = (): UserSharesState => ({ ready: false, live: false, shares: [], blocked: [], pending: [], error: null })

const safeSegment = (raw: string, fallback: string) => {
  const cleaned = raw.replace(/[\u0000-\u001f\\/:*?"<>|]/gu, ' ').replace(/\s+/gu, ' ').trim().replace(/^\.+/u, '').replace(/[. ]+$/u, '').slice(0, 80)
  return cleaned || fallback
}

const relIsSafe = (rel: string) => Boolean(rel) && rel.length <= 512 && !rel.includes('\0') && !rel.includes('\\') && isSyncablePath(rel)

const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const stripNoteExtension = (name: string) => name.replace(/\.(md|markdown|famd|pdf)$/iu, '')

/** `Mathe.md` and `Mathe.famd` (ink companion) and `Mathe.pdf` belong to one note. */
const noteFamily = (notePath: string) => {
  const stem = stripNoteExtension(notePath)
  return new Set([notePath, `${stem}.md`, `${stem}.famd`, `${stem}.pdf`])
}

type Opened = { view: UserShareView; keys: SyncKeys; title: ShareTitle | null; raw: UserShareIncoming | UserShareOutgoing }

export class UserShareManager {
  private host: SyncHostApi | null = null
  private hooks: UserShareHooks = {}
  private session: SyncSession | null = null
  private identity: { username: string; publicKey: string; privateKey: CryptoKey } | null = null
  private snapshot = emptyState()
  private listeners = new Set<() => void>()
  private persisted: PersistedShares | null = null
  private stateId: string | null = null
  private opened = new Map<string, Opened>()
  private unsubscribe: (() => void) | null = null
  private unsubscribeLocal: (() => void) | null = null
  private abort: AbortController | null = null
  private reconnect = RECONNECT_MIN_MS
  private reconnectTimer: number | null = null
  private safetyTimer: number | null = null
  private localTimer: number | null = null
  private refreshing: Promise<void> | null = null
  private refreshAgain = false
  private readonly queues = new Map<string, Promise<void>>()
  private knownIncoming = new Set<string>()
  /** Shares this user just left or declined themselves: no "was revoked" notice for those. */
  private readonly selfInitiated = new Set<string>()
  private firstRefresh = true
  private generation = 0
  private disposed = false

  constructor(private readonly engine: SyncEngine, private readonly api: SyncApi = new SyncApi()) {}

  // ── External store ──────────────────────────────────────────────────────

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getState = () => this.snapshot

  private set(patch: Partial<UserSharesState>) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.snapshot.pending = this.snapshot.shares.filter((share) => share.role === 'recipient' && share.status === 'pending')
    for (const listener of [...this.listeners]) {
      try { listener() } catch (error) { console.error('[shares] listener failed', error) }
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  attach(host: SyncHostApi, hooks: UserShareHooks) {
    this.host = host
    this.hooks = hooks
  }

  /** Follows the sync engine's sign-in state: opens the channel on sign-in, closes it on sign-out. */
  start() {
    if (this.unsubscribe) return
    this.disposed = false
    let signedInAs = ''
    const follow = () => {
      const account = this.engine.getState().account
      const key = account ? `${account.accountId}:${account.username ?? ''}` : ''
      if (key === signedInAs) return
      signedInAs = key
      if (account) void this.begin()
      else void this.end()
    }
    this.unsubscribe = this.engine.subscribe(follow)
    this.unsubscribeLocal = this.engine.onLocalChange(() => this.notifyLocalChange())
    follow()
  }

  dispose() {
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribeLocal?.()
    this.unsubscribe = null
    this.unsubscribeLocal = null
    void this.end()
  }

  /** The vault changed: shares are looked up again for the new vault. */
  async switchVault() {
    if (!this.session) return
    await this.end(false)
    await this.begin()
  }

  private async begin() {
    if (!this.host || this.disposed) return
    const generation = ++this.generation
    await this.end(false)
    this.generation = generation
    const session = this.engine.getSession()
    if (!session) return
    try {
      const identity = await this.engine.sharingIdentity()
      if (generation !== this.generation) return
      this.session = session
      this.identity = identity
      if (!identity) {
        this.set({ ready: false, shares: [], blocked: [], error: null })
        return
      }
      const vaultId = await this.host.vaultId()
      this.stateId = await sha256Hex(new TextEncoder().encode(`shares:${vaultId}`))
      this.persisted = await this.loadPersisted(session.accountId)
      this.firstRefresh = true
      this.set({ ready: true, error: null })
      await this.refresh()
      this.connect()
      this.armSafetyTimer()
    } catch (error) {
      if (generation === this.generation) this.set({ error: error instanceof Error ? error.message : 'Freigaben konnten nicht gestartet werden.' })
    }
  }

  private async end(clear = true) {
    this.generation += clear ? 1 : 0
    this.abort?.abort()
    this.abort = null
    for (const timer of [this.reconnectTimer, this.safetyTimer, this.localTimer]) if (timer !== null) window.clearTimeout(timer)
    this.reconnectTimer = null
    this.safetyTimer = null
    this.localTimer = null
    this.session = null
    this.identity = null
    this.opened.clear()
    this.knownIncoming.clear()
    this.set({ live: false, ...(clear ? { ...emptyState() } : {}) })
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  private async loadPersisted(accountId: string): Promise<PersistedShares> {
    try {
      const raw = this.host && this.stateId ? await this.host.readState(this.stateId) : null
      const parsed = raw ? JSON.parse(raw) as Partial<PersistedShares> : null
      if (parsed?.v === 1 && parsed.accountId === accountId && parsed.shares && typeof parsed.shares === 'object') return { v: 1, accountId, shares: parsed.shares }
    } catch { /* start fresh */ }
    return { v: 1, accountId, shares: {} }
  }

  private async save() {
    if (!this.host || !this.stateId || !this.persisted) return
    await this.host.writeState(this.stateId, JSON.stringify(this.persisted))
  }

  private localFor(id: string): ShareLocal {
    this.persisted ??= { v: 1, accountId: this.session?.accountId ?? '', shares: {} }
    return (this.persisted.shares[id] ??= { cursor: 0, files: {} })
  }

  // ── Push channel ────────────────────────────────────────────────────────

  private connect() {
    if (this.disposed || !this.session) return
    const generation = this.generation
    const controller = new AbortController()
    this.abort = controller
    void (async () => {
      try {
        const response = await this.api.openEvents(this.session!, controller.signal)
        if (generation !== this.generation) return
        this.reconnect = RECONNECT_MIN_MS
        this.set({ live: true })
        // Anything that happened while the channel was down is picked up now.
        void this.refresh()
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let index = buffer.indexOf('\n\n')
          while (index >= 0) {
            this.handleEvent(buffer.slice(0, index))
            buffer = buffer.slice(index + 2)
            index = buffer.indexOf('\n\n')
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof SyncApiError && error.unauthorized) return
      }
      if (generation !== this.generation || controller.signal.aborted) return
      this.set({ live: false })
      this.reconnectTimer = window.setTimeout(() => { this.reconnectTimer = null; this.connect() }, this.reconnect)
      this.reconnect = Math.min(RECONNECT_MAX_MS, this.reconnect * 2)
    })()
  }

  private handleEvent(block: string) {
    const type = /^event: (.*)$/mu.exec(block)?.[1]
    const dataText = /^data: (.*)$/mu.exec(block)?.[1]
    let data: { id?: string } | null = null
    try { data = dataText ? JSON.parse(dataText) as { id?: string } : null } catch { data = null }
    if (type === 'shares') void this.refresh()
    else if (type === 'files' && data?.id) void this.syncShare(data.id)
  }

  private armSafetyTimer() {
    if (this.safetyTimer !== null) window.clearTimeout(this.safetyTimer)
    this.safetyTimer = window.setTimeout(() => {
      this.safetyTimer = null
      if (!this.session) return
      // With the channel open nothing needs polling. Without it, this keeps shares from going stale.
      if (!this.snapshot.live) void this.refresh()
      this.armSafetyTimer()
    }, SAFETY_REFRESH_MS)
  }

  /** The app saved something: shares whose files changed here are pushed. */
  notifyLocalChange() {
    if (!this.session || this.localTimer !== null) return
    this.localTimer = window.setTimeout(() => {
      this.localTimer = null
      for (const entry of this.opened.values()) {
        if (this.canPush(entry.view)) void this.syncShare(entry.view.id)
      }
    }, LOCAL_DEBOUNCE_MS)
  }

  // ── Refresh ─────────────────────────────────────────────────────────────

  refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true
      return this.refreshing
    }
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null
      if (this.refreshAgain) {
        this.refreshAgain = false
        void this.refresh()
      }
    })
    return this.refreshing
  }

  private async open(raw: UserShareIncoming | UserShareOutgoing): Promise<Opened> {
    const identity = this.identity!
    const cached = this.opened.get(raw.id)
    if (cached) return { ...cached, raw, view: { ...cached.view, permission: raw.permission, status: raw.status } }
    const owner = raw.role === 'owner'
    const base: UserShareView = {
      id: raw.id,
      role: raw.role,
      kind: raw.kind,
      permission: raw.permission,
      status: raw.status,
      name: '',
      peer: owner ? (raw as UserShareOutgoing).recipient.username : (raw as UserShareIncoming).owner.username,
      localRoot: null,
      sourcePath: null,
      createdAt: raw.createdAt,
      problem: null,
    }
    try {
      const shareKey = await unwrapShareKey(owner ? (raw as UserShareOutgoing).ownerKeyWrap : (raw as UserShareIncoming).keyWrap, identity.privateKey)
      const keys = await deriveShareKeys(shareKey)
      shareKey.fill(0)
      const title = await decryptShareTitle(keys, raw.nameEnc)
      return { view: { ...base, name: title.name, sourcePath: owner ? title.rootPath : null }, keys, title, raw }
    } catch (error) {
      return { view: { ...base, problem: error instanceof Error ? error.message : 'Diese Freigabe konnte nicht geöffnet werden.' }, keys: null as unknown as SyncKeys, title: null, raw }
    }
  }

  private async doRefresh() {
    const session = this.session
    if (!session || !this.identity) return
    const generation = this.generation
    try {
      const listing = await this.api.listShares(session)
      if (generation !== this.generation) return
      const next = new Map<string, Opened>()
      for (const raw of [...listing.outgoing, ...listing.incoming]) {
        const opened = await this.open(raw)
        if (opened.view.role === 'recipient' && opened.view.status === 'accepted') {
          const local = this.localFor(opened.view.id)
          local.localRoot ??= this.chooseLocalRoot(opened)
          opened.view.localRoot = local.localRoot
        } else if (opened.view.role === 'recipient') {
          opened.view.localRoot = this.persisted?.shares[opened.view.id]?.localRoot ?? null
        }
        next.set(raw.id, opened)
      }
      const previous = this.opened
      this.opened = next
      const views = [...next.values()].map((entry) => entry.view)
      this.set({ shares: views, blocked: listing.blocked.map((entry) => entry.username), error: null })

      // Shares that disappeared or ended: drop the local copy now.
      const removedFiles: string[] = []
      for (const [id, entry] of previous) {
        const current = next.get(id)
        const ended = !current || (entry.view.role === 'recipient' && current.view.status !== 'accepted' && entry.view.status === 'accepted')
        if (!ended || entry.view.role !== 'recipient') continue
        removedFiles.push(...await this.dropLocalCopy(id))
        if (entry.view.status === 'accepted' && !this.selfInitiated.delete(id)) this.hooks.onGone?.(entry.view, current ? 'left' : 'revoked')
      }
      if (this.persisted) {
        for (const id of Object.keys(this.persisted.shares)) if (!next.has(id)) delete this.persisted.shares[id]
        await this.save()
      }
      if (removedFiles.length) this.hooks.onApplied?.({ written: [], removed: removedFiles })

      // New incoming shares: tell the user. The very first listing after start-up does not count as news.
      for (const entry of next.values()) {
        const view = entry.view
        if (view.role !== 'recipient' || this.knownIncoming.has(view.id)) continue
        this.knownIncoming.add(view.id)
        if (!this.firstRefresh) this.hooks.onIncoming?.(view)
      }
      this.firstRefresh = false

      for (const entry of next.values()) {
        const view = entry.view
        if (view.problem) continue
        if (view.role === 'owner' && (view.status === 'accepted' || view.status === 'pending')) void this.syncShare(view.id)
        if (view.role === 'recipient' && view.status === 'accepted') void this.syncShare(view.id)
      }
    } catch (error) {
      if (error instanceof SyncApiError && error.unauthorized) return
      if (generation === this.generation) this.set({ error: error instanceof Error ? error.message : 'Freigaben konnten nicht geladen werden.' })
    }
  }

  private chooseLocalRoot(entry: Opened) {
    const owner = safeSegment(entry.view.peer, 'Benutzer')
    const wanted = safeSegment(entry.view.kind === 'note' ? stripNoteExtension(entry.view.name) : entry.view.name, 'Freigabe')
    const taken = new Set(Object.entries(this.persisted?.shares ?? {}).filter(([id]) => id !== entry.view.id).map(([, local]) => local.localRoot))
    let candidate = `${SHARED_INBOX_FOLDER}/${owner}/${wanted}`
    for (let index = 2; taken.has(candidate); index += 1) candidate = `${SHARED_INBOX_FOLDER}/${owner}/${wanted} (${index})`
    return candidate
  }

  private async dropLocalCopy(id: string): Promise<string[]> {
    const local = this.persisted?.shares[id]
    const removed: string[] = []
    if (!local || !this.host || !local.localRoot) return removed
    for (const base of Object.values(local.files)) {
      const path = `${local.localRoot}/${base.rel}`
      try {
        await this.host.remove(path)
        removed.push(path)
      } catch { /* already gone */ }
    }
    return removed
  }

  // ── Per-share sync ──────────────────────────────────────────────────────

  private canPush(view: UserShareView) {
    if (view.problem) return false
    if (view.role === 'owner') return view.status === 'accepted' || view.status === 'pending'
    return view.status === 'accepted' && view.permission === 'edit'
  }

  /** One sync of one share at a time: pull what changed, then push local changes. */
  syncShare(id: string): Promise<void> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const run = previous.then(() => this.runShare(id), () => this.runShare(id))
    const settled = run.catch(() => undefined)
    this.queues.set(id, settled)
    void settled.then(() => { if (this.queues.get(id) === settled) this.queues.delete(id) })
    return run.catch(() => undefined)
  }

  private rootFor(entry: Opened): { dir: string; family: Set<string> | null } | null {
    if (entry.view.role === 'recipient') {
      const local = this.persisted?.shares[entry.view.id]
      return local?.localRoot ? { dir: local.localRoot, family: null } : null
    }
    const source = entry.view.sourcePath
    if (!source) return null
    return entry.view.kind === 'folder' ? { dir: source, family: null } : { dir: dirname(source), family: noteFamily(source) }
  }

  private listLocal(entry: Opened, scan: SyncScanEntry[]): Map<string, SyncScanEntry> {
    const root = this.rootFor(entry)
    const found = new Map<string, SyncScanEntry>()
    if (!root) return found
    const prefix = root.dir ? `${root.dir}/` : ''
    for (const file of scan) {
      if (prefix && !file.path.startsWith(prefix)) continue
      if (root.family && !root.family.has(file.path)) continue
      const rel = file.path.slice(prefix.length)
      if (!relIsSafe(rel) || file.size > MAX_FILE_BYTES) continue
      if (root.family && rel.includes('/')) continue
      found.set(rel, file)
    }
    return found
  }

  private async runShare(id: string) {
    const session = this.session
    const entry = this.opened.get(id)
    if (!session || !entry || !this.host || entry.view.problem) return
    if (entry.view.role === 'recipient' && entry.view.status !== 'accepted') return
    const root = this.rootFor(entry)
    if (!root) return
    const generation = this.generation
    try {
      const written: string[] = []
      const removed: string[] = []
      await this.pull(session, entry, root.dir, written, removed)
      if (generation !== this.generation) return
      if (this.canPush(entry.view)) {
        const conflicted = await this.push(session, entry, root.dir)
        if (conflicted) await this.pull(session, entry, root.dir, written, removed)
      }
      await this.save()
      if (written.length || removed.length) this.hooks.onApplied?.({ written, removed })
      if (entry.view.problem) this.patchView(id, { problem: null })
    } catch (error) {
      if (error instanceof SyncApiError && (error.status === 404 || error.status === 403)) {
        // Revoked or no longer allowed: the next listing settles it.
        void this.refresh()
        return
      }
      if (error instanceof SyncApiError && error.unauthorized) return
      this.patchView(id, { problem: error instanceof Error ? error.message : 'Diese Freigabe konnte nicht abgeglichen werden.' })
    }
  }

  private patchView(id: string, patch: Partial<UserShareView>) {
    const entry = this.opened.get(id)
    if (!entry) return
    entry.view = { ...entry.view, ...patch }
    this.set({ shares: this.snapshot.shares.map((view) => (view.id === id ? entry.view : view)) })
  }

  private async pull(session: SyncSession, entry: Opened, dir: string, written: string[], removed: string[]) {
    const host = this.host!
    const local = this.localFor(entry.view.id)
    const page = await this.api.shareChanges(session, entry.view.id, local.cursor)
    if (!page.entries.length) {
      local.cursor = Math.max(local.cursor, page.rev)
      return
    }
    const scan = await host.scan()
    const byPath = new Map(scan.map((file) => [file.path, file]))
    let deferred = false
    for (const remote of page.entries) {
      const base = local.files[remote.id]
      if (base && base.revision >= remote.revision) continue
      if (remote.deleted) {
        if (base) {
          const path = this.pathFor(dir, base.rel)
          const current = byPath.get(path)
          // A local edit that the owner's delete never saw is kept as a plain local file.
          if (current && (current.size !== base.size || current.mtimeMs !== base.mtimeMs) && await this.hashOf(path) !== base.sha256) {
            delete local.files[remote.id]
            continue
          }
          if (this.hooks.isPathBusy?.(path)) { deferred = true; continue }
          if (current) {
            await host.remove(path)
            removed.push(path)
          }
          delete local.files[remote.id]
        }
        continue
      }
      const download = await this.api.shareDownload(session, entry.view.id, remote.id)
      if ('deleted' in download) continue
      const meta = await decryptMeta(entry.keys, remote.id, download.meta)
      if (!relIsSafe(meta.path) || (await fileIdFor(entry.keys, meta.path)) !== remote.id) continue
      const plain = await decryptBytes(entry.keys, remote.id, download.blob)
      if (await sha256Hex(plain) !== meta.sha256) throw new Error('Eine geteilte Datei ist beschädigt angekommen.')
      const path = this.pathFor(dir, meta.path)
      if (this.hooks.isPathBusy?.(path)) { deferred = true; continue }
      const existing = byPath.get(path)
      if (existing) {
        const unchanged = base && existing.size === base.size && existing.mtimeMs === base.mtimeMs
        const currentHash = unchanged ? base!.sha256 : await this.hashOf(path)
        if (currentHash === meta.sha256) {
          local.files[remote.id] = { rel: meta.path, revision: download.revision, sha256: meta.sha256, size: existing.size, mtimeMs: existing.mtimeMs }
          continue
        }
        if (!base || currentHash !== base.sha256) {
          // Both sides changed it: the shared version takes the path, the local one is kept next to it.
          const copy = this.conflictPath(path, byPath)
          await host.write(copy, await host.read(path), existing.mtimeMs)
          written.push(copy)
        }
      }
      const result = await host.write(path, plain, meta.mtimeMs || (this.hooks.now?.() ?? Date.now()))
      byPath.set(path, result)
      written.push(path)
      local.files[remote.id] = { rel: meta.path, revision: download.revision, sha256: meta.sha256, size: result.size, mtimeMs: result.mtimeMs }
    }
    if (!deferred) local.cursor = Math.max(local.cursor, page.rev)
  }

  private pathFor(dir: string, rel: string) {
    return dir ? `${dir}/${rel}` : rel
  }

  private conflictPath(path: string, existing: Map<string, SyncScanEntry>) {
    const dot = path.lastIndexOf('.')
    const hasExtension = dot > path.lastIndexOf('/') + 1
    const stem = hasExtension ? path.slice(0, dot) : path
    const extension = hasExtension ? path.slice(dot) : ''
    const stamp = new Date(this.hooks.now?.() ?? Date.now()).toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')
    let candidate = `${stem} (Konflikt ${stamp})${extension}`
    for (let index = 2; existing.has(candidate); index += 1) candidate = `${stem} (Konflikt ${stamp} ${index})${extension}`
    return candidate
  }

  private async hashOf(path: string) {
    return sha256Hex(await this.host!.read(path))
  }

  /** Returns true when the server held a newer version of something that was uploaded (a pull should follow). */
  private async push(session: SyncSession, entry: Opened, dir: string): Promise<boolean> {
    const host = this.host!
    const local = this.localFor(entry.view.id)
    const files = this.listLocal(entry, await host.scan())
    let conflicted = false
    for (const [rel, file] of files) {
      const fileId = await fileIdFor(entry.keys, rel)
      const base = local.files[fileId]
      if (base && base.size === file.size && base.mtimeMs === file.mtimeMs) continue
      const path = this.pathFor(dir, rel)
      if (this.hooks.isPathBusy?.(path)) continue
      const bytes = await host.read(path)
      const sha = await sha256Hex(bytes)
      if (base && base.sha256 === sha) {
        local.files[fileId] = { ...base, size: file.size, mtimeMs: file.mtimeMs }
        continue
      }
      const blob = await encryptBytes(entry.keys, fileId, bytes)
      const meta = await encryptMeta(entry.keys, fileId, { path: rel, mtimeMs: file.mtimeMs, size: bytes.length, sha256: sha })
      try {
        const revision = await this.api.shareUpload(session, entry.view.id, fileId, base?.revision ?? 0, meta, sha, blob)
        local.files[fileId] = { rel, revision, sha256: sha, size: file.size, mtimeMs: file.mtimeMs }
      } catch (error) {
        if (error instanceof SyncApiError && error.conflict) { conflicted = true; continue }
        throw error
      }
    }
    // A file that was synced and is now gone locally becomes a delete. If the whole folder vanished (moved, or a drive
    // that is not mounted), nothing is deleted: that is not an intent to remove the shared content.
    const known = Object.entries(local.files)
    const missing = known.filter(([, base]) => !files.has(base.rel))
    if (missing.length && (files.size > 0 || known.length === 1)) {
      for (const [fileId, base] of missing) {
        try {
          await this.api.shareRemoveFile(session, entry.view.id, fileId, base.revision)
          delete local.files[fileId]
        } catch (error) {
          if (error instanceof SyncApiError && error.conflict) { conflicted = true; continue }
          if (error instanceof SyncApiError && error.status === 404) { delete local.files[fileId]; continue }
          throw error
        }
      }
    }
    return conflicted
  }

  // ── User actions ────────────────────────────────────────────────────────

  /** An exact username lookup. Rejects when there is no such account. The fingerprint lets two people compare keys out of band. */
  async lookup(username: string): Promise<{ username: string; publicKey: string; fingerprint: string }> {
    const session = this.requireSession()
    const found = await this.api.lookupUser(session, username.trim())
    return { ...found, fingerprint: await keyFingerprint(found.publicKey) }
  }

  /** Shares a vault note or folder with a user. The files go up right away and appear on the other side at once. */
  async share(options: { path: string; kind: 'note' | 'folder'; username: string; permission: SharePermission }) {
    const session = this.requireSession()
    const identity = this.identity
    if (!identity) throw new Error('Wähle zuerst einen Benutzernamen, damit andere dir etwas teilen können und du teilen kannst.')
    const recipient = await this.api.lookupUser(session, options.username.trim())
    const shareKey = newShareKey()
    const keys = await deriveShareKeys(shareKey)
    const name = options.kind === 'note' ? stripNoteExtension(basename(options.path)) : basename(options.path)
    const created = await this.api.createShare(session, {
      recipient: recipient.username,
      kind: options.kind,
      permission: options.permission,
      keyWrap: await wrapShareKey(shareKey, recipient.publicKey),
      ownerKeyWrap: await wrapShareKey(shareKey, identity.publicKey),
      nameEnc: await encryptShareTitle(keys, { name, kind: options.kind, rootPath: options.path }),
    })
    shareKey.fill(0)
    await this.refresh()
    await this.syncShare(created.share.id)
    return created.share.id
  }

  async respond(id: string, accept: boolean, block = false) {
    if (!accept) this.selfInitiated.add(id)
    await this.api.respondShare(this.requireSession(), id, { accept, block })
    await this.refresh()
  }

  async setPermission(id: string, permission: SharePermission) {
    await this.api.setSharePermission(this.requireSession(), id, permission)
    await this.refresh()
  }

  /** Owner: revokes at once. Recipient: leaves the share. */
  async remove(id: string) {
    this.selfInitiated.add(id)
    await this.api.removeShare(this.requireSession(), id)
    await this.refresh()
  }

  async block(username: string) {
    await this.api.blockUser(this.requireSession(), username)
    await this.refresh()
  }

  async unblock(username: string) {
    await this.api.unblockUser(this.requireSession(), username)
    await this.refresh()
  }

  /** The shares of one vault path, for the share dialog. */
  sharesOf(path: string) {
    return this.snapshot.shares.filter((share) => share.role === 'owner' && share.sourcePath === path)
  }

  private requireSession() {
    if (!this.session) throw new Error('Du bist nicht angemeldet.')
    return this.session
  }
}

/** The app-wide instance: follows the sync engine's account and keeps the push channel open. */
import { syncEngine } from './engine'
export const userShares = new UserShareManager(syncEngine)
