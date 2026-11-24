// The real sync API (fanotes-site/sync-api.mjs) on a local port with a temp data dir, for round-trip
// tests of the browser's vault client. Synthetic accounts only.
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newKdf, newVaultSecret, deriveFromPassword, wrapVaultSecret } from '@sync/crypto'
import { SyncApi } from '@sync/api'

export interface TestServer { origin: string; close: () => Promise<void> }

// The sync API logs one JSON line per request; keep the test output readable.
const log = console.log
console.log = (...args: unknown[]) => { if (!(typeof args[0] === 'string' && args[0].startsWith('{"time"'))) log(...args) }

export const startSyncServer = async (): Promise<TestServer> => {
  const dir = await mkdtemp(join(tmpdir(), 'kanti-vault-test-'))
  process.env.FANOTES_SYNC_DIR = join(dir, 'sync')
  const modulePath = new URL('../../../sync-api.mjs', import.meta.url).href
  const { handleSyncRequest } = await import(/* @vite-ignore */ modulePath) as { handleSyncRequest: (request: unknown, response: unknown, url: URL) => Promise<boolean> }
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://localhost')
    handleSyncRequest(request, response, url).then((handled) => { if (!handled) response.writeHead(404).end() }).catch(() => response.writeHead(500).end())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }) },
  }
}

/** An account as the apps create it: random vault secret, wrapped with the key from the password. */
export const registerAccount = async (origin: string, email: string, password: string) => {
  const kdf = newKdf()
  const { wrappingKey, authKey } = await deriveFromPassword(password, kdf)
  const secret = newVaultSecret()
  const vaultKeyWrap = await wrapVaultSecret(secret, wrappingKey)
  await new SyncApi(origin).register({ email, authKey, kdf, vaultKeyWrap, device: { name: 'Test phone', platform: 'android' } })
  return { kdf, secret }
}

/** What the sign-in form does: prelogin, derive, hand over the two halves. */
export const derive = async (origin: string, email: string, password: string) => {
  const { kdf } = await new SyncApi(origin).prelogin(email)
  return deriveFromPassword(password, kdf)
}
