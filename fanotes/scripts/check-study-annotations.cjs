'use strict'

/** Geometry, sanitising and .famd round trip of study annotations (electron/noteAnnotation.mjs). */

const assert = require('node:assert/strict')
const A = require('../electron/noteAnnotation.mjs')
const famd = require('../electron/famd.cjs')

const approx = (a, b, eps = 0.05) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

// angle: a 35 degree bee-dance wedge on a page with a 1:1.414 aspect
const size = { width: 21, height: 29.7 }
const rad = (35 * Math.PI) / 180
const vertex = [0.3, 0.5]
const toFrac = (dx, dy) => [vertex[0] + dx / size.width, vertex[1] + dy / size.height]
const arm1 = toFrac(6, 0)
const arm2 = toFrac(6 * Math.cos(rad), -6 * Math.sin(rad))
const m3 = { kind: 'measure', mode: 'angle', pts: [arm1, vertex, arm2] }
approx(A.measureValue(m3, size), 35)
assert.equal(A.formatMeasure(m3, 35), '35°')
// two separate lines: parallel-ish ones measure the acute angle
const m4 = { kind: 'measure', mode: 'angle', pts: [[0.1, 0.1], [0.5, 0.1], [0.2, 0.4], [0.2 + 0.3, 0.4 - 0.3 * Math.tan(rad) * size.width / size.height]] }
approx(A.measureValue(m4, size), 35)
approx(A.measureValue({ kind: 'measure', mode: 'angle', pts: [[0.1, 0.1], [0.1, 0.5], [0.3, 0.2], [0.3, 0.7]] }, size), 0)
approx(A.angleAt([0, 0], [1, 0], [0, 1]), 90)
approx(A.angleAt([0, 0], [1, 0], [-1, 0]), 180)
assert.equal(A.angleAt([0, 0], [0, 0], [1, 0]), 0)
// distance in cm uses real page proportions
const d = { kind: 'measure', mode: 'distance', pts: [[0, 0], [0.5, 0]] }
approx(A.measureValue(d, size), 10.5)
assert.equal(A.formatMeasure(d, 10.5), '10,5 cm')

// sanitising
assert.equal(A.sanitizeAnnotation({ kind: 'future-thing', id: 'x' }), null)
assert.equal(A.sanitizeAnnotation(null), null)
assert.equal(A.sanitizeAnnotation({ kind: 'image', src: 'javascript:alert(1)' }), null)
assert.equal(A.sanitizeAnnotation({ kind: 'image', src: 'data:image/svg+xml;base64,AAAA' }), null)
const img = A.sanitizeAnnotation({ kind: 'image', id: 'i1', src: 'data:image/png;base64,iVBORw0KGgo=', w: 9, opacity: -1 })
assert.equal(img.w, 1); assert.equal(img.opacity, 0.1); assert.equal(img.locked, false)
const callout = A.sanitizeAnnotation({ kind: 'callout', id: 'bad id!', ax: 4, ay: -2, text: 'x'.repeat(500), color: 'red' })
assert.match(callout.id, /^an-/); assert.equal(callout.ax, 1); assert.equal(callout.ay, 0); assert.equal(callout.text.length, 120); assert.equal(callout.color, '#1d4ed8')
assert.equal(A.sanitizeAnnotation({ kind: 'stroke', pts: [[0.1, 0.1]] }), null)
assert.equal(A.sanitizeAnnotation({ kind: 'measure', mode: 'angle', pts: [[0, 0], [1, 1]] }), null)
assert.equal(A.sanitizeAnnotation({ kind: 'stamp', stamp: 'nonsense' }).stamp, 'event')
const many = Array.from({ length: 700 }, (_, i) => ({ kind: 'stamp', id: `s${i}`, stamp: 'gain' }))
assert.equal(A.parseAnnotations(many).length, A.ANNOTATION_LIMIT)
assert.equal(A.parseAnnotations([{ kind: 'stamp', id: 'a' }, { kind: 'stamp', id: 'a' }]).length, 1)
assert.deepEqual(A.parseAnnotations('nope'), [])

// numbered labels + legend
let list = A.parseAnnotations([
  { kind: 'callout', id: 'c1', page: 1, ax: 0.1, ay: 0.1, lx: 0.5, ly: 0.6, num: 5, text: 'Femur' },
  { kind: 'callout', id: 'c2', page: 1, ax: 0.1, ay: 0.1, lx: 0.2, ly: 0.2, num: 9, text: 'Tibia' },
  { kind: 'callout', id: 'c3', page: 1, ax: 0.1, ay: 0.1, lx: 0.3, ly: 0.3, text: 'free' },
  { kind: 'stamp', id: 's1', page: 1, x: 0.5, y: 0.5, stamp: 'letter-h' },
  { kind: 'stamp', id: 's2', page: 2, x: 0.5, y: 0.5, stamp: 'letter-h' },
  { kind: 'stamp', id: 's3', page: 2, x: 0.5, y: 0.5, stamp: 'loss' },
])
assert.equal(A.nextCalloutNumber(list), 10)
list = A.renumberCallouts(list)
assert.deepEqual(list.filter((i) => i.kind === 'callout' && i.num).map((i) => [i.id, i.num]), [['c1', 2], ['c2', 1]])
const rows = A.legendRows(list, { 'letter-h': 'hemimetabol (unvollst.)' })
assert.deepEqual(rows.map((r) => r.glyph), ['H', '✕', '1', '2'])
assert.equal(rows[0].label, 'hemimetabol (unvollst.)')

// word bank
assert.deepEqual(A.termsFromText('Caput, Thorax\nAbdomen; 1. Coxa\n  Femur  \nx'), ['Caput', 'Thorax', 'Abdomen', 'Coxa', 'Femur'])

// undo / redo
let h = A.createAnnotationHistory(3)
h = A.pushAnnotationHistory(h, [])
h = A.pushAnnotationHistory(h, [1])
let u = A.undoAnnotations(h, [1, 2])
assert.deepEqual(u.list, [1]); h = u.history
u = A.undoAnnotations(h, [1]); assert.deepEqual(u.list, []); h = u.history
assert.equal(A.undoAnnotations(h, []), null)
const r = A.redoAnnotations(h, []); assert.deepEqual(r.list, [1])
for (let i = 0; i < 5; i += 1) h = A.pushAnnotationHistory(h, [i])
assert.equal(h.past.length, 3)

// .famd round trip, both encodings, plus a note without annotations
const png = 'data:image/png;base64,iVBORw0KGgo='
const payload = (extra = {}) => ({ ...famd.emptyFamdPayload(), ...extra })
const saved = A.parseAnnotations([
  { kind: 'callout', id: 'c1', page: 3, ax: 0.2, ay: 0.3, lx: 0.4, ly: 0.5, text: 'Caput', num: 1 },
  { kind: 'stamp', id: 's1', page: 3, x: 0.7, y: 0.2, stamp: 'gain' },
  { kind: 'legend', id: 'l1', page: 3, x: 0.6, y: 0.05, names: { gain: 'dazugekommen' } },
  { kind: 'image', id: 'i1', page: 3, x: 0.1, y: 0.1, w: 0.4, aspect: 1.5, opacity: 0.35, locked: true, src: png, title: 'Abb. 3' },
  { kind: 'stroke', id: 'h1', page: 9, pts: [[0.1, 0.1], [0.2, 0.15], [0.3, 0.1]], color: '#facc15', width: 20, opacity: 0.4 },
  { kind: 'measure', id: 'm1', page: 10, mode: 'angle', pts: [[0.2, 0.2], [0.4, 0.4], [0.6, 0.3]], color: '#dc2626' },
  { kind: 'terms', id: 'terms', list: ['Caput', 'Thorax'] },
])
assert.equal(saved.length, 7)
for (const encoding of ['v1', 'v2']) {
  const text = famd.serializeFamd('body text', payload({ annotations: saved }), encoding)
  const back = famd.parseFamd(text)
  assert.equal(back.markdown, 'body text')
  assert.deepEqual(back.payload.annotations, saved, `${encoding} round trip`)
  assert.equal(famd.sameFamdPayload(back.payload, back.payload), true)
  assert.equal(famd.sameFamdPayload(back.payload, { ...back.payload, annotations: saved.slice(1) }), false)
  // old notes (no annotations) still open and stay without the key
  const plain = famd.parseFamd(famd.serializeFamd('x', payload(), encoding))
  assert.equal(plain.payload.annotations, undefined)
  // a note written by a newer version with an unknown kind keeps the known objects and does not throw
  const future = famd.serializeFamd('x', payload({ annotations: [...saved, { kind: 'hologram', id: 'z' }] }), encoding)
  assert.equal(famd.parseFamd(future).payload.annotations.length, 7)
}
console.log('study annotation checks passed')
