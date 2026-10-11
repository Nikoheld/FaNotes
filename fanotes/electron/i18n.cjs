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

const EXACT_ONLY_REPLACEMENTS = new Set(['Frei', 'Breite', 'Pinsel', 'Farben', 'Strich', 'gespeichert', 'werden', 'Holt'])

function translateComposedChrome(source) {
  const syncing = /^(Holt|Lädt hoch|Prüft) (\d+)\/(\d+)$/u.exec(source)
  if (syncing) {
    const phase = syncing[1] === 'Holt' ? 'Fetching' : syncing[1] === 'Lädt hoch' ? 'Uploading' : 'Checking'
    return `${phase} ${syncing[2]}/${syncing[3]}`
  }
  const idShape = /^"id" \((.+)\) darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten \(2-64 Zeichen\)\.$/u.exec(source)
  if (idShape) return `"id" (${idShape[1]}) may only contain lowercase letters, digits, and hyphens (2-64 characters).`
  const idFolder = /^"id" \((.+)\) muss dem Ordnernamen \((.+)\) entsprechen\.$/u.exec(source)
  if (idFolder) return `"id" (${idFolder[1]}) must match the folder name (${idFolder[2]}).`
  const versionShape = /^"version" \((.+)\) muss wie 1\.0\.0 aufgebaut sein\.$/u.exec(source)
  if (versionShape) return `"version" (${versionShape[1]}) must look like 1.0.0.`
  const api = /^"api" (\S+) wird nicht unterstützt \(diese FaNotes-Version spricht API (\d+)\)\.$/u.exec(source)
  if (api) return `"api" ${api[1]} is not supported (this FaNotes version speaks API ${api[2]}).`
  const permission = /^Unbekannte Berechtigung "(.+)"\.$/u.exec(source)
  if (permission) return `Unknown permission "${permission[1]}".`
  const host = /^"networkHosts" enthält einen ungültigen Host: (.+)$/u.exec(source)
  if (host) return `"networkHosts" contains an invalid host: ${host[1]}`
  const category = /^Unbekannte Kategorie "(.+)" wurde ignoriert\.$/u.exec(source)
  if (category) return `Unknown category "${category[1]}" was ignored.`
  const mainFile = /^"main" muss (\S+) sein; andere Einstiegsdateien werden nicht geladen\.$/u.exec(source)
  if (mainFile) return `"main" must be ${mainFile[1]}; other entry files are not loaded.`
  const icon = /^"icon" muss (\S+) sein\.$/u.exec(source)
  if (icon) return `"icon" must be ${icon[1]}.`
  const addonId = /^Ungültige Add-on-ID: (.+)$/u.exec(source)
  if (addonId) return `Invalid add-on ID: ${addonId[1]}`
  return null
}

function translateUpdateDiagnosis(source) {
  const phaseName = (label) => (label === 'Die Updateprüfung' ? 'The update check' : 'The update download')
  const redirected = /^(Die Updateprüfung|Der Update-Download) von (\S+) wurde mit HTTP (\d+) umgeleitet(?: nach (\S+))?(?: \(„([^”]*)“\))?\. So blockiert oft ein Schul-WLAN oder eine Anmeldeseite den Update-Server\.$/u.exec(source)
  if (redirected) {
    const via = redirected[4] ? ` to ${redirected[4]}` : ''
    const title = redirected[5] ? ` (“${redirected[5]}”)` : ''
    return `${phaseName(redirected[1])} from ${redirected[2]} was redirected with HTTP ${redirected[3]}${via}${title}. A school Wi-Fi network or a sign-in page often blocks the update server this way.`
  }
  const proxy = /^(Die Updateprüfung|Der Update-Download) von (\S+) verlangt eine Proxy-Anmeldung \(HTTP (\d+)\)\. Das Schulnetz lässt den Download erst nach der Anmeldung am Proxy durch\.$/u.exec(source)
  if (proxy) return `${phaseName(proxy[1])} from ${proxy[2]} requires a proxy sign-in (HTTP ${proxy[3]}). The school network allows the download only after you sign in to the proxy.`
  const blocked = /^(Die Updateprüfung|Der Update-Download) von (\S+) wurde mit HTTP (\d+) abgewiesen(?: \(„([^”]*)“\))?\. Ein Schul- oder Netzfilter blockiert fanotes\.fasrv\.ch\.$/u.exec(source)
  if (blocked) {
    const title = blocked[4] ? ` (“${blocked[4]}”)` : ''
    return `${phaseName(blocked[1])} from ${blocked[2]} was rejected with HTTP ${blocked[3]}${title}. A school or network filter is blocking fanotes.fasrv.ch.`
  }
  const htmlPage = /^(Die Updateprüfung|Der Update-Download) von (\S+) lieferte HTTP (\d+) als HTML-Seite(?: „([^”]*)“)?\. Das Schul-WLAN hat die Updatedatei durch eine Sperr- oder Anmeldeseite ersetzt\.$/u.exec(source)
  if (htmlPage) {
    const title = htmlPage[4] ? ` “${htmlPage[4]}”` : ''
    return `${phaseName(htmlPage[1])} from ${htmlPage[2]} returned HTTP ${htmlPage[3]} as an HTML page${title}. The school Wi-Fi replaced the update file with a block or sign-in page.`
  }
  const httpEnd = /^(Die Updateprüfung|Der Update-Download) von (\S+) endete mit HTTP (\d+)\.$/u.exec(source)
  if (httpEnd) return `${phaseName(httpEnd[1])} from ${httpEnd[2]} ended with HTTP ${httpEnd[3]}.`
  const replaced = /^Statt der Update-Datei von (\S+) kam eine HTML-Seite(?: „([^”]*)“)?\. Ein Schul-WLAN oder Filter hat die Antwort ersetzt\.$/u.exec(source)
  if (replaced) {
    const title = replaced[2] ? ` “${replaced[2]}”` : ''
    return `Instead of the update file from ${replaced[1]}, an HTML page arrived${title}. A school Wi-Fi network or filter replaced the response.`
  }
  const tls = /^Die HTTPS-Verbindung zu (\S+) scheiterte \(([^)]+)\)\. Ein Schul-Proxy prüft den Datenverkehr und tauscht das Zertifikat — FaNotes bricht das zum Schutz ab\.$/u.exec(source)
  if (tls) return `The HTTPS connection to ${tls[1]} failed (${tls[2]}). A school proxy inspects the traffic and substitutes the certificate — FaNotes stops it for protection.`
  const dnsHijack = /^(\S+) zeigt auf (\S+) \(lokales Netz\) statt auf den FaNotes-Server\. Das Schul-WLAN fängt den Namen ab\.$/u.exec(source)
  if (dnsHijack) return `${dnsHijack[1]} points to ${dnsHijack[2]} (local network) instead of the FaNotes server. The school Wi-Fi is intercepting the name.`
  const dns = /^Der Name (\S+) ließ sich nicht auflösen \(([^)]+)\)\. Das Schul-WLAN filtert oder unterdrückt die Namensauflösung für den Update-Server\.$/u.exec(source)
  if (dns) return `The name ${dns[1]} could not be resolved (${dns[2]}). The school Wi-Fi is filtering or suppressing name resolution for the update server.`
  const connection = /^Die Verbindung zu (\S+) wurde abgebrochen \(([^)]+)\)\. Eine Firewall oder ein Filter des Schulnetzes lässt den Update-Server nicht durch\.$/u.exec(source)
  if (connection) return `The connection to ${connection[1]} was interrupted (${connection[2]}). A firewall or school-network filter is not letting the update server through.`
  const timeout = /^(Die Updateprüfung|Der Update-Download) von (\S+) hat nicht geantwortet\. Das Schulnetz kann große Downloads oder unbekannte Ziele still verwerfen\.$/u.exec(source)
  if (timeout) return `${phaseName(timeout[1])} from ${timeout[2]} did not respond. The school network can silently drop large downloads or unknown destinations.`
  const proxyStatus = /^HTTP (\d+) \(Proxy-Anmeldung\)$/u.exec(source)
  if (proxyStatus) return `HTTP ${proxyStatus[1]} (proxy sign-in)`
  const contentFilter = /^HTTP (\d+) \(Inhaltsfilter\)$/u.exec(source)
  if (contentFilter) return `HTTP ${contentFilter[1]} (content filter)`
  const filterPage = /^Filterseite „([^”]*)“$/u.exec(source)
  if (filterPage) return `Filter page “${filterPage[1]}”`
  return null
}

function applyEnglishUnits(source) {
  const composed = translateComposedChrome(source)
  if (composed) return composed
  const generalOpen = /^Allgemein: (.+) öffnen$/u.exec(source)
  if (generalOpen) return `General: open ${generalOpen[1]}`
  const openNamed = /^(.+): (.+) öffnen$/u.exec(source)
  if (openNamed) {
    const translations = catalog()
    const folder = translations[openNamed[1]] ?? openNamed[1]
    return `${folder}: open ${openNamed[2]}`
  }
  const updateMessage = translateUpdateDiagnosis(source)
  if (updateMessage) return updateMessage
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
