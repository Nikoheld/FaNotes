// Desktop ink recognition, end to end in Node: the shared Rust (fanotes-recog WASM) groups,
// renders and decodes exactly as in the app, and the committed native `fanotes-ocr` sidecar runs
// the model exactly as the Electron host drives it. This is the desktop pipeline without a
// browser, so it checks the shipped artifacts (WASM, model, language models) and the fixtures.
//
//   node scripts/check-ink-recognition.mjs
//   FANOTES_INK_CASES=/path/cases.json node scripts/check-ink-recognition.mjs   # private sets
//   FANOTES_INK_DIR=/path/to/fanotes-ink node scripts/check-ink-recognition.mjs  # another ONNX + manifest
//
// The bundled cases are the IAM-OnDB example line and held-out ScaDS German lines traced into
// pen strokes (scripts/fixtures/README-INK-RECOGNITION.md).
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNativeOcrHost } from '../electron/native-ocr.cjs'
import { initSync, inkDecode, inkGroupLines, inkLineImage, inkSpanBoxes, setInkExactWords, setInkLanguageModel, setInkLexicon } from '../src/lib/recogWasm/fanotes_recog_wasm.js'
import { RECOG_WASM_BASE64 } from '../src/lib/recogWasm/bytes.ts'
import { BRACKET_COMMA_MARGIN, BRACKET_STRETCH, FIRST_LETTER_MARGIN, INK_RETRY_VARIANTS, INK_SHEAR_RETRY, LARGER_SCALE, MERGE_SCORE_MARGIN, MIXED_CASE_SCALE, NARROW_LINE_MARGIN, NARROW_SCALE, NARROW_STRETCH, NARROW_STRETCH_MARGIN, NARROW_WORD_MARGIN, SHEAR_SCORE_MARGIN, SPLICE_SCORE_MARGIN, WIDTH_RETRY_MARGIN, capitalizesOnlyTheFirstLetter, charactersWithWordEdits, aToAeIndexes, charactersSeparatingFinalB, dToBIndexes, separateFinalBIndexes, fToLowerIndexes, finalLetterApostropheIndexes, rToNIndexes, foldInkWord, hasLongUnknownWord, hasMixedInteriorCase, longUnknownWordEdits, narrowScaleKeepsKnownWords, capitalCompoundIndex, charactersJoiningWords, insertedLetterInOneKnownWord, kraftPluralFromReading, capitalizedNounAfterDeterminer, capitalizedSentenceAdverb, capitalizeLoneLowercase, largerScaleGrowsOneWord, tripleLetterFromNarrowGreedy, hasOneOddLetterGroup, longerKnownCropWord, quotedWordAfterDoubleSix, leadingStrokesAreTicks, COMPOUND_PEN, COMPOUND_SHEAR, COMPOUND_SCALE, dictionaryCompound, isolatedWideGroups, lowercaseShortBeamWord, lowercaseInitialFromBeam, capitalizeEnglishPronoun, periodBeforeCapitals, quoteAfterParenthesis, closeBracketAfterLetter, openingBracketFromTrace, spaceBetweenDifferentQuotes, spaceBetweenSymbolRuns, splitFunctionWordJoin, strayParenBeforeCapital, tracedFinalComma, accusativeDer, trailingTracedLetter, transposedTraceWord, personalNeighborEdits, finalizeInkLineText, interiorCapitalNeighbor, lowercaseVerbSein, umlautAndOneOtherLetter, nounAfterAttributiveAdjective, oneLetterInALongUnknownWord, oneUnknownWordBecomesKnown, replacesBracketPeriodWithComma, rewriteSameLengthWord, rewriteWord, sameLettersAllowingCapsJoin, shearReadingRewritesTwoWords, stretchedReadingKeepsKnownWords, textWithWordEdits, widthReadingKeepsKnownWords, widthReadingMergesTwoWords } from '../src/lib/inkWidthChoice.ts'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ocr = path.join(appRoot, 'public', 'ocr')
const inkDir = process.env.FANOTES_INK_DIR || path.join(ocr, 'fanotes-ink')
const casesFile = process.env.FANOTES_INK_CASES || path.join(appRoot, 'scripts/fixtures/ink-recognition-cases.json')

initSync({ module: Buffer.from(RECOG_WASM_BASE64, 'base64') })

const manifest = JSON.parse(fs.readFileSync(path.join(inkDir, 'manifest.json'), 'utf8'))
assert.equal(manifest.format, 'fanotes-ink-recognizer-v1', 'unexpected ink manifest')
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const verified = (descriptor, directory) => {
  const bytes = fs.readFileSync(path.join(directory, descriptor.file))
  assert.equal(bytes.length, descriptor.size, `${descriptor.file} size`)
  assert.equal(digest(bytes), descriptor.sha256, `${descriptor.file} sha256`)
  return bytes
}
const modelBytes = verified(manifest.models.desktop, inkDir)
const modelPath = path.join(inkDir, manifest.models.desktop.file)

// Language models + the spelling Bloom filter, loaded into the WASM decoder as in the app.
for (const language of ['de', 'en']) {
  setInkLanguageModel(language, verified(manifest.languageModels[language], inkDir))
}
const spelling = JSON.parse(fs.readFileSync(path.join(ocr, '..', 'spell', 'manifest.json'), 'utf8'))
const exactWords = { de: new Set(), en: new Set() }
for (const language of ['de', 'en']) {
  const descriptor = spelling.languages[language]
  const bloom = fs.readFileSync(path.join(appRoot, 'public', 'spell', descriptor.file))
  setInkLexicon(language, bloom, descriptor.bitCount)
  const words = fs.readFileSync(path.join(appRoot, 'public', 'spell', `${language}.words`), 'utf8')
    .split('\n')
    .filter((word) => word.length > 0)
  setInkExactWords(language, words)
  exactWords[language] = new Set(words.map((word) => foldInkWord(word)))
}
const knownWord = (language) => (word) => exactWords[language].has(foldInkWord(word))
{
  const known = knownWord('de')
  assert.equal(shearReadingRewritesTwoWords(
    'Die Ausbildung in dieser Waten tauscht mich.',
    'Die Ausbildung in dieser Welt entlauscht mich.',
  ), true)
  assert.equal(shearReadingRewritesTwoWords(
    'und Computerspielen sowie über Personen, die daran',
    'und Computerspielen sowie über Personen, die Paronen',
  ), false)
  assert.equal(shearReadingRewritesTwoWords(
    'Das wird nie enden.',
    'Das wird sie enden.',
  ), false)
  assert.equal(largerScaleGrowsOneWord(
    'Aus irgendeinem Grad hat das mikrofon gerade nicht funktioniert.',
    'Aus irgendeinem Grund hat das mikrofon gerade nicht funktioniert.',
    known,
  ), true)
  assert.equal(largerScaleGrowsOneWord('Das wird nie enden.', 'Das wird sie enden.', known), false)
  assert.equal(largerScaleGrowsOneWord('Das war ein böses Kaninchen.', 'Das war ein böses kaninchen.', known), false)
  assert.equal(largerScaleGrowsOneWord(
    'Zudem sind über 11,7 Millionen Film- und',
    'Zudem sind über 19,7 Millionen Film- und',
    known,
  ), false)
  assert.equal(oneUnknownWordBecomesKnown(
    'bleiben wegen der Kolbenningspannung in der Aneren',
    'bleiben wegen der Kolbenningspannung in der inneren',
    known,
  ), true)
  assert.equal(oneUnknownWordBecomesKnown(
    'und Computerspielen sowie über Personen, die daran',
    'und Computerspielen sowie über Personen, die davon',
    known,
  ), false)
  assert.equal(narrowScaleKeepsKnownWords(
    'Nuklearenaie ist die Technologie zur großtechnischen Erzeugge',
    'Nuklearenergie ist die Technologie zur großtechnischen Erzeugen',
    known,
  ), true)
  assert.equal(narrowScaleKeepsKnownWords(
    'und Computerspielen sowie über Personen, die daran',
    'und Computerspielen sowie über Personen, die davon',
    known,
  ), false)
  assert.equal(oneLetterInALongUnknownWord(
    'bleiben wegen der Kolbenningspannung in der inneren',
    [
      { text: 'bleiben wegen der Kolbenningspannung in der inneren', score: 0 },
      { text: 'bleiben wegen der Kolbenringspannung in der ineren', score: -0.78 },
    ],
    known,
  )?.to, 'Kolbenringspannung')
  assert.equal(nounAfterAttributiveAdjective(
    'Nuklearenergie ist die Technologie zur großtechnischen Erzeugen',
    known,
  )?.to, 'Erzeugung')
  assert.equal(nounAfterAttributiveAdjective('rund 2400 Wohnungen verfügen. Die Straßen und Garagen', known), null)
  assert.equal(nounAfterAttributiveAdjective('Ich war in den Bergen.', known), null)
  assert.equal(capitalizedNounAfterDeterminer(
    'Aus irgendeinem Grund hat das mikrofon gerade nicht funktioniert.',
    known,
  )?.to, 'Mikrofon')
  assert.equal(capitalizedNounAfterDeterminer('das folgende Beispiel bleibt.', known), null)
  assert.equal(capitalizedNounAfterDeterminer('Staat im Sinne des Völkerrechts anerkannt. Auch heute', known), null)
  assert.equal(umlautAndOneOtherLetter('Die Ausbildung in dieser Welt entlauscht mich.', known)?.to, 'enttäuscht')
  assert.equal(interiorCapitalNeighbor('Watched. EwtopEan.', knownWord('en'))?.to, 'EuropEan')
  assert.equal(interiorCapitalNeighbor("Guy's Pendyce 'My!", knownWord('en')), null)
  assert.equal(tripleLetterFromNarrowGreedy('TAF UUU VVV WWW', 'TTT UUU VVV WWW')?.to, 'TTT')
  assert.equal(tripleLetterFromNarrowGreedy('TAF UUU VVV WWW', 'TAT UUU VVV WWW'), null)
  assert.equal(tripleLetterFromNarrowGreedy('DDD EEE FFF GGG', 'DOD EEE FFF GGG'), null)
  assert.equal(hasOneOddLetterGroup('HHH III JJJ KKK'), false)
  assert.equal(hasOneOddLetterGroup('Six piqued gmnasts!'), false)
  assert.equal(longerKnownCropWord('Watched', 'Wretched', knownWord('en')), 'Wretched')
  assert.equal(longerKnownCropWord('Watched', 'Wretched.', knownWord('en')), 'Wretched')
  assert.equal(longerKnownCropWord('bleiben', 'blon', known), null)
  assert.equal(longerKnownCropWord('Vorgaben', 'vorgeben', known), null)
  assert.equal(longerKnownCropWord('EuropEan', 'EwtopEa', knownWord('en')), null)
  assert.equal(quotedWordAfterDoubleSix('66 Erdkunde" Fairfax'), true)
  assert.equal(quotedWordAfterDoubleSix('"Erdkunde" Fairfax'), false)
  assert.equal(quotedWordAfterDoubleSix('66 Erdkunde Fairfax'), false)
  const tickStroke = (points) => [points.length, ...points.flat()]
  assert.equal(leadingStrokesAreTicks(new Float64Array([
    ...tickStroke([[0, 0], [5, 20]]),
    ...tickStroke([[15, 2], [20, 17]]),
    ...tickStroke([[50, 0], [51, 36]]),
  ])), true)
  assert.equal(leadingStrokesAreTicks(new Float64Array([
    ...tickStroke([[0, 0], [12, 18]]),
    ...tickStroke([[20, 0], [32, 18]]),
    ...tickStroke([[50, 0], [60, 20]]),
  ])), false)
  assert.equal(dictionaryCompound('Landschaftsgeräte', known)?.left, 'landschafts')
  assert.equal(dictionaryCompound('Landschaftsgeräte', known)?.right, 'geräte')
  assert.equal(dictionaryCompound('Landschottensträsse', known), null)
  assert.equal(dictionaryCompound('Kolbenringspannung', known), null)
  assert.equal(lowercaseShortBeamWord('for Job pen. Jackdaws', [
    { text: 'for Job pen. Jackdaws', score: 0 },
    { text: 'for job pen. Jackdaws', score: -2.93 },
  ])?.to, 'job')
  assert.equal(lowercaseShortBeamWord('Manifestly enjoying', [
    { text: 'Manifestly enjoying', score: 0 },
    { text: 'manifestly enjoying', score: -1 },
  ]), null)
  assert.equal(lowercaseShortBeamWord('dog Cozy lummox gives', [
    { text: 'dog Cozy lummox gives', score: 0 },
    { text: 'dog cozy lummox gives', score: -1 },
  ]), null)
  const englishKnown = knownWord('en')
  const capital = (letter, alternative, confidence) => [{ char: letter, alternatives: [{ char: alternative, confidence }] }]
  assert.equal(lowercaseInitialFromBeam('Wretched. EuropEan.', [
    { text: 'Watched. EwtopEan.', score: 0 },
    { text: 'watched. EwtopEan.', score: -1.14 },
  ], 'en', capital('W', 'w', 0.24), englishKnown)?.to, 'wretched')
  assert.equal(lowercaseInitialFromBeam('Upward mummy "me', [
    { text: 'Upward mummy "me', score: 0 },
    { text: 'upward mummy "me', score: -1.31 },
  ], 'en', capital('U', 'u', 0.21), englishKnown), null)
  assert.equal(lowercaseInitialFromBeam('Chudleigh rejected;', [
    { text: 'Chudleigh rejected;', score: 0 },
    { text: 'chudleigh rejected;', score: -0.24 },
  ], 'en', capital('C', 'c', 0.44), englishKnown), null)
  assert.equal(lowercaseInitialFromBeam('Obscure investment', [
    { text: 'Obscure investment', score: 0 },
    { text: 'obscure investment', score: -0.12 },
  ], 'en', capital('O', 'o', 0.46), englishKnown)?.to, 'obscure')
  assert.equal(lowercaseInitialFromBeam('Manifestly enjoying', [
    { text: 'Manifestly enjoying', score: 0 },
    { text: 'manifestly enjoying', score: -6.88 },
  ], 'en', capital('M', 'm', 0.4), englishKnown), null)
  assert.equal(lowercaseInitialFromBeam('Ich war in den Bergen.', [
    { text: 'Ich war in den Bergen.', score: 0 },
    { text: 'ich war in den Bergen.', score: -0.2 },
  ], 'de', capital('I', 'i', 0.4), knownWord('de')), null)
  assert.equal(capitalizeEnglishPronoun('today but I think I can safely say that i know', 'en')?.to, 'I')
  assert.equal(capitalizeEnglishPronoun("men who'll be after that coach i'm introsted", 'en')?.to, 'I')
  assert.equal(capitalizeEnglishPronoun('entstand in den 1970er und 1980er Jahren i', 'de'), null)
  assert.equal(capitalizeEnglishPronoun('Six piqued gmnasts!', 'en'), null)
  const quoteChars = (text) => [...text].map((char) => ({ char }))
  assert.equal(quoteAfterParenthesis(quoteChars('(Tanis 6a)" if')).map((character) => character.char).join(''), '(Tanis 6a) "if')
  assert.equal(quoteAfterParenthesis(quoteChars('(Tanis 6a)" If')), null)
  assert.equal(quoteAfterParenthesis(quoteChars('enough." he')), null)
  assert.equal(periodBeforeCapitals(quoteChars('entsandte 1 FC Lokomotive'), 'de').map((character) => character.char).join(''), 'entsandte 1. FC Lokomotive')
  assert.equal(periodBeforeCapitals(quoteChars('entsandte 1. FC Lokomotive'), 'de'), null)
  assert.equal(periodBeforeCapitals(quoteChars('entsandte 1 FC Lokomotive'), 'en'), null)
  assert.equal(strayParenBeforeCapital(quoteChars('genannt) Die beiden')).map((character) => character.char).join(''), 'genannt. Die beiden')
  assert.equal(strayParenBeforeCapital(quoteChars('(note) Die beiden')), null)
  assert.equal(spaceBetweenDifferentQuotes(quoteChars("'Garz'\"Such")).map((character) => character.char).join(''), "'Garz' \"Such")
  assert.equal(spaceBetweenDifferentQuotes(quoteChars("'''")), null)
  assert.equal(spaceBetweenDifferentQuotes(quoteChars('""')), null)
  assert.equal(closeBracketAfterLetter(quoteChars('SURROUNDED up ]')).map((character) => character.char).join(''), 'SURROUNDED up]')
  assert.equal(closeBracketAfterLetter(quoteChars('Qu[een]')), null)
  assert.equal(spaceBetweenSymbolRuns(quoteChars('%%% ***///')).map((character) => character.char).join(''), '%%% *** ///')
  assert.equal(spaceBetweenSymbolRuns(quoteChars("'''")), null)
  assert.equal(openingBracketFromTrace(quoteChars('TECUMSEH: Queen]'), 'TECUMSEH: Qu[een]').map((character) => character.char).join(''), 'TECUMSEH: Qu[een]')
  assert.equal(openingBracketFromTrace(quoteChars('Queen]'), 'Queen]'), null)
  assert.equal(openingBracketFromTrace(quoteChars('up]'), 'up]'), null)
  assert.equal(tracedFinalComma(quoteChars('astounded Mirabeau.'), [{ text: 'astounded Mirabeau,', score: 0 }], 'astounded Mirabeau,').map((character) => character.char).join(''), 'astounded Mirabeau,')
  assert.equal(tracedFinalComma(quoteChars('Worte.'), [{ text: 'Worte,', score: 0 }], 'Worte.'), null)
  assert.equal(tracedFinalComma(quoteChars('"Muiriel".'), [{ text: '"Muiriel",', score: 0 }], '"Muiriel",'), null)
  assert.equal(splitFunctionWordJoin(quoteChars('withfive dozen liquor'), [{ text: 'with five dozen liquor', score: 0 }], knownWord('en')).map((character) => character.char).join(''), 'with five dozen liquor')
  assert.equal(splitFunctionWordJoin(quoteChars('Naturdenk-'), [{ text: 'Natur denk-', score: 0 }], known), null)
  assert.equal(accusativeDer('bezeichnet man einen des Landschaftsgeräte.')?.to, 'der')
  assert.equal(accusativeDer('und setzt die Vorgaben des Bundesnaturschutzgesetzes'), null)
  assert.equal(accusativeDer('Staat im Sinne des Völkerrechts anerkannt. Auch heute'), null)
  assert.equal(trailingTracedLetter('Chudley rejected', 'Chudleyh rejected', knownWord('en'))?.to, 'Chudleyh')
  assert.equal(personalNeighborEdits('Chudleyh rejected', ['chudleigh'], knownWord('en'))[0]?.to, 'Chudleigh')
  assert.equal(personalNeighborEdits('Chudleyh rejected', [], knownWord('en')).length, 0)
  assert.equal(personalNeighborEdits('rejected the offer', ['chudleigh'], knownWord('en')).length, 0)
  assert.equal(finalizeInkLineText({
    text: 'Manchmal kann er in seltsamer Junge sein.',
    greedyText: 'munchmal lann er ien seltsamer Junge bein.',
    characters: [...'Manchmal kann er in seltsamer Junge sein.'].map((char) => ({ char })),
    readings: [{ text: 'Manchmal kann er in seltsamer Junge sein.', score: 0 }],
  }, known).text, 'Manchmal kann er ein seltsamer Junge sein.')
  assert.equal(trailingTracedLetter("Unlike York: Soc'", 'Unlise Yook: Soci', knownWord('en')), null)
  assert.equal(transposedTraceWord(
    'Manchmal kann er in seltsamer Junge sein.',
    'munchmal lann er ien seltsamer Junge bein.',
    known,
  )?.to, 'ein')
  assert.equal(transposedTraceWord('Ich war in den Bergen.', 'Ich war in den Bergen.', known), null)
  assert.equal(capitalizedSentenceAdverb('manchmal kann er in seltsamer Junge Sein.')?.to, 'Manchmal')
  assert.equal(capitalizedSentenceAdverb('bleiben wegen der Kolbenringspannung in der inneren'), null)
  assert.equal(capitalizedSentenceAdverb('Auch heute bleibt das so.'), null)
  assert.equal(lowercaseVerbSein('manchmal kann er in seltsamer Junge Sein.')?.to, 'sein')
  assert.equal(capitalizeLoneLowercase('[Kidney,] JuDKINB?')?.to, 'JUDKINB')
  assert.equal(capitalizeLoneLowercase('bleiben wegen der Kolbenringspannung in der inneren'), null)
  assert.equal(capitalizeLoneLowercase('PECKSNIFF long-lost'), null)
  assert.equal(lowercaseVerbSein('das Sein bleibt.'), null)
  assert.equal(lowercaseVerbSein('Sein Vater wartet.'), null)
  assert.equal(umlautAndOneOtherLetter('Das Passwort ist "Muiriel".', known), null)
  assert.equal(umlautAndOneOtherLetter("Guy's Pendyce 'My!", knownWord('en')), null)
  const marineBase = 'Kaiserlich Japanischen Marie luft statut in Friedenszeiten auf die in'
  const marineMerged = 'Kaiserlich Japanischen Marie luftstreitkraft in Friedenszeiten auf die in'
  const marineReadings = [
    { text: marineBase, score: 0 },
    { text: 'Kaiserlich Japanischen Marine luft statut in Friedenszeiten auf die in', score: -0.92 },
  ]
  assert.equal(insertedLetterInOneKnownWord(marineBase, marineMerged, marineReadings, known)?.to, 'Marine')
  assert.equal(capitalCompoundIndex('Kaiserlich Japanischen Marine luftstreitkraft in Friedenszeiten auf die in', known), 2)
  assert.equal(capitalCompoundIndex('der österreichischen Fußballnationalmannschaft statt', known), null)
  assert.equal(capitalCompoundIndex('Die Ausbildung in dieser Welt entlauscht mich.', known), null)
  const kraftReadings = [
    { text: 'Kaiserlich Japanischen Marie luftstreitkraft in Friedenszeiten auf die in', score: 0 },
    { text: 'Kaiserlich Japanischen Marie luftstreitkrafte in Friedenszeiten auf die in', score: -2.84 },
  ]
  assert.equal(kraftPluralFromReading(
    'Kaiserlich Japanischen Marineluftstreitkraft in Friedenszeiten auf die in',
    kraftReadings,
    known,
  )?.to, 'Marineluftstreitkräfte')
  assert.equal(kraftPluralFromReading(
    'Kaiserlich Japanischen Marineluftstreitkraft in Friedenszeiten auf die in',
    [kraftReadings[0], { text: kraftReadings[1].text, score: -3.1 }],
    known,
  ), null)
  assert.equal(kraftPluralFromReading(
    'Die Fliehkraft bleibt.',
    [
      { text: 'Die Fliehkraft bleibt.', score: 0 },
      { text: 'Die Fliehkrafte bleibt.', score: -2 },
    ],
    known,
  ), null)
  assert.equal(charactersJoiningWords([... 'Marine luftstreitkraft'].map((char) => ({ char })), 0).map((character) => character.char).join(''), 'Marineluftstreitkraft')
  assert.equal(insertedLetterInOneKnownWord(marineBase, marineBase, marineReadings, known), null)
  assert.equal(insertedLetterInOneKnownWord(
    marineBase,
    marineMerged,
    [marineReadings[0], { text: marineReadings[1].text, score: -1.05 }],
    known,
  ), null)
  assert.equal(insertedLetterInOneKnownWord(
    'By Trevor Williams. A move',
    'By Trevor Williams. A moved',
    [
      { text: 'By Trevor Williams. A move', score: 0 },
      { text: 'By Trevor Williams. A mace', score: -0.12 },
    ],
    knownWord('en'),
  ), null)
  assert.equal(insertedLetterInOneKnownWord(
    'CHARACTERS Trelawny',
    'CHARACTERS Trelawny.',
    [
      { text: 'CHARACTERS Trelawny', score: 0 },
      { text: 'CHARACTERS Trelawnyt', score: -0.9 },
    ],
    knownWord('en'),
  ), null)
  assert.equal(oneLetterInALongUnknownWord(
    'und Computerspielen sowie über Personen, die daran',
    [
      { text: 'und Computerspielen sowie über Personen, die daran', score: 0 },
      { text: 'und Computerspielen sowie über Personen, die davon', score: -0.5 },
    ],
    known,
  ), null)
  assert.equal(stretchedReadingKeepsKnownWords(
    'bezeichnet Man einen des Landstatisters.',
    'bezeichnet man einen des Landschottenstrasse.',
    known,
  ), true)
  assert.equal(stretchedReadingKeepsKnownWords(
    'und Computerspielen sowie über Personen, die daran',
    'und Computerspielen sowie über Personen, die davon',
    known,
  ), false)
  assert.equal(replacesBracketPeriodWithComma('[Kidney.] JuDKIND?', '[Kidney,] JuDKIND?'), true)
  assert.equal(replacesBracketPeriodWithComma('By Trevor Williams. A move', 'By Trevor Williams, A move'), false)
  assert.deepEqual(aToAeIndexes([
    { char: 'a', alternatives: [{ char: 'ä', confidence: 0.93 }] },
  ]), [0])
  assert.deepEqual(aToAeIndexes([
    { char: 'a', alternatives: [{ char: 'ä', confidence: 0.5 }] },
  ]), [])
  assert.deepEqual(fToLowerIndexes([
    { char: 'F', alternatives: [{ char: 'f', confidence: 0.3 }] },
  ]), [0])
  assert.deepEqual(fToLowerIndexes([
    { char: 'F', alternatives: [{ char: 'f', confidence: 0.02 }] },
  ]), [])
  const kidneyD = [...'JuDKIND'].map((char, index, letters) => ({
    char,
    alternatives: index === letters.length - 1 ? [{ char: 'B', confidence: 0.64 }] : [],
  }))
  assert.deepEqual(separateFinalBIndexes(kidneyD), [6])
  assert.equal(charactersSeparatingFinalB(kidneyD, [6]).map((character) => character.char).join(''), 'JuDKIN B')
  assert.deepEqual(dToBIndexes(kidneyD), [])
  assert.deepEqual(dToBIndexes([
    { char: 'D', alternatives: [{ char: 'B', confidence: 0.64 }] },
  ]), [0])
  assert.deepEqual(dToBIndexes([
    { char: 'D', alternatives: [{ char: 'B', confidence: 0.64 }] },
    { char: 'e', alternatives: [] },
  ]), [])
  assert.deepEqual(rToNIndexes([
    { char: 'r', alternatives: [{ char: 'n', confidence: 0.63 }] },
  ]), [0])
  assert.deepEqual(rToNIndexes([
    { char: 'r', alternatives: [{ char: 'n', confidence: 0.03 }] },
  ]), [])
  assert.deepEqual(finalLetterApostropheIndexes([
    { char: 'i', alternatives: [{ char: "'", confidence: 0.38 }] },
  ]), [0])
  assert.deepEqual(finalLetterApostropheIndexes([
    { char: 'i', alternatives: [{ char: "'", confidence: 0.2 }] },
    { char: 'e', alternatives: [] },
  ]), [])
  assert.equal(capitalizesOnlyTheFirstLetter('dumdum; GENTLEMAN', 'Dumdum; GENTLEMAN'), true)
  assert.equal(capitalizesOnlyTheFirstLetter('xxx yyy zzz', 'Xxx yyy zzz'), true)
  assert.equal(capitalizesOnlyTheFirstLetter('DDD EEE FFF GGG', 'DOD EEE FFF GGG'), false)
  assert.equal(capitalizesOnlyTheFirstLetter('for Job pen. Jackdaws', 'For job pen. Jackdaws'), false)
  assert.equal(hasMixedInteriorCase('PEcK SNIFF long-lost'), true)
  assert.equal(sameLettersAllowingCapsJoin('PEcK SNIFF long-lost', 'PECKSNIFF long-lost'), true)
  assert.equal(sameLettersAllowingCapsJoin('PEcK SNIFF long-lost', 'PECK SNIFF long-lost'), true)
  assert.equal(sameLettersAllowingCapsJoin('PEcK SNIFF long-lost', 'PECKSNAFF long-lost'), false)
  assert.equal(sameLettersAllowingCapsJoin('Ich muss schlafen gehen.', 'Ich muss schlafengehen.'), false)
  assert.equal(sameLettersAllowingCapsJoin('DDD EEE FFF GGG', 'DDDEEEFFFGGG'), false)
  assert.equal(hasMixedInteriorCase('Das war ein böses Kaninchen.'), false)
  assert.equal(hasLongUnknownWord('Herzlichen Glückensisch zum Geburtstag', known), true)
  assert.equal(widthReadingKeepsKnownWords(
    'Herzlichen Glückensisch zum Geburtstag, Weiriell',
    'Herzlichen Glückwunsch zum Geburtstag, Muiriell',
    known,
  ), true)
  assert.equal(widthReadingKeepsKnownWords(
    'sowie über Personen, die daran',
    'sowie über Personen, die davon',
    known,
  ), false)
  assert.equal(widthReadingKeepsKnownWords(
    'Nuklearenaie ist die Technologie',
    'Nuklearen sie ist die Technologie',
    known,
  ), false)
  assert.equal(widthReadingMergesTwoWords(
    'Kaiserlich Japanischen Marie luft statut in Friedenszeiten auf die in',
    'Kaiserlich Japanischen Marie luftstreitkraft in Friedenszeiten auf die in',
  ), true)
  assert.equal(widthReadingMergesTwoWords(
    'und Computerspielen sowie über Personen, die daran',
    'und Computerspielen sowie über Personen, die davon',
  ), false)
  const nuclear = longUnknownWordEdits(
    'Nuklearenaie ist die Technologie zur großtechnischen Erzeugge',
    'Nuklearenergie ist die Technologie zur größtechischen Erzeugge',
    known,
  )
  assert.deepEqual(nuclear, [{ index: 0, from: 'Nuklearenaie', to: 'Nuklearenergie' }])
  assert.equal(
    textWithWordEdits('Nuklearenaie ist die Technologie zur großtechnischen Erzeugge', nuclear),
    'Nuklearenergie ist die Technologie zur großtechnischen Erzeugge',
  )
}

const host = createNativeOcrHost({
  executable: path.join(appRoot, 'native-ocr', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'fanotes-ocr.exe' : 'fanotes-ocr'),
  runtime: path.join(appRoot, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3', process.platform, process.arch, process.platform === 'win32' ? 'onnxruntime.dll' : process.platform === 'darwin' ? 'libonnxruntime.1.21.0.dylib' : 'libonnxruntime.so.1'),
  model: { path: modelPath, size: manifest.models.desktop.size, sha256: manifest.models.desktop.sha256 },
  modelHeight: 64,
  inputName: 'image',
  outputName: 'logits',
  minWidth: 16,
})

const editDistance = (first, second) => {
  const a = Array.from(first)
  const b = Array.from(second)
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) current.push(Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1])))
    previous = current
  }
  return previous[b.length]
}
const fold = (value) => value.replace(/ß/gu, 'ss')
const cer = (rows) => 100 * rows.reduce((s, r) => s + editDistance(fold(r.text), fold(r.truth)), 0) / Math.max(1, rows.reduce((s, r) => s + Array.from(r.truth).length, 0))
const wer = (rows) => 100 * rows.reduce((s, r) => s + editDistance(fold(r.text).split(/\s+/u), fold(r.truth).split(/\s+/u)), 0) / Math.max(1, rows.reduce((s, r) => s + r.truth.split(/\s+/u).length, 0))

const decoderOptionsFor = (language) => {
  const { englishLmWeight, englishWordBonus, penWidth: _penWidth, ...shared } = manifest.decoder
  const english = language === 'en'
  return JSON.stringify({
    ...shared,
    nBest: 5,
    lmWeight: english ? englishLmWeight ?? shared.lmWeight : shared.lmWeight,
    wordBonus: english ? englishWordBonus ?? shared.wordBonus : shared.wordBonus,
  })
}
const median = (values) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : 0

const cropPacked = (packed, minX, maxX) => {
  const chunks = []
  for (let offset = 0; offset < packed.length;) {
    const count = packed[offset]
    const end = offset + 1 + count * 2
    let lo = Infinity
    let hi = -Infinity
    for (let index = 0; index < count; index += 1) {
      const x = packed[offset + 1 + index * 2]
      lo = Math.min(lo, x)
      hi = Math.max(hi, x)
    }
    const center = (lo + hi) / 2
    if (center >= minX - 3 && center <= maxX + 3) chunks.push(packed.subarray(offset, end))
    offset = end
  }
  if (chunks.length < 2) return null
  const out = new Float64Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let cursor = 0
  for (const chunk of chunks) {
    out.set(chunk, cursor)
    cursor += chunk.length
  }
  return out
}

const packStrokes = (strokes, width, height) => {
  let count = 0
  for (const stroke of strokes) count += 1 + stroke.length * 2
  const packed = new Float64Array(count)
  let offset = 0
  for (const stroke of strokes) {
    packed[offset++] = stroke.length
    for (const [x, y] of stroke) { packed[offset++] = x * width; packed[offset++] = y * height }
  }
  return packed
}

async function recognize(entry, { strokes = entry.strokes, width = entry.sourceWidth, height = entry.sourceHeight, group = true } = {}) {
  const usable = strokes.map((_, index) => index)
  const packed = packStrokes(strokes, width, height)
  // Single, already-separated lines (the accuracy fixtures) are one render. Page grouping is
  // exercised separately with real pen strokes; the skeleton-traced fixtures are not pen input.
  const grouped = group
    ? JSON.parse(inkGroupLines(packed))
    : [{ strokes: usable, minX: 0, minY: 0, maxX: width, maxY: height }]
  const reference = group
    ? median(grouped.filter((line) => line.strokes.length >= 2).map((line) => line.maxY - line.minY))
    : 0
  const lines = []
  let inferenceMs = 0
  for (const line of grouped) {
    const linePacked = packStrokes(line.strokes.map((index) => strokes[usable[index]]), width, height)
    let linePackedForBoxes = linePacked
    const raw = inkLineImage(linePacked, reference, manifest.decoder.penWidth ?? 2.6, 0, 1)
    if (raw.length < 3) continue
    const image = raw.subarray(2)
    const t = Date.now()
    const { probabilities, dims } = await host.recognize({ input: Float32Array.from(image), width: raw[0], height: 64, threads: 4 })
    inferenceMs += Date.now() - t
    assert.equal(dims[2], manifest.classes, 'class count')
    let decoded = JSON.parse(inkDecode(probabilities, dims[2], manifest.alphabet, entry.language, decoderOptionsFor(entry.language)))
    const baseDecoded = decoded
    let penWidth = manifest.decoder.penWidth ?? 2.6
    let scale = 1
    let shear = 0
    const baseText = decoded.text
    const baseScore = decoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
    let spliceBest = null
    if (exactWords[entry.language]?.size && hasLongUnknownWord(baseText, knownWord(entry.language))) {
      let bestScore = baseScore
      const known = knownWord(entry.language)
      for (const variant of INK_RETRY_VARIANTS) {
        const retryRaw = inkLineImage(linePacked, reference, variant.penWidth, 0, variant.scale)
        if (retryRaw.length < 3) continue
        const retryImage = retryRaw.subarray(2)
        const retryStarted = Date.now()
        const retry = await host.recognize({ input: Float32Array.from(retryImage), width: retryRaw[0], height: 64, threads: 4 })
        inferenceMs += Date.now() - retryStarted
        const retryDecoded = JSON.parse(inkDecode(retry.probabilities, retry.dims[2], manifest.alphabet, entry.language, decoderOptionsFor(entry.language)))
        const retryScore = retryDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
        const wordFix = retryScore >= baseScore + WIDTH_RETRY_MARGIN
          && widthReadingKeepsKnownWords(baseText, retryDecoded.text, known)
        const mergeFix = retryScore >= baseScore + MERGE_SCORE_MARGIN
          && widthReadingMergesTwoWords(baseText, retryDecoded.text)
        const narrow = variant.scale === NARROW_SCALE
        const shortFix = narrow
          && retryScore >= baseScore + NARROW_WORD_MARGIN
          && oneUnknownWordBecomesKnown(baseText, retryDecoded.text, known)
        const lineFix = narrow
          && retryScore >= baseScore + NARROW_LINE_MARGIN
          && narrowScaleKeepsKnownWords(baseText, retryDecoded.text, known)
        if ((wordFix || mergeFix || shortFix || lineFix) && retryScore > bestScore) {
          decoded = retryDecoded
          penWidth = variant.penWidth
          scale = variant.scale
          bestScore = retryScore
          continue
        }
        if (narrow) continue
        if (retryScore < baseScore + SPLICE_SCORE_MARGIN) continue
        const edits = longUnknownWordEdits(baseText, retryDecoded.text, known)
        if (!edits || (spliceBest && retryScore <= spliceBest.score)) continue
        spliceBest = { score: retryScore, decoded: retryDecoded, penWidth: variant.penWidth, scale: variant.scale, edits }
      }
      const narrowPacked = Float64Array.from(linePacked)
      for (let offset = 0; offset < narrowPacked.length;) {
        const count = narrowPacked[offset]
        for (let index = 0; index < count; index += 1) narrowPacked[offset + 1 + index * 2] *= NARROW_STRETCH
        offset += 1 + count * 2
      }
      const narrowRaw = inkLineImage(narrowPacked, reference, 2.6, 0, 1)
      if (narrowRaw.length >= 3) {
        const narrowStarted = Date.now()
        const narrowRun = await host.recognize({ input: Float32Array.from(narrowRaw.subarray(2)), width: narrowRaw[0], height: 64, threads: 4 })
        inferenceMs += Date.now() - narrowStarted
        const narrowDecoded = JSON.parse(inkDecode(narrowRun.probabilities, narrowRun.dims[2], manifest.alphabet, entry.language, decoderOptionsFor(entry.language)))
        const narrowScore = narrowDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
        if (
          narrowScore >= baseScore + NARROW_STRETCH_MARGIN
          && narrowScore > bestScore
          && stretchedReadingKeepsKnownWords(baseText, narrowDecoded.text, known)
        ) {
          decoded = narrowDecoded
          penWidth = 2.6
          scale = 1
          shear = 0
          bestScore = narrowScore
          linePackedForBoxes = narrowPacked
        }
      }
    }
    let boxes
    if (decoded.text === baseText && spliceBest) {
      const edited = charactersWithWordEdits(baseDecoded.characters, spliceBest.decoded.characters, spliceBest.edits)
      if (edited) {
        decoded = { ...baseDecoded, text: textWithWordEdits(baseText, spliceBest.edits), characters: edited.characters }
        const spanBoxes = (width, usedScale, characters) => {
          const spans = new Uint32Array(characters.flatMap((c) => [c.startFrame, c.endFrame]))
          return inkSpanBoxes(linePacked, reference, width, 0, usedScale, spans)
        }
        const baseBoxes = spanBoxes(manifest.decoder.penWidth ?? 2.6, 1, baseDecoded.characters)
        const altBoxes = spanBoxes(spliceBest.penWidth, spliceBest.scale, spliceBest.decoded.characters)
        boxes = new Float64Array(edited.characters.length * 4)
        edited.source.forEach((source, index) => {
          const from = source.alt ? altBoxes : baseBoxes
          boxes.set(from.subarray(source.index * 4, source.index * 4 + 4), index * 4)
        })
      }
    }
    if (decoded.text === baseText && exactWords[entry.language]?.size) {
      const shearRaw = inkLineImage(linePacked, reference, penWidth, INK_SHEAR_RETRY, scale)
      if (shearRaw.length >= 3) {
        const shearStarted = Date.now()
        const shearRun = await host.recognize({ input: Float32Array.from(shearRaw.subarray(2)), width: shearRaw[0], height: 64, threads: 4 })
        inferenceMs += Date.now() - shearStarted
        const shearDecoded = JSON.parse(inkDecode(shearRun.probabilities, shearRun.dims[2], manifest.alphabet, entry.language, decoderOptionsFor(entry.language)))
        const shearScore = shearDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
        if (shearScore >= baseScore + SHEAR_SCORE_MARGIN && shearReadingRewritesTwoWords(baseText, shearDecoded.text)) {
          decoded = shearDecoded
          shear = INK_SHEAR_RETRY
          boxes = undefined
        }
      }
    }
    if (decoded.text === baseText && exactWords[entry.language]?.size) {
      const grownRaw = inkLineImage(linePacked, reference, penWidth, 0, LARGER_SCALE)
      if (grownRaw.length >= 3) {
        const grownStarted = Date.now()
        const grownRun = await host.recognize({ input: Float32Array.from(grownRaw.subarray(2)), width: grownRaw[0], height: 64, threads: 4 })
        inferenceMs += Date.now() - grownStarted
        const grownDecoded = JSON.parse(inkDecode(grownRun.probabilities, grownRun.dims[2], manifest.alphabet, entry.language, decoderOptionsFor(entry.language)))
        const grownScore = grownDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
        if (grownScore > baseScore && largerScaleGrowsOneWord(baseText, grownDecoded.text, knownWord(entry.language))) {
          decoded = grownDecoded
          scale = LARGER_SCALE
          shear = 0
          boxes = undefined
        }
      }
    }
    if (decoded.text === baseText && penWidth === (manifest.decoder.penWidth ?? 2.6) && shear === 0 && scale === 1 && hasOneOddLetterGroup(decoded.text)) {
      const groupRaw = inkLineImage(linePacked, reference, penWidth, 0, NARROW_SCALE)
      if (groupRaw.length >= 3) {
        const groupStarted = Date.now()
        const groupRun = await host.recognize({ input: Float32Array.from(groupRaw.subarray(2)), width: groupRaw[0], height: 64, threads: 4 })
        inferenceMs += Date.now() - groupStarted
        const groupDecoded = JSON.parse(inkDecode(groupRun.probabilities, groupRun.dims[2], manifest.alphabet, entry.language, decoderOptionsFor(entry.language)))
        const grouped = tripleLetterFromNarrowGreedy(decoded.text, groupDecoded.greedyText)
        if (grouped) {
          const rewritten = rewriteSameLengthWord(decoded.characters, grouped.index, grouped.to)
          const nextText = textWithWordEdits(decoded.text, [grouped])
          if (rewritten && nextText !== decoded.text) {
            decoded = { ...decoded, text: nextText, characters: rewritten }
            scale = NARROW_SCALE
            shear = 0
            boxes = undefined
          }
        }
      }
    }
    const firstLetter = [...decoded.text][0]
    if (firstLetter && firstLetter !== firstLetter.toUpperCase()) {
      const capitalRaw = inkLineImage(linePacked, reference, penWidth, shear, NARROW_SCALE)
      if (capitalRaw.length >= 3) {
        const capitalStarted = Date.now()
        const capitalRun = await host.recognize({ input: Float32Array.from(capitalRaw.subarray(2)), width: capitalRaw[0], height: 64, threads: 4 })
        inferenceMs += Date.now() - capitalStarted
        const capitalDecoded = JSON.parse(inkDecode(capitalRun.probabilities, capitalRun.dims[2], manifest.alphabet, entry.language, decoderOptionsFor(entry.language)))
        const capitalScore = capitalDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
        const currentScore = decoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
        if (capitalScore >= currentScore + FIRST_LETTER_MARGIN && capitalizesOnlyTheFirstLetter(decoded.text, capitalDecoded.text)) {
          decoded = capitalDecoded
          scale = NARROW_SCALE
          boxes = undefined
        }
      }
    }
    if (hasMixedInteriorCase(decoded.text)) {
      const caseRaw = inkLineImage(linePacked, reference, penWidth, shear, MIXED_CASE_SCALE)
      if (caseRaw.length >= 3) {
        const caseStarted = Date.now()
        const caseRun = await host.recognize({ input: Float32Array.from(caseRaw.subarray(2)), width: caseRaw[0], height: 64, threads: 4 })
        inferenceMs += Date.now() - caseStarted
        const caseDecoded = JSON.parse(inkDecode(caseRun.probabilities, caseRun.dims[2], manifest.alphabet, entry.language, decoderOptionsFor(entry.language)))
        const caseScore = caseDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
        const currentScore = decoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
        if (caseScore > currentScore && sameLettersAllowingCapsJoin(decoded.text, caseDecoded.text)) {
          decoded = caseDecoded
          scale = MIXED_CASE_SCALE
          boxes = undefined
        }
      }
    }
    let boxedPacked = linePackedForBoxes
    if (decoded.text.includes('.]')) {
      const stretched = Float64Array.from(linePacked)
      for (let offset = 0; offset < stretched.length;) {
        const count = stretched[offset]
        for (let index = 0; index < count; index += 1) stretched[offset + 1 + index * 2] *= BRACKET_STRETCH
        offset += 1 + count * 2
      }
      const bracketRaw = inkLineImage(stretched, reference, penWidth, shear, scale)
      if (bracketRaw.length >= 3) {
        const bracketStarted = Date.now()
        const bracketRun = await host.recognize({ input: Float32Array.from(bracketRaw.subarray(2)), width: bracketRaw[0], height: 64, threads: 4 })
        inferenceMs += Date.now() - bracketStarted
        const bracketDecoded = JSON.parse(inkDecode(bracketRun.probabilities, bracketRun.dims[2], manifest.alphabet, entry.language, decoderOptionsFor(entry.language)))
        const bracketScore = bracketDecoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
        const currentScore = decoded.readings[0]?.score ?? Number.NEGATIVE_INFINITY
        if (bracketScore >= currentScore + BRACKET_COMMA_MARGIN && replacesBracketPeriodWithComma(decoded.text, bracketDecoded.text)) {
          decoded = bracketDecoded
          boxedPacked = stretched
          boxes = undefined
        }
      }
    }
    if (decoded.text !== baseText) {
      const inserted = insertedLetterInOneKnownWord(baseText, decoded.text, baseDecoded.readings ?? [], knownWord(entry.language))
      if (inserted) {
        const rewritten = rewriteWord(decoded.characters, inserted.index, inserted.to)
        const nextText = textWithWordEdits(decoded.text, [inserted])
        if (rewritten && nextText !== decoded.text) {
          decoded = { ...decoded, text: nextText, characters: rewritten }
          boxes = undefined
        }
      }
    }
    const compoundIndex = capitalCompoundIndex(decoded.text, knownWord(entry.language))
    if (compoundIndex !== null) {
      const characters = charactersJoiningWords(decoded.characters, compoundIndex)
      const nextText = characters?.map((character) => character.char).join('')
      if (characters && nextText && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters }
        boxes = undefined
      }
    }
    const pluralEdit = kraftPluralFromReading(decoded.text, decoded.readings ?? [], knownWord(entry.language))
    if (pluralEdit) {
      const rewritten = rewriteWord(decoded.characters, pluralEdit.index, pluralEdit.to)
      const nextText = textWithWordEdits(decoded.text, [pluralEdit])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        boxes = undefined
      }
    }
    const letterEdit = oneLetterInALongUnknownWord(decoded.text, decoded.readings ?? [], knownWord(entry.language))
    if (letterEdit) {
      const rewritten = rewriteSameLengthWord(decoded.characters, letterEdit.index, letterEdit.to)
      const nextText = textWithWordEdits(decoded.text, [letterEdit])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        boxes = undefined
      }
    }
    const aeIndexes = aToAeIndexes(decoded.characters ?? [])
    if (aeIndexes.length) {
      const characters = decoded.characters.map((character, index) => aeIndexes.includes(index) ? { ...character, char: 'ä' } : character)
      decoded = { ...decoded, characters, text: characters.map((character) => character.char).join('') }
      boxes = undefined
    }
    const fIndexes = fToLowerIndexes(decoded.characters ?? [])
    if (fIndexes.length) {
      const characters = decoded.characters.map((character, index) => fIndexes.includes(index) ? { ...character, char: 'f' } : character)
      decoded = { ...decoded, characters, text: characters.map((character) => character.char).join('') }
      boxes = undefined
    }
    const separatedB = separateFinalBIndexes(decoded.characters ?? [])
    if (separatedB.length) {
      const characters = charactersSeparatingFinalB(decoded.characters, separatedB)
      decoded = { ...decoded, characters, text: characters.map((character) => character.char).join('') }
      boxes = undefined
    }
    const bIndexes = dToBIndexes(decoded.characters ?? [])
    if (bIndexes.length) {
      const characters = decoded.characters.map((character, index) => bIndexes.includes(index) ? { ...character, char: 'B' } : character)
      decoded = { ...decoded, characters, text: characters.map((character) => character.char).join('') }
      boxes = undefined
    }
    const nIndexes = rToNIndexes(decoded.characters ?? [])
    if (nIndexes.length) {
      const characters = decoded.characters.map((character, index) => nIndexes.includes(index) ? { ...character, char: 'n' } : character)
      decoded = { ...decoded, characters, text: characters.map((character) => character.char).join('') }
      boxes = undefined
    }
    const apostropheIndexes = finalLetterApostropheIndexes(decoded.characters ?? [])
    if (apostropheIndexes.length) {
      const characters = decoded.characters.map((character, index) => apostropheIndexes.includes(index) ? { ...character, char: "'" } : character)
      decoded = { ...decoded, characters, text: characters.map((character) => character.char).join('') }
      boxes = undefined
    }
    const adverb = capitalizedSentenceAdverb(decoded.text)
    if (adverb) {
      const rewritten = rewriteSameLengthWord(decoded.characters, adverb.index, adverb.to)
      const nextText = textWithWordEdits(decoded.text, [adverb])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        boxes = undefined
      }
    }
    const loneCap = capitalizeLoneLowercase(decoded.text)
    if (loneCap) {
      const rewritten = rewriteSameLengthWord(decoded.characters, loneCap.index, loneCap.to)
      const nextText = textWithWordEdits(decoded.text, [loneCap])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        boxes = undefined
      }
    }
    const verbSein = lowercaseVerbSein(decoded.text)
    if (verbSein) {
      const rewritten = rewriteSameLengthWord(decoded.characters, verbSein.index, verbSein.to)
      const nextText = textWithWordEdits(decoded.text, [verbSein])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        boxes = undefined
      }
    }
    const interior = interiorCapitalNeighbor(decoded.text, knownWord(entry.language))
    if (interior) {
      const rewritten = rewriteSameLengthWord(decoded.characters, interior.index, interior.to)
      const nextText = textWithWordEdits(decoded.text, [interior])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        boxes = undefined
      }
    }
    const umlautEdit = umlautAndOneOtherLetter(decoded.text, knownWord(entry.language))
    if (umlautEdit) {
      const rewritten = rewriteSameLengthWord(decoded.characters, umlautEdit.index, umlautEdit.to)
      const nextText = textWithWordEdits(decoded.text, [umlautEdit])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        boxes = undefined
      }
    }
    const capitalNoun = capitalizedNounAfterDeterminer(decoded.text, knownWord(entry.language))
    if (capitalNoun) {
      const rewritten = rewriteSameLengthWord(decoded.characters, capitalNoun.index, capitalNoun.to)
      const nextText = textWithWordEdits(decoded.text, [capitalNoun])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        boxes = undefined
      }
    }
    const nounEdit = nounAfterAttributiveAdjective(decoded.text, knownWord(entry.language))
    if (nounEdit) {
      const rewritten = rewriteWord(decoded.characters, nounEdit.index, nounEdit.to)
      const nextText = textWithWordEdits(decoded.text, [nounEdit])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        boxes = undefined
      }
    }
    if (penWidth === (manifest.decoder.penWidth ?? 2.6) && shear === 0 && scale === 1 && linePackedForBoxes === linePacked) {
      const known = knownWord(entry.language)
      const letter = /[A-Za-zÄÖÜäöüß]/u
      const words = [...decoded.text.matchAll(/[A-Za-zÄÖÜäöüß]+/gu)].map((match) => match[0])
      const eligible = words.map((word, index) => ({ word, index })).filter(({ word }) => [...word].length >= 6 && known(word))
      if (eligible.length) {
        const spans = new Uint32Array(decoded.characters.flatMap((character) => [character.startFrame, character.endFrame]))
        const wordBoxes = inkSpanBoxes(linePacked, reference, penWidth, 0, 1, spans)
        const glyphRuns = []
        let glyph = 0
        while (glyph < decoded.characters.length) {
          if (!letter.test(decoded.characters[glyph].char)) { glyph += 1; continue }
          const start = glyph
          while (glyph < decoded.characters.length && letter.test(decoded.characters[glyph].char)) glyph += 1
          glyphRuns.push({ start, end: glyph })
        }
        for (const run of eligible) {
          const glyphs = glyphRuns[run.index]
          if (!glyphs) continue
          let minX = Infinity
          let maxX = -Infinity
          for (let index = glyphs.start; index < glyphs.end; index += 1) {
            const left = wordBoxes[index * 4]
            const right = wordBoxes[index * 4 + 2]
            if (!Number.isFinite(left) || !Number.isFinite(right)) continue
            minX = Math.min(minX, left)
            maxX = Math.max(maxX, right)
          }
          if (!Number.isFinite(minX)) continue
          const cropped = cropPacked(linePacked, minX, maxX)
          if (!cropped) continue
          const cropRaw = inkLineImage(cropped, reference, penWidth, 0, 1)
          if (cropRaw.length < 3) continue
          const cropStarted = Date.now()
          const cropRun = await host.recognize({ input: Float32Array.from(cropRaw.subarray(2)), width: cropRaw[0], height: 64, threads: 4 })
          inferenceMs += Date.now() - cropStarted
          const cropDecoded = JSON.parse(inkDecode(cropRun.probabilities, cropRun.dims[2], manifest.alphabet, entry.language, decoderOptionsFor(entry.language)))
          const replacement = longerKnownCropWord(run.word, cropDecoded.text, known)
          if (!replacement) continue
          const rewritten = rewriteWord(decoded.characters, run.index, replacement)
          const nextText = textWithWordEdits(decoded.text, [{ index: run.index, from: run.word, to: replacement }])
          if (!rewritten || nextText === decoded.text) continue
          decoded = { ...decoded, text: nextText, characters: rewritten }
          boxes = undefined
          break
        }
      }
    }
    if (
      penWidth === (manifest.decoder.penWidth ?? 2.6)
      && shear === 0
      && scale === 1
      && linePackedForBoxes === linePacked
      && decoded.characters.length >= 3
      && decoded.characters[0].char === '6'
      && decoded.characters[1].char === '6'
      && decoded.characters[2].char === ' '
      && quotedWordAfterDoubleSix(decoded.text)
      && leadingStrokesAreTicks(linePacked)
    ) {
      const quote = { ...decoded.characters[0], char: '"', endFrame: decoded.characters[1].endFrame }
      const characters = [quote, ...decoded.characters.slice(3)]
      decoded = { ...decoded, characters, text: characters.map((character) => character.char).join('') }
      boxes = undefined
    }
    const personalEdits = personalNeighborEdits(decoded.text, [], knownWord(entry.language))
    if (personalEdits.length) {
      const rewritten = personalEdits.reduce((characters, edit) => characters && rewriteWord(characters, edit.index, edit.to), decoded.characters)
      const nextText = textWithWordEdits(decoded.text, personalEdits)
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        boxes = undefined
      }
    }
    const transposed = transposedTraceWord(decoded.text, decoded.greedyText, knownWord(entry.language))
    if (transposed) {
      const rewritten = rewriteWord(decoded.characters, transposed.index, transposed.to)
      const nextText = textWithWordEdits(decoded.text, [transposed])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        boxes = undefined
      }
    }
    const tracedTail = trailingTracedLetter(decoded.text, decoded.greedyText, knownWord(entry.language))
    if (tracedTail) {
      const rewritten = rewriteWord(decoded.characters, tracedTail.index, tracedTail.to)
      const nextText = textWithWordEdits(decoded.text, [tracedTail])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        boxes = undefined
      }
    }
    const article = accusativeDer(decoded.text)
    if (article) {
      const rewritten = rewriteSameLengthWord(decoded.characters, article.index, article.to)
      const nextText = textWithWordEdits(decoded.text, [article])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        boxes = undefined
      }
    }
    const shortCase = lowercaseShortBeamWord(decoded.text, decoded.readings ?? [])
    if (shortCase) {
      const rewritten = rewriteSameLengthWord(decoded.characters, shortCase.index, shortCase.to)
      const nextText = textWithWordEdits(decoded.text, [shortCase])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        boxes = undefined
      }
    }
    const initialCase = lowercaseInitialFromBeam(
      decoded.text,
      decoded.readings ?? [],
      entry.language,
      decoded.characters,
      knownWord(entry.language),
    )
    if (initialCase) {
      const rewritten = rewriteSameLengthWord(decoded.characters, initialCase.index, initialCase.to)
      const nextText = textWithWordEdits(decoded.text, [initialCase])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        boxes = undefined
      }
    }
    const movedQuote = quoteAfterParenthesis(decoded.characters)
    if (movedQuote) {
      decoded = { ...decoded, characters: movedQuote, text: movedQuote.map((character) => character.char).join('') }
      boxes = undefined
    }
    const clubPeriod = periodBeforeCapitals(decoded.characters, entry.language)
    if (clubPeriod) {
      decoded = { ...decoded, characters: clubPeriod, text: clubPeriod.map((character) => character.char).join('') }
      boxes = undefined
    }
    const strayParen = strayParenBeforeCapital(decoded.characters)
    if (strayParen) {
      decoded = { ...decoded, characters: strayParen, text: strayParen.map((character) => character.char).join('') }
      boxes = undefined
    }
    const quoteSpace = spaceBetweenDifferentQuotes(decoded.characters)
    if (quoteSpace) {
      decoded = { ...decoded, characters: quoteSpace, text: quoteSpace.map((character) => character.char).join('') }
      boxes = undefined
    }
    const closedBracket = closeBracketAfterLetter(decoded.characters)
    if (closedBracket) {
      decoded = { ...decoded, characters: closedBracket, text: closedBracket.map((character) => character.char).join('') }
      boxes = undefined
    }
    const symbolSpace = spaceBetweenSymbolRuns(decoded.characters)
    if (symbolSpace) {
      decoded = { ...decoded, characters: symbolSpace, text: symbolSpace.map((character) => character.char).join('') }
      boxes = undefined
    }
    const tracedBracket = openingBracketFromTrace(decoded.characters, decoded.greedyText ?? '')
    if (tracedBracket) {
      decoded = { ...decoded, characters: tracedBracket, text: tracedBracket.map((character) => character.char).join('') }
      boxes = undefined
    }
    const tracedComma = tracedFinalComma(decoded.characters, decoded.readings ?? [], decoded.greedyText ?? '')
    if (tracedComma) {
      decoded = { ...decoded, characters: tracedComma, text: tracedComma.map((character) => character.char).join('') }
      boxes = undefined
    }
    const splitJoin = splitFunctionWordJoin(decoded.characters, decoded.readings ?? [], knownWord(entry.language))
    if (splitJoin) {
      decoded = { ...decoded, characters: splitJoin, text: splitJoin.map((character) => character.char).join('') }
      boxes = undefined
    }
    const englishPronoun = capitalizeEnglishPronoun(decoded.text, entry.language)
    if (englishPronoun) {
      const rewritten = rewriteSameLengthWord(decoded.characters, englishPronoun.index, englishPronoun.to)
      const nextText = textWithWordEdits(decoded.text, [englishPronoun])
      if (rewritten && nextText !== decoded.text) {
        decoded = { ...decoded, text: nextText, characters: rewritten }
        boxes = undefined
      }
    }
    const compoundKnown = knownWord(entry.language)
    const unknownCompound = [...decoded.text.matchAll(/[A-Za-zÄÖÜäöüß]+/gu)]
      .map((match) => match[0])
      .map((word, index) => ({ word, index }))
      .filter(({ word }) => [...word].length >= 12 && !compoundKnown(word) && !dictionaryCompound(word, compoundKnown))
    if (unknownCompound.length === 1) {
      const compounds = []
      for (const group of isolatedWideGroups(linePacked)) {
        const compoundRaw = inkLineImage(group, reference, COMPOUND_PEN, COMPOUND_SHEAR, COMPOUND_SCALE)
        if (compoundRaw.length < 3) continue
        const compoundStarted = Date.now()
        const compoundRun = await host.recognize({ input: Float32Array.from(compoundRaw.subarray(2)), width: compoundRaw[0], height: 64, threads: 4 })
        inferenceMs += Date.now() - compoundStarted
        const compoundDecoded = JSON.parse(inkDecode(compoundRun.probabilities, compoundRun.dims[2], manifest.alphabet, entry.language, decoderOptionsFor(entry.language)))
        const tokens = [...compoundDecoded.text.matchAll(/[A-Za-zÄÖÜäöüß]+/gu)].map((match) => match[0])
        if (tokens.length === 1 && dictionaryCompound(tokens[0], compoundKnown)) compounds.push(tokens[0])
      }
      const target = unknownCompound[0]
      if (compounds.length === 1 && compounds[0] !== target.word) {
        const rewritten = rewriteWord(decoded.characters, target.index, compounds[0])
        const nextText = textWithWordEdits(decoded.text, [{ index: target.index, from: target.word, to: compounds[0] }])
        if (rewritten && nextText !== decoded.text) {
          decoded = { ...decoded, text: nextText, characters: rewritten }
          boxes = undefined
        }
      }
    }
    if (!boxes) {
      const spans = new Uint32Array(decoded.characters.flatMap((c) => [c.startFrame, c.endFrame]))
      boxes = inkSpanBoxes(boxedPacked, reference, penWidth, shear, scale, spans)
    }
    if (!decoded.text.trim()) continue
    lines.push({ decoded, boxes, characters: decoded.characters.length })
  }
  return { text: lines.map((l) => l.decoded.text).join('\n'), lines, inferenceMs }
}

// Stacks real pen-stroke lines into one page to exercise line grouping end to end. `entry`
// strokes are normalized to its own box; each copy lands on its own well-separated row.
const composePage = (entry, rows) => {
  const lineHeight = 46
  const rowGap = 92
  const strokes = []
  for (let row = 0; row < rows; row += 1) {
    for (const stroke of entry.strokes) {
      strokes.push(stroke.map(([x, y]) => [
        (70 + x * 760) / 900,
        (90 + row * rowGap + y * lineHeight) / 1273,
      ]))
    }
  }
  return { strokes, truth: Array.from({ length: rows }, () => entry.truth).join('\n') }
}

try {
  const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'))
  const rows = []
  let cold = 0
  const warm = []
  for (const entry of cases) {
    const started = Date.now()
    const result = await recognize(entry, { group: false })
    const elapsed = Date.now() - started
    if (!rows.length) cold = elapsed
    else warm.push(result.inferenceMs)
    rows.push({ name: entry.name, language: entry.language, truth: entry.truth, text: result.text, characters: result.lines.reduce((s, l) => s + l.characters, 0), boxes: result.lines.reduce((s, l) => s + l.boxes.filter((v, i) => i % 4 === 0 && Number.isFinite(v)).length, 0) })
    if (process.env.FANOTES_INK_DEBUG === '1') console.log(`${entry.name}\t${entry.truth}\t→ ${result.text}`)
  }
  const report = {}
  for (const language of ['de', 'en']) {
    const chosen = rows.filter((r) => r.language === language)
    if (chosen.length) report[language] = { lines: chosen.length, exact: chosen.filter((row) => row.text === row.truth).length, cer: Number(cer(chosen).toFixed(2)), wer: Number(wer(chosen).toFixed(2)) }
  }
  // One real pen line (IAM-OnDB) stacked into a 3-line page checks grouping end to end.
  const pages = []
  const penLine = cases.find((entry) => entry.name === 'iam-ondb-a01-001z-01')
  if (penLine) {
    const composed = composePage(penLine, 3)
    const result = await recognize({ language: 'en' }, { strokes: composed.strokes, width: 900, height: 1273, group: true })
    pages.push({ language: 'en', truth: composed.truth, text: result.text, lines: result.lines.length, expected: 3, cer: Number(cer([{ text: result.text, truth: composed.truth }]).toFixed(2)) })
    if (process.env.FANOTES_INK_DEBUG === '1') console.log(`page\t${composed.truth.replaceAll('\n', ' / ')}\t→ ${result.text.replaceAll('\n', ' / ')}`)
  }
  console.log(JSON.stringify({ model: manifest.version, report, pages: pages.map(({ language, lines, expected, cer }) => ({ language, lines, expected, cer })), coldMs: cold, warmMs: Math.round(warm.reduce((s, v) => s + v, 0) / Math.max(1, warm.length)) }, null, 2))

  if (!process.env.FANOTES_INK_CASES) {
    const iam = rows.find((r) => r.name === 'iam-ondb-a01-001z-01')
    assert.ok(iam, 'the IAM-OnDB example line is missing')
    assert.ok(cer([iam]) <= 8, `the real IAM-OnDB pen line is too inaccurate: ${JSON.stringify(iam)}`)
    assert.ok(report.de?.cer <= 8, `German handwriting (ScaDS, unseen writers) is too inaccurate: ${JSON.stringify(report.de)}`)
    assert.ok(rows.every((r) => r.boxes === r.characters), 'every recognized character needs a page position')
    for (const page of pages) {
      assert.equal(page.lines, page.expected, `page line splitting is wrong: ${JSON.stringify(page)}`)
      assert.ok(page.cer <= 8, `a stacked real-pen page is too inaccurate: ${JSON.stringify(page)}`)
    }
  }
} finally {
  host.stop()
}
