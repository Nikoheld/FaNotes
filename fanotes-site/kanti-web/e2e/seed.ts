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
// Calendar days in Zurich, like the browser (timezoneId) and the server, whatever TZ the runner has:
// a UTC runner is still on the previous day from 00:00 to 01:00/02:00 Zurich time.
const zurichToday = () => {
  const [year, month, date] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-').map(Number)
  return Date.UTC(year, month - 1, date)
}
const day = (offset: number) => new Date(zurichToday() + offset * 86_400_000).toISOString().slice(0, 10)

/** Monday of the current week, then Monday to Friday lessons plus today, an exam, an absence and a message. */
export const snapshot = () => {
  const weekday = (new Date(zurichToday()).getUTCDay() + 6) % 7
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

// ---- The vault: an account whose files are encrypted exactly like the apps do it ----

import { deriveFromPassword, newKdf, newVaultSecret, wrapVaultSecret } from '../../../fanotes/src/lib/sync/crypto'
import { VaultClient } from '../src/vault/client'
import { createMemoryStore } from '../src/vault/keystore'
import {
  CALENDAR_NOTE_PATH, GRADE_BOOK_PATH, HOMEWORK_NOTE_PATH, emptyCalendar, serializeCalendar, serializeGradeBook, serializeHomework,
} from '../src/vault/files'

export const OWN_MARK_TITLE = 'E2E Eigene Note Zeta'
export const TASK_TITLE = 'E2E Aufgabe Eta'
export const EVENT_TITLE = 'E2E Termin Theta'
export const NOTE_PATH = 'E2E Fach/E2E Notiz Iota.md'
export const NOTE_TEXT = '# E2E Überschrift Kappa\n\nEin **fetter** Text mit [Link](https://example.test) und <script>alert(1)</script>.\n'

const enc = (text: string) => new TextEncoder().encode(text)

/**
 * A FaNotes account with a real vault key (the password wraps a random vault secret), the school link and
 * snapshot like `fanotesAccount`, and own data in the vault: one own mark, one task, one event, one note.
 * `client` is a second device of the same account, to read back what the page wrote.
 */
export const vaultAccount = async (base: string, extra: Record<string, string | Uint8Array> = {}) => {
  const email = `e2e-${randomBytes(4).toString('hex')}@example.test`
  const kdf = newKdf()
  const { wrappingKey, authKey } = await deriveFromPassword(PASSWORD, kdf)
  const vaultKeyWrap = await wrapVaultSecret(newVaultSecret(), wrappingKey)
  const account = await request(base, {}, 'POST', '/api/v1/sync/register', { email, authKey, kdf, vaultKeyWrap, device: { name: 'E2E', platform: 'android' } })
  const headers = { Authorization: `Bearer ${account.token}`, 'X-FaNotes-Account': account.accountId }
  await request(base, headers, 'PUT', '/api/v1/schulnetz/link', link)
  await request(base, headers, 'PUT', '/api/v1/schulnetz/snapshot', snapshot())
  // The registration opened a session without the vault secret. Open the vault as a second device would.
  const client = await VaultClient.login({ email, authKey, wrappingKey, deviceName: 'E2E Gerät' }, { origin: base, store: createMemoryStore() })
  const tomorrow = day(1)
  const files: Record<string, string | Uint8Array> = {
    [GRADE_BOOK_PATH]: serializeGradeBook({ own: [{ id: 'e2e-own-1', courseId: 'ALPHA-1', title: OWN_MARK_TITLE, mark: 6, weight: 1, date: day(-3) }], collective: [], adjustments: [], archivedCourseIds: [] }),
    [HOMEWORK_NOTE_PATH]: serializeHomework({ publishedIds: [], tasks: [{ id: 'e2e-task-1', title: TASK_TITLE, notes: '', subject: SUBJECT, dueDate: tomorrow, dueTime: null, done: false, kind: 'homework', priority: 'normal', createdAt: '', updatedAt: '' }] }),
    [CALENDAR_NOTE_PATH]: serializeCalendar({ ...emptyCalendar(), events: [{ id: 'e2e-event-1', calendarId: 'personal', title: EVENT_TITLE, start: `${day(0)}T16:00`, end: `${day(0)}T17:00`, allDay: false, location: '', notes: '', notePath: '', recurrence: 'none', recurrenceUntil: null, exceptionDates: [] }] }),
    [NOTE_PATH]: NOTE_TEXT,
    ...extra,
  }
  for (const [path, content] of Object.entries(files)) await client.update(path, () => (typeof content === 'string' ? enc(content) : content))
  return { email, client }
}

// ---- Synthetic notes of every kind for the notes view ----

export const PDF_TEXT = 'E2E PDF Omikron'
export const PDF_PATH = 'E2E Fach/E2E Skript.pdf'
export const IMAGE_PATH = 'E2E Fach/E2E Bild.png'
export const AUDIO_PATH = 'E2E Fach/E2E Ton.wav'
export const FAMD_PATH = 'E2E Fach/E2E Handschrift.famd'
export const STORY_PATH = 'E2E Geschichte.story'
export const STORY_TEXT = 'E2E Absatz Rho'

/** A valid one-page PDF with a line of text, built with real xref offsets. */
const pdf = (text: string) => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${`BT /F1 24 Tf 20 100 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 24 Tf 20 100 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

const crc = (text: string) => {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; return c >>> 0 })
  let c = 0xffffffff
  for (const byte of new TextEncoder().encode(text)) c = (table[(c ^ byte) & 255] ^ (c >>> 8)) >>> 0
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

const famd = () => {
  const strokes = [{ points: Array.from({ length: 40 }, (_, i) => ({ x: 0.1 + i * 0.02, y: 0.2 + Math.sin(i / 4) * 0.05, pressure: 0.6 })), baseWidth: 6, color: '#d00000', pressureEnabled: true }]
  const json = JSON.stringify({ schema: 'fanotes-famd-v2', paperStyle: 'grid', ink: { sourceWidth: 900, sourceHeight: 1273, strokes } })
  return `# E2E Handschrift\n<!-- fanotes-famd:v2 chars=${json.length} crc=${crc(json)} -->\n${json}`
}

const wav = () => {
  const samples = 800
  const data = new Uint8Array(44 + samples * 2)
  const view = new DataView(data.buffer)
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i += 1) data[at + i] = value.charCodeAt(i) }
  text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples * 2, true)
  return data
}

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DwnwEJMDIwMAAAKQkCAm8SDVEAAAAASUVORK5CYII=', 'base64'))

export const noteFiles = (): Record<string, string | Uint8Array> => ({
  [PDF_PATH]: pdf(PDF_TEXT),
  [IMAGE_PATH]: PNG,
  [AUDIO_PATH]: wav(),
  [FAMD_PATH]: famd(),
  'E2E Fach/E2E Bildnotiz.md': `# Bildnotiz\n\n![Bild](E2E Bild.png)\n\nSiehe [[E2E Notiz Iota]].\n`,
  [`${STORY_PATH}/story.json`]: JSON.stringify({ format: 'fanotes-story-v1', title: 'E2E Geschichte', binder: [{ id: 'abcdef12', kind: 'scene', title: 'Szene Pi' }] }),
  [`${STORY_PATH}/scenes/abcdef12.json`]: JSON.stringify({ format: 'fanotes-story-scene-v1', id: 'abcdef12', paragraphs: [{ id: 'p1', key: 'a', runs: [{ text: STORY_TEXT }] }] }),
})
