import type { StrokePoint } from '../../../src/types'
import { readFunctionGraphStamp } from './functionGraph'
import {
  clampFigureLineWidth,
  clampFigureParams,
  figureLineWidthForSize,
  isMathFigureId,
  mathFigurePaths,
} from './mathFigures'

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))

export type SavedInkCatalogs = {
  symbolIds: ReadonlySet<string>
  brushIds: ReadonlySet<string>
  effectIds: ReadonlySet<string>
}

/**
 * Strokes a saved drawing JSON hands the board. Coordinates are the 0–1 sheet
 * (or the loose section box). This is the open parser — callers must not
 * reimplement the clamp.
 */
export const readSavedInkStrokes = (
  value: unknown,
  fallbackColor: string,
  options: { clampToSheet?: boolean } = {},
  catalogs: SavedInkCatalogs = { symbolIds: new Set(), brushIds: new Set(), effectIds: new Set() },
) => {
  if (!Array.isArray(value)) return []
  const bound = options.clampToSheet === false
    ? (coordinate: number) => clamp(coordinate, -4, 4)
    : (coordinate: number) => clamp(coordinate)
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const raw = entry as {
      points?: unknown
      baseWidth?: unknown
      pressureEnabled?: unknown
      color?: unknown
      purpose?: unknown
      brush?: unknown
      colorEffect?: unknown
      opacity?: unknown
      textureSeed?: unknown
      keepColor?: unknown
      symbolId?: unknown
      symbolRotation?: unknown
      figureId?: unknown
      figureParams?: unknown
      figureLineWidth?: unknown
      graphExpression?: unknown
      graphXMin?: unknown
      graphXMax?: unknown
    }
    if (!Array.isArray(raw.points)) return []
    const points = raw.points.flatMap((point): StrokePoint[] => {
      if (!point || typeof point !== 'object') return []
      const sample = point as Partial<StrokePoint>
      return [{
        x: bound(Number(sample.x) || 0),
        y: bound(Number(sample.y) || 0),
        t: Number(sample.t) || 0,
        pressure: clamp(Number(sample.pressure) || 0.5),
        tiltX: clamp(Number(sample.tiltX) || 0, -90, 90),
        tiltY: clamp(Number(sample.tiltY) || 0, -90, 90),
        pointerType: typeof sample.pointerType === 'string' ? sample.pointerType : 'pen',
      }]
    })
    if (!points.length) return []
    const symbolId = typeof raw.symbolId === 'string' && catalogs.symbolIds.has(raw.symbolId) ? raw.symbolId : undefined
    const figureId = isMathFigureId(raw.figureId) ? raw.figureId : undefined
    const figureParams = figureId ? clampFigureParams(figureId, raw.figureParams) : undefined
    const graph = readFunctionGraphStamp(raw)
    const baseWidth = clamp(Number(raw.baseWidth) || 4, 0.5, figureId || graph ? 320 : symbolId ? 180 : 48)
    const figurePaths = figureId ? mathFigurePaths(figureId, figureParams) : undefined
    const brush = typeof raw.brush === 'string' && catalogs.brushIds.has(raw.brush) ? raw.brush : undefined
    const colorEffect = typeof raw.colorEffect === 'string' && catalogs.effectIds.has(raw.colorEffect) ? raw.colorEffect : 'solid'
    return [{
      points,
      baseWidth,
      pressureEnabled: raw.pressureEnabled !== false,
      color: typeof raw.color === 'string' && /^#[\da-f]{6}$/iu.test(raw.color) ? raw.color : fallbackColor,
      purpose: raw.purpose === 'art' ? 'art' as const : 'handwriting' as const,
      brush,
      colorEffect,
      opacity: clamp(Number(raw.opacity) || 1, 0.08, 1),
      textureSeed: Math.round(clamp(Math.abs(Number(raw.textureSeed) || 1), 1, 2_147_483_647)),
      keepColor: raw.keepColor === true ? true as const : undefined,
      symbolId,
      symbolRotation: symbolId || figureId ? clamp(Number(raw.symbolRotation) || 0, -180, 180) : graph ? 0 : undefined,
      figureId,
      figureParams,
      figureLineWidth: figureId || graph ? clampFigureLineWidth(raw.figureLineWidth, figureLineWidthForSize(baseWidth)) : undefined,
      figurePaths: figurePaths?.length ? figurePaths : undefined,
      graphExpression: graph?.expression || undefined,
      graphXMin: graph ? graph.xMin : undefined,
      graphXMax: graph ? graph.xMax : undefined,
      graphPaths: graph?.paths.length ? graph.paths.slice() : undefined,
    }]
  })
}
