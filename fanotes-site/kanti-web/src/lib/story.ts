// A story project (the writing mode's `*.story` folder) as text, read only; the same walk as the app's StoryReader.kt.
export type StoryBlockKind = 'part' | 'chapter' | 'scene' | 'paragraph'
export interface StoryBlock { kind: StoryBlockKind; text: string; style: string }
export interface StoryText { title: string; subtitle: string; author: string; blocks: StoryBlock[]; truncated: boolean }

const STORY_FORMAT = 'fanotes-story-v1'
const SCENE_FORMAT = 'fanotes-story-scene-v1'
const STORY_ID = /^[0-9a-z]{6,40}$/u
const MAX_CHARS = 4_000_000
const MAX_DEPTH = 6

type Json = Record<string, unknown>
const object = (text: string | null): Json | null => {
  if (!text?.trim()) return null
  try { const value = JSON.parse(text) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null } catch { return null }
}
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const string = (value: unknown): string => (typeof value === 'string' ? value : '')

const sceneParagraphs = (scene: Json | null, expectedId: string): StoryBlock[] => {
  if (!scene || scene.format !== SCENE_FORMAT) return []
  if (typeof scene.id === 'string' && scene.id !== expectedId) return []
  const entries: { key: string; id: string; block: StoryBlock }[] = []
  for (const raw of array(scene.paragraphs).slice(0, 50_000)) {
    const paragraph = raw as Json
    if (!paragraph || typeof paragraph !== 'object' || paragraph.deleted === true) continue
    const text = array(paragraph.runs).map((run) => string((run as Json)?.text)).join('').replace(/\r\n?/gu, '\n').trim()
    if (!text) continue
    const style = /^[a-z0-9-]{1,40}$/u.test(string(paragraph.style)) ? string(paragraph.style) : 'body'
    entries.push({ key: string(paragraph.key), id: string(paragraph.id), block: { kind: 'paragraph', text, style } })
  }
  const keyed = entries.every((entry) => entry.key !== '')
  return (keyed ? [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) : entries).map((entry) => entry.block)
}

/** `read` returns a story-relative file's text or null. Null when `story.json` is missing or no story manifest. */
export const readStoryText = async (read: (path: string) => Promise<string | null>): Promise<StoryText | null> => {
  const manifest = object(await read('story.json'))
  if (!manifest || manifest.format !== STORY_FORMAT) return null
  const blocks: StoryBlock[] = []
  let chars = 0
  let truncated = false
  const seen = new Set<string>()
  const walk = async (nodes: unknown[], depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    for (const entry of nodes.slice(0, 5000)) {
      const node = entry as Json
      const id = string(node?.id)
      if (!id || !STORY_ID.test(id) || seen.has(id) || node.exclude === true) continue
      seen.add(id)
      const title = string(node.title).trim()
      const kind = string(node.kind)
      if (kind === 'scene') {
        if (chars > MAX_CHARS) { truncated = true; return }
        if (title) blocks.push({ kind: 'scene', text: title, style: 'heading' })
        for (const paragraph of sceneParagraphs(object(await read(`scenes/${id}.json`)), id)) { chars += paragraph.text.length; blocks.push(paragraph) }
      } else if (kind === 'part' || kind === 'chapter') {
        if (title) blocks.push({ kind, text: title, style: 'chapter' })
        await walk(array(node.children), depth + 1)
      } else if (kind === 'folder') await walk(array(node.children), depth + 1)
    }
  }
  await walk(array(manifest.binder), 0)
  return { title: string(manifest.title).trim(), subtitle: string(manifest.subtitle).trim(), author: string(manifest.author).trim(), blocks, truncated }
}
