// Sync parity harness: runs JSON scenarios against the real sync server module
// (fanotes-site/sync-api.mjs, temporary data directory, throwaway accounts) with
// the TypeScript engine, the Rust engine (fanotes-sync-harness), or both mixed,
// and compares normalised records with the committed ones in expected/.
//
//   node scripts/sync-parity/run.mjs [--engines ts|rust|mixed|all] [--bin path] [--update] [--only name,...]
//
// Never talks to the production server; every account is created here.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createDecipheriv, createHash, createHmac, hkdfSync } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

process.env.TZ = 'UTC'
const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..', '..')
const repoRoot = join(appRoot, '..')
const args = process.argv.slice(2)
const flag = (name, fallback = null) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback }
const modes = (flag('--engines', 'ts') === 'all' ? 'ts,rust,mixed' : flag('--engines', 'ts')).split(',')
const update = args.includes('--update')
const only = flag('--only')?.split(',') ?? null
const quiet = args.includes('--quiet')
const bin = flag('--bin') ?? join(process.env.CARGO_TARGET_DIR || join(repoRoot, 'target'), 'debug', process.platform === 'win32' ? 'fanotes-sync-harness.exe' : 'fanotes-sync-harness')
const SCENARIO_NOW = 1_893_456_000_000 // 2030-01-01, far from the real clock

globalThis.window = Object.assign(Object.create(null), {
  setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a),
  addEventListener: () => undefined, removeEventListener: () => undefined, fanotes: { platform: 'test' }, location: { origin: 'http://127.0.0.1' },
})

// The server's rate limits (per address, per account per minute) would throttle a
// 2,000-file first sync; the local server gets a fresh address per request and its
// clock moves one minute per 1,000 requests. Both engines see the same server.
const realNow = Date.now
let clockOffset = 0
let handled = 0
Date.now = () => realNow() + clockOffset

const dataDirectory = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'fanotes-sync-parity-'))
process.env.FANOTES_SYNC_DIR = dataDirectory
process.env.FANOTES_MCP_DIR = join(dataDirectory, 'mcp')
const PORT = 19_100 + Math.floor(Math.random() * 600)
export const ORIGIN = `http://127.0.0.1:${PORT}`
process.env.FANOTES_PUBLIC_ORIGIN = ORIGIN
const { handleSyncRequest } = await import('../../../fanotes-site/sync-api.mjs')
const origLog = console.log
console.log = (...items) => { if (typeof items[0] === 'string' && items[0].startsWith('{"time"')) return; origLog(...items) }
const origError = console.error
console.error = (...items) => { if (typeof items[0] === 'string' && items[0].startsWith('{"time"')) return; origError(...items) }
const httpServer = createHttpServer(async (request, response) => {
  handled += 1
  if (handled % 1000 === 0) clockOffset += 61_000
  request.headers['x-real-ip'] = `10.0.${Math.floor(handled / 250) % 250}.${handled % 250}`
  const url = new URL(request.url, 'http://localhost')
  if (await handleSyncRequest(request, response, url)) return
  response.writeHead(404); response.end()
})
await new Promise((resolve) => httpServer.listen(PORT, '127.0.0.1', resolve))

const { createServer } = await import('vite')
const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const { SyncEngine } = await vite.ssrLoadModule('/src/lib/sync/engine.ts')
const { SyncApi } = await vite.ssrLoadModule('/src/lib/sync/api.ts')
const famd = await vite.ssrLoadModule('/src/lib/famd.ts')
const homework = await vite.ssrLoadModule('/src/lib/homeworkStore.ts')

const encoder = new TextEncoder()
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

// ── Devices ──────────────────────────────────────────────────────────────

const ruleMatches = (rule, method, path, stage) => rule.count !== 0 && rule.method === method && path.includes(rule.path) && ((rule.mode === 'drop' || rule.mode === 'corrupt') ? 'after' : 'before') === stage

/** The TypeScript engine on the fake host of check-sync.mjs. */
const createTsDevice = (id, name) => {
  const files = new Map()
  let clock = 1_700_000_000_000
  const store = { state: new Map(), secrets: null }
  const settings = { busy: [], excluded: [], now: SCENARIO_NOW, includeHistory: false, includeModel: false }
  const faults = []
  let events = []
  let requests = []
  const host = {
    async vaultId() { return `vault-${id}` },
    async scan() { return [...files.entries()].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtimeMs: file.mtimeMs })) },
    async read(path) { if (!files.has(path)) throw new Error(`missing ${path}`); return files.get(path).bytes },
    async write(path, bytes, mtimeMs) { files.set(path, { bytes: new Uint8Array(bytes), mtimeMs: mtimeMs || (clock += 1000) }); return { path, size: bytes.byteLength, mtimeMs: files.get(path).mtimeMs } },
    async remove(path) { files.delete(path) },
    async readState(vaultId) { return store.state.get(vaultId) ?? null },
    async writeState(vaultId, json) { if (json === null) store.state.delete(vaultId); else store.state.set(vaultId, json) },
    async readSecrets() { return store.secrets },
    async writeSecrets(json) { store.secrets = json },
  }
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input))
    const path = url.pathname.replace('/api/v1/sync', '')
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    headers.set('Accept-Language', 'de-CH,de;q=0.9')
    const before = faults.find((rule) => ruleMatches(rule, method, path, 'before'))
    if (before) {
      before.count -= 1
      if (before.mode === 'offline') { requests.push(`${method} ${path} 0`); throw new TypeError('Failed to fetch') }
      requests.push(`${method} ${path} ${before.status}`)
      return new Response(JSON.stringify({ error: before.message }), { status: before.status, headers: { 'Content-Type': 'application/json' } })
    }
    const response = await fetch(input, { ...init, headers })
    const after = faults.find((rule) => ruleMatches(rule, method, path, 'after'))
    if (after) {
      after.count -= 1
      if (after.mode === 'drop') { await response.arrayBuffer(); requests.push(`${method} ${path} 0`); throw new TypeError('Failed to fetch') }
      const body = new Uint8Array(await response.arrayBuffer())
      if (body.length) body[body.length - 1] ^= 0xff
      requests.push(`${method} ${path} ${response.status}`)
      return new Response(response.status === 204 ? null : body, { status: response.status, headers: response.headers })
    }
    requests.push(`${method} ${path} ${response.status}`)
    return response
  }
  let engine
  const make = () => {
    engine = new SyncEngine(new SyncApi(ORIGIN, fetchImpl))
    const log = engine.log.bind(engine)
    engine.log = (level, text) => { events.push({ log: [level, text] }); log(level, text) }
    engine.attach(host, {
      platform: 'linux', deviceName: () => name, automatic: () => false,
      isPathBusy: (path) => settings.busy.includes(path),
      excludedPrefixes: () => settings.excluded,
      includeHistory: () => settings.includeHistory, includeRecognitionModel: () => settings.includeModel,
      onApplied: (change) => events.push({ applied: change }),
      onConflict: (conflict) => events.push({ conflict: { path: conflict.path, copyPath: conflict.copyPath } }),
      onSignedOut: (reason) => events.push({ signedOut: reason }),
      now: () => settings.now,
    })
  }
  make()
  // The scheduler is the app's job: the sign-in kick (`schedule(0)`) is cancelled
  // so every cycle in a record is one the scenario asked for.
  const quietTimer = () => { if (engine.timer !== null) window.clearTimeout(engine.timer); engine.timer = null }
  return {
    kind: 'ts',
    async handle(command) {
      try {
        switch (command.cmd) {
          case 'register': await engine.register(command.email, command.password); quietTimer(); return { ok: true }
          case 'login': await engine.login(command.email, command.password); quietTimer(); return { ok: true }
          case 'logout': await engine.logout(); return { ok: true }
          case 'restart': engine.dispose(); make(); await engine.start(); quietTimer(); return { ok: true, signedIn: Boolean(engine.getSession()) }
          case 'put': clock += 1000; files.set(command.path, { bytes: new Uint8Array(Buffer.from(command.b64, 'base64')), mtimeMs: clock }); return { ok: true }
          case 'vanish': files.delete(command.path); return { ok: true }
          case 'markDeleted': engine.markDeleted(command.path); await new Promise((resolve) => setTimeout(resolve, 5)); return { ok: true }
          case 'markCleared': engine.markCleared(command.path); return { ok: true }
          case 'settings':
            if (command.busy) settings.busy = command.busy
            if (command.excluded) settings.excluded = command.excluded
            if (typeof command.now === 'number') settings.now = command.now
            if (typeof command.includeHistory === 'boolean') settings.includeHistory = command.includeHistory
            if (typeof command.includeModel === 'boolean') settings.includeModel = command.includeModel
            return { ok: true }
          case 'fault': {
            const rule = { ...command.rule, count: command.rule.count ?? 1 }
            if (rule.file) {
              const secrets = JSON.parse(store.secrets)
              rule.path = `/files/${fileIdOf(keysFrom(secrets.vaultSecret), rule.file)}`
            }
            faults.push(rule)
            return { ok: true }
          }
          case 'clearFaults': faults.length = 0; return { ok: true }
          case 'sync': {
            events = []; requests = []
            const started = performance.now()
            await engine.syncNow('manual')
            const ms = performance.now() - started
            const state = engine.getState()
            const out = { ok: true, status: state.status, error: state.error, events, requests, ms }
            events = []; requests = []
            return out
          }
          case 'dump': return { ok: true, files: [...files.entries()].map(([path, file]) => ({ path, b64: b64(file.bytes), mtimeMs: file.mtimeMs })), state: store.state.get(`vault-${id}`) ?? null, secrets: store.secrets, cleared: [...engine.cleared] }
          case 'load':
            for (const file of command.files) files.set(file.path, { bytes: new Uint8Array(Buffer.from(file.b64, 'base64')), mtimeMs: file.mtimeMs || (clock += 1000) })
            if (command.state) store.state.set(`vault-${id}`, command.state)
            if (command.secrets) store.secrets = command.secrets
            engine.dispose(); make(); await engine.start(); quietTimer()
            for (const path of command.cleared ?? []) engine.markCleared(path)
            events = []
            return { ok: true, signedIn: Boolean(engine.getSession()) }
          default: return { ok: false, error: `unknown ${command.cmd}` }
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    close() { engine.dispose() },
  }
}

/** The Rust engine in a child process. */
const createRustDevice = (id, name) => {
  const child = spawn(bin, [ORIGIN, id, name], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, TZ: 'UTC' } })
  const lines = createInterface({ input: child.stdout })
  const waiting = []
  lines.on('line', (line) => waiting.shift()?.(JSON.parse(line)))
  const send = (command) => new Promise((resolve) => { waiting.push(resolve); child.stdin.write(`${JSON.stringify(command)}\n`) })
  send({ cmd: 'settings', now: SCENARIO_NOW })
  return { kind: 'rust', handle: send, close() { child.stdin.end() } }
}

// ── Keys for the records (the harness reads its own throwaway accounts) ──

const keysFrom = (secretB64) => {
  const secret = Buffer.from(secretB64, 'base64')
  return {
    data: Buffer.from(hkdfSync('sha256', secret, 'fanotes-sync-v1', 'data', 32)),
    id: Buffer.from(hkdfSync('sha256', secret, 'fanotes-sync-v1', 'id', 32)),
  }
}
const fileIdOf = (keys, path) => createHmac('sha256', keys.id).update(path.normalize('NFC'), 'utf8').digest('hex')
const decryptWith = (keys, fileId, blob) => {
  const decipher = createDecipheriv('aes-256-gcm', keys.data, blob.subarray(0, 12))
  decipher.setAAD(Buffer.from(fileId))
  decipher.setAuthTag(blob.subarray(blob.length - 16))
  return Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()])
}

// ── Content builders ───────────────────────────────────────────────────

const pseudoRandom = (size, seed) => {
  const out = new Uint8Array(size)
  let state = (seed * 2654435761) >>> 0 || 1
  for (let index = 0; index < size; index += 1) {
    state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0
    out[index] = state & 0xff
  }
  return out
}

const famdBytes = (spec) => {
  const strokes = Array.from({ length: spec.strokes ?? 0 }, (_, stroke) => ({
    color: '#222', width: 2, points: Array.from({ length: spec.points ?? 20 }, (_, index) => ({ x: (index + stroke) / 100, y: 0.25 + stroke / 1000, pressure: 0.5, t: index * 8 })),
  }))
  const payload = {
    schema: 'fanotes-famd-v1', updatedAt: spec.updatedAt ?? '2029-12-01T00:00:00.000Z',
    ink: strokes.length ? { strokes, updatedAt: spec.updatedAt ?? '2029-12-01T00:00:00.000Z' } : null, worksheets: [],
    ...(spec.pageStats ? { pageStats: { createdAt: '2029-11-01T00:00:00.000Z', modifiedAt: '2029-11-02T00:00:00.000Z', openCount: spec.pageStats, dwellMs: spec.pageStats * 1000 } } : {}),
    ...(spec.textFields ? { textFields: spec.textFields } : {}),
  }
  const parsedStats = payload.pageStats ? famd.parseFamd(famd.serializeFamd('', payload, 'v1')).payload.pageStats : undefined
  return encoder.encode(famd.serializeFamd(spec.markdown ?? '', { ...payload, ...(parsedStats ? { pageStats: parsedStats } : {}) }, spec.encoding ?? 'v1'))
}

const contentOf = (step) => {
  if (typeof step.text === 'string') return encoder.encode(step.text)
  if (typeof step.repeat === 'string') return encoder.encode(step.repeat.repeat(step.times ?? 1))
  if (step.gen) return pseudoRandom(step.gen.bytes, step.gen.seed ?? 1)
  if (step.famd) return famdBytes(step.famd)
  if (step.homework) return encoder.encode(homework.serializeHomeworkMarkdown({ version: 1, tasks: step.homework.map((task) => ({ title: task.id, notes: '', subject: '', dueDate: null, dueTime: null, kind: 'homework', priority: 'normal', createdAt: '2029-10-01T00:00:00.000Z', ...task })) }))
  if (typeof step.b64 === 'string') return Buffer.from(step.b64, 'base64')
  return new Uint8Array()
}

// ── Records ────────────────────────────────────────────────────────────

const sortStrings = (items) => [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const nearNow = (value) => typeof value === 'number' && Math.abs(value - realNow()) < 3 * 86_400_000

const accountOf = (secretsJson) => (secretsJson ? JSON.parse(secretsJson) : null)

const changeLog = (accountId) => {
  try {
    return readFileSync(join(dataDirectory, 'accounts', accountId, 'changes.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch { return [] }
}

const buildRecord = async (scenario, devices, steps) => {
  const dumps = {}
  for (const [name, device] of Object.entries(devices)) dumps[name] = await device.handle({ cmd: 'dump' })
  const secrets = Object.values(dumps).map((dump) => accountOf(dump.secrets)).find(Boolean)
  const keys = secrets ? keysFrom(secrets.vaultSecret) : null
  const log = secrets ? changeLog(secrets.accountId) : []
  const head = log.reduce((max, entry) => Math.max(max, entry.revision), 0)
  const paths = new Set()
  for (const dump of Object.values(dumps)) {
    for (const file of dump.files) paths.add(file.path)
    if (dump.state) for (const path of Object.keys(JSON.parse(dump.state).files ?? {})) paths.add(path)
  }
  const idToPath = new Map()
  if (keys) {
    for (const entry of log) {
      if (!entry.meta) continue
      try { idToPath.set(entry.id, JSON.parse(decryptWith(keys, entry.id, Buffer.from(entry.meta, 'base64')).toString('utf8')).path) } catch { /* not ours */ }
    }
    for (const path of paths) idToPath.set(fileIdOf(keys, path), path)
  }
  const nameOf = (id) => idToPath.get(id) ?? `<unknown ${id.slice(0, 6)}>`
  const ordinal = (id, revision) => log.filter((entry) => entry.id === id && entry.revision <= revision).length
  const mapRequest = (line) => line.replace(/\/files\/([a-f0-9]{64})/u, (_, id) => `/files/${nameOf(id)}`)
  const server = {}
  const latest = new Map()
  for (const entry of log) latest.set(entry.id, entry)
  for (const [id, entry] of latest) {
    let plainSha = null
    if (!entry.deleted && keys) {
      try { plainSha = JSON.parse(decryptWith(keys, id, Buffer.from(entry.meta, 'base64')).toString('utf8')).sha256 } catch { plainSha = '<undecryptable>' }
    }
    server[nameOf(id)] = { deleted: Boolean(entry.deleted), sha256: plainSha, revisions: log.filter((item) => item.id === id).length }
  }
  const deviceRecords = {}
  for (const [name, dump] of Object.entries(dumps)) {
    const files = Object.fromEntries(sortStrings(dump.files.map((file) => file.path)).map((path) => {
      const bytes = Buffer.from(dump.files.find((file) => file.path === path).b64, 'base64')
      return [path, { sha256: sha(bytes), size: bytes.length }]
    }))
    let state = null
    if (dump.state) {
      const parsed = JSON.parse(dump.state)
      state = {
        cursorLag: head - parsed.cursor,
        lastSyncAt: parsed.lastSyncAt,
        files: Object.fromEntries(sortStrings(Object.keys(parsed.files)).map((path) => {
          const base = parsed.files[path]
          return [path, {
            idMatchesPath: keys ? base.id === fileIdOf(keys, path) : null,
            revision: ordinal(base.id, base.revision), sha256: base.sha256, size: base.size,
            mtimeMs: nearNow(base.mtimeMs) ? '<now>' : base.mtimeMs,
            contentSha256: base.contentSha256 ?? null, blank: base.blank === true,
          }]
        })),
        conflicts: sortStrings(parsed.conflicts.map((conflict) => `${conflict.path} -> ${conflict.copyPath}`)),
        pendingDeletes: parsed.pendingDeletes,
        skipped: sortStrings(parsed.skipped.map((entry) => `${nameOf(entry.id)}@${ordinal(entry.id, entry.revision)}${entry.deleted ? ' deleted' : ''}`)),
      }
    }
    deviceRecords[name] = { signedIn: Boolean(dump.secrets), cleared: sortStrings(dump.cleared ?? []), files, state }
  }
  const stepRecords = steps.map((step) => {
    if (step.do !== 'sync') return step.result ? { do: step.do, device: step.device, ok: step.result.ok, ...(step.result.ok ? {} : { error: step.result.error }) } : { do: step.do }
    const result = step.result
    const written = new Set(); const removed = new Set(); const conflicts = []; const logs = []; let signedOut = 0
    for (const event of result.events ?? []) {
      if (event.applied) { for (const path of event.applied.written) written.add(path); for (const path of event.applied.removed) removed.add(path) }
      if (event.conflict) conflicts.push(`${event.conflict.path} -> ${event.conflict.copyPath}`)
      if (event.log) logs.push(`${event.log[0]}: ${event.log[1]}`)
      if (event.signedOut) signedOut += 1
    }
    return {
      do: 'sync', device: step.device, ok: result.ok, status: result.status, error: result.error ?? null,
      written: sortStrings(written), removed: sortStrings(removed), conflicts: sortStrings(conflicts), logs: sortStrings(logs), signedOut,
      requests: sortStrings((result.requests ?? []).map(mapRequest)),
    }
  })
  // Long lists (the 2,000-file scenario) are kept as a count and a hash so the committed records stay small.
  const compact = (value) => {
    if (Array.isArray(value)) return value.length > 60 ? { count: value.length, sha256: sha(JSON.stringify(value)) } : value.map(compact)
    if (value && typeof value === 'object') {
      const keys = Object.keys(value)
      if (keys.length > 60) return { count: keys.length, sha256: sha(JSON.stringify(value)) }
      return Object.fromEntries(keys.map((key) => [key, compact(value[key])]))
    }
    return value
  }
  const full = { scenario: scenario.name, steps: stepRecords, devices: deviceRecords, server: Object.fromEntries(sortStrings(Object.keys(server)).map((path) => [path, server[path]])) }
  return { full, compacted: compact(full) }
}

// ── Runner ─────────────────────────────────────────────────────────────

let accountCounter = 0
const runScenario = async (scenario, mode) => {
  const runId = `${scenario.name}-${mode}-${(accountCounter += 1)}`
  const email = `parity-${createHash('sha256').update(`${runId}-${realNow()}`).digest('hex').slice(0, 12)}@example.com`
  const password = 'parity passwort fuer den sync 7'
  const devices = {}
  const kindFor = (index) => (mode === 'ts' ? 'ts' : mode === 'rust' ? 'rust' : index % 2 === 0 ? 'ts' : 'rust')
  scenario.devices.forEach((name, index) => { devices[name] = (kindFor(index) === 'ts' ? createTsDevice : createRustDevice)(`${name.toLowerCase()}-${accountCounter}`, name) })
  const steps = []
  const timings = []
  try {
    for (const raw of scenario.steps) {
      const step = { ...raw }
      const device = devices[step.device]
      const repeat = step.do === 'bulk' || step.do === 'edit-bulk' ? step.count : 1
      if (step.do === 'switch') {
        const dump = await device.handle({ cmd: 'dump' })
        device.close()
        const next = (device.kind === 'ts' ? createRustDevice : createTsDevice)(`${step.device.toLowerCase()}-${accountCounter}-s${steps.length}`, step.device)
        await next.handle({ cmd: 'settings', now: SCENARIO_NOW })
        step.result = await next.handle({ cmd: 'load', files: dump.files, state: dump.state, secrets: dump.secrets, cleared: dump.cleared })
        devices[step.device] = next
        steps.push(step)
        continue
      }
      for (let index = 0; index < repeat; index += 1) {
        let command
        switch (step.do) {
          case 'register': command = { cmd: 'register', email, password: step.password ?? password }; break
          case 'login': command = { cmd: 'login', email, password: step.password ?? password }; break
          case 'put': command = { cmd: 'put', path: step.path, b64: b64(contentOf(step)) }; break
          case 'bulk': command = { cmd: 'put', path: `${step.prefix}${String(index).padStart(5, '0')}.md`, b64: b64(encoder.encode(`# Notiz ${index}\n\n${'Text '.repeat((index % 40) + 5)}\n`)) }; break
          case 'edit-bulk': command = { cmd: 'put', path: `${step.prefix}${String(index).padStart(5, '0')}.md`, b64: b64(encoder.encode(`# Notiz ${index}\n\nGeändert.\n`)) }; break
          case 'vanish': command = { cmd: 'vanish', path: step.path }; break
          case 'delete': await device.handle({ cmd: 'vanish', path: step.path }); command = { cmd: 'markDeleted', path: step.path }; break
          case 'rename': {
            const dump = await device.handle({ cmd: 'dump' })
            const file = dump.files.find((item) => item.path === step.path)
            await device.handle({ cmd: 'vanish', path: step.path })
            await device.handle({ cmd: 'put', path: step.to, b64: file.b64 })
            command = { cmd: 'markDeleted', path: step.path }
            break
          }
          case 'markDeleted': case 'markCleared': command = { cmd: step.do, path: step.path }; break
          case 'settings': command = { cmd: 'settings', ...step.set }; break
          case 'fault': command = { cmd: 'fault', rule: step.rule }; break
          case 'clearFaults': command = { cmd: 'clearFaults' }; break
          case 'sync': command = { cmd: 'sync' }; break
          case 'restart': command = { cmd: 'restart' }; break
          case 'logout': command = { cmd: 'logout' }; break
          default: throw new Error(`unknown step ${step.do}`)
        }
        step.result = await device.handle(command)
      }
      if (step.do === 'bulk' || step.do === 'edit-bulk') step.do = `${step.do} ${step.count}`
      if (step.do === 'sync') timings.push({ device: step.device, engine: device.kind, ms: step.result.ms, label: raw.label ?? null })
      steps.push(step)
    }
    const built = await buildRecord(scenario, devices, steps)
    return { record: built.compacted, full: built.full, timings }
  } finally {
    for (const device of Object.values(devices)) device.close()
  }
}

const describeDiff = (left, right, path = '') => {
  if (JSON.stringify(left) === JSON.stringify(right)) return null
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const found = describeDiff(left[key], right[key], `${path}/${key}`)
      if (found) return found
    }
  }
  return `${path}: ${JSON.stringify(left)?.slice(0, 300)} != ${JSON.stringify(right)?.slice(0, 300)}`
}

export const runAll = async () => {
  const scenarioDirectory = join(here, 'scenarios')
  const expectedDirectory = join(here, 'expected')
  mkdirSync(expectedDirectory, { recursive: true })
  const names = sortStrings(readdirSync(scenarioDirectory).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))).filter((name) => !only || only.includes(name))
  const failures = []
  const allTimings = {}
  for (const name of names) {
    const scenario = { name, ...JSON.parse(readFileSync(join(scenarioDirectory, `${name}.json`), 'utf8')) }
    const expectedPath = join(expectedDirectory, `${name}.json`)
    for (const mode of modes) {
      const { record, full, timings } = await runScenario(scenario, mode)
      allTimings[`${name}/${mode}`] = timings
      for (const check of scenario.expect ?? []) {
        const device = full.devices[check.device]
        const actual = check.server ? full.server[check.path] : check.state ? device?.state?.files?.[check.path] : device?.files?.[check.path]
        try {
          if (check.absent) assert.equal(actual, undefined)
          else if (check.deleted !== undefined) assert.equal(actual?.deleted, check.deleted)
          else assert.equal(actual?.sha256, sha(contentOf(check)))
        } catch { failures.push(`${name}/${mode}: expectation ${JSON.stringify({ ...check, text: undefined })} failed (got ${JSON.stringify(actual)})`) }
      }
      if (flag('--dump')) { mkdirSync(flag('--dump'), { recursive: true }); writeFileSync(join(flag('--dump'), `${name}.${mode}.json`), `${JSON.stringify(record, null, 1)}\n`) }
      if (update && mode === 'ts') writeFileSync(expectedPath, `${JSON.stringify(record, null, 1)}\n`)
      if (!existsSync(expectedPath)) { failures.push(`${name}: no expected record (run with --update)`); continue }
      const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
      const diff = describeDiff(expected, record)
      if (diff) failures.push(`${name}/${mode}: ${diff}`)
      else if (!quiet) origLog(`ok ${name}/${mode}`)
    }
  }
  return { failures, timings: allTimings }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  let code = 0
  try {
    const { failures, timings } = await runAll()
    const timingsPath = flag('--timings')
    if (timingsPath) writeFileSync(timingsPath, JSON.stringify(timings, null, 1))
    if (failures.length) { for (const failure of failures) origError(`FAIL ${failure}`); code = 1 } else origLog(`sync-parity: ok (${modes.join(', ')})`)
  } catch (error) {
    origError(error); code = 1
  } finally {
    await vite.close(); httpServer.close(); rmSync(dataDirectory, { recursive: true, force: true })
  }
  process.exit(code)
}
