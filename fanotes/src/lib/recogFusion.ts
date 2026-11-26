import type { RecognitionModelEntry } from '../../../src/lib/recognition'
import { wireFusionEntry } from '../../../src/lib/recogFusionWire'
import { fuseRecogModel } from './recogCore'

type Fused = Awaited<ReturnType<typeof fuseRecogModel>>

/**
 * The fusion of a recognition model. Building the wire form, the wasm run and the JSON take hundreds of milliseconds
 * on a big set of samples, so it runs in a worker (typed arrays are copied, not serialised); where workers are not
 * available (headless checks) it runs here as before.
 */
export const fuseRecogModelOffThread = (entries: RecognitionModelEntry[]): Promise<Fused> => {
  // Only the app window has the built worker; headless checks and library builds keep the synchronous path.
  if (typeof Worker === 'undefined' || !(globalThis as { fanotes?: unknown }).fanotes) return fuseRecogModel(entries.map(wireFusionEntry))
  return new Promise<Fused>((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./recogFusionWorker.ts', import.meta.url), { type: 'module' })
    } catch {
      fuseRecogModel(entries.map(wireFusionEntry)).then(resolve, reject)
      return
    }
    worker.onmessage = ({ data }: MessageEvent<{ fused?: Fused; error?: string }>) => {
      worker.terminate()
      if (data.fused) resolve(data.fused)
      else reject(new Error(data.error ?? 'fusion failed'))
    }
    worker.onerror = () => {
      worker.terminate()
      // No worker (policy, bundling): the same work on this thread.
      fuseRecogModel(entries.map(wireFusionEntry)).then(resolve, reject)
    }
    worker.postMessage({ entries })
  })
}
