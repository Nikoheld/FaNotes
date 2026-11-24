import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newKdf, deriveFromPassword, fromBase64, newVaultSecret, wrapVaultSecret, unwrapVaultSecret } from '@sync/crypto'
import { VaultClient, VaultError } from '../src/vault/client'
import { createMemoryStore } from '../src/vault/keystore'
import { startSyncServer, registerAccount, derive, type TestServer } from './helpers/syncServer'

const EMAIL = 'vault-test@example.test'
const PASSWORD = 'synthetic-test-password'
const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null)
const enc = (value: string) => new TextEncoder().encode(value)

let server: TestServer
const signIn = async (store = createMemoryStore()) => {
  const { authKey, wrappingKey } = await derive(server.origin, EMAIL, PASSWORD)
  return VaultClient.login({ email: EMAIL, authKey, wrappingKey, deviceName: 'Kanti+ im Browser · Test' }, { origin: server.origin, store })
}

describe('sign-in key split', () => {
  it('splits the PBKDF2 output into a wrapping half that stays and an auth half that is sent', async () => {
    const kdf = { ...newKdf(), iterations: 100_000 }
    const first = await deriveFromPassword('pässwörd', kdf)
    const again = await deriveFromPassword('pässwörd'.normalize('NFD'), kdf)
    expect(first.authKey).toBe(again.authKey)
    expect(fromBase64(first.authKey)).toHaveLength(32)
    // The wrapping key cannot be read out, only used.
    expect(first.wrappingKey.extractable).toBe(false)
    const secret = newVaultSecret()
    const wrap = await wrapVaultSecret(secret, first.wrappingKey)
    expect(await unwrapVaultSecret(wrap, again.wrappingKey)).toEqual(secret)
    const other = await deriveFromPassword('other password', kdf)
    await expect(unwrapVaultSecret(wrap, other.wrappingKey)).rejects.toThrow()
  })
})

describe('vault client against the real sync API', () => {
  beforeAll(async () => {
    server = await startSyncServer()
    await registerAccount(server.origin, EMAIL, PASSWORD)
  }, 60_000)
  afterAll(async () => { await server.close() })

  it('signs in with the derived key, writes and reads back encrypted files, and lists their names', async () => {
    const client = await signIn()
    expect(await client.read('.fanotes/schulnetz/grade-book.json')).toMatchObject({ bytes: null, revision: 0 })
    await client.update('.fanotes/schulnetz/grade-book.json', () => enc('{"version":1}'))
    const again = await client.read('.fanotes/schulnetz/grade-book.json')
    expect(text(again.bytes)).toBe('{"version":1}')
    expect(again.revision).toBeGreaterThan(0)
    await client.create('Mathematik/Notiz.md', enc('# Hallo'))
    await expect(client.create('Mathematik/Notiz.md', enc('# Anders'))).rejects.toMatchObject({ code: 'conflict' })
    const paths = (await client.list()).map((entry) => entry.path)
    expect(paths).toEqual(expect.arrayContaining(['.fanotes/schulnetz/grade-book.json', 'Mathematik/Notiz.md']))
  }, 60_000)

  it('opens the same vault from a second device (restore and a second login)', async () => {
    const store = createMemoryStore()
    const first = await signIn(store)
    await first.update('Hausaufgaben.md', () => enc('# Hausaufgaben'))
    // A page reload: the access comes back from the key store.
    const restored = await VaultClient.restore({ origin: server.origin, store })
    expect(restored).not.toBeNull()
    expect(text((await restored!.read('Hausaufgaben.md')).bytes)).toBe('# Hausaufgaben')
    const second = await signIn()
    expect(text((await second.read('Hausaufgaben.md')).bytes)).toBe('# Hausaufgaben')
  }, 60_000)

  it('wrong password: the vault key does not open', async () => {
    const { authKey } = await derive(server.origin, EMAIL, PASSWORD)
    // The right auth key (so the server lets us in) with a wrapping key from another password cannot open the vault.
    const { wrappingKey } = await deriveFromPassword('wrong password', newKdf())
    await expect(VaultClient.login({ email: EMAIL, authKey, wrappingKey, deviceName: 'x' }, { origin: server.origin, store: createMemoryStore() })).rejects.toBeInstanceOf(VaultError)
  }, 60_000)

  it('re-applies the change to the fresh content after a stale rejection, and keeps the other writer\'s change', async () => {
    const mine = await signIn()
    const theirs = await signIn()
    const path = '.fanotes/schulnetz/hypothetical.json'
    await mine.update(path, () => enc('["a"]'))
    let interfered = false
    await mine.update(path, async (current) => {
      if (!interfered) {
        interfered = true
        // Another device writes between our read and our upload.
        await theirs.update(path, () => enc('["a","theirs"]'))
      }
      const list = JSON.parse(text(current)!) as string[]
      return enc(JSON.stringify([...list, 'mine']))
    })
    expect(JSON.parse(text((await mine.read(path)).bytes)!)).toEqual(['a', 'theirs', 'mine'])
  }, 60_000)

  it('gives up after three stale rejections and never overwrites the newer remote version', async () => {
    const mine = await signIn()
    const theirs = await signIn()
    const path = '.fanotes/schulnetz/planned-absences.json'
    await mine.update(path, () => enc('{"items":[]}'))
    let rounds = 0
    let attempts = 0
    await expect(mine.update(path, async () => {
      attempts += 1
      rounds += 1
      await theirs.update(path, () => enc(`{"items":[],"round":${rounds}}`))
      return enc('{"items":[{"id":"mine"}]}')
    })).rejects.toMatchObject({ code: 'conflict' })
    expect(attempts).toBe(3)
    expect(text((await mine.read(path)).bytes)).toBe('{"items":[],"round":3}')
  }, 60_000)

  it('sign-out ends the sync session and wipes the stored access', async () => {
    const store = createMemoryStore()
    const client = await signIn(store)
    await client.logout()
    expect(await store.load()).toBeNull()
    await expect(client.read('Hausaufgaben.md')).rejects.toMatchObject({ code: 'unauthorized' })
  }, 60_000)
})
