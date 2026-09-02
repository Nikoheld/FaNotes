import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import {
  acceptBugReportPayload,
  BUG_REPORT_MAX_BODY_BYTES as handlerMaxBody,
} from '../../fanotes-site/bug-report-api.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  PAGE_START_HEIGHT,
  PAGE_START_WIDTH,
  growPageFromMark,
  keepMarkOnPage,
  markdownAndInkAfterMinEdgeGrow,
  paperOriginScrollDelta,
  paintedStayExtent,
  textOriginCssPx,
} = await server.ssrLoadModule('/src/lib/noteCanvas.ts')
const {
  continueLiveWriteStroke,
  continueStrokeAfterExtentGrow,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')
const { classifyInkJumpAppend } = await server.ssrLoadModule('/src/lib/inkSampleMap.ts')
const {
  BUG_REPORT_MAX_BODY_BYTES,
  BUG_REPORT_MAX_EVENTS,
  BUG_REPORT_PEN_SAMPLE_MS,
  BUG_REPORT_WINDOW_MS,
  buildBugReportRequest,
  buildPenDiagnosticEvent,
  createBugReportLog,
} = await server.ssrLoadModule('/src/lib/bugReport.ts')

/**
 * Linux 2026.8.77 report 1788158126376: left-edge pen, x ≈ 0.03–0.12,
 * y from ≈ 0.07 down through ≈ 0.75, including near-top samples that grow.
 * Layout stays stale for the whole stroke (ResizeObserver defers while inking).
 */
const REPORT_1788158126376 = [
  { x: 0.031, y: 0.071 },
  { x: 0.038, y: 0.074 },
  { x: 0.044, y: 0.078 },
  { x: 0.052, y: 0.086 },
  { x: 0.061, y: 0.102 },
  { x: 0.068, y: 0.128 },
  { x: 0.074, y: 0.164 },
  { x: 0.081, y: 0.221 },
  { x: 0.088, y: 0.286 },
  { x: 0.094, y: 0.352 },
  { x: 0.101, y: 0.428 },
  { x: 0.108, y: 0.511 },
  { x: 0.114, y: 0.598 },
  { x: 0.118, y: 0.672 },
  { x: 0.121, y: 0.748 },
]

const driveReport = () => {
  const start = { width: PAGE_START_WIDTH, height: PAGE_START_HEIGHT }
  const painted = { width: 1400, height: 800 }
  const text = { x: 86, y: 78 }
  const existingInk = { x: 0.22, y: 0.31 }
  let page = { ...start, originX: 0, originY: 0 }
  let pendingStale = null
  let last = null
  let ink = { ...existingInk }
  let glyph = { ...text }
  let cameraX = 0
  let cameraY = 0
  const originInkX = existingInk.x * paintedStayExtent(start.width, painted.width)
  const originInkY = existingInk.y * paintedStayExtent(start.height, painted.height)
  const points = []
  const diagnostics = []
  const grows = []
  let naiveSkips = 0

  for (const [index, sample] of REPORT_1788158126376.entries()) {
    const live = continueLiveWriteStroke({
      last,
      current: sample,
      page,
      painted,
      existingCount: points.length,
      pendingStale,
    })
    pendingStale = live.pendingStale

    if (index > 0 && last && classifyInkJumpAppend(last, sample, points.length) === 'skip') naiveSkips += 1

    if (live.grew) {
      const prevPaint = live.prev
      const nextPaint = live.next
      const stay = markdownAndInkAfterMinEdgeGrow(
        ink,
        glyph,
        prevPaint,
        { width: nextPaint.width, height: nextPaint.height, padX: live.grown.padX, padY: live.grown.padY },
        nextPaint,
        prevPaint,
      )
      assert.equal(stay.origin.x, textOriginCssPx(live.grown.padX, live.grown.padY).x)
      assert.equal(stay.origin.y, textOriginCssPx(live.grown.padX, live.grown.padY).y)
      assert.equal(stay.scrollX, paperOriginScrollDelta(live.grown.padX))
      assert.equal(stay.scrollY, paperOriginScrollDelta(live.grown.padY))
      cameraX += stay.scrollX
      cameraY += stay.scrollY
      const visualInkX = stay.inkX - cameraX
      const visualInkY = stay.inkY - cameraY
      const visualTextX = stay.textX - cameraX
      const visualTextY = stay.textY - cameraY
      assert.ok(
        Math.abs(visualInkX - originInkX) < 1e-6,
        `step ${index} ink X ${visualInkX} must stay ${originInkX}`,
      )
      assert.ok(
        Math.abs(visualInkY - originInkY) < 1e-6,
        `step ${index} ink Y ${visualInkY} must stay ${originInkY}`,
      )
      assert.ok(
        Math.abs(visualTextX - text.x) < 1e-6,
        `step ${index} typed text X ${visualTextX} must stay ${text.x}`,
      )
      assert.ok(
        Math.abs(visualTextY - text.y) < 1e-6,
        `step ${index} typed text Y ${visualTextY} must stay ${text.y}`,
      )
      ink = {
        x: nextPaint.width > 0 ? stay.inkX / nextPaint.width : ink.x,
        y: nextPaint.height > 0 ? stay.inkY / nextPaint.height : ink.y,
      }
      glyph = { x: stay.textX, y: stay.textY }
      page = {
        width: live.grown.width,
        height: live.grown.height,
        originX: (page.originX ?? 0) + live.grown.padX,
        originY: (page.originY ?? 0) + live.grown.padY,
      }
      grows.push({
        index,
        padX: live.grown.padX,
        padY: live.grown.padY,
        visualInkX,
        visualInkY,
        visualTextX,
        visualTextY,
      })
    }

    const diagnostic = buildPenDiagnosticEvent({
      at: 20_000_000 + index * BUG_REPORT_PEN_SAMPLE_MS,
      noteId: 'Notizen/Physik.md',
      x: live.current.x,
      y: live.current.y,
      pointerType: 'pen',
      tool: 'pen',
      version: '2026.9.1',
      platform: 'linux',
      pageW: page.width,
      pageH: page.height,
      padX: page.originX ?? 0,
      padY: page.originY ?? 0,
      camX: cameraX,
      camY: cameraY,
      grew: live.grew,
      jump: live.action === 'skip',
    })
    diagnostics.push(diagnostic)
    assert.equal(typeof diagnostic.pageW, 'number')
    assert.equal(typeof diagnostic.pageH, 'number')
    assert.equal(typeof diagnostic.padX, 'number')
    assert.equal(typeof diagnostic.padY, 'number')
    assert.equal(typeof diagnostic.camX, 'number')
    assert.equal(typeof diagnostic.camY, 'number')

    assert.notEqual(live.action, 'skip', `report sample ${index} at y=${sample.y} must stay on the stroke after remap`)
    if (live.action === 'restart') points.splice(0, 1, live.current)
    else points.push(live.current)
    last = live.current
  }

  assert.ok(grows.length > 0, 'the near-top samples must grow the sheet')
  assert.ok(grows[0].padY > 0, 'the first near-top sample must open paper above')
  assert.ok(naiveSkips > 0, 'without stale-layout remap the same sequence would jump-filter later samples')
  assert.equal(points.length, REPORT_1788158126376.length)

  const first = REPORT_1788158126376[0]
  const grown = growPageFromMark(start, first, painted)
  assert.ok(grown.padY > 0)
  const remappedFirst = keepMarkOnPage(
    first.y,
    paintedStayExtent(start.height, painted.height),
    Math.max(paintedStayExtent(start.height, painted.height), grown.height),
    grown.padY,
  )
  assert.ok(remappedFirst > first.y)

  return {
    points: points.length,
    grows: grows.length,
    firstPadY: grows[0].padY,
    naiveSkips,
    lastY: points.at(-1).y,
    pageH: page.height,
    padY: page.originY,
    camY: cameraY,
    visualTextY: grows.at(-1).visualTextY,
    visualInkY: grows.at(-1).visualInkY,
    diagnostics,
  }
}

const runOnce = () => {
  const driven = driveReport()
  const now = 20_000_000 + BUG_REPORT_WINDOW_MS
  const log = createBugReportLog()
  for (const event of driven.diagnostics) log.record(event, now)
  const request = buildBugReportRequest({
    description: 'It jumpst around while painting.',
    events: log.snapshot(now),
    version: '2026.9.1',
    platform: 'linux',
    now,
  })
  const accepted = acceptBugReportPayload(request.body)
  assert.equal(accepted.ok, true)
  assert.ok(accepted.report.events.length >= 1)
  const stored = accepted.report.events.filter((event) => event.kind === 'pen')
  assert.ok(stored.length >= driven.diagnostics.length)
  for (const event of stored) {
    assert.equal(typeof event.pageW, 'number', 'handler must keep page extent')
    assert.equal(typeof event.pageH, 'number')
    assert.equal(typeof event.padX, 'number', 'handler must keep origin pad')
    assert.equal(typeof event.padY, 'number')
    assert.equal(typeof event.camX, 'number', 'handler must keep camera/scroll')
    assert.equal(typeof event.camY, 'number')
  }
  assert.ok(stored.some((event) => event.grew === true), 'a grow during the stroke must persist')

  const fullLog = createBugReportLog()
  const start = now - BUG_REPORT_WINDOW_MS + 1
  const step = Math.max(1, Math.floor((BUG_REPORT_WINDOW_MS - 2) / BUG_REPORT_MAX_EVENTS))
  for (let index = 0; index < BUG_REPORT_MAX_EVENTS; index += 1) {
    fullLog.record(buildPenDiagnosticEvent({
      at: start + index * step,
      noteId: 'Faecher/Mathematik/Uebungen/Lineare-Algebra-Blatt-12.md',
      x: 0.031 + (index % 50) / 1000,
      y: 0.071 + (index % 40) / 100,
      pointerType: 'pen',
      tool: 'fineliner',
      version: '2026.9.1',
      platform: 'linux',
      pageW: 1544 + (index % 3),
      pageH: 1800 + (index % 5),
      padX: 108,
      padY: 144,
      camX: 108,
      camY: 144,
      grew: index % 17 === 0,
      jump: index % 29 === 0,
    }), now)
  }
  const maxRequest = buildBugReportRequest({
    description: 'x'.repeat(2000),
    events: fullLog.snapshot(now),
    version: '2026.9.1',
    platform: 'linux',
    now,
  })
  const encoded = Buffer.byteLength(JSON.stringify(maxRequest.body), 'utf8')
  assert.equal(maxRequest.body.events.length, BUG_REPORT_MAX_EVENTS)
  assert.ok(encoded < BUG_REPORT_MAX_BODY_BYTES, `max-window payload ${encoded} must stay under ${BUG_REPORT_MAX_BODY_BYTES}`)
  assert.equal(BUG_REPORT_MAX_BODY_BYTES, handlerMaxBody)
  const maxAccepted = acceptBugReportPayload(maxRequest.body)
  assert.equal(maxAccepted.ok, true)
  assert.equal(maxAccepted.report.events.length, BUG_REPORT_MAX_EVENTS)
  assert.ok(maxAccepted.report.events.some((event) => event.grew === true && event.pageH > 0))

  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  const paperGrow = readFileSync(join(root, 'src/lib/paperGrow.ts'), 'utf8')
  const bugReport = readFileSync(join(root, 'src/lib/bugReport.ts'), 'utf8')
  const handler = readFileSync(join(root, '../fanotes-site/bug-report-api.mjs'), 'utf8')
  const appendAt = board.indexOf('const appendPointerEvent = useCallback')
  assert.ok(appendAt >= 0)
  const liveAt = board.indexOf('continueLiveWriteStroke(', appendAt)
  const recordAt = board.indexOf('buildPenDiagnosticEvent(', appendAt)
  assert.ok(liveAt > appendAt, 'appendPointerEvent must call continueLiveWriteStroke')
  assert.ok(recordAt > liveAt, 'pen diagnostics must follow the live write helper')
  assert.match(paperGrow, /export const continueLiveWriteStroke/)
  assert.match(paperGrow, /remapSampleThroughStaleLayout/)
  assert.match(paperGrow, /continueStrokeAfterExtentGrow\(/)
  assert.match(bugReport, /export const buildPenDiagnosticEvent/)
  assert.match(bugReport, /pageW/)
  assert.match(handler, /pageW: finiteLayout\(raw\.pageW\)/)
  assert.match(handler, /padX: finiteLayout\(raw\.padX\)/)
  assert.match(handler, /camX: finiteLayout\(raw\.camX\)/)
  assert.match(handler, /grew: raw\.grew === true/)
  assert.match(handler, /jump: raw\.jump === true/)
  assert.match(readFileSync(fileURLToPath(import.meta.url), 'utf8'), /REPORT_1788158126376/)
  assert.doesNotMatch(readFileSync(fileURLToPath(import.meta.url), 'utf8'), /CORNERS\['top-left'\]/)

  return {
    points: driven.points,
    grows: driven.grows,
    firstPadY: driven.firstPadY,
    naiveSkips: driven.naiveSkips,
    lastY: driven.lastY,
    pageH: driven.pageH,
    visualTextY: driven.visualTextY,
    visualInkY: driven.visualInkY,
    stored: stored.length,
    maxBytes: encoded,
    limit: BUG_REPORT_MAX_BODY_BYTES,
    sampleMs: BUG_REPORT_PEN_SAMPLE_MS,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('paint-jump ok')
} finally {
  await server.close()
}
