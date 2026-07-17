import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL('./public/i18n/en.json', import.meta.url)), 'utf8'))
const replacements = Object.entries(catalog)
  .filter(([source, translated]) => source !== translated && source.length >= 4)
  .sort(([left], [right]) => right.length - left.length)

export const languageForRequest = (request) => {
  const header = String(request.headers['accept-language'] || '')
  const first = header.split(',', 1)[0].trim()
  return /^de(?:-|$)/iu.test(first) ? 'de' : 'en'
}

export const localizeText = (value, language) => {
  if (language !== 'en' || typeof value !== 'string' || !value.trim()) return value
  const source = value.trim()
  if (catalog[source] !== undefined) return catalog[source]
  let translated = source
  for (const [german, english] of replacements) {
    if (translated.includes(german)) translated = translated.split(german).join(english)
  }
  return translated
}

export const localizeExactText = (value, language) => {
  if (language !== 'en' || typeof value !== 'string' || !value.trim()) return value
  const source = value.trim()
  return catalog[source] ?? source
}

export const localizeResponse = (value, language, key = '') => {
  if (language !== 'en') return value
  if (typeof value === 'string') {
    if (['releaseNotes', 'changes'].includes(key)) return localizeExactText(value, language)
    return ['error', 'message', 'detail'].includes(key) ? localizeText(value, language) : value
  }
  if (Array.isArray(value)) return value.map((entry) => localizeResponse(entry, language, key))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, localizeResponse(child, language, childKey)]))
}
