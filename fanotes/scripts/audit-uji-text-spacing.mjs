import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

// UJI Pen Characters v2, CC BY 4.0, DOI 10.24432/C5FG8S. The pinned data is
// supplied by the caller and remains outside FaNotes release packages.
const dataset = process.env.FANOTES_UJI_DATASET?.trim()
assert.ok(dataset && fs.statSync(dataset).isFile(), 'FANOTES_UJI_DATASET muss auf den geprüften UJI-Datensatz zeigen.')

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 560
const GLYPH_HEIGHT = 0.075
const TOP = 0.22
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const parseDataset = (source) => {
  const lines = source.split(/\r?\n/u)
  const records = []
  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    const header = /^WORD\s+([a-z])\s+((?:trn|tst)_(?:UJI|UPV)_W\d+)-(0[12])$/u.exec(lines[cursor].trim())
    if (!header) continue
    const strokeCount = Number(/^NUMSTROKES\s+(\d+)$/u.exec((lines[++cursor] ?? '').trim())?.[1])
    const strokes = []
    for (let strokeIndex = 0; strokeIndex < strokeCount; strokeIndex += 1) {
      const match = /^POINTS\s+(\d+)\s+#\s+(.+)$/u.exec((lines[++cursor] ?? '').trim())
      assert.ok(match, `Ungültiger UJI-Stiftzug bei Zeile ${cursor + 1}.`)
      const count = Number(match[1])
      const values = match[2].trim().split(/\s+/u).map(Number)
      strokes.push(Array.from({ length: count }, (_, index) => [
        values[index * 2],
        values[index * 2 + 1],
      ]))
    }
    records.push({
      char: header[1],
      writer: header[2],
      session: Number(header[3]),
      strokes,
    })
  }
  return records
}

const positionedGlyph = (record, left, timeStart) => {
  const points = record.strokes.flat()
  const minX = Math.min(...points.map(([x]) => x))
  const maxX = Math.max(...points.map(([x]) => x))
  const minY = Math.min(...points.map(([, y]) => y))
  const maxY = Math.max(...points.map(([, y]) => y))
  const scale = GLYPH_HEIGHT * SOURCE_HEIGHT / Math.max(1, maxY - minY)
  const width = (maxX - minX) * scale / SOURCE_WIDTH
  let time = timeStart
  return {
    width,
    strokes: record.strokes.map((stroke) => ({
      baseWidth: 3.7,
      pressureEnabled: false,
      points: stroke.map(([x, y]) => ({
        x: left + (x - minX) * scale / SOURCE_WIDTH,
        y: TOP + (y - minY) * scale / SOURCE_HEIGHT,
        t: time++,
        pressure: 0.62,
        pointerType: 'pen',
      })),
    })),
    nextTime: time + 5,
  }
}

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const all = parseDataset(fs.readFileSync(dataset, 'utf8'))
  const requestedWriters = Math.max(1, Math.min(60, Number(process.env.FANOTES_UJI_SPACING_WRITERS) || 12))
  const writers = [...new Set(all.map((entry) => entry.writer))].sort().slice(0, requestedWriters)
  const recordsByWriter = new Map(writers.map((writer) => [
    writer,
    new Map(all
      .filter((entry) => entry.writer === writer && entry.session === 1)
      .map((entry) => [entry.char, entry])),
  ]))
  const { applyTextReranking, recognizedSentence } = await server.ssrLoadModule('/../src/lib/recognition.ts')
  const { BASE_CATALOG } = await server.ssrLoadModule('/../src/data/catalog.ts')
  const labelByChar = new Map(BASE_CATALOG.map((label) => [label.char, label]))

  const recognizeLine = (writer, words, innerGap, wordGap) => {
    const lookup = recordsByWriter.get(writer)
    let left = 0.04
    let time = 0
    let tokenIndex = 0
    const tokens = []
    words.forEach((word, wordIndex) => {
      ;[...word].forEach((char, charIndex) => {
        const record = lookup?.get(char)
        const label = labelByChar.get(char)
        assert.ok(record && label, `Fehlendes ${char} für ${writer}.`)
        const positioned = positionedGlyph(record, left, time)
        tokens.push({
          id: `${writer}-${tokenIndex++}`,
          strokes: positioned.strokes,
          imageData: '',
          bbox: [left, TOP, positioned.width, GLYPH_HEIGHT],
          labelId: label.id,
          char: label.char,
          name: label.name,
          latex: label.latex,
          confidence: 99,
          alternatives: [{
            labelId: label.id,
            char: label.char,
            name: label.name,
            confidence: 99,
          }],
          visualLabelId: label.id,
          visualConfidence: 99,
        })
        const atWordBoundary = charIndex + 1 === word.length && wordIndex + 1 < words.length
        left += positioned.width
        if (charIndex + 1 < word.length) left += innerGap
        else if (atWordBoundary) left += wordGap
        // Real pen event timestamps retain the short pause used while moving
        // to the next word. The extra 45 ms is deliberately modest; the
        // recognizer still requires a physical ink gap as independent proof.
        time = positioned.nextTime + (atWordBoundary ? 45 : 0)
      })
    })
    assert.ok(left <= 0.98, `Testzeile läuft rechts aus der Seite: ${writer} ${words.join(' ')} ${left}`)
    return recognizedSentence(applyTextReranking(tokens, BASE_CATALOG, 'de'))
  }

  const words = ['test', 'hallo', 'fabio', 'mathematik', 'wirtschaft', 'handschrift']
  const phrases = [
    ['hallo', 'mathe'],
    ['mein', 'name'],
    ['das', 'ist'],
    ['guten', 'tag'],
    ['private', 'notiz'],
    ['fabio', 'test'],
    ['niko', 'fabio'],
    ['alpha', 'beta'],
  ]
  const innerGaps = [-0.001, 0.002, 0.004, 0.007]
  const wordGaps = [0.025, 0.035, 0.045, 0.06]
  const failures = []

  writers.forEach((writer) => {
    words.forEach((word) => innerGaps.forEach((innerGap) => {
      const recognized = recognizeLine(writer, [word], innerGap, 0)
      if (recognized.includes(' ')) failures.push({
        type: 'false-space', writer, expected: word, innerGap, recognized,
      })
    }))
    phrases.forEach((phrase) => wordGaps.forEach((wordGap) => {
      const expected = phrase.join(' ')
      const recognized = recognizeLine(writer, phrase, 0.004, wordGap)
      if (recognized !== expected) failures.push({
        type: 'missed-space', writer, expected, wordGap, recognized,
      })
    }))
  })

  const falseSpaces = failures.filter((entry) => entry.type === 'false-space')
  const missedSpaces = failures.filter((entry) => entry.type === 'missed-space')
  const result = {
    writers: writers.length,
    cases: writers.length * (words.length * innerGaps.length + phrases.length * wordGaps.length),
    falseSpaces: falseSpaces.length,
    missedSpaces: missedSpaces.length,
    missedByGap: wordGaps.map((wordGap) => ({
      wordGap,
      failures: missedSpaces.filter((entry) => entry.wordGap === wordGap).length,
    })),
    failures,
  }
  console.log(JSON.stringify(process.env.FANOTES_UJI_SPACING_SUMMARY === '1' ? {
    ...result,
    failures: failures.slice(0, 80),
  } : result, null, 2))
  if (process.env.FANOTES_UJI_SPACING_STRICT === '1') {
    assert.equal(falseSpaces.length, 0, `Enge echte Wörter wurden getrennt: ${JSON.stringify(falseSpaces.slice(0, 20))}`)
    const ordinaryMisses = missedSpaces.filter((entry) => entry.wordGap >= 0.045)
    assert.equal(ordinaryMisses.length, 0, `Normale Wortabstände gingen verloren: ${JSON.stringify(ordinaryMisses.slice(0, 20))}`)
  }
} finally {
  await server.close()
}
