/** When the default pen leaves a long word unknown, another width may read it as a dictionary word. */

const WORD = /[A-Za-zÄÖÜäöüß]+/gu

/** A thinner pen and a thicker pen around the default 2.6 px. The default reading comes first. */
export const INK_RETRY_WIDTHS = [1.8, 3.5] as const

/** The unknown word has to be at least this long before a second rendering is worth the time. */
export const LONG_UNKNOWN_LETTERS = 10

/** The other rendering has to beat the default reading by this many nats. */
export const WIDTH_RETRY_MARGIN = 2

export const foldInkWord = (word: string) => word.toLowerCase().replaceAll('ß', 'ss')

export const inkWords = (text: string) => text.match(WORD) ?? []

const editDistance = (left: string, right: string) => {
  const a = Array.from(left)
  const b = Array.from(right)
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1])))
    }
    previous = current
  }
  return previous[b.length]
}

export const hasLongUnknownWord = (
  text: string,
  known: (word: string) => boolean,
  minLength = LONG_UNKNOWN_LETTERS,
) => inkWords(text).some((word) => foldInkWord(word).length >= minLength && !known(word))

/**
 * True when `alternate` turns one long unknown word into a dictionary word of nearly the same
 * length, leaves every known word as it was, and moves any other unknown word by at most two
 * letters (`Glückensisch` → `Glückwunsch`, while `Weiriell` may become `Muiriell`).
 */
export const widthReadingKeepsKnownWords = (
  base: string,
  alternate: string,
  known: (word: string) => boolean,
  minLength = LONG_UNKNOWN_LETTERS,
) => {
  const left = inkWords(base)
  const right = inkWords(alternate)
  if (left.length !== right.length) return false
  let replaced = false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue
    if (known(left[index])) return false
    const before = foldInkWord(left[index])
    const after = foldInkWord(right[index])
    if (before.length >= minLength && known(right[index]) && Math.abs(before.length - after.length) <= 3) {
      replaced = true
      continue
    }
    if (editDistance(before, after) <= 2) continue
    return false
  }
  return replaced
}
