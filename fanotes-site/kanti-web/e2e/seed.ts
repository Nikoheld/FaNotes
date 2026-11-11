// Synthetic data and the app-side calls that put it on the local server (HTTP only, like the app does).
import { pbkdf2Sync, randomBytes } from 'node:crypto'

export const SUBJECT = 'Testfach Alpha'
export const GRADE_TITLE = 'E2E Prüfung Alpha'
export const EXAM_TOPIC = 'E2E Klausur Beta'
export const ABSENCE_REASON = 'E2E Arztbesuch'
export const MESSAGE_TITLE = 'E2E Mitteilung Gamma'
export const CANCELLED_SUBJECT = 'E2E Entfall Delta'
export const CHANGED_SUBJECT = 'E2E Vertretung Epsilon'
export const SUBSTITUTE = 'Lehrperson Y'
export const PASSWORD = 'e2e-synthetic-password'

const DEVICE = '0123456789abcdef01234567'
const day = (offset: number) => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Monday of the current week, then Monday to Friday lessons plus today, an exam, an absence and a message. */
export const snapshot = () => {
  const weekday = (new Date().getDay() + 6) % 7
  const monday = -weekday
  const lessons: Record<string, unknown>[] = [0, 1, 2, 3, 4, weekday].map((offset, index) => ({
    id: `e2e-lesson-${index}`, eventType: 'lesson', start: `${day(monday + (index === 5 ? weekday : offset))}T09:40:00`, end: `${day(monday + (index === 5 ? weekday : offset))}T10:25:00`,
    text: SUBJECT, courseName: SUBJECT, courseId: 'ALPHA-1', room: 'X101', teachers: ['Lehrperson X'], status: '', comment: '',
  }))
  // Two more lessons today: one cancelled (struck through in Schulnetz) and one changed with a substitute.
  const marked = (id: string, subject: string, hour: string, fields: Record<string, unknown>) => ({
    id, eventType: 'lesson', start: `${day(0)}T${hour}:00:00`, end: `${day(0)}T${hour}:45:00`,
    text: subject, courseName: subject, courseId: id.toUpperCase(), room: 'X103', teachers: ['Lehrperson X'], status: '', comment: '', ...fields,
  })
  lessons.push(
    marked('e2e-cancelled', CANCELLED_SUBJECT, '11', { status: 'cancelled', marker: 'cancelled' }),
    marked('e2e-changed', CHANGED_SUBJECT, '12', { marker: 'changed', substitute: SUBSTITUTE }),
  )
  return {
    fetchedAt: new Date().toISOString(),
    gradesReadComplete: true,
    grades: [{ id: 'e2e-g1', course: 'ALPHA-1', courseId: 'ALPHA-1', subject: SUBJECT, title: GRADE_TITLE, date: day(-10), mark: 5.25, weight: 1, comment: '', confirmed: true, courseGrade: 5.25 }],
    events: lessons,
    exams: [{ id: 'e2e-exam1', eventType: 'exam', start: `${day(3)}T10:30:00`, end: `${day(3)}T11:15:00`, text: `${SUBJECT}: ${EXAM_TOPIC}`, comment: EXAM_TOPIC, courseName: SUBJECT, courseId: 'ALPHA-1', room: 'X102', teachers: ['Lehrperson X'], status: '' }],
    absences: [{ id: 'e2e-a1', dateFrom: day(-5), dateTo: day(-5), hourFrom: '', hourTo: '', subject: '', reason: ABSENCE_REASON, excused: true, acknowledged: true, status: 'gebucht', points: 2 }],
    absenceQuota: 30,
    absenceRemaining: 28,
    homework: [],
    messages: [{ id: 'e2e-m1', title: MESSAGE_TITLE, body: 'Synthetische Mitteilung fuer den End-to-End-Test.', at: new Date().toISOString() }],
    vacations: [],
    konto: [],
    startMessages: [],
  }
}

const link = {
  mode: 'web', baseUrl: 'https://www.schulnetz-ag.ch/aksa', deviceId: DEVICE, userAgent: 'KantiTest',
  ssoCookies: { 'login.microsoftonline.com': 'ESTSAUTHPERSISTENT=synthetic-cookie-value' },
}

type Headers = Record<string, string>
const request = async (base: string, headers: Headers, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  if (response.status >= 400) throw new Error(`${method} ${path} -> ${response.status}`)
  return text ? JSON.parse(text) : null
}

/** An app identity (anonymous guest) with a web link and the synthetic snapshot. */
export const appIdentity = async (base: string) => {
  const guest = await request(base, {}, 'POST', '/api/v1/schulnetz/guest', {})
  const headers = { 'X-Kanti-Guest': guest.accountId, Authorization: `Bearer ${guest.token}` }
  const call = (method: string, path: string, body?: unknown) => request(base, headers, method, `/api/v1/schulnetz${path}`, body)
  await call('PUT', '/link', link)
  await call('PUT', '/snapshot', snapshot())
  return { call }
}

/** A FaNotes account registered through the sync API, with the same kind of school link and snapshot. */
export const fanotesAccount = async (base: string) => {
  const email = `e2e-${randomBytes(4).toString('hex')}@example.test`
  const kdf = { algorithm: 'pbkdf2-sha256', iterations: 600_000, salt: randomBytes(16).toString('base64') }
  // Same derivation as the apps and the browser: PBKDF2-SHA256 over the NFKC password, bytes 32..64.
  const authKey = pbkdf2Sync(PASSWORD.normalize('NFKC'), Buffer.from(kdf.salt, 'base64'), kdf.iterations, 64, 'sha256').subarray(32, 64).toString('base64')
  const account = await request(base, {}, 'POST', '/api/v1/sync/register', {
    email, authKey, kdf,
    vaultKeyWrap: { iv: randomBytes(12).toString('base64'), data: randomBytes(48).toString('base64') },
    device: { name: 'E2E', platform: 'android' },
  })
  const headers = { Authorization: `Bearer ${account.token}`, 'X-FaNotes-Account': account.accountId }
  await request(base, headers, 'PUT', '/api/v1/schulnetz/link', link)
  await request(base, headers, 'PUT', '/api/v1/schulnetz/snapshot', snapshot())
  return { email }
}

// ---- Pendelstrecken: mocked commute endpoints (synthetic stops, one cancelled trip with an alternative) ----

const iso = (minutes: number) => {
  const date = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + minutes * 60_000)
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date)
  const p: Record<string, string> = {}
  for (const part of parts) p[part.type] = part.value
  const offset = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(date.getTime() / 1000) * 1000) / 60_000)
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`
}

export const COMMUTE_STOPS = [
  { id: 'e2e-testdorf', name: 'Testdorf Bahnhof', type: 'train' },
  { id: 'e2e-schulstadt', name: 'Schulstadt Bahnhof', type: 'train' },
]

const point = (stop: { id: string; name: string }, minutes: number, platform: string) => ({ name: stop.name, stopId: stop.id, time: iso(minutes), planned: iso(minutes), delay: 0, platform, platformChanged: false })
const trip = (id: string, minutes: number, extra: Record<string, unknown> = {}) => ({
  id, departure: iso(minutes), arrival: iso(minutes + 20), plannedDeparture: iso(minutes), plannedArrival: iso(minutes + 20), depDelay: 0, arrDelay: 0, minutes: 20, transfers: 0,
  status: 'ok', changes: [], occupancy: { first: 1, second: 2 }, issues: [], quietest: false,
  legs: [{ kind: 'ride', line: 'S29', category: 'S', type: 'train', operator: 'E2E', direction: 'Schulstadt', fgColor: 'ffffff', bgColor: '1f6fb5', from: point(COMMUTE_STOPS[0], minutes, '3'), to: point(COMMUTE_STOPS[1], minutes + 20, '1'), occupancy: { first: 1, second: 2 }, cancelled: false, notes: [], minutes: 20 }],
  ...extra,
})

/** The board for a saved route: the first trip is cancelled, the second is the alternative. */
export const commuteBoard = (routeId: string) => {
  const cancelled = trip('e2e-cancelled', 10, { status: 'cancelled', issues: [{ kind: 'cancelled', text: 'Zug fällt aus (E2E)' }] })
  const alternative = trip('e2e-alt', 25, { quietest: true })
  return {
    routeId,
    target: { kind: 'now', at: iso(0), timeType: 'depart', lesson: null, lessonChange: 'none', plannedAt: null },
    trips: [cancelled, alternative], alternatives: [alternative], viaDropped: false, updatedAt: iso(0), stale: false,
  }
}
