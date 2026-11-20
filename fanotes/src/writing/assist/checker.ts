// Runs spelling, rules and style hints for one paragraph, cached by the
// identity of its runs (unchanged paragraphs are never re-checked).
import type { SpellingLanguage } from '../../types'
import { runsText } from '../model/runs'
import type { Run, StoryLanguage } from '../model/types'
import { detectLanguage } from './language'
import { checkRules, type Issue } from './rules'
import { checkStyle, type StyleOptions } from './style'

/** What the writing mode needs from the app's spelling lexicon (src/lib/spelling.ts). */
export type SpellingSource = {
  isMisspelled: (word: string) => boolean
  suggest: (word: string, language: SpellingLanguage) => string[]
  /** Preferred when present (the spelling worker): the answer arrives later, see `onSuggestions`. */
  suggestAsync?: (word: string, language: SpellingLanguage) => Promise<string[]>
}

export type AssistSettings = {
  spelling: boolean
  grammar: boolean
  punctuation: boolean
  typography: boolean
  style: StyleOptions
  disabledRules: string[]
  /** Use the language a paragraph is actually written in when it differs from the story's. */
  detectLanguage: boolean
}

export const defaultAssistSettings = (): AssistSettings => ({
  spelling: true,
  grammar: true,
  punctuation: true,
  typography: true,
  style: { fillers: false, repetition: false, longSentences: false, passive: false, longSentenceWords: 35, repetitionWindow: 50 },
  disabledRules: [],
  detectLanguage: true,
})

const settingsKey = (settings: AssistSettings, language: StoryLanguage, dictionaryVersion: number, ignoredVersion: number) => JSON.stringify([settings, language, dictionaryVersion, ignoredVersion])

/** The language a paragraph is checked in. */
// About 60 words decide the language. The paragraph being typed in is checked on every
// keystroke, and its start mostly stays the same, so the answer is cached per sample.
const SAMPLE = 400
const detected = new Map<string, ReturnType<typeof detectLanguage>>()
const detectCached = (text: string) => {
  const sample = text.length > SAMPLE ? text.slice(0, SAMPLE) : text
  let value = detected.get(sample)
  if (value === undefined && !detected.has(sample)) {
    if (detected.size > 1_000) detected.clear()
    value = detectLanguage(sample)
    detected.set(sample, value)
  }
  return value ?? null
}

export const paragraphLanguage = (text: string, own: StoryLanguage | undefined, story: StoryLanguage, detect: boolean): StoryLanguage => {
  if (own) return own
  if (!detect) return story
  const found = detectCached(text)
  if (!found || story.startsWith(found)) return story
  return found === 'de' ? 'de' : 'en-US'
}

export const issueSignature = (issue: Issue, text: string) => `${issue.rule}:${text.slice(issue.from, issue.to).toLocaleLowerCase('de-DE')}`

const WORD = /[\p{L}][\p{L}\p{M}'’-]*/gu

export class Assistant {
  private cache = new WeakMap<Run[], { key: string; issues: Issue[]; language: StoryLanguage }>()
  private dictionary = new Set<string>()
  private ignored = new Set<string>()
  private dictionaryVersion = 0
  private ignoredVersion = 0

  constructor(private spelling: SpellingSource | null, public settings: AssistSettings = defaultAssistSettings()) {}

  /** Dictionary answers per word: a paragraph is checked again on every keystroke, its words mostly are not new. */
  private misspelled = new Map<string, boolean>()
  private suggestions = new Map<string, string[]>()

  setSpelling(spelling: SpellingSource | null) {
    this.spelling = spelling
    this.misspelled.clear()
    this.suggestions.clear()
    this.suggestionsAsked.clear()
    this.dictionaryVersion += 1
  }

  private isMisspelled(word: string) {
    let value = this.misspelled.get(word)
    if (value === undefined) {
      if (this.misspelled.size > 50_000) this.misspelled.clear()
      value = this.spelling!.isMisspelled(word)
      this.misspelled.set(word, value)
    }
    return value
  }

  /** Suggestions are slow to compute, so they are made when someone looks at them (popover, check panel). */
  private suggest(word: string, language: SpellingLanguage) {
    const key = `${language}:${word}`
    let value = this.suggestions.get(key)
    if (value === undefined) {
      if (this.suggestions.size > 2_000) this.suggestions.clear()
      const spelling = this.spelling
      if (spelling?.suggestAsync) {
        // Not cached until the worker answered, so an empty list here is "not yet", not "none".
        if (!this.suggestionsAsked.has(key)) {
          this.suggestionsAsked.add(key)
          spelling.suggestAsync(word, language).then((words) => {
            this.suggestionsAsked.delete(key)
            if (this.spelling !== spelling) return
            this.suggestions.set(key, words.slice(0, 5))
            this.onSuggestions?.()
          }, () => { this.suggestionsAsked.delete(key) })
        }
        return []
      }
      value = spelling ? spelling.suggest(word, language).slice(0, 5) : []
      this.suggestions.set(key, value)
    }
    return value
  }

  private suggestionsAsked = new Set<string>()
  /** Called when suggestions asked from the worker arrived; the UI renders again and reads them. */
  onSuggestions: (() => void) | null = null

  /** The story's own words (names, invented words) and the ignored findings. */
  setProjectLists(dictionary: string[], ignored: string[]) {
    const words = new Set(dictionary.map((word) => word.toLocaleLowerCase('de-DE')))
    if (words.size !== this.dictionary.size || [...words].some((word) => !this.dictionary.has(word))) {
      this.dictionary = words
      this.dictionaryVersion += 1
    }
    const ignore = new Set(ignored)
    if (ignore.size !== this.ignored.size || [...ignore].some((value) => !this.ignored.has(value))) {
      this.ignored = ignore
      this.ignoredVersion += 1
    }
  }

  knows(word: string) {
    return this.dictionary.has(word.toLocaleLowerCase('de-DE'))
  }

  check(runs: Run[], own: StoryLanguage | undefined, story: StoryLanguage): { issues: Issue[]; language: StoryLanguage } {
    const text = runsText(runs)
    const language = paragraphLanguage(text, own, story, this.settings.detectLanguage)
    const key = settingsKey(this.settings, language, this.dictionaryVersion, this.ignoredVersion)
    const cached = this.cache.get(runs)
    if (cached && cached.key === key) return cached
    const disabled = new Set(this.settings.disabledRules)
    let issues: Issue[] = []
    if (this.settings.spelling && this.spelling) issues.push(...this.spellingIssues(text, language))
    issues.push(...checkRules(text, language, { disabled }).filter((issue) => (
      (issue.category === 'grammar' && this.settings.grammar)
      || (issue.category === 'punctuation' && this.settings.punctuation)
      || (issue.category === 'typography' && this.settings.typography)
    )))
    issues.push(...checkStyle(text, language, this.settings.style))
    issues = issues.filter((issue) => !disabled.has(issue.rule) && !this.ignored.has(issueSignature(issue, text)))
    // Where a spelling mistake and a rule overlap, the spelling one is shown.
    issues.sort((left, right) => left.from - right.from || (left.category === 'spelling' ? -1 : 1))
    const value = { key, issues, language }
    this.cache.set(runs, value)
    return value
  }

  private spellingIssues(text: string, language: StoryLanguage): Issue[] {
    const out: Issue[] = []
    const spellingLanguage: SpellingLanguage = language.startsWith('de') ? 'de' : 'en'
    for (const match of text.matchAll(WORD)) {
      const word = match[0].replace(/['’-]+$/u, '')
      const from = match.index!
      if (word.length < 2 || this.knows(word)) continue
      // Acronyms, words with digits and parts of addresses are left alone.
      if (/^\p{Lu}{2,}$/u.test(word) || /\d/u.test(word)) continue
      if (/[@/:.]\S*$/u.test(text.slice(Math.max(0, from - 30), from)) && !/\s/u.test(text[from - 1] ?? ' ')) continue
      if (!this.isMisspelled(word)) continue
      const assistant = this
      out.push({
        from,
        to: from + word.length,
        rule: 'spelling',
        category: 'spelling',
        message: { de: `„${word}“ steht in keinem Wörterbuch.`, en: `“${word}” is not in the dictionary.` },
        get replacements() { return assistant.suggest(word, spellingLanguage) },
      })
    }
    return out
  }
}
