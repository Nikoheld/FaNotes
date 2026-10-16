import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const cjs = require(join(dirname(fileURLToPath(import.meta.url)), '../electron/search-ink.cjs')).noteSearchExcerpt

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const { noteSearchExcerpt } = await server.ssrLoadModule('/src/lib/searchInkAnchor.ts')
  const excerpt = (text, index, length) => text.slice(Math.max(0, index - 8), index + length + 8)
  const cases = [
    {
      relativePath: 'Bio/Blatt.md',
      content: 'Die Photosynthese braucht Licht.',
      transcript: '0.4200\tChlorophyll',
      needle: 'chlorophyll',
      queryLength: 'Chlorophyll'.length,
    },
    {
      relativePath: 'Bio/Blatt.md',
      content: 'Die Photosynthese braucht Licht.',
      transcript: '0.4200\tChlorophyll',
      needle: 'licht',
      queryLength: 5,
    },
    {
      relativePath: 'Bio/Welt.md',
      content: 'Hallo',
      transcript: '',
      needle: 'welt',
      queryLength: 4,
    },
  ]
  for (const item of cases) {
    assert.equal(noteSearchExcerpt({ ...item, excerpt }), cjs({ ...item, excerpt }))
  }
  const handwriting = noteSearchExcerpt({ ...cases[0], excerpt })
  assert.match(handwriting, /Chlorophyll/)
  assert.doesNotMatch(handwriting, /^Dateiname/)
  assert.match(noteSearchExcerpt({ ...cases[1], excerpt }), /Licht/)
  assert.equal(noteSearchExcerpt({ ...cases[2], excerpt }), 'Dateiname · Bio/Welt.md')
  console.log('search excerpt ok')
} finally {
  await server.close()
}
