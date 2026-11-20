// Writing mode, milestone 5: story files in sync. Merges on the shared
// fixtures (also run by Android's StorySyncTest), then two and three simulated
// devices against the real sync server module (fanotes-site/sync-api.mjs) on a
// local port: concurrent scene edits, edit vs delete, reorder vs edit, a late
// offline device, empty and truncated files, deliberate cuts, manifest and
// bible conflicts, per-device files, an interrupted sync, an open story; then
// story search units and conflict previews.
//   node scripts/check-writing-sync.mjs           check
//   node scripts/check-writing-sync.mjs --write   regenerate the fixture file
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const fixtureFile = join(appRoot, 'scripts/fixtures/writing-sync/cases.json')

globalThis.window = Object.assign(Object.create(null), {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  fanotes: { platform: 'test' },
  location: { origin: 'http://127.0.0.1' },
})
// Devices can be taken offline: their requests fail like a dropped network.
const offline = new Set()
const nodeFetch = globalThis.fetch
globalThis.fetch = (input, init = {}) => {
  const device = init.headers instanceof Headers ? init.headers.get('x-test-device') : init.headers?.['x-test-device']
  const headers = new Headers(init.headers)
  if (!headers.has('accept-language')) headers.set('Accept-Language', 'de-CH,de;q=0.9')
  const rule = [...offline].find((entry) => entry.matches(String(input), init))
  if (rule) { offline.delete(rule); return Promise.reject(new TypeError('fetch failed')) }
  void device
  return nodeFetch(input, { ...init, headers })
}

const dataDirectory = mkdtempSync(join(tmpdir(), 'fanotes-writing-sync-'))
process.env.FANOTES_SYNC_DIR = dataDirectory
const PORT = 19_000 + Math.floor(Math.random() * 400)
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
const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } })

const encoder = new TextEncoder()
const decoder = new TextDecoder()
let passed = 0
const check = async (name, body) => {
  try {
    await body()
    passed += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
}

try {
  const { SyncEngine } = await vite.ssrLoadModule('/src/lib/sync/engine.ts')
  const { SyncApi } = await vite.ssrLoadModule('/src/lib/sync/api.ts')
  const syncMerge = await vite.ssrLoadModule('/src/writing/syncMerge.ts')
  const { stampEdits, mergeManifests } = await vite.ssrLoadModule('/src/writing/model/merge.ts')
  const { storySearchUnits } = await vite.ssrLoadModule('/src/writing/searchUnits.ts')
  const { DocIndex } = await vite.ssrLoadModule('/src/lib/docSearch/docIndex.ts')
  const { listSearchDocuments } = await vite.ssrLoadModule('/src/lib/docSearch/extract.ts')
  const { paragraphForQuery } = await vite.ssrLoadModule('/src/writing/reveal.ts')
  const { previewOfVersion } = await vite.ssrLoadModule('/src/lib/sync/conflictPreview.ts')
  const { groupConflicts } = await vite.ssrLoadModule('/src/lib/sync/conflicts.ts')

  // ── Shared fixtures (TS ⇄ Kotlin) ─────────────────────────────────────────
  const { default: cases } = await import('./fixtures/writing-sync/make.mjs')
  const computed = cases.map((entry) => {
    const outcome = syncMerge.mergeStoryFile(entry.path, encoder.encode(JSON.stringify(entry.left)), encoder.encode(JSON.stringify(entry.right)), { localMtimeMs: 0, remoteMtimeMs: 0 })
    assert.equal(outcome?.kind, 'merged', entry.name)
    return { ...entry, expected: JSON.parse(decoder.decode(outcome.bytes)) }
  })
  if (process.argv.includes('--write')) writeFileSync(fixtureFile, `${JSON.stringify(computed, null, 1)}\n`)
  const stored = JSON.parse(readFileSync(fixtureFile, 'utf8'))
  await check('fixtures are current and symmetric', () => {
    assert.deepEqual(stored, computed, 'fixtures match the TS merge (run with --write after a deliberate change)')
    for (const entry of stored) {
      const swapped = syncMerge.mergeStoryFile(entry.path, encoder.encode(JSON.stringify(entry.right)), encoder.encode(JSON.stringify(entry.left)), { localMtimeMs: 0, remoteMtimeMs: 0 })
      assert.equal(JSON.stringify(JSON.parse(decoder.decode(swapped.bytes))), JSON.stringify(entry.expected), `${entry.name}: same bytes from either side`)
    }
    const texts = (scene) => scene.paragraphs.filter((paragraph) => !paragraph.deleted).map((paragraph) => paragraph.runs.map((run) => run.text).join(''))
    const [different, same, editDelete, reorder, notes, manifest, deletedEdited] = stored
    assert.deepEqual(texts(different.expected), ['Es war einmal ein großes Mädchen.', 'Sie aß gern Süßes.', 'Ende gut, alles gut.', 'Nachwort.'])
    assert.ok(texts(same.expected).includes('Sie aß gern Schokolade.') && texts(same.expected).includes('Sie aß gern Äpfel und Süßes.'), 'both versions of one paragraph are kept')
    assert.equal(same.expected.paragraphs.filter((paragraph) => paragraph.conflictOf === 'para000002').length, 1)
    assert.ok(texts(editDelete.expected).includes('Sie aß sehr gern Süßes.'), 'an edit wins over a delete')
    assert.ok(texts(reorder.expected).includes('Sie aß gern Kuchen.') && texts(reorder.expected).includes('Ende.'), 'reorder and edit both survive')
    assert.deepEqual(Object.keys(notes.expected.footnotes).sort(), ['fn00000001', 'fn00000002'])
    assert.ok(notes.expected.comments.cm00000001)
    const m = manifest.expected
    assert.equal(m.title, 'Der Roman', 'title from the newer manifest')
    assert.equal(m.binder[0].title, 'Erstes Kapitel')
    assert.deepEqual(m.binder[0].children.map((node) => node.id), ['scene000001', 'scene000003', 'scene000002'], 'binder union by node id (an older-only node stays after its older sibling)')
    assert.ok(m.binder.some((node) => node.id === 'trashbin'), 'the trash folder of the older side is kept')
    assert.deepEqual(m.dictionary, ['Mädchen', 'Zwölfe'])
    assert.deepEqual(m.ignored, ['spelling:Grüße'])
    assert.deepEqual(m.futureField, { keep: true }, 'unknown fields survive the merge')
    assert.deepEqual(deletedEdited.expected.binder[0].children.map((node) => node.title), ['Anfang (überarbeitet)'], 'a node deleted on one side and edited on the other is kept')
    assert.equal(mergeManifests(m, m).changedFromLeft, false)
  })

  // ── Devices ───────────────────────────────────────────────────────────────
  const createHost = (id) => {
    const files = new Map()
    let clock = 1_700_000_000_000
    const store = { state: new Map(), secrets: null }
    return {
      files,
      put(path, content) {
        clock += 1000
        files.set(path, { bytes: typeof content === 'string' ? encoder.encode(content) : content, mtimeMs: clock })
      },
      text(path) { return files.has(path) ? decoder.decode(files.get(path).bytes) : null },
      json(path) { return files.has(path) ? JSON.parse(decoder.decode(files.get(path).bytes)) : null },
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
  }
  let account = 0
  const devices = async (...names) => {
    account += 1
    const email = `story${account}@example.com`
    const list = []
    for (const name of names) {
      const host = createHost(`${name}-${account}`)
      const busy = new Set()
      const engine = new SyncEngine(new SyncApi(ORIGIN))
      const events = { conflicts: [], applied: [] }
      engine.attach(host, {
        platform: 'linux', deviceName: () => name, automatic: () => false,
        isPathBusy: (path) => [...busy].some((prefix) => path.startsWith(prefix)),
        onApplied: (change) => events.applied.push(change), onConflict: (conflict) => events.conflicts.push(conflict), onSignedOut: () => undefined,
      })
      if (!list.length) await engine.register(email, 'korrektes pferd batterie')
      else await engine.login(email, 'korrektes pferd batterie')
      list.push({ name, host, engine, events, busy, writer: name.toLowerCase().replace(/[^a-z0-9]/gu, '') })
    }
    return list
  }
  const syncAll = async (list, rounds = 2) => {
    for (let round = 0; round < rounds; round += 1) for (const device of list) await device.engine.syncNow()
  }
  const dispose = (list) => list.forEach((device) => device.engine.dispose())

  const STORY = 'Bücher/Roman.story'
  const SCENE = `${STORY}/scenes/scene000001.json`
  const long = (word, n) => Array.from({ length: n }, (_, index) => `${word} ${index} – über Straßen und Brücken, Grüße aus Zürich.`).join(' ')
  const freshScene = (count = 6, writer = 'laptop') => stampEdits({
    format: 'fanotes-story-scene-v1', id: 'scene000001',
    paragraphs: Array.from({ length: count }, (_, index) => ({ id: `para${String(index + 1).padStart(6, '0')}`, key: `a${index}`, v: {}, style: 'body', runs: [{ text: long(`Absatz ${index + 1}`, 20) }] })),
  }, null, writer)
  const manifest = (extra = {}) => ({
    format: 'fanotes-story-v1', id: 'story000001', title: 'Roman', language: 'de', page: { size: 'A5' }, styles: {},
    binder: [{ id: 'chap000001', kind: 'chapter', title: 'Kapitel 1', children: [{ id: 'scene000001', kind: 'scene', title: 'Anfang', synopsis: 'Ein Mädchen träumt.' }] }],
    dictionary: [], createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z', ...extra,
  })
  /** Edits a scene the way the editor saves: change, then stamp this writer's counters. */
  const edit = (device, change, path = SCENE) => {
    const saved = device.host.json(path)
    const next = change(structuredClone(saved))
    device.host.put(path, `${JSON.stringify(stampEdits(next, saved, device.writer))}\n`)
  }
  const setText = (scene, id, text) => { scene.paragraphs.find((paragraph) => paragraph.id === id).runs = [{ text }]; return scene }
  const liveTexts = (device, path = SCENE) => device.host.json(path).paragraphs.filter((paragraph) => !paragraph.deleted).map((paragraph) => paragraph.runs.map((run) => run.text).join(''))
  const conflictCopies = (device) => [...device.host.files.keys()].filter((path) => path.includes('(Konflikt'))
  const sameEverywhere = (list, path) => { for (const device of list.slice(1)) assert.equal(device.host.text(path), list[0].host.text(path), `${device.name} has the same ${path}`) }
  const seed = async (list) => {
    list[0].host.put(`${STORY}/story.json`, `${JSON.stringify(manifest(), null, 1)}\n`)
    list[0].host.put(SCENE, `${JSON.stringify(freshScene())}\n`)
    await syncAll(list, 1)
    for (const device of list) assert.ok(device.host.text(SCENE), `${device.name} has the scene`)
  }

  await check('three devices edit one scene at the same time: every edit is kept, no conflict copy', async () => {
    const list = await devices('Laptop', 'Tablet', 'Phone')
    const [A, B, C] = list
    await seed(list)
    edit(A, (scene) => setText(scene, 'para000001', 'Laptop: Der Anfang wurde überarbeitet.'))
    edit(B, (scene) => { setText(scene, 'para000003', 'Tablet: Mitte mit Ärger.'); scene.paragraphs.push({ id: 'para000099', key: 'a9', v: {}, style: 'body', runs: [{ text: 'Tablet: ein neuer Schluss.' }] }); return scene })
    edit(C, (scene) => setText(scene, 'para000005', 'Phone: Süßes zum Schluss.'))
    await syncAll(list, 3)
    sameEverywhere(list, SCENE)
    const texts = liveTexts(A)
    for (const expected of ['Laptop: Der Anfang wurde überarbeitet.', 'Tablet: Mitte mit Ärger.', 'Tablet: ein neuer Schluss.', 'Phone: Süßes zum Schluss.']) assert.ok(texts.includes(expected), expected)
    assert.equal(texts.length, 7)
    for (const device of list) assert.deepEqual(conflictCopies(device), [], `${device.name}: no whole-file conflict copy`)
    dispose(list)
  })

  await check('same paragraph on two devices: both versions, marked; edit vs delete; reorder vs edit', async () => {
    const list = await devices('Laptop', 'Tablet')
    const [A, B] = list
    await seed(list)
    edit(A, (scene) => setText(scene, 'para000002', 'Laptop-Fassung des zweiten Absatzes.'))
    edit(B, (scene) => setText(scene, 'para000002', 'Tablet-Fassung des zweiten Absatzes.'))
    edit(A, (scene) => { scene.paragraphs = scene.paragraphs.filter((paragraph) => paragraph.id !== 'para000004'); return scene })
    edit(B, (scene) => setText(scene, 'para000004', 'Tablet hat diesen Absatz behalten und geändert.'))
    edit(A, (scene) => { scene.paragraphs.find((paragraph) => paragraph.id === 'para000006').key = 'Zz'; return scene })
    edit(B, (scene) => setText(scene, 'para000006', 'Tablet: letzter Absatz, neu.'))
    await syncAll(list, 3)
    sameEverywhere(list, SCENE)
    const texts = liveTexts(A)
    assert.ok(texts.includes('Laptop-Fassung des zweiten Absatzes.') && texts.includes('Tablet-Fassung des zweiten Absatzes.'))
    assert.ok(A.host.json(SCENE).paragraphs.some((paragraph) => paragraph.conflictOf === 'para000002'), 'the second version is marked for review')
    assert.ok(texts.includes('Tablet hat diesen Absatz behalten und geändert.'), 'edit beats delete')
    assert.ok(texts.some((text) => text.startsWith('Tablet: letzter Absatz')), 'reorder vs edit keeps the text')
    assert.deepEqual(conflictCopies(A), [])
    assert.deepEqual(conflictCopies(B), [])
    dispose(list)
  })

  await check('a device that syncs late: nothing older or empty wins, nothing is lost', async () => {
    const list = await devices('Laptop', 'Tablet', 'Altes Handy')
    const [A, B, C] = list
    await seed(list)
    const SCENE2 = `${STORY}/scenes/scene000002.json`
    A.host.put(SCENE2, `${JSON.stringify({ ...freshScene(3), id: 'scene000002' })}\n`)
    await syncAll(list, 1)
    // C goes offline with the old versions and edits one paragraph.
    edit(C, (scene) => setText(scene, 'para000006', 'Handy (offline): der letzte Absatz.'))
    for (let version = 1; version <= 3; version += 1) {
      edit(A, (scene) => setText(scene, 'para000001', `Laptop Fassung ${version}.`))
      edit(B, (scene) => setText(scene, 'para000002', `Tablet Fassung ${version}.`), SCENE)
      edit(A, (scene) => setText(scene, 'para000001', `Szene zwei, Fassung ${version}.`), SCENE2)
      await A.engine.syncNow()
      await B.engine.syncNow()
      await A.engine.syncNow()
    }
    // C also lost a scene to a failed write: an empty file.
    C.host.put(SCENE2, '')
    await syncAll(list, 3)
    sameEverywhere(list, SCENE)
    sameEverywhere(list, SCENE2)
    const texts = liveTexts(A)
    assert.ok(texts.includes('Laptop Fassung 3.') && texts.includes('Tablet Fassung 2.') === false && texts.includes('Tablet Fassung 3.'), 'newest published versions win over the old ones')
    assert.ok(texts.includes('Handy (offline): der letzte Absatz.'), 'the late device keeps its edit')
    assert.ok(liveTexts(A, SCENE2).includes('Szene zwei, Fassung 3.'), 'the empty file did not replace the scene')
    dispose(list)
  })

  await check('truncated scene is merged back; a deliberate cut uploads without a guard', async () => {
    const list = await devices('Laptop', 'Tablet')
    const [A, B] = list
    await seed(list)
    // A file that lost most paragraphs without tombstones (not a save of the editor).
    const broken = A.host.json(SCENE)
    broken.paragraphs = broken.paragraphs.slice(0, 1)
    A.host.put(SCENE, `${JSON.stringify(broken)}\n`)
    await syncAll(list, 2)
    assert.equal(liveTexts(B).length, 6, 'the server copy kept every paragraph')
    assert.equal(liveTexts(A).length, 6, 'the missing paragraphs came back on the device')
    // The writer cuts the scene to one line: tombstones prove it.
    edit(A, (scene) => { scene.paragraphs = [{ ...scene.paragraphs[0], runs: [{ text: 'Nur noch das.' }] }]; return scene })
    assert.ok(A.host.text(SCENE).length * 4 < B.host.text(SCENE).length, 'severe shrink')
    await syncAll(list, 2)
    assert.deepEqual(liveTexts(B), ['Nur noch das.'], 'the cut reached the other device')
    assert.deepEqual(conflictCopies(A), [])
    assert.deepEqual(conflictCopies(B), [])
    dispose(list)
  })

  await check('manifest: binder edits on two devices merge; unknown fields survive', async () => {
    const list = await devices('Laptop', 'Tablet')
    const [A, B] = list
    await seed(list)
    const path = `${STORY}/story.json`
    const a = A.host.json(path)
    a.binder[0].children.push({ id: 'scene000002', kind: 'scene', title: 'Laptop-Szene' })
    a.dictionary = ['Zwölfe']
    a.updatedAt = '2026-11-15T10:00:00.000Z'
    A.host.put(path, `${JSON.stringify(a, null, 1)}\n`)
    const b = B.host.json(path)
    b.binder[0].title = 'Erstes Kapitel'
    b.binder.push({ id: 'chap000002', kind: 'chapter', title: 'Tablet-Kapitel', children: [] })
    b.dictionary = ['Grüezi']
    b.updatedAt = '2026-11-15T11:00:00.000Z'
    b.laterField = 7
    B.host.put(path, `${JSON.stringify(b, null, 1)}\n`)
    await syncAll(list, 3)
    sameEverywhere(list, path)
    const merged = A.host.json(path)
    assert.equal(merged.binder[0].title, 'Erstes Kapitel')
    assert.deepEqual(merged.binder[0].children.map((node) => node.id), ['scene000001', 'scene000002'])
    assert.ok(merged.binder.some((node) => node.id === 'chap000002'))
    assert.deepEqual([...merged.dictionary].sort(), ['Grüezi', 'Zwölfe'])
    assert.equal(merged.laterField, 7)
    assert.deepEqual(conflictCopies(A), [])
    dispose(list)
  })

  await check('bible entries: the newer one keeps the path, the other is a conflict copy on every device', async () => {
    const list = await devices('Laptop', 'Tablet')
    const [A, B] = list
    await seed(list)
    const path = `${STORY}/bible/characters/char000001.json`
    const entry = (name, at) => `${JSON.stringify({ format: 'fanotes-story-bible-v1', kind: 'character', id: 'char000001', name, fields: [{ label: 'Alter', value: '12' }], notes: `${name} wohnt an der Hauptstraße.`, updatedAt: at }, null, 2)}\n`
    A.host.put(path, entry('Anna', '2026-11-10T10:00:00.000Z'))
    await syncAll(list, 1)
    // B is newer but syncs second; A syncs first: the remote (B) must still win on A.
    A.host.put(path, entry('Anna Laptop', '2026-11-15T09:00:00.000Z'))
    B.host.put(path, entry('Anna Tablet', '2026-11-15T10:00:00.000Z'))
    await syncAll(list, 3)
    sameEverywhere(list, path)
    assert.equal(A.host.json(path).name, 'Anna Tablet')
    for (const device of list) {
      const copies = conflictCopies(device).filter((copy) => copy.startsWith(`${STORY}/bible/characters/`))
      assert.equal(copies.length, 1, `${device.name} has the other version`)
      assert.equal(device.host.json(copies[0]).name, 'Anna Laptop')
    }
    // Local newer than remote: the local version keeps the path.
    A.host.put(path, entry('Anna neu', '2026-11-16T10:00:00.000Z'))
    B.host.put(path, entry('Anna alt', '2026-11-15T12:00:00.000Z'))
    await B.engine.syncNow()
    await A.engine.syncNow()
    await syncAll(list, 2)
    sameEverywhere(list, path)
    assert.equal(B.host.json(path).name, 'Anna neu')
    assert.ok(conflictCopies(A).some((copy) => A.host.json(copy).name === 'Anna alt'), 'the older version is kept, not dropped')
    dispose(list)
  })

  await check('progress and snapshots: per-device and immutable files all arrive and stay', async () => {
    const list = await devices('Laptop', 'Tablet')
    const [A, B] = list
    await seed(list)
    A.host.put(`${STORY}/progress/laptop.json`, JSON.stringify({ format: 'fanotes-story-progress-v1', writer: 'laptop', days: { '2026-11-15': { start: 10, words: 500 } }, updatedAt: '2026-11-15T10:00:00Z' }))
    B.host.put(`${STORY}/progress/tablet.json`, JSON.stringify({ format: 'fanotes-story-progress-v1', writer: 'tablet', days: { '2026-11-15': { start: 10, words: 200 } }, updatedAt: '2026-11-15T10:00:00Z' }))
    A.host.put(`${STORY}/snapshots/scene000001/20261115T100000Z-laptop.json`, A.host.text(SCENE))
    await syncAll(list, 2)
    for (const device of list) {
      for (const file of ['progress/laptop.json', 'progress/tablet.json', 'snapshots/scene000001/20261115T100000Z-laptop.json']) assert.ok(device.host.text(`${STORY}/${file}`), `${device.name}: ${file}`)
    }
    dispose(list)
  })

  await check('interrupted sync: a failed upload after the merge loses nothing and converges', async () => {
    const list = await devices('Laptop', 'Tablet')
    const [A, B] = list
    await seed(list)
    edit(A, (scene) => setText(scene, 'para000001', 'Laptop vor dem Abbruch.'))
    await A.engine.syncNow()
    edit(B, (scene) => setText(scene, 'para000003', 'Tablet vor dem Abbruch.'))
    // B pulls and merges, then its uploads fail (network gone).
    let puts = 0
    offline.add({ matches: (_url, init) => init.method === 'PUT' && (puts += 1) >= 1 })
    offline.add({ matches: (_url, init) => init.method === 'PUT' })
    await B.engine.syncNow()
    assert.ok(liveTexts(B).includes('Laptop vor dem Abbruch.') && liveTexts(B).includes('Tablet vor dem Abbruch.'), 'the merge is on disk')
    offline.clear()
    await syncAll(list, 2)
    sameEverywhere(list, SCENE)
    assert.ok(liveTexts(A).includes('Tablet vor dem Abbruch.') && liveTexts(A).includes('Laptop vor dem Abbruch.'))
    dispose(list)
  })

  await check('an open story is left alone while it is open and merged when it closes', async () => {
    const list = await devices('Laptop', 'Tablet')
    const [A, B] = list
    await seed(list)
    A.busy.add(`${STORY}/`)
    edit(B, (scene) => setText(scene, 'para000002', 'Tablet, während der Laptop schreibt.'))
    await B.engine.syncNow()
    edit(A, (scene) => setText(scene, 'para000005', 'Laptop schreibt gerade.'))
    const before = A.host.text(SCENE)
    await A.engine.syncNow()
    assert.equal(A.host.text(SCENE), before, 'nothing is written under the open editor')
    A.busy.clear()
    await syncAll(list, 3)
    sameEverywhere(list, SCENE)
    assert.ok(liveTexts(A).includes('Tablet, während der Laptop schreibt.') && liveTexts(A).includes('Laptop schreibt gerade.'))
    dispose(list)
  })

  // ── Search ────────────────────────────────────────────────────────────────
  await check('search: scene text with umlauts and ß, titles, synopses, bible; hits name the scene', async () => {
    const files = {
      'story.json': JSON.stringify(manifest({ binder: [
        { id: 'chap000001', kind: 'chapter', title: 'Das Grüne Tor', children: [{ id: 'scene000001', kind: 'scene', title: 'Ankunft', synopsis: 'Sie überquert die Brücke.' }, { id: 'scene000002', kind: 'scene', title: 'Abschied' }] },
        { id: 'trashbin', kind: 'folder', title: 'Papierkorb', children: [{ id: 'scene000003', kind: 'scene', title: 'Gestrichen' }] }] })),
      'scenes/scene000001.json': JSON.stringify({ format: 'fanotes-story-scene-v1', id: 'scene000001', paragraphs: [
        { id: 'para000001', key: 'a0', v: { a: 1 }, style: 'body', runs: [{ text: 'Die Straße war nass.' }] },
        { id: 'para000002', key: 'a1', v: { a: 1 }, style: 'body', runs: [{ text: 'Gelöschter Satz mit Zauberwort.' }], deleted: true },
        { id: 'para000003', key: 'a2', v: { a: 1 }, style: 'body', runs: [{ text: 'Ännchen aß ' }, { text: 'Süßigkeiten', m: { i: true } }, { text: '.' }] }] }),
      'scenes/scene000002.json': JSON.stringify({ format: 'fanotes-story-scene-v1', id: 'scene000002', paragraphs: [{ id: 'para000009', key: 'a0', v: {}, style: 'body', runs: [{ text: 'Grüße aus Zürich.' }] }] }),
      'scenes/scene000003.json': JSON.stringify({ format: 'fanotes-story-scene-v1', id: 'scene000003', paragraphs: [{ id: 'para000010', key: 'a0', v: {}, style: 'body', runs: [{ text: 'Papierkorbtext.' }] }] }),
      'bible/characters/char000001.json': JSON.stringify({ format: 'fanotes-story-bible-v1', kind: 'character', id: 'char000001', name: 'Jörg Weiß', fields: [{ label: 'Beruf', value: 'Fährmann' }], updatedAt: 'x' }),
    }
    const path = 'Bücher/Märchen.story'
    const units = await storySearchUnits(path, Object.keys(files), async (relative) => files[relative] ?? null)
    const docs = listSearchDocuments([{ name: 'Märchen.story', relativePath: path, kind: 'file', extension: 'story', modifiedAt: '2026-11-15T10:00:00Z' }], () => 's:1')
    assert.equal(docs.length, 1)
    assert.equal(docs[0].kind, 'story')
    assert.notEqual(docs[0].fingerprint, listSearchDocuments([{ name: 'Märchen.story', relativePath: path, kind: 'file', extension: 'story', modifiedAt: '2026-11-15T10:00:00Z' }], () => 's:2')[0].fingerprint, 'a story change changes the fingerprint')
    const index = new DocIndex()
    index.setDoc({ path, title: 'Märchen', kind: 'story', fingerprint: docs[0].fingerprint, extractor: 1, status: 'indexed', attempts: 0, issues: [], ocrPages: 0, updatedAt: 0 })
    for (const unit of units) index.addUnit(unit)
    const top = (query) => index.search(query)[0]
    assert.equal(top('strasse')?.sceneId, 'scene000001', 'ß folds to ss')
    assert.equal(top('Straße')?.sceneId, 'scene000001')
    assert.equal(top('Süßigkeiten')?.sceneId, 'scene000001')
    assert.equal(top('aennchen')?.sceneId, 'scene000001', 'ä = ae')
    assert.equal(top('Grüße Zürich')?.sceneId, 'scene000002')
    assert.equal(top('Brücke')?.sceneId, 'scene000001', 'synopsis is indexed')
    assert.deepEqual(index.search('Grüne Tor').map((hit) => hit.sceneId).sort(), ['scene000001', 'scene000002'], 'chapter title is indexed with its scenes')
    assert.equal(top('Fährmann')?.kind, 'bible')
    assert.equal(index.search('Zauberwort').length, 0, 'deleted paragraphs are not indexed')
    assert.equal(index.search('Papierkorbtext').length, 0, 'scenes in the trash are not indexed')
    const scene = JSON.parse(files['scenes/scene000001.json'])
    assert.equal(paragraphForQuery(scene, 'süßigkeiten'), 'para000003', 'the hit opens at the paragraph')
  })

  // ── Conflict preview ──────────────────────────────────────────────────────
  await check('conflict page: scenes, manifests and bible entries preview as text, not JSON', () => {
    const scenePath = 'Roman.story/scenes/scene000001.json'
    const scene = { format: 'fanotes-story-scene-v1', id: 'scene000001', paragraphs: [
      { id: 'para000001', key: 'a0', v: {}, style: 'chapter', runs: [{ text: 'Erstes Kapitel' }] },
      { id: 'para000002', key: 'a1', v: {}, style: 'body', runs: [{ text: 'Sie ' }, { text: 'lief', m: { b: true } }, { text: ' über die Brücke.' }] },
      { id: 'para000003', key: 'a2', v: {}, style: 'body', runs: [], deleted: true }] }
    const preview = previewOfVersion([{ path: scenePath, bytes: encoder.encode(JSON.stringify(scene)) }])
    assert.equal(preview.kind, 'story')
    assert.deepEqual(preview.lines, ['# Erstes Kapitel', 'Sie lief über die Brücke.'])
    assert.equal(preview.paragraphs, 2)
    assert.ok(!preview.lines.join('\n').includes('"runs"'))
    const outline = previewOfVersion([{ path: 'Roman.story/story.json', bytes: encoder.encode(JSON.stringify(manifest())) }])
    assert.equal(outline.kind, 'story')
    assert.deepEqual(outline.lines, ['# Roman', '## Kapitel 1', '- Anfang – Ein Mädchen träumt.'])
    const sheet = previewOfVersion([{ path: 'Roman.story/bible/places/place00001.json', bytes: encoder.encode(JSON.stringify({ format: 'fanotes-story-bible-v1', kind: 'place', id: 'place00001', name: 'Zürich', fields: [{ label: 'Lage', value: 'am See' }], notes: 'Nebel.', updatedAt: 'x' })) }])
    assert.deepEqual(sheet.lines, ['# Zürich', '- Lage: am See', '', 'Nebel.'])
    assert.equal(previewOfVersion([{ path: scenePath, bytes: encoder.encode('{kaputt') }]).kind, 'damaged')
    const [group] = groupConflicts(new Set([scenePath, 'Roman.story/scenes/scene000001 (Konflikt Tablet 2026-11-15 10-00).json']))
    assert.deepEqual(group.story, { name: 'Roman', role: 'scene' })
  })

  // ── Wiring ────────────────────────────────────────────────────────────────
  await check('wiring: busy open story, search reveal, web story assets', () => {
    const app = readFileSync(join(appRoot, 'src/App.tsx'), 'utf8')
    // The open story waits for sync, except its scenes and manifest while the editor has nothing unsaved (liveSync.ts).
    assert.match(app, /writingPathRef\.current && path\.startsWith\(`\$\{writingPathRef\.current\}\/`\)\) return storySyncBusy\(writingPathRef\.current, path\)/u)
    assert.match(app, /notifyStoryWritten\(writingPathRef\.current, written\)/u)
    assert.match(app, /requestStoryReveal\(hit\.relativePath, \{ sceneId: hit\.sceneId/u)
    assert.match(app, /docSearch\.notifyStoryChanged/u)
    const host = readFileSync(join(appRoot, 'src/lib/sync/browserSyncHost.ts'), 'utf8')
    assert.match(host, /isTextNotePath\(path\) && !isStoryFilePath\(path\)/u)
    assert.match(readFileSync(join(appRoot, 'src/lib/browserApi.ts'), 'utf8'), /setMeta\('storyAssetTimes'/u)
  })

  console.log(`check-writing-sync: ok (${passed} groups)`)
} finally {
  await vite.close()
  httpServer.close()
  rmSync(dataDirectory, { recursive: true, force: true })
}
