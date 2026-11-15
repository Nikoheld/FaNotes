// Live merge on Android. Sync is native there and cannot ask the editor anything
// synchronously, so the editor PUSHES its state (unsaved or saving = busy) to Kotlin
// through the bridge whenever it changes, and Kotlin calls `window.fanotesStoryWritten`
// (evaluateJavascript) with the story-relative files sync wrote. Until the first push
// and whenever a push fails, Kotlin treats the story files as busy.

export type BusyBridge = { storyBusy?: (busy: boolean) => void }
export type BusySource = { isDirty(): boolean; isSaving(): boolean; subscribe(listener: () => void): () => void }

/** The global Kotlin calls with a JSON array of story-relative paths. */
export const STORY_WRITTEN_ENTRY = 'fanotesStoryWritten'

/**
 * Reports `isDirty() || isSaving()` to Kotlin on every change. A failed report is
 * retried, and counts as busy on the Kotlin side until one goes through.
 */
export const reportEditorBusy = (source: BusySource, bridge: BusyBridge | null, schedule: (retry: () => void, ms: number) => unknown = (retry, ms) => setTimeout(retry, ms)): (() => void) => {
  const send = bridge?.storyBusy
  if (!bridge || typeof send !== 'function') return () => undefined
  let last: boolean | null = null
  let alive = true
  const push = () => {
    if (!alive) return
    const busy = source.isDirty() || source.isSaving()
    if (busy === last) return
    try {
      send.call(bridge, busy)
      last = busy
    } catch {
      last = null
      schedule(push, 250)
    }
  }
  const off = source.subscribe(push)
  push()
  // Whatever happens next (reload, unmount) is unknown to Kotlin: hold the files.
  return () => { alive = false; off(); try { send.call(bridge, true) } catch { /* Kotlin resets on page load */ } }
}

/** Installs the entry Kotlin calls; `written` receives the live story files (relative to the story folder). */
export const installStoryWrittenEntry = (target: Record<string, unknown>, written: (relatives: string[]) => void): (() => void) => {
  const entry = (json: string) => {
    let value: unknown
    try { value = JSON.parse(json) } catch { return }
    if (!Array.isArray(value)) return
    const relatives = value.filter((item): item is string => typeof item === 'string')
    if (relatives.length) written(relatives)
  }
  target[STORY_WRITTEN_ENTRY] = entry
  return () => { if (target[STORY_WRITTEN_ENTRY] === entry) delete target[STORY_WRITTEN_ENTRY] }
}
