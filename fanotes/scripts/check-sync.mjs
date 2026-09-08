// Sync: crypto round-trips, the engine's two-device behaviour against the real
// server module (fanotes-site/sync-api.mjs) mounted on a bare http server, and
// the wiring in App / Electron / nginx / systemd.
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
const { SyncApi } = await vite.ssrLoadModule('/src/lib/sync/api.ts')
const { SyncEngine, isSyncablePath, conflictCopyPath } = await vite.ssrLoadModule('/src/lib/sync/engine.ts')

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
    await assert.rejects(crypto.decryptBytes(keys, id2.replace(/./u, 'f'), blob), /nicht entschlüsselt/u, 'blob is bound to its file id (AAD)')
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
  assert.ok(!isSyncablePath('.fanotes/onboarding.json'))
  assert.ok(!isSyncablePath('.git/config'))
  assert.ok(!isSyncablePath('Mathe/.Algebra.md.123.tmp'))
  assert.ok(!isSyncablePath('../etc/passwd'))
  assert.ok(!isSyncablePath('Mathe//x.md'))
  assert.ok(!isSyncablePath('.DS_Store'))
  assert.equal(conflictCopyPath('Mathe/Algebra.md', 'Laptop', new Date(2026, 8, 8, 9, 5)), 'Mathe/Algebra (Konflikt Laptop 2026-09-08 09-05).md')
  assert.equal(conflictCopyPath('README', 'A/B:C', new Date(2026, 0, 1, 0, 0)), 'README (Konflikt A B C 2026-01-01 00-00)')

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

  // Delete on A → gone on B; delete + concurrent edit keeps the edit.
  hostA.files.delete('Physik/Bild.png')
  await A.engine.syncNow()
  await B.engine.syncNow()
  assert.ok(!hostB.files.has('Physik/Bild.png'))
  assert.deepEqual(B.events.applied.at(-1), { written: [], removed: ['Physik/Bild.png'] })
  hostA.files.delete(copies[0])
  hostB.put(copies[0], 'doch behalten')
  await A.engine.syncNow()
  await B.engine.syncNow()
  assert.equal(hostB.text(copies[0]), 'doch behalten', 'a local edit survives a remote delete')
  await B.engine.syncNow()
  await A.engine.syncNow()
  assert.equal(hostA.text(copies[0]), 'doch behalten', 'and is re-uploaded on top of the tombstone')

  // A note that is being edited is not overwritten; it arrives once the editor is quiet.
  let busy = true
  const C = createEngine(hostB, 'Tablet', { busy: (path) => busy && path === 'Mathe/Algebra.md' })
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

  // ── Wiring ──────────────────────────────────────────────────────────────
  const serverSource = read('../fanotes-site/server.mjs')
  assert.match(serverSource, /import \{ handleSyncRequest \} from '\.\/sync-api\.mjs'/u)
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
  assert.match(mainSource, /syncAutomatic: \{ type: 'boolean' \}/u)
  assert.match(mainSource, /syncDeviceName: \{ type: 'string', max: 80 \}/u)
  const preloadSource = read('electron/preload.cjs')
  for (const channel of ['sync-vault-id', 'sync-scan', 'sync-read', 'sync-write', 'sync-remove', 'sync-read-state', 'sync-write-state', 'sync-read-secrets', 'sync-write-secrets']) {
    assert.ok(preloadSource.includes(`'fanotes:${channel}'`), `preload exposes ${channel}`)
  }
  const syncHostSource = read('electron/sync.cjs')
  assert.match(syncHostSource, /isSymbolicLink\(\)\) throw new Error/u, 'symlinks are rejected on every path component')
  assert.match(syncHostSource, /safeStorage\.encryptString/u, 'secrets go through safeStorage')
  assert.match(syncHostSource, /O_EXCL/u, 'atomic writes via exclusive temp file')

  const { createSyncHost, resolveInside } = await import('../electron/sync.cjs')
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
    await host.writeSecrets(null)
    assert.equal(await host.readSecrets(), null)
    const vaultId = await host.vaultId()
    await host.writeState(vaultId, '{"cursor":1}')
    assert.equal(await host.readState(vaultId), '{"cursor":1}')
    await assert.rejects(host.readState('../../etc'), /Ungültige Vault-ID/u)
    rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); rmSync(userData, { recursive: true, force: true })
  }

  const appSource = read('src/App.tsx')
  assert.match(appSource, /useSyncExternalStore\(syncEngine\.subscribe, syncEngine\.getState, syncEngine\.getState\)/u)
  assert.match(appSource, /syncEngine\.notifyLocalChange\(\)/u, 'saves kick the engine')
  assert.match(appSource, /syncEngine\.attach\(/u)
  assert.match(appSource, /id: 'sync-now'/u)
  assert.match(appSource, /id: 'sync-settings'/u)
  assert.match(appSource, /className=\{`sync-status-item/u)
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
