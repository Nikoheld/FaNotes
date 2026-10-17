import { resolveSyncOrigin, type SyncSession } from '../sync/api'

export const MCP_CONNECTOR_NAME = 'FaNotes'

export type McpGrantInfo = {
  id: string
  clientName: string
  redirectHost: string
  createdAt: string
  lastUsedAt: string | null
}

export const mcpServerUrl = () => `${resolveSyncOrigin()}/mcp`

export const newReaderKey = () => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

const parseError = async (response: Response) => {
  try {
    const body = await response.json() as { error?: unknown }
    if (typeof body.error === 'string') return body.error
  } catch { /* not JSON */ }
  return 'Der Grok-Connector hat die Anfrage abgelehnt.'
}

export const mcpReaderRequest = async (session: SyncSession, path: string, init: RequestInit & { readerKey?: string } = {}) => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${session.token}`)
  headers.set('X-FaNotes-Account', session.accountId)
  if (init.readerKey) headers.set('X-FaNotes-Reader', init.readerKey)
  const response = await fetch(`${resolveSyncOrigin()}/api/v1/mcp${path}`, {
    method: init.method,
    headers,
    body: init.body,
    credentials: 'omit',
    cache: 'no-store',
  })
  if (response.status === 204) return null
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : await parseError(response))
    ;(error as Error & { status?: number }).status = response.status
    throw error
  }
  return body
}
