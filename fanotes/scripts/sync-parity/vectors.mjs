// Golden vectors from the TypeScript code for the Rust unit tests
// (crates/fanotes-sync/tests/vectors.rs): note identity hashes, page-statistics
// splice, homework merge, JavaScript number printing and the crypto layout.
//   node scripts/sync-parity/vectors.mjs [--check]
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

process.env.TZ = 'UTC'
const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..', '..')
const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false } })
const famd = await vite.ssrLoadModule('/src/lib/famd.ts')
const homework = await vite.ssrLoadModule('/src/lib/homeworkStore.ts')
const crypto = await vite.ssrLoadModule('/src/lib/sync/crypto.ts')
const conflicts = await vite.ssrLoadModule('/src/lib/sync/conflicts.ts')

const encoder = new TextEncoder()
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const b64 = (bytes) => Buffer.from(bytes).toString('base64')

let seed = 7
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }

const stroke = (count, extra = {}) => ({
  color: '#123', width: 2.5, ...extra,
  points: Array.from({ length: count }, (_, index) => ({ x: random(), y: random(), t: index * 7.25, pressure: index % 3 ? random() : undefined, ...(index % 5 === 0 ? { tiltX: -12.5 } : {}), ...(index % 7 === 0 ? { pointerType: index % 2 ? 'pen' : 'touch' } : {}), ...(index === 3 ? { custom: [1, 'a'] } : {}) })),
})
const stats = (n) => ({ createdAt: '2029-11-01T00:00:00.000Z', modifiedAt: 'kein Datum', openCount: n, dwellMs: n * 1.5, focusMs: '7', typing: { ms: 3.7, lastTypedAt: '2029-11-03' }, ink: { lengthMm: 12.345, colors: ['#111', '', 5], brushes: { pen: 3, '2': 1, marker: 0 } }, activeDays: ['2029-11-01', 'x'], opensByHour: [1, 2, '3'], document: { words: 9, peakWords: 4 } })

const payloads = [
  { markdown: '# Nur Text\n\nAbsatz.', payload: null },
  { markdown: '', payload: { ink: null, worksheets: [] } },
  { markdown: '# Ink', payload: { ink: { strokes: [stroke(12)], updatedAt: '2029-12-01T10:00:00Z', '10': 'zehn', '2': 'zwei' }, worksheets: [] } },
  { markdown: '# Stats', payload: { ink: { strokes: [stroke(6, { erased: false })] }, worksheets: ['ws-1'], pageStats: stats(4), paperStyle: 'grid' } },
  { markdown: 'Links <!-- fanotes-worksheet:abc--> und <!--fanotes-worksheet:x_y  -->', payload: { ink: null, worksheets: [], noteLinks: [{ id: 'nl-1', sourcePath: 'A.md', targetPath: 'B.MD', page: 2, x: 1.5, y: -1, style: 'text', label: '  viele   Leerzeichen  😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀' }, { id: 'nl-1', sourcePath: 'A.md', targetPath: 'C.md' }] } },
  { markdown: '', payload: { ink: null, worksheets: [], textFields: [{ id: 'tf-1', page: '3', x: '0.5', y: 2, width: 0.01, fontSize: 12, text: '  ' }, { id: 'tf-2', text: 'Feld' }] } },
  { markdown: '# Backup', payload: { ink: null, worksheets: [], noteBackups: [{ id: 'nb-1', notePath: '/x/y.md', createdAt: '2029-01-02', content: 'alt' }] } },
  { markdown: '# Zahlen', payload: { ink: { strokes: [{ points: [{ x: 1e-7, y: 0.1 + 0.2, t: 1e21, pressure: -0 }, { x: 0.5, y: 0.5, t: 123456789012345680000 }] }], nested: { a: [1.5e-10, 2e300, -3.25] } }, worksheets: [] } },
  { markdown: '', payload: { ink: { strokes: [], hidden: [{ points: [{ x: 0.2, y: 0.2 }] }] }, worksheets: [] } },
  { markdown: '\u{feff}# BOM', payload: { ink: null, worksheets: [], pageStats: stats(1) } },
  // Index 10 on: text box styles and tombstones, study annotations, ink in a collapsed subsection (odd index = .famd).
  { markdown: '# Stil', payload: { ink: null, worksheets: [], textFields: [{ id: 'tf-1', text: 'Rot', color: '#C62F4A', bold: true, updatedAt: 1890000000000.5 }, { id: 'tf-2', text: 'x', color: 'blue', bold: 1, updatedAt: '5' }], textFieldTombstones: [{ id: 'tf-9', deletedAt: 1880000000000 }, { id: 'tf-9', deletedAt: 1890000000000 }, { id: 'tf-8', deletedAt: -1 }] } },
  { markdown: '', payload: { ink: null, worksheets: [], annotations: [{ kind: 'stamp', x: 0.4, y: 0.4, stamp: 'gain' }, { kind: 'callout', ax: 0.2, ay: 0.3, text: 'Kern', num: 4 }] } },
  { markdown: '', payload: { ink: null, worksheets: [], textFields: [{ id: 'tf-3', text: '' }], textFieldTombstones: [{ id: 'tf-4', deletedAt: 1890000000000 }] } },
  { markdown: '', payload: { ink: null, worksheets: [], annotations: [{ kind: 'terms', list: [' ', ''] }, { kind: 'stroke', pts: [[0.1, 0.1]] }] } },
  { markdown: '# Tief', payload: { ink: { strokes: [], sections: [{ collapsed: true, hidden: { strokes: [], sections: [{ collapsed: true, hidden: { strokes: [{ points: [{ x: 0.5, y: 0.5 }] }] } }] } }] }, worksheets: [] } },
  { markdown: '', payload: { ink: { strokes: [], sections: [{ collapsed: true, hidden: { strokes: [], sections: [{ collapsed: true, hidden: { strokes: [{ points: [{ x: 0.5, y: 0.5 }] }] } }] } }] }, worksheets: [] } },
]

const notes = []
for (const [index, item] of payloads.entries()) {
  for (const encoding of ['v1', 'v2']) {
    const path = index % 2 ? `N${index}.famd` : `N${index}.md`
    const text = item.payload ? famd.serializeFamd(item.markdown, { schema: 'fanotes-famd-v1', updatedAt: '2029-12-01T00:00:00.000Z', ...item.payload }, encoding) : item.markdown
    notes.push({ path, bytes: encoder.encode(text) })
  }
}
const bad = [
  '<!-- fanotes-famd:v1 chars=20 -->\n{"truncated":',
  '# x\n\n<!-- fanotes-famd:v2 chars=10 crc=00000000 -->\n{"schema":1}\n',
  '{"schema":"fanotes-famd-v1","ink":null}',
  '# Text\n{"schema":"fanotes-famd-v1","ink":null}\n',
  '# Kein Ende <!-- fanotes-famd:v1 chars=5 -->\n',
  '',
  '   \n\t',
]
for (const [index, text] of bad.entries()) notes.push({ path: `Bad${index}.famd`, bytes: encoder.encode(text) })
notes.push({ path: 'Latin.md', bytes: new Uint8Array([0x23, 0x20, 0x47, 0x72, 0xfc, 0xdf, 0x65]) })
notes.push({ path: 'Bild.png', bytes: new Uint8Array([1, 2, 3]) })
notes.push({ path: 'Leer.png', bytes: new Uint8Array() })

const decoder = new TextDecoder()
const noteVectors = notes.map(({ path, bytes }) => {
  const kind = famd.noteSyncKind(path, bytes)
  let canonical = null
  try { canonical = sha(famd.canonicalSyncBytes(path, bytes)) } catch (error) { canonical = `throws ${error.message}` }
  const identityBytes = famd.identitySyncBytes(path, bytes)
  const local = notes[7].bytes
  let spliced = null
  if (famd.isFamdSyncPath(path) && kind !== 'unreadable') {
    try { spliced = sha(encoder.encode(famd.withLocalPageStats(decoder.decode(bytes), decoder.decode(local)))) } catch (error) { spliced = `throws ${error.message}` }
  }
  return { path, b64: b64(bytes), kind, canonical, identity: identityBytes ? sha(identityBytes) : null, spliced, fingerprint: await_(conflicts.conflictFingerprint(path, bytes)) }
})
function await_(promise) { return promise }
for (const vector of noteVectors) vector.fingerprint = await vector.fingerprint

const task = (id, done, updatedAt, extra = {}) => ({ id, title: `Aufgabe ${id}`, notes: '', subject: 'Mathe', dueDate: '2029-02-28', dueTime: '08:30', done, kind: 'homework', priority: 'normal', createdAt: '2029-10-01T00:00:00.000Z', updatedAt, ...extra })
const doc = (tasks, publishedIds) => encoder.encode(homework.serializeHomeworkMarkdown({ version: 1, tasks, ...(publishedIds ? { publishedIds } : {}) }))
const homeworkPairs = [
  [doc([task('x', true, '2029-10-02T10:00:00.000Z'), task('y', false, '2029-10-01T10:00:00.000Z')], ['p1']), doc([task('x', false, '2029-10-01T10:00:00.000Z'), task('y', true, '2029-10-02T09:00:00.000Z'), task('z', false, '2029-10-02T09:00:00.000Z', { dueDate: '2029-02-30', dueTime: '24:00' })], ['p2', 'p1'])],
  [doc([task('t', true, '2029-10-02T10:00:00.000Z')]), doc([task('t', false, '2029-10-02T10:00:00.000Z', { title: 'Remote' })])],
  [encoder.encode('# Hausaufgaben\n'), doc([task('a', false, '2029-10-02T10:00:00.000Z')])],
  [doc([]), encoder.encode('<!-- fanotes-homework-v1 {')],
]
const homeworkVectors = homeworkPairs.map(([local, remote]) => {
  const merged = homework.mergeHomeworkMarkdownBytes(local, remote)
  return { local: b64(local), remote: b64(remote), merged: merged ? sha(merged) : null }
})

const numbers = []
const view = new DataView(new ArrayBuffer(8))
for (let index = 0; index < 4000; index += 1) {
  view.setUint32(0, Math.floor(random() * 2 ** 32)); view.setUint32(4, Math.floor(random() * 2 ** 32))
  const value = view.getFloat64(0)
  if (Number.isFinite(value)) numbers.push([b64(new Uint8Array(view.buffer.slice(0))), String(value)])
}
for (const value of [0.1, 1e21, 1e-7, 123e-20, 5e-324, 2 ** 53, 0.000001, 1.5e300, 100, 7.25]) {
  view.setFloat64(0, value); numbers.push([b64(new Uint8Array(view.buffer.slice(0))), String(value)])
}

// Crypto with fixed randomness, so the ciphertext itself can be compared.
const realRandom = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
globalThis.crypto.getRandomValues = (array) => { for (let index = 0; index < array.length; index += 1) array[index] = (index * 37 + 11) & 0xff; return array }
const secret = crypto.newVaultSecret()
const keys = await crypto.deriveSyncKeys(await crypto.importVaultSecret(secret))
const path = 'Mathe/Älgebra.md'
const fileId = await crypto.fileIdFor(keys, path)
const blob = await crypto.encryptBytes(keys, fileId, encoder.encode('# Algebra\n\nx² + y²'))
const meta = await crypto.encryptMeta(keys, fileId, { path, mtimeMs: 1700000001000, size: 21, sha256: 'ab'.repeat(32) })
const kdf = { algorithm: 'pbkdf2-sha256', iterations: 100000, salt: crypto.toBase64(new Uint8Array(16).fill(9)) }
const derived = await crypto.deriveFromPassword('korrektes pferd ﬁ batterie', kdf)
const wrap = await crypto.wrapVaultSecret(secret, derived.wrappingKey)
globalThis.crypto.getRandomValues = realRandom
const cryptoVector = { secret: b64(secret), path, fileId, blob: b64(blob), meta, kdf, password: 'korrektes pferd ﬁ batterie', authKey: derived.authKey, wrap }

const out = { notes: noteVectors, homework: homeworkVectors, numbers, crypto: cryptoVector }
const target = join(here, 'expected', 'vectors.json')
const text = `${JSON.stringify(out)}\n`
if (process.argv.includes('--check')) {
  const ok = readFileSync(target, 'utf8') === text
  console.log(ok ? 'vectors: unchanged' : 'vectors: CHANGED (rerun without --check and review)')
  process.exitCode = ok ? 0 : 1
} else {
  writeFileSync(target, text)
  console.log(`vectors: ${noteVectors.length} notes, ${homeworkVectors.length} merges, ${numbers.length} numbers`)
}
await vite.close()
