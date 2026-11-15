// What every exporter starts from: the story narrowed to the chosen scope
// (whole book or one chapter), with excluded nodes and the trash left out,
// the manuscript flow, and footnotes and comments by id.
import { TRASH_ID } from '../model/binder'
import { buildFlow, type FlowBlock } from '../model/flow'
import type { BinderNode, Comment, Footnote, Run, Scene, StoryManifest } from '../model/types'

export type ExportScope = 'book' | 'chapter'
export type NotesPlacement = 'footnotes' | 'endnotes-chapter' | 'endnotes-book'

export type StorySource = { manifest: StoryManifest; scenes: Map<string, Scene> | Scene[] }

export type Prepared = {
  manifest: StoryManifest
  scenes: Map<string, Scene>
  flow: FlowBlock[]
  /** Binder nodes by id (only those in the export). */
  nodes: Map<string, BinderNode>
  footnotes: Map<string, Footnote>
  comments: Map<string, Comment>
  footnoteRuns: (id: string) => Run[] | null
  /** The book has parts (chapter titles are one outline level deeper). */
  hasParts: boolean
}

/** Drops excluded nodes and the trash folder, recursively. */
export const exportedBinder = (nodes: BinderNode[]): BinderNode[] => nodes
  .filter((node) => !node.exclude && node.id !== TRASH_ID)
  .map((node) => (node.children ? { ...node, children: exportedBinder(node.children) } : node))

const findNode = (nodes: BinderNode[], id: string): BinderNode | null => {
  for (const node of nodes) {
    if (node.id === id) return node
    const inner = findNode(node.children ?? [], id)
    if (inner) return inner
  }
  return null
}

export const prepare = (source: StorySource, scope: ExportScope = 'book', chapterId?: string): Prepared => {
  const scenes = source.scenes instanceof Map ? source.scenes : new Map(source.scenes.map((scene) => [scene.id, scene]))
  let binder = exportedBinder(source.manifest.binder)
  if (scope === 'chapter') {
    const node = chapterId ? findNode(binder, chapterId) : null
    if (!node) throw new Error(`Chapter ${chapterId ?? '(none)'} is not in the export.`)
    binder = [node]
  }
  const manifest: StoryManifest = { ...source.manifest, binder }
  const flow = buildFlow(manifest, scenes)
  const nodes = new Map<string, BinderNode>()
  const walk = (list: BinderNode[]) => {
    for (const node of list) {
      nodes.set(node.id, node)
      walk(node.children ?? [])
    }
  }
  walk(binder)
  const footnotes = new Map<string, Footnote>()
  const comments = new Map<string, Comment>()
  for (const scene of scenes.values()) {
    if (!nodes.has(scene.id)) continue
    for (const [id, note] of Object.entries(scene.footnotes ?? {})) footnotes.set(id, note)
    for (const [id, note] of Object.entries(scene.comments ?? {})) comments.set(id, note)
  }
  const hasParts = [...nodes.values()].some((node) => node.kind === 'part')
  return { manifest, scenes, flow, nodes, footnotes, comments, footnoteRuns: (id) => footnotes.get(id)?.runs ?? null, hasParts }
}

/** The binder node kind of a title block ('part' or 'chapter'). */
export const titleKind = (prepared: Prepared, block: FlowBlock): 'part' | 'chapter' | null => {
  if (block.ref.kind !== 'title') return null
  return prepared.nodes.get(block.ref.nodeId)?.kind === 'part' ? 'part' : 'chapter'
}

/** Scene titles from the binder, in flow order: first block index of each scene. */
export const sceneStarts = (prepared: Prepared) => {
  const starts = new Map<number, BinderNode>()
  const seen = new Set<string>()
  prepared.flow.forEach((block, index) => {
    if (!block.sceneId || seen.has(block.sceneId)) return
    seen.add(block.sceneId)
    const node = prepared.nodes.get(block.sceneId)
    if (node) starts.set(index, node)
  })
  return starts
}

export const notesLabel = (language: string) => (language.startsWith('en') ? 'Notes' : 'Anmerkungen')

export const safeFileName = (title: string) => title.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120) || 'Story'

export const xmlEscape = (text: string) => text
  // Characters XML 1.0 does not allow.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/gu, '')
  .replace(/[&<>"]/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)

export const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled')
    this.name = 'ExportCancelled'
  }
}
