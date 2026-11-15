// The export API: `exportStory(project, format, options)` gives the file's
// bytes, MIME type and a file name. The writers are loaded on first use, so
// pdf-lib, fontkit and JSZip stay out of the editor's bundle.
import { CanvasMeasurer, loadHyphenator, hyphenatorFor, loadWritingFonts, type Hyphenator, type TextMeasurer } from '../layout/measure'
import { LayoutCache, layoutManuscript, type ManuscriptLayout } from '../layout/paginate'
import type { StoryLanguage } from '../model/types'
import { allFaces, familiesInRuns, fetchFont, FontFiles, fontFilesOf, FontkitMeasurer, type FontLoader } from './fonts'
import { ExportCancelled, notesLabel, prepare, safeFileName, type ExportScope, type NotesPlacement, type Prepared, type StorySource } from './prepare'

export type ExportFormat = 'pdf' | 'docx' | 'epub' | 'md' | 'txt'
export { ExportCancelled }
export type { ExportScope, NotesPlacement, StorySource }

export type ExportOptions = {
  /** Whole book (default) or one chapter/part/scene given by `chapterId`. */
  scope?: ExportScope
  chapterId?: string
  /** Footnotes at the page bottom (default) or as endnotes per chapter / at the end. */
  notes?: NotesPlacement
  /** DOCX, EPUB, Markdown, text: scene titles from the binder as headings instead of scene-break markers. */
  sceneTitles?: boolean
  /** PDF: bookmarks for scenes too (default true). */
  sceneBookmarks?: boolean
  /** DOCX: include comments (default true). */
  comments?: boolean
  /** EPUB: embed the bundled fonts (default false). */
  embedFonts?: boolean
  /** PDF: the screen's measurer, so line and page breaks match the editor exactly. */
  measurer?: TextMeasurer
  hyphenators?: Partial<Record<string, Hyphenator | null>>
  /** PDF: the editor's current layout; used as-is for the whole book with footnotes. */
  layout?: ManuscriptLayout
  /** Font bytes by file name (default: fetched from `writing/fonts/`). */
  loadFont?: FontLoader
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  now?: Date
}

export type ExportResult = { bytes: Uint8Array; mime: string; fileName: string }

export const EXPORT_MIME: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  epub: 'application/epub+zip',
  md: 'text/markdown;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
}

const canvasAvailable = () => typeof document !== 'undefined' && (typeof OffscreenCanvas !== 'undefined' || typeof document.createElement === 'function')

/** The languages whose hyphenation patterns a layout needs. */
const languagesOf = (prepared: Prepared) => {
  const languages = new Set<StoryLanguage>([prepared.manifest.language])
  for (const block of prepared.flow) if (block.lang) languages.add(block.lang)
  return languages
}

/** Lays the prepared story out for the PDF (or reuses the editor's layout). */
export const exportLayout = async (prepared: Prepared, files: FontFiles, options: ExportOptions) => {
  const families = familiesInRuns(prepared.flow.flatMap((block) => block.runs), fontFilesOf(prepared.manifest))
  for (const note of prepared.footnotes.values()) familiesInRuns(note.runs, families)
  let measurer = options.measurer
  if (!measurer) {
    if (canvasAvailable()) {
      await loadWritingFonts()
      measurer = new CanvasMeasurer()
    } else {
      await files.preload(allFaces(families))
      measurer = new FontkitMeasurer(files)
    }
  }
  const notes = options.notes ?? 'footnotes'
  if (options.layout && (options.scope ?? 'book') === 'book' && notes === 'footnotes') return { layout: options.layout, measurer }
  let hyphenators = options.hyphenators
  if (!hyphenators && prepared.manifest.page.hyphenate) {
    const languages = [...languagesOf(prepared)]
    await Promise.all(languages.map((language) => loadHyphenator(language).catch(() => null)))
    hyphenators = Object.fromEntries(languages.map((language) => [language, hyphenatorFor(language)]))
  }
  const layout = layoutManuscript(prepared.manifest, prepared.flow, new LayoutCache(), {
    measurer,
    hyphenators,
    footnoteRuns: prepared.footnoteRuns,
    ...(notes === 'footnotes' ? {} : { endnotes: { placement: notes === 'endnotes-chapter' ? 'chapter' as const : 'book' as const, title: notesLabel(prepared.manifest.language) } }),
  })
  return { layout, measurer }
}

export const exportFileName = (prepared: Prepared, format: ExportFormat, scope: ExportScope) => {
  const chapter = scope === 'chapter' ? prepared.manifest.binder[0]?.title : ''
  return `${safeFileName(chapter ? `${prepared.manifest.title} - ${chapter}` : prepared.manifest.title)}.${format}`
}

export const exportStory = async (project: StorySource, format: ExportFormat, options: ExportOptions = {}): Promise<ExportResult> => {
  const scope = options.scope ?? 'book'
  const prepared = prepare(project, scope, options.chapterId)
  const check = () => { if (options.signal?.aborted) throw new ExportCancelled() }
  check()
  options.onProgress?.(0.02)
  const encode = (text: string) => new TextEncoder().encode(text)
  let bytes: Uint8Array
  if (format === 'pdf') {
    const files = new FontFiles(options.loadFont ?? fetchFont)
    const { layout, measurer } = await exportLayout(prepared, files, options)
    check()
    options.onProgress?.(0.1)
    const { writePdf } = await import('./pdf')
    bytes = await writePdf({ prepared, layout, files, measurer, sceneBookmarks: options.sceneBookmarks, signal: options.signal, now: options.now, onProgress: (value) => options.onProgress?.(0.1 + value * 0.9) })
  } else if (format === 'docx') {
    const { writeDocx } = await import('./docx')
    bytes = await writeDocx({ prepared, notes: options.notes, sceneTitles: options.sceneTitles, comments: options.comments, now: options.now })
  } else if (format === 'epub') {
    const { writeEpub } = await import('./epub')
    bytes = await writeEpub({ prepared, notes: options.notes, sceneTitles: options.sceneTitles, embedFonts: options.embedFonts, files: new FontFiles(options.loadFont ?? fetchFont), now: options.now })
  } else {
    const { writeMarkdown, writeText } = await import('./markdown')
    const input = { prepared, notes: options.notes, sceneTitles: options.sceneTitles }
    bytes = encode(format === 'md' ? writeMarkdown(input) : writeText(input))
  }
  check()
  options.onProgress?.(1)
  return { bytes, mime: EXPORT_MIME[format], fileName: exportFileName(prepared, format, scope) }
}
