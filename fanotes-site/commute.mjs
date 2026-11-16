// Pendelstrecken (commute routes): provider, storage, live boards and the alert check.
// Contract: commute-api.md. Logic: commute-logic.mjs. Routes never go to Schulnetz.

import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  CHAIN_TRANSFER_MIN, CHECK_IMMINENT_MS, MAX_PINS, MAX_TIMES, MAX_VIAS, chainSegments, hasViaLoop, passesVias, sameViaStop, matchTransportLeg, mergeLegDetail, slimTrip, tripPosition, WINDOW_BEFORE_MS, inWindow, isoZurich, lessonChangeAlert, markQuietest, matchPin, nextCheckAt,
  parseCompletion, parseLocal, parseSearchChRoute, parseTransportRoute, pinMissingAlert, rankTrips, routeTarget, sanitizePins, sanitizeRoutes, sanitizeSchedule, sanitizeVias,
  sanitizeSettings, sanitizeStop, tripAlerts, usable, zurichWall,
} from './commute-logic.mjs'
import { createServiceLog, routeOf } from './service-log.mjs'

export const SEARCH_CH = 'https://timetable.search.ch/api'
export const TRANSPORT = 'https://transport.opendata.ch/v1'
/** search.ch allows 1000 route queries and 10080 boards a day; keep a margin for other users of the IP. */
export const ROUTE_BUDGET = 850
export const COMPLETION_BUDGET = 3000
/** transport.opendata.ch lookups for the connection detail (platforms and arrival forecasts per stop). */
export const DETAIL_BUDGET = 900
export const ROUTE_CACHE_MS = 30_000
/** Last good timetable kept on disk so a restart can still answer while the source is down. */
export const ROUTE_DISK_MS = 6 * 60 * 60 * 1000
export const STOP_CACHE_MS = 24 * 60 * 60_000
/** One timetable request gives up after this, then retries transient failures. */
export const UPSTREAM_TIMEOUT_MS = 12_000
export const UPSTREAM_ATTEMPTS = 3
/** Wait before the second and third attempt. A 4xx is not retried. */
export const UPSTREAM_RETRY_MS = [200, 800]
/** A timetable or stop answer larger than this is dropped. It is not parsed and not retried. */
export const UPSTREAM_BODY_MAX = 1024 * 1024

// Stop once the cap is passed. The rest of the body is never stored.
const readLimitedText = async (response, max) => {
  const reader = response.body?.getReader?.()
  if (!reader) {
    const body = typeof response.text === 'function' ? await response.text() : ''
    if (body.length > max) throw new Error('page too large')
    return body
  }
  const decoder = new TextDecoder('utf-8')
  let size = 0
  let body = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return body + decoder.decode()
    const bytes = value?.byteLength || 0
    size += bytes
    if (size > max) {
      if (typeof reader.cancel === 'function') await Promise.resolve(reader.cancel()).catch(() => undefined)
      throw new Error('page too large')
    }
    if (bytes) body += decoder.decode(value, { stream: true })
  }
}
const readUpstreamJson = async (response) => {
  const hasReader = typeof response.body?.getReader === 'function'
  if (!hasReader && typeof response.text !== 'function' && typeof response.json === 'function') return response.json()
  return JSON.parse(await readLimitedText(response, UPSTREAM_BODY_MAX))
}
// An error page is not parsed. Cancel it so the rest is not kept.
const releaseUnread = async (response) => {
  const reader = response?.body?.getReader?.()
  if (reader && typeof reader.cancel === 'function') await Promise.resolve(reader.cancel()).catch(() => undefined)
}
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

/** Transient upstream failures: timeouts, dropped connections, and 408/429/5xx. */
export const upstreamRetryable = (error) => {
  const status = Number(error?.status)
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return true
  const name = String(error?.name || '')
  if (name === 'TimeoutError' || name === 'AbortError') return true
  const code = String(error?.code || error?.cause?.code || '')
  if (['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT'].includes(code)) return true
  return error instanceof TypeError
}

/**
 * Timetable provider with a shared 30 s cache, in-flight sharing for identical queries, retries on
 * transient upstream failures, and a daily budget that falls back to transport.opendata.ch, then
 * to the last good answer (stale).
 */
export const createCommuteProvider = ({ fetchImpl = fetch, now = () => new Date(), log = () => {}, budgetFile = '', routeFile = '', sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), jsonLog } = {}) => {
  // Production emits one JSON line per upstream call. Tests pass jsonLog when they want the lines.
  const events = jsonLog || createServiceLog('commute', (line) => {
    if (process.env.NODE_ENV === 'production') console.log(line)
  }, now)
  const cache = new Map()
  const inflight = new Map()
  let budget = { day: '', route: 0, completion: 0, fallback: 0, detail: 0 }
  let budgetLoaded = false
  let budgetBlocked = false
  let budgetQueue = Promise.resolve()
  const withBudget = (task) => {
    const run = budgetQueue.then(task, task)
    budgetQueue = run.then(() => undefined, () => undefined)
    return run
  }
  const budgetCounts = ['route', 'completion', 'fallback', 'detail']
  const loadBudget = async () => {
    if (budgetLoaded || !budgetFile) return
    try {
      const parsed = JSON.parse(await fs.readFile(budgetFile, 'utf8'))
      // A missing or broken file can start again. A file that is there but not today's counts must not look empty, or the next lookup replaces it with zeros.
      if (!parsed || typeof parsed.day !== 'string' || budgetCounts.some((key) => !Number.isFinite(parsed[key]))) {
        budgetBlocked = true
        return
      }
      budget = { ...budget, ...parsed }
      budgetBlocked = false
    } catch (error) {
      // A missing or broken file can start again. A read error must not replace today's count with zeros.
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    budgetLoaded = true
  }
  const rollBudget = () => {
    const day = zurichWall(now().getTime()).day
    if (budget.day !== day) budget = { day, route: 0, completion: 0, fallback: 0, detail: 0 }
  }
  const writeBudget = async () => {
    if (!budgetFile) return
    const temporary = `${budgetFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await fs.mkdir(dirname(budgetFile), { recursive: true })
      await fs.writeFile(temporary, JSON.stringify(budget), { mode: 0o600 })
      await fs.rename(temporary, budgetFile)
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
  }
  // Check and increment under one lock. Two requests must not both pass the daily cap.
  const reserve = (kind, limit) => withBudget(async () => {
    await loadBudget()
    if (budgetBlocked) return false
    rollBudget()
    if (budget[kind] >= limit) return false
    budget[kind] += 1
    await writeBudget()
    return true
  })
  const spend = (kind) => withBudget(async () => {
    await loadBudget()
    if (budgetBlocked) return
    rollBudget()
    budget[kind] += 1
    await writeBudget()
  })
  const DISK_LIMIT = 40
  let disk = { entries: [] }
  let diskLoading = null
  let diskBlocked = false
  const loadDisk = () => {
    if (!routeFile) return Promise.resolve()
    if (!diskLoading) {
      diskLoading = (async () => {
        try {
          const parsed = JSON.parse(await fs.readFile(routeFile, 'utf8'))
          const entryKnown = (entry) => Boolean(entry) && typeof entry.key === 'string' && entry.key.startsWith('route:') && entry.key.length <= 300
            && Number.isFinite(entry.at) && entry.value && Array.isArray(entry.value.trips)
          // A missing or broken file can start again. A file that is there but not this timetable must not look empty, or the next route replaces it.
          // An entry that is not a stored trip must not be dropped, or the next route replaces the timetable.
          if (parsed?.version === 1 && Array.isArray(parsed.entries) && parsed.entries.every(entryKnown)) {
            disk.entries = parsed.entries.slice(-DISK_LIMIT)
            diskBlocked = false
          } else {
            diskBlocked = true
          }
        } catch (error) {
          if (error?.code === 'ENOENT' || error instanceof SyntaxError) return
          diskLoading = null
          throw error
        }
      })()
    }
    return diskLoading
  }
  // Different routes finish together. Writes run one at a time, each into its own temp file,
  // so one rename cannot replace the file with the other route missing.
  let diskQueue = Promise.resolve()
  const remember = (key, at, value) => {
    const run = diskQueue.then(async () => {
      if (!routeFile || !key.startsWith('route:') || !Array.isArray(value?.trips) || !value.trips.length) return
      // Leave an unreadable timetable file as it is. The live answer is still returned.
      try { await loadDisk() } catch { return }
      if (diskBlocked) return
      disk.entries = [...disk.entries.filter((entry) => entry.key !== key), { key, at, value }].slice(-DISK_LIMIT)
      const temporary = `${routeFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      try {
        await fs.mkdir(dirname(routeFile), { recursive: true })
        await fs.writeFile(temporary, JSON.stringify({ version: 1, entries: disk.entries }), { mode: 0o600 })
        await fs.rename(temporary, routeFile)
      } catch {
        await fs.rm(temporary, { force: true }).catch(() => undefined)
      }
    })
    diskQueue = run.then(() => undefined, () => undefined)
    return run
  }
  const recall = async (key) => {
    if (!routeFile || !key.startsWith('route:')) return null
    await loadDisk()
    const at = now().getTime()
    const found = [...disk.entries].reverse().find((entry) => entry.key === key && at - entry.at < ROUTE_DISK_MS && at >= entry.at)
    return found ? { ...found.value, stale: true } : null
  }
  const getJson = async (url) => {
    const route = routeOf(url)
    const requestId = events.requestId()
    let last = null
    for (let attempt = 1; attempt <= UPSTREAM_ATTEMPTS; attempt += 1) {
      const started = now().getTime()
      const elapsed = () => Math.max(0, now().getTime() - started)
      try {
        const response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, redirect: 'error', signal: AbortSignal.timeout?.(UPSTREAM_TIMEOUT_MS) })
        if (!response.ok && response.status !== 200) {
          await releaseUnread(response)
          last = Object.assign(new Error('provider'), { status: response.status })
          events.warn({ requestId, method: 'GET', route, status: response.status, attempt, error: 'Error', ms: elapsed() })
          if (!upstreamRetryable(last) || attempt === UPSTREAM_ATTEMPTS) throw last
        } else {
          const body = await readUpstreamJson(response)
          events.info({ requestId, method: 'GET', route, status: response.status || 200, attempt, ms: elapsed() })
          return body
        }
      } catch (error) {
        if (error === last) throw error
        last = error
        events.warn({ requestId, method: 'GET', route, status: Number(error?.status) || 0, attempt, error: String(error?.name || 'error'), ms: elapsed() })
        if (!upstreamRetryable(error) || attempt === UPSTREAM_ATTEMPTS) throw error
      }
      await sleep(UPSTREAM_RETRY_MS[attempt - 1] ?? UPSTREAM_RETRY_MS.at(-1))
    }
    throw last
  }
  const cached = async (key, ttl, load) => {
    const hit = cache.get(key)
    const at = now().getTime()
    if (hit && at - hit.at < ttl) return { ...hit.value, cached: true }
    if (inflight.has(key)) return inflight.get(key)
    const task = (async () => {
      try {
        const value = await load()
        const at = now().getTime()
        cache.set(key, { at, value })
        if (cache.size > 2000) cache.delete(cache.keys().next().value)
        await remember(key, at, value)
        return value
      } catch (error) {
        if (hit) return { ...hit.value, stale: true }
        try {
          const stored = await recall(key)
          if (stored) return stored
        } catch { /* the disk copy is optional */ }
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
      if (await reserve('completion', COMPLETION_BUDGET)) {
        try {
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

  const stopKey = (stop) => stop?.id || stop?.name || ''
  const routeKey = ({ from, to, vias, at, timeType, num }) => {
    const when = searchDate(at)
    // Cached per minute of the asked time: equal questions from several people share one answer.
    return `route:${stopKey(from)}>${vias.map(stopKey).join('>')}>${stopKey(to)}@${when.isoDay}T${when.time}:${timeType}:${num}`
  }

  /** One timetable query (search.ch, then transport.opendata.ch) for from → to through [vias] in order; no guard, no cache. */
  const fetchTrips = async ({ from, to, vias, at, timeType, num }) => {
    const when = searchDate(at)
    if (await reserve('route', ROUTE_BUDGET)) {
      try {
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
  }

  /** A single segment search without vias, cached like any other answer. Each one counts against the route budget. */
  const segmentTrips = (query) => {
    const full = { ...query, vias: [], num: query.num || 6 }
    return cached(routeKey(full), ROUTE_CACHE_MS, () => fetchTrips(full))
  }

  /**
   * Chained trips for a loop route (a via equals the start, the destination or the other via):
   * segment searches from → via1 → via2 → to, each next one at or after the previous arrival plus
   * the minimum transfer time (depart), or backward from the last segment (arrive).
   */
  const chainedTrips = async ({ from, to, vias, at, timeType, num }) => {
    // A via equal to its neighbour (start at the start) adds no ride: those stops collapse.
    const points = [from, ...vias, to].filter((stop, index, all) => index === 0 || !sameViaStop(stop, all[index - 1]))
    if (points.length < 2) return { trips: [], provider: 'search.ch', at: now().toISOString(), chained: true }
    const segments = points.slice(0, -1).map((start, index) => ({ from: start, to: points[index + 1] }))
    const transfer = CHAIN_TRANSFER_MIN * 60_000
    const want = num || 4
    const alive = (trip) => trip.status !== 'cancelled'
    let providerName = 'search.ch'
    let stale = false
    const ask = async (segment, when) => {
      const answer = await segmentTrips({ ...segment, at: when, timeType })
      providerName = answer.provider || providerName
      stale = stale || Boolean(answer.stale)
      return answer.trips || []
    }
    let chains
    if (timeType === 'arrive') {
      const last = segments.length - 1
      chains = (await ask(segments[last], at)).sort((a, b) => parseLocal(b.departure) - parseLocal(a.departure)).slice(0, want).map((trip) => [trip])
      for (let index = last - 1; index >= 0 && chains.length; index -= 1) {
        // Arriving in time for the next segment's departure: the latest deadline asks, every chain takes the latest trip that fits.
        const deadline = (chain) => parseLocal(chain[0].departure) - transfer
        const list = await ask(segments[index], Math.max(...chains.map(deadline)))
        chains = chains.map((chain) => {
          const fit = list.filter((trip) => alive(trip) && parseLocal(trip.arrival) <= deadline(chain)).sort((a, b) => parseLocal(b.departure) - parseLocal(a.departure))[0]
          return fit ? [fit, ...chain] : null
        }).filter(Boolean)
      }
    } else {
      chains = (await ask(segments[0], at)).sort((a, b) => parseLocal(a.departure) - parseLocal(b.departure)).slice(0, want).map((trip) => [trip])
      for (let index = 1; index < segments.length && chains.length; index += 1) {
        const ready = (chain) => parseLocal(chain[chain.length - 1].arrival) + transfer
        const list = await ask(segments[index], Math.min(...chains.map(ready)))
        chains = chains.map((chain) => {
          const fit = list.filter((trip) => alive(trip) && parseLocal(trip.departure) >= ready(chain)).sort((a, b) => parseLocal(a.departure) - parseLocal(b.departure))[0]
          return fit ? [...chain, fit] : null
        }).filter(Boolean)
      }
    }
    const chained = chains.map((chain) => chainSegments(chain))
    return { trips: chained, provider: providerName, at: now().toISOString(), chained: true, ...(stale ? { stale: true } : {}) }
  }

  /**
   * Trips around [at] (ms) for from → to (through [vias] in order), departing or arriving at that
   * time. Only trips that pass the vias in order are returned; when none does (or the provider
   * fails) and the vias contain a loop, trips are chained from segment searches.
   */
  const trips = ({ from, to, vias = [], at, timeType = 'depart', num = 0 }) => {
    vias = (vias || []).filter(Boolean).slice(0, MAX_VIAS)
    const query = { from, to, vias, at, timeType, num }
    const loop = hasViaLoop(from, to, vias)
    return cached(routeKey(query), ROUTE_CACHE_MS, async () => {
      let answer = null
      let failure = null
      try { answer = await fetchTrips(query) } catch (error) { failure = error }
      if (answer && vias.length) {
        const passing = answer.trips.filter((trip) => passesVias(trip, vias))
        // Without a loop the provider already honoured the vias: a name that does not match must not empty the board.
        if (passing.length || loop) answer = { ...answer, trips: passing }
      }
      if ((!answer || !answer.trips.length) && loop) {
        try {
          const chained = await chainedTrips(query)
          if (chained.trips.length) return chained
        } catch (error) { failure = failure || error }
      }
      if (!answer) throw failure
      return answer
    })
  }

  /**
   * The same vehicle from transport.opendata.ch, for its platforms and arrival forecasts per stop:
   * one query for the leg's own stops at its planned departure. Null when the budget is spent or the
   * provider has no match; the detail then shows what search.ch has.
   */
  const legDetail = async (leg) => {
    const at = parseLocal(leg.from.planned)
    if (!Number.isFinite(at)) return null
    const when = searchDate(at)
    const key = `detail:${leg.from.stopId || leg.from.name}>${leg.to.stopId || leg.to.name}@${when.isoDay}T${when.time}:${leg.trainNo || leg.line}`
    try {
      const answer = await cached(key, ROUTE_CACHE_MS, async () => {
        if (!(await reserve('detail', DETAIL_BUDGET))) throw Object.assign(new Error('budget'), { status: 429 })
        const params = new URLSearchParams({ from: leg.from.stopId || leg.from.name, to: leg.to.stopId || leg.to.name, date: when.isoDay, time: when.time, limit: '3' })
        return { trips: parseTransportRoute(await getJson(`${TRANSPORT}/connections?${params}`)) }
      })
      return matchTransportLeg(leg, answer.trips || [])
    } catch (error) {
      if (error?.status !== 429) log('warn', `Haltestellen-Details transport.opendata.ch fehlgeschlagen (${error?.status || error?.name || 'error'})`)
      return null
    }
  }

  return { stops, trips, legDetail, budget: () => ({ ...budget }), clear: () => cache.clear() }
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
  const provider = options.provider || createCommuteProvider({ fetchImpl: options.fetch, now, log, sleep: options.sleep, budgetFile: root ? resolve(root, 'commute-budget.json') : '', routeFile: root ? resolve(root, 'commute-routes.json') : '' })
  const lessonsFor = options.lessonsFor || (async () => [])
  const publish = options.publish || (async () => [])
  const ping = options.ping || (async () => {})
  const accountDir = (accountId) => resolve(root, 'accounts', accountId)
  const file = (accountId) => resolve(accountDir(accountId), 'commute.json')
  const stateFile = (accountId) => resolve(accountDir(accountId), 'commute-state.json')
  const due = new Map()
  // Saves and removals for one account run one at a time. Two clients otherwise both read the
  // old pins, and the slower write puts those pins back over the newer ones.
  const accountQueues = new Map()
  const withAccount = (accountId, task) => {
    const previous = accountQueues.get(accountId) || Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(() => undefined, () => undefined)
    accountQueues.set(accountId, tail)
    tail.then(() => { if (accountQueues.get(accountId) === tail) accountQueues.delete(accountId) })
    return run
  }

  const readJson = async (path) => {
    try {
      return JSON.parse(await fs.readFile(path, 'utf8'))
    } catch (error) {
      // A missing or broken file can start again. A read error must not look empty, or the next save replaces the route.
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null
      throw error
    }
  }
  const writeJson = async (path, value) => {
    const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await fs.mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
    try {
      await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 })
      await fs.rename(temp, path)
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }
  const readState = async (accountId) => {
    const stored = await readJson(stateFile(accountId))
    // A missing or broken file can start again. A file that is there but not this alert state must not look empty, or the next check replaces it.
    if (stored == null) return null
    const routes = stored.routes
    const plainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
    // An entry that is not an alert record must not look absent, or the next check replaces it.
    const known = plainObject(stored) && plainObject(routes) && Object.values(routes).every(plainObject)
    if (!known) throw Object.assign(new Error('commute state'), { code: 'EBADMSG' })
    return stored
  }

  const read = async (accountId) => {
    const stored = await readJson(file(accountId))
    // A missing or broken file can start again. A file that is there but not this route list must not look empty, or the next save replaces it.
    if (stored != null) {
      const known = typeof stored === 'object' && !Array.isArray(stored) && Array.isArray(stored.routes)
      if (!known) throw Object.assign(new Error('commute routes'), { code: 'EBADMSG' })
      // An entry the sanitizer would skip must not look absent, or the next check deletes its alert state and the next save drops the route.
      if (sanitizeRoutes(stored.routes).length !== stored.routes.length) throw Object.assign(new Error('commute routes'), { code: 'EBADMSG' })
      const weekdayKept = (day) => {
        const number = Number(day)
        return Number.isInteger(number) && number >= 1 && number <= 7
      }
      const STOP_TYPES = ['train', 'bus', 'tram', 'ship', 'cableway', 'other']
      const stopTypeKnown = (stop) => stop == null || typeof stop !== 'object' || Array.isArray(stop) || stop.type == null || STOP_TYPES.includes(stop.type)
      const thresholdKept = (value) => {
        if (value == null) return true
        const number = Number(value)
        return Number.isFinite(number) && number >= 1 && number <= 30
      }
      const transfersKept = (value) => {
        if (value == null) return true
        const number = Number(value)
        return Number.isInteger(number) && number >= 0 && number <= 9
      }
      const stopIdKept = (value) => {
        if (value == null || value === '') return true
        const stopId = String(value).replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 32)
        return /^[A-Za-z0-9:_.-]{1,32}$/u.test(stopId)
      }
      const detailKnown = (route) => {
        const pins = route?.pins
        const vias = route?.vias
        const schedule = route?.schedule
        const times = schedule?.times
        const days = schedule?.days
        const mode = schedule?.mode
        const buffer = schedule?.bufferMinutes
        if (pins != null && !Array.isArray(pins)) return false
        if (Array.isArray(pins) && sanitizePins(pins.slice(0, MAX_PINS)).length !== Math.min(pins.length, MAX_PINS)) return false
        if (Array.isArray(pins) && pins.slice(0, MAX_PINS).some((pin) => Array.isArray(pin?.days) && pin.days.some((day) => !weekdayKept(day)))) return false
        if (Array.isArray(pins) && pins.slice(0, MAX_PINS).some((pin) => pin && typeof pin === 'object' && (!transfersKept(pin.transfers) || !stopIdKept(pin.stopId)))) return false
        if (vias != null && !Array.isArray(vias)) return false
        if (Array.isArray(vias) && sanitizeVias({ vias: vias.slice(0, MAX_VIAS) }).length !== Math.min(vias.length, MAX_VIAS)) return false
        if (Array.isArray(vias) && vias.slice(0, MAX_VIAS).some((via) => !stopTypeKnown(via))) return false
        if (!stopTypeKnown(route?.from) || !stopTypeKnown(route?.to)) return false
        if (route?.notify != null && typeof route.notify !== 'boolean') return false
        if (!thresholdKept(route?.delayThreshold)) return false
        if (schedule != null && (typeof schedule !== 'object' || Array.isArray(schedule))) return false
        if (days != null && !Array.isArray(days)) return false
        if (Array.isArray(days) && days.some((day) => !weekdayKept(day))) return false
        if (mode != null && !['none', 'times', 'firstLesson', 'lastLesson'].includes(mode)) return false
        if (buffer != null && buffer !== '' && (typeof buffer !== 'number' || !Number.isFinite(buffer))) return false
        if (times != null && !Array.isArray(times)) return false
        if (route?.schedule?.mode === 'times' && Array.isArray(times) && sanitizeSchedule({ mode: 'times', times: times.slice(0, MAX_TIMES) }).times.length !== Math.min(times.length, MAX_TIMES)) return false
        return true
      }
      // A pin, via, time, weekday, schedule, stop type, threshold, or notify flag the sanitizer would replace must not look absent, or the next save drops it. The caps stay.
      if (!stored.routes.every(detailKnown)) throw Object.assign(new Error('commute routes'), { code: 'EBADMSG' })
      // Hidden labels or a threshold that are not the known shape must not look like the defaults, or the next save clears them.
      const settings = stored.settings
      if (settings != null) {
        const labels = settings.hiddenLabels
        const threshold = settings.delayThreshold
        const settingsKnown = typeof settings === 'object' && !Array.isArray(settings)
          && (labels == null || (Array.isArray(labels) && labels.every((label) => typeof label === 'string')))
          && (threshold == null || (typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 1 && threshold <= 30))
        if (!settingsKnown) throw Object.assign(new Error('commute settings'), { code: 'EBADMSG' })
      }
    }
    const settings = sanitizeSettings(stored?.settings)
    // Version 1 hidden labels mixed half-class choices (removed) with hidden lessons; the app sends
    // the hidden lessons again, so no lesson stays left out of the first/last lesson.
    if (stored && Number(stored.version || 1) < 2) settings.hiddenLabels = []
    return { routes: sanitizeRoutes(stored?.routes), settings }
  }
  const view = async (accountId) => ({ ...(await read(accountId)), provider: PROVIDERS['search.ch'] })
  const save = (accountId, body) => withAccount(accountId, async () => {
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
  })

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
    // lastLesson before the lesson has ended: a trip that leaves before lesson end + walking time is
    // unreachable from school (`pre` can return one), so it never ranks. After that moment the plain "from now" ranking applies.
    if (target.kind === 'lastLesson' && at < targetMs) answer = { ...answer, trips: answer.trips.filter((trip) => parseLocal(trip.departure) >= targetMs) }
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
    // Boards carry no stop lists (they are polled often); the connection detail asks for them.
    const slimPinned = pinned ? { ...pinned, trip: slimTrip(pinned.trip), nearest: slimTrip(pinned.nearest) } : null
    return { routeId: route.id, target, trips: ranked.map(slimTrip), alternatives: alternatives.map(slimTrip), viaDropped, pinned: slimPinned, change: slimTrip(change), updatedAt: answer.at || now().toISOString(), stale: Boolean(answer.stale) }
  }

  const board = async (accountId, routeId = '') => {
    const { routes, settings } = await read(accountId)
    const events = await lessonsFor(accountId).catch(() => [])
    const chosen = routeId ? routes.filter((route) => route.id === routeId) : routes
    const state = chosen.some((route) => route.pins.length) ? await readState(accountId) : null
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
    const state = (await readState(accountId)) || { version: 1, routes: {} }
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
    // A removal that finished during this check must not bring the state file back.
    const kept = await withAccount(accountId, async () => {
      try { await fs.stat(file(accountId)) } catch { return false }
      await writeJson(stateFile(accountId), state)
      return true
    })
    if (!kept) {
      due.delete(accountId)
      return { checked, alerts: 0 }
    }
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
      try { checked += (await checkAccount(accountId)).checked } catch (error) { log('warn', `Pendelstrecke nicht geprüft (${error?.name || 'error'})`) }
    }
    return checked
  }

  const remove = (accountId) => withAccount(accountId, async () => {
    await fs.rm(file(accountId), { force: true })
    await fs.rm(stateFile(accountId), { force: true })
    due.delete(accountId)
  })

  /**
   * The connection detail: one trip of a route with every leg, every intermediate stop, real times,
   * platforms and where the vehicle is now. [tripId] and [plannedDeparture] come from a board.
   * `gone` when the timetable no longer has that trip.
   */
  const tripDetail = async (accountId, routeId, tripId, plannedDeparture) => {
    const { routes } = await read(accountId)
    const route = routes.find((item) => item.id === routeId)
    if (!route) return null
    const planned = parseLocal(plannedDeparture)
    if (!tripId || !Number.isFinite(planned)) return { trip: null, gone: true }
    const at = now().getTime()
    let answer
    try {
      answer = await provider.trips({ from: route.from, to: route.to, vias: route.vias, at: planned - 2 * 60_000, timeType: 'depart' })
    } catch {
      return { trip: null, gone: false, stale: true, updatedAt: now().toISOString() }
    }
    const found = (answer.trips || []).find((trip) => trip.id === tripId)
    if (!found) return { trip: null, gone: true, updatedAt: answer.at || now().toISOString(), stale: Boolean(answer.stale) }
    const legs = []
    let platforms = false
    for (const leg of found.legs) {
      if (leg.kind !== 'ride' || !provider.legDetail) { legs.push(leg); continue }
      const other = await provider.legDetail(leg)
      if (other) platforms = true
      legs.push(mergeLegDetail(leg, other))
    }
    const trip = { ...found, legs }
    return {
      trip,
      position: tripPosition(trip, at),
      updatedAt: answer.at || now().toISOString(),
      stale: Boolean(answer.stale),
      sources: { realtime: answer.provider || 'search.ch', platforms: platforms ? 'transport.opendata.ch' : null, formation: null },
      gone: false,
    }
  }

  return { view, save, board, tripsFor, tripDetail, connections, stops: provider.stops, checkAccount, tick, remove, provider, due, isoZurich }
}
