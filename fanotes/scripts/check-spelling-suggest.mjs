import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

// Spelling corrections: candidates one (or two) edits away verified against the
// shipped exact word lists, ranked by how likely the slip is, the conservative
// rule that lets a fix apply while typing, the personal dictionary, and the
// editor plumbing (Backspace revert, minimal document replacement) around them.

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const wordList = (file) => new Set(readFileSync(new URL(`../public/spell/${file}`, import.meta.url), 'utf8').split('\n').filter(Boolean))

try {
  const suggest = await server.ssrLoadModule('/src/lib/spellingSuggest.ts')
  const text = await server.ssrLoadModule('/src/lib/textReplacement.ts')
  const lists = { de: wordList('de.words'), en: wordList('en.words') }
  // The exact lists hold no German compounds; the app's lexicon accepts them
  // through the Bloom compound split. Mirror that with a two-part split here.
  const isCompound = (word) => {
    for (let cut = 3; cut <= word.length - 3; cut += 1) if (lists.de.has(word.slice(0, cut)) && lists.de.has(word.slice(cut))) return true
    return false
  }
  const lexicon = {
    hasWord: (language, word) => lists[language].has(word) || (language === 'de' && word.length >= 8 && isCompound(word)),
    candidatePenalty: (language, word) => (lists[language].has(word) ? 0 : 15),
  }
  const words = (suggestions) => suggestions.map((entry) => entry.word)

  // ── Candidate generation ─────────────────────────────────────────────────
  const edits = suggest.editsAtDistanceOne('abc', 'abc')
  assert.ok(edits.some((edit) => edit.word === 'bac' && edit.kind === 'transpose'))
  assert.ok(edits.some((edit) => edit.word === 'ab' && edit.kind === 'delete'))
  assert.ok(edits.some((edit) => edit.word === 'abbc' && edit.kind === 'double'), 'inserting a repeat of a neighbour is a doubled letter')
  assert.ok(edits.some((edit) => edit.word === 'cbc' && edit.kind === 'replace'))

  // ── Ranking ──────────────────────────────────────────────────────────────
  const teh = suggest.suggestCorrections('teh', ['en'], lexicon)
  assert.equal(teh[0].word, 'the', `transposition ranks first: ${words(teh)}`)
  const wiht = suggest.suggestCorrections('wiht', ['en'], lexicon)
  assert.ok(words(wiht).includes('with'), `wiht → with among ${words(wiht)}`)
  const hasu = suggest.suggestCorrections('Hasu', ['de'], lexicon)
  assert.equal(hasu[0].word, 'Haus', `case restored and transposition first: ${words(hasu)}`)
  const upper = suggest.suggestCorrections('HASU', ['de'], lexicon)
  assert.equal(upper[0].word, 'HAUS', 'all-caps typed → all-caps suggestion')
  const umlaut = suggest.suggestCorrections('Schuler', ['de'], lexicon)
  assert.ok(words(umlaut).includes('Schüler'), `umlaut slip suggests Schüler: ${words(umlaut)}`)
  const split = suggest.suggestCorrections('auchdas', ['de'], lexicon)
  assert.equal(split[0].word, 'auch das', `missing space ranks above a glued compound: ${words(split)}`)
  const two = suggest.suggestCorrections('Hausafgbaen', ['de'], lexicon)
  assert.ok(words(two).includes('Hausaufgaben'), `two edits found for a long word: ${words(two)}`)
  assert.deepEqual(suggest.suggestCorrections('Hausafgbaen', ['de'], lexicon, { maxDistance: 1 }).filter((entry) => entry.word === 'Hausaufgaben'), [], 'distance-one mode skips the two-edit search')
  const both = suggest.suggestCorrections('hte', ['de', 'en'], lexicon)
  assert.ok(words(both).includes('the'), `unknown line language searches both lists: ${words(both)}`)
  assert.ok(suggest.suggestCorrections('qzxwv', ['de', 'en'], lexicon).length === 0, 'garbage yields nothing')
  assert.ok(suggest.suggestCorrections('12ab', ['de'], lexicon).length === 0, 'non-letters are not corrected')

  // ── Autocorrect decision ─────────────────────────────────────────────────
  const context = { language: 'de', sentenceStart: false, isProperName: () => false }
  const decide = (typed, options = {}) => {
    const merged = { ...context, ...options }
    const languages = merged.language ? [merged.language] : ['de', 'en']
    return suggest.decideAutocorrect(typed, suggest.suggestCorrections(typed, languages, lexicon, { limit: 4, maxDistance: 1 }), merged)
  }
  assert.equal(decide('teh', { language: 'en' })?.word, 'the', 'a clear transposition is applied')
  assert.equal(decide('Hasu')?.word, 'Haus')
  assert.equal(decide('wiht', { language: 'en' })?.word, 'with', 'two transpositions (with / whit): the everyday word breaks the tie')
  assert.equal(decide('Jonas', { language: 'en' }), null, 'a capitalised word mid-sentence in English is a name')
  assert.equal(decide('Fabio', { language: 'en', sentenceStart: true, isProperName: (word) => word === 'fabio' }), null, 'known proper names stay')
  assert.equal(decide('iPhone'), null, 'camelCase stays')
  assert.equal(decide('NASA'), null, 'acronyms stay')
  assert.equal(decide('ab'), null, 'too short')
  const replaceOnly = suggest.decideAutocorrect('haxs', [{ word: 'haus', distance: 1, score: 130, language: 'de' }], context)
  assert.equal(replaceOnly, null, 'a plain letter replacement is never automatic')
  const tie = suggest.decideAutocorrect('xyz', [
    { word: 'abc', distance: 1, score: 100, language: 'de' },
    { word: 'abd', distance: 1, score: 110, language: 'de' },
  ], context)
  assert.equal(tie, null, 'a runner-up within 20 points blocks the autocorrect')
  const clear = suggest.decideAutocorrect('xyz', [
    { word: 'abc', distance: 1, score: 100, language: 'de' },
    { word: 'abd', distance: 1, score: 125, language: 'de' },
  ], context)
  assert.equal(clear?.word, 'abc')
  assert.equal(suggest.decideAutocorrect('xyz', [{ word: 'ab c', distance: 1, score: 100, language: 'de' }], context), null, 'a split into two words is a suggestion, never automatic')

  // ── Personal dictionary and session state ────────────────────────────────
  const storage = new Map()
  const fakeStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  suggest.resetPersonalDictionaryCache()
  assert.equal(suggest.isUserAcceptedWord('Nikoheld', fakeStorage), false)
  assert.ok(suggest.addPersonalWord('Nikoheld', fakeStorage))
  assert.equal(suggest.isUserAcceptedWord('nikoheld', fakeStorage), true, 'case-insensitive')
  assert.equal(suggest.isUserAcceptedWord('NIKOHELD', fakeStorage), true)
  assert.deepEqual(JSON.parse(storage.get(suggest.PERSONAL_DICTIONARY_STORAGE_KEY)), ['nikoheld'], 'persisted normalized')
  suggest.resetPersonalDictionaryCache()
  assert.equal(suggest.isUserAcceptedWord('Nikoheld', fakeStorage), true, 'read back from storage after a restart')
  assert.ok(suggest.removePersonalWord('Nikoheld', fakeStorage))
  assert.equal(suggest.isUserAcceptedWord('Nikoheld', fakeStorage), false)
  suggest.ignoreWordForSession('Straßenbahnhaltestelle')
  assert.equal(suggest.isUserAcceptedWord('strassenbahnhaltestelle', fakeStorage), true, 'ß and ss are the same word')
  assert.equal(suggest.isAutocorrectDeclined('teh'), false)
  suggest.declineAutocorrect('teh')
  assert.equal(suggest.isAutocorrectDeclined('Teh'), true, 'a reverted autocorrect is not applied again')
  suggest.resetPersonalDictionaryCache()

  // ── Minimal document replacement keeps the cursor ────────────────────────
  assert.deepEqual(text.minimalReplacement('Hallo Welt\n', 'Hallo Welt'), { from: 10, to: 11, insert: '' })
  assert.deepEqual(text.minimalReplacement('abc', 'abXc'), { from: 2, to: 2, insert: 'X' })
  assert.deepEqual(text.minimalReplacement('same', 'same'), { from: 4, to: 4, insert: '' })
  assert.deepEqual(text.minimalReplacement('', 'new'), { from: 0, to: 0, insert: 'new' })
  assert.deepEqual(text.minimalReplacement('aaa', 'aa'), { from: 2, to: 3, insert: '' })
  const emoji = text.minimalReplacement('x😀y', 'x😁y')
  assert.equal('x😀y'.slice(0, emoji.from) + emoji.insert + 'x😀y'.slice(emoji.to), 'x😁y', 'surrogate pairs are never split')
  assert.equal(emoji.from % 1, 0)

  // ── Source checks: the editor keeps the text it typed ────────────────────
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const saveBody = app.slice(app.indexOf('const saveContent = useCallback'), app.indexOf('const convertAllNotesToCurrentStandard'))
  assert.doesNotMatch(saveBody, /content: tab\.content === content \? visibleContent/u, 'saveContent must not push the trimmed body back into the editor')
  assert.match(saveBody, /savedContent: tab\.content === content \? content : visibleContent/u)
  const editor = readFileSync(new URL('../src/components/MarkdownEditor.tsx', import.meta.url), 'utf8')
  assert.match(editor, /changes: minimalReplacement\(current, content\)/u, 'external content is applied as the smallest change so the selection maps')
  assert.doesNotMatch(editor, /Math\.min\(anchor, nextLength\)/u, 'no more cursor clamping to the new document length')
  assert.match(editor, /spellingCorrections\(\{\s*autocorrectEnabled: \(\) => autocorrectEnabledRef\.current,\s*languageAt: spellingLanguageAt,\s*\}\)/u)
  assert.match(editor, /const autocorrectEnabled = settings\.spellcheck && settings\.autocorrect && !readOnly/u)
  const spelling = readFileSync(new URL('../src/lib/spelling.ts', import.meta.url), 'utf8')
  assert.match(spelling, /language === 'de' && splitsIntoGermanParts\(normalized, exactPart\)/u, 'suggestion lexicon accepts German compounds only from exact-list parts')
  assert.match(spelling, /return dictionaries\[language\]\.has\(normalized, language\) \? 4 : 15/u, 'a compound the dictionary knows as a whole ranks above one it does not')
  assert.doesNotMatch(spelling.slice(spelling.indexOf('const lexiconFrom')), /\|\| dictionaries\[language\]\.has\(normalized, language\)/u, 'Bloom membership alone never admits a candidate')
  assert.match(spelling, /TECHNICAL_WORDS\.has\(normalized\) \|\| isUserAcceptedWord\(normalized\)/u, 'personal dictionary words are never underlined')
  const corrections = readFileSync(new URL('../src/lib/spellingCorrections.ts', import.meta.url), 'utf8')
  assert.match(corrections, /isolateHistory\.of\('full'\)/u, 'an autocorrect is its own undo step')
  assert.match(corrections, /key: 'Backspace', run: revertAutocorrect/u)
  assert.match(corrections, /key: 'Mod-\.'/u)
  assert.match(corrections, /maxDistance: 1 \}\)/u, 'typing-time autocorrect never runs the two-edit search')
  assert.match(corrections, /closest\('\.cm-spelling-error, \.cm-autocorrected'\)/u, 'right-click on an underlined word opens the menu')

  console.log(JSON.stringify({ teh: words(teh).slice(0, 3), hasu: words(hasu).slice(0, 3), two: words(two).slice(0, 3), split: words(split).slice(0, 3) }))
  console.log('spelling-suggest ok')
} finally {
  await server.close()
}
