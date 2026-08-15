import { isPaperStyle } from './paperStyles'
import type { PaperStyle } from '../types'

export const FAMD_EXTENSION = '.famd'
export const FAMD_SCHEMA = 'fanotes-famd-v1'
export const NOTE_FILE_EXTENSIONS = ['.md', '.markdown', '.famd'] as const

const FAMD_HEADER = /(?:^|\n)<!--\s*fanotes-famd:v1\s+chars=(\d+)\s*-->\n/u
const WORKSHEET_MARKER = /<!--\s*fanotes-worksheet:([a-zA-Z0-9_-]{1,96})\s*-->/gu

export type FamdPayload = {
  schema: typeof FAMD_SCHEMA
  updatedAt: string
  ink: Record<string, unknown> | null
  worksheets: string[]
  paperStyle?: PaperStyle
}

export const isNoteFileName = (name: string) => (
  NOTE_FILE_EXTENSIONS.some((extension) => name.toLocaleLowerCase('en-US').endsWith(extension))
)

export const noteStem = (relativePath: string) => relativePath.replace(/\.(md|markdown|famd)$/iu, '')

export const companionNotePath = (relativePath: string, extension: '.md' | '.famd') => (
  `${noteStem(relativePath)}${extension}`
)

export const emptyFamdPayload = (updatedAt = new Date().toISOString()): FamdPayload => ({
  schema: FAMD_SCHEMA,
  updatedAt,
  ink: null,
  worksheets: [],
})

export const worksheetIdsFromMarkdown = (markdown: string) => (
  [...markdown.matchAll(WORKSHEET_MARKER)].map((match) => match[1])
)

export const stripFamdPayload = (source: string) => {
  if (typeof source !== 'string' || !source) return ''
  const match = [...source.matchAll(new RegExp(FAMD_HEADER.source, 'gu'))].at(-1)
  if (!match || match.index === undefined) return source.replace(/\s+$/u, '')
  return source.slice(0, match.index).replace(/\s+$/u, '')
}

export const parseFamd = (source: string): { markdown: string; payload: FamdPayload | null } => {
  const markdown = stripFamdPayload(source)
  if (typeof source !== 'string' || !source) return { markdown: '', payload: null }
  const match = [...source.matchAll(new RegExp(FAMD_HEADER.source, 'gu'))].at(-1)
  if (!match || match.index === undefined) return { markdown, payload: null }
  const length = Number(match[1])
  if (!Number.isSafeInteger(length) || length < 2 || length > 32 * 1024 * 1024) {
    return { markdown, payload: null }
  }
  const start = match.index + match[0].length
  const json = source.slice(start, start + length)
  if (json.length !== length) return { markdown, payload: null }
  try {
    const parsed = JSON.parse(json) as Partial<FamdPayload>
    if (parsed?.schema !== FAMD_SCHEMA || !parsed || typeof parsed !== 'object') {
      return { markdown, payload: null }
    }
    const worksheets = Array.isArray(parsed.worksheets)
      ? parsed.worksheets.filter((id): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,96}$/u.test(id))
      : []
    const ink = parsed.ink && typeof parsed.ink === 'object' && !Array.isArray(parsed.ink)
      ? parsed.ink as Record<string, unknown>
      : null
    const updatedAt = typeof parsed.updatedAt === 'string' && Number.isFinite(Date.parse(parsed.updatedAt))
      ? new Date(parsed.updatedAt).toISOString()
      : new Date().toISOString()
    const paperStyle = isPaperStyle(parsed.paperStyle) ? parsed.paperStyle : undefined
    return { markdown, payload: { schema: FAMD_SCHEMA, updatedAt, ink, worksheets, ...(paperStyle ? { paperStyle } : {}) } }
  } catch {
    return { markdown, payload: null }
  }
}

export const serializeFamd = (markdown: string, payload: FamdPayload) => {
  const body = stripFamdPayload(markdown)
  const next: FamdPayload = {
    schema: FAMD_SCHEMA,
    updatedAt: payload.updatedAt || new Date().toISOString(),
    ink: payload.ink && typeof payload.ink === 'object' ? payload.ink : null,
    worksheets: payload.worksheets.length ? payload.worksheets : worksheetIdsFromMarkdown(body),
    ...(isPaperStyle(payload.paperStyle) ? { paperStyle: payload.paperStyle } : {}),
  }
  const json = JSON.stringify(next)
  return `${body ? `${body}\n\n` : ''}<!-- fanotes-famd:v1 chars=${json.length} -->\n${json}\n`
}
