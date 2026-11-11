// Other classes' and rooms' timetables of the Alte Kantonsschule Aarau, read from the school's
// own PDF (one page per class). The PDF is school-internal: it is uploaded by the operator, kept
// under the Schulnetz data dir and served only to Kanti+ users linked to the Alte Kanti.
//
// Two halves:
//   parseTimetableBbox(xhtml)      pure; `pdftotext -bbox-layout` output -> classes, footnotes, rooms
//   createClassTimetables({root})  stores versions on disk (source.pdf, one PDF + PNG per class,
//                                  index.json, rooms.json) and switches `current.json` atomically
//
// The parser never throws on odd input: what it cannot read is skipped and counted in `warnings`.
// Warnings carry counts only, never PDF text.
//
// The parser works on word coordinates, not on text lines: a cell's text is vertically centred in
// its box (a single lesson on its time label, a double lesson between two labels), so lines of the
// layout text land in the wrong row.

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
const CONCURRENCY = 4

export const CLASS_CODE = /^[A-Z]\d{2}[A-Z]{1,3}$/u
export const ROOM_NAME = /^[A-Za-z0-9_.\- ]{1,24}$/u
const DAY_NAMES = ['montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag']
const TIME_LABEL = /^(\d{1,2}):(\d{2})$/u
const TEACHER_ONE = '[A-ZÄÖÜ][a-zäöüéè]{1,3}[A-ZÄÖÜ][a-zäöüéè]{1,3}'
const TEACHER = new RegExp(`^${TEACHER_ONE}(?:[/,]${TEACHER_ONE})*$`, 'u')
const MARKER = /^(\d{1,2})\)$/u
const CLASS_START = /^[A-Z]\d{2}[A-Z]/u
const SEMESTER = /^\d{4}[-/]\d{2,4}$/u

// Geometry tolerances in PDF points (tuned on the real PDF: text 6 pt, line pitch 6.5 pt, row pitch ~42 pt).
const WORD_GAP = 3 // words closer than this are one item ("Amos 1.2"); real word gaps are ~1.4, entry gaps >= 5
const LINE_TOLERANCE = 1 // words whose tops differ by less than this share a baseline
const TRACK_TOLERANCE = 3 // items whose left edges differ by less than this are in one vertical track
const STACK_GAP = 4 // vertical gap above which a track starts a new stack (line gaps are < 1.5, stack gaps > 13)
const PLACE_TOLERANCE = 0.3 // a stack centre must be within this many row pitches of a lesson centre
const MAX_LESSON_ROWS = 4
const DEFAULT_PITCH = 42

const pad2 = (value) => String(value).padStart(2, '0')
const hhmmOf = (minutes) => `${pad2(Math.floor(minutes / 60) % 24)}:${pad2(minutes % 60)}`

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decodeEntities = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name) => {
  const lower = name.toLowerCase()
  if (Object.hasOwn(ENTITIES, lower)) return ENTITIES[lower]
  const code = lower[0] === '#' ? Number.parseInt(lower[1] === 'x' ? lower.slice(2) : lower.slice(1), lower[1] === 'x' ? 16 : 10) : NaN
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
})

/** `pdftotext -bbox-layout` XHTML -> [{ width, height, words: [{ x0, y0, x1, y1, text }] }]. */
export const readBboxPages = (xhtml) => {
  const pages = []
  const pattern = /<page\b([^>]*)>|<word\b([^>]*)>([^<]*)<\/word>/gu
  const attrs = (text) => Object.fromEntries([...text.matchAll(/(\w+)="([^"]*)"/gu)].map(([, key, value]) => [key, Number(value)]))
  let match
  while ((match = pattern.exec(String(xhtml ?? ''))) !== null) {
    if (match[1] !== undefined) {
      const { width, height } = attrs(match[1])
      pages.push({ width, height, words: [] })
      continue
    }
    const page = pages.at(-1)
    if (!page) continue
    const { xMin, yMin, xMax, yMax } = attrs(match[2])
    const text = decodeEntities(match[3]).trim()
    if (!text || ![xMin, yMin, xMax, yMax].every(Number.isFinite)) continue
    page.words.push({ x0: xMin, y0: yMin, x1: xMax, y1: yMax, text })
  }
  return pages
}

/**
 * "G26ABI" -> G26A, G26B, G26I: the first letter+digit is the prefix, the digit after it the
 * year, the letters classes; every further digit switches the year ("G23DL4B4D" -> G23D, G23L,
 * G24B, G24D). Known (real) class codes win for letter pairs ("G26FM" stays one class if known).
 * A trailing ".." means the PDF cut the list off.
 */
export const expandClassListInfo = (text, known = new Set()) => {
  const out = []
  let truncated = false
  for (let token of String(text || '').split(/[\s,;/]+/u)) {
    if (/(?:\.\.|…)$/u.test(token)) { truncated = true; token = token.replace(/(?:\.\.|…)+$/u, '') }
    // Scan: "G26" starts a prefix+year, a lone digit switches the year, letters are classes.
    let prefix = ''
    let year = ''
    let index = 0
    while (index < token.length) {
      const rest = token.slice(index)
      const start = /^([A-Z]\d)(\d)(?=[A-Z]|$)/u.exec(rest)
      if (start) { [, prefix, year] = start; index += 3; continue }
      if (/^\d/u.test(rest)) { year = rest[0]; index += 1; continue }
      if (!prefix || !year || !/^[A-Z]/u.test(rest)) { index += 1; continue }
      const letters = rest.match(/^[A-Z]+/u)[0]
      const size = [3, 2].find((length) => length <= letters.length && known.has(`${prefix}${year}${letters.slice(0, length)}`)) || 1
      out.push(`${prefix}${year}${letters.slice(0, size)}`)
      index += size
    }
  }
  return { classes: [...new Set(out)], truncated }
}
export const expandClassList = (text, known = new Set()) => expandClassListInfo(text, known).classes

/** Words of one page -> items: words on one baseline closer than WORD_GAP join ("Amos 1.2"). */
const itemsOf = (words) => {
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
  const lines = []
  for (const word of sorted) {
    const line = lines.find((candidate) => Math.abs(candidate.y0 - word.y0) < LINE_TOLERANCE)
    if (line) line.words.push(word)
    else lines.push({ y0: word.y0, words: [word] })
  }
  const items = []
  for (const line of lines) {
    line.words.sort((a, b) => a.x0 - b.x0)
    for (const word of line.words) {
      const last = items.at(-1)
      if (last && last.line === line && word.x0 - last.x1 < WORD_GAP) {
        last.text += ` ${word.text}`
        last.x1 = Math.max(last.x1, word.x1)
        last.y1 = Math.max(last.y1, word.y1)
      } else items.push({ line, x0: word.x0, x1: word.x1, y0: word.y0, y1: word.y1, text: word.text })
    }
  }
  return items
}

/** Lines of one stack (top to bottom) -> entries anchored on the teacher short (subject above, room below). */
const entriesOfStack = (lines) => {
  const entries = []
  const make = (subjectLines, teacherLine, roomLine) => {
    const all = [...subjectLines, ...(teacherLine ? [teacherLine] : []), ...(roomLine ? [roomLine] : [])]
    entries.push({
      subject: subjectLines.map((line) => line.text).join(' '),
      teacher: teacherLine ? teacherLine.text : '',
      room: roomLine ? roomLine.text : '',
      x0: Math.min(...all.map((line) => line.x0)),
      x1: Math.max(...all.map((line) => line.x1)),
      y0: Math.min(...all.map((line) => line.y0)),
      y1: Math.max(...all.map((line) => line.y1)),
      footnote: [],
    })
  }
  const isTeacher = (index) => index < lines.length && TEACHER.test(lines[index].text)
  let from = 0
  let index = 0
  while (index < lines.length) {
    if (!isTeacher(index)) { index += 1; continue }
    // Lines before the teacher that no entry owns yet: the last one is this subject, earlier ones stand alone.
    for (let alone = from; alone < index - 1; alone += 1) make([lines[alone]], null, null)
    const subject = index - 1 >= from ? [lines[index - 1]] : []
    // The line after the teacher is the room unless it is the next entry's subject (a teacher follows it).
    const hasRoom = index + 1 < lines.length && !isTeacher(index + 1) && !isTeacher(index + 2)
    make(subject, lines[index], hasRoom ? lines[index + 1] : null)
    index += hasRoom ? 2 : 1
    from = index
  }
  // Left-over lines without a teacher: "subject" or "subject, room".
  const rest = lines.slice(from)
  if (rest.length === 2) make([rest[0]], null, rest[1])
  else rest.forEach((line) => make([line], null, null))
  return entries
}

/** Row labels of a page -> { start, end } of a stack, by comparing the stack centre with lesson centres. */
const placeStack = (stack, labels, pitch) => {
  const centre = (stack.y0 + stack.y1) / 2
  const height = stack.y1 - stack.y0
  let best = null
  for (let rows = 1; rows <= Math.min(MAX_LESSON_ROWS, labels.length); rows += 1) {
    if (rows > 1 && height > rows * pitch) continue
    for (let first = 0; first + rows <= labels.length; first += 1) {
      const middle = (labels[first].y + labels[first + rows - 1].y) / 2
      const distance = Math.abs(middle - centre)
      // A stack taller than one lesson cannot be a single lesson: it must fill its rows plausibly.
      if (rows === 1 && height > pitch * 1.05) continue
      if (!best || distance < best.distance - 0.01) best = { distance, first, rows }
    }
  }
  if (!best || best.distance > pitch * PLACE_TOLERANCE) return null
  return { first: labels[best.first], last: labels[best.first + best.rows - 1] }
}

/** Splits the footnote table (below the `Nr.` header line) into footnote rows. */
const footnoteRowsOf = (words, headerY, warnStat) => {
  const header = words.filter((word) => Math.abs(word.y0 - headerY) < 2)
  const nrColumns = header.filter((word) => word.text === 'Nr.').sort((a, b) => a.x0 - b.x0)
  const rows = []
  // A footnote that does not fit a column continues at the top of the next one.
  let current = null
  let currentNr = ''
  nrColumns.forEach((nr, group) => {
    const end = nrColumns[group + 1] ? nrColumns[group + 1].x0 - 2 : Infinity
    const inGroup = (word) => word.x0 >= nr.x0 - 3 && word.x0 < end
    const middle = header.find((word) => /^Le\./u.test(word.text) && inGroup(word))
    const midX = middle ? middle.x0 : nr.x0 + 12
    const lines = []
    for (const word of words.filter((candidate) => candidate.y0 > headerY + 2 && inGroup(candidate)).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
      const line = lines.find((candidate) => Math.abs(candidate.y0 - word.y0) < 2)
      if (line) line.words.push(word)
      else lines.push({ y0: word.y0, words: [word] })
    }
    for (const line of lines) {
      line.words.sort((a, b) => a.x0 - b.x0)
      const numberWord = line.words.find((word) => word.x0 < midX - 2 && MARKER.test(word.text))
      // The class list starts at the first word shaped like a class ("G26A..."): long room lists run
      // past the `Kla.` header, so the header's x position cannot split the row.
      const body = line.words.filter((word) => word.x0 >= midX - 2 && word !== numberWord)
      const classAt = body.findIndex((word) => CLASS_START.test(word.text))
      const middleText = (classAt < 0 ? body : body.slice(0, classAt)).map((word) => word.text).join(' ')
      const classText = classAt < 0 ? '' : body.slice(classAt).map((word) => word.text).join(' ')
      if (numberWord) currentNr = MARKER.exec(numberWord.text)[1]
      if (middleText || numberWord) {
        if (!currentNr) { warnStat('footnoteRows'); continue }
        current = { nr: currentNr, middle: middleText, classes: classText }
        rows.push(current)
      } else if (classText && current) current.classes += ` ${classText}`
      else if (classText) warnStat('footnoteRows')
    }
  })
  return rows
}

const footnoteOf = (row, page, known) => {
  const parts = row.middle.split(',').map((part) => part.trim()).filter(Boolean)
  let teacher = ''
  let subject = ''
  let room = ''
  if (parts.length === 1) [subject] = parts
  else if (parts.length === 2) {
    if (TEACHER.test(parts[0])) [teacher, subject] = parts
    else [subject, room] = parts
  } else if (parts.length >= 3) [teacher, subject, room] = [parts[0], parts[1], parts.slice(2).join(', ')]
  const { classes, truncated } = expandClassListInfo(row.classes, known)
  return { nr: row.nr, teacher, subject, room, classes, ...(truncated ? { classesTruncated: true } : {}), page }
}

const parsePage = (pdfPage, pageNumber, stats) => {
  const { words } = pdfPage
  const header = DAY_NAMES.map((name) => words.filter((word) => word.text.toLowerCase() === name).sort((a, b) => a.y0 - b.y0)[0])
  if (header.some((word) => !word)) { stats.pagesWithoutHeader += 1; return null }
  const headerBottom = Math.max(...header.map((word) => word.y1))
  const centres = header.map((word) => (word.x0 + word.x1) / 2)
  const spacing = (centres[4] - centres[0]) / 4
  if (!(spacing > 10) || centres.some((value, index) => index > 0 && value <= centres[index - 1]) || Math.abs(header[0].y0 - header[4].y0) > 4) {
    stats.pagesWithoutHeader += 1
    return null
  }
  const bounds = [centres[0] - spacing / 2, ...centres.slice(1).map((value, index) => (value + centres[index]) / 2), centres[4] + spacing / 2]
  const columnOf = (x) => {
    for (let day = 4; day >= 0; day -= 1) if (x >= bounds[day]) return day
    return 0
  }

  const codeWord = words.filter((word) => word.y1 <= headerBottom && CLASS_CODE.test(word.text)).sort((a, b) => b.x0 - a.x0)[0]
  if (!codeWord) { stats.pagesWithoutCode += 1; return null }
  const teacher = words
    .filter((word) => word !== codeWord && word.x0 >= codeWord.x1 - 0.1 && word.y1 <= headerBottom && (word.y0 + word.y1) / 2 >= codeWord.y0 && (word.y0 + word.y1) / 2 <= codeWord.y1)
    .sort((a, b) => a.x0 - b.x0).map((word) => word.text).join(' ').slice(0, 80)
  const top = words.filter((word) => word.y1 <= headerBottom).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
  const sj = top.findIndex((word, index) => word.text === 'SJ' && top[index + 1] && SEMESTER.test(top[index + 1].text))
  const semester = sj >= 0 ? `SJ ${top[sj + 1].text}` : ''

  const footHeader = words.filter((word) => word.text === 'Nr.' && word.y0 > headerBottom).sort((a, b) => a.y0 - b.y0)[0]
  const footY = footHeader ? footHeader.y0 : Infinity
  const labels = words
    .filter((word) => word.x0 < bounds[0] && word.y0 > headerBottom && word.y0 < footY && TIME_LABEL.test(word.text))
    .map((word) => {
      const [, hours, minutes] = TIME_LABEL.exec(word.text)
      return { y: (word.y0 + word.y1) / 2, minutes: Number(hours) * 60 + Number(minutes) }
    })
    .filter((label) => label.minutes < 24 * 60)
    .sort((a, b) => a.y - b.y)
  if (!labels.length) { stats.pagesWithoutHeader += 1; return null }
  const pitch = labels.length > 1 ? (labels.at(-1).y - labels[0].y) / (labels.length - 1) : DEFAULT_PITCH
  const gridBottom = Math.min(footY, labels.at(-1).y + pitch)

  const grid = words.filter((word) => word.y0 > headerBottom && word.y1 <= gridBottom + 1 && word.x0 >= bounds[0] - 1)
  const markerWords = []
  const textWords = []
  for (const word of grid) (MARKER.test(word.text) ? markerWords : textWords).push(word)
  const items = itemsOf(textWords).map((item) => ({ ...item, day: columnOf(item.x0 + 1) }))

  // Vertical tracks (same left edge) -> stacks of consecutive lines -> entries.
  const stacks = []
  for (let day = 0; day < 5; day += 1) {
    const inColumn = items.filter((item) => item.day === day).sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0)
    const tracks = []
    for (const item of inColumn) {
      const track = tracks.at(-1)
      if (track && item.x0 - track.at(-1).x0 < TRACK_TOLERANCE) track.push(item)
      else tracks.push([item])
    }
    for (const track of tracks) {
      track.sort((a, b) => a.y0 - b.y0)
      let lines = []
      const flush = () => {
        if (lines.length) {
          stacks.push({
            day, lines, x0: Math.min(...lines.map((line) => line.x0)),
            y0: Math.min(...lines.map((line) => line.y0)), y1: Math.max(...lines.map((line) => line.y1)),
          })
        }
        lines = []
      }
      for (const item of track) {
        if (lines.length && item.y0 - Math.max(...lines.map((line) => line.y1)) > STACK_GAP) flush()
        lines.push(item)
      }
      flush()
    }
  }

  const slotMap = new Map()
  const placed = []
  for (const stack of stacks) {
    const rows = placeStack(stack, labels, pitch)
    if (!rows) { stats.stacksNotPlaced += 1; continue }
    const start = hhmmOf(rows.first.minutes)
    const end = hhmmOf(rows.last.minutes + LESSON_MINUTES)
    const key = `${stack.day}|${start}|${end}`
    if (!slotMap.has(key)) slotMap.set(key, { day: stack.day + 1, start, end, entries: [], startMinutes: rows.first.minutes })
    const slot = slotMap.get(key)
    for (const entry of entriesOfStack(stack.lines)) {
      entry.slot = slot
      entry.day = stack.day
      slot.entries.push(entry)
      placed.push(entry)
    }
  }

  // Footnote markers sit right of a cell in the same day column: take the entry whose lines contain the
  // marker's height (the one just left of the marker if several), else the vertically nearest one.
  const markers = markerWords.map((word) => ({ nr: MARKER.exec(word.text)[1], x0: word.x0, y: (word.y0 + word.y1) / 2, day: columnOf(word.x0 + 1) }))
  for (const marker of markers) {
    const candidates = placed.filter((entry) => entry.day === marker.day)
    if (!candidates.length) { stats.markersNotPlaced += 1; continue }
    const distance = (entry) => (marker.y < entry.y0 ? entry.y0 - marker.y : marker.y > entry.y1 ? marker.y - entry.y1 : 0)
    const near = Math.min(...candidates.map(distance))
    const level = candidates.filter((entry) => distance(entry) <= near + 0.5)
    const left = level.filter((entry) => entry.x1 <= marker.x0 + 2).sort((a, b) => b.x1 - a.x1)
    const target = left[0] || level.sort((a, b) => Math.abs(a.x1 - marker.x0) - Math.abs(b.x1 - marker.x0))[0]
    target.footnote.push(marker.nr)
  }

  const slots = [...slotMap.values()].sort((a, b) => a.day - b.day || a.startMinutes - b.startMinutes || a.end.localeCompare(b.end))
  for (const slot of slots) {
    slot.entries.sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0)
    slot.entries = slot.entries.map(({ subject, teacher: entryTeacher, room, footnote }) => ({ subject, teacher: entryTeacher, room, footnote: [...new Set(footnote)].join(',') }))
    delete slot.startMinutes
  }

  let footnoteRows = []
  if (footHeader) {
    const table = words.filter((word) => word.y0 >= footY - 2)
    footnoteRows = footnoteRowsOf(table, footY, (name) => { stats[name] += 1 })
  }
  return { code: codeWord.text, teacher, page: pageNumber, slots, footnoteRows, semester }
}

/** Room -> week entries: class pages (one entry per class) and footnote rows (which name other classes). */
const deriveRooms = (classes, footnotes) => {
  const byRoom = new Map()
  const add = (room, day, start, end, classCodes, subject, teacher) => {
    const name = String(room || '').trim()
    if (!name || !ROOM_NAME.test(name) || Object.hasOwn(Object.prototype, name)) return
    const rooms = byRoom.get(name) || new Map()
    byRoom.set(name, rooms)
    const key = [day, start, subject, teacher].join('\u0000')
    const found = rooms.get(key) || { day, start, end, classes: new Set(), subject, teacher }
    rooms.set(key, found)
    if (end > found.end) found.end = end
    classCodes.forEach((code) => found.classes.add(code))
  }
  for (const entryClass of classes) {
    for (const slot of entryClass.slots) {
      for (const entry of slot.entries) {
        add(entry.room, slot.day, slot.start, slot.end, [entryClass.code], entry.subject, entry.teacher)
        for (const nr of entry.footnote ? entry.footnote.split(',') : []) {
          for (const note of footnotes.filter((item) => item.page === entryClass.page && item.nr === nr)) {
            add(note.room, slot.day, slot.start, slot.end, note.classes, note.subject, note.teacher)
          }
        }
      }
    }
  }
  const rooms = {}
  const natural = (a, b) => a.localeCompare(b, 'de', { numeric: true })
  for (const [name, entries] of byRoom) {
    rooms[name] = [...entries.values()]
      .flatMap(({ classes, ...rest }) => [...classes].map((code) => ({ ...rest, class: code })))
      .sort((a, b) => a.day - b.day || a.start.localeCompare(b.start) || natural(a.class, b.class))
  }
  return rooms
}

/**
 * Full `pdftotext -bbox-layout` XHTML ->
 * { semester, classes: [{ code, teacher, page, slots: [{ day, start, end, entries }] }], footnotes, rooms, warnings, stats }.
 * Never throws; warnings and stats carry counts and page numbers only, never PDF text.
 */
export const parseTimetableBbox = (xhtml) => {
  const stats = { pages: 0, pagesWithoutHeader: 0, pagesWithoutCode: 0, stacksNotPlaced: 0, markersNotPlaced: 0, unknownMarkers: 0, footnoteRows: 0, duplicatePages: 0, unreadablePages: 0 }
  const classes = []
  const rawNotes = []
  let semester = ''
  let pages = []
  try { pages = readBboxPages(xhtml) } catch { pages = [] }
  pages.forEach((pdfPage, index) => {
    stats.pages += 1
    try {
      const page = parsePage(pdfPage, index + 1, stats)
      if (!page) return
      if (classes.some((item) => item.code === page.code)) { stats.duplicatePages += 1; return }
      semester ||= page.semester
      classes.push({ code: page.code, teacher: page.teacher, page: page.page, slots: page.slots })
      rawNotes.push(...page.footnoteRows.map((row) => ({ row, page: page.page })))
    } catch {
      stats.unreadablePages += 1
    }
  })
  const known = new Set(classes.map((item) => item.code))
  const footnotes = rawNotes.map(({ row, page }) => footnoteOf(row, page, known))
  for (const entryClass of classes) {
    for (const slot of entryClass.slots) {
      for (const entry of slot.entries) {
        for (const nr of entry.footnote ? entry.footnote.split(',') : []) {
          if (!footnotes.some((note) => note.page === entryClass.page && note.nr === nr)) stats.unknownMarkers += 1
        }
      }
    }
  }
  const counted = [
    [stats.pagesWithoutHeader, 'pages without a weekday header or time rows'],
    [stats.pagesWithoutCode, 'pages without a class code'],
    [stats.duplicatePages, 'pages repeating a class'],
    [stats.unreadablePages, 'unreadable pages'],
    [stats.stacksNotPlaced, 'entries not placed in a lesson'],
    [stats.markersNotPlaced, 'footnote markers without an entry'],
    [stats.unknownMarkers, 'footnote markers without a footnote row'],
    [stats.footnoteRows, 'unreadable footnote rows'],
  ]
  const warnings = counted.filter(([count]) => count > 0).map(([count, what]) => `${count} ${what}`)
  return { semester, classes, footnotes, rooms: deriveRooms(classes, footnotes), warnings, stats }
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
        text = (await run('pdftotext', ['-bbox-layout', source, '-'])).stdout
      } catch {
        throw problem(422, 'Die PDF-Datei konnte nicht gelesen werden.')
      }
      const pageCount = (String(text).match(/<page\b/gu) || []).length
      if (pageCount > MAX_PDF_PAGES) throw problem(413, 'Die PDF-Datei hat zu viele Seiten (höchstens 200).')
      const parsed = parseTimetableBbox(text)
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
