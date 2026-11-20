import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { applyToolErase, strokeTouchesEraser } = await server.ssrLoadModule('/src/lib/toolErase.ts')
const {
  clearMarkerCoverageRect,
  createMarkerCoverage,
  inkStrokePaintMargin,
  removedStrokeBitmapPatch,
  unionBitmapPatch,
} = await server.ssrLoadModule('/src/lib/inkStrokePaint.ts')
const { readSavedInkStrokes } = await server.ssrLoadModule('/src/lib/inkDocument.ts')
const { savedInkPage, keepMarkOnPage } = await server.ssrLoadModule('/src/lib/noteCanvas.ts')
const {
  adoptPaintedInkPage,
  GROW_STEP_Y,
  WRITE_CAP_HEIGHT,
  textGrowPageHeight,
  textTypingRoomHeight,
  textAbsorbTargetHeight,
} = await server.ssrLoadModule('/src/lib/paperGrow.ts')

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 1273
const RADIUS = 16

const point = (x, y) => ({ x, y, t: 0, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' })
const px = (x) => x / SOURCE_WIDTH
const py = (y) => y / SOURCE_HEIGHT
const polyline = (coords, extras = {}) => ({
  points: coords.map(([x, y]) => point(x, y)),
  baseWidth: 4,
  pressureEnabled: true,
  color: '#191c24',
  purpose: 'handwriting',
  ...extras,
})
const idsOf = (strokes) => strokes.map((stroke) => stroke.id)
const hasPointNear = (stroke, x, y, slack = 4) => stroke.points.some((entry) => (
  Math.hypot(entry.x * SOURCE_WIDTH - x, entry.y * SOURCE_HEIGHT - y) <= slack
))

try {
  const handwriting = polyline([[0.2, 0.25], [0.28, 0.25], [0.36, 0.25]], { id: 'handwriting' })
  const neighbor = polyline([[0.72, 0.25], [0.8, 0.25], [0.88, 0.25]], { id: 'neighbor' })
  const symbol = polyline([[0.25, 0.62]], { id: 'symbol', baseWidth: 36, purpose: 'art', symbolId: 'star' })
  const start = [handwriting, neighbor, symbol]

  assert.equal(start.length, 3, 'the check starts from the mixed list, not a pre-filtered one')
  assert.equal(
    strokeTouchesEraser(handwriting, 0.28 * SOURCE_WIDTH, 0.25 * SOURCE_HEIGHT, RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT),
    true,
    'eraser on the handwriting path must hit that stroke',
  )
  assert.equal(
    strokeTouchesEraser(neighbor, 0.28 * SOURCE_WIDTH, 0.25 * SOURCE_HEIGHT, RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT),
    false,
    'the nearby polyline must not intersect the handwriting hit',
  )
  assert.equal(
    strokeTouchesEraser(symbol, 0.25 * SOURCE_WIDTH, 0.62 * SOURCE_HEIGHT, RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT),
    true,
    'eraser on a one-point pictogram must hit the symbol disk',
  )

  const corner = polyline([[px(100), py(200)], [px(100), py(300)], [px(200), py(300)]], { id: 'corner' })
  assert.equal(
    strokeTouchesEraser(corner, 200, 200, RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT),
    false,
    'an empty corner of the bounding box is not a hit',
  )

  const afterHits = applyToolErase(
    start,
    [{ x: 0.28, y: 0.25 }, { x: 0.25, y: 0.62 }],
    RADIUS,
    SOURCE_WIDTH,
    SOURCE_HEIGHT,
  )
  assert.equal(afterHits.includes(symbol), false, 'a touched pictogram is removed whole')
  assert.equal(afterHits.includes(neighbor), true, 'the untouched line stays in the list')
  assert.equal(afterHits.find((stroke) => stroke.id === 'neighbor'), neighbor, 'the nearby stroke is the same object, not a rebuilt copy')
  const remnants = afterHits.filter((stroke) => stroke.id === 'handwriting')
  assert.ok(remnants.length >= 1, 'a long line keeps the ink the eraser did not cover')
  assert.equal(remnants.some((stroke) => hasPointNear(stroke, 0.28 * SOURCE_WIDTH, 0.25 * SOURCE_HEIGHT, 2)), false, 'the touched middle of the line is gone')
  assert.equal(remnants.some((stroke) => hasPointNear(stroke, 0.2 * SOURCE_WIDTH, 0.25 * SOURCE_HEIGHT, 2)), true, 'the untouched start of the line stays')
  assert.equal(remnants.some((stroke) => hasPointNear(stroke, 0.36 * SOURCE_WIDTH, 0.25 * SOURCE_HEIGHT, 2)), true, 'the untouched end of the line stays')

  const afterMiss = applyToolErase(start, [{ x: 0.5, y: 0.82 }], RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(afterMiss, start, 'a miss on empty paper leaves the original list unchanged')
  assert.equal(afterMiss.length, 3)
  assert.deepEqual(idsOf(afterMiss), ['handwriting', 'neighbor', 'symbol'])

  const afterEmpty = applyToolErase(start, [], RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(afterEmpty, start, 'no samples must not filter the list')

  const leftLetter = polyline([
    [px(100), py(220)],
    [px(100), py(300)],
    [px(140), py(230)],
    [px(170), py(300)],
  ], { id: 'left' })
  const rightLetter = polyline([
    [px(280), py(220)],
    [px(280), py(300)],
    [px(320), py(230)],
    [px(350), py(300)],
  ], { id: 'right' })
  const pair = [leftLetter, rightLetter]
  const erasedLeft = applyToolErase(pair, [{ x: px(130), y: py(260) }], RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(erasedLeft.includes(rightLetter), true, 'the letter that was not touched stays the same object')
  assert.equal(erasedLeft.some((stroke) => stroke.id === 'left' && hasPointNear(stroke, 130, 260, 2)), false, 'the touched spot of the letter is gone')
  assert.equal(erasedLeft.some((stroke) => stroke.id === 'left' && hasPointNear(stroke, 100, 220, 2)), true, 'the far end of the letter stays (erasing is local)')

  const nearMiss = applyToolErase(pair, [{ x: px(100), y: py(220 - 30) }], RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(nearMiss, pair, 'passing beside the ink does not delete the letter')

  const word = polyline([
    [px(120), py(220)],
    [px(120), py(300)],
    [px(155), py(230)],
    [px(190), py(300)],
    [px(230), py(298)],
    [px(270), py(300)],
    [px(305), py(230)],
    [px(340), py(300)],
    [px(340), py(220)],
  ], { id: 'word' })
  const erasedWord = applyToolErase([word, rightLetter], [{ x: px(140), y: py(260) }], RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(erasedWord.includes(rightLetter), true, 'a separate neighbour is untouched')
  const wordParts = erasedWord.filter((stroke) => stroke.id === 'word')
  assert.ok(wordParts.length >= 1, 'the rest of the connected word stays')
  assert.equal(wordParts.some((stroke) => hasPointNear(stroke, 140, 260, 4)), false, 'the touched spot of the word is gone')
  assert.equal(wordParts.some((stroke) => hasPointNear(stroke, 320, 250, 30)), true, 'the connected letter that was not touched stays')

  const stem = polyline([[px(100), py(230)], [px(100), py(310)]], { id: 'stem' })
  const dot = polyline([[px(96), py(198)], [px(104), py(198)]], { id: 'dot' })
  const other = polyline([[px(220), py(230)], [px(220), py(310)]], { id: 'other' })
  const eyed = [stem, dot, other]
  const erasedStem = applyToolErase(eyed, [{ x: px(100), y: py(270) }], RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(erasedStem.includes(dot), true, 'touching the stem leaves the dot (local erase)')
  assert.equal(erasedStem.includes(other), true)
  assert.equal(erasedStem.some((stroke) => stroke.id === 'stem' && hasPointNear(stroke, 100, 270, 2)), false)
  const erasedDot = applyToolErase(eyed, [{ x: px(100), y: py(198) }], RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(erasedDot.includes(stem), true, 'touching the dot leaves the stem')
  assert.equal(erasedDot.some((stroke) => stroke.id === 'dot'), false, 'the touched dot is gone')

  const wideM = polyline([
    [px(100), py(300)],
    [px(100), py(220)],
    [px(150), py(300)],
    [px(200), py(220)],
    [px(250), py(300)],
  ], { id: 'em' })
  const afterM = applyToolErase([wideM, rightLetter], [{ x: px(100), y: py(260) }], RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(afterM.some((stroke) => stroke.id === 'em' && hasPointNear(stroke, 100, 260, 2)), false, 'the touched part of a wide letter is gone')
  assert.equal(afterM.some((stroke) => stroke.id === 'em' && hasPointNear(stroke, 250, 300, 2)), true, 'the far end of a wide letter stays')
  assert.equal(afterM.includes(rightLetter), true)

  const underline = polyline([
    [px(40), py(420)],
    [px(120), py(420)],
    [px(200), py(420)],
    [px(280), py(420)],
    [px(360), py(420)],
  ], { id: 'line' })
  const erasedLine = applyToolErase([underline], [{ x: px(200), y: py(420) }], RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT)
  const lineParts = erasedLine.filter((stroke) => stroke.id === 'line')
  assert.equal(lineParts.some((stroke) => hasPointNear(stroke, 200, 420, 2)), false, 'the underline loses only the touched span')
  assert.equal(lineParts.some((stroke) => hasPointNear(stroke, 40, 420, 2)), true, 'the underline keeps its untouched start')
  assert.equal(lineParts.some((stroke) => hasPointNear(stroke, 360, 420, 2)), true, 'the underline keeps its untouched end')

  const paintMargin = (stroke) => inkStrokePaintMargin(stroke, 1)
  const underlinePatch = removedStrokeBitmapPatch([underline], erasedLine, SOURCE_WIDTH, SOURCE_HEIGHT, paintMargin)
  assert.ok(underlinePatch, 'erasing the middle of a line dirties a box')
  assert.ok(underlinePatch.x0 > 40, 'the kept start of the line is outside the cleared box')
  assert.ok(underlinePatch.x1 < 360, 'the kept end of the line is outside the cleared box')
  assert.ok(underlinePatch.x0 < 200 && underlinePatch.x1 > 200, 'the erased span is inside the cleared box')
  assert.ok(underlinePatch.x1 - underlinePatch.x0 < SOURCE_WIDTH / 2, 'the cleared box is the gap, not the page')
  const letterPatch = removedStrokeBitmapPatch(pair, erasedLeft, SOURCE_WIDTH, SOURCE_HEIGHT, paintMargin)
  assert.ok(letterPatch, 'a removed letter dirties its own box')
  assert.ok(letterPatch.x1 < 280, 'the untouched letter stays outside the cleared box')
  assert.equal(removedStrokeBitmapPatch(start, start, SOURCE_WIDTH, SOURCE_HEIGHT, paintMargin), null, 'a miss does not dirty the page')
  assert.equal(
    removedStrokeBitmapPatch(start, start.slice(), SOURCE_WIDTH, SOURCE_HEIGHT, paintMargin),
    null,
    'strokes that stayed are not part of the hole',
  )
  assert.deepEqual(
    unionBitmapPatch({ x0: 1, y0: 2, x1: 3, y1: 4 }, { x0: 10, y0: 0, x1: 12, y1: 5 }),
    { x0: 1, y0: 0, x1: 12, y1: 5 },
  )
  const coverage = createMarkerCoverage(8, 4)
  coverage.mask.fill(1)
  clearMarkerCoverageRect(coverage, 2, 1, 3, 2)
  assert.equal(coverage.mask[0], 1, 'rows above the hole stay claimed')
  assert.equal(coverage.mask[8 + 1], 1, 'the column before the hole stays claimed')
  assert.equal(coverage.mask[8 + 2], 0, 'the hole clears the marker mask')
  assert.equal(coverage.mask[16 + 4], 0, 'the hole clears its full rectangle')
  assert.equal(coverage.mask[16 + 5], 1, 'the column after the hole stays claimed')
  assert.equal(coverage.mask[24], 1, 'rows below the hole stay claimed')

  assert.equal(wordParts.some((stroke) => hasPointNear(stroke, 120, 220, 8)), true, 'the stem end outside the eraser stays')

  const fineStem = polyline([[px(100), py(230)], [px(100), py(310)]], { id: 'fine' })
  const fineNeighbor = polyline([[px(130), py(230)], [px(130), py(310)]], { id: 'fine-neighbor' })
  const finePair = [fineStem, fineNeighbor]
  const fineHit = applyToolErase(finePair, [{ x: px(100), y: py(270) }], 1, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(fineHit.some((stroke) => stroke.id === 'fine' && hasPointNear(stroke, 100, 270, 1)), false, 'a 1 px eraser on the ink cuts that spot')
  assert.equal(fineHit.includes(fineNeighbor), true, 'a 1 px eraser leaves the stroke a few pixels away')
  const fineMiss = applyToolErase(finePair, [{ x: px(108), y: py(270) }], 1, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(fineMiss, finePair, 'a 1 px eraser that only passes near the ink deletes nothing')

  const tallStem = polyline([[px(120), py(200)], [px(120), py(320)]], { id: 'tall' })
  const stray = polyline([[px(108), py(400)], [px(132), py(400)]], { id: 'stray' })
  const farLine = polyline([[px(420), py(180)], [px(620), py(180)]], { id: 'far' })
  const separated = applyToolErase(
    [tallStem, stray, farLine],
    [{ x: px(120), y: py(300) }],
    RADIUS,
    SOURCE_WIDTH,
    SOURCE_HEIGHT,
  )
  assert.equal(separated.some((stroke) => stroke.id === 'tall' && hasPointNear(stroke, 120, 300, 2)), false, 'the touched part of the stem is removed')
  assert.equal(separated.includes(stray), true, 'a short line well below the letter stays')
  assert.equal(separated.includes(farLine), true, 'a line elsewhere on the page stays')

  const jumped = polyline([
    [px(80), py(200)],
    [px(80), py(260)],
    [px(700), py(900)],
    [px(780), py(900)],
  ], { id: 'jumped' })
  const quiet = polyline([[px(200), py(500)], [px(400), py(500)]], { id: 'quiet' })
  const afterJump = applyToolErase([jumped, quiet], [{ x: px(80), y: py(230) }], RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(afterJump.includes(quiet), true, 'a stroke that was not touched stays')
  const jumpParts = afterJump.filter((stroke) => stroke.id === 'jumped')
  assert.equal(jumpParts.some((stroke) => hasPointNear(stroke, 80, 230, 8)), false, 'the touched end of a jumped stroke is gone')
  assert.equal(jumpParts.some((stroke) => hasPointNear(stroke, 740, 900, 50)), true, 'the far end of a jumped stroke stays')

  // Reopen: strokes saved as 0–1 of the page, then the sheet is much taller
  // than that page. The old eraser kept the saved page after the layout
  // scale, so a 110 px gap collapsed inside a 16 px disk. The open path
  // adopts the sheet the scale belongs to.
  const boardSource = readFileSync(new URL('../src/components/DrawingBoard.tsx', import.meta.url), 'utf8')
  assert.match(boardSource, /readSavedInkStrokes\(value, fallbackColor/, 'the board opens a drawing with the shared parser')
  assert.match(boardSource, /adoptPaintedInkPage\(\{/, 'reopen catch-up adopts the painted page')
  assert.match(boardSource, /sourceWidthRef\.current = adopted\.pageWidth/, 'catch-up stores the adopted page width')
  assert.match(boardSource, /sourceHeightRef\.current = adopted\.pageHeight/, 'catch-up stores the adopted page height')
  assert.match(
    boardSource,
    /\(eraserMode === 'stroke' \? applyStrokeErase : applyToolErase\)\(\s*strokesRef\.current,\s*samples,\s*eraserSize,\s*sourceWidthRef\.current,\s*sourceHeightRef\.current,/,
    'the eraser multiplies by the page refs catch-up just stored',
  )

  const savedPage = savedInkPage(
    { width: SOURCE_WIDTH, height: SOURCE_HEIGHT },
    { w: SOURCE_WIDTH, h: SOURCE_HEIGHT },
  )
  const sheetHeight = 9000
  const savedLetter = polyline([
    [120 / savedPage.width, 220 / savedPage.height],
    [120 / savedPage.width, 300 / savedPage.height],
    [150 / savedPage.width, 240 / savedPage.height],
    [180 / savedPage.width, 300 / savedPage.height],
  ])
  const savedBelow = polyline([
    [135 / savedPage.width, 380 / savedPage.height],
    [175 / savedPage.width, 380 / savedPage.height],
  ])
  const savedFar = polyline([
    [560 / savedPage.width, 260 / savedPage.height],
    [620 / savedPage.width, 280 / savedPage.height],
    [580 / savedPage.width, 320 / savedPage.height],
  ])
  const savedLine = polyline([
    [40 / savedPage.width, 720 / savedPage.height],
    [200 / savedPage.width, 720 / savedPage.height],
    [400 / savedPage.width, 720 / savedPage.height],
    [700 / savedPage.width, 720 / savedPage.height],
  ])
  const drawing = {
    schemaVersion: 1,
    sourceWidth: savedPage.width,
    sourceHeight: savedPage.height,
    strokes: [savedLetter, savedBelow, savedFar, savedLine],
  }
  const opened = readSavedInkStrokes(JSON.parse(JSON.stringify(drawing)).strokes, '#191c24')
  assert.equal(opened.length, 4, 'the open parser returns every saved stroke')
  assert.ok(Math.abs(opened[0].points[0].x - savedLetter.points[0].x) < 1e-9, 'open keeps the saved 0–1 x')
  assert.ok(Math.abs(opened[1].points[0].y - savedBelow.points[0].y) < 1e-9, 'open keeps the saved 0–1 y')
  const reopenLabels = ['letter', 'below', 'far', 'line']
  opened.forEach((stroke, index) => {
    stroke.id = reopenLabels[index]
  })

  const adopted = adoptPaintedInkPage({
    sourceW: drawing.sourceWidth,
    sourceH: drawing.sourceHeight,
    prevLayoutW: drawing.sourceWidth,
    prevLayoutH: drawing.sourceHeight,
    nextLayoutW: drawing.sourceWidth,
    nextLayoutH: sheetHeight,
  })
  assert.equal(adopted.apply, true, 'a taller sheet rescales the saved page')
  assert.equal(adopted.scaleX, 1, 'a width that did not grow is not rescaled')
  assert.equal(adopted.pageWidth, drawing.sourceWidth)
  assert.equal(adopted.pageHeight, sheetHeight, 'the eraser page is the sheet the strokes were scaled into')
  assert.ok(Math.abs(adopted.scaleY - (drawing.sourceHeight / sheetHeight)) < 1e-9)

  const scaleOpened = (scaleX, scaleY) => opened.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((entry) => ({ ...entry, x: entry.x * scaleX, y: entry.y * scaleY })),
  }))
  const reopened = scaleOpened(adopted.scaleX, adopted.scaleY)
  const onAdopted = (stroke, x, y, slack = 4) => stroke.points.some((entry) => (
    Math.hypot(entry.x * adopted.pageWidth - x, entry.y * adopted.pageHeight - y) <= slack
  ))
  const letterTouch = { x: 135 / adopted.pageWidth, y: 270 / adopted.pageHeight }
  const adoptedGap = Math.hypot(
    (reopened[1].points[0].x - letterTouch.x) * adopted.pageWidth,
    (reopened[1].points[0].y - letterTouch.y) * adopted.pageHeight,
  )
  assert.ok(adoptedGap > RADIUS + 2, 'after reopen the neighbour is still outside the configured range')
  assert.ok(Math.abs(adoptedGap - 110) < 1, 'the 110 px gap survives the open remap')

  const stalePage = scaleOpened(adopted.scaleX, adopted.scaleY)
  const staleHit = applyToolErase(stalePage, [letterTouch], RADIUS, drawing.sourceWidth, drawing.sourceHeight)
  assert.equal(staleHit.some((stroke) => stroke.id === 'below' && stroke.points.some((e) => e.x === stalePage[1].points[0].x && e.y === stalePage[1].points[0].y)), false, 'the saved page after the layout scale deletes the neighbour the disk does not meet')
  const staleGap = Math.hypot(
    (stalePage[1].points[0].x - letterTouch.x) * drawing.sourceWidth,
    (stalePage[1].points[0].y - letterTouch.y) * drawing.sourceHeight,
  )
  assert.ok(staleGap < RADIUS, 'the stale page pulls that neighbour inside the disk')

  const erasedReopen = applyToolErase(reopened, [letterTouch], RADIUS, adopted.pageWidth, adopted.pageHeight)
  const keptBelow = erasedReopen.find((stroke) => stroke.id === 'below')
  const keptFar = erasedReopen.find((stroke) => stroke.id === 'far')
  assert.equal(keptBelow, reopened[1], 'the mark outside the disk stays, and it is the same stroke')
  assert.equal(keptFar, reopened[2], 'a mark far from the touch stays the same stroke')
  assert.equal(erasedReopen.some((stroke) => stroke.id === 'letter' && onAdopted(stroke, 135, 270, 2)), false, 'the ink under the eraser is removed')
  assert.equal(onAdopted(keptBelow, 135, 380), true, 'the neighbour keeps the ink that was saved')

  const lineTouch = { x: 200 / adopted.pageWidth, y: 720 / adopted.pageHeight }
  const erasedSpan = applyToolErase(
    scaleOpened(adopted.scaleX, adopted.scaleY),
    [lineTouch],
    RADIUS,
    adopted.pageWidth,
    adopted.pageHeight,
  )
  const spanParts = erasedSpan.filter((stroke) => stroke.id === 'line')
  assert.equal(spanParts.some((stroke) => onAdopted(stroke, 200, 720, 2)), false, 'a reopened line loses only the covered span')
  assert.equal(spanParts.some((stroke) => onAdopted(stroke, 40, 720, 2)), true, 'the uncovered start of a reopened line stays')
  assert.equal(spanParts.some((stroke) => onAdopted(stroke, 700, 720, 2)), true, 'the uncovered end of a reopened line stays')
  assert.equal(erasedSpan.some((stroke) => stroke.id === 'far'), true, 'a partial erase does not remove a distant mark')
  assert.equal(erasedSpan.some((stroke) => stroke.id === 'below'), true, 'a partial erase does not remove the other mark')

  const missed = scaleOpened(adopted.scaleX, adopted.scaleY)
  const missSample = { x: 120 / adopted.pageWidth, y: 180 / adopted.pageHeight }
  assert.ok(
    Math.abs((220 / savedPage.height) * adopted.scaleY * adopted.pageHeight - 220) < 1,
    'the top of the opened letter is still 40 px under the miss',
  )
  const afterReopenMiss = applyToolErase(missed, [missSample], RADIUS, adopted.pageWidth, adopted.pageHeight)
  assert.equal(afterReopenMiss, missed, 'a touch farther than the configured range leaves the opened handwriting unchanged')
  const staleMissed = scaleOpened(adopted.scaleX, adopted.scaleY)
  const staleMiss = applyToolErase(
    staleMissed,
    [missSample],
    RADIUS,
    drawing.sourceWidth,
    drawing.sourceHeight,
  )
  assert.notEqual(staleMiss, staleMissed, 'the same miss deletes ink when the page is still the saved one')
  const staleTopY = 220 * drawing.sourceHeight / sheetHeight
  const staleLetterKeepsTop = staleMiss.some((stroke) => stroke.id === 'letter' && stroke.points.some((entry) => (
    Math.hypot(entry.x * drawing.sourceWidth - 120, entry.y * drawing.sourceHeight - staleTopY) <= 3
  )))
  assert.equal(staleLetterKeepsTop, false, 'the stale page treats a 40 px miss as a hit on the letter')

  const absorbedY = keepMarkOnPage(380 / savedPage.height, savedPage.height, sheetHeight, 0)
  assert.ok(Math.abs(absorbedY * sheetHeight - 380) < 0.05, 'absorbing the sheet keeps the pixel')
  const afterAbsorb = adoptPaintedInkPage({
    sourceW: savedPage.width,
    sourceH: sheetHeight,
    prevLayoutW: savedPage.width,
    prevLayoutH: savedPage.height,
    nextLayoutW: savedPage.width,
    nextLayoutH: sheetHeight,
  })
  assert.equal(afterAbsorb.apply, false, 'a page absorb already grew does not scale again')
  assert.equal(afterAbsorb.scaleY, 1)
  assert.equal(afterAbsorb.pageHeight, sheetHeight)

  // Typing used to resize the sheet on every line, and the catch-up then
  // rescaled every ink point. One write step of room absorbs the next lines.
  assert.equal(GROW_STEP_Y, 144)
  const line = 28
  const typing = {
    paintedWidth: 900,
    prevLayoutWidth: 900,
    keyboard: true,
    activeStroke: false,
    pendingGrow: false,
    pdfOrWorksheet: false,
  }
  assert.equal(textGrowPageHeight(400, 144), 400 + GROW_STEP_Y)
  assert.equal(textGrowPageHeight(400, 400 + GROW_STEP_Y), 400 + GROW_STEP_Y, 'a full step of room is not grown again')
  assert.equal(textGrowPageHeight(0, 144), 144)
  assert.equal(textGrowPageHeight(0, 0), 0)
  assert.equal(textGrowPageHeight(WRITE_CAP_HEIGHT - 10, WRITE_CAP_HEIGHT - 10), WRITE_CAP_HEIGHT)
  assert.equal(textGrowPageHeight(WRITE_CAP_HEIGHT, 100), WRITE_CAP_HEIGHT)
  const firstPainted = 400 + line
  const room = textTypingRoomHeight({
    ...typing,
    paintedHeight: firstPainted,
    sourceHeight: 400,
    prevLayoutHeight: 400,
  })
  assert.equal(room, firstPainted + GROW_STEP_Y, 'the first line that overflows reserves one write step')
  const reserved = adoptPaintedInkPage({
    sourceW: 900,
    sourceH: 400,
    prevLayoutW: 900,
    prevLayoutH: 400,
    nextLayoutW: 900,
    nextLayoutH: room,
  })
  assert.equal(reserved.apply, true, 'ink scales once onto the reserved sheet')
  assert.equal(reserved.scaleX, 1)
  assert.equal(reserved.pageHeight, room, 'the eraser page is that reserved sheet')
  for (let extra = 1; extra <= 4; extra += 1) {
    const content = firstPainted + line * extra
    assert.ok(content < room, `line ${extra} stays inside the reserved sheet`)
    assert.equal(textTypingRoomHeight({
      ...typing,
      paintedHeight: room,
      sourceHeight: room,
      prevLayoutHeight: room,
    }), null, 'a line inside the room does not ask for another scale')
  }
  const overflow = room + line
  const nextRoom = textTypingRoomHeight({
    ...typing,
    paintedHeight: overflow,
    sourceHeight: room,
    prevLayoutHeight: room,
  })
  assert.equal(nextRoom, overflow + GROW_STEP_Y, 'a filled room reserves one more step')
  const reservedAgain = adoptPaintedInkPage({
    sourceW: 900,
    sourceH: room,
    prevLayoutW: 900,
    prevLayoutH: room,
    nextLayoutW: 900,
    nextLayoutH: nextRoom,
  })
  assert.equal(reservedAgain.apply, true)
  assert.equal(reservedAgain.pageHeight, nextRoom)
  assert.equal(textTypingRoomHeight({
    ...typing,
    paintedHeight: firstPainted,
    sourceHeight: 400,
    prevLayoutHeight: 400,
    keyboard: false,
  }), null, 'the pen does not reserve typing room')
  assert.equal(textTypingRoomHeight({
    ...typing,
    paintedHeight: firstPainted,
    sourceHeight: 400,
    prevLayoutHeight: 400,
    activeStroke: true,
  }), null)
  assert.equal(textTypingRoomHeight({
    ...typing,
    paintedHeight: firstPainted,
    sourceHeight: 400,
    prevLayoutHeight: 400,
    pendingGrow: true,
  }), null)
  assert.equal(textTypingRoomHeight({
    ...typing,
    paintedHeight: firstPainted,
    sourceHeight: 400,
    prevLayoutHeight: 400,
    pdfOrWorksheet: true,
  }), null)
  assert.equal(textTypingRoomHeight({
    ...typing,
    paintedHeight: firstPainted,
    sourceHeight: 400,
    prevLayoutHeight: 400,
    paintedWidth: 1000,
  }), null, 'a sideways grow is not a typing line')
  assert.equal(textTypingRoomHeight({
    ...typing,
    paintedHeight: room,
    sourceHeight: room,
    prevLayoutHeight: 400,
  }), null, 'a page that already matches the sheet does not reserve again')
  let absorbed = 144
  const contentHeight = 400
  for (let pass = 0; pass < 3; pass += 1) {
    const sheet = Math.max(contentHeight, absorbed)
    if (sheet <= absorbed + 1) break
    absorbed = textAbsorbTargetHeight(sheet, absorbed, true)
  }
  assert.equal(absorbed, contentHeight + GROW_STEP_Y, 'opening a text note leaves one write step, then stops')
  assert.equal(textAbsorbTargetHeight(absorbed, absorbed, true), absorbed, 'the next absorb does not eat or add room')
  assert.equal(
    textAbsorbTargetHeight(contentHeight + line, absorbed, true),
    absorbed,
    'a line inside the room is not a new page',
  )
  assert.equal(
    textAbsorbTargetHeight(900, 400, false),
    900,
    'the pen absorb stays on the painted sheet',
  )
  assert.equal(
    textAbsorbTargetHeight(400, 400, true),
    400,
    'a width-only grow does not add typing room',
  )
  const catchUpStart = boardSource.indexOf('const catchUpPaintedLayout = useCallback(')
  const catchUpEnd = boardSource.indexOf('catchUpPaintedLayoutRef.current = catchUpPaintedLayout')
  assert.ok(catchUpStart >= 0 && catchUpEnd > catchUpStart, 'catch-up is in the board')
  const catchUp = boardSource.slice(catchUpStart, catchUpEnd)
  assert.ok(catchUp.indexOf('textTypingRoomHeight') < catchUp.indexOf('adoptPaintedInkPage'), 'the room is pinned before ink is scaled')
  assert.match(catchUp, /applyInkExtentStylesRef\.current\(room, sourceW\)/, 'the reserved height is the sheet min-height')
  assert.match(catchUp, /keyboard: inline && !inputActive/, 'only keyboard typing reserves the room')
  assert.match(boardSource, /textAbsorbTargetHeight\(paintedH, sourceHeightRef\.current, reserveTypingRoom\)/)
  assert.match(boardSource, /noteErasedInkRef\.current\(before, next\)/, 'an erase remembers the ink it removed')
  assert.match(boardSource, /pendingErase\.strokes === strokesRef\.current/, 'a patch is dropped when the stroke list changed')
  assert.match(boardSource, /if \(hole\) context\.clearRect\(hole\.x, hole\.y, hole\.width, hole\.height\)/, 'an erase clears the hole, not the bitmap')
  assert.match(boardSource, /context\.clearRect\(0, 0, canvas\.width, canvas\.height\)/, 'other paints can still clear the bitmap')
  assert.match(
    boardSource,
    /redrawCommitted: gestureToolRef\.current === 'eraser' \? false : scribbleDeleted > 0/,
    'lifting the eraser does not mark the bitmap dirty again',
  )

  console.log(JSON.stringify({
    lineRemnants: remnants.length,
    wordParts: wordParts.map((stroke) => stroke.points.length),
    underlineParts: lineParts.map((stroke) => stroke.points.length),
    reopen: {
      adoptedGap,
      staleGap,
      pageHeight: adopted.pageHeight,
      scaleY: adopted.scaleY,
      belowStays: keptBelow === reopened[1],
      farStays: keptFar === reopened[2],
      spanParts: spanParts.map((stroke) => stroke.points.length),
      missUnchanged: afterReopenMiss === missed,
    },
  }))
  {
    // Regression: "erasing also erases text I was not near". The eraser used
    // to take the whole letter plus any dot or bar grouped to it, and to
    // widen cuts by a letter width. Everything beyond the disk must stay.
    const R = 10
    const tall = polyline([[px(300), py(1000)], [px(300), py(1120)]], { id: 'tallStem' })
    const dotAbove = polyline([[px(296), py(976)], [px(304), py(976)]], { id: 'dotAbove' })
    const scribble = polyline([
      [px(300), py(1000)], [px(330), py(1060)], [px(300), py(1120)], [px(270), py(1060)], [px(300), py(1000)],
    ], { id: 'loop' })
    const longWord = polyline(Array.from({ length: 41 }, (_, i) => [px(100 + i * 10), py(1300 + (i % 2) * 40)]), { id: 'cursive' })
    const strokes = [tall, dotAbove, scribble, longWord]
    const out = applyToolErase(strokes, [{ x: px(300), y: py(1115) }], R, SOURCE_WIDTH, SOURCE_HEIGHT)
    assert.equal(out.includes(dotAbove), true, 'a dot 140 px from the eraser stays')
    assert.equal(out.includes(longWord), true, 'a word on another line stays untouched')
    const reach = (stroke) => stroke.points.every((entry) => Math.hypot(entry.x * SOURCE_WIDTH - 300, entry.y * SOURCE_HEIGHT - 1115) > R - 0.5)
    for (const stroke of out) assert.equal(reach(stroke), true, `no kept ink of ${stroke.id} lies inside the eraser disk`)
    assert.equal(out.some((stroke) => stroke.id === 'tallStem' && hasPointNear(stroke, 300, 1000, 2)), true, 'the top of the stem stays')
    assert.equal(out.some((stroke) => stroke.id === 'loop' && hasPointNear(stroke, 330, 1060, 2)), true, 'the rest of the loop stays')
    // Every removed vertex lies within the disk plus half a stroke width.
    const before = strokes.flatMap((stroke) => stroke.points).length
    const after = out.flatMap((stroke) => stroke.points).length
    assert.ok(after >= before - 4, 'only a few vertices near the disk are dropped')
    const longCut = applyToolErase([longWord], [{ x: px(300), y: py(1300) }], R, SOURCE_WIDTH, SOURCE_HEIGHT)
    assert.equal(longCut.some((stroke) => hasPointNear(stroke, 140, 1300, 2)), true, 'a long word keeps ink 160 px from the eraser')
    assert.equal(longCut.some((stroke) => hasPointNear(stroke, 460, 1300, 2)), true, 'a long word keeps ink 160 px away on the other side')
  }
  {
    // The cut is closed-form geometry (review R2: E1 crossings, E2 mid-segment
    // cuts, E6 crumbs). First the reviewer's repros with exact expectations,
    // then random strokes and eraser paths checked against an oracle that
    // samples the ink and measures every sample against the eraser path.
    const W = 1000
    const H = 1400
    const TOL = 1e-6
    const close = (left, right, tolerance = TOL) => Math.abs(left - right) <= tolerance
    const ink = (coords, width = 3, pageH = H) => polyline(
      coords.map(([x, y]) => [x / W, y / pageH]),
      { baseWidth: width },
    )
    const erase = (strokes, samples, radius, pageW = W, pageH = H) => applyToolErase(
      strokes,
      samples.map(([x, y]) => ({ x: x / pageW, y: y / pageH })),
      radius,
      pageW,
      pageH,
    )
    const coordsOf = (stroke, pageW = W, pageH = H) => stroke.points.map((entry) => [entry.x * pageW, entry.y * pageH])
    const assertShape = (strokes, expected, label, pageH = H) => {
      const got = strokes.map((stroke) => coordsOf(stroke, W, pageH))
      assert.equal(got.length, expected.length, `${label}: expected ${expected.length} pieces, got ${JSON.stringify(got)}`)
      got.forEach((piece, index) => {
        assert.equal(piece.length, expected[index].length, `${label}: piece ${index} is ${JSON.stringify(piece)}`)
        piece.forEach(([x, y], at) => {
          assert.ok(
            close(x, expected[index][at][0]) && close(y, expected[index][at][1]),
            `${label}: piece ${index} point ${at} is ${x},${y}, expected ${expected[index][at]}`,
          )
        })
      })
    }
    // Erasing the same place again must change nothing (no rim noise, no new objects).
    const eraseTwice = (strokes, samples, radius, pageH = H) => {
      const once = erase(strokes, samples, radius, W, pageH)
      assert.equal(erase(once, samples, radius, W, pageH), once, 'a second pass over the same place changes nothing')
      return once
    }

    // E1: a swipe that crosses a sparse stroke between its vertices. Width 3 and
    // radius 6 reach the ink 7.5 px to either side of the swipe.
    for (const x of [130, 200, 270]) {
      assertShape(
        eraseTwice([ink([[100, 500], [300, 500]])], [[x, 480], [x, 520]], 6),
        [[[100, 500], [x - 7.5, 500]], [[x + 7.5, 500], [300, 500]]],
        `a swipe across a 200 px segment at x=${x}`,
      )
    }
    const denseLine = ink(Array.from({ length: 101 }, (_, index) => [100 + index * 2, 500]))
    const denseCut = erase([denseLine], [[130, 480], [130, 520]], 6).map((stroke) => coordsOf(stroke))
    assert.equal(denseCut.length, 2, 'a dense line is cut in two as well')
    assert.ok(close(denseCut[0].at(-1)[0], 122.5) && close(denseCut[1][0][0], 137.5), 'and at the same places as the sparse one')
    // A slanted stroke and a vertical swipe: the cut points are where the slab ends.
    const slope = 20 / 300
    assertShape(
      eraseTwice([ink([[100, 500], [400, 520]])], [[250, 400], [250, 600]], 6),
      [[[100, 500], [242.5, 500 + 142.5 * slope]], [[257.5, 500 + 157.5 * slope], [400, 520]]],
      'a long swipe across a slanted stroke',
    )
    // A diagonal stroke and a disk on it: the cut is 11.5 px of ink either side.
    const diagonal = 11.5 / Math.SQRT2
    assertShape(
      eraseTwice([ink([[100, 100], [400, 400]])], [[250, 250]], 10),
      [[[100, 100], [250 - diagonal, 250 - diagonal]], [[250 + diagonal, 250 + diagonal], [400, 400]]],
      'a disk on a diagonal stroke',
    )
    // A path along the ink and a path that crosses it twice.
    assertShape(
      eraseTwice([ink([[100, 500], [300, 500]])], [[150, 500], [250, 500]], 6),
      [[[100, 500], [142.5, 500]], [[257.5, 500], [300, 500]]],
      'an eraser path laid along the stroke',
    )
    assertShape(
      eraseTwice([ink([[100, 500], [300, 500]])], [[130, 480], [130, 520], [270, 520], [270, 480]], 6),
      [[[100, 500], [122.5, 500]], [[137.5, 500], [262.5, 500]], [[277.5, 500], [300, 500]]],
      'a U-shaped eraser path that crosses the stroke twice',
    )
    // A radius of 1 px across a 4000 px segment: no vertex or probe lies near the cut.
    assertShape(
      eraseTwice([ink([[100, 100], [100, 4100]], 3, 9000)], [[90, 2000], [110, 2000]], 1, 9000),
      [[[100, 100], [100, 1997.5]], [[100, 2002.5], [100, 4100]]],
      'a 1 px swipe across a very long segment',
      9000,
    )

    // E2: an eraser that sits on a long segment cuts out its own width and nothing else.
    for (const x of [110, 130, 160, 200, 270, 290]) {
      assertShape(
        eraseTwice([ink([[100, 500], [300, 500]])], [[x, 500]], 6),
        [[[100, 500], [x - 7.5, 500]], [[x + 7.5, 500], [300, 500]]],
        `a stationary eraser at x=${x}`,
      )
    }
    assertShape(
      eraseTwice([ink([[100, 500], [160, 500], [220, 500]])], [[118, 500]], 3),
      [[[100, 500], [113.5, 500]], [[122.5, 500], [160, 500], [220, 500]]],
      'a small eraser on the first segment of a polyline',
    )
    assertShape(
      eraseTwice([ink([[100, 500], [160, 500], [220, 500]])], [[160, 500]], 6),
      [[[100, 500], [152.5, 500]], [[167.5, 500], [220, 500]]],
      'an eraser on a vertex takes the vertex',
    )
    assertShape(
      eraseTwice([ink([[100, 500], [152.5, 500], [220, 500]])], [[160, 500]], 6),
      [[[100, 500], [152.5, 500]], [[167.5, 500], [220, 500]]],
      'a cut that lands on a vertex does not repeat it',
    )
    assertShape(
      eraseTwice([ink([[100, 500], [120, 500], [140, 500]])], [[128.4, 500]], 3),
      [[[100, 500], [120, 500], [123.9, 500]], [[132.9, 500], [140, 500]]],
      'an eraser between two vertices',
    )
    const dotStroke = ink([[100, 500]], 8)
    assert.equal(erase([dotStroke], [[105, 500]], 2).length, 0, 'a dot is erased when the disk reaches its edge')
    const dotList = [dotStroke]
    assert.equal(erase(dotList, [[107, 500]], 2), dotList, 'and kept when the disk stops short of it')
    assert.equal(erase([ink([[100, 500], [101, 500]])], [[100, 500]], 2).length, 0, 'a tiny two-point stroke under the eraser is gone')
    assert.equal(erase([ink([[100, 500], [100, 500], [100, 500]])], [[103, 500]], 2).length, 0, 'a stroke of repeated samples is a dot')
    // A broken sample (NaN) is never reached, and does not stop the rest of the stroke from being cut.
    const broken = ink([[100, 500], [160, 500], [220, 500]])
    broken.points[1].x = Number.NaN
    const brokenList = [broken]
    assert.equal(erase(brokenList, [[130, 500]], 6), brokenList, 'segments with a NaN end are not hit')
    const brokenFar = ink([[100, 500], [140, 500], [160, 500], [400, 500]])
    brokenFar.points[1].y = Number.NaN
    const brokenCut = erase([brokenFar], [[300, 500]], 6)
    assert.equal(brokenCut.length, 2, 'a NaN elsewhere in the stroke does not stop a cut')
    assert.ok(close(coordsOf(brokenCut[0]).at(-1)[0], 292.5) && close(coordsOf(brokenCut[1])[0][0], 307.5), 'and the cut is still exact')

    // E6: no crumbs. A remainder shorter than a quarter of the width (at least
    // half a pixel) is dropped, a longer one stays.
    assertShape(
      eraseTwice([ink([[100, 500], [300, 500]])], [[292, 500]], 6),
      [[[100, 500], [284.5, 500]]],
      'a 0.5 px remainder at the far end is dropped',
    )
    assertShape(
      eraseTwice([ink([[100, 500], [300, 500]])], [[108, 500]], 6),
      [[[115.5, 500], [300, 500]]],
      'a 0.5 px remainder at the near end is dropped',
    )
    assertShape(
      eraseTwice([ink([[100, 500], [300, 500]])], [[291.5, 500]], 6),
      [[[100, 500], [284, 500]], [[299, 500], [300, 500]]],
      'a 1 px remainder is kept',
    )
    // The limit grows with the width: a quarter of 12 px is 3 px.
    const wide = ink([[100, 500], [300, 500]], 12)
    assertShape(erase([wide], [[200, 500]], 6), [[[100, 500], [188, 500]], [[212, 500], [300, 500]]], 'a wide stroke is cut by its own reach')
    assertShape(erase([wide], [[286, 500]], 6), [[[100, 500], [274, 500]]], 'a 2 px stub of a wide stroke is dropped')
    assertShape(erase([wide], [[284, 500]], 6), [[[100, 500], [272, 500]], [[296, 500], [300, 500]]], 'a 4 px stub of a wide stroke is kept')

    // Touching without reaching: a miss by a hair keeps the same objects, a
    // graze by 0.01 px cuts a hair of ink.
    const hairLine = [ink([[100, 500], [300, 500]])]
    assert.equal(erase(hairLine, [[200, 500 - 7.51]], 6), hairLine, 'an eraser 0.01 px short of the ink changes nothing')
    const chord = Math.sqrt(7.5 * 7.5 - 7.49 * 7.49)
    assertShape(
      eraseTwice(hairLine, [[200, 500 - 7.49]], 6),
      [[[100, 500], [200 - chord, 500]], [[200 + chord, 500], [300, 500]]],
      'a graze cuts the chord and no more',
    )

    // Random strokes and eraser paths against a sampling oracle.
    const seeded = (seed) => () => {
      seed = (seed + 0x6d2b79f5) | 0
      let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
    }
    const rand = seeded(20261116)
    const between = (low, high) => low + (high - low) * rand()
    const clamp = (value, low, high) => Math.max(low, Math.min(high, value))
    const distanceToSeg = (x, y, ax, ay, bx, by) => {
      const dx = bx - ax
      const dy = by - ay
      const squared = dx * dx + dy * dy
      const t = squared > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / squared, 0, 1) : 0
      return Math.hypot(x - (ax + dx * t), y - (ay + dy * t))
    }
    const distanceToLine = (x, y, line) => {
      if (line.length === 1) return Math.hypot(x - line[0][0], y - line[0][1])
      let best = Number.POSITIVE_INFINITY
      for (let index = 1; index < line.length; index += 1) {
        best = Math.min(best, distanceToSeg(x, y, line[index - 1][0], line[index - 1][1], line[index][0], line[index][1]))
      }
      return best
    }
    // Points along a polyline no farther than `step` apart, vertices included.
    const sampleLine = (line, step) => {
      const found = [line[0]]
      for (let index = 1; index < line.length; index += 1) {
        const [ax, ay] = line[index - 1]
        const [bx, by] = line[index]
        const parts = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step))
        for (let part = 1; part <= parts; part += 1) found.push([ax + (bx - ax) * part / parts, ay + (by - ay) * part / parts])
      }
      return found
    }
    const lengthOf = (line) => line.slice(1).reduce((sum, entry, index) => sum + Math.hypot(entry[0] - line[index][0], entry[1] - line[index][1]), 0)
    const coverIndex = (lines) => lines.flatMap((line) => line.slice(1).map((entry, index) => {
      const [ax, ay] = line[index]
      return {
        ax,
        ay,
        bx: entry[0],
        by: entry[1],
        minX: Math.min(ax, entry[0]) - TOL,
        maxX: Math.max(ax, entry[0]) + TOL,
        minY: Math.min(ay, entry[1]) - TOL,
        maxY: Math.max(ay, entry[1]) + TOL,
      }
    }))
    const isCovered = (index, x, y) => index.some((segment) => (
      x >= segment.minX && x <= segment.maxX && y >= segment.minY && y <= segment.maxY
      && distanceToSeg(x, y, segment.ax, segment.ay, segment.bx, segment.by) <= TOL
    ))
    // Pressure and time are linear in the position, so a cut point must carry
    // the value the line has there.
    const fieldsAt = (x, y) => ({ t: 0.5 * x + 0.25 * y, pressure: 0.2 + 0.0004 * x + 0.0003 * y })
    const makeStroke = (id, pageW, pageH, sparse = rand() < 0.5) => {
      const count = sparse ? 2 + Math.floor(rand() * 7) : 20 + Math.floor(rand() * 100)
      let x = between(30, pageW - 30)
      let y = between(30, pageH - 30)
      let heading = between(0, 2 * Math.PI)
      const points = []
      for (let index = 0; index < count; index += 1) {
        points.push({ x: x / pageW, y: y / pageH, ...fieldsAt(x, y), tiltX: 0, tiltY: 0, pointerType: 'pen' })
        heading += sparse ? between(-1.5, 1.5) : between(-0.4, 0.4)
        const step = rand() < 0.05 ? 0 : sparse ? between(15, 260) : between(0.4, 3.5)
        x = clamp(x + Math.cos(heading) * step, 2, pageW - 2)
        y = clamp(y + Math.sin(heading) * step, 2, pageH - 2)
      }
      return { id, points, baseWidth: between(0.5, 14), pressureEnabled: true, color: '#191c24', purpose: 'handwriting' }
    }
    // The same line with extra points on its segments: it must be cut identically.
    const densified = (stroke, pageW, pageH) => ({
      ...stroke,
      points: stroke.points.flatMap((entry, index, all) => {
        if (index === 0) return [entry]
        const before = all[index - 1]
        const extra = Array.from({ length: Math.floor(rand() * 4) }, () => between(0.05, 0.95)).sort((left, right) => left - right)
        return [
          ...extra.map((t) => {
            const x = before.x + (entry.x - before.x) * t
            const y = before.y + (entry.y - before.y) * t
            return { ...before, x, y, ...fieldsAt(x * pageW, y * pageH) }
          }),
          entry,
        ]
      }),
    })
    const makePath = (strokes, pageW, pageH) => {
      const target = strokes[Math.floor(rand() * strokes.length)]
      const hook = target.points[Math.floor(rand() * target.points.length)]
      let x = clamp(hook.x * pageW + between(-30, 30), 1, pageW - 1)
      let y = clamp(hook.y * pageH + between(-30, 30), 1, pageH - 1)
      const samples = [[x, y]]
      const wanted = 1 + Math.floor(rand() * 6)
      const fast = rand() < 0.6
      let heading = between(0, 2 * Math.PI)
      for (let attempt = 0; attempt < 60 && samples.length < wanted; attempt += 1) {
        heading += between(-1.2, 1.2)
        const step = fast ? between(10, 320) : between(0.5, 6)
        const nextX = clamp(x + Math.cos(heading) * step, 1, pageW - 1)
        const nextY = clamp(y + Math.sin(heading) * step, 1, pageH - 1)
        if (Math.hypot(nextX - x, nextY - y) < 0.6) continue
        samples.push([nextX, nextY])
        x = nextX
        y = nextY
      }
      return samples
    }

    const stats = { trials: 0, strokesCut: 0, untouched: 0, pieces: 0, composed: 0 }
    const checkErase = (name, strokes, samples, radius, pageW, pageH) => {
      const out = erase(strokes, samples, radius, pageW, pageH)
      const dense = strokes.map((stroke) => densified(stroke, pageW, pageH))
      const outDense = erase(dense, samples, radius, pageW, pageH)
      const middle = samples.length >= 3 ? Math.floor(samples.length / 2) : 0
      const outSteps = middle
        ? erase(erase(strokes, samples.slice(0, middle + 1), radius, pageW, pageH), samples.slice(middle), radius, pageW, pageH)
        : null
      stats.trials += 1

      assert.equal(out.every((entry) => strokes.some((stroke) => stroke.id === entry.id)), true, `${name}: no stroke appears from nowhere`)
      assert.equal(erase(out, samples, radius, pageW, pageH), out, `${name}: erasing the same path again changes nothing`)

      for (const stroke of strokes) {
        const label = `${name} ${stroke.id} (radius ${radius.toFixed(2)}, width ${stroke.baseWidth.toFixed(2)}, ${stroke.points.length} points)`
        const original = coordsOf(stroke, pageW, pageH)
        const reach = radius + stroke.baseWidth / 2
        const crumb = Math.max(0.5, stroke.baseWidth / 4)
        const inkSamples = sampleLine(original, 0.25)
        const gaps = inkSamples.map(([x, y]) => distanceToLine(x, y, samples))
        const nearest = Math.min(...gaps)
        const pieces = out.filter((entry) => entry.id === stroke.id)
        const lines = pieces.map((piece) => coordsOf(piece, pageW, pageH))
        const kept = coverIndex(lines)

        // 0.125 px is the most a point between two samples can be closer than the closest sample.
        if (nearest > reach + 0.126) {
          assert.equal(out.includes(stroke), true, `${label}: ink the path never reaches stays the same object`)
          stats.untouched += 1
          continue
        }
        if (nearest < reach - 0.01) {
          assert.equal(out.includes(stroke), false, `${label}: ink the path reaches is cut`)
          stats.strokesCut += 1
        }
        stats.pieces += pieces.length

        lines.forEach((line, index) => {
          assert.ok(line.length >= 2, `${label}: piece ${index} has one point`)
          assert.ok(lengthOf(line) >= crumb - 1e-9, `${label}: piece ${index} is a crumb of ${lengthOf(line)} px`)
          // Every piece is a stretch of the original line...
          for (const [x, y] of sampleLine(line, 0.5)) {
            assert.ok(distanceToLine(x, y, original) <= TOL, `${label}: piece ${index} leaves the drawn line at ${x},${y}`)
          }
          // ...that lies wholly outside the reach of the eraser.
          for (const [x, y] of sampleLine(line, 0.25)) {
            assert.ok(
              distanceToLine(x, y, samples) >= reach - TOL,
              `${label}: ink left at ${x},${y}, ${distanceToLine(x, y, samples)} px from the path (reach ${reach})`,
            )
          }
          // Cut points carry the pressure and time the line has at that spot.
          for (const entry of pieces[index].points) {
            const expected = fieldsAt(entry.x * pageW, entry.y * pageH)
            assert.ok(close(entry.pressure, expected.pressure, 1e-9) && close(entry.t, expected.t, 1e-9), `${label}: a cut point lost its pressure or time`)
          }
        })

        // Only ink within reach goes, plus a crumb next to a cut.
        inkSamples.forEach(([x, y], index) => {
          if (gaps[index] > reach + crumb + TOL) {
            assert.ok(isCovered(kept, x, y), `${label}: ink at ${x},${y} is ${gaps[index]} px from the path (reach ${reach}, crumb ${crumb}) and was removed`)
          }
        })

        // Extra points on a segment make no difference to the cut. A sample on
        // the rim itself can fall either way.
        const denseKept = coverIndex(outDense.filter((entry) => entry.id === stroke.id).map((piece) => coordsOf(piece, pageW, pageH)))
        inkSamples.forEach(([x, y], index) => {
          if (close(gaps[index], reach, 1e-6)) return
          assert.equal(isCovered(denseKept, x, y), isCovered(kept, x, y), `${label}: a stroke with extra points on its segments was cut differently at ${x},${y}`)
        })
        // Two erase passes along one path leave what a single pass does.
        if (outSteps) {
          const stepKept = coverIndex(outSteps.filter((entry) => entry.id === stroke.id).map((piece) => coordsOf(piece, pageW, pageH)))
          stats.composed += 1
          inkSamples.forEach(([x, y], index) => {
            if (close(gaps[index], reach, 1e-6)) return
            assert.equal(isCovered(stepKept, x, y), isCovered(kept, x, y), `${label}: erasing in two steps cut differently at ${x},${y}`)
          })
        }
      }
      return out
    }

    for (let trial = 0; trial < 300; trial += 1) {
      const pageW = Math.round(between(500, 1300))
      const pageH = Math.round(between(700, 2200))
      const strokes = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, index) => makeStroke(`s${index}`, pageW, pageH))
      const radius = rand() < 0.15 ? between(0.5, 3) : between(1, 40)
      checkErase(`trial ${trial}`, strokes, makePath(strokes, pageW, pageH), radius, pageW, pageH)
    }

    // The far end of a long segment: the eraser stops `stub` px short of the
    // end. The stub is a crumb up to a quarter of the width (at least 0.5 px).
    let crumbsDropped = 0
    let stubsKept = 0
    for (let trial = 0; trial < 120; trial += 1) {
      const pageW = Math.round(between(500, 1300))
      const pageH = Math.round(between(700, 2200))
      const radius = between(1, 30)
      let stroke = makeStroke('end', pageW, pageH, true)
      let line = coordsOf(stroke, pageW, pageH)
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [end, before] = [line.at(-1), line.at(-2)]
        if (Math.hypot(end[0] - before[0], end[1] - before[1]) > 4 * (radius + 7) + 20) break
        stroke = makeStroke('end', pageW, pageH, true)
        line = coordsOf(stroke, pageW, pageH)
      }
      const [end, before] = [line.at(-1), line.at(-2)]
      const length = Math.hypot(end[0] - before[0], end[1] - before[1])
      if (length <= 4 * (radius + 7) + 20) continue
      const reach = radius + stroke.baseWidth / 2
      const crumb = Math.max(0.5, stroke.baseWidth / 4)
      const stub = between(0.05, crumb * 1.8)
      if (close(stub, crumb, 1e-4)) continue
      const aim = reach + stub
      const sample = [end[0] - (end[0] - before[0]) / length * aim, end[1] - (end[1] - before[1]) / length * aim]
      const out = checkErase(`end ${trial}`, [stroke], [sample], radius, pageW, pageH)
      const tail = out.map((piece) => coordsOf(piece, pageW, pageH)).filter((piece) => close(piece.at(-1)[0], end[0], 1e-6) && close(piece.at(-1)[1], end[1], 1e-6))
      if (stub < crumb) {
        assert.equal(tail.length, 0, `end ${trial}: a stub of ${stub} px (crumb ${crumb}) is dropped`)
        crumbsDropped += 1
      } else {
        assert.equal(tail.length, 1, `end ${trial}: a stub of ${stub} px (crumb ${crumb}) stays`)
        assert.ok(close(lengthOf(tail[0]), stub, 1e-6), `end ${trial}: the stub keeps its length`)
        stubsKept += 1
      }
    }
    assert.ok(crumbsDropped > 20 && stubsKept > 20, `crumb trials cover both sides (${crumbsDropped} dropped, ${stubsKept} kept)`)
    assert.ok(stats.strokesCut > 150, `the random trials cut ink (${stats.strokesCut} cut strokes)`)
    assert.ok(stats.untouched > 50, `the random trials also miss (${stats.untouched} untouched strokes)`)
    assert.ok(stats.pieces > stats.strokesCut, 'some random cuts leave more than one piece')
    console.log(JSON.stringify({ randomErase: { ...stats, crumbsDropped, stubsKept } }))
  }
  console.log('tool-erase ok')
} finally {
  await server.close()
}
