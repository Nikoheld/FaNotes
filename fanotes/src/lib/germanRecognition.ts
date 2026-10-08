/** German line repair for the common ae/oe/ue/ss confusions of Latin-only OCR. */

const KNOWN = new Set([
  'mädchen', 'ärger', 'öffnen', 'über', 'straße', 'groß', 'schön', 'für', 'können', 'müssen',
  'hören', 'führen', 'während', 'später', 'früher', 'zurück', 'prüfung', 'übung', 'lösung',
  'gleichung', 'höher', 'nächste', 'größer', 'kleiner', 'zählen', 'wählen', 'gefähr',
  'brücke', 'stücke', 'füße', 'größe', 'heißt', 'weiß', 'daß', 'daß', 'straße',
  'räder', 'käse', 'bäume', 'häuser', 'mütter', 'väter', 'söhne', 'töne', 'höhe',
  'lösungsweg', 'bruch', 'wurzel', 'summe', 'integral',
])

const pairs: Array<[string, string]> = [
  ['ae', 'ä'],
  ['oe', 'ö'],
  ['ue', 'ü'],
  ['Ae', 'Ä'],
  ['Oe', 'Ö'],
  ['Ue', 'Ü'],
  ['ss', 'ß'],
]

const variantsOf = (word: string) => {
  const found: string[] = []
  for (const [from, to] of pairs) {
    let index = word.indexOf(from)
    while (index >= 0) {
      found.push(`${word.slice(0, index)}${to}${word.slice(index + from.length)}`)
      index = word.indexOf(from, index + from.length)
    }
  }
  return found
}

/**
 * Return the single dictionary form of a token, if one umlaut expansion is known
 * and the original is not. `known` defaults to the built-in school list.
 */
export const repairGermanToken = (
  token: string,
  known: (word: string) => boolean = (word) => KNOWN.has(word),
): string | null => {
  const lower = token.toLocaleLowerCase('de-DE')
  if (lower.length < 3 || known(lower)) return null
  const hits = [...new Set(variantsOf(lower))].filter((candidate) => known(candidate))
  if (hits.length !== 1) return null
  return hits[0]
}

export const applyGermanTokenCase = (source: string, replacement: string) => {
  if (source === source.toLocaleUpperCase('de-DE') && source.length > 1) return replacement.toLocaleUpperCase('de-DE')
  if (source[0] === source[0]?.toLocaleUpperCase('de-DE')) {
    return `${replacement[0]?.toLocaleUpperCase('de-DE') ?? ''}${replacement.slice(1)}`
  }
  return replacement
}

export const repairGermanLine = (
  text: string,
  known?: (word: string) => boolean,
) => text.replace(/[A-Za-zÄÖÜäöüß]+/gu, (token) => {
  const repaired = repairGermanToken(token, known)
  return repaired ? applyGermanTokenCase(token, repaired) : token
})
