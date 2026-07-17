'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const executable = path.resolve(process.argv[2] || path.join(__dirname, '..', 'release', 'linux-unpacked', 'fanotes'))
const timeoutMs = 20_000
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-visual-check-'))
const output = path.join(temporary, 'screenshots')
const home = path.join(temporary, 'home')
const configHome = path.join(temporary, 'config')
const runtime = path.join(temporary, 'runtime')
const vault = path.join(home, 'Visual-Vault')
const userData = path.join(configHome, 'FaNotes')

for (const directory of [output, vault, userData, runtime]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
fs.mkdirSync(path.join(vault, 'Mathematik'), { recursive: true, mode: 0o700 })
fs.writeFileSync(path.join(vault, 'Mathematik', 'Darstellung.md'), `# Visueller Systemtest

Normaler Fliesstext bleibt auf der Papierseite gut lesbar. **Fett**, *kursiv* und ~~durchgestrichen~~ werden live dargestellt.

Das ist ein Tset für die deutsche Rechtschreibprüfung.
This is an exampel for the English spell checker.

- [ ] Offene Aufgabe
- [x] Erledigte Aufgabe

Inline-Mathematik: $E = mc^2$

$$
\\int_0^5 x^2 \\, dx = \\frac{125}{3}
$$

<details open>
<summary>Einklappbarer Lerninhalt</summary>

Der Inhalt wird ohne Layoutsprung nachgeladen.

</details>

${Array.from({ length: 70 }, (_, index) => `Zusätzliche Prüfzeile ${index + 1}: Auswahl und Scrollen bleiben flüssig.`).join('\n\n')}
`)
fs.writeFileSync(path.join(userData, 'config.json'), `${JSON.stringify({
  version: 3,
  vaultPath: vault,
  settings: {
    uiLanguage: 'de',
    autoCheckUpdates: false,
    autoDownloadUpdates: false,
    spellcheck: true,
    reduceMotion: true,
  },
  onboarding: { version: 1, completed: true },
}, null, 2)}\n`, { mode: 0o600 })

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function connect(port, child) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`FaNotes wurde zu früh mit Code ${child.exitCode} beendet.`)
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
    } catch {
      // Chromium is still opening its debugging endpoint.
    }
    await wait(25)
  }
  throw new Error('FaNotes hat den Renderer nicht rechtzeitig gestartet.')
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
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Renderer-Auswertung fehlgeschlagen.')
      return result.result?.value
    },
  }
}

async function waitFor(cdp, expression, description) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return
    await wait(40)
  }
  throw new Error(`${description} wurde nicht rechtzeitig dargestellt.`)
}

async function capture(cdp, name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(result.data, 'base64'))
}

void (async () => {
  if (process.platform !== 'linux') throw new Error('Der echte Rendering-Smoke-Test ist für den Linux-Build vorgesehen.')
  if (!fs.existsSync(executable)) throw new Error(`FaNotes-Programm nicht gefunden: ${executable}`)

  const port = 19_000 + Math.floor(Math.random() * 20_000)
  const child = spawn('xvfb-run', ['-a', executable, `--remote-debugging-port=${port}`], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_RUNTIME_DIR: runtime },
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
  let socket
  try {
    try {
      socket = await connect(port, child)
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ''}`)
    }
    const cdp = createCdp(socket)
    const rendererErrors = []
    cdp.onEvent((message) => {
      if (message.method === 'Runtime.exceptionThrown') rendererErrors.push(message.params?.exceptionDetails?.text || 'Unbekannte Renderer-Ausnahme')
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        const entry = message.params.entry
        rendererErrors.push(`${entry.text}${entry.url ? ` (${entry.url})` : ''}`)
      }
    })
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Page.enable')
    await cdp.evaluate(`localStorage.setItem('fanotes.uiLanguage', 'de'); location.reload()`)

    await waitFor(cdp, `Boolean(document.querySelector('.markdown-editor .cm-content'))`, 'Der Live-Editor')
    await waitFor(cdp, `document.querySelectorAll('.katex').length >= 2`, 'Die mathematische Darstellung')
    await waitFor(cdp, `Boolean(document.querySelector('.cm-live-details'))`, 'Der einklappbare Markdown-Bereich')
    const spellingResources = await cdp.evaluate(`window.lernwerk.loadSpellingResources()
      .then((resources) => ({ format: resources.manifest?.format, de: resources.de?.byteLength, en: resources.en?.byteLength }))
      .catch((error) => ({ error: error?.message || String(error) }))`)
    if (spellingResources.error || spellingResources.format !== 'fanotes-spelling-bloom-v2' || spellingResources.de < 400000 || spellingResources.en < 150000) {
      throw new Error(`Die eingebetteten Rechtschreibressourcen sind ungültig: ${JSON.stringify(spellingResources)}`)
    }
    await waitFor(cdp, `Boolean([...document.querySelectorAll('.cm-spelling-error')].find((node) => node.dataset.spellingWord === 'Tset')) && Boolean([...document.querySelectorAll('.cm-spelling-error')].find((node) => node.dataset.spellingWord === 'exampel'))`, 'Die zweisprachige Rechtschreibmarkierung')
    const spelling = await cdp.evaluate(`(() => ({
      words: [...document.querySelectorAll('.cm-spelling-error')].map((node) => node.dataset.spellingWord).sort(),
      languages: [...document.querySelectorAll('.cm-spelling-error')].map((node) => node.dataset.spellingLanguage).sort(),
      detected: document.querySelector('.markdown-editor .cm-editor')?.dataset.detectedLanguage,
      status: document.querySelector('.detected-text-language')?.textContent.trim(),
      decoration: getComputedStyle(document.querySelector('.cm-spelling-error')).textDecorationStyle,
    }))()`)
    if (!spelling.words.includes('Tset') || !spelling.words.includes('exampel') || !spelling.languages.includes('de') || !spelling.languages.includes('en') || spelling.detected !== 'mixed' || !spelling.status.includes('DE / EN') || spelling.decoration !== 'wavy') {
      throw new Error(`Die automatische Rechtschreibprüfung ist visuell unvollständig: ${JSON.stringify(spelling)}`)
    }

    const dragStart = await cdp.evaluate(`(() => {
      const scroller = document.querySelector('.unified-note-view')
      const content = document.querySelector('.markdown-editor .cm-content')
      scroller.scrollTop = 0
      const bounds = scroller.getBoundingClientRect()
      const contentBounds = content.getBoundingClientRect()
      return {
        x: Math.min(contentBounds.right - 12, contentBounds.left + 100),
        y: Math.max(bounds.top + 20, contentBounds.top + 24),
        outsideBottom: bounds.bottom + 72,
      }
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragStart.x, y: dragStart.y, button: 'left', buttons: 1, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragStart.x, y: dragStart.outsideBottom, button: 'left', buttons: 1 })
    await wait(420)
    const selectionAutoScroll = await cdp.evaluate(`(() => {
      const scroller = document.querySelector('.unified-note-view')
      const selection = window.getSelection()
      return {
        scrollTop: scroller.scrollTop,
        selectedLength: selection?.toString().length ?? 0,
      }
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragStart.x, y: dragStart.outsideBottom, button: 'left', buttons: 0, clickCount: 1 })
    if (selectionAutoScroll.scrollTop < 24 || selectionAutoScroll.selectedLength < 8) {
      throw new Error(`Die Textauswahl scrollt am Seitenrand nicht automatisch weiter: ${JSON.stringify(selectionAutoScroll)}`)
    }
    const dragBack = await cdp.evaluate(`(() => {
      const scroller = document.querySelector('.unified-note-view')
      scroller.scrollTop = scroller.scrollHeight
      const bounds = scroller.getBoundingClientRect()
      window.__fanotesDragDebug = []
      for (const type of ['pointerdown', 'pointermove', 'mousedown', 'mousemove']) {
        window.addEventListener(type, (event) => window.__fanotesDragDebug.push({
          type,
          target: event.target?.className || event.target?.tagName,
          buttons: event.buttons,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        }), { capture: true, once: type.endsWith('down') })
      }
      return {
        x: bounds.left + 120,
        y: bounds.bottom - 24,
        outsideTop: bounds.top - 72,
        startTop: scroller.scrollTop,
        hit: document.elementFromPoint(bounds.left + 120, bounds.bottom - 24)?.className,
        bounds: { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right },
      }
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragBack.x, y: dragBack.y, button: 'left', buttons: 1, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragBack.x, y: dragBack.outsideTop, button: 'left', buttons: 1 })
    await wait(420)
    const upwardState = await cdp.evaluate(`({
      top: document.querySelector('.unified-note-view').scrollTop,
      debug: window.__fanotesDragDebug,
    })`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragBack.x, y: dragBack.outsideTop, button: 'left', buttons: 0, clickCount: 1 })
    if (upwardState.top > dragBack.startTop - 24) {
      throw new Error(`Die Textauswahl scrollt am oberen Seitenrand nicht zurück: ${JSON.stringify({ upwardState, dragBack })}`)
    }
    await cdp.evaluate(`document.querySelector('.unified-note-view').scrollTop = 0`)

    const themes = ['dark', 'light', 'midnight', 'forest', 'aurora', 'sepia']
    for (const theme of themes) {
      await cdp.evaluate(`(() => {
        const shell = document.querySelector('.app-shell')
        for (const name of ${JSON.stringify(themes)}) shell.classList.remove('theme-' + name)
        shell.classList.add('theme-${theme}')
        return true
      })()`)
      await wait(80)
      await capture(cdp, `theme-${theme}`)
    }

    await cdp.evaluate(`document.querySelector('button[aria-label="Einstellungen öffnen"]').click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.settings-modal'))`, 'Das Einstellungsfenster')
    const settingsLayout = await cdp.evaluate(`(() => {
      const bounds = document.querySelector('.settings-modal').getBoundingClientRect()
      return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom }
    })()`)
    if (settingsLayout.left < 0 || settingsLayout.top < 0 || settingsLayout.right > 1480 || settingsLayout.bottom > 940) {
      throw new Error(`Das Einstellungsfenster liegt ausserhalb des sichtbaren Bereichs: ${JSON.stringify(settingsLayout)}`)
    }
    const settingsNavigation = await cdp.evaluate(`(() => ({
      groups: [...document.querySelectorAll('.settings-nav-group > small')].map((node) => node.textContent.trim()),
      sections: document.querySelectorAll('.settings-nav-group > button').length,
      searchPlaceholder: document.querySelector('.settings-search input')?.placeholder,
    }))()`)
    if (settingsNavigation.groups.join('|') !== 'Aussehen & Schreiben|Stift & Arbeitsbereich|FaNotes & System' || settingsNavigation.sections !== 7 || settingsNavigation.searchPlaceholder !== 'Einstellungen suchen') {
      throw new Error(`Die neue Einstellungsnavigation ist unvollständig: ${JSON.stringify(settingsNavigation)}`)
    }
    await capture(cdp, 'settings')
    await cdp.evaluate(`document.querySelector('.settings-search input').focus()`)
    await cdp.send('Input.insertText', { text: 'Rechtschreibung' })
    await waitFor(cdp, `Boolean([...document.querySelectorAll('.settings-search-results button')].find((button) => button.textContent.includes('Rechtschreibprüfung')))`, 'Die direkte Einstellungssuche')
    await cdp.evaluate(`[...document.querySelectorAll('.settings-search-results button')].find((button) => button.textContent.includes('Rechtschreibprüfung')).click()`)
    await waitFor(cdp, `document.querySelector('#settings-editor') && document.querySelector('.settings-nav-group button.active')?.textContent.includes('Editor')`, 'Den gesuchten Editor-Bereich')
    await cdp.evaluate(`document.querySelector('.settings-search input').select()`)
    await cdp.send('Input.insertText', { text: 'OneNote' })
    await waitFor(cdp, `Boolean([...document.querySelectorAll('.settings-search-results button')].find((button) => button.textContent.includes('Microsoft OneNote')))`, 'Den OneNote-Import in der Einstellungssuche')
    await cdp.evaluate(`[...document.querySelectorAll('.settings-search-results button')].find((button) => button.textContent.includes('Microsoft OneNote')).click()`)
    await waitFor(cdp, `Boolean(document.querySelector('#settings-onenote .onenote-preservation-grid'))`, 'Die OneNote-Importeinstellungen')
    const oneNoteSettings = await cdp.evaluate(`(() => ({
      title: document.querySelector('#settings-onenote .setting-card-title span')?.textContent,
      formats: document.querySelector('#settings-onenote .onenote-import-actions strong')?.textContent,
      safety: [...document.querySelectorAll('#settings-onenote .onenote-preservation-grid small')].some((node) => node.textContent.includes('niemals ausführbar')),
    }))()`)
    if (oneNoteSettings.title !== 'Microsoft OneNote Import' || !oneNoteSettings.formats.includes('.onepkg') || !oneNoteSettings.safety) throw new Error(`Die OneNote-Einstellungen sind unvollständig: ${JSON.stringify(oneNoteSettings)}`)
    await capture(cdp, 'settings-onenote')
    await cdp.evaluate(`document.querySelector('.settings-modal button[aria-label="Schließen"]').click()`)
    await waitFor(cdp, `!document.querySelector('.settings-modal')`, 'Das Schliessen des Einstellungsfensters')

    await cdp.evaluate(`document.querySelector('button[aria-label="AI-Assistent öffnen"]').click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.ai-panel'))`, 'Der gemeinsame AI-Bereich')
    const aiPanel = await cdp.evaluate(`(() => {
      const panel = document.querySelector('.ai-panel')
      const bounds = panel.getBoundingClientRect()
      return {
        title: panel.querySelector('h2')?.textContent,
        providers: [...panel.querySelectorAll('.ai-provider-grid > button strong')].map((node) => node.textContent),
        selected: panel.querySelectorAll('.ai-provider-grid > button[aria-selected="true"]').length,
        bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
      }
    })()`)
    if (aiPanel.title !== 'AI' || aiPanel.providers.join('|') !== 'LM Studio|Ollama|OpenAI|Gemini|Anthropic|OpenCode' || aiPanel.selected !== 1 || aiPanel.bounds.left < 0 || aiPanel.bounds.top < 0 || aiPanel.bounds.right > 1480 || aiPanel.bounds.bottom > 940) {
      throw new Error(`Der AI-Bereich ist unvollständig oder verlässt das Fenster: ${JSON.stringify(aiPanel)}`)
    }
    await cdp.evaluate(`[...document.querySelectorAll('.ai-provider-grid > button')].find((button) => button.textContent.includes('OpenCode'))?.click()`)
    await waitFor(cdp, `Boolean([...document.querySelectorAll('.ai-privacy-note strong')].find((node) => node.textContent.includes('Sicherer Vorschau-Modus')))`, 'Die OpenCode-Sicherheitsanzeige')
    await capture(cdp, 'ai-providers')
    await cdp.evaluate(`document.querySelector('.ai-panel button[aria-label="AI-Menü schließen"]').click()`)
    await waitFor(cdp, `!document.querySelector('.ai-panel')`, 'Das Schliessen des AI-Bereichs')

    await cdp.evaluate(`document.querySelector('.toolbar-button.menu-trigger')?.click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.editor-more-menu'))`, 'Das gruppierte Notizmenü')
    const noteMenu = await cdp.evaluate(`(() => {
      const menu = document.querySelector('.editor-more-menu')
      const bounds = menu.getBoundingClientRect()
      return {
        buttons: menu.querySelectorAll(':scope > button').length,
        labels: [...menu.querySelectorAll('.editor-menu-label')].map((node) => node.textContent.trim()),
        title: menu.querySelector('header strong')?.textContent,
        bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
      }
    })()`)
    if (noteMenu.buttons !== 3 || noteMenu.title !== 'Notizmenü' || noteMenu.labels.join('|') !== 'Ansicht|Datei' || noteMenu.bounds.left < 0 || noteMenu.bounds.top < 0 || noteMenu.bounds.right > 1480 || noteMenu.bounds.bottom > 940) {
      throw new Error(`Das neue Notizmenü ist unvollständig oder verlässt das Fenster: ${JSON.stringify(noteMenu)}`)
    }
    await capture(cdp, 'note-menu')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await waitFor(cdp, `!document.querySelector('.editor-more-menu')`, 'Das Schliessen des Notizmenüs')

    const activeTreeRow = await cdp.evaluate(`(() => {
      const bounds = document.querySelector('.file-tree__item.is-active .file-tree__row').getBoundingClientRect()
      return { x: bounds.left + bounds.width * .5, y: bounds.top + bounds.height * .5 }
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: activeTreeRow.x, y: activeTreeRow.y, button: 'right', buttons: 2, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: activeTreeRow.x, y: activeTreeRow.y, button: 'right', buttons: 0, clickCount: 1 })
    await waitFor(cdp, `Boolean(document.querySelector('.file-tree__context-menu .file-tree__menu-head'))`, 'Das gruppierte Datei-Kontextmenü')
    const fileMenu = await cdp.evaluate(`(() => ({
      title: document.querySelector('.file-tree__menu-head strong')?.textContent,
      type: document.querySelector('.file-tree__menu-head small')?.textContent,
      labels: [...document.querySelectorAll('.file-tree__context-menu .file-tree__menu-label')].map((node) => node.textContent.trim()),
      buttons: document.querySelectorAll('.file-tree__context-menu > button').length,
    }))()`)
    if (fileMenu.title !== 'Darstellung' || fileMenu.type !== 'Notiz' || fileMenu.labels.join('|') !== 'Verwalten' || fileMenu.buttons !== 2) {
      throw new Error(`Das Datei-Kontextmenü ist nicht klar gruppiert: ${JSON.stringify(fileMenu)}`)
    }
    await capture(cdp, 'file-menu')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await waitFor(cdp, `!document.querySelector('.file-tree__context-menu')`, 'Das Schliessen des Datei-Kontextmenüs')

    await cdp.evaluate(`document.querySelector('.sidebar > .sidebar-search input').focus()`)
    await waitFor(cdp, `Boolean(document.querySelector('.search-panel input:focus'))`, 'Die direkt schreibbare Vault-Suche')
    await cdp.send('Input.insertText', { text: 'Darstellung' })
    await waitFor(cdp, `document.querySelectorAll('.search-results > button').length >= 1`, 'Ein Suchergebnis aus Text und Dateinamen')
    const searchExperience = await cdp.evaluate(`(() => ({
      query: document.querySelector('.search-panel input').value,
      summary: document.querySelector('.search-summary').textContent,
      sidebarQuery: document.querySelector('.sidebar > .sidebar-search input')?.value,
    }))()`)
    if (searchExperience.query !== 'Darstellung' || searchExperience.sidebarQuery !== 'Darstellung' || !searchExperience.summary.includes('Treffer')) {
      throw new Error(`Die direkte Vault-Suche ist nicht synchron: ${JSON.stringify(searchExperience)}`)
    }
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await waitFor(cdp, `!document.querySelector('.search-panel')`, 'Das Schliessen der Suche mit Escape')

    await cdp.evaluate(`document.querySelector('button[title^="Auf derselben Seite"]').click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.lw-drawing-board.is-inline.is-input-active .lw-tablet-canvas'))`, 'Die Stiftebene')
    await waitFor(cdp, `Boolean(document.querySelector('.lw-drawing-board.is-inline.is-input-active .lw-draw-footer'))`, 'Die untere Handschriftleiste')
    await waitFor(cdp, `Boolean(document.querySelector('.lw-drawing-board.is-inline .lw-draw-footer > div:first-child button'))`, 'Der optionale GlyphenWerk-Knopf ohne persönliches Training')
    const inkLayout = await cdp.evaluate(`(() => {
      const footer = document.querySelector('.lw-drawing-board.is-inline .lw-draw-footer').getBoundingClientRect()
      const status = document.querySelector('.statusbar').getBoundingClientRect()
      const toolbar = document.querySelector('.lw-drawing-board.is-inline .lw-draw-toolbar').getBoundingClientRect()
      return {
        footer: { left: footer.left, top: footer.top, right: footer.right, bottom: footer.bottom },
        status: { top: status.top, bottom: status.bottom },
        toolbar: { left: toolbar.left, top: toolbar.top, right: toolbar.right, bottom: toolbar.bottom },
      }
    })()`)
    if (inkLayout.footer.bottom > inkLayout.status.top || inkLayout.footer.left < 0 || inkLayout.footer.right > 1480) {
      throw new Error(`Die untere Handschriftleiste überlappt oder verlässt das Fenster: ${JSON.stringify(inkLayout)}`)
    }
    if (inkLayout.toolbar.left < 0 || inkLayout.toolbar.right > 1480 || inkLayout.toolbar.top < 0) {
      throw new Error(`Die Stiftwerkzeuge verlassen den sichtbaren Bereich: ${JSON.stringify(inkLayout)}`)
    }
    await capture(cdp, 'pen-layer')

    await cdp.evaluate(`[...document.querySelectorAll('.lw-draw-toolbar button')].find((button) => button.title?.startsWith('Zeichenstudio mit Pinseln'))?.click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.lw-drawing-board.is-art-mode .lw-art-studio'))`, 'Das Zeichenstudio')
    const artStudio = await cdp.evaluate(`(() => {
      const panel = document.querySelector('.lw-art-studio').getBoundingClientRect()
      return {
        tabs: document.querySelectorAll('.lw-art-studio-tabs > button').length,
        brushes: document.querySelectorAll('.lw-art-brushes > button').length,
        colors: document.querySelectorAll('.lw-art-solid-colors > button').length,
        specialInks: document.querySelectorAll('.lw-art-special-inks > button').length,
        symbols: document.querySelectorAll('.lw-art-symbols > button').length,
        symbolCategories: document.querySelectorAll('.lw-art-symbol-categories > button').length,
        bounds: { left: panel.left, top: panel.top, right: panel.right, bottom: panel.bottom },
        conversionActionsVisible: [...document.querySelectorAll('.lw-draw-footer button')].some((button) => button.textContent.includes('konvertieren')),
      }
    })()`)
    if (artStudio.tabs !== 3 || artStudio.brushes !== 8 || artStudio.colors !== 0 || artStudio.specialInks !== 0 || artStudio.symbols !== 0 || artStudio.symbolCategories !== 0 || artStudio.conversionActionsVisible) {
      throw new Error(`Das Zeichenstudio ist unvollständig oder mit Handschriftaktionen vermischt: ${JSON.stringify(artStudio)}`)
    }
    if (artStudio.bounds.left < 0 || artStudio.bounds.top < 0 || artStudio.bounds.right > 1480 || artStudio.bounds.bottom > 940) {
      throw new Error(`Das Zeichenstudio verlässt das Fenster: ${JSON.stringify(artStudio.bounds)}`)
    }
    await cdp.evaluate(`[...document.querySelectorAll('.lw-art-brushes > button')].find((button) => button.title?.startsWith('Spray:'))?.click()`)
    await cdp.evaluate(`document.querySelector('.lw-art-studio-tabs > button[aria-controls="lw-art-colors-panel"]')?.click()`)
    await waitFor(cdp, `document.querySelectorAll('.lw-art-solid-colors > button').length >= 14 && document.querySelectorAll('.lw-art-special-inks > button').length === 7 && document.querySelectorAll('.lw-art-studio-body > [role="tabpanel"]').length === 1`, 'Den übersichtlichen Farbbereich')
    await cdp.evaluate(`[...document.querySelectorAll('.lw-art-special-inks > button')].find((button) => button.textContent.includes('Aurora'))?.click()`)
    await waitFor(cdp, `Boolean([...document.querySelectorAll('.lw-art-special-inks > button[aria-pressed="true"]')].some((button) => button.textContent.includes('Aurora')))`, 'Aurora-Spezialtinte')
    const artCanvas = await cdp.evaluate(`(() => {
      const bounds = document.querySelector('.lw-tablet-canvas-live.tool-art').getBoundingClientRect()
      return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }
    })()`)
    const artStart = { x: artCanvas.left + artCanvas.width * .22, y: artCanvas.top + artCanvas.height * .57 }
    const artEnd = { x: artCanvas.left + artCanvas.width * .66, y: artCanvas.top + artCanvas.height * .66 }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: artStart.x, y: artStart.y, button: 'left', buttons: 1, clickCount: 1 })
    for (let step = 1; step <= 14; step += 1) {
      const progress = step / 14
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: artStart.x + (artEnd.x - artStart.x) * progress,
        y: artStart.y + (artEnd.y - artStart.y) * progress + Math.sin(progress * Math.PI * 2) * 18,
        button: 'left',
        buttons: 1,
      })
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: artEnd.x, y: artEnd.y, button: 'left', buttons: 0, clickCount: 1 })
    await waitFor(cdp, `Boolean(document.querySelector('.lw-draw-toolbar button[aria-label="Rückgängig"]:not(:disabled)'))`, 'Ein gezeichneter Kunststrich')
    await waitFor(cdp, `window.lernwerk.listDrawings().then((items) => items.length > 0)`, 'Die automatische Speicherung der Zeichnung')
    const savedArt = await cdp.evaluate(`(async () => {
      const drawings = await window.lernwerk.listDrawings()
      const loaded = await window.lernwerk.readDrawing(drawings[0].id)
      const document = JSON.parse(loaded.drawingJson)
      const stroke = document.strokes.at(-1)
      return {
        purpose: stroke?.purpose,
        brush: stroke?.brush,
        colorEffect: stroke?.colorEffect,
        opacity: stroke?.opacity,
        textureSeed: stroke?.textureSeed,
        transcript: document.searchTranscript,
      }
    })()`)
    if (savedArt.purpose !== 'art' || savedArt.brush !== 'spray' || savedArt.colorEffect !== 'aurora' || savedArt.opacity !== 1 || !Number.isSafeInteger(savedArt.textureSeed) || savedArt.transcript) {
      throw new Error(`Der Kunststrich wurde nicht stabil und getrennt von der Handschrifterkennung gespeichert: ${JSON.stringify(savedArt)}`)
    }
    await cdp.evaluate(`document.querySelector('.lw-art-studio-tabs > button[aria-controls="lw-art-symbols-panel"]')?.click()`)
    await waitFor(cdp, `document.querySelectorAll('.lw-art-symbols > button').length === 25 && document.querySelectorAll('.lw-art-symbol-categories > button').length === 4 && document.querySelectorAll('.lw-art-studio-body > [role="tabpanel"]').length === 1`, 'Den übersichtlichen Piktogrammbereich')
    await cdp.evaluate(`document.querySelector('button[title="Stern einfügen"]')?.click()`)
    await waitFor(cdp, `Boolean(document.querySelector('input[aria-label="Piktogrammdrehung"]'))`, 'Die Einstellungen des Stern-Piktogramms')
    await cdp.evaluate(`(() => {
      const rotation = document.querySelector('input[aria-label="Piktogrammdrehung"]')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(rotation, '35')
      rotation.dispatchEvent(new Event('input', { bubbles: true }))
      rotation.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await waitFor(cdp, `document.querySelector('input[aria-label="Piktogrammdrehung"]')?.value === '35'`, 'Die Drehung des Stern-Piktogramms')
    await waitFor(cdp, `Boolean(document.querySelector('.lw-tablet-canvas-live.tool-stamp') && document.querySelector('button[title="Stern einfügen"][aria-pressed="true"]'))`, 'Das direkte Stern-Piktogrammwerkzeug')
    await cdp.evaluate(`document.querySelector('.lw-art-studio button[aria-label="Zeichenstudio einklappen"]')?.click()`)
    await waitFor(cdp, `!document.querySelector('.lw-art-studio')`, 'Das Einklappen der Piktogrammbibliothek')
    const symbolPoint = { x: artCanvas.left + artCanvas.width * .76, y: artCanvas.top + artCanvas.height * .68 }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: symbolPoint.x, y: symbolPoint.y, button: 'left', buttons: 1, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: symbolPoint.x, y: symbolPoint.y, button: 'left', buttons: 0, clickCount: 1 })
    await waitFor(cdp, `window.lernwerk.listDrawings().then(async (items) => {
      const loaded = await window.lernwerk.readDrawing(items[0].id)
      return JSON.parse(loaded.drawingJson).strokes.at(-1)?.symbolId === 'star'
    })`, 'Die automatische Speicherung des Stern-Piktogramms')
    const savedSymbol = await cdp.evaluate(`(async () => {
      const drawings = await window.lernwerk.listDrawings()
      const loaded = await window.lernwerk.readDrawing(drawings[0].id)
      const document = JSON.parse(loaded.drawingJson)
      const stroke = document.strokes.at(-1)
      return {
        purpose: stroke?.purpose,
        symbolId: stroke?.symbolId,
        symbolRotation: stroke?.symbolRotation,
        baseWidth: stroke?.baseWidth,
        points: stroke?.points?.length,
        transcript: document.searchTranscript,
      }
    })()`)
    if (savedSymbol.purpose !== 'art' || savedSymbol.symbolId !== 'star' || savedSymbol.symbolRotation !== 35 || savedSymbol.baseWidth !== 72 || savedSymbol.points !== 1 || savedSymbol.transcript) {
      throw new Error(`Das Piktogramm wurde nicht korrekt platziert oder gespeichert: ${JSON.stringify(savedSymbol)}`)
    }
    await cdp.evaluate(`document.querySelector('.lw-art-studio-trigger')?.click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.lw-art-studio'))`, 'Das erneute Öffnen der Piktogrammbibliothek')
    await capture(cdp, 'drawing-studio')
    await cdp.evaluate(`[...document.querySelectorAll('.lw-draw-toolbar button')].find((button) => button.title?.startsWith('Handschrift schreiben'))?.click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.lw-drawing-board.is-writing-mode')) && !document.querySelector('.lw-art-studio')`, 'Die Rückkehr zum Handschriftmodus')
    const handwritingCanvas = await cdp.evaluate(`(() => {
      const bounds = document.querySelector('.lw-tablet-canvas-live.tool-pen').getBoundingClientRect()
      return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }
    })()`)
    const handX = handwritingCanvas.left + handwritingCanvas.width * .46
    const handTop = handwritingCanvas.top + handwritingCanvas.height * .28
    const handBottom = handwritingCanvas.top + handwritingCanvas.height * .39
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handX, y: handTop, button: 'left', buttons: 1, clickCount: 1 })
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: handX,
        y: handTop + (handBottom - handTop) * step / 8,
        button: 'left',
        buttons: 1,
      })
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handX, y: handBottom, button: 'left', buttons: 0, clickCount: 1 })
    await cdp.evaluate(`[...document.querySelectorAll('.lw-draw-footer button')].find((button) => button.textContent.includes('Seite konvertieren'))?.click()`)
    await waitFor(cdp, `Boolean(document.querySelector('.lw-conversion-panel .lw-model-card > span.is-ready'))`, 'Das erst bei Bedarf geladene Handschriftmodell')
    await waitFor(cdp, `Boolean(document.querySelector('.lw-conversion-panel textarea'))`, 'Die Handschriftkonvertierung nach dem Lazy-Load')
    await cdp.evaluate(`document.querySelector('.lw-conversion-head button[aria-label="Konvertierung schließen"]')?.click()`)
    await cdp.evaluate(`document.querySelector('button[title="Zur Tastatureingabe wechseln"]').click()`)

    await cdp.evaluate(`(() => {
      const shell = document.querySelector('.app-shell')
      for (const name of ${JSON.stringify(['dark', 'light', 'midnight', 'forest', 'aurora', 'sepia'])}) shell.classList.remove('theme-' + name)
      shell.classList.add('theme-dark')
      document.querySelector('button[title="GlyphenWerk"]').click()
      return true
    })()`)
    await waitFor(cdp, `Boolean(document.querySelector('.glyphenwerk-frame'))`, 'Der GlyphenWerk-Arbeitsbereich')
    await waitFor(cdp, `Boolean(document.querySelector('.glyphenwerk-frame').contentDocument?.querySelector('#root'))`, 'Der eingebettete GlyphenWerk-Renderer')
    await waitFor(cdp, `document.querySelector('.glyphenwerk-frame').contentDocument?.documentElement?.dataset.fanotesTheme === 'dark'`, 'Die GlyphenWerk-Theme-Brücke')
    const glyphenWerkAppearance = await cdp.evaluate(`(() => {
      const host = document.querySelector('.app-shell')
      const child = document.querySelector('.glyphenwerk-frame').contentDocument
      return {
        theme: child.documentElement.dataset.fanotesTheme,
        hostPanel: getComputedStyle(host).getPropertyValue('--panel').trim(),
        childPanel: child.documentElement.style.getPropertyValue('--fanotes-panel').trim(),
        hostAccent: getComputedStyle(host).getPropertyValue('--accent').trim(),
        childAccent: child.documentElement.style.getPropertyValue('--fanotes-accent').trim(),
        childPanelBackground: getComputedStyle(child.querySelector('.panel')).backgroundColor,
      }
    })()`)
    if (
      glyphenWerkAppearance.theme !== 'dark'
      || glyphenWerkAppearance.childPanel !== glyphenWerkAppearance.hostPanel
      || glyphenWerkAppearance.childAccent !== glyphenWerkAppearance.hostAccent
      || glyphenWerkAppearance.childPanelBackground === 'rgba(0, 0, 0, 0)'
    ) throw new Error(`GlyphenWerk hat das FaNotes-Theme nicht vollständig übernommen: ${JSON.stringify(glyphenWerkAppearance)}`)
    await cdp.evaluate(`[...document.querySelectorAll('.glyphenwerk-sidebar-nav button')].find((button) => button.textContent.includes('Erkennung testen')).click()`)
    await waitFor(cdp, `document.querySelector('.glyphenwerk-frame').contentDocument?.querySelector('.automatic-mode-pill')?.textContent.includes('Text & Mathematik aktiv')`, 'Die gemeinsame GlyphenWerk-Erkennung')
    const glyphenWerkRecognitionUi = await cdp.evaluate(`(() => {
      const child = document.querySelector('.glyphenwerk-frame').contentDocument
      return {
        title: child.querySelector('h1')?.textContent.trim(),
        automatic: Boolean(child.querySelector('.automatic-mode-pill')),
        manualSwitch: Boolean(child.querySelector('.recognition-mode-switch')),
      }
    })()`)
    if (glyphenWerkRecognitionUi.title !== 'Text & Mathematik testen' || !glyphenWerkRecognitionUi.automatic || glyphenWerkRecognitionUi.manualSwitch) {
      throw new Error(`GlyphenWerk verwendet noch keine gemeinsame Text-/Mathematik-Oberfläche: ${JSON.stringify(glyphenWerkRecognitionUi)}`)
    }
    const glyphenWerkCanvas = await cdp.evaluate(`(() => {
      const frame = document.querySelector('.glyphenwerk-frame').getBoundingClientRect()
      const canvas = document.querySelector('.glyphenwerk-frame').contentDocument.querySelector('.drawing-canvas').getBoundingClientRect()
      return { left: frame.left + canvas.left, top: frame.top + canvas.top, width: canvas.width, height: canvas.height }
    })()`)
    const drawGlyphenWerkStroke = async (fromX, fromY, toX, toY) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1 })
      for (let index = 1; index <= 8; index += 1) {
        const progress = index / 8
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: fromX + (toX - fromX) * progress,
          y: fromY + (toY - fromY) * progress,
          button: 'left',
          buttons: 1,
        })
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1 })
    }
    const fractionCenter = glyphenWerkCanvas.left + glyphenWerkCanvas.width * .44
    await drawGlyphenWerkStroke(
      fractionCenter,
      glyphenWerkCanvas.top + glyphenWerkCanvas.height * .2,
      fractionCenter,
      glyphenWerkCanvas.top + glyphenWerkCanvas.height * .38,
    )
    await drawGlyphenWerkStroke(
      fractionCenter,
      glyphenWerkCanvas.top + glyphenWerkCanvas.height * .59,
      fractionCenter,
      glyphenWerkCanvas.top + glyphenWerkCanvas.height * .79,
    )
    await drawGlyphenWerkStroke(
      glyphenWerkCanvas.left + glyphenWerkCanvas.width * .31,
      glyphenWerkCanvas.top + glyphenWerkCanvas.height * .49,
      glyphenWerkCanvas.left + glyphenWerkCanvas.width * .57,
      glyphenWerkCanvas.top + glyphenWerkCanvas.height * .49,
    )
    await waitFor(cdp, `document.querySelector('.glyphenwerk-frame').contentDocument?.querySelector('.automatic-mode-pill.is-math')?.textContent.includes('Mathematik erkannt')`, 'Die automatische Mathematikerkennung in GlyphenWerk')
    await wait(120)
    await capture(cdp, 'glyphenwerk')
    await cdp.evaluate(`document.querySelector('.glyphenwerk-close').click()`)
    await waitFor(cdp, `!document.querySelector('.glyphenwerk-workspace')`, 'Das Schliessen von GlyphenWerk')

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 940, height: 640, deviceScaleFactor: 1, mobile: false })
    await wait(100)
    const layout = await cdp.evaluate(`(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector)
        if (!node) return null
        const bounds = node.getBoundingClientRect()
        return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height }
      }
      const required = ['.app-shell', '.ribbon', '.sidebar', '.workspace', '.editor-toolbar', '.unified-paper', '.statusbar']
      const rectangles = Object.fromEntries(required.map((selector) => [selector, rect(selector)]))
      return {
        viewport: { width: innerWidth, height: innerHeight },
        pageOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
        pageOverflowY: document.documentElement.scrollHeight > innerHeight + 1,
        rectangles,
        rawMathVisible: [...document.querySelectorAll('.cm-live-math-inline, .cm-live-math-block')].some((node) => !node.querySelector('.katex')),
      }
    })()`)
    const missing = Object.entries(layout.rectangles).filter(([, bounds]) => !bounds || bounds.width < 1 || bounds.height < 1).map(([selector]) => selector)
    if (missing.length) throw new Error(`Unsichtbare Kernbereiche bei 940 × 640: ${missing.join(', ')}`)
    if (layout.pageOverflowX || layout.pageOverflowY) throw new Error(`Unerwartetes Seiten-Overflow bei 940 × 640: ${JSON.stringify(layout)}`)
    if (layout.rawMathVisible) throw new Error('Mindestens eine sichtbare Formel blieb als unformatierter Quelltext stehen.')
    const status = layout.rectangles['.statusbar']
    if (Math.abs(status.bottom - layout.viewport.height) > 1) throw new Error('Die Statusleiste sitzt nicht bündig am unteren Fensterrand.')
    await capture(cdp, 'responsive-940x640')

    await cdp.evaluate(`document.querySelector('.tabs-menu').click()`)
    await waitFor(cdp, `document.querySelectorAll('.note-tab').length === 2`, 'Das Öffnen eines zweiten Tabs')
    const tabBeforeCycle = await cdp.evaluate(`document.querySelector('.note-tab.active')?.title`)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await waitFor(cdp, `document.querySelector('.note-tab.active')?.title !== ${JSON.stringify(tabBeforeCycle)}`, 'Der Tabwechsel mit Strg+Tab')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 })
    await waitFor(cdp, `document.querySelectorAll('.note-tab').length === 1`, 'Das Schliessen nur des aktiven Tabs mit Strg+W')

    if (rendererErrors.length) throw new Error(`Renderer-Fehler: ${rendererErrors.join(' | ')}`)
    console.log(`Renderingprüfung erfolgreich: ${themes.length} Themes, zweisprachige Rechtschreibung, AI-Provider, Suche, Tabs, Mathematik, Klappbereich, Einstellungen, Stift- und Zeichenmodus, GlyphenWerk und 940 × 640.`)
    console.log(`Screenshots: ${output}`)
    await cdp.evaluate('window.lernwerk.requestClose()')
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(1000)])
  } finally {
    socket?.close()
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  console.error(`Fehler-Screenshots und Testdaten bleiben zur Diagnose erhalten: ${temporary}`)
  process.exitCode = 1
})
