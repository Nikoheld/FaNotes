// Pendelstrecken: delay classes, relevant route, polling rules, editor validation, stop autocomplete and rendering.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { shortcutFor, VIEWS } from '../src/lib/shortcuts'
import { createApi } from '../src/lib/api'
import {
  browseRequest, chipColors, clockOf, createStopSearcher, delayClass, durationLabel, emptyRoute, focusDue, hiddenLabelsFor, isoZurich, lessonChange, mergeTrips, moveRoute,
  newRouteId, nextTrip, normalizeRoute, pollDue, relevantRoute, sameLabels, upsertRoute, validateRoute, MAX_ROUTES,
} from '../src/lib/commute'
import { demoCommute } from '../src/lib/demo-commute'
import { detectGroupSets } from '../src/lib/groups'
import { STRINGS } from '../src/lib/i18n'
import { BoardBody, DelayBadge, LessonChangeBanner, LineChip, TripCard } from '../src/components/commute'
import { KantiProvider } from '../src/state'
import { Today } from '../src/views/Today'
import { Commute } from '../src/views/Commute'
import type { CommuteRoute, Stop, Trip } from '../src/types'

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
  it('derives the hidden lesson labels from the half-class choices', () => {
    const weekly = (label: string, hour: number) => [0, 1, 2].map((week) => ({
      id: `${label}-${week}`, eventType: 'lesson', start: `2026-11-${String(2 + week * 7).padStart(2, '0')}T${hour}:00:00`, end: `2026-11-${String(2 + week * 7).padStart(2, '0')}T${hour}:45:00`,
      text: label, courseName: label, courseId: label, room: '', teachers: [], status: '', comment: '', timetableText: '', color: '',
    }))
    const sets = detectGroupSets([...weekly('Sport-Sem1', 9), ...weekly('Sport-Sem2', 9)] as never)
    expect(sets).toHaveLength(1)
    expect(hiddenLabelsFor(sets, {})).toEqual([])
    expect(hiddenLabelsFor(sets, { [sets[0].key]: ['Sport-Sem1'] })).toEqual(['sport-sem2'])
    expect(hiddenLabelsFor(sets, { [sets[0].key]: ['Gone'] })).toEqual([])
    expect(sameLabels(['A', 'b'], ['b', 'a'])).toBe(true)
    expect(sameLabels(['a'], [])).toBe(false)
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
