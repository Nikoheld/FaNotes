// Desktop ink recognition, end to end in Node: the shared Rust (fanotes-recog WASM) groups,
// renders and decodes exactly as in the app, and the committed native `fanotes-ocr` sidecar runs
// the model exactly as the Electron host drives it. This is the desktop pipeline without a
// browser, so it checks the shipped artifacts (WASM, model, language models) and the fixtures.
//
//   node scripts/check-ink-recognition.mjs
//   FANOTES_INK_CASES=/path/cases.json node scripts/check-ink-recognition.mjs   # private sets
//   FANOTES_INK_DIR=/path/to/fanotes-ink node scripts/check-ink-recognition.mjs  # another ONNX + manifest
//
// The bundled cases are the IAM-OnDB example line and held-out ScaDS German lines traced into
// pen strokes (scripts/fixtures/README-INK-RECOGNITION.md).
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNativeOcrHost } from '../electron/native-ocr.cjs'
import { initSync, inkDecode, inkGroupLines, inkLineImage, inkSpanBoxes, setInkExactWords, setInkLanguageModel, setInkLexicon } from '../src/lib/recogWasm/fanotes_recog_wasm.js'
import { RECOG_WASM_BASE64 } from '../src/lib/recogWasm/bytes.ts'
import { INK_RETRY_VARIANTS, INK_SHEAR_RETRY, MERGE_SCORE_MARGIN, MIXED_CASE_SCALE, NARROW_LINE_MARGIN, NARROW_SCALE, NARROW_WORD_MARGIN, SHEAR_SCORE_MARGIN, SPLICE_SCORE_MARGIN, WIDTH_RETRY_MARGIN, charactersWithWordEdits, foldInkWord, hasLongUnknownWord, hasMixedInteriorCase, longUnknownWordEdits, narrowScaleKeepsKnownWords, oneUnknownWordBecomesKnown, sameLettersAllowingCapsJoin, shearReadingRewritesTwoWords, textWithWordEdits, widthReadingKeepsKnownWords, widthReadingMergesTwoWords } from '../src/lib/inkWidthChoice.ts'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ocr = path.join(appRoot, 'public', 'ocr')
const inkDir = process.env.FANOTES_INK_DIR || path.join(ocr, 'fanotes-ink')
const casesFile = process.env.FANOTES_INK_CASES || path.join(appRoot, 'scripts/fixtures/ink-recognition-cases.json')

initSync({ module: Buffer.from(RECOG_WASM_BASE64, 'base64') })

const manifest = JSON.parse(fs.readFileSync(path.join(inkDir, 'manifest.json'), 'utf8'))
assert.equal(manifest.format, 'fanotes-ink-recognizer-v1', 'unexpected ink manifest')
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const verified = (descriptor, directory) => {
  const bytes = fs.readFileSync(path.join(directory, descriptor.file))
  assert.equal(bytes.length, descriptor.size, `${descriptor.file} size`)
  assert.equal(digest(bytes), descriptor.sha256, `${descriptor.file} sha256`)
  return bytes
}
const modelBytes = verified(manifest.models.desktop, inkDir)
const modelPath = path.join(inkDir, manifest.models.desktop.file)

// Language models + the spelling Bloom filter, loaded into the WASM decoder as in the app.
for (const language of ['de', 'en']) {
  setInkLanguageModel(language, verified(manifest.languageModels[language], inkDir))
}
const spelling = JSON.parse(fs.readFileSync(path.join(ocr, '..', 'spell', 'manifest.json'), 'utf8'))
const exactWords = { de: new Set(), en: new Set() }
for (const language of ['de', 'en']) {
  const descriptor = spelling.languages[language]
  const bloom = fs.readFileSync(path.join(appRoot, 'public', 'spell', descriptor.file))
  setInkLexicon(language, bloom, descriptor.bitCount)
  const words = fs.readFileSync(path.join(appRoot, 'public', 'spell', `${language}.words`), 'utf8')
    .split('\n')
    .filter((word) => word.length > 0)
  setInkExactWords(language, words)
  exactWords[language] = new Set(words.map((word) => foldInkWord(word)))
}
const knownWord = (language) => (word) => exactWords[language].has(foldInkWord(word))
{
  const known = knownWord('de')
  assert.equal(shearReadingRewritesTwoWords(
    'Die Ausbildung in dieser Waten tauscht mich.',
    'Die Ausbildung in dieser Welt entlauscht mich.',
  ), true)
  assert.equal(shearReadingRewritesTwoWords(
    'und Computerspielen sowie über Personen, die daran',
    'und Computerspielen sowie über Personen, die Paronen',
  ), false)
  assert.equal(shearReadingRewritesTwoWords(
    'Das wird nie enden.',
    'Das wird sie enden.',
  ), false)
  assert.equal(oneUnknownWordBecomesKnown(
    'bleiben wegen der Kolbenningspannung in der Aneren',
    'bleiben wegen der Kolbenningspannung in der inneren',
    known,
  ), true)
  assert.equal(oneUnknownWordBecomesKnown(
    'und Computerspielen sowie über Personen, die daran',
    'und Computerspielen sowie über Personen, die davon',
    known,
  ), false)
  assert.equal(narrowScaleKeepsKnownWords(
    'Nuklearenaie ist die Technologie zur großtechnischen Erzeugge',
    'Nuklearenergie ist die Technologie zur großtechnischen Erzeugen',
    known,
  ), true)
  assert.equal(narrowScaleKeepsKnownWords(
    'und Computerspielen sowie über Personen, die daran',
    'und Computerspielen sowie über Personen, die davon',
    known,
  ), false)
  assert.equal(hasMixedInteriorCase('PEcK SNIFF long-lost'), true)
  assert.equal(sameLettersAllowingCapsJoin('PEcK SNIFF long-lost', 'PECKSNIFF long-lost'), true)
  assert.equal(sameLettersAllowingCapsJoin('PEcK SNIFF long-lost', 'PECK SNIFF long-lost'), true)
  assert.equal(sameLettersAllowingCapsJoin('PEcK SNIFF long-lost', 'PECKSNAFF long-lost'), false)
  assert.equal(sameLettersAllowingCapsJoin('Ich muss schlafen gehen.', 'Ich muss schlafengehen.'), false)
  assert.equal(sameLettersAllowingCapsJoin('DDD EEE FFF GGG', 'DDDEEEFFFGGG'), false)
  assert.equal(hasMixedInteriorCase('Das war ein böses Kaninchen.'), false)
  assert.equal(hasLongUnknownWord('Herzlichen Glückensisch zum Geburtstag', known), true)
  assert.equal(widthReadingKeepsKnownWords(
    'Herzlichen Glückensisch zum Geburtstag, Weiriell',
    'Herzlichen Glückwunsch zum Geburtstag, Muiriell',
    known,
  ), true)
  assert.equal(widthReadingKeepsKnownWords(
    'sowie über Personen, die daran',
    'sowie über Personen, die davon',
    known,
  ), false)
  assert.equal(widthReadingKeepsKnownWords(
    'Nuklearenaie ist die Technologie',
    'Nuklearen sie ist die Technologie',
    known,
  ), false)
  assert.equal(widthReadingMergesTwoWords(
    'Kaiserlich Japanischen Marie luft statut in Friedenszeiten auf die in',
    'Kaiserlich Japanischen Marie luftstreitkraft in Friedenszeiten auf die in',
  ), true)
  assert.equal(widthReadingMergesTwoWords(
    'und Computerspielen sowie über Personen, die daran',
    'und Computerspielen sowie über Personen, die davon',
  ), false)
  const nuclear = longUnknownWordEdits(
    'Nuklearenaie ist die Technologie zur großtechnischen Erzeugge',
    'Nuklearenergie ist die Technologie zur größtechischen Erzeugge',
    known,
  )
  assert.deepEqual(nuclear, [{ index: 0, from: 'Nuklearenaie', to: 'Nuklearenergie' }])
  assert.equal(
    textWithWordEdits('Nuklearenaie ist die Technologie zur großtechnischen Erzeugge', nuclear),
    'Nuklearenergie ist die Technologie zur großtechnischen Erzeugge',
  )
}

const host = createNativeOcrHost({
  executable: path.join(appRoot, 'native-ocr', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'fanotes-ocr.exe' : 'fanotes-ocr'),
  runtime: path.join(appRoot, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', process.platform, process.arch, process.platform === 'win32' ? 'onnxruntime.dll' : process.platform === 'darwin' ? 'libonnxruntime.1.21.0.dylib' : 'libonnxruntime.so.1'),
  model: { path: modelPath, size: manifest.models.desktop.size, sha256: manifest.models.desktop.sha256 },
  modelHeight: 64,
  inputName: 'image',
  outputName: 'logits',
  minWidth: 16,
})

const editDistance = (first, second) => {
  const a = Array.from(first)
  const b = Array.from(second)
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) current.push(Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1])))
    previous = current
  }
  return previous[b.length]
}
const fold = (value) => value.replace(/ß/gu, 'ss')
const cer = (rows) => 100 * rows.reduce((s, r) => s + editDistance(fold(r.text), fold(r.truth)), 0) / Math.max(1, rows.reduce((s, r) => s + Array.from(r.truth).length, 0))
const wer = (rows) => 100 * rows.reduce((s, r) => s + editDistance(fold(r.text).split(/\s+/u), fold(r.truth).split(/\s+/u)), 0) / Math.max(1, rows.reduce((s, r) => s + r.truth.split(/\s+/u).length, 0))

const decoderOptionsFor = (language) => {
  const { englishLmWeight, englishWordBonus, penWidth: _penWidth, ...shared } = manifest.decoder
  const english = language === 'en'
  return JSON.stringify({
    ...shared,
    nBest: 5,
    lmWeight: english ? englishLmWeight ?? shared.lmWeight : shared.lmWeight,
    wordBonus: english ? englishWordBonus ?? shared.wordBonus : shared.wordBonus,
  })
}
const median = (values) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : 0

const packStrokes = (strokes, width, height) => {
  let count = 0
  for (const stroke of strokes) count += 1 + stroke.length * 2
  const packed = new Float64Array(count)
  let offset = 0
  for (const stroke of strokes) {
    packed[offset++] = stroke.length
    for (const [x, y] of stroke) { packed[offset++] = x * width; packed[offset++] = y * height }
  }
  return packed
}

async function recognize(entry, { strokes = entry.strokes, width = entry.sourceWidth, height = entry.sourceHeight, group = true } = {}) {
  const usable = strokes.map((_, index) => index)
  const packed = packStrokes(strokes, width, height)
  // Single, already-separated lines (the accuracy fixtures) are one render. Page grouping is
  // exercised separately with real pen strokes; the skeleton-traced fixtures are not pen input.
  const grouped = group
    ? JSON.parse(inkGroupLines(packed))
    : [{ strokes: usable, minX: 0, minY: 0, maxX: width, maxY: height }]
  const reference = group
    ? median(grouped.filter((line) => line.strokes.length >= 2).map((line) => line.maxY - line.minY))
    : 0
  const lines = []
  let inferenceMs = 0
  for (const line of grouped) {
    const linePacked = packStrokes(line.strokes.map((index) => strokes[usable[index]]), width, height)
    const raw = inkLineImage(linePacked, reference, manifest.decoder.penWidth ?? 2.6, 0, 1)
    if (raw.length < 3) continue
    const image = raw.subarray(2)
    const t = Date.now()
    const { probabilities, dims } = await host.recognize({ input: Float32Array.from(image), width: raw[0], height: 64, threads: 4 })
    inferenceMs += Date.now() - t
    assert.equal(dims[2], manifest.classes, 'class count')
    let decoded = JSON.parse(inkDecode(probabilities, dims[2], manifest.alphabet, entry.language, decoderOptionsFor(entry.language)))
    const baseDecoded = decoded
    let penWidth = manifest.decoder.penWidth ?? 2.6
    let scale = 1
    let shear = 0
    const baseText = decoded.text
    const baseScore = decoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
    let spliceBest = null
    if (exactWords[entry.language]?.size && hasLongUnknownWord(baseText, knownWord(entry.language))) {
      let bestScore = baseScore
      const known = knownWord(entry.language)
      for (const variant of INK_RETRY_VARIANTS) {
        const retryRaw = inkLineImage(linePacked, reference, variant.penWidth, 0, variant.scale)
        if (retryRaw.length < 3) continue
        const retryImage = retryRaw.subarray(2)
        const retryStarted = Date.now()
        const retry = await host.recognize({ input: Float32Array.from(retryImage), width: retryRaw[0], height: 64, threads: 4 })
        inferenceMs += Date.now() - retryStarted
        const retryDecoded = JSON.parse(inkDecode(retry.probabilities, retry.dims[2], manifest.alphabet, entry.language, decoderOptionsFor(entry.language)))
        const retryScore = retryDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
        const wordFix = retryScore >= baseScore + WIDTH_RETRY_MARGIN
          && widthReadingKeepsKnownWords(baseText, retryDecoded.text, known)
        const mergeFix = retryScore >= baseScore + MERGE_SCORE_MARGIN
          && widthReadingMergesTwoWords(baseText, retryDecoded.text)
        const narrow = variant.scale === NARROW_SCALE
        const shortFix = narrow
          && retryScore >= baseScore + NARROW_WORD_MARGIN
          && oneUnknownWordBecomesKnown(baseText, retryDecoded.text, known)
        const lineFix = narrow
          && retryScore >= baseScore + NARROW_LINE_MARGIN
          && narrowScaleKeepsKnownWords(baseText, retryDecoded.text, known)
        if ((wordFix || mergeFix || shortFix || lineFix) && retryScore > bestScore) {
          decoded = retryDecoded
          penWidth = variant.penWidth
          scale = variant.scale
          bestScore = retryScore
          continue
        }
        if (narrow) continue
        if (retryScore < baseScore + SPLICE_SCORE_MARGIN) continue
        const edits = longUnknownWordEdits(baseText, retryDecoded.text, known)
        if (!edits || (spliceBest && retryScore <= spliceBest.score)) continue
        spliceBest = { score: retryScore, decoded: retryDecoded, penWidth: variant.penWidth, scale: variant.scale, edits }
      }
    }
    let boxes
    if (decoded.text === baseText && spliceBest) {
      const edited = charactersWithWordEdits(baseDecoded.characters, spliceBest.decoded.characters, spliceBest.edits)
      if (edited) {
        decoded = { ...baseDecoded, text: textWithWordEdits(baseText, spliceBest.edits), characters: edited.characters }
        const spanBoxes = (width, usedScale, characters) => {
          const spans = new Uint32Array(characters.flatMap((c) => [c.startFrame, c.endFrame]))
          return inkSpanBoxes(linePacked, reference, width, 0, usedScale, spans)
        }
        const baseBoxes = spanBoxes(manifest.decoder.penWidth ?? 2.6, 1, baseDecoded.characters)
        const altBoxes = spanBoxes(spliceBest.penWidth, spliceBest.scale, spliceBest.decoded.characters)
        boxes = new Float64Array(edited.characters.length * 4)
        edited.source.forEach((source, index) => {
          const from = source.alt ? altBoxes : baseBoxes
          boxes.set(from.subarray(source.index * 4, source.index * 4 + 4), index * 4)
        })
      }
    }
    if (decoded.text === baseText && exactWords[entry.language]?.size) {
      const shearRaw = inkLineImage(linePacked, reference, penWidth, INK_SHEAR_RETRY, scale)
      if (shearRaw.length >= 3) {
        const shearStarted = Date.now()
        const shearRun = await host.recognize({ input: Float32Array.from(shearRaw.subarray(2)), width: shearRaw[0], height: 64, threads: 4 })
        inferenceMs += Date.now() - shearStarted
        const shearDecoded = JSON.parse(inkDecode(shearRun.probabilities, shearRun.dims[2], manifest.alphabet, entry.language, decoderOptionsFor(entry.language)))
        const shearScore = shearDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
        if (shearScore >= baseScore + SHEAR_SCORE_MARGIN && shearReadingRewritesTwoWords(baseText, shearDecoded.text)) {
          decoded = shearDecoded
          shear = INK_SHEAR_RETRY
          boxes = undefined
        }
      }
    }
    if (hasMixedInteriorCase(decoded.text)) {
      const caseRaw = inkLineImage(linePacked, reference, penWidth, shear, MIXED_CASE_SCALE)
      if (caseRaw.length >= 3) {
        const caseStarted = Date.now()
        const caseRun = await host.recognize({ input: Float32Array.from(caseRaw.subarray(2)), width: caseRaw[0], height: 64, threads: 4 })
        inferenceMs += Date.now() - caseStarted
        const caseDecoded = JSON.parse(inkDecode(caseRun.probabilities, caseRun.dims[2], manifest.alphabet, entry.language, decoderOptionsFor(entry.language)))
        const caseScore = caseDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
        const currentScore = decoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
        if (caseScore > currentScore && sameLettersAllowingCapsJoin(decoded.text, caseDecoded.text)) {
          decoded = caseDecoded
          scale = MIXED_CASE_SCALE
          boxes = undefined
        }
      }
    }
    if (!boxes) {
      const spans = new Uint32Array(decoded.characters.flatMap((c) => [c.startFrame, c.endFrame]))
      boxes = inkSpanBoxes(linePacked, reference, penWidth, shear, scale, spans)
    }
    if (!decoded.text.trim()) continue
    lines.push({ decoded, boxes, characters: decoded.characters.length })
  }
  return { text: lines.map((l) => l.decoded.text).join('\n'), lines, inferenceMs }
}

// Stacks real pen-stroke lines into one page to exercise line grouping end to end. `entry`
// strokes are normalized to its own box; each copy lands on its own well-separated row.
const composePage = (entry, rows) => {
  const lineHeight = 46
  const rowGap = 92
  const strokes = []
  for (let row = 0; row < rows; row += 1) {
    for (const stroke of entry.strokes) {
      strokes.push(stroke.map(([x, y]) => [
        (70 + x * 760) / 900,
        (90 + row * rowGap + y * lineHeight) / 1273,
      ]))
    }
  }
  return { strokes, truth: Array.from({ length: rows }, () => entry.truth).join('\n') }
}

try {
  const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'))
  const rows = []
  let cold = 0
  const warm = []
  for (const entry of cases) {
    const started = Date.now()
    const result = await recognize(entry, { group: false })
    const elapsed = Date.now() - started
    if (!rows.length) cold = elapsed
    else warm.push(result.inferenceMs)
    rows.push({ name: entry.name, language: entry.language, truth: entry.truth, text: result.text, characters: result.lines.reduce((s, l) => s + l.characters, 0), boxes: result.lines.reduce((s, l) => s + l.boxes.filter((v, i) => i % 4 === 0 && Number.isFinite(v)).length, 0) })
    if (process.env.FANOTES_INK_DEBUG === '1') console.log(`${entry.name}\t${entry.truth}\t→ ${result.text}`)
  }
  const report = {}
  for (const language of ['de', 'en']) {
    const chosen = rows.filter((r) => r.language === language)
    if (chosen.length) report[language] = { lines: chosen.length, exact: chosen.filter((row) => row.text === row.truth).length, cer: Number(cer(chosen).toFixed(2)), wer: Number(wer(chosen).toFixed(2)) }
  }
  // One real pen line (IAM-OnDB) stacked into a 3-line page checks grouping end to end.
  const pages = []
  const penLine = cases.find((entry) => entry.name === 'iam-ondb-a01-001z-01')
  if (penLine) {
    const composed = composePage(penLine, 3)
    const result = await recognize({ language: 'en' }, { strokes: composed.strokes, width: 900, height: 1273, group: true })
    pages.push({ language: 'en', truth: composed.truth, text: result.text, lines: result.lines.length, expected: 3, cer: Number(cer([{ text: result.text, truth: composed.truth }]).toFixed(2)) })
    if (process.env.FANOTES_INK_DEBUG === '1') console.log(`page\t${composed.truth.replaceAll('\n', ' / ')}\t→ ${result.text.replaceAll('\n', ' / ')}`)
  }
  console.log(JSON.stringify({ model: manifest.version, report, pages: pages.map(({ language, lines, expected, cer }) => ({ language, lines, expected, cer })), coldMs: cold, warmMs: Math.round(warm.reduce((s, v) => s + v, 0) / Math.max(1, warm.length)) }, null, 2))

  if (!process.env.FANOTES_INK_CASES) {
    const iam = rows.find((r) => r.name === 'iam-ondb-a01-001z-01')
    assert.ok(iam, 'the IAM-OnDB example line is missing')
    assert.ok(cer([iam]) <= 8, `the real IAM-OnDB pen line is too inaccurate: ${JSON.stringify(iam)}`)
    assert.ok(report.de?.cer <= 8, `German handwriting (ScaDS, unseen writers) is too inaccurate: ${JSON.stringify(report.de)}`)
    assert.ok(rows.every((r) => r.boxes === r.characters), 'every recognized character needs a page position')
    for (const page of pages) {
      assert.equal(page.lines, page.expected, `page line splitting is wrong: ${JSON.stringify(page)}`)
      assert.ok(page.cer <= 8, `a stacked real-pen page is too inaccurate: ${JSON.stringify(page)}`)
    }
  }
} finally {
  host.stop()
}
