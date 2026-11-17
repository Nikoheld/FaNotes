// Synonyms from the bundled thesaurus files (OpenThesaurus for German,
// WordNet for English), loaded the first time they are asked for.
import { fontUrl } from '../layout/measure'

type Thesaurus = { groups: string[][]; index: Map<string, number[]> }
const loaded = new Map<'de' | 'en', Promise<Thesaurus>>()
const POS: Record<string, { de: string; en: string }> = { n: { de: 'Substantiv', en: 'noun' }, v: { de: 'Verb', en: 'verb' }, a: { de: 'Adjektiv', en: 'adjective' }, r: { de: 'Adverb', en: 'adverb' } }

const fileUrl = (language: 'de' | 'en') => fontUrl(`../thesaurus/${language}.txt`)

export const loadThesaurus = (language: 'de' | 'en', fetcher: (url: string) => Promise<string> = (url) => fetch(url).then((response) => {
  if (!response.ok) throw new Error(`Thesaurus ${language}: HTTP ${response.status}`)
  return response.text()
})) => {
  const existing = loaded.get(language)
  if (existing) return existing
  const loading = fetcher(fileUrl(language)).then((text) => parseThesaurus(text, language))
  loading.catch(() => loaded.delete(language))
  loaded.set(language, loading)
  return loading
}

export const parseThesaurus = (text: string, language: 'de' | 'en'): Thesaurus => {
  const groups: string[][] = []
  const index = new Map<string, number[]>()
  for (const line of text.split('\n')) {
    if (!line) continue
    const words = line.split('|')
    const group = groups.length
    groups.push(words)
    for (const word of language === 'en' ? words.slice(1) : words) {
      const key = word.toLocaleLowerCase(language === 'de' ? 'de-DE' : 'en-US')
      const list = index.get(key)
      if (list) list.push(group)
      else index.set(key, [group])
    }
  }
  return { groups, index }
}

/** German and English base forms to try when the inflected word is not in the thesaurus. */
const baseForms = (word: string, language: 'de' | 'en') => {
  const lower = word.toLocaleLowerCase(language === 'de' ? 'de-DE' : 'en-US')
  const forms = [lower]
  if (language === 'de') {
    for (const ending of ['en', 'em', 'er', 'es', 'e', 'n', 's', 'st', 't', 'te', 'ten', 'test', 'tet']) if (lower.endsWith(ending) && lower.length - ending.length >= 3) forms.push(lower.slice(0, -ending.length), `${lower.slice(0, -ending.length)}en`, `${lower.slice(0, -ending.length)}e`)
  } else {
    for (const [ending, replacement] of [['ies', 'y'], ['es', ''], ['s', ''], ['ed', ''], ['ed', 'e'], ['ing', ''], ['ing', 'e'], ['ly', ''], ['er', ''], ['est', '']] as const) if (lower.endsWith(ending) && lower.length - ending.length >= 3) forms.push(lower.slice(0, -ending.length) + replacement)
  }
  return [...new Set(forms)]
}

export type SynonymGroup = { label?: { de: string; en: string }; words: string[] }

/** Synonym groups for a word (the word itself left out), at most `limit` groups. */
export const synonyms = (thesaurus: Thesaurus, word: string, language: 'de' | 'en', limit = 8): SynonymGroup[] => {
  const seen = new Set<number>()
  const out: SynonymGroup[] = []
  for (const form of baseForms(word, language)) {
    for (const group of thesaurus.index.get(form) ?? []) {
      if (seen.has(group)) continue
      seen.add(group)
      const words = thesaurus.groups[group]
      const list = (language === 'en' ? words.slice(1) : words).filter((candidate) => candidate.toLocaleLowerCase() !== form && candidate.toLocaleLowerCase() !== word.toLocaleLowerCase())
      if (list.length) out.push({ ...(language === 'en' ? { label: POS[words[0]] } : {}), words: list.slice(0, 12) })
      if (out.length >= limit) return out
    }
    if (out.length) return out
  }
  return out
}
