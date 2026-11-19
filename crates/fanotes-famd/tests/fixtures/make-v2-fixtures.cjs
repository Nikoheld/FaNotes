'use strict'

// Golden fixtures for the Rust `fanotes-famd:v2` codec, produced by the real
// Electron codec (`fanotes/electron/famd.cjs` and `famdV2.mjs`).
//
//   node crates/fanotes-famd/tests/fixtures/make-v2-fixtures.cjs
//
// writes `v2-golden.json` beside this script. The Rust test reads only that
// file and does not need Node.

const fs = require('node:fs')
const path = require('node:path')

const NOW = '2026-11-15T10:20:30.456Z'
const RealDate = Date
// The codec stamps `new Date()` into a changed note. A fixed clock keeps the
// fixtures stable; the Rust side passes the same `now`.
global.Date = class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(NOW)
    else super(...args)
  }
  static now() { return new RealDate(NOW).getTime() }
}

const repo = path.resolve(__dirname, '..', '..', '..', '..')
const famd = require(path.join(repo, 'fanotes', 'electron', 'famd.cjs'))
const v2 = require(path.join(repo, 'fanotes', 'electron', 'famdV2.mjs'))

const UPDATED = '2026-10-31T08:00:00.000Z'

const stroke = (points, extra = {}) => ({ id: `s-${points.length}`, color: '#1f2933', width: 2.4, tool: 'pen', ...extra, points })

const inkCases = {
  'no-ink': null,
  'ink-full': {
    schemaVersion: 1,
    title: 'Handschrift',
    sourceWidth: 900,
    sourceHeight: 1273,
    paperStyle: 'dots',
    searchTranscript: 'Integral über x',
    strokes: [
      stroke([
        { x: 0.1, y: 0.2, pressure: 0.5, t: 1730000000000.125, tiltX: 12.5, tiltY: -3.25 },
        { x: 0.1004, y: 0.2011, pressure: 0.61, t: 1730000000016.5 },
        { x: 0.3333333333, y: 0.6666666667, t: 1730000000033 },
        { x: 0, y: 1 },
      ]),
      stroke([{ x: 0.9, y: 0.95, pressure: 1, t: 0, tiltX: 0, tiltY: 0 }], { width: 6, tool: 'marker', opacity: 0.35 }),
    ],
  },
  'pointer-same': {
    strokes: [stroke([
      { x: 0.2, y: 0.2, pointerType: 'pen', pressure: 0.4 },
      { x: 0.25, y: 0.21, pointerType: 'pen', pressure: 0.45 },
    ])],
  },
  'pointer-mixed': {
    strokes: [stroke([
      { x: 0.2, y: 0.2, pointerType: 'pen' },
      { x: 0.3, y: 0.2, pointerType: 'touch' },
      { x: 0.4, y: 0.2 },
      { x: 0.5, y: 0.2, pointerType: 'mouse' },
      { x: 0.6, y: 0.2, pointerType: 'pen' },
    ])],
  },
  'pointer-overflow': {
    strokes: [stroke(Array.from({ length: 256 }, (_, index) => ({ x: index / 300, y: 0.5, pointerType: `p${index}` })))],
  },
  'point-extras': {
    strokes: [stroke([
      { x: 0.1, y: 0.1, pressure: 0.3, id: 'p1', w: 2 },
      { x: 0.2, y: 0.1, pressure: 0.3 },
      { x: 0.3, y: 0.1, label: 'ä', nested: { a: 1 } },
    ])],
  },
  'numbers': {
    tiny: 0.000001,
    smaller: 1e-7,
    huge: 1e21,
    negative: -0.0000005,
    whole: 12,
    strokes: [stroke([{ x: 1 / 65535, y: 65534 / 65535, pressure: 0.1 + 0.2, t: 1e-9 }], { width: 0.000015 })],
  },
  'odd-values': {
    strokes: [
      stroke([
        { x: '0.25', y: null, pressure: '0.5', t: Infinity },
        null,
        { x: 1.3, y: -0.2, pointerType: 7 },
      ]),
      { id: 'no-points', color: '#ff0000' },
      { id: 'points-object', points: { x: 1 } },
    ],
  },
  'unicode': {
    searchTranscript: 'Grüße 😀 漢字 "quoted" \\ back\u0001slash',
    strokes: [stroke([{ x: 0.5, y: 0.5, pressure: 0.5 }], { label: '😀 ü' })],
  },
}

const markdowns = {
  'no-ink': '# Leer\n\nNur Text.',
  'ink-full': '# Analysis\n\n$$\\int x\\,dx$$\n\n<!-- fanotes-worksheet:ws-1 -->\n',
  'pointer-same': '# Stift',
  'pointer-mixed': 'Gemischt',
  'pointer-overflow': 'Viele Zeiger',
  'point-extras': 'Extras',
  'numbers': 'Zahlen',
  'odd-values': '',
  'unicode': '# Grüße 😀\n\n漢字 und “Anführung” Zeile',
}

const richFields = {
  paperStyle: 'grid',
  noteLinks: [{ id: 'nl-1', sourcePath: 'Mathe/Skript.pdf', targetPath: 'Mathe/Notiz.md', page: 3, x: 0.72, y: 0.18, style: 'text', label: 'Notiz' }],
  noteBackups: [{ id: 'nb-1', notePath: 'Mathe/Notiz.md', createdAt: '2026-10-01T10:00:00.000Z', content: 'Stand A' }],
  pageStats: { createdAt: '2026-09-01T00:00:00.000Z', modifiedAt: '2026-10-01T00:00:00.000Z', lastOpenedAt: '2026-10-02T00:00:00.000Z', dwellMs: 1234.7, openCount: 3, typedChars: 99 },
  textFields: [
    { id: 'tf-1', page: 1, x: 0.2, y: 0.3, width: 0.4, fontSize: 18, text: 'Feld 😀' },
    { id: 'tf-2', page: 2, x: 0.5, y: 0.5, width: 0.3, fontSize: 12, text: 'Rot', color: '#C62F4A', bold: true, updatedAt: 1790000000000.7 },
    { id: 'tf-3', page: 1, x: 0.1, y: 0.9, width: 0.2, fontSize: 16, text: 'Kein Stil', color: 'red', bold: 'yes', updatedAt: -4 },
  ],
  textFieldTombstones: [
    { id: 'tf-old', deletedAt: 1780000000000 },
    { id: 'tf-new', deletedAt: 1790000000000.9 },
    { id: 'tf-old', deletedAt: 1785000000000 },
    { id: 'bad id', deletedAt: 1 },
    { id: 'tf-zero', deletedAt: 0 },
    { id: 'tf-string', deletedAt: '1790000000000' },
    null,
  ],
  annotations: [
    { kind: 'callout', id: 'an-1', page: 2, ax: 0.25, ay: 0.75, lx: 1.4, ly: '0.1', text: 'Zellkern', color: '#ABCDEF', num: 3 },
    { kind: 'callout', ax: 0.333333, ay: 0.5, text: 'ohne Id', num: 2.5 },
    { kind: 'stamp', page: 1, x: 0.4, y: 0.4, stamp: 'gain', size: 80 },
    { kind: 'stamp', stamp: 'unknown' },
    { kind: 'legend', x: 0.7, names: { gain: 'mehr', loss: 'weniger', other: 'x', check: 7 } },
    { kind: 'image', id: 'img-1', x: 0.2, y: 0.3, w: 0.5, aspect: 1.5, opacity: 0.05, locked: true, src: 'data:image/png;base64,iVBORw0KGgo=', title: 'Bild' },
    { kind: 'image', id: 'img-bad', src: 'data:image/gif;base64,R0lG' },
    { kind: 'stroke', pts: [[0.1, 0.2], [0.123456, 1.5], ['x', 0.3], [0.3]], color: '#00ff00', width: 1 },
    { kind: 'stroke', pts: [[0.1, 0.2]] },
    { kind: 'measure', mode: 'distance', pts: [[0, 0], [0.5, 0.5], [0.9, 0.9]] },
    { kind: 'measure', pts: [[0, 0], [0.5, 0.5], [0.9, 0.1], [0.2, 0.2], [0.3, 0.3]] },
    { kind: 'terms', list: ['  Mitose ', 'Mitose', '', 'Meiose', 5] },
    { kind: 'callout', id: 'an-1', text: 'doppelt' },
    { kind: 'unknown' },
    'text',
  ],
}

const plain = (value) => JSON.parse(JSON.stringify(value))
const newInk = { strokes: [stroke([{ x: 0.42, y: 0.24, pressure: 0.7, t: 5 }])], paperStyle: 'lines' }
const trailerMarkdown = famd.serializeFamd('Mit Anhang', { updatedAt: UPDATED, ink: null, worksheets: [], noteLinks: richFields.noteLinks, pageStats: richFields.pageStats }, 'v1')

const parsed = (source, options) => {
  try {
    const result = famd.parseFamd(source, options)
    return { markdown: result.markdown, payload: result.payload }
  } catch (error) {
    return { error: error.message, corrupt: error.code === 'FAMD_CORRUPT' }
  }
}

const attempt = (run) => {
  try {
    return { text: run() }
  } catch (error) {
    return { error: error.message }
  }
}

const cases = []
for (const [name, ink] of Object.entries(inkCases)) {
  for (const rich of [false, true]) {
    if (rich && !['ink-full', 'no-ink', 'unicode'].includes(name)) continue
    const label = rich ? `${name}+fields` : name
    const markdown = markdowns[name]
    const payload = { schema: famd.FAMD_SCHEMA, updatedAt: UPDATED, ink, worksheets: famd.worksheetIdsFromMarkdown(markdown), ...(rich ? richFields : {}) }
    const v1 = famd.serializeFamd(markdown, payload, 'v1')
    const fromV1 = famd.parseFamd(v1)
    const v2Text = famd.serializeFamd(fromV1.markdown, fromV1.payload, 'v2')
    const packed = famd.parseFamd(v2Text, { unpack: false })
    // The 256-pointer case only checks the encoding, to keep this file small.
    const full = name !== 'pointer-overflow'
    const heavy = (run) => (full ? run() : null)
    cases.push({
      name: label,
      markdown,
      v1,
      v2: v2Text,
      strippedV2: famd.stripFamdPayload(v2Text),
      parsedV1: heavy(() => plain(parsed(v1))),
      parsedV2: plain(parsed(v2Text)),
      parsedV2Packed: heavy(() => plain(parsed(v2Text, { unpack: false }))),
      repacked: heavy(() => famd.serializeFamd(packed.markdown, packed.payload, 'v2')),
      convert: famd.convertFamdSource(v1),
      convertV2: heavy(() => famd.convertFamdSource(v2Text)),
      rewriteSame: heavy(() => attempt(() => famd.rewriteFamdText(v2Text, fromV1.markdown, NOW))),
      rewriteChanged: heavy(() => attempt(() => famd.rewriteFamdText(v2Text, `${fromV1.markdown}\n\nNeu <!-- fanotes-worksheet:ws-2 -->`, NOW))),
      rewriteV1: heavy(() => attempt(() => famd.rewriteFamdText(v1, 'Anders', NOW))),
      composeKeep: heavy(() => attempt(() => famd.composeFamdCompanion(v2Text, fromV1.markdown, undefined, 'squares'))),
      composeInk: heavy(() => attempt(() => famd.composeFamdCompanion(v2Text, 'Neuer Text', newInk, 'squares'))),
      composeNull: heavy(() => attempt(() => famd.composeFamdCompanion(v2Text, fromV1.markdown, null, undefined))),
      composeV1Ink: heavy(() => attempt(() => famd.composeFamdCompanion(v1, `${fromV1.markdown}`, newInk, 'grid'))),
      composeTrailer: heavy(() => attempt(() => famd.composeFamdCompanion(v2Text, trailerMarkdown, undefined, 'grid'))),
      inkHasMarks: famd.inkHasMarks(fromV1.payload.ink),
      packedInk: heavy(() => plain(v2.packV2Ink(fromV1.payload.ink))),
      encoding: famd.famdEncodingForSave(v2Text),
      encodingV1: famd.famdEncodingForSave(v1),
      activeV2: v2.isActiveV2(v2Text),
    })
  }
}

// A v2 text whose point block has a character outside the alphabet, with a
// fresh checksum so the damage is found while unpacking.
const recrc = (text, edit) => {
  const marker = /<!-- fanotes-famd:v2 chars=(\d+) crc=([0-9a-f]{8}) -->\n/u
  const match = marker.exec(text)
  const start = match.index + match[0].length
  const json = edit(text.slice(start, start + Number(match[1])))
  return `${text.slice(0, match.index)}<!-- fanotes-famd:v2 chars=${json.length} crc=${v2.crcHex(json)} -->\n${json}\n`
}

const base = cases.find((entry) => entry.name === 'ink-full+fields').v2
const corruptSources = {
  'bad-crc': base.replace('"Handschrift"', '"Handschrifx"'),
  'truncated': base.slice(0, base.length - 40),
  'header-missing-crc': base.replace(/ crc=[0-9a-f]{8}/u, ''),
  'header-without-comment': base.replace('<!-- fanotes-famd:v2', 'fanotes-famd:v2'),
  'length-too-small': base.replace(/chars=\d+/u, 'chars=1'),
  'bad-alphabet': recrc(base, (json) => json.replace(/"famdPts":"(.)/u, '"famdPts":"~')),
  'bad-block-length': recrc(base, (json) => json.replace(/"famdPts":"(.....)/u, '"famdPts":"')),
  'bad-pointer-index': recrc(cases.find((entry) => entry.name === 'pointer-mixed').v2, (json) => json.replace(/"famdPtrList":\[[^\]]*\]/u, '"famdPtrList":[]')),
  'bad-json': recrc(base, (json) => json.replace('{"schema"', '{"schema"]')),
  'wrong-schema': recrc(base, (json) => json.replace('"fanotes-famd-v2"', '"fanotes-famd-v3"')),
  'v1-after-v2': `${base}\n<!-- fanotes-famd:v1 chars=5 -->\n{"x":1}\n`,
}
const corrupt = Object.entries(corruptSources).map(([name, source]) => ({
  name,
  source,
  parsed: plain(parsed(source)),
  stripped: famd.stripFamdPayload(source),
  activeV2: v2.isActiveV2(source),
  looksStored: famd.famdLooksStored(source),
  convert: famd.convertFamdSource(source),
  rewrite: attempt(() => famd.rewriteFamdText(source, 'Text', NOW)),
  compose: attempt(() => famd.composeFamdCompanion(source, 'Text', undefined, undefined)),
}))

const created = ['# Neu\n\n', '', 'Zeile 😀'].map((markdown) => ({
  markdown,
  text: famd.createNoteCompanion(markdown, UPDATED),
}))

const encodings = ['', '# Nur Markdown', 'fanotes-famd:v1 mention', base, `${base}\nfanotes-famd:v1`].map((source) => ({
  source,
  encoding: famd.famdEncodingForSave(source),
  activeV2: v2.isActiveV2(source),
  looksStored: famd.famdLooksStored(source),
}))

const marks = [
  null, 0, '', [], {}, { strokes: [] }, { strokes: [{ points: [] }] }, { strokes: [{ points: [{ x: 0 }] }] },
  { strokes: [{ famdPts: '' }] }, { strokes: [{ famdPts: '!!!!!' }] }, { figurePaths: [1] },
  { ink: { hidden: { sections: [{ strokes: [{ points: [1] }] }] } } },
  { a: { b: { c: { d: { e: { f: { g: { points: [1] } } } } } } } },
  [[[[[[[{ points: [1] }]]]]]]], [[[[[[{ points: [1] }]]]]]],
  // A collapsed subsection parks its strokes eight levels deep; the walk stops after 24.
  { ink: { sections: [{ hidden: { sections: [{ hidden: { strokes: [{ points: [1] }] } }] } }] } },
  JSON.parse(`${'['.repeat(24)}{"points":[1]}${']'.repeat(24)}`),
  JSON.parse(`${'['.repeat(25)}{"points":[1]}${']'.repeat(25)}`),
].map((value) => ({ value, marks: famd.inkHasMarks(value) }))

const out = { now: NOW, updated: UPDATED, newInk, trailerMarkdown, cases, corrupt, created, encodings, marks }
fs.writeFileSync(path.join(__dirname, 'v2-golden.json'), `${JSON.stringify(out)}\n`)
console.log(`wrote ${cases.length} cases, ${corrupt.length} corrupt cases`)
