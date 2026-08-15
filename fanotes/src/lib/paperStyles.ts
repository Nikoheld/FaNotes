import type { PaperStyle } from '../types'

export type PaperStyleOption = {
  id: PaperStyle
  label: string
  detail: string
}

export const PAPER_STYLES: readonly PaperStyleOption[] = [
  { id: 'blank', label: 'Leer', detail: 'Ohne Muster' },
  { id: 'dots', label: 'Gepunktet', detail: 'Ruhiges Punktraster' },
  { id: 'squares', label: 'Häuschen', detail: 'Kleine Schulkästchen' },
  { id: 'grid', label: 'Kariert', detail: 'Grössere Karos' },
  { id: 'lines', label: 'Liniert', detail: 'Lineatur mit Rand' },
  { id: 'millimeter', label: 'Millimeter', detail: 'Feinraster wie Millimeterpapier' },
]

const PAPER_STYLE_IDS = new Set<PaperStyle>(PAPER_STYLES.map((item) => item.id))
const A4_WIDTH_MM = 210

export const isPaperStyle = (value: unknown): value is PaperStyle => (
  typeof value === 'string' && PAPER_STYLE_IDS.has(value as PaperStyle)
)

export const normalizePaperStyle = (value: unknown, fallback: PaperStyle = 'dots'): PaperStyle => (
  isPaperStyle(value) ? value : fallback
)

export const paperStyleLabel = (style: PaperStyle) => (
  PAPER_STYLES.find((item) => item.id === style)?.label ?? 'Papier'
)

const stepForMm = (width: number, millimeters: number) => Math.max(2, width * millimeters / A4_WIDTH_MM)

export const drawPaperBackground = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  style: PaperStyle,
) => {
  context.save()
  context.fillStyle = '#fbfcff'
  context.fillRect(0, 0, width, height)
  if (style === 'blank') {
    context.restore()
    return
  }

  const scale = width / 900
  context.lineWidth = Math.max(1, scale * 0.7)

  if (style === 'dots') {
    const step = stepForMm(width, 7.5)
    const radius = Math.max(0.8, scale * 1.05)
    context.fillStyle = 'rgba(92, 107, 142, .28)'
    for (let y = step; y < height; y += step) {
      for (let x = step; x < width; x += step) {
        context.beginPath()
        context.arc(x, y, radius, 0, Math.PI * 2)
        context.fill()
      }
    }
  } else if (style === 'squares') {
    const step = stepForMm(width, 5)
    context.strokeStyle = 'rgba(92, 118, 168, .22)'
    context.beginPath()
    for (let x = step; x < width; x += step) {
      context.moveTo(x, 0)
      context.lineTo(x, height)
    }
    for (let y = step; y < height; y += step) {
      context.moveTo(0, y)
      context.lineTo(width, y)
    }
    context.stroke()
  } else if (style === 'grid') {
    const step = stepForMm(width, 7.5)
    context.strokeStyle = 'rgba(103, 116, 147, .145)'
    context.beginPath()
    for (let x = step; x < width; x += step) {
      context.moveTo(x, 0)
      context.lineTo(x, height)
    }
    for (let y = step; y < height; y += step) {
      context.moveTo(0, y)
      context.lineTo(width, y)
    }
    context.stroke()
  } else if (style === 'lines') {
    const step = stepForMm(width, 7.5)
    context.strokeStyle = 'rgba(103, 116, 147, .145)'
    context.beginPath()
    for (let y = step; y < height; y += step) {
      context.moveTo(0, y)
      context.lineTo(width, y)
    }
    context.stroke()
    context.strokeStyle = 'rgba(210, 82, 105, .16)'
    context.beginPath()
    context.moveTo(step * 1.65, 0)
    context.lineTo(step * 1.65, height)
    context.stroke()
  } else if (style === 'millimeter') {
    const minor = stepForMm(width, 1)
    const major = stepForMm(width, 5)
    context.strokeStyle = 'rgba(92, 118, 168, .1)'
    context.beginPath()
    for (let x = minor; x < width; x += minor) {
      context.moveTo(x, 0)
      context.lineTo(x, height)
    }
    for (let y = minor; y < height; y += minor) {
      context.moveTo(0, y)
      context.lineTo(width, y)
    }
    context.stroke()
    context.strokeStyle = 'rgba(72, 98, 148, .22)'
    context.beginPath()
    for (let x = major; x < width; x += major) {
      context.moveTo(x, 0)
      context.lineTo(x, height)
    }
    for (let y = major; y < height; y += major) {
      context.moveTo(0, y)
      context.lineTo(width, y)
    }
    context.stroke()
  }
  context.restore()
}
