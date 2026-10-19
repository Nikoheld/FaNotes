import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const board = readFileSync(new URL('../src/components/DrawingBoard.tsx', import.meta.url), 'utf8')
const preview = readFileSync(new URL('../src/components/InkPreviewLayer.tsx', import.meta.url), 'utf8')

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  MATH_FIGURES,
  clampFigureParams,
  defaultFigureParams,
  isMathFigureId,
  mathFigurePaths,
} = await server.ssrLoadModule('/src/lib/mathFigures.ts')

const segmentLengths = (path) => {
  const lengths = []
  let cursor = null
  for (const match of path.matchAll(/([ML])\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)) {
    const point = { x: Number(match[2]), y: Number(match[3]) }
    if (match[1] === 'L' && cursor) lengths.push(Math.hypot(point.x - cursor.x, point.y - cursor.y))
    cursor = point
  }
  return lengths
}

try {
  assert.ok(MATH_FIGURES.length >= 48, `expected a broad catalog, got ${MATH_FIGURES.length}`)
  const ids = new Set()
  for (const figure of MATH_FIGURES) {
    assert.equal(ids.has(figure.id), false, figure.id)
    ids.add(figure.id)
    assert.ok(figure.label.length > 1, figure.id)
    assert.ok(figure.group === 'plane' || figure.group === 'solid', figure.id)
    const defaults = defaultFigureParams(figure.id)
    const paths = mathFigurePaths(figure.id, defaults)
    assert.ok(paths.length >= 1, `${figure.id} drew nothing`)
    for (const path of paths) assert.match(path, /^M /, figure.id)
    assert.deepEqual(mathFigurePaths(figure.id, defaults), paths, `${figure.id} is not stable`)
    for (const param of figure.params) {
      assert.ok(param.min < param.max, `${figure.id}.${param.id}`)
      assert.ok(param.step > 0, `${figure.id}.${param.id}`)
      assert.ok(param.value >= param.min && param.value <= param.max, `${figure.id}.${param.id}`)
    }
  }

  assert.equal(isMathFigureId('cube'), true)
  assert.equal(isMathFigureId('not-a-figure'), false)
  assert.deepEqual(mathFigurePaths('not-a-figure'), [])
  assert.deepEqual(mathFigurePaths('cube'), mathFigurePaths('cube', null))

  const cube = mathFigurePaths('cube')
  const turned = mathFigurePaths('cube', { yaw: 12, pitch: 24 })
  assert.notEqual(cube.join('\n'), turned.join('\n'), 'yaw should change the cube')
  const cuboid = defaultFigureParams('cuboid')
  const wide = mathFigurePaths('cuboid', { ...cuboid, width: 2.1 })
  const narrow = mathFigurePaths('cuboid', { ...cuboid, width: 0.45 })
  assert.notEqual(wide.join('\n'), narrow.join('\n'), 'width should change the cuboid')

  const cubeLengths = cube.flatMap(segmentLengths)
  assert.ok(cubeLengths.some((length) => length > 4), 'a front edge of the cube stays solid')
  assert.ok(cubeLengths.some((length) => length < 2.2), 'a hidden edge of the cube is dashed')
  assert.ok(cube.some((path) => (path.match(/M /g) || []).length >= 2), 'the dashed cube edge is more than one move')

  for (const id of ['tetrahedron', 'octahedron', 'icosahedron', 'dodecahedron', 'cylinder', 'cone', 'frustum']) {
    const paths = mathFigurePaths(id)
    const lengths = paths.flatMap(segmentLengths)
    assert.ok(lengths.some((length) => length > 3), `${id} keeps a solid edge`)
    assert.ok(lengths.some((length) => length < 2.2), `${id} hides a back edge`)
  }
  for (const id of ['sphere', 'hemisphere', 'torus']) {
    const paths = mathFigurePaths(id)
    assert.ok(paths.some((path) => (path.match(/ L /g) || []).length > (path.match(/M /g) || []).length), `${id} keeps a continuous front curve`)
    assert.ok(paths.some((path) => (path.match(/M /g) || []).length >= 4), `${id} breaks the back into dashes`)
  }

  const clamped = clampFigureParams('polygon', { sides: 99, extra: 4, nope: Number.NaN })
  assert.equal(clamped.sides, 12)
  assert.equal('extra' in clamped, false)
  const cubeClamp = clampFigureParams('cube', { yaw: Number.NaN, pitch: 999, width: 4 })
  assert.equal(cubeClamp.yaw, defaultFigureParams('cube').yaw)
  assert.equal(cubeClamp.pitch, 60)
  assert.equal('width' in cubeClamp, false)

  assert.match(board, /mathFigurePaths/)
  assert.match(board, /isMathFigureId/)
  assert.match(board, /Figurenbibliothek: Figur wählen und auf die Seite tippen/)
  assert.match(board, /lw-figure-library/)
  assert.equal((board.match(/id="lw-art-tab-/g) || []).length, 3)
  assert.match(preview, /mathFigurePaths/)

  console.log(`math-figures ok (${MATH_FIGURES.length})`)
} finally {
  await server.close()
}
