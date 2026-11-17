import test from 'node:test'
import assert from 'node:assert/strict'
import { mapStreamEvent, describeBash, describeTool, estimatePercent, createThrottle, findPrUrl } from '../progress.mjs'

const tool = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })

test('init event yields session and start line', () => {
  const out = mapStreamEvent({ type: 'system', subtype: 'init', session_id: 's1' })
  assert.deepEqual(out[0], { kind: 'session', id: 's1' })
  assert.equal(out[1].text, 'Claude startet')
})

test('tool uses map to German lines', () => {
  assert.equal(mapStreamEvent(tool('Read', { file_path: '/x/src/App.tsx' }))[0].text, 'Liest App.tsx')
  assert.equal(mapStreamEvent(tool('Edit', { file_path: '/x/a/B.ts' }))[0].text, 'Bearbeitet B.ts')
  assert.equal(mapStreamEvent(tool('Write', { file_path: '/x/c.md' }))[0].text, 'Schreibt c.md')
  assert.equal(mapStreamEvent(tool('Grep', { pattern: 'x' }))[0].text, 'Durchsucht den Code')
})

test('bash commands are classified', () => {
  assert.equal(describeBash('node --test a.mjs').text, 'Führt Tests aus')
  assert.equal(describeBash('npx tsc -p tsconfig.app.json --noEmit').text, 'Prüft Typen (tsc)')
  assert.match(describeBash('./gradlew :core:test').text, /Android-Tests/)
  assert.equal(describeBash('git commit -m x').text, 'Committet Änderungen')
  assert.equal(describeBash('gh pr create --title t').text, 'Erstellt Pull Request')
  assert.match(describeBash('echo hello world').text, /^Führt aus: echo hello/)
  assert.equal(describeTool('Mystery').text, 'Nutzt Mystery')
})

test('PR url in tool result yields pr item and line', () => {
  const ev = { type: 'user', message: { content: [{ type: 'tool_result', content: 'https://github.com/Nikoheld/FaNotes/pull/1234\n' }] } }
  const out = mapStreamEvent(ev)
  assert.deepEqual(out[0], { kind: 'pr', url: 'https://github.com/Nikoheld/FaNotes/pull/1234', number: 1234 })
  assert.equal(out[1].text, 'Erstellt PR #1234')
  assert.equal(findPrUrl('none'), null)
})

test('result event', () => {
  const ok = mapStreamEvent({ type: 'result', subtype: 'success', is_error: false, result: 'done https://github.com/a/b/pull/7', session_id: 's' })
  assert.ok(ok.some((i) => i.kind === 'result' && i.ok))
  assert.ok(ok.some((i) => i.kind === 'pr' && i.number === 7))
  const bad = mapStreamEvent({ type: 'result', subtype: 'error_max_turns', is_error: true })
  assert.ok(bad.some((i) => i.kind === 'result' && !i.ok))
  assert.deepEqual(mapStreamEvent(null), [])
  assert.deepEqual(mapStreamEvent({ type: 'rate_limit_event' }), [])
})

test('percent grows monotonically and stays below 86', () => {
  let prev = 0
  for (const n of [0, 1, 5, 20, 80, 500]) { const p = estimatePercent(n); assert.ok(p >= prev && p <= 85); prev = p }
})

test('throttle coalesces plain lines and keeps important ones', () => {
  let t = 0
  const timers = []
  const posted = []
  const th = createThrottle({ minIntervalMs: 1000, post: (p) => posted.push(p), now: () => t, setTimer: (fn) => { timers.push(fn); return timers.length }, clearTimer: () => {} })
  th.push('a') // first goes out immediately
  th.push('b'); th.push('c') // coalesced to c
  th.push('IMP', true)
  assert.deepEqual(posted, ['a'])
  t = 1000; timers.shift()()
  assert.deepEqual(posted, ['a', 'IMP'])
  t = 2000; timers.shift()()
  assert.deepEqual(posted, ['a', 'IMP', 'c'])
  th.push('d'); th.flushNow()
  assert.equal(posted.at(-1), 'd')
})
