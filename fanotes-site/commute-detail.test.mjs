// Pendelstrecken: the connection detail — every stop of every leg, real times per stop, platforms
// from transport.opendata.ch, where the vehicle is, and small boards. Synthetic stops and lines.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchTransportLeg, mergeLegDetail, parseLocal, parseSearchChRoute, parseTransportRoute, slimTrip, tripPosition } from './commute-logic.mjs'
import { createCommute, DETAIL_BUDGET } from './commute.mjs'

const day = '2026-11-13'
const stop = (name, id, time, delay, extra = {}) => ({ arrival: `${day} ${time}:00`, departure: `${day} ${time}:00`, ...(delay === undefined ? {} : { dep_delay: delay }), name, stopid: id, occupancy: '12', ...extra })
/** Bus 371 Dorf → Knoten (3 stops), walk, S 29 Knoten → Schulstadt (2 stops). */
const searchAnswer = ({ busDelay = '+0', stops = null } = {}) => ({
  connections: [{
    from: 'Testdorf', departure: `${day} 07:05:00`, to: 'Schulstadt', arrival: `${day} 07:47:00`,
    legs: [
      { departure: `${day} 07:05:00`, tripid: 'T_bus_371', stopid: '9000001', name: 'Testdorf, Dorfplatz', type: 'bus', type_name: 'Bus', line: '371', '*G': 'B', '*Z': '037101', terminal: 'Knoten, Bahnhof', operator: 'PAG', dep_delay: busDelay, track: '', occupancy: '11',
        stops: stops || [stop('Testdorf, Schule', '9000011', '07:08', '+0'), stop('Mittelweiler', '9000012', '07:13', '+2'), stop('Oberried', '9000013', '07:17', undefined)],
        runningtime: 960, exit: { arrival: `${day} 07:21:00`, name: 'Knoten, Bahnhof', stopid: '9000002', arr_delay: '+1' } },
      { departure: `${day} 07:21:00`, name: 'Knoten, Bahnhof', stopid: '9000002', type: 'walk', normal_time: 240, exit: { arrival: `${day} 07:25:00`, name: 'Knoten', stopid: '9000003' } },
      { departure: `${day} 07:30:00`, tripid: 'T_s29', stopid: '9000003', name: 'Knoten', type: 'strain', type_name: 'S-Bahn', line: 'S29', '*G': 'S', '*Z': '018301', terminal: 'Endstation', operator: 'SBB', dep_delay: '+0', track: '4',
        stops: [stop('Zwischenau', '9000021', '07:36', '+0'), stop('Vorstadt', '9000022', '07:42', 'X')],
        runningtime: 1020, exit: { arrival: `${day} 07:47:00`, name: 'Schulstadt', stopid: '9000004', arr_delay: '+0', track: '7' } },
      { arrival: `${day} 07:47:00`, name: 'Schulstadt', stopid: '9000004' },
    ],
  }],
})
/** transport.opendata.ch for the S 29 leg: platforms per stop, an arrival forecast and a platform change. */
const transportAnswer = () => ({
  connections: [{ sections: [{
    journey: { category: 'S', number: '29', operator: 'SBB', to: 'Endstation', capacity1st: 1, capacity2nd: 2, passList: [
      { station: { id: '9000003', name: 'Knoten' }, arrival: null, departure: `${day}T07:30:00+0100`, platform: '4', prognosis: { platform: null, departure: `${day}T07:30:00+0100` } },
      { station: { id: '9000021', name: 'Zwischenau' }, arrival: `${day}T07:36:00+0100`, departure: `${day}T07:36:00+0100`, platform: '2', prognosis: { platform: '3', arrival: `${day}T07:38:00+0100`, departure: `${day}T07:38:00+0100` } },
      { station: { id: '9000022', name: 'Vorstadt' }, arrival: `${day}T07:42:00+0100`, departure: `${day}T07:42:00+0100`, platform: '1', prognosis: {} },
      { station: { id: '9000004', name: 'Schulstadt' }, arrival: `${day}T07:47:00+0100`, departure: null, platform: '7', prognosis: { arrival: `${day}T07:47:00+0100` } },
    ] },
    departure: { station: { id: '9000003', name: 'Knoten' }, departure: `${day}T07:30:00+0100`, delay: 0, platform: '4' },
    arrival: { station: { id: '9000004', name: 'Schulstadt' }, arrival: `${day}T07:47:00+0100`, platform: '7' },
  }] }],
})
const fakeFetch = (calls, { transport = transportAnswer, search = searchAnswer } = {}) => async (url, init = {}) => {
  calls.push(String(url))
  assert.equal(init.method || 'GET', 'GET')
  assert.ok(!String(url).includes('schulnetz'), 'commute data never goes to Schulnetz')
  const body = new URL(String(url)).hostname === 'transport.opendata.ch' ? transport() : search()
  return { ok: true, status: 200, json: async () => body }
}

test('search.ch legs carry every intermediate stop: departure delay, no real time, cancelled', () => {
  const [trip] = parseSearchChRoute(searchAnswer())
  const [bus, walk, train] = trip.legs
  assert.equal(bus.journeyId, 'T_bus_371')
  assert.deepEqual(bus.stops.map((item) => item.name), ['Testdorf, Schule', 'Mittelweiler', 'Oberried'])
  const middle = bus.stops[1]
  assert.deepEqual(middle.departure, { planned: `${day}T07:13:00+01:00`, time: `${day}T07:15:00+01:00`, delay: 2 })
  // search.ch has no arrival delay per stop: the arrival stays planned, never guessed.
  assert.deepEqual(middle.arrival, { planned: `${day}T07:13:00+01:00`, time: `${day}T07:13:00+01:00`, delay: null })
  assert.equal(middle.realtime, true)
  assert.equal(bus.stops[2].realtime, false, 'a stop without dep_delay has no real time')
  assert.equal(bus.stops[2].departure.delay, null)
  assert.deepEqual(walk.stops, [])
  assert.equal(train.stops[1].cancelled, true)
  assert.equal(train.stops[1].name, 'Vorstadt')
})

test('boards carry only the stop count', () => {
  const [trip] = parseSearchChRoute(searchAnswer())
  const slim = slimTrip(trip)
  assert.deepEqual(slim.legs.map((leg) => leg.stopCount), [3, 0, 2])
  assert.ok(slim.legs.every((leg) => !('stops' in leg)))
  assert.equal(slimTrip(null), null)
})

test('transport.opendata.ch adds platforms and arrival forecasts per stop to the same vehicle only', () => {
  const [trip] = parseSearchChRoute(searchAnswer())
  const train = trip.legs[2]
  const others = parseTransportRoute(transportAnswer())
  const match = matchTransportLeg(train, others)
  assert.ok(match, 'same boarding stop, planned departure and number')
  assert.equal(matchTransportLeg(trip.legs[0], others), null, 'the bus is another vehicle')
  const merged = mergeLegDetail(train, match)
  const zwischenau = merged.stops[0]
  assert.equal(zwischenau.platform, '3')
  assert.equal(zwischenau.platformChanged, true)
  assert.deepEqual(zwischenau.arrival, { planned: `${day}T07:36:00+01:00`, time: `${day}T07:38:00+01:00`, delay: 2 })
  // search.ch's own departure delay (0) stays; transport.opendata.ch fills only what search.ch lacks.
  assert.equal(zwischenau.departure.delay, 0)
  assert.equal(merged.stops[1].platform, '1')
  assert.equal(merged.stops[1].cancelled, true)
  assert.equal(merged.to.platform, '7')
  assert.equal(mergeLegDetail(train, null), train)
})

test('the vehicle position follows the real times stop by stop', () => {
  const [trip] = parseSearchChRoute(searchAnswer())
  const at = (clock) => tripPosition(trip, parseLocal(`${day} ${clock}:00`))
  assert.deepEqual(at('07:00'), { state: 'notStarted', legIndex: 0, point: 0, progress: 0, estimated: false })
  const moving = at('07:06:30')
  assert.equal(moving.state, 'between')
  assert.equal(moving.point, 0)
  assert.ok(moving.progress > 0.4 && moving.progress < 0.6, `progress ${moving.progress}`)
  // Mittelweiler: planned 07:13, leaves at 07:15 (+2): at the stop between 07:13 and 07:15.
  assert.equal(at('07:14').state, 'atStop')
  assert.equal(at('07:14').point, 2)
  // Oberried has no real time: still placed, marked estimated.
  assert.equal(at('07:19').state, 'between')
  assert.equal(at('07:19').point, 3)
  assert.equal(at('07:19').estimated, true)
  assert.deepEqual([at('07:27').state, at('07:27').legIndex], ['transfer', 0])
  // On the S 29 the cancelled Vorstadt is passed: between Zwischenau (1) and Schulstadt.
  const late = at('07:44')
  assert.deepEqual([late.state, late.legIndex, late.point], ['between', 2, 1])
  assert.equal(at('07:50').state, 'arrived')
})

test('the detail endpoint finds the trip again, merges platforms and reports the position', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commute-detail-'))
  const calls = []
  let clock = parseLocal(`${day} 07:14:00`)
  const commute = createCommute({ root, fetch: fakeFetch(calls), now: () => new Date(clock) })
  const accountId = 'd'.repeat(32)
  try {
    await commute.save(accountId, { routes: [{ id: 'abcdef012345', name: 'Schule', from: { id: '9000001', name: 'Testdorf, Dorfplatz', type: 'bus' }, to: { id: '9000004', name: 'Schulstadt', type: 'train' }, schedule: { mode: 'none' } }], settings: {} })
    const { boards: [board] } = await commute.board(accountId)
    const listed = board.trips[0]
    assert.deepEqual(listed.legs.map((leg) => leg.stopCount), [3, 0, 2])
    assert.ok(listed.legs.every((leg) => !leg.stops), 'the board has no stop lists')
    const detail = await commute.tripDetail(accountId, 'abcdef012345', listed.id, listed.plannedDeparture)
    assert.equal(detail.gone, false)
    assert.deepEqual(detail.trip.legs.map((leg) => leg.stops.length), [3, 0, 2])
    assert.equal(detail.trip.legs[2].stops[0].platform, '3')
    assert.deepEqual(detail.sources, { realtime: 'search.ch', platforms: 'transport.opendata.ch', formation: null })
    assert.deepEqual([detail.position.state, detail.position.point], ['atStop', 2])
    // One transport.opendata.ch lookup per ride leg; cached for 30 s.
    assert.equal(calls.filter((url) => url.startsWith('https://transport.opendata.ch/')).length, 2)
    await commute.tripDetail(accountId, 'abcdef012345', listed.id, listed.plannedDeparture)
    assert.equal(calls.filter((url) => url.startsWith('https://transport.opendata.ch/')).length, 2)
    assert.equal(commute.provider.budget().detail, 2)
    // A trip the timetable no longer has.
    assert.deepEqual(await commute.tripDetail(accountId, 'abcdef012345', 'gone|x', listed.plannedDeparture).then((answer) => [answer.trip, answer.gone]), [null, true])
    assert.equal(await commute.tripDetail(accountId, '000000000000', listed.id, listed.plannedDeparture), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('without transport.opendata.ch (down or budget spent) the detail shows search.ch data only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commute-detail-'))
  const calls = []
  const clock = parseLocal(`${day} 07:00:00`)
  const commute = createCommute({ root, fetch: fakeFetch(calls, { transport: () => { throw new Error('down') } }), now: () => new Date(clock), log: () => {} })
  const accountId = 'e'.repeat(32)
  try {
    await commute.save(accountId, { routes: [{ id: 'abcdef012345', from: { id: '9000001', name: 'Testdorf, Dorfplatz' }, to: { id: '9000004', name: 'Schulstadt' } }], settings: {} })
    const [trip] = parseSearchChRoute(searchAnswer())
    const detail = await commute.tripDetail(accountId, 'abcdef012345', trip.id, trip.plannedDeparture)
    assert.equal(detail.sources.platforms, null)
    assert.equal(detail.trip.legs[2].stops[0].platform, '')
    assert.equal(detail.trip.legs[0].stops[1].departure.delay, 2)
    assert.ok(DETAIL_BUDGET > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the app and the browser reach the detail through their APIs', async () => {
  const { createSchulnetzRuntime } = await import('./schulnetz-api.mjs')
  const { Readable } = await import('node:stream')
  const { randomBytes } = await import('node:crypto')
  const root = await mkdtemp(join(tmpdir(), 'commute-detail-api-'))
  const calls = []
  const runtime = createSchulnetzRuntime({ root, key: randomBytes(32), fetch: async () => { throw new Error('no school reads') }, commuteFetch: fakeFetch(calls), autostart: false, now: () => new Date(parseLocal(`${day} 07:00:00`)), log: () => {}, fcmSend: async () => ({ status: 200 }) })
  const call = async (guest, method, path, body) => {
    const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
    request.method = method
    request.headers = { authorization: `Bearer ${guest.token}`, 'x-kanti-guest': guest.accountId, 'content-type': 'application/json' }
    request.socket = { remoteAddress: '198.51.100.30' }
    let status = 0
    let text = ''
    await runtime.handle(request, { writeHead(code) { status = code }, end(value) { text = String(value || '') } }, new URL(`http://127.0.0.1/api/v1/schulnetz${path}`))
    return { status, json: text ? JSON.parse(text) : null }
  }
  try {
    const guest = await runtime.createGuest('203.0.113.90')
    assert.equal((await call(guest, 'PUT', '/commute', { routes: [{ id: 'abcdef012345', from: { id: '9000001', name: 'Testdorf, Dorfplatz' }, to: { id: '9000004', name: 'Schulstadt' } }], settings: {} })).status, 200)
    const [trip] = parseSearchChRoute(searchAnswer())
    const detail = await call(guest, 'GET', `/commute/trip?route=abcdef012345&trip=${encodeURIComponent(trip.id)}&at=${encodeURIComponent(trip.plannedDeparture)}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.json.trip.legs[0].stops.length, 3)
    assert.equal((await call(guest, 'GET', `/commute/trip?route=000000000000&trip=x&at=${encodeURIComponent(trip.plannedDeparture)}`)).status, 404)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
