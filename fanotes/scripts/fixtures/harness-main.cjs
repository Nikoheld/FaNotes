// Minimal Electron main for browser-style harness pages: opens one window on the file given after `--harness`.
const { app, BrowserWindow } = require('electron')
const index = process.argv.indexOf('--harness')
const target = index >= 0 ? process.argv[index + 1] : ''
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 860, show: true, webPreferences: { contextIsolation: true, sandbox: true } })
  void win.loadURL(target)
})
app.on('window-all-closed', () => app.quit())
