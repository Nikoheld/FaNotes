// Absence points: the server's parser and estimate run the same cases as the app (AbsencePointsTest.kt).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { createSchulnetzRuntime } from './schulnetz-api.mjs'
import {
  ABSENCE_PARSER_VERSION, absenceNoticeBody, absenceSeedRead, absenceTally, diffSnapshots, keepAbsenceRead, parseAbsenceStatement, pointsText, readAbsenceStatement,
} from './schulnetz-logic.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const resources = resolve(here, '../android/core/src/test/resources/schulnetz')
const shared = JSON.parse(readFileSync(resolve(resources, 'absence-points-cases.json'), 'utf8'))
const fixture = (name) => readFileSync(resolve(resources, name), 'utf8')

test('the shared cases estimate like the Reglement', () => {
  assert.ok(shared.cases.length >= 15)
  for (const { name, snapshot, expect } of shared.cases) {
    const tally = absenceTally(snapshot)
    assert.equal(tally.estimated, expect.estimated, name)
    assert.equal(tally.booked, expect.booked, name)
    assert.equal(tally.remaining, expect.remaining, name)
    for (const [id, points] of Object.entries(expect.points)) assert.equal(tally.estimates[id]?.points, points, `${name} ${id}`)
    for (const [id, rule] of Object.entries(expect.rules)) assert.equal(tally.estimates[id]?.rule, rule, `${name} ${id}`)
    const blocks = new Map()
    for (const [id, estimate] of Object.entries(tally.estimates)) if (estimate.block >= 0) blocks.set(estimate.block, [...(blocks.get(estimate.block) || []), id])
    const actual = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, ids]) => ids.sort())
    assert.deepEqual(actual, expect.blocks.map((ids) => [...ids].sort()), name)
  }
})

test('the real layout reads exactly like the app (same ids, times, points and quota)', () => {
  for (const [name, expected] of Object.entries(shared.fixtures)) {
    const statement = readAbsenceStatement(fixture(name))
    assert.equal(statement.read, true, name)
    assert.equal(statement.quota, expected.quota, name)
    assert.equal(statement.remaining, expected.remaining, name)
    assert.deepEqual(statement.absences.map((row) => {
      const out = { id: row.id, dateFrom: row.dateFrom, dateTo: row.dateTo, hourFrom: row.hourFrom, hourTo: row.hourTo, subject: row.subject, reason: row.reason, status: row.status, pending: Boolean(row.pending) }
      if (row.points != null) out.points = row.points
      return out
    }), expected.absences, name)
  }
  // The reason field and the save button of an open report are not part of the row.
  const booked = readAbsenceStatement(fixture('absenzen-aksa-booked.html'))
  assert.ok(!JSON.stringify(booked.absences).includes('Zahnarzt'))
  assert.ok(!JSON.stringify(booked.absences).includes('Speichern'))
  // An older layout or a sign-in page is not read here; the server then keeps what it had.
  assert.equal(readAbsenceStatement(fixture('absenzen.html')).read, false)
  assert.equal(parseAbsenceStatement(''), null)
})

test('the double lesson costs 3 and leaves 27 of 30', () => {
  const statement = readAbsenceStatement(fixture('absenzen-aksa-open.html'))
  const lesson = (id, from, to, course) => ({ id, start: `2026-11-03T${from}:00`, end: `2026-11-03T${to}:00`, text: course, comment: '', room: '', teachers: [], courseId: id, courseName: course, status: '', eventType: '0_stp', color: '', timetableText: course })
  const snapshot = {
    events: [lesson('1', '08:00', '08:45', 'geo 2.3'), lesson('2', '08:45', '09:30', 'geo 2.3'), lesson('3', '09:45', '10:30', 'mat 2.1')],
    exams: [{ id: 'e', start: '2026-11-03T13:15:00', end: '2026-11-03T14:00:00', text: 'bio 2.1 Prüfung', eventType: 'exam', courseName: 'bio 2.1 Prüfung' }],
    absences: statement.absences, absenceQuota: statement.quota, absenceRemaining: statement.remaining, absenceParser: ABSENCE_PARSER_VERSION,
  }
  const tally = absenceTally(snapshot)
  assert.equal(tally.estimated, 3)
  assert.equal(tally.remaining, 27)
  assert.deepEqual(statement.absences.map((row) => tally.estimates[row.id].first), [true, false])
  assert.equal(absenceNoticeBody(statement.absences[0], tally), 'geo 2.3 · 03.11.2026 08:00 · Absenzmeldung offen · geschätzt 3 Punkte · Kontingent noch 27 von 30')
})

test('an open report turning into a booked entry is not counted twice, and the booking is announced', () => {
  const statement = readAbsenceStatement(fixture('absenzen-aksa-open.html'))
  const lessons = [['08:00', '08:45'], ['08:45', '09:30']].map(([from, to], index) => ({ id: `${index}`, start: `2026-11-03T${from}:00`, end: `2026-11-03T${to}:00`, text: 'geo 2.3', courseName: 'geo 2.3', eventType: '0_stp', status: '' }))
  const open = { events: lessons, exams: [], absences: statement.absences, absenceQuota: 30, absenceRemaining: 30, absenceParser: ABSENCE_PARSER_VERSION }
  const bookedRow = { id: 'abs-1', dateFrom: '03.11.2026', dateTo: '03.11.2026', hourFrom: '', hourTo: '', subject: '', reason: 'Krankheit', excused: false, acknowledged: true, status: 'gebucht', points: 3 }
  const both = { ...open, absences: [bookedRow, ...open.absences], absenceRemaining: 27 }
  assert.equal(absenceTally(both).estimated, 0)
  assert.equal(absenceTally(both).booked, 3)
  assert.equal(absenceTally(both).remaining, 27)
  const booked = { ...open, absences: [bookedRow], absenceRemaining: 27 }
  assert.equal(absenceTally(booked).total, 3)
  const changes = diffSnapshots(open, booked, { absences: true, deadlines: true }, '2026-11-10')
  assert.deepEqual(changes.filter((change) => change.category === 'absence').map((change) => change.body), ['Krankheit · 03.11.2026 · 3 Punkte gebucht · Kontingent noch 27 von 30'])
})

test('the first read with the points parser is a baseline; later reports carry the estimate', () => {
  const statement = readAbsenceStatement(fixture('absenzen-aksa-open.html'))
  const before = { absences: [], events: [], exams: [] }
  const first = { ...before, absences: statement.absences, absenceQuota: 30, absenceRemaining: 30, absenceParser: ABSENCE_PARSER_VERSION }
  assert.equal(absenceSeedRead(before, first), true)
  assert.deepEqual(diffSnapshots(before, first, { absences: true }, '2026-11-10').filter((change) => change.category === 'absence'), [])
  const later = { ...first, absences: [...first.absences, { id: 'abs-open-x', dateFrom: '10.11.2026', dateTo: '10.11.2026', hourFrom: '10:30', hourTo: '11:15', subject: 'mat 2.1', reason: '', excused: false, acknowledged: false, status: 'offen', pending: true }] }
  const notices = diffSnapshots(first, later, { absences: true }, '2026-11-10').filter((change) => change.category === 'absence')
  assert.equal(notices.length, 1)
  assert.equal(notices[0].body, 'mat 2.1 · 10.11.2026 10:30 · Absenzmeldung offen · geschätzt 2 Punkte · Kontingent noch 24 von 30')
})

test('an unread page keeps the stored statement; an empty read empties it', () => {
  const stored = { absences: [{ id: 'a', pending: true }], absenceQuota: 30, absenceRemaining: 28, absenceParser: ABSENCE_PARSER_VERSION }
  assert.deepEqual(keepAbsenceRead(stored, { absences: [] }).absences, stored.absences)
  assert.equal(keepAbsenceRead(stored, { absences: [] }).absenceRemaining, 28)
  // An older app's upload (no parser stamp) does not replace the server's statement.
  assert.deepEqual(keepAbsenceRead(stored, { absences: [{ id: 'old' }] }).absences, stored.absences)
  assert.deepEqual(keepAbsenceRead(stored, { absences: [], absenceParser: ABSENCE_PARSER_VERSION, absenceQuota: 30, absenceRemaining: 30 }).absences, [])
})

test('points text is German', () => {
  assert.equal(pointsText(3), '3')
  assert.equal(pointsText(2.5), '2,5')
})

const invoke = async (runtime, method, path, headers = {}, body = '') => {
  const request = Readable.from(body ? [Buffer.from(body)] : [])
  request.method = method
  request.headers = headers
  request.socket = { remoteAddress: '198.51.100.10' }
  let status = 0
  let payload = ''
  const response = { writeHead(code) { status = code }, end(value) { payload = value || '' } }
  assert.equal(await runtime.handle(request, response, new URL(`http://127.0.0.1${path}`)), true)
  return { status, body: payload ? JSON.parse(payload) : {} }
}

test('the server reads the statement on every poll, starts silently, keeps it over older uploads and serves older apps their own ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-absences-'))
  let absencePage = fixture('absenzen-aksa-open.html')
  const calls = []
  const fetch = async (url, options = {}) => {
    const target = String(url)
    const cookie = options.headers?.Cookie || ''
    calls.push({ target, method: options.method || 'GET' })
    const response = (status, body, { location = '', cookies = [] } = {}) => ({ status, headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null) }, setCookies: cookies, text: async () => body })
    if (target.endsWith('/index.php?pageid=1') && !cookie.includes('PHPSESSID=server-session')) return response(302, '', { location: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?redirect_uri=https%3A%2F%2Fwww.schulnetz-ag.ch%2Faksa%2F' })
    if (target.includes('login.microsoftonline.com')) return response(302, '', { location: 'https://www.schulnetz-ag.ch/aksa/?code=abc' })
    if (target.includes('/aksa/?code=')) return response(200, '<a href="index.php?pageid=21311&id=abc123&transid=a1b2c3">Noten</a>', { cookies: ['PHPSESSID=server-session; Path=/; HttpOnly'] })
    if (target.includes('scheduler_processor')) return response(200, "<?xml version='1.0' encoding='utf-8' ?><data></data>")
    if (target.includes('pageid=21111')) return response(200, absencePage)
    return response(200, '<html><body><a href="index.php?pageid=21311&amp;id=abc123&amp;transid=a1b2c3">Noten</a></body></html>')
  }
  const runtime = createSchulnetzRuntime({ root, key: randomBytes(32), fetch, autostart: false, now: () => new Date('2026-11-10T12:00:00Z'), fcmSend: async () => ({ status: 200 }) })
  try {
    const guest = await runtime.createGuest('203.0.113.61')
    await runtime.linkAccount(guest.accountId, { mode: 'web', baseUrl: 'https://www.schulnetz-ag.ch/aksa', deviceId: '0123456789abcdef01234567', userAgent: 'KantiTest', ssoCookies: { 'login.microsoftonline.com': 'ESTSAUTHPERSISTENT=synthetic' } })
    const stored = async () => JSON.parse(await readFile(join(root, 'accounts', guest.accountId, 'snapshot.json'), 'utf8'))
    const absenceNotices = async () => (await readFile(join(root, 'accounts', guest.accountId, 'changes.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((change) => change.category === 'absence')
    await runtime.pollAccount(guest.accountId)
    const first = await stored()
    assert.equal(first.absenceParser, ABSENCE_PARSER_VERSION)
    assert.equal(first.absenceQuota, 30)
    assert.equal(first.absences.filter((row) => row.pending).length, 2)
    assert.deepEqual(await absenceNotices(), [], 'the first statement read is a baseline')
    // Read-only: every Schulnetz call is a GET.
    assert.ok(calls.filter((call) => call.target.includes('schulnetz-ag.ch')).every((call) => call.method === 'GET'))
    // A new open report is announced with its estimate.
    absencePage = absencePage.replace('                <tr><td colspan="4">&nbsp;</td></tr>', `                    <tr >
                <td >10.11.2026</td>
                <td >10:30 - 11:15</td>
                <td >mat 2.1</td>
                                                    <td >&nbsp;</td>
                                            </tr>
                <tr><td colspan="4">&nbsp;</td></tr>`)
    await runtime.pollAccount(guest.accountId)
    const notices = await absenceNotices()
    assert.equal(notices.length, 1)
    assert.match(notices[0].body, /^mat 2\.1 · 10\.11\.2026 10:30 · Absenzmeldung offen · geschätzt 2 Punkte · Kontingent noch \d+ von 30$/u)
    // An app before the points parser uploads its own rows; the server keeps its statement and announces nothing.
    const headers = { authorization: `Bearer ${guest.token}`, 'x-kanti-guest': guest.accountId, 'content-type': 'application/json' }
    const olderUpload = { absences: [{ id: 'abs-legacy', dateFrom: '03.11.2026', dateTo: '03.11.2026', hourFrom: '08:00 - 08:45', hourTo: '', subject: 'geo 2.3', reason: '', excused: false, acknowledged: false, status: '' }] }
    assert.equal((await invoke(runtime, 'PUT', '/api/v1/schulnetz/snapshot', headers, JSON.stringify(olderUpload))).status, 200)
    assert.equal((await stored()).absences.length, 3)
    assert.equal((await absenceNotices()).length, 1)
    // This app gets the statement; an older app gets the ids its own reader makes of the page.
    const current = await invoke(runtime, 'GET', '/api/v1/schulnetz/snapshot', { ...headers, 'x-kanti-timetable': 'weeks', 'x-kanti-absences': String(ABSENCE_PARSER_VERSION) })
    assert.equal(current.body.absenceQuota, 30)
    assert.equal(current.body.absences.filter((row) => row.pending).length, 3)
    const older = await invoke(runtime, 'GET', '/api/v1/schulnetz/snapshot', { ...headers, 'x-kanti-timetable': 'weeks' })
    assert.equal(older.body.absenceQuota, undefined)
    assert.ok(older.body.absences.every((row) => row.pending === undefined && row.points === undefined))
    assert.deepEqual(older.body.absences.map((row) => row.hourFrom), ['08:00 - 08:45', '08:45 - 09:30', '10:30 - 11:15'])
    // Two reports of one double lesson share the older reader's id, as on the phone.
    assert.equal(new Set(older.body.absences.map((row) => row.id)).size, 2)
    // A page that cannot be read keeps the statement.
    absencePage = '<html><body>Inaktivitätslimit überschritten</body></html>'
    await runtime.pollAccount(guest.accountId)
    assert.equal((await stored()).absences.length, 3)
    assert.equal((await stored()).absenceRemaining, 30)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
