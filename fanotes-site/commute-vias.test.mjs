// Pendelstrecken: vias exactly as entered (loop routes such as Brugg - Aarau - Lenzburg - Aarau), the
// in-order guard and the chained fallback. Synthetic search.ch answers with the shape of the real API.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hasViaLoop, parseLocal, parseSearchChRoute, passesVias, sanitizeRoutes, sanitizeVias } from './commute-logic.mjs'
import { createCommute, createCommuteProvider } from './commute.mjs'

const DAY = '2026-11-13'
const BRUGG = { id: '8500309', name: 'Brugg AG', type: 'train' }
const AARAU = { id: '8502113', name: 'Aarau', type: 'train' }
const LENZBURG = { id: '8502119', name: 'Lenzburg', type: 'train' }
const at = (clock) => `${DAY} ${clock}:00`

/** One ride leg of a search.ch answer; [stops] are the intermediate stops. */
const ride = ({ from, to, dep, arr, line, z, stops = [], normal, delay = '+0', arrDelay = '+0' }) => ({
  departure: at(dep), stopid: from.id, name: from.name, type: 'strain', type_name: 'S-Bahn', line, '*G': 'S', '*Z': z, terminal: to.name, operator: 'SBB',
  fgcolor: 'fff', bgcolor: '039', dep_delay: delay, track: '3', occupancy: '12', runningtime: 900,
  ...(normal != null ? { normal_time: normal } : {}),
  stops: stops.map((stop) => ({ name: stop.name, stopid: stop.id, arrival: at(stop.arr), departure: at(stop.arr) })),
  exit: { arrival: at(arr), name: to.name, stopid: to.id, arr_delay: arrDelay },
})
const trip = (...legs) => ({ from: legs[0].name, departure: legs[0].departure, to: legs.at(-1).exit.name, arrival: legs.at(-1).exit.arrival, legs: [...legs, { arrival: legs.at(-1).exit.arrival, name: legs.at(-1).exit.name, stopid: legs.at(-1).exit.stopid }] })
const answer = (...connections) => ({ count: connections.length, connections })

const direct = trip(ride({ from: BRUGG, to: AARAU, dep: '07:00', arr: '07:25', line: 'RE12', z: '1' }))
/** What the live planner returns for Brugg -> Aarau via Aarau, Lenzburg: RE12, S11 and IR 37 in one trip. */
const loopTrip = trip(
  ride({ from: BRUGG, to: AARAU, dep: '07:00', arr: '07:25', line: 'RE12', z: '1' }),
  ride({ from: AARAU, to: LENZBURG, dep: '07:29', arr: '07:40', line: 'S11', z: '2', normal: 240, stops: [{ id: '8502120', name: 'Hendschiken', arr: '07:36' }] }),
  ride({ from: LENZBURG, to: AARAU, dep: '07:46', arr: '07:58', line: 'IR 37', z: '3', normal: 240 }),
)
const segments = {
  '8500309>8502113': [direct, trip(ride({ from: BRUGG, to: AARAU, dep: '07:30', arr: '07:55', line: 'RE12', z: '4' }))],
  '8502113>8502119': [trip(ride({ from: AARAU, to: LENZBURG, dep: '07:29', arr: '07:40', line: 'S11', z: '2' })), trip(ride({ from: AARAU, to: LENZBURG, dep: '07:59', arr: '08:10', line: 'S11', z: '5' }))],
  '8502119>8502113': [trip(ride({ from: LENZBURG, to: AARAU, dep: '07:46', arr: '07:58', line: 'IR 37', z: '3' })), trip(ride({ from: LENZBURG, to: AARAU, dep: '08:16', arr: '08:28', line: 'IR 37', z: '6' }))],
}
const fake = (handler) => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push(new URL(String(url)))
    assert.equal(init.method || 'GET', 'GET')
    assert.ok(!String(url).includes('schulnetz'))
    return { ok: true, status: 200, json: async () => handler(new URL(String(url))) }
  }
  return { fetchImpl, calls }
}
const routeCalls = (calls) => calls.filter((url) => url.pathname.endsWith('route.json'))
/** A planner that ignores a via equal to the destination (like a direct-only answer): only the plain segments work. */
const stubborn = (url) => {
  if (url.searchParams.getAll('via[]').length) return answer(direct)
  return answer(...(segments[`${url.searchParams.get('from')}>${url.searchParams.get('to')}`] || []))
}
const loopVias = [AARAU, LENZBURG]
const clockAt = (clock) => () => new Date(parseLocal(at(clock)))

test('vias stay exactly as entered: equal to the destination, to the origin, duplicated, at most two', () => {
  const route = (vias, extra = {}) => sanitizeRoutes([{ id: 'a1b2c3d4e5f6', from: BRUGG, to: AARAU, vias, ...extra }])[0]
  assert.deepEqual(route([AARAU, LENZBURG]).vias.map((via) => via.name), ['Aarau', 'Lenzburg'], 'the Brugg / Aarau / Lenzburg loop')
  assert.deepEqual(route([AARAU]).vias.map((via) => via.id), ['8502113'], 'via equal to the destination')
  assert.deepEqual(route([BRUGG]).vias.map((via) => via.id), ['8500309'], 'via equal to the origin')
  assert.deepEqual(route([LENZBURG, LENZBURG, BRUGG]).vias.map((via) => via.name), ['Lenzburg', 'Lenzburg'], 'duplicates kept, capped at two')
  assert.deepEqual(route([{ evil: true }, LENZBURG]).vias.map((via) => via.name), ['Lenzburg'], 'only stops sanitizeStop rejects are dropped')
  assert.equal(route([AARAU, LENZBURG]).via.name, 'Aarau')
  assert.deepEqual(sanitizeVias({ via: AARAU }).map((via) => via.name), ['Aarau'])
})

test('save keeps the loop vias and an older client cannot lose them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commute-vias-'))
  const accountId = 'e'.repeat(32)
  const commute = createCommute({ root, fetch: fake(stubborn).fetchImpl, now: clockAt('06:00') })
  try {
    const body = { id: 'a1b2c3d4e5f6', name: 'Schleife', from: BRUGG, to: AARAU, vias: loopVias, via: AARAU, schedule: { mode: 'none' } }
    const saved = await commute.save(accountId, { routes: [body], settings: {} })
    assert.deepEqual(saved.routes[0].vias.map((via) => via.id), ['8502113', '8502119'])
    assert.deepEqual((await commute.view(accountId)).routes[0].vias.map((via) => via.id), ['8502113', '8502119'])
    // An old client sends the first via only: the stored second via stays.
    const old = await commute.save(accountId, { routes: [{ id: 'a1b2c3d4e5f6', name: 'Schleife', from: BRUGG, to: AARAU, via: AARAU, schedule: { mode: 'none' } }], settings: {} })
    assert.deepEqual(old.routes[0].vias.map((via) => via.id), ['8502113', '8502119'])
    // A different first via is a real change.
    const changed = await commute.save(accountId, { routes: [{ id: 'a1b2c3d4e5f6', from: BRUGG, to: AARAU, via: LENZBURG, schedule: { mode: 'none' } }], settings: {} })
    assert.deepEqual(changed.routes[0].vias.map((via) => via.id), ['8502119'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the provider passes the loop vias to search.ch in order and keeps the trip that passes them', async () => {
  const { fetchImpl, calls } = fake((url) => (url.searchParams.getAll('via[]').length ? answer(loopTrip) : answer(direct)))
  const provider = createCommuteProvider({ fetchImpl, now: clockAt('06:00') })
  const answerLoop = await provider.trips({ from: BRUGG, to: AARAU, vias: loopVias, at: parseLocal(at('06:55')) })
  assert.deepEqual(routeCalls(calls)[0].searchParams.getAll('via[]'), ['8502113', '8502119'])
  assert.equal(routeCalls(calls)[0].searchParams.get('to'), '8502113')
  assert.equal(answerLoop.trips.length, 1)
  assert.deepEqual(answerLoop.trips[0].legs.map((leg) => leg.line), ['RE12', 'S11', 'IR 37'])
  assert.equal(answerLoop.chained, undefined)
})

test('the guard keeps only trips that pass the vias in order', () => {
  const [full] = parseSearchChRoute(answer(loopTrip))
  const [plain] = parseSearchChRoute(answer(direct))
  assert.equal(passesVias(full, loopVias), true)
  assert.equal(passesVias(full, [LENZBURG, AARAU]), false, 'the final arrival is not a via visit: Aarau must be visited again before the end')
  assert.equal(passesVias(full, [AARAU, AARAU]), false)
  assert.equal(passesVias(full, [LENZBURG, { id: '', name: 'hendschiken' }]), false, 'order matters')
  assert.equal(passesVias(full, [{ id: '', name: 'HENDSCHIKEN' }, LENZBURG]), true, 'name match is case-insensitive, intermediate stops count')
  assert.equal(passesVias(plain, [AARAU]), false, 'a via equal to the destination needs a second visit')
  assert.equal(passesVias(plain, [BRUGG]), false, 'a via equal to the origin needs a return')
  assert.equal(passesVias(plain, []), true)
  assert.equal(hasViaLoop(BRUGG, AARAU, [AARAU]), true)
  assert.equal(hasViaLoop(BRUGG, AARAU, [LENZBURG, LENZBURG]), true)
  assert.equal(hasViaLoop(BRUGG, AARAU, [LENZBURG]), false)
})

test('without a loop, a trip the guard cannot verify is not thrown away', async () => {
  const { fetchImpl } = fake(() => answer(direct))
  const provider = createCommuteProvider({ fetchImpl, now: clockAt('06:00') })
  const result = await provider.trips({ from: BRUGG, to: AARAU, vias: [{ id: '8599999', name: 'Irgendwo' }], at: parseLocal(at('06:55')) })
  assert.equal(result.trips.length, 1)
})

test('chained fallback (depart): segment searches become one trip with every leg and stop', async () => {
  const { fetchImpl, calls } = fake(stubborn)
  const provider = createCommuteProvider({ fetchImpl, now: clockAt('06:00') })
  const result = await provider.trips({ from: BRUGG, to: AARAU, vias: loopVias, at: parseLocal(at('06:55')) })
  assert.equal(result.chained, true)
  const [first, second] = result.trips
  assert.deepEqual(first.legs.filter((leg) => leg.kind === 'ride').map((leg) => leg.line), ['RE12', 'S11', 'IR 37'])
  assert.deepEqual([first.departure.slice(11, 16), first.arrival.slice(11, 16), first.transfers], ['07:00', '07:58', 2])
  assert.equal(passesVias(first, loopVias), true)
  assert.equal(first.id, 'RE12|1|2026-11-13T07:00:00+01:00|2026-11-13T07:58:00+01:00')
  assert.deepEqual(first.changes.map((change) => [change.at, change.gapMinutes, change.requiredMinutes, change.requiredSource, change.broken, change.tight]), [['Aarau', 4, 4, 'default', false, false], ['Lenzburg', 6, 4, 'default', false, false]])
  assert.equal(first.pin.line, 'RE12')
  // The later RE12 reaches the next S11 and the 08:16 IR.
  assert.deepEqual(second.legs.map((leg) => leg.line), ['RE12', 'S11', 'IR 37'])
  assert.deepEqual([second.departure.slice(11, 16), second.arrival.slice(11, 16)], ['07:30', '08:28'])
  // Each segment is a route query; the answer is cached like a normal one.
  assert.deepEqual(routeCalls(calls).filter((url) => !url.searchParams.getAll('via[]').length).length, 3)
  const spent = provider.budget().route
  assert.equal(spent, 4, 'the failed loop query and three segments')
  await provider.trips({ from: BRUGG, to: AARAU, vias: loopVias, at: parseLocal(at('06:55')) })
  assert.equal(provider.budget().route, spent)
})

test('chained fallback (arrive) works backward from the last segment', async () => {
  const { fetchImpl } = fake(stubborn)
  const provider = createCommuteProvider({ fetchImpl, now: clockAt('06:00') })
  const result = await provider.trips({ from: BRUGG, to: AARAU, vias: loopVias, at: parseLocal(at('08:30')), timeType: 'arrive' })
  assert.equal(result.chained, true)
  const [best] = result.trips
  assert.deepEqual(best.legs.map((leg) => [leg.line, leg.from.planned.slice(11, 16)]), [['RE12', '07:30'], ['S11', '07:59'], ['IR 37', '08:16']])
  assert.equal(best.arrival.slice(11, 16), '08:28')
  assert.deepEqual(best.changes.map((change) => change.requiredSource), ['default', 'default'])
})

test('the provider failing on a loop route still chains; without a loop it throws', async () => {
  const failing = (url) => { if (url.searchParams.getAll('via[]').length) throw Object.assign(new Error('provider'), { status: 500 }); return stubborn(url) }
  const { fetchImpl } = fake((url) => failing(url))
  const provider = createCommuteProvider({ fetchImpl, now: clockAt('06:00') })
  assert.equal((await provider.trips({ from: BRUGG, to: AARAU, vias: loopVias, at: parseLocal(at('06:55')) })).trips.length, 2)
  const broken = createCommuteProvider({ fetchImpl: async () => { throw new Error('down') }, now: clockAt('06:00') })
  await assert.rejects(() => broken.trips({ from: BRUGG, to: AARAU, vias: [LENZBURG], at: parseLocal(at('06:55')) }))
})

test('a pinned loop route finds its pin, shows every leg and opens the connection detail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commute-vias-'))
  const accountId = 'f'.repeat(32)
  const { fetchImpl } = fake((url) => (url.hostname.includes('transport') ? { connections: [] } : stubborn(url)))
  const commute = createCommute({ root, fetch: fetchImpl, now: clockAt('06:30') })
  try {
    const pin = { days: [1, 2, 3, 4, 5], line: 'RE12', trainNo: '1', stop: 'Brugg AG', stopId: '8500309', departure: '07:00', arrival: '07:58', transfers: 2 }
    await commute.save(accountId, { routes: [{ id: 'a1b2c3d4e5f6', name: 'Schleife', from: BRUGG, to: AARAU, vias: loopVias, schedule: { mode: 'none' }, pins: [pin], notify: true }], settings: {} })
    const { boards: [board] } = await commute.board(accountId)
    assert.equal(board.pinned.status, 'ok')
    assert.deepEqual(board.pinned.trip.legs.map((leg) => leg.line), ['RE12', 'S11', 'IR 37'])
    assert.equal(board.pinned.trip.legs[0].stopCount, 0)
    const detail = await commute.tripDetail(accountId, 'a1b2c3d4e5f6', board.pinned.trip.id, board.pinned.trip.plannedDeparture)
    assert.equal(detail.gone, false)
    assert.deepEqual(detail.trip.legs.map((leg) => leg.line), ['RE12', 'S11', 'IR 37'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
