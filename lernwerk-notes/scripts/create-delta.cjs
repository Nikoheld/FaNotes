'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap.js')
const { DELTA_FORMAT, DELTA_MAGIC, sha256File } = require('../electron/delta.cjs')

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u

const readBlockMap = async (filePath) => {
  const parsed = JSON.parse(zlib.gunzipSync(await fsp.readFile(filePath)).toString('utf8'))
  if (parsed?.version !== '2' || !Array.isArray(parsed.files) || parsed.files.length !== 1) throw new Error('Der erzeugte Blockplan ist ungültig.')
  const file = parsed.files[0]
  if (file.name !== 'file' || file.offset !== 0 || !Array.isArray(file.checksums) || !Array.isArray(file.sizes) || file.checksums.length !== file.sizes.length) {
    throw new Error('Der erzeugte Blockplan enthält keine eindeutige Datei.')
  }
  return file
}

const blockOffsets = (blockMap) => {
  let offset = 0
  return blockMap.sizes.map((sizeBytes, index) => {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error('Der Blockplan enthält eine ungültige Blockgröße.')
    const block = { checksum: blockMap.checksums[index], sizeBytes, offset }
    offset += sizeBytes
    return block
  })
}

const createOperations = (sourceMap, targetMap, sourceSize, targetSize) => {
  const available = new Map()
  for (const block of blockOffsets(sourceMap)) {
    const key = `${block.checksum}:${block.sizeBytes}`
    if (!available.has(key)) available.set(key, block.offset)
  }
  const targetBlocks = blockOffsets(targetMap)
  if (sourceMap.sizes.reduce((sum, value) => sum + value, 0) !== sourceSize || targetMap.sizes.reduce((sum, value) => sum + value, 0) !== targetSize) {
    throw new Error('Der Blockplan deckt die Quell- oder Zieldatei nicht vollständig ab.')
  }

  const operations = []
  let payloadBytes = 0
  for (const block of targetBlocks) {
    const sourceOffset = available.get(`${block.checksum}:${block.sizeBytes}`)
    const next = sourceOffset == null
      ? { kind: 'data', dataOffset: payloadBytes, sizeBytes: block.sizeBytes, targetOffset: block.offset }
      : { kind: 'copy', sourceOffset, sizeBytes: block.sizeBytes, targetOffset: block.offset }
    if (next.kind === 'data') payloadBytes += next.sizeBytes
    const previous = operations.at(-1)
    const contiguousTarget = previous && previous.targetOffset + previous.sizeBytes === next.targetOffset
    const mergeCopy = previous?.kind === 'copy' && next.kind === 'copy' && contiguousTarget && previous.sourceOffset + previous.sizeBytes === next.sourceOffset
    const mergeData = previous?.kind === 'data' && next.kind === 'data' && contiguousTarget && previous.dataOffset + previous.sizeBytes === next.dataOffset
    if (mergeCopy || mergeData) previous.sizeBytes += next.sizeBytes
    else operations.push(next)
  }
  return { operations, payloadBytes }
}

const copyRange = async (sourceHandle, targetHandle, sourceOffset, targetOffset, sizeBytes) => {
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let copied = 0
  while (copied < sizeBytes) {
    const length = Math.min(buffer.length, sizeBytes - copied)
    const { bytesRead } = await sourceHandle.read(buffer, 0, length, sourceOffset + copied)
    if (bytesRead !== length) throw new Error('Die Zieldatei endet während der Delta-Erstellung unerwartet.')
    let written = 0
    while (written < length) {
      const result = await targetHandle.write(buffer, written, length - written, targetOffset + copied + written)
      if (!result.bytesWritten) throw new Error('Das Delta-Paket konnte nicht vollständig geschrieben werden.')
      written += result.bytesWritten
    }
    copied += length
  }
}

async function createDeltaPatch({ platform, baseVersion, targetVersion, sourcePath, targetPath, outputPath, targetKind, targetFileName }) {
  if (!['linux', 'windows'].includes(platform)) throw new Error('Die Delta-Plattform muss linux oder windows sein.')
  if (!VERSION_PATTERN.test(baseVersion) || !VERSION_PATTERN.test(targetVersion)) throw new Error('Basis- und Zielversion müssen semantische Versionen sein.')
  const expectedKind = platform === 'linux' ? 'appimage' : 'app-asar'
  if (targetKind !== expectedKind) throw new Error(`Für ${platform} wird der Zieldateityp ${expectedKind} erwartet.`)
  if (!/^[A-Za-z0-9._-]{1,160}$/u.test(targetFileName)) throw new Error('Der Delta-Zieldateiname ist ungültig.')
  const resolvedSource = path.resolve(sourcePath)
  const resolvedTarget = path.resolve(targetPath)
  const resolvedOutput = path.resolve(outputPath)
  const [sourceStats, targetStats] = await Promise.all([fsp.lstat(resolvedSource), fsp.lstat(resolvedTarget)])
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink() || !targetStats.isFile() || targetStats.isSymbolicLink()) throw new Error('Delta-Quelle und -Ziel müssen reguläre Dateien sein.')

  const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-delta-map-'))
  try {
    const sourceMapPath = path.join(temporaryRoot, 'source.blockmap')
    const targetMapPath = path.join(temporaryRoot, 'target.blockmap')
    const [sourceSha256, targetSha256] = await Promise.all([
      sha256File(resolvedSource),
      sha256File(resolvedTarget),
      buildBlockMap(resolvedSource, 'gzip', sourceMapPath),
      buildBlockMap(resolvedTarget, 'gzip', targetMapPath),
    ]).then((results) => results.slice(0, 2))
    const [sourceMap, targetMap] = await Promise.all([readBlockMap(sourceMapPath), readBlockMap(targetMapPath)])
    const { operations, payloadBytes } = createOperations(sourceMap, targetMap, sourceStats.size, targetStats.size)
    const header = {
      format: DELTA_FORMAT,
      platform,
      baseVersion,
      targetVersion,
      source: { kind: expectedKind, sizeBytes: sourceStats.size, sha256: sourceSha256 },
      target: { kind: targetKind, fileName: targetFileName, sizeBytes: targetStats.size, sha256: targetSha256 },
      operations: operations.map(({ targetOffset: _targetOffset, ...operation }) => operation),
    }
    const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8')
    const prefix = Buffer.alloc(DELTA_MAGIC.length + 4)
    DELTA_MAGIC.copy(prefix)
    prefix.writeUInt32BE(encodedHeader.length, DELTA_MAGIC.length)
    await fsp.mkdir(path.dirname(resolvedOutput), { recursive: true, mode: 0o700 })
    const outputHandle = await fsp.open(resolvedOutput, 'w', 0o600)
    const targetHandle = await fsp.open(resolvedTarget, 'r')
    try {
      await outputHandle.write(prefix, 0, prefix.length, 0)
      await outputHandle.write(encodedHeader, 0, encodedHeader.length, prefix.length)
      const dataStart = prefix.length + encodedHeader.length
      for (const operation of operations) {
        if (operation.kind !== 'data') continue
        await copyRange(targetHandle, outputHandle, operation.targetOffset, dataStart + operation.dataOffset, operation.sizeBytes)
      }
      await outputHandle.sync()
    } finally {
      await Promise.allSettled([outputHandle.close(), targetHandle.close()])
    }
    const patchStats = await fsp.stat(resolvedOutput)
    const patchSha256 = await sha256File(resolvedOutput)
    return {
      ...header,
      fileName: path.basename(resolvedOutput),
      patchSizeBytes: patchStats.size,
      patchSha256,
      payloadBytes,
      reusedBytes: targetStats.size - payloadBytes,
      reuseRatio: (targetStats.size - payloadBytes) / targetStats.size,
    }
  } finally {
    await fsp.rm(temporaryRoot, { recursive: true, force: true })
  }
}

const parseArguments = (values) => {
  const result = {}
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    if (!key?.startsWith('--') || values[index + 1] == null) throw new Error(`Ungültiges Argument: ${key ?? ''}`)
    result[key.slice(2)] = values[index + 1]
  }
  return result
}

if (require.main === module) {
  const args = parseArguments(process.argv.slice(2))
  createDeltaPatch({
    platform: args.platform,
    baseVersion: args['base-version'],
    targetVersion: args['target-version'],
    sourcePath: args.source,
    targetPath: args.target,
    outputPath: args.output,
    targetKind: args['target-kind'],
    targetFileName: args['target-file'],
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  })
}

module.exports = { createDeltaPatch, createOperations }
