import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { applyToolErase, strokeTouchesEraser } = await server.ssrLoadModule('/src/lib/toolErase.ts')

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
  console.log(JSON.stringify({
    lineRemnants: remnants.length,
    wordParts: wordParts.map((stroke) => stroke.points.length),
    underlineParts: lineParts.map((stroke) => stroke.points.length),
  }))
  console.log('tool-erase ok')
} finally {
  await server.close()
}
