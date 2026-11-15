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
main().catch((error) => { console.error(error); process.exit(1) })
