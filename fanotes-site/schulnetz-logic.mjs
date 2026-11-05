// Pure Schulnetz parsing, grade maths, diffing and the read-only allow-list.
// The phone app has the same rules in android/core/.../schulnetz. Keep the
// change-id formula identical: category:entityId:key.

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

export const parseKontoauszug = (html) => {
  if (!html) return []
  const cleaned = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  const lines = []
  for (const row of cleaned.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => htmlText(cell[1])).filter(Boolean)
    if (cells.length < 3 || !/\d{1,2}\.\d{1,2}\.\d{2,4}/.test(cells[0])) continue
    lines.push({ date: cells[0], label: cells[1], amount: cells[2], balance: cells[3] || '' })
  }
  return lines
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

export const isSubstitution = (event) => ['substitution', 'vertretung', 'suppl', 'supply', 'stellvertretung']
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

export const mergeEventsById = (base, incoming) => {
  const extra = incoming || []
  if (!extra.length) return base || []
  const incomingById = new Map(extra.map((event) => [event.id, event]))
  const seen = new Set()
  const out = []
  for (const event of base || []) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    out.push(incomingById.get(event.id) || event)
  }
  for (const event of extra) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
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
].join('|')

const formatMark = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return '–'
  const rounded = Math.round(Number(value) * 100) / 100
  return rounded.toLocaleString('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

const eventBody = (event) => {
  const time = displayClock(event.start, event.end)
  const room = cleanSchulnetzText(event.room)
  const label = [event.courseName, event.text, event.timetableText].map((part) => cleanSchulnetzText(part)).find((part) => part) || ''
  return [label, time, room ? `Raum ${room}` : '', isCancelled(event) ? 'fällt aus' : '', isSubstitution(event) ? 'Vertretung' : '', cleanSchulnetzText(event.comment)]
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
  const name = cleanSchulnetzText(body.split('·')[0] || '')
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

/**
 * Decide which changes may be announced and which identity keys to store.
 * `ledger === null` means the account has no notified-grades file yet: every
 * grade currently on file is marked seen and none of them are announced.
 * A later mark or weight is a new key and is announced once.
 */
export const settleGradeNotifications = (changes, grades, ledger) => {
  const pool = gradeLedgerEntries(grades)
  if (ledger == null) {
    return {
      changes: (changes || []).filter((change) => change?.category !== 'grade'),
      keys: pool,
      migrated: true,
    }
  }
  const known = new Set(ledger)
  const fresh = []
  for (const change of changes || []) {
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
export const keepLoadedGrades = (previousGrades, nextGrades) => {
  const next = Array.isArray(nextGrades) ? nextGrades : []
  const prev = Array.isArray(previousGrades) ? previousGrades : []
  if (next.length === 0 && prev.length > 0) return prev
  return next
}
export const eventLabel = (event) => cleanSchulnetzText(event.courseName) || cleanSchulnetzText(event.text) || cleanSchulnetzText(event.timetableText) || 'Lektion'
export const eventDay = (event) => eventDayKey(event.start) || String(event.start || '').slice(0, 10)
export const eventClock = (event) => {
  const clock = schulnetzClock(event.start)
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
  return 'events'
}

export const linkedChange = (id, category, title, body, extra = {}) => {
  const targetId = extra.targetId || ''
  const targetIds = extra.targetIds || (targetId ? [targetId] : [])
  const gradeKeys = Array.isArray(extra.gradeKeys) ? extra.gradeKeys.filter((key) => typeof key === 'string' && key) : []
  return {
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
  }
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
  const grades = (changes || []).filter((change) => change.category === 'grade')
  if (grades.length <= 1) return changes || []
  const rest = (changes || []).filter((change) => change.category !== 'grade')
  const ids = [...new Set(grades.flatMap((change) => change.targetIds || String(change.targetId || '').split(',').filter(Boolean)))]
  const courses = [...new Set(grades.map((change) => change.courseId).filter(Boolean))]
  const gradeKeys = [...new Set(grades.flatMap((change) => change.gradeKeys || []))]
  return [linkedChange(`grades:${ids.slice().sort().join(',')}`, 'grade', `${grades.length} neue Noten`, grades.map((change) => change.body).join('\n'), {
    target: 'grades',
    targetId: ids.join(','),
    courseId: courses.length === 1 ? courses[0] : '',
    targetIds: ids,
    gradeKeys,
  }), ...rest]
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

export const diffSnapshots = (previous, next, settings = {}, today = zurichToday()) => {
  if (!previous) return []
  const freshWeeks = introducedWeeks(previous, next)
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
    diffAgenda((previous.events || []).filter(isLesson), (next.events || []).filter(isLesson), 'timetable', 'Stundenplan geändert', 'Lektion entfernt', changes, freshWeeks, [], [], next.exams || [])
  }
  if (prefs.exams) diffAgenda(previous.exams || [], next.exams || [], 'exam', 'Neue Prüfung', 'Prüfung entfällt', changes, freshWeeks, previous.events || [], next.events || [], [])
  if (prefs.absences) {
    const before = new Set((previous.absences || []).map((item) => item.id))
    for (const absence of next.absences || []) {
      if (before.has(absence.id)) continue
      const whenText = [absence.dateFrom, absence.hourFrom].filter(Boolean).join(' ')
      changes.push(linkedChange(`absence:${absence.id}`, 'absence', 'Neue Absenz', [absence.subject || 'Absenz', whenText, absence.reason, absence.excused ? 'entschuldigt' : 'nicht entschuldigt'].filter(Boolean).join(' · '), {
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
    for (const event of next.events || []) {
      if (freshWeeks.has(weekMondayKey(event.start))) continue
      if (isLesson(event) || isExamLike(event) || beforeEvents.has(event.id)) continue
      if (knownEvents.some((known) => sameSchoolSlot(event, known))) continue
      const body = eventBody(event)
      if (!body) continue
      changes.push(linkedChange(`event:${event.id}:${eventKey(event)}`, 'event', 'Neuer Termin', body, {
        targetId: lessonTargetId(event),
        courseId: event.courseId || eventLabel(event),
        date: eventDay(event),
      }))
    }
  }
  return deduped(changes)
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
    const key = gradeKey(grade)
    const course = grade.course || grade.subject || grade.courseId || 'Kurs'
    changes.push(linkedChange(`grade:${grade.id}:${key}`, 'grade', matched ? 'Notenänderung' : 'Neue Note', `${course} · ${grade.title || 'Note'} · ${formatMark(grade.mark)} · Gewicht ${formatMark(grade.weight)}`, {
      targetId: gradeTargetId(grade),
      courseId: courseKeyOf(grade),
      date: grade.date || '',
      gradeKeys: gradeNotifyKeys(grade, nextLooseCounts.get(loose) === 1),
    }))
  }
}

const diffAgenda = (previous, next, category, created, removed, changes, skipWeeks = new Set(), adoptFrom = [], stillThere = [], spareAgainst = []) => {
  const before = new Map(previous.map((event) => [event.id, event]))
  const after = new Set(next.map((event) => event.id))
  for (const event of next) {
    const old = before.get(event.id)
    if (!old && skipWeeks.has(weekMondayKey(event.start))) continue
    const adopted = old ? null : adoptFrom.find((candidate) => sameSchoolSlot(event, candidate) && !stillThere.some((item) => item.id === candidate.id))
    if (!old && adopted && !schoolEventMoved(adopted, event)) continue
    const slotTwin = !old && category === 'timetable' ? previous.find((candidate) => sameLessonSlot(event, candidate)) : null
    const prior = old || slotTwin
    if (prior && category === 'timetable' && !lessonContentChanged(prior, event)) continue
    const key = eventKey(event)
    if (old && eventKey(old) === key) continue
    let title
    if (!prior && adopted) title = 'Prüfung verschoben'
    else if (!prior) title = category === 'exam' ? 'Neue Prüfung' : created
    else if (isCancelled(event) && !isCancelled(prior)) title = category === 'exam' ? 'Prüfung fällt aus' : 'Lektion fällt aus'
    else if ((event.teachers || []).join() !== (prior.teachers || []).join() || (isSubstitution(event) && !isSubstitution(prior))) title = 'Vertretung'
    else if (category === 'exam' && (event.start !== prior.start || event.room !== prior.room)) title = 'Prüfung verschoben'
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
    if (after.has(event.id)) continue
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

export const parseGradesHtml = (html) => {
  const grades = []
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi
  for (const row of String(html).matchAll(rowRe)) {
    const cells = [...row[1].matchAll(cellRe)].map((cell) => clean(cell[1]))
    const date = cells.find((cell) => /^\d{2}\.\d{2}\.\d{4}$/.test(cell))
    if (!date) continue
    const dateAt = cells.indexOf(date)
    const topic = cells[dateAt + 1] || 'Note'
    if (isSummaryGradeTitle(topic) || cells.some((cell) => isSummaryGradeTitle(cell))) continue
    const mark = parseMark(cells[dateAt + 2] || '')
    if (mark == null) continue
    const courseMatch = String(html).match(/<b>\s*([^<]*-[^<]*-[^<]*)\s*<\/b>/i)
    const course = clean(courseMatch?.[1] || 'Kurs')
    grades.push({
      id: `web:${course}:${date}:${topic}:${numKey(mark)}`,
      course,
      courseId: course,
      subject: course,
      title: topic,
      date: `${date.slice(6, 10)}-${date.slice(3, 5)}-${date.slice(0, 2)}`,
      mark,
      weight: parseWeight(cells[dateAt + 3] || '1'),
      confirmed: true,
      courseGrade: null,
      comment: '',
    })
  }
  return grades
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
    const course = field('kurskuerzel') || field('fachkuerzel') || field('text')
    const startIso = schedulerTime(start)
    const endIso = schedulerTime(end)
    events.push({
      id: id || field('identity') || `sched:${startIso}:${course}`,
      start: startIso,
      end: endIso,
      text: field('text'),
      comment,
      room: field('zimmerkuerzel') || field('zimmer'),
      teachers: field('lehrerkuerzelname') ? [field('lehrerkuerzelname')] : [],
      courseId: field('kursid'),
      courseName: course,
      status: /fällt|faellt/iu.test(comment) ? 'cancelled' : '',
      eventType: canonicalEventType(field('event_type')),
      color: field('color'),
      timetableText: field('text'),
    })
  }
  return events
}

/** Next Terminliste page (`sRow`), not a filter, sort, show-all, or the page just loaded. */
export const terminlisteNextUrl = (html, baseUrl, currentRow = 0) => {
  let best = null
  let bestRow = 0
  for (const match of String(html || '').matchAll(/href\s*=\s*["']([^"']+)["']/giu)) {
    const href = match[1].replace(/&amp;/gu, '&')
    if (!href.includes('pageid=22108') || !href.includes('sRow=')) continue
    if (href.includes('ff') || href.includes('sort=') || href.includes('action=') || href.includes('numRows=')) continue
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

export const extractWebIds = (url, html) => {
  const blob = `${url}\n${html}`
  const id = /[?&]id=([a-f0-9]{4,})/i.exec(blob)?.[1] || ''
  const transid = /[?&]transid=([a-f0-9]{4,})/i.exec(blob)?.[1] || ''
  return id && transid ? { id, transid } : null
}

export const WEEK_ADJACENT_MS = 30 * 60 * 1000
export const WEEK_FAR_MS = 24 * 60 * 60 * 1000
export const WEEK_CAP = 48

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

/** A missing limit stays null. Callers then keep the current week. */
export const parseWeekSpan = (html) => {
  const scriptStart = limitDate(html, 'start')
  const scriptEnd = limitDate(html, 'end')
  if (scriptStart && scriptEnd && scriptEnd >= scriptStart) return { start: scriptStart, end: scriptEnd }
  const min = dataDate(html, 'min')
  const max = dataDate(html, 'max')
  if (min && max && max >= min) return { start: min, end: max }
  return null
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

export const planWeekFetches = ({ mondays = [], fetchedAt = {}, icalFetchedAt = '', now, today, icalAvailable = false } = {}) => {
  const current = weekMonday(today)
  const universe = capMondays(mondays.length ? mondays : [current], today)
  const near = universe.filter((monday) => Math.abs(weekDistance(monday, current)) <= 1)
  const far = universe.filter((monday) => Math.abs(weekDistance(monday, current)) > 1)
  const first = Object.keys(fetchedAt || {}).length === 0 && !icalFetchedAt
  if (first && icalAvailable) return { fetch: near, fetchIcal: true }
  if (first) return { fetch: universe, fetchIcal: false }
  const due = []
  for (const monday of near) {
    if (monday === current || stampAge(fetchedAt[monday], now) >= WEEK_ADJACENT_MS) due.push(monday)
  }
  if (icalAvailable && stampAge(icalFetchedAt, now) >= WEEK_FAR_MS) return { fetch: due, fetchIcal: true }
  const farDue = far.filter((monday) => stampAge(fetchedAt[monday], now) >= WEEK_FAR_MS)
    .sort((left, right) => String(fetchedAt[left] || '').localeCompare(String(fetchedAt[right] || '')))
  if (farDue.length) due.push(farDue[0])
  return { fetch: due, fetchIcal: false }
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
