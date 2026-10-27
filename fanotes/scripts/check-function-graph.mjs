import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const near = (actual, expected) => Math.abs(actual - expected) < 1e-9

try {
  const graph = await server.ssrLoadModule('/src/lib/functionGraph.ts')
  const laser = await server.ssrLoadModule('/src/lib/laserPointer.ts')
  const sin = graph.compileFunctionGraph('sin(x)')
  assert.ok(near(sin(0), 0))
  assert.ok(near(sin(Math.PI / 2), 1))
  assert.ok(near(graph.compileFunctionGraph('x^2')(2), 4))
  assert.ok(near(graph.compileFunctionGraph('2x')(3), 6))
  assert.ok(near(graph.compileFunctionGraph('2sin(x)')(Math.PI / 2), 2))
  assert.ok(near(graph.compileFunctionGraph('-x^2')(3), -9))
  assert.ok(near(graph.compileFunctionGraph('exp(-x^2)')(0), 1))
  assert.ok(near(graph.compileFunctionGraph('ln(e)')(0), 1))
  assert.ok(near(graph.compileFunctionGraph('log10(100)')(0), 2))
  assert.throws(() => graph.compileFunctionGraph(''), /leer/)
  assert.throws(() => graph.compileFunctionGraph('   '), /leer/)
  assert.throws(() => graph.compileFunctionGraph('alert(1)'), /nicht erlaubt/)
  assert.throws(() => graph.compileFunctionGraph('constructor'), /Variable x/)
  assert.throws(() => graph.compileFunctionGraph('y'), /Variable x/)
  assert.throws(() => graph.compileFunctionGraph('1=1'), /nicht erlaubt/)
  assert.throws(() => graph.functionGraphPaths('sin(x)', 2, 2), /x-Minimum/)

  const sinePaths = graph.functionGraphPaths('sin(x)', graph.DEFAULT_GRAPH_X_MIN, graph.DEFAULT_GRAPH_X_MAX)
  assert.ok(sinePaths.length >= 2)
  const numbersOf = (path) => (path.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number)
  for (const path of sinePaths) {
    assert.match(path, /^[ML\d\s.,-]+$/u)
    for (const value of numbersOf(path)) assert.ok(value >= 0 && value <= 24, path)
  }
  assert.ok(sinePaths[0].includes('M ') && sinePaths[0].split(' L ').length >= 4)

  const split = graph.functionGraphPaths('1/x', -4, 4)
  assert.ok(split.length >= 3, `expected a split curve, got ${split.length}`)
  const stamp = graph.readFunctionGraphStamp({
    graphExpression: 'x^2',
    graphXMin: -2,
    graphXMax: 2,
    graphPaths: ['M 0 0 L 1 1'],
  })
  assert.ok(stamp.paths.length >= 2)
  assert.equal(stamp.expression, 'x^2')
  const fallback = graph.readFunctionGraphStamp({
    graphExpression: 'alert(1)',
    graphXMin: -2,
    graphXMax: 2,
    graphPaths: ['M 1 1 L 2 2', 'M 3 3 L 4 4'],
  })
  assert.deepEqual(fallback.paths, ['M 1 1 L 2 2', 'M 3 3 L 4 4'])
  assert.equal(graph.readFunctionGraphStamp({ graphPaths: ['<script>'] }), null)

  const kept = laser.pushLaserSample([], { x: 0, y: 0, t: 0 })
  const moved = laser.pushLaserSample(kept, { x: 10, y: 0, t: 10 })
  assert.equal(moved.length, 2)
  const still = laser.pushLaserSample(moved, { x: 11, y: 0, t: 20 })
  assert.equal(still.length, 2)
  assert.equal(still[1].t, 20)
  assert.equal(laser.trimLaserSamples(still, 20 + laser.LASER_TRAIL_MS + 1).length, 0)
  const calls = []
  const context = {
    clearRect() { calls.push('clear') },
    beginPath() { calls.push('begin') },
    arc() { calls.push('arc') },
    fill() { calls.push('fill') },
  }
  laser.paintLaserPointer({ width: 8, height: 8, getContext: () => context }, still, 20, true)
  assert.ok(calls.includes('clear'))
  assert.ok(calls.includes('arc'))
  assert.ok(calls.includes('fill'))

  const source = readFileSync(join(root, 'src/lib/functionGraph.ts'), 'utf8')
  assert.doesNotMatch(source, /\beval\s*\(|\bnew Function\b/u)
  const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
  assert.match(board, /tool === 'laser' && event\.pointerType === 'mouse'/u)
  assert.match(board, /laserPressedRef/u)
  assert.match(board, /The dot follows the pointer\. The line is only the stroke while it is held down\./u)
  assert.match(board, /graphPlaceRef\.current/u)
  assert.match(board, /aria-label="Laserpointer"/u)
  assert.match(board, /aria-label="Funktionsgraph einfügen"/u)
  console.log('function graph ok')
} finally {
  await server.close()
}
