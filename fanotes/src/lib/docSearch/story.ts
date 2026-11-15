/**
 * Writing-mode stories in the document index (reference for the desktop's
 * native index, `crates/fanotes-index/src/vault.rs`). A `Name.story/` folder
 * is one document titled `Name`. Each scene file `scenes/<id>.json`
 * (`fanotes-story-scene-v1`) is searched as its text: the runs of every
 * paragraph that is not deleted, paragraphs joined by line breaks, ordered
 * by their `key` (then `id`) when every paragraph has one. Scenes come in
 * binder order (`story.json`, depth first), scene files the binder does not
 * name follow sorted by id. A scene is cut into 6,000-character units like a
 * note; `page` is the scene's position (1-based).
 */
import type { IndexUnit } from './docIndex'
import { chunk } from './extract'

export const STORY_SCENE_FILE = /^scenes\/([0-9a-z]{6,40})\.json$/u

type Json = Record<string, unknown>
const object = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null)
const codeUnitOrder = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

export const storySceneText = (value: unknown): string | null => {
  const scene = object(value)
  if (!scene || scene.format !== 'fanotes-story-scene-v1') return null
  const paragraphs = (Array.isArray(scene.paragraphs) ? scene.paragraphs : []).map(object).filter((paragraph): paragraph is Json => Boolean(paragraph))
  const live = paragraphs.filter((paragraph) => paragraph.deleted !== true)
  const key = (paragraph: Json) => (typeof paragraph.key === 'string' && paragraph.key ? paragraph.key : null)
  if (live.every((paragraph) => key(paragraph) !== null)) {
    const id = (paragraph: Json) => (typeof paragraph.id === 'string' ? paragraph.id : '')
    live.sort((left, right) => codeUnitOrder(key(left)!, key(right)!) || codeUnitOrder(id(left), id(right)))
  }
  return live.map((paragraph) => (Array.isArray(paragraph.runs) ? paragraph.runs : [])
    .map(object)
    .filter((run): run is Json => Boolean(run))
    .map((run) => (typeof run.text === 'string' ? run.text : ''))
    .join('')
    .replace(/\r\n?/gu, '\n')).join('\n')
}

const binderSceneIds = (nodes: unknown, out: string[]) => {
  if (!Array.isArray(nodes)) return
  for (const entry of nodes) {
    const node = object(entry)
    if (!node) continue
    if (node.kind === 'scene' && typeof node.id === 'string' && !out.includes(node.id)) out.push(node.id)
    binderSceneIds(node.children, out)
  }
}

/** Units of one story. `files` are paths inside the `.story` folder with their text. */
export const storySearchUnits = (path: string, manifestText: string | null, files: Array<{ name: string; text: string }>): IndexUnit[] => {
  const scenes = new Map<string, string>()
  for (const file of files) {
    const match = STORY_SCENE_FILE.exec(file.name)
    if (!match) continue
    let value: unknown
    try { value = JSON.parse(file.text) } catch { continue }
    const text = storySceneText(value)
    if (text !== null) scenes.set(match[1]!, text)
  }
  const order: string[] = []
  if (manifestText !== null) {
    try {
      const manifest = object(JSON.parse(manifestText))
      if (manifest?.format === 'fanotes-story-v1') binderSceneIds(manifest.binder, order)
    } catch { /* scenes still count */ }
  }
  const named = order.filter((id) => scenes.has(id))
  const rest = [...scenes.keys()].filter((id) => !named.includes(id)).sort(codeUnitOrder)
  const units: IndexUnit[] = []
  let n = 0
  ;[...named, ...rest].forEach((id, index) => {
    for (const text of chunk(scenes.get(id)!)) {
      n += 1
      units.push({ id: `${path}#scene:${n}`, path, kind: 'scene', page: index + 1, source: 'text', text })
    }
  })
  return units
}
