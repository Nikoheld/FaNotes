import { PDFDocument } from 'pdf-lib'

/** Returns a copy of `order` with the entry at `from` moved to `to`. */
export const movePage = (order: number[], from: number, to: number): number[] => {
  if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return order
  const next = order.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/** Builds a new PDF holding the 1-based pages of `source` in the given order (repeats and gaps allowed). */
export const buildPdfWithPages = async (source: Uint8Array, pages: number[]): Promise<Uint8Array> => {
  if (!pages.length) throw new Error('Mindestens eine Seite muss bleiben.')
  const original = await PDFDocument.load(source, { ignoreEncryption: false })
  const count = original.getPageCount()
  if (pages.some((page) => !Number.isInteger(page) || page < 1 || page > count)) throw new Error('Ungültige Seitenauswahl.')
  const result = await PDFDocument.create()
  const copied = await result.copyPages(original, pages.map((page) => page - 1))
  copied.forEach((page) => result.addPage(page))
  return result.save()
}
