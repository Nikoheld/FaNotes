// Connection detail: the rows and their collapsing, vehicle position (ported from the server), delay classes,
// transfer warnings, the demo's stops, the API call and the rendering of the detail.
import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createApi } from '../src/lib/api'
import {
  changeAfter, clockOf, delayBadgeRows, delayClass, dwellMinutes, isoZurich, legRows, pinnedPoints, positionInfo, railItems, rowProgress, rowShowsPlanned, rowTime, transferWarning, tripPosition,
} from '../src/lib/commute'
import { demoCommute, demoStopsFor, demoTripDetail } from '../src/lib/demo-commute'
import { STRINGS } from '../src/lib/i18n'
import { DetailContent, PositionLine } from '../src/components/ConnectionDetail'
import type { Leg, LegStop, Position, Trip } from '../src/types'

const MIN = 60_000
const T0 = Date.parse('2026-11-12T07:00:00+01:00')
const iso = (minutes: number) => isoZurich(T0 + minutes * MIN)
const time = (planned: number, delay: number | null) => ({ planned: iso(planned), time: iso(planned + (delay || 0)), delay })
const point = (name: string, planned: number, delay: number | null, platform = '', changed = false) => ({ name, stopId: name, time: iso(planned + (delay || 0)), planned: iso(planned), delay, platform, platformChanged: changed })
const stop = (name: string, planned: number, delay: number | null, extra: Partial<LegStop> = {}): LegStop => ({
  name, stopId: name, arrival: time(planned, delay), departure: time(planned, delay), platform: '', platformChanged: false, realtime: delay != null, cancelled: false, occupancy: { first: null, second: null }, ...extra,
})
const leg = (from: [string, number, number | null], to: [string, number, number | null], stops: LegStop[] = [], extra: Partial<Leg> = {}): Leg => ({
  kind: 'ride', line: 'S29', category: 'S', type: 'train', operator: 'Test', direction: 'Endstadt', fgColor: 'ffffff', bgColor: '1f6fb5',
  from: point(from[0], from[1], from[2], '3'), to: point(to[0], to[1], to[2], '5'), occupancy: { first: 1, second: 2 }, cancelled: false, notes: [], minutes: to[1] - from[1], journeyId: 'j1', stopCount: stops.length, stops, ...extra,
})
const walk = (minutes: number): Leg => ({ ...leg(['A', 0, 0], ['B', minutes, 0]), kind: 'walk', line: '', category: '', type: 'other', stops: undefined, stopCount: 0, minutes })
const trip = (legs: Leg[], changes: Trip['changes'] = []): Trip => ({
  id: 'S29-x', departure: legs[0].from.time, arrival: legs[legs.length - 1].to.time, plannedDeparture: legs[0].from.planned, plannedArrival: legs[legs.length - 1].to.planned,
  depDelay: legs[0].from.delay, arrDelay: legs[legs.length - 1].to.delay, minutes: 40, transfers: changes.length, status: 'ok', legs, changes, occupancy: { first: 1, second: 2 }, issues: [], quietest: false, pin: null,
})

// Leg A: Start 0 -> Mid1 10 -> Mid2 20 (no real time) -> End 30; leg B starts 35.
const stopsA = [stop('Mid1', 10, 2), stop('Mid2', 20, null), stop('Skip', 25, 2, { cancelled: true })]
const legA = leg(['Start', 0, 2], ['End', 30, 2], stopsA)
const legB = leg(['End', 35, 0], ['Final', 50, 0], [stop('B1', 42, 0)])
const both = trip([legA, legB], [{ at: 'End', minutes: 3, plannedMinutes: 5, broken: false, tight: true }])
const at = (minutes: number) => T0 + minutes * MIN

describe('rows and collapsing', () => {
  it('lists boarding, every stop (cancelled too) and exit in order', () => {
    const rows = legRows(legA)
    expect(rows.map((row) => [row.index, row.kind, row.name])).toEqual([[0, 'board', 'Start'], [1, 'stop', 'Mid1'], [2, 'stop', 'Mid2'], [3, 'stop', 'Skip'], [4, 'exit', 'End']])
    expect(rows[0].platform).toBe('3')
    expect(rows[4].platform).toBe('5')
    expect(legRows(leg(['A', 0, 0], ['B', 5, 0])).map((row) => row.kind)).toEqual(['board', 'exit'])
  })
  it('shows the departure at the boarding stop and the arrival elsewhere', () => {
    const rows = legRows(legA)
    expect(clockOf(rowTime(rows[0])?.time || '')).toBe('07:02')
    expect(clockOf(rowTime(rows[4])?.time || '')).toBe('07:32')
    expect(clockOf(rowTime(rows[1])?.time || '')).toBe('07:12')
  })
  it('collapses the intermediate stops into one gap that counts them', () => {
    const rows = legRows(legA)
    const items = railItems(rows, false, pinnedPoints(legA, 0, undefined))
    expect(items.map((item) => item.type)).toEqual(['row', 'gap', 'row'])
    expect(items[1]).toEqual({ type: 'gap', count: 3, from: 1 })
    expect(railItems(rows, true, pinnedPoints(legA, 0, undefined))).toHaveLength(5)
  })
  it('keeps the stop where the vehicle is, and both neighbours while it is between two stops', () => {
    const rows = legRows(legA)
    const atStop: Position = { state: 'atStop', legIndex: 0, point: 2, progress: 0, estimated: false }
    const items = railItems(rows, false, pinnedPoints(legA, 0, atStop))
    expect(items.map((item) => (item.type === 'row' ? item.row.index : `gap${item.count}`))).toEqual([0, 'gap1', 2, 'gap1', 4])
    const between: Position = { state: 'between', legIndex: 0, point: 1, progress: 0.5, estimated: false }
    expect(railItems(rows, false, pinnedPoints(legA, 0, between)).map((item) => (item.type === 'row' ? item.row.index : 'gap'))).toEqual([0, 1, 2, 'gap', 4])
    // Another leg's position pins nothing here; neither does a train that has not left.
    expect([...pinnedPoints(legA, 0, { ...atStop, legIndex: 1 })].sort()).toEqual([0, 4])
    expect([...pinnedPoints(legA, 0, { state: 'notStarted', legIndex: 0, point: 0, progress: 0, estimated: false })].sort()).toEqual([0, 4])
  })
  it('marks planned times as struck only where real time differs', () => {
    const rows = legRows(legA)
    expect(rowShowsPlanned(rows[1])).toBe(true)
    expect(rowShowsPlanned(rows[2])).toBe(false)
    expect(rowShowsPlanned(rows[3])).toBe(false)
    expect(rowShowsPlanned(legRows(legB)[1])).toBe(false)
  })
  it('gives a delay badge only where the delay changes along the leg', () => {
    const late = leg(['A', 0, 4], ['B', 40, 6], [stop('X', 10, 4), stop('Y', 20, 5), stop('Z', 30, 5)])
    expect([...delayBadgeRows(legRows(late))]).toEqual([0, 2, 4])
    expect(delayBadgeRows(legRows(leg(['A', 0, 0], ['B', 5, 0]))).size).toBe(0)
  })
  it('knows the dwell time of an intermediate stop', () => {
    const row = legRows(leg(['A', 0, 0], ['B', 30, 0], [stop('X', 10, 0, { departure: time(12, 0) })]))[1]
    expect(dwellMinutes(row)).toBe(2)
    expect(dwellMinutes(legRows(legA)[1])).toBe(0)
  })
})

describe('vehicle position (port of the server logic)', () => {
  it('is not started before the first departure, estimated when that time has no real-time value', () => {
    expect(tripPosition(both, at(-5))).toEqual({ state: 'notStarted', legIndex: 0, point: 0, progress: 0, estimated: false })
    expect(tripPosition(trip([leg(['A', 0, null], ['B', 10, null])]), at(-1)).estimated).toBe(true)
  })
  it('sits between two stops by progress', () => {
    // Leg A leaves 07:02 (+2), Mid1 at 07:12: 5 minutes in is halfway.
    expect(tripPosition(both, at(7))).toEqual({ state: 'between', legIndex: 0, point: 0, progress: 0.5, estimated: false })
  })
  it('stands at a stop between its arrival and departure', () => {
    const dwell = trip([leg(['A', 0, 0], ['B', 30, 0], [stop('X', 10, 0, { departure: time(12, 0) })])])
    expect(tripPosition(dwell, at(11))).toMatchObject({ state: 'atStop', point: 1, progress: 0 })
  })
  it('skips cancelled stops and keeps the original point numbers', () => {
    // After Mid2 (no real time: estimated) the next stop is End; Skip (index 3) is ignored.
    const result = tripPosition(both, at(22))
    expect(result).toMatchObject({ state: 'between', legIndex: 0, point: 2, estimated: true })
    expect(result.progress).toBeCloseTo((22 - 20) / (32 - 20), 5)
  })
  it('says transfer after the leg has arrived and before the next one leaves, then arrived', () => {
    expect(tripPosition(both, at(33))).toMatchObject({ state: 'transfer', legIndex: 0, point: 4 })
    expect(tripPosition(both, at(36))).toMatchObject({ state: 'between', legIndex: 1, point: 0 })
    expect(tripPosition(both, at(60))).toMatchObject({ state: 'arrived', legIndex: 1, point: 2, progress: 1 })
  })
  it('handles a trip with only walking', () => {
    expect(tripPosition(trip([walk(5)]), at(1)).state).toBe('notStarted')
  })
})

describe('where it is, in words', () => {
  it('names the stops of the status line', () => {
    const info = (position: Position) => positionInfo(both, position)
    expect(info({ state: 'atStop', legIndex: 0, point: 1, progress: 0, estimated: false })).toEqual({ state: 'atStop', at: 'Mid1', next: '', estimated: false })
    expect(info({ state: 'between', legIndex: 0, point: 1, progress: 0.3, estimated: true })).toEqual({ state: 'between', at: 'Mid1', next: 'Mid2', estimated: true })
    expect(info({ state: 'transfer', legIndex: 0, point: 4, progress: 0, estimated: false })?.at).toBe('End')
    expect(positionInfo(both, undefined)).toBeNull()
    expect(positionInfo(both, { state: 'atStop', legIndex: 9, point: 0, progress: 0, estimated: false })).toBeNull()
  })
  it('says which rows are behind the vehicle', () => {
    const position: Position = { state: 'between', legIndex: 0, point: 1, progress: 0.4, estimated: false }
    expect(rowProgress(position, 0, 0)).toBe('past')
    expect(rowProgress(position, 0, 1)).toBe('past')
    expect(rowProgress(position, 0, 2)).toBe('future')
    expect(rowProgress(position, 1, 0)).toBe('future')
    expect(rowProgress({ ...position, state: 'atStop' }, 0, 1)).toBe('current')
    expect(rowProgress({ ...position, legIndex: 1 }, 0, 4)).toBe('past')
    expect(rowProgress(undefined, 0, 0)).toBe('future')
  })
  it('renders every state in both languages', () => {
    for (const language of ['de', 'en'] as const) {
      const t = STRINGS[language]
      const states: [Position, string][] = [
        [{ state: 'notStarted', legIndex: 0, point: 0, progress: 0, estimated: false }, t.posNotStarted],
        [{ state: 'atStop', legIndex: 0, point: 1, progress: 0, estimated: false }, t.posAt('Mid1')],
        [{ state: 'between', legIndex: 0, point: 1, progress: 0.5, estimated: true }, t.posBetween('Mid1', 'Mid2')],
        [{ state: 'transfer', legIndex: 0, point: 4, progress: 0, estimated: false }, t.posTransfer('End')],
        [{ state: 'arrived', legIndex: 1, point: 2, progress: 1, estimated: false }, t.posArrived],
      ]
      for (const [position, text] of states) expect(renderToString(<PositionLine trip={both} position={position} t={t} />)).toContain(text)
      expect(renderToString(<PositionLine trip={both} position={states[2][0]} t={t} />)).toContain(t.estimatedShort)
    }
  })
})

describe('delay classes and transfers in the detail', () => {
  it('classifies stop delays like the board does', () => {
    expect([0, 1, 2, 4, 5].map((minutes) => delayClass(minutes))).toEqual(['ok', 'minor', 'moderate', 'moderate', 'major'])
    expect(delayClass(null)).toBe('ok')
  })
  it('warns about tight and broken changes and finds the change after a ride leg', () => {
    expect(transferWarning(both.changes[0])).toBe('tight')
    expect(transferWarning({ at: 'X', minutes: -1, plannedMinutes: 4, broken: true, tight: false })).toBe('broken')
    expect(transferWarning({ at: 'X', minutes: 8, plannedMinutes: 8, broken: false, tight: false })).toBe('')
    expect(transferWarning(undefined)).toBe('')
    expect(changeAfter(both, 0)).toBe(both.changes[0])
    expect(changeAfter(both, 1)).toBeUndefined()
    // A walk between two rides does not shift the match.
    const withWalk = trip([legA, walk(2), legB], both.changes)
    expect(changeAfter(withWalk, 0)).toBe(both.changes[0])
    expect(changeAfter(withWalk, 1)).toBeUndefined()
  })
})

describe('demo detail', () => {
  const now = Date.parse('2026-11-11T10:02:00+01:00')
  const demo = demoCommute(now)
  const boardTrips = Object.values(demo.boards).flatMap((board) => board.trips)

  it('boards carry only the stop count, the detail carries the stops', () => {
    for (const candidate of boardTrips) for (const ride of candidate.legs) { expect(ride.stops).toBeUndefined(); expect(ride.stopCount).toBe(demoStopsFor(ride).length) }
    const detail = demoTripDetail(boardTrips[0], now)
    expect(detail.gone).toBe(false)
    expect(detail.sources).toEqual({ realtime: 'search.ch', platforms: 'transport.opendata.ch', formation: null })
    expect(detail.trip?.legs[0].stops?.length).toBe(boardTrips[0].legs[0].stopCount)
  })
  it('covers a delayed stop, a stop without real time, a cancelled stop, a platform change and a tight transfer', () => {
    const all = boardTrips.flatMap((candidate) => candidate.legs.flatMap((ride) => demoStopsFor(ride)))
    expect(all.some((entry) => (entry.arrival?.delay || 0) > 0)).toBe(true)
    expect(all.some((entry) => !entry.realtime && entry.arrival?.delay === null && entry.arrival.planned === entry.arrival.time)).toBe(true)
    expect(all.some((entry) => entry.cancelled)).toBe(true)
    expect(all.some((entry) => entry.platformChanged)).toBe(true)
    expect(boardTrips.some((candidate) => candidate.changes.some((change) => change.tight))).toBe(true)
  })
  it('puts the demo stops between the ends in time order', () => {
    for (const candidate of boardTrips) for (const ride of candidate.legs) {
      const times = demoStopsFor(ride).map((entry) => Date.parse(entry.arrival?.planned || ''))
      expect([...times].sort((a, b) => a - b)).toEqual(times)
      for (const value of times) { expect(value).toBeGreaterThanOrEqual(Date.parse(ride.from.planned)); expect(value).toBeLessThanOrEqual(Date.parse(ride.to.planned)) }
    }
  })
  it('computes the position from the clock: one demo trip is under way', () => {
    const states = new Set(boardTrips.map((candidate) => demoTripDetail(candidate, now).position?.state))
    expect(states.has('between')).toBe(true)
    expect(states.has('notStarted')).toBe(true)
  })
})

describe('api', () => {
  it('asks the trip endpoint with route, trip and planned departure', async () => {
    const seen: string[] = []
    const api = createApi(async (input) => { seen.push(String(input)); return new Response(JSON.stringify({ trip: null, gone: true }), { status: 200 }) })
    const answer = await api.commuteTrip('c0', 'abc', 'S29-1+2', '2026-11-12T07:00:00+01:00')
    expect(answer.gone).toBe(true)
    expect(seen[0]).toBe('/api/v1/kanti-web/connections/c0/commute/trip?route=abc&trip=S29-1%2B2&at=2026-11-12T07%3A00%3A00%2B01%3A00')
  })
})

describe('DetailContent', () => {
  const detail = {
    gone: false, updatedAt: iso(0), stale: false, position: { state: 'between', legIndex: 0, point: 1, progress: 0.5, estimated: false } as Position,
    sources: { realtime: 'search.ch', platforms: 'transport.opendata.ch' as string | null, formation: null }, trip: { ...both, issues: [{ kind: 'disruption' as const, text: 'Baustelle bei Mid1' }] },
  }
  it.each(['de', 'en'] as const)('renders header, legs, stops, transfer and footer (%s)', (language) => {
    const t = STRINGS[language]
    const html = renderToString(<DetailContent trip={detail.trip} detail={detail} routeName="Schule" t={t} />)
    expect(html).toContain('Schule')
    expect(html).toContain('07:02')
    expect(html).toContain('Endstadt')
    expect(html).toContain(t.detailStops(1))
    expect(html).toContain(t.posBetween('Mid1', 'Mid2'))
    expect(html).toContain(t.transferAtRisk)
    expect(html).toContain(t.detailSources('search.ch', 'transport.opendata.ch'))
    expect(html).toContain(t.detailNoFormation)
    expect(html).toContain('Baustelle bei Mid1')
    expect(html).toContain('rail-vehicle')
  })
  it('hides the platform source when there is none, and the position of a cancelled trip', () => {
    const t = STRINGS.de
    const html = renderToString(<DetailContent trip={{ ...detail.trip, status: 'cancelled' }} detail={{ ...detail, sources: { realtime: 'search.ch', platforms: null, formation: null } }} routeName="" t={t} />)
    expect(html).toContain('Echtzeit: search.ch<')
    expect(html).not.toContain('Gleise:')
    expect(html).not.toContain('dt-position')
    expect(html).not.toContain('rail-vehicle')
  })
})
