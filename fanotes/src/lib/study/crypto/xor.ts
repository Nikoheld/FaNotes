/** 7-bit ASCII of upper case letters and bitwise XOR. */

import { EMPTY, cellText, lettersOf, type CellState } from './letters'

export const XOR_MAX = 24
export const BITS = 7

export const asciiBits = (letter: string) => letter.toUpperCase().charCodeAt(0).toString(2).padStart(BITS, '0')

export const xorBits = (a: string, b: string) => [...a].map((bit, index) => (bit === b[index] ? '0' : '1')).join('')

export type XorLetters = { plain: string; key: string }

export const xorLetters = (plainText: string, keyText: string): XorLetters => {
  const key = lettersOf(keyText)
  const plain = lettersOf(plainText).slice(0, XOR_MAX)
  return { plain, key: key ? Array.from({ length: plain.length }, (_, index) => key[index % key.length]).join('') : '' }
}

export type XorRow = 'p' | 'k' | 'c'
export type XorCells = { p: string[]; k: string[]; c: string[] }

/** The correct bits of one row at one letter (internal; used to check and for "Codes einsetzen" of the first two rows). */
export const expectedBits = (letters: XorLetters, row: XorRow, index: number) => {
  const p = letters.plain[index]
  const k = letters.key[index]
  if (!p || !k) return ''
  return row === 'p' ? asciiBits(p) : row === 'k' ? asciiBits(k) : xorBits(asciiBits(p), asciiBits(k))
}

export const emptyBits = () => EMPTY.repeat(BITS)

/** Brings the stored rows to one entry per plaintext letter. */
export const fitCells = (cells: XorCells, count: number): XorCells => {
  const fit = (list: string[]) => Array.from({ length: count }, (_, index) => list[index] ?? emptyBits())
  return { p: fit(cells.p), k: fit(cells.k), c: fit(cells.c) }
}

/** Per bit: right, wrong or empty. */
export const checkBitsRow = (letters: XorLetters, cells: XorCells, row: XorRow, index: number): CellState[] => {
  const want = expectedBits(letters, row, index)
  const typed = cells[row][index] ?? ''
  return Array.from({ length: BITS }, (_, bit): CellState => {
    const value = cellText(typed[bit])
    if (!value) return 'open'
    return want && value === want[bit] ? 'ok' : 'bad'
  })
}

/** Fills the first two rows (plaintext and key code) from the letters. The ciphertext row is never filled. */
export const insertCodes = (letters: XorLetters, cells: XorCells): XorCells => ({
  ...cells,
  p: Array.from({ length: letters.plain.length }, (_, index) => expectedBits(letters, 'p', index)),
  k: Array.from({ length: letters.plain.length }, (_, index) => expectedBits(letters, 'k', index)),
})
