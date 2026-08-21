import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const layerSource = readFileSync(new URL('../src/components/NoteLinkLayer.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  placeNewNoteLink,
  removeNoteLink,
  serializeNoteLinks,
} = await server.ssrLoadModule('/src/lib/noteLink.ts')
const { emptyFamdPayload, parseFamd, serializeFamd } = await server.ssrLoadModule('/src/lib/famd.ts')

const runOnce = () => {
  const keep = placeNewNoteLink({
    sourcePath: 'Faecher/Skript.pdf',
    page: 1,
    x: 0.2,
    y: 0.3,
    style: 'symbol',
    id: 'nl-keep',
  }, { targetPath: 'Faecher/Skript · Notiz.md' })
  const drop = placeNewNoteLink({
    sourcePath: 'Faecher/Skript.pdf',
    page: 2,
    x: 0.8,
    y: 0.4,
    style: 'text',
    id: 'nl-drop',
  }, { targetPath: 'Faecher/Skript · Notiz-2.md' })

  const remaining = removeNoteLink([keep, drop], drop.id)
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].id, keep.id)
  assert.equal(remaining[0].targetPath, keep.targetPath)

  const encoded = serializeFamd('', {
    ...emptyFamdPayload('2026-08-21T12:00:00.000Z'),
    noteLinks: remaining,
  })
  const parsed = parseFamd(encoded)
  const persisted = serializeNoteLinks(parsed.payload?.noteLinks)
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].id, 'nl-keep')
  assert.equal(persisted.some((link) => link.id === 'nl-drop'), false)

  const empty = serializeFamd('', {
    ...emptyFamdPayload('2026-08-21T12:00:00.000Z'),
    noteLinks: removeNoteLink(remaining, keep.id),
  })
  assert.equal(parseFamd(empty).payload?.noteLinks?.length ?? 0, 0)

  assert.throws(() => removeNoteLink([keep], 'nl-missing'), /gibt es nicht/)
  assert.throws(() => removeNoteLink([keep], ''), /gibt es nicht/)
  assert.throws(() => removeNoteLink([], keep.id), /gibt es nicht/)

  assert.match(appSource, /removeNoteLink/)
  assert.match(appSource, /aria-label="Verlinkung entfernen"/)
  assert.match(appSource, /<span>Entfernen<\/span>/)
  assert.match(appSource, /className="toolbar-button note-link-remove"/)
  assert.match(appSource, /onRemove=\{\(link\) => void removePlacedNoteLink\(link\)\}/)
  assert.match(appSource, /event\.key === 'Delete'/)
  assert.match(layerSource, /className="note-link-remove"/)
  assert.match(layerSource, /onRemove\?: \(link: NoteLinkRecord\) => void/)
  assert.match(css, /\.note-link-wrap > \.note-link-remove/)
  assert.match(css, /\.toolbar-button\.note-link-remove/)

  return {
    kept: remaining[0].id,
    dropped: drop.id,
    emptyAfterLast: parseFamd(empty).payload?.noteLinks?.length ?? 0,
  }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('note-link-remove ok')
} finally {
  await server.close()
}
