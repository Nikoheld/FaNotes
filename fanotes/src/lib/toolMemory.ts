import {
  clampFigureParams,
  defaultFigureParams,
  isMathFigureId,
  mathFigureById,
  type MathFigureGroup,
  type MathFigureId,
} from './mathFigures'

/**
 * Tool choices that are not part of the note and not part of AppSettings:
 * eraser size, the armed figure, the last pen or eraser, and the text-to-
 * handwriting sliders. Art colour and pen width already have their own stores.
 */
export const TOOL_MEMORY_KEY = 'fanotes.tool-memory.v1'

export type ToolMemoryTool = 'pen' | 'eraser'
export type ToolMemoryInkMode = 'writing' | 'drawing'
export type ToolMemoryPlacement = 'free-line' | 'page-start'
export type ToolMemoryMathPlacement = 'auto' | 'same-line' | 'next-line'

export type HandwritingToolMemory = {
  fontSize: number
  lineSpacing: number
  variation: number
  connectLetters: boolean
  fitToPage: boolean
  placement: ToolMemoryPlacement
}

export type ToolMemory = {
  eraserSize: number
  tool: ToolMemoryTool
  inkMode: ToolMemoryInkMode
  symbolId: string | null
  figureId: MathFigureId
  figureParams: Record<string, number>
  figureSize: number
  figureRotation: number
  figureGroup: MathFigureGroup
  handwriting: HandwritingToolMemory
  mathPlacement: ToolMemoryMathPlacement
}

const DEFAULT_FIGURE_ID: MathFigureId = 'cube'

const clampNumber = (value: unknown, min: number, max: number, fallback: number) => {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

const snap = (value: number, step: number) => Math.round(value / step) * step

export const defaultHandwritingToolMemory = (): HandwritingToolMemory => ({
  fontSize: 42,
  lineSpacing: 1.42,
  variation: 0.62,
  connectLetters: true,
  fitToPage: true,
  placement: 'free-line',
})

export const defaultToolMemory = (): ToolMemory => ({
  eraserSize: 24,
  tool: 'pen',
  inkMode: 'writing',
  symbolId: null,
  figureId: DEFAULT_FIGURE_ID,
  figureParams: defaultFigureParams(DEFAULT_FIGURE_ID),
  figureSize: 120,
  figureRotation: 0,
  figureGroup: mathFigureById(DEFAULT_FIGURE_ID).group,
  handwriting: defaultHandwritingToolMemory(),
  mathPlacement: 'auto',
})

const readSymbolId = (value: unknown) => (
  typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[a-z0-9-]+$/iu.test(value) ? value : null
)

const readHandwriting = (value: unknown): HandwritingToolMemory => {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const defaults = defaultHandwritingToolMemory()
  const placement = source.placement === 'page-start' ? 'page-start' : defaults.placement
  return {
    fontSize: Math.round(clampNumber(source.fontSize, 20, 72, defaults.fontSize)),
    lineSpacing: Math.round(clampNumber(source.lineSpacing, 1.05, 2, defaults.lineSpacing) * 100) / 100,
    variation: Math.round(clampNumber(source.variation, 0, 1, defaults.variation) * 100) / 100,
    connectLetters: typeof source.connectLetters === 'boolean' ? source.connectLetters : defaults.connectLetters,
    fitToPage: typeof source.fitToPage === 'boolean' ? source.fitToPage : defaults.fitToPage,
    placement,
  }
}

/** Drops unknown ids and out-of-range sliders. A missing store is today's defaults. */
export const normalizeToolMemory = (raw: unknown): ToolMemory => {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const defaults = defaultToolMemory()
  const figureId = isMathFigureId(source.figureId) ? source.figureId : defaults.figureId
  const mathPlacement = source.mathPlacement === 'same-line' || source.mathPlacement === 'next-line'
    ? source.mathPlacement
    : defaults.mathPlacement
  return {
    eraserSize: Math.round(clampNumber(source.eraserSize, 1, 72, defaults.eraserSize)),
    tool: source.tool === 'eraser' ? 'eraser' : 'pen',
    inkMode: source.inkMode === 'drawing' ? 'drawing' : 'writing',
    symbolId: readSymbolId(source.symbolId),
    figureId,
    figureParams: clampFigureParams(figureId, source.figureParams),
    figureSize: snap(Math.round(clampNumber(source.figureSize, 40, 320, defaults.figureSize)), 2),
    figureRotation: snap(Math.round(clampNumber(source.figureRotation, -180, 180, defaults.figureRotation)), 5),
    figureGroup: mathFigureById(figureId).group,
    handwriting: readHandwriting(source.handwriting),
    mathPlacement,
  }
}

const storage = () => {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export const loadToolMemory = (): ToolMemory => {
  try {
    const raw = storage()?.getItem(TOOL_MEMORY_KEY)
    return normalizeToolMemory(raw ? JSON.parse(raw) : null)
  } catch {
    return defaultToolMemory()
  }
}

/** Merges a partial change into the stored memory. Other tools keep their values. */
export const saveToolMemory = (patch: Partial<Omit<ToolMemory, 'handwriting' | 'figureGroup'>> & { handwriting?: Partial<HandwritingToolMemory> }) => {
  const store = storage()
  if (!store) return
  try {
    const current = loadToolMemory()
    const next = normalizeToolMemory({
      ...current,
      ...patch,
      handwriting: { ...current.handwriting, ...patch.handwriting },
      figureParams: patch.figureParams ?? current.figureParams,
    })
    store.setItem(TOOL_MEMORY_KEY, JSON.stringify(next))
  } catch {
    // Private mode or a full disk: the session still uses the live controls.
  }
}
