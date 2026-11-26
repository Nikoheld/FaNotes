/**
 * Worksheets (pasted pictures and PDF worksheets) as export pictures. Renderer only.
 *
 * A worksheet page becomes one PNG or JPEG with its legacy text boxes and marks painted in, so the exporters need
 * no new drawing code: the handwriting export places the picture at its on-screen box, the text-note export puts
 * it into the reading order next to the text it floats beside.
 */
import { stripFamdPayload } from '../famd'
import type { WorksheetDocument, WorksheetPlacement } from '../../types'
import { renderPdfPagesToPng } from './pdfRaster'

export type WorksheetExportPage = {
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

export type WorksheetExportItem = {
  id: string
  kind: WorksheetDocument['kind']
  placement?: WorksheetPlacement
  pages: WorksheetExportPage[]
}

const sniff = (bytes: Uint8Array): 'image/png' | 'image/jpeg' | null => {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return null
}

const toBytes = async (canvas: HTMLCanvasElement) => {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('PNG encoding failed.')
  return new Uint8Array(await blob.arrayBuffer())
}

const hasMarks = (document: WorksheetDocument, page: number) => (
  document.textBoxes.some((box) => box.page === page && box.text.trim() !== '')
  || (document.highlights ?? []).some((mark) => mark.page === page)
)

/** Wraps `text` into lines no wider than `maxWidth` (canvas measuring), keeping explicit line breaks. */
const wrapLines = (context: CanvasRenderingContext2D, text: string, maxWidth: number) => {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/(\s+)/u)) {
      const candidate = line + word
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line.replace(/\s+$/u, ''))
        line = word.replace(/^\s+/u, '')
      } else line = candidate
    }
    lines.push(line.replace(/\s+$/u, ''))
  }
  return lines
}

/**
 * Draws the legacy marks of one page over a canvas that already holds the page. `displayWidth` is the page's width
 * in CSS px on the sheet: text boxes keep their pixel font size there, so the font scales with the bitmap.
 */
export const paintWorksheetMarks = (canvas: HTMLCanvasElement, document: WorksheetDocument, page: number, displayWidth: number) => {
  const context = canvas.getContext('2d')
  if (!context) return
  const scale = canvas.width / Math.max(1, displayWidth)
  for (const mark of document.highlights ?? []) {
    if (mark.page !== page) continue
    context.save()
    context.globalCompositeOperation = 'multiply'
    context.fillStyle = mark.color
    context.fillRect(mark.x * canvas.width, mark.y * canvas.height, mark.width * canvas.width, mark.height * canvas.height)
    context.restore()
  }
  for (const box of document.textBoxes) {
    if (box.page !== page || !box.text.trim()) continue
    const size = Math.max(6, box.fontSize * scale)
    const padding = 6 * scale
    const left = box.x * canvas.width
    const top = box.y * canvas.height
    const width = Math.max(90 * scale, box.width * canvas.width)
    context.save()
    context.font = `${size}px "Segoe UI", "Noto Sans", "DejaVu Sans", Arial, sans-serif`
    const lines = wrapLines(context, box.text, width - padding * 2)
    const lineHeight = size * 1.35
    context.fillStyle = 'rgba(255,255,255,0.78)'
    context.fillRect(left, top, width, lines.length * lineHeight + padding * 2)
    context.fillStyle = '#20222b'
    context.textBaseline = 'top'
    lines.forEach((line, index) => context.fillText(line, left + padding, top + padding + index * lineHeight))
    context.restore()
  }
}

/** A picture worksheet page: the original bytes when nothing is drawn over it, else a PNG with the marks painted in. */
export const exportImageWorksheetPage = async (
  document: WorksheetDocument,
  bytes: Uint8Array,
  displayWidth: number,
): Promise<WorksheetExportPage | null> => {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart]))
  } catch {
    return null
  }
  try {
    const mime = sniff(bytes)
    if (mime && !hasMarks(document, 1)) return { bytes, mime, width: bitmap.width, height: bitmap.height }
    const canvas = window.document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
    paintWorksheetMarks(canvas, document, 1, displayWidth)
    const png = await toBytes(canvas)
    canvas.width = 0
    canvas.height = 0
    return { bytes: png, mime: 'image/png', width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close()
  }
}

/** The pages of a PDF worksheet as pictures (150 dpi), with the marks of each page painted in. */
export const exportPdfWorksheetPages = async (
  document: WorksheetDocument,
  pdfBytes: Uint8Array,
  displayWidths: readonly number[],
): Promise<WorksheetExportPage[]> => {
  const rendered = await renderPdfPagesToPng(pdfBytes, 150)
  const pages: WorksheetExportPage[] = []
  for (let index = 0; index < rendered.length; index += 1) {
    const page = rendered[index]
    if (!hasMarks(document, index + 1)) {
      pages.push({ bytes: page.png, mime: 'image/png', width: page.widthPx, height: page.heightPx })
      continue
    }
    const bitmap = await createImageBitmap(new Blob([page.png as BlobPart]))
    const canvas = window.document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
    bitmap.close()
    paintWorksheetMarks(canvas, document, index + 1, displayWidths[index] ?? displayWidths[0] ?? 800)
    pages.push({ bytes: await toBytes(canvas), mime: 'image/png', width: canvas.width, height: canvas.height })
    canvas.width = 0
    canvas.height = 0
  }
  return pages
}

/**
 * Every picture and PDF worksheet of the open note as export pictures. Layers are asked to save first, so a text box
 * typed a moment ago is included. A worksheet that cannot be read is left out; the export still runs.
 */
export const collectWorksheetExportItems = async (
  ids: readonly string[],
  api: {
    readWorksheet: (id: string) => Promise<WorksheetDocument>
    readAssetBytes: (relativePath: string) => Promise<Uint8Array>
  },
  root: ParentNode = window.document,
): Promise<WorksheetExportItem[]> => {
  const items: WorksheetExportItem[] = []
  for (const id of ids) {
    try {
      const document = await api.readWorksheet(id)
      if (document.kind === 'html') continue
      const raw = await api.readAssetBytes(document.sourceRelativePath)
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayLike<number>)
      const layer = root.querySelector<HTMLElement>(`[data-worksheet-id="${CSS.escape(id)}"]`)
      const pageWidths = [...(layer?.querySelectorAll<HTMLElement>('.worksheet-page') ?? [])].map((node) => node.offsetWidth).filter((value) => value > 0)
      if (document.kind === 'image') {
        const page = await exportImageWorksheetPage(document, bytes, pageWidths[0] ?? 900)
        if (page) items.push({ id, kind: 'image', placement: document.placement, pages: [page] })
      } else {
        const pages = await exportPdfWorksheetPages(document, bytes, pageWidths)
        if (pages.length) items.push({ id, kind: 'pdf', pages })
      }
    } catch {
      // Left out.
    }
  }
  return items
}

/** The picture source the text-note exporters resolve for a worksheet page (no scheme: the HTML sanitizer keeps relative sources). */
export const worksheetImageSource = (id: string, page: number) => `fanotes-sheet/${id}/${page}`

const SHEET_SOURCE = /^fanotes-sheet\/([a-zA-Z0-9_-]+)\/(\d+)$/u

/** A resolver that serves worksheet pages and defers everything else to `fallback`. */
export const withWorksheetImages = (
  items: readonly WorksheetExportItem[],
  fallback: ((source: string) => Promise<{ bytes: Uint8Array; mime: string; width: number; height: number } | null>) | undefined,
) => async (source: string) => {
  const match = SHEET_SOURCE.exec(source)
  if (!match) return fallback ? fallback(source) : null
  const page = items.find((item) => item.id === match[1])?.pages[Number(match[2]) - 1]
  return page ? { bytes: page.bytes, mime: page.mime, width: page.width, height: page.height } : null
}

/** Alt text of a placed worksheet picture: `fanotes-sheet x=0.1 w=0.5`. Both are fractions of the text width. */
export const sheetAlt = (placement?: WorksheetPlacement) => (
  placement ? `fanotes-sheet x=${placement.x.toFixed(4)} w=${placement.width.toFixed(4)}` : 'fanotes-sheet'
)

export const parseSheetAlt = (alt: string | undefined): { x: number; width: number } | null => {
  const match = /^fanotes-sheet(?: x=([0-9.]+) w=([0-9.]+))?$/u.exec(alt ?? '')
  if (!match) return null
  if (match[1] === undefined) return { x: 0, width: 1 }
  const width = Math.min(1, Math.max(0.05, Number(match[2]) || 1))
  return { x: Math.min(1 - width, Math.max(0, Number(match[1]) || 0)), width }
}

const WORKSHEET_MARKER_LINE = /^\s*<!--\s*fanotes-worksheet:[a-zA-Z0-9_-]{1,96}\s*-->\s*$/u

/** Index of the line after which a picture may be inserted without cutting a paragraph or a code fence. */
const safeInsertLine = (lines: readonly string[], after: number) => {
  let fence: string | null = null
  let end = Math.min(after, lines.length - 1)
  for (let index = 0; index <= end; index += 1) {
    const marker = /^\s*(```+|~~~+)/u.exec(lines[index])?.[1]
    if (!marker) continue
    if (!fence) fence = marker
    else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
  }
  if (fence) {
    // Inside a code fence: continue to its closing line.
    for (let next = end + 1; next < lines.length; next += 1) {
      end = next
      const marker = /^\s*(```+|~~~+)\s*$/u.exec(lines[next])?.[1]
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) break
    }
  }
  // Inside a paragraph, list or table: after its last line (a blank line is already between two blocks).
  if (lines[end]?.trim() !== '') while (end + 1 < lines.length && lines[end + 1].trim() !== '') end += 1
  return end
}

/**
 * Takes the worksheet marker lines out of the note and puts a picture line where the sheet shows each picture:
 * after the text line the floating picture sits beside (`lineAt` answers that, 0-based, for a placed picture),
 * pictures without a position and PDF pages at the end, in the order the sheet stacks them. Returns the Markdown
 * for the exporters.
 */
export const placeWorksheetPagesInMarkdown = (
  markdown: string,
  items: readonly WorksheetExportItem[],
  lineAt: (item: WorksheetExportItem) => number | null,
): string => {
  if (!items.length) return markdown
  const lines = stripFamdPayload(markdown).split('\n')
  const inserts = new Map<number, string[]>()
  const tail: string[] = []
  const sorted = [...items].sort((a, b) => (a.placement?.y ?? Infinity) - (b.placement?.y ?? Infinity))
  for (const item of sorted) {
    const row = item.placement ? lineAt(item) : null
    const target = row === null || !lines.length ? null : safeInsertLine(lines, Math.max(0, row))
    const pictures = item.pages.map((_page, index) => `![${sheetAlt(item.placement)}](${worksheetImageSource(item.id, index + 1)})`)
    if (target === null) tail.push(...pictures)
    else inserts.set(target, [...(inserts.get(target) ?? []), ...pictures])
  }
  const out: string[] = []
  lines.forEach((line, index) => {
    if (!WORKSHEET_MARKER_LINE.test(line)) out.push(line)
    const added = inserts.get(index)
    if (added) out.push('', ...added.flatMap((picture) => [picture, '']))
  })
  if (tail.length) out.push('', ...tail.flatMap((picture) => [picture, '']))
  return out.join('\n')
}
