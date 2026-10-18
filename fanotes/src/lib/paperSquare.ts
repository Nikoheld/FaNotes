import type { PaperStyle } from '../types'

/** 0 keeps the built-in size of each square paper. */
export const PAPER_SQUARE_MM_MIN = 2
export const PAPER_SQUARE_MM_MAX = 20
const A4_WIDTH_MM = 210

export const clampPaperSquareMm = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  const stepped = Math.round(parsed * 2) / 2
  return Math.min(PAPER_SQUARE_MM_MAX, Math.max(PAPER_SQUARE_MM_MIN, stepped))
}

/** Millimetres for Häuschen or Kariert. A custom size applies to both. */
export const paperSquareStyleMm = (style: PaperStyle, configured: unknown) => {
  if (style !== 'squares' && style !== 'grid') return null
  const custom = clampPaperSquareMm(configured)
  if (custom > 0) return custom
  return style === 'grid' ? 7.5 : 5
}

export const paperSheetPx = (contentWidth: number, readableLineLength: boolean) => {
  if (!readableLineLength) return 900
  const width = Number.isFinite(contentWidth) ? contentWidth : 820
  return Math.min(900, Math.max(540, width))
}

/** One square, in CSS pixels, on a sheet `sheetPx` wide. */
export const paperSquarePx = (sheetPx: number, millimeters: number) => {
  const width = Number.isFinite(sheetPx) && sheetPx > 0 ? sheetPx : 820
  return Math.max(4, (width * millimeters) / A4_WIDTH_MM)
}

export const paperSquareSizeLabel = (configured: unknown) => {
  const size = clampPaperSquareMm(configured)
  if (size <= 0) return 'Auto'
  return `${Number.isInteger(size) ? String(size) : size.toFixed(1)} mm`
}
