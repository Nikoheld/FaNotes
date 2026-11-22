// Runs every check listed in scripts/ci-fast-checks.txt one after the other and reports all failures at the end.
//
// These are the checks that need neither a browser, nor Electron, nor a built site, nor the network and finish in a few
// seconds each (source-contract guards, vite `ssrLoadModule` logic checks, pure node checks). They used to run only by
// hand, and by hand they rotted: a refactor renamed a symbol, nobody ran the check, and the next person found a red
// script that guarded nothing. CI runs this runner on every change to the app (see .github/workflows/ink-stable.yml).
//
// Usage: node scripts/run-fast-checks.mjs [name-filter]
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const filter = process.argv[2] ?? ''
const checks = readFileSync(join(here, 'ci-fast-checks.txt'), 'utf8')
  .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && line.includes(filter))

const failures = []
const started = Date.now()
for (const name of checks) {
  const begin = Date.now()
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    join(here, name),
  ], { cwd: appRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, TZ: 'Europe/Zurich' } })
  const seconds = ((Date.now() - begin) / 1000).toFixed(1)
  if (result.status === 0) {
    console.log(`ok    ${name} (${seconds}s)`)
    continue
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n').filter((line) => line.trim()).slice(-25).join('\n')
  console.log(`FAIL  ${name} (${seconds}s)${result.error ? ` ${result.error.message}` : ''}\n${output}\n`)
  failures.push(name)
}
console.log(`\n${checks.length - failures.length}/${checks.length} checks passed in ${((Date.now() - started) / 1000).toFixed(0)}s`)
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`)
  process.exit(1)
}
