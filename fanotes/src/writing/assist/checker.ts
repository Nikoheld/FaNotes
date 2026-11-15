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
export const paragraphLanguage = (text: string, own: StoryLanguage | undefined, story: StoryLanguage, detect: boolean): StoryLanguage => {
  if (own) return own
  if (!detect) return story
  const found = detectLanguage(text)
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

  setSpelling(spelling: SpellingSource | null) {
    this.spelling = spelling
    this.dictionaryVersion += 1
  }

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
      if (!this.spelling!.isMisspelled(word)) continue
      out.push({
        from,
        to: from + word.length,
        rule: 'spelling',
        category: 'spelling',
        message: { de: `„${word}“ steht in keinem Wörterbuch.`, en: `“${word}” is not in the dictionary.` },
        replacements: this.spelling!.suggest(word, spellingLanguage).slice(0, 5),
      })
    }
    return out
  }
}
