// Public note and folder links. This is not vault sync: encrypted device sync
// stays on /api/v1/sync. A share uploads readable title and markdown only.

export const SHARE_HOST = 'fanotes.fasrv.ch'
export const SHARE_ORIGIN = `https://${SHARE_HOST}`
export const SHARE_API_PATH = '/api/v1/share'
export const SHARE_VIEW_PATH = '/share/'

export type ShareMode = 'copy' | 'live'

export type ShareEntry = {
  path: string
  kind: 'file' | 'folder'
  content?: string
}

export type ShareVaultNode = {
  relativePath: string
  kind: 'file' | 'folder'
  extension?: string
  children?: ShareVaultNode[]
}

export type ShareNote = {
  path: string
  title: string
  content: string
}

export type SharePayload = {
  schemaVersion: 1
  id: string
  mode: ShareMode
  kind: 'note' | 'folder'
  rootPath: string
  title: string
  notes: ShareNote[]
  updatedAt: string
  stopped?: boolean
}

export type ShareLinkRecord = {
  id: string
  link: string
  title: string
  rootPath: string
  mode: ShareMode
  kind: 'note' | 'folder'
  createdAt: string
  stopped: boolean
}

export type ShareDirectory = { shares: ShareLinkRecord[] }

export type ShareHttpRequest = {
  method: 'PUT' | 'GET' | 'DELETE'
  url: string
  headers: Record<string, string>
  body: string
}

export type ShareHttpResponse = { status: number; body: string }

/** Narrow upload/fetch boundary. The client builds the request; the port only sends it. */
export type SharePort = {
  exchange(request: ShareHttpRequest): Promise<ShareHttpResponse>
}

const normalizePath = (path: string) => path.replace(/\\/gu, '/').replace(/^\/+/u, '').replace(/\/+$/u, '')

const isInsideFolder = (path: string, folder: string) => {
  const note = normalizePath(path)
  const root = normalizePath(folder)
  return note === root || note.startsWith(`${root}/`)
}

export const shareNoteTitle = (path: string, content: string) => {
  for (const line of content.split(/\r?\n/u)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/u.exec(line)
    if (heading) return heading[1].trim()
  }
  const base = normalizePath(path).split('/').pop() || path
  return base.replace(/\.md$/iu, '')
}

export const shareViewUrl = (id: string, origin = SHARE_ORIGIN) => (
  `${origin.replace(/\/$/u, '')}${SHARE_VIEW_PATH}?id=${encodeURIComponent(id)}`
)

export const shareApiUrl = (id: string, origin = SHARE_ORIGIN) => (
  `${origin.replace(/\/$/u, '')}${SHARE_API_PATH}/${encodeURIComponent(id)}`
)

export const resolveShareOrigin = () => {
  const platform = typeof window !== 'undefined' ? window.fanotes?.platform : undefined
  if ((platform === 'web' || platform === 'browser-preview') && typeof window !== 'undefined' && window.location?.origin?.startsWith('http')) {
    return window.location.origin
  }
  return SHARE_ORIGIN
}

export const createShareId = () => {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** One note, or every markdown note under a folder, including nested folders. */
export const collectShareNotes = (entries: readonly ShareEntry[], rootPath: string) => {
  const root = normalizePath(rootPath)
  const match = entries.find((entry) => normalizePath(entry.path) === root)
  const nested = entries.some((entry) => entry.kind !== 'folder' && isInsideFolder(entry.path, root) && normalizePath(entry.path) !== root)
  const kind: 'note' | 'folder' = match?.kind === 'folder' || (!match && nested) ? 'folder' : 'note'
  if (kind === 'note') {
    const file = entries.find((entry) => normalizePath(entry.path) === root && entry.kind !== 'folder' && typeof entry.content === 'string')
    if (!file || typeof file.content !== 'string') {
      return { kind, title: shareNoteTitle(root, ''), rootPath: root, notes: [] as ShareNote[] }
    }
    const title = shareNoteTitle(root, file.content)
    return { kind, title, rootPath: root, notes: [{ path: root, title, content: file.content }] }
  }
  const notes = entries
    .filter((entry) => entry.kind !== 'folder' && typeof entry.content === 'string' && isInsideFolder(entry.path, root))
    .map((entry) => {
      const path = normalizePath(entry.path)
      const content = entry.content ?? ''
      return { path, title: shareNoteTitle(path, content), content }
    })
    .sort((left, right) => left.path.localeCompare(right.path, 'de'))
  const title = root.split('/').pop() || root
  return { kind, title, rootPath: root, notes }
}

export const flattenShareVault = (nodes: readonly ShareVaultNode[]): Array<{ path: string; kind: 'file' | 'folder'; extension?: string }> => {
  const flat: Array<{ path: string; kind: 'file' | 'folder'; extension?: string }> = []
  const walk = (list: readonly ShareVaultNode[]) => {
    for (const node of list) {
      flat.push({ path: node.relativePath, kind: node.kind, extension: node.extension })
      if (node.children?.length) walk(node.children)
    }
  }
  walk(nodes)
  return flat
}

const isMarkdownPath = (path: string, extension?: string) => extension === 'md' || path.toLowerCase().endsWith('.md')

export const loadShareEntries = async (
  nodes: readonly ShareVaultNode[],
  readFile: (path: string) => Promise<string>,
): Promise<ShareEntry[]> => {
  const entries: ShareEntry[] = []
  for (const node of flattenShareVault(nodes)) {
    if (node.kind === 'folder') {
      entries.push({ path: node.path, kind: 'folder' })
      continue
    }
    if (!isMarkdownPath(node.path, node.extension)) continue
    entries.push({ path: node.path, kind: 'file', content: await readFile(node.path) })
  }
  return entries
}

export const buildShareUpload = (payload: SharePayload, origin = SHARE_ORIGIN): ShareHttpRequest => ({
  method: 'PUT',
  url: shareApiUrl(payload.id, origin),
  headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-FaNotes-Share': '1' },
  body: JSON.stringify(payload),
})

export const buildShareFetch = (id: string, origin = SHARE_ORIGIN): ShareHttpRequest => ({
  method: 'GET',
  url: shareApiUrl(id, origin),
  headers: { Accept: 'application/json', 'X-FaNotes-Share': '1' },
  body: '',
})

export const buildShareRevoke = (id: string, origin = SHARE_ORIGIN): ShareHttpRequest => ({
  method: 'DELETE',
  url: shareApiUrl(id, origin),
  headers: { Accept: 'application/json', 'X-FaNotes-Share': '1' },
  body: '',
})

export const parseSharePayload = (body: string): SharePayload | null => {
  try {
    const parsed = JSON.parse(body) as Partial<SharePayload>
    if (parsed.schemaVersion !== 1 || typeof parsed.id !== 'string' || !Array.isArray(parsed.notes)) return null
    if (parsed.mode !== 'copy' && parsed.mode !== 'live') return null
    const notes = parsed.notes.flatMap((note) => {
      if (!note || typeof note.content !== 'string' || typeof note.path !== 'string') return []
      return [{ path: note.path, title: typeof note.title === 'string' ? note.title : shareNoteTitle(note.path, note.content), content: note.content }]
    })
    return {
      schemaVersion: 1,
      id: parsed.id,
      mode: parsed.mode,
      kind: parsed.kind === 'folder' ? 'folder' : 'note',
      rootPath: typeof parsed.rootPath === 'string' ? parsed.rootPath : '',
      title: typeof parsed.title === 'string' ? parsed.title : '',
      notes,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      stopped: Boolean(parsed.stopped),
    }
  } catch {
    return null
  }
}

export const emptyShareDirectory = (): ShareDirectory => ({ shares: [] })

export const parseShareDirectory = (raw: string | null | undefined): ShareDirectory => {
  if (!raw) return emptyShareDirectory()
  try {
    const parsed = JSON.parse(raw) as { shares?: unknown }
    if (!parsed || !Array.isArray(parsed.shares)) return emptyShareDirectory()
    const shares = parsed.shares.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const record = item as Partial<ShareLinkRecord>
      if (typeof record.id !== 'string' || typeof record.link !== 'string') return []
      return [{
        id: record.id,
        link: record.link,
        title: typeof record.title === 'string' ? record.title : record.id,
        rootPath: typeof record.rootPath === 'string' ? record.rootPath : '',
        mode: record.mode === 'live' ? 'live' as const : 'copy' as const,
        kind: record.kind === 'folder' ? 'folder' as const : 'note' as const,
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
        stopped: Boolean(record.stopped),
      }]
    })
    return { shares }
  } catch {
    return emptyShareDirectory()
  }
}

export const serializeShareDirectory = (directory: ShareDirectory) => JSON.stringify(directory)

export const rememberShare = (directory: ShareDirectory, record: ShareLinkRecord): ShareDirectory => ({
  shares: [record, ...directory.shares.filter((share) => share.id !== record.id)].slice(0, 30),
})

export const markShareStopped = (directory: ShareDirectory, id: string): ShareDirectory => ({
  shares: directory.shares.map((share) => share.id === id ? { ...share, stopped: true } : share),
})

export const listRecentShares = (directory: ShareDirectory) => directory.shares

export function createFetchSharePort(fetchImpl: typeof fetch = fetch): SharePort {
  return {
    async exchange(request) {
      let response: Response
      try {
        response = await fetchImpl(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' || request.method === 'DELETE' ? undefined : request.body,
          cache: 'no-store',
        })
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError'
        throw new Error(aborted ? 'Die Freigabe-Anfrage wurde abgebrochen.' : 'Der Freigabe-Server ist nicht erreichbar.')
      }
      return { status: response.status, body: await response.text() }
    },
  }
}

export async function publishShare(input: {
  entries: readonly ShareEntry[]
  rootPath: string
  mode: ShareMode
  port: SharePort
  origin?: string
  id?: string
  now?: string
  directory?: ShareDirectory
}): Promise<{ record: ShareLinkRecord; directory: ShareDirectory; request: ShareHttpRequest; payload: SharePayload }> {
  const origin = input.origin ?? resolveShareOrigin()
  const collected = collectShareNotes(input.entries, input.rootPath)
  const payload: SharePayload = {
    schemaVersion: 1,
    id: input.id ?? createShareId(),
    mode: input.mode,
    kind: collected.kind,
    rootPath: collected.rootPath,
    title: collected.title,
    notes: collected.notes,
    updatedAt: input.now ?? new Date().toISOString(),
  }
  const request = buildShareUpload(payload, origin)
  const response = await input.port.exchange(request)
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Freigabe wurde nicht angenommen (${response.status}).`)
  }
  const record: ShareLinkRecord = {
    id: payload.id,
    link: shareViewUrl(payload.id, origin),
    title: payload.title,
    rootPath: payload.rootPath,
    mode: payload.mode,
    kind: payload.kind,
    createdAt: payload.updatedAt,
    stopped: false,
  }
  return { record, directory: rememberShare(input.directory ?? emptyShareDirectory(), record), request, payload }
}

/** A copy returns the uploaded snapshot. A live share resolves the same paths against the current notes. */
export async function readShare(input: {
  id: string
  port: SharePort
  origin?: string
  entries?: readonly ShareEntry[]
}): Promise<SharePayload | null> {
  const origin = input.origin ?? resolveShareOrigin()
  const response = await input.port.exchange(buildShareFetch(input.id, origin))
  if (response.status === 404 || response.status === 410 || !response.body) return null
  const payload = parseSharePayload(response.body)
  if (!payload || payload.stopped) return null
  if (payload.mode === 'live' && input.entries) {
    const fresh = collectShareNotes(input.entries, payload.rootPath)
    return { ...payload, kind: fresh.kind, title: fresh.title, notes: fresh.notes }
  }
  return payload
}

export async function stopShare(input: {
  id: string
  port: SharePort
  origin?: string
  directory?: ShareDirectory
}): Promise<ShareDirectory> {
  const origin = input.origin ?? resolveShareOrigin()
  const response = await input.port.exchange(buildShareRevoke(input.id, origin))
  if (response.status >= 400) throw new Error(`Freigabe konnte nicht beendet werden (${response.status}).`)
  return markShareStopped(input.directory ?? emptyShareDirectory(), input.id)
}

/** Push the current notes for every live share. Copies stay as they were uploaded. */
export async function refreshLiveShares(input: {
  entries: readonly ShareEntry[]
  directory: ShareDirectory
  port: SharePort
  origin?: string
  now?: string
}): Promise<void> {
  const origin = input.origin ?? resolveShareOrigin()
  for (const share of input.directory.shares) {
    if (share.stopped || share.mode !== 'live') continue
    const collected = collectShareNotes(input.entries, share.rootPath)
    const payload: SharePayload = {
      schemaVersion: 1,
      id: share.id,
      mode: 'live',
      kind: collected.kind,
      rootPath: collected.rootPath,
      title: collected.title,
      notes: collected.notes,
      updatedAt: input.now ?? new Date().toISOString(),
    }
    const response = await input.port.exchange(buildShareUpload(payload, origin))
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Live-Freigabe wurde nicht aktualisiert (${response.status}).`)
    }
  }
}

let liveRefreshTimer: ReturnType<typeof setTimeout> | null = null

/** Debounced push after a local save. No-op when nothing is shared live. Never throws into the save path. */
export function queueLiveShareRefresh(input: {
  settingsRecent: string
  loadEntries: () => Promise<readonly ShareEntry[]>
  port?: SharePort
  origin?: string
}) {
  const directory = parseShareDirectory(input.settingsRecent)
  if (!directory.shares.some((share) => share.mode === 'live' && !share.stopped)) return
  if (liveRefreshTimer) clearTimeout(liveRefreshTimer)
  liveRefreshTimer = setTimeout(() => {
    liveRefreshTimer = null
    void input.loadEntries()
      .then((entries) => refreshLiveShares({
        entries,
        directory: parseShareDirectory(input.settingsRecent),
        port: input.port ?? createFetchSharePort(),
        origin: input.origin,
      }))
      .catch(() => undefined)
  }, 1500)
}
