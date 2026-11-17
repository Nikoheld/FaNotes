/** Shared letter helpers for the cryptology tools. Only the 26 ASCII letters count; umlauts and the like are kept as they are. */

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export const isLetter = (ch: string | undefined): ch is string => typeof ch === 'string' && /^[A-Za-z]$/u.test(ch)

/** Only the ASCII letters of `text`, upper case. */
export const lettersOf = (text: string) => text.replace(/[^A-Za-z]/gu, '').toUpperCase()

export const letterIndex = (ch: string) => ch.toUpperCase().charCodeAt(0) - 65

/** The marker of an empty cell in stored answers. */
export const EMPTY = '_'

/** Per-cell verdict. `open` means nothing was entered yet. The right letter is never part of a verdict. */
export type CellState = 'ok' | 'bad' | 'open'

export const cellText = (value: string | undefined) => (value && value !== EMPTY && value !== ' ' ? value : '')

/** Replaces one character of a fixed-width stored string. */
export const setCharAt = (value: string, index: number, ch: string, width: number) => {
  const cells = Array.from({ length: width }, (_, at) => value[at] ?? EMPTY)
  cells[index] = ch || EMPTY
  return cells.join('')
}
