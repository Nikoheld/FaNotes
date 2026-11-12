// Pure geometry for the grade charts: the 1-6 scale, a course's marks over time and the running average.
// Kept free of React and of any rendering so it can be tested on plain numbers.
import type { CourseMark } from './grades'

export const MARK_MIN = 1
export const MARK_MAX = 6
export const PASS_MARK = 4

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** Position of a mark on the 1-6 scale in percent (a bar's fill, the tick at 4.0 sits at 60). */
export const scalePercent = (mark: number | null | undefined) =>
  mark == null || !Number.isFinite(mark) ? 0 : clamp(((mark - MARK_MIN) / (MARK_MAX - MARK_MIN)) * 100, 0, 100)

export interface TrendPoint {
  id: string
  date: string
  title: string
  mark: number
  weight: number
  /** Weighted average of this and every earlier counted mark. */
  running: number
}

/**
 * The marks a course chart may show, oldest first. Hidden marks and marks still waiting for their value
 * never appear (the chart must not reveal what the table keeps covered).
 */
export const trendPoints = (marks: CourseMark[]): TrendPoint[] => {
  const shown = marks
    .filter((entry) => entry.counted && !entry.hidden && entry.mark != null && Number.isFinite(entry.mark))
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => (left.entry.grade.date || '').localeCompare(right.entry.grade.date || '') || right.index - left.index)
  let weight = 0
  let sum = 0
  let running: number | null = null
  return shown.map(({ entry }) => {
    const mark = entry.mark as number
    if (entry.weight > 0) {
      weight += entry.weight
      sum += mark * entry.weight
      running = sum / weight
    }
    return { id: entry.grade.id, date: entry.grade.date || '', title: entry.grade.title || '', mark, weight: entry.weight, running: running ?? mark }
  })
}

export interface Padding { left: number; right: number; top: number; bottom: number }
export interface PlacedPoint extends TrendPoint { x: number; y: number; ry: number }
export interface TrendLayout {
  width: number
  height: number
  low: number
  high: number
  plot: { left: number; right: number; top: number; bottom: number }
  ticks: { value: number; y: number }[]
  passY: number
  points: PlacedPoint[]
  markPath: string
  runningPath: string
}

const dayNumber = (date: string) => {
  const stamp = Date.parse(`${date.slice(0, 10)}T00:00:00Z`)
  return Number.isFinite(stamp) ? stamp / 86_400_000 : null
}

const round = (value: number) => Math.round(value * 100) / 100

/** The visible mark range: always contains 4, never below 1 or above 6, whole numbers at the edges. */
export const trendDomain = (points: TrendPoint[]) => {
  const marks = points.flatMap((point) => [point.mark, point.running])
  const lowest = marks.length ? Math.min(...marks) : PASS_MARK
  const highest = marks.length ? Math.max(...marks) : PASS_MARK
  const low = clamp(Math.min(3, Math.floor(lowest)), MARK_MIN, 3)
  const high = clamp(Math.max(5, Math.ceil(highest)), 5, MARK_MAX)
  return { low, high }
}

export const trendLayout = (points: TrendPoint[], width: number, height: number, padding: Padding = { left: 30, right: 16, top: 14, bottom: 26 }): TrendLayout => {
  const { low, high } = trendDomain(points)
  const plot = { left: padding.left, right: Math.max(padding.left + 1, width - padding.right), top: padding.top, bottom: Math.max(padding.top + 1, height - padding.bottom) }
  const y = (value: number) => round(plot.bottom - ((clamp(value, low, high) - low) / (high - low)) * (plot.bottom - plot.top))
  const days = points.map((point) => dayNumber(point.date))
  const timed = points.length > 1 && days.every((day): day is number => day != null) && (days[days.length - 1] as number) > (days[0] as number)
  // Keep dots off the plot edges so the first and last stay whole.
  const inset = Math.min(18, (plot.right - plot.left) / 4)
  const span = plot.right - plot.left - inset * 2
  const x = (index: number) => {
    if (points.length === 1) return round((plot.left + plot.right) / 2)
    const share = timed ? ((days[index] as number) - (days[0] as number)) / ((days[days.length - 1] as number) - (days[0] as number)) : index / (points.length - 1)
    return round(plot.left + inset + share * span)
  }
  const placed = points.map((point, index) => ({ ...point, x: x(index), y: y(point.mark), ry: y(point.running) }))
  const ticks: { value: number; y: number }[] = []
  for (let value = low; value <= high; value += 1) ticks.push({ value, y: y(value) })
  const path = (key: 'y' | 'ry') => placed.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point[key]}`).join(' ')
  return { width, height, low, high, plot, ticks, passY: y(PASS_MARK), points: placed, markPath: path('y'), runningPath: path('ry') }
}

/** Index of the point closest to a pointer x (for hover), or -1 without points. */
export const nearestPoint = (points: { x: number }[], x: number) => {
  let best = -1
  let distance = Infinity
  points.forEach((point, index) => {
    const gap = Math.abs(point.x - x)
    if (gap < distance) { distance = gap; best = index }
  })
  return best
}

export interface RingSegments { radius: number; circumference: number; booked: number; estimated: number; used: number }

/** The absence quota ring: booked points first, the estimate after them, both clipped to the quota. Lengths are arc lengths. */
export const ringSegments = (booked: number, estimated: number, quota: number, radius = 40): RingSegments => {
  const circumference = round(2 * Math.PI * radius)
  if (!(quota > 0)) return { radius, circumference, booked: 0, estimated: 0, used: 0 }
  const bookedShare = clamp(booked / quota, 0, 1)
  const estimatedShare = clamp(estimated / quota, 0, 1 - bookedShare)
  return { radius, circumference, booked: round(bookedShare * circumference), estimated: round(estimatedShare * circumference), used: round(bookedShare + estimatedShare) }
}
