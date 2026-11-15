// Commute provider: short-lived cache, in-flight coalescing, upstream retries, and a recorded
// search.ch answer for Brugg → Aarau via Aarau, Lenzburg (a via equal to the destination).
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'
import { hasViaLoop, parseLocal, parseSearchChRoute, passesVias } from './commute-logic.mjs'
import { UPSTREAM_ATTEMPTS, UPSTREAM_TIMEOUT_MS, createCommuteProvider, upstreamRetryable } from './commute.mjs'

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
