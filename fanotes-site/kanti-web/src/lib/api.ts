// The one way the page talks to the server: same origin, the session cookie, JSON, and the
// session's CSRF token on every request that changes something.
import type { AlertSettings, Change, Connection, LinkStatus, Reveals, Session, Snapshot } from '../types'

export const API = '/api/v1/kanti-web'

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export interface Transport {
  (input: string, init: RequestInit): Promise<Response>
}

export const createApi = (transport: Transport = (input, init) => fetch(input, init)) => {
  let csrf = ''
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json'
      if (csrf) headers['X-Kanti-CSRF'] = csrf
    }
    let response: Response
    try {
      response = await transport(`${API}${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      })
    } catch {
      throw new ApiError(0, 'offline')
    }
    const text = await response.text()
    let value: unknown = null
    try { value = text ? JSON.parse(text) : null } catch { value = null }
    if (!response.ok) {
      const message = value && typeof value === 'object' && 'error' in value ? String((value as { error: unknown }).error) : `HTTP ${response.status}`
      throw new ApiError(response.status, message)
    }
    return value as T
  }
  const connection = (id: string) => `/connections/${encodeURIComponent(id)}`
  return {
    setCsrf(value: string) { csrf = value },
    /** The session, or null when this browser is not signed in. */
    session: async (): Promise<Session | null> => {
      const answer = await call<Session & { signedIn: boolean }>('GET', '/session')
      if (!answer?.signedIn) {
        csrf = ''
        return null
      }
      csrf = answer.csrf
      return answer
    },
    /** Today's Mensa menu; public, same body as the app gets. */
    mensa: () => call<unknown>('GET', '/mensa'),
    logout: () => call<{ signedOut: boolean }>('POST', '/logout'),
    prelogin: (email: string) => call<{ kdf: { algorithm: string; iterations: number; salt: string } }>('POST', '/prelogin', { email }),
    login: (email: string, authKey: string) => call<{ ok: boolean }>('POST', '/login', { email, authKey }),
    startPairing: () => call<{ code: string; expiresAt: string }>('POST', '/pair'),
    pairingStatus: () => call<{ status: 'waiting' | 'approved' | 'expired'; added?: number; expiresAt?: string; browser?: string }>('GET', '/pair'),
    cancelPairing: () => call<{ status: string }>('DELETE', '/pair'),
    /** A code the Kanti+ app showed (the other direction). */
    claimPairing: (code: string) => call<{ status: 'approved'; added: number }>('POST', '/pair/claim', { code }),
    snapshot: (id: string) => call<Snapshot>('GET', `${connection(id)}/snapshot`),
    status: (id: string) => call<LinkStatus>('GET', `${connection(id)}/status`),
    saveSettings: (id: string, settings: Partial<AlertSettings>) => call<LinkStatus>('PUT', `${connection(id)}/settings`, settings),
    changes: (id: string, since: number) => call<{ changes: Change[] }>('GET', `${connection(id)}/changes?since=${Math.max(0, Math.floor(since))}`),
    reveals: (id: string) => call<Reveals>('GET', `${connection(id)}/reveals`),
    reveal: (id: string, ids: string[]) => call<Reveals>('POST', `${connection(id)}/reveal`, { ids }),
    rename: (id: string, label: string) => call<Connection>('PATCH', connection(id), { label }),
    remove: (id: string) => call<{ removed: boolean; signedOut: boolean }>('DELETE', connection(id)),
  }
}

export type Api = ReturnType<typeof createApi>
