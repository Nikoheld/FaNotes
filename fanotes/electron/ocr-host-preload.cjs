'use strict'

// Preload of the hidden OCR host page: a tiny bridge for lines in, text out. No vault access.
const { contextBridge, ipcRenderer } = require('electron')

const argument = process.argv.find((entry) => entry.startsWith('--fanotes-ocr-workers='))
const workers = Math.max(1, Math.min(4, Number(argument?.split('=')[1]) || 1))

contextBridge.exposeInMainWorld('fanotes', { platform: process.platform })
contextBridge.exposeInMainWorld('fanotesOcrHost', {
  workers,
  onLine: (callback) => {
    ipcRenderer.on('fanotes-ocr-host:line', (_event, id, payload) => callback(id, payload))
  },
  result: (id, payload) => ipcRenderer.send('fanotes-ocr-host', 'fanotes-ocr-host:result', id, payload),
  ready: () => ipcRenderer.send('fanotes-ocr-host', 'fanotes-ocr-host:ready', 0, null),
})
