import { execFile } from 'node:child_process'

// Run a command to completion. Never rejects; returns {code, stdout, stderr}.
export function run(cmd, args, { cwd, env, timeoutMs = 120_000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
    if (input !== undefined) child.stdin.end(input)
  })
}
