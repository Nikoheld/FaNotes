// A search hit asks the writing mode to show a scene (and the paragraph with
// the found words). Like the PDF reveal bus, a request made just before the
// writing mode mounts is delivered when it subscribes.
import { foldPlain, matchRanges, parseDocQuery } from '../lib/docSearch/text'
import { runsText } from './model/runs'
import type { Scene } from './model/types'

export type StoryRevealRequest = { path: string; sceneId: string; query: string; token: number }
type Listener = (request: StoryRevealRequest) => void
const listeners = new Set<Listener>()
let pending: StoryRevealRequest | null = null

/** Asks the writing mode showing `path` to go to `sceneId` and the paragraph matching `query`. */
export const requestStoryReveal = (path: string, target: { sceneId: string; query?: string }) => {
  pending = { path, sceneId: target.sceneId, query: target.query ?? '', token: Date.now() }
  for (const listener of listeners) listener(pending)
}

/** For the writing mode: receives requests for its story, including one made just before it mounted. */
export const subscribeStoryReveal = (path: string, listener: Listener) => {
  const wrapped: Listener = (request) => { if (request.path === path) { pending = null; listener(request) } }
  listeners.add(wrapped)
  if (pending && pending.path === path && Date.now() - pending.token < 15_000) wrapped(pending)
  return () => { listeners.delete(wrapped) }
}

/** The first live paragraph of the scene that contains every word of the query (else any word), or null. */
export const paragraphForQuery = (scene: Scene, query: string): string | null => {
  const { terms } = parseDocQuery(query)
  const live = scene.paragraphs.filter((paragraph) => !paragraph.deleted)
  if (!terms.length) return live[0]?.id ?? null
  const texts = live.map((paragraph) => ({ id: paragraph.id, text: foldPlain(runsText(paragraph.runs)) }))
  const has = (text: string, term: string) => matchRanges(text, [term], 1).length > 0
  return texts.find((entry) => terms.every((term) => has(entry.text, term)))?.id
    ?? texts.find((entry) => terms.some((term) => has(entry.text, term)))?.id
    ?? null
}
