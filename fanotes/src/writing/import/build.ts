// Builds a new story from imported text: parts, chapters, scenes and
// paragraphs arrive in reading order; the result is a manifest and scenes
// made with the model helpers (ids, order keys, version vectors).
import { detectLanguage } from '../assist/language'
import { newStory } from '../model/defaults'
import { newId } from '../model/ids'
import { keysBetween } from '../model/keys'
import { normalizeRuns, runsText } from '../model/runs'
import { SCENE_FORMAT, type Align, type BinderNode, type Comment, type Footnote, type Paragraph, type Run, type Scene, type StoryLanguage, type StoryManifest } from '../model/types'

export type ImportedParagraph = { style: string; runs: Run[]; align?: Align; lang?: StoryLanguage; breakBefore?: 'page' }
export type ImportedStory = { manifest: StoryManifest; scenes: Scene[] }

type SceneDraft = { node: BinderNode; paragraphs: ImportedParagraph[]; footnotes: Record<string, Footnote>; comments: Record<string, Comment> }

/** Paragraph text that marks a scene break. */
export const SCENE_BREAK = /^\s*(?:(?:\*\s*){3,}|#|⁂|(?:~\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,}|(?:•\s*){3}|(?:·\s*){3}|◇|◆|§)\s*$/u

/** A chapter (or part) heading in plain text: "Kapitel 3", "Chapter Three", "Prolog", "III". */
export const CHAPTER_HEADING = /^(?:(?:kapitel|chapter|teil|part|buch|book)\s+(?:\d{1,4}|[ivxlcdm]+|[\p{L}-]{3,20})\b[^\n]{0,70}|(?:prolog|prologue|epilog|epilogue|vorwort|nachwort|foreword|afterword|preface|einleitung|introduction|interlude|zwischenspiel)\b[^\n]{0,60}|[IVXLC]{1,7}\.?|\d{1,3}\.?)$/iu
export const PART_HEADING = /^(?:teil|part|buch|book)\s/iu

export const normalizeLanguage = (value: string | null | undefined): StoryLanguage | null => {
  if (!value) return null
  const lower = value.toLowerCase()
  if (lower === 'de-ch' || lower === 'gsw') return 'de-CH'
  if (lower.startsWith('de')) return 'de'
  if (lower === 'en-gb' || lower === 'en-uk') return 'en-GB'
  if (lower.startsWith('en')) return 'en-US'
  return null
}

export const guessLanguage = (text: string): StoryLanguage => {
  const sample = text.slice(0, 20_000)
  const detected = detectLanguage(sample)
  if (detected === 'en') return /\b(colour|realise|favourite|whilst)\b/iu.test(sample) ? 'en-GB' : 'en-US'
  return /[«»]/u.test(sample) && !/ß/u.test(sample) ? 'de-CH' : 'de'
}

export class StoryBuilder {
  readonly binder: BinderNode[] = []
  private part: BinderNode | null = null
  private chapterNode: BinderNode | null = null
  private scene: SceneDraft | null = null
  private scenes: SceneDraft[] = []
  private sceneCount = 0
  private pendingBreak = false
  title = ''
  subtitle = ''
  author = ''
  language: StoryLanguage | null = null
  /** The first paragraph of a scene in body style becomes 'first' (foreign files). */
  firstStyle = true
  patchManifest: (manifest: StoryManifest) => StoryManifest = (manifest) => manifest

  private english() {
    return (this.language ?? 'de').startsWith('en')
  }

  private container() {
    return this.chapterNode?.children ?? this.part?.children ?? this.binder
  }

  addPart(title: string) {
    const node: BinderNode = { id: newId(), kind: 'part', title, children: [] }
    this.binder.push(node)
    this.part = node
    this.chapterNode = null
    this.scene = null
  }

  addChapter(title: string) {
    const node: BinderNode = { id: newId(), kind: 'chapter', title, children: [] }
    ;(this.part?.children ?? this.binder).push(node)
    this.chapterNode = node
    this.scene = null
  }

  /** Starts a new scene (a titled one, or after a scene break). */
  addScene(title?: string) {
    this.sceneCount += 1
    const node: BinderNode = { id: newId(), kind: 'scene', title: title || `${this.english() ? 'Scene' : 'Szene'} ${this.container().filter((entry) => entry.kind === 'scene').length + 1}` }
    this.container().push(node)
    this.scene = { node, paragraphs: [], footnotes: {}, comments: {} }
    this.scenes.push(this.scene)
  }

  /** A scene break: the next paragraph starts a new scene (an empty scene is not created). */
  sceneBreak() {
    if (this.scene?.paragraphs.length) this.scene = null
  }

  pageBreak() {
    this.pendingBreak = true
  }

  paragraph(paragraph: ImportedParagraph) {
    if (!this.scene) this.addScene()
    const runs = normalizeRuns(paragraph.runs)
    const entry: ImportedParagraph = { ...paragraph, runs }
    if (this.pendingBreak && this.scene!.paragraphs.length) entry.breakBefore = 'page'
    this.pendingBreak = false
    if (this.firstStyle && !this.scene!.paragraphs.length && entry.style === 'body') entry.style = 'first'
    this.scene!.paragraphs.push(entry)
  }

  footnote(runs: Run[]): string {
    if (!this.scene) this.addScene()
    const id = newId()
    this.scene!.footnotes[id] = { id, runs: normalizeRuns(runs) }
    return id
  }

  comment(comment: Omit<Comment, 'id'>): string {
    if (!this.scene) this.addScene()
    const id = newId()
    this.scene!.comments[id] = { id, ...comment }
    return id
  }

  /** Text of everything so far (for language detection). */
  sampleText() {
    return this.scenes.flatMap((scene) => scene.paragraphs.map((paragraph) => runsText(paragraph.runs))).join('\n').slice(0, 20_000)
  }

  build(options: { deviceId: string; fallbackTitle: string; now?: Date }): ImportedStory {
    const language = this.language ?? guessLanguage(this.sampleText())
    this.language = language
    const base = newStory({ title: this.title || options.fallbackTitle, author: this.author || undefined, language, deviceId: options.deviceId, now: options.now })
    // Chapters without text still get a scene to type into.
    const fill = (nodes: BinderNode[]) => {
      for (const node of nodes) {
        if (node.kind === 'chapter' && !(node.children ?? []).some((entry) => entry.kind === 'scene' || entry.kind === 'folder')) {
          const sceneNode: BinderNode = { id: newId(), kind: 'scene', title: `${language.startsWith('en') ? 'Scene' : 'Szene'} 1` }
          node.children = [...(node.children ?? []), sceneNode]
          this.scenes.push({ node: sceneNode, paragraphs: [], footnotes: {}, comments: {} })
        }
        if (node.children) fill(node.children)
      }
    }
    fill(this.binder)
    if (!this.binder.length) {
      this.addChapter(language.startsWith('en') ? 'Chapter 1' : 'Kapitel 1')
      fill(this.binder)
    }
    const scenes: Scene[] = this.scenes.map((draft) => {
      const drafts = draft.paragraphs.length ? draft.paragraphs : [{ style: 'first', runs: [] }]
      const keys = keysBetween(null, null, drafts.length)
      const paragraphs: Paragraph[] = drafts.map((entry, index) => ({
        id: newId(),
        key: keys[index],
        v: { [options.deviceId]: 1 },
        style: entry.style,
        runs: entry.runs,
        ...(entry.lang ? { lang: entry.lang } : {}),
        ...(entry.align ? { align: entry.align } : {}),
        ...(entry.breakBefore ? { breakBefore: entry.breakBefore } : {}),
      }))
      return {
        format: SCENE_FORMAT,
        id: draft.node.id,
        paragraphs,
        ...(Object.keys(draft.footnotes).length ? { footnotes: draft.footnotes } : {}),
        ...(Object.keys(draft.comments).length ? { comments: draft.comments } : {}),
      }
    })
    const manifest = this.patchManifest({ ...base.manifest, binder: this.binder, ...(this.subtitle ? { subtitle: this.subtitle } : {}) })
    // Keep only styles that exist; unknown ones fall back to body.
    for (const scene of scenes) for (const paragraph of scene.paragraphs) if (!manifest.styles[paragraph.style]) paragraph.style = 'body'
    return { manifest, scenes }
  }
}
