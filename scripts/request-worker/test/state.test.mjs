import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canTransition, transition, loadJobs, saveJobs, emptyState } from '../state.mjs'
import { loadConfig, childEnv } from '../config.mjs'
import { createLogger } from '../log.mjs'
import { parseControl } from '../api.mjs'
import { buildPrompt } from '../prompt.mjs'
import { buildClaudeArgs } from '../runner.mjs'
import { summarizeChecks } from '../ci.mjs'

test('happy path transitions', () => {
  let s = emptyState()
  for (const p of ['claimed', 'preparing', 'running', 'pr_open', 'waiting', 'merging', 'verifying', 'done']) s = transition(s, p)
  assert.equal(s.phase, 'done')
})

test('follow-up loops and illegal moves', () => {
  assert.ok(canTransition('waiting', 'running'))
  assert.ok(canTransition('pr_open', 'running'))
  assert.ok(canTransition('merging', 'failed'))
  assert.ok(!canTransition('waiting', 'done'))
  assert.ok(!canTransition('running', 'merging'))
  assert.throws(() => transition(emptyState(), 'merging'))
})

test('state file round trip and corrupt file fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-state-'))
  const f = path.join(dir, 'sub', 'state.json')
  assert.deepEqual(loadJobs(f), {})
  saveJobs(f, { r1: { phase: 'running', requestId: 'r1' }, r2: { phase: 'waiting', requestId: 'r2' } })
  assert.deepEqual(Object.keys(loadJobs(f)), ['r1', 'r2'])
  fs.writeFileSync(f, JSON.stringify({ jobs: { r1: { phase: 'bogus' }, r2: { phase: 'done' } } }))
  assert.deepEqual(Object.keys(loadJobs(f)), ['r2'])
  fs.writeFileSync(f, '{oops')
  assert.deepEqual(loadJobs(f), {})
  fs.rmSync(dir, { recursive: true })
})

test('config requires origin and token; child env drops token', () => {
  assert.throws(() => loadConfig({}), /ORIGIN/)
  assert.throws(() => loadConfig({ FANOTES_SERVER_ORIGIN: 'https://x.test' }), /TOKEN/)
  const c = loadConfig({ FANOTES_SERVER_ORIGIN: 'https://x.test/', FANOTES_AGENT_TOKEN: 'sekrit-token' })
  assert.equal(c.origin, 'https://x.test')
  assert.equal(c.budgetMs, 60 * 60_000)
  assert.equal(c.worktreeRoot, '/srv/agents/fanotes/chats/requests')
  process.env.FANOTES_AGENT_TOKEN = 'sekrit-token'
  assert.equal(childEnv(c).FANOTES_AGENT_TOKEN, undefined)
  delete process.env.FANOTES_AGENT_TOKEN
})

test('logger redacts the token', () => {
  const lines = []
  const log = createLogger(['sekrit-token'], (l) => lines.push(l))
  log.info('using sekrit-token now')
  assert.ok(!lines[0].includes('sekrit-token'))
})

test('control parsing (server shape)', () => {
  const c = parseControl({ status: 'waiting_for_you', approved: true, cancelled: false, lastSeq: 9, messages: [{ seq: 4, at: 1, text: 'hi' }, { seq: 5, at: 2, text: '' }] })
  assert.ok(c.approved && !c.cancelled)
  assert.deepEqual(c.messages, [{ id: '4', text: 'hi' }])
  assert.equal(c.lastSeq, 9)
  assert.ok(parseControl({ status: 'rejected', cancelled: true }).cancelled)
  assert.ok(parseControl({ status: 'rejected' }).cancelled)
})

test('prompt contains request, rules and hard rules; resume prompt is short', () => {
  const p = buildPrompt({ request: { id: 'a1', type: 'bug', title: 'Crash', description: 'It crashes' }, rules: 'RULES-TEXT', attachments: [{ path: '.request-scratch/s.png', label: 'image/png' }], messages: [], branch: 'request/a1' })
  for (const needle of ['Crash', 'It crashes', 'RULES-TEXT', 'NEVER merge', 'request/a1', 's.png', 'NOTES.md']) assert.ok(p.includes(needle), needle)
  const r = buildPrompt({ resume: true, messages: [{ text: 'bitte auch dunkel' }] })
  assert.ok(r.includes('bitte auch dunkel') && !r.includes('HARD RULES'))
})

test('claude args', () => {
  const base = { permissionMode: 'acceptEdits', allowedTools: 'Bash,Read', model: '', maxTurns: null }
  const a = buildClaudeArgs(base)
  assert.deepEqual(a.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose'])
  assert.ok(!a.includes('--model') && !a.includes('--resume'))
  const b = buildClaudeArgs({ ...base, model: 'opus', maxTurns: 50 }, { sessionId: 's9' })
  assert.deepEqual(b.slice(-6), ['--model', 'opus', '--max-turns', '50', '--resume', 's9'])
})

test('CI summary', () => {
  assert.equal(summarizeChecks([]).state, 'pending')
  assert.equal(summarizeChecks([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'skipping' }]).state, 'green')
  assert.equal(summarizeChecks([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'pending' }]).state, 'pending')
  assert.deepEqual(summarizeChecks([{ name: 'a', bucket: 'fail' }]), { state: 'red', failed: ['a'] })
})
