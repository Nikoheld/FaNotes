import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createCipheriv, generateKeyPairSync, randomBytes } from 'node:crypto'
import { createSchulnetzRuntime, openToken, sealToken } from './schulnetz-api.mjs'
import { notifyAccountDeleted, setAccountDeletedHook } from './sync-api.mjs'
import { connectionRouteKey, fcmDataMessage, fcmDropToken, fcmPriorityForChanges, isValidFcmToken, serviceAccountJwt } from './fcm.mjs'
import {
  diffSnapshots as diffSnapshotsAt,
  changeIsOver,
  weekMondayKey,
  addDays,
  semesterSpan,
  schedulerTransid,
  extractWebIds,
  keepServerLessons,
  legacySnapshotView,
  lessonSeedWeeks,
  LESSON_SEED_MIN,
  TIMETABLE_BURST,
  appointmentHorizon,
  APPOINTMENT_BURST,
  emptyWeekCountsAsRead,
  weekIsHoliday,
  withoutUnprovenEmptyReads,
  fallbackSchoolSpan,
  prepareAgendaRead,
  normalizeSchoolBase,
  parseGradesHtml,
  parseRawSnapshot,
  pluspunkte,
  redactSecrets,
  redirectTargetAllowed,
  microsoftLoginRequired,
  schulnetzCallAllowed,
  sessionProblem,
  unseenChanges,
  weightedAverage,
  wunschnote,
  roundToHalf,
  isSportCourse,
  promotionPoints,
  isSummaryGradeTitle,
  withoutSummaryGrades,
  notifyHash,
  gradeTargetId,
  lessonTargetId,
  groupGradeChanges,
  notifyPayload,
  parseNotifyLink,
  prepareGradeNotifications,
  redactGradeChange,
  routeNotify,
  gradeLedgerEntries,
  gradeContentHash,
  gradeLooseHash,
  settleGradeNotifications,
  isNotificationProbe,
  formatProbeDay,
  linkedChange,
  notificationProbeBatch,
  notificationProbeChanges,
  alertAllowed,
  notifyAlertKind,
  resolvedAlertSettings,
  keepLoadedGrades,
  normalizeGradeDate,
  parseWeekSpan,
  planWeekFetches,
  confirmedLessonStamps,
  probeDeviceKey,
  changeVisibleToDevice,
  WEEK_PROBE,
  WEEK_BATCH,
  introducedWeeks,
  eventQueryWindow,
  overlayLessons,
  isExamLike,
  isLesson,
  parseSchedulerXml,
  parseIcs,
  carryTimetableExams,
  schedulerFetchUrl,
  schedulerWeekLoaded,
  terminlisteNextUrl,
  zurichTimeshift,
  WEEK_CAP,
} from './schulnetz-logic.mjs'

// Fixtures are dated around early November 2026. Pin "today" so already-ended events are judged
// against that week, not the machine clock. Calls that pass their own day keep it.
const FIXTURE_TODAY = '2026-11-01'
const diffSnapshots = (previous, next, settings = {}, today = FIXTURE_TODAY, now) => diffSnapshotsAt(previous, next, settings, today, now)
import { scrapeWithSession } from './schulnetz-web.mjs'
import { gzipSync } from 'node:zlib'
import { GRADE_PARSER_VERSION, SNAPSHOT_JSON_LIMIT, UPLOAD_LIST_BURST, decodeRequestJson, gradeDiffBase, mergeEventsById, uploadDiffBase } from './schulnetz-logic.mjs'

const marks = [
  { mark: 5.5, weight: 1 },
  { mark: 4.75, weight: 1 },
  { mark: 5.25, weight: 1.5 },
]

test('grade maths matches the Swiss pass line', () => {
  assert.equal(Math.round(weightedAverage(marks) * 1000) / 1000, 5.179)
  assert.equal(pluspunkte(marks), 4.125)
  assert.equal(wunschnote(marks, 5, 1).achievable, true)
  assert.equal(Math.round(wunschnote(marks, 5, 1).needed * 1000) / 1000, 4.375)
  assert.equal(wunschnote(marks, 5.5, 1).achievable, false)
  assert.equal(wunschnote(marks, 4, 1).alreadyMet, true)
})

test('Aargau pluspunkte round the Zeugnisnote and skip sport', () => {
  assert.equal(roundToHalf(4.74), 4.5)
  assert.equal(roundToHalf(4.75), 5)
  assert.equal(promotionPoints(5.5), 1.5)
  assert.equal(promotionPoints(4), 0)
  assert.equal(promotionPoints(3), -2)
  assert.equal(promotionPoints(3.5), -1)
  assert.equal(isSportCourse('Sport'), true)
  assert.equal(isSportCourse('Mathematik'), false)
})

test('diff ids stay stable and the first snapshot is silent', () => {
  const grade = { id: 'g1', course: 'Mathematik', title: 'Probe', date: '2026-10-20', mark: 5.5, weight: 1 }
  const next = { grades: [grade], events: [], exams: [], absences: [], messages: [] }
  assert.deepEqual(diffSnapshots(null, next), [])
  const [change] = diffSnapshots({ grades: [], events: [], exams: [], absences: [], messages: [] }, next)
  assert.equal(change.id, 'grade:g1:5.5|1|Probe|2026-10-20')
  assert.equal(change.category, 'grade')
  assert.equal(change.title, 'Neue Note')
  assert.equal(change.target, 'grades')
  assert.equal(change.targetId, gradeTargetId(grade))
  assert.equal(change.courseId, 'Mathematik')
  assert.equal(change.date, '2026-10-20')
  const lesson = { id: 'e1', start: '2026-11-02T08:15:00', end: '2026-11-02T09:00:00', text: 'Mathematik', room: 'R201', teachers: [], courseName: 'Mathematik', status: 'confirmed', eventType: 'lesson' }
  const room = diffSnapshots({ grades: [], events: [lesson], exams: [], absences: [], messages: [] }, { grades: [], events: [{ ...lesson, room: 'R202' }], exams: [], absences: [], messages: [] })
  assert.equal(room.find((item) => item.category === 'timetable').title, 'Raum geändert')
  const time = diffSnapshots({ grades: [], events: [lesson], exams: [], absences: [], messages: [] }, { grades: [], events: [{ ...lesson, start: '2026-11-02T09:15:00', end: '2026-11-02T10:00:00' }], exams: [], absences: [], messages: [] })
  assert.equal(time.find((item) => item.category === 'timetable').title, 'Zeit geändert')
})

test('course average rows are not grades and drop silently', () => {
  assert.equal(isSummaryGradeTitle('Durchschnitt'), true)
  assert.equal(isSummaryGradeTitle('Aktueller Durchschnitt'), true)
  assert.equal(isSummaryGradeTitle('1. Prüfung'), false)
  const exam = { id: 'exam:che', course: 'Chemie', courseId: 'che', title: '1. Prüfung', date: '2026-09-17', mark: 4.2, weight: 1 }
  const average = { id: 'course:che:4.2', course: 'Chemie', courseId: 'che', title: 'Durchschnitt', date: '', mark: 4.2, weight: 1 }
  assert.deepEqual(withoutSummaryGrades([average, exam]).map((grade) => grade.id), ['exam:che'])
  const changes = diffSnapshots(
    { grades: [average, exam], events: [], exams: [], absences: [], messages: [] },
    { grades: [exam], events: [], exams: [], absences: [], messages: [] },
  )
  assert.equal(changes.some((change) => change.category === 'grade'), false)
  assert.equal(parseRawSnapshot({ grades: JSON.stringify([average, exam]) }).grades.length, 1)
  const html = '<table><tr><td><b>CHE-K26A-1</b></td><td>4.2</td></tr><tr><td><table><tr><td>17.09.2026</td><td>Durchschnitt</td><td>4.2</td><td>1</td></tr><tr><td>17.09.2026</td><td>1. Prüfung</td><td>4.2</td><td>1</td></tr></table></td></tr></table>'
  assert.deepEqual(parseGradesHtml(html).map((grade) => grade.title), ['1. Prüfung'])
})

test('an excuse deadline is pushed once and only inside the window', () => {
  const open = { id: 'a', dateFrom: '2026-11-01', subject: 'Deutsch', reason: 'Arzt', excused: false, excuseUntil: '04.11.2026' }
  const previous = { grades: [], events: [], exams: [], absences: [], messages: [] }
  const next = { grades: [], events: [], exams: [], absences: [open], messages: [] }
  const settings = { grades: false, timetable: false, exams: false, absences: false, events: false, deadlines: true }
  const changes = diffSnapshots(previous, next, settings, '2026-11-02')
  assert.equal(changes.length, 1)
  assert.equal(changes[0].category, 'deadline')
  assert.equal(changes[0].id, 'deadline:a:2026-11-04')
  assert.deepEqual(diffSnapshots(previous, next, settings, '2026-11-07'), [])
  assert.deepEqual(diffSnapshots(previous, { ...next, absences: [{ ...open, excused: true }] }, settings, '2026-11-02'), [])
  assert.deepEqual(unseenChanges(changes, [changes[0].id]), [])
})

test('read-only policy blocks enrolment, confirmation and absence writes', () => {
  const base = 'https://www.schulnetz-ag.ch/aksa'
  assert.equal(schulnetzCallAllowed('GET', `${base}/rest/v1/me/grades`), true)
  assert.equal(schulnetzCallAllowed('GET', `${base}/index.php?pageid=21411`), true)
  assert.equal(schulnetzCallAllowed('POST', `${base}/token.php`, 'grant_type=refresh_token&refresh_token=abc'), true)
  assert.equal(schulnetzCallAllowed('POST', `${base}/rest/v1/me/absences`, '{"reason":"x"}'), false)
  assert.equal(schulnetzCallAllowed('POST', `${base}/rest/v1/me/notifications/token`, '{"token":"x"}'), false)
  assert.equal(schulnetzCallAllowed('GET', `${base}/index.php?pageid=23118`), false)
  assert.equal(schulnetzCallAllowed('GET', `${base}/rest/v1/me/absencesAndLateness/isAlreadyConfirmed`), false)
  assert.equal(schulnetzCallAllowed('POST', `${base}/token.php`, 'grant_type=password&passwort=secret'), false)
  assert.equal(normalizeSchoolBase(`${base}/`), base)
  assert.equal(normalizeSchoolBase('https://evil.example/aksa'), null)
  assert.equal(normalizeSchoolBase('https://schulnetz.evil.tld/aksa'), null)
  assert.equal(normalizeSchoolBase('https://evilschulnetz-ag.ch/aksa'), null)
  assert.equal(normalizeSchoolBase('https://microsoft.evil.tld/'), null)
  assert.equal(schulnetzCallAllowed('GET', 'https://schulnetz.evil.tld/rest/v1/me/grades'), false)
  assert.equal(schulnetzCallAllowed('GET', 'https://evilschulnetz-ag.ch/rest/v1/me/grades'), false)
  assert.equal(schulnetzCallAllowed('GET', 'https://microsoft.evil.tld/'), false)
  assert.equal(redirectTargetAllowed('https://127.0.0.1/'), false)
  assert.equal(redirectTargetAllowed('https://10.1.2.3/'), false)
  assert.equal(redirectTargetAllowed('https://192.168.1.1/'), false)
  assert.equal(redirectTargetAllowed('https://169.254.1.1/'), false)
  assert.equal(redirectTargetAllowed('https://[::1]/'), false)
  assert.equal(redirectTargetAllowed('https://microsoft.evil.tld/'), false)
  assert.equal(redirectTargetAllowed('https://www.schulnetz-ag.ch/aksa'), true)
  assert.equal(redirectTargetAllowed('https://login.microsoftonline.com/tenant'), true)
  assert.equal(redactSecrets('Bearer super-secret refresh_token=abcdef'), 'Bearer [redacted] refresh_token=[redacted]')
  const redacted = redactSecrets('id=abc&transid=def&code=secret&buid=b1&fpc=f1&esctx=e1&sFT=s1&canary=c1 SignInStateCookie=state x-ms-RefreshTokenCredential=rt Cookie: PHPSESSID=phone; ESTSAUTH=auth')
  assert.equal(redacted.includes('secret'), false)
  assert.equal(redacted.includes('abc'), false)
  assert.equal(redacted.includes('phone'), false)
  assert.equal(redacted.includes('SignInStateCookie=state'), false)
  assert.equal(redacted.includes('SignInStateCookie=[redacted]'), true)
  assert.equal(redacted.includes('b1'), false)
  assert.equal(redacted.includes('id=[redacted]'), true)
  assert.equal(redacted.includes('transid=[redacted]'), true)
  assert.equal(redacted.includes('names=PHPSESSID,ESTSAUTH'), true)
})

test('parser reads the mobile grade shape and the Kontoauszug table', () => {
  const snapshot = parseRawSnapshot({
    grades: JSON.stringify([{ id: 'g1', course: 'Mathematik', mark: '5,5', weight: '1', title: 'Probe', date: '2026-10-20' }]),
    kontoHtml: '<table><tr><td>01.11.2026</td><td>Mittagessen</td><td>-12.50</td><td>40.00</td></tr></table>',
    startHtml: '<div class="cls-start-mitteilung">Elternabend am Freitag</div>',
  })
  assert.equal(snapshot.grades[0].mark, 5.5)
  assert.equal(snapshot.konto[0].label, 'Mittagessen')
  assert.deepEqual(snapshot.startMessages, ['Elternabend am Freitag'])
})

test('stored refresh tokens are encrypted and only the poller refreshes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-'))
  const key = randomBytes(32)
  const secret = 'super-secret-refresh-token-value'
  const calls = []
  let gradePolls = 0
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method })
    const json = (value, status = 200) => ({ status, text: async () => JSON.stringify(value) })
    if (String(url).endsWith('/token.php')) {
      return json({ access_token: 'access-token-value', refresh_token: 'rotated-refresh-token-value-123456', expires_in: 3600 })
    }
    if (String(url).includes('/me/grades')) {
      gradePolls += 1
      const grades = [{ id: 'g1', course: 'Mathematik', title: 'Probe', date: '2026-10-20', mark: '5.5', weight: '1' }]
      if (gradePolls > 1) grades.push({ id: 'g2', course: 'Englisch', title: 'Essay', date: '2026-11-01', mark: '4.5', weight: '1' })
      return json(grades)
    }
    if (String(url).includes('pageid=21411')) {
      return { status: 200, text: async () => '<table><tr><td>01.11.2026</td><td>Essen</td><td>-1</td><td>2</td></tr></table>' }
    }
    if (String(url).includes('pageid=1')) {
      return { status: 200, text: async () => '<div class="cls-start-mitteilung">Willkommen</div>' }
    }
    return json([])
  }
  const sent = []
  const runtime = createSchulnetzRuntime({
    root,
    key,
    fetch,
    autostart: false,
    fcmSend: async (message) => { sent.push(message); return { status: 200 } },
  })
  const accountId = 'a'.repeat(32)
  {
    const status = await runtime.linkAccount(accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: secret,
      displayName: 'Max',
    })
    assert.equal(status.linked, true)
    assert.equal(JSON.stringify(status).includes(secret), false)
    const stored = await readFile(join(root, 'accounts', accountId, 'link.json'), 'utf8')
    assert.equal(stored.includes(secret), false)
    const roundTrip = openToken(key, JSON.parse(stored).refresh)
    assert.equal(roundTrip, secret)
    await assert.rejects(() => runtime.addFcmToken(accountId, 'bad token'), (error) => error.publicMessage.includes('Push-Token'))
    await runtime.addFcmToken(accountId, 'phone:APA91b-example-token-value')
    await runtime.pollAccount(accountId)
    assert.equal(sent.length, 0)
    const afterPoll = JSON.parse(await readFile(join(root, 'accounts', accountId, 'link.json'), 'utf8'))
    assert.equal(openToken(key, afterPoll.refresh), 'rotated-refresh-token-value-123456')
    assert.equal(afterPoll.topic, undefined)
    assert.equal(afterPoll.pushEndpoints, undefined)
    assert.equal(calls.some((call) => call.method === 'POST' && call.url.endsWith('/token.php')), true)
    assert.equal(calls.some((call) => call.method !== 'GET' && call.method !== 'POST'), false)
    assert.equal(calls.some((call) => call.url.includes('/me/absences') && call.method !== 'GET'), false)
    assert.equal(calls.some((call) => call.url.includes('pageid=23118')), false)
    const snapshot = JSON.parse(await readFile(join(root, 'accounts', accountId, 'snapshot.json'), 'utf8'))
    assert.equal(snapshot.grades[0].id, 'g1')
    assert.equal(snapshot.konto[0].label, 'Essen')
    assert.equal(snapshot.startMessages[0], 'Willkommen')
    assert.equal(JSON.stringify(snapshot).includes(secret), false)
    await runtime.pollAccount(accountId)
    const changes = await readFile(join(root, 'accounts', accountId, 'changes.jsonl'), 'utf8')
    assert.match(changes, /grade:g2:4\.5\|1\|Essay\|2026-11-01/)
    assert.equal(changes.includes('rotated-refresh'), false)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].message.data.event, 'sync')
    assert.equal(sent[0].message.android.priority, 'HIGH')
    // The push names its connection by route key, and each connection has its own collapse slot.
    assert.equal(sent[0].message.data.route, connectionRouteKey(accountId))
    assert.equal(sent[0].message.android.collapse_key, `kanti-sync-${connectionRouteKey(accountId)}`)
    assert.equal(JSON.stringify(sent[0]).includes(accountId), false)
    assert.equal(sent[0].message.notification, undefined)
    assert.equal(JSON.stringify(sent[0]).includes('4.5'), false)
    assert.equal(JSON.stringify(sent[0]).includes('5.5'), false)
    assert.equal(calls.some((call) => String(call.url).includes('ntfy')), false)
    await runtime.pollAccount(accountId)
    assert.equal(sent.length, 1)
  }
})

test('web session is opened with Microsoft cookies and not the phone PHPSESSID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-web-'))
  const key = randomBytes(32)
  const calls = []
  const fetch = async (url, options = {}) => {
    const cookie = options.headers?.Cookie || ''
    calls.push({ url: String(url), cookie })
    const response = (status, body, { location = '', cookies = [] } = {}) => ({
      status,
      headers: { get: (name) => name.toLowerCase() === 'location' ? location : null },
      setCookies: cookies,
      text: async () => body,
    })
    const target = String(url)
    if (target.endsWith('/index.php?pageid=1') && !cookie.includes('PHPSESSID=server-session')) {
      return response(302, '', { location: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?redirect_uri=https%3A%2F%2Fwww.schulnetz-ag.ch%2Faksa%2F' })
    }
    if (target.includes('login.microsoftonline.com')) {
      return response(302, '', { location: 'https://www.schulnetz-ag.ch/aksa/?code=abc' })
    }
    if (target.includes('/aksa/?code=') || target.includes('/aksa?code=')) {
      return response(200, '<a href="index.php?pageid=21311&id=abc123&transid=a1b2c3">Noten</a>', { cookies: ['PHPSESSID=server-session; Path=/; HttpOnly'] })
    }
    if (target.includes('pageid=21311')) {
      return response(200, '<table><tr><td><b>MA-4a-He</b></td><td>5.5</td></tr><tr><td><table><tr><td>20.10.2026</td><td>Probe</td><td>5.5</td><td>1</td></tr></table></td></tr></table>')
    }
    return response(200, '<main>Termin</main>')
  }
  const runtime = createSchulnetzRuntime({ root, key, fetch, autostart: false })
  const accountId = 'b'.repeat(32)
  const status = await runtime.linkAccount(accountId, {
    mode: 'web',
    baseUrl: 'https://www.schulnetz-ag.ch/aksa',
    deviceId: '0123456789abcdef01234567',
    userAgent: 'FaNotesTest',
    ssoCookies: { 'login.microsoftonline.com': 'PHPSESSID=phone-session; ESTSAUTHPERSISTENT=microsoft-cookie-value' },
  })
  assert.equal(status.linked, true)
  assert.equal(status.mode, 'web')
  const stored = await readFile(join(root, 'accounts', accountId, 'link.json'), 'utf8')
  assert.equal(stored.includes('microsoft-cookie-value'), false)
  assert.equal(stored.includes('phone-session'), false)
  await runtime.pollAccount(accountId)
  assert.equal(calls.some((call) => call.cookie.includes('phone-session')), false)
  assert.equal(calls.some((call) => call.url.includes('login.microsoftonline.com') && call.cookie.includes('ESTSAUTHPERSISTENT=microsoft-cookie-value')), true)
  assert.equal(calls.some((call) => call.url.includes('authorize.php')), false)
  const snapshot = JSON.parse(await readFile(join(root, 'accounts', accountId, 'snapshot.json'), 'utf8'))
  assert.equal(snapshot.grades[0].mark, 5.5)
  assert.equal(snapshot.grades[0].course.includes('MA-4a-He'), true)
})

test('an empty scheduler read keeps lessons, exams and appointments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-keep-'))
  const key = randomBytes(32)
  let phase = 'good'
  const lessonXml = '<data><event id="neu"><start_date>2026-11-04 08:15</start_date><end_date>2026-11-04 09:00</end_date><text>Mathematik</text><zimmerkuerzel>A1</zimmerkuerzel><event_type>0_stp</event_type></event></data>'
  const examXml = '<data><event id="phy"><start_date></start_date><vdatum>04.11.2026</vdatum><vzeit>10:15</vzeit><bdatum>04.11.2026</bdatum><bzeit>11:00</bzeit><text>Mathe &amp; Physik</text><fachkuerzel>PHY</fachkuerzel><zimmerkuerzel>B04</zimmerkuerzel><event_type>1_pru</event_type></event></data>'
  const calls = []
  const fetch = async (url, options = {}) => {
    const cookie = options.headers?.Cookie || ''
    const target = String(url)
    calls.push(target)
    const response = (status, body, { location = '', cookies = [] } = {}) => ({
      status,
      headers: { get: (name) => name.toLowerCase() === 'location' ? location : null },
      setCookies: cookies,
      text: async () => body,
    })
    if (target.endsWith('/index.php?pageid=1') && !cookie.includes('PHPSESSID=server-session')) {
      return response(302, '', { location: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?redirect_uri=https%3A%2F%2Fwww.schulnetz-ag.ch%2Faksa%2F' })
    }
    if (target.includes('login.microsoftonline.com')) {
      return response(302, '', { location: 'https://www.schulnetz-ag.ch/aksa/?code=abc' })
    }
    if (target.includes('/aksa/?code=') || target.includes('/aksa?code=')) {
      return response(200, '<a href="index.php?pageid=21311&id=abc123&transid=a1b2c3">Noten</a>', { cookies: ['PHPSESSID=server-session; Path=/; HttpOnly'] })
    }
    if (phase === 'wall') return response(200, '<html><body>Inaktivitätslimit überschritten</body></html>')
    if (target.includes('scheduler_processor') && target.includes('pageid=22202')) {
      return response(200, phase === 'good' ? lessonXml : '<data><event id="e"></event></data>')
    }
    if (target.includes('scheduler_processor') && target.includes('pageid=21312')) {
      return response(200, phase === 'good' ? examXml : '<data><event id="e"></event></data>')
    }
    const note = phase === 'good' ? '<div class="cls-start-mitteilung">Elternabend am Freitag</div>' : ''
    return response(200, `<html><body><a href="index.php?pageid=21311&amp;id=abc123&amp;transid=a1b2c3">Noten</a>${note}</body></html>`)
  }
  const runtime = createSchulnetzRuntime({
    root,
    key,
    fetch,
    autostart: false,
    now: () => new Date('2026-11-04T12:00:00Z'),
  })
  const accountId = 'd'.repeat(32)
  try {
    await runtime.linkAccount(accountId, {
      mode: 'web',
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      userAgent: 'FaNotesTest',
      ssoCookies: { 'login.microsoftonline.com': 'ESTSAUTHPERSISTENT=microsoft-cookie-value' },
    })
    await runtime.pollAccount(accountId)
    const first = JSON.parse(await readFile(join(root, 'accounts', accountId, 'snapshot.json'), 'utf8'))
    assert.equal(first.events.some((event) => event.id === 'neu'), true)
    assert.equal(first.exams.some((event) => event.id === 'phy' && event.text === 'Mathe & Physik'), true)
    assert.equal(first.messages.some((message) => message.body === 'Elternabend am Freitag'), true)
    const stamped = first.weekFetched['2026-11-02']
    phase = 'empty'
    await runtime.pollAccount(accountId)
    const second = JSON.parse(await readFile(join(root, 'accounts', accountId, 'snapshot.json'), 'utf8'))
    assert.equal(second.events.some((event) => event.id === 'neu'), true)
    assert.equal(second.exams.some((event) => event.id === 'phy'), true)
    assert.equal(second.messages.some((message) => message.body === 'Elternabend am Freitag'), true)
    assert.equal(second.weekFetched['2026-11-02'], stamped)
    phase = 'wall'
    await runtime.pollAccount(accountId)
    const third = JSON.parse(await readFile(join(root, 'accounts', accountId, 'snapshot.json'), 'utf8'))
    assert.equal(third.events.some((event) => event.id === 'neu'), true)
    assert.equal(third.exams.some((event) => event.id === 'phy'), true)
    assert.equal(third.messages.some((message) => message.body === 'Elternabend am Freitag'), true)
    const changesPath = join(root, 'accounts', accountId, 'changes.jsonl')
    const changes = await readFile(changesPath, 'utf8').catch(() => '')
    assert.equal(changes.includes('Lektion entfernt'), false)
    assert.equal(changes.includes('Prüfung entfällt'), false)
    assert.equal(calls.some((url) => url.includes('pageid=23118') || url.includes('pageid=9999')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a logged-in schulNetz page with menu logout links stays ok', () => {
  const html = `<html><body>
    <a href="loginto.php?pageid=1&amp;mode=5">Abmelden</a>
    <a href="index.php?pageid=1">Anmelden</a>
    <a href="index.php?pageid=1&amp;action=global_logout">Logout</a>
    <form><input name="login"><input name="passwort"></form>
    <span>Sitzung</span>
    <a href="index.php?pageid=21311&amp;id=abc123&amp;transid=a1b2c3">Noten</a>
    <script>${'$'}Config={"urlPost":"https://example.invalid/login"};</script>
  </body></html>`
  const url = 'https://www.schulnetz-ag.ch/aksa/index.php?pageid=21311&id=abc123&transid=a1b2c3'
  assert.equal(sessionProblem(url, html), '')
  assert.equal(microsoftLoginRequired(url, html), false)
  assert.equal(sessionProblem('https://www.schulnetz-ag.ch/aksa/', '<html><body>Bitte warten</body></html>'), 'login')
  const withHandshakeLink = html.replace('Abmelden', 'Abmelden mode=17 Login nicht erfolgreich')
  assert.equal(sessionProblem(url, withHandshakeLink), '')
  assert.equal(sessionProblem('https://www.schulnetz-ag.ch/aksa/loginto.php?mode=17&lang=', 'Login nicht erfolgreich.'), 'oauth')
})

test('a Microsoft sign-in page is login required, not a scraped grade page', () => {
  const html = '<html><head><title>Sign in to your account</title></head><body><script>$Config={"sCompanyDisplayName":"Alte Kantonsschule Aarau","sErrorCode":"50058","urlPost":"https://login.microsoftonline.com/common/login","pgid":"ConvergedSignIn"};</script></body></html>'
  assert.equal(sessionProblem('https://www.schulnetz-ag.ch/aksa/index.php?pageid=21111', html), 'microsoft')
  assert.equal(microsoftLoginRequired('https://login.microsoftonline.com/8c2df54b-02dc-4a78-809d-8a025372e6c4/oauth2/v2.0/authorize', html), true)
  assert.equal(parseGradesHtml(html).length, 0)
})

test('notify payload hashes stay stable and route to the matching screen', () => {
  assert.equal(notifyHash('math', '2026-11-01', 'Probe'), notifyHash('MATH', '2026-11-01', ' probe '))
  const grade = { id: 'g1', courseId: 'math', course: 'Mathematik', title: 'Probe', date: '2026-11-01', mark: 5.5, weight: 1 }
  const other = { id: 'g2', courseId: 'che', course: 'Chemie', title: 'Test', date: '2026-11-02', mark: 4.5, weight: 1 }
  const lesson = { id: 'e1', start: '2026-11-02T08:15:00', end: '2026-11-02T09:00:00', text: 'Mathematik', courseName: 'Mathematik', eventType: 'lesson' }
  const exam = { ...lesson, id: 'x1', eventType: 'exam', text: 'Prüfung' }
  const absence = { id: 'a1', dateFrom: '2026-10-01', subject: 'Französisch', reason: 'Arzt' }
  const snapshot = { grades: [grade, other], events: [lesson], exams: [exam], absences: [absence], messages: [{ id: 'm1', title: 'Elternabend', body: 'Freitag' }] }
  const gradeChange = { id: 'grade:g1', category: 'grade', title: 'Neue Note', body: 'Mathematik · Probe', targetId: gradeTargetId(grade), courseId: 'math', date: '2026-11-01', targetIds: [gradeTargetId(grade)] }
  const payload = notifyPayload(gradeChange)
  const parsed = JSON.parse(payload)
  assert.equal(parsed.target, 'grades')
  assert.deepEqual(parsed.targetIds, [gradeTargetId(grade)])
  const nested = parseNotifyLink(JSON.stringify({ event: 'message', message: payload }))
  assert.equal(nested.kind, 'grade')
  assert.deepEqual(nested.ids, [gradeTargetId(grade)])
  const opened = routeNotify(nested, snapshot)
  assert.equal(opened.tab, 'Noten')
  assert.equal(opened.courseId, 'math')
  assert.equal(opened.found, true)
  const missing = routeNotify({ kind: 'grade', ids: ['gone'], courseId: 'math', date: '2026-11-01' }, snapshot)
  assert.equal(missing.found, false)
  assert.match(missing.hint, /Note/)
  const grouped = groupGradeChanges([
    { id: 'grade:g1', category: 'grade', title: 'Neue Note', body: 'Mathe', targetId: gradeTargetId(grade), courseId: 'math', targetIds: [gradeTargetId(grade)] },
    { id: 'grade:g2', category: 'grade', title: 'Neue Note', body: 'Chemie', targetId: gradeTargetId(other), courseId: 'che', targetIds: [gradeTargetId(other)] },
  ])
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0].title, '2 neue Noten')
  const groupRoute = routeNotify(parseNotifyLink(notifyPayload(grouped[0])), snapshot)
  assert.equal(groupRoute.tab, 'Noten')
  assert.equal(groupRoute.courseId, '')
  assert.equal(groupRoute.highlightIds.length, 2)
  const lessonRoute = routeNotify({ kind: 'timetable', ids: [lessonTargetId(lesson)], courseId: '', date: '2026-11-02' }, snapshot)
  assert.equal(lessonRoute.tab, 'Plan')
  assert.equal(lessonRoute.day, '2026-11-02')
  const replaced = { ...lesson, id: 'neu', text: 'Mathematik Holm', courseName: 'Mathematik Holm', timetableText: 'Mathematik Holm', room: 'R201' }
  const replacedRoute = routeNotify({ kind: 'timetable', ids: ['gone'], courseId: 'math', date: '2026-11-02', body: 'Mathematik · 08:15–09:00 · Raum R201' }, { ...snapshot, events: [replaced] })
  assert.equal(replacedRoute.found, true)
  assert.equal(replacedRoute.hint, '')
  assert.deepEqual(replacedRoute.highlightIds, [lessonTargetId(replaced)])
  const wrongRoom = routeNotify({ kind: 'timetable', ids: ['gone'], courseId: 'math', date: '2026-11-02', body: 'Mathematik · 08:15–09:00 · Raum Z9' }, { ...snapshot, events: [replaced] })
  assert.equal(wrongRoom.found, false)
  const examRoute = routeNotify({ kind: 'exam', ids: [lessonTargetId(exam)], courseId: '', date: '' }, snapshot)
  assert.equal(examRoute.section, 'Pruefungen')
  const testRoute = routeNotify(parseNotifyLink(JSON.stringify({ id: 'push-test', category: 'settings', title: 'Testbenachrichtigung', body: 'x' })), snapshot)
  assert.equal(testRoute.section, 'Einstellungen')
  assert.equal(parseNotifyLink(JSON.stringify({ event: 'keepalive' })), null)
})

test('guess-grade mode redacts the mark from push copy and keeps each grade separate', () => {
  const grade = { id: 'g1', courseId: 'math', course: 'Mathematik', title: 'Probe', date: '2026-11-01', mark: 5.5, weight: 1 }
  const other = { id: 'g2', courseId: 'che', course: 'Chemie', title: 'Test', date: '2026-11-02', mark: 4.25, weight: 1 }
  const previous = { grades: [], events: [], exams: [], absences: [], messages: [] }
  const next = { grades: [grade, other], events: [], exams: [], absences: [], messages: [] }
  const changes = diffSnapshots(previous, next)
  assert.equal(changes.length, 2)
  assert.match(changes[0].body, /5[,.]5/)
  const hidden = prepareGradeNotifications(changes, true)
  assert.equal(hidden.length, 2)
  for (const change of hidden) {
    assert.match(change.title, /tippen zum Aufdecken/)
    assert.equal(change.body.includes('5,5') || change.body.includes('5.5') || change.body.includes('4,25') || change.body.includes('4.25'), false)
    assert.equal(JSON.stringify(change).includes('5,5') || JSON.stringify(change).includes('5.5'), false)
    assert.match(change.id, /:hidden$/)
  }
  assert.equal(hidden[0].body, 'Probe')
  assert.equal(hidden[1].body, 'Test')
  const open = prepareGradeNotifications(changes, false)
  assert.equal(open.length, 1)
  assert.equal(open[0].title, '2 neue Noten')
  const again = redactGradeChange(hidden[0])
  assert.equal(again.title, hidden[0].title)
})

const probe = (id, course, courseId = course) => ({
  id, course, courseId, subject: course, title: 'Probe', date: '2026-10-20', mark: 5.5, weight: 1,
})

test('a grade is notified once across redeploy, model change, app update and both delivery paths', () => {
  assert.equal(normalizeGradeDate('20.10.2026'), '2026-10-20')
  assert.equal(normalizeGradeDate('2026-10-20T08:00:00'), '2026-10-20')
  const hashed = { courseId: 'math', course: 'Mathematik', title: 'Probe', date: '2026-10-20', mark: 5.5, weight: 1 }
  assert.equal(gradeContentHash(hashed), '7a0eaaf2')
  assert.equal(gradeLooseHash(hashed), '38afa78f')
  const original = probe('web:MA-4a-He:20.10.2026:Probe:5.5', 'MA-4a-He')
  const reparsed = probe('api-99', 'Mathematik', 'math')
  reparsed.date = '20.10.2026'
  assert.equal(gradeLooseHash(original), gradeLooseHash(reparsed))
  const empty = { grades: [], events: [], exams: [], absences: [], messages: [] }
  const current = { ...empty, grades: [reparsed] }
  const lookedNew = diffSnapshots(empty, current)
  assert.equal(lookedNew.length, 1)
  assert.equal(lookedNew[0].title, 'Neue Note')
  assert.ok(lookedNew[0].gradeKeys.includes(`l:${gradeLooseHash(reparsed)}`))

  const redeploy = settleGradeNotifications(lookedNew, [original, reparsed], null)
  assert.equal(redeploy.migrated, true)
  assert.equal(redeploy.changes.length, 0)
  assert.ok(redeploy.keys.includes(`l:${gradeLooseHash(original)}`))

  const modelChange = diffSnapshots({ ...empty, grades: [original] }, current)
  assert.equal(modelChange.some((change) => change.category === 'grade'), false)
  const wipedModel = settleGradeNotifications(lookedNew, [reparsed], gradeLedgerEntries([original]))
  assert.equal(wipedModel.migrated, false)
  assert.equal(wipedModel.changes.some((change) => change.category === 'grade'), false)

  const appUpdate = settleGradeNotifications(lookedNew, [reparsed], null)
  assert.equal(appUpdate.migrated, true)
  assert.equal(appUpdate.changes.some((change) => change.category === 'grade'), false)

  const freshLedger = []
  const edited = { ...reparsed, id: 'api-99', mark: 4.5 }
  const editedChanges = diffSnapshots({ ...empty, grades: [reparsed] }, { ...empty, grades: [edited] })
  assert.equal(editedChanges[0].title, 'Notenänderung')
  const firstDelivery = settleGradeNotifications(editedChanges, [edited], freshLedger)
  assert.equal(firstDelivery.changes.filter((change) => change.category === 'grade').length, 1)
  const pushed = prepareGradeNotifications(firstDelivery.changes, false)
  assert.equal(pushed.length, 1)
  assert.deepEqual(pushed[0].gradeKeys, firstDelivery.changes[0].gradeKeys)
  const phone = settleGradeNotifications(pushed, [edited], firstDelivery.keys)
  assert.equal(phone.changes.some((change) => change.category === 'grade'), false)
  const secondDelivery = settleGradeNotifications(editedChanges, [edited], firstDelivery.keys)
  assert.equal(secondDelivery.changes.some((change) => change.category === 'grade'), false)

  assert.deepEqual(keepLoadedGrades([original], []), [original])
  assert.deepEqual(keepLoadedGrades([original], [reparsed]), [reparsed])
  assert.deepEqual(keepLoadedGrades([], []), [])
})

test('an empty scrape does not announce grades that were already on file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-grades-'))
  const key = randomBytes(32)
  let polls = 0
  const fetch = async (url) => {
    const json = (value) => ({ status: 200, text: async () => JSON.stringify(value) })
    if (String(url).endsWith('/token.php')) {
      return json({ access_token: 'access-token-value', refresh_token: 'rotated-refresh-token-value-123456', expires_in: 3600 })
    }
    if (String(url).includes('/me/grades')) {
      polls += 1
      if (polls === 1) return json([{ id: 'g1', course: 'Mathematik', courseId: 'math', title: 'Probe', date: '2026-10-20', mark: '5.5', weight: '1' }])
      if (polls === 2) return json([])
      if (polls === 3) return json([{ id: 'web:other', course: 'MA-4a-He', courseId: 'MA-4a-He', title: 'Probe', date: '20.10.2026', mark: '5.5', weight: '1' }])
      return json([{ id: 'g2', course: 'Englisch', courseId: 'en', title: 'Essay', date: '2026-11-01', mark: '4.5', weight: '1' }])
    }
    return json([])
  }
  const sent = []
  const runtime = createSchulnetzRuntime({
    root,
    key,
    fetch,
    autostart: false,
    fcmSend: async (message) => { sent.push(message); return { status: 200 } },
  })
  const accountId = 'c'.repeat(32)
  try {
    await runtime.linkAccount(accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'super-secret-refresh-token-value',
    })
    await runtime.addFcmToken(accountId, 'phone:APA91b-example-token-value')
    await runtime.pollAccount(accountId)
    const ledger = JSON.parse(await readFile(join(root, 'accounts', accountId, 'notified-grades.json'), 'utf8'))
    assert.equal(ledger.version, 1)
    assert.ok(ledger.keys.length > 0)
    assert.equal(sent.length, 0)
    await runtime.pollAccount(accountId)
    const kept = JSON.parse(await readFile(join(root, 'accounts', accountId, 'snapshot.json'), 'utf8'))
    assert.equal(kept.grades.length, 1)
    assert.equal(kept.grades[0].id, 'g1')
    assert.equal(sent.length, 0)
    await rm(join(root, 'accounts', accountId, 'notified-grades.json'), { force: true })
    await runtime.pollAccount(accountId)
    assert.equal(sent.length, 0)
    const reseeded = JSON.parse(await readFile(join(root, 'accounts', accountId, 'notified-grades.json'), 'utf8'))
    assert.ok(reseeded.keys.length > 0)
    await runtime.pollAccount(accountId)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].message.data.event, 'sync')
    assert.equal(sent[0].message.notification, undefined)
    assert.equal(JSON.stringify(sent[0]).includes('4.5'), false)
    assert.equal(JSON.stringify(sent[0]).includes('5.5'), false)
    assert.equal(JSON.stringify(sent[0]).includes('super-secret'), false)
    await runtime.pollAccount(accountId)
    assert.equal(sent.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('firebase data messages name an event and never a grade', () => {
  for (const event of ['sync', 'reauth', 'test']) {
    const message = fcmDataMessage('phone:APA91b-example-token-value', event)
    assert.equal(message.message.data.event, event)
    assert.equal(message.message.android.priority, 'HIGH')
    assert.equal(message.message.android.collapse_key, event === 'reauth' ? 'kanti-reauth' : event === 'test' ? 'kanti-test' : 'kanti-sync')
    assert.equal(message.message.android.ttl, '21600s')
    assert.equal(message.message.notification, undefined)
    assert.equal(JSON.stringify(message).includes('5.5'), false)
    assert.equal(JSON.stringify(message).includes('Neue Note'), false)
    assert.equal(message.message.data.probe, undefined)
  }
  const probeMessage = fcmDataMessage('phone:APA91b-example-token-value', 'sync', { probe: true, serverAt: '2026-11-07T12:00:00.000Z' })
  assert.equal(probeMessage.message.data.event, 'sync')
  assert.equal(probeMessage.message.data.probe, '1')
  assert.equal(probeMessage.message.data.serverAt, '2026-11-07T12:00:00.000Z')
  assert.equal(probeMessage.message.data.correlation, undefined)
  const correlated = fcmDataMessage('phone:APA91b-example-token-value', 'sync', { probe: true, serverAt: '2026-11-07T12:00:00.000Z', correlation: 'probe:20261107120000000' })
  assert.equal(correlated.message.data.correlation, 'probe:20261107120000000')
  assert.equal(fcmDataMessage('phone:APA91b-example-token-value', 'sync', { probe: true, correlation: 'user@example.com' }).message.data.correlation, undefined)
  assert.equal(fcmDataMessage('phone:APA91b-example-token-value', 'sync', { probe: true, correlation: 'probe:123;drop' }).message.data.correlation, undefined)
  assert.equal(probeMessage.message.android.collapse_key, 'kanti-probe')
  assert.equal(probeMessage.message.android.priority, 'HIGH')
  assert.equal(probeMessage.message.notification, undefined)
  assert.equal(JSON.stringify(probeMessage.message.data).includes('Neue Note'), false)
  assert.equal(JSON.stringify(probeMessage.message.data).includes('5.5'), false)
  assert.equal(fcmPriorityForChanges([{ category: 'grade' }, { category: 'timetable' }]), 'HIGH')
  assert.equal(fcmPriorityForChanges([{ category: 'exam' }]), 'HIGH')
  assert.equal(fcmPriorityForChanges([{ category: 'absence' }]), 'HIGH')
  assert.equal(fcmPriorityForChanges([{ category: 'deadline' }]), 'HIGH')
  assert.equal(fcmPriorityForChanges([{ category: 'event' }]), 'HIGH')
  assert.equal(fcmPriorityForChanges([{ category: 'timetable' }]), null)
  assert.equal(fcmPriorityForChanges([]), null)
  const quiet = fcmDataMessage('phone:APA91b-example-token-value', 'sync', { priority: 'NORMAL' })
  assert.equal(quiet.message.android.priority, 'NORMAL')
  assert.equal(quiet.message.android.ttl, '3600s')
  assert.equal(isValidFcmToken('phone:APA91b-example-token-value'), true)
  assert.equal(isValidFcmToken('bad token'), false)
  assert.equal(isValidFcmToken(''), false)
  assert.equal(fcmDropToken(404, '{}'), true)
  assert.equal(fcmDropToken(400, '{"error":{"details":[{"errorCode":"UNREGISTERED"}]}}'), true)
  assert.equal(fcmDropToken(200, '{}'), false)
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const signed = serviceAccountJwt({
    client_email: 'push@kantiplus.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    project_id: 'kantiplus',
  }, 1_700_000_000_000)
  assert.equal(signed.jwt.split('.').length, 3)
  assert.equal(signed.jwt.includes('PRIVATE'), false)
  assert.equal(signed.exp, 1_700_000_000 + 3600)
})

test('missing firebase credentials skip the push and do not throw', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-fcm-'))
  const key = randomBytes(32)
  let polls = 0
  const calls = []
  const fetch = async (url) => {
    calls.push(String(url))
    const json = (value) => ({ status: 200, text: async () => JSON.stringify(value) })
    if (String(url).endsWith('/token.php')) return json({ access_token: 'access-token-value', refresh_token: 'rotated-refresh-token-value-123456', expires_in: 3600 })
    if (String(url).includes('/me/grades')) {
      polls += 1
      const grades = [{ id: 'g1', course: 'Mathematik', title: 'Probe', date: '2026-10-20', mark: '5.5', weight: '1' }]
      if (polls > 1) grades.push({ id: 'g2', course: 'Englisch', title: 'Essay', date: '2026-11-01', mark: '4.5', weight: '1' })
      return json(grades)
    }
    return json([])
  }
  const runtime = createSchulnetzRuntime({ root, key, fetch, autostart: false, fcmAccountFile: join(root, 'missing-fcm.json') })
  const accountId = 'd'.repeat(32)
  try {
    await runtime.linkAccount(accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'super-secret-refresh-token-value',
    })
    const registered = await runtime.addFcmToken(accountId, 'phone:APA91b-example-token-value')
    assert.equal(JSON.stringify(registered).includes('APA91b'), false)
    await runtime.pollAccount(accountId)
    await runtime.pollAccount(accountId)
    assert.equal(calls.some((url) => url.includes('fcm.googleapis.com') || url.includes('ntfy') || url.includes('oauth2.googleapis.com')), false)
    const changes = await readFile(join(root, 'accounts', accountId, 'changes.jsonl'), 'utf8')
    assert.match(changes, /grade:g2:/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unregistered firebase token is forgotten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-fcm-drop-'))
  const key = randomBytes(32)
  let polls = 0
  const fetch = async (url) => {
    const json = (value) => ({ status: 200, text: async () => JSON.stringify(value) })
    if (String(url).endsWith('/token.php')) return json({ access_token: 'access-token-value', refresh_token: 'rotated-refresh-token-value-123456', expires_in: 3600 })
    if (String(url).includes('/me/grades')) {
      polls += 1
      const grades = [{ id: 'g1', course: 'Mathematik', title: 'Probe', date: '2026-10-20', mark: '5.5', weight: '1' }]
      if (polls > 1) grades.push({ id: 'g2', course: 'Englisch', title: 'Essay', date: '2026-11-01', mark: '4.5', weight: '1' })
      return json(grades)
    }
    return json([])
  }
  const runtime = createSchulnetzRuntime({
    root,
    key,
    fetch,
    autostart: false,
    fcmSend: async (message) => ({ status: 404, drop: true, event: message.message.data.event }),
  })
  const accountId = 'e'.repeat(32)
  try {
    await runtime.linkAccount(accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'super-secret-refresh-token-value',
    })
    await runtime.addFcmToken(accountId, 'phone:APA91b-example-token-value')
    await runtime.pollAccount(accountId)
    await runtime.pollAccount(accountId)
    const stored = JSON.parse(await readFile(join(root, 'accounts', accountId, 'link.json'), 'utf8'))
    assert.deepEqual(stored.fcmTokens, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const invokeSchulnetz = async (runtime, method, path, headers = {}, body = '') => {
  const request = Readable.from(body ? [Buffer.from(body)] : [])
  request.method = method
  request.headers = headers
  request.socket = { remoteAddress: '198.51.100.10' }
  let status = 0
  let payload = ''
  const response = {
    writeHead(code) { status = code },
    end(value) { payload = value || '' },
  }
  const handled = await runtime.handle(request, response, new URL(`http://127.0.0.1${path}`))
  assert.equal(handled, true)
  return { status, body: payload ? JSON.parse(payload) : {} }
}

const guestHeaders = (guest) => ({
  authorization: `Bearer ${guest.token}`,
  'x-kanti-guest': guest.accountId,
})

const schoolFetch = () => async (url) => {
  const json = (value) => ({ status: 200, text: async () => JSON.stringify(value) })
  if (String(url).endsWith('/token.php')) return json({ access_token: 'access-token-value', refresh_token: 'rotated-refresh-token-value-123456', expires_in: 3600 })
  if (String(url).includes('/me/grades')) {
    return json([{ id: 'g1', course: 'Mathematik', title: 'Probe', date: '2026-10-20', mark: '5.5', weight: '1' }])
  }
  return json([])
}

const linkBody = {
  baseUrl: 'https://www.schulnetz-ag.ch/aksa',
  deviceId: '0123456789abcdef01234567',
  refreshToken: 'super-secret-refresh-token-value',
}

test('an anonymous kanti identity owns schulnetz without a fanotes login', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-guest-'))
  const runtime = createSchulnetzRuntime({ root, key: randomBytes(32), fetch: schoolFetch(), autostart: false, fcmSend: async () => ({ status: 200 }) })
  try {
    const created = await invokeSchulnetz(runtime, 'POST', '/api/v1/schulnetz/guest')
    assert.equal(created.status, 200)
    assert.match(created.body.accountId, /^[a-f0-9]{32}$/)
    assert.match(created.body.token, /^[A-Za-z0-9_-]{40,80}$/)
    const stored = JSON.parse(await readFile(join(root, 'accounts', created.body.accountId, 'guest.json'), 'utf8'))
    assert.equal(stored.v, 1)
    assert.equal(JSON.stringify(stored).includes(created.body.token), false)
    const wrong = await invokeSchulnetz(runtime, 'GET', '/api/v1/schulnetz/status', {
      authorization: `Bearer ${'a'.repeat(43)}`,
      'x-kanti-guest': created.body.accountId,
    })
    assert.equal(wrong.status, 401)
    const status = await invokeSchulnetz(runtime, 'GET', '/api/v1/schulnetz/status', guestHeaders(created.body))
    assert.equal(status.status, 200)
    assert.equal(status.body.linked, false)
    const blocked = await invokeSchulnetz(runtime, 'POST', '/api/v1/schulnetz/adopt', guestHeaders(created.body), '{}')
    assert.equal(blocked.status, 403)
    await runtime.linkAccount(created.body.accountId, linkBody)
    const unlinked = await invokeSchulnetz(runtime, 'DELETE', '/api/v1/schulnetz/link', guestHeaders(created.body))
    assert.equal(unlinked.status, 200)
    assert.equal(JSON.parse(await readFile(join(root, 'accounts', created.body.accountId, 'guest.json'), 'utf8')).v, 1)
    await assert.rejects(readFile(join(root, 'accounts', created.body.accountId, 'link.json')))
    const removed = await invokeSchulnetz(runtime, 'DELETE', '/api/v1/schulnetz/guest', guestHeaders(created.body))
    assert.equal(removed.status, 200)
    await assert.rejects(readFile(join(root, 'accounts', created.body.accountId, 'guest.json')))
    for (let i = 0; i < 30; i += 1) await runtime.createGuest('203.0.113.77')
    await assert.rejects(() => runtime.createGuest('203.0.113.77'), (error) => error.status === 429)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('adopt and detach move school data without a second grade push', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-adopt-'))
  const sent = []
  const runtime = createSchulnetzRuntime({
    root,
    key: randomBytes(32),
    fetch: schoolFetch(),
    autostart: false,
    fcmSend: async (message) => { sent.push(message); return { status: 200 } },
  })
  const fa = 'a'.repeat(32)
  const other = 'phone:APA91b-other-device-token'
  const mine = 'phone:APA91b-example-token-value'
  try {
    const guest = await runtime.createGuest('203.0.113.41')
    await runtime.linkAccount(guest.accountId, linkBody)
    await runtime.addFcmToken(guest.accountId, mine)
    await runtime.pollAccount(guest.accountId)
    assert.equal(sent.length, 0)
    await runtime.addFcmToken(guest.accountId, other)
    const adopted = await runtime.adoptGuest(fa, { guestAccountId: guest.accountId, guestToken: guest.token })
    assert.equal(adopted.adopted, true)
    assert.equal(sent.length, 0)
    await assert.rejects(readFile(join(root, 'accounts', guest.accountId, 'guest.json')))
    await runtime.pollAccount(fa)
    assert.equal(sent.length, 0)
    const quiet = await readFile(join(root, 'accounts', fa, 'changes.jsonl'), 'utf8').catch(() => '')
    assert.equal(quiet.includes('grade:'), false)

    const home = await runtime.createGuest('203.0.113.43')
    const detached = await runtime.detachGuest(fa, { guestAccountId: home.accountId, guestToken: home.token, fcmToken: mine })
    assert.equal(detached.detached, true)
    assert.equal(sent.length, 0)
    const faTokens = JSON.parse(await readFile(join(root, 'accounts', fa, 'link.json'), 'utf8')).fcmTokens
    const guestTokens = JSON.parse(await readFile(join(root, 'accounts', home.accountId, 'link.json'), 'utf8')).fcmTokens
    assert.equal(faTokens.includes(mine), false)
    assert.ok(faTokens.includes(other))
    assert.deepEqual(guestTokens, [mine])
    const guestLink = JSON.parse(await readFile(join(root, 'accounts', home.accountId, 'link.json'), 'utf8'))
    assert.equal(guestLink.needsReauth, true)
    assert.equal(guestLink.refresh, null)
    const faLink = JSON.parse(await readFile(join(root, 'accounts', fa, 'link.json'), 'utf8'))
    assert.ok(faLink.refresh)
    await runtime.pollAccount(fa)
    await runtime.pollAccount(home.accountId)
    assert.equal(sent.length, 0)
    const faAfter = JSON.parse(await readFile(join(root, 'accounts', fa, 'link.json'), 'utf8'))
    assert.equal(faAfter.needsReauth, false)

    const faWeb = 'c'.repeat(32)
    await runtime.linkAccount(faWeb, {
      mode: 'web',
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      userAgent: 'KantiPlus',
      ssoCookies: { 'login.microsoftonline.com': 'ESTSAUTHPERSISTENT=cookie-value-long' },
    })
    const webBefore = JSON.parse(await readFile(join(root, 'accounts', faWeb, 'link.json'), 'utf8'))
    webBefore.serverSession = webBefore.sso
    await writeFile(join(root, 'accounts', faWeb, 'link.json'), JSON.stringify(webBefore))
    const device = await runtime.createGuest('203.0.113.44')
    await runtime.detachGuest(faWeb, { guestAccountId: device.accountId, guestToken: device.token })
    const webGuest = JSON.parse(await readFile(join(root, 'accounts', device.accountId, 'link.json'), 'utf8'))
    const webFa = JSON.parse(await readFile(join(root, 'accounts', faWeb, 'link.json'), 'utf8'))
    assert.equal(webGuest.mode, 'web')
    assert.equal(webGuest.serverSession, null)
    assert.equal(webGuest.needsReauth, false)
    assert.ok(webGuest.sso)
    assert.ok(webFa.serverSession)
    assert.equal(sent.length, 0)

    const second = await runtime.createGuest('203.0.113.42')
    await runtime.linkAccount(second.accountId, linkBody)
    await writeFile(join(root, 'accounts', fa, 'snapshot.json'), JSON.stringify({ revision: 3, grades: [{ id: 'keep' }] }))
    await writeFile(join(root, 'accounts', second.accountId, 'snapshot.json'), JSON.stringify({ revision: 9, grades: [{ id: 'other' }] }))
    await writeFile(join(root, 'accounts', fa, 'notified-grades.json'), JSON.stringify({ version: 1, keys: ['c:aaa'] }))
    await writeFile(join(root, 'accounts', second.accountId, 'notified-grades.json'), JSON.stringify({ version: 1, keys: ['c:bbb'] }))
    await runtime.addFcmToken(second.accountId, 'phone:APA91b-second-guest-token')
    await runtime.adoptGuest(fa, { guestAccountId: second.accountId, guestToken: second.token })
    assert.equal(sent.length, 0)
    const kept = JSON.parse(await readFile(join(root, 'accounts', fa, 'snapshot.json'), 'utf8'))
    assert.equal(kept.grades[0].id, 'keep')
    const ledger = JSON.parse(await readFile(join(root, 'accounts', fa, 'notified-grades.json'), 'utf8'))
    assert.ok(ledger.keys.includes('c:aaa'))
    assert.ok(ledger.keys.includes('c:bbb'))
    await assert.rejects(() => runtime.deleteGuestAccount(fa), (error) => error.status === 404)
    await runtime.deleteGuestAccount(home.accountId)
    await assert.rejects(readFile(join(root, 'accounts', home.accountId, 'link.json')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const guestCall = async (runtime, guest, method, path, body) => {
  const request = {
    method,
    headers: { 'x-kanti-guest': guest.accountId, authorization: `Bearer ${guest.token}` },
    socket: { remoteAddress: '203.0.113.9' },
    async *[Symbol.asyncIterator]() {
      if (body != null) yield Buffer.from(body)
    },
  }
  let status = 0
  let payload = ''
  const response = {
    writeHead(code) { status = code },
    end(text) { payload = String(text || '') },
  }
  await runtime.handle(request, response, new URL(`http://127.0.0.1${path}`))
  return { status, body: payload ? JSON.parse(payload) : {} }
}

const webLinkBody = (cookies) => JSON.stringify({
  mode: 'web',
  baseUrl: 'https://www.schulnetz-ag.ch/aksa',
  deviceId: '0123456789abcdef01234567',
  ssoCookies: cookies,
})

test('account deletion unlinks schulnetz and a later poll does not recreate it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-delete-'))
  const key = randomBytes(32)
  const runtime = createSchulnetzRuntime({ root, key, autostart: false, fetch: async () => { throw new Error('fetched') } })
  const accountId = 'd'.repeat(32)
  setAccountDeletedHook((id) => runtime.unlink(id))
  try {
    await runtime.linkAccount(accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'refresh-token-value-long-enough',
    })
    await notifyAccountDeleted(accountId)
    await assert.rejects(stat(join(root, 'accounts', accountId)))
    const polled = await runtime.pollAccount(accountId)
    assert.equal(polled.skipped, true)
    await assert.rejects(stat(join(root, 'accounts', accountId)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the poller drops an orphan link and keeps a guest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-orphan-'))
  const key = randomBytes(32)
  const runtime = createSchulnetzRuntime({
    root,
    key,
    autostart: false,
    pruneOrphans: true,
    syncAccountExists: async () => false,
    fetch: async () => ({ status: 200, text: async () => '[]' }),
  })
  try {
    const orphan = 'e'.repeat(32)
    await runtime.linkAccount(orphan, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'refresh-token-value-long-enough',
    })
    const skipped = await runtime.pollAccount(orphan)
    assert.equal(skipped.skipped, true)
    await assert.rejects(stat(join(root, 'accounts', orphan)))
    const guest = await runtime.createGuest('203.0.113.10')
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'refresh-token-value-long-enough',
    })
    await runtime.pollAccount(guest.accountId)
    assert.equal((await stat(join(root, 'accounts', guest.accountId, 'guest.json'))).isFile(), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a redirect to loopback and a microsoft lookalike are not fetched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-ssrf-'))
  const key = randomBytes(32)
  const calls = []
  const fetch = async (url) => {
    const target = String(url)
    calls.push(target)
    if (target.includes('127.0.0.1') || target.includes('microsoft.evil.tld')) throw new Error('fetched blocked host')
    return {
      status: 302,
      headers: { get: (name) => name.toLowerCase() === 'location' ? 'https://127.0.0.1/' : null },
      setCookies: [],
      text: async () => '',
    }
  }
  const runtime = createSchulnetzRuntime({ root, key, fetch, autostart: false })
  const accountId = 'f'.repeat(32)
  try {
    await runtime.linkAccount(accountId, JSON.parse(webLinkBody({ 'login.microsoftonline.com': 'ESTSAUTHPERSISTENT=microsoft-cookie-value' })))
    const result = await runtime.pollAccount(accountId)
    assert.equal(result.needsReauth, true)
    assert.equal(calls.some((url) => url.includes('127.0.0.1')), false)
    assert.equal(calls.some((url) => url.includes('microsoft.evil.tld')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stored cookies keep only the login names and expire after 14 days', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-cookie-'))
  const key = randomBytes(32)
  let clock = Date.parse('2026-01-01T00:00:00Z')
  const runtime = createSchulnetzRuntime({
    root,
    key,
    autostart: false,
    now: () => new Date(clock),
    fetch: async () => { throw new Error('fetched after expiry') },
  })
  const accountId = '1'.repeat(32)
  try {
    await runtime.linkAccount(accountId, JSON.parse(webLinkBody({
      'login.microsoftonline.com': 'PHPSESSID=phone; buid=drop-me; ESTSAUTH=keep-me; fpc=also-drop',
      'evil.example': 'ESTSAUTH=foreign',
    })))
    const stored = JSON.parse(await readFile(join(root, 'accounts', accountId, 'link.json'), 'utf8'))
    assert.equal(stored.cookiesSavedAt, '2026-01-01T00:00:00.000Z')
    const cookies = JSON.parse(openToken(key, stored.sso))
    assert.deepEqual(cookies, { 'login.microsoftonline.com': 'ESTSAUTH=keep-me' })
    clock += 15 * 24 * 60 * 60 * 1000
    const expired = await runtime.pollAccount(accountId)
    assert.equal(expired.needsReauth, true)
    const after = JSON.parse(await readFile(join(root, 'accounts', accountId, 'link.json'), 'utf8'))
    assert.equal(after.sso, null)
    await runtime.unlink(accountId)
    await assert.rejects(stat(join(root, 'accounts', accountId, 'link.json')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('schulnetz routes are rate limited per account', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-rate-'))
  const key = randomBytes(32)
  const runtime = createSchulnetzRuntime({ root, key, autostart: false, fetch: async () => ({ status: 200, text: async () => '{}' }) })
  try {
    const first = await runtime.createGuest('203.0.113.20')
    const second = await runtime.createGuest('203.0.113.21')
    const body = webLinkBody({ 'login.microsoftonline.com': 'ESTSAUTH=microsoft-cookie-value' })
    for (let index = 0; index < 5; index += 1) {
      const response = await guestCall(runtime, first, 'PUT', '/api/v1/schulnetz/link', body)
      assert.equal(response.status, 200)
    }
    const blocked = await guestCall(runtime, first, 'PUT', '/api/v1/schulnetz/link', body)
    assert.equal(blocked.status, 429)
    assert.equal(blocked.body.error, 'Zu viele Anfragen. Bitte später erneut versuchen.')
    const other = await guestCall(runtime, second, 'PUT', '/api/v1/schulnetz/link', body)
    assert.equal(other.status, 200)
    for (let index = 0; index < 60; index += 1) {
      const response = await guestCall(runtime, second, 'PUT', '/api/v1/schulnetz/snapshot', '{"grades":[]}')
      assert.equal(response.status, 200)
    }
    const snapshotBlocked = await guestCall(runtime, second, 'PUT', '/api/v1/schulnetz/snapshot', '{"grades":[]}')
    assert.equal(snapshotBlocked.status, 429)
    for (let index = 0; index < 5; index += 1) {
      const response = await guestCall(runtime, second, 'POST', '/api/v1/schulnetz/push/test', '{}')
      assert.equal(response.status, 200)
    }
    const pushBlocked = await guestCall(runtime, second, 'POST', '/api/v1/schulnetz/push/test', '{}')
    assert.equal(pushBlocked.status, 429)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('schulnetz errors do not echo internal messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-error-'))
  const key = randomBytes(32)
  const runtime = createSchulnetzRuntime({ root, key, autostart: false })
  const guest = await runtime.createGuest('203.0.113.30')
  try {
    const rejected = await guestCall(runtime, guest, 'PUT', '/api/v1/schulnetz/link', '{}')
    assert.equal(rejected.status, 400)
    assert.equal(rejected.body.error, 'Die Schulnetz-Adresse ist nicht erlaubt.')
    assert.equal(JSON.stringify(rejected.body).includes('schulnetz'), false)
    const request = {
      method: 'PUT',
      headers: { 'x-kanti-guest': guest.accountId, authorization: `Bearer ${guest.token}` },
      socket: { remoteAddress: '203.0.113.30' },
      async *[Symbol.asyncIterator]() { throw new Error('leak-this-token-value') },
    }
    let payload = ''
    const response = { writeHead() {}, end(text) { payload = String(text || '') } }
    await runtime.handle(request, response, new URL('http://127.0.0.1/api/v1/schulnetz/link'))
    assert.equal(payload.includes('leak-this-token-value'), false)
    assert.equal(JSON.parse(payload).error, 'Der Schulnetz-Dienst ist vorübergehend nicht erreichbar.')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reading a link drops the retired ntfy fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-legacy-'))
  const key = randomBytes(32)
  const runtime = createSchulnetzRuntime({ root, key, autostart: false })
  const accountId = '2'.repeat(32)
  try {
    await runtime.linkAccount(accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'refresh-token-value-long-enough',
    })
    const file = join(root, 'accounts', accountId, 'link.json')
    const stored = JSON.parse(await readFile(file, 'utf8'))
    stored.topic = 'old-topic'
    stored.pushEndpoints = ['https://ntfy.example/topic']
    await writeFile(file, JSON.stringify(stored))
    const status = await runtime.publicStatusOf(accountId)
    assert.equal(status.push.topic, undefined)
    const cleaned = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(cleaned.topic, undefined)
    assert.equal(cleaned.pushEndpoints, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('week range follows the page span and stays quiet for a new week', () => {
  const clock = '<script>scheduler.config.limit_start = new Date(2026, 7, 17); scheduler.config.limit_end = new Date(2027, 6, 4);</script>'
  assert.deepEqual(parseWeekSpan(clock), { start: '2026-08-17', end: '2027-07-04' })
  assert.equal(parseWeekSpan('<html><body>Stundenplan</body></html>'), null)
  assert.equal(parseWeekSpan('<script>scheduler.config.limit_start = new Date(Date.UTC(2026, 7, 17)); scheduler.config.limit_end = new Date(Date.UTC(2027, 6, 4));</script>'), null)
  assert.equal(parseWeekSpan('<div data-min-date="17.08.2026" data-max-date="04.07.2027"></div>'), null)
  assert.deepEqual(parseWeekSpan('<div data-min-date="2026-08-17" data-max-date="2027-07-04"></div>'), { start: '2026-08-17', end: '2027-07-04' })
  const mondays = []
  for (let day = '2026-01-05'; day <= '2027-06-28'; day = new Date(Date.parse(`${day}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10)) mondays.push(day)
  const first = planWeekFetches({ mondays, fetchedAt: {}, icalFetchedAt: '', now: '2026-11-04T12:00:00Z', today: '2026-11-04', icalAvailable: true })
  assert.equal(first.fetch.length, WEEK_PROBE * 2 + 1 + WEEK_BATCH)
  assert.equal(first.fetch.includes('2026-10-26'), true)
  assert.equal(first.fetch.includes('2026-11-16'), true)
  assert.equal(first.fetch.includes('2026-11-23'), true)
  assert.equal(first.fetchIcal, true)
  const walked = planWeekFetches({ mondays, fetchedAt: {}, icalFetchedAt: '', now: '2026-11-04T12:00:00Z', today: '2026-11-04', icalAvailable: false })
  assert.equal(walked.fetch.length, WEEK_PROBE * 2 + 1 + WEEK_BATCH)
  assert.equal(walked.fetch.length < WEEK_CAP, true)
  assert.equal(walked.fetchIcal, false)
  const currentOnly = planWeekFetches({ mondays: [], fetchedAt: {}, icalFetchedAt: '', now: '2026-11-04T12:00:00Z', today: '2026-11-04', icalAvailable: false })
  assert.deepEqual(currentOnly.fetch, ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'])
  assert.equal(currentOnly.fetchIcal, false)
  const held = planWeekFetches({ mondays: [], fetchedAt: { '2026-11-02': '2026-11-04T12:00:00Z' }, icalFetchedAt: '', now: '2026-11-04T12:00:00Z', today: '2026-11-04', icalAvailable: false })
  assert.deepEqual(held.fetch, currentOnly.fetch)
  const freshProbe = Object.fromEntries(currentOnly.fetch.map((day) => [day, '2026-11-04T12:00:00Z']))
  const quietProbe = planWeekFetches({ mondays: [], fetchedAt: freshProbe, icalFetchedAt: '', now: '2026-11-04T12:00:00Z', today: '2026-11-04', icalAvailable: false })
  assert.deepEqual(quietProbe.fetch, ['2026-11-02'])
  const oneFar = planWeekFetches({
    mondays: [],
    fetchedAt: { ...freshProbe, '2026-11-16': '2026-11-03T11:00:00Z', '2026-11-23': '2026-11-03T11:00:00Z', '2026-11-30': '2026-11-03T10:00:00Z' },
    icalFetchedAt: '',
    now: '2026-11-04T12:00:00Z',
    today: '2026-11-04',
    icalAvailable: false,
  })
  assert.deepEqual(oneFar.fetch, ['2026-11-02', '2026-11-16', '2026-11-23', '2026-11-30'])
  const spanStamps = Object.fromEntries(mondays.map((day) => [day, '2026-11-03T11:00:00Z']))
  spanStamps['2026-11-02'] = '2026-11-04T12:00:00Z'
  spanStamps['2026-10-26'] = '2026-11-04T12:00:00Z'
  spanStamps['2026-11-09'] = '2026-11-04T12:00:00Z'
  spanStamps['2026-08-17'] = '2026-10-01T00:00:00Z'
  const spanFar = planWeekFetches({ mondays, fetchedAt: spanStamps, icalFetchedAt: '', now: '2026-11-04T12:00:00Z', today: '2026-11-04', icalAvailable: false })
  assert.equal(spanFar.fetch.includes('2026-11-02'), true)
  assert.equal(spanFar.fetch.includes('2026-10-26'), false)
  assert.equal(spanFar.fetch.includes('2026-11-09'), false)
  assert.equal(spanFar.fetch.includes('2026-08-17'), true)
  assert.equal(spanFar.fetch.length, 7 + WEEK_BATCH)
  const lesson = (id, start, room = 'A1') => ({ id, start, end: start, room, text: 'Mathematik', courseName: 'Mathematik', teachers: ['Nord'], status: '', eventType: 'lesson' })
  const taught = confirmedLessonStamps([lesson('e1', '2026-11-02T08:15:00')], { '2026-11-02': 'a', '2026-11-09': 'a', '2026-11-16': 'a' }, {})
  assert.deepEqual(Object.keys(taught), ['2026-11-02'])
  assert.deepEqual(confirmedLessonStamps([], { '2026-11-09': 'a' }, { '2026-11-16': 'b' }), { '2026-11-16': 'b' })
  const previous = { events: [lesson('e1', '2026-11-02T08:15:00')], exams: [], weekFetched: {} }
  const next = {
    events: [lesson('e1', '2026-11-02T08:15:00', 'B2'), lesson('e2', '2026-11-16T08:15:00')],
    exams: [],
    weekFetched: { '2026-11-02': '2026-11-04T12:00:00Z', '2026-11-16': '2026-11-04T12:00:00Z' },
  }
  assert.deepEqual(diffSnapshots(previous, next).map((change) => change.title), ['Raum geändert'])
  const quietLegacy = diffSnapshots(
    { events: [], exams: [], weekFetched: { '2026-11-16': '2026-11-01T00:00:00Z' }, weekRead: {} },
    { events: [lesson('e2', '2026-11-16T08:15:00')], exams: [], weekFetched: { '2026-11-16': '2026-11-04T12:00:00Z' }, weekRead: { '2026-11-16': '2026-11-04T12:00:00Z' } },
  )
  assert.equal(quietLegacy.some((change) => change.category === 'timetable'), false)
  assert.equal(introducedWeeks({ events: [], exams: [] }, { events: [lesson('e1', '2026-11-02T08:15:00')], exams: [] }).size, 0)
  const legacy = diffSnapshots({ grades: [], events: [], exams: [], absences: [], messages: [] }, { events: [lesson('e1', '2026-11-02T08:15:00')], exams: [] })
  assert.equal(legacy.some((change) => change.category === 'timetable'), true)
  const merged = overlayLessons(
    [lesson('e1', '2026-11-02T08:15:00'), { ...lesson('t1', '2026-11-03T15:00:00'), eventType: 'event' }, lesson('far', '2026-12-07T08:15:00')],
    [lesson('e2', '2026-11-04T09:00:00', 'B2')],
    new Set(['2026-11-02']),
  )
  assert.deepEqual(merged.map((event) => event.id), ['t1', 'far', 'e2'])
  const xml = `<data>
    <event id="p1"><start_date>2026-11-12 10:00</start_date><end_date>2026-11-12 10:45</end_date><text><![CDATA[Mathematik]]></text><event_type><![CDATA[1_pru]]></event_type></event>
    <event id="s1"><start_date>2026-11-12 08:00</start_date><end_date>2026-11-12 08:45</end_date><text><![CDATA[Deutsch]]></text><event_type><![CDATA[0_stp]]></event_type></event>
    <event id="w1"><start_date>2026-11-13 09:00</start_date><end_date>2026-11-13 09:45</end_date><text><![CDATA[Test Chemie]]></text><event_type>0_stp</event_type></event>
  </data>`
  const byId = Object.fromEntries(parseSchedulerXml(xml).map((event) => [event.id, event]))
  assert.equal(byId.p1.eventType, 'exam')
  assert.equal(byId.p1.text, 'Mathematik')
  assert.equal(isExamLike(byId.p1), true)
  assert.equal(isLesson(byId.p1), false)
  assert.equal(byId.s1.eventType, '0_stp')
  assert.equal(isExamLike(byId.s1), false)
  assert.equal(isLesson(byId.s1), true)
  assert.equal(isExamLike(byId.w1), true)
  assert.equal(isLesson(byId.w1), false)
  const oldDeutsch = { id: 'old', start: '2026-11-12T08:00:00', end: '2026-11-12T08:45:00', text: 'Deutsch', courseName: 'Deutsch', room: 'A1', teachers: ['Nord'], status: '', eventType: 'lesson' }
  const shown = overlayLessons([oldDeutsch], [byId.s1], new Set(['2026-11-09']))
  assert.deepEqual(shown.map((event) => event.id), ['s1'])
  const quietId = diffSnapshots({ events: [oldDeutsch], exams: [], messages: [] }, { events: [byId.s1], exams: [], messages: [] })
  assert.equal(quietId.some((change) => change.title === 'Lektion entfernt' || change.title === 'Stundenplan geändert'), false)
  assert.equal(isExamLike({ eventType: 'lesson', text: 'Lesetest', timetableText: 'Lesetest' }), false)
  assert.equal(isLesson({ eventType: 'lesson', text: 'Lesetest', timetableText: 'Lesetest' }), true)
  assert.equal(isExamLike({ eventType: '<![CDATA[1_pru]]>', text: 'Mathematik' }), true)
  assert.equal(isLesson({ eventType: '<![CDATA[1_pru]]>', text: 'Mathematik' }), false)
  const named = Object.fromEntries(parseSchedulerXml(`<data>
    <event id="m"><start_date>2026-11-04 08:15</start_date><end_date>2026-11-04 09:00</end_date><text>M4a</text><fachbezeichnung>Mathematik</fachbezeichnung><fachkuerzel>M4a</fachkuerzel><event_type>0_stp</event_type></event>
    <event id="d"><start_date>2026-11-04 09:05</start_date><end_date>2026-11-04 09:50</end_date><text>Deutsch</text><fachbezeichnung>Mathematik</fachbezeichnung><event_type>0_stp</event_type></event>
    <event id="c"><start_date>2026-11-04 10:00</start_date><end_date>2026-11-04 10:45</end_date><text>PHY</text><event_type>0_stp</event_type></event>
  </data>`).map((event) => [event.id, event]))
  assert.equal(named.m.text, 'Mathematik')
  assert.equal(named.m.courseName, 'M4a')
  assert.equal(named.d.text, 'Deutsch')
  assert.equal(named.c.text, 'PHY')
  const carried = carryTimetableExams([byId.s1, byId.w1], [byId.p1])
  assert.deepEqual(carried.map((event) => event.id), ['p1', 'w1'])
  const icsTest = parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:u-test\nDTSTART:20261112T100000\nDTEND:20261112T104500\nSUMMARY:Test Chemie\nEND:VEVENT\nEND:VCALENDAR')
  assert.equal(icsTest[0].eventType, 'exam')
  const icsLesson = parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:u-lesson\nDTSTART:20261112T080000\nDTEND:20261112T084500\nSUMMARY:Lesetest\nEND:VEVENT\nEND:VCALENDAR')
  assert.equal(icsLesson[0].eventType, 'lesson')
  const narrow = eventQueryWindow({ spanStart: '', spanEnd: '', weekFetched: {}, icalFetchedAt: '', today: '2026-11-04', now: '2026-11-04T12:00:00Z' })
  assert.equal(narrow.wide, false)
  assert.equal(narrow.min, '2026-10-28')
  assert.equal(narrow.max, '2026-11-25')
  const wide = eventQueryWindow({ spanStart: '2026-08-17', spanEnd: '2027-07-04', weekFetched: {}, icalFetchedAt: '', today: '2026-11-04', now: '2026-11-04T12:00:00Z' })
  assert.equal(wide.wide, true)
  assert.equal(wide.min, '2026-08-17')
  const base = 'https://www.schulnetz-ag.ch/aksa'
  assert.equal(schulnetzCallAllowed('GET', `${base}/abo.ics`), true)
  assert.equal(schulnetzCallAllowed('POST', `${base}/abo.ics`), false)
  assert.equal(schulnetzCallAllowed('GET', `${base}/abo.ics?pageid=23118`), false)
  assert.equal(schulnetzCallAllowed('GET', `${base}/abo.ics?pageid=9999`), false)
  assert.equal(schulnetzCallAllowed('GET', `${base}/index.php?pageid=9999`), false)
  assert.equal(zurichTimeshift('2026-11-04'), -60)
  assert.equal(zurichTimeshift('2026-08-17'), -120)
  const url = schedulerFetchUrl({ root: base, pageId: '22202', ansicht: 'schueleransicht', id: 'abc', transid: 'def', today: '2026-11-04', min: '2026-11-02', max: '2026-11-09' })
  assert.equal(url.includes('action='), false)
  assert.equal(url.includes('pageid=22202'), true)
  assert.equal(url.includes('min_date=2026-11-02'), true)
  assert.equal(url.includes('max_date=2026-11-09'), true)
  assert.equal(url.includes('timeshift=-60'), true)
  const examUrl = schedulerFetchUrl({ root: base, pageId: '21312', ansicht: 'klassenuebersicht', id: 'abc', transid: 'def', today: '2026-11-02', min: '2026-11-02', max: '2026-11-09', extra: 'showOnlyThisClass=-1' })
  assert.equal(examUrl.includes('pageid=21312'), true)
  assert.equal(examUrl.includes('action='), false)
})

test('a web scrape reads the whole current week and keeps a far lesson', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    const scheduler = String(url).includes('scheduler_processor')
    const body = scheduler ? '<data></data>' : '<html><body>ok</body></html>'
    return { status: 200, headers: { get: () => '' }, text: async () => body }
  }
  const session = { php: 'php', id: 'abc', transid: 'def', userAgent: 'test' }
  const base = 'https://www.schulnetz-ag.ch/aksa'
  const first = await scrapeWithSession(base, session, fetchImpl, { today: '2026-11-04', now: '2026-11-04T12:00:00Z' })
  const schedulers = urls.filter((url) => url.includes('scheduler_processor'))
  assert.equal(schedulers.some((url) => url.includes('pageid=22202') && url.includes('min_date=2026-11-02') && url.includes('max_date=2026-11-09') && !url.includes('action=')), true)
  assert.equal(schedulers.some((url) => url.includes('pageid=21312') && !url.includes('action=')), true)
  assert.equal(first.weekFetched['2026-11-02'], undefined)
  // Every week answered empty and none had lessons: that proves nothing, so no week looks free.
  assert.equal(first.weekRead['2026-11-02'], undefined)
  assert.equal(first.weekRead['2026-11-09'], undefined)
  assert.equal(first.weekFetched['2026-11-09'], '2026-11-04T12:00:00Z')
  assert.equal(first.weekFetched['2026-10-26'], '2026-11-04T12:00:00Z')
  assert.equal(schedulers.filter((url) => url.includes('min_date=2026-11-09') && url.includes('pageid=22202') && !url.includes('action=')).length, 1)
  assert.equal(schedulers.some((url) => url.includes('min_date=2026-10-26') && url.includes('pageid=22202')), true)
  assert.equal(schedulers.some((url) => url.includes('min_date=2026-08-17')), false)
  assert.equal(schedulers.length, 18)
  assert.equal(schedulerWeekLoaded('<data></data>'), false)
  assert.equal(schedulerWeekLoaded('<data><event id="e"></event></data>'), true)
  urls.length = 0
  const far = { id: 'far', start: '2026-12-07T08:15:00', end: '2026-12-07T09:00:00', text: 'Deutsch', courseName: 'Deutsch', teachers: [], status: '', eventType: 'lesson', room: 'A1' }
  const appointment = { id: 't1', start: '2026-11-04T15:00:00', end: '2026-11-04T16:00:00', text: 'Probe', courseName: 'Probe', teachers: [], status: '', eventType: 'event', room: '' }
  const currentLesson = { id: 'e1', start: '2026-11-04T08:15:00', end: '2026-11-04T09:00:00', text: 'Mathematik', courseName: 'Mathematik', teachers: [], status: '', eventType: 'lesson', room: 'A1' }
  const currentExam = { id: 'x1', start: '2026-11-04T10:00:00', end: '2026-11-04T10:45:00', text: 'Test Chemie', courseName: 'Test Chemie', teachers: [], status: '', eventType: 'exam', room: 'B1' }
  const second = await scrapeWithSession(base, session, fetchImpl, {
    today: '2026-11-04',
    now: '2026-11-04T12:30:00Z',
    previousEvents: [far, appointment, currentLesson],
    previousExams: [currentExam],
    weekFetched: { '2026-11-02': '2026-11-04T12:00:00Z', '2026-12-07': '2026-11-04T12:00:00Z' },
  })
  assert.equal(second.events.some((event) => event.id === 'far'), true)
  assert.equal(second.events.some((event) => event.id === 't1'), true)
  assert.equal(second.events.some((event) => event.id === 'e1'), true)
  assert.equal(second.exams.some((event) => event.id === 'x1'), true)
  assert.equal(second.weekFetched['2026-11-02'], '2026-11-04T12:00:00Z')
  assert.equal(second.weekFetched['2026-11-09'], '2026-11-04T12:30:00Z')
  assert.equal(second.weekFetched['2026-12-07'], '2026-11-04T12:00:00Z')
  const secondSchedulers = urls.filter((url) => url.includes('scheduler_processor'))
  // Nine probe weeks plus a batch of far weeks: the planner follows the stored far lesson (7 Dec) eight weeks on.
  assert.equal(secondSchedulers.length, (9 + WEEK_BATCH) * 2)
  assert.equal(secondSchedulers.some((url) => url.includes('min_date=2026-11-02') && url.includes('pageid=22202')), true)
  assert.equal(secondSchedulers.some((url) => url.includes('min_date=2026-11-09') && url.includes('pageid=22202')), true)
  assert.equal(secondSchedulers.some((url) => url.includes('min_date=2026-12-07')), false)
  const undated = async (url) => {
    const scheduler = String(url).includes('scheduler_processor')
    const body = scheduler ? '<data><event id="e"></event></data>' : '<html><body>ok</body></html>'
    return { status: 200, headers: { get: () => '' }, text: async () => body }
  }
  const keptWeek = await scrapeWithSession(base, session, undated, {
    today: '2026-11-04',
    now: '2026-11-04T13:00:00Z',
    previousEvents: [far, appointment, currentLesson],
    previousExams: [currentExam],
    weekFetched: { '2026-11-02': '2026-11-04T12:00:00Z' },
  })
  assert.equal(keptWeek.events.some((event) => event.id === 'e1'), true)
  assert.equal(keptWeek.events.some((event) => event.id === 'far'), true)
  assert.equal(keptWeek.exams.some((event) => event.id === 'x1'), true)
  assert.equal(keptWeek.weekFetched['2026-11-02'], '2026-11-04T12:00:00Z')
  const lessonXml = '<data><event id="neu"><start_date>2026-11-04 08:15</start_date><end_date>2026-11-04 09:00</end_date><text>Mathematik</text><zimmerkuerzel>A1</zimmerkuerzel><event_type>0_stp</event_type></event></data>'
  const examXml = '<data><event id="phy"><start_date></start_date><vdatum>04.11.2026</vdatum><vzeit>10:15</vzeit><bdatum>04.11.2026</bdatum><bzeit>11:00</bzeit><text>Mathe &amp; Physik</text><fachkuerzel>PHY</fachkuerzel><zimmerkuerzel>B04</zimmerkuerzel><event_type>1_pru</event_type></event><event id="bare"><start_date></start_date><vdatum>05.11.2026</vdatum><vzeit>08:15</vzeit><text>Mathe & Physik</text><event_type>1_pru</event_type></event></data>'
  const parsedExam = Object.fromEntries(parseSchedulerXml(examXml).map((event) => [event.id, event]))
  assert.equal(parsedExam.phy.start, '2026-11-04T10:15:00')
  assert.equal(parsedExam.phy.end, '2026-11-04T11:00:00')
  assert.equal(parsedExam.phy.courseName, 'PHY')
  assert.equal(parsedExam.phy.room, 'B04')
  assert.equal(parsedExam.phy.text, 'Mathe & Physik')
  assert.equal(parsedExam.phy.eventType, 'exam')
  assert.equal(parsedExam.bare.text, 'Mathe & Physik')
  const loaded = async (url) => {
    const target = String(url)
    let body = '<html><body>ok</body></html>'
    // Schulnetz answers each week with that week's rows; other weeks are empty.
    const thisWeek = target.includes('min_date=2026-11-02')
    if (target.includes('scheduler_processor') && target.includes('pageid=22202')) body = thisWeek ? lessonXml : '<data></data>'
    if (target.includes('scheduler_processor') && target.includes('pageid=21312')) body = thisWeek ? examXml : '<data></data>'
    return { status: 200, headers: { get: () => '' }, text: async () => body }
  }
  const read = await scrapeWithSession(base, session, loaded, {
    today: '2026-11-04',
    now: '2026-11-04T13:30:00Z',
    previousEvents: [currentLesson, far],
    previousExams: [],
    weekFetched: {},
  })
  assert.equal(read.events.some((event) => event.id === 'neu'), true)
  assert.equal(read.events.some((event) => event.id === 'e1'), false)
  assert.equal(read.events.some((event) => event.id === 'far'), true)
  assert.equal(read.exams.some((event) => event.id === 'phy'), true)
  assert.equal(read.exams.some((event) => event.text === 'Mathe & Physik'), true)
  const quietRead = diffSnapshots(
    { events: [currentLesson], exams: [], messages: [] },
    { events: read.events, exams: read.exams, messages: [] },
  )
  assert.equal(quietRead.some((change) => change.title === 'Lektion entfernt'), false)
  const links = '<a href="index.php?pageid=22108&amp;sRow=0&amp;ff=1">alle</a><a href="index.php?pageid=22108&amp;sRow=25">25</a><a href="index.php?pageid=22108&amp;sRow=50">50</a><a href="index.php?pageid=22108&amp;sRow=25&amp;sort=datum">sort</a>'
  assert.equal(terminlisteNextUrl(links, base).includes('sRow=25'), true)
  assert.equal(terminlisteNextUrl(links, base, 25).includes('sRow=50'), true)
  assert.equal(terminlisteNextUrl(links, base, 50), '')
  const rotated = '<a href="index.php?pageid=22108&amp;id=abcff123&amp;sRow=25">25</a><a href="index.php?pageid=22108&amp;id=abcff123&amp;sRow=50">50</a>'
  assert.equal(terminlisteNextUrl(rotated, base).includes('sRow=25'), true)
  assert.equal(terminlisteNextUrl(rotated, base, 25).includes('sRow=50'), true)
  assert.equal(terminlisteNextUrl(rotated, base, 50), '')
})

test('an unmarked timetable still loads next week into the schedule', async () => {
  const urls = []
  const page = `<html><body>
    <script>scheduler.config.limit_start = new Date(Date.UTC(2026, 7, 17)); scheduler.config.limit_end = new Date(Date.UTC(2027, 6, 4)); scheduler.init('scheduler_here', new Date(2026, 10, 4), 'week');</script>
    <div data-min-date="17.08.2026" data-max-date="04.07.2027"><div class="dhx_cal_date">02.11.2026 – 08.11.2026</div></div>
    <div class="dhx_cal_event" event_id="nested"><div data-bar-start="1794208500000"></div><div class="stpt_event_text">Mathematik</div><div class="stpt_event_date">08:15 - 09:00 / A1</div></div>
  </body></html>`
  assert.equal(parseWeekSpan(page), null)
  const currentXml = '<data><event id="now"><start_date>2026-11-04 08:15</start_date><end_date>2026-11-04 09:00</end_date><text>Deutsch</text><event_type>0_stp</event_type></event></data>'
  const nextXml = '<data><event id="next"><start_date>2026-11-09 08:15</start_date><end_date>2026-11-09 09:00</end_date><text>Mathematik</text><zimmerkuerzel>A1</zimmerkuerzel><event_type>0_stp</event_type></event></data>'
  const fetchImpl = async (url) => {
    const target = String(url)
    urls.push(target)
    let body = '<html><body>ok</body></html>'
    if (target.includes('pageid=22202') && !target.includes('scheduler_processor')) body = page
    if (target.includes('scheduler_processor') && target.includes('pageid=22202') && target.includes('min_date=2026-11-02')) body = currentXml
    if (target.includes('scheduler_processor') && target.includes('pageid=22202') && target.includes('min_date=2026-11-09')) body = nextXml
    if (target.includes('scheduler_processor') && !body.startsWith('<data><event')) body = '<data></data>'
    return { status: 200, headers: { get: () => '' }, text: async () => body }
  }
  const session = { php: 'php', id: 'abc', transid: 'def', userAgent: 'test' }
  const base = 'https://www.schulnetz-ag.ch/aksa'
  const read = await scrapeWithSession(base, session, fetchImpl, {
    today: '2026-11-04',
    now: '2026-11-04T12:00:00Z',
    previousEvents: [{ id: 'e1', start: '2026-11-04T08:15:00', end: '2026-11-04T09:00:00', text: 'Deutsch', courseName: 'Deutsch', teachers: [], status: '', eventType: 'lesson', room: 'A1' }],
    previousExams: [{ id: 'x1', start: '2026-11-04T10:00:00', end: '2026-11-04T10:45:00', text: 'Test Chemie', courseName: 'Test Chemie', teachers: [], status: '', eventType: 'exam', room: 'B1' }],
    weekFetched: { '2026-11-02': '2026-11-04T11:00:00Z' },
  })
  const schedulers = urls.filter((url) => url.includes('scheduler_processor'))
  assert.equal(schedulers.some((url) => url.includes('pageid=22202') && url.includes('min_date=2026-11-09') && url.includes('max_date=2026-11-16') && !url.includes('action=')), true)
  assert.equal(schedulers.some((url) => url.includes('min_date=2026-08-17') || url.includes('min_date=2027-')), false)
  // Nine probe weeks plus the weeks up to eight past the stored lesson (4 Nov): through 4 Jan.
  assert.equal(schedulers.length, 13 * 2)
  assert.equal(read.events.some((event) => event.id === 'next' && event.start === '2026-11-09T08:15:00'), true)
  assert.equal(read.events.some((event) => event.id === 'now'), true)
  assert.equal(read.events.some((event) => event.id === 'e1'), false)
  assert.equal(read.exams.some((event) => event.id === 'x1'), true)
  assert.equal(read.weekFetched['2026-11-09'], '2026-11-04T12:00:00Z')
  assert.equal(read.weekFetched['2026-11-16'], '2026-11-04T12:00:00Z')
  urls.length = 0
  const again = await scrapeWithSession(base, session, fetchImpl, {
    today: '2026-11-04',
    now: '2026-11-04T12:10:00Z',
    previousEvents: read.events,
    previousExams: read.exams,
    weekFetched: read.weekFetched,
    weekRead: read.weekRead,
  })
  const againSchedulers = urls.filter((url) => url.includes('scheduler_processor'))
  // The current week again, plus only far weeks the walk forward has not read yet.
  const againWeeks = [...new Set(againSchedulers.map((url) => url.match(/min_date=([\d-]+)/u)[1]))]
  assert.equal(againWeeks.includes('2026-11-02'), true)
  assert.equal(againWeeks.filter((week) => week !== '2026-11-02').every((week) => !read.weekFetched[week] && week > '2026-11-30'), true)
  assert.equal(againSchedulers.length, againWeeks.length * 2)
  assert.equal(again.events.some((event) => event.id === 'next'), true)
})

test('exam alerts ignore a stored lesson, empty markup and a missing clock', () => {
  const wrapped = {
    id: 'p', start: '<![CDATA[2026-11-12 10:00]]>', end: '<![CDATA[2026-11-12 10:45]]>',
    text: '<![CDATA[Mathematik]]>', courseName: '<![CDATA[]]>', room: '<![CDATA[]]>', timetableText: '<![CDATA[Mathematik]]>',
    teachers: [], status: '', eventType: 'exam', comment: '',
  }
  const duplicates = diffSnapshots({ events: [], exams: [], messages: [] }, { events: [], exams: [wrapped, { ...wrapped, id: 'p2' }], messages: [] })
    .filter((change) => change.category === 'exam')
  assert.equal(duplicates.length, 1)
  assert.equal(duplicates[0].title, 'Neue Prüfung')
  assert.equal(duplicates[0].body.includes('Mathematik'), true)
  assert.equal(duplicates[0].body.includes('10:00'), true)
  assert.equal(duplicates[0].body.includes('CDATA'), false)
  assert.equal(duplicates[0].body.includes('A[202'), false)
  assert.equal(duplicates[0].body.includes('Raum'), false)
  const dateOnly = { id: 'd', start: '2026-11-12', end: '2026-11-12', text: 'Prüfung', courseName: 'Prüfung', room: '', teachers: [], status: '', eventType: 'exam' }
  const midnight = { id: 'm', start: '2026-11-12T00:00:00', end: '2026-11-12T00:00:00', text: 'Klausur', courseName: 'Klausur', room: '', teachers: [], status: '', eventType: 'exam' }
  const timed = { id: 'r', start: '2026-11-12T08:15:00', end: '2026-11-12T09:00:00', text: 'Test Physik', courseName: 'Test Physik', room: 'A1', teachers: [], status: '', eventType: 'exam' }
  const clocks = diffSnapshots({ events: [], exams: [], messages: [] }, { events: [], exams: [dateOnly, midnight, timed], messages: [] })
    .filter((change) => change.category === 'exam')
  assert.equal(clocks.some((change) => change.body.includes('00:00')), false)
  assert.equal(clocks.find((change) => change.body.includes('Physik')).body.includes('08:15'), true)
  const stored = { id: 'old', start: '2026-11-02T08:15:00', end: '2026-11-02T09:00:00', text: 'Test Chemie', courseName: 'Test Chemie', timetableText: 'Test Chemie', room: 'A1', teachers: [], status: '', eventType: 'lesson' }
  const exam = { ...stored, id: 'new', eventType: 'exam' }
  const quiet = diffSnapshots({ events: [stored], exams: [], messages: [] }, { events: [], exams: [exam], messages: [] })
  assert.equal(quiet.some((change) => change.title === 'Neue Prüfung' || change.title === 'Lektion entfernt' || change.title === 'Neuer Termin'), false)
  const block = { ...stored, eventType: '0_stp' }
  const stillQuiet = diffSnapshots({ events: [block], exams: [], messages: [] }, { events: [], exams: [exam], messages: [] })
  assert.equal(stillQuiet.some((change) => change.title === 'Neue Prüfung' || change.title === 'Lektion entfernt'), false)
  const later = { ...exam, id: stored.id, start: '2026-11-02T10:15:00', end: '2026-11-02T11:00:00' }
  assert.deepEqual(diffSnapshots({ events: [stored], exams: [], messages: [] }, { events: [], exams: [later], messages: [] }).map((change) => change.title), ['Prüfung verschoben'])
  const other = { ...stored, id: 'bio', text: 'Test Biologie', courseName: 'Test Biologie', timetableText: 'Test Biologie', eventType: 'exam' }
  const added = diffSnapshots({ events: [stored], exams: [], messages: [] }, { events: [stored], exams: [other], messages: [] })
  assert.equal(added.some((change) => change.title === 'Neue Prüfung'), true)
  const dropped = diffSnapshots(
    { events: [], exams: [timed], messages: [], weekFetched: { '2026-11-09': '2026-11-04T12:00:00Z' } },
    { events: [], exams: [], messages: [], weekFetched: { '2026-11-09': '2026-11-04T12:00:00Z' } },
  )
  assert.equal(dropped.some((change) => change.category === 'exam'), false)
  const termin = { id: 'term-2', start: '2026-11-04T15:00:00', end: '2026-11-04T16:00:00', text: 'Elternabend', courseName: 'Elternabend', timetableText: 'Elternabend', room: '', teachers: [], status: '', eventType: 'event' }
  const earlier = { ...termin, id: 'term-1' }
  const repeat = diffSnapshots({ events: [earlier], exams: [], messages: [] }, { events: [earlier, termin], exams: [], messages: [] })
  assert.equal(repeat.some((change) => change.title === 'Neuer Termin'), false)
  const fresh = { ...termin, id: 'term-3', text: 'Konzert', courseName: 'Konzert', timetableText: 'Konzert' }
  assert.equal(diffSnapshots({ events: [earlier], exams: [], messages: [] }, { events: [earlier, fresh], exams: [], messages: [] }).some((change) => change.title === 'Neuer Termin'), true)
  const sameNote = diffSnapshots(
    { events: [], exams: [], messages: [{ id: 'a', title: 'Termin', body: 'Elternabend' }] },
    { events: [], exams: [], messages: [{ id: 'b', title: 'Termin', body: 'Elternabend' }] },
  )
  assert.equal(sameNote.some((change) => change.category === 'event'), false)
  assert.equal(isLesson({ eventType: 'lesson', text: 'Lesetest', timetableText: 'Lesetest' }), true)
  assert.equal(isExamLike({ eventType: '0_stp', text: 'Deutsch', timetableText: 'Deutsch' }), false)
  assert.equal(isLesson({ eventType: '0_stp', text: 'Deutsch', timetableText: 'Deutsch' }), true)
})

test('seal round trip uses aes-256-gcm', () => {
  const key = randomBytes(32)
  const sealed = sealToken(key, 'token-value-which-is-long-enough')
  assert.equal(openToken(key, sealed), 'token-value-which-is-long-enough')
  sealed.data = createCipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64')).update('x').toString('base64')
  assert.throws(() => openToken(key, sealed))
})


test('synthetic nested tables keep three courses and eighteen individual marks separate', async () => {
  const html = await readFile(new URL('../android/core/src/test/resources/schulnetz/noten-multi-course.html', import.meta.url), 'utf8')
  const grades = parseGradesHtml(html)
  assert.equal(grades.length, 18)
  assert.deepEqual([...new Set(grades.map((grade) => grade.courseId))], ['Alpha-K26A-1', 'Beta-K26A-1', 'Gamma-K26A-1'])
  for (const [index, subject] of ['Alpha', 'Beta', 'Gamma'].entries()) {
    const group = grades.filter((grade) => grade.courseId === `${subject}-K26A-1`)
    assert.equal(group.length, 6)
    assert.equal(group.every((grade) => grade.title.startsWith(`Exercise ${index + 1}-`) && grade.mark === 3 + (index + 1) / 2), true)
  }
  const partial = grades.slice(0, 7).map((grade) => ({ ...grade, course: 'Fach Kurs', courseId: 'Fach Kurs', subject: 'Fach Kurs' }))
  assert.deepEqual(keepLoadedGrades(grades, partial), grades)
  assert.deepEqual(keepLoadedGrades(grades, grades.slice(0, 7), false), grades)
  const blocked = await readFile(new URL('../android/core/src/test/resources/schulnetz/blocked-start-grades.html', import.meta.url), 'utf8')
  assert.deepEqual(parseGradesHtml(blocked), [])
})


test('snapshot uploads with blocked or partial grades preserve the previous complete grade book', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-partial-'))
  const runtime = createSchulnetzRuntime({ root, key: randomBytes(32), autostart: false })
  try {
    const guest = await runtime.createGuest('203.0.113.33')
    await runtime.linkAccount(guest.accountId, { baseUrl: 'https://www.schulnetz-ag.ch/aksa', deviceId: '0123456789abcdef01234567', refreshToken: 'synthetic-refresh-token-long-enough' })
    const html = await readFile(new URL('../android/core/src/test/resources/schulnetz/noten-multi-course.html', import.meta.url), 'utf8')
    const grades = parseGradesHtml(html)
    const send = (body) => guestCall(runtime, guest, 'PUT', '/api/v1/schulnetz/snapshot', JSON.stringify(body))
    assert.equal((await send({ grades })).status, 200)
    for (const partial of [
      { grades: grades.slice(0, 7), gradesReadComplete: false },
      { grades: grades.slice(0, 7), readErrors: ['Inaktivitätslimit überschritten'] },
      { grades: grades.slice(0, 7), readErrors: ['Schulnetz hat die IP-Adresse abgelehnt'] },
      { grades: grades.slice(0, 7), readErrors: ['Bei Schulnetz neu anmelden'] },
      { grades: grades.slice(0, 7).map((grade) => ({ ...grade, course: 'Fach Kurs', courseId: 'Fach Kurs', subject: 'Fach Kurs' })) },
    ]) {
      assert.equal((await send(partial)).status, 200)
      const stored = JSON.parse(await readFile(join(root, 'accounts', guest.accountId, 'snapshot.json'), 'utf8'))
      assert.deepEqual(stored.grades, grades)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('a nonempty parse with an unowned exam is incomplete, not a replacement grade book', async () => {
  const html = await readFile(new URL('../android/core/src/test/resources/schulnetz/noten-multi-course.html', import.meta.url), 'utf8')
  const partial = html.replace('</main>', '<table><tr><td>07.11.2026</td><td>Unowned exercise</td><td>4.5</td><td>1</td></tr></table></main>')
  assert.deepEqual(parseGradesHtml(partial), [])
  const previous = parseGradesHtml(html)
  assert.deepEqual(keepLoadedGrades(previous, parseGradesHtml(partial)), previous)
})


// Synthetic events only. No screenshot text, real course codes, or account data.
const baselineWeek = '2026-11-23'
const syntheticExam = (id = 'synthetic-101@calendar.example.org', day = baselineWeek) => ({
  id, start: `${day}T10:15:00`, end: `${day}T11:00:00`, text: 'Synthetic quiz', timetableText: 'Synthetic quiz',
  courseName: 'Synthetic course', courseId: 'synthetic', room: 'R1', teachers: [], status: '', eventType: 'exam', comment: '',
})
const agendaRead = (exams, hour, weeks = [baselineWeek], events = []) => ({
  fetchedAt: `2026-11-06T${hour}:00:00Z`, exams, events,
  weekFetched: Object.fromEntries(weeks.map((week) => [week, `2026-11-06T${hour}:00:00Z`])),
  examWeekFetched: Object.fromEntries(weeks.map((week) => [week, `2026-11-06T${hour}:00:00Z`])),
})
const baselineDiff = (previous, next, stored) => {
  const read = prepareAgendaRead(stored, next)
  const persisted = JSON.parse(JSON.stringify(read.weeks))
  const before = previous ? { ...previous, exams: read.before.exams,
    events: read.before.events.filter((event) => event.eventType === 'lesson').concat((previous.events || []).filter((event) => event.eventType === 'event')) } : null
  return { changes: diffSnapshots(before, next), weeks: persisted }
}

test('future exam baseline persists quietly; overlapping UID formats stay quiet; one later real move alerts', () => {
  const ordinary = { ...syntheticExam('old-lesson'), eventType: 'lesson', text: 'Synthetic course', timetableText: 'Synthetic course', start: `${baselineWeek}T08:00:00`, room: 'R2' }
  const previous = { ...agendaRead([], '09', [baselineWeek], [ordinary]), examWeekFetched: {} }
  const first = agendaRead([syntheticExam()], '10', [baselineWeek], [ordinary])
  const initial = baselineDiff(previous, first, {})
  assert.deepEqual(initial.changes, [])
  assert.equal(initial.weeks[baselineWeek].exams.length, 1)
  const alias = syntheticExam('synthetic-101')
  const repeated = agendaRead([alias, syntheticExam()], '11', [baselineWeek, '2026-11-30'], [ordinary])
  const stable = baselineDiff(first, repeated, initial.weeks)
  assert.deepEqual(stable.changes, [])
  const moved = { ...alias, start: `${baselineWeek}T12:00:00`, end: `${baselineWeek}T12:45:00` }
  const latest = agendaRead([moved], '12', [baselineWeek, '2026-11-30'], [ordinary])
  const actual = baselineDiff(repeated, latest, stable.weeks)
  assert.deepEqual(actual.changes.map((change) => change.title), ['Prüfung verschoben'])
  assert.equal(actual.changes[0].body.startsWith('23.11.2026 · '), true)
  assert.deepEqual(baselineDiff(latest, latest, actual.weeks).changes, [])
  assert.deepEqual(baselineDiff(latest, agendaRead([moved], '13', [baselineWeek, '2026-11-30'], [ordinary]), actual.weeks).changes, [])
})

test('stale, empty, partial, and missing-field reads keep the last complete exam baseline', () => {
  const first = agendaRead([syntheticExam()], '11')
  const stored = baselineDiff({}, first, {}).weeks
  const moved = { ...syntheticExam(), start: `${baselineWeek}T12:00:00`, end: `${baselineWeek}T12:45:00` }
  for (const next of [agendaRead([moved], '10'), agendaRead([], '12'),
    agendaRead([{ ...syntheticExam(), start: baselineWeek, end: '' }], '12'),
    { ...agendaRead([moved], '12'), readErrors: ['Laden fehlgeschlagen'] },
    { ...agendaRead([moved], '12'), examWeekFetched: {} }]) {
    const read = baselineDiff(first, next, stored)
    assert.deepEqual(read.changes, [])
    assert.deepEqual(read.weeks[baselineWeek].exams, stored[baselineWeek].exams)
    assert.equal(read.weeks[baselineWeek].examWeekFetched[baselineWeek], '2026-11-06T11:00:00Z')
  }
  assert.equal(baselineDiff(first, agendaRead([moved], '12'), stored).changes[0].title, 'Prüfung verschoben')
  assert.equal(baselineDiff(first, { ...agendaRead([moved], '12'), readErrors: ['Noten: Seite geladen, aber nicht lesbar'] }, stored).changes[0].title, 'Prüfung verschoben')
})

test('new exams in an established empty week still alert and room-only changes are not moves', () => {
  const first = agendaRead([], '10')
  const stored = baselineDiff({}, first, {}).weeks
  const next = agendaRead([syntheticExam()], '11')
  const added = baselineDiff(first, next, stored)
  assert.deepEqual(added.changes.map((change) => change.title), ['Neue Prüfung'])
  assert.deepEqual(baselineDiff(next, agendaRead([{ ...syntheticExam(), room: 'R3' }], '12'), added.weeks).changes.map((change) => change.title), ['Raum geändert'])
  assert.deepEqual(baselineDiff(next, agendaRead([{ ...syntheticExam(), end: `${baselineWeek}T11:30:00` }], '12'), added.weeks).changes.map((change) => change.title), ['Prüfung verschoben'])
})

test('moved exams and cancelled lessons show each own German event date, including Zurich midnight', () => {
  const first = agendaRead([syntheticExam(), syntheticExam('synthetic-102', '2026-11-24')], '10')
  const stored = baselineDiff({}, first, {}).weeks
  const moved = first.exams.map((event) => ({ ...event, start: event.start.replace('10:15', '12:00'), end: event.end.replace('11:00', '12:45') }))
  const notices = baselineDiff(first, agendaRead(moved, '11'), stored).changes
  assert.deepEqual(new Set(notices.map((change) => change.body.split(' · ')[0])), new Set(['23.11.2026', '24.11.2026']))
  const lessons = first.exams.map((event) => ({ ...event, text: 'Synthetic lesson', timetableText: 'Synthetic lesson', eventType: 'lesson' }))
  const cancelled = diffSnapshots({ events: lessons }, { events: lessons.map((event) => ({ ...event, status: 'cancelled' })) })
  assert.equal(cancelled.every((change) => change.title === 'Lektion fällt aus'), true)
  assert.deepEqual(new Set(cancelled.map((change) => change.body.split(' · ')[0])), new Set(['23.11.2026', '24.11.2026']))
  const night = { ...lessons[0], start: '2026-11-08T23:30:00Z', end: '2026-11-09T00:15:00Z' }
  assert.equal(diffSnapshots({ events: [night] }, { events: [{ ...night, status: 'cancelled' }] })[0].body.startsWith('09.11.2026 · '), true)
})

test('snapshot upload stores week baselines before push and emits one actual later move', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-exam-baseline-'))
  let account, pushes = 0
  const runtime = createSchulnetzRuntime({ root, key: randomBytes(32), autostart: false,
    fcmSend: async () => {
      const baseline = JSON.parse(await readFile(join(root, 'accounts', account, 'notification-baseline.json'), 'utf8'))
      assert.equal(baseline.weeks[baselineWeek].exams[0].start, `${baselineWeek}T12:00:00`)
      pushes += 1
      return { status: 200 }
    },
  })
  try {
    const guest = await runtime.createGuest('203.0.113.34'); account = guest.accountId
    await runtime.linkAccount(account, { baseUrl: 'https://www.schulnetz-ag.ch/aksa', deviceId: '0123456789abcdef01234567', refreshToken: 'synthetic-refresh-token-long-enough' })
    await runtime.addFcmToken(account, 'phone:APA91b-example-token-value')
    const send = (body) => guestCall(runtime, guest, 'PUT', '/api/v1/schulnetz/snapshot', JSON.stringify(body))
    const first = agendaRead([syntheticExam()], '10')
    assert.equal((await send(first)).body.changes, 0)
    assert.equal((await stat(join(root, 'accounts', account, 'notification-baseline.json'))).mode & 0o777, 0o600)
    const next = agendaRead([syntheticExam('synthetic-101')], '11')
    assert.equal((await send(next)).body.changes, 0)
    const moved = agendaRead([{ ...syntheticExam('synthetic-101'), start: `${baselineWeek}T12:00:00`, end: `${baselineWeek}T12:45:00` }], '12')
    assert.equal((await send(moved)).body.changes, 1)
    assert.equal(pushes, 1)
    assert.equal((await send(moved)).body.changes, 0)
    assert.equal(pushes, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('a known exam really moving into a new week alerts once while equivalent time formats stay quiet', () => {
  const first = agendaRead([syntheticExam()], '10')
  const baseline = baselineDiff({}, first, {}).weeks
  const formatted = { ...syntheticExam('synthetic-101'), start: '2026-11-23T09:15:00Z', end: '2026-11-23T10:00:00Z' }
  assert.deepEqual(baselineDiff(first, agendaRead([formatted], '11'), baseline).changes, [])
  const later = syntheticExam('synthetic-101', '2026-11-30')
  const next = agendaRead([later], '11', [baselineWeek, '2026-11-30'])
  const moved = baselineDiff(first, next, baseline)
  assert.deepEqual(moved.changes.map((change) => change.title), ['Prüfung verschoben'])
  assert.equal(moved.changes[0].body.startsWith('30.11.2026 · '), true)
  assert.deepEqual(moved.weeks[baselineWeek].exams, [])
  assert.deepEqual(baselineDiff(next, agendaRead([later], '12', [baselineWeek, '2026-11-30']), moved.weeks).changes, [])
})

test('delivery probe rows stay marked, dated, and out of the grade ledger', () => {
  assert.equal(formatProbeDay('2026-11-07'), '07.11.2026')
  assert.equal(formatProbeDay('2026-11-07T00:00:00'), '')
  const probes = notificationProbeChanges({ serverAt: '2026-11-07T12:00:00.000Z', day: '2026-11-07' })
  assert.equal(probes.length, 6)
  assert.deepEqual(probes.map((change) => change.category), ['grade', 'grade', 'exam', 'exam', 'timetable', 'event'])
  assert.equal(probes.every((change) => change.title.startsWith('Test: ') && change.body.includes('Datum 07.11.2026')), true)
  assert.equal(probes.every((change) => change.serverAt === '2026-11-07T12:00:00.000Z' && change.date === '2026-11-07'), true)
  assert.equal(JSON.stringify(probes).includes('5.5'), false)
  assert.equal(JSON.stringify(probes).includes('Neue Note in'), false)
  const real = { id: 'grade:real', category: 'grade', gradeKeys: ['c:real'], targetId: 'real-target' }
  const seeded = settleGradeNotifications([...probes, real], [], null)
  assert.deepEqual(seeded.changes.map((change) => change.id), probes.map((change) => change.id))
  assert.equal(seeded.keys.some((key) => String(key).startsWith('probe:')), false)
  const kept = settleGradeNotifications([probes[0]], [], ['c:kept'])
  assert.equal(kept.changes.length, 1)
  assert.equal(kept.keys.includes('c:kept'), true)
  assert.equal(kept.keys.some((key) => String(key).startsWith('probe:')), false)
  assert.equal(groupGradeChanges([probes[0], probes[1]]).length, 2)
  const grouped = groupGradeChanges([
    { id: 'grade:a', category: 'grade', title: 'Neue Note', body: 'A', targetIds: ['a'], gradeKeys: ['c:a'], courseId: 'math' },
    { id: 'grade:b', category: 'grade', title: 'Neue Note', body: 'B', targetIds: ['b'], gradeKeys: ['c:b'], courseId: 'eng' },
    probes[0],
    probes[1],
  ])
  assert.equal(grouped.length, 3)
  assert.equal(grouped[0].title, '2 neue Noten')
  assert.equal(isNotificationProbe(grouped[1].id) && isNotificationProbe(grouped[2].id), true)
  assert.equal(grouped[0].gradeKeys.includes(probes[0].gradeKeys[0]), false)
})

const probeCall = async (runtime, guest, body, headers = {}, path = '/api/v1/schulnetz/push/probe') => {
  const request = {
    method: 'POST',
    headers: guest
      ? { 'x-kanti-guest': guest.accountId, authorization: `Bearer ${guest.token}`, ...headers }
      : headers,
    socket: { remoteAddress: '203.0.113.77' },
    async *[Symbol.asyncIterator]() {
      if (body != null) yield Buffer.from(body)
    },
  }
  let status = 0
  let payload = ''
  const response = {
    writeHead(code) { status = code },
    end(text) { payload = String(text || '') },
  }
  await runtime.handle(request, response, new URL(`http://127.0.0.1${path}`))
  return { status, body: payload ? JSON.parse(payload) : {} }
}

test('delivery probe reaches only the registered device and leaves school records alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-probe-'))
  const key = randomBytes(32)
  const sent = []
  let fetches = 0
  const serverAt = '2026-11-07T12:00:00.000Z'
  const runtime = createSchulnetzRuntime({
    root,
    key,
    autostart: false,
    now: () => new Date(serverAt),
    fetch: async () => { fetches += 1; throw new Error('probe must not call Schulnetz') },
    fcmSend: async (message) => { sent.push(message); return { status: 200 } },
  })
  const mine = 'phone:APA91b-probe-device-token'
  const otherToken = 'phone:APA91b-other-device-tokenx'
  try {
    assert.equal(isValidFcmToken(mine), true)
    assert.equal(isValidFcmToken(otherToken), true)
    const caller = await runtime.createGuest('203.0.113.77')
    const other = await runtime.createGuest('203.0.113.78')
    const stranger = await runtime.createGuest('203.0.113.79')
    const linkBody = {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    }
    await runtime.linkAccount(caller.accountId, linkBody)
    await runtime.linkAccount(other.accountId, linkBody)
    await runtime.linkAccount(stranger.accountId, linkBody)
    await runtime.addFcmToken(caller.accountId, mine)
    await runtime.addFcmToken(other.accountId, otherToken)
    await runtime.addFcmToken(stranger.accountId, 'phone:APA91b-stranger-device-token')
    const dir = join(root, 'accounts', caller.accountId)
    const snapshot = '{"grades":[{"id":"keep","mark":"5.5"}],"events":[]}\n'
    const ledger = '{"version":1,"keys":["c:kept"]}\n'
    const baseline = '{"version":1,"weeks":{}}\n'
    await writeFile(join(dir, 'snapshot.json'), snapshot)
    await writeFile(join(dir, 'notified-grades.json'), ledger)
    await writeFile(join(dir, 'notification-baseline.json'), baseline)
    const settings = await guestCall(runtime, caller, 'PUT', '/api/v1/schulnetz/settings', '{"guessGrades":true}')
    assert.equal(settings.status, 200)
    const anonymous = await probeCall(runtime, null, `{"token":${JSON.stringify(mine)}}`)
    assert.equal(anonymous.status, 401)
    assert.equal(fetches, 0)
    const missing = await probeCall(runtime, stranger, `{"token":${JSON.stringify(otherToken)}}`)
    assert.equal(missing.status, 400)
    assert.equal(missing.body.error, 'Dieses Gerät ist für Push nicht registriert.')
    assert.equal(sent.length, 0)
    const ok = await probeCall(runtime, caller, `{"token":${JSON.stringify(mine)}}`)
    assert.equal(ok.status, 200)
    assert.equal(ok.body.ok, true)
    assert.equal(ok.body.serverAt, serverAt)
    assert.equal(ok.body.count, 6)
    assert.equal(ok.body.scenario, 'standard')
    assert.equal(ok.body.correlation, 'probe:20261107120000000')
    assert.equal(JSON.stringify(ok.body).includes(mine), false)
    assert.equal(JSON.stringify(ok.body).includes('5.5'), false)
    assert.equal(JSON.stringify(ok.body).includes('Neue Note'), false)
    assert.equal(sent.length, 1)
    const message = sent[0]
    assert.equal(message.message.token, mine)
    assert.equal(message.message.data.event, 'sync')
    assert.equal(message.message.data.probe, '1')
    assert.equal(message.message.data.serverAt, serverAt)
    assert.equal(message.message.data.correlation, 'probe:20261107120000000')
    assert.match(message.message.android.collapse_key, /^kanti-probe-[a-f0-9]{16}$/u)
    assert.equal(message.message.data.route, message.message.android.collapse_key.slice('kanti-probe-'.length))
    assert.equal(message.message.android.priority, 'HIGH')
    assert.equal(message.message.android.ttl, '21600s')
    assert.equal(message.message.notification, undefined)
    const data = JSON.stringify(message.message.data)
    assert.equal(data.includes('5.5'), false)
    assert.equal(data.includes('Neue Note'), false)
    assert.equal(data.includes('Testfach'), false)
    assert.equal(data.includes(mine), false)
    const lines = (await readFile(join(dir, 'changes.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.length, 6)
    assert.equal(lines.every((row) => row.revision === 1 && String(row.id).startsWith('probe:')), true)
    assert.equal(lines.every((row) => String(row.title).startsWith('Test: ') && String(row.body).includes('Datum 07.11.2026') && row.correlation === 'probe:20261107120000000' && String(row.body).includes(`Folge ${row.sequence}`)), true)
    assert.deepEqual(lines.map((row) => row.category), ['grade', 'grade', 'exam', 'exam', 'timetable', 'event'])
    assert.equal(JSON.stringify(lines).includes('5.5'), false)
    const link = JSON.parse(await readFile(join(dir, 'link.json'), 'utf8'))
    assert.equal(link.revision, 1)
    assert.deepEqual(link.fcmTokens, [mine])
    const otherLink = JSON.parse(await readFile(join(root, 'accounts', other.accountId, 'link.json'), 'utf8'))
    assert.deepEqual(otherLink.fcmTokens, [otherToken])
    assert.equal(await readFile(join(dir, 'snapshot.json'), 'utf8'), snapshot)
    assert.equal(await readFile(join(dir, 'notified-grades.json'), 'utf8'), ledger)
    assert.equal(await readFile(join(dir, 'notification-baseline.json'), 'utf8'), baseline)
    assert.equal(fetches, 0)
    const listed = await guestCall(runtime, caller, 'GET', `/api/v1/schulnetz/changes?since=0&device=${probeDeviceKey(mine)}`, null)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.changes.length, 6)
    assert.equal(listed.body.changes.every((row) => row.serverAt === serverAt && row.device === probeDeviceKey(mine)), true)
    const accountWide = await guestCall(runtime, caller, 'GET', '/api/v1/schulnetz/changes?since=0', null)
    assert.equal(accountWide.body.changes.length, 0)
    const otherDevice = await guestCall(runtime, caller, 'GET', `/api/v1/schulnetz/changes?since=0&device=${probeDeviceKey(otherToken)}`, null)
    assert.equal(otherDevice.body.changes.length, 0)
    for (let index = 0; index < 4; index += 1) {
      const again = await probeCall(runtime, caller, `{"token":${JSON.stringify(mine)}}`)
      assert.equal(again.status, 200)
    }
    const blocked = await probeCall(runtime, caller, `{"token":${JSON.stringify(mine)}}`)
    assert.equal(blocked.status, 429)
    assert.equal(blocked.body.error, 'Zu viele Anfragen. Bitte später erneut versuchen.')
    const after = JSON.parse(await readFile(join(dir, 'link.json'), 'utf8'))
    assert.equal(after.revision, 5)
    assert.equal((await readFile(join(dir, 'changes.jsonl'), 'utf8')).trim().split('\n').length, 30)
    assert.equal(sent.length, 5)
    assert.equal(sent.every((item) => item.message.token === mine), true)
    assert.equal(await readFile(join(dir, 'snapshot.json'), 'utf8'), snapshot)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a delivery probe rolls back when Firebase does not accept it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-probe-rollback-'))
  const key = randomBytes(32)
  let fetches = 0
  const skipped = createSchulnetzRuntime({
    root,
    key,
    autostart: false,
    now: () => new Date('2026-11-07T12:00:00.000Z'),
    fcmAccountFile: join(root, 'missing-fcm.json'),
    fetch: async () => { fetches += 1; throw new Error('probe must not call Schulnetz') },
  })
  const token = 'phone:APA91b-probe-device-token'
  try {
    const guest = await skipped.createGuest('203.0.113.80')
    await skipped.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    await skipped.addFcmToken(guest.accountId, token)
    const missing = await probeCall(skipped, guest, `{"token":${JSON.stringify(token)}}`)
    assert.equal(missing.status, 503)
    assert.equal(missing.body.error, 'Firebase ist auf dem Server nicht eingerichtet.')
    await assert.rejects(stat(join(root, 'accounts', guest.accountId, 'changes.jsonl')))
    const quiet = JSON.parse(await readFile(join(root, 'accounts', guest.accountId, 'link.json'), 'utf8'))
    assert.equal(quiet.revision, 0)
    assert.deepEqual(quiet.fcmTokens, [token])
    assert.equal(fetches, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  const droppedRoot = await mkdtemp(join(tmpdir(), 'schulnetz-probe-drop-'))
  const dropped = createSchulnetzRuntime({
    root: droppedRoot,
    key: randomBytes(32),
    autostart: false,
    now: () => new Date('2026-11-07T12:00:00.000Z'),
    fetch: async () => { throw new Error('probe must not call Schulnetz') },
    fcmSend: async () => ({ status: 404, drop: true }),
  })
  try {
    const guest = await dropped.createGuest('203.0.113.81')
    await dropped.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    await dropped.addFcmToken(guest.accountId, token)
    const gone = await probeCall(dropped, guest, `{"token":${JSON.stringify(token)}}`)
    assert.equal(gone.status, 409)
    assert.equal(gone.body.error, 'Dieses Gerät ist bei Firebase nicht mehr registriert.')
    await assert.rejects(stat(join(droppedRoot, 'accounts', guest.accountId, 'changes.jsonl')))
    const link = JSON.parse(await readFile(join(droppedRoot, 'accounts', guest.accountId, 'link.json'), 'utf8'))
    assert.equal(link.revision, 0)
    assert.deepEqual(link.fcmTokens, [])
  } finally {
    await rm(droppedRoot, { recursive: true, force: true })
  }
})

test('probe batches reject unknown scenarios and keep one clock on every row', () => {
  const serverAt = '2026-11-07T12:00:00.000Z'
  const day = '2026-11-07'
  assert.equal(notificationProbeBatch({ serverAt, day, scenario: 'held' }), null)
  assert.equal(notificationProbeBatch({ serverAt, day, scenario: 'delay' }), null)
  const standard = notificationProbeBatch({ serverAt, day, scenario: 'standard' })
  const duplicate = notificationProbeBatch({ serverAt, day, scenario: 'duplicate' })
  const reorder = notificationProbeBatch({ serverAt, day, scenario: 'reorder' })
  assert.equal(standard.length, 6)
  assert.equal(duplicate.length, 7)
  assert.equal(duplicate[0].id, duplicate[6].id)
  assert.equal(duplicate[0].serverAt, serverAt)
  assert.equal(duplicate.every((row) => row.serverAt === serverAt && row.correlation === 'probe:20261107120000000'), true)
  assert.deepEqual(reorder.map((row) => row.id), [...standard.map((row) => row.id)].reverse())
  assert.deepEqual(reorder.map((row) => row.sequence), [6, 5, 4, 3, 2, 1])
  assert.equal(reorder.every((row) => row.serverAt === serverAt), true)
  assert.equal(standard[0].body.split(' · ')[0], 'Test')
  assert.equal(standard[0].body.split(' · ')[1], 'Testfach')
  assert.equal(standard[0].body.includes('Datum 07.11.2026 · Folge 1'), true)
  assert.equal(JSON.stringify(duplicate).includes('5.5'), false)
  assert.equal(JSON.stringify(duplicate).includes('Neue Note in'), false)
  const ordinary = linkedChange('grade:1', 'grade', 'Neue Note', 'Fach', {})
  assert.equal(Object.hasOwn(ordinary, 'correlation'), false)
  assert.equal(Object.hasOwn(ordinary, 'sequence'), false)
  const copied = linkedChange('probe:1:grade-new', 'grade', 'Test: Neue Note', 'Test · Testfach', { correlation: 'probe:1', sequence: 2, serverAt })
  assert.equal(copied.correlation, 'probe:1')
  assert.equal(copied.sequence, 2)
})

test('diagnostic probe scenarios stay on this device and clear only probe rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-probe-diagnostic-'))
  const key = randomBytes(32)
  const sent = []
  let fetches = 0
  const serverAt = '2026-11-07T12:00:00.000Z'
  const runtime = createSchulnetzRuntime({
    root,
    key,
    autostart: false,
    now: () => new Date(serverAt),
    fetch: async () => { fetches += 1; throw new Error('probe must not call Schulnetz') },
    fcmSend: async (message) => { sent.push(message); return { status: 200 } },
  })
  const mine = 'phone:APA91b-probe-device-token'
  const otherToken = 'phone:APA91b-other-device-tokenx'
  const clearPath = '/api/v1/schulnetz/push/probe/clear'
  try {
    const caller = await runtime.createGuest('203.0.113.90')
    await runtime.linkAccount(caller.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'synthetic-refresh-token-long-enough',
    })
    await runtime.addFcmToken(caller.accountId, mine)
    const dir = join(root, 'accounts', caller.accountId)
    const snapshot = '{"grades":[{"id":"keep","mark":"5.5"}],"events":[]}\n'
    const ledger = '{"version":1,"keys":["c:kept"]}\n'
    const baseline = '{"version":1,"weeks":{}}\n'
    await writeFile(join(dir, 'snapshot.json'), snapshot)
    await writeFile(join(dir, 'notified-grades.json'), ledger)
    await writeFile(join(dir, 'notification-baseline.json'), baseline)
    const anonymous = await probeCall(runtime, null, `{"token":${JSON.stringify(mine)},"scenario":"duplicate"}`, {}, clearPath)
    assert.equal(anonymous.status, 401)
    const unknown = await probeCall(runtime, caller, `{"token":${JSON.stringify(mine)},"scenario":"delay"}`)
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body.error, 'Dieses Testszenario gibt es nicht.')
    assert.equal(sent.length, 0)
    assert.equal(fetches, 0)
    await assert.rejects(stat(join(dir, 'changes.jsonl')))
    const duplicate = await probeCall(runtime, caller, `{"token":${JSON.stringify(mine)},"scenario":"duplicate"}`)
    assert.equal(duplicate.status, 200)
    assert.equal(duplicate.body.count, 7)
    assert.equal(duplicate.body.scenario, 'duplicate')
    assert.equal(duplicate.body.correlation, 'probe:20261107120000000')
    assert.equal(JSON.stringify(duplicate.body).includes(mine), false)
    assert.equal(JSON.stringify(duplicate.body).includes('5.5'), false)
    assert.equal(JSON.stringify(sent[0].message.data).includes('Testfach'), false)
    assert.equal(sent[0].message.data.correlation, 'probe:20261107120000000')
    assert.equal(sent[0].message.token, mine)
    const duplicateLines = (await readFile(join(dir, 'changes.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(duplicateLines.length, 7)
    assert.equal(duplicateLines[0].id, duplicateLines[6].id)
    assert.equal(duplicateLines.every((row) => row.serverAt === serverAt), true)
    assert.equal(duplicateLines.every((row) => row.device === probeDeviceKey(mine)), true)
    assert.equal(JSON.stringify(duplicateLines).includes(mine), false)
    assert.equal(duplicate.body.probeRemaining, 3)
    assert.equal(duplicate.body.clearRemaining, 5)
    assert.equal(changeVisibleToDevice({ id: 'probe:legacy' }, probeDeviceKey(mine)), false)
    assert.equal(changeVisibleToDevice({ id: 'probe:legacy', device: '' }, probeDeviceKey(mine)), false)
    assert.equal(changeVisibleToDevice({ id: 'grade:real' }, ''), true)
    const listed = await guestCall(runtime, caller, 'GET', `/api/v1/schulnetz/changes?since=0&device=${probeDeviceKey(mine)}`, null)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.changes.length, 7)
    const hiddenFromOther = await guestCall(runtime, caller, 'GET', `/api/v1/schulnetz/changes?since=0&device=${probeDeviceKey(otherToken)}`, null)
    assert.equal(hiddenFromOther.status, 200)
    assert.equal(hiddenFromOther.body.changes.length, 0)
    const unmarked = await guestCall(runtime, caller, 'GET', '/api/v1/schulnetz/changes?since=0', null)
    assert.equal(unmarked.body.changes.length, 0)
    const reorder = await probeCall(runtime, caller, `{"token":${JSON.stringify(mine)},"scenario":"reorder"}`)
    assert.equal(reorder.status, 200)
    assert.equal(reorder.body.count, 6)
    const standardIds = notificationProbeBatch({ serverAt, day: '2026-11-07', scenario: 'standard' }).map((row) => row.id)
    const all = (await readFile(join(dir, 'changes.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const reorderLines = all.filter((row) => row.revision === 2)
    assert.deepEqual(reorderLines.map((row) => row.id), [...standardIds].reverse())
    assert.deepEqual(reorderLines.map((row) => row.sequence), [6, 5, 4, 3, 2, 1])
    assert.equal(reorderLines.every((row) => row.serverAt === serverAt), true)
    assert.equal((await probeCall(runtime, caller, `{"token":${JSON.stringify(mine)}}`)).status, 200)
    assert.equal((await probeCall(runtime, caller, `{"token":${JSON.stringify(mine)}}`)).status, 200)
    const blocked = await probeCall(runtime, caller, `{"token":${JSON.stringify(mine)}}`)
    assert.equal(blocked.status, 429)
    const linkBefore = JSON.parse(await readFile(join(dir, 'link.json'), 'utf8'))
    assert.equal(linkBefore.revision, 4)
    const keeper = '{"id":"grade:keep","category":"grade","revision":9}\n'
    await writeFile(join(dir, 'changes.jsonl'), `${await readFile(join(dir, 'changes.jsonl'), 'utf8')}not-json\n${keeper}`)
    const foreign = await probeCall(runtime, caller, `{"token":${JSON.stringify(otherToken)}}`, {}, clearPath)
    assert.equal(foreign.status, 400)
    assert.equal(foreign.body.error, 'Dieses Gerät ist für Push nicht registriert.')
    const cleared = await probeCall(runtime, caller, `{"token":${JSON.stringify(mine)}}`, {}, clearPath)
    assert.equal(cleared.status, 200)
    assert.equal(cleared.body.ok, true)
    assert.equal(cleared.body.failed, false)
    assert.equal(cleared.body.removed, 25)
    assert.equal(cleared.body.probeRemaining, 0)
    assert.equal(cleared.body.clearRemaining, 3)
    const left = (await readFile(join(dir, 'changes.jsonl'), 'utf8')).trim().split('\n')
    assert.deepEqual(left, ['not-json', keeper.trim()])
    const linkAfter = JSON.parse(await readFile(join(dir, 'link.json'), 'utf8'))
    assert.equal(linkAfter.revision, 4)
    assert.deepEqual(linkAfter.fcmTokens, [mine])
    assert.equal(await readFile(join(dir, 'snapshot.json'), 'utf8'), snapshot)
    assert.equal(await readFile(join(dir, 'notified-grades.json'), 'utf8'), ledger)
    assert.equal(await readFile(join(dir, 'notification-baseline.json'), 'utf8'), baseline)
    assert.equal(fetches, 0)
    const again = await probeCall(runtime, caller, `{"token":${JSON.stringify(mine)}}`, {}, clearPath)
    assert.equal(again.status, 200)
    assert.equal(again.body.ok, true)
    assert.equal(again.body.failed, false)
    assert.equal(again.body.removed, 0)
    assert.equal(again.body.clearRemaining, 2)
    assert.equal((await probeCall(runtime, caller, `{"token":${JSON.stringify(mine)}}`)).status, 429)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notification preferences keep only the school events the diff actually emits', () => {
  const blank = { grades: [], events: [], exams: [], absences: [], messages: [] }
  const grade = { id: 'g1', course: 'Mathematik', title: 'Probe', date: '2026-10-20', mark: 5.5, weight: 1 }
  const changed = { ...grade, mark: 4.5 }
  const lesson = { id: 'e1', start: '2026-11-02T08:15:00', end: '2026-11-02T09:00:00', text: 'Mathematik', room: 'R201', teachers: [], courseName: 'Mathematik', status: 'confirmed', eventType: 'lesson' }
  const exam = { id: 'ex1', start: '2026-11-10T10:00:00', end: '2026-11-10T10:45:00', text: 'Mathematik', room: 'R1', teachers: [], courseName: 'Mathematik', status: 'confirmed', eventType: '1_pru' }
  const otherExam = { ...exam, id: 'ex2', text: 'Chemie', courseName: 'Chemie' }
  const appointment = { id: 't1', start: '2026-11-04T15:00:00', end: '2026-11-04T16:00:00', text: 'Elternabend', room: 'Aula', teachers: [], courseName: '', status: '', eventType: 'event' }
  const titles = (previous, next, settings = {}) => diffSnapshots(previous, next, settings).map((change) => change.title)

  assert.deepEqual(titles(blank, { ...blank, grades: [grade] }), ['Neue Note'])
  assert.deepEqual(titles(blank, { ...blank, grades: [grade] }, { gradeNew: false }), [])
  assert.deepEqual(titles(blank, { ...blank, grades: [grade] }, { grades: false, gradeNew: true }), [])
  assert.deepEqual(titles({ ...blank, grades: [grade] }, { ...blank, grades: [changed] }), ['Notenänderung'])
  assert.deepEqual(titles({ ...blank, grades: [grade] }, { ...blank, grades: [changed] }, { gradeChanged: false }), [])

  assert.deepEqual(titles(blank, { ...blank, exams: [exam] }), ['Neue Prüfung'])
  assert.deepEqual(titles(blank, { ...blank, exams: [exam] }, { examNew: false }), [])
  const movedExam = { ...exam, start: '2026-11-10T12:00:00', end: '2026-11-10T12:45:00' }
  assert.deepEqual(titles({ ...blank, exams: [exam] }, { ...blank, exams: [movedExam] }), ['Prüfung verschoben'])
  assert.deepEqual(titles({ ...blank, exams: [exam] }, { ...blank, exams: [movedExam] }, { examMoved: false }), [])
  const cancelledExam = { ...exam, status: 'cancelled' }
  assert.deepEqual(titles({ ...blank, exams: [exam] }, { ...blank, exams: [cancelledExam] }), ['Prüfung fällt aus'])
  assert.ok(titles({ ...blank, exams: [exam] }, { ...blank, exams: [otherExam] }).includes('Prüfung entfällt'))
  assert.equal(titles({ ...blank, exams: [exam] }, { ...blank, exams: [cancelledExam] }, { examCancelled: false }).includes('Prüfung fällt aus'), false)
  assert.equal(titles({ ...blank, exams: [exam] }, { ...blank, exams: [otherExam] }, { examCancelled: false }).includes('Prüfung entfällt'), false)
  const movedRoom = { ...exam, room: 'R9' }
  assert.deepEqual(titles({ ...blank, exams: [exam] }, { ...blank, exams: [movedRoom] }), ['Raum geändert'])
  assert.deepEqual(titles({ ...blank, exams: [exam] }, { ...blank, exams: [movedRoom] }, { examRoom: false }), [])

  assert.deepEqual(titles({ ...blank, events: [lesson] }, { ...blank, events: [{ ...lesson, room: 'R202' }] }), ['Raum geändert'])
  assert.deepEqual(titles({ ...blank, events: [lesson] }, { ...blank, events: [{ ...lesson, room: 'R202' }] }, { lessonChanged: false }), [])
  assert.deepEqual(titles({ ...blank, events: [lesson] }, { ...blank, events: [{ ...lesson, status: 'cancelled' }] }), ['Lektion fällt aus'])
  assert.deepEqual(titles({ ...blank, events: [lesson] }, blank), ['Lektion entfernt'])
  assert.deepEqual(titles({ ...blank, events: [lesson] }, { ...blank, events: [{ ...lesson, status: 'cancelled' }] }, { lessonCancelled: false }), [])
  assert.equal(titles({ ...blank, events: [lesson] }, blank, { lessonCancelled: false }).includes('Lektion entfernt'), false)
  assert.deepEqual(titles({ ...blank, events: [lesson] }, { ...blank, events: [{ ...lesson, status: 'cancelled' }] }, { lessonChanged: false }), ['Lektion fällt aus'])

  assert.deepEqual(titles(blank, { ...blank, events: [appointment] }), ['Neuer Termin'])
  assert.deepEqual(titles(blank, { ...blank, events: [appointment] }, { appointmentNew: false }), [])
  assert.deepEqual(titles({ ...blank, events: [appointment] }, { ...blank, events: [{ ...appointment, start: '2026-11-05T15:00:00', end: '2026-11-05T16:00:00' }] }), [])
  assert.equal(notifyAlertKind({ category: 'event', title: 'Termin geändert' }), 'message-new')

  const message = { id: 'm1', title: 'Elternabend', body: 'Freitag 19 Uhr' }
  assert.deepEqual(titles(blank, { ...blank, messages: [message] }), ['Elternabend'])
  assert.deepEqual(titles(blank, { ...blank, messages: [message] }, { messageNew: false }), [])
  assert.deepEqual(titles(blank, { ...blank, messages: [message] }, { appointmentNew: false }), ['Elternabend'])

  const absence = { id: 'a1', dateFrom: '2026-11-01', hourFrom: '08:00', subject: 'Deutsch', reason: 'Arzt', excused: false }
  assert.deepEqual(titles(blank, { ...blank, absences: [absence] }, { enabled: false }), [])
  assert.equal(alertAllowed({ enabled: false, gradeNew: false }, { id: 'probe:1', category: 'grade', title: 'Test: Neue Note' }), true)
  assert.equal(alertAllowed({}, { id: 'grade:g1', category: 'grade', title: 'Neue Note' }), true)
})

test('older settings keep the category behaviour and a disabled master does not leak a mark', () => {
  const legacy = resolvedAlertSettings({
    grades: false,
    timetable: true,
    exams: true,
    absences: true,
    events: true,
    deadlines: true,
    guessGrades: false,
  })
  assert.equal(legacy.enabled, true)
  assert.equal(legacy.gradeNew, false)
  assert.equal(legacy.gradeChanged, false)
  assert.equal(legacy.lessonChanged, true)
  assert.equal(legacy.guessGrades, false)
  const kept = resolvedAlertSettings({ grades: true, timetable: true, exams: true, absences: true, events: true, deadlines: true })
  assert.equal(kept.enabled, true)
  assert.equal(kept.gradeNew, true)
  assert.equal(kept.appointmentNew, true)
  const master = resolvedAlertSettings({ enabled: false, grades: true, gradeNew: true, guessGrades: true })
  assert.equal(master.enabled, false)
  assert.equal(master.gradeNew, true)
  assert.equal(master.guessGrades, true)
  const blank = { grades: [], events: [], exams: [], absences: [], messages: [] }
  const grade = { id: 'g1', course: 'Mathematik', title: 'Probe', date: '2026-10-20', mark: 5.5, weight: 1 }
  const lesson = { id: 'e1', start: '2026-11-02T08:15:00', end: '2026-11-02T09:00:00', text: 'Mathematik', room: 'R201', teachers: [], courseName: 'Mathematik', status: 'confirmed', eventType: 'lesson' }
  const moved = { ...lesson, room: 'R202' }
  const mixed = diffSnapshots({ ...blank, events: [lesson] }, { ...blank, grades: [grade], events: [moved] }, legacy)
  assert.deepEqual(mixed.map((change) => change.title), ['Raum geändert'])
  assert.equal(JSON.stringify(mixed).includes('5.5'), false)
  const silent = diffSnapshots(blank, { ...blank, grades: [grade] }, master)
  assert.deepEqual(silent, [])
  assert.equal(alertAllowed(master, { id: 'probe:4', category: 'grade', title: 'Test: Neue Note' }), true)
})

const gradePollFetch = () => {
  let polls = 0
  return async (url) => {
    const json = (value) => ({ status: 200, text: async () => JSON.stringify(value) })
    if (String(url).endsWith('/token.php')) return json({ access_token: 'access-token-value', refresh_token: 'rotated-refresh-token-value-123456', expires_in: 3600 })
    if (String(url).includes('/me/grades')) {
      polls += 1
      const grades = [{ id: 'g1', course: 'Mathematik', title: 'Probe', date: '2026-10-20', mark: '5.5', weight: '1' }]
      if (polls > 1) grades.push({ id: 'g2', course: 'Englisch', title: 'Essay', date: '2026-11-01', mark: '4.5', weight: '1' })
      return json(grades)
    }
    return json([])
  }
}

test('turning alerts off still stores the snapshot and does not push', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-alerts-off-'))
  const key = randomBytes(32)
  const sent = []
  const runtime = createSchulnetzRuntime({
    root,
    key,
    fetch: gradePollFetch(),
    autostart: false,
    fcmSend: async (message) => { sent.push(message); return { status: 200 } },
  })
  try {
    const guest = await runtime.createGuest('203.0.113.9')
    await runtime.linkAccount(guest.accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'super-secret-refresh-token-value',
    })
    await runtime.addFcmToken(guest.accountId, 'phone:APA91b-example-token-value')
    await runtime.pollAccount(guest.accountId)
    assert.equal(sent.length, 0)
    const saved = await guestCall(runtime, guest, 'PUT', '/api/v1/schulnetz/settings', '{"enabled":false}')
    assert.equal(saved.status, 200)
    assert.equal(saved.body.settings.enabled, false)
    assert.equal(saved.body.settings.gradeNew, true)
    assert.equal(saved.body.settings.guessGrades, false)
    const again = await runtime.publicStatusOf(guest.accountId)
    assert.equal(again.settings.enabled, false)
    assert.equal(again.settings.gradeNew, true)
    await runtime.pollAccount(guest.accountId)
    const snapshot = JSON.parse(await readFile(join(root, 'accounts', guest.accountId, 'snapshot.json'), 'utf8'))
    assert.equal(snapshot.grades.some((row) => row.id === 'g2'), true)
    assert.equal(sent.length, 0)
    const changes = await readFile(join(root, 'accounts', guest.accountId, 'changes.jsonl'), 'utf8').catch(() => '')
    assert.equal(changes.includes('g2'), false)
    assert.equal(changes.includes('4.5'), false)
    assert.equal(changes.includes('5.5'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an older settings file still pushes a new grade as a data message', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-alerts-legacy-'))
  const key = randomBytes(32)
  const sent = []
  const runtime = createSchulnetzRuntime({
    root,
    key,
    fetch: gradePollFetch(),
    autostart: false,
    fcmSend: async (message) => { sent.push(message); return { status: 200 } },
  })
  const accountId = 'f'.repeat(32)
  try {
    await runtime.linkAccount(accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: 'super-secret-refresh-token-value',
    })
    await runtime.addFcmToken(accountId, 'phone:APA91b-example-token-value')
    await runtime.pollAccount(accountId)
    const file = join(root, 'accounts', accountId, 'link.json')
    const link = JSON.parse(await readFile(file, 'utf8'))
    link.settings = { grades: true, timetable: true, exams: true, absences: true, events: true, deadlines: true }
    await writeFile(file, JSON.stringify(link))
    await runtime.pollAccount(accountId)
    const snapshot = JSON.parse(await readFile(join(root, 'accounts', accountId, 'snapshot.json'), 'utf8'))
    assert.equal(snapshot.grades.some((row) => row.id === 'g2'), true)
    const changes = await readFile(join(root, 'accounts', accountId, 'changes.jsonl'), 'utf8')
    assert.match(changes, /g2/)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].message.data.event, 'sync')
    assert.equal(sent[0].message.notification, undefined)
    assert.equal(JSON.stringify(sent[0]).includes('4.5'), false)
    assert.equal(JSON.stringify(sent[0]).includes('5.5'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notices about lessons, exams and appointments that already ended are dropped', () => {
  const at = new Date('2026-11-09T12:30:00Z') // 13:30 in Zurich
  assert.equal(changeIsOver({ id: 'exam:a', category: 'exam', title: 'Neue Prüfung', body: '15.10.2026 · Mathematik · 14:55–15:40', date: '' }, at), true)
  assert.equal(changeIsOver({ id: 'exam:b', category: 'exam', title: 'Prüfung verschoben', body: '09.11.2026 · Chemie · 08:15–09:00' }, at), true)
  assert.equal(changeIsOver({ id: 'exam:c', category: 'exam', title: 'Neue Prüfung', body: '09.11.2026 · Chemie · 14:00–14:45' }, at), false)
  assert.equal(changeIsOver({ id: 'tt:a', category: 'timetable', title: 'Lektion fällt aus', body: 'x', date: '2026-11-06' }, at), true)
  assert.equal(changeIsOver({ id: 'ev:a', category: 'event', title: 'Neuer Termin', body: 'Sporttag', date: '2026-11-20' }, at), false)
  // Grades, absences, messages without a date and delivery tests never expire.
  assert.equal(changeIsOver({ id: 'grade:a', category: 'grade', title: 'Neue Note', body: 'Mathematik 5.5', date: '2026-10-01' }, at), false)
  assert.equal(changeIsOver({ id: 'absence:a', category: 'absence', title: 'Neue Absenz', body: 'x', date: '2026-10-01' }, at), false)
  assert.equal(changeIsOver({ id: 'event:m1', category: 'event', title: 'Elternabend', body: 'Freitag 19 Uhr' }, at), false)
  assert.equal(changeIsOver({ id: 'probe:1', category: 'exam', title: 'Test', body: '01.01.2026' }, at), false)

  const blank = { grades: [], events: [], exams: [], absences: [], messages: [] }
  const past = { id: 'p1', start: '2026-10-29T10:00:00', end: '2026-10-29T10:45:00', text: 'Biologie', room: 'R1', teachers: [], courseName: 'Biologie', status: '', eventType: '1_pru' }
  const future = { ...past, id: 'p2', start: '2026-11-19T10:00:00', end: '2026-11-19T10:45:00' }
  const titles = diffSnapshotsAt(blank, { ...blank, exams: [past, future] }, {}, '2026-11-09', at).map((c) => c.date)
  assert.deepEqual(titles, ['2026-11-19'])
  const moved = diffSnapshotsAt({ ...blank, exams: [past] }, { ...blank, exams: [{ ...past, start: '2026-10-29T12:00:00', end: '2026-10-29T12:45:00' }] }, {}, '2026-11-09', at)
  assert.deepEqual(moved, [])
})

test('appointments the list newly reaches are not announced as new', () => {
  const blank = { grades: [], events: [], exams: [], absences: [], messages: [] }
  const appointment = (id, day) => ({ id, start: `${day}T15:00:00`, end: `${day}T16:00:00`, text: `Anlass ${id}`, room: 'Aula', teachers: [], courseName: '', status: '', eventType: 'event' })
  const before = { ...blank, events: [appointment('a', '2026-11-12'), appointment('b', '2026-12-03')] }
  assert.equal(appointmentHorizon(before), '2026-12-03')
  const at = new Date('2026-11-09T08:00:00Z')
  // Inside the range already shown: news. Beyond it: the list grew further, quiet.
  const inside = diffSnapshotsAt(before, { ...before, events: [...before.events, appointment('c', '2026-11-26')] }, {}, '2026-11-09', at)
  assert.deepEqual(inside.map((c) => c.title), ['Neuer Termin'])
  const beyond = diffSnapshotsAt(before, { ...before, events: [...before.events, appointment('d', '2027-03-01')] }, {}, '2026-11-09', at)
  assert.deepEqual(beyond, [])
  // A large batch at once is the list loading more rows, not news.
  const many = Array.from({ length: APPOINTMENT_BURST + 1 }, (_, i) => appointment(`n${i}`, '2026-11-20'))
  assert.deepEqual(diffSnapshotsAt(before, { ...before, events: [...before.events, ...many] }, {}, '2026-11-09', at), [])
})

test('an empty scheduler only proves a free week next to real lessons or in holidays', () => {
  const holidays = [{ id: 'v', name: 'Weihnachtsferien', start: '2026-12-21', end: '2027-01-03' }]
  assert.equal(weekIsHoliday('2026-12-28', holidays), true)
  assert.equal(weekIsHoliday('2026-11-16', holidays), false)
  assert.equal(emptyWeekCountsAsRead('2026-11-16', false, holidays), false)
  assert.equal(emptyWeekCountsAsRead('2026-11-16', true, holidays), true)
  assert.equal(emptyWeekCountsAsRead('2026-12-28', false, holidays), true)
  const lesson = { id: 'l', start: '2026-11-10T08:15:00', end: '2026-11-10T09:00:00', text: 'Deutsch', eventType: 'lesson' }
  assert.deepEqual(Object.keys(withoutUnprovenEmptyReads({ '2026-11-09': 'x', '2026-11-16': 'x', '2026-12-28': 'x' }, [lesson], holidays)).sort(), ['2026-11-09', '2026-12-28'])
  const appointment = { id: 'a', start: '2027-06-30T08:00:00', end: '2027-06-30T09:00:00', text: 'Schlussfeier', eventType: 'event' }
  assert.deepEqual(fallbackSchoolSpan([appointment], holidays, '2026-11-09'), { start: '2026-10-12', end: '2027-06-30' })
  assert.equal(fallbackSchoolSpan([], [], '2026-11-09'), null)
})

test('a scrape reopens the timetable before its weeks and plans the school year without a page range', async () => {
  const calls = []
  const lessonXml = (monday) => `<data><event id="l${monday}"><start_date>${monday} 08:15</start_date><end_date>${monday} 09:00</end_date><text>Deutsch</text><event_type>0_stp</event_type></event></data>`
  let page = 0
  const fetchImpl = async (url, init) => {
    const text = String(url)
    calls.push({ url: text, referer: init?.headers?.Referer || '' })
    if (!text.includes('scheduler_processor')) {
      page += 1
      return { status: 200, headers: { get: () => '' }, text: async () => `<html><body><a href="index.php?pageid=1&id=abc&transid=t${page}">x</a></body></html>` }
    }
    const monday = text.match(/min_date=(\d{4}-\d{2}-\d{2})/)[1]
    const body = text.includes('pageid=22202') && monday <= '2026-12-14' ? lessonXml(monday) : '<data></data>'
    return { status: 200, headers: { get: () => '' }, text: async () => body }
  }
  const session = { php: 'php', id: 'abc', transid: 't0', userAgent: 'test' }
  const year = { id: 'y', start: '2027-06-30T08:00:00', end: '2027-06-30T09:00:00', text: 'Schlussfeier', courseName: '', teachers: [], status: '', eventType: 'event', room: '' }
  const result = await scrapeWithSession('https://www.schulnetz-ag.ch/aksa', session, fetchImpl, { today: '2026-11-09', now: '2026-11-09T07:00:00Z', previousEvents: [year] })
  const firstLesson = calls.findIndex((c) => c.url.includes('scheduler_processor') && c.url.includes('pageid=22202'))
  const firstExam = calls.findIndex((c) => c.url.includes('scheduler_processor') && c.url.includes('pageid=21312'))
  assert.match(calls[firstLesson - 1].url, /pageid=22202/u)
  assert.match(calls[firstExam - 1].url, /pageid=21312/u)
  assert.match(calls[firstLesson].referer, /pageid=22202/u)
  // The appointment list reaches into 2027, so weeks well beyond the old four-week probe are asked for.
  const asked = calls.filter((c) => c.url.includes('scheduler_processor') && c.url.includes('pageid=22202')).map((c) => c.url.match(/min_date=([\d-]+)/)[1])
  assert.ok(asked.some((monday) => monday > '2026-12-07'))
  assert.ok(result.events.some((event) => event.id === 'l2026-11-16'))
  // The scheduler gave lessons, so an empty later week is a real free week.
  const empty = asked.find((monday) => monday > '2026-12-14')
  if (empty) assert.equal(typeof result.weekRead[empty], 'string')
})

test('a week that gets its timetable for the first time is read silently', () => {
  // 9 Nov 2026 incident: older reads stamped weeks as read from empty scheduler answers; when the
  // lessons finally loaded, each one was announced as "Stundenplan geändert" or "Vertretung".
  const at = new Date('2026-11-09T05:45:00Z')
  const week = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']
  const lessons = week.flatMap((day, d) => Array.from({ length: 8 }, (_, h) => ({
    id: `s${d}${h}`, start: `${day}T${String(7 + h).padStart(2, '0')}:45:00`, end: `${day}T${String(8 + h).padStart(2, '0')}:30:00`,
    text: `Fach ${h}`, room: `R${h}`, teachers: [`T${h}`], courseName: `Fach ${h}`, status: '', eventType: '0_stp',
  })))
  const stamps = { '2026-11-09': '2026-11-08T20:00:00Z' }
  const previous = { grades: [], events: [], exams: [], absences: [], messages: [], weekFetched: stamps, weekRead: stamps }
  const next = { ...previous, events: lessons, weekFetched: { '2026-11-09': '2026-11-09T05:45:00Z' }, weekRead: { '2026-11-09': '2026-11-09T05:45:00Z' }, fetchedAt: '2026-11-09T05:45:00Z' }
  assert.deepEqual([...lessonSeedWeeks(previous, next)], ['2026-11-09'])
  assert.deepEqual(diffSnapshotsAt(previous, next, {}, '2026-11-09', at), [])
  // Same through the poller's notification baseline, where the week was stored with no lessons.
  const read = prepareAgendaRead({ '2026-11-09': { fetchedAt: '2026-11-08T20:00:00Z', events: [], exams: [], weekFetched: stamps, examWeekFetched: {} } }, next)
  const before = { ...previous, events: read.before.events, exams: read.before.exams }
  assert.deepEqual(diffSnapshotsAt(before, next, {}, '2026-11-09', at), [])
  // One or two lessons added to an empty week are still news; later changes in a seeded week too.
  const one = { ...next, events: lessons.slice(0, LESSON_SEED_MIN - 1) }
  assert.equal(diffSnapshotsAt(previous, one, {}, '2026-11-09', at).filter((c) => c.category === 'timetable').length, LESSON_SEED_MIN - 1)
  const moved = { ...next, events: lessons.map((l) => l.id === 's40' ? { ...l, room: 'Aula' } : l) }
  assert.deepEqual(diffSnapshotsAt(next, moved, {}, '2026-11-09', at).map((c) => c.title), ['Raum geändert'])
  // A whole timetable changing in one read is a reload, not news.
  const reload = { ...next, events: lessons.map((l) => ({ ...l, room: `${l.room}x` })) }
  assert.ok(lessons.length > TIMETABLE_BURST)
  assert.deepEqual(diffSnapshotsAt(next, reload, {}, '2026-11-09', at), [])
})

test('an exam-like appointment that stays listed is not reported as cancelled', () => {
  const at = new Date('2026-11-09T05:45:00Z')
  const listed = { id: 'term1', start: '2026-12-01T08:00:00', end: '2026-12-01T12:00:00', text: 'Prüfung Biologie', room: '', teachers: [], courseName: '', status: '', eventType: 'event' }
  // Another exam keeps the exam list non-empty; an empty list never cancels anything.
  const other = { id: 'x9', start: '2026-12-08T10:00:00', end: '2026-12-08T10:45:00', text: 'Chemie', room: 'R1', teachers: [], courseName: 'Chemie', status: '', eventType: '1_pru' }
  const snapshot = { grades: [], events: [listed], exams: [other], absences: [], messages: [] }
  assert.equal(isExamLike(listed), true)
  assert.deepEqual(diffSnapshotsAt(snapshot, snapshot, {}, '2026-11-09', at), [])
  // Gone from the list and from the exams: that is a cancellation.
  assert.deepEqual(diffSnapshotsAt(snapshot, { ...snapshot, events: [] }, {}, '2026-11-09', at).map((c) => c.title), ['Prüfung entfällt'])
})

test('a near week read without lessons is checked again within half an hour', () => {
  const now = '2026-11-09T06:10:00Z'
  const stamps = { '2026-11-09': '2026-11-09T05:24:00Z', '2026-11-16': '2026-11-09T05:24:00Z', '2026-11-23': '2026-11-09T05:24:00Z', '2026-12-07': '2026-11-09T05:24:00Z', '2026-12-14': '2026-11-09T05:24:00Z', '2026-10-26': '2026-11-09T05:24:00Z' }
  const base = { mondays: [], fetchedAt: stamps, icalFetchedAt: '', now, today: '2026-11-09', icalAvailable: false }
  // Without the hint only the current and adjacent weeks are due after 30 minutes.
  assert.deepEqual(planWeekFetches(base).fetch.filter((m) => stamps[m]).sort(), ['2026-11-09', '2026-11-16'])
  // Empty weeks up to four ahead join them; a past empty week and one five ahead keep the daily cadence.
  const empty = new Set(['2026-11-23', '2026-12-07', '2026-12-14', '2026-10-26'])
  assert.deepEqual(planWeekFetches({ ...base, emptyWeeks: empty }).fetch.filter((m) => stamps[m]).sort(), ['2026-11-09', '2026-11-16', '2026-11-23', '2026-12-07'])
})

test('a lesson id that Schulnetz reuses in another week is not a moved lesson', () => {
  const at = new Date('2026-11-09T05:45:00Z')
  const lesson = (id, start, room) => ({ id, start, end: start.replace(':45:', ':30:').replace('T07', 'T08'), text: 'Deutsch', room, teachers: ['T'], courseName: 'Deutsch', status: '', eventType: '0_stp' })
  const thisWeek = [lesson('L1', '2026-11-12T07:45:00', 'A1'), lesson('L2', '2026-11-13T07:45:00', 'A1'), lesson('L3', '2026-11-11T07:45:00', 'A1')]
  const previous = { grades: [], events: thisWeek, exams: [], absences: [], messages: [] }
  // Two weeks later the same ids come back, one of them in another room.
  const later = [lesson('L1', '2026-11-26T07:45:00', 'B2'), lesson('L2', '2026-11-27T07:45:00', 'A1'), lesson('L4', '2026-11-25T07:45:00', 'A1')]
  const next = { ...previous, events: [...thisWeek, ...later] }
  assert.deepEqual(diffSnapshotsAt(previous, next, {}, '2026-11-09', at), [])
  // Within one week the id still tracks a real change.
  const moved = { ...previous, events: [lesson('L1', '2026-11-12T07:45:00', 'C3'), ...thisWeek.slice(1)] }
  assert.deepEqual(diffSnapshotsAt(previous, moved, {}, '2026-11-09', at).map((c) => c.title), ['Raum geändert'])
})

test('without a page range the planner follows a published timetable forward', () => {
  const lesson = (day) => ({ id: day, start: `${day}T08:00:00`, end: `${day}T08:45:00`, text: 'Deutsch', eventType: '0_stp' })
  // Lessons only (no appointment list): eight weeks past the last lesson read.
  assert.deepEqual(fallbackSchoolSpan([lesson('2026-12-10')], [], '2026-11-09'), { start: '2026-10-12', end: '2027-02-04' })
  // Exams count as known dates too.
  const exam = { id: 'x', start: '2027-03-18T10:00:00', end: '2027-03-18T10:45:00', text: 'Chemie', eventType: 'exam' }
  assert.equal(fallbackSchoolSpan([], [], '2026-11-09', [exam]).end, '2027-03-18')
  // Still at most forty weeks ahead.
  assert.equal(fallbackSchoolSpan([lesson('2027-07-01')], [], '2026-11-09').end, '2027-08-16')
})

test('a phone upload keeps the timetable weeks the server read', () => {
  const lesson = (id, day, room = 'A1') => ({ id, start: `${day}T08:00:00`, end: `${day}T08:45:00`, text: 'Deutsch', room, teachers: ['T'], courseName: 'Deutsch', status: '', eventType: '0_stp' })
  const appointment = { id: 't1', start: '2026-11-20T15:00:00', end: '2026-11-20T16:00:00', text: 'Sporttag', eventType: 'event' }
  const server = { events: [lesson('s1', '2026-11-10'), lesson('s2', '2026-11-17'), lesson('s3', '2026-11-24')], weekFetched: { '2026-11-16': 'S', '2026-11-23': 'S' }, weekRead: { '2026-11-09': 'S', '2026-11-16': 'S', '2026-11-23': 'S' } }
  // An older app: its own rendering of this week, nothing later, and empty stamps for later weeks.
  const upload = { events: [lesson('dom1', '2026-11-10', 'A1 '), appointment, lesson('p9', '2026-12-01')], weekFetched: { '2026-11-16': 'P', '2026-11-30': 'P' }, weekRead: { '2026-11-16': 'P', '2026-11-30': 'P' }, grades: [] }
  const merged = keepServerLessons(server, upload)
  assert.deepEqual(merged.events.map((e) => e.id).sort(), ['p9', 's1', 's2', 's3', 't1'])
  assert.deepEqual(merged.weekFetched, { '2026-11-16': 'S', '2026-11-23': 'S', '2026-11-30': 'P' })
  assert.deepEqual(merged.weekRead, { '2026-11-09': 'S', '2026-11-16': 'S', '2026-11-23': 'S', '2026-11-30': 'P' })
  // Nothing read yet on the server: the upload stays as it is.
  assert.equal(keepServerLessons({ events: [appointment] }, upload), upload)
})

test('an older app gets this week only and no stamps that would read as changes', () => {
  const lesson = (id, day) => ({ id, start: `${day}T08:00:00`, end: `${day}T08:45:00`, text: 'Deutsch', room: 'A1', teachers: ['T'], courseName: 'Deutsch', status: '', eventType: '0_stp' })
  const appointment = { id: 't1', start: '2026-11-20T15:00:00', end: '2026-11-20T16:00:00', text: 'Sporttag', eventType: 'event' }
  const snapshot = {
    events: [lesson('a', '2026-11-10'), lesson('b', '2026-11-17'), appointment],
    weekFetched: { '2026-11-09': 'S', '2026-11-16': 'S', '2026-12-21': 'S' },
    weekRead: { '2026-11-09': 'S', '2026-11-16': 'S', '2026-12-21': 'S' },
  }
  const view = legacySnapshotView(snapshot, '2026-11-09')
  assert.deepEqual(view.events.map((e) => e.id), ['a', 't1'])
  assert.deepEqual(view.weekFetched, { '2026-12-21': 'S' })
  assert.deepEqual(view.weekRead, { '2026-11-09': 'S', '2026-12-21': 'S' })
  assert.equal(legacySnapshotView({ events: [appointment] }, '2026-11-09').events.length, 1)
})

const fixture5141 = (name) => readFileSync(new URL(`../android/core/src/test/resources/schulnetz/${name}`, import.meta.url), 'utf8')

test('the semester range and the fresh transid come from the real 5.14.1 page shape', () => {
  const plan = fixture5141('stundenplan-5141.html')
  const exams = fixture5141('pruefungsplan-5141.html')
  assert.deepEqual(parseWeekSpan(plan), { start: '2026-08-10', end: '2027-01-29' })
  assert.deepEqual(parseWeekSpan(exams), { start: '2026-08-10', end: '2027-01-29' })
  assert.deepEqual(semesterSpan('return scheduler.templates.day_date(new Date("2026-08-10"))+" &ndash; "+scheduler.templates.day_date(scheduler.date.add(new Date("2027-01-30"),-1,"day"));'), { start: '2026-08-10', end: '2027-01-29' })
  assert.deepEqual(semesterSpan('<input id="zeitraum_von" value="10.08.2026"> if(\'2027-01-30\'<max_date) alert(1)'), { start: '2026-08-10', end: '2027-01-29' })
  assert.equal(semesterSpan('<html><body>Stundenplan</body></html>'), null)
  assert.equal(schedulerTransid(plan, '22202'), 'a1b2c3')
  assert.equal(schedulerTransid(exams, '21312'), 'b2c3d4')
  // The URL carried the transid that was sent; the page printed a fresh one, which wins.
  assert.deepEqual(extractWebIds('https://www.schulnetz-ag.ch/aksa/index.php?pageid=22202&id=f1a2b3c4d5e6f708&transid=e0e0e0', plan), { id: 'f1a2b3c4d5e6f708', transid: 'a1b2c3' })
  // A body without links (the scheduler XML) keeps the URL's ids.
  assert.deepEqual(extractWebIds('https://x.schulnetz-ag.ch/aksa/scheduler_processor.php?id=f1a2b3c4d5e6f708&transid=a1b2c3', '<data></data>'), { id: 'f1a2b3c4d5e6f708', transid: 'a1b2c3' })
})

test('a scrape loads every semester week with each page\'s printed transid and never trusts a bare empty answer', async () => {
  const empty = "<?xml version='1.0' encoding='utf-8' ?><data></data>"
  const lessonXml = (monday) => `<data>${[0, 1, 2, 3, 4].map((d) => { const day = addDays(monday, d); return `<event id="L${day}"><start_date>${day} 07:45</start_date><end_date>${day} 08:30</end_date><text>Fach</text><event_type>0_stp</event_type></event><event id="M${day}"><start_date>${day} 08:35</start_date><end_date>${day} 09:20</end_date><text>Fach 2</text><event_type>0_stp</event_type></event>` }).join('')}</data>`
  const scrape = async (works, options = {}) => {
    const calls = []
    const fetchImpl = async (url) => {
      const target = String(url)
      calls.push(target)
      const q = Object.fromEntries(new URL(target).searchParams)
      let body = `<html><body>${['1', '21311', '21111', '21411', '21200', '22202', '22108', '21312'].map((p) => `<a href="index.php?pageid=${p}&amp;id=f1a2b3c4d5e6f708&amp;transid=d1e2f3">x</a>`).join('')}</body></html>`
      if (target.includes('scheduler_processor')) {
        body = empty
        if (works && q.pageid === '22202' && q.transid === 'a1b2c3' && !['2026-12-21', '2026-12-28'].includes(q.min_date)) body = lessonXml(q.min_date)
      } else if (q.pageid === '22202') body = fixture5141('stundenplan-5141.html')
      else if (q.pageid === '21312') body = fixture5141('pruefungsplan-5141.html')
      return { status: 200, headers: { get: () => '' }, text: async () => body }
    }
    const result = await scrapeWithSession('https://www.schulnetz-ag.ch/aksa', { php: 'php', id: 'f1a2b3c4d5e6f708', transid: 'e0e0e0', userAgent: 'test' }, fetchImpl, { today: '2026-11-06', now: '2026-11-06T17:00:00Z', ...options })
    return { result, calls }
  }
  const { result, calls } = await scrape(true)
  const lessonCalls = calls.filter((url) => url.includes('scheduler_processor') && url.includes('pageid=22202'))
  assert.ok(lessonCalls.length > 9)
  assert.ok(lessonCalls.every((url) => url.includes('transid=a1b2c3')))
  assert.ok(calls.filter((url) => url.includes('scheduler_processor') && url.includes('pageid=21312')).every((url) => url.includes('transid=b2c3d4')))
  assert.equal(result.weekSpanStart, '2026-08-10')
  assert.equal(result.weekSpanEnd, '2027-01-29')
  const taught = new Set(result.events.filter(isLesson).map((event) => weekMondayKey(event.start)))
  for (const week of ['2026-11-09', '2026-11-16', '2026-12-07', '2027-01-25']) assert.ok(taught.has(week), week)
  assert.ok(result.weekRead['2026-12-21'], 'a holiday answered empty with a proven transid is a free week')
  // Stale transid everywhere: weeks are attempted, never marked read, and asked again 40 minutes later.
  const stale = await scrape(false)
  assert.ok(stale.result.weekFetched['2026-11-16'])
  assert.equal(stale.result.weekRead['2026-11-16'], undefined)
  const retry = await scrape(true, { now: '2026-11-06T17:40:00Z', previousEvents: stale.result.events, weekFetched: stale.result.weekFetched, weekRead: stale.result.weekRead, weekSpanStart: stale.result.weekSpanStart, weekSpanEnd: stale.result.weekSpanEnd })
  assert.ok(retry.calls.some((url) => url.includes('scheduler_processor') && url.includes('min_date=2026-11-23')))
  assert.ok(retry.result.weekRead['2026-11-23'])
})

// --- Lessons survive later reads; every grade row is read (beta.17 field reports) ---

const realIdLessons = (mondays) => mondays.flatMap((monday) => [0, 1, 2, 3, 4].flatMap((d) => [0, 1, 2].map((slot) => {
  const day = addDays(monday, d)
  const clock = ['07:45', '08:35', '09:40'][slot]
  // Schulnetz numbers the lessons of a week and reuses those ids every week.
  return { id: String(d * 3 + slot + 1), start: `${day}T${clock}:00`, end: `${day}T${clock}:00`, text: `Fach ${slot}`, eventType: '0_stp', teachers: [], room: '' }
})))

test('appointments merge by id without dropping lessons that reuse their id every week', () => {
  const lessons = realIdLessons(['2026-11-02', '2026-11-09', '2026-11-16'])
  const appointment = { id: 'T1', start: '2026-11-12T08:00:00', end: '2026-11-12T12:00:00', text: 'Sporttag', eventType: 'event' }
  const merged = mergeEventsById([...lessons, appointment], [{ ...appointment, text: 'Sporttag (verschoben)' }, { ...appointment, id: 'T2' }])
  assert.equal(merged.filter(isLesson).length, 45)
  for (const week of ['2026-11-02', '2026-11-09', '2026-11-16']) assert.equal(merged.filter((event) => isLesson(event) && weekMondayKey(event.start) === week).length, 15, week)
  assert.equal(merged.find((event) => event.id === 'T1').text, 'Sporttag (verschoben)')
  assert.ok(merged.some((event) => event.id === 'T2'))
})

test('a scheduler answer for another week never empties the requested week', async () => {
  const lessonXml = (monday) => `<data>${realIdLessons([monday]).map((event) => `<event id="${event.id}"><start_date>${event.start.slice(0, 10)} ${event.start.slice(11, 16)}</start_date><end_date>${event.start.slice(0, 10)} ${event.start.slice(11, 16)}</end_date><text>${event.text}</text><event_type>0_stp</event_type></event>`).join('')}</data>`
  const fetchImpl = async (url) => {
    const target = String(url)
    const q = Object.fromEntries(new URL(target).searchParams)
    let body = `<html><body>${['1', '21311', '21111', '21411', '21200', '22202', '22108', '21312'].map((p) => `<a href="index.php?pageid=${p}&amp;id=f1a2b3c4d5e6f708&amp;transid=d1e2f3">x</a>`).join('')}</body></html>`
    // The scheduler ignores the requested range and always answers with the week of 9 November.
    if (target.includes('scheduler_processor')) body = q.pageid === '22202' && q.transid === 'a1b2c3' ? lessonXml('2026-11-09') : "<?xml version='1.0' encoding='utf-8' ?><data></data>"
    else if (q.pageid === '22202') body = fixture5141('stundenplan-5141.html')
    else if (q.pageid === '21312') body = fixture5141('pruefungsplan-5141.html')
    return { status: 200, headers: { get: () => '' }, text: async () => body }
  }
  const stored = realIdLessons(['2026-11-16', '2026-11-23'])
  const read = await scrapeWithSession('https://www.schulnetz-ag.ch/aksa', { php: 'php', id: 'f1a2b3c4d5e6f708', transid: 'e0e0e0', userAgent: 'test' }, fetchImpl, {
    today: '2026-11-11', now: '2026-11-11T17:00:00Z', previousEvents: stored, weekFetched: { '2026-11-16': '2026-11-10T07:00:00Z', '2026-11-23': '2026-11-10T07:00:00Z' }, weekRead: { '2026-11-16': '2026-11-10T07:00:00Z', '2026-11-23': '2026-11-10T07:00:00Z' },
  })
  for (const week of ['2026-11-09', '2026-11-16', '2026-11-23']) assert.equal(read.events.filter((event) => isLesson(event) && weekMondayKey(event.start) === week).length, 15, week)
})

test('every grade row of a real-shaped grades page is read, tooltips and pending rows included', async () => {
  const html = await readFile(new URL('../android/core/src/test/resources/schulnetz/noten-5141.html', import.meta.url), 'utf8')
  const grades = parseGradesHtml(html)
  // 8 rows in four courses: plain marks, marks followed by an info tooltip with other numbers, a comma
  // decimal, rows still waiting for a mark, and a row without date or weight. A course without
  // grades adds none.
  assert.equal(grades.length, 8)
  const by = (title) => grades.find((grade) => grade.title === title)
  assert.equal(by('Geometrie').mark, 4.25)
  assert.equal(by('Aufsatz Erörterung').mark, 5)
  assert.equal(by('Aufsatz Erörterung').weight, 2)
  assert.equal(by('Kurztest Wurzeln').mark, 4.5)
  assert.equal(by('Kurztest Wurzeln').weight, 0.5)
  assert.equal(by('Funktionen').mark, null)
  assert.equal(by('Genetik').mark, null)
  assert.equal(by('Vocabulaire').date, '')
  assert.equal(by('Vocabulaire').weight, 1)
  assert.ok(grades.every((grade) => grade.mark == null || (grade.mark >= 1 && grade.mark <= 6)))
  assert.deepEqual([...new Set(grades.map((grade) => grade.courseId))], ['MAT_K99Z_Demo', 'Kurs', 'BIO_K99Z_Demo', 'FRA_K99Z_Demo'])
})

test('a pending grade is not news, its mark arriving is a new grade', () => {
  const pending = { id: 'web:MAT:14.10.2026:Funktionen:', course: 'Mathematik', courseId: 'MAT', subject: 'Mathematik', title: 'Funktionen', date: '2026-10-14', mark: null, weight: 1, confirmed: true }
  const base = { grades: [{ ...pending, id: 'web:MAT:02.09.2026:Algebra:5.5', title: 'Algebra', date: '2026-09-02', mark: 5.5 }] }
  const withPending = { grades: [...base.grades, pending] }
  assert.equal(diffSnapshots(base, withPending, {}).filter((change) => change.category === 'grade').length, 0)
  const marked = { grades: [...base.grades, { ...pending, id: 'web:MAT:14.10.2026:Funktionen:4', mark: 4 }] }
  const changes = diffSnapshots(withPending, marked, {}).filter((change) => change.category === 'grade')
  assert.equal(changes.length, 1)
  assert.equal(changes[0].title, 'Neue Note')
})

test('grades only the new parser reads are not announced once, later grades are', async () => {
  const html = await readFile(new URL('../android/core/src/test/resources/schulnetz/noten-5141.html', import.meta.url), 'utf8')
  const all = parseGradesHtml(html)
  // What the old parser kept: plain marks only.
  const old = { grades: all.filter((grade) => ['Algebra 1', 'Kurztest Wurzeln', 'Vocabulaire'].includes(grade.title)) }
  const next = { grades: all, gradeParser: GRADE_PARSER_VERSION }
  assert.ok(diffSnapshots(old, next, {}).some((change) => change.category === 'grade'), 'without the reseed the old marks would be announced')
  assert.equal(diffSnapshots(gradeDiffBase(old, next), next, {}).filter((change) => change.category === 'grade').length, 0)
  const later = { ...next, grades: [...all, { ...all[0], id: 'web:MAT:11.11.2026:Neu:4', title: 'Neu', date: '2026-11-11', mark: 4 }] }
  assert.equal(diffSnapshots(gradeDiffBase(next, later), later, {}).filter((change) => change.category === 'grade').length, 1)
})

test('a semester-sized app snapshot is accepted plain and gzip', async () => {
  const lessons = realIdLessons(Array.from({ length: 24 }, (_, week) => addDays('2026-08-10', week * 7)))
    .map((event) => ({ ...event, room: 'Zimmer 101', teachers: ['Lehrperson A'], courseId: '41234', courseName: 'Mathematik Grundlagenfach', timetableText: 'Mathematik Grundlagenfach' }))
  const body = JSON.stringify({ grades: [], events: lessons, weekRead: {}, weekFetched: {} })
  assert.ok(body.length > 64 * 1024, 'bigger than the old 64 KB limit')
  assert.deepEqual(decodeRequestJson(gzipSync(Buffer.from(body)), 'gzip').events.length, lessons.length)
  assert.throws(() => decodeRequestJson(gzipSync(Buffer.alloc(SNAPSHOT_JSON_LIMIT + 10, 32)), 'gzip'), (error) => error.status === 413)
  assert.throws(() => decodeRequestJson(Buffer.from(body), 'br'), (error) => error.status === 415)
  assert.throws(() => decodeRequestJson(Buffer.from('not gzip'), 'gzip'), (error) => error.status === 400)
  const root = await mkdtemp(join(tmpdir(), 'schulnetz-upload-'))
  const runtime = createSchulnetzRuntime({ root, key: randomBytes(32), autostart: false })
  try {
    const guest = await runtime.createGuest('203.0.113.34')
    await runtime.linkAccount(guest.accountId, { baseUrl: 'https://www.schulnetz-ag.ch/aksa', deviceId: '0123456789abcdef01234567', refreshToken: 'synthetic-refresh-token-long-enough' })
    const plain = await invokeSchulnetz(runtime, 'PUT', '/api/v1/schulnetz/snapshot', guestHeaders(guest), body)
    assert.equal(plain.status, 200)
    const packed = await invokeSchulnetz(runtime, 'PUT', '/api/v1/schulnetz/snapshot', { ...guestHeaders(guest), 'content-encoding': 'gzip' }, gzipSync(Buffer.from(body)))
    assert.equal(packed.status, 200)
    const stored = JSON.parse(await readFile(join(root, 'accounts', guest.accountId, 'snapshot.json'), 'utf8'))
    assert.equal(stored.events.filter(isLesson).length, lessons.length)
    // Other requests keep the small limit.
    const big = await invokeSchulnetz(runtime, 'PUT', '/api/v1/schulnetz/settings', guestHeaders(guest), JSON.stringify({ pad: 'x'.repeat(70 * 1024) }))
    assert.equal(big.status, 413)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the first upload after uploads were refused announces no absence, message or appointment backlog', () => {
  const absence = (id) => ({ id, dateFrom: '2026-11-02', dateTo: '2026-11-02', hourFrom: '07:45', hourTo: '08:30', subject: 'Fach', reason: 'Krank', excused: false, acknowledged: false, status: 'offen' })
  const message = (id) => ({ id, title: 'Termin', body: `Elternabend ${id}`, at: '2026-11-20' })
  const appointment = (id) => ({ id, start: '2026-11-20T19:00:00', end: '2026-11-20T20:00:00', text: `Anlass ${id}`, eventType: 'event' })
  const server = { events: realIdLessons(['2026-11-09']), absences: [], messages: [], exams: [] }
  const upload = { ...server, absences: [absence('a1'), absence('a2')], messages: [message('m1')], events: [...server.events, appointment('t1'), appointment('t2')] }
  assert.ok(diffSnapshots(server, upload, {}).length > 0, 'without the base the backlog would be announced')
  assert.equal(diffSnapshots(uploadDiffBase(server, upload), upload, {}).length, 0)
  // Once the lists are known, a single new absence is news again; a large batch is not.
  const known = { ...upload }
  const one = { ...upload, absences: [...upload.absences, absence('a3')] }
  assert.equal(diffSnapshots(uploadDiffBase(known, one), one, {}).filter((change) => change.category === 'absence').length, 1)
  const many = { ...upload, absences: [...upload.absences, ...Array.from({ length: UPLOAD_LIST_BURST + 1 }, (_, i) => absence(`b${i}`))] }
  assert.equal(diffSnapshots(uploadDiffBase(known, many), many, {}).filter((change) => change.category === 'absence').length, 0)
})

test('a push names its school connection by a route key and keeps one collapse slot per connection', () => {
  // Shared test vector with the app (android core ConnectionsTest).
  assert.equal(connectionRouteKey('0123456789abcdef0123456789abcdef'), 'b6df6a1c77130be8')
  const first = fcmDataMessage('token', 'sync', { route: connectionRouteKey('0123456789abcdef0123456789abcdef') })
  const second = fcmDataMessage('token', 'sync', { route: connectionRouteKey('fedcba9876543210fedcba9876543210') })
  assert.equal(first.message.data.route, 'b6df6a1c77130be8')
  assert.notEqual(first.message.android.collapse_key, second.message.android.collapse_key)
  assert.equal(JSON.stringify(first).includes('0123456789abcdef0123456789abcdef'), false)
  // Without a valid route the message stays as before.
  const plain = fcmDataMessage('token', 'sync', { route: 'not-a-route' })
  assert.equal(plain.message.data.route, undefined)
  assert.equal(plain.message.android.collapse_key, 'kanti-sync')
})

