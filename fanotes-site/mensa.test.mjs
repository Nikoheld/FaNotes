import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MAX_HTML_BYTES, createMensa, mensaQuery, parseMensaApi, parseMensaHtml, pickMensaDay } from './mensa.mjs'
import { createServiceLog } from './service-log.mjs'

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

test('a 503 or a timeout is tried once more; the stored menu stays when the source stays down', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-'))
  const calls = []
  const fetchImpl = async (url) => {
    const target = String(url)
    calls.push(target)
    if (target.includes('/api/_Combine/')) {
      const status = calls.filter((item) => item.includes('/Unit/')).length === 1 ? 503 : 200
      const kind = target.split('/api/_Combine/')[1].split('/')[0].toLowerCase()
      return { ok: status === 200, status, text: async () => JSON.stringify(apiFixture[kind]) }
    }
    return { ok: true, status: 200, text: async () => fixture }
  }
  const mensa = createMensa({ fetch: fetchImpl, sleep: async () => {}, now: () => new Date('2026-11-10T07:00:00Z'), root, log: () => {} })
  const body = await mensa.get()
  assert.equal(body.days.length, 10)
  assert.equal(body.stale, false)
  assert.equal(calls.filter((item) => item.includes('/Unit/')).length, 2)

  let clock = new Date('2026-11-10T12:00:00Z')
  let timedOut = false
  const later = createMensa({
    fetch: async () => { timedOut = true; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }) },
    sleep: async () => {},
    now: () => clock,
    root,
    log: () => {},
  })
  const kept = await later.get()
  await later.idle()
  assert.equal(timedOut, true)
  assert.equal(kept.days.length, 10)
  assert.equal(kept.stale, true)
})

test('menu fetches are logged as JSON without the query or the menu text', async () => {
  const lines = []
  const jsonLog = createServiceLog('mensa', (line) => lines.push(line), () => new Date('2026-11-15T11:00:00.000Z'))
  const root = await mkdtemp(join(tmpdir(), 'mensa-log-'))
  let unitHits = 0
  const fetchImpl = async (url) => {
    const target = String(url)
    assert.equal(target.includes('schulnetz'), false)
    if (!target.includes('/api/_Combine/')) return { ok: true, status: 200, text: async () => fixture }
    const kind = target.split('/api/_Combine/')[1].split('/')[0].toLowerCase()
    if (kind === 'unit') {
      unitHits += 1
      if (unitHits === 1) return { ok: false, status: 503, text: async () => 'Pouletgeschnetzeltes secret-menu' }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(apiFixture[kind]) }
  }
  const mensa = createMensa({
    fetch: fetchImpl,
    sleep: async () => {},
    now: () => new Date('2026-11-10T07:00:00.000Z'),
    root,
    log: () => {},
    jsonLog,
  })
  const body = await mensa.get()
  assert.equal(body.days.length, 10)
  assert.equal(body.stale, false)
  const rows = lines.map((line) => JSON.parse(line))
  const unit = rows.filter((row) => row.route === 'https://clients.compass-group.ch/api/_Combine/Unit')
  assert.equal(unit.length, 2)
  assert.equal(unit[0].requestId, unit[1].requestId)
  assert.equal(unit[0].level, 'warn')
  assert.equal(unit[0].status, 503)
  assert.equal(unit[0].attempt, 1)
  assert.equal(unit[1].level, 'info')
  assert.equal(unit[1].status, 200)
  assert.equal(unit[1].method, 'GET')
  assert.ok(rows.length > 2)
  for (const line of lines) {
    assert.equal(line.includes('?'), false)
    assert.equal(line.includes('Poulet'), false)
    assert.equal(line.includes('secret-menu'), false)
    assert.equal(line.includes('='), false)
  }
})

test('a redirect is not followed and is not retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-redirect-'))
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(String(url))
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'manual')
    if (String(url).includes('/api/_Combine/')) return { ok: false, status: 302, text: async () => '' }
    return { ok: true, status: 200, text: async () => fixture }
  }
  const mensa = createMensa({
    fetch: fetchImpl,
    sleep: async () => {},
    now: () => new Date('2026-11-10T07:00:00.000Z'),
    root,
    log: () => {},
  })
  const body = await mensa.get()
  assert.equal(body.days.length, 1)
  assert.equal(body.day.date, '2026-11-10')
  assert.equal(calls.filter((url) => url.includes('/api/_Combine/')).length, 1)
  assert.equal(calls.some((url) => url.includes('example.test')), false)
})

test('a slow cache read is shared and is not replaced by an older copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-load-'))
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let reads = 0
  const stored = { fetchedAt: '2026-11-16T08:00:00.000Z', days: [{ date: '2026-11-16', weekday: 'Mo', closed: false, menus: [] }] }
  const readFile = async () => {
    reads += 1
    await gate
    return JSON.stringify(stored)
  }
  let fetches = 0
  const lines = []
  const mensa = createMensa({
    readFile,
    fetch: async () => {
      fetches += 1
      throw new Error('https://clients.compass-group.ch/secret-menu')
    },
    now: () => new Date('2026-11-16T08:00:00.000Z'),
    root,
    log: (_level, message) => lines.push(String(message)),
  })
  try {
    const first = mensa.get()
    for (let i = 0; i < 20 && reads < 1; i += 1) await new Promise((resolve) => setImmediate(resolve))
    const second = mensa.get()
    release()
    const [left, right] = await Promise.all([first, second])
    assert.equal(reads, 1)
    assert.equal(fetches, 0)
    assert.equal(left.day.date, '2026-11-16')
    assert.equal(right.day.date, '2026-11-16')
    assert.equal(left.stale, false)
    assert.equal(right.stale, false)
    assert.equal(lines.some((line) => line.includes('secret-menu')), false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

const byteStream = (payload, { onText, onCancel, reads } = {}) => {
  const parts = Array.isArray(payload) ? payload : [payload]
  let index = 0
  return {
    ok: true,
    status: 200,
    text: async () => {
      if (onText) onText()
      return ''
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= parts.length) return { done: true }
          const value = parts[index]
          index += 1
          if (reads) reads.count += 1
          return { done: false, value }
        },
        cancel: async () => { if (onCancel) onCancel() },
      }),
    },
  }
}

test('a streamed menu answer is assembled without buffering through text()', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-stream-'))
  let textCalls = 0
  const fetchImpl = async (url) => {
    const kind = String(url).split('/api/_Combine/')[1].split('/')[0].toLowerCase()
    const bytes = Buffer.from(JSON.stringify(apiFixture[kind]))
    const mid = Math.max(1, Math.floor(bytes.length / 2))
    return byteStream([bytes.subarray(0, mid), bytes.subarray(mid)], { onText: () => { textCalls += 1 } })
  }
  const mensa = createMensa({ fetch: fetchImpl, now: () => new Date('2026-11-13T14:00:00Z'), root, log: () => {} })
  try {
    const body = await mensa.get()
    assert.equal(textCalls, 0)
    assert.equal(body.days.length, 10)
    assert.equal(body.day.date, '2026-11-16')
    assert.equal(body.stale, false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('an oversized menu body is dropped after one read and is not retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-cap-'))
  let calls = 0
  let textCalls = 0
  let cancelled = 0
  const reads = { count: 0 }
  const lines = []
  const fetchImpl = async () => {
    calls += 1
    return byteStream([new Uint8Array(MAX_HTML_BYTES + 1)], {
      onText: () => { textCalls += 1 },
      onCancel: () => { cancelled += 1 },
      reads,
    })
  }
  const mensa = createMensa({
    fetch: fetchImpl,
    sleep: async () => {},
    now: () => new Date('2026-11-10T07:00:00Z'),
    root,
    log: (_level, message) => lines.push(String(message)),
  })
  try {
    const body = await mensa.get()
    assert.equal(body.days.length, 0)
    assert.equal(body.stale, true)
    assert.equal(calls, 2)
    assert.equal(textCalls, 0)
    assert.equal(reads.count, 2)
    assert.equal(cancelled, 2)
    assert.equal(lines.some((line) => line.includes('page too large')), false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('an upstream error page is cancelled and the menu still falls back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-release-'))
  let apiCalls = 0
  let textCalls = 0
  let reads = 0
  let cancelled = 0
  const lines = []
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/_Combine/')) {
      apiCalls += 1
      return {
        ok: false,
        status: 503,
        text: async () => { textCalls += 1; return 'secret-error-page' },
        body: {
          getReader: () => ({
            read: async () => { reads += 1; return { done: false, value: new Uint8Array(32) } },
            cancel: async () => { cancelled += 1 },
          }),
        },
      }
    }
    return { ok: true, status: 200, text: async () => fixture }
  }
  const mensa = createMensa({
    fetch: fetchImpl,
    sleep: async () => {},
    now: () => new Date('2026-11-10T07:00:00.000Z'),
    root,
    log: () => {},
    jsonLog: createServiceLog('mensa', (line) => lines.push(line), () => new Date('2026-11-10T07:00:00.000Z')),
  })
  try {
    const body = await mensa.get()
    assert.equal(body.days.length, 1)
    assert.equal(body.day.date, '2026-11-10')
    assert.equal(apiCalls, 2)
    assert.equal(cancelled, 2)
    assert.equal(reads, 0)
    assert.equal(textCalls, 0)
    assert.equal(lines.some((line) => line.includes('secret-error-page')), false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('an unreadable mensa cache is left unchanged and merged once it can be read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-disk-'))
  const file = join(root, 'mensa.json')
  const stored = JSON.stringify({
    fetchedAt: '2026-11-15T08:00:00.000Z',
    days: [{ date: '2026-12-01', weekday: 'Di', closed: false, note: 'kept', menus: [] }],
  })
  await fs.writeFile(file, stored, { mode: 0o600 })
  await fs.chmod(file, 0o000)
  let clock = new Date('2026-11-15T10:00:00Z')
  const calls = []
  const mensa = createMensa({ fetch: makeFetch(calls, [], { api: true }), now: () => clock, root, log: () => {} })
  try {
    const live = await mensa.get()
    await mensa.idle()
    assert.equal(live.days.length, 10)
    assert.equal((await fs.readdir(root)).some((name) => name.endsWith('.tmp')), false)
    await fs.chmod(file, 0o600)
    assert.equal(await fs.readFile(file, 'utf8'), stored)

    clock = new Date('2026-11-16T10:00:00Z')
    await mensa.get()
    await mensa.idle()
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(saved.days.some((day) => day.date === '2026-12-01' && day.note === 'kept'), true)
    assert.ok(saved.days.length > 1)
  } finally {
    await fs.chmod(file, 0o600).catch(() => undefined)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a mensa cache that is not the known shape is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-shape-'))
  const file = join(root, 'mensa.json')
  const stored = '{"version":2,"days":[{"date":"2026-12-01","note":"kept"}]}\n'
  await fs.writeFile(file, stored, { mode: 0o600 })
  const mensa = createMensa({ fetch: makeFetch([], [], { api: true }), now: () => new Date('2026-11-15T10:00:00Z'), root, log: () => {} })
  try {
    const live = await mensa.get()
    await mensa.idle()
    assert.ok(live.days.length > 0)
    assert.equal(await fs.readFile(file, 'utf8'), stored)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a mensa day that is not a day is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-day-'))
  const file = join(root, 'mensa.json')
  const mensa = createMensa({ fetch: makeFetch([], [], { api: true }), now: () => new Date('2026-11-15T10:00:00Z'), root, log: () => {} })
  try {
    for (const stored of [
      '{"fetchedAt":"2026-11-15T08:00:00.000Z","days":["kept-day"]}\n',
      '{"fetchedAt":"2026-11-15T08:00:00.000Z","days":[{"note":"kept"}]}\n',
      '{"fetchedAt":"2026-11-15T08:00:00.000Z","days":[{"date":"2026-12-01","menus":"kept"}]}\n',
      '{"fetchedAt":"2026-11-15T08:00:00.000Z","days":[{"date":"2026-12-01","menus":["kept"]}]}\n',
    ]) {
      await fs.writeFile(file, stored, { mode: 0o600 })
      const live = await mensa.get()
      await mensa.idle()
      assert.ok(live.days.length > 0)
      assert.equal(await fs.readFile(file, 'utf8'), stored)
    }
    const good = '{"fetchedAt":"2026-11-15T08:00:00.000Z","days":[{"date":"2026-12-01","menus":[{"name":"kept"}]}]}\n'
    await fs.writeFile(file, good, { mode: 0o600 })
    const fresh = createMensa({ fetch: makeFetch([], [], { api: true }), now: () => new Date('2026-11-16T10:00:00Z'), root, log: () => {} })
    await fresh.get()
    await fresh.idle()
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(saved.days.some((day) => day.date === '2026-12-01' && day.menus.some((menu) => menu.name === 'kept')), true)
    assert.ok(saved.days.length > 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a broken mensa cache can be replaced by a fresh menu', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mensa-broken-'))
  const file = join(root, 'mensa.json')
  await fs.writeFile(file, '{', { mode: 0o600 })
  const mensa = createMensa({ fetch: makeFetch([], [fixture]), now: () => new Date('2026-11-10T07:00:00Z'), root, log: () => {} })
  try {
    const body = await mensa.get()
    assert.equal(body.days.length, 1)
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).days.length, 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
