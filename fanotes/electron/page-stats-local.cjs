'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/**
 * Page statistics of plain notes (no ink, no sidecar). They live in the app
 * profile, never in the vault, so they are not synced or shared and a text
 * edit does not create a `.famd` next to the note.
 * One JSON file per vault: { "<relative note path>": pageStats }.
 */
function createLocalPageStats({ directory, atomicWrite, delayMs = 800 }) {
  const maps = new Map()
  const timers = new Map()

  const fileFor = (vaultPath) => path.join(
    directory,
    `page-stats-${crypto.createHash('sha256').update(String(vaultPath)).digest('hex').slice(0, 16)}.json`,
  )

  function load(vaultPath) {
    let map = maps.get(vaultPath)
    if (map) return map
    map = new Map()
    try {
      const parsed = JSON.parse(fs.readFileSync(fileFor(vaultPath), 'utf8'))
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed)) {
          if (value && typeof value === 'object') map.set(key, value)
        }
      }
    } catch {
      // Missing or damaged: start empty. These are statistics only.
    }
    maps.set(vaultPath, map)
    return map
  }

  async function flush(vaultPath) {
    const timer = timers.get(vaultPath)
    if (timer) clearTimeout(timer)
    timers.delete(vaultPath)
    const map = maps.get(vaultPath)
    if (!map) return
    await fs.promises.mkdir(directory, { recursive: true })
    await atomicWrite(fileFor(vaultPath), JSON.stringify(Object.fromEntries(map)), { encoding: 'utf8', mode: 0o600 })
  }

  function schedule(vaultPath) {
    if (timers.has(vaultPath)) return
    const timer = setTimeout(() => {
      timers.delete(vaultPath)
      flush(vaultPath).catch(() => {})
    }, delayMs)
    timer.unref?.()
    timers.set(vaultPath, timer)
  }

  return {
    get: (vaultPath, notePath) => load(vaultPath).get(notePath) ?? null,
    set(vaultPath, notePath, stats) {
      if (!stats) return
      load(vaultPath).set(notePath, stats)
      schedule(vaultPath)
    },
    remove(vaultPath, notePath) {
      if (load(vaultPath).delete(notePath)) schedule(vaultPath)
    },
    flush,
    fileFor,
  }
}

module.exports = { createLocalPageStats }
