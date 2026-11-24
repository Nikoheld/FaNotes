// Document language detection for spellcheck and autocorrect, measured on a realistic corpus of a
// Swiss Kantonsschule student's notes (German, English and French, often mixed in one note).
//
//   node scripts/check-spelling-languages.mjs                     asserts the new behaviour
//   FANOTES_SPELL_BASELINE=1 FANOTES_SPELL_ROOT=<old checkout>/fanotes node scripts/check-spelling-languages.mjs
//                                                                  prints the same numbers for an older checkout (no asserts)
//
// For every note the script asks the spellchecker which words it underlines and which passage
// language it assigns, then replays the typing: for each word the note up to that word is the
// document, and the autocorrect decision for that word is read back. A correct word that would be
// replaced is a false autocorrect; a typo replaced by anything but its fix is a wrong autocorrect.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const appRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const root = process.env.FANOTES_SPELL_ROOT ? path.resolve(process.env.FANOTES_SPELL_ROOT) : appRoot
const baseline = process.env.FANOTES_SPELL_BASELINE === '1'
const spellDir = path.join(root, 'public', 'spell')
const manifest = JSON.parse(await readFile(path.join(spellDir, 'manifest.json'), 'utf8'))
const bytes = async (name) => new Uint8Array(await readFile(path.join(spellDir, name)))
const files = { de: await bytes('de.bloom'), en: await bytes('en.bloom'), deWords: await bytes('de.words'), enWords: await bytes('en.words') }
const french = !baseline && manifest.french ? { bloom: await bytes('fr.bloom'), words: await bytes('fr.words') } : null

globalThis.window = {
  fanotes: {
    loadSpellingResources: async () => ({ manifest, de: files.de, en: files.en, ...(french ? { fr: french.bloom } : {}) }),
    loadSpellingWordCandidates: async (language) => {
      if (language === 'fr') {
        if (!french) throw new Error('no French')
        return { language, descriptor: manifest.french.candidates, bytes: french.words }
      }
      return { language, descriptor: manifest.languages[language].candidates, bytes: language === 'de' ? files.deWords : files.enWords }
    },
  },
}

/* ---------- the corpus ---------- */

// ⟦typo|fix⟧ marks a typing slip and the word it should become. A line given as { text, passages }
// also states the expected language of the passages it contains ([substring, language]).
// `unsupported` lines are in a language without dictionary: nothing may be autocorrected there.
const NOTES = [
  {
    name: 'German note with English terms',
    lines: [
      '# Informatik: Algorithmen',
      { text: 'Ein Algorithmus ist eine Folge von Schritten, die ein Problem löst.', passages: [['Ein Algorithmus', 'de']] },
      'Der Computer führt jeden ⟦Befhel|Befehl⟧ nacheinander aus.',
      'Wichtige Begriffe sind Array, Loop, Software und Hardware.',
      'Die Variable speichert einen ⟦Wret|Wert⟧ im Arbeitsspeicher.',
      { text: 'Ein Programm mit einem ⟦Fehlr|Fehler⟧ liefert ein falsches Resultat.', passages: [['Ein Programm', 'de']] },
      'Der ⟦Bidlschirm|Bildschirm⟧ zeigt die Ausgabe an und die Maus steuert den Zeiger.',
      { text: 'Beim Debugging sucht man den Fehler im Code.', passages: [['Beim Debugging', 'de']] },
    ],
  },
  {
    name: 'French class note with German explanations',
    lines: [
      '# Französisch: Passé composé',
      { text: 'Le passé composé se forme avec l\'auxiliaire avoir ou être et le participe passé.', passages: [['Le passé', 'fr']] },
      { text: 'Hier, j\'ai mangé une ⟦pomem|pomme|fr⟧ et mon frère a bu du lait.', passages: [['Hier, j\'ai', 'fr']] },
      { text: 'Elle est allée à l\'école avec ses ⟦amsi|amis|fr⟧ et ils ont joué dans le ⟦jadrin|jardin|fr⟧.', passages: [['Elle est', 'fr']] },
      { text: 'Hier soir nous avons regardé un film très ⟦intéressnt|intéressant|fr⟧.', passages: [['Hier soir', 'fr']] },
      { text: 'Erklärung: Bei Verben der Bewegung verwendet man être als Hilfsverb.', passages: [['Bei Verben', 'de']] },
      { text: 'Das Partizip richtet sich nach dem ⟦Subjket|Subjekt⟧ des Satzes.', passages: [['Das Partizip', 'de']] },
      { text: 'Les ⟦élvèes|élèves|fr⟧ ont fait leurs devoirs et le professeur a corrigé l\'⟦ecole|école|fr⟧.', passages: [['ont fait leurs devoirs', 'fr']] },
      { text: 'Pourquoi est-ce que tu ⟦palres|parles|fr⟧ si vite aujourd\'hui ?', passages: [['Pourquoi', 'fr']] },
    ],
  },
  {
    name: 'Vocabulary lists',
    lines: [
      '## Vokabeln Französisch',
      { text: 'le chien – der Hund', passages: [['le chien', 'fr'], ['der Hund', 'de']] },
      { text: 'la maison – das Haus', passages: [['la maison', 'fr'], ['das Haus', 'de']] },
      { text: 'le chat – die Katze', passages: [['le chat', 'fr'], ['die Katze', 'de']] },
      { text: 'l\'école = die Schule', passages: [['l\'école', 'fr'], ['die Schule', 'de']] },
      { text: 'le ⟦chein|chien|fr⟧ – der Hund', passages: [['der Hund', 'de']], weak: true },
      { text: '- la ⟦maisno|maison|fr⟧ – das Haus', passages: [['das Haus', 'de']], weak: true },
      '## Vocabulary English',
      { text: 'the dog – der Hund', passages: [['the dog', 'en'], ['der Hund', 'de']] },
      { text: 'the house – das Haus', passages: [['the house', 'en'], ['das Haus', 'de']] },
      { text: 'to run = laufen', passages: [['to run', 'en'], ['laufen', 'de']] },
      { text: 'the ⟦hosue|house⟧ – das Haus', passages: [['das Haus', 'de']], weak: true },
      { text: '| le livre | das Buch |', passages: [['le livre', 'fr'], ['das Buch', 'de']] },
      'chien',
      'Hund',
    ],
  },
  {
    name: 'English note with a German quote',
    lines: [
      '# History: The Swiss Confederation',
      { text: 'The Swiss Confederation was ⟦fonuded|founded⟧ in 1291 by three cantons.', passages: [['The Swiss', 'en']] },
      { text: 'The teacher said: „Das ist ein wichtiges Datum für die Schweiz.“ and we wrote it down.', passages: [['The teacher said', 'en'], ['Das ist ein wichtiges', 'de']] },
      { text: 'Students must learn the ⟦differnt|different⟧ treaties and their dates.', passages: [['Students must', 'en']] },
      { text: 'Der Bundesbrief ist das älteste Dokument der Schweiz.', passages: [['Der Bundesbrief', 'de']] },
      { text: 'The document is kept in a museum and many people visit it every year.', passages: [['The document', 'en']] },
    ],
  },
  {
    name: 'Single words and headings',
    lines: [
      '# Biologie',
      'Zelle',
      'Zellkern',
      '## Aufbau',
      'Die Zelle ist die kleinste Einheit des Lebens und besteht aus vielen Teilen.',
      '⟦Zelkern|Zellkern⟧',
      'Der Zellkern enthält die Erbinformation der Zelle.',
      'Nucleus',
    ],
  },
  {
    name: 'Italian line must stay untouched',
    lines: [
      '# Italienisch',
      'Das ist ein Satz über den Unterricht und die Hausaufgaben.',
      { text: 'Il cane è molto grande e la casa è vicino al fiume.', unsupported: true },
      { text: 'Buongiorno, come stai oggi? Sto molto bene, grazie mille.', unsupported: true },
      'Der Lehrer hat gesagt, dass wir die Wörter lernen müssen.',
    ],
  },
  {
    name: 'Mixed German note with French vocabulary and English quote',
    lines: [
      '# Sprachen: Wochenplan',
      'Am Montag haben wir Französisch und am Dienstag Englisch.',
      { text: 'Wir lernen die Wörter le lundi, le mardi und le mercredi.', passages: [['Wir lernen', 'unsure']] },
      { text: 'Les jours de la semaine sont très faciles à retenir.', passages: [['Les jours', 'fr']] },
      { text: 'Der Lehrer sagte: "The weekend starts on Friday afternoon." und alle freuten sich.', passages: [['Der Lehrer', 'de'], ['The weekend', 'en']] },
      'Die ⟦Hausafugabe|Hausaufgabe⟧ ist bis Freitag abzugeben.',
    ],
  },
]

const MARK = /⟦([^|⟧]+)\|([^|⟧]+)(?:\|([a-z]+))?⟧/gu
const prepare = (note) => {
  const typos = []
  const passages = []
  const unsupported = []
  const lineStarts = []
  let text = ''
  note.lines.forEach((entry, index) => {
    const spec = typeof entry === 'string' ? { text: entry } : entry
    const start = text.length
    lineStarts.push(start)
    let plain = ''
    let last = 0
    for (const match of spec.text.matchAll(MARK)) {
      plain += spec.text.slice(last, match.index)
      typos.push({ from: start + plain.length, to: start + plain.length + match[1].length, typo: match[1], fix: match[2], language: match[3] ?? null, weak: Boolean(spec.weak), line: index })
      plain += match[1]
      last = match.index + match[0].length
    }
    plain += spec.text.slice(last)
    for (const [needle, language] of spec.passages ?? []) {
      const at = plain.indexOf(needle)
      assert.ok(at >= 0, `passage ${needle} is in ${plain}`)
      passages.push({ from: start + at, to: start + at + needle.length, language, text: needle })
    }
    if (spec.unsupported) unsupported.push({ from: start, to: start + plain.length })
    text += plain + (index < note.lines.length - 1 ? '\n' : '')
  })
  return { ...note, text, typos, passages, unsupported }
}
const notes = NOTES.map(prepare)

/* ---------- adapters ---------- */

const server = await createServer({ root, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true }, appType: 'custom', logLevel: 'error' })
const toSegments = (text) => {
  let from = 0
  return text.split('\n').map((line) => {
    const segment = { from, text: line }
    from += line.length + 1
    return segment
  })
}
const textSource = (text) => ({ iterLines: () => text.split('\n') })
const LETTER_RUN = /\p{L}+/gu

try {
  const spelling = await server.ssrLoadModule('/src/lib/spelling.ts')
  const suggest = await server.ssrLoadModule('/src/lib/spellingSuggest.ts')
  let analyze
  let autocorrect
  if (baseline) {
    // The behaviour before this change, replayed as the old editor did it: the line language of the
    // last pass (computed from the text before the word) picks the candidates, German and English
    // dictionaries alone decide "misspelled".
    const { loadSpellingEngine } = await server.ssrLoadModule('/src/lib/spellingEngine.ts')
    const engine = await loadSpellingEngine()
    const opensSentence = (text, from) => {
      const lineStart = text.lastIndexOf('\n', from - 1) + 1
      const before = text.slice(lineStart, from).replace(/^\s*(?:[-*+>]|\d+[.)]|#{1,6})?\s*/u, '')
      return !before.trim() || /[.!?:]\s*$/u.test(before)
    }
    analyze = async (note) => {
      const result = await spelling.checkSpelling({ segments: toSegments(note.text) })
      return {
        errors: result.errors,
        languageAt: (position) => result.lines.find((line) => position >= line.from && position <= line.to)?.language ?? null,
      }
    }
    autocorrect = async (text, start, end) => {
      const word = text.slice(start, end)
      if (start > 0 && /[\p{L}\p{M}\d'’\-_#@/\\.:&+]/u.test(text[start - 1])) return null
      if (word.length < 1 || !engine.isMisspelled(word)) return null
      const before = text.slice(0, start)
      const lineStart = before.lastIndexOf('\n') + 1
      const pass = before.slice(lineStart).trim() ? await spelling.checkSpelling({ segments: toSegments(before), cursorPositions: [start] }) : null
      const language = pass?.lines.find((line) => start >= line.from && start <= line.to + 1)?.language ?? null
      const decision = await engine.planAutocorrect(word, language ? [language] : null, {
        language,
        sentenceStart: opensSentence(text, start),
        properName: spelling.isCanonicalProperName(word.normalize('NFC').toLocaleLowerCase('en-US')),
      })
      return decision?.word ?? null
    }
  } else {
    const corrections = await server.ssrLoadModule('/src/lib/spellingCorrections.ts')
    const { EditorState } = await import(pathToFileURL(path.join(appRoot, 'node_modules', '@codemirror', 'state', 'dist', 'index.js')).href)
    await corrections.primeSpellingCorrections()
    analyze = async (note) => {
      const result = await spelling.checkSpelling({ segments: toSegments(note.text), document: textSource(note.text) })
      return {
        errors: result.errors,
        passages: result.passages,
        languages: result.languages,
        languageAt: (position) => result.passages.find((passage) => position >= passage.from && position < passage.to)?.language ?? null,
        confidentAt: (position) => Boolean(result.passages.find((passage) => position >= passage.from && position < passage.to)?.confident),
      }
    }
    autocorrect = async (text, start, end) => {
      // The editor's own decision for the word ending at `end` of the text typed so far.
      const typed = text.slice(0, end)
      const pass = await spelling.checkSpelling({ segments: toSegments(typed), cursorPositions: [end], document: textSource(typed) })
      let state = EditorState.create({ doc: typed, extensions: [corrections.languageProfileField] })
      state = state.update({ effects: corrections.setLanguageProfile.of(pass.profile) }).state
      const plan = await corrections.planAutocorrectAt(state, end)
      return plan?.replacement ?? null
    }
  }

  /* ---------- measure ---------- */

  const total = { words: 0, falseFlags: 0, typos: 0, typosCaught: 0, frenchTypos: 0, frenchTyposCaught: 0, fixed: 0, wrongFix: 0, falseAutocorrects: 0, unsafeAutocorrects: 0, unsupportedUnderlined: 0, passages: 0, passagesRight: 0 }
  const problems = { falseFlags: [], falseAutocorrects: [], wrongFix: [], missed: [], passages: [] }
  const overlaps = (from, to, other) => from < other.to && to > other.from
  for (const note of notes) {
    const analysis = await analyze(note)
    const inUnsupported = (from, to) => note.unsupported.some((range) => overlaps(from, to, range))
    // Underlines on words that are right.
    for (const match of note.text.matchAll(/\p{L}[\p{L}\p{M}'’-]*/gu)) {
      const from = match.index
      const to = from + match[0].length
      if (note.typos.some((typo) => overlaps(from, to, typo))) continue
      if (match[0].length < 2) continue
      total.words += 1
      const flagged = analysis.errors.some((error) => overlaps(from, to, error))
      if (inUnsupported(from, to)) {
        if (flagged) total.unsupportedUnderlined += 1
        continue
      }
      if (flagged) {
        total.falseFlags += 1
        problems.falseFlags.push(`${note.name}: ${match[0]}`)
      }
    }
    for (const typo of note.typos) {
      total.typos += 1
      const inFrench = typo.language === 'fr'
      const caught = analysis.errors.some((error) => overlaps(typo.from, typo.to, error))
      if (caught) total.typosCaught += 1
      else problems.missed.push(`${note.name}: ${typo.typo}`)
      if (inFrench) {
        total.frenchTypos += 1
        if (caught) total.frenchTyposCaught += 1
      }
    }
    // Replay the typing: every word of the note, in order.
    for (const match of note.text.matchAll(LETTER_RUN)) {
      const start = match.index
      const end = start + match[0].length
      if (match[0].length < 2) continue
      const replacement = await autocorrect(note.text, start, end)
      const typo = note.typos.find((candidate) => candidate.from === start && candidate.to === end)
      if (inUnsupported(start, end)) {
        if (replacement) {
          total.unsafeAutocorrects += 1
          problems.falseAutocorrects.push(`${note.name}: ${match[0]} → ${replacement} (unsupported language)`)
        }
        continue
      }
      if (typo) {
        if (process.env.FANOTES_SPELL_VERBOSE) console.log(`typo ${typo.typo} → ${replacement ?? 'left underlined'} (fix ${typo.fix})`)
        if (replacement === typo.fix) total.fixed += 1
        else if (replacement) {
          total.wrongFix += 1
          problems.wrongFix.push(`${note.name}: ${typo.typo} → ${replacement} (expected ${typo.fix})`)
        }
      } else if (replacement) {
        total.falseAutocorrects += 1
        problems.falseAutocorrects.push(`${note.name}: ${match[0]} → ${replacement}`)
      }
    }
    // Language per annotated passage.
    for (const passage of note.passages) {
      total.passages += 1
      const language = analysis.languageAt?.(passage.from + 1)
      const right = passage.language === 'unsure' ? !analysis.confidentAt?.(passage.from + 1) : language === passage.language
      if (right) total.passagesRight += 1
      else problems.passages.push(`${note.name}: "${passage.text}" is ${language ?? 'unknown'}, expected ${passage.language}`)
    }
  }

  console.log(JSON.stringify({ implementation: baseline ? 'before' : 'after', ...total }, null, 2))
  for (const [kind, list] of Object.entries(problems)) if (list.length) console.log(`${kind} (${list.length}):\n  ${list.join('\n  ')}`)

  if (!baseline) {
    assert.equal(total.falseFlags, 0, `no correct word is underlined: ${problems.falseFlags.join('; ')}`)
    assert.equal(total.falseAutocorrects + total.unsafeAutocorrects, 0, `no correct or foreign word is autocorrected: ${problems.falseAutocorrects.join('; ')}`)
    assert.equal(total.wrongFix, 0, `autocorrect never picks a wrong word: ${problems.wrongFix.join('; ')}`)
    assert.equal(total.typosCaught, total.typos, `every typo is underlined: ${problems.missed.join('; ')}`)
    assert.equal(total.frenchTyposCaught, total.frenchTypos, 'every French typo is underlined')
    assert.ok(total.frenchTypos >= 5, 'the corpus holds French typos')
    assert.equal(total.passagesRight, total.passages, `every annotated passage gets its language: ${problems.passages.join('; ')}`)
    assert.equal(total.unsupportedUnderlined, 0, 'an unsupported language is not underlined')
    assert.ok(total.fixed >= 6, `confident passages still get their typos corrected (${total.fixed})`)
    console.log('spelling-languages ok')
  }
} finally {
  await server.close()
}
