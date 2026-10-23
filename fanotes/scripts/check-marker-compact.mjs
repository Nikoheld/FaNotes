import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const board = readFileSync(new URL('../src/components/DrawingBoard.tsx', import.meta.url), 'utf8')

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { artStudioOpenForBrush, inkColorForBrush, usesPenStrip } = await server.ssrLoadModule('/src/lib/inkOptionSurface.ts')

try {
  assert.equal(usesPenStrip('marker'), true)
  assert.equal(usesPenStrip('highlighter'), true)
  assert.equal(usesPenStrip('fineliner'), false)
  assert.equal(artStudioOpenForBrush('marker', true), false)
  assert.equal(artStudioOpenForBrush('highlighter', true), false)
  assert.equal(artStudioOpenForBrush('fineliner', true), true)
  assert.equal(artStudioOpenForBrush('paintbrush', false), false)
  assert.equal(inkColorForBrush('marker', '#202333', '#3478df'), '#202333')
  assert.equal(inkColorForBrush('highlighter', '#202333', '#f2b735'), '#f2b735')
  assert.equal(inkColorForBrush('fineliner', '#202333', '#3478df'), '#3478df')
  assert.match(board, /inkColorForBrush\(artBrush, penColor, artColor\)/)
  assert.match(board, /stripUsesPenColor \? penColor : artColor/)
  assert.match(board, /stripUsesPenColor \? colorChoices : artColorChoices/)

  assert.match(board, /usesPenStrip\(artBrush\)/)
  assert.match(board, /artStudioOpenForBrush\(artBrush, artPanelOpen\)/)
  assert.match(board, /setArtPanelOpen\(!usesPenStrip\(artBrush\)\)/)
  assert.match(board, /if \(usesPenStrip\(brush\.id\)\) setArtPanelOpen\(false\)/)

  const markerAt = board.indexOf("tool === 'pen' && usesPenStrip(artBrush)")
  const markerEnd = board.indexOf(") : tool === 'pen' ?", markerAt)
  assert.ok(markerAt > 0 && markerEnd > markerAt)
  const marker = board.slice(markerAt, markerEnd)
  for (const token of ['lw-pen-strip', 'Pinsel', 'Zeichenfarbe', 'Breite', 'Größe', 'Deckkraft', 'Piktogramme', 'Farben nicht mischen']) {
    assert.ok(marker.includes(token), token)
  }
  assert.equal(marker.includes('lw-art-studio'), false)
  assert.match(board, /aria-label="Stift"/)
  assert.match(board, /className="lw-pen-strip"/)

  const studioAt = board.indexOf('artStudioOpenForBrush(artBrush, artPanelOpen)')
  const studio = board.slice(studioAt, studioAt + 1800)
  assert.match(studio, /className=\{`lw-art-studio/)
  assert.match(studio, /role="tablist" aria-label="Bereiche des Zeichenstudios"/)
  assert.equal((board.match(/id="lw-art-tab-/g) || []).length, 3)

  console.log('marker-compact ok')
} finally {
  await server.close()
}
