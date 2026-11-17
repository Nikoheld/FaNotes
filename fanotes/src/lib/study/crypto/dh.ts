/** Diffie-Hellman key exchange; all arithmetic with BigInt. Expected values only serve to check the student's fields. */

import { modPow } from './modular'

export const DH_FIELDS = ['alpha', 'beta', 'sa', 'sb'] as const
export type DhField = (typeof DH_FIELDS)[number]

const big = (value: string) => (/^\d{1,12}$/u.test(value) ? BigInt(value) : null)

/** What is wrong with the inputs (empty when all is fine). */
export const dhProblems = (y: string, p: string, a: string, b: string): string[] => {
  const problems: string[] = []
  const [vy, vp, va, vb] = [big(y), big(p), big(a), big(b)]
  if (vp === null) problems.push('P muss eine ganze Zahl sein.')
  else if (vp < 2n) problems.push('P muss mindestens 2 sein.')
  if (vy === null) problems.push('Y muss eine ganze Zahl sein.')
  else if (vp !== null && vp >= 2n && vy >= vp) problems.push('Y muss kleiner als P sein.')
  else if (vy < 1n) problems.push('Y muss mindestens 1 sein.')
  if (va === null) problems.push('A muss eine ganze Zahl sein.')
  if (vb === null) problems.push('B muss eine ganze Zahl sein.')
  return problems
}

export const dhExpected = (y: string, p: string, a: string, b: string): Record<DhField, string> | null => {
  if (dhProblems(y, p, a, b).length) return null
  const [vy, vp, va, vb] = [big(y) as bigint, big(p) as bigint, big(a) as bigint, big(b) as bigint]
  const alpha = modPow(vy, va, vp)
  const beta = modPow(vy, vb, vp)
  return { alpha: String(alpha), beta: String(beta), sa: String(modPow(beta, va, vp)), sb: String(modPow(alpha, vb, vp)) }
}

export type DhState = 'ok' | 'bad' | 'open'

export const checkDhField = (y: string, p: string, a: string, b: string, field: DhField, value: string): DhState => {
  const typed = value.trim()
  if (!typed) return 'open'
  const expected = dhExpected(y, p, a, b)
  return expected && /^\d+$/u.test(typed) && BigInt(typed) === BigInt(expected[field]) ? 'ok' : 'bad'
}

/** Whether the student's s_a and s_b (both filled) agree. `null` while one is missing. */
export const secretsAgree = (sa: string, sb: string) => (sa.trim() && sb.trim() ? sa.trim() === sb.trim() : null)
