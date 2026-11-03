import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import { emptyPersonalModel, learnPage, personalStyle, updatePersonalPage, spliceTrajectories, validModel, bounds, fitPopulation } from '../src/lib/personalHandwriting.mjs'
const server = await createServer({ appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const p = (x, y, t = 0) => ({ x, y, t, pressure: .45, tiltX: 0, tiltY: 0, pointerType: 'pen' })
const options = { fontSize: 42, lineSpacing: 1.4, variation: .65, connectLetters: true, color: '#202333', baseWidth: 3.5, pressureEnabled: true, seed: 7 }
const xs = [p(0, 0), p(3, -.3), p(6, 0)], ys = [p(14, 2), p(17, 2.3), p(20, 2)]
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, (a[0]*b[0] + a[1]*b[1]) / Math.hypot(...a) / Math.hypot(...b))))
const dir = (a, b) => [b.x - a.x, b.y - a.y]
try {
  const { synthesizeHandwriting: generate, synthesizeHandwritingToFit } = await server.ssrLoadModule('/src/lib/textToHandwriting.ts')
  const { schoolScript } = await server.ssrLoadModule('/src/lib/schoolScript.mjs')
  const { readSavedInkStrokes } = await server.ssrLoadModule('/src/lib/inkDocument.ts')
  const joined = spliceTrajectories(xs, ys, 42)
  assert(joined && joined.length > xs.length + ys.length)
  assert.deepEqual(joined.slice(0, 3), xs); assert.deepEqual(joined.slice(-3), ys)
  const departure = angle(dir(xs[1], xs[2]), dir(joined[2], joined[3]))
  const arrival = angle(dir(joined.at(-4), joined.at(-3)), dir(ys[0], ys[1]))
  assert(departure < .12 && arrival < .12, 'endpoint tangent error must stay under seven degrees')
  assert.equal(spliceTrajectories(xs, ys.map(q => ({ ...q, x: q.x + 100 })), 42), null)
  assert.equal(spliceTrajectories(xs.slice().reverse(), ys, 42), null, 'never reverse a print trajectory to force a join')
  assert.equal(spliceTrajectories(xs, ys.map(q => ({ ...q, y: q.y + 100 })), 42), null)

  // An independent normal-page fixture: user-like pressure and geometry, no transcript.
  const iam = JSON.parse(await fs.readFile(new URL('./fixtures/iam-online-a01-001z-01.json', import.meta.url)))
  const real = { sourceWidth: iam.sourceWidth, sourceHeight: iam.sourceHeight, strokes: iam.strokes.map(ps => ({ points: ps.map(([x,y,t]) => p(x,y,t)), baseWidth: 3.2, pressureEnabled: true, purpose: 'handwriting' })) }
  const learned = learnPage(real, [])
  assert(learned.observations.length > 0, 'real, completely unlabeled handwriting must teach style')
  assert(learned.joins.length > 0, 'unlabeled notes supply real joining-motion geometry')
  assert.equal(learned.units.length, 0, 'no arbitrary transcript from unlabeled strokes')
  let model = updatePersonalPage(emptyPersonalModel(), 'ordinary.famd', learned)
  assert.equal(updatePersonalPage(model, 'ordinary.famd', learned), model, 'identical page does no work')
  model = updatePersonalPage(model, 'copy.famd', learned)
  assert.equal(personalStyle(model).pageCount, 1, 'copied geometry cannot amplify the writer profile')
  assert(validModel(JSON.parse(JSON.stringify(model))))
  assert.equal(validModel({ version: 2, revision: 0, pages: { broken: null } }), false)
  assert.equal(validModel({ ...model, population: { height: 0 } }), false)
  assert.deepEqual(generate('hello', [], { ...options, model: { version: 2, revision: 0, pages: { broken: null } } }).missingCharacters, [], 'corrupt derived data falls back safely')
  assert.equal(personalStyle(updatePersonalPage(model, 'ordinary.famd', null)).pageCount, 1)
  assert.equal(personalStyle(updatePersonalPage(updatePersonalPage(model, 'ordinary.famd', null), 'copy.famd', null)).observations.length, 0)
  const bad = structuredClone(real); bad.strokes.forEach(s => s.synthesis = { engine: 2 })
  assert.equal(learnPage(bad, schoolScript).observations.length, 0, 'synthesis cannot train itself')
  bad.strokes.forEach(s => { delete s.synthesis; s.purpose = 'art' })
  assert.equal(learnPage(bad, schoolScript).observations.length, 0)
  const marked = generate('hello', [], options)
  const reopened = readSavedInkStrokes(JSON.parse(JSON.stringify(marked.strokes)), '#202333')
  assert(reopened.every(s => s.synthesis?.engine === 2), 'provenance survives the real open parser')
  assert.equal(learnPage({ sourceWidth: marked.pageWidth, sourceHeight: marked.pageHeight, strokes: reopened }, schoolScript).observations.length, 0)

  // Known local shapes on an ordinary page can be pseudo-labeled conservatively.
  const ordinary = generate('he sch nr', schoolScript, { ...options, connectLetters: false, variation: 0 })
  const ordinaryPage = { sourceWidth: ordinary.pageWidth, sourceHeight: ordinary.pageHeight, strokes: ordinary.strokes.map(s => { const c = { ...s }; delete c.synthesis; return c }) }
  const known = learnPage(ordinaryPage, schoolScript)
  assert(known.units.some(u => u.label.length > 1), 'ordinary page supplies cohesive words/pairs when shape evidence is unambiguous')
  const ambiguous = schoolScript.flatMap(s => [s, { ...s, id: `${s.id}-ambiguous`, label: '¤' }])
  assert.equal(learnPage(ordinaryPage, ambiguous).units.length, 0, 'low margin labels must be rejected')
  const wordModel = updatePersonalPage(emptyPersonalModel(), 'known', known)
  const unit = known.units.find(u => u.label.length > 1)
  const copied = generate(unit.label, [], { ...options, model: wordModel, variation: 0 })
  assert(copied.usedSampleIds.includes(unit.id), 'longest matching trajectory is used before independent glyphs')
  assert.equal(copied.glyphCount, [...unit.label].length)
  assert.equal(copied.strokes.length, unit.strokes.length, 'word stroke order and pen lifts remain intact')

  assert(generate('m', [], options).bounds[2] > generate('l', [], options).bounds[2] * 4, 'fallback preserves natural glyph aspect ratios')
  assert(generate('.', [], options).bounds[3] < options.fontSize * .15, 'punctuation is sized as punctuation')
  const text = 'he el te ll en in ch sch mm nn ee hello Straße äöü ÄÖÜ 123!?\nA second line.'
  const generated = generate(text, [], { ...options, model })
  assert.equal(generated.normalizedText, text)
  assert.equal(generated.glyphCount, [...text].filter(c => !/\s/u.test(c)).length)
  assert.deepEqual(generated.missingCharacters, [])
  assert(generated.strokes.every(s => s.points.every(q => q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1)))
  assert.deepEqual(generated, generate(text, [], { ...options, model }), 'preview is fully deterministic')
  let time = -Infinity
  for (const s of generated.strokes) for (const q of s.points) { assert(q.t > time); time = q.t }
  const tall = generate('hello '.repeat(100), [], options, { width: 300, height: 300 })
  assert(tall.pageHeight > 300 && !tall.overflow)
  const cap = synthesizeHandwritingToFit('hello '.repeat(100), [], { ...options, startY: 50900 }, { width: 300, height: 50920 })
  assert(cap.overflow && cap.overflowCharacters > 0)
  const personalized = generate('eeee eeee', schoolScript, { ...options, model, connectLetters: false })
  assert.notDeepEqual(personalized.strokes.map(s => s.points), generate('eeee eeee', schoolScript, { ...options, model, seed: 99, connectLetters: false }).strokes.map(s => s.points), 'empirical variation responds to the seed')

  const cursiveSample = JSON.parse(await fs.readFile(new URL('./fixtures/cursive-synthesis.json', import.meta.url))).samples[0]
  const cursiveText = 'eeee eeee\neeee'
  const cursiveAfter = generate(cursiveText, [cursiveSample], { ...options, variation: 0 })
  assert.equal(cursiveAfter.connectionCount, 9)
  assert.equal(cursiveAfter.strokes.length, 3, 'one pen-down trajectory per cursive word')
  const summary = learned.observations[0]
  const records = Array.from({ length: 10 }, (_, i) => ({ fingerprint: `${i < 2 ? '00' : '01'}${i}`, summary: { ...summary, pressure: i < 2 ? .4 : .8 } }))
  const held = fitPopulation(records, { ...summary, pressure: .4 })
  assert.equal(held.validation.accepted, false, 'held-out page geometry rejects a worse style-center update')
  assert.equal(held.population.pressure, .4)
  const output = path.resolve(process.env.FANOTES_HANDWRITING_ARTIFACTS || '../.scratch/handwriting-evaluation')
  await fs.mkdir(output, { recursive: true })
  const svg = (strokes, width, height) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fffdf5"/>${strokes.map(s => `<polyline points="${s.points.map(q => `${q.x*width},${q.y*height}`).join(' ')}" fill="none" stroke="#202333" stroke-width="${s.baseWidth}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}</svg>`
  const { synthesizeHandwriting: legacy } = await server.ssrLoadModule('/src/lib/textToHandwritingLegacy.ts')
  const cursiveBefore = legacy(cursiveText, [cursiveSample], { ...options, variation: 0 })
  await fs.writeFile(path.join(output, 'cursive-before.svg'), svg(cursiveBefore.strokes, cursiveBefore.pageWidth, cursiveBefore.pageHeight))
  await fs.writeFile(path.join(output, 'cursive-after.svg'), svg(cursiveAfter.strokes, cursiveAfter.pageWidth, cursiveAfter.pageHeight))
  await fs.writeFile(path.join(output, 'cursive-example.json'), JSON.stringify({ text: cursiveText, samples: [cursiveSample], options: { ...options, variation: 0 } }))
  const before = legacy(text.replaceAll('ß','ss'), schoolScript, options)
  await fs.writeFile(path.join(output, 'before.svg'), svg(before.strokes, before.pageWidth, before.pageHeight))
  await fs.writeFile(path.join(output, 'after.svg'), svg(generated.strokes, generated.pageWidth, generated.pageHeight))
  await fs.writeFile(path.join(output, 'unlabeled-real.svg'), svg(real.strokes, real.sourceWidth, real.sourceHeight))
  await fs.writeFile(path.join(output, 'trajectory-splice.svg'), svg([{ points: joined.map(q => ({ ...q, x: (q.x+3)/27, y: (q.y+6)/14 })), baseWidth: .35 }], 27, 14))
  const report = { realUnlabeledObservations: learned.observations.length, pseudoLabeledUnits: known.units.length, departureDegrees: departure*180/Math.PI, arrivalDegrees: arrival*180/Math.PI, beforeOverlayConnectors: before.connectionCount, stylePreservingPrintJoins: generated.connectionCount, cursiveContinuousJoins: cursiveAfter.connectionCount, cursiveWords: cursiveAfter.strokes.length, unlabeledJoiningMotions: learned.joins.length, heldOutStyleUpdateRejected: !held.validation.accepted, heldOutRecognitionAccuracy: null, note: 'Geometric regression fixtures; no claim of human indistinguishability or calibrated OCR accuracy.' }
  await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(report, null, 2))
  const close = r => svg(r.strokes, r.pageWidth, r.pageHeight).replace(`viewBox="0 0 ${r.pageWidth} ${r.pageHeight}"`, 'viewBox="60 65 240 125"')
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>FaNotes trajectory evaluation</title><style>body{margin:32px;font:16px system-ui;color:#202333;background:#f5f4ef}h1{font-size:26px}h2{font-size:18px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}section{padding:20px;background:white;border:1px solid #ddd;border-radius:12px}svg{width:100%;max-height:370px}p{line-height:1.5}.muted{color:#596274}code{font-size:14px}</style><h1>FaNotes: continuous handwriting trajectories</h1><p>Synthetic cursive regression fixture, same source letter and seed. This demonstrates geometry and pen state, not real-user indistinguishability.</p><div class="grid"><section><h2>Previous engine</h2>${close(cursiveBefore)}<p>${cursiveBefore.strokes.length} separate pen-down strokes, including ${cursiveBefore.connectionCount} overlay connectors.</p></section><section><h2>New engine</h2>${close(cursiveAfter)}<p>${cursiveAfter.strokes.length} continuous pen-down words, ${cursiveAfter.connectionCount} direction-aware joins. Source letter geometry remains editable.</p></section></div><p>Finite-sampling endpoint tangent errors: ${report.departureDegrees.toFixed(2)}° / ${report.arrivalDegrees.toFixed(2)}°. Infeasible backward/long joins are rejected.</p><section><h2>Real, unlabeled handwriting: IAM fixture</h2>${svg(real.strokes, real.sourceWidth, real.sourceHeight).replace('viewBox="0 0 900 560"','viewBox="70 70 770 160"')}<p>${learned.observations.length} style observations and ${learned.joins.length} joining motions learned with no transcript. Unknown letter identities remain unlabeled.</p></section><p class="muted">Reproduce with <code>npm --prefix fanotes run check:personal-handwriting</code>. See PERSONAL_HANDWRITING.md for limits and validation details.</p></html>`
  await fs.writeFile(path.join(output, 'comparison.html'), html)
  console.log(JSON.stringify(report)); console.log(`Visual fixtures: ${output}`)
} finally { await server.close() }
