import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const { maskMarkdownCode } = await server.ssrLoadModule('/src/lib/markdownCode.ts')
  const { backlinksFor, wikilinkTargets } = await server.ssrLoadModule('/src/lib/backlinks.ts')
  const { parseHashtags } = await server.ssrLoadModule('/src/lib/noteTags.ts')

  const note = [
    'Siehe [[Algebra]] und `[[Physik]]`.',
    '```',
    '[[Chemie]]',
    '```',
    '#Übung und `#geheim`',
    '```css',
    'color: #ff0000',
    '```',
  ].join('\n')
  assert.equal(maskMarkdownCode(note).length, note.length)
  assert.deepEqual(wikilinkTargets(note), ['Algebra'])
  assert.deepEqual(parseHashtags(note), ['übung'])
  const filler = 'Wort '.repeat(20)
  const links = backlinksFor('Mathe/Algebra.md', [
    { path: 'Deutsch/Text.md', content: `\`[[Algebra]]\` ${filler}wirklich [[Algebra]] im Heft.` },
    { path: 'Mathe/Physik.md', content: 'Nur `[[Algebra]]`.' },
  ])
  assert.equal(links.length, 1)
  assert.equal(links[0].path, 'Deutsch/Text.md')
  assert.match(links[0].excerpt, /wirklich \[\[Algebra\]\]/)
  assert.equal(links[0].excerpt.includes('`[[Algebra]]`'), false)
  const pathLinks = backlinksFor('Mathe/Algebra.md', [
    { path: 'Index.md', content: 'Siehe [[Mathe/Algebra]] und [[Mathe/Algebra.md]].' },
    { path: 'Deutsch/Text.md', content: '[[Deutsch/Algebra]] ist ein anderes Fach.' },
    { path: 'Extra.md', content: '[[Algebra.md]]' },
  ])
  assert.deepEqual(pathLinks.map((link) => link.path).sort(), ['Extra.md', 'Index.md'])
  console.log('markdown-code ok')
} finally {
  await server.close()
}
