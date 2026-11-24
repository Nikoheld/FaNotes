/**
 * Reads what the screen shows besides the ink: text boxes, the note's typed
 * text, pictures and PDF page boxes, in sheet CSS pixels (paper layout, camera
 * zoom divided out). DOM only; the exporters take the plain data.
 */
import type { NoteTextField } from '../noteTextField'
import type { SheetField, SheetImage, SheetText } from './inkPdf'

/** Camera zoom of the sheet: painted height over layout height. */
export const paperZoom = (paper: HTMLElement) => {
  const height = paper.getBoundingClientRect().height
  return height > 0 ? height / Math.max(1, paper.offsetHeight) : 1
}

const SKIP_CHROME = '.lw-drawing-board, .note-text-layer, .note-link-layer, .cm-cursor, .cm-dropCursor, .lw-draw-notice, .lw-conversion-panel, .lw-art-studio, .lw-selection-hint, script, style, [data-snapshot="hide"]'
const SKIP = `${SKIP_CHROME}, .katex-mathml, .cm-widgetBuffer, canvas, svg, [aria-hidden="true"]`

const relative = (rect: DOMRect, paperRect: DOMRect, zoom: number) => ({
  left: (rect.left - paperRect.left) / zoom,
  top: (rect.top - paperRect.top) / zoom,
  width: rect.width / zoom,
  height: rect.height / zoom,
})

/** A text box with a place on this sheet. */
export type CapturedField = SheetField & { page: number; boxLeft: number; boxTop: number }

export const captureTextFields = (
  paper: HTMLElement,
  fields: readonly NoteTextField[],
  zoom = paperZoom(paper),
): CapturedField[] => {
  const paperRect = paper.getBoundingClientRect()
  const out: CapturedField[] = []
  for (const element of paper.querySelectorAll<HTMLElement>('.note-text-field')) {
    const area = element.querySelector<HTMLElement>('textarea[data-note-text-field]')
    const id = area?.getAttribute('data-note-text-field')
    const field = id ? fields.find((item) => item.id === id) : undefined
    if (!area || !field || !field.text.trim()) continue
    const rect = relative(element.getBoundingClientRect(), paperRect, zoom)
    if (!(rect.width > 0)) continue
    const fontSize = Number.parseFloat(getComputedStyle(area).fontSize) || field.fontSize
    out.push({
      id: field.id,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      fontSize,
      color: field.color,
      bold: field.bold,
      text: field.text,
      page: field.page,
      boxLeft: rect.left,
      boxTop: rect.top,
    })
  }
  return out
}

const sizeOf = (style: CSSStyleDeclaration) => Number.parseFloat(style.fontSize) || 16

/** The note's typed text, one piece per visual line and style. */
export const captureBodyText = (paper: HTMLElement, roots: readonly Element[], zoom = paperZoom(paper)): SheetText[] => {
  const paperRect = paper.getBoundingClientRect()
  const out: SheetText[] = []
  const styles = new Map<Element, CSSStyleDeclaration>()
  const styleOf = (element: Element) => {
    let style = styles.get(element)
    if (!style) {
      style = getComputedStyle(element)
      styles.set(element, style)
    }
    return style
  }
  const range = document.createRange()
  const addText = (node: Text) => {
    const parent = node.parentElement
    const text = node.data
    if (!parent || !text.trim()) return
    const style = styleOf(parent)
    const size = sizeOf(style)
    const mono = /mono|courier|consol/iu.test(style.fontFamily)
    const bold = Number.parseInt(style.fontWeight, 10) >= 600 || style.fontWeight === 'bold'
    const italic = style.fontStyle === 'italic'
    const color = style.color
    let line = ''
    let lineTop = Number.NaN
    let first: DOMRect | null = null
    let last: DOMRect | null = null
    const flush = () => {
      if (first && last && line.trim()) {
        const rect = relative(new DOMRect(first.left, first.top, last.right - first.left, first.height), paperRect, zoom)
        out.push({
          x: rect.left,
          baseline: rect.top + rect.height * 0.8,
          size,
          text: line.replace(/\s+$/u, ''),
          color,
          bold,
          italic,
          mono,
          width: rect.width,
        })
      }
      line = ''
      lineTop = Number.NaN
      first = null
      last = null
    }
    for (let index = 0; index < text.length; index += 1) {
      range.setStart(node, index)
      range.setEnd(node, index + 1)
      const rect = range.getBoundingClientRect()
      if (!(rect.width > 0) && !(rect.height > 0)) continue
      if (!(rect.width > 0)) continue
      if (!Number.isNaN(lineTop) && Math.abs(rect.top - lineTop) > size * 0.4) flush()
      if (Number.isNaN(lineTop)) lineTop = rect.top
      if (!first) first = rect
      last = rect
      line += text[index]
    }
    flush()
  }
  const visit = (element: Element) => {
    if (element.matches(SKIP)) return
    const style = styleOf(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) addText(child as Text)
      else if (child.nodeType === Node.ELEMENT_NODE) visit(child as Element)
    }
  }
  for (const root of roots) visit(root)
  range.detach?.()
  return out
}

const sniff = (bytes: Uint8Array): 'image/png' | 'image/jpeg' | null => {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return null
}

/** Pictures in the note's text, as PNG or JPEG bytes, placed on the sheet. */
export const captureImages = async (paper: HTMLElement, roots: readonly Element[], zoom = paperZoom(paper)): Promise<SheetImage[]> => {
  const paperRect = paper.getBoundingClientRect()
  const cache = new Map<string, { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' } | null>()
  const bytesOf = async (image: HTMLImageElement) => {
    const src = image.currentSrc || image.src
    if (cache.has(src)) return cache.get(src) ?? null
    let found: { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' } | null = null
    try {
      const response = await fetch(src)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const mime = sniff(bytes)
      if (mime) found = { bytes, mime }
    } catch {
      // Fall through to the canvas copy.
    }
    if (!found && image.naturalWidth > 0) {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        canvas.getContext('2d')?.drawImage(image, 0, 0)
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
        if (blob) found = { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' }
      } catch {
        found = null
      }
    }
    cache.set(src, found)
    return found
  }
  const out: SheetImage[] = []
  const images: HTMLImageElement[] = []
  const visit = (element: Element) => {
    if (element.matches(SKIP_CHROME)) return
    if (element instanceof HTMLImageElement) {
      images.push(element)
      return
    }
    for (const child of element.children) visit(child)
  }
  for (const root of roots) visit(root)
  for (const image of images) {
    const rect = relative(image.getBoundingClientRect(), paperRect, zoom)
    if (rect.width < 4 || rect.height < 4) continue
    const data = await bytesOf(image)
    if (data) out.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height, bytes: data.bytes, mime: data.mime })
  }
  return out
}

export type PdfPageBox = { page: number; side: boolean; left: number; top: number; width: number; height: number; rotation: number }

/** PDF pages and blank side pages of a PDF note, in paper px. */
export const capturePdfPageBoxes = (paper: HTMLElement, zoom = paperZoom(paper)): PdfPageBox[] => {
  const paperRect = paper.getBoundingClientRect()
  const boxes: PdfPageBox[] = []
  for (const element of paper.querySelectorAll<HTMLElement>('[data-pdf-page], [data-pdf-side-page]')) {
    const side = element.hasAttribute('data-pdf-side-page')
    const page = Number(side ? element.dataset.pdfSidePage : element.dataset.pdfPage)
    if (!Number.isInteger(page) || page < 1) continue
    const rect = relative(element.getBoundingClientRect(), paperRect, zoom)
    if (!(rect.width > 0) || !(rect.height > 0)) continue
    const rotation = Number(element.dataset.pdfViewRotation ?? element.closest<HTMLElement>('[data-pdf-view-rotation]')?.dataset.pdfViewRotation ?? 0) || 0
    boxes.push({ page, side, ...rect, rotation })
  }
  return boxes
}
