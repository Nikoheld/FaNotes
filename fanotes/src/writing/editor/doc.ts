// The editor's document: manifest + scenes (immutable; an edit returns a new
// Doc that shares every unchanged scene and paragraph) and the manuscript flow
// derived from them. Positions are (flow block key, UTF-16 offset).
import { buildFlow, paragraphKey, titleKey, type FlowBlock } from '../model/flow'
import { newId } from '../model/ids'
import { keyBetween } from '../model/keys'
import { runsLength } from '../model/runs'
import type { BinderNode, Paragraph, Scene, StoryManifest } from '../model/types'

export type Doc = {
  manifest: StoryManifest
  scenes: Map<string, Scene>
  flow: FlowBlock[]
  index: Map<string, number>
}

export type Pos = { block: string; offset: number }
export type Selection = { anchor: Pos; head: Pos }

export const makeDoc = (manifest: StoryManifest, scenes: Map<string, Scene>): Doc => {
  const flow = buildFlow(manifest, scenes)
  return { manifest, scenes, flow, index: new Map(flow.map((block, position) => [block.key, position])) }
}

export const blockAt = (doc: Doc, key: string) => {
  const position = doc.index.get(key)
  return position === undefined ? undefined : doc.flow[position]
}
export const blockLength = (block: FlowBlock) => runsLength(block.runs)
export const samePos = (a: Pos, b: Pos) => a.block === b.block && a.offset === b.offset
export const isCollapsed = (selection: Selection) => samePos(selection.anchor, selection.head)
export const caret = (pos: Pos): Selection => ({ anchor: pos, head: pos })

export const comparePos = (doc: Doc, a: Pos, b: Pos) => {
  const left = doc.index.get(a.block) ?? -1
  const right = doc.index.get(b.block) ?? -1
  return left !== right ? left - right : a.offset - b.offset
}

export const ordered = (doc: Doc, selection: Selection) => (
  comparePos(doc, selection.anchor, selection.head) <= 0
    ? { from: selection.anchor, to: selection.head }
    : { from: selection.head, to: selection.anchor }
)

/** The first editable position at or after a flow index. */
export const firstEditable = (doc: Doc, from = 0, direction: 1 | -1 = 1): Pos | null => {
  for (let index = from; index >= 0 && index < doc.flow.length; index += direction) {
    const block = doc.flow[index]
    if (block.editable) return { block: block.key, offset: direction === 1 ? 0 : blockLength(block) }
  }
  return null
}

/** A position that exists in this doc (after an undo or a sync merge removed its block). */
export const clampPos = (doc: Doc, pos: Pos, fallbackIndex = 0): Pos => {
  const block = blockAt(doc, pos.block)
  if (block?.editable) return { block: block.key, offset: Math.max(0, Math.min(pos.offset, blockLength(block))) }
  const position = block ? doc.index.get(block.key)! : Math.min(fallbackIndex, doc.flow.length - 1)
  return firstEditable(doc, Math.max(0, position)) ?? firstEditable(doc, Math.max(0, position), -1) ?? { block: doc.flow[0]?.key ?? '', offset: 0 }
}

// ── Scene and binder edits ─────────────────────────────────────────────────

export const sceneParagraphIndex = (scene: Scene, paragraphId: string) => scene.paragraphs.findIndex((paragraph) => paragraph.id === paragraphId)

/**
 * Replaces one scene. When only paragraph contents changed (same paragraphs in
 * the same order, as with typing or formatting) the affected blocks are
 * patched into a copy of the flow; otherwise the flow is rebuilt.
 */
export const withScene = (doc: Doc, scene: Scene, manifest = doc.manifest): Doc => {
  const scenes = new Map(doc.scenes)
  scenes.set(scene.id, scene)
  const before = doc.scenes.get(scene.id)
  if (manifest !== doc.manifest || !before || before.paragraphs.length !== scene.paragraphs.length) return makeDoc(manifest, scenes)
  let flow: FlowBlock[] | null = null
  for (let index = 0; index < scene.paragraphs.length; index += 1) {
    const next = scene.paragraphs[index]
    const previous = before.paragraphs[index]
    if (next === previous) continue
    if (next.id !== previous.id || Boolean(next.deleted) !== Boolean(previous.deleted)) return makeDoc(manifest, scenes)
    if (next.deleted) continue
    const position = doc.index.get(paragraphKey(next.id))
    if (position === undefined) return makeDoc(manifest, scenes)
    flow ??= doc.flow.slice()
    const block = flow[position]
    const { align: _align, lang: _lang, breakBefore: _break, conflictOf: _conflict, ...rest } = block
    flow[position] = {
      ...rest,
      style: next.style,
      runs: next.runs,
      ...(next.align ? { align: next.align } : {}),
      ...(next.lang ? { lang: next.lang } : {}),
      ...(next.breakBefore ? { breakBefore: next.breakBefore } : {}),
      ...(next.conflictOf ? { conflictOf: next.conflictOf } : {}),
      paragraph: next,
    }
  }
  return { manifest, scenes, flow: flow ?? doc.flow, index: doc.index }
}

export const updateParagraph = (doc: Doc, sceneId: string, paragraphId: string, update: (paragraph: Paragraph) => Paragraph): Doc => {
  const scene = doc.scenes.get(sceneId)
  if (!scene) return doc
  const position = sceneParagraphIndex(scene, paragraphId)
  if (position < 0) return doc
  const next = update(scene.paragraphs[position])
  if (next === scene.paragraphs[position]) return doc
  const paragraphs = scene.paragraphs.slice()
  paragraphs[position] = next
  return withScene(doc, { ...scene, paragraphs })
}

/** A key between a paragraph and its successor in the scene (tombstones included). */
export const keyAfter = (scene: Scene, paragraphId: string | null) => {
  if (paragraphId === null) return keyBetween(null, scene.paragraphs[0]?.key ?? null)
  const position = sceneParagraphIndex(scene, paragraphId)
  return keyBetween(scene.paragraphs[position].key, scene.paragraphs[position + 1]?.key ?? null)
}

export const keyBefore = (scene: Scene, paragraphId: string) => {
  const position = sceneParagraphIndex(scene, paragraphId)
  return keyBetween(scene.paragraphs[position - 1]?.key ?? null, scene.paragraphs[position].key)
}

export const insertParagraph = (doc: Doc, sceneId: string, paragraph: Paragraph): Doc => {
  const scene = doc.scenes.get(sceneId)
  if (!scene) return doc
  const paragraphs = [...scene.paragraphs, paragraph].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : left.id.localeCompare(right.id)))
  return withScene(doc, { ...scene, paragraphs })
}

export const removeParagraphs = (doc: Doc, sceneId: string, ids: Set<string>): Doc => {
  const scene = doc.scenes.get(sceneId)
  if (!scene || !ids.size) return doc
  return withScene(doc, { ...scene, paragraphs: scene.paragraphs.filter((paragraph) => !ids.has(paragraph.id)) })
}

const mapBinder = (nodes: BinderNode[], update: (node: BinderNode) => BinderNode | null): BinderNode[] => {
  let changed = false
  const out: BinderNode[] = []
  for (const node of nodes) {
    let next = update(node)
    if (next && next.children) {
      const children = mapBinder(next.children, update)
      if (children !== next.children) next = { ...next, children }
    }
    if (next !== node) changed = true
    if (next) out.push(next)
  }
  return changed ? out : nodes
}

export const updateBinder = (doc: Doc, update: (node: BinderNode) => BinderNode | null, scenes = doc.scenes): Doc => {
  const binder = mapBinder(doc.manifest.binder, update)
  if (binder === doc.manifest.binder && scenes === doc.scenes) return doc
  return makeDoc({ ...doc.manifest, binder }, scenes)
}

export const setNodeTitle = (doc: Doc, nodeId: string, title: string) => updateBinder(doc, (node) => (node.id === nodeId && node.title !== title ? { ...node, title } : node))

export const findNode = (nodes: BinderNode[], id: string, parent: BinderNode | null = null): { node: BinderNode; parent: BinderNode | null; siblings: BinderNode[] } | null => {
  for (const node of nodes) {
    if (node.id === id) return { node, parent, siblings: nodes }
    const found = node.children ? findNode(node.children, id, node) : null
    if (found) return found
  }
  return null
}

/** Inserts nodes right after `afterId` among its siblings. */
export const insertNodesAfter = (nodes: BinderNode[], afterId: string, inserted: BinderNode[]): BinderNode[] => {
  const position = nodes.findIndex((node) => node.id === afterId)
  if (position >= 0) return [...nodes.slice(0, position + 1), ...inserted, ...nodes.slice(position + 1)]
  let changed = false
  const out = nodes.map((node) => {
    if (!node.children) return node
    const children = insertNodesAfter(node.children, afterId, inserted)
    if (children === node.children) return node
    changed = true
    return { ...node, children }
  })
  return changed ? out : nodes
}

/** The chapter (or part) that holds a scene. */
export const chapterOfScene = (nodes: BinderNode[], sceneId: string): BinderNode | null => {
  const found = findNode(nodes, sceneId)
  if (!found) return null
  let parent = found.parent
  while (parent && parent.kind === 'folder') parent = findNode(nodes, parent.id)?.parent ?? null
  return parent
}

export const newSceneId = () => newId()
export const flowKeyOfParagraph = paragraphKey
export const flowKeyOfTitle = titleKey
