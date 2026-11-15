// Builds the writing mode's thesaurus files from their sources:
//   German:  OpenThesaurus text export (LGPL-2.1), https://www.openthesaurus.de
//   English: Princeton WordNet 3.1 (WordNet licence), https://wordnet.princeton.edu
// Output: public/writing/thesaurus/{de,en}.txt — one synonym group per line,
// words separated by "|", the part of speech first for English ("n|v|a|r").
// The files are committed; run this only to refresh them:
//   node scripts/build-writing-thesaurus.mjs <OpenThesaurus-Textversion.zip> <wn3.1.dict.tar.gz> <WordNet-3.0/LICENSE>
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'public', 'writing', 'thesaurus')
const [openThesaurusZip, wordnetTarball] = process.argv.slice(2)
if (!openThesaurusZip || !wordnetTarball) throw new Error('Usage: node scripts/build-writing-thesaurus.mjs <OpenThesaurus-Textversion.zip> <wn3.1.dict.tar.gz>')
fs.mkdirSync(out, { recursive: true })
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fanotes-thesaurus-'))

// German: "# comment" lines, otherwise "word;word (Erläuterung);…".
execFileSync('unzip', ['-o', '-q', openThesaurusZip, '-d', work])
const germanSource = fs.readdirSync(work).find((name) => name.endsWith('.txt') && name.toLowerCase().includes('openthesaurus'))
if (!germanSource) throw new Error('openthesaurus.txt not found in the archive')
const germanGroups = new Set()
for (const line of fs.readFileSync(path.join(work, germanSource), 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue
  const words = [...new Set(line.split(';')
    .map((word) => word.replace(/\([^)]*\)?/gu, '').replace(/\s+/gu, ' ').trim())
    // Placeholders ("in ...dingen", "Darm...") and unbalanced notes are not words a writer can insert.
    .filter((word) => word && word.length <= 40 && !/[|()]|\.\.\.|…/u.test(word)))]
  if (words.length >= 2) germanGroups.add(words.slice(0, 24).join('|'))
}
fs.writeFileSync(path.join(out, 'de.txt'), `${[...germanGroups].join('\n')}\n`)
// writeFileSync, not copyFileSync: a read-only source licence must not make the output read-only.
fs.writeFileSync(path.join(out, 'LICENSE-openthesaurus.txt'), fs.readFileSync(path.join(work, fs.readdirSync(work).find((name) => /lizenz|license|lgpl/iu.test(name)) ?? germanSource)))

// English: WordNet data.{noun,verb,adj,adv}: "offset lex_filenum ss_type w_cnt(hex) word lex_id …".
execFileSync('tar', ['-xzf', wordnetTarball, '-C', work])
const dictDir = ['dict', 'wn3.1.dict', 'WordNet-3.1/dict'].map((name) => path.join(work, name)).find((candidate) => fs.existsSync(path.join(candidate, 'data.noun')))
if (!dictDir) throw new Error('WordNet dict/ not found in the archive')
const englishGroups = new Set()
for (const [file, pos] of [['data.noun', 'n'], ['data.verb', 'v'], ['data.adj', 'a'], ['data.adv', 'r']]) {
  for (const line of fs.readFileSync(path.join(dictDir, file), 'utf8').split('\n')) {
    if (!line || line.startsWith('  ')) continue
    const fields = line.split(' ')
    const count = parseInt(fields[3], 16)
    const words = []
    for (let index = 0; index < count; index += 1) {
      const word = fields[4 + index * 2].replace(/_/gu, ' ').replace(/\(.*\)$/u, '')
      if (!words.includes(word)) words.push(word)
    }
    if (words.length >= 2) englishGroups.add(`${pos}|${words.slice(0, 24).join('|')}`)
  }
}
fs.writeFileSync(path.join(out, 'en.txt'), `${[...englishGroups].join('\n')}\n`)
// The 3.1 data archive carries no licence file; the licence is the one shipped with WordNet 3.0
// (pass its path as the third argument, from WordNet-3.0.tar.gz: WordNet-3.0/LICENSE).
const wordnetLicense = process.argv[4] ?? path.join(dictDir, '..', 'LICENSE')
if (!fs.existsSync(wordnetLicense)) throw new Error('WordNet LICENSE not found; pass it as the third argument')
fs.writeFileSync(path.join(out, 'LICENSE-wordnet.txt'), fs.readFileSync(wordnetLicense))
fs.rmSync(work, { recursive: true, force: true })
console.log(`thesaurus: ${germanGroups.size} German and ${englishGroups.size} English synonym groups`)
