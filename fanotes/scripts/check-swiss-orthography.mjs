import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

try {
  const { BASE_CATALOG } = await server.ssrLoadModule('/../src/data/catalog.ts')
  const { GERMAN_COMMON_WORDS } = await server.ssrLoadModule('/../src/data/germanLanguage.ts')
  const { recognizedSentence } = await server.ssrLoadModule('/../src/lib/recognition.ts')
  const { containsGermanSharpS, isSupportedRecognitionLabel, normalizeGermanSharpS } = await server.ssrLoadModule('/../src/lib/orthography.ts')
  const { applyNeuralWordContext } = await server.ssrLoadModule('/src/lib/neuralTextRecognition.ts')
  const { synthesizeHandwriting } = await server.ssrLoadModule('/src/lib/textToHandwriting.ts')

  assert.equal(BASE_CATALOG.some((label) => label.char === 'ß' && label.id === 'german_eszett'), true)
  assert.equal(BASE_CATALOG.some((label) => /sharp[_-]?s/iu.test(label.id)), false)
  assert.equal([...GERMAN_COMMON_WORDS].some(containsGermanSharpS), false)
  assert.equal(normalizeGermanSharpS('Straße ẞ'), 'Strasse SS')
  assert.equal(isSupportedRecognitionLabel('ss', 'german_lower_sharp_s'), false)
  assert.equal(isSupportedRecognitionLabel('ß', 'german_eszett'), true)
  assert.equal(isSupportedRecognitionLabel('ẞ', 'custom-legacy'), false)
  assert.equal(isSupportedRecognitionLabel('ü', 'german_lower_u_umlaut'), true)

  const eszettToken = {
    labelId: 'german_eszett',
    char: 'ß',
    alternatives: [],
    confidence: 100,
    bbox: [0, 0, 0.1, 0.1],
  }
  assert.equal(recognizedSentence([eszettToken]), 'ß')
  assert.equal(applyNeuralWordContext('Straße ẞ', 'de'), 'Strasse SS')
  assert.equal(applyNeuralWordContext('ß', 'en'), 'ss')

  const synthesized = synthesizeHandwriting('Straße ẞ', [], {
    fontSize: 32,
    lineSpacing: 1.4,
    variation: 0.5,
    connectLetters: true,
    color: '#111111',
    baseWidth: 3,
    pressureEnabled: true,
    seed: 1,
  })
  assert.equal(synthesized.normalizedText, 'Strasse SS')
  assert.equal(synthesized.missingCharacters.includes('ß'), false)
  assert.equal(synthesized.missingCharacters.includes('ẞ'), false)

  console.log('Schweizer Orthografie geprüft: ß bleibt ein Buchstabe; Wörterbuch und Text-zu-Handschrift falten ß/ẞ weiter zu ss/SS.')
} finally {
  await server.close()
}
