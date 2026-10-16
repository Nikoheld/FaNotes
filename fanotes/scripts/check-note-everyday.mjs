import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  root,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const { fenceIsOpen, toggleTaskLine } = await server.ssrLoadModule('/src/lib/noteEveryday.ts')

  assert.equal(toggleTaskLine('- [ ] offen'), '- [x] offen')
  assert.equal(toggleTaskLine('- [x] fertig'), '- [ ] fertig')
  assert.equal(toggleTaskLine('- [X] fertig'), '- [ ] fertig')
  assert.equal(toggleTaskLine('  1. Punkt'), '  1. [ ] Punkt')
  assert.equal(toggleTaskLine('# Titel'), '# Titel')
  assert.equal(toggleTaskLine('> Zitat'), '> Zitat')
  assert.equal(toggleTaskLine('| A | B |'), '| A | B |')
  assert.equal(toggleTaskLine('---'), '---')
  assert.equal(toggleTaskLine(''), '- [ ] ')
  assert.equal(toggleTaskLine('  '), '  - [ ] ')
  assert.equal(toggleTaskLine('Hausaufgabe'), '- [ ] Hausaufgabe')
  assert.equal(fenceIsOpen(['Text', '```', 'code']), true)
  assert.equal(fenceIsOpen(['```', 'code', '```']), false)

  const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
  const editor = readFileSync(join(root, 'src/components/MarkdownEditor.tsx'), 'utf8')
  assert.equal(app.includes("id: 'toggle-task'"), true)
  assert.equal(app.includes("event.code === 'KeyD'"), true)
  assert.equal(app.includes('copyPlainText'), true)
  assert.equal(editor.includes("key: 'Mod-Enter'"), true)
  assert.equal(editor.includes('toggleTaskLine'), true)
  const duplicateIds = [...app.matchAll(/id: 'duplicate-note'/g)]
  assert.equal(duplicateIds.length, 1)
  const dateIds = [...app.matchAll(/id: 'insert-date'/g)]
  assert.equal(dateIds.length, 1)

  console.log('note-everyday ok')
} finally {
  await server.close()
}
