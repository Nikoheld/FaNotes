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
  grades: safeList(raw.grades).map(parseGrade).filter(Boolean),
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

export const diffSnapshots = (previous, next, settings = {}) => {
  if (!previous) return []
  const prefs = {
    grades: settings.grades !== false,
    timetable: settings.timetable !== false,
    exams: settings.exams !== false,
    absences: settings.absences !== false,
    events: settings.events !== false,
  }
  const changes = []
  if (prefs.grades) {
    const before = new Map((previous.grades || []).map((grade) => [grade.id, grade]))
    for (const grade of next.grades || []) {
      const old = before.get(grade.id)
      const key = gradeKey(grade)
      if (old && gradeKey(old) === key) continue
      const course = grade.course || grade.subject || grade.courseId || 'Kurs'
      changes.push({
        id: `grade:${grade.id}:${key}`,
        category: 'grade',
        title: old ? 'Notenänderung' : 'Neue Note',
        body: `${course} · ${grade.title || 'Note'} · ${formatMark(grade.mark)} · Gewicht ${formatMark(grade.weight)}`,
      })
    }
  }
  if (prefs.timetable) {
    diffAgenda((previous.events || []).filter(isLesson), (next.events || []).filter(isLesson), 'timetable', 'Stundenplan geändert', 'Lektion entfernt', changes)
  }
  if (prefs.exams) diffAgenda(previous.exams || [], next.exams || [], 'exam', 'Neue Prüfung', 'Prüfung entfällt', changes)
  if (prefs.absences) {
    const before = new Set((previous.absences || []).map((item) => item.id))
    for (const absence of next.absences || []) {
      if (before.has(absence.id)) continue
      const whenText = [absence.dateFrom, absence.hourFrom].filter(Boolean).join(' ')
      changes.push({
        id: `absence:${absence.id}`,
        category: 'absence',
        title: 'Neue Absenz',
        body: [absence.subject || 'Absenz', whenText, absence.reason, absence.excused ? 'entschuldigt' : 'nicht entschuldigt'].filter(Boolean).join(' · '),
      })
    }
  }
  if (prefs.events) {
    const beforeMessages = new Set((previous.messages || []).map((item) => item.id))
    for (const message of next.messages || []) {
      if (beforeMessages.has(message.id)) continue
      changes.push({ id: `event:${message.id}`, category: 'event', title: message.title || 'Neue Mitteilung', body: message.body || message.title || '' })
    }
    const beforeEvents = new Set((previous.events || []).map((item) => item.id))
    for (const event of next.events || []) {
      if (isLesson(event) || isExamLike(event) || beforeEvents.has(event.id)) continue
      changes.push({ id: `event:${event.id}:${eventKey(event)}`, category: 'event', title: 'Neuer Termin', body: eventBody(event) })
    }
  }
  return changes
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
    else if ((event.teachers || []).join() !== (old.teachers || []).join() || isSubstitution(event)) title = 'Vertretung'
    else if (category === 'exam' && (event.start !== old.start || event.room !== old.room)) title = 'Prüfung verschoben'
    else title = category === 'exam' ? 'Prüfung geändert' : 'Stundenplan geändert'
    changes.push({ id: `${category}:${event.id}:${key}`, category, title, body: eventBody(event) })
  }
  for (const event of previous) {
    if (after.has(event.id)) continue
    changes.push({ id: `${category}:${event.id}:removed`, category, title: removed, body: eventBody(event) })
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
    return !query.includes('action=') && (query.includes('pageid=22202') || query.includes('ansicht=schueleransicht'))
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

export const sessionProblem = (url, html) => {
  const blob = `${url}\n${html}`.toLowerCase()
  if (blob.includes('ip-adresse wurde vom system zurückgewiesen') || blob.includes('ip-adresse wurde vom system zurueckgewiesen')) return 'ip'
  if (blob.includes('inaktivitätslimit') || blob.includes('inaktivitaetslimit') || blob.includes('mode=5')) return 'inactivity'
  if (String(url).toLowerCase().includes('loginto.php')) return 'login'
  return ''
}

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
