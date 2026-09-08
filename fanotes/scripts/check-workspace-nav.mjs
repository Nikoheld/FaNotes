import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

// Workspace navigation: visited-note history with back/forward, the split
// layout, tab ordering/pinning, the remembered workspace per vault and the
// quick-switcher ranking. Plus the read-only ink preview of the second pane:
// it paints the saved page at the saved size and text origin, so ink and text
// sit exactly where the live board shows them.

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const nav = await server.ssrLoadModule('/src/lib/workspaceNav.ts')
  const preview = await server.ssrLoadModule('/src/components/InkPreviewLayer.tsx')

  // ── History ──────────────────────────────────────────────────────────────
  let history = nav.EMPTY_NOTE_HISTORY
  assert.equal(nav.canGoBack(history), false)
  assert.equal(nav.canGoForward(history), false)
  history = nav.visitNote(history, 'A.md')
  history = nav.visitNote(history, 'B.md')
  history = nav.visitNote(history, 'B.md') // a repeat records nothing
  history = nav.visitNote(history, 'C.md')
  assert.deepEqual(history, { entries: ['A.md', 'B.md', 'C.md'], index: 2 })
  assert.equal(nav.canGoBack(history), true)
  assert.equal(nav.canGoForward(history), false)

  let step = nav.stepNoteHistory(history, -1)
  assert.equal(step.path, 'B.md')
  assert.equal(step.history.index, 1)
  assert.equal(nav.canGoForward(step.history), true)
  // Closed notes are skipped, not lost.
  step = nav.stepNoteHistory(history, -1, (path) => path !== 'B.md')
  assert.equal(step.path, 'A.md')
  assert.equal(step.history.index, 0)
  step = nav.stepNoteHistory(step.history, 1, (path) => path !== 'B.md')
  assert.equal(step.path, 'C.md')
  // Visiting from the middle drops the forward entries.
  const branched = nav.visitNote({ entries: ['A.md', 'B.md', 'C.md'], index: 0 }, 'D.md')
  assert.deepEqual(branched, { entries: ['A.md', 'D.md'], index: 1 })
  // The list is bounded.
  let long = nav.EMPTY_NOTE_HISTORY
  for (let i = 0; i < nav.NOTE_HISTORY_LIMIT + 25; i += 1) long = nav.visitNote(long, `n${i}.md`)
  assert.equal(long.entries.length, nav.NOTE_HISTORY_LIMIT)
  assert.equal(long.index, nav.NOTE_HISTORY_LIMIT - 1)
  assert.equal(long.entries[long.index], `n${nav.NOTE_HISTORY_LIMIT + 24}.md`)

  // Rename/move follows, including notes inside a moved folder; repeats collapse.
  const moved = nav.remapNoteHistory({ entries: ['Math/a.md', 'Bio/b.md', 'Math/c.md'], index: 2 }, 'Math', 'Maths')
  assert.deepEqual(moved.entries, ['Maths/a.md', 'Bio/b.md', 'Maths/c.md'])
  const renamedOnto = nav.remapNoteHistory({ entries: ['a.md', 'b.md', 'a.md'], index: 2 }, 'b.md', 'a.md')
  assert.deepEqual(renamedOnto, { entries: ['a.md'], index: 0 })
  // Trash forgets every visit and keeps the cursor on the note still shown.
  const forgotten = nav.forgetNoteHistory({ entries: ['a.md', 'T/x.md', 'b.md', 'T/y.md'], index: 2 }, 'T')
  assert.deepEqual(forgotten, { entries: ['a.md', 'b.md'], index: 1 })
  const forgotCurrent = nav.forgetNoteHistory({ entries: ['a.md', 'b.md'], index: 1 }, 'b.md')
  assert.deepEqual(forgotCurrent, { entries: ['a.md'], index: 0 })

  // ── Paths & breadcrumbs ──────────────────────────────────────────────────
  assert.equal(nav.remapPath('Math/Notes/x.md', 'Math', 'Science'), 'Science/Notes/x.md')
  assert.equal(nav.remapPath('Mathematics/x.md', 'Math', 'Science'), null)
  assert.deepEqual(nav.breadcrumbsFor('Math/Algebra/Sets.md'), [
    { label: 'Math', path: 'Math', isNote: false },
    { label: 'Algebra', path: 'Math/Algebra', isNote: false },
    { label: 'Sets', path: 'Math/Algebra/Sets.md', isNote: true },
  ])
  assert.deepEqual(nav.breadcrumbsFor('Welcome.md'), [{ label: 'Welcome', path: 'Welcome.md', isNote: true }])

  // ── Split layout ─────────────────────────────────────────────────────────
  assert.equal(nav.clampSplitRatio(0.05), nav.SPLIT_MIN_RATIO)
  assert.equal(nav.clampSplitRatio(0.95), nav.SPLIT_MAX_RATIO)
  assert.equal(nav.clampSplitRatio(Number.NaN), nav.DEFAULT_SPLIT_LAYOUT.ratio)
  const box = { left: 100, top: 50, width: 1000, height: 600 }
  assert.equal(nav.splitRatioFromPointer(box, { x: 400, y: 0 }, 'columns'), 0.3)
  assert.equal(nav.splitRatioFromPointer(box, { x: 0, y: 350 }, 'rows'), 0.5)
  assert.equal(nav.splitRatioFromPointer(box, { x: 5000, y: 0 }, 'columns'), nav.SPLIT_MAX_RATIO)
  assert.equal(nav.nudgeSplitRatio(0.5, 1), 0.55)
  assert.equal(nav.nudgeSplitRatio(0.22, -1), nav.SPLIT_MIN_RATIO)
  // Pane tracks land on whole device pixels: a half-pixel pane offset composited its text soft.
  assert.equal(nav.splitFirstPaneSize(1064, 7, 0.5, 1), 529, '(1064 - 7) / 2 = 528.5 snaps to a whole pixel')
  assert.equal(nav.splitFirstPaneSize(1064, 7, 0.5, 1.25) * 1.25, 661, 'at 125 % the track is a whole number of device pixels')
  assert.equal(nav.splitFirstPaneSize(1064, 7, 0.5, 2), 528.5, 'at 200 % a half CSS pixel is a whole device pixel')
  assert.equal(nav.splitFirstPaneSize(1064, 7, 5, 1), Math.round(1057 * nav.SPLIT_MAX_RATIO), 'ratio is clamped')
  assert.equal(nav.splitFirstPaneSize(Number.NaN, 7, 0.5, 0), 0)
  assert.equal(nav.snapToDevicePixels(7, 1.25) * 1.25, 9)
  assert.equal(nav.snapToDevicePixels(7, 1), 7)
  assert.deepEqual(nav.normalizeSplitLayout({ ratio: 0.6, orientation: 'rows' }), { ratio: 0.6, orientation: 'rows' })
  assert.deepEqual(nav.normalizeSplitLayout({ ratio: 'x', orientation: 'diagonal' }), nav.DEFAULT_SPLIT_LAYOUT)
  assert.deepEqual(nav.normalizeSplitLayout(null), nav.DEFAULT_SPLIT_LAYOUT)
  const store = new Map()
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => { store.set(key, value) } }
  nav.saveSplitLayout({ ratio: 0.35, orientation: 'rows' }, storage)
  assert.deepEqual(nav.loadSplitLayout(storage), { ratio: 0.35, orientation: 'rows' })
  assert.deepEqual(nav.loadSplitLayout({ getItem: () => '{not json' }), nav.DEFAULT_SPLIT_LAYOUT)
  assert.deepEqual(nav.loadSplitLayout(null), nav.DEFAULT_SPLIT_LAYOUT)

  // ── Tabs ─────────────────────────────────────────────────────────────────
  const tabs = [{ path: 'a' }, { path: 'b', pinned: true }, { path: 'c' }, { path: 'd', pinned: true }]
  assert.deepEqual(nav.sortPinnedFirst(tabs).map((tab) => tab.path), ['b', 'd', 'a', 'c'])
  const pinnedFirst = nav.sortPinnedFirst(tabs)
  assert.deepEqual(nav.reorderTabs(pinnedFirst, 'c', 'a').map((tab) => tab.path), ['b', 'd', 'c', 'a'])
  assert.deepEqual(nav.reorderTabs(pinnedFirst, 'a', null).map((tab) => tab.path), ['b', 'd', 'c', 'a'])
  // An unpinned tab cannot be dropped into the pinned block, nor a pinned one after it.
  assert.equal(nav.reorderTabs(pinnedFirst, 'c', 'b'), pinnedFirst)
  assert.equal(nav.reorderTabs(pinnedFirst, 'b', 'a'), pinnedFirst)
  assert.equal(nav.reorderTabs(pinnedFirst, 'b', null), pinnedFirst)
  assert.deepEqual(nav.reorderTabs(pinnedFirst, 'd', 'b').map((tab) => tab.path), ['d', 'b', 'a', 'c'])
  assert.deepEqual(nav.togglePinnedTab([{ path: 'a' }, { path: 'b' }], 'b').map((tab) => [tab.path, Boolean(tab.pinned)]), [['b', true], ['a', false]])
  assert.equal(nav.tabIndexForDigit(1, 3), 0)
  assert.equal(nav.tabIndexForDigit(3, 3), 2)
  assert.equal(nav.tabIndexForDigit(4, 3), null)
  assert.equal(nav.tabIndexForDigit(9, 3), 2)
  assert.equal(nav.tabIndexForDigit(9, 0), null)
  assert.deepEqual(nav.tabsToClose(pinnedFirst, 'a', 'others'), ['c'])
  assert.deepEqual(nav.tabsToClose(pinnedFirst, 'a', 'right'), ['c'])
  assert.deepEqual(nav.tabsToClose(pinnedFirst, 'c', 'right'), [])
  assert.deepEqual(nav.tabsToClose(pinnedFirst, 'zzz', 'others'), [])
  let closed = []
  for (let i = 0; i < nav.CLOSED_TABS_LIMIT + 5; i += 1) closed = nav.rememberClosedTab(closed, `t${i}`)
  assert.equal(closed.length, nav.CLOSED_TABS_LIMIT)
  assert.equal(closed[0], `t${nav.CLOSED_TABS_LIMIT + 4}`)
  assert.deepEqual(nav.rememberClosedTab(['a', 'b'], 'b'), ['b', 'a'])

  // ── Remembered workspace ─────────────────────────────────────────────────
  const memory = nav.normalizeWorkspaceMemory({ tabs: ['a', 'b', 'a', 7, ''], pinned: ['b', 'zzz'], active: 'a', split: 'b' })
  assert.deepEqual(memory, { tabs: ['a', 'b'], pinned: ['b'], active: 'a', split: 'b' })
  assert.equal(nav.normalizeWorkspaceMemory('nope'), null)
  assert.deepEqual(nav.normalizeWorkspaceMemory({ tabs: ['a'], active: 'gone', split: 'a' }).active, null)
  const pruned = nav.pruneWorkspaceMemory({ tabs: ['a', 'b', 'c'], pinned: ['a', 'c'], active: 'c', split: 'b' }, (path) => path !== 'c')
  assert.deepEqual(pruned, { tabs: ['a', 'b'], pinned: ['a'], active: null, split: 'b' })
  // The split never shows the active note twice.
  assert.equal(nav.pruneWorkspaceMemory({ tabs: ['a'], pinned: [], active: 'a', split: 'a' }, () => true).split, null)
  nav.saveWorkspaceMemory('/vault', { tabs: ['a', 'b'], pinned: [], active: 'a', split: 'b' }, storage)
  assert.deepEqual(nav.loadWorkspaceMemory('/vault', storage), { tabs: ['a', 'b'], pinned: [], active: 'a', split: 'b' })
  assert.equal(nav.loadWorkspaceMemory('/other', storage), null)
  assert.equal(nav.workspaceStorageKey(''), `${nav.WORKSPACE_STORAGE_PREFIX}default`)

  // ── Quick switcher ───────────────────────────────────────────────────────
  assert.deepEqual(nav.switcherNoteFor('Math/Algebra/Sets.md'), { path: 'Math/Algebra/Sets.md', title: 'Sets', folder: 'Math › Algebra' })
  assert.ok(nav.fuzzyScore('sets', 'Sets') > nav.fuzzyScore('sets', 'Subsets and Extras'))
  assert.ok(nav.fuzzyScore('alg', 'Algebra') > nav.fuzzyScore('alg', 'Analog'))
  assert.equal(nav.fuzzyScore('xyz', 'Sets'), 0)
  assert.equal(nav.fuzzyScore('', 'Anything'), 1)
  assert.ok(nav.fuzzyScore('ubung', 'Übung') > 0, 'umlauts match their base letters')
  const paths = ['Math/Sets.md', 'Bio/Cells.md', 'Inbox/Untitled Note 2.md', 'Welcome.md', 'Inbox/Untitled Note.md']
  const recentFirst = nav.rankSwitcherNotes(paths, '', ['Bio/Cells.md', 'Welcome.md']).map((note) => note.path)
  assert.deepEqual(recentFirst.slice(0, 2), ['Bio/Cells.md', 'Welcome.md'])
  assert.deepEqual(recentFirst.slice(2), ['Math/Sets.md', 'Inbox/Untitled Note.md', 'Inbox/Untitled Note 2.md'])
  assert.equal(nav.rankSwitcherNotes(paths, 'un2')[0].path, 'Inbox/Untitled Note 2.md')
  assert.equal(nav.rankSwitcherNotes(paths, 'cells')[0].path, 'Bio/Cells.md')
  assert.deepEqual(nav.rankSwitcherNotes(paths, 'zzzz'), [])
  assert.equal(nav.rankSwitcherNotes(paths, '', [], 2).length, 2)
  // A title hit beats the same letters buried in a folder name.
  assert.equal(nav.rankSwitcherNotes(['Sets/Intro.md', 'Math/Sets.md'], 'sets')[0].path, 'Math/Sets.md')

  // ── Ink preview page ─────────────────────────────────────────────────────
  const page = preview.parseInkPreviewPage(JSON.stringify({
    sourceWidth: 1252,
    sourceHeight: 476,
    sourceOriginX: 0,
    sourceOriginY: 144,
    strokes: [
      { color: '#000', baseWidth: 3, points: [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.3 }] },
      { color: '#000', points: [{ x: 'nan', y: 0.1 }, { x: 0.5, y: 0.5 }] },
      { points: [{ x: 0.1, y: 0.1 }] }, // no colour: dropped
      null,
    ],
  }))
  assert.equal(page.width, 1252)
  assert.equal(page.height, 476)
  assert.equal(page.originY, 144, 'text origin pad travels with the page')
  assert.equal(page.originX, 0)
  assert.equal(page.strokes.length, 2)
  assert.equal(page.strokes[1].points.length, 1, 'malformed points are dropped, not thrown')
  assert.equal(page.strokes[1].baseWidth, 4)
  assert.equal(preview.parseInkPreviewPage('{not json'), null)
  assert.equal(preview.parseInkPreviewPage(JSON.stringify({ strokes: [] })), null, 'a page without a size cannot be placed')
  assert.equal(preview.parseInkPreviewPage(JSON.stringify({ sourceWidth: 100, sourceHeight: 100, sourceOriginY: -5, strokes: [] })).originY, 0)
  // Device pixels times the sheet zoom up to 4×, capped by the pixel budget for tall pages.
  assert.equal(preview.inkPreviewScale(1000, 1000, 2), 2)
  assert.equal(preview.inkPreviewScale(1000, 1000, 5), 4)
  assert.equal(preview.inkPreviewScale(1000, 1000, 1, 2.5), 2.5, 'a zoomed pane rasterises the ink at the zoom, not stretched from 1×')
  assert.equal(preview.inkPreviewScale(1000, 1000, 2, 3), 4)
  assert.equal(preview.inkPreviewScale(1000, 1000, 1, 0.5), 1, 'zoomed out never drops below device pixels')
  assert.ok(preview.inkPreviewScale(4000, 20000, 2) < 1)

  const previewSource = readFileSync(new URL('../src/components/InkPreviewLayer.tsx', import.meta.url), 'utf8')
  assert.match(previewSource, /--text-origin-y/, 'the preview applies the saved text origin like the live board')
  assert.match(previewSource, /contextrestored/, 'a lost GPU context repaints the preview')
  assert.match(previewSource, /usePaperViewController\(\)/, 'the preview follows its own pane camera')
  assert.match(previewSource, /paperView\?\.subscribe\(/, 'zoom changes re-raster the preview once settled')

  // ── App wiring ───────────────────────────────────────────────────────────
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /editorRef\.current\?\.flushChanges\(\)\s*\n\s*if \(!await flushDocumentLayers\(\)\) return false/, 'a note switch books pending keystrokes under the leaving note')
  assert.match(app, /drawingSessionKeyRef\.current !== noteDrawingSession\.key/, 'the ink dirty flag belongs to the mounted board')
  assert.match(app, /InkPreviewLayer load=\{loadSplitInk\}/, 'the second pane paints the saved ink')
  // Each pane drives its own camera: zooming one sheet must not move the other.
  assert.match(app, /const splitPaperViewStore = useMemo<PaperViewStore>\(\(\) => createPaperViewStore\(\), \[\]\)/, 'the split pane owns a camera store')
  assert.match(app, /viewKey=\{`split:\$\{splitTab\.path\}`\}\s+showHud=\{false\}\s+store=\{splitPaperViewStore\}/, 'the split PaperView is wired to its own store')
  assert.match(app, /globalShortcuts=\{!splitTab \|\| focusedPane === 'main'\}/, 'Ctrl+/- and the pinch go to the focused pane')
  assert.match(app, /globalShortcuts=\{focusedPane === 'split'\}/)
  assert.match(app, /for \(const store of \[sharedPaperViewStore, splitPaperViewStore\]\)/, 'a new zoom limit clamps both cameras')
  assert.match(app, /'--split-first': `\$\{splitTracks\.first\}px`, '--split-divider': `\$\{splitTracks\.divider\}px`/, 'the measured, snapped tracks reach the grid')
  const paperView = readFileSync(new URL('../src/components/PaperView.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(paperView, /writeSharedPaperView|readSharedPaperView\(|subscribeSharedPaperView/, 'PaperView never touches the shared store directly; everything goes through its store prop')
  assert.match(paperView, /store = sharedPaperViewStore/, 'the main pane keeps the shared store the ink board and settings use')
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  assert.match(css, /grid-template-columns: minmax\(0, min\(var\(--split-first, calc\(\(100% - var\(--split-divider\)\) \* var\(--split-ratio\)\)\)/, 'the snapped track wins over the percentage')
  assert.match(css, /\.unified-paper \.markdown-editor \.cm-gutters \{ padding-top: 0; background: transparent; \}/, 'the fold gutter is aligned with its lines (CodeMirror pads it itself) and lets the ruling through')
  assert.match(app, /await restoreWorkspace\(data\.vaultPath, initialTree\)/, 'a fresh vault starts remembering its workspace')
  for (const shortcut of ["event.key === 'Tab'", "/^[1-9]$/.test(event.key)", "event.key.toLowerCase() === 't'", "event.key.toLowerCase() === 'o'", "event.code === 'Backslash'", "event.key === 'ArrowLeft' || event.key === 'ArrowRight'"]) {
    assert.ok(app.includes(shortcut), `keyboard: ${shortcut}`)
  }
  const board = readFileSync(new URL('../src/components/DrawingBoard.tsx', import.meta.url), 'utf8')
  assert.match(board, /onDirtyChange\?\.\(dirty && inkPagePersists\(/, 'a page with nothing to write never reports dirty to the host')

  console.log('workspace-nav ok')
} finally {
  await server.close()
}
