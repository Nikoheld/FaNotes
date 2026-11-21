// Regression checks for the Windows QA findings QA-002, 007, 008, 011, 014, 017.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { detectLineEnding, toLf, applyLineEnding } = require(join(root, 'electron/line-endings.cjs'))
const { payloadIsStatsOnly, parseFamd, serializeFamd, emptyFamdPayload } = require(join(root, 'electron/famd.cjs'))
const { createLocalPageStats } = require(join(root, 'electron/page-stats-local.cjs'))
const { stripInternalComments, noteSearchExcerpt, createExcerpt } = require(join(root, 'electron/search-ink.cjs'))

// QA-002: load (read-file) normalizes to LF, save (write-file) restores the file's ending, no extra line.
const crlfFile = '# CRLF2\r\nl1\r\nl2\r\nl3\r\nl4\r\nl5\r\n'
assert.equal(detectLineEnding(crlfFile), 'crlf')
assert.equal(detectLineEnding('a\nb\n'), 'lf')
assert.equal(detectLineEnding('a\r\nb\nc\n'), 'lf')
const loaded = toLf(crlfFile)
assert.equal(loaded, '# CRLF2\nl1\nl2\nl3\nl4\nl5\n')
const edited = loaded.replace(/\n$/u, '') + ' X'
const lfBody = toLf(edited)
const saved = applyLineEnding(lfBody.endsWith('\n') ? lfBody : `${lfBody}\n`, detectLineEnding(crlfFile))
assert.equal(saved, '# CRLF2\r\nl1\r\nl2\r\nl3\r\nl4\r\nl5 X\r\n')
assert.equal(applyLineEnding('a\nb\n', 'lf'), 'a\nb\n')
assert.equal(toLf('a\rb\r\nc'), 'a\nb\nc')

// QA-007: a plain note needs no sidecar; ink, text boxes, worksheets and links still do.
const stats = { createdAt: '2026-01-01T00:00:00.000Z', modifiedAt: '2026-01-01T00:00:00.000Z', openCount: 1 }
const statsOnly = parseFamd(serializeFamd('Hello', { ...emptyFamdPayload(), pageStats: stats }))
assert.ok(statsOnly.payload?.pageStats)
assert.equal(payloadIsStatsOnly(statsOnly.payload, statsOnly.markdown), true)
assert.equal(payloadIsStatsOnly(null, 'x'), true)
assert.equal(payloadIsStatsOnly({ ...statsOnly.payload, ink: { strokes: [{ points: [{ x: 1, y: 2 }] }] } }, 'x'), false)
assert.equal(payloadIsStatsOnly({ ...statsOnly.payload, paperStyle: 'ruled' }, 'x'), false)
assert.equal(payloadIsStatsOnly(statsOnly.payload, 'a <!-- fanotes-worksheet:ws1 --> b'), false)
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-stats-'))
  const write = async (target, data) => fs.promises.writeFile(target, data)
  const store = createLocalPageStats({ directory: dir, atomicWrite: write, delayMs: 5 })
  store.set('/vault', 'A/n.md', stats)
  await store.flush('/vault')
  const again = createLocalPageStats({ directory: dir, atomicWrite: write })
  assert.equal(again.get('/vault', 'A/n.md').openCount, 1)
  assert.equal(again.get('/other', 'A/n.md'), null)
  fs.rmSync(dir, { recursive: true, force: true })
}

// QA-017: internal markers never reach an excerpt.
assert.equal(stripInternalComments('# Handschrift 0 <!-- fanotes-ink:qa0 -->'), '# Handschrift 0 ')
assert.equal(stripInternalComments('a <!-- fanotes-onenote:x=1 --> b <!-- normal --> c'), 'a  b <!-- normal --> c')
const inkNote = '# Handschrift 0 <!-- fanotes-ink:qa0 -->'
assert.equal(createExcerpt(inkNote, 2, 'Handschrift'.length), '# Handschrift 0')
assert.equal(noteSearchExcerpt({ relativePath: 'a.md', content: inkNote, transcript: '', needle: 'handschrift', queryLength: 11, excerpt: createExcerpt }), '# Handschrift 0')
assert.equal(createExcerpt('x <!-- fanotes-ink:a --> Treffer <!-- fanotes-famd:v1 chars=2 -->', 26, 7), 'x Treffer')
assert.equal(typeof noteSearchExcerpt, 'function')

const server = await createServer({ appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
try {
  // QA-008: raw IPC errors become short messages without paths.
  const fileErrors = await server.ssrLoadModule('/src/lib/fileErrors.ts')
  const raw = "Error invoking remote method 'fanotes:write-file': Error: EPERM: operation not permitted, rename 'C:\\Users\\x\\.B note 4.md.29236.4c6f.tmp' -> 'C:\\Users\\x\\B note 4.md'"
  for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOENT', 'ENOSPC']) {
    const message = fileErrors.friendlyFileError(new Error(`Error invoking remote method 'fanotes:read-file': Error: ${code}: x, open 'C:\\a\\b.md'`), 'fallback')
    assert.ok(message && message !== 'fallback' && !/[A-Z]:\\|Error invoking|E[A-Z]{3,}/u.test(message), `${code}: ${message}`)
  }
  assert.ok(!/C:|\.tmp|Error invoking/u.test(fileErrors.sanitizeToastMessage(raw)))
  assert.equal(fileErrors.sanitizeToastMessage('Nichts Technisches'), 'Nichts Technisches')

  // QA-014: singular and plural in the table grid label.
  const toolbar = await server.ssrLoadModule('/src/components/FormattingToolbar.tsx')
  assert.equal(toolbar.tableGridLabel(1, 1), 'Tabelle mit 1 Zeile und 1 Spalte einfügen')
  assert.equal(toolbar.tableGridLabel(2, 3), 'Tabelle mit 2 Zeilen und 3 Spalten einfügen')
} finally {
  await server.close()
}
console.log('qa editor/files checks passed')
