import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const point = (x, y, t = 0) => ({
  x,
  y,
  t,
  pressure: 0.5,
  tiltX: 0,
  tiltY: 0,
  pointerType: 'pen',
})

const stroke = (from, to) => ({
  points: [point(...from), point(...to, 10)],
  baseWidth: 4,
  pressureEnabled: true,
  color: '#111827',
})

try {
  const {
    normalizeMathInput,
    solveMathExpression,
  } = await server.ssrLoadModule('/src/lib/mathSolver.ts')
  const { solveMathExpressionSafely } = await server.ssrLoadModule('/src/lib/mathSolverClient.ts')
  const { selectMathInkAtPoint } = await server.ssrLoadModule('/src/lib/mathInkSelection.ts')

  assert.equal(solveMathExpression('2*x+3*x', 'simplify').steps.at(-1).expression, '5*x')
  assert.deepEqual(
    solveMathExpression('2*x+3=7', 'solve', 'x').steps.map((entry) => entry.expression),
    ['2*x=4', 'x=2'],
  )
  assert.deepEqual(
    solveMathExpression('x^2-5*x+6=0', 'solve', 'x').steps.filter((entry) => entry.kind === 'result').map((entry) => entry.expression),
    ['x=2', 'x=3'],
  )
  assert.equal(solveMathExpression('(x+1)^3', 'expand').steps[0].expression, '1+3*x+3*x^2+x^3')
  assert.equal(solveMathExpression('x^2-1', 'factor').steps[0].expression, '(-1+x)*(1+x)')
  assert.equal(solveMathExpression('2+3*4', 'calculate').steps[0].expression, '14')
  assert.equal(solveMathExpression('(x^2-1)/(x-1)', 'simplify').steps[0].expression, '1+x')
  assert.equal(solveMathExpression('sqrt(x+2)=3', 'solve', 'x').steps.at(-1).expression, 'x=7')
  assert.equal((await solveMathExpressionSafely('6/8', 'simplify')).steps[0].expression, '3/4')

  assert.equal(normalizeMathInput('√(x + 2) = 3'), 'sqrt(x+2)=3')
  assert.throws(() => normalizeMathInput('x=2=3'), /einzelne Gleichung|genau einen/u)
  assert.throws(() => normalizeMathInput('import(x)'), /nicht erlaubt/u)
  assert.throws(() => normalizeMathInput('x^101'), /Exponenten/u)

  const expression = [
    stroke([0.10, 0.24], [0.12, 0.27]),
    stroke([0.15, 0.25], [0.18, 0.25]),
    stroke([0.21, 0.25], [0.24, 0.25]),
    // Fraction bar with numerator and denominator.
    stroke([0.27, 0.25], [0.36, 0.25]),
    stroke([0.31, 0.20], [0.32, 0.22]),
    stroke([0.31, 0.28], [0.33, 0.30]),
    // A different expression on the next line must not be pulled into the group.
    stroke([0.10, 0.55], [0.13, 0.58]),
    stroke([0.16, 0.56], [0.19, 0.56]),
  ]
  const selected = selectMathInkAtPoint(expression, { x: 0.11, y: 0.25 }, { width: 900, height: 1273 })
  assert.ok(selected, 'Ein Doppeltipp auf Tinte muss einen Ausdruck auswählen.')
  assert.deepEqual(selected.indexes, [0, 1, 2, 3, 4, 5], 'Bruchlayout muss zusammenbleiben, die nächste Zeile aber getrennt.')
  assert.equal(selectMathInkAtPoint(expression, { x: 0.8, y: 0.8 }, { width: 900, height: 1273 }), null)

  console.log('Mathematik-Löser erfolgreich: Vereinfachen, lineare/quadratische Gleichungen, Brüche, Wurzeln, Transformationen, Parser-Schutz und räumliche Doppeltipp-Auswahl geprüft.')
} finally {
  await server.close()
}
