/**
 * Parses and rewrites a heavy `.famd` off the Electron main thread.
 * The main process only sends a vault path it has already resolved.
 */
import { parentPort } from 'node:worker_threads'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { composeFamdCompanion, openFamdFile, rewriteFamdText } = require('./famd.cjs')

const readOptional = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

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
      // New ink travels as its JSON text: parsing it here keeps a large
      // drawing's objects off the main thread, which also forwards pen input.
      const existing = message.inkJson === undefined
        ? fs.readFileSync(message.filePath, 'utf8')
        : readOptional(message.filePath)
      if (message.maxChars && existing.length > message.maxChars) {
        throw new Error('Die Datei ist zu groß.')
      }
      const ink = message.inkJson === undefined ? undefined : JSON.parse(message.inkJson)
      const text = composeFamdCompanion(existing, message.markdown, ink, message.paperStyle)
      parentPort.postMessage({ id, ok: true, result: text })
      return
    }
    if (message?.op === 'rewriteText') {
      const existing = readOptional(message.filePath)
      if (message.maxChars && existing.length > message.maxChars) {
        throw new Error('Die Datei ist zu groß.')
      }
      parentPort.postMessage({ id, ok: true, result: rewriteFamdText(existing, message.markdown) })
      return
    }
    if (message?.op === 'inspectDrawing') {
      // Only the top-level fields go back; the strokes stay here.
      const document = JSON.parse(message.drawingJson)
      if (!document || typeof document !== 'object' || Array.isArray(document)) {
        throw new Error('Die Zeichnungsdaten sind kein gültiges JSON.')
      }
      const head = {}
      for (const key of Object.keys(document)) {
        if (key === 'strokes' || key === 'sections' || key === 'inkHistory') continue
        head[key] = document[key]
      }
      head.strokes = Array.isArray(document.strokes) ? [] : null
      parentPort.postMessage({ id, ok: true, result: head })
      return
    }
    parentPort.postMessage({ id, ok: false, message: 'Unbekannte Handschrift-Aufgabe.' })
  } catch (error) {
    parentPort.postMessage({ id, ok: false, message: error instanceof Error ? error.message : 'Die Handschrift konnte nicht gelesen werden.' })
  }
})
