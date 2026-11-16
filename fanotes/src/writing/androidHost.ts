// The writing mode inside the Android app's WebView. The app exposes a
// synchronous JavaScript interface `FaNotesAndroid` whose methods return a
// JSON envelope `{ ok, value?, error? }`; this adapter turns it into the
// story part of `window.fanotes`. All path checks happen again in Kotlin.
type Envelope<T> = { ok: boolean; value?: T; error?: string }

export type AndroidBridge = {
  storyRead(path: string): string
  storyWrite(path: string, content: string): string
  storyList(storyPath: string): string
  storyCreate(parent: string, name: string): string
  readFile(path: string): string
  listNotes(): string
  /** Writes an exported file (base64) next to the story; returns the vault path. */
  saveExport(storyPath: string, fileName: string, base64: string): string
  saved(pathsJson: string): void
  /** Pushes whether the editor holds unsaved or saving text (sync must then leave scenes and story.json alone). */
  storyBusy?(busy: boolean): void
  close(): void
}

const call = <T>(raw: string): T => {
  let envelope: Envelope<T>
  try {
    envelope = JSON.parse(raw) as Envelope<T>
  } catch {
    throw new Error('FaNotes Android: invalid bridge response')
  }
  if (!envelope.ok) throw new Error(envelope.error || 'FaNotes Android: request failed')
  return envelope.value as T
}

export const androidBridge = (): AndroidBridge | null => (window as unknown as { FaNotesAndroid?: AndroidBridge }).FaNotesAndroid ?? null

/** Installs the story methods (and what the writing mode reads besides) on `window.fanotes`. */
export const installAndroidHost = (bridge: AndroidBridge) => {
  const api = {
    storyRead: async (path: string) => call<string | null>(bridge.storyRead(path)),
    storyWrite: async (path: string, content: string) => { call<null>(bridge.storyWrite(path, content)) },
    storyList: async (storyPath: string) => call<string[]>(bridge.storyList(storyPath)),
    storyCreate: async (parent: string, name: string) => call<string>(bridge.storyCreate(parent, name)),
    readFile: async (path: string) => call<string>(bridge.readFile(path)),
    // Only notes are needed (linking notes to scenes); the tree is flat here.
    getTree: async () => call<Array<{ path: string; name: string }>>(bridge.listNotes()).map((note) => ({ name: note.name, relativePath: note.path, kind: 'file' as const, extension: 'md' })),
  }
  ;(window as unknown as { fanotes: unknown }).fanotes = api
  return api
}
