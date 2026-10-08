import { createHash, verify } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,180}$/u

export const assertReleaseFileName = (fileName) => {
  if (typeof fileName !== 'string' || !FILE_NAME.test(fileName) || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    throw new Error('Ungültiger Release-Dateiname.')
  }
  return fileName
}

export const parseChecksumMap = (text) => {
  const map = new Map()
  for (const line of String(text).split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const match = /^([a-f0-9]{64})\s+\*?(\S+)$/iu.exec(trimmed)
    if (!match) throw new Error('SHA256SUMS enthält eine ungültige Zeile.')
    map.set(assertReleaseFileName(match[2]), match[1].toLowerCase())
  }
  if (!map.size) throw new Error('SHA256SUMS enthält keine Prüfsummen.')
  return map
}

export const verifyChecksumSignature = (payload, signature, publicKey) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload))
  if (!Buffer.isBuffer(signature) || signature.length < 32 || signature.length > 128) return false
  try {
    return verify(null, body, publicKey, signature)
  } catch {
    return false
  }
}

export const hashRegularFile = async (filePath) => {
  let handle
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error('Die Release-Datei ist keine sichere reguläre Datei.')
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('Die Release-Datei ist keine sichere reguläre Datei.')
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(1024 * 1024)
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}
