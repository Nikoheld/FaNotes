// Other classes' and rooms' timetables of the Alte Kantonsschule Aarau, read from the school's
// own PDF (one page per class). The PDF is school-internal: it is uploaded by the operator, kept
// under the Schulnetz data dir and served only to Kanti+ users linked to the Alte Kanti.
//
// Two halves:
//   parseTimetableText(text)       pure; `pdftotext -layout` output -> classes, footnotes, rooms
//   createClassTimetables({root})  stores versions on disk (source.pdf, one PDF + PNG per class,
//                                  index.json, rooms.json) and switches `current.json` atomically
//
// The parser never throws on odd input: what it cannot read is skipped and counted in `warnings`.
// Warnings carry page numbers and counts only, never PDF text.

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

export const MAX_PDF_BYTES = 25 * 1024 * 1024
export const MAX_PDF_PAGES = 200
export const KEEP_VERSIONS = 3
export const TOOL_TIMEOUT_MS = 60_000
export const PNG_DPI = 110
const LESSON_MINUTES = 45
const COLUMN_TOLERANCE = 3
const CONCURRENCY = 4

export const CLASS_CODE = /^G\d{2}[A-Z]{1,2}$/u
export const ROOM_NAME = /^[A-Za-z0-9_.\- ]{1,24}$/u
const CLASS_IN_TEXT = /\bG\d{2}[A-Z]{1,2}\b/u
const DAY_NAMES = ['montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag']
const TIME_AT_START = /^(\s*)(\d{1,2}):(\d{2})(?=\s|$)/u
const TEACHER_ONE = '[A-ZÄÖÜ][a-zäöüéè]{1,3}[A-ZÄÖÜ][a-zäöüéè]{1,3}'
const TEACHER = new RegExp(`^${TEACHER_ONE}(?:[/,]${TEACHER_ONE})*$`, 'u')
const FOOTNOTE_ONLY = /^(\d{1,2})\)$/u
const FOOTNOTE_SUFFIX = /\s+(\d{1,2})\)$/u
const FOOTNOTE_ROW = /^\s*(\d{1,2})\)?\s+([^,]+?)\s*,\s*([^,]+?)\s*,\s*(.+?)\s+(G\d{2}.*?)\s*$/u

const pad2 = (value) => String(value).padStart(2, '0')
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const hhmmOf = (minutes) => `${pad2(Math.floor(minutes / 60) % 24)}:${pad2(minutes % 60)}`

/** Text fragments of one line: runs of words joined by single spaces, with their start offsets. */
const fragmentsOf = (line) => {
  const out = []
  const pattern = /\S+(?: \S+)*/gu
  let match
  while ((match = pattern.exec(line)) !== null) out.push({ text: match[0], x: match.index })
  return out
}

/** "G26BFGKL" -> G26B, G26F, ... Known two-letter codes win over single letters. */
export const expandClassList = (text, known = new Set()) => {
  const out = []
  for (const token of String(text || '').split(/[\s,;/]+/u)) {
    const match = /^(G\d{2})([A-Z]+)$/u.exec(token)
    if (!match) continue
    const [, prefix, letters] = match
    if (letters.length <= 2) {
      out.push(token)
      continue
    }
    let index = 0
    while (index < letters.length) {
      const pair = `${prefix}${letters.slice(index, index + 2)}`
      if (index + 1 < letters.length && known.has(pair)) {
        out.push(pair)
        index += 2
      } else {
        out.push(`${prefix}${letters[index]}`)
        index += 1
      }
    }
  }
  return [...new Set(out)]
}

/** One stack of fragments (top to bottom) -> entries, anchored on the teacher short. */
const entriesOfStack = (fragments, warn) => {
  const entries = []
  const teacherAt = fragments.map((text, index) => (TEACHER.test(text) ? index : -1)).filter((index) => index >= 0)
  if (!teacherAt.length) {
    if (fragments.length > 3) warn('cell without a teacher short')
    for (let index = 0; index < fragments.length; index += 3) {
      const [subject = '', second = '', third = ''] = fragments.slice(index, index + 3)
      // One or two fragments read as subject (+ room); three without teacher as subject, ?, room.
      if (fragments.slice(index, index + 3).length === 2) entries.push({ subject, teacher: '', room: second })
      else entries.push({ subject, teacher: '', room: third, ...(second ? { teacher: second } : {}) })
    }
    return entries
  }
  let from = 0
  teacherAt.forEach((at, order) => {
    const nextTeacher = teacherAt[order + 1]
    const subject = fragments.slice(from, at).join(' ')
    let room = ''
    from = at + 1
    if (from < fragments.length && nextTeacher !== from + 1) {
      room = fragments[from]
      from += 1
    }
    entries.push({ subject, teacher: fragments[at], room })
  })
  if (from < fragments.length) warn('text after the last entry of a cell')
  return entries
}

/** The lines of one cell -> entries `{ subject, teacher, room, footnote }`. */
const entriesOfCell = (lines, warn) => {
  const notes = [] // { nr, x }
  const cleaned = lines.map((line) => {
    const kept = []
    for (const fragment of line) {
      const only = FOOTNOTE_ONLY.exec(fragment.text)
      if (only) { notes.push({ nr: only[1], x: fragment.x }); continue }
      const suffix = FOOTNOTE_SUFFIX.exec(fragment.text)
      if (suffix) {
        notes.push({ nr: suffix[1], x: fragment.x })
        kept.push({ text: fragment.text.slice(0, suffix.index), x: fragment.x })
      } else kept.push(fragment)
    }
    return kept
  }).filter((line) => line.length)

  let groups
  const wide = cleaned.find((line) => line.length > 1 && line.length === Math.max(...cleaned.map((l) => l.length)))
  if (wide) {
    // Half classes side by side: every fragment joins the sub-column whose start is nearest.
    const anchors = wide.map((fragment) => fragment.x)
    groups = anchors.map(() => [])
    for (const line of cleaned) {
      for (const fragment of line) {
        let best = 0
        anchors.forEach((anchor, index) => { if (Math.abs(anchor - fragment.x) < Math.abs(anchors[best] - fragment.x)) best = index })
        groups[best].push(fragment)
      }
    }
  } else groups = [cleaned.flat()]

  const entries = []
  const origins = []
  for (const group of groups) {
    if (!group.length) continue
    const made = entriesOfStack(group.map((fragment) => fragment.text), warn)
    made.forEach((entry) => { entries.push({ ...entry, footnote: '' }); origins.push(group[0].x) })
  }
  for (const note of notes) {
    if (!entries.length) {
      entries.push({ subject: '', teacher: '', room: '', footnote: note.nr })
      origins.push(note.x)
      continue
    }
    let best = 0
    origins.forEach((origin, index) => { if (Math.abs(origin - note.x) < Math.abs(origins[best] - note.x)) best = index })
    const target = entries.findIndex((entry, index) => !entry.footnote && origins[index] === origins[best])
    if (target >= 0) entries[target].footnote = note.nr
    else entries.push({ subject: '', teacher: '', room: '', footnote: note.nr })
  }
  return entries
}

const parsePage = (pageText, pageNumber, warn) => {
  const lines = pageText.replace(/\t/gu, '        ').split('\n').map((line) => line.replace(/\r$/u, ''))
  const head = lines.slice(0, 8)
  const codeLine = head.findIndex((line) => CLASS_IN_TEXT.test(line))
  if (codeLine < 0) { warn(`page ${pageNumber}: no class code`); return null }
  const codeMatch = CLASS_IN_TEXT.exec(head[codeLine])
  const code = codeMatch[0]
  const after = fragmentsOf(head[codeLine].slice(codeMatch.index + code.length)).map((fragment) => fragment.text)
  const teacher = after.find((text) => TEACHER.test(text)) || ''
  const semester = (/\bSJ\s*\d{4}\s*[-/]\s*\d{2,4}/u.exec(head.join('\n')) || [''])[0].replace(/\s+/gu, ' ')

  const headerIndex = lines.findIndex((line) => DAY_NAMES.every((name) => line.toLowerCase().includes(name)))
  if (headerIndex < 0) { warn(`page ${pageNumber}: no weekday header`); return null }
  const header = lines[headerIndex].toLowerCase()
  const starts = DAY_NAMES.map((name) => header.indexOf(name))
  const firstStart = starts[0]

  const footIndex = lines.findIndex((line, index) => index > headerIndex && /\bNr\.?/u.test(line) && /Kla/u.test(line))
  const gridEnd = footIndex >= 0 ? footIndex : lines.length

  // Time rows: a line that starts with a time (left of the first day column) opens a row.
  const timeOf = (line) => {
    const time = TIME_AT_START.exec(line)
    if (!time || time[1].length >= firstStart - COLUMN_TOLERANCE || Number(time[2]) > 23 || Number(time[3]) > 59) return null
    return { minutes: Number(time[2]) * 60 + Number(time[3]), length: time[0].length }
  }
  const rows = []
  let lastMinutes = -1
  for (let index = headerIndex + 1; index < gridEnd; index += 1) {
    const line = lines[index]
    const time = timeOf(line)
    if (time && time.minutes > lastMinutes) {
      lastMinutes = time.minutes
      rows.push({ start: hhmmOf(time.minutes), lines: [' '.repeat(time.length) + line.slice(time.length)] })
      continue
    }
    if (time) warn(`page ${pageNumber}: time label out of order`)
    if (!rows.length) continue
    // After the last row, a blank line ends the grid, so a footer stays out of the last cell.
    if (!line.trim() && !lines.slice(index + 1, gridEnd).some((later) => timeOf(later))) break
    rows[rows.length - 1].lines.push(line)
  }
  if (!rows.length) warn(`page ${pageNumber}: no time rows`)

  const columnOf = (x) => {
    let day = -1
    starts.forEach((start, index) => { if (x >= start - COLUMN_TOLERANCE) day = index })
    if (day >= 0) return day
    let best = 0
    starts.forEach((start, index) => { if (Math.abs(start - x) < Math.abs(starts[best] - x)) best = index })
    return best
  }

  const slots = []
  for (const row of rows) {
    const cells = Array.from({ length: 5 }, () => [])
    row.lines.forEach((line) => {
      const perDay = Array.from({ length: 5 }, () => [])
      for (const fragment of fragmentsOf(line)) {
        if (fragment.x < firstStart - COLUMN_TOLERANCE) {
          warn(`page ${pageNumber}: text left of the first day column`)
        }
        perDay[columnOf(fragment.x)].push(fragment)
      }
      perDay.forEach((fragments, day) => { if (fragments.length) cells[day].push(fragments) })
    })
    cells.forEach((cellLines, day) => {
      if (!cellLines.length) return
      let problem = false
      const entries = entriesOfCell(cellLines, () => { problem = true })
      if (problem) warn(`page ${pageNumber}: unclear cell on day ${day + 1} at ${row.start}`)
      const usable = entries.filter((entry) => entry.subject || entry.teacher || entry.room || entry.footnote)
      if (usable.length) slots.push({ day: day + 1, start: row.start, entries: usable })
    })
  }

  const footnotes = []
  if (footIndex >= 0) {
    for (const line of lines.slice(footIndex + 1)) {
      if (!line.trim()) continue
      const match = FOOTNOTE_ROW.exec(line)
      if (!match) { warn(`page ${pageNumber}: unreadable footnote row`); continue }
      footnotes.push({ nr: match[1], teacher: match[2].trim(), subject: match[3].trim(), room: match[4].trim(), classesText: match[5], page: pageNumber })
    }
  }
  return { code, teacher, page: pageNumber, slots, footnotes, semester, rowStarts: rows.map((row) => row.start) }
}

/** Room -> week entries, from the class slots and from footnote rows (which name other classes). */
const deriveRooms = (classes, footnotes, rowStartsByPage) => {
  const rooms = {}
  const seen = new Set()
  const add = (room, entry) => {
    const name = String(room || '').trim()
    if (!name) return
    const key = [name, entry.day, entry.start, entry.class, entry.subject, entry.teacher].join('\u0000')
    if (seen.has(key)) return
    seen.add(key)
    ;(rooms[name] ||= []).push(entry)
  }
  const endOf = (page, start) => {
    const starts = rowStartsByPage.get(page) || []
    const next = starts[starts.indexOf(start) + 1]
    return next || hhmmOf(minutesOf(start) + LESSON_MINUTES)
  }
  for (const entryClass of classes) {
    for (const slot of entryClass.slots) {
      const end = endOf(entryClass.page, slot.start)
      for (const entry of slot.entries) {
        if (entry.room) add(entry.room, { day: slot.day, start: slot.start, end, class: entryClass.code, subject: entry.subject, teacher: entry.teacher })
        if (!entry.footnote) continue
        for (const note of footnotes.filter((item) => item.page === entryClass.page && item.nr === entry.footnote)) {
          for (const code of note.classes) {
            add(note.room, { day: slot.day, start: slot.start, end, class: code, subject: note.subject, teacher: note.teacher })
          }
        }
      }
    }
  }
  const order = (a, b) => a.day - b.day || a.start.localeCompare(b.start) || a.class.localeCompare(b.class)
  for (const list of Object.values(rooms)) list.sort(order)
  return rooms
}

/**
 * Full `pdftotext -layout` output (pages separated by form feeds) ->
 * { semester, classes: [{ code, teacher, page, slots }], footnotes, rooms, warnings }.
 */
export const parseTimetableText = (text) => {
  const warnings = []
  const classes = []
  const footnotes = []
  const rowStartsByPage = new Map()
  let semester = ''
  const pages = String(text ?? '').split('\f')
  pages.forEach((pageText, index) => {
    if (!pageText.trim()) return
    const pageNumber = index + 1
    try {
      const page = parsePage(pageText, pageNumber, (message) => warnings.push(message))
      if (!page) return
      if (classes.some((item) => item.code === page.code)) { warnings.push(`page ${pageNumber}: class ${page.code} appears twice`); return }
      semester ||= page.semester
      classes.push({ code: page.code, teacher: page.teacher, page: page.page, slots: page.slots })
      footnotes.push(...page.footnotes)
      rowStartsByPage.set(pageNumber, page.rowStarts)
    } catch {
      warnings.push(`page ${pageNumber}: unreadable page`)
    }
  })
  const known = new Set(classes.map((item) => item.code))
  const resolved = footnotes.map(({ classesText, ...note }) => ({ ...note, classes: expandClassList(classesText, known) }))
  return { semester, classes, footnotes: resolved, rooms: deriveRooms(classes, resolved, rowStartsByPage), warnings }
}

const naturalOrder = (a, b) => a.localeCompare(b, 'de', { numeric: true })

const problem = (status, message) => Object.assign(new Error('class-timetables'), { status, publicMessage: message })
const execFileAsync = promisify(execFile)
const defaultRun = async (command, args, options = {}) => {
  const { stdout } = await execFileAsync(command, args, {
    timeout: TOOL_TIMEOUT_MS,
    maxBuffer: 128 * 1024 * 1024,
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' },
    ...options,
  })
  return { stdout }
}

/** True for a Schulnetz link of the Alte Kanti (base URL path /aksa). */
export const isAksaBase = (baseUrl) => {
  try { return /^\/aksa\/?$/iu.test(new URL(String(baseUrl || '')).pathname) } catch { return false }
}

export const createClassTimetables = (options = {}) => {
  const root = resolve(options.root || process.env.FANOTES_SCHULNETZ_DIR || '/var/lib/fanotes-schulnetz', 'timetables')
  const now = options.now || (() => new Date())
  const log = options.log || ((level, message) => console.log(`${now().toISOString()} timetables ${level} ${message}`))
  const run = options.run || defaultRun
  let tail = Promise.resolve()

  const versionDir = (version) => {
    if (!/^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}$/u.test(String(version))) return null
    return join(root, version)
  }
  const readJson = async (file) => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null }
  }
  const currentVersion = async () => {
    const pointer = await readJson(join(root, 'current.json'))
    return pointer && versionDir(pointer.version) ? pointer.version : null
  }
  const readIndex = async () => {
    const version = await currentVersion()
    if (!version) return null
    const index = await readJson(join(versionDir(version), 'index.json'))
    return index ? { ...index, version } : null
  }

  /** Public summary for the apps: no warnings, no file names. */
  const summary = async () => {
    const index = await readIndex()
    if (!index) return { available: false }
    return {
      available: true,
      uploadedAt: index.uploadedAt,
      semester: index.semester || '',
      classes: index.classes.map(({ code, teacher }) => ({ code, teacher })),
      rooms: index.rooms,
    }
  }
  const classFile = async (code, extension) => {
    if (!CLASS_CODE.test(String(code))) return null
    const index = await readIndex()
    if (!index || !index.classes.some((item) => item.code === code)) return null
    const file = join(versionDir(index.version), `${code}.${extension}`)
    return file
  }
  const classPdf = async (code) => {
    const file = await classFile(code, 'pdf')
    return file ? fs.readFile(file).catch(() => null) : null
  }
  const classPng = async (code) => {
    const file = await classFile(code, 'png')
    return file ? fs.readFile(file).catch(() => null) : null
  }
  const room = async (name) => {
    if (!ROOM_NAME.test(String(name))) return null
    const version = await currentVersion()
    if (!version) return null
    const rooms = await readJson(join(versionDir(version), 'rooms.json'))
    if (!rooms || !Object.hasOwn(rooms, name)) return null
    return { room: name, entries: rooms[name] }
  }

  const prune = async (keepVersion) => {
    const names = (await fs.readdir(root).catch(() => [])).filter((name) => versionDir(name)).sort()
    const surplus = names.slice(0, Math.max(0, names.length - KEEP_VERSIONS)).filter((name) => name !== keepVersion)
    for (const name of surplus) await fs.rm(join(root, name), { recursive: true, force: true })
  }

  const inParallel = async (items, task) => {
    let next = 0
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) await task(items[next++])
    }))
  }

  const doIngest = async (pdf) => {
    if (!Buffer.isBuffer(pdf) || pdf.length < 8) throw problem(400, 'Das ist keine PDF-Datei.')
    if (pdf.length > MAX_PDF_BYTES) throw problem(413, 'Die PDF-Datei ist zu gross (höchstens 25 MB).')
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw problem(400, 'Das ist keine PDF-Datei.')
    const at = now()
    const version = `${at.toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z')}-${randomBytes(3).toString('hex')}`
    const dir = join(root, version)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      const source = join(dir, 'source.pdf')
      await fs.writeFile(source, pdf, { mode: 0o600 })
      let text
      try {
        text = (await run('pdftotext', ['-layout', source, '-'])).stdout
      } catch {
        throw problem(422, 'Die PDF-Datei konnte nicht gelesen werden.')
      }
      const pageCount = String(text).split('\f').length - (String(text).endsWith('\f') ? 1 : 0)
      if (pageCount > MAX_PDF_PAGES) throw problem(413, 'Die PDF-Datei hat zu viele Seiten (höchstens 200).')
      const parsed = parseTimetableText(text)
      if (!parsed.classes.length) throw problem(422, 'In der PDF-Datei wurden keine Klassenseiten gefunden.')
      await inParallel(parsed.classes, async (entry) => {
        await run('qpdf', ['--empty', '--pages', source, String(entry.page), '--', join(dir, `${entry.code}.pdf`)])
        await run('pdftoppm', ['-f', String(entry.page), '-l', String(entry.page), '-r', String(PNG_DPI), '-png', '-singlefile', source, join(dir, entry.code)])
      })
      const roomNames = Object.keys(parsed.rooms).sort(naturalOrder)
      const index = {
        uploadedAt: at.toISOString(),
        semester: parsed.semester,
        classes: parsed.classes.map(({ code, teacher, page }) => ({ code, teacher, page })).sort((a, b) => naturalOrder(a.code, b.code)),
        rooms: roomNames,
        warnings: parsed.warnings,
      }
      await fs.writeFile(join(dir, 'rooms.json'), JSON.stringify(parsed.rooms), { mode: 0o600 })
      await fs.writeFile(join(dir, 'index.json'), JSON.stringify(index), { mode: 0o600 })
      // The new version is complete: switch the pointer in one rename.
      const pointer = join(root, `current.json.${randomBytes(4).toString('hex')}.tmp`)
      await fs.writeFile(pointer, JSON.stringify({ version, switchedAt: at.toISOString() }), { mode: 0o600 })
      await fs.rename(pointer, join(root, 'current.json'))
      await prune(version)
      log('info', `Stundenplan-PDF übernommen (${index.classes.length} Klassen, ${roomNames.length} Räume, ${index.warnings.length} Hinweise)`)
      return { uploadedAt: index.uploadedAt, classes: index.classes.length, rooms: roomNames.length, warnings: index.warnings }
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      if (error?.status) throw error
      log('warn', `Stundenplan-PDF abgelehnt (${error?.name || 'error'})`)
      throw problem(422, 'Die PDF-Datei konnte nicht verarbeitet werden.')
    }
  }

  /** One upload at a time; the previous version stays current until the new one is complete. */
  const ingest = (pdf) => {
    const result = tail.then(() => doIngest(pdf))
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  return { root, ingest, summary, readIndex, classPdf, classPng, room }
}
