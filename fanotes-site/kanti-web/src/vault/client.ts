// The browser's end of FaNotes sync: sign in with the key derived from the password, open the
// vault, read and write encrypted files. Same crypto, same ids, same revisions as the apps
// (fanotes/src/lib/sync): the server only ever sees the auth key and ciphertext.
import {
  decryptBytes, decryptMeta, deriveSyncKeys, encryptBytes, encryptMeta, fileIdFor, fromBase64, importVaultSecret, isValidKdf,
  randomBytes, sha256Hex, toBase64, unwrapVaultSecret, type SyncKdf, type SyncKeys,
} from '@sync/crypto'
import { SyncApi, SyncApiError, type SyncRemoteEntry, type SyncSession } from '@sync/api'
import type { KeyStore, StoredVault } from './keystore'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** How often one change is re-applied to a newer remote version before the page gives up. */
export const MAX_WRITE_ATTEMPTS = 3

export class VaultError extends Error {
  constructor(readonly code: 'conflict' | 'guard' | 'unauthorized' | 'offline' | 'quota' | 'corrupt' | 'unavailable' | 'failed', message: string) {
    super(message)
    this.name = 'VaultError'
  }
}

const fromApiError = (error: unknown): VaultError => {
  if (error instanceof VaultError) return error
  if (error instanceof SyncApiError) {
    if (error.status === 0) return new VaultError('offline', error.message)
    if (error.status === 401) return new VaultError('unauthorized', error.message)
    if (error.guarded) return new VaultError('guard', error.message)
    if (error.status === 409) return new VaultError('conflict', error.message)
    if (error.status === 507) return new VaultError('quota', error.message)
    if (error.status === 404 || error.status === 502 || error.status === 503) return new VaultError('unavailable', error.message)
    return new VaultError('failed', error.message)
  }
  return new VaultError('failed', error instanceof Error ? error.message : String(error))
}

export interface VaultFile { bytes: Uint8Array; revision: number; mtimeMs: number }
/** What a read finds: the file, or nothing (never written, or deleted: `revision` is then the base for a new write). */
export type VaultRead = VaultFile | { bytes: null; revision: number; mtimeMs: 0 }

export interface VaultEntry { id: string; path: string; revision: number; size: number; mtimeMs: number }

export interface LoginInput {
  email: string
  authKey: string
  wrappingKey: CryptoKey
  deviceName: string
}

export interface ClientOptions {
  origin: string
  store: KeyStore
  fetchImpl?: typeof fetch
  now?: () => number
}

/** `mutate` gets the current bytes (null when the file does not exist) and returns the next bytes, or null for "leave it". */
export type Mutation = (current: Uint8Array | null) => Uint8Array | null | Promise<Uint8Array | null>

export class VaultClient {
  /** Every file the server holds for the account (ids and revisions, no names): what exists, so a missing file costs no request. */
  private index = new Map<string, SyncRemoteEntry>()
  private cursor = 0
  private indexed = false

  private constructor(
    private readonly api: SyncApi,
    private readonly store: KeyStore,
    private session: SyncSession,
    private readonly keys: SyncKeys,
    private readonly options: ClientOptions,
    private readonly extra: { tokenKey: CryptoKey; sealed: StoredVault['token'] },
  ) {}

  /** Signs in at the sync API, opens the vault secret with the wrapping key and keeps access (see keystore.ts). */
  static async login(input: LoginInput, options: ClientOptions): Promise<VaultClient> {
    const api = new SyncApi(options.origin, options.fetchImpl)
    let answer
    try {
      answer = await api.login({ email: input.email, authKey: input.authKey, device: { name: input.deviceName, platform: 'web' } })
    } catch (error) { throw fromApiError(error) }
    if (!isValidKdf(answer.kdf as SyncKdf) || !answer.vaultKeyWrap) throw new VaultError('corrupt', 'The account has no usable vault key.')
    let secret: Uint8Array
    try { secret = await unwrapVaultSecret(answer.vaultKeyWrap, input.wrappingKey) } catch (error) {
      // No vault access without the vault key: end the sync session that was just opened.
      await api.logout({ accountId: answer.accountId, deviceId: answer.deviceId, token: answer.token, expiresAt: answer.expiresAt, email: input.email }).catch(() => undefined)
      throw new VaultError('corrupt', error instanceof Error ? error.message : 'vault key')
    }
    const keys = await deriveSyncKeys(await importVaultSecret(secret))
    secret.fill(0)
    const session: SyncSession = { accountId: answer.accountId, deviceId: answer.deviceId, token: answer.token, expiresAt: answer.expiresAt, email: input.email }
    const tokenKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const iv = randomBytes(12)
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: encoder.encode(session.accountId) }, tokenKey, encoder.encode(session.token)))
    const sealed = { iv, data }
    const client = new VaultClient(api, options.store, session, keys, options, { tokenKey, sealed })
    await client.persist()
    return client
  }

  /** The access kept by an earlier page load, or null (nothing stored, expired, unreadable). */
  static async restore(options: ClientOptions): Promise<VaultClient | null> {
    const stored = await options.store.load()
    if (!stored) return null
    const now = (options.now ?? Date.now)()
    if (Date.parse(stored.expiresAt) <= now) { await options.store.wipe(); return null }
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.token.iv as BufferSource, additionalData: encoder.encode(stored.accountId) }, stored.tokenKey, stored.token.data as BufferSource)
      const session: SyncSession = { accountId: stored.accountId, deviceId: stored.deviceId, token: decoder.decode(plain), expiresAt: stored.expiresAt, email: stored.email }
      return new VaultClient(new SyncApi(options.origin, options.fetchImpl), options.store, session, stored.keys, options, { tokenKey: stored.tokenKey, sealed: stored.token })
    } catch {
      await options.store.wipe()
      return null
    }
  }

  get email() { return this.session.email }
  get persistent() { return this.store.persistent }

  private async persist() {
    const value: StoredVault = { v: 1, accountId: this.session.accountId, deviceId: this.session.deviceId, email: this.session.email, expiresAt: this.session.expiresAt, tokenKey: this.extra.tokenKey, token: this.extra.sealed, keys: this.keys }
    try { await this.store.save(value) } catch { /* the access then lives in memory for this page load only */ }
  }

  /** Ends the sync session on the server and removes everything stored here. Never throws. */
  async logout(): Promise<void> {
    try { await this.api.logout(this.session) } catch { /* the token expires on its own */ }
    await this.store.wipe()
  }

  /** Drops the stored access without calling the server (the server session is already gone). */
  async forget(): Promise<void> { await this.store.wipe() }

  async pathId(path: string): Promise<string> { return fileIdFor(this.keys, path) }

  /** Brings the list of what exists up to date (cheap: only entries changed since the last call). */
  async sync(): Promise<void> {
    for (let page = 0; page < 500; page += 1) {
      let answer
      try { answer = await this.api.changes(this.session, this.cursor) } catch (error) { throw fromApiError(error) }
      for (const entry of answer.entries) this.index.set(entry.id, entry)
      const advanced = answer.nextSince > this.cursor
      if (advanced) this.cursor = answer.nextSince
      if (!answer.more || !advanced) break
    }
    this.indexed = true
  }

  async read(path: string): Promise<VaultRead> {
    const id = await fileIdFor(this.keys, path)
    if (!this.indexed) await this.sync()
    return this.readId(id, path)
  }

  private async readId(id: string, path: string): Promise<VaultRead> {
    const known = this.index.get(id)
    if (!known) return { bytes: null, revision: 0, mtimeMs: 0 }
    if (known.deleted) return { bytes: null, revision: known.revision, mtimeMs: 0 }
    let download
    try {
      download = await this.api.download(this.session, id)
    } catch (error) {
      if (error instanceof SyncApiError && error.status === 404) return { bytes: null, revision: 0, mtimeMs: 0 }
      throw fromApiError(error)
    }
    if ('deleted' in download) {
      this.index.set(id, { ...known, revision: download.revision, deleted: true })
      return { bytes: null, revision: download.revision, mtimeMs: 0 }
    }
    if (await sha256Hex(download.blob) !== download.sha256) throw new VaultError('corrupt', `The file “${path}” arrived damaged.`)
    let plain: Uint8Array
    let meta
    try {
      plain = await decryptBytes(this.keys, id, download.blob)
      meta = await decryptMeta(this.keys, id, download.meta)
    } catch (error) { throw new VaultError('corrupt', error instanceof Error ? error.message : String(error)) }
    if (await sha256Hex(plain) !== meta.sha256) throw new VaultError('corrupt', `The checksum of “${path}” does not match.`)
    this.index.set(id, { ...known, revision: download.revision })
    return { bytes: plain, revision: download.revision, mtimeMs: meta.mtimeMs }
  }

  /** Every live file of the vault: the encrypted names are opened here, the server never sees them. */
  async list(): Promise<VaultEntry[]> {
    await this.sync()
    const out: VaultEntry[] = []
    await Promise.all([...this.index.values()].filter((entry) => !entry.deleted).map(async (entry) => {
      if (!entry.meta) return
      try {
        const meta = await decryptMeta(this.keys, entry.id, entry.meta)
        out.push({ id: entry.id, path: meta.path, revision: entry.revision, size: meta.size, mtimeMs: meta.mtimeMs })
      } catch { /* an entry this key cannot open is not ours to show */ }
    }))
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  /**
   * Reads the file, lets `mutate` build the next bytes from what is there NOW, and uploads them with the
   * revision that was read as the base. When the server has a newer version (409), the file is read again
   * and the same change is applied to the fresh content (at most MAX_WRITE_ATTEMPTS times). A newer remote
   * version is never overwritten blindly.
   */
  async update(path: string, mutate: Mutation): Promise<{ revision: number; bytes: Uint8Array } | null> {
    const id = await fileIdFor(this.keys, path)
    if (!this.indexed) await this.sync()
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      // After a stale rejection what the server holds has changed: look again before re-applying the change.
      if (attempt > 1) await this.sync()
      const current = await this.readId(id, path)
      const next = await mutate(current.bytes)
      if (next === null) return null
      const sha256 = await sha256Hex(next)
      const meta = await encryptMeta(this.keys, id, { path, mtimeMs: (this.options.now ?? Date.now)(), size: next.byteLength, sha256 })
      const blob = await encryptBytes(this.keys, id, next)
      try {
        const revision = await this.api.upload(this.session, id, current.revision, meta, await sha256Hex(blob), blob, { blank: next.byteLength === 0 })
        this.index.set(id, { id, revision, deleted: false, size: blob.byteLength, sha256: await sha256Hex(blob), meta, updatedAt: null, deviceId: this.session.deviceId })
        return { revision, bytes: next }
      } catch (error) {
        if (error instanceof SyncApiError && error.conflict && !error.guarded) {
          if (attempt === MAX_WRITE_ATTEMPTS) throw new VaultError('conflict', 'The file was changed elsewhere again and again. Nothing was overwritten.')
          continue
        }
        throw fromApiError(error)
      }
    }
    throw new VaultError('conflict', 'The file was changed elsewhere. Nothing was overwritten.')
  }

  /** Writes a whole file the user created (a new note). Fails with a conflict when the path exists. */
  async create(path: string, bytes: Uint8Array): Promise<void> {
    let existed = false
    await this.update(path, (current) => { if (current !== null) { existed = true; return null } return bytes })
    if (existed) throw new VaultError('conflict', 'A file with this name already exists.')
  }

  /** Deletes a file (a tombstone), with the revision that was read as the base. */
  async remove(path: string): Promise<void> {
    const id = await fileIdFor(this.keys, path)
    if (!this.indexed) await this.sync()
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await this.sync()
      const current = await this.readId(id, path)
      if (current.bytes === null) return
      try {
        const revision = await this.api.remove(this.session, id, current.revision)
        this.index.set(id, { id, revision, deleted: true, size: 0, sha256: null, meta: null, updatedAt: null, deviceId: this.session.deviceId })
        return
      } catch (error) {
        if (error instanceof SyncApiError && error.conflict && attempt < MAX_WRITE_ATTEMPTS) continue
        throw fromApiError(error)
      }
    }
  }
}

export { fromBase64, toBase64 }
