// Writing assistance: autocorrect, grammar/punctuation/typography rules, style
// hints, language detection, the checker and the thesaurus, in German and
// English. Each case also states what must NOT be flagged.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const vite = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
const results = []
const test = async (name, body) => {
  try { await body(); results.push(['PASS', name]) } catch (error) { results.push(['FAIL', name, error]) }
}

try {
  const typo = await vite.ssrLoadModule('/src/writing/assist/typography.ts')
  const rules = await vite.ssrLoadModule('/src/writing/assist/rules.ts')
  const style = await vite.ssrLoadModule('/src/writing/assist/style.ts')
  const language = await vite.ssrLoadModule('/src/writing/assist/language.ts')
  const checker = await vite.ssrLoadModule('/src/writing/assist/checker.ts')
  const thesaurus = await vite.ssrLoadModule('/src/writing/assist/thesaurus.ts')

  /** Types `typed` after `before` and applies the autocorrect fix, like the editor does. */
  const typeInto = (before, typed, lang, extra = {}) => {
    let text = before
    for (const char of typed) {
      text += char
      const fix = typo.autocorrectAfterInput(text, text.length, char, lang, { ...typo.defaultAutocorrect(lang), ...extra })
      if (fix) text = text.slice(0, fix.from) + fix.text + text.slice(fix.to)
    }
    return text
  }

  await test('autocorrect: quotes, apostrophes, dashes and ellipsis per language', () => {
    assert.equal(typeInto('', '"Komm her", sagte sie.', 'de'), '„Komm her“, sagte sie.')
    assert.equal(typeInto('', '"Komm her", sagte sie.', 'de-CH'), '«Komm her», sagte sie.')
    assert.equal(typeInto('', '"Come here," she said.', 'en-US'), '“Come here,” she said.')
    assert.equal(typeInto('', '"Come here," she said.', 'en-GB'), '‘Come here,’ she said.')
    assert.equal(typeInto('', "It's Peter's car.", 'en-US'), 'It’s Peter’s car.')
    assert.equal(typeInto('', "Wie geht's?", 'de'), 'Wie geht’s?')
    assert.equal(typeInto('', "Er sagte 'nein' dazu.", 'de'), 'Er sagte ‚nein‘ dazu.')
    assert.equal(typeInto('', 'Und dann... nichts.', 'de'), 'Und dann… nichts.')
    assert.equal(typeInto('', 'Sie kam - spät - an.', 'de'), 'Sie kam – spät – an.')
    assert.equal(typeInto('', 'She came - late - home.', 'en-US'), 'She came—late—home.')
    assert.equal(typeInto('', 'So--genau.', 'de'), 'So–genau.')
    assert.equal(typeInto('', 'Ein Bindestrich-Wort bleibt.', 'de'), 'Ein Bindestrich-Wort bleibt.')
  })

  await test('autocorrect: capitals at sentence starts, but not after abbreviations or numbers', () => {
    assert.equal(typeInto('', 'es war spät. dann ging er.', 'de'), 'Es war spät. Dann ging er.')
    assert.equal(typeInto('', 'Er kam! wer war das?', 'de'), 'Er kam! Wer war das?')
    assert.equal(typeInto('', 'Obst, z. B. äpfel und Birnen.', 'de'), 'Obst, z. B. äpfel und Birnen.')
    assert.equal(typeInto('', 'Am 3. dezember fiel Schnee.', 'de'), 'Am 3. dezember fiel Schnee.')
    assert.equal(typeInto('', 'Und dann… ging sie.', 'de'), 'Und dann… ging sie.')
    assert.equal(typeInto('', '„Komm!“ sie lief.', 'de'), '„Komm!“ Sie lief.')
    assert.equal(typeInto('', 'DIe Tür war offen. NASA bleibt.', 'de'), 'Die Tür war offen. NASA bleibt.')
    assert.equal(typeInto('', 'i think i\'m right.', 'en-US'), 'I think I’m right.')
    assert.equal(typeInto('', 'Visit www.example.com today.', 'en-US'), 'Visit www.example.com today.')
  })

  await test('autocorrect: Swiss ss, dictionary corrections, own replacements, names left alone', () => {
    assert.equal(typeInto('', 'Die Straße war groß. ', 'de-CH'), 'Die Strasse war gross. ')
    assert.equal(typeInto('', 'Die Straße war groß. ', 'de'), 'Die Straße war groß. ')
    const correctWord = (word) => ({ Hasue: 'Hause', teh: 'the' })[word] ?? null
    assert.equal(typeInto('', 'Sie ging nach Hasue.', 'de', { correctWord }), 'Sie ging nach Hause.')
    assert.equal(typeInto('', 'teh dog barked.', 'en-US', { correctWord }), 'The dog barked.')
    assert.equal(typeInto('', 'zb das hier.', 'de', { replacements: { zb: 'z. B.' } }), 'Z. B. das hier.'.replace('Z. B.', 'z. B.').replace(/^z/u, 'z'))
    assert.equal(typeInto('', 'Hasue blieb.', 'de', { correctWord, isKnown: (word) => word === 'Hasue' }), 'Hasue blieb.', 'a word in the story dictionary is a name')
  })

  const ids = (text, lang) => rules.checkRules(text, lang).map((issue) => issue.rule)
  const fix = (text, lang, rule) => {
    const issue = rules.checkRules(text, lang).find((candidate) => candidate.rule === rule)
    assert.ok(issue, `${rule} not found in: ${text}`)
    return text.slice(0, issue.from) + issue.replacements[0] + text.slice(issue.to)
  }

  await test('German grammar: das/dass, seit/seid, wider/wieder, als/wie, capitalisation', () => {
    assert.equal(fix('Ich glaube, das er kommt.', 'de', 'de-das-dass'), 'Ich glaube, dass er kommt.')
    assert.equal(fix('Sie wusste, das es zu spät war.', 'de', 'de-das-dass'), 'Sie wusste, dass es zu spät war.')
    assert.ok(!ids('Das Haus, das er baute, steht noch.', 'de').includes('de-das-dass'), 'a relative "das" is right')
    assert.equal(fix('Es regnete, so das wir blieben.', 'de', 'de-das-dass'), 'Es regnete, sodass wir blieben.')
    assert.equal(fix('Ihr seit spät dran.', 'de', 'de-seit-seid'), 'Ihr seid spät dran.')
    assert.equal(fix('Seid gestern regnet es.', 'de', 'de-seit-seid'), 'Seit gestern regnet es.')
    assert.ok(!ids('Seid ihr bereit? Seit Jahren warte ich.', 'de').includes('de-seit-seid'))
    assert.equal(fix('Er tat es wieder Willen.', 'de', 'de-wider-wieder'), 'Er tat es wider Willen.')
    assert.equal(fix('Der Wiederstand war gross.', 'de', 'de-wider-wieder'), 'Der Widerstand war gross.')
    assert.ok(!ids('Er kam wieder nach Hause.', 'de').includes('de-wider-wieder'))
    assert.equal(fix('Sie ist größer wie ihr Bruder.', 'de', 'de-als-wie'), 'Sie ist größer als ihr Bruder.')
    assert.ok(!ids('Sie ist so gross wie ihr Bruder.', 'de').includes('de-als-wie'))
    assert.equal(fix('Beim lesen schlief er ein.', 'de', 'de-noun-after-preposition-article'), 'Beim Lesen schlief er ein.')
    assert.ok(!ids('Im ganzen Haus war es still.', 'de').includes('de-noun-after-preposition-article'))
    assert.equal(fix('Das war die meinung aller.', 'de', 'de-noun-suffix-lowercase'), 'Das war die Meinung aller.')
    assert.equal(fix('Das ist Peter\'s Auto.', 'de', 'de-apostrophe-genitive'), 'Das ist Peters Auto.')
    assert.ok(!ids('Das ist Hans’ Auto.', 'de').includes('de-apostrophe-genitive'))
  })

  await test('German punctuation: commas before subordinate clauses and "sondern", none where they do not belong', () => {
    assert.equal(fix('Er blieb zu Hause weil es regnete.', 'de', 'de-comma-subordinate'), 'Er blieb zu Hause, weil es regnete.')
    assert.equal(fix('Sie wusste nicht ob er kommt.', 'de', 'de-comma-subordinate'), 'Sie wusste nicht, ob er kommt.')
    assert.equal(fix('Ich hoffe dass du kommst.', 'de', 'de-comma-subordinate'), 'Ich hoffe, dass du kommst.')
    for (const ok of ['Er blieb, weil es regnete.', 'Weil es regnete, blieb er.', 'Sie kam, auch wenn sie müde war.', 'Er tat, als ob er schliefe.', 'Er kam nur weil sie rief.', 'Und wenn schon.']) {
      assert.ok(!ids(ok, 'de').includes('de-comma-subordinate'), ok)
    }
    assert.equal(fix('Nicht rot sondern blau.', 'de', 'de-comma-sondern'), 'Nicht rot, sondern blau.')
    assert.equal(fix('Das ist z.B. so.', 'de', 'de-abbreviation-space'), 'Das ist z. B. so.')
  })

  await test('Typography and punctuation in both languages', () => {
    assert.equal(fix('Er sagte "ja".', 'de', 'straight-quote'), 'Er sagte „ja".')
    assert.equal(fix('Und dann...', 'de', 'ellipsis'), 'Und dann…')
    assert.equal(fix('Sie kam - spät.', 'de', 'spaced-hyphen'), 'Sie kam – spät.')
    assert.equal(fix('Zwei  Leerzeichen.', 'de', 'double-space'), 'Zwei Leerzeichen.')
    assert.equal(fix('Ja , genau.', 'de', 'space-before-punctuation'), 'Ja, genau.')
    assert.equal(fix('Ja,genau.', 'de', 'missing-space-after-punctuation'), 'Ja, genau.')
    assert.ok(!ids('Es kostet 3,50 Franken auf www.beispiel.ch heute.', 'de').includes('missing-space-after-punctuation'))
    assert.equal(fix('Das ist und und klar.', 'de', 'repeated-word'), 'Das ist und klar.')
    assert.ok(!ids('Die Frau, die die Tür öffnete, lachte.', 'de').includes('repeated-word'), 'relative "die die" is right')
    assert.ok(!ids('He said that that was fine.', 'en-US').includes('repeated-word'))
    assert.equal(fix('Er ging. dann kam sie.', 'de', 'sentence-start-lowercase'), 'Er ging. Dann kam sie.')
    assert.ok(!ids('Er sah z. B. einen Hund.', 'de').includes('sentence-start-lowercase'))
    assert.ok(ids('Die Straße war leer.', 'de-CH').includes('de-ch-eszett'))
    assert.ok(!ids('Die Straße war leer.', 'de').includes('de-ch-eszett'))
  })

  await test('English grammar: a/an, its/it’s, your/you’re, there, could of, then/than, I', () => {
    assert.equal(fix('She ate a apple.', 'en-US', 'en-a-an'), 'She ate an apple.')
    assert.equal(fix('He went to an university.', 'en-US', 'en-a-an'), 'He went to a university.')
    assert.equal(fix('Wait a hour.', 'en-US', 'en-a-an'), 'Wait an hour.')
    for (const ok of ['an hour', 'a European city', 'a one-off', 'an honest man', 'a user', 'an MBA']) assert.ok(!ids(`It was ${ok}.`, 'en-US').includes('en-a-an'), ok)
    assert.equal(fix('Its a trap.', 'en-US', 'en-its'), 'It’s a trap.')
    assert.equal(fix('The dog wagged it’s own tail.', 'en-US', 'en-its'), 'The dog wagged its own tail.')
    assert.ok(!ids('The dog wagged its tail.', 'en-US').includes('en-its'))
    assert.equal(fix('Your welcome.', 'en-US', 'en-your'), 'You’re welcome.')
    assert.ok(!ids('Your house is lovely.', 'en-US').includes('en-your'))
    assert.equal(fix('Their is a problem.', 'en-US', 'en-their-there'), 'There is a problem.')
    assert.equal(fix('I could of known.', 'en-US', 'en-could-of'), 'I could have known.')
    assert.equal(fix('It is better then before.', 'en-US', 'en-then-than'), 'It is better than before.')
    assert.ok(!ids('We ate, then we left.', 'en-US').includes('en-then-than'))
    assert.equal(fix('Then i left.', 'en-US', 'en-lowercase-i'), 'Then I left.')
  })

  await test('style hints: fillers, repetition, long sentences, passive, readability', () => {
    const on = { ...style.defaultStyleOptions(), fillers: true, repetition: true, longSentences: true, passive: true }
    const de = style.checkStyle('Eigentlich war der Wald dunkel. Im Wald war es still.', 'de', on)
    assert.ok(de.some((issue) => issue.rule === 'style-filler' && issue.from === 0))
    assert.ok(de.some((issue) => issue.rule === 'style-repetition'))
    const en = style.checkStyle('The door was opened by him. It was very quiet.', 'en-US', on)
    assert.ok(en.some((issue) => issue.rule === 'style-passive'))
    assert.ok(en.some((issue) => issue.rule === 'style-filler'))
    const long = style.checkStyle(`${'Wort '.repeat(40)}.`, 'de', on)
    assert.ok(long.some((issue) => issue.rule === 'style-long-sentence'))
    assert.equal(style.checkStyle('Eigentlich war es gut.', 'de', style.defaultStyleOptions()).length, 0, 'style hints are off by default')
    const easy = style.readability('Der Hund lief. Die Katze sass. Es war warm.', 'de')
    const hard = style.readability('Die verfassungsrechtliche Auseinandersetzung bezüglich infrastruktureller Investitionsentscheidungen verdeutlichte gesellschaftspolitische Interessenkonflikte.', 'de')
    assert.ok(easy.score > hard.score && easy.score >= 60, `${easy.score} vs ${hard.score}`)
  })

  await test('language detection per paragraph', () => {
    assert.equal(language.detectLanguage('Sie ging nach Hause und schloss die Tür hinter sich.'), 'de')
    assert.equal(language.detectLanguage('She went home and closed the door behind her.'), 'en')
    assert.equal(language.detectLanguage('Okay.'), null)
    assert.equal(checker.paragraphLanguage('She went home and closed the door.', undefined, 'de', true), 'en-US')
    assert.equal(checker.paragraphLanguage('She went home and closed the door.', 'de-CH', 'de', true), 'de-CH', 'a set paragraph language wins')
    assert.equal(checker.paragraphLanguage('She went home and closed the door.', undefined, 'de', false), 'de')
  })

  await test('checker: spelling with suggestions, story dictionary, ignored findings, cache', () => {
    const spelling = { isMisspelled: (word) => ['Hasue', 'Elrond'].includes(word), suggest: (word) => (word === 'Hasue' ? ['Hause', 'Hase'] : []) }
    const assistant = new checker.Assistant(spelling)
    const runs = [{ text: 'Elrond ging nach Hasue weil es regnete.' }]
    let result = assistant.check(runs, undefined, 'de')
    assert.deepEqual(result.issues.filter((issue) => issue.category === 'spelling').map((issue) => [issue.from, issue.replacements[0] ?? null]), [[0, null], [17, 'Hause']])
    assert.ok(result.issues.some((issue) => issue.rule === 'de-comma-subordinate'))
    assert.equal(assistant.check(runs, undefined, 'de'), result, 'same runs, same object (cached)')
    assistant.setProjectLists(['Elrond'], [])
    result = assistant.check(runs, undefined, 'de')
    assert.ok(!result.issues.some((issue) => issue.from === 0), 'a name in the story dictionary is not flagged')
    const comma = result.issues.find((issue) => issue.rule === 'de-comma-subordinate')
    assistant.setProjectLists(['Elrond'], [checker.issueSignature(comma, runs[0].text)])
    assert.ok(!assistant.check(runs, undefined, 'de').issues.some((issue) => issue.rule === 'de-comma-subordinate'), 'ignored stays ignored')
  })

  await test('thesaurus: German and English synonyms from the bundled files, inflected forms too', () => {
    const de = thesaurus.parseThesaurus(readFileSync(new URL('../public/writing/thesaurus/de.txt', import.meta.url), 'utf8'), 'de')
    const en = thesaurus.parseThesaurus(readFileSync(new URL('../public/writing/thesaurus/en.txt', import.meta.url), 'utf8'), 'en')
    const words = (groups) => groups.flatMap((group) => group.words)
    assert.ok(words(thesaurus.synonyms(de, 'schnell', 'de')).includes('rasch'))
    assert.ok(words(thesaurus.synonyms(de, 'schnellen', 'de')).length > 0, 'inflected adjective')
    assert.ok(words(thesaurus.synonyms(de, 'sagte', 'de')).length > 0, 'past tense')
    const quick = thesaurus.synonyms(en, 'quickly', 'en')
    assert.ok(words(quick).some((word) => ['rapidly', 'speedily', 'fast'].includes(word)), JSON.stringify(quick).slice(0, 200))
    assert.ok(thesaurus.synonyms(en, 'house', 'en').some((group) => group.label?.en === 'noun'))
  })
} finally {
  await vite.close()
}

for (const [status, name, error] of results) {
  console.log(`${status}  ${name}`)
  if (error) console.log(`      ${String(error?.stack ?? error).split('\n').slice(0, 5).join('\n      ')}`)
}
const failed = results.filter(([status]) => status === 'FAIL').length
console.log(`${results.length - failed}/${results.length} passed`)
if (failed) process.exit(1)
