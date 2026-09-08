// Thin client for the FaNotes Sync HTTP API (fanotes-site/sync-api.mjs).
// Everything that crosses this boundary is already encrypted by the caller;
// this module only knows about revisions, ids and sessions.
import type { SyncKdf, SyncKeyWrap } from './crypto'

export const SYNC_HOST = 'fanotes.fasrv.ch'
export const SYNC_ORIGIN = `https://${SYNC_HOST}`
export const SYNC_API_PATH = '/api/v1/sync'
const RETRY_DELAY_MS = 400

export type SyncSession = { accountId: string; deviceId: string; token: string; expiresAt: string; email: string }

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

export type SyncAccountInfo = {
  accountId: string
  email: string
  createdAt: string
  revision: number
  usage: { files: number; bytes: number; quotaBytes: number; maxFiles: number; maxFileBytes: number }
  devices: SyncDevice[]
}

export class SyncApiError extends Error {
  constructor(public status: number, message: string, public entry: SyncRemoteEntry | null = null) {
    super(message)
    this.name = 'SyncApiError'
  }
  get unauthorized() { return this.status === 401 }
  get conflict() { return this.status === 409 }
  get offline() { return this.status === 0 }
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
  try {
    const body = await response.json() as { error?: unknown; entry?: SyncRemoteEntry }
    if (typeof body.error === 'string') message = body.error
    if (body.entry && typeof body.entry === 'object') entry = body.entry
  } catch { /* not JSON */ }
  return new SyncApiError(response.status, message, entry)
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

  prelogin(email: string) {
    return this.json<{ kdf: SyncKdf }>('/prelogin', { ...this.post('/prelogin', { email }), retry: true })
  }

  register(body: { email: string; authKey: string; kdf: SyncKdf; vaultKeyWrap: SyncKeyWrap; device: { name: string; platform: string } }) {
    return this.json<{ accountId: string; deviceId: string; token: string; expiresAt: string; revision: number }>('/register', this.post('/register', body))
  }

  login(body: { email: string; authKey: string; device: { name: string; platform: string } }) {
    return this.json<{ accountId: string; deviceId: string; token: string; expiresAt: string; kdf: SyncKdf; vaultKeyWrap: SyncKeyWrap; revision: number }>('/login', this.post('/login', body))
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

  async upload(session: SyncSession, fileId: string, baseRevision: number, meta: string, sha256: string, blob: Uint8Array): Promise<number> {
    const result = await this.json<{ revision: number }>(`/files/${fileId}`, {
      method: 'PUT',
      session,
      headers: { 'Content-Type': 'application/octet-stream', 'If-Match': String(baseRevision), 'X-FaNotes-Meta': meta, 'X-FaNotes-Sha256': sha256 },
      body: blob as BodyInit,
    })
    return result.revision
  }

  async remove(session: SyncSession, fileId: string, baseRevision: number): Promise<number> {
    const result = await this.json<{ revision: number }>(`/files/${fileId}`, { method: 'DELETE', session, headers: { 'If-Match': String(baseRevision) } })
    return result.revision
  }
}
