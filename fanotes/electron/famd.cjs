'use strict'

const FAMD_SCHEMA = 'fanotes-famd-v1'
const FAMD_HEADER = /(?:^|\n)<!--\s*fanotes-famd:v1\s+chars=(\d+)\s*-->\n/u
const WORKSHEET_MARKER = /<!--\s*fanotes-worksheet:([a-zA-Z0-9_-]{1,96})\s*-->/gu
const MARKDOWN_NOTE_EXTENSIONS = Object.freeze(['.md', '.markdown', '.famd'])
const NOTE_FILE_EXTENSIONS = Object.freeze(['.md', '.markdown', '.famd', '.pdf'])
const PAPER_STYLES = Object.freeze(['blank', 'dots', 'squares', 'grid', 'lines', 'millimeter'])
const MAX_FAMD_JSON_CHARS = 32 * 1024 * 1024

function isPaperStyle(value) {
  return typeof value === 'string' && PAPER_STYLES.includes(value)
}

function isMarkdownExtension(extension) {
  return MARKDOWN_NOTE_EXTENSIONS.includes(String(extension || '').toLocaleLowerCase('en-US'))
}

function isPdfNoteExtension(extension) {
  return String(extension || '').toLocaleLowerCase('en-US') === '.pdf'
}

function isNoteExtension(extension) {
  return NOTE_FILE_EXTENSIONS.includes(String(extension || '').toLocaleLowerCase('en-US'))
}

function noteStem(relativePath) {
  return String(relativePath || '').replace(/\.(md|markdown|famd|pdf)$/iu, '')
}

function companionNotePath(relativePath, extension) {
  return `${noteStem(relativePath)}${extension}`
}

const NOTE_LINK_ID = /^[a-zA-Z0-9._-]{1,96}$/u
const NOTE_LINK_STYLES = Object.freeze(['symbol', 'text', 'symbol-text'])

function isNoteLinkStyleId(value) {
  return NOTE_LINK_STYLES.includes(value)
}

function sanitizeNoteLinkPath(value) {
  if (typeof value !== 'string') return ''
  const path = value.replace(/\\/gu, '/').replace(/^\/+/u, '').trim()
  if (!path || path.length > 500 || path.includes('..') || path.includes('\0')) return ''
  return path
}

function sanitizeNoteLink(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const sourcePath = sanitizeNoteLinkPath(value.sourcePath)
  const targetPath = sanitizeNoteLinkPath(value.targetPath)
  if (!sourcePath || !targetPath || sourcePath === targetPath || !/\.md$/iu.test(targetPath)) return null
  const page = Number(value.page)
  const x = Number(value.x)
  const y = Number(value.y)
  const label = typeof value.label === 'string' ? value.label.replace(/\s+/gu, ' ').trim().slice(0, 80) : ''
  const stem = targetPath.replace(/^.*\//u, '').replace(/\.(md|markdown)$/iu, '') || 'Notiz'
  return {
    id: typeof value.id === 'string' && NOTE_LINK_ID.test(value.id) ? value.id : `nl-${Date.now().toString(36)}`,
    sourcePath,
    targetPath,
    page: Number.isSafeInteger(page) && page >= 1 && page <= 10000 ? page : 1,
    x: Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5,
    y: Number.isFinite(y) ? Math.min(1, Math.max(0, y)) : 0.5,
    style: isNoteLinkStyleId(value.style) ? value.style : 'symbol',
    label: label || stem,
    appearance: value.style === 'text' ? 'text' : value.style === 'symbol-text' ? 'symbol-text' : 'symbol',
  }
}

function parseNoteLinks(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const links = []
  for (const entry of value) {
    const link = sanitizeNoteLink(entry)
    if (!link || seen.has(link.id)) continue
    seen.add(link.id)
    links.push(link)
  }
  return links
}

const NOTE_BACKUP_ID = /^[a-zA-Z0-9._-]{1,96}$/u
const NOTE_BACKUP_LIMIT = 40
const NOTE_BACKUP_MAX_CHARS = 2 * 1024 * 1024

function sanitizeNoteBackup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const notePath = sanitizeNoteLinkPath(value.notePath)
  if (!notePath) return null
  const createdAt = typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
    ? new Date(value.createdAt).toISOString()
    : new Date().toISOString()
  const content = typeof value.content === 'string' ? value.content.slice(0, NOTE_BACKUP_MAX_CHARS) : ''
  return {
    id: typeof value.id === 'string' && NOTE_BACKUP_ID.test(value.id) ? value.id : `nb-${Date.now().toString(36)}`,
    notePath,
    createdAt,
    content,
  }
}

function parseNoteBackups(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const snapshots = []
  for (const entry of value) {
    const snapshot = sanitizeNoteBackup(entry)
    if (!snapshot || seen.has(snapshot.id)) continue
    seen.add(snapshot.id)
    snapshots.push(snapshot)
  }
  return snapshots.slice(-NOTE_BACKUP_LIMIT)
}

function emptyFamdPayload(updatedAt = new Date().toISOString()) {
  return { schema: FAMD_SCHEMA, updatedAt, ink: null, worksheets: [] }
}

function worksheetIdsFromMarkdown(markdown) {
  return [...String(markdown || '').matchAll(WORKSHEET_MARKER)].map((match) => match[1])
}

function stripFamdPayload(source) {
  if (typeof source !== 'string' || !source) return ''
  const match = [...source.matchAll(new RegExp(FAMD_HEADER.source, 'gu'))].at(-1)
  if (!match || match.index === undefined) return source.replace(/\s+$/u, '')
  return source.slice(0, match.index).replace(/\s+$/u, '')
}

function parseFamd(source) {
  const markdown = stripFamdPayload(source)
  if (typeof source !== 'string' || !source) return { markdown: '', payload: null }
  const match = [...source.matchAll(new RegExp(FAMD_HEADER.source, 'gu'))].at(-1)
  if (!match || match.index === undefined) return { markdown, payload: null }
  const length = Number(match[1])
  if (!Number.isSafeInteger(length) || length < 2 || length > MAX_FAMD_JSON_CHARS) {
    return { markdown, payload: null }
  }
  const start = match.index + match[0].length
  const json = source.slice(start, start + length)
  if (json.length !== length) return { markdown, payload: null }
  try {
    const parsed = JSON.parse(json)
    if (!parsed || parsed.schema !== FAMD_SCHEMA || typeof parsed !== 'object') {
      return { markdown, payload: null }
    }
    const worksheets = Array.isArray(parsed.worksheets)
      ? parsed.worksheets.filter((id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,96}$/u.test(id))
      : []
    const ink = parsed.ink && typeof parsed.ink === 'object' && !Array.isArray(parsed.ink) ? parsed.ink : null
    const updatedAt = typeof parsed.updatedAt === 'string' && Number.isFinite(Date.parse(parsed.updatedAt))
      ? new Date(parsed.updatedAt).toISOString()
      : new Date().toISOString()
    const paperStyle = isPaperStyle(parsed.paperStyle) ? parsed.paperStyle : undefined
    const noteLinks = parseNoteLinks(parsed.noteLinks)
    const noteBackups = parseNoteBackups(parsed.noteBackups)
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
      },
    }
  } catch {
    return { markdown, payload: null }
  }
}

function serializeFamd(markdown, payload) {
  const body = stripFamdPayload(markdown)
  const next = {
    schema: FAMD_SCHEMA,
    updatedAt: payload?.updatedAt || new Date().toISOString(),
    ink: payload?.ink && typeof payload.ink === 'object' ? payload.ink : null,
    worksheets: Array.isArray(payload?.worksheets) && payload.worksheets.length
      ? payload.worksheets
      : worksheetIdsFromMarkdown(body),
    ...(isPaperStyle(payload?.paperStyle) ? { paperStyle: payload.paperStyle } : {}),
  }
  const noteLinks = parseNoteLinks(payload?.noteLinks)
  if (noteLinks.length) next.noteLinks = noteLinks
  const noteBackups = parseNoteBackups(payload?.noteBackups)
  if (noteBackups.length) next.noteBackups = noteBackups
  const json = JSON.stringify(next)
  return `${body ? `${body}\n\n` : ''}<!-- fanotes-famd:v1 chars=${json.length} -->\n${json}\n`
}

module.exports = {
  FAMD_SCHEMA,
  MAX_FAMD_JSON_CHARS,
  MARKDOWN_NOTE_EXTENSIONS,
  NOTE_FILE_EXTENSIONS,
  PAPER_STYLES,
  companionNotePath,
  isPaperStyle,
  emptyFamdPayload,
  isMarkdownExtension,
  isNoteExtension,
  isPdfNoteExtension,
  noteStem,
  parseFamd,
  parseNoteBackups,
  parseNoteLinks,
  serializeFamd,
  stripFamdPayload,
  worksheetIdsFromMarkdown,
}
