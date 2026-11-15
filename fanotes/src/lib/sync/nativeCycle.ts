// Desktop hook for the native sync engine (Tauri, preview). Only used when
// window.fanotes.nativeSync exists AND its preference is on; otherwise the
// TypeScript engine runs its own pull/push exactly as before. The TypeScript
// engine keeps the scheduler, the account and the conflict page; the native
// side runs the body of one cycle on the same state file.
import type { NativeSyncApi, NativeSyncEvent, NativeSyncOutcome, SyncHostApi } from '../../types'

const BUSY_REFRESH_MS = 250

/** The native engine, when this desktop offers it and the user turned it on. */
export const nativeSyncFor = async (): Promise<NativeSyncApi | null> => {
  const api = typeof window !== 'undefined' ? window.fanotes?.nativeSync : undefined
  if (!api) return null
  try {
    return (await api.enabled()) === true ? api : null
  } catch {
    return null
  }
}

export type NativeCycleContext = {
  host: SyncHostApi
  trackedPaths: string[]
  platform: string
  deviceName: string
  excludedPrefixes: readonly string[]
  includeRecognitionModel: boolean
  includeHistory: boolean
  cleared: Set<string>
  isPathBusy: (path: string) => boolean
  onEvent: (event: NativeSyncEvent) => void
}

/** Runs one native cycle body. Events are delivered once each, as they happen or with the result. */
export const runNativeCycle = async (api: NativeSyncApi, context: NativeCycleContext): Promise<NativeSyncOutcome> => {
  const candidates = new Set(context.trackedPaths)
  for (const entry of await context.host.scan().catch(() => [])) candidates.add(entry.path)
  const busyNow = () => [...candidates].filter((path) => context.isPathBusy(path))
  const delivered = new Set<number>()
  const deliver = (event: NativeSyncEvent) => {
    if (delivered.has(event.seq)) return
    delivered.add(event.seq)
    context.onEvent(event)
  }
  const stop = api.onEvent(deliver)
  const timer = window.setInterval(() => { void api.setBusy(busyNow()).catch(() => undefined) }, BUSY_REFRESH_MS)
  try {
    const outcome = await api.cycle({
      platform: context.platform,
      deviceName: context.deviceName,
      excludedPrefixes: context.excludedPrefixes,
      includeRecognitionModel: context.includeRecognitionModel,
      includeHistory: context.includeHistory,
      cleared: [...context.cleared],
      busy: busyNow(),
    })
    for (const event of outcome.events ?? []) deliver(event)
    if (outcome.cleared) {
      context.cleared.clear()
      for (const path of outcome.cleared) context.cleared.add(path)
    }
    return outcome
  } finally {
    window.clearInterval(timer)
    stop()
  }
}
