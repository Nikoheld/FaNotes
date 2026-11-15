// Grammar, punctuation and typography checks for German and English prose.
// Every rule is written for precision: in a story a false alarm costs more
// than a missed one, so ambiguous patterns are left alone. Each rule has an
// id (to switch it off or ignore it), a category and a message in both
// languages, and optionally replacements the writer can apply.
import type { StoryLanguage } from '../model/types'
import { startsSentence } from './typography'

export type IssueCategory = 'spelling' | 'grammar' | 'punctuation' | 'typography' | 'style'

export type Issue = {
  from: number
  to: number
  rule: string
  category: IssueCategory
  message: { de: string; en: string }
  replacements: string[]
}

type Match = Omit<Issue, 'rule' | 'category' | 'message'> & { message?: Issue['message'] }
type Rule = {
  id: string
  languages: Array<'de' | 'en'>
  category: IssueCategory
  message: Issue['message']
  /** Swiss German only. */
  swissOnly?: boolean
  check: (text: string, language: StoryLanguage) => Match[]
}

const family = (language: StoryLanguage) => (language.startsWith('de') ? 'de' : 'en') as 'de' | 'en'

const all = (pattern: RegExp, text: string, build: (match: RegExpExecArray) => Match | null) => {
  const out: Match[] = []
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    if (match[0].length === 0) { regex.lastIndex += 1; continue }
    const value = build(match)
    if (value) out.push(value)
  }
  return out
}

const keepCase = (template: string, replacement: string) => (/^\p{Lu}/u.test(template) ? replacement[0].toLocaleUpperCase('de-DE') + replacement.slice(1) : replacement)

const SAYING_DE = 'glaube|glaubte|glaubst|denke|dachte|denkst|weiß|weiss|wusste|wusstest|hoffe|hoffte|hoffst|sagte|sagt|sage|sagst|meint|meinte|meine|finde|fand|fürchte|fürchtete|vermute|vermutete|merkte|bemerkte|ahnte|ahne|spürte|sah|hörte|erfuhr|zeigt|zeigte|bedeutet|bedeutete|heißt|heisst|behauptet|behauptete|versprach|verspricht|schwor|erklärte|erklärt|wünsche|wünschte|befürchte|bezweifle|bezweifelte|vergaß|vergass|vergiss|klar|sicher|möglich|wahrscheinlich|unwahrscheinlich|wichtig|schade|gut|froh|stolz|überzeugt|sicherlich'
const SUBORDINATORS_DE = 'dass|weil|obwohl|obgleich|nachdem|sodass|falls|indem|sobald|wenn|ob'
const NO_COMMA_BEFORE_DE = new Set(['und', 'oder', 'aber', 'sondern', 'als', 'so', 'auch', 'nur', 'schon', 'noch', 'selbst', 'gerade', 'erst', 'außer', 'ausser', 'sowie', 'wie', 'bloss', 'bloß', 'eben', 'besonders', 'vor', 'allem', 'zumal', 'ohne', 'statt', 'anstatt', 'egal', 'gleich', 'gerade', 'weder', 'sowohl', 'je', 'jetzt', 'nun', 'dann', 'ausgerechnet', 'insbesondere'])
const COMPARATIVES_DE = 'grösser|größer|kleiner|besser|schlechter|mehr|weniger|älter|jünger|länger|kürzer|schneller|langsamer|höher|tiefer|schöner|lieber|früher|später|stärker|schwächer|weiter|näher|leichter|schwerer|anders|eher|öfter|lauter|leiser|heller|dunkler|wärmer|kälter|klüger|dümmer|reicher|ärmer'
const COMPARATIVES_EN = 'more|less|better|worse|rather|other|larger|smaller|bigger|older|younger|faster|slower|higher|lower|longer|shorter|stronger|weaker|easier|harder|greater|fewer|further|farther|sooner|later|louder|quieter|darker|brighter|happier|sadder|richer|poorer|smarter|wiser|closer'

const RULES: Rule[] = [
  // ── Typography (both) ──
  {
    id: 'straight-quote', languages: ['de', 'en'], category: 'typography',
    message: { de: 'Gerade Anführungszeichen statt typografischer.', en: 'Straight quotation mark instead of a typographic one.' },
    check: (text, language) => all(/"/u, text, (match) => {
      const opening = match.index === 0 || /[\s(\[–—-]/u.test(text[match.index - 1])
      const glyphs = { de: ['„', '“'], 'de-CH': ['«', '»'], 'en-US': ['“', '”'], 'en-GB': ['‘', '’'] }[language]
      return { from: match.index, to: match.index + 1, replacements: [opening ? glyphs[0] : glyphs[1]] }
    }),
  },
  {
    id: 'ellipsis', languages: ['de', 'en'], category: 'typography',
    message: { de: 'Drei Punkte: Auslassungszeichen (…) verwenden.', en: 'Three dots: use an ellipsis (…).' },
    check: (text) => all(/\.\.\.(?!\.)/u, text, (match) => ({ from: match.index, to: match.index + 3, replacements: ['…'] })),
  },
  {
    id: 'spaced-hyphen', languages: ['de', 'en'], category: 'typography',
    message: { de: 'Bindestrich als Gedankenstrich: Halbgeviertstrich (–) verwenden.', en: 'Hyphen used as a dash: use a dash.' },
    check: (text, language) => all(/(?<=\S) - (?=\S)/u, text, (match) => ({ from: match.index, to: match.index + 3, replacements: [language === 'en-US' ? '—' : ' – '] })),
  },
  {
    id: 'double-space', languages: ['de', 'en'], category: 'typography',
    message: { de: 'Mehrere Leerzeichen hintereinander.', en: 'Several spaces in a row.' },
    check: (text) => all(/(?<=\S) {2,}(?=\S)/u, text, (match) => ({ from: match.index, to: match.index + match[0].length, replacements: [' '] })),
  },
  {
    id: 'space-before-punctuation', languages: ['de', 'en'], category: 'punctuation',
    message: { de: 'Kein Leerzeichen vor dem Satzzeichen.', en: 'No space before the punctuation mark.' },
    check: (text) => all(/(?<=[\p{L}\d])\s+(?=[,.;:!?](?:\s|$|[“”"»«’]))/u, text, (match) => ({ from: match.index, to: match.index + match[0].length, replacements: [''] })),
  },
  {
    id: 'missing-space-after-punctuation', languages: ['de', 'en'], category: 'punctuation',
    message: { de: 'Nach dem Satzzeichen fehlt ein Leerzeichen.', en: 'A space is missing after the punctuation mark.' },
    // ",Wort" and "Satz.Neuer" but not 3.5, z.B., www.x.de, Mr.X in names, or "…?!".
    check: (text) => all(/(?<=\p{L}\p{Ll})([,;!?])(?=\p{L})|(?<=\p{Ll}{3})\.(?=\p{Lu}\p{Ll})/u, text, (match) => {
      const around = text.slice(Math.max(0, match.index - 20), match.index + 20)
      if (/(?:https?:|www\.|@|\.[a-z]{2,4}\b)/iu.test(around)) return null
      return { from: match.index, to: match.index + 1, replacements: [`${match[0]} `] }
    }),
  },
  {
    id: 'repeated-word', languages: ['de', 'en'], category: 'grammar',
    message: { de: 'Wort doppelt.', en: 'Word repeated.' },
    check: (text, language) => all(/(?<![\p{L}])(\p{L}+)\s+(\1)(?![\p{L}])/iu, text, (match) => {
      const word = match[1].toLocaleLowerCase(language)
      // "Die Frau, die die Tür öffnete" and "Das, das das…" are correct German.
      if (family(language) === 'de' && ['die', 'der', 'das', 'den', 'dem', 'des'].includes(word)) return null
      if (family(language) === 'en' && ['that', 'had', 'is'].includes(word)) return null
      const second = match.index + match[0].length - match[2].length
      return { from: match.index + match[1].length, to: second + match[2].length, replacements: [''] }
    }),
  },
  {
    id: 'sentence-start-lowercase', languages: ['de', 'en'], category: 'grammar',
    message: { de: 'Satzanfang klein geschrieben.', en: 'Sentence starts with a lower-case letter.' },
    check: (text, language) => all(/(?<=[.!?][“”"»«’']?\s+)(\p{Ll}[\p{L}]*)/u, text, (match) => {
      if (!startsSentence(text, match.index)) return null
      if (/^(?:iPhone|iPad|eBay|e-?mail)/u.test(match[1])) return null
      return { from: match.index, to: match.index + 1, replacements: [match[1][0].toLocaleUpperCase(language)] }
    }),
  },

  // ── German ──
  {
    id: 'de-das-dass', languages: ['de'], category: 'grammar',
    message: { de: '„dass“ (Konjunktion) statt „das“?', en: '“dass” (conjunction) rather than “das”?' },
    check: (text) => [
      ...all(new RegExp(`\\b(?:${SAYING_DE}),\\s+(das)\\b`, 'iu'), text, (match) => {
        const at = match.index + match[0].length - 3
        return { from: at, to: at + 3, replacements: ['dass'] }
      }),
      ...all(/\b(so)\s+(das)\s+(?=\p{Ll})/iu, text, (match) => ({ from: match.index, to: match.index + match[1].length + 1 + match[2].length, replacements: ['sodass', 'so dass'] })),
    ],
  },
  {
    id: 'de-seit-seid', languages: ['de'], category: 'grammar',
    message: { de: '„seit“ (Zeit) und „seid“ (Verb) verwechselt.', en: '“seit” (since) and “seid” (are) mixed up.' },
    check: (text) => [
      ...all(/\b(ihr)\s+(seit)\b/iu, text, (match) => { const at = match.index + match[0].length - 4; return { from: at, to: at + 4, replacements: ['seid'] } }),
      ...all(/\b([Ss]eid)\s+(?=(?:dem|der|langem|kurzem|gestern|heute|vorgestern|Jahren|Monaten|Wochen|Tagen|Stunden|Minuten|Sekunden|Ewigkeiten|einer|einem|\d)\b)/u, text, (match) => ({ from: match.index, to: match.index + 4, replacements: [keepCase(match[1], 'seit')] })),
    ],
  },
  {
    id: 'de-wider-wieder', languages: ['de'], category: 'grammar',
    message: { de: '„wider“ (gegen) und „wieder“ (nochmals) verwechselt.', en: '“wider” (against) and “wieder” (again) mixed up.' },
    check: (text) => all(/\b(wieder)(\s+Willen|stand|spruch|sprechen|sprach|spiegel(?:n|t|te)?|wärtig|fahren|fuhr|setzen|setzte|rufen|rief|legen|legte)\b/iu, text, (match) => ({ from: match.index, to: match.index + match[0].length, replacements: [keepCase(match[1], 'wider') + match[2]] })),
  },
  {
    id: 'de-comma-subordinate', languages: ['de'], category: 'punctuation',
    message: { de: 'Vor dem Nebensatz fehlt vermutlich ein Komma.', en: 'A comma is probably missing before the subordinate clause.' },
    check: (text) => all(new RegExp(`(?<=[\\p{L}])(\\s+)(${SUBORDINATORS_DE})\\b(?=\\s+\\p{L})`, 'u'), text, (match) => {
      const before = text.slice(0, match.index)
      const previousWord = /(\p{L}+)$/u.exec(before)?.[1]?.toLocaleLowerCase('de-DE') ?? ''
      if (NO_COMMA_BEFORE_DE.has(previousWord)) return null
      // Needs two words of its own clause before it; a conjunction at the start of a sentence takes no comma.
      const clause = before.split(/[.!?;:,–—„“"«»()]/u).at(-1) ?? ''
      if ((clause.match(/\p{L}+/gu) ?? []).length < 2) return null
      if (match[2].toLocaleLowerCase('de-DE') === 'ob' && previousWord === 'als') return null
      return { from: match.index, to: match.index + match[1].length, replacements: [', '] }
    }),
  },
  {
    id: 'de-comma-sondern', languages: ['de'], category: 'punctuation',
    message: { de: 'Vor „sondern“ steht ein Komma.', en: 'A comma goes before “sondern”.' },
    check: (text) => all(/(?<=\p{L})(\s+)(sondern)\b/u, text, (match) => ({ from: match.index, to: match.index + match[1].length, replacements: [', '] })),
  },
  {
    id: 'de-als-wie', languages: ['de'], category: 'grammar',
    message: { de: 'Nach einem Komparativ steht „als“, nicht „wie“.', en: 'After a comparative German uses “als”, not “wie”.' },
    check: (text) => all(new RegExp(`\\b(?:${COMPARATIVES_DE})\\s+(wie)\\b`, 'iu'), text, (match) => { const at = match.index + match[0].length - 3; return { from: at, to: at + 3, replacements: ['als'] } }),
  },
  {
    id: 'de-noun-after-preposition-article', languages: ['de'], category: 'grammar',
    message: { de: 'Substantivierung: gross schreiben.', en: 'Nominalised verb: capitalise.' },
    check: (text) => all(/\b([Bb]eim|[Zz]um|[Vv]om|[Ii]m|[Aa]m)\s+(\p{Ll}\p{Ll}+en)\b(?!\s+(?:und|oder|ist|war|wird|sind|waren|werden|hat|haben|hatte)\b\s+\p{Ll})/u, text, (match) => {
      if (/^(?:ganzen|besten|meisten|liebsten|wenigsten|ehesten|schnellsten|letzten|ersten|anderen|nächsten|frühen|späten|kommenden|vergangenen|eigenen|großen|grossen|kleinen|offenen|ganzen|leeren)$/u.test(match[2])) return null
      const at = match.index + match[0].length - match[2].length
      return { from: at, to: at + 1, replacements: [match[2][0].toLocaleUpperCase('de-DE')] }
    }),
  },
  {
    id: 'de-noun-suffix-lowercase', languages: ['de'], category: 'grammar',
    message: { de: 'Substantiv klein geschrieben.', en: 'Noun written in lower case.' },
    check: (text) => all(/\b([Dd]er|[Dd]ie|[Dd]as|[Dd]en|[Dd]em|[Dd]es|[Ee]in|[Ee]ine|[Ee]inen|[Ee]inem|[Ee]iner|[Ee]ines|[Kk]ein|[Kk]eine|[Mm]eine|[Dd]eine|[Ss]eine|[Ii]hre|[Uu]nsere|[Ee]ure|[Dd]iese|[Dd]ieser|[Jj]ene)\s+(\p{Ll}\p{Ll}+(?:ung|heit|keit|schaft|tion|tät|nis|ling|ismus|ment|tum))\b/u, text, (match) => {
      const at = match.index + match[0].length - match[2].length
      return { from: at, to: at + 1, replacements: [match[2][0].toLocaleUpperCase('de-DE')] }
    }),
  },
  {
    id: 'de-abbreviation-space', languages: ['de'], category: 'typography',
    message: { de: 'Abkürzung mit schmalem Abstand: „z. B.“, „d. h.“', en: 'German abbreviation with a space: “z. B.”, “d. h.”' },
    check: (text) => all(/\b(z|d|u|o|v|s)\.(B|h|a|ä|Ä|g|l|u)\./u, text, (match) => ({ from: match.index, to: match.index + match[0].length, replacements: [`${match[1]}. ${match[2]}.`] })),
  },
  {
    id: 'de-apostrophe-genitive', languages: ['de'], category: 'grammar',
    message: { de: 'Genitiv ohne Apostroph: „Peters“, nicht „Peter’s“.', en: 'German genitive without an apostrophe: “Peters”, not “Peter’s”.' },
    check: (text) => all(/\b(\p{Lu}\p{Ll}+[^sßxz\s])['’]s\b/u, text, (match) => ({ from: match.index, to: match.index + match[0].length, replacements: [`${match[1]}s`] })),
  },
  {
    id: 'de-quote-balance', languages: ['de'], category: 'punctuation',
    message: { de: 'Anführungszeichen geöffnet, aber nicht geschlossen.', en: 'Quotation opened but not closed.' },
    check: (text, language) => {
      const [open, close] = language === 'de-CH' ? ['«', '»'] : ['„', '“']
      let depth = 0
      let last = -1
      for (let index = 0; index < text.length; index += 1) {
        if (text[index] === open) { depth += 1; last = index }
        else if (text[index] === close && depth > 0) depth -= 1
      }
      // Dialogue that runs on into the next paragraph is allowed: only flag when a later opener appears unclosed.
      return depth > 1 ? [{ from: last, to: last + 1, replacements: [] }] : []
    },
  },
  {
    id: 'de-ch-eszett', languages: ['de'], category: 'typography', swissOnly: true,
    message: { de: 'In der Schweiz: „ss“ statt „ß“.', en: 'Swiss German: “ss” instead of “ß”.' },
    check: (text) => all(/\p{L}*ß\p{L}*/u, text, (match) => ({ from: match.index, to: match.index + match[0].length, replacements: [match[0].replace(/ß/gu, 'ss')] })),
  },

  // ── English ──
  {
    id: 'en-a-an', languages: ['en'], category: 'grammar',
    message: { de: '„a“/„an“ passt nicht zum folgenden Laut.', en: '“a”/“an” does not match the following sound.' },
    check: (text) => all(/\b(a|an|A|An)\s+([\p{L}\d][\p{L}\d'-]*)/u, text, (match) => {
      // Abbreviations are read letter by letter (an SOS, an HR manager); leave them to the writer.
      if (/^[A-Z0-9]{2,6}$/u.test(match[2])) return null
      const word = match[2].toLowerCase()
      const vowelSound = /^(?:[aeio]|u(?!ni|se|su|tu|re|ro|ra|ku|ki)|hour|honest|honou?r|heir|herb(?!al)|8|11|18|x-?ray|mba|mri|fbi|fda|nba|nhl|hdmi|html|sql|ssd|lcd|led|rsvp|mp3)/u.test(word) && !/^(?:one|once|eu|ewe|uni|usu|use|usa|ur[aio]|ufo|ukr)/u.test(word)
      const article = match[1].toLowerCase()
      if (article === 'a' && vowelSound) return { from: match.index, to: match.index + match[1].length, replacements: [match[1] === 'A' ? 'An' : 'an'] }
      if (article === 'an' && !vowelSound && /^\p{L}/u.test(word)) return { from: match.index, to: match.index + match[1].length, replacements: [match[1] === 'An' ? 'A' : 'a'] }
      return null
    }),
  },
  {
    id: 'en-its', languages: ['en'], category: 'grammar',
    message: { de: '„its“ (sein) und „it’s“ (es ist) verwechselt.', en: '“its” (possessive) and “it’s” (it is) mixed up.' },
    check: (text) => [
      ...all(/\b(its)\s+(?=(?:a|an|the|been|not|going|time|okay|ok|so|too|very|just|still|really|getting|almost|always|never|only|probably)\b)/iu, text, (match) => ({ from: match.index, to: match.index + 3, replacements: [keepCase(match[1], 'it’s')] })),
      ...all(/\b(it['’]s)\s+(?=own\b)/iu, text, (match) => ({ from: match.index, to: match.index + match[1].length, replacements: [keepCase(match[1], 'its')] })),
    ],
  },
  {
    id: 'en-your', languages: ['en'], category: 'grammar',
    message: { de: '„your“ (dein) und „you’re“ (du bist) verwechselt.', en: '“your” and “you’re” mixed up.' },
    check: (text) => all(/\b(your)\s+(?=(?:a|an|the|welcome|not|going|so|very|too|right|wrong|being|doing|getting|making|always|never|probably|kidding|joking|sure|late|early)\b)/iu, text, (match) => ({ from: match.index, to: match.index + 4, replacements: [keepCase(match[1], 'you’re')] })),
  },
  {
    id: 'en-their-there', languages: ['en'], category: 'grammar',
    message: { de: '„their“ und „there“ verwechselt.', en: '“their” and “there” mixed up.' },
    check: (text) => all(/\b(their)\s+(?=(?:is|are|was|were|will be|has been|have been)\b)/iu, text, (match) => ({ from: match.index, to: match.index + 5, replacements: [keepCase(match[1], 'there')] })),
  },
  {
    id: 'en-could-of', languages: ['en'], category: 'grammar',
    message: { de: '„could have“, nicht „could of“.', en: '“could have”, not “could of”.' },
    check: (text) => all(/\b(could|should|would|must|might)\s+(of)\b/iu, text, (match) => { const at = match.index + match[0].length - 2; return { from: at, to: at + 2, replacements: ['have'] } }),
  },
  {
    id: 'en-then-than', languages: ['en'], category: 'grammar',
    message: { de: 'Nach einem Komparativ steht „than“.', en: 'After a comparative use “than”.' },
    check: (text) => all(new RegExp(`\\b(?:${COMPARATIVES_EN})\\s+(then)\\b`, 'iu'), text, (match) => { const at = match.index + match[0].length - 4; return { from: at, to: at + 4, replacements: ['than'] } }),
  },
  {
    id: 'en-lowercase-i', languages: ['en'], category: 'grammar',
    message: { de: '„I“ wird gross geschrieben.', en: '“I” is always capitalised.' },
    check: (text) => all(/(?<![\p{L}'’])i(?=(?:['’](?:m|ve|ll|d))?(?![\p{L}'’]))/u, text, (match) => ({ from: match.index, to: match.index + 1, replacements: ['I'] })),
  },
]

export const RULE_IDS = RULES.map((rule) => rule.id)

export type RuleOptions = { disabled?: ReadonlySet<string> }

/** All grammar, punctuation and typography issues of a paragraph. */
export const checkRules = (text: string, language: StoryLanguage, options: RuleOptions = {}): Issue[] => {
  const lang = family(language)
  const issues: Issue[] = []
  for (const rule of RULES) {
    if (!rule.languages.includes(lang) || options.disabled?.has(rule.id)) continue
    if (rule.swissOnly && language !== 'de-CH') continue
    for (const match of rule.check(text, language)) issues.push({ ...match, rule: rule.id, category: rule.category, message: match.message ?? rule.message })
  }
  return issues.sort((left, right) => left.from - right.from || left.to - right.to)
}
