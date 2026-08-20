import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const { localizeText } = require('../electron/i18n.cjs')

const GERMAN_HINT = /[ÄÖÜäöüß]|(?:ung|keit|heit|lich|ieren)|\b(?:der|die|das|und|oder|für|mit|ohne|von|bei|auf|aus|zu|bitte|zurück|weiter|fertig|sitzung|buch|fach|notiz|ordner|seite|stift|handschrift|einstell|erkenn|speicher|öffnen|schließen|hinzufügen|entfernen|standard|experimentell|verlinkung|auspoppen|anpassung|optionen|blatt|schreibmodus|stiftmodus|werkzeuge)\b|Vault-Wurzel/iu
const GERMAN_LEFTOVER = /[ÄÖÜäöüß]|\b(?:der|die|das|und|oder|für|ohne|bitte|zurück|weiter|fertig|sitzung|experimentell|verlinkung|auspoppen|anpassung|optionen|blatt|schreibmodus|stiftmodus|werkzeuge)\b|Vault-Wurzel/iu

const CHROME_FILES = [
  'src/App.tsx',
  'src/components/SettingsModal.tsx',
  'src/components/FileTree.tsx',
  'src/components/FirstRunOnboarding.tsx',
  'src/components/CommandPalette.tsx',
  'src/components/SubjectBookPane.tsx',
  'src/components/BugReportModal.tsx',
  'src/components/SearchPanel.tsx',
  'src/components/PaperView.tsx',
  'src/lib/subjectBook.ts',
  'electron/main.cjs',
]

const harvest = () => {
  const found = new Set()
  const patterns = [
    /(?:title|label|description|detail|placeholder|aria-label|buttonLabel|message|alt)=["']([^"'${}]{2,300})["']/gu,
    /(?:label|title|description|detail|name|placeholder):\s*['"]([^'"${}]{2,300})['"]/gu,
    /(?:toast|localizeText|showErrorBox)\(\s*['"]([^'"${}]{2,300})['"]/gu,
    />\s*([^<>{\n]{2,90}?)\s*</gu,
    /(?:group:\s*|\|\|\s*)['"]([^'"${}]{2,80})['"]/gu,
    /\?\s*['"]([^'"${}]{2,80})['"]/gu,
  ]
  for (const relative of CHROME_FILES) {
    const text = readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      for (const match of text.matchAll(pattern)) found.add(match[1].trim())
    }
    for (const required of ['Blatt', 'Schreibmodus', 'Stiftmodus', 'Werkzeuge', 'Vault-Wurzel', 'In Vault-Wurzel']) {
      if (text.includes(`'${required}'`) || text.includes(`>${required}<`) || text.includes(`>${required}</`)) found.add(required)
    }
  }
  return [...found].filter((value) => (
    GERMAN_HINT.test(value)
    && !value.startsWith('http')
    && !value.startsWith(':')
    && !value.includes('assert.')
    && !value.includes('}')
    && !value.includes('{')
  )).sort((left, right) => left.localeCompare(right, 'de'))
}

const installDom = () => {
  const storage = new Map([['fanotes.uiLanguage', 'en']])
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, String(value)) },
  }
  const documentStub = {
    documentElement: { lang: '', dataset: {} },
    querySelector: () => null,
    createTreeWalker: () => ({ nextNode: () => null }),
    body: {},
  }
  const windowStub = globalThis.window && typeof globalThis.window === 'object' ? globalThis.window : {}
  Object.assign(windowStub, {
    localStorage,
    confirm: () => true,
    alert: () => undefined,
    prompt: () => null,
    dispatchEvent: () => true,
    addEventListener: () => undefined,
    setTimeout,
    clearTimeout,
    requestIdleCallback: (callback) => {
      callback()
      return 0
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type
        this.detail = init?.detail
      }
    },
    document: documentStub,
    navigator: { language: 'en-US', languages: ['en-US'] },
  })
  if (!globalThis.window) globalThis.window = windowStub
  if (!globalThis.document) globalThis.document = documentStub
  if (!globalThis.Node) globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 }
  if (!globalThis.NodeFilter) globalThis.NodeFilter = { SHOW_ELEMENT: 1, SHOW_TEXT: 4 }
  if (!globalThis.Element) globalThis.Element = class Element {}
  if (!globalThis.Text) globalThis.Text = class Text {}
  if (!globalThis.MutationObserver) {
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    }
  }
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US', languages: ['en-US'] }, configurable: true })
  } catch {
    /* Node 22 navigator is a getter. */
  }
}

const server = await createServer({
  root: appRoot,
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

installDom()
const i18n = await server.ssrLoadModule('/src/i18n.ts')

const runOnce = async () => {
  const harvested = harvest()
  const settingsSource = readFileSync(new URL('../src/components/SettingsModal.tsx', import.meta.url), 'utf8')
  assert.match(settingsSource, /\{`Anpassung · \$\{section\.count\} Optionen`\}/)
  assert.doesNotMatch(settingsSource, /Anpassung · \{section\.count\} Optionen/)
  assert.ok(harvested.includes('Experimentell'), 'harvest missed Experimentell')
  assert.ok(harvested.includes('Blatt'), 'harvest missed Blatt toolbar chrome')
  assert.ok(harvested.includes('Schreibmodus'), 'harvest missed Schreibmodus status chrome')
  assert.ok(harvested.includes('Stiftmodus'), 'harvest missed Stiftmodus status chrome')
  assert.ok(harvested.includes('Werkzeuge'), 'harvest missed Werkzeuge palette group')
  assert.ok(harvested.includes('Vault-Wurzel'), 'harvest missed Vault-Wurzel palette detail')
  assert.ok(harvested.includes('Send Data') || harvested.includes('Notiz-Backup'), 'harvest missed experimental chrome')
  assert.ok(harvested.some((value) => value.includes('Buch')), 'harvest missed book chrome')
  assert.ok(harvested.some((value) => /Verlinkung|Backup|Remote Support/u.test(value)), 'harvest missed recent chrome')

  await i18n.setUiLanguage('de')
  for (const source of harvested) {
    assert.equal(i18n.translateUiText(source), source)
    assert.equal(localizeText(source, 'de'), source)
  }

  await i18n.setUiLanguage('en')
  const leftovers = []
  for (const source of harvested) {
    const rendered = i18n.translateUiText(source)
    const main = localizeText(source, 'en')
    if (GERMAN_LEFTOVER.test(rendered)) leftovers.push({ path: 'renderer', source, rendered })
    if (GERMAN_LEFTOVER.test(main)) leftovers.push({ path: 'main', source, rendered: main })
  }
  if (leftovers.length) {
    throw new Error(`Unmapped German chrome (${leftovers.length}): ${JSON.stringify(leftovers.slice(0, 12))}`)
  }
  return { harvested: harvested.length, leftovers: 0 }
}

try {
  const first = await runOnce()
  const second = await runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('i18n-catalog ok')
} finally {
  await server.close()
}
