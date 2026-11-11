import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createMensa, mensaQuery, parseMensaApi, parseMensaHtml, pickMensaDay } from './mensa.mjs'

const apiFixture = JSON.parse(await fs.readFile(new URL('./test-fixtures/mensa-api-week.json', import.meta.url), 'utf8'))
const fixture = await fs.readFile(new URL('./test-fixtures/mensa-alte-kanti.html', import.meta.url), 'utf8')

test('parses the real page fixture', () => {
  const { days } = parseMensaHtml(fixture)
  assert.equal(days.length, 1)
  const [day] = days
  assert.equal(day.date, '2026-11-10')
  assert.equal(day.weekday, 'Di')
  assert.equal(day.closed, false)
  assert.equal(day.menus.length, 2)
  assert.deepEqual(day.menus[0], {
    name: 'Pouletgeschnetzeltes ( CH )',
    description: 'Zürcher Art, Teigwaren und Tagesgemüse',
    label: 'Daily',
    price: 13.5,
    studentPrice: 10.5,
  })
  assert.equal(day.menus[1].label, 'Vegi')
  assert.equal(day.menus[1].studentPrice, 9.5)
})

test('a dated day without menus is closed and keeps its note', () => {
  const html = '<mat-tab-body><div class="date x"><p>11.11.26</p></div><p>Heute geschlossen &amp; Ferien</p></mat-tab-body>'
  const { days } = parseMensaHtml(html)
  assert.equal(days.length, 1)
  assert.equal(days[0].closed, true)
  assert.equal(days[0].note, 'Heute geschlossen & Ferien')
  assert.deepEqual(days[0].menus, [])
})

test('garbage never throws', () => {
  for (const input of ['', 'garbage', '<html><body>nothing</body></html>', null, undefined, '<mat-tab-body><div class="date"><p>99.99.99</p>']) {
    assert.deepEqual(parseMensaHtml(input), { days: [] })
  }
})

const day = (date, weekday) => ({ date, weekday, closed: false, note: '', menus: [{ name: date, description: '', label: '', price: null, studentPrice: null }] })
const week = [day('2026-11-09', 'Mo'), day('2026-11-10', 'Di'), day('2026-11-13', 'Fr'), day('2026-11-16', 'Mo')]

test('pickMensaDay chooses today, the next school day after 14:00 and after the weekend', () => {
  assert.equal(pickMensaDay(week, new Date('2026-11-10T08:00:00Z'))?.date, '2026-11-10') // 09:00 Zurich
  assert.equal(pickMensaDay(week, new Date('2026-11-09T14:00:00Z'))?.date, '2026-11-10') // 15:00 Zurich Monday
  assert.equal(pickMensaDay(week, new Date('2026-11-13T14:00:00Z'))?.date, '2026-11-16') // Friday 15:00
  assert.equal(pickMensaDay(week, new Date('2026-11-14T10:00:00Z'))?.date, '2026-11-16') // Saturday
  assert.equal(pickMensaDay(week, new Date('2026-11-15T10:00:00Z'))?.date, '2026-11-16') // Sunday
  assert.equal(pickMensaDay(week, new Date('2026-11-11T08:00:00Z')), null)
  assert.equal(pickMensaDay([], new Date()), null)
})

// A fake of the two sources. `pages` feeds the HTML page in order; the API answers from the fixture
// unless `api` is false (then it fails). Every request is recorded in `calls`.
const makeFetch = (calls, pages, { api = false } = {}) => async (url, init) => {
  calls.push({ url: String(url), init })
  const text = String(url)
  if (text.includes('/api/_Combine/')) {
    if (!api) throw new Error('API down')
    const kind = text.split('/api/_Combine/')[1].split('/')[0].toLowerCase()
    return { ok: true, status: 200, text: async () => JSON.stringify(apiFixture[kind]) }
  }
  const next = pages.shift()
  if (next instanceof Error) throw next
  return { ok: true, status: 200, text: async () => next }
}
const pageCalls = (calls) => calls.filter((call) => !call.url.includes('/api/')).length
const menuCalls = (calls) => calls.filter((call) => call.url.includes('/api/_Combine/Menu/')).length

test('parses the API week fixture', () => {
  const { days } = parseMensaApi(apiFixture.menu)
  assert.equal(days.length, 10)
  assert.deepEqual(days.map((day) => day.weekday).slice(0, 5), ['Mo', 'Di', 'Mi', 'Do', 'Fr'])
  assert.equal(days[0].date, '2026-11-09')
  assert.deepEqual(days[1].menus[0], {
    name: 'Pouletgeschnetzeltes ( CH )', description: 'Zürcher Art, Teigwaren und Tagesgemüse', label: 'Daily', price: 13.5, studentPrice: 10.5,
  })
  assert.equal(days[1].menus[1].label, 'Vegi')
  assert.deepEqual(parseMensaApi({ status: 'ERROR' }), { days: [] })
  assert.deepEqual(parseMensaApi(null), { days: [] })
})

test('week data finds the next school day (Friday to Monday)', () => {
  const { days } = parseMensaApi(apiFixture.menu)
  assert.equal(pickMensaDay(days, new Date('2026-11-13T14:00:00Z'))?.date, '2026-11-16') // Friday 15:00
  assert.equal(pickMensaDay(days, new Date('2026-11-10T14:00:00Z'))?.date, '2026-11-11') // Tuesday 15:00
})

test('the query encoding matches the page', () => {
  assert.equal(mensaQuery('Unit', ['ID', 'UnitName1', 'UnitWebsite1'], [['UnitWebsite1', 'eq', 'altekanti']], 1),
    'Unit/MS0wJTJGJTJGSUQlMjZVbml0TmFtZTElMjZVbml0V2Vic2l0ZTElMkZVbml0V2Vic2l0ZTElM0RlcSUzQSU3QiU3QmFsdGVrYW50aSU3RCU3RA==')
})

test('the API is the primary source; only GETs to the allowed host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-'))
  const calls = []
  const mensa = createMensa({ fetch: makeFetch(calls, [fixture], { api: true }), now: () => new Date('2026-11-13T14:00:00Z'), root, log: () => {} })
  const body = await mensa.get()
  assert.equal(pageCalls(calls), 0)
  assert.equal(calls.length, 3) // unit, outlet, menus
  for (const call of calls) {
    assert.equal(new URL(call.url).hostname, 'clients.compass-group.ch')
    assert.equal(call.init.method, 'GET')
    assert.equal(call.init.headers['User-Agent'], 'Kanti+ menu reader (fasrv.ch)')
  }
  assert.equal(body.days.length, 10)
  assert.equal(body.day.date, '2026-11-16')
})

test('falls back to the HTML page when the API fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-'))
  const calls = []
  const mensa = createMensa({ fetch: makeFetch(calls, [fixture]), now: () => new Date('2026-11-10T07:00:00Z'), root, log: () => {} })
  const body = await mensa.get()
  assert.equal(pageCalls(calls), 1)
  assert.equal(body.days.length, 1)
  assert.equal(body.day.date, '2026-11-10')
  assert.equal(body.stale, false)
})

test('cache (page source): no refetch within the window, refetch after it, stale fallback on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-'))
  let clock = new Date('2026-11-10T05:00:00Z') // 06:00 Zurich, Tuesday
  const calls = []
  const pages = [fixture, fixture, new Error('network down')]
  const mensa = createMensa({ fetch: makeFetch(calls, pages), now: () => clock, root, log: () => {} })

  const first = await mensa.get()
  const pageCall = calls.find((call) => !call.url.includes('/api/'))
  assert.equal(pageCalls(calls), 1)
  assert.equal(pageCall.url, 'https://clients.compass-group.ch/altekanti/de/Mensa%20Alte%20Kanti')
  assert.equal(pageCall.init.method, 'GET')
  assert.equal(pageCall.init.headers['User-Agent'], 'Kanti+ menu reader (fasrv.ch)')
  assert.equal(first.stale, false)
  assert.equal(first.day.date, '2026-11-10')
  assert.equal(JSON.parse(await fs.readFile(join(root, 'mensa.json'), 'utf8')).days.length, 1)

  clock = new Date(clock.getTime() + 2 * 3_600_000)
  await Promise.all([mensa.get(), mensa.get()])
  assert.equal(pageCalls(calls), 1)

  clock = new Date(clock.getTime() + 2 * 3_600_000) // 4 h old, school hours
  await Promise.all([mensa.get(), mensa.get()])
  await mensa.idle()
  assert.equal(pageCalls(calls), 2)

  clock = new Date(clock.getTime() + 3.5 * 3_600_000) // 13:30 Zurich, failing fetch
  const stale = await mensa.get()
  await mensa.idle()
  assert.equal(pageCalls(calls), 3)
  const after = await mensa.get()
  assert.equal(pageCalls(calls), 3, 'no retry storm after a failure')
  assert.equal(after.stale, true)
  assert.equal(after.days.length, 1)
  assert.equal(typeof stale.fetchedAt, 'string')

  // A fresh instance reads the last good result from disk.
  const again = createMensa({ fetch: makeFetch([], [new Error('down')]), now: () => clock, root, log: () => {} })
  assert.equal((await again.get()).days.length, 1)
})

test('outside school hours the window is 12 hours', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-'))
  let clock = new Date('2026-11-10T17:00:00Z') // 18:00 Zurich
  const calls = []
  const mensa = createMensa({ fetch: makeFetch(calls, [fixture, fixture]), now: () => clock, root, log: () => {} })
  await mensa.get()
  clock = new Date(clock.getTime() + 5 * 3_600_000)
  await mensa.get(); await mensa.idle()
  assert.equal(pageCalls(calls), 1)
  clock = new Date(clock.getTime() + 8 * 3_600_000)
  await mensa.get(); await mensa.idle()
  assert.equal(pageCalls(calls), 2)
})

test('cache (API source): the outlet is looked up once, menus refresh by window, failure keeps the week', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-'))
  let clock = new Date('2026-11-10T05:00:00Z')
  const calls = []
  let apiUp = true
  const inner = makeFetch(calls, [fixture], { api: true })
  const fetchImpl = async (url, init) => {
    if (!apiUp) { calls.push({ url: String(url), init }); throw new Error('down') }
    return inner(url, init)
  }
  const mensa = createMensa({ fetch: fetchImpl, now: () => clock, root, log: () => {} })
  await mensa.get()
  assert.equal(calls.length, 3)
  clock = new Date(clock.getTime() + 2 * 3_600_000)
  await mensa.get()
  assert.equal(calls.length, 3)
  clock = new Date(clock.getTime() + 2 * 3_600_000)
  await mensa.get(); await mensa.idle()
  assert.equal(menuCalls(calls), 2)
  assert.equal(calls.length, 4, 'outlet id is reused')
  apiUp = false
  clock = new Date(clock.getTime() + 3.5 * 3_600_000)
  await mensa.get(); await mensa.idle()
  const after = await mensa.get()
  assert.equal(after.stale, true)
  assert.equal(after.days.length, 10)
})

test('first fetch failing gives an empty stale body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-'))
  const mensa = createMensa({ fetch: makeFetch([], [new Error('down')]), now: () => new Date('2026-11-10T07:00:00Z'), root, log: () => {} })
  assert.deepEqual(await mensa.get(), { fetchedAt: null, stale: true, day: null, days: [] })
})

test('endpoints answer with the body shape and only GET', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-'))
  const mensa = createMensa({ fetch: makeFetch([], [fixture]), now: () => new Date('2026-11-10T07:00:00Z'), root, log: () => {} })
  const run = async (method, pathname) => {
    const out = { headers: {} }
    const response = { writeHead: (status, headers) => { out.status = status; out.headers = headers }, end: (payload) => { out.payload = payload } }
    out.handled = await mensa.handle({ method }, response, new URL(pathname, 'http://localhost'))
    return out
  }
  for (const path of ['/api/v1/schulnetz/mensa', '/api/v1/kanti-web/mensa']) {
    const result = await run('GET', path)
    assert.equal(result.status, 200)
    assert.equal(result.headers['Cache-Control'], 'no-store')
    const body = JSON.parse(result.payload)
    assert.deepEqual(Object.keys(body).sort(), ['day', 'days', 'fetchedAt', 'stale'])
    assert.equal(body.day.date, '2026-11-10')
    assert.equal(body.day.menus[0].studentPrice, 10.5)
  }
  assert.equal((await run('POST', '/api/v1/kanti-web/mensa')).status, 405)
  assert.equal((await run('GET', '/api/v1/other')).handled, false)
})
