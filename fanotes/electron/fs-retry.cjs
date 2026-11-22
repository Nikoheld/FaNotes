'use strict'

// Windows keeps a file busy while Defender, the search indexer, OneDrive or a
// backup tool has it open without FILE_SHARE_DELETE. Renaming over it, or
// opening it, then fails with EBUSY, EPERM or EACCES for a few hundred
// milliseconds. The same errors on Linux/macOS are real permission problems and
// are never retried.

const fsp = require('node:fs/promises')

const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])
const DEFAULT_DELAYS_MS = Object.freeze([20, 40, 80, 160, 320, 640, 1000])

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Runs `operation`, retrying with backoff while it fails with a "file busy" error on Windows. */
async function retryWhileBusy(operation, { platform = process.platform, delays = DEFAULT_DELAYS_MS, wait = sleep } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (platform !== 'win32' || !BUSY_CODES.has(error?.code) || attempt >= delays.length) throw error
      await wait(delays[attempt])
    }
  }
}

const renameWithRetry = (from, to, options = {}) => retryWhileBusy(() => (options.rename ?? fsp.rename)(from, to), options)

const openWithRetry = (target, flags, mode, options = {}) => retryWhileBusy(() => (options.open ?? fsp.open)(target, flags, mode), options)

module.exports = { BUSY_CODES, DEFAULT_DELAYS_MS, openWithRetry, renameWithRetry, retryWhileBusy }
