/** Caesar shift, given cipher alphabet and keyword alphabet. Answers are checked, never revealed (except by an explicit hint). */

import { ALPHABET, cellText, isLetter, letterIndex, EMPTY, type CellState } from './letters'

export const PLAIN_ROW = 'abcdefghijklmnopqrstuvwxyz'

/** The cipher alphabet of a shift: plain `a` becomes the letter `shift` places on. */
export const shiftAlphabet = (shift: number) => {
  const by = ((Math.trunc(shift) % 26) + 26) % 26
  return `${ALPHABET.slice(by)}${ALPHABET.slice(0, by)}`
}

export type AlphabetCheck = {
  /** The 26 letters in order when valid, else whatever letters were typed (upper case). */
  letters: string
  missing: string[]
  duplicates: string[]
  /** Characters that are neither letters nor spaces. */
  invalid: string[]
  ok: boolean
}

/** A given cipher alphabet must hold each of the 26 letters exactly once (spaces between letters are fine). */
export const checkAlphabet = (text: string): AlphabetCheck => {
  const invalid = [...new Set([...text].filter((ch) => !isLetter(ch) && !/\s/u.test(ch) && ch !== ','))]
  const letters = text.replace(/[^A-Za-z]/gu, '').toUpperCase()
  const seen = new Map<string, number>()
  for (const ch of letters) seen.set(ch, (seen.get(ch) ?? 0) + 1)
  const duplicates = [...seen].filter(([, count]) => count > 1).map(([ch]) => ch)
  const missing = [...ALPHABET].filter((ch) => !seen.has(ch))
  return { letters, missing, duplicates, invalid, ok: !invalid.length && !duplicates.length && !missing.length && letters.length === 26 }
}

export type KeywordPart = { ch: string; kind: 'letter' | 'repeat' | 'space' }

/** The keyword as typed: repeated letters (and spaces) are marked so they can be struck through. */
export const keywordParts = (keyword: string): KeywordPart[] => {
  const seen = new Set<string>()
  return [...keyword].map((ch): KeywordPart => {
    if (!isLetter(ch)) return { ch, kind: 'space' }
    const up = ch.toUpperCase()
    if (seen.has(up)) return { ch, kind: 'repeat' }
    seen.add(up)
    return { ch, kind: 'letter' }
  })
}

/**
 * The cipher alphabet of a keyword: keyword without spaces and repeated letters, then the unused letters in
 * alphabetical order starting after the last letter of the keyword and wrapping around. '' for an empty keyword.
 */
export const keywordAlphabet = (keyword: string) => {
  const clean = keyword.replace(/[^A-Za-z]/gu, '').toUpperCase()
  if (!clean) return ''
  const unique = [...new Set(clean)]
  const used = new Set(unique)
  const start = letterIndex(clean[clean.length - 1])
  const fill: string[] = []
  for (let step = 1; step <= 26; step += 1) {
    const ch = ALPHABET[(start + step) % 26]
    if (!used.has(ch)) fill.push(ch)
  }
  return [...unique, ...fill].join('')
}

/** Letters of the keyword alphabet row that are not placed yet. */
export const unusedLetters = (built: string) => {
  const placed = new Set([...built.slice(0, 26)].filter((ch) => isLetter(ch)).map((ch) => ch.toUpperCase()))
  return [...ALPHABET].filter((ch) => !placed.has(ch))
}

/** Per cell of the student's own keyword alphabet: right, wrong or still empty. Does not reveal the right letter. */
export const checkBuilt = (keyword: string, built: string): CellState[] => {
  const target = keywordAlphabet(keyword)
  return Array.from({ length: 26 }, (_, index): CellState => {
    const typed = cellText(built[index])
    if (!typed) return 'open'
    return target && typed.toUpperCase() === target[index] ? 'ok' : 'bad'
  })
}

/** Encrypts with a 26-letter cipher alphabet (internal: used to check and to hint, never shown as a whole). */
export const encryptWith = (text: string, alphabet: string) => [...text].map((ch) => (isLetter(ch) ? alphabet[letterIndex(ch)] ?? ch : ch)).join('')

export type AnswerCell = { ch: string; state: 'ok' | 'bad' | 'keep' | 'open' }

/** Position-wise verdict of an answer text against the task text; spaces and punctuation must be kept. */
export const checkAnswer = (task: string, answer: string, alphabet: string): AnswerCell[] => {
  const expected = encryptWith(task, alphabet)
  return [...answer].map((ch, index): AnswerCell => {
    const want = expected[index]
    if (want === undefined) return { ch, state: 'bad' }
    if (!isLetter(task[index])) return { ch, state: ch === task[index] ? 'keep' : 'bad' }
    if (ch === EMPTY || ch === ' ') return { ch, state: 'open' }
    return { ch, state: ch.toUpperCase() === want ? 'ok' : 'bad' }
  })
}

export type AnswerSummary = { ok: number; bad: number; open: number; total: number }

export const summariseAnswer = (task: string, cells: readonly AnswerCell[]): AnswerSummary => {
  const total = [...task].filter(isLetter).length
  const ok = cells.filter((cell) => cell.state === 'ok').length
  const bad = cells.filter((cell) => cell.state === 'bad').length
  return { ok, bad, open: Math.max(0, total - ok - bad), total }
}

/** Reveals exactly one letter: the first letter position that is empty or wrong. `null` when nothing is left to reveal. */
export const hintAnswer = (task: string, answer: string, alphabet: string): { answer: string; index: number } | null => {
  const expected = encryptWith(task, alphabet)
  for (let index = 0; index < task.length; index += 1) {
    if (!isLetter(task[index]) || !alphabet) continue
    if ((answer[index] ?? '').toUpperCase() === expected[index]) continue
    const cells = Array.from({ length: Math.max(answer.length, index + 1) }, (_, at) => answer[at] ?? (isLetter(task[at]) ? EMPTY : task[at] ?? ' '))
    cells[index] = expected[index]
    return { answer: cells.join(''), index }
  }
  return null
}
