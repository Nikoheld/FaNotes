import type { MathCheckResult } from './mathChecker'

export const checkMathStepsSafely = (lines: string[], timeoutMs = 6_000): Promise<MathCheckResult> => {
  if (typeof Worker === 'undefined') {
    return import('./mathChecker').then(({ checkMathSteps }) => checkMathSteps(lines))
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./mathSolverWorker.ts', import.meta.url), { type: 'module' })
    const timeout = globalThis.setTimeout(() => {
      worker.terminate()
      reject(new Error('Die mathematische Schrittprüfung wurde nach sechs Sekunden sicher abgebrochen.'))
    }, timeoutMs)
    worker.onmessage = (event: MessageEvent<{ result?: MathCheckResult; error?: string }>) => {
      globalThis.clearTimeout(timeout)
      worker.terminate()
      if (event.data.result) resolve(event.data.result)
      else reject(new Error(event.data.error || 'Der Rechenweg konnte nicht geprüft werden.'))
    }
    worker.onerror = () => {
      globalThis.clearTimeout(timeout)
      worker.terminate()
      reject(new Error('Der lokale Mathematik-Korrigierer konnte nicht gestartet werden.'))
    }
    worker.postMessage({ kind: 'check-steps', lines })
  })
}

