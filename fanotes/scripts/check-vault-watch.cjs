// Unit checks for the external-change detection of the vault (electron/vault-watch.cjs).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { isIgnoredWatchPath, flattenTree, diffSignatures, createVaultWatcher } = require('../electron/vault-watch.cjs')

// Ignore rules
for (const ignored of ['.fanotes/state.json', 'Physik/.hidden.md', 'Physik/.note.md.123.abc.tmp', 'a/b.tmp', 'x.md~', 'a/b.sync-conflict-2026.md', 'dl.crdownload', '', null]) {
  assert.equal(isIgnoredWatchPath(ignored), true, String(ignored))
}
for (const shown of ['Physik/Optik.md', 'Bilder/foto.png', 'a b/c.famd']) assert.equal(isIgnoredWatchPath(shown), false, shown)

// Diff
const tree = (files) => files.map(([p, m, s]) => ({ name: p, relativePath: p, kind: 'file', modifiedAt: m, size: s }))
const a = flattenTree([{ name: 'Physik', relativePath: 'Physik', kind: 'folder', children: tree([['Physik/a.md', 'm1', 1], ['Physik/b.md', 'm1', 2]]) }])
const b = flattenTree([{ name: 'Physik', relativePath: 'Physik', kind: 'folder', children: tree([['Physik/a.md', 'm2', 1], ['Physik/c.md', 'm1', 3]]) }])
const diff = diffSignatures(a, b)
assert.deepEqual(diff, { added: ['Physik/c.md'], removed: ['Physik/b.md'], changed: ['Physik/a.md'] })
assert.deepEqual(diffSignatures(a, a), { added: [], removed: [], changed: [] })
// A rename shows as remove + add.
const renamed = diffSignatures(flattenTree(tree([['x.md', 'm', 1]])), flattenTree(tree([['y.md', 'm', 1]])))
assert.deepEqual([renamed.added, renamed.removed], [['y.md'], ['x.md']])

// Interval policy: fast while fs.watch fails, slow when healthy, paused while hidden.
async function intervalPolicy() {
  const makeFake = () => {
    const f = { intervals: [], cleared: 0 }
    f.setIntervalFn = (fn, ms) => { const h = { fn, ms, unref() {} }; f.intervals.push(h); return h }
    f.clearIntervalFn = () => { f.cleared += 1 }
    return f
  }
  const base = { getRoots: () => ['/x'], scan: async () => [], onChange() {}, debounceMs: 1, intervalMs: 20000, healthyIntervalMs: 120000 }
  const fakeWatcher = () => ({ close() {}, on() {} })
  const broken = makeFake()
  const w1 = createVaultWatcher({ ...base, ...broken, watch: () => { throw new Error('ENOSPC') } })
  w1.start(); await w1.rescan()
  assert.equal(w1.currentIntervalMs(), 20000, 'failing fs.watch keeps 20 s')
  w1.stop()
  const ok = makeFake()
  const w2 = createVaultWatcher({ ...base, ...ok, watch: fakeWatcher })
  w2.start(); await w2.rescan()
  assert.equal(w2.currentIntervalMs(), 120000, 'healthy watchers back off to 120 s')
  w2.setActive(false)
  assert.equal(w2.currentIntervalMs(), 0, 'paused while hidden')
  w2.setActive(true)
  assert.equal(w2.currentIntervalMs(), 120000, 'resumes')
  w2.stop()
  const noWatch = makeFake()
  const w3 = createVaultWatcher({ ...base, ...noWatch })
  w3.start(); await w3.rescan()
  assert.equal(w3.currentIntervalMs(), 20000, 'no fs.watch: 20 s')
  w3.stop()
  console.log('vault watch interval checks passed')
}

// Watcher against a real temp directory (rescan path, no fs.watch dependency).
async function main() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-watch-'))
  try {
    const scan = async () => {
      const out = []
      for (const name of fs.readdirSync(dir)) {
        if (isIgnoredWatchPath(name)) continue
        const stat = fs.statSync(path.join(dir, name))
        out.push({ name, relativePath: name, kind: 'file', modifiedAt: String(stat.mtimeMs), size: stat.size })
      }
      return out
    }
    const events = []
    const watcher = createVaultWatcher({ getRoots: () => [dir], scan, onChange: (d) => events.push(d), debounceMs: 5, intervalMs: 3600000 })
    fs.writeFileSync(path.join(dir, 'one.md'), 'x')
    watcher.start()
    await watcher.rescan() // baseline is silent
    assert.equal(events.length, 0)
    fs.writeFileSync(path.join(dir, 'two.md'), 'hello')
    fs.writeFileSync(path.join(dir, '.two.md.1.tmp'), 'temp')
    await watcher.rescan()
    assert.deepEqual(events.at(-1), { added: ['two.md'], removed: [], changed: [] })
    await watcher.rescan()
    assert.equal(events.length, 1, 'unchanged rescan stays silent')
    fs.unlinkSync(path.join(dir, 'one.md'))
    await watcher.rescan()
    assert.deepEqual(events.at(-1).removed, ['one.md'])
    watcher.stop()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  console.log('vault watch checks passed')
}

// Real recursive fs.watch (the periodic rescan is disabled, so only the OS watcher can report).
async function realWatch() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-watch-real-'))
  const nested = path.join(dir, 'Physik', 'Optik')
  fs.mkdirSync(nested, { recursive: true })
  const scan = async () => {
    const out = []
    const walk = (rel) => {
      for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const next = rel ? `${rel}/${entry.name}` : entry.name
        if (isIgnoredWatchPath(next)) continue
        if (entry.isDirectory()) walk(next)
        else { const stat = fs.statSync(path.join(dir, next)); out.push({ name: entry.name, relativePath: next, kind: 'file', modifiedAt: String(stat.mtimeMs), size: stat.size }) }
      }
    }
    walk('')
    return out
  }
  const events = []
  const watcher = createVaultWatcher({ getRoots: () => [dir], scan, onChange: (d) => events.push(d), watch: fs.watch, debounceMs: 20, intervalMs: 3600000 })
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 200; i += 1) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`fs.watch never reported: ${label}`)
  }
  try {
    watcher.start()
    await watcher.rescan() // baseline (also installs the watcher)
    fs.writeFileSync(path.join(nested, 'neu.md'), 'x')
    await waitFor(() => events.some((e) => e.added.includes('Physik/Optik/neu.md')), 'nested add')
    fs.writeFileSync(path.join(nested, 'neu.md'), 'longer content')
    await waitFor(() => events.some((e) => e.changed.includes('Physik/Optik/neu.md')), 'nested change')
    fs.unlinkSync(path.join(nested, 'neu.md'))
    await waitFor(() => events.some((e) => e.removed.includes('Physik/Optik/neu.md')), 'nested remove')
  } finally {
    watcher.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  console.log('real recursive fs.watch checks passed')
}
async function newArrivalStore() {
  const { loadArrivals, saveArrivals, externalArrivals, ARRIVAL_CAP, ARRIVAL_TTL_MS, SYNC_GRACE_MS } = await import('../src/lib/newArrivals.mjs')
  const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v) }, removeItem: (k) => { m.delete(k) } } }
  const now = 1_800_000_000_000
  const storage = mem()
  saveArrivals(storage, '/v1', new Map([['a.md', now - 1000], ['old.md', now - ARRIVAL_TTL_MS - 1]]))
  assert.deepEqual([...loadArrivals(storage, '/v1', now).keys()], ['a.md'], 'persisted across restart, expired dropped')
  assert.equal(loadArrivals(storage, '/v2', now).size, 0, 'per vault')
  const many = new Map(Array.from({ length: ARRIVAL_CAP + 50 }, (_, i) => [`f${i}.md`, now - i]))
  saveArrivals(storage, '/v1', many)
  assert.equal(loadArrivals(storage, '/v1', now).size, ARRIVAL_CAP, 'capped')
  saveArrivals(storage, '/v1', new Map())
  assert.equal(loadArrivals(storage, '/v1', now).size, 0, 'cleared')
  storage.setItem('fanotes.newArrivals.v1:/v3', '{broken')
  assert.equal(loadArrivals(storage, '/v3', now).size, 0, 'corrupt store tolerated')
  assert.equal(loadArrivals(null, '/v1', now).size, 0)
  // Only files from outside count: not during/after sync, not sync-written, not our own.
  const base = { files: ['a.md', 'b.md'], now, syncBusy: false, syncEndedAt: 0, syncWritten: new Map(), ownRecently: false }
  assert.deepEqual(externalArrivals(base), ['a.md', 'b.md'])
  assert.deepEqual(externalArrivals({ ...base, syncBusy: true }), [], 'mid-pull rescan')
  assert.deepEqual(externalArrivals({ ...base, syncEndedAt: now - SYNC_GRACE_MS + 1 }), [], 'just after sync')
  assert.deepEqual(externalArrivals({ ...base, syncEndedAt: now - SYNC_GRACE_MS - 1 }), ['a.md', 'b.md'])
  assert.deepEqual(externalArrivals({ ...base, syncWritten: new Map([['a.md', now - 60_000]]) }), ['b.md'], 'sync-written path')
  assert.deepEqual(externalArrivals({ ...base, ownRecently: true }), [])
  console.log('new-arrival store checks passed')
}
main().then(newArrivalStore).then(intervalPolicy).then(realWatch).catch((error) => { console.error(error); process.exit(1) })
