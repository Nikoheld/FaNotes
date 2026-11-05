import { parseNoteBackups, serializeNoteBackups, type NoteBackupSnapshot } from './noteBackup'
import { parseNoteLinks, serializeNoteLinks, type NoteLinkRecord } from './noteLink'
import { parseNoteTextFields, type NoteTextField } from './noteTextField'
import { parsePageStats, type PageStats } from './pageStats'
import { isPaperStyle } from './paperStyles'
import type { PaperStyle } from '../types'
import {
  FAMD_V2_SCHEMA,
  encodeV2Document,
  famdEncodingForSave,
  isActiveV2,
  readV2Payload,
  v2CutIndex,
} from '../../electron/famdV2.mjs'

export { famdEncodingForSave }

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
  textFields?: NoteTextField[]
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

const isFamdSidecarJson = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') || !trimmed.includes(FAMD_SCHEMA)) return false
  try {
    const parsed = JSON.parse(trimmed) as { schema?: unknown }
    return parsed?.schema === FAMD_SCHEMA
  } catch {
    return false
  }
}

export const stripFamdPayload = (source: string) => {
  if (typeof source !== 'string' || !source) return ''
  let text = source
  const match = [...text.matchAll(new RegExp(FAMD_HEADER.source, 'gu'))].at(-1)
  const v2Cut = v2CutIndex(text)
  let cut = match && match.index !== undefined ? match.index : -1
  if (v2Cut >= 0 && v2Cut > cut) cut = v2Cut
  if (cut >= 0) text = text.slice(0, cut)
  text = text.replace(/\s+$/u, '')
  if (isFamdSidecarJson(text)) return ''
  const trailing = text.match(/\n(\{[\s\S]*\})\s*$/u)
  if (trailing?.[1] && isFamdSidecarJson(trailing[1])) {
    return text.slice(0, trailing.index).replace(/\s+$/u, '')
  }
  return text
}

const payloadFromParsed = (parsed: Partial<FamdPayload> & { schema?: string } | null): FamdPayload | null => {
  if (!parsed || typeof parsed !== 'object' || parsed.schema !== FAMD_SCHEMA && parsed.schema !== FAMD_V2_SCHEMA) return null
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
  const textFields = parseNoteTextFields(parsed.textFields)
  return {
    schema: FAMD_SCHEMA,
    updatedAt,
    ink,
    worksheets,
    ...(paperStyle ? { paperStyle } : {}),
    ...(noteLinks.length ? { noteLinks } : {}),
    ...(noteBackups.length ? { noteBackups } : {}),
    ...(pageStats ? { pageStats } : {}),
    ...(textFields.length ? { textFields } : {}),
  }
}

export const parseFamd = (source: string): { markdown: string; payload: FamdPayload | null } => {
  const markdown = stripFamdPayload(source)
  if (typeof source !== 'string' || !source) return { markdown: '', payload: null }
  if (isActiveV2(source)) {
    const payload = payloadFromParsed(readV2Payload(source) as Partial<FamdPayload>)
    if (!payload) throw new Error('famd v2 payload')
    return { markdown, payload }
  }
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
    return { markdown, payload: payloadFromParsed(JSON.parse(json) as Partial<FamdPayload>) }
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
    // Statistics move on a timer. The note's own timestamp stays, or a later
    // statistics-only save would look like an edit to every other device.
    updatedAt: payload?.updatedAt || stats.modifiedAt,
  }
  return serializeFamd(markdown, next, famdEncodingForSave(content))
}

const syncTextDecoder = new TextDecoder()
const syncTextEncoder = new TextEncoder()

/** A note file whose body can carry a `.famd` payload. PDF bytes are not notes. */
export const isFamdSyncPath = (path: string) => /\.(?:md|markdown|famd)$/iu.test(path)

/**
 * Bytes that decide whether a note changed for sync.
 * A file without page statistics is returned untouched, so a vault that never
 * stored them is not rewritten. Statistics are removed; the note timestamp is kept.
 */
export const canonicalSyncBytes = (path: string, bytes: Uint8Array): Uint8Array => {
  if (!isFamdSyncPath(path)) return bytes
  const text = syncTextDecoder.decode(bytes)
  const parsed = parseFamd(text)
  if (!parsed.payload?.pageStats) return bytes
  const { pageStats: _pageStats, ...rest } = parsed.payload
  return syncTextEncoder.encode(serializeFamd(parsed.markdown, rest, famdEncodingForSave(text)))
}

export type NoteSyncKind = 'present' | 'blank' | 'unreadable'

const IDENTITY_STAMP = '1970-01-01T00:00:00.000Z'

const headerLooksStored = (text: string) => text.includes('fanotes-famd:v1') || text.includes('fanotes-famd:v2')

/** True when the ink object, including packed strokes and collapsed sections, holds marks. */
export const inkHasMarks = (value: unknown, depth = 0): boolean => {
  if (!value || depth > 6) return false
  if (Array.isArray(value)) return value.some((item) => inkHasMarks(item, depth + 1))
  if (typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.famdPts === 'string' && record.famdPts.length > 0) return true
  if (Array.isArray(record.points) && record.points.length > 0) return true
  if (Array.isArray(record.figurePaths) && record.figurePaths.length > 0) return true
  if (Array.isArray(record.strokes) && record.strokes.some((stroke) => inkHasMarks(stroke, depth + 1))) return true
  return inkHasMarks(record.ink, depth + 1) || inkHasMarks(record.hidden, depth + 1) || inkHasMarks(record.sections, depth + 1)
}

const textFieldsHaveText = (payload: FamdPayload | null) => (
  payload?.textFields?.some((field) => typeof field.text === 'string' && field.text.trim().length > 0) ?? false
)

/** Blank means no prose and no ink. A truncated famd is unreadable and must not be uploaded. */
export const noteSyncKind = (path: string, bytes: Uint8Array): NoteSyncKind => {
  if (!bytes.byteLength) return 'blank'
  if (!isFamdSyncPath(path)) return 'present'
  let text: string
  try {
    text = syncTextDecoder.decode(bytes)
  } catch {
    return 'unreadable'
  }
  try {
    if (isActiveV2(text)) {
      const payload = payloadFromParsed(readV2Payload(text) as Partial<FamdPayload>)
      if (!payload) return 'unreadable'
      const markdown = stripFamdPayload(text).trim()
      if (!markdown && !inkHasMarks(payload) && !textFieldsHaveText(payload)) return 'blank'
      return 'present'
    }
  } catch {
    return 'unreadable'
  }
  const parsed = parseFamd(text)
  if (headerLooksStored(text) && !parsed.payload) return 'unreadable'
  const markdown = parsed.markdown.trim()
  if (!markdown && !inkHasMarks(parsed.payload) && !textFieldsHaveText(parsed.payload)) return 'blank'
  return 'present'
}

/**
 * Hash input that ignores page statistics and timestamps.
 * Two saves of the same strokes and prose produce the same bytes.
 */
export const identitySyncBytes = (path: string, bytes: Uint8Array): Uint8Array | null => {
  if (noteSyncKind(path, bytes) === 'unreadable') return null
  if (!isFamdSyncPath(path)) return bytes
  const text = syncTextDecoder.decode(bytes)
  const parsed = parseFamd(text)
  if (!parsed.payload) return canonicalSyncBytes(path, bytes)
  const { pageStats: _pageStats, ink, ...rest } = parsed.payload
  const stableInk = ink && typeof ink === 'object'
    ? { ...ink, updatedAt: IDENTITY_STAMP }
    : ink
  return syncTextEncoder.encode(serializeFamd(parsed.markdown, {
    ...rest,
    updatedAt: IDENTITY_STAMP,
    ink: stableInk,
  }, famdEncodingForSave(text)))
}

/** Put this device's page statistics back into a note downloaded from sync. */
export const withLocalPageStats = (downloaded: string, local: string): string => {
  const stats = parseFamd(local).payload?.pageStats
  if (!stats) return downloaded
  const remote = parseFamd(downloaded)
  if (!remote.payload) return downloaded
  return serializeFamd(remote.markdown, {
    ...remote.payload,
    updatedAt: remote.payload.updatedAt,
    pageStats: stats,
  }, famdEncodingForSave(downloaded))
}

export const serializeFamd = (markdown: string, payload: FamdPayload, encoding?: 'v1' | 'v2') => {
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
  const textFields = parseNoteTextFields(payload.textFields)
  if (textFields.length) next.textFields = textFields
  if (encoding === 'v2') return encodeV2Document(body, next)
  const json = JSON.stringify(next)
  return `${body ? `${body}\n\n` : ''}<!-- fanotes-famd:v1 chars=${json.length} -->\n${json}\n`
}
