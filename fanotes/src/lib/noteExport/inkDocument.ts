/**
 * Renderer side of the handwriting export: reads the open sheet (ink model and
 * DOM), builds the vector PDF, and for DOCX renders its pages to pictures.
 * Runs while the sheet is open with every section expanded.
 */
import type { PaperStyle } from '../../types'
import type { NoteTextField } from '../noteTextField'
import type { ExportInkStroke } from './inkGeometry'
import { exportInkDocx } from './inkDocx'
import { exportInkPdfDetailed, type InkSheet } from './inkPdf'
import { renderPdfPagesToPng } from './pdfRaster'
import { rendererFontLoader } from './rendererFonts'
import { captureBodyText, captureImages, captureTextFields, paperZoom } from './sheetCapture'
import type { NoteExportOptions } from './types'

export type InkDocumentInput = {
  paper: HTMLElement
  title: string
  width: number
  height: number
  strokes: readonly ExportInkStroke[]
  fields: readonly NoteTextField[]
  smoothing: number
  paperStyle: PaperStyle
  squareMm: number
}

/** The sheet as plain data: ink, text boxes, typed text and pictures. */
export const captureInkSheet = async (input: InkDocumentInput): Promise<InkSheet> => {
  const zoom = paperZoom(input.paper)
  const textRoots = [
    ...input.paper.querySelectorAll('.cm-content'),
    ...input.paper.querySelectorAll('.lw-ink-section-titles'),
  ]
  const imageRoots = [...input.paper.querySelectorAll('.cm-content')]
  const fields = captureTextFields(input.paper, input.fields, zoom)
  return {
    title: input.title,
    width: input.width,
    height: input.height,
    strokes: input.strokes,
    smoothing: input.smoothing,
    paper: { style: input.paperStyle, squareMm: input.squareMm },
    fields,
    body: captureBodyText(input.paper, textRoots, zoom),
    images: await captureImages(input.paper, imageRoots, zoom),
  }
}

export const buildInkDocument = async (
  format: 'pdf' | 'docx',
  options: NoteExportOptions,
  input: InkDocumentInput,
): Promise<Uint8Array> => {
  const sheet = await captureInkSheet(input)
  if (format === 'pdf') return (await exportInkPdfDetailed(sheet, options, rendererFontLoader)).bytes
  // The Word pages carry no page numbers: Word numbers its own pages.
  const result = await exportInkPdfDetailed(sheet, { ...options, pageNumbers: false }, rendererFontLoader)
  const rendered = await renderPdfPagesToPng(result.bytes, 200)
  const byId = new Map(result.fields.map((field) => [field.id, field.text]))
  return exportInkDocx(
    rendered.map((page, index) => ({
      png: page.png,
      widthPt: page.widthPt,
      heightPt: page.heightPt,
      fields: (result.pages[index]?.fieldIds ?? []).map((id) => byId.get(id) ?? ''),
    })),
    options,
    input.title,
  )
}
