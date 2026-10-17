// Remote MCP connector for Grok Build and grok.com.
// The server stores grants and ciphertext only. A device the user turned on
// decrypts the vault locally and answers tool calls. Without that device,
// and without an OAuth grant the user approved, there is nothing to read.
import { randomBytes } from 'node:crypto'
import { languageForRequest } from './i18n.mjs'
import {
  MCP_SCOPE,
  MCP_TOOLS,
  escapeHtml,
  redirectsMatch,
  resourceMatches,
  resourceUrl,
  toolArgumentsAllowed,
} from './mcp-policy.mjs'
import {
  approveAuthorization,
  beginAuthorization,
  cancelVaultJob,
  claimVaultJob,
  completeVaultJob,
  consentCookie,
  disableReader,
  discardPending,
  enableReader,
  enqueueVaultJob,
  exchangeAuthorizationCode,
  getOauthClient,
  listGrants,
  matchReader,
  noteReaderSeen,
  pendingAuthorization,
  proveConsent,
  readerEnabled,
  readerSeenRecently,
  refreshOauthToken,
  registerOauthClient,
  revokeGrant,
  revokeOauthToken,
  verifyAccessToken,
} from './mcp-grants.mjs'
import { accountAcceptsAuthKey, authenticateSyncRequest, loadSyncAccountByEmail, withVerifiedSyncAuth } from './sync-api.mjs'

const PUBLIC_ORIGIN = () => (process.env.FANOTES_PUBLIC_ORIGIN || 'https://fanotes.fasrv.ch').replace(/\/+$/u, '')
const TOOL_WAIT_MS = () => Number(process.env.FANOTES_MCP_TOOL_WAIT_MS || 18_000)
const POLL_WAIT_MS = () => Number(process.env.FANOTES_MCP_POLL_WAIT_MS || 12_000)
const READER_FRESH_MS = 90_000
const MAX_JSON = 48 * 1024
const MAX_RESULT = 120_000
const PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])

const rateWindows = new Map()
const rateLimit = (key, maximum, windowMs) => {
  const now = Date.now()
  if (rateWindows.size > 20_000) {
    for (const [candidate, window] of rateWindows) if (window.until <= now) rateWindows.delete(candidate)
  }
  const current = rateWindows.get(key)
  if (!current || current.until <= now) {
    rateWindows.set(key, { count: 1, until: now + windowMs })
    return false
  }
  current.count += 1
  return current.count > maximum
}

const clientAddress = (request) => {
  const forwarded = request.headers['x-real-ip']
  return typeof forwarded === 'string' && forwarded.length <= 64 ? forwarded : request.socket?.remoteAddress || 'unknown'
}

const readBody = async (request, limit) => {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const readJson = async (request, limit = MAX_JSON) => {
  const raw = await readBody(request, limit)
  if (!raw) return { error: 'too_large' }
  if (!raw.length) return {}
  try { return JSON.parse(raw.toString('utf8')) } catch { return { error: 'invalid_json' } }
}

const readForm = async (request) => {
  const raw = await readBody(request, MAX_JSON)
  if (!raw) return { error: 'too_large' }
  const params = new URLSearchParams(raw.toString('utf8'))
  return Object.fromEntries(params.entries())
}

const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
}

const sendJson = (response, status, body, extra = {}) => {
  const payload = JSON.stringify(body)
  response.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), ...extra })
  response.end(payload)
}

const sendEmpty = (response, status, extra = {}) => {
  response.writeHead(status, { ...securityHeaders, ...extra })
  response.end()
}

const sendHtml = (response, status, html, extra = {}) => {
  response.writeHead(status, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), ...extra })
  response.end(html)
}

const oauthError = (response, status, error, description) => {
  sendJson(response, status, { error, error_description: description })
}

const bearerChallenge = (origin) => `Bearer realm="FaNotes", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="${MCP_SCOPE}"`

const corsHeaders = (request) => {
  const origin = request.headers.origin
  const allowed = origin === 'null' || origin === PUBLIC_ORIGIN()
  return allowed ? {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-FaNotes-Account, X-FaNotes-Reader',
    'Access-Control-Max-Age': '600',
  } : {}
}

const cookieValue = (request, name) => {
  const header = request.headers.cookie
  if (typeof header !== 'string') return ''
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return ''
}

const secureCookie = () => PUBLIC_ORIGIN().startsWith('https://') ? '; Secure' : ''

const metadata = (origin) => ({
  issuer: origin,
  authorization_endpoint: `${origin}/oauth/authorize`,
  token_endpoint: `${origin}/oauth/token`,
  registration_endpoint: `${origin}/oauth/register`,
  revocation_endpoint: `${origin}/oauth/revoke`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: [MCP_SCOPE],
  service_documentation: `${origin}/mcp`,
})

const protectedResource = (origin) => ({
  resource: resourceUrl(origin),
  authorization_servers: [origin],
  scopes_supported: [MCP_SCOPE],
  bearer_methods_supported: ['header'],
  resource_name: 'FaNotes',
})

const consentPage = ({ request, origin, english }) => {
  const nonce = randomBytes(16).toString('base64url')
  const copy = english ? {
    title: 'Allow Grok to read FaNotes',
    lead: 'Grok can read notes, exam dates, homework and flashcards only after you approve it here. The server cannot decrypt them. A FaNotes device with the connector turned on answers each request.',
    returns: 'After approval, the browser returns to',
    email: 'Email',
    password: 'Sync password',
    passwordHint: 'The password is turned into a key on this page. It is not sent to the server.',
    continue: 'Check password',
    allow: 'Allow this Grok',
    deny: 'Deny',
    waiting: 'Checking the password…',
  } : {
    title: 'Grok darf FaNotes lesen',
    lead: 'Grok liest Notizen, Prüfungstermine, Hausaufgaben und Karteikarten erst, nachdem du es hier erlaubst. Der Server kann sie nicht entschlüsseln. Ein FaNotes-Gerät, auf dem der Connector an ist, beantwortet jede Anfrage.',
    returns: 'Nach dem Erlauben kehrt der Browser zurück zu',
    email: 'E-Mail',
    password: 'Sync-Passwort',
    passwordHint: 'Das Passwort wird auf dieser Seite zum Schlüssel. Es wird nicht an den Server gesendet.',
    continue: 'Passwort prüfen',
    allow: 'Diesem Grok erlauben',
    deny: 'Ablehnen',
    waiting: 'Passwort wird geprüft…',
  }
  let host = 'Grok'
  try { host = new URL(request.redirectUri).host } catch { host = 'Grok' }
  const html = `<!DOCTYPE html>
<html lang="${english ? 'en' : 'de'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(copy.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.45 system-ui, sans-serif; background: #10140f; color: #f4f1e8; }
  main { max-width: 34rem; margin: 8vh auto; padding: 1.5rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .6rem; }
  p { color: #d5d0c4; }
  label { display: block; margin: .8rem 0; }
  span { display: block; margin-bottom: .25rem; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .7rem; border-radius: .5rem; border: 1px solid #3c4636; background: #181d16; color: inherit; }
  .row { display: flex; gap: .6rem; margin-top: 1rem; }
  button { border: 0; border-radius: .6rem; padding: .7rem 1rem; font: inherit; cursor: pointer; }
  .yes { background: #d7f26a; color: #17200c; }
  .no { background: transparent; color: inherit; border: 1px solid #3c4636; }
  .host { font-family: ui-monospace, monospace; }
  .err { color: #ffb4a8; }
  small { display: block; color: #aaa494; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(copy.title)}</h1>
  <p>${escapeHtml(copy.lead)}</p>
  <p>${escapeHtml(copy.returns)} <strong class="host">${escapeHtml(host)}</strong> (${escapeHtml(request.clientName)}).</p>
  <p id="err" class="err" role="alert"></p>
  <form id="sign">
    <label><span>${escapeHtml(copy.email)}</span><input id="email" type="email" autocomplete="username" required></label>
    <label><span>${escapeHtml(copy.password)}</span><input id="password" type="password" autocomplete="current-password" required><small>${escapeHtml(copy.passwordHint)}</small></label>
    <div class="row"><button class="yes" type="submit">${escapeHtml(copy.continue)}</button></div>
  </form>
  <form id="choice" hidden>
    <p id="who"></p>
    <div class="row">
      <button class="yes" type="submit" name="allow" value="1">${escapeHtml(copy.allow)}</button>
      <button class="no" type="submit" name="allow" value="0">${escapeHtml(copy.deny)}</button>
    </div>
  </form>
</main>
<script nonce="${nonce}">
const requestId = ${JSON.stringify(request.id)}
const copyWaiting = ${JSON.stringify(copy.waiting)}
const err = document.getElementById('err')
const bytesToBase64 = (bytes) => {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}
const fromBase64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
document.getElementById('sign').addEventListener('submit', async (event) => {
  event.preventDefault()
  err.textContent = copyWaiting
  const email = document.getElementById('email').value
  const password = document.getElementById('password').value
  document.getElementById('password').value = ''
  try {
    const pre = await fetch('/api/v1/sync/prelogin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })
    const preBody = await pre.json()
    const kdf = preBody.kdf
    if (!pre.ok || kdf?.algorithm !== 'pbkdf2-sha256') throw new Error('Sync-Anmeldung fehlgeschlagen.')
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'])
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(kdf.salt), iterations: kdf.iterations }, material, 512))
    const authKey = bytesToBase64(bits.subarray(32, 64))
    bits.fill(0)
    const proof = await fetch('/api/v1/mcp/consent', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, email, authKey }) })
    const body = await proof.json()
    if (!proof.ok) throw new Error(body.error || 'Anmeldung abgelehnt.')
    document.getElementById('sign').hidden = true
    document.getElementById('choice').hidden = false
    document.getElementById('who').textContent = body.email
    document.getElementById('choice').dataset.csrf = body.csrf
    err.textContent = ''
  } catch (error) {
    err.textContent = error instanceof Error ? error.message : 'Anmeldung abgelehnt.'
  }
})
document.getElementById('choice').addEventListener('submit', async (event) => {
  event.preventDefault()
  const allow = event.submitter?.value === '1'
  const decision = await fetch('/api/v1/mcp/consent/decision', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, csrf: event.currentTarget.dataset.csrf, allow }) })
  const body = await decision.json()
  if (!decision.ok || !body.redirect) {
    err.textContent = body.error || 'Die Freigabe wurde abgelehnt.'
    return
  }
  location.assign(body.redirect)
})
</script>
</body>
</html>`
  return {
    html,
    headers: {
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  }
}

const redirectBack = (redirectUri, params) => {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url.toString()
}

const syncAuth = async (request) => {
  try {
    return await authenticateSyncRequest(request)
  } catch (error) {
    return { error }
  }
}

const requireReader = async (request, auth) => {
  const readerKey = request.headers['x-fanotes-reader']
  const deviceId = await matchReader(auth.account.id, typeof readerKey === 'string' ? readerKey : '')
  return deviceId ? { deviceId, readerKey } : null
}

const toolResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError })

const offlineResult = async (accountId) => {
  const enabled = await readerEnabled(accountId)
  if (!enabled) {
    return toolResult('The FaNotes connector is off. Open FaNotes, go to Settings → Sync, and turn on the Grok connector on a device that has the vault.', true)
  }
  return null
}

const dispatchTool = async (access, name, args) => {
  if (!toolArgumentsAllowed(name, args)) return toolResult('Those arguments are not allowed for this read-only tool.', true)
  const offline = await offlineResult(access.accountId)
  if (offline) return offline
  // A device that is mid-poll has already checked in. If it has not, wait
  // only a short time so a closed app does not stall Grok for the full window.
  const waitMs = readerSeenRecently(access.accountId, READER_FRESH_MS) ? TOOL_WAIT_MS() : Math.min(TOOL_WAIT_MS(), 3_000)
  const job = enqueueVaultJob({ accountId: access.accountId, clientId: access.clientId, tool: name, args, waitMs })
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), waitMs))
  const result = await Promise.race([job.done, timeout])
  if (!result) {
    cancelVaultJob(job.id)
    return toolResult('FaNotes did not answer in time. Leave the app open and signed in to Sync.', true)
  }
  return result
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

const handleRpc = async (message, access) => {
  const id = message?.id ?? null
  const method = message?.method
  if (!message || message.jsonrpc !== '2.0' || typeof method !== 'string') return { status: 200, body: rpcError(id, -32600, 'Invalid Request') }
  if (id === undefined || id === null) return { status: 202, body: null }
  if (method === 'initialize') {
    const requested = message.params?.protocolVersion
    const protocolVersion = PROTOCOL_VERSIONS.has(requested) ? requested : '2025-06-18'
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'FaNotes', version: '1' },
        instructions: 'Read-only access to the FaNotes vault the user approved. Exam dates, notes, homework and flashcards are decrypted on the user\'s device. If a tool says FaNotes is offline, ask them to open the app.',
      }),
    }
  }
  if (method === 'ping' || method === 'notifications/initialized') return { status: 200, body: rpcResult(id, {}) }
  if (method === 'tools/list') return { status: 200, body: rpcResult(id, { tools: MCP_TOOLS }) }
  if (method === 'tools/call') {
    const name = message.params?.name
    const args = message.params?.arguments ?? {}
    if (typeof name !== 'string' || !MCP_TOOLS.some((tool) => tool.name === name)) {
      return { status: 200, body: rpcResult(id, toolResult('Unknown FaNotes tool.', true)) }
    }
    const result = await dispatchTool(access, name, args)
    return { status: 200, body: rpcResult(id, result) }
  }
  return { status: 200, body: rpcError(id, -32601, 'Method not found') }
}

const acceptableOrigin = (request) => {
  const origin = request.headers.origin
  if (!origin) return true
  return origin === PUBLIC_ORIGIN() || origin === 'https://grok.com' || origin === 'https://grok.x.ai'
}

const handleMcp = async (request, response, url) => {
  const origin = PUBLIC_ORIGIN()
  if (!acceptableOrigin(request)) {
    sendJson(response, 403, { error: 'This origin may not call FaNotes.' })
    return
  }
  if (request.method === 'OPTIONS') {
    sendEmpty(response, 204, corsHeaders(request))
    return
  }
  const header = request.headers.authorization
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const access = token ? await verifyAccessToken(token, resourceUrl(origin)) : null
  if (!access) {
    sendJson(response, 401, { error: 'Sign in with the FaNotes connector first.' }, { 'WWW-Authenticate': bearerChallenge(origin) })
    return
  }
  if (request.method === 'DELETE') {
    sendEmpty(response, 204)
    return
  }
  if (request.method === 'GET') {
    sendJson(response, 405, { error: 'FaNotes answers MCP calls with JSON, not an event stream.' }, { Allow: 'POST, DELETE' })
    return
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'POST, DELETE' })
    return
  }
  if (rateLimit(`mcp:${access.accountId}`, 120, 60_000)) {
    sendJson(response, 429, rpcError(null, -32000, 'Too many requests.'))
    return
  }
  const message = await readJson(request, 64 * 1024)
  if (!message || message.error) {
    sendJson(response, 400, rpcError(null, -32700, 'Parse error'))
    return
  }
  const outcome = await handleRpc(message, access)
  if (!outcome.body) {
    sendEmpty(response, outcome.status)
    return
  }
  const accept = String(request.headers.accept || '')
  if (accept.includes('text/event-stream') && !accept.includes('application/json')) {
    const data = `event: message\ndata: ${JSON.stringify(outcome.body)}\n\n`
    response.writeHead(outcome.status, { ...securityHeaders, 'Content-Type': 'text/event-stream; charset=utf-8', 'Content-Length': Buffer.byteLength(data) })
    response.end(data)
    return
  }
  sendJson(response, outcome.status, outcome.body)
}

const handleRegister = async (request, response) => {
  if (rateLimit(`mcp-register:${clientAddress(request)}`, 30, 60 * 60_000)) {
    oauthError(response, 429, 'slow_down', 'Too many registration attempts.')
    return
  }
  const body = await readJson(request)
  if (!body || body.error) {
    oauthError(response, 400, 'invalid_client_metadata', 'The registration body must be JSON.')
    return
  }
  const method = body.token_endpoint_auth_method
  if (method && method !== 'none') {
    oauthError(response, 400, 'invalid_client_metadata', 'FaNotes only accepts public clients with PKCE.')
    return
  }
  const grants = body.grant_types
  if (grants && (!Array.isArray(grants) || grants.some((grant) => grant !== 'authorization_code' && grant !== 'refresh_token'))) {
    oauthError(response, 400, 'invalid_client_metadata', 'Only authorization_code and refresh_token are accepted.')
    return
  }
  if (body.response_types && (!Array.isArray(body.response_types) || body.response_types.some((type) => type !== 'code'))) {
    oauthError(response, 400, 'invalid_client_metadata', 'Only the code response type is accepted.')
    return
  }
  const registered = await registerOauthClient({ name: body.client_name, redirectUris: body.redirect_uris })
  if (registered.error) {
    oauthError(response, 400, registered.error, 'The redirect URI is not an allowed Grok callback.')
    return
  }
  sendJson(response, 201, {
    client_id: registered.client.id,
    client_name: registered.client.name,
    redirect_uris: registered.client.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    client_id_issued_at: Math.floor(Date.parse(registered.client.createdAt) / 1000),
  })
}

const handleAuthorize = async (request, response, url) => {
  const origin = PUBLIC_ORIGIN()
  const client = await getOauthClient(url.searchParams.get('client_id') || '')
  if (!client) {
    oauthError(response, 400, 'invalid_client', 'Unknown client.')
    return
  }
  const redirectUri = url.searchParams.get('redirect_uri') || ''
  if (!client.redirectUris.some((uri) => redirectsMatch(uri, redirectUri))) {
    oauthError(response, 400, 'invalid_redirect_uri', 'That redirect URI is not registered for Grok.')
    return
  }
  const resource = url.searchParams.get('resource') || resourceUrl(origin)
  if (!resourceMatches(origin, resource)) {
    oauthError(response, 400, 'invalid_target', 'The resource must be the FaNotes MCP endpoint.')
    return
  }
  const started = beginAuthorization({
    client,
    redirectUri,
    state: url.searchParams.get('state') || '',
    codeChallenge: url.searchParams.get('code_challenge') || '',
    scope: url.searchParams.get('scope') || MCP_SCOPE,
    resource: resourceUrl(origin),
  })
  if (started.error === 'invalid_redirect_uri') {
    oauthError(response, 400, started.error, 'That redirect URI is not registered for Grok.')
    return
  }
  if (started.error) {
    const back = classifyRedirect(redirectUri) ? redirectBack(redirectUri, { error: started.error, state: url.searchParams.get('state') || '' }) : null
    if (back && url.searchParams.get('state')) {
      response.writeHead(302, { Location: back, ...securityHeaders })
      response.end()
      return
    }
    oauthError(response, 400, started.error, 'The authorization request is not valid.')
    return
  }
  if (url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256') {
    discardPending(started.request.id)
    response.writeHead(302, { Location: redirectBack(redirectUri, { error: 'invalid_request', state: started.request.state }), ...securityHeaders })
    response.end()
    return
  }
  const english = languageForRequest(request) !== 'de'
  const page = consentPage({ request: started.request, origin, english })
  sendHtml(response, 200, page.html, page.headers)
}

const handleToken = async (request, response) => {
  if (rateLimit(`mcp-token:${clientAddress(request)}`, 60, 15 * 60_000)) {
    oauthError(response, 429, 'slow_down', 'Too many token requests.')
    return
  }
  const type = String(request.headers['content-type'] || '')
  const body = type.includes('application/json') ? await readJson(request) : await readForm(request)
  if (!body || body.error) {
    oauthError(response, 400, 'invalid_request', 'The token request could not be read.')
    return
  }
  if (body.client_secret) {
    oauthError(response, 400, 'invalid_client', 'This client is public. Do not send a client secret.')
    return
  }
  const client = await getOauthClient(body.client_id || '')
  if (!client) {
    oauthError(response, 401, 'invalid_client', 'Unknown client.')
    return
  }
  const origin = PUBLIC_ORIGIN()
  const resource = body.resource || resourceUrl(origin)
  if (!resourceMatches(origin, resource)) {
    oauthError(response, 400, 'invalid_target', 'The resource must be the FaNotes MCP endpoint.')
    return
  }
  if (body.grant_type === 'authorization_code') {
    const exchanged = await exchangeAuthorizationCode({
      code: body.code,
      clientId: client.id,
      redirectUri: body.redirect_uri,
      verifier: body.code_verifier,
      resource: resourceUrl(origin),
    })
    if (exchanged.error) {
      oauthError(response, 400, exchanged.error, 'The authorization code was rejected.')
      return
    }
    sendJson(response, 200, exchanged.tokens)
    return
  }
  if (body.grant_type === 'refresh_token') {
    const refreshed = await refreshOauthToken({ refreshToken: body.refresh_token, clientId: client.id, resource: resourceUrl(origin) })
    if (refreshed.error) {
      oauthError(response, 400, refreshed.error, 'The refresh token was rejected.')
      return
    }
    sendJson(response, 200, refreshed.tokens)
    return
  }
  oauthError(response, 400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are accepted.')
}

const handleConsent = async (request, response) => {
  if (rateLimit(`mcp-consent:${clientAddress(request)}`, 20, 15 * 60_000)) {
    sendJson(response, 429, { error: 'Zu viele Anmeldeversuche.' })
    return
  }
  const body = await readJson(request)
  if (!body || body.error || typeof body.requestId !== 'string' || typeof body.email !== 'string' || typeof body.authKey !== 'string') {
    sendJson(response, 400, { error: 'Die Anmeldung ist unvollständig.' })
    return
  }
  const account = await loadSyncAccountByEmail(body.email)
  const matches = account ? await accountAcceptsAuthKey(account, body.authKey) : false
  if (!account || !matches) {
    if (!account) await accountAcceptsAuthKey({ auth: { salt: randomBytes(16).toString('base64'), hash: randomBytes(32).toString('base64') } }, body.authKey).catch(() => undefined)
    sendJson(response, 401, { error: 'E-Mail-Adresse oder Passwort stimmen nicht.' })
    return
  }
  const requestRecord = await proveConsent(body.requestId, account)
  if (!requestRecord) {
    sendJson(response, 400, { error: 'Diese Freigabe ist abgelaufen. Starte die Verbindung in Grok erneut.' })
    return
  }
  const cookie = await consentCookie(requestRecord)
  sendJson(response, 200, { email: account.email, csrf: requestRecord.csrf, clientName: requestRecord.clientName }, {
    'Set-Cookie': `fanotes_mcp_consent=${encodeURIComponent(cookie.value)}; HttpOnly; SameSite=Lax; Path=/api/v1/mcp; Max-Age=600${secureCookie()}`,
  })
}

const handleDecision = async (request, response) => {
  const body = await readJson(request)
  if (!body || body.error || typeof body.requestId !== 'string' || typeof body.csrf !== 'string') {
    sendJson(response, 400, { error: 'Die Freigabe ist unvollständig.' })
    return
  }
  const pending = pendingAuthorization(body.requestId)
  if (!pending) {
    sendJson(response, 400, { error: 'Diese Freigabe ist abgelaufen.' })
    return
  }
  if (body.allow !== true) {
    discardPending(body.requestId)
    sendJson(response, 200, { redirect: redirectBack(pending.redirectUri, { error: 'access_denied', state: pending.state }) })
    return
  }
  const approved = await approveAuthorization({ requestId: body.requestId, csrf: body.csrf, cookie: cookieValue(request, 'fanotes_mcp_consent') })
  if (approved.error || !approved.code) {
    sendJson(response, 400, { error: 'Die Freigabe wurde abgelehnt.' })
    return
  }
  sendJson(response, 200, {
    redirect: redirectBack(approved.request.redirectUri, { code: approved.code, state: approved.request.state }),
  }, { 'Set-Cookie': `fanotes_mcp_consent=; HttpOnly; SameSite=Lax; Path=/api/v1/mcp; Max-Age=0${secureCookie()}` })
}

const toolResultShape = (value) => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.content) || value.content.length !== 1) return null
  const item = value.content[0]
  if (!item || item.type !== 'text' || typeof item.text !== 'string' || item.text.length > MAX_RESULT) return null
  return { content: [{ type: 'text', text: item.text }], isError: value.isError === true }
}

const handleReader = async (request, response, route) => {
  if (request.method === 'OPTIONS') {
    sendEmpty(response, 204, corsHeaders(request))
    return
  }
  const auth = await syncAuth(request)
  if (auth.error) {
    sendJson(response, auth.error.status || 401, { error: auth.error.publicMessage || 'Bitte erneut anmelden.' }, corsHeaders(request))
    return
  }
  const extra = corsHeaders(request)
  if (route === '/reader' && request.method === 'POST') {
    if (rateLimit(`mcp-reader-on:${auth.account.id}`, 10, 60 * 60_000)) {
      sendJson(response, 429, { error: 'Zu viele Versuche.' }, extra)
      return
    }
    const body = await readJson(request)
    if (!body || body.error) {
      sendJson(response, 400, { error: 'Die Anfrage ist ungültig.' }, extra)
      return
    }
    const verified = await withVerifiedSyncAuth(auth.account.id, body.authKey, () => enableReader(auth.account.id, auth.deviceId, body.readerKey))
    if (!verified.ok) {
      sendJson(response, 403, { error: 'Das Passwort stimmt nicht.' }, extra)
      return
    }
    if (!verified.value) {
      sendJson(response, 400, { error: 'Der Connector-Schlüssel ist ungültig.' }, extra)
      return
    }
    sendJson(response, 200, { enabled: true }, extra)
    return
  }
  if (route === '/reader' && request.method === 'DELETE') {
    const body = await readJson(request)
    if (!body || body.error) {
      sendJson(response, 400, { error: 'Die Anfrage ist ungültig.' }, extra)
      return
    }
    const verified = await withVerifiedSyncAuth(auth.account.id, body.authKey, () => disableReader(auth.account.id, body.everywhere === true ? null : auth.deviceId, { revokeGrants: body.everywhere === true }))
    if (!verified.ok) {
      sendJson(response, 403, { error: 'Das Passwort stimmt nicht.' }, extra)
      return
    }
    sendJson(response, 200, { enabled: false }, extra)
    return
  }
  const reader = await requireReader(request, auth)
  if (!reader) {
    sendJson(response, 401, { error: 'Dieser Connector-Schlüssel gehört nicht zum Konto.' }, extra)
    return
  }
  noteReaderSeen(auth.account.id)
  if (route === '/reader' && request.method === 'GET') {
    sendJson(response, 200, { enabled: true, grants: await listGrants(auth.account.id) }, extra)
    return
  }
  if (route === '/reader/revoke' && request.method === 'POST') {
    const body = await readJson(request)
    const revoked = body && typeof body.grantId === 'string' ? await revokeGrant(auth.account.id, body.grantId) : false
    sendJson(response, revoked ? 200 : 404, revoked ? { revoked: true } : { error: 'Diese Freigabe ist nicht bekannt.' }, extra)
    return
  }
  if (route === '/reader/poll' && request.method === 'POST') {
    const waitMs = Math.min(POLL_WAIT_MS(), 20_000)
    const started = Date.now()
    let job = claimVaultJob(auth.account.id)
    while (!job && Date.now() - started < waitMs) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      job = claimVaultJob(auth.account.id)
    }
    sendJson(response, 200, { job }, extra)
    return
  }
  if (route === '/reader/result' && request.method === 'POST') {
    const body = await readJson(request, MAX_RESULT + 4096)
    const result = toolResultShape(body?.result)
    if (!body || typeof body.id !== 'string' || !result || !completeVaultJob(auth.account.id, body.id, result)) {
      sendJson(response, 404, { error: 'Diese Anfrage ist nicht mehr offen.' }, extra)
      return
    }
    sendJson(response, 200, { ok: true }, extra)
    return
  }
  sendJson(response, 404, { error: 'Nicht gefunden.' }, extra)
}

export const handleMcpRequest = async (request, response, url) => {
  const path = url.pathname
  const method = request.method || 'GET'
  try {
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' })
        return true
      }
      sendJson(response, 200, protectedResource(PUBLIC_ORIGIN()))
      return true
    }
    if (path === '/.well-known/oauth-authorization-server') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' })
        return true
      }
      sendJson(response, 200, metadata(PUBLIC_ORIGIN()))
      return true
    }
    if (path === '/oauth/register' && method === 'POST') {
      await handleRegister(request, response)
      return true
    }
    if (path === '/oauth/authorize' && method === 'GET') {
      await handleAuthorize(request, response, url)
      return true
    }
    if (path === '/oauth/token' && method === 'POST') {
      await handleToken(request, response)
      return true
    }
    if (path === '/oauth/revoke' && method === 'POST') {
      const type = String(request.headers['content-type'] || '')
      const body = type.includes('application/json') ? await readJson(request) : await readForm(request)
      if (body && !body.error) await revokeOauthToken({ token: body.token, clientId: body.client_id })
      sendEmpty(response, 200)
      return true
    }
    if (path === '/mcp' || path === '/mcp/') {
      await handleMcp(request, response, url)
      return true
    }
    if (path === '/api/v1/mcp/consent' && method === 'POST') {
      await handleConsent(request, response)
      return true
    }
    if (path === '/api/v1/mcp/consent/decision' && method === 'POST') {
      await handleDecision(request, response)
      return true
    }
    if (path.startsWith('/api/v1/mcp/')) {
      await handleReader(request, response, path.slice('/api/v1/mcp'.length))
      return true
    }
    return false
  } catch (error) {
    console.error(new Date().toISOString(), 'mcp', method, path, error?.message || error)
    if (!response.headersSent) sendJson(response, 500, { error: 'FaNotes could not complete that request.' })
    return true
  }
}

export const mcpConnectorName = 'FaNotes'
