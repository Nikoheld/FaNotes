/**
 * Entry points for the export dialog: handwriting notes and PDF notes as PDF or DOCX.
 * `board` is the open DrawingBoard handle of the note.
 */
import type { DrawingBoardHandle } from '../../components/DrawingBoard'
import { loadVaultPdfBytes } from '../pdfDocument'
import { readPdfMarks } from '../pdfTextMarks'
import { exportInkDocx } from './inkDocx'
import { exportAnnotatedPdfNoteDetailed, type PdfNoteMarksSnapshot } from './pdfNote'
import { openPdfTextSource, renderPdfPagesToPng } from './pdfRaster'
import { rendererFontLoader } from './rendererFonts'
import type { NoteExportOptions } from './types'

export type NonTextNoteContext = {
  board: Pick<DrawingBoardHandle, 'exportInkDocument' | 'exportPdfNoteMarks'> | null
  /** Vault path of the PDF (PDF notes). */
  pdfPath?: string
  /** The note's markdown (carries the PDF text marks). */
  note: string
  title: string
}

const copyBytes = (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

export const exportPdfNoteBytes = async (
  format: 'pdf' | 'docx',
  options: NoteExportOptions,
  context: NonTextNoteContext,
): Promise<Uint8Array> => {
  if (!context.pdfPath) throw new Error('PDF-Export fehlgeschlagen.')
  const original = await loadVaultPdfBytes(context.pdfPath)
  if (options.annotations === false && format === 'pdf') return copyBytes(original)
  const annotate = options.annotations !== false
  const snapshot: PdfNoteMarksSnapshot | null = annotate ? await context.board?.exportPdfNoteMarks() ?? null : null
  const marks = annotate ? readPdfMarks(context.note) : []
  const text = annotate && marks.length ? await openPdfTextSource(original) : null
  let result
  try {
    result = await exportAnnotatedPdfNoteDetailed({
      original: copyBytes(original),
      snapshot,
      marks,
      pageText: text?.source,
      loadFont: rendererFontLoader,
      paperBackground: options.paperBackground,
      title: context.title,
    })
  } finally {
    await text?.close()
  }
  if (format === 'pdf') return result.bytes
  const rendered = await renderPdfPagesToPng(result.bytes, 200)
  return exportInkDocx(
    rendered.map((page, index) => {
      const source = result.pages[index]
      const fields = source && !source.side && snapshot ? snapshot.fields.filter((field) => field.page === source.page).map((field) => field.text) : []
      return { png: page.png, widthPt: page.widthPt, heightPt: page.heightPt, fields }
    }),
    options,
    context.title,
  )
}

/** Handwriting note or PDF note as PDF or DOCX bytes. */
export const exportNonTextNoteBytes = async (
  kind: 'ink' | 'pdf',
  format: 'pdf' | 'docx',
  options: NoteExportOptions,
  context: NonTextNoteContext,
): Promise<Uint8Array> => {
  if (kind === 'pdf') return exportPdfNoteBytes(format, options, context)
  const bytes = await context.board?.exportInkDocument(format, options, context.title)
  if (!bytes) throw new Error(format === 'docx' ? 'DOCX-Export fehlgeschlagen.' : 'PDF-Export fehlgeschlagen.')
  return bytes
}

