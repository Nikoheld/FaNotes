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
const { readSavedInkStrokes } = await server.ssrLoadModule('/src/lib/inkDocument.ts')
const { savedInkPage, keepMarkOnPage } = await server.ssrLoadModule('/src/lib/noteCanvas.ts')
const { adoptPaintedInkPage } = await server.ssrLoadModule('/src/lib/paperGrow.ts')

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
  assert.equal(erasedLeft.some((stroke) => stroke.id === 'left'), false, 'the touched letter is removed whole')

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
  assert.equal(wordParts.some((stroke) => hasPointNear(stroke, 140, 260, 18)), false, 'the touched letter of the word is gone')
  assert.equal(wordParts.some((stroke) => hasPointNear(stroke, 320, 250, 30)), true, 'the connected letter that was not touched stays')

  const stem = polyline([[px(100), py(230)], [px(100), py(310)]], { id: 'stem' })
  const dot = polyline([[px(96), py(198)], [px(104), py(198)]], { id: 'dot' })
  const other = polyline([[px(220), py(230)], [px(220), py(310)]], { id: 'other' })
  const eyed = [stem, dot, other]
  const erasedStem = applyToolErase(eyed, [{ x: px(100), y: py(270) }], RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.deepEqual(idsOf(erasedStem), ['other'], 'touching the stem removes the whole i, including the dot')
  assert.equal(erasedStem[0], other)
  const erasedDot = applyToolErase(eyed, [{ x: px(100), y: py(198) }], RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.deepEqual(idsOf(erasedDot), ['other'], 'touching the dot removes the whole i')

  const wideM = polyline([
    [px(100), py(300)],
    [px(100), py(220)],
    [px(150), py(300)],
    [px(200), py(220)],
    [px(250), py(300)],
  ], { id: 'em' })
  const afterM = applyToolErase([wideM, rightLetter], [{ x: px(100), y: py(260) }], RADIUS, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(afterM.some((stroke) => stroke.id === 'em'), false, 'a single wide letter is removed whole when touched')
  assert.equal(afterM[0], rightLetter)

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

  assert.equal(wordParts.some((stroke) => hasPointNear(stroke, 120, 220, 8)), false, 'the stem of the touched letter goes with the letter')

  const fineStem = polyline([[px(100), py(230)], [px(100), py(310)]], { id: 'fine' })
  const fineNeighbor = polyline([[px(130), py(230)], [px(130), py(310)]], { id: 'fine-neighbor' })
  const finePair = [fineStem, fineNeighbor]
  const fineHit = applyToolErase(finePair, [{ x: px(100), y: py(270) }], 1, SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.equal(fineHit.some((stroke) => stroke.id === 'fine'), false, 'a 1 px eraser on the ink removes that stroke')
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
  assert.equal(separated.some((stroke) => stroke.id === 'tall'), false, 'the touched stem is removed')
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
    /applyToolErase\(\s*strokesRef\.current,\s*samples,\s*eraserSize,\s*sourceWidthRef\.current,\s*sourceHeightRef\.current,/,
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
  assert.equal(staleHit.some((stroke) => stroke.id === 'below'), false, 'the saved page after the layout scale deletes the neighbour the disk does not meet')
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
  assert.equal(erasedReopen.some((stroke) => stroke.id === 'letter'), false, 'the mark under the eraser is removed')
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
  console.log('tool-erase ok')
} finally {
  await server.close()
}
