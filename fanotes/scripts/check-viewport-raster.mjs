// Viewport raster (Milestone 3): fanotes-raster tiles behind a DrawingBoard flag.
// Runs without the flag: it drives the wasm scene directly and checks that the
// board loads it only when the flag is on, with the slice bitmap left in place.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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

const raster = await server.ssrLoadModule('/src/lib/viewportRaster.ts')
const { placeViewportRaster, viewportRasterShift, viewportRasterViewOf } = await server.ssrLoadModule('/src/lib/viewportRasterPlan.ts')
const { VIEWPORT_RASTER_STORAGE_KEY } = await server.ssrLoadModule('/src/lib/viewportRasterFlag.ts')
const { opaqueInkStats } = await server.ssrLoadModule('/src/lib/inkStrokePaint.ts')

const pen = (points, extra = {}) => ({
  points: points.map(([x, y]) => ({ x, y, pressure: 0.5 })),
  baseWidth: 3.5,
  pressureEnabled: true,
  color: '#202333',
  purpose: 'handwriting',
  ...extra,
})

const runOnce = () => {
  assert.equal(raster.viewportRasterTilePx(), 512)
  assert.equal(raster.viewportRasterTileBudget(), 64)
  for (const [zoom, bucket] of [[0.5, 1], [1, 1], [1.17, 1], [1.2, 2], [2, 2], [2.35, 2], [2.4, 4], [3, 4], [4.7, 4], [5, null], [6, null], [0.4, null]]) {
    assert.equal(raster.viewportRasterBucket(zoom), bucket, `zoom ${zoom}`)
  }

  // Tiles: a 2400 × 2400 page at 1× is a 5 × 5 grid of 512 px tiles.
  const near = pen([[0.02, 0.02], [0.05, 0.04], [0.08, 0.05]])
  const far = pen([[0.8, 0.85], [0.85, 0.88], [0.9, 0.9]])
  const scene = raster.createViewportRaster()
  const page = { scale: 1, dpr: 1, originX: 0, originY: 0, width: 2400, height: 2400 }
  const full = { x: 0, y: 0, width: 2400, height: 2400 }
  try {
    assert.equal(scene.setScene(2400, 2400, 0.5, [near, far]), true)
    assert.deepEqual(scene.dirtyRegion(page), full, 'a new page is dirty everywhere')
    const first = scene.paint(page, full)
    assert.equal(first.data.length, 2400 * 2400 * 4)
    assert.equal(scene.lastBucket(), 1)
    assert.equal(scene.lastTilesRendered(), 25)
    assert.equal(scene.tileCount(), 25)
    scene.clearDirty()

    // Revisit (scroll back, zoom settle at the same bucket): no tile rasterises.
    scene.paint({ ...page, originX: 512, originY: 512, width: 1024, height: 1024 }, { x: 0, y: 0, width: 1024, height: 1024 })
    assert.equal(scene.lastTilesRendered(), 0, 'cached tiles serve a revisit')

    // Erase: only the erased stroke's tile and region repaint.
    assert.equal(scene.setScene(2400, 2400, 0.5, [far]), true)
    const dirty = scene.dirtyRegion(page)
    assert.ok(dirty && dirty.x + dirty.width < 512 && dirty.y + dirty.height < 512, `erase dirties only its own area, got ${JSON.stringify(dirty)}`)
    const repaint = scene.paint(page, dirty)
    assert.equal(scene.lastTilesRendered(), 1)
    assert.equal(opaqueInkStats(repaint).opaque, 0, 'the erased stroke is gone from its region')
    scene.clearDirty()

    // Unchanged page: nothing to repaint.
    assert.equal(scene.setScene(2400, 2400, 0.5, [far]), false)
    assert.equal(scene.dirtyRegion(page), null)

    // Undo brings the stroke back in the same region.
    assert.equal(scene.setScene(2400, 2400, 0.5, [near, far]), true)
    const back = scene.paint(page, scene.dirtyRegion(page))
    assert.ok(opaqueInkStats(back).opaque > 0)
    scene.clearDirty()

    // Append (pen lift): painted onto the cached tile, no tile rasterises.
    const appended = pen([[0.45, 0.45], [0.46, 0.47], [0.47, 0.48]])
    assert.equal(scene.setScene(2400, 2400, 0.5, [near, far, appended]), true)
    const appendRegion = scene.dirtyRegion(page)
    assert.ok(appendRegion.width < 200 && appendRegion.height < 200, JSON.stringify(appendRegion))
    const appendedPixels = scene.paint(page, appendRegion)
    assert.equal(scene.lastTilesRendered(), 0)
    assert.ok(opaqueInkStats(appendedPixels).opaque > 0)
    scene.clearDirty()

    // A bottom grow remaps 0–1 ink to the same paper pixels: tiles stay.
    const grown = 2400 + 144
    const remap = (stroke) => ({ ...stroke, points: stroke.points.map((point) => ({ ...point, y: point.y * 2400 / grown })) })
    assert.equal(scene.setScene(2400, grown, 0.5, [near, far, appended].map(remap)), false)

    // 500%: painted at the exact device scale, nothing cached.
    const before = scene.tileCount()
    scene.paint({ scale: 10, dpr: 2, originX: 0, originY: 0, width: 600, height: 400 }, { x: 0, y: 0, width: 600, height: 400 })
    assert.equal(scene.lastBucket(), null)
    assert.equal(scene.tileCount(), before)
  } finally {
    scene.dispose()
  }

  // Art stamps and brushes go through the same packed format.
  const star = 'M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9Z'
  const stamp = raster.rasterizeInkStrokes([{
    points: [{ x: 0.5, y: 0.5, pressure: 0.5 }],
    baseWidth: 60,
    pressureEnabled: true,
    color: '#d35400',
    purpose: 'art',
    symbolId: 'star',
    symbolRotation: 20,
  }], 400, 400, { symbols: [{ id: 'star', paths: [star] }] })
  const stampStats = opaqueInkStats(stamp)
  assert.ok(stampStats.opaque > 50 && stampStats.boxW > 40 && stampStats.boxW < 90, `star stamp ${JSON.stringify(stampStats)}`)
  const brushes = ['fineliner', 'pencil', 'marker', 'paintbrush', 'calligraphy', 'highlighter', 'watercolor', 'spray']
  const brushStats = Object.fromEntries(brushes.map((brush) => {
    const image = raster.rasterizeInkStrokes([pen([[0.2, 0.3], [0.4, 0.45], [0.7, 0.62]], {
      purpose: 'art',
      brush,
      baseWidth: 10,
      textureSeed: 7,
    })], 300, 300, { smoothing: 0.5 })
    const stats = opaqueInkStats(image, 8)
    assert.ok(stats.opaque > 20, `${brush} painted ${stats.opaque} px`)
    return [brush, stats.opaque]
  }))

  // Placement: the bitmap is the box at zoom × dpr, snapped to whole px.
  const box = { left: 100.3, top: 820.6, width: 312, height: 208 }
  const placed = placeViewportRaster(box, { width: 900, height: 1273 }, 5, 2)
  assert.equal(placed.scale, 10)
  assert.equal(placed.slice.leftPx, 1003)
  assert.equal(placed.slice.topPx, 8206)
  assert.ok(placed.box.left <= box.left && placed.box.left + placed.box.width >= box.left + box.width - 1e-9)
  assert.equal(placed.slice.width, Math.round(placed.box.width * placed.scale))
  const moved = viewportRasterViewOf(placeViewportRaster({ ...box, left: box.left + 10, top: box.top - 4 }, { width: 900, height: 1273 }, 5, 2))
  const shift = viewportRasterShift(viewportRasterViewOf(placed), moved)
  assert.deepEqual([shift.dx, shift.dy], [-100, 40])
  assert.deepEqual(shift.regions, [
    { x: moved.width - 100, y: 0, width: 100, height: moved.height },
    { x: 0, y: 0, width: moved.width, height: 40 },
  ])
  assert.equal(viewportRasterShift(viewportRasterViewOf(placed), viewportRasterViewOf(placeViewportRaster(box, { width: 900, height: 1273 }, 4, 2))), null, 'a zoom change repaints the box')
  const rotated = placeViewportRaster(null, { width: 900, height: 1273 }, 6, 4)
  assert.ok(rotated.slice.width * rotated.slice.height <= 48_000_000, 'the whole-sheet fallback keeps the pixel budget')

  // DrawingBoard wiring.
  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  const paint = readFileSync(join(root, 'src/lib/inkStrokePaint.ts'), 'utf8')
  const flag = readFileSync(join(root, 'src/lib/viewportRasterFlag.ts'), 'utf8')
  assert.match(flag, /VITE_FANOTES_VIEWPORT_RASTER === '1'/)
  assert.equal(VIEWPORT_RASTER_STORAGE_KEY, 'fanotes.viewport-raster')
  assert.match(board, /if \(!inline \|\| !viewportRasterEnabled\(\)\) return undefined/)
  assert.match(board, /import\('\.\.\/lib\/viewportRaster'\)/)
  assert.match(board, /import type \{ ViewportRaster \} from '\.\.\/lib\/viewportRaster'/)
  assert.doesNotMatch(board, /import \{[^}]*\} from '\.\.\/lib\/viewportRaster'/, 'the wasm module stays out of the main bundle')
  assert.doesNotMatch(paint, /viewportRaster/, 'the canvas painter does not pull in the raster')
  assert.match(board, /if \(inline && viewportRasterRef\.current\) \{\n      redrawViewportRaster\(layoutWidth, layoutHeight, measureLayout\)\n      return\n    \}/)
  assert.match(board, /createViewportRaster\(ART_SYMBOLS\)/)
  assert.match(board, /if \(viewportRasterRef\.current\) \{\n      \/\/ Viewport raster: no vertical slice, one box for both layers\./)
  assert.match(board, /shiftCanvasBitmap\(canvas, shift\.dx, shift\.dy\)/)
  assert.match(board, /viewportPaintedRef\.current = null\n      scheduleRedraw\(\)/, 'a restored GPU context repaints the viewport bitmap')
  // The slice bitmap is the flag-off path and stays complete.
  assert.ok(existsSync(join(root, 'src/lib/inkWindowPlan.ts')))
  assert.match(board, /planInkWindow\(\{/)
  assert.match(board, /placeInkWindow\(layoutWindow, layoutHeight, nextSize\.height\)/)
  assert.match(board, /shiftInkWindowBitmap\(committedCanvas, shift\.dy\)/)
  assert.match(board, /renderDocument\(\s*committedCanvas,\s*strokesRef\.current/)

  return { brushStats, stamp: stampStats.opaque }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('viewport-raster ok')
} finally {
  await server.close()
}
