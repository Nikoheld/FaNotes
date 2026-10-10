'use strict'

const fsp = require('node:fs/promises')

/**
 * Make a finished temporary file appear at `targetPath` only when that path
 * is absent. `link` fails with EEXIST for a file, directory, or symlink, so a
 * PDF or book import cannot replace a note that already uses the name.
 */
async function publishNewFile(temporaryPath, targetPath) {
  await fsp.link(temporaryPath, targetPath)
  await fsp.unlink(temporaryPath).catch(() => {})
}

module.exports = { publishNewFile }
