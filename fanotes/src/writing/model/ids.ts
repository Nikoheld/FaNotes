const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 14 random base-36 characters (~72 bits): ids of projects, scenes, paragraphs, notes. */
export const newId = (length = 14) => {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return out
}

export const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-z]{6,40}$/u.test(value)

const WRITER_KEY = 'fanotes.writing.writer.v1'

/** This installation's writer id for version vectors. Stable per browser profile / app install. */
export const writerId = () => {
  try {
    const stored = globalThis.localStorage?.getItem(WRITER_KEY)
    if (stored && /^[0-9a-z]{8,16}$/u.test(stored)) return stored
    const created = newId(10)
    globalThis.localStorage?.setItem(WRITER_KEY, created)
    return created
  } catch {
    return 'local'
  }
}
