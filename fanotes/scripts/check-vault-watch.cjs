// Unit checks for the external-change detection of the vault (electron/vault-watch.cjs)
// and for what the app does with open notes when their files change (src/lib/externalTabs.mjs).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
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
    // The renderer was handed a tree without a file that has not yet been seen leaving (own trash): when the file
    // comes back before the next walk, it is reported as added instead of vanishing as "unchanged".
    fs.writeFileSync(path.join(dir, 'back.md'), 'restore me')
    await watcher.rescan()
    const before = events.length
    watcher.adopt(await scan().then((entries) => entries.filter((entry) => entry.name !== 'back.md')))
    await watcher.rescan()
    assert.deepEqual(events.slice(before).at(-1), { added: ['back.md'], removed: [], changed: [] }, 'a file the renderer does not show is reported even though the last walk saw it')
    watcher.stop()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  console.log('vault watch checks passed')
}

// Open notes whose files change outside FaNotes: the pure decisions, then a run against real files and the real watcher diffs.
async function reconcileChecks() {
  const tabs = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'lib', 'externalTabs.mjs')).href)
  const {
    OWN_WRITE_MEMORY, sameNoteText, rememberOwnWrite, isOwnWrite, normalizeVaultChange, tabVaultPaths, implicatedTabPaths,
    decideTabReconcile, renameCandidates, companionToFollow, conflictCopyBase, conflictDeviceName,
  } = tabs

  // Texts are compared without line endings and trailing whitespace, nothing else.
  assert.equal(sameNoteText('a\r\nb\n\n', 'a\nb'), true)
  assert.equal(sameNoteText('a b', 'a  b'), false)
  assert.equal(sameNoteText(undefined, ''), true)

  // Own writes: newest first, bounded, matched by content.
  let own = []
  for (const body of ['1', '2', '3', '4', '5', '3']) own = rememberOwnWrite(own, body)
  assert.equal(own.length, OWN_WRITE_MEMORY)
  assert.equal(isOwnWrite(own, '3\n'), true)
  assert.equal(isOwnWrite(own, '2'), true)
  assert.equal(isOwnWrite(own, '1'), false, 'aged out')
  assert.equal(isOwnWrite(own, '33'), false)

  // The IPC payload is not trusted; a full list may be incomplete.
  assert.deepEqual(normalizeVaultChange({ added: ['a.md', 5, ''], removed: 'x', changed: ['b.md'] }), { added: ['a.md'], removed: [], changed: ['b.md'], unreliable: false })
  assert.equal(normalizeVaultChange({ added: Array.from({ length: 500 }, (_, i) => `n${i}.md`), removed: [], changed: [] }).unreliable, true)
  assert.equal(normalizeVaultChange({ added: [], removed: [], changed: [], truncated: true }).unreliable, true)
  assert.equal(normalizeVaultChange(null).unreliable, true)
  assert.deepEqual(normalizeVaultChange(undefined).added, [])

  // Which open notes a change is about: the note and its .famd companion.
  assert.deepEqual(tabVaultPaths('Physik/a.md'), ['Physik/a.md', 'Physik/a.famd'])
  assert.deepEqual(tabVaultPaths('Physik/a.famd'), ['Physik/a.famd'])
  assert.deepEqual(tabVaultPaths('x.pdf'), ['x.pdf', 'x.famd'])
  const open = ['a.md', 'b.md', 'Doc/c.famd', 'p.pdf']
  const change = (parts) => normalizeVaultChange({ added: [], removed: [], changed: [], ...parts })
  assert.deepEqual(implicatedTabPaths(open, change({ changed: ['b.md'] })), ['b.md'])
  assert.deepEqual(implicatedTabPaths(open, change({ removed: ['p.famd'] })), ['p.pdf'])
  assert.deepEqual(implicatedTabPaths(open, change({ added: ['other.md'] })), [])
  assert.deepEqual(implicatedTabPaths(open, change({ truncated: true })), open)
  assert.deepEqual(implicatedTabPaths(open, null), open)

  // Decisions. Neither the typed text nor the file is ever overwritten by one of them.
  const there = (content) => ({ exists: true, content })
  const decide = (facts) => decideTabReconcile({ content: 'one', savedContent: 'one', ownWrites: [], ...facts })
  assert.deepEqual(decide({ disk: there('one\n') }), { action: 'none' }, 'unchanged')
  assert.deepEqual(decide({ disk: null }), { action: 'none' }, 'unreadable: leave alone')
  assert.deepEqual(decide({ disk: there('two') }), { action: 'reload', content: 'two' }, 'clean tab, outside edit: reload')
  assert.deepEqual(decide({ content: 'one!', disk: there('two') }), { action: 'conflict', external: 'two' }, 'dirty tab, outside edit: conflict')
  assert.deepEqual(decide({ content: 'one!', disk: there('one') }), { action: 'none' }, 'dirty tab, file untouched')
  assert.deepEqual(decide({ content: 'one!', ownWrites: rememberOwnWrite([], 'one!'), disk: there('one!') }), { action: 'none' }, 'own autosave seen before the tab was updated')
  assert.deepEqual(decide({ content: 'one!!', ownWrites: rememberOwnWrite([], 'one!'), disk: there('one!') }), { action: 'none' }, 'own autosave while typing on')
  assert.deepEqual(decide({ content: 'same', disk: there('same\n') }), { action: 'adopt' }, 'the typed text already is the file')
  assert.deepEqual(decide({ disk: { exists: false } }), { action: 'deleted' }, 'deleted outside, clean or not')
  assert.deepEqual(decide({ content: 'one!', disk: { exists: false } }), { action: 'deleted' })
  assert.deepEqual(decide({ hold: 'deleted', disk: { exists: false } }), { action: 'none' }, 'already on hold')
  assert.deepEqual(decide({ hold: 'conflict', content: 'one!', disk: { exists: false } }), { action: 'deleted' }, 'a conflicting file that then vanished')
  assert.deepEqual(decide({ hold: 'deleted', disk: there('one') }), { action: 'release' }, 'the file came back unchanged')
  assert.deepEqual(decide({ hold: 'deleted', disk: there('two') }), { action: 'reload', content: 'two' }, 'the file came back changed, nothing typed')
  assert.deepEqual(decide({ hold: 'deleted', content: 'one!', disk: there('two') }), { action: 'conflict', external: 'two' }, 'the file came back changed, text typed meanwhile')
  assert.deepEqual(decide({ hold: 'conflict', content: 'one!', heldExternal: 'two', disk: there('two') }), { action: 'none' }, 'conflict already announced')
  assert.deepEqual(decide({ hold: 'conflict', content: 'one!', heldExternal: 'two', disk: there('three') }), { action: 'conflict', external: 'three' }, 'edited again outside')
  assert.deepEqual(decide({ hold: 'conflict', content: 'one!', heldExternal: 'two', disk: there('one') }), { action: 'release' }, 'outside edit reverted')
  assert.deepEqual(decide({ content: 'a\nb', savedContent: 'a\nb', disk: there('a\r\nb\r\n') }), { action: 'none' }, 'line endings only')

  // Where a vanished note may have gone.
  const sig = (modifiedAt, size) => ({ modifiedAt, size })
  const after = new Map([['m.md', sig('t1', 5)], ['n.famd', sig('t9', 70)], ['z.md', sig('t2', 5)]])
  assert.deepEqual(renameCandidates({ from: 'n.md', added: ['m.md', 'n.famd', 'z.md'], before: sig('t1', 5), after }), ['m.md'], 'same signature')
  assert.deepEqual(renameCandidates({ from: 'n.md', added: ['m.md', 'n.famd', 'z.md'], before: sig('t8', 5), after }), ['m.md', 'z.md'], 'no signature match: a few of the same kind, the text decides')
  assert.deepEqual(renameCandidates({ from: 'n.md', added: ['m.md'], before: sig('t1', 5), after, taken: ['m.md'] }), [], 'already open as another tab')
  assert.deepEqual(renameCandidates({ from: 'n.md', added: Array.from({ length: 7 }, (_, i) => `f${i}.md`), before: null }), [], 'too many to read blindly')
  assert.deepEqual(renameCandidates({ from: 'n.md', added: ['n.famd'] }), [], 'the orphaned companion is not the note')
  assert.deepEqual(renameCandidates({ from: 'n.md', added: ['n.markdown'], before: sig('t1', 5), after: new Map([['n.markdown', sig('t1', 5)]]) }), ['n.markdown'], 'extension change')
  assert.deepEqual(renameCandidates({ from: 'x.pdf', added: ['y.pdf'], before: sig('t', 9), after: new Map([['y.pdf', sig('t', 9)]]) }), ['y.pdf'])
  assert.deepEqual(renameCandidates({ from: 'x.pdf', added: ['y.pdf'], before: sig('t', 9), after: new Map([['y.pdf', sig('t2', 9)]]) }), [], 'a PDF has no text to compare: signature or nothing')
  assert.deepEqual(companionToFollow({ from: 'a/n.md', to: 'a/m.md' }), { from: 'a/n.famd', to: 'a/m.famd' })
  assert.deepEqual(companionToFollow({ from: 'a/n.md', to: 'b/n.md' }), { from: 'a/n.famd', to: 'b/n.famd' })
  assert.equal(companionToFollow({ from: 'a/n.md', to: 'a/n.markdown' }), null, 'same stem: nothing to move')
  assert.equal(companionToFollow({ from: 'a.famd', to: 'b.famd' }), null, 'a handwriting note is its own companion')

  // Conflict copies keep the sync convention; only Markdown keeps its extension.
  assert.equal(conflictCopyBase('Physik/a.md'), 'Physik/a.md')
  assert.equal(conflictCopyBase('Physik/a.famd'), 'Physik/a.md')
  assert.equal(conflictCopyBase('x.pdf'), 'x.md')
  assert.equal(conflictDeviceName(' Laptop ', 'linux'), 'Laptop')
  assert.equal(conflictDeviceName('', 'win32'), 'Windows-Gerät')
  assert.equal(conflictDeviceName(undefined, 'something'), 'Gerät')

  // The decisions against real files and the diffs the real watcher produces.
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-tabs-'))
  try {
    let clock = 1_700_000_000_000
    const put = (name, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
      fs.writeFileSync(path.join(dir, name), text)
      clock += 5000
      fs.utimesSync(path.join(dir, name), clock / 1000, clock / 1000)
    }
    const stat = (name) => { const info = fs.statSync(path.join(dir, name)); return { modifiedAt: String(info.mtimeMs), size: info.size } }
    const NOTE = /\.(md|markdown|pdf)$/iu
    // Like the app's tree: a `.famd` next to a note of the same name is that note's companion and stays out of the list.
    const scan = async () => {
      const names = fs.readdirSync(dir).filter((name) => !isIgnoredWatchPath(name))
      const stems = new Set(names.filter((name) => NOTE.test(name)).map((name) => name.replace(NOTE, '')))
      return names
        .filter((name) => !(name.endsWith('.famd') && stems.has(name.slice(0, -5))))
        .map((name) => ({ name, relativePath: name, kind: 'file', ...stat(name) }))
    }
    const events = []
    const watcher = createVaultWatcher({ getRoots: () => [dir], scan, onChange: (d) => events.push(d), debounceMs: 5, intervalMs: 3600000 })
    put('a.md', 'one')
    put('a.famd', 'one\n<!-- ink payload -->')
    await watcher.rescan()

    const tab = { path: 'a.md', content: 'one', savedContent: 'one', ownWrites: [], hold: null, heldExternal: null }
    const diskOf = (name) => (fs.existsSync(path.join(dir, name)) ? { exists: true, content: fs.readFileSync(path.join(dir, name), 'utf8') } : { exists: false })
    const step = async (model = tab) => {
      const seen = events.length
      await watcher.rescan()
      const raw = events.length > seen ? events.at(-1) : null
      if (!raw) return { action: 'none', change: null }
      const change = normalizeVaultChange(raw)
      if (!implicatedTabPaths([model.path], change).length) return { action: 'none', change }
      const decision = decideTabReconcile({ content: model.content, savedContent: model.savedContent, ownWrites: model.ownWrites, disk: diskOf(model.path), hold: model.hold, heldExternal: model.heldExternal })
      return { ...decision, change }
    }

    // The app's own autosave comes back as an event and is no outside edit, even before the tab is updated.
    tab.content = 'one, then typing'
    tab.ownWrites = rememberOwnWrite(tab.ownWrites, tab.content)
    put('a.md', tab.content)
    assert.equal((await step()).action, 'none', 'own autosave')
    tab.savedContent = tab.content

    // An outside edit of an idle note (the active note too): the tab reloads.
    put('a.md', 'edited outside')
    let result = await step()
    assert.deepEqual([result.action, result.content], ['reload', 'edited outside'])
    tab.content = tab.savedContent = result.content

    // The same while the user has unsaved text: both sides survive, saving pauses.
    tab.content = 'edited outside, plus my words'
    put('a.md', 'edited outside, and again')
    result = await step()
    assert.deepEqual([result.action, result.external], ['conflict', 'edited outside, and again'])
    tab.hold = 'conflict'
    tab.heldExternal = result.external
    assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'edited outside, and again', 'the file still holds the outside version')
    assert.equal(tab.content, 'edited outside, plus my words', 'the typed text is still in the tab')
    assert.equal((await step()).action, 'none', 'nothing new')
    put('a.md', 'a third version')
    result = await step()
    assert.deepEqual([result.action, result.external], ['conflict', 'a third version'])

    // Deleted outside: the text stays, nothing is written back, and the orphaned companion is no rename target.
    fs.unlinkSync(path.join(dir, 'a.md'))
    result = await step()
    assert.equal(result.action, 'deleted')
    assert.deepEqual(result.change.removed, ['a.md'])
    assert.deepEqual(result.change.added, ['a.famd'], 'the companion shows up as a note of its own')
    assert.deepEqual(renameCandidates({ from: 'a.md', added: result.change.added }), [])
    tab.hold = 'deleted'
    tab.heldExternal = null
    assert.equal(decideTabReconcile({ ...tab, disk: diskOf('a.md') }).action, 'none')
    // It comes back (restored from the trash) with the text the tab was based on: the pause lifts.
    put('a.md', tab.savedContent)
    result = await step()
    assert.equal(result.action, 'release')
    tab.hold = null

    // Renamed outside (only the note, as Explorer does): same signature, same text, and the companion is left behind.
    put('n.md', 'rename me')
    put('n.famd', 'rename me\n<!-- ink payload -->')
    await watcher.rescan()
    const second = { path: 'n.md', content: 'rename me, typed', savedContent: 'rename me', ownWrites: [], hold: null, heldExternal: null }
    const beforeSignature = stat('n.md')
    fs.renameSync(path.join(dir, 'n.md'), path.join(dir, 'm.md'))
    result = await step(second)
    assert.equal(result.action, 'deleted')
    assert.deepEqual([...result.change.added].sort(), ['m.md', 'n.famd'])
    const afterSignatures = new Map((await scan()).map((entry) => [entry.relativePath, { modifiedAt: entry.modifiedAt, size: entry.size }]))
    const candidates = renameCandidates({ from: 'n.md', added: result.change.added, before: beforeSignature, after: afterSignatures })
    assert.deepEqual(candidates, ['m.md'])
    assert.equal(sameNoteText(diskOf('m.md').content, second.savedContent), true, 'the text decides before a tab follows')
    assert.deepEqual(companionToFollow({ from: 'n.md', to: 'm.md' }), { from: 'n.famd', to: 'm.famd' })
    assert.equal(diskOf('n.famd').exists, true, 'the companion is still there, as a note of its own')

    // Two identical copies are no safe rename: the caller sees two candidates and keeps the tab on hold.
    put('twin1.md', 'same text')
    await watcher.rescan()
    const twin = { path: 'twin1.md', content: 'same text', savedContent: 'same text', ownWrites: [], hold: null, heldExternal: null }
    const twinBefore = stat('twin1.md')
    fs.copyFileSync(path.join(dir, 'twin1.md'), path.join(dir, 'twin2.md'))
    fs.copyFileSync(path.join(dir, 'twin1.md'), path.join(dir, 'twin3.md'))
    fs.utimesSync(path.join(dir, 'twin2.md'), fs.statSync(path.join(dir, 'twin1.md')).atime, fs.statSync(path.join(dir, 'twin1.md')).mtime)
    fs.utimesSync(path.join(dir, 'twin3.md'), fs.statSync(path.join(dir, 'twin1.md')).atime, fs.statSync(path.join(dir, 'twin1.md')).mtime)
    fs.unlinkSync(path.join(dir, 'twin1.md'))
    result = await step(twin)
    assert.equal(result.action, 'deleted')
    const twinAfter = new Map((await scan()).map((entry) => [entry.relativePath, { modifiedAt: entry.modifiedAt, size: entry.size }]))
    assert.equal(renameCandidates({ from: 'twin1.md', added: result.change.added, before: twinBefore, after: twinAfter }).length, 2)

    // A PDF note: removal and rename are detected by signature; the file itself is never read.
    put('x.pdf', '%PDF-1.4 not really')
    await watcher.rescan()
    const pdfBefore = stat('x.pdf')
    fs.renameSync(path.join(dir, 'x.pdf'), path.join(dir, 'y.pdf'))
    await watcher.rescan()
    const pdfChange = normalizeVaultChange(events.at(-1))
    assert.deepEqual(implicatedTabPaths(['x.pdf'], pdfChange), ['x.pdf'])
    const pdfAfter = new Map((await scan()).map((entry) => [entry.relativePath, { modifiedAt: entry.modifiedAt, size: entry.size }]))
    assert.deepEqual(renameCandidates({ from: 'x.pdf', added: pdfChange.added, before: pdfBefore, after: pdfAfter }), ['y.pdf'])
    watcher.stop()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  console.log('open note reconciliation checks passed')
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
main().then(newArrivalStore).then(reconcileChecks).then(intervalPolicy).then(realWatch).catch((error) => { console.error(error); process.exit(1) })
