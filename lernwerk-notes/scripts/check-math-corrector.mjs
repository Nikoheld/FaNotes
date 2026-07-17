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

const stroke = (from, to, t = 0) => ({
  points: [point(...from, t), point(...to, t + 10)],
  baseWidth: 4,
  pressureEnabled: true,
  color: '#111827',
})

const token = (char, x, y, width = 0.02, height = 0.04) => ({
  char,
  confidence: 95,
  bbox: [x, y, width, height],
  strokeCount: 1,
  source: 'knn',
})

try {
  const { checkMathSteps } = await server.ssrLoadModule('/src/lib/mathChecker.ts')
  const { checkMathStepsSafely } = await server.ssrLoadModule('/src/lib/mathCheckerClient.ts')
  const { groupMathInkLines } = await server.ssrLoadModule('/src/lib/mathInkSelection.ts')
  const { changedMathTokenRect } = await server.ssrLoadModule('/src/lib/mathCorrectionLayout.ts')

  const correctLinear = checkMathSteps(['2*x+3=7', '2*x=4', 'x=2'])
  assert.equal(correctLinear.status, 'correct')
  assert.deepEqual(correctLinear.lines.map((line) => line.status), ['start', 'correct', 'correct'])

  const wrongArithmetic = checkMathSteps(['2*x+3=7', '2*x=5', 'x=2.5'])
  assert.equal(wrongArithmetic.status, 'incorrect')
  assert.equal(wrongArithmetic.errorLineIndex, 1)
  assert.equal(wrongArithmetic.lines[2].status, 'unchecked')
  assert.match(wrongArithmetic.suggestion, /x=2/u)

  const missingRoot = checkMathSteps(['x^2=4', 'x=2'])
  assert.equal(missingRoot.status, 'incorrect')
  assert.match(missingRoot.suggestion, /x=-2|x=\(-2\)/u)

  assert.equal(checkMathSteps(['(x+2)^2', 'x^2+4*x+4']).status, 'correct')
  assert.equal(checkMathSteps(['1/2+1/3', '5/6']).status, 'correct')
  assert.equal(checkMathSteps(['sqrt(x)=3', 'x=9']).status, 'correct')
  assert.equal(checkMathSteps(['2*x+2*y=4', 'x+y=2']).status, 'correct')
  assert.equal(checkMathSteps(['x/x=1', '1=1']).status, 'uncertain', 'Definitionslücken dürfen nicht als sicher äquivalent gelten.')

  const multiVariable = checkMathSteps(['x*y=0', 'x^2*y=0'])
  assert.equal(multiVariable.status, 'uncertain')
  assert.equal(multiVariable.lines[1].status, 'uncertain')

  const unreadable = checkMathSteps(['x+1=2', 'x+@=1'])
  assert.equal(unreadable.status, 'unreadable')
  assert.equal(unreadable.errorLineIndex, 1)

  const safely = await checkMathStepsSafely(['3*x=12', 'x=4'])
  assert.equal(safely.status, 'correct')

  const derivation = [
    // Row 1 with a fraction bar, numerator and denominator.
    stroke([0.10, 0.17], [0.14, 0.21]),
    stroke([0.17, 0.19], [0.25, 0.19]),
    stroke([0.20, 0.15], [0.21, 0.16]),
    stroke([0.20, 0.22], [0.22, 0.24]),
    stroke([0.29, 0.18], [0.32, 0.21]),
    // Row 2.
    stroke([0.10, 0.41], [0.14, 0.45]),
    stroke([0.17, 0.43], [0.24, 0.43]),
    stroke([0.28, 0.42], [0.32, 0.46]),
    // Row 3.
    stroke([0.10, 0.67], [0.14, 0.71]),
    stroke([0.17, 0.69], [0.24, 0.69]),
    stroke([0.28, 0.68], [0.32, 0.72]),
  ]
  const lines = groupMathInkLines(derivation, { width: 900, height: 1273 })
  assert.equal(lines.length, 3, 'Ein Rechenweg muss als drei Zeilen erkannt werden.')
  assert.equal(lines[0].strokes.length, 5, 'Der Bruch muss vollständig in seiner Zeile bleiben.')
  assert.ok(lines[0].rect.y < lines[1].rect.y && lines[1].rect.y < lines[2].rect.y)

  const previousTokens = [token('2', 0.10, 0.40), token('x', 0.13, 0.40), token('=', 0.17, 0.40), token('4', 0.21, 0.40)]
  const currentTokens = [token('2', 0.10, 0.50), token('x', 0.13, 0.50), token('=', 0.17, 0.50), token('5', 0.21, 0.50)]
  const changed = changedMathTokenRect(previousTokens, currentTokens, { x: 0.08, y: 0.48, width: 0.2, height: 0.08 })
  assert.ok(changed.x >= 0.20 && changed.x < 0.22, 'Nur die geänderte 5 soll markiert werden.')
  assert.ok(changed.width < 0.04, 'Die Fehlermarkierung soll enger als die ganze Zeile sein.')

  console.log('Mathe-Korrigierer erfolgreich: äquivalente Schritte, erster sicherer Fehler, verlorene Lösungen, Brüche, Wurzeln, Mehrvariablen-Sicherheit, Parser-Schutz, Zeilengruppierung und präzise Markierung geprüft.')
} finally {
  await server.close()
}
