// Sync-time benchmark: the TypeScript engine with the desktop host
// (electron/sync.cjs on real folders) and the Rust engine (fanotes-sync-bench),
// both against one local sync server. Full sync of a generated vault, then an
// incremental sync after a few edits.
//   node scripts/sync-parity/bench.mjs [--files 2000] [--edits 20] [--runs 3] [--rust-bin path] [--json out.json]
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { startSyncServer } from './server.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..', '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback }
const files = Number(flag('--files', 2000))
const edits = Number(flag('--edits', 20))
const runs = Number(flag('--runs', 3))
const rustBin = flag('--rust-bin', join(process.env.CARGO_TARGET_DIR || join(appRoot, '..', 'target'), 'release', 'fanotes-sync-bench'))

globalThis.window = Object.assign(Object.create(null), { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {}, fanotes: { platform: 'linux' }, location: { origin: 'http://127.0.0.1' } })
const server = await startSyncServer()
const { createServer } = await import('vite')
const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } })
const { SyncEngine } = await vite.ssrLoadModule('/src/lib/sync/engine.ts')
const { SyncApi } = await vite.ssrLoadModule('/src/lib/sync/api.ts')
const { createSyncHost } = createRequire(import.meta.url)('../../electron/sync.cjs')
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (buffer) => buffer.toString('utf8') }
const note = (index, edited) => (edited ? `# Notiz ${index}\n\nGeändert.\n` : `# Notiz ${index}\n\n${'Text '.repeat((index % 40) + 5)}\n`)

const tsRun = async (run) => {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'fanotes-sync-bench-ts-'))
  const make = (name) => {
    const vault = join(root, name, 'vault'); mkdirSync(vault, { recursive: true })
    const engine = new SyncEngine(new SyncApi(server.origin))
    engine.attach(createSyncHost({ vaultRoot: async () => vault, userDataDirectory: join(root, name, 'data'), safeStorage }), { platform: 'linux', deviceName: () => `Bench ${name}`, automatic: () => false })
    return { engine, vault }
  }
  const a = make('a'); const b = make('b')
  for (let index = 0; index < files; index += 1) writeFileSync(join(a.vault, `Notiz ${String(index).padStart(5, '0')}.md`), note(index, false))
  const timed = async (device) => {
    const started = performance.now()
    await device.engine.syncNow('manual')
    const state = device.engine.getState()
    if (state.status !== 'idle') throw new Error(state.error)
    return performance.now() - started
  }
  const quiet = (device) => { if (device.engine.timer !== null) clearTimeout(device.engine.timer); device.engine.timer = null }
  const email = `bench-ts-${process.pid}-${run}@example.com`
  await a.engine.register(email, 'bench passwort fuer den sync 7'); quiet(a)
  const fullUploadMs = await timed(a)
  await b.engine.login(email, 'bench passwort fuer den sync 7'); quiet(b)
  const fullPullMs = await timed(b)
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let index = 0; index < edits; index += 1) writeFileSync(join(a.vault, `Notiz ${String(index).padStart(5, '0')}.md`), note(index, true))
  const incrementalUploadMs = await timed(a)
  const incrementalPullMs = await timed(b)
  const idleMs = await timed(a)
  a.engine.dispose(); b.engine.dispose()
  rmSync(root, { recursive: true, force: true })
  return { engine: 'ts', files, edits, run, fullUploadMs, fullPullMs, incrementalUploadMs, incrementalPullMs, idleMs }
}

const results = []
try {
  for (let run = 0; run < runs; run += 1) { const line = await tsRun(run); results.push(line); console.log(JSON.stringify(line)) }
  // The server runs in this process, so the Rust bench must not block the event loop.
  const rust = await new Promise((resolve, reject) => {
    const child = spawn(rustBin, ['--origin', server.origin, '--files', String(files), '--edits', String(edits), '--runs', String(runs)], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`rust bench exited with ${code}`))))
  })
  for (const line of rust.trim().split('\n')) { results.push(JSON.parse(line)); console.log(line) }
  const median = (values) => { const sorted = [...values].sort((x, y) => x - y); return sorted[Math.floor(sorted.length / 2)] }
  const summary = {}
  for (const engine of ['ts', 'rust']) {
    const rows = results.filter((row) => row.engine === engine)
    summary[engine] = Object.fromEntries(['fullUploadMs', 'fullPullMs', 'incrementalUploadMs', 'incrementalPullMs', 'idleMs'].map((key) => [key, Math.round(median(rows.map((row) => row[key])))]))
  }
  console.log(JSON.stringify({ summary }))
  if (flag('--json')) writeFileSync(flag('--json'), JSON.stringify({ results, summary }, null, 1))
} finally {
  await vite.close(); server.close()
}
process.exit(0)
