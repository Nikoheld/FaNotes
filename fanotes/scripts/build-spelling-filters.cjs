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

const normalizeWord = (word, language) => word.normalize('NFC').toLocaleLowerCase(language === 'de' ? 'de-DE' : 'en-US')

const hashWord = (word, seed) => {
  let hash = seed >>> 0
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

const dictionaries = {
  de: ['dictionary-de'],
  // The handwriting corpora and real FaNotes notes contain both British and
  // American English. Treating a valid British form as unknown previously let
  // a lower visual beam replace `moustache`, `specialised`, or `deputise` with
  // a more common US word even when the first image reading was already right.
  en: ['dictionary-en', 'dictionary-en-gb'],
}

const makeFilter = (language) => {
  const words = new Set()
  const ocrWords = new Set()
  for (const [dictionaryIndex, dictionary] of dictionaries[language].entries()) {
    const dictionaryRoot = path.join(root, 'node_modules', dictionary)
    const checker = nspell(
      fs.readFileSync(path.join(dictionaryRoot, 'index.aff')),
      fs.readFileSync(path.join(dictionaryRoot, 'index.dic')),
    )
    for (const candidate of Object.keys(checker.data)) {
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
for (const language of ['de', 'en']) {
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
const manifest = {
  format: 'fanotes-spelling-bloom-v2',
  generatedFrom: {
    de: ['dictionary-de@3.0.0'],
    en: ['dictionary-en@4.0.0', 'dictionary-en-gb@3.0.0'],
  },
  ocrFrequencySource: 'SUBTLEXus via subtlex-word-frequencies@2.0.0',
  minimumSupplementalOcrFrequency,
  bitsPerWord,
  hashes,
  languages,
}
fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
for (const [source, target] of [
  [path.join(root, 'node_modules', 'dictionary-de', 'license'), 'NOTICE-dictionary-de.txt'],
  [path.join(root, 'node_modules', 'dictionary-en', 'license'), 'LICENSE-dictionary-en.txt'],
  [path.join(root, 'node_modules', 'dictionary-en-gb', 'license'), 'LICENSE-dictionary-en-gb.txt'],
  [path.join(root, 'node_modules', 'nspell', 'license'), 'LICENSE-nspell.txt'],
  [path.join(root, 'node_modules', 'subtlex-word-frequencies', 'license'), 'LICENSE-SUBTLEX-WORD-FREQUENCIES-ISC.txt'],
]) {
  fs.copyFileSync(source, path.join(output, target))
  fs.chmodSync(path.join(output, target), 0o644)
}
console.log(`Rechtschreibfilter: ${languages.de.wordCount.toLocaleString('de-CH')} deutsche und ${languages.en.wordCount.toLocaleString('de-CH')} englische Wortformen · ${((languages.de.bitCount + languages.en.bitCount) / 8 / 1024).toFixed(0)} KiB`)
