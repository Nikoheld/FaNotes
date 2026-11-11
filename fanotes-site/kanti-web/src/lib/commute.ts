// Pendelstrecken: the pure logic behind the Pendeln view, the Today card and the route editor.
// Nothing here touches the network or React, so all of it is unit-tested.
import type { CommuteRoute, CommuteSettings, Leg, Occupancy, OccupancyLevel, RouteBoard, Schedule, ScheduleMode, Stop, Trip } from '../types'
import type { GroupChoices, GroupSet } from './groups'

export const MAX_ROUTES = 8
export const MAX_TIMES = 6
export const MAX_NAME = 40
export const THRESHOLDS = [2, 3, 5, 10]
export const DEFAULT_THRESHOLD = 3
/** The server caches a board for 30 s: the page never asks more often. */
export const BOARD_MIN_MS = 30_000
export const POLL_EVERY_MS = 60_000
/** Poll only while a trip leaves within this window. */
export const POLL_WINDOW_MS = 30 * 60_000
export const SEARCH_DELAY_MS = 250
export const SEARCH_MIN_CHARS = 2
export const DEFAULT_DAYS = [1, 2, 3, 4, 5]

// ---------------------------------------------------------------- times

/** 'HH:MM' of an ISO time that already carries the Zurich offset; '' when it is not one. */
export const clockOf = (iso: string): string => {
  const match = /T(\d{2}:\d{2})/u.exec(iso || '')
  return match ? match[1] : ''
}

export const timeMs = (iso: string): number => {
  const ms = Date.parse(iso || '')
  return Number.isFinite(ms) ? ms : NaN
}

const ZURICH_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Zurich', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
})

/** An instant as ISO 8601 with the Zurich offset, the way the server writes times. */
export const isoZurich = (ms: number): string => {
  const parts: Record<string, string> = {}
  for (const part of ZURICH_PARTS.formatToParts(new Date(ms))) parts[part.type] = part.value
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  const offset = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000)
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/** '1 h 05 min' / '42 min'. */
export const durationLabel = (minutes: number): string => {
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) return `${total} min`
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')} min`
}

// ---------------------------------------------------------------- delays and trips

export type DelayClass = 'ok' | 'minor' | 'moderate' | 'major' | 'cancelled'

/** on time / +1-2 / +3-5 / >5 minutes / cancelled. Early (negative) counts as on time. */
export const delayClass = (delay: number | null | undefined, cancelled = false): DelayClass => {
  if (cancelled) return 'cancelled'
  const minutes = typeof delay === 'number' && Number.isFinite(delay) ? delay : 0
  if (minutes <= 0) return 'ok'
  if (minutes <= 2) return 'minor'
  if (minutes <= 5) return 'moderate'
  return 'major'
}

export const tripCancelled = (trip: Trip): boolean => trip.status === 'cancelled' || trip.status === 'broken'

export const rideLegs = (trip: Trip): Leg[] => trip.legs.filter((leg) => leg.kind === 'ride')

/** The delay shown next to the departure: the trip's own, or the first ride's. */
export const departureDelay = (trip: Trip): number | null => trip.depDelay ?? rideLegs(trip)[0]?.from.delay ?? null

/** Platform of the first ride leg. */
export const departurePlatform = (trip: Trip): { platform: string; changed: boolean } => {
  const first = rideLegs(trip)[0]
  return { platform: first?.from.platform || '', changed: first?.from.platformChanged === true }
}

/** Colour pair of a line chip as CSS values; '' when the provider sent none (the chip then uses the theme). */
export const chipColors = (leg: Pick<Leg, 'bgColor' | 'fgColor'>): { background?: string; color?: string } => {
  const hex = (value: string) => (/^[0-9a-f]{6}$/iu.test(value || '') ? `#${value}` : /^[0-9a-f]{3}$/iu.test(value || '') ? `#${value}` : '')
  const background = hex(leg.bgColor)
  const color = hex(leg.fgColor)
  return { ...(background ? { background } : {}), ...(color ? { color } : {}) }
}

export const occupancyLevel = (value: OccupancyLevel | undefined): 0 | 1 | 2 | 3 => (value === 1 || value === 2 || value === 3 ? value : 0)

export const hasOccupancy = (occupancy: Occupancy | undefined): boolean => Boolean(occupancy && (occupancy.first || occupancy.second))

/** Trips by planned departure, extra (browsed) trips merged in, ids unique; the board's own copy wins. */
export const mergeTrips = (board: Trip[], extra: Trip[]): Trip[] => {
  const seen = new Set<string>()
  const out: Trip[] = []
  for (const trip of [...board, ...extra]) {
    if (seen.has(trip.id)) continue
    seen.add(trip.id)
    out.push(trip)
  }
  return out.sort((a, b) => (timeMs(a.plannedDeparture) || timeMs(a.departure)) - (timeMs(b.plannedDeparture) || timeMs(b.departure)))
}

/** The request for earlier or later trips around the ones shown. */
export const browseRequest = (trips: Trip[], direction: 'earlier' | 'later'): { at: string; timeType: 'depart' | 'arrive' } | null => {
  if (!trips.length) return null
  if (direction === 'later') {
    const last = trips.reduce((a, b) => (timeMs(b.departure) > timeMs(a.departure) ? b : a))
    const ms = timeMs(last.departure)
    return Number.isFinite(ms) ? { at: isoZurich(ms + 60_000), timeType: 'depart' } : null
  }
  const first = trips.reduce((a, b) => (timeMs(b.arrival) < timeMs(a.arrival) ? b : a))
  const ms = timeMs(first.arrival)
  return Number.isFinite(ms) ? { at: isoZurich(ms - 60_000), timeType: 'arrive' } : null
}

export interface LessonChange { kind: 'lastCancelled' | 'firstCancelled'; line: string; time: string; plannedTime: string }

/** The lesson-change banner: what to take instead, from the board's best trip. */
export const lessonChange = (board: RouteBoard | undefined): LessonChange | null => {
  if (!board || board.target.lessonChange === 'none') return null
  const kind = board.target.lessonChange
  const trip = board.trips.find((candidate) => !tripCancelled(candidate)) || board.trips[0]
  if (!trip) return null
  const line = rideLegs(trip)[0]?.line || ''
  const time = clockOf(kind === 'lastCancelled' ? trip.departure : trip.departure)
  return { kind, line, time, plannedTime: clockOf(board.target.plannedAt || '') }
}

// ---------------------------------------------------------------- relevant route

export interface RelevantInput { routes: CommuteRoute[]; boards: Record<string, RouteBoard>; now: number; clockMinutes: number }

/** First usable trip of a board (not cancelled, not long gone). */
export const nextTrip = (board: RouteBoard | undefined, now: number): Trip | null => {
  if (!board) return null
  return board.trips.find((trip) => !tripCancelled(trip) && !(timeMs(trip.departure) < now - 60_000)) || null
}

/**
 * The route the Today card shows: morning (before noon) the way to school (first-lesson route),
 * afternoon the way home (last-lesson route), otherwise - or when none of those exists - the route
 * whose target is soonest. Routes without a board yet still count as a last resort.
 */
export const relevantRoute = ({ routes, boards, now, clockMinutes }: RelevantInput): CommuteRoute | null => {
  if (!routes.length) return null
  const distance = (route: CommuteRoute) => {
    const at = timeMs(boards[route.id]?.target.at || '')
    return Number.isFinite(at) ? at - now : Number.POSITIVE_INFINITY
  }
  // A target more than an hour in the past is over for the day.
  const open = routes.filter((route) => distance(route) > -60 * 60_000)
  const pool = open.length ? open : routes
  const soonest = (list: CommuteRoute[]) => [...list].sort((a, b) => distance(a) - distance(b))[0] || null
  const wanted = (route: CommuteRoute) => {
    const kind = boards[route.id]?.target.kind
    return clockMinutes < 12 * 60 ? (route.schedule.mode === 'firstLesson' || kind === 'firstLesson') : (route.schedule.mode === 'lastLesson' || kind === 'lastLesson')
  }
  return soonest(pool.filter(wanted)) || soonest(pool) || routes[0]
}

// ---------------------------------------------------------------- polling

/** Earliest upcoming departure over all boards, in ms (NaN when there is none). */
export const nextDeparture = (boards: Record<string, RouteBoard>, now: number): number => {
  let best = Number.NaN
  for (const board of Object.values(boards)) {
    for (const trip of board.trips) {
      if (tripCancelled(trip)) continue
      const at = timeMs(trip.departure)
      if (!Number.isFinite(at) || at < now - 2 * 60_000) continue
      if (!Number.isFinite(best) || at < best) best = at
    }
  }
  return best
}

/** The 60 s timer refreshes only while visible and a trip leaves within 30 minutes (or just left). */
export const pollDue = (input: { visible: boolean; boards: Record<string, RouteBoard>; lastAt: number; now: number; loading: boolean }): boolean => {
  if (!input.visible || input.loading) return false
  if (input.lastAt && input.now >= input.lastAt && input.now - input.lastAt < BOARD_MIN_MS) return false
  const next = nextDeparture(input.boards, input.now)
  return Number.isFinite(next) && next - input.now <= POLL_WINDOW_MS
}

/** Focus and visibility refresh whenever the last load is older than the server's cache. */
export const focusDue = (lastAt: number, now: number, loading: boolean): boolean => !loading && (!lastAt || now < lastAt || now - lastAt >= BOARD_MIN_MS)

// ---------------------------------------------------------------- routes

export const newRouteId = (): string => {
  const bytes = new Uint8Array(6)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const emptyStop = (): Stop => ({ id: '', name: '', type: 'other' })

export const emptySchedule = (mode: ScheduleMode = 'none'): Schedule => ({ mode, times: [], days: [...DEFAULT_DAYS], bufferMinutes: 10 })

export const emptyRoute = (id = newRouteId()): CommuteRoute => ({ id, name: '', from: emptyStop(), to: emptyStop(), via: null, schedule: emptySchedule(), delayThreshold: null, notify: true })

export const routeLabel = (route: Pick<CommuteRoute, 'name' | 'from' | 'to'>): string => route.name.trim() || `${route.from.name} → ${route.to.name}`

export const isClock = (value: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/u.test(value)

export type RouteError = 'from' | 'to' | 'same' | 'name' | 'times' | 'days' | 'buffer'

const sameStop = (a: Stop, b: Stop) => a.id !== '' && a.id === b.id

/** What is wrong with a route draft; empty means it can be saved. */
export const validateRoute = (route: CommuteRoute): RouteError[] => {
  const errors: RouteError[] = []
  if (!route.from.id || !route.from.name) errors.push('from')
  if (!route.to.id || !route.to.name) errors.push('to')
  if (route.from.id && sameStop(route.from, route.to)) errors.push('same')
  if (route.name.trim().length > MAX_NAME) errors.push('name')
  const { mode, times, days, bufferMinutes } = route.schedule
  if (mode === 'times' && (!times.length || times.length > MAX_TIMES || times.some((time) => !isClock(time)))) errors.push('times')
  if (mode !== 'none' && !days.length) errors.push('days')
  if ((mode === 'firstLesson' || mode === 'lastLesson') && !(Number.isInteger(bufferMinutes) && bufferMinutes >= 0 && bufferMinutes <= 60)) errors.push('buffer')
  return errors
}

/** The route as it is saved: trimmed name, sorted unique times and days, empty via dropped. */
export const normalizeRoute = (route: CommuteRoute): CommuteRoute => ({
  ...route,
  name: route.name.trim().slice(0, MAX_NAME),
  via: route.via && route.via.id ? route.via : null,
  schedule: {
    mode: route.schedule.mode,
    times: route.schedule.mode === 'times' ? [...new Set(route.schedule.times)].sort() : [],
    days: [...new Set(route.schedule.days)].filter((day) => day >= 1 && day <= 7).sort((a, b) => a - b),
    bufferMinutes: Math.min(60, Math.max(0, Math.round(route.schedule.bufferMinutes) || 0)),
  },
})

/** Adds or replaces a route; the list never grows past the server's limit. */
export const upsertRoute = (routes: CommuteRoute[], route: CommuteRoute): CommuteRoute[] => {
  const index = routes.findIndex((candidate) => candidate.id === route.id)
  if (index >= 0) return routes.map((candidate, at) => (at === index ? route : candidate))
  return routes.length >= MAX_ROUTES ? routes : [...routes, route]
}

export const moveRoute = <T,>(list: T[], index: number, delta: -1 | 1): T[] => {
  const target = index + delta
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list
  const copy = [...list]
  ;[copy[index], copy[target]] = [copy[target], copy[index]]
  return copy
}

// ---------------------------------------------------------------- hidden lessons

const lower = (text: string) => text.trim().toLowerCase()

/**
 * Lower-case labels of the lessons the user does not attend: in every half-class group set with a
 * choice, the options that were not chosen. The server ignores these lessons when it works out
 * the first and the last lesson of a day.
 */
export const hiddenLabelsFor = (sets: GroupSet[], choices: GroupChoices): string[] => {
  const out = new Set<string>()
  for (const set of sets) {
    const valid = new Set(set.options.map((option) => lower(option.label)))
    const chosen = new Set((choices[set.key] || []).map(lower).filter((label) => valid.has(label)))
    if (!chosen.size) continue
    for (const option of set.options) if (!chosen.has(lower(option.label))) out.add(lower(option.label))
  }
  return [...out].sort().slice(0, 200)
}

export const sameLabels = (a: readonly string[], b: readonly string[]): boolean => {
  const left = [...new Set(a.map(lower))].sort()
  const right = [...new Set(b.map(lower))].sort()
  return left.length === right.length && left.every((label, index) => label === right[index])
}

export const defaultSettings = (): CommuteSettings => ({ delayThreshold: DEFAULT_THRESHOLD, hiddenLabels: [] })

// ---------------------------------------------------------------- stop search

export interface StopSearcher {
  /** Called with every keystroke; searches after the delay, never for short text, ignores stale answers. */
  input: (text: string) => void
  cancel: () => void
}

export interface StopSearchEvents { onBusy: (busy: boolean) => void; onResult: (stops: Stop[]) => void; onError: () => void }

export const createStopSearcher = (
  search: (query: string) => Promise<Stop[]>,
  events: StopSearchEvents,
  delay = SEARCH_DELAY_MS,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void } = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
): StopSearcher => {
  let handle: unknown = null
  let serial = 0
  const cancel = () => {
    serial += 1
    if (handle != null) timers.clear(handle)
    handle = null
  }
  return {
    cancel,
    input: (text) => {
      cancel()
      const query = text.trim()
      if (query.length < SEARCH_MIN_CHARS) {
        events.onBusy(false)
        events.onResult([])
        return
      }
      const mine = serial
      events.onBusy(true)
      handle = timers.set(() => {
        handle = null
        search(query).then((stops) => {
          if (mine !== serial) return
          events.onBusy(false)
          events.onResult(stops.slice(0, 10))
        }, () => {
          if (mine !== serial) return
          events.onBusy(false)
          events.onError()
        })
      }, delay)
    },
  }
}
