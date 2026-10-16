import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const actions = await server.ssrLoadModule('/src/lib/noteActions.ts')
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const editor = readFileSync(new URL('../src/components/MarkdownEditor.tsx', import.meta.url), 'utf8')

  assert.equal(actions.toggleTaskLine('Milch'), '- [ ] Milch')
  assert.equal(actions.toggleTaskLine('- Milch'), '- [ ] Milch')
  assert.equal(actions.toggleTaskLine('* Milch'), '* [ ] Milch')
  assert.equal(actions.toggleTaskLine('1. Milch'), '1. [ ] Milch')
  assert.equal(actions.toggleTaskLine('  - [ ] Milch'), '  - [x] Milch')
  assert.equal(actions.toggleTaskLine('- [x] Milch'), '- [ ] Milch')
  assert.equal(actions.toggleTaskLine('- [X] Milch'), '- [ ] Milch')
  assert.equal(actions.toggleTaskLine(''), '- [ ] ')
  assert.equal(actions.toggleTaskLine('# Titel'), '# Titel')
  assert.equal(actions.toggleTaskLine('---'), '---')
  assert.equal(actions.toggleTaskLine('| a | b |'), '| a | b |')
  assert.equal(actions.toggleTaskLine('```js'), '```js')
  assert.equal(actions.toggleTaskLine('> offen'), '> - [ ] offen')
  assert.equal(actions.toggleTaskLine('> - [ ] offen'), '> - [x] offen')
  assert.equal(actions.taskAfterHeading('## Aufgabe'), '- [ ] ')
  assert.equal(actions.taskAfterHeading('kein Titel'), null)

  const fenced = ['```', 'code', '```', '- [ ] draussen']
  assert.equal(actions.lineInsideFence(fenced, 1), true)
  assert.equal(actions.lineInsideFence(fenced, 3), false)
  const math = ['$$', 'x', '$$', 'danach']
  assert.equal(actions.lineInsideFence(math, 1), true)
  assert.equal(actions.lineInsideFence(math, 3), false)
  assert.deepEqual(actions.taskToggleChanges(['```', 'code', '```', '- sichtbar'], 1, 4), [
    { line: 4, insert: '- [ ] sichtbar' },
  ])
  assert.deepEqual(actions.taskToggleChanges(['# Titel'], 1, 1), [{ line: 1, insert: '\n- [ ] ' }])
  assert.deepEqual(actions.taskToggleChanges(['- [ ] a', '- [x] b'], 1, 2), [
    { line: 1, insert: '- [x] a' },
    { line: 2, insert: '- [ ] b' },
  ])

  assert.match(app, /id: 'toggle-task', label:/)
  assert.match(app, /!event\.shiftKey && event\.key\.toLowerCase\(\) === 'd'/)
  assert.match(editor, /key: 'Mod-Enter'/)
  assert.match(editor, /toggleTask:/)

  console.log('note-actions ok')
} finally {
  await server.close()
}
