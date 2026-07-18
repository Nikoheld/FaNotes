'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const nspell = require('nspell')

const root = path.resolve(__dirname, '..')
const output = path.join(root, 'public', 'spell')
const bitsPerWord = 12
const hashes = 8

const normalizeWord = (word, language) => word.normalize('NFC').toLocaleLowerCase(language === 'de' ? 'de-DE' : 'en-US')

const hashWord = (word, seed) => {
  let hash = seed >>> 0
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

const makeFilter = (language) => {
  const dictionaryRoot = path.join(root, 'node_modules', `dictionary-${language}`)
  const checker = nspell(
    fs.readFileSync(path.join(dictionaryRoot, 'index.aff')),
    fs.readFileSync(path.join(dictionaryRoot, 'index.dic')),
  )
  const words = new Set()
  for (const candidate of Object.keys(checker.data)) {
    if (!/^\p{L}[\p{L}\p{M}'’\-]*$/u.test(candidate)) continue
    const source = normalizeWord(candidate, language)
    const normalized = language === 'de'
      ? source.replaceAll('ẞ', 'SS').replaceAll('ß', 'ss')
      : source
    words.add(normalized)
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
  const candidateWords = [...words]
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
  generatedFrom: { de: 'dictionary-de@3.0.0', en: 'dictionary-en@4.0.0' },
  bitsPerWord,
  hashes,
  languages,
}
fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
for (const [source, target] of [
  [path.join(root, 'node_modules', 'dictionary-de', 'license'), 'NOTICE-dictionary-de.txt'],
  [path.join(root, 'node_modules', 'dictionary-en', 'license'), 'LICENSE-dictionary-en.txt'],
  [path.join(root, 'node_modules', 'nspell', 'license'), 'LICENSE-nspell.txt'],
]) {
  fs.copyFileSync(source, path.join(output, target))
  fs.chmodSync(path.join(output, target), 0o644)
}
console.log(`Rechtschreibfilter: ${languages.de.wordCount.toLocaleString('de-CH')} deutsche und ${languages.en.wordCount.toLocaleString('de-CH')} englische Wortformen · ${((languages.de.bitCount + languages.en.bitCount) / 8 / 1024).toFixed(0)} KiB`)
