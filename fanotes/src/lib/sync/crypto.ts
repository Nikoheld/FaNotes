// End-to-end encryption for Sync, WebCrypto only (runs in the renderer of the
// desktop app and in the browser build alike).
//
//   password + salt ──PBKDF2-SHA256 (600k)──▶ 64 bytes
//                                             ├─ wrapping key (AES-256-GCM) – never leaves the device
//                                             └─ auth key – the only thing the server ever sees (it scrypt-hashes it again)
//   vault secret (random 32 bytes) ─wrapped with the wrapping key─▶ stored on the server, opaque
//   vault secret ──HKDF──▶ data key (AES-256-GCM for file contents and metadata)
//                      └──▶ id key   (HMAC-SHA256 over the path = the file's server-side id)
//
// Changing the password re-wraps the same vault secret, so no file has to be
// re-encrypted. Losing the password loses the vault: the server cannot help.

export const KDF_ITERATIONS = 600_000
const KDF_ALGORITHM = 'pbkdf2-sha256'
const HKDF_SALT = new TextEncoder().encode('fanotes-sync-v1')
const GCM_IV_BYTES = 12

export type SyncKdf = { algorithm: typeof KDF_ALGORITHM; iterations: number; salt: string }
export type SyncKeyWrap = { iv: string; data: string }
export type SyncKeys = { data: CryptoKey; id: CryptoKey }

const subtle = () => {
  const api = globalThis.crypto?.subtle
  if (!api) throw new Error('WebCrypto steht in dieser Umgebung nicht zur Verfügung.')
  return api
}

export const randomBytes = (length: number) => {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

export const toBase64 = (bytes: ArrayBuffer | Uint8Array) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (let index = 0; index < view.length; index += 0x8000) binary += String.fromCharCode(...view.subarray(index, index + 0x8000))
  return btoa(binary)
}

export const fromBase64 = (text: string) => {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export const toHex = (bytes: ArrayBuffer | Uint8Array) => Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

export const sha256Hex = async (bytes: Uint8Array) => toHex(await subtle().digest('SHA-256', bytes as BufferSource))

export const newKdf = (): SyncKdf => ({ algorithm: KDF_ALGORITHM, iterations: KDF_ITERATIONS, salt: toBase64(randomBytes(16)) })

export const isValidKdf = (value: unknown): value is SyncKdf => {
  if (!value || typeof value !== 'object') return false
  const kdf = value as Record<string, unknown>
  return kdf.algorithm === KDF_ALGORITHM && Number.isInteger(kdf.iterations) && (kdf.iterations as number) >= 100_000 && (kdf.iterations as number) <= 5_000_000 && typeof kdf.salt === 'string' && kdf.salt.length >= 20
}

/** Derives the wrapping key (kept) and the auth key (sent) from the password. Deliberately slow. */
export const deriveFromPassword = async (password: string, kdf: SyncKdf): Promise<{ wrappingKey: CryptoKey; authKey: string }> => {
  if (!isValidKdf(kdf)) throw new Error('Die Schlüsselableitung des Kontos wird nicht unterstützt.')
  const api = subtle()
  const material = await api.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(await api.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(kdf.salt) as BufferSource, iterations: kdf.iterations }, material, 512))
  const wrappingKey = await api.importKey('raw', bits.subarray(0, 32) as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const authKey = toBase64(bits.subarray(32, 64))
  bits.fill(0)
  return { wrappingKey, authKey }
}

export const newVaultSecret = () => randomBytes(32)

export const wrapVaultSecret = async (secret: Uint8Array, wrappingKey: CryptoKey): Promise<SyncKeyWrap> => {
  const iv = randomBytes(GCM_IV_BYTES)
  const data = await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, wrappingKey, secret as BufferSource)
  return { iv: toBase64(iv), data: toBase64(data) }
}

export const unwrapVaultSecret = async (wrap: SyncKeyWrap, wrappingKey: CryptoKey): Promise<Uint8Array> => {
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(wrap.iv) as BufferSource }, wrappingKey, fromBase64(wrap.data) as BufferSource))
  } catch {
    throw new Error('Der Vault-Schlüssel konnte mit diesem Passwort nicht entschlüsselt werden.')
  }
}

/** Imports the raw vault secret as a non-extractable HKDF base key; the raw bytes can be dropped afterwards. */
export const importVaultSecret = (secret: Uint8Array) => subtle().importKey('raw', secret as BufferSource, 'HKDF', false, ['deriveKey', 'deriveBits'])

export const deriveSyncKeys = async (vaultSecret: CryptoKey): Promise<SyncKeys> => {
  const api = subtle()
  const encode = (info: string) => new TextEncoder().encode(info)
  const data = await api.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: encode('data') }, vaultSecret, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const id = await api.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: encode('id') }, vaultSecret, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
  return { data, id }
}

/** The server-side id of a path: an HMAC, so the server learns neither names nor folder structure. */
export const fileIdFor = async (keys: SyncKeys, path: string) => toHex(await subtle().sign('HMAC', keys.id, new TextEncoder().encode(path.normalize('NFC'))))

/** iv || ciphertext, authenticated with the file id so a blob cannot be swapped between paths. */
export const encryptBytes = async (keys: SyncKeys, fileId: string, plain: Uint8Array): Promise<Uint8Array> => {
  const iv = randomBytes(GCM_IV_BYTES)
  const cipher = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: new TextEncoder().encode(fileId) }, keys.data, plain as BufferSource))
  const out = new Uint8Array(iv.length + cipher.length)
  out.set(iv, 0)
  out.set(cipher, iv.length)
  return out
}

export const decryptBytes = async (keys: SyncKeys, fileId: string, blob: Uint8Array): Promise<Uint8Array> => {
  if (blob.length < GCM_IV_BYTES + 16) throw new Error('Der verschlüsselte Inhalt ist beschädigt.')
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: blob.subarray(0, GCM_IV_BYTES) as BufferSource, additionalData: new TextEncoder().encode(fileId) }, keys.data, blob.subarray(GCM_IV_BYTES) as BufferSource))
  } catch {
    throw new Error('Der Inhalt konnte nicht entschlüsselt werden – falscher Schlüssel oder beschädigte Datei.')
  }
}

export type SyncFileMeta = { path: string; mtimeMs: number; size: number; sha256: string }

export const encryptMeta = async (keys: SyncKeys, fileId: string, meta: SyncFileMeta) => toBase64(await encryptBytes(keys, fileId, new TextEncoder().encode(JSON.stringify(meta))))

export const decryptMeta = async (keys: SyncKeys, fileId: string, encoded: string): Promise<SyncFileMeta> => {
  const parsed = JSON.parse(new TextDecoder().decode(await decryptBytes(keys, fileId, fromBase64(encoded)))) as Partial<SyncFileMeta>
  if (typeof parsed.path !== 'string' || typeof parsed.sha256 !== 'string') throw new Error('Die Metadaten der Datei sind unvollständig.')
  return { path: parsed.path, mtimeMs: Number(parsed.mtimeMs) || 0, size: Number(parsed.size) || 0, sha256: parsed.sha256 }
}

export const passwordProblems = (password: string): string | null => {
  if (password.length < 10) return 'Das Passwort braucht mindestens 10 Zeichen.'
  if (password.length > 256) return 'Das Passwort ist zu lang.'
  if (/^(.)\1+$/u.test(password) || /^(?:0123456789|1234567890|qwertzuiop|asdfghjkl)/iu.test(password)) return 'Dieses Passwort ist zu leicht zu erraten.'
  return null
}

// ── Sharing keys ────────────────────────────────────────────────────────────
//
// Every account owns an ECDH P-256 key pair. The public half is published at
// account creation so others can share with the account's username. The private
// half never leaves the devices unencrypted: it is wrapped with a key derived
// from the vault secret, so every device of the account can open it.
//
// A share has its own random 32-byte share key K. K is wrapped for the
// recipient (ephemeral ECDH with their public key + HKDF + AES-GCM) and for the
// owner (same, to the owner's own public key). File contents, names and the
// share title are encrypted with keys derived from K, the same way vault sync
// does with the vault secret, so the server only ever sees ciphertext.

export type UserKeyWrap = SyncKeyWrap
export type ShareKeyWrap = { epk: string; iv: string; data: string }
export type UserKeyPair = { publicKey: string; privateKey: CryptoKey; wrap: UserKeyWrap }

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const
const WRAP_SALT = new TextEncoder().encode('fanotes-share-v1')

const userKeyWrapKey = async (vaultSecret: CryptoKey) => subtle().deriveKey(
  { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: new TextEncoder().encode('user-key') },
  vaultSecret,
  { name: 'AES-GCM', length: 256 },
  false,
  ['encrypt', 'decrypt'],
)

const importPrivate = (pkcs8: Uint8Array) => subtle().importKey('pkcs8', pkcs8 as BufferSource, ECDH, false, ['deriveBits'])

/** Creates the account's sharing key pair and wraps the private half with the vault secret. */
export const createUserKeyPair = async (vaultSecret: CryptoKey): Promise<UserKeyPair> => {
  const api = subtle()
  const pair = await api.generateKey(ECDH, true, ['deriveBits']) as CryptoKeyPair
  const publicKey = toBase64(await api.exportKey('raw', pair.publicKey))
  const pkcs8 = new Uint8Array(await api.exportKey('pkcs8', pair.privateKey))
  const iv = randomBytes(GCM_IV_BYTES)
  const data = await api.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: new TextEncoder().encode(publicKey) }, await userKeyWrapKey(vaultSecret), pkcs8 as BufferSource)
  const privateKey = await importPrivate(pkcs8)
  pkcs8.fill(0)
  return { publicKey, privateKey, wrap: { iv: toBase64(iv), data: toBase64(data) } }
}

/** Opens the wrapped private key. The public key is bound as additional data, so a swapped public key fails. */
export const openUserPrivateKey = async (publicKey: string, wrap: UserKeyWrap, vaultSecret: CryptoKey): Promise<CryptoKey> => {
  try {
    const pkcs8 = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(wrap.iv) as BufferSource, additionalData: new TextEncoder().encode(publicKey) }, await userKeyWrapKey(vaultSecret), fromBase64(wrap.data) as BufferSource))
    const key = await importPrivate(pkcs8)
    pkcs8.fill(0)
    return key
  } catch {
    throw new Error('Der Freigabe-Schlüssel des Kontos konnte nicht geöffnet werden.')
  }
}

const sharedWrapKey = async (privateKey: CryptoKey, peerPublicRaw: Uint8Array, usages: KeyUsage[]) => {
  const api = subtle()
  const peer = await api.importKey('raw', peerPublicRaw as BufferSource, ECDH, false, [])
  const bits = await api.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256)
  const base = await api.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return api.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: WRAP_SALT, info: new TextEncoder().encode('share-key') }, base, { name: 'AES-GCM', length: 256 }, false, usages)
}

export const newShareKey = () => randomBytes(32)

/** Wraps a share key for the holder of `recipientPublicKey` (base64 raw P-256). */
export const wrapShareKey = async (shareKey: Uint8Array, recipientPublicKey: string): Promise<ShareKeyWrap> => {
  const api = subtle()
  let recipient: Uint8Array
  try { recipient = fromBase64(recipientPublicKey) } catch { throw new Error('Der öffentliche Schlüssel des Empfängers ist ungültig.') }
  if (recipient.length !== 65) throw new Error('Der öffentliche Schlüssel des Empfängers ist ungültig.')
  const ephemeral = await api.generateKey(ECDH, true, ['deriveBits']) as CryptoKeyPair
  const epkRaw = new Uint8Array(await api.exportKey('raw', ephemeral.publicKey))
  const key = await sharedWrapKey(ephemeral.privateKey, recipient, ['encrypt'])
  const iv = randomBytes(GCM_IV_BYTES)
  const data = await api.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: epkRaw as BufferSource }, key, shareKey as BufferSource)
  return { epk: toBase64(epkRaw), iv: toBase64(iv), data: toBase64(data) }
}

export const unwrapShareKey = async (wrap: ShareKeyWrap, privateKey: CryptoKey): Promise<Uint8Array> => {
  try {
    const epk = fromBase64(wrap.epk)
    const key = await sharedWrapKey(privateKey, epk, ['decrypt'])
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(wrap.iv) as BufferSource, additionalData: epk as BufferSource }, key, fromBase64(wrap.data) as BufferSource))
  } catch {
    throw new Error('Der Freigabe-Schlüssel konnte nicht geöffnet werden.')
  }
}

/** Data and id keys of one share, derived from its share key. */
export const deriveShareKeys = async (shareKey: Uint8Array): Promise<SyncKeys> => deriveSyncKeys(await importVaultSecret(shareKey))

export type ShareTitle = { name: string; kind: 'note' | 'folder'; rootPath: string }

export const encryptShareTitle = async (keys: SyncKeys, title: ShareTitle): Promise<{ iv: string; data: string }> => {
  const blob = await encryptBytes(keys, 'title', new TextEncoder().encode(JSON.stringify(title)))
  return { iv: toBase64(blob.subarray(0, GCM_IV_BYTES)), data: toBase64(blob.subarray(GCM_IV_BYTES)) }
}

export const decryptShareTitle = async (keys: SyncKeys, enc: { iv: string; data: string }): Promise<ShareTitle> => {
  const blob = new Uint8Array([...fromBase64(enc.iv), ...fromBase64(enc.data)])
  const parsed = JSON.parse(new TextDecoder().decode(await decryptBytes(keys, 'title', blob))) as Partial<ShareTitle>
  if (typeof parsed.name !== 'string' || (parsed.kind !== 'note' && parsed.kind !== 'folder')) throw new Error('Der Titel der Freigabe ist unvollständig.')
  return { name: parsed.name, kind: parsed.kind, rootPath: typeof parsed.rootPath === 'string' ? parsed.rootPath : '' }
}

/** A short fingerprint of a public key, shown so two people can compare it out of band. */
export const keyFingerprint = async (publicKey: string) => {
  const digest = toHex(await subtle().digest('SHA-256', fromBase64(publicKey) as BufferSource)).slice(0, 20)
  return digest.match(/.{1,4}/gu)?.join(' ') ?? digest
}

/** A fresh random device key: 32 random bytes as base64. It takes the place of a password for accounts without one. */
export const newDeviceKey = () => toBase64(randomBytes(32))

export const USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,30})[A-Za-z0-9]$/u
export const usernameProblem = (name: string): string | null => {
  const trimmed = name.trim()
  if (trimmed.length < 3 || trimmed.length > 32) return 'Der Benutzername braucht 3 bis 32 Zeichen.'
  if (!USERNAME_PATTERN.test(trimmed) || /[._-]{2}/u.test(trimmed)) return 'Erlaubt sind Buchstaben, Ziffern, Punkt, Unterstrich und Bindestrich, ohne doppelte Trennzeichen.'
  return null
}
