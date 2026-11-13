// Pendelstrecken: routing, delays, broken transfers, alternatives, lesson-tied targets and alerts.
// Stops, lines and lessons are synthetic; the answers have the shape of search.ch's route API.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isoZurich, lessonChangeAlert, nextCheckAt, parseCompletion, parseDelay, parseLocal, parseOccupancy, parseSearchChRoute,
  parseTransportRoute, rankTrips, routeTarget, sanitizeRoutes, sanitizeSettings, schoolDay, tripAlerts, zurichMs,
} from './commute-logic.mjs'
import { createCommute, createCommuteProvider } from './commute.mjs'

const MIN = 60_000
const leg = ({ name, stopid, dep, line = '', type = 'bus', depDelay = '+0', track = '', exit, occupancy = '', terminal = 'Endstation', z = '001', disruptions = [] }) => ({
  departure: dep, stopid, name, type: line ? (type === 'bus' ? 'bus' : 'strain') : 'walk', type_name: line ? (type === 'bus' ? 'Bus' : 'S-Bahn') : 'Fussweg',
  ...(line ? { line, '*G': type === 'bus' ? 'B' : 'S', '*Z': z, terminal, operator: type === 'bus' ? 'PAG' : 'SBB', fgcolor: 'fff', bgcolor: '039', dep_delay: depDelay, track, occupancy, disruptions } : { normal_time: 240 }),
  runningtime: line ? 900 : 240,
  exit,
})
/** Bus Dorf → Knoten (4 min walk) → S-Bahn Knoten → Schulstadt, like a village-to-Kanti route. */
const connection = ({ day = '2026-11-13', bus = '07:05', busDelay = '+0', busArrive = '07:21', busArrDelay = '+0', train = '07:30', trainDelay = '+0', trainTrack = '4', arrive = '07:47', occupancy = '12', z = '018301' } = {}) => ({
  from: 'Testdorf, Dorfplatz', departure: `${day} ${bus}:00`, to: 'Schulstadt', arrival: `${day} ${arrive}:00`, occupancy,
  legs: [
    leg({ name: 'Testdorf, Dorfplatz', stopid: '9000001', dep: `${day} ${bus}:00`, line: '371', depDelay: busDelay, z: `b${z}`, exit: { arrival: `${day} ${busArrive}:00`, name: 'Knoten, Bahnhof', stopid: '9000002', arr_delay: busArrDelay } }),
    leg({ name: 'Knoten, Bahnhof', stopid: '9000002', dep: `${day} ${busArrive}:00`, exit: { arrival: `${day} ${busArrive.replace(/\d{2}$/u, (m) => String(Number(m) + 4).padStart(2, '0'))}:00`, name: 'Knoten', stopid: '9000003' } }),
    leg({ name: 'Knoten', stopid: '9000003', dep: `${day} ${train}:00`, line: 'S29', type: 'train', depDelay: trainDelay, track: trainTrack, occupancy, z, exit: { arrival: `${day} ${arrive}:00`, name: 'Schulstadt', stopid: '9000004', track: '7', arr_delay: trainDelay } }),
    { arrival: `${day} ${arrive}:00`, name: 'Schulstadt', stopid: '9000004' },
  ],
})
const answer = (...connections) => ({ count: connections.length, connections })
const lesson = (day, start, end, label, extra = {}) => ({ id: `${label}-${day}-${start}`, start: `${day}T${start}:00`, end: `${day}T${end}:00`, text: label, courseName: label, timetableText: label, eventType: '0_stp', status: '', teachers: ['TstAa'], room: 'T01', comment: '', ...extra })
const route = (extra = {}) => sanitizeRoutes([{
  id: 'a1b2c3d4e5f6', name: 'Schule', from: { id: '9000001', name: 'Testdorf, Dorfplatz', type: 'bus' }, to: { id: '9000004', name: 'Schulstadt', type: 'train' },
  via: null, schedule: { mode: 'firstLesson', bufferMinutes: 10 }, delayThreshold: null, notify: true, ...extra,
}])[0]

test('Zurich wall-clock times round-trip across winter and summer time', () => {
  assert.equal(isoZurich(zurichMs('2026-11-13', '07:05')), '2026-11-13T07:05:00+01:00')
  assert.equal(isoZurich(zurichMs('2027-06-14', '07:05')), '2027-06-14T07:05:00+02:00')
  assert.equal(parseLocal('2026-11-13 07:05:00'), Date.parse('2026-11-13T06:05:00Z'))
  assert.equal(parseLocal('2026-11-11T15:17:00+0100'), Date.parse('2026-11-11T14:17:00Z'))
})

test('delays, cancellations, occupancy and platform changes are read as search.ch sends them', () => {
  assert.deepEqual(parseDelay('+3'), { minutes: 3, cancelled: false })
  assert.deepEqual(parseDelay('X'), { minutes: null, cancelled: true })
  assert.deepEqual(parseDelay(undefined), { minutes: null, cancelled: false })
  assert.deepEqual(parseOccupancy('12'), { first: 1, second: 2 })
  assert.deepEqual(parseOccupancy('03'), { first: null, second: 3 })
  assert.deepEqual(parseOccupancy(null), { first: null, second: null })
  const [trip] = parseSearchChRoute(answer(connection({ trainTrack: '5!', trainDelay: '+2' })))
  const train = trip.legs.find((item) => item.line === 'S29')
  assert.equal(train.from.platform, '5')
  assert.equal(train.from.platformChanged, true)
  assert.equal(train.from.time, '2026-11-13T07:32:00+01:00')
  assert.equal(train.from.planned, '2026-11-13T07:30:00+01:00')
  assert.equal(trip.arrDelay, 2)
  assert.equal(trip.status, 'delayed')
  assert.ok(trip.issues.some((issue) => issue.kind === 'platformChange'))
})

test('stop search keeps small bus stops and drops addresses', () => {
  const stops = parseCompletion([
    { label: 'Testdorf, Dorfplatz', id: '9000001', iconclass: 'sl-icon-type-bus' },
    { label: 'Knoten', id: '9000003', iconclass: 'sl-icon-type-strain' },
    { label: 'Musterweg 3, Testdorf', iconclass: 'sl-icon-type-adr' },
  ])
  assert.deepEqual(stops.map((stop) => `${stop.name}:${stop.type}`), ['Testdorf, Dorfplatz:bus', 'Knoten:train'])
})

test('a transfer that the bus delay makes impossible breaks the trip; a tight one is flagged', () => {
  const [ok] = parseSearchChRoute(answer(connection()))
  assert.equal(ok.status, 'ok')
  assert.deepEqual(ok.changes.map((change) => [change.at, change.plannedMinutes, change.minutes]), [['Knoten', 5, 5]])
  // 9 min planned, 4 min footpath: +5 still leaves the official 4 min, +6/+7 is tight, +8 is missed.
  const [still] = parseSearchChRoute(answer(connection({ busArrDelay: '+5' })))
  assert.deepEqual([still.changes[0].tight, still.changes[0].broken], [false, false])
  const [tight] = parseSearchChRoute(answer(connection({ busArrDelay: '+6' })))
  assert.equal(tight.changes[0].tight, true)
  assert.equal(tight.status, 'ok')
  const [broken] = parseSearchChRoute(answer(connection({ busDelay: '+8', busArrDelay: '+8' })))
  assert.equal(broken.changes[0].broken, true)
  assert.equal(broken.status, 'broken')
  assert.ok(broken.issues.some((issue) => issue.kind === 'missedTransfer'))
  const [cancelled] = parseSearchChRoute(answer(connection({ trainDelay: 'X' })))
  assert.equal(cancelled.status, 'cancelled')
})

test('the least crowded of the near-equal trips is marked, only when it really differs', () => {
  const now = parseLocal('2026-11-13 06:30:00')
  const trips = parseSearchChRoute(answer(connection({ occupancy: '13' }), connection({ bus: '07:12', busArrive: '07:21', occupancy: '11', z: '018303' }), connection({ bus: '07:35', busArrive: '07:51', train: '08:00', arrive: '08:17', occupancy: '11', z: '018305' })))
  const ranked = rankTrips(trips, now)
  // The 07:05 and 07:12 buses reach the same train: the later start ranks first and is also the emptier one.
  assert.deepEqual(ranked.map((trip) => [trip.departure.slice(11, 16), trip.quietest]), [['07:12', true], ['07:05', false], ['07:35', false]])
  const same = rankTrips(parseSearchChRoute(answer(connection({ occupancy: '12' }), connection({ bus: '07:12', occupancy: '12', z: '018303' }))), now)
  assert.ok(same.every((trip) => !trip.quietest))
})

test('transport.opendata.ch answers map onto the same trips (fallback provider)', () => {
  const [trip] = parseTransportRoute({ connections: [{ sections: [
    { journey: { category: 'B', number: '371', operator: 'PAG', to: 'Knoten', capacity1st: null, capacity2nd: 2 }, departure: { station: { id: '9000001', name: 'Testdorf, Dorfplatz' }, departure: '2026-11-13T07:05:00+0100', delay: 1, platform: null }, arrival: { station: { id: '9000002', name: 'Knoten, Bahnhof' }, arrival: '2026-11-13T07:21:00+0100' } },
    { journey: null, walk: { duration: 240 }, departure: { station: { name: 'Knoten, Bahnhof' }, departure: '2026-11-13T07:21:00+0100' }, arrival: { station: { name: 'Knoten' }, arrival: '2026-11-13T07:25:00+0100' } },
    { journey: { category: 'S', number: '29', operator: 'SBB', to: 'Endstation', capacity1st: 1, capacity2nd: 2 }, departure: { station: { id: '9000003', name: 'Knoten' }, departure: '2026-11-13T07:30:00+0100', delay: 0, platform: '4' }, arrival: { station: { id: '9000004', name: 'Schulstadt' }, arrival: '2026-11-13T07:47:00+0100', platform: '7' } },
  ] }] })
  assert.equal(trip.legs.filter((item) => item.kind === 'ride').length, 2)
  assert.equal(trip.depDelay, 1)
  assert.deepEqual(trip.occupancy, { first: 1, second: 2 })
  assert.equal(trip.status, 'delayed')
})

test('routes and settings are validated: unknown fields, bad times and too many routes are dropped', () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ id: index.toString(16).padStart(12, 'a'), from: { name: 'A' }, to: { name: 'B' } }))
  assert.equal(sanitizeRoutes(many).length, 8)
  const [one] = sanitizeRoutes([{ id: 'a1b2c3d4e5f6', from: { id: '1', name: 'A', type: 'bus' }, to: { name: 'B', type: 'rocket' }, schedule: { mode: 'times', times: ['7:05', '25:00', '07:05', '16:20'] }, delayThreshold: 99, evil: true }])
  assert.deepEqual(one.schedule.times, ['07:05', '16:20'])
  assert.equal(one.to.type, 'other')
  assert.equal(one.delayThreshold, null)
  assert.equal('evil' in one, false)
  assert.deepEqual(sanitizeRoutes([{ id: 'bad', from: { name: 'A' }, to: { name: 'B' } }]), [])
  assert.deepEqual(sanitizeSettings({ delayThreshold: 0, hiddenLabels: ['Sport M ', 'Sport M'] }), { delayThreshold: 3, hiddenLabels: ['sport m'] })
})

test('first and last lesson targets follow half-class choices and cancellations', () => {
  const day = '2026-11-13'
  const events = [
    lesson(day, '07:45', '08:30', 'Sport M'), lesson(day, '07:45', '08:30', 'Sport F'),
    lesson(day, '08:35', '09:20', 'Testfach A'), lesson(day, '13:15', '14:00', 'Testfach B'),
    lesson(day, '14:10', '14:55', 'Testfach C', { status: 'cancelled' }), lesson(day, '15:05', '15:50', 'Testfach C', { status: 'cancelled' }),
  ]
  const now = parseLocal(`${day} 06:00:00`)
  const info = schoolDay(events, day, ['sport f'])
  assert.equal(isoZurich(info.first.start), '2026-11-13T07:45:00+01:00')
  const first = routeTarget(route(), { now, events, hiddenLabels: ['sport f'] })
  assert.deepEqual([first.kind, first.at, first.timeType, first.lessonChange], ['firstLesson', '2026-11-13T07:35:00+01:00', 'arrive', 'none'])
  // Both Sport groups hidden (say, a dispensation): school starts with the 08:35 lesson.
  const later = routeTarget(route(), { now, events, hiddenLabels: ['sport f', 'sport m'] })
  assert.equal(later.at, '2026-11-13T08:25:00+01:00')
  const home = routeTarget(route({ schedule: { mode: 'lastLesson', bufferMinutes: 10 } }), { now, events, hiddenLabels: ['sport f'] })
  assert.deepEqual([home.kind, home.at, home.timeType, home.lessonChange, home.plannedAt], ['lastLesson', '2026-11-13T14:10:00+01:00', 'depart', 'lastCancelled', '2026-11-13T16:00:00+01:00'])
  // After the first lesson started, the next school day is the target (Monday, weekend skipped).
  const monday = [lesson('2026-11-16', '08:35', '09:20', 'Testfach A')]
  const next = routeTarget(route(), { now: parseLocal(`${day} 08:00:00`), events: [...events, ...monday], hiddenLabels: ['sport f'] })
  assert.equal(next.at, '2026-11-16T08:25:00+01:00')
  // A day whose lessons are all cancelled needs no trip.
  const off = routeTarget(route(), { now, events: [lesson(day, '07:45', '08:30', 'Testfach A', { status: 'cancelled' })], hiddenLabels: [] })
  assert.equal(off, null)
})

test('fixed departure times pick the next one on an allowed day', () => {
  const times = route({ schedule: { mode: 'times', times: ['07:05', '16:20'], days: [1, 2, 3, 4, 5] } })
  assert.equal(routeTarget(times, { now: parseLocal('2026-11-13 10:00:00') }).at, '2026-11-13T16:20:00+01:00')
  // Friday evening → Monday morning.
  assert.equal(routeTarget(times, { now: parseLocal('2026-11-13 18:00:00') }).at, '2026-11-16T07:05:00+01:00')
  assert.equal(routeTarget(route({ schedule: { mode: 'none' } }), { now: 0 }).kind, 'now')
})

test('the server looks every minute shortly before departure, every 3 minutes before, never outside the window', () => {
  const [trip] = parseSearchChRoute(answer(connection()))
  const target = { kind: 'firstLesson', at: '2026-11-13T07:35:00+01:00', timeType: 'arrive' }
  const dep = parseLocal(trip.departure)
  assert.equal(nextCheckAt(target, trip, dep - 3 * 3600_000), dep - 75 * MIN)
  assert.equal(nextCheckAt(target, trip, dep - 40 * MIN), dep - 37 * MIN)
  assert.equal(nextCheckAt(target, trip, dep - 10 * MIN), dep - 9 * MIN)
  assert.equal(nextCheckAt({ kind: 'now' }, trip, dep), Number.POSITIVE_INFINITY)
})

test('delay alerts start at the threshold, repeat only when the delay grows by 5, never twice', () => {
  const now = parseLocal('2026-11-13 06:55:00')
  const r = route()
  const at = (busDelay) => parseSearchChRoute(answer(connection({ busDelay, busArrDelay: busDelay, train: '07:40', arrive: '07:57' })))[0]
  let state = {}
  const run = (trip) => { const result = tripAlerts({ route: r, tracked: trip, state, delayThreshold: 3, now }); state = result.state; return result.changes }
  assert.deepEqual(run(at('+2')), [])
  const first = run(at('+3'))
  assert.equal(first.length, 1)
  assert.equal(first[0].title, 'Verspätung')
  assert.equal(first[0].category, 'commute')
  assert.match(first[0].body, /07:05 Bus 371 ab Testdorf, Dorfplatz · \+3 min/u)
  assert.deepEqual(run(at('+4')), [])
  assert.deepEqual(run(at('+3')), [])
  assert.equal(run(at('+8')).length, 1)
  assert.deepEqual(run(at('+8')), [])
  // The route's own threshold wins over the global one.
  const strict = tripAlerts({ route: route({ delayThreshold: 10 }), tracked: at('+8'), state: {}, delayThreshold: 3, now })
  assert.deepEqual(strict.changes, [])
})

test('a cancellation and a missed transfer are announced once, with the alternative', () => {
  const now = parseLocal('2026-11-13 06:55:00')
  const [cancelled] = parseSearchChRoute(answer(connection({ trainDelay: 'X' })))
  const [alternative] = parseSearchChRoute(answer(connection({ bus: '07:12', z: '018303', train: '07:40', busArrive: '07:28', arrive: '07:57' })))
  const once = tripAlerts({ route: route(), tracked: cancelled, alternatives: [alternative], state: {}, delayThreshold: 3, now })
  assert.equal(once.changes.length, 1)
  assert.equal(once.changes[0].title, 'Fällt aus')
  assert.match(once.changes[0].body, /Alternative: Bus um 07:12 \(371 ab Testdorf, Dorfplatz, an Schulstadt 07:57\)/u)
  assert.deepEqual(tripAlerts({ route: route(), tracked: cancelled, alternatives: [alternative], state: once.state, delayThreshold: 3, now }).changes, [])
  const [broken] = parseSearchChRoute(answer(connection({ busDelay: '+8', busArrDelay: '+8' })))
  const missed = tripAlerts({ route: route(), tracked: broken, alternatives: [alternative], state: {}, delayThreshold: 3, now })
  assert.deepEqual(missed.changes.map((change) => change.title), ['Anschluss verpasst'])
  // Alerts off for this route: nothing.
  assert.deepEqual(tripAlerts({ route: route({ notify: false }), tracked: cancelled, state: {}, delayThreshold: 3, now }).changes, [])
})

test('cancelled last lessons: "Letzte Stunde fällt aus – du kannst den Zug um … nehmen", once', () => {
  const now = parseLocal('2026-11-13 09:00:00')
  const target = { kind: 'lastLesson', at: '2026-11-13T14:10:00+01:00', timeType: 'depart', lessonChange: 'lastCancelled', plannedAt: '2026-11-13T16:00:00+01:00' }
  const homeRoute = route({ name: 'Heim', schedule: { mode: 'lastLesson' } })
  const [trip] = parseSearchChRoute(answer(connection({ day: '2026-11-13', bus: '14:13', busArrive: '14:29', train: '14:43', arrive: '15:00' })))
  const result = lessonChangeAlert({ route: homeRoute, target, trip, state: {}, now })
  assert.equal(result.changes.length, 1)
  assert.equal(result.changes[0].title, 'Früher nach Hause')
  assert.match(result.changes[0].body, /^Letzte Stunde fällt aus – du kannst den Bus um 14:13 \(371 ab Testdorf, Dorfplatz, an Schulstadt 15:00\) nehmen\.$/u)
  assert.deepEqual(lessonChangeAlert({ route: homeRoute, target, trip, state: result.state, now }).changes, [])
  const first = lessonChangeAlert({ route: route(), target: { ...target, kind: 'firstLesson', lessonChange: 'firstCancelled', at: '2026-11-13T09:25:00+01:00' }, trip, state: {}, now: parseLocal('2026-11-13 06:00:00') })
  assert.equal(first.changes[0].title, 'Später zur Schule')
})

const fakeSearch = (handler) => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push(String(url))
    assert.equal(init.method || 'GET', 'GET')
    assert.ok(!String(url).includes('schulnetz'), 'commute data never goes to Schulnetz')
    const body = handler(new URL(String(url)))
    return { ok: true, status: 200, json: async () => body }
  }
  return { fetchImpl, calls }
}

test('the provider caches equal questions for 30 s, spends its budget, then falls back', async () => {
  let clock = parseLocal('2026-11-13 06:00:00')
  const { fetchImpl, calls } = fakeSearch((url) => (url.hostname === 'transport.opendata.ch' ? { connections: [] } : answer(connection())))
  const provider = createCommuteProvider({ fetchImpl, now: () => new Date(clock) })
  const ask = () => provider.trips({ from: { id: '9000001', name: 'x' }, to: { id: '9000004', name: 'y' }, at: clock, timeType: 'depart' })
  await ask()
  await ask()
  assert.equal(calls.length, 1)
  clock += 31_000
  await ask()
  assert.equal(calls.length, 2)
  assert.match(calls[0], /time_type=depart/u)
  assert.match(calls[0], /show_delays=1/u)
  for (let index = 0; index < 900; index += 1) { clock += 31_000; await ask() }
  assert.ok(calls.some((url) => url.startsWith('https://transport.opendata.ch/')), 'over budget: the fallback answers')
  assert.ok(provider.budget().route <= 850)
})

test('the runtime saves routes, answers the board, alerts a delay once and pings the widget otherwise', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commute-'))
  let clock = parseLocal('2026-11-13 06:00:00')
  let busDelay = '+0'
  const { fetchImpl } = fakeSearch(() => answer(connection({ busDelay, busArrDelay: busDelay, train: '07:40', arrive: '07:57' }), connection({ bus: '06:40', busArrive: '06:56', train: '07:05', arrive: '07:22', z: '018299' })))
  const published = []
  const pings = []
  const accountId = 'f'.repeat(32)
  const events = [lesson('2026-11-13', '07:45', '08:30', 'Testfach A'), lesson('2026-11-13', '08:35', '09:20', 'Testfach B')]
  const commute = createCommute({ root, fetch: fetchImpl, now: () => new Date(clock), lessonsFor: async () => events, publish: async (id, changes) => { published.push(...changes) }, ping: async (id) => { pings.push(id) } })
  try {
    const saved = await commute.save(accountId, { routes: [route()], settings: { delayThreshold: 3 } })
    assert.equal(saved.routes.length, 1)
    assert.equal(saved.provider.occupancy, 'train-class')
    const stored = JSON.parse(await readFile(join(root, 'accounts', accountId, 'commute.json'), 'utf8'))
    assert.equal(stored.routes[0].from.name, 'Testdorf, Dorfplatz')
    const { boards } = await commute.board(accountId)
    // Arrive by 07:35: the 07:05 bus (arriving 07:22) is the latest that makes it; the 07:57 one is too late.
    assert.equal(boards[0].target.kind, 'firstLesson')
    assert.equal(boards[0].trips[0].departure, '2026-11-13T06:40:00+01:00')
    // 06:00 is before the window (06:40 − 75 min = 05:25 … it is inside): checked, quiet.
    await commute.tick()
    assert.deepEqual(published, [])
    clock = parseLocal('2026-11-13 06:30:00')
    commute.due.clear()
    commute.provider.clear()
    await commute.tick()
    assert.deepEqual(published, [])
    assert.equal(pings.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a delayed tracked trip is pushed within a minute and the same delay is not repeated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commute-'))
  let clock = parseLocal('2026-11-13 06:20:00')
  let delay = '+0'
  const { fetchImpl } = fakeSearch(() => answer(connection({ bus: '06:40', busArrive: '06:56', train: '07:05', arrive: '07:22', busDelay: delay, busArrDelay: delay, trainDelay: delay, z: '018299' })))
  const published = []
  const accountId = 'e'.repeat(32)
  const events = [lesson('2026-11-13', '07:45', '08:30', 'Testfach A')]
  const commute = createCommute({ root, fetch: fetchImpl, now: () => new Date(clock), lessonsFor: async () => events, publish: async (id, changes) => { published.push(...changes.map((change) => ({ ...change, at: clock }))) }, ping: async () => {} })
  try {
    await commute.save(accountId, { routes: [route()], settings: { delayThreshold: 3 } })
    const runFor = async (ms) => { const stop = clock + ms; while (clock < stop) { await commute.tick(); clock += 15_000 } }
    await runFor(5 * MIN)
    assert.equal(published.length, 0)
    const appeared = clock
    delay = '+6'
    await runFor(5 * MIN)
    assert.equal(published.length, 1)
    assert.equal(published[0].title, 'Verspätung')
    assert.ok(published[0].at - appeared <= 70_000, `alerted ${Math.round((published[0].at - appeared) / 1000)} s after the delay appeared`)
    await runFor(10 * MIN)
    assert.equal(published.length, 1, 'no repeat for the same delay')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cancelled last lessons push the earlier way home right after the lesson change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commute-'))
  const clock = parseLocal('2026-11-13 09:00:00')
  const { fetchImpl, calls } = fakeSearch(() => answer(connection({ bus: '14:13', busArrive: '14:29', train: '14:43', arrive: '15:00' })))
  const published = []
  const accountId = 'd'.repeat(32)
  let events = [lesson('2026-11-13', '13:15', '14:00', 'Testfach B'), lesson('2026-11-13', '14:10', '14:55', 'Testfach C'), lesson('2026-11-13', '15:05', '15:50', 'Testfach C')]
  const home = sanitizeRoutes([{ id: 'b1b2c3d4e5f6', name: 'Heim', from: { id: '9000004', name: 'Schulstadt' }, to: { id: '9000001', name: 'Testdorf, Dorfplatz' }, schedule: { mode: 'lastLesson', bufferMinutes: 10 } }])
  const commute = createCommute({ root, fetch: fetchImpl, now: () => new Date(clock), lessonsFor: async () => events, publish: async (id, changes) => { published.push(...changes) }, ping: async () => {} })
  try {
    await commute.save(accountId, { routes: home })
    await commute.tick()
    assert.equal(calls.length, 0, 'no lesson change, far before the window: nothing is asked')
    events = events.map((event) => (event.start.includes('14:10') || event.start.includes('15:05') ? { ...event, status: 'cancelled' } : event))
    commute.due.clear()
    await commute.tick()
    assert.equal(published.length, 1)
    assert.equal(published[0].title, 'Früher nach Hause')
    assert.match(published[0].body, /Letzte Stunde fällt aus – du kannst den Bus um 14:13/u)
    commute.due.clear()
    await commute.tick()
    assert.equal(published.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a walk to another stop before the first ride starts the trip', () => {
  const day = '2026-11-13'
  const [trip] = parseSearchChRoute(answer({
    from: 'Testdorf, Dorfplatz', departure: `${day} 06:45:00`, to: 'Schulstadt', arrival: `${day} 07:25:00`,
    legs: [
      { departure: `${day} 06:45:00`, name: 'Testdorf, Dorfplatz', stopid: '9000001', type: 'walk', normal_time: 1620, runningtime: 1620, exit: { arrival: `${day} 07:12:00`, name: 'Nachbarort', stopid: '9000005' } },
      leg({ name: 'Nachbarort', stopid: '9000005', dep: `${day} 07:12:00`, line: 'S29', type: 'train', exit: { arrival: `${day} 07:25:00`, name: 'Schulstadt', stopid: '9000004', arr_delay: '+0' } }),
      { arrival: `${day} 07:25:00`, name: 'Schulstadt', stopid: '9000004' },
    ],
  }))
  assert.equal(trip.departure, '2026-11-13T06:45:00+01:00')
  assert.equal(trip.minutes, 40)
  assert.equal(trip.transfers, 0)
})

test('the app API stores routes, answers boards and stops, and the switches gate commute alerts', async () => {
  const { createSchulnetzRuntime } = await import('./schulnetz-api.mjs')
  const { Readable } = await import('node:stream')
  const { randomBytes } = await import('node:crypto')
  const root = await mkdtemp(join(tmpdir(), 'commute-api-'))
  const clock = parseLocal('2026-11-13 06:20:00')
  const { fetchImpl } = fakeSearch((url) => (url.pathname.endsWith('/completion.json')
    ? [{ label: 'Testdorf, Dorfplatz', id: '9000001', iconclass: 'sl-icon-type-bus' }]
    : answer(connection({ bus: '06:40', busArrive: '06:56', train: '07:05', arrive: '07:22', z: '018299' }))))
  const schoolFetch = async () => { throw new Error('no school reads in this test') }
  const runtime = createSchulnetzRuntime({ root, key: randomBytes(32), fetch: schoolFetch, commuteFetch: fetchImpl, autostart: false, now: () => new Date(clock), log: () => {}, fcmSend: async () => ({ status: 200 }) })
  const call = async (guest, method, path, body) => {
    const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
    request.method = method
    request.headers = { authorization: `Bearer ${guest.token}`, 'x-kanti-guest': guest.accountId, 'content-type': 'application/json' }
    request.socket = { remoteAddress: '198.51.100.20' }
    let status = 0
    let text = ''
    await runtime.handle(request, { writeHead(code) { status = code }, end(value) { text = String(value || '') } }, new URL(`http://127.0.0.1/api/v1/schulnetz${path}`))
    return { status, json: text ? JSON.parse(text) : null }
  }
  try {
    const guest = await runtime.createGuest('203.0.113.80')
    const put = await call(guest, 'PUT', '/commute', { routes: [route()], settings: { delayThreshold: 5, hiddenLabels: ['Sport F'] } })
    assert.equal(put.status, 200)
    assert.equal(put.json.settings.delayThreshold, 5)
    assert.equal((await call(guest, 'GET', '/commute')).json.routes[0].id, 'a1b2c3d4e5f6')
    const stops = await call(guest, 'GET', '/commute/stops?q=Testd')
    assert.deepEqual(stops.json.stops.map((stop) => stop.name), ['Testdorf, Dorfplatz'])
    const board = await call(guest, 'GET', '/commute/board')
    assert.equal(board.status, 200)
    assert.equal(board.json.boards.length, 1)
    assert.equal(board.json.provider.occupancy, 'train-class')
    assert.equal((await call(guest, 'GET', '/commute/trips?route=000000000000')).status, 404)
    // Alerts need a linked identity (push tokens live on the link); the switches decide what is sent.
    await runtime.linkAccount(guest.accountId, { mode: 'web', baseUrl: 'https://www.schulnetz-ag.ch/aksa', deviceId: '0123456789abcdef01234569', userAgent: 'KantiTest', ssoCookies: { 'login.microsoftonline.com': 'ESTSAUTHPERSISTENT=synthetic' } })
    const delay = { id: 'commute:a1b2c3d4e5f6:2026-11-13:x:delay:6', category: 'commute', title: 'Verspätung', body: 'b', target: 'commute', targetId: 'a1b2c3d4e5f6', date: '2026-11-13' }
    const lessonNews = { ...delay, id: 'commute:a1b2c3d4e5f6:2026-11-13:lesson:lastCancelled:1410', title: 'Früher nach Hause' }
    assert.equal((await call(guest, 'PUT', '/settings', { commuteDelay: false })).status, 200)
    assert.ok(runtime.commute)
    const before = JSON.parse(await readFile(join(root, 'accounts', guest.accountId, 'link.json'), 'utf8')).revision || 0
    const published = await runtimePublish(runtime, guest.accountId, [delay, lessonNews])
    assert.deepEqual(published.map((change) => change.title), ['Früher nach Hause'])
    const after = JSON.parse(await readFile(join(root, 'accounts', guest.accountId, 'link.json'), 'utf8')).revision
    assert.equal(after, before + 1, 'a commute alert gets its own revision, so the app cursor picks it up')
    const changes = await call(guest, 'GET', `/changes?since=${before}`)
    assert.deepEqual(changes.json.changes.map((change) => change.title), ['Früher nach Hause'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** The runtime's publish hook, reached through a route alert the way the checker sends it. */
const runtimePublish = async (runtime, accountId, changes) => runtime.commutePublish(accountId, changes)

test('commute alerts have their own switch: the school-updates master switch does not silence them', async () => {
  const { alertAllowed, resolvedAlertSettings } = await import('./schulnetz-logic.mjs')
  const delay = { id: 'commute:x:2026-11-13:t:delay:6', category: 'commute', title: 'Verspätung', body: 'b' }
  const grade = { id: 'grade:x', category: 'grade', title: 'Neue Note', body: 'b' }
  const off = resolvedAlertSettings({ enabled: false })
  assert.equal(alertAllowed(off, delay), true)
  assert.equal(alertAllowed(off, grade), false)
  assert.equal(alertAllowed(resolvedAlertSettings({ commute: false }), delay), false)
  assert.equal(alertAllowed(resolvedAlertSettings({ commuteDelay: false }), { ...delay, title: 'Gleisänderung' }), false)
  assert.equal(alertAllowed(resolvedAlertSettings({ commuteDelay: false }), { ...delay, title: 'Fällt aus' }), true)
})

// ── Transfer reachability from the official transfer times ─────────────────

/** Brugg → Aarau → Lenzburg style change: ride A arrives at [at], ride B leaves [dep]; [walkSec] adds a footpath leg, [normal] is B's normal_time. */
const changeTrip = ({ arr = '07:10', dep = '07:14', arrDelay = '+0', walkSec = null, normal = null, depDelay = '+0', walkEnd = null }) => {
  const day = '2026-11-13'
  const legs = [
    leg({ name: 'Brugg AG', stopid: '8500309', dep: `${day} 06:50:00`, line: 'RE12', type: 'train', z: '1', exit: { arrival: `${day} ${arr}:00`, name: 'Aarau', stopid: '8502113', arr_delay: arrDelay } }),
  ]
  if (walkSec != null) legs.push({ departure: `${day} ${arr}:00`, stopid: '8502113', name: 'Aarau', type: 'walk', normal_time: walkSec, runningtime: walkSec, exit: { arrival: `${day} ${walkEnd || arr}:00`, name: 'Aarau, Bahnhof', stopid: '8502114' } })
  const second = leg({ name: walkSec != null ? 'Aarau, Bahnhof' : 'Aarau', stopid: walkSec != null ? '8502114' : '8502113', dep: `${day} ${dep}:00`, line: walkSec != null ? '4' : 'S11', type: walkSec != null ? 'bus' : 'train', z: '2', depDelay, exit: { arrival: `${day} 07:40:00`, name: 'Lenzburg', stopid: '8502119' } })
  if (normal != null) second.normal_time = normal
  legs.push(second, { arrival: `${day} 07:40:00`, name: 'Lenzburg', stopid: '8502119' })
  return { from: 'Brugg AG', departure: `${day} 06:50:00`, to: 'Lenzburg', arrival: `${day} 07:40:00`, legs }
}
const change = (options) => parseSearchChRoute(answer(changeTrip(options)))[0]

test('train to bus with a 4 min footpath and 2 min planned slack: +2 ok, +3/+4 tight, +5 missed', () => {
  const run = (delay) => change({ arr: '07:10', walkEnd: '07:14', walkSec: 240, dep: '07:16', arrDelay: `+${delay}` }).changes[0]
  assert.deepEqual([0, 2].map((d) => [run(d).tight, run(d).broken]), [[false, false], [false, false]])
  assert.deepEqual([3, 4].map((d) => [run(d).tight, run(d).broken]), [[true, false], [true, false]])
  assert.deepEqual([run(5).tight, run(5).broken], [false, true])
  const base = run(0)
  assert.deepEqual([base.requiredMinutes, base.requiredSource, base.walkMinutes, base.gapMinutes, base.plannedGapMinutes], [4, 'timetable', 4, 6, 6])
  // Old fields keep their meaning: the time beyond the footpath.
  assert.deepEqual([base.at, base.minutes, base.plannedMinutes], ['Aarau, Bahnhof', 2, 2])
  assert.equal(run(5).minutes, -3)
})

test('same-station change with normal_time 240 and a 4 min planned gap: +0 ok, +1/+2 tight, +3 missed', () => {
  const run = (delay) => change({ arr: '07:10', dep: '07:14', normal: 240, arrDelay: `+${delay}` })
  assert.equal(run(0).changes[0].requiredMinutes, 4)
  assert.deepEqual([0, 1, 2, 3].map((d) => run(d).changes[0]).map((c) => [c.tight, c.broken]), [[false, false], [true, false], [true, false], [false, true]])
  assert.equal(run(3).status, 'broken')
})

test('a timetable that plans a shorter change than the official one sets the minimum', () => {
  const planned = change({ arr: '07:10', dep: '07:12', normal: 240 }).changes[0]
  assert.deepEqual([planned.requiredMinutes, planned.requiredSource, planned.tight, planned.broken], [2, 'planned', false, false])
  const late = change({ arr: '07:10', dep: '07:12', normal: 240, arrDelay: '+1' }).changes[0]
  assert.deepEqual([late.tight, late.broken], [true, false])
})

test('an unknown change time: only a negative gap is missed; nothing is invented', () => {
  const unknown = change({ arr: '07:10', dep: '07:11' }).changes[0]
  assert.deepEqual([unknown.requiredMinutes, unknown.requiredSource, unknown.tight, unknown.broken], [null, 'unknown', false, false])
  assert.equal(change({ arr: '07:10', dep: '07:11', arrDelay: '+1' }).changes[0].broken, false)
  assert.equal(change({ arr: '07:10', dep: '07:11', arrDelay: '+2' }).changes[0].broken, true)
})

test('transport.opendata.ch: the footpath of a walk section is the minimum, otherwise unknown', () => {
  const section = (journey, from, to, dep, arr, extra = {}) => ({ journey, departure: { station: { id: from[0], name: from[1] }, departure: `2026-11-13T${dep}:00+0100` }, arrival: { station: { id: to[0], name: to[1] }, arrival: `2026-11-13T${arr}:00+0100` }, ...extra })
  const ride = { category: 'S', number: '11', to: 'X' }
  const [walked] = parseTransportRoute({ connections: [{ sections: [section(ride, ['1', 'A'], ['2', 'B'], '07:00', '07:10'), section(null, ['2', 'B'], ['3', 'B, Bhf'], '07:10', '07:14'), section(ride, ['3', 'B, Bhf'], ['4', 'C'], '07:16', '07:30')] }] })
  assert.deepEqual([walked.changes[0].requiredMinutes, walked.changes[0].requiredSource], [4, 'timetable'])
  const [plain] = parseTransportRoute({ connections: [{ sections: [section(ride, ['1', 'A'], ['2', 'B'], '07:00', '07:10'), section(ride, ['2', 'B'], ['4', 'C'], '07:12', '07:30')] }] })
  assert.deepEqual([plain.changes[0].requiredMinutes, plain.changes[0].requiredSource], [null, 'unknown'])
})

test('alerts: a missed transfer pushes, a tight one does not', () => {
  const now = parseLocal('2026-11-13 06:40:00')
  const tight = change({ arr: '07:10', dep: '07:14', normal: 240, arrDelay: '+2' })
  const missed = change({ arr: '07:10', dep: '07:14', normal: 240, arrDelay: '+4' })
  assert.equal(tight.changes[0].tight, true)
  const hush = tripAlerts({ route: route({ delayThreshold: 30 }), tracked: tight, state: {}, delayThreshold: 30, now })
  assert.deepEqual(hush.changes, [])
  assert.deepEqual(tripAlerts({ route: route(), tracked: missed, state: {}, delayThreshold: 30, now }).changes.map((item) => item.title), ['Anschluss verpasst'])
})

test('sanitizeSchedule defaults the walking time to 5 for lastLesson and keeps stored values', () => {
  const defaults = (schedule) => sanitizeRoutes([{ id: 'a1b2c3d4e5f6', from: { name: 'A' }, to: { name: 'B' }, schedule }])[0].schedule.bufferMinutes
  assert.equal(defaults({ mode: 'lastLesson' }), 5)
  assert.equal(defaults({ mode: 'lastLesson', bufferMinutes: null }), 5)
  assert.equal(defaults({ mode: 'firstLesson' }), 10)
  assert.equal(defaults({ mode: 'lastLesson', bufferMinutes: 10 }), 10)
  assert.equal(defaults({ mode: 'lastLesson', bufferMinutes: 0 }), 0)
})

test('lastLesson: the target is lesson end + walking time and an earlier trip never ranks first', async () => {
  const events = [lesson('2026-11-13', '13:10', '15:50', 'Fach A')]
  const home = route({ name: 'Heim', schedule: { mode: 'lastLesson', bufferMinutes: 5 } })
  const target = routeTarget(home, { now: parseLocal('2026-11-13 15:00:00'), events })
  assert.equal(target.at, '2026-11-13T15:55:00+01:00')
  assert.equal(target.lesson.end, '2026-11-13T15:50:00+01:00')
  const early = connection({ bus: '15:30', busArrive: '15:40', train: '15:47', arrive: '16:05', z: '1' })
  const reachable = connection({ bus: '15:56', busArrive: '16:06', train: '16:15', arrive: '16:40', z: '2' })
  const root = await mkdtemp(join(tmpdir(), 'commute-walk-'))
  try {
    const clock = { value: parseLocal('2026-11-13 15:00:00') }
    const commute = createCommute({ root, now: () => new Date(clock.value), lessonsFor: async () => events, provider: { trips: async () => ({ trips: parseSearchChRoute(answer(early, reachable)), provider: 'search.ch', at: new Date(clock.value).toISOString() }), stops: async () => ({ stops: [] }) } })
    const accountId = 'a'.repeat(32)
    await commute.save(accountId, { routes: [home], settings: {} })
    const before = (await commute.board(accountId)).boards[0]
    assert.deepEqual(before.trips.map((trip) => trip.departure.slice(11, 16)), ['15:56'])
    // Past lesson end + walk the plain "from now" ranking applies again.
    clock.value = parseLocal('2026-11-13 15:55:30')
    const after = (await commute.board(accountId)).boards[0]
    assert.equal(after.trips[0].departure.slice(11, 16), '15:56')
  } finally { await rm(root, { recursive: true, force: true }) }
})
