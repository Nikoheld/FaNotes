// Pendelstrecken: two vias, a fixed (pinned) connection per route and weekday, timetable changes,
// and the hidden-label reset that follows the removal of half-class choices. Synthetic stops/lines.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchPin, parseLocal, parseSearchChRoute, pinFor, routeTarget, sanitizeRoutes } from './commute-logic.mjs'
import { createCommute, createCommuteProvider } from './commute.mjs'

const leg = ({ name, stopid, dep, line = '', type = 'bus', depDelay = '+0', track = '', exit, occupancy = '', z = '001' }) => ({
  departure: dep, stopid, name, type: line ? (type === 'bus' ? 'bus' : 'strain') : 'walk', type_name: line ? (type === 'bus' ? 'Bus' : 'S-Bahn') : 'Fussweg',
  ...(line ? { line, '*G': type === 'bus' ? 'B' : 'S', '*Z': z, terminal: 'Endstation', operator: 'SBB', fgcolor: 'fff', bgcolor: '039', dep_delay: depDelay, track, occupancy } : { normal_time: 240 }),
  runningtime: line ? 900 : 240,
  exit,
})
/** One train Testdorf → Schulstadt: [dep] planned departure, [arr] planned arrival. */
const direct = ({ day = '2026-11-13', dep = '07:12', arr = '07:41', line = 'IR 16', z = '002512', delay = '+0', track = '3' } = {}) => ({
  from: 'Testdorf', departure: `${day} ${dep}:00`, to: 'Schulstadt', arrival: `${day} ${arr}:00`,
  legs: [
    leg({ name: 'Testdorf', stopid: '9100001', dep: `${day} ${dep}:00`, line, type: 'train', depDelay: delay, track, z, occupancy: '12', exit: { arrival: `${day} ${arr}:00`, name: 'Schulstadt', stopid: '9100009', arr_delay: delay } }),
    { arrival: `${day} ${arr}:00`, name: 'Schulstadt', stopid: '9100009' },
  ],
})
const answer = (...connections) => ({ count: connections.length, connections })
const lesson = (day, start, end, label, extra = {}) => ({ id: `${label}-${day}-${start}`, start: `${day}T${start}:00`, end: `${day}T${end}:00`, text: label, courseName: label, timetableText: label, eventType: '0_stp', status: '', teachers: ['TstAa'], room: 'T01', comment: '', ...extra })
const pin = (extra = {}) => ({ days: [1, 2, 3, 4, 5], line: 'IR 16', trainNo: '002512', stop: 'Testdorf', stopId: '9100001', departure: '07:12', arrival: '07:41', transfers: 0, ...extra })
const route = (extra = {}) => sanitizeRoutes([{
  id: 'b1b2c3d4e5f6', name: 'Schule', from: { id: '9100001', name: 'Testdorf', type: 'train' }, to: { id: '9100009', name: 'Schulstadt', type: 'train' },
  schedule: { mode: 'none' }, delayThreshold: 3, notify: true, pins: [pin()], ...extra,
}])[0]
const fakeSearch = (handler) => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push(String(url))
    assert.equal(init.method || 'GET', 'GET')
    assert.ok(!String(url).includes('schulnetz'), 'commute data never goes to Schulnetz')
    return { ok: true, status: 200, json: async () => handler(new URL(String(url))) }
  }
  return { fetchImpl, calls }
}

test('routes keep up to two ordered vias; an old single via still reads and is mirrored', () => {
  const stop = (name, id) => ({ id, name, type: 'train' })
  const [old] = sanitizeRoutes([{ id: 'a1b2c3d4e5f6', from: stop('A', '1'), to: stop('B', '2'), via: stop('V', '3') }])
  assert.deepEqual(old.vias.map((item) => item.name), ['V'])
  assert.equal(old.via.name, 'V')
  const [two] = sanitizeRoutes([{ id: 'a1b2c3d4e5f6', from: stop('A', '1'), to: stop('B', '2'), via: stop('Ignored', '9'), vias: [stop('V2', '5'), stop('V1', '4'), stop('V2', '5'), stop('A', '1'), stop('V3', '6')] }])
  assert.deepEqual(two.vias.map((item) => item.name), ['V2', 'V1'], 'order and duplicates kept exactly as entered, max 2')
  assert.equal(two.via.name, 'V2')
  const [none] = sanitizeRoutes([{ id: 'a1b2c3d4e5f6', from: stop('A', '1'), to: stop('B', '2') }])
  assert.deepEqual([none.vias, none.via, none.pins], [[], null, []])
})

test('pins are validated and a weekday belongs to one pin only', () => {
  const [one] = sanitizeRoutes([{ id: 'a1b2c3d4e5f6', from: { name: 'A' }, to: { name: 'B' }, pins: [
    pin({ days: [1, 2, 3] }), pin({ days: [3, 4], departure: '07:42' }), pin({ days: [5], departure: '25:00' }), pin({ days: [6], line: '' }), { evil: true },
  ] }])
  assert.deepEqual(one.pins.map((item) => [item.departure, item.days]), [['07:12', [1, 2, 3]], ['07:42', [4]]])
  assert.equal(pinFor(one, 3).departure, '07:12')
  assert.equal(pinFor(one, 4).departure, '07:42')
  assert.equal(pinFor(one, 5), null)
})

test('the provider asks search.ch with both vias in order', async () => {
  const { fetchImpl, calls } = fakeSearch(() => answer(direct()))
  const provider = createCommuteProvider({ fetchImpl, now: () => new Date(parseLocal('2026-11-13 06:00:00')) })
  await provider.trips({ from: { id: '1', name: 'A' }, to: { id: '2', name: 'B' }, vias: [{ id: '8500001', name: 'Erst' }, { id: '', name: 'Zweit Ort' }], at: parseLocal('2026-11-13 07:00:00') })
  const url = new URL(calls[0])
  assert.deepEqual(url.searchParams.getAll('via[]'), ['8500001', 'Zweit Ort'])
  assert.equal(url.searchParams.get('via'), null)
})

test('a pinned connection is found by line or train number, boarding stop and planned time', () => {
  const day = '2026-11-13'
  const trips = parseSearchChRoute(answer(direct({ dep: '07:02', arr: '07:31', z: '002510' }), direct(), direct({ dep: '07:20', arr: '07:55', line: 'S 29', z: '018301' })))
  assert.equal(trips[0].pin.departure, '07:02')
  assert.equal(trips[1].pin.trainNo, '002512')
  const ok = matchPin(trips, pin(), day)
  assert.equal(ok.status, 'ok')
  assert.equal(ok.trip.pin.departure, '07:12')
  // The timetable moved it to 07:14 (same train number, line renamed): moved, not missing.
  const shifted = parseSearchChRoute(answer(direct({ dep: '07:14', arr: '07:43', line: 'IR 17', z: '2512' })))
  const moved = matchPin(shifted, pin(), day)
  assert.equal(moved.status, 'moved')
  assert.equal(moved.trip.pin.departure, '07:14')
  // Gone from the timetable: the nearest departure is suggested.
  // Another train of the same line ten minutes earlier is not the pinned one moved.
  assert.equal(matchPin(parseSearchChRoute(answer(direct({ dep: '07:02', arr: '07:31', z: '002510' }))), pin(), day).status, 'missing')
  // Buses without numbers: the same line two minutes off is moved, ten minutes off is not.
  const bus = pin({ line: '366', trainNo: '' })
  assert.equal(matchPin(parseSearchChRoute(answer(direct({ dep: '07:14', arr: '07:43', line: '366', z: '' }))), bus, day).status, 'moved')
  assert.equal(matchPin(parseSearchChRoute(answer(direct({ dep: '07:22', arr: '07:51', line: '366', z: '' }))), bus, day).status, 'missing')
  const gone = matchPin(parseSearchChRoute(answer(direct({ dep: '06:50', arr: '07:20', line: 'S 23', z: '1' }), direct({ dep: '07:20', arr: '07:55', line: 'S 29', z: '2' }))), pin(), day)
  assert.equal(gone.status, 'missing')
  assert.equal(gone.trip, null)
  assert.equal(gone.nearest.pin.departure, '07:20')
})

test('a pinned route targets its connection on the next pinned weekday and keeps it until arrival', () => {
  const thursday = sanitizeRoutes([{ ...route(), pins: [pin({ days: [1, 2, 3, 5] }), pin({ days: [4], departure: '08:12', arrival: '08:41' })] }])[0]
  const friday = routeTarget(thursday, { now: parseLocal('2026-11-12 09:00:00') })
  assert.deepEqual([friday.kind, friday.at, friday.timeType, friday.day], ['pinned', '2026-11-13T07:12:00+01:00', 'depart', '2026-11-13'])
  const thursdayMorning = routeTarget(thursday, { now: parseLocal('2026-11-12 06:00:00') })
  assert.equal(thursdayMorning.at, '2026-11-12T08:12:00+01:00')
  // On the train (07:30, arrival 07:41): still the same target.
  assert.equal(routeTarget(thursday, { now: parseLocal('2026-11-13 07:30:00') }).at, '2026-11-13T07:12:00+01:00')
  // After arrival: next pinned weekday (Monday).
  assert.equal(routeTarget(thursday, { now: parseLocal('2026-11-13 07:50:00') }).at, '2026-11-16T07:12:00+01:00')
})

test('a lesson-tied pinned route skips days without lessons and reports the earlier way home', () => {
  const home = route({ schedule: { mode: 'lastLesson', bufferMinutes: 10 }, pins: [pin({ departure: '16:32', arrival: '17:01' })] })
  const events = [
    lesson('2026-11-13', '13:15', '14:00', 'Fach A'), lesson('2026-11-13', '14:10', '14:55', 'Fach B'), lesson('2026-11-13', '15:05', '16:15', 'Fach C', { status: 'cancelled' }),
    lesson('2026-11-16', '08:00', '08:45', 'Fach D', { status: 'cancelled' }),
    lesson('2026-11-17', '08:00', '16:15', 'Fach E'),
  ]
  const friday = routeTarget(home, { now: parseLocal('2026-11-13 10:00:00'), events })
  assert.deepEqual([friday.kind, friday.at, friday.lessonChange, friday.changeAt, friday.changeTimeType], ['pinned', '2026-11-13T16:32:00+01:00', 'lastCancelled', '2026-11-13T15:05:00+01:00', 'depart'])
  // Monday: all lessons cancelled → skipped; Tuesday is the next target.
  assert.equal(routeTarget(home, { now: parseLocal('2026-11-13 18:00:00'), events }).day, '2026-11-17')
})

test('the board focuses on the pinned connection; alerts follow only it; a missing one is reported once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commute-pin-'))
  let clock = parseLocal('2026-11-13 06:30:00')
  let pinnedThere = true
  let pinnedDelay = '+0'
  // The 07:02 is earlier and would rank first without the pin; it is late by 9 min (no alert: not pinned).
  // Answers for the asked day (search.ch date=MM/DD/YYYY).
  const { fetchImpl } = fakeSearch((url) => {
    const [month, date, year] = url.searchParams.get('date').split('/')
    const day = `${year}-${month}-${date}`
    return answer(direct({ day, dep: '07:02', arr: '07:31', z: '002510', delay: '+9' }), ...(pinnedThere ? [direct({ day, delay: pinnedDelay })] : []), direct({ day, dep: '07:20', arr: '07:55', line: 'S 29', z: '018301' }))
  })
  const published = []
  const accountId = 'e'.repeat(32)
  const commute = createCommute({ root, fetch: fetchImpl, now: () => new Date(clock), lessonsFor: async () => [], publish: async (id, changes) => { published.push(...changes) }, ping: async () => {} })
  const pass = async () => { commute.due.clear(); commute.provider.clear(); await commute.tick() }
  try {
    await commute.save(accountId, { routes: [route()], settings: {} })
    const { boards: [board] } = await commute.board(accountId)
    assert.equal(board.pinned.status, 'ok')
    assert.equal(board.trips[0].pin.departure, '07:12', 'the pinned trip comes first')
    assert.ok(board.trips.slice(1).some((trip) => trip.pin.departure === '07:02'), 'other connections stay available')
    await pass()
    assert.deepEqual(published, [], 'the delayed 07:02 is not the pinned train')
    clock = parseLocal('2026-11-13 06:55:00')
    pinnedDelay = '+4'
    await pass()
    assert.deepEqual(published.map((change) => change.title), ['Verspätung'])
    assert.match(published[0].body, /07:12 IR 16 ab Testdorf · \+4 min/u)
    // It vanished after being seen today: cancelled, with an alternative.
    pinnedThere = false
    clock = parseLocal('2026-11-13 07:00:00')
    await pass()
    assert.equal(published[1].title, 'Fällt aus')
    // The 07:02 runs 9 min late and still leaves after now: the best way on.
    assert.match(published[1].body, /Alternative: Zug um 07:11 \(IR 16 ab Testdorf/u)
    const gone = (await commute.board(accountId)).boards[0]
    assert.equal(gone.pinned.status, 'gone')
    assert.equal(gone.trips[0].status, 'cancelled')
    await pass()
    assert.equal(published.length, 2, 'no repeat')
    // Monday: not in the timetable at all (timetable change) → "Verbindung fehlt" once, nearest named.
    clock = parseLocal('2026-11-16 06:10:00')
    await pass()
    assert.deepEqual(published.slice(2).map((change) => change.title), ['Verbindung fehlt'])
    assert.match(published[2].body, /07:12 IR 16 ab Testdorf ist am 16\.11\. nicht im Fahrplan\. Nächste Verbindung: Zug um 07:20/u)
    const missing = (await commute.board(accountId)).boards[0]
    assert.equal(missing.pinned.status, 'missing')
    assert.equal(missing.pinned.nearest.pin.departure, '07:20')
    clock = parseLocal('2026-11-17 06:10:00')
    await pass()
    assert.equal(published.length, 3, 'reported once per pin, not every day')
    // Back in the timetable, then gone again on another day: reported again.
    pinnedThere = true
    pinnedDelay = '+0'
    clock = parseLocal('2026-11-18 06:10:00')
    await pass()
    pinnedThere = false
    clock = parseLocal('2026-11-19 06:10:00')
    await pass()
    assert.deepEqual(published.slice(3).map((change) => change.title), ['Verbindung fehlt'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a pinned way home on a day with cancelled last lessons suggests the earlier train once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commute-pin-'))
  const clock = parseLocal('2026-11-13 10:00:00')
  const { fetchImpl } = fakeSearch((url) => {
    const time = url.searchParams.get('time')
    return time < '16:00' ? answer(direct({ dep: '15:12', arr: '15:41' }), direct({ dep: '15:42', arr: '16:11' })) : answer(direct({ dep: '16:32', arr: '17:01' }))
  })
  const published = []
  const accountId = 'd'.repeat(32)
  const events = [lesson('2026-11-13', '13:15', '14:55', 'Fach A'), lesson('2026-11-13', '15:05', '16:15', 'Fach C', { status: 'cancelled' })]
  const commute = createCommute({ root, fetch: fetchImpl, now: () => new Date(clock), lessonsFor: async () => events, publish: async (id, changes) => { published.push(...changes) }, ping: async () => {} })
  try {
    await commute.save(accountId, { routes: [route({ schedule: { mode: 'lastLesson', bufferMinutes: 10 }, pins: [pin({ departure: '16:32', arrival: '17:01' })] })], settings: {} })
    const { boards: [board] } = await commute.board(accountId)
    assert.equal(board.pinned.status, 'ok')
    assert.equal(board.change.pin.departure, '15:12')
    await commute.tick()
    assert.deepEqual(published.map((change) => change.title), ['Früher nach Hause'])
    assert.match(published[0].body, /Zug um 15:12/u)
    commute.due.clear()
    await commute.tick()
    assert.equal(published.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('hidden labels stored before half-class choices were removed are reset; new ones are kept', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commute-pin-'))
  const accountId = 'c'.repeat(32)
  const { fetchImpl } = fakeSearch(() => answer(direct()))
  const commute = createCommute({ root, fetch: fetchImpl, now: () => new Date(parseLocal('2026-11-13 06:00:00')) })
  try {
    await mkdir(join(root, 'accounts', accountId), { recursive: true })
    await writeFile(join(root, 'accounts', accountId, 'commute.json'), JSON.stringify({ version: 1, routes: [route({ pins: [] })], settings: { delayThreshold: 5, hiddenLabels: ['sport gruppe b'] } }))
    const old = await commute.view(accountId)
    assert.deepEqual(old.settings, { delayThreshold: 5, hiddenLabels: [] })
    assert.equal(old.routes.length, 1)
    // A half-class label left over would have moved the first lesson; with the reset it counts.
    const target = routeTarget({ ...old.routes[0], schedule: { mode: 'firstLesson', days: [5], bufferMinutes: 10 } }, { now: parseLocal('2026-11-13 06:00:00'), events: [lesson('2026-11-13', '07:45', '08:30', 'Sport Gruppe B'), lesson('2026-11-13', '08:35', '09:20', 'Fach A')], hiddenLabels: old.settings.hiddenLabels })
    assert.equal(target.lesson.start, '2026-11-13T07:45:00+01:00')
    await commute.save(accountId, { routes: old.routes, settings: { delayThreshold: 5, hiddenLabels: ['Fach X'] } })
    assert.equal(JSON.parse(await readFile(join(root, 'accounts', accountId, 'commute.json'), 'utf8')).version, 2)
    assert.deepEqual((await commute.view(accountId)).settings.hiddenLabels, ['fach x'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an app older than pins and two vias keeps them when it saves the route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commute-pin-'))
  const accountId = 'b'.repeat(32)
  const commute = createCommute({ root, fetch: fakeSearch(() => answer(direct())).fetchImpl, now: () => new Date(parseLocal('2026-11-13 06:00:00')) })
  const stop = (name, id) => ({ id, name, type: 'train' })
  try {
    const full = { ...route(), vias: [stop('V1', '11'), stop('V2', '12')] }
    await commute.save(accountId, { routes: [full], settings: {} })
    // The old client: its own fields, `via` = first via, no pins/vias keys.
    const { pins, vias, ...old } = full
    const saved = await commute.save(accountId, { routes: [{ ...old, name: 'Neu', via: stop('V1', '11') }], settings: {} })
    assert.equal(saved.routes[0].name, 'Neu')
    assert.deepEqual(saved.routes[0].vias.map((item) => item.name), ['V1', 'V2'])
    assert.equal(saved.routes[0].pins.length, 1)
    // It changed the via: that change wins; a new client clearing pins clears them.
    const changed = await commute.save(accountId, { routes: [{ ...old, via: stop('W', '13') }], settings: {} })
    assert.deepEqual(changed.routes[0].vias.map((item) => item.name), ['W'])
    const cleared = await commute.save(accountId, { routes: [{ ...full, pins: [] }], settings: {} })
    assert.deepEqual(cleared.routes[0].pins, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the connection picker answers for unsaved stops through the app API, in departure order', async () => {
  const { createSchulnetzRuntime } = await import('./schulnetz-api.mjs')
  const { Readable } = await import('node:stream')
  const { randomBytes } = await import('node:crypto')
  const root = await mkdtemp(join(tmpdir(), 'commute-pin-api-'))
  const clock = parseLocal('2026-11-12 18:00:00')
  const { fetchImpl, calls } = fakeSearch(() => answer(direct({ dep: '07:42', arr: '08:11', z: '2514' }), direct(), direct({ dep: '07:02', arr: '07:31', z: '2510' })))
  const runtime = createSchulnetzRuntime({ root, key: randomBytes(32), fetch: async () => { throw new Error('no school reads') }, commuteFetch: fetchImpl, autostart: false, now: () => new Date(clock), log: () => {}, fcmSend: async () => ({ status: 200 }) })
  const call = async (guest, path) => {
    const request = Readable.from([])
    request.method = 'GET'
    request.headers = { authorization: `Bearer ${guest.token}`, 'x-kanti-guest': guest.accountId }
    request.socket = { remoteAddress: '198.51.100.21' }
    let status = 0
    let text = ''
    await runtime.handle(request, { writeHead(code) { status = code }, end(value) { text = String(value || '') } }, new URL(`http://127.0.0.1/api/v1/schulnetz${path}`))
    return { status, json: text ? JSON.parse(text) : null }
  }
  try {
    const guest = await runtime.createGuest('203.0.113.81')
    const found = await call(guest, `/commute/connections?from=9100001&to=Schulstadt&via=8500001&via=Zweit&at=${encodeURIComponent('2026-11-13T07:00:00+01:00')}`)
    assert.equal(found.status, 200)
    assert.deepEqual(found.json.trips.map((trip) => trip.pin.departure), ['07:02', '07:12', '07:42'])
    const asked = new URL(calls[0])
    assert.deepEqual([asked.searchParams.get('from'), asked.searchParams.get('to'), asked.searchParams.getAll('via[]'), asked.searchParams.get('num')], ['9100001', 'Schulstadt', ['8500001', 'Zweit'], '8'])
    assert.equal((await call(guest, '/commute/connections?to=x')).status, 400)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
