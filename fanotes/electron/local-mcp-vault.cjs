'use strict'

// Read (and, when allowed, write) access to a FaNotes vault for the local MCP
// server. This module never imports Electron: it runs in the app's main
// process and in the stand-alone `fanotes-mcp` entry. Parsers mirror the
// renderer's (src/lib/{homeworkStore,calendarModel,flashcards}.ts and
// src/writing/*); scripts/check-local-mcp.mjs builds a vault with those same
// serializers, so a format change that breaks this reader fails CI.
//
// Safety rules:
//  - every path is a vault-relative POSIX path without `..`, `.`-prefixed
//    segments (`.fanotes`, `.git`, ...) or backslashes, and its real path must
//    stay inside the real vault root (no symlink escapes);
//  - excluded folders do not exist for the caller;
//  - only text is returned, never raw bytes of handwriting, PDFs or images;
//  - file contents are never logged.

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { germanIndexOf } = require('./german-search.cjs')

const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_WALK_ENTRIES = 30_000
const MAX_WALK_DEPTH = 24
const MAX_SEARCH_FILES = 6000
const MAX_CACHE_BYTES = 32 * 1024 * 1024
const MAX_CACHED_FILE_BYTES = 1024 * 1024
const MAX_SCAN_FILE_BYTES = 1024 * 1024
const SCAN_BYTE_BUDGET = 64 * 1024 * 1024
const SCAN_TIME_BUDGET_MS = 8000
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu
const HOMEWORK_PATH = 'Hausaufgaben.md'
const CALENDAR_PATH = 'Kalender.md'
const MANAGED_PATHS = new Set([HOMEWORK_PATH.toLowerCase(), CALENDAR_PATH.toLowerCase()])
const EXAM_WORD = /\b(klausur|prüfungen|prüfung|pruefung|examen|exam|matura|abitur)\b/iu
const KINDS = Object.freeze(['markdown', 'handwriting', 'pdf', 'story'])
const TRASH_ID = 'trashbin'

class McpError extends Error {
  constructor(message, code = 'invalid') {
    super(message)
    this.name = 'McpError'
    this.code = code
  }
}

const pad = (value) => String(value).padStart(2, '0')
const dateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const wallKey = (date) => `${dateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u

const parseDateKey = (value) => {
  const match = DATE_RE.exec(String(value))
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) || dateKey(date) !== value ? null : date
}

const parseWall = (value, allDay = false) => {
  if (typeof value !== 'string') return null
  if (allDay || DATE_RE.test(value)) return parseDateKey(value.slice(0, 10))
  const match = WALL_RE.exec(value)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]))
  return Number.isNaN(date.getTime()) ? null : date
}

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes())
const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60_000)
const addMonths = (date, months) => {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1, date.getHours(), date.getMinutes())
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  target.setDate(Math.min(date.getDate(), lastDay))
  return target
}

// ── Embedded JSON blocks (`<!-- fanotes-xyz-v1 { ... } -->`) ────────────────

const locateEmbeddedJsonComment = (source, startMarker) => {
  if (typeof source !== 'string' || !source || !startMarker) return null
  const start = source.indexOf(startMarker)
  if (start < 0) return null
  let index = start + startMarker.length
  while (index < source.length && /\s/u.test(source[index])) index += 1
  if (source[index] !== '{') return null
  const jsonStart = index
  let depth = 0
  let inString = false
  let escape = false
  for (; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escape) { escape = false; continue }
      if (char === '\\') { escape = true; continue }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const jsonEnd = index + 1
        let closer = jsonEnd
        while (closer < source.length && /\s/u.test(source[closer])) closer += 1
        if (!source.startsWith('-->', closer)) return null
        return { start, jsonStart, jsonEnd, end: closer + 3 }
      }
    }
  }
  return null
}

const MACHINE_MARKERS = ['<!-- fanotes-calendar-v1', '<!-- fanotes-homework-v1', '<!-- fanotes-cards-v1']

const stripMachine = (markdown) => {
  let text = markdown
  for (const marker of MACHINE_MARKERS) {
    for (let guard = 0; guard < 8; guard += 1) {
      const block = locateEmbeddedJsonComment(text, marker)
      if (!block) break
      text = `${text.slice(0, block.start)}${text.slice(block.end)}`
    }
  }
  return text
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]{80,}/giu, '[embedded file omitted]')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

const parseBlock = (markdown, marker) => {
  if (typeof markdown !== 'string' || !markdown.includes(marker)) return { found: false, value: null, broken: false }
  const block = locateEmbeddedJsonComment(markdown, marker)
  if (!block) return { found: true, value: null, broken: true }
  try {
    return { found: true, value: JSON.parse(markdown.slice(block.jsonStart, block.jsonEnd)), broken: false }
  } catch {
    return { found: true, value: null, broken: true }
  }
}

// ── Homework ────────────────────────────────────────────────────────────────

const HOMEWORK_MARKER = '<!-- fanotes-homework-v1'
const isIsoDate = (value) => typeof value === 'string' && parseDateKey(value) !== null
const isIsoTime = (value) => {
  const match = /^(\d{2}):(\d{2})$/u.exec(typeof value === 'string' ? value : '')
  return Boolean(match) && Number(match[1]) <= 23 && Number(match[2]) <= 59
}

const sanitizeTask = (raw) => {
  if (!raw || typeof raw !== 'object') return null
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title || title.length > 240) return null
  const now = new Date().toISOString()
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 80) : crypto.randomUUID(),
    title: title.slice(0, 240),
    notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 4000) : '',
    subject: typeof raw.subject === 'string' ? raw.subject.trim().slice(0, 80) : '',
    dueDate: isIsoDate(raw.dueDate) ? raw.dueDate : null,
    dueTime: isIsoTime(raw.dueTime) ? raw.dueTime : null,
    done: Boolean(raw.done),
    kind: raw.kind === 'appointment' ? 'appointment' : 'homework',
    priority: raw.priority === 'high' ? 'high' : 'normal',
    createdAt: typeof raw.createdAt === 'string' && Date.parse(raw.createdAt) ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' && Date.parse(raw.updatedAt) ? raw.updatedAt : now,
  }
}

/** `{ ok:false }` for a damaged block: callers must not write the file back. */
const loadHomework = (markdown) => {
  const parsed = parseBlock(markdown, HOMEWORK_MARKER)
  if (!parsed.found) return { ok: true, tasks: [], publishedIds: undefined }
  if (parsed.broken || !parsed.value || typeof parsed.value !== 'object') return { ok: false }
  const tasks = Array.isArray(parsed.value.tasks) ? parsed.value.tasks.map(sanitizeTask).filter(Boolean) : []
  const ids = Array.isArray(parsed.value.publishedIds)
    ? parsed.value.publishedIds.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim().slice(0, 80)).slice(0, 2000)
    : []
  return { ok: true, tasks, publishedIds: ids.length ? ids : undefined }
}

const serializeHomework = (document) => {
  const payload = {
    version: 1,
    tasks: document.tasks.map(sanitizeTask).filter(Boolean),
    ...(document.publishedIds?.length ? { publishedIds: document.publishedIds } : {}),
  }
  return [
    '# Hausaufgaben',
    '',
    'Diese Notiz wird von der **Hausaufgaben-Ansicht** in FaNotes verwaltet.',
    'Trage Aufgaben und Termine dort ein – sie bleiben in deinem lokalen Vault.',
    '',
    HOMEWORK_MARKER,
    JSON.stringify(payload, null, 2),
    '-->',
    '',
  ].join('\n')
}

// ── Calendar ────────────────────────────────────────────────────────────────

const CALENDAR_MARKER = '<!-- fanotes-calendar-v1'
const RECURRENCE = new Set(['none', 'daily', 'weekly', 'monthly', 'yearly'])
const cleanText = (value, max) => (typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : '')

const sanitizeCalendarDocument = (raw) => {
  const source = raw && typeof raw === 'object' ? raw : {}
  const calendars = new Map()
  ;(Array.isArray(source.calendars) ? source.calendars : []).slice(0, 24).forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return
    const name = cleanText(entry.name, 80)
    if (!name) return
    const id = cleanText(entry.id, 80) || `calendar-${index + 1}`
    calendars.set(id, { id, name })
  })
  if (!calendars.size) {
    calendars.set('personal', { id: 'personal', name: 'Persönlich' })
    calendars.set('school', { id: 'school', name: 'Schule' })
    calendars.set('work', { id: 'work', name: 'Arbeit' })
  }
  const events = []
  for (const raw of (Array.isArray(source.events) ? source.events : []).slice(0, 2000)) {
    if (!raw || typeof raw !== 'object') continue
    const title = cleanText(raw.title, 240)
    if (!title) continue
    const allDay = Boolean(raw.allDay)
    const start = parseWall(raw.start, allDay)
    const end = parseWall(raw.end, allDay)
    const calendarId = cleanText(raw.calendarId, 80)
    if (!start || !end || !calendars.has(calendarId)) continue
    const recurrence = RECURRENCE.has(raw.recurrence) ? raw.recurrence : 'none'
    events.push({
      id: cleanText(raw.id, 80) || crypto.randomUUID(),
      calendarId,
      title,
      start: allDay ? dateKey(start) : wallKey(start),
      end: allDay ? dateKey(end < start ? start : end) : wallKey(end <= start ? addMinutes(start, 30) : end),
      allDay,
      location: cleanText(raw.location, 160),
      notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 4000) : '',
      notePath: cleanText(raw.notePath, 400),
      recurrence,
      recurrenceUntil: recurrence !== 'none' && typeof raw.recurrenceUntil === 'string' && DATE_RE.test(raw.recurrenceUntil) ? raw.recurrenceUntil : null,
      exceptionDates: recurrence === 'none' || !Array.isArray(raw.exceptionDates)
        ? []
        : [...new Set(raw.exceptionDates.filter((entry) => typeof entry === 'string' && DATE_RE.test(entry)))].slice(0, 400),
    })
  }
  return { calendars: [...calendars.values()], events }
}

const loadCalendar = (markdown) => {
  const parsed = parseBlock(markdown, CALENDAR_MARKER)
  if (!parsed.found || parsed.broken) return { calendars: [], events: [] }
  return sanitizeCalendarDocument(parsed.value)
}

const eventBounds = (event) => {
  const start = parseWall(event.start, event.allDay)
  if (!start) return null
  if (event.allDay) {
    const inclusive = parseWall(event.end, true) ?? start
    return { start: startOfDay(start), end: addDays(startOfDay(inclusive), 1) }
  }
  const end = parseWall(event.end, false)
  if (!end || end.getTime() <= start.getTime()) return { start, end: addMinutes(start, 30) }
  return { start, end }
}

const instanceStart = (origin, step, frequency) => {
  if (frequency === 'weekly') return addDays(origin, step * 7)
  if (frequency === 'monthly') return addMonths(origin, step)
  if (frequency === 'yearly') return addMonths(origin, step * 12)
  return addDays(origin, step)
}

const expandOccurrences = (document, rangeStart, rangeEnd) => {
  const occurrences = []
  for (const event of document.events) {
    const bounds = eventBounds(event)
    if (!bounds) continue
    const duration = bounds.end.getTime() - bounds.start.getTime()
    if (duration <= 0) continue
    const until = event.recurrenceUntil ? parseDateKey(event.recurrenceUntil) : null
    const untilEnd = until ? addDays(startOfDay(until), 1) : null
    const skipped = new Set(event.exceptionDates)
    let step = 0
    let cursor = bounds.start
    let guard = 0
    while (cursor < rangeEnd && guard < 500) {
      if (untilEnd && cursor >= untilEnd) break
      const end = new Date(cursor.getTime() + duration)
      if (!skipped.has(dateKey(cursor)) && end > rangeStart) {
        occurrences.push({ event, start: new Date(cursor), end, key: `${event.id}@${dateKey(cursor)}` })
      }
      if (event.recurrence === 'none') break
      step += 1
      const next = instanceStart(bounds.start, step, event.recurrence)
      if (next.getTime() <= cursor.getTime()) break
      cursor = next
      guard += 1
    }
  }
  return occurrences.sort((left, right) => left.start.getTime() - right.start.getTime() || left.event.title.localeCompare(right.event.title, 'de'))
}

// ── Flashcards ──────────────────────────────────────────────────────────────

const CARDS_MARKER = '<!-- fanotes-cards-v1'
const cleanCard = (value) => value.replace(/\s+/gu, ' ').trim().slice(0, 600)

const questionBlocks = (markdown) => {
  const section = markdown.split(/^##\s+Lernfragen\s*$/imu)[1] ?? ''
  const body = section.split(/^##\s+/mu)[0] ?? ''
  const cards = []
  for (const match of body.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/giu)) {
    const front = cleanCard(match[1] ?? '')
    const back = cleanCard(match[2] ?? '')
    if (front && back) cards.push({ front, back })
  }
  if (cards.length) return cards
  for (const match of body.matchAll(/^(?:\d+\.\s+)(.+)$/gmu)) {
    const front = cleanCard(match[1] ?? '')
    if (front) cards.push({ front, back: '' })
  }
  return cards
}

const parseStoredCards = (markdown, now) => {
  const parsed = parseBlock(markdown, CARDS_MARKER)
  if (!parsed.value || !Array.isArray(parsed.value.cards)) return []
  return parsed.value.cards.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const front = typeof entry.front === 'string' ? cleanCard(entry.front) : ''
    if (!front) return []
    return [{
      id: typeof entry.id === 'string' ? entry.id.slice(0, 80) : `card-${front.slice(0, 12)}`,
      front,
      back: typeof entry.back === 'string' ? cleanCard(entry.back) : '',
      ease: typeof entry.ease === 'number' && entry.ease > 1 ? entry.ease : 2.5,
      intervalDays: typeof entry.intervalDays === 'number' && entry.intervalDays > 0 ? entry.intervalDays : 0,
      due: typeof entry.due === 'string' ? entry.due : dateKey(now),
      reps: typeof entry.reps === 'number' ? entry.reps : 0,
      lapses: typeof entry.lapses === 'number' ? entry.lapses : 0,
    }]
  }).slice(0, 400)
}

/** The note's cards: stored schedule merged with the questions in the note. */
const cardsOfMarkdown = (markdown, now) => {
  const stored = parseStoredCards(markdown, now)
  const byFront = new Map(stored.map((card) => [card.front, card]))
  const due = dateKey(now)
  const questions = questionBlocks(markdown)
  if (!questions.length) return stored
  return questions.map((question) => {
    const existing = byFront.get(question.front)
    if (existing) return { ...existing, back: question.back || existing.back }
    return { id: '', front: question.front, back: question.back, ease: 2.5, intervalDays: 0, due, reps: 0, lapses: 0 }
  })
}

// ── Stories (`Name.story/`) ─────────────────────────────────────────────────

const ID_RE = /^[0-9a-z]{6,40}$/u
const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')

const sanitizeBinder = (nodes, depth = 0) => {
  if (!Array.isArray(nodes) || depth > 16) return []
  return nodes.slice(0, 2000).flatMap((node) => {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string') return []
    const kind = ['part', 'chapter', 'scene', 'folder'].includes(node.kind) ? node.kind : null
    if (!kind) return []
    return [{
      id: node.id.slice(0, 60),
      kind,
      title: str(node.title, 300),
      synopsis: str(node.synopsis, 4000),
      status: ['idea', 'draft', 'revised', 'final'].includes(node.status) ? node.status : '',
      pov: str(node.pov, 60),
      characters: Array.isArray(node.characters) ? node.characters.filter((id) => typeof id === 'string').slice(0, 100) : [],
      places: Array.isArray(node.places) ? node.places.filter((id) => typeof id === 'string').slice(0, 100) : [],
      children: sanitizeBinder(node.children, depth + 1),
    }]
  })
}

const sceneText = (scene) => {
  if (!scene || typeof scene !== 'object' || !Array.isArray(scene.paragraphs)) return ''
  return scene.paragraphs
    .filter((paragraph) => paragraph && typeof paragraph === 'object' && !paragraph.deleted && Array.isArray(paragraph.runs))
    .map((paragraph) => paragraph.runs.map((run) => (run && typeof run.text === 'string' ? run.text : '')).join(''))
    .filter((line) => line.trim())
    .join('\n\n')
}

const walkBinder = (nodes, visit, chapter = null, trashed = false) => {
  for (const node of nodes) {
    const inTrash = trashed || node.id === TRASH_ID
    visit(node, chapter, inTrash)
    if (node.children?.length) walkBinder(node.children, visit, node.kind === 'chapter' || node.kind === 'part' ? node : chapter, inTrash)
  }
}

const countWords = (text) => (text.trim() ? text.trim().split(/\s+/u).length : 0)

// ── Vault ───────────────────────────────────────────────────────────────────

const kindOfName = (name) => {
  const lower = name.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  if (lower.endsWith('.famd')) return 'handwriting'
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.story')) return 'story'
  return null
}

const folderOf = (rel) => {
  const slash = rel.lastIndexOf('/')
  return slash > 0 ? rel.slice(0, slash) : ''
}

const titleOf = (rel, markdown) => {
  const heading = /^#\s+(.+)$/mu.exec(markdown)?.[1]?.trim()
  if (heading) return heading.slice(0, 180)
  return (rel.split('/').pop() ?? rel).replace(/\.(md|markdown|famd|pdf|story)$/iu, '')
}

const normalizeExcluded = (value) => {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\n\r,;]+/u)
  const out = []
  for (const entry of list) {
    const clean = String(entry).trim().replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
    if (clean && !clean.includes('\0') && !clean.split('/').some((segment) => segment === '..' || segment === '.')) out.push(clean.toLowerCase())
  }
  return out
}

/** Names that Windows resolves to something else (streams, devices, 8.3 aliases, trailing dot/space). */
const badSegment = (segment) => (
  !segment || segment === '.' || segment === '..' || segment.startsWith('.')
  || segment.includes(':') || /[. ]$/u.test(segment) || RESERVED_DEVICE.test(segment) || /~\d/u.test(segment)
)

const createVault = ({ root, excluded = [], now = () => new Date() }) => {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new McpError('The vault path is not set.', 'unavailable')
  const excludedList = normalizeExcluded(excluded)
  const cache = new Map()
  let cacheBytes = 0
  const cacheDrop = (key) => { const hit = cache.get(key); if (hit) { cacheBytes -= hit.size; cache.delete(key) } }
  const cachePut = (key, entry) => {
    cacheDrop(key)
    if (entry.size > MAX_CACHED_FILE_BYTES) return
    cache.set(key, entry)
    cacheBytes += entry.size
    while (cacheBytes > MAX_CACHE_BYTES && cache.size) cacheDrop(cache.keys().next().value)
  }
  let realRootPromise = null

  const realRoot = () => {
    realRootPromise ??= fsp.realpath(root).catch(() => { throw new McpError('The FaNotes vault folder is not reachable.', 'unavailable') })
    return realRootPromise
  }

  const isExcluded = (rel) => {
    const lower = rel.toLowerCase()
    return excludedList.some((entry) => lower === entry || lower.startsWith(`${entry}/`))
  }

  /** Validates a caller-supplied vault-relative path. Throws McpError. */
  const cleanPath = (value, { allowEmpty = false } = {}) => {
    if (typeof value !== 'string') throw new McpError('path must be a string.')
    if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || value.length > 1024) throw new McpError('That path is not allowed.')
    const trimmed = value.trim().replace(/^\/+/u, '').replace(/\/+$/u, '')
    if (!trimmed) {
      if (allowEmpty) return ''
      throw new McpError('path must not be empty.')
    }
    if (/^[a-z]:/iu.test(trimmed)) throw new McpError('That path is not allowed.')
    const segments = trimmed.split('/')
    if (segments.some(badSegment)) {
      throw new McpError('That path is not allowed.')
    }
    if (isExcluded(trimmed)) throw new McpError('That note was not found.', 'not_found')
    return trimmed
  }

  const resolveReal = async (rel) => {
    const rootReal = await realRoot()
    let real
    try {
      real = await fsp.realpath(path.join(rootReal, ...rel.split('/')))
    } catch {
      throw new McpError('That note was not found.', 'not_found')
    }
    // The real path must be the lexical path: any symlink on the way (even one that
    // stays inside the vault) could lead into an excluded folder or .fanotes.
    const fold = (value) => (CASE_INSENSITIVE_FS ? value.toLowerCase() : value)
    const expected = path.join(rootReal, ...rel.split('/'))
    if (fold(real) !== fold(expected)) throw new McpError('That note was not found.', 'not_found')
    const back = path.relative(rootReal, real).split(path.sep).join('/')
    if (!back || back.startsWith('..') || back.split('/').some(badSegment) || isExcluded(back)) throw new McpError('That note was not found.', 'not_found')
    return real
  }

  const readTextFile = async (rel) => {
    const real = await resolveReal(rel)
    const handle = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)).catch(() => {
      throw new McpError('That note was not found.', 'not_found')
    })
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new McpError('That note was not found.', 'not_found')
      if (info.size > MAX_FILE_BYTES) throw new McpError('That file is too large to read.', 'too_large')
      const key = rel
      const hit = cache.get(key)
      if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return { text: hit.text, info }
      const text = (await handle.readFile({ encoding: 'utf8' }))
      cachePut(key, { mtimeMs: info.mtimeMs, size: info.size, text })
      return { text, info }
    } finally {
      await handle.close().catch(() => {})
    }
  }

  const readOptional = async (rel) => {
    try {
      return await readTextFile(rel)
    } catch (error) {
      if (error instanceof McpError && error.code === 'not_found') return null
      throw error
    }
  }

  /** Every note, handwriting note, PDF and story in the vault (not excluded). */
  const walk = async () => {
    const rootReal = await realRoot()
    const out = []
    const visit = async (relDir, depth) => {
      if (depth > MAX_WALK_DEPTH || out.length >= MAX_WALK_ENTRIES) return
      let entries
      try {
        entries = await fsp.readdir(path.join(rootReal, ...(relDir ? relDir.split('/') : [])), { withFileTypes: true })
      } catch {
        return
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, 'de'))
      for (const entry of entries) {
        if (badSegment(entry.name) || entry.isSymbolicLink() || entry.name.includes('\\')) continue
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name
        if (isExcluded(rel)) continue
        const kind = kindOfName(entry.name)
        const abs = path.join(rootReal, ...rel.split('/'))
        if (entry.isDirectory()) {
          if (kind === 'story') {
            const info = await fsp.stat(path.join(abs, 'story.json')).catch(() => null)
            out.push({ path: rel, kind: 'story', size: info?.size ?? 0, mtimeMs: info?.mtimeMs ?? 0 })
          } else {
            await visit(rel, depth + 1)
          }
        } else if (entry.isFile() && kind && kind !== 'story') {
          const info = await fsp.stat(abs).catch(() => null)
          if (info) out.push({ path: rel, kind, size: info.size, mtimeMs: info.mtimeMs })
        }
        if (out.length >= MAX_WALK_ENTRIES) return
      }
    }
    await visit('', 0)
    // A .famd beside a .md of the same name is that note's sidecar (page statistics, older builds also kept a text copy),
    // not a second note: the pair is listed once, as the Markdown note.
    const markdownStems = new Set(out.filter((entry) => entry.kind === 'markdown').map((entry) => entry.path.replace(/\.(md|markdown)$/iu, '').toLowerCase()))
    return out.filter((entry) => entry.kind !== 'handwriting' || !markdownStems.has(entry.path.replace(/\.famd$/iu, '').toLowerCase()))
  }

  const iso = (mtimeMs) => (mtimeMs ? new Date(mtimeMs).toISOString() : null)

  // ── notes ──

  const famdMarkdown = (text) => {
    try {
      // eslint-disable-next-line global-require
      const famd = require('./famd.cjs')
      const parsed = famd.parseFamd(text)
      const fields = (parsed.payload?.textFields ?? [])
        .map((field) => (typeof field?.text === 'string' ? field.text.trim() : ''))
        .filter(Boolean)
      return fields.length ? `${parsed.markdown}\n\n${fields.join('\n\n')}` : parsed.markdown
    } catch {
      const cut = text.search(/\n<!--\s*fanotes-famd:/u)
      return cut >= 0 ? text.slice(0, cut) : text
    }
  }

  const pdfPages = async (rel) => {
    const name = `${crypto.createHash('sha256').update(rel).digest('hex').slice(0, 32)}.json`
    const sidecar = path.join(await realRoot(), '.fanotes', 'page-text', name)
    try {
      const info = await fsp.lstat(sidecar)
      if (!info.isFile() || info.size > 4 * 1024 * 1024) return null
      const record = JSON.parse(await fsp.readFile(sidecar, 'utf8'))
      if (record?.format !== 'fanotes-page-text-v1' || record.path !== rel || !Array.isArray(record.pages)) return null
      return record.pages
        .filter((page) => page && Number.isSafeInteger(page.page) && typeof page.text === 'string' && page.status === 'ok')
        .sort((left, right) => left.page - right.page)
        .map((page) => ({ page: page.page, text: page.text.slice(0, 6000) }))
    } catch {
      return null
    }
  }

  /** The text of one note. Returns null when the path is a story folder. */
  const noteContent = async (rel) => {
    const kind = kindOfName(rel)
    if (!kind || kind === 'story') throw new McpError('That path is not a note. Use read_story for stories.')
    if (kind === 'pdf') {
      const real = await resolveReal(rel)
      const info = await fsp.stat(real)
      if (!info.isFile()) throw new McpError('That note was not found.', 'not_found')
      const pages = await pdfPages(rel)
      const text = pages?.length ? pages.map((page) => `--- page ${page.page} ---\n${page.text}`).join('\n\n') : ''
      const stem = rel.replace(/\.pdf$/iu, '')
      const companions = []
      for (const extension of ['.famd', '.md']) {
        if (await fsp.stat(await resolveReal(`${stem}${extension}`).catch(() => '')).then((stat) => stat.isFile()).catch(() => false)) {
          if (!isExcluded(`${stem}${extension}`)) companions.push(`${stem}${extension}`)
        }
      }
      return {
        kind,
        modifiedAt: iso(info.mtimeMs),
        text: stripMachine(text),
        note: pages?.length ? undefined : 'No extracted text is stored for this PDF yet. FaNotes stores it after the PDF was opened or searched in the app.',
        companions,
      }
    }
    const { text, info } = await readTextFile(rel)
    return { kind, modifiedAt: iso(info.mtimeMs), text: stripMachine(kind === 'handwriting' ? famdMarkdown(text) : text) }
  }

  const listNotes = async ({ folder = '', since = null, kind = null, limit = 100, offset = 0, sort = 'modified' } = {}) => {
    const base = folder ? cleanPath(folder, { allowEmpty: true }) : ''
    const sinceMs = since ? Date.parse(since) : null
    if (since && !Number.isFinite(sinceMs)) throw new McpError('since must be an ISO date or date-time.')
    if (kind && !KINDS.includes(kind)) throw new McpError(`kind must be one of ${KINDS.join(', ')}.`)
    const all = (await walk()).filter((entry) => (
      (!base || entry.path.toLowerCase().startsWith(`${base.toLowerCase()}/`) || entry.path.toLowerCase() === base.toLowerCase())
      && (!kind || entry.kind === kind)
      && (sinceMs === null || entry.mtimeMs >= sinceMs)
      && !MANAGED_PATHS.has(entry.path.toLowerCase())
    ))
    all.sort(sort === 'path' ? (a, b) => a.path.localeCompare(b.path, 'de') : (a, b) => b.mtimeMs - a.mtimeMs)
    const rows = all.slice(offset, offset + limit).map((entry) => ({
      path: entry.path,
      title: titleOf(entry.path, ''),
      kind: entry.kind,
      folder: folderOf(entry.path),
      modifiedAt: iso(entry.mtimeMs),
      bytes: entry.size,
    }))
    return { total: all.length, offset, notes: rows }
  }

  const listFolders = async () => {
    const entries = await walk()
    const folders = new Map()
    for (const entry of entries) {
      let dir = folderOf(entry.path)
      while (dir) {
        const row = folders.get(dir) ?? { path: dir, notes: 0, latest: 0 }
        if (dir === folderOf(entry.path)) row.notes += 1
        row.latest = Math.max(row.latest, entry.mtimeMs)
        folders.set(dir, row)
        dir = folderOf(dir)
      }
    }
    const rows = [...folders.values()].sort((a, b) => a.path.localeCompare(b.path, 'de'))
    return {
      subjects: rows.filter((row) => !row.path.includes('/')).map((row) => row.path),
      rootNotes: entries.filter((entry) => !entry.path.includes('/')).length,
      folders: rows.map((row) => ({ path: row.path, notesDirectlyInside: row.notes, modifiedAt: iso(row.latest) })),
    }
  }

  // ── search ──

  const storyCorpus = async (rel) => {
    const story = await readStory(rel, { text: true, maxChars: 60_000 }).catch(() => null)
    if (!story) return ''
    return [
      story.title,
      ...story.outline.flatMap((scene) => [scene.chapter, scene.title, scene.synopsis, scene.text ?? '']),
      ...story.bible.map((entry) => `${entry.name} ${entry.role ?? ''} ${entry.notes ?? ''} ${entry.fields.map((field) => `${field.label}: ${field.value}`).join(' ')}`),
    ].filter(Boolean).join('\n')
  }

  const corpusOf = async (entry) => {
    if (entry.kind === 'story') return storyCorpus(entry.path)
    return (await noteContent(entry.path)).text
  }

  /** Bytes and time one scan over many notes may spend; a scan stops (partial results) when spent. */
  const scanBudget = () => {
    const started = Date.now()
    let bytes = 0
    return {
      exhausted: (next = 0) => {
        bytes += next
        return bytes > SCAN_BYTE_BUDGET || Date.now() - started > SCAN_TIME_BUDGET_MS
      },
    }
  }

  const searchNotes = async ({ query, folder = '', kind = null, limit = 20 } = {}) => {
    const words = String(query ?? '').toLocaleLowerCase('de').split(/\s+/u).filter(Boolean).slice(0, 8)
    if (!words.length) throw new McpError('query must not be empty.')
    const candidates = (await listNotes({ folder, kind, limit: MAX_SEARCH_FILES, sort: 'modified' })).notes
    const hits = []
    const budget = scanBudget()
    let truncated = false
    let skippedLarge = 0
    for (const candidate of candidates) {
      if (candidate.kind !== 'story' && candidate.bytes > MAX_SCAN_FILE_BYTES) { skippedLarge += 1; continue }
      if (budget.exhausted(candidate.bytes)) { truncated = true; break }
      let text
      try {
        text = await corpusOf(candidate)
      } catch {
        continue
      }
      const lower = text.toLocaleLowerCase('de')
      const title = candidate.title.toLocaleLowerCase('de')
      let score = 0
      let first = -1
      let all = true
      for (const word of words) {
        const index = germanIndexOf(lower, word)
        if (index < 0 && germanIndexOf(title, word) < 0) { all = false; break }
        if (index >= 0 && (first < 0 || index < first)) first = index
        if (germanIndexOf(title, word) >= 0) score += 5
        score += index >= 0 ? 1 : 0
      }
      if (!all) continue
      const start = Math.max(0, first < 0 ? 0 : first - 80)
      hits.push({
        score,
        path: candidate.path,
        title: candidate.title,
        kind: candidate.kind,
        modifiedAt: candidate.modifiedAt,
        excerpt: text.slice(start, start + 260).replace(/\s+/gu, ' ').trim(),
      })
    }
    hits.sort((a, b) => b.score - a.score || String(b.modifiedAt).localeCompare(String(a.modifiedAt)))
    return { query: String(query), matches: hits.slice(0, limit).map(({ score, ...rest }) => rest), searched: candidates.length - skippedLarge, truncated: truncated || skippedLarge > 0, skippedLarge }
  }

  // ── tasks / calendar / exams / flashcards ──

  const homeworkDocument = async () => {
    const file = isExcluded(HOMEWORK_PATH) ? null : await readOptional(HOMEWORK_PATH)
    if (!file) return { ok: true, tasks: [], file: null }
    return { ...loadHomework(file.text), file }
  }

  const listTasks = async ({ includeDone = false, subject = '', kind = null, dueBefore = null, dueAfter = null, overdue = false, limit = 100 } = {}) => {
    const document = await homeworkDocument()
    if (!document.ok) throw new McpError('Hausaufgaben.md is damaged; FaNotes will not interpret it.', 'unavailable')
    const today = dateKey(now())
    const wantSubject = String(subject).trim().toLocaleLowerCase('de')
    const rows = document.tasks
      .filter((task) => (includeDone || !task.done)
        && (!wantSubject || task.subject.toLocaleLowerCase('de') === wantSubject)
        && (!kind || task.kind === kind)
        && (!dueBefore || (task.dueDate !== null && task.dueDate <= dueBefore))
        && (!dueAfter || (task.dueDate !== null && task.dueDate >= dueAfter))
        && (!overdue || (!task.done && task.dueDate !== null && task.dueDate < today)))
      .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || (a.dueTime ?? '').localeCompare(b.dueTime ?? ''))
    return {
      today,
      total: rows.length,
      tasks: rows.slice(0, limit).map((task) => ({
        id: task.id,
        title: task.title,
        subject: task.subject,
        dueDate: task.dueDate,
        dueTime: task.dueTime,
        done: task.done,
        kind: task.kind,
        priority: task.priority,
        notes: task.notes,
        overdue: !task.done && task.dueDate !== null && task.dueDate < today,
      })),
    }
  }

  const calendarEvents = async (from, to) => {
    const file = isExcluded(CALENDAR_PATH) ? null : await readOptional(CALENDAR_PATH)
    if (!file) return []
    const document = loadCalendar(file.text)
    const names = new Map(document.calendars.map((calendar) => [calendar.id, calendar.name]))
    return expandOccurrences(document, from, to).map((occurrence) => ({
      title: occurrence.event.title,
      start: occurrence.event.start,
      end: occurrence.event.end,
      allDay: occurrence.event.allDay,
      calendar: names.get(occurrence.event.calendarId) ?? '',
      location: occurrence.event.location,
      notes: occurrence.event.notes,
      notePath: occurrence.event.notePath && !isExcluded(occurrence.event.notePath) ? occurrence.event.notePath : '',
      recurrence: occurrence.event.recurrence,
      occurrence: occurrence.key,
    }))
  }

  const rangeOf = ({ from, to } = {}) => {
    const today = startOfDay(now())
    const start = from ? parseDateKey(from) : today
    const end = to ? parseDateKey(to) : addDays(today, 370)
    if (!start || !end || end.getTime() <= start.getTime()) throw new McpError('from and to must be YYYY-MM-DD dates with from before to.')
    if (end.getTime() - start.getTime() > 800 * 86_400_000) throw new McpError('The date range is too long (at most 800 days).')
    return { start, end }
  }

  const listCalendar = async (args = {}) => {
    const { start, end } = rangeOf(args)
    return { from: dateKey(start), to: dateKey(end), events: await calendarEvents(start, end) }
  }

  const listExams = async (args = {}) => {
    const { start, end } = rangeOf(args)
    const events = (await calendarEvents(start, end)).filter((event) => EXAM_WORD.test(event.title) || EXAM_WORD.test(event.calendar))
    const document = await homeworkDocument()
    const homework = (document.ok ? document.tasks : [])
      .filter((task) => task.dueDate && EXAM_WORD.test(`${task.title} ${task.subject}`))
      .map((task) => ({ id: task.id, title: task.title, subject: task.subject, dueDate: task.dueDate, dueTime: task.dueTime, done: task.done }))
    const mentioned = []
    if (args.includeNotes !== false) {
      const budget = scanBudget()
      for (const entry of (await walk()).filter((item) => item.kind === 'markdown' || item.kind === 'handwriting')) {
        if (MANAGED_PATHS.has(entry.path.toLowerCase()) || entry.size > MAX_SCAN_FILE_BYTES) continue
        if (budget.exhausted(entry.size)) break
        let text
        try { text = (await noteContent(entry.path)).text } catch { continue }
        for (const line of text.split('\n')) {
          if (EXAM_WORD.test(line) && /\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{2,4}/u.test(line)) {
            mentioned.push({ path: entry.path, line: line.trim().slice(0, 240) })
            if (mentioned.length >= 40) break
          }
        }
        if (mentioned.length >= 40) break
      }
    }
    return { from: dateKey(start), to: dateKey(end), exams: events, homework, mentionedInNotes: mentioned }
  }

  const flashcardDecks = async () => {
    const decks = []
    const today = dateKey(now())
    const budget = scanBudget()
    for (const entry of (await walk()).filter((item) => item.kind === 'markdown' && item.size <= MAX_SCAN_FILE_BYTES)) {
      if (MANAGED_PATHS.has(entry.path.toLowerCase())) continue
      if (budget.exhausted(entry.size)) break
      let text
      try { text = (await readTextFile(entry.path)).text } catch { continue }
      if (!text.includes('fanotes-cards-v1') && !/^##\s+Lernfragen\s*$/imu.test(text)) continue
      const cards = cardsOfMarkdown(text, now())
      if (!cards.length) continue
      decks.push({ path: entry.path, title: titleOf(entry.path, text), cards: cards.length, due: cards.filter((card) => card.due <= today).length })
    }
    return { today, decks }
  }

  const listFlashcards = async ({ path: notePath = '', dueOnly = false, limit = 40 } = {}) => {
    const today = dateKey(now())
    const paths = notePath ? [cleanPath(notePath)] : (await flashcardDecks()).decks.map((deck) => deck.path)
    const cards = []
    for (const rel of paths) {
      const { text } = await readTextFile(rel)
      for (const card of cardsOfMarkdown(text, now())) {
        if (dueOnly && card.due > today) continue
        cards.push({ path: rel, front: card.front, back: card.back, due: card.due, reps: card.reps, lapses: card.lapses })
        if (cards.length >= limit) return { today, cards }
      }
    }
    return { today, cards }
  }

  // ── stories ──

  const storyFile = async (rel, relative) => {
    const file = await readOptional(`${rel}/${relative}`)
    if (!file) return null
    try { return JSON.parse(file.text) } catch { return null }
  }

  const listStories = async () => {
    const stories = []
    for (const entry of (await walk()).filter((item) => item.kind === 'story')) {
      const manifest = await storyFile(entry.path, 'story.json')
      stories.push({
        path: entry.path,
        title: str(manifest?.title, 300) || titleOf(entry.path, ''),
        author: str(manifest?.author, 200),
        language: str(manifest?.language, 10),
        modifiedAt: iso(entry.mtimeMs),
      })
    }
    return { stories }
  }

  const readStory = async (rel, { text = true, scene = '', maxChars = 60_000 } = {}) => {
    if (!rel.toLowerCase().endsWith('.story')) throw new McpError('That path is not a story (*.story).')
    const manifest = await storyFile(rel, 'story.json')
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.binder)) throw new McpError('That story was not found or is not complete on this device.', 'not_found')
    const binder = sanitizeBinder(manifest.binder)
    const outline = []
    let budget = maxChars
    const nodes = []
    walkBinder(binder, (node, chapter, trashed) => { if (node.kind === 'scene' && !trashed) nodes.push({ node, chapter }) })
    for (const { node, chapter } of nodes) {
      const row = { sceneId: node.id, chapter: chapter?.title ?? '', title: node.title, synopsis: node.synopsis, status: node.status, characters: node.characters, places: node.places }
      const wanted = ID_RE.test(node.id) && (scene ? node.id === scene : text)
      if (wanted) {
        const body = sceneText(await storyFile(rel, `scenes/${node.id}.json`))
        row.words = countWords(body)
        if (budget > 0) {
          row.text = body.slice(0, budget)
          budget -= row.text.length
          if (row.text.length < body.length) row.truncated = true
        } else if (body) row.truncated = true
      }
      if (!scene || node.id === scene) outline.push(row)
    }
    const bible = []
    for (const [folder, kind] of [['characters', 'character'], ['places', 'place'], ['events', 'event']]) {
      let names = []
      try {
        names = await fsp.readdir(path.join(await resolveReal(rel), 'bible', folder))
      } catch { /* no entries of this kind */ }
      for (const name of names.filter((item) => /^[0-9a-z]{6,40}\.json$/u.test(item)).sort().slice(0, 300)) {
        const entry = await storyFile(rel, `bible/${folder}/${name}`)
        if (!entry || typeof entry !== 'object' || entry.archived === true) continue
        bible.push({
          kind,
          id: name.slice(0, -5),
          name: str(entry.name, 300),
          role: str(entry.role, 300),
          aliases: Array.isArray(entry.aliases) ? entry.aliases.filter((alias) => typeof alias === 'string').slice(0, 20) : [],
          when: str(entry.when, 300),
          notes: str(entry.notes, 6000),
          fields: Array.isArray(entry.fields)
            ? entry.fields.slice(0, 40).flatMap((field) => (field && typeof field === 'object' ? [{ label: str(field.label, 200), value: str(field.value, 4000) }] : []))
            : [],
        })
      }
    }
    return {
      path: rel,
      title: str(manifest.title, 300),
      subtitle: str(manifest.subtitle, 300),
      author: str(manifest.author, 200),
      language: str(manifest.language, 10),
      goals: manifest.goals && typeof manifest.goals === 'object' ? manifest.goals : undefined,
      updatedAt: str(manifest.updatedAt, 40),
      outline,
      bible: scene ? [] : bible,
    }
  }

  // ── activity & stats ──

  const recentActivity = async ({ limit = 20, since = null } = {}) => {
    const listing = await listNotes({ since, limit, sort: 'modified' })
    return { total: listing.total, recent: listing.notes }
  }

  const vaultStats = async () => {
    const entries = (await walk()).filter((entry) => !MANAGED_PATHS.has(entry.path.toLowerCase()))
    const counts = Object.fromEntries(KINDS.map((kind) => [kind, entries.filter((entry) => entry.kind === kind).length]))
    const tasks = await listTasks({ limit: 1000 }).catch(() => null)
    const week = await listCalendar({ to: dateKey(addDays(startOfDay(now()), 8)) }).catch(() => null)
    return {
      notes: entries.length,
      byKind: counts,
      folders: new Set(entries.map((entry) => folderOf(entry.path)).filter(Boolean)).size,
      newest: iso(Math.max(0, ...entries.map((entry) => entry.mtimeMs))),
      openTasks: tasks?.total ?? 0,
      overdueTasks: tasks?.tasks.filter((task) => task.overdue).length ?? 0,
      eventsNext7Days: week?.events.length ?? 0,
      excludedFolders: excludedList.length,
    }
  }

  // ── writes ──

  const writeTemp = async (target, data, mode) => {
    const temp = path.join(path.dirname(target), `.fanotes-${process.pid}.${crypto.randomBytes(10).toString('hex')}.tmp`)
    const handle = await fsp.open(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), mode)
    try {
      await handle.writeFile(data, { encoding: 'utf8' })
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => {})
      await fsp.rm(temp, { force: true }).catch(() => {})
      throw error
    }
    await handle.close()
    return temp
  }

  /** Creates a file that must not exist yet (hard link: fails if the target appeared meanwhile). */
  const publishNew = async (target, data) => {
    const temp = await writeTemp(target, data, 0o644)
    try {
      try {
        await fsp.link(temp, target)
      } catch (error) {
        if (error?.code === 'EEXIST') throw new McpError('A note with that path already exists.', 'exists')
        if (error?.code !== 'EPERM' && error?.code !== 'ENOTSUP' && error?.code !== 'EXDEV') throw error
        // Filesystems without hard links: exclusive create is still race-free.
        const handle = await fsp.open(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644).catch((openError) => {
          if (openError?.code === 'EEXIST') throw new McpError('A note with that path already exists.', 'exists')
          throw openError
        })
        try { await handle.writeFile(data, { encoding: 'utf8' }); await handle.sync() } finally { await handle.close() }
      }
    } finally {
      await fsp.rm(temp, { force: true }).catch(() => {})
    }
  }

  /** Replaces a file only if it still has the size and mtime that were read. */
  const replaceIfUnchanged = async (rel, expected, data) => {
    const real = await resolveReal(rel)
    const temp = await writeTemp(real, data, expected.mode & 0o777)
    try {
      const current = await fsp.stat(real)
      if (current.mtimeMs !== expected.mtimeMs || current.size !== expected.size || current.ino !== expected.ino) {
        throw new McpError('The note changed while it was being updated. Nothing was written; try again.', 'conflict')
      }
      await fsp.rename(temp, real)
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => {})
      throw error
    }
    cacheDrop(rel)
  }

  const writablePath = (value, { allowManaged = false } = {}) => {
    const rel = cleanPath(value)
    if (rel.length > 240 || /[<>:"|?*\u0000-\u001f]/u.test(rel)) throw new McpError('That path is not allowed.')
    if (rel.split('/').some((segment) => segment.toLowerCase().endsWith('.story'))) throw new McpError('Story projects are not writable through MCP.')
    if (!/\.(md|markdown)$/iu.test(rel)) throw new McpError('Only Markdown notes (.md) can be written.')
    if (!allowManaged && MANAGED_PATHS.has(rel.toLowerCase())) throw new McpError('That note is managed by a FaNotes view. Use add_task or complete_task instead.')
    return rel
  }

  const createNote = async ({ path: value, content }) => {
    const rel = writablePath(value)
    if (typeof content !== 'string' || content.length > 500_000) throw new McpError('content must be a string of at most 500000 characters.')
    const rootReal = await realRoot()
    const segments = rel.split('/')
    let cursor = rootReal
    for (const segment of segments.slice(0, -1)) {
      cursor = path.join(cursor, segment)
      const info = await fsp.lstat(cursor).catch(() => null)
      if (!info) await fsp.mkdir(cursor, { mode: 0o755 }).catch((error) => { if (error?.code !== 'EEXIST') throw error })
      const stat = await fsp.lstat(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new McpError('That path is not allowed.')
    }
    await publishNew(path.join(rootReal, ...segments), content.endsWith('\n') ? content : `${content}\n`)
    cacheDrop(rel)
    return { path: rel, created: true }
  }

  const appendToNote = async ({ path: value, text }) => {
    const rel = writablePath(value)
    if (typeof text !== 'string' || !text.trim() || text.length > 200_000) throw new McpError('text must be a non-empty string of at most 200000 characters.')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { text: current, info } = await readTextFile(rel)
      const next = `${current.replace(/\s+$/u, '')}${current.trim() ? '\n\n' : ''}${text.trim()}\n`
      if (Buffer.byteLength(next, 'utf8') > MAX_FILE_BYTES) throw new McpError('The note would become too large.', 'too_large')
      try {
        await replaceIfUnchanged(rel, info, next)
        return { path: rel, appended: true }
      } catch (error) {
        if (!(error instanceof McpError) || error.code !== 'conflict' || attempt === 2) throw error
      }
    }
    throw new McpError('The note changed while it was being updated.', 'conflict')
  }

  const mutateHomework = async (mutate) => {
    if (isExcluded(HOMEWORK_PATH)) throw new McpError('The task list is excluded from AI access.', 'not_found')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const file = await readOptional(HOMEWORK_PATH)
      const loaded = file ? loadHomework(file.text) : { ok: true, tasks: [], publishedIds: undefined }
      if (!loaded.ok) throw new McpError('Hausaufgaben.md is damaged; FaNotes will not overwrite it.', 'unavailable')
      const result = mutate(loaded)
      const data = serializeHomework({ tasks: loaded.tasks, publishedIds: loaded.publishedIds })
      try {
        if (file) await replaceIfUnchanged(HOMEWORK_PATH, file.info, data)
        else await publishNew(path.join(await realRoot(), HOMEWORK_PATH), data)
        cacheDrop(HOMEWORK_PATH)
        return result
      } catch (error) {
        const retry = error instanceof McpError && (error.code === 'conflict' || error.code === 'exists')
        if (!retry || attempt === 2) throw error
      }
    }
    throw new McpError('The task list changed while it was being updated.', 'conflict')
  }

  const addTask = async (args) => {
    const title = cleanText(args.title, 240)
    if (!title) throw new McpError('title must not be empty.')
    if (args.dueDate && !isIsoDate(args.dueDate)) throw new McpError('dueDate must be YYYY-MM-DD.')
    if (args.dueTime && !isIsoTime(args.dueTime)) throw new McpError('dueTime must be HH:mm.')
    const stamp = new Date().toISOString()
    const task = sanitizeTask({
      id: crypto.randomUUID(),
      title,
      notes: args.notes ?? '',
      subject: args.subject ?? '',
      dueDate: args.dueDate ?? null,
      dueTime: args.dueTime ?? null,
      done: false,
      kind: args.kind,
      priority: args.priority,
      createdAt: stamp,
      updatedAt: stamp,
    })
    await mutateHomework((document) => { document.tasks.push(task) })
    return { added: true, task }
  }

  const completeTask = async ({ id = '', title = '', done = true }) => {
    const wantId = String(id).trim()
    const wantTitle = String(title).trim().toLocaleLowerCase('de')
    if (!wantId && !wantTitle) throw new McpError('Give the task id (from list_tasks) or its exact title.')
    return mutateHomework((document) => {
      const matches = document.tasks.filter((task) => (wantId ? task.id === wantId : task.title.toLocaleLowerCase('de') === wantTitle && task.done !== Boolean(done)))
      if (!matches.length) throw new McpError('No matching task was found.', 'not_found')
      if (matches.length > 1) throw new McpError('More than one task matches. Use the id from list_tasks.')
      matches[0].done = Boolean(done)
      matches[0].updatedAt = new Date().toISOString()
      return { id: matches[0].id, title: matches[0].title, done: matches[0].done }
    })
  }

  return {
    cleanPath,
    cacheBytes: () => cacheBytes,
    isExcluded,
    noteContent,
    listNotes,
    listFolders,
    searchNotes,
    listTasks,
    listCalendar,
    listExams,
    flashcardDecks,
    listFlashcards,
    listStories,
    readStory,
    recentActivity,
    vaultStats,
    createNote,
    appendToNote,
    addTask,
    completeTask,
    titleOf,
    walk,
  }
}

module.exports = { createVault, McpError, normalizeExcluded, KINDS, HOMEWORK_PATH, CALENDAR_PATH, locateEmbeddedJsonComment, stripMachine, loadHomework, serializeHomework }
