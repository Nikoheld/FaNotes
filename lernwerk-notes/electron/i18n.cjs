'use strict'

let englishCatalog = null
let replacements = null

function catalog() {
  if (!englishCatalog) {
    englishCatalog = require('../resources/i18n/en.json')
    replacements = Object.entries(englishCatalog)
      .filter(([source, translated]) => source !== translated && source.length >= 4)
      .sort(([left], [right]) => right.length - left.length)
  }
  return englishCatalog
}

function resolveLanguage(preference = 'system', systemLocale = '') {
  if (preference === 'de' || preference === 'en') return preference
  const locale = systemLocale || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ''
  return /^de(?:[-_.@]|$)/iu.test(locale) ? 'de' : 'en'
}

function localizeText(value, language) {
  if (language !== 'en' || typeof value !== 'string' || !value.trim()) return value
  const translations = catalog()
  const leading = value.match(/^\s*/u)?.[0] || ''
  const trailing = value.match(/\s*$/u)?.[0] || ''
  const source = value.trim()
  if (translations[source] !== undefined) return `${leading}${translations[source]}${trailing}`
  let result = source
  for (const [german, english] of replacements) {
    if (result.includes(german)) result = result.split(german).join(english)
  }
  return `${leading}${result}${trailing}`
}

function localizeDialogOptions(options, language) {
  if (language !== 'en' || !options || typeof options !== 'object') return options
  const localized = { ...options }
  for (const key of ['title', 'message', 'detail', 'buttonLabel', 'nameLabel']) {
    if (typeof localized[key] === 'string') localized[key] = localizeText(localized[key], language)
  }
  if (Array.isArray(localized.buttons)) localized.buttons = localized.buttons.map((button) => localizeText(button, language))
  if (Array.isArray(localized.filters)) {
    localized.filters = localized.filters.map((filter) => ({
      ...filter,
      name: localizeText(filter.name, language),
    }))
  }
  return localized
}

module.exports = { localizeDialogOptions, localizeText, resolveLanguage }

