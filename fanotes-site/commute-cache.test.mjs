// Commute provider: short-lived cache, in-flight coalescing, upstream retries, and a recorded
// search.ch answer for Brugg → Aarau via Aarau, Lenzburg (a via equal to the destination).
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { hasViaLoop, parseLocal, parseSearchChRoute, passesVias } from './commute-logic.mjs'
import { ROUTE_DISK_MS, UPSTREAM_ATTEMPTS, UPSTREAM_BODY_MAX, UPSTREAM_TIMEOUT_MS, createCommuteProvider, upstreamRetryable } from './commute.mjs'
import { createServiceLog, requestIdFrom } from './service-log.mjs'

const fixture = JSON.parse(await readFile(new URL('./test-fixtures/commute-searchch-brugg-aarau-loop.json', import.meta.url), 'utf8'))
const BRUGG = { id: '8500309', name: 'Brugg AG' }
const AARAU = { id: '8502113', name: 'Aarau' }
const LENZBURG = { id: '8502119', name: 'Lenzburg' }
const ASK_AT = parseLocal('2026-11-16 07:00:00')
const query = { from: BRUGG, to: AARAU, vias: [AARAU, LENZBURG], at: ASK_AT, timeType: 'depart' }

const ok = (body) => ({ ok: true, status: 200, json: async () => body })

test('the recorded search.ch loop keeps a via equal to the destination', () => {
  assert.equal(fixture.request, 'route')
  assert.match(fixture.description, /via Aarau und Lenzburg/u)
  const trips = parseSearchChRoute(fixture)
  assert.equal(trips.length, 3)
  const [first] = trips
  assert.deepEqual(first.legs.filter((leg) => leg.kind === 'ride').map((leg) => leg.line), ['IR 16', 'RE37', 'S11'])
  assert.equal(passesVias(first, [AARAU, LENZBURG]), true)
  assert.equal(passesVias(first, [AARAU]), true, 'Aarau is visited again before the final arrival')
  assert.equal(hasViaLoop(BRUGG, AARAU, [AARAU, LENZBURG]), true)
  assert.equal(upstreamRetryable(Object.assign(new Error('provider'), { status: 503 })), true)
  assert.equal(upstreamRetryable(Object.assign(new Error('provider'), { status: 400 })), false)
  assert.equal(upstreamRetryable(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), true)
})

test('identical connection queries share one in-flight request and then the 30 s cache', async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fetchImpl = async (url, init) => {
    calls += 1
    assert.equal(init.method, 'GET')
    assert.equal(init.signal.aborted, false)
    assert.ok(!String(url).includes('schulnetz'))
    await gate
    return ok(fixture)
  }
  let clock = ASK_AT
  const provider = createCommuteProvider({ fetchImpl, now: () => new Date(clock), sleep: async () => {} })
  const first = provider.trips(query)
  const second = provider.trips(query)
  for (let step = 0; step < 8 && calls < 1; step += 1) await Promise.resolve()
  assert.equal(calls, 1, 'the second caller joins the request that is already running')
  release()
  const [left, right] = await Promise.all([first, second])
  assert.equal(left.trips.length, 3)
  assert.equal(right.trips[0].departure, left.trips[0].departure)
  assert.equal(calls, 1)
  assert.equal(provider.budget().route, 1)
  await provider.trips(query)
  assert.equal(calls, 1, 'a repeat inside 30 s is served from the cache')
  clock += 31_000
  await provider.trips(query)
  assert.equal(calls, 2, 'after the TTL the same question is asked again')
  assert.equal(provider.budget().route, 2)
})

test('a via equal to the origin is still sent, and the recorded loop vias stay in order', async () => {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(new URL(String(url)))
    return ok(fixture)
  }
  const provider = createCommuteProvider({ fetchImpl, now: () => new Date(ASK_AT), sleep: async () => {} })
  await provider.trips({ from: BRUGG, to: AARAU, vias: [BRUGG], at: ASK_AT })
  const originQuery = seen.find((url) => url.pathname.endsWith('/route.json'))
  assert.deepEqual(originQuery.searchParams.getAll('via[]'), ['8500309'], 'a via equal to the origin is still sent')
  const loop = createCommuteProvider({ fetchImpl, now: () => new Date(ASK_AT), sleep: async () => {} })
  const board = await loop.trips(query)
  const loopQuery = seen.filter((url) => url.pathname.endsWith('/route.json')).at(-1)
  assert.deepEqual(loopQuery.searchParams.getAll('via[]'), ['8502113', '8502119'])
  assert.equal(board.trips.filter((trip) => passesVias(trip, [AARAU, LENZBURG])).length, 3)
})

test('timeouts and 5xx are retried; a 400 is not', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    const host = new URL(String(url)).hostname
    calls.push(host)
    if (host !== 'timetable.search.ch') return ok({ connections: [] })
    if (calls.filter((item) => item === host).length === 1) {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    }
    return ok(fixture)
  }
  const provider = createCommuteProvider({ fetchImpl, now: () => new Date(ASK_AT), sleep: async () => {} })
  const answer = await provider.trips(query)
  assert.equal(answer.trips[0].legs[0].line, 'IR 16')
  assert.deepEqual(calls, ['timetable.search.ch', 'timetable.search.ch'])
  assert.equal(provider.budget().route, 1, 'retries do not spend the daily budget again')

  const statuses = []
  const failing = async (url) => {
    const parsed = new URL(String(url))
    statuses.push(parsed.hostname === 'timetable.search.ch' ? 503 : 200)
    if (parsed.hostname === 'timetable.search.ch') {
      return { ok: false, status: 503, json: async () => ({}) }
    }
    return ok({ connections: [] })
  }
  const down = createCommuteProvider({ fetchImpl: failing, now: () => new Date(ASK_AT), sleep: async () => {} })
  const fallback = await down.trips({ from: BRUGG, to: AARAU, at: ASK_AT })
  assert.equal(fallback.provider, 'transport.opendata.ch')
  assert.equal(fallback.trips.length, 0)
  assert.equal(statuses.filter((status) => status === 503).length, UPSTREAM_ATTEMPTS)

  const client = []
  const bad = createCommuteProvider({
    fetchImpl: async (url) => {
      const host = new URL(String(url)).hostname
      client.push(host)
      if (host === 'timetable.search.ch') return { ok: false, status: 400, json: async () => ({}) }
      return ok({ connections: [] })
    },
    now: () => new Date(ASK_AT),
    sleep: async () => {},
  })
  const empty = await bad.trips({ from: BRUGG, to: AARAU, at: ASK_AT })
  assert.deepEqual(empty.trips, [])
  assert.deepEqual(client, ['timetable.search.ch', 'transport.opendata.ch'])
  assert.equal(UPSTREAM_TIMEOUT_MS, 12_000)
})

test('a restart serves the last stored timetable when the source is down', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commute-disk-'))
  const routeFile = join(root, 'commute-routes.json')
  let up = true
  const fetchImpl = async () => {
    if (!up) throw Object.assign(new Error('down'), { name: 'TimeoutError' })
    return ok(fixture)
  }
  try {
    const first = createCommuteProvider({ fetchImpl, now: () => new Date(ASK_AT), sleep: async () => {}, routeFile, log: () => {} })
    const answer = await first.trips(query)
    assert.equal(answer.stale, undefined)
    assert.equal(answer.trips[0].legs[0].line, 'IR 16')
    const stored = JSON.parse(await readFile(routeFile, 'utf8'))
    assert.equal(stored.version, 1)
    assert.equal(stored.entries.length, 1)
    assert.equal(stored.entries[0].key.startsWith('route:'), true)
    assert.equal(JSON.stringify(stored).includes('?'), false)
    const mode = (await stat(routeFile)).mode & 0o777
    assert.equal(mode, 0o600)

    up = false
    const restarted = createCommuteProvider({ fetchImpl, now: () => new Date(ASK_AT + 60_000), sleep: async () => {}, routeFile, log: () => {} })
    const stale = await restarted.trips(query)
    assert.equal(stale.stale, true)
    assert.equal(stale.trips[0].legs[0].line, 'IR 16')
    assert.equal(stale.trips.length, answer.trips.length)

    const expired = createCommuteProvider({
      fetchImpl,
      now: () => new Date(ASK_AT + ROUTE_DISK_MS + 60_000),
      sleep: async () => {},
      routeFile,
      log: () => {},
    })
    await assert.rejects(() => expired.trips(query))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('two timetables saved together both stay on disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commute-disk-pair-'))
  const routeFile = join(root, 'commute-routes.json')
  let waiting = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fetchImpl = async () => {
    waiting += 1
    if (waiting >= 2) release()
    await gate
    return ok(fixture)
  }
  try {
    const provider = createCommuteProvider({ fetchImpl, now: () => new Date(ASK_AT), sleep: async () => {}, routeFile, log: () => {} })
    const second = { from: BRUGG, to: LENZBURG, vias: [], at: ASK_AT, timeType: 'depart' }
    const [left, right] = await Promise.all([provider.trips(query), provider.trips(second)])
    assert.ok(left.trips.length > 0)
    assert.ok(right.trips.length > 0)
    const stored = JSON.parse(await readFile(routeFile, 'utf8'))
    assert.equal(stored.entries.length, 2)
    const restarted = createCommuteProvider({
      fetchImpl: async () => { throw Object.assign(new Error('down'), { name: 'TimeoutError' }) },
      now: () => new Date(ASK_AT + 60_000),
      sleep: async () => {},
      routeFile,
      log: () => {},
    })
    const again = await Promise.all([restarted.trips(query), restarted.trips(second)])
    assert.equal(again[0].stale, true)
    assert.equal(again[1].stale, true)
    assert.equal(again[0].trips[0].legs[0].line, 'IR 16')
    assert.equal(again[1].trips[0].legs[0].line, 'IR 16')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parallel route queries add up in the daily budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commute-budget-'))
  const budgetFile = join(root, 'commute-budget.json')
  await writeFile(budgetFile, JSON.stringify({ day: '2026-11-16', route: 10, completion: 0, fallback: 0, detail: 0 }))
  let waiting = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fetchImpl = async () => {
    waiting += 1
    if (waiting >= 2) release()
    await gate
    return ok(fixture)
  }
  try {
    const provider = createCommuteProvider({ fetchImpl, now: () => new Date(ASK_AT), sleep: async () => {}, budgetFile, log: () => {} })
    const second = { from: BRUGG, to: LENZBURG, vias: [], at: ASK_AT, timeType: 'depart' }
    await Promise.all([provider.trips(query), provider.trips(second)])
    assert.equal(provider.budget().route, 12)
    const stored = JSON.parse(await readFile(budgetFile, 'utf8'))
    assert.equal(stored.day, '2026-11-16')
    assert.equal(stored.route, 12)
    assert.equal((await stat(budgetFile)).mode & 0o777, 0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an unreadable commute file keeps its previous contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commute-unreadable-'))
  const budgetFile = join(root, 'commute-budget.json')
  const routeFile = join(root, 'commute-routes.json')
  const budgetText = JSON.stringify({ day: '2026-11-16', route: 10, completion: 0, fallback: 0, detail: 0 })
  const routeText = JSON.stringify({ version: 1, entries: [{ key: 'route:keep', at: ASK_AT, value: { trips: [{ id: 'kept' }] } }] })
  await writeFile(budgetFile, budgetText, { mode: 0o600 })
  await writeFile(routeFile, routeText, { mode: 0o600 })
  await chmod(budgetFile, 0o000)
  await chmod(routeFile, 0o000)
  const fetchImpl = async () => ok(fixture)
  try {
    const provider = createCommuteProvider({ fetchImpl, now: () => new Date(ASK_AT), sleep: async () => {}, budgetFile, routeFile, log: () => {} })
    await assert.rejects(() => provider.trips(query), (error) => error?.code === 'EACCES')
    assert.equal((await readdir(root)).some((name) => name.endsWith('.tmp')), false)
    await chmod(budgetFile, 0o600)
    await chmod(routeFile, 0o600)
    assert.equal(await readFile(budgetFile, 'utf8'), budgetText)
    assert.equal(await readFile(routeFile, 'utf8'), routeText)
    const again = createCommuteProvider({ fetchImpl, now: () => new Date(ASK_AT), sleep: async () => {}, budgetFile, routeFile, log: () => {} })
    const answer = await again.trips(query)
    assert.ok(answer.trips.length > 0)
    assert.equal(JSON.parse(await readFile(budgetFile, 'utf8')).route, 11)
    const stored = JSON.parse(await readFile(routeFile, 'utf8'))
    assert.equal(stored.entries.some((entry) => entry.key === 'route:keep'), true)
    assert.equal(stored.entries.length, 2)
  } finally {
    await chmod(budgetFile, 0o600).catch(() => undefined)
    await chmod(routeFile, 0o600).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test('a commute timetable file that is not the known shape is left in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commute-shape-'))
  const routeFile = join(root, 'commute-routes.json')
  const routeText = '{"version":2,"entries":[{"key":"route:keep","at":1,"value":{"trips":[{"id":"kept"}]}}]}\n'
  await writeFile(routeFile, routeText, { mode: 0o600 })
  const fetchImpl = async () => ok(fixture)
  try {
    const provider = createCommuteProvider({ fetchImpl, now: () => new Date(ASK_AT), sleep: async () => {}, routeFile, log: () => {} })
    const answer = await provider.trips(query)
    assert.ok(answer.trips.length > 0)
    assert.equal(await readFile(routeFile, 'utf8'), routeText)
    assert.equal((await readdir(root)).some((name) => name.endsWith('.tmp')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('timetable requests are logged as JSON without the query, a token, or a cookie', async () => {
  assert.equal(requestIdFrom('req-1234.ok'), 'req-1234.ok')
  const generated = requestIdFrom('short')
  assert.match(generated, /^[a-f0-9]{16}$/u)
  assert.notEqual(generated, 'short')

  const lines = []
  const log = createServiceLog('commute', (line) => lines.push(line), () => new Date('2026-11-15T11:00:00.000Z'))
  log.info({
    requestId: 'req-1234.ok', method: 'GET', route: 'https://timetable.search.ch/api/route.json', status: 200,
    authorization: 'Bearer secret', cookie: 'session=secret', token: 'secret', body: { password: 'secret' },
  })
  const scrubbed = JSON.parse(lines[0])
  assert.equal(scrubbed.time, '2026-11-15T11:00:00.000Z')
  assert.equal(scrubbed.service, 'commute')
  assert.equal(scrubbed.status, 200)
  assert.equal(scrubbed.authorization, undefined)
  assert.equal(scrubbed.cookie, undefined)
  assert.equal(scrubbed.token, undefined)
  assert.equal(scrubbed.body, undefined)
  assert.equal(JSON.stringify(scrubbed).includes('secret'), false)

  lines.length = 0
  const provider = createCommuteProvider({
    jsonLog: log,
    sleep: async () => {},
    now: () => new Date(ASK_AT),
    fetchImpl: async () => ok({ connections: [] }),
  })
  await provider.trips({ from: BRUGG, to: AARAU, at: ASK_AT })
  assert.ok(lines.length >= 1)
  for (const line of lines) {
    const row = JSON.parse(line)
    assert.equal(row.method, 'GET')
    assert.equal(row.route.includes('?'), false)
    assert.equal(row.route.includes('8500309'), false)
    assert.equal(row.route.includes('Brugg'), false)
    assert.match(row.requestId, /^[A-Za-z0-9._-]{8,64}$/u)
  }
})

const byteStream = (chunks, counters) => ({
  ok: true,
  status: 200,
  text: async () => { counters.text += 1; return '' },
  json: async () => { counters.json += 1; return {} },
  body: {
    getReader: () => ({
      read: async () => {
        if (!chunks.length) return { done: true }
        counters.reads += 1
        return { done: false, value: chunks.shift() }
      },
      cancel: async () => { counters.cancelled += 1 },
    }),
  },
})

test('a streamed stop list is parsed, and an oversized body is not retried', async () => {
  const payload = Buffer.from(JSON.stringify([{ id: '8500309', label: 'Brügg AG', iconclass: 'sl-icon-type-train' }]))
  const split = payload.indexOf(0xc3)
  assert.ok(split > 0)
  const counters = { text: 0, json: 0, reads: 0, cancelled: 0 }
  const fetchImpl = async (url) => {
    assert.equal(new URL(String(url)).hostname, 'timetable.search.ch')
    return byteStream([payload.subarray(0, split + 1), payload.subarray(split + 1)], counters)
  }
  const provider = createCommuteProvider({ fetchImpl, now: () => new Date(ASK_AT), sleep: async () => {} })
  const found = await provider.stops('Brugg')
  assert.equal(found.stops[0].name, 'Brügg AG')
  assert.equal(counters.text, 0)
  assert.equal(counters.json, 0)
  assert.equal(counters.reads, 2)
  assert.equal(counters.cancelled, 0)

  const hosts = []
  const huge = { text: 0, json: 0, reads: 0, cancelled: 0 }
  const lines = []
  const log = createServiceLog('commute', (line) => lines.push(line), () => new Date('2026-11-15T11:00:00.000Z'))
  const oversized = createCommuteProvider({
    jsonLog: log,
    sleep: async () => {},
    now: () => new Date(ASK_AT),
    fetchImpl: async (url) => {
      const host = new URL(String(url)).hostname
      hosts.push(host)
      if (host === 'timetable.search.ch') return byteStream([new Uint8Array(UPSTREAM_BODY_MAX + 1)], huge)
      return ok({ stations: [{ id: '8500309', name: 'Brugg AG' }] })
    },
  })
  const answer = await oversized.stops('Brugg')
  assert.equal(answer.stops[0].name, 'Brugg AG')
  assert.deepEqual(hosts, ['timetable.search.ch', 'transport.opendata.ch'])
  assert.equal(huge.text, 0)
  assert.equal(huge.json, 0)
  assert.equal(huge.reads, 1)
  assert.equal(huge.cancelled, 1)
  assert.equal(upstreamRetryable(new Error('page too large')), false)
  const searchRows = lines.map((line) => JSON.parse(line)).filter((row) => row.route.endsWith('/completion.json'))
  assert.equal(searchRows.length, 1)
  assert.equal(searchRows[0].error, 'Error')
  assert.equal(lines.some((line) => line.includes('page too large')), false)
})

test('an upstream error page is cancelled and is not parsed', async () => {
  const hosts = []
  const errors = { text: 0, json: 0, reads: 0, cancelled: 0 }
  const lines = []
  const log = createServiceLog('commute', (line) => lines.push(line), () => new Date('2026-11-15T11:00:00.000Z'))
  const fetchImpl = async (url) => {
    const host = new URL(String(url)).hostname
    hosts.push(host)
    if (host !== 'timetable.search.ch') return ok({ stations: [{ id: '8500309', name: 'Brugg AG' }] })
    return {
      ok: false,
      status: 503,
      text: async () => { errors.text += 1; return 'secret-error-page' },
      json: async () => { errors.json += 1; return {} },
      body: {
        getReader: () => ({
          read: async () => { errors.reads += 1; return { done: false, value: new Uint8Array(32) } },
          cancel: async () => { errors.cancelled += 1 },
        }),
      },
    }
  }
  const provider = createCommuteProvider({ fetchImpl, jsonLog: log, now: () => new Date(ASK_AT), sleep: async () => {} })
  const answer = await provider.stops('Brugg')
  assert.equal(answer.stops[0].name, 'Brugg AG')
  assert.equal(hosts.filter((host) => host === 'timetable.search.ch').length, UPSTREAM_ATTEMPTS)
  assert.equal(errors.cancelled, UPSTREAM_ATTEMPTS)
  assert.equal(errors.reads, 0)
  assert.equal(errors.text, 0)
  assert.equal(errors.json, 0)
  assert.equal(lines.some((line) => line.includes('secret-error-page')), false)
})
