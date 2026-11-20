// Live co-editing of shared notes: two (three) simulated devices against the real server module on a
// local port. Concurrent text and ink edits, presence, latency, batching, idle silence, offline and
// reconnect, restart from the local cache, permission enforcement, the file sync staying out of the
// way, and the server never holding plaintext.
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import * as Y from 'yjs'

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

const dataDirectory = mkdtempSync(join(tmpdir(), 'fanotes-live-collab-'))
process.env.FANOTES_SYNC_DIR = dataDirectory
process.env.FANOTES_MCP_DIR = join(dataDirectory, 'mcp')
process.env.FANOTES_SYNC_REGISTER_PER_HOUR = '1000'
/** Every POST to a live endpoint, as the server received it. */
const liveWire = []
const PORT = 19_100 + Math.floor(Math.random() * 300)
const ORIGIN = `http://127.0.0.1:${PORT}`
process.env.FANOTES_PUBLIC_ORIGIN = ORIGIN
const { handleSyncRequest } = await import('../../fanotes-site/sync-api.mjs')
const httpServer = createHttpServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost')
  let incoming = request
  if (request.method === 'POST' && url.pathname.includes('/live/')) {
    // Record the body exactly as it arrives, then hand the server an identical stream.
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    liveWire.push({ path: url.pathname, body: body.toString('utf8') })
    incoming = Object.assign(Readable.from([body]), { headers: request.headers, method: request.method, url: request.url, socket: request.socket, connection: request.connection, httpVersion: request.httpVersion })
  }
  if (await handleSyncRequest(incoming, response, url)) return
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
  const api = new SyncApi(ORIGIN)
  const shares = new UserShareManager(engine, api)
  const events = { incoming: [], gone: [], applied: [] }
  shares.attach(host, {
    onIncoming: (share) => events.incoming.push(share),
    onGone: (share, why) => events.gone.push({ share, why }),
    onApplied: (change) => events.applied.push(change),
  })
  const device = { name, host, settings, engine, shares, events, api, offline: false }
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

const wait = async (check, what, ms = 4000) => {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(2)
  }
}

const ink = await vite.ssrLoadModule('/src/lib/collab/liveInk.ts')
const awarenessModule = await vite.ssrLoadModule('/src/lib/collab/liveAwareness.ts')

/** A device that can be cut off from the server: sends and fetches fail, pushes are dropped. */
const withNetwork = (device) => {
  const { api, shares } = device
  for (const name of ['liveSend', 'liveFetch']) {
    const original = api[name].bind(api)
    api[name] = (...args) => (device.offline ? Promise.reject(new SyncApiError(0, 'offline')) : original(...args))
  }
  const route = shares.routeLive.bind(shares)
  shares.routeLive = (event) => { if (!device.offline) route(event) }
}

const stroke = (x, y, color = '#112233') => ({
  color,
  baseWidth: 2,
  pressureEnabled: true,
  points: Array.from({ length: 5 }, (_, index) => ({ x: x + index * 3, y: y + index, t: index, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' })),
})
const shifted = (source, dx, dy) => ({ ...source, points: source.points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy })) })

try {
  // ── Pure pieces ───────────────────────────────────────────────────────
  {
    const a = awarenessModule.liveUserFor('Anna_F')
    assert.equal(a.color, awarenessModule.liveUserFor('Anna_F').color, 'a person keeps their colour')
    assert.equal(awarenessModule.liveInitials('Anna_F'), 'AF')
    assert.equal(awarenessModule.liveInitials('ben'), 'BE')
    // Ink ids are content-derived for file strokes, so two devices that load one file agree.
    const one = ink.contentIdOf(stroke(1, 2))
    assert.equal(one, ink.contentIdOf(stroke(1, 2)))
    assert.notEqual(one, ink.contentIdOf(stroke(1, 3)))
  }

  // ── Accounts and an editable note share ────────────────────────────
  const anna = createDevice('anna-laptop')
  const ben = createDevice('ben-laptop')
  const cleo = createDevice('cleo-laptop')
  await anna.engine.start(); await ben.engine.start(); await cleo.engine.start()
  await anna.engine.createAccount({ username: 'Anna_F' })
  await ben.engine.createAccount({ username: 'Ben_K' })
  await cleo.engine.createAccount({ username: 'Cleo_R' })
  for (const device of [anna, ben, cleo]) { device.shares.start(); withNetwork(device) }
  await until(() => [anna, ben, cleo].every((device) => device.shares.getState().ready && device.shares.getState().live), 'share managers ready')

  const NOTE = 'Schule/Plan.md'
  const BEN_NOTE = 'Mit mir geteilt/Anna_F/Plan/Plan.md'
  const NOTE2 = 'Schule/Lesen.md'
  const CLEO_NOTE = 'Mit mir geteilt/Anna_F/Lesen/Lesen.md'
  anna.host.put(NOTE, 'Titel\n\nErster Absatz.\n')
  anna.host.put(NOTE2, 'Nur zum Lesen.\n')
  const editShare = await anna.shares.share({ path: NOTE, kind: 'note', username: 'Ben_K', permission: 'edit' })
  await until(() => ben.shares.getState().pending.length === 1, 'share arrives')
  await ben.shares.respond(editShare, true)
  await until(() => ben.host.text(BEN_NOTE) === 'Titel\n\nErster Absatz.\n', 'recipient copy')
  const readShare = await anna.shares.share({ path: NOTE2, kind: 'note', username: 'Cleo_R', permission: 'read' })
  await until(() => cleo.shares.getState().pending.length === 1, 'read share arrives')
  await cleo.shares.respond(readShare, true)
  await until(() => cleo.host.text(CLEO_NOTE) === 'Nur zum Lesen.\n', 'reader copy')

  // Live info reflects the permission, and only notes that belong to an accepted share qualify.
  assert.equal(anna.shares.liveInfoFor(NOTE)?.canWrite, true)
  assert.equal(ben.shares.liveInfoFor(BEN_NOTE)?.canWrite, true)
  assert.equal(cleo.shares.liveInfoFor(CLEO_NOTE)?.canWrite, false)
  assert.equal(anna.shares.liveInfoFor('Schule/Andere.md'), null)

  // ── Joining: the first device starts the session, the second joins it ───
  const open = async (device, path) => {
    const outcome = await device.shares.openLive(path, device.host.text(path))
    assert.ok(outcome.note, `live note opens on ${device.name}: ${outcome.reason}`)
    return outcome.note
  }
  const annaNote = await open(anna, NOTE)
  const benNote = await open(ben, BEN_NOTE)
  assert.equal(annaNote.ytext.toString(), 'Titel\n\nErster Absatz.\n')
  assert.equal(benNote.ytext.toString(), 'Titel\n\nErster Absatz.\n', 'the second device joins the same history, no duplicated text')
  assert.equal(annaNote.status, 'live')
  // A reader joins a session somebody else started; a reader cannot start one.
  const idle = await cleo.shares.openLive(CLEO_NOTE, cleo.host.text(CLEO_NOTE))
  assert.deepEqual([idle.note, idle.reason], [null, 'idle'], 'a note nobody edits live stays a plain file for a reader')
  const annaRead = await open(anna, NOTE2)
  const outsiderRead = await open(cleo, CLEO_NOTE)
  annaRead.ytext.insert(annaRead.ytext.length, 'Neu für Cleo.')
  await wait(() => outsiderRead.ytext.toString().endsWith('Neu für Cleo.'), 'a read-only user receives live text')

  // ── Concurrent typing merges without losing characters ───────────
  {
    const textA = annaNote.ytext
    const textB = benNote.ytext
    const wordsA = Array.from({ length: 25 }, (_, index) => `a${index};`)
    const wordsB = Array.from({ length: 25 }, (_, index) => `b${index};`)
    for (let index = 0; index < 25; index += 1) {
      textA.insert(textA.toString().indexOf('Titel') + 5, wordsA[index])
      textB.insert(textB.length, wordsB[index])
      if (index % 5 === 0) await sleep(10)
    }
    await wait(() => textA.toString() === textB.toString() && wordsA.every((word) => textA.toString().includes(word)) && wordsB.every((word) => textA.toString().includes(word)), 'concurrent typing converges')
    for (const word of [...wordsA, ...wordsB]) assert.equal(textA.toString().split(word).length - 1, 1, `${word} appears exactly once`)
  }

  // ── Latency (target < 200 ms) and batching ──────────────────────────
  {
    const samples = []
    for (let index = 0; index < 20; index += 1) {
      const mark = `<${index}>`
      const started = performance.now()
      annaNote.ytext.insert(annaNote.ytext.length, mark)
      await wait(() => benNote.ytext.toString().endsWith(mark), 'keystroke arrives')
      samples.push(performance.now() - started)
      await sleep(15)
    }
    samples.sort((a, b) => a - b)
    const median = samples[10]
    const worst = samples[19]
    console.log(`live latency: median ${median.toFixed(0)} ms, worst ${worst.toFixed(0)} ms`)
    assert.ok(median < 200, `median keystroke latency ${median} ms`)
    assert.ok(worst < 500, `worst keystroke latency ${worst} ms`)

    // A burst inside one frame is one request.
    await sleep(100)
    const before = liveWire.filter((record) => record.body.includes('"k":"u"')).length
    annaNote.ytext.doc.transact(() => {})
    for (let index = 0; index < 60; index += 1) annaNote.ytext.insert(annaNote.ytext.length, 'x')
    await wait(() => benNote.ytext.toString().endsWith('x'.repeat(60)), 'burst arrives')
    const requests = liveWire.filter((record) => record.body.includes('"k":"u"')).length - before
    assert.ok(requests <= 2, `60 edits in one tick were sent as ${requests} requests`)
  }

  // ── Idle: nothing is sent while nobody types ───────────────────────
  {
    await sleep(300)
    const before = liveWire.length
    await sleep(1800)
    assert.equal(liveWire.length, before, 'no traffic while idle (presence refreshes every 30 s, not faster)')
  }

  // ── Presence: names, colours, cursors, pen, leaving ────────────────
  {
    annaNote.awareness.setLocalStateField('cursor', { anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(annaNote.ytext, 3)), head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(annaNote.ytext, 6)) })
    annaNote.setPen({ x: 120, y: 340, down: true })
    await wait(() => benNote.people().length === 1, 'presence arrives')
    const [person] = benNote.people()
    assert.equal(person.name, 'Anna_F')
    assert.equal(person.color, awarenessModule.liveUserFor('Anna_F').color)
    assert.deepEqual(person.pen, { x: 120, y: 340, down: true })
    const remoteState = [...benNote.awareness.getStates().values()].find((state) => state.user?.name === 'Anna_F')
    assert.ok(remoteState.cursor?.anchor && remoteState.cursor?.head, 'the cursor and selection travel as relative positions')
    // Presence is encrypted and not kept by the server.
    assert.ok(liveWire.some((record) => record.body.includes('"k":"p"')))
    // Both sides know each other (a newcomer is answered), the reader is invisible because it cannot send.
    await wait(() => annaNote.people().length === 1, 'the newcomer sees the others as well')
    assert.ok(!annaRead.people().some((entry) => entry.name === 'Cleo_R'), 'a read-only viewer sends no presence')
  }

  // ── Ink: strokes as a CRDT ─────────────────────────────────────────
  {
    const seenByBen = []
    const seenByAnna = []
    const annaInk = annaNote.attachInk((change) => seenByAnna.push(change))
    const benInk = benNote.attachInk((change) => seenByBen.push(change))
    const base = stroke(10, 10)
    // The board hands its committed strokes over; Anna's file had one, Ben has the same file.
    assert.equal(annaInk.attach([base]).length, 1)
    await sleep(150)
    assert.equal(benInk.attach([stroke(10, 10)]).length, 1, 'the same file stroke is recognised, not duplicated')
    assert.equal(benInk.current().length, 1)
    let annaBoard = annaInk.current()
    let benBoard = benInk.current()

    // A new stroke appears live at the other side.
    const drawn = stroke(50, 50, '#ff0000')
    seenByBen.length = 0
    annaBoard = [...annaBoard, drawn]
    annaInk.push(annaBoard)
    await wait(() => seenByBen.some((change) => change.added.length === 1), 'stroke arrives live')
    benBoard = [...benBoard, ...seenByBen.at(-1).added]
    benInk.acknowledge(benBoard)
    assert.equal(benBoard.length, 2)
    assert.deepEqual(benBoard[1].points.map((point) => point.x), drawn.points.map((point) => point.x))

    // Erase on one side, concurrent move of the same stroke on the other: the erase wins, nothing half-alive stays.
    seenByAnna.length = 0
    seenByBen.length = 0
    const erased = benBoard[1]
    benBoard = [benBoard[0]]
    annaBoard = [annaBoard[0], shifted(drawn, 40, 40)]
    benInk.push(benBoard)
    annaInk.push(annaBoard)
    await wait(() => annaInk.current().length === 1 && benInk.current().length === 1, 'erase wins over a concurrent move')
    assert.equal(annaInk.current()[0].color, '#112233')
    void erased

    // Two people draw at once: both strokes end up on both pages, in the same order.
    const fromAnna = stroke(200, 10, '#00aa00')
    const fromBen = stroke(200, 80, '#0000aa')
    annaBoard = [...annaInk.current(), fromAnna]
    benBoard = [...benInk.current(), fromBen]
    annaInk.push(annaBoard)
    benInk.push(benBoard)
    await wait(() => annaInk.current().length === 3 && benInk.current().length === 3, 'both new strokes arrive')
    assert.deepEqual(annaInk.current().map((entry) => entry.color), benInk.current().map((entry) => entry.color))

    // A move of one stroke is a move, not an erase plus a new stroke.
    seenByBen.length = 0
    const moving = annaInk.current()[0]
    const moved = shifted(moving, 7, -3)
    annaInk.push([moved, ...annaInk.current().slice(1)])
    await wait(() => seenByBen.some((change) => change.replaced.length === 1), 'move arrives as a replacement')
    assert.equal(benInk.current().length, 3)
    assert.equal(seenByBen.at(-1).replaced[0].to.points[0].x, moving.points[0].x + 7)

    // A stroke that is still being drawn is not in the document, so an erase of its neighbours cannot touch it.
    const stillDrawing = stroke(300, 300, '#abcdef')
    const board = benInk.current().slice(0, 1)
    benInk.push(board)
    await wait(() => annaInk.current().length === 1, 'erase of other strokes propagates')
    annaInk.push([...annaInk.current(), stillDrawing])
    await wait(() => benInk.current().length === 2, 'the finished stroke arrives after the erase')
    assert.equal(benInk.current()[1].color, '#abcdef')
  }

  // ── Persisting: the merged text goes to the normal share file, no loops, no copies ──
  {
    const merged = annaNote.ytext.toString()
    anna.host.put(NOTE, merged)
    ben.host.put(BEN_NOTE, merged)
    anna.engine.notifyLocalChange()
    ben.engine.notifyLocalChange()
    await sleep(2800)
    const listing = (device) => [...device.host.files.keys()].filter((path) => path.includes('Konflikt'))
    assert.deepEqual(listing(anna), [], 'no conflict copies on the owner')
    assert.deepEqual(listing(ben), [], 'no conflict copies on the recipient')
    assert.equal(anna.host.text(NOTE), ben.host.text(BEN_NOTE))
    // While the session runs the file is not overwritten by pulls; type more and it stays the live text.
    annaNote.ytext.insert(0, 'LIVE ')
    await wait(() => benNote.ytext.toString().startsWith('LIVE '), 'edit arrives')
    ben.host.put(BEN_NOTE, benNote.ytext.toString())
    ben.engine.notifyLocalChange()
    await sleep(2200)
    assert.equal(ben.host.text(BEN_NOTE).startsWith('LIVE '), true)
    assert.deepEqual(listing(ben), [])
  }

  // ── Permission enforcement ────────────────────────────────────────
  {
    const before = outsiderRead.ytext.toString()
    // A read-only device cannot send: its edits stay local and the server refuses a direct attempt too.
    assert.equal(outsiderRead.canWrite, false)
    await assert.rejects(() => cleo.api.liveSend(cleo.engine.getSession(), readShare, 'a'.repeat(32), { k: 'u', d: Buffer.alloc(40, 1).toString('base64') }), (error) => error.status === 403)
    await assert.rejects(() => cleo.api.liveSend(cleo.engine.getSession(), readShare, 'a'.repeat(32), { k: 'p', d: Buffer.alloc(40, 1).toString('base64') }), (error) => error.status === 403)
    outsiderRead.ytext.insert(0, 'ILLEGAL ')
    await sleep(400)
    assert.ok(!annaRead.ytext.toString().includes('ILLEGAL'), 'a read-only edit never reaches the others')
    outsiderRead.ytext.delete(0, 8)
    assert.equal(outsiderRead.ytext.toString(), before)
    // The permission can be taken away while somebody is in the note.
    await anna.shares.setPermission(editShare, 'read')
    await until(() => ben.shares.liveInfoFor(BEN_NOTE)?.canWrite === false, 'permission change reaches Ben')
    benNote.ytext.insert(0, 'NOT ALLOWED ')
    await sleep(500)
    assert.ok(!annaNote.ytext.toString().includes('NOT ALLOWED'), 'after the downgrade the server refuses Ben')
    await anna.shares.setPermission(editShare, 'edit')
    await until(() => ben.shares.liveInfoFor(BEN_NOTE)?.canWrite === true, 'permission restored')
    benNote.ytext.delete(0, 12)
    await benNote.channel.resync()
    await wait(() => annaNote.ytext.toString() === benNote.ytext.toString(), 'after the permission is back the held-back edits are consistent')
  }

  // ── Offline and reconnect ─────────────────────────────────────────
  {
    await sleep(300)
    ben.offline = true
    annaNote.ytext.insert(annaNote.ytext.length, ' [Anna schreibt weiter]')
    benNote.ytext.insert(benNote.ytext.length, ' [Ben ist offline]')
    await sleep(600)
    assert.ok(!annaNote.ytext.toString().includes('Ben ist offline'))
    assert.ok(!benNote.ytext.toString().includes('Anna schreibt weiter'))
    ben.offline = false
    await benNote.channel.resync()
    await wait(() => annaNote.ytext.toString() === benNote.ytext.toString() && benNote.ytext.toString().includes('Anna schreibt weiter') && benNote.ytext.toString().includes('Ben ist offline'), 'both edits merge after reconnect')
  }

  // ── Leaving and coming back: the device cache keeps offline edits ──
  {
    await benNote.close()
    await wait(() => annaNote.people().length === 0, 'presence fades when Ben leaves')
    // Ben edits the file while away (not in a live session), and Anna keeps typing.
    const away = ben.host.text(BEN_NOTE)
    ben.host.put(BEN_NOTE, `${away}\nBen schrieb das ohne Verbindung.`)
    annaNote.ytext.insert(0, '>> ')
    await sleep(300)
    const again = await open(ben, BEN_NOTE)
    assert.equal(again.diverged, null)
    await wait(() => again.ytext.toString() === annaNote.ytext.toString(), 'rejoined and merged')
    assert.ok(again.ytext.toString().startsWith('>> '), 'Anna\'s change arrived')
    assert.ok(again.ytext.toString().includes('Ben schrieb das ohne Verbindung.'), 'Ben\'s offline edit was kept')
    assert.equal(again.ytext.toString().split('Ben schrieb das ohne Verbindung.').length - 1, 1, 'and not duplicated')
    again.close = again.close.bind(again)
    await again.close()
  }

  // ── The server only relays ciphertext ──────────────────────────────
  {
    const secrets = ['Erster Absatz', 'Anna schreibt weiter', 'Ben ist offline', 'Ben schrieb das ohne', 'LIVE ', '#ff0000']
    for (const record of liveWire) {
      for (const secret of secrets) assert.ok(!record.body.includes(secret), `plaintext "${secret}" in a request body`)
      const parsed = JSON.parse(record.body)
      assert.ok(/^[A-Za-z0-9+/]+={0,2}$/u.test(parsed.d), 'bodies are base64 ciphertext')
    }
    await sleep(1000)
    const stored = [...serverFiles(join(dataDirectory, 'user-shares')), ...(existsSync(join(dataDirectory, 'live-rooms')) ? serverFiles(join(dataDirectory, 'live-rooms')) : [])]
    for (const file of stored) {
      const bytes = readFileSync(file).toString('latin1')
      for (const secret of secrets) assert.ok(!bytes.includes(secret), `plaintext "${secret}" stored in ${file}`)
      assert.ok(!bytes.includes('Plan'), `a name leaked into ${file}`)
    }
    assert.ok(stored.some((file) => file.endsWith('live.json')), 'the buffer exists and is ciphertext')
    // Another account holding another key cannot open what the relay carries.
    const stray = await crypto.deriveShareKeys(crypto.newShareKey())
    const sample = JSON.parse(liveWire.find((record) => record.body.includes('"k":"u"')).body).d
    await assert.rejects(() => crypto.decryptBytes(stray, `live:${'a'.repeat(32)}:u`, crypto.fromBase64(sample)), /entschlüsselt/u)
  }

  // ── Three people in one note; revoking one mid-session ───────────────
  {
    const GROUP = 'Schule/Gruppe.md'
    const BEN_G = 'Mit mir geteilt/Anna_F/Gruppe/Gruppe.md'
    const CLEO_G = 'Mit mir geteilt/Anna_F/Gruppe/Gruppe.md'
    anna.host.put(GROUP, 'Gruppenarbeit\n')
    const shareBen = await anna.shares.share({ path: GROUP, kind: 'note', username: 'Ben_K', permission: 'edit' })
    const shareCleo = await anna.shares.share({ path: GROUP, kind: 'note', username: 'Cleo_R', permission: 'edit' })
    await until(() => ben.host.text(BEN_G) === 'Gruppenarbeit\n' && cleo.host.text(CLEO_G) === 'Gruppenarbeit\n', 'both recipients have the group note')
    await until(() => ben.shares.liveInfoFor(BEN_G) && cleo.shares.liveInfoFor(CLEO_G) && anna.shares.liveInfoFor(GROUP), 'all three know the note')
    const nA = await open(anna, GROUP)
    const nB = await open(ben, BEN_G)
    const nC = await open(cleo, CLEO_G)
    const room = nA.channel.options.channel
    assert.equal(nB.channel.options.channel, room, 'all collaborators are in one room')
    assert.equal(nC.channel.options.channel, room)
    assert.notEqual(nA.info.shareId, nC.info.shareId, 'although they hold different shares')
    for (const [first, second] of [[nA, nB], [nA, nC]]) assert.equal(first.ytext.toString(), second.ytext.toString())

    // Concurrent typing from all three, with everyone's presence visible to everyone.
    const tags = ['<anna>', '<ben>', '<cleo>']
    nA.ytext.insert(0, tags[0]); nB.ytext.insert(nB.ytext.length, tags[1]); nC.ytext.insert(nC.ytext.length, tags[2])
    await wait(() => [nA, nB, nC].every((note) => tags.every((tag) => note.ytext.toString().includes(tag))) && nA.ytext.toString() === nB.ytext.toString() && nB.ytext.toString() === nC.ytext.toString(), 'three-way concurrent typing converges')
    nA.setPen({ x: 0.2, y: 0.3, down: true }); nB.setPen({ x: 0.5, y: 0.5, down: false }); nC.setPen({ x: 0.7, y: 0.1, down: true })
    await wait(() => [nA, nB, nC].every((note) => note.people().length === 2), 'presence shows everyone')
    assert.deepEqual(nA.people().map((person) => person.name), ['Ben_K', 'Cleo_R'])
    assert.deepEqual(nC.people().map((person) => person.name), ['Anna_F', 'Ben_K'])

    // The merged text is what each device saves (the app autosaves it).
    for (const [device, path, note] of [[anna, GROUP, nA], [ben, BEN_G, nB], [cleo, CLEO_G, nC]]) device.host.put(path, note.ytext.toString())
    const oldKeys = nC.channel.options.keys
    const oldRoom = room
    let cleoPushes = 0
    const routeC = cleo.shares.routeLive.bind(cleo.shares)
    cleo.shares.routeLive = (event) => { cleoPushes += 1; routeC(event) }
    const mark = liveWire.length

    // Anna revokes Cleo while all three are in the note.
    await anna.shares.remove(shareCleo)
    await until(() => nA.status === 'closed' && nB.status === 'closed', 'the remaining collaborators move to the new room')
    await until(() => cleo.shares.liveInfoFor(CLEO_G) === null, 'Cleo loses the share')
    const nA2 = await open(anna, GROUP)
    const nB2 = await open(ben, BEN_G)
    assert.notEqual(nA2.channel.options.channel, oldRoom, 'the room was rotated')
    assert.equal(nB2.channel.options.channel, nA2.channel.options.channel)
    assert.equal(nA2.ytext.toString(), nB2.ytext.toString())
    nA2.ytext.insert(0, 'NACH-DEM-WIDERRUF ')
    nB2.ytext.insert(nB2.ytext.length, ' (Ben auch)')
    nA2.setPen({ x: 0.1, y: 0.1, down: true })
    await wait(() => nB2.ytext.toString().includes('NACH-DEM-WIDERRUF') && nA2.ytext.toString().includes('(Ben auch)'), 'two collaborators keep editing')
    await wait(() => nA2.people().length === 1 && nA2.people()[0].name === 'Ben_K', 'presence after the revoke shows only the remaining people')
    await sleep(400)

    // The revoked user received nothing, can fetch nothing, and could not decrypt what was sent anyway.
    const before = cleoPushes
    assert.equal(cleoPushes, before)
    assert.equal(nC.ytext.toString().includes('NACH-DEM-WIDERRUF'), false, 'Cleo\'s copy of the note never saw the later edit')
    await assert.rejects(() => cleo.api.liveFetch(cleo.engine.getSession(), shareCleo, oldRoom, 0), (error) => error.status === 404)
    await assert.rejects(() => cleo.api.liveSend(cleo.engine.getSession(), shareCleo, oldRoom, { k: 'u', d: Buffer.alloc(40, 2).toString('base64') }), (error) => error.status === 404)
    const later = liveWire.slice(mark).filter((record) => JSON.parse(record.body).k === 'u' && !record.path.includes(`/shares/${shareCleo}/`))
    assert.ok(later.length > 0)
    for (const record of later) {
      const parsed = JSON.parse(record.body)
      await assert.rejects(() => crypto.decryptBytes(oldKeys, `live:${oldRoom}:u`, crypto.fromBase64(parsed.d)), /entschlüsselt/u, 'the old room key opens nothing sent after the revoke')
      assert.ok(!record.path.endsWith(`/live/${oldRoom}`), 'nothing was sent to the old room afterwards')
    }
    await nA2.close(); await nB2.close(); await nC.close()
  }

  // ── Revoking ends it at once ──────────────────────────────────────
  await anna.shares.remove(readShare)
  await until(() => cleo.shares.liveInfoFor(CLEO_NOTE) === null, 'the reader loses live access with the share')
  await annaNote.close()
  await annaRead.close()
  await outsiderRead.close()

  // ── Wiring ────────────────────────────────────────────────────────
  assert.ok(read('src/components/MarkdownEditor.tsx').includes("import('../lib/collab/liveEditor')"), 'y-codemirror.next is loaded on demand')
  assert.ok(!read('src/lib/sync/userShares.ts').match(/^import .* from '\.\.\/collab\/live(Channel|Notes)'$/mu)?.[0]?.includes('import {'), 'Yjs is only imported as types or on demand by the share manager')
  console.log('live collaboration checks passed')
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
