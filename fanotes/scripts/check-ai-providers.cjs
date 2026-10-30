'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')
const { listAiModels, normalizeLocalUrl, transformWithAi } = require('../electron/ai-provider.cjs')
const { createLogin, refreshSession } = require('../electron/grok-build.cjs')

const requests = []
let openCodeDeleted = false
const server = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  const body = text ? JSON.parse(text) : null
  requests.push({ method: request.method, url: request.url, headers: request.headers, body })
  const send = (value, status = 200) => { const data = JSON.stringify(value); response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }); response.end(data) }
  if (request.url === '/api/v1/models') return send({ models: [{ type: 'llm', key: 'local/lm', display_name: 'LM lokal', publisher: 'FaNotes', loaded_instances: [{}], max_context_length: 32768 }] })
  if (request.url === '/api/v1/chat') return send({ output: [{ type: 'message', content: '# LM Studio\n\nKorrigiert' }], stats: { input_tokens: 10, total_output_tokens: 5 } })
  if (request.url === '/api/tags') return send({ models: [{ model: 'qwen:latest', name: 'Qwen', details: { family: 'qwen', parameter_size: '8B', quantization_level: 'Q4' } }] })
  if (request.url === '/api/chat') return send({ message: { role: 'assistant', content: '# Ollama\n\nKorrigiert' }, prompt_eval_count: 10, eval_count: 5, eval_duration: 1_000_000_000 })
  if (request.url === '/global/health') return send({ healthy: true, version: 'test' })
  if (request.url === '/provider') return send({ all: [{ id: 'anthropic', name: 'Anthropic', models: { 'claude-test': { name: 'Claude Test', limit: { context: 200000 } } } }], connected: ['anthropic'] })
  if (request.url === '/session' && request.method === 'POST') return send({ id: 'session-test' })
  if (request.url === '/session/session-test/message') return send({ info: {}, parts: [{ type: 'text', text: '# OpenCode\n\nKorrigiert' }] })
  if (request.url === '/session/session-test' && request.method === 'DELETE') { openCodeDeleted = true; return send(true) }
  return send({ error: { message: 'not found' } }, 404)
})

const listen = () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const close = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
const payload = (connection) => ({ connection, title: 'Test', relativePath: 'Test.md', markdown: '# Tset', actions: ['spelling'], instruction: '', vaultNotes: [] })

;(async () => {
  await listen()
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}`
  const localConnections = [
    { provider: 'lmstudio', baseUrl, apiKey: '', model: 'local/lm' },
    { provider: 'ollama', baseUrl, apiKey: '', model: 'qwen:latest' },
    { provider: 'opencode', baseUrl, apiKey: 'secret', username: 'opencode', model: 'anthropic/claude-test' },
  ]
  for (const connection of localConnections) {
    const models = await listAiModels({ ...connection, model: '' })
    assert.equal(models[0].provider, connection.provider)
    const result = await transformWithAi(payload(connection))
    assert.equal(result.provider, connection.provider)
    assert.match(result.markdown, /Korrigiert/u)
  }
  assert.equal(openCodeDeleted, true, 'OpenCode-Sitzungen müssen nach jeder Vorschau gelöscht werden.')
  const openCodeMessage = requests.find((entry) => entry.url === '/session/session-test/message')
  assert.equal(openCodeMessage.body.tools.bash, false)
  assert.equal(openCodeMessage.body.tools.edit, false)
  assert.equal(openCodeMessage.body.tools.webfetch, false)
  assert.match(openCodeMessage.headers.authorization, /^Basic /u)
  assert.throws(() => normalizeLocalUrl('https://example.com', 'ollama'), /localhost|privaten LAN/u)

  const nativeFetch = global.fetch
  const cloudRequests = []
  global.fetch = async (url, options = {}) => {
    const address = String(url)
    cloudRequests.push({ address, options })
    let value
    if (address === 'https://api.openai.com/v1/models') value = { data: [{ id: 'gpt-test', owned_by: 'openai' }] }
    else if (address === 'https://api.openai.com/v1/responses') value = { output_text: '# OpenAI\n\nKorrigiert', usage: { input_tokens: 10, output_tokens: 5 } }
    else if (address.includes('generativelanguage.googleapis.com') && address.includes('?pageSize=')) value = { models: [{ name: 'models/gemini-test', displayName: 'Gemini Test', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 100000 }] }
    else if (address.includes('generativelanguage.googleapis.com')) value = { candidates: [{ content: { parts: [{ text: '# Gemini\n\nKorrigiert' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }
    else if (address.includes('api.anthropic.com/v1/models')) value = { data: [{ id: 'claude-test', display_name: 'Claude Test', max_input_tokens: 200000 }] }
    else if (address === 'https://api.anthropic.com/v1/messages') value = { content: [{ type: 'text', text: '# Anthropic\n\nKorrigiert' }], usage: { input_tokens: 10, output_tokens: 5 } }
    else if (address === 'https://api.x.ai/v1/language-models') value = { models: [{ id: 'grok-imagine-image', output_modalities: ['image'], owned_by: 'xai' }, { id: 'grok-4.5', output_modalities: ['text'], owned_by: 'xai' }, { id: 'grok-4.7', output_modalities: ['text'], owned_by: 'xai' }] }
    else if (address === 'https://api.x.ai/v1/responses') value = { output_text: '# Grok\n\nKorrigiert', usage: { input_tokens: 10, output_tokens: 5 } }
    else if (address === 'https://cli-chat-proxy.grok.com/v1/models') {
      const authorization = options.headers?.Authorization
      if (authorization === 'Bearer build-denied-token') return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      value = authorization === 'Bearer build-empty-token'
        ? { data: [] }
        : { data: [{ id: 'grok-4.7' }, { id: 'imagine-only', output_modalities: ['image'] }, { id: 'grok-build' }] }
    } else if (address === 'https://cli-chat-proxy.grok.com/v1/chat/completions') value = { choices: [{ message: { content: '# Grok Build\n\nKorrigiert' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }
    else return new Response(JSON.stringify({ error: { message: 'unbekannt' } }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    for (const [provider, model] of [['openai', 'gpt-test'], ['gemini', 'gemini-test'], ['anthropic', 'claude-test'], ['grok', 'grok-4.7']]) {
      const connection = { provider, baseUrl: 'https://evil.example', apiKey: `${provider}-secret`, model }
      assert.equal((await listAiModels({ ...connection, model: '' }))[0].provider, provider)
      const result = await transformWithAi(payload(connection))
      assert.equal(result.provider, provider)
      assert.match(result.markdown, /Korrigiert/u)
    }
    const grokModels = await listAiModels({ provider: 'grok', baseUrl: 'https://evil.example', apiKey: 'grok-secret', model: '' })
    assert.deepEqual(grokModels.map((entry) => entry.key), ['grok-4.7', 'grok-4.5'])
    const grokTransform = cloudRequests.find((entry) => entry.address === 'https://api.x.ai/v1/responses')
    const grokBody = JSON.parse(grokTransform.options.body)
    assert.equal(grokBody.store, false)
    assert.equal(grokBody.model, 'grok-4.7')
    assert.deepEqual(grokBody.input.map((item) => item.role), ['system', 'user'])
    assert.equal(JSON.stringify(grokBody).includes('grok-secret'), false)
    assert.ok(cloudRequests.filter((entry) => entry.address.includes('x.ai')).every((entry) => entry.address.startsWith('https://api.x.ai/')))
    assert.equal(cloudRequests.some((entry) => entry.address.includes('cli-chat-proxy')), false)

    const beforeBuild = cloudRequests.length
    const buildConnection = { provider: 'grok', grokUsage: 'build', baseUrl: 'https://evil.example', apiKey: 'build-access-token', model: 'grok-build' }
    const buildModels = await listAiModels({ ...buildConnection, model: '' })
    assert.deepEqual(buildModels.map((entry) => entry.key), ['grok-build', 'grok-4.7'])
    const buildResult = await transformWithAi(payload(buildConnection))
    assert.match(buildResult.markdown, /Korrigiert/u)
    assert.deepEqual((await listAiModels({ ...buildConnection, apiKey: 'build-empty-token', model: '' })).map((entry) => entry.key), ['grok-build'])
    await assert.rejects(() => listAiModels({ ...buildConnection, apiKey: 'build-denied-token', model: '' }), /abgelaufen/u)
    await assert.rejects(() => listAiModels({ provider: 'grok', grokUsage: 'build', apiKey: '', model: '' }), /Melde dich zuerst bei Grok Build an/u)
    const buildRequests = cloudRequests.slice(beforeBuild)
    assert.ok(buildRequests.length >= 2)
    assert.ok(buildRequests.every((entry) => entry.address.startsWith('https://cli-chat-proxy.grok.com/v1/')))
    assert.equal(buildRequests.some((entry) => entry.address.includes('api.x.ai') || entry.address.includes('evil.example')), false)
    const buildChat = buildRequests.find((entry) => entry.address === 'https://cli-chat-proxy.grok.com/v1/chat/completions')
    const buildChatBody = JSON.parse(buildChat.options.body)
    assert.equal(buildChat.options.headers?.Authorization, 'Bearer build-access-token')
    assert.equal(buildChat.options.headers?.['X-XAI-Token-Auth'], 'xai-grok-cli')
    assert.equal(buildChat.options.headers?.['x-grok-model-override'], 'grok-build')
    assert.deepEqual(buildChatBody.messages.map((item) => item.role), ['system', 'user'])
    assert.equal(buildChatBody.stream, false)
    assert.equal(Object.hasOwn(buildChatBody, 'store'), false)
    assert.equal(Object.hasOwn(buildChatBody, 'temperature'), false)
    assert.equal(JSON.stringify(buildChatBody).includes('build-access-token'), false)
    assert.ok(buildRequests.every((entry) => !entry.address.includes('build-access-token')))
  } finally { global.fetch = nativeFetch }
  assert.ok(cloudRequests.every((entry) => !entry.address.includes('secret')), 'API-Schlüssel dürfen nie in einer URL stehen.')
  assert.ok(cloudRequests.some((entry) => entry.options.headers?.Authorization === 'Bearer openai-secret'))
  assert.ok(cloudRequests.some((entry) => entry.options.headers?.['x-goog-api-key'] === 'gemini-secret'))
  assert.ok(cloudRequests.some((entry) => entry.options.headers?.['x-api-key'] === 'anthropic-secret'))
  assert.ok(cloudRequests.some((entry) => entry.options.headers?.Authorization === 'Bearer grok-secret'))

  const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  const immediate = () => Promise.resolve()
  let polls = 0
  const deviceCalls = []
  const login = createLogin({
    sleep: immediate,
    fetchImpl: async (url, options = {}) => {
      const address = String(url)
      const body = String(options.body ?? '')
      deviceCalls.push({ address, body, headers: options.headers })
      if (address === 'https://auth.x.ai/oauth2/device/code') {
        return jsonResponse({
          device_code: 'device-secret-code',
          user_code: 'ABCD-1234',
          verification_uri: 'https://auth.x.ai/device',
          verification_uri_complete: 'https://auth.x.ai/device?user_code=ABCD-1234',
          expires_in: 600,
          interval: 1,
        })
      }
      if (address === 'https://auth.x.ai/oauth2/token') {
        polls += 1
        if (polls === 1) return jsonResponse({ error: 'authorization_pending' }, 400)
        if (polls === 2) return jsonResponse({ error: 'slow_down' }, 400)
        return jsonResponse({ access_token: 'access-token-value', refresh_token: 'refresh-token-value', expires_in: 3600 })
      }
      return jsonResponse({ error: 'unexpected' }, 404)
    },
  })
  const pending = await login.start()
  assert.equal(pending.status, 'pending')
  assert.equal(pending.userCode, 'ABCD-1234')
  assert.equal(pending.verificationUri, 'https://auth.x.ai/device')
  assert.equal(JSON.stringify(pending).includes('device-secret-code'), false)
  await login.whenSettled()
  const ready = login.status()
  assert.equal(ready.status, 'ready')
  assert.equal(JSON.stringify(ready).includes('access-token-value'), false)
  assert.equal(JSON.stringify(ready).includes('refresh-token-value'), false)
  assert.equal(JSON.stringify(ready).includes('device-secret-code'), false)
  const taken = login.take()
  assert.equal(taken.accessToken, 'access-token-value')
  assert.equal(taken.refreshToken, 'refresh-token-value')
  assert.equal(login.take(), null)
  const deviceBody = new URLSearchParams(deviceCalls[0].body)
  assert.equal(deviceBody.get('client_id'), 'b1a00492-073a-47ea-816f-4c329264a828')
  assert.equal(deviceBody.get('referrer'), 'grok-build')
  assert.match(deviceBody.get('scope'), /grok-cli:access/u)
  assert.equal(deviceBody.get('client_secret'), null)
  assert.equal(deviceCalls[0].headers?.['x-grok-client-surface'], 'ui')
  assert.equal(deviceCalls.some((entry) => entry.address.includes('device-secret-code') || entry.body.includes('client_secret')), false)

  const rejectedLogin = createLogin({
    sleep: immediate,
    fetchImpl: async () => jsonResponse({ device_code: 'device-secret-code', user_code: 'ABCD-1234', verification_uri: 'javascript:alert(1)', expires_in: 600, interval: 1 }),
  })
  await assert.rejects(() => rejectedLogin.start(), /unzulässig/u)
  const foreignLogin = createLogin({
    sleep: immediate,
    fetchImpl: async () => jsonResponse({ device_code: 'device-secret-code', user_code: 'ABCD-1234', verification_uri: 'https://evil.example/device', expires_in: 600, interval: 1 }),
  })
  await assert.rejects(() => foreignLogin.start(), /unzulässig/u)
  const deniedLogin = createLogin({
    sleep: immediate,
    fetchImpl: async (url) => String(url).endsWith('/device/code')
      ? jsonResponse({ device_code: 'device-secret-code', user_code: 'WXYZ-9876', verification_uri: 'https://accounts.x.ai/device', expires_in: 600, interval: 1 })
      : jsonResponse({ error: 'access_denied' }, 400),
  })
  await deniedLogin.start()
  assert.equal(await deniedLogin.whenSettled(), null)
  assert.match(deniedLogin.status().error, /abgelehnt/u)
  assert.equal(JSON.stringify(deniedLogin.status()).includes('device-secret-code'), false)

  let refreshCalls = 0
  const refreshFetch = async (url, options = {}) => {
    refreshCalls += 1
    const body = new URLSearchParams(String(options.body ?? ''))
    assert.equal(String(url), 'https://auth.x.ai/oauth2/token')
    assert.equal(body.get('grant_type'), 'refresh_token')
    assert.equal(body.get('refresh_token'), 'refresh-token-old')
    assert.equal(body.get('client_id'), 'b1a00492-073a-47ea-816f-4c329264a828')
    assert.equal(body.get('client_secret'), null)
    assert.equal(String(options.body).includes('access-token-value'), false)
    return jsonResponse({ access_token: 'access-token-new', refresh_token: 'refresh-token-new', expires_in: 3600 })
  }
  const fresh = await refreshSession({ accessToken: 'access-token-value', refreshToken: 'refresh-token-value', expiresAt: Date.now() + 60 * 60 * 1000 }, refreshFetch)
  assert.equal(fresh.rotated, false)
  assert.equal(fresh.accessToken, 'access-token-value')
  assert.equal(refreshCalls, 0)
  const rotated = await refreshSession({ accessToken: 'access-token-value', refreshToken: 'refresh-token-old', expiresAt: Date.now() + 60 * 1000 }, refreshFetch)
  assert.equal(rotated.rotated, true)
  assert.equal(rotated.accessToken, 'access-token-new')
  assert.equal(rotated.refreshToken, 'refresh-token-new')
  assert.equal(refreshCalls, 1)

  const root = path.resolve(__dirname, '..')
  const [panel, app, browserApi, browserProvider, main, proxy] = await Promise.all([
    fs.readFile(path.join(root, 'src/components/AiPanel.tsx'), 'utf8'),
    fs.readFile(path.join(root, 'src/App.tsx'), 'utf8'),
    fs.readFile(path.join(root, 'src/lib/browserApi.ts'), 'utf8'),
    fs.readFile(path.join(root, 'src/lib/aiProviderBrowser.ts'), 'utf8'),
    fs.readFile(path.join(root, 'electron/main.cjs'), 'utf8'),
    fs.readFile(path.resolve(root, '..', 'fanotes-site/ai-proxy.mjs'), 'utf8'),
  ])
  for (const name of ['LM Studio', 'Ollama', 'OpenAI', 'Gemini', 'Anthropic', 'Grok', 'OpenCode']) assert.match(panel, new RegExp(name, 'u'))
  assert.match(panel, /Bei Grok Build anmelden/u)
  assert.match(panel, /Grok Build ist verbunden/u)
  assert.match(panel, /grokUsage === 'build' \? 'Abo' : 'API'/u)
  assert.match(app, /\{hasConnectedAiProvider\(settings\) && \([\s\S]*?aria-label="AI-Assistent öffnen"[\s\S]*?<span>AI<\/span><\/button>/u)
  for (const key of ['ollamaApiToken', 'openAiApiKey', 'geminiApiKey', 'anthropicApiKey', 'grokApiKey', 'grokBuildAccessToken', 'grokBuildRefreshToken', 'openCodePassword']) assert.match(browserApi, new RegExp(`delete safeSettings\\.${key}`, 'u'))
  assert.match(browserProvider, /connection\.grokUsage === 'build'/u)
  assert.match(browserProvider, /Desktop-App/u)
  assert.match(main, /safeStorage\.encryptString/u)
  assert.match(main, /'grokApiKey'/)
  assert.match(main, /'grokBuildAccessToken'/)
  assert.match(main, /'grokBuildRefreshToken'/)
  assert.match(main, /fanotes:grok-build/u)
  assert.match(proxy, /new Set\(\['openai', 'gemini', 'anthropic', 'grok'\]\)/u)
  assert.match(proxy, /https:\/\/api\.x\.ai\/v1\/responses/)
  assert.doesNotMatch(proxy, /body\.baseUrl/u)
  assert.doesNotMatch(proxy, /cli-chat-proxy/u)
  console.log('AI-Prüfung erfolgreich: LM Studio, Ollama, OpenAI, Gemini, Anthropic, Grok und OpenCode; Modelllisten, Transformation, Schlüsselschutz, Backup-Ausschluss und OpenCode-Sandbox geprüft.')
})().finally(close).catch((error) => { console.error(error); process.exitCode = 1 })
