import { keyBetween } from './keys'
import { newId } from './ids'
import {
  SCENE_FORMAT,
  STORY_FORMAT,
  type BinderNode,
  type PageSetup,
  type PageSizeId,
  type Paragraph,
  type ParagraphStyle,
  type Scene,
  type StoryLanguage,
  type StoryManifest,
} from './types'

/** Page sizes in millimetres and their usual margins. */
export const PAGE_SIZES: Record<Exclude<PageSizeId, 'custom'>, { width: number; height: number; margins: PageSetup['margins']; name: { de: string; en: string } }> = {
  A4: { width: 210, height: 297, margins: { top: 25, bottom: 25, inner: 25, outer: 25 }, name: { de: 'A4', en: 'A4' } },
  A5: { width: 148, height: 210, margins: { top: 18, bottom: 20, inner: 20, outer: 15 }, name: { de: 'A5 (Buch)', en: 'A5 (book)' } },
  Letter: { width: 215.9, height: 279.4, margins: { top: 25.4, bottom: 25.4, inner: 25.4, outer: 25.4 }, name: { de: 'US Letter', en: 'US Letter' } },
  pocket: { width: 115, height: 185, margins: { top: 15, bottom: 17, inner: 17, outer: 12 }, name: { de: 'Taschenbuch (11,5 × 18,5 cm)', en: 'Pocket book (4.5 × 7.3 in)' } },
  trade: { width: 152.4, height: 228.6, margins: { top: 19, bottom: 21, inner: 22, outer: 16 }, name: { de: 'Trade Paperback (6 × 9 in)', en: 'Trade paperback (6 × 9 in)' } },
  manuscript: { width: 210, height: 297, margins: { top: 25.4, bottom: 25.4, inner: 25.4, outer: 25.4 }, name: { de: 'Normseite / Manuskript', en: 'Standard manuscript' } },
}

export const defaultPageSetup = (size: Exclude<PageSizeId, 'custom'> = 'A5', language: StoryLanguage = 'de'): PageSetup => {
  const format = PAGE_SIZES[size]
  const book = size === 'A5' || size === 'pocket' || size === 'trade'
  return {
    size,
    width: format.width,
    height: format.height,
    margins: { ...format.margins },
    mirror: book,
    header: book ? { left: '{title}', center: '', right: '{chapter}' } : size === 'manuscript' ? { left: '', center: '', right: '{author} / {title} / {page}' } : { left: '', center: '', right: '' },
    footer: book || size === 'manuscript' ? { left: '', center: size === 'manuscript' ? '' : '{page}', right: '' } : { left: '', center: '{page}', right: '' },
    hideOnChapterStart: true,
    chapterStartsRight: false,
    pageNumberStart: 1,
    headerOffset: book ? 10 : 12.7,
    footerOffset: book ? 10 : 12.7,
    widowsOrphans: true,
    hyphenate: language.startsWith('de'),
    sceneBreak: language.startsWith('de') ? '* * *' : '* * *',
  }
}

const style = (id: string, de: string, en: string, rest: Partial<ParagraphStyle>): ParagraphStyle => {
  const value: ParagraphStyle = {
    id,
    name: { de, en },
    font: 'literata',
    size: 11,
    lineHeight: 1.45,
    spaceBefore: 0,
    spaceAfter: 0,
    indentFirst: 0,
    indentLeft: 0,
    indentRight: 0,
    align: 'justify',
    ...rest,
  }
  // Optional flags are stored only when set, exactly as a saved file reads back.
  for (const key of ['bold', 'italic', 'smallCaps', 'uppercase', 'keepWithNext', 'pageBreakBefore', 'noIndentAfterBreak', 'dropCap', 'outlineLevel'] as const) {
    if (!value[key]) delete value[key]
  }
  return value
}

/** The built-in paragraph styles. Projects can change them; ids stay. */
export const defaultStyles = (manuscript = false): Record<string, ParagraphStyle> => {
  const font = manuscript ? 'courier' : 'literata'
  const size = manuscript ? 12 : 11
  const lineHeight = manuscript ? 2 : 1.45
  const list = [
    style('body', 'Fliesstext', 'Body text', { font, size, lineHeight, indentFirst: manuscript ? 12.7 : 5, align: manuscript ? 'left' : 'justify', next: 'body' }),
    style('first', 'Erster Absatz', 'First paragraph', { font, size, lineHeight, indentFirst: 0, align: manuscript ? 'left' : 'justify', next: 'body', dropCap: 0 }),
    style('chapter', 'Kapitelüberschrift', 'Chapter title', { font, size: manuscript ? 12 : 20, lineHeight: 1.2, spaceBefore: manuscript ? 72 : 60, spaceAfter: manuscript ? 24 : 30, align: 'center', bold: !manuscript, uppercase: manuscript, keepWithNext: true, pageBreakBefore: true, next: 'first', outlineLevel: 1 }),
    style('heading', 'Überschrift', 'Heading', { font, size: manuscript ? 12 : 14, lineHeight: 1.3, spaceBefore: 18, spaceAfter: 8, align: 'left', bold: true, keepWithNext: true, next: 'first', outlineLevel: 2 }),
    style('subheading', 'Zwischenüberschrift', 'Subheading', { font, size: manuscript ? 12 : 12, lineHeight: 1.3, spaceBefore: 12, spaceAfter: 6, align: 'left', italic: true, keepWithNext: true, next: 'first', outlineLevel: 3 }),
    style('quote', 'Zitat', 'Quotation', { font, size: manuscript ? 12 : 10.5, lineHeight, spaceBefore: 6, spaceAfter: 6, indentLeft: 10, indentRight: 10, align: manuscript ? 'left' : 'justify', italic: !manuscript, next: 'body' }),
    style('dialogue', 'Dialog', 'Dialogue', { font, size, lineHeight, indentFirst: manuscript ? 12.7 : 5, align: manuscript ? 'left' : 'justify', next: 'dialogue' }),
    style('letter', 'Brief / Einschub', 'Letter / insert', { font, size: manuscript ? 12 : 10.5, lineHeight, spaceBefore: 6, spaceAfter: 6, indentLeft: 8, indentRight: 8, align: 'left', italic: !manuscript, next: 'letter' }),
    style('poem', 'Gedicht / Lied', 'Poem / song', { font, size, lineHeight: manuscript ? 2 : 1.35, indentLeft: 15, align: 'left', italic: !manuscript, next: 'poem' }),
    style('scenebreak', 'Szenenwechsel', 'Scene break', { font, size, lineHeight, spaceBefore: 8, spaceAfter: 8, align: 'center', keepWithNext: true, next: 'first' }),
    style('epigraph', 'Motto', 'Epigraph', { font, size: manuscript ? 12 : 10, lineHeight: 1.35, spaceBefore: 24, spaceAfter: 24, indentLeft: 30, align: 'right', italic: !manuscript, next: 'first' }),
    style('list', 'Aufzählung', 'List', { font, size, lineHeight, indentLeft: 6, indentFirst: -4, align: 'left', next: 'list' }),
  ]
  return Object.fromEntries(list.map((entry) => [entry.id, entry]))
}

export const emptyParagraph = (style: string, deviceId: string, key: string, text = ''): Paragraph => ({
  id: newId(),
  key,
  v: { [deviceId]: 1 },
  style,
  runs: text ? [{ text }] : [],
})

export const emptyScene = (deviceId: string, firstStyle = 'first', text = ''): Scene => ({
  format: SCENE_FORMAT,
  id: newId(),
  paragraphs: [emptyParagraph(firstStyle, deviceId, keyBetween(null, null), text)],
})

export type NewStoryOptions = {
  title: string
  author?: string
  language: StoryLanguage
  size?: Exclude<PageSizeId, 'custom'>
  deviceId: string
  now?: Date
}

/** A new project with one chapter holding one empty scene. */
export const newStory = (options: NewStoryOptions): { manifest: StoryManifest; scenes: Scene[] } => {
  const now = (options.now ?? new Date()).toISOString()
  const scene = emptyScene(options.deviceId)
  const english = options.language.startsWith('en')
  const chapter: BinderNode = {
    id: newId(),
    kind: 'chapter',
    title: english ? 'Chapter 1' : 'Kapitel 1',
    children: [{ id: scene.id, kind: 'scene', title: english ? 'Scene 1' : 'Szene 1', status: 'draft' }],
  }
  const size = options.size ?? 'A5'
  return {
    manifest: {
      format: STORY_FORMAT,
      id: newId(),
      title: options.title.trim() || (english ? 'Untitled story' : 'Unbenannte Geschichte'),
      ...(options.author ? { author: options.author } : {}),
      language: options.language,
      page: defaultPageSetup(size, options.language),
      styles: defaultStyles(size === 'manuscript'),
      binder: [chapter],
      goals: {},
      dictionary: [],
      createdAt: now,
      updatedAt: now,
    },
    scenes: [scene],
  }
}

/** Typographic defaults per language. */
export const LANGUAGE_TYPOGRAPHY: Record<StoryLanguage, { open: string; close: string; openSingle: string; closeSingle: string; apostrophe: string; dash: string; wpm: number }> = {
  de: { open: '„', close: '“', openSingle: '‚', closeSingle: '‘', apostrophe: '’', dash: ' – ', wpm: 230 },
  'de-CH': { open: '«', close: '»', openSingle: '‹', closeSingle: '›', apostrophe: '’', dash: ' – ', wpm: 230 },
  'en-US': { open: '“', close: '”', openSingle: '‘', closeSingle: '’', apostrophe: '’', dash: '—', wpm: 250 },
  'en-GB': { open: '‘', close: '’', openSingle: '“', closeSingle: '”', apostrophe: '’', dash: ' – ', wpm: 250 },
}
