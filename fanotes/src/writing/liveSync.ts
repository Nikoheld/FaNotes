// The open story and the sync engine. While a story is open, sync may write its
// scenes and its manifest only when the editor has nothing unsaved and is not
// saving; the editor then merges what sync wrote into the open document, so a
// change made on another device shows up while writing. Every other file of the
// open story (bible, progress, snapshots, recovery) still waits until the story
// is closed. Without a registered editor (the Android host, or before the
// editor has loaded) the whole story waits, as before.

export type StoryGate = {
  /** The open story folder, e.g. `Bücher/Roman.story`. */
  path: string
  /** True while sync must not write this file (relative to the story folder). */
  isBusy: (relative: string) => boolean
  /** Sync wrote these files (relative to the story folder). */
  changed: (relatives: string[]) => void
}

let gate: StoryGate | null = null

export const registerStoryGate = (value: StoryGate) => {
  gate = value
  return () => { if (gate === value) gate = null }
}

/** Files of an open story that sync may write and the editor merges live. */
export const isLiveStoryFile = (relative: string) => relative === 'story.json' || /^scenes\/[0-9a-z]{6,40}\.json$/u.test(relative)

/** For the sync engine: must `path` wait because the story `storyPath` is open? */
export const storySyncBusy = (storyPath: string, path: string): boolean => {
  if (!path.startsWith(`${storyPath}/`)) return false
  const relative = path.slice(storyPath.length + 1)
  if (!gate || gate.path !== storyPath || !isLiveStoryFile(relative)) return true
  return gate.isBusy(relative)
}

/** For the sync engine: these paths were written; the open story merges its own. */
export const notifyStoryWritten = (storyPath: string, paths: readonly string[]) => {
  if (!gate || gate.path !== storyPath) return
  const relatives = paths.filter((path) => path.startsWith(`${storyPath}/`)).map((path) => path.slice(storyPath.length + 1)).filter(isLiveStoryFile)
  if (relatives.length) gate.changed(relatives)
}
