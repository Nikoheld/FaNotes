// Cancelled and changed lessons: Schulnetz marks them in the scheduler XML (`markierung`, `textdeco`).
// All names, rooms and teachers below are synthetic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createDecipheriv, randomBytes } from 'node:crypto'
import { createSchulnetzRuntime } from './schulnetz-api.mjs'
import { scrapeWithSession } from './schulnetz-web.mjs'
import {
  GRADE_SLA_MS, LESSON_CHECK_MS, alertAllowed, diffSnapshots, isCancelled, isSubstitution, lessonCheckWeeks, lessonMarker,
  parseSchedulerXml, resolvedAlertSettings, seedLessonMarks,
} from './schulnetz-logic.mjs'

const openSealed = (keyBase64, sealed) => {
  const bytes = Buffer.from(sealed, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(bytes.length - 16))
  return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString('utf8')
}

const cdata = (value) => `<![CDATA[${value}]]>`
/** One scheduler event in the shape Schulnetz sends (field order and CDATA as on the live page). */
const schedulerEvent = ({ id, start, end, text = 'Testfach', course = 'TF-4a-TstAa', room = 'T01', teacher = 'Tester Anna (TstAa)', type = '0_stp', mark = 'none', deco = '', color = '#77B0D4', comment = '', newTeacher = '' }) =>
  `<event id='${id}' ><start_date>${cdata(start)}</start_date><end_date>${cdata(end)}</end_date><text>${cdata(text)}</text>` +
  `<kommentar>${cdata(comment)}</kommentar><klasse>${cdata('T26A')}</klasse><readonly>${cdata('1')}</readonly>` +
  `<zimmer>${cdata('1')}</zimmer><zimmerkuerzel>${cdata(room)}</zimmerkuerzel><lehrerkuerzelname>${cdata(teacher)}</lehrerkuerzelname>` +
  `<istrv>${cdata('1')}</istrv><markierung>${cdata(mark)}</markierung><textdeco>${cdata(deco)}</textdeco><color>${cdata(color)}</color>` +
  `<event_type>${cdata(type)}</event_type><kurskuerzel>${cdata(course)}</kurskuerzel><kursid>${cdata('9001')}</kursid>` +
  `<neuerlehrer>${cdata(newTeacher)}</neuerlehrer><neuerlehrername>${cdata(newTeacher)}</neuerlehrername><wochentag>${cdata('Fr')}</wochentag></event>`
const schedulerXml = (events) => `<?xml version='1.0' encoding='utf-8' ?><data>${events.map(schedulerEvent).join('')}</data>`

// A Friday like the one in the report: two normal lessons, then two the school deleted.
const friday = (deleted = true) => [
  { id: '0', start: '2026-11-13 07:45', end: '2026-11-13 08:30', text: 'Testfach A', course: 'TA-4a-TstBb' },
  { id: '1', start: '2026-11-13 08:35', end: '2026-11-13 09:20', text: 'Testfach B', course: 'TB-4a-TstCc' },
  { id: '2', start: '2026-11-13 09:30', end: '2026-11-13 10:15', text: 'Testfach C', course: 'TC-4a-TstDd', ...(deleted ? { mark: 'deleted', deco: 'line-through', color: '#fb8c60' } : {}) },
  { id: '3', start: '2026-11-13 10:30', end: '2026-11-13 11:15', text: 'Testfach C', course: 'TC-4a-TstDd', ...(deleted ? { mark: 'deleted', deco: 'line-through', color: '#fb8c60' } : {}) },
]

test('a lesson Schulnetz marks deleted (struck through) is cancelled, without any comment', () => {
  const events = parseSchedulerXml(schedulerXml(friday()))
  assert.equal(events.length, 4)
  assert.deepEqual(events.map((event) => isCancelled(event)), [false, false, true, true])
  assert.deepEqual(events.map((event) => event.status), ['', '', 'cancelled', 'cancelled'])
  assert.deepEqual(events.map((event) => event.marker), ['', '', 'cancelled', 'cancelled'])
  assert.equal(events[2].comment, '')
  // Every parsed lesson carries the field, so a read with marks is told apart from an older one.
  assert.ok(events.every((event) => Object.hasOwn(event, 'marker')))
})

test('new, moved and changed lessons keep their mark; a substitute teacher is a substitution', () => {
  const events = parseSchedulerXml(schedulerXml([
    { id: 'n', start: '2026-11-16 07:45', end: '2026-11-16 08:30', mark: 'new', color: '#00cc00', comment: 'Zusatzlektion' },
    { id: 'm', start: '2026-11-16 08:35', end: '2026-11-16 09:20', mark: 'moved', color: '#fdff5b', comment: 'verschoben vom Mi' },
    { id: 'c', start: '2026-11-16 09:30', end: '2026-11-16 10:15', mark: '16', color: '#00b7ff', newTeacher: 'TstEe' },
    { id: 's', start: '2026-11-16 10:30', end: '2026-11-16 11:15', deco: 'line-through', mark: '' },
  ]))
  assert.deepEqual(events.map((event) => event.marker), ['added', 'moved', 'changed', 'cancelled'])
  assert.deepEqual(events.map((event) => isCancelled(event)), [false, false, false, true])
  assert.equal(events[2].substitute, 'TstEe')
  assert.equal(isSubstitution(events[2]), true)
  assert.equal(isSubstitution(events[0]), false)
})

test('on an exam the mark field is the exam material, not a lesson mark', () => {
  assert.equal(lessonMarker('1_pru', 'Kapitel 3 bis 5, ohne Anhang', ''), '')
  assert.equal(lessonMarker('5_trm', 'deleted', ''), '')
  assert.equal(lessonMarker('0_stp', 'none', ''), '')
  assert.equal(lessonMarker('0_stp', '', ''), '')
  assert.equal(lessonMarker('', 'deleted', ''), 'cancelled')
  const [exam] = parseSchedulerXml(schedulerXml([{ id: 'p', start: '2026-11-13 00:00:00', end: '2026-11-14 00:00:00', type: '1_pru', mark: 'Gemäss Lernzielen', color: '#f7bc19' }]))
  assert.equal(exam.marker, '')
  assert.equal(isCancelled(exam), false)
})

test('the first read with marks announces only upcoming cancellations, not a semester of old ones', () => {
  const now = new Date('2026-11-11T13:00:00Z') // Wednesday 14:00 Zurich
  const marked = parseSchedulerXml(schedulerXml([
    ...friday(),
    { id: '7', start: '2026-08-10 07:45', end: '2026-08-10 08:30', mark: 'deleted', deco: 'line-through' },
    { id: '8', start: '2027-01-18 07:45', end: '2027-01-18 08:30', mark: 'deleted', deco: 'line-through' },
    { id: '9', start: '2026-11-16 09:30', end: '2026-11-16 10:15', mark: '16', newTeacher: 'TstEe' },
  ]))
  // What the server stored before: the same lessons, read without marks (no `marker` field at all).
  const unmarked = marked.map(({ marker, substitute, ...event }) => ({ ...event, status: '' }))
  const weeks = [...new Set(marked.map((event) => event.start.slice(0, 10)))]
  const stamps = Object.fromEntries(weeks.map((day) => [day, '2026-11-11T12:00:00Z']))
  const previous = { events: unmarked, exams: [], grades: [], weekFetched: stamps }
  const next = { events: marked, exams: [], grades: [], weekFetched: stamps }
  const changes = diffSnapshots(previous, next, {}, '2026-11-11', now)
  const titles = changes.map((change) => `${change.title} ${change.date}`)
  assert.deepEqual(titles.sort(), ['Lektion fällt aus 2026-11-13', 'Lektion fällt aus 2026-11-13', 'Vertretung 2026-11-16'])
  assert.ok(changes.every((change) => change.category === 'timetable'))
  // The far and the past cancellation are now the baseline: an unchanged second read is quiet.
  const seeded = seedLessonMarks(unmarked, marked, now)
  assert.equal(seeded.find((event) => event.id === '7').status, 'cancelled')
  assert.equal(seeded.find((event) => event.id === '8').status, 'cancelled')
  assert.equal(seeded.find((event) => event.id === '2').status, '')
  assert.deepEqual(diffSnapshots(next, next, {}, '2026-11-11', now), [])
})

test('a lesson cancelled after the first read with marks is announced, and respects the switch', () => {
  const now = new Date('2026-11-11T13:00:00Z')
  const before = parseSchedulerXml(schedulerXml(friday(false)))
  const after = parseSchedulerXml(schedulerXml(friday(true)))
  const stamps = { '2026-11-09': '2026-11-11T12:55:00Z' }
  const changes = diffSnapshots({ events: before, exams: [], grades: [], weekFetched: stamps }, { events: after, exams: [], grades: [], weekFetched: stamps }, {}, '2026-11-11', now)
  assert.equal(changes.length, 2)
  assert.ok(changes.every((change) => change.title === 'Lektion fällt aus' && /fällt aus/u.test(change.body)))
  // "Abgesagte Lektionen" off in the notification settings drops them; on (the default) keeps them.
  assert.equal(changes.every((change) => alertAllowed(resolvedAlertSettings({}), change)), true)
  assert.equal(changes.some((change) => alertAllowed(resolvedAlertSettings({ lessonCancelled: false }), change)), false)
  // Reinstated: the mark is gone again.
  const back = diffSnapshots({ events: after, exams: [], grades: [], weekFetched: stamps }, { events: before, exams: [], grades: [], weekFetched: stamps }, {}, '2026-11-11', now)
  assert.equal(back.length, 2)
  assert.ok(back.every((change) => change.title === 'Stundenplan geändert'))
})

test('a grade check reads this and next week once their last read is 8 minutes old', () => {
  const now = '2026-11-12T21:30:00Z'
  assert.deepEqual(lessonCheckWeeks({ weekFetched: {}, today: '2026-11-12', now }), ['2026-11-09', '2026-11-16'])
  assert.deepEqual(lessonCheckWeeks({ weekFetched: { '2026-11-09': '2026-11-12T21:25:00Z', '2026-11-16': '2026-11-12T21:21:00Z' }, today: '2026-11-12', now }), ['2026-11-16'])
  assert.deepEqual(lessonCheckWeeks({ weekFetched: { '2026-11-09': '2026-11-12T21:25:00Z', '2026-11-16': '2026-11-12T21:23:00Z' }, today: '2026-11-12', now }), [])
  // Not past the semester Schulnetz offers.
  assert.deepEqual(lessonCheckWeeks({ weekFetched: {}, today: '2027-07-01', now: '2027-07-01T10:00:00Z', spanStart: '2026-08-17', spanEnd: '2027-07-04' }), ['2027-06-28'])
  assert.equal(LESSON_CHECK_MS, 8 * 60_000)
})

const timetablePage = (transid) => `<html><body><a href="index.php?pageid=21311&amp;id=abc123&amp;transid=${transid}">Noten</a>
  <script>loadStundenplanReal('scheduler_processor.php?view=week&ansicht=schueleransicht&id=abc123&transid=${transid}&pageid=22202')</script></body></html>`

test('a grade check reads lesson weeks with GET only and skips them while fresh', async () => {
  const urls = []
  const fetchImpl = async (url, init = {}) => {
    assert.equal(init.method || 'GET', 'GET')
    const target = String(url)
    urls.push(target)
    let body = '<html><body><a href="index.php?pageid=21311&amp;id=abc123&amp;transid=t1">Noten</a></body></html>'
    if (target.includes('pageid=22202') && !target.includes('scheduler_processor')) body = timetablePage('aa22202')
    if (target.includes('scheduler_processor')) body = target.includes('min_date=2026-11-09') ? schedulerXml(friday()) : "<?xml version='1.0' encoding='utf-8' ?><data></data>"
    return { status: 200, headers: { get: () => '' }, text: async () => body }
  }
  const session = { php: 'php', id: 'abc123', transid: 't0', userAgent: 'test' }
  const base = 'https://www.schulnetz-ag.ch/aksa'
  const stale = await scrapeWithSession(base, session, fetchImpl, {
    gradesOnly: true, today: '2026-11-12', now: '2026-11-12T21:30:00Z',
    previousEvents: parseSchedulerXml(schedulerXml(friday(false))), weekFetched: { '2026-11-09': '2026-11-12T21:00:00Z' },
  })
  const pages = urls.filter((url) => !url.includes('scheduler_processor')).map((url) => url.match(/pageid=(\d+)/u)[1])
  assert.deepEqual(pages, ['1', '21311', '22202'])
  const schedulers = urls.filter((url) => url.includes('scheduler_processor'))
  assert.equal(schedulers.length, 2)
  assert.ok(schedulers.every((url) => url.includes('pageid=22202') && url.includes('transid=aa22202')))
  assert.equal(stale.lessonsRead, true)
  assert.equal(stale.events.filter(isCancelled).length, 2)
  assert.equal(stale.weekFetched['2026-11-09'], '2026-11-12T21:30:00Z')
  urls.length = 0
  const fresh = await scrapeWithSession(base, session, fetchImpl, {
    gradesOnly: true, today: '2026-11-12', now: '2026-11-12T21:33:00Z',
    previousEvents: stale.events, weekFetched: stale.weekFetched,
  })
  assert.deepEqual(urls.map((url) => url.match(/pageid=(\d+)/u)[1]), ['1', '21311'])
  assert.equal(fresh.lessonsRead, false)
  assert.equal(fresh.events.filter(isCancelled).length, 2)
})

test('a lesson cancelled at 22:30 the evening before is pushed within 10 minutes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-lesson-marks-'))
  let clock = Date.parse('2026-11-12T20:00:00Z') // Thursday 21:00 Zurich
  let deleted = false
  const sent = []
  const fetch = async (url, options = {}) => {
    const target = String(url)
    const cookie = options.headers?.Cookie || ''
    if ((options.method || 'GET') !== 'GET') throw new Error(`not read-only: ${options.method}`)
    const response = (status, body, { location = '', cookies = [] } = {}) => ({ status, headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null) }, setCookies: cookies, text: async () => body })
    if (target.endsWith('/index.php?pageid=1') && !cookie.includes('PHPSESSID=server-session')) return response(302, '', { location: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?redirect_uri=https%3A%2F%2Fwww.schulnetz-ag.ch%2Faksa%2F' })
    if (target.includes('login.microsoftonline.com')) return response(302, '', { location: 'https://www.schulnetz-ag.ch/aksa/?code=abc' })
    if (target.includes('/aksa/?code=')) return response(200, '<a href="index.php?pageid=21311&id=abc123&transid=a1b2c3">Noten</a>', { cookies: ['PHPSESSID=server-session; Path=/; HttpOnly'] })
    if (target.includes('scheduler_processor')) {
      if (target.includes('pageid=22202') && target.includes('min_date=2026-11-09')) return response(200, schedulerXml(friday(deleted)))
      return response(200, "<?xml version='1.0' encoding='utf-8' ?><data></data>")
    }
    if (target.includes('pageid=22202')) return response(200, timetablePage('d4e5f6'))
    return response(200, '<html><body><a href="index.php?pageid=21311&amp;id=abc123&amp;transid=a1b2c3">Noten</a></body></html>')
  }
  const runtime = createSchulnetzRuntime({
    root, key: randomBytes(32), fetch, autostart: false, spacingMs: 0,
    now: () => new Date(clock),
    log: () => {},
    fcmSend: async (message) => { sent.push({ at: clock, message: message.message }); return { status: 200 } },
  })
  try {
    const guest = await runtime.createGuest('203.0.113.71')
    await runtime.linkAccount(guest.accountId, { mode: 'web', baseUrl: 'https://www.schulnetz-ag.ch/aksa', deviceId: '0123456789abcdef01234568', userAgent: 'KantiTest', ssoCookies: { 'login.microsoftonline.com': 'ESTSAUTHPERSISTENT=synthetic' } })
    const pushKey = randomBytes(32).toString('base64')
    const request = Readable.from([Buffer.from(JSON.stringify({ token: `${'e'.repeat(40)}:APA91b${'y'.repeat(120)}`, key: pushKey }))])
    request.method = 'PUT'
    request.headers = { authorization: `Bearer ${guest.token}`, 'x-kanti-guest': guest.accountId, 'content-type': 'application/json' }
    request.socket = { remoteAddress: '198.51.100.11' }
    await runtime.handle(request, { writeHead() {}, end() {} }, new URL('http://127.0.0.1/api/v1/schulnetz/push-token'))
    const runFor = async (ms) => { const stop = clock + ms; while (clock < stop) { await runtime.scheduler.tick(); clock += 15_000 } }
    await runFor(90 * 60_000)
    assert.equal(sent.filter((item) => item.message.data.event === 'sync').length, 0, 'the first reads are a quiet baseline')
    // 22:30 Zurich (night phase: full reads only every 30 minutes): the school deletes two of Friday's lessons.
    clock = Math.max(clock, Date.parse('2026-11-12T21:30:00Z'))
    const appeared = clock
    deleted = true
    while (!sent.some((item) => item.message.data.event === 'sync') && clock < appeared + 40 * 60_000) { await runtime.scheduler.tick(); clock += 15_000 }
    const push = sent.find((item) => item.message.data.event === 'sync')
    assert.ok(push, 'a push was sent')
    assert.ok(push.at - appeared <= GRADE_SLA_MS, `pushed ${Math.round((push.at - appeared) / 1000)} s after the lesson was deleted`)
    const notices = JSON.parse(openSealed(pushKey, push.message.data.n)).changes
    assert.equal(notices.filter((notice) => notice.title === 'Lektion fällt aus').length, 2)
    assert.ok(notices.every((notice) => notice.category === 'timetable' && /13\.11\.2026/u.test(notice.body)))
    const snapshot = JSON.parse(await readFile(join(root, 'accounts', guest.accountId, 'snapshot.json'), 'utf8'))
    assert.equal(snapshot.events.filter((event) => isCancelled(event)).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
