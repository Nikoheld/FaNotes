/** `ß` and `ss` are the same letters when a German word is looked up. */
export const foldSharpS = (value: string) => value.replaceAll('ß', 'ss')

/** A pattern whose match index still points into the lowercased note. */
export const germanSearchExpression = (loweredQuery: string) => {
  let source = ''
  for (let index = 0; index < loweredQuery.length; index += 1) {
    const char = loweredQuery[index] ?? ''
    if (char === 'ß' || (char === 's' && loweredQuery[index + 1] === 's')) {
      source += '(?:ß|ss)'
      if (char === 's') index += 1
      continue
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(source, 'gu')
}

export const germanIndexOf = (haystackLower: string, queryLower: string, from = 0) => {
  if (!queryLower || from > haystackLower.length) return -1
  const expression = germanSearchExpression(queryLower)
  expression.lastIndex = from
  const match = expression.exec(haystackLower)
  if (!match || match.index < from) return -1
  return match.index
}

export const germanCount = (haystackLower: string, queryLower: string) => {
  if (!queryLower) return 0
  const expression = germanSearchExpression(queryLower)
  let count = 0
  while (expression.exec(haystackLower)) {
    count += 1
    if (expression.lastIndex > haystackLower.length) break
  }
  return count
}
