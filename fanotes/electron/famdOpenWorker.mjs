/**
 * Parses and rewrites a heavy `.famd` off the Electron main thread.
 * The main process only sends a vault path it has already resolved.
 */
import { parentPort } from 'node:worker_threads'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { composeFamdCompanion, openFamdFile } = require('./famd.cjs')

parentPort.on('message', (message) => {
  const id = message?.id
  try {
    if (message?.op === 'open') {
      const source = fs.readFileSync(message.filePath, 'utf8')
      if (message.maxChars && source.length > message.maxChars) {
        throw new Error('Die Datei ist zu groß.')
      }
      const result = openFamdFile(source)
      const buffer = result.packedInk?.columns?.buffer
      parentPort.postMessage({ id, ok: true, result }, buffer ? [buffer] : [])
      return
    }
    if (message?.op === 'compose') {
      const existing = fs.readFileSync(message.filePath, 'utf8')
      if (message.maxChars && existing.length > message.maxChars) {
        throw new Error('Die Datei ist zu groß.')
      }
      const text = composeFamdCompanion(existing, message.markdown, undefined, message.paperStyle)
      parentPort.postMessage({ id, ok: true, result: text })
      return
    }
    parentPort.postMessage({ id, ok: false, message: 'Unbekannte Handschrift-Aufgabe.' })
  } catch (error) {
    parentPort.postMessage({ id, ok: false, message: error instanceof Error ? error.message : 'Die Handschrift konnte nicht gelesen werden.' })
  }
})
