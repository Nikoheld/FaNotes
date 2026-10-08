/**
 * Swiss prose, spelling, and Text → Handwriting still fold ß/ẞ to ss/SS.
 * The letter detector does not. ß is one trainable glyph; NFC keeps it
 * intact (it has no canonical decomposition). Legacy label ids named
 * sharp-s stay rejected so an old "ss" alias cannot re-enter as ß.
 */
export const containsGermanSharpS = (value: string) => /[ßẞ]/u.test(value)

export const isSupportedRecognitionLabel = (character: string, labelId = '') => {
  if (/sharp[_-]?s/iu.test(labelId)) return false
  if (character === 'ß') return true
  return !containsGermanSharpS(character)
}

/** Dictionary and handwriting-synthesis folding. Not used to slice letters. */
export const normalizeGermanSharpS = (value: string) => value
  .replace(/ẞ/gu, 'SS')
  .replace(/ß/gu, 'ss')

/**
 * Characters of a line reading. NFC composes umlauts and does not expand ß.
 * Whitespace is layout, not a letter.
 */
export const preservedReadingCharacters = (value: string) => (
  Array.from(value.normalize('NFC')).filter((character) => !/\s/u.test(character))
)
