/**
 * PDF note → PDF with the user's marks.
 *
 * The original file is loaded and kept as it is (its text stays selectable);
 * the highlights, underlines, ink strokes and text boxes are appended to each
 * page as vector operators in the page's own coordinates, through a matrix that
 * maps the sheet's paper pixels onto the page's crop box with the page turned
 * the way the note showed it. Blank side pages become extra pages after their
 * PDF page.
 */
import { PDFDocument } from 'pdf-lib'
import { unrotatePagePoint } from '../pdfSidePages'
import { spanIndexesForQuotes, type PdfTextMark } from '../pdfTextMarks'
import type { PaperStyle } from '../../types'
import { emitStroke, fmt, parseInkColor, rgbOperands, strokeBox, symbolStampLineWidth, type ExportInkStroke } from './inkGeometry'
import { paperOps } from './inkPdf'
import { PdfFontBook, type FontFace, type FontFileLoader } from './pdfFonts'
import { PageSurface } from './pdfSurface'
import { svgPathOperators } from './svgPath'
import { layoutMarkdown } from './textLayout'

export type PdfNoteBox = { page: number; side: boolean; left: number; top: number; width: number; height: number; rotation: number }

export type PdfNoteFieldMark = {
  id: string
  page: number
  left: number
  top: number
  width: number
  fontSize: number
  color?: string
  bold?: boolean
  text: string
}

/** What the ink board knows about a PDF note's marks, in paper px. */
export type PdfNoteMarksSnapshot = {
  paperWidth: number
  paperHeight: number
  strokes: readonly ExportInkStroke[]
  smoothing: number
  pages: readonly PdfNoteBox[]
  fields: readonly PdfNoteFieldMark[]
  /** Ruling of the side pages. */
  paperStyle?: PaperStyle
  squareMm?: number
}

/** One run of text as pdf.js reports it (`getTextContent` item). */
export type PdfTextItem = { str: string; transform: number[]; width: number; height: number }

export type PdfPageTextSource = (pageNumber: number) => Promise<PdfTextItem[]>

export type AnnotatedPdfInput = {
  original: Uint8Array
  snapshot: PdfNoteMarksSnapshot | null
  marks: readonly PdfTextMark[]
  pageText?: PdfPageTextSource
  loadFont: FontFileLoader
  /** Draw the ruling on side pages. */
  paperBackground?: boolean
  title?: string
}

const fmt3 = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

type Affine = [number, number, number, number, number, number]

const affineOf = (map: (x: number, y: number) => [number, number]): Affine => {
  const [e, f] = map(0, 0)
  const [x1, y1] = map(1, 0)
  const [x2, y2] = map(0, 1)
  return [x1 - e, y1 - f, x2 - e, y2 - f, e, f]
}

const affineText = (matrix: Affine) => matrix.map(fmt3).join(' ')

const hasInk = (snapshot: PdfNoteMarksSnapshot | null) => Boolean(snapshot && (snapshot.strokes.length || snapshot.fields.length))

/** Marked highlight colour of the text layer (`.pdf-anchored-mark`). */
const MARK_FILL: [number, number, number] = [1, 214 / 255, 90 / 255]
const MARK_LINE: [number, number, number] = [196 / 255, 138 / 255, 18 / 255]

export type AnnotatedPdfResult = {
  bytes: Uint8Array
  /** Output pages in order: the PDF page they come from, and whether it is a blank side page. */
  pages: Array<{ page: number; side: boolean }>
}

export const exportAnnotatedPdfNote = async (input: AnnotatedPdfInput): Promise<Uint8Array> => (await exportAnnotatedPdfNoteDetailed(input)).bytes

export const exportAnnotatedPdfNoteDetailed = async (input: AnnotatedPdfInput): Promise<AnnotatedPdfResult> => {
  const { snapshot, marks } = input
  const doc = await PDFDocument.load(input.original, { ignoreEncryption: true, updateMetadata: false })
  const pageCount = doc.getPageCount()
  const plain = () => Array.from({ length: pageCount }, (_unused, index) => ({ page: index + 1, side: false }))
  if (!marks.length && !hasInk(snapshot)) return { bytes: await doc.save(), pages: plain() }

  const fonts = new PdfFontBook(doc, input.loadFont)
  const fieldFaces = new Set<FontFace>()
  const fieldTexts = (snapshot?.fields ?? []).map((field) => field.text.replace(/[*_`~#>\\[\]()]/gu, ''))
  for (const field of snapshot?.fields ?? []) {
    if (field.bold || /\*\*|^\s{0,3}#/mu.test(field.text)) fieldFaces.add('bold')
    if (/(^|[^*_])[*_][^*_\s]/u.test(field.text)) fieldFaces.add('italic')
  }
  if (fieldTexts.length) await fonts.prepare(fieldTexts, 'sans', fieldFaces)
  const measure = (text: string, face: FontFace, mono: boolean, size: number) => fonts.width(text, mono ? 'mono' : 'sans', face, size)

  const boxes = new Map<number, PdfNoteBox>()
  const sideBoxes = new Map<number, PdfNoteBox>()
  for (const box of snapshot?.pages ?? []) (box.side ? sideBoxes : boxes).set(box.page, box)
  const strokeBoxes = (snapshot?.strokes ?? []).map((stroke) => (
    snapshot ? strokeBox(stroke, snapshot.paperWidth, snapshot.paperHeight) : null
  ))
  const pages = doc.getPages()

  /** Ink and text boxes onto a surface, through `matrix` (paper px -> page space). */
  const drawMarks = (surface: PageSurface, box: PdfNoteBox, matrix: Affine, clip: string, pageNumber: number) => {
    if (!snapshot) return
    const out: string[] = []
    let any = false
    const slack = 8
    snapshot.strokes.forEach((stroke, index) => {
      const bounds = strokeBoxes[index]
      if (!bounds || bounds.x1 < box.left - slack || bounds.x0 > box.left + box.width + slack || bounds.y1 < box.top - slack || bounds.y0 > box.top + box.height + slack) return
      if (!emitStroke(out, surface, stroke, snapshot.paperWidth, snapshot.paperHeight, snapshot.smoothing)) emitStamp(out, surface, stroke, snapshot.paperWidth, snapshot.paperHeight)
      any = true
    })
    if (any) surface.push(`q ${clip} W n`, `${affineText(matrix)} cm`, ...out, 'Q')
    for (const field of snapshot.fields) {
      if (field.page !== pageNumber || box.side) continue
      drawField(surface, field, matrix)
    }
  }

  const drawField = (surface: PageSurface, field: PdfNoteFieldMark, matrix: Affine) => {
    const padX = 0.4 * field.fontSize + 1
    const padY = 0.22 * field.fontSize + 1
    const laid = layoutMarkdown(field.text, Math.max(8, field.width - padX * 2), field.fontSize, measure, { bold: field.bold })
    const [a, b, c, d, e, f] = matrix
    const toPage = (x: number, y: number): [number, number] => [a * x + c * y + e, b * x + d * y + f]
    const color = rgbOperands(parseInkColor(field.color ?? '#20222b'))
    const scale = Math.hypot(a, b)
    const ops: string[] = []
    for (const line of laid.lines) {
      const baseline = field.top + padY + line.top + line.height * 0.5 + line.size * 0.32
      if (line.rule) {
        const y = field.top + padY + line.top + line.height / 2
        const [x0, y0] = toPage(field.left + padX, y)
        const [x1, y1] = toPage(field.left + field.width - padX, y)
        ops.push(`q 0.6 0.6 0.62 RG ${fmt3(0.6 * scale)} w ${fmt3(x0)} ${fmt3(y0)} m ${fmt3(x1)} ${fmt3(y1)} l S Q`)
        continue
      }
      for (const run of line.runs) {
        if (!run.text) continue
        let cursor = field.left + padX + run.x
        for (const piece of fonts.encode(run.text, run.mono ? 'mono' : 'sans', run.face)) {
          const [px, py] = toPage(cursor, baseline)
          ops.push(`BT ${color} rg /${surface.font(piece.entry.font)} ${fmt3(run.size)} Tf ${fmt3(a)} ${fmt3(b)} ${fmt3(-c)} ${fmt3(-d)} ${fmt3(px)} ${fmt3(py)} Tm ${piece.hex} Tj ET`)
          cursor += fonts.width(piece.text, run.mono ? 'mono' : 'sans', run.face, run.size)
        }
      }
    }
    surface.push(...ops)
  }

  // Side pages go in after their PDF page, last first so indexes stay put.
  const sideOrder = [...sideBoxes.keys()].filter((number) => number >= 1 && number <= pageCount).sort((x, y) => y - x)

  for (let index = 0; index < pageCount; index += 1) {
    const number = index + 1
    const page = pages[index]
    const crop = page.getCropBox()
    const surface = new PageSurface(doc, page)
    const box = boxes.get(number)
    const quarter = (((Math.round((box?.rotation ?? 0) / 90) % 4) + 4) % 4) * 90

    // Text marks first: they sit under the ink.
    const pageMarks = marks.filter((mark) => mark.page === number)
    if (pageMarks.length && input.pageText) {
      let items: PdfTextItem[] = []
      try {
        items = await input.pageText(number)
      } catch {
        items = []
      }
      const spanTexts = items.map((item) => item.str)
      for (const mark of pageMarks) {
        const hit = spanIndexesForQuotes(spanTexts, [{ quote: mark.quote, nth: mark.nth }])
        for (const at of hit) {
          const item = items[at]
          if (!item?.str.trim()) continue
          const [ta, tb, tc, td, te, tf] = item.transform
          const xl = Math.hypot(ta, tb) || 1
          const yl = Math.hypot(tc, td) || 1
          const height = item.height > 0 ? item.height : yl
          const ux = [ta / xl, tb / xl]
          const uy = [tc / yl, td / yl]
          const corner = (along: number, up: number) => `${fmt3(te + ux[0] * along + uy[0] * up)} ${fmt3(tf + ux[1] * along + uy[1] * up)}`
          if (mark.kind === 'underline') {
            surface.push(`q ${rgbOperands(MARK_LINE)} RG ${fmt3(Math.max(0.6, height * 0.07))} w ${corner(0, -height * 0.14)} m ${corner(item.width, -height * 0.14)} l S Q`)
          } else {
            surface.push(`q /${surface.gs(0.55, 'Multiply')} gs ${rgbOperands(MARK_FILL)} rg ${corner(0, -height * 0.22)} m ${corner(item.width, -height * 0.22)} l ${corner(item.width, height * 0.95)} l ${corner(0, height * 0.95)} l h f Q`)
          }
        }
      }
    }

    if (box && snapshot) {
      const map = (x: number, y: number): [number, number] => {
        const [u0, v0] = unrotatePagePoint((x - box.left) / box.width, (y - box.top) / box.height, quarter)
        return [crop.x + u0 * crop.width, crop.y + crop.height - v0 * crop.height]
      }
      const clip = `${fmt3(crop.x)} ${fmt3(crop.y)} ${fmt3(crop.width)} ${fmt3(crop.height)} re`
      drawMarks(surface, box, affineOf(map), clip, number)
    }
    await surface.finish({ wrapExisting: true })
  }

  const added = new Set<number>()
  if (snapshot) {
    for (const number of sideOrder) {
      const box = sideBoxes.get(number)!
      const source = pages[number - 1]
      const crop = source.getCropBox()
      const quarter = (((Math.round((boxes.get(number)?.rotation ?? box.rotation) / 90) % 4) + 4) % 4)
      const width = quarter % 2 === 1 ? crop.height : crop.width
      const height = quarter % 2 === 1 ? crop.width : crop.height
      const hasMarks = snapshot.strokes.some((_stroke, index) => {
        const bounds = strokeBoxes[index]
        return bounds && bounds.x1 >= box.left && bounds.x0 <= box.left + box.width && bounds.y1 >= box.top && bounds.y0 <= box.top + box.height
      })
      if (!hasMarks && !input.paperBackground) continue
      added.add(number)
      const page = doc.insertPage(number, [width, height])
      const surface = new PageSurface(doc, page)
      const k = width / box.width
      const matrix: Affine = [k, 0, 0, -k, -box.left * k, height + box.top * k]
      if (input.paperBackground && snapshot.paperStyle) {
        surface.push('q', `${fmt3(k)} 0 0 ${fmt3(-k)} 0 ${fmt3(height)} cm`, ...paperOps(surface, snapshot.paperStyle, snapshot.squareMm ?? 0, box.width, 0, box.height), 'Q')
      }
      drawMarks(surface, box, matrix, `0 0 ${fmt3(width)} ${fmt3(height)} re`, number)
      await surface.finish()
    }
  }

  if (input.title && !doc.getTitle()) doc.setTitle(input.title)
  const order: AnnotatedPdfResult['pages'] = []
  for (let number = 1; number <= pageCount; number += 1) {
    order.push({ page: number, side: false })
    if (added.has(number)) order.push({ page: number, side: true })
  }
  return { bytes: await doc.save({ useObjectStreams: true }), pages: order }
}

const emitStamp = (out: string[], surface: PageSurface, stroke: ExportInkStroke, width: number, height: number) => {
  const paths = stroke.symbolPaths
  const first = stroke.points[0]
  if (!paths?.length || !first) return
  const opacity = stroke.purpose === 'art' ? Math.max(0.08, Math.min(1, stroke.opacity ?? 1)) : 1
  const factor = stroke.baseWidth / 24
  const angle = ((stroke.symbolRotation ?? 0) * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  out.push(
    `q ${opacity < 0.999 ? `/${surface.gs(opacity)} gs ` : ''}${rgbOperands(parseInkColor(stroke.color))} RG 1 J 1 j`,
    `1 0 0 1 ${fmt(first.x * width)} ${fmt(first.y * height)} cm`,
    `${fmt3(cos)} ${fmt3(sin)} ${fmt3(-sin)} ${fmt3(cos)} 0 0 cm`,
    `${fmt3(factor)} 0 0 ${fmt3(factor)} 0 0 cm`,
    '1 0 0 1 -12 -12 cm',
    `${fmt3(symbolStampLineWidth(stroke))} w`,
  )
  for (const path of paths) out.push(svgPathOperators(path), 'S')
  out.push('Q')
}
