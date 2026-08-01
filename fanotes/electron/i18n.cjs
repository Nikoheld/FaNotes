'use strict'

let englishCatalog = null
let replacements = null

// Core file operations must remain available even when a package is damaged or
// an old delta update omitted the full localization catalog. The complete
// catalog is still loaded lazily during normal operation; these few entries are
// only the fail-safe needed by the main process before it can show/recover from
// that packaging problem.
const CORE_ENGLISH_CATALOG = Object.freeze({
  'Unbenannte Notiz': 'Untitled note',
  'Neuer Ordner': 'New folder',
  'FaNotes konnte nicht gestartet werden': 'FaNotes failed to start',
})

function loadEnglishCatalog() {
  try {
    const loaded = require('../resources/i18n/en.json')
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
      throw new TypeError('The English localization catalog is not an object.')
    }
    return Object.freeze(Object.assign(Object.create(null), CORE_ENGLISH_CATALOG, loaded))
  } catch (error) {
    // Do not turn a missing translation asset into a vault I/O failure. This is
    // intentionally a narrow fallback rather than a silent replacement for the
    // complete catalog, so packaging checks still catch the missing resource.
    console.warn('FaNotes: Englischer Übersetzungskatalog fehlt; Kern-Fallback aktiv:', error?.message ?? error)
    return CORE_ENGLISH_CATALOG
  }
}

function catalog() {
  if (!englishCatalog) {
    englishCatalog = loadEnglishCatalog()
    replacements = Object.entries(englishCatalog)
      .filter(([source, translated]) => typeof translated === 'string' && source !== translated && source.length >= 4)
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
