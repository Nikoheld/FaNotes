'use strict'

const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-i18n-check-'))
const profile = path.join(temporary, 'chromium')
const screenshots = path.join(temporary, 'screenshots')
const timeoutMs = 30_000
const mime = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'],
])

fs.mkdirSync(profile, { recursive: true })
fs.mkdirSync(screenshots, { recursive: true })

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname === '/api/release') {
    const body = JSON.stringify({ version: '2.42.0', releasedAt: '2026-07-16T00:00:00.000Z', changes: [] })
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body)
    return
  }
  if (!url.pathname.startsWith('/notes/')) return response.writeHead(404).end()
  const relative = url.pathname === '/notes/' ? 'index.html' : decodeURIComponent(url.pathname.slice('/notes/'.length))
  const candidate = path.resolve(dist, relative)
  if (candidate !== dist && !candidate.startsWith(`${dist}${path.sep}`)) return response.writeHead(403).end()
  try {
    const data = fs.readFileSync(candidate)
    response.writeHead(200, { 'Content-Type': mime.get(path.extname(candidate)) || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-cache' })
    response.end(data)
  } catch { response.writeHead(404).end() }
})

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function connect(port, child) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chromium exited with code ${child.exitCode}.`)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((candidate) => candidate.type === 'page')
      if (page?.webSocketDebuggerUrl) {
        const socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true })
          socket.addEventListener('error', reject, { once: true })
        })
        return socket
      }
    } catch {}
    await wait(40)
  }
  throw new Error('Chromium debugging did not become available.')
}

function createCdp(socket) {
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id) return
    const callback = pending.get(message.id)
    if (!callback) return
    pending.delete(message.id)
    if (message.error) callback.reject(new Error(message.error.message))
    else callback.resolve(message.result)
  })
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
      return result.result?.value
    },
  }
}

async function waitFor(cdp, expression, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return
    await wait(60)
  }
  throw new Error(`${label} did not become available.`)
}

const AUDIT_EXPRESSION = `(() => {
  const german = /[ÄÖÜäöüß]|\\b(?:Willkommen|bei|du|lernst|geht|Schritt|Einrichtung|Zurück|Weiter|Fertig|Fächer|Fach|Handschrift|Erkennung|Einstellungen|Darstellung|Bedienung|Dateien|Ordner|Notiz|Notizen|Speichern|Gespeichert|Speichert|Löschen|Öffnen|Schließen|Abbrechen|Auswählen|Ausgewählt|Auswahl|aufheben|Suche|Suchen|Treffer|Schreiben|Stift|Seite|Bereich|Arbeitsblatt|Zeichen|Wörter|Deutsch|Automatisch|Aktuell|Bereit|Dein|Deine|Diese|Keine|Alle|Nur|Wird|wird|konnte|kann|möchtest|Bitte|Fehler|Verbindung|Vorschau|Ergebnis|Wiederherstellen|Herunterladen|Installieren|Erweitert|Bewegung|Letzte|Noch|Neu|Neue|Neuer|Eigenes|Eigene|Sicherung|Zurücksetzen|Papierkorb|durchsuchen|einfügen|konvertieren|Ableitungen|Sauber|vorbereitet|einrichten|Farbschema|Akzentfarbe|Arbeitsbereich|Ansicht|Inhaltsbreite|Zeilennummern|Wortzahl|Gliederung|Grafiktablett|Punktraster|Stiftfarbe|Stiftbreite|Druckempfindlichkeit|Durchkritzel|Erkennungsmodus|Automatisierung|Ursprung|Privater|Komfort|Fokus|Seitenleiste|Informationsleiste|verbinden|Adresse|Aktionen|Rechtschreibung|verlinken|strukturieren|Einrichtungs|Struktur|Seitenbild|Positionen|Tabellen|Formeln|Bilder|Eingang|angelegt|erstellt|Aktivieren|Verbunden|Sichert)\\b/iu
  const ignored = (element) => Boolean(element?.closest('[data-i18n-ignore], .cm-content, .markdown-preview, code, pre, .file-tree__name, .note-tab-main > span'))
  const visible = (element) => !element || Boolean(element.getClientRects().length) || element === document.body
  const found = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const value = node.data.replace(/\\s+/gu, ' ').trim()
    if (value && german.test(value) && !ignored(node.parentElement) && visible(node.parentElement)) found.push(value)
    node = walker.nextNode()
  }
  for (const element of document.querySelectorAll('[aria-label], [title], [placeholder]')) {
    if (ignored(element) || !visible(element)) continue
    for (const name of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(name) || ''
      if (german.test(value)) found.push(name + ': ' + value)
    }
  }
  return [...new Set(found)].slice(0, 100)
})()`

async function audit(cdp, label) {
  await wait(120)
  const leftovers = await cdp.evaluate(AUDIT_EXPRESSION)
  if (leftovers.length) throw new Error(`${label} still contains German UI: ${JSON.stringify(leftovers)}`)
}

async function auditGlyphenWerk(cdp, label) {
  const frameAudit = AUDIT_EXPRESSION
    .replaceAll('document.body', 'document.querySelector(\'.glyphenwerk-frame\').contentDocument.body')
    .replaceAll('document.querySelectorAll', 'document.querySelector(\'.glyphenwerk-frame\').contentDocument.querySelectorAll')
  await wait(150)
  const leftovers = await cdp.evaluate(frameAudit)
  if (leftovers.length) throw new Error(`${label} still contains German GlyphenWerk UI: ${JSON.stringify(leftovers)}`)
}

async function capture(cdp, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(screenshots, `${name}.png`), Buffer.from(shot.data, 'base64'))
}

void (async () => {
  if (!fs.existsSync(path.join(dist, 'sw.js'))) throw new Error('Run npm run build:web first.')
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const target = `http://127.0.0.1:${server.address().port}/notes/`
  const debugPort = 20_000 + Math.floor(Math.random() * 20_000)
  const chromium = spawn('/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--lang=en-US', '--accept-lang=en-US,en',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, target,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  let socket
  try {
    socket = await connect(debugPort, chromium)
    const cdp = createCdp(socket)
    await Promise.all([cdp.send('Runtime.enable'), cdp.send('Page.enable'), cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })])
    await waitFor(cdp, `document.documentElement?.lang === 'en' && document.querySelector('.first-run')?.dataset.step === 'welcome'`, 'English onboarding')
    await audit(cdp, 'Welcome onboarding')
    await capture(cdp, 'onboarding-welcome')
    await cdp.evaluate(`document.querySelector('.first-run-continue').click()`)
    await waitFor(cdp, `document.querySelector('.first-run')?.dataset.step === 'profile'`, 'Profile onboarding')
    await audit(cdp, 'Profile onboarding')
    await capture(cdp, 'onboarding-profile')
    const profiles = await cdp.evaluate(`[...document.querySelectorAll('.first-run-profiles strong')].map((node) => node.textContent)`)
    if (profiles.join('|') !== 'School|University|Personal|Work') throw new Error(`English profiles are incomplete: ${JSON.stringify(profiles)}`)
    await cdp.evaluate(`document.querySelector('.first-run-profile-actions .first-run-continue').click()`)
    await waitFor(cdp, `document.querySelector('.first-run')?.dataset.step === 'writing'`, 'Writing onboarding')
    await audit(cdp, 'Writing onboarding')
    await cdp.evaluate(`document.querySelector('.first-run-continue').click()`)
    await waitFor(cdp, `document.querySelector('.first-run')?.dataset.step === 'folders'`, 'Folder onboarding')
    await audit(cdp, 'Folder onboarding')
    await capture(cdp, 'onboarding-folders')
    const subjects = await cdp.evaluate(`[...document.querySelectorAll('.first-run-subject-copy strong')].map((node) => node.textContent)`)
    if (!subjects.includes('Mathematics') || !subjects.includes('Computer Science') || !subjects.includes('Economics')) throw new Error(`English subjects are incomplete: ${JSON.stringify(subjects)}`)
    await cdp.evaluate(`document.querySelector('.first-run-continue').click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.app-shell') && document.querySelector('.markdown-editor .cm-content'))`, 'English workspace')
    await audit(cdp, 'Main workspace')
    const bootstrap = await cdp.evaluate(`window.lernwerk.bootstrap()`)
    if (bootstrap.settings.recognitionLanguage !== 'en' || !bootstrap.starterSubjects.some((subject) => subject.name === 'English')) throw new Error(`English bootstrap is incomplete: ${JSON.stringify(bootstrap.settings)}`)

    await cdp.evaluate(`document.querySelector('button[aria-label="Open Settings"]')?.click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.settings-modal'))`, 'English settings')
    await audit(cdp, 'Settings appearance')
    await capture(cdp, 'settings-appearance')
    const languageOptions = await cdp.evaluate(`[...document.querySelectorAll('.language-options button')].map((button) => button.textContent.trim())`)
    if (languageOptions.join('|') !== 'System|German|English') throw new Error(`Language options are incorrect: ${languageOptions.join('|')}`)
    for (const section of ['Editor', 'Pen & Recognition', 'Files & Vault', 'Updates', 'Accessibility', 'Advanced']) {
      await cdp.evaluate(`([...document.querySelectorAll('.settings-nav nav button')].find((button) => button.textContent.includes(${JSON.stringify(section)})) || null)?.click()`)
      await wait(100)
      await audit(cdp, `Settings ${section}`)
      await capture(cdp, `settings-${section.toLowerCase().replaceAll(/[^a-z]+/gu, '-')}`)
    }
    await cdp.evaluate(`document.querySelector('.settings-content header .icon-button')?.click()`)

    await cdp.evaluate(`document.querySelector('button[aria-label="Open AI Assistant"]')?.click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.ai-panel'))`, 'English AI panel')
    await audit(cdp, 'AI panel')
    await capture(cdp, 'ai-panel')
    await cdp.evaluate(`document.querySelector('.ai-panel button[aria-label="Close AI menu"]')?.click()`)

    await cdp.evaluate(`document.querySelector('.toolbar-button.menu-trigger')?.click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.editor-more-menu'))`, 'English note menu')
    await audit(cdp, 'Note menu')
    await capture(cdp, 'note-menu')
    await cdp.evaluate(`document.querySelector('.toolbar-button.menu-trigger')?.click()`)

    await cdp.evaluate(`document.querySelector('button[aria-label="Search throughout the vault"]')?.click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.search-panel'))`, 'English search')
    await audit(cdp, 'Search panel')
    await capture(cdp, 'search-panel')
    await cdp.evaluate(`document.querySelector('.search-panel button[aria-label="Close search"]')?.click()`)

    await cdp.evaluate(`document.querySelector('button[aria-label="Open Command Palette"]')?.click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.command-palette'))`, 'English command palette')
    await audit(cdp, 'Command palette')
    await capture(cdp, 'command-palette')
    await cdp.evaluate(`document.querySelector('.command-palette button[aria-label="Close"]')?.click()`)

    await cdp.evaluate(`document.querySelector('button[aria-label="Open Vault Overview and Knowledge Graph"]')?.click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.vault-overview'))`, 'English vault overview')
    await audit(cdp, 'Vault overview')
    await capture(cdp, 'vault-overview')
    await cdp.evaluate(`document.querySelector('.vault-overview__close')?.click()`)

    await cdp.evaluate(`document.querySelector('.toolbar-button.convert')?.click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.lw-drawing-board'))`, 'English pen mode')
    await audit(cdp, 'Pen mode')
    await capture(cdp, 'pen-mode')
    await cdp.evaluate(`([...document.querySelectorAll('.lw-draw-toolbar button')].find((button) => button.textContent.includes('Draw')) || null)?.click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.lw-art-studio'))`, 'English drawing studio')
    await audit(cdp, 'Drawing studio')
    await capture(cdp, 'drawing-studio')
    await cdp.evaluate(`([...document.querySelectorAll('.lw-draw-toolbar button')].find((button) => button.textContent.includes('Write')) || null)?.click()`)
    await cdp.evaluate(`([...document.querySelectorAll('.lw-draw-toolbar button')].find((button) => button.textContent.includes('Text') && button.textContent.includes('Handwriting')) || null)?.click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.lw-tth-dialog'))`, 'English text-to-handwriting dialog')
    await audit(cdp, 'Text-to-handwriting dialog')
    await capture(cdp, 'text-to-handwriting')
    await cdp.evaluate(`document.querySelector('.lw-tth-dialog button[aria-label="Close dialog"]')?.click()`)
    await cdp.evaluate(`document.querySelector('.toolbar-button.convert')?.click()`)

    await cdp.evaluate(`document.querySelector('button[aria-label="Open GlyphenWerk"]')?.click()`)
    await waitFor(cdp, `document.querySelector('.glyphenwerk-frame')?.contentDocument?.documentElement?.lang === 'en' && Boolean(document.querySelector('.glyphenwerk-frame')?.contentDocument?.querySelector('.capture-page'))`, 'English GlyphenWerk capture')
    await audit(cdp, 'GlyphenWerk shell')
    await auditGlyphenWerk(cdp, 'GlyphenWerk capture')
    await capture(cdp, 'glyphenwerk-capture')
    for (const [view, label] of [['test', 'Recognition test'], ['collection', 'Collection'], ['export', 'Export']]) {
      await cdp.evaluate(`document.querySelector('.glyphenwerk-frame').contentDocument.querySelectorAll('.nav-item')[${view === 'test' ? 1 : view === 'collection' ? 2 : 3}].click()`)
      await waitFor(cdp, `Boolean(document.querySelector('.glyphenwerk-frame')?.contentDocument?.querySelector('.${view}-page'))`, `English GlyphenWerk ${label}`)
      await auditGlyphenWerk(cdp, `GlyphenWerk ${label}`)
      await capture(cdp, `glyphenwerk-${view}`)
    }
    await cdp.evaluate(`document.querySelector('.glyphenwerk-close')?.click()`)

    const manifest = await cdp.send('Page.getAppManifest')
    if (!manifest.url?.endsWith('/notes/manifest.en.webmanifest') || manifest.errors?.length) throw new Error(`English PWA manifest is invalid: ${JSON.stringify(manifest)}`)
    console.log(`English localization passed: onboarding, workspace, settings, search, menus, pen and drawing tools, text-to-handwriting, all GlyphenWerk views, AI, metadata, and PWA manifest. Screenshots: ${screenshots}`)
  } finally {
    socket?.close()
    chromium.kill('SIGTERM')
    server.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
