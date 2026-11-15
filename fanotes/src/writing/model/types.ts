// The writing mode's document model. A story project is a folder
// `Name.story/` in the vault: `story.json` (this manifest) and one file per
// scene under `scenes/`. Paragraphs carry stable ids, an order key and a
// version vector so two devices' edits of one scene merge paragraph by
// paragraph (see merge.ts). Units: lengths in millimetres, font sizes in points.

export const STORY_FORMAT = 'fanotes-story-v1' as const
export const SCENE_FORMAT = 'fanotes-story-scene-v1' as const
export const STORY_EXTENSION = '.story'

export type StoryLanguage = 'de' | 'de-CH' | 'en-US' | 'en-GB'
export type Align = 'left' | 'center' | 'right' | 'justify'

/** Inline formatting of a run. Absent means "as the paragraph style says". */
export type Marks = {
  b?: true
  i?: true
  u?: true
  s?: true
  /** Small capitals. */
  sc?: true
  sup?: true
  sub?: true
  font?: FontFamilyId
  /** Points. */
  size?: number
  color?: string
  /** Highlight colour. */
  hl?: string
  link?: string
  /** Footnote reference: the footnote id. The run's text is the marker (usually empty, numbered on layout). */
  fn?: string
  /** Comment anchor: the comment id. */
  cm?: string
  lang?: StoryLanguage
}

export type Run = { text: string; m?: Marks }

export type Paragraph = {
  id: string
  /** Order key within the scene (fractional index). */
  key: string
  /** Version vector: device id → edit counter. */
  v: Record<string, number>
  style: string
  runs: Run[]
  lang?: StoryLanguage
  align?: Align
  /** A manual page break before this paragraph. */
  breakBefore?: 'page'
  /** Tombstone: the paragraph was deleted (kept for merging, never shown). */
  deleted?: true
  /**
   * Two devices changed this paragraph at the same time. This is the other
   * device's version, kept next to the one that kept the id, for review.
   */
  conflictOf?: string
}

export type Footnote = { id: string; runs: Run[] }
export type Comment = { id: string; author: string; at: string; text: string; resolved?: boolean }

export type Scene = {
  format: typeof SCENE_FORMAT
  id: string
  paragraphs: Paragraph[]
  footnotes?: Record<string, Footnote>
  comments?: Record<string, Comment>
}

export type FontFamilyId = 'literata' | 'garamond' | 'courier' | 'atkinson'

export type ParagraphStyle = {
  id: string
  name: { de: string; en: string }
  font: FontFamilyId
  /** Points. */
  size: number
  /** Multiple of the font size. */
  lineHeight: number
  /** Points. */
  spaceBefore: number
  spaceAfter: number
  /** Millimetres. */
  indentFirst: number
  indentLeft: number
  indentRight: number
  align: Align
  bold?: boolean
  italic?: boolean
  smallCaps?: boolean
  uppercase?: boolean
  color?: string
  keepWithNext?: boolean
  pageBreakBefore?: boolean
  /** Number of lines a drop cap spans (0 = none). */
  dropCap?: number
  /** Style of the paragraph Enter creates after this one. */
  next?: string
  /** First paragraph after a heading or scene break uses this style's first-line indent of 0. */
  noIndentAfterBreak?: boolean
  /** Shown in the outline/navigation (chapter and scene headings). */
  outlineLevel?: number
}

export type PageSizeId = 'A4' | 'A5' | 'Letter' | 'pocket' | 'trade' | 'manuscript' | 'custom'

export type HeaderFooter = { left: string; center: string; right: string }

export type PageSetup = {
  size: PageSizeId
  /** Millimetres. */
  width: number
  height: number
  margins: { top: number; bottom: number; inner: number; outer: number }
  /** Inner/outer margins alternate (books). Off: inner = left. */
  mirror: boolean
  header: HeaderFooter
  footer: HeaderFooter
  /** Header and footer are left out on the first page of a chapter. */
  hideOnChapterStart: boolean
  /** Chapters start on a right-hand (odd) page. */
  chapterStartsRight: boolean
  pageNumberStart: number
  /** Distance of header/footer text from the page edge, millimetres. */
  headerOffset: number
  footerOffset: number
  /** Two lines minimum at the top and bottom of a page for a split paragraph. */
  widowsOrphans: boolean
  hyphenate: boolean
  sceneBreak: string
}

export type BinderKind = 'part' | 'chapter' | 'scene' | 'folder'
export type SceneStatus = 'idea' | 'draft' | 'revised' | 'final'

export type BinderNode = {
  id: string
  kind: BinderKind
  title: string
  children?: BinderNode[]
  synopsis?: string
  status?: SceneStatus
  /** Label colour (hex). */
  label?: string
  /** Point-of-view character id. */
  pov?: string
  /** Left out of the manuscript and exports. */
  exclude?: boolean
  /** Word goal of this chapter or scene. */
  goal?: number
}

export type StoryGoals = {
  project?: number
  /** ISO date. */
  deadline?: string
  session?: number
  daily?: number
}

export type StoryManifest = {
  format: typeof STORY_FORMAT
  id: string
  title: string
  subtitle?: string
  author?: string
  language: StoryLanguage
  page: PageSetup
  styles: Record<string, ParagraphStyle>
  binder: BinderNode[]
  goals?: StoryGoals
  /** Words that are correct in this project (names, invented words). */
  dictionary?: string[]
  createdAt: string
  updatedAt: string
}

/** A loaded project: manifest plus scenes by id. */
export type StoryProject = {
  /** Vault path of the `.story` folder. */
  path: string
  manifest: StoryManifest
  scenes: Map<string, Scene>
}
