'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const v2codec = require('./famdV2.mjs')
const famdPack = require('./famdPack.mjs')

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

const TEXT_FIELD_ID = /^[a-zA-Z0-9._-]{1,96}$/u
const TEXT_FIELD_LIMIT = 200
const TEXT_FIELD_MAX_CHARS = 8000

function sanitizeNoteTextField(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const page = Number(value.page)
  const x = Number(value.x)
  const y = Number(value.y)
  const width = Number(value.width)
  const fontSize = Number(value.fontSize)
  return {
    id: typeof value.id === 'string' && TEXT_FIELD_ID.test(value.id) ? value.id : `tf-${Date.now().toString(36)}`,
    page: Number.isSafeInteger(page) && page >= 1 && page <= 10000 ? page : 1,
    x: Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5,
    y: Number.isFinite(y) ? Math.min(1, Math.max(0, y)) : 0.5,
    width: Number.isFinite(width) ? Math.min(0.92, Math.max(0.12, width)) : 0.32,
    fontSize: Number.isSafeInteger(fontSize) && fontSize >= 10 && fontSize <= 48 ? fontSize : 16,
    text: typeof value.text === 'string' ? value.text.slice(0, TEXT_FIELD_MAX_CHARS) : '',
  }
}

function parseNoteTextFields(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const fields = []
  for (const entry of value) {
    const field = sanitizeNoteTextField(entry)
    if (!field || seen.has(field.id)) continue
    seen.add(field.id)
    fields.push(field)
    if (fields.length === TEXT_FIELD_LIMIT) break
  }
  return fields
}

function emptyFamdPayload(updatedAt = new Date().toISOString()) {
  return { schema: FAMD_SCHEMA, updatedAt, ink: null, worksheets: [] }
}

function worksheetIdsFromMarkdown(markdown) {
  return [...String(markdown || '').matchAll(WORKSHEET_MARKER)].map((match) => match[1])
}

function isFamdSidecarJson(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed.startsWith('{') || !trimmed.includes(FAMD_SCHEMA)) return false
  try {
    const parsed = JSON.parse(trimmed)
    return Boolean(parsed && parsed.schema === FAMD_SCHEMA)
  } catch {
    return false
  }
}

function parsePageStats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const createdAt = typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
    ? new Date(value.createdAt).toISOString()
    : undefined
  const modifiedAt = typeof value.modifiedAt === 'string' && Number.isFinite(Date.parse(value.modifiedAt))
    ? new Date(value.modifiedAt).toISOString()
    : createdAt
  if (!createdAt || !modifiedAt) return undefined
  const lastOpenedAt = typeof value.lastOpenedAt === 'string' && Number.isFinite(Date.parse(value.lastOpenedAt))
    ? new Date(value.lastOpenedAt).toISOString()
    : createdAt
  const dwell = Number(value.dwellMs)
  const opens = Number(value.openCount)
  // The editor stores typing, ink, and document counts beside the five
  // companion keys. Replacing the object dropped those counts on every save.
  return {
    ...value,
    createdAt,
    modifiedAt,
    lastOpenedAt,
    dwellMs: Number.isFinite(dwell) && dwell >= 0 ? Math.floor(dwell) : 0,
    openCount: Number.isFinite(opens) && opens >= 0 ? Math.floor(opens) : 0,
  }
}

function stripFamdPayload(source) {
  if (typeof source !== 'string' || !source) return ''
  let text = source
  const match = [...text.matchAll(new RegExp(FAMD_HEADER.source, 'gu'))].at(-1)
  const v2Cut = v2codec.v2CutIndex(text)
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

function payloadFromParsed(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (parsed.schema !== FAMD_SCHEMA && parsed.schema !== v2codec.FAMD_V2_SCHEMA) return null
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
  const pageStats = parsePageStats(parsed.pageStats)
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

function parseFamd(source) {
  const markdown = stripFamdPayload(source)
  if (typeof source !== 'string' || !source) return { markdown: '', payload: null }
  if (v2codec.isActiveV2(source)) {
    const payload = payloadFromParsed(v2codec.readV2Payload(source))
    if (!payload) throw new v2codec.FamdCorruptError('famd v2 payload')
    return { markdown, payload }
  }
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
    const payload = payloadFromParsed(JSON.parse(json))
    return { markdown, payload }
  } catch {
    return { markdown, payload: null }
  }
}

/**
 * One read of a companion: the header JSON is parsed once, then ink, page
 * stats, links, paper style, backups, and text fields come from that object. Callers that
 * only need the visible note use `stripFamdPayload`, which does not parse it.
 */
function readFamdCompanion(source) {
  const parsed = parseFamd(source)
  return companionFromParsed(parsed)
}

function companionFromParsed(parsed) {
  const payload = parsed.payload
  const ink = payload?.ink ?? null
  const inkStyle = ink && isPaperStyle(ink.paperStyle) ? ink.paperStyle : null
  return {
    markdown: parsed.markdown,
    updatedAt: payload?.updatedAt ?? null,
    ink,
    pageStats: payload?.pageStats ?? null,
    paperStyle: payload?.paperStyle || inkStyle,
    noteLinks: payload?.noteLinks ?? [],
    noteBackups: payload?.noteBackups ?? [],
    textFields: payload?.textFields ?? [],
  }
}

/**
 * One companion read for the window.
 * A heavy page keeps samples in columns and leaves the main thread free.
 * A short page stays the ordinary unpacked document.
 */
function openFamdFile(source) {
  const markdown = stripFamdPayload(source)
  if (v2codec.isActiveV2(source)) {
    const raw = v2codec.readV2Payload(source, { unpack: false })
    const companion = companionFromParsed({ markdown, payload: payloadFromParsed(raw) })
    const packed = famdPack.packInk(companion.ink)
    if (!packed) return { ...readFamdCompanion(source), packedInk: null }
    return { ...companion, ink: packed.slim, packedInk: packed.packedInk }
  }
  const companion = readFamdCompanion(source)
  const packed = famdPack.packInk(companion.ink)
  if (!packed) return { ...companion, packedInk: null }
  return { ...companion, ink: packed.slim, packedInk: packed.packedInk }
}

/**
 * The text a companion write stores. `ink === undefined` keeps the ink already
 * in the file. Callers that already hold a large file run this off the UI thread.
 */
function composeFamdCompanion(existingSource, markdown, ink, settingsPaperStyle) {
  const existing = existingSource ? parseFamd(existingSource) : { markdown: '', payload: emptyFamdPayload() }
  const incoming = parseFamd(typeof markdown === 'string' ? markdown : '')
  const body = incoming.markdown || stripFamdPayload(typeof markdown === 'string' ? markdown : '')
  const existingPayload = existing.payload || emptyFamdPayload()
  const inkDocument = ink === undefined ? existingPayload.ink : ink
  const paperFromInk = inkDocument && typeof inkDocument === 'object' && isPaperStyle(inkDocument.paperStyle)
    ? inkDocument.paperStyle
    : undefined
  const payload = {
    ...existingPayload,
    ...(incoming.payload || {}),
    updatedAt: new Date().toISOString(),
    worksheets: worksheetIdsFromMarkdown(body),
    ink: inkDocument ?? null,
    paperStyle: existingPayload.paperStyle || incoming.payload?.paperStyle || paperFromInk || (isPaperStyle(settingsPaperStyle) ? settingsPaperStyle : undefined),
    ...(incoming.payload?.pageStats ? { pageStats: incoming.payload.pageStats } : {}),
  }
  return serializeFamd(body, payload, v2codec.famdEncodingForSave(existingSource))
}

function serializeFamd(markdown, payload, encoding) {
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
  const pageStats = parsePageStats(payload?.pageStats)
  if (pageStats) next.pageStats = pageStats
  const textFields = parseNoteTextFields(payload?.textFields)
  if (textFields.length) next.textFields = textFields
  if (encoding === 'v2') return v2codec.encodeV2Document(body, next)
  const json = JSON.stringify(next)
  return `${body ? `${body}\n\n` : ''}<!-- fanotes-famd:v1 chars=${json.length} -->\n${json}\n`
}

/** Bytes for a note that did not exist yet. New notes use the compact encoding. */
function createNoteCompanion(markdown, updatedAt) {
  return serializeFamd(markdown, emptyFamdPayload(updatedAt), 'v2')
}

const POINT_TOLERANCE = 1e-4

function samePoint(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return left === right
  if (Math.abs(Number(left.x) - Number(right.x)) > POINT_TOLERANCE) return false
  if (Math.abs(Number(left.y) - Number(right.y)) > POINT_TOLERANCE) return false
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (key === 'x' || key === 'y') continue
    if (left[key] !== right[key]) return false
  }
  return true
}

function sameStroke(left, right) {
  if (!left || !right) return left === right
  const leftPoints = Array.isArray(left.points) ? left.points : []
  const rightPoints = Array.isArray(right.points) ? right.points : []
  if (leftPoints.length !== rightPoints.length) return false
  for (let index = 0; index < leftPoints.length; index += 1) {
    if (!samePoint(leftPoints[index], rightPoints[index])) return false
  }
  const leftKeys = Object.keys(left).filter((key) => key !== 'points').sort()
  const rightKeys = Object.keys(right).filter((key) => key !== 'points').sort()
  if (leftKeys.join('\0') !== rightKeys.join('\0')) return false
  for (const key of leftKeys) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) return false
  }
  return true
}

function sameInk(left, right) {
  if (left == null && right == null) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  const leftKeys = Object.keys(left).filter((key) => key !== 'strokes').sort()
  const rightKeys = Object.keys(right).filter((key) => key !== 'strokes').sort()
  if (leftKeys.join('\0') !== rightKeys.join('\0')) return false
  for (const key of leftKeys) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) return false
  }
  const leftStrokes = Array.isArray(left.strokes) ? left.strokes : []
  const rightStrokes = Array.isArray(right.strokes) ? right.strokes : []
  if (leftStrokes.length !== rightStrokes.length) return false
  for (let index = 0; index < leftStrokes.length; index += 1) {
    if (!sameStroke(leftStrokes[index], rightStrokes[index])) return false
  }
  return true
}

function sameFamdPayload(left, right) {
  if (!left || !right) return false
  if (left.updatedAt !== right.updatedAt) return false
  if ((left.paperStyle || undefined) !== (right.paperStyle || undefined)) return false
  if (JSON.stringify(left.worksheets || []) !== JSON.stringify(right.worksheets || [])) return false
  if (JSON.stringify(left.noteLinks || []) !== JSON.stringify(right.noteLinks || [])) return false
  if (JSON.stringify(left.noteBackups || []) !== JSON.stringify(right.noteBackups || [])) return false
  if (JSON.stringify(left.pageStats || null) !== JSON.stringify(right.pageStats || null)) return false
  if (JSON.stringify(left.textFields || []) !== JSON.stringify(right.textFields || [])) return false
  return sameInk(left.ink, right.ink)
}

/**
 * Logical conversion of one file's text. A failure returns the original
 * string so the caller can leave the bytes on disk alone.
 */
function convertFamdSource(source) {
  const original = typeof source === 'string' ? source : ''
  try {
    if (v2codec.isActiveV2(original)) {
      parseFamd(original)
      return { status: 'skipped', source: original }
    }
    if (!original.includes('fanotes-famd:v1')) return { status: 'skipped', source: original }
    const parsed = parseFamd(original)
    if (!parsed.payload) return { status: 'failed', source: original }
    const next = serializeFamd(parsed.markdown, parsed.payload, 'v2')
    const back = parseFamd(next)
    if (back.markdown !== parsed.markdown || !sameFamdPayload(parsed.payload, back.payload)) {
      return { status: 'failed', source: original }
    }
    return { status: 'converted', source: next }
  } catch {
    return { status: 'failed', source: original }
  }
}

const CONVERT_SKIP_DIRS = new Set(['.fanotes', '.git', 'node_modules'])

/**
 * Replace a note only after the new file reloads to the same markdown and
 * payload. A note that fails stays byte-identical.
 */
function convertFamdDirectory(root) {
  const counts = { converted: 0, skipped: 0, failed: 0 }
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      counts.failed += 1
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (CONVERT_SKIP_DIRS.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const extension = path.extname(entry.name).toLocaleLowerCase('en-US')
      if (extension !== '.famd' && extension !== '.md' && extension !== '.markdown') continue
      let bytes
      try {
        bytes = fs.readFileSync(full)
      } catch {
        counts.failed += 1
        continue
      }
      const text = bytes.toString('utf8')
      const result = convertFamdSource(text)
      if (result.status === 'skipped') {
        counts.skipped += 1
        continue
      }
      if (result.status !== 'converted') {
        counts.failed += 1
        continue
      }
      const temp = `${full}.${crypto.randomBytes(6).toString('hex')}.famd-new`
      try {
        fs.writeFileSync(temp, result.source, { mode: 0o600 })
        const readBack = fs.readFileSync(temp, 'utf8')
        const originalParsed = parseFamd(text)
        const again = parseFamd(readBack)
        if (again.markdown !== originalParsed.markdown || !sameFamdPayload(originalParsed.payload, again.payload)) {
          throw new Error('famd conversion round-trip')
        }
        fs.renameSync(temp, full)
        counts.converted += 1
      } catch {
        counts.failed += 1
        try { fs.rmSync(temp, { force: true }) } catch { /* the original file is still in place */ }
      }
    }
  }
  walk(root)
  return counts
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
  FamdCorruptError: v2codec.FamdCorruptError,
  convertFamdDirectory,
  convertFamdSource,
  createNoteCompanion,
  FAMD_ASYNC_CHARS: famdPack.FAMD_ASYNC_CHARS,
  composeFamdCompanion,
  famdEncodingForSave: v2codec.famdEncodingForSave,
  openFamdFile,
  parseFamd,
  readFamdCompanion,
  parseNoteBackups,
  parseNoteLinks,
  parseNoteTextFields,
  sameFamdPayload,
  serializeFamd,
  stripFamdPayload,
  worksheetIdsFromMarkdown,
}
