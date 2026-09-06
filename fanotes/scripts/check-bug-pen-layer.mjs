import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  INK_OVERLAY_CRASH_TITLE,
  INK_TOOLBAR_SLOT_ID,
  applyOverlayLifetimeOp,
  drawingSessionFromLoad,
  inkBoardReady,
  inkOverlayHitSelector,
  inkToolbarPortalHost,
  liveInkToolbarHost,
  overlayAfterNoteSwitch,
  overlayPenHitReady,
  overlayShowsCrashFallback,
  penModeToolbarSlot,
  pointerEventsForInkLayer,
  portalInkToolbar,
  resolveInkToolbarHost,
} = await server.ssrLoadModule('/src/lib/pdfInkHit.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const appSource = readFileSync(join(root, 'src/App.tsx'), 'utf8')
const boardSource = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
const css = readFileSync(join(root, 'src/styles.css'), 'utf8')

/**
 * Linux 2026.9.10 report 1788690730379: “The Pen Layer always crashes”.
 * session-start, open Eingang/Untitled note 4.md, then Eingang/Untitled note 3.md.
 * Empty markdown notes; no pen samples.
 */
const REPORT_1788690730379 = {
  id: '1788690730379',
  version: '2026.9.10',
  description: 'The Pen Layer always crashes',
  notes: ['Eingang/Untitled note 4.md', 'Eingang/Untitled note 3.md'],
}

const connectedHost = () => ({
  id: INK_TOOLBAR_SLOT_ID,
  isConnected: true,
})

const detachedHost = () => ({
  id: INK_TOOLBAR_SLOT_ID,
  isConnected: false,
})

try {
  assert.equal(INK_OVERLAY_CRASH_TITLE, 'Die Stiftebene ist abgestürzt')
  assert.equal(inkBoardReady(0), false, 'start state is not overlay-ready')
  assert.equal(inkBoardReady(drawingSessionFromLoad(1, null).key), true)

  const createPortalOrThrow = (node, host) => {
    if (!host || host.isConnected === false) {
      throw new Error('createPortal into a node that is not in the document')
    }
    return { portaled: true, node, host }
  }

  let state = {
    session: { key: 0, document: null },
    drawingOpen: false,
    host: null,
  }
  const frames = []
  const drive = (op) => {
    state = applyOverlayLifetimeOp(state, op)
    const portalHost = inkToolbarPortalHost(state.host, state.drawingOpen)
    const portaled = portalInkToolbar(createPortalOrThrow, { toolbar: true }, state.host, state.drawingOpen)
    const ui = {
      ready: inkBoardReady(state.session.key),
      fallbackTitle: overlayShowsCrashFallback({ fallbackTitle: INK_OVERLAY_CRASH_TITLE, ready: inkBoardReady(state.session.key) })
        ? INK_OVERLAY_CRASH_TITLE
        : undefined,
      hit: overlayPenHitReady(state.session.key, state.drawingOpen),
      slot: penModeToolbarSlot(state.drawingOpen, false),
      overlayPointerEvents: pointerEventsForInkLayer('overlay', state.drawingOpen),
      hostConnected: portalHost?.isConnected === true,
      portaled: Boolean(portaled),
    }
    assert.equal(overlayShowsCrashFallback({ fallbackTitle: INK_OVERLAY_CRASH_TITLE, ready: ui.ready }), false)
    assert.notEqual(ui.fallbackTitle, INK_OVERLAY_CRASH_TITLE)
    frames.push({ op: op.type, ...ui, key: state.session.key })
    return ui
  }

  // session-start → note 4 (empty markdown), Stift on
  drive({ type: 'note-switch', requestId: 1 })
  drive({ type: 'ink-loaded', requestId: 1, document: null })
  assert.equal(inkBoardReady(state.session.key), true)
  drive({ type: 'host', host: connectedHost() })
  const note4On = drive({ type: 'stift', open: true })
  assert.equal(note4On.ready, true)
  assert.equal(note4On.hostConnected, true)
  assert.equal(note4On.hit, true)
  assert.equal(note4On.overlayPointerEvents, 'auto')
  assert.equal(note4On.slot, 'ink')
  assert.equal(note4On.portaled, true)

  drive({ type: 'stift', open: false })
  const note4Off = drive({ type: 'stift', open: true })
  assert.equal(note4Off.ready, true)
  assert.equal(note4Off.hostConnected, true)

  // Switch to note 3: previous slot detaches. Portaling into it must not throw.
  const stale = detachedHost()
  assert.equal(liveInkToolbarHost(stale), null)
  assert.equal(inkToolbarPortalHost(stale, true), null)
  assert.equal(portalInkToolbar(createPortalOrThrow, { toolbar: true }, stale, true), null)

  const switched = overlayAfterNoteSwitch({
    session: state.session,
    drawingOpen: true,
    host: stale,
  }, 2)
  assert.equal(inkBoardReady(switched.session.key), true, 'note switch must leave a ready overlay, not key 0')
  assert.equal(switched.drawingOpen, true, 'Stift stays on across the note switch')
  assert.equal(switched.host, null, 'detached slot cannot remain the portal host')
  assert.equal(portalInkToolbar(createPortalOrThrow, { toolbar: true }, stale, switched.drawingOpen), null)
  assert.notEqual(switched.session.key, 0)

  state = switched
  const afterSwitch = drive({ type: 'ink-loaded', requestId: 2, document: null })
  assert.equal(afterSwitch.ready, true)
  assert.equal(overlayShowsCrashFallback({ fallbackTitle: INK_OVERLAY_CRASH_TITLE, ready: afterSwitch.ready }), false)

  drive({ type: 'host', host: connectedHost() })
  const note3On = drive({ type: 'stift', open: true })
  assert.equal(note3On.ready, true)
  assert.equal(note3On.hostConnected, true)
  assert.equal(note3On.hit, true)
  assert.equal(note3On.portaled, true)
  drive({ type: 'stift', open: false })
  const note3OnAgain = drive({ type: 'stift', open: true })
  assert.equal(note3OnAgain.hostConnected, true)
  assert.equal(note3OnAgain.ready, true)

  const toolbarRoot = {
    nodes: { [INK_TOOLBAR_SLOT_ID]: { id: INK_TOOLBAR_SLOT_ID, isConnected: true } },
    getElementById(id) { return this.nodes[id] ?? null },
    querySelector(selector) { return this.nodes[selector.slice(1)] ?? null },
  }
  assert.equal(resolveInkToolbarHost(toolbarRoot)?.isConnected, true)
  toolbarRoot.nodes[INK_TOOLBAR_SLOT_ID] = { id: INK_TOOLBAR_SLOT_ID, isConnected: false }
  assert.equal(resolveInkToolbarHost(toolbarRoot), null, 'detached slot is not a portal host')

  assert.match(appSource, /overlayAfterNoteSwitch/)
  assert.match(appSource, /INK_OVERLAY_CRASH_TITLE/)
  assert.match(appSource, /key=\{`stiftebene:\$\{activeTab\.path\}:\$\{drawingSession\.key\}`\}/)
  assert.match(boardSource, /portalInkToolbar\(createPortal/)
  assert.match(boardSource, /liveInkToolbarHost/)
  assert.match(css, new RegExp(inkOverlayHitSelector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\\\', '\\')))
  const hitBlockStart = css.indexOf('.lw-drawing-board.is-inline.is-input-active')
  assert.ok(hitBlockStart >= 0)
  assert.match(css.slice(hitBlockStart, hitBlockStart + 280), /pointer-events:\s*auto/)

  console.log(JSON.stringify({
    report: REPORT_1788690730379.id,
    version: REPORT_1788690730379.version,
    notes: REPORT_1788690730379.notes,
    frames: frames.length,
    lastKey: state.session.key,
    lastReady: inkBoardReady(state.session.key),
    lastHit: overlayPenHitReady(state.session.key, state.drawingOpen),
    lastHost: inkToolbarPortalHost(state.host, state.drawingOpen)?.isConnected === true,
    crashFallback: INK_OVERLAY_CRASH_TITLE,
  }))
  console.log('bug-pen-layer ok')
} finally {
  await server.close()
}
