// Today's Mensa menu (Mensa Alte Kanti, run by Compass Group) for the Kanti+ start page.
// The public page is an Angular app that is server-rendered for the current day only: the day tabs
// Mo..So exist, but only the active tab ("Heute") carries a date and its menus. We parse whatever
// dated day panels are present, merge them into the last good result and serve that from a cache.
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

export const MENSA_HOST = 'clients.compass-group.ch'
export const MENSA_URL = `https://${MENSA_HOST}/altekanti/de/Mensa%20Alte%20Kanti`
export const MENSA_USER_AGENT = 'Kanti+ menu reader (fasrv.ch)'
export const MENSA_PATHS = ['/api/v1/schulnetz/mensa', '/api/v1/kanti-web/mensa']

const TIME_ZONE = 'Europe/Zurich'
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
const FETCH_TIMEOUT_MS = 15_000
const MAX_HTML_BYTES = 2 * 1024 * 1024
const HOUR_MS = 3_600_000
const RETRY_AFTER_FAILURE_MS = 10 * 60_000
const KEEP_DAYS_MS = 7 * 24 * HOUR_MS

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', agrave: 'à' }
const decode = (value) => value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, name) => {
  if (name[0] === '#') {
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' '
  }
  return ENTITIES[name] ?? whole
})
const text = (html) => decode(String(html || '').replace(/<!--.*?-->/gsu, '').replace(/<[^>]*>/gu, ' ')).replace(/\s+/gu, ' ').trim()
const price = (value) => {
  const match = /(\d+(?:[.,]\d{1,2})?)/u.exec(String(value || ''))
  if (!match) return null
  const number = Number(match[1].replace(',', '.'))
  return Number.isFinite(number) ? number : null
}

const pad = (number) => String(number).padStart(2, '0')
const isoDate = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`
const weekdayOf = (date) => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]

/** Date and time parts of an instant in Europe/Zurich. */
export const zurichParts = (instant) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(instant).map((part) => [part.type, part.value]))
  const date = `${parts.year}-${parts.month}-${parts.day}`
  return { date, hour: Number(parts.hour), minute: Number(parts.minute), weekday: WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()] }
}

const parseMenu = (item) => {
  const name = text((/<h3[^>]*>(.*?)<\/h3>/isu.exec(item) || [])[1])
  if (!name) return null
  const afterName = item.slice(item.search(/<\/h3>/iu) + 5)
  const description = text((/<p[^>]*>(.*?)<\/p>/isu.exec(afterName.split(/class="[^"]*price-wrapper/u)[0]) || [])[1])
  const label = text((/<li[^>]*class="[^"]*menuline[^"]*"[^>]*>(.*?)<\/li>/isu.exec(item) || [])[1])
  const main = /<p[^>]*class="[^"]*\bmain\b[^"]*"[^>]*>(.*?)<\/p>/isu.exec(item)
  const small = /<p[^>]*class="[^"]*\bsmall\b[^"]*"[^>]*>(.*?)<\/p>/isu.exec(item)
  return { name, description, label, price: price(text(main?.[1])), studentPrice: price(text(small?.[1])) }
}

/** Parses the menu page. Never throws; unusable input gives { days: [] }. */
export const parseMensaHtml = (html) => {
  try {
    const source = String(html || '')
    const bodies = source.split(/<mat-tab-body\b/iu).slice(1)
    const days = []
    for (const body of bodies) {
      const dateMatch = /<div[^>]*class="[^"]*\bdate\b[^"]*"[^>]*>\s*<p[^>]*>\s*(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})\s*<\/p>/iu.exec(body)
      if (!dateMatch) continue // a tab that is not rendered (no date) says nothing about its day
      const year = dateMatch[3].length === 2 ? 2000 + Number(dateMatch[3]) : Number(dateMatch[3])
      const month = Number(dateMatch[2])
      const dayOfMonth = Number(dateMatch[1])
      if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) continue
      const date = isoDate(year, month, dayOfMonth)
      const weekday = weekdayOf(date)
      if (!weekday || Number.isNaN(Date.parse(`${date}T12:00:00Z`)) || weekday === 'Sa' || weekday === 'So') continue
      const rest = body.slice(dateMatch.index + dateMatch[0].length)
      const items = rest.split(/<div[^>]*class="[^"]*\blist-item\b[^"]*"[^>]*>/iu).slice(1)
      const menus = items.map(parseMenu).filter(Boolean)
      const note = menus.length ? '' : text(rest.replace(/<\/mat-tab-body>[\s\S]*$/iu, '')).slice(0, 200)
      days.push({ date, weekday, closed: menus.length === 0, note, menus })
    }
    return { days }
  } catch {
    return { days: [] }
  }
}

const addDays = (date, count) => {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + count)
  return value.toISOString().slice(0, 10)
}

/** Today's day; after 14:00 Zurich or on a weekend the next school day's. null when not known. */
export const pickMensaDay = (days, now = new Date()) => {
  const list = Array.isArray(days) ? days : []
  const local = zurichParts(now)
  let target = local.date
  if (local.weekday === 'Sa' || local.weekday === 'So' || local.hour >= 14) {
    do { target = addDays(target, 1) } while (['Sa', 'So'].includes(weekdayOf(target)))
  }
  return list.find((day) => day?.date === target) || null
}

const needsRefresh = (fetchedAtMs, nowDate) => {
  if (!fetchedAtMs) return true
  const local = zurichParts(nowDate)
  const schoolHours = local.weekday !== 'Sa' && local.weekday !== 'So' && local.hour >= 6 && local.hour < 15
  return nowDate.getTime() - fetchedAtMs > (schoolHours ? 3 : 12) * HOUR_MS
}

export const createMensa = (options = {}) => {
  const fetchImpl = options.fetch || globalThis.fetch
  const now = options.now || (() => new Date())
  const root = resolve(options.root || process.env.FANOTES_SCHULNETZ_DIR || '/var/lib/fanotes-schulnetz')
  const log = options.log || ((level, message) => console.log(`${now().toISOString()} mensa ${level} ${message}`))
  const file = join(root, 'mensa.json')
  let cache = null // { fetchedAt, days }
  let loaded = false
  let lastFailureAt = 0
  let lastFailed = false
  let inflight = null

  const load = async () => {
    if (loaded) return
    loaded = true
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'))
      if (value && Array.isArray(value.days) && typeof value.fetchedAt === 'string') cache = { fetchedAt: value.fetchedAt, days: value.days }
    } catch { /* no cache yet */ }
  }

  const save = async () => {
    try {
      await fs.mkdir(root, { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      await fs.writeFile(temporary, JSON.stringify(cache), { mode: 0o640 })
      await fs.rename(temporary, file)
    } catch (error) {
      log('warn', `cache not saved: ${error?.code || 'error'}`)
    }
  }

  const download = async () => {
    const url = new URL(MENSA_URL)
    if (url.hostname !== MENSA_HOST) throw new Error('unexpected host')
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'User-Agent': MENSA_USER_AGENT, Accept: 'text/html' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.text()
    if (body.length > MAX_HTML_BYTES) throw new Error('page too large')
    return body
  }

  const refresh = () => {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const parsed = parseMensaHtml(await download())
        if (!parsed.days.length) throw new Error('no menu days found')
        const instant = now()
        const keepFrom = zurichParts(new Date(instant.getTime() - KEEP_DAYS_MS)).date
        const merged = new Map()
        for (const day of cache?.days || []) if (day?.date >= keepFrom) merged.set(day.date, day)
        for (const day of parsed.days) merged.set(day.date, day)
        cache = { fetchedAt: instant.toISOString(), days: [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)) }
        lastFailed = false
        await save()
      } catch (error) {
        lastFailed = true
        lastFailureAt = now().getTime()
        log('warn', `refresh failed: ${String(error?.message || error).slice(0, 120)}`)
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  const body = () => {
    const instant = now()
    const days = cache?.days || []
    const stale = !cache || lastFailed || needsRefresh(Date.parse(cache.fetchedAt), instant)
    return { fetchedAt: cache?.fetchedAt || null, stale, day: pickMensaDay(days, instant), days }
  }

  /** Reads the cache; starts at most one background refresh when it is due. Waits only when nothing is cached. */
  const get = async () => {
    await load()
    const instant = now()
    const due = needsRefresh(cache ? Date.parse(cache.fetchedAt) : 0, instant)
      && !(lastFailed && instant.getTime() - lastFailureAt < RETRY_AFTER_FAILURE_MS)
    if (due) {
      const running = refresh()
      if (!cache) await running
    }
    return body()
  }

  const send = (response, status, value, headers = {}) => {
    const payload = JSON.stringify(value)
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    })
    response.end(payload)
  }

  const handle = async (request, response, url) => {
    if (!MENSA_PATHS.includes(url.pathname.replace(/\/+$/u, ''))) return false
    if (request.method !== 'GET') {
      send(response, 405, { error: 'Nur GET ist erlaubt.' }, { Allow: 'GET' })
      return true
    }
    send(response, 200, await get())
    return true
  }

  return { get, handle, idle: async () => { if (inflight) await inflight } }
}
