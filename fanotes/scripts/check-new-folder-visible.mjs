// Regression check: a folder created in FaNotes must show up in the tree.
// Covers (1) stale tree results overwriting a newer one in the renderer,
// (2) the main-process watcher walk being reused across an own mutation,
// (3) the tag filter hiding an empty new folder, (4) folders that exist in
// several linked locations, (5) the watcher noticing a new empty nested folder.
// Node only, temp dirs and synthetic data.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { createTreeScanCache, mergeTreeEntries } = require('../electron/tree-scan.cjs')
const folderLocations = require('../electron/folder-locations.cjs')
const { createVaultWatcher, flattenTree } = require('../electron/vault-watch.cjs')
const { createTreeSync } = await import(pathToFileURL(path.join(root, 'src/lib/treeSync.mjs')).href)

const folder = (name, children = []) => ({ name, relativePath: name, kind: 'folder', children })
const names = (tree) => tree.map((entry) => entry.name)
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

// ---- 1. Renderer: tree results are applied in request order -----------------
{
  // Mocked window.fanotes: getTree answers are released by the test.
  const pending = []
  const fanotes = {
    getTree: (options) => { const d = deferred(); pending.push({ options, ...d }); return d.promise },
  }
  let shown = []
  const sync = createTreeSync((tree) => { shown = tree })
  const oldTree = [folder('A')]
  const newTree = [folder('A'), folder('A2')]

  // Watcher refresh starts first, own refresh (after mkdir) second.
  const watcher = sync.request(() => fanotes.getTree({ fromWatcher: true }))
  const own = sync.request(() => fanotes.getTree())
  pending[1].resolve(newTree) // own refresh answers first
  assert.equal((await own).applied, true)
  pending[0].resolve(oldTree) // the older watcher answer arrives late
  assert.equal((await watcher).applied, false, 'a stale watcher result must be dropped')
  assert.deepEqual(names(shown), ['A', 'A2'], 'the new folder must stay visible')

  // In order: both apply.
  pending.length = 0
  const first = sync.request(() => fanotes.getTree())
  pending[0].resolve(oldTree)
  await first
  const second = sync.request(() => fanotes.getTree())
  pending[1].resolve(newTree)
  assert.equal((await second).applied, true)
  assert.deepEqual(names(shown), ['A', 'A2'])

  // Startup: a cached tree requested earlier must not replace a refresh that already applied.
  const cachedTicket = sync.begin()
  const refreshed = await sync.request(async () => [folder('A'), folder('A2'), folder('A3')])
  assert.equal(refreshed.applied, true)
  assert.equal(sync.accept(cachedTicket, oldTree), false)
  assert.deepEqual(names(shown), ['A', 'A2', 'A3'])
}

// The app must route every fetched tree through the guard.
{
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')
  const direct = app.split('\n').filter((line) => /\bsetTree\(/.test(line) && !/setTree\(\[\]\)/.test(line) && !/treeRef\.current = next; setTree\(next\)/.test(line))
  assert.deepEqual(direct, [], 'every tree result must go through treeSyncRef (found a direct setTree)')
  assert.match(app, /sync\.accept\(ticket, fetchedTree\)/, 'the watcher listener must use the ordering guard')
  const create = app.slice(app.indexOf('const createFolder = useCallback'), app.indexOf('const openFolderPath'))
  assert.match(create, /setTagFilter\(null\)/, 'creating a folder must clear a tag filter that would hide it')
}

// ---- 2. Main: the watcher walk is not reusable across an own mutation --------
{
  let clock = 1000
  const cache = createTreeScanCache({ now: () => clock })
  const R = '/vault'
  const staleWalk = [folder('A')]

  // Walk starts before mkdir, mkdir happens (bump), walk finishes afterwards.
  const token = cache.begin()
  cache.bump() // own mutation starts
  cache.bump() // own mutation done
  cache.finish(token, R, staleWalk)
  cache.markReusable(R)
  assert.equal(cache.take(R, { fromWatcher: true }), null, 'a walk from before the mutation must not be reused')

  // Walk fully after the mutation is reusable once, only for the watcher caller.
  const fresh = [folder('A'), folder('A2')]
  cache.finish(cache.begin(), R, fresh)
  cache.markReusable(R)
  assert.equal(cache.take(R, { fromWatcher: false }), null, 'only the watcher caller may reuse a walk')
  cache.finish(cache.begin(), R, fresh)
  cache.markReusable(R)
  assert.equal(cache.take(R, { fromWatcher: true }), fresh)
  assert.equal(cache.take(R, { fromWatcher: true }), null, 'a walk is reusable once')

  // A mutation after the walk finished also invalidates it.
  cache.finish(cache.begin(), R, fresh)
  cache.markReusable(R)
  cache.bump()
  assert.equal(cache.take(R, { fromWatcher: true }), null)

  // Too old.
  cache.finish(cache.begin(), R, fresh)
  cache.markReusable(R)
  clock += 6000
  assert.equal(cache.take(R, { fromWatcher: true }), null)

  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8')
  assert.doesNotMatch(main, /watcherTreeScan/, 'main.cjs must not keep an unguarded walk cache')
  assert.match(main, /treeScanCache\.take\(root, \{ fromWatcher: options\?\.fromWatcher === true \}\)/)
  const readOnlySource = main.match(/const READ_ONLY_IPC = (\/.*\/)\r?\n/)?.[1]
  assert.ok(readOnlySource, 'READ_ONLY_IPC must exist')
  const readOnly = new RegExp(readOnlySource.slice(1, -1))
  // Every IPC channel that creates, renames, moves, deletes or imports must count as a mutation.
  const channels = [...main.matchAll(/^\s+\w+: '(fanotes:[a-z-]+)',?\r?$/gm)].map((match) => match[1])
  for (const channel of channels) {
    if (/^fanotes:(create|rename|move|trash|import|delete|save|write|convert|set-|select-vault|reset|story-create|story-write)/.test(channel)) {
      assert.equal(readOnly.test(channel), false, `${channel} must invalidate the tree walk`)
    }
  }
  for (const channel of ['fanotes:get-tree', 'fanotes:read-file', 'fanotes:search']) assert.equal(readOnly.test(channel), true, channel)
}

// ---- 3. Tag filter -------------------------------------------------------------
{
  const server = await createServer({ root, appType: 'custom', logLevel: 'error', server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] } })
  try {
    const { filterTreeByTag } = await server.ssrLoadModule('/src/lib/noteTags.ts')
    const tree = [
      { name: 'A', relativePath: 'A', kind: 'folder', children: [{ name: 'n.md', relativePath: 'A/n.md', kind: 'file' }] },
      { name: 'Neu', relativePath: 'Neu', kind: 'folder', children: [] },
    ]
    const index = new Map([['A/n.md', ['mathe']]])
    assert.deepEqual(filterTreeByTag(tree, 'mathe', index).map((e) => e.name), ['A'], 'documents why an empty folder vanishes under a tag filter')
    assert.equal(filterTreeByTag(tree, null, index).length, 2)
  } finally {
    await server.close()
  }
}

// ---- 4. Linked folder locations ------------------------------------------------
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-newfolder-'))
  try {
    const vault = fs.realpathSync(fs.mkdtempSync(path.join(base, 'vault-')))
    const loc1 = fs.realpathSync(fs.mkdirSync(path.join(base, 'loc1'), { recursive: true }) ?? path.join(base, 'loc1'))
    const loc2 = path.join(base, 'loc2')
    fs.mkdirSync(path.join(loc1, 'Sub'), { recursive: true })
    fs.mkdirSync(path.join(loc2, 'Sub'), { recursive: true })
    fs.mkdirSync(path.join(loc2, 'OnlyTwo'), { recursive: true })
    const map = { Fach: [loc1, loc2] }

    // createFolder resolves the parent with asContent; the nested folder lands where the parent exists.
    const sub = await folderLocations.resolveLocated({ vault, logical: 'Fach/OnlyTwo', map, expected: 'directory', asContent: true })
    assert.equal(sub.target, path.join(loc2, 'OnlyTwo'))
    fs.mkdirSync(path.join(sub.target, 'Neu'))

    // Simulate the scan of the logical folder "Fach": the same name in two locations is one folder.
    const readLocation = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({
      name: d.name, relativePath: `Fach/${d.name}`, kind: 'folder',
      children: fs.readdirSync(path.join(dir, d.name), { withFileTypes: true }).filter((c) => c.isDirectory()).map((c) => ({ name: c.name, relativePath: `Fach/${d.name}/${c.name}`, kind: 'folder', children: [] })),
    }))
    fs.mkdirSync(path.join(loc2, 'Sub', 'InTwo'))
    const merged = mergeTreeEntries(readLocation(loc1), readLocation(loc2))
    assert.deepEqual(names(merged).sort(), ['OnlyTwo', 'Sub'])
    assert.deepEqual(names(merged.find((e) => e.name === 'Sub').children), ['InTwo'], 'children of a folder that exists in two locations must be merged')
    assert.deepEqual(names(merged.find((e) => e.name === 'OnlyTwo').children), ['Neu'])

    const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8')
    assert.equal((main.match(/mergeTreeEntries\(first\.children/g) || []).length, 2, 'full and fast tree scans must both merge repeated folders')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

// ---- 5. Watcher: a new empty nested folder is noticed even without fs.watch events ----
{
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-watch-folder-')))
  try {
    fs.mkdirSync(path.join(base, 'A', 'B'), { recursive: true })
    const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
      const rp = rel ? `${rel}/${d.name}` : d.name
      return { name: d.name, relativePath: rp, kind: 'folder', children: walk(path.join(dir, d.name), rp) }
    })
    const gate = { block: null }
    const seen = []
    const watcher = createVaultWatcher({
      getRoots: () => [base],
      scan: async () => {
        const wait = gate.block
        const result = walk(base) // taken first: this is the "scan that started before mkdir" case
        if (wait) await wait.promise
        return result
      },
      onChange: (diff) => seen.push(diff),
      watch: () => ({ close() {}, on() {} }),
      debounceMs: 1,
    })
    await watcher.rescan() // baseline
    // A walk is in flight, the folder is created, the walk finishes without it.
    gate.block = deferred()
    const running = watcher.rescan()
    fs.mkdirSync(path.join(base, 'A', 'B', 'Neu'))
    gate.block.resolve()
    gate.block = null
    await running
    assert.equal(seen.length, 0, 'the stale walk does not know the folder')
    // The nudge after an own mutation (and the trailing rescan) heals it.
    await watcher.rescan()
    assert.deepEqual(seen.at(-1)?.added, ['A/B/Neu'])
    assert.equal(flattenTree(walk(base)).get('A/B/Neu'), 'd')
    watcher.stop()
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

console.log('check-new-folder-visible: ok')
