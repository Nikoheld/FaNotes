/** Runs the recognition fusion (JSON wiring, wasm, JSON result) off the main thread. */
import { wireFusionEntry } from '../../../src/lib/recogFusionWire'
import { fuseRecogModel } from './recogCore'

self.onmessage = async ({ data }: MessageEvent<{ entries: Parameters<typeof wireFusionEntry>[0][] }>) => {
  try {
    const fused = await fuseRecogModel(data.entries.map(wireFusionEntry))
    self.postMessage({ fused })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'fusion failed' })
  }
}
