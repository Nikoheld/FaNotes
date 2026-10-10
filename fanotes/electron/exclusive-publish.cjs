'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'])

/**
 * Make a finished temporary file appear at `targetPath` only when that path
 * is absent. `link` fails with EEXIST for a file, directory, or symlink, so a
 * PDF or book import cannot replace a note that already uses the name.
 * Filesystems without hard links fall back to an exclusive create.
 */
async function publishNewFile(temporaryPath, targetPath, linkImpl = fsp.link) {
  try {
    await linkImpl(temporaryPath, targetPath)
  } catch (error) {
    if (error?.code === 'EEXIST' || !LINK_UNSUPPORTED.has(error?.code)) throw error
    const handle = await fsp.open(
      targetPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    )
    try {
      await handle.writeFile(await fsp.readFile(temporaryPath))
      await handle.sync()
    } catch (writeError) {
      await handle.close().catch(() => {})
      await fsp.rm(targetPath, { force: true }).catch(() => {})
      throw writeError
    }
    await handle.close()
  }
  await fsp.unlink(temporaryPath).catch(() => {})
}

module.exports = { publishNewFile }
