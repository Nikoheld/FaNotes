// Folded Markdown headings are remembered per note in the local profile (never in the note), keyed by heading text and
// occurrence so line shifts do not matter; renames/moves carry them, trashing and deleted notes drop them.
// Usage: node scripts/check-heading-folds.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({ root, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
try {
  const lib = await server.ssrLoadModule('/src/lib/headingFolds.ts')
  const { EditorState } = await import('@codemirror/state')
  const { markdown } = await import('@codemirror/lang-markdown')
  const { foldable, ensureSyntaxTree } = await import('@codemirror/language')
  const memory = () => { const map = new Map(); return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), map } }

  // 1. Keys: level + text + occurrence; fenced code and non-headings are ignored.
  const doc = ['# Intro', 'text', '## Part', 'a', '## Part', 'b', '```', '# not a heading', '```', '#nospace', '## Part  ##', ''].join('\n')
  const headings = lib.listHeadings(doc)
  assert.deepEqual(headings.map((h) => h.key), ['1:Intro#1', '2:Part#1', '2:Part#2', '2:Part#3'])
  assert.deepEqual(headings.map((h) => h.line), [1, 3, 5, 11])

  // 2. Line shifts: the second "Part" stays the second "Part" after lines are inserted above.
  const keys = lib.foldKeysForLines(doc, [5])
  assert.deepEqual(keys, ['2:Part#2'])
  const shifted = `new line\nanother\n${doc}`
  assert.deepEqual(lib.linesForFoldKeys(shifted, keys), [7])
  assert.deepEqual(lib.linesForFoldKeys('# Other\n', keys), [], 'a removed heading restores nothing')

  // 3. CodeMirror: the restored line really is foldable, and a fold range starts on the heading line.
  const state = EditorState.create({ doc: shifted, extensions: [markdown()] })
  ensureSyntaxTree(state, state.doc.length, 1000)
  const line = state.doc.line(7)
  const range = foldable(state, line.from, line.to)
  assert.ok(range && state.doc.lineAt(range.from).number === 7, 'heading line folds; range starts on it')

  // 4. Storage: per path, remap on rename/move (folder prefix too), drop on trash and for missing notes, empty forgets.
  const store = memory()
  lib.rememberHeadingFolds('A/n.md', keys, store, 1)
  lib.rememberHeadingFolds('A/sub/m.md', ['1:Intro#1'], store, 2)
  lib.rememberHeadingFolds('B/x.md', ['1:X#1'], store, 3)
  assert.deepEqual(lib.recallHeadingFolds('A/n.md', store), keys)
  assert.deepEqual(lib.recallHeadingFolds('nope.md', store), [])
  lib.remapHeadingFolds('A/n.md', 'A/renamed.md', store)
  assert.deepEqual(lib.recallHeadingFolds('A/renamed.md', store), keys)
  assert.deepEqual(lib.recallHeadingFolds('A/n.md', store), [])
  lib.remapHeadingFolds('A', 'C', store)
  assert.deepEqual(lib.recallHeadingFolds('C/sub/m.md', store), ['1:Intro#1'])
  lib.remapHeadingFolds('C/renamed.md', null, store)
  assert.deepEqual(lib.recallHeadingFolds('C/renamed.md', store), [])
  lib.pruneHeadingFolds(new Set(['B/x.md']), store)
  assert.deepEqual(Object.keys(lib.loadHeadingFolds(store)), ['B/x.md'], 'entries of deleted notes are pruned')
  lib.rememberHeadingFolds('B/x.md', [], store)
  assert.deepEqual(lib.loadHeadingFolds(store), {}, 'unfolding everything forgets the note')
  assert.deepEqual(lib.parseHeadingFolds('{not json'), {})
  const big = memory()
  for (let i = 0; i < lib.HEADING_FOLDS_MAX_NOTES + 20; i += 1) lib.rememberHeadingFolds(`n${i}.md`, ['1:A#1'], big, i)
  assert.equal(Object.keys(lib.loadHeadingFolds(big)).length, lib.HEADING_FOLDS_MAX_NOTES)

  // 5. Wiring: editor restores and saves, App passes the note path and remaps/prunes; nothing is written into the note.
  const editor = readFileSync(join(root, 'src/components/MarkdownEditor.tsx'), 'utf8')
  assert.match(editor, /recallHeadingFolds\(foldPath\)/)
  assert.match(editor, /rememberHeadingFolds\(foldPath/)
  const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
  assert.match(app, /foldKey=\{activeTab\.path\}/)
  assert.match(app, /foldKey=\{splitTab\.path\}/)
  assert.match(app, /remapHeadingFolds\(from, to\)/)
  assert.match(app, /pruneHeadingFolds\(new Set\(collectNotePaths\(next\)\)\)/)
  console.log('heading-folds ok')
} finally { await server.close() }
