// Order keys ("fractional indexing"): strings that sort in document order and
// always leave room for another key between two neighbours, so a paragraph can
// be inserted or moved without renumbering the others. A key is a variable-
// length integer part (`a0`, `a1` … `az`, `b00` …; `Z…` below `a0`) followed by
// an optional fraction. Appending keeps keys short: 10 000 paragraphs need 4 chars.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const SMALLEST_INTEGER = `A${'0'.repeat(26)}`
const ZERO = 'a0'

const integerLength = (head: string) => {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2
  throw new Error(`invalid order key head: ${head}`)
}

const integerPart = (key: string) => {
  const length = integerLength(key[0])
  if (length > key.length) throw new Error(`invalid order key: ${key}`)
  return key.slice(0, length)
}

/** True for a well-formed key (integer part, fraction without trailing zero). */
export const isValidKey = (key: unknown): key is string => {
  if (typeof key !== 'string' || !key || key.length > 512) return false
  if (key === SMALLEST_INTEGER) return false
  try {
    const head = integerPart(key)
    if ([...key].some((char) => !DIGITS.includes(char) && !/[A-Za-z]/u.test(char))) return false
    const fraction = key.slice(head.length)
    return !fraction.endsWith('0')
  } catch {
    return false
  }
}

const midpoint = (a: string, b: string | null): string => {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`)
  if (a.endsWith('0') || (b && b.endsWith('0'))) throw new Error('trailing zero')
  if (b) {
    let shared = 0
    while ((a[shared] || '0') === b[shared]) shared += 1
    if (shared > 0) return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared))
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)]
  if (b && b.length > 1) return b.slice(0, 1)
  return DIGITS[digitA] + midpoint(a.slice(1), null)
}

const incrementInteger = (value: string): string | null => {
  const [head, ...digits] = value.split('')
  let carry = true
  for (let index = digits.length - 1; carry && index >= 0; index -= 1) {
    const next = DIGITS.indexOf(digits[index]) + 1
    if (next === DIGITS.length) digits[index] = '0'
    else {
      digits[index] = DIGITS[next]
      carry = false
    }
  }
  if (!carry) return head + digits.join('')
  if (head === 'Z') return `a${DIGITS[0]}`
  if (head === 'z') return null
  const nextHead = String.fromCharCode(head.charCodeAt(0) + 1)
  if (nextHead > 'a') digits.push('0')
  else digits.pop()
  return nextHead + digits.join('')
}

const decrementInteger = (value: string): string | null => {
  const [head, ...digits] = value.split('')
  let borrow = true
  for (let index = digits.length - 1; borrow && index >= 0; index -= 1) {
    const next = DIGITS.indexOf(digits[index]) - 1
    if (next === -1) digits[index] = DIGITS[DIGITS.length - 1]
    else {
      digits[index] = DIGITS[next]
      borrow = false
    }
  }
  if (!borrow) return head + digits.join('')
  if (head === 'a') return `Z${DIGITS[DIGITS.length - 1]}`
  if (head === 'A') return null
  const nextHead = String.fromCharCode(head.charCodeAt(0) - 1)
  if (nextHead < 'Z') digits.push(DIGITS[DIGITS.length - 1])
  else digits.pop()
  return nextHead + digits.join('')
}

/** A key strictly between `a` and `b` (null = open end). */
export const keyBetween = (a: string | null, b: string | null): string => {
  if (a !== null && b !== null && a >= b) throw new Error(`order keys out of order: ${a} >= ${b}`)
  if (a === null) {
    if (b === null) return ZERO
    const head = integerPart(b)
    const fraction = b.slice(head.length)
    if (head === SMALLEST_INTEGER) return head + midpoint('', fraction)
    if (head < b) return head
    const lower = decrementInteger(head)
    if (lower === null) throw new Error('cannot go below the smallest order key')
    return lower
  }
  if (b === null) {
    const head = integerPart(a)
    const fraction = a.slice(head.length)
    const higher = incrementInteger(head)
    return higher === null ? head + midpoint(fraction, null) : higher
  }
  const headA = integerPart(a)
  const fractionA = a.slice(headA.length)
  const headB = integerPart(b)
  const fractionB = b.slice(headB.length)
  if (headA === headB) return headA + midpoint(fractionA, fractionB)
  const higher = incrementInteger(headA)
  if (higher === null) throw new Error('cannot go above the largest order key')
  return higher < b ? higher : headA + midpoint(fractionA, null)
}

/** `count` keys in order, strictly between `a` and `b`. */
export const keysBetween = (a: string | null, b: string | null, count: number): string[] => {
  if (count <= 0) return []
  if (count === 1) return [keyBetween(a, b)]
  if (b === null) {
    const out: string[] = []
    let previous = a
    for (let index = 0; index < count; index += 1) {
      previous = keyBetween(previous, null)
      out.push(previous)
    }
    return out
  }
  if (a === null) {
    const out: string[] = []
    let next = b
    for (let index = 0; index < count; index += 1) {
      next = keyBetween(null, next)
      out.push(next)
    }
    return out.reverse()
  }
  const half = Math.floor(count / 2)
  const middle = keyBetween(a, b)
  return [...keysBetween(a, middle, half), middle, ...keysBetween(middle, b, count - half - 1)]
}
