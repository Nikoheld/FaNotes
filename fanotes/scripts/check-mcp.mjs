// Grok connector: redirect allowlist, OAuth PKCE, reader step-up, and a
// device-answered tool call. Note text must not be readable without both
// an approved Grok grant and a device that holds the reader key.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const read = (relative) => readFileSync(join(appRoot, relative), 'utf8')
const dataDirectory = mkdtempSync(join(tmpdir(), 'fanotes-mcp-check-'))
const port = 18_900 + Math.floor(Math.random() * 200)
const origin = `http://127.0.0.1:${port}`
process.env.FANOTES_SYNC_DIR = dataDirectory
process.env.FANOTES_MCP_DIR = join(dataDirectory, 'mcp')
process.env.FANOTES_PUBLIC_ORIGIN = origin
process.env.FANOTES_MCP_TOOL_WAIT_MS = '4000'
process.env.FANOTES_MCP_POLL_WAIT_MS = '2000'

const { handleSyncRequest } = await import('../../fanotes-site/sync-api.mjs')
const { handleMcpRequest } = await import('../../fanotes-site/mcp-api.mjs')
const { classifyRedirect, redirectsMatch, notePathAllowed } = await import('../../fanotes-site/mcp-policy.mjs')

const httpServer = createHttpServer(async (request, response) => {
  const url = new URL(request.url, origin)
  if (await handleSyncRequest(request, response, url)) return
  if (await handleMcpRequest(request, response, url)) return
  response.writeHead(404)
  response.end()
})
await new Promise((resolve) => httpServer.listen(port, '127.0.0.1', resolve))

const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const { answerVaultTool, collectVaultNotes } = await vite.ssrLoadModule('/src/lib/mcp/vaultQuery.ts')
const { serializeCalendarMarkdown } = await vite.ssrLoadModule('/src/lib/calendarModel.ts')
const { serializeHomeworkMarkdown } = await vite.ssrLoadModule('/src/lib/homeworkStore.ts')

const b64 = (size) => randomBytes(size).toString('base64')
const readerKey = () => randomBytes(32).toString('base64url')
const authKey = () => b64(32)

const request = async (path, { method = 'GET', body, headers = {}, form = false } = {}) => {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body && !form ? { 'Content-Type': 'application/json' } : {}),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { status: response.status, headers: response.headers, body: parsed, text }
}

const registerAccount = async (email) => {
  const key = authKey()
  const created = await request('/api/v1/sync/register', {
    method: 'POST',
    body: {
      email,
      authKey: key,
      kdf: { algorithm: 'pbkdf2-sha256', iterations: 600_000, salt: b64(16) },
      vaultKeyWrap: { iv: b64(12), data: b64(48) },
      device: { name: 'Check', platform: 'linux' },
    },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return { key, session: created.body }
}

const sessionHeaders = (session, extra = {}) => ({
  Authorization: `Bearer ${session.token}`,
  'X-FaNotes-Account': session.accountId,
  ...extra,
})

assert.equal(classifyRedirect('https://evil.example/callback'), null)
assert.equal(classifyRedirect('https://grok.com/connectors-oauth-exchange-code/').kind, 'grok')
assert.equal(classifyRedirect('http://127.0.0.1.evil.com/callback'), null)
assert.equal(classifyRedirect('http://user:pass@127.0.0.1:9/callback'), null)
assert.equal(redirectsMatch('http://127.0.0.1/callback', 'http://127.0.0.1:43123/callback'), true)
assert.equal(redirectsMatch('http://127.0.0.1/callback', 'http://127.0.0.1:9/admin'), false)
assert.equal(notePathAllowed('../Kalender.md'), false)
assert.equal(notePathAllowed('.fanotes/secrets.md'), false)
assert.equal(notePathAllowed('Mathematik/Analysis.md'), true)

const anonymous = await request('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'initialize' } })
assert.equal(anonymous.status, 401)
assert.match(anonymous.headers.get('www-authenticate') ?? '', /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/u)

const metadata = await request('/.well-known/oauth-authorization-server')
assert.equal(metadata.status, 200)
assert.deepEqual(metadata.body.code_challenge_methods_supported, ['S256'])
assert.deepEqual(metadata.body.token_endpoint_auth_methods_supported, ['none'])
const resource = await request('/.well-known/oauth-protected-resource/mcp')
assert.equal(resource.body.resource, `${origin}/mcp`)

const rejectedClient = await request('/oauth/register', {
  method: 'POST',
  body: { client_name: 'Grok', redirect_uris: ['https://evil.example/steal'], token_endpoint_auth_method: 'none' },
})
assert.equal(rejectedClient.status, 400)
assert.equal(rejectedClient.body.error, 'invalid_redirect_uri')

const secretClient = await request('/oauth/register', {
  method: 'POST',
  body: { client_name: 'Grok', redirect_uris: ['https://grok.com/connectors-oauth-exchange-code/'], token_endpoint_auth_method: 'client_secret_basic' },
})
assert.equal(secretClient.status, 400)

const grok = await request('/oauth/register', {
  method: 'POST',
  body: {
    client_name: 'Grok Build',
    redirect_uris: ['https://grok.com/connectors-oauth-exchange-code/', 'http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  },
})
assert.equal(grok.status, 201)
assert.equal(grok.body.token_endpoint_auth_method, 'none')

const owner = await registerAccount('owner@example.com')
const stranger = await registerAccount('stranger@example.com')
const ownerReader = readerKey()
const strangerReader = readerKey()

const enable = async (account, key, reader) => request('/api/v1/mcp/reader', {
  method: 'POST',
  headers: sessionHeaders(account.session),
  body: { authKey: key, readerKey: reader },
})
assert.equal((await enable(owner, 'wrong-key', ownerReader)).status, 403)
assert.equal((await enable(owner, owner.key, 'short')).status, 400)
assert.equal((await enable(owner, owner.key, ownerReader)).status, 200)
assert.equal((await enable(stranger, stranger.key, strangerReader)).status, 200)

const noReader = await request('/api/v1/mcp/reader/poll', {
  method: 'POST',
  headers: sessionHeaders(owner.session),
  body: {},
})
assert.equal(noReader.status, 401)

const verifier = randomBytes(32).toString('base64url')
const challenge = createHash('sha256').update(verifier).digest('base64url')
const state = 'grok-state-1'
const redirectUri = 'http://127.0.0.1:43123/callback'
const authorizeUrl = `/oauth/authorize?response_type=code&client_id=${grok.body.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&scope=vault:read&resource=${encodeURIComponent(`${origin}/mcp`)}`
const authorize = await request(authorizeUrl)
assert.equal(authorize.status, 200)
assert.match(authorize.text, /Grok darf FaNotes lesen|Allow Grok to read FaNotes/u)
const requestId = /const requestId = "([^"]+)"/u.exec(authorize.text)?.[1]
assert.ok(requestId)

const proof = await request('/api/v1/mcp/consent', {
  method: 'POST',
  body: { requestId, email: 'owner@example.com', authKey: owner.key },
})
assert.equal(proof.status, 200, JSON.stringify(proof.body))
const consentCookie = proof.headers.get('set-cookie') ?? ''
assert.match(consentCookie, /fanotes_mcp_consent=/u)
assert.match(consentCookie, /HttpOnly/u)

const decision = await request('/api/v1/mcp/consent/decision', {
  method: 'POST',
  headers: { Cookie: consentCookie.split(';')[0] },
  body: { requestId, csrf: proof.body.csrf, allow: true },
})
assert.equal(decision.status, 200)
const returned = new URL(decision.body.redirect)
assert.equal(returned.origin, 'http://127.0.0.1:43123')
assert.equal(returned.pathname, '/callback')
assert.equal(returned.searchParams.get('state'), state)
const code = returned.searchParams.get('code')
assert.ok(code)

const badVerifier = await request('/oauth/token', {
  method: 'POST',
  form: true,
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: grok.body.client_id,
    redirect_uri: redirectUri,
    code_verifier: randomBytes(32).toString('base64url'),
    resource: `${origin}/mcp`,
  }).toString(),
})
assert.equal(badVerifier.status, 400)
assert.equal(badVerifier.body.error, 'invalid_grant')

const verifierAgain = randomBytes(32).toString('base64url')
const challengeAgain = createHash('sha256').update(verifierAgain).digest('base64url')
const authorizeAgain = await request(`/oauth/authorize?response_type=code&client_id=${grok.body.client_id}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${challengeAgain}&code_challenge_method=S256&resource=${encodeURIComponent(`${origin}/mcp`)}`)
const requestAgain = /const requestId = "([^"]+)"/u.exec(authorizeAgain.text)?.[1]
const proofAgain = await request('/api/v1/mcp/consent', { method: 'POST', body: { requestId: requestAgain, email: 'owner@example.com', authKey: owner.key } })
const decisionAgain = await request('/api/v1/mcp/consent/decision', {
  method: 'POST',
  headers: { Cookie: (proofAgain.headers.get('set-cookie') ?? '').split(';')[0] },
  body: { requestId: requestAgain, csrf: proofAgain.body.csrf, allow: true },
})
const codeAgain = new URL(decisionAgain.body.redirect).searchParams.get('code')
const token = await request('/oauth/token', {
  method: 'POST',
  form: true,
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: codeAgain,
    client_id: grok.body.client_id,
    redirect_uri: redirectUri,
    code_verifier: verifierAgain,
    resource: `${origin}/mcp`,
  }).toString(),
})
assert.equal(token.status, 200, JSON.stringify(token.body))
assert.equal(token.body.token_type, 'Bearer')
assert.equal(token.body.scope, 'vault:read')
const access = token.body.access_token
const refresh = token.body.refresh_token

const wrongResource = await request('/oauth/token', {
  method: 'POST',
  form: true,
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: grok.body.client_id, resource: 'https://evil.example/mcp' }).toString(),
})
assert.equal(wrongResource.status, 400)
assert.equal(wrongResource.body.error, 'invalid_target')

const callTool = (name, args) => request('/mcp', {
  method: 'POST',
  headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' },
  body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } },
})

const traversal = await callTool('read_note', { path: '../Kalender.md' })
assert.equal(traversal.body.result.isError, true)

const seen = await request('/api/v1/mcp/reader', { headers: { ...sessionHeaders(owner.session), 'X-FaNotes-Reader': ownerReader } })
assert.equal(seen.status, 200)
assert.equal(seen.body.grants.length, 1)

const strangerPoll = request('/api/v1/mcp/reader/poll', {
  method: 'POST',
  headers: { ...sessionHeaders(stranger.session), 'X-FaNotes-Reader': strangerReader },
  body: {},
})
const ownerPoll = request('/api/v1/mcp/reader/poll', {
  method: 'POST',
  headers: { ...sessionHeaders(owner.session), 'X-FaNotes-Reader': ownerReader },
  body: {},
})
const toolPromise = callTool('list_exams', {})
const [ownerJob, strangerJob] = await Promise.all([ownerPoll, strangerPoll])
assert.equal(strangerJob.body.job, null)
assert.equal(ownerJob.body.job.tool, 'list_exams')
const posted = await request('/api/v1/mcp/reader/result', {
  method: 'POST',
  headers: { ...sessionHeaders(owner.session), 'X-FaNotes-Reader': ownerReader },
  body: { id: ownerJob.body.job.id, result: { content: [{ type: 'text', text: '{"exams":[{"title":"Mathe Klausur"}]}' }], isError: false } },
})
assert.equal(posted.status, 200)
const tool = await toolPromise
assert.equal(tool.status, 200)
assert.match(tool.body.result.content[0].text, /Mathe Klausur/u)
assert.equal(tool.body.result.isError, false)

const listed = await request('/mcp', {
  method: 'POST',
  headers: { Authorization: `Bearer ${access}` },
  body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
})
assert.ok(listed.body.result.tools.some((tool) => tool.name === 'list_exams'))
assert.ok(listed.body.result.tools.every((tool) => !/write|delete|update/iu.test(tool.name)))

const rotated = await request('/oauth/token', {
  method: 'POST',
  form: true,
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: grok.body.client_id, resource: `${origin}/mcp` }).toString(),
})
assert.equal(rotated.status, 200)
assert.notEqual(rotated.body.refresh_token, refresh)
const reused = await request('/oauth/token', {
  method: 'POST',
  form: true,
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: grok.body.client_id, resource: `${origin}/mcp` }).toString(),
})
assert.equal(reused.status, 400)
const afterReuse = await request('/mcp', {
  method: 'POST',
  headers: { Authorization: `Bearer ${rotated.body.access_token}` },
  body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
})
assert.equal(afterReuse.status, 401)

const racedReader = readerKey()
const nextKey = authKey()
const [changed, lateEnable] = await Promise.all([
  request('/api/v1/sync/password', {
    method: 'POST',
    headers: sessionHeaders(owner.session),
    body: {
      authKey: owner.key,
      newAuthKey: nextKey,
      kdf: { algorithm: 'pbkdf2-sha256', iterations: 600_000, salt: b64(16) },
      vaultKeyWrap: { iv: b64(12), data: b64(48) },
    },
  }),
  enable(owner, owner.key, racedReader),
])
assert.equal(changed.status, 204, JSON.stringify(changed.body))
assert.ok(lateEnable.status === 200 || lateEnable.status === 403)
const staleReader = await request('/api/v1/mcp/reader/poll', {
  method: 'POST',
  headers: { ...sessionHeaders(owner.session), 'X-FaNotes-Reader': ownerReader },
  body: {},
})
const racedPoll = await request('/api/v1/mcp/reader/poll', {
  method: 'POST',
  headers: { ...sessionHeaders(owner.session), 'X-FaNotes-Reader': racedReader },
  body: {},
})
assert.equal(staleReader.status, 401)
assert.equal(racedPoll.status, 401)
assert.equal((await enable(owner, owner.key, readerKey())).status, 403)

const calendar = serializeCalendarMarkdown({
  version: 1,
  calendars: [{ id: 'school', name: 'Schule', color: '#7f6df2', visible: false }],
  events: [{
    id: 'exam-1', calendarId: 'school', title: 'Mathe Klausur', start: '2026-11-02', end: '2026-11-02', allDay: true,
    location: 'Aula', notes: 'Formeln', notePath: 'Mathematik/Analysis.md', recurrence: 'none', recurrenceUntil: null, exceptionDates: [],
  }],
})
const homework = serializeHomeworkMarkdown({
  version: 1,
  tasks: [{
    id: 'hw-1', title: 'Chemiehausaufgabe', notes: 'Seite 4', subject: 'Chemie', dueDate: '2026-10-20', dueTime: '18:00',
    done: false, kind: 'homework', priority: 'high', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  }],
})
const notes = [
  { path: 'Kalender.md', modifiedAt: '2026-10-01T00:00:00.000Z', markdown: calendar },
  { path: 'Hausaufgaben.md', modifiedAt: '2026-10-01T00:00:00.000Z', markdown: homework },
  { path: 'Mathematik/Analysis.md', modifiedAt: '2026-10-02T00:00:00.000Z', markdown: '# Analysis\n\nKlausur am 02.11.2026 in der Aula.\n\n<!-- fanotes-cards-v1\n{"cards":[{"id":"c1","front":"Was ist eine Ableitung?","back":"Die Steigung","ease":2.5,"intervalDays":1,"due":"2026-10-01","reps":1,"lapses":0}]}\n-->' },
]
const now = new Date(2026, 9, 17)
const exams = JSON.parse(answerVaultTool('list_exams', {}, notes, now).content[0].text)
assert.equal(exams.exams[0].title, 'Mathe Klausur')
assert.equal(exams.exams[0].calendar, 'Schule')
assert.match(exams.mentionedInNotes[0].line, /Klausur am 02\.11\.2026/u)
const tasks = JSON.parse(answerVaultTool('list_homework', {}, notes, now).content[0].text)
assert.equal(tasks.tasks[0].subject, 'Chemie')
const cards = JSON.parse(answerVaultTool('list_flashcards', {}, notes, now).content[0].text)
assert.match(cards.cards[0].front, /Ableitung/u)
const readNote = answerVaultTool('read_note', { path: 'Mathematik/Analysis.md' }, notes, now)
assert.match(readNote.content[0].text, /Analysis/u)
assert.doesNotMatch(readNote.content[0].text, /fanotes-cards-v1/u)
const found = await collectVaultNotes('read_note', { path: 'Mathematik/Analysis.md' }, {
  list: async () => notes.map(({ path, modifiedAt }) => ({ path, modifiedAt })),
  read: async (path) => notes.find((note) => note.path === path)?.markdown ?? '',
})
assert.equal(found.length, 1)

const serverSource = read('../fanotes-site/server.mjs')
assert.match(serverSource, /handleMcpRequest\(request, response, url\)/u)
assert.ok(serverSource.indexOf('handleMcpRequest(request, response, url)') < serverSource.indexOf('Nur GET und HEAD sind erlaubt'))
assert.match(read('../fanotes-site/deploy/fanotes-fasrv.conf'), /location = \/mcp \{[\s\S]*?proxy_buffering off;/u)
const service = read('../fanotes-site/deploy/fanotes-site.service')
assert.match(service, /FANOTES_MCP_DIR=\/var\/lib\/fanotes-mcp/u)
assert.match(service, /ReadWritePaths=\/var\/lib\/fanotes-mcp/u)
assert.match(read('src/components/SyncSettingsSection.tsx'), /settings-grok-connector/u)
assert.match(read('src/App.tsx'), /startMcpBridge/u)
assert.match(read('../fanotes-site/mcp-api.mjs'), /subarray\(32, 64\)/u)

await vite.close()
await new Promise((resolve) => httpServer.close(resolve))
rmSync(dataDirectory, { recursive: true, force: true })
console.log('Grok connector: OAuth, reader step-up and vault tools passed.')
