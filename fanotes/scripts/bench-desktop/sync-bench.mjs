#!/usr/bin/env node
// Sync time: a full sync of the generated vault against a LOCAL sync server,
// then an incremental sync after 20 edits.
//
//   node sync-bench.mjs --fixture <vault> [--runs 5] [--engine ts|rust] [--rust-cli <path>]
//                       [--account-limit 1000000] [--out results/sync-ts.json]
//
// Per run: a fresh server (fanotes-site/sync-api.mjs in its own process on
// 127.0.0.1, empty data directory), device A with a copy of the fixture vault,
// device B with an empty vault.
//   full-upload       A's first sync (uploads every file)
//   full-download     B signs in to the same account; its first sync downloads everything
//   incremental-upload   20 notes edited on A, A syncs
//   incremental-download B syncs and receives the 20 edits
//   noop              A syncs again with nothing to do
// B's vault is compared with A's after each download (same paths, same bytes).
//
// Engines:
//   ts    src/lib/sync/engine.ts with the desktop's own host (electron/sync.cjs
//         createSyncHost, no keychain), in this Node process. The renderer↔main
//         IPC hop of the real app is not included.
//   rust  the WP3 bench CLI (crates/fanotes-sync). Contract, one process per call:
//           <cli> register|login --server <origin> --vault <dir> --state <dir> --email <e> --device <name>
//           <cli> sync           --server <origin> --vault <dir> --state <dir>
//         The password comes in the environment variable FANOTES_BENCH_SYNC_PASSWORD.
//         The last stdout line is JSON: {"status":"idle","uploads":n,"downloads":n,"ms":n}
//         ("ms" = the CLI's own time for the cycle; the harness also records wall time).
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAverage, machine, round, summarize } from './lib/stats.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '..', '..')
const args = Object.fromEntries(process.argv.slice(2).flatMap((value, index, values) => (value.startsWith('--') ? [[value.slice(2), values[index + 1]?.startsWith('--') ? 'true' : values[index + 1]]] : [])))
const fixture = path.resolve(args.fixture || '')
if (!args.fixture || !fs.existsSync(fixture)) throw new Error('--fixture <generated vault> is required')
const runs = Math.max(1, Number(args.runs) || 5)
const engineName = args.engine || 'ts'
const accountLimit = args['account-limit'] === undefined ? 1_000_000 : Number(args['account-limit'])
const outFile = path.resolve(args.out || path.join(here, 'results', `sync-${engineName}.json`))
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-sync-bench-'))
const EDITS = 20

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── Local server ────────────────────────────────────────────────────────────

const startServer = async (dataDir) => {
  const port = 18_000 + Math.floor(Math.random() * 2_000)
  const child = spawn(process.execPath, [path.join(here, 'lib', 'sync-server.mjs'), '--port', String(port), '--data', dataDir, ...(accountLimit ? ['--account-limit', String(accountLimit)] : [])], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((resolve, reject) => {
    let buffer = ''
    child.stdout.on('data', (chunk) => { buffer += chunk; if (buffer.includes('ready')) resolve() })
    child.once('exit', (code) => reject(new Error(`sync server exited (${code})`)))
  })
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    stats: async () => (await (await fetch(`${origin}/__bench/requests`)).json()),
    stop: async () => { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)) },
  }
}

// ── Engines ─────────────────────────────────────────────────────────────────

const tsEngine = async () => {
  globalThis.window = Object.assign(Object.create(null), {
    setTimeout: (...values) => setTimeout(...values),
    clearTimeout: (...values) => clearTimeout(...values),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    fanotes: { platform: 'linux' },
    location: { origin: 'http://127.0.0.1' },
  })
  const require = createRequire(path.join(appRoot, 'package.json'))
  const { createServer } = await import(require.resolve('vite'))
  const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
  const { SyncApi } = await vite.ssrLoadModule('/src/lib/sync/api.ts')
  const { SyncEngine } = await vite.ssrLoadModule('/src/lib/sync/engine.ts')
  const { createSyncHost } = require('./electron/sync.cjs')
  const noKeychain = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('no keychain') }, decryptString: () => { throw new Error('no keychain') } }
  return {
    name: 'ts',
    describe: 'src/lib/sync/engine.ts + electron/sync.cjs host, in-process (no IPC hop)',
    async device({ origin, vault, state, name }) {
      const host = createSyncHost({ vaultRoot: async () => vault, userDataDirectory: state, safeStorage: noKeychain })
      const engine = new SyncEngine(new SyncApi(origin))
      engine.attach(host, { platform: 'linux', deviceName: () => name, automatic: () => false, isPathBusy: () => false, excludedPrefixes: () => [], onApplied: () => undefined, onConflict: () => undefined, onSignedOut: () => undefined })
      await engine.start()
      return {
        register: (email, password) => engine.register(email, password),
        login: (email, password) => engine.login(email, password),
        async sync() {
          const started = performance.now()
          await engine.syncNow()
          const ms = performance.now() - started
          const current = engine.getState()
          if (current.status !== 'idle') throw new Error(`ts engine ended in "${current.status}": ${current.error}`)
          return { ms }
        },
        dispose: () => engine.dispose?.(),
      }
    },
    close: () => vite.close(),
  }
}

const rustEngine = async () => {
  const cli = path.resolve(args['rust-cli'] || '')
  if (!args['rust-cli'] || !fs.existsSync(cli)) throw new Error('--engine rust needs --rust-cli <path to the WP3 bench CLI>')
  const call = (verb, flags, password) => new Promise((resolve, reject) => {
    const child = spawn(cli, [verb, ...Object.entries(flags).flatMap(([key, value]) => [`--${key}`, value])], { env: { ...process.env, ...(password ? { FANOTES_BENCH_SYNC_PASSWORD: password } : {}) }, stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.once('exit', (code) => {
      const last = output.trim().split('\n').at(-1) || '{}'
      let parsed
      try { parsed = JSON.parse(last) } catch { parsed = {} }
      if (code !== 0 || (verb === 'sync' && parsed.status !== 'idle')) reject(new Error(`rust CLI ${verb} failed (${code}): ${last.slice(0, 200)}`))
      else resolve(parsed)
    })
  })
  return {
    name: 'rust',
    describe: `WP3 bench CLI ${cli} (one process per sync)`,
    async device({ origin, vault, state, name }) {
      const base = { server: origin, vault, state }
      return {
        register: (email, password) => call('register', { ...base, email, device: name }, password),
        login: (email, password) => call('login', { ...base, email, device: name }, password),
        async sync() {
          const started = performance.now()
          const result = await call('sync', base)
          return { ms: performance.now() - started, engineMs: result.ms }
        },
        dispose: () => undefined,
      }
    },
    close: () => undefined,
  }
}

// ── Vault helpers ───────────────────────────────────────────────────────────

const listFiles = (root, prefix = '') => fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
  const relative = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isDirectory()) return listFiles(root, relative)
  return entry.isFile() && !entry.name.endsWith('.tmp') ? [relative] : []
})

/** Digest over the files sync carries (the same filter as electron/sync.cjs: no history/trash/tree-cache). */
const vaultDigest = (root) => {
  const files = listFiles(root).filter((file) => !/^\.fanotes\/(history|trash|tree-cache)\//u.test(file) && !(file.startsWith('.') && !file.startsWith('.fanotes/'))).sort()
  const hash = createHash('sha256')
  for (const file of files) hash.update(`${file}\0`).update(fs.readFileSync(path.join(root, file)))
  return { files: files.length, digest: hash.digest('hex') }
}

const editNotes = (vault, run) => {
  const notes = listFiles(vault).filter((file) => /^Fach-\d+\/Notiz \d+\.md$/u.test(file)).sort()
  const step = Math.floor(notes.length / EDITS)
  const when = new Date()
  for (let index = 0; index < EDITS; index += 1) {
    const target = path.join(vault, notes[index * step])
    fs.appendFileSync(target, `\nBearbeitet im Benchmark (Lauf ${run}, Änderung ${index + 1}).\n`)
    fs.utimesSync(target, when, when)
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

const engine = engineName === 'rust' ? await rustEngine() : await tsEngine()
const fixtureInfo = vaultDigest(fixture)
const results = []
try {
  for (let run = 1; run <= runs; run += 1) {
    const runDir = path.join(work, `run-${run}`)
    const vaultA = path.join(runDir, 'a', 'vault')
    const vaultB = path.join(runDir, 'b', 'vault')
    fs.mkdirSync(path.join(runDir, 'a', 'state'), { recursive: true })
    fs.mkdirSync(path.join(runDir, 'b', 'state'), { recursive: true })
    fs.mkdirSync(vaultB, { recursive: true })
    fs.cpSync(fixture, vaultA, { recursive: true, preserveTimestamps: true })
    const server = await startServer(path.join(runDir, 'server'))
    // Throw-away local account; the password never leaves this process and the local server.
    const email = `bench-${run}-${randomBytes(4).toString('hex')}@example.com`
    const password = randomBytes(18).toString('base64url')
    const a = await engine.device({ origin: server.origin, vault: vaultA, state: path.join(runDir, 'a', 'state'), name: 'Bench A' })
    const b = await engine.device({ origin: server.origin, vault: vaultB, state: path.join(runDir, 'b', 'state'), name: 'Bench B' })
    const phases = {}
    const measure = async (name, device) => {
      const loadBefore = loadAverage()
      const before = await server.stats()
      const cpuBefore = process.cpuUsage()
      const result = await device.sync()
      const cpu = process.cpuUsage(cpuBefore)
      const after = await server.stats()
      phases[name] = {
        ms: round(result.ms, 1),
        ...(result.engineMs !== undefined ? { engineMs: result.engineMs } : {}),
        requests: after.requests - before.requests,
        clientCpuMs: round((cpu.user + cpu.system) / 1000, 1),
        serverCpuMs: round((after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / 1000, 1),
        load: loadBefore,
      }
    }
    try {
      await a.register(email, password)
      await measure('full-upload', a)
      await b.login(email, password)
      await measure('full-download', b)
      const afterFull = vaultDigest(vaultB)
      const sourceFull = vaultDigest(vaultA)
      if (afterFull.digest !== sourceFull.digest) throw new Error(`run ${run}: B differs from A after the full sync (${afterFull.files} vs ${sourceFull.files} files)`)
      editNotes(vaultA, run)
      await measure('incremental-upload', a)
      await measure('incremental-download', b)
      const afterEdits = vaultDigest(vaultB)
      if (afterEdits.digest !== vaultDigest(vaultA).digest) throw new Error(`run ${run}: B differs from A after the incremental sync`)
      await measure('noop', a)
      phases.verified = { files: afterEdits.files }
    } finally {
      a.dispose()
      b.dispose()
      await server.stop()
    }
    results.push(phases)
    console.log(`run ${run}: ${Object.entries(phases).filter(([key]) => key !== 'verified').map(([key, value]) => `${key} ${value.ms} ms (${value.requests} req)`).join(' · ')} · load ${loadAverage().join(' ')}`)
    fs.rmSync(runDir, { recursive: true, force: true })
    await wait(500)
  }
} finally {
  await engine.close()
  fs.rmSync(work, { recursive: true, force: true })
}

const phaseNames = ['full-upload', 'full-download', 'incremental-upload', 'incremental-download', 'noop']
const summary = Object.fromEntries(phaseNames.map((name) => [name, { ms: summarize(results.map((run) => run[name].ms)), requests: summarize(results.map((run) => run[name].requests)) }]))
const report = {
  metric: 'sync',
  engine: engine.name,
  engineDescription: engine.describe,
  date: new Date().toISOString(),
  machine: machine(),
  fixture: { path: fixture, ...fixtureInfo },
  edits: EDITS,
  server: { module: 'fanotes-site/sync-api.mjs', bind: '127.0.0.1', accountRequestLimitPerMinute: accountLimit || 1200 },
  runs: results,
  summary,
}
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, `${JSON.stringify(report, null, 1)}\n`)
for (const name of phaseNames) console.log(`${name}: median ${round(summary[name].ms.median, 0)} ms (min ${round(summary[name].ms.min, 0)}, max ${round(summary[name].ms.max, 0)}), ${summary[name].requests.median} requests`)
console.log(`wrote ${outFile}`)
