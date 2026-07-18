'use strict'

const assert = require('node:assert/strict')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { applyDeltaPatch, inspectDeltaPatch, sha256File } = require('../electron/delta.cjs')

const [sourcePath, patchPath, expectedTargetPath] = process.argv.slice(2).map((value) => path.resolve(value || ''))
assert.ok(sourcePath && patchPath && expectedTargetPath, 'Quelle, Delta und erwartete Zieldatei werden benötigt.')

void (async () => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-release-delta-'))
  try {
    const { header } = await inspectDeltaPatch(patchPath)
    const outputPath = path.join(temporary, header.target.fileName)
    await applyDeltaPatch({ sourcePath, patchPath, outputPath })
    const [actual, expected] = await Promise.all([sha256File(outputPath), sha256File(expectedTargetPath)])
    assert.equal(actual, expected, 'Das reale Release-Delta rekonstruiert nicht die veröffentlichte Zieldatei.')
    console.log(`${header.platform}: ${header.baseVersion} → ${header.targetVersion} bytegenau rekonstruiert (${header.target.sizeBytes} Bytes).`)
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true })
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
