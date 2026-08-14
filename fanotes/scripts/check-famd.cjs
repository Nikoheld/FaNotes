'use strict'

const assert = require('node:assert/strict')
const {
  companionNotePath,
  emptyFamdPayload,
  parseFamd,
  serializeFamd,
  stripFamdPayload,
  worksheetIdsFromMarkdown,
} = require('../electron/famd.cjs')

const markdown = '# Analysis\n\n$$\\int x$$\n\n<!-- fanotes-ink:abc -->\n<!-- fanotes-worksheet:ws-1 -->\n'
const ink = {
  schemaVersion: 1,
  title: 'Handschrift',
  strokes: [{ points: [{ x: 0.2, y: 0.3, t: 1, pressure: 0.5 }] }],
  searchTranscript: 'integral',
}
const encoded = serializeFamd(markdown, {
  ...emptyFamdPayload('2026-08-14T12:00:00.000Z'),
  ink,
  worksheets: worksheetIdsFromMarkdown(markdown),
})

assert.match(encoded, /<!-- fanotes-famd:v1 chars=\d+ -->/u)
assert.equal(stripFamdPayload(encoded).includes('fanotes-famd'), false)
assert.ok(stripFamdPayload(encoded).includes('# Analysis'))

const parsed = parseFamd(encoded)
assert.equal(parsed.payload?.schema, 'fanotes-famd-v1')
assert.equal(parsed.payload?.ink?.title, 'Handschrift')
assert.deepEqual(parsed.payload?.worksheets, ['ws-1'])
assert.equal(parsed.markdown.includes('$$\\int x$$'), true)
assert.equal(companionNotePath('Mathe/Analysis.md', '.famd'), 'Mathe/Analysis.famd')
assert.equal(companionNotePath('Mathe/Analysis.famd', '.md'), 'Mathe/Analysis.md')

const poisoned = `${encoded}\n<!-- fanotes-famd:v1 chars=2 -->\n{}`
const last = parseFamd(poisoned)
assert.equal(last.payload, null)

const fs = require('node:fs')
const path = require('node:path')
const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8')
assert.match(main, /fanotes:read-famd-ink/u)
assert.match(main, /writeFamdCompanion/u)
assert.match(main, /omitFamdCompanions/u)
assert.match(preload, /readFamdInk:\s*\(relativePath\)/u)
assert.match(app, /readFamdInk/u)
assert.match(app, /noteRelativePath/u)

console.log('FAMD-Prüfung erfolgreich: Markdown bleibt lesbar, Handschrift sitzt im Längen-präfixierten Block, Begleiterpfade und Desktop-Anbindung stimmen.')
