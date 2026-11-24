'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const nspell = require('nspell')
const subtlex = require('subtlex-word-frequencies')

const root = path.resolve(__dirname, '..')
const output = path.join(root, 'public', 'spell')
const bitsPerWord = 12
const hashes = 8
// A supplementary dictionary may contain perfectly valid but extremely rare
// forms. They belong in spellchecking, but a single dictionary occurrence must
// not become positive evidence for replacing the visual OCR winner. Three
// independent SUBTLEX occurrences across 51 million spoken-English tokens are
// the deliberately low floor for joining the OCR candidate vocabulary.
const minimumSupplementalOcrFrequency = 3
const englishFrequencies = new Map(subtlex.map(({ word, count }) => [
  word.normalize('NFC').toLocaleLowerCase('en-US'),
  count,
]))

const locales = { de: 'de-DE', en: 'en-US', fr: 'fr-FR' }
// French typographic apostrophes are folded to the ASCII one, exactly like `normalizeWord` in src/lib/spelling.ts.
const normalizeWord = (word, language) => {
  const lower = word.normalize('NFC').toLocaleLowerCase(locales[language])
  return language === 'fr' ? lower.replaceAll('’', "'") : lower
}

const hashWord = (word, seed) => {
  let hash = seed >>> 0
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// dictionary-de lists Geburtstags but not the lemma Geburtstag. Without the
// lemma, the one-edit handwriting corrector rewrites a correct Geburtstag
// into Geburtstags.
const germanLemmaSupplements = ['geburtstag']

const dictionaries = {
  de: ['dictionary-de'],
  // Dicollecte / Grammalecte (MPL-2.0). The Hunspell file expands elided forms ("l'homme",
  // "qu'il", ...) and inverted pronouns ("dit-il") into roughly three million strings, which would
  // make the filter five times larger than the German one. Those are handled at lookup time
  // instead (an elision prefix is stripped, a hyphenated word is checked part by part), so the
  // filter only carries plain letter words plus the dictionary's own apostrophe and hyphen stems
  // ("aujourd'hui", "peut-être").
  fr: ['dictionary-fr'],
  // The handwriting corpora and real FaNotes notes contain both British and
  // American English. Treating a valid British form as unknown previously let
  // a lower visual beam replace `moustache`, `specialised`, or `deputise` with
  // a more common US word even when the first image reading was already right.
  en: ['dictionary-en', 'dictionary-en-gb'],
}

const frenchPlainWord = /^\p{L}+$/u
const frenchStemWord = /^\p{L}+(?:['\-]\p{L}+)+$/u

// A local build can point NODE_PATH at a directory holding the dictionary packages.
const dictionaryDirectory = (dictionary) => {
  const roots = [path.join(root, 'node_modules'), ...(process.env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean)]
  const found = roots.map((base) => path.join(base, dictionary)).find((candidate) => fs.existsSync(path.join(candidate, 'index.dic')))
  if (!found) throw new Error(`${dictionary} is not installed (npm ci).`)
  return found
}

const frenchStems = (dictionaryRoot) => fs.readFileSync(path.join(dictionaryRoot, 'index.dic'), 'utf8')
  .split('\n')
  .slice(1)
  .map((line) => line.split('/')[0].trim())
  .filter(Boolean)

const makeFilter = (language) => {
  const words = new Set()
  const ocrWords = new Set()
  for (const [dictionaryIndex, dictionary] of dictionaries[language].entries()) {
    const dictionaryRoot = dictionaryDirectory(dictionary)
    const checker = nspell(
      fs.readFileSync(path.join(dictionaryRoot, 'index.aff')),
      fs.readFileSync(path.join(dictionaryRoot, 'index.dic')),
    )
    const keys = language === 'fr'
      ? [
        ...Object.keys(checker.data).filter((key) => frenchPlainWord.test(key.normalize('NFC'))),
        ...frenchStems(dictionaryRoot).filter((stem) => frenchStemWord.test(stem.normalize('NFC').replaceAll('’', "'"))),
      ]
      : Object.keys(checker.data)
    for (const candidate of keys) {
      if (!/^\p{L}[\p{L}\p{M}'’\-]*$/u.test(candidate)) continue
      const source = normalizeWord(candidate, language)
      const normalized = language === 'de'
        ? source.replaceAll('ẞ', 'SS').replaceAll('ß', 'ss')
        : source
      words.add(normalized)
      if (
        dictionaryIndex === 0
        || language !== 'en'
        || (englishFrequencies.get(normalized) ?? 0) >= minimumSupplementalOcrFrequency
      ) ocrWords.add(normalized)
    }
  }
  if (language === 'de') {
    for (const word of germanLemmaSupplements) ocrWords.add(normalizeWord(word, 'de').replaceAll('ß', 'ss'))
  }
  const bitCount = Math.ceil((words.size * bitsPerWord) / 8) * 8
  const bytes = Buffer.alloc(bitCount / 8)
  for (const word of words) {
    const first = hashWord(word, 0x811c9dc5)
    const second = (hashWord(word, 0x9e3779b1) | 1) >>> 0
    for (let index = 0; index < hashes; index += 1) {
      const bit = ((first + Math.imul(index, second)) >>> 0) % bitCount
      bytes[bit >>> 3] |= 1 << (bit & 7)
    }
  }
  const candidateWords = [...ocrWords]
    .filter((word) => /^\p{L}{3,32}$/u.test(word))
    .sort()
  const candidateBytes = Buffer.from(`${candidateWords.join('\n')}\n`, 'utf8')
  return { bytes, bitCount, wordCount: words.size, candidateBytes, candidateWords }
}

fs.mkdirSync(output, { recursive: true, mode: 0o755 })
const languages = {}
for (const language of ['de', 'en', 'fr']) {
  const filter = makeFilter(language)
  const file = `${language}.bloom`
  const candidateFile = `${language}.words`
  fs.writeFileSync(path.join(output, file), filter.bytes, { mode: 0o644 })
  fs.writeFileSync(path.join(output, candidateFile), filter.candidateBytes, { mode: 0o644 })
  languages[language] = {
    file,
    bitCount: filter.bitCount,
    wordCount: filter.wordCount,
    sha256: crypto.createHash('sha256').update(filter.bytes).digest('hex'),
    candidates: {
      file: candidateFile,
      size: filter.candidateBytes.length,
      wordCount: filter.candidateWords.length,
      sha256: crypto.createHash('sha256').update(filter.candidateBytes).digest('hex'),
    },
  }
}
const { fr: french, ...baseLanguages } = languages
const manifest = {
  format: 'fanotes-spelling-bloom-v2',
  generatedFrom: {
    de: ['dictionary-de@3.0.0'],
    en: ['dictionary-en@4.0.0', 'dictionary-en-gb@3.0.0'],
    fr: ['dictionary-fr@3.0.0'],
  },
  ocrFrequencySource: 'SUBTLEXus via subtlex-word-frequencies@2.0.0',
  minimumSupplementalOcrFrequency,
  bitsPerWord,
  hashes,
  languages: baseLanguages,
  // French is an optional, separately loaded dictionary (spellcheck and corrections only; the
  // handwriting recognition does not use it). Its absence leaves German and English untouched.
  french,
}
fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
for (const [source, target] of [
  [path.join(root, 'node_modules', 'dictionary-de', 'license'), 'NOTICE-dictionary-de.txt'],
  [path.join(root, 'node_modules', 'dictionary-en', 'license'), 'LICENSE-dictionary-en.txt'],
  [path.join(root, 'node_modules', 'dictionary-en-gb', 'license'), 'LICENSE-dictionary-en-gb.txt'],
  [path.join(dictionaryDirectory('dictionary-fr'), 'license'), 'NOTICE-dictionary-fr.txt'],
  [path.join(root, 'public', 'licenses', 'LICENSE-MPL-2.0.txt'), 'LICENSE-MPL-2.0.txt'],
  [path.join(root, 'node_modules', 'nspell', 'license'), 'LICENSE-nspell.txt'],
  [path.join(root, 'node_modules', 'subtlex-word-frequencies', 'license'), 'LICENSE-SUBTLEX-WORD-FREQUENCIES-ISC.txt'],
]) {
  fs.copyFileSync(source, path.join(output, target))
  fs.chmodSync(path.join(output, target), 0o644)
}
console.log(`Rechtschreibfilter: ${languages.de.wordCount.toLocaleString('de-CH')} deutsche, ${languages.en.wordCount.toLocaleString('de-CH')} englische und ${languages.fr.wordCount.toLocaleString('de-CH')} französische Wortformen · ${((languages.de.bitCount + languages.en.bitCount + languages.fr.bitCount) / 8 / 1024).toFixed(0)} KiB`)
