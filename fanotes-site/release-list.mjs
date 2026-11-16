import { spawn } from 'node:child_process'

/** Stop a hung release-share read. A cold listing can take a few seconds; this is longer. */
export const RELEASE_SHARE_TIMEOUT_MS = 20_000

const MAX_LIST_BYTES = 1_000_000

// Runs in a child so a hung NAS read can be killed. Node's own readdir keeps a
// libuv thread until the share answers, and an AbortSignal does not stop it.
const RELEASE_SHARE_SCRIPT = `
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
const dir = process.argv[1]
const entries = await readdir(dir, { withFileTypes: true })
const files = []
for (const entry of entries) if (entry.isFile()) files.push(entry.name)
const checksums = await readFile(join(dir, 'SHA256SUMS'), 'utf8')
process.stdout.write(JSON.stringify({ files, checksums }))
`

/**
 * File names and the SHA256SUMS text from a release directory.
 * The directory is an argument, not part of a shell command.
 * A read that outlives the deadline is killed. The promise settles when that
 * child exits, so the caller can keep the in-flight read instead of starting another.
 */
export const readReleaseShare = (dir, {
  spawnImpl = spawn,
  execPath = process.execPath,
  timeoutMs = RELEASE_SHARE_TIMEOUT_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) => new Promise((resolve, reject) => {
  let out = ''
  let settled = false
  let timer = null
  const finish = (error, value) => {
    if (settled) return
    settled = true
    if (timer) clearTimeoutImpl(timer)
    timer = null
    if (error) reject(error)
    else resolve(value)
  }
  let child
  try {
    child = spawnImpl(execPath, ['--input-type=module', '-e', RELEASE_SHARE_SCRIPT, '--', String(dir)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (error) {
    finish(error)
    return
  }
  timer = setTimeoutImpl(() => {
    try { child.kill?.('SIGKILL') } catch { /* already gone */ }
  }, timeoutMs)
  timer.unref?.()
  child.stdout?.on?.('data', (chunk) => {
    out += chunk
    if (out.length > MAX_LIST_BYTES) {
      try { child.kill?.('SIGKILL') } catch { /* already gone */ }
    }
  })
  child.on?.('error', (error) => finish(error))
  child.on?.('exit', (code) => {
    if (code !== 0) {
      finish(Object.assign(new Error('release list failed'), { code: 'ELIST' }))
      return
    }
    try {
      const parsed = JSON.parse(out)
      if (!parsed || !Array.isArray(parsed.files) || typeof parsed.checksums !== 'string' || parsed.files.some((name) => typeof name !== 'string')) {
        throw new Error('bad')
      }
      finish(null, { files: parsed.files, checksums: parsed.checksums })
    } catch {
      finish(Object.assign(new Error('release list failed'), { code: 'ELIST' }))
    }
  })
})
