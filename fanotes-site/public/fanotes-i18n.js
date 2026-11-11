(() => {
  const root = document.documentElement
  // Pages may point at a smaller catalogue (data-catalog); the statistics page
  // and older callers keep the full shared catalogue.
  const catalogUrl = document.currentScript?.dataset.catalog || '/i18n/en.json'
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  const language = languages.some((value) => /^de(?:-|$)/iu.test(value || '')) ? 'de' : 'en'
  root.lang = language === 'de' ? 'de-CH' : 'en'
  root.dataset.uiLanguage = language
  if (language === 'de') return

  root.classList.add('i18n-loading')
  // Never keep the page hidden for long, even on a slow or failed request.
  const revealTimer = window.setTimeout(() => root.classList.remove('i18n-loading'), 2500)
  const domReady = document.readyState === 'loading'
    ? new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }))
    : Promise.resolve()
  const attributes = ['aria-label', 'alt', 'placeholder', 'title']
  let replacements = []
  let replacementExpression = null
  let catalog = {}
  const textTranslations = new WeakMap()
  const attributeTranslations = new WeakMap()
  const germanHint = /[ÄÖÜäöüß]|\b(?:der|die|das|den|dem|des|ein|eine|einen|einem|und|oder|für|mit|ohne|von|bei|auf|aus|zu|zum|zur|dein|deine|wird|werden|ist|sind|nicht|noch|nur|alle|keine|bitte)\b|(?:ung|keit|heit|lich|isch|ieren|zeichen|schrift|farbe|ordner|notiz|seite|speicher|erkenn|install|herunter|öffnen|laden)/iu

  const translate = (value) => {
    if (!value?.trim()) return value
    const leading = value.match(/^\s*/u)?.[0] || ''
    const trailing = value.match(/\s*$/u)?.[0] || ''
    const source = value.trim()
    if (catalog[source] !== undefined) return `${leading}${catalog[source]}${trailing}`
    const versionTemplate = source.replace(/\b\d+\.\d+\.\d+\b/gu, 'VERSION')
    if (versionTemplate !== source && catalog[versionTemplate] !== undefined) {
      const versions = source.match(/\b\d+\.\d+\.\d+\b/gu) || []
      let translated = catalog[versionTemplate]
      for (const version of versions) translated = translated.replace('VERSION', version)
      return `${leading}${translated}${trailing}`
    }
    if (!germanHint.test(source)) return value
    const result = replacementExpression
      ? source.replace(replacementExpression, (german) => catalog[german] ?? german)
      : source
    return `${leading}${result}${trailing}`
  }

  const translateTree = (start) => {
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.parentElement?.closest('[data-i18n-ignore]')) {
          const previous = textTranslations.get(node)
          if (previous?.translated === node.data) return
          const source = previous?.source === node.data ? previous.source : node.data
          const translated = translate(source)
          textTranslations.set(node, { source, translated })
          if (translated !== node.data) node.data = translated
        }
        return
      }
      if (!(node instanceof Element)) return
      if (!node.closest('[data-i18n-ignore]')) {
        for (const attribute of attributes) {
          const value = node.getAttribute(attribute)
          if (value !== null) {
            let states = attributeTranslations.get(node)
            if (!states) {
              states = new Map()
              attributeTranslations.set(node, states)
            }
            const previous = states.get(attribute)
            if (previous?.translated === value) continue
            const source = previous?.source === value ? previous.source : value
            const translated = translate(source)
            states.set(attribute, { source, translated })
            if (translated !== value) node.setAttribute(attribute, translated)
          }
        }
      }
    }
    visit(start)
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node) {
      visit(node)
      node = walker.nextNode()
    }
  }

  fetch(catalogUrl, { cache: 'force-cache' })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    })
    .then((loaded) => domReady.then(() => loaded))
    .then((loaded) => {
      catalog = loaded
      replacements = Object.entries(catalog)
        .filter(([source, translated]) => source !== translated && source.length >= 4)
        .sort(([left], [right]) => right.length - left.length)
      replacementExpression = new RegExp(replacements.map(([source]) => source.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'gu')
      window.fanotesTranslate = translate
      translateTree(document.body)
      document.title = translate(document.title)
      const description = document.querySelector('meta[name="description"]')
      if (description) description.setAttribute('content', translate(description.getAttribute('content') || ''))
      document.querySelector('meta[property="og:locale"]')?.setAttribute('content', 'en_US')
      for (const property of ['og:title', 'og:description']) {
        const meta = document.querySelector(`meta[property="${property}"]`)
        if (meta) meta.setAttribute('content', translate(meta.getAttribute('content') || ''))
      }
      new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'characterData') translateTree(mutation.target)
          if (mutation.type === 'attributes') translateTree(mutation.target)
          mutation.addedNodes.forEach(translateTree)
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: attributes })
    })
    .catch(() => undefined)
    .finally(() => {
      window.clearTimeout(revealTimer)
      root.classList.remove('i18n-loading')
    })
})()
