// Thin client for the FaNotes Sync HTTP API (fanotes-site/sync-api.mjs).
// Everything that crosses this boundary is already encrypted by the caller;
// this module only knows about revisions, ids and sessions.
import type { ShareKeyWrap, SyncKdf, SyncKeyWrap } from './crypto'

export const SYNC_HOST = 'fanotes.fasrv.ch'
export const SYNC_ORIGIN = `https://${SYNC_HOST}`
export const SYNC_API_PATH = '/api/v1/sync'
const RETRY_DELAY_MS = 400

export type SyncSession = { accountId: string; deviceId: string; token: string; expiresAt: string; email: string; username?: string | null; credential?: SyncCredential }

export type SharePermission = 'read' | 'edit'
export type ShareStatus = 'pending' | 'accepted' | 'declined' | 'left'
type ShareBase = { id: string; kind: 'note' | 'folder'; permission: SharePermission; status: ShareStatus; nameEnc: { iv: string; data: string }; createdAt: string; updatedAt: string; rev: number }
export type UserShareIncoming = ShareBase & { role: 'recipient'; owner: { username: string; publicKey: string | null }; keyWrap: ShareKeyWrap }
export type UserShareOutgoing = ShareBase & { role: 'owner'; recipient: { username: string }; ownerKeyWrap: ShareKeyWrap }

export type SyncRemoteEntry = {
  id: string
  revision: number
  deleted: boolean
  size: number
  sha256: string | null
  meta: string | null
  updatedAt: string | null
  deviceId: string | null
}

export type SyncChangesPage = { revision: number; entries: SyncRemoteEntry[]; more: boolean; nextSince: number }

export type SyncDevice = { id: string; name: string; platform: string; createdAt: string; lastSeenAt: string; current: boolean }

/** How an account proves itself: a password, or a random key kept in the device's keychain. */
export type SyncCredential = 'password' | 'device-key'

/** The account's sharing key: the published public half and the private half wrapped by the vault secret. */
export type SyncUserKey = { publicKey: string; wrap: SyncKeyWrap }

export type SyncIdentity = { username: string | null; email: string | null; credential: SyncCredential; userKey: SyncUserKey | null }

export type SyncAccountInfo = {
  accountId: string
  email: string | null
  username: string | null
  credential: SyncCredential
  userKey: SyncUserKey | null
  createdAt: string
  revision: number
  usage: { files: number; bytes: number; quotaBytes: number; maxFiles: number; maxFileBytes: number }
  devices: SyncDevice[]
}

/** Why a 409 happened: the base is not the current revision, or the server refused an empty or collapsed body. */
export type SyncRejectReason = 'stale' | 'guard'

export class SyncApiError extends Error {
  constructor(public status: number, message: string, public entry: SyncRemoteEntry | null = null, public reason: SyncRejectReason | null = null, public retryAfterMs: number | null = null) {
    super(message)
    this.name = 'SyncApiError'
  }
  get unauthorized() { return this.status === 401 }
  get conflict() { return this.status === 409 }
  get offline() { return this.status === 0 }
  /** The server kept its copy because this body looked empty or collapsed. Sending it again cannot succeed. */
  get guarded() { return this.status === 409 && this.reason === 'guard' }
  /** The server's request budget for this account is used up for now (a large first sync). Not a failure: wait and go on. */
  get throttled() { return this.status === 429 }
}

/** The web build talks to its own origin (nginx proxies /api/v1/sync); the desktop renderer talks to the public host. */
export const resolveSyncOrigin = () => {
  const platform = typeof window !== 'undefined' ? window.fanotes?.platform : undefined
  if ((platform === 'web' || platform === 'browser-preview') && window.location?.origin?.startsWith('http')) return window.location.origin
  return SYNC_ORIGIN
}

const parseError = async (response: Response): Promise<SyncApiError> => {
  let message = `Der Sync-Server antwortete mit ${response.status}.`
  let entry: SyncRemoteEntry | null = null
  let reason: SyncRejectReason | null = response.headers.get('X-FaNotes-Rejected') === 'guard' ? 'guard' : null
  let retryAfterMs: number | null = null
  try {
    const body = await response.json() as { error?: unknown; entry?: SyncRemoteEntry; reason?: unknown; retryAfter?: unknown }
    if (typeof body.error === 'string') message = body.error
    if (typeof body.retryAfter === 'number' && Number.isFinite(body.retryAfter) && body.retryAfter > 0) retryAfterMs = body.retryAfter * 1000
    if (body.entry && typeof body.entry === 'object') entry = body.entry
    if (body.reason === 'guard' || body.reason === 'stale') reason = body.reason
  } catch { /* not JSON */ }
  return new SyncApiError(response.status, message, entry, reason, retryAfterMs)
}

export class SyncApi {
  /**
   * The origin is resolved per request, not at construction: the engine singleton is created while
   * modules load, before main.tsx has installed window.fanotes, so an eager lookup would always pick
   * the desktop default and the web build would end up cross-origin.
   */
  constructor(private readonly origin: string | null = null, private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  private url(path: string) { return `${this.origin ?? resolveSyncOrigin()}${SYNC_API_PATH}${path}` }

  private async request(path: string, init: RequestInit & { session?: SyncSession | null; retry?: boolean } = {}): Promise<Response> {
    const { session, retry, ...fetchInit } = init
    const headers = new Headers(fetchInit.headers)
    if (session) {
      headers.set('Authorization', `Bearer ${session.token}`)
      headers.set('X-FaNotes-Account', session.accountId)
    }
    // A request that fails before any response arrived (connection dropped, renderer cancelled it)
    // is repeated once when repeating cannot change server state: reads, and prelogin, which only
    // returns KDF parameters. Everything that creates or mutates stays single-shot so that a lost
    // response can never turn into a duplicate account, device or upload.
    const retryable = retry ?? (fetchInit.method ?? 'GET') === 'GET'
    for (let attempt = 0; ; attempt += 1) {
      let response: Response
      try {
        response = await this.fetchImpl(this.url(path), { ...fetchInit, headers, credentials: 'omit', cache: 'no-store' })
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError'
        if (retryable && !aborted && attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
          continue
        }
        throw new SyncApiError(0, aborted ? 'Die Anfrage wurde abgebrochen.' : 'Der Sync-Server ist nicht erreichbar.')
      }
      if (!response.ok) throw await parseError(response)
      return response
    }
  }

  private async json<T>(path: string, init: RequestInit & { session?: SyncSession | null; retry?: boolean } = {}): Promise<T> {
    const response = await this.request(path, init)
    if (response.status === 204) return undefined as T
    return await response.json() as T
  }

  private post(path: string, body: unknown, session?: SyncSession | null) {
    return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), session }
  }

  /** `who` is an e-mail address or a username, or the explicit object. */
  prelogin(who: string | { email?: string; username?: string }) {
    const body = typeof who === 'string' ? (who.includes('@') ? { email: who } : { username: who }) : who
    return this.json<{ kdf: SyncKdf }>('/prelogin', { ...this.post('/prelogin', body), retry: true })
  }

  register(body: { email?: string; username?: string; credential?: SyncCredential; publicKey?: string; userKeyWrap?: SyncKeyWrap; authKey: string; kdf: SyncKdf; vaultKeyWrap: SyncKeyWrap; device: { name: string; platform: string } }) {
    return this.json<{ accountId: string; deviceId: string; token: string; expiresAt: string; revision: number } & SyncIdentity>('/register', this.post('/register', body))
  }

  login(body: { email?: string; username?: string; authKey: string; device: { name: string; platform: string } }) {
    return this.json<{ accountId: string; deviceId: string; token: string; expiresAt: string; kdf: SyncKdf; vaultKeyWrap: SyncKeyWrap; revision: number } & SyncIdentity>('/login', this.post('/login', body))
  }

  setUsername(session: SyncSession, body: { username: string; publicKey: string; userKeyWrap: SyncKeyWrap }) {
    return this.json<SyncIdentity>('/username', this.post('/username', body, session))
  }

  setEmail(session: SyncSession, body: { email: string; authKey: string }) {
    return this.json<SyncIdentity>('/email', this.post('/email', body, session))
  }

  setUserKey(session: SyncSession, body: { publicKey: string; userKeyWrap: SyncKeyWrap }) {
    return this.json<SyncIdentity>('/userkey', this.post('/userkey', body, session))
  }

  // ── Shares between accounts ───────────────────────────────────────────

  lookupUser(session: SyncSession, username: string) {
    return this.json<{ username: string; publicKey: string }>('/users/lookup', this.post('/users/lookup', { username }, session))
  }

  listShares(session: SyncSession) {
    return this.json<{ incoming: UserShareIncoming[]; outgoing: UserShareOutgoing[]; blocked: Array<{ username: string }> }>('/shares', { session })
  }

  createShare(session: SyncSession, body: { recipient: string; kind: 'note' | 'folder'; permission: SharePermission; keyWrap: ShareKeyWrap; ownerKeyWrap: ShareKeyWrap; nameEnc: { iv: string; data: string } }) {
    return this.json<{ share: UserShareOutgoing }>('/shares', this.post('/shares', body, session))
  }

  respondShare(session: SyncSession, id: string, body: { accept: boolean; block?: boolean }) {
    return this.json<{ share: UserShareIncoming }>(`/shares/${id}/respond`, this.post(`/shares/${id}/respond`, body, session))
  }

  setSharePermission(session: SyncSession, id: string, permission: SharePermission) {
    return this.json<{ share: UserShareOutgoing }>(`/shares/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permission }), session })
  }

  /** Owner: revokes the share and deletes its ciphertext. Recipient: leaves or declines. */
  removeShare(session: SyncSession, id: string) {
    return this.json<{ ok: true }>(`/shares/${id}`, { method: 'DELETE', session })
  }

  blockUser(session: SyncSession, username: string) {
    return this.json<{ ok: true }>('/blocks', this.post('/blocks', { username }, session))
  }

  unblockUser(session: SyncSession, username: string) {
    return this.json<{ ok: true }>(`/blocks/${encodeURIComponent(username)}`, { method: 'DELETE', session })
  }

  shareChanges(session: SyncSession, id: string, since: number) {
    return this.json<{ rev: number; entries: Array<SyncRemoteEntry & { seq: number }> }>(`/shares/${id}/changes?since=${since}`, { session })
  }

  async shareDownload(session: SyncSession, id: string, fileId: string): Promise<{ revision: number; meta: string; sha256: string; blob: Uint8Array } | { revision: number; deleted: true }> {
    const response = await this.request(`/shares/${id}/files/${fileId}`, { session })
    const revision = Number(response.headers.get('X-FaNotes-Revision'))
    if (response.status === 204 || response.headers.get('X-FaNotes-Deleted') === '1') return { revision, deleted: true }
    return { revision, meta: response.headers.get('X-FaNotes-Meta') ?? '', sha256: response.headers.get('X-FaNotes-Sha256') ?? '', blob: new Uint8Array(await response.arrayBuffer()) }
  }

  async shareUpload(session: SyncSession, id: string, fileId: string, baseRevision: number, meta: string, sha256: string, blob: Uint8Array): Promise<number> {
    const result = await this.json<{ revision: number }>(`/shares/${id}/files/${fileId}`, {
      method: 'PUT',
      session,
      headers: { 'Content-Type': 'application/octet-stream', 'If-Match': String(baseRevision), 'X-FaNotes-Meta': meta, 'X-FaNotes-Sha256': sha256 },
      body: blob as BodyInit,
    })
    return result.revision
  }

  async shareRemoveFile(session: SyncSession, id: string, fileId: string, baseRevision: number): Promise<number> {
    const result = await this.json<{ revision: number }>(`/shares/${id}/files/${fileId}`, { method: 'DELETE', session, headers: { 'If-Match': String(baseRevision) } })
    return result.revision
  }

  /** Live co-editing: one end-to-end encrypted message (`d` is base64 ciphertext) for a shared note's channel. */
  liveSend(session: SyncSession, id: string, channel: string, body: { k: 'u' | 'p' | 'i' | 's'; d: string; upTo?: number }) {
    return this.json<{ ok: true; q?: number; seq?: number; stale?: boolean; delivered?: number }>(`/shares/${id}/live/${channel}`, this.post(`/shares/${id}/live/${channel}`, body, session))
  }

  /** Buffered live messages after `since` (and the compacted snapshot when the caller may have missed it). */
  liveFetch(session: SyncSession, id: string, channel: string, since: number) {
    return this.json<{ seq: number; snapshot: { q: number; d: string } | null; updates: Array<{ q: number; d: string }> }>(`/shares/${id}/live/${channel}?since=${since}`, { session })
  }

  /** Opens the Server-Sent Events stream the app keeps open while it runs. The caller reads `response.body`. */
  async openEvents(session: SyncSession, signal: AbortSignal): Promise<Response> {
    const response = await this.fetchImpl(this.url('/events'), {
      headers: { Authorization: `Bearer ${session.token}`, 'X-FaNotes-Account': session.accountId, Accept: 'text/event-stream' },
      credentials: 'omit',
      cache: 'no-store',
      signal,
    })
    if (!response.ok || !response.body) throw await parseError(response)
    return response
  }

  account(session: SyncSession) {
    return this.json<SyncAccountInfo>('/account', { session })
  }

  logout(session: SyncSession) {
    return this.json<void>('/logout', { method: 'POST', session })
  }

  removeDevice(session: SyncSession, deviceId: string) {
    return this.json<void>(`/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE', session })
  }

  changePassword(session: SyncSession, body: { authKey: string; newAuthKey: string; kdf: SyncKdf; vaultKeyWrap: SyncKeyWrap }) {
    return this.json<void>('/password', this.post('/password', body, session))
  }

  deleteAccount(session: SyncSession, authKey: string) {
    return this.json<void>('/account', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ authKey }), session })
  }

  changes(session: SyncSession, since: number) {
    return this.json<SyncChangesPage>(`/changes?since=${since}`, { session })
  }

  async download(session: SyncSession, fileId: string): Promise<{ revision: number; meta: string; sha256: string; blob: Uint8Array } | { revision: number; deleted: true }> {
    const response = await this.request(`/files/${fileId}`, { session })
    const revision = Number(response.headers.get('X-FaNotes-Revision'))
    if (response.status === 204 || response.headers.get('X-FaNotes-Deleted') === '1') return { revision, deleted: true }
    const meta = response.headers.get('X-FaNotes-Meta') ?? ''
    const sha256 = response.headers.get('X-FaNotes-Sha256') ?? ''
    return { revision, meta, sha256, blob: new Uint8Array(await response.arrayBuffer()) }
  }

  async upload(session: SyncSession, fileId: string, baseRevision: number, meta: string, sha256: string, blob: Uint8Array, flags?: { blank?: boolean; clear?: boolean }): Promise<number> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(blob.byteLength),
      'If-Match': String(baseRevision),
      'X-FaNotes-Meta': meta,
      'X-FaNotes-Sha256': sha256,
      'X-FaNotes-Blank': flags?.blank ? '1' : '0',
    }
    if (flags?.clear) headers['X-FaNotes-Clear'] = '1'
    const result = await this.json<{ revision: number }>(`/files/${fileId}`, {
      method: 'PUT',
      session,
      headers,
      body: blob as BodyInit,
    })
    return result.revision
  }

  async remove(session: SyncSession, fileId: string, baseRevision: number): Promise<number> {
    const result = await this.json<{ revision: number }>(`/files/${fileId}`, {
      method: 'DELETE',
      session,
      headers: { 'If-Match': String(baseRevision), 'X-FaNotes-Delete': '1' },
    })
    return result.revision
  }
}
