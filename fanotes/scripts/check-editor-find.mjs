import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SearchQuery } from '@codemirror/search'
import { EditorSelection, EditorState } from '@codemirror/state'
import { findMatchStatus } from '../src/lib/editorFindBar.ts'

const state = (doc, from = 0, to = from) => EditorState.create({
  doc,
  selection: EditorSelection.range(from, to),
})

const status = (doc, search, extra = {}) => findMatchStatus(state(doc, extra.from, extra.to), new SearchQuery({ search, ...extra }))

assert.equal(status('alpha beta', ''), '')
assert.equal(status('alpha beta', 'zzz'), 'Keine Treffer')
assert.equal(status('alpha beta alpha', 'alpha'), '2 Treffer')
assert.equal(status('alpha beta alpha', 'alpha', { from: 0, to: 5 }), '1 / 2')
assert.equal(status('alpha beta alpha', 'alpha', { from: 11, to: 16 }), '2 / 2')
assert.equal(status('Alpha', 'alpha'), '1 Treffer')
assert.equal(status('Alpha', 'alpha', { caseSensitive: true }), 'Keine Treffer')
assert.equal(findMatchStatus(state('abc'), new SearchQuery({ search: '[', regexp: true })), 'Ungültiger Ausdruck')

const editor = readFileSync(new URL('../src/components/MarkdownEditor.tsx', import.meta.url), 'utf8')
const bar = readFileSync(new URL('../src/lib/editorFindBar.ts', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
assert.match(editor, /search\(\{ top: true, createPanel: createEditorFindPanel \}\)/)
assert.match(bar, /export const createEditorFindPanel/)
assert.match(bar, /main-field/)
assert.match(bar, /textButton\('replaceAll', 'Alle ersetzen'/)
assert.match(bar, /Alle ersetzen/)
assert.match(css, /\.markdown-editor \.cm-panels\.cm-panels-top \{[^}]*position: absolute;/s)
assert.match(css, /\.fanotes-find\.is-readonly \.fanotes-find__replace \{ display: none; \}/)

console.log('editor-find ok')
