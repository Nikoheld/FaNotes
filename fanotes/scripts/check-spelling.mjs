import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'vite'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('../public/spell/manifest.json', import.meta.url), 'utf8'))
const de = new Uint8Array(await readFile(new URL('../public/spell/de.bloom', import.meta.url)))
const en = new Uint8Array(await readFile(new URL('../public/spell/en.bloom', import.meta.url)))
const deWords = new Uint8Array(await readFile(new URL('../public/spell/de.words', import.meta.url)))
const enWords = new Uint8Array(await readFile(new URL('../public/spell/en.words', import.meta.url)))

assert.equal(manifest.format, 'fanotes-spelling-bloom-v2')
assert.ok(de.byteLength + en.byteLength < 700 * 1024, 'Die Wörterbuchfilter müssen start- und speichereffizient bleiben.')
assert.equal(createHash('sha256').update(de).digest('hex'), manifest.languages.de.sha256)
assert.equal(createHash('sha256').update(en).digest('hex'), manifest.languages.en.sha256)
assert.equal(createHash('sha256').update(deWords).digest('hex'), manifest.languages.de.candidates.sha256)
assert.equal(createHash('sha256').update(enWords).digest('hex'), manifest.languages.en.candidates.sha256)
assert.deepEqual(manifest.generatedFrom.en, ['dictionary-en@4.0.0', 'dictionary-en-gb@3.0.0'])
assert.equal(manifest.minimumSupplementalOcrFrequency, 3)

globalThis.window = {
  fanotes: {
    loadSpellingResources: async () => ({ manifest, de, en }),
    loadSpellingWordCandidates: async (language) => ({
      language,
      descriptor: manifest.languages[language].candidates,
      bytes: language === 'de' ? deWords : enWords,
    }),
  },
}

const server = await createServer({ root: new URL(root).pathname, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true }, appType: 'custom', logLevel: 'error' })
try {
  const { checkSpelling, loadSpellingWordContext } = await server.ssrLoadModule('/src/lib/spelling.ts')
  const { applyFinalNeuralWordContext, applyNeuralWordContext } = await server.ssrLoadModule('/src/lib/neuralWordContext.ts')
  const check = (text, options = {}) => checkSpelling({ segments: [{ from: 0, text }], ...options })

  const german = await check('Das ist ein Tset und die Strasse ist gross. Rechtschreibprüfung funktioniert.')
  assert.deepEqual(german.errors.map(({ word }) => word), ['Tset'])
  assert.equal(german.detectedLanguage, 'de')

  const english = await check('This is an exampel and the simple word is correct.')
  assert.deepEqual(english.errors.map(({ word }) => word), ['exampel'])
  assert.equal(english.detectedLanguage, 'en')

  const british = await check('The specialised enquiry noted a moustache before they deputise the officer at Chequers.')
  assert.deepEqual(british.errors, [], 'Gültige britische Schreibweisen dürfen weder im Editor noch bei Eigennamen rot markiert werden.')

  const mixed = await checkSpelling({ segments: [
    { from: 0, text: 'Das ist ein deutscher Satz.' },
    { from: 30, text: 'This is an English sentence.' },
  ] })
  assert.equal(mixed.detectedLanguage, 'mixed')
  assert.deepEqual(mixed.errors, [])

  const markdown = await check('Formel $exampel + Tset$ und `exampel` bleibt korrekt.')
  assert.deepEqual(markdown.errors, [])

  const cursor = await check('Das ist ein Tset', { cursorPositions: [16] })
  assert.deepEqual(cursor.errors, [])

  const excluded = await check('Das ist ein Tset.', { ignoredRanges: [{ from: 12, to: 16 }] })
  assert.deepEqual(excluded.errors, [])

  await loadSpellingWordContext('de')
  assert.equal(applyNeuralWordContext('fenxter', 'de'), 'fenxter', 'Das Vollwörterbuch darf die visuelle Modellwahl nicht vorwegnehmen.')
  assert.equal(applyFinalNeuralWordContext('fenxter', 'de'), 'fenster')
  assert.equal(applyNeuralWordContext('sarten', 'de'), 'sarten', 'Mehrdeutige Vollwörterbuch-Nachbarn müssen ohne visuelle Evidenz unverändert bleiben.')
  const englishOcrMembership = await loadSpellingWordContext('en')
  for (const word of ['moustache', 'specialised', 'deputise']) {
    assert.equal(englishOcrMembership(word), true, `${word} muss als corpusgestützte britische OCR-Form gelten.`)
  }
  assert.equal(
    englishOcrMembership('chequers'),
    false,
    'Eine nur zweimal belegte Ergänzungsform darf Rechtschreibung sein, aber keine visuelle OCR-Hypothese verdrängen.',
  )
} finally {
  await server.close()
}

console.log('Rechtschreibprüfung: Deutsch, Englisch, Mischtext, Schweizer Schreibweise, Markdown-Ausnahmen und Tipp-Cursor geprüft.')
