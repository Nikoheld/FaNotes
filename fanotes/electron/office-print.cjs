'use strict'

// Prints generated Office HTML (the built-in fallback) to PDF in a hidden
// window that has no node integration, no JavaScript and no network: the page
// is a local file made of escaped text and data: pictures only.
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')

const PRINT_TIMEOUT_MS = 120_000

async function printOfficeHtmlToPdf(html, { tempDir } = {}) {
  const { app, BrowserWindow } = require('electron')
  const folder = await fsp.mkdtemp(path.join(tempDir || app.getPath('temp'), 'fanotes-office-'))
  const file = path.join(folder, 'page.html')
  let win = null
  try {
    await fsp.writeFile(file, html, 'utf8')
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        javascript: false,
        spellcheck: false,
        backgroundThrottling: false,
        partition: `fanotes-office-${crypto.randomUUID()}`,
      },
    })
    const pageUrl = pathToFileURL(file).href
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.url === pageUrl || details.url.startsWith('data:')) }))
    win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (navigation) => navigation.preventDefault())
    const work = (async () => {
      await win.loadURL(pageUrl)
      return win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true })
    })()
    let timer
    const limit = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Zeitüberschreitung bei der Umwandlung.')), PRINT_TIMEOUT_MS) })
    try {
      return Buffer.from(await Promise.race([work, limit]))
    } finally {
      clearTimeout(timer)
      work.catch(() => {})
    }
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
    await fsp.rm(folder, { recursive: true, force: true }).catch(() => {})
  }
}

module.exports = { printOfficeHtmlToPdf }
