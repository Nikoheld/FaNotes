// Sync: crypto round-trips, the engine's two-device behaviour against the real
// server module (fanotes-site/sync-api.mjs) mounted on a bare http server, and
// the wiring in App / Electron / nginx / systemd.
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const read = (relative) => readFileSync(join(appRoot, relative), 'utf8')

// The engine talks to window.setTimeout / addEventListener; Node gets a minimal stand-in.
globalThis.window = Object.assign(Object.create(null), {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  fanotes: { platform: 'test' },
  location: { origin: 'http://127.0.0.1' },
})

// Browsers and Electron send the system locale; the server answers in German for it and in
// English otherwise. Node sends nothing, so pin German to keep the message assertions stable.
const nodeFetch = globalThis.fetch
globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers)
  if (!headers.has('accept-language')) headers.set('Accept-Language', 'de-CH,de;q=0.9')
  return nodeFetch(input, { ...init, headers })
}

const dataDirectory = mkdtempSync(join(tmpdir(), 'fanotes-sync-check-'))
process.env.FANOTES_SYNC_DIR = dataDirectory
process.env.FANOTES_MCP_DIR = join(dataDirectory, 'mcp')
const PORT = 18_600 + Math.floor(Math.random() * 300)
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

const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const crypto = await vite.ssrLoadModule('/src/lib/sync/crypto.ts')
const { SyncApi, SyncApiError } = await vite.ssrLoadModule('/src/lib/sync/api.ts')
const { SyncEngine, isSyncablePath, conflictCopyPath, loadPersistedSyncState } = await vite.ssrLoadModule('/src/lib/sync/engine.ts')
const { syncStatusLabel } = await vite.ssrLoadModule('/src/lib/sync/status.ts')
const homework = await vite.ssrLoadModule('/src/lib/homeworkStore.ts')
const conflictsModule = await vite.ssrLoadModule('/src/lib/sync/conflicts.ts')

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const text = (bytes) => decoder.decode(bytes)

/** In-memory vault + state store standing in for Electron main / IndexedDB. */
const createFakeHost = (id) => {
  const files = new Map()
  let clock = 1_700_000_000_000
  const store = { state: new Map(), secrets: null }
  const host = {
    files,
    store,
    put(path, content) {
      clock += 1000
      files.set(path, { bytes: typeof content === 'string' ? encoder.encode(content) : content, mtimeMs: clock })
    },
    text(path) { return files.has(path) ? text(files.get(path).bytes) : null },
    async vaultId() { return `vault-${id}` },
    async scan() { return [...files.entries()].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtimeMs: file.mtimeMs })) },
    async read(path) {
      if (!files.has(path)) throw new Error(`missing ${path}`)
      return files.get(path).bytes
    },
    async write(path, bytes, mtimeMs) {
      files.set(path, { bytes: new Uint8Array(bytes), mtimeMs: mtimeMs || (clock += 1000) })
      return { path, size: bytes.byteLength, mtimeMs: files.get(path).mtimeMs }
    },
    async remove(path) { files.delete(path) },
    async readState(vaultId) { return store.state.get(vaultId) ?? null },
    async writeState(vaultId, json) { if (json === null) store.state.delete(vaultId); else store.state.set(vaultId, json) },
    async readSecrets() { return store.secrets },
    async writeSecrets(json) { store.secrets = json },
  }
  return host
}

const createEngine = (host, name, hooks = {}) => {
  const engine = new SyncEngine(new SyncApi(ORIGIN))
  const events = { applied: [], conflicts: [], signedOut: [] }
  engine.attach(host, {
    platform: 'linux',
    deviceName: () => name,
    automatic: () => false,
    isPathBusy: (path) => hooks.busy?.(path) ?? false,
    excludedPrefixes: () => hooks.excludedPrefixes?.() ?? [],
    onApplied: (change) => events.applied.push(change),
    onConflict: (conflict) => events.conflicts.push(conflict),
    onSignedOut: (reason) => events.signedOut.push(reason),
  })
  return { engine, events }
}

try {
  // ── Crypto ──────────────────────────────────────────────────────────────
  {
    const kdf = crypto.newKdf()
    assert.ok(crypto.isValidKdf(kdf))
    const a = await crypto.deriveFromPassword('korrektes pferd batterie', kdf)
    const b = await crypto.deriveFromPassword('korrektes pferd batterie', kdf)
    const c = await crypto.deriveFromPassword('korrektes pferd batteriE', kdf)
    assert.equal(a.authKey, b.authKey, 'same password + salt → same auth key')
    assert.notEqual(a.authKey, c.authKey)
    const secret = crypto.newVaultSecret()
    const wrap = await crypto.wrapVaultSecret(secret, a.wrappingKey)
    assert.deepEqual(await crypto.unwrapVaultSecret(wrap, b.wrappingKey), secret)
    await assert.rejects(crypto.unwrapVaultSecret(wrap, c.wrappingKey), /nicht entschlüsselt/u)
    const keys = await crypto.deriveSyncKeys(await crypto.importVaultSecret(secret))
    const id1 = await crypto.fileIdFor(keys, 'Mathe/Algebra.md')
    const id2 = await crypto.fileIdFor(keys, 'Mathe/Algebra.md')
    assert.equal(id1, id2)
    assert.match(id1, /^[a-f0-9]{64}$/u)
    assert.notEqual(id1, await crypto.fileIdFor(keys, 'Mathe/algebra.md'))
    const plain = encoder.encode('# Algebra\n\nx² + y²')
    const blob = await crypto.encryptBytes(keys, id1, plain)
    assert.notDeepEqual(blob.subarray(12), plain)
    assert.deepEqual(await crypto.decryptBytes(keys, id1, blob), plain)
    const tamperedFileId = `${id2.startsWith('a') ? 'b' : 'a'}${id2.slice(1)}`
    await assert.rejects(crypto.decryptBytes(keys, tamperedFileId, blob), /nicht entschlüsselt/u, 'blob is bound to its file id (AAD)')
    const otherKeys = await crypto.deriveSyncKeys(await crypto.importVaultSecret(crypto.newVaultSecret()))
    await assert.rejects(crypto.decryptBytes(otherKeys, id1, blob))
    const meta = await crypto.encryptMeta(keys, id1, { path: 'Mathe/Algebra.md', mtimeMs: 5, size: plain.byteLength, sha256: await crypto.sha256Hex(plain) })
    assert.ok(!meta.includes('Algebra'))
    assert.equal((await crypto.decryptMeta(keys, id1, meta)).path, 'Mathe/Algebra.md')
    assert.equal(crypto.passwordProblems('kurz'), 'Das Passwort braucht mindestens 10 Zeichen.')
    assert.equal(crypto.passwordProblems('aaaaaaaaaaaa'), 'Dieses Passwort ist zu leicht zu erraten.')
    assert.equal(crypto.passwordProblems('korrektes pferd batterie'), null)
  }

  // ── Path rules ──────────────────────────────────────────────────────────
  assert.ok(isSyncablePath('Mathe/Algebra.md'))
  assert.ok(isSyncablePath('Mathe/Algebra.famd'))
  assert.ok(isSyncablePath('Physik/Skript.pdf'))
  assert.ok(isSyncablePath('.fanotes/folder-colors.json'))
  assert.ok(isSyncablePath('.fanotes/assets/abc.json'))
  assert.ok(!isSyncablePath('.fanotes/history/abc/index.json'), 'local version history stays local')
  assert.ok(!isSyncablePath('.fanotes/trash/index.json'), 'tablet trash stays on the device')
  assert.ok(!isSyncablePath('.fanotes/trash/abc/Math/Algebra.md'), 'a trashed note is not uploaded')
  assert.ok(!isSyncablePath('.fanotes/onboarding.json'))
  assert.ok(!isSyncablePath('.git/config'))
  assert.ok(!isSyncablePath('Mathe/.Algebra.md.123.tmp'))
  assert.ok(!isSyncablePath('../etc/passwd'))
  assert.ok(!isSyncablePath('Mathe//x.md'))
  assert.ok(!isSyncablePath('.DS_Store'))
  assert.equal(conflictCopyPath('Mathe/Algebra.md', 'Laptop', new Date(2026, 8, 8, 9, 5)), 'Mathe/Algebra (Konflikt Laptop 2026-09-08 09-05).md')
  assert.equal(conflictCopyPath('README', 'A/B:C', new Date(2026, 0, 1, 0, 0)), 'README (Konflikt A B C 2026-01-01 00-00)')
  const persistedBase = (id, revision) => ({ id, revision, sha256: 'ab'.repeat(32), size: 4, mtimeMs: 1 })
  const persistedRaw = JSON.stringify({
    version: 1,
    accountId: 'acct',
    cursor: 9,
    lastSyncAt: '2026-11-01T00:00:00.000Z',
    files: {
      'Mathe/Algebra.md': persistedBase('a'.repeat(64), 3),
      '.fanotes/recognition-model.json': persistedBase('b'.repeat(64), 2),
      '.fanotes/history/abc/index.json': persistedBase('c'.repeat(64), 7),
      '.fanotes/trash/gone.md': persistedBase('d'.repeat(64), 1),
      '.fanotes/onboarding.json': persistedBase('e'.repeat(64), 1),
    },
    conflicts: [],
    pendingDeletes: [],
    skipped: [],
  })
  const persisted = loadPersistedSyncState(persistedRaw, 'acct')
  assert.deepEqual(Object.keys(persisted.files).sort(), [
    '.fanotes/history/abc/index.json',
    '.fanotes/recognition-model.json',
    'Mathe/Algebra.md',
  ])
  assert.equal(persisted.files['.fanotes/history/abc/index.json'].revision, 7)
  assert.equal(persisted.cursor, 9)
  assert.equal(Object.keys(loadPersistedSyncState(persistedRaw, 'other').files).length, 0)

  // ── Two devices, one account ───────────────────────────────────────────
  const hostA = createFakeHost('a')
  hostA.put('Mathe/Algebra.md', '# Algebra\n\nErste Fassung.')
  hostA.put('Mathe/Algebra.famd', '{"schema":"fanotes-famd-v1"}')
  hostA.put('.fanotes/folder-colors.json', '{"version":1,"colors":{"Mathe":"#ff0000"}}')
  hostA.put('.fanotes/history/abc/index.json', '{"local":true}')
  hostA.put('Physik/Bild.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]))
  const A = createEngine(hostA, 'Laptop')
  await A.engine.start()
  assert.equal(A.engine.getState().status, 'signed-out')
  await assert.rejects(A.engine.register('fabio@example.com', 'kurz'), /mindestens 10 Zeichen/u)
  await A.engine.register('Fabio@Example.com', 'korrektes pferd batterie')
  assert.equal(A.engine.getState().account.email, 'fabio@example.com')
  await assert.rejects(
    A.engine.register('fabio@example.com', 'korrektes pferd batterie'),
    (error) => error instanceof Error && error.message === 'E-Mail-Adresse oder Passwort stimmen nicht.' && !error.message.includes('bereits ein Konto'),
    'eine bestehende Adresse darf bei der Registrierung nicht bestätigt werden',
  )
  assert.equal(A.engine.getState().account.email, 'fabio@example.com')
  await A.engine.syncNow()
  assert.equal(A.engine.getState().status, 'idle', A.engine.getState().error)
  assert.equal(A.engine.getState().trackedFiles, 4, 'history is excluded, everything else uploaded')
  const info = await A.engine.refreshAccount()
  assert.equal(info.usage.files, 4)
  assert.equal(info.devices.length, 1)
  assert.equal(info.devices[0].name, 'Laptop')

  await assert.rejects(new SyncEngine(new SyncApi(ORIGIN)).login('fabio@example.com', 'x'), /Sync steht in dieser Umgebung/u)

  // ── Transport: a dropped request is repeated once, but only when repeating is side-effect free ──
  {
    const calls = []
    const flakyFetch = (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`)
      if (calls.length % 2 === 1) return Promise.reject(new TypeError('Failed to fetch'))
      return fetch(input, init)
    }
    const flaky = new SyncApi(ORIGIN, flakyFetch)
    const { kdf } = await flaky.prelogin('fabio@example.com')
    assert.ok(kdf.salt, 'prelogin survives one dropped request')
    assert.deepEqual(calls, ['POST /api/v1/sync/prelogin', 'POST /api/v1/sync/prelogin'])
    calls.length = 0
    const session = { accountId: 'x', deviceId: 'y', token: 'z', email: 'fabio@example.com' }
    await assert.rejects(flaky.account(session), (error) => error.status === 401, 'GET is retried and then reports the server answer')
    assert.equal(calls.length, 2)
    calls.length = 0
    await assert.rejects(flaky.register({ email: 'x@example.com', authKey: 'a', kdf, vaultKeyWrap: {}, device: { name: 'n', platform: 'p' } }), (error) => error.status === 0 && error.offline, 'register is never repeated')
    assert.equal(calls.length, 1)
    const alwaysDown = new SyncApi(ORIGIN, () => Promise.reject(new TypeError('Failed to fetch')))
    await assert.rejects(alwaysDown.prelogin('fabio@example.com'), (error) => error.offline)
  }

  const hostB = createFakeHost('b')
  const B = createEngine(hostB, 'Tablet')
  await B.engine.start()
  await assert.rejects(B.engine.login('fabio@example.com', 'falsches passwort!'), /E-Mail-Adresse oder Passwort/u)
  await assert.rejects(B.engine.login('niemand@example.com', 'korrektes pferd batterie'), /E-Mail-Adresse oder Passwort/u)
  await B.engine.login('fabio@example.com', 'korrektes pferd batterie')
  await B.engine.syncNow()
  assert.equal(B.engine.getState().status, 'idle', B.engine.getState().error)
  assert.equal(hostB.text('Mathe/Algebra.md'), '# Algebra\n\nErste Fassung.')
  assert.equal(hostB.text('Mathe/Algebra.famd'), '{"schema":"fanotes-famd-v1"}')
  assert.equal(hostB.text('.fanotes/folder-colors.json'), '{"version":1,"colors":{"Mathe":"#ff0000"}}')
  assert.deepEqual([...hostB.files.get('Physik/Bild.png').bytes], [0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5])
  assert.ok(!hostB.files.has('.fanotes/history/abc/index.json'))
  assert.equal(B.events.applied.length, 1)
  assert.equal(B.events.applied[0].written.length, 4)

  // The server only ever saw ciphertext and opaque ids.
  {
    const { readdirSync } = await import('node:fs')
    const accountsDirectory = join(dataDirectory, 'accounts')
    const [accountId] = readdirSync(accountsDirectory)
    const log = readFileSync(join(accountsDirectory, accountId, 'changes.jsonl'), 'utf8')
    assert.ok(!log.includes('Algebra') && !log.includes('Mathe') && !log.includes('folder-colors'), 'no plaintext path reaches the server')
    const account = JSON.parse(readFileSync(join(accountsDirectory, accountId, 'account.json'), 'utf8'))
    assert.ok(!JSON.stringify(account).includes('korrektes pferd'), 'no password reaches the server')
    assert.equal(account.email, 'fabio@example.com')
    for (const blob of readdirSync(join(accountsDirectory, accountId, 'blobs'))) {
      const bytes = readFileSync(join(accountsDirectory, accountId, 'blobs', blob))
      assert.ok(!bytes.includes('Erste Fassung') && !bytes.includes('fanotes-famd'), 'blobs are encrypted')
    }
  }

  // Edit on B → arrives on A.
  hostB.put('Mathe/Algebra.md', '# Algebra\n\nZweite Fassung vom Tablet.')
  await B.engine.syncNow()
  await A.engine.syncNow()
  assert.equal(hostA.text('Mathe/Algebra.md'), '# Algebra\n\nZweite Fassung vom Tablet.')
  assert.deepEqual(A.events.applied.at(-1), { written: ['Mathe/Algebra.md'], removed: [] })

  // Same text saved again on A (editor re-save): nothing new is uploaded.
  const before = (await A.engine.refreshAccount()).revision
  hostA.put('Mathe/Algebra.md', '# Algebra\n\nZweite Fassung vom Tablet.')
  await A.engine.syncNow()
  assert.equal((await A.engine.refreshAccount()).revision, before, 'identical content → no upload')

  // Concurrent edits: A wins the race, B keeps its version as a conflict copy and takes A's.
  hostA.put('Mathe/Algebra.md', '# Algebra\n\nLaptop-Fassung.')
  hostB.put('Mathe/Algebra.md', '# Algebra\n\nTablet-Fassung.')
  await A.engine.syncNow()
  await B.engine.syncNow()
  assert.equal(B.engine.getState().status, 'idle', B.engine.getState().error)
  assert.equal(hostB.text('Mathe/Algebra.md'), '# Algebra\n\nLaptop-Fassung.')
  const copies = [...hostB.files.keys()].filter((path) => path.startsWith('Mathe/Algebra (Konflikt Tablet '))
  assert.equal(copies.length, 1, 'exactly one conflict copy')
  assert.equal(hostB.text(copies[0]), '# Algebra\n\nTablet-Fassung.')
  assert.equal(B.events.conflicts.length, 1)
  assert.equal(B.engine.getState().conflicts.length, 1)
  await B.engine.syncNow()
  await A.engine.syncNow()
  assert.equal(hostA.text(copies[0]), '# Algebra\n\nTablet-Fassung.', 'the conflict copy reaches the other device too')

  // Hausaufgaben.md: concurrent edits merge task by task (newest updatedAt wins), no conflict copy.
  {
    const task = (id, done, updatedAt) => ({ id, title: id, notes: '', subject: '', dueDate: null, dueTime: null, done, kind: 'homework', priority: 'normal', createdAt: '2026-10-01T00:00:00.000Z', updatedAt })
    const doc = (...tasks) => homework.serializeHomeworkMarkdown({ version: 1, tasks })
    hostA.put('Hausaufgaben.md', doc(task('x', false, '2026-10-01T10:00:00.000Z'), task('y', false, '2026-10-01T10:00:00.000Z')))
    await A.engine.syncNow()
    await B.engine.syncNow()
    assert.equal(homework.parseHomeworkMarkdown(hostB.text('Hausaufgaben.md')).tasks.length, 2)
    // A (Kanti+) ticks x later; B (FaNotes) ticks y later than A's y and adds z.
    hostA.put('Hausaufgaben.md', doc(task('x', true, '2026-10-02T10:00:00.000Z'), task('y', false, '2026-10-01T10:00:00.000Z')))
    hostB.put('Hausaufgaben.md', doc(task('x', false, '2026-10-01T10:00:00.000Z'), task('y', true, '2026-10-02T09:00:00.000Z'), task('z', false, '2026-10-02T09:00:00.000Z')))
    const conflictsBefore = B.events.conflicts.length
    await A.engine.syncNow()
    await B.engine.syncNow()
    await A.engine.syncNow()
    await B.engine.syncNow()
    for (const host of [hostA, hostB]) {
      const tasks = new Map(homework.parseHomeworkMarkdown(host.text('Hausaufgaben.md')).tasks.map((item) => [item.id, item]))
      assert.deepEqual([...tasks.keys()].sort(), ['x', 'y', 'z'], 'union of tasks, none lost')
      assert.equal(tasks.get('x').done, true, 'the later tick on A reaches B')
      assert.equal(tasks.get('y').done, true, 'the later tick on B reaches A')
    }
    assert.equal([...hostA.files.keys(), ...hostB.files.keys()].filter((path) => path.startsWith('Hausaufgaben (Konflikt')).length, 0, 'no conflict copy for the homework note')
    assert.equal(B.events.conflicts.length, conflictsBefore)
    // The pure merge: ties prefer done, then remote; publishedIds union; unparseable files are not merged.
    const at = '2026-10-02T10:00:00.000Z'
    const tie = homework.mergeHomeworkDocuments(
      { version: 1, tasks: [task('t', true, at), task('u', false, at)], publishedIds: ['p1'] },
      { version: 1, tasks: [task('t', false, at), { ...task('u', false, at), title: 'remote' }], publishedIds: ['p2'] },
    )
    assert.equal(tie.tasks.find((item) => item.id === 't').done, true)
    assert.equal(tie.tasks.find((item) => item.id === 'u').title, 'remote')
    assert.deepEqual([...tie.publishedIds].sort(), ['p1', 'p2'])
    assert.equal(homework.mergeHomeworkMarkdownBytes(encoder.encode(doc()), encoder.encode('<!-- fanotes-homework-v1 {')), null)
  }

  // Delete on A → gone on B; delete + concurrent edit keeps the edit.
  hostA.files.delete('Physik/Bild.png')
  A.engine.markDeleted('Physik/Bild.png')
  await A.engine.syncNow()
  await B.engine.syncNow()
  assert.ok(!hostB.files.has('Physik/Bild.png'))
  assert.deepEqual(B.events.applied.at(-1), { written: [], removed: ['Physik/Bild.png'] })
  hostA.files.delete(copies[0])
  A.engine.markDeleted(copies[0])
  hostB.put(copies[0], 'doch behalten')
  await A.engine.syncNow()
  await B.engine.syncNow()
  assert.equal(hostB.text(copies[0]), 'doch behalten', 'a local edit survives a remote delete')
  await B.engine.syncNow()
  await A.engine.syncNow()
  assert.equal(hostA.text(copies[0]), 'doch behalten', 'and is re-uploaded on top of the tombstone')

  // A missing file is not a delete. The server copy is written back.
  hostA.put('Physik/Bleibt.png', encoder.encode('bleibt'))
  await A.engine.syncNow()
  await B.engine.syncNow()
  assert.equal(hostB.text('Physik/Bleibt.png'), 'bleibt')
  hostA.files.delete('Physik/Bleibt.png')
  await A.engine.syncNow()
  assert.equal(hostA.text('Physik/Bleibt.png'), 'bleibt', 'a vanished file is restored')
  await B.engine.syncNow()
  assert.equal(hostB.text('Physik/Bleibt.png'), 'bleibt', 'the other device still has it')

  // A note skipped while its folder was excluded is fetched once the folder is included.
  {
    let hide = true
    const hostD = createFakeHost('skip')
    const D = createEngine(hostD, 'Web', { excludedPrefixes: () => (hide ? ['Notizen'] : []) })
    hostA.put('Notizen/Uebersprungen.md', '# spaeter')
    await A.engine.syncNow()
    await D.engine.login('fabio@example.com', 'korrektes pferd batterie')
    await D.engine.syncNow()
    assert.equal(hostD.text('Notizen/Uebersprungen.md'), null, 'excluded notes are not applied')
    hide = false
    await D.engine.syncNow()
    assert.equal(hostD.text('Notizen/Uebersprungen.md'), '# spaeter', 'a previously skipped note is fetched again')
    D.engine.dispose()
  }

  // A note that is being edited is not overwritten; it arrives once the editor is quiet.
  let busy = true
  // `busyAfter`: the file turns busy only after this many checks (an editor starts on it during the download).
  let busyAfter = -1
  let checks = 0
  const C = createEngine(hostB, 'Tablet', { busy: (path) => {
    if (path !== 'Mathe/Algebra.md') return false
    if (busyAfter >= 0) return checks++ >= busyAfter
    return busy
  } })
  await C.engine.start()
  assert.equal(C.engine.getState().status, 'idle', 'session restored from the host secrets')
  assert.equal(C.engine.getState().account.email, 'fabio@example.com')
  hostA.put('Mathe/Algebra.md', '# Algebra\n\nDritte Fassung.')
  await A.engine.syncNow()
  await C.engine.syncNow()
  assert.equal(hostB.text('Mathe/Algebra.md'), '# Algebra\n\nLaptop-Fassung.', 'busy note untouched')
  busy = false
  await C.engine.syncNow()
  assert.equal(hostB.text('Mathe/Algebra.md'), '# Algebra\n\nDritte Fassung.', 'applied once the note is idle')

  // The file was free when the pull looked at it, but an editor started on it while it downloaded:
  // the write is put off, not done over the editor's file.
  hostA.put('Mathe/Algebra.md', '# Algebra\n\nWährend des Downloads.')
  await A.engine.syncNow()
  busyAfter = 1
  checks = 0
  await C.engine.syncNow()
  assert.ok(checks >= 2, 'busy was asked again before writing')
  assert.equal(hostB.text('Mathe/Algebra.md'), '# Algebra\n\nDritte Fassung.', 'not written while the editor holds it')
  busyAfter = -1
  busy = false
  await C.engine.syncNow()
  assert.equal(hostB.text('Mathe/Algebra.md'), '# Algebra\n\nWährend des Downloads.', 'written on the next cycle')
  hostA.put('Mathe/Algebra.md', '# Algebra\n\nDritte Fassung.')
  await A.engine.syncNow()
  await C.engine.syncNow()

  // A file that is here but cannot be read (permissions, locked) is not "missing":
  // the server's version is not written over it; it arrives once it can be read.
  const readable = hostB.read
  hostB.read = async (path) => { if (path === 'Mathe/Algebra.md') throw new Error('EACCES'); return readable(path) }
  hostA.put('Mathe/Algebra.md', '# Algebra\n\nVierte Fassung.')
  await A.engine.syncNow()
  await C.engine.syncNow()
  assert.equal(hostB.text('Mathe/Algebra.md'), '# Algebra\n\nDritte Fassung.', 'unreadable local note left alone')
  hostB.read = readable
  await C.engine.syncNow()
  assert.equal(hostB.text('Mathe/Algebra.md'), '# Algebra\n\nVierte Fassung.', 'applied once it can be read')
  hostA.put('Mathe/Algebra.md', '# Algebra\n\nDritte Fassung.')
  await A.engine.syncNow()
  await C.engine.syncNow()
  assert.equal(hostB.text('Mathe/Algebra.md'), '# Algebra\n\nDritte Fassung.')

  // A large first sync runs into the server's request budget (HTTP 429). That is a pause, not
  // an error: no error state, and the cycle goes on by itself after the server's retryAfter,
  // even with automatic sync off.
  {
    const realFetch = globalThis.fetch
    let throttle = true
    globalThis.fetch = (input, init) => {
      if (throttle && String(input).includes('/api/v1/sync/') && !String(input).endsWith('/prelogin')) {
        throttle = false
        return Promise.resolve(new Response(JSON.stringify({ error: 'Zu viele Anfragen. Bitte später erneut versuchen.', retryAfter: 1 }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '1' } }))
      }
      return realFetch(input, init)
    }
    try {
      hostA.put('Mathe/Gedrosselt.md', '# Gedrosselt')
      await A.engine.syncNow()
      const paused = A.engine.getState()
      assert.equal(paused.status, 'paused', 'a throttled cycle shows as a pause, not as in sync')
      assert.equal(paused.error, null, 'throttling is not an error')
      assert.ok(paused.pausedUntil > Date.now() - 50 && paused.pausedUntil <= Date.now() + 65_000, 'the end of the pause is published')
      assert.ok(paused.log.some((entry) => /bremst kurz/u.test(entry.text)), 'the pause is logged')
      let calls = 0
      const counting = globalThis.fetch
      globalThis.fetch = (input, init) => { calls += 1; return counting(input, init) }
      await A.engine.syncNow('focus')
      assert.equal(calls, 0, 'automatic triggers wait while the server throttles')
      for (let waited = 0; waited < 4_000 && A.engine.getState().lastSyncAt === paused.lastSyncAt; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100))
      assert.notEqual(A.engine.getState().lastSyncAt, paused.lastSyncAt, 'the cycle resumed by itself after retryAfter')
      assert.ok(calls > 0)
      await C.engine.syncNow()
      assert.equal(hostB.text('Mathe/Gedrosselt.md'), '# Gedrosselt', 'the resumed cycle uploaded the note')
      assert.equal(A.engine.getState().status, 'idle', A.engine.getState().error)
    } finally {
      globalThis.fetch = realFetch
    }
  }

  // Password change re-wraps the same vault secret; other sessions are signed out.
  await A.engine.changePassword('korrektes pferd batterie', 'neues sicheres passwort 42')
  await assert.rejects(A.engine.changePassword('korrektes pferd batterie', 'irgendwas anderes 99'), /aktuelle Passwort/u)
  await C.engine.syncNow()
  assert.equal(C.engine.getState().status, 'signed-out')
  assert.equal(C.events.signedOut.length, 1)
  assert.equal(hostB.store.secrets, null, 'revoked session is forgotten locally')
  assert.ok(hostB.files.has('Mathe/Algebra.md'), 'files stay on the device')
  await C.engine.login('fabio@example.com', 'neues sicheres passwort 42')
  await C.engine.syncNow()
  assert.equal(C.engine.getState().status, 'idle', C.engine.getState().error)
  assert.equal(hostB.text('Mathe/Algebra.md'), '# Algebra\n\nDritte Fassung.', 'same files, same content, no conflict copies after re-login')
  assert.equal([...hostB.files.keys()].filter((path) => path.includes('(Konflikt')).length, 1)

  // A famd whose only change is the timestamp is not uploaded again.
  const inkFamd = (updatedAt) => {
    const payload = {
      schema: 'fanotes-famd-v1',
      updatedAt,
      ink: { strokes: [{ points: Array.from({ length: 30 }, (_, index) => ({ x: index, y: 1 })) }], updatedAt },
      worksheets: [],
    }
    const json = JSON.stringify(payload)
    return `# Seite\n\n${'Wort '.repeat(40)}\n\n<!-- fanotes-famd:v1 chars=${json.length} -->\n${json}\n`
  }
  const blankFamd = () => {
    const payload = { schema: 'fanotes-famd-v1', updatedAt: '2026-03-03T00:00:00.000Z', ink: null, worksheets: [] }
    const json = JSON.stringify(payload)
    return `<!-- fanotes-famd:v1 chars=${json.length} -->\n${json}\n`
  }
  hostA.put('Notizen/Seite.famd', inkFamd('2026-01-01T00:00:00.000Z'))
  await A.engine.syncNow()
  await C.engine.syncNow()
  const keptNote = hostB.text('Notizen/Seite.famd')
  assert.ok(keptNote.includes('"points"'))
  const beforeStamp = (await A.engine.refreshAccount()).revision
  hostA.put('Notizen/Seite.famd', inkFamd('2026-02-02T00:00:00.000Z'))
  await A.engine.syncNow()
  assert.equal((await A.engine.refreshAccount()).revision, beforeStamp, 'a timestamp-only famd is not uploaded')
  await C.engine.syncNow()
  assert.equal(hostB.text('Notizen/Seite.famd'), keptNote)

  // A failed load is not uploaded. The server copy comes back.
  hostA.put('Notizen/Seite.famd', '<!-- fanotes-famd:v1 chars=20 -->\n{"truncated":')
  await A.engine.syncNow()
  assert.ok(hostA.text('Notizen/Seite.famd').includes('"points"'), 'a truncated famd is not uploaded')
  await C.engine.syncNow()
  assert.ok(hostB.text('Notizen/Seite.famd').includes('"points"'))

  // A blank local file is not uploaded over the note. It is kept as a conflict copy.
  const blank = blankFamd()
  assert.ok(keptNote.length > blank.length + 64)
  hostB.put('Notizen/Seite.famd', blank)
  await C.engine.syncNow()
  assert.equal(hostB.text('Notizen/Seite.famd'), keptNote, 'the server copy is written back')
  const blankCopies = [...hostB.files.keys()].filter((path) => path.startsWith('Notizen/Seite (Konflikt Tablet '))
  assert.equal(blankCopies.length, 1, 'the blank stays beside the note')
  assert.equal(hostB.text(blankCopies[0]), blank)
  await A.engine.syncNow()
  assert.ok(hostA.text('Notizen/Seite.famd').includes('"points"'), 'the other device still has the ink')
  await C.engine.syncNow()
  await A.engine.syncNow()
  assert.equal(hostA.text(blankCopies[0]), blank, 'the conflict copy is uploaded on the next sync')

  // An explicit clear is allowed, and the previous blob stays on the server.
  const revisionSizes = () => {
    const accountsDirectory = join(dataDirectory, 'accounts')
    const [accountId] = readdirSync(accountsDirectory)
    const revisionsRoot = join(accountsDirectory, accountId, 'revisions')
    const sizes = []
    let names
    try { names = readdirSync(revisionsRoot) } catch { return sizes }
    for (const fileId of names) {
      for (const name of readdirSync(join(revisionsRoot, fileId))) {
        sizes.push(statSync(join(revisionsRoot, fileId, name)).size)
      }
    }
    return sizes
  }
  const archivedBefore = revisionSizes()
  A.engine.markCleared('Notizen/Seite.famd')
  hostA.put('Notizen/Seite.famd', blank)
  await A.engine.syncNow()
  assert.equal(hostA.text('Notizen/Seite.famd'), blank)
  const archivedAfter = revisionSizes()
  assert.ok(archivedAfter.length > archivedBefore.length, 'the previous blob is kept in the revision archive')
  assert.ok(Math.max(...archivedAfter) > Math.max(0, ...archivedBefore))


  // ── No version is lost to a stale device ──────────────────────────────
  // A device that deletes a folder after another device published a newer
  // version of a note in it: the newer version stays everywhere, the other
  // notes are deleted as asked.
  {
    hostA.put('Stale/Notiz.md', '# Notiz\n\nAlt.')
    hostA.put('Stale/Andere.md', '# Andere\n\nAlt.')
    await A.engine.syncNow()
    await C.engine.syncNow()
    assert.equal(hostB.text('Stale/Notiz.md'), '# Notiz\n\nAlt.')
    hostA.put('Stale/Notiz.md', '# Notiz\n\nNeu vom Laptop.')
    await A.engine.syncNow()
    hostB.files.delete('Stale/Notiz.md')
    hostB.files.delete('Stale/Andere.md')
    C.engine.markDeleted('Stale')
    await C.engine.syncNow()
    assert.equal(C.engine.getState().status, 'idle', C.engine.getState().error)
    assert.equal(hostB.text('Stale/Notiz.md'), '# Notiz\n\nNeu vom Laptop.', 'the newer version comes back on the stale device')
    assert.ok(!hostB.files.has('Stale/Andere.md'), 'the untouched note is deleted as asked')
    await A.engine.syncNow()
    assert.equal(hostA.text('Stale/Notiz.md'), '# Notiz\n\nNeu vom Laptop.', 'the newer version survives where it was written')
    assert.ok(!hostA.files.has('Stale/Andere.md'))
    // Later the restored note goes missing without a delete (a linked folder
    // offline, a scan that missed it). The used-up delete mark must not turn
    // that into a delete on every device; the note is restored instead.
    hostB.files.delete('Stale/Notiz.md')
    await C.engine.syncNow()
    assert.equal(hostB.text('Stale/Notiz.md'), '# Notiz\n\nNeu vom Laptop.', 'an old delete mark does not delete a note later')
    await A.engine.syncNow()
    assert.equal(hostA.text('Stale/Notiz.md'), '# Notiz\n\nNeu vom Laptop.')
  }
  // The same when the pull missed the newer version: the delete names the
  // revision this device saw, the server refuses it, and the newer version is restored.
  {
    hostA.put('Stale/Zweite.md', '# Zweite\n\nAlt.')
    await A.engine.syncNow()
    await C.engine.syncNow()
    hostA.put('Stale/Zweite.md', '# Zweite\n\nNeu.')
    await A.engine.syncNow()
    hostB.files.delete('Stale/Zweite.md')
    C.engine.markDeleted('Stale/Zweite.md')
    const api = C.engine.api
    const realChanges = api.changes.bind(api)
    api.changes = async (_session, since) => {
      api.changes = realChanges
      return { entries: [], nextSince: since, more: false }
    }
    await C.engine.syncNow()
    assert.equal(api.changes, realChanges, 'the stale pull ran')
    assert.equal(hostB.text('Stale/Zweite.md'), '# Zweite\n\nNeu.', 'the server refused the stale delete; the newer version is back')
    await A.engine.syncNow()
    assert.equal(hostA.text('Stale/Zweite.md'), '# Zweite\n\nNeu.', 'and it is still on the device that wrote it')
    hostB.files.delete('Stale/Zweite.md')
    await C.engine.syncNow()
    assert.equal(hostB.text('Stale/Zweite.md'), '# Zweite\n\nNeu.', 'the refused delete leaves no mark behind')
  }
  // Two conflicts on one note within a minute: the second copy gets a number, the first is not overwritten.
  {
    hostA.put('Doppelt.md', '# Doppelt\n\nA1')
    await A.engine.syncNow()
    await C.engine.syncNow()
    for (const round of [2, 3]) {
      hostA.put('Doppelt.md', `# Doppelt\n\nA${round}`)
      hostB.put('Doppelt.md', `# Doppelt\n\nB${round}`)
      await A.engine.syncNow()
      await C.engine.syncNow()
    }
    const twins = [...hostB.files.keys()].filter((path) => path.startsWith('Doppelt (Konflikt Tablet ')).sort()
    assert.equal(twins.length, 2, 'two copies')
    assert.deepEqual(twins.map((path) => hostB.text(path)).sort(), ['# Doppelt\n\nB2', '# Doppelt\n\nB3'], 'both local versions are kept')
  }

  // ── Resolving a conflict ───────────────────────────────────────────────
  const { conflictFingerprint, parseConflictCopyPath, groupConflicts, keptVersionPath } = conflictsModule
  assert.equal(parseConflictCopyPath('Mathe/Algebra (Konflikt Mein Laptop 2026-11-15 09-04).md').originalPath, 'Mathe/Algebra.md')
  assert.equal(parseConflictCopyPath('Mathe/Algebra (Konflikt Tablet 2026-11-15 09-04 2).famd').device, 'Tablet')
  assert.equal(parseConflictCopyPath('Mathe/Algebra.md'), null)
  assert.equal(keptVersionPath('A (Konflikt Tablet 2026-11-15 09-04).md'), 'A (Fassung Tablet 2026-11-15 09-04).md')
  {
    const grouped = groupConflicts(new Set(['N.md', 'N.famd', 'N (Konflikt X 2026-01-01 10-00).md', 'N (Konflikt X 2026-01-01 10-00).famd', 'Solo (Konflikt X 2026-01-01 10-00).pdf']))
    assert.equal(grouped.length, 2)
    const note = grouped.find((group) => group.title === 'N')
    assert.equal(note.pairs.length, 2, '.md and .famd of one note are one conflict')
    assert.equal(note.path, 'N.md')
    assert.equal(grouped.find((group) => group.title === 'Solo').originalMissing, true)
  }
  const expectedFor = async (host, group) => {
    const out = {}
    for (const pair of group.pairs) {
      for (const path of [pair.path, pair.copyPath]) out[path] = await conflictFingerprint(path, host.files.has(path) ? host.files.get(path).bytes : null)
    }
    return out
  }
  const makeConflict = async (path, laptop, tablet) => {
    hostA.put(path, laptop.base)
    await A.engine.syncNow()
    await C.engine.syncNow()
    hostA.put(path, laptop.next)
    hostB.put(path, tablet)
    await A.engine.syncNow()
    await C.engine.syncNow()
    await A.engine.syncNow()
    const stem = path.replace(/\.[^.]+$/u, '')
    const groups = await A.engine.listConflicts()
    const group = groups.find((candidate) => candidate.copyPath.startsWith(`${stem} (Konflikt Tablet `))
    assert.ok(group, `the laptop finds the tablet's copy of ${path} by its name`)
    return group
  }
  // Keep the copy, on a device that did not make it. A handwriting note: the
  // chosen version's ink must arrive byte for byte, not just its text.
  {
    const tabletInk = inkFamd('2026-04-04T00:00:00.000Z').replace('# Seite', '# Tablet-Seite')
    const group = await makeConflict('Konflikt/Heft.famd', { base: inkFamd('2026-03-01T00:00:00.000Z'), next: inkFamd('2026-03-02T00:00:00.000Z').replace('Wort ', 'Laptop ') }, tabletInk)
    assert.equal(group.device, 'Tablet')
    const expected = await expectedFor(hostA, group)
    const result = await A.engine.resolveConflict(group, 'copy', expected)
    assert.equal(result.status, 'resolved', result.message)
    assert.equal(hostA.text('Konflikt/Heft.famd'), tabletInk, 'the chosen version, ink included, is the note now')
    assert.ok(!hostA.files.has(group.copyPath), 'the copy is gone here')
    await C.engine.syncNow()
    assert.equal(hostB.text('Konflikt/Heft.famd'), tabletInk, 'and on the other device')
    assert.ok(!hostB.files.has(group.copyPath), 'the copy is gone there too')
    assert.equal((await C.engine.listConflicts()).filter((candidate) => candidate.title === 'Heft').length, 0)
    await A.engine.syncNow()
    assert.equal(hostA.text('Konflikt/Heft.famd'), tabletInk, 'nothing flips back')
  }
  // Keep the original: the copy is removed everywhere, the note is untouched.
  {
    const group = await makeConflict('Konflikt/Plan.md', { base: '# Plan\n\nAlt.', next: '# Plan\n\nLaptop.' }, '# Plan\n\nTablet.')
    const result = await C.engine.resolveConflict(group, 'original', await expectedFor(hostB, group))
    assert.equal(result.status, 'resolved', result.message)
    assert.equal(hostB.text('Konflikt/Plan.md'), '# Plan\n\nLaptop.')
    assert.ok(!hostB.files.has(group.copyPath))
    await A.engine.syncNow()
    assert.equal(hostA.text('Konflikt/Plan.md'), '# Plan\n\nLaptop.')
    assert.ok(!hostA.files.has(group.copyPath), 'the copy is removed on the other device')
  }
  // Keep both: the copy becomes an ordinary file on every device.
  {
    const group = await makeConflict('Konflikt/Liste.md', { base: '# Liste\n\nAlt.', next: '# Liste\n\nLaptop.' }, '# Liste\n\nTablet.')
    const result = await A.engine.resolveConflict(group, 'both', await expectedFor(hostA, group))
    assert.equal(result.status, 'resolved', result.message)
    const kept = keptVersionPath(group.copyPath)
    assert.equal(hostA.text(kept), '# Liste\n\nTablet.')
    assert.equal(hostA.text('Konflikt/Liste.md'), '# Liste\n\nLaptop.')
    await C.engine.syncNow()
    assert.equal(hostB.text(kept), '# Liste\n\nTablet.')
    assert.ok(!hostB.files.has(group.copyPath))
    assert.equal((await A.engine.listConflicts()).filter((candidate) => candidate.title === 'Liste').length, 0)
  }
  // A version that changed after the preview is not decided on: nothing is touched.
  {
    const group = await makeConflict('Konflikt/Brief.md', { base: '# Brief\n\nAlt.', next: '# Brief\n\nLaptop.' }, '# Brief\n\nTablet.')
    const expected = await expectedFor(hostA, group)
    hostB.put('Konflikt/Brief.md', '# Brief\n\nTablet hat nochmal geändert.')
    await C.engine.syncNow()
    const result = await A.engine.resolveConflict(group, 'copy', expected)
    assert.equal(result.status, 'changed')
    assert.equal(hostA.text('Konflikt/Brief.md'), '# Brief\n\nTablet hat nochmal geändert.', 'the newer edit arrived and stays')
    assert.equal(hostA.text(group.copyPath), '# Brief\n\nTablet.', 'the copy stays')
    await assert.rejects(A.engine.resolveConflict(group, 'original', { ...expected, 'Konflikt/Brief.md': null }), /Originaldatei fehlt/u)
  }
  // A version that exists only on this device (an edit the sync could not upload) is never replaced or removed.
  {
    const group = await makeConflict('Konflikt/Notizblock.md', { base: '# Block\n\nAlt.', next: '# Block\n\nLaptop.' }, '# Block\n\nTablet.')
    const api = A.engine.api
    const realUpload = api.upload.bind(api)
    // The laptop edits the note again, and that upload fails (quota, size): the edit is only here.
    api.upload = async (...args) => { const { SyncApiError: Failure } = await vite.ssrLoadModule('/src/lib/sync/api.ts'); throw new Failure(507, 'voll') }
    hostA.put('Konflikt/Notizblock.md', '# Block\n\nNur auf dem Laptop.')
    const expected = await expectedFor(hostA, group)
    await assert.rejects(A.engine.resolveConflict(group, 'copy', expected), /noch nicht im Sync/u)
    api.upload = realUpload
    assert.equal(hostA.text('Konflikt/Notizblock.md'), '# Block\n\nNur auf dem Laptop.', 'the local-only edit is untouched')
    assert.equal(hostA.text(group.copyPath), '# Block\n\nTablet.', 'and so is the copy')
    await A.engine.syncNow()
  }
  // A note being edited is not replaced underneath the editor.
  {
    const group = (await A.engine.listConflicts()).find((candidate) => candidate.title === 'Brief')
    busy = true
    const busyGroup = { ...group, pairs: [{ path: 'Mathe/Algebra.md', copyPath: group.copyPath }] }
    await assert.rejects(C.engine.resolveConflict(busyGroup, 'copy', {}), /gerade geöffnet/u)
    busy = false
  }

  // A write that names an older base revision does not replace the body.
  {
    const session = A.engine.getSession()
    const direct = new SyncApi(ORIGIN)
    const id = 'ab'.repeat(32)
    const first = new Uint8Array(64).fill(7)
    const second = new Uint8Array(64).fill(8)
    const meta = Buffer.from(new Uint8Array(32).fill(3)).toString('base64')
    await direct.upload(session, id, 0, meta, await crypto.sha256Hex(first), first, { blank: false })
    await assert.rejects(
      direct.upload(session, id, 0, meta, await crypto.sha256Hex(second), second, { blank: false }),
      (error) => error.status === 409,
    )
    const downloaded = await direct.download(session, id)
    assert.ok(!('deleted' in downloaded))
    assert.deepEqual(downloaded.blob, first)
  }

  // Device management + logout + account deletion.
  const devices = (await A.engine.refreshAccount()).devices
  assert.equal(devices.length, 2, 'password change also drops devices whose sessions were revoked')
  const tablet = devices.find((device) => !device.current)
  assert.equal(tablet.id, C.engine.getState().account.deviceId)
  await A.engine.removeDevice(tablet.id)
  await C.engine.syncNow()
  assert.equal(C.engine.getState().status, 'signed-out')
  await A.engine.logout()
  assert.equal(A.engine.getState().status, 'signed-out')
  assert.equal(hostA.store.secrets, null)
  await A.engine.login('fabio@example.com', 'neues sicheres passwort 42')
  await assert.rejects(A.engine.deleteAccount('falsch falsch falsch'), /Passwort stimmt nicht/u)
  await A.engine.deleteAccount('neues sicheres passwort 42')
  await assert.rejects(A.engine.login('fabio@example.com', 'neues sicheres passwort 42'), /E-Mail-Adresse oder Passwort/u)
  A.engine.dispose(); B.engine.dispose(); C.engine.dispose()

  // ── 409s are resolved from the entry the server sends back ─────────────
  // The production laptop re-sent six notes on every cycle for weeks: their
  // server entries were tombstones older than its pull cursor, so the pull that
  // was meant to resolve the 409 never brought them. A ProbeApi records every
  // upload and can play a stricter (older) server.
  {
    class ProbeApi extends SyncApi {
      constructor() { super(ORIGIN); this.uploads = []; this.refuse = null; this.corrupt = null }
      async download(session, id) {
        const result = await super.download(session, id)
        if (!this.corrupt?.has(id) || !result.blob) return result
        const blob = new Uint8Array(result.blob)
        blob[blob.length - 1] ^= 0xff
        return { ...result, blob }
      }
      async upload(session, id, base, ...rest) {
        const refusal = this.refuse ? await this.refuse(id, base, session) : null
        if (refusal) {
          this.uploads.push({ id, base, status: 409 })
          throw refusal
        }
        try {
          const revision = await super.upload(session, id, base, ...rest)
          this.uploads.push({ id, base, status: 200 })
          return revision
        } catch (error) {
          this.uploads.push({ id, base, status: error.status })
          throw error
        }
      }
    }
    const createProbe = (host, name) => {
      const api = new ProbeApi()
      const engine = new SyncEngine(api)
      const events = { conflicts: [], applied: [], busy: new Set() }
      engine.attach(host, { platform: 'linux', deviceName: () => name, automatic: () => false, isPathBusy: (path) => events.busy.has(path), excludedPrefixes: () => [], onConflict: (conflict) => events.conflicts.push(conflict), onApplied: (change) => events.applied.push(change) })
      return { engine, api, events }
    }
    const entryFor = async (api, session, id) => (await api.changes(session, 0)).entries.find((item) => item.id === id) ?? null
    const password = 'probe passwort fuer den sync 7'
    const hostP = createFakeHost('probe-laptop')
    const P = createProbe(hostP, 'Laptop')
    await P.engine.register('probe@example.com', password)
    const hostQ = createFakeHost('probe-tablet')
    const Q = createProbe(hostQ, 'Tablet')
    await Q.engine.login('probe@example.com', password)
    const idOf = async (path) => {
      const state = JSON.parse(hostP.store.state.get('vault-probe-laptop'))
      return state.files[path]?.id ?? null
    }

    // A short note that got shorter still syncs (deleting a line is not an empty overwrite).
    const longList = `# Einkauf\n\n${Array.from({ length: 12 }, (_, index) => `- Artikel ${index} mit etwas Text`).join('\n')}\n`
    const shortList = '# Einkauf\n\n- Artikel 0 mit etwas Text\n'
    hostP.put('Notizen/Kurz.md', longList)
    await P.engine.syncNow()
    await Q.engine.syncNow()
    assert.equal(hostQ.text('Notizen/Kurz.md'), longList)
    hostP.put('Notizen/Kurz.md', shortList)
    await P.engine.syncNow()
    assert.equal(P.api.uploads.at(-1).status, 200, 'the shorter short note is accepted')
    await Q.engine.syncNow()
    assert.equal(hostQ.text('Notizen/Kurz.md'), shortList, 'a short note that got shorter arrives on the other device')

    // A note that is a tombstone older than the cursor, while this device still has the file.
    const kept = '# Wieder da\n\nInhalt, den der Laptop noch hat.\n'
    for (const [path, strict] of [['Alt/Wieder da.md', true], ['Alt/Auch wieder da.md', false]]) {
      hostP.put(path, kept)
      await P.engine.syncNow()
      await Q.engine.syncNow()
      assert.equal(hostQ.text(path), kept)
      const id = await idOf(path)
      hostP.files.delete(path)
      P.engine.markDeleted(path)
      await P.engine.syncNow()
      await Q.engine.syncNow()
      assert.equal(hostQ.text(path), null, 'the explicit delete reached the tablet')
      // Later changes move the cursor well past the tombstone.
      hostQ.put(`Alt/Spaeter ${strict}.md`, 'spaeter')
      await Q.engine.syncNow()
      await P.engine.syncNow()
      // An older build put the file back untracked (or its delete was inferred from a missing file).
      hostP.put(path, kept)
      P.api.refuse = strict
        ? async (uploadId, base, session) => {
          if (uploadId !== id) return null
          const current = await entryFor(P.api, session, id)
          return current?.deleted && base < current.revision ? new SyncApiError(409, 'stale', current, 'stale') : null
        }
        : null
      await P.engine.syncNow()
      assert.equal(P.engine.getState().status, 'idle', P.engine.getState().error)
      const tries = P.api.uploads.filter((item) => item.id === id)
      assert.equal(tries.at(-1).status, 200, `${strict ? 'a strict' : 'this'} server takes the copy back over the tombstone`)
      const count = P.api.uploads.length
      await P.engine.syncNow()
      assert.equal(P.api.uploads.length, count, 'nothing is sent again on the next cycle')
      await Q.engine.syncNow()
      assert.equal(hostQ.text(path), kept, 'the tablet has the note again')
      P.api.refuse = null
    }

    // One damaged entry does not keep the rest of the pull, or any upload, from happening.
    {
      hostP.put('Alt/Kaputt.md', '# Kaputt\n\nkommt beschaedigt an\n')
      hostP.put('Alt/Gut.md', '# Gut\n\nkommt an\n')
      await P.engine.syncNow()
      Q.api.corrupt = new Set([await idOf('Alt/Kaputt.md')])
      hostQ.put('Alt/Vom Tablet.md', '# Vom Tablet\n')
      await Q.engine.syncNow()
      assert.equal(Q.engine.getState().status, 'idle', Q.engine.getState().error)
      assert.equal(hostQ.text('Alt/Gut.md'), '# Gut\n\nkommt an\n', 'the other entries are applied')
      assert.equal(hostQ.text('Alt/Kaputt.md'), null, 'the damaged entry is not written')
      await P.engine.syncNow()
      assert.equal(hostP.text('Alt/Vom Tablet.md'), '# Vom Tablet\n', 'the local edit was uploaded in the same cycle')
      Q.api.corrupt = null
      await Q.engine.syncNow()
      assert.equal(hostQ.text('Alt/Kaputt.md'), '# Kaputt\n\nkommt beschaedigt an\n', 'the damaged entry arrives once it is served intact')
    }

    // A stale 409 whose newer entry is older than the cursor is applied at once.
    {
      hostP.put('Alt/Liste.md', '# Liste\n\n- eins\n')
      await P.engine.syncNow()
      await Q.engine.syncNow()
      const id = await idOf('Alt/Liste.md')
      const persisted = JSON.parse(hostP.store.state.get('vault-probe-laptop'))
      const olderBase = persisted.files['Alt/Liste.md'].revision
      hostQ.put('Alt/Liste.md', '# Liste\n\n- eins\n- zwei vom Tablet\n')
      await Q.engine.syncNow()
      await P.engine.syncNow()
      assert.equal(hostP.text('Alt/Liste.md'), '# Liste\n\n- eins\n- zwei vom Tablet\n')
      // Play an older build that moved its cursor past that change without applying it.
      P.engine.dispose()
      const rewound = JSON.parse(hostP.store.state.get('vault-probe-laptop'))
      rewound.files['Alt/Liste.md'].revision = olderBase
      rewound.files['Alt/Liste.md'].contentSha256 = 'stale'
      hostP.store.state.set('vault-probe-laptop', JSON.stringify(rewound))
      const P2 = createProbe(hostP, 'Laptop')
      await P2.engine.start()
      hostP.put('Alt/Liste.md', '# Liste\n\n- eins\n- drei vom Laptop\n')
      await P2.engine.syncNow()
      assert.equal(P2.engine.getState().status, 'idle', P2.engine.getState().error)
      assert.equal(hostP.text('Alt/Liste.md'), '# Liste\n\n- eins\n- zwei vom Tablet\n', 'the newer server revision is applied in the same cycle')
      const copies = [...hostP.files.keys()].filter((path) => path.startsWith('Alt/Liste (Konflikt Laptop '))
      assert.equal(copies.length, 1, 'the local edit is kept as a conflict copy')
      assert.equal(hostP.text(copies[0]), '# Liste\n\n- eins\n- drei vom Laptop\n')
      const count = P2.api.uploads.filter((item) => item.id === id).length
      await P2.engine.syncNow()
      assert.equal(P2.api.uploads.filter((item) => item.id === id).length, count, 'the note is not sent again')
      await Q.engine.syncNow()
      assert.equal(hostQ.text(copies[0]), '# Liste\n\n- eins\n- drei vom Laptop\n', 'both versions reach the tablet')

      // A guard 409 (base current, body refused) keeps both instead of looping.
      hostP.put('Alt/Gross.md', `# Gross\n\n${'Viel Inhalt. '.repeat(600)}\n`)
      await P2.engine.syncNow()
      const big = hostP.text('Alt/Gross.md')
      const bigId = JSON.parse(hostP.store.state.get('vault-probe-laptop')).files['Alt/Gross.md'].id
      hostP.put('Alt/Gross.md', `# Gross\n\n${'Viel Inhalt. '.repeat(590)}\n`)
      P2.api.refuse = async (uploadId, base, session) => {
        if (uploadId !== bigId) return null
        return new SyncApiError(409, 'guard', await entryFor(P2.api, session, bigId), 'guard')
      }
      // While the editor still holds the note, nothing is written under it.
      const edited = hostP.text('Alt/Gross.md')
      P2.events.busy.add('Alt/Gross.md')
      await P2.engine.syncNow()
      assert.equal(hostP.text('Alt/Gross.md'), edited, 'an open note is not replaced under the editor')
      assert.equal([...hostP.files.keys()].filter((path) => path.startsWith('Alt/Gross (Konflikt')).length, 0)
      P2.events.busy.delete('Alt/Gross.md')
      await P2.engine.syncNow()
      P2.api.refuse = null
      assert.ok(P2.events.applied.some((change) => change.written.includes('Alt/Gross.md')), 'the app is told to reload the restored note')
      assert.equal(hostP.text('Alt/Gross.md'), big, 'the server copy is put back after a guard rejection')
      const guardCopies = [...hostP.files.keys()].filter((path) => path.startsWith('Alt/Gross (Konflikt Laptop '))
      assert.equal(guardCopies.length, 1, 'the refused local version stays beside the note')
      const tries = P2.api.uploads.filter((item) => item.id === bigId).length
      await P2.engine.syncNow()
      assert.equal(P2.api.uploads.filter((item) => item.id === bigId).length, tries, 'a guard rejection is not retried')
      await P2.engine.logout()
      P2.engine.dispose()
    }
    await Q.engine.logout()
    Q.engine.dispose()
  }

  // ── Review R13: the throttle pause, notes that wait, and what a failed cycle leaves behind ──
  {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const waitFor = async (check, message, limit = 8_000) => {
      for (let waited = 0; waited < limit; waited += 25) {
        if (check()) return
        await sleep(25)
      }
      assert.fail(message)
    }
    const password = 'drosselung und halten 2026'
    const clockOf = (ms) => `${String(new Date(ms).getHours()).padStart(2, '0')}:${String(new Date(ms).getMinutes()).padStart(2, '0')}`
    /** An engine whose requests the test can count, slow down, or answer with HTTP 429 (the server's request budget). */
    const createSteered = (host, name, hooks = {}) => {
      const steer = {
        counts: { changes: 0, download: 0, upload: 0, delete: 0 },
        log: [],
        rule: null,
        /** `rule(kind, count)` returns `{ throttle: seconds }`, `{ delay: ms }` or nothing; counts and log start again. */
        arm(rule) { steer.counts = { changes: 0, download: 0, upload: 0, delete: 0 }; steer.log = []; steer.rule = rule },
      }
      const steerFetch = async (input, init = {}) => {
        const url = new URL(String(input))
        const route = url.pathname.slice('/api/v1/sync'.length)
        const method = init.method ?? 'GET'
        const kind = route.startsWith('/changes') ? 'changes' : route.startsWith('/files/') ? (method === 'PUT' ? 'upload' : method === 'DELETE' ? 'delete' : 'download') : null
        if (kind) {
          steer.counts[kind] += 1
          steer.log.push({ kind, search: url.search })
          const verdict = steer.rule?.(kind, steer.counts[kind])
          if (verdict?.delay) await sleep(verdict.delay)
          if (verdict?.throttle) {
            return new Response(JSON.stringify({ error: 'Zu viele Anfragen. Bitte später erneut versuchen.', retryAfter: verdict.throttle }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(verdict.throttle) } })
          }
        }
        return fetch(input, init)
      }
      const engine = new SyncEngine(new SyncApi(ORIGIN, steerFetch))
      const events = { applied: [], conflicts: [] }
      engine.attach(host, {
        platform: 'linux',
        deviceName: () => name,
        automatic: () => hooks.automatic ?? false,
        isPathBusy: (path) => hooks.busy?.(path) ?? false,
        excludedPrefixes: () => [],
        onApplied: (change) => events.applied.push(change),
        onConflict: (conflict) => events.conflicts.push(conflict),
        onSignedOut: () => undefined,
      })
      return { engine, events, steer }
    }
    /**
     * Records the timers the engine arms (window.setTimeout) and lets the test fire one by hand, so no check has to
     * wait for a pause to run out, or to bet on a pause still lasting after a slow step.
     */
    const captureTimers = () => {
      const realSetTimeout = window.setTimeout
      const timers = []
      window.setTimeout = (callback, delay, ...rest) => {
        const id = realSetTimeout(callback, delay, ...rest)
        timers.push({ callback, delay, id })
        return id
      }
      return { timers, restore() { window.setTimeout = realSetTimeout }, fire(timer) { clearTimeout(timer.id); timer.callback() } }
    }
    /** Answers the first sync request with HTTP 429 and everything after it normally. */
    const first = (throttle) => { let used = false; return () => { if (used) return null; used = true; return { throttle } } }
    const savedState = (host, vault) => JSON.parse(host.store.state.get(vault))

    // The status label.
    assert.equal(syncStatusLabel({ status: 'idle', heldRemote: 0, failed: [] }), 'Synchron')
    assert.equal(syncStatusLabel({ status: 'idle', heldRemote: 0, failed: [{ path: 'a.md', reason: 'x' }, { path: 'b.md', reason: 'y' }, { path: 'c.md', reason: 'z' }] }), '3 Dateien nicht hochgeladen')
    assert.equal(syncStatusLabel({ status: 'idle', heldRemote: 1, failed: [] }), 'Synchron · 1 Änderung von einem anderen Gerät wartet')
    assert.equal(syncStatusLabel({ status: 'idle', heldRemote: 3, failed: [] }), 'Synchron · 3 Änderungen von anderen Geräten warten')
    assert.equal(syncStatusLabel({ status: 'paused', pausedUntil: new Date(2026, 10, 16, 9, 5, 30).getTime(), heldRemote: 0, failed: [] }), 'Sync pausiert – geht um 09:05 weiter')
    assert.equal(syncStatusLabel({ status: 'paused', pausedUntil: new Date(2026, 10, 16, 14, 32, 0).getTime(), heldRemote: 2, failed: [] }), 'Sync pausiert – geht um 14:32 weiter · 2 Änderungen von anderen Geräten warten')
    assert.equal(syncStatusLabel({ status: 'paused', pausedUntil: null, heldRemote: 0, failed: [] }), 'Sync pausiert')
    assert.equal(syncStatusLabel({ status: 'offline', heldRemote: 2, failed: [] }), 'Offline – wartet auf Verbindung')
    // The settings card shows the pause (icon, colour class, label with the end time) and the waiting changes.
    {
      const { createElement } = await import('react')
      const { renderToStaticMarkup } = await import('react-dom/server')
      const { SyncSettingsSection } = await vite.ssrLoadModule('/src/components/SyncSettingsSection.tsx')
      const { defaultSettingsForPlatform } = await vite.ssrLoadModule('/src/defaults.ts')
      const render = (patch) => renderToStaticMarkup(createElement(SyncSettingsSection, {
        engine: {},
        syncState: { status: 'idle', account: { email: 'ada@example.com', accountId: 'a'.repeat(32), deviceId: 'd' }, vaultId: 'v', lastSyncAt: null, error: null, progress: null, pausedUntil: null, pendingLocal: 0, trackedFiles: 0, heldRemote: 0, failed: [], conflicts: [], openConflicts: 0, log: [], info: null, mcpReader: false, ...patch },
        settings: defaultSettingsForPlatform('linux'),
        update: () => undefined,
        platform: 'linux',
        grants: [],
        onGrants: () => undefined,
      }))
      assert.match(render({ failed: [{ path: 'A/b.md', reason: 'Zu groß' }, { path: 'c.md', reason: 'x' }, { path: 'd.md', reason: 'y' }] }), /3 Dateien nicht hochgeladen[\s\S]*Erneut versuchen[\s\S]*A\/b.md/u, 'failed files are listed with a retry')
      const pausedHtml = render({ status: 'paused', pausedUntil: new Date(2026, 10, 16, 14, 32, 0).getTime(), heldRemote: 1 })
      assert.match(pausedHtml, /sync-status-card is-paused/u)
      assert.match(pausedHtml, /sync-status-icon"><svg[^>]*lucide-clock/u, 'the pause has its own icon')
      assert.match(pausedHtml, /Sync pausiert – geht um 14:32 weiter · 1 Änderung von einem anderen Gerät wartet/u)
      assert.doesNotMatch(render({ status: 'idle' }), /is-paused|lucide-clock/u)
      assert.match(render({ status: 'idle', heldRemote: 2 }), /Synchron · 2 Änderungen von anderen Geräten warten/u)
    }

    // 1 + 2. The server's request budget runs out: the pause is shown with its end, a manual sync waits for
    // it instead of firing a request, a replaced timer does not end the periodic sync, and a good cycle,
    // a sign-out or a clock that jumped back do not leave the gate shut.
    {
      const host = createFakeHost('r13-pause')
      host.put('Pause/Eins.md', '# Eins')
      const T = createSteered(host, 'Laptop', { automatic: true })
      await T.engine.register('pause@example.com', password)
      await T.engine.syncNow()
      await T.engine.syncNow()
      assert.equal(T.engine.getState().status, 'idle', T.engine.getState().error)

      host.put('Pause/Zwei.md', '# Zwei')
      T.steer.arm(first(5))
      await T.engine.syncNow()
      const paused = T.engine.getState()
      assert.equal(paused.status, 'paused', 'a throttled cycle shows as a pause, not as in sync')
      assert.equal(paused.error, null, 'a pause is not an error')
      assert.ok(paused.pausedUntil > Date.now() && paused.pausedUntil <= Date.now() + 65_000, 'the end of the pause is published')
      assert.equal(syncStatusLabel(paused), `Sync pausiert – geht um ${clockOf(paused.pausedUntil)} weiter`)

      const capture = captureTimers()
      try {
        // A manual sync waits for the end of the pause instead of firing a request.
        const before = T.steer.log.length
        await T.engine.syncNow('manual')
        assert.equal(T.steer.log.length, before, 'a manual sync does not fire a request while the server throttles')
        assert.equal(T.engine.getState().status, 'paused')
        const manual = capture.timers.filter((timer) => timer.delay > 0)
        assert.equal(manual.length, 1, 'a manual sync arms the resume')
        assert.ok(manual[0].delay <= 5_000, 'for the end of the pause')

        // A vault switch replaces the timer that waits for the end of the pause by an immediate one, which meets the closed gate.
        capture.timers.length = 0
        await T.engine.switchVault()
        await sleep(100)
        assert.equal(T.steer.log.length, before, 'the gate holds')
        assert.equal(T.engine.getState().status, 'paused')
        const rearmed = capture.timers.filter((timer) => timer.delay > 0)
        assert.equal(rearmed.length, 1, 'the timer that the pause swallowed is armed again, or the periodic sync would be dead')
        assert.ok(rearmed[0].delay <= 5_000)
        // The pause runs out.
        capture.fire(rearmed[0])
      } finally {
        capture.restore()
      }
      await waitFor(() => T.engine.getState().status === 'idle', 'the sync goes on after the pause')
      assert.equal(T.engine.getState().pausedUntil, null)
      assert.ok(T.steer.log.some((request) => request.kind === 'upload'), 'the waiting note is uploaded once the pause is over')

      // Work outside a cycle (resolving a conflict) must not turn the pause into "in sync".
      host.put('Pause/Drei.md', '# Drei')
      T.steer.arm(first(30))
      await T.engine.syncNow()
      assert.equal(T.engine.getState().status, 'paused')
      assert.ok(T.engine.getState().pausedUntil - Date.now() > 25_000, 'the retryAfter of the server is honoured')
      const resolved = await T.engine.resolveConflict({ title: 'Leer', device: null, pairs: [] }, 'original', {})
      assert.equal(resolved.status, 'resolved')
      assert.equal(T.engine.getState().status, 'paused', 'work outside a cycle keeps the pause visible')
      assert.ok(T.engine.getState().pausedUntil > Date.now())
      // The first good cycle ends the pause: the server accepts requests again, so triggers are no longer held back.
      await T.engine.syncNow('resume')
      assert.equal(T.engine.getState().status, 'idle', T.engine.getState().error)
      assert.equal(T.engine.getState().pausedUntil, null)
      const afterResume = T.steer.log.length
      await T.engine.syncNow('focus')
      assert.ok(T.steer.log.length > afterResume, 'after a good cycle the old pause no longer holds automatic triggers back')

      // Signing out ends the pause. Signing in again syncs at once.
      host.put('Pause/Vier.md', '# Vier')
      T.steer.arm(first(30))
      await T.engine.syncNow()
      assert.equal(T.engine.getState().status, 'paused')
      await T.engine.logout()
      assert.equal(T.engine.getState().status, 'signed-out')
      assert.equal(T.engine.getState().pausedUntil, null)
      await T.engine.login('pause@example.com', password)
      await waitFor(() => T.engine.getState().lastSyncAt !== null, 'signing in again does not inherit the old pause')
      assert.equal(T.engine.getState().status, 'idle', T.engine.getState().error)

      // The clock jumps back an hour while the server throttles: the gate shuts for no longer than a pause can last,
      // and the timer that a vault switch swallowed is armed again for that time, not for the size of the jump.
      host.put('Pause/Fuenf.md', '# Fuenf')
      T.steer.arm(first(5))
      await T.engine.syncNow()
      assert.equal(T.engine.getState().status, 'paused')
      const realNow = Date.now
      const clock = captureTimers()
      Date.now = () => realNow() - 3_600_000
      try {
        await T.engine.switchVault()
        await sleep(100)
        assert.equal(T.engine.getState().status, 'paused')
        assert.ok(T.engine.getState().pausedUntil <= Date.now() + 65_000, 'the pause is cut to what a pause can last')
        const armed = clock.timers.filter((timer) => timer.delay > 0)
        assert.ok(armed.length > 0, 'the swallowed timer is armed again')
        assert.ok(Math.max(...armed.map((timer) => timer.delay)) <= 65_000, 'and not for the size of the clock jump')
      } finally {
        Date.now = realNow
        clock.restore()
      }
      await T.engine.syncNow('resume')
      assert.equal(T.engine.getState().status, 'idle', T.engine.getState().error)
      T.engine.dispose()
    }

    // 3. A pull that fails halfway: the notes written so far are saved and reported (the tree and open tabs
    // refresh), no worker goes on writing after the failure, and the next pull starts behind the finished notes.
    {
      const hostS = createFakeHost('r13-pull-s')
      for (let index = 1; index <= 6; index += 1) hostS.put(`Teil/Datei${index}.md`, `# Datei ${index}`)
      const S = createSteered(hostS, 'Laptop')
      await S.engine.register('pull@example.com', password)
      await S.engine.syncNow()
      assert.equal(S.engine.getState().trackedFiles, 6)
      const hostR = createFakeHost('r13-pull-r')
      const R = createSteered(hostR, 'Tablet')
      await R.engine.login('pull@example.com', password)
      R.steer.arm((kind, count) => (kind === 'download' && count === 4 ? { throttle: 5 } : null))
      await R.engine.syncNow()
      assert.equal(R.engine.getState().status, 'paused', R.engine.getState().error)
      const present = [...hostR.files.keys()].sort()
      assert.ok(present.length >= 1 && present.length < 6, `some notes arrived before the budget ran out (${present.length})`)
      assert.deepEqual(R.events.applied.flatMap((change) => change.written).sort(), present, 'the app is told about every note that was written, although the pull failed afterwards')
      const saved = savedState(hostR, 'vault-r13-pull-r')
      assert.deepEqual(Object.keys(saved.files).sort(), present, 'and they are recorded as synced')
      assert.ok(saved.cursor > 0, 'the cursor moved behind the notes that are done')
      await sleep(300)
      assert.deepEqual([...hostR.files.keys()].sort(), present, 'no worker goes on writing after the pull failed')

      const mark = R.steer.log.length
      await R.engine.syncNow('resume')
      assert.equal(R.engine.getState().status, 'idle', R.engine.getState().error)
      assert.equal(hostR.files.size, 6)
      assert.deepEqual(R.events.applied.flatMap((change) => change.written).sort(), [...hostR.files.keys()].sort())
      assert.equal([...hostR.files.keys()].filter((path) => path.includes('Konflikt')).length, 0, 'no conflict copies')
      const resumed = R.steer.log.slice(mark).find((request) => request.kind === 'changes')
      assert.ok(Number(new URLSearchParams(resumed.search).get('since')) > 0, 'the resumed pull does not list the finished notes again')
      S.engine.dispose()
      R.engine.dispose()
    }

    // 4 + 5 + 6. Two devices on one account. The tablet holds notes that cannot be applied yet, and meets a
    // conflict and a failed push.
    {
      const hostS = createFakeHost('r13-held-s')
      for (const name of ['A', 'B', 'C']) hostS.put(`Held/${name}.md`, `# ${name} eins`)
      hostS.put('Konf/Notiz.md', '# Urfassung')
      hostS.put('Scan/G.md', '# G eins')
      const S = createSteered(hostS, 'Laptop')
      await S.engine.register('held@example.com', password)
      await S.engine.syncNow()
      const hostR = createFakeHost('r13-held-r')
      let openNote = null
      let conflictMode = 'never'
      let asked = 0
      const R = createSteered(hostR, 'Tablet', { busy: (path) => {
        if (path === 'Konf/Notiz.md') return conflictMode === 'after-first-check' ? asked++ >= 1 : false
        return path === openNote
      } })
      await R.engine.login('held@example.com', password)
      await R.engine.syncNow()
      assert.equal(hostR.files.size, 5)

      // 4. B is open in an editor on the tablet while the laptop changes B and then C: the open note does not
      // hold the cursor back, is counted, and arrives once the editor is closed.
      openNote = 'Held/B.md'
      hostS.put('Held/B.md', '# B zwei')
      await S.engine.syncNow()
      hostS.put('Held/C.md', '# C zwei')
      await S.engine.syncNow()
      const revisionC = savedState(hostS, 'vault-r13-held-s').files['Held/C.md'].revision
      await R.engine.syncNow()
      assert.equal(hostR.text('Held/C.md'), '# C zwei', 'the other notes still arrive')
      assert.equal(hostR.text('Held/B.md'), '# B eins', 'an open note is not replaced')
      assert.equal(R.engine.getState().status, 'idle')
      assert.equal(R.engine.getState().heldRemote, 1, 'the waiting change is counted')
      assert.equal(syncStatusLabel(R.engine.getState()), 'Synchron · 1 Änderung von einem anderen Gerät wartet')
      const held = savedState(hostR, 'vault-r13-held-r')
      assert.ok(held.cursor >= revisionC, 'the cursor is not held in front of the open note')
      assert.equal(held.skipped.length, 1, 'the open note waits on the retry list')
      const restarted = createSteered(hostR, 'Tablet')
      await restarted.engine.start()
      assert.equal(restarted.engine.getState().heldRemote, 1, 'the count survives a restart')
      restarted.engine.dispose()

      const mark = R.steer.log.length
      await R.engine.syncNow()
      await R.engine.syncNow()
      const since = R.steer.log.slice(mark).filter((request) => request.kind === 'changes').map((request) => Number(new URLSearchParams(request.search).get('since')))
      assert.equal(since.length, 2)
      assert.ok(since.every((value) => value >= revisionC), 'an open note does not make every cycle list the changes after it again')
      assert.equal(R.engine.getState().heldRemote, 1)
      assert.equal(hostR.text('Held/B.md'), '# B eins')
      openNote = null
      await R.engine.syncNow()
      assert.equal(hostR.text('Held/B.md'), '# B zwei', 'the change arrives once the note is closed')
      assert.equal(R.engine.getState().heldRemote, 0)
      assert.equal(syncStatusLabel(R.engine.getState()), 'Synchron')
      assert.deepEqual(savedState(hostR, 'vault-r13-held-r').skipped, [])
      assert.ok(R.events.applied.some((change) => change.written.includes('Held/B.md')), 'the app is told to reload it')

      // 4. A file that cannot be read is reported once, not on every cycle, and again when its state changed in between.
      const readable = hostR.read
      const locked = new Set()
      hostR.read = async (path) => { if (locked.has(path)) throw new Error('EACCES'); return readable(path) }
      const reports = () => R.engine.getState().log.filter((entry) => /Held\/A\.md.*nicht lesen/u.test(entry.text)).length
      locked.add('Held/A.md')
      hostS.put('Held/A.md', '# A zwei')
      await S.engine.syncNow()
      for (let round = 0; round < 3; round += 1) await R.engine.syncNow()
      assert.equal(reports(), 1, 'an unreadable file is reported once, not on every cycle')
      assert.equal(R.engine.getState().heldRemote, 1)
      assert.equal(hostR.text('Held/A.md'), '# A eins', 'the unreadable file is left alone')
      locked.delete('Held/A.md')
      await R.engine.syncNow()
      assert.equal(hostR.text('Held/A.md'), '# A zwei', 'it arrives once it can be read')
      assert.equal(R.engine.getState().heldRemote, 0)
      locked.add('Held/A.md')
      hostS.put('Held/A.md', '# A drei')
      await S.engine.syncNow()
      await R.engine.syncNow()
      await R.engine.syncNow()
      assert.equal(reports(), 2, 'reported again when it became unreadable anew')
      locked.delete('Held/A.md')
      await R.engine.syncNow()
      assert.equal(hostR.text('Held/A.md'), '# A drei')
      hostR.read = readable

      // 5. The note turns busy during the download, after a conflict was found: no conflict copy is written for a
      // deferral, so trying again does not leave two copies and two conflict entries.
      hostS.put('Konf/Notiz.md', '# Fassung vom Laptop')
      await S.engine.syncNow()
      hostR.put('Konf/Notiz.md', '# Fassung vom Tablet')
      // The note is free when the pull looks at it and busy when the conflict copy would be written.
      conflictMode = 'after-first-check'
      await R.engine.syncNow()
      const copies = () => [...hostR.files.keys()].filter((path) => path.startsWith('Konf/Notiz (Konflikt'))
      assert.equal(copies().length, 0, 'a deferred note gets no conflict copy')
      assert.equal(R.events.conflicts.length, 0)
      assert.equal(R.engine.getState().conflicts.length, 0)
      assert.equal(hostR.text('Konf/Notiz.md'), '# Fassung vom Tablet', 'the open note is untouched')
      conflictMode = 'never'
      await R.engine.syncNow()
      assert.equal(copies().length, 1, 'exactly one conflict copy once the note is free')
      assert.equal(hostR.text(copies()[0]), '# Fassung vom Tablet')
      assert.equal(hostR.text('Konf/Notiz.md'), '# Fassung vom Laptop')
      assert.equal(R.events.conflicts.length, 1)
      assert.equal(R.engine.getState().conflicts.length, 1)
      assert.equal(R.engine.getState().heldRemote, 0)

      // 6. A push that failed halfway must not leave its listing of the vault to the next cycle: a note that is
      // gone from the vault was reported as "present but unreadable" and put off.
      hostR.put('Scan/H.md', '# H')
      R.steer.arm((kind) => (kind === 'upload' ? { throttle: 5 } : null))
      await R.engine.syncNow()
      assert.equal(R.engine.getState().status, 'paused')
      R.steer.arm(null)
      // G disappears from the tablet (moved away, quarantined) and the laptop changes it.
      hostR.files.delete('Scan/G.md')
      hostS.put('Scan/G.md', '# G zwei')
      await S.engine.syncNow()
      await R.engine.syncNow('resume')
      assert.equal(R.engine.getState().status, 'idle', R.engine.getState().error)
      assert.equal(hostR.text('Scan/G.md'), '# G zwei')
      assert.ok(!R.engine.getState().log.some((entry) => /Scan\/G\.md.*nicht lesen/u.test(entry.text)), 'a note that is gone is not reported as unreadable on account of an old listing')
      assert.equal(R.engine.getState().heldRemote, 0)
      assert.ok(R.events.applied.some((change) => change.written.includes('Scan/G.md')), 'the pull applied the note and told the app')
      S.engine.dispose()
      R.engine.dispose()
    }

    // 7. After the first failure no worker takes another file, and the cycle ends only when the running ones
    // are done, so the saved state matches the server.
    {
      const host = createFakeHost('r13-limited')
      for (let index = 1; index <= 12; index += 1) host.put(`Viele/Datei${index}.md`, `# Datei ${index}`)
      const U = createSteered(host, 'Laptop')
      await U.engine.register('limited@example.com', password)
      U.steer.arm((kind, count) => (kind === 'upload' ? (count === 2 ? { throttle: 5 } : { delay: 80 }) : null))
      await U.engine.syncNow()
      assert.equal(U.engine.getState().status, 'paused', U.engine.getState().error)
      const started = U.steer.counts.upload
      assert.ok(started >= 2 && started < 12, `the failure stopped the upload (${started} started)`)
      await sleep(400)
      assert.equal(U.steer.counts.upload, started, 'no worker takes another file after the cycle failed')
      const session = U.engine.getSession()
      const onServer = (await new SyncApi(ORIGIN).changes(session, 0)).entries.length
      assert.equal(Object.keys(savedState(host, 'vault-r13-limited').files).length, onServer, 'every upload that went through is in the saved state')
      await U.engine.syncNow('resume')
      assert.equal(U.engine.getState().status, 'idle', U.engine.getState().error)
      assert.equal((await new SyncApi(ORIGIN).changes(session, 0)).entries.length, 12)
      assert.equal([...host.files.keys()].filter((path) => path.includes('Konflikt')).length, 0)
      U.engine.dispose()
    }
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  const serverSource = read('../fanotes-site/server.mjs')
  assert.match(serverSource, /import \{[^}]*\bhandleSyncRequest\b[^}]*\} from '\.\/sync-api\.mjs'/u)
  assert.ok(serverSource.indexOf('handleSyncRequest(request, response, url)') < serverSource.indexOf('Nur GET und HEAD sind erlaubt'), 'sync is routed before the GET/HEAD guard')
  assert.match(read('../fanotes-site/deploy/fanotes-fasrv.conf'), /location \^~ \/api\/v1\/sync\/ \{[\s\S]*?client_max_body_size 110m;[\s\S]*?proxy_request_buffering off;/u)
  const service = read('../fanotes-site/deploy/fanotes-site.service')
  assert.match(service, /Environment=FANOTES_SYNC_DIR=\/var\/lib\/fanotes-sync/u)
  assert.match(service, /ReadWritePaths=\/var\/lib\/fanotes-sync/u)
  const apiSource = read('../fanotes-site/sync-api.mjs')
  assert.match(apiSource, /scrypt\(secret, salt, 32, \{ N: 32_768/u, 'auth keys are scrypt-hashed server-side')
  assert.match(apiSource, /timingSafeEqual/u)
  assert.match(apiSource, /'wx'/u, 'e-mail uniqueness via exclusive create')
  assert.match(apiSource, /await scryptHash\(authKey, randomBytes\(16\)\)/u, 'unknown e-mail burns the same time')
  assert.match(apiSource, /origin === 'null' \|\| origin === PUBLIC_ORIGIN/u)

  const mainSource = read('electron/main.cjs')
  assert.match(mainSource, /registerSyncIpc\(handle, createSyncHost\(\{/u)
  assert.match(mainSource, /require\('\.\/settings-sanitize\.cjs'\)/u)
  const settingsSchema = read('electron/settings-sanitize.cjs')
  assert.match(settingsSchema, /syncAutomatic: \{ type: 'boolean' \}/u)
  assert.match(settingsSchema, /syncDeviceName: \{ type: 'string', max: 80 \}/u)
  const preloadSource = read('electron/preload.cjs')
  for (const channel of ['sync-vault-id', 'sync-scan', 'sync-read', 'sync-write', 'sync-remove', 'sync-read-state', 'sync-write-state', 'sync-read-secrets', 'sync-write-secrets']) {
    assert.ok(preloadSource.includes(`'fanotes:${channel}'`), `preload exposes ${channel}`)
  }
  const syncHostSource = read('electron/sync.cjs')
  assert.match(syncHostSource, /isSymbolicLink\(\)\) throw new Error/u, 'symlinks are rejected on every path component')
  assert.match(syncHostSource, /safeStorage\.encryptString/u, 'secrets go through safeStorage')
  assert.match(syncHostSource, /O_EXCL/u, 'atomic writes via exclusive temp file')

  const { coerceSyncBytes, createSyncHost, resolveInside } = await import('../electron/sync.cjs')
  assert.deepEqual([...coerceSyncBytes(new Uint8Array([1, 2, 3]))], [1, 2, 3])
  assert.deepEqual([...coerceSyncBytes([4, 5])], [4, 5])
  assert.throws(() => coerceSyncBytes(100_000_000), /binär/u)
  assert.throws(() => coerceSyncBytes({ length: 100_000_000 }), /binär/u)
  {
    const { mkdirSync, writeFileSync, symlinkSync } = await import('node:fs')
    const root = mkdtempSync(join(tmpdir(), 'fanotes-sync-vault-'))
    mkdirSync(join(root, 'Mathe'))
    mkdirSync(join(root, '.fanotes', 'history', 'x'), { recursive: true })
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, 'Mathe', 'Algebra.md'), '# A')
    writeFileSync(join(root, 'Mathe', '.Algebra.md.1.tmp'), 'tmp')
    writeFileSync(join(root, '.fanotes', 'folder-colors.json'), '{}')
    writeFileSync(join(root, '.fanotes', 'history', 'x', 'index.json'), '{}')
    writeFileSync(join(root, '.git', 'config'), '')
    const outside = mkdtempSync(join(tmpdir(), 'fanotes-sync-outside-'))
    writeFileSync(join(outside, 'secret.md'), 'nope')
    symlinkSync(outside, join(root, 'Link'))
    symlinkSync(join(outside, 'secret.md'), join(root, 'Mathe', 'Link.md'))
    const userData = mkdtempSync(join(tmpdir(), 'fanotes-sync-userdata-'))
    const fakeSafeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`enc:${value}`), decryptString: (buffer) => buffer.toString('utf8').slice(4) }
    const host = createSyncHost({ vaultRoot: async () => root, userDataDirectory: userData, safeStorage: fakeSafeStorage })
    const scanned = (await host.scan()).map((entry) => entry.path).sort()
    assert.deepEqual(scanned, ['.fanotes/folder-colors.json', 'Mathe/Algebra.md'], 'scan skips history, tmp files, .git and symlinks')
    const missingRoot = createSyncHost({ vaultRoot: async () => join(root, 'fehlt'), userDataDirectory: userData, safeStorage: fakeSafeStorage })
    await assert.rejects(missingRoot.scan(), /unvollständig/u, 'a missing vault is not an empty scan')
    await assert.rejects(host.read('Mathe/Link.md'), /Symbolische Links/u)
    await assert.rejects(host.read('Link/secret.md'), /Symbolische Links/u)
    await assert.rejects(host.read('../outside.md'), /Ungültiger Sync-Pfad/u)
    await assert.rejects(resolveInside(root, 'Mathe/../../x'), /Ungültiger Sync-Pfad/u)
    const written = await host.write('Physik/Neu/Optik.md', encoder.encode('# Optik'), 1_700_000_000_000)
    assert.equal(written.path, 'Physik/Neu/Optik.md')
    assert.equal(written.mtimeMs, 1_700_000_000_000, 'remote mtime is preserved')
    assert.equal(text(await host.read('Physik/Neu/Optik.md')), '# Optik')
    await assert.rejects(host.write('Link/evil.md', encoder.encode('x'), 0), /Symbolische Links/u)
    await host.remove('Physik/Neu/Optik.md')
    await assert.rejects(host.read('Physik/Neu/Optik.md'))
    await host.remove('Physik/Neu/Optik.md')
    await host.writeSecrets('{"v":1}')
    assert.equal(await host.readSecrets(), '{"v":1}')
    assert.ok(readFileSync(join(userData, 'sync', 'account.secret'), 'utf8').startsWith('safe1:'))
    const lockedStorage = {
      isEncryptionAvailable: () => false,
      encryptString() { throw new Error('no keychain') },
      decryptString() { throw new Error('no keychain') },
    }
    const lockedOnSafe = createSyncHost({ vaultRoot: async () => root, userDataDirectory: userData, safeStorage: lockedStorage })
    await assert.rejects(lockedOnSafe.readSecrets(), /Schlüsselbund/u)
    await host.writeSecrets(null)
    assert.equal(await host.readSecrets(), null)
    const lockedUserData = mkdtempSync(join(tmpdir(), 'fanotes-sync-nokeyring-'))
    const locked = createSyncHost({ vaultRoot: async () => root, userDataDirectory: lockedUserData, safeStorage: lockedStorage })
    await locked.writeSecrets('{"token":"secret"}')
    const storedSecret = readFileSync(join(lockedUserData, 'sync', 'account.secret'), 'utf8')
    assert.ok(storedSecret.startsWith('local1:'), 'missing keychain stores an encrypted local envelope')
    assert.equal(storedSecret.includes('secret'), false)
    assert.equal(statSync(join(lockedUserData, 'sync', 'account.secret')).mode & 0o077, 0)
    assert.equal(statSync(join(lockedUserData, 'sync', 'account.key')).mode & 0o077, 0)
    assert.equal(await locked.readSecrets(), '{"token":"secret"}')
    rmSync(lockedUserData, { recursive: true, force: true })
    const { localizeText } = await import('../electron/i18n.cjs')
    const translated = localizeText('Die Sync-Anmeldung ist mit dem Schlüsselbund dieses Systems geschützt, der gerade nicht verfügbar ist.', 'en')
    assert.match(translated, /Schlüsselbund|keychain/u)
    assert.doesNotMatch(translated, /saved become/u)
    const vaultId = await host.vaultId()
    await host.writeState(vaultId, '{"cursor":1}')
    assert.equal(await host.readState(vaultId), '{"cursor":1}')
    await assert.rejects(host.readState('../../etc'), /Ungültige Vault-ID/u)
    rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); rmSync(userData, { recursive: true, force: true })
  }

  const appSource = read('src/App.tsx')
  assert.match(appSource, /useSyncExternalStore\(syncEngine\.subscribe, syncEngine\.getState, syncEngine\.getState\)/u)
  assert.match(appSource, /syncEngine\.notifyLocalChange\(\)/u, 'saves kick the engine')
  assert.match(appSource, /if \(!options\?\.quiet\) \{[\s\S]*?syncEngine\.notifyLocalChange\(\)/u, 'statistics-only saves do not kick the engine')
  assert.match(read('src/lib/sync/engine.ts'), /canonicalSyncBytes\(entry\.path, raw\)/u, 'uploads hash the note without page statistics')
  assert.match(read('src/lib/sync/engine.ts'), /withLocalPageStats\(/u, 'a download keeps the statistics already on this device')
  assert.match(read('src/lib/sync/engine.ts'), /AUTO_INTERVAL_MS/u, 'the regular sync timer stays')
  assert.match(appSource, /syncEngine\.attach\(/u)
  assert.match(appSource, /id: 'sync-now'/u)
  assert.match(appSource, /id: 'sync-settings'/u)
  assert.match(appSource, /className=\{`sync-status-item/u)
  assert.match(appSource, /syncState\.status === 'paused' \? <Clock size=\{12\} \/> : <Cloud size=\{12\} \/>[^]*?syncState\.status === 'paused' \? 'Sync pausiert' : 'Synchron'/u, 'the status bar shows the pause')
  const settingsSource = read('src/components/SettingsModal.tsx')
  assert.match(settingsSource, /\{ id: 'sync', label: 'Sync'/u)
  assert.match(settingsSource, /<SyncSettingsSection/u)
  const types = read('src/types.ts')
  assert.match(types, /sync\?: SyncHostApi/u)
  assert.match(read('src/lib/browserApi.ts'), /sync: createBrowserSyncHost\(\{/u)
  assert.match(read('src/lib/browserPreview.ts'), /vaultId: async \(\) => 'browser-preview'/u)
  assert.match(read('vite.config.ts'), /'\/api\/v1\/sync'/u, 'dev server proxies the sync API')

  console.log('check-sync: ok')
} finally {
  await vite.close()
  httpServer.close()
  rmSync(dataDirectory, { recursive: true, force: true })
}
