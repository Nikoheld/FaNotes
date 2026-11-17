/** Vigenère: key row over the plaintext; the student looks the cipher letter up in the square. */

import { ALPHABET, EMPTY, cellText, letterIndex, lettersOf, type CellState } from './letters'

export const VIGENERE_MAX = 120

/** Row `key` of the Vigenère square at column `plain`. */
export const vigenereLetter = (key: string, plain: string) => ALPHABET[(letterIndex(key) + letterIndex(plain)) % 26]

export type VigenereRows = { plain: string; key: string }

/** Plaintext without spaces and the key repeated over it, both upper case. */
export const vigenereRows = (keyText: string, plainText: string): VigenereRows => {
  const key = lettersOf(keyText)
  const plain = lettersOf(plainText).slice(0, VIGENERE_MAX)
  if (!key) return { plain, key: '' }
  return { plain, key: Array.from({ length: plain.length }, (_, index) => key[index % key.length]).join('') }
}

export const expectedLetter = (rows: VigenereRows, index: number) => (rows.key[index] && rows.plain[index] ? vigenereLetter(rows.key[index], rows.plain[index]) : '')

export const checkVigenere = (rows: VigenereRows, answer: string): CellState[] => (
  Array.from({ length: rows.plain.length }, (_, index): CellState => {
    const typed = cellText(answer[index])
    if (!typed) return 'open'
    return typed.toUpperCase() === expectedLetter(rows, index) ? 'ok' : 'bad'
  })
)

/** The answer with exactly the letter at `index` filled in. */
export const hintVigenere = (rows: VigenereRows, answer: string, index: number) => {
  const want = expectedLetter(rows, index)
  if (!want) return answer
  const cells = Array.from({ length: rows.plain.length }, (_, at) => answer[at] ?? EMPTY)
  cells[index] = want
  return cells.join('')
}

/** First position that is empty or wrong, for the hint button when nothing is focused. */
export const nextOpenVigenere = (rows: VigenereRows, answer: string) => checkVigenere(rows, answer).findIndex((state) => state !== 'ok')
