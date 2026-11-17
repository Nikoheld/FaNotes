/** Modulo arithmetic with "reduce first". The expected values are only used to check what the student entered. */

export type ModOp = '*' | '+' | '^'

export const MOD_FIELDS = ['s1', 's2', 's3', 's4'] as const
export type ModField = (typeof MOD_FIELDS)[number]

export const MOD_POWER_MAX = 200

export type ModFieldSpec = { key: ModField; label: string }

export const modFields = (op: ModOp): ModFieldSpec[] => (op === '^'
  ? [{ key: 's1', label: 'a mod m' }, { key: 's3', label: '(a mod m) hoch b' }, { key: 's4', label: 'Resultat mod m' }]
  : [
    { key: 's1', label: 'a mod m' },
    { key: 's2', label: 'b mod m' },
    { key: 's3', label: op === '*' ? 'Produkt' : 'Summe' },
    { key: 's4', label: 'Resultat mod m' },
  ])

const big = (value: string) => (/^\d{1,12}$/u.test(value) ? BigInt(value) : null)

export const modPow = (base: bigint, exponent: bigint, modulus: bigint) => {
  let result = 1n % modulus
  let b = base % modulus
  let e = exponent
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus
    b = (b * b) % modulus
    e >>= 1n
  }
  return result
}

/** Problem with the inputs, or '' when the scaffold can be used. */
export const modProblem = (op: ModOp, a: string, b: string, m: string) => {
  if (big(a) === null || big(b) === null || big(m) === null) return 'Gib a, b und m als ganze Zahlen ein.'
  if ((big(m) as bigint) < 2n) return 'm muss mindestens 2 sein.'
  if (op === '^' && (big(b) as bigint) > BigInt(MOD_POWER_MAX)) return `Der Exponent ist für die Zwischenrechnung zu gross (höchstens ${MOD_POWER_MAX}).`
  return ''
}

export const modExpected = (op: ModOp, a: string, b: string, m: string): Record<ModField, string> | null => {
  if (modProblem(op, a, b, m)) return null
  const [x, y, mod] = [big(a) as bigint, big(b) as bigint, big(m) as bigint]
  const s1 = x % mod
  const s2 = y % mod
  const s3 = op === '^' ? s1 ** y : op === '*' ? s1 * s2 : s1 + s2
  return { s1: String(s1), s2: String(s2), s3: String(s3), s4: String(s3 % mod) }
}

export type FieldState = 'ok' | 'bad' | 'open'

/** Checks one filled field. An empty field stays `open`; the expected value is not part of the result. */
export const checkModField = (op: ModOp, a: string, b: string, m: string, key: ModField, value: string): FieldState => {
  const typed = value.trim()
  if (!typed) return 'open'
  const expected = modExpected(op, a, b, m)
  return expected && /^\d+$/u.test(typed) && BigInt(typed) === BigInt(expected[key]) ? 'ok' : 'bad'
}

export const MOD_RULES = [
  '(a + b) mod m = ((a mod m) + (b mod m)) mod m',
  '(a · b) mod m = ((a mod m) · (b mod m)) mod m',
  '(a hoch b) mod m = ((a mod m) hoch b) mod m',
] as const
