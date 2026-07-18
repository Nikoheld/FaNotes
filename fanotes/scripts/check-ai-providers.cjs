'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')
const { listAiModels, normalizeLocalUrl, transformWithAi } = require('../electron/ai-provider.cjs')

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
    else return new Response(JSON.stringify({ error: { message: 'unbekannt' } }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    for (const [provider, model] of [['openai', 'gpt-test'], ['gemini', 'gemini-test'], ['anthropic', 'claude-test']]) {
      const connection = { provider, baseUrl: '', apiKey: `${provider}-secret`, model }
      assert.equal((await listAiModels({ ...connection, model: '' }))[0].provider, provider)
      assert.equal((await transformWithAi(payload(connection))).provider, provider)
    }
  } finally { global.fetch = nativeFetch }
  assert.ok(cloudRequests.every((entry) => !entry.address.includes('secret')), 'API-Schlüssel dürfen nie in einer URL stehen.')
  assert.ok(cloudRequests.some((entry) => entry.options.headers?.Authorization === 'Bearer openai-secret'))
  assert.ok(cloudRequests.some((entry) => entry.options.headers?.['x-goog-api-key'] === 'gemini-secret'))
  assert.ok(cloudRequests.some((entry) => entry.options.headers?.['x-api-key'] === 'anthropic-secret'))

  const root = path.resolve(__dirname, '..')
  const [panel, app, browserApi, main, proxy] = await Promise.all([
    fs.readFile(path.join(root, 'src/components/AiPanel.tsx'), 'utf8'),
    fs.readFile(path.join(root, 'src/App.tsx'), 'utf8'),
    fs.readFile(path.join(root, 'src/lib/browserApi.ts'), 'utf8'),
    fs.readFile(path.join(root, 'electron/main.cjs'), 'utf8'),
    fs.readFile(path.resolve(root, '..', 'fanotes-site/ai-proxy.mjs'), 'utf8'),
  ])
  for (const name of ['LM Studio', 'Ollama', 'OpenAI', 'Gemini', 'Anthropic', 'OpenCode']) assert.match(panel, new RegExp(name, 'u'))
  assert.match(app, /> AI<\/button>/u)
  for (const key of ['ollamaApiToken', 'openAiApiKey', 'geminiApiKey', 'anthropicApiKey', 'openCodePassword']) assert.match(browserApi, new RegExp(`delete safeSettings\\.${key}`, 'u'))
  assert.match(main, /safeStorage\.encryptString/u)
  assert.match(proxy, /new Set\(\['openai', 'gemini', 'anthropic'\]\)/u)
  assert.doesNotMatch(proxy, /body\.baseUrl/u)
  console.log('AI-Prüfung erfolgreich: LM Studio, Ollama, OpenAI, Gemini, Anthropic und OpenCode; Modelllisten, Transformation, Schlüsselschutz, Backup-Ausschluss und OpenCode-Sandbox geprüft.')
})().finally(close).catch((error) => { console.error(error); process.exitCode = 1 })
