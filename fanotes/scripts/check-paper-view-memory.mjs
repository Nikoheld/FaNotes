import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

// Per-note camera memory: zoom + viewport centre survive a note switch and a
// relaunch, and typed notes come back with the same text under the viewport
// edge even though CodeMirror only estimates unrendered line heights.

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const memory = await server.ssrLoadModule('/src/lib/paperViewMemory.ts')
const anchorMod = await server.ssrLoadModule('/src/lib/paperTextAnchor.ts')

const {
  PAPER_VIEW_MEMORY_KEY,
  cameraForPaperCentre,
  isProgrammaticScroll,
  loadPaperViewMemory,
  paperCentreFromCamera,
  paperViewFromMemory,
  paperViewMemoryKey,
  parsePaperViewMemory,
  prunePaperViewMemory,
  recallPaperView,
  rememberPaperView,
  savePaperViewMemory,
  scaledPaperCentre,
  scrollTopForAnchorClientY,
  shouldKeepRestoringPaperView,
} = memory
const { clientYFromTextAnchor, normalizeTextAnchor, textAnchorFromView } = anchorMod

// --- store round trip -------------------------------------------------------
const fakeStorage = () => {
  const map = new Map()
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v) }, dump: () => Object.fromEntries(map) }
}
const storage = fakeStorage()
let store = loadPaperViewMemory(storage)
assert.deepEqual(store, {}, 'empty storage → empty store')
store = rememberPaperView(store, 'Math/Algebra.md', { zoom: 2.4431, rotation: 0, centreX: 309.42, centreY: 2880.444, pageWidth: 512.48, pageHeight: 5588.87, anchor: { pos: 1844, offset: 67.373 } }, 400)
assert.ok(savePaperViewMemory(store, storage))
const reloaded = loadPaperViewMemory(storage)
const entry = recallPaperView(reloaded, 'Math/Algebra.md')
assert.equal(entry.zoom, 2.443, 'zoom rounded to 1/1000')
assert.equal(entry.centreX, 309.42)
assert.equal(entry.pageWidth, 512.48)
assert.deepEqual(entry.anchor, { pos: 1844, offset: 67.37 }, 'text anchor survives the round trip')
assert.ok(entry.at > 0)
assert.equal(recallPaperView(reloaded, 'Other.md'), null)
assert.equal(paperViewMemoryKey('split:Math/Algebra.md'), 'Math/Algebra.md', 'split pane shares the note camera')
assert.equal(paperViewMemoryKey(''), '')
assert.deepEqual(paperViewFromMemory(null), { zoom: 1, rotation: 0, pan: { x: 0, y: 0 } })
assert.equal(paperViewFromMemory(entry).zoom, 2.443)

// Broken / hostile storage never throws and never yields NaN cameras.
assert.deepEqual(parsePaperViewMemory('{not json'), {})
assert.deepEqual(parsePaperViewMemory('[1,2]'), {})
const dirty = parsePaperViewMemory(JSON.stringify({
  ok: { zoom: 1.5, centreX: 10, centreY: 20, at: 5 },
  noZoom: { centreX: 1 },
  nanZoom: { zoom: 'x', centreX: 1 },
  badAnchor: { zoom: 1, centreX: 0, centreY: 0, anchor: { pos: -3, offset: 'y' } },
}))
assert.deepEqual(Object.keys(dirty).sort(), ['badAnchor', 'ok'])
assert.equal(dirty.badAnchor.anchor, undefined, 'invalid anchor dropped, entry kept')
assert.equal(normalizeTextAnchor({ pos: 12.4, offset: -3.456 }).pos, 12)
assert.equal(normalizeTextAnchor({ pos: 12, offset: -3.456 }).offset, -3.46)
assert.equal(normalizeTextAnchor({ pos: Infinity, offset: 0 }), null)

// LRU pruning keeps the newest cameras.
let big = {}
for (let i = 0; i < 12; i += 1) big = rememberPaperView(big, `n${i}.md`, { zoom: 1, rotation: 0, centreX: 0, centreY: 0, at: 1000 + i }, 400)
const pruned = prunePaperViewMemory(big, 5)
assert.deepEqual(Object.keys(pruned).sort(), ['n10.md', 'n11.md', 'n7.md', 'n8.md', 'n9.md'])
assert.equal(PAPER_VIEW_MEMORY_KEY, 'fanotes.paperView.v1')

// --- pixel centre camera (PDF / ink) ------------------------------------------
const scroller = { clientWidth: 1252, clientHeight: 858, scrollLeft: 1498, scrollTop: 11925 }
const scrollerRect = { left: 300, top: 102, width: 1252, height: 858 }
const zoom = 2.443
const pageRect = { left: 300 - 130, top: 102 - 9000, width: 512.48 * zoom, height: 4113 * zoom }
const centre = paperCentreFromCamera(scroller, scrollerRect, pageRect, zoom)
assert.equal(centre.centreX, Math.round(((300 + 626 - 170) / zoom) * 100) / 100)
const camera = cameraForPaperCentre(scroller, scrollerRect, pageRect, zoom, centre)
assert.ok(Math.abs(camera.scrollLeft - scroller.scrollLeft) < 0.02, 'centre → camera → same scrollLeft')
assert.ok(Math.abs(camera.scrollTop - scroller.scrollTop) < 0.02, 'centre → camera → same scrollTop')

// The page came back narrower (sidebar open): PDF content scales both axes,
// typed text keeps its vertical pixel (its anchor decides instead).
const saved = { centreX: 400, centreY: 3000, pageWidth: 1000 }
assert.deepEqual(scaledPaperCentre(saved, 800, true), { centreX: 320, centreY: 2400 })
assert.deepEqual(scaledPaperCentre(saved, 800, false), { centreX: 320, centreY: 3000 })
assert.deepEqual(scaledPaperCentre(saved, 1000.2, true), { centreX: 400, centreY: 3000 }, 'sub-px width noise is not a re-flow')
assert.deepEqual(scaledPaperCentre({ centreX: 400, centreY: 3000 }, 800, true), { centreX: 400, centreY: 3000 }, 'no saved width → no scaling')

// --- text anchor: stable under a changing height estimate --------------------
// A fake editor: 122 lines of 34 chars, each line block `top` comes from an
// estimate table that we can swap out (as CodeMirror does when it measures
// rendered lines).
const LINE_CHARS = 34
const LINE_COUNT = 122
const makeView = (lineTops, documentTop, scaleY) => ({
  documentTop,
  scaleY,
  state: { doc: { length: LINE_CHARS * LINE_COUNT } },
  lineBlockAt: (pos) => {
    const index = Math.min(lineTops.length - 1, Math.floor(pos / LINE_CHARS))
    return { from: index * LINE_CHARS, top: lineTops[index] }
  },
  lineBlockAtHeight: (height) => {
    let index = 0
    while (index + 1 < lineTops.length && lineTops[index + 1] <= height) index += 1
    return { from: index * LINE_CHARS, top: lineTops[index] }
  },
})
// Estimate: every line 60 client px. Measured: lines from 60 on are 100 px.
const estimated = Array.from({ length: LINE_COUNT }, (_, i) => i * 60)
const measured = Array.from({ length: LINE_COUNT }, (_, i) => i * 60 + Math.max(0, i - 60) * 40)
const viewportTop = 102
const before = makeView(measured, -5000, zoom)
const anchor = textAnchorFromView(before, viewportTop)
assert.ok(anchor.pos % LINE_CHARS === 0 && anchor.pos > 60 * LINE_CHARS, 'anchor is a line start inside the measured region')
const lineTopBefore = before.documentTop + before.lineBlockAt(anchor.pos).top
assert.ok(Math.abs((lineTopBefore + anchor.offset * zoom) - viewportTop) < 0.05, 'anchor offset re-creates the viewport edge')
// Reopen: heights are estimates again, the document sits elsewhere.
const after = makeView(estimated, -3815, zoom)
const y = clientYFromTextAnchor(after, anchor)
const lineTopAfter = after.documentTop + after.lineBlockAt(anchor.pos).top
assert.ok(Math.abs(y - (lineTopAfter + anchor.offset * zoom)) < 0.05, 'same line, same offset under the new estimate')
const nextTop = scrollTopForAnchorClientY({ scrollTop: 5476 }, { top: viewportTop }, y)
assert.equal(nextTop, Math.round((5476 + y - viewportTop) * 100) / 100)
assert.equal(scrollTopForAnchorClientY({ scrollTop: 10 }, { top: 100 }, 20), 0, 'never scrolls above the top')
// Anchor beyond the document (note was shortened) clamps to the last line.
const clampedY = clientYFromTextAnchor(after, { pos: 99999, offset: 0 })
assert.equal(clampedY, after.documentTop + after.lineBlockAt(LINE_CHARS * LINE_COUNT).top)
// Viewport edge above the first line → negative offset, restores exactly.
const highAnchor = textAnchorFromView(before, before.documentTop - 500)
assert.ok(highAnchor.offset < 0)
assert.ok(Math.abs(clientYFromTextAnchor(before, highAnchor) - (before.documentTop - 500)) < 0.05)
// scaleY 0 / NaN (editor not laid out yet) falls back to 1 instead of Infinity.
assert.ok(Number.isFinite(textAnchorFromView(makeView(estimated, 0, 0), 50).offset))

// --- restore loop guards -------------------------------------------------------
assert.equal(isProgrammaticScroll({ scrollLeft: 1498, scrollTop: 11925 }, { scrollLeft: 1498, scrollTop: 11926 }), true)
assert.equal(isProgrammaticScroll({ scrollLeft: 1498, scrollTop: 8650 }, { scrollLeft: 1498, scrollTop: 11925 }), false, 'browser clamp is not ours')
assert.equal(isProgrammaticScroll({ scrollLeft: 0, scrollTop: 0 }, null), false)
assert.equal(shouldKeepRestoringPaperView({ startedAt: 0, now: 1000, userInteracted: false }), true)
assert.equal(shouldKeepRestoringPaperView({ startedAt: 0, now: 1000, userInteracted: true }), false, 'first wheel/pen stops the restore')
assert.equal(shouldKeepRestoringPaperView({ startedAt: 0, now: 5000, userInteracted: false }), false)

// --- wiring ------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url))
const paperView = readFileSync(join(here, '../src/components/PaperView.tsx'), 'utf8')
assert.match(paperView, /useLayoutEffect\(\(\) => \{\s*\/\/ Only when the note identity changes/u, 'camera memory applies before first paint')
assert.match(paperView, /recallPaperView\(loadPaperViewMemory\(\), paperViewMemoryKey\(viewKey\)\)/u, 'note switch recalls the remembered camera')
assert.match(paperView, /findPaperTextAnchorProvider\(scroller\)\?\.clientYForAnchor\(remembered\.anchor\)/u, 'typed notes restore by text anchor')
assert.match(paperView, /if \(restoring && !userInteracted\) \{/u, 'restore never re-saves the settling camera')
assert.match(paperView, /window\.addEventListener\('pagehide', saveNow\)/u, 'camera saved on window close')
assert.match(paperView, /persist\(latestEntry\)/u, 'camera saved when leaving the note')
const editor = readFileSync(join(here, '../src/components/MarkdownEditor.tsx'), 'utf8')
assert.match(editor, /registerPaperTextAnchorProvider\(host, \{/u, 'editor provides the text anchor')
const pdfView = readFileSync(join(here, '../src/components/PdfNoteView.tsx'), 'utf8')
assert.match(pdfView, /if \(cam \? cam\.recalled : recallPaperView\(loadPaperViewMemory\(\), path\)\) \{/u, 'PDF page-into-view and first-open fit yield to the remembered camera')
assert.match(pdfView, /\{loading && !pdf && <div className="pdf-note-status">/u, 'loading placeholder leaves the flow once the document exists (no 220px column jump)')
const pkg = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8'))
const cmView = readFileSync(join(here, '../node_modules/@codemirror/view/package.json'), 'utf8')
const cmVersion = JSON.parse(cmView).version.split('.').map(Number)
assert.ok(cmVersion[0] > 6 || (cmVersion[0] === 6 && (cmVersion[1] > 43 || (cmVersion[1] === 43 && cmVersion[2] >= 10))), `@codemirror/view ≥ 6.43.10 fixes scroll anchoring under CSS zoom (have ${JSON.stringify(cmVersion)})`)
assert.match(pkg.devDependencies['@codemirror/view'], /\^6\.43\.1[1-9]|\^6\.4[4-9]/u)

await server.close()
console.log(JSON.stringify({ entry: { zoom: entry.zoom, anchor: entry.anchor }, anchor, restoredScrollTop: nextTop }))
console.log('paper-view-memory ok')
