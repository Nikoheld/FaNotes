/**
 * Handwriting note → vector PDF.
 *
 * Strokes are stroked paths with the screen's geometry (inkGeometry.ts), text
 * boxes and typed text are real text in embedded subset fonts, pictures are
 * embedded as PNG/JPEG. The sheet is cut into pages of the chosen paper size;
 * a stroke that crosses a cut is drawn on both pages and clipped. Cuts prefer
 * the emptiest row near the page end, so they rarely meet ink at all.
 */
import { PDFDocument, type PDFImage } from 'pdf-lib'
import { paperSquareStyleMm } from '../paperSquare'
import type { PaperStyle } from '../../types'
import { emitStroke, fmt, parseInkColor, rgbOperands, strokeBox, symbolStampLineWidth, type ExportInkStroke, type StrokeBox } from './inkGeometry'
import { PdfFontBook, type FontFace, type FontFileLoader } from './pdfFonts'
import { PageSurface } from './pdfSurface'
import { svgPathOperators } from './svgPath'
import { layoutMarkdown, type LaidText } from './textLayout'
import { NOTE_EXPORT_MARGIN_POINTS, NOTE_EXPORT_PAGE_POINTS } from './pagePoints'
import type { NoteExportOptions } from './types'

/** A text box of the sheet. `left`/`top`/`width` are its outer box in sheet px. */
export type SheetField = {
  id: string
  left: number
  top: number
  width: number
  /** Font size in sheet px (already scaled for PDF pages). */
  fontSize: number
  color?: string
  bold?: boolean
  text: string
}

/** One line of the note's typed text, placed where the editor shows it. */
export type SheetText = {
  x: number
  baseline: number
  size: number
  text: string
  color?: string
  bold?: boolean
  italic?: boolean
  mono?: boolean
  /** Width the editor gave this text; the PDF text is scaled to it. */
  width?: number
}

export type SheetImage = {
  x: number
  y: number
  width: number
  height: number
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg'
}

export type InkSheet = {
  title: string
  /** Sheet size in CSS px. Stroke points are 0-1 of it. */
  width: number
  height: number
  strokes: readonly ExportInkStroke[]
  smoothing: number
  paper: { style: PaperStyle; squareMm: number }
  fields: readonly SheetField[]
  body?: readonly SheetText[]
  images?: readonly SheetImage[]
  /** Height of the note's own page in sheet px, when the note has pages. */
  pageHeightPx?: number
}

export type InkPagePlan = { index: number; y0: number; y1: number; fieldIds: string[] }

export type InkPdfResult = { bytes: Uint8Array; pages: InkPagePlan[]; fields: Array<{ id: string; text: string }> }

const FIELD_PAD_X = 0.4
const FIELD_PAD_Y = 0.22
const FIELD_BORDER = 1
const DEFAULT_FIELD_INK = '#20222b'
const TITLE_BAND_PT = 30

const stepForMm = (width: number, millimeters: number) => Math.max(2, Math.round(width * millimeters / 210))

/** Ruling as vector lines, same steps and colours as `drawPaperBackground`. */
export const paperOps = (
  surface: PageSurface,
  style: PaperStyle,
  squareMm: number,
  width: number,
  y0: number,
  y1: number,
): string[] => {
  if (style === 'blank') return []
  const out: string[] = []
  const scale = width / 900
  const lineWidth = Math.max(1, scale * 0.7)
  const lineSet = (rgb: readonly [number, number, number], alpha: number, body: string[], w = lineWidth) => {
    if (!body.length) return
    out.push(`q /${surface.gs(alpha)} gs ${rgbOperands(rgb)} RG ${fmt(w)} w`, ...body, 'S', 'Q')
  }
  const horizontals = (step: number, start = step, color: readonly [number, number, number] = [103 / 255, 116 / 255, 147 / 255], alpha = 0.145, w = lineWidth, offset = 0) => {
    const body: string[] = []
    const from = Math.max(start, Math.ceil((y0 - offset) / step) * step)
    for (let y = from; y < y1 + step; y += step) {
      if (y + offset < y0 - 1 || y + offset > y1 + 1) continue
      body.push(`0 ${fmt(y + offset)} m ${fmt(width)} ${fmt(y + offset)} l`)
    }
    lineSet(color, alpha, body, w)
  }
  const verticals = (step: number, start = step, color: readonly [number, number, number] = [103 / 255, 116 / 255, 147 / 255], alpha = 0.145, w = lineWidth, offset = 0) => {
    const body: string[] = []
    for (let x = start; x <= width + 0.5; x += step) body.push(`${fmt(x + offset)} ${fmt(y0)} m ${fmt(x + offset)} ${fmt(y1)} l`)
    lineSet(color, alpha, body, w)
  }
  if (style === 'dots') {
    const step = stepForMm(width, 7.5)
    const radius = Math.max(0.8, scale * 1.05)
    const body: string[] = []
    for (let y = Math.max(step, Math.ceil(y0 / step) * step); y < y1 + radius; y += step) {
      for (let x = step; x < width; x += step) body.push(`${fmt(x)} ${fmt(y)} m ${fmt(x)} ${fmt(y)} l`)
    }
    if (body.length) out.push(`q /${surface.gs(0.28)} gs ${rgbOperands([92 / 255, 107 / 255, 142 / 255])} RG ${fmt(radius * 2)} w 1 J`, ...body, 'S', 'Q')
  } else if (style === 'squares') {
    const step = stepForMm(width, paperSquareStyleMm(style, squareMm) ?? 5)
    const color: [number, number, number] = [92 / 255, 118 / 255, 168 / 255]
    verticals(step, 0, color, 0.22, lineWidth, 0.5)
    horizontals(step, 0, color, 0.22, lineWidth, 0.5)
  } else if (style === 'grid') {
    const step = stepForMm(width, paperSquareStyleMm(style, squareMm) ?? 7.5)
    verticals(step)
    horizontals(step)
  } else if (style === 'lines') {
    const step = stepForMm(width, 7.5)
    horizontals(step)
    lineSet([210 / 255, 82 / 255, 105 / 255], 0.16, [`${fmt(step * 1.65)} ${fmt(y0)} m ${fmt(step * 1.65)} ${fmt(y1)} l`])
  } else if (style === 'millimeter') {
    const minor = stepForMm(width, 1)
    const major = stepForMm(width, 5)
    verticals(minor, minor, [92 / 255, 118 / 255, 168 / 255], 0.1)
    horizontals(minor, minor, [92 / 255, 118 / 255, 168 / 255], 0.1)
    verticals(major, major, [72 / 255, 98 / 255, 148 / 255], 0.22)
    horizontals(major, major, [72 / 255, 98 / 255, 148 / 255], 0.22)
  }
  return out
}

type Face = FontFace

const faceOfStyle = (bold?: boolean, italic?: boolean): Face => (bold ? (italic ? 'boldItalic' : 'bold') : italic ? 'italic' : 'regular')

/** Faces a Markdown text may need, found without parsing it. */
const facesFor = (text: string, bold?: boolean): FontFace[] => {
  const faces: FontFace[] = []
  const hasBold = bold || /\*\*|__|^\s{0,3}#{1,6}\s/mu.test(text)
  const hasItalic = /(^|[^*_])[*_][^*_\s]/u.test(text) || /\*\*\*|___/u.test(text)
  if (hasBold) faces.push('bold')
  if (hasItalic) faces.push('italic')
  if (hasBold && hasItalic) faces.push('boldItalic')
  return faces
}

type PlacedFieldText = {
  field: SheetField
  laid: LaidText
  contentLeft: number
  contentTop: number
  /** Bottom of the outer box. */
  bottom: number
}

type Extent = { top: number; bottom: number }

/** Page plan: cut positions in sheet px. */
export const planInkPages = (
  extents: { height: number; rows: Int32Array; usedBottom: number },
  firstCap: number,
  cap: number,
  ownPages: boolean,
): Array<{ y0: number; y1: number }> => {
  const pages: Array<{ y0: number; y1: number }> = []
  let y0 = 0
  const limit = Math.max(1, Math.ceil(extents.usedBottom))
  while (pages.length < 500) {
    const capacity = pages.length === 0 ? firstCap : cap
    if (y0 + capacity >= limit - 0.5) {
      pages.push({ y0, y1: Math.max(y0 + 1, Math.min(limit, y0 + capacity)) })
      break
    }
    let cut = Math.floor(y0 + capacity)
    if (!ownPages) {
      // The emptiest row in the last quarter of the page; the lowest one on a tie.
      const floor = Math.max(y0 + 1, Math.floor(y0 + capacity * 0.75))
      let best = cut
      let bestCount = extents.rows[Math.min(cut, extents.rows.length - 1)] ?? 0
      for (let row = cut; row >= floor && bestCount > 0; row -= 1) {
        const count = extents.rows[Math.min(row, extents.rows.length - 1)] ?? 0
        if (count < bestCount) {
          best = row
          bestCount = count
        }
      }
      cut = best
    }
    pages.push({ y0, y1: cut })
    y0 = cut
  }
  return pages
}

export const exportInkPdf = async (
  sheet: InkSheet,
  options: NoteExportOptions,
  loadFont: FontFileLoader,
): Promise<Uint8Array> => (await exportInkPdfDetailed(sheet, options, loadFont)).bytes

export const exportInkPdfDetailed = async (
  sheet: InkSheet,
  options: NoteExportOptions,
  loadFont: FontFileLoader,
): Promise<InkPdfResult> => {
  const paper = NOTE_EXPORT_PAGE_POINTS[options.pageSize === 'letter' ? 'letter' : 'a4']
  const margin = NOTE_EXPORT_MARGIN_POINTS[options.margins] ?? NOTE_EXPORT_MARGIN_POINTS.normal
  const sheetWidth = Math.max(1, sheet.width)
  const sheetHeight = Math.max(1, sheet.height)
  const contentWidthPt = paper.width - margin * 2
  const scale = contentWidthPt / sheetWidth
  const bottomMargin = options.pageNumbers ? Math.max(margin, 34) : margin
  const bandPt = options.includeTitle && sheet.title.trim() ? TITLE_BAND_PT : 0
  const capPx = (paper.height - margin - bottomMargin) / scale
  const firstCapPx = (paper.height - margin - bottomMargin - bandPt) / scale
  const ownPageHeight = sheet.pageHeightPx && sheet.pageHeightPx > 20 ? sheet.pageHeightPx : 0

  const doc = await PDFDocument.create()
  doc.setTitle(sheet.title || 'FaNotes', { showInWindowTitleBar: true })
  doc.setProducer('FaNotes')
  doc.setCreator('FaNotes')
  doc.setCreationDate(new Date())
  const fonts = new PdfFontBook(doc, loadFont)

  // Fonts first: text layout needs measurements.
  const faceSet = new Set<FontFace>()
  const monoSet = new Set<FontFace>()
  const sansTexts: string[] = []
  const monoTexts: string[] = []
  if (bandPt) {
    faceSet.add('bold')
    sansTexts.push(sheet.title)
  }
  if (options.pageNumbers) sansTexts.push('0123456789')
  for (const field of sheet.fields) {
    for (const face of facesFor(field.text, field.bold)) faceSet.add(face)
    sansTexts.push(field.text.replace(/[*_`~#>\\[\]()]/gu, ''))
    if (/`/u.test(field.text)) {
      monoTexts.push(field.text)
      monoSet.add('regular')
      if (/\*\*|^\s{0,3}#/mu.test(field.text)) monoSet.add('bold')
    }
  }
  for (const text of sheet.body ?? []) {
    if (text.bold) faceSet.add('bold')
    if (text.italic) faceSet.add('italic')
    if (text.bold && text.italic) faceSet.add('boldItalic')
    ;(text.mono ? monoTexts : sansTexts).push(text.text)
    if (text.mono) monoSet.add(faceOfStyle(text.bold, text.italic))
  }
  await fonts.prepare(sansTexts, 'sans', faceSet)
  if (monoTexts.length) await fonts.prepare(monoTexts, 'mono', monoSet)

  const measure = (text: string, face: FontFace, mono: boolean, size: number) => fonts.width(text, mono ? 'mono' : 'sans', face, size)

  // Layout the text boxes (sheet px).
  const placed: PlacedFieldText[] = sheet.fields.map((field) => {
    const padX = FIELD_PAD_X * field.fontSize + FIELD_BORDER
    const padY = FIELD_PAD_Y * field.fontSize + FIELD_BORDER
    const laid = layoutMarkdown(field.text, Math.max(8, field.width - padX * 2), field.fontSize, measure, { bold: field.bold })
    return {
      field,
      laid,
      contentLeft: field.left + padX,
      contentTop: field.top + padY,
      bottom: field.top + padY * 2 + laid.height,
    }
  })

  // Rows with ink, text or pictures: where a page cut would hurt.
  const boxes: Array<StrokeBox | null> = sheet.strokes.map((stroke) => strokeBox(stroke, sheetWidth, sheetHeight))
  let usedBottom = 0
  const extentOf = (box: StrokeBox | null): Extent | null => (box ? { top: box.y0, bottom: box.y1 } : null)
  const extents: Extent[] = []
  for (const box of boxes) {
    const extent = extentOf(box)
    if (extent) extents.push(extent)
  }
  for (const item of placed) extents.push({ top: item.field.top, bottom: item.bottom })
  for (const text of sheet.body ?? []) extents.push({ top: text.baseline - text.size, bottom: text.baseline + text.size * 0.35 })
  for (const image of sheet.images ?? []) extents.push({ top: image.y, bottom: image.y + image.height })
  for (const extent of extents) usedBottom = Math.max(usedBottom, extent.bottom)
  usedBottom = Math.max(1, usedBottom + 16)
  const rowCount = Math.ceil(usedBottom) + 2
  const delta = new Int32Array(rowCount + 2)
  const addRange = (top: number, bottom: number) => {
    const a = Math.max(0, Math.floor(top))
    const b = Math.min(rowCount, Math.ceil(bottom))
    if (b < a) return
    delta[a] += 1
    delta[b + 1] -= 1
  }
  sheet.strokes.forEach((stroke, strokeIndex) => {
    const box = boxes[strokeIndex]
    if (!box) return
    const reach = Math.max(0.5, stroke.baseWidth)
    const points = stroke.points
    if (points.length === 1) {
      addRange(box.y0, box.y1)
      return
    }
    for (let index = 1; index < points.length; index += 1) {
      const ya = points[index - 1].y * sheetHeight
      const yb = points[index].y * sheetHeight
      addRange(Math.min(ya, yb) - reach * 0.6, Math.max(ya, yb) + reach * 0.6)
    }
  })
  for (const item of placed) addRange(item.field.top, item.bottom)
  for (const text of sheet.body ?? []) addRange(text.baseline - text.size * 0.9, text.baseline + text.size * 0.3)
  for (const image of sheet.images ?? []) addRange(image.y, image.y + image.height)
  const rows = new Int32Array(rowCount)
  let running = 0
  for (let row = 0; row < rowCount; row += 1) {
    running += delta[row]
    rows[row] = running
  }

  const pageCap = ownPageHeight || capPx
  const pageSlices = planInkPages(
    { height: sheetHeight, rows, usedBottom },
    ownPageHeight || firstCapPx,
    pageCap,
    Boolean(ownPageHeight),
  )

  // Pictures once per document.
  const embedded = new Map<SheetImage, PDFImage>()
  for (const image of sheet.images ?? []) {
    try {
      embedded.set(image, image.mime === 'image/jpeg' ? await doc.embedJpg(image.bytes) : await doc.embedPng(image.bytes))
    } catch {
      // A picture pdf-lib cannot read is left out; the rest of the sheet still exports.
    }
  }

  const plans: InkPagePlan[] = []
  const pageCount = pageSlices.length
  const bgFill = options.paperBackground ? [0xfb / 255, 0xfc / 255, 0xff / 255] as const : null

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const { y0, y1 } = pageSlices[pageIndex]
    const page = doc.addPage([paper.width, paper.height])
    const surface = new PageSurface(doc, page)
    const topPt = margin + (pageIndex === 0 ? bandPt : 0)
    const sliceHeightPt = (y1 - y0) * scale
    const clipBottomPt = paper.height - topPt - sliceHeightPt
    const fieldIds: string[] = []

    if (bgFill) surface.push(`q ${rgbOperands(bgFill)} rg 0 0 ${fmt(paper.width)} ${fmt(paper.height)} re f Q`)

    // y-down sheet space: sheet px (x, y) -> page pt (margin + x*s, paper.height - topPt - (y - y0)*s).
    const matrix = `${fmt3(scale)} 0 0 ${fmt3(-scale)} ${fmt3(margin)} ${fmt3(paper.height - topPt + y0 * scale)} cm`
    surface.push(`q ${fmt(margin)} ${fmt(clipBottomPt)} ${fmt(contentWidthPt)} ${fmt(sliceHeightPt)} re W n`, matrix)
    if (options.paperBackground) surface.push(...paperOps(surface, sheet.paper.style, sheet.paper.squareMm, sheetWidth, y0, y1))

    // Pictures sit under the ink, like the editor's picture layer.
    for (const image of sheet.images ?? []) {
      const embeddedImage = embedded.get(image)
      if (!embeddedImage || image.y + image.height < y0 || image.y > y1) continue
      const name = surface.image(embeddedImage)
      // Flip back: images are drawn upright in the y-down space.
      surface.push(`q ${fmt(image.width)} 0 0 ${fmt(-image.height)} ${fmt(image.x)} ${fmt(image.y + image.height)} cm /${name} Do Q`)
    }

    // Ink.
    const out: string[] = []
    let drawn = 0
    for (let index = 0; index < sheet.strokes.length; index += 1) {
      const box = boxes[index]
      if (!box || box.y1 < y0 || box.y0 > y1) continue
      const stroke = sheet.strokes[index]
      if (!emitStroke(out, surface, stroke, sheetWidth, sheetHeight, sheet.smoothing)) emitSymbol(out, surface, stroke, sheetWidth, sheetHeight)
      drawn += 1
    }
    if (drawn) surface.push(...out)
    surface.push('Q')

    // Text: each line belongs to the page its baseline is on, and is not clipped.
    const textOps: string[] = []
    const putText = (text: string, face: Face, mono: boolean, sizePx: number, xPx: number, baselinePx: number, color: string, widthPx?: number, strike = false) => {
      const family = mono ? 'mono' : 'sans'
      const pieces = fonts.encode(text, family, face)
      if (!pieces.length) return
      let x = margin + xPx * scale
      const yPt = paper.height - topPt - (baselinePx - y0) * scale
      const sizePt = sizePx * scale
      const natural = fonts.width(text, family, face, sizePx)
      const stretch = widthPx && natural > 0 ? Math.max(0.8, Math.min(1.25, widthPx / natural)) : 1
      textOps.push(`BT ${rgbOperands(parseInkColor(color))} rg`)
      for (const piece of pieces) {
        const pieceWidth = fonts.width(piece.text, family, face, sizePx) * scale * stretch
        textOps.push(`/${surface.font(piece.entry.font)} ${fmt3(sizePt)} Tf ${fmt3(stretch * 100)} Tz 1 0 0 1 ${fmt3(x)} ${fmt3(yPt)} Tm ${piece.hex} Tj`)
        x += pieceWidth
      }
      textOps.push('ET')
      if (strike) {
        const startX = margin + xPx * scale
        textOps.push(`q ${rgbOperands(parseInkColor(color))} RG ${fmt3(Math.max(0.4, sizePt * 0.05))} w ${fmt3(startX)} ${fmt3(yPt + sizePt * 0.3)} m ${fmt3(x)} ${fmt3(yPt + sizePt * 0.3)} l S Q`)
      }
    }
    for (const item of placed) {
      const { field, laid } = item
      let onPage = false
      for (const line of laid.lines) {
        const lineTop = item.contentTop + line.top
        // Baseline: the line box's top plus the half-leading and the ascent of the text.
        const baseline = lineTop + line.height * 0.5 + line.size * 0.32
        if (baseline < y0 || baseline >= y1) continue
        onPage = true
        if (line.rule) {
          textOps.push(`q ${rgbOperands([0.6, 0.6, 0.62])} RG 0.6 w ${fmt3(margin + item.contentLeft * scale)} ${fmt3(paper.height - topPt - (lineTop + line.height / 2 - y0) * scale)} m ${fmt3(margin + (item.field.left + field.width - FIELD_PAD_X * field.fontSize) * scale)} ${fmt3(paper.height - topPt - (lineTop + line.height / 2 - y0) * scale)} l S Q`)
          continue
        }
        if (line.quote) {
          const barX = margin + (item.contentLeft + field.fontSize * 0.25) * scale
          textOps.push(`q ${rgbOperands([0.62, 0.64, 0.7])} RG 1.2 w ${fmt3(barX)} ${fmt3(paper.height - topPt - (lineTop - y0) * scale)} m ${fmt3(barX)} ${fmt3(paper.height - topPt - (lineTop + line.height - y0) * scale)} l S Q`)
        }
        for (const run of line.runs) {
          if (!run.text) continue
          putText(run.text, run.face, run.mono, run.size, item.contentLeft + run.x, baseline, field.color ?? DEFAULT_FIELD_INK, run.width, run.strike)
        }
      }
      if (onPage || (laid.lines.length === 0 && item.field.top >= y0 && item.field.top < y1)) fieldIds.push(field.id)
    }
    for (const text of sheet.body ?? []) {
      if (text.baseline < y0 || text.baseline >= y1) continue
      putText(text.text, faceOfStyle(text.bold, text.italic), Boolean(text.mono), text.size, text.x, text.baseline, text.color ?? DEFAULT_FIELD_INK, text.width)
    }
    surface.push(...textOps)

    // Title and page number sit in the margins.
    if (pageIndex === 0 && bandPt) {
      const pieces = fonts.encode(sheet.title.trim(), 'sans', 'bold')
      let x = margin
      const baseline = paper.height - margin - 16
      surface.push(`BT ${rgbOperands([0.12, 0.13, 0.18])} rg`)
      for (const piece of pieces) {
        surface.push(`/${surface.font(piece.entry.font)} 16 Tf 100 Tz 1 0 0 1 ${fmt3(x)} ${fmt3(baseline)} Tm ${piece.hex} Tj`)
        x += fonts.width(piece.text, 'sans', 'bold', 16)
      }
      surface.push('ET')
    }
    if (options.pageNumbers) {
      const label = String(pageIndex + 1)
      const width = fonts.width(label, 'sans', 'regular', 9)
      const pieces = fonts.encode(label, 'sans', 'regular')
      let x = (paper.width - width) / 2
      const baseline = Math.min(margin, bottomMargin) * 0.5
      surface.push(`BT ${rgbOperands([0.4, 0.42, 0.48])} rg`)
      for (const piece of pieces) {
        surface.push(`/${surface.font(piece.entry.font)} 9 Tf 100 Tz 1 0 0 1 ${fmt3(x)} ${fmt3(baseline)} Tm ${piece.hex} Tj`)
        x += fonts.width(piece.text, 'sans', 'regular', 9)
      }
      surface.push('ET')
    }
    await surface.finish()
    plans.push({ index: pageIndex, y0, y1, fieldIds })
  }

  const bytes = await doc.save({ useObjectStreams: true })
  return { bytes, pages: plans, fields: sheet.fields.map((field) => ({ id: field.id, text: field.text })) }
}

const fmt3 = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

/** A symbol or figure stamp (24 x 24 icon space, scaled by the pen width, turned around its centre). */
const emitSymbol = (out: string[], surface: PageSurface, stroke: ExportInkStroke, width: number, height: number) => {
  const paths = stroke.symbolPaths
  const first = stroke.points[0]
  if (!paths?.length || !first) return
  const opacity = stroke.purpose === 'art' ? Math.max(0.08, Math.min(1, stroke.opacity ?? 1)) : 1
  const factor = stroke.baseWidth / 24
  const angle = ((stroke.symbolRotation ?? 0) * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const color = rgbOperands(parseInkColor(stroke.color))
  out.push(
    `q ${opacity < 0.999 ? `/${surface.gs(opacity)} gs ` : ''}${color} RG 1 J 1 j`,
    `1 0 0 1 ${fmt(first.x * width)} ${fmt(first.y * height)} cm`,
    `${fmt3(cos)} ${fmt3(sin)} ${fmt3(-sin)} ${fmt3(cos)} 0 0 cm`,
    `${fmt3(factor)} 0 0 ${fmt3(factor)} 0 0 cm`,
    '1 0 0 1 -12 -12 cm',
    `${fmt3(symbolStampLineWidth(stroke))} w`,
  )
  for (const path of paths) out.push(svgPathOperators(path), 'S')
  out.push('Q')
}
