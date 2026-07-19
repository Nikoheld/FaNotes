export type GlyphenWerkLanguage = 'de' | 'en'

type EnglishCatalog = Record<string, string>

const queryLanguage = new URLSearchParams(window.location.search).get('lang')
const browserLanguages = navigator.languages?.length ? navigator.languages : [navigator.language]
const activeLanguage: GlyphenWerkLanguage = queryLanguage === 'de' || queryLanguage === 'en'
  ? queryLanguage
  : browserLanguages.some((language) => /^de(?:-|$)/iu.test(language || '')) ? 'de' : 'en'

const attributes = ['aria-label', 'alt', 'placeholder', 'title'] as const
const ignoredSelector = '[data-i18n-ignore], .katex'
let catalog: EnglishCatalog = {}
let replacements: Array<[string, string]> = []
let replacementExpression: RegExp | null = null
const GERMAN_HINT = /[ÄÖÜäöüß]|\b(?:der|die|das|den|dem|des|ein|eine|einen|einem|und|oder|für|mit|ohne|von|bei|auf|aus|zu|zum|zur|dein|deine|wird|werden|ist|sind|nicht|noch|nur|alle|keine|bitte)\b|(?:ung|keit|heit|lich|isch|ieren|zeichen|schrift|farbe|klasse|beispiel|erkenn|speicher|sammlung|datensatz)/iu

const translateCore = (source: string) => {
  if (activeLanguage !== 'en') return source
  if (catalog[source] !== undefined) return catalog[source]
  if (/^1 Beispiel$/u.test(source)) return '1 example'
  if (/^\d+ Beispiele$/u.test(source)) return source.replace('Beispiele', 'examples')
  if (/^1 Zeichen$/u.test(source)) return '1 character'
  if (/^\d+ Zeichen$/u.test(source)) return source.replace('Zeichen', 'characters')
  if (/^1 Klasse$/u.test(source)) return '1 class'
  if (/^\d+ Klassen$/u.test(source)) return source.replace('Klassen', 'classes')
  if (!GERMAN_HINT.test(source)) return source
  return replacementExpression
    ? source.replace(replacementExpression, (german) => catalog[german] ?? german)
    : source
}

export const translateGlyphenWerkText = (value: string) => {
  if (activeLanguage !== 'en' || !value.trim()) return value
  const leading = value.match(/^\s*/u)?.[0] ?? ''
  const trailing = value.match(/\s*$/u)?.[0] ?? ''
  return `${leading}${translateCore(value.trim())}${trailing}`
}

export const getGlyphenWerkLanguage = () => activeLanguage
export const getGlyphenWerkLocale = () => activeLanguage === 'en' ? 'en-US' : 'de-CH'

const ignored = (element: Element | null) => Boolean(element?.closest(ignoredSelector))

const translateNode = (node: Node) => {
  if (node.nodeType === Node.TEXT_NODE) {
    if (ignored(node.parentElement)) return
    const current = node.nodeValue ?? ''
    const translated = translateGlyphenWerkText(current)
    if (translated !== current) node.nodeValue = translated
    return
  }
  if (!(node instanceof Element) || ignored(node)) return
  for (const attribute of attributes) {
    const current = node.getAttribute(attribute)
    if (current === null) continue
    const translated = translateGlyphenWerkText(current)
    if (translated !== current) node.setAttribute(attribute, translated)
  }
}

const translateTree = (root: Node) => {
  translateNode(root)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    translateNode(node)
    node = walker.nextNode()
  }
}

export async function initializeGlyphenWerkLocalization() {
  document.documentElement.lang = activeLanguage === 'en' ? 'en' : 'de-CH'
  document.documentElement.dataset.uiLanguage = activeLanguage
  if (activeLanguage !== 'en') return
  const module = await import('../fanotes/resources/i18n/en.json')
  catalog = module.default as EnglishCatalog
  replacements = Object.entries(catalog)
    .filter(([source, translated]) => source !== translated && source.length >= 4)
    .sort(([left], [right]) => right.length - left.length)
  replacementExpression = new RegExp(replacements.map(([source]) => source.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'gu')
  document.title = translateGlyphenWerkText(document.title)
  const description = document.querySelector('meta[name="description"]')
  if (description) description.setAttribute('content', translateGlyphenWerkText(description.getAttribute('content') ?? ''))
  translateTree(document.body)
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') translateNode(mutation.target)
      if (mutation.type === 'attributes') translateNode(mutation.target)
      mutation.addedNodes.forEach(translateTree)
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...attributes] })
}
