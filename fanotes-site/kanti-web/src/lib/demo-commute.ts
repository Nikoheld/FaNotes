// Demo mode: invented routes and boards (Testdorf -> Schulstadt), built relative to "now" so the
// next trips are always ahead. Nothing here is read from or sent anywhere.
import { clockOf, isoZurich, timeMs, tripPosition } from './commute'
import type { CommuteProvider, CommuteRoute, CommuteSettings, Leg, LegStop, Occupancy, Pin, RouteBoard, Stop, Trip, TripDetail, TripPoint } from '../types'

const MIN = 60_000
const stop = (id: string, name: string, type: Stop['type']): Stop => ({ id, name, type })
export const DEMO_STOPS: Stop[] = [
  stop('demo-testdorf', 'Testdorf, Bahnhof', 'train'),
  stop('demo-testdorf-bus', 'Testdorf, Dorfplatz', 'bus'),
  stop('demo-schulstadt', 'Schulstadt', 'train'),
  stop('demo-schulstadt-kanti', 'Schulstadt, Kantonsschule', 'bus'),
  stop('demo-mittelwil', 'Mittelwil', 'train'),
  stop('demo-seeblick', 'Seeblick, Fähre', 'ship'),
]

const [TESTDORF, DORFPLATZ, SCHULSTADT, KANTI, MITTELWIL, SEEBLICK] = DEMO_STOPS
const none: Occupancy = { first: null, second: null }

const point = (s: Stop, at: number, planned: number, platform = '', changed = false): TripPoint => ({
  name: s.name, stopId: s.id, time: isoZurich(at), planned: isoZurich(planned), delay: Math.round((at - planned) / MIN), platform, platformChanged: changed,
})

/** Invented intermediate stops per kind of vehicle; the board only carries how many (`stopCount`). */
const STOP_NAMES: Record<string, string[]> = {
  S: ['Unterdorf', 'Neumatt', 'Birchwil', 'Seehalde'],
  IR: ['Hardmatt'],
  T: ['Marktplatz', 'Rathaus', 'Altstadt'],
  B: ['Dorfplatz Süd', 'Schulhaus Birken', 'Bergstrasse', 'Gewerbepark', 'Sportanlage'],
  BAT: ['Rebberg', 'Fischerhaus'],
}
const stopNames = (category: string): string[] => STOP_NAMES[category] || []

const ride = (line: string, category: string, type: Stop['type'], direction: string, from: [Stop, number, number, string?, boolean?], to: [Stop, number, number, string?], occupancy: Occupancy, colors: [string, string] = ['', ''], extra: Partial<Leg> = {}): Leg => ({
  kind: 'ride', line, category, type, operator: 'Demo-Verkehr', direction, bgColor: colors[0], fgColor: colors[1],
  from: point(from[0], from[1], from[2], from[3] || '', from[4] || false),
  to: point(to[0], to[1], to[2], to[3] || ''),
  occupancy, cancelled: false, notes: [], minutes: Math.round((to[1] - from[1]) / MIN), journeyId: `demo-${line}-${from[2]}`, stopCount: stopNames(category).length, ...extra,
})

const trip = (legs: Leg[], extra: Partial<Trip> = {}): Trip => {
  const first = legs[0]
  const last = legs[legs.length - 1]
  const changes = legs.slice(1).map((leg, index) => {
    const minutes = Math.round((Date.parse(leg.from.time) - Date.parse(legs[index].to.time)) / MIN)
    const planned = Math.round((Date.parse(leg.from.planned) - Date.parse(legs[index].to.planned)) / MIN)
    return { at: legs[index].to.name, minutes, plannedMinutes: planned, broken: minutes < 0, tight: minutes >= 0 && minutes <= 2 }
  })
  const worst = (pick: 'first' | 'second') => legs.reduce<1 | 2 | 3 | null>((best, leg) => {
    const level = leg.occupancy[pick]
    return level != null && (best == null || level > best) ? level : best
  }, null)
  const depDelay = first.from.delay
  return {
    id: `${first.line}-${first.from.planned}-${last.to.planned}`,
    departure: first.from.time, arrival: last.to.time, plannedDeparture: first.from.planned, plannedArrival: last.to.planned,
    depDelay, arrDelay: last.to.delay,
    minutes: Math.round((Date.parse(last.to.time) - Date.parse(first.from.time)) / MIN), transfers: changes.length,
    status: (depDelay || 0) > 0 || (last.to.delay || 0) > 0 ? 'delayed' : 'ok',
    legs, changes, occupancy: { first: worst('first'), second: worst('second') }, issues: [], quietest: false,
    pin: legs.some((leg) => leg.kind === 'ride') ? tripPin(legs, changes.length) : null, ...extra,
  }
}

const tripPin = (legs: Leg[], transfers: number): Omit<Pin, 'days'> => {
  const first = legs.find((leg) => leg.kind === 'ride') as Leg
  return { line: first.line, trainNo: '', stop: first.from.name, stopId: first.from.stopId, departure: clockOf(first.from.planned), arrival: clockOf(legs[legs.length - 1].to.planned), transfers }
}

/**
 * The intermediate stops of a demo ride leg, spread evenly between its ends. Real times follow the
 * delay of the ends. The S-Bahn legs show every case the detail view handles: the second stop has no
 * real-time data (planned time only), the third is skipped, the first changes its platform.
 */
export const demoStopsFor = (leg: Leg): LegStop[] => {
  const names = stopNames(leg.category)
  const train = leg.type === 'train'
  const plannedFrom = timeMs(leg.from.planned)
  const plannedSpan = timeMs(leg.to.planned) - plannedFrom
  const delayFrom = leg.from.delay || 0
  const delayTo = leg.to.delay || 0
  return names.map((name, index): LegStop => {
    const share = (index + 1) / (names.length + 1)
    const planned = Math.round((plannedFrom + plannedSpan * share) / MIN) * MIN
    const delay = Math.round(delayFrom + (delayTo - delayFrom) * share)
    const dwell = leg.category === 'IR' ? MIN : 0
    const realtime = !(leg.category === 'S' && index === 1)
    const times = (at: number) => realtime ? { planned: isoZurich(at), time: isoZurich(at + delay * MIN), delay } : { planned: isoZurich(at), time: isoZurich(at), delay: null }
    return {
      name, stopId: `demo-${name.toLowerCase().replace(/[^a-z]+/gu, '-')}`,
      arrival: times(planned), departure: times(planned + dwell),
      platform: train ? String((index % 3) + 1) : '', platformChanged: train && leg.category === 'S' && index === 0,
      realtime, cancelled: leg.cancelled || (leg.category === 'S' && index === 2), occupancy: none,
    }
  })
}

/** Demo version of the connection detail: the board trip with its stops and a position from the clock. */
export const demoTripDetail = (trip: Trip, now: number): TripDetail => {
  const full: Trip = { ...trip, legs: trip.legs.map((leg) => (leg.kind === 'ride' ? { ...leg, stops: demoStopsFor(leg) } : leg)) }
  return { trip: full, position: tripPosition(full, now), updatedAt: isoZurich(now), stale: false, gone: false, sources: { realtime: 'search.ch', platforms: 'transport.opendata.ch', formation: null } }
}

/**
 * Demo version of the connection picker: eight trips from `at` (every 20 minutes, direct and with one
 * change alternating), for any pair of stops. Never leaves the browser.
 */
export const demoConnections = (from: Stop, to: Stop, vias: Stop[], at: string): Trip[] => {
  const start = Math.ceil((timeMs(at) || Date.now()) / (5 * MIN)) * (5 * MIN)
  const mid = vias[0] || MITTELWIL
  return Array.from({ length: 8 }, (_, index) => {
    const dep = start + index * 20 * MIN
    if (index % 2 === 0) {
      return trip([ride('IR16', 'IR', 'train', to.name, [from, dep, dep, '3'], [to, dep + 29 * MIN, dep + 29 * MIN, '5'], { first: 1, second: index % 4 === 0 ? 1 : 2 }, ['d81e1e', 'ffffff'])])
    }
    return trip([
      ride('S29', 'S', 'train', mid.name, [from, dep, dep, '4'], [mid, dep + 14 * MIN, dep + 14 * MIN, '1'], { first: 1, second: 2 }, ['1f6fb5', 'ffffff']),
      ride('S6', 'S', 'train', to.name, [mid, dep + 18 * MIN, dep + 18 * MIN, '2'], [to, dep + 36 * MIN, dep + 36 * MIN, '3'], { first: 1, second: 3 }, ['1f6fb5', 'ffffff']),
    ])
  })
}

/** The demo's routes, their boards and a few stops to search. Times are relative to `now`. */
export const demoCommute = (now: number): { routes: CommuteRoute[]; settings: CommuteSettings; provider: CommuteProvider; boards: Record<string, RouteBoard>; stops: Stop[] } => {
  const base = Math.ceil(now / MIN) * MIN
  const at = (minutes: number) => base + minutes * MIN
  const schedule = (mode: 'firstLesson' | 'lastLesson') => ({ mode, times: [], days: [1, 2, 3, 4, 5], bufferMinutes: mode === 'lastLesson' ? 5 : 10 })
  const school: CommuteRoute = { id: 'd3m0a1b2c3d4', name: 'Schule', from: TESTDORF, to: KANTI, vias: [], via: null, schedule: schedule('firstLesson'), pins: [], delayThreshold: null, notify: true }
  const home: CommuteRoute = { id: 'd3m0e5f6a7b8', name: 'Heimweg', from: KANTI, to: TESTDORF, vias: [MITTELWIL], via: MITTELWIL, schedule: schedule('lastLesson'), pins: [], delayThreshold: 5, notify: true }

  // To school: the first train is late, the second one is the quietest.
  const t1 = trip([
    ride('S29', 'S', 'train', 'Schulstadt', [TESTDORF, at(14), at(10), '4', true], [SCHULSTADT, at(36), at(32), '2'], { first: 1, second: 3 }, ['1f6fb5', 'ffffff']),
    ride('3', 'T', 'tram', 'Kantonsschule', [SCHULSTADT, at(40), at(38), 'A'], [KANTI, at(47), at(45)], { first: 1, second: 2 }, ['c0392b', 'ffffff']),
  ])
  const t2 = trip([
    ride('IR16', 'IR', 'train', 'Schulstadt', [TESTDORF, at(25), at(25), '3'], [SCHULSTADT, at(43), at(43), '5'], { first: 1, second: 1 }, ['d81e1e', 'ffffff']),
    ride('3', 'T', 'tram', 'Kantonsschule', [SCHULSTADT, at(46), at(46), 'A'], [KANTI, at(53), at(53)], { first: 1, second: 2 }, ['c0392b', 'ffffff']),
  ], { quietest: true })
  const t3 = trip([
    ride('S29', 'S', 'train', 'Schulstadt', [TESTDORF, at(40), at(40), '4'], [SCHULSTADT, at(62), at(62), '2'], { first: 1, second: 2 }, ['1f6fb5', 'ffffff']),
    ride('3', 'T', 'tram', 'Kantonsschule', [SCHULSTADT, at(64), at(64), 'A'], [KANTI, at(71), at(71)], { first: 1, second: 2 }, ['c0392b', 'ffffff']),
  ])
  const t4 = trip([
    ride('366', 'B', 'bus', 'Schulstadt', [DORFPLATZ, at(52), at(52)], [KANTI, at(84), at(84)], none, ['f2c200', '1a1a1a']),
  ])
  const schoolBoard: RouteBoard = {
    routeId: school.id,
    target: { kind: 'firstLesson', at: isoZurich(at(60)), timeType: 'arrive', lesson: { start: isoZurich(at(70)), end: isoZurich(at(115)), label: 'Deutsch' }, lessonChange: 'none', plannedAt: null },
    trips: [t1, t2, t3, t4], alternatives: [], viaDropped: false, updatedAt: isoZurich(now), stale: false,
  }

  // Home: the next train is cancelled; two alternatives. The last lesson fell out, so they leave earlier.
  const cancelled = trip([
    ride('S29', 'S', 'train', 'Testdorf', [SCHULSTADT, at(12), at(12), '2'], [MITTELWIL, at(24), at(24), '1'], { first: 1, second: 1 }, ['1f6fb5', 'ffffff'], { cancelled: true, notes: ['Zug fällt aus (Fahrzeugstörung)'] }),
    ride('S29', 'S', 'train', 'Testdorf', [MITTELWIL, at(26), at(26), '1'], [TESTDORF, at(38), at(38), '2'], { first: 1, second: 1 }, ['1f6fb5', 'ffffff']),
  ], { status: 'cancelled', issues: [{ kind: 'cancelled', text: 'Zug fällt aus (Fahrzeugstörung)' }] })
  const alt1 = trip([
    ride('IR16', 'IR', 'train', 'Testdorf', [SCHULSTADT, at(19), at(19), '5'], [TESTDORF, at(47), at(47), '3'], { first: 1, second: 2 }, ['d81e1e', 'ffffff']),
  ], { quietest: true })
  const alt2 = trip([
    ride('S29', 'S', 'train', 'Testdorf', [SCHULSTADT, at(42), at(42), '2'], [MITTELWIL, at(54), at(54), '1'], { first: 1, second: 2 }, ['1f6fb5', 'ffffff']),
    ride('S29', 'S', 'train', 'Testdorf', [MITTELWIL, at(56), at(56), '1'], [TESTDORF, at(68), at(68), '2'], { first: 1, second: 2 }, ['1f6fb5', 'ffffff']),
  ])
  const homeBoard: RouteBoard = {
    routeId: home.id,
    target: { kind: 'lastLesson', at: isoZurich(at(12)), timeType: 'depart', lesson: { start: isoZurich(at(-35)), end: isoZurich(at(2)), label: 'Geschichte' }, lessonChange: 'lastCancelled', plannedAt: isoZurich(at(62)) },
    trips: [cancelled, alt1, alt2], alternatives: [alt1, alt2], viaDropped: true, updatedAt: isoZurich(now), stale: false,
  }

  // Fixed connection: always the IR 16 at the same time; it runs 2 minutes late today, two more trips are secondary.
  const fixedLeg = (dep: number, delay: number) => ride('IR16', 'IR', 'train', 'Schulstadt', [TESTDORF, at(dep + delay), at(dep), '3'], [SCHULSTADT, at(dep + 18 + delay), at(dep + 18), '5'], { first: 1, second: 2 }, ['d81e1e', 'ffffff'])
  const tramLeg = (dep: number) => ride('3', 'T', 'tram', 'Kantonsschule', [SCHULSTADT, at(dep + 23), at(dep + 23), 'A'], [KANTI, at(dep + 30), at(dep + 30)], { first: 1, second: 2 }, ['c0392b', 'ffffff'])
  const pinnedTrip = trip([fixedLeg(22, 2), tramLeg(22)])
  const fixedPin: Pin = { ...(pinnedTrip.pin as Omit<Pin, 'days'>), days: [1, 2, 3, 4, 5] }
  const fixed: CommuteRoute = { id: 'd3m0c9d0e1f2', name: 'Fester Zug', from: TESTDORF, to: KANTI, vias: [], via: null, schedule: { mode: 'none', times: [], days: [1, 2, 3, 4, 5], bufferMinutes: 10 }, pins: [fixedPin], delayThreshold: null, notify: true }
  const otherA = trip([fixedLeg(2, 0), tramLeg(2)])
  const otherB = trip([fixedLeg(42, 0), tramLeg(42)])
  const fixedBoard: RouteBoard = {
    routeId: fixed.id,
    target: { kind: 'pinned', at: pinnedTrip.plannedDeparture, timeType: 'depart', lesson: null, lessonChange: 'none', plannedAt: null, pin: fixedPin, day: isoZurich(at(22)).slice(0, 10), changeAt: null, changeTimeType: null },
    trips: [otherA, pinnedTrip, otherB], alternatives: [], viaDropped: false,
    pinned: { status: 'ok', day: isoZurich(at(22)).slice(0, 10), pin: fixedPin, trip: pinnedTrip, nearest: null }, change: null, updatedAt: isoZurich(now), stale: false,
  }

  // Two via stops: the ferry from Seeblick, over Mittelwil and Testdorf to the school.
  const lake: CommuteRoute = { id: 'd3m0a9b8c7d6', name: 'Seeweg', from: SEEBLICK, to: KANTI, vias: [MITTELWIL, TESTDORF], via: MITTELWIL, schedule: { mode: 'none', times: [], days: [1, 2, 3, 4, 5], bufferMinutes: 10 }, pins: [], delayThreshold: null, notify: false }
  const lakeTrip = (dep: number) => trip([
    ride('3302', 'BAT', 'ship', 'Mittelwil', [SEEBLICK, at(dep), at(dep), '1'], [MITTELWIL, at(dep + 22), at(dep + 22), '2'], none, ['0b6e9f', 'ffffff']),
    ride('S29', 'S', 'train', 'Schulstadt', [MITTELWIL, at(dep + 28), at(dep + 28), '1'], [TESTDORF, at(dep + 43), at(dep + 43), '2'], { first: 1, second: 2 }, ['1f6fb5', 'ffffff']),
    ride('IR16', 'IR', 'train', 'Schulstadt', [TESTDORF, at(dep + 45), at(dep + 45), '3'], [SCHULSTADT, at(dep + 63), at(dep + 63), '5'], { first: 1, second: 1 }, ['d81e1e', 'ffffff']),
  ])
  const lakeBoard: RouteBoard = {
    routeId: lake.id,
    target: { kind: 'now', at: isoZurich(at(0)), timeType: 'depart', lesson: null, lessonChange: 'none', plannedAt: null },
    trips: [lakeTrip(-10), lakeTrip(18), lakeTrip(78)], alternatives: [], viaDropped: false, pinned: null, change: null, updatedAt: isoZurich(now), stale: false,
  }

  return {
    routes: [school, home, fixed, lake],
    settings: { delayThreshold: 3, hiddenLabels: [] },
    provider: { name: 'search.ch', occupancy: 'train-class', formation: false },
    boards: { [school.id]: schoolBoard, [home.id]: homeBoard, [fixed.id]: fixedBoard, [lake.id]: lakeBoard },
    stops: DEMO_STOPS,
  }
}

/**
 * Demo: the board of a route the user just saved. A route without pins gets a plain board from the
 * template; with pins its first template trip becomes the fixed connection (live data is not invented).
 */
export const demoBoardFor = (route: CommuteRoute, template: RouteBoard, now: number): RouteBoard => {
  const plain: RouteBoard = { ...template, routeId: route.id, pinned: null, change: null, target: { ...template.target, kind: template.target.kind === 'pinned' ? 'now' : template.target.kind, pin: undefined, day: undefined }, updatedAt: isoZurich(now) }
  const pin = route.pins[0]
  if (!pin) return plain
  const pinnedTrip = plain.trips[0]
  const day = isoZurich(now).slice(0, 10)
  return {
    ...plain,
    target: { ...plain.target, kind: 'pinned', pin, day },
    pinned: { status: 'ok', day, pin, trip: pinnedTrip, nearest: null },
  }
}
