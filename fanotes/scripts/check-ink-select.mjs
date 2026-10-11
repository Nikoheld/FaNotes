import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { boundsOfInkIndexes, takeInkSelection } = await server.ssrLoadModule('/src/lib/inkSelect.ts')

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 1273
const px = (x) => x / SOURCE_WIDTH
const py = (y) => y / SOURCE_HEIGHT
const point = (x, y) => ({ x, y, t: 0, pressure: 0.5, tiltX: 0, tiltY: 0, pointerType: 'pen' })
const polyline = (coords, extras = {}) => ({
  points: coords.map(([x, y]) => point(x, y)),
  baseWidth: 4,
  pressureEnabled: true,
  color: '#191c24',
  purpose: 'handwriting',
  ...extras,
})
const box = (x, y, width, height) => ({ x: px(x), y: py(y), width: px(width), height: py(height) })
const selectedIds = (strokes, indexes) => indexes.map((index) => strokes[index].id)
const move = (strokes, indexes, dx, dy) => strokes.map((stroke, index) => (
  indexes.includes(index)
    ? { ...stroke, points: stroke.points.map((entry) => ({ ...entry, x: entry.x + dx, y: entry.y + dy })) }
    : stroke
))

try {
  const left = polyline([
    [px(100), py(220)],
    [px(100), py(300)],
    [px(140), py(240)],
    [px(170), py(300)],
  ], { id: 'left' })
  const right = polyline([
    [px(280), py(220)],
    [px(280), py(300)],
    [px(320), py(240)],
    [px(350), py(300)],
  ], { id: 'right' })
  const art = polyline([[px(120), py(250)], [px(150), py(280)]], { id: 'art', purpose: 'art' })
  const page = [left, art, right]

  const one = takeInkSelection(page, box(80, 200, 110, 120), SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.deepEqual(selectedIds(one.strokes, one.indexes), ['left'], 'the boxed letter is selected')
  assert.equal(one.strokes[one.indexes[0]], left, 'a wholly boxed letter keeps its stroke')
  assert.equal(one.strokes.includes(art), true)
  assert.equal(one.indexes.some((index) => one.strokes[index].id === 'art'), false, 'drawing ink is not handwriting')
  assert.equal(one.strokes.includes(right), true)
  const moved = move(one.strokes, one.indexes, 0.05, 0.02)
  assert.equal(moved[one.indexes[0]].points[0].x, left.points[0].x + 0.05)
  assert.equal(moved.find((stroke) => stroke.id === 'right'), right, 'the other letter does not move')

  const both = takeInkSelection(page, box(80, 200, 300, 120), SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.deepEqual(selectedIds(both.strokes, both.indexes).sort(), ['left', 'right'])

  const graze = takeInkSelection(page, box(188, 200, 24, 40), SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.deepEqual(graze.indexes, [], 'a rectangle that only grazes empty paper selects nothing')
  assert.equal(graze.strokes, page, 'a miss leaves the original list')

  const stem = polyline([[px(100), py(230)], [px(100), py(310)]], { id: 'stem' })
  const dot = polyline([[px(96), py(198)], [px(104), py(198)]], { id: 'dot' })
  const eyed = takeInkSelection([stem, dot, right], box(80, 220, 50, 100), SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.deepEqual(selectedIds(eyed.strokes, eyed.indexes).sort(), ['dot', 'stem'], 'the dot moves with the letter even when the box covers the stem')

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
  const partial = takeInkSelection([word], box(100, 200, 110, 120), SOURCE_WIDTH, SOURCE_HEIGHT)
  assert.ok(partial.indexes.length >= 1, 'part of a connected word can be selected')
  const kept = partial.strokes.filter((_, index) => !partial.indexes.includes(index))
  assert.ok(kept.some((stroke) => stroke.points.some((entry) => entry.x * SOURCE_WIDTH > 260)), 'the unboxed letter of the word stays behind')
  const taken = partial.indexes.map((index) => partial.strokes[index])
  assert.ok(taken.some((stroke) => stroke.points.some((entry) => Math.hypot(entry.x * SOURCE_WIDTH - 140, entry.y * SOURCE_HEIGHT - 260) < 40)), 'the boxed letter is in the selection')
  assert.equal(taken.some((stroke) => stroke.points.some((entry) => entry.x * SOURCE_WIDTH > 300)), false, 'the far letter is not selected')

  const bounds = boundsOfInkIndexes(one.strokes, one.indexes)
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0)

  console.log(JSON.stringify({
    one: selectedIds(one.strokes, one.indexes),
    eyed: selectedIds(eyed.strokes, eyed.indexes),
    partial: partial.indexes.length,
    kept: kept.length,
  }))
  console.log('ink-select ok')
} finally {
  await server.close()
}
