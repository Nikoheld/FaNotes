// Rules for the FaNotes MCP connector. Grok Build and grok.com may connect;
// every other redirect is rejected before a consent screen exists.

const GROK_CALLBACKS = new Set([
  'https://grok.com/connectors-oauth-exchange-code',
  'https://grok.com/connectors-oauth-exchange-code/',
])

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const LOOPBACK_PATH = /^\/(?:callback|redirect|oauth\/callback|oauth\/redirect)(?:\/[A-Za-z0-9_-]{1,64})?$/u
const SCOPE = 'vault:read'
const RESOURCE_PATH = '/mcp'

const TOOLS = Object.freeze([
  {
    name: 'vault_summary',
    description: 'Counts of synced notes, folders, upcoming exams, homework and flashcards. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_notes',
    description: 'Lists synced Markdown notes (path, title, folder, modified time). Read-only. Does not return handwriting images or PDF bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Optional folder prefix, such as Mathematik.' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_note',
    description: 'Reads one synced Markdown note by its vault path. Read-only. Machine markers and embedded files are omitted.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Vault-relative path ending in .md.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_notes',
    description: 'Searches synced Markdown note text and returns short excerpts. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 40 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_exams',
    description: 'Exam and test dates from the synced calendar, homework appointments, and note lines that name a Klausur, Prüfung or exam. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Inclusive YYYY-MM-DD. Defaults to today.' },
        to: { type: 'string', description: 'Exclusive YYYY-MM-DD. Defaults to one year ahead.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_calendar',
    description: 'Events from the synced FaNotes calendar, including calendars hidden in the app. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_homework',
    description: 'Synced homework and appointments, with due dates. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { includeDone: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_flashcards',
    description: 'Synced flashcards stored in notes. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        dueOnly: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
])

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))

export const MCP_SCOPE = SCOPE
export const MCP_TOOLS = TOOLS

const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))

/** A vault-relative Markdown path. Rejects absolute paths, traversal and internal folders. */
export const notePathAllowed = (value) => {
  if (typeof value !== 'string') return false
  const path = value.trim()
  if (!path || path.length > 240) return false
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return false
  return path.toLowerCase().endsWith('.md')
}

const folderAllowed = (value) => {
  if (value === undefined) return true
  if (typeof value !== 'string') return false
  const folder = value.trim().replace(/\/+$/u, '')
  if (!folder) return true
  if (folder.length > 200 || folder.startsWith('/') || folder.includes('\\') || folder.includes('\0')) return false
  const parts = folder.split('/')
  return parts.every((part) => part && part !== '.' && part !== '..' && !part.startsWith('.'))
}

const limitAllowed = (value, max) => value === undefined || (Number.isInteger(value) && value >= 1 && value <= max)

export const toolArgumentsAllowed = (name, args) => {
  const tool = TOOL_BY_NAME.get(name)
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) return false
  const keys = Object.keys(args)
  const properties = tool.inputSchema.properties ?? {}
  if (keys.some((key) => !Object.hasOwn(properties, key))) return false
  if ((tool.inputSchema.required ?? []).some((key) => args[key] === undefined || args[key] === '')) return false
  if (name === 'list_notes') return folderAllowed(args.folder) && limitAllowed(args.limit, 200)
  if (name === 'read_note') return notePathAllowed(args.path)
  if (name === 'search_notes') return typeof args.query === 'string' && args.query.trim().length >= 1 && args.query.trim().length <= 200 && limitAllowed(args.limit, 40)
  if (name === 'list_exams' || name === 'list_calendar') {
    return (args.from === undefined || isDate(args.from)) && (args.to === undefined || isDate(args.to))
  }
  if (name === 'list_homework') return args.includeDone === undefined || typeof args.includeDone === 'boolean'
  if (name === 'list_flashcards') return (args.dueOnly === undefined || typeof args.dueOnly === 'boolean') && limitAllowed(args.limit, 100)
  return keys.length === 0
}

const parsedRedirect = (value) => {
  if (typeof value !== 'string' || value.length < 12 || value.length > 300) return null
  if (value !== value.trim() || /[\u0000-\u001f\s]/u.test(value)) return null
  let url
  try { url = new URL(value) } catch { return null }
  if (url.username || url.password || url.hash || url.search) return null
  return url
}

/** Exact grok.com connector callback, or a loopback callback for Grok Build (any port, RFC 8252). */
export const classifyRedirect = (value) => {
  if (GROK_CALLBACKS.has(value)) return { kind: 'grok', href: value }
  const url = parsedRedirect(value)
  if (!url || url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()
  const bracketed = host.includes(':') ? `[${host}]` : host
  if (!LOOPBACK_HOSTS.has(host) && !LOOPBACK_HOSTS.has(bracketed)) return null
  if (!LOOPBACK_PATH.test(url.pathname)) return null
  return { kind: 'loopback', href: url.href, host, path: url.pathname }
}

export const redirectsMatch = (registered, requested) => {
  const left = classifyRedirect(registered)
  const right = classifyRedirect(requested)
  if (!left || !right || left.kind !== right.kind) return false
  if (left.kind === 'grok') {
    return left.href.replace(/\/$/u, '') === right.href.replace(/\/$/u, '')
  }
  return left.host === right.host && left.path === right.path
}

export const resourceUrl = (origin) => `${String(origin || '').replace(/\/+$/u, '')}${RESOURCE_PATH}`

export const resourceMatches = (origin, resource) => {
  if (resource === undefined || resource === null || resource === '') return true
  return resource === resourceUrl(origin)
}

export const scopeAllowed = (value) => {
  if (value === undefined || value === null || value === '') return SCOPE
  if (typeof value !== 'string' || value.length > 80) return null
  const parts = value.trim().split(/\s+/u).filter(Boolean)
  if (!parts.length || parts.some((part) => part !== SCOPE && part !== 'offline_access')) return null
  if (!parts.includes(SCOPE)) return null
  return SCOPE
}

export const clientNameAllowed = (value) => {
  if (value === undefined || value === null || value === '') return 'Grok'
  if (typeof value !== 'string') return null
  const name = value.replace(/[\u0000-\u001f<>]/gu, '').trim()
  if (!name || name.length > 80) return null
  return name
}

export const pkceS256 = (verifier, challenge) => {
  if (typeof verifier !== 'string' || typeof challenge !== 'string') return false
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) return false
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(challenge)) return false
  return true
}

export const escapeHtml = (value) => String(value)
  .replace(/&/gu, '&amp;')
  .replace(/</gu, '&lt;')
  .replace(/>/gu, '&gt;')
  .replace(/"/gu, '&quot;')
  .replace(/'/gu, '&#39;')
