import type { DetectedTextLanguage, TextLanguage } from '../types'

/**
 * Language detection for the spellchecker and autocorrect. Pure logic: callers hand in the words
 * of a passage together with what the dictionaries know about each of them, so the same code
 * runs in the editor, in the check scripts and (later) in a worker.
 *
 * Three levels of evidence decide the language of a passage (a sentence, list item, table cell,
 * one side of a vocabulary line "le chien – der Hund", or a quotation):
 *   1. the passage itself (stopwords, words only one dictionary knows, diacritics),
 *   2. its paragraph neighbours,
 *   3. the language profile of the whole note.
 * A passage with strong local evidence ignores the rest; a single word or a heading falls back to
 * the neighbours and the profile. Autocorrect only acts on a passage whose language is confident.
 */

export type LanguageEvidence = { de: number; en: number; fr: number }
export type WordLanguages = { de: boolean; en: boolean; fr: boolean }
export type EvidenceToken = { word: string; normalized: string; membership: WordLanguages }

export const TEXT_LANGUAGES: readonly TextLanguage[] = ['de', 'en', 'fr']

export const emptyEvidence = (): LanguageEvidence => ({ de: 0, en: 0, fr: 0 })
export const addEvidence = (target: LanguageEvidence, source: LanguageEvidence, weight = 1): LanguageEvidence => {
  target.de += source.de * weight
  target.en += source.en * weight
  target.fr += source.fr * weight
  return target
}
export const evidenceTotal = (evidence: LanguageEvidence) => evidence.de + evidence.en + evidence.fr

/* ---------- stopwords ---------- */

const words = (list: string) => list.split(/\s+/u).filter(Boolean)

const DE_STOPWORDS = words(`aber als auch auf aus bei das dem den der des die ein eine einer eines einem einen für hat haben hatte
  ich im in ist mit nicht oder sich sie sind und von war waren werden wird wie wir zu zum zur es er du ihr
  wenn dass weil was wer wo noch nur schon sehr mehr dann doch also man kein keine über unter nach vor bis
  mein dein sein unser euer mich dich uns euch mir dir ihm ihn hier dort heute morgen bin bist seid kann
  können muss müssen soll will wurde wurden gibt gab im am vom beim ins ans aufs`)
const EN_STOPWORDS = words(`a an and are as at be by for from has have had he in is it not of on or she that the this to was we were
  will with you i they them their your my his her its our do does did if so than then there here what which who
  when where how can could would should been being am no yes but about into out up all some any more most
  very just also only over after before because while these those`)
const FR_STOPWORDS = words(`le la les un une des de du et ou mais donc car ni que qui quoi dont où je tu il elle on nous vous ils
  elles me te se lui leur y en mon ton son ma ta sa mes tes ses notre votre nos vos leurs ce cet cette ces
  est suis es sommes êtes sont été était étaient ai as a avons avez ont pas ne plus jamais rien dans sur sous
  avec sans pour par chez entre vers au aux très bien aussi comme tout tous toute toutes si cela ça ceci
  quand pourquoi comment alors depuis pendant avant après non oui peu beaucoup déjà encore toujours`)
// Languages the app has no dictionary for. Their stopwords only serve to recognise such a passage
// as "unsupported", so it is neither underlined nor autocorrected.
const OTHER_STOPWORDS = words(`il lo gli di che è e al sul dal nei sono non per con una uno della delle dei degli nel nella questo questa
  molto anche come più ma mi ti ci vi sei siamo siete ho hai ha abbiamo hanno io lui lei noi voi loro cosa sì quando dove
  perché se bene grazie prego ciao buongiorno buonasera oggi domani ieri stai sto sta casa vicino grande piccolo
  el los las del y es por para muy pero más esta este está tiene tengo soy eres somos yo tú él ella
  nosotros también cuando donde porque hola gracias buenos días o os um uma não são você nós isso muito mas
  het een van dat niet zijn voor met ook maar naar dit wat ik je ze wij`)

type StopwordWeights = { de?: number; en?: number; fr?: number; other?: number }
const STOPWORDS = (() => {
  const sets: Array<[keyof StopwordWeights, string[]]> = [['de', DE_STOPWORDS], ['en', EN_STOPWORDS], ['fr', FR_STOPWORDS], ['other', OTHER_STOPWORDS]]
  const owners = new Map<string, Array<keyof StopwordWeights>>()
  for (const [name, list] of sets) for (const word of list) owners.set(word, [...(owners.get(word) ?? []), name])
  // A stopword two languages share ("in", "a", "des", "son") is split between them instead of
  // counting fully for both.
  const table = new Map<string, StopwordWeights>()
  for (const [word, names] of owners) {
    const weights: StopwordWeights = {}
    for (const name of names) weights[name] = 3 / names.length
    table.set(word, weights)
  }
  return table
})()

const FRENCH_ELISION = /^(?:[cdjlmnst]|qu|jusqu|lorsqu|puisqu|quoiqu)['’]\p{L}/u
// "è" is left out on purpose: Italian uses it as much as French does.
const FRENCH_LETTERS = /[éêàçœâîôûùëï]/u
const GERMAN_LETTERS = /[äöüß]/u

/* ---------- scoring ---------- */

export type PassageScore = {
  evidence: LanguageEvidence
  /** The stopword part of `evidence`, plus the stopwords of unsupported languages. */
  stopwords: LanguageEvidence & { other: number }
  words: number
  /** Words no dictionary knows. */
  unknown: number
}

export const emptyScore = (): PassageScore => ({
  evidence: emptyEvidence(),
  stopwords: { de: 0, en: 0, fr: 0, other: 0 },
  words: 0,
  unknown: 0,
})

export const mergeScores = (left: PassageScore, right: PassageScore): PassageScore => ({
  evidence: addEvidence(addEvidence(emptyEvidence(), left.evidence), right.evidence),
  stopwords: {
    de: left.stopwords.de + right.stopwords.de,
    en: left.stopwords.en + right.stopwords.en,
    fr: left.stopwords.fr + right.stopwords.fr,
    other: left.stopwords.other + right.stopwords.other,
  },
  words: left.words + right.words,
  unknown: left.unknown + right.unknown,
})

export const scoreTokens = (tokens: readonly EvidenceToken[]): PassageScore => {
  const score = emptyScore()
  for (const token of tokens) {
    score.words += 1
    const stop = STOPWORDS.get(token.normalized)
    if (stop) {
      for (const language of TEXT_LANGUAGES) {
        const weight = stop[language] ?? 0
        score.evidence[language] += weight
        score.stopwords[language] += weight
      }
      score.stopwords.other += stop.other ?? 0
    }
    if (FRENCH_ELISION.test(token.normalized)) {
      score.evidence.fr += 3
      score.stopwords.fr += 3
    }
    const known = TEXT_LANGUAGES.filter((language) => token.membership[language])
    if (known.length === 1) score.evidence[known[0]] += 2
    else if (known.length === 2) for (const language of known) score.evidence[language] += 0.6
    else if (known.length === 0) score.unknown += 1
    // Typos keep their accents, so these cues also work for words no dictionary knows.
    if (FRENCH_LETTERS.test(token.word)) score.evidence.fr += 1.5
    if (GERMAN_LETTERS.test(token.word)) score.evidence.de += 1.5
  }
  return score
}

/* ---------- decisions ---------- */

const STRONG_MINIMUM = 4
const STRONG_RATIO = 2
const TENTATIVE_MINIMUM = 1.5
const TENTATIVE_RATIO = 1.35

export type LanguageDecision = { language: TextLanguage | null; confident: boolean }

export const decideLanguage = (evidence: LanguageEvidence): LanguageDecision => {
  const ranked = TEXT_LANGUAGES.map((language) => ({ language, value: evidence[language] })).sort((a, b) => b.value - a.value)
  const [top, second] = ranked
  if (top.value >= STRONG_MINIMUM && top.value >= second.value * STRONG_RATIO) return { language: top.language, confident: true }
  if (top.value >= TENTATIVE_MINIMUM && top.value >= second.value * TENTATIVE_RATIO) return { language: top.language, confident: false }
  return { language: null, confident: false }
}

export type PassageSource = 'local' | 'context' | 'document' | 'none'
export type PassageLanguage = {
  /** The language the passage is written in; null when it cannot be told. */
  language: TextLanguage | null
  /** True only when autocorrect may rely on `language`. */
  confident: boolean
  /** A language without dictionary (Italian, Spanish, ...): never underlined, never corrected. */
  unsupported: boolean
  /** Mostly words no dictionary knows (a name list, a foreign quotation): never autocorrected. */
  foreign: boolean
  source: PassageSource
}

export const UNKNOWN_PASSAGE: PassageLanguage = { language: null, confident: false, unsupported: false, foreign: false, source: 'none' }

export const isUnsupported = (score: PassageScore) => {
  const { stopwords } = score
  const known = Math.max(stopwords.de, stopwords.en, stopwords.fr)
  return score.words >= 2 && stopwords.other >= 4.5 && stopwords.other >= known * 2
}

/** Words two to three letters long are too ambiguous to call a passage "foreign". */
const isForeign = (score: PassageScore) => score.words >= 2 && score.unknown / score.words >= 0.6

export type ResolveContext = {
  /** Evidence of neighbouring lines of the same paragraph, already weighted. */
  neighbours?: LanguageEvidence
  /** Evidence of sibling passages in the same line that probably share the language (sentences). */
  siblings?: LanguageEvidence
  /** The prior of the whole note (`profilePrior`). */
  prior?: LanguageEvidence
  /** Languages of strong sibling passages in a vocabulary line: the other side is not that one. */
  partnerLanguages?: readonly TextLanguage[]
}

/** Decides one passage: its own words first, then paragraph and note context. */
export const resolvePassage = (score: PassageScore, context: ResolveContext = {}): PassageLanguage => {
  if (isUnsupported(score)) return { language: null, confident: false, unsupported: true, foreign: true, source: 'local' }
  const foreign = isForeign(score)
  const local = decideLanguage(score.evidence)
  if (local.confident) return { ...local, unsupported: false, foreign, source: 'local' }

  const combined = addEvidence(emptyEvidence(), score.evidence)
  if (context.neighbours) addEvidence(combined, context.neighbours)
  if (context.siblings) addEvidence(combined, context.siblings, 0.5)
  if (context.prior) addEvidence(combined, context.prior)
  const hasLocalOrContext = evidenceTotal(score.evidence) + (context.neighbours ? evidenceTotal(context.neighbours) : 0) > 0
  // "chat – die Katze": the two sides of a vocabulary pair are different languages, so what the
  // confident partner side speaks (and the neighbouring pairs echo) is no evidence for this side.
  for (const language of context.partnerLanguages ?? []) combined[language] *= 0.2
  const decision = decideLanguage(combined)
  return {
    ...decision,
    unsupported: false,
    foreign,
    source: decision.language ? (hasLocalOrContext ? 'context' : 'document') : 'none',
  }
}

/* ---------- the profile of a note ---------- */

const PRESENT_MINIMUM = 4
const PRESENT_SHARE = 0.04
const PRESENT_ABSOLUTE = 30
const PRIOR_POINTS = 5
const PRIOR_FULL_AT = 20

/** Languages the note uses, most used first. A language counts once it has real evidence and a few percent of the whole. */
export const presentLanguages = (profile: LanguageEvidence): TextLanguage[] => {
  const total = evidenceTotal(profile)
  return TEXT_LANGUAGES
    .filter((language) => profile[language] >= PRESENT_MINIMUM && (profile[language] >= total * PRESENT_SHARE || profile[language] >= PRESENT_ABSOLUTE))
    .sort((a, b) => profile[b] - profile[a])
}

/** The weight the note's language mix gets when a passage has little evidence of its own. A note with
 * little text so far carries less weight than a long one, and a mixed note gives no strong prior. */
export const profilePrior = (profile: LanguageEvidence): LanguageEvidence => {
  const total = evidenceTotal(profile)
  if (total <= 0) return emptyEvidence()
  const scale = Math.min(1, total / PRIOR_FULL_AT) * PRIOR_POINTS
  return { de: (profile.de / total) * scale, en: (profile.en / total) * scale, fr: (profile.fr / total) * scale }
}

export const detectedLanguageOf = (present: readonly TextLanguage[]): DetectedTextLanguage => (
  present.length === 0 ? 'unknown' : present.length === 1 ? present[0] : 'mixed'
)

/** Status label of a note's language mix, e.g. "DE · FR". */
export const languageProfileLabel = (present: readonly TextLanguage[]) => present.map((language) => language.toLocaleUpperCase('en-US')).join(' · ')

/** The BCP 47 tag the browser uses for hyphenation and spellcheck hints. */
export const languageTag = (language: TextLanguage | null | undefined) => (
  language === 'en' ? 'en' : language === 'fr' ? 'fr-CH' : 'de-CH'
)

/* ---------- splitting a line into passages ---------- */

export type PassageKind = 'line' | 'cell' | 'column' | 'vocabulary' | 'sentence' | 'quote'
export type PassageRange = { from: number; to: number; kind: PassageKind }

const LINE_MARKER = /^\s*(?:>\s*)*(?:(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+)?/u
const VOCABULARY_SEPARATOR = /\s+(?:[–—−=→⇒↔⟷/]|-)\s+/gu
const QUOTE = /„[^„“”\n]{10,}?[“”]|«[^«»\n]{10,}?»|“[^“”\n]{10,}?”|"[^"\n]{10,}?"/gu
const wordCount = (text: string) => (text.match(/\p{L}[\p{L}\p{M}'’-]*/gu) ?? []).length

const trimmed = (text: string, from: number, to: number): [number, number] => {
  let start = from
  let end = to
  while (start < end && /\s/u.test(text[start])) start += 1
  while (end > start && /\s/u.test(text[end - 1])) end -= 1
  return [start, end]
}

const rangesBetween = (text: string, base: number, cuts: Array<[number, number]>, kind: PassageKind): PassageRange[] => {
  const result: PassageRange[] = []
  let cursor = base
  for (const [cutFrom, cutTo] of [...cuts, [text.length, text.length] as [number, number]]) {
    const [from, to] = trimmed(text, cursor, cutFrom)
    if (to > from && /\p{L}/u.test(text.slice(from, to))) result.push({ from, to, kind })
    cursor = cutTo
  }
  return result
}

/**
 * The passages of a line, as offsets into `text`: table cells, tab columns, the sides of a
 * vocabulary pair ("le chien – der Hund", "to run = laufen"), quotations and sentences. A line
 * that is none of these is one passage.
 */
export const splitPassages = (text: string): PassageRange[] => {
  const base = LINE_MARKER.exec(text)?.[0].length ?? 0
  const body = text.slice(base)
  const whole: PassageRange[] = [{ from: base, to: text.length, kind: 'line' }]
  if (!/\p{L}/u.test(body)) return []

  // Table row: every cell is its own passage.
  if ((body.match(/\|/gu)?.length ?? 0) >= 2 || body.trimStart().startsWith('|')) {
    const cuts: Array<[number, number]> = []
    for (let index = base; index < text.length; index += 1) if (text[index] === '|') cuts.push([index, index + 1])
    const cells = rangesBetween(text, base, cuts, 'cell')
    if (cells.length >= 2) return cells
    if (cells.length === 1) return cells.map((cell) => ({ ...cell, kind: 'line' as const }))
  }
  // Tab separated columns.
  if (body.includes('\t')) {
    const cuts: Array<[number, number]> = []
    for (let index = base; index < text.length; index += 1) if (text[index] === '\t') cuts.push([index, index + 1])
    const columns = rangesBetween(text, base, cuts, 'column')
    if (columns.length >= 2) return columns
  }
  // Vocabulary pairs: two to four short parts around a dash, equals sign, arrow or slash.
  const separators = [...text.slice(base).matchAll(VOCABULARY_SEPARATOR)].map((match): [number, number] => [base + (match.index ?? 0), base + (match.index ?? 0) + match[0].length])
  if (separators.length >= 1 && separators.length <= 3) {
    const parts = rangesBetween(text, base, separators, 'vocabulary')
    if (parts.length === separators.length + 1 && parts.every((part) => wordCount(text.slice(part.from, part.to)) <= 6)) return parts
  }
  // "le chien: der Hund" is only a pair when both sides are short; otherwise the colon is ordinary punctuation.
  const colon = /(?<=\p{L}):\s+/u.exec(body)
  if (colon) {
    const at = base + colon.index
    const parts = rangesBetween(text, base, [[at, at + colon[0].length]], 'sentence')
    if (parts.length === 2 && wordCount(text.slice(parts[0].from, parts[0].to)) <= 3 && wordCount(text.slice(parts[1].from, parts[1].to)) <= 4) {
      return parts
    }
  }
  // A quotation of its own: the words around it and the quotation are decided separately.
  const quotes = [...body.matchAll(QUOTE)].filter((match) => wordCount(match[0]) >= 3)
  if (quotes.length) {
    const cuts: Array<[number, number]> = []
    const quoted: PassageRange[] = []
    for (const match of quotes) {
      const from = base + (match.index ?? 0)
      cuts.push([from, from + match[0].length])
      const [start, end] = trimmed(text, from + 1, from + match[0].length - 1)
      quoted.push({ from: start, to: end, kind: 'quote' })
    }
    const outside = rangesBetween(text, base, cuts, 'sentence').filter((range) => wordCount(text.slice(range.from, range.to)) >= 1)
    return [...outside, ...quoted].sort((a, b) => a.from - b.from)
  }
  // Several sentences in one line, each long enough to carry a language.
  const boundaries = [...body.matchAll(/[.!?…]+["“”»)]*\s+(?=[\p{Lu}„«"“])/gu)].map((match): [number, number] => [base + (match.index ?? 0) + match[0].trimEnd().length, base + (match.index ?? 0) + match[0].length])
  if (boundaries.length) {
    const sentences = rangesBetween(text, base, boundaries, 'sentence')
    if (sentences.length >= 2 && sentences.every((sentence) => wordCount(text.slice(sentence.from, sentence.to)) >= 3)) return sentences
  }
  return whole
}

/* ---------- lines the profile skips ---------- */

/** A tiny state machine over the lines of a note: code fences, display math and front matter are not prose. */
export const proseLineFilter = () => {
  let fence: string | null = null
  let math = false
  let lineNumber = 0
  let frontMatter = false
  return (line: string): boolean => {
    lineNumber += 1
    if (lineNumber === 1 && line.trim() === '---') {
      frontMatter = true
      return false
    }
    if (frontMatter) {
      if (line.trim() === '---' || line.trim() === '...') frontMatter = false
      return false
    }
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null
      return false
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      return false
    }
    if (line.trim() === '$$') {
      math = !math
      return false
    }
    return !math
  }
}
