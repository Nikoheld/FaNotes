import { describe, expect, it } from 'vitest'
import { DESKTOP_PDF_COLUMN_DEFAULT, DESKTOP_PDF_PAGE_BORDER, DESKTOP_PDF_PAPER_BOTTOM, DESKTOP_PDF_PAPER_TOP, PDF_PAGE_GAP, desktopPdfColumnWidth, desktopPdfInkPages, type PdfInkPage } from '../src/lib/pdfInk'

// Port of DesktopPdfInkLayoutTest (android/core): same measured numbers.
const ratios = [842 / 595, 842 / 595, 792 / 612]

type Spot = [number, number, number]
const pageSpot = (pages: PdfInkPage[], sourceWidth: number, sourceHeight: number, x: number, y: number): Spot => {
  const px = x * sourceWidth
  const py = y * sourceHeight
  const page = pages.find((p) => py >= p.top - 2 && py <= p.top + p.height + 2) as PdfInkPage
  return [page.index, (px - page.left) / page.width, (py - page.top) / page.height]
}
const expectSpot = (expected: Spot, actual: Spot) => {
  expect(actual[0]).toBe(expected[0])
  expect(Math.abs(actual[1] - expected[1])).toBeLessThanOrEqual(0.004)
  expect(Math.abs(actual[2] - expected[2])).toBeLessThanOrEqual(0.004)
}

describe('desktop PDF ink layout', () => {
  it('a window 1400 wide sheet puts the strokes where they were drawn', () => {
    const pages = desktopPdfInkPages(1114, 3468, ratios)
    expect(desktopPdfColumnWidth(1114, 3468, ratios)).toBeCloseTo(820, 9)
    expect(pages[0].left).toBeCloseTo(148, 9)
    expectSpot([0, 0.05, 0.05], pageSpot(pages, 1114, 3468, 0.168756, 0.021917))
    expectSpot([0, 0.5, 0.5], pageSpot(pages, 1114, 3468, 0.499995, 0.172488))
    expectSpot([1, 0.95, 0.95], pageSpot(pages, 1114, 3468, 0.831233, 0.662273))
    expectSpot([2, 0.05, 0.05], pageSpot(pages, 1114, 3468, 0.168756, 0.698915))
  })
  it('a wider window only moves the column', () => {
    const pages = desktopPdfInkPages(1614, 3468, ratios)
    expectSpot([0, 0.05, 0.05], pageSpot(pages, 1614, 3468, 0.271376, 0.021919))
    expectSpot([1, 0.95, 0.95], pageSpot(pages, 1614, 3468, 0.728624, 0.662273))
    expectSpot([2, 0.05, 0.05], pageSpot(pages, 1614, 3468, 0.271376, 0.698916))
  })
  it('write room below the pages falls back to the default column', () => {
    expect(desktopPdfColumnWidth(972, 3806, ratios)).toBeCloseTo(DESKTOP_PDF_COLUMN_DEFAULT, 9)
    const pages = desktopPdfInkPages(972, 3806, ratios)
    expectSpot([2, 0.05, 0.05], pageSpot(pages, 972, 3806, 0.120379, 0.636826))
  })
  it('a narrower content width setting is read from the height', () => {
    const column = 640
    const height = DESKTOP_PDF_PAPER_TOP + DESKTOP_PDF_PAPER_BOTTOM + PDF_PAGE_GAP * 2 + column * ratios.reduce((a, b) => a + b, 0)
    expect(desktopPdfColumnWidth(1200, height, ratios)).toBeCloseTo(column, 9)
    expect(desktopPdfInkPages(1200, height, ratios)[0].left).toBeCloseTo((1200 - column) / 2 + DESKTOP_PDF_PAGE_BORDER, 9)
  })
  it('no pages or a broken size stay safe', () => {
    expect(desktopPdfInkPages(1000, 3000, [])).toEqual([])
    expect(desktopPdfColumnWidth(NaN, NaN, ratios)).toBeCloseTo(DESKTOP_PDF_COLUMN_DEFAULT, 9)
  })
})
