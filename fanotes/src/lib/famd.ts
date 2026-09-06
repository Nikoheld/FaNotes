import { parseNoteBackups, serializeNoteBackups, type NoteBackupSnapshot } from './noteBackup'
import { parseNoteLinks, serializeNoteLinks, type NoteLinkRecord } from './noteLink'
import { parsePageStats, type PageStats } from './pageStats'
import { isPaperStyle } from './paperStyles'
import type { PaperStyle } from '../types'

export const FAMD_EXTENSION = '.famd'
export const FAMD_SCHEMA = 'fanotes-famd-v1'
export const MARKDOWN_NOTE_EXTENSIONS = ['.md', '.markdown', '.famd'] as const
export const NOTE_FILE_EXTENSIONS = ['.md', '.markdown', '.famd', '.pdf'] as const

const FAMD_HEADER = /(?:^|\n)<!--\s*fanotes-famd:v1\s+chars=(\d+)\s*-->\n/u
const WORKSHEET_MARKER = /<!--\s*fanotes-worksheet:([a-zA-Z0-9_-]{1,96})\s*-->/gu

export type FamdPayload = {
  schema: typeof FAMD_SCHEMA
  updatedAt: string
  ink: Record<string, unknown> | null
  worksheets: string[]
  paperStyle?: PaperStyle
  noteLinks?: NoteLinkRecord[]
  noteBackups?: NoteBackupSnapshot[]
  pageStats?: PageStats
}

export const isNoteFileName = (name: string) => (
  NOTE_FILE_EXTENSIONS.some((extension) => name.toLocaleLowerCase('en-US').endsWith(extension))
)

export const isPdfNotePath = (relativePath: string) => (
  relativePath.toLocaleLowerCase('en-US').endsWith('.pdf')
)

export const noteStem = (relativePath: string) => relativePath.replace(/\.(md|markdown|famd|pdf)$/iu, '')

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
    const noteLinks = parseNoteLinks(parsed.noteLinks)
    const noteBackups = parseNoteBackups(parsed.noteBackups)
    const pageStats = parsed.pageStats ? parsePageStats(parsed.pageStats, Date.parse(updatedAt) || Date.now()) : undefined
    return {
      markdown,
      payload: {
        schema: FAMD_SCHEMA,
        updatedAt,
        ink,
        worksheets,
        ...(paperStyle ? { paperStyle } : {}),
        ...(noteLinks.length ? { noteLinks } : {}),
        ...(noteBackups.length ? { noteBackups } : {}),
        ...(pageStats ? { pageStats } : {}),
      },
    }
  } catch {
    return { markdown, payload: null }
  }
}

export const readPageStatsFromNote = (content: string, now = Date.now()) => {
  const { payload } = parseFamd(content)
  if (payload?.pageStats) return parsePageStats(payload.pageStats, now)
  if (payload?.updatedAt) {
    return parsePageStats({ createdAt: payload.updatedAt, modifiedAt: payload.updatedAt }, now)
  }
  return parsePageStats(null, now)
}

export const writePageStatsIntoNote = (content: string, stats: PageStats) => {
  const { markdown, payload } = parseFamd(typeof content === 'string' ? content : '')
  const next: FamdPayload = {
    ...(payload ?? emptyFamdPayload(stats.modifiedAt)),
    pageStats: stats,
    updatedAt: stats.modifiedAt,
  }
  return serializeFamd(markdown, next)
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
  const noteLinks = serializeNoteLinks(payload.noteLinks)
  if (noteLinks.length) next.noteLinks = noteLinks as NoteLinkRecord[]
  const noteBackups = serializeNoteBackups(payload.noteBackups)
  if (noteBackups.length) next.noteBackups = noteBackups
  if (payload.pageStats) next.pageStats = payload.pageStats
  const json = JSON.stringify(next)
  return `${body ? `${body}\n\n` : ''}<!-- fanotes-famd:v1 chars=${json.length} -->\n${json}\n`
}
