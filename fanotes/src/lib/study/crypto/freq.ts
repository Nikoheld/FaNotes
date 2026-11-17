/** Letter frequencies and the substitution grid of the frequency analysis. Nothing is assigned automatically. */

import { ALPHABET, isLetter } from './letters'

export type FreqLang = 'de' | 'en'

/** German reference from the school script (percent). */
export const GERMAN_REFERENCE: Record<string, number> = {
  e: 17.48, n: 9.84, i: 7.73, r: 7.54, s: 6.83, a: 6.47, t: 6.13, d: 4.83, h: 4.23, u: 4.17, l: 3.49, g: 3.06, o: 2.98,
  c: 2.68, m: 2.58, b: 1.93, f: 1.65, w: 1.48, k: 1.46, z: 1.14, p: 0.96, v: 0.94, j: 0.27, y: 0.08, x: 0.04, q: 0.02,
}

/** Standard English letter frequencies (percent). */
export const ENGLISH_REFERENCE: Record<string, number> = {
  e: 12.70, t: 9.06, a: 8.17, o: 7.51, i: 6.97, n: 6.75, s: 6.33, h: 6.09, r: 5.99, d: 4.25, l: 4.03, c: 2.78, u: 2.76,
  m: 2.41, w: 2.36, f: 2.23, g: 2.02, y: 1.97, p: 1.93, b: 1.29, v: 0.98, k: 0.77, j: 0.15, x: 0.15, q: 0.10, z: 0.07,
}

export type FreqRow = { letter: string; count: number; percent: number }

export const countLetters = (text: string) => {
  const counts: Record<string, number> = Object.fromEntries([...ALPHABET].map((ch) => [ch, 0]))
  let total = 0
  for (const ch of text) if (isLetter(ch)) { counts[ch.toUpperCase()] += 1; total += 1 }
  return { counts, total }
}

/** All 26 letters of the text, most frequent first (ties alphabetical). */
export const frequencyRows = (text: string): FreqRow[] => {
  const { counts, total } = countLetters(text)
  return [...ALPHABET]
    .map((letter) => ({ letter, count: counts[letter], percent: total ? (counts[letter] / total) * 100 : 0 }))
    .sort((a, b) => b.count - a.count || a.letter.localeCompare(b.letter))
}

export const referenceRows = (lang: FreqLang): FreqRow[] => {
  const table = lang === 'en' ? ENGLISH_REFERENCE : GERMAN_REFERENCE
  return Object.entries(table).sort((a, b) => b[1] - a[1]).map(([letter, percent]) => ({ letter: letter.toUpperCase(), count: 0, percent }))
}

export type FreqMap = Record<string, string>

export type Token = { ch: string; plain: string }

/** The ciphertext with assigned letters replaced (`plain` set); unassigned letters and other characters stay as they are. */
export const applyMap = (text: string, map: FreqMap): Token[] => [...text].map((ch) => ({ ch, plain: isLetter(ch) ? (map[ch.toUpperCase()] ?? '') : '' }))

/** Plain letters assigned to more than one cipher letter. */
export const duplicateAssignments = (map: FreqMap): Record<string, string[]> => {
  const byPlain = new Map<string, string[]>()
  for (const [cipher, plain] of Object.entries(map)) if (plain) byPlain.set(plain, [...(byPlain.get(plain) ?? []), cipher])
  return Object.fromEntries([...byPlain].filter(([, ciphers]) => ciphers.length > 1).map(([plain, ciphers]) => [plain, ciphers.sort()]))
}
