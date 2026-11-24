#!/usr/bin/env node
// Writes a new VAPID key pair (P-256) for Web Push to the credential file, mode 0600.
// Usage: node scripts/generate-vapid.mjs [file]   (default: FANOTES_WEB_PUSH_VAPID or /etc/fanotes/web-push-vapid.json)
// Refuses to overwrite an existing file (a new key invalidates every browser subscription).
// Prints the file path and the PUBLIC key only; the private key never reaches the terminal.
import { createECDH } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const file = resolve(process.argv[2] || process.env.FANOTES_WEB_PUSH_VAPID || '/etc/fanotes/web-push-vapid.json')
if (existsSync(file)) {
  console.error(`${file} exists; not overwriting.`)
  process.exit(1)
}
const ecdh = createECDH('prime256v1')
ecdh.generateKeys()
const publicKey = ecdh.getPublicKey().toString('base64url')
mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, `${JSON.stringify({ publicKey, privateKey: ecdh.getPrivateKey().toString('base64url') })}\n`, { mode: 0o600, flag: 'wx' })
chmodSync(file, 0o600)
console.log(`Wrote ${file} (mode 0600). Public key: ${publicKey}`)
