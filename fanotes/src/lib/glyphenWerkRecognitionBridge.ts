/**
 * Validates the only incremental text signal accepted from the embedded
 * GlyphenWerk frame. It is case-sensitive, bounded before normalization and
 * deliberately excludes the unsupported German Eszett.
 */
export const validatedGlyphenWerkTextPrefixHint = (value: unknown) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 320) return undefined
  const normalized = value.normalize('NFC')
  if (
    normalized.length > 320 ||
    /[ßẞ]/u.test(normalized) ||
    !/^\p{L}{1,320}$/u.test(normalized)
  ) return undefined
  return normalized
}

const normalizedLineText = (value: string) => value
  .normalize('NFC')
  .split(/\r?\n/u)
  .map((line) => line.replace(/[\t ]+/gu, ' ').trim())
  .join('\n')
  .trim()

/**
 * Exact reprojection is safe only when the independent neural line already
 * agrees with the final fusion. The absence of a prefix alone is not proof of
 * independence: a classical or personalized host branch can still share the
 * child's evidence and must not become a hard count/content hint.
 */
export const glyphenWerkExactProjectionIsIndependent = (
  _textPrefixHint: string | undefined,
  neuralText: string,
  fusedText: string,
) => {
  const normalizedNeural = normalizedLineText(neuralText)
  return normalizedNeural.length > 0 && normalizedNeural === normalizedLineText(fusedText)
}
