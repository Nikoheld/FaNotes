import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCipheriv, randomBytes } from 'node:crypto'
import { createSchulnetzRuntime, openToken, sealToken } from './schulnetz-api.mjs'
import {
  diffSnapshots,
  normalizeSchoolBase,
  parseRawSnapshot,
  pluspunkte,
  redactSecrets,
  schulnetzCallAllowed,
  weightedAverage,
  wunschnote,
} from './schulnetz-logic.mjs'

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

test('diff ids stay stable and the first snapshot is silent', () => {
  const grade = { id: 'g1', course: 'Mathematik', title: 'Probe', date: '2026-10-20', mark: 5.5, weight: 1 }
  const next = { grades: [grade], events: [], exams: [], absences: [], messages: [] }
  assert.deepEqual(diffSnapshots(null, next), [])
  const [change] = diffSnapshots({ grades: [], events: [], exams: [], absences: [], messages: [] }, next)
  assert.equal(change.id, 'grade:g1:5.5|1|Probe|2026-10-20')
  assert.equal(change.category, 'grade')
  assert.equal(change.title, 'Neue Note')
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
  assert.equal(redactSecrets('Bearer super-secret refresh_token=abcdef'), 'Bearer [redacted] refresh_token=[redacted]')
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
    if (String(url).startsWith('https://ntfy.example/')) return { status: 200, text: async () => 'ok' }
    return json([])
  }
  const previousNtfy = process.env.FANOTES_NTFY_URL
  process.env.FANOTES_NTFY_URL = 'https://ntfy.example'
  const runtime = createSchulnetzRuntime({ root, key, fetch, autostart: false })
  const accountId = 'a'.repeat(32)
  try {
    const status = await runtime.linkAccount(accountId, {
      baseUrl: 'https://www.schulnetz-ag.ch/aksa',
      deviceId: '0123456789abcdef01234567',
      refreshToken: secret,
      displayName: 'Fabio',
    })
    assert.equal(status.linked, true)
    assert.equal(JSON.stringify(status).includes(secret), false)
    const stored = await readFile(join(root, 'accounts', accountId, 'link.json'), 'utf8')
    assert.equal(stored.includes(secret), false)
    const roundTrip = openToken(key, JSON.parse(stored).refresh)
    assert.equal(roundTrip, secret)
    await runtime.pollAccount(accountId)
    assert.equal(await runtime.openStoredRefresh(accountId), 'rotated-refresh-token-value-123456')
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
  } finally {
    if (previousNtfy == null) delete process.env.FANOTES_NTFY_URL
    else process.env.FANOTES_NTFY_URL = previousNtfy
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
      return response(200, '<table><tr><td></td><td>20.10.2026</td><td>Probe</td><td>5.5</td><td>1</td></tr></table><b>MA-4a-He</b>')
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

test('seal round trip uses aes-256-gcm', () => {
  const key = randomBytes(32)
  const sealed = sealToken(key, 'token-value-which-is-long-enough')
  assert.equal(openToken(key, sealed), 'token-value-which-is-long-enough')
  sealed.data = createCipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64')).update('x').toString('base64')
  assert.throws(() => openToken(key, sealed))
})
