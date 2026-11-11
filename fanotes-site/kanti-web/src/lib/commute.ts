// Pendelstrecken: the pure logic behind the Pendeln view, the Today card and the route editor.
// Nothing here touches the network or React, so all of it is unit-tested.
import type { CommuteRoute, CommuteSettings, Leg, Occupancy, OccupancyLevel, Pin, RouteBoard, Schedule, ScheduleMode, Stop, Trip } from '../types'

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
export const MAX_VIAS = 2

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

export interface LessonChange { kind: 'lastCancelled' | 'firstCancelled'; line: string; time: string; plannedTime: string; arrival: string; pinned: boolean }

/**
 * The lesson-change banner: what to take instead. A pinned route suggests the server's `change`
 * trip (the earlier way home / later way to school); others use the board's best trip.
 */
export const lessonChange = (board: RouteBoard | undefined): LessonChange | null => {
  if (!board || board.target.lessonChange === 'none') return null
  const kind = board.target.lessonChange
  const pinned = Boolean(board.pinned)
  const trip = pinned ? board.change : (board.trips.find((candidate) => !tripCancelled(candidate)) || board.trips[0])
  if (!trip) return null
  const line = rideLegs(trip)[0]?.line || ''
  return { kind, line, time: clockOf(trip.departure), plannedTime: clockOf(board.target.plannedAt || ''), arrival: clockOf(trip.arrival), pinned }
}

// ---------------------------------------------------------------- pinned focus

export interface BoardFocus {
  /** 'plain' for routes without a fixed connection: the board looks as it always did. */
  mode: 'plain' | 'pinned'
  status: 'ok' | 'moved' | 'missing' | 'gone' | null
  pin: Pin | null
  day: string
  /** The pinned connection live; null when it is missing from the timetable. */
  trip: Trip | null
  /** Pinned connection cancelled, broken or gone: the alternatives become prominent. */
  broken: boolean
  /** Planned departure 'HH:MM' of a moved connection. */
  movedTo: string
  /** Missing: the trip closest to the pinned time. */
  nearest: Trip | null
  /** Everything else (secondary, behind "Andere Verbindungen anzeigen"). */
  others: Trip[]
}

export const boardFocus = (board: RouteBoard | undefined, trips: Trip[] = board?.trips || []): BoardFocus => {
  const pinned = board?.pinned
  if (!board || !pinned) return { mode: 'plain', status: null, pin: null, day: '', trip: null, broken: false, movedTo: '', nearest: null, others: trips }
  const trip = pinned.trip || null
  const nearest = pinned.status === 'missing' ? pinned.nearest || null : null
  const skip = new Set([trip?.id, nearest?.id].filter(Boolean) as string[])
  return {
    mode: 'pinned',
    status: pinned.status,
    pin: pinned.pin,
    day: pinned.day,
    trip,
    broken: Boolean(trip && (tripCancelled(trip) || pinned.status === 'gone')),
    movedTo: pinned.status === 'moved' && trip ? clockOf(trip.plannedDeparture) : '',
    nearest,
    others: trips.filter((candidate) => !skip.has(candidate.id)),
  }
}

/** 'YYYY-MM-DD' as '13.11.'. */
export const dayLabel = (day: string): string => {
  const match = /^\d{4}-(\d{2})-(\d{2})$/u.exec(day || '')
  return match ? `${match[2]}.${match[1]}.` : day || ''
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

export const emptyRoute = (id = newRouteId()): CommuteRoute => ({ id, name: '', from: emptyStop(), to: emptyStop(), vias: [], via: null, schedule: emptySchedule(), pins: [], delayThreshold: null, notify: true })

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

/** The via stops of a route; a route read without `vias` (older server) has `[via]`. */
const rawVias = (route: { vias?: Stop[] | null; via?: Stop | null }): Stop[] => (Array.isArray(route.vias) ? route.vias : route.via ? [route.via] : []).filter((stop) => stop && stop.id)

export const routeVias = (route: { vias?: Stop[] | null; via?: Stop | null }): Stop[] => rawVias(route).slice(0, MAX_VIAS)

const cleanVias = (route: Pick<CommuteRoute, 'from' | 'to' | 'vias' | 'via'>): Stop[] => {
  const seen = new Set([route.from.id, route.to.id].filter(Boolean))
  const out: Stop[] = []
  for (const stop of rawVias(route)) {
    if (seen.has(stop.id)) continue
    seen.add(stop.id)
    out.push(stop)
  }
  return out.slice(0, MAX_VIAS)
}

const cleanDays = (days: readonly number[]): number[] => [...new Set(days)].filter((day) => Number.isInteger(day) && day >= 1 && day <= 7).sort((a, b) => a - b)

/** Pins as saved: valid times, sorted unique days, every weekday in one pin only (the first wins). */
export const cleanPins = (pins: readonly Pin[] | null | undefined): Pin[] => {
  const used = new Set<number>()
  const out: Pin[] = []
  for (const pin of pins || []) {
    if (!pin || !isClock(pin.departure || '')) continue
    const days = cleanDays(pin.days || []).filter((day) => !used.has(day))
    if (!days.length) continue
    for (const day of days) used.add(day)
    out.push({ ...pin, days, line: pin.line || '', trainNo: pin.trainNo || '', stop: pin.stop || '', stopId: pin.stopId || '', arrival: isClock(pin.arrival || '') ? pin.arrival : '', transfers: Math.max(0, Math.round(pin.transfers) || 0) })
  }
  return out
}

/** A route as the server sent it: `vias` filled from `via` for older answers, pins always a list. */
export const readRoute = (route: CommuteRoute): CommuteRoute => {
  const vias = routeVias(route)
  return { ...route, vias, via: vias[0] || null, pins: cleanPins(route.pins) }
}

/** The route as it is saved: trimmed name, sorted unique times and days, vias (max 2), pins; sends `vias`, `via` (= first) and `pins`. */
export const normalizeRoute = (route: CommuteRoute): CommuteRoute => {
  const vias = cleanVias(route)
  return {
    ...route,
    name: route.name.trim().slice(0, MAX_NAME),
    vias,
    via: vias[0] || null,
    pins: cleanPins(route.pins),
    schedule: {
      mode: route.schedule.mode,
      times: route.schedule.mode === 'times' ? [...new Set(route.schedule.times)].sort() : [],
      days: cleanDays(route.schedule.days),
      bufferMinutes: Math.min(60, Math.max(0, Math.round(route.schedule.bufferMinutes) || 0)),
    },
  }
}

// ---------------------------------------------------------------- fixed connection (pins)

export type PinMode = 'none' | 'daily' | 'weekday'

/** The days a route travels: its schedule days, Monday to Friday without a schedule. */
export const travelDays = (schedule: Schedule): number[] => (schedule.mode !== 'none' && schedule.days.length ? cleanDays(schedule.days) : [...DEFAULT_DAYS])

/** One pin covering all travel days is "every day the same"; anything else is per weekday. */
export const pinModeOf = (route: Pick<CommuteRoute, 'pins' | 'schedule'>): PinMode => {
  if (!route.pins.length) return 'none'
  const days = travelDays(route.schedule)
  const [only] = route.pins
  return route.pins.length === 1 && days.every((day) => only.days.includes(day)) ? 'daily' : 'weekday'
}

/** The first departure time offered by the connection picker, from the schedule. */
export const defaultPickTime = (schedule: Schedule): string => {
  if (schedule.mode === 'times') {
    const first = [...schedule.times].filter(isClock).sort()[0]
    if (first) return first
  }
  return schedule.mode === 'lastLesson' ? '12:00' : '06:30'
}

const sameConnection = (a: Pin, b: Pin) => a.line === b.line && a.trainNo === b.trainNo && a.stopId === b.stopId && a.stop === b.stop && a.departure === b.departure

/** Pin from a picked trip; null for a walk-only trip. */
export const pinFromTrip = (trip: Trip, days: number[]): Pin | null => (trip.pin ? { ...trip.pin, days: cleanDays(days) } : null)

/** Adds a pin: its weekdays leave every other pin, the same connection merges, empty pins vanish. */
export const assignPin = (pins: readonly Pin[], pin: Pin): Pin[] => {
  const taken = new Set(pin.days)
  const rest = pins.map((other) => ({ ...other, days: other.days.filter((day) => !taken.has(day)) })).filter((other) => other.days.length)
  const merged = rest.find((other) => sameConnection(other, pin))
  if (merged) return rest.map((other) => (other === merged ? { ...other, days: cleanDays([...other.days, ...pin.days]) } : other))
  return [...rest, pin].sort((a, b) => a.days[0] - b.days[0])
}

/** Removes one weekday from the pins. */
export const removePinDay = (pins: readonly Pin[], day: number): Pin[] => pins.map((pin) => ({ ...pin, days: pin.days.filter((value) => value !== day) })).filter((pin) => pin.days.length)

export const pinForDay = (pins: readonly Pin[], day: number): Pin | null => pins.find((pin) => pin.days.includes(day)) || null

/** Identity of the stops: a pin only fits the route it was picked for. */
export const stopsKey = (route: Pick<CommuteRoute, 'from' | 'to' | 'vias'>): string => [route.from.id, ...routeVias(route).map((stop) => stop.id), route.to.id].join('>')

const ymd = (ms: number): string => isoZurich(ms).slice(0, 10)

/** 1 = Monday ... 7 = Sunday of a 'YYYY-MM-DD'. */
export const isoWeekday = (day: string): number => {
  const date = new Date(`${day}T00:00:00Z`)
  return ((date.getUTCDay() + 6) % 7) + 1
}

/** The next date (today included) with this weekday, Zurich time. */
export const nextDateForWeekday = (weekday: number, now: number): string => {
  const today = ymd(now)
  const ahead = (weekday - isoWeekday(today) + 7) % 7
  const date = new Date(`${today}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + ahead)
  return date.toISOString().slice(0, 10)
}

/** 'YYYY-MM-DD' + 'HH:MM' as ISO with the Zurich offset of that day. */
export const zurichAt = (day: string, clock: string): string => {
  const guess = Date.parse(`${day}T${clock}:00Z`)
  for (const hours of [1, 2]) {
    const candidate = isoZurich(guess - hours * 3_600_000)
    if (candidate.startsWith(`${day}T${clock}`)) return candidate
  }
  return isoZurich(guess - 3_600_000)
}

export interface ConnectionsQuery { from: string; to: string; vias: string[]; at: string; timeType: 'depart' | 'arrive' }

/** The picker's request: stop ids where present, names otherwise. */
export const connectionsQuery = (route: Pick<CommuteRoute, 'from' | 'to' | 'vias'>, at: string): ConnectionsQuery => {
  const ref = (stop: Stop) => stop.id || stop.name
  return { from: ref(route.from), to: ref(route.to), vias: routeVias(route).map(ref), at, timeType: 'depart' }
}

/** Later: after the last trip's planned departure (+1 min); earlier: 60 min before the first one. */
export const pickerPage = (trips: Trip[], direction: 'earlier' | 'later'): string | null => {
  if (!trips.length) return null
  const planned = (trip: Trip) => timeMs(trip.plannedDeparture || trip.departure)
  if (direction === 'later') {
    const last = Math.max(...trips.map(planned))
    return Number.isFinite(last) ? isoZurich(last + 60_000) : null
  }
  const first = Math.min(...trips.map(planned))
  return Number.isFinite(first) ? isoZurich(first - 60 * 60_000) : null
}

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

// ---------------------------------------------------------------- settings

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
