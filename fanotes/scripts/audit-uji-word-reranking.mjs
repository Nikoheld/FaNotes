import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const casesPath = process.env.FANOTES_UJI_CASES?.trim()
assert.ok(casesPath && fs.statSync(casesPath).isFile(), 'FANOTES_UJI_CASES muss auf einen vollständigen UJI-Fallbericht zeigen.')

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const wordSets = {
  de: [
    'test', 'hallo', 'mathematik', 'wirtschaft', 'handschrift', 'schule',
    'privat', 'arbeit', 'notizen', 'quadrat', 'quiz', 'system', 'zwischen',
    'lernen', 'Fabio', 'Niko',
  ],
  en: [
    'test', 'hello', 'handwriting', 'mathematics', 'business', 'private',
    'work', 'notes', 'quick', 'query', 'system', 'yellow', 'quality',
    'normal', 'Fabio', 'Niko',
  ],
}

try {
  const audit = JSON.parse(fs.readFileSync(casesPath, 'utf8'))
  const cases = audit.writerIndependent?.cases
  assert.ok(Array.isArray(cases) && cases.length >= 124, 'Der UJI-Bericht enthält keine vollständigen Einzelfälle.')
  const {
    applyTextReranking,
    installRecognitionProperNameMembership,
    installRecognitionWordCandidateProvider,
    installRecognitionWordMembership,
    recognizedSentence,
  } = await server.ssrLoadModule('/../src/lib/recognition.ts')
  const { BASE_CATALOG } = await server.ssrLoadModule('/../src/data/catalog.ts')
  const { ENGLISH_CANONICAL_PROPER_NAMES } = await server.ssrLoadModule('/../src/data/englishProperNames.ts')
  const { SUPPLEMENTAL_CANONICAL_PROPER_NAMES } = await server.ssrLoadModule('/../src/data/supplementalProperNames.ts')
  const properNameMembership = (word) => (
    ENGLISH_CANONICAL_PROPER_NAMES.has(word) || SUPPLEMENTAL_CANONICAL_PROPER_NAMES.has(word)
  )
  installRecognitionProperNameMembership('de', properNameMembership)
  installRecognitionProperNameMembership('en', properNameMembership)
  for (const language of ['de', 'en']) {
    const wordsPath = path.join(appRoot, 'public', 'spell', `${language}.words`)
    const wordList = fs.readFileSync(wordsPath, 'utf8').trimEnd().split('\n')
    const words = new Set(wordList)
    const byLength = new Map()
    wordList.forEach((word) => {
      const length = [...word].length
      const bucket = byLength.get(length)
      if (bucket) bucket.push(word)
      else byLength.set(length, [word])
    })
    installRecognitionWordMembership(language, (word) => words.has(word))
    installRecognitionWordCandidateProvider(language, (length) => byLength.get(length) ?? [])
  }
  const labelByChar = new Map(BASE_CATALOG.map((label) => [label.char, label]))
  const casesByKey = new Map(cases.map((entry) => [
    `${entry.writer}:${entry.session}:${entry.expected}`,
    entry,
  ]))
  const writers = [...new Set(cases.map((entry) => entry.writer))].sort()
  const sessions = [1, 2]
  const results = []

  const tokenFromCase = (entry, index, left) => {
    const primaryLabel = labelByChar.get(entry.recognized)
    assert.ok(primaryLabel, `Unbekanntes Resultat ${entry.recognized}.`)
    const alternatives = entry.alternatives.flatMap((candidate) => {
      const label = labelByChar.get(candidate.char)
      return label ? [{
        labelId: label.id,
        char: label.char,
        name: label.name,
        confidence: candidate.confidence,
        baseConfidence: candidate.baseConfidence,
        personalConfidence: candidate.personalConfidence,
        personalSupport: candidate.personalSupport,
      }] : []
    })
    const height = 0.08
    const width = Math.max(0.018, Math.min(0.1, entry.physicalAspect * height))
    return {
      id: `uji-word-${entry.writer}-${entry.session}-${index}`,
      strokes: [],
      imageData: '',
      bbox: [left, 0.24, width, height],
      labelId: primaryLabel.id,
      char: primaryLabel.char,
      name: primaryLabel.name,
      latex: primaryLabel.latex,
      confidence: entry.confidence,
      baseConfidence: entry.baseConfidence,
      personalConfidence: entry.personalConfidence,
      personalSupport: entry.personalSupport,
      alternatives,
      visualLabelId: primaryLabel.id,
      visualConfidence: entry.confidence,
    }
  }

  Object.entries(wordSets).forEach(([language, words]) => {
    writers.forEach((writer) => sessions.forEach((session) => words.forEach((expected) => {
      const entries = [...expected].map((char) => casesByKey.get(`${writer}:${session}:${char}`))
      assert.ok(entries.every(Boolean), `Fehlende UJI-Zeichen für ${writer} S${session}: ${expected}`)
      let cursor = 0.04
      const tokens = entries.map((entry, index) => {
        const token = tokenFromCase(entry, index, cursor)
        cursor += token.bbox[2] + 0.006
        return token
      })
      const before = tokens.map((token) => token.char).join('')
      const recoverable = entries.every((entry, index) => (
        [entry.recognized, ...entry.alternatives.map((candidate) => candidate.char)]
          .includes([...expected][index])
      ))
      const reranked = applyTextReranking(tokens, BASE_CATALOG, language)
      const after = recognizedSentence(reranked)
      results.push({ language, writer, session, expected, before, after, recoverable })
    })))
  })

  const summarize = (field) => {
    const exact = results.filter((entry) => entry[field] === entry.expected).length
    const caseNormalized = results.filter((entry) => (
      entry[field].toLocaleLowerCase(entry.language) === entry.expected.toLocaleLowerCase(entry.language)
    )).length
    const characters = results.reduce((sum, entry) => sum + [...entry.expected].length, 0)
    const correctCharacters = results.reduce((sum, entry) => (
      sum + [...entry.expected].filter((char, index) => [...entry[field]][index] === char).length
    ), 0)
    return {
      exactWords: exact,
      exactWordAccuracy: Math.round(exact / results.length * 10_000) / 100,
      caseNormalizedWords: caseNormalized,
      caseNormalizedWordAccuracy: Math.round(caseNormalized / results.length * 10_000) / 100,
      characters,
      correctCharacters,
      characterAccuracy: Math.round(correctCharacters / characters * 10_000) / 100,
    }
  }
  const before = summarize('before')
  const after = summarize('after')
  const recoverable = results.filter((entry) => entry.recoverable)
  const recoveredFromOracle = recoverable.filter((entry) => entry.after === entry.expected)
  const regressions = results.filter((entry) => entry.before === entry.expected && entry.after !== entry.expected)
  const recoveries = results.filter((entry) => entry.before !== entry.expected && entry.after === entry.expected)
  const unresolved = results.filter((entry) => entry.after !== entry.expected)
  const byWord = Object.entries(wordSets).flatMap(([language, words]) => words.map((expected) => {
    const matching = results.filter((entry) => entry.language === language && entry.expected === expected)
    const available = matching.filter((entry) => entry.recoverable)
    return {
      language,
      expected,
      cases: matching.length,
      beforeExact: matching.filter((entry) => entry.before === expected).length,
      afterExact: matching.filter((entry) => entry.after === expected).length,
      afterCaseNormalized: matching.filter((entry) => (
        entry.after.toLocaleLowerCase(language) === expected.toLocaleLowerCase(language)
      )).length,
      recoverable: available.length,
      recoveredFromOracle: available.filter((entry) => entry.after === expected).length,
    }
  }))
  const recoverableUnresolved = unresolved.filter((entry) => entry.recoverable)
  const caseOnlyUnresolved = recoverableUnresolved.filter((entry) => (
    entry.after.toLocaleLowerCase(entry.language) === entry.expected.toLocaleLowerCase(entry.language)
  ))
  const characterUnresolved = recoverableUnresolved.filter((entry) => (
    entry.after.toLocaleLowerCase(entry.language) !== entry.expected.toLocaleLowerCase(entry.language)
  ))
  console.log(JSON.stringify({
    writers: writers.length,
    cases: results.length,
    before,
    after,
    oracle: {
      recoverableWords: recoverable.length,
      recoverableWordAccuracy: Math.round(recoverable.length / results.length * 10_000) / 100,
      recoveredWords: recoveredFromOracle.length,
      recoveredWordAccuracy: Math.round(recoveredFromOracle.length / Math.max(1, recoverable.length) * 10_000) / 100,
    },
    recoveries: recoveries.length,
    regressions: regressions.length,
    recoverableUnresolved: {
      words: recoverableUnresolved.length,
      caseOnly: caseOnlyUnresolved.length,
      differentCharacters: characterUnresolved.length,
      characterExamples: characterUnresolved.slice(0, 80),
    },
    byWord,
    recoveryExamples: recoveries.slice(0, 30),
    regressionExamples: regressions.slice(0, 30),
    unresolvedExamples: unresolved.slice(0, 60),
  }, null, 2))
  if (process.env.FANOTES_UJI_WORDS_STRICT === '1') {
    assert.ok(after.exactWordAccuracy >= 50, `Zu wenige vollständige Wörter rekonstruiert: ${after.exactWordAccuracy}%`)
    assert.ok(after.characterAccuracy >= 83, `Zu wenige Zeichen im Wortkontext korrekt: ${after.characterAccuracy}%`)
    assert.ok(
      recoveredFromOracle.length / Math.max(1, recoverable.length) >= 0.68,
      'Der Wortstrahl nutzt die vorhandenen visuellen Top-8-Kandidaten zu schwach.',
    )
    assert.ok(regressions.length <= 1, `Der Wortkontext beschädigt korrekte visuelle Wörter: ${JSON.stringify(regressions)}`)
  }
} finally {
  await server.close()
}
