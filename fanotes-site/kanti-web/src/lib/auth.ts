// FaNotes sign-in, derived in the browser exactly as the apps do it (SyncCrypto.deriveFromPassword):
// PBKDF2-SHA256 over the NFKC password, 512 bits; the first half wraps the vault key and never
// leaves the device, the second half is the authentication key the server checks.

export interface Kdf { algorithm: string; iterations: number; salt: string }

const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export const kdfSupported = (kdf: Kdf): boolean =>
  kdf?.algorithm === 'pbkdf2-sha256' && Number.isInteger(kdf.iterations) && kdf.iterations >= 100_000 && kdf.iterations <= 5_000_000 && typeof kdf.salt === 'string' && kdf.salt.length >= 20

export const deriveAuthKey = async (password: string, kdf: Kdf, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string> => {
  if (!kdfSupported(kdf)) throw new Error('kdf')
  const material = await subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(kdf.salt) as BufferSource, iterations: kdf.iterations }, material, 512))
  try {
    return toBase64(bits.slice(32, 64))
  } finally {
    bits.fill(0)
  }
}
