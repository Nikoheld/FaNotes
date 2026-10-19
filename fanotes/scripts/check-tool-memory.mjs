// Tool sliders that are not AppSettings still come back after a restart:
// eraser pixels, the armed figure, and the text-to-handwriting options.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
}

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  TOOL_MEMORY_KEY,
  defaultToolMemory,
  loadToolMemory,
  normalizeToolMemory,
  saveToolMemory,
} = await server.ssrLoadModule('/src/lib/toolMemory.ts')

const fresh = loadToolMemory()
assert.equal(fresh.eraserSize, 24)
assert.equal(fresh.tool, 'pen')
assert.equal(fresh.inkMode, 'writing')
assert.equal(fresh.figureId, 'cube')
assert.equal(fresh.figureGroup, 'solid')
assert.equal(fresh.figureSize, 120)
assert.equal(fresh.handwriting.fontSize, 42)
assert.equal(fresh.handwriting.variation, 0.62)
assert.equal(fresh.mathPlacement, 'auto')

saveToolMemory({ eraserSize: 8 })
saveToolMemory({
  handwriting: { fontSize: 55, lineSpacing: 1.8, variation: 0, connectLetters: false, placement: 'page-start' },
})
saveToolMemory({
  tool: 'eraser',
  inkMode: 'drawing',
  symbolId: 'star',
  figureId: 'cube',
  figureParams: { yaw: 10, pitch: 24 },
  figureSize: 200,
  figureRotation: -15,
  mathPlacement: 'next-line',
})

const stored = loadToolMemory()
assert.equal(stored.eraserSize, 8, 'eraser pixels survive a later save')
assert.equal(stored.handwriting.fontSize, 55)
assert.equal(stored.handwriting.lineSpacing, 1.8)
assert.equal(stored.handwriting.variation, 0, 'zero variation is a real choice')
assert.equal(stored.handwriting.connectLetters, false)
assert.equal(stored.handwriting.fitToPage, true, 'an omitted handwriting switch keeps its value')
assert.equal(stored.handwriting.placement, 'page-start')
assert.equal(stored.tool, 'eraser')
assert.equal(stored.inkMode, 'drawing')
assert.equal(stored.symbolId, 'star')
assert.equal(stored.figureSize, 200)
assert.equal(stored.figureRotation, -15)
assert.equal(stored.figureParams.yaw, 10)
assert.equal(stored.mathPlacement, 'next-line')
memory.set(TOOL_MEMORY_KEY, JSON.stringify({ ...JSON.parse(memory.get(TOOL_MEMORY_KEY)), figureId: 'cube', figureGroup: 'plane' }))
assert.equal(loadToolMemory().figureGroup, 'solid', 'the group follows the figure, not a stale label')

const repaired = normalizeToolMemory({
  eraserSize: 0,
  figureId: 'not-a-figure',
  figureSize: 999,
  figureRotation: 3,
  symbolId: 'bad id',
  handwriting: { fontSize: 4, variation: 2 },
  mathPlacement: 'sideways',
})
assert.equal(repaired.eraserSize, 1)
assert.equal(repaired.figureId, 'cube')
assert.deepEqual(repaired.figureParams, defaultToolMemory().figureParams)
assert.equal(repaired.figureSize, 320)
assert.equal(repaired.figureRotation, 5)
assert.equal(repaired.symbolId, null)
assert.equal(repaired.handwriting.fontSize, 20)
assert.equal(repaired.handwriting.variation, 1)
assert.equal(repaired.mathPlacement, 'auto')

saveToolMemory({ figureId: 'circle' })
const circle = loadToolMemory()
assert.equal(circle.figureId, 'circle')
assert.equal(circle.figureGroup, 'plane')
assert.equal(circle.eraserSize, 8, 'switching figure keeps the eraser size')
assert.ok(!('yaw' in circle.figureParams), 'a plane figure does not keep a solid angle')

const board = readFileSync(new URL('../src/components/DrawingBoard.tsx', import.meta.url), 'utf8')
const dialog = readFileSync(new URL('../src/components/TextToHandwritingDialog.tsx', import.meta.url), 'utf8')
assert.match(board, /const \[initialToolMemory\] = useState\(loadToolMemory\)/)
assert.match(board, /useState\(initialToolMemory\.eraserSize\)/)
assert.match(board, /useState<MathFigureId>\(initialToolMemory\.figureId\)/)
assert.match(board, /artSymbolIds\.has\(initialToolMemory\.symbolId as ArtSymbolId\)/)
assert.match(board, /saveToolMemory\(\{/)
assert.match(board, /eraserSize,/)
assert.match(dialog, /loadToolMemory\(\)\.handwriting/)
assert.match(dialog, /saveToolMemory\(\{/)

await server.close()
console.log('tool-memory ok')
