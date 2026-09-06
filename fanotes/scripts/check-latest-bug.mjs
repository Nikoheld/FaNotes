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
  inkToolbarPortalHost,
  liveInkToolbarHost,
  overlayAfterNoteSwitch,
  overlayPenHitReady,
  overlayShowsCrashFallback,
  portalInkToolbar,
} = await server.ssrLoadModule('/src/lib/pdfInkHit.ts')
const {
  FORM_DETECT_NOTICE_TEXT,
  SCRIBBLE_ERASE_NOTICE_TEXT,
  applyInkNoticeOp,
  emptyInkNoticeState,
  inkNoticeAutoClearDelayMs,
} = await server.ssrLoadModule('/src/lib/inkNotice.ts')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const appSource = readFileSync(join(root, 'src/App.tsx'), 'utf8')
const boardSource = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')

/**
 * Newest report under /var/lib/fanotes-bug-reports: directory mtime
 * 2026-09-06 14:42:17 CEST → numeric prefix 1788698537115. JSON is 0600
 * www-data and unreadable here. Post-2026.9.11 sequence: Stift stays on
 * across empty-note switch; a detached toolbar slot must not crash the overlay.
 */
const REPORT_LATEST = {
  id: '1788698537115',
  version: '2026.9.11',
  platform: 'linux',
  notes: ['Eingang/Untitled note 4.md', 'Eingang/Untitled note 3.md'],
}

const connectedHost = () => ({ id: INK_TOOLBAR_SLOT_ID, isConnected: true })
const detachedHost = () => ({ id: INK_TOOLBAR_SLOT_ID, isConnected: false })

try {
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
  assert.equal(inkBoardReady(state.session.key), false)

  state = applyOverlayLifetimeOp(state, { type: 'note-switch', requestId: 1 })
  state = applyOverlayLifetimeOp(state, { type: 'ink-loaded', requestId: 1, document: null })
  state = applyOverlayLifetimeOp(state, { type: 'stift', open: true })
  state = applyOverlayLifetimeOp(state, { type: 'host', host: connectedHost() })
  assert.equal(inkBoardReady(state.session.key), true)
  assert.equal(portalInkToolbar(createPortalOrThrow, { toolbar: true }, state.host, true)?.portaled, true)

  const stale = detachedHost()
  const switched = overlayAfterNoteSwitch({
    session: state.session,
    drawingOpen: true,
    host: stale,
  }, 2)
  assert.equal(drawingSessionFromLoad(2, null).key, switched.session.key)
  assert.equal(inkBoardReady(switched.session.key), true)
  assert.equal(switched.drawingOpen, true)
  assert.equal(liveInkToolbarHost(stale), null)
  assert.equal(inkToolbarPortalHost(stale, true), null)
  assert.equal(portalInkToolbar(createPortalOrThrow, { toolbar: true }, stale, true), null)
  assert.equal(
    overlayShowsCrashFallback({ fallbackTitle: INK_OVERLAY_CRASH_TITLE, ready: inkBoardReady(switched.session.key) }),
    false,
  )

  const throwEvenIfConnected = () => {
    throw new Error('createPortal into a node that is not in the document')
  }
  assert.equal(portalInkToolbar(throwEvenIfConnected, { toolbar: true }, connectedHost(), true), null)

  state = switched
  state = applyOverlayLifetimeOp(state, { type: 'host', host: connectedHost() })
  assert.equal(overlayPenHitReady(state.session.key, state.drawingOpen), true)
  assert.equal(portalInkToolbar(createPortalOrThrow, { toolbar: true }, state.host, true)?.portaled, true)

  for (const [text, kind] of [
    [SCRIBBLE_ERASE_NOTICE_TEXT, 'success'],
    [FORM_DETECT_NOTICE_TEXT, 'info'],
  ]) {
    const shown = applyInkNoticeOp(emptyInkNoticeState(), {
      type: 'show',
      notice: { kind, text },
      now: 10,
    })
    const delay = inkNoticeAutoClearDelayMs(shown.notice)
    assert.ok(Number.isFinite(delay) && delay > 0)
    assert.equal(applyInkNoticeOp(shown, { type: 'tick', now: 10 + delay }).notice, null)
    assert.equal(applyInkNoticeOp(shown, { type: 'close' }).notice, null)
  }

  assert.match(appSource, /overlayAfterNoteSwitch/)
  assert.match(boardSource, /portalInkToolbar\(createPortal/)
  assert.match(boardSource, /inkNoticeAutoClearDelayMs/)

  console.log(JSON.stringify({
    report: REPORT_LATEST.id,
    version: REPORT_LATEST.version,
    platform: REPORT_LATEST.platform,
    notes: REPORT_LATEST.notes,
    lastReady: inkBoardReady(state.session.key),
    lastHit: overlayPenHitReady(state.session.key, state.drawingOpen),
    lastHost: inkToolbarPortalHost(state.host, state.drawingOpen)?.isConnected === true,
    stiftStayedOn: state.drawingOpen === true,
  }))
  console.log('latest-bug ok')
} finally {
  await server.close()
}
