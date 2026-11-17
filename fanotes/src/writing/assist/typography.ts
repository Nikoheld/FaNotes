// Autocorrect while typing. Each fix is a replacement inside the paragraph,
// applied as its own undo step right after the keystroke, so Ctrl+Z (or
// Backspace at once) gives back exactly what was typed.
import { LANGUAGE_TYPOGRAPHY } from '../model/defaults'
import type { StoryLanguage } from '../model/types'

export type AutoFix = { from: number; to: number; text: string; kind: 'quote' | 'apostrophe' | 'ellipsis' | 'dash' | 'capital' | 'twocaps' | 'pronoun' | 'eszett' | 'spelling' | 'replacement' }

export type AutocorrectOptions = {
  quotes: boolean
  dashes: boolean
  ellipsis: boolean
  capitalize: boolean
  spelling: boolean
  /** Swiss German: ß becomes ss. On for de-CH by default. */
  swissSs: boolean
  /** Spelling: the replacement the dictionary is sure of, or null. */
  correctWord?: (word: string, sentenceStart: boolean) => string | null
  /** Words the writer added (names): never changed. */
  isKnown?: (word: string) => boolean
  /** The writer's own replacements, e.g. "zb" → "z. B.". */
  replacements?: Record<string, string>
}

export const defaultAutocorrect = (language: StoryLanguage): AutocorrectOptions => ({
  quotes: true,
  dashes: true,
  ellipsis: true,
  capitalize: true,
  spelling: true,
  swissSs: language === 'de-CH',
})

const OPENERS = new Set([' ', '\n', '(', '[', '{', '-', '–', '—', '/', ' ', '„', '“', '«', '‹', '‚', '‘'])

/** Abbreviations after which a full stop does not end the sentence. */
const ABBREVIATIONS = new Set([
  'z', 'b', 'd', 'h', 'u', 'a', 'o', 's', 'v', 'ca', 'bzw', 'usw', 'etc', 'evtl', 'ggf', 'vgl', 'inkl', 'exkl', 'zb', 'dh', 'ua', 'bspw', 'dr', 'prof', 'hr', 'fr', 'nr', 'str', 'st', 'jh', 'jhd', 'mio', 'mrd', 'min', 'max', 'tel', 'abs', 'kap', 'bd', 'gr', 'sog', 'insb', 'allg', 'urspr', 'mr', 'mrs', 'ms', 'jr', 'sr', 'vs', 'eg', 'ie', 'no', 'fig', 'approx', 'dept', 'est', 'mt', 'ft', 'lt', 'capt', 'gen', 'gov', 'sen', 'rev',
])

const isLetter = (char: string | undefined) => Boolean(char && /\p{L}/u.test(char))

/** True when the word that starts at `start` opens a sentence. */
export const startsSentence = (text: string, start: number) => {
  let index = start - 1
  // Opening quotes and brackets before the word belong to it.
  while (index >= 0 && /[„“"«»‹›‚‘'(\[]/u.test(text[index])) index -= 1
  if (index < 0) return true
  if (text[index] === '\n') return true
  if (!/\s/u.test(text[index])) return false
  while (index >= 0 && /\s/u.test(text[index]) && text[index] !== '\n') index -= 1
  if (index < 0 || text[index] === '\n') return true
  // Closing quotes after the sentence mark: „Komm!“ Sie ging.
  while (index >= 0 && /[“”"»«‹›’')\]]/u.test(text[index])) index -= 1
  const mark = text[index]
  if (mark !== '.' && mark !== '!' && mark !== '?') return false
  if (mark === '.') {
    if (text.slice(Math.max(0, index - 2), index + 1) === '...') return false
    const word = /([\p{L}]+)\.$/u.exec(text.slice(Math.max(0, index - 12), index + 1))?.[1] ?? ''
    if (ABBREVIATIONS.has(word.toLocaleLowerCase('de-DE'))) return false
    if (/\d\.$/u.test(text.slice(Math.max(0, index - 1), index + 1))) return false
  }
  return true
}

const typography = (language: StoryLanguage) => LANGUAGE_TYPOGRAPHY[language]

/**
 * The fix for what was just typed, or null. `text` is the paragraph text after
 * the keystroke and `caret` the offset right after the inserted text.
 */
export const autocorrectAfterInput = (text: string, caret: number, inserted: string, language: StoryLanguage, options: AutocorrectOptions): AutoFix | null => {
  const glyphs = typography(language)
  const before = text[caret - 2]
  const english = language.startsWith('en')

  if (inserted === '"' && options.quotes) {
    const opening = caret === 1 || OPENERS.has(before ?? ' ')
    return { from: caret - 1, to: caret, text: opening ? glyphs.open : glyphs.close, kind: 'quote' }
  }
  if (inserted === "'" && options.quotes) {
    // After a word it closes a single quotation that is open in this paragraph (‚nein‘);
    // otherwise, after a letter, it is an apostrophe: it’s, Peter’s, geht’s.
    const opened = text.slice(0, caret - 1).split(glyphs.openSingle).length - 1
    const closed = glyphs.openSingle === glyphs.closeSingle ? 0 : text.slice(0, caret - 1).split(glyphs.closeSingle).length - 1
    if (isLetter(before) && glyphs.openSingle !== glyphs.apostrophe && opened > closed) return { from: caret - 1, to: caret, text: glyphs.closeSingle, kind: 'quote' }
    if (isLetter(before) || /[0-9]/u.test(before ?? '')) return { from: caret - 1, to: caret, text: glyphs.apostrophe, kind: 'apostrophe' }
    const opening = caret === 1 || OPENERS.has(before ?? ' ')
    return { from: caret - 1, to: caret, text: opening ? glyphs.openSingle : glyphs.closeSingle, kind: 'quote' }
  }
  if (inserted === '.' && options.ellipsis && text.slice(caret - 3, caret) === '...') {
    return { from: caret - 3, to: caret, text: '…', kind: 'ellipsis' }
  }
  if (options.dashes && (inserted === ' ' || inserted === '-')) {
    // "word - " → en dash with spaces (German, British) or em dash (US); "--" → dash.
    if (inserted === ' ' && text.slice(caret - 3, caret) === ' - ' && caret >= 4) {
      return english && language === 'en-US' ? { from: caret - 3, to: caret, text: '—', kind: 'dash' } : { from: caret - 3, to: caret, text: ' – ', kind: 'dash' }
    }
    if (inserted === '-' && text.slice(caret - 2, caret) === '--') {
      return { from: caret - 2, to: caret, text: language === 'en-US' ? '—' : '–', kind: 'dash' }
    }
  }

  // Word-level fixes when a word has just been finished.
  if (!/^[\s.,;:!?…)\]“”"»«’']$/u.test(inserted)) return null
  const end = caret - inserted.length
  let start = end
  while (start > 0 && /[\p{L}\p{M}'’-]/u.test(text[start - 1])) start -= 1
  const word = text.slice(start, end)
  if (!word || !/\p{L}/u.test(word)) return null
  if (options.isKnown?.(word)) return null
  // Do not touch what looks like a web address, an e-mail or code.
  if (/[@/\\:_]/u.test(text.slice(Math.max(0, start - 8), start))) return null

  const custom = options.replacements?.[word] ?? options.replacements?.[word.toLocaleLowerCase('de-DE')]
  if (custom) return { from: start, to: end, text: custom, kind: 'replacement' }

  if (options.swissSs && word.includes('ß')) return { from: start, to: end, text: word.replace(/ß/gu, 'ss'), kind: 'eszett' }

  if (english && options.capitalize && /^i(?:['’](?:m|ve|ll|d))?$/u.test(word)) return { from: start, to: start + 1, text: 'I', kind: 'pronoun' }

  // Two capitals at the start ("DIe", "HAus") — not an acronym ("NASA") or a short word ("OK").
  if (options.capitalize && word.length >= 3 && /^\p{Lu}\p{Lu}\p{Ll}+$/u.test(word)) {
    return { from: start, to: end, text: word[0] + word.slice(1).toLocaleLowerCase(language), kind: 'twocaps' }
  }

  const sentenceStart = startsSentence(text, start)
  if (options.spelling && options.correctWord) {
    const corrected = options.correctWord(word, sentenceStart)
    if (corrected && corrected !== word) {
      const capitalised = sentenceStart && options.capitalize ? corrected[0].toLocaleUpperCase(language) + corrected.slice(1) : corrected
      return { from: start, to: end, text: capitalised, kind: 'spelling' }
    }
  }
  if (options.capitalize && sentenceStart && /^\p{Ll}/u.test(word)) {
    return { from: start, to: start + 1, text: word[0].toLocaleUpperCase(language), kind: 'capital' }
  }
  return null
}
