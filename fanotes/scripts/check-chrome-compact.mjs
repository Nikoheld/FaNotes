import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const board = readFileSync(new URL('../src/components/DrawingBoard.tsx', import.meta.url), 'utf8')
const paperPicker = readFileSync(new URL('../src/components/PaperStylePicker.tsx', import.meta.url), 'utf8')

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { TOP_CHROME_SELECTORS } = await server.ssrLoadModule('/src/lib/chromeTextSelect.ts')

try {
  assert.ok(!TOP_CHROME_SELECTORS.includes('.note-meta-bar'))
  assert.ok(TOP_CHROME_SELECTORS.includes('.ribbon'))
  assert.ok(TOP_CHROME_SELECTORS.includes('.editor-toolbar'))

  assert.doesNotMatch(app, /className="note-meta-bar"/)
  assert.doesNotMatch(app, /className="statusbar"/)
  assert.doesNotMatch(app, /<footer[^>]*statusbar/)
  assert.doesNotMatch(app, /detected-text-language|Automatisch erkannte Sprache|activeWordCount/)
  assert.doesNotMatch(css, /\.note-meta-bar\b|\.statusbar\b|44px minmax\(0, 1fr\) 28px/)
  assert.match(css, /grid-template:\s*32px minmax\(0, 1fr\) \/ minmax\(0, 1fr\)/)

  const chromeStart = app.indexOf('<nav className="ribbon"')
  const chromeEnd = app.indexOf('editor-stage', chromeStart)
  assert.ok(chromeStart >= 0 && chromeEnd > chromeStart)
  const chrome = app.slice(chromeStart, chromeEnd)
  for (const token of [
    'Tag hinzufügen',
    'Tag entfernen',
    '<PaperStylePicker',
    'Vorherige Tagesnotiz',
    'Nächste Tagesnotiz',
    'Seitenleiste einblenden',
    'Update bereit',
    'Jetzt speichern',
    'sync-status-item',
    'addon-status-item',
    'Pfad der Notiz',
  ]) {
    assert.ok(chrome.includes(token), token)
  }
  assert.equal(chrome.includes('Kästchengrösse'), false)
  assert.equal(chrome.includes('<footer'), false)

  assert.doesNotMatch(board, /aria-label="Kästchengrösse"/)
  assert.match(paperPicker, /Notizhintergrund/)
  assert.match(paperPicker, /Nur für diese Notiz/)

  console.log('chrome-compact ok')
} finally {
  await server.close()
}
