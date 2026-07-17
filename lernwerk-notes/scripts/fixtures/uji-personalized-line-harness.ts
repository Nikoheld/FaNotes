import { BASE_CATALOG } from '../../../src/data/catalog'
import {
  buildRecognitionModel,
  connectedTextSegmentationHypotheses,
  estimatePenLiftTextCharacterCount,
  recognizeExpression,
  recognizedSentence,
  segmentStrokes,
  textCutCandidatesForTests,
} from '../../../src/lib/recognition'
import { createStandardRecognitionSamples } from '../../../src/lib/standardRecognition'
import { loadBrowserHandwritingRecognitionResources } from '../../src/lib/handwritingRecognitionResources'
import { loadBrowserSpellingResources, loadBrowserSpellingWordCandidates } from '../../src/lib/spellingResources'
import { recognizeNeuralText } from '../../src/lib/neuralTextRecognition'
import { recognizePersonalizedTextLine } from '../../src/lib/personalizedLineRecognition'
import {
  fusePersonalizedTextRecognition,
  personalizedDictionaryWordForTests,
  personalizedTextFusionSelectionScore,
} from '../../src/lib/personalizedTextRecognition'
import {
  createUjiWordStrokes,
  ujiPersonalSample,
  type UjiRecord,
} from './uji-personal-recognition-harness'

const editDistance = (first: string, second: string) => {
  const previous = Array.from({ length: second.length + 1 }, (_, index) => index)
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
    const current = [firstIndex]
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
      current.push(Math.min(
        previous[secondIndex] + 1,
        current[secondIndex - 1] + 1,
        previous[secondIndex - 1] + Number(first[firstIndex - 1] !== second[secondIndex - 1]),
      ))
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[second.length]
}

Object.assign(window, {
  lernwerk: {
    platform: 'web',
    loadHandwritingRecognitionResources: loadBrowserHandwritingRecognitionResources,
    loadSpellingResources: loadBrowserSpellingResources,
    loadSpellingWordCandidates: loadBrowserSpellingWordCandidates,
  },
})

export const runUjiPersonalizedLineAudit = async (records: UjiRecord[]) => {
  const parameters = new URLSearchParams(location.search)
  const useAllWriters = parameters.get('scope') === 'all'
  const includeDiagnostics = parameters.get('diagnostics') !== '0'
  const includeWordDiagnostics = parameters.get('word-diagnostics') === '1'
  const expectedCountDiagnosticsOnly = parameters.get('diagnostic-count') === 'expected'
  const requestedDiagnosticSegmentationIndex = Number(parameters.get('diagnostic-index') ?? '')
  const diagnosticSegmentationIndex = Number.isInteger(requestedDiagnosticSegmentationIndex)
    ? Math.max(0, Math.min(8, requestedDiagnosticSegmentationIndex))
    : null
  const useDeterministicNeuralFixture = parameters.get('mock-neural') === '1'
  const requestedLimit = Number(parameters.get('limit') ?? '12')
  const writerLimit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(60, requestedLimit)) : 12
  const requestedWriterOffset = Number(parameters.get('writer-offset') ?? '0')
  const writerOffset = Number.isSafeInteger(requestedWriterOffset)
    ? Math.max(0, Math.min(59, requestedWriterOffset))
    : 0
  const requestedWordsPerWriter = Number(parameters.get('words-per-writer') ?? '1')
  const wordsPerWriter = Number.isSafeInteger(requestedWordsPerWriter)
    ? Math.max(1, Math.min(12, requestedWordsPerWriter))
    : 1
  const requestedWordOffset = Number(parameters.get('word-offset') ?? '0')
  const wordOffset = Number.isSafeInteger(requestedWordOffset)
    ? Math.max(0, requestedWordOffset)
    : 0
  const requestedCorpus = parameters.get('corpus')
  const corpus = requestedCorpus === 'phrases' || requestedCorpus === 'multiline'
    ? requestedCorpus
    : 'words'
  const allWriters = [...new Set(records.map((record) => record.writer))]
    .filter((writer) => useAllWriters || writer.startsWith('tst_'))
  const requestedWriter = parameters.get('writer')
  if (requestedWriter && !allWriters.includes(requestedWriter)) {
    throw new Error(`Unknown UJI writer requested: ${requestedWriter}`)
  }
  const writers = requestedWriter
    ? [requestedWriter]
    : allWriters.slice(writerOffset, writerOffset + writerLimit)
  const words = [
    'fenster', 'garten', 'heute', 'morgen', 'seite', 'stift',
    'zahlen', 'wurzel', 'browser', 'familie', 'deutsch', 'symbol',
    'schule', 'arbeit', 'notizen', 'gleichung', 'lernen', 'mathe',
    'computer', 'hallo', 'test', 'aufgabe', 'papier', 'tabelle',
    'formel', 'rechnen', 'schreiben', 'zeichnen', 'ordner', 'datei',
    'wissen', 'privat', 'projekt', 'physik', 'chemie', 'biologie',
    'geschichte', 'informatik', 'wirtschaft', 'sprache', 'satz', 'buchstabe',
    'abstand', 'zeile', 'punkt', 'integral', 'summe', 'bruch',
    'index', 'grenze', 'funktion', 'variable', 'ergebnis', 'korrektur',
    'erkennung', 'training', 'beispiel', 'modell', 'lokal', 'sicher',
  ]
  const phrases = [
    'heute ist schule', 'morgen lernen wir', 'ich schreibe notizen',
    'die aufgabe ist sicher', 'papier und stift', 'mathe macht spass',
    'wir rechnen weiter', 'die formel stimmt', 'das ergebnis passt',
    'eine variable fehlt', 'die grenze ist null', 'funktion und integral',
    'physik im browser', 'chemie ist spannend', 'biologie lernen',
    'geschichte schreiben', 'informatik projekt', 'wirtschaft verstehen',
    'deutsche sprache', 'ein langer satz', 'jeder buchstabe passt',
    'der abstand stimmt', 'zweite zeile lesen', 'punkt und komma',
    'summe und bruch', 'index unter der zahl', 'wurzel aus neun',
    'gleichung korrektur', 'erkennung ohne cloud', 'training bleibt lokal',
    'ein neues beispiel', 'das modell lernt', 'daten bleiben sicher',
    'privates projekt', 'arbeit und schule', 'notizen im ordner',
    'datei auf papier', 'tabelle neu zeichnen', 'rechnen mit zahlen',
    'schreiben mit stift', 'wissen gut ordnen', 'familie und arbeit',
    'fenster im browser', 'garten am morgen', 'heute privat lernen',
    'symbol richtig lesen', 'formel sauber schreiben', 'computer bleibt lokal',
    'aufgabe fertig rechnen', 'papier richtig drehen', 'sprache automatisch erkennen',
    'abstand im wort', 'zeile von links', 'integral mit grenze',
    'funktion der variable', 'korrektur direkt lernen', 'beispiel ohne training',
    'modell mit kontext', 'sicheres lokales wissen', 'notizen weiter schreiben',
  ]
  const multilinePhrases = [
    'heute ist schule\nmorgen lernen wir',
    'ich schreibe notizen\ndie aufgabe ist sicher',
    'papier und stift\nmathe macht spass',
    'wir rechnen weiter\ndie formel stimmt',
    'das ergebnis passt\neine variable fehlt',
    'die grenze ist null\nfunktion und integral',
    'physik im browser\nchemie ist spannend',
    'biologie lernen\ngeschichte schreiben',
    'informatik projekt\nwirtschaft verstehen',
    'deutsche sprache\nein langer satz',
  ]
  const corpusValues = corpus === 'phrases'
    ? phrases
    : corpus === 'multiline' ? multilinePhrases : words
  const standard = await createStandardRecognitionSamples(BASE_CATALOG)
  const cases = []
  let neuralEdits = 0
  let fusedEdits = 0
  let characters = 0

  const deterministicNeuralFixture = (expected: string): NeuralTextRecognitionResult => {
    const text = ({
      fenster: 'heinster',
      mathe: 'münt',
      garten: 'sarten',
    } as Record<string, string>)[expected] ?? expected
    const visible = Array.from(text).filter((character) => !/\s/u.test(character))
    const confidence = text === expected ? 83 : 71
    return {
      text,
      confidence,
      engine: 'trocr-bilingual',
      wordCount: text.trim().split(/\s+/u).filter(Boolean).length,
      knownWordRatio: text === expected ? 1 : 0,
      lines: [{
        text,
        rawText: text,
        confidence,
        bbox: [0.04, 0.13, 0.9, 0.2],
        characters: visible.map((char, index) => ({
          char,
          confidence,
          start: index / Math.max(1, visible.length),
          end: (index + 1) / Math.max(1, visible.length),
        })),
      }],
    }
  }

  for (let writerIndex = 0; writerIndex < writers.length; writerIndex += 1) {
    const writer = writers[writerIndex]
    const writerWordIndex = allWriters.indexOf(writer)
    // Seventeen is coprime with the 60-word audit vocabulary. Successive
    // matrix columns therefore cover distant words instead of merely testing
    // neighbouring variants with similar lengths and letters.
    const expectedWords = Array.from({ length: wordsPerWriter }, (_, index) => (
      corpusValues[(writerWordIndex + (wordOffset + index) * 17) % corpusValues.length]
    ))
    const trainingRecords = records.filter((record) => record.writer === writer && record.session === 1)
    const personalSamples = trainingRecords.map(ujiPersonalSample)
    const model = await buildRecognitionModel([...personalSamples, ...standard])
    const resources = {
      model,
      samples: personalSamples,
      labels: BASE_CATALOG,
      layoutExamples: [],
      sampleCount: personalSamples.length,
      classCount: new Set(personalSamples.map((sample) => sample.labelId)).size,
      baselineSampleCount: standard.length,
      modelClassCount: new Set(model.map((entry) => entry.labelId)).size,
    }
    for (const expected of expectedWords) {
      const strokes = corpus === 'multiline'
        ? expected.split('\n').flatMap((line, lineIndex) => (
            createUjiWordStrokes(records, writer, 2, line, 0.04, 0.13 + lineIndex * 0.24, 0.066, 0.0035)
          ))
        : corpus === 'phrases'
          ? createUjiWordStrokes(records, writer, 2, expected, 0.04, 0.20, 0.066, 0.0035)
          : createUjiWordStrokes(records, writer, 2, expected)
      const neuralStartedAt = performance.now()
      const neural = useDeterministicNeuralFixture
        ? deterministicNeuralFixture(expected)
        : await recognizeNeuralText(strokes, 'de', 900, 560)
      const neuralMs = Math.round(performance.now() - neuralStartedAt)
      const personalizedStartedAt = performance.now()
      const personalized = await recognizePersonalizedTextLine(strokes, resources, neural, 'de', true)
      const personalizedMs = Math.round(performance.now() - personalizedStartedAt)
      const neuralText = neural.text.toLocaleLowerCase('de')
      const fusedText = personalized.fusion.text.toLocaleLowerCase('de')
      const neuralDistance = editDistance(expected, neuralText)
      const fusedDistance = editDistance(expected, fusedText)
      const neuralCharacterCount = Array.from(neural.text).filter((character) => !/\s/u.test(character)).length
      const segmentationCandidates = (neuralDistance || fusedDistance) && includeDiagnostics
        ? [...new Set(expectedCountDiagnosticsOnly ? [
            Array.from(expected).filter((character) => !/\s/u.test(character)).length,
          ] : [
            neuralCharacterCount - 2,
            neuralCharacterCount - 1,
            neuralCharacterCount,
            neuralCharacterCount + 1,
            neuralCharacterCount + 2,
            Array.from(expected).filter((character) => !/\s/u.test(character)).length,
          ])].flatMap((count) => {
            if (count < 1) return []
            const segmentationIndexes = diagnosticSegmentationIndex !== null
              ? [diagnosticSegmentationIndex]
              : expectedCountDiagnosticsOnly ? [0, 1, 2] : [0]
            return segmentationIndexes.map((segmentationIndex) => {
              const tokens = recognizeExpression(
                strokes,
                model,
                BASE_CATALOG,
                'text',
                [],
                'de',
                count,
                count === neuralCharacterCount ? neural.text : undefined,
                segmentationIndex,
              )
              const fusion = fusePersonalizedTextRecognition(
                tokens,
                neural,
                'de',
                estimatePenLiftTextCharacterCount(strokes) ?? undefined,
              )
              return {
                count,
                segmentationIndex,
                recognized: recognizedSentence(tokens),
                dictionaryCandidate: personalizedDictionaryWordForTests(
                  recognizedSentence(tokens),
                  tokens,
                  'de',
                ),
                compactDictionaryCandidate: personalizedDictionaryWordForTests(
                  recognizedSentence(tokens).replace(/\s+/gu, ''),
                  tokens,
                  'de',
                ),
                contextualDictionaryCandidate: personalizedDictionaryWordForTests(
                  recognizedSentence(tokens).replace(/\s+/gu, ''),
                  tokens,
                  'de',
                  neural.text,
                ),
                fused: fusion.text,
                score: personalizedTextFusionSelectionScore(fusion, neural, 'de'),
                tokenCount: tokens.length,
                tokens: tokens.map((token) => ({
                  id: token.id,
                  char: token.char,
                  confidence: token.confidence,
                  personalSupport: token.personalSupport ?? 0,
                  personalConfidence: token.personalConfidence ?? 0,
                  alternatives: token.alternatives.slice(0, 8).map((alternative) => ({
                    char: alternative.char,
                    personalSupport: alternative.personalSupport ?? 0,
                    personalConfidence: alternative.personalConfidence ?? 0,
                  })),
                })),
              }
            })
          })
        : []
      const rootCluster = segmentStrokes(strokes, 'text')[0]
      const segmentationHypotheses = (neuralDistance || fusedDistance) && includeDiagnostics && rootCluster
        ? connectedTextSegmentationHypotheses(
            rootCluster,
            Array.from(expected).filter((character) => !/\s/u.test(character)).length,
          ).map((hypothesis) => ({
            count: hypothesis.length,
            widths: hypothesis.map((part) => Math.round((part.maxX - part.minX) * 900)),
          }))
        : []
      const cutCandidates = (neuralDistance || fusedDistance) && includeDiagnostics
        ? textCutCandidatesForTests(strokes).map((candidate) => ({
            x: Math.round(candidate.x * 900),
            score: Math.round(candidate.score * 1_000) / 1_000,
          }))
        : []
      const expectedWordCandidates = (neuralDistance || fusedDistance) && includeWordDiagnostics && corpus !== 'words'
        ? expected.split(/\s+/u).map((word, wordIndex) => {
            const neuralWord = neural.text.split(/\s+/u)[wordIndex] ?? ''
            const wordStrokes = createUjiWordStrokes(records, writer, 2, word, 0.08, 0.20, 0.066, 0.0035)
            const tokens = recognizeExpression(
              wordStrokes,
              model,
              BASE_CATALOG,
              'text',
              [],
              'de',
              Array.from(word).length,
            )
            const recognized = recognizedSentence(tokens)
            return {
              expected: word,
              neuralWord,
              measured: estimatePenLiftTextCharacterCount(wordStrokes),
              recognized,
              dictionaryCandidate: personalizedDictionaryWordForTests(recognized, tokens, 'de'),
              neuralDictionaryCandidate: neuralWord
                ? personalizedDictionaryWordForTests(neuralWord, tokens, 'de')
                : null,
              tokens: tokens.map((token) => ({
                char: token.char,
                confidence: token.confidence,
                personalSupport: token.personalSupport ?? 0,
                personalConfidence: token.personalConfidence ?? 0,
                alternatives: token.alternatives.slice(0, 8).map((alternative) => ({
                  char: alternative.char,
                  confidence: alternative.confidence,
                  personalSupport: alternative.personalSupport ?? 0,
                  personalConfidence: alternative.personalConfidence ?? 0,
                })),
              })),
            }
          })
        : []
      neuralEdits += neuralDistance
      fusedEdits += fusedDistance
      characters += expected.length
      cases.push({
        writer,
        expected,
        neural: neuralText,
        fused: fusedText,
        neuralEdits: neuralDistance,
        fusedEdits: fusedDistance,
        neuralConfidence: neural.confidence,
        neuralMs,
        personalizedMs,
        fusion: personalized.fusion,
        candidateScores: personalized.candidateScores,
        penLiftCharacterCount: estimatePenLiftTextCharacterCount(strokes),
        segmentationCandidates,
        segmentationHypotheses,
        cutCandidates,
        expectedWordCandidates,
        tokens: (includeDiagnostics || fusedDistance > 0) ? personalized.tokens.map((token) => ({
          id: token.id,
          char: token.char,
          confidence: token.confidence,
          personalSupport: token.personalSupport,
          personalConfidence: token.personalConfidence,
          alternatives: token.alternatives.slice(0, 5).map((alternative) => ({
            char: alternative.char,
            confidence: alternative.confidence,
            personalSupport: alternative.personalSupport,
            personalConfidence: alternative.personalConfidence,
          })),
        })) : [],
      })
    }
  }
  return {
    writers,
    corpus,
    writerOffset,
    wordsPerWriter,
    wordOffset,
    trainingSamplesPerWriter: records.filter((record) => record.writer === writers[0] && record.session === 1).length,
    characters,
    neuralEdits,
    fusedEdits,
    neuralCer: neuralEdits / Math.max(1, characters),
    fusedCer: fusedEdits / Math.max(1, characters),
    cases,
  }
}
