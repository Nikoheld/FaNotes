import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

try {
  const { APP_VERSION } = await server.ssrLoadModule('/src/lib/appVersion.ts')
  const { outlineTagsFromNote, parseNoteOutline, revealDocumentLine } = await server.ssrLoadModule('/src/lib/noteOutline.ts')
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(APP_VERSION, packageJson.version, 'APP_VERSION must be the shipped package.json version')

  const markdown = `<!-- fanotes-tags: klausur, physik -->
# Einleitung

Absatz.

## Aufgabe 1

Text #übung und mehr.
`
  const headings = parseNoteOutline(markdown)
  assert.deepEqual(headings.map((item) => ({ level: item.level, title: item.title, line: item.line })), [
    { level: 1, title: 'Einleitung', line: 2 },
    { level: 2, title: 'Aufgabe 1', line: 6 },
  ])
  const tags = outlineTagsFromNote(markdown)
  assert.ok(tags.includes('klausur'))
  assert.ok(tags.includes('physik'))
  assert.ok(tags.includes('übung'))

  const doc = {
    lines: 7,
    line(number) {
      const starts = [0, 0, 34, 46, 48, 54, 67]
      return { from: starts[number] ?? 0 }
    },
  }
  assert.deepEqual(revealDocumentLine(doc, 2), { line: 2, from: 34 })
  assert.equal(revealDocumentLine(doc, 0)?.line, 1)
  assert.equal(revealDocumentLine(doc, 99)?.line, 7)
  assert.equal(revealDocumentLine(doc, Number.NaN), null)

  const editor = readFileSync(join(root, 'src', 'components', 'MarkdownEditor.tsx'), 'utf8')
  const inspector = readFileSync(join(root, 'src', 'components', 'RightInspector.tsx'), 'utf8')
  const app = readFileSync(join(root, 'src', 'App.tsx'), 'utf8')
  assert.match(editor, /revealDocumentLine/)
  assert.match(editor, /revealLine:/)
  assert.match(inspector, /parseNoteOutline/)
  assert.match(inspector, /onJumpToLine\?\.\(heading\.line\)/)
  assert.match(app, /editorRef\.current\?\.revealLine\(line\)/)

  console.log(JSON.stringify({ version: APP_VERSION, headings: headings.length, tags }))
  console.log('note-outline ok')
} finally {
  await server.close()
}
