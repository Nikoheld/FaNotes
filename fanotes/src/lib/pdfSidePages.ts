/**
 * Blank writing pages beside the pages of a PDF note ("Leere Seiten daneben").
 *
 * Storage. The side pages live in their own companion,
 * `.fanotes/pdf-side/<pdf path>.famd`, an ordinary famd v1 file whose payload
 * `ink` holds one entry per PDF page that has side ink:
 *
 *   { schemaVersion: 1, kind: 'fanotes-pdf-side-pages', pdf, updatedAt,
 *     ink: [{ page, width, height, ink: <drawing document> }] }
 *
 * `page` is the 1-based PDF page, `width`/`height` that page's box in PDF
 * points (unrotated view), and `ink` a normal drawing document whose strokes
 * are 0–1 of that page. A page without ink has no entry, and a PDF without
 * side ink has no file.
 *
 * Why not a key in the PDF's own `<stem>.famd`: every released desktop build
 * and the Android app keep only the payload keys they know, and rewrite the
 * companion on page statistics, PDF marks and text saves, so a new key would
 * be dropped by an older version just by opening the note. A separate file
 * under `.fanotes/` is never shown or rewritten by them, and sync carries it
 * like any other `.fanotes/` metadata.
 *
 * The entry list is named `ink` on purpose: every version's blank-note check
 * (desktop `inkHasMarks`, Android `inkHasMarks`) walks `ink`, `strokes` and
 * `sections`, so the file counts as holding marks everywhere.
 *
 * Board frame. While side pages are shown, one ink board covers the PDF pages
 * and the side pages. Its strokes are in paper pixels: a point is
 * (x * sourceWidth, y * sourceHeight) from the paper's top left, and the PDF
 * column sits centred in `max(scroller width, sourceWidth)`. Opening merges
 * the PDF's own ink (moved by the column's shift) and every side page's ink
 * into that frame; each save splits it back.
 */
import { FAMD_SCHEMA, parseFamd, serializeFamd } from './famd'

export const PDF_SIDE_PAGES_KIND = 'fanotes-pdf-side-pages'
export const PDF_SIDE_PAGES_DIRECTORY = '.fanotes/pdf-side'
/** Gap between a PDF page and its side page; the same as the gap between pages. */
export const PDF_SIDE_PAGE_GAP_PX = 16

type JsonRecord = Record<string, unknown>
type RawStroke = JsonRecord & { points?: Array<JsonRecord & { x?: unknown; y?: unknown }> }

export type PdfSidePageSize = { width: number; height: number }

export type PdfSidePageEntry = {
  page: number
  width: number
  height: number
  ink: JsonRecord & { strokes: RawStroke[]; sourceWidth: number; sourceHeight: number }
}

export type PdfSidePagesStore = {
  schemaVersion: 1
  kind: typeof PDF_SIDE_PAGES_KIND
  pdf: string
  updatedAt: string
  ink: PdfSidePageEntry[]
}

/** A box in paper layout pixels. */
export type PaperBox = { left: number; top: number; width: number; height: number }

/**
 * The live side-by-side layout, in paper layout pixels (camera zoom does not
 * change it). `pdfColumnLeft` and `pdfColumnWidth` are the PDF page column;
 * `scrollerWidth` is the paper width a PDF without side pages gets.
 */
export type PdfSideLayout = {
  paperWidth: number
  paperHeight: number
  scrollerWidth: number
  pdfColumnLeft: number
  pdfColumnWidth: number
  /** View rotation of the pages (the toolbar's "Drehen"), 0/90/180/270. */
  rotation: number
  /** Side page boxes, index = page - 1. */
  pages: PaperBox[]
  /** Each PDF page's box in points at rotation 0. */
  sizes: PdfSidePageSize[]
}

const finite = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** `Bio/Zelle.pdf` → `.fanotes/pdf-side/Bio/Zelle.pdf.famd`. */
export const pdfSidePagesPath = (pdfPath: string) => {
  const clean = pdfPath.replace(/\\/gu, '/').replace(/^\/+/u, '')
  return `${PDF_SIDE_PAGES_DIRECTORY}/${clean}.famd`
}

export const emptyPdfSidePagesStore = (pdf: string, updatedAt = new Date().toISOString()): PdfSidePagesStore => ({
  schemaVersion: 1,
  kind: PDF_SIDE_PAGES_KIND,
  pdf,
  updatedAt,
  ink: [],
})

const sanitizeEntry = (value: unknown): PdfSidePageEntry | null => {
  if (!isRecord(value)) return null
  const page = value.page
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 100_000) return null
  const width = finite(value.width)
  const height = finite(value.height)
  if (!(width > 0) || !(height > 0)) return null
  const ink = value.ink
  if (!isRecord(ink) || !Array.isArray(ink.strokes)) return null
  const sourceWidth = finite(ink.sourceWidth)
  const sourceHeight = finite(ink.sourceHeight)
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null
  const strokes = ink.strokes.filter((stroke): stroke is RawStroke => isRecord(stroke) && Array.isArray(stroke.points))
  return { page, width, height, ink: { ...ink, strokes, sourceWidth, sourceHeight } }
}

/** The side pages stored in a companion's text. Null when the text is not a side-page companion. */
export const parsePdfSidePages = (source: string | null | undefined): PdfSidePagesStore | null => {
  if (typeof source !== 'string' || !source) return null
  const { payload } = parseFamd(source)
  const store = payload?.ink
  if (!isRecord(store) || store.kind !== PDF_SIDE_PAGES_KIND) return null
  const entries = Array.isArray(store.ink) ? store.ink.map(sanitizeEntry).filter((entry): entry is PdfSidePageEntry => entry !== null) : []
  const byPage = new Map<number, PdfSidePageEntry>()
  for (const entry of entries) byPage.set(entry.page, entry)
  return {
    schemaVersion: 1,
    kind: PDF_SIDE_PAGES_KIND,
    pdf: typeof store.pdf === 'string' ? store.pdf : '',
    updatedAt: typeof store.updatedAt === 'string' ? store.updatedAt : new Date(0).toISOString(),
    ink: [...byPage.values()].sort((left, right) => left.page - right.page),
  }
}

export const serializePdfSidePages = (store: PdfSidePagesStore) => serializeFamd('', {
  schema: FAMD_SCHEMA,
  updatedAt: store.updatedAt,
  ink: {
    schemaVersion: 1,
    kind: PDF_SIDE_PAGES_KIND,
    pdf: store.pdf,
    updatedAt: store.updatedAt,
    ink: store.ink.filter((entry) => entry.ink.strokes.length > 0),
  },
  worksheets: [],
}, 'v1')

export const pdfSidePagesHaveInk = (store: PdfSidePagesStore | null | undefined) => (
  Boolean(store?.ink.some((entry) => entry.ink.strokes.some((stroke) => (stroke.points?.length ?? 0) > 0)))
)

// ---- rotation ---------------------------------------------------------------

const quarterTurns = (rotation: number) => ((Math.round(rotation / 90) % 4) + 4) % 4

/** Page-local point stored at rotation 0 → the same point on the page shown at `rotation` (clockwise). */
export const rotatePagePoint = (u: number, v: number, rotation: number): [number, number] => {
  switch (quarterTurns(rotation)) {
    case 1: return [1 - v, u]
    case 2: return [1 - u, 1 - v]
    case 3: return [v, 1 - u]
    default: return [u, v]
  }
}

/** Inverse of `rotatePagePoint`. */
export const unrotatePagePoint = (u: number, v: number, rotation: number): [number, number] => {
  switch (quarterTurns(rotation)) {
    case 1: return [v, 1 - u]
    case 2: return [1 - u, 1 - v]
    case 3: return [1 - v, u]
    default: return [u, v]
  }
}

/** Box ratio (height / width) of a page shown at `rotation`. */
export const pdfSidePageRatio = (size: PdfSidePageSize, rotation: number) => (
  quarterTurns(rotation) % 2 === 1 ? size.width / Math.max(1e-6, size.height) : size.height / Math.max(1e-6, size.width)
)

// ---- frame transforms -------------------------------------------------------

const mapPoints = (stroke: RawStroke, map: (x: number, y: number) => [number, number]): RawStroke => ({
  ...stroke,
  points: (stroke.points ?? []).map((point) => {
    const [x, y] = map(finite(point.x), finite(point.y))
    return { ...point, x, y }
  }),
})

const scaleWidths = (stroke: RawStroke, factor: number): RawStroke => {
  if (!(factor > 0) || Math.abs(factor - 1) < 1e-9) return stroke
  const next: RawStroke = { ...stroke }
  if (typeof stroke.baseWidth === 'number') next.baseWidth = stroke.baseWidth * factor
  if (typeof stroke.figureLineWidth === 'number') next.figureLineWidth = stroke.figureLineWidth * factor
  return next
}

/** Centre of a stroke's points in paper pixels. */
const strokeCentre = (stroke: RawStroke, sourceWidth: number, sourceHeight: number) => {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const point of stroke.points ?? []) {
    const x = finite(point.x) * sourceWidth
    const y = finite(point.y) * sourceHeight
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) return null
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

/** Side page whose row holds paper-pixel y (nearest row when y falls in a gap). */
const sidePageAt = (layout: PdfSideLayout, y: number) => {
  let best = -1
  let bestDistance = Infinity
  layout.pages.forEach((box, index) => {
    const distance = y < box.top ? box.top - y : y > box.top + box.height ? y - box.top - box.height : 0
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  })
  return best
}

/** Left edge of the PDF column on a paper of the given width without side pages. */
const plainColumnLeft = (paperWidth: number, columnWidth: number) => Math.max(0, (paperWidth - columnWidth) / 2)

type History = { extras: unknown[]; undo: unknown[][]; redo: unknown[][] }

const readHistory = (value: unknown): History | null => {
  if (!isRecord(value) || !Array.isArray(value.extras) || !Array.isArray(value.undo) || !Array.isArray(value.redo)) return null
  if (!value.undo.every(Array.isArray) || !value.redo.every(Array.isArray)) return null
  return { extras: value.extras, undo: value.undo as unknown[][], redo: value.redo as unknown[][] }
}

const refOf = (value: unknown): { live: number } | { extra: number } | null => {
  if (!isRecord(value)) return null
  if (typeof value.live === 'number' && Number.isInteger(value.live)) return { live: value.live }
  if (typeof value.extra === 'number' && Number.isInteger(value.extra)) return { extra: value.extra }
  return null
}

export type MergedSideInk = {
  /** Drawing document for the board, in the side-by-side frame. */
  drawing: JsonRecord & { strokes: RawStroke[]; sourceWidth: number; sourceHeight: number }
  /** Points fingerprint of the PDF strokes as merged; an unchanged split skips the PDF save. */
  pdfFingerprint: string
  /** Width the PDF ink is written back with. */
  plainSourceWidth: number
  /** Fingerprint of the side strokes as merged. */
  sideFingerprint: string
}

const fingerprint = (strokes: readonly RawStroke[]) => {
  let text = `${strokes.length}`
  for (const stroke of strokes) {
    let sum = 0
    let twist = 0
    const points = stroke.points ?? []
    for (let index = 0; index < points.length; index += 1) {
      const x = finite(points[index].x)
      const y = finite(points[index].y)
      sum += x + y * 3.1
      twist += (x - y) * (index + 1)
    }
    text += `|${points.length}:${sum.toFixed(6)}:${twist.toFixed(4)}:${finite(stroke.baseWidth).toFixed(3)}:${String(stroke.color ?? '')}`
  }
  return text
}

/**
 * The board document for the side-by-side view: the PDF's own ink moved with
 * the PDF column, plus every side page's ink placed on its side page.
 */
export const mergePdfSideInk = (
  pdfDrawing: JsonRecord | null,
  store: PdfSidePagesStore | null,
  layout: PdfSideLayout,
  fallback: { title: string; now?: string },
): MergedSideInk => {
  const now = fallback.now ?? new Date().toISOString()
  const plainWidth = Math.max(1, finite(pdfDrawing?.sourceWidth, layout.scrollerWidth))
  const plainHeight = Math.max(1, finite(pdfDrawing?.sourceHeight, layout.paperHeight))
  const paperWidth = Math.max(layout.paperWidth, 1)
  const paperHeight = Math.max(layout.paperHeight, plainHeight, 1)
  const plainLeft = plainColumnLeft(Math.max(layout.scrollerWidth, plainWidth), layout.pdfColumnWidth)
  const shift = layout.pdfColumnLeft - plainLeft
  const movePdf = (stroke: RawStroke) => mapPoints(stroke, (x, y) => [
    (x * plainWidth + shift) / paperWidth,
    (y * plainHeight) / paperHeight,
  ])
  const pdfStrokes = Array.isArray(pdfDrawing?.strokes)
    ? (pdfDrawing.strokes as unknown[]).filter((stroke): stroke is RawStroke => isRecord(stroke) && Array.isArray(stroke.points))
    : []
  const movedPdf = pdfStrokes.map(movePdf)
  const sideStrokes: RawStroke[] = []
  for (const entry of store?.ink ?? []) {
    const box = layout.pages[entry.page - 1]
    if (!box) continue
    const pageWidth = quarterTurns(layout.rotation) % 2 === 1 ? box.height : box.width
    const widthScale = pageWidth / Math.max(1e-6, entry.ink.sourceWidth)
    for (const stroke of entry.ink.strokes) {
      const placed = mapPoints(stroke, (u, v) => {
        const [shownU, shownV] = rotatePagePoint(u, v, layout.rotation)
        return [(box.left + shownU * box.width) / paperWidth, (box.top + shownV * box.height) / paperHeight]
      })
      sideStrokes.push(scaleWidths(placed, widthScale))
    }
  }
  const drawing: MergedSideInk['drawing'] = {
    ...(pdfDrawing ?? {}),
    schemaVersion: 1,
    title: typeof pdfDrawing?.title === 'string' ? pdfDrawing.title : fallback.title,
    paperStyle: typeof pdfDrawing?.paperStyle === 'string' ? pdfDrawing.paperStyle : 'blank',
    createdAt: typeof pdfDrawing?.createdAt === 'string' ? pdfDrawing.createdAt : now,
    updatedAt: typeof pdfDrawing?.updatedAt === 'string' ? pdfDrawing.updatedAt : now,
    sourceWidth: paperWidth,
    sourceHeight: paperHeight,
    sourceOriginX: 0,
    sourceOriginY: 0,
    strokes: [...movedPdf, ...sideStrokes],
  }
  delete drawing.inkHistory
  // Undo after reopening: every PDF snapshot keeps the side ink as it is now,
  // so stepping back through the PDF's history never removes side strokes.
  const history = readHistory(pdfDrawing?.inkHistory)
  if (history) {
    const sideRefs = sideStrokes.map((_, index) => ({ live: movedPdf.length + index }))
    const remap = (snapshot: unknown[]) => [...snapshot.map(refOf).filter((ref) => ref !== null && ('extra' in ref || ref.live < movedPdf.length)), ...sideRefs]
    drawing.inkHistory = {
      extras: history.extras.map((stroke) => (isRecord(stroke) && Array.isArray(stroke.points) ? movePdf(stroke as RawStroke) : stroke)),
      undo: history.undo.map(remap),
      redo: history.redo.map(remap),
    }
  }
  return {
    drawing,
    pdfFingerprint: fingerprint(movedPdf),
    plainSourceWidth: Math.max(plainWidth, layout.scrollerWidth),
    sideFingerprint: fingerprint(sideStrokes),
  }
}

export type SplitSideInk = {
  /** The PDF's own drawing document, in the frame without side pages. */
  pdfDrawing: JsonRecord
  /** Fingerprints of the board's PDF and side strokes; compare with the merged or last written ones. */
  pdfFingerprint: string
  sideFingerprint: string
  store: PdfSidePagesStore
}

/**
 * Splits a board save back into the PDF's drawing and the side pages. A
 * stroke belongs to the side page when its centre lies right of the middle
 * of the gap between the columns.
 */
export const splitPdfSideInk = (
  drawing: JsonRecord,
  layout: PdfSideLayout,
  merged: Pick<MergedSideInk, 'plainSourceWidth'>,
  pdf: string,
  now = new Date().toISOString(),
): SplitSideInk => {
  const sourceWidth = Math.max(1, finite(drawing.sourceWidth, layout.paperWidth))
  const sourceHeight = Math.max(1, finite(drawing.sourceHeight, layout.paperHeight))
  const plainWidth = Math.max(1, merged.plainSourceWidth)
  const plainLeft = plainColumnLeft(Math.max(layout.scrollerWidth, plainWidth), layout.pdfColumnWidth)
  const shift = layout.pdfColumnLeft - plainLeft
  const sideFrom = layout.pdfColumnLeft + layout.pdfColumnWidth + PDF_SIDE_PAGE_GAP_PX / 2
  const toPdf = (stroke: RawStroke) => mapPoints(stroke, (x, y) => [(x * sourceWidth - shift) / plainWidth, y])
  const placeOf = (stroke: RawStroke): number => {
    const centre = strokeCentre(stroke, sourceWidth, sourceHeight)
    if (!centre || centre.x < sideFrom || !layout.pages.length) return 0
    return sidePageAt(layout, centre.y) + 1
  }
  const strokes = Array.isArray(drawing.strokes)
    ? (drawing.strokes as unknown[]).filter((stroke): stroke is RawStroke => isRecord(stroke) && Array.isArray(stroke.points))
    : []
  const places = strokes.map(placeOf)
  const boardPdf: RawStroke[] = []
  const boardSide: RawStroke[] = []
  const pdfIndex = new Map<number, number>()
  const byPage = new Map<number, RawStroke[]>()
  strokes.forEach((stroke, index) => {
    const page = places[index]
    if (!page) {
      pdfIndex.set(index, boardPdf.length)
      boardPdf.push(stroke)
      return
    }
    boardSide.push(stroke)
    const box = layout.pages[page - 1]
    const local = mapPoints(stroke, (x, y) => unrotatePagePoint(
      (x * sourceWidth - box.left) / Math.max(1e-6, box.width),
      (y * sourceHeight - box.top) / Math.max(1e-6, box.height),
      layout.rotation,
    ))
    const list = byPage.get(page) ?? []
    list.push(local)
    byPage.set(page, list)
  })
  const pdfStrokes = boardPdf.map(toPdf)
  const pdfDrawing: JsonRecord = {
    ...drawing,
    sourceWidth: plainWidth,
    sourceHeight,
    sourceOriginX: 0,
    sourceOriginY: 0,
    strokes: pdfStrokes,
  }
  delete pdfDrawing.inkHistory
  const history = readHistory(drawing.inkHistory)
  if (history) {
    const extraIndex = new Map<number, number>()
    const extras: unknown[] = []
    history.extras.forEach((stroke, index) => {
      if (!isRecord(stroke) || !Array.isArray(stroke.points) || placeOf(stroke as RawStroke)) return
      extraIndex.set(index, extras.length)
      extras.push(toPdf(stroke as RawStroke))
    })
    type Ref = { live: number } | { extra: number }
    const remap = (snapshot: unknown[]) => snapshot.flatMap((value): Ref[] => {
      const ref = refOf(value)
      if (!ref) return []
      if ('live' in ref) {
        const next = pdfIndex.get(ref.live)
        return next === undefined ? [] : [{ live: next }]
      }
      const next = extraIndex.get(ref.extra)
      return next === undefined ? [] : [{ extra: next }]
    })
    const undo = history.undo.map(remap)
    const redo = history.redo.map(remap)
    if (undo.length || redo.length) pdfDrawing.inkHistory = { extras, undo, redo }
  }
  const entries: PdfSidePageEntry[] = [...byPage.entries()].sort(([left], [right]) => left - right).map(([page, list]) => {
    const box = layout.pages[page - 1]
    const size = layout.sizes[page - 1] ?? { width: 595, height: 842 }
    const turned = quarterTurns(layout.rotation) % 2 === 1
    const width = Math.max(1, turned ? box.height : box.width)
    const height = Math.max(1, turned ? box.width : box.height)
    return {
      page,
      width: size.width,
      height: size.height,
      ink: {
        schemaVersion: 1,
        paperStyle: 'blank',
        sourceWidth: width,
        sourceHeight: height,
        updatedAt: now,
        strokes: list,
      },
    }
  })
  return {
    pdfDrawing,
    pdfFingerprint: fingerprint(boardPdf),
    sideFingerprint: fingerprint(boardSide),
    store: { schemaVersion: 1, kind: PDF_SIDE_PAGES_KIND, pdf, updatedAt: now, ink: entries },
  }
}
