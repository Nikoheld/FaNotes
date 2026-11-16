// Runs `claude -p` headless in a worktree and streams parsed events.
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { mapStreamEvent } from './progress.mjs'

export function buildClaudeArgs(config, { sessionId } = {}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', config.permissionMode, `--allowedTools=${config.allowedTools}`]
  if (config.model) args.push('--model', config.model)
  if (config.maxTurns) args.push('--max-turns', String(config.maxTurns))
  if (sessionId) args.push('--resume', sessionId)
  return args
}

// The prompt goes in via stdin (equivalent to `claude -p "<prompt>"`, but keeps it out of `ps`).
// Returns {child, done}; done resolves {code, signal, timedOut} once the process exits.
export function startClaude(config, { cwd, env, prompt, sessionId, onItem, onLine }) {
  const child = spawn(config.claudeBin, buildClaudeArgs(config, { sessionId }), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)
  const rl = readline.createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    onLine?.(line)
    let ev
    try { ev = JSON.parse(line) } catch { return }
    for (const item of mapStreamEvent(ev)) onItem(item)
  })
  let stderrTail = ''
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000) })
  const done = new Promise((resolve) => {
    child.on('error', (e) => resolve({ code: -1, signal: null, error: e.message, stderrTail }))
    child.on('close', (code, signal) => resolve({ code, signal, stderrTail }))
  })
  const kill = () => {
    if (child.exitCode !== null || child.killed) return
    child.kill('SIGTERM')
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 5000).unref()
  }
  return { child, done, kill }
}
