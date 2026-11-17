/** Data of the `fanotes-crypto` block: one of six tools with its inputs and the student's own answers. */

import { asRecord, asText, parseJsonObject } from '../blocks'

export const CRYPTO_TOOLS = ['caesar', 'freq', 'vigenere', 'xor', 'mod', 'dh'] as const
export type CryptoTool = (typeof CRYPTO_TOOLS)[number]

export const CRYPTO_TOOL_LABELS: Record<CryptoTool, string> = {
  caesar: 'Caesar und Alphabetstreifen',
  freq: 'Häufigkeitsanalyse',
  vigenere: 'Vigenère-Quadrat',
  xor: 'ASCII und XOR',
  mod: 'Rechnen mit Modulo',
  dh: 'Diffie-Hellman',
}

export const isCryptoTool = (value: unknown): value is CryptoTool => typeof value === 'string' && (CRYPTO_TOOLS as readonly string[]).includes(value)

export const CRYPTO_LIMITS = { title: 120, text: 400, answer: 600, freqText: 4000, keyword: 60, alphabet: 80, key: 60, number: 12, bits: 7, rows: 24 } as const

type Base = { v: 1; title: string }
export type CaesarMode = 'shift' | 'alphabet' | 'keyword'
export type CaesarData = Base & {
  tool: 'caesar'
  mode: CaesarMode
  shift: number
  /** The given cipher alphabet as the student typed it. */
  alphabet: string
  keyword: string
  /** The cipher alphabet the student builds for the keyword: 26 cells, `_` for an empty one. */
  built: string
  task: string
  answer: string
}
export type FreqData = Base & { tool: 'freq'; lang: 'de' | 'en'; text: string; map: Record<string, string> }
export type VigenereData = Base & { tool: 'vigenere'; key: string; plain: string; answer: string }
export type XorData = Base & { tool: 'xor'; plain: string; key: string; p: string[]; k: string[]; c: string[] }
export type ModData = Base & {
  tool: 'mod'; op: '*' | '+' | '^'; a: string; b: string; m: string; s1: string; s2: string; s3: string; s4: string
}
export type DhData = Base & { tool: 'dh'; y: string; p: string; a: string; b: string; alpha: string; beta: string; sa: string; sb: string }
export type CryptoData = CaesarData | FreqData | VigenereData | XorData | ModData | DhData

const TITLES: Record<CryptoTool, string> = {
  caesar: 'Caesar', freq: 'Häufigkeitsanalyse', vigenere: 'Vigenère', xor: 'ASCII und XOR', mod: 'Modulo', dh: 'Diffie-Hellman',
}

export const defaultCryptoData = (tool: CryptoTool = 'caesar'): CryptoData => {
  const base = { v: 1 as const, title: TITLES[tool] }
  switch (tool) {
    case 'caesar': return { ...base, tool, mode: 'shift', shift: 3, alphabet: '', keyword: '', built: '_'.repeat(26), task: '', answer: '' }
    case 'freq': return { ...base, tool, lang: 'de', text: '', map: {} }
    case 'vigenere': return { ...base, tool, key: '', plain: '', answer: '' }
    case 'xor': return { ...base, tool, plain: '', key: '', p: [], k: [], c: [] }
    case 'mod': return { ...base, tool, op: '*', a: '', b: '', m: '', s1: '', s2: '', s3: '', s4: '' }
    case 'dh': return { ...base, tool, y: '', p: '', a: '', b: '', alpha: '', beta: '', sa: '', sb: '' }
  }
}

const digits = (value: unknown) => asText(value, CRYPTO_LIMITS.number).replace(/\D/gu, '')
const list = (value: unknown, max: number, width: number) => (Array.isArray(value) ? value.slice(0, max).map((entry) => asText(entry, width)) : [])

/** Every stored field of a tool, cut to its cap or replaced by a default when it has the wrong type. */
export const normaliseCryptoData = (raw: unknown): CryptoData => {
  const source = asRecord(raw)
  const tool = isCryptoTool(source.tool) ? source.tool : 'caesar'
  const title = asText(source.title, CRYPTO_LIMITS.title)
  const L = CRYPTO_LIMITS
  switch (tool) {
    case 'caesar': {
      const shift = Number(source.shift)
      return {
        v: 1, title, tool,
        mode: source.mode === 'alphabet' || source.mode === 'keyword' ? source.mode : 'shift',
        shift: Number.isFinite(shift) ? Math.max(0, Math.min(25, Math.trunc(shift))) : 3,
        alphabet: asText(source.alphabet, L.alphabet),
        keyword: asText(source.keyword, L.keyword),
        built: asText(source.built, 26) || '_'.repeat(26),
        task: asText(source.task, L.text),
        answer: asText(source.answer, L.answer),
      }
    }
    case 'freq': {
      const map: Record<string, string> = {}
      for (const [cipher, plain] of Object.entries(asRecord(source.map))) {
        if (/^[A-Z]$/u.test(cipher) && typeof plain === 'string' && /^[a-z]$/u.test(plain)) map[cipher] = plain
      }
      return { v: 1, title, tool, lang: source.lang === 'en' ? 'en' : 'de', text: asText(source.text, L.freqText), map }
    }
    case 'vigenere': return { v: 1, title, tool, key: asText(source.key, L.key), plain: asText(source.plain, L.text), answer: asText(source.answer, L.answer) }
    case 'xor': return {
      v: 1, title, tool, plain: asText(source.plain, L.text), key: asText(source.key, L.key),
      p: list(source.p, L.rows, L.bits), k: list(source.k, L.rows, L.bits), c: list(source.c, L.rows, L.bits),
    }
    case 'mod': return {
      v: 1, title, tool, op: source.op === '+' || source.op === '^' ? source.op : '*',
      a: digits(source.a), b: digits(source.b), m: digits(source.m), s1: digits(source.s1), s2: digits(source.s2), s3: asText(source.s3, 400).replace(/\D/gu, ''), s4: digits(source.s4),
    }
    case 'dh': return {
      v: 1, title, tool, y: digits(source.y), p: digits(source.p), a: digits(source.a), b: digits(source.b),
      alpha: digits(source.alpha), beta: digits(source.beta), sa: digits(source.sa), sb: digits(source.sb),
    }
  }
}

export const parseCryptoData = (body: string): CryptoData => {
  const raw = parseJsonObject(body)
  return Object.keys(raw).length ? normaliseCryptoData(raw) : defaultCryptoData()
}

/** Every key any tool may write; used to tell unknown fields apart when a block is read. */
export const CRYPTO_KEYS = [
  'v', 'tool', 'title', 'mode', 'shift', 'alphabet', 'keyword', 'built', 'task', 'answer', 'lang', 'text', 'map', 'key', 'plain',
  'p', 'k', 'c', 'op', 'a', 'b', 'm', 's1', 's2', 's3', 's4', 'y', 'alpha', 'beta', 'sa', 'sb',
] as const
