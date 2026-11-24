/** PDF pages as PNG bytes (renderer only): the DOCX export puts one picture on each Word page. */
import { openPdfDocument } from '../pdfDocument'

export type RenderedPage = { png: Uint8Array; widthPt: number; heightPt: number; widthPx: number; heightPx: number }

export const renderPdfPagesToPng = async (pdfBytes: Uint8Array, dpi = 200): Promise<RenderedPage[]> => {
  const copy = new Uint8Array(pdfBytes.byteLength)
  copy.set(pdfBytes)
  const { pdf, task } = await openPdfDocument(copy)
  const pages: RenderedPage[] = []
  try {
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number)
      const base = page.getViewport({ scale: 1 })
      const scale = dpi / 72
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(viewport.width))
      canvas.height = Math.max(1, Math.round(viewport.height))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas 2D is not available.')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: context, viewport, canvas }).promise
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('PNG encoding failed.')
      pages.push({ png: new Uint8Array(await blob.arrayBuffer()), widthPt: base.width, heightPt: base.height, widthPx: canvas.width, heightPx: canvas.height })
      canvas.width = 0
      canvas.height = 0
      page.cleanup()
    }
  } finally {
    await task.destroy()
  }
  return pages
}

/** Text items per page for locating marked passages (renderer only). */
export const openPdfTextSource = async (pdfBytes: Uint8Array) => {
  const copy = new Uint8Array(pdfBytes.byteLength)
  copy.set(pdfBytes)
  const { pdf, task } = await openPdfDocument(copy)
  return {
    source: async (number: number) => {
      const page = await pdf.getPage(number)
      const content = await page.getTextContent()
      page.cleanup()
      return content.items.flatMap((item) => ('str' in item ? [{ str: item.str, transform: item.transform as number[], width: item.width, height: item.height }] : []))
    },
    close: () => task.destroy(),
  }
}
