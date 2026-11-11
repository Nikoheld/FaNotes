// Pure Schulnetz parsing, grade maths, diffing and the read-only allow-list.
// The phone app has the same rules in android/core/.../schulnetz. Keep the
// change-id formula identical: category:entityId:key.

import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

const PASS = 4

export const REST_GET = new Set([
  '/rest/v1/me',
  '/rest/v1/me/grades',
  '/rest/v1/me/events',
  '/rest/v1/me/exams',
  '/rest/v1/me/absences',
  '/rest/v1/me/absencenotices',
  '/rest/v1/me/vacations',
  '/rest/v1/me/notes/homework',
  '/rest/v1/me/notes/objectives',
  '/rest/v1/me/notifications/push',
  '/rest/v1/me/notifications/topics',
  '/rest/v1/me/courses',
  '/rest/v1/me/certificates/grades',
  '/rest/v1/me/lateness',
  '/rest/v1/config/settings',
  '/rest/v1/config/lists/absencenoticestatus',
])

const READ_PAGES = new Set(['1', '21311', '21111', '21411', '22202', '22108', '21312', '21200', '22206', '1000', '1001', '1012'])
const BLOCKED_PAGES = ['23118', '23100', '23104', '23102', '23182', '23150', '23156', '9999']

export const numKey = (value) => {
  if (value == null || Number.isNaN(Number(value))) return ''
  const rounded = Math.round(Number(value) * 1000) / 1000
  return String(rounded)
}

export const parseMark = (raw) => {
  const cleaned = String(raw ?? '').trim().replace(/\s/g, '').replace(',', '.')
  if (!cleaned || cleaned === '-' || cleaned.toLowerCase() === 'null') return null
  const value = Number(cleaned)
  if (!Number.isFinite(value) || value < 1 || value > 6) return null
  return value
}

export const parseWeight = (raw) => {
  const value = Number(String(raw ?? '').trim().replace(',', '.'))
  if (!Number.isFinite(value) || value <= 0 || value > 100) return 1
  return value
}

const text = (obj, ...keys) => {
  for (const key of keys) {
    const value = obj?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'boolean') return value ? 'true' : 'false'
  }
  return ''
}

const flag = (obj, ...keys) => {
  for (const key of keys) {
    const value = obj?.[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true'
  }
  return false
}

const list = (payload) => {
  if (!payload) return []
  const root = typeof payload === 'string' ? JSON.parse(payload) : payload
  if (Array.isArray(root)) return root.filter((item) => item && typeof item === 'object')
  if (!root || typeof root !== 'object') return []
  for (const key of ['data', 'items', 'results', 'grades', 'events', 'exams', 'absences', 'homework', 'notifications', 'vacations', 'messages', 'value', 'lateness']) {
    if (Array.isArray(root[key])) return root[key].filter((item) => item && typeof item === 'object')
  }
  if (root.mark != null || root.startDate || root.dateFrom || root.title || root.id) return [root]
  return []
}

const safeList = (payload) => {
  if (payload == null || payload === '') return []
  try { return list(payload) } catch { return [] }
}

const stableId = (prefix, ...parts) => {
  let hash = 2166136261
  const basis = parts.join('|')
  for (const char of basis) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return `${prefix}-${(hash >>> 0).toString(16)}`
}

const strings = (obj, ...keys) => {
  for (const key of keys) {
    const value = obj?.[key]
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (typeof item === 'string') return item.trim()
        if (item && typeof item === 'object') return text(item, 'name', 'token', 'id')
        return ''
      }).filter(Boolean)
    }
    if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean)
  }
  return []
}

export const parseRawSnapshot = (raw, fetchedAt = '') => ({
  revision: 0,
  fetchedAt,
  profile: parseProfile(raw.me),
  grades: safeList(raw.grades).map(parseGrade).filter(Boolean).filter((grade) => !isSummaryGrade(grade)),
  events: safeList(raw.events).map(parseEvent).filter(Boolean),
  exams: safeList(raw.exams).map(parseEvent).filter(Boolean),
  absences: [...safeList(raw.absences).map(parseAbsence).filter(Boolean), ...safeList(raw.lateness).map(parseLate).filter(Boolean)],
  homework: safeList(raw.homework).map(parseHomework).filter(Boolean),
  messages: parseMessages(raw.messages),
  vacations: safeList(raw.vacations).map(parseVacation).filter(Boolean),
  konto: parseKontoauszug(raw.kontoHtml || ''),
  kontoSaldo: parseKontoSaldo(raw.kontoHtml || ''),
  startMessages: parseStartMessages(raw.startHtml || ''),
})

const parseProfile = (payload) => {
  if (!payload) return null
  let obj
  try { obj = typeof payload === 'string' ? JSON.parse(payload) : payload } catch { return null }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const classes = Array.isArray(obj.regularClasses) ? obj.regularClasses : []
  const profile = {
    id: text(obj, 'id', 'idNr'),
    firstName: text(obj, 'firstName', 'firstname', 'vorname'),
    lastName: text(obj, 'lastName', 'lastname', 'name'),
    className: text(classes[0] || {}, 'className', 'name', 'classId'),
    email: text(obj, 'email'),
  }
  const display = [profile.firstName, profile.lastName].filter(Boolean).join(' ')
  return display || profile.id ? profile : null
}

const parseGrade = (obj) => {
  const course = text(obj, 'course', 'courseName', 'kurs')
  const subject = text(obj, 'subject', 'fach')
  const title = text(obj, 'title', 'name', 'description')
  const date = text(obj, 'date', 'examDate').slice(0, 10)
  const mark = parseMark(text(obj, 'mark', 'grade', 'note'))
  if (!course && !subject && !title && mark == null) return null
  if (isSummaryGradeTitle(title)) return null
  return {
    id: text(obj, 'id') || stableId('grade', course, subject, title, date, numKey(mark)),
    course,
    courseId: text(obj, 'courseId', 'courseToken'),
    subject,
    title,
    date,
    mark,
    weight: parseWeight(text(obj, 'weight', 'gewichtung')),
    confirmed: flag(obj, 'isConfirmed', 'confirmed'),
    courseGrade: parseMark(text(obj, 'courseGrade', 'classGrade', 'average')),
    comment: text(obj, 'comment', 'remark'),
  }
}

const parseEvent = (obj) => {
  const start = text(obj, 'startDate', 'start', 'from')
  const label = text(obj, 'text', 'title', 'name')
  const courseName = text(obj, 'courseName', 'course', 'subject')
  if (!start && !label && !courseName) return null
  const end = text(obj, 'endDate', 'end', 'to') || start
  return {
    id: text(obj, 'id') || stableId('event', start, end, label, courseName),
    start,
    end,
    text: label,
    comment: text(obj, 'comment'),
    room: text(obj, 'roomToken', 'room', 'roomName'),
    teachers: strings(obj, 'teachers', 'teacher'),
    courseId: text(obj, 'courseId', 'courseToken'),
    courseName,
    status: text(obj, 'status'),
    eventType: text(obj, 'eventType', 'type'),
    color: text(obj, 'color'),
    timetableText: text(obj, 'timetableText'),
    // Lesson marks (lessonMarker) when a client sends them; absent stays absent (seedLessonMarks).
    ...(Object.hasOwn(obj || {}, 'marker') ? { marker: text(obj, 'marker') } : {}),
    ...(text(obj, 'substitute') ? { substitute: text(obj, 'substitute') } : {}),
  }
}

const parseAbsence = (obj) => {
  const dateFrom = text(obj, 'dateFrom', 'date', 'from')
  const subject = text(obj, 'subject', 'course', 'courseName')
  const reason = text(obj, 'reason', 'comment')
  if (!dateFrom && !subject && !reason) return null
  return {
    id: text(obj, 'id') || stableId('absence', dateFrom, subject, reason),
    dateFrom: dateFrom.slice(0, 10),
    dateTo: (text(obj, 'dateTo', 'to') || dateFrom).slice(0, 10),
    hourFrom: text(obj, 'hourFrom', 'fromTime'),
    hourTo: text(obj, 'hourTo', 'toTime'),
    subject,
    reason,
    excused: flag(obj, 'isExcused', 'excused'),
    acknowledged: flag(obj, 'isAcknowledged', 'acknowledged'),
    status: text(obj, 'statusEAE', 'status') || text(obj, 'statusEAB'),
    excuseUntil: text(obj, 'excuseUntil', 'excuseDeadline', 'deadline', 'entschuldigenBis'),
  }
}

const parseLate = (obj) => {
  const date = text(obj, 'date').slice(0, 10)
  if (!date) return null
  const excused = flag(obj, 'excused')
  return {
    id: text(obj, 'id') || stableId('late', date, text(obj, 'courseToken')),
    dateFrom: date,
    dateTo: date,
    hourFrom: text(obj, 'startTime'),
    hourTo: text(obj, 'endTime'),
    subject: text(obj, 'courseToken', 'courseId'),
    reason: text(obj, 'reason') || 'Verspätung',
    excused,
    acknowledged: excused,
    status: excused ? 'entschuldigt' : 'offen',
    excuseUntil: text(obj, 'excuseUntil', 'excuseDeadline', 'deadline'),
  }
}

const parseHomework = (obj) => {
  const title = text(obj, 'title', 'name', 'text')
  if (!title) return null
  return {
    id: text(obj, 'id') || stableId('hw', title, text(obj, 'dueDate')),
    title,
    description: text(obj, 'description', 'comment', 'notes'),
    dueDate: text(obj, 'dueDate', 'date').slice(0, 10),
    courseId: text(obj, 'courseId'),
    courseName: text(obj, 'courseName', 'course', 'subject'),
  }
}

const parseMessages = (payload) => {
  if (!payload) return []
  let root
  try { root = typeof payload === 'string' ? JSON.parse(payload) : payload } catch { return [] }
  if (Array.isArray(root) && root.every((item) => typeof item === 'string')) {
    return root.map((item) => item.trim()).filter(Boolean).map((body) => ({ id: stableId('msg', body), title: 'Mitteilung', body, at: '' }))
  }
  return safeList(root).map((obj) => {
    const body = text(obj, 'body', 'message', 'text', 'content', 'description')
    const title = text(obj, 'title', 'subject', 'name')
    if (!body && !title) return null
    return { id: text(obj, 'id') || stableId('msg', title, body), title, body: body || title, at: text(obj, 'date', 'createdAt', 'at', 'timestamp') }
  }).filter(Boolean)
}

const parseVacation = (obj) => {
  const name = text(obj, 'name', 'title', 'text')
  const start = text(obj, 'startDate', 'start', 'from', 'dateFrom')
  if (!name && !start) return null
  return { id: text(obj, 'id') || stableId('vac', name, start), name: name || 'Ferien', start, end: text(obj, 'endDate', 'end', 'to', 'dateTo') }
}

const htmlText = (raw) => String(raw)
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim()

/**
 * Schulnetz page 21411 leaves <tr>/<td> unclosed, so rows are split on the opening tags.
 * Text after the closing </table> (for example the "confirm balance" action link) is never read.
 */
const kontoRows = (html) => {
  const cleaned = String(html || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  const rows = []
  for (const chunk of cleaned.split(/<tr\b/i).slice(1)) {
    const body = chunk.split(/<\/table\b/i)[0].replace(/^[^>]*>/, '')
    const cells = body.split(/<t[dh]\b[^>]*>/i).slice(1).map(htmlText).filter(Boolean)
    if (cells.length) rows.push(cells)
  }
  return rows
}

export const parseKontoauszug = (html) => {
  if (!html) return []
  const lines = []
  for (const cells of kontoRows(html)) {
    if (cells.length < 3 || !/\d{1,2}\.\d{1,2}\.\d{2,4}/.test(cells[0])) continue
    lines.push({ date: cells[0], label: cells[1], amount: cells[2], balance: cells[3] || '' })
  }
  return lines
}

/** Final "Saldo" row of the statement (for example "5.40 CHF"), or ''. */
export const parseKontoSaldo = (html) => {
  if (!html) return ''
  let saldo = ''
  for (const cells of kontoRows(html)) {
    if (cells.length >= 2 && /^saldo:?$/i.test(cells[0])) saldo = cells[cells.length - 1]
  }
  return saldo
}

export const parseStartMessages = (html) => {
  if (!html) return []
  const cleaned = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  const found = []
  const pattern = /<(div|article|li|p)\b[^>]*class="[^"]*(mitteilung|message|news|ankündigung|ankuendigung|cls-start)[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi
  for (const match of cleaned.matchAll(pattern)) {
    const line = htmlText(match[3])
    if (line.length >= 3 && line.length <= 500 && !found.includes(line)) found.push(line)
  }
  return found.slice(0, 20)
}

const cancelledBlob = (event) => `${event.status} ${event.eventType} ${event.text} ${event.comment} ${event.timetableText}`.toLowerCase()

export const isCancelled = (event) => ['cancel', 'cancelled', 'canceled', 'abgesagt', 'fällt', 'faellt', 'entfällt', 'entfaellt', 'ausgefallen', 'cancellation', 'annull']
  .some((word) => cancelledBlob(event).includes(word))

export const isSubstitution = (event) => Boolean(cleanSchulnetzText(event?.substitute)) || ['substitution', 'vertretung', 'suppl', 'supply', 'stellvertretung']
  .some((word) => cancelledBlob(event).includes(word))

const cdataWrapped = /^<!\[CDATA\[([\s\S]*)\]\]>$/iu

/** Schulnetz wraps scheduler fields in CDATA. The brackets are not part of the value. */
export const unwrapSchulnetz = (raw) => {
  let value = String(raw || '').trim()
  let match = cdataWrapped.exec(value)
  while (match) {
    value = match[1].trim()
    match = cdataWrapped.exec(value)
  }
  return value
}

/** Drop CDATA markup, including a wrapper that sits inside a longer field. */
export const cleanSchulnetzText = (raw) => {
  let value = unwrapSchulnetz(raw)
  let previous = ''
  while (value !== previous) {
    previous = value
    value = value.replace(/<!\[CDATA\[/iu, '').replace(/\]\]>/u, '')
  }
  return value.replace(/\s+/gu, ' ').trim()
}

/** A real HH:mm. The T inside `<![CDATA[` is not a time, and a date alone is not 00:00. */
export const schulnetzClock = (raw) => {
  const match = /(?:^|[\sT])([01]\d|2[0-3]):([0-5]\d)\b/u.exec(cleanSchulnetzText(raw))
  return match ? `${match[1]}:${match[2]}` : ''
}

export const eventDayKey = (raw) => {
  const text = cleanSchulnetzText(raw)
  const iso = /(\d{4}-\d{2}-\d{2})/u.exec(text)
  if (iso) return iso[1]
  const swiss = /(\d{1,2})\.(\d{1,2})\.(\d{4})/u.exec(text)
  if (!swiss) return ''
  return `${swiss[3]}-${swiss[2].padStart(2, '0')}-${swiss[1].padStart(2, '0')}`
}

/** Clock text for a notification. Midnight is shown only when the event also ends at a later time. */
export const displayClock = (start, end = '') => {
  const from = schulnetzClock(start)
  const to = schulnetzClock(end)
  if (!from || (from === '00:00' && (!to || to === '00:00'))) return ''
  if (!to || to === from) return from
  return `${from}–${to}`
}

const realClock = (raw) => {
  const clock = schulnetzClock(raw)
  return clock === '00:00' ? '' : clock
}

const pruefungCode = /(?:^|_)pru(?:fung)?$/iu
const examToken = /(?:^|[^a-zäöü])test(?:[^a-zäöü]|$)/iu
const examLeadRegex = /^(?:prüfung|pruefung|klausur|test)\b/iu

/** Scheduler codes such as `1_pru`, plus the words exam, Prüfung, Klausur, and Test. */
export const examMarker = (raw) => {
  const kind = cleanSchulnetzText(raw).toLowerCase()
  if (!kind) return false
  if (kind === '1_pru' || pruefungCode.test(kind)) return true
  if (kind.includes('prüfung') || kind.includes('pruefung') || kind.includes('klausur') || kind.includes('exam')) return true
  return examToken.test(kind)
}

/** A leading Test/Prüfung/Klausur on a title. Lesetest and other longer words do not match. */
export const examLead = (raw) => {
  const line = cleanSchulnetzText(raw).split(/\r?\n/u).find((part) => part.trim()) || ''
  return examLeadRegex.test(line.trim())
}

export const canonicalEventType = (raw) => {
  const kind = cleanSchulnetzText(raw)
  if (!kind) return 'lesson'
  if (examMarker(kind)) return 'exam'
  return kind
}

export const isExamLike = (event) => examMarker(event?.eventType) || examLead(event?.text) || examLead(event?.timetableText)

export const isLesson = (event) => {
  if (isExamLike(event)) return false
  const kind = cleanSchulnetzText(event?.eventType).toLowerCase()
  if (!kind || kind === '0_stp') return true
  return kind.includes('lesson') || kind.includes('unterricht') || kind.includes('timetable') || kind === 'period' || kind === 'stunde'
}

// Schulnetz reuses a lesson id in every week, so a lesson's identity is its id and its start. An id
// alone would keep only the first week's lesson and drop every later one.
const mergeKey = (event) => (isLesson(event) ? `lesson|${event.id}|${event.start}` : event.id)

export const mergeEventsById = (base, incoming) => {
  const extra = incoming || []
  if (!extra.length) return base || []
  const incomingById = new Map(extra.map((event) => [mergeKey(event), event]))
  const seen = new Set()
  const out = []
  for (const event of base || []) {
    const key = mergeKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(incomingById.get(key) || event)
  }
  for (const event of extra) {
    const key = mergeKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(event)
  }
  return out
}

/** Exams found inside the timetable feed stay on the exam list after lesson overlay drops them. */
export const carryTimetableExams = (events, exams) => mergeEventsById(exams || [], (events || []).filter(isExamLike))

const gradeKey = (grade) => [numKey(grade.mark), numKey(grade.weight), grade.title || '', grade.date || ''].join('|')

const eventKey = (event) => [
  eventDayKey(event.start), realClock(event.start), realClock(event.end), cleanSchulnetzText(event.room),
  cleanSchulnetzText(event.status), cleanSchulnetzText(event.text),
  (event.teachers || []).map((teacher) => cleanSchulnetzText(teacher)).join(','),
  isCancelled(event) ? 'aus' : 'da', cleanSchulnetzText(event.courseName),
  // A substitute teacher (`neuerlehrer`) is part of the lesson; absent, the key stays as before.
  ...(cleanSchulnetzText(event.substitute) ? [cleanSchulnetzText(event.substitute)] : []),
].join('|')

const formatMark = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return '–'
  const rounded = Math.round(Number(value) * 100) / 100
  return rounded.toLocaleString('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

const eventBody = (event) => {
  const time = displayClock(` ${noticeClock(event.start)}`, ` ${noticeClock(event.end)}`)
  const room = cleanSchulnetzText(event.room)
  const label = [event.courseName, event.text, event.timetableText].map((part) => cleanSchulnetzText(part)).find((part) => part) || ''
  const day = parsedDay(eventDay(event)) ? eventDay(event).split('-').reverse().join('.') : ''
  return [day, label, time, room ? `Raum ${room}` : '', isCancelled(event) ? 'fällt aus' : '', isSubstitution(event) ? 'Vertretung' : '', cleanSchulnetzText(event.comment)]
    .filter(Boolean)
    .join(' · ')
}

const eventMatchLabel = (event) => [event?.courseName, event?.text, event?.timetableText]
  .map((part) => cleanSchulnetzText(part).toLowerCase())
  .find((part) => part) || ''

const courseKeys = (event) => {
  const texts = [event?.courseName, event?.text, event?.timetableText, event?.courseId]
    .map((part) => cleanSchulnetzText(part).toLowerCase())
    .filter(Boolean)
  return new Set(texts.flatMap((text) => [text, text.split(' ')[0], text.split('(')[0].trim()]).filter((text) => text.length >= 2))
}

/** Same lesson after an id or parser change. Course, clock, and room identify it. */
const sameLessonSlot = (left, right) => {
  const leftDay = eventDayKey(left?.start)
  const rightDay = eventDayKey(right?.start)
  if (!leftDay || leftDay !== rightDay) return false
  const leftKeys = courseKeys(left)
  const rightKeys = courseKeys(right)
  if (![...leftKeys].some((key) => rightKeys.has(key))) return false
  const leftClock = realClock(left?.start)
  const rightClock = realClock(right?.start)
  if (!leftClock || !rightClock || leftClock !== rightClock) return false
  const leftRoom = cleanSchulnetzText(left?.room)
  const rightRoom = cleanSchulnetzText(right?.room)
  return !leftRoom || !rightRoom || leftRoom.toLowerCase() === rightRoom.toLowerCase()
}

const namedTeachers = (event) => (event?.teachers || []).map((teacher) => cleanSchulnetzText(teacher)).filter(Boolean)

const lessonContentChanged = (previous, next) => {
  if (schoolEventMoved(previous, next)) return true
  if (isCancelled(next) !== isCancelled(previous)) return true
  const before = namedTeachers(previous)
  const after = namedTeachers(next)
  if (before.length && after.length && before.join() !== after.join()) return true
  return isSubstitution(next) !== isSubstitution(previous)
}

/** A notification body still carries course, clock, and room when the stored id is gone. */
const noticeLesson = (link) => {
  const body = String(link?.body || '')
  const clock = body.match(/(?<!\d)(\d{2}:\d{2})/u)?.[1] || ''
  const room = body.match(/Raum\s+([^\s·]+)/u)?.[1] || ''
  const name = body.split('·').map(cleanSchulnetzText).find((part) => !/^\d{2}\.\d{2}\.\d{4}$/u.test(part)) || ''
  const day = String(link?.date || '').slice(0, 10)
  const start = day && clock ? `${day}T${clock}:00` : day
  return {
    id: '',
    start,
    end: start,
    text: name,
    courseName: name || link?.courseId || '',
    courseId: link?.courseId || '',
    timetableText: name,
    room,
    eventType: 'lesson',
    teachers: [],
    status: '',
  }
}

/** Same subject on the same day. A missing clock still matches, so a stored lesson can be the same test. */
const sameSchoolSlot = (left, right) => {
  if (left?.id && left.id === right?.id) return true
  const leftLabel = eventMatchLabel(left)
  const rightLabel = eventMatchLabel(right)
  if (!leftLabel || leftLabel !== rightLabel) return false
  const leftDay = eventDayKey(left?.start)
  const rightDay = eventDayKey(right?.start)
  return Boolean(leftDay) && leftDay === rightDay
}

const schoolEventMoved = (left, right) => {
  const leftClock = realClock(left?.start)
  const rightClock = realClock(right?.start)
  if (leftClock && rightClock && leftClock !== rightClock) return true
  const leftRoom = cleanSchulnetzText(left?.room)
  const rightRoom = cleanSchulnetzText(right?.room)
  return Boolean(leftRoom) && Boolean(rightRoom) && leftRoom !== rightRoom
}

const messageIdentity = (message) => {
  const title = cleanSchulnetzText(message?.title).toLowerCase()
  const body = cleanSchulnetzText(message?.body).toLowerCase()
  if (!title && !body) return ''
  return `${title}|${body}`
}

const deduped = (changes) => {
  const seen = new Set()
  return changes.filter((change) => {
    if (change.category !== 'exam' && change.category !== 'event' && change.category !== 'timetable') return true
    const key = `${change.category}|${change.title}|${cleanSchulnetzText(change.body)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const parseSchoolDate = (raw) => {
  const match = String(raw || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/u)
  if (!match) return null
  const iso = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`
  const parsed = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null
  if (parsed.getUTCFullYear() !== Number(match[3]) || parsed.getUTCMonth() + 1 !== Number(match[2]) || parsed.getUTCDate() !== Number(match[1])) return null
  return iso
}

export const zurichToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now)

const daysUntil = (today, deadline) => Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000)

/** One reminder per open absence while the excuse deadline is inside the window. Excused rows and missing dates produce nothing. */
export const excuseReminders = (absences, today, withinDays = 2) => {
  if (!Number.isFinite(withinDays) || withinDays < 0) return []
  return (absences || []).flatMap((absence) => {
    if (!absence || absence.excused) return []
    const deadline = parseSchoolDate(absence.excuseUntil)
    if (!deadline) return []
    const days = daysUntil(today, deadline)
    if (days < 0 || days > withinDays) return []
    const whenText = days === 0 ? 'heute' : days === 1 ? 'morgen' : `in ${days} Tagen`
    return [linkedChange(`deadline:${absence.id}:${deadline}`, 'deadline', 'Entschuldigung läuft ab', [absence.subject || 'Absenz', absence.reason || '', `Frist ${whenText} (${deadline.split('-').reverse().join('.')})`].filter(Boolean).join(' · '), {
      targetId: absenceTargetId(absence),
      date: (absence.dateFrom || '').slice(0, 10),
    })]
  })
}

/** Drops change ids that were already stored, so a deadline inside the window is pushed once. */
export const unseenChanges = (changes, knownIds) => {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || [])
  const seen = new Set()
  return (changes || []).filter((change) => {
    if (!change?.id || known.has(change.id) || seen.has(change.id)) return false
    seen.add(change.id)
    return true
  })
}

export const notifyHash = (...parts) => {
  let hash = 2166136261
  const raw = parts.map((part) => String(part ?? '').trim().toLowerCase()).join('|')
  for (const char of raw) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

const courseKeyOf = (grade) => grade.courseId || grade.course || grade.subject || ''

/** dd.mm.yyyy and yyyy-mm-dd become yyyy-mm-dd. Anything else is kept, lowercased. */
export const normalizeGradeDate = (raw) => {
  const value = String(raw || '').trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(value)
  if (de) return `${de[3]}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}`
  return value.toLowerCase()
}

export const normalizeGradeText = (raw) => String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ')

const gradeContentParts = (grade) => [
  normalizeGradeText(courseKeyOf(grade)),
  normalizeGradeDate(grade?.date),
  normalizeGradeText(grade?.title),
  numKey(grade?.mark),
  numKey(grade?.weight),
]

const gradeLooseParts = (grade) => [
  normalizeGradeDate(grade?.date),
  normalizeGradeText(grade?.title),
  numKey(grade?.mark),
  numKey(grade?.weight),
]

const partKey = (parts) => parts.join('\u0000')

/** Hash of course + date + title + mark + weight. Stable when the row id changes. */
export const gradeContentHash = (grade) => notifyHash('c', ...gradeContentParts(grade))

/**
 * Hash without the course. The HTML parser stamps every row with the first
 * bold course label on the page, so a label change rewrites every id and
 * every course string at once. The loose hash still matches that grade.
 */
export const gradeLooseHash = (grade) => notifyHash('l', ...gradeLooseParts(grade))

const looseCounts = (grades) => {
  const counts = new Map()
  for (const grade of withoutSummaryGrades(grades)) {
    const key = partKey(gradeLooseParts(grade))
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

export const gradeNotifyKeys = (grade, uniqueLoose) => {
  const keys = [`c:${gradeContentHash(grade)}`]
  if (uniqueLoose) keys.push(`l:${gradeLooseHash(grade)}`)
  return keys
}

/**
 * Identity keys for every real grade. The loose key is always stored so two
 * parser representations of one grade (different course label, same mark)
 * stay one grade. A change only carries the loose key when that mark is
 * unique in the snapshot, so a second subject with the same mark is not swallowed.
 */
export const gradeLedgerEntries = (grades) => {
  const keys = []
  for (const grade of withoutSummaryGrades(grades)) {
    keys.push(`c:${gradeContentHash(grade)}`, `l:${gradeLooseHash(grade)}`)
  }
  return [...new Set(keys)]
}

/** Delivery-test rows. They are not school records and must not enter the grade ledger. */
export const isNotificationProbe = (id) => String(id || '').startsWith('probe:')

/** Stable device id for probe rows. The raw push token is not stored. */
export const probeDeviceKey = (token) => {
  const value = String(token || '')
  if (!value) return ''
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

/** School rows stay account-wide. A probe row is visible only to the device that was addressed. */
export const changeVisibleToDevice = (change, deviceHash) => {
  if (!change || typeof change !== 'object') return false
  if (!isNotificationProbe(change.id)) return true
  const hash = String(deviceHash || '')
  return /^[a-f0-9]{32}$/u.test(hash) && change.device === hash
}

/**
 * Decide which changes may be announced and which identity keys to store.
 * `ledger === null` means the account has no notified-grades file yet: every
 * grade currently on file is marked seen and none of them are announced.
 * A later mark or weight is a new key and is announced once.
 * Probe rows stay visible and do not add keys.
 */
export const settleGradeNotifications = (changes, grades, ledger) => {
  const pool = gradeLedgerEntries(grades)
  if (ledger == null) {
    return {
      changes: (changes || []).filter((change) => change?.category !== 'grade' || isNotificationProbe(change?.id)),
      keys: pool,
      migrated: true,
    }
  }
  const known = new Set(ledger)
  const fresh = []
  for (const change of changes || []) {
    if (isNotificationProbe(change?.id)) {
      fresh.push(change)
      continue
    }
    if (change?.category !== 'grade') {
      fresh.push(change)
      continue
    }
    const keys = (change.gradeKeys || []).filter(Boolean)
    if (keys.length > 0 && keys.some((key) => known.has(key))) continue
    fresh.push(change)
    for (const key of keys) known.add(key)
  }
  for (const key of pool) known.add(key)
  return { changes: fresh, keys: [...known], migrated: false }
}

/** A failed or empty scrape must not wipe a grade list that was already loaded. */
export const placeholderCourse = (value) => {
  const words = String(value || '').toLowerCase().trim().split(/[^a-zäöü]+/u).filter(Boolean)
  return words.length === 0 || words.every((word) => ['fach', 'kurs', 'course', 'subject'].includes(word))
}

export const trustedGradeRead = (snapshot) => snapshot?.gradesReadComplete !== false &&
  !(snapshot?.readErrors || []).some((error) => /inaktivit|ip.adresse|neu anmelden|anmeldung|login|not(en|es):.*(nicht lesbar|failed)/iu.test(String(error)))

/** Raw upload limit for an app snapshot; nginx takes 1 MB for this site. */
export const SNAPSHOT_BODY_LIMIT = 960 * 1024
/** A gzip upload may expand to this much JSON, no more (a semester of lessons is well below). */
export const SNAPSHOT_JSON_LIMIT = 8 * 1024 * 1024

/**
 * The JSON an app sent, plain or gzip (Content-Encoding: gzip). Throws { status } for a body that is
 * too large once inflated (413), an encoding other than gzip (415), or broken gzip or JSON (400).
 */
export const decodeRequestJson = (raw, encoding = '', maxJson = SNAPSHOT_JSON_LIMIT) => {
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }) }
  const kind = String(encoding || '').trim().toLowerCase()
  let bytes = raw
  if (kind === 'gzip') {
    try {
      bytes = gunzipSync(raw, { maxOutputLength: maxJson })
    } catch (error) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE' || error?.code === 'ERR_OUT_OF_RANGE' || /larger than|maxOutputLength/iu.test(String(error?.message))) fail(413, 'Die Anfrage ist zu gross.')
      fail(400, 'Ungültige Komprimierung.')
    }
  } else if (kind && kind !== 'identity') {
    fail(415, 'Diese Komprimierung wird nicht unterstützt.')
  }
  if (bytes.length > maxJson) fail(413, 'Die Anfrage ist zu gross.')
  if (!bytes.length) return {}
  try { return JSON.parse(bytes.toString('utf8')) } catch { fail(400, 'Ungültiges JSON.') }
}

/** 2: marks with an info tooltip and rows still waiting for a mark are read (the app reads them too). */
export const GRADE_PARSER_VERSION = 2

/**
 * The previous snapshot as the notification diff should see it. When it came from an older grade
 * parser, grades that only the new parser reads are not news: the grade diff starts from the new list
 * and the ledger takes every key, so nothing that was already in Schulnetz is announced.
 */
export const gradeDiffBase = (previous, next) => {
  if (!previous || (Number(previous.gradeParser) || 0) >= GRADE_PARSER_VERSION) return previous
  if (!Array.isArray(next?.grades) || !next.grades.length) return previous
  return { ...previous, grades: next.grades }
}

/** More new absences or messages than this in one upload are a list reappearing, not news. */
export const UPLOAD_LIST_BURST = 3

/**
 * The previous snapshot as the diff of an app upload should see it. The server never reads
 * absences, start-page appointments or the Terminliste itself; they only arrive with uploads (which
 * were refused with 413 for days). A list the server never held, or one that grows by more than
 * UPLOAD_LIST_BURST at once, is taken as the baseline instead of being announced item by item.
 */
export const uploadDiffBase = (previous, next) => {
  if (!previous || !next) return previous
  const base = { ...previous }
  for (const field of ['absences', 'messages']) {
    const known = new Set((previous[field] || []).map((item) => item?.id))
    const fresh = (next[field] || []).filter((item) => !known.has(item?.id)).length
    if (!(previous[field] || []).length || fresh > UPLOAD_LIST_BURST) base[field] = next[field] || []
  }
  if (!(previous.events || []).some((event) => !isLesson(event))) {
    base.events = [...(previous.events || []), ...(next.events || []).filter((event) => !isLesson(event))]
  }
  return base
}

export const keepLoadedGrades = (previousGrades, nextGrades, complete = true) => {
  const next = Array.isArray(nextGrades) ? nextGrades : []
  const prev = Array.isArray(previousGrades) ? previousGrades : []
  if (!complete || next.length === 0 || next.some((grade) => placeholderCourse(grade.course || grade.subject || grade.courseId))) return prev
  return next
}
export const eventLabel = (event) => cleanSchulnetzText(event.courseName) || cleanSchulnetzText(event.text) || cleanSchulnetzText(event.timetableText) || 'Lektion'
const noticeClock = (raw) => {
  const text = cleanSchulnetzText(raw)
  if (/(?:Z|[+-]\d{2}:?\d{2})$/iu.test(text) && Number.isFinite(Date.parse(text))) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(text))
  }
  return schulnetzClock(text)
}
export const eventDay = (event) => {
  const text = cleanSchulnetzText(event.start)
  if (/(?:Z|[+-]\d{2}:?\d{2})$/iu.test(text) && Number.isFinite(Date.parse(text))) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(text))
  }
  return eventDayKey(text)
}
export const eventClock = (event) => {
  const clock = noticeClock(event.start)
  return clock === '00:00' ? '' : clock
}
export const gradeTargetId = (grade) => notifyHash(courseKeyOf(grade), grade.date || '', grade.title || '')
export const lessonTargetId = (event) => notifyHash(eventDay(event), eventClock(event), eventLabel(event))
export const absenceTargetId = (absence) => notifyHash(absence.id || '', absence.dateFrom || '', absence.subject || '', absence.reason || '')
export const messageTargetId = (message) => notifyHash(message.id || '', message.title || '', message.body || '')

export const defaultTarget = (category) => {
  if (category === 'grade') return 'grades'
  if (category === 'timetable') return 'plan'
  if (category === 'exam') return 'exams'
  if (category === 'absence' || category === 'deadline') return 'absences'
  if (category === 'settings') return 'settings'
  if (category === 'commute') return 'commute'
  return 'events'
}

export const linkedChange = (id, category, title, body, extra = {}) => {
  const targetId = extra.targetId || ''
  const targetIds = extra.targetIds || (targetId ? [targetId] : [])
  const gradeKeys = Array.isArray(extra.gradeKeys) ? extra.gradeKeys.filter((key) => typeof key === 'string' && key) : []
  const change = {
    id,
    category,
    title,
    body,
    target: extra.target || defaultTarget(category),
    targetId,
    courseId: extra.courseId || '',
    date: extra.date || '',
    targetIds,
    gradeKeys,
    serverAt: extra.serverAt || '',
  }
  if (typeof extra.correlation === 'string' && extra.correlation) change.correlation = extra.correlation
  if (Number.isInteger(extra.sequence) && extra.sequence > 0) change.sequence = extra.sequence
  return change
}

/** `2026-11-07` becomes `07.11.2026`. Anything else stays blank. */
export const formatProbeDay = (isoDate) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(isoDate || ''))
  if (!match) return ''
  return `${match[3]}.${match[2]}.${match[1]}`
}

/**
 * Six synthetic notices for one delivery test. Titles start with "Test:",
 * the day is DD.MM.YYYY, and no numeric mark is included.
 */
export const notificationProbeChanges = ({ serverAt, day } = {}) => {
  const stamp = String(serverAt || '').replace(/[^0-9]/gu, '').slice(0, 17) || '0'
  const label = formatProbeDay(day)
  const dated = (detail) => `Test · ${detail} · Datum ${label}`
  const one = (kind, category, title, detail, extra = {}) => linkedChange(
    `probe:${stamp}:${kind}`,
    category,
    `Test: ${title}`,
    dated(detail),
    { ...extra, date: day || '', serverAt: serverAt || '' },
  )
  return [
    one('grade-new', 'grade', 'Neue Note', 'Testfach · Testprobe', {
      targetId: `probe-target:${stamp}:grade-new`,
      courseId: 'probe-course',
      gradeKeys: [`probe:key:${stamp}:grade-new`],
      courseLabel: 'Testfach',
      examTitle: 'Testprobe',
    }),
    one('grade-changed', 'grade', 'Notenänderung', 'Testfach · Testprobe', {
      targetId: `probe-target:${stamp}:grade-changed`,
      courseId: 'probe-course',
      gradeKeys: [`probe:key:${stamp}:grade-changed`],
      courseLabel: 'Testfach',
      examTitle: 'Testprobe',
    }),
    one('exam-moved', 'exam', 'Prüfung verschoben', 'Testprüfung verschoben', {
      targetId: `probe-target:${stamp}:exam-moved`,
    }),
    one('exam-cancelled', 'exam', 'Prüfung abgesagt', 'Testprüfung abgesagt', {
      targetId: `probe-target:${stamp}:exam-cancelled`,
    }),
    one('lesson-cancelled', 'timetable', 'Lektion abgesagt', 'Testlektion abgesagt', {
      targetId: `probe-target:${stamp}:lesson-cancelled`,
    }),
    one('appointment-changed', 'event', 'Termin geändert', 'Testtermin geändert', {
      targetId: `probe-target:${stamp}:appointment-changed`,
    }),
  ]
}

/** Remote delivery variants. `reorder` keeps one server clock so receipt matching still works. */
export const PROBE_SCENARIOS = new Set(['standard', 'duplicate', 'reorder'])

export const notificationProbeBatch = ({ serverAt, day, scenario } = {}) => {
  const name = String(scenario || 'standard').trim().toLowerCase()
  if (!PROBE_SCENARIOS.has(name)) return null
  const stamp = String(serverAt || '').replace(/[^0-9]/gu, '').slice(0, 17) || '0'
  const correlation = `probe:${stamp}`
  const changes = notificationProbeChanges({ serverAt, day }).map((change, index) => {
    const sequence = index + 1
    return { ...change, correlation, sequence, body: `${change.body} · Folge ${sequence}` }
  })
  if (name === 'duplicate') return [...changes, { ...changes[0] }]
  if (name === 'reorder') return [...changes].reverse()
  return changes
}

export const notifyKindOf = (category, id = '', title = '') => {
  if (category === 'settings' || id === 'push-test' || String(title).includes('Testbenachrichtigung')) return 'settings'
  if (id === 'schulnetz-login-required' || String(id).startsWith('reauth:')) return 'home'
  if (category === 'deadline') return 'deadline'
  return category
}

export const notifyPayload = (change) => JSON.stringify({
  id: change.id,
  category: change.category,
  title: change.title,
  body: change.body,
  target: change.target || defaultTarget(change.category),
  targetId: change.targetId || (change.targetIds || []).join(','),
  courseId: change.courseId || '',
  date: change.date || '',
  targetIds: change.targetIds || (change.targetId ? String(change.targetId).split(',').filter(Boolean) : []),
  gradeKeys: Array.isArray(change.gradeKeys) ? change.gradeKeys : [],
})

export const parseNotifyLink = (json) => {
  let obj
  try { obj = typeof json === 'string' ? JSON.parse(json) : json } catch { return null }
  if (!obj || typeof obj !== 'object') return null
  if (obj.event === 'keepalive' || obj.event === 'open') return null
  let source = obj
  if (typeof obj.message === 'string') {
    try {
      const nested = JSON.parse(obj.message)
      if (nested && typeof nested === 'object') source = nested
    } catch { /* body is plain text */ }
  }
  const category = source.category || obj.category || 'event'
  const title = source.title || obj.title || ''
  const id = source.id || obj.id || ''
  const fromArray = Array.isArray(source.targetIds) ? source.targetIds.filter((item) => typeof item === 'string' && item) : []
  const fromField = String(source.targetId || obj.targetId || '').split(',').map((item) => item.trim()).filter(Boolean)
  const ids = [...new Set([...fromArray, ...fromField])]
  return {
    kind: notifyKindOf(category, id, title),
    ids: ids.length ? ids : (id ? [id] : []),
    courseId: source.courseId || obj.courseId || '',
    date: source.date || obj.date || '',
    body: source.body || obj.body || '',
  }
}

export const hiddenGradeTitle = (change, course) => {
  const subject = course || 'einem Fach'
  const kind = /änderung|aenderung/i.test(change?.title || '') ? 'Notenänderung' : 'Neue Note'
  return `${kind} in ${subject} – tippen zum Aufdecken`
}

export const hiddenGradeBody = (examTitle) => (examTitle && String(examTitle).trim()) || 'Tippen zum Aufdecken'

export const publicGradeChangeId = (id) => {
  const raw = String(id || '')
  if (!raw.startsWith('grade:')) return raw
  const entity = raw.split(':')[1]
  return entity ? `grade:${entity}:hidden` : 'grade:hidden'
}

export const redactGradeChange = (change) => {
  if (!change || change.category !== 'grade') return change
  if (String(change.title || '').includes('Aufdecken')) return { ...change, id: publicGradeChangeId(change.id) }
  const parts = String(change.body || '').split(' · ').map((part) => part.trim()).filter(Boolean)
  const course = change.courseLabel || parts[0] || change.courseId || 'einem Fach'
  const exam = parts[1] && !/^gewicht/i.test(parts[1]) ? parts[1] : (change.examTitle || 'Note')
  return { ...change, id: publicGradeChangeId(change.id), title: hiddenGradeTitle(change, course), body: hiddenGradeBody(exam) }
}

export const prepareGradeNotifications = (changes, guessGrades) => {
  if (!guessGrades) return groupGradeChanges(changes)
  return (changes || []).map(redactGradeChange)
}

export const groupGradeChanges = (changes) => {
  const list = changes || []
  const probes = list.filter((change) => isNotificationProbe(change?.id))
  const ordinary = list.filter((change) => !isNotificationProbe(change?.id))
  const grades = ordinary.filter((change) => change.category === 'grade')
  if (grades.length <= 1) return list
  const rest = ordinary.filter((change) => change.category !== 'grade')
  const ids = [...new Set(grades.flatMap((change) => change.targetIds || String(change.targetId || '').split(',').filter(Boolean)))]
  const courses = [...new Set(grades.map((change) => change.courseId).filter(Boolean))]
  const gradeKeys = [...new Set(grades.flatMap((change) => change.gradeKeys || []))]
  return [linkedChange(`grades:${ids.slice().sort().join(',')}`, 'grade', `${grades.length} neue Noten`, grades.map((change) => change.body).join('\n'), {
    target: 'grades',
    targetId: ids.join(','),
    courseId: courses.length === 1 ? courses[0] : '',
    targetIds: ids,
    gradeKeys,
  }), ...rest, ...probes]
}

export const routeNotify = (link, snapshot = {}) => {
  if (link.kind === 'settings') return { tab: 'Mehr', section: 'Einstellungen', found: true, highlightIds: [], hint: '' }
  if (link.kind === 'home') return { tab: 'Heute', section: 'Menu', found: true, highlightIds: [], hint: '' }
  if (link.kind === 'grade') {
    const found = (snapshot.grades || []).filter((grade) => link.ids.includes(gradeTargetId(grade)) || link.ids.includes(grade.id))
    const courses = [...new Set(found.map((grade) => courseKeyOf(grade)))]
    return {
      tab: 'Noten',
      section: 'Menu',
      courseId: courses.length === 1 ? courses[0] : link.courseId || '',
      highlightIds: found.length ? found.map(gradeTargetId) : link.ids,
      hint: found.length ? '' : 'Die Note ist nicht mehr im letzten Stand.',
      found: found.length > 0,
    }
  }
  if (link.kind === 'timetable') {
    const found = (snapshot.events || []).filter((event) => link.ids.includes(lessonTargetId(event)) || link.ids.includes(event.id))
    const notice = noticeLesson(link)
    const event = found[0] || (snapshot.events || []).find((candidate) => isLesson(candidate) && sameLessonSlot(candidate, notice))
    return {
      tab: 'Plan',
      section: 'Menu',
      highlightIds: event ? [lessonTargetId(event)] : link.ids,
      day: event ? eventDay(event) : link.date || '',
      hint: event ? '' : 'Die Lektion ist nicht mehr im letzten Stand.',
      found: Boolean(event),
    }
  }
  if (link.kind === 'exam') {
    const pool = [...(snapshot.exams || []), ...(snapshot.events || []).filter(isExamLike)]
    const found = pool.filter((event) => link.ids.includes(lessonTargetId(event)) || link.ids.includes(event.id))
    const event = found[0]
    return {
      tab: 'Mehr',
      section: 'Pruefungen',
      highlightIds: event ? [lessonTargetId(event)] : link.ids,
      day: event ? eventDay(event) : link.date || '',
      hint: event ? '' : 'Die Prüfung ist nicht mehr im letzten Stand.',
      found: Boolean(event),
    }
  }
  if (link.kind === 'deadline' || link.kind === 'absence') {
    const found = (snapshot.absences || []).filter((absence) => link.ids.includes(absenceTargetId(absence)) || link.ids.includes(absence.id))
    return {
      tab: 'Mehr',
      section: 'Absenzen',
      highlightIds: found.length ? found.map(absenceTargetId) : link.ids,
      hint: found.length ? '' : 'Die Absenz ist nicht mehr im letzten Stand.',
      found: found.length > 0,
    }
  }
  const messages = (snapshot.messages || []).filter((message) => link.ids.includes(messageTargetId(message)) || link.ids.includes(message.id))
  if (messages.length) return { tab: 'Mehr', section: 'Termine', highlightIds: messages.map(messageTargetId), found: true, hint: '' }
  const events = (snapshot.events || []).filter((event) => !isLesson(event) && (link.ids.includes(lessonTargetId(event)) || link.ids.includes(event.id)))
  return {
    tab: 'Mehr',
    section: 'Termine',
    highlightIds: events.length ? events.map(lessonTargetId) : link.ids,
    hint: events.length ? '' : 'Der Termin ist nicht mehr im letzten Stand.',
    found: events.length > 0,
  }
}

export const isSummaryGradeTitle = (title) => {
  const raw = String(title || '').trim()
  if (raw === 'Ø' || raw === 'ø') return true
  const folded = raw.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  if (!folded) return false
  if (folded === 'o' || folded === 'avg' || folded === 'average') return true
  if (folded === 'durchschnitt' || folded === 'schnitt') return true
  if (folded === 'notendurchschnitt' || folded === 'notenschnitt') return true
  return folded.startsWith('aktueller durchschnitt')
}

export const isSummaryGrade = (grade) => isSummaryGradeTitle(grade?.title)

export const withoutSummaryGrades = (grades) => (grades || []).filter((grade) => !isSummaryGrade(grade))

const ALERT_PARENT = {
  'grade-new': 'grades',
  'grade-changed': 'grades',
  'lesson-cancelled': 'timetable',
  'lesson-changed': 'timetable',
  'exam-new': 'exams',
  'exam-moved': 'exams',
  'exam-cancelled': 'exams',
  'exam-room': 'exams',
  'exam-other': 'exams',
  'appointment-new': 'events',
  'message-new': 'events',
  'absence-new': 'absences',
  deadline: 'deadlines',
  'commute-delay': 'commute',
  'commute-cancelled': 'commute',
  'commute-lesson': 'commute',
}

const ALERT_FINE = {
  'grade-new': 'gradeNew',
  'grade-changed': 'gradeChanged',
  'lesson-cancelled': 'lessonCancelled',
  'lesson-changed': 'lessonChanged',
  'exam-new': 'examNew',
  'exam-moved': 'examMoved',
  'exam-cancelled': 'examCancelled',
  'exam-room': 'examRoom',
  'appointment-new': 'appointmentNew',
  'message-new': 'messageNew',
  'commute-delay': 'commuteDelay',
  'commute-cancelled': 'commuteCancelled',
  'commute-lesson': 'commuteLessonEnd',
}

/** Real school-alert kind. Blank for probes, tests, and categories this diff does not emit. */
export const notifyAlertKind = (change) => {
  const category = String(change?.category || '')
  const title = String(change?.title || '')
  if (category === 'grade') return /änderung|aenderung/iu.test(title) ? 'grade-changed' : 'grade-new'
  if (category === 'exam') {
    if (title === 'Neue Prüfung') return 'exam-new'
    if (title === 'Prüfung verschoben') return 'exam-moved'
    if (title === 'Prüfung fällt aus' || title === 'Prüfung entfällt') return 'exam-cancelled'
    if (title === 'Raum geändert') return 'exam-room'
    return 'exam-other'
  }
  if (category === 'timetable') {
    if (title === 'Lektion fällt aus' || title === 'Lektion entfernt') return 'lesson-cancelled'
    return 'lesson-changed'
  }
  if (category === 'event') return title === 'Neuer Termin' ? 'appointment-new' : 'message-new'
  if (category === 'absence') return 'absence-new'
  if (category === 'deadline') return 'deadline'
  if (category === 'commute') {
    if (title === 'Fällt aus' || title === 'Anschluss verpasst' || title === 'Verbindung fehlt') return 'commute-cancelled'
    if (title === 'Früher nach Hause' || title === 'Später zur Schule') return 'commute-lesson'
    return 'commute-delay'
  }
  return ''
}

/**
 * Fills an older stored settings object. A missing fine switch follows its
 * category. A missing master switch stays on. Hidden grades stay off.
 * An older server that ignores unknown keys never sees `enabled`.
 */
export const resolvedAlertSettings = (stored = {}) => {
  const source = stored && typeof stored === 'object' ? stored : {}
  const parent = (name) => source[name] !== false
  const grades = parent('grades')
  const timetable = parent('timetable')
  const exams = parent('exams')
  const events = parent('events')
  const fine = (name, fallback) => (typeof source[name] === 'boolean' ? source[name] : fallback)
  return {
    enabled: source.enabled !== false,
    grades,
    gradeNew: fine('gradeNew', grades),
    gradeChanged: fine('gradeChanged', grades),
    timetable,
    lessonCancelled: fine('lessonCancelled', timetable),
    lessonChanged: fine('lessonChanged', timetable),
    exams,
    examNew: fine('examNew', exams),
    examMoved: fine('examMoved', exams),
    examCancelled: fine('examCancelled', exams),
    examRoom: fine('examRoom', exams),
    absences: parent('absences'),
    events,
    appointmentNew: fine('appointmentNew', events),
    messageNew: fine('messageNew', events),
    deadlines: parent('deadlines'),
    commute: parent('commute'),
    commuteDelay: fine('commuteDelay', parent('commute')),
    commuteCancelled: fine('commuteCancelled', parent('commute')),
    commuteLessonEnd: fine('commuteLessonEnd', parent('commute')),
    guessGrades: source.guessGrades === true,
  }
}

/**
 * A missing fine flag follows the older category switch. `enabled: false` blocks
 * every school alert. Delivery probes stay visible because the user asked for them.
 */
export const alertAllowed = (settings = {}, change) => {
  if (isNotificationProbe(change?.id)) return true
  const kind = notifyAlertKind(change)
  // The master switch is "Schul-Updates"; commute alerts have their own parent switch.
  if (settings?.enabled === false && !String(kind).startsWith('commute-')) return false
  if (!kind) return true
  const parent = ALERT_PARENT[kind]
  if (parent && settings?.[parent] === false) return false
  const fine = ALERT_FINE[kind]
  if (fine && settings?.[fine] === false) return false
  return true
}

export const diffSnapshots = (previous, next, settings = {}, today = zurichToday(), now = today === zurichToday() ? new Date() : new Date(`${today}T00:00:00Z`)) => {
  if (!previous) return []
  // Master off: do not build rows. The caller still stores the snapshot.
  if (settings?.enabled === false) return []
  const freshWeeks = new Set([...introducedWeeks(previous, next), ...legacyBackfillWeeks(previous, next), ...lessonSeedWeeks(previous, next)])
  previous = { ...previous, grades: withoutSummaryGrades(previous.grades) }
  next = { ...next, grades: withoutSummaryGrades(next.grades) }
  const prefs = {
    grades: settings.grades !== false,
    timetable: settings.timetable !== false,
    exams: settings.exams !== false,
    absences: settings.absences !== false,
    events: settings.events !== false,
    deadlines: settings.deadlines !== false,
  }
  const changes = []
  if (prefs.grades) diffGradeList(previous.grades || [], next.grades || [], changes)
  if (prefs.timetable) {
    const lessonChanges = []
    const nextLessons = (next.events || []).filter(isLesson)
    diffAgenda(seedLessonMarks((previous.events || []).filter(isLesson), nextLessons, now), nextLessons, 'timetable', 'Stundenplan geändert', 'Lektion entfernt', lessonChanges, freshWeeks, next.exams || [])
    // So many lesson changes in one read is the timetable reloading, not news.
    if (lessonChanges.length <= TIMETABLE_BURST) changes.push(...lessonChanges)
  }
  if (prefs.exams) {
    // An exam-like appointment that is still listed has not been cancelled.
    const stillListed = new Set((next.events || []).map((event) => event.id))
    diffExams([...(previous.exams || []), ...(previous.events || []).filter((event) => isExamLike(event) && !stillListed.has(event.id))], next.exams || [], changes, freshWeeks)
  }
  // The first read with the points parser gives the rows new ids: a baseline, not news.
  if (prefs.absences && !absenceSeedRead(previous, next)) {
    const before = new Set((previous.absences || []).map((item) => item.id))
    let tally = null
    for (const absence of next.absences || []) {
      if (before.has(absence.id)) continue
      tally ||= absenceTally(next)
      changes.push(linkedChange(`absence:${absence.id}`, 'absence', 'Neue Absenz', absenceNoticeBody(absence, tally), {
        targetId: absenceTargetId(absence),
        date: (absence.dateFrom || '').slice(0, 10),
      }))
    }
  }
  if (prefs.deadlines) changes.push(...excuseReminders(next.absences || [], today))
  if (prefs.events) {
    const beforeMessages = new Set((previous.messages || []).map((item) => item.id))
    const knownMessages = new Set((previous.messages || []).map(messageIdentity).filter(Boolean))
    for (const message of next.messages || []) {
      if (beforeMessages.has(message.id)) continue
      const identity = messageIdentity(message)
      if (identity && knownMessages.has(identity)) continue
      const title = cleanSchulnetzText(message.title) || 'Neue Mitteilung'
      const body = cleanSchulnetzText(message.body) || cleanSchulnetzText(message.title)
      if (!body) continue
      changes.push(linkedChange(`event:${message.id}`, 'event', title, body, { targetId: messageTargetId(message) }))
    }
    const beforeEvents = new Set((previous.events || []).map((item) => item.id))
    const knownEvents = [...(previous.events || []), ...(previous.exams || []), ...(next.exams || [])]
    // Only the range the previous appointment list already covered can hold news; later
    // appointments are the list reaching further. A large batch is the list growing too.
    const horizon = appointmentHorizon(previous)
    const appointments = (next.events || []).filter((event) => !freshWeeks.has(weekMondayKey(event.start)) && !isLesson(event) && !isExamLike(event) &&
      !beforeEvents.has(event.id) && !knownEvents.some((known) => sameSchoolSlot(event, known)) && eventBody(event) &&
      (!horizon || (eventDay(event) && eventDay(event) <= horizon)))
    for (const event of appointments.length > APPOINTMENT_BURST ? [] : appointments) {
      const body = eventBody(event)
      changes.push(linkedChange(`event:${event.id}:${eventKey(event)}`, 'event', 'Neuer Termin', body, {
        targetId: lessonTargetId(event),
        courseId: event.courseId || eventLabel(event),
        date: eventDay(event),
      }))
    }
  }
  // A notice about a lesson, exam or appointment that has already ended is never sent.
  return deduped(changes).filter((change) => alertAllowed(settings, change) && !changeIsOver(change, now))
}

/**
 * Same mark under a new row id, or the same mark after the course label
 * changes, is not a new grade. A different mark on the same row is.
 */
const diffGradeList = (previous, next, changes) => {
  const consumed = new Set()
  const prevById = new Map(previous.map((grade, index) => [grade.id, index]))
  const prevByContent = new Map()
  const looseBuckets = new Map()
  previous.forEach((grade, index) => {
    const content = partKey(gradeContentParts(grade))
    const loose = partKey(gradeLooseParts(grade))
    if (!prevByContent.has(content)) prevByContent.set(content, [])
    prevByContent.get(content).push(index)
    if (!looseBuckets.has(loose)) looseBuckets.set(loose, [])
    looseBuckets.get(loose).push(index)
  })
  const nextLooseCounts = looseCounts(next)
  for (const grade of next) {
    const content = partKey(gradeContentParts(grade))
    const loose = partKey(gradeLooseParts(grade))
    let matchedIndex = null
    const idIndex = prevById.get(grade.id)
    if (idIndex != null && !consumed.has(idIndex)) matchedIndex = idIndex
    if (matchedIndex == null) {
      matchedIndex = (prevByContent.get(content) || []).find((index) => !consumed.has(index)) ?? null
    }
    if (matchedIndex == null && nextLooseCounts.get(loose) === 1) {
      const bucket = looseBuckets.get(loose) || []
      if (bucket.length === 1 && !consumed.has(bucket[0])) matchedIndex = bucket[0]
    }
    const matched = matchedIndex == null ? null : previous[matchedIndex]
    if (matchedIndex != null) consumed.add(matchedIndex)
    if (matched) {
      const same = partKey(gradeContentParts(matched)) === content
        || partKey(gradeLooseParts(matched)) === loose
        || gradeKey(matched) === gradeKey(grade)
      if (same) continue
    }
    // A row still waiting for its mark is not news. Its mark arriving is a new grade.
    if (grade.mark == null) continue
    const key = gradeKey(grade)
    const course = grade.course || grade.subject || grade.courseId || 'Kurs'
    changes.push(linkedChange(`grade:${grade.id}:${key}`, 'grade', matched && matched.mark != null ? 'Notenänderung' : 'Neue Note', `${course} · ${grade.title || 'Note'} · ${formatMark(grade.mark)} · Gewicht ${formatMark(grade.weight)}`, {
      targetId: gradeTargetId(grade),
      courseId: courseKeyOf(grade),
      date: grade.date || '',
      gradeKeys: gradeNotifyKeys(grade, nextLooseCounts.get(loose) === 1),
    }))
  }
}

/** A mark the first read with marks finds on a lesson up to this far ahead is still news. */
export const LESSON_MARK_NEWS_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Lessons read before [lessonMarker] existed carry no `marker` field, so they cannot say whether they
 * were already cancelled. For those, the first read with marks is the baseline: its cancellation and
 * substitute count as known, except for lessons still to come within [LESSON_MARK_NEWS_MS], which
 * nobody has been told about yet. So the first read does not announce a semester of past changes.
 */
export const seedLessonMarks = (previous, next, now = new Date()) => {
  const at = now instanceof Date ? now.getTime() : Date.parse(now)
  const marked = next.filter((event) => Object.hasOwn(event, 'marker'))
  if (!marked.length) return previous
  const weekId = (event) => `${event.id}|${weekMondayKey(event.start) || ''}`
  const byWeekId = new Map(marked.map((event) => [weekId(event), event]))
  return previous.map((event) => {
    if (Object.hasOwn(event, 'marker')) return event
    const fresh = byWeekId.get(weekId(event)) || marked.find((candidate) => sameLessonSlot(event, candidate))
    if (!fresh) return event
    const start = schoolStamp(fresh.start)
    const end = schoolStamp(fresh.end || fresh.start)
    const upcoming = Number.isFinite(start) && Number.isFinite(end) && end > at && start - at <= LESSON_MARK_NEWS_MS
    if (upcoming) return { ...event, marker: '' }
    return { ...event, status: fresh.status, marker: fresh.marker, substitute: fresh.substitute || '' }
  })
}

const diffAgenda = (previous, next, category, created, removed, changes, skipWeeks = new Set(), spareAgainst = []) => {
  // Schulnetz reuses a lesson id across weeks, so an id only names the same lesson within a week.
  const weekId = (event) => `${event.id}|${weekMondayKey(event.start) || ''}`
  const before = new Map(previous.map((event) => [weekId(event), event]))
  const after = new Set(next.map(weekId))
  for (const event of next) {
    const old = before.get(weekId(event))
    if (!old && skipWeeks.has(weekMondayKey(event.start))) continue
    const slotTwin = !old && category === 'timetable' ? previous.find((candidate) => sameLessonSlot(event, candidate)) : null
    const prior = old || slotTwin
    if (prior && category === 'timetable' && !lessonContentChanged(prior, event)) continue
    const key = eventKey(event)
    if (old && eventKey(old) === key) continue
    let title
    if (!prior) title = category === 'exam' ? 'Neue Prüfung' : created
    else if (isCancelled(event) && !isCancelled(prior)) title = category === 'exam' ? 'Prüfung fällt aus' : 'Lektion fällt aus'
    else if ((event.teachers || []).join() !== (prior.teachers || []).join() || (isSubstitution(event) && !isSubstitution(prior))) title = 'Vertretung'
    else if (event.room !== prior.room && (event.start !== prior.start || event.end !== prior.end)) title = category === 'exam' ? 'Prüfung geändert' : 'Stundenplan geändert'
    else if (event.room !== prior.room) title = 'Raum geändert'
    else if (event.start !== prior.start || event.end !== prior.end) title = 'Zeit geändert'
    else title = category === 'exam' ? 'Prüfung geändert' : 'Stundenplan geändert'
    const body = eventBody(event)
    if (!body) continue
    changes.push(linkedChange(`${category}:${event.id}:${key}`, category, title, body, {
      targetId: lessonTargetId(event),
      courseId: event.courseId || eventLabel(event),
      date: eventDay(event),
    }))
  }
  for (const event of previous) {
    if (after.has(weekId(event))) continue
    if (skipWeeks.has(weekMondayKey(event.start))) continue
    if (spareAgainst.some((candidate) => sameSchoolSlot(event, candidate))) continue
    if (category === 'timetable' && next.some((candidate) => sameLessonSlot(event, candidate))) continue
    const body = eventBody(event)
    if (!body) continue
    changes.push(linkedChange(`${category}:${event.id}:removed`, category, removed, body, {
      targetId: lessonTargetId(event),
      courseId: event.courseId || eventLabel(event),
      date: eventDay(event),
    }))
  }
}

export const weightedAverage = (marks) => {
  const usable = marks.filter((mark) => mark.weight > 0 && Number.isFinite(mark.mark))
  const weight = usable.reduce((sum, mark) => sum + mark.weight, 0)
  if (weight <= 0) return null
  return usable.reduce((sum, mark) => sum + mark.mark * mark.weight, 0) / weight
}

export const pluspunkte = (marks) => marks
  .filter((mark) => mark.weight > 0 && Number.isFinite(mark.mark))
  .reduce((sum, mark) => sum + (mark.mark - PASS) * mark.weight, 0)

/** Aargau gymnasium promotion: round the course average to 0.5, then Note−4 or twice below 4. */
export const roundToHalf = (value) => {
  if (!Number.isFinite(value)) return value
  return Math.round(value * 2 + Number.EPSILON) / 2
}

export const isSportCourse = (name) => {
  const blob = String(name || '').trim().toLowerCase()
  if (blob.includes('turnen')) return true
  return blob.split(/[\s_/()+\-]+/u).some((token) => token === 'sport' || token.startsWith('sport'))
}

export const promotionPoints = (zeugnis) => {
  if (!Number.isFinite(zeugnis)) return null
  return zeugnis + 1e-9 >= PASS ? zeugnis - PASS : -2 * (PASS - zeugnis)
}

export const wunschnote = (current, target, nextWeight) => {
  if (!Number.isFinite(target) || target < 1 || target > 6) return { achievable: false, alreadyMet: false, needed: null }
  if (!Number.isFinite(nextWeight) || nextWeight <= 0) return { achievable: false, alreadyMet: false, needed: null }
  const usable = current.filter((mark) => mark.weight > 0 && Number.isFinite(mark.mark))
  const weight = usable.reduce((sum, mark) => sum + mark.weight, 0)
  const sum = usable.reduce((total, mark) => total + mark.mark * mark.weight, 0)
  const needed = (target * (weight + nextWeight) - sum) / nextWeight
  if (!Number.isFinite(needed)) return { achievable: false, alreadyMet: false, needed: null }
  if (needed > 6) return { achievable: false, alreadyMet: false, needed }
  if (needed <= 1) return { achievable: true, alreadyMet: true, needed: 1 }
  return { achievable: true, alreadyMet: false, needed, neededHalf: Math.ceil(needed * 2 - 1e-9) / 2 }
}

const blocked = (value) => {
  if (!value) return false
  const blob = value.toLowerCase()
  if (blob.includes('eschool') || blob.includes('e-school') || blob.includes('e_school')) return true
  if (blob.includes('notifications/token') || blob.includes('isalreadyconfirmed')) return true
  if (blob.includes('bestaetigen') || blob.includes('best%c3%a4tigen') || blob.includes('bestätigen')) return true
  if (blob.includes('action=confirm') || blob.includes('action=global_logout')) return true
  if (blob.includes('gradeconfirm') || blob.includes('/enroll')) return true
  return BLOCKED_PAGES.some((pageId) => blob.includes(`pageid=${pageId}`))
}

const EXACT_SCHOOL_HOSTS = new Set(['www.schulnetz-ag.ch', 'schulnetz-ag.ch', 'schulnetz.web.app'])
const SCHOOL_HOST_SUFFIXES = ['.schulnetz-ag.ch', '.schulnetz.ch', '.schulnetz.com']
const MICROSOFT_LOGIN_HOSTS = new Set([
  'login.microsoftonline.com',
  'login.microsoft.com',
  'login.live.com',
  'login.windows.net',
])
const MICROSOFT_LOGIN_SUFFIXES = ['.login.microsoftonline.com', '.msidentity.com', '.msauth.net', '.msftauth.net']

export const ipLiteral = (host) => isIP(String(host || '').replace(/^\[|\]$/u, '')) !== 0

export const schoolHostAllowed = (host) => {
  const name = String(host || '').toLowerCase().replace(/\.$/u, '')
  if (!name || ipLiteral(name)) return false
  if (EXACT_SCHOOL_HOSTS.has(name)) return true
  return SCHOOL_HOST_SUFFIXES.some((suffix) => name.endsWith(suffix) && name.length > suffix.length)
}

export const microsoftLoginHost = (host) => {
  const name = String(host || '').toLowerCase().replace(/\.$/u, '')
  if (!name || ipLiteral(name)) return false
  if (MICROSOFT_LOGIN_HOSTS.has(name)) return true
  return MICROSOFT_LOGIN_SUFFIXES.some((suffix) => name.endsWith(suffix) && name.length > suffix.length)
}

/** HTTPS school or Microsoft login host. IP literals, including loopback, are rejected. */
export const redirectTargetAllowed = (url) => {
  let parsed
  try { parsed = new URL(String(url || '')) } catch { return false }
  if (parsed.protocol !== 'https:') return false
  if (ipLiteral(parsed.hostname)) return false
  return schoolHostAllowed(parsed.hostname) || microsoftLoginHost(parsed.hostname)
}

export const schulnetzCallAllowed = (method, url, body = '') => {
  const verb = String(method || '').toUpperCase()
  if (!['GET', 'HEAD', 'POST'].includes(verb)) return false
  let parsed
  try { parsed = new URL(url) } catch { return false }
  if (parsed.protocol !== 'https:') return false
  if (ipLiteral(parsed.hostname)) return false
  const host = parsed.hostname.toLowerCase()
  if (!schoolHostAllowed(host)) return false
  const path = parsed.pathname.toLowerCase()
  const query = parsed.search.replace(/^\?/, '').toLowerCase()
  if (blocked(`${path}?${query}`) || blocked(String(body || '').toLowerCase())) return false
  if (path.endsWith('/authorize.php')) return false
  if (verb === 'POST') return tokenPostAllowed(path, body)
  if (path.endsWith('/token.php') || path.endsWith('/loginto.php')) return !query.includes('action=')
  const restIndex = path.indexOf('/rest/v1/')
  if (restIndex >= 0) return REST_GET.has(path.slice(restIndex).replace(/\/+$/, ''))
  if (path.endsWith('/index.php')) {
    if (query.includes('action=')) return false
    const pageId = new URLSearchParams(query).get('pageid')
    return READ_PAGES.has(pageId || '')
  }
  if (path.endsWith('/scheduler_processor.php')) {
    return !query.includes('action=') && (query.includes('pageid=22202') || query.includes('pageid=21312') || query.includes('ansicht=schueleransicht') || query.includes('ansicht=klassenuebersicht'))
  }
  if (verb === 'GET' && path.endsWith('.ics') && !query.includes('action=')) return true
  return false
}

const tokenPostAllowed = (path, body) => {
  if (!path.endsWith('/token.php')) return false
  const form = String(body || '').toLowerCase()
  if (form.includes('passwort') || form.includes('loginhash') || form.includes('eschool')) return false
  const params = new URLSearchParams(form)
  const grant = params.get('grant_type')
  return grant === 'authorization_code' || grant === 'refresh_token'
}

export const normalizeSchoolBase = (baseUrl) => {
  let parsed
  try { parsed = new URL(String(baseUrl || '').trim()) } catch { return null }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
  const host = parsed.hostname.toLowerCase()
  if (!/^[a-z0-9.-]+$/.test(host) || !schoolHostAllowed(host)) return null
  return `https://${host}${parsed.pathname.replace(/\/+$/, '')}`
}

const cookieHeaderNames = (header) => String(header || '').split(';').map((part) => part.trim().split('=')[0]).filter(Boolean)

export const redactSecrets = (value) => String(value ?? '')
  .replace(/(Cookie\s*:\s*)([^\r\n]+)/gi, (_, prefix, header) => `${prefix}names=${cookieHeaderNames(header).join(',')}`)
  .replace(/([?&#\s]|^)(code_verifier|code|flowToken|access_token|refresh_token|id_token|client_secret|sFT|canary|buid|fpc|esctx)=([^&\s#"'<>]+)/gi, '$1$2=[redacted]')
  .replace(/"(flowToken|access_token|refresh_token|id_token|client_secret|code|sFT|canary|buid|fpc|esctx)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
  .replace(/\b(PHPSESSID|ESTSAUTH[A-Z0-9]*|SignInStateCookie|esctx|buid|fpc|x-ms-RefreshTokenCredential)=([^;\s,]+)/gi, '$1=[redacted]')
  .replace(/([?&#\s]|^)(transid|id)=([^&\s#"'<>]+)/gi, '$1$2=[redacted]')
  .replace(/(Authorization\s*:\s*)\S+/gi, '$1[redacted]')
  .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')

export const usesWebsiteSession = (baseUrl) => {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return schoolHostAllowed(host) && (host === 'schulnetz-ag.ch' || host.endsWith('.schulnetz-ag.ch'))
  } catch {
    return false
  }
}

const IP_REJECTED_TEXT = [
  'ihre ip-adresse wurde vom system zurückgewiesen',
  'ihre ip-adresse wurde vom system zurueckgewiesen',
]
const INACTIVITY_TEXT = [
  'inaktivitätslimit überschritten',
  'inaktivitaetslimit ueberschritten',
]

const schoolHost = (host) => schoolHostAllowed(host)

/** Final URL, a missing page id, or the exact inactivity / IP sentence. Menu logout links are not a signal. */
export const sessionProblem = (url, html) => {
  const text = String(html || '')
  let parsed = null
  try { parsed = new URL(String(url || 'https://invalid.local')) } catch { parsed = null }
  const host = parsed?.hostname?.toLowerCase() || ''
  if (microsoftLoginHost(host)) return 'microsoft'
  if (text.includes('ConvergedSignIn')) return 'microsoft'
  if (text.includes('AADSTS50058')) return 'microsoft'
  if (/"sErrorCode"\s*:\s*"50058"/.test(text) || /sErrorCode\\?"?\s*:\s*\\?"?50058/.test(text)) return 'microsoft'
  if (text.includes('stsErrorCode') && text.includes('50058')) return 'microsoft'
  const lower = text.toLowerCase()
  if (IP_REJECTED_TEXT.some((phrase) => lower.includes(phrase))) return 'ip'
  if (INACTIVITY_TEXT.some((phrase) => lower.includes(phrase))) return 'inactivity'
  const path = (parsed?.pathname || '').toLowerCase()
  if (path.includes('loginto.php') && parsed?.searchParams.get('mode') === '17') return 'oauth'
  if (path.includes('loginto.php') && text.toLowerCase().includes('login nicht erfolgreich')) return 'oauth'
  if (path.includes('loginto.php') && parsed?.searchParams.get('mode') === '5') return 'inactivity'
  if (path.includes('loginto.php')) return 'login'
  if (parsed && schoolHost(host)) {
    const query = parsed.search || ''
    const body = text.replace(/&amp;/g, '&')
    const htmlPage = /<html|<body|<main/i.test(text)
    if (!/(?:^|[?&])pageid=\d+/i.test(query) && !/pageid=\d+/i.test(body) && htmlPage) return 'login'
  }
  return ''
}

export const microsoftLoginRequired = (url, html) => sessionProblem(url, html) === 'microsoft'

export const stripPhpSession = (cookieHeader) => String(cookieHeader || '')
  .split(';')
  .map((part) => part.trim())
  .filter((part) => part && !/^PHPSESSID=/i.test(part))
  .join('; ')

const clean = (value) => String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

/** Read own table rows/cells only; descendant exam tables never supply a course label. */
const gradeTables = (html) => {
  const tables = []
  const stack = []
  // Schulnetz puts an info icon and a hidden .mdl-tooltip (with more numbers) after some marks.
  // Its text is not part of the cell; the mark is the cell's own text.
  let tooltipDepth = 0
  for (const token of String(html || '').matchAll(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<[^>]+>|[^<]+/gi)) {
    const part = token[0]
    const div = /^<(\/)?div\b/i.exec(part)
    if (tooltipDepth > 0) {
      if (div) tooltipDepth += div[1] ? -1 : 1
      continue
    }
    if (div && !div[1] && /\bclass\s*=\s*["'][^"']*\bmdl-tooltip\b/i.test(part)) {
      tooltipDepth = 1
      continue
    }
    const tag = /^<(\/)?(table|tr|td|th)\b/i.exec(part)
    if (tag) {
      const close = Boolean(tag[1])
      const name = tag[2].toLowerCase()
      if (name === 'table') {
        if (close) stack.pop()
        else {
          const table = { rows: [], row: null, cell: null }
          if (stack.length && stack.at(-1).row) stack.at(-1).row.nested.push(table)
          tables.push(table)
          stack.push(table)
        }
      } else if (stack.length) {
        const table = stack.at(-1)
        if (name === 'tr') {
          table.cell = null
          table.row = close ? null : { cells: [], nested: [] }
          if (table.row) table.rows.push(table.row)
        } else if (close) table.cell = null
        else if (table.row) {
          table.cell = { text: '', header: name === 'th' }
          table.row.cells.push(table.cell)
        }
      }
    } else if (stack.length && stack.at(-1).cell && !part.startsWith('<')) {
      stack.at(-1).cell.text += part + ' '
    }
  }
  return tables
}

export const parseGradesHtml = (html) => {
  if (sessionProblem('', html)) return []
  const grades = []
  const tokenPattern = /^[A-Za-zÄÖÜäöü0-9 ()]+-[A-Za-z0-9]+-[A-Za-zÄÖÜäöü0-9]+/u
  const tables = gradeTables(html)
  const expected = tables.flatMap((table) => table.rows).filter((row) => {
    const values = row.cells.map((cell) => clean(cell.text))
    if (values[0] === '') values.shift()
    return /^\d{2}\.\d{2}\.\d{4}$/u.test(values[0] || '') && !isSummaryGradeTitle(values[1] || '') && parseMark(values[2] || '') != null
  }).length
  for (const table of tables) {
    let course = ''
    let courseId = ''
    let average = null
    const header = table.rows[0]?.cells.map((cell) => clean(cell.text).toLowerCase()) || []
    const courseTable = header.some((cell) => placeholderCourse(cell) && /fach|kurs/u.test(cell)) && header.some((cell) => cell.includes('durchschnitt'))
    for (const row of table.rows) {
      const cells = row.cells.map((cell) => clean(cell.text))
      if (row.nested.length) {
        if (!course) continue
        for (const detail of row.nested) for (const exam of detail.rows) {
          const values = exam.cells.map((cell) => clean(cell.text))
          // Exactly the four grade columns (Datum, Thema, Bewertung, Gewichtung) with an empty date
          // is a grade without a date; a leading empty cell before a date is the indented layout.
          const undated = values.length === 4 && values[0] === '' && Boolean(values[1]) && !/\d{2}\.\d{2}\.\d{4}/u.test(values[1]) &&
            !isSummaryGradeTitle(values[1]) && (parseMark(values[2]) != null || /\d/u.test(values[3] || ''))
          if (values[0] === '' && !undated) values.shift()
          const [date, topic, markText, weight] = values
          if ((!undated && !/^\d{2}\.\d{2}\.\d{4}$/u.test(date || '')) || !topic || isSummaryGradeTitle(topic)) continue
          // A row still waiting for its mark is kept with mark null, as the app reads it.
          const mark = parseMark(markText || '')
          grades.push({
            id: `web:${courseId}:${date}:${topic}:${numKey(mark)}`,
            course, courseId, subject: course, title: topic,
            date: undated ? '' : `${date.slice(6, 10)}-${date.slice(3, 5)}-${date.slice(0, 2)}`,
            mark, weight: parseWeight(weight || '1'), confirmed: true, courseGrade: average, comment: '',
          })
        }
        continue
      }
      const name = cells[0] || ''
      if (placeholderCourse(name) || row.cells.some((cell) => cell.header)) {
        course = ''
        continue
      }
      const token = tokenPattern.exec(name)?.[0]
      if (!token && !courseTable) continue
      course = token ? name.slice(token.length).trim() || token : name
      courseId = token || name.split(' ')[0]
      average = parseMark(cells[1] || '')
    }
  }
  return grades.length < expected ? [] : grades
}

const hasSchedulerDay = (raw) => /\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4}/u.test(String(raw || ''))

/** `start_date` when it carries a day. Prüfungsplan rows often leave it blank and use von/bis instead. */
const schedulerStamp = (direct, day, clock) => {
  const dated = hasSchedulerDay(direct) ? direct : ''
  const raw = dated || (hasSchedulerDay(day) ? (/\d{2}:\d{2}/u.test(clock || '') ? `${day} ${clock}` : day) : '')
  if (!raw) return ''
  const swiss = String(raw).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{2}:\d{2}))?/u)
  if (!swiss) return raw
  const date = `${swiss[3]}-${swiss[2].padStart(2, '0')}-${swiss[1].padStart(2, '0')}`
  return swiss[4] ? `${date} ${swiss[4]}` : date
}

const schedulerTime = (raw) => {
  const text = String(raw || '').replace(' ', 'T')
  return text.length === 16 ? `${text}:00` : text
}

/** Short Schulnetz tokens such as `PHY` or `M4a`. Ordinary subject names are not codes. */
export const looksLikeCourseCode = (raw) => {
  const text = String(raw || '').trim()
  if (text.length < 2 || text.length > 12 || /\s/u.test(text)) return false
  if (![...text].every((char) => /[0-9A-Za-z_./-]/u.test(char))) return false
  const letters = [...text].filter((char) => /[A-Za-z]/u.test(char)).join('')
  if (!letters) return false
  if (/[0-9_/]/u.test(text)) return true
  if (text.includes('.') && letters.length <= 6) return true
  return letters.length <= 6 && letters === letters.toUpperCase()
}

export const parseSchedulerXml = (xml) => {
  const events = []
  for (const block of String(xml).matchAll(/<event\b([^>]*)>([\s\S]*?)<\/event>/giu)) {
    const id = /id=["']([^"']+)["']/u.exec(block[1])?.[1] || ''
    const decodeXml = (value) => String(value || '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&')
    const field = (name) => decodeXml(cleanSchulnetzText(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'iu').exec(block[2])?.[1] || ''))
    const start = schedulerStamp(field('start_date'), field('vdatum'), field('vzeit'))
    if (!start) continue
    const end = schedulerStamp(field('end_date'), field('bdatum'), field('bzeit')) || start
    const comment = field('kommentar')
    const marker = lessonMarker(field('event_type'), field('markierung'), field('textdeco'))
    const named = ['fachbezeichnung', 'kursbezeichnung', 'bezeichnung', 'fach'].map((name) => field(name)).find((value) => value && !looksLikeCourseCode(value)) || ''
    const rawText = field('text')
    const text = named && (!rawText || looksLikeCourseCode(rawText)) ? named : rawText
    const course = field('kurskuerzel') || field('fachkuerzel') || text
    const startIso = schedulerTime(start)
    const endIso = schedulerTime(end)
    events.push({
      id: id || field('identity') || `sched:${startIso}:${course}`,
      start: startIso,
      end: endIso,
      text,
      comment,
      room: field('zimmerkuerzel') || field('zimmer'),
      teachers: field('lehrerkuerzelname') ? [field('lehrerkuerzelname')] : [],
      courseId: field('kursid'),
      courseName: course,
      status: marker === 'cancelled' || /fällt|faellt/iu.test(comment) ? 'cancelled' : '',
      eventType: canonicalEventType(field('event_type')),
      color: field('color'),
      timetableText: text,
      marker,
      substitute: marker ? field('neuerlehrername') || field('neuerlehrer') : '',
    })
  }
  return events
}

/**
 * The mark a school puts on a timetable lesson (`markierung`, offered as "Keine Markierung", "Neu
 * eingefügt", "Verschoben", "Gelöscht" and school-defined labels such as "Geändert"). Schulnetz draws
 * a deleted lesson struck through (`textdeco` line-through). Only lessons carry these marks: on an
 * exam the same field holds the exam material.
 */
export const LESSON_MARKERS = ['cancelled', 'added', 'moved', 'changed']
export const lessonMarker = (eventType, markierung, textdeco) => {
  const kind = cleanSchulnetzText(eventType).toLowerCase()
  if (kind && kind !== '0_stp' && kind !== 'lesson') return ''
  const mark = cleanSchulnetzText(markierung).toLowerCase()
  if (mark === 'deleted' || /line-through/iu.test(cleanSchulnetzText(textdeco))) return 'cancelled'
  if (!mark || mark === 'none') return ''
  if (mark === 'new') return 'added'
  if (mark === 'moved') return 'moved'
  return 'changed'
}

/** Next Terminliste page (`sRow`), not a filter, sort, show-all, or the page just loaded. */
export const terminlisteNextUrl = (html, baseUrl, currentRow = 0) => {
  let best = null
  let bestRow = 0
  for (const match of String(html || '').matchAll(/href\s*=\s*["']([^"']+)["']/giu)) {
    const href = match[1].replace(/&amp;/gu, '&')
    if (!href.includes('pageid=22108') || !href.includes('sRow=')) continue
    if (/(?:^|[?&])ff=/iu.test(href) || href.includes('sort=') || href.includes('action=') || href.includes('numRows=')) continue
    const row = Number(href.match(/sRow=(\d+)/u)?.[1] || 0)
    if (!row || row <= currentRow) continue
    if (best == null || row < bestRow) {
      best = href
      bestRow = row
    }
  }
  if (!best) return ''
  if (best.startsWith('http')) return best
  return `${String(baseUrl || '').replace(/\/+$/u, '')}/${best.replace(/^\/+/u, '')}`
}

/**
 * The transid a loaded page printed for its own scheduler calls (loadStundenplanReal builds
 * scheduler_processor.php?...&ansicht=…&id=…&transid=…&pageid=…). Schulnetz mints a new transid with
 * every page; the scheduler answers only with that one, a replayed transid returns <data></data>.
 */
export const schedulerTransid = (html, pageId = '') => {
  const text = String(html || '').replace(/&amp;/gu, '&').replace(/&#38;/gu, '&')
  for (const match of text.matchAll(/ansicht=[a-z]+[^"'<>\s]*?[?&]id=[a-f0-9]{4,}&transid=([a-f0-9]{4,})[^"'<>\s]*?[?&]pageid=(\d+)/giu)) {
    if (!pageId || match[2] === String(pageId)) return match[1]
  }
  return ''
}

/**
 * id and transid for the next request, from the page that just loaded, the way a browser follows
 * it: the transid printed into the page's scheduler call or links. The URL is only a fallback for
 * bodies without links (the scheduler XML), because it carries the transid that was sent.
 */
export const extractWebIds = (url, html) => {
  const text = String(html || '').replace(/&amp;/gu, '&').replace(/&#38;/gu, '&')
  const links = [...text.matchAll(/href\s*=\s*["']([^"']+)["']/giu)].map((match) => match[1])
    .filter((href) => /(?:^|[?&])pageid=\d+/iu.test(href) && !/pageid=9999\b/iu.test(href))
    .map((href) => ({ id: /(?:^|[?&])id=([a-f0-9]{4,})/iu.exec(href)?.[1] || '', transid: /(?:^|[?&])transid=([a-f0-9]{4,})/iu.exec(href)?.[1] || '' }))
    .filter((link) => link.id && link.transid)
  if (links.length) {
    const groups = new Map()
    for (const link of links) groups.set(link.id.toLowerCase(), [...(groups.get(link.id.toLowerCase()) || []), link])
    const best = [...groups.values()].sort((a, b) => b.length - a.length)[0]
    const sample = best.at(-1)
    return { id: sample.id, transid: schedulerTransid(text) || sample.transid }
  }
  const id = /[?&]id=([a-f0-9]{4,})/iu.exec(String(url || ''))?.[1] || ''
  const transid = /[?&]transid=([a-f0-9]{4,})/iu.exec(String(url || ''))?.[1] || ''
  return id && transid ? { id, transid } : null
}

export const WEEK_ADJACENT_MS = 30 * 60 * 1000
/**
 * This week and the next are read again once their last read is this old, by a full read or by a
 * grade check. Grade checks come every 3.06–3.94 min, so every second one reads the lessons: at most
 * 2 × 3.94 ≈ 7.9 min from a change to its read, inside the same 10 minutes as a grade.
 */
export const LESSON_CHECK_MS = 4 * 60 * 1000
export const WEEK_FAR_MS = 24 * 60 * 60 * 1000
export const WEEK_CAP = 48
/** Mondays tried on each side when the page has no start or end. Not a school year. */
export const WEEK_PROBE = 4
/** Far weeks beyond that horizon loaded on one sync. */
export const WEEK_BATCH = 8

export const weekMonday = (iso) => {
  const [year, month, day] = String(iso || '').split('-').map(Number)
  if (!year || !month || !day) return ''
  const date = new Date(Date.UTC(year, month - 1, day))
  const weekday = date.getUTCDay()
  const delta = weekday === 0 ? 6 : weekday - 1
  date.setUTCDate(date.getUTCDate() - delta)
  return date.toISOString().slice(0, 10)
}

export const addDays = (iso, days) => {
  const [year, month, day] = String(iso || '').split('-').map(Number)
  if (!year || !month || !day) return ''
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return date.toISOString().slice(0, 10)
}

export const eventDate = (start) => {
  const iso = String(start || '').match(/(\d{4}-\d{2}-\d{2})/)
  if (iso) return iso[1]
  const swiss = String(start || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/)
  if (!swiss) return ''
  return `${swiss[3]}-${swiss[2].padStart(2, '0')}-${swiss[1].padStart(2, '0')}`
}

export const weekMondayKey = (start) => {
  const day = eventDate(start)
  return day ? weekMonday(day) : ''
}

export const mondaysBetween = (start, end) => {
  if (!start || !end || end < start) return []
  const last = weekMonday(end)
  const out = []
  let monday = weekMonday(start)
  while (monday && monday <= last && out.length < 520) {
    out.push(monday)
    monday = addDays(monday, 7)
  }
  return out
}

export const capMondays = (mondays, today) => {
  const unique = [...new Set((mondays || []).map(weekMonday).filter(Boolean))].sort()
  if (unique.length <= WEEK_CAP) return unique
  const anchor = weekMonday(today)
  return unique
    .sort((left, right) => Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) - Math.abs(Date.parse(`${right}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) || left.localeCompare(right))
    .slice(0, WEEK_CAP)
    .sort()
}

const parsedDay = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : '')

const limitDate = (html, which) => {
  const constructed = new RegExp(`scheduler\\.config\\.limit_${which}\\s*=\\s*new\\s+Date\\(\\s*(\\d{4})\\s*,\\s*(\\d{1,2})\\s*,\\s*(\\d{1,2})`, 'i').exec(html || '')
  if (constructed) {
    const month = String(Number(constructed[2]) + 1).padStart(2, '0')
    const day = String(Number(constructed[3])).padStart(2, '0')
    const iso = `${constructed[1]}-${month}-${day}`
    return parsedDay(iso) && !Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? iso : ''
  }
  const quoted = new RegExp(`scheduler\\.config\\.limit_${which}\\s*=\\s*["'](\\d{4}-\\d{2}-\\d{2})["']`, 'i').exec(html || '')
  return parsedDay(quoted?.[1] || '')
}

const dataDate = (html, which) => {
  const match = new RegExp(`data-${which}-date\\s*=\\s*["'](\\d{4}-\\d{2}-\\d{2})["']`, 'i').exec(html || '')
  return parsedDay(match?.[1] || '')
}

export const probeMondays = (today) => {
  const current = weekMonday(today)
  const out = []
  for (let step = -WEEK_PROBE; step <= WEEK_PROBE; step += 1) {
    const monday = addDays(current, step * 7)
    if (monday) out.push(monday)
  }
  return out
}

/** Legacy stamps count only when that week already has a lesson. An iCal coverage mark does not. */
export const confirmedLessonStamps = (events = [], weekFetched = {}, weekRead = {}) => {
  if (Object.keys(weekRead || {}).length) return { ...weekRead }
  const taught = new Set((events || []).filter(isLesson).map((event) => weekMondayKey(event.start)).filter(Boolean))
  const out = {}
  for (const [monday, stamp] of Object.entries(weekFetched || {})) {
    if (taught.has(monday)) out[monday] = stamp
  }
  return out
}

export const legacyBackfillWeeks = (previous = {}, next = {}) => {
  const read = Object.keys(next?.weekRead || {})
  if (!read.length) return new Set()
  const prior = new Set(Object.keys(previous?.weekRead || {}))
  const fetched = new Set(Object.keys(previous?.weekFetched || {}))
  return new Set(read.filter((week) => !prior.has(week) && fetched.has(week)))
}

/** A missing limit stays null. Callers then probe a few future weeks. */
export const parseWeekSpan = (html) => {
  const scriptStart = limitDate(html, 'start')
  const scriptEnd = limitDate(html, 'end')
  if (scriptStart && scriptEnd && scriptEnd >= scriptStart) return { start: scriptStart, end: scriptEnd }
  const min = dataDate(html, 'min')
  const max = dataDate(html, 'max')
  if (min && max && max >= min) return { start: min, end: max }
  return semesterSpan(html)
}

/**
 * The semester Schulnetz 5.14 offers on Stundenplan and Prüfungsplan, never stated as
 * limit_start/limit_end: the grid view from/to (to is exclusive), the wp_date/grid_date templates,
 * the "Folgesemester" guard date (exclusive) and the Wochenplan "Zeitraum" inputs.
 */
export const semesterSpan = (html) => {
  const text = String(html || '')
  const dotted = (value) => {
    const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/u.exec(value || '')
    return match ? `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}` : ''
  }
  const valid = (day) => (parsedDay(day) ? day : '')
  const grid = /createGridView\(\{[\s\S]{0,4000}?from\s*:\s*new\s+Date\(\s*["'](\d{4}-\d{2}-\d{2})["']\s*\)\s*,\s*to\s*:\s*new\s+Date\(\s*["'](\d{4}-\d{2}-\d{2})["']\s*\)/u.exec(text)
  const template = /day_date\(\s*new\s+Date\(\s*["'](\d{4}-\d{2}-\d{2})["']\s*\)\s*\)[\s\S]{0,160}?day_date\(\s*scheduler\.date\.add\(\s*new\s+Date\(\s*["'](\d{4}-\d{2}-\d{2})["']\s*\)\s*,\s*-1\s*,\s*["']day["']/u.exec(text)
  const guard = /if\s*\(\s*["'](\d{4}-\d{2}-\d{2})["']\s*<\s*max_date\s*\)/u.exec(text)
  const from = /id\s*=\s*["']zeitraum_von["'][^>]*?value\s*=\s*["'](\d{1,2}\.\d{1,2}\.\d{4})["']/u.exec(text)
  const to = /id\s*=\s*["']zeitraum_bis["'][^>]*?value\s*=\s*["'](\d{1,2}\.\d{1,2}\.\d{4})["']/u.exec(text)
  const start = valid(grid?.[1]) || valid(template?.[1]) || valid(dotted(from?.[1]))
  const end = (valid(grid?.[2]) && addDays(grid[2], -1)) || (valid(template?.[2]) && addDays(template[2], -1)) ||
    valid(dotted(to?.[1])) || (valid(guard?.[1]) && addDays(guard[1], -1)) || ''
  return start && end && end >= start ? { start, end } : null
}

export const spanOfEvents = (events) => {
  const days = (events || []).map((event) => eventDate(event.start)).filter(Boolean).sort()
  if (!days.length) return null
  return { start: days[0], end: days[days.length - 1] }
}

const stampAge = (stamp, now) => {
  const then = Date.parse(stamp || '')
  const at = Date.parse(now || '')
  if (!Number.isFinite(then) || !Number.isFinite(at)) return Number.POSITIVE_INFINITY
  return at - then
}

const weekDistance = (monday, current) => Math.round((Date.parse(`${monday}T00:00:00Z`) - Date.parse(`${current}T00:00:00Z`)) / (7 * 86400000))

// emptyWeeks: weeks read without a lesson. Up to WEEK_PROBE weeks ahead they are checked again on the
// short cadence, so a week an earlier empty answer marked free does not stay free for a day.
// unreadWeeks: weeks asked for but never confirmed as read; asked again on the short cadence.
export const planWeekFetches = ({ mondays = [], fetchedAt = {}, icalFetchedAt = '', now, today, icalAvailable = false, emptyWeeks = new Set(), unreadWeeks = new Set() } = {}) => {
  const current = weekMonday(today)
  const probing = !mondays.length
  const universe = capMondays(probing ? probeMondays(today) : mondays, today)
  const due = []
  const beyond = []
  for (const monday of universe) {
    const distance = Math.abs(weekDistance(monday, current))
    const stamp = fetchedAt?.[monday]
    const soon = distance <= 1 || unreadWeeks.has(monday) || (monday > current && distance <= WEEK_PROBE && emptyWeeks.has(monday))
    const refresh = weekDistance(monday, current) === 1 ? LESSON_CHECK_MS : soon ? WEEK_ADJACENT_MS : WEEK_FAR_MS
    const wanted = monday === current || !stamp || stampAge(stamp, now) >= refresh
    if (!wanted) continue
    if (distance <= WEEK_PROBE) due.push(monday)
    else beyond.push(monday)
  }
  // Oldest attempt first; among equals the coming weeks before past ones, nearest first.
  beyond.sort((left, right) => {
    const stamp = String(fetchedAt?.[left] || '').localeCompare(String(fetchedAt?.[right] || ''))
    if (stamp) return stamp
    const past = Number(left < current) - Number(right < current)
    if (past) return past
    return Math.abs(weekDistance(left, current)) - Math.abs(weekDistance(right, current))
  }).slice(0, WEEK_BATCH).forEach((monday) => due.push(monday))
  const first = Object.keys(fetchedAt || {}).length === 0 && !icalFetchedAt
  const icalDue = Boolean(icalAvailable && (first || stampAge(icalFetchedAt, now) >= WEEK_FAR_MS))
  return { fetch: due, fetchIcal: icalDue }
}

/**
 * The lesson weeks a grade check reads too: this week and the next, when their last read is
 * [LESSON_CHECK_MS] old. Between full reads (evenings, nights, weekends) this keeps cancellations
 * inside the grade window. Weeks outside the semester Schulnetz offers are left out.
 */
export const lessonCheckWeeks = ({ weekFetched = {}, today, now, spanStart = '', spanEnd = '' } = {}) => {
  const current = weekMonday(today)
  if (!current) return []
  return [current, addDays(current, 7)].filter((monday) => {
    if (parsedDay(spanStart) && parsedDay(spanEnd) && (addDays(monday, 6) < spanStart || monday > spanEnd)) return false
    return stampAge(weekFetched?.[monday], now) >= LESSON_CHECK_MS
  })
}

export const eventQueryWindow = ({ spanStart = '', spanEnd = '', weekFetched = {}, icalFetchedAt = '', today, now } = {}) => {
  const nearMin = addDays(today, -7)
  const nearMax = addDays(today, 21)
  if (!parsedDay(spanStart) || !parsedDay(spanEnd) || spanEnd < spanStart) return { min: nearMin, max: nearMax, wide: false }
  const current = weekMonday(today)
  const far = mondaysBetween(spanStart, spanEnd).filter((monday) => Math.abs(weekDistance(monday, current)) > 1)
  const icalFresh = stampAge(icalFetchedAt, now) < WEEK_FAR_MS
  const missingFar = far.some((monday) => !weekFetched?.[monday])
  const staleFar = far.some((monday) => weekFetched?.[monday] && stampAge(weekFetched[monday], now) >= WEEK_FAR_MS)
  const wide = missingFar || (staleFar && !icalFresh)
  return wide ? { min: spanStart, max: spanEnd, wide: true } : { min: nearMin, max: nearMax, wide: false }
}

export const hasFetchedWeeks = (weekFetched) => Object.keys(weekFetched || {}).some((key) => weekMonday(key) === key)

export const introducedWeeks = (previous, next) => {
  const keys = Object.keys(next?.weekFetched || {}).filter((key) => weekMonday(key) === key)
  if (!keys.length) return new Set()
  const prevKeys = Object.keys(previous?.weekFetched || {}).filter((key) => weekMonday(key) === key)
  const known = new Set(prevKeys)
  if (!prevKeys.length) {
    for (const event of [...(previous?.events || []), ...(previous?.exams || [])]) {
      const monday = weekMondayKey(event?.start)
      if (monday) known.add(monday)
    }
  }
  return new Set(keys.filter((key) => !known.has(key)))
}

export const overlayLessons = (previous, incoming, refreshed) => {
  const weeks = refreshed instanceof Set ? refreshed : new Set(refreshed || [])
  if (!weeks.size) return previous || []
  const kept = (previous || []).filter((event) => {
    const monday = weekMondayKey(event.start)
    return !weeks.has(monday) || (!isLesson(event) && !isExamLike(event))
  })
  const added = (incoming || []).filter((event) => isLesson(event) && weeks.has(weekMondayKey(event.start)))
  return kept.concat(added)
}

export const overlayDated = (previous, incoming, refreshed) => {
  const weeks = refreshed instanceof Set ? refreshed : new Set(refreshed || [])
  if (!weeks.size) return previous || []
  const kept = (previous || []).filter((event) => !weeks.has(weekMondayKey(event.start)))
  const added = (incoming || []).filter((event) => weeks.has(weekMondayKey(event.start)))
  return kept.concat(added)
}

export const applyEventWindow = (previous, incoming, minDay, maxDay) => {
  if (!parsedDay(minDay) || !parsedDay(maxDay)) return previous || []
  const inside = (event) => {
    const day = eventDate(event.start)
    return Boolean(day) && day >= minDay && day <= maxDay
  }
  return (previous || []).filter((event) => !inside(event)).concat((incoming || []).filter(inside))
}

export const stampWeeks = (previous, minDay, maxDay, nowIso) => {
  const out = { ...(previous || {}) }
  if (!parsedDay(minDay) || !parsedDay(maxDay)) return out
  for (const monday of mondaysBetween(minDay, maxDay)) out[monday] = nowIso
  return out
}

export const schedulerBodyUsable = (body) => {
  const trimmed = String(body || '').trim()
  return Boolean(trimmed) && (trimmed.includes('<data') || trimmed.includes('<event'))
}

/** An empty `<data></data>` body is readable but not a timetable. It must not wipe the week. */
export const schedulerWeekLoaded = (body) => schedulerBodyUsable(body) && /<event/iu.test(body)

export const icalBodyUsable = (body) => String(body || '').includes('BEGIN:VCALENDAR')

export const findIcalUrl = (html, baseUrl) => {
  const href = /href=["']([^"']+\.ics[^"']*)["']/i.exec(html || '')?.[1]
  const call = /icalAbo\(\s*['"]([^'"]+)['"]/i.exec(html || '')?.[1]
  const raw = href || call
  if (!raw) return ''
  if (raw.startsWith('http')) return raw
  if (raw.startsWith('//')) return `https:${raw}`
  return `${String(baseUrl || '').replace(/\/+$/u, '')}/${raw.replace(/^\/+/u, '')}`
}

export const parseIcs = (text) => {
  if (!String(text || '').includes('BEGIN:VEVENT')) return []
  return String(text).split('BEGIN:VEVENT').slice(1).map((block) => {
    const body = block.split('END:VEVENT')[0]
    const value = (name) => new RegExp(`^${name}(?:;[^:]*)?:(.+)$`, 'm').exec(body)?.[1]?.trim()?.replace(/\\n/g, '\n')?.replace(/\\,/g, ',') || ''
    const summary = value('SUMMARY')
    const start = value('DTSTART')
    if (!summary || !start) return null
    const icsTime = (raw) => {
      const compact = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(raw)
      if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:00`
      const day = /(\d{4})(\d{2})(\d{2})/.exec(raw)
      return day ? `${day[1]}-${day[2]}-${day[3]}` : raw
    }
    return {
      id: value('UID') || `ics:${start}:${summary}`,
      start: icsTime(start),
      end: icsTime(value('DTEND') || start),
      text: summary,
      comment: value('DESCRIPTION'),
      room: value('LOCATION'),
      teachers: [],
      courseId: '',
      courseName: summary,
      status: '',
      eventType: examLead(summary) || examMarker(value('CATEGORIES')) ? 'exam' : 'lesson',
      color: '',
      timetableText: summary,
    }
  }).filter(Boolean)
}

/** Europe/Zurich offset at noon UTC, negated the way the scheduler page sends timeshift. */
export const zurichTimeshift = (day) => {
  const date = new Date(`${day}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return -60
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || '0')
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || '0')
  return -((hour * 60 + minute) - 12 * 60)
}

export const schedulerFetchUrl = ({ root, pageId, ansicht, id, transid, today, min, max, extra = '' }) => {
  const shift = zurichTimeshift(today)
  const middle = extra ? `&${extra}` : ''
  return `${String(root).replace(/\/+$/u, '')}/scheduler_processor.php?view=week&curr_date=${today}&min_date=${min}&max_date=${max}&ansicht=${ansicht}${middle}&id=${id}&transid=${transid}&pageid=${pageId}&timeshift=${shift}`
}

// Private notification baselines are independent of display/fetch caches and survive process restarts.
export const prepareAgendaRead = (stored = {}, next = {}) => {
  const weeks = { ...stored }
  const beforeEvents = []
  const beforeExams = []
  const knownExams = distinctExams(Object.entries(stored).filter(([key, value]) => Number.isFinite(Date.parse(value.examWeekFetched?.[key] || ''))).flatMap(([, week]) => week.exams || []))
  const keys = new Set([...Object.keys(stored), ...Object.keys(next.weekFetched || {}), ...Object.keys(next.examWeekFetched || {}),
    ...(next.events || []).concat(next.exams || []).map((event) => weekMondayKey(eventDay(event))).filter(Boolean)])
  // A grade check that also read lesson weeks keeps fetchedAt (the full read) and stamps lessonsFetchedAt.
  const readAt = [next.fetchedAt, next.lessonsFetchedAt].map((stamp) => Date.parse(stamp || '')).filter(Number.isFinite)
  const at = readAt.length ? Math.max(...readAt) : Number.NaN
  const fresh = (stamp, old) => {
    const value = Date.parse(stamp || '')
    const prior = Date.parse(old || '')
    return !(next.readErrors || []).some((error) => /inaktivit|ip.adresse|anmeld|login|abgelaufen|microsoft|oauth/iu.test(error) ||
      !/^(Noten|Absenzen|Termine|Mitteilungen|Konto):/iu.test(error)) && Number.isFinite(at) && Number.isFinite(value) && value <= at && (!Number.isFinite(prior) || value > prior)
  }
  for (const week of keys) {
    if (weekMondayKey(week) !== week) continue
    const old = stored[week] || {}
    const events = (next.events || []).filter((event) => !isExamLike(event) && weekMondayKey(eventDay(event)) === week)
    const exams = (next.exams || []).filter((event) => weekMondayKey(eventDay(event)) === week)
    const lessonsFresh = fresh(next.weekFetched?.[week], old.weekFetched?.[week])
    const ambiguous = exams.some((event) => exams.some((other) => sameExamId(event, other) && examTimeChanged(event, other)))
    const partial = ambiguous || (!exams.length && (old.exams || []).length) || exams.some((candidate) =>
      knownExams.some((event) => sameExamId(event, candidate) && completeExamTime(event) && !completeExamTime(candidate)))
    const examsFresh = !partial && fresh(next.examWeekFetched?.[week], old.examWeekFetched?.[week])
    beforeEvents.push(...(lessonsFresh && Number.isFinite(Date.parse(old.weekFetched?.[week] || '')) ? old.events || [] : events))
    beforeExams.push(...(!examsFresh ? exams : Number.isFinite(Date.parse(old.examWeekFetched?.[week] || '')) ? old.exams || [] : exams.map((event) => {
      const known = knownExams.filter((candidate) => sameExamId(candidate, event))
      return known.length === 1 ? known[0] : event
    })))
    if (lessonsFresh || examsFresh) weeks[week] = {
      ...old, fetchedAt: next.fetchedAt,
      events: lessonsFresh ? events : old.events || [],
      exams: examsFresh ? exams : old.exams || [],
      weekFetched: lessonsFresh ? { [week]: next.weekFetched[week] } : old.weekFetched || {},
      examWeekFetched: examsFresh ? { [week]: next.examWeekFetched[week] } : old.examWeekFetched || {},
    }
  }
  for (const [week, record] of Object.entries(weeks)) {
    const elsewhere = Object.entries(weeks).filter(([key]) => key !== week).flatMap(([, value]) => value.exams || [])
    weeks[week] = { ...record, exams: (record.exams || []).filter((event) => !elsewhere.some((other) =>
      sameExamId(event, other) && eventDay(event) !== eventDay(other) &&
      Date.parse(Object.values(weeks[weekMondayKey(eventDay(other))]?.examWeekFetched || {})[0] || '') > Date.parse(Object.values(record.examWeekFetched || {})[0] || ''))) }
  }
  const distinct = (events) => [...new Map(events.map((event) => [`${event.id}|${event.start}|${event.end}`, event])).values()]
  return { before: { ...next, events: distinct(beforeEvents), exams: distinct(beforeExams) }, weeks }
}

const sameExamId = (left, right) => {
  const key = (event) => cleanSchulnetzText(event.id || '').split('@')[0]
  return Boolean(key(left)) && key(left) === key(right)
}
const examLabel = (event) => [event.text, event.timetableText, event.courseName].map((text) => cleanSchulnetzText(text).toLowerCase()).find(Boolean) || ''
const schoolStamp = (raw) => {
  const text = cleanSchulnetzText(raw)
  if (/(?:Z|[+-]\d{2}:?\d{2})$/iu.test(text)) return Date.parse(text)
  const day = eventDayKey(text), clock = schulnetzClock(text)
  if (!day || !clock) return Number.NaN
  return Date.parse(`${day}T${clock}:00Z`) + zurichTimeshift(day) * 60_000
}
const sameExamSlot = (left, right) => Boolean(examLabel(left)) && examLabel(left) === examLabel(right) &&
  eventDay(left) === eventDay(right) && (!eventClock(left) || !eventClock(right) || eventClock(left) === eventClock(right)) &&
  (!schulnetzClock(left.end) || !schulnetzClock(right.end) || schoolStamp(left.end) === schoolStamp(right.end))
const completeExamTime = (event) => Boolean(eventDayKey(event.start)) && Boolean(eventDayKey(event.end)) &&
    Boolean(schulnetzClock(event.start)) && Boolean(schulnetzClock(event.end)) &&
    !(schulnetzClock(event.start) === '00:00' && schulnetzClock(event.end) === '00:00') &&
    Number.isFinite(schoolStamp(event.start)) && Number.isFinite(schoolStamp(event.end))
const examTimeChanged = (left, right) => completeExamTime(left) && completeExamTime(right) &&
  (schoolStamp(left.start) !== schoolStamp(right.start) || schoolStamp(left.end) !== schoolStamp(right.end))
const diffExams = (previous, next, changes, skipWeeks) => {
  const before = distinctExams(previous), consumed = new Set()
  for (const event of distinctExams(next)) {
    if (!parsedDay(eventDay(event))) continue
    const ids = before.map((candidate, index) => !consumed.has(index) && sameExamId(candidate, event) ? index : -1).filter((index) => index >= 0)
    const slots = before.map((candidate, index) => !consumed.has(index) && sameExamSlot(candidate, event) ? index : -1).filter((index) => index >= 0)
    const index = ids.length === 1 ? ids[0] : slots.length === 1 ? slots[0] : null
    const prior = index == null ? null : before[index]
    if (index != null) consumed.add(index)
    if (!prior && skipWeeks.has(weekMondayKey(eventDay(event)))) continue
    let title
    if (!prior) title = 'Neue Prüfung'
    else if (isCancelled(event) && !isCancelled(prior)) title = 'Prüfung fällt aus'
    else if (examTimeChanged(prior, event)) title = 'Prüfung verschoben'
    else if (prior.room && event.room && cleanSchulnetzText(prior.room) !== cleanSchulnetzText(event.room)) title = 'Raum geändert'
    else continue
    changes.push(linkedChange(`exam:${String(event.id).split('@')[0]}:${eventKey(event)}`, 'exam', title, eventBody(event), {
      targetId: lessonTargetId(event), courseId: event.courseId || eventLabel(event), date: eventDay(event),
    }))
  }
  if (!next.length) return
  for (const [index, event] of before.entries()) {
    if (consumed.has(index) || skipWeeks.has(weekMondayKey(eventDay(event))) || !parsedDay(eventDay(event))) continue
    if (next.some((candidate) => sameExamId(event, candidate) || sameExamSlot(event, candidate))) continue
    changes.push(linkedChange(`exam:${event.id}:removed`, 'exam', 'Prüfung entfällt', eventBody(event), {
      targetId: lessonTargetId(event), courseId: event.courseId || eventLabel(event), date: eventDay(event),
    }))
  }
}

const distinctExams = (events) => {
  const out = []
  for (const event of events) {
    const index = out.findIndex((candidate) =>
      (sameExamId(candidate, event) && schoolStamp(candidate.start) === schoolStamp(event.start) && schoolStamp(candidate.end) === schoolStamp(event.end)) ||
      (eventClock(candidate) && eventClock(event) && sameExamSlot(candidate, event)))
    if (index < 0) out.push(event)
    else if (!completeExamTime(out[index]) && completeExamTime(event)) out[index] = event
  }
  return out
}

// When a school notice is still worth sending, and when a timetable week really counts as read.
// Mirrors android/core/.../schulnetz/SchoolTiming.kt; keep both in step.
const DATED_CATEGORIES = new Set(['exam', 'timetable', 'event'])
const CLOCK_RANGE = /\b(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})\b/u
export const zurichClock = (now = new Date()) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)
export const changeDay = (change) => eventDate(change?.date) ||
  ((change?.category === 'exam' || change?.category === 'timetable') ? eventDate(String(change?.body || '').slice(0, 12)) : '')
/** A notice about a lesson, exam or appointment that has already ended. Grades, absences, messages and probes never are. */
export const changeIsOver = (change, now = new Date()) => {
  if (!DATED_CATEGORIES.has(change?.category) || isNotificationProbe(change?.id)) return false
  const day = changeDay(change)
  if (!day) return false
  const today = zurichToday(now)
  if (day < today) return true
  if (day > today) return false
  const range = String(change.body || '').match(CLOCK_RANGE)
  if (!range) return false
  return zurichClock(now) > `${range[3].padStart(2, '0')}:${range[4]}`
}
/** More new appointments than this in one read is the list growing, not news. */
export const APPOINTMENT_BURST = 8
/** Last day the previous appointment list reached. Appointments after it are newly visible, not new. */
export const appointmentHorizon = (previous) => {
  const days = (previous?.events || []).filter((event) => !isLesson(event) && !isExamLike(event)).map((event) => eventDay(event)).filter(Boolean)
  return days.length ? days.sort().at(-1) : ''
}
const vacationRanges = (vacations = []) => vacations.map((v) => {
  const start = eventDate(v?.start)
  const end = eventDate(v?.end) || start
  return start && end >= start ? [start, end] : null
}).filter(Boolean)
export const weekIsHoliday = (monday, vacations = []) => {
  const ranges = vacationRanges(vacations)
  return [0, 1, 2, 3, 4].every((offset) => { const day = addDays(monday, offset); return ranges.some(([a, b]) => day >= a && day <= b) })
}
/** An empty scheduler answer proves a free week only if the scheduler returned lessons in the same read, or it is a holiday. */
export const emptyWeekCountsAsRead = (monday, schedulerProven, vacations = []) => Boolean(schedulerProven) || weekIsHoliday(monday, vacations)
export const withoutUnprovenEmptyReads = (reads = {}, events = [], vacations = []) => {
  const taught = new Set(events.filter(isLesson).map((event) => weekMondayKey(event.start)).filter(Boolean))
  return Object.fromEntries(Object.entries(reads).filter(([week]) => taught.has(week) || weekIsHoliday(week, vacations)))
}
/** Weeks looked at past the last week that had lessons, so a published timetable is followed forward. */
export const LESSON_WALK_WEEKS = 8
/**
 * School year when the page shows no range: from appointments, exams, holidays, and eight weeks past
 * the last lesson read. Four weeks back, at least four and at most forty ahead.
 */
export const fallbackSchoolSpan = (events = [], vacations = [], today = zurichToday(), exams = []) => {
  const lessonDays = events.filter(isLesson).map((event) => eventDay(event)).filter(Boolean).sort()
  const days = [
    ...events.filter((event) => !isLesson(event)).map((event) => eventDay(event)),
    ...exams.map((event) => eventDay(event)),
    ...vacationRanges(vacations).flat(),
    ...(lessonDays.length ? [addDays(lessonDays.at(-1), LESSON_WALK_WEEKS * 7)] : []),
  ].filter(Boolean).sort()
  if (!days.length) return null
  // Never narrower than the four-week probe around today.
  const start = addDays(today, -28)
  const probeEnd = addDays(today, 28)
  const high = addDays(today, 280)
  const reach = days.at(-1) < high ? days.at(-1) : high
  return { start, end: reach > probeEnd ? reach : probeEnd }
}

/** Lessons that must appear at once in an empty week before it counts as the timetable loading. */
export const LESSON_SEED_MIN = 3
/**
 * Weeks whose lessons appear for the first time, several at once. That is the timetable loading (a
 * week an older read stamped as empty, or a week further ahead), not a change, so it is read
 * silently. One or two lessons added to an empty week are still news.
 */
export const lessonSeedWeeks = (previous, next) => {
  const had = new Set((previous?.events || []).filter(isLesson).map((event) => weekMondayKey(event.start)).filter(Boolean))
  const count = new Map()
  for (const event of (next?.events || []).filter(isLesson)) {
    const week = weekMondayKey(event.start)
    if (week && !had.has(week)) count.set(week, (count.get(week) || 0) + 1)
  }
  return new Set([...count].filter(([, n]) => n >= LESSON_SEED_MIN).map(([week]) => week))
}
/** More lesson changes than this in one read is the timetable reloading, not news. */
export const TIMETABLE_BURST = 20

const lessonWeeksOf = (events = []) => new Set(events.filter(isLesson).map((event) => weekMondayKey(event.start)).filter(Boolean))

/**
 * A phone upload does not replace timetable weeks the server has read: for those weeks the server's
 * lessons and stamps stay. An older app only sees this week and would otherwise erase the rest, and
 * its rendered lessons differ in form from the scheduler's, which would read as changes.
 */
export const keepServerLessons = (previous, upload) => {
  const weeks = lessonWeeksOf(previous?.events)
  if (!weeks.size || !upload) return upload
  const events = [
    ...(upload.events || []).filter((event) => !isLesson(event) || !weeks.has(weekMondayKey(event.start))),
    ...(previous.events || []).filter((event) => isLesson(event) && weeks.has(weekMondayKey(event.start))),
  ]
  const stamps = (field) => {
    const out = { ...(upload[field] || {}) }
    for (const week of weeks) {
      if (previous?.[field]?.[week]) out[week] = previous[field][week]
      else delete out[week]
    }
    return out
  }
  return { ...upload, events, weekFetched: stamps('weekFetched'), weekRead: stamps('weekRead') }
}

/** Header a client sends when it reads absences with [ABSENCE_PARSER_VERSION] (points and open reports). */
export const ABSENCES_HEADER = 'x-kanti-absences'

/**
 * What an app before the points parser gets: the rows its own reader (`parseAbsencesByHeader`)
 * makes of the same page, with the same ids, so adopting the server copy and then reading
 * Schulnetz itself does not announce the same absences again. Points and quota are not part of it.
 */
export const legacyAbsenceView = (snapshot) => {
  if (!snapshot || !(Number(snapshot.absenceParser) >= ABSENCE_PARSER_VERSION)) return snapshot
  const absences = (snapshot.absences || []).map((row) => {
    const reason = row.pending ? '' : String(row.reason || '').split(' · ')[0]
    const subject = row.pending ? String(row.subject || '') : ''
    return {
      id: stableId('abs', row.dateFrom || '', reason, subject),
      dateFrom: row.dateFrom || '', dateTo: row.dateFrom || '',
      hourFrom: row.pending ? [row.hourFrom, row.hourTo].filter(Boolean).join(' - ') : '', hourTo: '',
      subject, reason, excused: false, acknowledged: false, status: '', excuseUntil: '',
    }
  })
  const { absenceQuota, absenceRemaining, absenceParser, ...rest } = snapshot
  return { ...rest, absences }
}

/** Header a client sends when its own notification diff handles every timetable week. */
export const TIMETABLE_WEEKS_HEADER = 'x-kanti-timetable'

/**
 * What an older app gets: this week's lessons, without the per-week "fetched" stamps of weeks with
 * lessons, so its own diff, which lacks the first-timetable rule, has nothing to announce. Other
 * weeks stay unread for it rather than looking free.
 */
export const legacySnapshotView = (snapshot, today = zurichToday()) => {
  if (!snapshot) return snapshot
  const current = weekMonday(today)
  const weeks = lessonWeeksOf(snapshot.events)
  if (!weeks.size) return snapshot
  const weekFetched = { ...(snapshot.weekFetched || {}) }
  const weekRead = { ...(snapshot.weekRead || {}) }
  for (const week of weeks) {
    delete weekFetched[week]
    if (week !== current) delete weekRead[week]
  }
  return {
    ...snapshot,
    events: (snapshot.events || []).filter((event) => !isLesson(event) || weekMondayKey(event.start) === current),
    weekFetched,
    weekRead,
  }
}

// ── Kanti+ im Browser ──────────────────────────────────────────────────────

const TAM_HOST = 'intranet.tam.ch'
const TAM_SLUG = /^[a-z0-9][a-z0-9-]{1,19}$/u
const TAM_RESERVED = new Set(['auth', 'themes', 'public', 'rest', 'js', 'css', 'img', 'images', 'default', 'logout'])

/** "https://intranet.tam.ch/bmz" for that URL, a deeper page of it or the bare school code; the app's tamSchoolRoot. */
export const tamSchoolRoot = (input) => {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  let slug
  if (!raw.includes('/') && !raw.includes('.')) {
    slug = raw.toLowerCase()
  } else {
    let url
    try { url = new URL(raw.includes('://') ? raw : `https://${raw}`) } catch { return null }
    if (url.hostname.toLowerCase() !== TAM_HOST || url.protocol !== 'https:') return null
    slug = url.pathname.replace(/^\/+/u, '').split('/')[0].toLowerCase()
  }
  if (!TAM_SLUG.test(slug) || TAM_RESERVED.has(slug)) return null
  return `https://${TAM_HOST}/${slug}`
}

/** Target ids of the grades a change list announces; the app's newGradeTargetIds. */
export const newGradeTargetIds = (changes) => [...new Set((changes || [])
  .filter((change) => change?.category === 'grade' && !isNotificationProbe(change.id))
  .flatMap((change) => (Array.isArray(change.targetIds) && change.targetIds.length ? change.targetIds : String(change.targetId || '').split(',')))
  .map((id) => String(id).trim())
  .filter((id) => id && !id.includes(':')))]

const REVEAL_LEDGER_MAX = 2000
const ledgerIds = (list) => (Array.isArray(list) ? list : []).map((id) => String(id ?? '').trim()).filter((id) => /^[A-Za-z0-9_-]{1,64}$/u.test(id))

/**
 * Hidden-grade ledger shared by the app and the browser: ids that were hidden when they arrived and
 * ids that were revealed since. Both lists only grow (newest kept), so two devices merge without loss.
 */
export const mergeRevealLedger = (stored, incoming = {}) => {
  const keep = (before, added) => {
    const seen = new Set()
    const out = []
    for (const id of [...ledgerIds(before), ...ledgerIds(added)].reverse()) {
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out.slice(0, REVEAL_LEDGER_MAX).reverse()
  }
  return {
    version: 1,
    hidden: keep(stored?.hidden, incoming.hidden),
    revealed: keep(stored?.revealed, incoming.revealed),
  }
}

/** Ids still hidden: hidden and never revealed. */
export const unrevealedGradeIds = (ledger) => {
  const revealed = new Set(ledgerIds(ledger?.revealed))
  return ledgerIds(ledger?.hidden).filter((id) => !revealed.has(id))
}

/**
 * The grades the browser receives. Every grade carries its target id. While hidden grades are on, a
 * hidden mark never leaves the server: the mark and its comment are withheld, and so is the school's
 * course average for that course, which would give the mark away.
 */
export const webGradeView = (grades, hiddenIds, guessGrades) => {
  const hidden = guessGrades ? new Set(hiddenIds || []) : new Set()
  const list = (grades || []).map((grade) => ({ ...grade, targetId: gradeTargetId(grade) }))
  const coveredCourses = new Set(list.filter((grade) => hidden.has(grade.targetId)).map(courseKeyOf))
  return list.map((grade) => {
    if (hidden.has(grade.targetId)) return { ...grade, mark: null, comment: '', courseGrade: null, hidden: true }
    // A summary row (an average printed as a grade) of that course is withheld as well.
    if (coveredCourses.has(courseKeyOf(grade))) return isSummaryGrade(grade) ? { ...grade, mark: null, courseGrade: null, withheld: true } : { ...grade, courseGrade: null }
    return grade
  })
}

// ---------------------------------------------------------------------------------------------
// Absence points (Absenzpunkte). Same parser and estimate as the app's AbsencePoints.kt; both run
// the cases in android/core/src/test/resources/schulnetz/absence-points-cases.json.
//
// The AKSA Absenzen page (pageid 21111) has the booked statement ("Absenzenauszug": points per row,
// quota) and the open reports (table#offeneAbsenzen: date, time, course, no points). An open report
// has no points yet, so they are estimated with the Absenzenreglement of the Alte Kantonsschule
// Aarau (from August 2026) until Schulnetz books the real entry.

export const ABSENCE_PARSER_VERSION = 2

const ABS_SWISS_DATE = /(\d{1,2})\.(\d{1,2})\.(\d{4})/u
const ABS_LEADING_DATE = /^\d{1,2}\.\d{1,2}\.\d{4}/u
const ABS_CLOCK = /([01]?\d|2[0-3]):([0-5]\d)/gu
const ABS_POINTS = /-?\d+(?:[.,]\d+)?/u

const absText = (raw) => String(raw ?? '').replace(/ /gu, ' ').replace(/\s+/gu, ' ').trim()
const absFold = (raw) => absText(raw).toLowerCase().replace(/ä/gu, 'ae').replace(/ö/gu, 'oe').replace(/ü/gu, 'ue').replace(/[^a-z0-9]+/gu, ' ').trim()
const absEntity = (raw) => String(raw).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (all, name) => {
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : all
  }
  return { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name.toLowerCase()] ?? all
})
const swissDayOf = (raw) => {
  const match = ABS_SWISS_DATE.exec(String(raw || ''))
  return match ? `${match[1].padStart(2, '0')}.${match[2].padStart(2, '0')}.${match[3]}` : ''
}
const absClock = (raw, index = 0) => {
  const match = [...String(raw || '').matchAll(ABS_CLOCK)][index]
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : ''
}
const absPoints = (raw) => {
  const match = ABS_POINTS.exec(absText(raw).replace(/ /gu, ''))
  if (!match) return null
  const value = Number(match[0].replace(',', '.'))
  return Number.isFinite(value) ? value : null
}

/** Tables with their own rows and cells (colspan, th, text, lines split at <br>), nested tables kept apart. */
const absenceTables = (html) => {
  const tables = []
  const stack = []
  const BLOCK = /^<\/?(div|p|li|ul|ol|h\d|section)\b/iu
  for (const token of String(html || '').matchAll(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<[^>]+>|[^<]+/giu)) {
    const part = token[0]
    if (part.startsWith('<!--') || /^<(script|style)\b/iu.test(part)) continue
    const tag = /^<(\/)?(table|caption|tr|td|th|br)\b/iu.exec(part)
    const table = stack.at(-1)
    if (tag) {
      const close = Boolean(tag[1])
      const name = tag[2].toLowerCase()
      if (name === 'table') {
        if (close) stack.pop()
        else {
          const created = { id: /\sid\s*=\s*["']([^"']*)["']/iu.exec(part)?.[1] || '', caption: '', rows: [], inner: [], row: null, cell: null, inCaption: false, nested: Boolean(table) }
          if (table?.cell) table.cell.hasTable = true
          for (const outer of stack) outer.inner.push(created)
          tables.push(created)
          stack.push(created)
        }
      } else if (!table) continue
      else if (name === 'caption') table.inCaption = !close
      else if (name === 'tr') {
        table.cell = null
        table.row = close ? null : { cells: [] }
        if (table.row) table.rows.push(table.row)
      } else if (name === 'br') {
        if (table.cell) { table.cell.text += ' '; table.cell.lines.push('') }
        else if (table.inCaption) table.caption += ' '
      } else if (close) table.cell = null
      else if (table.row) {
        const span = Number(/\bcolspan\s*=\s*["']?(\d+)/iu.exec(part)?.[1] || 1)
        table.cell = { header: name === 'th', span: Math.min(20, Math.max(1, span || 1)), text: '', lines: [''], hasTable: false }
        table.row.cells.push(table.cell)
      }
      continue
    }
    if (part.startsWith('<')) {
      if (table?.cell && BLOCK.test(part)) table.cell.text += ' '
      continue
    }
    if (!table) continue
    const value = absEntity(part)
    if (table.cell) {
      table.cell.text += value
      table.cell.lines[table.cell.lines.length - 1] += value
      // Text of a nested table also belongs to the cells that contain it (as in the app's reader).
      for (const outer of stack.slice(0, -1)) if (outer.cell) outer.cell.text += value
    } else if (table.inCaption) table.caption += value
  }
  return tables
}

const absColumns = (row) => {
  let at = 0
  return row.cells.map((cell) => {
    const column = { label: absText(cell.text), start: at, span: cell.span }
    at += cell.span
    return column
  })
}

const distinctAbsenceIds = (rows) => {
  const seen = new Map()
  return rows.map((row) => {
    const count = (seen.get(row.id) || 0) + 1
    seen.set(row.id, count)
    return count === 1 ? row : { ...row, id: `${row.id}-${count}` }
  })
}

/** The statement and open reports, or null when the page has neither table. */
export const parseAbsenceStatement = (html) => {
  if (!html) return null
  let read = false
  let quota = null
  let remaining = null
  const booked = []
  const open = []
  for (const table of absenceTables(html)) {
    if (table.nested) continue
    const headerRow = table.rows.find((row) => row.cells.some((cell) => cell.header))
    if (!headerRow) continue
    const header = absColumns(headerRow)
    const labels = header.map((column) => absFold(column.label))
    const caption = absFold(table.caption)
    const openTable = table.id === 'offeneAbsenzen' || caption.includes('offene absenzmeldungen') ||
      (labels.includes('datum') && labels.includes('zeit') && labels.includes('kurs'))
    const pointsAt = labels.findIndex((label) => label.startsWith('absenzpunkte') || label === 'punkte')
    const statementTable = !openTable && labels[0] === 'datum von' && pointsAt >= 0
    if (!openTable && !statementTable) continue
    read = true
    const body = table.rows.slice(table.rows.indexOf(headerRow) + 1)
    if (openTable) {
      const at = (name, fallback) => (labels.indexOf(name) >= 0 ? labels.indexOf(name) : fallback)
      const dateAt = at('datum', 0)
      const timeAt = at('zeit', 1)
      const courseAt = at('kurs', 2)
      for (const row of body) {
        const cells = row.cells.map((cell) => absText(cell.text))
        if (!ABS_LEADING_DATE.test(cells[dateAt] || '')) continue
        const day = swissDayOf(cells[dateAt])
        const time = cells[timeAt] || ''
        const course = cells[courseAt] || ''
        open.push({
          id: stableId('abs-open', day, time, course),
          dateFrom: day, dateTo: day, hourFrom: absClock(time, 0), hourTo: absClock(time, 1),
          subject: course, reason: '', excused: false, acknowledged: false, status: 'offen', excuseUntil: '', pending: true,
        })
      }
      continue
    }
    const headerSpan = header.reduce((sum, column) => sum + column.span, 0)
    const point = header[pointsAt]
    const reasonColumn = header.find((column) => absFold(column.label).startsWith('grund'))
    for (const row of body) {
      const cells = row.cells
      const laid = absColumns(row)
      if (!laid.length) continue
      const firstText = absText(cells[0].text)
      const day = swissDayOf(firstText)
      if (!day || cells.length < 3) continue
      const rowSpan = laid.reduce((sum, column) => sum + column.span, 0)
      const shift = rowSpan > headerSpan ? rowSpan - headerSpan : 0
      const cellAt = (column) => {
        const index = laid.findIndex((item) => column >= item.start && column < item.start + item.span)
        return index >= 0 ? cells[index] : null
      }
      const pointsCell = cellAt(point.start + shift)
      let points = pointsCell ? absPoints(pointsCell.text) : null
      if (points == null) {
        const numbers = cells.slice(2).map((cell) => absText(cell.text)).filter((text) => !ABS_SWISS_DATE.test(text)).map(absPoints).filter((value) => value != null)
        points = numbers.length ? numbers.at(-1) : null
      }
      let reason = ''
      if (reasonColumn) {
        const covered = []
        for (let column = reasonColumn.start; column < reasonColumn.start + reasonColumn.span; column += 1) {
          const cell = cellAt(column)
          if (cell && !covered.includes(cell)) covered.push(cell)
        }
        reason = covered.map((cell) => absText(cell.text)).filter(Boolean).join(' · ')
      }
      const toText = absText(cells[1]?.text || '')
      booked.push({
        id: stableId('abs', firstText, toText, reason),
        dateFrom: day, dateTo: swissDayOf(toText) || day, hourFrom: absClock(firstText), hourTo: absClock(toText),
        subject: '', reason, excused: false, acknowledged: true, status: 'gebucht', excuseUntil: '', points,
      })
    }
    // The footer (a nested table): "Kontingent:<br>Verbleibendes Kontingent:" next to "30<br>30".
    for (const cellRow of [...table.rows, ...table.inner.flatMap((inner) => inner.rows)]) {
      cellRow.cells.forEach((cell, index) => {
        if (!cell.text.includes('Kontingent') || cell.hasTable) return
        const lines = cell.lines.map(absText).filter(Boolean)
        const values = (cellRow.cells[index + 1]?.lines || []).map(absText).filter(Boolean).map(absPoints).filter((value) => value != null)
        lines.forEach((line, at) => {
          const colon = line.indexOf(':')
          const inline = colon >= 0 ? absPoints(line.slice(colon + 1)) : null
          const value = inline ?? values[at] ?? null
          const key = absFold(colon >= 0 ? line.slice(0, colon) : line)
          if (key === 'kontingent') quota = value ?? quota
          else if (key === 'verbleibendes kontingent') remaining = value ?? remaining
        })
      })
    }
  }
  if (!read) return null
  return { absences: [...distinctAbsenceIds(booked), ...distinctAbsenceIds(open)], quota, remaining, read: true }
}

/** The Absenzen page: `{absences, quota, remaining, read}`; `read` is false when it showed neither table. */
export const readAbsenceStatement = (html) => {
  if (!html || sessionProblem('', html)) return { absences: [], quota: null, remaining: null, read: false }
  return parseAbsenceStatement(html) || { absences: [], quota: null, remaining: null, read: false }
}

/** [next] when it read the page or brought rows; otherwise the stored absences with their quota. */
export const keepAbsenceRead = (previous, next) => {
  if (Number(next?.absenceParser) >= ABSENCE_PARSER_VERSION) return next
  if ((next?.absences || []).length && !(Number(previous?.absenceParser) >= ABSENCE_PARSER_VERSION)) return next
  return {
    ...next,
    absences: previous?.absences || [],
    absenceQuota: previous?.absenceQuota ?? null,
    absenceRemaining: previous?.absenceRemaining ?? null,
    absenceParser: Number(previous?.absenceParser) || 0,
  }
}

/** The first read with the points parser gives rows new ids: a baseline, not news. */
export const absenceSeedRead = (previous, next) =>
  !(Number(previous?.absenceParser) >= ABSENCE_PARSER_VERSION) && Number(next?.absenceParser) >= ABSENCE_PARSER_VERSION

const INSTRUMENT_WORDS = /(?<![\p{L}])(instrument\p{L}*|klavier|piano|gitarre|e-gitarre|e-bass|violine|geige|viola|bratsche|cello|violoncello|kontrabass|querflöte|blockflöte|flöte|oboe|fagott|klarinette|saxophon|saxofon|trompete|posaune|waldhorn|horn|tuba|schlagzeug|perkussion|harfe|orgel|akkordeon|gesang|sologesang|sologesangsunterricht|stimmbildung|einzelunterricht|einzellektion)(?![\p{L}])/iu
const SPECIAL_WORDS = /(projektwoche|projekttag|klassenwoche|sonderwoche|studienwoche|spezialwoche|arbeitswoche|sporttag|sportwoche|exkursion|studienreise|maturareise|klassenlager|skilager|schneesportlager|lager|schulreise|besuchstag|ausflug)/iu

const absMinutes = (clock) => {
  const match = /([01]?\d|2[0-3]):([0-5]\d)/u.exec(String(clock || ''))
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}
const absDay = (raw) => eventDate(raw) || null
const epochDay = (iso) => {
  const [year, month, day] = iso.split('-').map(Number)
  return Math.round(Date.UTC(year, month - 1, day) / 86400000)
}
const absOverlap = (aFrom, aTo, bFrom, bTo) => aFrom < bTo && bFrom < aTo
const absWords = (event) => [event.courseName, event.courseId, event.text, event.timetableText].map((value) => String(value || '')).join(' ').toLowerCase()
const compareNullable = (a, b) => (a === b ? 0 : a == null ? -1 : b == null ? 1 : a < b ? -1 : 1)

/**
 * Booked points, the estimate for open reports and the remaining quota (see AbsencePoints.kt):
 * n lessons without an attended lesson in between cost n + 1 (free periods, cancelled lessons and
 * the night are no interruption; a weekend is), an instrumental lesson alone 3, a block with an
 * announced exam 10 (at most 10 per day), special days 5 (half) or 9 (full). Without a time or a
 * timetable a report is 1 + 1. A report on a day with a booked entry is booked.
 */
export const absenceTally = (snapshot) => {
  const absences = Array.isArray(snapshot?.absences) ? snapshot.absences : []
  const pending = absences.filter((item) => item?.pending)
  const booked = absences.filter((item) => item && !item.pending && Number.isFinite(item.points))
  const quota = Number.isFinite(snapshot?.absenceQuota) ? snapshot.absenceQuota : null
  const shownRemaining = Number.isFinite(snapshot?.absenceRemaining) ? snapshot.absenceRemaining : null
  const bookedPoints = quota != null && shownRemaining != null ? Math.max(0, quota - shownRemaining) : booked.reduce((sum, item) => sum + (item.points || 0), 0)

  const slots = pending.map((absence, index) => {
    let from = absMinutes(absClock(absence.hourFrom))
    let to = absMinutes(absClock(absence.hourTo))
    if (to == null && absClock(absence.hourFrom, 1)) to = absMinutes(absClock(absence.hourFrom, 1))
    if (from != null && to != null && to <= from) { from = null; to = null }
    const lessons = from != null && to != null && to > from ? Math.max(1, Math.round((to - from + 5) / 50)) : 1
    return { index, absence, date: absDay(absence.dateFrom), from, to, lessons }
  })
  const events = Array.isArray(snapshot?.events) ? snapshot.events : []
  const examList = Array.isArray(snapshot?.exams) ? snapshot.exams : []
  const lessons = events.filter((event) => isLesson(event) && !isCancelled(event)).map((event) => {
    const date = absDay(event.start)
    const from = absMinutes(schulnetzClock(event.start))
    if (!date || from == null) return null
    const end = absMinutes(schulnetzClock(event.end))
    return { event, date, from, to: end != null && end > from ? end : from + 45 }
  }).filter(Boolean)
  const lessonWeeks = new Set(lessons.map((lesson) => weekMonday(lesson.date)))
  const exams = [...examList.filter((event) => String(event.eventType || '').toLowerCase() === 'exam' || isExamLike(event)), ...events.filter((event) => isExamLike(event))]
    .filter((event) => !isCancelled(event))
  const appointments = [...events, ...examList].filter((event) => !isLesson(event) && !isExamLike(event) && String(event.eventType || '').toLowerCase() !== 'exam')

  const lessonsAt = (slot) => (slot.date && slot.from != null && slot.to != null
    ? lessons.filter((lesson) => lesson.date === slot.date && absOverlap(lesson.from, lesson.to, slot.from, slot.to)) : [])
  const bookedCovers = (slot) => {
    if (!slot.date) return false
    return booked.some((entry) => {
      const start = absDay(entry.dateFrom)
      if (!start) return false
      const endDay = absDay(entry.dateTo)
      const end = endDay && endDay >= start ? endDay : start
      if (slot.date < start || slot.date > end) return false
      const bFrom = absMinutes(entry.hourFrom)
      const bTo = absMinutes(entry.hourTo)
      if (start === end && bFrom != null && bTo != null && bTo > bFrom && slot.from != null && slot.to != null) return absOverlap(bFrom, bTo, slot.from, slot.to)
      return true
    })
  }
  const special = (slot) => {
    if (!slot.date) return false
    if (SPECIAL_WORDS.test(String(slot.absence.subject || ''))) return true
    if (lessonsAt(slot).length || slot.from == null) return false
    return appointments.some((event) => {
      if (absDay(event.start) !== slot.date || !SPECIAL_WORDS.test(absWords(event))) return false
      const from = absMinutes(schulnetzClock(event.start))
      const to = absMinutes(schulnetzClock(event.end))
      return from == null || to == null || from === to || absOverlap(from, to, slot.from, slot.to ?? slot.from)
    })
  }
  const examAt = (slot) => {
    if (!slot.date) return false
    const course = String(slot.absence.subject || '').trim().toLowerCase()
    const courses = [...new Set([course, ...lessonsAt(slot).map((lesson) => String(lesson.event.courseName || '').trim().toLowerCase())].filter((value) => value.length >= 2))]
    return exams.some((exam) => {
      if (absDay(exam.start) !== slot.date) return false
      const from = absMinutes(schulnetzClock(exam.start))
      const to = absMinutes(schulnetzClock(exam.end))
      if (from != null && to != null && to > from) {
        return slot.from != null && slot.to != null ? absOverlap(from, to, slot.from, slot.to) : courses.some((value) => absWords(exam).includes(value))
      }
      return courses.some((value) => absWords(exam).includes(value))
    })
  }
  const instrumental = (slot) => INSTRUMENT_WORDS.test(String(slot.absence.subject || '')) || lessonsAt(slot).some((lesson) => INSTRUMENT_WORDS.test(absWords(lesson.event)))

  const estimates = {}
  let block = 0
  let estimated = 0
  const assign = (group, points, rule) => {
    const lessonCount = group.reduce((sum, slot) => sum + slot.lessons, 0)
    group.forEach((slot, at) => { estimates[slot.absence.id] = { points, lessons: lessonCount, reports: group.length, rule, block, first: at === 0 } })
    estimated += points
    block += 1
  }
  const open = slots.filter((slot) => {
    if (!bookedCovers(slot)) return true
    estimates[slot.absence.id] = { points: 0, lessons: slot.lessons, reports: 1, rule: 'booked', block: -1, first: true }
    return false
  })
  const specials = open.filter(special)
  const known = open.filter((slot) => !specials.includes(slot) && slot.date && slot.from != null && slot.to != null && lessonWeeks.has(weekMonday(slot.date)))
  const fallback = open.filter((slot) => !specials.includes(slot) && !known.includes(slot))
  const missed = slots.filter((slot) => slot.date && slot.from != null && slot.to != null)
  const attended = lessons.filter((lesson) => !missed.some((slot) => slot.date === lesson.date && absOverlap(slot.from, slot.to, lesson.from, lesson.to)))
  const inChain = (a, b) => {
    if (!a.date || !b.date || weekMonday(a.date) !== weekMonday(b.date) || a.to == null || b.from == null) return false
    const aEnd = epochDay(a.date) * 1440 + a.to
    const bStart = epochDay(b.date) * 1440 + b.from
    return !attended.some((lesson) => {
      const start = epochDay(lesson.date) * 1440 + lesson.from
      return start >= aEnd && start < bStart
    })
  }
  const ordered = [...known].sort((a, b) => compareNullable(a.date, b.date) || compareNullable(a.from, b.from) || a.index - b.index)
  const chains = []
  for (const slot of ordered) {
    const last = chains.at(-1)?.at(-1)
    if (last && inChain(last, slot)) chains.at(-1).push(slot)
    else chains.push([slot])
  }
  const byDay = new Map()
  for (const slot of specials) byDay.set(slot.date, [...(byDay.get(slot.date) || []), slot])
  const items = [...chains.map((group) => [group, 'chain']), ...[...byDay.values()].map((group) => [group, 'special']), ...fallback.map((slot) => [[slot], 'fallback'])]
  items.sort(([a], [b]) => compareNullable(a[0].date, b[0].date) || ((a[0].from ?? -1) - (b[0].from ?? -1)) || a[0].index - b[0].index)
  const examDay = new Map()
  for (const [group, kind] of items) {
    if (kind === 'special') {
      const froms = group.map((slot) => slot.from).filter((value) => value != null)
      const tos = group.map((slot) => slot.to).filter((value) => value != null)
      const from = froms.length ? Math.min(...froms) : null
      const to = tos.length ? Math.max(...tos) : null
      const fullDay = group.some((slot) => slot.from == null || slot.to == null) || (from != null && to != null && from < 12 * 60 && to > 13 * 60)
      assign(group, fullDay ? 9 : 5, 'special')
    } else if (kind === 'fallback') {
      assign(group, group.reduce((sum, slot) => sum + slot.lessons, 0) + 1, 'fallback')
    } else {
      const examSlot = group.find(examAt)
      if (examSlot) {
        const used = examDay.get(examSlot.date) || 0
        const points = Math.min(10, Math.max(0, 10 - used))
        examDay.set(examSlot.date, used + points)
        assign(group, points, 'exam')
      } else if (group.every(instrumental)) assign(group, 3 * group.length, 'instrument')
      else assign(group, group.reduce((sum, slot) => sum + slot.lessons, 0) + 1, 'lessons')
    }
  }
  const remaining = shownRemaining != null ? shownRemaining - estimated : quota != null ? quota - bookedPoints - estimated : null
  return { quota, booked: bookedPoints, estimated, remaining, total: bookedPoints + estimated, openReports: pending.length, estimates }
}

/** "3", "2,5": German number for notices. */
export const pointsText = (value) => {
  const rounded = Math.round(value * 10) / 10
  return Math.abs(rounded - Math.round(rounded)) < 1e-9 ? String(Math.round(rounded)) : String(rounded).replace('.', ',')
}

/** Notice body for a new absence; the app builds the same text (AbsencePoints.kt `absenceNoticeBody`). */
export const absenceNoticeBody = (absence, tally) => {
  const whenText = [absence.dateFrom, absence.hourFrom].filter(Boolean).join(' ')
  const left = tally?.quota != null && tally?.remaining != null ? `Kontingent noch ${pointsText(tally.remaining)} von ${pointsText(tally.quota)}` : ''
  let parts
  if (absence.pending) {
    const estimate = tally?.estimates?.[absence.id]
    parts = [absence.subject || 'Absenz', whenText, 'Absenzmeldung offen', estimate && estimate.rule !== 'booked' ? `geschätzt ${estimate.points} Punkte` : '', left]
  } else if (Number.isFinite(absence.points)) {
    parts = [absence.reason || 'Absenz', whenText, `${pointsText(absence.points)} Punkte gebucht`, left]
  } else {
    parts = [absence.subject || 'Absenz', whenText, absence.reason, absence.excused ? 'entschuldigt' : 'nicht entschuldigt']
  }
  return parts.filter(Boolean).join(' · ')
}

// ---------------------------------------------------------------------------------------------
// When the server reads Schulnetz. News should reach the phone within a few minutes on school days
// without loading Schulnetz (or the server) at night, on weekends or in holidays. Strictly read-only
// as before: every read is the same GET sequence.

/** School days, 06:00–22:00 Europe/Zurich: the configured base (FANOTES_SCHULNETZ_POLL_MS), kept within 2–5 minutes. */
export const POLL_SCHOOL_MIN_MS = 2 * 60_000
export const POLL_SCHOOL_MAX_MS = 5 * 60_000
export const POLL_SCHOOL_DEFAULT_MS = 150_000
/** Saturday and Sunday daytime. */
export const POLL_WEEKEND_MS = 15 * 60_000
/** 22:00–06:00 and school holidays. */
export const POLL_QUIET_MS = 30 * 60_000
/** Failed reads back off exponentially up to this. */
export const POLL_MAX_BACKOFF_MS = 60 * 60_000
/** Each wait varies by up to this share either way, so accounts never line up into bursts. */
export const POLL_JITTER = 0.2
/** At least this long between two accounts' reads in one round. */
export const POLL_SPACING_MS = 5_000

const zurichParts = (now) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Zurich', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]))
  return { weekday: parts.weekday, hour: Number(parts.hour), minute: Number(parts.minute) }
}

/**
 * school, weekend, night or holiday for [now] (Europe/Zurich). A holiday is a day inside one of the
 * snapshot's vacations, or a week the timetable was read for and that has no lessons.
 */
export const pollPhase = (now, snapshot = null) => {
  const { weekday, hour } = zurichParts(now)
  if (hour < 6 || hour >= 22) return 'night'
  if (weekday === 'Sat' || weekday === 'Sun') return 'weekend'
  const today = zurichToday(now)
  const vacation = (snapshot?.vacations || []).some((item) => {
    const start = eventDate(item?.start || '')
    const end = eventDate(item?.end || '') || start
    return start && today >= start && today <= end
  })
  if (vacation) return 'holiday'
  const monday = weekMonday(today)
  const lessons = (snapshot?.events || []).some((event) => isLesson(event) && weekMondayKey(event.start) === monday)
  if (snapshot?.weekRead?.[monday] && !lessons) return 'holiday'
  return 'school'
}

/**
 * Milliseconds until the account's next read. [failures] consecutive failed reads double the wait
 * (at most an hour). The last night hour never waits past 06:00, so the school day starts fresh.
 */
export const pollDelayMs = ({ now = new Date(), snapshot = null, failures = 0, baseMs = POLL_SCHOOL_DEFAULT_MS, random = Math.random } = {}) => {
  const phase = pollPhase(now, snapshot)
  const school = Math.min(POLL_SCHOOL_MAX_MS, Math.max(POLL_SCHOOL_MIN_MS, Number(baseMs) || POLL_SCHOOL_DEFAULT_MS))
  let wait = phase === 'school' ? school : phase === 'weekend' ? POLL_WEEKEND_MS : POLL_QUIET_MS
  if (failures > 0) wait = Math.min(POLL_MAX_BACKOFF_MS, wait * 2 ** Math.min(failures, 6))
  wait = Math.round(wait * (1 + (random() * 2 - 1) * POLL_JITTER))
  const { weekday, hour, minute } = zurichParts(now)
  if (failures === 0 && hour === 5 && weekday !== 'Sat' && weekday !== 'Sun') {
    const untilSix = (60 - minute) * 60_000
    wait = Math.min(wait, untilSix + Math.round(random() * 60_000))
  }
  return Math.max(30_000, wait)
}

/**
 * The grade promise: a new grade reaches the phone within 10 minutes of appearing in Schulnetz, every
 * day and every hour. Between full reads each account gets a grade check (start page and grades page,
 * GET only) at most every 3.5 min ±12.5 % (≤ 4 min), with no backoff, so even with a scheduler tick
 * (15 s), a queue of accounts, a sign-in refresh and the push there is room left in the 10 minutes.
 */
export const GRADE_SLA_MS = 10 * 60_000
export const GRADE_CHECK_MS = 210_000
export const GRADE_CHECK_JITTER = 0.125
export const gradeCheckDelayMs = (random = Math.random) => Math.round(GRADE_CHECK_MS * (1 + (random() * 2 - 1) * GRADE_CHECK_JITTER))

/**
 * Due-time scheduler for the poller. [tick] reads every account whose time has come, one after the
 * other with [spacingMs] between them, and plans each next read with [pollDelayMs]. New accounts
 * start staggered, so a restart is not a burst.
 */
export const createPollScheduler = ({ listAccounts, pollAccount, readSnapshot, now = () => new Date(), baseMs = POLL_SCHOOL_DEFAULT_MS, random = Math.random, spacingMs = POLL_SPACING_MS, sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)), log = () => {} }) => {
  const due = new Map()
  const gradeDue = new Map()
  const failures = new Map()
  const tick = async () => {
    const accounts = await listAccounts()
    const started = now().getTime()
    accounts.forEach((accountId, index) => {
      if (!due.has(accountId)) due.set(accountId, started + index * 10_000)
      if (!gradeDue.has(accountId)) gradeDue.set(accountId, started + index * 10_000)
    })
    for (const accountId of [...due.keys()]) if (!accounts.includes(accountId)) { due.delete(accountId); gradeDue.delete(accountId); failures.delete(accountId) }
    let polled = 0
    // Only reads that reached Schulnetz are spaced apart; an identity without a link is skipped at once.
    let contacted = false
    for (const accountId of accounts) {
      const at = now().getTime()
      const full = due.get(accountId) <= at
      const gradesOnly = !full && gradeDue.get(accountId) <= at
      if (!full && !gradesOnly) continue
      if (contacted && spacingMs > 0) await sleep(spacingMs)
      polled += 1
      let failed = false
      contacted = false
      try {
        const result = await pollAccount(accountId, gradesOnly ? { gradesOnly: true } : {})
        failed = Boolean(result?.failed)
        contacted = !result?.skipped
      } catch (error) {
        failed = true
        contacted = true
        log('warn', `Konto ${accountId.slice(0, 8)} nicht aktualisiert (${error?.status || error?.name || 'error'})`)
      }
      // Grade checks never back off: the 10-minute promise holds through a failing read.
      gradeDue.set(accountId, now().getTime() + gradeCheckDelayMs(random))
      if (!full) continue
      const count = failed ? (failures.get(accountId) || 0) + 1 : 0
      failures.set(accountId, count)
      const snapshot = await readSnapshot(accountId).catch(() => null)
      due.set(accountId, now().getTime() + pollDelayMs({ now: now(), snapshot, failures: count, baseMs, random }))
    }
    return polled
  }
  return { tick, due, gradeDue, failures }
}
