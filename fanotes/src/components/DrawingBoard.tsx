import {
  Calculator,
  Compass,
  Copy,
  Check,
  ChevronDown,
  CircleAlert,
  Eraser,
  FileInput,
  LoaderCircle,
  ListChecks,
  Paintbrush,
  Palette,
  PenLine,
  Redo2,
  Ruler,
  RotateCcw,
  RotateCw,
  Save,
  ScanSearch,
  Shapes,
  Sparkles,
  Trash2,
  Triangle,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  forwardRef,
  memo,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { BASE_CATALOG } from '../../../src/data/catalog'
import type {
  AutomaticRecognitionResult,
  RecognitionToken,
} from '../../../src/lib/recognition'
import type { Stroke, StrokePoint } from '../../../src/types'
import type { AppSettings, DrawingAsset, PaperStyle } from '../types'
import { PAPER_STYLES, drawPaperBackground } from '../lib/paperStyles'
import { TextToHandwritingDialog } from './TextToHandwritingDialog'
import type {
  CorrectionLearningResult,
  RecognitionResources,
} from '../lib/handwritingDb'
import { SHAPE_SNAP_LABEL, shapeSnapProfile, snapStrokeToShape, strokeLooksLikeShape } from '../lib/shapeSnap'
import {
  VIEW_ROTATE_STEP,
  VIEW_ZOOM_MIN,
  applyPaperViewToElements,
  capturePaperAnchor,
  clampViewZoom,
  clearPaperViewFromElements,
  normalizeRotation,
  readSharedZoomMax,
  readSharedZoomSpeed,
  restorePaperAnchor,
  zoomFactorFromWheel,
  zoomStepFromSpeed,
} from '../lib/paperView'
import { usePaperView } from './PaperView'
import { getHandwritingTrainingSampleCount } from '../lib/handwritingDbSummary'
import { changedMathTokenRect } from '../lib/mathCorrectionLayout'
import { groupMathInkLines, selectMathInkAtPoint } from '../lib/mathInkSelection'
import type { MathCheckResult } from '../lib/mathChecker'
import { inspectMathInputSyntax } from '../lib/mathSolverInput'
import {
  assessNeuralTextModeCandidate,
  hasDecisiveMathLayout,
} from '../lib/recognitionModeSelection'
import type { MathSolverAction, MathSolverResult } from '../lib/mathSolver'
import { detectScribbleErase } from '../lib/scribbleErase'
import { BUG_REPORT_PEN_SAMPLE_MS, diagnosticLog } from '../lib/bugReport'
import { applyToolErase } from '../lib/toolErase'
import {
  inkPointerSessionFromSample,
  resolveInkFinishSample,
  shouldAllowNewInkPointer,
  shouldHardEndInkPointerSession,
  touchInkPointerSession,
  type InkPointerSessionSnapshot,
} from '../lib/inkPointerSession'
import {
  acceptUsableInkClient,
  classifyInkJumpAppend,
  collectPreviewInkPoints,
  mapClientToPaperPoint,
  resolveInkPointerDown,
} from '../lib/inkSampleMap'
import { INLINE_INK_ACTIVE_CLASS } from '../lib/pdfInkHit'
import {
  applyPenUpInkCleanup,
  applyWheelInkPolicy,
  keepGotPointerCaptureId,
  shouldIgnorePointerAfterPen,
  shouldRejectNonPenInk,
} from '../lib/inkPointerPolicy'
import {
  PAGE_GROW_STEP_HEIGHT,
  PAGE_GROW_STEP_WIDTH,
  WRITE_SLACK_HEIGHT,
  WRITE_SLACK_WIDTH,
  growLiveInkAndMapNext,
  INK_WIDTH_ANCHOR_CLASS,
  inkExtentStyleValues,
  inkWidthNeedsAnchor,
  liveGrowScale,
  mergePendingGrow,
  nextWriteExtent,
  pendingGrowScale,
  resolvePaintedLayoutGrow,
} from '../lib/paperGrow'
import { DraftingGuides } from './DraftingGuides'
import {
  asCompassPose,
  compassRadiiNorm,
  defaultCompassPose,
  defaultRulerPose,
  defaultSetSquarePose,
  draftingToolLabel,
  formatMillimetres,
  sampleCompassArc,
  sampleCompassCircle,
  snapToDraftingTools,
  type CompassDrawEvent,
  type CompassPose,
  type DraftingDisplay,
  type DraftingKind,
  type DraftingPose,
} from '../lib/draftingTools'
import {
  createHandwritingSeed,
  synthesizeHandwriting,
  synthesizeHandwritingToFit,
  type HandwritingSynthesisResult,
  type SynthesizedInkStroke,
} from '../lib/textToHandwriting'

type HandwritingDbModule = typeof import('../lib/handwritingDb')
type KatexModule = typeof import('katex')
type RecognitionModule = typeof import('../../../src/lib/recognition')

let handwritingDbModulePromise: Promise<HandwritingDbModule> | null = null
let katexModulePromise: Promise<KatexModule> | null = null
let recognitionModulePromise: Promise<RecognitionModule> | null = null
let loadedRecognitionModule: RecognitionModule | null = null

const loadHandwritingDbModule = () => {
  handwritingDbModulePromise ??= import('../lib/handwritingDb')
  return handwritingDbModulePromise
}

const loadRecognitionResources = async (force = false) => (
  (await loadHandwritingDbModule()).loadRecognitionResources(force)
)
const clearHandwritingTraining = async () => (
  (await loadHandwritingDbModule()).clearHandwritingTraining()
)
const importGlyphenWerkZip = async (
  ...args: Parameters<HandwritingDbModule['importGlyphenWerkZip']>
) => (
  (await loadHandwritingDbModule()).importGlyphenWerkZip(...args)
)
const learnFromContextualRecognition = async (
  ...args: Parameters<HandwritingDbModule['learnFromContextualRecognition']>
) => (
  (await loadHandwritingDbModule()).learnFromContextualRecognition(...args)
)
const learnFromRecognitionCorrection = async (
  ...args: Parameters<HandwritingDbModule['learnFromRecognitionCorrection']>
) => (
  (await loadHandwritingDbModule()).learnFromRecognitionCorrection(...args)
)

const loadKatexModule = async () => {
  katexModulePromise ??= Promise.all([
    import('katex'),
    import('katex/dist/katex.min.css'),
  ]).then(([module]) => module)
  return katexModulePromise
}

const loadRecognitionModule = async () => {
  recognitionModulePromise ??= import('../../../src/lib/recognition').then((module) => {
    loadedRecognitionModule = module
    return module
  })
  return recognitionModulePromise
}

const SOURCE_WIDTH = 900
const SOURCE_HEIGHT = 1273
/** Soft cap (~40 A4 pages) so a runaway write cannot exhaust memory. */
const MAX_SOURCE_HEIGHT = SOURCE_HEIGHT * 40
/** Soft cap for horizontal growth (~20 A4 widths). */
const MAX_SOURCE_WIDTH = SOURCE_WIDTH * 20
const EXPORT_SCALE = 2
/** Cap for window.devicePixelRatio contribution. */
const MAX_DPR = 4
/**
 * When the paper is CSS-zoomed, the bitmap is stretched. Supersample up to this
 * view-zoom factor so ink stays sharp when zooming in (without unbounded RAM).
 */
const MAX_VIEW_QUALITY_ZOOM = 2.6
const MIN_INLINE_QUALITY = 1.35
const MAX_CANVAS_EDGE = 6_144
const MAX_CANVAS_PIXELS = 18_000_000
/** Tall multi-page notes (PDF worksheets) keep a lower ink bitmap budget to avoid lag. */
const MAX_CANVAS_PIXELS_TALL = 4_200_000
const TALL_LAYOUT_HEIGHT = 1_800
/** Fallback hold time after the last real movement to beautify a figure. */
const SHAPE_DWELL_MS = 700
const SHAPE_DWELL_HINT_MS = 260
const SHAPE_MOVE_RESET_PX = 1.8

/** Backing-store size for the ink canvases. Higher when zoomed in so CSS scale stays sharp. */
const computeInkPixelSize = (layoutWidth: number, layoutHeight: number, viewZoom: number, inlineMode: boolean) => {
  const screenDpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), MAX_DPR)
  const zoomBoost = Math.max(1, Math.min(MAX_VIEW_QUALITY_ZOOM, viewZoom > 1.02 ? viewZoom : 1))
  const baseBoost = inlineMode ? MIN_INLINE_QUALITY : 1
  // Multi-page worksheets make the paper very tall; keep ink supersampling moderate
  // so the overlay canvas does not compete with PDF page bitmaps for GPU memory.
  const tallFactor = layoutHeight > TALL_LAYOUT_HEIGHT
    ? Math.max(0.38, Math.min(1, TALL_LAYOUT_HEIGHT / layoutHeight))
    : 1
  let scale = screenDpr * baseBoost * zoomBoost * tallFactor
  let width = Math.max(1, Math.round(layoutWidth * scale))
  let height = Math.max(1, Math.round(layoutHeight * scale))
  const edge = Math.max(width, height)
  if (edge > MAX_CANVAS_EDGE) {
    const factor = MAX_CANVAS_EDGE / edge
    width = Math.max(1, Math.round(width * factor))
    height = Math.max(1, Math.round(height * factor))
    scale *= factor
  }
  const pixelBudget = layoutHeight > TALL_LAYOUT_HEIGHT ? MAX_CANVAS_PIXELS_TALL : MAX_CANVAS_PIXELS
  const pixels = width * height
  if (pixels > pixelBudget) {
    const factor = Math.sqrt(pixelBudget / pixels)
    width = Math.max(1, Math.round(width * factor))
    height = Math.max(1, Math.round(height * factor))
    scale *= factor
  }
  return { width, height, scale }
}

type InkWindow = { y0: number; y1: number }
const FULL_INK_WINDOW: InkWindow = { y0: 0, y1: 1 }
const inkWindowSpan = (window: InkWindow) => Math.max(0.06, Math.min(1, window.y1 - window.y0))
const isFullInkWindow = (window: InkWindow) => window.y0 <= 0.002 && window.y1 >= 0.998

const measureVisibleInkRange = (paper: HTMLElement, scroller: HTMLElement): InkWindow => {
  const view = scroller.getBoundingClientRect()
  const sheet = paper.getBoundingClientRect()
  if (sheet.height < 1_600 || sheet.height <= view.height * 1.35) return FULL_INK_WINDOW
  return {
    y0: clamp((view.top - sheet.top) / sheet.height),
    y1: clamp((view.bottom - sheet.top) / sheet.height),
  }
}

const measureInkWindow = (paper: HTMLElement, scroller: HTMLElement): InkWindow => {
  const view = scroller.getBoundingClientRect()
  const sheet = paper.getBoundingClientRect()
  if (sheet.height < 1_600 || sheet.height <= view.height * 1.35) return FULL_INK_WINDOW
  const pad = (view.height * 1.15) / Math.max(1, sheet.height)
  const y0 = clamp((view.top - sheet.top) / sheet.height - pad)
  const y1 = clamp((view.bottom - sheet.top) / sheet.height + pad)
  if (y1 - y0 >= 0.94) return FULL_INK_WINDOW
  return { y0, y1 }
}

const inkWindowsDiffer = (left: InkWindow, right: InkWindow) => (
  Math.abs(left.y0 - right.y0) > 0.04 || Math.abs(left.y1 - right.y1) > 0.04
)

const visibleFitsInkWindow = (window: InkWindow, visible: InkWindow) => {
  if (isFullInkWindow(visible)) return isFullInkWindow(window)
  if (isFullInkWindow(window)) return true
  const margin = 0.05
  return visible.y0 >= window.y0 + margin && visible.y1 <= window.y1 - margin
}

const strokeIntersectsWindow = (stroke: { points: Array<{ y: number }> }, window: InkWindow) => {
  let minY = 1
  let maxY = 0
  for (const point of stroke.points) {
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }
  const pad = 0.03
  return maxY >= window.y0 - pad && minY <= window.y1 + pad
}

const applyInkWindowToCanvases = (canvases: Array<HTMLCanvasElement | null>, window: InkWindow) => {
  const top = isFullInkWindow(window) ? '0' : `${window.y0 * 100}%`
  const height = isFullInkWindow(window) ? '100%' : `${inkWindowSpan(window) * 100}%`
  for (const canvas of canvases) {
    if (!canvas) continue
    if (canvas.style.top !== top) canvas.style.top = top
    if (canvas.style.height !== height) canvas.style.height = height
  }
}

const wipeLiveInkCanvas = (canvas: HTMLCanvasElement | null) => {
  if (!canvas || !canvas.width || !canvas.height) return
  const context = canvas.getContext('2d', { alpha: true })
  if (!context) return
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
}

const releasePointerCaptureSafe = (target: EventTarget | null, pointerId: number) => {
  if (!(target instanceof Element)) return
  try {
    if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId)
  } catch {
    // Chromium on Wayland can throw if capture was already cleared by the compositor.
  }
}

const releaseInkPointerCaptures = (targets: Array<EventTarget | null | undefined>, pointerId: number | null) => {
  if (pointerId === null) return
  for (const target of targets) releasePointerCaptureSafe(target ?? null, pointerId)
}

const clearInkCursor = () => {
  try {
    document.documentElement.style.removeProperty('cursor')
    document.body.style.removeProperty('cursor')
  } catch {
    // ignore
  }
}

const isInkSurfaceTarget = (target: EventTarget | null) => (
  target instanceof Element && Boolean(target.closest('.lw-canvas-surface, .lw-tablet-canvas'))
)

/** Toolbar, ribbon and menus — never treat these as the ink surface. */
const CHROME_HIT_SELECTOR = [
  '.editor-toolbar',
  '.toolbar-button',
  '.ink-toolbar-slot',
  '.lw-draw-toolbar',
  '.lw-draw-notice',
  '.lw-conversion-panel',
  '.lw-art-studio',
  '.lw-draw-footer',
  '.editor-more-menu',
  '.ribbon',
  '.tabs-bar',
  '.tabs-menu',
  '.note-tab',
  '.paper-view-hud',
  '.sidebar',
  '.statusbar',
  '[data-fanotes-drawing-chrome]',
  'button',
  'select',
  'input',
  'textarea',
  'a',
  '[role="button"]',
  '[role="menuitem"]',
].join(', ')

const elementFromPointSafe = (x: number, y: number) => {
  try {
    return document.elementFromPoint(x, y)
  } catch {
    return null
  }
}

/** Real hit under the cursor — ignores leftover pointer-capture retargeting. */
const hitTestChrome = (clientX: number, clientY: number) => {
  const hit = elementFromPointSafe(clientX, clientY)
  if (!(hit instanceof Element)) return null
  if (hit.closest('.lw-canvas-surface, .lw-tablet-canvas')) return null
  return hit.closest(CHROME_HIT_SELECTOR)
}

const clickableChromeControl = (chrome: Element) => (
  chrome.closest('button, [role="button"], [role="menuitem"], select, a, input, textarea, label')
)

const releaseStuckInputFocus = (preferred?: HTMLElement | null) => {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return
  // Keep intentional board focus (keyboard shortcuts), but never leave the
  // canvas itself focused after pen input — that traps keys/scroll on Hyprland.
  if (active.classList.contains('lw-tablet-canvas')) {
    try { active.blur() } catch { /* ignore */ }
    if (preferred && preferred !== active) {
      try { preferred.focus({ preventScroll: true }) } catch { /* ignore */ }
    }
    return
  }
  if (active === preferred) return
  if (active.closest?.('.lw-drawing-board') && active.tagName === 'CANVAS') {
    try { active.blur() } catch { /* ignore */ }
  }
}

type DrawingTool = 'pen' | 'eraser'
type InkMode = 'writing' | 'drawing'
type ArtStudioTab = 'brushes' | 'colors' | 'symbols'
type ArtBrush = 'fineliner' | 'pencil' | 'marker' | 'paintbrush' | 'calligraphy' | 'highlighter' | 'watercolor' | 'spray'
type InkEffect = 'solid' | 'rainbow' | 'aurora' | 'sunset' | 'ocean' | 'gold' | 'silver' | 'neon'
type ArtSymbolCategory = 'all' | 'school' | 'symbols' | 'everyday'
type ArtSymbolId =
  | 'book' | 'calculator' | 'flask' | 'atom' | 'globe' | 'lightbulb' | 'pencil' | 'laptop'
  | 'star' | 'heart' | 'check' | 'warning' | 'info' | 'question' | 'flag' | 'arrow'
  | 'home' | 'user' | 'users' | 'clock' | 'calendar' | 'camera' | 'music' | 'smile' | 'chat'
type RecognitionMode = 'math' | 'text'
type RecognitionPreference = 'auto' | RecognitionMode
type RecognitionScope = 'page' | 'selection'
type SelectionPurpose = 'conversion' | 'math-correction' | 'edit'
type MathSolverPlacement = 'auto' | 'same-line' | 'next-line'

type SelectionRect = {
  x: number
  y: number
  width: number
  height: number
}

type InkStroke = Stroke & {
  color: string
  purpose?: 'handwriting' | 'art'
  brush?: ArtBrush
  colorEffect?: InkEffect
  opacity?: number
  textureSeed?: number
  symbolId?: ArtSymbolId
  symbolRotation?: number
}

type MathSolverHistoryEntry = {
  action: MathSolverAction
  input: string
  output: string[]
  placement: Exclude<MathSolverPlacement, 'auto'>
  fontSize: number
  lineSpacing: number
  createdAt: string
}

type MathSolverSelection = {
  rect: SelectionRect
  strokes: InkStroke[]
  tokens: RecognitionToken[]
  status: 'recognizing' | 'ready' | 'error'
  input: string
  latex: string
  confidence: number
  error?: string
}

type MathCorrectionLine = {
  id: string
  strokes: InkStroke[]
  tokens: RecognitionToken[]
  rect: SelectionRect
  input: string
  latex: string
  confidence: number
  recognitionRisk: boolean
  confirmed: boolean
}

type MathCorrectionSession = {
  rect: SelectionRect
  status: 'recognizing' | 'checking' | 'editing' | 'ready' | 'error'
  lines: MathCorrectionLine[]
  result?: MathCheckResult
  error?: string
}

type PendingSolverTap = {
  stroke: InkStroke
  snapshot: InkStroke[]
  point: Pick<StrokePoint, 'x' | 'y'>
  at: number
  timer: number
}

type DrawingDocument = {
  schemaVersion: 1
  title: string
  paperStyle: PaperStyle
  sourceWidth: number
  sourceHeight: number
  createdAt: string
  updatedAt: string
  strokes: InkStroke[]
  searchTranscript?: string
  transcriptMode?: 'text-and-math'
  transcriptUpdatedAt?: string
  recognitionPreference?: RecognitionPreference
  detectedRecognitionMode?: RecognitionMode
  mathSolverEnabled?: boolean
  mathSolverHistory?: MathSolverHistoryEntry[]
}

export type DrawingSavePayload = {
  id?: string
  title: string
  /** Generated only when a Markdown image is explicitly requested. */
  imageData?: string
  drawingJson: string
}

export type DrawingSaveResult =
  | DrawingAsset
  | { markdown?: string; imageRelativePath?: string }
  | string
  | void

export type DrawingBoardHandle = {
  flush: () => Promise<void>
  refreshTraining: () => Promise<void>
  supportSnapshot?: () => { tool: string; inkMode: string }
  applySupportTool?: (tool: string) => void
}

export type DrawingBoardProps = {
  settings: Pick<
    AppSettings,
    | 'paperStyle'
    | 'penColor'
    | 'penWidth'
    | 'pressureEnabled'
    | 'penOnly'
    | 'smoothing'
    | 'scribbleEraseSensitivity'
    | 'shapeSnapSensitivity'
    | 'recognitionMode'
    | 'lastRecognitionMode'
    | 'recognitionLanguage'
    | 'enhancedMathRecognition'
    | 'enhancedMathLicenseAccepted'
    | 'qwenVisionRecognition'
    | 'qwenVisionLicenseAccepted'
    | 'experimentalHandwritingToText'
    | 'viewZoomSpeed'
    | 'viewZoomMax'
    | 'autoOpenConversion'
    | 'keepDrawingAfterInsert'
  >
  drawingId?: string
  title?: string
  initialDrawingJson?: string | null
  className?: string
  /** Renders the ink as a transparent layer on the normal note page. */
  inline?: boolean
  /** Enables pointer input without replacing or hiding the keyboard editor. */
  inputActive?: boolean
  onSaveDrawing: (payload: DrawingSavePayload) => Promise<DrawingSaveResult>
  /** Returns true only when the Markdown was actually inserted into an open note. */
  onInsertMarkdown: (markdown: string) => boolean | Promise<boolean>
  onSettingsChange?: (settings: Partial<AppSettings>) => void
  onDirtyChange?: (dirty: boolean) => void
  onTrainingChanged?: (sampleCount: number) => void
  onOpenGlyphenWerk?: () => void
  onClose?: () => void
  pagePaperStyle?: PaperStyle
  onPagePaperChange?: (style: PaperStyle) => void
}

type Notice = { kind: 'success' | 'error' | 'info'; text: string }

const INK_TOOLBAR_SLOT_ID = 'fanotes-ink-toolbar-slot'

const cloneStrokes = (strokes: InkStroke[]): InkStroke[] => strokes.map((stroke) => ({
  ...stroke,
  points: stroke.points.map((point) => ({ ...point })),
}))

// Committed strokes are immutable. History can therefore share their point arrays
// instead of copying an entire page on every pen-down event.
const snapshotStrokes = (strokes: InkStroke[]): InkStroke[] => strokes.slice()

const BACKGROUND_RECOGNITION_CHUNK = 24

/**
 * Keeps invisible indexing cooperative. Whole-page recognition scales poorly
 * because spatial segmentation compares many stroke pairs; bounded row chunks
 * keep each main-thread slice short and preserve fractions/scripts in a row.
 */
const backgroundRecognitionChunks = (strokes: InkStroke[], sourceHeight: number): InkStroke[][] => {
  void sourceHeight
  const ordered = handwritingStrokes(strokes)
    .map((stroke) => {
      let left = 1
      let centerY = 0
      stroke.points.forEach((point) => {
        left = Math.min(left, point.x)
        centerY += point.y
      })
      return { stroke, left, centerY: centerY / Math.max(1, stroke.points.length) }
    })
    .sort((first, second) => first.centerY - second.centerY || first.left - second.left)
    .map(({ stroke }) => stroke)
  const chunks: InkStroke[][] = []
  for (let index = 0; index < ordered.length; index += BACKGROUND_RECOGNITION_CHUNK) {
    chunks.push(ordered.slice(index, index + BACKGROUND_RECOGNITION_CHUNK))
  }
  return chunks
}

const waitForBackgroundIdle = () => new Promise<void>((resolve) => {
  window.requestIdleCallback(() => resolve(), { timeout: 1_500 })
})

const bottomOfStrokes = (strokes: InkStroke[], sourceHeight: number) => strokes.reduce((bottom, stroke) => (
  stroke.points.reduce((strokeBottom, point) => Math.max(strokeBottom, point.y * sourceHeight), bottom)
), 0)

const inkAbsoluteBounds = (strokes: InkStroke[], sourceWidth: number, sourceHeight: number) => {
  let maxX = 0
  let maxY = 0
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      maxX = Math.max(maxX, point.x * sourceWidth)
      maxY = Math.max(maxY, point.y * sourceHeight)
    }
  }
  return { maxX, maxY }
}

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))

const selectionBetween = (start: Pick<StrokePoint, 'x' | 'y'>, end: Pick<StrokePoint, 'x' | 'y'>): SelectionRect => ({
  x: Math.min(start.x, end.x),
  y: Math.min(start.y, end.y),
  width: Math.abs(end.x - start.x),
  height: Math.abs(end.y - start.y),
})

const strokeIntersectsSelection = (stroke: InkStroke, selection: SelectionRect) => {
  if (!stroke.points.length) return false
  const padding = Math.max(0.003, stroke.baseWidth / SOURCE_WIDTH / 2)
  const left = Math.min(...stroke.points.map((point) => point.x)) - padding
  const right = Math.max(...stroke.points.map((point) => point.x)) + padding
  const top = Math.min(...stroke.points.map((point) => point.y)) - padding
  const bottom = Math.max(...stroke.points.map((point) => point.y)) + padding
  return right >= selection.x
    && left <= selection.x + selection.width
    && bottom >= selection.y
    && top <= selection.y + selection.height
}

const pressureWidth = (stroke: Stroke, pressure: number) => {
  if (!stroke.pressureEnabled) return stroke.baseWidth
  return stroke.baseWidth * (0.4 + Math.max(0.08, pressure) * 1.12)
}

const seededUnit = (seed: number) => {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43_758.5453
  return value - Math.floor(value)
}

const strokePaint = (
  context: CanvasRenderingContext2D,
  stroke: InkStroke,
  width: number,
  height: number,
) => {
  const effect = stroke.colorEffect ?? 'solid'
  if (effect === 'solid') return stroke.color
  const special = SPECIAL_INKS.find(({ id }) => id === effect)
  if (!special) return stroke.color
  const gradient = context.createLinearGradient(0, height * .08, width, height * .28)
  special.stops.forEach(([offset, color]) => gradient.addColorStop(offset, color))
  return gradient
}

const paperLabel: Record<PaperStyle, string> = Object.fromEntries(
  PAPER_STYLES.map((item) => [item.id, item.label]),
) as Record<PaperStyle, string>

const colorChoices = ['#191c24', '#3d52d5', '#7654d6', '#d74769', '#df7627', '#138d75']
const artColorChoices = [
  '#17191f', '#ffffff', '#6c727f', '#d83b52', '#f06c32', '#f2b735', '#77ad3a',
  '#1ca982', '#21a8c7', '#3478df', '#6548dc', '#a444cf', '#e5489a', '#8b5a3c',
]

const ART_BRUSHES: ReadonlyArray<{
  id: ArtBrush
  label: string
  description: string
  defaultWidth: number
  pressure: boolean
}> = [
  { id: 'fineliner', label: 'Fineliner', description: 'klar & präzise', defaultWidth: 3, pressure: false },
  { id: 'pencil', label: 'Bleistift', description: 'weich texturiert', defaultWidth: 3.5, pressure: true },
  { id: 'marker', label: 'Marker', description: 'satt & gleichmässig', defaultWidth: 9, pressure: false },
  { id: 'paintbrush', label: 'Pinsel', description: 'dynamischer Druck', defaultWidth: 11, pressure: true },
  { id: 'calligraphy', label: 'Kalligrafie', description: 'schräge Breitfeder', defaultWidth: 9, pressure: true },
  { id: 'highlighter', label: 'Textmarker', description: 'transparent', defaultWidth: 22, pressure: false },
  { id: 'watercolor', label: 'Aquarell', description: 'lasierende Kanten', defaultWidth: 20, pressure: true },
  { id: 'spray', label: 'Spray', description: 'feine Partikel', defaultWidth: 26, pressure: false },
]

type ArtSymbolDefinition = {
  id: ArtSymbolId
  label: string
  category: Exclude<ArtSymbolCategory, 'all'>
  paths: readonly string[]
}

const ART_SYMBOL_CATEGORIES: ReadonlyArray<{ id: ArtSymbolCategory; label: string }> = [
  { id: 'all', label: 'Alle' },
  { id: 'school', label: 'Schule' },
  { id: 'symbols', label: 'Zeichen' },
  { id: 'everyday', label: 'Alltag' },
]

// Path-only SVGs keep the symbols crisp at every size in Electron, Windows and the web app.
const ART_SYMBOLS: readonly ArtSymbolDefinition[] = [
  { id: 'book', label: 'Buch', category: 'school', paths: ['M2 4.5A2.5 2.5 0 0 1 4.5 2H9a3 3 0 0 1 3 3v17a3 3 0 0 0-3-3H2Z', 'M22 4.5A2.5 2.5 0 0 0 19.5 2H15a3 3 0 0 0-3 3v17a3 3 0 0 1 3-3h7Z'] },
  { id: 'calculator', label: 'Rechner', category: 'school', paths: ['M5 2h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z', 'M7 6h10v4H7Z', 'M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01'] },
  { id: 'flask', label: 'Labor', category: 'school', paths: ['M9 3h6', 'M10 3v6l-6.8 10.2A1.8 1.8 0 0 0 4.7 22h14.6a1.8 1.8 0 0 0 1.5-2.8L14 9V3', 'M6.5 17h11'] },
  { id: 'atom', label: 'Atom', category: 'school', paths: ['M12 12h.01', 'M19.1 4.9c2.8 2.8-1.1 11.1-6.2 16.2S1.5 18.3 4.9 14.9 16.3 1.5 19.1 4.9Z', 'M4.9 4.9c-2.8 2.8 1.1 11.1 6.2 16.2s11.4-2.8 8-6.2S7.7 1.5 4.9 4.9Z'] },
  { id: 'globe', label: 'Globus', category: 'school', paths: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M2 12h20', 'M12 2a15.3 15.3 0 0 1 0 20', 'M12 2a15.3 15.3 0 0 0 0 20'] },
  { id: 'lightbulb', label: 'Idee', category: 'school', paths: ['M9 18h6', 'M10 22h4', 'M8.5 15.5A7 7 0 1 1 15.5 15.5C14.5 16.3 14 17 14 18h-4c0-1-.5-1.7-1.5-2.5Z'] },
  { id: 'pencil', label: 'Stift', category: 'school', paths: ['M4 20l4.2-1 11-11a2.1 2.1 0 0 0-3-3l-11 11Z', 'M14.8 6.2l3 3', 'M4 20l3-3'] },
  { id: 'laptop', label: 'Computer', category: 'school', paths: ['M4 4h16v12H4Z', 'M2 20h20', 'M8 20l1-4h6l1 4'] },
  { id: 'star', label: 'Stern', category: 'symbols', paths: ['M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9Z'] },
  { id: 'heart', label: 'Herz', category: 'symbols', paths: ['M20.8 4.7a5.5 5.5 0 0 0-7.8 0L12 5.8l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.5a5.5 5.5 0 0 0 0-7.8Z'] },
  { id: 'check', label: 'Haken', category: 'symbols', paths: ['M20 6 9 17l-5-5'] },
  { id: 'warning', label: 'Warnung', category: 'symbols', paths: ['M10.3 3.7 2.5 18a2 2 0 0 0 1.8 3h15.4a2 2 0 0 0 1.8-3L13.7 3.7a2 2 0 0 0-3.4 0Z', 'M12 9v4', 'M12 17h.01'] },
  { id: 'info', label: 'Information', category: 'symbols', paths: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 10v6', 'M12 7h.01'] },
  { id: 'question', label: 'Frage', category: 'symbols', paths: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M9.5 9a2.7 2.7 0 1 1 4.5 2c-1.3 1-2 1.4-2 3', 'M12 17h.01'] },
  { id: 'flag', label: 'Markierung', category: 'symbols', paths: ['M5 22V3', 'M5 4h12l-2 4 2 4H5'] },
  { id: 'arrow', label: 'Pfeil', category: 'symbols', paths: ['M5 12h14', 'm13 6 6 6-6 6'] },
  { id: 'home', label: 'Haus', category: 'everyday', paths: ['m3 11 9-8 9 8', 'M5 10v11h14V10', 'M9 21v-7h6v7'] },
  { id: 'user', label: 'Person', category: 'everyday', paths: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M4 21a8 8 0 0 1 16 0'] },
  { id: 'users', label: 'Gruppe', category: 'everyday', paths: ['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M2 21a7 7 0 0 1 14 0', 'M16 4a4 4 0 0 1 0 7', 'M18 21a6 6 0 0 0-4-5.6'] },
  { id: 'clock', label: 'Uhr', category: 'everyday', paths: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M12 6v6l4 2'] },
  { id: 'calendar', label: 'Kalender', category: 'everyday', paths: ['M5 3v4M19 3v4', 'M3 6h18v15H3Z', 'M3 10h18'] },
  { id: 'camera', label: 'Kamera', category: 'everyday', paths: ['M14.5 5 13 3h-2L9.5 5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z', 'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z'] },
  { id: 'music', label: 'Musik', category: 'everyday', paths: ['M9 18V5l11-2v13', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M17 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z'] },
  { id: 'smile', label: 'Smiley', category: 'everyday', paths: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z', 'M8 9h.01M16 9h.01', 'M8 14a5 5 0 0 0 8 0'] },
  { id: 'chat', label: 'Sprechblase', category: 'everyday', paths: ['M21 15a4 4 0 0 1-4 4H8l-5 3 1.5-5A7.7 7.7 0 0 1 3 12a7 7 0 0 1 7-7h7a4 4 0 0 1 4 4Z'] },
]

const artSymbolIds = new Set<ArtSymbolId>(ART_SYMBOLS.map(({ id }) => id))
const artSymbolById = new Map<ArtSymbolId, ArtSymbolDefinition>(ART_SYMBOLS.map((symbol) => [symbol.id, symbol]))

const ArtSymbolPreview = ({ symbol, size = 24 }: { symbol: ArtSymbolDefinition; size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {symbol.paths.map((path, index) => <path key={`${symbol.id}-${index}`} d={path} />)}
  </svg>
)

const SPECIAL_INKS: ReadonlyArray<{ id: Exclude<InkEffect, 'solid'>; label: string; css: string; stops: ReadonlyArray<readonly [number, string]> }> = [
  { id: 'rainbow', label: 'Regenbogen', css: 'linear-gradient(90deg,#ff4d6d,#ffb13b,#e9e34a,#48ce87,#3aa8ff,#815cff,#e84dba)', stops: [[0, '#ff4d6d'], [.17, '#ffb13b'], [.34, '#e9e34a'], [.51, '#48ce87'], [.68, '#3aa8ff'], [.84, '#815cff'], [1, '#e84dba']] },
  { id: 'aurora', label: 'Aurora', css: 'linear-gradient(110deg,#68f6ca,#32b9ef,#7968f4,#e85bd2)', stops: [[0, '#68f6ca'], [.34, '#32b9ef'], [.68, '#7968f4'], [1, '#e85bd2']] },
  { id: 'sunset', label: 'Abendrot', css: 'linear-gradient(110deg,#ffcf59,#ff754e,#d84dba,#694ee8)', stops: [[0, '#ffcf59'], [.36, '#ff754e'], [.68, '#d84dba'], [1, '#694ee8']] },
  { id: 'ocean', label: 'Ozean', css: 'linear-gradient(110deg,#62ead5,#1eb6db,#2671df,#4036a9)', stops: [[0, '#62ead5'], [.36, '#1eb6db'], [.7, '#2671df'], [1, '#4036a9']] },
  { id: 'gold', label: 'Gold', css: 'linear-gradient(105deg,#7c5013,#f7d779,#b27620,#fff0a8,#8b5914)', stops: [[0, '#7c5013'], [.24, '#f7d779'], [.5, '#b27620'], [.76, '#fff0a8'], [1, '#8b5914']] },
  { id: 'silver', label: 'Silber', css: 'linear-gradient(105deg,#59616d,#f5f7fb,#8b929d,#ffffff,#626975)', stops: [[0, '#59616d'], [.24, '#f5f7fb'], [.5, '#8b929d'], [.76, '#ffffff'], [1, '#626975']] },
  { id: 'neon', label: 'Neon', css: 'linear-gradient(105deg,#45ffe6,#5e8bff,#db55ff,#ff4ba8)', stops: [[0, '#45ffe6'], [.34, '#5e8bff'], [.68, '#db55ff'], [1, '#ff4ba8']] },
]

const ART_PREFERENCES_KEY = 'fanotes.art-tools.v1'
const artBrushIds = new Set<ArtBrush>(ART_BRUSHES.map(({ id }) => id))
const inkEffectIds = new Set<InkEffect>(['solid', ...SPECIAL_INKS.map(({ id }) => id)])
const isHandwritingStroke = (stroke: InkStroke) => stroke.purpose !== 'art'
const handwritingStrokes = (strokes: InkStroke[]) => strokes.filter(isHandwritingStroke)

const loadArtPreferences = () => {
  const fallback = { brush: 'fineliner' as ArtBrush, color: '#3478df', effect: 'solid' as InkEffect, width: 3, opacity: 1, symbolSize: 72, symbolRotation: 0 }
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(ART_PREFERENCES_KEY) ?? '{}') as Partial<typeof fallback>
    return {
      brush: raw.brush && artBrushIds.has(raw.brush) ? raw.brush : fallback.brush,
      color: typeof raw.color === 'string' && /^#[\da-f]{6}$/iu.test(raw.color) ? raw.color : fallback.color,
      effect: raw.effect && inkEffectIds.has(raw.effect) ? raw.effect : fallback.effect,
      width: clamp(Number(raw.width) || fallback.width, .75, 42),
      opacity: clamp(Number(raw.opacity) || fallback.opacity, .12, 1),
      symbolSize: clamp(Number(raw.symbolSize) || fallback.symbolSize, 20, 180),
      symbolRotation: clamp(Number(raw.symbolRotation) || fallback.symbolRotation, -180, 180),
    }
  } catch {
    return fallback
  }
}

const drawPaper = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  style: PaperStyle,
) => {
  drawPaperBackground(context, width, height, style)
}

const drawInkStroke = (
  context: CanvasRenderingContext2D,
  stroke: InkStroke,
  width: number,
  height: number,
  smoothing: number,
  startSegment = 1,
  sourceWidth = SOURCE_WIDTH,
) => {
  if (stroke.points.length === 0) return
  const first = stroke.points[0]
  // baseWidth is in original page units; map through the current logical page width.
  const scale = width / Math.max(1, sourceWidth)
  const brush = stroke.purpose === 'art' ? stroke.brush ?? 'fineliner' : 'fineliner'
  const opacity = stroke.purpose === 'art' ? clamp(stroke.opacity ?? 1, .08, 1) : 1
  const paint = strokePaint(context, stroke, width, height)
  context.save()
  context.strokeStyle = paint
  context.fillStyle = paint
  context.lineCap = 'round'
  context.lineJoin = 'round'
  if (brush === 'highlighter') context.globalCompositeOperation = 'multiply'
  if (stroke.colorEffect === 'neon') {
    context.shadowColor = stroke.color
    context.shadowBlur = Math.max(4, stroke.baseWidth * scale * .85)
  }

  const symbol = stroke.symbolId ? artSymbolById.get(stroke.symbolId) : undefined
  if (symbol) {
    const symbolScale = stroke.baseWidth * scale / 24
    context.globalAlpha = opacity
    context.translate(first.x * width, first.y * height)
    context.rotate((stroke.symbolRotation ?? 0) * Math.PI / 180)
    context.scale(symbolScale, symbolScale)
    context.translate(-12, -12)
    context.lineWidth = 1.75
    symbol.paths.forEach((path) => context.stroke(new Path2D(path)))
    context.restore()
    return
  }

  const spraySegment = (previous: StrokePoint, point: StrokePoint, index: number) => {
    const previousX = previous.x * width
    const previousY = previous.y * height
    const pointX = point.x * width
    const pointY = point.y * height
    const radius = pressureWidth(stroke, (previous.pressure + point.pressure) / 2) * scale / 2
    const particles = Math.round(clamp(stroke.baseWidth * .68, 6, 24))
    const seed = stroke.textureSeed ?? 1
    for (let particle = 0; particle < particles; particle += 1) {
      const key = seed + index * 1_009 + particle * 37
      const progress = seededUnit(key + 1)
      const angle = seededUnit(key + 2) * Math.PI * 2
      const spread = Math.sqrt(seededUnit(key + 3)) * radius
      const x = previousX + (pointX - previousX) * progress + Math.cos(angle) * spread
      const y = previousY + (pointY - previousY) * progress + Math.sin(angle) * spread
      const particleRadius = Math.max(.35, scale * (.28 + seededUnit(key + 4) * .62))
      context.globalAlpha = opacity * (.2 + seededUnit(key + 5) * .5)
      context.beginPath()
      context.arc(x, y, particleRadius, 0, Math.PI * 2)
      context.fill()
    }
  }

  const calligraphySegment = (previous: StrokePoint, point: StrokePoint) => {
    const previousX = previous.x * width
    const previousY = previous.y * height
    const pointX = point.x * width
    const pointY = point.y * height
    const nibWidth = pressureWidth(stroke, (previous.pressure + point.pressure) / 2) * scale
    const nibX = Math.cos(-Math.PI * .22) * nibWidth / 2
    const nibY = Math.sin(-Math.PI * .22) * nibWidth / 2
    context.globalAlpha = opacity
    context.beginPath()
    context.moveTo(previousX + nibX, previousY + nibY)
    context.lineTo(pointX + nibX, pointY + nibY)
    context.lineTo(pointX - nibX, pointY - nibY)
    context.lineTo(previousX - nibX, previousY - nibY)
    context.closePath()
    context.fill()
  }

  if (stroke.points.length === 1 && startSegment <= 1) {
    if (brush === 'spray') {
      spraySegment(first, first, 0)
    } else if (brush === 'calligraphy') {
      const nibWidth = pressureWidth(stroke, first.pressure) * scale
      context.globalAlpha = opacity
      context.beginPath()
      context.ellipse(first.x * width, first.y * height, nibWidth / 2, Math.max(.5, nibWidth * .16), -Math.PI * .22, 0, Math.PI * 2)
      context.fill()
    } else {
      context.globalAlpha = brush === 'highlighter' ? opacity * .32 : opacity
      context.beginPath()
      context.arc(
        first.x * width,
        first.y * height,
        pressureWidth(stroke, first.pressure) * scale / 2,
        0,
        Math.PI * 2,
      )
      context.fill()
    }
    context.restore()
    return
  }

  for (let index = Math.max(1, startSegment); index < stroke.points.length; index += 1) {
    const previous = stroke.points[index - 1]
    const point = stroke.points[index]
    const previousX = previous.x * width
    const previousY = previous.y * height
    const pointX = point.x * width
    const pointY = point.y * height
    if (brush === 'spray') {
      spraySegment(previous, point, index)
      continue
    }
    if (brush === 'calligraphy') {
      calligraphySegment(previous, point)
      continue
    }

    const segment = (widthFactor: number, alpha: number, offsetX = 0, offsetY = 0) => {
      context.globalAlpha = opacity * alpha
      context.beginPath()
      context.moveTo(previousX + offsetX, previousY + offsetY)
      if (smoothing > 0 && index < stroke.points.length - 1) {
        const next = stroke.points[index + 1]
        const blend = clamp(smoothing, 0, .92)
        const midpointX = pointX * (1 - blend * .35) + ((pointX + next.x * width) / 2) * blend * .35
        const midpointY = pointY * (1 - blend * .35) + ((pointY + next.y * height) / 2) * blend * .35
        context.quadraticCurveTo(pointX + offsetX, pointY + offsetY, midpointX + offsetX, midpointY + offsetY)
      } else if (smoothing > 0 && index >= 2) {
        // Live tip: no next point yet, so continue the incoming direction
        // instead of a sharp corner, while still ending under the stylus.
        const before = stroke.points[index - 2]
        const blend = clamp(smoothing, 0, .92)
        const controlX = previousX + (previous.x - before.x) * width * blend * 0.4
        const controlY = previousY + (previous.y - before.y) * height * blend * 0.4
        context.quadraticCurveTo(controlX + offsetX, controlY + offsetY, pointX + offsetX, pointY + offsetY)
      } else {
        context.lineTo(pointX + offsetX, pointY + offsetY)
      }
      context.lineWidth = pressureWidth(stroke, (previous.pressure + point.pressure) / 2) * scale * widthFactor
      context.stroke()
    }

    if (brush === 'pencil') {
      segment(.72, .58)
      const seed = (stroke.textureSeed ?? 1) + index * 53
      segment(.22, .2, (seededUnit(seed) - .5) * scale * 1.4, (seededUnit(seed + 1) - .5) * scale * 1.4)
      segment(.18, .14, (seededUnit(seed + 2) - .5) * scale * 1.8, (seededUnit(seed + 3) - .5) * scale * 1.8)
    } else if (brush === 'paintbrush') {
      segment(1.4, .16)
      segment(.92, .82)
    } else if (brush === 'highlighter') {
      context.lineCap = 'butt'
      segment(1, .34)
    } else if (brush === 'watercolor') {
      segment(1.48, .11)
      segment(1.14, .17)
      segment(.78, .27)
    } else if (brush === 'marker') {
      segment(1, .9)
    } else {
      segment(1, 1)
    }
  }
  context.restore()
}

const renderDocument = (
  canvas: HTMLCanvasElement,
  strokes: InkStroke[],
  paperStyle: PaperStyle,
  smoothing: number,
  width: number,
  height: number,
  includePaper = true,
  sourceWidth = SOURCE_WIDTH,
  inkWindow: InkWindow = FULL_INK_WINDOW,
) => {
  const context = canvas.getContext('2d')
  if (!context) return
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  if (includePaper) drawPaper(context, width, height, paperStyle)
  const span = inkWindowSpan(inkWindow)
  const virtualHeight = height / span
  context.save()
  context.beginPath()
  context.rect(0, 0, width, height)
  context.clip()
  context.setTransform(1, 0, 0, 1, 0, -inkWindow.y0 * virtualHeight)
  const visible = isFullInkWindow(inkWindow) ? strokes : strokes.filter((stroke) => strokeIntersectsWindow(stroke, inkWindow))
  visible.forEach((stroke) => drawInkStroke(context, stroke, width, virtualHeight, smoothing, 1, sourceWidth))
  context.restore()
}

const safeInkStrokes = (value: unknown, fallbackColor: string): InkStroke[] => {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const raw = entry as Partial<InkStroke>
    if (!Array.isArray(raw.points)) return []
    const points = raw.points.flatMap((point) => {
      if (!point || typeof point !== 'object') return []
      return [{
        x: clamp(Number(point.x) || 0),
        y: clamp(Number(point.y) || 0),
        t: Number(point.t) || 0,
        pressure: clamp(Number(point.pressure) || 0.5),
        tiltX: clamp(Number(point.tiltX) || 0, -90, 90),
        tiltY: clamp(Number(point.tiltY) || 0, -90, 90),
        pointerType: typeof point.pointerType === 'string' ? point.pointerType : 'pen',
      }]
    })
    if (!points.length) return []
    const symbolId = raw.symbolId && artSymbolIds.has(raw.symbolId) ? raw.symbolId : undefined
    return [{
      points,
      baseWidth: clamp(Number(raw.baseWidth) || 4, 0.5, symbolId ? 180 : 48),
      pressureEnabled: raw.pressureEnabled !== false,
      color: typeof raw.color === 'string' && /^#[\da-f]{6}$/iu.test(raw.color) ? raw.color : fallbackColor,
      purpose: raw.purpose === 'art' ? 'art' : 'handwriting',
      brush: raw.brush && artBrushIds.has(raw.brush) ? raw.brush : undefined,
      colorEffect: raw.colorEffect && inkEffectIds.has(raw.colorEffect) ? raw.colorEffect : 'solid',
      opacity: clamp(Number(raw.opacity) || 1, .08, 1),
      textureSeed: Math.round(clamp(Math.abs(Number(raw.textureSeed) || 1), 1, 2_147_483_647)),
      symbolId,
      symbolRotation: symbolId ? clamp(Number(raw.symbolRotation) || 0, -180, 180) : undefined,
    }]
  })
}

const safeMathSolverHistory = (value: unknown): MathSolverHistoryEntry[] => {
  if (!Array.isArray(value)) return []
  const actions = new Set<MathSolverAction>(['simplify', 'solve', 'expand', 'factor', 'calculate'])
  return value.slice(-24).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const raw = entry as Partial<MathSolverHistoryEntry>
    if (!raw.action || !actions.has(raw.action) || typeof raw.input !== 'string' || !Array.isArray(raw.output)) return []
    return [{
      action: raw.action,
      input: raw.input.slice(0, 512),
      output: raw.output.filter((item): item is string => typeof item === 'string').slice(0, 8),
      placement: raw.placement === 'same-line' ? 'same-line' : 'next-line',
      fontSize: clamp(Number(raw.fontSize) || 34, 18, 72),
      lineSpacing: clamp(Number(raw.lineSpacing) || 1.42, 1, 2.4),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    }]
  })
}

const MATH_SOLVER_HISTORY_KEY = 'fanotes.math-solver-format.v1'

const sharedMathSolverHistory = () => {
  try {
    return safeMathSolverHistory(JSON.parse(globalThis.localStorage?.getItem(MATH_SOLVER_HISTORY_KEY) ?? '[]'))
  } catch {
    return []
  }
}

const saveSharedMathSolverHistory = (history: MathSolverHistoryEntry[]) => {
  try {
    globalThis.localStorage?.setItem(MATH_SOLVER_HISTORY_KEY, JSON.stringify(history.slice(-24)))
  } catch {
    // Per-document history still preserves formatting if browser storage is unavailable.
  }
}

const median = (values: number[]) => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const isShortTapStroke = (stroke: InkStroke, sourceWidth: number, sourceHeight: number) => {
  if (!stroke.points.length) return false
  const width = (Math.max(...stroke.points.map((point) => point.x)) - Math.min(...stroke.points.map((point) => point.x))) * sourceWidth
  const height = (Math.max(...stroke.points.map((point) => point.y)) - Math.min(...stroke.points.map((point) => point.y))) * sourceHeight
  const duration = (stroke.points.at(-1)?.t ?? 0) - (stroke.points[0]?.t ?? 0)
  return width <= 9 && height <= 9 && duration <= 320
}

const mathSolverActionLabel: Record<MathSolverAction, string> = {
  simplify: 'Term vereinfachen',
  solve: 'Gleichung lösen',
  expand: 'Ausmultiplizieren',
  factor: 'Faktorisieren',
  calculate: 'Ausrechnen',
}

const continuationText = (result: MathSolverResult, placement: Exclude<MathSolverPlacement, 'auto'>) => {
  const lines = result.steps.map((step) => step.display)
  if (result.action === 'solve' || result.normalizedInput.includes('=') || placement === 'next-line' && lines.length > 1) {
    return lines.join('\n')
  }
  return `= ${lines.at(-1) ?? ''}`
}

const adaptMathTextToSamples = (value: string, samples: RecognitionResources['samples']) => {
  const labels = new Set(samples.flatMap((sample) => [sample.label, sample.labelId]))
  const hasDot = labels.has('·') || labels.has('operator_dot')
  const hasTimes = labels.has('×') || labels.has('operator_times')
  let adapted = value
  if (!hasDot) adapted = hasTimes ? adapted.replace(/·/gu, '×') : adapted.replace(/·/gu, '')
  if (!labels.has('√') && !labels.has('root')) adapted = adapted.replace(/√\(([^()]*)\)/gu, 'sqrt($1)')
  return adapted
}



const markdownFromSaveResult = (result: DrawingSaveResult, title: string) => {
  if (typeof result === 'string') {
    return result.startsWith('![') ? result : `![${title}](${result})`
  }
  if (!result) return ''
  if ('markdown' in result && result.markdown) return result.markdown
  const path = 'imageRelativePath' in result ? result.imageRelativePath : undefined
  return path ? `![${title}](${path.replaceAll(' ', '%20')})` : ''
}

export const DrawingBoard = memo(forwardRef<DrawingBoardHandle, DrawingBoardProps>(function DrawingBoard({
  settings,
  drawingId,
  title = 'Handschrift',
  initialDrawingJson,
  className = '',
  inline = false,
  inputActive = true,
  onSaveDrawing,
  onInsertMarkdown,
  onSettingsChange,
  onDirtyChange,
  onTrainingChanged,
  onOpenGlyphenWerk,
  onClose,
  pagePaperStyle,
  onPagePaperChange,
}: DrawingBoardProps, forwardedRef) {
  const paperView = usePaperView()
  const boardRef = useRef<HTMLElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const committedCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const committedCanvasKeyRef = useRef('')
  const committedCanvasDirtyRef = useRef(true)
  const canvasPixelSizeRef = useRef({ width: 0, height: 0, virtualHeight: 0 })
  const inkWindowRef = useRef<InkWindow>(FULL_INK_WINDOW)
  const inkWindowIdleRef = useRef<number | null>(null)
  const resizeDebounceRef = useRef<number | null>(null)
  const resizeDirtyRef = useRef(false)
  const canvasQualityKeyRef = useRef('')
  const pointerBoundsRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null)
  const viewZoomRef = useRef(1)
  const viewRotationRef = useRef(0)
  const viewPanRef = useRef({ x: 0, y: 0 })
  const sourceHeightRef = useRef(SOURCE_HEIGHT)
  const sourceWidthRef = useRef(SOURCE_WIDTH)
  const pageLayoutFrameRef = useRef<number | null>(null)
  const paintedLayoutRef = useRef({ w: 0, h: 0 })
  const pendingGrowRemapRef = useRef<{
    prevH: number
    nextH: number
    prevW: number
    nextW: number
    prevLayoutH: number
    prevLayoutW: number
  } | null>(null)
  const commitPendingGrowRemapRef = useRef<(layoutW: number, layoutH: number) => boolean>(() => false)

  const activePointerTargetRef = useRef<Element | null>(null)
  /** Last pointer id we successfully called setPointerCapture for (may outlive activePointerRef on Wayland glitches). */
  const lastCapturedPointerIdRef = useRef<number | null>(null)
  const lastPointerTypeRef = useRef<string>('mouse')
  const exportCacheRef = useRef<{ key: string; imageData: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const strokesRef = useRef<InkStroke[]>([])
  const activeStrokeRef = useRef<InkStroke | null>(null)
  const activePointerRef = useRef<number | null>(null)
  const inkSessionRef = useRef<InkPointerSessionSnapshot | null>(null)
  const pendingSolverTapRef = useRef<PendingSolverTap | null>(null)
  const solverDoubleTapPointRef = useRef<Pick<StrokePoint, 'x' | 'y'> | null>(null)
  const mathSolverRunRef = useRef(0)
  const mathCorrectionRunRef = useRef(0)
  const selectionStartRef = useRef<StrokePoint | null>(null)
  const recognitionStrokesRef = useRef<InkStroke[] | null>(null)
  const recognizeLatestRef = useRef<(requestedMode?: RecognitionPreference, scopedStrokes?: InkStroke[]) => Promise<void>>(async () => {})
  const gestureToolRef = useRef<DrawingTool>('pen')
  const beforeGestureRef = useRef<InkStroke[]>([])
  const gestureChangedRef = useRef(false)
  const scribbleHintShownRef = useRef(false)
  const undoRef = useRef<InkStroke[][]>([])
  const redoRef = useRef<InkStroke[][]>([])
  const drawFrameRef = useRef<number | null>(null)
  const activeRenderedPointCountRef = useRef(0)
  const liveSmoothAtRef = useRef(0)
  const liveCanvasHasInkRef = useRef(false)
  const lastPenContactRef = useRef(0)
  const shapeDwellTimerRef = useRef<number | null>(null)
  const shapeHintTimerRef = useRef<number | null>(null)
  const shapeLastMoveAtRef = useRef(0)
  const shapeSnappedRef = useRef(false)
  const mountedRef = useRef(true)
  const resourcesRef = useRef<RecognitionResources | null>(null)
  const recognitionRunRef = useRef(0)
  const contextualLearningRunRef = useRef(0)
  const revisionRef = useRef(0)
  const inkRevisionRef = useRef(0)
  const dirtyRef = useRef(false)
  const saveLatestRef = useRef<() => Promise<void>>(async () => {})
  const searchTranscriptRef = useRef('')
  const transcriptUpdatedAtRef = useRef<string | null>(null)
  const indexedStrokeCountRef = useRef(0)
  const transcriptNeedsFullRebuildRef = useRef(false)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const queuedSaveCountRef = useRef(0)
  const createdAtRef = useRef(new Date().toISOString())
  const initialColorRef = useRef(settings.penColor)
  const drawingIdRef = useRef(drawingId)
  const loadedDrawingIdRef = useRef<string | null | undefined>(undefined)
  const mathSolverHistoryRef = useRef<MathSolverHistoryEntry[]>([])

  const [initialArtPreferences] = useState(loadArtPreferences)
  const [tool, setTool] = useState<DrawingTool>('pen')
  const [inkMode, setInkMode] = useState<InkMode>('writing')
  const [artPanelOpen, setArtPanelOpen] = useState(false)
  const [artStudioTab, setArtStudioTab] = useState<ArtStudioTab>('brushes')
  const [artBrush, setArtBrush] = useState<ArtBrush>(initialArtPreferences.brush)
  const [artColor, setArtColor] = useState(initialArtPreferences.color)
  const [artEffect, setArtEffect] = useState<InkEffect>(initialArtPreferences.effect)
  const [artWidth, setArtWidth] = useState(initialArtPreferences.width)
  const [artOpacity, setArtOpacity] = useState(initialArtPreferences.opacity)
  const [artSymbolCategory, setArtSymbolCategory] = useState<ArtSymbolCategory>('all')
  const [artSymbolId, setArtSymbolId] = useState<ArtSymbolId | null>(null)
  const [artSymbolSize, setArtSymbolSize] = useState(initialArtPreferences.symbolSize)
  const [artSymbolRotation, setArtSymbolRotation] = useState(initialArtPreferences.symbolRotation)
  const [penColor, setPenColor] = useState(settings.penColor)
  const [penWidth, setPenWidth] = useState(settings.penWidth)
  const [paperStyle, setPaperStyle] = useState(pagePaperStyle ?? settings.paperStyle)
  const [sourceHeight, setSourceHeight] = useState(SOURCE_HEIGHT)
  const [sourceWidth, setSourceWidth] = useState(SOURCE_WIDTH)
  const [viewZoom, setViewZoom] = useState(1)
  const [viewRotation, setViewRotation] = useState(0)
  const [viewPan, setViewPan] = useState({ x: 0, y: 0 })
  const [eraserSize, setEraserSize] = useState(24)

  viewZoomRef.current = viewZoom
  viewRotationRef.current = viewRotation
  viewPanRef.current = viewPan
  sourceHeightRef.current = sourceHeight
  sourceWidthRef.current = sourceWidth
  const [revision, setRevision] = useState(0)
  const [transcriptRevision, setTranscriptRevision] = useState(0)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isRecognizing, setIsRecognizing] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [isResettingTraining, setIsResettingTraining] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [mode, setMode] = useState<RecognitionPreference>(settings.recognitionMode)
  const [recognizedMode, setRecognizedMode] = useState<RecognitionMode>(
    settings.recognitionMode === 'auto' ? settings.lastRecognitionMode : settings.recognitionMode,
  )
  const [automaticResult, setAutomaticResult] = useState<Pick<AutomaticRecognitionResult, 'confidence' | 'reason' | 'textScore' | 'mathScore'> | null>(null)
  const [tokens, setTokens] = useState<RecognitionToken[]>([])
  const [correction, setCorrection] = useState('')
  const [wholeFormulaResult, setWholeFormulaResult] = useState(false)
  const [conversionOpen, setConversionOpen] = useState(false)
  const [textToHandwritingOpen, setTextToHandwritingOpen] = useState(false)
  const [mathSolverEnabled, setMathSolverEnabled] = useState(false)
  const [mathSolverSelection, setMathSolverSelection] = useState<MathSolverSelection | null>(null)
  const [mathSolverInput, setMathSolverInput] = useState('')
  const [mathSolverVariable, setMathSolverVariable] = useState('')
  const [mathSolverPlacement, setMathSolverPlacement] = useState<MathSolverPlacement>('auto')
  const [isMathSolving, setIsMathSolving] = useState(false)
  const [mathCorrectorEnabled, setMathCorrectorEnabled] = useState(false)
  const [mathCorrectionSession, setMathCorrectionSession] = useState<MathCorrectionSession | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectionPurpose, setSelectionPurpose] = useState<SelectionPurpose>('conversion')
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null)
  const [rulerPose, setRulerPose] = useState<DraftingPose | null>(null)
  const [setSquarePose, setSetSquarePose] = useState<DraftingPose | null>(null)
  const [compassPose, setCompassPose] = useState<CompassPose | null>(null)
  const [inkToolbarHost, setInkToolbarHost] = useState<HTMLElement | null>(null)
  const [draftingReadout, setDraftingReadout] = useState<string | null>(null)
  const rulerPoseRef = useRef<DraftingPose | null>(null)
  const setSquarePoseRef = useRef<DraftingPose | null>(null)
  const compassPoseRef = useRef<CompassPose | null>(null)
  const draftingLockRef = useRef<{ kind: DraftingKind; edgeIndex: number } | null>(null)
  const draftingReadoutRef = useRef<string | null>(null)
  const lastDiagnosticAtRef = useRef(0)
  rulerPoseRef.current = rulerPose
  setSquarePoseRef.current = setSquarePose
  compassPoseRef.current = compassPose

  useLayoutEffect(() => {
    if (!inline || !inputActive) {
      setInkToolbarHost(null)
      return
    }
    setInkToolbarHost(document.getElementById(INK_TOOLBAR_SLOT_ID))
  }, [inline, inputActive])
  const selectedStrokeIndexesRef = useRef<number[]>([])
  const inkDragRef = useRef<{ kind: 'move' | 'scale'; startX: number; startY: number; origin: SelectionRect } | null>(null)
  const [recognitionScope, setRecognitionScope] = useState<RecognitionScope>('page')
  const [resources, setResources] = useState<RecognitionResources | null>(null)
  const [trainingSampleCount, setTrainingSampleCount] = useState<number | null>(null)
  const [katexModule, setKatexModule] = useState<KatexModule | null>(null)
  const activeMode: RecognitionMode = mode === 'auto' ? recognizedMode : mode
  const activeArtBrush = ART_BRUSHES.find(({ id }) => id === artBrush) ?? ART_BRUSHES[0]
  const activeArtSymbol = artSymbolId ? artSymbolById.get(artSymbolId) ?? null : null
  const visibleArtSymbols = useMemo(() => artSymbolCategory === 'all'
    ? ART_SYMBOLS
    : ART_SYMBOLS.filter(({ category }) => category === artSymbolCategory), [artSymbolCategory])

  const inkCount = strokesRef.current.length
  const handwritingCount = handwritingStrokes(strokesRef.current).length
  const artCount = inkCount - handwritingCount
  const knownTrainingSampleCount = resources?.sampleCount ?? trainingSampleCount
  const averageConfidence = tokens.length
    ? Math.round(tokens.filter((token) => !token.isLayout).reduce((sum, token) => sum + token.confidence, 0) /
      Math.max(1, tokens.filter((token) => !token.isLayout).length))
    : 0

  const mathSolverInspection = useMemo(() => {
    if (!mathSolverInput.trim()) return { inspection: null, error: 'Kein Ausdruck ausgewählt.' }
    try {
      return { inspection: inspectMathInputSyntax(mathSolverInput), error: '' }
    } catch (error) {
      return {
        inspection: null,
        error: error instanceof Error ? error.message : 'Der Ausdruck ist nicht gültig.',
      }
    }
  }, [mathSolverInput])

  const needsMathRenderer = Boolean(
    (mathSolverSelection?.latex && mathSolverInput === mathSolverSelection.input)
    || (activeMode === 'math' && correction.trim()),
  )

  useEffect(() => {
    if (!needsMathRenderer || katexModule) return
    let active = true
    void loadKatexModule()
      .then((loaded) => {
        if (active) setKatexModule(loaded)
      })
      .catch(() => {
        // The editable LaTeX field remains usable if the optional preview
        // renderer cannot be loaded.
      })
    return () => { active = false }
  }, [katexModule, needsMathRenderer])

  const mathSolverPreview = useMemo(() => {
    const latex = mathSolverSelection && mathSolverInput === mathSolverSelection.input
      ? mathSolverSelection.latex
      : ''
    if (!latex || !katexModule) return ''
    try {
      return katexModule.default.renderToString(latex, {
        displayMode: true,
        throwOnError: false,
        strict: false,
        output: 'htmlAndMathml',
      })
    } catch {
      return ''
    }
  }, [katexModule, mathSolverInput, mathSolverSelection])

  const mathCorrectionErrorRect = useMemo(() => {
    const session = mathCorrectionSession
    const lineIndex = session?.result?.errorLineIndex
    if (!session || lineIndex === undefined || !session.lines[lineIndex]) return null
    const current = session.lines[lineIndex]
    const previous = session.lines[lineIndex - 1]
    return previous && session.result?.lines[lineIndex]?.highlight !== 'line'
      ? changedMathTokenRect(previous.tokens, current.tokens, current.rect)
      : current.rect
  }, [mathCorrectionSession])

  useEffect(() => {
    setPenColor(settings.penColor)
    setPenWidth(settings.penWidth)
    if (!pagePaperStyle) setPaperStyle(settings.paperStyle)
    setMode(settings.recognitionMode)
    if (settings.recognitionMode === 'auto') {
      if (!tokens.length) setRecognizedMode(settings.lastRecognitionMode)
    } else {
      setRecognizedMode(settings.recognitionMode)
      setAutomaticResult(null)
    }
  }, [pagePaperStyle, settings.lastRecognitionMode, settings.paperStyle, settings.penColor, settings.penWidth, settings.recognitionMode, tokens.length])

  useEffect(() => {
    if (pagePaperStyle) setPaperStyle(pagePaperStyle)
  }, [pagePaperStyle])

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(ART_PREFERENCES_KEY, JSON.stringify({
        brush: artBrush,
        color: artColor,
        effect: artEffect,
        width: artWidth,
        opacity: artOpacity,
        symbolSize: artSymbolSize,
        symbolRotation: artSymbolRotation,
      }))
    } catch {
      // Die Zeichenwerkzeuge bleiben auch ohne verfügbaren Web-Speicher nutzbar.
    }
  }, [artBrush, artColor, artEffect, artOpacity, artSymbolRotation, artSymbolSize, artWidth])

  useEffect(() => {
    if (drawingId) drawingIdRef.current = drawingId
  }, [drawingId])

  const setDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty
    setIsDirty(dirty)
    onDirtyChange?.(dirty)
  }, [onDirtyChange])

  const bumpRevision = useCallback(() => {
    revisionRef.current += 1
    setRevision(revisionRef.current)
  }, [])

  const bumpInkRevision = useCallback((options: { redrawCommitted?: boolean; updateTranscript?: boolean; appendOnly?: boolean } = {}) => {
    inkRevisionRef.current += 1
    contextualLearningRunRef.current += 1
    if (options.updateTranscript !== false && !options.appendOnly) transcriptNeedsFullRebuildRef.current = true
    if (options.redrawCommitted !== false) committedCanvasDirtyRef.current = true
    exportCacheRef.current = null
    if (options.updateTranscript !== false) setTranscriptRevision((current) => current + 1)
    bumpRevision()
  }, [bumpRevision])

  const updateHistoryState = useCallback(() => {
    setCanUndo(undoRef.current.length > 0)
    setCanRedo(redoRef.current.length > 0)
  }, [])

  const clearRecognitionScope = useCallback(() => {
    selectionStartRef.current = null
    recognitionStrokesRef.current = null
    setSelectionMode(false)
    setSelectionRect(null)
    setRecognitionScope('page')
  }, [])

  const redraw = useCallback((measureLayout = false) => {
    const canvas = canvasRef.current
    const committedCanvas = committedCanvasRef.current
    const surface = surfaceRef.current
    if (!canvas || !committedCanvas || !surface) return
    const shell = surface.parentElement
    if ((measureLayout || !canvasPixelSizeRef.current.width) && shell) {
      const availableWidth = Math.max(240, shell.clientWidth - 20)
      const availableHeight = Math.max(150, shell.clientHeight - 48)
      const sourceRatio = sourceWidth / sourceHeight
      const width = Math.min(availableWidth, availableHeight * sourceRatio)
      const height = width / sourceRatio
      const cssWidth = `${Math.round(width)}px`
      const cssHeight = `${Math.round(height)}px`
      if (surface.style.width !== cssWidth) surface.style.width = cssWidth
      if (surface.style.height !== cssHeight) surface.style.height = cssHeight
    }
    // Use layout size (offset*), not getBoundingClientRect: CSS zoom/rotation of the
    // sheet must not change coordinate space mid-stroke. Quality is increased by a
    // denser backing store that tracks view zoom instead.
    const layoutWidth = surface.offsetWidth || surface.clientWidth
    const layoutHeight = surface.offsetHeight || surface.clientHeight
    if (layoutWidth <= 0 || layoutHeight <= 0) return
    const inkWindow = inkWindowRef.current
    const windowSpan = inkWindowSpan(inkWindow)
    const windowLayoutHeight = Math.max(1, layoutHeight * windowSpan)
    const qualityKey = [
      Math.round(layoutWidth),
      Math.round(layoutHeight),
      inkWindow.y0.toFixed(3),
      inkWindow.y1.toFixed(3),
      viewZoomRef.current.toFixed(2),
      (window.devicePixelRatio || 1).toFixed(2),
      inline ? 'i' : 'f',
    ].join(':')
    const shouldRemeasure = measureLayout
      || !canvasPixelSizeRef.current.width
      || canvasQualityKeyRef.current !== qualityKey
    // Page growth forces measureLayout=true and must resize even mid-stroke so new
    // paper area maps correctly; pure zoom waits for the pen to lift.
    if (shouldRemeasure && (measureLayout || !activeStrokeRef.current)) {
      const nextSize = computeInkPixelSize(layoutWidth, windowLayoutHeight, viewZoomRef.current, inline)
      const virtualHeight = nextSize.height / windowSpan
      canvasPixelSizeRef.current = { width: nextSize.width, height: nextSize.height, virtualHeight }
      canvasQualityKeyRef.current = qualityKey
      committedCanvasDirtyRef.current = true
      applyInkWindowToCanvases([canvas, committedCanvas], inkWindow)
      if (activeStrokeRef.current) {
        // Force a full live-canvas replace so a remesure cannot overdraw the
        // previous bitmap (that leftover is the "ghost copy" of the writing).
        activeRenderedPointCountRef.current = 0
        liveCanvasHasInkRef.current = true
      }
    } else if (!canvasPixelSizeRef.current.width) {
      const nextSize = computeInkPixelSize(layoutWidth, windowLayoutHeight, viewZoomRef.current, inline)
      canvasPixelSizeRef.current = {
        width: nextSize.width,
        height: nextSize.height,
        virtualHeight: nextSize.height / windowSpan,
      }
      canvasQualityKeyRef.current = qualityKey
      applyInkWindowToCanvases([canvas, committedCanvas], inkWindow)
    }
    const { width: pixelWidth, height: pixelHeight, virtualHeight } = canvasPixelSizeRef.current
    if (!pixelWidth || !pixelHeight || !virtualHeight) return
    const liveCanvasResized = canvas.width !== pixelWidth || canvas.height !== pixelHeight
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight
    if (liveCanvasResized) {
      activeRenderedPointCountRef.current = 0
      liveCanvasHasInkRef.current = false
    }
    if (committedCanvas.width !== pixelWidth) committedCanvas.width = pixelWidth
    if (committedCanvas.height !== pixelHeight) committedCanvas.height = pixelHeight

    const cacheKey = [
      pixelWidth,
      pixelHeight,
      inkWindow.y0.toFixed(3),
      inkWindow.y1.toFixed(3),
      paperStyle,
      settings.smoothing,
      sourceWidth,
      sourceHeight,
      inline,
    ].join(':')
    if (committedCanvasDirtyRef.current || committedCanvasKeyRef.current !== cacheKey) {
      renderDocument(
        committedCanvas,
        strokesRef.current,
        paperStyle,
        settings.smoothing,
        pixelWidth,
        pixelHeight,
        !inline,
        sourceWidth,
        inkWindow,
      )
      committedCanvasKeyRef.current = cacheKey
      committedCanvasDirtyRef.current = false
    }

    const context = canvas.getContext('2d', { alpha: true })
    if (!context) return
    context.imageSmoothingEnabled = !activeStrokeRef.current
    context.imageSmoothingQuality = 'low'
    const activeStroke = activeStrokeRef.current
    if (!activeStroke) {
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, pixelWidth, pixelHeight)
      activeRenderedPointCountRef.current = 0
      liveCanvasHasInkRef.current = false
      return
    }
    if (activeRenderedPointCountRef.current === 0) {
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, pixelWidth, pixelHeight)
      liveCanvasHasInkRef.current = false
    }
    if (activeStroke.points.length > activeRenderedPointCountRef.current) {
      context.setTransform(1, 0, 0, 1, 0, -inkWindow.y0 * virtualHeight)
      drawInkStroke(
        context,
        activeStroke,
        pixelWidth,
        virtualHeight,
        settings.smoothing,
        Math.max(1, activeRenderedPointCountRef.current),
        sourceWidth,
      )
      activeRenderedPointCountRef.current = activeStroke.points.length
      liveCanvasHasInkRef.current = true
    }
  }, [inline, paperStyle, settings.smoothing, sourceHeight, sourceWidth])

  const commitStrokeToCanvas = useCallback((stroke: InkStroke) => {
    const canvas = committedCanvasRef.current
    const { width, height, virtualHeight } = canvasPixelSizeRef.current
    if (!canvas || !width || !height || !virtualHeight || committedCanvasDirtyRef.current) return
    const inkWindow = inkWindowRef.current
    if (!strokeIntersectsWindow(stroke, inkWindow)) return
    const context = canvas.getContext('2d')
    if (!context) return
    context.save()
    context.beginPath()
    context.rect(0, 0, width, height)
    context.clip()
    context.setTransform(1, 0, 0, 1, 0, -inkWindow.y0 * virtualHeight)
    drawInkStroke(context, stroke, width, virtualHeight, settings.smoothing, 1, sourceWidth)
    context.restore()
  }, [settings.smoothing, sourceWidth])

  useEffect(() => {
    if (inline && !inputActive) {
      setConversionOpen(false)
      setTextToHandwritingOpen(false)
      setMathSolverSelection(null)
      setMathCorrectionSession(null)
      setMathCorrectorEnabled(false)
      clearRecognitionScope()
    }
  }, [clearRecognitionScope, inline, inputActive])

  const scheduleRedraw = useCallback(() => {
    if (drawFrameRef.current !== null) return
    drawFrameRef.current = requestAnimationFrame(() => {
      drawFrameRef.current = null
      redraw()
    })
  }, [redraw])

  useEffect(() => {
    let active = true
    void getHandwritingTrainingSampleCount()
      .then((count) => {
        if (active) setTrainingSampleCount(count)
      })
      .catch(() => {
        if (active) setTrainingSampleCount(null)
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    redraw()
  }, [redraw, revision])

  useEffect(() => {
    if (!initialDrawingJson) return
    const sourceId = drawingId ?? null
    if (loadedDrawingIdRef.current === sourceId) return
    try {
      const document: unknown = JSON.parse(initialDrawingJson)
      if (!document || typeof document !== 'object') throw new Error('Kein Zeichnungsobjekt')
      const raw = document as Partial<DrawingDocument>
      strokesRef.current = safeInkStrokes(raw.strokes, initialColorRef.current)
      if (!pagePaperStyle && raw.paperStyle && raw.paperStyle in paperLabel) setPaperStyle(raw.paperStyle)
      if (typeof raw.sourceHeight === 'number' && raw.sourceHeight >= 400 && raw.sourceHeight <= MAX_SOURCE_HEIGHT) {
        sourceHeightRef.current = raw.sourceHeight
        setSourceHeight(raw.sourceHeight)
      }
      if (typeof raw.sourceWidth === 'number' && raw.sourceWidth >= 400 && raw.sourceWidth <= MAX_SOURCE_WIDTH) {
        sourceWidthRef.current = raw.sourceWidth
        setSourceWidth(raw.sourceWidth)
      }
      if (typeof raw.createdAt === 'string') createdAtRef.current = raw.createdAt
      searchTranscriptRef.current = typeof raw.searchTranscript === 'string' ? raw.searchTranscript : ''
      transcriptUpdatedAtRef.current = typeof raw.transcriptUpdatedAt === 'string' ? raw.transcriptUpdatedAt : null
      indexedStrokeCountRef.current = handwritingStrokes(strokesRef.current).length
      transcriptNeedsFullRebuildRef.current = false
      if (raw.detectedRecognitionMode === 'math' || raw.detectedRecognitionMode === 'text') {
        setRecognizedMode(raw.detectedRecognitionMode)
      }
      setMathSolverEnabled(raw.mathSolverEnabled === true)
      mathSolverHistoryRef.current = [
        ...sharedMathSolverHistory(),
        ...safeMathSolverHistory(raw.mathSolverHistory),
      ].slice(-24)
      setMathSolverSelection(null)
      setMathCorrectionSession(null)
      setMathCorrectorEnabled(false)
      undoRef.current = []
      redoRef.current = []
      clearRecognitionScope()
      bumpInkRevision({ updateTranscript: false })
      setDirty(false)
      updateHistoryState()
      loadedDrawingIdRef.current = sourceId
    } catch {
      loadedDrawingIdRef.current = sourceId
      strokesRef.current = []
      committedCanvasDirtyRef.current = true
      setNotice({ kind: 'error', text: 'Die gespeicherte Zeichnung konnte nicht gelesen werden.' })
    }
  }, [bumpInkRevision, clearRecognitionScope, drawingId, initialDrawingJson, setDirty, updateHistoryState])

  useEffect(() => {
    if (!initialDrawingJson && !mathSolverHistoryRef.current.length) {
      mathSolverHistoryRef.current = sharedMathSolverHistory()
    }
  }, [initialDrawingJson])

  const pointFromEvent = useCallback((event: PointerEvent): StrokePoint | null => {
    const canvas = canvasRef.current
    const originEl = (inline
      ? (canvas?.closest('.unified-paper') as HTMLElement | null)
      : null) ?? canvas
    if (!originEl) return null
    commitPendingGrowRemapRef.current(originEl.offsetWidth, originEl.offsetHeight)
    const originRect = originEl.getBoundingClientRect()
    const surface = {
      left: originRect.left,
      top: originRect.top,
      width: originRect.width,
      height: originRect.height,
      offsetWidth: originEl.offsetWidth,
      offsetHeight: originEl.offsetHeight,
    }
    const leftover = pendingGrowRemapRef.current
    const lastLive = activeStrokeRef.current?.points.at(-1)
    let mapped = leftover && lastLive
      ? (() => {
        const continued = growLiveInkAndMapNext(
          lastLive,
          leftover.prevH,
          leftover.nextH,
          event,
          surface,
          viewRotationRef.current,
          leftover.prevLayoutH,
          originEl.offsetHeight,
          leftover.prevW,
          leftover.nextW,
          leftover.prevLayoutW,
          originEl.offsetWidth,
        )
        if (continued.last.remapped) {
          lastLive.x = continued.last.x
          lastLive.y = continued.last.y
        }
        if (continued.jumped) return null
        return continued.next
      })()
      : mapClientToPaperPoint(event, surface, viewRotationRef.current)
    if (!mapped) return null

    const width = Math.max(1, canvas?.offsetWidth ?? originEl.offsetWidth)
    const height = Math.max(1, canvas?.offsetHeight ?? originEl.offsetHeight)
    const paperW = Math.max(1, originEl === canvas ? width : originEl.offsetWidth)
    const paperH = Math.max(1, originEl === canvas ? height : originEl.offsetHeight)
    const localX = originEl === canvas ? mapped.x * paperW : mapped.x * paperW * (width / paperW)
    const localY = originEl === canvas ? mapped.y * paperH : mapped.y * paperH * (height / paperH)
    let x = clamp(localX / width)
    let y = clamp(localY / height)
    const guides: Array<{ kind: DraftingKind; pose: DraftingPose }> = []
    if (rulerPoseRef.current) guides.push({ kind: 'ruler', pose: rulerPoseRef.current })
    if (setSquarePoseRef.current) guides.push({ kind: 'setSquare', pose: setSquarePoseRef.current })
    if (compassPoseRef.current) guides.push({ kind: 'compass', pose: compassPoseRef.current })
    if (guides.length && !selectionStartRef.current && gestureToolRef.current !== 'eraser') {
      const snapped = snapToDraftingTools(
        x,
        y,
        guides,
        sourceWidthRef.current,
        sourceHeightRef.current,
        draftingLockRef.current,
        { width: paperW, height: paperH },
      )
      if (snapped) {
        x = snapped.x
        y = snapped.y
        draftingLockRef.current = { kind: snapped.kind, edgeIndex: snapped.edgeIndex }
        const nextReadout = `${draftingToolLabel(snapped.kind)} · ${formatMillimetres(snapped.millimetres)}`
        if (draftingReadoutRef.current !== nextReadout) {
          draftingReadoutRef.current = nextReadout
          setDraftingReadout(nextReadout)
        }
      }
    }
    return {
      ...mapped,
      x,
      y,
    }
  }, [inline])

  const resolvePaperElement = useCallback((): HTMLElement | null => {
    const surface = surfaceRef.current
    return (surface?.closest('.unified-paper') ?? boardRef.current?.closest('.unified-paper')) as HTMLElement | null
  }, [])

  const syncInkWindow = useCallback((force = false) => {
    if (!inline) {
      if (!isFullInkWindow(inkWindowRef.current)) {
        inkWindowRef.current = FULL_INK_WINDOW
        committedCanvasDirtyRef.current = true
        canvasQualityKeyRef.current = ''
        scheduleRedraw()
      }
      return
    }
    const paper = resolvePaperElement()
    const scroller = paper?.closest('.unified-note-view') as HTMLElement | null
    if (!paper || !scroller) {
      if (!isFullInkWindow(inkWindowRef.current)) {
        inkWindowRef.current = FULL_INK_WINDOW
        committedCanvasDirtyRef.current = true
        canvasQualityKeyRef.current = ''
        applyInkWindowToCanvases([canvasRef.current, committedCanvasRef.current], FULL_INK_WINDOW)
        scheduleRedraw()
      }
      return
    }
    const visible = measureVisibleInkRange(paper, scroller)
    if (!force && visibleFitsInkWindow(inkWindowRef.current, visible)) return
    const next = measureInkWindow(paper, scroller)
    if (!force && !inkWindowsDiffer(inkWindowRef.current, next)) return
    inkWindowRef.current = next
    committedCanvasDirtyRef.current = true
    canvasQualityKeyRef.current = ''
    applyInkWindowToCanvases([canvasRef.current, committedCanvasRef.current], next)
    scheduleRedraw()
  }, [inline, resolvePaperElement, scheduleRedraw])

  const scaleNormalizedSpace = useCallback((scaleX: number, scaleY: number) => {
    if (scaleX === 1 && scaleY === 1) return
    for (const stroke of strokesRef.current) {
      for (const point of stroke.points) {
        point.x *= scaleX
        point.y *= scaleY
      }
    }
    const active = activeStrokeRef.current
    if (active) {
      for (const point of active.points) {
        point.x *= scaleX
        point.y *= scaleY
      }
    }
    const scalePose = <T extends DraftingPose>(pose: T | null): T | null => (
      pose ? { ...pose, x: pose.x * scaleX, y: pose.y * scaleY } : pose
    )
    if (rulerPoseRef.current) {
      const next = scalePose(rulerPoseRef.current)
      rulerPoseRef.current = next
      setRulerPose(next)
    }
    if (setSquarePoseRef.current) {
      const next = scalePose(setSquarePoseRef.current)
      setSquarePoseRef.current = next
      setSetSquarePose(next)
    }
    if (compassPoseRef.current) {
      const next = scalePose(compassPoseRef.current)
      compassPoseRef.current = next
      setCompassPose(next)
    }
    setSelectionRect((current) => current ? {
      x: current.x * scaleX,
      y: current.y * scaleY,
      width: current.width * scaleX,
      height: current.height * scaleY,
    } : current)
  }, [])

  const flushPaintedLayoutGrow = useCallback(() => {
    const paper = resolvePaperElement()
    if (!paper) return false
    const nextW = paper.offsetWidth
    const nextH = paper.offsetHeight
    const prevW = paintedLayoutRef.current.w
    const prevH = paintedLayoutRef.current.h
    const resolved = resolvePaintedLayoutGrow({
      pending: pendingGrowRemapRef.current,
      prevLayoutW: prevW,
      prevLayoutH: prevH,
      nextLayoutW: nextW,
      nextLayoutH: nextH,
      sourceW: sourceWidthRef.current,
      sourceH: sourceHeightRef.current,
    })
    if (resolved.discard) pendingGrowRemapRef.current = null
    else pendingGrowRemapRef.current = resolved.pending
    paintedLayoutRef.current = { w: nextW, h: nextH }
    if (!resolved.apply) return false
    scaleNormalizedSpace(resolved.scaleX, resolved.scaleY)
    canvasQualityKeyRef.current = ''
    committedCanvasDirtyRef.current = true
    activeRenderedPointCountRef.current = 0
    wipeLiveInkCanvas(canvasRef.current)
    redraw(true)
    return true
  }, [redraw, resolvePaperElement, scaleNormalizedSpace])

  useEffect(() => {
    mountedRef.current = true
    const scheduleMeasure = () => {
      if (activeStrokeRef.current) {
        resizeDirtyRef.current = true
        return
      }
      if (resizeDebounceRef.current !== null) window.clearTimeout(resizeDebounceRef.current)
      resizeDebounceRef.current = window.setTimeout(() => {
        resizeDebounceRef.current = null
        flushPaintedLayoutGrow()
        syncInkWindow()
        redraw(true)
      }, 90)
    }
    const observer = new ResizeObserver(scheduleMeasure)
    if (surfaceRef.current) observer.observe(surfaceRef.current)
    if (surfaceRef.current?.parentElement) observer.observe(surfaceRef.current.parentElement)
    const scroller = resolvePaperElement()?.closest('.unified-note-view')
    const onScroll = () => {
      // Rebuild the ink window only after scrolling settles. Resizing canvases
      // mid-scroll forces a full paper/text repaint and looks like warping.
      if (inkWindowIdleRef.current !== null) window.clearTimeout(inkWindowIdleRef.current)
      inkWindowIdleRef.current = window.setTimeout(() => {
        inkWindowIdleRef.current = null
        if (activeStrokeRef.current) {
          resizeDirtyRef.current = true
          return
        }
        syncInkWindow()
      }, 160)
    }
    scroller?.addEventListener('scroll', onScroll, { passive: true })
    syncInkWindow(true)
    redraw(true)
    return () => {
      mountedRef.current = false
      observer.disconnect()
      scroller?.removeEventListener('scroll', onScroll)
      if (inkWindowIdleRef.current !== null) window.clearTimeout(inkWindowIdleRef.current)
      if (resizeDebounceRef.current !== null) window.clearTimeout(resizeDebounceRef.current)
      if (drawFrameRef.current !== null) cancelAnimationFrame(drawFrameRef.current)
      if (pendingSolverTapRef.current) window.clearTimeout(pendingSolverTapRef.current.timer)
    }
  }, [flushPaintedLayoutGrow, redraw, resolvePaperElement, syncInkWindow])

  const applyInkExtentStyles = useCallback((height: number, width: number = sourceWidthRef.current) => {
    const paper = resolvePaperElement()
    if (!paper) return
    const styles = inkExtentStyleValues(height, width, Math.max(1, paper.clientWidth))
    paper.style.setProperty('--ink-extent-ratio', String(styles.extentRatio))
    paper.style.setProperty('--ink-width-extent', String(styles.widthExtent))
    paper.classList.add('has-ink-extent')
    paper.classList.toggle(INK_WIDTH_ANCHOR_CLASS, inkWidthNeedsAnchor(styles.widthExtent))
  }, [resolvePaperElement])

  const schedulePageLayoutRefresh = useCallback(() => {
    if (pageLayoutFrameRef.current !== null) return
    pageLayoutFrameRef.current = requestAnimationFrame(() => {
      pageLayoutFrameRef.current = null
      canvasQualityKeyRef.current = ''
      committedCanvasDirtyRef.current = true
      redraw(true)
    })
  }, [redraw])

  const commitPendingGrowRemap = useCallback((layoutW: number, layoutH: number) => {
    const flushed = pendingGrowScale(pendingGrowRemapRef.current, layoutW, layoutH)
    if (flushed.discard) {
      pendingGrowRemapRef.current = null
      return false
    }
    if (!flushed.ready) return false
    pendingGrowRemapRef.current = flushed.remaining
    scaleNormalizedSpace(flushed.scaleX, flushed.scaleY)
    canvasQualityKeyRef.current = ''
    committedCanvasDirtyRef.current = true
    activeRenderedPointCountRef.current = 0
    wipeLiveInkCanvas(canvasRef.current)
    redraw(true)
    return true
  }, [redraw, scaleNormalizedSpace])
  commitPendingGrowRemapRef.current = commitPendingGrowRemap

  /**
   * Resize the writable page without shifting existing ink in absolute space.
   * Coordinates stay normalized 0–1, so we scale by old/new when the sheet changes.
   */
  const setPageExtent = useCallback((targetHeight: number, targetWidth: number) => {
    const prevH = sourceHeightRef.current
    const prevW = sourceWidthRef.current
    const nextH = Math.min(MAX_SOURCE_HEIGHT, Math.max(SOURCE_HEIGHT, Math.round(targetHeight)))
    const nextW = Math.min(MAX_SOURCE_WIDTH, Math.max(SOURCE_WIDTH, Math.round(targetWidth)))
    if (nextH === prevH && nextW === prevW) return false
    const paper = resolvePaperElement()
    const prevLayoutH = paper?.offsetHeight ?? 0
    const prevLayoutW = paper?.offsetWidth ?? 0
    sourceHeightRef.current = nextH
    sourceWidthRef.current = nextW
    setSourceHeight(nextH)
    setSourceWidth(nextW)
    applyInkExtentStyles(nextH, nextW)
    const nextLayoutH = paper?.offsetHeight ?? 0
    const nextLayoutW = paper?.offsetWidth ?? 0
    // Shrinking 0–1 before the painted sheet gets taller lifts every stroke
    // toward the top and makes the writing look smaller than the ruling.
    const scaleX = liveGrowScale(prevLayoutW, nextLayoutW, prevW, nextW, nextH > prevH)
    const scaleY = liveGrowScale(prevLayoutH, nextLayoutH, prevH, nextH, nextW > prevW)
    scaleNormalizedSpace(scaleX, scaleY)
    pendingGrowRemapRef.current = mergePendingGrow(
      pendingGrowRemapRef.current,
      { prevH, nextH, prevW, nextW, prevLayoutH, prevLayoutW },
      { scaleX, scaleY },
    )
    paintedLayoutRef.current = { w: nextLayoutW, h: nextLayoutH }
    exportCacheRef.current = null
    setDirty(true)
    if (activeStrokeRef.current) {
      canvasQualityKeyRef.current = ''
      committedCanvasDirtyRef.current = true
      redraw(true)
    } else {
      schedulePageLayoutRefresh()
    }
    return true
  }, [applyInkExtentStyles, resolvePaperElement, scaleNormalizedSpace, schedulePageLayoutRefresh, setDirty, redraw])

  /** Keep about half a page of empty paper beyond the pen so the edge does not arrive first. */
  const ensureWriteRoom = useCallback((normalizedY?: number, normalizedX?: number) => {
    const prevH = sourceHeightRef.current
    const prevW = sourceWidthRef.current
    const paper = resolvePaperElement()
    const paintedH = paper?.offsetHeight ?? 0
    const paintedW = paper?.offsetWidth ?? 0
    const nextH = nextWriteExtent(normalizedY, prevH, WRITE_SLACK_HEIGHT, PAGE_GROW_STEP_HEIGHT, paintedH)
    const nextW = nextWriteExtent(normalizedX, prevW, WRITE_SLACK_WIDTH, PAGE_GROW_STEP_WIDTH, paintedW)
    if (nextH > prevH || nextW > prevW) setPageExtent(nextH, nextW)
  }, [resolvePaperElement, setPageExtent])

  const fitPageToInk = useCallback(() => {
    if (activeStrokeRef.current) return false
    const prevH = sourceHeightRef.current
    const prevW = sourceWidthRef.current
    const bounds = inkAbsoluteBounds(strokesRef.current, prevW, prevH)
    return setPageExtent(
      Math.max(SOURCE_HEIGHT, bounds.maxY + WRITE_SLACK_HEIGHT),
      Math.max(SOURCE_WIDTH, bounds.maxX + WRITE_SLACK_WIDTH),
    )
  }, [setPageExtent])

  const clearViewTransformTargets = useCallback(() => {
    const surface = surfaceRef.current
    const paper = resolvePaperElement()
    const noteView = paper?.closest('.unified-note-view') as HTMLElement | null
    clearPaperViewFromElements(paper, noteView, surface)
  }, [resolvePaperElement])

  const applyViewTransform = useCallback((zoom: number, rotation: number, pan: { x: number; y: number }) => {
    // Shared PaperView owns the note-sheet transform in inline mode so zoom
    // survives switching between keyboard and pen.
    if (inline && paperView) return
    const surface = surfaceRef.current
    if (!inline) {
      applyPaperViewToElements(surface, null, { zoom, rotation, pan })
      return
    }
    // Inline fallback (no shared PaperView): same CSS-zoom path so text stays sharp.
    const paper = resolvePaperElement()
    const noteView = paper?.closest('.unified-note-view') as HTMLElement | null
    applyPaperViewToElements(paper, noteView, { zoom, rotation, pan })
    if (surface) {
      surface.style.removeProperty('transform')
      surface.style.removeProperty('transform-origin')
      surface.style.removeProperty('zoom')
    }
  }, [inline, paperView, resolvePaperElement])

  const setView = useCallback((next: { zoom?: number; rotation?: number; pan?: { x: number; y: number } }) => {
    if (paperView) {
      paperView.setView(next)
      return
    }
    const zoom = clampViewZoom(next.zoom ?? viewZoomRef.current)
    const rotation = normalizeRotation(next.rotation ?? viewRotationRef.current)
    const pan = next.pan ?? viewPanRef.current
    setViewZoom(zoom)
    setViewRotation(rotation)
    setViewPan(pan)
    viewZoomRef.current = zoom
    viewRotationRef.current = rotation
    viewPanRef.current = pan
    applyViewTransform(zoom, rotation, pan)
  }, [applyViewTransform, paperView])

  // Populated after finishPointer is defined — zoom/rotate must free tablet capture first.
  const forceEndActivePointerRef = useRef<(
    reason?: 'view-gesture' | 'cross-device' | 'watchdog' | 'blur' | 'escape',
    sample?: PointerEvent | ReactPointerEvent<HTMLElement>,
  ) => void>(() => {})

  const zoomBy = useCallback((delta: number, originClient?: { x: number; y: number }) => {
    forceEndActivePointerRef.current('view-gesture')
    if (paperView) {
      paperView.zoomBy(delta, originClient)
      return
    }
    const previous = viewZoomRef.current
    const next = clampViewZoom(previous + delta)
    if (next === previous) return
    const surface = surfaceRef.current
    const scroller = surface?.parentElement
    const anchor = scroller ? capturePaperAnchor(scroller, surface, originClient) : null
    setView({ zoom: next, pan: { x: 0, y: 0 } })
    if (scroller && surface && anchor) restorePaperAnchor(scroller, surface, anchor)
  }, [paperView, setView])

  const rotateBy = useCallback((delta: number) => {
    forceEndActivePointerRef.current('view-gesture')
    setView({ rotation: viewRotationRef.current + delta })
  }, [setView])

  const resetView = useCallback(() => {
    forceEndActivePointerRef.current('view-gesture')
    setView({ zoom: 1, rotation: 0, pan: { x: 0, y: 0 } })
  }, [setView])

  useEffect(() => {
    if (paperView) {
      setViewZoom(paperView.zoom)
      setViewRotation(paperView.rotation)
      setViewPan(paperView.pan)
      viewZoomRef.current = paperView.zoom
      viewRotationRef.current = paperView.rotation
      viewPanRef.current = paperView.pan
      return
    }
    applyViewTransform(viewZoom, viewRotation, viewPan)
    return () => {
      clearViewTransformTargets()
    }
  }, [applyViewTransform, clearViewTransformTargets, paperView, viewPan, viewRotation, viewZoom])

  // Re-rasterize ink at higher backing-store resolution after zoom settles so
  // zoomed handwriting stays sharp instead of a stretched low-res bitmap.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (activeStrokeRef.current) return
      canvasQualityKeyRef.current = ''
      committedCanvasDirtyRef.current = true
      redraw(true)
    }, 90)
    return () => window.clearTimeout(timer)
  }, [redraw, viewZoom])

  useEffect(() => {
    applyInkExtentStyles(sourceHeight, sourceWidth)
  }, [applyInkExtentStyles, sourceHeight, sourceWidth])

  useLayoutEffect(() => {
    const paper = resolvePaperElement()
    if (!paper) return
    commitPendingGrowRemap(paper.offsetWidth, paper.offsetHeight)
  }, [commitPendingGrowRemap, resolvePaperElement, sourceHeight, sourceWidth])

  useEffect(() => {
    fitPageToInk()
  }, [drawingId, fitPageToInk, initialDrawingJson])

  useEffect(() => {
    if (inline && !inputActive) {
      // Leaving pen mode: keep shared paper zoom (text mode uses it too).
      if (!paperView) resetView()
      releaseStuckInputFocus()
      const canvas = canvasRef.current
      if (canvas) {
        const pointerId = activePointerRef.current ?? lastCapturedPointerIdRef.current
        if (pointerId !== null) {
          releasePointerCaptureSafe(activePointerTargetRef.current ?? canvas, pointerId)
          releasePointerCaptureSafe(canvas, pointerId)
        }
        activePointerRef.current = null
        activePointerTargetRef.current = null
        lastCapturedPointerIdRef.current = null
        pointerBoundsRef.current = null
        activeStrokeRef.current = null
        wipeLiveInkCanvas(canvas)
        activeRenderedPointCountRef.current = 0
        liveCanvasHasInkRef.current = false
      }
    }
  }, [inline, inputActive, paperView, resetView])

  const eraseAt = useCallback((value: StrokePoint | StrokePoint[]) => {
    const before = strokesRef.current.length
    const points = Array.isArray(value) ? value : [value]
    strokesRef.current = applyToolErase(strokesRef.current, points, eraserSize, sourceWidth, sourceHeight)
    if (strokesRef.current.length !== before) {
      gestureChangedRef.current = true
      committedCanvasDirtyRef.current = true
      scheduleRedraw()
    }
  }, [eraserSize, scheduleRedraw, sourceHeight, sourceWidth])

  const clearShapeDwellTimer = useCallback(() => {
    if (shapeDwellTimerRef.current !== null) {
      window.clearTimeout(shapeDwellTimerRef.current)
      shapeDwellTimerRef.current = null
    }
    if (shapeHintTimerRef.current !== null) {
      window.clearTimeout(shapeHintTimerRef.current)
      shapeHintTimerRef.current = null
    }
  }, [])

  const readShapeSnapProfile = useCallback(() => shapeSnapProfile(settings.shapeSnapSensitivity ?? 50), [settings.shapeSnapSensitivity])

  /** Snap only a confidently recognized figure after a deliberate still hold. */
  const trySnapActiveShape = useCallback(() => {
    if (gestureToolRef.current !== 'pen' || selectionStartRef.current) return false
    const stroke = activeStrokeRef.current
    const profile = readShapeSnapProfile()
    if (!stroke || stroke.symbolId || stroke.points.length < profile.minPoints) return false
    const snapped = snapStrokeToShape(stroke, sourceWidth, sourceHeight, settings.shapeSnapSensitivity ?? 50)
    if (!snapped || snapped.confidence < profile.minConfidence) return false
    activeStrokeRef.current = {
      ...stroke,
      ...snapped.stroke,
      points: snapped.stroke.points,
    } as InkStroke
    // Force a full live-canvas redraw so the freehand stroke is replaced, not overdrawn.
    activeRenderedPointCountRef.current = 0
    liveCanvasHasInkRef.current = true
    shapeSnappedRef.current = true
    gestureChangedRef.current = true
    scheduleRedraw()
    setNotice({
      kind: 'success',
      text: `${SHAPE_SNAP_LABEL[snapped.kind]} erkannt · Stift heben übernimmt die saubere Form.`,
    })
    return true
  }, [readShapeSnapProfile, scheduleRedraw, settings.shapeSnapSensitivity, sourceHeight, sourceWidth])

  const onShapeDwellElapsed = useCallback(() => {
    shapeDwellTimerRef.current = null
    if (shapeSnappedRef.current || !activeStrokeRef.current || activePointerRef.current === null) return
    const remaining = readShapeSnapProfile().dwellMs - (performance.now() - shapeLastMoveAtRef.current)
    if (remaining > 16) {
      shapeDwellTimerRef.current = window.setTimeout(onShapeDwellElapsed, remaining)
      return
    }
    if (trySnapActiveShape()) return
    // Almost a shape (e.g. circle not fully closed): keep watching while the tip stays down.
    shapeDwellTimerRef.current = window.setTimeout(onShapeDwellElapsed, 180)
  }, [readShapeSnapProfile, trySnapActiveShape])

  const armShapeDwell = useCallback(() => {
    if (gestureToolRef.current !== 'pen' || selectionStartRef.current || shapeSnappedRef.current) return
    const stroke = activeStrokeRef.current
    const profile = readShapeSnapProfile()
    if (!stroke || stroke.symbolId || stroke.points.length < profile.minPoints) return
    if (shapeDwellTimerRef.current === null) {
      shapeDwellTimerRef.current = window.setTimeout(onShapeDwellElapsed, profile.dwellMs)
    }
    if (shapeHintTimerRef.current === null) {
      shapeHintTimerRef.current = window.setTimeout(() => {
        shapeHintTimerRef.current = null
        if (shapeSnappedRef.current || !activeStrokeRef.current) return
        if (performance.now() - shapeLastMoveAtRef.current < profile.hintMs) return
        if (strokeLooksLikeShape(activeStrokeRef.current, sourceWidthRef.current, sourceHeightRef.current, settings.shapeSnapSensitivity ?? 50)) {
          setNotice({ kind: 'info', text: 'Form erkannt — halte still, um sie zu glätten.' })
        }
      }, profile.hintMs)
    }
  }, [onShapeDwellElapsed, readShapeSnapProfile, settings.shapeSnapSensitivity])

  const paintActiveStrokeNow = useCallback((predicted: PointerEvent[] = []) => {
    const canvas = canvasRef.current
    const stroke = activeStrokeRef.current
    if (!canvas || !stroke) return false
    const { width: pixelWidth, height: pixelHeight, virtualHeight } = canvasPixelSizeRef.current
    if (!pixelWidth || !pixelHeight || !virtualHeight) return false
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) return false
    const inkWindow = inkWindowRef.current
    const liveSmoothing = settings.smoothing
    context.imageSmoothingEnabled = false
    const added = stroke.points.length - activeRenderedPointCountRef.current
    const resmooth = liveSmoothing > 0.04
      && liveCanvasHasInkRef.current
      && stroke.points.length - liveSmoothAtRef.current >= 5
    // Predictions and remesures must replace the live bitmap. Incremental
    // overdraw of predicted events leaves a ghost copy of the writing that
    // only disappears after the canvases remount.
    const replaceLive = resmooth || predicted.length > 0 || activeRenderedPointCountRef.current === 0
    if (replaceLive) {
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, pixelWidth, pixelHeight)
      context.setTransform(1, 0, 0, 1, 0, -inkWindow.y0 * virtualHeight)
      const previewPoints = collectPreviewInkPoints(
        stroke.points,
        predicted.map(pointFromEvent),
      ) as StrokePoint[]
      const preview: InkStroke = previewPoints.length
        ? { ...stroke, points: [...stroke.points, ...previewPoints] }
        : stroke
      drawInkStroke(context, preview, pixelWidth, virtualHeight, liveSmoothing, 1, sourceWidthRef.current)
      activeRenderedPointCountRef.current = stroke.points.length
      liveSmoothAtRef.current = stroke.points.length
      liveCanvasHasInkRef.current = true
    } else if (added > 0) {
      context.setTransform(1, 0, 0, 1, 0, -inkWindow.y0 * virtualHeight)
      drawInkStroke(
        context,
        stroke,
        pixelWidth,
        virtualHeight,
        liveSmoothing,
        Math.max(1, activeRenderedPointCountRef.current),
        sourceWidthRef.current,
      )
      activeRenderedPointCountRef.current = stroke.points.length
      liveCanvasHasInkRef.current = true
    }
    return true
  }, [pointFromEvent, settings.smoothing])

  const appendPointerEvent = useCallback((event: PointerEvent) => {
    const canvas = canvasRef.current
    const originEl = (inline
      ? (canvas?.closest('.unified-paper') as HTMLElement | null)
      : null) ?? canvas
    const originRect = originEl?.getBoundingClientRect() ?? null
    const surface = originRect && originEl
      ? {
        left: originRect.left,
        top: originRect.top,
        width: originRect.width,
        height: originRect.height,
        offsetWidth: originEl.offsetWidth,
        offsetHeight: originEl.offsetHeight,
      }
      : null
    // Unusable/0,0 first — then remap live ink — then leap-filter. Leap
    // against the pre-grow last point would drop the next same-visual sample.
    if (!acceptUsableInkClient(event, surface, viewRotationRef.current)) return
    const point = pointFromEvent(event)
    if (!point) return
    const live = activeStrokeRef.current
    const lastPoint = live?.points.at(-1) ?? null
    const jump = classifyInkJumpAppend(lastPoint, point, live?.points.length ?? 0)
    if (jump === 'skip') return
    if (jump === 'restart' && live) {
      live.points.splice(0, 1, point)
      activeRenderedPointCountRef.current = 0
      wipeLiveInkCanvas(canvas)
      if (gestureToolRef.current === 'eraser') {
        eraseAt(point)
        return
      }
      gestureChangedRef.current = true
      if (!paintActiveStrokeNow()) scheduleRedraw()
      return
    }
    if (gestureToolRef.current === 'eraser') {
      eraseAt(point)
      return
    }
    const stroke = activeStrokeRef.current
    if (!stroke) return
    const previous = stroke.points.at(-1)
    if (previous) {
      const distance = Math.hypot(
        (point.x - previous.x) * sourceWidth,
        (point.y - previous.y) * sourceHeight,
      )
      if (distance < 0.35) {
        // Holding still must still arm the dwell clock. Tablets/mice often send
        // no further moves, so the timeout from the last real point is what snaps.
        armShapeDwell()
        return
      }
      shapeLastMoveAtRef.current = performance.now()
      clearShapeDwellTimer()
      // A larger correction after a snap lets the user keep drawing freehand.
      if (distance > SHAPE_MOVE_RESET_PX && shapeSnappedRef.current) shapeSnappedRef.current = false
    } else {
      shapeLastMoveAtRef.current = performance.now()
    }
    stroke.points.push(point)
    const now = performance.now()
    if (now - lastDiagnosticAtRef.current > BUG_REPORT_PEN_SAMPLE_MS) {
      lastDiagnosticAtRef.current = now
      diagnosticLog.record({
        at: Date.now(),
        kind: 'pen',
        noteId: drawingIdRef.current,
        x: point.x,
        y: point.y,
        pointerType: point.pointerType,
        tool: gestureToolRef.current || tool,
      })
    }
    gestureChangedRef.current = true
    if (!paintActiveStrokeNow()) scheduleRedraw()
    armShapeDwell()
    const visibleInk = inkWindowRef.current
    if (!isFullInkWindow(visibleInk) && (point.y < visibleInk.y0 + 0.08 || point.y > visibleInk.y1 - 0.08)) {
      // Remeasuring mid-stroke freezes the UI and can drop pointerup.
      resizeDirtyRef.current = true
    }
  }, [armShapeDwell, clearShapeDwellTimer, eraseAt, inline, paintActiveStrokeNow, pointFromEvent, scheduleRedraw, sourceHeight, sourceWidth])

  const commitPendingSolverTap = useCallback(() => {
    const pending = pendingSolverTapRef.current
    if (!pending) return
    window.clearTimeout(pending.timer)
    pendingSolverTapRef.current = null
    undoRef.current.push(pending.snapshot)
    if (undoRef.current.length > 80) undoRef.current.shift()
    redoRef.current = []
    strokesRef.current.push(pending.stroke)
    commitStrokeToCanvas(pending.stroke)
    setTokens([])
    setCorrection('')
    setAutomaticResult(null)
    bumpInkRevision({ redrawCommitted: false, appendOnly: true })
    setDirty(true)
    updateHistoryState()
    scheduleRedraw()
  }, [bumpInkRevision, commitStrokeToCanvas, scheduleRedraw, setDirty, updateHistoryState])

  const closeMathSolverSelection = useCallback(() => {
    mathSolverRunRef.current += 1
    setMathSolverSelection(null)
    setMathSolverInput('')
    setMathSolverVariable('')
    setIsMathSolving(false)
  }, [])

  const closeMathCorrectionSession = useCallback(() => {
    mathCorrectionRunRef.current += 1
    setMathCorrectionSession(null)
  }, [])

  const verifyMathCorrectionLines = useCallback(async (
    lines: MathCorrectionLine[],
    rect: SelectionRect,
    existingRunId?: number,
  ) => {
    const runId = existingRunId ?? ++mathCorrectionRunRef.current
    setMathCorrectionSession({ rect, lines, status: 'checking' })
    try {
      const { checkMathStepsSafely } = await import('../lib/mathCheckerClient')
      const checked = await checkMathStepsSafely(lines.map((line) => line.input))
      if (runId !== mathCorrectionRunRef.current) return
      const unconfirmedIndex = lines.findIndex((line) => !line.confirmed && line.recognitionRisk)
      const result: MathCheckResult = unconfirmedIndex >= 0 ? {
        status: 'uncertain',
        errorLineIndex: unconfirmedIndex,
        lines: checked.lines.map((line, index) => index === unconfirmedIndex
          ? { ...line, status: 'uncertain', message: 'Die Handschrifterkennung dieser Zeile ist für eine automatische Fehleraussage zu unsicher.' }
          : index > unconfirmedIndex ? { ...line, status: 'unchecked', message: 'Noch nicht geprüft' } : line),
        message: `Bestätige oder korrigiere zuerst Schritt ${unconfirmedIndex + 1}; mindestens ein Zeichen ist mehrdeutig (${lines[unconfirmedIndex].confidence} % mittlere Sicherheit).`,
      } : checked
      setMathCorrectionSession({ rect, lines, status: 'ready', result })
      setNotice(result.status === 'correct' ? {
        kind: 'success',
        text: result.message,
      } : result.status === 'incorrect' ? {
        kind: 'error',
        text: `${result.message} Die verdächtige Stelle ist rot markiert.`,
      } : {
        kind: 'info',
        text: result.message,
      })
    } catch (error) {
      if (runId !== mathCorrectionRunRef.current) return
      const message = error instanceof Error ? error.message : 'Der Rechenweg konnte nicht geprüft werden.'
      setMathCorrectionSession({ rect, lines, status: 'error', error: message })
      setNotice({ kind: 'error', text: message })
    }
  }, [])

  const analyzeMathCorrectionSelection = useCallback(async (
    rect: SelectionRect,
    selectedStrokes: InkStroke[],
  ) => {
    const runId = ++mathCorrectionRunRef.current
    const groups = groupMathInkLines(selectedStrokes, { width: sourceWidth, height: sourceHeight })
    setMathCorrectionSession({ rect, lines: [], status: 'recognizing' })
    setConversionOpen(false)
    setNotice(null)
    try {
      if (groups.length < 2) {
        throw new Error('Im gewählten Bereich wurden nicht mindestens zwei getrennte Rechenzeilen gefunden.')
      }
      if (groups.length > 20) {
        throw new Error('Wähle höchstens 20 Rechenschritte auf einmal aus.')
      }
      const [loaded, recognitionEngine] = await Promise.all([
        resourcesRef.current ?? loadRecognitionResources(),
        loadRecognitionModule(),
      ])
      if (runId !== mathCorrectionRunRef.current) return
      if (!loaded.model.length) {
        throw new Error('Das lokale Standardmodell konnte nicht geladen werden.')
      }
      resourcesRef.current = loaded
      setResources(loaded)
      const lines = groups.map((group, index): MathCorrectionLine => {
        const recognized = recognitionEngine.recognizeExpression(
          cloneStrokes(group.strokes),
          loaded.model,
          loaded.labels,
          'math',
          loaded.layoutExamples,
          settings.recognitionLanguage,
        )
        const usableTokens = recognized.filter((token) => !token.isLayout)
        const averageConfidence = usableTokens.length
          ? Math.round(usableTokens.reduce((sum, token) => sum + token.confidence, 0) / usableTokens.length)
          : 0
        const ambiguousToken = usableTokens.some((token) => {
          const ranked = [...token.alternatives].sort((left, right) => right.confidence - left.confidence)
          return token.confidence < 42 || (
            ranked.length > 1
            && ranked[0].char !== ranked[1].char
            && ranked[0].confidence - ranked[1].confidence < 5
          )
        })
        return {
          id: `math-step-${runId}-${index}`,
          strokes: cloneStrokes(group.strokes),
          tokens: recognized,
          rect: group.rect,
          input: recognitionEngine.recognizedText(recognized, loaded.layoutExamples).trim(),
          latex: recognitionEngine.recognizedLatex(recognized, loaded.layoutExamples).trim(),
          confidence: averageConfidence,
          recognitionRisk: averageConfidence < 62 || ambiguousToken,
          confirmed: false,
        }
      })
      if (runId !== mathCorrectionRunRef.current) return
      await verifyMathCorrectionLines(lines, rect, runId)
    } catch (error) {
      if (runId !== mathCorrectionRunRef.current) return
      const message = error instanceof Error ? error.message : 'Der ausgewählte Rechenweg konnte nicht gelesen werden.'
      setMathCorrectionSession({ rect, lines: [], status: 'error', error: message })
      setNotice({ kind: 'error', text: message })
    }
  }, [settings.recognitionLanguage, sourceHeight, verifyMathCorrectionLines])

  const openMathSolverAtPoint = useCallback(async (point: Pick<StrokePoint, 'x' | 'y'>) => {
    const selection = selectMathInkAtPoint(handwritingStrokes(strokesRef.current), point, {
      width: sourceWidth,
      height: sourceHeight,
    })
    if (!selection) {
      setNotice({ kind: 'info', text: 'Doppeltippe direkt auf den mathematischen Ausdruck, den du bearbeiten möchtest.' })
      return
    }
    const runId = ++mathSolverRunRef.current
    clearRecognitionScope()
    setConversionOpen(false)
    setMathSolverInput('')
    setMathSolverVariable('')
    setMathSolverSelection({
      rect: selection.rect,
      strokes: cloneStrokes(selection.strokes),
      tokens: [],
      status: 'recognizing',
      input: '',
      latex: '',
      confidence: 0,
    })
    try {
      const [loaded, recognitionEngine] = await Promise.all([
        resourcesRef.current ?? loadRecognitionResources(),
        loadRecognitionModule(),
      ])
      if (runId !== mathSolverRunRef.current) return
      if (!loaded.model.length) {
        throw new Error('Das lokale Standardmodell konnte nicht geladen werden.')
      }
      resourcesRef.current = loaded
      setResources(loaded)
      const recognized = recognitionEngine.recognizeExpression(
        cloneStrokes(selection.strokes),
        loaded.model,
        loaded.labels,
        'math',
        loaded.layoutExamples,
        settings.recognitionLanguage,
      )
      const input = recognitionEngine.recognizedText(recognized, loaded.layoutExamples).trim()
      const latex = recognitionEngine.recognizedLatex(recognized, loaded.layoutExamples).trim()
      const usableTokens = recognized.filter((token) => !token.isLayout)
      const confidence = usableTokens.length
        ? Math.round(usableTokens.reduce((sum, token) => sum + token.confidence, 0) / usableTokens.length)
        : 0
      let initialVariable = ''
      try {
        initialVariable = inspectMathInputSyntax(input).variables[0] ?? ''
      } catch {
        // The editable field remains available when recognition needs a correction.
      }
      setMathSolverInput(input)
      setMathSolverVariable(initialVariable)
      setMathSolverSelection({
        rect: selection.rect,
        strokes: cloneStrokes(selection.strokes),
        tokens: recognized,
        status: 'ready',
        input,
        latex,
        confidence,
      })
    } catch (error) {
      if (runId !== mathSolverRunRef.current) return
      const message = error instanceof Error ? error.message : 'Der ausgewählte Ausdruck konnte nicht gelesen werden.'
      setMathSolverSelection({
        rect: selection.rect,
        strokes: cloneStrokes(selection.strokes),
        tokens: [],
        status: 'error',
        input: '',
        latex: '',
        confidence: 0,
        error: message,
      })
    }
  }, [clearRecognitionScope, settings.recognitionLanguage, sourceHeight])

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (hitTestChrome(event.clientX, event.clientY)) return
    setArtPanelOpen(false)
    if (event.button !== 0 && event.pointerType !== 'pen') return
    // Pen-only (Windows palm / resting hand): ignore finger, mouse and trackpad ink.
    if (shouldRejectNonPenInk(event.pointerType, settings.penOnly)) return
    const now = performance.now()
    if (activePointerRef.current !== null) {
      if (activePointerRef.current === event.pointerId) return
      if (!shouldAllowNewInkPointer(inkSessionRef.current, event, now)) return
      forceEndActivePointerRef.current('cross-device')
    }
    if (shouldIgnorePointerAfterPen(event.pointerType, lastPenContactRef.current, now)) return
    if (event.pointerType === 'pen') lastPenContactRef.current = now
    inkSessionRef.current = inkPointerSessionFromSample(event.nativeEvent, now)
    event.preventDefault()
    // User input always wins over cooperative background transcription.
    contextualLearningRunRef.current += 1
    lastPointerTypeRef.current = event.pointerType || 'mouse'
    // Prefer board focus over canvas focus so keyboard shortcuts still work
    // without trapping Wayland/Hyprland keyboard grab on the canvas element.
    boardRef.current?.focus({ preventScroll: true })
    activePointerTargetRef.current = event.currentTarget
    // Never capture in the inline note: the surface already covers the sheet,
    // and leftover capture retargets ribbon/tab clicks back onto the paper.
    // Standalone mouse drawing still captures so a drag can leave the canvas.
    // Pen/touch must never capture — Hyprland/Wayland often never releases it.
    if (!inline && event.pointerType === 'mouse') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
        lastCapturedPointerIdRef.current = event.pointerId
      } catch {
        lastCapturedPointerIdRef.current = null
      }
    } else {
      lastCapturedPointerIdRef.current = null
    }
    activePointerRef.current = event.pointerId
    const pointerRect = event.currentTarget.getBoundingClientRect()
    pointerBoundsRef.current = {
      left: pointerRect.left,
      top: pointerRect.top,
      width: pointerRect.width,
      height: pointerRect.height,
    }
    const canvas = canvasRef.current
    const originEl = (inline
      ? (canvas?.closest('.unified-paper') as HTMLElement | null)
      : null) ?? canvas
    const originRect = originEl?.getBoundingClientRect() ?? null
    const surface = originRect && originEl
      ? {
        left: originRect.left,
        top: originRect.top,
        width: originRect.width,
        height: originRect.height,
        offsetWidth: originEl.offsetWidth,
        offsetHeight: originEl.offsetHeight,
      }
      : null
    const start = resolveInkPointerDown(event.nativeEvent, surface, viewRotationRef.current)
    if (!start.openStroke) return
    // Ghost 0,0 downs stay session-open so the next real sample can start the stroke.
    const firstPoint = start.commitFirst ? pointFromEvent(event.nativeEvent) : null
    const pointerEraser = event.pointerType === 'pen' && (event.button === 5 || (event.buttons & 32) !== 0)
    const pendingTap = pendingSolverTapRef.current
    if (pendingTap) {
      const elapsed = performance.now() - pendingTap.at
      const distance = firstPoint
        ? Math.hypot(
          (firstPoint.x - pendingTap.point.x) * sourceWidth,
          (firstPoint.y - pendingTap.point.y) * sourceHeight,
        )
        : Number.POSITIVE_INFINITY
      if (firstPoint && mathSolverEnabled && inkMode === 'writing' && !pointerEraser && tool === 'pen' && elapsed <= 430 && distance <= 34) {
        window.clearTimeout(pendingTap.timer)
        pendingSolverTapRef.current = null
        solverDoubleTapPointRef.current = firstPoint
        gestureToolRef.current = 'pen'
        activeStrokeRef.current = null
        clearRecognitionScope()
        setConversionOpen(false)
        return
      }
      commitPendingSolverTap()
    }
    if (selectionMode) {
      if (!firstPoint) return
      selectionStartRef.current = firstPoint
      recognitionStrokesRef.current = null
      setSelectionRect({ x: firstPoint.x, y: firstPoint.y, width: 0, height: 0 })
      return
    }
    if (firstPoint && inkMode === 'drawing' && tool === 'pen' && !pointerEraser && activeArtSymbol) {
      const snapshot = snapshotStrokes(strokesRef.current)
      const symbolStroke: InkStroke = {
        points: [firstPoint],
        baseWidth: artSymbolSize,
        pressureEnabled: false,
        color: artColor,
        purpose: 'art',
        brush: 'fineliner',
        colorEffect: artEffect,
        opacity: artOpacity,
        textureSeed: Math.max(1, Math.round((performance.now() * 1_000 + event.pointerId * 7_919) % 2_147_483_647)),
        symbolId: activeArtSymbol.id,
        symbolRotation: artSymbolRotation,
      }
      clearRecognitionScope()
      closeMathSolverSelection()
      closeMathCorrectionSession()
      strokesRef.current.push(symbolStroke)
      commitStrokeToCanvas(symbolStroke)
      undoRef.current.push(snapshot)
      if (undoRef.current.length > 80) undoRef.current.shift()
      redoRef.current = []
      setTokens([])
      setCorrection('')
      setAutomaticResult(null)
      bumpInkRevision({ redrawCommitted: false, appendOnly: true, updateTranscript: false })
      setDirty(true)
      updateHistoryState()
      gestureChangedRef.current = false
      activePointerRef.current = null
      inkSessionRef.current = null
      pointerBoundsRef.current = null
      releasePointerCaptureSafe(event.currentTarget, event.pointerId)
      if (lastCapturedPointerIdRef.current === event.pointerId) lastCapturedPointerIdRef.current = null
      activePointerTargetRef.current = null
      if (event.pointerType === 'pen' || event.pointerType === 'touch') {
        queueMicrotask(() => releaseStuckInputFocus(boardRef.current))
      }
      setNotice({ kind: 'success', text: `${activeArtSymbol.label} eingefügt · tippe erneut für weitere.` })
      scheduleRedraw()
      return
    }
    clearRecognitionScope()
    closeMathSolverSelection()
    closeMathCorrectionSession()
    clearShapeDwellTimer()
    shapeSnappedRef.current = false
    shapeLastMoveAtRef.current = performance.now()
    beforeGestureRef.current = snapshotStrokes(strokesRef.current)
    gestureChangedRef.current = false
    gestureToolRef.current = pointerEraser ? 'eraser' : tool
    if (gestureToolRef.current === 'pen') {
      activeRenderedPointCountRef.current = 0
      liveSmoothAtRef.current = 0
      activeStrokeRef.current = inkMode === 'drawing' ? {
          points: [],
          baseWidth: artWidth,
          pressureEnabled: settings.pressureEnabled && activeArtBrush.pressure,
          color: artColor,
          purpose: 'art',
          brush: artBrush,
          colorEffect: artEffect,
          opacity: artOpacity,
          textureSeed: Math.max(1, Math.round((performance.now() * 1_000 + event.pointerId * 7_919) % 2_147_483_647)),
        } : {
          points: [],
          baseWidth: penWidth,
          pressureEnabled: settings.pressureEnabled,
          color: penColor,
          purpose: 'handwriting',
          brush: 'fineliner',
          colorEffect: 'solid',
          opacity: 1,
        }
    }
    appendPointerEvent(event.nativeEvent)
  }, [activeArtBrush.pressure, activeArtSymbol, appendPointerEvent, artBrush, artColor, artEffect, artOpacity, artSymbolRotation, artSymbolSize, artWidth, bumpInkRevision, clearRecognitionScope, clearShapeDwellTimer, closeMathCorrectionSession, closeMathSolverSelection, commitPendingSolverTap, commitStrokeToCanvas, inkMode, inline, mathSolverEnabled, penColor, penWidth, pointFromEvent, scheduleRedraw, selectionMode, setDirty, settings.penOnly, settings.pressureEnabled, sourceHeight, sourceWidth, tool, updateHistoryState])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (shouldRejectNonPenInk(event.pointerType, settings.penOnly)) return
    if (activePointerRef.current !== event.pointerId) return
    const now = performance.now()
    // End only when the helper says so — not because a few seconds elapsed
    // or Linux Wacom sent pressure 0 while the tip button is still down.
    if (shouldHardEndInkPointerSession(inkSessionRef.current, now, event.nativeEvent)) {
      forceEndActivePointerRef.current('watchdog', event.nativeEvent)
      return
    }
    if (inkSessionRef.current) inkSessionRef.current = touchInkPointerSession(inkSessionRef.current, event.nativeEvent, now)
    event.preventDefault()
    if (selectionStartRef.current) {
      const next = pointFromEvent(event.nativeEvent)
      if (next) setSelectionRect(selectionBetween(selectionStartRef.current, next))
      return
    }
    if (event.pointerType === 'pen') lastPenContactRef.current = performance.now()
    const events = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent]
    if (gestureToolRef.current === 'eraser') {
      eraseAt(events.map(pointFromEvent).filter((point): point is StrokePoint => Boolean(point)))
    } else {
      events.forEach(appendPointerEvent)
      const predicted = event.nativeEvent.getPredictedEvents?.() ?? []
      if (predicted.length) paintActiveStrokeNow(predicted)
      // Grow the page ahead of the pen so writing never hits a hard bottom edge.
      const latest = activeStrokeRef.current?.points.at(-1)
      if (latest) ensureWriteRoom(latest.y, latest.x)
    }
  }, [appendPointerEvent, ensureWriteRoom, eraseAt, paintActiveStrokeNow, pointFromEvent, settings.penOnly])

  const finishPointer = useCallback((event: ReactPointerEvent<HTMLElement> | PointerEvent) => {
    const pointerId = event.pointerId
    if (activePointerRef.current !== pointerId) return
    if ('preventDefault' in event && typeof event.preventDefault === 'function' && event.cancelable) {
      try { event.preventDefault() } catch { /* ignore */ }
    }
    const native = 'nativeEvent' in event && event.nativeEvent instanceof PointerEvent
      ? event.nativeEvent
      : event as PointerEvent
    const finalPoint = pointFromEvent(native)
    const captureTarget = activePointerTargetRef.current
      ?? ('currentTarget' in event && event.currentTarget instanceof Element ? event.currentTarget : canvasRef.current)
    const pointerType = native.pointerType || lastPointerTypeRef.current
    const endInteraction = () => {
      const cleanup = applyPenUpInkCleanup({
        activePointerId: activePointerRef.current,
        captureId: lastCapturedPointerIdRef.current,
        lastContactAt: lastPenContactRef.current,
      })
      pointerBoundsRef.current = null
      activePointerRef.current = cleanup.session.activePointerId
      inkSessionRef.current = null
      activePointerTargetRef.current = null
      draftingLockRef.current = null
      if (draftingReadoutRef.current) {
        draftingReadoutRef.current = null
        setDraftingReadout(null)
      }
      if (resizeDirtyRef.current) {
        resizeDirtyRef.current = false
        flushPaintedLayoutGrow()
        syncInkWindow()
        redraw(true)
      }
      releaseInkPointerCaptures([captureTarget, canvasRef.current, surfaceRef.current, boardRef.current], pointerId)
      if (lastCapturedPointerIdRef.current === pointerId) lastCapturedPointerIdRef.current = null
      clearInkCursor()
      // Hyprland/Wayland: after pen/touch, free keyboard + scroll without requiring a workspace switch.
      // Also free on any cancel/lost-capture so trackpad zoom mid-stroke cannot leave input trapped.
      if (
        pointerType === 'pen'
        || pointerType === 'touch'
        || event.type === 'pointercancel'
        || event.type === 'lostpointercapture'
        || pointerType === 'mouse'
      ) {
        queueMicrotask(() => releaseStuckInputFocus(boardRef.current))
        window.setTimeout(() => releaseStuckInputFocus(boardRef.current), 0)
      }
    }
    if (selectionStartRef.current) {
      const start = selectionStartRef.current
      const selection = selectionBetween(start, finalPoint ?? start)
      selectionStartRef.current = null
      endInteraction()
      if (event.type === 'pointercancel' || selection.width < 0.012 || selection.height < 0.012) {
        setSelectionMode(false)
        setSelectionRect(null)
        if (selectionPurpose === 'math-correction') setMathCorrectorEnabled(false)
        setNotice({ kind: 'info', text: 'Bereichsauswahl abgebrochen. Ziehe einen Rahmen um die gewünschte Handschrift.' })
        return
      }
      const selectedStrokes = handwritingStrokes(strokesRef.current.filter((stroke) => strokeIntersectsSelection(stroke, selection)))
      if (!selectedStrokes.length) {
        setSelectionMode(false)
        setSelectionRect(null)
        if (selectionPurpose === 'math-correction') setMathCorrectorEnabled(false)
        setNotice({ kind: 'info', text: 'Im gewählten Bereich wurde keine Handschrift gefunden.' })
        return
      }
      if (selectionPurpose === 'math-correction') {
        recognitionStrokesRef.current = null
        setSelectionMode(false)
        setSelectionRect(null)
        setRecognitionScope('page')
        void analyzeMathCorrectionSelection(selection, selectedStrokes)
        return
      }
      if (selectionPurpose === 'edit') {
        selectedStrokeIndexesRef.current = strokesRef.current.flatMap((stroke, index) => (
          selectedStrokes.includes(stroke) ? [index] : []
        ))
        setSelectionMode(false)
        setSelectionRect(selection)
        setNotice({ kind: 'info', text: 'Ziehen zum Verschieben, Ecke zum Skalieren. Kopieren oder Löschen unten.' })
        return
      }
      recognitionStrokesRef.current = selectedStrokes
      setSelectionMode(false)
      setSelectionRect(selection)
      setRecognitionScope('selection')
      setTokens([])
      setCorrection('')
      setAutomaticResult(null)
      setConversionOpen(true)
      setNotice(null)
      void recognizeLatestRef.current(mode, selectedStrokes)
      return
    }
    if (solverDoubleTapPointRef.current) {
      const point = solverDoubleTapPointRef.current
      solverDoubleTapPointRef.current = null
      activeStrokeRef.current = null
      wipeLiveInkCanvas(canvasRef.current)
      activeRenderedPointCountRef.current = 0
      liveCanvasHasInkRef.current = false
      endInteraction()
      if (event.type !== 'pointercancel') void openMathSolverAtPoint(point)
      scheduleRedraw()
      return
    }
    if (resolveInkFinishSample(native)) appendPointerEvent(native)
    const heldLongEnough = performance.now() - shapeLastMoveAtRef.current >= readShapeSnapProfile().dwellMs
    clearShapeDwellTimer()
    const activeStroke = activeStrokeRef.current
    if (heldLongEnough && !shapeSnappedRef.current) trySnapActiveShape()
    if (
      mathSolverEnabled
      && inkMode === 'writing'
      && gestureToolRef.current === 'pen'
      && event.type !== 'pointercancel'
      && activeStroke?.points.length
      && !shapeSnappedRef.current
      && isShortTapStroke(activeStroke, sourceWidth, sourceHeight)
    ) {
      const tapPoint = activeStroke.points.at(-1)!
      const pending: PendingSolverTap = {
        stroke: activeStroke,
        snapshot: beforeGestureRef.current,
        point: tapPoint,
        at: performance.now(),
        timer: 0,
      }
      activeStrokeRef.current = null
      gestureChangedRef.current = false
      pending.timer = window.setTimeout(commitPendingSolverTap, 420)
      pendingSolverTapRef.current = pending
      endInteraction()
      scheduleRedraw()
      return
    }
    let scribbleDeleted = 0
    if (gestureToolRef.current === 'pen' && activeStroke?.points.length) {
      const handwritingEntries = beforeGestureRef.current
        .map((stroke, index) => ({ stroke, index }))
        .filter(({ stroke }) => isHandwritingStroke(stroke))
      const scribble = inkMode === 'writing' && event.type !== 'pointercancel' ? detectScribbleErase(
        activeStroke,
        handwritingEntries.map(({ stroke }) => stroke),
        { width: sourceWidth, height: sourceHeight },
        settings.scribbleEraseSensitivity,
      ) : null
      if (scribble) {
        const deleted = new Set(scribble.indexes.map((index) => handwritingEntries[index]?.index).filter((index): index is number => index !== undefined))
        strokesRef.current = beforeGestureRef.current.filter((_, index) => !deleted.has(index))
        scribbleDeleted = beforeGestureRef.current.length - strokesRef.current.length
        gestureChangedRef.current = scribbleDeleted > 0
      } else {
        strokesRef.current.push(activeStroke)
        commitStrokeToCanvas(activeStroke)
        gestureChangedRef.current = true
      }
    }
    activeStrokeRef.current = null
    wipeLiveInkCanvas(canvasRef.current)
    activeRenderedPointCountRef.current = 0
    liveCanvasHasInkRef.current = false
    const didShapeSnap = shapeSnappedRef.current
    shapeSnappedRef.current = false
    endInteraction()
    // If zoom changed during the stroke, upgrade the backing store once the pen lifts.
    queueMicrotask(() => {
      if (activeStrokeRef.current) return
      canvasQualityKeyRef.current = ''
      committedCanvasDirtyRef.current = true
      redraw(true)
    })
    if (gestureChangedRef.current) {
      undoRef.current.push(beforeGestureRef.current)
      if (undoRef.current.length > 80) undoRef.current.shift()
      redoRef.current = []
      setTokens([])
      setCorrection('')
      setAutomaticResult(null)
      bumpInkRevision({
        redrawCommitted: scribbleDeleted > 0,
        appendOnly: scribbleDeleted === 0 && gestureToolRef.current === 'pen',
        updateTranscript: gestureToolRef.current !== 'pen' || activeStroke?.purpose !== 'art',
      })
      setDirty(true)
      updateHistoryState()
      if (scribbleDeleted && !scribbleHintShownRef.current) {
        scribbleHintShownRef.current = true
        setNotice({
          kind: 'success',
          text: 'Durchkritzeln erkannt: Handschrift gelöscht. Mit Strg+Z kannst du sie sofort zurückholen.',
        })
      } else if (didShapeSnap) {
        setNotice({ kind: 'success', text: 'Form übernommen.' })
      }
    }
    if (gestureChangedRef.current) fitPageToInk()
    scheduleRedraw()
  }, [analyzeMathCorrectionSelection, appendPointerEvent, bumpInkRevision, clearShapeDwellTimer, commitPendingSolverTap, commitStrokeToCanvas, fitPageToInk, flushPaintedLayoutGrow, inkMode, mathSolverEnabled, mode, openMathSolverAtPoint, pointFromEvent, readShapeSnapProfile, redraw, scheduleRedraw, selectionPurpose, setDirty, settings.scribbleEraseSensitivity, sourceHeight, sourceWidth, syncInkWindow, trySnapActiveShape, updateHistoryState])

  const readDraftingDisplay = useCallback((): DraftingDisplay => {
    const surface = surfaceRef.current
    const canvas = canvasRef.current
    const paper = inline
      ? (surface?.closest('.unified-paper') as HTMLElement | null)
        ?? (canvas?.closest('.unified-paper') as HTMLElement | null)
      : null
    const node = paper ?? surface ?? canvas
    return {
      width: Math.max(1, node?.offsetWidth ?? sourceWidthRef.current),
      height: Math.max(1, node?.offsetHeight ?? sourceHeightRef.current),
    }
  }, [inline])

  const handleCompassDraw = useCallback((event: CompassDrawEvent) => {
    const sw = sourceWidthRef.current
    const sh = sourceHeightRef.current
    const display = readDraftingDisplay()
    const toPoint = (x: number, y: number): StrokePoint => ({
      x,
      y,
      t: Math.round(performance.now() * 100) / 100,
      pressure: 0.62,
      tiltX: 0,
      tiltY: 0,
      pointerType: 'compass',
    })
    const makeStroke = (points: StrokePoint[]): InkStroke => (
      inkMode === 'drawing'
        ? {
            points,
            baseWidth: artWidth,
            pressureEnabled: false,
            color: artColor,
            purpose: 'art',
            brush: artBrush,
            colorEffect: artEffect,
            opacity: artOpacity,
            textureSeed: Math.max(1, Math.round((performance.now() * 1_000) % 2_147_483_647)),
          }
        : {
            points,
            baseWidth: penWidth,
            pressureEnabled: false,
            color: penColor,
            purpose: 'handwriting',
            brush: 'fineliner',
            colorEffect: 'solid',
            opacity: 1,
          }
    )
    const growForPose = (pose: CompassPose) => {
      const { rx, ry } = compassRadiiNorm(pose.radiusMm, sw, sh, display)
      ensureWriteRoom(pose.y + ry + 0.02, pose.x + rx + 0.02)
    }
    const commitReadyStroke = (stroke: InkStroke | null, label: string) => {
      activeStrokeRef.current = null
      wipeLiveInkCanvas(canvasRef.current)
      activeRenderedPointCountRef.current = 0
      liveCanvasHasInkRef.current = false
      if (!stroke || stroke.points.length < 2) {
        scheduleRedraw()
        return
      }
      undoRef.current.push(beforeGestureRef.current)
      if (undoRef.current.length > 80) undoRef.current.shift()
      redoRef.current = []
      strokesRef.current.push(stroke)
      commitStrokeToCanvas(stroke)
      bumpInkRevision({ redrawCommitted: false, appendOnly: true, updateTranscript: stroke.purpose !== 'art' })
      setDirty(true)
      updateHistoryState()
      setNotice({ kind: 'success', text: label })
      fitPageToInk()
      scheduleRedraw()
    }

    if (event.type === 'begin') {
      if (activePointerRef.current !== null) return
      beforeGestureRef.current = snapshotStrokes(strokesRef.current)
      gestureChangedRef.current = true
      gestureToolRef.current = 'pen'
      activeRenderedPointCountRef.current = 0
      growForPose(event.pose)
      const pose = compassPoseRef.current ?? event.pose
      const first = sampleCompassArc(pose, pose.rotation, pose.rotation, sourceWidthRef.current, sourceHeightRef.current, 0.035, display)[0]
      if (!first) return
      activeStrokeRef.current = makeStroke([toPoint(first.x, first.y)])
      paintActiveStrokeNow()
      return
    }
    if (event.type === 'append') {
      const stroke = activeStrokeRef.current
      if (!stroke) return
      growForPose(event.pose)
      const extra = sampleCompassArc(
        compassPoseRef.current ?? event.pose,
        event.fromAngle,
        event.toAngle,
        sourceWidthRef.current,
        sourceHeightRef.current,
        0.035,
        display,
      )
      for (const point of extra) stroke.points.push(toPoint(point.x, point.y))
      if (!paintActiveStrokeNow()) scheduleRedraw()
      return
    }
    if (event.type === 'cancel') {
      activeStrokeRef.current = null
      wipeLiveInkCanvas(canvasRef.current)
      activeRenderedPointCountRef.current = 0
      liveCanvasHasInkRef.current = false
      scheduleRedraw()
      return
    }
    if (event.type === 'commit') {
      const label = `Bogen ${formatMillimetres(event.pose.radiusMm)} gezeichnet.`
      commitReadyStroke(activeStrokeRef.current, label)
      return
    }
    growForPose(event.pose)
    const pose = compassPoseRef.current ?? event.pose
    const points = sampleCompassCircle(pose, sourceWidthRef.current, sourceHeightRef.current, display).map((point) => toPoint(point.x, point.y))
    beforeGestureRef.current = snapshotStrokes(strokesRef.current)
    commitReadyStroke(makeStroke(points), `Kreis ${formatMillimetres(pose.radiusMm)} gezeichnet.`)
  }, [artBrush, artColor, artEffect, artOpacity, artWidth, bumpInkRevision, commitStrokeToCanvas, ensureWriteRoom, fitPageToInk, inkMode, paintActiveStrokeNow, penColor, penWidth, readDraftingDisplay, scheduleRedraw, setDirty, updateHistoryState])

  /**
   * Hard-stop any in-progress pen/mouse stroke and scrub leftover pointer capture.
   * Used when trackpad zoom/pan interleaves with tablet input (Hyprland freezes the
   * crosshair cursor and blocks chrome clicks until capture is released).
   */
  const forceEndActivePointer = useCallback((
    reason: 'view-gesture' | 'cross-device' | 'watchdog' | 'blur' | 'escape' = 'watchdog',
    sample?: PointerEvent | ReactPointerEvent<HTMLElement>,
  ) => {
    void reason
    const pointerId = activePointerRef.current
    const scrubId = pointerId ?? lastCapturedPointerIdRef.current
    if (pointerId !== null) {
      const native = sample && 'nativeEvent' in sample && sample.nativeEvent instanceof PointerEvent
        ? sample.nativeEvent
        : sample instanceof PointerEvent ? sample : null
      if (native && native.pointerId === pointerId) {
        finishPointer(native)
      } else {
        const synthetic = {
          pointerId,
          type: 'pointercancel',
          pointerType: lastPointerTypeRef.current,
          clientX: Number.NaN,
          clientY: Number.NaN,
          pressure: 0,
          tiltX: 0,
          tiltY: 0,
          buttons: 0,
          button: -1,
          timeStamp: performance.now(),
          preventDefault() {},
          cancelable: false,
        } as unknown as PointerEvent
        finishPointer(synthetic)
      }
    } else if (activeStrokeRef.current) {
      activeStrokeRef.current = null
      pointerBoundsRef.current = null
      wipeLiveInkCanvas(canvasRef.current)
      activeRenderedPointCountRef.current = 0
      liveCanvasHasInkRef.current = false
      scheduleRedraw()
    }
    releaseInkPointerCaptures(
      [activePointerTargetRef.current, canvasRef.current, surfaceRef.current, boardRef.current],
      scrubId,
    )
    lastCapturedPointerIdRef.current = null
    activePointerRef.current = null
    inkSessionRef.current = null
    activePointerTargetRef.current = null
    pointerBoundsRef.current = null
    clearInkCursor()
    releaseStuckInputFocus(boardRef.current)
    queueMicrotask(() => {
      releaseStuckInputFocus(boardRef.current)
      clearInkCursor()
    })
    window.setTimeout(() => {
      releaseStuckInputFocus(boardRef.current)
      clearInkCursor()
    }, 0)
  }, [finishPointer, scheduleRedraw])
  forceEndActivePointerRef.current = forceEndActivePointer

  useEffect(() => {
    if (inputActive) return
    forceEndActivePointer('watchdog')
  }, [forceEndActivePointer, inputActive])

  // Global safety net: leftover capture retargets every click onto the sheet, so
  // ribbon/tab buttons look dead. These listeners stay up even after leaving
  // Stiftmodus so a missed pointerup cannot keep the UI frozen.
  useEffect(() => {
    const captureTargets = () => [
      activePointerTargetRef.current,
      canvasRef.current,
      surfaceRef.current,
      boardRef.current,
    ]
    const scrub = (pointerId: number | null) => {
      releaseInkPointerCaptures(captureTargets(), pointerId)
      if (pointerId !== null && lastCapturedPointerIdRef.current === pointerId) {
        lastCapturedPointerIdRef.current = null
      }
    }
    const onWindowPointerMove = (event: PointerEvent) => {
      if (!inputActive || activePointerRef.current !== event.pointerId) return
      const now = performance.now()
      // Same helper as canvas move: pressure flicker must not cut a live stroke.
      if (shouldHardEndInkPointerSession(inkSessionRef.current, now, event)) {
        forceEndActivePointer('watchdog', event)
        return
      }
      if (inkSessionRef.current) inkSessionRef.current = touchInkPointerSession(inkSessionRef.current, event, now)
      const canvas = canvasRef.current
      const hitTarget = inline ? surfaceRef.current : canvas
      if (hitTarget && (event.target === hitTarget || (event.target instanceof Node && hitTarget.contains(event.target)))) {
        return
      }
      if (selectionStartRef.current) {
        const next = pointFromEvent(event)
        if (next) setSelectionRect(selectionBetween(selectionStartRef.current, next))
        return
      }
      if (event.pointerType === 'pen') lastPenContactRef.current = performance.now()
      const events = event.getCoalescedEvents?.() ?? [event]
      if (gestureToolRef.current === 'eraser') {
        eraseAt(events.map(pointFromEvent).filter((point): point is StrokePoint => Boolean(point)))
      } else {
        events.forEach(appendPointerEvent)
        const predicted = event.getPredictedEvents?.() ?? []
        if (predicted.length) paintActiveStrokeNow(predicted)
        const latest = activeStrokeRef.current?.points.at(-1)
        if (latest) ensureWriteRoom(latest.y, latest.x)
      }
    }
    const onWindowPointerEnd = (event: PointerEvent) => {
      if (activePointerRef.current === event.pointerId) finishPointer(event)
      else scrub(event.pointerId)
    }
    const onWindowPointerDown = (event: PointerEvent) => {
      const chrome = hitTestChrome(event.clientX, event.clientY)
      if (chrome) {
        const stuck = activePointerRef.current !== null
          || lastCapturedPointerIdRef.current !== null
          || activeStrokeRef.current
        if (stuck) forceEndActivePointer('cross-device')
        else scrub(event.pointerId)
        // Capture retargets the event onto the canvas. Replay the click on the
        // real button so the first tap after writing still works.
        const control = clickableChromeControl(chrome)
        if (control instanceof HTMLElement && isInkSurfaceTarget(event.target) && event.target !== control) {
          event.preventDefault()
          event.stopPropagation()
          queueMicrotask(() => {
            if (typeof control.click === 'function') control.click()
          })
        }
        return
      }
      if (isInkSurfaceTarget(event.target)) {
        if (activePointerRef.current !== null && event.pointerId !== activePointerRef.current) {
          forceEndActivePointer('cross-device')
        }
        return
      }
      // Clicking any chrome (ribbon, tabs, menus, HUD) must free a stuck pen first,
      // including the same pointer id — otherwise capture swallows the click.
      if (activePointerRef.current !== null || lastCapturedPointerIdRef.current !== null || activeStrokeRef.current) {
        forceEndActivePointer('cross-device')
      } else {
        scrub(event.pointerId)
      }
    }
    const onWheel = () => {
      if (activePointerRef.current !== null || lastCapturedPointerIdRef.current !== null || inkSessionRef.current) {
        forceEndActivePointer('view-gesture')
      }
    }
    const onGotCapture = (event: PointerEvent) => {
      if (keepGotPointerCaptureId(event.pointerId, activePointerRef.current)) {
        lastCapturedPointerIdRef.current = event.pointerId
      }
    }
    const onWindowBlur = () => {
      forceEndActivePointer('blur')
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') forceEndActivePointer('blur')
    }
    const onWatchdog = () => {
      const now = performance.now()
      if (shouldHardEndInkPointerSession(inkSessionRef.current, now)) {
        forceEndActivePointer('watchdog')
        return
      }
      const capturedId = lastCapturedPointerIdRef.current
      if (activePointerRef.current !== null || activeStrokeRef.current) return
      if (capturedId === null) return
      scrub(capturedId)
      clearInkCursor()
      releaseStuckInputFocus(boardRef.current)
    }
    window.addEventListener('pointermove', onWindowPointerMove, true)
    window.addEventListener('pointerup', onWindowPointerEnd, true)
    window.addEventListener('pointercancel', onWindowPointerEnd, true)
    window.addEventListener('lostpointercapture', onWindowPointerEnd, true)
    window.addEventListener('gotpointercapture', onGotCapture, true)
    window.addEventListener('pointerdown', onWindowPointerDown, true)
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('visibilitychange', onVisibility)
    const watchdog = window.setInterval(onWatchdog, 280)
    return () => {
      window.removeEventListener('pointermove', onWindowPointerMove, true)
      window.removeEventListener('pointerup', onWindowPointerEnd, true)
      window.removeEventListener('pointercancel', onWindowPointerEnd, true)
      window.removeEventListener('lostpointercapture', onWindowPointerEnd, true)
      window.removeEventListener('gotpointercapture', onGotCapture, true)
      window.removeEventListener('pointerdown', onWindowPointerDown, true)
      window.removeEventListener('wheel', onWheel, true)
      window.removeEventListener('blur', onWindowBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(watchdog)
      releaseInkPointerCaptures(captureTargets(), lastCapturedPointerIdRef.current)
      releaseInkPointerCaptures(captureTargets(), activePointerRef.current)
      clearInkCursor()
    }
  }, [appendPointerEvent, eraseAt, ensureWriteRoom, finishPointer, forceEndActivePointer, inline, inputActive, paintActiveStrokeNow, pointFromEvent])

  const handleWheel = useCallback((event: React.WheelEvent) => {
    const policy = applyWheelInkPolicy({
      activePointerId: activePointerRef.current,
      captureId: lastCapturedPointerIdRef.current,
      lastContactAt: lastPenContactRef.current,
    }, event)
    if (inputActive && (activePointerRef.current !== null || lastCapturedPointerIdRef.current !== null || activeStrokeRef.current || inkSessionRef.current)) {
      forceEndActivePointer('view-gesture')
    }
    // Shared PaperView already handles sheet zoom in inline notes (text + pen).
    // Two-finger pan must reach the paper scroller even at zoom 1.
    if (paperView) {
      if (policy.pinch && event.cancelable) {
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }
    if (!inputActive) return
    if (policy.preventDefault) {
      event.preventDefault()
      event.stopPropagation()
      const factor = zoomFactorFromWheel(event.deltaY, event.deltaMode, settings.viewZoomSpeed ?? 5)
      zoomBy(viewZoomRef.current * factor - viewZoomRef.current, { x: event.clientX, y: event.clientY })
    }
  }, [forceEndActivePointer, inputActive, paperView, settings.viewZoomSpeed, zoomBy])

  const undo = useCallback(() => {
    if (pendingSolverTapRef.current) {
      window.clearTimeout(pendingSolverTapRef.current.timer)
      pendingSolverTapRef.current = null
      activeStrokeRef.current = null
      scheduleRedraw()
      return
    }
    const previous = undoRef.current.pop()
    if (!previous) return
    clearRecognitionScope()
    closeMathSolverSelection()
    closeMathCorrectionSession()
    redoRef.current.push(snapshotStrokes(strokesRef.current))
    strokesRef.current = snapshotStrokes(previous)
    setTokens([])
    setCorrection('')
    setAutomaticResult(null)
    bumpInkRevision()
    setDirty(true)
    updateHistoryState()
    fitPageToInk()
  }, [bumpInkRevision, clearRecognitionScope, closeMathCorrectionSession, closeMathSolverSelection, fitPageToInk, scheduleRedraw, setDirty, updateHistoryState])

  const redo = useCallback(() => {
    const next = redoRef.current.pop()
    if (!next) return
    clearRecognitionScope()
    closeMathSolverSelection()
    closeMathCorrectionSession()
    undoRef.current.push(snapshotStrokes(strokesRef.current))
    strokesRef.current = snapshotStrokes(next)
    setTokens([])
    setCorrection('')
    setAutomaticResult(null)
    bumpInkRevision()
    setDirty(true)
    updateHistoryState()
    fitPageToInk()
  }, [bumpInkRevision, clearRecognitionScope, closeMathCorrectionSession, closeMathSolverSelection, fitPageToInk, setDirty, updateHistoryState])

  const clear = useCallback(() => {
    if (!strokesRef.current.length) return
    clearRecognitionScope()
    closeMathSolverSelection()
    closeMathCorrectionSession()
    undoRef.current.push(snapshotStrokes(strokesRef.current))
    redoRef.current = []
    strokesRef.current = []
    setTokens([])
    setCorrection('')
    setAutomaticResult(null)
    searchTranscriptRef.current = ''
    transcriptUpdatedAtRef.current = null
    bumpInkRevision()
    setDirty(true)
    updateHistoryState()
    fitPageToInk()
  }, [bumpInkRevision, clearRecognitionScope, closeMathCorrectionSession, closeMathSolverSelection, fitPageToInk, setDirty, updateHistoryState])

  const insertSynthesizedHandwriting = useCallback((
    generatedStrokes: SynthesizedInkStroke[],
    result: HandwritingSynthesisResult,
  ) => {
    if (!generatedStrokes.length) return
    clearRecognitionScope()
    undoRef.current.push(snapshotStrokes(strokesRef.current))
    if (undoRef.current.length > 80) undoRef.current.shift()
    redoRef.current = []
    strokesRef.current = [
      ...strokesRef.current,
      ...generatedStrokes,
    ]
    setTokens([])
    setCorrection('')
    setAutomaticResult(null)
    searchTranscriptRef.current = [searchTranscriptRef.current, result.normalizedText.trim()]
      .filter(Boolean)
      .join('\n')
    transcriptUpdatedAtRef.current = new Date().toISOString()
    indexedStrokeCountRef.current = handwritingStrokes(strokesRef.current).length
    transcriptNeedsFullRebuildRef.current = false
    bumpInkRevision({ updateTranscript: false })
    setDirty(true)
    updateHistoryState()
    scheduleRedraw()
    setTextToHandwritingOpen(false)
    setNotice({
      kind: 'success',
      text: `${result.glyphCount} Zeichen als persönliche Handschrift eingefügt${result.connectionCount ? ` · ${result.connectionCount} natürliche Verbindungen` : ''}.`,
    })
    fitPageToInk()
  }, [bumpInkRevision, clearRecognitionScope, fitPageToInk, scheduleRedraw, setDirty, updateHistoryState])

  const drawingPayload = useCallback((includeImage = false): DrawingSavePayload => {
    let imageData: string | undefined
    if (includeImage) {
      const exportKey = [inkRevisionRef.current, paperStyle, settings.smoothing, sourceWidth, sourceHeight].join(':')
      imageData = exportCacheRef.current?.key === exportKey ? exportCacheRef.current.imageData : undefined
      if (!imageData) {
      const exportCanvas = document.createElement('canvas')
      exportCanvas.width = sourceWidth * EXPORT_SCALE
      exportCanvas.height = sourceHeight * EXPORT_SCALE
      renderDocument(
        exportCanvas,
        strokesRef.current,
        paperStyle,
        settings.smoothing,
        exportCanvas.width,
        exportCanvas.height,
        true,
        sourceWidth,
      )
      imageData = exportCanvas.toDataURL('image/png')
      exportCacheRef.current = { key: exportKey, imageData }
      }
    }
    const now = new Date().toISOString()
    const drawing: DrawingDocument = {
      schemaVersion: 1,
      title,
      paperStyle,
      sourceWidth,
      sourceHeight,
      createdAt: createdAtRef.current,
      updatedAt: now,
      strokes: strokesRef.current,
      searchTranscript: searchTranscriptRef.current,
      transcriptMode: 'text-and-math',
      transcriptUpdatedAt: transcriptUpdatedAtRef.current ?? undefined,
      recognitionPreference: mode,
      detectedRecognitionMode: activeMode,
      mathSolverEnabled,
      mathSolverHistory: mathSolverHistoryRef.current,
    }
    return {
      id: drawingIdRef.current,
      title,
      imageData,
      drawingJson: JSON.stringify(drawing),
    }
  }, [activeMode, mathSolverEnabled, mode, paperStyle, settings.smoothing, sourceHeight, sourceWidth, title])

  const saveDrawing = useCallback((insertAfterSave: boolean, silent = false) => {
    if (!strokesRef.current.length) return Promise.resolve()
    if (!silent) {
      queuedSaveCountRef.current += 1
      setIsSaving(true)
    }
    if (!silent) setNotice(null)

    const run = async () => {
      const savedRevision = revisionRef.current
      try {
        const result = await onSaveDrawing(drawingPayload(insertAfterSave))
        if (!mountedRef.current) return
        if (result && typeof result === 'object' && 'id' in result && typeof result.id === 'string') {
          drawingIdRef.current = result.id
        }
        if (revisionRef.current === savedRevision) setDirty(false)
        if (insertAfterSave) {
          const markdown = markdownFromSaveResult(result, title)
          if (!markdown) throw new Error('Die App hat keinen Bildpfad für die gespeicherte Handschrift-Seite zurückgegeben.')
          const inserted = await onInsertMarkdown(markdown)
          if (!inserted) {
            throw new Error('Die Seite wurde gespeichert, konnte aber in keine geöffnete Notiz eingefügt werden.')
          }
          if (!settings.keepDrawingAfterInsert) {
            clear()
            setDirty(false)
          }
          setNotice({ kind: 'success', text: 'Handschrift-Seite gespeichert und in die Notiz eingefügt.' })
        } else if (!silent) {
          setNotice({ kind: 'success', text: 'Handschrift-Seite sicher im Vault gespeichert.' })
        }
      } catch (error) {
        if (mountedRef.current && !silent) {
          setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Handschrift-Seite konnte nicht gespeichert werden.' })
        }
        if (silent) console.error('Automatisches Speichern der Handschrift-Seite fehlgeschlagen.', error)
      } finally {
        if (!silent) {
          queuedSaveCountRef.current = Math.max(0, queuedSaveCountRef.current - 1)
          if (mountedRef.current && queuedSaveCountRef.current === 0) setIsSaving(false)
        }
      }
    }

    const queued = saveQueueRef.current.catch(() => {}).then(run)
    saveQueueRef.current = queued
    return queued
  }, [clear, drawingPayload, onInsertMarkdown, onSaveDrawing, setDirty, settings.keepDrawingAfterInsert, title])

  useEffect(() => {
    saveLatestRef.current = () => saveDrawing(false, true)
  }, [saveDrawing])

  useImperativeHandle(forwardedRef, () => ({
    flush: async () => {
      await saveQueueRef.current
      if (!dirtyRef.current || !strokesRef.current.length) return
      const result = await onSaveDrawing(drawingPayload())
      if (result && typeof result === 'object' && 'id' in result && typeof result.id === 'string') {
        drawingIdRef.current = result.id
      }
      setDirty(false)
    },
    refreshTraining: async () => {
      const loaded = await loadRecognitionResources()
      resourcesRef.current = loaded
      if (mountedRef.current) setResources(loaded)
    },
    supportSnapshot: () => ({ tool, inkMode }),
    applySupportTool: (next) => {
      if (next === 'eraser') {
        setTool('eraser')
        setArtPanelOpen(false)
        return
      }
      if (next === 'drawing') {
        setInkMode('drawing')
        setTool('pen')
        return
      }
      if (next === 'writing') {
        setInkMode('writing')
        setTool('pen')
        setArtPanelOpen(false)
        return
      }
      setTool('pen')
    },
  }), [drawingPayload, inkMode, onSaveDrawing, setDirty, tool])

  useEffect(() => () => {
    if (dirtyRef.current && strokesRef.current.length) void saveLatestRef.current()
  }, [])

  const recognize = useCallback(async (
    requestedMode: RecognitionPreference = mode,
    scopedStrokes?: InkStroke[],
  ) => {
    if (!settings.experimentalHandwritingToText) {
      setNotice({ kind: 'info', text: 'Handschrift zu Text ist experimentell und in den Einstellungen ausgeschaltet.' })
      return
    }
    const engineStrokes: Stroke[] = snapshotStrokes(handwritingStrokes(scopedStrokes ?? strokesRef.current))
    if (!engineStrokes.length) return
    const runId = ++recognitionRunRef.current
    setIsRecognizing(true)
    setNotice(null)
    setWholeFormulaResult(false)
    try {
      const [loaded, recognitionEngine] = await Promise.all([
        loadRecognitionResources(),
        loadRecognitionModule(),
      ])
      if (runId !== recognitionRunRef.current) return
      if (!loaded.model.length) {
        setConversionOpen(true)
        setNotice({ kind: 'error', text: 'Das lokale Standardmodell konnte nicht geladen werden.' })
        return
      }
      resourcesRef.current = loaded
      setResources(loaded)
      let resolvedMode: RecognitionMode
      let recognized: RecognitionToken[]
      let value: string
      let automaticDetection: AutomaticRecognitionResult | null = null
      let neuralTextUsed = false
      let neuralTextFailure = ''
      let enhancedMathFailure = ''
      let enhancedMathUsed = false
      if (requestedMode === 'auto') {
        const detected = recognitionEngine.recognizeAutomaticExpression(
          engineStrokes,
          loaded.model,
          loaded.labels,
          loaded.layoutExamples,
          settings.recognitionLanguage,
          settings.lastRecognitionMode,
        )
        resolvedMode = detected.mode
        recognized = detected.tokens
        value = detected.value
        automaticDetection = detected
      } else {
        resolvedMode = requestedMode
        recognized = requestedMode === 'math'
          ? recognitionEngine.recognizeMathDocument(
              engineStrokes,
              loaded.model,
              loaded.labels,
              loaded.layoutExamples,
              settings.recognitionLanguage,
            )
          : recognitionEngine.recognizeExpression(
              engineStrokes,
              loaded.model,
              loaded.labels,
              requestedMode,
              loaded.layoutExamples,
              settings.recognitionLanguage,
            )
        value = requestedMode === 'math'
          ? recognitionEngine.recognizedLatex(recognized, loaded.layoutExamples)
          : recognitionEngine.recognizedSentence(recognized)
      }

      // Optional Qwen3-VL (Intel NPU): recommended text engine. Run it before
      // the slower neural line model so the conversion uses the VLM first.
      let qwenVisionFailure = ''
      let qwenVisionUsed = false
      const recognizeQwenVision = window.fanotes.recognizeQwenVision
      const qwenVisionReady = Boolean(
        settings.qwenVisionRecognition
        && settings.qwenVisionLicenseAccepted
        && recognizeQwenVision,
      )
      const textModeLikely = resolvedMode === 'text'
        || (
          requestedMode !== 'math'
          && Boolean(automaticDetection)
          && automaticDetection!.textScore > automaticDetection!.mathScore
        )
      if (textModeLikely && qwenVisionReady) {
        try {
          const {
            applyGlyphenWerkLegend,
            cleanQwenVisionText,
            renderQwenVisionImage,
            shouldPreferQwenVisionText,
          } = await import('../lib/qwenVisionRecognition')
          const visionImage = renderQwenVisionImage(engineStrokes, sourceWidth, sourceHeight)
          if (visionImage) {
            const visionPage = await applyGlyphenWerkLegend(
              visionImage,
              (resourcesRef.current ?? loaded).samples,
            )
            const vision = await recognizeQwenVision!({
              pixels: visionPage.pixels,
              width: visionPage.width,
              height: visionPage.height,
              lineCount: visionPage.lineCount,
              language: settings.recognitionLanguage === 'en' ? 'en' : 'de',
              hasGlyphLegend: Boolean(visionPage.hasGlyphLegend),
              maxNewTokens: Math.min(512, Math.max(128, visionPage.lineCount * 48 + engineStrokes.length * 6 + 96)),
            })
            if (runId !== recognitionRunRef.current) return
            const visionText = cleanQwenVisionText(vision.text || '')
            if (
              vision.device === 'NPU'
              && visionText
              && shouldPreferQwenVisionText(value, visionText, engineStrokes.length)
            ) {
              value = visionText
              qwenVisionUsed = true
              resolvedMode = 'text'
              recognized = []
              if (automaticDetection) {
                automaticDetection = {
                  ...automaticDetection,
                  mode: 'text',
                  value,
                  confidence: Math.max(automaticDetection.confidence, vision.confidence ?? 86),
                  reason: 'Qwen3-VL, empfohlene Texterkennung auf der Intel-NPU',
                  textScore: Math.max(automaticDetection.textScore, 1.55 + (vision.confidence ?? 86) / 45),
                }
              }
            }
          }
        } catch (error) {
          qwenVisionFailure = error instanceof Error
            ? error.message
            : 'Qwen3-VL konnte nicht auf der NPU ausgeführt werden.'
        }
      }

      if (requestedMode !== 'math' && !qwenVisionUsed) {
        try {
          const { recognizeNeuralText } = await import('../lib/neuralTextRecognition')
          const neural = await recognizeNeuralText(
            engineStrokes,
            settings.recognitionLanguage,
            sourceWidth,
            sourceHeight,
          )
          if (runId !== recognitionRunRef.current) return
          const compact = neural.text.replace(/\s/gu, '')
          const neuralModeAssessment = assessNeuralTextModeCandidate(
            neural.text,
            settings.recognitionLanguage,
            neural,
            automaticDetection,
          )
          const letters = neuralModeAssessment.letters
          const hasPersonalTextEvidence = recognized.some((token) => (
            (token.personalSupport ?? 0) > 0 ||
            token.alternatives.some((alternative) => (alternative.personalSupport ?? 0) > 0)
          ))
          const strongAutomaticText = neuralModeAssessment.shouldUseText
          const usableExplicitText = requestedMode === 'text'
            && (hasPersonalTextEvidence || neural.confidence >= 32)
            && (compact.length >= 2 || letters >= 1)
          if (neural.text && (usableExplicitText || automaticDetection?.mode === 'text' || strongAutomaticText)) {
            const { recognizePersonalizedTextLine } = await import('../lib/personalizedLineRecognition')
            const personalized = await recognizePersonalizedTextLine(
              engineStrokes,
              loaded,
              neural,
              settings.recognitionLanguage,
              false,
              sourceWidth,
              sourceHeight,
            )
            const fused = personalized.fusion
            recognized = personalized.tokens
            resolvedMode = 'text'
            value = fused.text
            neuralTextUsed = fused.neuralCharacters > 0
            if (automaticDetection) {
              const neuralTextScore = 1.1 + fused.confidence / 45 + Math.min(1.4, letters * 0.08)
              automaticDetection = {
                ...automaticDetection,
                mode: 'text',
                tokens: recognized,
                value,
                confidence: fused.confidence,
                reason: fused.source === 'personalized'
                  ? 'personalisierte Stiftverlaufs-Erkennung'
                  : fused.source === 'hybrid'
                    ? 'Fusion aus persönlicher Handschrift und Zeilenmodell'
                    : 'zeilenbasierte lokale Handschrifterkennung',
                textScore: Math.max(automaticDetection.textScore, neuralTextScore),
              }
            }
          }
        } catch (error) {
          neuralTextFailure = error instanceof Error ? error.message : 'Das neuronale Textmodell konnte nicht geladen werden.'
        }
      }

      if (
        resolvedMode === 'math'
        && settings.enhancedMathRecognition
        && settings.enhancedMathLicenseAccepted
        && window.fanotes.recognizeEnhancedMath
      ) {
        try {
          const { renderEnhancedMathImage } = await import('../lib/enhancedMathRecognition')
          const image = renderEnhancedMathImage(engineStrokes, sourceWidth, sourceHeight)
          if (image) {
            const enhanced = await window.fanotes.recognizeEnhancedMath(image)
            if (runId !== recognitionRunRef.current) return
            // The independent MathWriting holdout shows a clear gain for
            // fractions, roots, limits, integrals and scripts. Simple linear
            // expressions remain on the existing recognizer: replacing those
            // merely because the optional decoder returned valid LaTeX caused
            // measurable regressions on out-of-domain handwriting.
            if (enhanced.recommended) {
              value = enhanced.latex
              enhancedMathUsed = true
              if (automaticDetection) automaticDetection = {
                ...automaticDetection,
                mode: 'math',
                value,
                reason: 'zweidimensionales lokales Formelmodell',
              }
            }
          }
        } catch (error) {
          enhancedMathFailure = error instanceof Error
            ? error.message
            : 'Das erweiterte Formelmodell konnte nicht ausgeführt werden.'
        }
      }

      setAutomaticResult(automaticDetection ? {
        confidence: automaticDetection.confidence,
        reason: automaticDetection.reason,
        textScore: automaticDetection.textScore,
        mathScore: automaticDetection.mathScore,
      } : null)
      onSettingsChange?.({
        recognitionMode: requestedMode,
        lastRecognitionMode: resolvedMode,
      })
      setRecognizedMode(resolvedMode)
      // Whole-formula decoding has no trustworthy one-to-one mapping to the
      // classic glyph tokens. Hiding those stale alternatives also prevents a
      // later insertion from training the personal glyph model on a mismatched
      // sequence.
      setTokens(enhancedMathUsed || qwenVisionUsed ? [] : recognized)
      setWholeFormulaResult(enhancedMathUsed)
      setCorrection(value)
      setConversionOpen(true)
      const contextChanges = recognized.filter((token) => token.context?.changed).length
      if (resolvedMode === 'text' && neuralTextFailure && !neuralTextUsed && !qwenVisionUsed) {
        setNotice({
          kind: 'info',
          text: `${neuralTextFailure} FaNotes verwendet vorübergehend die klassische Erkennung.`,
        })
      } else if (resolvedMode === 'math' && enhancedMathFailure) {
        setNotice({
          kind: 'info',
          text: `${enhancedMathFailure} FaNotes verwendet für diese Eingabe die klassische lokale Mathematikerkennung.`,
        })
      } else if (resolvedMode === 'text' && qwenVisionFailure && !qwenVisionUsed) {
        setNotice({
          kind: 'info',
          text: `${qwenVisionFailure} FaNotes bleibt bei der klassischen lokalen Texterkennung.`,
        })
      } else if (resolvedMode === 'text' && qwenVisionUsed) {
        setNotice({
          kind: 'success',
          text: 'Qwen3-VL hat den Text gelesen — empfohlene Texterkennung auf der Intel-NPU. Du kannst das Ergebnis weiter korrigieren.',
        })
      } else if (resolvedMode === 'text' && contextChanges > 0 && !neuralTextUsed) {
        setNotice({
          kind: 'info',
          text: `Der lokale Wortkontext hat ${contextChanges} unsichere${contextChanges === 1 ? 's Zeichen' : ' Zeichen'} plausibel aufgelöst. Du kannst das Ergebnis weiterhin korrigieren.`,
        })
      } else if (!value || value.includes('?')) {
        setNotice({ kind: 'info', text: 'Einige Zeichen sind noch unsicher. Wähle Alternativen oder korrigiere das Ergebnis direkt.' })
      }
    } catch (error) {
      if (runId === recognitionRunRef.current) {
        setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Handschrift konnte nicht analysiert werden.' })
      }
    } finally {
      if (mountedRef.current && runId === recognitionRunRef.current) setIsRecognizing(false)
    }
  }, [mode, onSettingsChange, settings.enhancedMathLicenseAccepted, settings.enhancedMathRecognition, settings.experimentalHandwritingToText, settings.lastRecognitionMode, settings.qwenVisionLicenseAccepted, settings.qwenVisionRecognition, settings.recognitionLanguage, sourceHeight, sourceWidth])

  useEffect(() => {
    recognizeLatestRef.current = recognize
  }, [recognize])

  const recognizePage = useCallback(() => {
    if (!settings.experimentalHandwritingToText) {
      setNotice({ kind: 'info', text: 'Handschrift zu Text ist experimentell und in den Einstellungen ausgeschaltet.' })
      return
    }
    closeMathSolverSelection()
    closeMathCorrectionSession()
    setMathCorrectorEnabled(false)
    recognitionStrokesRef.current = null
    setRecognitionScope('page')
    setSelectionMode(false)
    setSelectionRect(null)
    setConversionOpen(true)
    void recognize(mode, handwritingStrokes(strokesRef.current))
  }, [closeMathCorrectionSession, closeMathSolverSelection, mode, recognize, settings.experimentalHandwritingToText])

  const applyInkTransform = useCallback((mutatePoint: (x: number, y: number) => { x: number; y: number }) => {
    const indexes = new Set(selectedStrokeIndexesRef.current)
    if (!indexes.size) return
    strokesRef.current = strokesRef.current.map((stroke, index) => {
      if (!indexes.has(index)) return stroke
      return {
        ...stroke,
        points: stroke.points.map((point) => {
          const next = mutatePoint(point.x, point.y)
          return { ...point, x: clamp(next.x), y: clamp(next.y, 0, 8) }
        }),
      }
    })
    scheduleRedraw()
    setDirty(true)
    updateHistoryState()
  }, [scheduleRedraw, setDirty, updateHistoryState])

  const beginInkEdit = useCallback(() => {
    closeMathSolverSelection()
    closeMathCorrectionSession()
    setMathCorrectorEnabled(false)
    setConversionOpen(false)
    selectedStrokeIndexesRef.current = []
    setSelectionMode(true)
    setSelectionPurpose('edit')
    setSelectionRect(null)
    setNotice({ kind: 'info', text: 'Rahmen um die Tinte ziehen, dann verschieben, kopieren oder skalieren.' })
  }, [closeMathCorrectionSession, closeMathSolverSelection])

  const copySelectedInk = useCallback(() => {
    const indexes = selectedStrokeIndexesRef.current
    if (!indexes.length) return
    const copies: InkStroke[] = []
    for (const index of indexes) {
      const stroke = strokesRef.current[index]
      if (!stroke) continue
      copies.push({
        ...stroke,
        points: stroke.points.map((point) => ({ ...point, x: clamp(point.x + 0.03), y: clamp(point.y + 0.03, 0, 8) })),
      })
    }
    const start = strokesRef.current.length
    strokesRef.current = [...strokesRef.current, ...copies]
    selectedStrokeIndexesRef.current = copies.map((_, offset) => start + offset)
    setSelectionRect((current) => current && { ...current, x: clamp(current.x + 0.03), y: clamp(current.y + 0.03, 0, 8) })
    scheduleRedraw()
    setDirty(true)
    updateHistoryState()
  }, [scheduleRedraw, setDirty, updateHistoryState])

  const deleteSelectedInk = useCallback(() => {
    const indexes = new Set(selectedStrokeIndexesRef.current)
    if (!indexes.size) return
    strokesRef.current = strokesRef.current.filter((_, index) => !indexes.has(index))
    selectedStrokeIndexesRef.current = []
    setSelectionRect(null)
    scheduleRedraw()
    setDirty(true)
    updateHistoryState()
    fitPageToInk()
  }, [fitPageToInk, scheduleRedraw, setDirty, updateHistoryState])

  const beginSelectionRecognition = useCallback(() => {
    if (!settings.experimentalHandwritingToText) {
      setNotice({ kind: 'info', text: 'Handschrift zu Text ist experimentell und in den Einstellungen ausgeschaltet.' })
      return
    }
    closeMathSolverSelection()
    closeMathCorrectionSession()
    setMathCorrectorEnabled(false)
    recognitionRunRef.current += 1
    recognitionStrokesRef.current = null
    setRecognitionScope('selection')
    setSelectionMode(true)
    setSelectionPurpose('conversion')
    setSelectionRect(null)
    setConversionOpen(false)
    setTokens([])
    setCorrection('')
    setAutomaticResult(null)
    setNotice({ kind: 'info', text: 'Ziehe auf der Seite einen Rahmen um die Handschrift, die du konvertieren möchtest. Esc bricht ab.' })
    requestAnimationFrame(() => boardRef.current?.focus({ preventScroll: true }))
  }, [closeMathCorrectionSession, closeMathSolverSelection, settings.experimentalHandwritingToText])

  const updateHiddenTranscript = useCallback(async () => {
    if (!settings.experimentalHandwritingToText) return
    const currentHandwriting = handwritingStrokes(strokesRef.current)
    if (!currentHandwriting.length) return
    const learningRun = ++contextualLearningRunRef.current
    try {
      const [loaded, recognitionEngine] = await Promise.all([
        resourcesRef.current ?? loadRecognitionResources(),
        loadRecognitionModule(),
      ])
      if (!loaded.model.length) return
      resourcesRef.current = loaded
      const currentStrokeCount = currentHandwriting.length
      const previousStrokeCount = indexedStrokeCountRef.current
      const appendOnly = !transcriptNeedsFullRebuildRef.current && currentStrokeCount >= previousStrokeCount
      const recognitionStart = appendOnly && previousStrokeCount > 0
        ? Math.max(0, previousStrokeCount - 24)
        : currentStrokeCount > 360
          ? currentStrokeCount - 240
          : 0
      const recognitionStrokes = snapshotStrokes(currentHandwriting.slice(recognitionStart))
      const chunks = backgroundRecognitionChunks(recognitionStrokes, sourceHeight)
      const textTokens: RecognitionToken[] = []
      const textValues: string[] = []
      const mathValues: string[] = []
      for (const chunk of chunks) {
        if (learningRun !== contextualLearningRunRef.current || document.hasFocus()) return
        await waitForBackgroundIdle()
        if (learningRun !== contextualLearningRunRef.current || document.hasFocus()) return
        const automatic = mode === 'auto'
          ? recognitionEngine.recognizeAutomaticExpression(
            chunk,
            loaded.model,
            loaded.labels,
            loaded.layoutExamples,
            settings.recognitionLanguage,
            settings.lastRecognitionMode,
          )
          : null
        const backgroundMode = automatic?.mode ?? activeMode
        const ambiguousAutomaticMode = Boolean(automatic && automatic.mathScore - automatic.textScore < 2.2)
        const decisiveAutomaticMath = Boolean(automatic && hasDecisiveMathLayout(automatic.mathValue))
        const couldBeMisclassifiedText = Boolean(automatic && mode === 'auto' && !decisiveAutomaticMath)
        if (backgroundMode === 'text' || ambiguousAutomaticMode || couldBeMisclassifiedText) {
          let chunkTextTokens = automatic?.mode === 'text'
            ? automatic.tokens
            : recognitionEngine.recognizeExpression(
                chunk,
                loaded.model,
                loaded.labels,
                'text',
                loaded.layoutExamples,
                settings.recognitionLanguage,
              )
          const hasPersonalTextEvidence = chunkTextTokens.some((token) => (
            (token.personalSupport ?? 0) > 0 ||
            token.alternatives.some((alternative) => (alternative.personalSupport ?? 0) > 0)
          ))
          let neuralValue = ''
          try {
            const { recognizeNeuralText } = await import('../lib/neuralTextRecognition')
            const neural = await recognizeNeuralText(
              chunk,
              settings.recognitionLanguage,
              sourceWidth,
              sourceHeight,
            )
            const neuralModeAssessment = assessNeuralTextModeCandidate(
              neural.text,
              settings.recognitionLanguage,
              neural,
              automatic,
            )
            const letters = neuralModeAssessment.letters
            const minimumConfidence = backgroundMode === 'text'
              ? hasPersonalTextEvidence ? 0 : 32
              : 54
            if (
              neural.confidence >= minimumConfidence
              && letters >= (backgroundMode === 'text' ? 1 : 3)
              && neuralModeAssessment.wordLike
              && !neuralModeAssessment.explicitFormulaSyntax
              && (backgroundMode === 'text' || neuralModeAssessment.shouldUseText)
            ) {
              const { recognizePersonalizedTextLine } = await import('../lib/personalizedLineRecognition')
              const personalized = await recognizePersonalizedTextLine(
                chunk,
                loaded,
                neural,
                settings.recognitionLanguage,
                false,
                sourceWidth,
                sourceHeight,
              )
              chunkTextTokens = personalized.tokens
              neuralValue = personalized.fusion.text.trim()
            }
          } catch {
            // The classic local recognizer remains a bounded offline fallback.
          }
          if (neuralValue) {
            textTokens.push(...chunkTextTokens)
            textValues.push(neuralValue)
          } else if (automatic?.mode === 'math') {
            const mathValue = automatic.value.trim()
            if (mathValue) mathValues.push(mathValue)
          } else {
            textTokens.push(...chunkTextTokens)
            const textValue = (automatic?.mode === 'text'
              ? automatic.value
              : recognitionEngine.recognizedSentence(chunkTextTokens)).trim()
            if (textValue) textValues.push(textValue)
          }
        } else {
          const mathTokens = automatic?.mode === 'math'
            ? automatic.tokens
            : recognitionEngine.recognizeExpression(
              chunk,
              loaded.model,
              loaded.labels,
              'math',
              loaded.layoutExamples,
              settings.recognitionLanguage,
            )
          const mathValue = (automatic?.mode === 'math'
            ? automatic.value
            : recognitionEngine.recognizedLatex(mathTokens, loaded.layoutExamples)).trim()
          if (mathValue) mathValues.push(mathValue)
        }
      }
      if (learningRun !== contextualLearningRunRef.current) return
      const latestTranscript = [textValues.join('\n'), mathValues.join('\n')].filter(Boolean)
      const replaceTranscript = !appendOnly && currentStrokeCount <= 360
      searchTranscriptRef.current = [...new Set([
        ...(replaceTranscript ? [] : searchTranscriptRef.current.split('\n').filter(Boolean)),
        ...latestTranscript,
      ])].slice(-2_000).join('\n')
      transcriptUpdatedAtRef.current = new Date().toISOString()
      indexedStrokeCountRef.current = currentHandwriting.length
      transcriptNeedsFullRebuildRef.current = false
      const learning = await learnFromContextualRecognition(
        textTokens,
        settings.recognitionLanguage,
        loaded.labels,
      )
      if (learning.learnedSamples > 0 && learningRun === contextualLearningRunRef.current) {
        const refreshed = await loadRecognitionResources(true)
        resourcesRef.current = refreshed
        if (mountedRef.current) setResources(refreshed)
      }
    } catch (error) {
      // Background indexing must never interrupt freehand writing.
      console.error('Unsichtbares Handschrift-Transkript konnte nicht aktualisiert werden.', error)
    }
  }, [activeMode, mode, settings.experimentalHandwritingToText, settings.lastRecognitionMode, settings.recognitionLanguage, sourceHeight])

  useEffect(() => {
    if (revision === 0 || !strokesRef.current.length) return
    if (!dirtyRef.current) return
    let idleId: number | null = null
    const saveTimer = window.setTimeout(() => {
      idleId = window.requestIdleCallback(() => { void saveDrawing(false, true) }, { timeout: 2_500 })
    }, 900)
    return () => {
      window.clearTimeout(saveTimer)
      if (idleId !== null) window.cancelIdleCallback(idleId)
    }
  }, [revision, saveDrawing])

  useEffect(() => {
    if (transcriptRevision === 0 || !strokesRef.current.length) return
    let cancelled = false
    let ready = false
    let idleId: number | null = null
    const runDuringIdle = () => {
      if (cancelled || document.hasFocus() || idleId !== null) return
      idleId = window.requestIdleCallback(() => {
        idleId = null
        if (cancelled || document.hasFocus()) return
        void updateHiddenTranscript().finally(() => {
          if (!cancelled && mountedRef.current) void saveDrawing(false, true)
        })
      }, { timeout: 3_000 })
    }
    const handleActivity = () => {
      if (document.hasFocus()) {
        contextualLearningRunRef.current += 1
      }
      if (document.hasFocus() && idleId !== null) {
        window.cancelIdleCallback(idleId)
        idleId = null
      } else if (!document.hasFocus() && ready) {
        runDuringIdle()
      }
    }
    document.addEventListener('visibilitychange', handleActivity)
    window.addEventListener('focus', handleActivity)
    window.addEventListener('blur', handleActivity)
    const transcriptTimer = window.setTimeout(() => {
      ready = true
      runDuringIdle()
    }, 4_000)
    return () => {
      cancelled = true
      window.clearTimeout(transcriptTimer)
      if (idleId !== null) window.cancelIdleCallback(idleId)
      document.removeEventListener('visibilitychange', handleActivity)
      window.removeEventListener('focus', handleActivity)
      window.removeEventListener('blur', handleActivity)
    }
  }, [saveDrawing, transcriptRevision, updateHiddenTranscript])

  const changeRecognitionMode = useCallback((nextMode: RecognitionPreference) => {
    if (nextMode === mode) return
    setMode(nextMode)
    setTokens([])
    setCorrection('')
    setAutomaticResult(null)
    if (nextMode !== 'auto') setRecognizedMode(nextMode)
    onSettingsChange?.(nextMode === 'auto'
      ? { recognitionMode: 'auto' }
      : { recognitionMode: nextMode, lastRecognitionMode: nextMode })
    const scopedStrokes = handwritingStrokes(recognitionStrokesRef.current ?? strokesRef.current)
    if (scopedStrokes.length && resourcesRef.current?.model.length) {
      void recognize(nextMode, scopedStrokes)
    }
  }, [mode, onSettingsChange, recognize])

  const updateToken = useCallback((tokenId: string, labelId: string) => {
    const activeResources = resourcesRef.current
    const recognitionEngine = loadedRecognitionModule
    const label = activeResources?.labels.find((entry) => entry.id === labelId) ?? BASE_CATALOG.find((entry) => entry.id === labelId)
    if (!label) return
    const sourceToken = tokens.find((token) => token.id === tokenId)
    if (!sourceToken || sourceToken.labelId === label.id) return
    const correctedToText = (
      label.category === 'uppercase' ||
      label.category === 'lowercase' ||
      label.category === 'german'
    )
    const learningMode: RecognitionMode = correctedToText ? 'text' : activeMode
    setTokens((current) => {
      const next = current.map((token) => token.id === tokenId ? {
        ...token,
        labelId: label.id,
        char: label.char,
        name: label.name,
        latex: label.latex,
        confidence: token.alternatives.find((alternative) => alternative.labelId === label.id)?.confidence ?? token.confidence,
        context: undefined,
      } : token)
      const visible = next.filter((token) => !token.isLayout)
      const correctedToSingleTextLetter = (
        mode === 'auto' &&
        visible.length === 1 &&
        (label.category === 'uppercase' || label.category === 'lowercase' || label.category === 'german')
      )
      const correctedMode = correctedToSingleTextLetter ? 'text' : activeMode
      if (correctedToSingleTextLetter) {
        setRecognizedMode('text')
        setAutomaticResult((currentResult) => currentResult ? {
          ...currentResult,
          confidence: 100,
          reason: 'bestätigte manuelle Korrektur',
          textScore: Math.max(currentResult.textScore, currentResult.mathScore + 1),
        } : currentResult)
        onSettingsChange?.({ recognitionMode: 'auto', lastRecognitionMode: 'text' })
      }
      setCorrection(correctedMode === 'math'
        ? recognitionEngine?.recognizedLatex(next, activeResources?.layoutExamples ?? [])
          ?? next.filter((token) => !token.isLayout).map((token) => token.latex || token.char).join('')
        : recognitionEngine?.recognizedSentence(next)
          ?? next.filter((token) => !token.isLayout).map((token) => token.char).join(''))
      return next
    })
    if (activeResources) {
      void learnFromRecognitionCorrection(
        [sourceToken],
        learningMode === 'math' ? label.latex || label.char : label.char,
        learningMode,
        activeResources.labels,
        activeResources.layoutExamples,
      ).then(async (learningResult) => {
        if (!learningResult.learnedSamples && !learningResult.learnedLayouts) return
        const refreshed = await loadRecognitionResources(true)
        resourcesRef.current = refreshed
        if (mountedRef.current) {
          setResources(refreshed)
          setNotice({
            kind: 'success',
            text: `Korrektur sofort gelernt: ${label.char}`,
          })
          onTrainingChanged?.(refreshed.sampleCount)
        }
      }).catch(() => {
        if (mountedRef.current) {
          setNotice({
            kind: 'info',
            text: 'Die Auswahl wurde übernommen; das lokale Nachlernen wird beim Einfügen erneut versucht.',
          })
        }
      })
    }
  }, [activeMode, mode, onSettingsChange, onTrainingChanged, tokens])

  const insertConversion = useCallback(async () => {
    const cleaned = correction.trim().replace(/^\$+|\$+$/gu, '')
    if (!cleaned) return
    setNotice(null)
    try {
      const inserted = await onInsertMarkdown(activeMode === 'math' ? `$${cleaned}$` : cleaned)
      if (!inserted) {
        throw new Error('Öffne zuerst eine Notiz, damit die Konvertierung eingefügt werden kann.')
      }

      const loaded = resourcesRef.current
      let learningResult: CorrectionLearningResult | null = null
      let learningFailed = false
      if (loaded && tokens.length && !wholeFormulaResult) {
        try {
          learningResult = await learnFromRecognitionCorrection(
            tokens,
            cleaned,
            activeMode,
            loaded.labels,
            loaded.layoutExamples,
          )
          if (learningResult.learnedSamples || learningResult.learnedLayouts) {
            const refreshed = await loadRecognitionResources(true)
            resourcesRef.current = refreshed
            setResources(refreshed)
            onTrainingChanged?.(refreshed.sampleCount)
          }
        } catch {
          // Das Einfügen darf nie an optionalem lokalem Nachlernen scheitern.
          learningFailed = true
        }
      }

      const learnedCount = (learningResult?.learnedSamples ?? 0) + (learningResult?.learnedLayouts ?? 0)
      const learningMessage = learnedCount > 0
        ? ` Lokales Modell mit ${learningResult!.learnedSamples} Zeichen${learningResult!.learnedLayouts ? ` und ${learningResult!.learnedLayouts} Layout-Beispielen` : ''} verbessert.`
        : learningResult?.reason
          ? ` ${learningResult.reason}`
          : learningFailed ? ' Lokales Nachlernen war diesmal nicht möglich.' : ''
      setNotice({ kind: 'success', text: `Konvertierung eingefügt.${learningMessage}` })
      searchTranscriptRef.current = cleaned
      transcriptUpdatedAtRef.current = new Date().toISOString()
      indexedStrokeCountRef.current = handwritingStrokes(strokesRef.current).length
      transcriptNeedsFullRebuildRef.current = false
      await saveDrawing(false, true)
      if (!settings.keepDrawingAfterInsert) {
        clear()
        setDirty(false)
      }
    } catch (error) {
      if (mountedRef.current) {
        setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Konvertierung konnte nicht eingefügt werden.' })
      }
    }
  }, [activeMode, clear, correction, onInsertMarkdown, onTrainingChanged, saveDrawing, settings.keepDrawingAfterInsert, tokens, wholeFormulaResult])

  const importTraining = useCallback(async (file: File) => {
    setIsImporting(true)
    setNotice(null)
    try {
      const result = await importGlyphenWerkZip(file)
      const loaded = await loadRecognitionResources(true)
      resourcesRef.current = loaded
      setResources(loaded)
      onTrainingChanged?.(loaded.sampleCount)
      const importedCount = result.importedSamples + result.importedLayoutExamples + result.importedLabels
      const warning = result.warnings[0] ? ` ${result.warnings[0]}` : ''
      setNotice(importedCount > 0 ? {
        kind: 'success',
        text: `${result.importedSamples} Zeichen und ${result.importedLayoutExamples} Layout-Beispiele importiert.${warning}`,
      } : {
        kind: 'info',
        text: `Keine neuen Trainingsbeispiele gespeichert; vorhandene Duplikate wurden ausgelassen.${warning}`,
      })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Training konnte nicht importiert werden.' })
    } finally {
      if (mountedRef.current) setIsImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [onTrainingChanged])

  const resetTraining = useCallback(async () => {
    const confirmed = window.confirm(
      'Lokales Handschrift-Training wirklich vollständig löschen? Diese Aktion entfernt alle importierten und durch Korrekturen gelernten Beispiele dauerhaft.',
    )
    if (!confirmed) return
    setIsResettingTraining(true)
    setNotice(null)
    try {
      await clearHandwritingTraining()
      const loaded = await loadRecognitionResources(true)
      resourcesRef.current = loaded
      setResources(loaded)
      setTokens([])
      setCorrection('')
      onTrainingChanged?.(loaded.sampleCount)
      setNotice({ kind: 'success', text: 'Lokales Handschrift-Training wurde vollständig zurückgesetzt.' })
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Training konnte nicht zurückgesetzt werden.',
      })
    } finally {
      if (mountedRef.current) setIsResettingTraining(false)
    }
  }, [onTrainingChanged])

  const mathPreview = useMemo(() => {
    if (activeMode !== 'math' || !correction.trim() || !katexModule) return ''
    const latex = correction.trim().replace(/^\$+|\$+$/gu, '')
    try {
      return katexModule.default.renderToString(latex, {
        displayMode: true,
        throwOnError: false,
        strict: false,
        output: 'htmlAndMathml',
      })
    } catch {
      return ''
    }
  }, [activeMode, correction, katexModule])

  const runMathSolverAction = useCallback(async (action: MathSolverAction) => {
    const selection = mathSolverSelection
    const inspection = mathSolverInspection.inspection
    if (!selection || selection.status !== 'ready' || !inspection) return
    const variable = action === 'solve' ? (mathSolverVariable || inspection.variables[0]) : undefined
    setIsMathSolving(true)
    setNotice(null)
    try {
      const { solveMathExpressionSafely } = await import('../lib/mathSolverClient')
      const result = await solveMathExpressionSafely(mathSolverInput, action, variable)
      const loaded = resourcesRef.current ?? await loadRecognitionResources()
      if (!loaded.sampleCount || !loaded.samples.length) {
        throw new Error('Für die handschriftliche Ausgabe fehlt dein GlyphenWerk-Training.')
      }
      resourcesRef.current = loaded
      setResources(loaded)

      const glyphHeights = selection.tokens
        .filter((token) => !token.isLayout && token.bbox[3] > 0.008 && token.bbox[3] < 0.12)
        .map((token) => token.bbox[3] * sourceHeight)
      const inferredFontSize = clamp((median(glyphHeights) || 26) / 0.73, 22, 58)
      const previousFormat = [...mathSolverHistoryRef.current]
        .reverse()
        .find((entry) => entry.action === action)
      const fontSize = previousFormat
        ? clamp(inferredFontSize * 0.7 + previousFormat.fontSize * 0.3, 20, 60)
        : inferredFontSize
      const lineSpacing = previousFormat?.lineSpacing ?? 1.42
      const selectionLeft = selection.rect.x * sourceWidth
      const selectionRight = (selection.rect.x + selection.rect.width) * sourceWidth
      const selectionTop = selection.rect.y * sourceHeight
      const selectionBottom = (selection.rect.y + selection.rect.height) * sourceHeight
      const estimatedResultWidth = continuationText(result, 'same-line').length * fontSize * 0.48
      let placement: Exclude<MathSolverPlacement, 'auto'> = mathSolverPlacement === 'auto'
        ? previousFormat?.placement
          ?? (action === 'solve' || result.normalizedInput.includes('=') || selectionRight + estimatedResultWidth + 52 > sourceWidth
            ? 'next-line'
            : 'same-line')
        : mathSolverPlacement

      const baselineCandidates = selection.tokens
        .filter((token) => !token.isLayout && token.bbox[3] >= (median(glyphHeights) / sourceHeight || 0.014) * 0.62)
        .map((token) => (token.bbox[1] + token.bbox[3]) * sourceHeight)
      const sourceBaseline = median(baselineCandidates) || selectionTop + (selectionBottom - selectionTop) * 0.76
      const createResult = (targetPlacement: Exclude<MathSolverPlacement, 'auto'>) => {
        const text = adaptMathTextToSamples(continuationText(result, targetPlacement), loaded.samples)
        const sameLine = targetPlacement === 'same-line'
        const options = {
          fontSize,
          lineSpacing,
          variation: 0.5,
          connectLetters: false,
          color: penColor,
          baseWidth: penWidth,
          pressureEnabled: settings.pressureEnabled,
          seed: createHandwritingSeed(),
          marginLeft: sameLine ? selectionRight + 14 : Math.max(44, selectionLeft),
          marginRight: 44,
          marginTop: 18,
          marginBottom: 42,
          startY: sameLine ? sourceBaseline : selectionBottom + fontSize * 1.02,
        }
        return {
          text,
          generated: sameLine
            ? synthesizeHandwriting(text, loaded.samples, options, { width: sourceWidth, height: sourceHeight })
            : synthesizeHandwritingToFit(text, loaded.samples, options, { width: sourceWidth, height: sourceHeight }, 18),
        }
      }

      let synthesis = createResult(placement)
      if (placement === 'same-line' && synthesis.generated.lineCount > 1) {
        placement = 'next-line'
        synthesis = createResult(placement)
      }
      if (synthesis.generated.missingCharacters.length) {
        const missing = synthesis.generated.missingCharacters.slice(0, 8).map((char) => char === ' ' ? 'Leerzeichen' : `„${char}“`).join(', ')
        throw new Error(`Für die handschriftliche Lösung fehlen Trainingszeichen: ${missing}. Ergänze sie in GlyphenWerk und importiere das Training erneut.`)
      }
      if (synthesis.generated.overflow || !synthesis.generated.strokes.length) {
        throw new Error('Unter oder neben dem Ausdruck ist auf dieser Seite nicht genug Platz für die vollständige Lösung.')
      }

      undoRef.current.push(snapshotStrokes(strokesRef.current))
      if (undoRef.current.length > 80) undoRef.current.shift()
      redoRef.current = []
      strokesRef.current = [...strokesRef.current, ...synthesis.generated.strokes]
      const transcript = [result.normalizedInput, ...result.steps.map((step) => step.display)].join(' ')
      searchTranscriptRef.current = [searchTranscriptRef.current, transcript].filter(Boolean).join('\n')
      transcriptUpdatedAtRef.current = new Date().toISOString()
      indexedStrokeCountRef.current = handwritingStrokes(strokesRef.current).length
      transcriptNeedsFullRebuildRef.current = false
      mathSolverHistoryRef.current = [...mathSolverHistoryRef.current, {
        action,
        input: result.normalizedInput,
        output: result.steps.map((step) => step.expression),
        placement,
        fontSize,
        lineSpacing,
        createdAt: new Date().toISOString(),
      }].slice(-24)
      saveSharedMathSolverHistory(mathSolverHistoryRef.current)
      setTokens([])
      setCorrection('')
      setAutomaticResult(null)
      bumpInkRevision({ updateTranscript: false })
      setDirty(true)
      updateHistoryState()
      scheduleRedraw()
      closeMathSolverSelection()
      setNotice({
        kind: 'success',
        text: `${mathSolverActionLabel[action]} lokal berechnet und in deiner persönlichen Handschrift ${placement === 'same-line' ? 'rechts fortgesetzt' : 'darunter weitergeführt'}.`,
      })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Der Ausdruck konnte nicht verarbeitet werden.' })
    } finally {
      if (mountedRef.current) setIsMathSolving(false)
    }
  }, [bumpInkRevision, closeMathSolverSelection, mathSolverInput, mathSolverInspection.inspection, mathSolverPlacement, mathSolverSelection, mathSolverVariable, penColor, penWidth, scheduleRedraw, setDirty, settings.pressureEnabled, sourceHeight, updateHistoryState])

  const toggleMathSolver = useCallback(() => {
    if (!settings.experimentalHandwritingToText) {
      setNotice({ kind: 'info', text: 'Handschrift zu Text ist experimentell und in den Einstellungen ausgeschaltet.' })
      return
    }
    if (mathSolverEnabled) commitPendingSolverTap()
    const enabled = !mathSolverEnabled
    setMathSolverEnabled(enabled)
    if (enabled) {
      setMathCorrectorEnabled(false)
      closeMathCorrectionSession()
      if (selectionPurpose === 'math-correction') clearRecognitionScope()
    } else {
      closeMathSolverSelection()
    }
    setNotice({
      kind: 'info',
      text: enabled
        ? 'Mathematik-Löser aktiv: Doppeltippe auf einen handschriftlichen Term oder eine Gleichung.'
        : 'Mathematik-Löser ausgeschaltet.',
    })
    bumpRevision()
    setDirty(true)
  }, [bumpRevision, clearRecognitionScope, closeMathCorrectionSession, closeMathSolverSelection, commitPendingSolverTap, mathSolverEnabled, selectionPurpose, setDirty, settings.experimentalHandwritingToText])

  const beginMathCorrectionSelection = useCallback(() => {
    commitPendingSolverTap()
    closeMathSolverSelection()
    closeMathCorrectionSession()
    if (mathSolverEnabled) {
      setMathSolverEnabled(false)
      bumpRevision()
      setDirty(true)
    }
    recognitionRunRef.current += 1
    recognitionStrokesRef.current = null
    setMathCorrectorEnabled(true)
    setSelectionPurpose('math-correction')
    setSelectionMode(true)
    setSelectionRect(null)
    setRecognitionScope('selection')
    setConversionOpen(false)
    setTokens([])
    setCorrection('')
    setAutomaticResult(null)
    setNotice({ kind: 'info', text: 'Ziehe einen Rahmen um mindestens zwei untereinander geschriebene Rechenschritte. FaNotes markiert den ersten sicheren Fehler.' })
    requestAnimationFrame(() => boardRef.current?.focus({ preventScroll: true }))
  }, [bumpRevision, closeMathCorrectionSession, closeMathSolverSelection, commitPendingSolverTap, mathSolverEnabled, setDirty])

  const toggleMathCorrector = useCallback(() => {
    if (!settings.experimentalHandwritingToText) {
      setNotice({ kind: 'info', text: 'Handschrift zu Text ist experimentell und in den Einstellungen ausgeschaltet.' })
      return
    }
    if (!mathCorrectorEnabled) {
      beginMathCorrectionSelection()
      return
    }
    setMathCorrectorEnabled(false)
    closeMathCorrectionSession()
    if (selectionPurpose === 'math-correction') clearRecognitionScope()
    setNotice({ kind: 'info', text: 'Mathematik-Korrigierer ausgeschaltet.' })
  }, [beginMathCorrectionSelection, clearRecognitionScope, closeMathCorrectionSession, mathCorrectorEnabled, selectionPurpose, settings.experimentalHandwritingToText])

  useEffect(() => {
    if (settings.experimentalHandwritingToText) return
    setConversionOpen(false)
    setMathSolverEnabled(false)
    setMathCorrectorEnabled(false)
    setSelectionMode((current) => current && selectionPurpose === 'edit' ? current : false)
    closeMathSolverSelection()
    closeMathCorrectionSession()
  }, [closeMathCorrectionSession, closeMathSolverSelection, selectionPurpose, settings.experimentalHandwritingToText])

  const updateMathCorrectionLine = useCallback((lineId: string, input: string) => {
    setMathCorrectionSession((current) => current ? {
      ...current,
      status: 'editing',
      result: undefined,
      lines: current.lines.map((line) => line.id === lineId ? { ...line, input, confirmed: true } : line),
    } : current)
  }, [])

  const recheckMathCorrection = useCallback(() => {
    if (!mathCorrectionSession?.lines.length) return
    const confirmedLines = mathCorrectionSession.lines.map((line) => ({ ...line, confirmed: true }))
    void verifyMathCorrectionLines(confirmedLines, mathCorrectionSession.rect)
  }, [mathCorrectionSession, verifyMathCorrectionLines])

  const changePaper = (next: PaperStyle) => {
    setPaperStyle(next)
    onPagePaperChange?.(next)
    if (!onPagePaperChange) onSettingsChange?.({ paperStyle: next })
    bumpRevision()
    setDirty(true)
  }

  const activateWriting = () => {
    setInkMode('writing')
    setTool('pen')
    setArtSymbolId(null)
    setArtPanelOpen(false)
    setNotice(null)
  }

  const activateDrawing = () => {
    setInkMode('drawing')
    setTool('pen')
    setArtSymbolId(null)
    setArtPanelOpen(true)
    setMathSolverEnabled(false)
    setMathCorrectorEnabled(false)
    clearRecognitionScope()
    closeMathSolverSelection()
    closeMathCorrectionSession()
    setConversionOpen(false)
    setNotice(null)
  }

  const activateEraser = () => {
    setTool('eraser')
    setArtPanelOpen(false)
    setNotice(null)
  }

  const chooseArtBrush = (brush: typeof ART_BRUSHES[number]) => {
    setArtSymbolId(null)
    setArtBrush(brush.id)
    setArtWidth(brush.defaultWidth)
  }

  const chooseArtSymbol = (symbol: ArtSymbolDefinition) => {
    setArtSymbolId(symbol.id)
    setTool('pen')
    setNotice({ kind: 'info', text: `${symbol.label} ausgewählt · tippe auf die gewünschte Stelle der Seite.` })
    requestAnimationFrame(() => boardRef.current?.focus({ preventScroll: true }))
  }

  const chooseSpecialInk = (effect: Exclude<InkEffect, 'solid'>) => {
    const special = SPECIAL_INKS.find(({ id }) => id === effect)
    setArtEffect(effect)
    if (special) setArtColor(special.stops[Math.floor(special.stops.length / 2)][1])
  }

  const handleKeyboard = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && mathCorrectionSession) {
      event.preventDefault()
      closeMathCorrectionSession()
      setMathCorrectorEnabled(false)
      return
    }
    if (event.key === 'Escape' && mathSolverSelection) {
      event.preventDefault()
      closeMathSolverSelection()
      return
    }
    if (event.key === 'Escape' && selectionMode) {
      event.preventDefault()
      if (selectionPurpose === 'math-correction') setMathCorrectorEnabled(false)
      clearRecognitionScope()
      setNotice({ kind: 'info', text: 'Bereichsauswahl abgebrochen.' })
      return
    }
    if (event.key === 'Escape') {
      if (activePointerRef.current !== null || activeStrokeRef.current || lastCapturedPointerIdRef.current !== null) {
        event.preventDefault()
        forceEndActivePointer('escape')
        return
      }
      if (viewZoom !== 1 || viewRotation !== 0 || viewPan.x !== 0 || viewPan.y !== 0) {
        event.preventDefault()
        resetView()
        return
      }
    }
    if (!(event.ctrlKey || event.metaKey)) {
      if (event.key === '[') {
        event.preventDefault()
        forceEndActivePointer('view-gesture')
        rotateBy(-VIEW_ROTATE_STEP)
      } else if (event.key === ']') {
        event.preventDefault()
        forceEndActivePointer('view-gesture')
        rotateBy(VIEW_ROTATE_STEP)
      }
      return
    }
    if (event.key === '=' || event.key === '+') {
      event.preventDefault()
      forceEndActivePointer('view-gesture')
      zoomBy(zoomStepFromSpeed(readSharedZoomSpeed()))
      return
    }
    if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      forceEndActivePointer('view-gesture')
      zoomBy(-zoomStepFromSpeed(readSharedZoomSpeed()))
      return
    }
    if (event.key === '0') {
      event.preventDefault()
      forceEndActivePointer('view-gesture')
      resetView()
      return
    }
    if (event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.shiftKey ? redo() : undo()
    } else if (event.key.toLowerCase() === 'y') {
      event.preventDefault()
      redo()
    } else if (event.key.toLowerCase() === 's') {
      event.preventDefault()
      void saveDrawing(false)
    }
  }

  const requestTraining = () => {
    if (onOpenGlyphenWerk) onOpenGlyphenWerk()
    else fileInputRef.current?.click()
  }

  const openTextToHandwriting = () => {
    setTextToHandwritingOpen(true)
    if (resourcesRef.current) return
    void loadRecognitionResources()
      .then((loaded) => {
        resourcesRef.current = loaded
        if (mountedRef.current) setResources(loaded)
      })
      .catch(() => {
        if (mountedRef.current) {
          setNotice({ kind: 'error', text: 'Das persönliche Handschriftmodell konnte nicht geladen werden.' })
        }
      })
  }

  return (
    <section
      ref={boardRef as React.RefObject<HTMLElement>}
      className={`lw-drawing-board ${inline ? 'is-inline' : ''} ${inputActive ? INLINE_INK_ACTIVE_CLASS : ''} ${inkMode === 'drawing' ? 'is-art-mode' : 'is-writing-mode'} ${className}`}
      tabIndex={inputActive ? 0 : -1}
      onKeyDown={handleKeyboard}
      onWheel={handleWheel}
    >
      <style>{drawingBoardStyles}</style>
      <header className="lw-draw-header">
        <div className="lw-draw-title">
          <span className="lw-draw-title-icon">{inkMode === 'drawing' ? <Paintbrush size={18} /> : <PenLine size={18} />}</span>
          <span>
            <strong>{title}</strong>
            <small>{isSaving ? 'Speichert Seite und Suchindex …' : isDirty ? 'Wird automatisch gespeichert' : inkMode === 'drawing' ? artCount ? 'Zeichnung gespeichert · getrennt von Handschrift' : 'Zeichenmodus bereit' : inkCount ? 'Gespeichert · unsichtbar durchsuchbar' : 'Neue Handschrift-Seite'}</small>
          </span>
        </div>
        <div className="lw-draw-header-actions">
          <button type="button" className="lw-draw-subtle" onClick={() => void saveDrawing(false)} disabled={!inkCount || isSaving}>
            {isSaving ? <LoaderCircle className="lw-spin" size={15} /> : <Save size={15} />}
              Seite speichern
          </button>
          {onClose && <button type="button" className="lw-draw-icon" aria-label="Zeichenbereich schließen" onClick={onClose}><X size={18} /></button>}
        </div>
      </header>

      {(() => {
        const toolbar = (
      <div
        className={`lw-draw-toolbar ${inline ? 'is-docked-chrome' : ''} ${inline && inputActive ? 'is-visible' : ''}`}
        aria-label="Zeichenwerkzeuge"
        data-fanotes-drawing-chrome={inline ? 'toolbar' : undefined}
      >
        <div className="lw-draw-toolgroup lw-segmented">
          <button type="button" className={tool === 'pen' && inkMode === 'writing' ? 'is-active' : ''} aria-pressed={tool === 'pen' && inkMode === 'writing'} title="Handschrift schreiben oder vorhandene Wörter mehrfach durchkritzeln" onClick={activateWriting}>
            <PenLine size={16} /> <span className="lw-tool-label">Schreiben</span>
          </button>
          <button type="button" className={tool === 'pen' && inkMode === 'drawing' ? 'is-active' : ''} aria-pressed={tool === 'pen' && inkMode === 'drawing'} title="Zeichenstudio mit Pinseln und Spezialfarben öffnen" onClick={activateDrawing}>
            <Paintbrush size={16} /> <span className="lw-tool-label">Zeichnen</span>
          </button>
          <button type="button" className={tool === 'eraser' ? 'is-active' : ''} aria-pressed={tool === 'eraser'} onClick={activateEraser}>
            <Eraser size={16} /> <span className="lw-tool-label">Radierer</span>
          </button>
          <button
            type="button"
            className={rulerPose ? 'is-active' : ''}
            aria-pressed={Boolean(rulerPose)}
            title="Lineal einblenden: verschieben, drehen, Zentimeter ablesen und an der Kante nachzeichnen"
            onClick={() => setRulerPose((current) => current ? null : defaultRulerPose())}
          >
            <Ruler size={16} /> <span className="lw-tool-label">Lineal</span>
          </button>
          <button
            type="button"
            className={setSquarePose ? 'is-active' : ''}
            aria-pressed={Boolean(setSquarePose)}
            title="Geodreieck einblenden: Winkel messen, verschieben und an den Kanten nachzeichnen"
            onClick={() => setSetSquarePose((current) => current ? null : defaultSetSquarePose())}
          >
            <Triangle size={16} /> <span className="lw-tool-label">Geodreieck</span>
          </button>
          <button
            type="button"
            className={compassPose ? 'is-active' : ''}
            aria-pressed={Boolean(compassPose)}
            title="Zirkel: Nadel setzen, gelb Radius messen/übertragen, grün Bogen zeichnen, Kreis-Taste für einen ganzen Kreis"
            onClick={() => setCompassPose((current) => {
              if (current) return null
              setNotice({
                kind: 'info',
                text: 'Nadel ziehen zum Setzen, gelber Punkt für den Radius, grüner Punkt drehen zum Zeichnen. Schloss sperrt das Maß, Kreis-Taste zeichnet sofort.',
              })
              return defaultCompassPose()
            })}
          >
            <Compass size={16} /> <span className="lw-tool-label">Zirkel</span>
          </button>
          <button
            type="button"
            className={settings.penOnly ? 'is-active' : ''}
            aria-pressed={settings.penOnly}
            title={settings.penOnly
              ? 'Nur Stift: Finger und Hand werden ignoriert. Klicken zum Ausschalten.'
              : 'Nur Stift: nur der Grafikstift schreibt, nicht Finger oder Hand (empfohlen unter Windows).'}
            onClick={() => onSettingsChange?.({ penOnly: !settings.penOnly })}
          >
            <PenLine size={16} /> <span className="lw-tool-label">{settings.penOnly ? 'Nur Stift' : 'Stift+Hand'}</span>
          </button>
        </div>

        {inkMode === 'writing' && tool === 'pen' && <div className="lw-draw-toolgroup lw-segmented lw-writing-actions">
          <button
            type="button"
            className={textToHandwritingOpen ? 'is-active' : ''}
            aria-pressed={textToHandwritingOpen}
            title="Getippten Text mit deinen trainierten Buchstaben als Handschrift einfügen"
            onClick={openTextToHandwriting}
          >
            <Type size={16} /> <span className="lw-tool-label">Text → Handschrift</span>
          </button>
          {settings.experimentalHandwritingToText && <button
            type="button"
            className={mathSolverEnabled ? 'is-active' : ''}
            aria-pressed={mathSolverEnabled}
            title="Mathematik-Löser ein- oder ausschalten; danach einen Ausdruck doppeltippen"
            onClick={toggleMathSolver}
          >
            <Calculator size={16} /> <span className="lw-tool-label">Mathe-Löser</span>
          </button>}
          {settings.experimentalHandwritingToText && <button
            type="button"
            className={mathCorrectorEnabled ? 'is-active' : ''}
            aria-pressed={mathCorrectorEnabled}
            title="Rechenweg auswählen und den ersten falschen Schritt markieren"
            onClick={toggleMathCorrector}
          >
            <ListChecks size={16} /> <span className="lw-tool-label">Mathe-Korrigierer</span>
          </button>}
        </div>}

        {tool === 'pen' && inkMode === 'writing' ? <>
          <div className="lw-draw-toolgroup lw-colors" aria-label="Stiftfarbe">
            {colorChoices.map((color) => (
              <button
                key={color}
                type="button"
                className={penColor.toLowerCase() === color ? 'is-active' : ''}
                aria-label={`Farbe ${color}`}
                aria-pressed={penColor.toLowerCase() === color}
                style={{ '--ink-color': color } as React.CSSProperties}
                onClick={() => { setPenColor(color); onSettingsChange?.({ penColor: color }) }}
              />
            ))}
            <label className="lw-color-custom" title="Eigene Farbe">
              <input type="color" value={penColor} onChange={(event) => { setPenColor(event.target.value); onSettingsChange?.({ penColor: event.target.value }) }} />
              <span style={{ background: penColor }} />
            </label>
          </div>
          <label className="lw-draw-range">
            <span>Breite</span>
            <input
              type="range"
              min="1"
              max="18"
              step="0.5"
              value={penWidth}
              onChange={(event) => {
                const value = Number(event.target.value)
                setPenWidth(value)
                onSettingsChange?.({ penWidth: value })
              }}
            />
            <output>{penWidth.toFixed(penWidth % 1 ? 1 : 0)} px</output>
          </label>
        </> : tool === 'pen' ? <>
          <button type="button" className="lw-art-studio-trigger" aria-expanded={artPanelOpen} onClick={() => setArtPanelOpen((open) => !open)}>
            {activeArtSymbol ? <Shapes size={16} /> : <Palette size={16} />}
            <span><strong>{activeArtSymbol?.label ?? activeArtBrush.label}</strong><small>{activeArtSymbol ? 'Auf Seite platzieren' : artEffect === 'solid' ? 'Vollfarbe' : SPECIAL_INKS.find(({ id }) => id === artEffect)?.label}</small></span>
            <i className={activeArtSymbol ? 'is-symbol' : ''} style={{ '--art-ink': artEffect === 'solid' ? artColor : SPECIAL_INKS.find(({ id }) => id === artEffect)?.css, color: artColor } as React.CSSProperties}>{activeArtSymbol && <ArtSymbolPreview symbol={activeArtSymbol} size={18} />}</i>
          </button>
          <label className="lw-draw-range lw-art-quick-width">
            <span>{activeArtSymbol ? 'Größe' : 'Breite'}</span>
            <input type="range" min={activeArtSymbol ? 20 : .75} max={activeArtSymbol ? 180 : 42} step={activeArtSymbol ? 2 : .25} value={activeArtSymbol ? artSymbolSize : artWidth} onChange={(event) => activeArtSymbol ? setArtSymbolSize(Number(event.target.value)) : setArtWidth(Number(event.target.value))} />
            <output>{activeArtSymbol ? artSymbolSize : artWidth.toFixed(artWidth % 1 ? 1 : 0)} px</output>
          </label>
        </> : <label className="lw-draw-range">
          <span>Größe</span>
          <input type="range" min="10" max="72" value={eraserSize} onChange={(event) => setEraserSize(Number(event.target.value))} />
          <output>{eraserSize} px</output>
        </label>}

        <label className="lw-paper-select">
          <span className="sr-only">Papierart</span>
          <select value={paperStyle} onChange={(event) => changePaper(event.target.value as PaperStyle)}>
            {Object.entries(paperLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <ChevronDown size={14} />
        </label>

        <div className="lw-draw-toolgroup lw-view-controls" aria-label="Blattansicht">
          <button type="button" className="lw-draw-icon" aria-label="Herauszoomen" title="Herauszoomen (Strg+- · Strg+Mausrad)" onClick={() => zoomBy(-zoomStepFromSpeed(readSharedZoomSpeed()))} disabled={viewZoom <= VIEW_ZOOM_MIN}><ZoomOut size={17} /></button>
          <button type="button" className="lw-draw-icon" aria-label="Hineinzoomen" title="Hineinzoomen (Strg++ · Strg+Mausrad)" onClick={() => zoomBy(zoomStepFromSpeed(readSharedZoomSpeed()))} disabled={viewZoom >= readSharedZoomMax()}><ZoomIn size={17} /></button>
          <button type="button" className="lw-draw-icon" aria-label="Blatt gegen den Uhrzeigersinn drehen" title="Blatt drehen ( [  · Alt+Mausrad )" onClick={() => rotateBy(-90)}><RotateCcw size={17} /></button>
          <button type="button" className="lw-draw-icon" aria-label="Blatt im Uhrzeigersinn drehen" title="Blatt drehen ( ]  · Alt+Mausrad )" onClick={() => rotateBy(90)}><RotateCw size={17} /></button>
          <button type="button" className="lw-draw-subtle lw-view-reset" aria-label="Ansicht zurücksetzen" title="Zoom und Drehung zurücksetzen (Strg+0 · Esc)" onClick={resetView} disabled={viewZoom === 1 && viewRotation === 0 && viewPan.x === 0 && viewPan.y === 0}>
            {Math.round(viewZoom * 100)}%{viewRotation ? ` · ${viewRotation}°` : ''}
          </button>
        </div>

        <div className="lw-draw-toolgroup lw-history">
          <button type="button" className="lw-draw-icon" aria-label="Rückgängig" title="Rückgängig (Strg+Z)" onClick={undo} disabled={!canUndo}><Undo2 size={17} /></button>
          <button type="button" className="lw-draw-icon" aria-label="Wiederholen" title="Wiederholen (Strg+Umschalt+Z)" onClick={redo} disabled={!canRedo}><Redo2 size={17} /></button>
          <button type="button" className="lw-draw-icon lw-danger" aria-label="Alles löschen" title="Alles löschen" onClick={clear} disabled={!inkCount}><Trash2 size={17} /></button>
        </div>

        {inline && <div className="lw-draw-toolgroup lw-ink-actions">
          {inkMode === 'writing' && knownTrainingSampleCount === 0 && (
            <button type="button" className="lw-draw-subtle" onClick={requestTraining} disabled={isImporting || isResettingTraining} title="GlyphenWerk öffnen">
              {isImporting ? <LoaderCircle className="lw-spin" size={14} /> : <Sparkles size={14} />}
              <span className="lw-tool-label">GlyphenWerk</span>
            </button>
          )}
          {inkMode === 'writing' && <button type="button" className={`lw-draw-subtle ${selectionMode && selectionPurpose === 'edit' ? 'is-active' : ''}`} onClick={beginInkEdit} disabled={!handwritingCount} title="Tinte auswählen, verschieben, kopieren oder skalieren">
            <Shapes size={14} /> <span className="lw-tool-label">Tinte</span>
          </button>}
          {selectionPurpose === 'edit' && selectionRect && !selectionMode && <>
            <button type="button" className="lw-draw-subtle" onClick={copySelectedInk} title="Auswahl duplizieren"><Copy size={14} /> <span className="lw-tool-label">Kopieren</span></button>
            <button type="button" className="lw-draw-subtle lw-danger" onClick={deleteSelectedInk} title="Auswahl löschen"><Trash2 size={14} /> <span className="lw-tool-label">Löschen</span></button>
          </>}
          {settings.experimentalHandwritingToText && inkMode === 'writing' && <button type="button" className={`lw-draw-subtle ${selectionMode && selectionPurpose === 'conversion' ? 'is-active' : ''}`} onClick={beginSelectionRecognition} disabled={!handwritingCount || isRecognizing} title="Einen frei gewählten Bereich von Handschrift in Text oder Mathematik konvertieren">
            <ScanSearch size={15} /> <span className="lw-tool-label">Bereich</span>
          </button>}
          {settings.experimentalHandwritingToText && inkMode === 'writing' && <button type="button" className="lw-convert-action" onClick={recognizePage} disabled={!handwritingCount || isRecognizing} title="Die gesamte Handschrift-Seite konvertieren">
            {isRecognizing ? <LoaderCircle className="lw-spin" size={15} /> : <Sparkles size={15} />}
            <span className="lw-tool-label">Konvertieren</span>
          </button>}
        </div>}
      </div>
        )
        if (inline) return inkToolbarHost && inputActive ? createPortal(toolbar, inkToolbarHost) : null
        return toolbar
      })()}

      {inkMode === 'drawing' && tool === 'pen' && artPanelOpen && (!inline || inputActive) && (inline ? (node: ReactNode) => createPortal(node, document.body) : (node: ReactNode) => node)(
      <aside className={`lw-art-studio ${inline ? 'is-viewport-chrome' : ''}`} aria-label="Zeichenstudio">
        <header>
          <span><Palette size={17} /></span>
          <div><strong>Zeichenstudio</strong><small>{artStudioTab === 'brushes' ? 'Strichart und Druckverhalten wählen' : artStudioTab === 'colors' ? 'Vollfarben und Spezialtinten kombinieren' : 'Icons direkt auf der Seite platzieren'}</small></div>
          <button type="button" className="lw-draw-icon" aria-label="Zeichenstudio einklappen" onClick={() => setArtPanelOpen(false)}><X size={16} /></button>
        </header>

        <nav className="lw-art-studio-tabs" role="tablist" aria-label="Bereiche des Zeichenstudios">
          <button type="button" role="tab" id="lw-art-tab-brushes" aria-controls="lw-art-brushes-panel" aria-selected={artStudioTab === 'brushes'} className={artStudioTab === 'brushes' ? 'is-active' : ''} onClick={() => setArtStudioTab('brushes')}><Paintbrush size={15} /><span><strong>Pinsel</strong><small>8 Werkzeuge</small></span></button>
          <button type="button" role="tab" id="lw-art-tab-colors" aria-controls="lw-art-colors-panel" aria-selected={artStudioTab === 'colors'} className={artStudioTab === 'colors' ? 'is-active' : ''} onClick={() => setArtStudioTab('colors')}><Palette size={15} /><span><strong>Farben</strong><small>Voll- &amp; Spezialtinte</small></span></button>
          <button type="button" role="tab" id="lw-art-tab-symbols" aria-controls="lw-art-symbols-panel" aria-selected={artStudioTab === 'symbols'} className={artStudioTab === 'symbols' ? 'is-active' : ''} onClick={() => setArtStudioTab('symbols')}><Shapes size={15} /><span><strong>Piktogramme</strong><small>25 Motive</small></span></button>
        </nav>

        <div className="lw-art-studio-body">
          {artStudioTab === 'brushes' && <section id="lw-art-brushes-panel" className="lw-art-brush-section" role="tabpanel" aria-labelledby="lw-art-tab-brushes">
            <div className="lw-art-section-head"><strong id="lw-art-brush-title">Pinsel</strong><span>{activeArtBrush.description}</span></div>
            <div className="lw-art-brushes">
              {ART_BRUSHES.map((brush) => <button
                type="button"
                key={brush.id}
                className={artBrush === brush.id ? 'is-active' : ''}
                aria-pressed={artBrush === brush.id}
                title={`${brush.label}: ${brush.description}`}
                onClick={() => chooseArtBrush(brush)}
              >
                <span className={`lw-art-brush-preview is-${brush.id}`}><i /></span>
                <small>{brush.label}</small>
              </button>)}
            </div>
          </section>}

          {artStudioTab === 'colors' && <section id="lw-art-colors-panel" className="lw-art-color-section" role="tabpanel" aria-labelledby="lw-art-tab-colors">
            <div className="lw-art-section-head"><strong id="lw-art-color-title">Farben</strong><span>{artEffect === 'solid' ? 'Vollfarbe' : 'Spezialtinte'}</span></div>
            <div className="lw-art-solid-colors" aria-label="Vollfarben">
              {artColorChoices.map((color) => <button
                type="button"
                key={color}
                className={artEffect === 'solid' && artColor === color ? 'is-active' : ''}
                aria-label={`Zeichenfarbe ${color}`}
                aria-pressed={artEffect === 'solid' && artColor === color}
                style={{ '--art-ink': color } as React.CSSProperties}
                onClick={() => { setArtColor(color); setArtEffect('solid') }}
              />)}
              <label className="lw-art-custom-color" title="Eigene Zeichenfarbe">
                <input type="color" value={artColor} onChange={(event) => { setArtColor(event.target.value); setArtEffect('solid') }} />
                <span style={{ background: artColor }} />
              </label>
            </div>
            <div className="lw-art-special-inks" aria-label="Spezialfarben">
              {SPECIAL_INKS.map((ink) => <button
                type="button"
                key={ink.id}
                className={artEffect === ink.id ? 'is-active' : ''}
                aria-pressed={artEffect === ink.id}
                aria-label={`${ink.label} Spezialtinte`}
                title={`${ink.label} Spezialtinte`}
                onClick={() => chooseSpecialInk(ink.id)}
              >
                <i style={{ '--art-ink': ink.css } as React.CSSProperties} />
                <span>{ink.label}</span>
              </button>)}
            </div>
          </section>}

          <section className="lw-art-control-section" aria-label="Pinseleinstellungen">
            {activeArtSymbol ? <>
              <label><span><strong>Größe</strong><small>20–180 px</small></span><input aria-label="Piktogrammgröße" type="range" min="20" max="180" step="2" value={artSymbolSize} onChange={(event) => setArtSymbolSize(Number(event.target.value))} /><output>{artSymbolSize}</output></label>
              <label><span><strong>Drehung</strong><small>frei ausrichten</small></span><input aria-label="Piktogrammdrehung" type="range" min="-180" max="180" step="5" value={artSymbolRotation} onChange={(event) => setArtSymbolRotation(Number(event.target.value))} /><output>{artSymbolRotation}°</output></label>
            </> : <label><span><strong>Breite</strong><small>0,75–42 px</small></span><input type="range" min="0.75" max="42" step="0.25" value={artWidth} onChange={(event) => setArtWidth(Number(event.target.value))} /><output>{artWidth.toFixed(artWidth % 1 ? 1 : 0)}</output></label>}
            <label><span><strong>Deckkraft</strong><small>für sanfte Überlagerungen</small></span><input type="range" min="12" max="100" step="1" value={Math.round(artOpacity * 100)} onChange={(event) => setArtOpacity(Number(event.target.value) / 100)} /><output>{Math.round(artOpacity * 100)}%</output></label>
            <div className="lw-art-current-stroke"><span className={activeArtSymbol ? 'is-symbol' : ''} style={{ '--art-ink': artEffect === 'solid' ? artColor : SPECIAL_INKS.find(({ id }) => id === artEffect)?.css, '--art-opacity': artOpacity, '--art-width': `${Math.min(20, Math.max(2, artWidth))}px`, color: artColor } as React.CSSProperties}>{activeArtSymbol && <ArtSymbolPreview symbol={activeArtSymbol} size={29} />}</span><small>{activeArtSymbol ? activeArtSymbol.label : 'Aktueller Strich'}</small></div>
          </section>

          {artStudioTab === 'symbols' && <section id="lw-art-symbols-panel" className="lw-art-symbol-section" role="tabpanel" aria-labelledby="lw-art-tab-symbols">
            <div className="lw-art-symbol-heading">
              <div className="lw-art-section-head"><strong id="lw-art-symbol-title">Icons &amp; Piktogramme</strong><span>Symbol wählen · auf die Seite tippen</span></div>
              <div className="lw-art-symbol-categories" aria-label="Piktogramm-Kategorien">
                {ART_SYMBOL_CATEGORIES.map((category) => <button type="button" key={category.id} className={artSymbolCategory === category.id ? 'is-active' : ''} aria-pressed={artSymbolCategory === category.id} onClick={() => setArtSymbolCategory(category.id)}>{category.label}</button>)}
              </div>
            </div>
            <div className="lw-art-symbols" aria-label="Icon- und Piktogrammbibliothek">
              {visibleArtSymbols.map((symbol) => <button
                type="button"
                key={symbol.id}
                className={artSymbolId === symbol.id ? 'is-active' : ''}
                aria-label={`${symbol.label} einfügen`}
                aria-pressed={artSymbolId === symbol.id}
                title={`${symbol.label} einfügen`}
                onClick={() => chooseArtSymbol(symbol)}
              ><ArtSymbolPreview symbol={symbol} size={22} /><small>{symbol.label}</small></button>)}
            </div>
          </section>}
        </div>
      </aside>)}

      <div className={`lw-draw-workspace ${conversionOpen ? 'has-conversion' : ''}`}>
        <div className="lw-canvas-shell">
          <div className="lw-canvas-glow" />
          <div
            ref={surfaceRef}
            className="lw-canvas-surface"
            onPointerDown={inline ? handlePointerDown : undefined}
            onPointerMove={inline ? handlePointerMove : undefined}
            onPointerUp={inline ? finishPointer : undefined}
            onPointerCancel={inline ? finishPointer : undefined}
            onLostPointerCapture={inline ? finishPointer : undefined}
            onContextMenu={inline ? (event) => event.preventDefault() : undefined}
          >
            <canvas ref={committedCanvasRef} className="lw-tablet-canvas lw-tablet-canvas-committed" aria-hidden="true" />
            <canvas
              ref={canvasRef}
              className={`lw-tablet-canvas lw-tablet-canvas-live ${selectionMode ? 'tool-select' : tool === 'pen' && inkMode === 'drawing' ? activeArtSymbol ? 'tool-stamp' : 'tool-art' : `tool-${tool}`} ${inputActive ? INLINE_INK_ACTIVE_CLASS : ''}`}
              tabIndex={-1}
              aria-label={selectionMode
                ? selectionPurpose === 'math-correction' ? 'Rechenweg zur mathematischen Korrektur auswählen' : 'Bereich für Handschrifterkennung auswählen'
                : inkMode === 'drawing' ? activeArtSymbol ? `Piktogramm ${activeArtSymbol.label} auf Seite platzieren` : `Zeichenfläche mit ${activeArtBrush.label}` : 'Druckempfindliche Handschriftfläche'}
              onPointerDown={inline ? undefined : handlePointerDown}
              onPointerMove={inline ? undefined : handlePointerMove}
              onPointerUp={inline ? undefined : finishPointer}
              onPointerCancel={inline ? undefined : finishPointer}
              onLostPointerCapture={inline ? undefined : finishPointer}
              onContextMenu={(event) => event.preventDefault()}
            />
            {(rulerPose || setSquarePose || compassPose) && (
              <DraftingGuides
                sourceWidth={sourceWidth}
                sourceHeight={sourceHeight}
                ruler={rulerPose}
                setSquare={setSquarePose}
                compass={compassPose}
                readout={draftingReadout}
                onMove={(kind, pose) => {
                  if (kind === 'ruler') setRulerPose(pose)
                  else if (kind === 'setSquare') setSetSquarePose(pose)
                  else setCompassPose(asCompassPose(pose))
                }}
                onCompassDraw={handleCompassDraw}
              />
            )}
            {selectionMode && !selectionRect && <div className={`lw-selection-hint ${selectionPurpose === 'math-correction' ? 'is-correction' : ''}`}>
              {selectionPurpose === 'math-correction' ? <ListChecks size={18} /> : <ScanSearch size={18} />}
              {selectionPurpose === 'math-correction' ? 'Rechenweg mit mehreren Zeilen auswählen' : 'Bereich auf der Seite aufziehen'}
            </div>}
            {selectionRect && <div
              className={`lw-selection-rect ${selectionMode ? 'is-selecting' : 'is-selected'} ${selectionPurpose === 'edit' && !selectionMode ? 'is-editable' : ''}`}
              style={{
                left: `${selectionRect.x * 100}%`,
                top: `${selectionRect.y * 100}%`,
                width: `${selectionRect.width * 100}%`,
                height: `${selectionRect.height * 100}%`,
              }}
              onPointerDown={(event) => {
                if (selectionPurpose !== 'edit' || selectionMode) return
                event.stopPropagation()
                event.currentTarget.setPointerCapture(event.pointerId)
                const surface = surfaceRef.current?.getBoundingClientRect()
                if (!surface) return
                inkDragRef.current = {
                  kind: (event.target as HTMLElement).dataset.handle === 'scale' ? 'scale' : 'move',
                  startX: (event.clientX - surface.left) / surface.width,
                  startY: (event.clientY - surface.top) / surface.height,
                  origin: selectionRect,
                }
              }}
              onPointerMove={(event) => {
                const drag = inkDragRef.current
                const surface = surfaceRef.current?.getBoundingClientRect()
                if (!drag || !surface) return
                const x = (event.clientX - surface.left) / surface.width
                const y = (event.clientY - surface.top) / surface.height
                const dx = x - drag.startX
                const dy = y - drag.startY
                if (drag.kind === 'move') {
                  applyInkTransform((px, py) => ({ x: px + dx, y: py + dy }))
                  setSelectionRect({ ...drag.origin, x: clamp(drag.origin.x + dx), y: clamp(drag.origin.y + dy, 0, 8) })
                  inkDragRef.current = { ...drag, startX: x, startY: y, origin: { ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy } }
                  return
                }
                const originX = drag.origin.x
                const originY = drag.origin.y
                const scaleX = drag.origin.width > 0.001 ? Math.max(0.2, (drag.origin.width + dx) / drag.origin.width) : 1
                const scaleY = drag.origin.height > 0.001 ? Math.max(0.2, (drag.origin.height + dy) / drag.origin.height) : 1
                const scale = (scaleX + scaleY) / 2
                applyInkTransform((px, py) => ({
                  x: originX + (px - originX) * scale,
                  y: originY + (py - originY) * scale,
                }))
                setSelectionRect({
                  x: originX,
                  y: originY,
                  width: Math.max(0.02, drag.origin.width * scale),
                  height: Math.max(0.02, drag.origin.height * scale),
                })
                inkDragRef.current = { ...drag, startX: x, startY: y, origin: {
                  x: originX,
                  y: originY,
                  width: Math.max(0.02, drag.origin.width * scale),
                  height: Math.max(0.02, drag.origin.height * scale),
                } }
              }}
              onPointerUp={() => { inkDragRef.current = null; fitPageToInk() }}
              onPointerCancel={() => { inkDragRef.current = null; fitPageToInk() }}
            >
              <span>{selectionMode
                ? selectionPurpose === 'math-correction' ? 'Rechenweg auswählen' : selectionPurpose === 'edit' ? 'Tinte auswählen' : 'Auswählen'
                : selectionPurpose === 'edit' ? 'Ziehen · Ecke skalieren' : 'Wird konvertiert'}</span>
              {selectionPurpose === 'edit' && !selectionMode && <i data-handle="scale" className="lw-selection-scale" />}
            </div>}
            {mathCorrectionSession && <>
              <div
                className="lw-math-correction-scope"
                style={{
                  left: `${mathCorrectionSession.rect.x * 100}%`,
                  top: `${mathCorrectionSession.rect.y * 100}%`,
                  width: `${mathCorrectionSession.rect.width * 100}%`,
                  height: `${mathCorrectionSession.rect.height * 100}%`,
                }}
              />
              {mathCorrectionSession.lines.map((line, index) => {
                const status = mathCorrectionSession.result?.lines[index]?.status ?? 'unchecked'
                return <div
                  key={line.id}
                  className={`lw-math-step-mark is-${status}`}
                  style={{
                    left: `${line.rect.x * 100}%`,
                    top: `${line.rect.y * 100}%`,
                    width: `${line.rect.width * 100}%`,
                    height: `${line.rect.height * 100}%`,
                  }}
                ><span>{index + 1}</span></div>
              })}
              {mathCorrectionErrorRect && <div
                className={`lw-math-error-spot is-${mathCorrectionSession.result?.status ?? 'uncertain'}`}
                style={{
                  left: `${mathCorrectionErrorRect.x * 100}%`,
                  top: `${mathCorrectionErrorRect.y * 100}%`,
                  width: `${mathCorrectionErrorRect.width * 100}%`,
                  height: `${mathCorrectionErrorRect.height * 100}%`,
                }}
              ><span>{mathCorrectionSession.result?.status === 'incorrect' ? 'Fehler hier' : 'Bitte prüfen'}</span></div>}
              <div
                className="lw-math-correction-popover"
                role="dialog"
                aria-label="Mathematischen Rechenweg korrigieren"
                style={{
                  left: `${clamp(mathCorrectionSession.rect.x + mathCorrectionSession.rect.width + 0.012, 0.015, 0.57) * 100}%`,
                  top: `${clamp(mathCorrectionSession.rect.y, 0.02, 0.48) * 100}%`,
                }}
              >
                <div className="lw-math-correction-head">
                  <span><ListChecks size={15} /></span>
                  <div><strong>Mathematik-Korrigierer</strong><small>erster sicherer Fehler · vollständig lokal</small></div>
                  <button
                    type="button"
                    className="lw-draw-icon"
                    aria-label="Mathematik-Korrigierer schließen"
                    onClick={() => { setMathCorrectorEnabled(false); closeMathCorrectionSession() }}
                  ><X size={15} /></button>
                </div>

                {(mathCorrectionSession.status === 'recognizing' || mathCorrectionSession.status === 'checking') && <div className="lw-math-correction-loading">
                  <LoaderCircle className="lw-spin" size={20} />
                  {mathCorrectionSession.status === 'recognizing'
                    ? 'Rechenzeilen, Brüche und Indizes werden räumlich gelesen …'
                    : 'Alle Übergänge werden symbolisch bewiesen …'}
                </div>}

                {mathCorrectionSession.status === 'error' && <div className="lw-math-correction-error">
                  <CircleAlert size={18} />
                  <span>{mathCorrectionSession.error}</span>
                  {knownTrainingSampleCount === 0 && <button type="button" className="lw-draw-subtle" onClick={requestTraining}><Sparkles size={14} /> GlyphenWerk öffnen</button>}
                </div>}

                {mathCorrectionSession.lines.length > 0 && <>
                  {mathCorrectionSession.result ? <div className={`lw-math-correction-result is-${mathCorrectionSession.result.status}`}>
                    {mathCorrectionSession.result.status === 'correct' ? <Check size={16} /> : <CircleAlert size={16} />}
                    <span><strong>{mathCorrectionSession.result.status === 'correct'
                      ? 'Rechenweg konsistent'
                      : mathCorrectionSession.result.status === 'incorrect'
                        ? 'Fehler gefunden'
                        : mathCorrectionSession.result.status === 'unreadable'
                          ? 'Zeile nicht lesbar'
                          : 'Manuelle Prüfung nötig'}</strong><small>{mathCorrectionSession.result.message}</small></span>
                  </div> : mathCorrectionSession.status === 'editing' ? <div className="lw-math-correction-result is-editing">
                    <ListChecks size={16} /><span><strong>Erkennung geändert</strong><small>Prüfe die Eingaben und starte die Analyse erneut.</small></span>
                  </div> : null}

                  <div className="lw-math-step-list">
                    {mathCorrectionSession.lines.map((line, index) => {
                      const resultLine = mathCorrectionSession.result?.lines[index]
                      const status = resultLine?.status ?? 'unchecked'
                      return <label key={line.id} className={`lw-math-step-row is-${status}`}>
                        <span className="lw-math-step-number">{index + 1}</span>
                        <span className="lw-math-step-input">
                          <input
                            value={line.input}
                            spellCheck={false}
                            aria-label={`Erkannter mathematischer Schritt ${index + 1}`}
                            disabled={mathCorrectionSession.status === 'checking'}
                            onChange={(event) => updateMathCorrectionLine(line.id, event.target.value)}
                          />
                          <small>{resultLine?.message || `${line.confidence}% Erkennungssicherheit`}</small>
                        </span>
                        <strong className="lw-math-step-status">{status === 'start'
                          ? 'Start'
                          : status === 'correct'
                            ? 'Richtig'
                            : status === 'incorrect'
                              ? 'Falsch'
                              : status === 'uncertain'
                                ? 'Prüfen'
                                : status === 'unreadable'
                                  ? 'Unklar'
                                  : '–'}</strong>
                      </label>
                    })}
                  </div>

                  {mathCorrectionSession.result?.suggestion && <div className="lw-math-correction-suggestion">
                    <Sparkles size={14} /><span><strong>Mögliche korrekte Zielzeile</strong><code>{mathCorrectionSession.result.suggestion}</code></span>
                  </div>}

                  <div className="lw-math-correction-actions">
                    <button
                      type="button"
                      className="lw-primary-action"
                      disabled={mathCorrectionSession.status === 'checking' || mathCorrectionSession.lines.some((line) => !line.input.trim())}
                      onClick={recheckMathCorrection}
                    >
                      {mathCorrectionSession.status === 'checking' ? <LoaderCircle className="lw-spin" size={14} /> : <ListChecks size={14} />}
                      Eingaben bestätigen &amp; neu prüfen
                    </button>
                    <button type="button" className="lw-draw-subtle" onClick={beginMathCorrectionSelection}><ScanSearch size={14} /> Anderen Bereich wählen</button>
                  </div>
                  <small className="lw-math-correction-footnote">Rot wird nur markiert, wenn die Algebra einen echten Widerspruch beweist. Unsichere Handschrift und nicht beweisbare Mehrvariablen-Schritte bleiben gelb.</small>
                </>}
              </div>
            </>}
            {mathSolverSelection && <>
              <div
                className="lw-math-selection"
                style={{
                  left: `${mathSolverSelection.rect.x * 100}%`,
                  top: `${mathSolverSelection.rect.y * 100}%`,
                  width: `${mathSolverSelection.rect.width * 100}%`,
                  height: `${mathSolverSelection.rect.height * 100}%`,
                }}
              ><span><Calculator size={11} /> Mathe-Löser</span></div>
              <div
                className="lw-math-solver-popover"
                role="dialog"
                aria-label="Mathematischen Ausdruck bearbeiten"
                style={{
                  left: `${clamp(mathSolverSelection.rect.x, 0.015, 0.61) * 100}%`,
                  top: `${(mathSolverSelection.rect.y + mathSolverSelection.rect.height > 0.68
                    ? Math.max(0.025, mathSolverSelection.rect.y - 0.39)
                    : mathSolverSelection.rect.y + mathSolverSelection.rect.height + 0.012) * 100}%`,
                }}
              >
                <div className="lw-math-solver-head">
                  <span><Calculator size={15} /></span>
                  <div><strong>Lokaler Mathematik-Löser</strong><small>offline · Ergebnis als deine Handschrift</small></div>
                  <button type="button" className="lw-draw-icon" aria-label="Mathematik-Löser schließen" onClick={closeMathSolverSelection}><X size={15} /></button>
                </div>

                {mathSolverSelection.status === 'recognizing' ? <div className="lw-math-solver-loading">
                  <LoaderCircle className="lw-spin" size={20} /> Ausdruck und räumliches Layout werden gelesen …
                </div> : mathSolverSelection.status === 'error' ? <div className="lw-math-solver-error">
                  <CircleAlert size={18} />
                  <span>{mathSolverSelection.error}</span>
                  {knownTrainingSampleCount === 0 && <button type="button" className="lw-draw-subtle" onClick={requestTraining}><Sparkles size={14} /> GlyphenWerk öffnen</button>}
                </div> : <>
                  <div className="lw-math-solver-confidence">
                    <span>Erkennung</span>
                    <i><b style={{ width: `${mathSolverSelection.confidence}%` }} /></i>
                    <strong>{mathSolverSelection.confidence}%</strong>
                  </div>
                  {mathSolverSelection.confidence < 62 && <p className="lw-math-solver-warning">Bitte prüfe den erkannten Ausdruck vor dem Rechnen.</p>}
                  <label className="lw-math-solver-input">
                    <span>Erkannter Ausdruck</span>
                    <input
                      value={mathSolverInput}
                      spellCheck={false}
                      inputMode="text"
                      onChange={(event) => setMathSolverInput(event.target.value)}
                    />
                  </label>
                  <div className="lw-math-solver-preview">
                    {mathSolverPreview
                      ? <div dangerouslySetInnerHTML={{ __html: mathSolverPreview }} />
                      : <code>{mathSolverInput || 'Vorschau nicht verfügbar'}</code>}
                  </div>
                  {mathSolverInspection.error && <div className="lw-math-solver-validation"><CircleAlert size={13} /> {mathSolverInspection.error}</div>}
                  <div className="lw-math-solver-options">
                    {mathSolverInspection.inspection?.variables.length ? <label>
                      <span>Variable</span>
                      <select
                        value={mathSolverInspection.inspection.variables.includes(mathSolverVariable)
                          ? mathSolverVariable
                          : mathSolverInspection.inspection.variables[0]}
                        onChange={(event) => setMathSolverVariable(event.target.value)}
                      >
                        {mathSolverInspection.inspection.variables.map((variable) => <option key={variable} value={variable}>{variable}</option>)}
                      </select>
                    </label> : <span />}
                    <label>
                      <span>Fortsetzung</span>
                      <select value={mathSolverPlacement} onChange={(event) => setMathSolverPlacement(event.target.value as MathSolverPlacement)}>
                        <option value="auto">Automatisch gelernt</option>
                        <option value="same-line">Rechts daneben</option>
                        <option value="next-line">Nächste Zeile</option>
                      </select>
                    </label>
                  </div>
                  <div className="lw-math-solver-actions">
                    {(['simplify', 'solve', 'expand', 'factor', 'calculate'] as MathSolverAction[]).map((action) => {
                      const inspection = mathSolverInspection.inspection
                      const disabled = !inspection
                        || isMathSolving
                        || (action === 'solve' && !inspection.variables.length)
                        || (action === 'calculate' && (inspection.variables.length > 0 || inspection.isEquation))
                      return <button
                        type="button"
                        key={action}
                        disabled={disabled}
                        className={action === 'simplify' || action === 'solve' ? 'is-primary' : ''}
                        onClick={() => void runMathSolverAction(action)}
                      >
                        {isMathSolving ? <LoaderCircle className="lw-spin" size={13} /> : <Calculator size={13} />}
                        {action === 'solve' && inspection?.variables.length
                          ? `Nach ${mathSolverVariable || inspection.variables[0]} lösen`
                          : mathSolverActionLabel[action]}
                      </button>
                    })}
                  </div>
                  <small className="lw-math-solver-footnote">Brüche, Wurzeln und Potenzen werden symbolisch verarbeitet. Die Anordnung orientiert sich an deinen bisherigen Lösungen.</small>
                </>}
              </div>
            </>}
          </div>
          <div className="lw-canvas-meta">
            <span><i className="lw-pressure-dot" />{settings.pressureEnabled ? 'Druckdynamik aktiv' : 'Konstante Strichbreite'}</span>
            <span>{handwritingCount ? `${handwritingCount} Handschrift` : ''}{handwritingCount && artCount ? ' · ' : ''}{artCount ? `${artCount} Zeichnung` : ''}{!inkCount ? 'Noch leer' : ''} · {sourceHeight === SOURCE_HEIGHT && sourceWidth === SOURCE_WIDTH ? 'A4-Seite' : 'Zeichenfläche'}</span>
          </div>
        </div>

        {settings.experimentalHandwritingToText && conversionOpen && (inline ? (node: ReactNode) => createPortal(node, document.body) : (node: ReactNode) => node)(
        <aside className={`lw-conversion-panel ${inline ? 'is-viewport-chrome' : ''}`} aria-label="Handschrift konvertieren">
          <div className="lw-conversion-head">
            <span className="lw-spark"><Sparkles size={17} /></span>
            <div><strong>Intelligente Konvertierung</strong><small>{recognitionScope === 'selection' ? `${recognitionStrokesRef.current?.length ?? 0} Striche im ausgewählten Bereich` : 'Ganze Seite'} · vollständig lokal</small></div>
            <button type="button" className="lw-draw-icon" aria-label="Konvertierung schließen" onClick={() => { setConversionOpen(false); clearRecognitionScope() }}><X size={17} /></button>
          </div>

          <div className="lw-mode-switch">
            <button type="button" className={mode === 'auto' ? 'is-active' : ''} onClick={() => changeRecognitionMode('auto')}><ScanSearch size={14} /> Automatisch</button>
            <button type="button" className={mode === 'text' ? 'is-active' : ''} onClick={() => changeRecognitionMode('text')}>Text</button>
            <button type="button" className={mode === 'math' ? 'is-active' : ''} onClick={() => changeRecognitionMode('math')}>Mathematik</button>
          </div>

          {mode === 'auto' && <div className={`lw-auto-detection ${automaticResult ? 'has-result' : ''}`}>
            <ScanSearch size={16} />
            <span><strong>{automaticResult ? `Automatisch erkannt: ${activeMode === 'math' ? 'Mathematik' : 'Text'}` : 'Automatische Moduserkennung aktiv'}</strong><small>{automaticResult ? `${automaticResult.confidence}% sicher · erkannt durch ${automaticResult.reason}` : `Bei unklaren Eingaben wird der zuletzt erkannte ${settings.lastRecognitionMode === 'math' ? 'Mathematik-' : 'Text-'}Modus verwendet.`}</small></span>
          </div>}

          {tokens.length > 0 || correction.trim() ? <>
            {tokens.length > 0 && <>
              <div className="lw-confidence-row">
                <span>Gesamtsicherheit</span>
                <div><i style={{ width: `${averageConfidence}%` }} /></div>
                <strong>{averageConfidence}%</strong>
              </div>

              <div className="lw-token-strip" aria-label="Erkannte Zeichen und Alternativen">
                {tokens.filter((token) => !token.isLayout).map((token) => (
                <div
                  className={`lw-token ${token.context?.changed ? 'is-context' : ''}`}
                  key={token.id}
                  title={token.context?.changed ? `Durch Wortkontext „${token.context.word}“ gewählt` : undefined}
                >
                  <span className="lw-token-value">{token.char}</span>
                  <span className={`lw-token-score ${token.confidence < 55 ? 'is-low' : ''}`}>{token.confidence}%</span>
                  {token.context?.changed && <span className="lw-token-context">Kontext</span>}
                  {token.alternatives.length > 1 && <div className="lw-token-alternatives">
                    {token.alternatives.slice(0, 4).map((alternative) => (
                      <button
                        type="button"
                        key={alternative.labelId}
                        className={alternative.labelId === token.labelId ? 'is-active' : ''}
                        title={`${alternative.name} · ${alternative.confidence}%`}
                        onClick={() => updateToken(token.id, alternative.labelId)}
                      >{alternative.char}</button>
                    ))}
                  </div>}
                </div>
                ))}
              </div>
            </>}

            <label className="lw-correction-field">
              <span>{activeMode === 'math' ? 'LaTeX prüfen oder korrigieren' : 'Text prüfen oder korrigieren'}</span>
              <textarea
                value={correction}
                rows={activeMode === 'math' ? 2 : 4}
                spellCheck={activeMode === 'text'}
                onChange={(event) => setCorrection(event.target.value)}
              />
            </label>

            <div className={`lw-beautiful-preview mode-${activeMode}`}>
              <span className="lw-preview-label">Live-Vorschau</span>
              {activeMode === 'math'
                ? mathPreview
                  ? <div className="lw-math-render" dangerouslySetInnerHTML={{ __html: mathPreview }} />
                  : <span className="lw-preview-empty">Formel eingeben …</span>
                : <p data-i18n-ignore={correction ? true : undefined}>{correction || <span className="lw-preview-empty">Erkannter Text erscheint hier …</span>}</p>}
            </div>

            <button type="button" className="lw-primary-action" disabled={!correction.trim()} onClick={() => void insertConversion()}>
              <Check size={17} /> Als {activeMode === 'math' ? 'Formel' : 'Text'} einfügen
            </button>
          </> : <div className="lw-empty-conversion">
            <Sparkles size={24} />
            <strong>Bereit für deine Handschrift</strong>
            <p>Schreibe einen Satz oder eine vollständige Formel. Brüche, Wurzeln, Indizes sowie Grenzen von ∫ und ∑ werden räumlich gesetzt.</p>
            <button type="button" className="lw-primary-action" onClick={() => void recognize(mode, recognitionStrokesRef.current ?? strokesRef.current)} disabled={!inkCount || isRecognizing}>
              {isRecognizing ? <LoaderCircle className="lw-spin" size={17} /> : <Sparkles size={17} />}
              Jetzt analysieren
            </button>
          </div>}

          <div className="lw-model-card">
            <span className={resources?.model.length ? 'is-ready' : ''} />
            <div className="lw-model-copy">
              <strong>{resources?.sampleCount
                ? `Standardmodell + ${resources.sampleCount} persönliche Beispiele`
                : resources?.model.length
                  ? 'Standardmodell aktiv'
                  : knownTrainingSampleCount
                    ? `${knownTrainingSampleCount} persönliche Beispiele · Modell bei Bedarf`
                    : knownTrainingSampleCount === 0
                      ? 'Erkennung bei Bedarf bereit'
                      : 'Lokales Training wird geprüft …'}</strong>
              <small>{resources?.sampleCount
                ? `${resources.modelClassCount} erkennbare Klassen · ${resources.classCount} davon personalisiert${resources.model.estimatedAccuracy !== null ? ` · intern ${Math.round(resources.model.estimatedAccuracy)}%` : ''}`
                : resources?.model.length
                  ? `${resources.modelClassCount} Text- und Mathematikklassen · GlyphenWerk-Training ist optional`
                  : 'Das rechenintensive Modell wird erst beim Konvertieren geladen.'}</small>
            </div>
            <div className="lw-model-actions">
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isImporting || isResettingTraining}>
                {isImporting ? <LoaderCircle className="lw-spin" size={14} /> : <FileInput size={14} />}
                Import
              </button>
              <button
                type="button"
                className="is-danger"
                onClick={() => void resetTraining()}
                disabled={isImporting || isResettingTraining || !knownTrainingSampleCount}
                title="Lokales Training vollständig zurücksetzen"
              >
                {isResettingTraining ? <LoaderCircle className="lw-spin" size={14} /> : <Trash2 size={14} />}
                Löschen
              </button>
            </div>
          </div>
        </aside>)}
      </div>

      {notice && (inline ? (node: ReactNode) => createPortal(node, document.body) : (node: ReactNode) => node)(
      <div className={`lw-draw-notice is-${notice.kind} ${inline ? 'is-viewport-chrome' : ''}`} role="status">
        {notice.kind === 'success' ? <Check size={15} /> : notice.kind === 'error' ? <CircleAlert size={15} /> : <Sparkles size={15} />}
        <span>{notice.text}</span>
        <button type="button" aria-label="Hinweis schließen" onClick={() => setNotice(null)}><X size={14} /></button>
      </div>
      )}

      {(() => {
        const fileInput = (
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void importTraining(file) }}
        />
        )
        if (inline) return fileInput
        const footer = (
      <footer
        className="lw-draw-footer"
        data-fanotes-drawing-chrome={undefined}
      >
        {inkMode === 'writing' && knownTrainingSampleCount === 0 && <div>
          <button type="button" className="lw-draw-subtle" onClick={requestTraining} disabled={isImporting || isResettingTraining}>
            {isImporting ? <LoaderCircle className="lw-spin" size={15} /> : <Sparkles size={15} />}
            GlyphenWerk öffnen
          </button>
        </div>}
        {fileInput}
        <div className="lw-footer-actions">
          <button type="button" className="lw-draw-subtle" onClick={() => void saveDrawing(true)} disabled={!inkCount || isSaving}>
            <Save size={15} /> Seite als Bild einfügen
          </button>
          {inkMode === 'writing' && <button type="button" className={`lw-draw-subtle ${selectionMode && selectionPurpose === 'edit' ? 'is-active' : ''}`} onClick={beginInkEdit} disabled={!handwritingCount} title="Tinte auswählen, verschieben, kopieren oder skalieren">
            <Shapes size={14} /> Tinte
          </button>}
          {selectionPurpose === 'edit' && selectionRect && !selectionMode && <>
            <button type="button" className="lw-draw-subtle" onClick={copySelectedInk} title="Auswahl duplizieren"><Copy size={14} /> Kopieren</button>
            <button type="button" className="lw-draw-subtle lw-danger" onClick={deleteSelectedInk} title="Auswahl löschen"><Trash2 size={14} /> Löschen</button>
          </>}
          {settings.experimentalHandwritingToText && inkMode === 'writing' && <button type="button" className={`lw-draw-subtle ${selectionMode && selectionPurpose === 'conversion' ? 'is-active' : ''}`} onClick={beginSelectionRecognition} disabled={!handwritingCount || isRecognizing} title="Einen frei gewählten Bereich von Handschrift in Text oder Mathematik konvertieren">
            <ScanSearch size={16} /> Bereich konvertieren
          </button>}
          {settings.experimentalHandwritingToText && inkMode === 'writing' && <button type="button" className="lw-convert-action" onClick={recognizePage} disabled={!handwritingCount || isRecognizing} title="Die gesamte Handschrift-Seite konvertieren">
            {isRecognizing ? <LoaderCircle className="lw-spin" size={16} /> : <Sparkles size={16} />}
            Seite konvertieren
          </button>}
          {inkMode === 'drawing' && <span className="lw-art-footer-note"><Paintbrush size={14} /> Zeichenstriche und Piktogramme werden nicht als Text interpretiert</span>}
        </div>
      </footer>
        )
        return footer
      })()}

      <TextToHandwritingDialog
        open={textToHandwritingOpen}
        samples={resources?.samples ?? []}
        pageWidth={sourceWidth}
        pageHeight={sourceHeight}
        suggestedStartY={Math.max(96, bottomOfStrokes(strokesRef.current, sourceHeight) + 58)}
        color={penColor}
        baseWidth={penWidth}
        pressureEnabled={settings.pressureEnabled}
        paperStyle={paperStyle}
        onClose={() => setTextToHandwritingOpen(false)}
        onInsert={insertSynthesizedHandwriting}
        onRequestTraining={requestTraining}
      />
    </section>
  )
}))

const drawingBoardStyles = `
.lw-drawing-board{--draw-accent:var(--accent,#7654d6);--draw-border:var(--border-strong,color-mix(in srgb,var(--text,#e9e9ef) 20%,transparent));display:flex;flex-direction:column;min-width:0;height:100%;overflow:hidden;color:var(--text,#e9e9ef);background:linear-gradient(145deg,color-mix(in srgb,var(--background-secondary,#17171d) 96%,var(--draw-accent) 4%),var(--background,#111116));font:500 13px/1.4 var(--ui-font,Inter,system-ui,sans-serif)}
.lw-drawing-board *{box-sizing:border-box}.lw-drawing-board button,.lw-drawing-board select,.lw-drawing-board textarea,.lw-drawing-board input{font:inherit}.lw-drawing-board button{color:inherit}.lw-draw-header{height:58px;flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid var(--draw-border);background:color-mix(in srgb,var(--background-secondary,#17171d) 88%,transparent)}
.lw-draw-title,.lw-draw-header-actions,.lw-draw-toolgroup,.lw-draw-footer,.lw-footer-actions,.lw-conversion-head,.lw-confidence-row,.lw-model-card{display:flex;align-items:center}.lw-draw-title{gap:10px;min-width:0}.lw-draw-title-icon,.lw-spark{display:grid;place-items:center;color:var(--on-accent,#11131a);background:var(--draw-accent);box-shadow:0 6px 20px color-mix(in srgb,var(--draw-accent) 28%,transparent)}.lw-draw-title-icon{width:32px;height:32px;border-radius:10px}.lw-draw-title>span:last-child{display:flex;min-width:0;flex-direction:column}.lw-draw-title strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.lw-draw-title small,.lw-conversion-head small,.lw-model-card small{font-size:11px;color:var(--text-muted,#9292a0)}.lw-draw-header-actions{gap:7px}
.lw-draw-toolbar{min-height:58px;flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--draw-border);overflow-x:auto;background:color-mix(in srgb,var(--background,#111116) 74%,transparent)}.lw-draw-toolgroup{gap:4px}.lw-segmented{padding:3px;border:1px solid var(--draw-border);border-radius:11px;background:color-mix(in srgb,var(--background-secondary,#17171d) 82%,transparent)}.lw-segmented button,.lw-mode-switch button{display:flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:8px;background:transparent;color:var(--text-muted,#9999a7);cursor:pointer}.lw-segmented button{height:30px;padding:0 10px}.lw-segmented button.is-active,.lw-mode-switch button.is-active{color:var(--text,#fff);background:color-mix(in srgb,var(--draw-accent) 22%,var(--background-secondary,#17171d));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--draw-accent) 36%,transparent)}
.lw-colors{padding:0 4px}.lw-colors>button,.lw-color-custom{position:relative;width:23px;height:23px;border-radius:50%;border:2px solid transparent;background:var(--ink-color);cursor:pointer}.lw-colors>button.is-active{border-color:var(--text,#fff);box-shadow:0 0 0 2px color-mix(in srgb,var(--ink-color) 50%,transparent)}.lw-color-custom{display:block;overflow:hidden;border:1px dashed var(--text-muted,#777);background:conic-gradient(#e45,#fb3,#6d5,#4ce,#65f,#c5e,#e45)}.lw-color-custom input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}.lw-color-custom span{position:absolute;inset:5px;border-radius:50%}
.lw-draw-range{display:grid;grid-template-columns:auto minmax(64px,105px) 42px;align-items:center;gap:7px;color:var(--text-muted,#9999a7);white-space:nowrap}.lw-draw-range input{accent-color:var(--draw-accent);width:100%}.lw-draw-range output{text-align:right;font-size:11px;font-variant-numeric:tabular-nums}.lw-paper-select{position:relative;display:flex;align-items:center}.lw-paper-select select{height:34px;appearance:none;padding:0 30px 0 10px;border:1px solid var(--draw-border);border-radius:9px;color:var(--text,#fff);background:var(--background-secondary,#1a1a20);outline:none}.lw-paper-select svg{position:absolute;right:9px;pointer-events:none;color:var(--text-muted,#999)}.lw-view-controls{gap:2px;padding:2px;border:1px solid var(--draw-border);border-radius:10px;background:color-mix(in srgb,var(--background-secondary,#17171d) 82%,transparent)}.lw-view-reset{min-width:64px;height:30px;padding:0 8px;font-size:10px;font-variant-numeric:tabular-nums}.lw-history{margin-left:auto}.lw-drawing-board:focus{outline:none}.lw-drawing-board:focus-visible{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--draw-accent) 55%,transparent)}
.lw-art-studio-trigger{height:38px;display:grid;grid-template-columns:19px minmax(68px,auto) 25px;align-items:center;gap:7px;padding:0 8px;border:1px solid color-mix(in srgb,var(--draw-accent) 32%,var(--draw-border));border-radius:10px;color:var(--text,#fff);background:linear-gradient(130deg,color-mix(in srgb,var(--draw-accent) 12%,var(--background-secondary,#18181f)),var(--background-secondary,#18181f));cursor:pointer}.lw-art-studio-trigger>svg{color:var(--accent-readable,var(--draw-accent))}.lw-art-studio-trigger>span{display:flex;min-width:0;flex-direction:column;text-align:left}.lw-art-studio-trigger strong{font-size:10px}.lw-art-studio-trigger small{max-width:92px;overflow:hidden;color:var(--text-muted,#999);font-size:7px;text-overflow:ellipsis;white-space:nowrap}.lw-art-studio-trigger>i{width:25px;height:25px;border:2px solid color-mix(in srgb,var(--text,#fff) 25%,transparent);border-radius:8px;background:var(--art-ink);box-shadow:inset 0 1px rgba(255,255,255,.25)}
.lw-art-studio{position:relative;z-index:13;flex:0 0 auto;margin:10px 14px 0;padding:11px;border:1px solid color-mix(in srgb,var(--draw-accent) 36%,var(--draw-border));border-radius:16px;background:linear-gradient(145deg,color-mix(in srgb,var(--background-secondary,#19191f) 96%,var(--draw-accent) 4%),color-mix(in srgb,var(--background,#111116) 94%,transparent));box-shadow:0 22px 65px rgba(0,0,0,.24),inset 0 1px rgba(255,255,255,.035);animation:lw-art-studio-in .24s cubic-bezier(.2,.8,.2,1)}.lw-art-studio>header{display:flex;align-items:center;gap:8px;margin-bottom:9px}.lw-art-studio>header>span{width:29px;height:29px;display:grid;place-items:center;border-radius:9px;color:var(--on-accent,#111);background:var(--draw-accent)}.lw-art-studio>header>div{display:flex;min-width:0;flex:1;flex-direction:column}.lw-art-studio>header strong{font-size:11px}.lw-art-studio>header small{color:var(--text-muted,#999);font-size:8px}.lw-art-studio-body{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) minmax(160px,.64fr);gap:10px}.lw-art-studio-body>section{min-width:0;padding:9px;border:1px solid var(--draw-border);border-radius:12px;background:color-mix(in srgb,var(--background,#111116) 43%,transparent)}.lw-art-section-head{height:23px;display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.lw-art-section-head strong{font-size:9px}.lw-art-section-head span{overflow:hidden;color:var(--text-muted,#999);font-size:7px;text-overflow:ellipsis;white-space:nowrap}.lw-art-brushes{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}.lw-art-brushes>button{min-width:0;height:49px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:3px;padding:3px;border:1px solid transparent;border-radius:8px;color:var(--text-muted,#999);background:transparent;cursor:pointer}.lw-art-brushes>button:hover{background:color-mix(in srgb,var(--text,#fff) 6%,transparent)}.lw-art-brushes>button.is-active{border-color:color-mix(in srgb,var(--draw-accent) 48%,var(--draw-border));color:var(--text,#fff);background:color-mix(in srgb,var(--draw-accent) 12%,transparent)}.lw-art-brushes small{max-width:100%;overflow:hidden;font-size:7px;text-overflow:ellipsis;white-space:nowrap}.lw-art-brush-preview{position:relative;width:42px;height:16px;display:grid;place-items:center;overflow:hidden}.lw-art-brush-preview i{display:block;width:37px;height:3px;border-radius:99px;background:currentColor;transform:rotate(-5deg)}.lw-art-brush-preview.is-fineliner i{height:2px}.lw-art-brush-preview.is-pencil i{height:2px;opacity:.65;background:repeating-linear-gradient(90deg,currentColor 0 3px,transparent 3px 4px)}.lw-art-brush-preview.is-marker i{height:6px;border-radius:2px;opacity:.88}.lw-art-brush-preview.is-paintbrush i{height:7px;border-radius:90% 15% 80% 20%;transform:rotate(-5deg) scaleX(1.02)}.lw-art-brush-preview.is-calligraphy i{height:7px;border-radius:1px;transform:rotate(-5deg) skewX(-28deg)}.lw-art-brush-preview.is-highlighter i{height:9px;border-radius:2px;opacity:.35}.lw-art-brush-preview.is-watercolor i{height:10px;opacity:.28;filter:blur(.45px);box-shadow:0 -2px currentColor,0 2px currentColor}.lw-art-brush-preview.is-spray i{height:13px;opacity:.75;background:radial-gradient(circle,currentColor 0 1px,transparent 1.3px) 0 0/5px 5px;transform:rotate(-5deg)}
.lw-art-solid-colors{display:flex;flex-wrap:wrap;gap:5px}.lw-art-solid-colors>button,.lw-art-custom-color{position:relative;width:20px;height:20px;flex:0 0 auto;border:2px solid color-mix(in srgb,var(--text,#fff) 8%,transparent);border-radius:7px;background:var(--art-ink);cursor:pointer}.lw-art-solid-colors>button.is-active{border-color:var(--text,#fff);box-shadow:0 0 0 2px color-mix(in srgb,var(--art-ink) 40%,transparent)}.lw-art-custom-color{display:block;overflow:hidden;background:conic-gradient(#e45,#fb3,#5d7,#4ce,#65f,#d5e,#e45)}.lw-art-custom-color input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}.lw-art-custom-color span{position:absolute;inset:5px;border-radius:3px}.lw-art-special-inks{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;margin-top:7px}.lw-art-special-inks>button{height:34px;display:flex;min-width:0;align-items:stretch;justify-content:center;flex-direction:column;gap:2px;padding:3px 4px;border:1px solid var(--draw-border);border-radius:7px;color:var(--text-muted,#999);background:transparent;cursor:pointer}.lw-art-special-inks>button:hover{background:color-mix(in srgb,var(--text,#fff) 5%,transparent)}.lw-art-special-inks>button.is-active{border-color:color-mix(in srgb,var(--draw-accent) 60%,var(--draw-border));color:var(--text,#fff);background:color-mix(in srgb,var(--draw-accent) 9%,transparent)}.lw-art-special-inks i{width:100%;height:12px;flex:0 0 auto;border-radius:4px;background:var(--art-ink);box-shadow:inset 0 1px rgba(255,255,255,.25)}.lw-art-special-inks span{overflow:hidden;font-size:7px;line-height:1;text-align:center;text-overflow:ellipsis;white-space:nowrap}.lw-art-control-section{display:flex;flex-direction:column;gap:7px}.lw-art-control-section>label{display:grid;grid-template-columns:minmax(65px,1fr) minmax(60px,1fr) 30px;align-items:center;gap:5px}.lw-art-control-section label>span{display:flex;min-width:0;flex-direction:column}.lw-art-control-section label strong{font-size:8px}.lw-art-control-section label small{overflow:hidden;color:var(--text-muted,#999);font-size:6px;text-overflow:ellipsis;white-space:nowrap}.lw-art-control-section input{width:100%;accent-color:var(--draw-accent)}.lw-art-control-section output{color:var(--text-muted,#999);font-size:7px;text-align:right;font-variant-numeric:tabular-nums}.lw-art-current-stroke{min-height:35px;display:flex;align-items:center;gap:7px;margin-top:auto;padding:4px 6px;border-radius:8px;background:color-mix(in srgb,var(--text,#fff) 4%,transparent)}.lw-art-current-stroke>span{height:var(--art-width);max-height:20px;min-height:2px;flex:1;border-radius:99px;background:var(--art-ink);opacity:var(--art-opacity)}.lw-art-current-stroke small{color:var(--text-muted,#999);font-size:7px;white-space:nowrap}.lw-art-footer-note{display:inline-flex;align-items:center;gap:6px;padding:0 7px;color:var(--text-muted,#999);font-size:8px}.lw-tablet-canvas.tool-art{cursor:crosshair}@keyframes lw-art-studio-in{from{opacity:0;transform:translateY(-7px) scale(.99)}}
.lw-draw-icon,.lw-draw-subtle,.lw-primary-action,.lw-convert-action,.lw-model-card button{border:0;cursor:pointer;transition:transform .16s ease,background .16s ease,opacity .16s ease}.lw-draw-icon{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;background:transparent}.lw-draw-icon:hover:not(:disabled){background:color-mix(in srgb,var(--text,#fff) 8%,transparent)}.lw-draw-icon.lw-danger:hover:not(:disabled){color:var(--danger,#d94b63);background:color-mix(in srgb,var(--danger,#d94b63) 10%,transparent)}.lw-drawing-board button:disabled{opacity:.5;cursor:not-allowed}.lw-draw-subtle{display:flex;align-items:center;justify-content:center;gap:7px;height:32px;padding:0 10px;border-radius:8px;background:color-mix(in srgb,var(--text,#fff) 6%,transparent)}.lw-draw-subtle:hover:not(:disabled){background:color-mix(in srgb,var(--text,#fff) 10%,transparent)}.lw-draw-subtle.is-active{color:var(--text,#fff);background:color-mix(in srgb,var(--draw-accent) 22%,var(--background-secondary,#17171d));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--draw-accent) 38%,transparent)}
.lw-draw-workspace{position:relative;display:grid;grid-template-columns:minmax(0,1fr);flex:1;min-height:0;padding:18px;gap:14px}.lw-draw-workspace.has-conversion{grid-template-columns:minmax(0,1fr) minmax(300px,370px)}.lw-canvas-shell{position:relative;display:flex;min-width:0;min-height:0;flex-direction:column;padding:10px 10px 7px;border:1px solid var(--draw-border);border-radius:17px;background:color-mix(in srgb,var(--background-secondary,#17171d) 84%,transparent);box-shadow:0 20px 55px rgba(0,0,0,.16)}.lw-canvas-glow{position:absolute;inset:-1px;border-radius:inherit;pointer-events:none;background:radial-gradient(circle at 15% 0,color-mix(in srgb,var(--draw-accent) 10%,transparent),transparent 36%)}.lw-canvas-surface{position:relative;z-index:1;flex:0 0 auto;min-width:220px;min-height:300px;aspect-ratio:210/297;margin:auto;overflow:hidden;border-radius:8px;background:#fbfcff;box-shadow:0 8px 32px rgba(0,0,0,.2),inset 0 0 0 1px rgba(30,42,65,.08);will-change:transform;touch-action:none}.lw-tablet-canvas{position:absolute;inset:0;display:block;width:100%;height:100%;outline:none;touch-action:none;user-select:none;-webkit-user-select:none;image-rendering:auto}
.lw-drafting-layer{position:absolute;inset:0;z-index:6;width:100%;height:100%;overflow:visible;pointer-events:none;touch-action:none}
.lw-drafting-body{fill:#e8edf4;stroke:#2a3348;stroke-width:1.2;cursor:grab;pointer-events:auto}
.lw-drafting-window{fill:#f7f9fc;stroke:#5b6578;stroke-width:.8;pointer-events:none}
.lw-drafting-arm{fill:#cfd6e2;stroke:#2a3348;stroke-width:1.1;cursor:grab;pointer-events:auto}
.lw-drafting-edge{stroke:#1e6fd6;stroke-width:2.2;stroke-linecap:round;pointer-events:none}
.lw-drafting-tick{stroke:#2a3348;stroke-width:.8}
.lw-drafting-tick.is-major{stroke:#151a24;stroke-width:1.2}
.lw-drafting-label{fill:#1d2433;font:600 9px/1 var(--ui-font,system-ui);text-anchor:middle;pointer-events:none}
.lw-drafting-caption{fill:#31405c;font:700 10px/1 var(--ui-font,system-ui);text-anchor:middle;pointer-events:none}
.lw-drafting-rotate{fill:#3a6ee8;stroke:#fff;stroke-width:1.5;cursor:alias;pointer-events:auto}
.lw-drafting-compass-ghost{fill:none;stroke:#1e6fd6;stroke-width:1.35;stroke-dasharray:5 4;opacity:.5;pointer-events:none}
.lw-drafting-compass-arc{fill:none;stroke:#1ea86a;stroke-width:2.6;stroke-linecap:round;pointer-events:none}
.lw-drafting-span{stroke:rgba(30,111,214,.35);stroke-width:1.1;stroke-dasharray:3 3;pointer-events:none}
.lw-drafting-leg{fill:none;stroke:#9aa3b5;stroke-width:8;stroke-linecap:round;cursor:grab;pointer-events:stroke}
.lw-drafting-leg.is-pencil{stroke:#c4a57a}
.lw-drafting-hinge{fill:#8a93a5;stroke:#3a4460;stroke-width:1.2;cursor:grab;pointer-events:auto}
.lw-drafting-needle{fill:none;stroke:#1a1f2a;stroke-width:1.6;cursor:grab;pointer-events:auto}
.lw-drafting-needle-dot{fill:#111;pointer-events:none}
.lw-drafting-lead{fill:#2b2f38;stroke:#111;stroke-width:.6;pointer-events:none}
.lw-drafting-radius{fill:#f3c14e;stroke:#fff;stroke-width:1.5;cursor:ew-resize;pointer-events:auto}
.lw-drafting-draw{fill:#1ea86a;stroke:#fff;stroke-width:1.6;cursor:alias;pointer-events:auto}
.lw-drafting-action{cursor:pointer;pointer-events:auto}
.lw-drafting-action-bg{fill:#3a6ee8;stroke:#fff;stroke-width:1.2}
.lw-drafting-action.is-locked .lw-drafting-action-bg{fill:#c45b2d}
.lw-drafting-action.is-circle .lw-drafting-action-bg{fill:#1e6fd6}
.lw-drafting-action-icon{fill:#fff;pointer-events:none}
.lw-drafting-action-icon-ring{fill:none;stroke:#fff;stroke-width:1.6;pointer-events:none}
.lw-drafting-hint{fill:#4a5870;font:600 8px/1 var(--ui-font,system-ui);text-anchor:middle;pointer-events:none}
.lw-drafting-readout{fill:#15305a;font:800 13px/1 var(--ui-font,system-ui);text-anchor:middle}.lw-tablet-canvas-committed{z-index:1;pointer-events:none}.lw-tablet-canvas-live{z-index:2;pointer-events:auto}.lw-tablet-canvas.tool-pen,.lw-tablet-canvas.tool-select{cursor:crosshair}.lw-tablet-canvas.tool-eraser{cursor:cell}.lw-tablet-canvas:focus-visible{box-shadow:inset 0 0 0 2px var(--draw-accent)}.lw-selection-hint{position:absolute;z-index:3;top:18px;left:50%;display:flex;align-items:center;gap:7px;padding:8px 11px;transform:translateX(-50%);border:1px solid rgba(86,71,183,.32);border-radius:9px;color:#28233d;background:rgba(255,255,255,.92);box-shadow:0 8px 24px rgba(39,31,85,.18);font:700 11px/1.2 var(--ui-font,system-ui);pointer-events:none;white-space:nowrap}.lw-selection-rect{position:absolute;z-index:3;min-width:2px;min-height:2px;border:2px dashed #6855d9;background:rgba(104,85,217,.1);box-shadow:0 0 0 9999px rgba(38,35,55,.08);pointer-events:none}.lw-selection-rect.is-editable{pointer-events:auto;cursor:move;box-shadow:0 0 0 2px rgba(104,85,217,.2)}.lw-selection-scale{position:absolute;right:-6px;bottom:-6px;width:13px;height:13px;border-radius:3px;background:#5f4bcf;cursor:nwse-resize}.lw-selection-rect.is-selected{border-style:solid;background:rgba(104,85,217,.07);box-shadow:0 0 0 9999px rgba(38,35,55,.04),0 0 0 3px rgba(104,85,217,.14)}.lw-selection-rect span{position:absolute;bottom:calc(100% + 5px);left:-2px;padding:3px 7px;border-radius:6px;color:#fff;background:#5f4bcf;font:700 9px/1.3 var(--ui-font,system-ui);white-space:nowrap}.lw-canvas-meta{display:flex;align-items:center;justify-content:space-between;padding:7px 3px 0;color:var(--text-muted,#9292a0);font-size:10px}.lw-canvas-meta span{display:flex;align-items:center;gap:6px}.lw-pressure-dot{width:6px;height:6px;border-radius:50%;background:#4bd7a4;box-shadow:0 0 7px #4bd7a4}
.lw-selection-hint.is-correction{border-color:rgba(30,142,115,.42);color:#153b32;background:rgba(242,255,250,.95)}.lw-math-correction-scope{position:absolute;z-index:3;border:1px dashed rgba(60,95,178,.5);border-radius:7px;background:rgba(67,102,190,.025);pointer-events:none}.lw-math-step-mark{position:absolute;z-index:4;min-width:5px;min-height:5px;border:2px solid rgba(91,106,151,.5);border-radius:6px;background:rgba(91,106,151,.04);pointer-events:none;transition:border-color .22s,background .22s,box-shadow .22s}.lw-math-step-mark>span{position:absolute;top:-8px;left:-8px;display:grid;width:17px;height:17px;place-items:center;border-radius:50%;color:#fff;background:#667091;font:800 8px/1 var(--ui-font,system-ui);box-shadow:0 3px 8px rgba(0,0,0,.2)}.lw-math-step-mark.is-start{border-color:#6855d9;background:rgba(104,85,217,.06)}.lw-math-step-mark.is-start>span{background:#6855d9}.lw-math-step-mark.is-correct{border-color:#249671;background:rgba(36,150,113,.07);box-shadow:0 0 0 3px rgba(36,150,113,.09)}.lw-math-step-mark.is-correct>span{background:#208963}.lw-math-step-mark.is-incorrect,.lw-math-step-mark.is-unreadable{border-color:#dc3f59;background:rgba(220,63,89,.09);box-shadow:0 0 0 3px rgba(220,63,89,.12)}.lw-math-step-mark.is-incorrect>span,.lw-math-step-mark.is-unreadable>span{background:#c9354e}.lw-math-step-mark.is-uncertain{border-color:#d18b25;background:rgba(209,139,37,.09)}.lw-math-step-mark.is-uncertain>span{background:#b87518}.lw-math-error-spot{position:absolute;z-index:7;min-width:12px;min-height:12px;border:3px solid #df304d;border-radius:7px;background:rgba(238,45,75,.14);box-shadow:0 0 0 4px rgba(238,45,75,.12),0 0 25px rgba(222,39,69,.3);pointer-events:none;animation:lw-error-pulse 1.35s ease-in-out infinite}.lw-math-error-spot.is-uncertain,.lw-math-error-spot.is-unreadable{border-color:#d38b20;background:rgba(230,151,33,.12);box-shadow:0 0 0 4px rgba(230,151,33,.12)}.lw-math-error-spot>span{position:absolute;bottom:calc(100% + 5px);left:-3px;padding:3px 7px;border-radius:6px;color:#fff;background:#d9304b;font:800 8px/1.2 var(--ui-font,system-ui);white-space:nowrap}.lw-math-error-spot.is-uncertain>span,.lw-math-error-spot.is-unreadable>span{background:#b87518}@keyframes lw-error-pulse{50%{box-shadow:0 0 0 7px rgba(238,45,75,.05),0 0 30px rgba(222,39,69,.34)}}
.lw-math-correction-popover{position:absolute;z-index:9;display:flex;width:min(390px,calc(100% - 22px));max-height:min(560px,86%);flex-direction:column;gap:9px;overflow:auto;padding:11px;border:1px solid color-mix(in srgb,#2b9c79 42%,var(--draw-border));border-radius:14px;color:var(--text,#f4f2fa);background:linear-gradient(150deg,color-mix(in srgb,var(--background-secondary,#18171f) 95%,#2b9c79 5%),var(--background,#111116));box-shadow:0 24px 70px rgba(15,25,23,.42),0 0 0 1px rgba(255,255,255,.03);backdrop-filter:blur(18px);pointer-events:auto}.lw-math-correction-head{display:flex;align-items:center;gap:8px}.lw-math-correction-head>span{display:grid;width:28px;height:28px;flex:0 0 auto;place-items:center;border-radius:9px;color:#071b15;background:#48c39c}.lw-math-correction-head>div{display:flex;min-width:0;flex:1;flex-direction:column}.lw-math-correction-head strong{font-size:11px}.lw-math-correction-head small,.lw-math-correction-footnote{color:var(--text-muted,#aaa);font-size:8px;line-height:1.45}.lw-math-correction-loading,.lw-math-correction-error{display:flex;min-height:82px;align-items:center;justify-content:center;gap:8px;color:var(--text-muted,#aaa);text-align:center;font-size:10px}.lw-math-correction-error{flex-direction:column;color:var(--danger,#e16778)}.lw-math-correction-result{display:flex;align-items:flex-start;gap:8px;padding:8px 9px;border:1px solid var(--draw-border);border-radius:9px}.lw-math-correction-result>svg{flex:0 0 auto;margin-top:1px}.lw-math-correction-result>span,.lw-math-correction-result strong,.lw-math-correction-result small{display:block}.lw-math-correction-result strong{font-size:10px}.lw-math-correction-result small{margin-top:2px;color:var(--text-muted,#aaa);font-size:8px;line-height:1.45}.lw-math-correction-result.is-correct{color:var(--success,#4bc69d);border-color:color-mix(in srgb,var(--success,#4bc69d) 32%,var(--draw-border));background:color-mix(in srgb,var(--success,#4bc69d) 8%,transparent)}.lw-math-correction-result.is-incorrect,.lw-math-correction-result.is-unreadable{color:var(--danger,#e16778);border-color:color-mix(in srgb,var(--danger,#e16778) 34%,var(--draw-border));background:color-mix(in srgb,var(--danger,#e16778) 8%,transparent)}.lw-math-correction-result.is-uncertain,.lw-math-correction-result.is-editing{color:var(--warning,#d49a48);border-color:color-mix(in srgb,var(--warning,#d49a48) 34%,var(--draw-border));background:color-mix(in srgb,var(--warning,#d49a48) 8%,transparent)}
.lw-math-step-list{display:flex;flex-direction:column;gap:5px}.lw-math-step-row{display:grid;grid-template-columns:22px minmax(0,1fr) 39px;align-items:center;gap:6px;padding:6px;border:1px solid var(--draw-border);border-radius:9px;background:color-mix(in srgb,var(--background,#111116) 46%,transparent)}.lw-math-step-row.is-incorrect,.lw-math-step-row.is-unreadable{border-color:color-mix(in srgb,var(--danger,#e16778) 48%,var(--draw-border));background:color-mix(in srgb,var(--danger,#e16778) 7%,transparent)}.lw-math-step-row.is-correct{border-color:color-mix(in srgb,var(--success,#4bc69d) 28%,var(--draw-border))}.lw-math-step-number{display:grid;width:20px;height:20px;place-items:center;border-radius:6px;color:var(--text-muted,#aaa);background:color-mix(in srgb,var(--background-modifier-border,#555) 42%,transparent);font:800 8px/1 var(--ui-font,system-ui)}.lw-math-step-input{display:flex;min-width:0;flex-direction:column;gap:2px}.lw-math-step-input input{width:100%;min-width:0;padding:5px 7px;border:1px solid transparent;border-radius:6px;outline:none;color:inherit;background:transparent;font:600 11px/1.2 var(--mono-font,monospace)}.lw-math-step-input input:hover,.lw-math-step-input input:focus{border-color:var(--draw-border);background:color-mix(in srgb,var(--background,#111116) 82%,transparent)}.lw-math-step-input small{overflow:hidden;color:var(--text-muted,#aaa);font-size:7px;line-height:1.25;text-overflow:ellipsis;white-space:nowrap}.lw-math-step-status{overflow:hidden;color:var(--text-muted,#aaa);font-size:7px;text-align:right;text-overflow:ellipsis;white-space:nowrap}.lw-math-step-row.is-incorrect .lw-math-step-status,.lw-math-step-row.is-unreadable .lw-math-step-status{color:var(--danger,#e16778)}.lw-math-step-row.is-correct .lw-math-step-status{color:var(--success,#4bc69d)}.lw-math-step-row.is-uncertain .lw-math-step-status{color:var(--warning,#d49a48)}.lw-math-correction-suggestion{display:flex;align-items:center;gap:7px;padding:7px 9px;border-radius:8px;color:var(--text-normal,#ddd);background:color-mix(in srgb,#6855d9 11%,transparent);font-size:9px}.lw-math-correction-suggestion code{overflow:hidden;color:#b9acf9;text-overflow:ellipsis;white-space:nowrap}.lw-math-correction-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}.lw-math-correction-actions button{display:flex;min-height:30px;align-items:center;justify-content:center;gap:5px;border:1px solid var(--draw-border);border-radius:8px;color:inherit;background:color-mix(in srgb,var(--background-secondary,#18171f) 78%,transparent);font:700 9px/1 var(--ui-font,system-ui);cursor:pointer}.lw-math-correction-actions button:first-child{border-color:color-mix(in srgb,#35b68e 40%,var(--draw-border));background:color-mix(in srgb,#35b68e 11%,transparent)}.lw-math-correction-actions button:hover{filter:brightness(1.12)}.lw-math-correction-actions button:disabled{opacity:.55;cursor:wait}.lw-math-correction-footnote{margin:0}
.lw-math-selection{position:absolute;z-index:4;min-width:5px;min-height:5px;border:2px solid #7259e8;border-radius:5px;background:rgba(114,89,232,.07);box-shadow:0 0 0 3px rgba(114,89,232,.13),0 0 24px rgba(90,67,194,.16);pointer-events:none}.lw-math-selection>span{position:absolute;bottom:calc(100% + 5px);left:-2px;display:flex;align-items:center;gap:4px;padding:3px 7px;border-radius:6px;color:#fff;background:#654dd4;font:700 9px/1.3 var(--ui-font,system-ui);white-space:nowrap}
.lw-math-solver-popover{position:absolute;z-index:8;display:flex;width:min(350px,calc(100% - 24px));max-height:min(490px,78%);flex-direction:column;gap:9px;overflow:auto;padding:11px;border:1px solid color-mix(in srgb,var(--draw-accent) 40%,var(--draw-border));border-radius:14px;color:var(--text,#f4f2fa);background:linear-gradient(150deg,color-mix(in srgb,var(--background-secondary,#18171f) 95%,var(--draw-accent) 5%),var(--background,#111116));box-shadow:0 24px 70px rgba(15,12,28,.42),0 0 0 1px rgba(255,255,255,.03);backdrop-filter:blur(18px);pointer-events:auto}.lw-math-solver-head{display:flex;align-items:center;gap:8px}.lw-math-solver-head>span{display:grid;width:28px;height:28px;flex:0 0 auto;place-items:center;border-radius:9px;color:var(--on-accent,#11131a);background:var(--draw-accent)}.lw-math-solver-head>div{display:flex;min-width:0;flex:1;flex-direction:column}.lw-math-solver-head strong{font-size:11px}.lw-math-solver-head small,.lw-math-solver-footnote{color:var(--text-muted,#aaa);font-size:8px;line-height:1.4}.lw-math-solver-loading,.lw-math-solver-error{display:flex;min-height:82px;align-items:center;justify-content:center;gap:8px;color:var(--text-muted,#aaa);text-align:center;font-size:10px}.lw-math-solver-error{flex-direction:column;color:var(--danger,#e16778)}
.lw-math-solver-confidence{display:flex;align-items:center;gap:7px;color:var(--text-muted,#aaa);font-size:9px}.lw-math-solver-confidence>i{height:4px;flex:1;overflow:hidden;border-radius:8px;background:color-mix(in srgb,var(--text,#fff) 9%,transparent)}.lw-math-solver-confidence b{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#f1ad53,#4fcda2)}.lw-math-solver-confidence strong{font-size:9px;color:var(--text,#fff)}.lw-math-solver-warning{margin:0;padding:6px 8px;border-radius:7px;color:var(--warning,#d79a49);background:color-mix(in srgb,var(--warning,#d79a49) 10%,transparent);font-size:9px}.lw-math-solver-input{display:flex;flex-direction:column;gap:4px;color:var(--text-muted,#aaa);font-size:9px}.lw-math-solver-input input{height:31px;padding:0 9px;border:1px solid var(--draw-border);border-radius:8px;outline:none;color:var(--text,#fff);background:color-mix(in srgb,var(--background,#111116) 70%,transparent);font:600 12px/1.2 var(--editor-font,ui-monospace,monospace)}.lw-math-solver-input input:focus{border-color:color-mix(in srgb,var(--draw-accent) 65%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--draw-accent) 13%,transparent)}.lw-math-solver-preview{display:grid;min-height:54px;place-items:center;overflow:auto;padding:8px;border:1px solid rgba(56,62,84,.13);border-radius:9px;color:#20212a;background:#fbfcff}.lw-math-solver-preview .katex-display{margin:.15em 0}.lw-math-solver-validation{display:flex;align-items:flex-start;gap:5px;color:var(--danger,#e16778);font-size:9px;line-height:1.4}.lw-math-solver-validation svg{flex:0 0 auto;margin-top:1px}
.lw-math-solver-options{display:grid;grid-template-columns:1fr 1.45fr;gap:7px}.lw-math-solver-options>label{display:flex;min-width:0;flex-direction:column;gap:3px;color:var(--text-muted,#aaa);font-size:8px}.lw-math-solver-options select{width:100%;height:28px;padding:0 7px;border:1px solid var(--draw-border);border-radius:7px;outline:none;color:var(--text,#fff);background:var(--background-secondary,#1a1921);font-size:9px}.lw-math-solver-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}.lw-math-solver-actions button{display:flex;min-height:30px;align-items:center;justify-content:center;gap:5px;padding:5px 7px;border:1px solid var(--draw-border);border-radius:8px;color:var(--text,#fff);background:color-mix(in srgb,var(--text,#fff) 6%,transparent);cursor:pointer;font-size:9px}.lw-math-solver-actions button:hover:not(:disabled){border-color:color-mix(in srgb,var(--draw-accent) 45%,var(--draw-border));background:color-mix(in srgb,var(--draw-accent) 13%,transparent)}.lw-math-solver-actions button.is-primary{color:var(--on-accent,#11131a);border-color:transparent;background:var(--draw-accent)}.lw-math-solver-actions button:last-child{grid-column:1/-1}.lw-math-solver-footnote{display:block}
.lw-conversion-panel{display:flex;min-width:0;min-height:0;flex-direction:column;gap:12px;overflow:auto;padding:14px;border:1px solid color-mix(in srgb,var(--draw-accent) 22%,var(--draw-border));border-radius:17px;background:linear-gradient(155deg,color-mix(in srgb,var(--background-secondary,#19191f) 94%,var(--draw-accent) 6%),var(--background-secondary,#17171d));box-shadow:0 20px 55px rgba(0,0,0,.18)}.lw-conversion-head{gap:9px}.lw-conversion-head>div:nth-child(2){display:flex;min-width:0;flex:1;flex-direction:column}.lw-spark{width:30px;height:30px;flex:0 0 auto;border-radius:9px}.lw-mode-switch{display:grid;grid-template-columns:1.25fr .8fr 1fr;padding:3px;border-radius:10px;background:color-mix(in srgb,var(--background,#111116) 65%,transparent)}.lw-mode-switch button{height:31px;padding:0 6px;font-size:11px}.lw-auto-detection{display:flex;align-items:center;gap:9px;padding:9px 10px;border:1px dashed color-mix(in srgb,var(--draw-accent) 32%,var(--draw-border));border-radius:10px;color:var(--text-muted,#999);background:color-mix(in srgb,var(--draw-accent) 6%,transparent)}.lw-auto-detection.has-result{border-style:solid;color:var(--text,#fff);background:color-mix(in srgb,var(--draw-accent) 11%,transparent)}.lw-auto-detection>svg{flex:0 0 auto;color:var(--draw-accent)}.lw-auto-detection span,.lw-auto-detection strong,.lw-auto-detection small{display:block}.lw-auto-detection strong{font-size:11px}.lw-auto-detection small{margin-top:2px;color:var(--text-muted,#999);font-size:9px;line-height:1.35}.lw-confidence-row{gap:8px;font-size:11px;color:var(--text-muted,#999)}.lw-confidence-row>div{height:5px;flex:1;overflow:hidden;border-radius:9px;background:color-mix(in srgb,var(--text,#fff) 8%,transparent)}.lw-confidence-row i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#ffb453,#60d7a9);transition:width .3s ease}.lw-confidence-row strong{width:34px;text-align:right;color:var(--text,#fff);font-variant-numeric:tabular-nums}
.lw-token-strip{display:flex;gap:7px;padding:2px 1px 8px;overflow-x:auto}.lw-token{position:relative;display:grid;min-width:47px;place-items:center;padding:7px 5px 5px;border:1px solid var(--draw-border);border-radius:10px;background:color-mix(in srgb,var(--background,#111116) 62%,transparent)}.lw-token.is-context{border-color:color-mix(in srgb,var(--draw-accent) 58%,var(--draw-border));background:color-mix(in srgb,var(--draw-accent) 10%,var(--background,#111116))}.lw-token-value{font:600 19px/1.2 var(--editor-font,serif)}.lw-token-score{font-size:9px;color:var(--success,#3a8f6d)}.lw-token-score.is-low{color:var(--warning,#9b6414)}.lw-token-context{margin-top:2px;color:var(--accent-readable,var(--draw-accent));font-size:7px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}.lw-token-alternatives{position:absolute;z-index:3;top:calc(100% + 4px);left:50%;display:none;gap:3px;padding:4px;transform:translateX(-50%);border:1px solid var(--draw-border);border-radius:8px;background:var(--background-secondary,#1a1a21);box-shadow:0 8px 20px rgba(0,0,0,.28)}.lw-token:hover .lw-token-alternatives,.lw-token:focus-within .lw-token-alternatives{display:flex}.lw-token-alternatives button{width:27px;height:27px;border:0;border-radius:6px;background:transparent;cursor:pointer}.lw-token-alternatives button:hover,.lw-token-alternatives button.is-active{background:color-mix(in srgb,var(--draw-accent) 24%,transparent)}
.lw-correction-field{display:flex;flex-direction:column;gap:6px;color:var(--text-muted,#aaa);font-size:11px}.lw-correction-field textarea{width:100%;resize:vertical;min-height:53px;padding:9px 10px;border:1px solid var(--draw-border);border-radius:10px;outline:none;color:var(--text,#fff);background:color-mix(in srgb,var(--background,#111116) 72%,transparent);font:500 13px/1.45 var(--editor-font,ui-monospace,monospace)}.lw-correction-field textarea:focus{border-color:color-mix(in srgb,var(--draw-accent) 65%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--draw-accent) 12%,transparent)}.lw-beautiful-preview{position:relative;display:grid;min-height:100px;place-items:center;overflow:auto;padding:27px 16px 14px;border:1px solid rgba(74,82,110,.12);border-radius:13px;color:#20222c;background:radial-gradient(circle at 20% 10%,rgba(118,84,214,.08),transparent 38%),linear-gradient(145deg,#fff,#f5f6fb);box-shadow:inset 0 1px rgba(255,255,255,.9),0 8px 25px rgba(0,0,0,.12)}.lw-preview-label{position:absolute;top:8px;left:10px;padding:2px 6px;border-radius:5px;color:#737788;background:rgba(100,105,130,.08);font:700 8px/1.4 var(--ui-font,system-ui);letter-spacing:.08em;text-transform:uppercase}.lw-beautiful-preview p{width:100%;margin:0;white-space:pre-wrap;font:500 16px/1.65 var(--editor-font,Georgia,serif)}.lw-math-render{max-width:100%;font-size:18px}.lw-math-render .katex-display{margin:.3em 0}.lw-preview-empty{color:#767988;font-style:italic}.lw-primary-action,.lw-convert-action{display:flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:0 14px;border-radius:10px;color:var(--on-accent,#11131a);background:var(--draw-accent);box-shadow:0 8px 22px color-mix(in srgb,var(--draw-accent) 24%,transparent)}.lw-primary-action:hover:not(:disabled),.lw-convert-action:hover:not(:disabled){transform:translateY(-1px);filter:brightness(1.07)}
.lw-empty-conversion{display:flex;flex:1;min-height:230px;align-items:center;justify-content:center;flex-direction:column;text-align:center;color:var(--text-muted,#999)}.lw-empty-conversion>svg{margin-bottom:10px;color:var(--accent-readable,var(--draw-accent))}.lw-empty-conversion strong{color:var(--text,#fff)}.lw-empty-conversion p{max-width:290px;margin:7px 0 15px;font-size:12px;line-height:1.6}.lw-model-card{gap:9px;margin-top:auto;padding:9px;border:1px solid var(--draw-border);border-radius:11px;background:color-mix(in srgb,var(--background,#111116) 42%,transparent)}.lw-model-card>span{width:7px;height:7px;flex:0 0 auto;border-radius:50%;background:var(--warning,#b36b2d)}.lw-model-card>span.is-ready{background:var(--success,#3a8f6d);box-shadow:0 0 7px color-mix(in srgb,var(--success,#3a8f6d) 65%,transparent)}.lw-model-copy{display:flex;min-width:0;flex:1;flex-direction:column}.lw-model-card strong{font-size:10px}.lw-model-card small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px}.lw-model-actions{display:flex;align-items:center;gap:4px}.lw-model-card button{display:flex;align-items:center;gap:4px;padding:5px 7px;border:0;border-radius:7px;background:color-mix(in srgb,var(--text,#fff) 7%,transparent)}.lw-model-card button.is-danger{color:var(--danger,#d94b63);background:color-mix(in srgb,var(--danger,#d94b63) 9%,transparent)}
.lw-draw-notice{display:flex;align-items:center;gap:7px;margin:0 14px 10px;padding:8px 10px;border:1px solid var(--draw-border);border-radius:9px;background:var(--background-secondary,#1b1b22);font-size:11px}.lw-draw-notice.is-success{color:var(--success,#3a8f6d);border-color:color-mix(in srgb,var(--success,#3a8f6d) 28%,transparent)}.lw-draw-notice.is-error{color:var(--danger,#d94b63);border-color:color-mix(in srgb,var(--danger,#d94b63) 28%,transparent)}.lw-draw-notice.is-info{color:var(--accent-readable,var(--draw-accent));border-color:color-mix(in srgb,var(--draw-accent) 32%,transparent)}.lw-draw-notice span{flex:1}.lw-draw-notice button{display:grid;place-items:center;border:0;background:transparent;color:inherit;cursor:pointer}.lw-draw-footer{min-height:55px;flex:0 0 auto;justify-content:space-between;gap:10px;padding:9px 14px;border-top:1px solid var(--draw-border);background:color-mix(in srgb,var(--background-secondary,#17171d) 92%,transparent)}.lw-footer-actions{gap:8px}.lw-convert-action{min-height:34px}.lw-spin{animation:lw-spin .8s linear infinite}.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}@keyframes lw-spin{to{transform:rotate(360deg)}}

.lw-drawing-board.is-inline{position:absolute;z-index:4;inset:0;height:auto;min-height:100%;overflow:visible;background:transparent;pointer-events:none}
.lw-drawing-board.is-inline .lw-draw-header{display:none}
.lw-drawing-board.is-inline .lw-draw-footer{display:none}
.lw-drawing-board.is-inline .lw-draw-workspace{position:absolute;inset:0;display:block;min-height:100%;padding:0;pointer-events:none}
.lw-drawing-board.is-inline .lw-canvas-shell{position:absolute;inset:0;display:block;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;pointer-events:none}
.lw-drawing-board.is-inline .lw-canvas-glow,.lw-drawing-board.is-inline .lw-canvas-meta{display:none}
.lw-drawing-board.is-inline .lw-canvas-surface{position:absolute;inset:0;width:100%!important;height:100%!important;min-width:0;min-height:0;aspect-ratio:auto;margin:0;border-radius:0;background:transparent;box-shadow:none;will-change:auto;pointer-events:none}
.lw-drawing-board.is-inline.is-input-active .lw-canvas-surface{pointer-events:auto}
.lw-drawing-board.is-inline .lw-tablet-canvas{position:absolute;left:0;width:100%;height:100%;pointer-events:none}
.lw-drawing-board.is-inline .lw-tablet-canvas.is-input-active{pointer-events:none}
.lw-drawing-board.is-inline .lw-conversion-panel,.lw-conversion-panel.is-viewport-chrome{position:fixed;z-index:80;top:78px;right:16px;left:auto;float:none;width:min(370px,calc(100vw - 32px));max-height:calc(100vh - 175px);margin:0;overflow:auto;pointer-events:auto;box-shadow:0 22px 70px rgba(0,0,0,.34)}
.lw-drawing-board.is-inline .lw-draw-notice,.lw-draw-notice.is-viewport-chrome{position:fixed;z-index:81;top:78px;left:50%;width:min(420px,calc(100vw - 28px));margin:0;transform:translateX(-50%);pointer-events:auto;box-shadow:0 13px 34px rgba(0,0,0,.24)}
.lw-drawing-board.is-inline .lw-art-studio,.lw-art-studio.is-viewport-chrome{position:fixed;z-index:79;top:78px;left:14px;right:14px;width:min(900px,calc(100vw - 28px));max-width:calc(100vw - 28px);max-height:calc(100vh - 170px);margin-left:auto;margin-right:auto;transform:none;overflow:auto;background:color-mix(in srgb,var(--background-secondary,#17171d) 95%,transparent);backdrop-filter:blur(18px);pointer-events:auto}.lw-drawing-board.is-inline:not(.is-input-active) .lw-art-studio{display:none}
@media(max-width:900px){.lw-draw-workspace.has-conversion{grid-template-columns:1fr}.lw-conversion-panel{position:absolute;z-index:5;inset:10px;box-shadow:0 24px 80px rgba(0,0,0,.45)}.lw-draw-range span{display:none}.lw-draw-toolbar{gap:7px}.lw-canvas-surface{width:100%;height:auto}.lw-draw-workspace{padding:10px}}@media(max-width:640px){.lw-math-correction-popover{left:8px!important;width:min(390px,calc(100vw - 16px));max-height:82%;}.lw-math-correction-actions{grid-template-columns:1fr}}
@media(max-width:900px){.lw-art-studio-body{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.lw-art-control-section{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr minmax(140px,.7fr)}}
@media(max-width:640px){.lw-draw-header{padding:0 10px}.lw-draw-header-actions .lw-draw-subtle{font-size:0}.lw-draw-toolbar{min-height:54px;padding:7px 9px}.lw-segmented button{font-size:0;padding:0 9px}.lw-draw-range{grid-template-columns:70px 38px}.lw-colors>button:nth-of-type(n+5){display:none}.lw-drawing-board:not(.is-inline) .lw-draw-footer{align-items:stretch;flex-direction:column}.lw-drawing-board:not(.is-inline) .lw-draw-footer>div:first-child{display:none}.lw-footer-actions{display:grid;grid-template-columns:1fr 1fr}.lw-footer-actions button{width:100%}.lw-footer-actions>button:first-child{grid-column:1/-1}}
@media(max-width:640px){.lw-art-studio-body{grid-template-columns:1fr}.lw-art-control-section{grid-column:auto;display:flex}.lw-art-brushes{grid-template-columns:repeat(4,minmax(0,1fr))}.lw-art-special-inks{grid-template-columns:repeat(2,minmax(0,1fr))}.lw-art-quick-width{display:none}.lw-drawing-board.is-inline .lw-art-studio{width:min(900px,calc(100vw - 16px));margin-top:0}}
.lw-tablet-canvas.tool-stamp{cursor:copy}.lw-art-studio-trigger>i.is-symbol{display:grid;place-items:center;color:var(--art-ink);background:color-mix(in srgb,var(--art-ink) 10%,var(--background,#111116))}.lw-art-studio-trigger>i.is-symbol svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.18))}.lw-art-symbol-section{grid-column:1/-1}.lw-art-symbol-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px}.lw-art-symbol-heading>.lw-art-section-head{height:auto;min-width:160px;flex:1}.lw-art-symbol-categories{display:flex;align-items:center;gap:3px;padding:3px;border-radius:9px;background:color-mix(in srgb,var(--text,#fff) 4%,transparent)}.lw-art-symbol-categories button{height:24px;padding:0 8px;border:1px solid transparent;border-radius:6px;color:var(--text-muted,#999);background:transparent;font:700 7px/1 var(--ui-font,system-ui);cursor:pointer}.lw-art-symbol-categories button:hover{color:var(--text,#fff)}.lw-art-symbol-categories button.is-active{border-color:color-mix(in srgb,var(--draw-accent) 35%,transparent);color:var(--text,#fff);background:color-mix(in srgb,var(--draw-accent) 15%,transparent)}.lw-art-symbols{display:grid;grid-template-columns:repeat(auto-fit,minmax(58px,1fr));gap:4px}.lw-art-symbols>button{height:48px;display:flex;min-width:0;align-items:center;justify-content:center;flex-direction:column;gap:2px;padding:3px;border:1px solid transparent;border-radius:8px;color:var(--text-muted,#999);background:transparent;cursor:pointer}.lw-art-symbols>button:hover{color:var(--text,#fff);background:color-mix(in srgb,var(--text,#fff) 6%,transparent);transform:translateY(-1px)}.lw-art-symbols>button.is-active{border-color:color-mix(in srgb,var(--draw-accent) 52%,var(--draw-border));color:var(--accent-readable,var(--draw-accent));background:color-mix(in srgb,var(--draw-accent) 13%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--draw-accent) 10%,transparent)}.lw-art-symbols small{max-width:100%;overflow:hidden;font-size:6.5px;text-overflow:ellipsis;white-space:nowrap}.lw-art-current-stroke>span.is-symbol{height:30px;max-height:none;display:grid;flex:1;place-items:center;border-radius:6px;color:var(--art-ink);background:transparent}
@media(max-width:640px){.lw-art-symbol-heading{align-items:stretch;flex-direction:column;gap:5px}.lw-art-symbol-categories{overflow-x:auto}.lw-art-symbol-categories button{flex:1}.lw-art-symbols{grid-template-columns:repeat(4,minmax(0,1fr))}}
.lw-art-studio-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;margin:0 0 9px;padding:4px;border:1px solid var(--draw-border);border-radius:12px;background:color-mix(in srgb,var(--background,#111116) 54%,transparent)}.lw-art-studio-tabs>button{min-width:0;height:42px;display:flex;align-items:center;gap:8px;padding:0 10px;border:1px solid transparent;border-radius:9px;color:var(--text-muted,#999);background:transparent;cursor:pointer;text-align:left}.lw-art-studio-tabs>button:hover{color:var(--text,#fff);background:color-mix(in srgb,var(--text,#fff) 5%,transparent)}.lw-art-studio-tabs>button.is-active{border-color:color-mix(in srgb,var(--draw-accent) 42%,var(--draw-border));color:var(--text,#fff);background:linear-gradient(135deg,color-mix(in srgb,var(--draw-accent) 17%,transparent),color-mix(in srgb,var(--background-secondary,#18181f) 78%,transparent));box-shadow:0 5px 16px color-mix(in srgb,var(--draw-accent) 8%,transparent),inset 0 1px rgba(255,255,255,.04)}.lw-art-studio-tabs>button>svg{flex:0 0 auto;color:var(--accent-readable,var(--draw-accent))}.lw-art-studio-tabs>button>span{display:flex;min-width:0;flex-direction:column}.lw-art-studio-tabs strong{font-size:9px}.lw-art-studio-tabs small{overflow:hidden;color:var(--text-muted,#999);font-size:6.5px;text-overflow:ellipsis;white-space:nowrap}.lw-art-studio-body{grid-template-columns:minmax(0,1fr) minmax(190px,220px);align-items:stretch}.lw-art-studio-body>.lw-art-brush-section,.lw-art-studio-body>.lw-art-color-section,.lw-art-studio-body>.lw-art-symbol-section{grid-column:1;grid-row:1}.lw-art-studio-body>.lw-art-control-section{grid-column:2;grid-row:1}.lw-art-studio-body>.lw-art-symbol-section{grid-column:1}.lw-art-symbols{grid-template-columns:repeat(auto-fit,minmax(56px,1fr))}.lw-art-studio-body>section[role="tabpanel"]{animation:lw-art-tab-in .16s ease-out}@keyframes lw-art-tab-in{from{opacity:0;transform:translateY(3px)}}
.lw-art-studio-body>.lw-art-control-section{display:flex;flex-direction:column}
@media(max-width:640px){.lw-art-studio-tabs>button{height:38px;justify-content:center;padding:0 6px}.lw-art-studio-tabs>button>span small{display:none}.lw-art-studio-body{grid-template-columns:1fr}.lw-art-studio-body>.lw-art-brush-section,.lw-art-studio-body>.lw-art-color-section,.lw-art-studio-body>.lw-art-symbol-section,.lw-art-studio-body>.lw-art-control-section{grid-column:1;grid-row:auto}.lw-art-symbols{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media(prefers-reduced-motion:reduce){.lw-drawing-board *{scroll-behavior:auto!important;transition:none!important;animation-duration:.001ms!important}}
`

export default DrawingBoard
