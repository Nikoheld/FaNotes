export const MATH_SOLVER_MAX_VARIABLES = 8

const MAX_INPUT_LENGTH = 512
const SAFE_FUNCTIONS = new Set([
  'abs', 'acos', 'asin', 'atan', 'cos', 'cosh', 'exp', 'factorial', 'log', 'max', 'min', 'sin', 'sinh',
  'sqrt', 'tan', 'tanh',
])
const CONSTANTS = new Set(['e', 'i', 'pi'])

const normalizeUnicode = (value: string) => value
  .normalize('NFKC')
  .replace(/[−–—]/gu, '-')
  .replace(/[×·⋅]/gu, '*')
  .replace(/[÷]/gu, '/')
  .replace(/[π]/gu, 'pi')
  .replace(/√\s*\(/gu, 'sqrt(')
  .replace(/√\s*([A-Za-z0-9.]+)/gu, 'sqrt($1)')
  .replace(/\s+/gu, '')

const nestingDepth = (value: string) => {
  let depth = 0
  let maximum = 0
  for (const char of value) {
    if (char === '(') maximum = Math.max(maximum, ++depth)
    else if (char === ')' && --depth < 0) return -1
  }
  return depth === 0 ? maximum : -1
}

export const normalizeMathInput = (input: string) => {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Der ausgewählte mathematische Ausdruck ist leer.')
  if (input.length > MAX_INPUT_LENGTH) throw new Error('Der ausgewählte Ausdruck ist für eine sichere lokale Berechnung zu lang.')
  const normalized = normalizeUnicode(input)
  if (!normalized || normalized.length > MAX_INPUT_LENGTH) throw new Error('Der Ausdruck ist zu lang.')
  if (!/^[0-9A-Za-z_+\-*/^().,=!]+$/u.test(normalized)) {
    throw new Error('Der Ausdruck enthält ein Zeichen, das der lokale Mathematik-Löser noch nicht sicher unterstützt.')
  }
  if ((normalized.match(/=/gu) ?? []).length > 1 || /==|!=|:=|\*\*|\/\//u.test(normalized)) {
    throw new Error('Bitte wähle genau einen Term oder eine einzelne Gleichung aus.')
  }
  const depth = nestingDepth(normalized)
  if (depth < 0 || depth > 24) {
    throw new Error('Die Klammerung des Ausdrucks ist ungültig oder zu tief verschachtelt.')
  }
  for (const match of normalized.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\(/gu)) {
    if (!SAFE_FUNCTIONS.has(match[1])) throw new Error(`Die Funktion „${match[1]}“ ist im sicheren Mathematikmodus nicht erlaubt.`)
  }
  for (const match of normalized.matchAll(/\^\(?(-?\d{1,4})\)?/gu)) {
    if (Math.abs(Number(match[1])) > 100) throw new Error('Exponenten über 100 werden zum Schutz vor blockierenden Berechnungen nicht verarbeitet.')
  }
  return normalized
}

export const inspectMathInputSyntax = (input: string) => {
  const normalizedInput = normalizeMathInput(input)
  const variables = [...normalizedInput.matchAll(/[A-Za-z_][A-Za-z0-9_]*/gu)]
    .map((match) => match[0])
    .filter((name) => !SAFE_FUNCTIONS.has(name) && !CONSTANTS.has(name))
    .filter((name) => /^[A-Za-z][A-Za-z0-9_]{0,15}$/u.test(name))
    .filter((name, index, all) => all.indexOf(name) === index)
    .sort((left, right) => left === 'x' ? -1 : right === 'x' ? 1 : left.localeCompare(right))
  if (variables.length > MATH_SOLVER_MAX_VARIABLES) throw new Error('Der Ausdruck enthält zu viele verschiedene Variablen.')
  return {
    normalizedInput,
    variables,
    isEquation: normalizedInput.includes('='),
  }
}

