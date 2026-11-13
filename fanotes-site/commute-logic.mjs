// Pendelstrecken (commute routes): pure logic. Contract: commute-api.md.
// Times inside the module are milliseconds (UTC); the API speaks ISO 8601 with the Zurich offset.

import { cleanSchulnetzText, eventLabel, isCancelled, isLesson, linkedChange } from './schulnetz-logic.mjs'

export const MAX_ROUTES = 8
export const MAX_TIMES = 6
/** Ordered via stops per route. */
export const MAX_VIAS = 2
/** Pinned connections per route (one per weekday at most). */
export const MAX_PINS = 7
/** A pinned connection found within this many minutes of its planned time counts as moved, not missing. */
export const PIN_MOVED_MIN = 15
/** Without train numbers only the same line this close counts as moved (buses run every few minutes). */
export const PIN_MOVED_LINE_MIN = 3
export const DELAY_STEPS = [2, 3, 5, 10]
export const DEFAULT_DELAY_THRESHOLD = 3
/** A delay alert repeats only when the delay grew by this much since the last one. */
export const DELAY_REPEAT_MIN = 5
/** Tracked trips are watched from this long before departure until arrival. */
export const WINDOW_BEFORE_MS = 75 * 60_000
/** Inside this many minutes before departure the server checks every minute. */
export const IMMINENT_MS = 20 * 60_000
export const CHECK_IMMINENT_MS = 60_000
export const CHECK_EARLY_MS = 3 * 60_000
/**
 * A change that falls short of the official minimum transfer time by up to this many minutes is
 * "tight" (still possible with a quick change); more than this, or a negative gap, is "broken".
 */
export const TRANSFER_GRACE_MIN = 2
/**
 * Default minimum transfer time (minutes) between two chained segment searches when no official
 * time is known: the usual minimum at medium Swiss stations. Marked as a default (requiredSource 'default').
 */
export const CHAIN_TRANSFER_MIN = 4
/** Default walking time from school to the first stop for a lastLesson route (minutes). */
export const DEFAULT_WALK_MIN = 5
/** Lesson-tied targets look this many days ahead for the next school day. */
const LOOKAHEAD_DAYS = 10
const MINUTE = 60_000

// ── Zurich time ─────────────────────────────────────────────────────────────

const zurichFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
})

/** Zurich wall clock of an instant: { day: 'YYYY-MM-DD', clock: 'HH:MM', weekday: 1..7, offset: minutes east of UTC }. */
export const zurichWall = (ms) => {
  const parts = Object.fromEntries(zurichFormat.formatToParts(new Date(ms)).map((part) => [part.type, part.value]))
  const day = `${parts.year}-${parts.month}-${parts.day}`
  const clock = `${parts.hour}:${parts.minute}`
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1
  return { day, clock, weekday, offset: Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE) }
}

/** Instant of a Zurich wall-clock time ('YYYY-MM-DD', 'HH:MM[:SS]'). NaN when unreadable. */
export const zurichMs = (day, clock) => {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(day || ''))
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(String(clock || ''))
  if (!date || !time) return Number.NaN
  const guess = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]), Number(time[1]), Number(time[2]), Number(time[3] || 0))
  let ms = guess - zurichWall(guess).offset * MINUTE
  // Around a DST switch the first guess can be one hour off.
  ms = guess - zurichWall(ms).offset * MINUTE
  return ms
}

/** 'YYYY-MM-DD HH:MM[:SS]' or 'YYYY-MM-DDTHH:MM[:SS]' Zurich local, or ISO with offset → ms. */
export const parseLocal = (text) => {
  const value = String(text || '').trim()
  if (!value) return Number.NaN
  if (/(?:Z|[+-]\d{2}:?\d{2})$/u.test(value)) return Date.parse(value.replace(/([+-]\d{2})(\d{2})$/u, '$1:$2'))
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2}(?::\d{2})?)/u.exec(value)
  return match ? zurichMs(match[1], match[2]) : Number.NaN
}

/** ms → '2026-11-13T07:05:00+01:00'. */
export const isoZurich = (ms) => {
  if (!Number.isFinite(ms)) return ''
  const wall = zurichWall(ms)
  const sign = wall.offset >= 0 ? '+' : '-'
  const abs = Math.abs(wall.offset)
  const seconds = String(new Date(ms).getUTCSeconds()).padStart(2, '0')
  return `${wall.day}T${wall.clock}:${seconds}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

const addDays = (day, count) => new Date(Date.parse(`${day}T12:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10)

// ── Validation ──────────────────────────────────────────────────────────────

const STOP_TYPES = ['train', 'bus', 'tram', 'ship', 'cableway', 'other']
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max)

export const sanitizeStop = (input) => {
  if (!input || typeof input !== 'object') return null
  const id = text(input.id, 32)
  const name = text(input.name, 80)
  if (!name || (id && !/^[A-Za-z0-9:_.-]{1,32}$/u.test(id))) return null
  return { id, name, type: STOP_TYPES.includes(input.type) ? input.type : 'other' }
}

const clockOk = (value) => {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(String(value || '').trim())
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return ''
  return `${match[1].padStart(2, '0')}:${match[2]}`
}

export const sanitizeSchedule = (input = {}) => {
  const mode = ['none', 'times', 'firstLesson', 'lastLesson'].includes(input?.mode) ? input.mode : 'none'
  const times = mode === 'times' ? [...new Set((Array.isArray(input.times) ? input.times : []).map(clockOk).filter(Boolean))].sort().slice(0, MAX_TIMES) : []
  const days = [...new Set((Array.isArray(input?.days) ? input.days : [1, 2, 3, 4, 5]).map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))].sort()
  const given = input?.bufferMinutes
  const buffer = given == null || given === '' ? Number.NaN : Number(given)
  // lastLesson: walking time from school to the first stop; firstLesson: minutes to arrive early.
  const fallback = mode === 'lastLesson' ? DEFAULT_WALK_MIN : 10
  return {
    mode: mode === 'times' && !times.length ? 'none' : mode,
    times,
    days: days.length ? days : [1, 2, 3, 4, 5],
    bufferMinutes: Number.isFinite(buffer) ? Math.max(0, Math.min(60, Math.round(buffer))) : fallback,
  }
}

const threshold = (value, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) && number >= 1 && number <= 30 ? Math.round(number) : fallback
}

/** The fixed connection of a route: matched by line (or train number), boarding stop and planned departure. */
export const sanitizePin = (input) => {
  if (!input || typeof input !== 'object') return null
  const line = text(input.line, 16)
  const departure = clockOk(input.departure)
  const stop = text(input.stop, 80)
  if (!line || !departure || !stop) return null
  const stopId = text(input.stopId, 32)
  const days = [...new Set((Array.isArray(input.days) ? input.days : []).map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))].sort()
  const transfers = Number(input.transfers)
  return {
    days,
    line,
    trainNo: text(input.trainNo, 16),
    stop,
    stopId: /^[A-Za-z0-9:_.-]{1,32}$/u.test(stopId) ? stopId : '',
    departure,
    arrival: clockOk(input.arrival),
    transfers: Number.isInteger(transfers) && transfers >= 0 && transfers <= 9 ? transfers : 0,
  }
}

/** Pins with disjoint weekdays; a pin without days is dropped. */
export const sanitizePins = (input) => {
  const taken = new Set()
  const out = []
  for (const raw of Array.isArray(input) ? input : []) {
    if (out.length >= MAX_PINS) break
    const pin = sanitizePin(raw)
    if (!pin) continue
    pin.days = pin.days.filter((day) => !taken.has(day))
    if (!pin.days.length) continue
    for (const day of pin.days) taken.add(day)
    out.push(pin)
  }
  return out
}

/**
 * Up to two ordered vias, exactly as entered: order, duplicates and vias equal to the route ends
 * are kept (loop routes such as Brugg - Aarau - Lenzburg - Aarau). An old single [via] still reads.
 * Only entries that sanitizeStop rejects are dropped.
 */
export const sanitizeVias = (raw) => {
  const list = Array.isArray(raw?.vias) ? raw.vias : raw?.via ? [raw.via] : []
  const out = []
  for (const item of list) {
    const stop = sanitizeStop(item)
    if (!stop) continue
    out.push(stop)
    if (out.length >= MAX_VIAS) break
  }
  return out
}

export const pinFor = (route, weekday) => (route.pins || []).find((pin) => pin.days.includes(weekday)) || null

export const sanitizeRoutes = (input) => {
  const out = []
  for (const raw of Array.isArray(input) ? input : []) {
    if (out.length >= MAX_ROUTES) break
    const from = sanitizeStop(raw?.from)
    const to = sanitizeStop(raw?.to)
    if (!from || !to) continue
    const id = /^[a-f0-9]{12}$/u.test(String(raw?.id || '')) ? raw.id : ''
    if (!id || out.some((route) => route.id === id)) continue
    const vias = sanitizeVias(raw)
    out.push({
      id,
      name: text(raw.name, 40),
      from,
      to,
      vias,
      // The first via for clients older than two vias.
      via: vias[0] || null,
      schedule: sanitizeSchedule(raw.schedule),
      pins: sanitizePins(raw.pins),
      delayThreshold: raw.delayThreshold == null ? null : threshold(raw.delayThreshold, null),
      notify: raw.notify !== false,
    })
  }
  return out
}

export const sanitizeSettings = (input = {}) => ({
  delayThreshold: threshold(input?.delayThreshold, DEFAULT_DELAY_THRESHOLD),
  hiddenLabels: [...new Set((Array.isArray(input?.hiddenLabels) ? input.hiddenLabels : []).map((label) => text(label, 80).toLowerCase()).filter(Boolean))].slice(0, 200),
})

// ── search.ch answers ───────────────────────────────────────────────────────

const typeOf = (raw) => {
  const value = String(raw || '').toLowerCase()
  if (/train|zug|strain|express|bahn|rail/u.test(value)) return 'train'
  if (/tram/u.test(value)) return 'tram'
  if (/bus|post|night/u.test(value)) return 'bus'
  if (/ship|boat|schiff/u.test(value)) return 'ship'
  if (/cable|gondola|funi|seilbahn|standseil/u.test(value)) return 'cableway'
  return 'other'
}

/** search.ch completion → Stop[]. Addresses and points of interest are not stops. */
export const parseCompletion = (json) => (Array.isArray(json) ? json : [])
  .filter((item) => item && item.id && /sl-icon-type-(?:train|strain|bus|tram|ship|cableway|funicular|gondola|zug|express)/u.test(String(item.iconclass || '')))
  .map((item) => sanitizeStop({ id: String(item.id), name: item.label, type: typeOf(String(item.iconclass).replace('sl-icon-type-', '')) }))
  .filter(Boolean)
  .slice(0, 10)

/** search.ch delay field: '+3' → { minutes: 3 }, 'X' → cancelled, missing → no real-time data. */
export const parseDelay = (raw) => {
  const value = String(raw ?? '').trim()
  if (!value) return { minutes: null, cancelled: false }
  if (/^x$/iu.test(value) || /ausfall|cancel/iu.test(value)) return { minutes: null, cancelled: true }
  const number = Number(value.replace(/^\+/u, ''))
  return { minutes: Number.isFinite(number) ? Math.round(number) : null, cancelled: false }
}

/** search.ch occupancy forecast '12' → 1st class 1 (low), 2nd class 2 (medium). Per train and class only. */
export const parseOccupancy = (raw) => {
  const match = /^([0-3])([0-3])$/u.exec(String(raw ?? '').trim())
  const level = (digit) => (digit >= 1 && digit <= 3 ? digit : null)
  return match ? { first: level(Number(match[1])), second: level(Number(match[2])) } : { first: null, second: null }
}

const platformOf = (raw) => {
  const value = String(raw ?? '').trim()
  return { platform: value.replace(/!$/u, ''), changed: value.endsWith('!') }
}

const CANCELLED_NOTE = /fällt aus|faellt aus|ausfall|annul|cancel|entfällt/iu

const point = (name, stopId, plannedText, delayRaw, trackRaw) => {
  const planned = parseLocal(plannedText)
  const delay = parseDelay(delayRaw)
  const track = platformOf(trackRaw)
  return {
    point: {
      name: text(name, 80), stopId: String(stopId || ''),
      time: isoZurich(Number.isFinite(planned) && delay.minutes != null ? planned + delay.minutes * MINUTE : planned),
      planned: isoZurich(planned), delay: delay.minutes, platform: track.platform, platformChanged: track.changed,
    },
    cancelled: delay.cancelled,
  }
}

/** A stop time: planned, real (planned + delay) and the delay; delay null = no real-time data for it. */
const stopTime = (plannedText, delayMinutes) => {
  const planned = parseLocal(plannedText)
  if (!Number.isFinite(planned)) return null
  return { planned: isoZurich(planned), time: isoZurich(delayMinutes != null ? planned + delayMinutes * MINUTE : planned), delay: delayMinutes }
}

/**
 * One intermediate stop of a search.ch leg. search.ch reports the departure delay per stop (and 'X'
 * for a cancelled stop); an arrival delay or a platform per stop it does not have, so those stay
 * empty here and are never guessed.
 */
const searchChStop = (raw) => {
  const delay = parseDelay(raw?.dep_delay)
  const departure = stopTime(raw?.departure, delay.minutes)
  return {
    name: text(raw?.name, 80), stopId: String(raw?.stopid || ''),
    arrival: stopTime(raw?.arrival, null), departure,
    platform: '', platformChanged: false,
    realtime: delay.minutes != null || delay.cancelled,
    cancelled: delay.cancelled,
    occupancy: parseOccupancy(raw?.occupancy),
  }
}

/** search.ch seconds → whole minutes, null when absent or unreadable. */
const officialMinutes = (seconds) => {
  if (seconds == null || seconds === '') return null
  const value = Number(seconds)
  return Number.isFinite(value) && value >= 0 ? Math.round(value / 60) : null
}

/** One search.ch route answer → Trip[] (evaluated). */
export const parseSearchChRoute = (json) => (Array.isArray(json?.connections) ? json.connections : []).map((connection) => {
  const legs = []
  for (const leg of Array.isArray(connection.legs) ? connection.legs : []) {
    if (!leg?.exit) continue // the final arrival entry
    const walk = leg.type === 'walk' || !leg.line
    const from = point(leg.name, leg.stopid, leg.departure, leg.dep_delay, leg.track)
    const to = point(leg.exit.name, leg.exit.stopid, leg.exit.arrival, leg.exit.arr_delay, leg.exit.track)
    const notes = (Array.isArray(leg.disruptions) ? leg.disruptions : Object.values(leg.disruptions || {}))
      .map((item) => text(typeof item === 'string' ? item : item?.text || item?.header || item?.lead || '', 300)).filter(Boolean)
    legs.push({
      kind: walk ? 'walk' : 'ride',
      line: walk ? '' : text(leg.line, 16),
      category: walk ? '' : text(leg['*G'] || '', 8),
      trainNo: walk ? '' : text(leg['*Z'] || '', 16),
      type: walk ? 'other' : typeOf(leg.type_name || leg.type),
      operator: text(leg.operator, 24),
      direction: text(leg.terminal, 80),
      fgColor: /^[0-9a-f]{3,6}$/iu.test(leg.fgcolor || '') ? leg.fgcolor : '',
      bgColor: /^[0-9a-f]{3,6}$/iu.test(leg.bgcolor || '') ? leg.bgcolor : '',
      from: from.point,
      to: to.point,
      occupancy: walk ? { first: null, second: null } : parseOccupancy(leg.occupancy),
      cancelled: !walk && (from.cancelled || to.cancelled || leg.cancelled === true || notes.some((note) => CANCELLED_NOTE.test(note))),
      notes,
      minutes: Math.max(0, Math.round(Number(leg.runningtime || leg.normal_time || 0) / 60)),
      // Official minimum change time (minutes). Ride leg: the change before it; walk leg: the footpath. Null when absent.
      changeMinutes: officialMinutes(walk ? (leg.normal_time ?? leg.runningtime) : leg.normal_time),
      journeyId: walk ? '' : text(leg.tripid, 80),
      stops: walk ? [] : (Array.isArray(leg.stops) ? leg.stops : []).map(searchChStop).filter((stop) => stop.name),
    })
  }
  return evaluateTrip({ legs })
}).filter((trip) => trip.legs.length)

/** One transport.opendata.ch passList entry: planned platform and real-time forecasts per stop. */
const transportStop = (raw) => {
  const time = (key) => {
    const planned = parseLocal(raw?.[key])
    if (!Number.isFinite(planned)) return null
    const forecast = parseLocal(raw?.prognosis?.[key])
    const delay = Number.isFinite(forecast) ? Math.round((forecast - planned) / MINUTE) : null
    return { planned: isoZurich(planned), time: isoZurich(Number.isFinite(forecast) ? forecast : planned), delay }
  }
  const arrival = time('arrival')
  const departure = time('departure')
  const platform = platformOf(raw?.platform).platform
  const forecastPlatform = String(raw?.prognosis?.platform || '').trim()
  return {
    name: text(raw?.station?.name || raw?.location?.name, 80), stopId: String(raw?.station?.id || ''),
    arrival, departure,
    platform: forecastPlatform || platform,
    platformChanged: Boolean(forecastPlatform && platform && forecastPlatform !== platform),
    realtime: arrival?.delay != null || departure?.delay != null,
    cancelled: false,
    occupancy: { first: null, second: null },
  }
}

/** transport.opendata.ch /v1/connections answer → Trip[] (fallback provider). */
export const parseTransportRoute = (json) => (Array.isArray(json?.connections) ? json.connections : []).map((connection) => {
  const legs = (connection.sections || []).map((section) => {
    const walk = !section.journey
    const journey = section.journey || {}
    const mk = (end, plannedKey) => {
      const planned = parseLocal(end?.[plannedKey])
      const realtime = parseLocal(end?.prognosis?.[plannedKey])
      const delay = Number.isFinite(end?.delay) ? end.delay : Number.isFinite(realtime) && Number.isFinite(planned) ? Math.round((realtime - planned) / MINUTE) : null
      const platform = platformOf(end?.platform)
      return {
        name: text(end?.station?.name || end?.location?.name, 80), stopId: String(end?.station?.id || ''),
        time: isoZurich(Number.isFinite(planned) && delay != null ? planned + delay * MINUTE : planned), planned: isoZurich(planned), delay,
        platform: platform.platform, platformChanged: Boolean(end?.prognosis?.platform && end.prognosis.platform !== end.platform),
      }
    }
    const cap = (value) => (Number.isInteger(value) && value >= 1 && value <= 3 ? value : null)
    const pass = Array.isArray(journey.passList) ? journey.passList : []
    return {
      journeyId: '',
      stops: walk ? [] : pass.slice(1, -1).map(transportStop).filter((stop) => stop.name),
      kind: walk ? 'walk' : 'ride',
      line: walk ? '' : text(`${journey.category || ''}${journey.number && !/^\d{4,}$/u.test(journey.number) ? journey.number : ''}`, 16),
      category: walk ? '' : text(journey.category, 8),
      trainNo: walk ? '' : text(journey.number, 16),
      type: walk ? 'other' : typeOf(journey.category === 'B' ? 'bus' : journey.category === 'T' ? 'tram' : 'train'),
      operator: text(journey.operator, 24), direction: text(journey.to, 80), fgColor: '', bgColor: '',
      from: mk(section.departure, 'departure'), to: mk(section.arrival, 'arrival'),
      occupancy: { first: cap(journey.capacity1st), second: cap(journey.capacity2nd) },
      cancelled: false, notes: [],
      minutes: Math.max(0, Math.round((parseLocal(section.arrival?.arrival) - parseLocal(section.departure?.departure)) / MINUTE)) || 0,
      // No official change times here: the footpath of a walk section, otherwise unknown.
      changeMinutes: walk ? (Math.max(0, Math.round((parseLocal(section.arrival?.arrival) - parseLocal(section.departure?.departure)) / MINUTE)) || null) : null,
    }
  })
  return evaluateTrip({ legs })
}).filter((trip) => trip.legs.length)

// ── Trip evaluation ─────────────────────────────────────────────────────────

const worse = (left, right) => (left == null ? right : right == null ? left : Math.max(left, right))
const clockOf = (iso) => (/T(\d{2}:\d{2})/u.exec(String(iso || ''))?.[1] || '')

/** Fills status, transfers, occupancy and issues of a trip from its legs. */
export const evaluateTrip = ({ legs }) => {
  const rides = legs.filter((leg) => leg.kind === 'ride')
  const first = rides[0] || legs[0]
  const last = rides[rides.length - 1] || legs[legs.length - 1]
  const changes = []
  for (let index = 0; index < rides.length - 1; index += 1) {
    const arriving = rides[index]
    const leaving = rides[index + 1]
    const between = legs.slice(legs.indexOf(arriving) + 1, legs.indexOf(leaving))
    const walks = between.filter((leg) => leg.kind === 'walk')
    const walk = between.reduce((sum, leg) => sum + leg.minutes, 0)
    const gap = Math.round((parseLocal(leaving.from.time) - parseLocal(arriving.to.time)) / MINUTE)
    const plannedGap = Math.round((parseLocal(leaving.from.planned) - parseLocal(arriving.to.planned)) / MINUTE)
    // The official minimum: the footpath when search.ch inserted a walk, else the change time of the leaving ride.
    const footpath = walks.reduce((sum, leg) => sum + (leg.changeMinutes ?? leg.minutes), 0)
    let required = null
    let source = 'unknown'
    if (walks.length && footpath > 0) { required = footpath; source = 'timetable' }
    else if (leaving.changeMinutes != null) { required = leaving.changeMinutes; source = leaving.changeDefault ? 'default' : 'timetable' }
    // The timetable itself plans a shorter change (a held or guaranteed connection): that is the minimum.
    if (required != null && plannedGap < required) { required = Math.max(0, plannedGap); source = 'planned' }
    const shortfall = (required ?? 0) - gap
    const broken = gap < 0 || shortfall > TRANSFER_GRACE_MIN || leaving.cancelled === true
    const tight = !broken && shortfall > 0
    // minutes / plannedMinutes keep their old meaning for older apps: the time beyond the footpath.
    changes.push({
      at: leaving.from.name, minutes: gap - walk, plannedMinutes: plannedGap - walk, broken, tight,
      gapMinutes: gap, plannedGapMinutes: plannedGap, walkMinutes: walk, requiredMinutes: required, requiredSource: source,
    })
  }
  const issues = []
  for (const leg of rides) {
    if (leg.cancelled) issues.push({ kind: 'cancelled', text: `${leg.line} ${clockOf(leg.from.planned)} ab ${leg.from.name} fällt aus` })
    if (leg.from.platformChanged) issues.push({ kind: 'platformChange', text: `${leg.line} ab ${leg.from.name}: neu Gleis ${leg.from.platform}` })
    for (const note of leg.notes) if (!issues.some((issue) => issue.text === note)) issues.push({ kind: 'disruption', text: note })
  }
  for (const change of changes) if (change.broken) issues.push({ kind: 'missedTransfer', text: `Anschluss in ${change.at} nicht mehr erreichbar` })
  const depDelay = first?.from.delay ?? null
  const arrDelay = last?.to.delay ?? null
  const delayed = Math.max(depDelay || 0, arrDelay || 0)
  if (delayed > 0) issues.push({ kind: 'delay', text: `+${delayed} min` })
  const status = rides.some((leg) => leg.cancelled) ? 'cancelled' : changes.some((change) => change.broken) ? 'broken' : delayed >= 1 ? 'delayed' : 'ok'
  const occupancy = rides.reduce((acc, leg) => ({ first: worse(acc.first, leg.occupancy.first), second: worse(acc.second, leg.occupancy.second) }), { first: null, second: null })
  // A walk to another stop before the first ride (or after the last) is part of the trip.
  const start = legs[0]
  const end = legs[legs.length - 1]
  const lead = start && start.kind === 'walk' && first !== start ? start.minutes * MINUTE : 0
  const departure = start ? isoZurich(parseLocal(first?.from.time) - lead) : ''
  const plannedDeparture = start ? isoZurich(parseLocal(first?.from.planned) - lead) : ''
  const tail = end && end.kind === 'walk' && last !== end ? end.minutes * MINUTE : 0
  const arrival = isoZurich(parseLocal(last?.to.time) + tail)
  const plannedArrival = isoZurich(parseLocal(last?.to.planned) + tail)
  return {
    id: `${first?.line || 'walk'}|${first?.trainNo || ''}|${first?.from.planned || ''}|${last?.to.planned || ''}`,
    departure, arrival,
    plannedDeparture, plannedArrival,
    depDelay, arrDelay,
    minutes: Math.max(0, Math.round((parseLocal(arrival) - parseLocal(departure)) / MINUTE)) || 0,
    transfers: Math.max(0, rides.length - 1),
    status, legs, changes, occupancy, issues, quietest: false,
    // What a client stores to pin this connection (see sanitizePin).
    pin: rides.length ? {
      line: first.line, trainNo: first.trainNo || '', stop: first.from.name, stopId: first.from.stopId || '',
      departure: clockOf(first.from.planned), arrival: clockOf(last.to.planned), transfers: Math.max(0, rides.length - 1),
    } : null,
  }
}

// ── Vias: guard and chained trips ──────────────────────────────────────────

const viaDigits = (value) => String(value || '').replace(/\D/gu, '').replace(/^0+/u, '')
/** Two stops are the same when their ids match, else when their names match (case-insensitive). */
export const sameViaStop = (a, b) => {
  if (!a || !b) return false
  const idA = viaDigits(a.id ?? a.stopId)
  const idB = viaDigits(b.id ?? b.stopId)
  if (idA && idB) return idA === idB
  const nameA = String(a.name || '').trim().toLowerCase()
  return Boolean(nameA) && nameA === String(b.name || '').trim().toLowerCase()
}

/** True when a via equals the origin, the destination or the other via (the trip must come back to a stop). */
export const hasViaLoop = (from, to, vias = []) => vias.some((via, index) => sameViaStop(via, from) || sameViaStop(via, to) || vias.some((other, at) => at !== index && sameViaStop(via, other)))

/** The stops a trip passes in order: the start, then every ride's boarding stop (after a walk), intermediate stops and end. */
export const tripPoints = (trip) => {
  const legs = Array.isArray(trip?.legs) ? trip.legs : []
  const points = []
  const add = (stop) => { if (stop?.name || stop?.stopId) points.push({ id: stop.stopId || '', name: stop.name || '' }) }
  if (legs[0]) add(legs[0].from)
  for (const leg of legs) {
    if (leg.kind !== 'ride') continue
    if (!points.length || !sameViaStop(points[points.length - 1], { id: leg.from.stopId, name: leg.from.name })) add(leg.from)
    for (const stop of leg.stops || []) add(stop)
    add(leg.to)
  }
  return points
}

/** Whether the trip passes [vias] in order: matched at indices 0 < i1 < i2 < last. */
export const passesVias = (trip, vias = []) => {
  if (!vias.length) return true
  const points = tripPoints(trip)
  let from = 1
  for (const via of vias) {
    let found = -1
    for (let index = from; index < points.length - 1; index += 1) {
      if (sameViaStop(via, points[index])) { found = index; break }
    }
    if (found < 0) return false
    from = found + 1
  }
  return true
}

/**
 * One trip from consecutive segment trips (from → via1, via1 → via2, via2 → to). The first ride of
 * every later segment gets [transferMin] as its change time, marked as a default; the whole is
 * evaluated like any trip, so ids, pins, changes and status stay consistent.
 */
export const chainSegments = (segments, transferMin = CHAIN_TRANSFER_MIN) => {
  const legs = []
  segments.forEach((segment, index) => {
    let marked = index === 0
    for (const leg of segment.legs) {
      if (!marked && leg.kind === 'ride') { legs.push({ ...leg, changeMinutes: transferMin, changeDefault: true }); marked = true } else legs.push(leg)
    }
  })
  return evaluateTrip({ legs })
}

const sameStop = (leg, pin) => (pin.stopId && leg.from.stopId ? leg.from.stopId === pin.stopId : leg.from.name.toLowerCase() === pin.stop.toLowerCase())
const sameLine = (leg, pin) => leg.line.replace(/\s+/gu, '').toLowerCase() === pin.line.replace(/\s+/gu, '').toLowerCase()
const sameNumber = (leg, pin) => Boolean(pin.trainNo && leg.trainNo && leg.trainNo.replace(/^0+/u, '') === pin.trainNo.replace(/^0+/u, ''))
const sameVehicle = (leg, pin) => sameLine(leg, pin) || sameNumber(leg, pin)
/** Moved by a timetable change: the same train number, or without numbers the same line a few minutes off. */
const movedVehicle = (leg, pin, offset) => (pin.trainNo && leg.trainNo
  ? sameNumber(leg, pin) && offset <= PIN_MOVED_MIN * MINUTE
  : sameLine(leg, pin) && offset <= PIN_MOVED_LINE_MIN * MINUTE)

/**
 * Finds a route's pinned connection on [day] among [trips]. 'ok': same line or train number, same
 * boarding stop and planned departure; 'moved': the same train number within PIN_MOVED_MIN
 * minutes (a timetable change; without numbers the same line within PIN_MOVED_LINE_MIN); 'missing': not there, [nearest] is the trip that leaves closest to it.
 */
export const matchPin = (trips, pin, day) => {
  const planned = zurichMs(day, pin.departure)
  const firstRide = (trip) => trip.legs.find((leg) => leg.kind === 'ride')
  const offset = (trip) => Math.abs(parseLocal(firstRide(trip)?.from.planned) - planned)
  const rides = trips.filter((trip) => firstRide(trip))
  const exact = rides.find((trip) => offset(trip) < MINUTE && sameVehicle(firstRide(trip), pin) && sameStop(firstRide(trip), pin))
  if (exact) return { status: 'ok', trip: exact, nearest: null }
  // The next bus of the same line ten minutes later is another vehicle, not the pinned one moved.
  const moved = rides.filter((trip) => movedVehicle(firstRide(trip), pin, offset(trip))).sort((a, b) => offset(a) - offset(b))[0]
  if (moved) return { status: 'moved', trip: moved, nearest: null }
  const nearest = [...rides].filter((trip) => trip.status !== 'cancelled').sort((a, b) => offset(a) - offset(b))[0] || null
  return { status: 'missing', trip: null, nearest }
}

export const pinLabel = (pin) => `${pin.departure} ${pin.line} ab ${pin.stop}`

export const usable = (trip, now) => trip.status !== 'cancelled' && trip.status !== 'broken' && parseLocal(trip.departure) >= now - MINUTE

/** Marks the least crowded trip among those arriving within 10 minutes of the earliest usable one. */
export const markQuietest = (trips, now) => {
  const candidates = trips.filter((trip) => usable(trip, now))
  if (candidates.length < 2) return trips
  const earliest = Math.min(...candidates.map((trip) => parseLocal(trip.arrival)))
  const near = candidates.filter((trip) => parseLocal(trip.arrival) <= earliest + 10 * MINUTE)
  const score = (trip) => (trip.occupancy.second ?? 9) * 10 + (trip.occupancy.first ?? 9)
  const known = near.filter((trip) => trip.occupancy.second != null || trip.occupancy.first != null)
  if (known.length < 2) return trips
  const best = Math.min(...known.map(score))
  // Only when it actually differs: all equally full is no recommendation.
  if (known.every((trip) => score(trip) === best)) return trips
  const pick = known.find((trip) => score(trip) === best)
  return trips.map((trip) => ({ ...trip, quietest: trip === pick }))
}

/** Usable trips first (by arrival), then the rest; at most [limit]. */
export const rankTrips = (trips, now, limit = 4) => {
  const seen = new Set()
  const distinct = trips.filter((trip) => (seen.has(trip.id) ? false : seen.add(trip.id)))
  const live = distinct.filter((trip) => parseLocal(trip.arrival) >= now)
  const good = live.filter((trip) => usable(trip, now)).sort((a, b) => parseLocal(a.arrival) - parseLocal(b.arrival) || parseLocal(b.departure) - parseLocal(a.departure))
  const bad = live.filter((trip) => !usable(trip, now))
  return markQuietest([...good, ...bad].slice(0, limit), now)
}

// ── Lessons and targets ─────────────────────────────────────────────────────

const lessonOf = (event) => ({ start: parseLocal(event.start), end: parseLocal(event.end || event.start), label: eventLabel(event) })

/**
 * A school day's lessons for this user: lessons of hidden groups left out. [planned] includes
 * cancelled lessons, [held] does not.
 */
export const schoolDay = (events, day, hiddenLabels = []) => {
  const hidden = new Set(hiddenLabels.map((label) => String(label).toLowerCase()))
  const lessons = (Array.isArray(events) ? events : []).filter((event) => isLesson(event) && String(event.start || '').slice(0, 10) === day && !hidden.has(eventLabel(event).trim().toLowerCase()))
  const planned = lessons.map(lessonOf).filter((lesson) => Number.isFinite(lesson.start)).sort((a, b) => a.start - b.start)
  const held = lessons.filter((event) => !isCancelled(event)).map(lessonOf).filter((lesson) => Number.isFinite(lesson.start)).sort((a, b) => a.start - b.start)
  if (!planned.length) return null
  const lastEnd = (list) => Math.max(...list.map((lesson) => lesson.end))
  return {
    day,
    first: held[0] || null,
    last: held.length ? held.reduce((a, b) => (b.end >= a.end ? b : a)) : null,
    plannedFirst: planned[0],
    plannedLastEnd: lastEnd(planned),
    heldLastEnd: held.length ? lastEnd(held) : null,
    allCancelled: !held.length,
  }
}

const iso = (ms) => isoZurich(ms)
const lessonRef = (lesson) => (lesson ? { start: iso(lesson.start), end: iso(lesson.end), label: lesson.label } : null)

/**
 * The moment a route is planned around next. firstLesson: arrive [buffer] minutes before the first
 * held lesson; lastLesson: leave [buffer] minutes after the last held lesson. A lesson-tied day that
 * has no held lessons is skipped. A target stays current until its trip should have left
 * (depart) or the lesson began (arrive).
 */
export const routeTarget = (route, { now, events = [], hiddenLabels = [] }) => {
  const schedule = route.schedule || { mode: 'none' }
  if (route.pins?.length) return pinnedTarget(route, { now, events, hiddenLabels })
  if (schedule.mode === 'none') return { kind: 'now', at: iso(now), timeType: 'depart', lesson: null, lessonChange: 'none', plannedAt: null }
  const today = zurichWall(now).day
  for (let offset = 0; offset <= LOOKAHEAD_DAYS; offset += 1) {
    const day = addDays(today, offset)
    const weekday = zurichWall(zurichMs(day, '12:00')).weekday
    if (!schedule.days.includes(weekday)) continue
    if (schedule.mode === 'times') {
      for (const time of schedule.times) {
        const at = zurichMs(day, time)
        if (at >= now - MINUTE) return { kind: 'time', at: iso(at), timeType: 'depart', lesson: null, lessonChange: 'none', plannedAt: null }
      }
      continue
    }
    const info = schoolDay(events, day, hiddenLabels)
    if (!info || info.allCancelled) continue
    const buffer = schedule.bufferMinutes * MINUTE
    if (schedule.mode === 'firstLesson') {
      const at = info.first.start - buffer
      if (info.first.start <= now) continue
      const moved = info.first.start > info.plannedFirst.start
      return { kind: 'firstLesson', at: iso(at), timeType: 'arrive', lesson: lessonRef(info.first), lessonChange: moved ? 'firstCancelled' : 'none', plannedAt: moved ? iso(info.plannedFirst.start - buffer) : null }
    }
    const at = info.heldLastEnd + buffer
    if (at < now - MINUTE) continue
    const earlier = info.heldLastEnd < info.plannedLastEnd
    return { kind: 'lastLesson', at: iso(at), timeType: 'depart', lesson: lessonRef(info.last), lessonChange: earlier ? 'lastCancelled' : 'none', plannedAt: earlier ? iso(info.plannedLastEnd + buffer) : null }
  }
  return null
}

/**
 * A pinned route's next target: its pinned connection on the next day a pin applies. A
 * lesson-tied route also skips days without held lessons and reports a lesson change, with
 * [changeAt]/[changeTimeType] for the earlier way home or the later way to school. The target
 * stays current until the pinned connection's planned arrival.
 */
const pinnedTarget = (route, { now, events, hiddenLabels }) => {
  const schedule = route.schedule
  const today = zurichWall(now).day
  for (let offset = 0; offset <= LOOKAHEAD_DAYS; offset += 1) {
    const day = addDays(today, offset)
    const weekday = zurichWall(zurichMs(day, '12:00')).weekday
    const pin = pinFor(route, weekday)
    if (!pin) continue
    const at = zurichMs(day, pin.departure)
    let until = pin.arrival ? zurichMs(day, pin.arrival) : at + 60 * MINUTE
    if (until < at) until += 24 * 60 * MINUTE
    if (until < now - MINUTE) continue
    const base = { kind: 'pinned', at: iso(at), timeType: 'depart', lesson: null, lessonChange: 'none', plannedAt: null, changeAt: null, changeTimeType: null, pin, day }
    if (schedule.mode !== 'firstLesson' && schedule.mode !== 'lastLesson') return base
    const info = schoolDay(events, day, hiddenLabels)
    // No lessons known for that day (holidays, data not read yet): the pinned train still counts.
    if (!info) return base
    if (info.allCancelled) continue
    const buffer = schedule.bufferMinutes * MINUTE
    if (schedule.mode === 'firstLesson') {
      const moved = info.first.start > info.plannedFirst.start
      return { ...base, lesson: lessonRef(info.first), lessonChange: moved ? 'firstCancelled' : 'none', plannedAt: moved ? iso(info.plannedFirst.start - buffer) : null, changeAt: moved ? iso(info.first.start - buffer) : null, changeTimeType: moved ? 'arrive' : null }
    }
    const earlier = info.heldLastEnd < info.plannedLastEnd
    return { ...base, lesson: lessonRef(info.last), lessonChange: earlier ? 'lastCancelled' : 'none', plannedAt: earlier ? iso(info.plannedLastEnd + buffer) : null, changeAt: earlier ? iso(info.heldLastEnd + buffer) : null, changeTimeType: earlier ? 'depart' : null }
  }
  return null
}

/** When the server should look at a tracked route again (ms), or Infinity outside its window. */
export const nextCheckAt = (target, tracked, now) => {
  if (!target || target.kind === 'now') return Number.POSITIVE_INFINITY
  const departure = tracked ? parseLocal(tracked.departure) : parseLocal(target.at) - (target.timeType === 'arrive' ? 60 * MINUTE : 0)
  const arrival = tracked ? parseLocal(tracked.arrival) : departure
  if (now > arrival) return now + CHECK_EARLY_MS
  const opens = departure - WINDOW_BEFORE_MS
  if (now < opens) return opens
  return now + (departure - now <= IMMINENT_MS ? CHECK_IMMINENT_MS : CHECK_EARLY_MS)
}

export const inWindow = (target, tracked, now) => {
  if (!target || target.kind === 'now' || !tracked) return false
  return now >= parseLocal(tracked.departure) - WINDOW_BEFORE_MS && now <= parseLocal(tracked.arrival)
}

// ── Alerts ──────────────────────────────────────────────────────────────────

const rideLegs = (trip) => trip.legs.filter((leg) => leg.kind === 'ride')
const tripLabel = (trip) => {
  const ride = rideLegs(trip)[0]
  if (!ride) return ''
  const mode = ride.type === 'bus' ? 'Bus ' : ride.type === 'tram' ? 'Tram ' : ''
  return `${clockOf(ride.from.planned)} ${mode}${ride.line} ab ${ride.from.name}`
}
const tripLine = (trip) => {
  const ride = rideLegs(trip)[0]
  const last = rideLegs(trip).slice(-1)[0]
  if (!ride) return ''
  const mode = ride.type === 'bus' ? 'Bus' : ride.type === 'tram' ? 'Tram' : 'Zug'
  return `${mode} um ${clockOf(ride.from.time)} (${ride.line} ab ${ride.from.name}${ride.from.platform ? `, Gleis ${ride.from.platform}` : ''}, an ${last.to.name} ${clockOf(last.to.time)})`
}
export const tripDelay = (trip) => Math.max(rideLegs(trip)[0]?.from.delay || 0, rideLegs(trip).slice(-1)[0]?.to.delay || 0)

/**
 * Alerts for one route's tracked trip. [state] is the route's stored alert state; the result
 * carries the next one. Every alert id is stable, so a repeat never shows twice.
 */
export const tripAlerts = ({ route, target, tracked, alternatives = [], state = {}, delayThreshold, now }) => {
  const changes = []
  if (!tracked || !route.notify) return { changes, state }
  delayThreshold = route.delayThreshold ?? delayThreshold
  const day = zurichWall(parseLocal(tracked.plannedDeparture || tracked.departure)).day
  const key = `${day}|${tracked.id}`
  const record = { ...(state.trips?.[key] || {}) }
  const base = `commute:${route.id}:${day}:${tracked.id.replace(/[^A-Za-z0-9|:+-]/gu, '')}`
  const extra = { target: 'commute', targetId: route.id, date: day }
  const alternative = alternatives.find((trip) => usable(trip, now))
  const instead = alternative ? `Alternative: ${tripLine(alternative)}` : 'Keine Alternative gefunden'
  const arrived = parseLocal(tracked.arrival) < now
  if (!arrived) {
    if (tracked.status === 'cancelled' && !record.cancelled) {
      record.cancelled = true
      changes.push(linkedChange(`${base}:cancelled`, 'commute', 'Fällt aus', `${tripLabel(tracked)} fällt aus. ${instead}`, extra))
    } else if (tracked.status === 'broken' && !record.broken) {
      record.broken = true
      const where = tracked.changes.find((change) => change.broken)?.at || ''
      changes.push(linkedChange(`${base}:broken`, 'commute', 'Anschluss verpasst', `${tripLabel(tracked)}: Anschluss in ${where} nicht erreichbar. ${instead}`, extra))
    } else if (tracked.status !== 'cancelled' && tracked.status !== 'broken') {
      const delay = tripDelay(tracked)
      const last = Number(record.delay || 0)
      if (delay >= delayThreshold && (!last || delay >= last + DELAY_REPEAT_MIN)) {
        record.delay = delay
        const lastRide = rideLegs(tracked).slice(-1)[0]
        const platform = rideLegs(tracked)[0]?.from.platform
        changes.push(linkedChange(`${base}:delay:${delay}`, 'commute', 'Verspätung', `${tripLabel(tracked)} · +${delay} min${platform ? ` · Gleis ${platform}` : ''} → ${lastRide.to.name} ${clockOf(lastRide.to.time)}`, extra))
      }
      const firstRide = rideLegs(tracked)[0]
      if (firstRide?.from.platformChanged && parseLocal(firstRide.from.time) - now <= 30 * MINUTE && record.platform !== firstRide.from.platform) {
        record.platform = firstRide.from.platform
        changes.push(linkedChange(`${base}:platform:${firstRide.from.platform}`, 'commute', 'Gleisänderung', `${tripLabel(tracked)} fährt neu ab Gleis ${firstRide.from.platform}`, extra))
      }
    }
  }
  const trips = Object.fromEntries(Object.entries({ ...(state.trips || {}), [key]: record }).filter(([name]) => name.slice(0, 10) >= addDays(zurichWall(now).day, -2)))
  return { changes, state: { ...state, trips } }
}

/**
 * "Letzte Stunde fällt aus – du kannst den Zug um 14:43 nehmen" (and the later way to school).
 * Once per route, day and new time.
 */
export const lessonChangeAlert = ({ route, target, trip, state = {}, now }) => {
  if (!route.notify || !target || target.lessonChange === 'none' || !trip) return { changes: [], state }
  const day = String(target.at).slice(0, 10)
  const moment = target.changeAt || target.at
  const key = `${day}|${target.lessonChange}|${moment}`
  if (state.lessons?.[key]) return { changes: [], state }
  if (parseLocal(moment) < now - 5 * MINUTE) return { changes: [], state }
  const extra = { target: 'commute', targetId: route.id, date: day }
  const id = `commute:${route.id}:${day}:lesson:${target.lessonChange}:${clockOf(moment).replace(':', '')}`
  const change = target.lessonChange === 'lastCancelled'
    ? linkedChange(id, 'commute', 'Früher nach Hause', `Letzte Stunde fällt aus – du kannst den ${tripLine(trip)} nehmen.`, extra)
    : linkedChange(id, 'commute', 'Später zur Schule', `Erste Stunde fällt aus – es reicht der ${tripLine(trip)}.`, extra)
  const lessons = Object.fromEntries(Object.entries({ ...(state.lessons || {}), [key]: true }).filter(([name]) => name.slice(0, 10) >= addDays(zurichWall(now).day, -2)))
  return { changes: [change], state: { ...state, lessons } }
}

/**
 * "Verbindung fehlt": the pinned connection is not in the timetable on its day (a timetable change).
 * Once per pin until it is found again; names the nearest connection.
 */
export const pinMissingAlert = ({ route, target, nearest, state = {} }) => {
  if (!route.notify || !target?.pin) return { changes: [], state }
  const key = `${target.pin.line}|${target.pin.stop}|${target.pin.departure}`
  if (state.pinMissing?.[key]) return { changes: [], state }
  const extra = { target: 'commute', targetId: route.id, date: target.day }
  const id = `commute:${route.id}:${target.day}:pin:${key.replace(/[^A-Za-z0-9|:+-]/gu, '')}`
  const hint = nearest ? `Nächste Verbindung: ${tripLine(nearest)}.` : 'Keine Verbindung in der Nähe gefunden.'
  const change = linkedChange(id, 'commute', 'Verbindung fehlt', `${pinLabel(target.pin)} ist am ${target.day.slice(8, 10)}.${target.day.slice(5, 7)}. nicht im Fahrplan. ${hint} Du kannst die Verbindung in der Strecke neu wählen.`, extra)
  return { changes: [change], state: { ...state, pinMissing: { ...(state.pinMissing || {}), [key]: true } } }
}

// ── Connection detail: every stop, real time and where the vehicle is ──────

/** A board trip without its stop lists (the boards stay small; the detail asks for them). */
export const slimTrip = (trip) => (trip ? { ...trip, legs: trip.legs.map(({ stops, ...leg }) => ({ ...leg, stopCount: Array.isArray(stops) ? stops.length : leg.stopCount || 0 })) } : trip)

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
const digits = (value) => String(value || '').replace(/\D/gu, '').replace(/^0+/u, '')

/**
 * Adds what transport.opendata.ch knows per stop to a search.ch leg: the platform (and a change) and
 * the real arrival/departure where search.ch has none. [other] is the matching leg from
 * transport.opendata.ch (same vehicle and planned departure) or null. Nothing is invented: a value
 * neither source has stays empty.
 */
export const mergeLegDetail = (leg, other) => {
  if (!other || leg.kind !== 'ride') return leg
  const merge = (mine, theirs) => {
    if (!theirs) return mine
    const pick = (a, b) => (a && a.delay != null ? a : b && b.delay != null ? { ...b, planned: a?.planned || b.planned } : a || b)
    return {
      ...mine,
      stopId: mine.stopId || theirs.stopId,
      arrival: pick(mine.arrival, theirs.arrival),
      departure: pick(mine.departure, theirs.departure),
      platform: mine.platform || theirs.platform,
      platformChanged: mine.platformChanged || theirs.platformChanged,
      realtime: mine.realtime || theirs.realtime,
    }
  }
  const theirs = other.stops || []
  const stops = (leg.stops || []).map((stop) => merge(stop, theirs.find((item) => (stop.stopId && item.stopId && digits(stop.stopId) === digits(item.stopId)) || sameName(item.name, stop.name))))
  const end = (mine, them) => ({
    ...mine,
    platform: mine.platform || them?.platform || '',
    platformChanged: mine.platformChanged || Boolean(them?.platformChanged),
  })
  return { ...leg, stops, from: end(leg.from, other.from), to: end(leg.to, other.to), platformsFrom: 'transport.opendata.ch' }
}

/** The transport.opendata.ch leg that is the same vehicle as [leg]: same boarding stop and planned departure, same number when known. */
export const matchTransportLeg = (leg, trips) => {
  const planned = parseLocal(leg.from.planned)
  for (const trip of trips) {
    for (const other of trip.legs) {
      if (other.kind !== 'ride') continue
      if (Math.abs(parseLocal(other.from.planned) - planned) >= MINUTE) continue
      if (!sameName(other.from.name, leg.from.name) && !(other.from.stopId && leg.from.stopId && digits(other.from.stopId) === digits(leg.from.stopId))) continue
      const number = digits(leg.trainNo)
      if (number && digits(other.trainNo) && digits(other.trainNo) !== number && digits(other.line) !== digits(leg.line)) continue
      return other
    }
  }
  return null
}

/**
 * Where the trip is at [now], from the real times (planned where a stop has none). Points of a leg:
 * 0 = boarding stop, 1..n = intermediate stops, n+1 = the stop where it is left.
 * state: 'notStarted' | 'atStop' (point) | 'between' (point → point + 1, progress 0–1) |
 * 'transfer' (after leg, before the next) | 'arrived'. [estimated] when a time it relies on has no real-time data.
 */
export const tripPosition = (trip, now) => {
  const rides = trip.legs.map((leg, index) => ({ leg, index })).filter(({ leg }) => leg.kind === 'ride')
  if (!rides.length) return { state: 'notStarted', legIndex: 0, point: 0, progress: 0, estimated: true }
  const ms = (value) => parseLocal(value)
  for (let r = 0; r < rides.length; r += 1) {
    const { leg, index } = rides[r]
    const points = [
      { arrive: null, leave: { at: ms(leg.from.time), real: leg.from.delay != null } },
      ...(leg.stops || []).filter((stop) => !stop.cancelled).map((stop) => ({
        arrive: stop.arrival ? { at: ms(stop.arrival.time), real: stop.arrival.delay != null } : null,
        leave: stop.departure ? { at: ms(stop.departure.time), real: stop.departure.delay != null } : null,
        original: (leg.stops || []).indexOf(stop) + 1,
      })),
      { arrive: { at: ms(leg.to.time), real: leg.to.delay != null }, leave: null, original: (leg.stops || []).length + 1 },
    ]
    points[0].original = 0
    const startAt = points[0].leave.at
    if (now < startAt) {
      return r === 0
        ? { state: 'notStarted', legIndex: index, point: 0, progress: 0, estimated: !points[0].leave.real }
        : { state: 'transfer', legIndex: rides[r - 1].index, point: (rides[r - 1].leg.stops || []).length + 1, progress: 0, estimated: !points[0].leave.real }
    }
    for (let p = 0; p < points.length - 1; p += 1) {
      const here = points[p]
      const next = points[p + 1]
      const leaveAt = here.leave?.at ?? here.arrive?.at
      const arriveAt = next.arrive?.at ?? next.leave?.at
      if (here.arrive && now >= here.arrive.at && now < leaveAt) return { state: 'atStop', legIndex: index, point: here.original, progress: 0, estimated: !(here.arrive.real && here.leave?.real) }
      if (now >= leaveAt && now < arriveAt) {
        const span = Math.max(1, arriveAt - leaveAt)
        return { state: 'between', legIndex: index, point: here.original, progress: Math.min(1, Math.max(0, (now - leaveAt) / span)), estimated: !((here.leave?.real ?? false) && (next.arrive?.real ?? false)) }
      }
    }
    const last = points[points.length - 1]
    if (now >= last.arrive.at && r === rides.length - 1) return { state: 'arrived', legIndex: index, point: last.original, progress: 1, estimated: !last.arrive.real }
  }
  const final = rides[rides.length - 1]
  return { state: 'arrived', legIndex: final.index, point: (final.leg.stops || []).length + 1, progress: 1, estimated: true }
}

export const routeLabel = (route) => route.name || `${route.from.name} → ${route.to.name}`
export const cleanText = cleanSchulnetzText
