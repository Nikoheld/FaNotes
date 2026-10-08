const DANGEROUS_CSS = /(?:@import|@charset|@namespace|@font-face|expression\s*\(|url\s*\(|-moz-binding|behavior\s*:|javascript\s*:|vbscript\s*:|<\/)/iu

/** Drops stylesheets that can load remote resources or break out of a style tag. */
export const sanitizeCustomCss = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) return ''
  const normalized = value
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\\[0-9a-f]{1,6}\s?/giu, '')
    .replace(/\\/gu, '')
  if (DANGEROUS_CSS.test(normalized)) return ''
  return value.length > 100_000 ? value.slice(0, 100_000) : value
}
