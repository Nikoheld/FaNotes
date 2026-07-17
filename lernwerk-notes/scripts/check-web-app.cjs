'use strict'

const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'dist')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-web-check-'))
const profile = path.join(temporary, 'chromium')
const worksheetPath = path.join(temporary, 'arbeitsblatt.png')
const screenshotPath = path.join(temporary, 'fanotes-web.png')
const onboardingScreenshotPath = path.join(temporary, 'fanotes-web-onboarding.png')
const welcomeRepairScreenshotPath = path.join(temporary, 'fanotes-web-welcome-repair.png')
const backupScreenshotPath = path.join(temporary, 'fanotes-web-backup.png')
const externalUrl = process.env.FANOTES_WEB_URL?.trim() || ''
const backupEnrollmentCode = process.env.FANOTES_BACKUP_ENROLLMENT_CODE?.trim() || ''
const timeoutMs = 30_000
const mime = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'],
])

fs.mkdirSync(profile, { recursive: true })
fs.copyFileSync(path.resolve(root, '..', 'fanotes-site', 'design-source', 'app-overview.png'), worksheetPath)
const analyticsEvents = []

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname === '/api/v1/analytics/event' && request.method === 'POST') {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      try { analyticsEvents.push(JSON.parse(body).type) } catch {}
      response.writeHead(204, { 'Cache-Control': 'no-store' }).end()
    })
    return
  }
  if (url.pathname === '/notes') {
    response.writeHead(308, { Location: '/notes/' }).end()
    return
  }
  if (url.pathname === '/api/release') {
    const body = JSON.stringify({ version: '2.30.0', releasedAt: new Date().toISOString(), changes: [] })
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body)
    return
  }
  if (!url.pathname.startsWith('/notes/')) {
    response.writeHead(404).end()
    return
  }
  const relative = url.pathname === '/notes/' ? 'index.html' : decodeURIComponent(url.pathname.slice('/notes/'.length))
  const candidate = path.resolve(dist, relative)
  if (candidate !== dist && !candidate.startsWith(`${dist}${path.sep}`)) {
    response.writeHead(403).end()
    return
  }
  try {
    const data = fs.readFileSync(candidate)
    response.writeHead(200, { 'Content-Type': mime.get(path.extname(candidate)) || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-cache' })
    response.end(data)
  } catch {
    response.writeHead(404).end()
  }
})

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function connect(port, child) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chromium wurde mit Code ${child.exitCode} beendet.`)
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
  throw new Error('Chromium-Debugging wurde nicht rechtzeitig verfügbar.')
}

function createCdp(socket) {
  let sequence = 0
  const pending = new Map()
  const listeners = new Set()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const callback = pending.get(message.id)
      if (!callback) return
      pending.delete(message.id)
      if (message.error) callback.reject(new Error(message.error.message))
      else callback.resolve(message.result)
      return
    }
    listeners.forEach((listener) => listener(message))
  })
  return {
    onEvent(listener) { listeners.add(listener) },
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
    try {
      if (await cdp.evaluate(expression)) return
    } catch (error) {
      // Chromium can expose a page target a few milliseconds before the
      // navigation owns its default execution context. Treat that short
      // hand-over like any other not-yet-ready state instead of making the
      // production smoke test flaky.
      if (!/Cannot find default execution context|Execution context was destroyed|Inspected target navigated or closed/iu.test(String(error?.message || error))) throw error
    }
    await wait(60)
  }
  throw new Error(`${label} wurde nicht rechtzeitig verfügbar.`)
}

void (async () => {
  if (!fs.existsSync(path.join(dist, 'sw.js'))) throw new Error('Der Web-Build fehlt. Führe zuerst npm run build:web aus.')
  const ctcManifest = JSON.parse(fs.readFileSync(path.join(dist, 'ocr', 'manifest.json'), 'utf8'))
  if (ctcManifest.format !== 'fanotes-neural-handwriting-v3') throw new Error(`Das Web-CTC-Manifest ist veraltet: ${ctcManifest.format}`)
  if (ctcManifest.models?.web?.precision !== 'q8-dynamic') throw new Error('Die Web-App verwendet nicht das kompakte Q8-CTC-Modell.')
  if (ctcManifest.models.web.size >= ctcManifest.models.desktop.size * 0.4) throw new Error('Das Web-CTC-Modell ist nicht ausreichend komprimiert.')
  if (fs.statSync(path.join(dist, 'ocr', ctcManifest.models.web.file)).size !== ctcManifest.models.web.size) throw new Error('Die Q8-CTC-Modellgröße stimmt nicht mit dem Manifest überein.')
  const contextManifest = JSON.parse(fs.readFileSync(path.join(dist, 'ocr', 'fanotes-trocr-web', 'manifest.json'), 'utf8'))
  if (contextManifest.quantization !== 'q8-encoder-q8-decoder') throw new Error(`Das Web-Kontextmodell ist nicht vollständig Q8: ${contextManifest.quantization}`)
  const webContextBytes = contextManifest.assets.reduce((sum, asset) => sum + asset.size, 0)
  const desktopContextManifest = JSON.parse(fs.readFileSync(path.join(dist, 'ocr', 'fanotes-trocr', 'manifest.json'), 'utf8'))
  const desktopContextBytes = desktopContextManifest.assets.reduce((sum, asset) => sum + asset.size, 0)
  if (webContextBytes >= desktopContextBytes * 0.55) throw new Error('Das Web-Kontextmodell ist nicht ausreichend kompakt.')
  if (fs.existsSync(path.join(dist, 'native-ocr'))) throw new Error('Die native Desktop-ONNX-Laufzeit wurde versehentlich in die Web-App gepackt.')
  if (process.platform !== 'win32') {
    const privatePaths = []
    const verifyPublicBuildPermissions = (directory) => {
      const directoryMode = fs.statSync(directory).mode & 0o777
      if ((directoryMode & 0o055) !== 0o055) privatePaths.push(`${path.relative(dist, directory) || '.'} (${directoryMode.toString(8)})`)
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) verifyPublicBuildPermissions(absolute)
        else if (entry.isFile()) {
          const mode = fs.statSync(absolute).mode & 0o777
          if ((mode & 0o044) !== 0o044) privatePaths.push(`${path.relative(dist, absolute)} (${mode.toString(8)})`)
        }
      }
    }
    verifyPublicBuildPermissions(dist)
    if (privatePaths.length) throw new Error(`Der Web-Build ist für den Produktionsdienst nicht lesbar: ${privatePaths.slice(0, 8).join(', ')}`)
  }
  if (!externalUrl) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const targetUrl = externalUrl || `http://127.0.0.1:${server.address().port}/notes/`
  const debugPort = 20_000 + Math.floor(Math.random() * 20_000)
  const chromium = spawn('/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--lang=de-CH', '--accept-lang=de-CH,de',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, targetUrl,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
  let socket
  try {
    socket = await connect(debugPort, chromium)
    const cdp = createCdp(socket)
    const errors = []
    cdp.onEvent((message) => {
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text)
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') errors.push(message.params.entry.text)
    })
    await Promise.all([cdp.send('Runtime.enable'), cdp.send('Log.enable'), cdp.send('Page.enable'), cdp.send('Network.enable'), cdp.send('DOM.enable'), cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })])
    await waitFor(cdp, `document.querySelector('.first-run')?.dataset.step === 'welcome'`, 'Der Willkommen-Schritt')
    const onboarding = await cdp.evaluate(`({
      steps: document.querySelectorAll('.first-run-progress button').length,
      preview: Boolean(document.querySelector('.first-run-app-preview .first-run-preview-ink')),
      active: document.querySelector('.first-run-progress [aria-current="step"]')?.getAttribute('aria-label'),
    })`)
    if (onboarding.steps !== 4 || !onboarding.preview || onboarding.active !== 'Schritt 1: Willkommen') throw new Error(`Das Onboarding ist unvollständig: ${JSON.stringify(onboarding)}`)
    await wait(850)
    const onboardingScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    fs.writeFileSync(onboardingScreenshotPath, Buffer.from(onboardingScreenshot.data, 'base64'))
    await cdp.evaluate(`document.querySelector('.first-run-continue').click()`)
    await waitFor(cdp, `document.querySelector('.first-run')?.dataset.step === 'profile' && document.querySelectorAll('.first-run-profiles > button').length === 4`, 'Die Profilauswahl')
    await cdp.evaluate(`document.querySelector('.first-run-continue').click()`)
    await waitFor(cdp, `document.querySelector('.first-run')?.dataset.step === 'writing' && Boolean(document.querySelector('.first-run-writing-preview'))`, 'Der Schreib-Schritt')
    await cdp.evaluate(`document.querySelector('.first-run-continue').click()`)
    await waitFor(cdp, `document.querySelector('.first-run')?.dataset.step === 'folders' && document.querySelectorAll('.first-run-subjects > button').length === 10`, 'Die Ordnerauswahl')
    await cdp.evaluate(`document.querySelector('.first-run-continue').click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.app-shell') && document.querySelector('.markdown-editor .cm-content'))`, 'Der Web-Markdown-Editor')
    await waitFor(cdp, `navigator.serviceWorker.getRegistration('./').then((registration) => Boolean(registration?.active))`, 'Der Offline-Service-Worker')
    const manifest = await cdp.send('Page.getAppManifest')
    if (!manifest.url?.endsWith('/notes/manifest.webmanifest') || manifest.errors?.length) throw new Error(`Das PWA-Manifest ist ungültig: ${JSON.stringify(manifest.errors ?? manifest)}`)
    const installability = await cdp.send('Page.getInstallabilityErrors')
    if (installability.installabilityErrors?.length) throw new Error(`Die Web-App ist nicht installierbar: ${JSON.stringify(installability.installabilityErrors)}`)

    await cdp.evaluate(`window.lernwerk.writeFile('Willkommen.md', '# Willkommen bei FaNotes\\n\\n- Unter **Durchkritzel-Empfindlichkeit** stellst du von 0 bis 100 Prozent ein, wie gründlich du dafür kritzeln musst.\\n- Mit \`Strg+Z\` holst du eine versehentliche Löschung sofort zurück.\\n\\nDieser Abschnitt muss hell bleiben.\\n')`)
    await cdp.send('Page.reload', { ignoreCache: true })
    await waitFor(cdp, `Boolean(window.lernwerk?.platform === 'web' && document.querySelector('.app-shell'))`, 'FaNotes nach der Welcome.md-Migration')
    const welcomeRepair = await cdp.evaluate(`(async () => {
      const content = await window.lernwerk.readFile('Willkommen.md')
      const welcomeButton = [...document.querySelectorAll('.file-tree__entry-button')].find((node) => node.textContent.includes('Willkommen'))
      welcomeButton?.click()
      await new Promise((resolve) => setTimeout(resolve, 250))
      const targetLine = [...document.querySelectorAll('.cm-line')].find((node) => node.textContent.includes('Strg+Z'))
      return {
        content,
        inlineCode: Boolean([...document.querySelectorAll('.cm-live-code')].find((node) => node.textContent.includes('Strg+Z'))),
        lineBackground: targetLine ? getComputedStyle(targetLine).backgroundColor : null,
      }
    })()`)
    if (!welcomeRepair.content.includes('**Strg+Z**') || welcomeRepair.content.includes('`Strg+Z`') || welcomeRepair.inlineCode || welcomeRepair.lineBackground === 'rgb(0, 0, 0)') {
      throw new Error(`Die bestehende Web-Willkommensnotiz wurde nicht vollständig repariert: ${JSON.stringify(welcomeRepair)}`)
    }
    const welcomeRepairScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    fs.writeFileSync(welcomeRepairScreenshotPath, Buffer.from(welcomeRepairScreenshot.data, 'base64'))

    const core = await cdp.evaluate(`(async () => {
      const created = await window.lernwerk.createNote('Mathematik', 'Web Persistenz')
      await window.lernwerk.writeFile(created.relativePath, '# Web Persistenz\\n\\nDas ist ein Tset.\\n\\nThis is an exampel.\\n\\nFormel: $x^2 + 2x + 1$\\n')
      const search = await window.lernwerk.search('Persistenz')
      const drawingJson = JSON.stringify({ schemaVersion: 1, title: 'Web Tinte', updatedAt: new Date().toISOString(), strokes: [], searchTranscript: 'Integral Persistenz' })
      const drawing = await window.lernwerk.saveDrawing({ title: 'Web Tinte', drawingJson })
      const loadedDrawing = await window.lernwerk.readDrawing(drawing.id)
      return { platform: window.lernwerk.platform, path: created.relativePath, content: await window.lernwerk.readFile(created.relativePath), hits: search.length, transcript: JSON.parse(loadedDrawing.drawingJson).searchTranscript }
    })()`)
    if (core.platform !== 'web' || !core.content.includes('x^2') || core.hits < 1 || core.transcript !== 'Integral Persistenz') throw new Error(`Web-API-Prüfung fehlgeschlagen: ${JSON.stringify(core)}`)

    await cdp.send('Runtime.evaluate', { expression: `window.__worksheetPromise = window.lernwerk.importWorksheet().then((value) => window.__worksheet = value)`, awaitPromise: false })
    await waitFor(cdp, `Boolean(document.querySelector('input[type=file]'))`, 'Die Arbeitsblatt-Dateiauswahl')
    const documentNode = await cdp.send('DOM.getDocument')
    const inputNode = await cdp.send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: 'input[type=file]' })
    await cdp.send('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [worksheetPath] })
    await waitFor(cdp, `Boolean(window.__worksheet?.kind === 'image')`, 'Der echte Bildimport')
    const worksheet = await cdp.evaluate(`(async () => ({ source: await window.lernwerk.readAssetDataUrl(window.__worksheet.sourceRelativePath), stored: (await window.lernwerk.readWorksheet(window.__worksheet.id)).id === window.__worksheet.id }))()`)
    if (!worksheet.source.startsWith('blob:') || !worksheet.stored) throw new Error('Das importierte Arbeitsblatt wurde nicht dauerhaft gespeichert.')

    await cdp.send('Page.reload', { ignoreCache: true })
    await waitFor(cdp, `Boolean(window.lernwerk?.platform === 'web' && document.querySelector('.app-shell'))`, 'FaNotes nach dem Neuladen')
    const persisted = await cdp.evaluate(`window.lernwerk.readFile('Mathematik/Web Persistenz.md')`)
    if (!persisted.includes('Web Persistenz')) throw new Error('Die IndexedDB-Persistenzprüfung ist fehlgeschlagen.')
    await cdp.evaluate(`[...document.querySelectorAll('.file-tree__entry-button')].find((node) => node.textContent.includes('Mathematik'))?.click()`)
    await waitFor(cdp, `Boolean([...document.querySelectorAll('.file-tree__entry-button')].find((node) => node.textContent.includes('Web Persistenz')))`, 'Die persistierte Testnotiz im Dateibaum')
    await cdp.evaluate(`[...document.querySelectorAll('.file-tree__entry-button')].find((node) => node.textContent.includes('Web Persistenz'))?.click()`)
    await waitFor(cdp, `document.querySelectorAll('.cm-spelling-error').length === 2`, 'Die zweisprachige Web-Rechtschreibprüfung')
    const spelling = await cdp.evaluate(`(() => ({
      words: [...document.querySelectorAll('.cm-spelling-error')].map((node) => node.dataset.spellingWord).sort().join('|'),
      detected: document.querySelector('.markdown-editor .cm-editor')?.dataset.detectedLanguage,
      status: document.querySelector('.detected-text-language')?.textContent.trim(),
    }))()`)
    if (spelling.words !== 'Tset|exampel' || spelling.detected !== 'mixed' || !spelling.status.includes('DE / EN')) throw new Error(`Die Web-Rechtschreibprüfung ist unvollständig: ${JSON.stringify(spelling)}`)

    await cdp.evaluate(`document.querySelector('.ribbon button[aria-label="AI-Assistent öffnen"]').click()`)
    await waitFor(cdp, `document.querySelectorAll('.ai-provider-grid > button').length === 6`, 'Die sechs AI-Anbieter im Web')
    const aiProviders = await cdp.evaluate(`[...document.querySelectorAll('.ai-provider-grid > button strong')].map((node) => node.textContent).join('|')`)
    if (aiProviders !== 'LM Studio|Ollama|OpenAI|Gemini|Anthropic|OpenCode') throw new Error(`Die Web-AI-Anbieter sind unvollständig: ${aiProviders}`)
    await cdp.evaluate(`[...document.querySelectorAll('.ai-provider-grid > button')].find((button) => button.querySelector('strong')?.textContent === 'OpenAI').click()`)
    await waitFor(cdp, `Boolean([...document.querySelectorAll('.ai-privacy-note strong')].find((node) => node.textContent.includes('Nicht im Browser gespeichert')))`, 'Den flüchtigen Web-Schlüsselschutz')
    await cdp.evaluate(`(() => { const input = document.querySelector('.ai-secret-field input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'web-secret-test'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await waitFor(cdp, `document.querySelector('.ai-secret-field input')?.value === 'web-secret-test'`, 'Die flüchtige AI-Schlüsseleingabe')
    await cdp.evaluate(`document.querySelector('.ai-panel button[aria-label="AI-Menü schließen"]').click()`)
    await waitFor(cdp, `!document.querySelector('.ai-panel')`, 'Das Schliessen des Web-AI-Bereichs')
    await cdp.evaluate(`document.querySelector('.ribbon button[aria-label="AI-Assistent öffnen"]').click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.ai-panel'))`, 'Das erneute Öffnen des Web-AI-Bereichs')
    const forgottenCloudKey = await cdp.evaluate(`document.querySelector('.ai-secret-field input')?.value === ''`)
    if (!forgottenCloudKey) throw new Error('Der Cloud-Schlüssel blieb unerwartet im Browser gespeichert.')
    await cdp.evaluate(`document.querySelector('.ai-panel button[aria-label="AI-Menü schließen"]').click()`)

    await cdp.evaluate(`document.querySelector('button[aria-label="Einstellungen öffnen"]').click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.settings-modal'))`, 'Die Web-Einstellungen')
    await cdp.evaluate(`[...document.querySelectorAll('.settings-nav nav button')].find((button) => button.textContent.includes('Dateien & Vault')).click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.server-backup-card input#server-backup-enrollment'))`, 'Das optionale Server-Backup')
    const backupUi = await cdp.evaluate(`(async () => ({
      enabled: document.querySelector('.backup-state-badge')?.textContent,
      enrollmentType: document.querySelector('#server-backup-enrollment')?.type,
      recoveryType: document.querySelector('#server-backup-recovery')?.type,
      supported: (await window.lernwerk.getServerBackupState()).supported,
    }))()`)
    if (backupUi.enabled !== 'Aus' || backupUi.enrollmentType !== 'password' || backupUi.recoveryType !== 'password' || !backupUi.supported) throw new Error(`Backup-Oberfläche ist nicht sicher initialisiert: ${JSON.stringify(backupUi)}`)
    await wait(350)
    const backupScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    fs.writeFileSync(backupScreenshotPath, Buffer.from(backupScreenshot.data, 'base64'))
    if (backupEnrollmentCode) {
      const activated = await cdp.evaluate(`(async () => {
        const state = await window.lernwerk.enableServerBackup(${JSON.stringify(backupEnrollmentCode)})
        return { enabled: state.enabled, status: state.status, automatic: state.automatic, sizeBytes: state.sizeBytes, recoveryCodeValid: /^fanotes1_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/.test(state.recoveryCode || '') }
      })()`)
      if (!activated.enabled || activated.status !== 'ready' || !activated.automatic || activated.sizeBytes <= 0 || !activated.recoveryCodeValid) throw new Error(`Produktives Browser-Backup ist nicht vollständig: ${JSON.stringify(activated)}`)
      const deleted = await cdp.evaluate(`window.lernwerk.deleteServerBackup()`)
      if (deleted.enabled || deleted.status !== 'disabled') throw new Error('Der Browser-Testtresor konnte nicht vollständig gelöscht werden.')
    }
    await cdp.evaluate(`document.querySelector('.settings-content > header button').click()`)

    await waitFor(cdp, `caches.keys().then((keys) => keys.some((key) => key.startsWith('fanotes-web-')))`, 'Der versionsgebundene App-Cache')
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
    await cdp.send('Page.reload', { ignoreCache: true })
    await waitFor(cdp, `Boolean(window.lernwerk?.platform === 'web' && document.querySelector('.markdown-editor .cm-content'))`, 'Der vollständige Editor im Offline-Modus')
    const offlineContent = await cdp.evaluate(`window.lernwerk.readFile('Mathematik/Web Persistenz.md')`)
    if (!offlineContent.includes('x^2')) throw new Error('Der Web-Vault war offline nicht verfügbar.')
    if (!externalUrl && !analyticsEvents.includes('web_app_open')) throw new Error('Der anonyme Web-App-Start wurde nicht aggregiert gemeldet.')

    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
    const relevantErrors = errors.filter((message) => message && !message.includes('ERR_INTERNET_DISCONNECTED'))
    if (relevantErrors.length) throw new Error(`Browserfehler: ${relevantErrors.join(' | ')}`)
    console.log(`Web-Prüfung erfolgreich: 4-stufiges Profil-Onboarding, dauerhafte Welcome.md-Reparatur, zweisprachige Rechtschreibung, sechs AI-Anbieter mit flüchtigen Cloud-Schlüsseln, Markdown, Suche, Zeichnungen, Bildimport, IndexedDB-Persistenz, optionales Server-Backup, PWA-Cache und Offline-Neustart. Screenshots: ${onboardingScreenshotPath}, ${welcomeRepairScreenshotPath}, ${backupScreenshotPath}, ${screenshotPath}`)
  } finally {
    socket?.close()
    chromium.kill('SIGTERM')
    if (!externalUrl) server.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
