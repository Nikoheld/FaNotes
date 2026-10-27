/**
 * Typed f(x) stamps. A small recursive-descent parser — no eval, no Function.
 * Paths are a 24×24 figure: axes, arrowheads, ticks, and the curve.
 */

export const DEFAULT_GRAPH_EXPRESSION = 'sin(x)'
export const DEFAULT_GRAPH_X_MIN = -6.2832
export const DEFAULT_GRAPH_X_MAX = 6.2832
export const GRAPH_PRESETS = ['sin(x)', 'cos(x)', 'x^2', '1/x', 'exp(-x^2)'] as const

export const GRAPH_ERROR_EMPTY = 'Die Formel ist leer.'
export const GRAPH_ERROR_CHAR = 'Die Formel enthält ein Zeichen, das nicht erlaubt ist.'
export const GRAPH_ERROR_LONG = 'Die Formel ist zu lang.'
export const GRAPH_ERROR_PARENS = 'Die Klammerung der Formel ist ungültig.'
export const GRAPH_ERROR_VARIABLE = 'Nur die Variable x ist erlaubt.'
export const GRAPH_ERROR_FUNCTION = 'Diese Funktion ist nicht erlaubt.'
export const GRAPH_ERROR_DOMAIN = 'x-Minimum muss kleiner als x-Maximum sein.'
export const GRAPH_ERROR_EMPTY_RANGE = 'Die Formel hat in diesem Bereich keinen Wert.'

const MAX_EXPRESSION_LENGTH = 180
const MAX_DEPTH = 24
const MAX_ABS_EXPONENT = 100
const SAMPLE_COUNT = 280
const BOX = 24
const MARGIN = 2.2
const MAX_PATHS = 32
const MAX_PATH_CHARS = 8000
const PATH_PATTERN = /^[ML\d\s.,-]+$/u

const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
  'sqrt', 'abs', 'exp', 'ln', 'log', 'log10',
])

type GraphFunction = (value: number) => number

const FUNCTION_IMPL: Record<string, GraphFunction> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sqrt: (value) => value < 0 ? Number.NaN : Math.sqrt(value),
  abs: Math.abs,
  exp: (value) => Math.abs(value) > 40 ? (value > 0 ? Number.POSITIVE_INFINITY : 0) : Math.exp(value),
  ln: (value) => value > 0 ? Math.log(value) : Number.NaN,
  log: (value) => value > 0 ? Math.log(value) : Number.NaN,
  log10: (value) => value > 0 ? Math.log10(value) : Number.NaN,
}

type GraphExpr = (x: number) => number

type Token =
  | { type: 'num'; value: number }
  | { type: 'id'; name: string }
  | { type: 'op'; op: string }
  | { type: 'lp' }
  | { type: 'rp' }
  | { type: 'eof' }

const normalizeExpression = (input: string) => input
  .normalize('NFKC')
  .replace(/[−–—]/gu, '-')
  .replace(/[×·⋅]/gu, '*')
  .replace(/÷/gu, '/')
  .replace(/π/gu, 'pi')
  .replace(/√/gu, 'sqrt')

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1
      continue
    }
    if (char === '(') {
      tokens.push({ type: 'lp' })
      index += 1
      continue
    }
    if (char === ')') {
      tokens.push({ type: 'rp' })
      index += 1
      continue
    }
    if (char === '+' || char === '-' || char === '*' || char === '/' || char === '^') {
      tokens.push({ type: 'op', op: char })
      index += 1
      continue
    }
    if (char === '.' || (char >= '0' && char <= '9')) {
      let end = index
      let sawDigit = false
      let sawDot = false
      if (source[end] === '.') {
        sawDot = true
        end += 1
      }
      while (end < source.length && source[end] >= '0' && source[end] <= '9') {
        sawDigit = true
        end += 1
      }
      if (!sawDot && source[end] === '.') {
        sawDot = true
        end += 1
        while (end < source.length && source[end] >= '0' && source[end] <= '9') {
          sawDigit = true
          end += 1
        }
      }
      const exponent = source[end]
      const exponentSign = source[end + 1]
      const exponentDigit = exponentSign === '+' || exponentSign === '-' ? source[end + 2] : exponentSign
      if (
        sawDigit
        && (exponent === 'e' || exponent === 'E')
        && exponentDigit >= '0'
        && exponentDigit <= '9'
      ) {
        end += 1
        if (source[end] === '+' || source[end] === '-') end += 1
        while (end < source.length && source[end] >= '0' && source[end] <= '9') end += 1
      }
      if (!sawDigit) throw new Error(GRAPH_ERROR_CHAR)
      const value = Number(source.slice(index, end))
      if (!Number.isFinite(value)) throw new Error(GRAPH_ERROR_CHAR)
      tokens.push({ type: 'num', value })
      index = end
      continue
    }
    if ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_') {
      let end = index + 1
      while (end < source.length) {
        const next = source[end]
        const word = (next >= 'A' && next <= 'Z') || (next >= 'a' && next <= 'z') || (next >= '0' && next <= '9') || next === '_'
        if (!word) break
        end += 1
      }
      tokens.push({ type: 'id', name: source.slice(index, end) })
      index = end
      continue
    }
    throw new Error(GRAPH_ERROR_CHAR)
  }
  tokens.push({ type: 'eof' })
  return tokens
}

const compileTokens = (tokens: Token[]): GraphExpr => {
  let cursor = 0
  let depth = 0
  const peek = () => tokens[cursor]
  const take = () => tokens[cursor++]
  const startsPrimary = (token: Token) => token.type === 'num' || token.type === 'id' || token.type === 'lp'

  const parseAdd = (): GraphExpr => {
    let left = parseMul()
    for (;;) {
      const token = peek()
      if (token.type !== 'op' || (token.op !== '+' && token.op !== '-')) break
      take()
      const right = parseMul()
      const op = token.op
      const previous = left
      left = (x) => op === '+' ? previous(x) + right(x) : previous(x) - right(x)
    }
    return left
  }

  const parseMul = (): GraphExpr => {
    let left = parseUnary()
    for (;;) {
      const token = peek()
      if (token.type === 'op' && (token.op === '*' || token.op === '/')) {
        take()
        const right = parseUnary()
        const op = token.op
        const previous = left
        left = (x) => op === '*' ? previous(x) * right(x) : previous(x) / right(x)
        continue
      }
      // 2x and 2sin(x): a primary after a factor is a product.
      if (!startsPrimary(token)) break
      const right = parseUnary()
      const previous = left
      left = (x) => previous(x) * right(x)
    }
    return left
  }

  // Unary minus sits above power, so -x^2 is -(x^2). The exponent may itself be signed.
  const parseUnary = (): GraphExpr => {
    const token = peek()
    if (token.type === 'op' && (token.op === '-' || token.op === '+')) {
      take()
      depth += 1
      if (depth > MAX_DEPTH) throw new Error(GRAPH_ERROR_PARENS)
      const inner = parseUnary()
      depth -= 1
      return token.op === '-' ? (x) => -inner(x) : inner
    }
    return parsePow()
  }

  const parsePow = (): GraphExpr => {
    const base = parsePrimary()
    const token = peek()
    if (token.type !== 'op' || token.op !== '^') return base
    take()
    const exponent = parseUnary()
    return (x) => {
      const power = exponent(x)
      if (!Number.isFinite(power) || Math.abs(power) > MAX_ABS_EXPONENT) return Number.NaN
      return base(x) ** power
    }
  }

  const parsePrimary = (): GraphExpr => {
    if (depth > MAX_DEPTH) throw new Error(GRAPH_ERROR_PARENS)
    const token = take()
    if (token.type === 'num') return () => token.value
    if (token.type === 'lp') {
      depth += 1
      const inner = parseAdd()
      depth -= 1
      if (take().type !== 'rp') throw new Error(GRAPH_ERROR_PARENS)
      return inner
    }
    if (token.type === 'id') {
      if (token.name === 'pi') return () => Math.PI
      if (token.name === 'e') return () => Math.E
      if (token.name === 'x') return (x) => x
      if (peek().type === 'lp') {
        if (!FUNCTIONS.has(token.name)) throw new Error(GRAPH_ERROR_FUNCTION)
        take()
        depth += 1
        const argument = parseAdd()
        depth -= 1
        if (take().type !== 'rp') throw new Error(GRAPH_ERROR_PARENS)
        const apply = FUNCTION_IMPL[token.name]
        return (x) => apply(argument(x))
      }
      throw new Error(GRAPH_ERROR_VARIABLE)
    }
    throw new Error(GRAPH_ERROR_PARENS)
  }

  const expression = parseAdd()
  if (peek().type !== 'eof') throw new Error(GRAPH_ERROR_PARENS)
  return expression
}

/** Compile a formula of x. Throws a German Error when the formula is rejected. */
export const compileFunctionGraph = (expression: string): GraphExpr => {
  if (typeof expression !== 'string' || !expression.trim()) throw new Error(GRAPH_ERROR_EMPTY)
  if (expression.length > MAX_EXPRESSION_LENGTH) throw new Error(GRAPH_ERROR_LONG)
  const normalized = normalizeExpression(expression)
  if (!normalized.trim()) throw new Error(GRAPH_ERROR_EMPTY)
  if (normalized.length > MAX_EXPRESSION_LENGTH) throw new Error(GRAPH_ERROR_LONG)
  return compileTokens(tokenize(normalized))
}

const formatCoord = (value: number) => {
  const clamped = Math.min(BOX, Math.max(0, value))
  const rounded = Math.round(clamped * 100) / 100
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

const polyline = (points: ReadonlyArray<readonly [number, number]>) => {
  if (points.length < 2) return ''
  let path = `M ${formatCoord(points[0][0])} ${formatCoord(points[0][1])}`
  for (let index = 1; index < points.length; index += 1) {
    path += ` L ${formatCoord(points[index][0])} ${formatCoord(points[index][1])}`
  }
  return path
}

const quantile = (sorted: readonly number[], ratio: number) => (
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))]
)

/**
 * Axes plus the curve, split where the function jumps (tan, 1/x).
 * One ink color strokes every path.
 */
export const functionGraphPaths = (expression: string, xMin: number, xMax: number): readonly string[] => {
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !(xMin < xMax)) throw new Error(GRAPH_ERROR_DOMAIN)
  const fn = compileFunctionGraph(expression)
  const samples: Array<{ x: number; y: number }> = []
  const finite: number[] = []
  for (let index = 0; index <= SAMPLE_COUNT; index += 1) {
    const x = xMin + (xMax - xMin) * (index / SAMPLE_COUNT)
    let y = fn(x)
    if (typeof y !== 'number' || !Number.isFinite(y)) y = Number.NaN
    else if (y > 1e6) y = 1e6
    else if (y < -1e6) y = -1e6
    samples.push({ x, y })
    if (Number.isFinite(y)) finite.push(y)
  }
  if (!finite.length) throw new Error(GRAPH_ERROR_EMPTY_RANGE)
  finite.sort((left, right) => left - right)
  let yLo = quantile(finite, 0.04)
  let yHi = quantile(finite, 0.96)
  if (!(yHi > yLo)) {
    const mid = quantile(finite, 0.5)
    const pad = Math.max(0.5, Math.abs(mid) * 0.5)
    yLo = mid - pad
    yHi = mid + pad
  } else {
    const pad = (yHi - yLo) * 0.12
    yLo -= pad
    yHi += pad
  }
  const span = yHi - yLo
  const inner = BOX - 2 * MARGIN
  const mapX = (x: number) => MARGIN + ((x - xMin) / (xMax - xMin)) * inner
  const mapY = (y: number) => MARGIN + (1 - (y - yLo) / span) * inner
  const axisX = xMin < 0 && xMax > 0 ? 0 : xMin >= 0 ? xMin : xMax
  const axisY = yLo < 0 && yHi > 0 ? 0 : yLo >= 0 ? yLo : yHi
  const originX = mapX(axisX)
  const originY = mapY(axisY)
  const left = MARGIN
  const right = MARGIN + inner
  const top = MARGIN
  const bottom = MARGIN + inner
  const segment = (x1: number, y1: number, x2: number, y2: number) => (
    `M ${formatCoord(x1)} ${formatCoord(y1)} L ${formatCoord(x2)} ${formatCoord(y2)}`
  )
  const axisParts = [
    segment(left, originY, right, originY),
    segment(originX, bottom, originX, top),
    segment(right, originY, right - 1.15, originY - 0.7),
    segment(right, originY, right - 1.15, originY + 0.7),
    segment(originX, top, originX - 0.7, top + 1.15),
    segment(originX, top, originX + 0.7, top + 1.15),
  ]
  for (const ratio of [0.25, 0.5, 0.75]) {
    const x = left + inner * ratio
    if (Math.abs(x - originX) > 1.2) axisParts.push(segment(x, originY - 0.35, x, originY + 0.35))
    const y = top + inner * ratio
    if (Math.abs(y - originY) > 1.2) axisParts.push(segment(originX - 0.35, y, originX + 0.35, y))
  }
  const curves: Array<Array<[number, number]>> = []
  let run: Array<[number, number]> = []
  let previous: number | null = null
  const flush = () => {
    if (run.length >= 2) curves.push(run)
    run = []
  }
  for (const sample of samples) {
    if (!Number.isFinite(sample.y)) {
      flush()
      previous = null
      continue
    }
    if (previous != null) {
      const jump = Math.abs(sample.y - previous)
      if (sample.y * previous < 0 && jump > span * 3) {
        flush()
        previous = null
        if (Math.abs(sample.y) > span * 8) continue
      }
    }
    const clipped = Math.min(yHi, Math.max(yLo, sample.y))
    run.push([mapX(sample.x), mapY(clipped)])
    previous = sample.y
  }
  flush()
  const paths = [axisParts.join(' '), ...curves.map(polyline).filter((path) => path.length > 0)]
  return paths.slice(0, MAX_PATHS)
}

export type FunctionGraphStamp = {
  expression: string
  xMin: number
  xMax: number
  paths: readonly string[]
}

const storedGraphPaths = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATHS) return null
  let total = 0
  const paths: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length >= MAX_PATH_CHARS) return null
    if (!PATH_PATTERN.test(entry)) return null
    total += entry.length
    if (total >= MAX_PATH_CHARS) return null
    paths.push(entry)
  }
  return paths
}

/**
 * Rebuild the stamp from the saved formula. Stored paths are the fallback
 * when the formula no longer samples.
 */
export const readFunctionGraphStamp = (raw: {
  graphExpression?: unknown
  graphXMin?: unknown
  graphXMax?: unknown
  graphPaths?: unknown
}): FunctionGraphStamp | null => {
  const expression = typeof raw.graphExpression === 'string' ? raw.graphExpression.trim().slice(0, MAX_EXPRESSION_LENGTH) : ''
  const xMin = typeof raw.graphXMin === 'number' ? raw.graphXMin : Number.NaN
  const xMax = typeof raw.graphXMax === 'number' ? raw.graphXMax : Number.NaN
  const domainOk = Number.isFinite(xMin) && Number.isFinite(xMax) && xMin < xMax
  if (expression && domainOk) {
    try {
      const paths = functionGraphPaths(expression, xMin, xMax)
      if (paths.length) return { expression, xMin, xMax, paths }
    } catch {
      const paths = storedGraphPaths(raw.graphPaths)
      if (paths) return { expression, xMin, xMax, paths }
      return null
    }
  }
  const paths = storedGraphPaths(raw.graphPaths)
  if (!paths) return null
  return {
    expression,
    xMin: domainOk ? xMin : 0,
    xMax: domainOk ? xMax : 1,
    paths,
  }
}
