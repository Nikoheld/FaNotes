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

const EXACT_ONLY_REPLACEMENTS = new Set(['Frei', 'Breite', 'Pinsel', 'Farben', 'Strich'])

function applyEnglishUnits(source) {
  if (source === 'Finde alles wieder') return 'Find everything again'
  if (source === 'Pinsel') return 'Brush'
  if (source === 'Farben') return 'Colors'
  if (source === 'Piktogramme') return 'Pictograms'
  if (source === 'Bleistift') return 'Pencil'
  if (source === 'Kalligrafie') return 'Calligraphy'
  if (source === 'Textmarker') return 'Highlighter'
  if (source === 'Aquarell') return 'Watercolor'
  if (source === 'Fineliner: klar & präzise') return 'Fineliner: clear & precise'
  if (source === 'Bleistift: weich texturiert') return 'Pencil: softly textured'
  if (source === 'Marker: satt & gleichmässig') return 'Marker: bold & even'
  if (source === 'Pinsel: dynamischer Druck') return 'Brush: dynamic pressure'
  if (source === 'Kalligrafie: schräge Breitfeder') return 'Calligraphy: angled broad nib'
  if (source === 'Textmarker: transparent') return 'Highlighter: transparent'
  if (source === 'Aquarell: lasierende Kanten') return 'Watercolor: glazing edges'
  if (source === 'Spray: feine Partikel') return 'Spray: fine particles'
  if (source === 'Breite') return 'Width'
  if (source === 'Deckkraft') return 'Opacity'
  if (source === 'Aktueller Strich') return 'Current stroke'
  if (source === 'Strich') return 'Stroke'
  if (source === '1 Strich') return '1 stroke'
  if (/^\d+ Striche$/u.test(source)) return source.replace('Striche', 'strokes')
  if (source === 'Zeilenabstand') return 'Line spacing'
  if (source === 'Datenerfassung') return 'Data capture'
  if (source === 'Frei') return 'Free'
  if (source === 'Ausgewogen') return 'Balanced'
  if (source === 'Sammlung') return 'Collection'
  if (source === 'Erkennung testen') return 'Test recognition'
  if (source === 'In FaNotes integriert') return 'Built into FaNotes'
  if (source === 'Training & Modell' || source === 'Training &amp; Modell') return 'Training & model'
  if (source === 'Trainingspaket') return 'Training package'
  if (source === 'Was steckt im Paket?') return 'What is in the package?'
  if (source === 'Zeichenstudio') return 'Art studio'
  if (/^\d+ Werkzeuge$/u.test(source)) return source.replace('Werkzeuge', 'Tools')
  const inHistory = /^(\d+) im Verlauf$/u.exec(source)
  if (inHistory) return `${Number(inHistory[1])} in history`
  const glyphenwerkStatus = /^GlyphenWerk · (.+)$/u.exec(source)
  if (glyphenwerkStatus) {
    const label = glyphenwerkStatus[1]
    const view = applyEnglishUnits(label)
    return `GlyphenWerk · ${view ?? catalog()[label] ?? label}`
  }
  if (source === 'Schreibe „') return 'Write “'
  const writeGlyph = /^Schreibe „(.+)“$/u.exec(source)
  if (writeGlyph) return `Write “${writeGlyph[1]}”`
  const namedColor = /^Farbe (.+)$/u.exec(source)
  if (namedColor) return `Color ${namedColor[1]}`
  const artColor = /^Zeichenfarbe (.+)$/u.exec(source)
  if (artColor) return `Drawing color ${artColor[1]}`
  const specialInk = /^(.+) Spezialtinte$/u.exec(source)
  if (specialInk) return `${catalog()[specialInk[1]] ?? specialInk[1]} special ink`
  const insertNamed = /^(.+) einfügen$/u.exec(source)
  if (insertNamed) return `Insert ${catalog()[insertNamed[1]] ?? insertNamed[1]}`
  const tthPreview = /^(\d+) Zeichen · (\d+) Zeilen · (\d+) Verbindungen$/u.exec(source)
  if (tthPreview) {
    const glyphs = Number(tthPreview[1])
    const lines = Number(tthPreview[2])
    const joins = Number(tthPreview[3])
    return `${glyphs} ${glyphs === 1 ? 'character' : 'characters'} · ${lines} ${lines === 1 ? 'line' : 'lines'} · ${joins} ${joins === 1 ? 'connection' : 'connections'}`
  }
  const patternCount = /^(\d+) Muster$/u.exec(source)
  if (patternCount) {
    const count = Number(patternCount[1])
    return `${count} ${count === 1 ? 'pattern' : 'patterns'}`
  }
  const activeSamples = /^(\d+) Beispiele direkt in FaNotes aktiv$/u.exec(source)
  if (activeSamples) {
    const count = Number(activeSamples[1])
    return `${count} ${count === 1 ? 'sample' : 'samples'} active directly in FaNotes`
  }
  return null
}

function catalog() {
  if (!englishCatalog) {
    englishCatalog = loadEnglishCatalog()
    replacements = Object.entries(englishCatalog)
      .filter(([source, translated]) => typeof translated === 'string' && source !== translated && source.length >= 4 && !EXACT_ONLY_REPLACEMENTS.has(source))
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
  const leading = value.match(/^\s*/u)?.[0] || ''
  const trailing = value.match(/\s*$/u)?.[0] || ''
  const source = value.trim()
  // These names are used by the vault IPC handlers on the note/folder creation
  // hot path. Resolve them before touching the optional catalog so a damaged
  // package or an incomplete delta can never turn a basic file operation into
  // a MODULE_NOT_FOUND error.
  const coreTranslation = CORE_ENGLISH_CATALOG[source]
  if (coreTranslation !== undefined) return `${leading}${coreTranslation}${trailing}`
  const translations = catalog()
  if (translations[source] !== undefined) return `${leading}${translations[source]}${trailing}`
  const unit = applyEnglishUnits(source)
  if (unit !== null) return `${leading}${unit}${trailing}`
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
