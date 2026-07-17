import { localizeResponse } from './i18n.mjs'

const PROVIDERS = new Set(['openai', 'gemini', 'anthropic'])
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_PROVIDER_BYTES = 8 * 1024 * 1024
const WINDOW_MS = 5 * 60_000
const MAX_REQUESTS_PER_WINDOW = 24
const MAX_ACTIVE_REQUESTS = 8
const buckets = new Map()
let activeRequests = 0

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const clientAddress = (request) => String(request.headers['x-real-ip'] || request.socket.remoteAddress || 'unknown').slice(0, 200)

const sendJson = (response, status, value) => {
  const body = JSON.stringify(localizeResponse(value, response.fanotesLanguage || 'de'))
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  response.end(body)
}

const consumeRateLimit = (request) => {
  const now = Date.now()
  const key = clientAddress(request)
  const current = buckets.get(key)
  const bucket = !current || now - current.startedAt >= WINDOW_MS ? { startedAt: now, count: 0 } : current
  bucket.count += 1
  buckets.set(key, bucket)
  if (buckets.size > 2000) for (const [address, value] of buckets) if (now - value.startedAt >= WINDOW_MS) buckets.delete(address)
  return bucket.count <= MAX_REQUESTS_PER_WINDOW && activeRequests < MAX_ACTIVE_REQUESTS
}

const readJson = async (request) => {
  let bytes = 0
  const chunks = []
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error('Der AI-Auftrag ist zu groß.'), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw Object.assign(new Error('Der AI-Auftrag enthält kein gültiges JSON.'), { status: 400 }) }
}

const cleanString = (value, max, label, required = true) => {
  if (typeof value !== 'string' || value.length > max || /[\0\r]/u.test(value) || (required && !value.trim())) throw Object.assign(new Error(`${label} ist ungültig.`), { status: 400 })
  return value.trim()
}

const connection = (body) => {
  if (!isObject(body) || !PROVIDERS.has(body.provider)) throw Object.assign(new Error('Dieser Cloud-Anbieter wird nicht unterstützt.'), { status: 400 })
  return { provider: body.provider, apiKey: cleanString(body.apiKey, 4096, 'Der API-Schlüssel') }
}

const providerHeaders = ({ provider, apiKey }) => provider === 'anthropic'
  ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  : provider === 'gemini'
    ? { 'x-goog-api-key': apiKey }
    : { Authorization: `Bearer ${apiKey}` }

const providerJson = async (url, provider, options = {}) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 25_000)
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: { Accept: 'application/json', ...providerHeaders(provider), ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'error',
      signal: controller.signal,
    })
    const advertised = Number(response.headers.get('content-length'))
    if (Number.isFinite(advertised) && advertised > MAX_PROVIDER_BYTES) throw new Error('Der Cloud-Anbieter hat eine unerwartet große Antwort geliefert.')
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_PROVIDER_BYTES) throw new Error('Der Cloud-Anbieter hat eine unerwartet große Antwort geliefert.')
    let data
    try { data = text ? JSON.parse(text) : null } catch { throw new Error('Der Cloud-Anbieter hat keine gültige JSON-Antwort geliefert.') }
    if (!response.ok) {
      const detail = typeof data?.error?.message === 'string' ? data.error.message : typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : `HTTP ${response.status}`
      throw Object.assign(new Error(`${provider.provider === 'openai' ? 'OpenAI' : provider.provider === 'gemini' ? 'Gemini' : 'Anthropic'}: ${detail.slice(0, 700)}`), { status: response.status >= 400 && response.status < 500 ? 400 : 502 })
    }
    return data
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('Der Cloud-Anbieter hat nicht rechtzeitig geantwortet.'), { status: 504 })
    throw error
  } finally { clearTimeout(timeout) }
}

const aiModel = (provider, key, displayName, metadata = {}) => ({
  provider, key: String(key).slice(0, 500), displayName: String(displayName || key).slice(0, 500), publisher: String(metadata.publisher || '').slice(0, 200), quantization: null, params: null, loaded: true, maxContextLength: Number.isFinite(metadata.maxContextLength) ? metadata.maxContextLength : null, description: metadata.description ? String(metadata.description).slice(0, 1200) : null,
})

const listModels = async (provider) => {
  if (provider.provider === 'openai') {
    const data = await providerJson('https://api.openai.com/v1/models', provider)
    if (!Array.isArray(data?.data)) throw new Error('OpenAI hat keine Modellliste geliefert.')
    return data.data.flatMap((entry) => isObject(entry) && typeof entry.id === 'string' ? [aiModel('openai', entry.id, entry.id, { publisher: entry.owned_by })] : []).sort((a, b) => a.displayName.localeCompare(b.displayName)).slice(0, 1000)
  }
  if (provider.provider === 'gemini') {
    const data = await providerJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', provider)
    if (!Array.isArray(data?.models)) throw new Error('Gemini hat keine Modellliste geliefert.')
    return data.models.flatMap((entry) => isObject(entry) && typeof entry.name === 'string' && Array.isArray(entry.supportedGenerationMethods) && entry.supportedGenerationMethods.includes('generateContent') ? [aiModel('gemini', entry.name.replace(/^models\//u, ''), entry.displayName, { publisher: 'Google', maxContextLength: entry.inputTokenLimit, description: entry.description })] : [])
  }
  const data = await providerJson('https://api.anthropic.com/v1/models?limit=1000', provider)
  if (!Array.isArray(data?.data)) throw new Error('Anthropic hat keine Modellliste geliefert.')
  return data.data.flatMap((entry) => isObject(entry) && typeof entry.id === 'string' ? [aiModel('anthropic', entry.id, entry.display_name, { publisher: 'Anthropic', maxContextLength: entry.max_input_tokens })] : [])
}

const transform = async (provider, body) => {
  const model = cleanString(body.model, 500, 'Das Modell')
  const systemPrompt = cleanString(body.systemPrompt, 4000, 'Die Systemanweisung')
  const prompt = cleanString(body.prompt, 1_800_000, 'Der AI-Auftrag')
  const maxTokens = Number.isSafeInteger(body.maxTokens) ? Math.min(16_000, Math.max(512, body.maxTokens)) : 4096
  let markdown = ''
  let stats = {}
  if (provider.provider === 'openai') {
    const data = await providerJson('https://api.openai.com/v1/responses', provider, { method: 'POST', timeoutMs: 10 * 60_000, body: { model, instructions: systemPrompt, input: prompt, max_output_tokens: maxTokens, store: false } })
    markdown = typeof data?.output_text === 'string' ? data.output_text : Array.isArray(data?.output) ? data.output.flatMap((item) => Array.isArray(item?.content) ? item.content : []).filter((part) => part?.type === 'output_text' && typeof part.text === 'string').map((part) => part.text).join('\n\n') : ''
    stats = { inputTokens: data?.usage?.input_tokens, outputTokens: data?.usage?.output_tokens }
  } else if (provider.provider === 'gemini') {
    const data = await providerJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, provider, { method: 'POST', timeoutMs: 10 * 60_000, body: { systemInstruction: { parts: [{ text: systemPrompt }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.15 } } })
    markdown = Array.isArray(data?.candidates?.[0]?.content?.parts) ? data.candidates[0].content.parts.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('\n\n') : ''
    stats = { inputTokens: data?.usageMetadata?.promptTokenCount, outputTokens: data?.usageMetadata?.candidatesTokenCount }
  } else {
    const data = await providerJson('https://api.anthropic.com/v1/messages', provider, { method: 'POST', timeoutMs: 10 * 60_000, body: { model, max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: prompt }] } })
    markdown = Array.isArray(data?.content) ? data.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n\n') : ''
    stats = { inputTokens: data?.usage?.input_tokens, outputTokens: data?.usage?.output_tokens }
  }
  if (!markdown.trim() || Buffer.byteLength(markdown) > 4 * 1024 * 1024) throw new Error('Der Cloud-Anbieter hat kein verwendbares Markdown-Dokument zurückgegeben.')
  return { provider: provider.provider, model, markdown, stats: Object.fromEntries(Object.entries(stats).filter(([, value]) => Number.isFinite(value) && value >= 0)) }
}

export const handleAiProxyRequest = async (request, response, url) => {
  if (!url.pathname.startsWith('/api/v1/ai/')) return false
  if (!['/api/v1/ai/models', '/api/v1/ai/transform'].includes(url.pathname)) { sendJson(response, 404, { error: 'AI-Endpunkt nicht gefunden.' }); return true }
  if (request.method !== 'POST') { sendJson(response, 405, { error: 'Nur POST ist erlaubt.' }); return true }
  if (!String(request.headers['content-type'] || '').toLocaleLowerCase('en-US').startsWith('application/json')) { sendJson(response, 415, { error: 'AI-Anfragen müssen JSON verwenden.' }); return true }
  const publicOrigin = process.env.FANOTES_PUBLIC_ORIGIN || 'https://fanotes.fasrv.ch'
  const origin = request.headers.origin
  if (origin && origin !== publicOrigin) { sendJson(response, 403, { error: 'Diese Anfrage stammt nicht von FaNotes.' }); return true }
  if (!consumeRateLimit(request)) { sendJson(response, 429, { error: 'Zu viele AI-Anfragen. Warte kurz und versuche es erneut.' }); return true }
  activeRequests += 1
  try {
    const body = await readJson(request)
    const provider = connection(body)
    sendJson(response, 200, url.pathname.endsWith('/models') ? { models: await listModels(provider) } : await transform(provider, body))
  } catch (error) {
    sendJson(response, Number.isInteger(error?.status) ? error.status : 502, { error: error instanceof Error ? error.message : 'Die AI-Anfrage ist fehlgeschlagen.' })
  } finally { activeRequests -= 1 }
  return true
}
