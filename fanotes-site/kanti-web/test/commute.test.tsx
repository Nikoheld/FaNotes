// Pendelstrecken: delay classes, relevant route, polling rules, editor validation, stop autocomplete and rendering.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { shortcutFor, VIEWS } from '../src/lib/shortcuts'
import { createApi } from '../src/lib/api'
import {
  assignPin, boardFocus, browseRequest, cleanPins, chipColors, connectionsQuery, defaultPickTime, isoWeekday, nextDateForWeekday, pickerPage, pinFromTrip, pinModeOf, readRoute, removePinDay, routeVias, zurichAt,
  clockOf, createStopSearcher, delayClass, durationLabel, emptyRoute, focusDue, isoZurich, lessonChange, mergeTrips, moveRoute,
  newRouteId, nextTrip, normalizeRoute, pollDue, relevantRoute, upsertRoute, validateRoute, MAX_ROUTES,
} from '../src/lib/commute'
import { demoCommute, demoConnections } from '../src/lib/demo-commute'
import { STRINGS } from '../src/lib/i18n'
import { BoardBody, PinnedFocus, DelayBadge, LessonChangeBanner, LineChip, TripCard } from '../src/components/commute'
import { KantiProvider } from '../src/state'
import { Today } from '../src/views/Today'
import { Commute } from '../src/views/Commute'
import type { CommuteRoute, Pin, RouteBoard, Stop, Trip } from '../src/types'

const NOW = Date.parse('2026-11-12T06:00:00+01:00')
const demo = demoCommute(NOW)
const [school, home] = demo.routes
const schoolBoard = demo.boards[school.id]
const homeBoard = demo.boards[home.id]
const de = STRINGS.de
const en = STRINGS.en

const validRoute = (): CommuteRoute => ({
  ...emptyRoute('0123456789ab'),
  from: { id: 'a', name: 'Testdorf', type: 'train' },
  to: { id: 'b', name: 'Schulstadt', type: 'train' },
})

afterEach(() => { vi.useRealTimers() })

describe('delay classes and formatting', () => {
  it('splits on time, +1-2, +3-5, over 5 and cancelled', () => {
    expect(delayClass(0)).toBe('ok')
    expect(delayClass(null)).toBe('ok')
    expect(delayClass(-1)).toBe('ok')
    expect(delayClass(1)).toBe('minor')
    expect(delayClass(2)).toBe('minor')
    expect(delayClass(3)).toBe('moderate')
    expect(delayClass(5)).toBe('moderate')
    expect(delayClass(6)).toBe('major')
    expect(delayClass(0, true)).toBe('cancelled')
  })
  it('formats clocks, durations and zurich ISO times', () => {
    expect(clockOf('2026-11-13T07:05:00+01:00')).toBe('07:05')
    expect(clockOf('')).toBe('')
    expect(durationLabel(65)).toBe('1 h 05 min')
    expect(durationLabel(42)).toBe('42 min')
    expect(isoZurich(Date.parse('2026-11-12T05:00:00Z'))).toBe('2026-11-12T06:00:00+01:00')
    expect(isoZurich(Date.parse('2026-07-12T05:00:00Z'))).toBe('2026-07-12T07:00:00+02:00')
    expect(chipColors({ bgColor: 'd81e1e', fgColor: 'fff' })).toEqual({ background: '#d81e1e', color: '#fff' })
    expect(chipColors({ bgColor: '', fgColor: 'zz' })).toEqual({})
  })
  it('makes 12 hex characters of route id', () => {
    expect(newRouteId()).toMatch(/^[0-9a-f]{12}$/u)
    expect(newRouteId()).not.toBe(newRouteId())
  })
})

describe('relevant route, polling and browsing', () => {
  const input = { routes: demo.routes, boards: demo.boards, now: NOW }
  it('picks the first-lesson route in the morning and the last-lesson route in the afternoon', () => {
    expect(relevantRoute({ ...input, clockMinutes: 6 * 60 })?.id).toBe(school.id)
    expect(relevantRoute({ ...input, clockMinutes: 14 * 60 })?.id).toBe(home.id)
  })
  it('falls back to the soonest target and to the first route without boards', () => {
    const times = (route: CommuteRoute): CommuteRoute => ({ ...route, schedule: { ...route.schedule, mode: 'times' } })
    const boards = { [school.id]: { ...schoolBoard, target: { ...schoolBoard.target, kind: 'time' as const, at: isoZurich(NOW + 3_600_000) } }, [home.id]: { ...homeBoard, target: { ...homeBoard.target, kind: 'time' as const, at: isoZurich(NOW + 600_000) } } }
    expect(relevantRoute({ routes: demo.routes.map(times), boards, now: NOW, clockMinutes: 6 * 60 })?.id).toBe(home.id)
    expect(relevantRoute({ routes: demo.routes, boards: {}, now: NOW, clockMinutes: 6 * 60 })?.id).toBe(school.id)
    expect(relevantRoute({ routes: [], boards: {}, now: NOW, clockMinutes: 0 })).toBeNull()
  })
  it('shows the next usable trip, skipping a cancelled one', () => {
    expect(nextTrip(homeBoard, NOW)?.id).toBe(homeBoard.trips[1].id)
    expect(nextTrip(undefined, NOW)).toBeNull()
  })
  it('polls only while visible and a trip leaves within 30 minutes, never faster than 30 s', () => {
    const base = { boards: demo.boards, now: NOW, loading: false }
    const soon = Date.parse(schoolBoard.trips[0].departure)
    const near = { ...base, boards: { x: { ...schoolBoard, trips: [{ ...schoolBoard.trips[0], departure: isoZurich(NOW + 10 * 60_000) }] } } }
    expect(soon - NOW).toBeGreaterThan(0)
    expect(pollDue({ ...near, visible: true, lastAt: NOW - 61_000 })).toBe(true)
    expect(pollDue({ ...near, visible: false, lastAt: NOW - 61_000 })).toBe(false)
    expect(pollDue({ ...near, visible: true, lastAt: NOW - 10_000 })).toBe(false)
    expect(pollDue({ ...near, visible: true, lastAt: NOW - 61_000, loading: true })).toBe(false)
    const far = { ...base, boards: { x: { ...schoolBoard, trips: [{ ...schoolBoard.trips[0], departure: isoZurich(NOW + 90 * 60_000) }] } } }
    expect(pollDue({ ...far, visible: true, lastAt: NOW - 61_000 })).toBe(false)
    expect(focusDue(NOW - 29_000, NOW, false)).toBe(false)
    expect(focusDue(NOW - 31_000, NOW, false)).toBe(true)
    expect(focusDue(0, NOW, false)).toBe(true)
  })
  it('browses later by departure and earlier by arrival, merging without duplicates', () => {
    const later = browseRequest(schoolBoard.trips, 'later')
    expect(later?.timeType).toBe('depart')
    expect(Date.parse(later!.at)).toBe(Math.max(...schoolBoard.trips.map((trip) => Date.parse(trip.departure))) + 60_000)
    const earlier = browseRequest(schoolBoard.trips, 'earlier')
    expect(earlier?.timeType).toBe('arrive')
    expect(browseRequest([], 'later')).toBeNull()
    const merged = mergeTrips(schoolBoard.trips.slice(2), schoolBoard.trips.slice(0, 3))
    expect(merged.map((trip) => trip.id)).toEqual(schoolBoard.trips.slice(0, 4).map((trip) => trip.id))
  })
  it('names the train to take when a lesson change moves the day', () => {
    const last = lessonChange(homeBoard)
    expect(last).toMatchObject({ kind: 'lastCancelled', line: 'IR16' })
    expect(last?.time).toMatch(/^\d\d:\d\d$/u)
    expect(lessonChange(schoolBoard)).toBeNull()
  })
})

describe('route editor validation', () => {
  it('accepts a minimal route and rejects missing or equal stops', () => {
    expect(validateRoute(validRoute())).toEqual([])
    expect(validateRoute(emptyRoute())).toEqual(['from', 'to'])
    expect(validateRoute({ ...validRoute(), to: validRoute().from })).toEqual(['same'])
    expect(validateRoute({ ...validRoute(), name: 'x'.repeat(41) })).toEqual(['name'])
  })
  it('checks times, days and the buffer per schedule mode', () => {
    const withSchedule = (schedule: Partial<CommuteRoute['schedule']>) => ({ ...validRoute(), schedule: { ...validRoute().schedule, ...schedule } })
    expect(validateRoute(withSchedule({ mode: 'times', times: [] }))).toEqual(['times'])
    expect(validateRoute(withSchedule({ mode: 'times', times: ['25:00'] }))).toEqual(['times'])
    expect(validateRoute(withSchedule({ mode: 'times', times: ['07:05', '07:40'] }))).toEqual([])
    expect(validateRoute(withSchedule({ mode: 'times', times: Array(7).fill('07:05') }))).toEqual(['times'])
    expect(validateRoute(withSchedule({ mode: 'firstLesson', days: [] }))).toEqual(['days'])
    expect(validateRoute(withSchedule({ mode: 'lastLesson', bufferMinutes: 61 }))).toEqual(['buffer'])
    expect(validateRoute(withSchedule({ mode: 'lastLesson', bufferMinutes: Number.NaN }))).toEqual(['buffer'])
    expect(validateRoute(withSchedule({ mode: 'none', days: [], times: ['zz'] }))).toEqual([])
  })
  it('normalizes before saving and keeps the list within the limit', () => {
    const route = normalizeRoute({ ...validRoute(), name: '  Schule ', via: { id: '', name: '', type: 'other' }, schedule: { mode: 'times', times: ['07:40', '07:05', '07:05'], days: [5, 1, 1], bufferMinutes: 10 } })
    expect(route).toMatchObject({ name: 'Schule', via: null, schedule: { times: ['07:05', '07:40'], days: [1, 5] } })
    expect(normalizeRoute({ ...validRoute(), schedule: { mode: 'none', times: ['07:00'], days: [1], bufferMinutes: 10 } }).schedule.times).toEqual([])
    let list: CommuteRoute[] = []
    for (let i = 0; i < MAX_ROUTES + 2; i++) list = upsertRoute(list, { ...validRoute(), id: `route${i}`.padEnd(12, '0') })
    expect(list).toHaveLength(MAX_ROUTES)
    expect(upsertRoute(list, { ...list[0], name: 'Neu' })[0].name).toBe('Neu')
    expect(moveRoute([1, 2, 3], 0, 1)).toEqual([2, 1, 3])
    expect(moveRoute([1, 2, 3], 0, -1)).toEqual([1, 2, 3])
  })
})

describe('stop autocomplete', () => {
  const stops: Stop[] = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `Stop ${i}`, type: 'bus' as const }))
  const make = (search: (query: string) => Promise<Stop[]>) => {
    const events = { busy: [] as boolean[], results: [] as Stop[][], errors: 0 }
    const searcher = createStopSearcher(search, { onBusy: (b) => events.busy.push(b), onResult: (r) => events.results.push(r), onError: () => { events.errors += 1 } })
    return { searcher, events }
  }
  it('waits 250 ms, needs 2 characters and searches once for a burst of keystrokes', async () => {
    vi.useFakeTimers()
    const search = vi.fn(async (query: string) => stops.filter((stop) => stop.name.includes(query.slice(0, 1))).slice(0, 12))
    const { searcher, events } = make(search)
    searcher.input('S')
    vi.advanceTimersByTime(1000)
    expect(search).not.toHaveBeenCalled()
    expect(events.results.at(-1)).toEqual([])
    searcher.input('St')
    searcher.input('Sto')
    vi.advanceTimersByTime(249)
    expect(search).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('Sto')
    await vi.runAllTimersAsync()
    expect(events.results.at(-1)).toHaveLength(10)
    expect(events.busy.at(-1)).toBe(false)
  })
  it('ignores a slow answer that a newer query replaced and reports failures', async () => {
    vi.useFakeTimers()
    let release: (stops: Stop[]) => void = () => undefined
    const search = vi.fn(() => new Promise<Stop[]>((resolve) => { release = resolve }))
    const { searcher, events } = make(search)
    searcher.input('Aa')
    vi.advanceTimersByTime(250)
    const stale = release
    searcher.input('Ab')
    stale([stops[0]])
    await vi.runAllTimersAsync()
    expect(events.results.every((result) => result.length === 0)).toBe(true)
    const failing = make(async () => { throw new Error('offline') })
    failing.searcher.input('Zu')
    await vi.runAllTimersAsync()
    expect(failing.events.errors).toBe(1)
  })
})

describe('navigation', () => {
  it('puts Pendeln before Settings with its own shortcuts', () => {
    expect(VIEWS.slice(-2)).toEqual(['commute', 'settings'])
    expect(shortcutFor({ key: '7' })).toEqual({ type: 'view', view: 'commute' })
    expect(shortcutFor({ key: '8' })).toEqual({ type: 'view', view: 'settings' })
    expect(shortcutFor({ key: 'w' }, true)).toEqual({ type: 'view', view: 'commute' })
  })
})

describe('api client', () => {
  it('sends the commute calls with CSRF on the write only', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const api = createApi(async (url, init) => {
      seen.push({ url, init })
      if (url.endsWith('/session')) return new Response(JSON.stringify({ signedIn: true, csrf: 'tok', connections: [] }), { status: 200 })
      return new Response('{"routes":[],"stops":[],"boards":[],"trips":[]}', { status: 200 })
    })
    await api.session()
    await api.commute('abcdefabcdef')
    await api.saveCommute('abcdefabcdef', [], { delayThreshold: 3, hiddenLabels: [] })
    await api.commuteStops('abcdefabcdef', 'Schul stadt')
    await api.commuteBoard('abcdefabcdef', 'r1')
    await api.commuteTrips('abcdefabcdef', 'r1', '2026-11-13T07:05:00+01:00', 'arrive')
    const [, read, write, stopsCall, board, trips] = seen
    const header = (call: { init: RequestInit }) => (call.init.headers as Record<string, string>)['X-Kanti-CSRF']
    expect(header(read)).toBeUndefined()
    expect(write.init.method).toBe('PUT')
    expect(header(write)).toBe('tok')
    expect(JSON.parse(write.init.body as string)).toEqual({ routes: [], settings: { delayThreshold: 3, hiddenLabels: [] } })
    expect(stopsCall.url).toBe('/api/v1/kanti-web/connections/abcdefabcdef/commute/stops?q=Schul%20stadt')
    expect(board.url).toContain('/commute/board?route=r1')
    expect(trips.url).toContain('/commute/trips?route=r1&at=2026-11-13T07%3A05%3A00%2B01%3A00&timeType=arrive')
  })
})

describe('rendering', () => {
  const delayedTrip = schoolBoard.trips[0]
  it('renders a delayed trip with the planned time struck, a badge and a changed platform', () => {
    for (const t of [de, en]) {
      const html = renderToString(<TripCard trip={delayedTrip} t={t} />)
      expect(html).toContain('trip-moderate')
      expect(html).toContain('<s class="trip-planned">')
      expect(html).toContain(t.delayMinutes(4))
      expect(html).toContain('platform-changed')
      expect(html).toContain(t.platformChanged)
      expect(html).toContain('line-chip-colored')
      expect(html).toContain('background:#1f6fb5')
    }
  })
  it('renders the quietest badge, occupancy and transfers', () => {
    const quiet = schoolBoard.trips[1]
    const html = renderToString(<TripCard trip={quiet} t={de} open />)
    expect(html).toContain(de.quietest)
    expect(html).toContain('occupancy-class level-1')
    expect(html).toContain(de.transferAt('Schulstadt', 3))
    expect(html).toContain('xfer')
  })
  it('marks tight and broken transfers', () => {
    const tight: Trip = { ...schoolBoard.trips[1], changes: [{ at: 'Schulstadt', minutes: 2, plannedMinutes: 3, broken: false, tight: true }] }
    expect(renderToString(<TripCard trip={tight} t={de} open />)).toContain('transfer-tight')
    const broken: Trip = { ...schoolBoard.trips[1], status: 'broken', changes: [{ at: 'Schulstadt', minutes: -2, plannedMinutes: 3, broken: true, tight: false }] }
    const html = renderToString(<TripCard trip={broken} t={de} open />)
    expect(html).toContain('transfer-broken')
    expect(html).toContain(de.tripBroken)
    expect(html).toContain('trip-cancelled')
  })
  it('renders the delay badge colours', () => {
    expect(renderToString(<DelayBadge delay={0} t={de} />)).toContain('delay-ok')
    expect(renderToString(<DelayBadge delay={2} t={de} />)).toContain('delay-minor')
    expect(renderToString(<DelayBadge delay={7} t={de} />)).toContain('delay-major')
    const cancelled = renderToString(<DelayBadge delay={null} cancelled t={en} />)
    expect(cancelled).toContain('delay-cancelled')
    expect(cancelled).toContain('Cancelled')
  })
  it('renders a chip without colours using the theme', () => {
    const html = renderToString(<LineChip leg={{ line: '366', category: 'B', type: 'bus', bgColor: '', fgColor: '', kind: 'ride' }} />)
    expect(html).not.toContain('line-chip-colored')
    expect(html).toContain('366')
  })
  it('shows the cancellation banner with alternatives, the via note and the lesson change', () => {
    const html = renderToString(<BoardBody route={home} board={homeBoard} trips={homeBoard.trips} t={de} />)
    expect(html).toContain(de.bannerCancelled)
    expect(html).toContain(de.alternatives)
    expect(html).toContain(de.viaDropped)
    expect(html).toContain('Letzte Stunde fällt aus – nimm den IR16 um')
    expect(html).toContain(de.occupancyNote)
    expect(de.occupancyNote).toBe('Auslastungsprognose pro Zug und Klasse (SBB/search.ch). Wagen-genaue Angaben sind noch nicht verfügbar.')
    expect(html).not.toContain(de.boardStale(''))
  })
  it('shows the later-to-school banner, the stale note and the empty state', () => {
    const later = { ...schoolBoard, target: { ...schoolBoard.target, lessonChange: 'firstCancelled' as const, plannedAt: schoolBoard.target.at }, stale: true }
    expect(renderToString(<LessonChangeBanner board={later} t={de} />)).toContain('Später zur Schule')
    const body = renderToString(<BoardBody board={later} trips={[]} t={de} />)
    expect(body).toContain(de.boardStale(clockOf(later.updatedAt)))
    expect(body).toContain(de.boardNoTrips)
    expect(renderToString(<BoardBody board={schoolBoard} trips={schoolBoard.trips} t={de} onEarlier={() => undefined} onLater={() => undefined} />)).toContain(de.boardLater)
  })
  it('renders the demo in the Pendeln view and on Today, in both languages', () => {
    const view = renderToString(<KantiProvider api={createApi(async () => new Response('{}'))} demo><Commute /></KantiProvider>)
    expect(view).toContain('Testdorf')
    expect(view).toContain('trip-head')
    const card = renderToString(<KantiProvider api={createApi(async () => new Response('{}'))} demo><Today /></KantiProvider>)
    expect(card).toContain('commute-card')
    expect(card).toMatch(/Pendeln|Commute/u)
  })
  it('has every commute string in both languages', () => {
    const keys = (strings: object) => Object.keys(strings).filter((key) => /commute|trip|board|occupancy|transfer|delay|platform|target|schedule|stop|alternatives|quietest|lastCancelled|firstCancelled/u.test(key)).sort()
    expect(keys(de)).toEqual(keys(en))
    expect(de.commute).toBe('Pendeln')
    expect(de.alertNames.commuteLessonEnd).toBeTruthy()
    expect(en.alertNames.commuteLessonEnd).toBeTruthy()
  })
})

describe('two vias and pins', () => {
  const stop = (id: string): Stop => ({ id, name: `Halt ${id}`, type: 'train' })
  const pin = (extra: Partial<Pin> = {}): Pin => ({ days: [1, 2, 3, 4, 5], line: 'IR 16', trainNo: '1234', stop: 'Aarau', stopId: 'aarau', departure: '07:12', arrival: '07:41', transfers: 1, ...extra })

  it('reads a route without vias as [via] and with vias as they are', () => {
    const old = { ...validRoute(), via: stop('v1') } as Partial<CommuteRoute>
    delete old.vias
    delete old.pins
    expect(routeVias(old)).toEqual([stop('v1')])
    const read = readRoute(old as CommuteRoute)
    expect(read).toMatchObject({ vias: [stop('v1')], via: stop('v1'), pins: [] })
    expect(readRoute({ ...validRoute(), vias: [stop('x'), stop('y'), stop('z')], via: null }).vias.map((v) => v.id)).toEqual(['x', 'y'])
    expect(routeVias({ via: null })).toEqual([])
  })
  it('saves vias (max 2, ordered, no duplicates or ends), via = first and cleaned pins', () => {
    const route = normalizeRoute({ ...validRoute(), vias: [stop('x'), stop('x'), { id: '', name: '', type: 'other' }, stop('y'), stop('z')], via: null, pins: [pin({ days: [5, 1, 1] }), pin({ days: [1, 2], departure: '08:00' }), pin({ days: [3], departure: '99:00' })] })
    expect(route.vias.map((v) => v.id)).toEqual(['x', 'y'])
    expect(route.via?.id).toBe('x')
    expect(route.pins).toHaveLength(2)
    expect(route.pins[0].days).toEqual([1, 5])
    expect(route.pins[1].days).toEqual([2])
    expect(normalizeRoute({ ...validRoute(), vias: [{ id: 'a', name: 'Testdorf', type: 'train' }, stop('y')], via: null }).vias.map((v) => v.id)).toEqual(['y'])
    expect(normalizeRoute(validRoute())).toMatchObject({ vias: [], via: null, pins: [] })
    expect(cleanPins(undefined)).toEqual([])
  })
  it('keeps a weekday in one pin only and merges the same connection', () => {
    const base = [pin({ days: [1, 2, 3, 4, 5] })]
    const wed = assignPin(base, pin({ days: [3], departure: '07:40', line: 'S 29' }))
    expect(wed.map((p) => [p.departure, p.days])).toEqual([['07:12', [1, 2, 4, 5]], ['07:40', [3]]])
    const back = assignPin(wed, pin({ days: [3] }))
    expect(back).toHaveLength(1)
    expect(back[0].days).toEqual([1, 2, 3, 4, 5])
    expect(removePinDay(back, 3)[0].days).toEqual([1, 2, 4, 5])
    expect(removePinDay([pin({ days: [2] })], 2)).toEqual([])
  })
  it('derives the editor mode from the pins', () => {
    const schedule = validRoute().schedule
    expect(pinModeOf({ pins: [], schedule })).toBe('none')
    expect(pinModeOf({ pins: [pin()], schedule })).toBe('daily')
    expect(pinModeOf({ pins: [pin({ days: [1] })], schedule })).toBe('weekday')
    expect(pinModeOf({ pins: [pin({ days: [1, 2] }), pin({ days: [3, 4, 5], departure: '08:00' })], schedule })).toBe('weekday')
  })
  it('turns a trip into a pin and picks the default time from the schedule', () => {
    const trip = demoConnections(demo.routes[0].from, demo.routes[0].to, [], '2026-11-13T06:30:00+01:00')[0]
    expect(pinFromTrip(trip, [5, 1])).toMatchObject({ days: [1, 5], line: 'IR16', departure: clockOf(trip.plannedDeparture) })
    expect(pinFromTrip({ ...trip, pin: null }, [1])).toBeNull()
    const schedule = validRoute().schedule
    expect(defaultPickTime({ ...schedule, mode: 'times', times: ['07:40', '07:05'] })).toBe('07:05')
    expect(defaultPickTime({ ...schedule, mode: 'firstLesson' })).toBe('06:30')
    expect(defaultPickTime({ ...schedule, mode: 'lastLesson' })).toBe('12:00')
    expect(defaultPickTime(schedule)).toBe('06:30')
  })
  it('finds the next date with a weekday and builds Zurich times', () => {
    const wednesday = Date.parse('2026-11-11T10:00:00+01:00')
    expect(isoWeekday('2026-11-11')).toBe(3)
    expect(nextDateForWeekday(3, wednesday)).toBe('2026-11-11')
    expect(nextDateForWeekday(1, wednesday)).toBe('2026-11-16')
    expect(nextDateForWeekday(2, Date.parse('2026-12-31T23:30:00+01:00'))).toBe('2027-01-05')
    expect(zurichAt('2026-11-16', '07:05')).toBe('2026-11-16T07:05:00+01:00')
    expect(zurichAt('2026-07-14', '07:05')).toBe('2026-07-14T07:05:00+02:00')
  })
  it('builds the connections query with stop ids (names as fallback) and pages by planned departure', () => {
    const route = { from: stop('a'), to: { id: '', name: 'Ziel', type: 'bus' as const }, vias: [stop('v1'), stop('v2')] }
    expect(connectionsQuery(route, 'AT')).toEqual({ from: 'a', to: 'Ziel', vias: ['v1', 'v2'], at: 'AT', timeType: 'depart' })
    const trips = demoConnections(stop('a'), stop('b'), [], '2026-11-13T06:30:00+01:00')
    expect(trips).toHaveLength(8)
    const last = trips[trips.length - 1]
    expect(pickerPage(trips, 'later')).toBe(isoZurich(Date.parse(last.plannedDeparture) + 60_000))
    expect(pickerPage(trips, 'earlier')).toBe(isoZurich(Date.parse(trips[0].plannedDeparture) - 60 * 60_000))
    expect(pickerPage([], 'later')).toBeNull()
  })
  it('api: the connections request repeats via and carries at and timeType', async () => {
    const seen: string[] = []
    const api = createApi(async (url) => { seen.push(String(url)); return new Response(JSON.stringify({ trips: [] }), { status: 200, headers: { 'content-type': 'application/json' } }) })
    await api.commuteConnections('abcdefabcdef', { from: 'a', to: 'b', vias: ['v1', 'v 2'], at: '2026-11-13T07:05:00+01:00', timeType: 'depart' })
    expect(seen[0]).toBe('/api/v1/kanti-web/connections/abcdefabcdef/commute/connections?from=a&to=b&via=v1&via=v%202&at=2026-11-13T07%3A05%3A00%2B01%3A00&timeType=depart')
  })
})

describe('pinned board focus', () => {
  const pinnedBoard = demo.boards[demo.routes.find((route) => route.pins.length)!.id]
  const withState = (patch: Partial<NonNullable<RouteBoard['pinned']>>, extra: Partial<RouteBoard> = {}): RouteBoard => ({ ...pinnedBoard, pinned: { ...pinnedBoard.pinned!, ...patch }, ...extra })

  it('has no focus on a plain route', () => {
    const focus = boardFocus(schoolBoard)
    expect(focus.mode).toBe('plain')
    expect(focus.others).toEqual(schoolBoard.trips)
    expect(boardFocus(undefined).mode).toBe('plain')
  })
  it('focuses the pinned trip and moves the others behind the expander', () => {
    const focus = boardFocus(pinnedBoard)
    expect(focus).toMatchObject({ mode: 'pinned', status: 'ok', broken: false, movedTo: '' })
    expect(focus.trip?.id).toBe(pinnedBoard.pinned!.trip!.id)
    expect(focus.others.map((trip) => trip.id)).not.toContain(focus.trip!.id)
    expect(focus.others).toHaveLength(pinnedBoard.trips.length - 1)
  })
  it('reports moved, broken (cancelled and gone) and missing', () => {
    const trip = pinnedBoard.pinned!.trip!
    expect(boardFocus(withState({ status: 'moved' })).movedTo).toBe(clockOf(trip.plannedDeparture))
    const cancelled = { ...trip, status: 'cancelled' as const }
    expect(boardFocus(withState({ trip: cancelled })).broken).toBe(true)
    expect(boardFocus(withState({ status: 'gone', trip })).broken).toBe(true)
    const nearest = pinnedBoard.trips[0]
    const missing = boardFocus(withState({ status: 'missing', trip: null, nearest }))
    expect(missing).toMatchObject({ status: 'missing', trip: null, nearest })
    expect(missing.others.map((other) => other.id)).not.toContain(nearest.id)
  })
  it('suggests the server change trip for a pinned route', () => {
    const change = pinnedBoard.trips[0]
    const board = withState({}, { target: { ...pinnedBoard.target, lessonChange: 'lastCancelled', plannedAt: null }, change })
    expect(lessonChange(board)).toMatchObject({ kind: 'lastCancelled', pinned: true, time: clockOf(change.departure), arrival: clockOf(change.arrival) })
    expect(lessonChange({ ...board, change: null })).toBeNull()
  })

  it('renders the pinned trip with its label, delay, and the notices', () => {
    for (const t of [de, en]) {
      const html = renderToString(<PinnedFocus board={pinnedBoard} t={t} />)
      expect(html).toContain('trip-pinned')
      expect(html).toContain(t.pinnedBadge)
      expect(html).toContain(t.delayMinutes(2))
      expect(html).not.toContain('class="alternatives"')
    }
    expect(renderToString(<PinnedFocus board={withState({ status: 'moved' })} t={de} />)).toContain(de.pinMoved(clockOf(pinnedBoard.pinned!.trip!.plannedDeparture)))
    const missing = renderToString(<PinnedFocus board={withState({ status: 'missing', trip: null, nearest: pinnedBoard.trips[0] })} t={de} onRepick={() => undefined} />)
    expect(missing).toContain(de.pinMissing(pinnedBoard.pinned!.pin.departure, 'IR16', pinnedBoard.pinned!.pin.stop, `${pinnedBoard.pinned!.day.slice(8, 10)}.${pinnedBoard.pinned!.day.slice(5, 7)}.`))
    expect(missing).toContain(de.pinRepick)
    expect(missing).toContain(de.pinNearest)
  })
  it('puts alternatives first when the pinned connection is cancelled and hides the others by default', () => {
    const cancelled = { ...pinnedBoard.pinned!.trip!, status: 'cancelled' as const, issues: [{ kind: 'cancelled' as const, text: 'Zug fällt aus' }] }
    const alt = pinnedBoard.trips[0]
    const board = withState({ trip: cancelled }, { alternatives: [alt] })
    const html = renderToString(<BoardBody board={board} trips={board.trips} t={de} onEarlier={() => undefined} onLater={() => undefined} />)
    expect(html).toContain(de.bannerCancelled)
    expect(html).toContain('class="alternatives"')
    expect(html).toContain(de.othersShow)
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain(de.boardEarlier)
  })
  it('a plain board still lists the trips directly', () => {
    const html = renderToString(<BoardBody board={schoolBoard} trips={schoolBoard.trips} t={de} onEarlier={() => undefined} />)
    expect(html).toContain(de.boardEarlier)
    expect(html).not.toContain(de.othersShow)
  })
  it('the demo has a pinned route and a route with two vias', () => {
    expect(demo.routes.some((route) => route.pins.length === 1)).toBe(true)
    expect(demo.routes.some((route) => route.vias.length === 2 && route.via?.id === route.vias[0].id)).toBe(true)
  })
})
