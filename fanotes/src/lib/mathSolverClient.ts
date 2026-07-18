import type { MathSolverAction, MathSolverResult } from './mathSolver'

export const solveMathExpressionSafely = (
  input: string,
  action: MathSolverAction,
  requestedVariable?: string,
  timeoutMs = 5_000,
): Promise<MathSolverResult> => {
  if (typeof Worker === 'undefined') {
    return import('./mathSolver').then(({ solveMathExpression }) => solveMathExpression(input, action, requestedVariable))
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./mathSolverWorker.ts', import.meta.url), { type: 'module' })
    const timeout = globalThis.setTimeout(() => {
      worker.terminate()
      reject(new Error('Die symbolische Berechnung wurde nach fünf Sekunden sicher abgebrochen.'))
    }, timeoutMs)
    worker.onmessage = (event: MessageEvent<{ result?: MathSolverResult; error?: string }>) => {
      globalThis.clearTimeout(timeout)
      worker.terminate()
      if (event.data.result) resolve(event.data.result)
      else reject(new Error(event.data.error || 'Der Ausdruck konnte nicht berechnet werden.'))
    }
    worker.onerror = () => {
      globalThis.clearTimeout(timeout)
      worker.terminate()
      reject(new Error('Der lokale Mathematik-Löser konnte nicht gestartet werden.'))
    }
    worker.postMessage({ input, action, requestedVariable })
  })
}

