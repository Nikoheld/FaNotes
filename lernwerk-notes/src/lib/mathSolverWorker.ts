import { solveMathExpression, type MathSolverAction } from './mathSolver'
import { checkMathSteps } from './mathChecker'

type SolverRequest = {
  kind?: 'solve'
  input: string
  action: MathSolverAction
  requestedVariable?: string
}

type CheckerRequest = {
  kind: 'check-steps'
  lines: string[]
}

globalThis.onmessage = (event: MessageEvent<SolverRequest | CheckerRequest>) => {
  try {
    if (event.data.kind === 'check-steps') {
      globalThis.postMessage({ result: checkMathSteps(event.data.lines) })
      return
    }
    globalThis.postMessage({ result: solveMathExpression(event.data.input, event.data.action, event.data.requestedVariable) })
  } catch (error) {
    globalThis.postMessage({ error: error instanceof Error ? error.message : 'Der Ausdruck konnte nicht berechnet werden.' })
  }
}
