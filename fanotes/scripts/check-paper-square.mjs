import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const main = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8')

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const square = await server.ssrLoadModule('/src/lib/paperSquare.ts')
const { defaultSettingsForPlatform } = await server.ssrLoadModule('/src/defaults.ts')
const { drawPaperBackground } = await server.ssrLoadModule('/src/lib/paperStyles.ts')

try {
  assert.equal(square.clampPaperSquareMm(undefined), 0)
  assert.equal(square.clampPaperSquareMm(-3), 0)
  assert.equal(square.clampPaperSquareMm(0), 0)
  assert.equal(square.clampPaperSquareMm(1), 2)
  assert.equal(square.clampPaperSquareMm(5.2), 5)
  assert.equal(square.clampPaperSquareMm(5.3), 5.5)
  assert.equal(square.clampPaperSquareMm(40), 20)
  assert.equal(square.paperSquareStyleMm('squares', 0), 5)
  assert.equal(square.paperSquareStyleMm('grid', 0), 7.5)
  assert.equal(square.paperSquareStyleMm('squares', 10), 10)
  assert.equal(square.paperSquareStyleMm('grid', 10), 10)
  assert.equal(square.paperSquareStyleMm('dots', 10), null)
  assert.equal(square.paperSquareStyleMm('lines', 0), null)
  assert.ok(Math.abs(square.paperSquarePx(820, 5) - (820 * 5) / 210) < 1e-9)
  assert.equal(square.paperSquareSizeLabel(0), 'Auto')
  assert.equal(square.paperSquareSizeLabel(7.5), '7.5 mm')
  assert.equal(defaultSettingsForPlatform('linux').paperSquareMm, 0)

  assert.match(css, /\.paper-squares \.paper-sheet-plane > \.paper-ruling/)
  assert.match(css, /\.paper-grid \.paper-sheet-plane > \.paper-ruling/)
  assert.match(css, /--paper-square-size, 20px/)
  assert.match(css, /--paper-square-size, 28px/)
  assert.match(css, /background-size:\s*28px 28px/)
  assert.match(app, /--paper-square-size/)
  assert.match(app, /aria-label="Kästchengrösse"/)
  assert.match(main, /paperSquareMm: \{ type: 'number', min: 0, max: 20 \}/)

  const canvas = {
    commands: [],
    save() {},
    restore() {},
    fillRect() {},
    beginPath() { this.commands.push('begin') },
    moveTo(x, y) { this.commands.push(['move', x, y]) },
    lineTo() {},
    stroke() { this.commands.push('stroke') },
    fill() {},
    arc() {},
  }
  canvas.fillStyle = ''
  canvas.strokeStyle = ''
  canvas.lineWidth = 1
  drawPaperBackground(canvas, 210, 40, 'squares', 10)
  const moves = canvas.commands.filter((entry) => Array.isArray(entry) && entry[0] === 'move')
  assert.ok(moves.some((entry) => entry[1] === 10.5), 'a 10 mm square steps by 10 px on a 210 px sheet')
  assert.equal(moves.some((entry) => entry[1] === 5.5), false, 'the custom size replaces the 5 mm default')

  console.log(JSON.stringify({
    autoSquares: square.paperSquareStyleMm('squares', 0),
    autoGrid: square.paperSquareStyleMm('grid', 0),
    custom: square.paperSquareStyleMm('grid', 10),
  }))
  console.log('paper-square ok')
} finally {
  await server.close()
}
