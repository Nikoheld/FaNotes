// QA-036: what opening a huge note (50,000 lines, ~5 MB) costs on the main thread, measured without a
// browser so it is stable on a busy CI runner (each number is the median of 5 runs; limits are generous).
//   - CodeMirror's markdown parse is bounded to the start of the document when the state is created
//     (Lezer parses the viewport plus a fixed look-ahead; the rest is parsed in idle slices on demand);
//   - the whole-text scans of the open path (note tags, famd payload split, page statistics) have fast
//     paths for plain notes;
//   - dropping a huge note from the search index yields to the UI instead of blocking for hundreds of ms.
//   FANOTES_NOTE_COST_REPORT=1 prints every number.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const report = process.env.FANOTES_NOTE_COST_REPORT === '1'
const LIMIT = Number(process.env.FANOTES_NOTE_COST_SCALE || 1)
globalThis.window = Object.assign(Object.create(null), { fanotes: { platform: 'test' } })
const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
try {
  const { stripFamdPayload, readPageStatsFromNote } = await vite.ssrLoadModule('/src/lib/famd.ts')
  const { parseNoteTags } = await vite.ssrLoadModule('/src/lib/noteTags.ts')
  const { DocIndex } = await vite.ssrLoadModule('/src/lib/docSearch/docIndex.ts')
  const { EditorState } = await import('@codemirror/state')
  const { markdown } = await import('@codemirror/lang-markdown')
  const { syntaxTree } = await import('@codemirror/language')

  const lines = Array.from({ length: 50_000 }, (_, i) => (i % 50 === 0
    ? `## Abschnitt ${i}`
    : i % 7 === 0
      ? `- Punkt **${i}** mit *Betonung* und \`code\` sowie [Link](https://example.org/${i}) und mehr Text zum Auffuellen`
      : `Zeile ${i} mit etwas Text, der eine realistische Laenge hat und weiter geht bis zum Ende der Zeile.`))
  const note = `# Lang\n\n${lines.join('\n')}\n`
  const median = (run, times = 5) => {
    const values = []
    for (let index = 0; index < times; index += 1) { const start = performance.now(); run(); values.push(performance.now() - start) }
    return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
  }
  const rows = []
  const row = (name, ms, limit) => { rows.push({ name, ms: Math.round(ms * 10) / 10, limit }); assert.ok(ms <= limit * LIMIT, `${name}: ${ms.toFixed(1)} ms (limit ${limit * LIMIT} ms)`) }

  row('parseNoteTags(5 MB note)', median(() => parseNoteTags(note)), 60)
  row('stripFamdPayload(5 MB note)', median(() => stripFamdPayload(note)), 60)
  row('readPageStatsFromNote(5 MB note)', median(() => readPageStatsFromNote(note)), 80)
  // Same text with a tag, a trailing famd-like brace and code: the fast paths must not change results.
  assert.deepEqual(parseNoteTags('Text #Tag und `#code` und (#klammer)\n```\n#fence\n```\n'), ['tag', 'klammer'])
  assert.deepEqual(parseNoteTags(note), [])
  assert.equal(stripFamdPayload('Hallo\n\n'), 'Hallo')
  assert.equal(stripFamdPayload('Hallo\n{"a":1}'), 'Hallo\n{"a":1}')

  // CodeMirror: creating the state parses only the beginning; the tree grows in idle slices on demand.
  const extensions = [markdown()]
  let tree = null
  const createMs = median(() => { tree = syntaxTree(EditorState.create({ doc: note, extensions })) })
  row('EditorState.create(5 MB note, markdown)', createMs, 400)
  assert.ok(tree.length < note.length / 10, `the initial parse covers ${tree.length} of ${note.length} characters (bounded to the viewport)`)

  // Search index: units of the note, removed in slices.
  const index = new DocIndex()
  const units = []
  for (let from = 0, n = 0; from < note.length; from += 6_000, n += 1) units.push({ id: `Lang.md#note:${n}`, path: 'Lang.md', kind: 'note', source: 'text', text: note.slice(from, from + 6_000) })
  const fill = () => { index.setDoc({ path: 'Lang.md', title: 'Lang', kind: 'note', fingerprint: 'x', extractor: 'x', status: 'done', attempts: 0, issues: [], ocrPages: 0, updatedAt: 0 }); for (const unit of units) index.addUnit(unit) }
  fill()
  let pauses = 0
  let longest = 0
  let last = performance.now()
  const start = performance.now()
  await index.removeDocSliced('Lang.md', true, async () => { const now = performance.now(); longest = Math.max(longest, now - last); pauses += 1; await new Promise((resolve) => setTimeout(resolve, 0)); last = performance.now() })
  longest = Math.max(longest, performance.now() - last)
  const total = performance.now() - start
  assert.equal(index.unitsOf('Lang.md').length, 0, 'every unit is removed')
  assert.ok(pauses >= 3, `removal yields to the UI (${pauses} pauses for ${units.length} units, ${total.toFixed(0)} ms in total)`)
  row('removeDocSliced longest uninterrupted stretch', longest, 60)

  if (report) console.table(rows)
  console.log(`check-note-open-cost: ok (${rows.map((entry) => `${entry.name} ${entry.ms} ms`).join('; ')})`)
} finally {
  await vite.close()
}
process.exit(0)
