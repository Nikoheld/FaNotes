// Runs the worker's api.mjs and the Worker against the REAL server module (fanotes-site/work-requests-api.mjs)
// in-process, with a temp data dir and a fake sync authenticator.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadConfig } from '../config.mjs'
import { createApi } from '../api.mjs'
import { createLogger } from '../log.mjs'
import { Worker } from '../worker.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverModule = pathToFileURL(path.resolve(here, '../../../fanotes-site/work-requests-api.mjs')).href
const TOKEN = 'w'.repeat(40)
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')])
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' })

test('worker against the real work-requests server module', async (t) => {
  const { createWorkRequestsStore, createWorkRequestsHandler } = await import(serverModule)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-int-'))
  const bare = path.join(tmp, 'origin.git')
  const repo = path.join(tmp, 'repo')
  git(tmp, 'init', '-q', '--bare', '-b', 'main', bare)
  git(tmp, 'clone', '-q', bare, repo)
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init'); git(repo, 'branch', '-M', 'main'); git(repo, 'push', '-q', 'origin', 'main')

  const store = createWorkRequestsStore(path.join(tmp, 'data'))
  const handler = createWorkRequestsHandler(store, { env: { FANOTES_REQUEST_OWNERS: 'acc1', FANOTES_AGENT_TOKEN: TOKEN }, authenticate: async () => ({ account: { id: 'acc1' } }) })
  const srv = http.createServer((req, res) => { handler(req, res, new URL(req.url, 'http://x')).then((h) => { if (!h) { res.writeHead(404); res.end() } }) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${srv.address().port}`
  t.after(() => { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

  const owner = async (method, p, body) => {
    const res = await fetch(origin + '/api/v1/requests' + p, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer s', 'x-fanotes-account': 'acc1' }, body: body && JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }
  const created = await owner('POST', '', { type: 'bug', title: 'Crash', description: 'beim Öffnen', screenshot: PNG.toString('base64') })
  assert.equal(created.status, 201)
  const id = created.body.request.id
  await owner('POST', `/${id}/messages`, { text: 'Hinweis vorab' })

  Object.assign(process.env, { FAKE_SCENARIO: 'ok', FAKE_GH_CI: 'pass', FAKE_GH_LOG: path.join(tmp, 'gh.log'), FAKE_CLAUDE_LOG: path.join(tmp, 'claude.log') })
  const rules = path.join(tmp, 'RULES.md'); fs.writeFileSync(rules, '# rules\n')
  const config = {
    ...loadConfig({ FANOTES_SERVER_ORIGIN: origin, FANOTES_AGENT_TOKEN: TOKEN, FANOTES_REPO_PATH: repo, FANOTES_WORKTREE_ROOT: path.join(tmp, 'wt'), FANOTES_RULES_PATH: rules, FANOTES_CLAUDE_BIN: path.join(here, 'fake/claude.mjs'), FANOTES_GH_BIN: path.join(here, 'fake/gh.mjs'), FANOTES_UPSTREAM_GIT: path.join(tmp, 'none') }),
    dryRun: true, once: true, pollIdleMs: 10, pollWaitMs: 30, throttleMs: 0,
  }
  const log = createLogger([TOKEN], () => {})
  const worker = new Worker({ config, api: createApi({ origin, token: TOKEN }), log, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) })
  const done = worker.loop()

  // Owner side: wait until the request waits for approval, check the live record, approve.
  let rec
  for (let i = 0; i < 400; i++) {
    rec = (await owner('GET', `/${id}`)).body.request
    if (rec.status === 'waiting_for_you') break
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.equal(rec.status, 'waiting_for_you')
  assert.equal(rec.pr.number, 4242)
  assert.equal(rec.pr.ci, 'success')
  assert.ok(rec.percent > 0 && rec.step)
  assert.equal((await owner('POST', `/${id}/approve`, {})).status, 200)
  await done

  const final = (await owner('GET', `/${id}`)).body.request
  assert.equal(final.status, 'merged')
  assert.equal(final.percent, 100)
  const events = (await store.readEvents(id)).filter((e) => e.type === 'status').map((e) => e.status)
  assert.deepEqual(events, ['queued', 'picked', 'working', 'pr_open', 'waiting_for_you', 'merged'])
  const run = JSON.parse(fs.readFileSync(path.join(tmp, 'claude.log'), 'utf8').trim().split('\n')[0])
  assert.ok(run.prompt.includes('Hinweis vorab') && run.prompt.includes('screenshot.png'))
  assert.equal(run.hasToken, false)

  // Cancel path against the real server: owner cancel -> rejected, worker posts nothing more.
  const c2 = (await owner('POST', '', { type: 'feature', title: 'Idee', description: 'mehr' })).body.request
  Object.assign(process.env, { FAKE_SCENARIO: 'hang' })
  const w2 = new Worker({ config, api: createApi({ origin, token: TOKEN }), log, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) })
  const d2 = w2.loop()
  for (let i = 0; i < 400; i++) { if ((await owner('GET', `/${c2.id}`)).body.request.status === 'working') break; await new Promise((r) => setTimeout(r, 25)) }
  await new Promise((r) => setTimeout(r, 150))
  assert.equal((await owner('POST', `/${c2.id}/cancel`, {})).status, 200)
  await d2
  assert.equal((await owner('GET', `/${c2.id}`)).body.request.status, 'rejected')
  assert.ok(!fs.existsSync(path.join(config.worktreeRoot, c2.id)))
})
