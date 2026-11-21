// Accounts without e-mail or password, device-key sign-in, cloud sync off by default,
// and end-to-end encrypted shares to a username that appear instantly through the push
// channel. The real server module runs on a local port; two fake devices drive it.
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const read = (relative) => readFileSync(join(appRoot, relative), 'utf8')

globalThis.window = Object.assign(Object.create(null), {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  fanotes: { platform: 'test' },
  location: { origin: 'http://127.0.0.1' },
})
const nodeFetch = globalThis.fetch
globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers)
  if (!headers.has('accept-language')) headers.set('Accept-Language', 'de-CH,de;q=0.9')
  return nodeFetch(input, { ...init, headers })
}

// The server logs one JSON line per request; keep the check output readable.
const log = console.log
console.log = (...args) => { if (typeof args[0] === 'string' && args[0].startsWith('{"time"')) return; log(...args) }

const dataDirectory = mkdtempSync(join(tmpdir(), 'fanotes-account-share-'))
process.env.FANOTES_SYNC_DIR = dataDirectory
process.env.FANOTES_MCP_DIR = join(dataDirectory, 'mcp')
process.env.FANOTES_SYNC_REGISTER_PER_HOUR = '1000'
const PORT = 19_100 + Math.floor(Math.random() * 300)
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
const { SyncEngine, isSyncablePath } = await vite.ssrLoadModule('/src/lib/sync/engine.ts')
const { UserShareManager } = await vite.ssrLoadModule('/src/lib/sync/userShares.ts')

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check, what, ms = 4000) => {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(25)
  }
}

/** In-memory vault, state and keychain (with the separate device-key slot) standing in for Electron main. */
const createFakeHost = (id, { protectedSecrets = true } = {}) => {
  const files = new Map()
  let clock = 1_700_000_000_000
  const store = { state: new Map(), secrets: new Map() }
  return {
    files,
    store,
    put(path, content) {
      clock += 1000
      files.set(path, { bytes: typeof content === 'string' ? encoder.encode(content) : content, mtimeMs: clock })
    },
    text(path) { return files.has(path) ? decoder.decode(files.get(path).bytes) : null },
    secretsProtected: protectedSecrets,
    async vaultId() { return `vault-${id}` },
    async scan() { return [...files.entries()].map(([path, file]) => ({ path, size: file.bytes.byteLength, mtimeMs: file.mtimeMs })) },
    async read(path) { if (!files.has(path)) throw new Error(`missing ${path}`); return files.get(path).bytes },
    async write(path, bytes, mtimeMs) {
      files.set(path, { bytes: new Uint8Array(bytes), mtimeMs: mtimeMs || (clock += 1000) })
      return { path, size: bytes.byteLength, mtimeMs: files.get(path).mtimeMs }
    },
    async remove(path) { files.delete(path) },
    async readState(vaultId) { return store.state.get(vaultId) ?? null },
    async writeState(vaultId, json) { if (json === null) store.state.delete(vaultId); else store.state.set(vaultId, json) },
    async readSecrets(slot = 'account') { return store.secrets.get(slot) ?? null },
    async writeSecrets(json, slot = 'account') { if (json === null) store.secrets.delete(slot); else store.secrets.set(slot, json) },
  }
}

const devices = []
const createDevice = (name, hostOptions) => {
  const host = createFakeHost(name, hostOptions)
  const settings = { vaultSync: true }
  const engine = new SyncEngine(new SyncApi(ORIGIN))
  engine.attach(host, {
    platform: 'linux',
    deviceName: () => name,
    automatic: () => false,
    vaultSync: () => settings.vaultSync,
    setVaultSync: (value) => { settings.vaultSync = value },
    onApplied: () => undefined,
  })
  const shares = new UserShareManager(engine, new SyncApi(ORIGIN))
  const events = { incoming: [], gone: [], applied: [] }
  shares.attach(host, {
    onIncoming: (share) => events.incoming.push(share),
    onGone: (share, why) => events.gone.push({ share, why }),
    onApplied: (change) => events.applied.push(change),
  })
  const device = { name, host, settings, engine, shares, events }
  devices.push(device)
  return device
}

const serverFiles = (directory) => {
  const out = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...serverFiles(full))
    else out.push(full)
  }
  return out
}

try {
  // ── Pure rules ──────────────────────────────────────────────────────
  assert.equal(isSyncablePath('Mit mir geteilt/anna/Notiz/Notiz.md'), false, 'received shares never enter the cloud vault')
  assert.equal(isSyncablePath('Schule/Notiz.md'), true)
  assert.equal(crypto.usernameProblem('ab'), 'Der Benutzername braucht 3 bis 32 Zeichen.')
  assert.equal(crypto.usernameProblem('anna_f'), null)
  assert.ok(crypto.usernameProblem('a b c'))
  assert.ok(crypto.usernameProblem('a..b'))

  // ── Key wrapping: only the holder of the private key opens a share key ──
  {
    const vault = await crypto.importVaultSecret(crypto.newVaultSecret())
    const alice = await crypto.createUserKeyPair(vault)
    const bob = await crypto.createUserKeyPair(vault)
    const shareKey = crypto.newShareKey()
    const wrapped = await crypto.wrapShareKey(shareKey, bob.publicKey)
    assert.deepEqual(await crypto.unwrapShareKey(wrapped, bob.privateKey), shareKey)
    await assert.rejects(() => crypto.unwrapShareKey(wrapped, alice.privateKey), /Freigabe-Schlüssel/u)
    const reopened = await crypto.openUserPrivateKey(bob.publicKey, bob.wrap, vault)
    assert.deepEqual(await crypto.unwrapShareKey(wrapped, reopened), shareKey)
    await assert.rejects(() => crypto.openUserPrivateKey(alice.publicKey, bob.wrap, vault), /Freigabe-Schlüssel/u, 'the wrap is bound to its public key')
    const keys = await crypto.deriveShareKeys(shareKey)
    const title = await crypto.encryptShareTitle(keys, { name: 'Mathe', kind: 'note', rootPath: 'Schule/Mathe.md' })
    assert.equal((await crypto.decryptShareTitle(keys, title)).name, 'Mathe')
  }

  // ── Account with only a username: no e-mail, no password ──────────────
  const anna = createDevice('anna-laptop')
  await anna.engine.start()
  await anna.engine.createAccount({ username: 'Anna_F' })
  let state = anna.engine.getState()
  assert.equal(state.account.username, 'Anna_F')
  assert.equal(state.account.email, '')
  assert.equal(state.account.credential, 'device-key')
  assert.equal(anna.settings.vaultSync, false, 'cloud sync is off for a new account')
  assert.equal(state.vaultSync, false)
  assert.equal((await anna.engine.deviceKeyAccounts()).length, 1)
  assert.ok(anna.host.store.secrets.has('device-keys'), 'the device key is kept in its own protected slot')
  assert.ok(!anna.host.store.secrets.get('account').includes('device-keys'))

  // With cloud sync off nothing from the vault reaches the server.
  anna.host.put('Schule/Mathe.md', 'Geheimer Satz im Heft.')
  await anna.engine.syncNow('manual')
  assert.equal(anna.engine.getState().status, 'idle')
  assert.equal((await anna.engine.refreshAccount()).usage.files, 0)
  // Turning it on is an explicit step and then syncs.
  anna.settings.vaultSync = true
  anna.engine.vaultSyncChanged()
  await until(async () => (await anna.engine.refreshAccount()).usage.files > 0, 'vault sync after the explicit toggle')

  // Signed out, the device key still signs in again; another device without it cannot.
  await anna.engine.logout()
  assert.equal(anna.engine.getState().account, null)
  const [stored] = await anna.engine.deviceKeyAccounts()
  assert.equal(stored.username, 'Anna_F')
  await anna.engine.loginWithDeviceKey(stored.accountId)
  assert.equal(anna.engine.getState().account.username, 'Anna_F')
  const stranger = createDevice('thief')
  await assert.rejects(() => stranger.engine.login('Anna_F', 'wrong guess 12345'), (error) => error instanceof SyncApiError && error.status === 401)
  await assert.rejects(() => stranger.engine.loginWithDeviceKey(stored.accountId), /Schlüssel/u)
  await assert.rejects(() => createDevice('web', { protectedSecrets: false }).engine.createAccount({ username: 'no_keychain' }), /Desktop-App/u)
  await assert.rejects(() => stranger.engine.createAccount({ username: 'anna_f' }), (error) => error instanceof SyncApiError && error.status === 409, 'usernames are unique ignoring case')

  // E-mail is optional and can be added later; a password can be added later too.
  await anna.engine.setEmail('Anna@Example.org')
  assert.equal(anna.engine.getState().account.email, 'anna@example.org')

  // ── A second account, with password, and instant sharing ──────────────
  const ben = createDevice('ben-laptop')
  await ben.engine.start()
  await ben.engine.createAccount({ username: 'Ben.K', password: 'ein langes passwort 42' })
  assert.equal(ben.engine.getState().account.credential, 'password')
  assert.equal((await ben.engine.deviceKeyAccounts()).length, 0)
  anna.shares.start()
  ben.shares.start()
  await until(() => anna.shares.getState().ready && ben.shares.getState().ready, 'both share managers ready')
  await until(() => anna.shares.getState().live && ben.shares.getState().live, 'push channels open')

  // Exact username only.
  await assert.rejects(() => anna.shares.lookup('Ben'), (error) => error instanceof SyncApiError && error.status === 404)
  await assert.rejects(() => anna.shares.lookup('ben'), (error) => error instanceof SyncApiError && error.status === 404)
  const found = await anna.shares.lookup('ben.k')
  assert.equal(found.username, 'Ben.K')
  assert.match(found.fingerprint, /^[0-9a-f]{4}( [0-9a-f]{4}){4}$/u)

  anna.host.put('Schule/Mathe.md', 'Geheimer Satz im Heft.')
  anna.host.put('Schule/Mathe.famd', '{"ink":"striche"}')
  const shareId = await anna.shares.share({ path: 'Schule/Mathe.md', kind: 'note', username: 'ben.k', permission: 'read' })

  // It shows up for Ben through the open channel, without anything polling.
  await until(() => ben.shares.getState().pending.length === 1, 'pending share pushed to the recipient')
  assert.equal(ben.events.incoming.length, 1)
  assert.equal(ben.events.incoming[0].peer, 'Anna_F')
  assert.equal(ben.events.incoming[0].name, 'Mathe')
  assert.equal(ben.host.text('Mit mir geteilt/Anna_F/Mathe/Mathe.md'), null, 'nothing is copied before the recipient accepts')

  await ben.shares.respond(shareId, true)
  await until(() => ben.host.text('Mit mir geteilt/Anna_F/Mathe/Mathe.md') === 'Geheimer Satz im Heft.', 'accepted share appears as a file')
  assert.equal(ben.host.text('Mit mir geteilt/Anna_F/Mathe/Mathe.famd'), '{"ink":"striche"}')
  // QA-010: the sidebar entry of a shared note opens this file.
  assert.equal(ben.shares.firstNotePath(shareId), 'Mit mir geteilt/Anna_F/Mathe/Mathe.md')
  assert.ok(ben.events.applied.some((change) => change.written.includes('Mit mir geteilt/Anna_F/Mathe/Mathe.md')))
  await until(() => anna.shares.getState().shares[0]?.status === 'accepted', 'the owner sees the acceptance at once')

  // The server only holds ciphertext.
  for (const file of serverFiles(join(dataDirectory, 'user-shares'))) {
    const bytes = readFileSync(file).toString('latin1')
    assert.ok(!bytes.includes('Geheimer Satz'), `plaintext leaked into ${file}`)
    assert.ok(!bytes.includes('Mathe'), `a name leaked into ${file}`)
  }

  // Later edits by the owner arrive without polling.
  anna.host.put('Schule/Mathe.md', 'Neuer Satz, sofort da.')
  anna.engine.notifyLocalChange()
  await until(() => ben.host.text('Mit mir geteilt/Anna_F/Mathe/Mathe.md') === 'Neuer Satz, sofort da.', 'owner edit pushed to the recipient')

  // Read-only: Ben's local edit does not reach Anna.
  ben.host.put('Mit mir geteilt/Anna_F/Mathe/Mathe.md', 'Ben schreibt, darf aber nicht.')
  ben.engine.notifyLocalChange()
  await sleep(2300)
  assert.equal(anna.host.text('Schule/Mathe.md'), 'Neuer Satz, sofort da.')
  // With edit permission it goes both ways.
  await anna.shares.setPermission(shareId, 'edit')
  await until(() => ben.shares.getState().shares[0]?.permission === 'edit', 'permission change pushed')
  ben.host.put('Mit mir geteilt/Anna_F/Mathe/Mathe.md', 'Ben bearbeitet jetzt mit.')
  ben.engine.notifyLocalChange()
  await until(() => anna.host.text('Schule/Mathe.md') === 'Ben bearbeitet jetzt mit.', 'recipient edit reaches the owner')

  // QA-013: an edit made while the network is down must upload after reconnect ("Jetzt synchronisieren"), not stay stuck
  // behind the error the failed attempt left on the share.
  const onlineFetch = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new TypeError('network down'))
  ben.host.put('Mit mir geteilt/Anna_F/Mathe/Mathe.md', 'Offline bearbeitet.')
  ben.engine.notifyLocalChange()
  await until(() => ben.shares.getState().shares[0]?.problem, 'the failed offline attempt is shown on the share')
  assert.equal(anna.host.text('Schule/Mathe.md'), 'Ben bearbeitet jetzt mit.')
  globalThis.fetch = onlineFetch
  await ben.engine.syncNow('manual')
  await until(() => anna.host.text('Schule/Mathe.md') === 'Offline bearbeitet.', 'offline edit reaches the owner after reconnect')
  await until(() => !ben.shares.getState().shares[0]?.problem, 'the error clears once the upload worked')

  // The received folder never goes into Ben's own cloud vault.
  ben.settings.vaultSync = true
  ben.engine.vaultSyncChanged()
  await ben.engine.syncNow('manual')
  assert.equal((await ben.engine.refreshAccount()).usage.files, 0)

  // ── Revoking is instant ────────────────────────────────────────────
  await anna.shares.remove(shareId)
  await until(() => ben.host.text('Mit mir geteilt/Anna_F/Mathe/Mathe.md') === null, 'revoked share disappears from the recipient')
  assert.equal(ben.shares.getState().shares.length, 0)
  assert.equal(ben.events.gone.length, 1)
  assert.equal(ben.events.gone[0].why, 'revoked')
  assert.equal(anna.host.text('Schule/Mathe.md'), 'Offline bearbeitet.', 'the owner keeps their own note')

  // People Ben accepted before are trusted: their next share needs no prompt. Anna sees it arrive as accepted at once.
  anna.host.put('Schule/Extra.md', 'zweiter Ordner')
  const trustedId = await anna.shares.share({ path: 'Schule', kind: 'folder', username: 'Ben.K', permission: 'read' })
  await until(() => ben.host.text('Mit mir geteilt/Anna_F/Schule/Extra.md') === 'zweiter Ordner', 'a trusted sender needs no approval')
  assert.equal(ben.shares.getState().pending.length, 0)
  assert.equal(ben.host.text('Mit mir geteilt/Anna_F/Schule/Mathe.md'), 'Offline bearbeitet.')
  await anna.shares.remove(trustedId)
  await until(() => ben.host.text('Mit mir geteilt/Anna_F/Schule/Extra.md') === null, 'second revoke is instant too')

  // ── Spam control: first-time senders need approval; decline plus block ──
  const cleo = createDevice('cleo-laptop')
  await cleo.engine.start()
  await cleo.engine.createAccount({ username: 'Cleo_Spam' })
  cleo.shares.start()
  await until(() => cleo.shares.getState().ready, 'sender ready')
  cleo.host.put('Werbung.md', 'Kauf jetzt!')
  const spamId = await cleo.shares.share({ path: 'Werbung.md', kind: 'note', username: 'Ben.K', permission: 'read' })
  await until(() => ben.shares.getState().pending.length === 1, 'an unknown sender waits for approval')
  assert.equal(ben.host.text('Mit mir geteilt/Cleo_Spam/Werbung/Werbung.md'), null)
  await ben.shares.respond(spamId, false, true)
  assert.deepEqual(ben.shares.getState().blocked, ['Cleo_Spam'])
  assert.equal(ben.shares.getState().shares.length, 0)
  const noticed = ben.events.incoming.length
  assert.ok(await cleo.shares.share({ path: 'Werbung.md', kind: 'note', username: 'Ben.K', permission: 'read' }), 'the sender gets no hint about the block')
  await sleep(300)
  assert.equal(ben.shares.getState().shares.length, 0, 'a blocked sender reaches nobody')
  assert.equal(ben.events.incoming.length, noticed)
  await ben.shares.unblock('Cleo_Spam')
  assert.deepEqual(ben.shares.getState().blocked, [])

  // ── Existing accounts keep working and can opt in to sharing ──────────
  const old = createDevice('old-laptop')
  await old.engine.start()
  await old.engine.register('legacy@example.org', 'ein altes passwort 77')
  assert.equal(old.engine.getState().account.username, null)
  assert.equal(old.settings.vaultSync, true, 'accounts that already existed keep cloud sync as it was')
  assert.equal(await old.engine.sharingIdentity(), null)
  await old.engine.claimUsername('Old_Olga')
  assert.equal(old.engine.getState().account.username, 'Old_Olga')
  assert.ok(await old.engine.sharingIdentity())
  await old.engine.logout()
  await old.engine.login('legacy@example.org', 'ein altes passwort 77')
  await old.engine.logout()
  await old.engine.login('old_olga', 'ein altes passwort 77')
  assert.equal(old.engine.getState().account.username, 'Old_Olga')

  // A device-key account can add a password; the key stops being the way in.
  await anna.engine.changePassword('', 'jetzt mit passwort 99')
  assert.equal(anna.engine.getState().account.credential, 'password')
  assert.equal((await anna.engine.deviceKeyAccounts()).length, 0)
  await anna.engine.logout()
  await anna.engine.login('Anna_F', 'jetzt mit passwort 99')
  assert.equal(anna.engine.getState().account.username, 'Anna_F')

  // ── Wiring ───────────────────────────────────────────────────────────
  assert.ok(read('electron/sync.cjs').includes("'device-keys'"))
  assert.ok(read('electron/preload.cjs').includes('secretsProtected: true'))
  assert.ok(read('src/App.tsx').includes('userShares.start()'))
  assert.ok(read('src/components/SyncSettingsSection.tsx').includes('Ohne Passwort/E-Mail ist dein Konto weg, wenn du dieses Gerät verlierst.'))
  assert.ok(read('src/components/SharedWithMePanel.tsx').includes('Mit mir geteilt'))
  assert.ok(read('src/components/ShareWithUserDialog.tsx').includes('Nur lesen'))

  console.log('account and share checks passed')
} finally {
  for (const device of devices) {
    try { device.shares.dispose() } catch { /* ignore */ }
    try { device.engine.dispose() } catch { /* ignore */ }
  }
  await vite.close()
  httpServer.closeAllConnections?.()
  httpServer.close()
  rmSync(dataDirectory, { recursive: true, force: true })
  setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref()
}
