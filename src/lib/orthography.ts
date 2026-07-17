/**
 * FaNotes uses Swiss Standard German: the German sharp S is neither a
 * trainable glyph nor a recognition output. Keep stored user data untouched,
 * but normalize any legacy/model output at the boundary.
 */
export const containsGermanSharpS = (value: string) => /[ßẞ]/u.test(value)

export const isSupportedRecognitionLabel = (character: string, labelId = '') => (
  !containsGermanSharpS(character) && !/sharp[_-]?s/iu.test(labelId)
)

export const normalizeGermanSharpS = (value: string) => value
  .replace(/ẞ/gu, 'SS')
  .replace(/ß/gu, 'ss')
