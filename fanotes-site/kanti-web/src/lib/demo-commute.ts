// Demo mode: invented routes and boards (Testdorf -> Schulstadt), built relative to "now" so the
// next trips are always ahead. Nothing here is read from or sent anywhere.
import { isoZurich } from './commute'
import type { CommuteProvider, CommuteRoute, CommuteSettings, Leg, Occupancy, RouteBoard, Stop, Trip, TripPoint } from '../types'

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

const [TESTDORF, DORFPLATZ, SCHULSTADT, KANTI, MITTELWIL] = DEMO_STOPS
const none: Occupancy = { first: null, second: null }

const point = (s: Stop, at: number, planned: number, platform = '', changed = false): TripPoint => ({
  name: s.name, stopId: s.id, time: isoZurich(at), planned: isoZurich(planned), delay: Math.round((at - planned) / MIN), platform, platformChanged: changed,
})

const ride = (line: string, category: string, type: Stop['type'], direction: string, from: [Stop, number, number, string?, boolean?], to: [Stop, number, number, string?], occupancy: Occupancy, colors: [string, string] = ['', ''], extra: Partial<Leg> = {}): Leg => ({
  kind: 'ride', line, category, type, operator: 'Demo-Verkehr', direction, bgColor: colors[0], fgColor: colors[1],
  from: point(from[0], from[1], from[2], from[3] || '', from[4] || false),
  to: point(to[0], to[1], to[2], to[3] || ''),
  occupancy, cancelled: false, notes: [], minutes: Math.round((to[1] - from[1]) / MIN), ...extra,
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
    legs, changes, occupancy: { first: worst('first'), second: worst('second') }, issues: [], quietest: false, ...extra,
  }
}

/** The demo's routes, their boards and a few stops to search. Times are relative to `now`. */
export const demoCommute = (now: number): { routes: CommuteRoute[]; settings: CommuteSettings; provider: CommuteProvider; boards: Record<string, RouteBoard>; stops: Stop[] } => {
  const base = Math.ceil(now / MIN) * MIN
  const at = (minutes: number) => base + minutes * MIN
  const schedule = (mode: 'firstLesson' | 'lastLesson') => ({ mode, times: [], days: [1, 2, 3, 4, 5], bufferMinutes: 10 })
  const school: CommuteRoute = { id: 'd3m0a1b2c3d4', name: 'Schule', from: TESTDORF, to: KANTI, via: null, schedule: schedule('firstLesson'), delayThreshold: null, notify: true }
  const home: CommuteRoute = { id: 'd3m0e5f6a7b8', name: 'Heimweg', from: KANTI, to: TESTDORF, via: MITTELWIL, schedule: schedule('lastLesson'), delayThreshold: 5, notify: true }

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

  return {
    routes: [school, home],
    settings: { delayThreshold: 3, hiddenLabels: [] },
    provider: { name: 'search.ch', occupancy: 'train-class', formation: false },
    boards: { [school.id]: schoolBoard, [home.id]: homeBoard },
    stops: DEMO_STOPS,
  }
}
