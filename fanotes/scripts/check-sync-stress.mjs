// Sync stress harness: 2-3 simulated devices against the real server module on localhost (temp data dir, throwaway
// accounts, no other network). Every scenario asserts the same invariants after a quiet period:
//   - no data loss: every marker written on any device is somewhere in every vault (a conflict copy counts),
//   - convergence: all vaults hold identical files,
//   - no zombies: deleted/renamed-away paths are gone everywhere,
//   - no endless re-uploads: a settled vault uploads nothing on further cycles.
// Deterministic: faults are injected by request count, not by timing.
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

const dataDirectory = mkdtempSync(join(tmpdir(), 'fanotes-sync-stress-'))
process.env.FANOTES_SYNC_DIR = dataDirectory
process.env.FANOTES_SYNC_REGISTER_PER_HOUR = '1000'
const PORT = 19_300 + Math.floor(Math.random() * 300)
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
const { UserShareManager } = await vite.ssrLoadModule('/src/lib/sync/userShares.ts')

const encoder = new TextEncoder()
const nodeFetch = globalThis.fetch
const PASSWORD = 'korrektes pferd batterie'

// ── Network: per device switches and request counters ───────────────────
const traffic = { put: 0, get: 0, del: 0, putActive: 0, maxPutActive: 0, maxHeldBytes: 0, heldBytes: 0 }
const makeFetch = (net) => async (input, init = {}) => {
  const method = init.method ?? 'GET'
  const url = String(input)
  const file = /\/sync\/files\//u.test(url)
  if (net.down) throw new TypeError('fetch failed')
  if (file && method === 'PUT') {
    if (net.dropPutAfter !== null && net.puts >= net.dropPutAfter) { net.down = true; throw new TypeError('fetch failed') }
    net.puts += 1
    traffic.put += 1
    traffic.putActive += 1
    const size = init.body?.byteLength ?? init.body?.size ?? 0
    traffic.heldBytes += size
    traffic.maxPutActive = Math.max(traffic.maxPutActive, traffic.putActive)
    traffic.maxHeldBytes = Math.max(traffic.maxHeldBytes, traffic.heldBytes)
    try { return await nodeFetch(input, init) } finally { traffic.putActive -= 1; traffic.heldBytes -= size }
  }
  if (file && method === 'GET') {
    if (net.dropGetAfter !== null && net.gets >= net.dropGetAfter) { net.down = true; throw new TypeError('fetch failed') }
    net.gets += 1
    traffic.get += 1
  }
  if (file && method === 'DELETE') traffic.del += 1
  return await nodeFetch(input, init)
}

// ── Devices ─────────────────────────────────────────────────────────────
const makeDevice = (id, name, { skewMs = 0, caseInsensitive = false } = {}) => {
  const files = new Map()
  /** Windows semantics: a path that differs only in case is the same file, and an overwrite keeps the existing spelling. */
  const spelled = (path) => { if (!caseInsensitive) return path; const lower = path.toLowerCase(); for (const key of files.keys()) if (key.toLowerCase() === lower) return key; return path }
  let clock = 1_700_000_000_000 + skewMs
  const store = { state: new Map(), secrets: new Map() }
  const net = { down: false, dropPutAfter: null, dropGetAfter: null, puts: 0, gets: 0 }
  const conflicts = []
  const host = {
    files,
    async vaultId() { return `vault-${id}` },
    async scan() { return [...files.entries()].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtimeMs: file.mtimeMs })) },
    async read(path) { const file = files.get(spelled(path)); if (!file) throw new Error('ENOENT'); return file.bytes },
    async write(path, bytes, mtimeMs) { path = spelled(path); clock += 1000; files.set(path, { bytes: new Uint8Array(bytes), mtimeMs: mtimeMs || clock }); return { path, size: bytes.byteLength, mtimeMs: files.get(path).mtimeMs } },
    async remove(path) { files.delete(spelled(path)) },
    async readState(vault) { return store.state.get(vault) ?? null },
    async writeState(vault, json) { if (store.frozen) return; if (json === null) store.state.delete(vault); else store.state.set(vault, json) },
    async readSecrets(slot = 'account') { return store.secrets.get(slot) ?? null },
    async writeSecrets(json, slot = 'account') { if (json === null) store.secrets.delete(slot); else store.secrets.set(slot, json) },
  }
  const build = () => {
    const created = new SyncEngine(new SyncApi(ORIGIN, makeFetch(net)))
    created.attach(host, { platform: 'linux', deviceName: () => name, automatic: () => false, isPathBusy: () => false, excludedPrefixes: () => [], onApplied: () => undefined, onConflict: (conflict) => conflicts.push(conflict), onSignedOut: () => undefined, now: () => Date.now() + skewMs })
    return created
  }
  const engine = build()
  const shares = new UserShareManager(engine, new SyncApi(ORIGIN, makeFetch(net)))
  shares.attach(host, { onIncoming: () => undefined, onGone: () => undefined, onApplied: () => undefined })
  const device = {
    shares, id, name, host, engine, net, conflicts, files,
    /** A local save: new bytes and a fresh mtime. */
    put(path, content) {
      path = spelled(path)
      clock += 1000
      const bytes = typeof content === 'string' ? encoder.encode(content) : content
      files.set(path, { bytes, mtimeMs: clock })
    },
    del(path) { files.delete(path); engine.markDeleted(path) },
    rename(from, to) {
      const file = files.get(from); files.delete(from)
      if (caseInsensitive && from.toLowerCase() === to.toLowerCase()) { files.set(to, file); engine.notifyLocalChange(); return }
      files.set(to, file); engine.markDeleted(from)
    },
    text(path) { const file = files.get(path); return file ? Buffer.from(file.bytes).toString('latin1') : null },
    allText() { return [...files.values()].map((file) => Buffer.from(file.bytes).toString('latin1')).join('\n\u0000\n') },
    /** The process dies: whatever the engine had not written to its state store is gone; a new engine starts on the same vault. */
    async crashAndRestart() {
      store.frozen = true
      device.engine.dispose()
      store.frozen = false
      net.down = false; net.dropPutAfter = null; net.dropGetAfter = null; net.puts = 0; net.gets = 0
      device.engine = build()
      await device.engine.start()
    },
    freezeState() { store.frozen = true },
    online() { net.down = false; net.dropPutAfter = null; net.dropGetAfter = null; net.puts = 0; net.gets = 0 },
    offline() { net.down = true },
    async sync() { await engine.syncNow('manual'); return engine.getState() },
  }
  return device
}

let accountCounter = 0
const newWorld = async (names, options = {}) => {
  accountCounter += 1
  const email = `stress${accountCounter}@example.com`
  const devices = names.map((name, index) => makeDevice(`${accountCounter}-${index}`, name, { skewMs: options.skew?.[index] ?? 0, caseInsensitive: options.caseInsensitive?.[index] ?? false }))
  await devices[0].engine.start()
  await devices[0].engine.register(email, PASSWORD)
  for (const device of devices.slice(1)) {
    await device.engine.start()
    await device.engine.login(email, PASSWORD)
  }
  return devices
}

const snapshot = (device) => new Map([...device.files].map(([path, file]) => [path, Buffer.from(file.bytes).toString('latin1')]))

/** Sync everyone round-robin until a whole round moves no bytes, then check convergence. */
const settle = async (devices, label, { rounds = 8 } = {}) => {
  let quiet = false
  for (let round = 0; round < rounds && !quiet; round += 1) {
    const before = traffic.put + traffic.del
    for (const device of devices) {
      const state = await device.sync()
      assert.equal(state.status, 'idle', `${label}: ${device.name} ends idle (${state.status}: ${state.error})`)
    }
    quiet = traffic.put + traffic.del === before && round > 0
  }
  assert.ok(quiet, `${label}: the vaults go quiet (no endless re-uploads)`)
  const reference = snapshot(devices[0])
  for (const device of devices.slice(1)) {
    const mine = snapshot(device)
    assert.deepEqual([...mine.keys()].sort(), [...reference.keys()].sort(), `${label}: ${device.name} has the same paths as ${devices[0].name}`)
    for (const [path, content] of reference) if (mine.get(path) !== content && process.env.STRESS_DEBUG) console.log('DIFF', path, JSON.stringify(content.slice(0, 200)), '<>', JSON.stringify(mine.get(path)?.slice(0, 200)), devices.map((d) => [...d.files.keys()]))
    for (const [path, content] of reference) assert.equal(mine.get(path) === content, true, `${label}: ${path} is identical on ${device.name}`)
  }
  // Another cycle on a settled vault changes nothing.
  const puts = traffic.put
  for (const device of devices) await device.sync()
  assert.equal(traffic.put, puts, `${label}: a settled vault uploads nothing`)
  return reference
}

/** Every marker is somewhere in the vault (edits may live in a conflict copy, a merge, or the winner). */
const assertNoLoss = (devices, markers, label) => {
  for (const device of devices) {
    const all = device.allText()
    for (const marker of markers) if (!all.includes(marker) && process.env.STRESS_DEBUG) console.log('LOST', marker, devices.map((d) => [d.name, [...d.files.entries()].map(([path, file]) => `${path}=${JSON.stringify(Buffer.from(file.bytes).toString('latin1').slice(0, 60))}`)]))
    for (const marker of markers) assert.ok(all.includes(marker), `${label}: "${marker}" survives on ${device.name}`)
  }
}
const assertGone = (devices, paths, label) => {
  for (const device of devices) for (const path of paths) assert.ok(!device.files.has(path), `${label}: ${path} is gone from ${device.name}`)
}
const conflictCopies = (device) => [...device.files.keys()].filter((path) => path.includes('(Konflikt'))
/** A real stored famd: prose plus one ink stroke that carries the marker. */
const famd = (marker, prose = 'Wort', stamp = '2026-01-01T00:00:00.000Z') => {
  const payload = { schema: 'fanotes-famd-v1', updatedAt: stamp, ink: { strokes: [{ label: marker, points: Array.from({ length: 30 }, (_, index) => ({ x: index, y: 1 })) }], updatedAt: stamp }, worksheets: [] }
  const json = JSON.stringify(payload)
  return `# Seite\n\n${prose}\n\n<!-- fanotes-famd:v1 chars=${json.length} -->\n${json}\n`
}
const note = (title, marker) => `# ${title}\n\n${marker}\n`

const scenarios = []
const scenario = (name, run) => scenarios.push({ name, run })

scenario('concurrent edit of one note, both online', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  A.put('Mathe/Algebra.md', note('Algebra', 'base'))
  await settle([A, B], 'seed')
  A.put('Mathe/Algebra.md', note('Algebra', 'edit-from-laptop'))
  B.put('Mathe/Algebra.md', note('Algebra', 'edit-from-tablet'))
  await A.sync()
  await B.sync()
  await settle([A, B], 'concurrent')
  assertNoLoss([A, B], ['edit-from-laptop', 'edit-from-tablet'], 'concurrent')
})

scenario('one device offline, edits, then reconnects (three devices)', async () => {
  const [A, B, C] = await newWorld(['Laptop', 'Tablet', 'Desktop'])
  for (let index = 0; index < 5; index += 1) A.put(`Ordner/Notiz ${index}.md`, note(`N${index}`, `base-${index}`))
  await settle([A, B, C], 'seed')
  B.offline()
  B.put('Ordner/Notiz 1.md', note('N1', 'offline-edit-b'))
  B.put('Ordner/Notiz 9.md', note('N9', 'offline-new-b'))
  B.del('Ordner/Notiz 2.md')
  A.put('Ordner/Notiz 1.md', note('N1', 'online-edit-a'))
  C.put('Ordner/Notiz 3.md', note('N3', 'online-edit-c'))
  await A.sync()
  await C.sync()
  const offlineState = await B.sync()
  assert.equal(offlineState.status, 'offline')
  assert.equal(B.text('Ordner/Notiz 1.md'), note('N1', 'offline-edit-b'), 'the offline device keeps its edit')
  B.online()
  await settle([A, B, C], 'reconnect')
  assertNoLoss([A, B, C], ['offline-edit-b', 'offline-new-b', 'online-edit-a', 'online-edit-c'], 'reconnect')
  assertGone([A, B, C], ['Ordner/Notiz 2.md'], 'reconnect')
  assert.ok(conflictCopies(A).length >= 1, 'the clashing edit produced a conflict copy')
})

scenario('rename on one device while another edits the old name', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  A.put('Projekt/Plan.md', note('Plan', 'base'))
  A.put('Projekt/Plan.famd', famd('base'))
  await settle([A, B], 'seed')
  A.rename('Projekt/Plan.md', 'Projekt/Plan neu.md')
  A.rename('Projekt/Plan.famd', 'Projekt/Plan neu.famd')
  B.put('Projekt/Plan.md', note('Plan', 'edit-on-old-name'))
  await A.sync()
  await B.sync()
  await settle([A, B], 'rename-vs-edit')
  assertNoLoss([A, B], ['edit-on-old-name'], 'rename-vs-edit')
  assert.ok(A.files.has('Projekt/Plan neu.md') && A.files.has('Projekt/Plan neu.famd'), 'renamed pair exists')
})

scenario('delete on one device while another edits', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  A.put('Weg.md', note('Weg', 'base'))
  A.put('Bleibt.md', note('Bleibt', 'base'))
  await settle([A, B], 'seed')
  A.del('Weg.md')
  B.put('Weg.md', note('Weg', 'edit-after-delete'))
  await A.sync()
  await B.sync()
  await settle([A, B], 'delete-vs-edit')
  assertNoLoss([A, B], ['edit-after-delete'], 'delete-vs-edit')
  // Reverse: edit first, then the other deletes an older revision.
  B.put('Bleibt.md', note('Bleibt', 'edit-before-delete'))
  A.del('Bleibt.md')
  await B.sync()
  await A.sync()
  await settle([A, B], 'edit-vs-delete')
  assertNoLoss([A, B], ['edit-before-delete'], 'edit-vs-delete')
})

scenario('folder move with many files and a concurrent edit inside', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  const COUNT = 120
  for (let index = 0; index < COUNT; index += 1) A.put(`Alt/Unter/Datei ${String(index).padStart(3, '0')}.md`, note(`D${index}`, `base-${index}`))
  await settle([A, B], 'seed')
  for (let index = 0; index < COUNT; index += 1) A.rename(`Alt/Unter/Datei ${String(index).padStart(3, '0')}.md`, `Neu/Unter/Datei ${String(index).padStart(3, '0')}.md`)
  B.put('Alt/Unter/Datei 007.md', note('D7', 'edit-inside-moved-folder'))
  await A.sync()
  await B.sync()
  const files = await settle([A, B], 'folder-move')
  assertNoLoss([A, B], ['edit-inside-moved-folder'], 'folder-move')
  assert.equal([...files.keys()].filter((path) => path.startsWith('Neu/')).length, COUNT, 'every file arrived in the new folder')
  assert.ok([...files.keys()].filter((path) => path.startsWith('Alt/') && !path.includes('(Konflikt')).length <= 1, 'old folder holds at most the re-created edit')
})

scenario('case-only rename', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  A.put('Notizen/meeting.md', note('meeting', 'base'))
  await settle([A, B], 'seed')
  A.rename('Notizen/meeting.md', 'Notizen/Meeting.md')
  await settle([A, B], 'case-rename')
  assert.ok(A.files.has('Notizen/Meeting.md') && B.files.has('Notizen/Meeting.md'), 'new casing on both')
  assertGone([A, B], ['Notizen/meeting.md'], 'case-rename')
  assertNoLoss([A, B], ['base'], 'case-rename')
})

scenario('case-only rename seen by a case-insensitive (Windows) device', async () => {
  const [A, W] = await newWorld(['Linux', 'Windows'], { caseInsensitive: [false, true] })
  A.put('Notizen/meeting.md', note('meeting', 'ci-base'))
  A.put('Notizen/meeting.famd', famd('ci-ink'))
  await settle([A, W], 'seed')
  A.rename('Notizen/meeting.md', 'Notizen/Meeting.md')
  A.rename('Notizen/meeting.famd', 'Notizen/Meeting.famd')
  A.engine.markDeleted('Notizen/meeting.md')
  A.engine.markDeleted('Notizen/meeting.famd')
  await A.sync()
  await W.sync()
  await A.sync()
  await W.sync()
  assert.equal(W.text('Notizen/Meeting.md') ?? W.text('Notizen/meeting.md'), note('meeting', 'ci-base'), 'the note survives the rename on the Windows device')
  assert.ok(W.files.has('Notizen/meeting.famd') || W.files.has('Notizen/Meeting.famd'), 'and so does its twin')
  assert.equal(W.files.size, 2)
  // A Windows-side case-only rename reaches the Linux device as well.
  W.rename([...W.files.keys()].find((path) => path.endsWith('.md')), 'Notizen/MEETING.md')
  await A.sync()
  await W.sync()
  await A.sync()
  await W.sync()
  assertNoLoss([A, W], ['ci-base', 'ci-ink'], 'ci-rename')
})

scenario('a folder deleted on one device while another edits inside it', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  for (let index = 0; index < 10; index += 1) A.put(`Weg/Ordner/n${index}.md`, note(`W${index}`, `folder-base-${index}`))
  A.put('Bleibt.md', note('Bleibt', 'stays'))
  await settle([A, B], 'seed')
  for (let index = 0; index < 10; index += 1) A.del(`Weg/Ordner/n${index}.md`)
  B.put('Weg/Ordner/n4.md', note('W4', 'edit-in-deleted-folder'))
  B.put('Weg/Ordner/neu.md', note('neu', 'new-in-deleted-folder'))
  await A.sync()
  await B.sync()
  await settle([A, B], 'folder-delete')
  assertNoLoss([A, B], ['edit-in-deleted-folder', 'new-in-deleted-folder', 'stays'], 'folder-delete')
  assert.equal([...A.files.keys()].filter((path) => path.startsWith('Weg/') && !path.includes('n4') && !path.includes('neu')).length, 0, 'untouched files stay deleted (no zombies)')
})

scenario('delete then re-create the same path on another device', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  A.put('Zombie.md', note('Z', 'first-life'))
  await settle([A, B], 'seed')
  A.del('Zombie.md')
  await settle([A, B], 'deleted')
  assertGone([A, B], ['Zombie.md'], 'deleted')
  B.put('Zombie.md', note('Z', 'second-life'))
  await settle([A, B], 'recreated')
  assert.equal(A.text('Zombie.md'), note('Z', 'second-life'))
})

scenario('edits made while a cycle is running are not lost or overwritten', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  for (let index = 0; index < 30; index += 1) A.put(`Live/n${index}.md`, note(`L${index}`, `live-base-${index}`))
  await settle([A, B], 'seed')
  for (let index = 0; index < 30; index += 1) B.put(`Live/n${index}.md`, note(`L${index}`, `remote-${index}`))
  await B.sync()
  // A edits files while its own pull is in progress.
  const edit = (async () => { while (A.net.gets < 3) await new Promise((resolve) => setTimeout(resolve, 1)); for (let index = 0; index < 30; index += 3) A.put(`Live/n${index}.md`, note(`L${index}`, `during-sync-${index}`)) })()
  await A.sync()
  await edit
  await settle([A, B], 'during-sync')
  for (let index = 0; index < 30; index += 3) assertNoLoss([A, B], [`during-sync-${index}`], 'during-sync')
  for (let index = 1; index < 30; index += 3) assertNoLoss([A, B], [`remote-${index}`], 'during-sync')
})

scenario('large files near the limits stay bounded in memory', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  const big = (seed, megabytes) => { const bytes = new Uint8Array(megabytes * 1024 * 1024); for (let index = 0; index < bytes.length; index += 4099) bytes[index] = (index / 4099 + seed) & 255; return bytes }
  // 24 x 6 MB = 144 MB queued: the 32 MB budget keeps well below that in flight (a file above the budget runs alone).
  for (let index = 0; index < 24; index += 1) A.put(`Anhang/gross-${index}.pdf`, big(index, 6))
  A.put('Anhang/riesig.bin', big(99, 40))
  traffic.maxHeldBytes = 0
  traffic.maxPutActive = 0
  await settle([A, B], 'big')
  assert.ok(traffic.maxPutActive <= 6, `uploads bounded (${traffic.maxPutActive})`)
  assert.ok(traffic.maxHeldBytes > 0, 'upload sizes are measured')
  assert.ok(traffic.maxHeldBytes <= 32 * 1024 * 1024 + 40 * 1024 * 1024, `bytes in flight stay near the budget (${(traffic.maxHeldBytes / 1048576).toFixed(0)} MB)`)
  assert.equal(B.files.size, 25)
})

scenario('1,100 small files upload once each and a re-sync is free', async () => {
  // The server allows 1,200 requests per account and minute, so only one device works on this account.
  const [A] = await newWorld(['Laptop'])
  const COUNT = 1100
  for (let index = 0; index < COUNT; index += 1) A.put(`Viele/${String(index % 40).padStart(2, '0')}/n${index}.md`, `# ${index}\n`)
  traffic.put = 0
  const state = await A.sync()
  assert.equal(state.status, 'idle', state.error)
  assert.equal(traffic.put, COUNT, 'each file uploaded exactly once')
  assert.equal(state.trackedFiles, COUNT)
  await A.sync()
  assert.equal(traffic.put, COUNT, 'a second cycle uploads nothing')
})

scenario('400 small files converge on a second device, half deleted again', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  const COUNT = 400
  for (let index = 0; index < COUNT; index += 1) A.put(`Viele/${String(index % 40).padStart(2, '0')}/n${index}.md`, `# ${index}\n`)
  traffic.put = 0
  const files = await settle([A, B], 'many', { rounds: 10 })
  assert.equal(files.size, COUNT)
  assert.equal(traffic.put, COUNT, 'each file uploaded exactly once')
  for (let index = 0; index < COUNT; index += 2) B.del(`Viele/${String(index % 40).padStart(2, '0')}/n${index}.md`)
  A.put('Viele/01/n1.md', '# 1\nstill-edited\n')
  const after = await settle([A, B], 'many-delete', { rounds: 10 })
  assert.equal(after.size, COUNT / 2)
  assertNoLoss([A, B], ['still-edited'], 'many-delete')
})

scenario('push killed mid-way resumes without duplicates', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  for (let index = 0; index < 40; index += 1) A.put(`Kill/n${index}.md`, note(`K${index}`, `kill-${index}`))
  A.net.dropPutAfter = 17
  const state = await A.sync()
  assert.equal(state.status, 'offline', 'the dropped connection is reported as offline')
  traffic.put = 0
  A.online()
  await settle([A, B], 'kill-push')
  assert.ok(traffic.put <= 40 - 10, `the resumed push does not start over (${traffic.put} uploads)`)
  assert.equal(B.files.size, 40)
  assertNoLoss([A, B], Array.from({ length: 40 }, (_, index) => `kill-${index}`), 'kill-push')
  assert.equal(conflictCopies(A).length + conflictCopies(B).length, 0, 'an interrupted push makes no conflict copies')
})

scenario('process killed mid-push (state not saved) restarts without conflicts', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  for (let index = 0; index < 40; index += 1) A.put(`Crash/n${index}.md`, note(`C${index}`, `crash-${index}`))
  A.net.dropPutAfter = 23
  A.freezeState()
  await A.sync()
  await A.crashAndRestart()
  traffic.put = 0
  await settle([A, B], 'crash-push')
  assert.equal(B.files.size, 40)
  assert.equal(conflictCopies(A).length + conflictCopies(B).length, 0, 'uploads that happened before the kill do not clash with themselves')
  assertNoLoss([A, B], Array.from({ length: 40 }, (_, index) => `crash-${index}`), 'crash-push')
})

scenario('process killed mid-pull (state not saved) restarts without conflicts', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  for (let index = 0; index < 40; index += 1) A.put(`Crash/n${index}.md`, note(`C${index}`, `crash-${index}`))
  await A.sync()
  B.net.dropGetAfter = 25
  B.freezeState()
  await B.sync()
  assert.ok(B.files.size > 0 && B.files.size < 40, `a partial pull happened (${B.files.size} files)`)
  await B.crashAndRestart()
  await settle([A, B], 'crash-pull')
  assert.equal(B.files.size, 40)
  assert.equal(conflictCopies(A).length + conflictCopies(B).length, 0, 'files written before the kill match the server and are adopted')
})

scenario('network drops mid-download and a retry completes', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  for (let index = 0; index < 40; index += 1) A.put(`Pull/n${index}.md`, note(`P${index}`, `pull-${index}`))
  await A.sync()
  B.net.dropGetAfter = 15
  const state = await B.sync()
  assert.notEqual(state.status, 'idle', 'the interrupted pull is not reported as success')
  B.online()
  B.put('Pull/lokal.md', note('lokal', 'local-while-partial'))
  await settle([A, B], 'drop-pull')
  assert.equal(B.files.size, 41)
  assertNoLoss([A, B], ['local-while-partial', 'pull-39'], 'drop-pull')
  assert.equal(conflictCopies(A).length + conflictCopies(B).length, 0, 'no conflict copies from a partial pull')
})

scenario('clock skew between devices (one hour ahead, one a day behind)', async () => {
  const [A, B, C] = await newWorld(['Laptop', 'Tablet', 'Desktop'], { skew: [0, 3_600_000, -86_400_000] })
  A.put('Skew/Notiz.md', note('Skew', 'base'))
  await settle([A, B, C], 'seed')
  A.put('Skew/Notiz.md', note('Skew', 'edit-a'))
  B.put('Skew/Notiz.md', note('Skew', 'edit-b'))
  C.put('Skew/Notiz.md', note('Skew', 'edit-c'))
  for (const device of [C, B, A]) await device.sync()
  await settle([A, B, C], 'skew')
  assertNoLoss([A, B, C], ['edit-a', 'edit-b', 'edit-c'], 'skew')
  C.put('Skew/Notiz.md', note('Skew', 'edit-c-later'))
  C.put('Skew/Zweite.md', note('Zwei', 'second'))
  await settle([A, B, C], 'skew-later')
  assertNoLoss([A, B], ['edit-c-later', 'second'], 'skew-later')
})

scenario('.famd + .md pairs and ink assets across devices', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  const png = (seed) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(3000, seed)])
  A.put('Skizzen/Seite.md', note('Seite', 'prose-1'))
  A.put('Skizzen/Seite.famd', famd('aaa'))
  A.put('Skizzen/Seite.assets/ink-1.png', png(1))
  await settle([A, B], 'seed')
  A.put('Skizzen/Seite.famd', famd('from-a'))
  B.put('Skizzen/Seite.famd', famd('from-b'))
  B.put('Skizzen/Seite.md', note('Seite', 'prose-from-b'))
  B.put('Skizzen/Seite.assets/ink-2.png', png(2))
  await A.sync()
  await B.sync()
  await settle([A, B], 'famd')
  assertNoLoss([A, B], ['from-a', 'from-b', 'prose-from-b'], 'famd')
  assert.ok(A.files.has('Skizzen/Seite.assets/ink-1.png') && A.files.has('Skizzen/Seite.assets/ink-2.png'), 'both ink assets exist everywhere')
})

scenario('same file created on two devices with different content', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  A.put('Neu.md', note('Neu', 'created-a'))
  B.put('Neu.md', note('Neu', 'created-b'))
  await A.sync()
  await B.sync()
  await settle([A, B], 'both-created')
  assertNoLoss([A, B], ['created-a', 'created-b'], 'both-created')
})

scenario('repeated ping-pong edits never loop', async () => {
  const [A, B] = await newWorld(['Laptop', 'Tablet'])
  A.put('Pingpong.md', note('P', 'v0'))
  await settle([A, B], 'seed')
  for (let round = 1; round <= 6; round += 1) {
    A.put('Pingpong.md', note('P', `a${round}`))
    await settle([A, B], `ping-${round}a`)
    B.put('Pingpong.md', note('P', `b${round}`))
    await settle([A, B], `ping-${round}b`)
  }
  assert.equal(conflictCopies(A).length, 0, 'sequential edits never conflict')
  assert.equal(A.text('Pingpong.md'), note('P', 'b6'))
})

/** Two accounts with a username each and an accepted share of `Schule/Mathe.md` (edit permission) from anna to ben. */
const newShareWorld = async () => {
  accountCounter += 1
  const anna = makeDevice(`share-${accountCounter}-a`, 'Anna')
  const ben = makeDevice(`share-${accountCounter}-b`, 'Ben')
  await anna.engine.start()
  await anna.engine.createAccount({ username: `Anna${accountCounter}`, password: PASSWORD })
  await ben.engine.start()
  await ben.engine.createAccount({ username: `Ben${accountCounter}`, password: PASSWORD })
  anna.shares.start()
  ben.shares.start()
  for (let tries = 0; !(anna.shares.getState().ready && ben.shares.getState().ready); tries += 1) {
    assert.ok(tries < 200, 'share managers become ready')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  anna.put('Schule/Mathe.md', note('Mathe', 'share-base'))
  anna.put('Schule/Mathe.famd', famd('share-ink-base'))
  const shareId = await anna.shares.share({ path: 'Schule/Mathe.md', kind: 'note', username: `Ben${accountCounter}`, permission: 'edit' })
  await ben.shares.refresh()
  await ben.shares.respond(shareId, true)
  await ben.shares.syncShare(shareId)
  const received = [...ben.files.keys()].find((path) => path.startsWith('Mit mir geteilt/') && path.endsWith('.md'))
  assert.ok(received, 'the accepted share arrives as a file')
  return { anna, ben, shareId, received, receivedFamd: received.replace(/\.md$/u, '.famd') }
}
const dump = (device) => `${device.name}: ${[...device.files.entries()].map(([path, file]) => `${path.split('/').pop()}=${Buffer.from(file.bytes).toString('latin1').replace(/\n/gu, ' ').match(/(owner|recipient|share)[-a-z0-9]*/u)?.[0] ?? '?'}`).join(' | ')}`
const shareRound = async ({ anna, ben, shareId }, times = 3) => {
  for (let index = 0; index < times; index += 1) {
    await anna.shares.syncShare(shareId)
    if (process.env.STRESS_DEBUG) console.log('after anna', dump(anna), '||', dump(ben))
    await ben.shares.syncShare(shareId)
    if (process.env.STRESS_DEBUG) console.log('after ben ', dump(anna), '||', dump(ben))
  }
}

scenario('shared note: recipient edits offline while the owner edits', async () => {
  const world = await newShareWorld()
  const { anna, ben, shareId, received, receivedFamd } = world
  assert.equal(ben.text(received), note('Mathe', 'share-base'))
  assert.ok(ben.files.has(receivedFamd), 'the .famd twin is shared too')
  ben.offline()
  ben.put(received, note('Mathe', 'recipient-offline-edit'))
  ben.put(receivedFamd, famd('recipient-ink'))
  anna.put('Schule/Mathe.md', note('Mathe', 'owner-edit'))
  await anna.shares.syncShare(shareId)
  await ben.shares.syncShare(shareId)
  assert.equal(ben.text(received), note('Mathe', 'recipient-offline-edit'), 'offline recipient keeps its edit')
  ben.online()
  await shareRound(world, 4)
  assertNoLoss([anna, ben], ['recipient-offline-edit', 'owner-edit', 'recipient-ink'], 'share-offline')
  const annaMd = [...anna.files.keys()].filter((path) => path.endsWith('.md')).sort()
  const benMd = [...ben.files.keys()].filter((path) => path.endsWith('.md')).sort()
  assert.equal(annaMd.length, benMd.length, `owner and recipient hold the same number of notes (${annaMd.length} vs ${benMd.length})`)
  // Quiet: another round changes nothing.
  const before = snapshot(anna)
  await shareRound(world, 2)
  assert.deepEqual([...snapshot(anna).entries()], [...before.entries()], 'the owner vault is stable')
})

scenario('shared note: owner deletes while the recipient edited', async () => {
  const world = await newShareWorld()
  const { anna, ben, shareId, received } = world
  anna.put('Schule/Zwei.md', note('Zwei', 'second-file'))
  await shareRound(world, 1)
  ben.put(received, note('Mathe', 'recipient-edit-after-owner-delete'))
  // The owner removes the file from the share by deleting it.
  anna.files.delete('Schule/Mathe.md')
  await anna.shares.syncShare(shareId)
  await ben.shares.syncShare(shareId)
  await shareRound(world, 3)
  assertNoLoss([ben], ['recipient-edit-after-owner-delete'], 'share-delete')
})

scenario('shared note: both edit online between syncs, many rounds', async () => {
  const world = await newShareWorld()
  const { anna, ben, received } = world
  for (let round = 0; round < 5; round += 1) {
    anna.put('Schule/Mathe.md', note('Mathe', `owner-${round}`))
    ben.put(received, note('Mathe', `recipient-${round}`))
    await shareRound(world, 3)
  }
  assertNoLoss([anna, ben], ['owner-4', 'recipient-4'], 'share-pingpong')
  const copies = conflictCopies(anna).length + conflictCopies(ben).length
  assert.ok(copies < 40, `conflict copies stay bounded (${copies})`)
})

const only = process.env.STRESS_ONLY
const startedAt = Date.now()
let heapPeak = 0
try {
  for (const { name, run } of scenarios) {
    if (only && !name.includes(only)) continue
    const began = Date.now()
    try {
      await run()
    } catch (error) {
      console.error(`FAILED: ${name}`)
      throw error
    }
    heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed)
    console.log(`  ok  ${name} (${Date.now() - began} ms)`)
  }
  assert.ok(heapPeak < 1.5 * 1024 ** 3, `heap stays bounded (${(heapPeak / 1048576).toFixed(0)} MB)`)
  console.log(`check-sync-stress: ok (${scenarios.length} scenarios, ${((Date.now() - startedAt) / 1000).toFixed(1)} s, heap peak ${(heapPeak / 1048576).toFixed(0)} MB)`)
} finally {
  await vite.close()
  httpServer.close()
  rmSync(dataDirectory, { recursive: true, force: true })
}
process.exit(0)
