import { SCROLL_ROOM } from './noteCanvas'

export type PdfOpenCameraInput = {
  pageWidth: number
  pageHeight: number
  viewWidth: number
  viewHeight: number
  room?: number
}

export type PdfOpenCamera = {
  x: number
  y: number
  pageCenterX: number
  pageCenterY: number
  room: number
}

const finitePositive = (value: number, fallback = 1) => (
  Number.isFinite(value) && value > 0 ? value : fallback
)

/** Camera that places the write-page visual center inside the viewport. */
export const pdfOpenCamera = (input: PdfOpenCameraInput): PdfOpenCamera => {
  const room = Number.isFinite(input.room) ? Math.max(0, Number(input.room)) : SCROLL_ROOM
  const pageWidth = finitePositive(input.pageWidth)
  const pageHeight = finitePositive(input.pageHeight)
  const viewWidth = finitePositive(input.viewWidth)
  const viewHeight = finitePositive(input.viewHeight)
  const pageCenterX = room + pageWidth / 2
  const pageCenterY = room + pageHeight / 2
  const maxX = Math.max(0, pageWidth + room * 2 - viewWidth)
  const maxY = Math.max(0, pageHeight + room * 2 - viewHeight)
  return {
    x: Math.min(maxX, Math.max(0, pageCenterX - viewWidth / 2)),
    y: Math.min(maxY, Math.max(0, pageCenterY - viewHeight / 2)),
    pageCenterX,
    pageCenterY,
    room,
  }
}

/** Origin-only / block:start camera: page top-left at the extra-room origin. */
export const pdfStartBlockCamera = (input: PdfOpenCameraInput): PdfOpenCamera => {
  const room = Number.isFinite(input.room) ? Math.max(0, Number(input.room)) : SCROLL_ROOM
  return {
    x: room,
    y: room,
    pageCenterX: room + finitePositive(input.pageWidth) / 2,
    pageCenterY: room + finitePositive(input.pageHeight) / 2,
    room,
  }
}

export const pdfPageCenterInViewport = (
  camera: { x: number; y: number },
  input: PdfOpenCameraInput,
  tolerance = 2,
) => {
  const room = Number.isFinite(input.room) ? Math.max(0, Number(input.room)) : SCROLL_ROOM
  const cx = room + finitePositive(input.pageWidth) / 2
  const cy = room + finitePositive(input.pageHeight) / 2
  const left = camera.x - tolerance
  const top = camera.y - tolerance
  const right = camera.x + finitePositive(input.viewWidth) + tolerance
  const bottom = camera.y + finitePositive(input.viewHeight) + tolerance
  return cx >= left && cx <= right && cy >= top && cy <= bottom
}

export const pdfPageScrollIntoViewBlock = (block: 'start' | 'center' | 'nearest' = 'center') => (
  block === 'start' ? 'start' as const : 'center' as const
)
