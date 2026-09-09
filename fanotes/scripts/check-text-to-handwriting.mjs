import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const point = (x, y, t) => ({
  x,
  y,
  t,
  pressure: 0.42 + x * 0.2,
  tiltX: 2,
  tiltY: -1,
  pointerType: 'pen',
})

const sample = (char, variant = 1) => ({
  id: `${char}-${variant}`,
  labelId: `label-${char}`,
  label: char,
  labelName: char,
  latex: char,
  category: char.toUpperCase() === char && char.toLowerCase() !== char ? 'uppercase' : 'lowercase',
  writerId: 'writer-test',
  sessionId: 'manual-test',
  createdAt: '2026-01-01T00:00:00.000Z',
  imageData: '',
  imageWidth: 100,
  imageHeight: 100,
  sourceCanvas: { width: 900, height: 1273, devicePixelRatio: 1 },
  bbox: [0.1, 0.1, 0.11 + variant * 0.004, 0.17],
  strokes: [{
    points: [
      point(0.105, 0.22, 0),
      point(0.13 + variant * 0.002, 0.12, 8),
      point(0.18 + variant * 0.003, 0.19, 16),
      point(0.205 + variant * 0.004, 0.215, 24),
    ],
    baseWidth: 4,
    pressureEnabled: true,
  }],
  strokeCount: 1,
  pointCount: 4,
  schemaVersion: 1,
})

const coordinates = (result) => result.strokes.flatMap((stroke) => stroke.points.map(({ x, y, pressure }) => [x, y, pressure]))

try {
  const {
    synthesizeHandwriting,
    synthesizeHandwritingToFit,
  } = await server.ssrLoadModule('/src/lib/textToHandwriting.ts')
  const { WRITE_CAP_HEIGHT } = await server.ssrLoadModule('/src/lib/noteCanvas.ts')

  const characters = [...new Set('Test einer langen Zeile')].filter((char) => char !== ' ')
  const samples = characters.flatMap((char) => [sample(char, 1), sample(char, 2)])
  const options = {
    fontSize: 42,
    lineSpacing: 1.4,
    variation: 0.72,
    connectLetters: true,
    color: '#18202d',
    baseWidth: 4,
    pressureEnabled: true,
    seed: 1_337,
  }
  const sourceSnapshot = JSON.stringify(samples)

  const first = synthesizeHandwriting('Test einer', samples, options)
  const repeated = synthesizeHandwriting('Test einer', samples, options)
  assert.deepEqual(coordinates(first), coordinates(repeated), 'Derselbe Seed muss eine stabile Vorschau ergeben.')
  assert.equal(first.missingCharacters.length, 0)
  assert.equal(first.glyphCount, 9)
  assert.ok(first.connectionCount >= 6, 'Buchstaben innerhalb der Wörter müssen verbunden werden.')
  assert.ok(first.strokes.every((stroke) => stroke.points.every((entry) => entry.x >= 0 && entry.x <= 1 && entry.y >= 0 && entry.y <= 1)))

  const varied = synthesizeHandwriting('Test einer', samples, { ...options, seed: 91_117 })
  assert.notDeepEqual(coordinates(first), coordinates(varied), 'Ein neuer Seed muss individuelle Zeichenabweichungen erzeugen.')

  const repeatedGlyph = synthesizeHandwriting('eeee', samples, options)
  assert.ok(repeatedGlyph.usedSampleIds.includes('e-1'))
  assert.ok(repeatedGlyph.usedSampleIds.includes('e-2'), 'Wiederholte Buchstaben sollen unterschiedliche Vorlagen nutzen.')
  assert.equal(repeatedGlyph.connectionCount, 3)

  const separated = synthesizeHandwriting('test test\ntest', samples, options)
  assert.equal(separated.connectionCount, 9, 'Leerzeichen und Zeilenumbrüche dürfen Wörter nicht verbinden.')
  assert.equal(separated.lineCount, 2)

  const missing = synthesizeHandwriting('test€', samples, options)
  assert.deepEqual(missing.missingCharacters, ['€'])

  const rightContinuation = synthesizeHandwriting('Test', samples, {
    ...options,
    marginLeft: 610,
    marginRight: 36,
    startY: 260,
  })
  assert.ok(
    Math.min(...rightContinuation.strokes.flatMap((entry) => entry.points.map((entryPoint) => entryPoint.x))) > 0.64,
    'Eine mathematische Fortsetzung muss auch weit rechts neben dem Ursprungsterm beginnen können.',
  )

  const longText = 'test einer langen Zeile '.repeat(5).trim()
  const longGlyphCount = [...longText].filter((char) => char !== ' ').length
  const shortPage = { width: 400, height: 420 }
  const grown = synthesizeHandwriting(longText, samples, { ...options, fontSize: 60 }, shortPage)
  assert.equal(grown.overflow, false, 'Ein zu hoher Text muss die Seite wachsen lassen statt zu blockieren.')
  assert.equal(grown.glyphCount, longGlyphCount, 'Jedes GlyphenWerk-Zeichen muss nach dem Wachsen ausgegeben werden.')
  assert.ok(grown.pageHeight > shortPage.height, 'Die benutzte Seitenhöhe muss über der Startseite liegen.')
  assert.ok(grown.pageHeight <= WRITE_CAP_HEIGHT)

  const atCap = synthesizeHandwriting(longText, samples, {
    ...options,
    fontSize: 60,
    startY: WRITE_CAP_HEIGHT - 8,
  }, { width: 400, height: WRITE_CAP_HEIGHT })
  assert.equal(atCap.overflow, true, 'Am Schreibhöhen-Anschlag muss Overflow gemeldet werden.')
  assert.ok(atCap.overflowCharacters > 0, 'Overflow am Anschlag darf Glyphen nicht still verwerfen.')
  assert.ok(atCap.glyphCount < longGlyphCount)

  const fitted = synthesizeHandwritingToFit(longText, samples, { ...options, fontSize: 60, startY: WRITE_CAP_HEIGHT - 8 }, { width: 400, height: WRITE_CAP_HEIGHT }, 18)
  assert.ok(fitted.fontSizeUsed <= 60)
  assert.equal(JSON.stringify(samples), sourceSnapshot, 'Die Synthese darf Trainingsdaten nicht verändern.')

  const eSamples = [sample('e', 1)]
  const glyphBox = (stroke, pageHeight) => {
    const ys = stroke.points.map((point) => point.y * pageHeight)
    return { height: Math.max(...ys) - Math.min(...ys), baseline: Math.max(...ys) }
  }
  const defaultVariation = synthesizeHandwriting('eeee', eSamples, {
    ...options,
    variation: 0.62,
    connectLetters: false,
    seed: 1_337,
  })
  const defaultBoxes = defaultVariation.strokes.map((stroke) => glyphBox(stroke, defaultVariation.pageHeight))
  assert.equal(defaultVariation.glyphCount, 4)
  assert.ok(new Set(defaultBoxes.map((box) => box.height.toFixed(4))).size > 1, 'Wiederholte Buchstaben brauchen unterschiedliche Höhen.')
  assert.ok(new Set(defaultBoxes.map((box) => box.baseline.toFixed(4))).size > 1, 'Wiederholte Buchstaben dürfen nicht auf einer Linie sitzen.')

  const uniform = synthesizeHandwriting('eeee', eSamples, {
    ...options,
    variation: 0,
    connectLetters: false,
    seed: 1_337,
  })
  const uniformBoxes = uniform.strokes.map((stroke) => glyphBox(stroke, uniform.pageHeight))
  assert.equal(new Set(uniformBoxes.map((box) => box.height.toFixed(6))).size, 1, 'Variation 0 muss gleiche Höhen behalten.')
  assert.equal(new Set(uniformBoxes.map((box) => box.baseline.toFixed(6))).size, 1, 'Variation 0 muss die Grundlinie halten.')

  console.log(`Text-zu-Handschrift erfolgreich: ${first.glyphCount} Glyphen, ${first.connectionCount} Verbindungen, Seitenwachstum, Variation, freie Fortsetzungsposition, Umbruch und Sicherheitsgrenzen geprüft.`)
} finally {
  await server.close()
}
