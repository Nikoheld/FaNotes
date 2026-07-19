'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const requestedExecutable = process.argv[2] ? path.resolve(process.argv[2]) : null
const executable = requestedExecutable || path.join(root, 'node_modules', 'electron', 'dist', 'electron')
const applicationArguments = requestedExecutable ? [] : [root]
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-note-check-'))
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Notizen')
const userData = path.join(configHome, 'FaNotes')
const timeoutMs = 20_000

for (const directory of [home, configHome, runtime, vault, userData]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
const legacyInternalDirectory = path.join(vault, '.lernwerk')
fs.mkdirSync(legacyInternalDirectory, { mode: 0o700 })
fs.writeFileSync(path.join(legacyInternalDirectory, 'migration-sentinel.json'), '{"preserved":true}\n', { mode: 0o600 })
fs.writeFileSync(path.join(vault, 'Vorhanden.md'), '# Vorhanden\n')
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: {
    uiLanguage: 'de',
    defaultFolder: 'Nicht mehr vorhanden',
    autoCheckUpdates: false,
    autoDownloadUpdates: false,
    reduceMotion: true,
  },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function connect(port, child) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`FaNotes wurde mit Code ${child.exitCode} beendet.`)
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
  throw new Error('FaNotes hat den Test-Renderer nicht rechtzeitig gestartet.')
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
    for (const listener of listeners) listener(message)
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
      if (!/Execution context was destroyed|Cannot find default execution context/iu.test(String(error?.message || error))) throw error
    }
    await wait(50)
  }
  throw new Error(`${label} wurde nicht rechtzeitig verfügbar.`)
}

const markdownFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  if (entry.name.startsWith('.')) return []
  const absolute = path.join(directory, entry.name)
  if (entry.isDirectory()) return markdownFiles(absolute)
  return entry.isFile() && entry.name.toLocaleLowerCase('en-US').endsWith('.md') ? [absolute] : []
})

void (async () => {
  if (!fs.existsSync(executable)) throw new Error(`FaNotes-Testprogramm fehlt: ${executable}`)
  if (!requestedExecutable && !fs.existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('Der Desktop-Build fehlt. Führe zuerst npm run build aus.')
  const port = 20_000 + Math.floor(Math.random() * 20_000)
  const child = spawn('xvfb-run', ['-a', executable, ...applicationArguments, `--remote-debugging-port=${port}`], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-6_000) })
  let socket
  try {
    socket = await connect(port, child)
    const cdp = createCdp(socket)
    const rendererErrors = []
    const rendererWarnings = []
    cdp.onEvent((message) => {
      if (message.method === 'Runtime.exceptionThrown') rendererErrors.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text)
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') rendererErrors.push(message.params.entry.text)
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'warning') rendererWarnings.push(message.params.entry.text)
    })
    await Promise.all([cdp.send('Runtime.enable'), cdp.send('Log.enable'), cdp.send('Page.enable')])
    await waitFor(cdp, `Boolean(window.fanotes && document.querySelector('.app-shell'))`, 'Die FaNotes-Oberfläche')

    await cdp.evaluate(`document.querySelector('.file-tree__root-actions button[aria-label="Neue Notiz"]').click()`)
    await waitFor(cdp, `document.querySelector('.note-tab.active')?.title?.endsWith('Unbenannte Notiz.md')`, 'Die sichtbare Notizerstellung')
    const uiPath = await cdp.evaluate(`document.querySelector('.note-tab.active').title`)
    const directResult = await cdp.evaluate(`window.fanotes.createNote(null, null)`)
    const directContent = await cdp.evaluate(`window.fanotes.readFile(${JSON.stringify(directResult.relativePath)})`)
    const files = markdownFiles(vault).map((file) => path.relative(vault, file).split(path.sep).join('/')).sort()
    const migratedSentinel = path.join(vault, '.fanotes', 'migration-sentinel.json')

    if (uiPath !== 'Unbenannte Notiz.md') throw new Error(`Die UI-Notiz wurde am falschen Ort angelegt: ${uiPath}`)
    if (directResult.relativePath !== 'Unbenannte Notiz 2.md' || !directContent.startsWith('# Unbenannte Notiz 2')) throw new Error(`Optionale IPC-Argumente wurden nicht sicher normalisiert: ${JSON.stringify(directResult)}`)
    if (files.join('|') !== 'Unbenannte Notiz 2.md|Unbenannte Notiz.md|Vorhanden.md') throw new Error(`Die Notizdateien sind unerwartet: ${files.join('|')}`)
    if (!fs.existsSync(migratedSentinel) || fs.existsSync(legacyInternalDirectory)) throw new Error('Die internen Vaultdaten wurden nicht sicher nach .fanotes migriert.')

    await cdp.evaluate(`(() => {
      window.__legacyTrainingSeed = 'pending'
      const request = indexedDB.open('lernwerk-notes-handwriting', 1)
      request.onupgradeneeded = () => {
        const database = request.result
        database.createObjectStore('samples', { keyPath: 'id' })
        database.createObjectStore('layoutExamples', { keyPath: 'id' })
        database.createObjectStore('labels', { keyPath: 'id' })
      }
      request.onerror = () => { window.__legacyTrainingSeed = 'error' }
      request.onsuccess = () => {
        const database = request.result
        const canvas = document.createElement('canvas')
        canvas.width = 64
        canvas.height = 64
        const context = canvas.getContext('2d')
        context.strokeStyle = '#111111'
        context.lineWidth = 4
        context.lineCap = 'round'
        context.beginPath()
        context.moveTo(18, 8)
        context.lineTo(18, 56)
        context.moveTo(18, 10)
        context.lineTo(50, 10)
        context.moveTo(18, 30)
        context.lineTo(42, 30)
        context.stroke()
        const strokes = [
          { baseWidth: 4, pressureEnabled: true, points: [{ x: 0.28, y: 0.12, t: 1, pressure: 0.6, tiltX: 0, tiltY: 0, pointerType: 'pen' }, { x: 0.28, y: 0.88, t: 2, pressure: 0.6, tiltX: 0, tiltY: 0, pointerType: 'pen' }] },
          { baseWidth: 4, pressureEnabled: true, points: [{ x: 0.28, y: 0.16, t: 3, pressure: 0.6, tiltX: 0, tiltY: 0, pointerType: 'pen' }, { x: 0.78, y: 0.16, t: 4, pressure: 0.6, tiltX: 0, tiltY: 0, pointerType: 'pen' }] },
          { baseWidth: 4, pressureEnabled: true, points: [{ x: 0.28, y: 0.47, t: 5, pressure: 0.6, tiltX: 0, tiltY: 0, pointerType: 'pen' }, { x: 0.66, y: 0.47, t: 6, pressure: 0.6, tiltX: 0, tiltY: 0, pointerType: 'pen' }] },
        ]
        const transaction = database.transaction('samples', 'readwrite')
        transaction.objectStore('samples').put({
          id: 'legacy-training-sentinel', labelId: 'latin_upper_F', label: 'F', labelName: 'Grosses F', latex: 'F', category: 'uppercase',
          writerId: 'migration-test', sessionId: 'migration-test', createdAt: new Date().toISOString(),
          imageData: canvas.toDataURL('image/png'), imageWidth: 64, imageHeight: 64,
          sourceCanvas: { width: 64, height: 64, devicePixelRatio: 1 }, bbox: [0.2, 0.08, 0.62, 0.82],
          strokes, strokeCount: 3, pointCount: 6, schemaVersion: 1,
        })
        transaction.oncomplete = () => { database.close(); window.__legacyTrainingSeed = 'ready' }
        transaction.onerror = () => { database.close(); window.__legacyTrainingSeed = 'error' }
      }
      return true
    })()`)
    await waitFor(cdp, `window.__legacyTrainingSeed === 'ready'`, 'Die bisherige Trainingsdaten-Testbasis')
    await cdp.evaluate(`document.querySelector('button[title="GlyphenWerk"]').click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.glyphenwerk-workspace'))`, 'GlyphenWerk für die Trainingsmigration')
    await waitFor(cdp, `/Beispiele direkt in FaNotes aktiv|Synchronisierung fehlgeschlagen/u.test(document.querySelector('.glyphenwerk-sync-state')?.textContent || '')`, 'Die GlyphenWerk-Synchronisierung')
    const glyphenWerkState = await cdp.evaluate(`document.querySelector('.glyphenwerk-sync-state')?.textContent?.trim() || ''`)
    if (/fehlgeschlagen/iu.test(glyphenWerkState)) throw new Error(`GlyphenWerk konnte die Trainingsmigration nicht ausführen: ${glyphenWerkState}`)
    await cdp.evaluate(`(() => {
      window.__trainingMigrationState = 'pending'
      const request = indexedDB.open('fanotes-handwriting', 1)
      request.onerror = () => { window.__trainingMigrationState = 'error' }
      request.onsuccess = () => {
        const database = request.result
        const sample = database.transaction('samples', 'readonly').objectStore('samples').get('legacy-training-sentinel')
        sample.onsuccess = () => { database.close(); window.__trainingMigrationState = sample.result?.labelId === 'latin_upper_F' ? 'ready' : 'missing' }
        sample.onerror = () => { database.close(); window.__trainingMigrationState = 'error' }
      }
      return true
    })()`)
    await waitFor(cdp, `window.__trainingMigrationState !== 'pending'`, 'Die persönliche Handschrift-Datenmigration')
    const trainingMigrationState = await cdp.evaluate(`window.__trainingMigrationState`)
    if (trainingMigrationState !== 'ready') {
      const databases = await cdp.evaluate(`indexedDB.databases().then((items) => items.map((item) => item.name))`)
      throw new Error(`Die persönliche Handschrift-Datenmigration ist unvollständig: Status=${trainingMigrationState}, Datenbanken=${JSON.stringify(databases)}, Warnungen=${JSON.stringify(rendererWarnings)}`)
    }
    const legacyTrainingDatabaseExists = await cdp.evaluate(`indexedDB.databases().then((databases) => databases.some((database) => database.name === 'lernwerk-notes-handwriting'))`)
    if (legacyTrainingDatabaseExists) throw new Error('Die übernommene frühere Handschrift-Datenbank wurde nicht bereinigt.')
    if (rendererErrors.length) throw new Error(`Rendererfehler bei der Notizerstellung: ${rendererErrors.join(' | ')}`)

    console.log(`FaNotes-Notizerstellung geprüft: UI=${uiPath}, IPC=${directResult.relativePath}`)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ''}`)
  } finally {
    socket?.close()
    if (child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
    }
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
