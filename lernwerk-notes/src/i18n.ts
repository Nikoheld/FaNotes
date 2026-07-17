import type { UiLanguagePreference } from './types'

export type UiLanguage = 'de' | 'en'

type EnglishCatalog = Record<string, string>
type AttributeSnapshot = { source: string; translated: string }

const STORAGE_KEY = 'fanotes.uiLanguage'
const TRANSLATED_ATTRIBUTES = ['aria-label', 'alt', 'placeholder', 'title'] as const
const USER_CONTENT_SELECTOR = [
  '[data-i18n-ignore]',
  '[contenteditable="true"]',
  '.cm-content',
  '.markdown-preview',
  '.file-tree__name',
  '.file-tree__rename-input',
  '.note-tab-main > span',
  '.search-result-title > strong',
  '.search-results > button > small',
  '.search-results > button > p',
  '.lm-result-source',
  '.lm-preview-empty b',
  '.vault-overview__recent-copy',
  '.vault-overview__graph-label',
  '.vault-overview__graph-note-label',
  '.vault-overview__graph svg title',
].join(',')

let preference: UiLanguagePreference = readStoredPreference()
let activeLanguage: UiLanguage = resolveUiLanguage(preference)
let catalog: EnglishCatalog | null = null
let catalogPromise: Promise<EnglishCatalog> | null = null
let observer: MutationObserver | null = null
let replacements: Array<[string, string]> = []
let replacementExpression: RegExp | null = null
let replacementPreparationScheduled = false
const GERMAN_HINT = /[ÄÖÜäöüß]|\b(?:der|die|das|den|dem|des|ein|eine|einen|einem|und|oder|für|mit|ohne|von|bei|auf|aus|zu|zum|zur|dein|deine|wird|werden|ist|sind|nicht|noch|nur|alle|keine|bitte|schritt|willkommen|zurück|weiter|fertig)\b|(?:ung|keit|heit|lich|isch|ieren|zeichen|schrift|farbe|ordner|notiz|seite|speicher|erkenn|einstell)/iu

const textSnapshots = new WeakMap<Text, { source: string; translated: string }>()
const attributeSnapshots = new WeakMap<Element, Map<string, AttributeSnapshot>>()

function readStoredPreference(): UiLanguagePreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'de' || value === 'en' || value === 'system' ? value : 'system'
  } catch {
    return 'system'
  }
}

function systemLanguage(): UiLanguage {
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  return languages.some((language) => /^de(?:-|$)/iu.test(language || '')) ? 'de' : 'en'
}

export function resolveUiLanguage(value: UiLanguagePreference): UiLanguage {
  return value === 'system' ? systemLanguage() : value
}

export function getUiLanguage(): UiLanguage {
  return activeLanguage
}

export function getUiLocale(): 'de-CH' | 'en-US' {
  return activeLanguage === 'de' ? 'de-CH' : 'en-US'
}

export function getUiLanguagePreference(): UiLanguagePreference {
  return preference
}

async function loadEnglishCatalog(): Promise<EnglishCatalog> {
  if (catalog) return catalog
  catalogPromise ??= import('../resources/i18n/en.json').then((module) => {
    catalog = module.default as EnglishCatalog
    return catalog
  })
  return catalogPromise
}

function prepareReplacementIndex() {
  if (!catalog || replacementExpression) return
  replacements = Object.entries(catalog)
    .filter(([source, translated]) => source !== translated && source.length >= 4)
    .sort(([left], [right]) => right.length - left.length)
  replacementExpression = new RegExp(replacements.map(([source]) => source.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'gu')
  if (activeLanguage === 'en') translateTree(document)
}

function scheduleReplacementIndex() {
  if (replacementPreparationScheduled || replacementExpression || activeLanguage !== 'en') return
  replacementPreparationScheduled = true
  window.setTimeout(() => {
    window.requestIdleCallback(() => {
      replacementPreparationScheduled = false
      prepareReplacementIndex()
    }, { timeout: 30_000 })
  }, 15_000)
}

const preserveOuterWhitespace = (source: string, translated: string) => {
  const leading = source.match(/^\s*/u)?.[0] ?? ''
  const trailing = source.match(/\s*$/u)?.[0] ?? ''
  return `${leading}${translated}${trailing}`
}

function translateCore(source: string): string {
  if (activeLanguage !== 'en' || !catalog) return source
  const exact = catalog[source]
  if (exact !== undefined) return exact

  if (/^1 Treffer$/u.test(source)) return '1 match'
  if (/^\d+ Treffer$/u.test(source)) return source.replace('Treffer', 'matches')
  if (/^Nur Eingang$/u.test(source)) return 'Only Inbox'
  if (/^(\d+) (?:Fach|Fächer) \+ Eingang$/u.test(source)) {
    const count = Number(source.match(/^\d+/u)?.[0] ?? 0)
    return `${count} ${count === 1 ? 'subject' : 'subjects'} + Inbox`
  }
  if (/^(\d+) Ordner \+ Eingang$/u.test(source)) {
    const count = Number(source.match(/^\d+/u)?.[0] ?? 0)
    return `${count} ${count === 1 ? 'folder' : 'folders'} + Inbox`
  }
  if (/^Nur Eingang wird angelegt\.$/u.test(source)) return 'Only Inbox will be created.'
  if (/^(\d+) (?:Fach|Fächer) \+ Eingang wird angelegt\.$/u.test(source)) {
    const count = Number(source.match(/^\d+/u)?.[0] ?? 0)
    return `${count} ${count === 1 ? 'subject' : 'subjects'} + Inbox will be created.`
  }
  if (/^1 (?:Fach|Fächer)(.*)$/u.test(source)) return source.replace(/^1 (?:Fach|Fächer)/u, '1 subject')
  if (/^\d+ (?:Fach|Fächer)(.*)$/u.test(source)) return source.replace(/^([\d]+) (?:Fach|Fächer)/u, '$1 subjects')
  if (/^1 Zeichen$/u.test(source)) return '1 character'
  if (/^\d+ Zeichen$/u.test(source)) return source.replace('Zeichen', 'characters')
  if (/^1 Wort$/u.test(source)) return '1 word'
  if (/^\d+ Wörter$/u.test(source)) return source.replace('Wörter', 'words')
  if (source === 'Notizen ·') return 'notes ·'
  if (source === 'Notizen') return 'Notes'
  if (source === 'Offene Notizen') return 'Open notes'
  if (source === 'Seitenleiste einklappen') return 'Collapse sidebar'
  if (source === 'Seitenleiste einblenden') return 'Expand sidebar'
  if (source === 'Ordner-Seitenleiste einklappen') return 'Collapse folder sidebar'
  if (source === 'GlyphenWerk-Seitenleiste einklappen') return 'Collapse GlyphenWerk sidebar'
  if (source === 'Gliederung umschalten') return 'Toggle outline'
  if (source === 'Fineliner: klar & präzise') return 'Fineliner: clear & precise'
  if (source === 'Marker: satt & gleichmässig') return 'Marker: bold & even'
  if (source === 'Kalligrafie: schräge Breitfeder') return 'Calligraphy: angled broad nib'
  if (source === 'Zeichen & Varianten erfassen') return 'Capture symbols & variants'
  if (source === 'Zurück zu Fächern & Notizen') return 'Back to folders & notes'
  const newNoteIn = /^Neue Notiz in (.+)$/u.exec(source)
  if (newNoteIn) return `New note in ${newNoteIn[1]}`
  const actionsFor = /^Aktionen für (.+)$/u.exec(source)
  if (actionsFor) return `Actions for ${actionsFor[1]}`
  const firstNoteIn = /^(.+): erste Notiz erstellen$/u.exec(source)
  if (firstNoteIn) return `Create first note in ${firstNoteIn[1]}`
  const generalOpen = /^Allgemein: (.+) öffnen$/u.exec(source)
  if (generalOpen) return `General: open ${generalOpen[1]}`
  const knowledgeGraph = /^Visueller Wissensgraph mit (\d+) (?:Fach|Fächern) und (\d+) Notizen$/u.exec(source)
  if (knowledgeGraph) {
    const subjects = Number(knowledgeGraph[1])
    const notes = Number(knowledgeGraph[2])
    return `Visual knowledge graph with ${subjects} ${subjects === 1 ? 'subject' : 'subjects'} and ${notes} ${notes === 1 ? 'note' : 'notes'}`
  }
  const closeNamed = /^(.+) schließen$/u.exec(source)
  if (closeNamed) return `Close ${closeNamed[1]}`
  const canvasWith = /^Zeichenfläche mit (.+)$/u.exec(source)
  if (canvasWith) return `Canvas with ${canvasWith[1]}`
  const currentVersion = /^(FaNotes(?: Web)? [\d.]+) ist aktuell$/u.exec(source)
  if (currentVersion) return `${currentVersion[1]} is up to date`
  const learnedCorrection = /^Korrektur sofort gelernt: (.+)$/u.exec(source)
  if (learnedCorrection) return `Correction learned immediately: ${learnedCorrection[1]}`
  const localAiStatus = /^(.+) verarbeitet die Notiz über (.+)$/u.exec(source)
  if (localAiStatus) return `${localAiStatus[1]} processes the note via ${localAiStatus[2]}`
  const onboardingStep = /^Schritt (\d+): (.+)$/u.exec(source)
  if (onboardingStep) return `Step ${onboardingStep[1]}: ${catalog[onboardingStep[2]] ?? onboardingStep[2]}`
  if (source.startsWith('– ') && catalog[source.slice(2)]) return `– ${catalog[source.slice(2)]}`

  if (!GERMAN_HINT.test(source)) return source

  if (!replacementExpression) {
    scheduleReplacementIndex()
    return source
  }
  return source.replace(replacementExpression, (german) => catalog?.[german] ?? german)
}

export function translateUiText(value: string): string {
  if (activeLanguage !== 'en' || !catalog || !value.trim()) return value
  const core = value.trim()
  return preserveOuterWhitespace(value, translateCore(core))
}

function ignored(element: Element | null): boolean {
  return Boolean(element?.closest(USER_CONTENT_SELECTOR))
}

function translateTextNode(node: Text) {
  if (ignored(node.parentElement)) return
  const current = node.data
  const previous = textSnapshots.get(node)
  const source = previous && (current === previous.source || current === previous.translated)
    ? previous.source
    : current
  const translated = activeLanguage === 'en' ? translateUiText(source) : source
  textSnapshots.set(node, { source, translated })
  if (current !== translated) node.data = translated
}

function translateAttributes(element: Element) {
  if (ignored(element)) return
  const snapshots = attributeSnapshots.get(element) ?? new Map<string, AttributeSnapshot>()
  for (const attribute of TRANSLATED_ATTRIBUTES) {
    if (attribute === 'title' && element.matches('.note-tab, .file-tree__entry-button, .vault-overview__recent-item')) continue
    const current = element.getAttribute(attribute)
    if (current === null) continue
    const previous = snapshots.get(attribute)
    const source = previous && (current === previous.source || current === previous.translated)
      ? previous.source
      : current
    const translated = activeLanguage === 'en' ? translateUiText(source) : source
    snapshots.set(attribute, { source, translated })
    if (translated !== current) element.setAttribute(attribute, translated)
  }
  if (snapshots.size) attributeSnapshots.set(element, snapshots)
}

function translateTree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as Text)
    return
  }
  if (!(root instanceof Element) && root !== document) return
  if (root instanceof Element) translateAttributes(root)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node as Text)
    else translateAttributes(node as Element)
    node = walker.nextNode()
  }
}

function observeDocument() {
  observer?.disconnect()
  observer = null
  if (activeLanguage !== 'en') return
  observer = new MutationObserver((mutations) => {
    const addedRoots: Node[] = []
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') translateTextNode(mutation.target as Text)
      if (mutation.type === 'attributes') translateAttributes(mutation.target as Element)
      mutation.addedNodes.forEach((node) => {
        if (addedRoots.some((root) => root === node || root.contains?.(node))) return
        for (let index = addedRoots.length - 1; index >= 0; index -= 1) {
          if (node.contains?.(addedRoots[index])) addedRoots.splice(index, 1)
        }
        addedRoots.push(node)
      })
    }
    addedRoots.forEach(translateTree)
  })
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...TRANSLATED_ATTRIBUTES],
  })
}

function updateDocumentLanguage() {
  document.documentElement.lang = activeLanguage === 'de' ? 'de-CH' : 'en'
  document.documentElement.dataset.uiLanguage = activeLanguage
  document.querySelector('link[rel="manifest"]')?.setAttribute(
    'href',
    activeLanguage === 'en' ? './manifest.en.webmanifest' : './manifest.webmanifest',
  )
}

export async function setUiLanguage(nextPreference: UiLanguagePreference): Promise<void> {
  const previousPreference = preference
  const previousLanguage = activeLanguage
  preference = nextPreference
  try { window.localStorage.setItem(STORAGE_KEY, nextPreference) } catch { /* private storage */ }
  activeLanguage = resolveUiLanguage(nextPreference)
  if (activeLanguage === 'en') await loadEnglishCatalog()
  updateDocumentLanguage()
  if (previousPreference === preference && previousLanguage === activeLanguage) return
  observeDocument()
  translateTree(document)
  window.dispatchEvent(new CustomEvent('fanotes:language-changed', { detail: { language: activeLanguage, preference } }))
}

export async function initializeUiLocalization(): Promise<void> {
  if (activeLanguage === 'en') await loadEnglishCatalog()
  updateDocumentLanguage()
  observeDocument()

  const nativeConfirm = window.confirm.bind(window)
  const nativeAlert = window.alert.bind(window)
  const nativePrompt = window.prompt.bind(window)
  window.confirm = (message) => nativeConfirm(translateUiText(String(message)))
  window.alert = (message) => nativeAlert(translateUiText(String(message)))
  window.prompt = (message, defaultValue) => nativePrompt(translateUiText(String(message)), defaultValue)
}
