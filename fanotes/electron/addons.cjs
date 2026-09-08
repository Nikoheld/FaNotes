'use strict'

// Main-process backend for the add-on store.
//
// Two jobs: (1) download registry files from GitHub – the renderer's CSP only
// permits same-origin/fasrv connections, and we only ever want GitHub hosts
// for add-ons anyway – and (2) keep installed add-ons in
// <userData>/addons/<id>/ with an addons.json manifest list. Nothing here
// touches the vault; a broken add-on file can never corrupt a note.

const fsp = require('node:fs/promises')
const https = require('node:https')
const path = require('node:path')

const ALLOWED_HOSTS = new Set(['raw.githubusercontent.com', 'api.github.com', 'github.com', 'objects.githubusercontent.com'])
const MAX_FETCH_BYTES = 2_000_000
const FETCH_TIMEOUT_MS = 20_000
const MAX_REDIRECTS = 3
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u
const FILE_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/u
const MAX_FILE_BYTES = 2_000_000
const MAX_DATA_BYTES = 1_100_000
const MAX_RECORDS = 500

const assertAllowedUrl = (rawUrl) => {
  let parsed
  try {
    parsed = new URL(String(rawUrl))
  } catch {
    throw new Error('Ungültige Add-on-Adresse.')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Diese Adresse ist für Add-ons nicht erlaubt: ${parsed.hostname || rawUrl}`)
  }
  return parsed
}

const requestOnce = (url, redirectsLeft) => new Promise((resolve, reject) => {
  const request = https.get(url, {
    headers: {
      'User-Agent': 'FaNotes-AddonStore',
      Accept: 'application/vnd.github.raw+json, text/plain, application/json;q=0.9, */*;q=0.1',
    },
    timeout: FETCH_TIMEOUT_MS,
  }, (response) => {
    const status = response.statusCode ?? 0
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume()
      if (redirectsLeft <= 0) {
        reject(new Error('Zu viele Weiterleitungen.'))
        return
      }
      try {
        const next = assertAllowedUrl(new URL(response.headers.location, url).toString())
        resolve(requestOnce(next, redirectsLeft - 1))
      } catch (error) {
        reject(error)
      }
      return
    }
    if (status < 200 || status >= 300) {
      response.resume()
      reject(new Error(status === 404 ? `Nicht gefunden (404): ${url.pathname}` : `HTTP ${status} beim Laden von ${url.hostname}${url.pathname}`))
      return
    }
    const chunks = []
    let total = 0
    response.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_FETCH_BYTES) {
        request.destroy(new Error('Die Datei ist größer als 2 MB.'))
        return
      }
      chunks.push(chunk)
    })
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    response.on('error', reject)
  })
  request.on('timeout', () => request.destroy(new Error('Zeitüberschreitung beim Laden.')))
  request.on('error', reject)
})

const fetchAddonText = async (rawUrl) => requestOnce(assertAllowedUrl(rawUrl), MAX_REDIRECTS)

const NET_MAX_BYTES = 5_000_000
const NET_TIMEOUT_MS = 20_000
const NET_ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
const NET_RESPONSE_HEADERS = ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified', 'x-ratelimit-remaining', 'retry-after', 'location']

const isPrivateHost = (hostname) => {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) {
    const [a, b] = host.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || a >= 224
  }
  return host.includes(':')
}

/**
 * Outbound request on behalf of an add-on with the "network" permission. The
 * renderer already checked the host against the manifest; this side enforces
 * https, blocks private ranges, caps size/time and never forwards cookies.
 */
const fetchForAddon = (rawUrl, rawInit, redirectsLeft = MAX_REDIRECTS) => new Promise((resolve, reject) => {
  let url
  try {
    url = new URL(String(rawUrl))
  } catch {
    reject(new Error('Ungültige URL.'))
    return
  }
  if (url.protocol !== 'https:' || url.username || url.password || isPrivateHost(url.hostname)) {
    reject(new Error('Add-ons dürfen nur öffentliche https-Adressen aufrufen.'))
    return
  }
  const init = rawInit && typeof rawInit === 'object' ? rawInit : {}
  const method = NET_ALLOWED_METHODS.has(String(init.method || 'GET').toUpperCase()) ? String(init.method || 'GET').toUpperCase() : 'GET'
  const headers = { 'User-Agent': 'FaNotes-Addon', Accept: '*/*' }
  if (init.headers && typeof init.headers === 'object') {
    for (const [key, value] of Object.entries(init.headers).slice(0, 20)) {
      if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,64}$/u.test(key)) continue
      if (/^(cookie|host|origin|referer|content-length|transfer-encoding|connection)$/iu.test(key)) continue
      headers[key] = value.slice(0, 2000)
    }
  }
  const body = typeof init.body === 'string' && method !== 'GET' && method !== 'HEAD' ? init.body : undefined
  if (body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(body, 'utf8'))
  const request = https.request(url, { method, headers, timeout: NET_TIMEOUT_MS }, (response) => {
    const status = response.statusCode ?? 0
    if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0 && (method === 'GET' || method === 'HEAD')) {
      response.resume()
      let next
      try {
        next = new URL(response.headers.location, url).toString()
      } catch {
        reject(new Error('Ungültige Weiterleitung.'))
        return
      }
      resolve(fetchForAddon(next, init, redirectsLeft - 1))
      return
    }
    const chunks = []
    let total = 0
    response.on('data', (chunk) => {
      total += chunk.length
      if (total > NET_MAX_BYTES) {
        request.destroy(new Error('Die Antwort ist größer als 5 MB.'))
        return
      }
      chunks.push(chunk)
    })
    response.on('end', () => {
      const picked = {}
      for (const name of NET_RESPONSE_HEADERS) {
        const value = response.headers[name]
        if (typeof value === 'string') picked[name] = value.slice(0, 2000)
      }
      resolve({ status, statusText: response.statusMessage || '', headers: picked, body: Buffer.concat(chunks).toString('utf8'), url: url.toString() })
    })
    response.on('error', reject)
  })
  request.on('timeout', () => request.destroy(new Error('Zeitüberschreitung bei der Anfrage.')))
  request.on('error', reject)
  if (body !== undefined) request.write(body)
  request.end()
})

const createAddonStore = (rootDir) => {
  const recordsFile = path.join(rootDir, 'addons.json')
  let queue = Promise.resolve()
  const serial = (task) => {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
  }

  const ensureRoot = () => fsp.mkdir(rootDir, { recursive: true })

  const safeId = (id) => {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Ungültige Add-on-ID.')
    return id
  }

  const safeFile = (name) => {
    if (typeof name !== 'string' || !FILE_PATTERN.test(name) || name.includes('..')) throw new Error('Ungültiger Dateiname.')
    return name
  }

  const addonDir = (id) => path.join(rootDir, safeId(id))

  const writeAtomic = async (target, content) => {
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`
    await fsp.writeFile(temp, content, 'utf8')
    await fsp.rename(temp, target)
  }

  const readRecords = async () => {
    try {
      const parsed = JSON.parse(await fsp.readFile(recordsFile, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      console.warn('addons.json ist beschädigt und wird neu angelegt:', error?.message ?? error)
      return []
    }
  }

  const writeRecords = async (records) => {
    await ensureRoot()
    await writeAtomic(recordsFile, JSON.stringify(records.slice(0, MAX_RECORDS), null, 2))
  }

  return {
    list: () => serial(readRecords),
    save: (record) => serial(async () => {
      if (!record || typeof record !== 'object' || typeof record.id !== 'string') throw new Error('Ungültiger Add-on-Eintrag.')
      safeId(record.id)
      const records = (await readRecords()).filter((item) => !item || item.id !== record.id)
      records.push(JSON.parse(JSON.stringify(record)))
      await writeRecords(records)
    }),
    remove: (id) => serial(async () => {
      const dir = addonDir(id)
      const records = (await readRecords()).filter((item) => !item || item.id !== id)
      await writeRecords(records)
      await fsp.rm(dir, { recursive: true, force: true })
      await fsp.rm(path.join(rootDir, `${id}.data.json`), { force: true })
    }),
    readFile: async (id, name) => {
      const target = path.join(addonDir(id), safeFile(name))
      try {
        return await fsp.readFile(target, 'utf8')
      } catch (error) {
        if (error && error.code === 'ENOENT') return null
        throw error
      }
    },
    writeFiles: (id, files) => serial(async () => {
      const dir = addonDir(id)
      if (!files || typeof files !== 'object') throw new Error('Keine Dateien übergeben.')
      await fsp.mkdir(dir, { recursive: true })
      for (const [name, content] of Object.entries(files)) {
        if (typeof content !== 'string') continue
        if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`${name} ist größer als 2 MB.`)
        await writeAtomic(path.join(dir, safeFile(name)), content)
      }
    }),
    readData: async (id) => {
      try {
        return await fsp.readFile(path.join(rootDir, `${safeId(id)}.data.json`), 'utf8')
      } catch (error) {
        if (error && error.code === 'ENOENT') return null
        throw error
      }
    },
    writeData: (id, value) => serial(async () => {
      if (typeof value !== 'string') throw new Error('Add-on-Daten müssen ein String sein.')
      if (Buffer.byteLength(value, 'utf8') > MAX_DATA_BYTES) throw new Error('Der Add-on-Speicher ist auf 1 MB begrenzt.')
      await ensureRoot()
      await writeAtomic(path.join(rootDir, `${safeId(id)}.data.json`), value)
    }),
  }
}

const ADDON_IPC = Object.freeze({
  fetch: 'fanotes:addons-fetch',
  list: 'fanotes:addons-list',
  save: 'fanotes:addons-save',
  remove: 'fanotes:addons-remove',
  readFile: 'fanotes:addons-read-file',
  writeFiles: 'fanotes:addons-write-files',
  readData: 'fanotes:addons-read-data',
  writeData: 'fanotes:addons-write-data',
  netFetch: 'fanotes:addons-net-fetch',
})

/** Registers the add-on IPC surface; `handle` is main.cjs' trusted-sender wrapper. */
const registerAddonIpc = (handle, store) => {
  handle(ADDON_IPC.fetch, (_event, url) => fetchAddonText(url))
  handle(ADDON_IPC.list, () => store.list())
  handle(ADDON_IPC.save, (_event, record) => store.save(record))
  handle(ADDON_IPC.remove, (_event, id) => store.remove(id))
  handle(ADDON_IPC.readFile, (_event, id, name) => store.readFile(id, name))
  handle(ADDON_IPC.writeFiles, (_event, id, files) => store.writeFiles(id, files))
  handle(ADDON_IPC.readData, (_event, id) => store.readData(id))
  handle(ADDON_IPC.writeData, (_event, id, value) => store.writeData(id, value))
  handle(ADDON_IPC.netFetch, (_event, url, init) => fetchForAddon(url, init))
}

module.exports = { ADDON_IPC, ALLOWED_HOSTS, assertAllowedUrl, createAddonStore, fetchAddonText, fetchForAddon, isPrivateHost, registerAddonIpc }
