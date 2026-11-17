// Style hints (never applied automatically, off per category): filler words,
// repeated words close together, long sentences, passive voice (English),
// and readability figures for a scene or chapter.
import type { StoryLanguage } from '../model/types'
import type { Issue } from './rules'

const FILLERS_DE = ['eigentlich', 'halt', 'irgendwie', 'quasi', 'sozusagen', 'ziemlich', 'wirklich', 'gewissermaßen', 'gewissermassen', 'durchaus', 'tatsächlich', 'letztendlich', 'schlussendlich', 'grundsätzlich', 'praktisch', 'regelrecht', 'echt', 'total', 'voll', 'irgendwo', 'gewissermaßen', 'relativ', 'eher', 'etwas', 'ein bisschen', 'irgendwann', 'im Grunde', 'an sich']
const FILLERS_EN = ['very', 'really', 'just', 'quite', 'actually', 'basically', 'literally', 'totally', 'somewhat', 'rather', 'simply', 'pretty much', 'kind of', 'sort of', 'a bit', 'definitely', 'certainly', 'completely', 'absolutely', 'seemingly', 'slightly']

const STOP_DE = new Set(['auch', 'aber', 'doch', 'nach', 'oder', 'sein', 'seit', 'hier', 'denn', 'mehr', 'ganz', 'wird', 'sind', 'habe', 'will', 'muss', 'kann', 'kein', 'alle', 'dort', 'dies', 'mich', 'dich', 'sich', 'ihre', 'ihren', 'ihm', 'ihn', 'eins', 'zwei', 'drei', 'heute', 'jetzt', 'damit', 'darauf', 'davon', 'dabei', 'schon', 'nur', 'der', 'die', 'das', 'und', 'ist', 'nicht', 'eine', 'einen', 'einem', 'einer', 'eines', 'ihre', 'ihren', 'seine', 'seinen', 'diese', 'dieser', 'dieses', 'wurde', 'wurden', 'haben', 'hatte', 'hatten', 'werden', 'würde', 'konnte', 'könnte', 'sagte', 'aber', 'schon', 'noch', 'doch', 'immer', 'wieder', 'nichts', 'etwas', 'wenn', 'dann', 'weil', 'dass', 'durch', 'gegen', 'unter', 'über', 'zwischen', 'ihnen', 'ihrer', 'meine', 'meinen', 'deine', 'unsere', 'alles', 'allem', 'einmal', 'während'])
const STOP_EN = new Set(['your', 'some', 'like', 'been', 'only', 'over', 'also', 'back', 'very', 'much', 'even', 'more', 'most', 'such', 'here', 'down', 'come', 'came', 'went', 'make', 'made', 'know', 'knew', 'well', 'will', 'shall', 'must', 'each', 'both', 'many', 'once', 'upon', 'onto', 'away', 'still', 'the', 'and', 'that', 'with', 'they', 'there', 'their', 'them', 'have', 'from', 'were', 'what', 'when', 'would', 'could', 'should', 'which', 'about', 'into', 'than', 'then', 'this', 'these', 'those', 'said', 'just', 'only', 'other', 'again', 'after', 'before', 'where', 'while', 'because', 'through', 'nothing', 'something', 'everything', 'himself', 'herself', 'itself', 'themselves'])

const IRREGULAR_PARTICIPLES = 'been|done|made|seen|given|taken|known|shown|told|found|left|kept|held|brought|bought|caught|taught|thought|built|sent|spent|lost|meant|paid|put|read|said|set|shut|sold|stood|struck|understood|won|written|driven|eaten|fallen|forgotten|frozen|gotten|hidden|ridden|risen|shaken|spoken|stolen|sworn|thrown|woken|worn|broken|chosen|beaten|bitten|blown|drawn|flown|grown|torn|shot|hit|hurt|cut|led|fed|fought|felt|heard|hung|laid|lit|met'

const words = (text: string) => [...text.matchAll(/[\p{L}][\p{L}'’-]*/gu)].map((match) => ({ word: match[0], from: match.index!, to: match.index! + match[0].length }))

export type StyleOptions = {
  fillers: boolean
  repetition: boolean
  longSentences: boolean
  passive: boolean
  /** Words in a sentence before it counts as long. */
  longSentenceWords: number
  /** Distance in words within which a repeated word is flagged. */
  repetitionWindow: number
}

export const defaultStyleOptions = (): StyleOptions => ({ fillers: false, repetition: false, longSentences: false, passive: false, longSentenceWords: 35, repetitionWindow: 50 })

const msg = (de: string, en: string) => ({ de, en })

export const checkStyle = (text: string, language: StoryLanguage, options: StyleOptions): Issue[] => {
  const german = language.startsWith('de')
  const issues: Issue[] = []
  if (options.fillers) {
    for (const filler of german ? FILLERS_DE : FILLERS_EN) {
      const pattern = new RegExp(`(?<![\\p{L}])${filler.replace(/ /gu, '\\s+')}(?![\\p{L}])`, 'giu')
      for (const match of text.matchAll(pattern)) issues.push({ from: match.index!, to: match.index! + match[0].length, rule: 'style-filler', category: 'style', message: msg(`Füllwort „${match[0]}“: braucht der Satz es?`, `Filler “${match[0]}”: does the sentence need it?`), replacements: [] })
    }
  }
  const list = words(text)
  if (options.repetition) {
    const stop = german ? STOP_DE : STOP_EN
    const last = new Map<string, number>()
    list.forEach((entry, index) => {
      const key = entry.word.toLocaleLowerCase(language).replace(/(?:en|es|e|er|s)$/u, '')
      if (entry.word.length < 4 || stop.has(entry.word.toLocaleLowerCase(language))) return
      const previous = last.get(key)
      if (previous !== undefined && index - previous <= options.repetitionWindow) {
        issues.push({ from: entry.from, to: entry.to, rule: 'style-repetition', category: 'style', message: msg(`„${entry.word}“ kommt kurz davor schon vor.`, `“${entry.word}” was used just before.`), replacements: [] })
      }
      last.set(key, index)
    })
  }
  if (options.longSentences) {
    const sentences = text.split(/(?<=[.!?…])\s+/u)
    let offset = 0
    for (const sentence of sentences) {
      const start = text.indexOf(sentence, offset)
      offset = start + sentence.length
      const count = (sentence.match(/[\p{L}\d]+/gu) ?? []).length
      if (count > options.longSentenceWords) issues.push({ from: start, to: start + sentence.length, rule: 'style-long-sentence', category: 'style', message: msg(`Langer Satz (${count} Wörter).`, `Long sentence (${count} words).`), replacements: [] })
    }
  }
  if (options.passive && !german) {
    const pattern = new RegExp(`\\b(?:am|is|are|was|were|be|been|being)\\s+(?:\\p{L}+ly\\s+)?(?:\\p{L}+ed|${IRREGULAR_PARTICIPLES})\\b`, 'giu')
    for (const match of text.matchAll(pattern)) issues.push({ from: match.index!, to: match.index! + match[0].length, rule: 'style-passive', category: 'style', message: msg('Passiv: aktiv wäre direkter.', 'Passive voice: active is often more direct.'), replacements: [] })
  }
  return issues
}

/** Syllables by vowel groups: good enough for readability scores. */
const syllables = (word: string, german: boolean) => {
  const lower = word.toLocaleLowerCase(german ? 'de-DE' : 'en-US')
  const groups = lower.match(german ? /[aeiouäöüy]+/gu : /[aeiouy]+/gu)?.length ?? 1
  const silentE = !german && /[^aeiouy]e$/u.test(lower) && groups > 1 ? 1 : 0
  return Math.max(1, groups - silentE)
}

export type Readability = { words: number; sentences: number; wordsPerSentence: number; syllablesPerWord: number; score: number; label: { de: string; en: string } }

/** Flesch reading ease (English) or Flesch–Amstad (German). */
export const readability = (text: string, language: StoryLanguage): Readability => {
  const german = language.startsWith('de')
  const list = words(text)
  const sentenceCount = Math.max(1, (text.match(/[.!?…]+(?=\s|$|[“”"»«’])/gu) ?? []).length)
  const syllableCount = list.reduce((sum, entry) => sum + syllables(entry.word, german), 0)
  const wordCount = Math.max(1, list.length)
  const asl = wordCount / sentenceCount
  const asw = syllableCount / wordCount
  const score = Math.max(0, Math.min(100, german ? 180 - asl - 58.5 * asw : 206.835 - 1.015 * asl - 84.6 * asw))
  const label = score >= 80 ? msg('sehr leicht', 'very easy') : score >= 60 ? msg('leicht bis mittel', 'easy to standard') : score >= 40 ? msg('anspruchsvoll', 'fairly difficult') : msg('schwer', 'difficult')
  return { words: list.length, sentences: sentenceCount, wordsPerSentence: asl, syllablesPerWord: asw, score: Math.round(score), label }
}
