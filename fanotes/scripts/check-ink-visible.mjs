import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  INK_MIN_BITMAP_PX,
  createInkReadbackContext,
  drawInkStroke,
  inkStrokeBitmapWidth,
  opaqueInkStats,
  paintMarkdownNoteStiftStroke,
  paintVisibleInkSample,
} = await server.ssrLoadModule('/src/lib/inkStrokePaint.ts')
const { inkStrokePaintScale } = await server.ssrLoadModule('/src/lib/paperGrow.ts')
const { inkBlockedMarkdownSelectors, markdownNoteInkOverlaySize, pointerEventsForInkLayer } = await server.ssrLoadModule('/src/lib/pdfInkHit.ts')
const { viewportRasterEnabled } = await server.ssrLoadModule('/src/lib/viewportRasterFlag.ts')
const viewportRaster = viewportRasterEnabled() ? await server.ssrLoadModule('/src/lib/viewportRaster.ts') : null
const rasterize = viewportRaster
  ? (stroke, width, height, layoutWidth) => viewportRaster.rasterizeInkStrokes([stroke], width, height, { layoutWidth })
  : null

const runOnce = () => {
  assert.equal(pointerEventsForInkLayer('markdown', true), 'none')
  assert.equal(pointerEventsForInkLayer('overlay', true), 'auto')
  const collapsed = markdownNoteInkOverlaySize({ width: 0, height: 0 }, { width: 900, height: 1273 })
  assert.ok(collapsed.width >= 900 - 1, '0×0 overlay must cover the write page')
  assert.ok(collapsed.height >= 1273 - 1)
  assert.equal(markdownNoteInkOverlaySize({ width: 0, height: 0 }, { width: 0, height: 0 }).width, 0)

  const mapped = paintVisibleInkSample()
  assert.ok(mapped.overlayWidth >= 8 && mapped.overlayHeight >= 8, `markdown overlay stayed 0×0 (${mapped.overlayWidth}x${mapped.overlayHeight})`)
  assert.ok(mapped.bitmapWidth >= 8 && mapped.bitmapHeight >= 8, `bitmap stayed 0 (${mapped.bitmapWidth}x${mapped.bitmapHeight})`)
  assert.ok(mapped.points >= 3, `mapped markdown stroke must keep real samples after a ghost 0,0 down, got ${mapped.points}`)
  assert.ok(mapped.opaque > 0, `shipped paint produced no opaque pixels (${mapped.opaque})`)
  assert.ok(mapped.area >= 16, `stroke bounding box must be a visible line, got ${mapped.boxW}x${mapped.boxH}`)
  assert.ok(mapped.boxW >= 4 && mapped.boxH >= 4, `stroke collapsed to a hairline ${mapped.boxW}x${mapped.boxH}`)

  const emptyOverlay = paintMarkdownNoteStiftStroke({
    overlay: { left: 10, top: 10, width: 0, height: 0 },
    paper: { width: 0, height: 0 },
    events: [{ type: 'pointerdown', clientX: 80, clientY: 90, pressure: 0.5, pointerType: 'pen', timeStamp: 1 }],
  })
  assert.equal(emptyOverlay.opaque, 0, 'no Blatt and no overlay must not invent a line')
  assert.equal(emptyOverlay.overlayWidth, 0)

  const absorbed = createInkReadbackContext(560, 560)
  drawInkStroke(
    absorbed.context,
    {
      points: [
        { x: 0.2, y: 0.25, pressure: 0.55 },
        { x: 0.55, y: 0.48, pressure: 0.6 },
        { x: 0.72, y: 0.62, pressure: 0.5 },
      ],
      baseWidth: 3.5,
      pressureEnabled: true,
      color: '#202333',
      purpose: 'handwriting',
      brush: 'fineliner',
      colorEffect: 'solid',
      opacity: 1,
    },
    560,
    560,
    0,
    1,
    2020,
    560,
  )
  const absorbedStats = opaqueInkStats(absorbed.getImageData())
  assert.ok(absorbedStats.opaque > 0, 'absorbed one-canvas note must still paint a visible pen')
  assert.ok(absorbedStats.area >= 16, `absorbed note stroke was a hairline ${absorbedStats.boxW}x${absorbedStats.boxH}`)

  const blank = createInkReadbackContext(200, 200)
  drawInkStroke(
    blank.context,
    {
      points: [],
      baseWidth: 3.5,
      color: '#202333',
      purpose: 'handwriting',
    },
    200,
    200,
    0,
    1,
    200,
    200,
  )
  assert.equal(opaqueInkStats(blank.getImageData()).opaque, 0, 'empty stroke must not invent pixels')

  assert.equal(INK_MIN_BITMAP_PX, 1)
  assert.ok(inkStrokeBitmapWidth({ baseWidth: 3.5, pressureEnabled: false }, 0.5, 0.2) >= 1)
  assert.ok(Math.abs(inkStrokePaintScale(560, 560) - 1) < 1e-6)

  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  for (const selector of inkBlockedMarkdownSelectors) {
    assert.ok(css.includes(selector), `missing ${selector}`)
  }
  assert.match(
    css,
    /\.unified-note-view\.is-inking \.editor-pane,[\s\S]{0,520}pointer-events:\s*none/,
    'Stift mode must let markdown layers pass the pen to the overlay',
  )
  assert.match(board, /\.lw-drawing-board\.is-inline\.is-input-active\{[^}]*pointer-events:\s*auto/)
  assert.match(board, /onPointerDown=\{inline && overlayHitEnabled\(inputActive\) \? handlePointerDown : undefined\}/)
  assert.match(board, /\.lw-drawing-board\.is-inline:not\(\.is-input-active\),[^}]*pointer-events:none!important/)
  assert.match(board, /from '\.\.\/lib\/inkStrokePaint'/)
  assert.match(board, /markdownNoteInkOverlaySize/)

  let raster = null
  if (rasterize) {
    // Flag on: the same mapped samples painted by the Rust viewport raster.
    const rasterMapped = paintVisibleInkSample(rasterize)
    assert.equal(rasterMapped.points, mapped.points, 'both painters see the same samples')
    assert.ok(rasterMapped.opaque > 0, `viewport raster produced no opaque pixels (${rasterMapped.opaque})`)
    assert.ok(rasterMapped.area >= 16, `viewport raster stroke must be a visible line, got ${rasterMapped.boxW}x${rasterMapped.boxH}`)
    assert.ok(rasterMapped.boxW >= 4 && rasterMapped.boxH >= 4, `viewport raster stroke collapsed to ${rasterMapped.boxW}x${rasterMapped.boxH}`)
    assert.ok(Math.abs(rasterMapped.boxW - mapped.boxW) <= 4 && Math.abs(rasterMapped.boxH - mapped.boxH) <= 4, `the raster footprint ${rasterMapped.boxW}x${rasterMapped.boxH} must match the canvas footprint ${mapped.boxW}x${mapped.boxH}`)
    const rasterEmpty = paintMarkdownNoteStiftStroke({
      overlay: { left: 10, top: 10, width: 0, height: 0 },
      paper: { width: 0, height: 0 },
      events: [{ type: 'pointerdown', clientX: 80, clientY: 90, pressure: 0.5, pointerType: 'pen', timeStamp: 1 }],
      rasterize,
    })
    assert.equal(rasterEmpty.opaque, 0, 'no Blatt and no overlay must not invent a line on the raster either')
    const rasterAbsorbed = opaqueInkStats(rasterize({
      points: [
        { x: 0.2, y: 0.25, pressure: 0.55 },
        { x: 0.55, y: 0.48, pressure: 0.6 },
        { x: 0.72, y: 0.62, pressure: 0.5 },
      ],
      baseWidth: 3.5,
      pressureEnabled: true,
      color: '#202333',
      purpose: 'handwriting',
      brush: 'fineliner',
      colorEffect: 'solid',
      opacity: 1,
    }, 560, 560, 560))
    assert.ok(rasterAbsorbed.opaque > 0, 'absorbed one-canvas note must still paint a visible pen on the raster')
    assert.ok(rasterAbsorbed.area >= 16, `absorbed raster stroke was a hairline ${rasterAbsorbed.boxW}x${rasterAbsorbed.boxH}`)
    const rasterBlank = opaqueInkStats(rasterize({ points: [], baseWidth: 3.5, color: '#202333', purpose: 'handwriting' }, 200, 200, 200))
    assert.equal(rasterBlank.opaque, 0, 'empty stroke must not invent pixels on the raster')
    raster = { opaque: rasterMapped.opaque, boxW: rasterMapped.boxW, boxH: rasterMapped.boxH, absorbedOpaque: rasterAbsorbed.opaque }
  }

  return {
    overlayWidth: mapped.overlayWidth,
    overlayHeight: mapped.overlayHeight,
    points: mapped.points,
    opaque: mapped.opaque,
    boxW: mapped.boxW,
    boxH: mapped.boxH,
    absorbedOpaque: absorbedStats.opaque,
    ...(raster ? { raster } : {}),
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('ink-visible ok')
} finally {
  await server.close()
}
