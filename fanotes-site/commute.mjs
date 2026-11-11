// Pendelstrecken (commute routes): provider, storage, live boards and the alert check.
// Contract: commute-api.md. Logic: commute-logic.mjs. Routes never go to Schulnetz.

import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  CHECK_IMMINENT_MS, MAX_VIAS, WINDOW_BEFORE_MS, inWindow, isoZurich, lessonChangeAlert, markQuietest, matchPin, nextCheckAt,
  parseCompletion, parseLocal, parseSearchChRoute, parseTransportRoute, pinMissingAlert, rankTrips, routeTarget, sanitizeRoutes,
  sanitizeSettings, sanitizeStop, tripAlerts, usable, zurichWall,
} from './commute-logic.mjs'

export const SEARCH_CH = 'https://timetable.search.ch/api'
export const TRANSPORT = 'https://transport.opendata.ch/v1'
/** search.ch allows 1000 route queries and 10080 boards a day; keep a margin for other users of the IP. */
export const ROUTE_BUDGET = 850
export const COMPLETION_BUDGET = 3000
export const ROUTE_CACHE_MS = 30_000
export const STOP_CACHE_MS = 24 * 60 * 60_000
const USER_AGENT = 'KantiPlus/1.0 (+https://fanotes.fasrv.ch; commute)'
const PROVIDERS = {
  'search.ch': { name: 'search.ch', occupancy: 'train-class', formation: false },
  'transport.opendata.ch': { name: 'transport.opendata.ch', occupancy: 'train-class', formation: false },
}

const searchDate = (ms) => {
  const wall = zurichWall(ms)
  const [year, month, day] = wall.day.split('-')
  return { date: `${month}/${day}/${year}`, time: wall.clock, isoDay: wall.day }
}

/**
 * Timetable provider with a shared 30 s cache, in-flight sharing and a daily budget that falls
 * back to transport.opendata.ch, then to the last good answer (stale).
 */
export const createCommuteProvider = ({ fetchImpl = fetch, now = () => new Date(), log = () => {}, budgetFile = '' } = {}) => {
  const cache = new Map()
  const inflight = new Map()
  let budget = { day: '', route: 0, completion: 0, fallback: 0 }
  let budgetLoaded = false
  const loadBudget = async () => {
    if (budgetLoaded || !budgetFile) return
    budgetLoaded = true
    try { budget = { ...budget, ...JSON.parse(await fs.readFile(budgetFile, 'utf8')) } } catch { /* first run */ }
  }
  const spend = async (kind) => {
    await loadBudget()
    const day = zurichWall(now().getTime()).day
    if (budget.day !== day) budget = { day, route: 0, completion: 0, fallback: 0 }
    budget[kind] += 1
    if (budgetFile) await fs.writeFile(budgetFile, JSON.stringify(budget), { mode: 0o600 }).catch(() => undefined)
  }
  const left = async (kind, limit) => {
    await loadBudget()
    const day = zurichWall(now().getTime()).day
    return budget.day !== day || budget[kind] < limit
  }
  const getJson = async (url) => {
    const response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, redirect: 'error', signal: AbortSignal.timeout?.(12_000) })
    if (!response.ok && response.status !== 200) throw Object.assign(new Error('provider'), { status: response.status })
    return response.json()
  }
  const cached = async (key, ttl, load) => {
    const hit = cache.get(key)
    const at = now().getTime()
    if (hit && at - hit.at < ttl) return { ...hit.value, cached: true }
    if (inflight.has(key)) return inflight.get(key)
    const task = (async () => {
      try {
        const value = await load()
        cache.set(key, { at: now().getTime(), value })
        if (cache.size > 2000) cache.delete(cache.keys().next().value)
        return value
      } catch (error) {
        if (hit) return { ...hit.value, stale: true }
        throw error
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, task)
    return task
  }

  const stops = (query) => {
    const term = String(query || '').trim().slice(0, 60)
    if (term.length < 2) return Promise.resolve({ stops: [] })
    return cached(`stops:${term.toLowerCase()}`, STOP_CACHE_MS, async () => {
      if (await left('completion', COMPLETION_BUDGET)) {
        try {
          await spend('completion')
          return { stops: parseCompletion(await getJson(`${SEARCH_CH}/completion.json?term=${encodeURIComponent(term)}&show_ids=1&nofavorites=1`)) }
        } catch (error) { log('warn', `Haltestellensuche search.ch fehlgeschlagen (${error?.status || error?.name || 'error'})`) }
      }
      const json = await getJson(`${TRANSPORT}/locations?query=${encodeURIComponent(term)}&type=station`)
      return {
        stops: (json?.stations || []).filter((station) => station?.id && station?.name).slice(0, 10)
          .map((station) => ({ id: String(station.id), name: String(station.name), type: /bus/u.test(station.icon || '') ? 'bus' : /tram/u.test(station.icon || '') ? 'tram' : 'train' })),
      }
    })
  }

  /** Trips around [at] (ms) for from → to (through [vias] in order), departing or arriving at that time. */
  const trips = ({ from, to, vias = [], at, timeType = 'depart', num = 0 }) => {
    const when = searchDate(at)
    const stopKey = (stop) => stop?.id || stop?.name || ''
    vias = (vias || []).filter(Boolean).slice(0, MAX_VIAS)
    // Cached per minute of the asked time: equal questions from several people share one answer.
    const key = `route:${stopKey(from)}>${vias.map(stopKey).join('>')}>${stopKey(to)}@${when.isoDay}T${when.time}:${timeType}:${num}`
    return cached(key, ROUTE_CACHE_MS, async () => {
      if (await left('route', ROUTE_BUDGET)) {
        try {
          await spend('route')
          // search.ch reads an arrival time as the earliest arrival; `pre` adds the trips that arrive in time.
          const params = new URLSearchParams({ from: stopKey(from), to: stopKey(to), date: when.date, time: when.time, time_type: timeType === 'arrive' ? 'arrival' : 'depart', num: String(num || (timeType === 'arrive' ? 2 : 5)), pre: timeType === 'arrive' ? '4' : '1', show_delays: '1', show_trackchanges: '1' })
          // search.ch reads repeated via[] in order (a plain repeated via keeps only the last one).
          for (const via of vias) params.append('via[]', stopKey(via))
          return { trips: parseSearchChRoute(await getJson(`${SEARCH_CH}/route.json?${params}`)), provider: 'search.ch', at: now().toISOString() }
        } catch (error) { log('warn', `Verbindungen search.ch fehlgeschlagen (${error?.status || error?.name || 'error'})`) }
      }
      await spend('fallback')
      const params = new URLSearchParams({ from: stopKey(from), to: stopKey(to), date: when.isoDay, time: when.time, isArrivalTime: timeType === 'arrive' ? '1' : '0', limit: String(Math.min(num || 5, 6)) })
      for (const via of vias) params.append('via[]', stopKey(via))
      return { trips: parseTransportRoute(await getJson(`${TRANSPORT}/connections?${params}`)), provider: 'transport.opendata.ch', at: now().toISOString() }
    })
  }

  return { stops, trips, budget: () => ({ ...budget }), clear: () => cache.clear() }
}

/** For an arrive target: trips arriving in time, the latest departure first (no needless early start). */
const rankArrive = (trips, deadline, now) => {
  const inTime = trips.filter((trip) => parseLocal(trip.arrival) <= deadline + 60_000 && parseLocal(trip.arrival) >= now)
    .sort((a, b) => parseLocal(b.departure) - parseLocal(a.departure))
  const good = inTime.filter((trip) => usable(trip, now))
  const rest = [...inTime.filter((trip) => !usable(trip, now)), ...trips.filter((trip) => !inTime.includes(trip) && parseLocal(trip.arrival) >= now)]
  return markQuietest([...good, ...rest].slice(0, 4), now)
}

/**
 * Commute runtime for the Kanti+ server. [lessonsFor](accountId) → snapshot events (or []),
 * [alertSettingsFor](accountId) → resolved alert settings, [publish](accountId, changes) sends
 * alerts through the push path, [ping](accountId) sends a silent "commute" data push.
 */
export const createCommute = (options = {}) => {
  const root = options.root
  const now = options.now || (() => new Date())
  const log = options.log || (() => {})
  const provider = options.provider || createCommuteProvider({ fetchImpl: options.fetch, now, log, budgetFile: root ? resolve(root, 'commute-budget.json') : '' })
  const lessonsFor = options.lessonsFor || (async () => [])
  const publish = options.publish || (async () => [])
  const ping = options.ping || (async () => {})
  const accountDir = (accountId) => resolve(root, 'accounts', accountId)
  const file = (accountId) => resolve(accountDir(accountId), 'commute.json')
  const stateFile = (accountId) => resolve(accountDir(accountId), 'commute-state.json')
  const due = new Map()

  const readJson = async (path) => { try { return JSON.parse(await fs.readFile(path, 'utf8')) } catch { return null } }
  const writeJson = async (path, value) => {
    const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    await fs.mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 })
    await fs.rename(temp, path)
  }

  const read = async (accountId) => {
    const stored = await readJson(file(accountId))
    const settings = sanitizeSettings(stored?.settings)
    // Version 1 hidden labels mixed half-class choices (removed) with hidden lessons; the app sends
    // the hidden lessons again, so no lesson stays left out of the first/last lesson.
    if (stored && Number(stored.version || 1) < 2) settings.hiddenLabels = []
    return { routes: sanitizeRoutes(stored?.routes), settings }
  }
  const view = async (accountId) => ({ ...(await read(accountId)), provider: PROVIDERS['search.ch'] })
  const save = async (accountId, body) => {
    // A client older than pins/two vias sends routes without those keys: keep what is stored.
    const known = new Map((await read(accountId)).routes.map((route) => [route.id, route]))
    const incoming = (Array.isArray(body?.routes) ? body.routes : []).map((raw) => {
      const stored = raw && typeof raw === 'object' ? known.get(raw.id) : null
      if (!stored) return raw
      const sameFirst = (stored.vias[0]?.id || stored.vias[0]?.name || '') === (raw.via?.id || raw.via?.name || '')
      return {
        ...raw,
        ...(!('pins' in raw) ? { pins: stored.pins } : {}),
        ...(!('vias' in raw) && sameFirst ? { vias: stored.vias } : {}),
      }
    })
    const routes = sanitizeRoutes(incoming)
    const settings = sanitizeSettings(body?.settings)
    await writeJson(file(accountId), { version: 2, routes, settings, updatedAt: now().toISOString() })
    due.delete(accountId)
    return { routes, settings, provider: PROVIDERS['search.ch'] }
  }

  /**
   * The live board of one route: target, ranked trips, alternatives when the first is unusable. A
   * pinned route puts its pinned connection first ([pinned] says whether it was found); [seen] is
   * the pinned trip the server already saw today, so one that vanished on its day reads as cancelled.
   */
  const routeBoard = async (route, settings, events, seen = null) => {
    const at = now().getTime()
    const target = routeTarget(route, { now: at, events, hiddenLabels: settings.hiddenLabels })
    const empty = { routeId: route.id, target, trips: [], alternatives: [], viaDropped: false, pinned: null, change: null, updatedAt: now().toISOString(), stale: false }
    if (!target) return empty
    const targetMs = parseLocal(target.at)
    let answer
    try {
      // A pinned connection: ask from two minutes before it (a leading walk starts earlier).
      const askAt = target.kind === 'pinned' ? targetMs - 2 * 60_000 : target.timeType === 'arrive' ? targetMs : Math.max(targetMs, at)
      answer = await provider.trips({ from: route.from, to: route.to, vias: route.vias, at: askAt, timeType: target.timeType })
    } catch {
      return { ...empty, stale: true }
    }
    let ranked = target.timeType === 'arrive' ? rankArrive(answer.trips, targetMs, at) : rankTrips(answer.trips, target.kind === 'pinned' ? Math.min(at, targetMs) : at)
    let pinned = null
    if (target.kind === 'pinned') {
      const found = matchPin(answer.trips, target.pin, target.day)
      let trip = found.trip
      let status = found.status
      if (!trip && seen && seen.day === target.day && seen.trip) {
        // Seen earlier today, gone now: search.ch drops some cancelled trips instead of marking them.
        trip = { ...seen.trip, status: 'cancelled', issues: [{ kind: 'cancelled', text: 'Nicht mehr im Fahrplan – fällt vermutlich aus' }, ...(seen.trip.issues || []).filter((issue) => issue.kind !== 'cancelled')] }
        status = 'gone'
      }
      pinned = { status, day: target.day, pin: target.pin, trip, nearest: found.nearest }
      ranked = trip ? [trip, ...ranked.filter((item) => item.id !== trip.id)].slice(0, 5) : ranked
    }
    let alternatives = []
    let viaDropped = false
    const first = ranked[0]
    if (first && !usable(first, at)) {
      alternatives = ranked.filter((trip) => trip !== first && usable(trip, at))
      if (target.kind === 'pinned') {
        // The pinned trip's own answer starts at it; alternatives are what leaves from now on.
        try {
          const later = await provider.trips({ from: route.from, to: route.to, vias: route.vias, at: Math.max(at, parseLocal(first.plannedDeparture) || at), timeType: 'depart' })
          alternatives = rankTrips(later.trips, at).filter((trip) => trip.id !== first.id && usable(trip, at))
        } catch { /* keep the ones from the board */ }
      }
      // Already on the way and a transfer broke: go on from the transfer stop.
      const broken = first.changes.find((change) => change.broken)
      if (first.status === 'broken' && broken && parseLocal(first.departure) <= at) {
        const leg = first.legs.find((item) => item.kind === 'ride' && item.from.name === broken.at)
        const stop = leg ? { id: leg.from.stopId, name: leg.from.name } : null
        if (stop) {
          try {
            const onward = await provider.trips({ from: stop, to: route.to, at: Math.max(at, parseLocal(first.legs[first.legs.indexOf(leg) - 1]?.to.time || '') || at), timeType: 'depart' })
            alternatives = rankTrips(onward.trips, at).filter((trip) => usable(trip, at))
          } catch { /* keep the whole-route alternatives */ }
        }
      }
      if (alternatives.length < 2 && route.vias.length) {
        try {
          const direct = await provider.trips({ from: route.from, to: route.to, at: Math.max(parseLocal(first.departure), at), timeType: 'depart' })
          const extra = rankTrips(direct.trips, at).filter((trip) => usable(trip, at) && !alternatives.some((known) => known.id === trip.id))
          if (extra.length) { alternatives = [...alternatives, ...extra].slice(0, 3); viaDropped = true }
        } catch { /* keep what we have */ }
      }
      alternatives = alternatives.slice(0, 3)
    }
    // A pinned route on a day with a lesson change: the earlier way home / later way to school.
    let change = null
    if (target.kind === 'pinned' && target.changeAt) {
      try {
        const changeMs = parseLocal(target.changeAt)
        const other = await provider.trips({ from: route.from, to: route.to, vias: route.vias, at: target.changeTimeType === 'arrive' ? changeMs : Math.max(changeMs, at), timeType: target.changeTimeType })
        const list = target.changeTimeType === 'arrive' ? rankArrive(other.trips, changeMs, at) : rankTrips(other.trips, at)
        change = list.find((trip) => usable(trip, at)) || null
      } catch { /* the pinned board still stands */ }
    }
    return { routeId: route.id, target, trips: ranked, alternatives, viaDropped, pinned, change, updatedAt: answer.at || now().toISOString(), stale: Boolean(answer.stale) }
  }

  const board = async (accountId, routeId = '') => {
    const { routes, settings } = await read(accountId)
    const events = await lessonsFor(accountId).catch(() => [])
    const chosen = routeId ? routes.filter((route) => route.id === routeId) : routes
    const state = chosen.some((route) => route.pins.length) ? (await readJson(stateFile(accountId))) : null
    const boards = []
    for (const route of chosen) boards.push(await routeBoard(route, settings, events, state?.routes?.[route.id]?.pinSeen || null))
    return { boards, provider: PROVIDERS['search.ch'] }
  }

  const tripsFor = async (accountId, routeId, atIso, timeType) => {
    const { routes } = await read(accountId)
    const route = routes.find((item) => item.id === routeId)
    if (!route) return null
    const at = Number.isFinite(parseLocal(atIso)) ? parseLocal(atIso) : now().getTime()
    const answer = await provider.trips({ from: route.from, to: route.to, vias: route.vias, at, timeType: timeType === 'arrive' ? 'arrive' : 'depart' })
    return { trips: timeType === 'arrive' ? rankArrive(answer.trips, at, now().getTime()) : rankTrips(answer.trips, Math.min(at, now().getTime()), 6) }
  }

  /**
   * The connection picker: trips for stops that need not be saved yet (the route editor), in
   * departure order from [at] on. Past trips of a future day are fine; that is what is picked.
   */
  const connections = async ({ from, to, vias = [], at, timeType = 'depart' }) => {
    const stop = (value) => {
      const raw = String(value || '').trim().slice(0, 80)
      if (!raw) return null
      return /^[A-Za-z0-9:_.-]{1,32}$/u.test(raw) && /\d/u.test(raw) ? { id: raw, name: raw } : sanitizeStop({ name: raw })
    }
    const start = stop(from)
    const end = stop(to)
    if (!start || !end) return null
    const when = Number.isFinite(parseLocal(at)) ? parseLocal(at) : now().getTime()
    const answer = await provider.trips({ from: start, to: end, vias: vias.map(stop).filter(Boolean).slice(0, MAX_VIAS), at: when, timeType: timeType === 'arrive' ? 'arrive' : 'depart', num: 8 })
    const seen = new Set()
    const trips = answer.trips.filter((trip) => trip.pin && (seen.has(trip.id) ? false : seen.add(trip.id)))
      .sort((a, b) => parseLocal(a.plannedDeparture) - parseLocal(b.plannedDeparture))
    return { trips: markQuietest(trips, Math.min(when, now().getTime())), stale: Boolean(answer.stale) }
  }

  /**
   * One background pass for an account: routes inside their travel window (or with a lesson
   * change for the day) are checked and alerted; everything else waits for its window.
   */
  const checkAccount = async (accountId) => {
    const at = now().getTime()
    if ((due.get(accountId) || 0) > at) return { checked: 0 }
    const { routes, settings } = await read(accountId)
    if (!routes.length) { due.set(accountId, at + 15 * 60_000); return { checked: 0 } }
    const events = await lessonsFor(accountId).catch(() => [])
    const state = (await readJson(stateFile(accountId))) || { version: 1, routes: {} }
    let next = Number.POSITIVE_INFINITY
    let checked = 0
    const alerts = []
    let moved = false
    for (const route of routes) {
      // Without a schedule or a pinned connection there is nothing to watch.
      if (route.schedule.mode === 'none' && !route.pins.length) continue
      const target = routeTarget(route, { now: at, events, hiddenLabels: settings.hiddenLabels })
      const routeState = state.routes[route.id] || {}
      const lessonNews = target && target.lessonChange !== 'none' && !routeState.lessons?.[`${target.at.slice(0, 10)}|${target.lessonChange}|${target.changeAt || target.at}`] && parseLocal(target.changeAt || target.at) - at <= 36 * 3600_000
      const guess = routeState.tracked && routeState.tracked.targetAt === target?.at ? routeState.tracked : null
      const opens = target ? (guess ? parseLocal(guess.departure) : parseLocal(target.at) - (target.timeType === 'arrive' ? 90 * 60_000 : 0)) - WINDOW_BEFORE_MS : Number.POSITIVE_INFINITY
      if (!target || (!lessonNews && at < opens)) {
        next = Math.min(next, Number.isFinite(opens) ? opens : at + 30 * 60_000)
        continue
      }
      checked += 1
      const live = await routeBoard(route, settings, events, routeState.pinSeen || null)
      // A pinned route tracks its pinned connection only; when it is missing, nothing is tracked.
      const tracked = live.pinned ? live.pinned.trip : live.trips[0] || null
      let updated = { ...routeState }
      if (live.pinned) {
        if (live.pinned.trip && live.pinned.status !== 'gone') {
          updated.pinSeen = { day: live.pinned.day, trip: live.pinned.trip }
          // Found again: a later disappearance alerts again.
          const pinKey = `${target.pin.line}|${target.pin.stop}|${target.pin.departure}`
          if (updated.pinMissing?.[pinKey]) { updated.pinMissing = { ...updated.pinMissing }; delete updated.pinMissing[pinKey] }
        } else if (live.pinned.status === 'missing' && !live.stale && at >= parseLocal(target.at) - WINDOW_BEFORE_MS) {
          const result = pinMissingAlert({ route, target, nearest: live.pinned.nearest, state: updated })
          alerts.push(...result.changes)
          updated = result.state
        }
      }
      const lessonTrip = live.pinned ? live.change : tracked && (usable(tracked, at) ? tracked : live.alternatives[0] || tracked)
      if (lessonNews && lessonTrip) {
        const result = lessonChangeAlert({ route, target, trip: lessonTrip, state: updated, now: at })
        alerts.push(...result.changes)
        updated = result.state
      }
      if (tracked && inWindow(target, tracked, at)) {
        const result = tripAlerts({ route, target, tracked, alternatives: live.alternatives, state: updated, delayThreshold: route.delayThreshold ?? settings.delayThreshold, now: at })
        alerts.push(...result.changes)
        updated = result.state
        const signature = `${tracked.id}|${tracked.status}|${tracked.depDelay}|${tracked.arrDelay}|${tracked.legs.map((leg) => leg.from.platform).join(',')}`
        if (routeState.signature && routeState.signature !== signature) moved = true
        updated.signature = signature
      }
      updated.tracked = tracked ? { id: tracked.id, departure: tracked.departure, arrival: tracked.arrival, targetAt: target.at } : null
      state.routes[route.id] = updated
      next = Math.min(next, nextCheckAt(target, tracked || (live.pinned ? { departure: target.at, arrival: target.at } : null), at))
    }
    for (const id of Object.keys(state.routes)) if (!routes.some((route) => route.id === id)) delete state.routes[id]
    await writeJson(stateFile(accountId), state)
    if (alerts.length) await publish(accountId, alerts)
    // The widget and the open app follow the tracked trip; a silent push when it changed.
    else if (moved) await ping(accountId)
    due.set(accountId, Math.max(at + CHECK_IMMINENT_MS, Number.isFinite(next) ? next : at + 30 * 60_000))
    return { checked, alerts: alerts.length }
  }

  const listAccounts = async () => {
    try {
      const names = await fs.readdir(resolve(root, 'accounts'))
      const out = []
      for (const name of names) if (/^[a-f0-9]{32}$/u.test(name) && await fs.stat(file(name)).then(() => true, () => false)) out.push(name)
      return out
    } catch { return [] }
  }

  /** Every account with routes, at most once a minute each (see nextCheckAt). */
  const tick = async () => {
    let checked = 0
    for (const accountId of await listAccounts()) {
      try { checked += (await checkAccount(accountId)).checked } catch (error) { log('warn', `Pendelstrecke ${accountId.slice(0, 8)} nicht geprüft (${error?.name || 'error'})`) }
    }
    return checked
  }

  const remove = async (accountId) => {
    await fs.rm(file(accountId), { force: true })
    await fs.rm(stateFile(accountId), { force: true })
    due.delete(accountId)
  }

  return { view, save, board, tripsFor, connections, stops: provider.stops, checkAccount, tick, remove, provider, due, isoZurich }
}
