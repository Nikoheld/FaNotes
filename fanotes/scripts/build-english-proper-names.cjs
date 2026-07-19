'use strict'

const fs = require('node:fs')
const path = require('node:path')
const subtlex = require('subtlex-word-frequencies')

const root = path.resolve(__dirname, '..')
const minimumFrequency = 3
const names = [...new Set(subtlex
  .filter(({ word, count }) => count >= minimumFrequency && /^[A-Z][a-z]{2,}$/u.test(word))
  .map(({ word }) => word.toLocaleLowerCase('en-US')))]
  .sort()
const lines = [
  '// Generated from subtlex-word-frequencies@2.0.0 by scripts/build-english-proper-names.cjs.',
  `// Canonical title-case forms require at least ${minimumFrequency} independent corpus occurrences.`,
  'export const ENGLISH_CANONICAL_PROPER_NAMES = new Set(`',
  ...names,
  "`.trim().split(/\\s+/u))",
  '',
]
const output = path.join(root, '..', 'src', 'data', 'englishProperNames.ts')
fs.writeFileSync(output, lines.join('\n'), { mode: 0o644 })
fs.chmodSync(output, 0o644)
console.log(`Englische Eigennamen: ${names.length.toLocaleString('de-CH')} corpusgestützte Formen.`)
