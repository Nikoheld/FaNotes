'use strict'

// Background OCR host. Reading text lines with the local TrOCR model is the CPU cost of document
// indexing (about nine tenths of it). It runs here, in its own hidden renderer process, instead of in
// the window the user types in:
//   - the process priority is lowered (below normal on Windows, nice 10 on Linux), so typing, pen input
//     and every other program come first;
//   - the number of OCR workers is bounded to at most half of the cores (see `workerCount`);
//   - the process is closed again a while after the last request, which returns its memory.
// Requests are event driven (IPC); nothing here polls.

const os = require('node:os')
const path = require('node:path')

const CHANNEL_LINE = 'fanotes-ocr-host:line'
const CHANNEL_RESULT = 'fanotes-ocr-host:result'
const CHANNEL_READY = 'fanotes-ocr-host:ready'
const MAX_LINE_PIXELS = 4096 * 1024 * 4
const READY_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 120_000

/** At most half of the cores, never more than 2 automatically; a configured limit can raise it to 4. */
const workerCount = (configured, cores = os.cpus().length) => {
  const half = Math.max(1, Math.floor(cores / 2))
  const wanted = Number.isSafeInteger(configured) && configured >= 1 ? Math.min(4, configured) : 2
  return Math.max(1, Math.min(wanted, half))
}

const lowerPriority = (webContents) => {
  try {
    const pid = webContents.getOSProcessId()
    if (pid > 0) os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    // Not permitted everywhere; the process still runs, only at normal priority.
  }
}

const validRequest = (request) => (
  request
  && typeof request === 'object'
  && Number.isSafeInteger(request.width) && request.width >= 8 && request.width <= 4096
  && Number.isSafeInteger(request.height) && request.height >= 8 && request.height <= 1024
  && ArrayBuffer.isView(request.pixels)
  && request.pixels.byteLength === request.width * request.height * 4
  && request.pixels.byteLength <= MAX_LINE_PIXELS
)

/**
 * @param {{ BrowserWindow: any, ipcMain: any, pagePath: () => string, devUrl: () => string | null, preload: string,
 *   configuredWorkers: () => number, keepAliveMs: () => number, createWindow?: (options: any) => any }} options
 */
function createOcrHost(options) {
  let win = null
  let ready = null
  let sequence = 0
  let idleTimer = null
  const pending = new Map()

  const workers = () => workerCount(options.configuredWorkers())

  const failAll = (error) => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error) }
    pending.clear()
  }

  const close = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
    const current = win
    win = null
    ready = null
    failAll(new Error('OCR-Host beendet'))
    if (current && !current.isDestroyed()) current.destroy()
  }

  const scheduleClose = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { idleTimer = null; if (!pending.size) close() }, Math.max(1, options.keepAliveMs()))
    idleTimer.unref?.()
  }

  const onMessage = (event, channel, id, payload) => {
    if (!win || event.sender !== win.webContents) return
    if (channel === CHANNEL_RESULT) {
      const waiter = pending.get(id)
      if (!waiter) return
      pending.delete(id)
      clearTimeout(waiter.timer)
      if (payload && typeof payload.text === 'string') waiter.resolve(payload.text.slice(0, 2000))
      else waiter.reject(new Error(typeof payload?.error === 'string' ? payload.error.slice(0, 200) : 'OCR fehlgeschlagen'))
      if (!pending.size) scheduleClose()
    }
  }

  const start = () => {
    if (win && ready) return ready
    const created = options.createWindow ? options.createWindow({ workers: workers() }) : new options.BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        preload: options.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        // The OCR must keep running while nothing is shown.
        backgroundThrottling: false,
        devTools: false,
        additionalArguments: [`--fanotes-ocr-workers=${workers()}`],
      },
    })
    win = created
    const contents = created.webContents
    lowerPriority(contents)
    contents.on('did-start-loading', () => lowerPriority(contents))
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    created.on('closed', () => { if (win === created) { win = null; ready = null; failAll(new Error('OCR-Host beendet')) } })
    contents.on('render-process-gone', () => { if (win === created) close() })
    ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('OCR-Host startet nicht')); close() }, READY_TIMEOUT_MS)
      const handler = (event, channel) => {
        if (channel !== CHANNEL_READY || event.sender !== contents) return
        clearTimeout(timer)
        options.ipcMain.removeListener('fanotes-ocr-host', handler)
        lowerPriority(contents)
        resolve()
      }
      options.ipcMain.on('fanotes-ocr-host', handler)
      created.once('closed', () => { clearTimeout(timer); options.ipcMain.removeListener('fanotes-ocr-host', handler) })
    })
    ready.catch(() => undefined)
    const dev = options.devUrl()
    void (dev ? created.loadURL(`${dev}/ocr-host.html`) : created.loadFile(options.pagePath())).catch(() => close())
    return ready
  }

  options.ipcMain.on('fanotes-ocr-host', (event, channel, id, payload) => onMessage(event, channel, id, payload))

  /** Reads one text line. Rejects when the host cannot run; the caller falls back to its own worker. */
  const recognize = async (request) => {
    if (!validRequest(request)) throw new Error('Die OCR-Eingabe ist ungültig.')
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    await start()
    const target = win
    if (!target || target.isDestroyed()) throw new Error('OCR-Host nicht verfügbar')
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('OCR-Zeitlimit')); if (!pending.size) scheduleClose() }, REQUEST_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      target.webContents.send(CHANNEL_LINE, id, { pixels: request.pixels, width: request.width, height: request.height })
    })
  }

  return { recognize, close, workers, get running() { return Boolean(win) } }
}

module.exports = { createOcrHost, workerCount, validRequest, CHANNEL_LINE, CHANNEL_RESULT, CHANNEL_READY }
