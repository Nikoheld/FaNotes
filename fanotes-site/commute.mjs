// Pendelstrecken (commute routes): provider, storage, live boards and the alert check.
// Contract: commute-api.md. Logic: commute-logic.mjs. Routes never go to Schulnetz.

import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  CHECK_IMMINENT_MS, WINDOW_BEFORE_MS, inWindow, isoZurich, lessonChangeAlert, markQuietest, nextCheckAt, parseCompletion,
  parseLocal, parseSearchChRoute, parseTransportRoute, rankTrips, routeTarget, sanitizeRoutes, sanitizeSettings, tripAlerts,
  usable, zurichWall,
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

  /** Trips around [at] (ms) for from → to (via), departing or arriving at that time. */
  const trips = ({ from, to, via = null, at, timeType = 'depart' }) => {
    const when = searchDate(at)
    const stopKey = (stop) => stop?.id || stop?.name || ''
    // Cached per minute of the asked time: equal questions from several people share one answer.
    const key = `route:${stopKey(from)}>${stopKey(via)}>${stopKey(to)}@${when.isoDay}T${when.time}:${timeType}`
    return cached(key, ROUTE_CACHE_MS, async () => {
      if (await left('route', ROUTE_BUDGET)) {
        try {
          await spend('route')
          // search.ch reads an arrival time as the earliest arrival; `pre` adds the trips that arrive in time.
          const params = new URLSearchParams({ from: stopKey(from), to: stopKey(to), date: when.date, time: when.time, time_type: timeType === 'arrive' ? 'arrival' : 'depart', num: timeType === 'arrive' ? '2' : '5', pre: timeType === 'arrive' ? '4' : '1', show_delays: '1', show_trackchanges: '1' })
          if (via) params.set('via', stopKey(via))
          return { trips: parseSearchChRoute(await getJson(`${SEARCH_CH}/route.json?${params}`)), provider: 'search.ch', at: now().toISOString() }
        } catch (error) { log('warn', `Verbindungen search.ch fehlgeschlagen (${error?.status || error?.name || 'error'})`) }
      }
      await spend('fallback')
      const params = new URLSearchParams({ from: stopKey(from), to: stopKey(to), date: when.isoDay, time: when.time, isArrivalTime: timeType === 'arrive' ? '1' : '0', limit: '5' })
      if (via) params.append('via[]', stopKey(via))
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
    return { routes: sanitizeRoutes(stored?.routes), settings: sanitizeSettings(stored?.settings) }
  }
  const view = async (accountId) => ({ ...(await read(accountId)), provider: PROVIDERS['search.ch'] })
  const save = async (accountId, body) => {
    const routes = sanitizeRoutes(body?.routes)
    const settings = sanitizeSettings(body?.settings)
    await writeJson(file(accountId), { version: 1, routes, settings, updatedAt: now().toISOString() })
    due.delete(accountId)
    return { routes, settings, provider: PROVIDERS['search.ch'] }
  }

  /** The live board of one route: target, ranked trips, alternatives when the first is unusable. */
  const routeBoard = async (route, settings, events) => {
    const at = now().getTime()
    const target = routeTarget(route, { now: at, events, hiddenLabels: settings.hiddenLabels })
    if (!target) return { routeId: route.id, target: null, trips: [], alternatives: [], viaDropped: false, updatedAt: now().toISOString(), stale: false }
    const targetMs = parseLocal(target.at)
    let answer
    try {
      answer = await provider.trips({ from: route.from, to: route.to, via: route.via, at: target.timeType === 'arrive' ? targetMs : Math.max(targetMs, at), timeType: target.timeType })
    } catch {
      return { routeId: route.id, target, trips: [], alternatives: [], viaDropped: false, updatedAt: now().toISOString(), stale: true }
    }
    const ranked = target.timeType === 'arrive' ? rankArrive(answer.trips, targetMs, at) : rankTrips(answer.trips, at)
    let alternatives = []
    let viaDropped = false
    const first = ranked[0]
    if (first && !usable(first, at)) {
      alternatives = ranked.filter((trip) => trip !== first && usable(trip, at))
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
      if (alternatives.length < 2 && route.via) {
        try {
          const direct = await provider.trips({ from: route.from, to: route.to, at: Math.max(parseLocal(first.departure), at), timeType: 'depart' })
          const extra = rankTrips(direct.trips, at).filter((trip) => usable(trip, at) && !alternatives.some((known) => known.id === trip.id))
          if (extra.length) { alternatives = [...alternatives, ...extra].slice(0, 3); viaDropped = true }
        } catch { /* keep what we have */ }
      }
      alternatives = alternatives.slice(0, 3)
    }
    return { routeId: route.id, target, trips: ranked, alternatives, viaDropped, updatedAt: answer.at || now().toISOString(), stale: Boolean(answer.stale) }
  }

  const board = async (accountId, routeId = '') => {
    const { routes, settings } = await read(accountId)
    const events = await lessonsFor(accountId).catch(() => [])
    const chosen = routeId ? routes.filter((route) => route.id === routeId) : routes
    const boards = []
    for (const route of chosen) boards.push(await routeBoard(route, settings, events))
    return { boards, provider: PROVIDERS['search.ch'] }
  }

  const tripsFor = async (accountId, routeId, atIso, timeType) => {
    const { routes } = await read(accountId)
    const route = routes.find((item) => item.id === routeId)
    if (!route) return null
    const at = Number.isFinite(parseLocal(atIso)) ? parseLocal(atIso) : now().getTime()
    const answer = await provider.trips({ from: route.from, to: route.to, via: route.via, at, timeType: timeType === 'arrive' ? 'arrive' : 'depart' })
    return { trips: timeType === 'arrive' ? rankArrive(answer.trips, at, now().getTime()) : rankTrips(answer.trips, Math.min(at, now().getTime()), 6) }
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
      if (route.schedule.mode === 'none') continue
      const target = routeTarget(route, { now: at, events, hiddenLabels: settings.hiddenLabels })
      const routeState = state.routes[route.id] || {}
      const lessonNews = target && target.lessonChange !== 'none' && !routeState.lessons?.[`${target.at.slice(0, 10)}|${target.lessonChange}|${target.at}`] && parseLocal(target.at) - at <= 36 * 3600_000
      const guess = routeState.tracked && routeState.tracked.targetAt === target?.at ? routeState.tracked : null
      const opens = target ? (guess ? parseLocal(guess.departure) : parseLocal(target.at) - (target.timeType === 'arrive' ? 90 * 60_000 : 0)) - WINDOW_BEFORE_MS : Number.POSITIVE_INFINITY
      if (!target || (!lessonNews && at < opens)) {
        next = Math.min(next, Number.isFinite(opens) ? opens : at + 30 * 60_000)
        continue
      }
      checked += 1
      const live = await routeBoard(route, settings, events)
      const tracked = live.trips[0] || null
      let updated = { ...routeState }
      if (lessonNews && tracked) {
        const result = lessonChangeAlert({ route, target, trip: usable(tracked, at) ? tracked : live.alternatives[0] || tracked, state: updated, now: at })
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
      next = Math.min(next, nextCheckAt(target, tracked, at))
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

  return { view, save, board, tripsFor, stops: provider.stops, checkAccount, tick, remove, provider, due, isoZurich }
}
