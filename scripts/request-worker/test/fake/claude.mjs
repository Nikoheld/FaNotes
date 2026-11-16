#!/usr/bin/env node
// Fake `claude` for dry-run tests. Scenario via FAKE_SCENARIO: ok | hang | nopr
import fs from 'node:fs'
const scenario = process.env.FAKE_SCENARIO || 'ok'
let prompt = ''
process.stdin.setEncoding('utf8')
for await (const c of process.stdin) prompt += c
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), hasToken: 'FANOTES_AGENT_TOKEN' in process.env, prompt }) + '\n')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const tool = (name, input) => out({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
out({ type: 'system', subtype: 'init', session_id: 'sess-1' })
tool('Read', { file_path: '/x/App.tsx' })
if (scenario === 'hang') { setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(143)) }
else {
  tool('Bash', { command: 'node --test x' })
  if (scenario === 'ok') {
    tool('Bash', { command: 'gh pr create --title t' })
    out({ type: 'user', message: { content: [{ type: 'tool_result', content: 'https://github.com/Nikoheld/FaNotes/pull/4242' }] } })
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess-1' })
}
