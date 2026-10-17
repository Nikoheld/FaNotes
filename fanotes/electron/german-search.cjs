'use strict'

const germanSearchExpression = (loweredQuery) => {
  let source = ''
  for (let index = 0; index < loweredQuery.length; index += 1) {
    const char = loweredQuery[index]
    if (char === 'ß' || (char === 's' && loweredQuery[index + 1] === 's')) {
      source += '(?:ß|ss)'
      if (char === 's') index += 1
      continue
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(source, 'gu')
}

const germanIndexOf = (haystackLower, queryLower, from = 0) => {
  if (!queryLower || from > haystackLower.length) return -1
  const expression = germanSearchExpression(queryLower)
  expression.lastIndex = from
  const match = expression.exec(haystackLower)
  if (!match || match.index < from) return -1
  return match.index
}

const germanCount = (haystackLower, queryLower) => {
  if (!queryLower) return 0
  const expression = germanSearchExpression(queryLower)
  let count = 0
  while (expression.exec(haystackLower)) count += 1
  return count
}

module.exports = { germanSearchExpression, germanIndexOf, germanCount }
