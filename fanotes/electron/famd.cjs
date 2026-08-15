'use strict'

const FAMD_SCHEMA = 'fanotes-famd-v1'
const FAMD_HEADER = /(?:^|\n)<!--\s*fanotes-famd:v1\s+chars=(\d+)\s*-->\n/u
const WORKSHEET_MARKER = /<!--\s*fanotes-worksheet:([a-zA-Z0-9_-]{1,96})\s*-->/gu
const NOTE_FILE_EXTENSIONS = Object.freeze(['.md', '.markdown', '.famd'])
const PAPER_STYLES = Object.freeze(['blank', 'dots', 'squares', 'grid', 'lines', 'millimeter'])
const MAX_FAMD_JSON_CHARS = 32 * 1024 * 1024

function isPaperStyle(value) {
  return typeof value === 'string' && PAPER_STYLES.includes(value)
}

function isNoteExtension(extension) {
  return NOTE_FILE_EXTENSIONS.includes(String(extension || '').toLocaleLowerCase('en-US'))
}

function noteStem(relativePath) {
  return String(relativePath || '').replace(/\.(md|markdown|famd)$/iu, '')
}

function companionNotePath(relativePath, extension) {
  return `${noteStem(relativePath)}${extension}`
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
    return { markdown, payload: { schema: FAMD_SCHEMA, updatedAt, ink, worksheets, ...(paperStyle ? { paperStyle } : {}) } }
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
  const json = JSON.stringify(next)
  return `${body ? `${body}\n\n` : ''}<!-- fanotes-famd:v1 chars=${json.length} -->\n${json}\n`
}

module.exports = {
  FAMD_SCHEMA,
  MAX_FAMD_JSON_CHARS,
  NOTE_FILE_EXTENSIONS,
  PAPER_STYLES,
  companionNotePath,
  isPaperStyle,
  emptyFamdPayload,
  isNoteExtension,
  noteStem,
  parseFamd,
  serializeFamd,
  stripFamdPayload,
  worksheetIdsFromMarkdown,
}
