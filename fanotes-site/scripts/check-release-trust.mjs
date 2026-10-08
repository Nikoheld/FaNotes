import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertReleaseFileName, hashRegularFile, parseChecksumMap, verifyChecksumSignature } from '../release-trust.mjs'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const body = `${'a'.repeat(64)}  FaNotes-1.0.0-x86_64.AppImage\n`
const signature = sign(null, Buffer.from(body), privateKey)
assert.equal(verifyChecksumSignature(Buffer.from(body), signature, publicKey), true)
assert.equal(verifyChecksumSignature(Buffer.from(`${body}x`), signature, publicKey), false)
assert.equal(verifyChecksumSignature(body, Buffer.from('too-short'), publicKey), false)

const map = parseChecksumMap(body)
assert.equal(map.get('FaNotes-1.0.0-x86_64.AppImage'), 'a'.repeat(64))
assert.throws(() => parseChecksumMap('not-a-checksum\n'), /ungültige Zeile/u)
assert.throws(() => parseChecksumMap(`${'b'.repeat(64)}  ../secret\n`), /Dateiname/u)
assert.throws(() => assertReleaseFileName('../SHA256SUMS'))

const directory = await mkdtemp(path.join(tmpdir(), 'fanotes-release-trust-'))
const filePath = path.join(directory, 'package.bin')
await writeFile(filePath, 'fanotes')
assert.equal(await hashRegularFile(filePath), createHash('sha256').update('fanotes').digest('hex'))
const linkPath = path.join(directory, 'link.bin')
await symlink(filePath, linkPath)
await assert.rejects(hashRegularFile(linkPath), /keine sichere reguläre Datei/u)
console.log('release-trust ok')
