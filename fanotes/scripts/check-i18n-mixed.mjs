// Fails when translating a catalog-less German UI sentence leaves it half German, half English
// ("mit onem Key", "Filenamen are dort lesbar"). Such text must either be translated by an exact
// catalog entry or stay completely German. Also pins the regressions behind QA-012.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const { localizeText } = require('../electron/i18n.cjs')
const catalogJson = JSON.parse(readFileSync(join(appRoot, 'resources/i18n/en.json'), 'utf8'))

const GERMAN_WORDS = /[ÄÖÜäöüß]|\b(?:der|die|das|den|dem|des|ein|eine|einen|einem|einer|und|oder|für|mit|ohne|von|bei|auf|aus|zu|zum|zur|dein|deine|deinen|wird|werden|ist|sind|nicht|noch|nur|alle|keine|auch|wurde|wurden|kann|dort|dieses|dieser|diesen|jede|jeden|weder|sondern|nach|über|unter|zuerst|neue|neuen)\b/iu
const ENGLISH_WORDS = /\b(?:the|and|or|with|of|is|are|to|a|an|for|in|on|not|from|this|that|will|can|your|by|it|has|have|was|were)\b/iu

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(?:tsx?|cjs)$/u.test(name) && !/\.test\./u.test(name)) out.push(full)
  }
  return out
}

const harvest = () => {
  const found = new Set()
  const files = [...walk(join(appRoot, 'src')), join(appRoot, 'electron/main.cjs')]
  const literal = /(['"`])((?:(?!\1)[^\\\n$]|\\.){12,1500}?)\1|>\s*([^<>{}\n]{12,1500}?)\s*</gu
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(literal)) {
      const value = (match[2] ?? match[3] ?? '').replace(/\\(['"`])/gu, '$1').trim()
      if (!/\s/u.test(value) || !GERMAN_WORDS.test(value) || /[{}]|=>|https?:/u.test(value)) continue
      found.add(value)
    }
  }
  return [...found].filter((value) => catalogJson[value] === undefined)
}

const installDom = () => {
  const storage = new Map([['fanotes.uiLanguage', 'en']])
  const documentStub = { documentElement: { lang: '', dataset: {} }, querySelector: () => null, createTreeWalker: () => ({ nextNode: () => null }), body: {} }
  const windowStub = globalThis.window && typeof globalThis.window === 'object' ? globalThis.window : {}
  Object.assign(windowStub, {
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, String(value)) } },
    confirm: () => true, alert: () => undefined, prompt: () => null, dispatchEvent: () => true, addEventListener: () => undefined,
    setTimeout, clearTimeout, requestIdleCallback: (callback) => { callback(); return 0 },
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
    document: documentStub, navigator: { language: 'en-US', languages: ['en-US'] },
  })
  if (!globalThis.window) globalThis.window = windowStub
  if (!globalThis.document) globalThis.document = documentStub
  if (!globalThis.Node) globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 }
  if (!globalThis.NodeFilter) globalThis.NodeFilter = { SHOW_ELEMENT: 1, SHOW_TEXT: 4 }
  if (!globalThis.Element) globalThis.Element = class Element {}
  if (!globalThis.Text) globalThis.Text = class Text {}
  if (!globalThis.MutationObserver) globalThis.MutationObserver = class { observe() {} disconnect() {} }
}

const server = await createServer({ root: appRoot, appType: 'custom', logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true } })
installDom()
try {
  const i18n = await server.ssrLoadModule('/src/i18n.ts')
  await i18n.setUiLanguage('en')
  i18n.warmUiTranslator()
  const mixed = []
  const strings = harvest()
  for (const source of strings) {
    for (const [path, rendered] of [['renderer', i18n.translateUiText(source)], ['main', localizeText(source, 'en')]]) {
      if (rendered !== source && GERMAN_WORDS.test(rendered) && ENGLISH_WORDS.test(rendered)) mixed.push({ path, source, rendered })
    }
  }
  if (process.env.I18N_LIST_UNTRANSLATED) {
    for (const source of strings) if (i18n.translateUiText(source) === source) console.log(`UNTRANSLATED ${source}`)
  }
  assert.deepEqual(mixed.slice(0, 15), [], `${mixed.length} German sentences translate to mixed German/English text`)

  // Whole-word fragments only; no replacement inside words or inside sentences.
  const sentence = 'Der Server speichert ausschließlich Chiffrate und zufällige IDs – weder Inhalte noch Dateinamen sind dort lesbar.'
  assert.equal(i18n.translateUiText(sentence), sentence, 'an uncatalogued German sentence stays German')
  assert.equal(localizeText(sentence, 'en'), sentence)
  // User data is never translated.
  assert.equal(i18n.translateUiText('Fach A'), 'Fach A')
  for (const [german, english] of [
    ['Jetzt speichern', 'Save now'], ['Kursiv', 'Italic'], ['Durchgestrichen', 'Strikethrough'], ['Nummerierte Liste', 'Numbered list'],
    ['Aufgabenliste', 'Task list'], ['Zitat', 'Quote'], ['Herauszoomen', 'Zoom out'], ['Hineinzoomen', 'Zoom in'], ['Markdown-Editor', 'Markdown editor'],
    ['Dieser Ordner ist bereits einem anderen FaNotes-Ordner zugeordnet.', 'This folder is already assigned to another FaNotes folder.'],
  ]) {
    assert.equal(i18n.translateUiText(german), english)
    assert.equal(localizeText(german, 'en'), english)
  }
  assert.equal(
    i18n.translateUiText("Error invoking remote method 'fanotes:set-folder-locations': Error: Dieser Ordner ist bereits einem anderen FaNotes-Ordner zugeordnet."),
    "Error invoking remote method 'fanotes:set-folder-locations': Error: This folder is already assigned to another FaNotes folder.",
  )
  console.log(JSON.stringify({ scanned: strings.length, mixed: 0 }))
  console.log('i18n-mixed ok')
} finally {
  await server.close()
}
