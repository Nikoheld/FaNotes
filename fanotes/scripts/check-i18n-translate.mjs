import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const { localizeText } = require('../electron/i18n.cjs')

const GERMAN_LEFTOVER = /[ÄÖÜäöüß]|\b(?:der|die|das|und|oder|für|ohne|bitte|zurück|weiter|fertig|sitzung|einstell|handschrift|verlinkung|experimentell|auspoppen|anpassung|optionen|blatt|schreibmodus|stiftmodus|werkzeuge)\b|Vault-Wurzel/iu

const CHROME = [
  'Experimentell',
  'Experimentelle Funktionen',
  'Unfertige Funktionen, standardmässig aus',
  'Handschrift zu Text',
  'Hausaufgaben API',
  'Notiz-Backup',
  'Send Data',
  'Remote Support',
  'Sitzung starten',
  'Sitzung beenden',
  'Code kopieren',
  'Sitzungscode',
  'Buch',
  'Buch hinzufügen',
  'Buch entfernen',
  'Buchansicht',
  'Buchplatzierung',
  'Buch schließen',
  'Links',
  'Rechts',
  'Oben',
  'Unten',
  'Auspoppen',
  'Notizen im Buch',
  'Verlinkung',
  'Verlinkung setzen',
  'Backup',
  'Weiteres Backup',
  'Darstellung',
  'Editor',
  'Stift & Erkennung',
  'Dateien & Vault',
  'Bedienung',
  'Erweitert',
  'FaNotes-Vault auswählen',
  'FaNotes ist abgestürzt',
  'PDF-Buch zum Fach hinzufügen',
  'Einrichtungsschritte',
  'Neue Notiz',
  'Einstellungen öffnen',
  'Fehler melden',
  'Glas-Effekte',
  'Notiz herunterladen',
  'Unfertige Erkennung: Ergebnisse können falsch sein. GlyphenWerk-Training und Text → Handschrift bleiben unabhängig von diesem Schalter nutzbar.',
  'Blatt',
  'Schreibmodus',
  'Stiftmodus',
  'Werkzeuge',
  'Vault-Wurzel',
  'In Vault-Wurzel',
]

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
    /* Node 22 navigator is a getter; i18n.ts reads window.navigator via systemLanguage through navigator global in browser only. */
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
  await i18n.setUiLanguage('de')
  for (const source of CHROME) {
    assert.equal(i18n.translateUiText(source), source, `German renderer changed «${source}»`)
    assert.equal(localizeText(source, 'de'), source, `German main process changed «${source}»`)
  }

  await i18n.setUiLanguage('en')
  const english = []
  for (const source of CHROME) {
    const rendered = i18n.translateUiText(source)
    const main = localizeText(source, 'en')
    assert.notEqual(rendered.trim(), '', `empty renderer translation for «${source}»`)
    assert.match(rendered, /\S/u)
    if (GERMAN_LEFTOVER.test(rendered) && rendered === source && /[ÄÖÜäöüß]/.test(source)) {
      throw new Error(`Renderer left German chrome untranslated: «${source}» → «${rendered}»`)
    }
    if (GERMAN_LEFTOVER.test(rendered)) {
      throw new Error(`Renderer English leftover in «${source}»: «${rendered}»`)
    }
    if (GERMAN_LEFTOVER.test(main)) {
      throw new Error(`Main-process English leftover in «${source}»: «${main}»`)
    }
    english.push({ source, rendered, main })
  }

  assert.equal(i18n.translateUiText('Experimentell'), 'Experimental')
  assert.equal(localizeText('Experimentell', 'en'), 'Experimental')
  assert.equal(i18n.translateUiText('Buch schließen'), 'Close book')
  assert.equal(localizeText('Links', 'en'), 'Left')
  assert.equal(i18n.translateUiText('Anpassung · 5 Optionen'), 'Customization · 5 options')
  assert.equal(i18n.translateUiText('PDF-Seite 3'), 'PDF page 3')
  assert.equal(i18n.translateUiText('Blatt'), 'Sheet')
  assert.equal(i18n.translateUiText('Schreibmodus'), 'Writing mode')
  assert.equal(i18n.translateUiText('Stiftmodus'), 'Pen mode')
  assert.equal(i18n.translateUiText('Werkzeuge'), 'Tools')
  assert.equal(i18n.translateUiText('In Vault-Wurzel'), 'In vault root')
  assert.equal(localizeText('Blatt', 'en'), 'Sheet')
  assert.equal(localizeText('Werkzeuge', 'en'), 'Tools')
  assert.equal(localizeText('Vault-Wurzel', 'en'), 'vault root')

  return { chrome: CHROME.length, samples: english.length }
}

try {
  const first = await runOnce()
  const second = await runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify({ ...first, renderer: 'translateUiText', main: 'localizeText' }))
  console.log('i18n-translate ok')
} finally {
  await server.close()
}
