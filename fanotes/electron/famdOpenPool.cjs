'use strict'

const path = require('node:path')
const { Worker } = require('node:worker_threads')

/**
 * One long-lived worker for heavy `.famd` reads and ink-preserving rewrites.
 * Messages stay small: samples travel as a transferred Float64Array, or the
 * worker returns the finished file text and the main thread only writes it.
 */
let worker = null
let sequence = 0
const pending = new Map()

function failAll(error) {
  for (const waiter of pending.values()) waiter.reject(error)
  pending.clear()
  if (worker) {
    const current = worker
    worker = null
    current.terminate().catch(() => undefined)
  }
}

function ensure() {
  if (worker) return worker
  const next = new Worker(path.join(__dirname, 'famdOpenWorker.mjs'))
  next.on('message', (message) => {
    const waiter = pending.get(message?.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.ok) waiter.resolve(message.result)
    else waiter.reject(new Error(message.message || 'Die Handschrift konnte nicht gelesen werden.'))
  })
  next.on('error', (error) => failAll(error))
  next.on('exit', (code) => {
    if (worker !== next) return
    worker = null
    if (pending.size) failAll(new Error(`Der Handschrift-Worker wurde beendet (${code}).`))
  })
  worker = next
  return next
}

function ask(payload) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      ensure().postMessage({ ...payload, id })
    } catch (error) {
      pending.delete(id)
      reject(error)
    }
  })
}

function close() {
  if (!worker) return Promise.resolve(0)
  const current = worker
  worker = null
  failAll(new Error('Der Handschrift-Worker wurde beendet.'))
  return current.terminate()
}

function openFile(filePath, maxChars) {
  return ask({ op: 'open', filePath, maxChars })
}

function composeFile(filePath, markdown, paperStyle, maxChars) {
  return ask({ op: 'compose', filePath, markdown, paperStyle, maxChars })
}

module.exports = {
  close,
  composeFile,
  openFile,
}
