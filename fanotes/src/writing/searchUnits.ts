// What document search indexes of a story: one unit per scene (chapter and
// scene title, synopsis, the text of every paragraph that is not deleted) and
// one per bible entry. A hit names its scene, so the writing mode can open
// there. Pure: the extractor reads the files, this turns them into units.
import type { IndexUnit } from '../lib/docSearch/docIndex'
import { bibleFileOf, sanitizeBibleEntry } from './model/bible'
import { scenesInOrder } from './model/binder'
import { runsText } from './model/runs'
import { sanitizeManifest, sanitizeScene } from './model/sanitize'

const UNIT_CHARS = 6000
const MAX_STORY_CHARS = 4_000_000

const parse = (text: string | null | undefined): unknown => {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Splits long text at paragraph ends so no unit grows beyond a few thousand characters. */
const pieces = (lines: string[]) => {
  const out: string[] = []
  let current = ''
  for (const line of lines) {
    if (current && current.length + line.length + 1 > UNIT_CHARS) {
      out.push(current)
      current = ''
    }
    current = current ? `${current}\n${line}` : line
  }
  if (current.trim()) out.push(current)
  return out
}

/**
 * Units of one story. `read` gives a story-relative file's text (null when
 * missing); `files` lists the story folder (as `storyList` returns it).
 */
export const storySearchUnits = async (storyPath: string, files: readonly string[], read: (relative: string) => Promise<string | null>): Promise<IndexUnit[]> => {
  const manifest = sanitizeManifest(parse(await read('story.json')))
  if (!manifest) return []
  const units: IndexUnit[] = []
  let total = 0
  let sceneUnit = 0
  for (const { scene: node, chapter } of scenesInOrder(manifest.binder)) {
    if (total > MAX_STORY_CHARS) break
    const scene = sanitizeScene(parse(await read(`scenes/${node.id}.json`)), node.id)
    const lines = [chapter?.title ?? '', node.title, node.synopsis ?? ''].filter((line) => line.trim())
    for (const paragraph of scene?.paragraphs ?? []) {
      if (paragraph.deleted) continue
      const text = runsText(paragraph.runs).trim()
      if (text) lines.push(text)
    }
    for (const text of pieces(lines)) {
      sceneUnit += 1
      total += text.length
      units.push({ id: `${storyPath}#scene:${sceneUnit}`, path: storyPath, kind: 'scene', sceneId: node.id, source: 'text', text })
    }
  }
  let bibleUnit = 0
  for (const file of [...files].sort()) {
    const found = bibleFileOf(file)
    if (!found || total > MAX_STORY_CHARS) continue
    const entry = sanitizeBibleEntry(parse(await read(file)))
    if (!entry || entry.id !== found.id || entry.archived) continue
    const lines = [entry.name, ...(entry.aliases ?? []), entry.role ?? '', entry.when ?? '', ...entry.fields.filter((field) => field.value.trim()).map((field) => `${field.label}: ${field.value}`), entry.notes ?? '']
      .filter((line) => line.trim())
    for (const text of pieces(lines)) {
      bibleUnit += 1
      total += text.length
      units.push({ id: `${storyPath}#bible:${bibleUnit}`, path: storyPath, kind: 'bible', source: 'text', text })
    }
  }
  return units
}
