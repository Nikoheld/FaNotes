'use strict'

// Grok Build subscription usage. The protocol matches the official grok CLI
// (grok-build config.rs default OAuth client, device-code grant, and the
// documented cli-chat-proxy chat completion). An xAI API key stays on api.x.ai
// and is billed separately. Callers cannot choose the host.

const { Buffer } = require('node:buffer')

const ISSUER = 'https://auth.x.ai'
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const SCOPES = 'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write'
const PROXY = 'https://cli-chat-proxy.grok.com/v1'
const CLIENT_VERSION = '1.0.70'
const CLIENT_IDENTIFIER = 'grok-shell'
const TOKEN_AUTH = 'xai-grok-cli'
const DEFAULT_MODEL = 'grok-build'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const REFRESH_SKEW_MS = 5 * 60 * 1000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function cleanToken(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\0\r\n]/u.test(value)) {
    throw new Error(`Die ${label} ist ungültig.`)
  }
  return value.trim()
}

function redact(message, secrets) {
  let text = String(message ?? '')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) text = text.split(secret).join('••••')
  }
  return text.slice(0, 700)
}

function allowedLoginHost(hostname) {
  const host = String(hostname || '').toLocaleLowerCase('en-US')
  return host === 'x.ai' || host === 'grok.com' || host.endsWith('.x.ai') || host.endsWith('.grok.com')
}

function assertLoginUri(uri) {
  if (typeof uri !== 'string' || uri.length > 2048 || /[\0\r\n]/u.test(uri)) throw new Error('Die Anmeldeseite von Grok Build ist unzulässig.')
  let parsed
  try { parsed = new URL(uri) } catch { throw new Error('Die Anmeldeseite von Grok Build ist unzulässig.') }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !allowedLoginHost(parsed.hostname)) {
    throw new Error('Die Anmeldeseite von Grok Build ist unzulässig.')
  }
  return parsed.href
}

function assertUserCode(code) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9-]{4,64}$/u.test(code)) throw new Error('Grok Build hat einen ungültigen Anmeldecode geliefert.')
  return code
}

function authHeaders(surface) {
  return {
    Accept: 'application/json',
    'x-grok-client-version': CLIENT_VERSION,
    'x-grok-client-surface': surface,
  }
}

function proxyHeaders(accessToken, model) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'X-XAI-Token-Auth': TOKEN_AUTH,
    'x-grok-client-version': CLIENT_VERSION,
    'x-grok-client-identifier': CLIENT_IDENTIFIER,
    'x-grok-model-override': model,
    'User-Agent': `grok-cli/${CLIENT_VERSION}`,
  }
}

async function readJson(response, label, secrets) {
  const advertised = Number(response.headers.get('content-length'))
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) throw new Error(`${label} hat eine unerwartet große Antwort geliefert.`)
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error(`${label} hat eine unerwartet große Antwort geliefert.`)
  try { return text ? JSON.parse(text) : null } catch {
    const error = new Error(`${label} hat keine gültige JSON-Antwort geliefert.`)
    error.status = response.status
    throw error
  }
}

async function postForm(url, fields, surface, fetchImpl, secrets) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { ...authHeaders(surface), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      redirect: 'error',
      signal: controller.signal,
    })
    const data = await readJson(response, 'Grok Build', secrets)
    return { ok: response.ok, status: response.status, data }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Grok Build hat nicht rechtzeitig geantwortet.')
    if (String(error?.message ?? '').startsWith('Grok Build')) throw error
    throw new Error(`Grok Build ist nicht erreichbar: ${redact(error?.message, secrets)}`)
  } finally {
    clearTimeout(timeout)
  }
}

async function requestDeviceCode(fetchImpl) {
  const posted = await postForm(`${ISSUER}/oauth2/device/code`, {
    client_id: CLIENT_ID,
    scope: SCOPES,
    referrer: 'grok-build',
  }, 'ui', fetchImpl, [])
  if (!posted.ok) {
    if (posted.status === 404) throw new Error('Die Grok-Build-Anmeldung ist hier nicht verfügbar.')
    const detail = isObject(posted.data) ? posted.data.error_description || posted.data.error : ''
    throw new Error(`Die Grok-Build-Anmeldung ist fehlgeschlagen.${detail ? ` ${redact(detail, [])}` : ''}`)
  }
  const data = posted.data
  if (!isObject(data) || typeof data.device_code !== 'string') throw new Error('Grok Build hat keinen Anmeldecode geliefert.')
  const verificationUri = assertLoginUri(data.verification_uri)
  const verificationUriComplete = typeof data.verification_uri_complete === 'string' && data.verification_uri_complete
    ? assertLoginUri(data.verification_uri_complete)
    : verificationUri
  const interval = Number.isFinite(data.interval) ? Math.min(60, Math.max(1, Math.trunc(data.interval))) : 5
  const expiresIn = Number.isFinite(data.expires_in) ? Math.min(1800, Math.max(60, Math.trunc(data.expires_in))) : 600
  return {
    deviceCode: cleanToken(data.device_code, 'Grok-Build-Anmeldung'),
    userCode: assertUserCode(data.user_code),
    verificationUri,
    verificationUriComplete,
    interval,
    expiresIn,
  }
}

function publicLogin(device) {
  return {
    status: 'pending',
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    verificationUriComplete: device.verificationUriComplete,
    expiresIn: device.expiresIn,
  }
}

async function pollDeviceOnce(device, fetchImpl) {
  return postForm(`${ISSUER}/oauth2/token`, {
    grant_type: DEVICE_GRANT,
    device_code: device.deviceCode,
    client_id: CLIENT_ID,
  }, 'ui', fetchImpl, [device.deviceCode])
}

function sessionFromToken(data, previousRefresh) {
  if (!isObject(data) || typeof data.access_token !== 'string') throw new Error('Grok Build hat keine Anmeldung geliefert.')
  const refreshToken = typeof data.refresh_token === 'string' && data.refresh_token
    ? cleanToken(data.refresh_token, 'Grok-Build-Anmeldung')
    : previousRefresh
  if (!refreshToken) throw new Error('Grok Build hat keine erneuerbare Anmeldung geliefert.')
  const expiresIn = Number.isFinite(data.expires_in) ? Math.max(30, Math.trunc(data.expires_in)) : 600
  return {
    accessToken: cleanToken(data.access_token, 'Grok-Build-Anmeldung'),
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  }
}

function createLogin(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms) }))
  let generation = 0
  let current = { status: 'idle', error: '', publicView: null, session: null }
  let settled = Promise.resolve(null)

  const view = () => {
    if (current.status === 'pending' || current.status === 'ready' || current.status === 'error') {
      return { status: current.status, error: current.error, ...(current.publicView ?? {}) }
    }
    return { status: 'idle', error: '' }
  }

  return {
    async start() {
      generation += 1
      const ticket = generation
      const device = await requestDeviceCode(fetchImpl)
      if (ticket !== generation) return view()
      current = { status: 'pending', error: '', publicView: publicLogin(device), session: null }
      const deadline = Date.now() + device.expiresIn * 1000
      let intervalMs = device.interval * 1000
      settled = (async () => {
        while (ticket === generation) {
          await sleep(intervalMs)
          if (ticket !== generation) return null
          if (Date.now() > deadline) throw new Error('Der Anmeldecode ist abgelaufen. Starte die Anmeldung erneut.')
          const posted = await pollDeviceOnce(device, fetchImpl)
          if (ticket !== generation) return null
          if (posted.ok) {
            current = { status: 'ready', error: '', publicView: { ...current.publicView, status: 'ready' }, session: sessionFromToken(posted.data, '') }
            return current.session
          }
          const error = isObject(posted.data) && typeof posted.data.error === 'string' ? posted.data.error : ''
          if (error === 'authorization_pending') continue
          if (error === 'slow_down') {
            intervalMs = Math.min(60_000, intervalMs + 5_000)
            continue
          }
          if (error === 'access_denied') throw new Error('Die Anmeldung wurde abgelehnt.')
          if (error === 'expired_token') throw new Error('Der Anmeldecode ist abgelaufen. Starte die Anmeldung erneut.')
          const detail = isObject(posted.data) ? posted.data.error_description || error : ''
          throw new Error(detail ? `Die Grok-Build-Anmeldung ist fehlgeschlagen. ${redact(detail, [device.deviceCode])}` : 'Die Grok-Build-Anmeldung ist fehlgeschlagen.')
        }
        return null
      })().catch((error) => {
        if (ticket !== generation) return null
        current = { status: 'error', error: error?.message || 'Die Grok-Build-Anmeldung ist fehlgeschlagen.', publicView: current.publicView, session: null }
        return null
      })
      return view()
    },
    status() {
      return view()
    },
    whenSettled() {
      return settled
    },
    take() {
      if (current.status !== 'ready' || !current.session) return null
      const session = current.session
      current = { status: 'idle', error: '', publicView: null, session: null }
      return session
    },
    cancel() {
      generation += 1
      current = { status: 'idle', error: '', publicView: null, session: null }
      return { status: 'idle' }
    },
  }
}

async function refreshSession(input, fetchImpl = globalThis.fetch, now = Date.now) {
  const refreshToken = cleanToken(input?.refreshToken, 'Grok-Build-Anmeldung')
  const accessToken = typeof input?.accessToken === 'string' && input.accessToken.trim()
    ? cleanToken(input.accessToken, 'Grok-Build-Anmeldung')
    : ''
  const expiresAt = Number(input?.expiresAt)
  const clock = typeof now === 'function' ? now() : now
  if (accessToken && Number.isFinite(expiresAt) && expiresAt - clock > REFRESH_SKEW_MS) {
    return { accessToken, refreshToken, expiresAt, rotated: false }
  }
  const posted = await postForm(`${ISSUER}/oauth2/token`, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  }, 'ui', fetchImpl, [refreshToken, accessToken])
  if (!posted.ok) {
    const detail = isObject(posted.data) ? posted.data.error_description || posted.data.error : ''
    throw new Error(`Die Grok-Build-Anmeldung ist abgelaufen.${detail ? ` ${redact(detail, [refreshToken, accessToken])}` : ' Melde dich erneut an.'}`)
  }
  const session = sessionFromToken(posted.data, refreshToken)
  return { ...session, rotated: true }
}

async function proxyJson(path, accessToken, model, options = {}) {
  const token = cleanToken(accessToken, 'Grok-Build-Anmeldung')
  const selected = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_MODEL
  if (selected.length > 500 || /[\0\r\n]/u.test(selected)) throw new Error('Wähle zuerst ein gültiges AI-Modell.')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000)
  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(`${PROXY}${path}`, {
      method: options.method ?? 'GET',
      headers: { ...proxyHeaders(token, selected), ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'error',
      signal: controller.signal,
    })
    const data = await readJson(response, 'Grok', [token])
    if (!response.ok) {
      const detail = isObject(data) && isObject(data.error) && typeof data.error.message === 'string'
        ? data.error.message
        : isObject(data) && typeof data.error === 'string'
          ? data.error
          : `HTTP ${response.status}`
      const error = new Error(`Grok: ${redact(detail, [token])}`)
      error.status = response.status
      throw error
    }
    return data
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Grok hat nicht rechtzeitig geantwortet.')
    if (String(error?.message ?? '').startsWith('Grok')) throw error
    throw new Error(`Grok ist nicht erreichbar: ${redact(error?.message, [token])}`)
  } finally {
    clearTimeout(timeout)
  }
}

const buildModel = (id) => ({
  provider: 'grok',
  key: String(id).slice(0, 500),
  displayName: String(id).slice(0, 500),
  publisher: 'xAI',
  quantization: null,
  params: null,
  loaded: true,
  maxContextLength: null,
  description: null,
})

function modelsFromPayload(data) {
  const entries = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : []
  return entries.flatMap((entry) => {
    if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id.trim()) return []
    if (Array.isArray(entry.output_modalities) && !entry.output_modalities.includes('text')) return []
    return [buildModel(entry.id.trim())]
  })
}

async function listGrokBuildModels(accessToken, fetchImpl = globalThis.fetch) {
  try {
    const data = await proxyJson('/models', accessToken, DEFAULT_MODEL, { fetchImpl })
    const models = modelsFromPayload(data)
    return models.length ? models : [buildModel(DEFAULT_MODEL)]
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) throw new Error('Die Grok-Build-Anmeldung ist abgelaufen. Melde dich erneut an.')
    return [buildModel(DEFAULT_MODEL)]
  }
}

function messageText(message) {
  if (!isObject(message)) return ''
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content.flatMap((part) => typeof part === 'string' ? [part] : isObject(part) && typeof part.text === 'string' ? [part.text] : []).join('\n\n')
  }
  return ''
}

async function completeGrokBuild({ accessToken, model, systemPrompt, prompt, fetchImpl }) {
  const selected = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_MODEL
  try {
    const data = await proxyJson('/chat/completions', accessToken, selected, {
      fetchImpl,
      method: 'POST',
      timeoutMs: 10 * 60_000,
      body: {
        model: selected,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        stream: false,
      },
    })
    return {
      markdown: messageText(data?.choices?.[0]?.message),
      stats: { inputTokens: data?.usage?.prompt_tokens, outputTokens: data?.usage?.completion_tokens },
    }
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) throw new Error('Die Grok-Build-Anmeldung ist abgelaufen. Melde dich erneut an.')
    throw error
  }
}

module.exports = {
  CLIENT_ID,
  CLIENT_IDENTIFIER,
  CLIENT_VERSION,
  DEFAULT_MODEL,
  ISSUER,
  PROXY,
  SCOPES,
  TOKEN_AUTH,
  completeGrokBuild,
  createLogin,
  listGrokBuildModels,
  refreshSession,
}
