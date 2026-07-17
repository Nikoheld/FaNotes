import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publicRoot = path.join(root, 'public')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-site-i18n-check-'))
const profile = path.join(temporary, 'chromium')
const screenshots = path.join(temporary, 'screenshots')
const timeoutMs = 30_000
const mime = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.webp', 'image/webp'], ['.woff2', 'font/woff2'],
])

fs.mkdirSync(profile, { recursive: true })
fs.mkdirSync(screenshots, { recursive: true })

const release = {
  version: '2.32.0', releasedAt: '2026-07-15T18:00:00.000Z',
  appimage: { sizeBytes: 188_000_000, url: '/download/appimage' },
  portable: { sizeBytes: 190_000_000, url: '/download/portable' },
  windows: {
    version: '2.32.0',
    packages: {
      installer: { sizeBytes: 181_000_000, url: '/download/windows-installer' },
      portable: { sizeBytes: 184_000_000, url: '/download/windows-portable' },
    },
  },
  checksumsUrl: '/download/checksums',
  changes: ['Complete English localization for FaNotes and its website.'],
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname === '/api/release') {
    const data = Buffer.from(JSON.stringify(release))
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': data.length }).end(data)
    return
  }
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
  const candidate = path.resolve(publicRoot, relative)
  if (candidate !== publicRoot && !candidate.startsWith(`${publicRoot}${path.sep}`)) return response.writeHead(403).end()
  try {
    const data = fs.readFileSync(candidate)
    response.writeHead(200, { 'Content-Type': mime.get(path.extname(candidate)) || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-cache' }).end(data)
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
    if (!message.id || !pending.has(message.id)) return
    const callback = pending.get(message.id)
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

const auditExpression = `(() => {
  const german = /[ÄÖÜäöüß]|\\b(?:Willkommen|Startseite|Hauptnavigation|öffnen|schließen|Farbschema|wechseln|Inhalt|springen|Notizen|Gedanken|Handschrift|Durchsuchbar|Deine|Dein|dein|deiner|Lernen|Papier|herunterladen|Funktionen|ansehen|Aktuell|Eine|Eingaben|lokal|erkannt|Entdecken|Eigenschaften|Privat|Keine|nötig|Echte|Dateien|bleibt|Tabletbereit|Druck|Radierer|Mathe|inklusive|Erkennen|lösen|prüfen|Warum|Alles|wirklich|zusammengehört|Wechsel|zwischen|Zeichen|Werkzeug|gemeinsame|ruhige|Seite|Schreiben|zeichnen|Farben|direkt|platzierbare|Piktogramme|selbstverständlich|Fächer|Ordner|Geschichte|Erkennung|lernt|trainieren|ganze|Sätze|Gleichungen|Korrekturen|Arbeitsblätter|ausfüllen|Bilder|Textfelder|darüber|Tastatur|Wahl|korrigieren|verlinken|strukturieren|Zusammenfassen|wird|geprüft|ohne|Wand|Überschriften|Tabellen|Aufgaben|Rechtschreibung|verstanden|gelöst|Rechenweg|Grenzen|Integralen|Indizes|Summen|Zahlen|Wurzeln|Doppeltipp|eingerahmten|beweisbaren|Fehler|Bereit|wenn|bist|Hol|neueste|Danach|integrierte|automatisch|Konto|Betriebssystem|auswählen|moderne|Distributionen|Empfohlen|Installiert|Benutzerkonto|Startmenü|spätere|Größe|laden|Datei|ausführbar|machen|öffnen|meisten|Architektur|Flexibel|vollständige|passend|manuelle|Signierter|Prüfsummen|wenigen|Sekunden|Wähle|Befehle|verwenden|aktuelle|Versionsnummer|Kopieren|Ordner|Vollständige|Anleitung|Häufige|Fragen|Antworten|Sicher|Gerät|Bleibt|Weitere|Einblicke|Korrigieren|Verlinken|Quelle|Grundlagen|verstehen|Energieerhaltung|Gesamtenergie|Antwort|Druckdynamik|erneut|abspielen|Beispielfach|Mathematik|Physik|Geschichte|Erkannt|Verfügbar|Veröffentlichung|bestätigen|über|gewünschten|verschieben)\\b/iu
  const found = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const value = node.data.replace(/\\s+/gu, ' ').trim()
    if (value && german.test(value) && !node.parentElement?.closest('[data-i18n-ignore]')) found.push(value)
    node = walker.nextNode()
  }
  for (const element of document.querySelectorAll('[aria-label], [title], [placeholder]')) {
    for (const name of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(name) || ''
      if (german.test(value)) found.push(name + ': ' + value)
    }
  }
  for (const element of document.querySelectorAll('title, meta[name="description"], meta[property="og:title"], meta[property="og:description"]')) {
    const value = element.tagName === 'TITLE' ? element.textContent : element.getAttribute('content')
    if (value && german.test(value)) found.push('metadata: ' + value)
  }
  return [...new Set(found)].slice(0, 200)
})()`

async function audit(cdp, label) {
  await wait(150)
  const leftovers = await cdp.evaluate(auditExpression)
  if (leftovers.length) throw new Error(`${label} still contains German UI: ${JSON.stringify(leftovers)}`)
}

async function capture(cdp, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(screenshots, `${name}.png`), Buffer.from(shot.data, 'base64'))
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const target = `http://127.0.0.1:${server.address().port}/`
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
  await waitFor(cdp, `document.documentElement.lang === 'en' && !document.documentElement.classList.contains('i18n-loading') && document.querySelector('[data-version]')?.textContent.includes('2.32.0')`, 'English website')
  await audit(cdp, 'Desktop website')
  await capture(cdp, 'desktop-hero')
  for (const [name, selector] of [['web-app', '.web-app-shell'], ['profiles', '.use-case-grid'], ['features', '.bento-grid'], ['download', '.download-shell'], ['faq', '.faq-list']]) {
    await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'start'})`)
    await wait(900)
    await capture(cdp, `desktop-${name}`)
  }
  await cdp.evaluate(`document.querySelector('[data-platform-tab="linux"]')?.click(); document.querySelector('[data-recognition-choice="text"]')?.click(); document.querySelector('[data-ai-action="summary"]')?.click()`)
  await audit(cdp, 'Interactive website')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await cdp.evaluate(`document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 0); document.querySelector('[data-menu-toggle]')?.click()`)
  await wait(500)
  await audit(cdp, 'Mobile website')
  await capture(cdp, 'mobile-menu')
  console.log(`English website localization passed on desktop, interactions, hidden panels, metadata, and mobile. Screenshots: ${screenshots}`)
} finally {
  socket?.close()
  chromium.kill('SIGTERM')
  server.close()
}
