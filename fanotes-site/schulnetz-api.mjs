// Schulnetz link for one FaNotes account. The refresh token is sealed with
// AES-256-GCM and only the single poller calls token.php. Devices receive the
// normalised snapshot and change list, never the token.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { resolve, sep } from 'node:path'
import { authenticateSyncRequest } from './sync-api.mjs'
import {
  diffSnapshots,
  normalizeSchoolBase,
  parseRawSnapshot,
  redactSecrets,
  schulnetzCallAllowed,
} from './schulnetz-logic.mjs'

const API_PREFIX = '/api/v1/schulnetz'
const MAX_BODY = 64 * 1024
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
const REFERER = 'https://schulnetz.web.app/'
const DEFAULT_SETTINGS = Object.freeze({ grades: true, timetable: true, exams: true, absences: true, events: true })

const readKeyMaterial = () => {
  const inline = process.env.FANOTES_SCHULNETZ_TOKEN_KEY
  if (inline && inline.trim()) return decodeKey(inline.trim())
  return null
}

const decodeKey = (text) => {
  if (/^[a-f0-9]{64}$/iu.test(text)) return Buffer.from(text, 'hex')
  const decoded = Buffer.from(text, 'base64')
  if (decoded.length === 32) return decoded
  return null
}

const loadKeyFile = async (file) => {
  try {
    const text = (await fs.readFile(file, 'utf8')).trim()
    return decodeKey(text)
  } catch {
    return null
  }
}

export const sealToken = (key, plain) => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

export const openToken = (key, sealed) => {
  if (!sealed || sealed.v !== 1 || !key) return ''
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8')
}

const fail = (status, message) => {
  const error = new Error(message)
  error.status = status
  throw error
}

export const createSchulnetzRuntime = (options = {}) => {
  const root = resolve(options.root || process.env.FANOTES_SCHULNETZ_DIR || '/var/lib/fanotes-schulnetz')
  const fetchImpl = options.fetch || globalThis.fetch
  const now = options.now || (() => new Date())
  const log = options.log || ((level, message) => {
    console.log(`${now().toISOString()} schulnetz ${level} ${redactSecrets(message)}`)
  })
  let keyPromise = null
  const key = async () => {
    if (options.key) return options.key
    if (!keyPromise) {
      keyPromise = (async () => {
        const inline = readKeyMaterial()
        if (inline) return inline
        const file = options.keyFile || process.env.FANOTES_SCHULNETZ_TOKEN_KEY_FILE || '/etc/fanotes/schulnetz-token.key'
        return loadKeyFile(file)
      })()
    }
    return keyPromise
  }

  const accountDir = (accountId) => {
    if (!/^[a-f0-9]{32}$/u.test(accountId)) fail(400, 'Ungültiges Konto.')
    const dir = resolve(root, 'accounts', accountId)
    if (dir !== resolve(root, 'accounts', accountId) || !dir.startsWith(`${resolve(root, 'accounts')}${sep}`)) fail(400, 'Ungültiges Konto.')
    return dir
  }

  const readJson = async (file) => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null }
  }

  const writeJson = async (file, value) => {
    await fs.mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
    await fs.rename(temporary, file)
  }

  const readLink = async (accountId) => readJson(resolve(accountDir(accountId), 'link.json'))
  const saveLink = async (accountId, link) => writeJson(resolve(accountDir(accountId), 'link.json'), link)

  const publicStatus = (link) => {
    if (!link) return { linked: false, settings: DEFAULT_SETTINGS }
    const server = (process.env.FANOTES_NTFY_URL || 'https://ntfy.sh').replace(/\/+$/u, '')
    return {
      linked: true,
      baseUrl: link.baseUrl,
      displayName: link.displayName || '',
      needsReauth: link.needsReauth === true,
      lastPollAt: link.lastPollAt || '',
      lastError: link.lastError || '',
      revision: link.revision || 0,
      settings: { ...DEFAULT_SETTINGS, ...(link.settings || {}) },
      push: { topic: link.topic, server, url: `${server}/${link.topic}`, endpoints: (link.pushEndpoints || []).length },
    }
  }

  const requireKey = async () => {
    const material = await key()
    if (!material) fail(503, 'Der Schulnetz-Schlüssel ist auf dem Server noch nicht eingerichtet.')
    return material
  }

  const linkAccount = async (accountId, body) => {
    const material = await requireKey()
    const baseUrl = normalizeSchoolBase(body?.baseUrl)
    if (!baseUrl) fail(400, 'Die Schulnetz-Adresse ist nicht erlaubt.')
    const deviceId = String(body?.deviceId || '')
    if (!/^[a-f0-9]{24}$/u.test(deviceId)) fail(400, 'Die Gerätekennung fehlt.')
    const refreshToken = String(body?.refreshToken || '')
    const accessToken = String(body?.accessToken || '')
    if (refreshToken.length < 20 || refreshToken.length > 4000) fail(400, 'Das Schulnetz-Token ist ungültig.')
    if (accessToken && accessToken.length > 8000) fail(400, 'Das Schulnetz-Token ist ungültig.')
    const existing = await readLink(accountId)
    const expiresIn = Number(body?.expiresIn) || 600
    const record = {
      baseUrl,
      deviceId,
      displayName: String(body?.displayName || existing?.displayName || '').slice(0, 80),
      refresh: sealToken(material, refreshToken),
      access: accessToken ? sealToken(material, accessToken) : null,
      accessExpiresAt: new Date(now().getTime() + Math.max(60, expiresIn - 60) * 1000).toISOString(),
      needsReauth: false,
      lastError: '',
      lastPollAt: existing?.lastPollAt || '',
      topic: existing?.topic || randomBytes(16).toString('hex'),
      pushEndpoints: Array.isArray(existing?.pushEndpoints) ? existing.pushEndpoints.slice(0, 8) : [],
      settings: { ...DEFAULT_SETTINGS, ...(existing?.settings || {}) },
      revision: existing?.revision || 0,
    }
    await saveLink(accountId, record)
    return publicStatus(record)
  }

  const updateSettings = async (accountId, body) => {
    const link = await readLink(accountId)
    if (!link) fail(404, 'Schulnetz ist noch nicht verbunden.')
    const settings = { ...DEFAULT_SETTINGS }
    for (const name of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof body?.[name] === 'boolean') settings[name] = body[name]
      else settings[name] = link.settings?.[name] !== false
    }
    link.settings = settings
    await saveLink(accountId, link)
    return publicStatus(link)
  }

  const addEndpoint = async (accountId, endpoint) => {
    let parsed
    try { parsed = new URL(String(endpoint || '')) } catch { fail(400, 'Der Push-Endpunkt ist ungültig.') }
    if (parsed.protocol !== 'https:') fail(400, 'Push-Endpunkte müssen HTTPS sein.')
    const link = await readLink(accountId)
    if (!link) fail(404, 'Schulnetz ist noch nicht verbunden.')
    const next = [...(link.pushEndpoints || []).filter((item) => item !== parsed.href), parsed.href].slice(-8)
    link.pushEndpoints = next
    await saveLink(accountId, link)
    return publicStatus(link)
  }

  const removeEndpoint = async (accountId, endpoint) => {
    const link = await readLink(accountId)
    if (!link) fail(404, 'Schulnetz ist noch nicht verbunden.')
    link.pushEndpoints = (link.pushEndpoints || []).filter((item) => item !== endpoint)
    await saveLink(accountId, link)
    return publicStatus(link)
  }

  const unlink = async (accountId) => {
    await fs.rm(accountDir(accountId), { recursive: true, force: true })
  }

  const tails = new Map()
  const withAccount = (accountId, task) => {
    const previous = tails.get(accountId) || Promise.resolve()
    const run = previous.then(task, task)
    tails.set(accountId, run.then(() => undefined, () => undefined))
    return run
  }

  const schoolFetch = async (url, method, headers, body) => {
    if (!schulnetzCallAllowed(method, url, body || '')) fail(400, 'Diese Schulnetz-Anfrage ist nicht erlaubt.')
    const response = await fetchImpl(url, { method, headers, body, redirect: 'manual' })
    const responseBody = await response.text()
    return { status: response.status, body: responseBody }
  }

  const refreshTokens = async (baseUrl, refreshToken, deviceId) => {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'ppyybShnMerHdtBQ',
      device_id: deviceId,
    }).toString()
    const response = await schoolFetch(`${baseUrl}/token.php`, 'POST', {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: REFERER,
      'User-Agent': USER_AGENT,
    }, form)
    let json = {}
    try { json = JSON.parse(response.body) } catch { json = {} }
    return {
      accessToken: typeof json.access_token === 'string' ? json.access_token : '',
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : '',
      expiresIn: Number(json.expires_in) || 0,
      error: typeof json.error === 'string' ? json.error : (response.status === 200 ? '' : `http-${response.status}`),
    }
  }

  const readCollection = async (baseUrl, access, path) => {
    const response = await schoolFetch(`${baseUrl}${path}`, 'GET', {
      Accept: path.includes('index.php') ? 'text/html' : 'application/json',
      Authorization: `Bearer ${access}`,
      Referer: REFERER,
      'User-Agent': USER_AGENT,
    })
    if (response.status === 401) return { unauthorized: true, body: '' }
    if (response.status >= 400) return { unauthorized: false, body: '' }
    return { unauthorized: false, body: response.body }
  }

  const deliver = async (link, change) => {
    const server = (process.env.FANOTES_NTFY_URL || 'https://ntfy.sh').replace(/\/+$/u, '')
    const targets = [`${server}/${link.topic}`, ...(link.pushEndpoints || [])]
    const payload = JSON.stringify({ id: change.id, category: change.category, title: change.title, body: change.body })
    for (const target of targets) {
      try {
        const parsed = new URL(target)
        if (parsed.protocol !== 'https:') continue
        const headers = {
          Title: change.title,
          Priority: 'high',
          Tags: change.category,
          'Content-Type': 'text/plain; charset=utf-8',
        }
        if (process.env.FANOTES_NTFY_TOKEN && target.startsWith(server)) headers.Authorization = `Bearer ${process.env.FANOTES_NTFY_TOKEN}`
        await fetchImpl(target, { method: 'POST', headers, body: payload })
      } catch (error) {
        log('warn', `Push an ${new URL(target).host} fehlgeschlagen (${error?.name || 'error'})`)
      }
    }
  }

  const appendChanges = async (accountId, changes, revision) => {
    if (!changes.length) return
    const file = resolve(accountDir(accountId), 'changes.jsonl')
    const lines = changes.map((change) => JSON.stringify({ ...change, revision, at: now().toISOString() }))
    await fs.appendFile(file, `${lines.join('\n')}\n`, { mode: 0o600 })
    const text = await fs.readFile(file, 'utf8')
    const kept = text.trim().split('\n').slice(-200)
    await fs.writeFile(file, `${kept.join('\n')}\n`, { mode: 0o600 })
  }

  const pollAccount = async (accountId) => withAccount(accountId, async () => {
    const material = await key()
    const link = await readLink(accountId)
    if (!material || !link || link.needsReauth) return { skipped: true }
    const baseUrl = normalizeSchoolBase(link.baseUrl)
    if (!baseUrl) return { skipped: true }
    let refreshToken = ''
    try { refreshToken = openToken(material, link.refresh) } catch { refreshToken = '' }
    if (!refreshToken) {
      link.needsReauth = true
      link.lastError = 'token'
      await saveLink(accountId, link)
      return { skipped: true }
    }
    let access = ''
    const expiry = Date.parse(link.accessExpiresAt || '')
    if (link.access && Number.isFinite(expiry) && expiry > now().getTime() + 30_000) {
      try { access = openToken(material, link.access) } catch { access = '' }
    }
    const storeRefresh = async (tokens) => {
      if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
        link.refresh = sealToken(material, tokens.refreshToken)
        refreshToken = tokens.refreshToken
      }
      if (tokens.accessToken) {
        link.access = sealToken(material, tokens.accessToken)
        const seconds = tokens.expiresIn > 0 ? tokens.expiresIn : 600
        link.accessExpiresAt = new Date(now().getTime() + Math.max(60, seconds - 60) * 1000).toISOString()
        access = tokens.accessToken
      }
      await saveLink(accountId, link)
    }
    if (!access) {
      const tokens = await refreshTokens(baseUrl, refreshToken, link.deviceId)
      if (!tokens.accessToken) {
        link.needsReauth = true
        link.lastError = tokens.error === 'biometric_required' ? 'biometric_required' : 'reauth'
        await saveLink(accountId, link)
        await deliver(link, {
          id: `reauth:${link.revision || 0}`,
          category: 'event',
          title: 'Schulnetz erneut anmelden',
          body: 'Die Sitzung ist abgelaufen. In FaNotes Companion unter Mehr → Schulnetz neu verbinden.',
        })
        return { needsReauth: true }
      }
      await storeRefresh(tokens)
    }
    const paths = [
      ['me', '/rest/v1/me'],
      ['grades', '/rest/v1/me/grades'],
      ['events', eventsPath()],
      ['exams', '/rest/v1/me/exams'],
      ['absences', '/rest/v1/me/absences'],
      ['homework', '/rest/v1/me/notes/homework'],
      ['messages', '/rest/v1/me/notifications/push'],
      ['vacations', '/rest/v1/me/vacations'],
      ['lateness', '/rest/v1/me/lateness'],
      ['kontoHtml', '/index.php?pageid=21411'],
      ['startHtml', '/index.php?pageid=1'],
    ]
    const raw = {}
    for (const [name, path] of paths) {
      const response = await readCollection(baseUrl, access, path)
      if (response.unauthorized) {
        const tokens = await refreshTokens(baseUrl, refreshToken, link.deviceId)
        if (!tokens.accessToken) {
          link.needsReauth = true
          link.lastError = 'reauth'
          await saveLink(accountId, link)
          return { needsReauth: true }
        }
        await storeRefresh(tokens)
        const retry = await readCollection(baseUrl, access, path)
        raw[name] = retry.body
      } else {
        raw[name] = response.body
      }
    }
    const previous = await readJson(resolve(accountDir(accountId), 'snapshot.json'))
    const snapshot = parseRawSnapshot(raw, now().toISOString())
    snapshot.revision = (link.revision || 0) + 1
    const changes = diffSnapshots(previous, snapshot, link.settings || DEFAULT_SETTINGS)
    link.revision = snapshot.revision
    link.lastPollAt = snapshot.fetchedAt
    link.lastError = ''
    link.needsReauth = false
    await writeJson(resolve(accountDir(accountId), 'snapshot.json'), snapshot)
    await saveLink(accountId, link)
    await appendChanges(accountId, changes, snapshot.revision)
    for (const change of changes) await deliver(link, change)
    return { revision: snapshot.revision, changes: changes.length }
  })

  const listAccounts = async () => {
    try {
      const entries = await fs.readdir(resolve(root, 'accounts'))
      return entries.filter((name) => /^[a-f0-9]{32}$/u.test(name))
    } catch {
      return []
    }
  }

  let started = false
  let lockHandle = null
  const start = () => {
    if (options.autostart === false || process.env.FANOTES_SCHULNETZ_POLL === '0' || started) return
    started = true
    const interval = Number(process.env.FANOTES_SCHULNETZ_POLL_MS || options.intervalMs || 180_000)
    const loop = async () => {
      const acquired = await acquireLock()
      if (!acquired) {
        log('info', 'Poller übersprungen, eine andere Instanz hält die Sperre.')
        return
      }
      for (;;) {
        try {
          for (const accountId of await listAccounts()) {
            try { await pollAccount(accountId) } catch (error) {
              log('warn', `Konto ${accountId.slice(0, 8)} nicht aktualisiert (${error?.status || error?.name || 'error'})`)
            }
          }
        } catch (error) {
          log('warn', `Poller-Durchlauf fehlgeschlagen (${error?.name || 'error'})`)
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, interval))
      }
    }
    loop().catch((error) => log('warn', `Poller gestoppt (${error?.name || 'error'})`))
  }

  const acquireLock = async () => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    const lockPath = resolve(root, 'poller.lock')
    try {
      lockHandle = await fs.open(lockPath, 'wx', 0o600)
      await lockHandle.writeFile(String(process.pid))
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') return false
      const pid = Number(await fs.readFile(lockPath, 'utf8').catch(() => '0'))
      if (pid && alive(pid)) return false
      await fs.rm(lockPath, { force: true })
      return acquireLock()
    }
  }

  const changesSince = async (accountId, since) => {
    const file = resolve(accountDir(accountId), 'changes.jsonl')
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    const changes = text.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter((change) => change && Number(change.revision) > since)
    return { changes }
  }

  const readBody = async (request) => {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_BODY) fail(413, 'Die Anfrage ist zu gross.')
      chunks.push(chunk)
    }
    if (!chunks.length) return {}
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail(400, 'Ungültiges JSON.') }
  }

  const send = (response, status, value) => {
    const payload = JSON.stringify(value)
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(payload)
  }

  const handle = async (request, response, url) => {
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return false
    const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/u, '') || '/'
    const method = request.method || 'GET'
    try {
      if (method === 'OPTIONS') {
        response.writeHead(204, { 'Cache-Control': 'no-store' })
        response.end()
        return true
      }
      const auth = await authenticateSyncRequest(request)
      const accountId = auth.account.id
      if (route === '/status' && method === 'GET') { send(response, 200, publicStatus(await readLink(accountId))); return true }
      if (route === '/link' && method === 'PUT') { send(response, 200, await linkAccount(accountId, await readBody(request))); return true }
      if (route === '/link' && method === 'DELETE') { await unlink(accountId); send(response, 200, { linked: false }); return true }
      if (route === '/snapshot' && method === 'GET') {
        const snapshot = await readJson(resolve(accountDir(accountId), 'snapshot.json'))
        send(response, 200, snapshot || { revision: 0, grades: [], events: [], exams: [], absences: [], homework: [], messages: [], vacations: [], konto: [], startMessages: [] })
        return true
      }
      if (route === '/changes' && method === 'GET') {
        const since = Number(url.searchParams.get('since') || 0)
        send(response, 200, await changesSince(accountId, Number.isFinite(since) ? since : 0))
        return true
      }
      if (route === '/settings' && method === 'PUT') { send(response, 200, await updateSettings(accountId, await readBody(request))); return true }
      if (route === '/push-endpoint' && method === 'PUT') {
        const body = await readBody(request)
        send(response, 200, await addEndpoint(accountId, body.endpoint))
        return true
      }
      if (route === '/push-endpoint' && method === 'DELETE') {
        const body = await readBody(request)
        send(response, 200, await removeEndpoint(accountId, String(body.endpoint || '')))
        return true
      }
      if (route === '/push/test' && method === 'POST') {
        const link = await readLink(accountId)
        if (!link) fail(404, 'Schulnetz ist noch nicht verbunden.')
        await deliver(link, { id: `test:${now().getTime()}`, category: 'event', title: 'FaNotes Companion', body: 'Testbenachrichtigung von Schulnetz.' })
        send(response, 200, { ok: true })
        return true
      }
      send(response, 404, { error: 'Diesen Schulnetz-Endpunkt gibt es nicht.' })
    } catch (error) {
      const status = Number(error?.status) || 500
      if (status >= 500) log('warn', `Anfrage fehlgeschlagen (${error?.name || 'error'})`)
      send(response, status, { error: error?.publicMessage || error?.message || 'Der Schulnetz-Dienst ist vorübergehend nicht erreichbar.' })
    }
    return true
  }

  return { handle, start, pollAccount, linkAccount, publicStatusOf: async (accountId) => publicStatus(await readLink(accountId)), root, openStoredRefresh: async (accountId) => openToken(await requireKey(), (await readLink(accountId))?.refresh) }
}

const eventsPath = () => {
  const today = new Date()
  const min = new Date(today.getTime() - 7 * 86400000).toISOString().slice(0, 10)
  const max = new Date(today.getTime() + 21 * 86400000).toISOString().slice(0, 10)
  return `/rest/v1/me/events?min_date=${min}&max_date=${max}`
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
