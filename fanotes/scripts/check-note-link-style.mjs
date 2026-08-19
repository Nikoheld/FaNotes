import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const layerSource = readFileSync(new URL('../src/components/NoteLinkLayer.tsx', import.meta.url), 'utf8')

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  NOTE_LINK_STYLES,
  noteLinkAppearanceToken,
  placeNewNoteLink,
  restyleNoteLink,
  serializeNoteLinks,
} = await server.ssrLoadModule('/src/lib/noteLink.ts')
const { emptyFamdPayload, parseFamd, serializeFamd } = await server.ssrLoadModule('/src/lib/famd.ts')

const runOnce = () => {
  const ids = NOTE_LINK_STYLES.map((style) => style.id)
  assert.ok(ids.includes('symbol'))
  assert.ok(ids.includes('text'))
  assert.notEqual(noteLinkAppearanceToken('symbol'), noteLinkAppearanceToken('text'))

  const symbol = placeNewNoteLink({
    sourcePath: 'Faecher/Skript.pdf',
    page: 2,
    x: 0.4,
    y: 0.5,
    style: 'symbol',
    id: 'nl-style-symbol',
  }, { targetPath: 'Faecher/Skript · Notiz.md' })
  const text = restyleNoteLink({ ...symbol, id: 'nl-style-text' }, 'text')
  assert.equal(symbol.style, 'symbol')
  assert.equal(text.style, 'text')
  assert.notEqual(noteLinkAppearanceToken(symbol.style), noteLinkAppearanceToken(text.style))

  const encoded = serializeFamd('', {
    ...emptyFamdPayload('2026-08-19T12:00:00.000Z'),
    noteLinks: [symbol, text],
  })
  const parsed = parseFamd(encoded)
  const persisted = serializeNoteLinks(parsed.payload?.noteLinks)
  const symbolToken = persisted.find((link) => link.style === 'symbol')?.appearance
  const textToken = persisted.find((link) => link.style === 'text')?.appearance
  assert.equal(symbolToken, 'symbol')
  assert.equal(textToken, 'text')
  assert.notEqual(symbolToken, textToken)

  assert.match(appSource, /className="note-nav-back"/)
  assert.match(appSource, /<div className="tabs-bar">[\s\S]*note-nav-back[\s\S]*Zurück/)
  assert.match(appSource, /aria-label="Verlinkungsstil"/)
  assert.match(appSource, /NOTE_LINK_STYLES/)
  assert.match(layerSource, /is-\$\{appearance\}/)
  assert.match(layerSource, /appearance !== 'text'/)
  assert.match(layerSource, /appearance !== 'symbol'/)

  return { ids, symbolToken, textToken }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('note-link-style ok')
} finally {
  await server.close()
}
