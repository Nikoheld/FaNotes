// Where the browser keeps the vault access between page loads.
//
// IndexedDB stores CryptoKey objects by structured clone, so the data key, the id key and the key
// that seals the sync token stay NON-extractable: a script can use them in this origin but cannot
// read their bytes. The password, the PBKDF2 output, the wrapping key and the raw vault secret are
// never stored. Without IndexedDB (private mode, blocked storage) the access lives in memory only
// and the page asks for the password again after a reload.
import type { SyncKeys } from '@sync/crypto'

export interface StoredVault {
  v: 1
  accountId: string
  deviceId: string
  email: string
  expiresAt: string
  /** Seals the sync token below; non-extractable AES-GCM. */
  tokenKey: CryptoKey
  token: { iv: Uint8Array; data: Uint8Array }
  keys: SyncKeys
  /** The Schulnetz connection slot the user chose for each connection of this browser (see slots.ts). */
  slots?: Record<string, string>
}

export interface KeyStore {
  load(): Promise<StoredVault | null>
  save(value: StoredVault): Promise<void>
  /** Removes everything this origin keeps for the vault. Must not throw. */
  wipe(): Promise<void>
  /** True when the access survives a reload. */
  readonly persistent: boolean
}

const DB_NAME = 'kanti-vault'
const STORE = 'access'
const KEY = 'current'

const open = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, 1)
  request.onupgradeneeded = () => { request.result.createObjectStore(STORE) }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
  request.onblocked = () => reject(new Error('blocked'))
})

const run = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const request = action(transaction.objectStore(STORE))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

export const indexedDbAvailable = (): boolean => {
  try { return typeof indexedDB !== 'undefined' && indexedDB !== null } catch { return false }
}

export const createIndexedDbStore = (): KeyStore => ({
  persistent: true,
  load: async () => {
    try {
      const value = await run<StoredVault | undefined>('readonly', (store) => store.get(KEY))
      return value && value.v === 1 ? value : null
    } catch { return null }
  },
  save: async (value) => { await run('readwrite', (store) => store.put(value, KEY)) },
  wipe: async () => {
    try { await run('readwrite', (store) => store.delete(KEY)) } catch { /* nothing to remove */ }
    try {
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(DB_NAME)
        request.onsuccess = () => resolve()
        request.onerror = () => resolve()
        request.onblocked = () => resolve()
      })
    } catch { /* ignore */ }
  },
})

/** Memory only: used when IndexedDB is unavailable and in tests. */
export const createMemoryStore = (): KeyStore => {
  let held: StoredVault | null = null
  return {
    persistent: false,
    load: async () => held,
    save: async (value) => { held = value },
    wipe: async () => { held = null },
  }
}

/** IndexedDB when it works (checked with a real write), otherwise memory. */
export const pickKeyStore = async (): Promise<KeyStore> => {
  if (!indexedDbAvailable()) return createMemoryStore()
  try {
    await run('readonly', (store) => store.get(KEY))
    return createIndexedDbStore()
  } catch { return createMemoryStore() }
}
