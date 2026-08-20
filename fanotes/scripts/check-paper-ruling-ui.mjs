import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const paperView = readFileSync(new URL('../src/components/PaperView.tsx', import.meta.url), 'utf8')

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { PAPER_STYLES } = await server.ssrLoadModule('/src/lib/paperStyles.ts')
const { PAPER_DOT_TILE_PX } = await server.ssrLoadModule('/src/lib/paperRuling.ts')

const runOnce = () => {
  assert.equal(PAPER_STYLES.find((item) => item.id === 'dots')?.label, 'Gepunktet')
  assert.equal(PAPER_STYLES.find((item) => item.id === 'blank')?.label, 'Leer')
  assert.match(paperView, /className="paper-sheet-plane"/)
  assert.match(paperView, /className="paper-ruling"/)
  assert.ok(paperView.indexOf('paper-ruling') < paperView.indexOf('{children}'))
  assert.match(css, /\.paper-dots \.paper-sheet-plane > \.paper-ruling/)
  assert.match(css, /background-size:\s*28px 28px/)
  assert.equal(PAPER_DOT_TILE_PX, 28)
  assert.match(css, /\.paper-blank \.paper-sheet-plane > \.paper-ruling/)
  assert.match(css, /\.unified-note-view\.is-pdf-note \.paper-sheet-plane > \.paper-ruling/)
  assert.match(css, /\.paper-blank \.unified-paper \{\s*background-color:\s*#fff/)
  assert.doesNotMatch(css, /\.paper-dots \.unified-paper > \.paper-ruling/)
  assert.match(appSource, /paper-\$\{isPdfActive \? 'blank' : activePaper\}/)
  assert.doesNotMatch(appSource, /!isPdfActive && <div className="paper-ruling"/)
  return { dotsOnPlane: true, blankUndotted: true, pdfHidden: true }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('paper-ruling-ui ok')
} finally {
  await server.close()
}
