// QA-031/032: uploads run in parallel (bounded), progress is live, the account is not refetched while nothing
// changed, and a parallel sync still converges on a second device. Uses the real server module.
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
globalThis.window = Object.assign(Object.create(null), {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  fanotes: { platform: 'test' },
  location: { origin: 'http://127.0.0.1' },
})

// Counts requests in flight per route and adds a little latency so that overlap is observable.
const counts = { account: 0, put: 0, active: 0, maxActive: 0 }
const nodeFetch = globalThis.fetch
globalThis.fetch = async (input, init = {}) => {
  const headers = new Headers(init.headers)
  if (!headers.has('accept-language')) headers.set('Accept-Language', 'de-CH,de;q=0.9')
  const url = String(input)
  const isPut = (init.method ?? 'GET') === 'PUT' && /\/sync\/files\//u.test(url)
  if (/\/sync\/account$/u.test(url) && (init.method ?? 'GET') === 'GET') counts.account += 1
  if (isPut) {
    counts.put += 1
    counts.active += 1
    counts.maxActive = Math.max(counts.maxActive, counts.active)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  try {
    return await nodeFetch(input, { ...init, headers })
  } finally {
    if (isPut) counts.active -= 1
  }
}

const dataDirectory = mkdtempSync(join(tmpdir(), 'fanotes-sync-parallel-'))
process.env.FANOTES_SYNC_DIR = dataDirectory
const PORT = 19_000 + Math.floor(Math.random() * 300)
const ORIGIN = `http://127.0.0.1:${PORT}`
process.env.FANOTES_PUBLIC_ORIGIN = ORIGIN
const { handleSyncRequest } = await import('../../fanotes-site/sync-api.mjs')
const httpServer = createHttpServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost')
  if (await handleSyncRequest(request, response, url)) return
  response.writeHead(404)
  response.end()
})
await new Promise((resolve) => httpServer.listen(PORT, '127.0.0.1', resolve))
const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const { SyncApi } = await vite.ssrLoadModule('/src/lib/sync/api.ts')
const { SyncEngine } = await vite.ssrLoadModule('/src/lib/sync/engine.ts')

const encoder = new TextEncoder()
const createHost = (id) => {
  const files = new Map()
  let clock = 1_700_000_000_000
  const store = { state: new Map(), secrets: null }
  return {
    files,
    put(path, content) { clock += 1000; files.set(path, { bytes: encoder.encode(content), mtimeMs: clock }) },
    async vaultId() { return `vault-${id}` },
    async scan() { return [...files.entries()].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtimeMs: file.mtimeMs })) },
    async read(path) { return files.get(path).bytes },
    async write(path, bytes, mtimeMs) { files.set(path, { bytes: new Uint8Array(bytes), mtimeMs: mtimeMs || (clock += 1000) }); return { path, size: bytes.byteLength, mtimeMs: files.get(path).mtimeMs } },
    async remove(path) { files.delete(path) },
    async readState(vault) { return store.state.get(vault) ?? null },
    async writeState(vault, json) { if (json === null) store.state.delete(vault); else store.state.set(vault, json) },
    async readSecrets() { return store.secrets },
    async writeSecrets(json) { store.secrets = json },
  }
}
const createEngine = (host, name) => {
  const engine = new SyncEngine(new SyncApi(ORIGIN))
  engine.attach(host, { platform: 'linux', deviceName: () => name, automatic: () => false, isPathBusy: () => false, excludedPrefixes: () => [], onApplied: () => undefined, onConflict: () => undefined, onSignedOut: () => undefined })
  return engine
}

try {
  const FILES = 60
  const hostA = createHost('a')
  for (let index = 0; index < FILES; index += 1) hostA.put(`Notizen/Note ${String(index).padStart(3, '0')}.md`, `# Note ${index}\n\n${'Zeile mit Inhalt. '.repeat(200 + index)}\n`)
  const A = createEngine(hostA, 'Laptop')
  await A.start()
  await A.register('parallel@example.com', 'korrektes pferd batterie')
  await A.syncNow()
  for (let index = 0; index < FILES; index += 1) hostA.put(`Zweite/Note ${String(index).padStart(3, '0')}.md`, `# Zweite ${index}\n\n${'Mehr Text. '.repeat(300 + index)}\n`)

  const seen = []
  A.subscribe(() => {
    const state = A.getState()
    if (state.progress?.phase === 'push') seen.push({ done: state.progress.done, total: state.progress.total, pending: state.pendingLocal })
  })
  counts.put = 0
  counts.maxActive = 0
  const startedAt = Date.now()
  await A.syncNow()
  const elapsed = Date.now() - startedAt
  assert.equal(A.getState().status, 'idle', A.getState().error)
  assert.equal(counts.put, FILES, 'every new file is uploaded exactly once')
  assert.ok(counts.maxActive >= 4, `uploads overlap (max ${counts.maxActive} in flight)`)
  assert.ok(counts.maxActive <= 6, `uploads stay bounded (max ${counts.maxActive} in flight)`)
  // Live progress: done climbs one by one from 1 to total while the cycle runs, never jumps back.
  assert.ok(seen.length >= FILES, 'a progress update per file')
  assert.ok(seen.some((entry) => entry.done > 0 && entry.done < entry.total), 'progress is visible before the end')
  for (let index = 1; index < seen.length; index += 1) assert.ok(seen[index].done >= seen[index - 1].done, 'progress never goes back')
  assert.equal(seen.at(-1).done, FILES)
  assert.equal(A.getState().trackedFiles, 2 * FILES)

  // The account details are fetched once, then reused while nothing changed.
  await A.refreshAccount({ onlyIfChanged: true })
  const fetched = counts.account
  await A.syncNow('timer')
  await A.refreshAccount({ onlyIfChanged: true })
  await A.refreshAccount({ onlyIfChanged: true })
  assert.equal(counts.account, fetched, 'an idle cycle does not refetch the account')
  hostA.put('Notizen/Neu.md', '# Neu\n')
  await A.syncNow('timer')
  await A.refreshAccount({ onlyIfChanged: true })
  assert.equal(counts.account, fetched + 1, 'an upload makes the account details stale')
  const info = await A.refreshAccount()
  assert.equal(counts.account, fetched + 2, 'an explicit refresh always asks the server')
  assert.equal(info.usage.files, 2 * FILES + 1)

  // A second device converges on the same content (ids, revisions and the changes table are consistent).
  const hostB = createHost('b')
  const B = createEngine(hostB, 'Tablet')
  await B.start()
  await B.login('parallel@example.com', 'korrektes pferd batterie')
  await B.syncNow()
  assert.equal(B.getState().status, 'idle', B.getState().error)
  assert.equal(hostB.files.size, hostA.files.size)
  for (const [path, file] of hostA.files) assert.equal(Buffer.from(hostB.files.get(path).bytes).toString(), Buffer.from(file.bytes).toString(), path)
  // Nothing is left to do on either side, and nothing conflicted.
  counts.put = 0
  await A.syncNow()
  await B.syncNow()
  assert.equal(counts.put, 0, 'a converged vault uploads nothing')
  assert.equal(A.getState().conflicts.length + B.getState().conflicts.length, 0)

  console.log(`check-sync-parallel: ok (max ${counts.maxActive} uploads in flight, ${FILES} files in ${elapsed} ms)`)
} finally {
  await vite.close()
  httpServer.close()
  rmSync(dataDirectory, { recursive: true, force: true })
}
// The engines keep their periodic sync timers alive.
process.exit(0)
