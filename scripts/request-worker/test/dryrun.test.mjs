import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config.mjs'
import { createApi } from '../api.mjs'
import { createLogger } from '../log.mjs'
import { Worker } from '../worker.mjs'
import { loadJobs } from '../state.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const TOKEN = 'test-token-123456'

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' })
}

async function fakeServer({ onWaiting }) {
  const rec = { events: [], statuses: [], queue: [], control: { status: 'working', messages: [] }, badAuth: 0 }
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { rec.badAuth++; res.writeHead(401); return res.end() }
      const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
      const j = body ? JSON.parse(body) : {}
      const m = req.url.split('?')[0].replace('/api/v1/worker', '')
      if (m === '/claim') return send({ request: rec.queue.shift() || null, busy: false })
      if (/\/attachments\/(screenshot|logs)$/.test(m)) { res.writeHead(200); return res.end(Buffer.from('PNGDATA')) }
      if (/\/events$/.test(m)) { rec.events.push(j); return send({ ok: true }) }
      if (/\/status$/.test(m)) {
        rec.statuses.push(j)
        if (j.status === 'waiting_for_you') onWaiting?.(rec)
        return send({ ok: true })
      }
      if (/\/messages$/.test(m)) return send(rec.control)
      res.writeHead(404); res.end()
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { rec, origin: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }
}

async function setup(t, { onWaiting, env = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-dry-'))
  const origin = path.join(tmp, 'origin.git')
  const repo = path.join(tmp, 'repo')
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin)
  git(tmp, 'clone', '-q', origin, repo)
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init'); git(repo, 'branch', '-M', 'main'); git(repo, 'push', '-q', 'origin', 'main')
  const server = await fakeServer({ onWaiting })
  const claudeLog = path.join(tmp, 'claude.log')
  const ghLog = path.join(tmp, 'gh.log')
  Object.assign(process.env, { FAKE_CLAUDE_LOG: claudeLog, FAKE_GH_LOG: ghLog, FAKE_SCENARIO: 'ok', FAKE_GH_CI: 'pass', ...env })
  const rules = path.join(tmp, 'RULES.md'); fs.writeFileSync(rules, '# fake rules\n')
  const config = {
    ...loadConfig({ FANOTES_SERVER_ORIGIN: server.origin, FANOTES_AGENT_TOKEN: TOKEN, FANOTES_REPO_PATH: repo, FANOTES_WORKTREE_ROOT: path.join(tmp, 'wt'), FANOTES_RULES_PATH: rules, FANOTES_CLAUDE_BIN: path.join(here, 'fake/claude.mjs'), FANOTES_GH_BIN: path.join(here, 'fake/gh.mjs'), FANOTES_UPSTREAM_GIT: path.join(tmp, 'none') }),
    dryRun: true, once: true, pollIdleMs: 10, pollWaitMs: 30, throttleMs: 0,
  }
  const logs = []
  const log = createLogger([TOKEN], (l) => logs.push(l))
  const makeWorker = () => new Worker({ config, api: createApi({ origin: config.origin, token: TOKEN }), log, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) })
  const worker = makeWorker()
  t.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }) })
  const readLog = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [])
  return { tmp, repo, config, server, worker, makeWorker, logs, claudeRuns: () => readLog(claudeLog).map((l) => JSON.parse(l)), ghLog: () => readLog(ghLog) }
}

const REQ = { id: 'req1', type: 'bug', title: 'Absturz', description: 'Beim Öffnen', priority: 'normal', status: 'picked', screenshot: 'image/png', hasLogs: true }

test('happy path: claim -> pr_open -> waiting_for_you -> approve -> merged', async (t) => {
  const s = await setup(t, { onWaiting: (rec) => { rec.control = { status: 'waiting_for_you', approved: true, cancelled: false, messages: [] } } })
  s.server.rec.queue.push({ ...REQ })
  await s.worker.loop()
  const statuses = s.server.rec.statuses.map((x) => x.status)
  assert.deepEqual(statuses.filter((v, i, a) => a.indexOf(v) === i), ['working', 'pr_open', 'waiting_for_you', 'merged'])
  assert.equal(s.server.rec.statuses.find((x) => x.status === 'pr_open').prNumber, 4242)
  assert.equal(s.server.rec.statuses.find((x) => x.status === 'waiting_for_you').ci, 'success')
  assert.equal(s.server.rec.statuses.at(-1).prNumber, 4242)
  const texts = s.server.rec.events.map((e) => e.text)
  assert.ok(texts.includes('Liest App.tsx'), texts.join('|'))
  assert.ok(texts.includes('Führt Tests aus'))
  assert.ok(texts.includes('Erstellt PR #4242'))
  assert.deepEqual(s.ghLog(), ['pr merge 4242 --merge'])
  const run = s.claudeRuns()[0]
  assert.equal(run.hasToken, false, 'token must not reach claude')
  assert.ok(run.args.includes('stream-json') && run.args.includes('--verbose'))
  assert.ok(run.prompt.includes('Absturz') && run.prompt.includes('# fake rules') && run.prompt.includes('screenshot.png') && run.prompt.includes('logs.txt'))
  assert.ok(run.cwd.endsWith(path.join('wt', 'req1')) || run.cwd.includes('req1'))
  assert.equal(s.server.rec.badAuth, 0)
  assert.deepEqual(loadJobs(s.config.stateFile), {})
  assert.ok(!fs.existsSync(path.join(s.config.worktreeRoot, 'req1')), 'worktree cleaned up')
  assert.ok(!s.logs.join('\n').includes(TOKEN))
})

test('owner cancel while claude is running kills it; nothing is posted after working', async (t) => {
  const s = await setup(t, { env: { FAKE_SCENARIO: 'hang' } })
  s.server.rec.queue.push({ ...REQ })
  setTimeout(() => { s.server.rec.control = { status: 'rejected', cancelled: true, messages: [] } }, 150)
  await s.worker.loop()
  assert.deepEqual(s.server.rec.statuses.map((x) => x.status), ['working'])
  assert.equal(s.ghLog().length, 0)
  assert.ok(!fs.existsSync(path.join(s.config.worktreeRoot, 'req1')))
})

test('no PR created -> failed', async (t) => {
  const s = await setup(t, { env: { FAKE_SCENARIO: 'nopr' } })
  s.server.rec.queue.push({ ...REQ })
  await s.worker.loop()
  assert.equal(s.server.rec.statuses.at(-1).status, 'failed')
  assert.match(s.server.rec.statuses.at(-1).reason, /keinen Pull Request/)
})

test('follow-up while waiting resumes the session, then merges', async (t) => {
  let n = 0
  const s = await setup(t, { onWaiting: (rec) => {
    n++
    rec.control = n === 1 ? { status: 'waiting_for_you', approved: false, messages: [{ seq: 7, text: 'Bitte auch Dark Mode' }] } : { status: 'waiting_for_you', approved: true, messages: [{ seq: 7, text: 'Bitte auch Dark Mode' }] }
  } })
  s.server.rec.queue.push({ ...REQ })
  await s.worker.loop()
  const runs = s.claudeRuns()
  assert.equal(runs.length, 2)
  assert.ok(runs[1].args.includes('--resume') && runs[1].args.includes('sess-1'))
  assert.ok(runs[1].prompt.includes('Dark Mode'))
  assert.equal(s.server.rec.statuses.at(-1).status, 'merged')
  assert.deepEqual(s.server.rec.statuses.map((x) => x.status), ['working', 'pr_open', 'waiting_for_you', 'working', 'pr_open', 'waiting_for_you', 'merged'])
})

test('red CI is not merged after limited fix attempts', async (t) => {
  const s = await setup(t, { env: { FAKE_GH_CI: 'fail' } })
  s.server.rec.queue.push({ ...REQ })
  await s.worker.loop()
  assert.equal(s.server.rec.statuses.at(-1).status, 'failed')
  assert.match(s.server.rec.statuses.at(-1).reason, /CI fehlgeschlagen/)
  assert.equal(s.ghLog().length, 0)
  assert.equal(s.claudeRuns().length, 3) // initial + 2 fixes
})

test('crash recovery: persisted running job resumes the session', async (t) => {
  const s = await setup(t, { onWaiting: (rec) => { rec.control = { status: 'waiting_for_you', approved: true, messages: [] } } })
  const { createWorktree } = await import('../worktree.mjs')
  await createWorktree(s.config, 'req1')
  fs.mkdirSync(path.dirname(s.config.stateFile), { recursive: true })
  fs.writeFileSync(s.config.stateFile, JSON.stringify({ jobs: { req1: { phase: 'running', requestId: 'req1', request: REQ, startedAt: Date.now(), seen: [], pending: [], ciFixes: 0, sessionId: 'sess-0' } } }))
  await s.makeWorker().loop()
  const run = s.claudeRuns()[0]
  assert.ok(run.args.includes('--resume') && run.args.includes('sess-0'))
  assert.equal(s.server.rec.statuses.at(-1).status, 'merged')
})
