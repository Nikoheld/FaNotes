'use strict'

// Transports and configuration of the local MCP server:
//  - stdio (newline-delimited JSON-RPC), for `fanotes-mcp` / `FaNotes --mcp`;
//  - Streamable HTTP on 127.0.0.1 with a bearer token (POST /mcp, JSON replies).
// Nothing here logs request or note contents.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { rpcError } = require('./local-mcp.cjs')
const { normalizeExcluded } = require('./local-mcp-vault.cjs')

const MAX_BODY_BYTES = 1024 * 1024
const MAX_LINE_CHARS = 1024 * 1024
const TOKEN_FILE = 'mcp-local.json'
const DEFAULT_PORT_RANGE = [49200, 49900]

// ── configuration ───────────────────────────────────────────────────────────

const defaultUserDataDir = () => {
  if (process.env.FANOTES_USER_DATA) return path.resolve(process.env.FANOTES_USER_DATA)
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'FaNotes')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'FaNotes')
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'FaNotes')
}

/** Reads only the few keys the MCP server needs from the app's config.json (never the protected secrets). */
const contextFromConfigFile = (userData) => {
  let parsed = null
  try {
    const file = path.join(userData, 'config.json')
    if (fs.statSync(file).size <= 2 * 1024 * 1024) parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    parsed = null
  }
  const settings = parsed && typeof parsed.settings === 'object' && parsed.settings ? parsed.settings : {}
  const vaultPath = typeof parsed?.vaultPath === 'string' && path.isAbsolute(parsed.vaultPath) ? path.resolve(parsed.vaultPath) : ''
  return {
    enabled: settings.mcpEnabled === true && Boolean(vaultPath),
    writeAccess: settings.mcpWriteAccess === true,
    vaultPath,
    excludedFolders: normalizeExcluded(typeof settings.mcpExcludedFolders === 'string' ? settings.mcpExcludedFolders : ''),
    httpEnabled: settings.mcpHttpEnabled === true,
  }
}

// ── HTTP token store ────────────────────────────────────────────────────────

const newToken = () => `fnmcp_${crypto.randomBytes(24).toString('base64url')}`

const loadTokenStore = (userData) => {
  const file = path.join(userData, TOKEN_FILE)
  let store = null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof parsed.token === 'string' && /^fnmcp_[A-Za-z0-9_-]{32,}$/u.test(parsed.token)
      && Number.isInteger(parsed.port) && parsed.port > 1023 && parsed.port < 65536) store = { token: parsed.token, port: parsed.port }
  } catch {
    store = null
  }
  if (!store) {
    const [low, high] = DEFAULT_PORT_RANGE
    store = { token: newToken(), port: low + crypto.randomInt(high - low) }
    saveTokenStore(userData, store)
  }
  return store
}

const saveTokenStore = (userData, store) => {
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 })
  const file = path.join(userData, TOKEN_FILE)
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(store)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
}

const regenerateToken = (userData) => {
  const store = { ...loadTokenStore(userData), token: newToken() }
  saveTokenStore(userData, store)
  return store
}

// ── stdio ───────────────────────────────────────────────────────────────────

const runStdio = ({ server, input = process.stdin, output = process.stdout }) => new Promise((resolve) => {
  let buffer = ''
  let pending = 0
  let ended = false
  const finish = () => { if (ended && pending === 0) resolve() }
  const send = (value) => { output.write(`${JSON.stringify(value)}\n`) }
  const process_ = async (line) => {
    pending += 1
    try {
      let payload
      try {
        payload = JSON.parse(line)
      } catch {
        send(rpcError(null, -32700, 'Parse error.'))
        return
      }
      const reply = await server.handle(payload)
      if (reply) send(reply)
    } catch {
      send(rpcError(null, -32603, 'Internal error.'))
    } finally {
      pending -= 1
      finish()
    }
  }
  input.setEncoding('utf8')
  let discarding = false
  input.on('data', (chunk) => {
    buffer += chunk
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (discarding) { discarding = false; continue } // tail of an oversized line
      if (line.length > MAX_LINE_CHARS) send(rpcError(null, -32600, 'Message too large.'))
      else if (line) void process_(line)
    }
    if (buffer.length > MAX_LINE_CHARS) {
      // An oversized line without its newline yet: drop it and everything up to the next newline.
      buffer = ''
      if (!discarding) send(rpcError(null, -32600, 'Message too large.'))
      discarding = true
    }
  })
  input.on('end', () => {
    const rest = buffer.trim()
    buffer = ''
    if (rest) void process_(rest)
    ended = true
    finish()
  })
})

// ── Streamable HTTP ─────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

const hostnameOf = (hostHeader) => {
  const match = /^(\[[0-9a-f:]+\]|[^:]+)(?::(\d{1,5}))?$/iu.exec(String(hostHeader ?? ''))
  return match ? { name: match[1].toLowerCase(), port: match[2] ? Number(match[2]) : null } : null
}

const sameSecret = (left, right) => {
  const a = crypto.createHash('sha256').update(String(left)).digest()
  const b = crypto.createHash('sha256').update(String(right)).digest()
  return crypto.timingSafeEqual(a, b)
}

const createHttpTransport = ({ server, getToken, port = 0, requestTimeoutMs = 30_000 }) => {
  const failures = []
  let httpServer = null

  const reply = (response, status, body, headers = {}) => {
    const data = body === undefined ? '' : JSON.stringify(body)
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    })
    response.end(data)
  }

  const tooManyFailures = () => {
    const cutoff = Date.now() - 60_000
    while (failures.length && failures[0] < cutoff) failures.shift()
    return failures.length >= 20
  }

  const onRequest = (request, response) => {
    const boundPort = httpServer.address()?.port
    // DNS rebinding: the Host must be a loopback name on our port; a browser Origin, if sent, must be loopback too.
    const host = hostnameOf(request.headers.host)
    if (!host || !LOOPBACK_HOSTS.has(host.name) || (host.port !== null && host.port !== boundPort)) {
      reply(response, 403, { error: 'Forbidden host.' })
      return
    }
    const origin = request.headers.origin
    if (origin !== undefined) {
      let originHost = null
      try { originHost = new URL(origin) } catch { originHost = null }
      if (!originHost || !['http:', 'https:'].includes(originHost.protocol) || !LOOPBACK_HOSTS.has(originHost.hostname.toLowerCase())) {
        reply(response, 403, { error: 'Forbidden origin.' })
        return
      }
    }
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${boundPort}`)
    if (url.pathname !== '/mcp') { reply(response, 404, { error: 'Not found.' }); return }
    const header = String(request.headers.authorization ?? '')
    const supplied = /^Bearer (\S+)$/u.exec(header)?.[1]
    if (!supplied || !sameSecret(supplied, getToken())) {
      // Only failed attempts are throttled; a valid token is never locked out by someone else's guesses.
      if (tooManyFailures()) { reply(response, 429, { error: 'Too many failed attempts.' }, { 'Retry-After': '60' }); return }
      failures.push(Date.now())
      reply(response, 401, { error: 'Missing or wrong bearer token.' }, { 'WWW-Authenticate': 'Bearer realm="fanotes"' })
      return
    }
    if (request.method === 'GET' || request.method === 'DELETE') { reply(response, 405, { error: 'Use POST.' }, { Allow: 'POST' }); return }
    if (request.method !== 'POST') { reply(response, 405, { error: 'Use POST.' }, { Allow: 'POST' }); return }
    if (!/^application\/json\b/iu.test(String(request.headers['content-type'] ?? ''))) { reply(response, 415, { error: 'Content-Type must be application/json.' }); return }
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) { reply(response, 413, { error: 'Body too large.' }); return }

    const chunks = []
    let size = 0
    let aborted = false
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES && !aborted) {
        aborted = true
        reply(response, 413, { error: 'Body too large.' })
        request.destroy()
        return
      }
      if (!aborted) chunks.push(chunk)
    })
    request.on('end', async () => {
      if (aborted) return
      let payload
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        reply(response, 400, rpcError(null, -32700, 'Parse error.'))
        return
      }
      try {
        const result = await server.handle(payload)
        if (result === null) { response.writeHead(202, { 'Cache-Control': 'no-store' }); response.end(); return }
        reply(response, 200, result)
      } catch {
        reply(response, 500, rpcError(null, -32603, 'Internal error.'))
      }
    })
  }

  return {
    listen: () => new Promise((resolve, reject) => {
      httpServer = http.createServer(onRequest)
      httpServer.requestTimeout = requestTimeoutMs
      httpServer.headersTimeout = 10_000
      httpServer.keepAliveTimeout = 5_000
      httpServer.maxHeadersCount = 40
      httpServer.once('error', reject)
      httpServer.listen(port, '127.0.0.1', () => { httpServer.off('error', reject); resolve(httpServer.address().port) })
    }),
    close: () => new Promise((resolve) => {
      if (!httpServer) { resolve(); return }
      httpServer.closeAllConnections?.()
      httpServer.close(() => resolve())
      httpServer = null
    }),
  }
}

module.exports = { defaultUserDataDir, contextFromConfigFile, loadTokenStore, saveTokenStore, regenerateToken, runStdio, createHttpTransport, TOKEN_FILE }
