import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

const SCHEMA_VERSION = 1
const MAX_STORE_BYTES = 8 * 1024 * 1024
const MAX_EVENT_BYTES = 2048
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u
const COUNTRY_PATTERN = /^[A-Z]{2}$/u
const METRICS = Object.freeze(['websiteViews', 'webAppOpens', 'desktopAppOpens', 'downloads'])
const PUBLIC_EVENTS = Object.freeze({
  website_view: 'websiteViews',
  web_app_open: 'webAppOpens',
  desktop_app_open: 'desktopAppOpens',
})
const PLATFORMS = new Set(['linux', 'windows'])
const DOWNLOAD_KINDS = new Set(['appimage', 'portable', 'windows-installer', 'windows-portable'])

const emptyCounters = () => ({ websiteViews: 0, webAppOpens: 0, desktopAppOpens: 0, downloads: 0 })
const emptyDay = () => ({
  ...emptyCounters(),
  countries: {},
  downloadsByArtifact: {},
  appOpensByPlatform: {},
  appOpensByVersion: {},
})

const safeCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0
const safeMap = (candidate, keyPattern, maxEntries = 500) => {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {}
  return Object.fromEntries(Object.entries(candidate).slice(0, maxEntries).flatMap(([key, value]) => (
    keyPattern.test(key) ? [[key, safeCount(value)]] : []
  )))
}

const cleanCounters = (candidate) => Object.fromEntries(METRICS.map((metric) => [metric, safeCount(candidate?.[metric])]))

const cleanDay = (candidate) => {
  const counters = cleanCounters(candidate)
  const countries = {}
  if (candidate?.countries && typeof candidate.countries === 'object' && !Array.isArray(candidate.countries)) {
    for (const [country, values] of Object.entries(candidate.countries).slice(0, 300)) {
      if (COUNTRY_PATTERN.test(country)) countries[country] = cleanCounters(values)
    }
  }
  return {
    ...counters,
    countries,
    downloadsByArtifact: safeMap(candidate?.downloadsByArtifact, /^[a-z-]{1,40}$/u, 20),
    appOpensByPlatform: safeMap(candidate?.appOpensByPlatform, /^[a-z]{1,20}$/u, 10),
    appOpensByVersion: safeMap(candidate?.appOpensByVersion, VERSION_PATTERN, 200),
  }
}

const newStore = () => ({
  schemaVersion: SCHEMA_VERSION,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  days: {},
})

const cleanStore = (candidate) => {
  if (candidate?.schemaVersion !== SCHEMA_VERSION || !candidate.days || typeof candidate.days !== 'object' || Array.isArray(candidate.days)) {
    throw new Error('Die Statistikdatei besitzt ein unbekanntes Format.')
  }
  const days = {}
  for (const [date, values] of Object.entries(candidate.days).slice(-4000)) {
    if (DATE_PATTERN.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00.000Z`))) days[date] = cleanDay(values)
  }
  const createdAt = Number.isFinite(Date.parse(candidate.createdAt)) ? new Date(candidate.createdAt).toISOString() : new Date().toISOString()
  return { schemaVersion: SCHEMA_VERSION, createdAt, updatedAt: new Date().toISOString(), days }
}

const utcDate = (date = new Date()) => date.toISOString().slice(0, 10)

const dateDaysAgo = (days) => {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() - days)
  return utcDate(date)
}

const countryForRequest = (request) => {
  const raw = String(request.headers['cf-ipcountry'] || '').trim().toUpperCase()
  return COUNTRY_PATTERN.test(raw) && raw !== 'XX' ? raw : 'ZZ'
}

const clientAddressForRateLimit = (request) => String(request.headers['x-real-ip'] || request.socket?.remoteAddress || 'unknown').slice(0, 200)

const readJsonBody = async (request) => {
  const advertised = Number(request.headers['content-length'])
  if (Number.isFinite(advertised) && advertised > MAX_EVENT_BYTES) {
    const error = new Error('Das Statistikereignis ist zu groß.')
    error.statusCode = 413
    throw error
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_EVENT_BYTES) {
      const error = new Error('Das Statistikereignis ist zu groß.')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('Das Statistikereignis ist kein gültiges JSON.')
    error.statusCode = 400
    throw error
  }
}

const addCounters = (target, source) => {
  for (const metric of METRICS) target[metric] += safeCount(source?.[metric])
  return target
}

const addMap = (target, source) => {
  for (const [key, value] of Object.entries(source || {})) target[key] = (target[key] || 0) + safeCount(value)
  return target
}

export const createAnalyticsService = async ({ directory }) => {
  const storageDirectory = resolve(directory)
  const storagePath = join(storageDirectory, 'aggregates.json')
  await fs.mkdir(storageDirectory, { recursive: true, mode: 0o700 })

  let store
  try {
    const stats = await fs.lstat(storagePath)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_STORE_BYTES) throw new Error('Die Statistikdatei ist unsicher oder zu groß.')
    store = cleanStore(JSON.parse(await fs.readFile(storagePath, 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    store = newStore()
  }

  let writeQueue = Promise.resolve()
  const rateSecret = randomBytes(32)
  const rateBuckets = new Map()

  const allowedByRateLimit = (request, type) => {
    const now = Date.now()
    const key = createHash('sha256').update(rateSecret).update(clientAddressForRateLimit(request)).update(type).digest('hex').slice(0, 24)
    const previous = rateBuckets.get(key)
    const bucket = !previous || previous.expiresAt <= now ? { count: 0, expiresAt: now + 10 * 60_000 } : previous
    bucket.count += 1
    rateBuckets.set(key, bucket)
    if (rateBuckets.size > 10_000) {
      for (const [candidate, value] of rateBuckets) if (value.expiresAt <= now) rateBuckets.delete(candidate)
    }
    return bucket.count <= 30
  }

  const persist = () => {
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      store.updatedAt = new Date().toISOString()
      const body = `${JSON.stringify(store)}\n`
      if (Buffer.byteLength(body, 'utf8') > MAX_STORE_BYTES) throw new Error('Die aggregierte Statistikdatei überschreitet das sichere Größenlimit.')
      const temporary = join(storageDirectory, `.aggregates-${process.pid}-${Date.now()}.tmp`)
      await fs.writeFile(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await fs.rename(temporary, storagePath)
    })
    return writeQueue
  }

  const record = async ({ metric, country, platform = null, version = null, artifact = null }) => {
    const date = utcDate()
    const day = store.days[date] ||= emptyDay()
    day[metric] += 1
    const countryCounters = day.countries[country] ||= emptyCounters()
    countryCounters[metric] += 1
    if (metric === 'downloads' && artifact) day.downloadsByArtifact[artifact] = (day.downloadsByArtifact[artifact] || 0) + 1
    if (metric === 'desktopAppOpens') {
      if (platform) day.appOpensByPlatform[platform] = (day.appOpensByPlatform[platform] || 0) + 1
      if (version) day.appOpensByVersion[version] = (day.appOpensByVersion[version] || 0) + 1
    }
    await persist()
  }

  const recordPublicEvent = async (request) => {
    const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      const error = new Error('Statistikereignisse müssen JSON verwenden.')
      error.statusCode = 415
      throw error
    }
    const origin = String(request.headers.origin || '')
    if (origin && origin !== 'https://fanotes.fasrv.ch') {
      const error = new Error('Diese Herkunft darf keine Statistikereignisse senden.')
      error.statusCode = 403
      throw error
    }
    const body = await readJsonBody(request)
    const metric = PUBLIC_EVENTS[body?.type]
    if (!metric) {
      const error = new Error('Unbekanntes Statistikereignis.')
      error.statusCode = 400
      throw error
    }
    if (!allowedByRateLimit(request, body.type)) return false
    const platform = metric === 'desktopAppOpens' && PLATFORMS.has(body.platform) ? body.platform : null
    const version = metric === 'desktopAppOpens' && VERSION_PATTERN.test(body.version || '') ? body.version : null
    if (metric === 'desktopAppOpens' && (!platform || !version)) {
      const error = new Error('Die anonymen App-Startdaten sind ungültig.')
      error.statusCode = 400
      throw error
    }
    await record({ metric, country: countryForRequest(request), platform, version })
    return true
  }

  const recordDownload = async (request, { artifact, version }) => {
    if (request.method !== 'GET' || !DOWNLOAD_KINDS.has(artifact) || !VERSION_PATTERN.test(version || '')) return false
    if (!allowedByRateLimit(request, `download:${artifact}`)) return false
    await record({ metric: 'downloads', country: countryForRequest(request), artifact, version })
    return true
  }

  const summary = async () => {
    await writeQueue.catch(() => {})
    const totals = emptyCounters()
    const last7Days = emptyCounters()
    const last30Days = emptyCounters()
    const countries = {}
    const downloadsByArtifact = {}
    const appOpensByPlatform = {}
    const appOpensByVersion = {}
    const series = []
    const sevenDayStart = dateDaysAgo(6)
    const thirtyDayStart = dateDaysAgo(29)
    const ninetyDayStart = dateDaysAgo(89)

    for (const [date, day] of Object.entries(store.days).sort(([left], [right]) => left.localeCompare(right))) {
      addCounters(totals, day)
      if (date >= sevenDayStart) addCounters(last7Days, day)
      if (date >= thirtyDayStart) addCounters(last30Days, day)
      if (date >= ninetyDayStart) series.push({ date, ...cleanCounters(day) })
      for (const [country, values] of Object.entries(day.countries)) addCounters(countries[country] ||= emptyCounters(), values)
      addMap(downloadsByArtifact, day.downloadsByArtifact)
      addMap(appOpensByPlatform, day.appOpensByPlatform)
      addMap(appOpensByVersion, day.appOpensByVersion)
    }

    const countryRows = Object.entries(countries).map(([country, values]) => ({ country, ...values }))
      .sort((left, right) => (right.websiteViews + right.downloads + right.desktopAppOpens + right.webAppOpens) - (left.websiteViews + left.downloads + left.desktopAppOpens + left.webAppOpens))
    return {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      collectingSince: store.createdAt,
      totals,
      today: cleanCounters(store.days[utcDate()] || emptyDay()),
      last7Days,
      last30Days,
      series,
      countries: countryRows,
      downloadsByArtifact,
      appOpensByPlatform,
      appOpensByVersion,
      privacy: {
        storesIpAddresses: false,
        storesDeviceIdentifiers: false,
        storesRawEvents: false,
        aggregation: 'daily',
      },
    }
  }

  return { recordPublicEvent, recordDownload, summary }
}
