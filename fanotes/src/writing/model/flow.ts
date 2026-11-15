// The manuscript as the editor and the layout see it: one ordered list of
// blocks built from the binder. A chapter or part contributes its title, each
// scene its paragraphs, and a scene that follows another in the same chapter
// is preceded by a scene break. Excluded nodes are left out.
import type { Align, BinderNode, Paragraph, Run, Scene, StoryLanguage, StoryManifest } from './types'

export type BlockRef =
  | { kind: 'title'; nodeId: string }
  | { kind: 'break'; sceneId: string }
  | { kind: 'para'; sceneId: string; paragraphId: string }

export type FlowBlock = {
  /** Unique in the flow: `t:<node>`, `b:<scene>`, `p:<paragraph>`. */
  key: string
  ref: BlockRef
  style: string
  runs: Run[]
  align?: Align
  lang?: StoryLanguage
  editable: boolean
  breakBefore?: 'page'
  /** The chapter (or part) this block belongs to, for headers and navigation. */
  chapterId: string | null
  chapterTitle: string
  sceneId: string | null
  /** First paragraph after a title or a scene break: no first-line indent, drop cap if the style has one. */
  afterBreak: boolean
  /** Starts a chapter: page break, header hidden on that page. */
  chapterStart: boolean
  conflictOf?: string
  /** The paragraph object (for identity-based layout caching). */
  paragraph?: Paragraph
}

export const titleKey = (nodeId: string) => `t:${nodeId}`
export const breakKey = (sceneId: string) => `b:${sceneId}`
export const paragraphKey = (paragraphId: string) => `p:${paragraphId}`

const titleRuns = new Map<string, Run[]>()
/** Same text → same array, so the layout cache keeps title blocks too. */
const runsFor = (key: string, text: string): Run[] => {
  const cached = titleRuns.get(key)
  if (cached && cached[0]?.text === text) return cached
  const runs = text ? [{ text }] : []
  titleRuns.set(key, runs)
  return runs
}

export const visibleParagraphs = (scene: Scene) => scene.paragraphs.filter((paragraph) => !paragraph.deleted)

export const buildFlow = (manifest: StoryManifest, scenes: Map<string, Scene>): FlowBlock[] => {
  const blocks: FlowBlock[] = []
  const sceneBreak = manifest.page.sceneBreak
  const walk = (nodes: BinderNode[], chapterId: string | null, chapterTitle: string) => {
    let scenesInChapter = 0
    for (const node of nodes) {
      if (node.exclude) continue
      if (node.kind === 'part' || node.kind === 'chapter') {
        blocks.push({
          key: titleKey(node.id),
          ref: { kind: 'title', nodeId: node.id },
          style: node.kind === 'part' && manifest.styles.part ? 'part' : 'chapter',
          runs: runsFor(titleKey(node.id), node.title),
          editable: true,
          chapterId: node.id,
          chapterTitle: node.title,
          sceneId: null,
          afterBreak: false,
          chapterStart: true,
        })
        walk(node.children ?? [], node.id, node.title)
        scenesInChapter = 0
        continue
      }
      if (node.kind === 'folder') {
        walk(node.children ?? [], chapterId, chapterTitle)
        continue
      }
      const scene = scenes.get(node.id)
      if (!scene) continue
      if (scenesInChapter > 0) {
        blocks.push({
          key: breakKey(scene.id),
          ref: { kind: 'break', sceneId: scene.id },
          style: 'scenebreak',
          runs: runsFor(breakKey(scene.id), sceneBreak),
          editable: false,
          chapterId,
          chapterTitle,
          sceneId: scene.id,
          afterBreak: false,
          chapterStart: false,
        })
      }
      scenesInChapter += 1
      let first = true
      for (const paragraph of visibleParagraphs(scene)) {
        const previous = blocks[blocks.length - 1]
        blocks.push({
          key: paragraphKey(paragraph.id),
          ref: { kind: 'para', sceneId: scene.id, paragraphId: paragraph.id },
          style: paragraph.style,
          runs: paragraph.runs,
          ...(paragraph.align ? { align: paragraph.align } : {}),
          ...(paragraph.lang ? { lang: paragraph.lang } : {}),
          ...(paragraph.breakBefore ? { breakBefore: paragraph.breakBefore } : {}),
          ...(paragraph.conflictOf ? { conflictOf: paragraph.conflictOf } : {}),
          editable: true,
          chapterId,
          chapterTitle,
          sceneId: scene.id,
          afterBreak: first && (!previous || previous.ref.kind !== 'para'),
          chapterStart: false,
          paragraph,
        })
        first = false
      }
    }
  }
  walk(manifest.binder, null, '')
  return blocks
}
