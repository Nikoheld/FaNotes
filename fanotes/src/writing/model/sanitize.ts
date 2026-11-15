// Reading project files from the vault: anything malformed is repaired or
// dropped field by field, never thrown away as a whole, so a damaged scene
// keeps every paragraph that is still readable.
import { defaultPageSetup, defaultStyles, PAGE_SIZES } from './defaults'
import { isId, newId } from './ids'
import { isValidKey, keysBetween } from './keys'
import { normalizeRuns } from './runs'
import {
  SCENE_FORMAT,
  STORY_FORMAT,
  type Align,
  type BinderKind,
  type BinderNode,
  type Comment,
  type FontFamilyId,
  type Footnote,
  type Marks,
  type PageSetup,
  type Paragraph,
  type ParagraphStyle,
  type Run,
  type Scene,
  type SceneStatus,
  type StoryLanguage,
  type StoryManifest,
} from './types'

const LANGUAGES = new Set<StoryLanguage>(['de', 'de-CH', 'en-US', 'en-GB'])
const ALIGNS = new Set<Align>(['left', 'center', 'right', 'justify'])
const FONTS = new Set<FontFamilyId>(['literata', 'garamond', 'courier', 'atkinson'])
const KINDS = new Set<BinderKind>(['part', 'chapter', 'scene', 'folder'])
const STATUSES = new Set<SceneStatus>(['idea', 'draft', 'revised', 'final'])
const COLOR = /^#[0-9a-f]{6}$/iu
const MAX_TEXT = 200_000

const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null)
const text = (value: unknown, max = 2000) => (typeof value === 'string' ? value.slice(0, max) : '')
const number = (value: unknown, min: number, max: number, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback)
const language = (value: unknown): StoryLanguage | undefined => (LANGUAGES.has(value as StoryLanguage) ? value as StoryLanguage : undefined)

export const sanitizeMarks = (value: unknown): Marks | undefined => {
  const source = record(value)
  if (!source) return undefined
  const marks: Marks = {}
  for (const flag of ['b', 'i', 'u', 's', 'sc', 'sup', 'sub'] as const) if (source[flag] === true) marks[flag] = true
  if (FONTS.has(source.font as FontFamilyId)) marks.font = source.font as FontFamilyId
  if (typeof source.size === 'number' && source.size >= 4 && source.size <= 144) marks.size = Math.round(source.size * 2) / 2
  if (typeof source.color === 'string' && COLOR.test(source.color)) marks.color = source.color.toLowerCase()
  if (typeof source.hl === 'string' && COLOR.test(source.hl)) marks.hl = source.hl.toLowerCase()
  if (typeof source.link === 'string' && /^(https?:|mailto:)/iu.test(source.link) && source.link.length < 2000) marks.link = source.link
  if (isId(source.fn)) marks.fn = source.fn
  if (isId(source.cm)) marks.cm = source.cm
  const lang = language(source.lang)
  if (lang) marks.lang = lang
  return Object.keys(marks).length ? marks : undefined
}

export const sanitizeRuns = (value: unknown): Run[] => {
  if (!Array.isArray(value)) return []
  const runs: Run[] = []
  let total = 0
  for (const entry of value.slice(0, 20_000)) {
    const source = record(entry)
    if (!source) continue
    const content = text(source.text, MAX_TEXT).replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
    total += content.length
    if (total > MAX_TEXT) break
    const marks = sanitizeMarks(source.m)
    runs.push(marks ? { text: content, m: marks } : { text: content })
  }
  return normalizeRuns(runs)
}

const sanitizeVector = (value: unknown): Record<string, number> => {
  const source = record(value)
  const out: Record<string, number> = {}
  if (!source) return out
  for (const [device, count] of Object.entries(source).slice(0, 200)) {
    if (/^[0-9a-z-]{1,40}$/u.test(device) && Number.isSafeInteger(count) && (count as number) > 0) out[device] = count as number
  }
  return out
}

export const sanitizeScene = (value: unknown, expectedId?: string): Scene | null => {
  const source = record(value)
  if (!source || source.format !== SCENE_FORMAT) return null
  const id = isId(source.id) ? source.id : expectedId && isId(expectedId) ? expectedId : null
  if (!id) return null
  const seen = new Set<string>()
  const paragraphs: Paragraph[] = []
  const rawParagraphs = Array.isArray(source.paragraphs) ? source.paragraphs.slice(0, 50_000) : []
  let rekey = false
  for (const entry of rawParagraphs) {
    const paragraph = record(entry)
    if (!paragraph) continue
    let pid = isId(paragraph.id) ? paragraph.id : newId()
    if (seen.has(pid)) pid = newId()
    seen.add(pid)
    const key = isValidKey(paragraph.key) ? paragraph.key : ''
    if (!key) rekey = true
    const item: Paragraph = {
      id: pid,
      key,
      v: sanitizeVector(paragraph.v),
      style: typeof paragraph.style === 'string' && /^[a-z0-9-]{1,40}$/u.test(paragraph.style) ? paragraph.style : 'body',
      runs: paragraph.deleted === true ? [] : sanitizeRuns(paragraph.runs),
    }
    const lang = language(paragraph.lang)
    if (lang) item.lang = lang
    if (ALIGNS.has(paragraph.align as Align)) item.align = paragraph.align as Align
    if (paragraph.breakBefore === 'page') item.breakBefore = 'page'
    if (paragraph.deleted === true) item.deleted = true
    if (isId(paragraph.conflictOf)) item.conflictOf = paragraph.conflictOf
    paragraphs.push(item)
  }
  if (rekey) {
    // Keep the stored order and give every paragraph a fresh, valid key.
    const keys = keysBetween(null, null, paragraphs.length)
    paragraphs.forEach((paragraph, index) => { paragraph.key = keys[index] })
  } else {
    paragraphs.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : left.id.localeCompare(right.id)))
  }
  const footnotes: Record<string, Footnote> = {}
  const rawFootnotes = record(source.footnotes)
  if (rawFootnotes) {
    for (const [fid, entry] of Object.entries(rawFootnotes).slice(0, 5000)) {
      const note = record(entry)
      if (isId(fid) && note) footnotes[fid] = { id: fid, runs: sanitizeRuns(note.runs) }
    }
  }
  const comments: Record<string, Comment> = {}
  const rawComments = record(source.comments)
  if (rawComments) {
    for (const [cid, entry] of Object.entries(rawComments).slice(0, 5000)) {
      const note = record(entry)
      if (!isId(cid) || !note) continue
      comments[cid] = { id: cid, author: text(note.author, 80), at: text(note.at, 40), text: text(note.text, 20_000), ...(note.resolved === true ? { resolved: true } : {}) }
    }
  }
  if (!paragraphs.some((paragraph) => !paragraph.deleted)) {
    paragraphs.push({ id: newId(), key: keysBetween(paragraphs.at(-1)?.key ?? null, null, 1)[0], v: {}, style: 'first', runs: [] })
  }
  return {
    format: SCENE_FORMAT,
    id,
    paragraphs,
    ...(Object.keys(footnotes).length ? { footnotes } : {}),
    ...(Object.keys(comments).length ? { comments } : {}),
  }
}

const sanitizeStyle = (id: string, value: unknown, fallback: ParagraphStyle | undefined): ParagraphStyle | null => {
  const source = record(value)
  if (!source) return fallback ?? null
  const base = fallback ?? defaultStyles().body
  const name = record(source.name)
  const style: ParagraphStyle = {
    id,
    name: { de: text(name?.de, 80) || base.name.de, en: text(name?.en, 80) || base.name.en },
    font: FONTS.has(source.font as FontFamilyId) ? source.font as FontFamilyId : base.font,
    size: number(source.size, 5, 96, base.size),
    lineHeight: number(source.lineHeight, 0.8, 4, base.lineHeight),
    spaceBefore: number(source.spaceBefore, 0, 400, base.spaceBefore),
    spaceAfter: number(source.spaceAfter, 0, 400, base.spaceAfter),
    indentFirst: number(source.indentFirst, -50, 100, base.indentFirst),
    indentLeft: number(source.indentLeft, 0, 100, base.indentLeft),
    indentRight: number(source.indentRight, 0, 100, base.indentRight),
    align: ALIGNS.has(source.align as Align) ? source.align as Align : base.align,
  }
  for (const flag of ['bold', 'italic', 'smallCaps', 'uppercase', 'keepWithNext', 'pageBreakBefore', 'noIndentAfterBreak'] as const) {
    const valueFlag = typeof source[flag] === 'boolean' ? source[flag] as boolean : base[flag]
    if (valueFlag) style[flag] = true
  }
  if (typeof source.color === 'string' && COLOR.test(source.color)) style.color = source.color
  const dropCap = number(source.dropCap, 0, 6, base.dropCap ?? 0)
  if (dropCap) style.dropCap = Math.round(dropCap)
  if (typeof source.next === 'string' && /^[a-z0-9-]{1,40}$/u.test(source.next)) style.next = source.next
  else if (base.next) style.next = base.next
  const marker = typeof source.listMarker === 'string' ? source.listMarker.slice(0, 4) : base.listMarker
  if (marker) style.listMarker = marker
  const outline = number(source.outlineLevel, 0, 6, base.outlineLevel ?? 0)
  if (outline) style.outlineLevel = Math.round(outline)
  return style
}

const sanitizePage = (value: unknown, languageCode: StoryLanguage): PageSetup => {
  const source = record(value)
  const size = source && (source.size as string) in PAGE_SIZES ? source.size as Exclude<PageSetup['size'], 'custom'> : source?.size === 'custom' ? 'custom' : 'A5'
  const base = defaultPageSetup(size === 'custom' ? 'A5' : size, languageCode)
  if (!source) return base
  const margins = record(source.margins)
  const hf = (input: unknown, fallback: PageSetup['header']) => {
    const part = record(input)
    return part ? { left: text(part.left, 200), center: text(part.center, 200), right: text(part.right, 200) } : fallback
  }
  return {
    size,
    width: number(source.width, 50, 600, base.width),
    height: number(source.height, 50, 900, base.height),
    margins: {
      top: number(margins?.top, 0, 100, base.margins.top),
      bottom: number(margins?.bottom, 0, 100, base.margins.bottom),
      inner: number(margins?.inner, 0, 100, base.margins.inner),
      outer: number(margins?.outer, 0, 100, base.margins.outer),
    },
    mirror: typeof source.mirror === 'boolean' ? source.mirror : base.mirror,
    header: hf(source.header, base.header),
    footer: hf(source.footer, base.footer),
    hideOnChapterStart: typeof source.hideOnChapterStart === 'boolean' ? source.hideOnChapterStart : base.hideOnChapterStart,
    chapterStartsRight: typeof source.chapterStartsRight === 'boolean' ? source.chapterStartsRight : base.chapterStartsRight,
    pageNumberStart: Math.round(number(source.pageNumberStart, 0, 9999, base.pageNumberStart)),
    headerOffset: number(source.headerOffset, 0, 60, base.headerOffset),
    footerOffset: number(source.footerOffset, 0, 60, base.footerOffset),
    widowsOrphans: typeof source.widowsOrphans === 'boolean' ? source.widowsOrphans : base.widowsOrphans,
    hyphenate: typeof source.hyphenate === 'boolean' ? source.hyphenate : base.hyphenate,
    sceneBreak: text(source.sceneBreak, 40) || base.sceneBreak,
  }
}

const sanitizeBinder = (value: unknown, depth = 0, seen = new Set<string>()): BinderNode[] => {
  if (!Array.isArray(value) || depth > 6) return []
  const out: BinderNode[] = []
  for (const entry of value.slice(0, 5000)) {
    const source = record(entry)
    if (!source || !isId(source.id) || seen.has(source.id) || !KINDS.has(source.kind as BinderKind)) continue
    seen.add(source.id)
    const node: BinderNode = { id: source.id, kind: source.kind as BinderKind, title: text(source.title, 300) }
    if (node.kind !== 'scene') node.children = sanitizeBinder(source.children, depth + 1, seen)
    const synopsis = text(source.synopsis, 5000)
    if (synopsis) node.synopsis = synopsis
    if (STATUSES.has(source.status as SceneStatus)) node.status = source.status as SceneStatus
    if (typeof source.label === 'string' && COLOR.test(source.label)) node.label = source.label
    if (isId(source.pov)) node.pov = source.pov
    if (source.exclude === true) node.exclude = true
    if (typeof source.goal === 'number' && source.goal > 0 && source.goal < 10_000_000) node.goal = Math.round(source.goal)
    out.push(node)
  }
  return out
}

export const sanitizeManifest = (value: unknown): StoryManifest | null => {
  const source = record(value)
  if (!source || source.format !== STORY_FORMAT || !isId(source.id)) return null
  const languageCode = language(source.language) ?? 'de'
  const page = sanitizePage(source.page, languageCode)
  const defaults = defaultStyles(page.size === 'manuscript')
  const styles: Record<string, ParagraphStyle> = {}
  const rawStyles = record(source.styles) ?? {}
  for (const id of new Set([...Object.keys(defaults), ...Object.keys(rawStyles)])) {
    if (!/^[a-z0-9-]{1,40}$/u.test(id)) continue
    const style = sanitizeStyle(id, rawStyles[id], defaults[id])
    if (style) styles[id] = style
  }
  const goalsSource = record(source.goals)
  const goals = goalsSource ? {
    ...(typeof goalsSource.project === 'number' && goalsSource.project > 0 ? { project: Math.round(goalsSource.project) } : {}),
    ...(typeof goalsSource.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(goalsSource.deadline) ? { deadline: goalsSource.deadline } : {}),
    ...(typeof goalsSource.session === 'number' && goalsSource.session > 0 ? { session: Math.round(goalsSource.session) } : {}),
    ...(typeof goalsSource.daily === 'number' && goalsSource.daily > 0 ? { daily: Math.round(goalsSource.daily) } : {}),
  } : {}
  const dictionary = Array.isArray(source.dictionary)
    ? [...new Set(source.dictionary.filter((word): word is string => typeof word === 'string' && word.length > 0 && word.length <= 80).slice(0, 20_000))]
    : []
  return {
    format: STORY_FORMAT,
    id: source.id,
    title: text(source.title, 300) || 'Untitled',
    ...(text(source.subtitle, 300) ? { subtitle: text(source.subtitle, 300) } : {}),
    ...(text(source.author, 200) ? { author: text(source.author, 200) } : {}),
    language: languageCode,
    page,
    styles,
    binder: sanitizeBinder(source.binder),
    goals,
    dictionary,
    createdAt: text(source.createdAt, 40) || new Date(0).toISOString(),
    updatedAt: text(source.updatedAt, 40) || new Date(0).toISOString(),
  }
}

/** Every scene id the binder refers to, in manuscript order. */
export const binderSceneIds = (nodes: BinderNode[]): string[] => nodes.flatMap((node) => (node.kind === 'scene' ? [node.id] : binderSceneIds(node.children ?? [])))
