// Pure Schulnetz parsing, grade maths, diffing and the read-only allow-list.
// The phone app has the same rules in android/core/.../schulnetz. Keep the
// change-id formula identical: category:entityId:key.

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

export const isExamLike = (event) => {
  const kind = (event.eventType || '').toLowerCase()
  return kind.includes('exam') || kind.includes('prüfung') || kind.includes('pruefung') || kind.includes('klausur')
}

export const isLesson = (event) => {
  if (isExamLike(event)) return false
  const kind = (event.eventType || '').toLowerCase()
  if (!kind) return true
  return kind.includes('lesson') || kind.includes('unterricht') || kind.includes('timetable') || kind === 'period' || kind === 'stunde'
}

const gradeKey = (grade) => [numKey(grade.mark), numKey(grade.weight), grade.title || '', grade.date || ''].join('|')

const eventKey = (event) => [
  event.start || '', event.end || '', event.room || '', event.status || '', event.text || '',
  (event.teachers || []).join(','), isCancelled(event) ? 'aus' : 'da', event.courseName || '',
].join('|')

const formatMark = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return '–'
  const rounded = Math.round(Number(value) * 100) / 100
  return rounded.toLocaleString('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

const eventBody = (event) => {
  const start = (event.start || '').split('T')[1]?.slice(0, 5) || ''
  const end = (event.end || '').split('T')[1]?.slice(0, 5) || ''
  const time = !start ? '' : !end || end === start ? start : `${start}–${end}`
  const label = event.courseName || event.text || event.timetableText || 'Lektion'
  return [label, time, event.room ? `Raum ${event.room}` : '', isCancelled(event) ? 'fällt aus' : '', isSubstitution(event) ? 'Vertretung' : '', event.comment || '']
    .filter(Boolean)
    .join(' · ')
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
export const eventLabel = (event) => event.courseName || event.text || event.timetableText || 'Lektion'
export const eventDay = (event) => (event.start || '').slice(0, 10)
export const eventClock = (event) => (event.start || '').includes('T') ? (event.start || '').split('T')[1].slice(0, 5) : ''
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
    const event = found[0]
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
    diffAgenda((previous.events || []).filter(isLesson), (next.events || []).filter(isLesson), 'timetable', 'Stundenplan geändert', 'Lektion entfernt', changes)
  }
  if (prefs.exams) diffAgenda(previous.exams || [], next.exams || [], 'exam', 'Neue Prüfung', 'Prüfung entfällt', changes)
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
    for (const message of next.messages || []) {
      if (beforeMessages.has(message.id)) continue
      changes.push(linkedChange(`event:${message.id}`, 'event', message.title || 'Neue Mitteilung', message.body || message.title || '', { targetId: messageTargetId(message) }))
    }
    const beforeEvents = new Set((previous.events || []).map((item) => item.id))
    for (const event of next.events || []) {
      if (isLesson(event) || isExamLike(event) || beforeEvents.has(event.id)) continue
      changes.push(linkedChange(`event:${event.id}:${eventKey(event)}`, 'event', 'Neuer Termin', eventBody(event), {
        targetId: lessonTargetId(event),
        courseId: event.courseId || eventLabel(event),
        date: eventDay(event),
      }))
    }
  }
  return changes
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

const diffAgenda = (previous, next, category, created, removed, changes) => {
  const before = new Map(previous.map((event) => [event.id, event]))
  const after = new Set(next.map((event) => event.id))
  for (const event of next) {
    const old = before.get(event.id)
    const key = eventKey(event)
    if (old && eventKey(old) === key) continue
    let title
    if (!old) title = category === 'exam' ? 'Neue Prüfung' : created
    else if (isCancelled(event) && !isCancelled(old)) title = category === 'exam' ? 'Prüfung fällt aus' : 'Lektion fällt aus'
    else if ((event.teachers || []).join() !== (old.teachers || []).join() || (isSubstitution(event) && !isSubstitution(old))) title = 'Vertretung'
    else if (category === 'exam' && (event.start !== old.start || event.room !== old.room)) title = 'Prüfung verschoben'
    else if (event.room !== old.room && (event.start !== old.start || event.end !== old.end)) title = category === 'exam' ? 'Prüfung geändert' : 'Stundenplan geändert'
    else if (event.room !== old.room) title = 'Raum geändert'
    else if (event.start !== old.start || event.end !== old.end) title = 'Zeit geändert'
    else title = category === 'exam' ? 'Prüfung geändert' : 'Stundenplan geändert'
    changes.push(linkedChange(`${category}:${event.id}:${key}`, category, title, eventBody(event), {
      targetId: lessonTargetId(event),
      courseId: event.courseId || eventLabel(event),
      date: eventDay(event),
    }))
  }
  for (const event of previous) {
    if (after.has(event.id)) continue
    changes.push(linkedChange(`${category}:${event.id}:removed`, category, removed, eventBody(event), {
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

export const schulnetzCallAllowed = (method, url, body = '') => {
  const verb = String(method || '').toUpperCase()
  if (!['GET', 'HEAD', 'POST'].includes(verb)) return false
  let parsed
  try { parsed = new URL(url) } catch { return false }
  if (parsed.protocol !== 'https:') return false
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
  if (!/^[a-z0-9.-]+$/.test(host)) return null
  const allowed = host === 'schulnetz.web.app' || host.endsWith('.schulnetz-ag.ch') || host.endsWith('.schulnetz.ch') || host.endsWith('.schulnetz.com') || host.startsWith('schulnetz.')
  if (!allowed) return null
  return `https://${host}${parsed.pathname.replace(/\/+$/, '')}`
}

export const redactSecrets = (value) => String(value ?? '')
  .replace(/refresh_token=[^&\s]+/gi, 'refresh_token=[redacted]')
  .replace(/access_token=[^&\s]+/gi, 'access_token=[redacted]')
  .replace(/code_verifier=[^&\s]+/gi, 'code_verifier=[redacted]')
  .replace(/PHPSESSID=[^;\s]+/gi, 'PHPSESSID=[redacted]')
  .replace(/ESTSAUTH[A-Z]*=[^;\s]+/gi, 'ESTSAUTH=[redacted]')
  .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')

export const usesWebsiteSession = (baseUrl) => {
  try { return new URL(baseUrl).hostname.toLowerCase().endsWith('schulnetz-ag.ch') } catch { return false }
}

const IP_REJECTED_TEXT = [
  'ihre ip-adresse wurde vom system zurückgewiesen',
  'ihre ip-adresse wurde vom system zurueckgewiesen',
]
const INACTIVITY_TEXT = [
  'inaktivitätslimit überschritten',
  'inaktivitaetslimit ueberschritten',
]

const schoolHost = (host) => host === 'schulnetz-ag.ch' || host.endsWith('.schulnetz-ag.ch') || host.endsWith('.schulnetz.ch') || host.endsWith('.schulnetz.com')

/** Final URL, a missing page id, or the exact inactivity / IP sentence. Menu logout links are not a signal. */
export const sessionProblem = (url, html) => {
  const text = String(html || '')
  let parsed = null
  try { parsed = new URL(String(url || 'https://invalid.local')) } catch { parsed = null }
  const host = parsed?.hostname?.toLowerCase() || ''
  if (host === 'login.microsoftonline.com' || host === 'login.microsoft.com' || host === 'login.live.com' || host.endsWith('.login.microsoftonline.com')) return 'microsoft'
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

export const parseSchedulerXml = (xml) => {
  const events = []
  for (const block of String(xml).matchAll(/<event\b([^>]*)>([\s\S]*?)<\/event>/gi)) {
    const id = /id="([^"]+)"/.exec(block[1])?.[1] || ''
    const field = (name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(block[2])?.[1]?.trim() || ''
    const start = field('start_date').replace(' ', 'T')
    if (!start) continue
    const end = field('end_date').replace(' ', 'T') || start
    const comment = field('kommentar')
    const course = field('kurskuerzel') || field('text')
    events.push({
      id: id || `sched:${start}:${course}`,
      start: start.length === 16 ? `${start}:00` : start,
      end: end.length === 16 ? `${end}:00` : end,
      text: field('text'),
      comment,
      room: field('zimmerkuerzel') || field('zimmer'),
      teachers: field('lehrerkuerzelname') ? [field('lehrerkuerzelname')] : [],
      courseId: field('kursid'),
      courseName: course,
      status: /fällt|faellt|aus/i.test(comment) ? 'cancelled' : '',
      eventType: field('event_type') || 'lesson',
      color: field('color'),
      timetableText: field('text'),
    })
  }
  return events
}

export const extractWebIds = (url, html) => {
  const blob = `${url}\n${html}`
  const id = /[?&]id=([a-f0-9]{4,})/i.exec(blob)?.[1] || ''
  const transid = /[?&]transid=([a-f0-9]{4,})/i.exec(blob)?.[1] || ''
  return id && transid ? { id, transid } : null
}
