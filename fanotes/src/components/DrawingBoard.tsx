import {
  Calculator,
  Compass,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Eraser,
  FileInput,
  LoaderCircle,
  ListChecks,
  ListCollapse,
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
  SlidersHorizontal,
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
  Fragment,
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
import { strokeDurationMs, strokeLengthMm, summarizeInkStrokes, type InkStrokeActivity, type InkSummary } from '../lib/pageStats'
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
  applyPaperZoomStayPut,
  clampViewZoom,
  clearPaperViewFromElements,
  normalizeRotation,
  readSharedZoomMax,
  readSharedZoomSpeed,
  resolvePaperViewTarget,
  resolvePaperZoomScroller,
  zoomFactorFromWheel,
  zoomStepFromSpeed,
} from '../lib/paperView'
import { usePaperViewController } from './PaperView'
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
import {
  FORM_DETECT_NOTICE_TEXT,
  SCRIBBLE_ERASE_NOTICE_TEXT,
  applyInkNoticeOp,
  inkNoticeAutoClearDelayMs,
} from '../lib/inkNotice'
import { BUG_REPORT_PEN_SAMPLE_MS, buildPenDiagnosticEvent, diagnosticLog } from '../lib/bugReport'
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
  collectPreviewInkPoints,
  inkPointOnWriteSurface,
  mapClientToPaperPoint,
  resolveInkPointerDown,
} from '../lib/inkSampleMap'
import { drawInkStroke as paintInkStroke, inkStrokeIsTranslucent, inkStrokePaintMargin } from '../lib/inkStrokePaint'
import {
  INLINE_INK_ACTIVE_CLASS,
  INK_TOOLBAR_SLOT_ID,
  FULL_INK_WINDOW,
  inkWindowLayoutStyle,
  isFullInkWindow,
  liveInkSliceLayoutStyle,
  markdownNoteInkOverlaySize,
  pdfOverlayPointFromClient,
  pdfOverlaySourceHeight,
  liveInkToolbarHost,
  portalInkToolbar,
  resolveInkToolbarHost,
  shouldSyncPdfOverlaySource,
} from '../lib/pdfInkHit'
import {
  type AuthoredInkSave,
  drawingChromeFromHit,
  inkDocumentIsOwnSave,
  inkPagePersists,
  isDrawingInkSurfaceTarget,
  overlayGlobalPointerLockOn,
  overlayHitEnabled,
  overlayInert,
} from '../lib/overlayInteract'
import {
  type InkLayoutBox,
  type InkLayoutPoint,
  type InkWindowLayout,
  type LiveInkSlice,
  inkBandWindow,
  inkWindowGuardHit,
  inkWindowShift,
  liveInkWindowHolds,
  measureVisibleInkBox,
  placeInkWindow,
  placeLiveInkWindow,
  planInkWindow,
  planLiveInkWindow,
  sameLiveInkSlice,
} from '../lib/inkWindowPlan'
import { mapClientToSheet } from '../lib/paperCanvas'
import {
  applyPenUpInkCleanup,
  applyWheelInkPolicy,
  keepGotPointerCaptureId,
  POST_PEN_IGNORE_MS,
  shouldIgnoreUnmappedPointerAfterPen,
  shouldRejectNonPenInk,
  shouldRejectNonPenInkMove,
} from '../lib/inkPointerPolicy'
import {
  tabletButtonActionFromPointer,
  tabletButtonIdentityFromPointer,
} from '../lib/tabletButtons'
import {
  type InkSection,
  type SerializedSection,
  SECTION_HEADER_PX,
  collapseSection,
  deserializeSections,
  expandSection,
  growBodyRoom,
  headerStrokeCount,
  insertSection,
  nextSectionTop,
  planBodyRoom,
  planCollapse,
  planInsertSection,
  serializeSections,
  sortSections,
} from '../lib/inkSections'
import {
  PAGE_START_WIDTH,
  SCROLL_ROOM,
  WRITE_CAP_HEIGHT,
  WRITE_CAP_WIDTH,
  WRITE_MARGIN_X,
  WRITE_MARGIN_Y,
  growPageFromMark,
  paintedStayExtent,
  savedInkPage,
  writePageStayExtent,
  keepMarkOnPage,
  mapClientToPage,
  paperScrollBoundsFromVisualRect,
  paperSheetLayoutShift,
  liveWriteStayPut,
  textOriginCssPx,
  writeExtentFromContent,
} from '../lib/noteCanvas'
import {
  paperRulingBackgroundPosition,
  paperRulingTileOrigin,
} from '../lib/paperRuling'
import {
  applyVisualGrowCorrection,
  lockPaperViewportEditorScroll,
  pinPaperViewportAfterExtentGrow,
  schedulePaperVisualGrowRefresh,
  VISUAL_GROW_REFRESH_FRAMES,
} from '../lib/paperCaretScroll'
import {
  continueLiveWriteStroke,
  growLiveInkAndMapNext,
  type PendingStaleLayoutMap,
  HAS_INK_EXTENT_CLASS,
  INK_WIDTH_ANCHOR_CLASS,
  clearInkExtentStyles,
  inkExtentStyleValues,
  inkOverlayPixelSize,
  INK_MAX_VIEW_QUALITY_ZOOM,
  INK_MIN_INLINE_QUALITY,
  inkStrokePaintScale,
  inkWidthNeedsAnchor,
  pendingGrowScale,
  resolvePaintedLayoutGrow,
} from '../lib/paperGrow'
import { DraftingGuides, type DraftingReadout } from './DraftingGuides'
import { DraftingPanel } from './DraftingPanel'
import {
  asCompassPose,
  compassCentreMarkSegments,
  compassRadiiNorm,
  defaultPoseFor,
  draftingToolLabel,
  formatArcDegrees,
  formatDegrees,
  formatHeading,
  formatLength,
  keepPoseOnSheet,
  loadDraftingSettings,
  magnetThresholdMm,
  mmToNorm,
  normToMm,
  nudgePose,
  sampleCompassArc,
  sampleCompassCircle,
  saveDraftingSettings,
  snapAngle,
  snapToDraftingTools,
  type CompassDrawEvent,
  type CompassPose,
  type DraftingDisplay,
  type DraftingKind,
  type DraftingPose,
  type DraftingSettings,
  type DraftingToolState,
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

const SOURCE_WIDTH = PAGE_START_WIDTH
const SOURCE_HEIGHT = 1273
const MAX_SOURCE_HEIGHT = WRITE_CAP_HEIGHT
const MAX_SOURCE_WIDTH = WRITE_CAP_WIDTH
const WRITE_SLACK_HEIGHT = WRITE_MARGIN_Y
const WRITE_SLACK_WIDTH = WRITE_MARGIN_X
const EXPORT_SCALE = 2
/** Fallback hold time after the last real movement to beautify a figure. */
const SHAPE_DWELL_MS = 700
const SHAPE_DWELL_HINT_MS = 260
const SHAPE_MOVE_RESET_PX = 1.8

/** Backing-store size for the ink canvases. Higher when zoomed in so CSS scale stays sharp. */
const computeInkPixelSize = (layoutWidth: number, layoutHeight: number, viewZoom: number, inlineMode: boolean) => (
  inkOverlayPixelSize(layoutWidth, layoutHeight, viewZoom, inlineMode, window.devicePixelRatio || 1)
)

type InkWindow = { y0: number; y1: number }
const inkWindowSpan = (window: InkWindow) => Math.max(0.06, Math.min(1, window.y1 - window.y0))
/** Final slice check after the last scroll event, in case scrollend never fires. */
const INK_WINDOW_IDLE_MS = 320
/**
 * A wheel zoom arrives as a burst of steps ~16–50 ms apart. The ink bitmap is
 * only re-sliced and re-rasterised once no step came for this long; in between,
 * the sheet's CSS zoom scales the existing bitmap.
 */
const ZOOM_SETTLE_MS = 160

/**
 * Visible sheet range in paper layout px. Client rects carry the plane's CSS
 * zoom, so visual scroll px and layout ink px do not get mixed: offsetTop
 * (layout px) against scrollTop (visual px) put the slice below the sheet at
 * 250% and the bottom of the page had no ink canvas at all.
 */
const measureInkWindow = (paper: HTMLElement, scroller: HTMLElement, rotation: number) => {
  const paperRect = paper.getBoundingClientRect()
  const scrollerRect = scroller.getBoundingClientRect()
  return measureVisibleInkBox({
    scrollerLeft: scrollerRect.left,
    scrollerTop: scrollerRect.top,
    scrollerWidth: scroller.clientWidth,
    scrollerHeight: scroller.clientHeight,
    paperLeft: paperRect.left,
    paperTop: paperRect.top,
    paperVisualWidth: paperRect.width,
    paperVisualHeight: paperRect.height,
    paperLayoutWidth: paper.offsetWidth,
    paperLayoutHeight: paper.offsetHeight,
    rotation,
  })
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

type InkCanvasBoxStyle = ReturnType<typeof inkWindowLayoutStyle> | ReturnType<typeof liveInkSliceLayoutStyle>

const applyInkBoxToCanvases = (canvases: Array<HTMLCanvasElement | null>, box: InkCanvasBoxStyle) => {
  for (const canvas of canvases) {
    if (!canvas) continue
    if (canvas.style.top !== box.top) canvas.style.top = box.top
    if (canvas.style.height !== box.height) canvas.style.height = box.height
    if (canvas.style.left !== box.left) canvas.style.left = box.left
    if (canvas.style.right !== box.right) canvas.style.right = box.right
    if (canvas.style.width !== box.width) canvas.style.width = box.width
    if (canvas.style.bottom !== box.bottom) canvas.style.bottom = box.bottom
  }
}

const applyInkWindowToCanvases = (
  canvases: Array<HTMLCanvasElement | null>,
  window: InkWindow,
  paper: { width: number; height: number } | null = null,
) => {
  // Pin the bitmap to the paper box inside the extra-room overlay. 0%/100%
  // fills the board (paper+2·SCROLL_ROOM) while 0–1 ink is the paper. In
  // layout px when the paper is measured: a percentage box stretches the
  // bitmap in the frame the sheet grows, before any redraw can re-place it.
  applyInkBoxToCanvases(canvases, inkWindowLayoutStyle(window, paper))
}

/**
 * The live layer covers only the visible sheet plus a guard (its own slice,
 * in layout px), or the committed slice when that is no bigger. A stroke in
 * progress is always under the pen, so nothing is lost — and the bitmap the
 * compositor has to take every frame shrinks from several viewports to
 * about one.
 */
const applyLiveInkBoxToCanvas = (
  canvas: HTMLCanvasElement | null,
  box: InkLayoutBox | null,
  window: InkWindow,
  paper: { width: number; height: number } | null = null,
) => {
  applyInkBoxToCanvases([canvas], box ? liveInkSliceLayoutStyle(box) : inkWindowLayoutStyle(window, paper))
}

/**
 * Clear the live layer. With the box of everything painted since the last
 * wipe (device px) only that area is cleared; the slice bitmap can be several
 * viewports tall, and clearing all of it after every letter costs a full
 * texture upload per pen lift.
 */
const wipeLiveInkCanvas = (
  canvas: HTMLCanvasElement | null,
  painted: { x0: number; y0: number; x1: number; y1: number } | null = null,
) => {
  if (!canvas || !canvas.width || !canvas.height) return
  const context = canvas.getContext('2d', { alpha: true })
  if (!context) return
  context.setTransform(1, 0, 0, 1, 0, 0)
  if (!painted) {
    context.clearRect(0, 0, canvas.width, canvas.height)
    return
  }
  const x0 = Math.max(0, Math.floor(painted.x0) - 1)
  const y0 = Math.max(0, Math.floor(painted.y0) - 1)
  const x1 = Math.min(canvas.width, Math.ceil(painted.x1) + 1)
  const y1 = Math.min(canvas.height, Math.ceil(painted.y1) + 1)
  if (x1 > x0 && y1 > y0) context.clearRect(x0, y0, x1 - x0, y1 - y0)
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

const isInkSurfaceTarget = (target: EventTarget | null) => isDrawingInkSurfaceTarget(target)

const elementFromPointSafe = (x: number, y: number) => {
  try {
    return document.elementFromPoint(x, y)
  } catch {
    return null
  }
}

/** Real hit under the cursor — ignores leftover pointer-capture retargeting. */
const hitTestChrome = (clientX: number, clientY: number) => (
  drawingChromeFromHit(elementFromPointSafe(clientX, clientY))
)

const clickableChromeControl = (chrome: Element) => (
  chrome.closest('button, [role="button"], [role="menuitem"], select, a, input, textarea, label')
)

const releaseStuckInputFocus = (preferred?: HTMLElement | null) => {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return
  // Keep intentional board focus (keyboard shortcuts), but never leave the
  // canvas itself focused after pen input — that traps keys/scroll on Hyprland.
  if (active.closest?.('.lw-tth-dialog, .lw-tth-backdrop')) return
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
  sourceOriginX?: number
  sourceOriginY?: number
  overlayQuality?: number
  overlayQualityZoom?: number
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
  /** Collapsible handwriting sections; hidden body ink lives inside a collapsed one. */
  sections?: SerializedSection[]
}

export type DrawingSavePayload = {
  id?: string
  title: string
  /** Generated only when a Markdown image is explicitly requested. */
  imageData?: string
  drawingJson: string
  /** What the saved layer contains, for the note's statistics. */
  inkSummary?: InkSummary
}

export type InkActivity =
  | { kind: 'stroke'; stroke: InkStrokeActivity }
  | { kind: 'erase'; removed: number }

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
    | 'tabletButtons'
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
  /** Reports finished strokes and erased strokes for the note's quiet statistics. */
  onInkActivity?: (activity: InkActivity) => void
  onTrainingChanged?: (sampleCount: number) => void
  onOpenGlyphenWerk?: () => void
  onClose?: () => void
  pagePaperStyle?: PaperStyle
  onPagePaperChange?: (style: PaperStyle) => void
  confirmDestructive?: (message: string) => Promise<boolean>
  /** Collapsible sections move ink up and down the sheet; off for PDF notes, whose ink must stay on its page. */
  sectionsEnabled?: boolean
}

type Notice = { kind: 'success' | 'error' | 'info'; text: string }

const cloneStrokes = (strokes: InkStroke[]): InkStroke[] => strokes.map((stroke) => ({
  ...stroke,
  points: stroke.points.map((point) => ({ ...point })),
}))

// Committed strokes are immutable. History can therefore share their point arrays
// instead of copying an entire page on every pen-down event.
const snapshotStrokes = (strokes: InkStroke[]): InkStroke[] => strokes.slice()

/** A failed silent autosave is retried after this pause while the page stays dirty. */
export const INK_SAVE_RETRY_DELAY_MS = 4_000
/** `flush` rewrites the page while strokes keep landing during a write, up to this many rounds. */
export const INK_FLUSH_MAX_ROUNDS = 6

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
  layoutWidth = 0,
  endSegment = stroke.points.length,
) => paintInkStroke(
  context,
  {
    ...stroke,
    symbolPaths: stroke.symbolId ? artSymbolById.get(stroke.symbolId)?.paths : undefined,
  },
  width,
  height,
  smoothing,
  startSegment,
  sourceWidth,
  layoutWidth,
  endSegment,
)

/** Bitmap-space box (paint coordinates, inclusive edges). */
type LiveInkRect = { x0: number; y0: number; x1: number; y1: number }

const unionLiveInkRect = (a: LiveInkRect | null, b: LiveInkRect | null): LiveInkRect | null => {
  if (!a) return b
  if (!b) return a
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }
}

const liveInkRectsTouch = (a: LiveInkRect, b: LiveInkRect) => (
  a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1
)

/**
 * The closing segment of a stroke (no point after it yet) curves around a
 * control point extrapolated past its start by up to this share of the
 * previous segment — outside the hull of the points themselves.
 */
const INK_CLOSING_CONTROL_REACH = .92 * .4

/**
 * Where segments `from`..`to` of a stroke (point indexes, clamped) can paint:
 * the points' box grown by the brush margin, snapped to whole bitmap px so a
 * clear and its repair meet on pixel edges. Smoothing control points stay
 * inside the hull of the neighbouring points, so include one point on each
 * side for the curve shape — plus the extrapolated control of the closing
 * segment when the range reaches it.
 */
const liveInkSegmentBox = (
  points: ReadonlyArray<{ x: number; y: number }>,
  from: number,
  to: number,
  width: number,
  height: number,
  margin: number,
): LiveInkRect | null => {
  const last = points.length - 1
  const start = Math.max(0, Math.min(from, to) - 1)
  const end = Math.min(last, Math.max(from, to) + 1)
  if (start > end) return null
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  const include = (px: number, py: number) => {
    if (px < x0) x0 = px
    if (py < y0) y0 = py
    if (px > x1) x1 = px
    if (py > y1) y1 = py
  }
  for (let index = start; index <= end; index += 1) include(points[index].x * width, points[index].y * height)
  if (end === last && last >= 2) {
    const previous = points[last - 1]
    const before = points[last - 2]
    include(
      (previous.x + (previous.x - before.x) * INK_CLOSING_CONTROL_REACH) * width,
      (previous.y + (previous.y - before.y) * INK_CLOSING_CONTROL_REACH) * height,
    )
  }
  return {
    x0: Math.floor(x0 - margin),
    y0: Math.floor(y0 - margin),
    x1: Math.ceil(x1 + margin),
    y1: Math.ceil(y1 + margin),
  }
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
  layoutWidth = 0,
  band: { y: number; height: number } | null = null,
) => {
  const context = canvas.getContext('2d')
  if (!context) return
  const span = inkWindowSpan(inkWindow)
  const virtualHeight = height / span
  const topPx = inkWindow.y0 * virtualHeight
  // A band paints only the rows a slice move exposed; the rest was copied.
  const clip = band ?? { y: 0, height }
  context.setTransform(1, 0, 0, 1, 0, 0)
  if (band) context.clearRect(0, band.y, width, band.height)
  else context.clearRect(0, 0, canvas.width, canvas.height)
  if (includePaper && !band) drawPaper(context, width, height, paperStyle)
  context.save()
  context.beginPath()
  context.rect(0, clip.y, width, clip.height)
  context.clip()
  context.setTransform(1, 0, 0, 1, 0, -topPx)
  const filter = band ? inkBandWindow(Math.round(topPx), band, virtualHeight) : inkWindow
  const visible = !band && isFullInkWindow(inkWindow) ? strokes : strokes.filter((stroke) => strokeIntersectsWindow(stroke, filter))
  visible.forEach((stroke) => drawInkStroke(context, stroke, width, virtualHeight, smoothing, 1, sourceWidth, layoutWidth))
  context.restore()
}

/**
 * Move the painted slice by whole rows: copy what is still on the sheet,
 * then paint only the exposed band from the model. `copy` compositing
 * replaces the bitmap, so nothing from the old position is left behind.
 */
const shiftInkWindowBitmap = (canvas: HTMLCanvasElement, dy: number) => {
  if (dy === 0) return
  const context = canvas.getContext('2d')
  if (!context) return
  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.globalCompositeOperation = 'copy'
  context.imageSmoothingEnabled = false
  context.drawImage(canvas, 0, dy)
  context.restore()
}

/**
 * Sheet ink is clamped to the 0–1 page. Ink hidden inside a collapsed section
 * is normalised to its own body box and may legitimately reach past it (a
 * stroke that ran into the next header), so that box is only bounded loosely.
 */
const safeInkStrokes = (value: unknown, fallbackColor: string, options: { clampToSheet?: boolean } = {}): InkStroke[] => {
  if (!Array.isArray(value)) return []
  const bound = options.clampToSheet === false
    ? (coordinate: number) => clamp(coordinate, -4, 4)
    : (coordinate: number) => clamp(coordinate)
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const raw = entry as Partial<InkStroke>
    if (!Array.isArray(raw.points)) return []
    const points = raw.points.flatMap((point) => {
      if (!point || typeof point !== 'object') return []
      return [{
        x: bound(Number(point.x) || 0),
        y: bound(Number(point.y) || 0),
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
  onInkActivity,
  onTrainingChanged,
  onOpenGlyphenWerk,
  onClose,
  pagePaperStyle,
  onPagePaperChange,
  confirmDestructive,
  sectionsEnabled = true,
}: DrawingBoardProps, forwardedRef) {
  // Controls only: the board follows the camera through refs and a
  // subscription, so a wheel zoom does not rebuild this tree on every step.
  const paperView = usePaperViewController()
  const boardRef = useRef<HTMLElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const committedCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const committedCanvasDirtyRef = useRef(true)
  const canvasPixelSizeRef = useRef({ width: 0, height: 0, virtualHeight: 0, layoutWidth: 0, layoutHeight: 0, topPx: 0 })
  /** Paint-time slice as paper fractions; derived from inkWindowLayoutRef in redraw. */
  const inkWindowRef = useRef<InkWindow>(FULL_INK_WINDOW)
  /** The slice in paper layout px (null = whole sheet). Page growth does not move it. */
  const inkWindowLayoutRef = useRef<InkWindowLayout | null>(null)
  const inkWindowViewportRef = useRef(0)
  /** Live-layer slice in paper layout px (null = same box as the committed slice). */
  const liveWindowLayoutRef = useRef<InkLayoutBox | null>(null)
  /** Applied live bitmap: size and offset in the sheet's paint space (bitmap px). */
  const liveSliceRef = useRef<LiveInkSlice | null>(null)
  /** Pen sample (layout px) the next live-slice plan should keep covered. */
  const livePenHintRef = useRef<InkLayoutPoint | null>(null)
  /** What the committed bitmap holds right now, so a slice move can reuse it. */
  const committedBitmapRef = useRef<{ key: string; topPx: number } | null>(null)
  const inkWindowIdleRef = useRef<number | null>(null)
  const inkScrollFrameRef = useRef<number | null>(null)
  const resizeDebounceRef = useRef<number | null>(null)
  const resizeDirtyRef = useRef(false)
  const canvasQualityKeyRef = useRef('')
  const pointerBoundsRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null)
  const viewZoomRef = useRef(1)
  /** Wall-clock until which a zoom gesture counts as still moving. */
  const zoomInFlightUntilRef = useRef(0)
  const zoomSettleTimerRef = useRef<number | null>(null)
  const zoomInFlight = useCallback(() => performance.now() < zoomInFlightUntilRef.current, [])
  const viewRotationRef = useRef(0)
  const viewPanRef = useRef({ x: 0, y: 0 })
  const sourceHeightRef = useRef(WRITE_SLACK_HEIGHT)
  const sourceWidthRef = useRef(SOURCE_WIDTH)
  const sourceOriginXRef = useRef(0)
  const sourceOriginYRef = useRef(0)
  const visualGrowFrameRef = useRef<number | null>(null)
  const paintedLayoutRef = useRef({ w: 0, h: 0 })
  const pendingStaleLayoutRef = useRef<PendingStaleLayoutMap | null>(null)
  const inkExtentPaperRef = useRef<HTMLElement | null>(null)
  const pendingGrowRemapRef = useRef<{
    prevH: number
    nextH: number
    prevW: number
    nextW: number
    prevLayoutH: number
    prevLayoutW: number
  } | null>(null)
  const commitPendingGrowRemapRef = useRef<(layoutW: number, layoutH: number) => boolean>(() => false)
  const applyInkExtentStylesRef = useRef<(height: number, width: number) => void>(() => {})
  const catchUpPaintedLayoutRef = useRef<() => boolean>(() => false)

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
  const liveCanvasHasInkRef = useRef(false)
  // Paint-space box of last frame's volatile tail (the newest segment plus the
  // predicted continuation). It is cleared and repaired before the next paint.
  const liveVolatileRectRef = useRef<LiveInkRect | null>(null)
  // Device-space box of everything on the live layer since the last wipe.
  const liveInkBoundsRef = useRef<LiveInkRect | null>(null)
  // Point count and prediction presence of the last live paint: an input
  // event that added nothing (all samples filtered) needs no repaint.
  const liveTailRef = useRef<{ count: number; predicted: boolean }>({ count: 0, predicted: false })
  const lastPenContactRef = useRef(0)
  const tabletPanRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  const undoNowRef = useRef<() => void>(() => {})
  const redoNowRef = useRef<() => void>(() => {})
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
  const saveRetryTimerRef = useRef<number | null>(null)
  const createdAtRef = useRef(new Date().toISOString())
  const initialColorRef = useRef(settings.penColor)
  const drawingIdRef = useRef(drawingId)
  const loadedDrawingIdRef = useRef<string | null | undefined>(undefined)
  /** The last snapshot this board wrote; the session echoes it back after the save. */
  const authoredSaveRef = useRef<AuthoredInkSave | null>(null)
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
  const [sourceHeight, setSourceHeight] = useState(WRITE_SLACK_HEIGHT)
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
  useEffect(() => {
    const delay = inkNoticeAutoClearDelayMs(notice)
    if (delay == null) return undefined
    const timer = window.setTimeout(() => {
      setNotice((current) => applyInkNoticeOp({
        notice: current,
        clearAt: inkNoticeAutoClearDelayMs(current) == null ? null : 0,
      }, { type: 'tick', now: Date.now() }).notice)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [notice])
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
  /** Collapsible sections, kept sorted by header top. The ref is what callbacks read; the state renders the bands. */
  const sectionsRef = useRef<InkSection<InkStroke>[]>([])
  const [sections, setSections] = useState<InkSection<InkStroke>[]>([])
  /** The next tap on the sheet inserts a section header there. */
  const [sectionPlacing, setSectionPlacing] = useState(false)
  const sectionPlacingRef = useRef(false)
  sectionPlacingRef.current = sectionPlacing
  const sectionGuideRef = useRef<HTMLDivElement | null>(null)
  const [selectionPurpose, setSelectionPurpose] = useState<SelectionPurpose>('conversion')
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null)
  const [rulerPose, setRulerPose] = useState<DraftingPose | null>(null)
  const [setSquarePose, setSetSquarePose] = useState<DraftingPose | null>(null)
  const [compassPose, setCompassPose] = useState<CompassPose | null>(null)
  const [inkToolbarHost, setInkToolbarHost] = useState<HTMLElement | null>(null)
  const [draftingReadout, setDraftingReadout] = useState<DraftingReadout | null>(null)
  const [draftingSettings, setDraftingSettings] = useState<DraftingSettings>(() => loadDraftingSettings())
  const [activeDraftingKind, setActiveDraftingKind] = useState<DraftingKind | null>(null)
  const rulerPoseRef = useRef<DraftingPose | null>(null)
  const setSquarePoseRef = useRef<DraftingPose | null>(null)
  const compassPoseRef = useRef<CompassPose | null>(null)
  const draftingLockRef = useRef<{ kind: DraftingKind; edgeIndex: number } | null>(null)
  const draftingReadoutRef = useRef<DraftingReadout | null>(null)
  const draftingReadoutAtRef = useRef(0)
  const draftingSettingsRef = useRef(draftingSettings)
  const activeDraftingKindRef = useRef<DraftingKind | null>(null)
  const lastDiagnosticAtRef = useRef(0)
  rulerPoseRef.current = rulerPose
  setSquarePoseRef.current = setSquarePose
  compassPoseRef.current = compassPose
  draftingSettingsRef.current = draftingSettings
  activeDraftingKindRef.current = activeDraftingKind

  const updateDraftingSettings = useCallback((patch: Partial<DraftingSettings>) => {
    setDraftingSettings((current) => {
      const next = { ...current, ...patch }
      saveDraftingSettings(next)
      return next
    })
  }, [])

  /** One setter for all three tools; keeps the refs in step so pointer code sees the pose immediately. */
  const setDraftingPose = useCallback((kind: DraftingKind, pose: DraftingPose | null) => {
    if (kind === 'ruler') {
      rulerPoseRef.current = pose
      setRulerPose(pose)
    } else if (kind === 'setSquare') {
      setSquarePoseRef.current = pose
      setSetSquarePose(pose)
    } else {
      const next = pose ? asCompassPose(pose) : null
      compassPoseRef.current = next
      setCompassPose(next)
    }
    if (!pose && activeDraftingKindRef.current === kind) {
      activeDraftingKindRef.current = null
      setActiveDraftingKind(null)
    }
  }, [])

  const draftingPoseOf = useCallback((kind: DraftingKind): DraftingPose | null => (
    kind === 'ruler' ? rulerPoseRef.current : kind === 'setSquare' ? setSquarePoseRef.current : compassPoseRef.current
  ), [])

  useLayoutEffect(() => {
    if (!inline || !inputActive) {
      setInkToolbarHost(null)
      return
    }
    const sync = () => {
      const next = liveInkToolbarHost(
        resolveInkToolbarHost<HTMLElement>(document)
        ?? document.getElementById(INK_TOOLBAR_SLOT_ID),
      )
      setInkToolbarHost((current) => liveInkToolbarHost(current) === next ? current : next)
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
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
    // The host guards note switches and the window close with this flag. A
    // page that has nothing to write (no strokes, no record: only its extent
    // followed the layout) must not keep those waiting on a save that never runs.
    onDirtyChange?.(dirty && inkPagePersists(strokesRef.current.length, Boolean(drawingIdRef.current) || loadedDrawingIdRef.current !== undefined))
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

  /**
   * Paint the active stroke onto the live layer incrementally.
   *
   * Every segment whose smoothing neighbour is known is painted exactly once,
   * in its final shape. The newest segment (its neighbour is still unknown)
   * and the predicted continuation form a volatile tail: their box is
   * remembered, cleared before the next paint (clipped, so nothing outside
   * is touched) and the permanent segments underneath are repainted. This
   * replaces clearing the whole slice bitmap and re-stroking the whole stroke
   * on every frame — which grew with the length of the word being written.
   *
   * `activeRenderedPointCountRef` = 0 means the bitmap must be replaced
   * (new stroke, or a remeasure/slice move made the old pixels stale).
   */
  const paintLiveInk = useCallback((
    context: CanvasRenderingContext2D,
    stroke: InkStroke,
    previewPoints: ReadonlyArray<Pick<StrokePoint, 'x' | 'y' | 'pressure'>>,
  ) => {
    const { width: pixelWidth, height: pixelHeight, virtualHeight, layoutWidth, topPx } = canvasPixelSizeRef.current
    if (!pixelWidth || !pixelHeight || !virtualHeight) return false
    if (!stroke.points.length) return true
    // The live bitmap is a slice of the sheet's paint space (pixelWidth ×
    // virtualHeight): its own when it is smaller than the committed slice,
    // else the committed one.
    const slice = liveSliceRef.current
    const paintLeft = slice?.leftPx ?? 0
    const paintTop = slice?.topPx ?? topPx
    const liveWidth = slice?.width ?? pixelWidth
    const liveHeight = slice?.height ?? pixelHeight
    const smoothing = settings.smoothing
    const sourceWidthNow = sourceWidthRef.current
    const margin = inkStrokePaintMargin(
      { ...stroke, symbolPaths: stroke.symbolId ? artSymbolById.get(stroke.symbolId)?.paths : undefined },
      inkStrokePaintScale(pixelWidth, layoutWidth > 1 ? layoutWidth : sourceWidthNow),
    )
    const toDevice = (rect: LiveInkRect): LiveInkRect => ({
      x0: rect.x0 - paintLeft,
      y0: rect.y0 - paintTop,
      x1: rect.x1 - paintLeft,
      y1: rect.y1 - paintTop,
    })
    const remember = (rect: LiveInkRect | null) => {
      if (rect) liveInkBoundsRef.current = unionLiveInkRect(liveInkBoundsRef.current, toDevice(rect))
    }
    const rendered = activeRenderedPointCountRef.current
    if (
      rendered !== 0
      && liveTailRef.current.count === stroke.points.length
      && !liveTailRef.current.predicted
      && !previewPoints.length
    ) return true
    liveTailRef.current = { count: stroke.points.length, predicted: previewPoints.length > 0 }
    context.imageSmoothingEnabled = false
    if (!stroke.symbolId && inkStrokeIsTranslucent(stroke)) {
      // A see-through brush is composited once per paint (inkStrokePaint), so
      // the live layer repaints the whole stroke each frame. Appending a tail
      // would cover the joint twice and band the marker at every sample.
      context.setTransform(1, 0, 0, 1, 0, 0)
      if (liveCanvasHasInkRef.current) {
        const bounds = rendered === 0 ? null : liveInkBoundsRef.current
        if (bounds) context.clearRect(bounds.x0, bounds.y0, bounds.x1 - bounds.x0, bounds.y1 - bounds.y0)
        else context.clearRect(0, 0, liveWidth, liveHeight)
      }
      liveInkBoundsRef.current = null
      liveVolatileRectRef.current = null
      const whole: InkStroke = previewPoints.length
        ? { ...stroke, points: [...stroke.points, ...previewPoints as StrokePoint[]] }
        : stroke
      context.setTransform(1, 0, 0, 1, -paintLeft, -paintTop)
      drawInkStroke(context, whole, pixelWidth, virtualHeight, smoothing, 1, sourceWidthNow, layoutWidth)
      remember(liveInkSegmentBox(whole.points, 0, whole.points.length - 1, pixelWidth, virtualHeight, margin))
      activeRenderedPointCountRef.current = Math.max(1, stroke.points.length)
      liveCanvasHasInkRef.current = true
      return true
    }
    // replaceLive: predicted points and remeasures never overdraw a stale
    // bitmap — what they painted last frame is cleared before painting again.
    const replaceLive = rendered === 0
    if (replaceLive) {
      if (liveCanvasHasInkRef.current) {
        context.setTransform(1, 0, 0, 1, 0, 0)
        context.clearRect(0, 0, liveWidth, liveHeight)
      }
      liveInkBoundsRef.current = null
      liveVolatileRectRef.current = null
    } else if (liveVolatileRectRef.current) {
      const volatile = liveVolatileRectRef.current
      liveVolatileRectRef.current = null
      context.save()
      context.setTransform(1, 0, 0, 1, -paintLeft, -paintTop)
      context.beginPath()
      context.rect(volatile.x0, volatile.y0, volatile.x1 - volatile.x0, volatile.y1 - volatile.y0)
      context.clip()
      context.clearRect(volatile.x0, volatile.y0, volatile.x1 - volatile.x0, volatile.y1 - volatile.y0)
      // Restore the permanent segments the tail was painted over. Segment i
      // joins points i-1 and i; runs of touching segments paint in one call.
      let runStart = -1
      for (let segment = 1; segment <= rendered; segment += 1) {
        const touches = segment < rendered
          && liveInkRectsTouch(volatile, liveInkSegmentBox(stroke.points, segment - 1, segment, pixelWidth, virtualHeight, margin)!)
        if (touches && runStart < 0) runStart = segment
        if (!touches && runStart >= 0) {
          drawInkStroke(context, stroke, pixelWidth, virtualHeight, smoothing, runStart, sourceWidthNow, layoutWidth, segment)
          runStart = -1
        }
      }
      context.restore()
    }
    context.setTransform(1, 0, 0, 1, -paintLeft, -paintTop)
    const count = stroke.points.length
    // Segments below permanentEnd have their smoothing neighbour and are final.
    const permanentEnd = Math.max(1, count - 1)
    const startSegment = Math.max(1, activeRenderedPointCountRef.current)
    if (permanentEnd > startSegment) {
      drawInkStroke(context, stroke, pixelWidth, virtualHeight, smoothing, startSegment, sourceWidthNow, layoutWidth, permanentEnd)
      remember(liveInkSegmentBox(stroke.points, startSegment - 1, permanentEnd - 1, pixelWidth, virtualHeight, margin))
    }
    activeRenderedPointCountRef.current = permanentEnd
    // Volatile tail: the newest segment (or the single dot of a fresh stroke)
    // plus the predicted continuation.
    const preview: InkStroke = previewPoints.length
      ? { ...stroke, points: [...stroke.points, ...previewPoints as StrokePoint[]] }
      : stroke
    const tailStart = Math.max(1, count - 1)
    if (preview.points.length === 1) {
      drawInkStroke(context, preview, pixelWidth, virtualHeight, smoothing, 1, sourceWidthNow, layoutWidth)
      liveVolatileRectRef.current = liveInkSegmentBox(preview.points, 0, 0, pixelWidth, virtualHeight, margin)
    } else {
      drawInkStroke(context, preview, pixelWidth, virtualHeight, smoothing, tailStart, sourceWidthNow, layoutWidth)
      liveVolatileRectRef.current = liveInkSegmentBox(preview.points, tailStart - 1, preview.points.length - 1, pixelWidth, virtualHeight, margin)
    }
    remember(liveVolatileRectRef.current)
    liveCanvasHasInkRef.current = true
    return true
  }, [settings.smoothing])

  const wipeLiveInk = useCallback(() => {
    wipeLiveInkCanvas(canvasRef.current, liveInkBoundsRef.current)
    liveInkBoundsRef.current = null
    liveVolatileRectRef.current = null
    liveCanvasHasInkRef.current = false
  }, [])

  const redraw = useCallback((measureLayout = false) => {
    const canvas = canvasRef.current
    const committedCanvas = committedCanvasRef.current
    const surface = surfaceRef.current
    if (!canvas || !committedCanvas || !surface) return
    const shell = surface.parentElement
    // Standalone tablet board: fit an A4 box in the shell. Inline overlay
    // must fill the paper — A4-aspect sizing on a tall PDF collapses to a
    // strip (hairline / no hit on the note).
    if (inline) {
      const paper = surface.closest('.unified-paper') as HTMLElement | null
      const plane = (surface.closest('.paper-sheet-plane') ?? paper?.closest('.paper-sheet-plane')) as HTMLElement | null
      markdownNoteInkOverlaySize(
        { width: boardRef.current?.offsetWidth ?? 0, height: boardRef.current?.offsetHeight ?? 0 },
        { width: paper?.offsetWidth ?? 0, height: paper?.offsetHeight ?? 0 },
        { width: plane?.offsetWidth ?? 0, height: plane?.offsetHeight ?? 0 },
      )
      if (
        paper
        && (surface.offsetWidth < 8 || surface.offsetHeight < 8)
        && paper.offsetWidth > 8
        && paper.offsetHeight > 8
      ) {
        surface.style.width = `${paper.offsetWidth}px`
        surface.style.height = `${paper.offsetHeight}px`
      }
    } else if ((measureLayout || !canvasPixelSizeRef.current.width) && shell) {
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
    const paper = inline ? (surface.closest('.unified-paper') as HTMLElement | null) : null
    const layoutWidth = paper?.offsetWidth || surface.offsetWidth || surface.clientWidth
    const layoutHeight = paper?.offsetHeight || surface.offsetHeight || surface.clientHeight
    if (layoutWidth <= 0 || layoutHeight <= 0) return
    // Paint only 0–1 of this sheet. The resize observer rescales the strokes
    // after a debounce; a redraw before it (a scroll re-slice, a state change,
    // the effect that added a text line) painted 0–1 of the previous sheet on
    // the grown one, and the ink slid down until the observer put it back.
    if (paper && !activeStrokeRef.current) catchUpPaintedLayoutRef.current()
    // The slice is planned in layout px (inkWindowLayoutRef); here it becomes
    // the CSS box, the bitmap size and the paint translate — all in one
    // synchronous pass, so no frame can show the bitmap at a stale box.
    const layoutWindow = inline ? inkWindowLayoutRef.current : null
    const liveLayout = inline ? liveWindowLayoutRef.current : null
    const windowLayoutHeight = Math.max(1, layoutWindow ? Math.min(layoutHeight, layoutWindow.height) : layoutHeight)
    const qualityKey = [
      Math.round(layoutWidth),
      Math.round(layoutHeight),
      Math.round(windowLayoutHeight),
      layoutWindow ? Math.round(layoutWindow.top) : 'full',
      liveLayout ? [liveLayout.left, liveLayout.top, liveLayout.width, liveLayout.height].map(Math.round).join(',') : 'shared',
      viewZoomRef.current.toFixed(2),
      (window.devicePixelRatio || 1).toFixed(2),
      inline ? 'i' : 'f',
    ].join(':')
    const shouldRemeasure = measureLayout
      || !canvasPixelSizeRef.current.width
      || canvasQualityKeyRef.current !== qualityKey
    // Box, bitmap size and paint offset of both canvases from the planned
    // slices. The live layer gets its own (smaller) slice when one is planned.
    const placeCanvases = () => {
      const nextSize = computeInkPixelSize(layoutWidth, windowLayoutHeight, viewZoomRef.current, inline)
      const placed = placeInkWindow(layoutWindow, layoutHeight, nextSize.height)
      const moved = placed.topPx !== canvasPixelSizeRef.current.topPx
      inkWindowRef.current = placed.window
      canvasPixelSizeRef.current = {
        width: nextSize.width,
        height: nextSize.height,
        virtualHeight: placed.virtualHeight,
        layoutWidth,
        layoutHeight,
        topPx: placed.topPx,
      }
      canvasQualityKeyRef.current = qualityKey
      const paperBox = inline ? { width: layoutWidth, height: layoutHeight } : null
      applyInkWindowToCanvases([committedCanvas], placed.window, paperBox)
      const live = liveLayout
        ? placeLiveInkWindow(liveLayout, { width: layoutWidth, height: layoutHeight }, { width: nextSize.width, height: placed.virtualHeight })
        : null
      const liveMoved = !sameLiveInkSlice(liveSliceRef.current, live?.slice ?? null)
      liveSliceRef.current = live?.slice ?? null
      applyLiveInkBoxToCanvas(canvas, live?.box ?? null, placed.window, paperBox)
      return moved || liveMoved
    }
    // Page growth and slice moves force measureLayout=true and apply even
    // mid-stroke (the live stroke is repainted whole); pure zoom waits for
    // the pen to lift.
    if (shouldRemeasure && (measureLayout || !activeStrokeRef.current)) {
      const moved = placeCanvases()
      if (activeStrokeRef.current && (moved || liveCanvasHasInkRef.current)) {
        // Force a full live-canvas replace so a remesure cannot overdraw the
        // previous bitmap (that leftover is the "ghost copy" of the writing).
        activeRenderedPointCountRef.current = 0
        liveCanvasHasInkRef.current = true
      }
    } else if (!canvasPixelSizeRef.current.width) {
      placeCanvases()
    }
    const inkWindow = inkWindowRef.current
    const { width: pixelWidth, height: pixelHeight, virtualHeight, layoutWidth: paintLayoutWidth, topPx } = canvasPixelSizeRef.current
    if (!pixelWidth || !pixelHeight || !virtualHeight) return
    const liveWidth = liveSliceRef.current?.width ?? pixelWidth
    const liveHeight = liveSliceRef.current?.height ?? pixelHeight
    const liveCanvasResized = canvas.width !== liveWidth || canvas.height !== liveHeight
    if (canvas.width !== liveWidth) canvas.width = liveWidth
    if (canvas.height !== liveHeight) canvas.height = liveHeight
    if (liveCanvasResized) {
      activeRenderedPointCountRef.current = 0
      liveCanvasHasInkRef.current = false
      // Chromium backs a fresh canvas lazily on its first draw call; a
      // viewport-sized live bitmap costs several ms. Pay that here, in the
      // layout pass, so the first pen-down sample paints immediately.
      const fresh = canvas.getContext('2d', { alpha: true })
      if (fresh) {
        fresh.setTransform(1, 0, 0, 1, 0, 0)
        fresh.clearRect(0, 0, 1, 1)
      }
    }
    const committedResized = committedCanvas.width !== pixelWidth || committedCanvas.height !== pixelHeight
    if (committedCanvas.width !== pixelWidth) committedCanvas.width = pixelWidth
    if (committedCanvas.height !== pixelHeight) committedCanvas.height = pixelHeight
    if (committedResized) committedBitmapRef.current = null

    // Content the committed bitmap depends on. The slice top is not part of
    // it: a move at the same size copies the bitmap and paints only the new
    // rows. Nor is the sheet height: a bottom grow rescales 0–1 ink by the
    // same factor as the paint height, so every row stays where it is — as
    // long as the rows per layout px hold, which the pixel budget can change
    // on a tall sheet. Gradient inks anchor to the paint height, so they do
    // force a repaint.
    const gradientInk = strokesRef.current.some((stroke) => stroke.colorEffect && stroke.colorEffect !== 'solid')
    const contentKey = [
      pixelWidth,
      pixelHeight,
      (pixelHeight / windowLayoutHeight).toFixed(5),
      paperStyle,
      settings.smoothing,
      paintLayoutWidth || layoutWidth,
      inline,
      gradientInk ? Math.round(virtualHeight) : 0,
    ].join(':')
    const held = committedBitmapRef.current
    const shift = held && !committedCanvasDirtyRef.current && held.key === contentKey
      ? inkWindowShift(held.topPx, topPx, pixelHeight)
      : null
    if (shift) {
      if (shift.dy !== 0) {
        shiftInkWindowBitmap(committedCanvas, shift.dy)
        renderDocument(
          committedCanvas,
          strokesRef.current,
          paperStyle,
          settings.smoothing,
          pixelWidth,
          pixelHeight,
          false,
          sourceWidth,
          inkWindow,
          paintLayoutWidth || layoutWidth,
          shift.band,
        )
        committedBitmapRef.current = { key: contentKey, topPx }
      }
    } else {
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
        paintLayoutWidth || layoutWidth,
      )
      committedBitmapRef.current = { key: contentKey, topPx }
      committedCanvasDirtyRef.current = false
    }

    const context = canvas.getContext('2d', { alpha: true })
    if (!context) return
    context.imageSmoothingEnabled = !activeStrokeRef.current
    context.imageSmoothingQuality = activeStrokeRef.current ? 'low' : 'high'
    const activeStroke = activeStrokeRef.current
    if (!activeStroke) {
      // Nothing live: the layer is already blank unless something painted
      // since the last wipe — clearing a multi-viewport bitmap is not free.
      if (liveCanvasHasInkRef.current) {
        context.setTransform(1, 0, 0, 1, 0, 0)
        context.clearRect(0, 0, canvas.width, canvas.height)
      }
      activeRenderedPointCountRef.current = 0
      liveCanvasHasInkRef.current = false
      liveInkBoundsRef.current = null
      liveVolatileRectRef.current = null
      return
    }
    paintLiveInk(context, activeStroke, [])
  }, [inline, paintLiveInk, paperStyle, settings.smoothing, sourceHeight, sourceWidth])

  const onInkActivityRef = useRef(onInkActivity)
  onInkActivityRef.current = onInkActivity

  /** Every path that adds a finished stroke to the page passes through here. */
  const noteStrokeDrawn = useCallback((stroke: InkStroke) => {
    const report = onInkActivityRef.current
    if (!report) return
    const width = sourceWidthRef.current
    const height = sourceHeightRef.current
    report({
      kind: 'stroke',
      stroke: {
        durationMs: strokeDurationMs(stroke),
        lengthMm: strokeLengthMm(stroke, width, height),
        points: stroke.points.length,
        purpose: stroke.purpose === 'art' ? 'art' : 'handwriting',
        color: stroke.color,
        brush: stroke.purpose === 'art' ? stroke.brush ?? 'art' : 'pen',
      },
    })
  }, [])

  const noteStrokesErased = useCallback((removed: number) => {
    if (removed > 0) onInkActivityRef.current?.({ kind: 'erase', removed })
  }, [])

  const commitStrokeToCanvas = useCallback((stroke: InkStroke) => {
    noteStrokeDrawn(stroke)
    const canvas = committedCanvasRef.current
    const { width, height, virtualHeight, layoutWidth } = canvasPixelSizeRef.current
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
    drawInkStroke(context, stroke, width, virtualHeight, settings.smoothing, 1, sourceWidth, layoutWidth)
    context.restore()
  }, [noteStrokeDrawn, settings.smoothing, sourceWidth])

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
    if (inkDocumentIsOwnSave(authoredSaveRef.current, sourceId, initialDrawingJson)) {
      // The first save gives a new page its id; the session then hands that
      // snapshot back. The live strokes are already ahead of it (an erase
      // during the save must not be undone by it), so it is only acknowledged.
      loadedDrawingIdRef.current = sourceId
      if (sourceId) drawingIdRef.current = sourceId
      return
    }
    try {
      const document: unknown = JSON.parse(initialDrawingJson)
      if (!document || typeof document !== 'object') throw new Error('Kein Zeichnungsobjekt')
      const raw = document as Partial<DrawingDocument>
      strokesRef.current = safeInkStrokes(raw.strokes, initialColorRef.current)
      const loadedSections = deserializeSections<InkStroke>(raw.sections, (value) => safeInkStrokes(value, initialColorRef.current, { clampToSheet: false }))
      sectionsRef.current = loadedSections
      setSections(loadedSections)
      setSectionPlacing(false)
      if (!pagePaperStyle && raw.paperStyle && raw.paperStyle in paperLabel) setPaperStyle(raw.paperStyle)
      if (typeof raw.sourceHeight === 'number' && raw.sourceHeight >= WRITE_SLACK_HEIGHT && raw.sourceHeight <= MAX_SOURCE_HEIGHT) {
        sourceHeightRef.current = raw.sourceHeight
        setSourceHeight(raw.sourceHeight)
      }
      if (typeof raw.sourceWidth === 'number' && raw.sourceWidth >= WRITE_SLACK_WIDTH && raw.sourceWidth <= MAX_SOURCE_WIDTH) {
        sourceWidthRef.current = raw.sourceWidth
        setSourceWidth(raw.sourceWidth)
      }
      if (typeof raw.sourceOriginX === 'number' && Number.isFinite(raw.sourceOriginX) && raw.sourceOriginX >= 0) {
        sourceOriginXRef.current = raw.sourceOriginX
      }
      if (typeof raw.sourceOriginY === 'number' && Number.isFinite(raw.sourceOriginY) && raw.sourceOriginY >= 0) {
        sourceOriginYRef.current = raw.sourceOriginY
      }
      // Saved 0–1 ink is relative to the saved page. The sheet takes that
      // page now — before the next redraw measures it — and a grow that
      // follows (fit to ink, sheet larger than the page) remaps from that
      // box, not from whatever this board measured before the document came.
      paintedLayoutRef.current = { w: sourceWidthRef.current, h: sourceHeightRef.current }
      pendingGrowRemapRef.current = null
      pendingStaleLayoutRef.current = null
      applyInkExtentStylesRef.current(sourceHeightRef.current, sourceWidthRef.current)
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
      sectionsRef.current = []
      setSections([])
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
      ? ((canvas?.closest('.unified-paper') as HTMLElement | null)
        ?? (surfaceRef.current)
        ?? (canvas?.closest('.lw-canvas-surface') as HTMLElement | null))
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
      : (inline
        ? mapClientToSheet(event, surface, viewRotationRef.current)
        : mapClientToPaperPoint(event, surface, viewRotationRef.current))
    if (!mapped) {
      const fallback = inline ? mapClientToPage(event.clientX, event.clientY, surface) : null
      if (!fallback) return null
      mapped = {
        x: fallback.x,
        y: fallback.y,
        t: Math.round((event.timeStamp ?? 0) * 100) / 100,
        pressure: (event.pressure ?? 0) > 0 ? event.pressure : event.pointerType === 'mouse' ? 0.55 : 0.35,
        tiltX: event.tiltX ?? 0,
        tiltY: event.tiltY ?? 0,
        pointerType: event.pointerType || 'mouse',
      }
    }
    if (inline && mapped) {
      const paper = originEl.closest('.unified-paper') as HTMLElement | null
      if (paper?.classList.contains('is-pdf-note')) {
        const pages = Array.from(paper.querySelectorAll('[data-pdf-page]')).map((node) => {
          const box = (node as HTMLElement).getBoundingClientRect()
          return { top: box.top, height: box.height }
        })
        const overlayHit = pdfOverlayPointFromClient(event.clientX, event.clientY, surface, pages)
        if (overlayHit) {
          mapped = { ...mapped, x: overlayHit.x, y: overlayHit.y }
        }
      }
    }

    const width = Math.max(1, canvas?.offsetWidth ?? originEl.offsetWidth)
    const height = Math.max(1, canvas?.offsetHeight ?? originEl.offsetHeight)
    const paperW = Math.max(1, originEl.offsetWidth)
    const paperH = Math.max(1, originEl.offsetHeight)
    const surfacePoint = inkPointOnWriteSurface(mapped, surface, { width, height })
    if (!surfacePoint) return null
    // Inline: 0–1 of the overlay surface. Never rescale by a windowed bitmap
    // (that mapped PDF page 2 onto page 1). Standalone board still uses the canvas.
    let x = inline ? surfacePoint.x : clamp(surfacePoint.x * paperW / width)
    let y = inline ? surfacePoint.y : clamp(surfacePoint.y * paperH / height)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    const guides: DraftingToolState[] = []
    if (rulerPoseRef.current) guides.push({ kind: 'ruler', pose: rulerPoseRef.current })
    if (setSquarePoseRef.current) guides.push({ kind: 'setSquare', pose: setSquarePoseRef.current })
    if (compassPoseRef.current) guides.push({ kind: 'compass', pose: compassPoseRef.current })
    if (guides.length && !selectionStartRef.current && gestureToolRef.current !== 'eraser') {
      const drafting = draftingSettingsRef.current
      const snapped = snapToDraftingTools(
        x,
        y,
        guides,
        sourceWidthRef.current,
        sourceHeightRef.current,
        draftingLockRef.current,
        { width: paperW, height: paperH },
        { thresholdMm: magnetThresholdMm(drafting.magnet) },
      )
      if (snapped) {
        x = snapped.x
        y = snapped.y
        draftingLockRef.current = { kind: snapped.kind, edgeIndex: snapped.edgeIndex }
        // The Geodreieck base reads from its centre mark, so that reading carries a sign.
        const centred = snapped.kind === 'setSquare' && snapped.edgeIndex === 0
        const text = snapped.kind === 'compass'
          ? `${draftingToolLabel('compass')} · r ${formatLength(snapped.millimetres, drafting.unit)} · ${formatHeading(snapped.angle)}`
          : `${draftingToolLabel(snapped.kind)} · ${formatLength(snapped.millimetres, drafting.unit, centred)} · ${formatDegrees(snapped.angle)}`
        const now = performance.now()
        const previous = draftingReadoutRef.current
        // A React render per pen sample is too dear while inking: refresh the
        // bubble when the reading changes and otherwise a few times a second.
        if (!previous || previous.text !== text || now - draftingReadoutAtRef.current > 90) {
          const nextReadout = { text, x, y }
          draftingReadoutRef.current = nextReadout
          draftingReadoutAtRef.current = now
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

  /**
   * Plan the ink slice for the current camera without painting. Returns true
   * when the slice changed and the canvases need a synchronous redraw(true).
   */
  const planInkWindowNow = useCallback((force = false) => {
    const current = inkWindowLayoutRef.current
    const currentLive = liveWindowLayoutRef.current
    const pen = livePenHintRef.current
    livePenHintRef.current = null
    if (!inline) {
      inkWindowLayoutRef.current = null
      liveWindowLayoutRef.current = null
      return current !== null || currentLive !== null
    }
    const paper = resolvePaperElement()
    const scroller = paper?.closest('.unified-note-view') as HTMLElement | null
    const measured = paper && scroller ? measureInkWindow(paper, scroller, viewRotationRef.current) : null
    if (!paper || !measured) {
      inkWindowLayoutRef.current = null
      liveWindowLayoutRef.current = null
      return current !== null || currentLive !== null
    }
    inkWindowViewportRef.current = measured.viewport.height
    const plan = planInkWindow({
      paperHeight: paper.offsetHeight,
      viewportHeight: measured.viewport.height,
      visible: measured.visible,
      current,
      force,
    })
    // The live slice is planned from the same measurement, so a scroll that
    // moves neither costs nothing beyond the two rects.
    const livePlan = planLiveInkWindow({
      paper: { width: paper.offsetWidth, height: paper.offsetHeight },
      viewport: measured.viewport,
      visible: measured.visible,
      current: currentLive,
      pen,
      force,
    })
    if (livePlan.changed) liveWindowLayoutRef.current = livePlan.window
    if (!plan.changed) return livePlan.changed
    inkWindowLayoutRef.current = plan.window
    return true
  }, [inline, resolvePaperElement])

  /**
   * Move the ink slice with the camera. Box, bitmap and paint change in this
   * same call — a scheduled redraw left one frame with the old bitmap at the
   * new box, which is the "ink jumps, then comes back" the user saw on scroll.
   */
  const syncInkWindow = useCallback((force = false) => {
    if (!planInkWindowNow(force)) return false
    canvasQualityKeyRef.current = ''
    redraw(true)
    return true
  }, [planInkWindowNow, redraw])

  /**
   * Visits every stroke point the board still holds — live strokes, the stroke
   * under the pen, undo and redo snapshots, the gesture snapshot and a pending
   * solver tap — exactly once. Snapshots share point objects with the live
   * strokes, but a stroke that was erased (or undone) lives only in history;
   * remapping the live array alone left those at pre-grow coordinates, so
   * undo after a grow brought them back shifted.
   */
  const forEachTrackedPoint = useCallback((visit: (point: StrokePoint) => void) => {
    const seen = new Set<StrokePoint>()
    const visitStrokes = (strokes: readonly InkStroke[] | null | undefined) => {
      if (!strokes) return
      for (const stroke of strokes) {
        for (const point of stroke.points) {
          if (seen.has(point)) continue
          seen.add(point)
          visit(point)
        }
      }
    }
    visitStrokes(strokesRef.current)
    if (activeStrokeRef.current) visitStrokes([activeStrokeRef.current])
    for (const snapshot of undoRef.current) visitStrokes(snapshot)
    for (const snapshot of redoRef.current) visitStrokes(snapshot)
    visitStrokes(beforeGestureRef.current)
    visitStrokes(recognitionStrokesRef.current)
    const tap = pendingSolverTapRef.current
    if (tap) {
      visitStrokes(tap.snapshot)
      visitStrokes([tap.stroke])
    }
    // Section edges are points too, so a grow, pad or rescale carries the bands along with the ink.
    for (const section of sectionsRef.current) {
      for (const edge of [section.top, section.bodyTop]) {
        if (seen.has(edge)) continue
        seen.add(edge)
        visit(edge)
      }
    }
  }, [])

  /** Same holders as forEachTrackedPoint, stroke by stroke, for moves that depend on where a stroke starts. */
  const forEachTrackedStroke = useCallback((visit: (stroke: InkStroke) => void) => {
    const seen = new Set<InkStroke>()
    const visitStrokes = (strokes: readonly InkStroke[] | null | undefined) => {
      if (!strokes) return
      for (const stroke of strokes) {
        if (seen.has(stroke)) continue
        seen.add(stroke)
        visit(stroke)
      }
    }
    visitStrokes(strokesRef.current)
    if (activeStrokeRef.current) visitStrokes([activeStrokeRef.current])
    for (const snapshot of undoRef.current) visitStrokes(snapshot)
    for (const snapshot of redoRef.current) visitStrokes(snapshot)
    visitStrokes(beforeGestureRef.current)
    visitStrokes(recognitionStrokesRef.current)
    const tap = pendingSolverTapRef.current
    if (tap) {
      visitStrokes(tap.snapshot)
      visitStrokes([tap.stroke])
    }
  }, [])

  const scaleNormalizedSpace = useCallback((scaleX: number, scaleY: number) => {
    if (scaleX === 1 && scaleY === 1) return
    forEachTrackedPoint((point) => {
      point.x *= scaleX
      point.y *= scaleY
    })
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
  }, [forEachTrackedPoint])

  // 0–1 ink follows the painted sheet: when the sheet grew (a text line, a
  // viewport minimum) the strokes are rescaled so every mark keeps its paper
  // pixel. Returns whether a rescale happened; the caller repaints.
  const catchUpPaintedLayout = useCallback(() => {
    const paper = resolvePaperElement()
    if (!paper) return false
    const nextW = paper.offsetWidth
    const nextH = paper.offsetHeight
    const prevW = paintedLayoutRef.current.w
    const prevH = paintedLayoutRef.current.h
    if (nextW === prevW && nextH === prevH && !pendingGrowRemapRef.current) return false
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
    return true
  }, [resolvePaperElement, scaleNormalizedSpace])
  catchUpPaintedLayoutRef.current = catchUpPaintedLayout

  const flushPaintedLayoutGrow = useCallback(() => {
    if (!catchUpPaintedLayout()) return false
    activeRenderedPointCountRef.current = 0
    wipeLiveInk()
    redraw(true)
    return true
  }, [catchUpPaintedLayout, redraw, wipeLiveInk])

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
        // Viewport size changes the slice height; the plan only changes the
        // slice when needed, and the redraw below paints it in the same task.
        planInkWindowNow()
        redraw(true)
      }, 90)
    }
    const observer = new ResizeObserver(scheduleMeasure)
    if (surfaceRef.current) observer.observe(surfaceRef.current)
    if (surfaceRef.current?.parentElement) observer.observe(surfaceRef.current.parentElement)
    const scroller = resolvePaperElement()?.closest('.unified-note-view')
    // The slice follows every scroll frame. The canvases scroll with the
    // sheet, so ink inside the slice never moves; a move only re-slices
    // (bitmap copy + one band) once the visible sheet reaches the guard zone.
    // While a zoom gesture is moving, every step scrolls the sheet to keep the
    // point under the cursor still. Those scrolls must not re-slice and
    // re-rasterise the ink per step (a full repaint of every stroke into a
    // zoom-sized bitmap); the settle after the gesture does it once.
    const followScroll = () => {
      if (inkScrollFrameRef.current !== null) return
      inkScrollFrameRef.current = window.requestAnimationFrame(() => {
        inkScrollFrameRef.current = null
        if (zoomInFlight()) return
        syncInkWindow()
      })
    }
    const settleInkWindow = () => {
      followScroll()
      if (inkWindowIdleRef.current !== null) window.clearTimeout(inkWindowIdleRef.current)
      inkWindowIdleRef.current = window.setTimeout(() => {
        inkWindowIdleRef.current = null
        if (zoomInFlight()) return
        syncInkWindow()
      }, INK_WINDOW_IDLE_MS)
    }
    const onScrollEnd = () => {
      if (inkWindowIdleRef.current !== null) window.clearTimeout(inkWindowIdleRef.current)
      inkWindowIdleRef.current = null
      if (zoomInFlight()) return
      syncInkWindow()
    }
    scroller?.addEventListener('scroll', settleInkWindow, { passive: true })
    scroller?.addEventListener('scrollend', onScrollEnd, { passive: true })
    planInkWindowNow()
    redraw(true)
    return () => {
      mountedRef.current = false
      observer.disconnect()
      scroller?.removeEventListener('scroll', settleInkWindow)
      scroller?.removeEventListener('scrollend', onScrollEnd)
      if (inkWindowIdleRef.current !== null) {
        window.clearTimeout(inkWindowIdleRef.current)
        inkWindowIdleRef.current = null
      }
      if (inkScrollFrameRef.current !== null) {
        cancelAnimationFrame(inkScrollFrameRef.current)
        inkScrollFrameRef.current = null
      }
      if (resizeDebounceRef.current !== null) {
        window.clearTimeout(resizeDebounceRef.current)
        resizeDebounceRef.current = null
      }
      // This cleanup also runs when `redraw` changes identity (every page
      // grow), not only on unmount. scheduleRedraw() treats a non-null handle
      // as "frame pending", so a cancelled-but-kept id disabled every later
      // scheduled redraw: the ink window moved on scroll while the committed
      // bitmap stayed stale, and the ink only snapped back on an erase.
      if (drawFrameRef.current !== null) {
        cancelAnimationFrame(drawFrameRef.current)
        drawFrameRef.current = null
      }
      if (visualGrowFrameRef.current !== null) {
        cancelAnimationFrame(visualGrowFrameRef.current)
        visualGrowFrameRef.current = null
      }
      if (pendingSolverTapRef.current) window.clearTimeout(pendingSolverTapRef.current.timer)
    }
  }, [flushPaintedLayoutGrow, planInkWindowNow, redraw, resolvePaperElement, syncInkWindow, zoomInFlight])

  const applyInkExtentStyles = useCallback((height: number, width: number = sourceWidthRef.current) => {
    const paper = resolvePaperElement()
    if (!paper) return
    const styles = inkExtentStyleValues(height, Math.max(SOURCE_WIDTH, width), Math.max(1, paper.clientWidth))
    paper.style.setProperty('--ink-extent-ratio', String(styles.extentRatio))
    paper.style.setProperty('--ink-width-extent', String(styles.widthExtent))
    paper.style.setProperty('--ink-page-width', `${Math.max(1, Math.round(width))}px`)
    paper.style.setProperty('--ink-page-height', `${Math.max(1, Math.round(height))}px`)
    const origin = textOriginCssPx(sourceOriginXRef.current, sourceOriginYRef.current)
    paper.style.setProperty('--text-origin-x', origin.x)
    paper.style.setProperty('--text-origin-y', origin.y)
    paper.classList.add(HAS_INK_EXTENT_CLASS)
    paper.classList.toggle(INK_WIDTH_ANCHOR_CLASS, inkWidthNeedsAnchor(styles.widthExtent))
    const plane = paper.closest('.paper-sheet-plane') as HTMLElement | null
    plane?.style.setProperty('--paper-scroll-room', `${SCROLL_ROOM}px`)
    plane?.style.setProperty('--text-origin-x', origin.x)
    plane?.style.setProperty('--text-origin-y', origin.y)
    const ruling = plane?.querySelector('.paper-ruling') as HTMLElement | null
    const planeBox = {
      x: 0,
      y: 0,
      width: Math.max(1, plane?.offsetWidth || paper.offsetWidth || 1),
      height: Math.max(1, plane?.offsetHeight || paper.offsetHeight || 1),
    }
    const tileOrigin = paperRulingTileOrigin(planeBox, {
      x: sourceOriginXRef.current,
      y: sourceOriginYRef.current,
    })
    const rulingPos = paperRulingBackgroundPosition(tileOrigin, planeBox)
    const rulingCss = textOriginCssPx(rulingPos.x, rulingPos.y)
    ruling?.style.setProperty('background-position', `${rulingCss.x} ${rulingCss.y}`)
    inkExtentPaperRef.current = paper
  }, [resolvePaperElement])
  applyInkExtentStylesRef.current = applyInkExtentStyles

  useEffect(() => () => {
    clearInkExtentStyles(inkExtentPaperRef.current)
    inkExtentPaperRef.current = null
  }, [])

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
    wipeLiveInk()
    redraw(true)
    return true
  }, [redraw, scaleNormalizedSpace, wipeLiveInk])
  commitPendingGrowRemapRef.current = commitPendingGrowRemap

  /**
   * Resize the writable page without shifting existing ink or typed text.
   * One stay-put step: new origin pad is the only paper-coord change, and the
   * camera pans by that same pad here. Nested editor layers are sealed so they
   * cannot keep an independent scroll offset.
   */
  const setPageExtent = useCallback((targetHeight: number, targetWidth: number, padX = 0, padY = 0) => {
    const prevH = sourceHeightRef.current
    const prevW = sourceWidthRef.current
    const haveX = sourceOriginXRef.current
    const haveY = sourceOriginYRef.current
    const addX = Math.max(0, Math.round(padX))
    const addY = Math.max(0, Math.round(padY))
    const nextH = Math.min(MAX_SOURCE_HEIGHT, Math.max(WRITE_SLACK_HEIGHT, Math.round(targetHeight)))
    const nextW = Math.min(MAX_SOURCE_WIDTH, Math.max(SOURCE_WIDTH, Math.round(targetWidth)))
    if (nextH === prevH && nextW === prevW && addX === 0 && addY === 0) return false
    const paper = resolvePaperElement()
    const scroller = paper?.closest('.unified-note-view') as HTMLElement | null
    const originCamera = { x: scroller?.scrollLeft ?? 0, y: scroller?.scrollTop ?? 0 }
    const scrollerBox = scroller
      ? {
        left: scroller.getBoundingClientRect().left,
        top: scroller.getBoundingClientRect().top,
        scrollLeft: originCamera.x,
        scrollTop: originCamera.y,
      }
      : null
    const beforeOrigin = paper && scrollerBox
      ? paperScrollBoundsFromVisualRect(paper.getBoundingClientRect(), scrollerBox)
      : { minX: 0, minY: 0, maxX: 0, maxY: 0 }
    lockPaperViewportEditorScroll(scroller)
    const prevPaintW = writePageStayExtent(prevW, paintedLayoutRef.current.w)
    const prevPaintH = writePageStayExtent(prevH, paintedLayoutRef.current.h)
    sourceOriginXRef.current = haveX + addX
    sourceOriginYRef.current = haveY + addY
    sourceHeightRef.current = nextH
    sourceWidthRef.current = nextW
    setSourceHeight(nextH)
    setSourceWidth(nextW)
    applyInkExtentStyles(nextH, nextW)
    void paper?.offsetWidth
    void paper?.offsetHeight
    const nextPaintW = writePageStayExtent(nextW, paper?.offsetWidth ?? 0)
    const nextPaintH = writePageStayExtent(nextH, paper?.offsetHeight ?? 0)
    forEachTrackedPoint((point) => {
      point.x = keepMarkOnPage(point.x, prevPaintW, nextPaintW, addX)
      point.y = keepMarkOnPage(point.y, prevPaintH, nextPaintH, addY)
    })
    const remapPose = <T extends { x: number; y: number }>(pose: T | null): T | null => {
      if (!pose) return pose
      return {
        ...pose,
        x: keepMarkOnPage(pose.x, prevPaintW, nextPaintW, addX),
        y: keepMarkOnPage(pose.y, prevPaintH, nextPaintH, addY),
      }
    }
    if (rulerPoseRef.current) {
      const next = remapPose(rulerPoseRef.current)
      rulerPoseRef.current = next
      setRulerPose(next)
    }
    if (setSquarePoseRef.current) {
      const next = remapPose(setSquarePoseRef.current)
      setSquarePoseRef.current = next
      setSetSquarePose(next)
    }
    if (compassPoseRef.current) {
      const next = remapPose(compassPoseRef.current)
      compassPoseRef.current = next
      setCompassPose(next)
    }
    const afterBox = scroller
      ? {
        left: scroller.getBoundingClientRect().left,
        top: scroller.getBoundingClientRect().top,
        scrollLeft: scroller.scrollLeft,
        scrollTop: scroller.scrollTop,
      }
      : null
    const afterOrigin = paper && afterBox
      ? paperScrollBoundsFromVisualRect(paper.getBoundingClientRect(), afterBox)
      : beforeOrigin
    const shift = paperSheetLayoutShift(
      { x: beforeOrigin.minX, y: beforeOrigin.minY },
      { x: afterOrigin.minX, y: afterOrigin.minY },
    )
    const nextStay = liveWriteStayPut({
      paperX: 0,
      paperY: 0,
      camX: originCamera.x,
      camY: originCamera.y,
      width: prevW,
      height: prevH,
      originX: haveX,
      originY: haveY,
      editorX: 0,
      editorY: 0,
    }, {
      grown: { width: nextW, height: nextH, padX: addX, padY: addY },
      painted: { width: paper?.offsetWidth ?? 0, height: paper?.offsetHeight ?? 0 },
      sheetShift: shift,
    })
    pinPaperViewportAfterExtentGrow(scroller, { x: nextStay.camX, y: nextStay.camY })
    const surface = surfaceRef.current
    const canvases = [canvasRef.current, committedCanvasRef.current]
    applyVisualGrowCorrection(scroller, { x: nextStay.camX, y: nextStay.camY }, { surface, canvases })
    if (visualGrowFrameRef.current !== null) cancelAnimationFrame(visualGrowFrameRef.current)
    visualGrowFrameRef.current = schedulePaperVisualGrowRefresh(
      (callback) => window.requestAnimationFrame(callback),
      scroller,
      { x: nextStay.camX, y: nextStay.camY },
      VISUAL_GROW_REFRESH_FRAMES,
      { surface, canvases },
    ) || null
    paintedLayoutRef.current = { w: nextPaintW, h: nextPaintH }
    exportCacheRef.current = null
    setDirty(true)
    // A bottom/right grow keeps every painted row where it is (0–1 ink and
    // the paint height rescale together); only an origin pad moves the ink.
    // The slice is re-planned first so a grow under the pen is covered by
    // the same synchronous redraw that applies the new sheet size.
    const paintedStale = Math.abs(prevPaintW - canvasPixelSizeRef.current.layoutWidth) > 0.5
      || Math.abs(prevPaintH - canvasPixelSizeRef.current.layoutHeight) > 0.5
    if (addX > 0 || addY > 0 || paintedStale) {
      committedCanvasDirtyRef.current = true
    }
    planInkWindowNow()
    canvasQualityKeyRef.current = ''
    redraw(true)
    return true
  }, [applyInkExtentStyles, forEachTrackedPoint, planInkWindowNow, resolvePaperElement, setDirty, redraw])

  /**
   * The 0–1 ink space is the painted sheet (`.unified-paper`), the same box
   * the pen is mapped against. When the sheet is laid out larger than the
   * write page — viewport fill on first paint, a taller text column, a saved
   * page opened in a bigger window — the page grows to the sheet through
   * setPageExtent, so existing ink keeps its paper position instead of being
   * stretched into the new box.
   *
   * Only the sheet is measured. The canvas surface is the sheet plus the
   * camera room on every side (`--paper-scroll-room`); absorbing it grew the
   * page by that room, the sheet followed, and the next measurement grew it
   * again — a runaway grow loop that crashed the overlay on a note switch.
   */
  const absorbPaintedOneCanvas = useCallback(() => {
    if (!inline) return false
    const paper = resolvePaperElement()
    if (!paper) return false
    if (paper.classList.contains('is-pdf-note') || paper.classList.contains('has-worksheet')) return false
    let grew = false
    // applyInkExtentStyles makes the sheet at least the page; a viewport
    // minimum can leave it larger still, so a second pass adopts that box.
    for (let pass = 0; pass < 3; pass += 1) {
      const paintedW = paintedStayExtent(sourceWidthRef.current, paper.offsetWidth)
      const paintedH = paintedStayExtent(sourceHeightRef.current, paper.offsetHeight)
      if (paintedW < 2 || paintedH < 2) break
      if (paintedW <= sourceWidthRef.current + 1 && paintedH <= sourceHeightRef.current + 1) break
      if (!setPageExtent(
        Math.max(sourceHeightRef.current, Math.round(paintedH)),
        Math.max(sourceWidthRef.current, Math.round(paintedW)),
      )) break
      grew = true
    }
    return grew
  }, [inline, resolvePaperElement, setPageExtent])

  /** Grow the write page around the pen. Extra paper for pan moves with the page. */
  const ensureWriteRoom = useCallback((normalizedY?: number, normalizedX?: number) => {
    const paper = resolvePaperElement()
    const prevH = sourceHeightRef.current
    const prevW = sourceWidthRef.current
    const painted = { width: paper?.offsetWidth ?? 0, height: paper?.offsetHeight ?? 0 }
    const prevPaintW = writePageStayExtent(prevW, paintedLayoutRef.current.w || painted.width)
    const prevPaintH = writePageStayExtent(prevH, paintedLayoutRef.current.h || painted.height)
    const grown = growPageFromMark(
      {
        width: prevW,
        height: prevH,
        originX: sourceOriginXRef.current,
        originY: sourceOriginYRef.current,
      },
      { x: normalizedX, y: normalizedY },
      { width: writePageStayExtent(prevW, painted.width), height: writePageStayExtent(prevH, painted.height) },
    )
    if (grown.height > prevH || grown.width > prevW || grown.padX > 0 || grown.padY > 0) {
      if (!setPageExtent(grown.height, grown.width, grown.padX, grown.padY)) return false
      const nextPaintW = writePageStayExtent(grown.width, paper?.offsetWidth ?? 0)
      const nextPaintH = writePageStayExtent(grown.height, paper?.offsetHeight ?? 0)
      return {
        prev: { width: prevPaintW, height: prevPaintH },
        next: { width: nextPaintW, height: nextPaintH, padX: grown.padX, padY: grown.padY },
      }
    }
    return false
  }, [resolvePaperElement, setPageExtent])

  const fitPageToInk = useCallback(() => {
    if (activeStrokeRef.current) return false
    const prevH = sourceHeightRef.current
    const prevW = sourceWidthRef.current
    const box = inkAbsoluteBounds(strokesRef.current, prevW, prevH)
    const extent = writeExtentFromContent({ minX: 0, minY: 0, maxX: box.maxX, maxY: box.maxY })
    return setPageExtent(Math.max(prevH, extent.height), Math.max(prevW, extent.width))
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
    const paper = resolvePaperElement()
    const scroller = (
      resolvePaperZoomScroller(paper ?? surface)
      ?? (surface?.parentElement instanceof HTMLElement ? surface.parentElement : null)
    )
    const sheet = resolvePaperViewTarget(paper ?? surface, scroller)
    applyPaperZoomStayPut(
      scroller,
      sheet ?? surface,
      { zoom: previous, rotation: viewRotationRef.current, pan: { x: 0, y: 0 } },
      next,
      originClient,
      (view) => setView({ zoom: view.zoom, pan: { x: 0, y: 0 } }),
    )
  }, [paperView, resolvePaperElement, setView])

  const rotateBy = useCallback((delta: number) => {
    forceEndActivePointerRef.current('view-gesture')
    setView({ rotation: viewRotationRef.current + delta })
  }, [setView])

  const resetView = useCallback(() => {
    forceEndActivePointerRef.current('view-gesture')
    setView({ zoom: 1, rotation: 0, pan: { x: 0, y: 0 } })
  }, [setView])

  // Re-rasterize ink at higher backing-store resolution after zoom settles so
  // zoomed handwriting stays sharp instead of a stretched low-res bitmap.
  // The slice is re-planned around the now-visible sheet (a 100% full
  // overlay becomes a 500% slice) and painted by the same redraw.
  const settleZoomedInk = useCallback(() => {
    if (activeStrokeRef.current) return
    planInkWindowNow(true)
    canvasQualityKeyRef.current = ''
    committedCanvasDirtyRef.current = true
    redraw(true)
  }, [planInkWindowNow, redraw])

  useEffect(() => {
    if (!paperView) return
    const adopt = (view: { zoom: number; rotation: number; pan: { x: number; y: number } }) => {
      viewZoomRef.current = view.zoom
      viewRotationRef.current = view.rotation
      viewPanRef.current = view.pan
    }
    const settle = () => {
      zoomSettleTimerRef.current = null
      zoomInFlightUntilRef.current = 0
      const view = paperView.getView()
      adopt(view)
      // One React render per gesture, not per step: the toolbar percentage
      // and everything else that reads the state catch up here.
      setViewZoom(view.zoom)
      setViewRotation(view.rotation)
      setViewPan(view.pan)
      settleZoomedInk()
    }
    const initial = paperView.getView()
    adopt(initial)
    setViewZoom(initial.zoom)
    setViewRotation(initial.rotation)
    setViewPan(initial.pan)
    const unsubscribe = paperView.subscribe((view) => {
      const zoomed = view.zoom !== viewZoomRef.current
      adopt(view)
      if (zoomed) zoomInFlightUntilRef.current = performance.now() + ZOOM_SETTLE_MS
      if (zoomSettleTimerRef.current !== null) window.clearTimeout(zoomSettleTimerRef.current)
      zoomSettleTimerRef.current = window.setTimeout(settle, ZOOM_SETTLE_MS)
    })
    return () => {
      unsubscribe()
      if (zoomSettleTimerRef.current !== null) {
        window.clearTimeout(zoomSettleTimerRef.current)
        zoomSettleTimerRef.current = null
      }
      zoomInFlightUntilRef.current = 0
    }
  }, [paperView, settleZoomedInk])

  useEffect(() => {
    if (paperView) return
    applyViewTransform(viewZoom, viewRotation, viewPan)
    return () => {
      clearViewTransformTargets()
    }
  }, [applyViewTransform, clearViewTransformTargets, paperView, viewPan, viewRotation, viewZoom])

  // Without a camera host the zoom is this board's own state; settle from it.
  useEffect(() => {
    if (paperView) return
    const timer = window.setTimeout(settleZoomedInk, 90)
    return () => window.clearTimeout(timer)
  }, [paperView, settleZoomedInk, viewZoom])

  // Refs, not the state snapshot: a document load moves the refs and the
  // sheet in one step, and this pass must not put the previous page back
  // for one frame before the state catches up.
  useEffect(() => {
    applyInkExtentStyles(sourceHeightRef.current, sourceWidthRef.current)
  }, [applyInkExtentStyles, sourceHeight, sourceWidth])

  const syncPdfOverlaySource = useCallback(() => {
    const paper = resolvePaperElement()
    if (!paper || !(paper.classList.contains('is-pdf-note') || paper.classList.contains('has-worksheet'))) return false
    const paintedW = Math.max(1, paper.offsetWidth)
    const paintedH = Math.max(1, paper.offsetHeight)
    const overlayH = pdfOverlaySourceHeight(sourceWidthRef.current, paintedW, paintedH)
    if (!shouldSyncPdfOverlaySource(sourceHeightRef.current, overlayH)) return false
    sourceHeightRef.current = overlayH
    setSourceHeight(overlayH)
    applyInkExtentStyles(overlayH, sourceWidthRef.current)
    return true
  }, [applyInkExtentStyles, resolvePaperElement])

  useLayoutEffect(() => {
    const paper = resolvePaperElement()
    if (!paper) return
    absorbPaintedOneCanvas()
    syncPdfOverlaySource()
    commitPendingGrowRemap(paper.offsetWidth, paper.offsetHeight)
  }, [absorbPaintedOneCanvas, commitPendingGrowRemap, resolvePaperElement, sourceHeight, sourceWidth, syncPdfOverlaySource])

  const fitLoadedPageRef = useRef(() => {})
  fitLoadedPageRef.current = () => {
    fitPageToInk()
    absorbPaintedOneCanvas()
  }

  // Once per loaded document. fitPageToInk changes identity with every page
  // grow (through setPageExtent/redraw); running this on each grow re-armed
  // the first-paint absorb after every step of the grow it had just caused.
  useEffect(() => {
    fitLoadedPageRef.current()
  }, [drawingId, initialDrawingJson])

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
        wipeLiveInk()
        activeRenderedPointCountRef.current = 0
      }
    }
  }, [inline, inputActive, paperView, resetView, wipeLiveInk])

  const eraseAt = useCallback((value: StrokePoint | StrokePoint[]) => {
    const before = strokesRef.current.length
    const points = Array.isArray(value) ? value : [value]
    strokesRef.current = applyToolErase(strokesRef.current, points, eraserSize, sourceWidth, sourceHeight)
    if (strokesRef.current.length !== before) {
      noteStrokesErased(before - strokesRef.current.length)
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
          setNotice({ kind: 'info', text: FORM_DETECT_NOTICE_TEXT })
        }
      }, profile.hintMs)
    }
  }, [onShapeDwellElapsed, readShapeSnapProfile, settings.shapeSnapSensitivity])

  const paintActiveStrokeNow = useCallback((predicted: PointerEvent[] = []) => {
    const canvas = canvasRef.current
    const stroke = activeStrokeRef.current
    if (!canvas || !stroke) return false
    let { width: pixelWidth, height: pixelHeight, virtualHeight } = canvasPixelSizeRef.current
    if (!pixelWidth || !pixelHeight || !virtualHeight) {
      redraw(true)
      ;({ width: pixelWidth, height: pixelHeight, virtualHeight } = canvasPixelSizeRef.current)
    }
    if (!pixelWidth || !pixelHeight || !virtualHeight) return false
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) return false
    // Predicted points only ever live in the volatile tail, which the next
    // paint clears and repairs — never an incremental overdraw that would
    // leave a ghost copy of the writing behind.
    const previewPoints = predicted.length
      ? collectPreviewInkPoints(stroke.points, predicted.map(pointFromEvent)) as StrokePoint[]
      : []
    return paintLiveInk(context, stroke, previewPoints)
  }, [paintLiveInk, pointFromEvent, redraw])

  // deferPaint: the caller paints once for a whole batch of coalesced samples
  // (one canvas pass per input event instead of one per sample).
  const appendPointerEvent = useCallback((event: PointerEvent, deferPaint = false) => {
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
    if (!surface || !acceptUsableInkClient(event, surface, viewRotationRef.current)) return
    let point = pointFromEvent(event)
    if (!point) return
    const live = activeStrokeRef.current
    const lastPoint = live?.points.at(-1) ?? null
    const existingCount = live?.points.length ?? 0
    // Snapshot last before grow. setPageExtent keepMarkOnPage-mutates the
    // live point; feeding that into continueStrokeAfterExtentGrow remaps it
    // twice and the crossing sample is skipped again. Mapping stays on the
    // pre-grow box until pointerup, so continueLiveWriteStroke also lifts
    // later samples through that stale layout before the jump filter.
    const lastSnapshot = lastPoint ? { x: lastPoint.x, y: lastPoint.y } : null
    const scrollerForStay = originEl?.closest('.unified-note-view') as HTMLElement | null
    const continued = continueLiveWriteStroke({
      last: lastSnapshot,
      current: point,
      page: {
        width: sourceWidthRef.current,
        height: sourceHeightRef.current,
        originX: sourceOriginXRef.current,
        originY: sourceOriginYRef.current,
      },
      // Layout box, like setPageExtent/ensureWriteRoom. The zoomed visual
      // rect is larger than source at zoom > 1, so every grow made the next
      // sample grow again until the page hit WRITE_CAP.
      painted: { width: surface.offsetWidth, height: surface.offsetHeight },
      existingCount,
      pendingStale: pendingStaleLayoutRef.current,
      stayPut: {
        paperX: 0,
        paperY: 0,
        camX: scrollerForStay?.scrollLeft ?? 0,
        camY: scrollerForStay?.scrollTop ?? 0,
        width: sourceWidthRef.current,
        height: sourceHeightRef.current,
        originX: sourceOriginXRef.current,
        originY: sourceOriginYRef.current,
        editorX: 0,
        editorY: 0,
      },
    })
    pendingStaleLayoutRef.current = continued.pendingStale
    if (continued.grew) {
      setPageExtent(continued.grown.height, continued.grown.width, continued.grown.padX, continued.grown.padY)
    }
    point = { ...point, x: continued.current.x, y: continued.current.y }
    const jump = continued.action
    const scroller = originEl?.closest('.unified-note-view') as HTMLElement | null
    const diagnosticNow = performance.now()
    const noteworthy = continued.grew || jump === 'skip'
    if (noteworthy || diagnosticNow - lastDiagnosticAtRef.current > BUG_REPORT_PEN_SAMPLE_MS) {
      lastDiagnosticAtRef.current = diagnosticNow
      diagnosticLog.record(buildPenDiagnosticEvent({
        at: Date.now(),
        noteId: drawingIdRef.current,
        x: point.x,
        y: point.y,
        pointerType: point.pointerType,
        tool: gestureToolRef.current || tool,
        pageW: sourceWidthRef.current,
        pageH: sourceHeightRef.current,
        padX: sourceOriginXRef.current,
        padY: sourceOriginYRef.current,
        camX: scroller?.scrollLeft ?? 0,
        camY: scroller?.scrollTop ?? 0,
        grew: continued.grew,
        jump: jump === 'skip',
      }))
    }
    if (jump === 'skip') return
    if (jump === 'restart' && live) {
      live.points.splice(0, 1, point)
      activeRenderedPointCountRef.current = 0
      wipeLiveInk()
      if (gestureToolRef.current === 'eraser') {
        eraseAt(point)
        return
      }
      gestureChangedRef.current = true
      if (!deferPaint && !paintActiveStrokeNow()) scheduleRedraw()
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
    gestureChangedRef.current = true
    if (!deferPaint && !paintActiveStrokeNow()) scheduleRedraw()
    armShapeDwell()
    // Writing toward the slice edge moves the slice now — a bitmap copy plus
    // one band, painted in this same event — so live ink is never clipped.
    const sheetHeight = originEl?.offsetHeight || surface.offsetHeight
    const sheetWidth = originEl?.offsetWidth || surface.offsetWidth
    const penOnSheet = { x: point.x * sheetWidth, y: point.y * sheetHeight }
    if (inkWindowGuardHit(inkWindowLayoutRef.current, penOnSheet.y, inkWindowViewportRef.current, sheetHeight)) {
      livePenHintRef.current = penOnSheet
      syncInkWindow()
    } else if (!liveInkWindowHolds(liveWindowLayoutRef.current, penOnSheet)) {
      // The pen reached the live slice's edge: slide the slice toward it and
      // repaint the stroke in progress in this same event.
      livePenHintRef.current = penOnSheet
      syncInkWindow()
    }
  }, [armShapeDwell, clearShapeDwellTimer, eraseAt, inline, paintActiveStrokeNow, pointFromEvent, scheduleRedraw, setPageExtent, sourceHeight, sourceWidth, syncInkWindow, tool])

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

  // ── Collapsible sections ──────────────────────────────────────────────────
  // A section is a handwritten title band with a body below it. Collapsing lifts
  // the body ink into the section record and pulls the rest of the page up; the
  // flat stroke list stays the only thing painting, erasing and saving look at.

  /** Sheet px the 0–1 ink is measured against right now (the painted sheet, not the lagging page). */
  const sheetPx = useCallback(() => savedInkPage(
    { width: sourceWidthRef.current, height: sourceHeightRef.current },
    paintedLayoutRef.current,
  ), [])

  const commitSections = useCallback((next: InkSection<InkStroke>[]) => {
    const sorted = sortSections(next)
    sectionsRef.current = sorted
    setSections(sorted)
  }, [])

  const cloneSectionStroke = useCallback((stroke: InkStroke, points: StrokePoint[]): InkStroke => ({ ...stroke, points }), [])

  /**
   * Ink moved, so the committed bitmap is repainted and the page saved. Collapse
   * and expand take strokes off the sheet and put them back at other positions;
   * an undo snapshot from before would resurrect them where they no longer
   * belong, so those two start the history afresh.
   */
  const afterSectionChange = useCallback((options: { resetHistory?: boolean } = {}) => {
    if (options.resetHistory) {
      undoRef.current = []
      redoRef.current = []
      updateHistoryState()
    }
    clearRecognitionScope()
    closeMathSolverSelection()
    closeMathCorrectionSession()
    canvasQualityKeyRef.current = ''
    bumpInkRevision({ redrawCommitted: true })
    setDirty(true)
    fitPageToInk()
    planInkWindowNow()
    redraw(true)
  }, [bumpInkRevision, clearRecognitionScope, closeMathCorrectionSession, closeMathSolverSelection, fitPageToInk, planInkWindowNow, redraw, setDirty, updateHistoryState])

  /** Grows the write page by `px` at the bottom without moving any mark; returns the sheet after the grow. */
  const growSheetBy = useCallback((px: number) => {
    if (px > 0) setPageExtent(sourceHeightRef.current + px, sourceWidthRef.current)
    return sheetPx()
  }, [setPageExtent, sheetPx])

  const insertSectionAt = useCallback((y: number) => {
    const id = `section-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
    const plan = planInsertSection(sectionsRef.current, y, sheetPx(), id)
    if (!plan) {
      setNotice({ kind: 'info', text: 'Hier ist bereits ein Abschnittstitel.' })
      return false
    }
    // Tracked before the grow so the new edges are remapped like every other point.
    sectionsRef.current = [...sectionsRef.current, plan.section]
    const sheet = growSheetBy(plan.growPx)
    insertSection(plan, sectionsRef.current, sheet, forEachTrackedStroke)
    commitSections(sectionsRef.current)
    afterSectionChange()
    setNotice({ kind: 'success', text: 'Abschnitt eingefügt · Titel in die Kopfzeile schreiben, Pfeil klappt den Inhalt ein.' })
    return true
  }, [afterSectionChange, commitSections, forEachTrackedStroke, growSheetBy, sheetPx])

  const toggleSection = useCallback((id: string) => {
    const section = sectionsRef.current.find((entry) => entry.id === id)
    if (!section || activeStrokeRef.current) return
    if (section.collapsed) {
      const hiddenPx = section.hidden?.heightPx ?? 0
      const sheet = growSheetBy(hiddenPx)
      strokesRef.current = expandSection(strokesRef.current, sectionsRef.current, section, sheet, forEachTrackedStroke, cloneSectionStroke)
    } else {
      const sheet = sheetPx()
      const plan = planCollapse(strokesRef.current, sectionsRef.current, section, sheet)
      if (!plan) return
      strokesRef.current = collapseSection(plan, strokesRef.current, sectionsRef.current, sheet, forEachTrackedStroke, cloneSectionStroke)
      if (plan.hiddenPx > 0) setPageExtent(Math.max(WRITE_SLACK_HEIGHT, sourceHeightRef.current - plan.hiddenPx), sourceWidthRef.current)
    }
    indexedStrokeCountRef.current = handwritingStrokes(strokesRef.current).length
    commitSections([...sectionsRef.current])
    afterSectionChange({ resetHistory: true })
  }, [afterSectionChange, cloneSectionStroke, commitSections, forEachTrackedStroke, growSheetBy, setPageExtent, sheetPx])

  /** Removes the band; ink stays where it is, a collapsed body comes back first so nothing is lost. */
  const removeSection = useCallback((id: string) => {
    const section = sectionsRef.current.find((entry) => entry.id === id)
    if (!section || activeStrokeRef.current) return
    let resetHistory = false
    if (section.collapsed) {
      const sheet = growSheetBy(section.hidden?.heightPx ?? 0)
      strokesRef.current = expandSection(strokesRef.current, sectionsRef.current, section, sheet, forEachTrackedStroke, cloneSectionStroke)
      indexedStrokeCountRef.current = handwritingStrokes(strokesRef.current).length
      resetHistory = true
    }
    commitSections(sectionsRef.current.filter((entry) => entry !== section))
    afterSectionChange({ resetHistory })
  }, [afterSectionChange, cloneSectionStroke, commitSections, forEachTrackedStroke, growSheetBy])

  /** A stroke near the bottom of a body pushes the next header down: writing inside a section never runs out of room. */
  const ensureSectionRoom = useCallback((stroke: InkStroke) => {
    if (!sectionsRef.current.length) return false
    const plan = planBodyRoom(stroke, sectionsRef.current, sheetPx())
    if (!plan) return false
    const sheet = growSheetBy(plan.growPx)
    growBodyRoom(plan, sectionsRef.current, sheet, forEachTrackedStroke)
    commitSections([...sectionsRef.current])
    afterSectionChange()
    return true
  }, [afterSectionChange, commitSections, forEachTrackedStroke, growSheetBy, sheetPx])

  /** Sections whose header band already holds ink; the others show the „Titel“ placeholder. */
  const titledSectionIds = useMemo(() => {
    void revision
    return new Set(sections.filter((section) => headerStrokeCount(strokesRef.current, section) > 0).map((section) => section.id))
  }, [revision, sections])

  const beginSectionPlacement = useCallback(() => {
    clearRecognitionScope()
    closeMathSolverSelection()
    closeMathCorrectionSession()
    setSectionPlacing((current) => !current)
  }, [clearRecognitionScope, closeMathCorrectionSession, closeMathSolverSelection])

  useEffect(() => {
    if (!sectionPlacing) return
    setNotice({ kind: 'info', text: 'Auf das Blatt tippen, wo der Abschnitt beginnen soll · Esc bricht ab.' })
    const surface = surfaceRef.current
    if (!surface) return
    // The guide follows the pen without a React render per move.
    const onMove = (event: PointerEvent) => {
      const guide = sectionGuideRef.current
      const point = pointFromEvent(event)
      if (!guide || !point) return
      guide.style.top = `${Math.max(0, Math.min(1, point.y)) * 100}%`
      guide.style.opacity = '1'
    }
    surface.addEventListener('pointermove', onMove)
    return () => surface.removeEventListener('pointermove', onMove)
  }, [pointFromEvent, sectionPlacing])

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (overlayInert(inline, inputActive) || !overlayHitEnabled(inputActive)) return
    if (hitTestChrome(event.clientX, event.clientY)) return
    setArtPanelOpen(false)
    const now = performance.now()
    const asStylus = event.pointerType === 'pen' || (
      lastPenContactRef.current > 0 && now - lastPenContactRef.current < POST_PEN_IGNORE_MS
    )
    const buttonIdentity = tabletButtonIdentityFromPointer(event.nativeEvent, asStylus)
    const buttonAction = tabletButtonActionFromPointer(settings.tabletButtons, event.nativeEvent, asStylus)
    if (!buttonIdentity && event.button !== 0 && event.pointerType !== 'pen') return
    if (buttonIdentity && buttonAction === 'os') return
    if (buttonIdentity && (buttonAction === 'none' || buttonAction === 'undo' || buttonAction === 'redo' || buttonAction === 'pan')) {
      event.preventDefault()
      if (buttonAction === 'undo') undoNowRef.current()
      if (buttonAction === 'redo') redoNowRef.current()
      if (buttonAction === 'pan') {
        tabletPanRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
        activePointerRef.current = event.pointerId
        if (event.pointerType === 'pen') lastPenContactRef.current = now
      }
      return
    }
    // Pen-only (Windows palm / resting hand): ignore finger, mouse and trackpad ink.
    // Mapped stylus/pad buttons still run even if Chromium labelled them `mouse`.
    if (!buttonIdentity && shouldRejectNonPenInk(event.pointerType, settings.penOnly)) return
    if (activePointerRef.current !== null) {
      if (activePointerRef.current === event.pointerId) return
      if (!shouldAllowNewInkPointer(inkSessionRef.current, event, now)) return
      forceEndActivePointerRef.current('cross-device')
    }
    if (shouldIgnoreUnmappedPointerAfterPen(event.pointerType, lastPenContactRef.current, now, Boolean(buttonIdentity))) return
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
    if (!start.openStroke) {
      activePointerRef.current = null
      inkSessionRef.current = null
      pointerBoundsRef.current = null
      lastCapturedPointerIdRef.current = null
      return
    }
    if (!canvasPixelSizeRef.current.width) redraw(true)
    // Ghost 0,0 downs stay session-open so the next real sample can start the stroke.
    const firstPoint = start.commitFirst ? pointFromEvent(event.nativeEvent) : null
    const pointerEraser = buttonAction === 'eraser'
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
    if (sectionPlacing) {
      // One tap places the header; the pointer session ends here, no stroke opens.
      activePointerRef.current = null
      inkSessionRef.current = null
      pointerBoundsRef.current = null
      releasePointerCaptureSafe(event.currentTarget, event.pointerId)
      if (lastCapturedPointerIdRef.current === event.pointerId) lastCapturedPointerIdRef.current = null
      activePointerTargetRef.current = null
      if (firstPoint) {
        setSectionPlacing(false)
        insertSectionAt(firstPoint.y)
      }
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
      // The live slice has to sit under the visible sheet before the first
      // sample paints; a scroll since the last plan may have left it behind.
      syncInkWindow()
    }
    appendPointerEvent(event.nativeEvent)
  // inputActive is a dependency: a board mounted inert (keyboard mode showing
  // saved ink) kept a handler that still saw inputActive=false after the pen
  // turned on, and every pen-down was refused until an unrelated grow rebuilt it.
  }, [activeArtBrush.pressure, activeArtSymbol, appendPointerEvent, artBrush, artColor, artEffect, artOpacity, artSymbolRotation, artSymbolSize, artWidth, bumpInkRevision, clearRecognitionScope, clearShapeDwellTimer, closeMathCorrectionSession, closeMathSolverSelection, commitPendingSolverTap, commitStrokeToCanvas, inkMode, inline, inputActive, insertSectionAt, mathSolverEnabled, penColor, penWidth, pointFromEvent, redraw, scheduleRedraw, sectionPlacing, selectionMode, setDirty, settings.penOnly, settings.pressureEnabled, settings.tabletButtons, sourceHeight, sourceWidth, syncInkWindow, tool, updateHistoryState])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const pan = tabletPanRef.current
    if (pan && pan.pointerId === event.pointerId) {
      event.preventDefault()
      const paper = resolvePaperElement()
      const scroller = paper?.closest('.unified-note-view') as HTMLElement | null
      if (scroller) {
        scroller.scrollLeft -= event.clientX - pan.x
        scroller.scrollTop -= event.clientY - pan.y
      }
      tabletPanRef.current = { ...pan, x: event.clientX, y: event.clientY }
      return
    }
    if (shouldRejectNonPenInkMove(
      event.pointerType,
      settings.penOnly,
      activePointerRef.current === event.pointerId,
    )) return
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
      for (const sample of events) appendPointerEvent(sample, true)
      const predicted = event.nativeEvent.getPredictedEvents?.() ?? []
      if (activeStrokeRef.current && !paintActiveStrokeNow(predicted)) scheduleRedraw()
      // Grow the page ahead of the pen so writing never hits a hard bottom edge.
      const latest = activeStrokeRef.current?.points.at(-1)
      if (latest) ensureWriteRoom(latest.y, latest.x)
    }
  }, [appendPointerEvent, ensureWriteRoom, eraseAt, inline, inputActive, paintActiveStrokeNow, pointFromEvent, resolvePaperElement, scheduleRedraw, settings.penOnly])

  const finishPointer = useCallback((event: ReactPointerEvent<HTMLElement> | PointerEvent) => {
    const pointerId = event.pointerId
    if (tabletPanRef.current?.pointerId === pointerId) {
      tabletPanRef.current = null
      if (activePointerRef.current === pointerId) activePointerRef.current = null
      return
    }
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
        planInkWindowNow()
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
      wipeLiveInk()
      activeRenderedPointCountRef.current = 0
      endInteraction()
      if (event.type !== 'pointercancel') void openMathSolverAtPoint(point)
      scheduleRedraw()
      return
    }
    if (resolveInkFinishSample(native)) appendPointerEvent(native, true)
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
        noteStrokesErased(scribbleDeleted)
        gestureChangedRef.current = scribbleDeleted > 0
      } else {
        strokesRef.current.push(activeStroke)
        commitStrokeToCanvas(activeStroke)
        gestureChangedRef.current = true
      }
    }
    activeStrokeRef.current = null
    wipeLiveInk()
    activeRenderedPointCountRef.current = 0
    const didShapeSnap = shapeSnappedRef.current
    shapeSnappedRef.current = false
    endInteraction()
    // If zoom changed during the stroke, upgrade the backing store once the
    // pen lifts. Only a changed pixel size repaints the committed bitmap;
    // the stroke itself was already appended to it. Repainting every stroke
    // on the sheet after each letter made writing slow down as a page filled.
    queueMicrotask(() => {
      if (activeStrokeRef.current) return
      canvasQualityKeyRef.current = ''
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
          text: SCRIBBLE_ERASE_NOTICE_TEXT,
        })
      } else if (didShapeSnap) {
        setNotice({ kind: 'success', text: 'Form übernommen.' })
      }
    }
    if (gestureChangedRef.current) {
      const roomGrown = activeStroke && gestureToolRef.current === 'pen' && !scribbleDeleted && strokesRef.current.includes(activeStroke)
        ? ensureSectionRoom(activeStroke)
        : false
      if (!roomGrown) fitPageToInk()
    }
    scheduleRedraw()
  }, [analyzeMathCorrectionSelection, appendPointerEvent, bumpInkRevision, clearShapeDwellTimer, commitPendingSolverTap, commitStrokeToCanvas, ensureSectionRoom, fitPageToInk, flushPaintedLayoutGrow, inkMode, mathSolverEnabled, mode, openMathSolverAtPoint, pointFromEvent, readShapeSnapProfile, planInkWindowNow, redraw, scheduleRedraw, selectionPurpose, setDirty, settings.scribbleEraseSensitivity, sourceHeight, sourceWidth, trySnapActiveShape, updateHistoryState, wipeLiveInk])

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
    /**
     * Sheet geometry, read again after every grow: a page that just gained
     * room for the arc has a new height, and radii sampled against the old one
     * would paint an ellipse.
     */
    const geometry = () => ({
      sw: sourceWidthRef.current,
      sh: sourceHeightRef.current,
      display: readDraftingDisplay(),
    })
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
    /**
     * Makes room for the whole circle (far corner, then near corner: the sheet
     * may also grow up/left) and returns the geometry that is current afterwards.
     * Poses are remapped by the grow, so callers re-read compassPoseRef.
     */
    const growForPose = (start: CompassPose) => {
      let pose = start
      for (const sign of [1, -1]) {
        const g = geometry()
        const { rx, ry } = compassRadiiNorm(pose.radiusMm, g.sw, g.sh, g.display)
        ensureWriteRoom(pose.y + sign * (ry + 0.02), pose.x + sign * (rx + 0.02))
        pose = compassPoseRef.current ?? pose
      }
      return geometry()
    }
    const drafting = draftingSettingsRef.current
    const unit = drafting.unit
    /** Small cross at the needle, when the construction should keep its centre. */
    const centreMarkStrokes = (pose: CompassPose, g = geometry()): InkStroke[] => (
      drafting.compassCentreMark
        ? compassCentreMarkSegments(pose, g.sw, g.sh, g.display).map((segment) => makeStroke(segment.map((point) => toPoint(point.x, point.y))))
        : []
    )
    /** One undo step for the arc/circle together with its centre mark. */
    const commitReadyStrokes = (strokes: Array<InkStroke | null>, label: string) => {
      activeStrokeRef.current = null
      wipeLiveInk()
      activeRenderedPointCountRef.current = 0
      const ready = strokes.filter((stroke): stroke is InkStroke => Boolean(stroke && stroke.points.length >= 2))
      if (!ready.length) {
        scheduleRedraw()
        return
      }
      undoRef.current.push(beforeGestureRef.current)
      if (undoRef.current.length > 80) undoRef.current.shift()
      redoRef.current = []
      for (const stroke of ready) {
        strokesRef.current.push(stroke)
        commitStrokeToCanvas(stroke)
      }
      bumpInkRevision({ redrawCommitted: false, appendOnly: true, updateTranscript: ready.some((stroke) => stroke.purpose !== 'art') })
      setDirty(true)
      updateHistoryState()
      setNotice({ kind: 'success', text: label })
      fitPageToInk()
      scheduleRedraw()
    }

    if (event.type === 'arc') {
      if (activePointerRef.current !== null || activeStrokeRef.current) return
      const before = compassPoseRef.current ?? event.pose
      const from = before.rotation
      const to = from + event.sweep
      const g = growForPose(before)
      const pose = compassPoseRef.current ?? before
      const points = [
        ...sampleCompassArc(pose, from, from, g.sw, g.sh, 0.035, g.display),
        ...sampleCompassArc(pose, from, to, g.sw, g.sh, 0.035, g.display),
      ].map((point) => toPoint(point.x, point.y))
      beforeGestureRef.current = snapshotStrokes(strokesRef.current)
      commitReadyStrokes(
        [makeStroke(points), ...centreMarkStrokes(pose, g)],
        `Bogen ${formatArcDegrees(event.sweep)} mit r ${formatLength(pose.radiusMm, unit)} gezeichnet.`,
      )
      // Like a real compass, the pencil now rests at the end of the arc.
      const turned = { ...pose, rotation: to }
      compassPoseRef.current = turned
      setCompassPose(turned)
      return
    }

    if (event.type === 'begin') {
      if (activePointerRef.current !== null) return
      beforeGestureRef.current = snapshotStrokes(strokesRef.current)
      gestureChangedRef.current = true
      gestureToolRef.current = 'pen'
      activeRenderedPointCountRef.current = 0
      const g = growForPose(event.pose)
      const pose = compassPoseRef.current ?? event.pose
      const first = sampleCompassArc(pose, pose.rotation, pose.rotation, g.sw, g.sh, 0.035, g.display)[0]
      if (!first) return
      activeStrokeRef.current = makeStroke([toPoint(first.x, first.y)])
      paintActiveStrokeNow()
      return
    }
    if (event.type === 'append') {
      const stroke = activeStrokeRef.current
      if (!stroke) return
      // The grow remaps the stroke so far together with the pose; the new
      // samples are taken around the remapped needle.
      const g = growForPose(event.pose)
      const extra = sampleCompassArc(
        compassPoseRef.current ?? event.pose,
        event.fromAngle,
        event.toAngle,
        g.sw,
        g.sh,
        0.035,
        g.display,
      )
      for (const point of extra) stroke.points.push(toPoint(point.x, point.y))
      if (!paintActiveStrokeNow()) scheduleRedraw()
      return
    }
    if (event.type === 'cancel') {
      activeStrokeRef.current = null
      wipeLiveInk()
      activeRenderedPointCountRef.current = 0
      scheduleRedraw()
      return
    }
    if (event.type === 'commit') {
      const pose = compassPoseRef.current ?? event.pose
      const label = `Bogen mit r ${formatLength(pose.radiusMm, unit)} gezeichnet.`
      commitReadyStrokes([activeStrokeRef.current, ...centreMarkStrokes(pose)], label)
      return
    }
    const g = growForPose(event.pose)
    const pose = compassPoseRef.current ?? event.pose
    const points = sampleCompassCircle(pose, g.sw, g.sh, g.display).map((point) => toPoint(point.x, point.y))
    beforeGestureRef.current = snapshotStrokes(strokesRef.current)
    commitReadyStrokes(
      [makeStroke(points), ...centreMarkStrokes(pose, g)],
      `Kreis mit r ${formatLength(pose.radiusMm, unit)} gezeichnet.`,
    )
  }, [artBrush, artColor, artEffect, artOpacity, artWidth, bumpInkRevision, commitStrokeToCanvas, ensureWriteRoom, fitPageToInk, inkMode, paintActiveStrokeNow, penColor, penWidth, readDraftingDisplay, scheduleRedraw, setDirty, updateHistoryState, wipeLiveInk])

  /** Centre of the sheet the user can currently see, in normalised sheet coordinates. */
  const visibleSheetCentre = useCallback((): { x: number; y: number } => {
    const paper = inline ? resolvePaperElement() : (surfaceRef.current ?? canvasRef.current)
    if (!paper) return { x: 0.5, y: 0.4 }
    const paperBox = paper.getBoundingClientRect()
    if (paperBox.width < 1 || paperBox.height < 1) return { x: 0.5, y: 0.4 }
    const scroller = paper.closest('.unified-note-view, .lw-draw-workspace') as HTMLElement | null
    const view = scroller?.getBoundingClientRect() ?? paperBox
    const left = Math.max(paperBox.left, view.left)
    const right = Math.min(paperBox.right, view.right)
    const top = Math.max(paperBox.top, view.top)
    const bottom = Math.min(paperBox.bottom, view.bottom)
    if (right <= left || bottom <= top) return { x: 0.5, y: 0.4 }
    return {
      x: Math.min(1, Math.max(0, ((left + right) / 2 - paperBox.left) / paperBox.width)),
      y: Math.min(1, Math.max(0, ((top + bottom) / 2 - paperBox.top) / paperBox.height)),
    }
  }, [inline, resolvePaperElement])

  const showDraftingTool = useCallback((kind: DraftingKind) => {
    const centre = visibleSheetCentre()
    const sw = sourceWidthRef.current
    const sh = sourceHeightRef.current
    // A second tool does not land on top of the first: step down the sheet
    // until the origin is clear of every tool that is already out.
    const others = [rulerPoseRef.current, setSquarePoseRef.current, compassPoseRef.current].filter((other): other is DraftingPose => Boolean(other))
    let target = { x: centre.x, y: centre.y }
    for (let step = 0; step < 4; step += 1) {
      const clear = others.every((other) => (
        Math.hypot(normToMm(other.x - target.x, sw), normToMm(other.y - target.y, sh)) > 20
      ))
      if (clear) break
      target = { x: target.x, y: target.y + mmToNorm(45, sh) }
    }
    const pose = keepPoseOnSheet(
      kind,
      { ...defaultPoseFor(kind, draftingSettingsRef.current), x: target.x, y: target.y },
      sw,
      sh,
    )
    setDraftingPose(kind, pose)
    activeDraftingKindRef.current = kind
    setActiveDraftingKind(kind)
  }, [setDraftingPose, visibleSheetCentre])

  const toggleDraftingTool = useCallback((kind: DraftingKind) => {
    if (draftingPoseOf(kind)) {
      setDraftingPose(kind, null)
      return
    }
    showDraftingTool(kind)
    if (kind === 'compass') {
      setNotice({
        kind: 'info',
        text: 'Nadel ziehen zum Setzen, gelber Punkt für den Radius, grüner Punkt drehen zum Zeichnen. Schloss sperrt das Maß, Kreis-Taste zeichnet sofort.',
      })
    } else if (kind === 'setSquare') {
      setNotice({
        kind: 'info',
        text: 'Geodreieck: Körper verschieben, blauer Punkt dreht, Stift zeichnet an allen drei Kanten. Nahe am Lineal legt es sich von selbst an.',
      })
    } else {
      setNotice({
        kind: 'info',
        text: 'Lineal: Körper verschieben, blauer Punkt dreht, linker Griff ändert die Länge. Der Stift zeichnet an beiden Kanten entlang.',
      })
    }
  }, [draftingPoseOf, setDraftingPose, showDraftingTool])

  /** Brings a tool back into view with its rotation reset; size and radius stay. */
  const recentreDraftingTool = useCallback((kind: DraftingKind) => {
    const current = draftingPoseOf(kind)
    if (!current) return
    const centre = visibleSheetCentre()
    setDraftingPose(kind, keepPoseOnSheet(kind, { ...current, x: centre.x, y: centre.y, rotation: 0 }, sourceWidthRef.current, sourceHeightRef.current))
  }, [draftingPoseOf, setDraftingPose, visibleSheetCentre])

  const activateDraftingTool = useCallback((kind: DraftingKind) => {
    activeDraftingKindRef.current = kind
    setActiveDraftingKind(kind)
    const board = boardRef.current
    if (board && !board.contains(document.activeElement)) {
      try { board.focus({ preventScroll: true }) } catch { /* ignore */ }
    }
  }, [])

  /** Arrow keys nudge, Q/E turn, F flips — for the tool touched last. */
  const handleDraftingKey = useCallback((event: React.KeyboardEvent): boolean => {
    const kind = activeDraftingKindRef.current
    if (!kind || event.ctrlKey || event.metaKey || event.altKey) return false
    const pose = draftingPoseOf(kind)
    if (!pose) return false
    const nudges: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }
    const nudge = nudges[event.key]
    if (nudge) {
      event.preventDefault()
      if (pose.pinned) return true
      const stepMm = event.shiftKey ? 10 : 1
      setDraftingPose(kind, nudgePose(pose, nudge[0] * stepMm, nudge[1] * stepMm, sourceWidthRef.current, sourceHeightRef.current))
      return true
    }
    const key = event.key.toLowerCase()
    if ((key === 'q' || key === 'e') && kind !== 'compass') {
      event.preventDefault()
      if (pose.pinned) return true
      const settingsStep = draftingSettingsRef.current.angleStep
      const stepDeg = event.shiftKey ? 15 : settingsStep || 1
      const direction = key === 'e' ? 1 : -1
      const raw = pose.rotation + direction * stepDeg * Math.PI / 180
      setDraftingPose(kind, { ...pose, rotation: settingsStep ? snapAngle(raw, settingsStep) : raw })
      return true
    }
    if (key === 'f' && kind === 'setSquare') {
      event.preventDefault()
      setDraftingPose(kind, { ...pose, flipped: !pose.flipped })
      return true
    }
    return false
  }, [draftingPoseOf, setDraftingPose])

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
      wipeLiveInk()
      activeRenderedPointCountRef.current = 0
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
  // ribbon/tab buttons look dead. Keyboard mode must not keep these capture-phase
  // locks — that is the 1788698537115 “can't press most of the things” stall.
  useEffect(() => {
    if (!overlayGlobalPointerLockOn(inline, inputActive)) {
      forceEndActivePointer('watchdog')
      releaseStuckInputFocus(boardRef.current)
      return
    }
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
        for (const sample of events) appendPointerEvent(sample, true)
        const predicted = event.getPredictedEvents?.() ?? []
        if (activeStrokeRef.current && !paintActiveStrokeNow(predicted)) scheduleRedraw()
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
  }, [appendPointerEvent, eraseAt, ensureWriteRoom, finishPointer, forceEndActivePointer, inline, inputActive, paintActiveStrokeNow, pointFromEvent, scheduleRedraw])

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
  undoNowRef.current = undo

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
  redoNowRef.current = redo

  const clear = useCallback(() => {
    if (!strokesRef.current.length && !sectionsRef.current.length) return
    clearRecognitionScope()
    closeMathSolverSelection()
    closeMathCorrectionSession()
    // Collapsed bodies come back first so the snapshot below holds every stroke of the page.
    for (const section of sectionsRef.current) {
      if (!section.collapsed) continue
      const sheet = growSheetBy(section.hidden?.heightPx ?? 0)
      strokesRef.current = expandSection(strokesRef.current, sectionsRef.current, section, sheet, forEachTrackedStroke, cloneSectionStroke)
    }
    sectionsRef.current = []
    setSections([])
    setSectionPlacing(false)
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
  }, [bumpInkRevision, clearRecognitionScope, cloneSectionStroke, closeMathCorrectionSession, closeMathSolverSelection, fitPageToInk, forEachTrackedStroke, growSheetBy, setDirty, updateHistoryState])

  const insertSynthesizedHandwriting = useCallback((
    generatedStrokes: SynthesizedInkStroke[],
    result: HandwritingSynthesisResult,
  ) => {
    if (!generatedStrokes.length) return
    const nextHeight = Math.max(sourceHeightRef.current, result.pageHeight || sourceHeightRef.current)
    const nextWidth = Math.max(sourceWidthRef.current, result.pageWidth || sourceWidthRef.current)
    if (nextHeight > sourceHeightRef.current || nextWidth > sourceWidthRef.current) {
      setPageExtent(nextHeight, nextWidth)
    }
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
  }, [bumpInkRevision, clearRecognitionScope, fitPageToInk, scheduleRedraw, setDirty, setPageExtent, updateHistoryState])

  const drawingPayload = useCallback((includeImage = false): DrawingSavePayload => {
    // Refs, not state: a grow in an effect and a save in the same commit (the
    // unmount save of a closing board) must see the box the strokes were just
    // remapped to. The sheet box, not the page: the page follows the sheet one
    // layout effect later, and strokes are 0–1 of the sheet in between.
    const page = savedInkPage(
      { width: sourceWidthRef.current, height: sourceHeightRef.current },
      paintedLayoutRef.current,
    )
    let imageData: string | undefined
    if (includeImage) {
      const exportKey = [inkRevisionRef.current, paperStyle, settings.smoothing, page.width, page.height].join(':')
      imageData = exportCacheRef.current?.key === exportKey ? exportCacheRef.current.imageData : undefined
      if (!imageData) {
      const exportCanvas = document.createElement('canvas')
      exportCanvas.width = page.width * EXPORT_SCALE
      exportCanvas.height = page.height * EXPORT_SCALE
      renderDocument(
        exportCanvas,
        strokesRef.current,
        paperStyle,
        settings.smoothing,
        exportCanvas.width,
        exportCanvas.height,
        true,
        page.width,
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
      sourceWidth: page.width,
      sourceHeight: page.height,
      sourceOriginX: sourceOriginXRef.current,
      sourceOriginY: sourceOriginYRef.current,
      overlayQuality: INK_MIN_INLINE_QUALITY,
      overlayQualityZoom: INK_MAX_VIEW_QUALITY_ZOOM,
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
      sections: sectionsRef.current.length ? serializeSections(sectionsRef.current) : undefined,
    }
    return {
      id: drawingIdRef.current,
      title,
      imageData,
      drawingJson: JSON.stringify(drawing),
      inkSummary: summarizeInkStrokes(strokesRef.current, page.width, page.height),
    }
  }, [activeMode, mathSolverEnabled, mode, paperStyle, settings.smoothing, title])

  /** A record exists once the page was loaded from the note or written by this board. */
  const inkRecordExists = useCallback(() => (
    Boolean(drawingIdRef.current) || loadedDrawingIdRef.current !== undefined
  ), [])

  /**
   * Write the page and adopt the id the app assigned. The snapshot is noted
   * first: the app updates the session (which echoes it back as the board's
   * document) before the save resolves.
   */
  const writeInkPage = useCallback(async (payload: DrawingSavePayload) => {
    authoredSaveRef.current = { id: payload.id || null, drawingJson: payload.drawingJson }
    const result = await onSaveDrawing(payload)
    if (result && typeof result === 'object' && 'id' in result && typeof result.id === 'string') {
      authoredSaveRef.current = { id: result.id, drawingJson: payload.drawingJson }
      drawingIdRef.current = result.id
    }
    return result
  }, [onSaveDrawing])

  const saveDrawing = useCallback((insertAfterSave: boolean, silent = false) => {
    if (!inkPagePersists(strokesRef.current.length, inkRecordExists())) return Promise.resolve()
    if (!silent) {
      queuedSaveCountRef.current += 1
      setIsSaving(true)
    }
    if (!silent) setNotice(null)

    const run = async () => {
      const savedRevision = revisionRef.current
      try {
        const result = await writeInkPage(drawingPayload(insertAfterSave))
        if (!mountedRef.current) {
          // The unmount save of a closing board: no state left to set, but the
          // host must learn the page is clean or it keeps guarding a saved page.
          if (revisionRef.current === savedRevision) {
            dirtyRef.current = false
            onDirtyChange?.(false)
          }
          return
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
        if (silent) {
          console.error('Automatisches Speichern der Handschrift-Seite fehlgeschlagen.', error)
          // A failed autosave must never stay invisible: the page stays dirty,
          // the writer sees it, and the board tries again on its own.
          if (mountedRef.current) {
            setNotice({ kind: 'error', text: 'Handschrift konnte nicht automatisch gespeichert werden – neuer Versuch folgt.' })
            if (saveRetryTimerRef.current !== null) window.clearTimeout(saveRetryTimerRef.current)
            saveRetryTimerRef.current = window.setTimeout(() => {
              saveRetryTimerRef.current = null
              if (mountedRef.current && dirtyRef.current) void saveLatestRef.current()
            }, INK_SAVE_RETRY_DELAY_MS)
          }
        }
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
  }, [clear, drawingPayload, inkRecordExists, onDirtyChange, onInsertMarkdown, setDirty, settings.keepDrawingAfterInsert, title, writeInkPage])

  useEffect(() => {
    saveLatestRef.current = () => saveDrawing(false, true)
  }, [saveDrawing])

  useImperativeHandle(forwardedRef, () => ({
    flush: async () => {
      // A pen still on the sheet while the note switches or the app closes:
      // commit that stroke first so the written page contains it.
      if (activePointerRef.current !== null || activeStrokeRef.current) forceEndActivePointerRef.current('blur')
      await saveQueueRef.current.catch(() => {})
      // Strokes drawn while a write is in flight bump the revision; only a
      // write that saw the latest revision may clear the dirty flag.
      for (let attempt = 0; attempt < INK_FLUSH_MAX_ROUNDS; attempt += 1) {
        if (!dirtyRef.current || !inkPagePersists(strokesRef.current.length, inkRecordExists())) return
        const savedRevision = revisionRef.current
        await writeInkPage(drawingPayload())
        if (revisionRef.current === savedRevision) {
          setDirty(false)
          return
        }
      }
      throw new Error('Die Handschrift ändert sich noch – bitte kurz warten und erneut speichern.')
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
  }), [drawingPayload, inkMode, inkRecordExists, setDirty, tool, writeInkPage])

  useEffect(() => () => {
    if (saveRetryTimerRef.current !== null) window.clearTimeout(saveRetryTimerRef.current)
    if (dirtyRef.current && inkPagePersists(strokesRef.current.length, inkRecordExists())) void saveLatestRef.current()
  }, [inkRecordExists])

  // A lost GPU context wipes both bitmaps; the strokes are still in the model,
  // so repaint them the moment the browser hands the context back.
  useEffect(() => {
    const canvases = [canvasRef.current, committedCanvasRef.current].filter((canvas): canvas is HTMLCanvasElement => Boolean(canvas))
    if (!canvases.length) return
    const restore = () => {
      committedCanvasDirtyRef.current = true
      scheduleRedraw()
    }
    for (const canvas of canvases) canvas.addEventListener('contextrestored', restore)
    return () => {
      for (const canvas of canvases) canvas.removeEventListener('contextrestored', restore)
    }
  }, [scheduleRedraw])

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
    const before = strokesRef.current.length
    strokesRef.current = strokesRef.current.filter((_, index) => !indexes.has(index))
    noteStrokesErased(before - strokesRef.current.length)
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
    if (revision === 0 || !dirtyRef.current) return
    if (!inkPagePersists(strokesRef.current.length, inkRecordExists())) return
    let idleId: number | null = null
    const saveTimer = window.setTimeout(() => {
      idleId = window.requestIdleCallback(() => { void saveDrawing(false, true) }, { timeout: 2_500 })
    }, 900)
    return () => {
      window.clearTimeout(saveTimer)
      if (idleId !== null) window.cancelIdleCallback(idleId)
    }
  }, [inkRecordExists, revision, saveDrawing])

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
    const message = 'Lokales Handschrift-Training wirklich vollständig löschen? Diese Aktion entfernt alle importierten und durch Korrekturen gelernten Beispiele dauerhaft.'
    const confirmed = confirmDestructive ? await confirmDestructive(message) : false
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
  }, [confirmDestructive, onTrainingChanged])

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
    const keyTarget = event.target
    if (keyTarget instanceof Element && keyTarget.closest('.lw-tth-dialog, .lw-tth-backdrop')) return
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
    if (event.key === 'Escape' && sectionPlacing) {
      event.preventDefault()
      setSectionPlacing(false)
      setNotice({ kind: 'info', text: 'Abschnitt nicht eingefügt.' })
      return
    }
    if (event.key === 'Escape') {
      if (activePointerRef.current !== null || activeStrokeRef.current || lastCapturedPointerIdRef.current !== null) {
        event.preventDefault()
        forceEndActivePointer('escape')
        return
      }
      if (viewZoomRef.current !== 1 || viewRotationRef.current !== 0 || viewPanRef.current.x !== 0 || viewPanRef.current.y !== 0) {
        event.preventDefault()
        resetView()
        return
      }
    }
    if (handleDraftingKey(event)) return
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
      inert={overlayInert(inline, inputActive) || undefined}
      aria-hidden={overlayInert(inline, inputActive) || undefined}
      onKeyDown={handleKeyboard}
      onWheel={handleWheel}
      onPointerDown={inline && overlayHitEnabled(inputActive) ? handlePointerDown : undefined}
      onPointerMove={inline && overlayHitEnabled(inputActive) ? handlePointerMove : undefined}
      onPointerUp={inline && overlayHitEnabled(inputActive) ? finishPointer : undefined}
      onPointerCancel={inline && overlayHitEnabled(inputActive) ? finishPointer : undefined}
      onLostPointerCapture={inline && overlayHitEnabled(inputActive) ? finishPointer : undefined}
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
            title="Lineal einblenden: verschieben, drehen, Länge ändern, Zentimeter oder Zoll ablesen und an beiden Kanten nachzeichnen"
            onClick={() => toggleDraftingTool('ruler')}
          >
            <Ruler size={16} /> <span className="lw-tool-label">Lineal</span>
          </button>
          <button
            type="button"
            className={setSquarePose ? 'is-active' : ''}
            aria-pressed={Boolean(setSquarePose)}
            title="Geodreieck einblenden: Winkel messen, an drei Kanten zeichnen, Parallelen und Senkrechte am Lineal anlegen"
            onClick={() => toggleDraftingTool('setSquare')}
          >
            <Triangle size={16} /> <span className="lw-tool-label">Geodreieck</span>
          </button>
          <button
            type="button"
            className={compassPose ? 'is-active' : ''}
            aria-pressed={Boolean(compassPose)}
            title="Zirkel: Nadel setzen, gelb Radius messen/übertragen, grün Bogen zeichnen, Kreis-Taste für einen ganzen Kreis"
            onClick={() => toggleDraftingTool('compass')}
          >
            <Compass size={16} /> <span className="lw-tool-label">Zirkel</span>
          </button>
          {(rulerPose || setSquarePose || compassPose) && (
            <button
              type="button"
              className={draftingSettings.panelOpen ? 'is-active' : ''}
              aria-pressed={draftingSettings.panelOpen}
              title="Optionen der Zeichenhilfen: Einheit, Winkelraster, Magnet, Länge, Größe, Radius und Bögen"
              onClick={() => updateDraftingSettings({ panelOpen: !draftingSettings.panelOpen })}
            >
              <SlidersHorizontal size={16} /> <span className="lw-tool-label">Optionen</span>
            </button>
          )}
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
          {sectionsEnabled && inkMode === 'writing' && <button type="button" className={`lw-draw-subtle ${sectionPlacing ? 'is-active' : ''}`} aria-pressed={sectionPlacing} onClick={beginSectionPlacement} title="Abschnitt mit Titelzeile einfügen · der Pfeil am Rand klappt den Inhalt ein">
            <ListCollapse size={14} /> <span className="lw-tool-label">Abschnitt</span>
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
        if (inline) return portalInkToolbar(createPortal, toolbar, inkToolbarHost, inputActive)
        return toolbar
      })()}

      {(rulerPose || setSquarePose || compassPose)
        && draftingSettings.panelOpen
        && !(inkMode === 'drawing' && tool === 'pen' && artPanelOpen)
        && (!inline || inputActive)
        && (inline ? (node: ReactNode) => createPortal(node, document.body) : (node: ReactNode) => node)(
        <DraftingPanel
          className={inline ? 'is-viewport-chrome' : ''}
          settings={draftingSettings}
          ruler={rulerPose}
          setSquare={setSquarePose}
          compass={compassPose}
          onSettingsChange={updateDraftingSettings}
          onPose={(kind, pose) => {
            activeDraftingKindRef.current = kind
            setActiveDraftingKind(kind)
            setDraftingPose(kind, pose)
          }}
          onHide={(kind) => setDraftingPose(kind, null)}
          onRecentre={recentreDraftingTool}
          onCompassDraw={handleCompassDraw}
          onClose={() => updateDraftingSettings({ panelOpen: false })}
        />,
      )}

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
            onContextMenu={inline ? (event) => {
              const action = tabletButtonActionFromPointer(settings.tabletButtons, event.nativeEvent, true)
              if (action !== 'os') event.preventDefault()
            } : undefined}
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
              onContextMenu={(event) => {
                const action = tabletButtonActionFromPointer(settings.tabletButtons, event.nativeEvent, true)
                if (action !== 'os') event.preventDefault()
              }}
            />
            {(rulerPose || setSquarePose || compassPose) && (
              <DraftingGuides
                sourceWidth={sourceWidth}
                sourceHeight={sourceHeight}
                ruler={rulerPose}
                setSquare={setSquarePose}
                compass={compassPose}
                settings={draftingSettings}
                readout={draftingReadout}
                onMove={(kind, pose) => {
                  // A length pulled by hand becomes the default for the next ruler.
                  if (kind === 'ruler' && pose.lengthMm && pose.lengthMm !== rulerPoseRef.current?.lengthMm) {
                    updateDraftingSettings({ rulerLengthMm: pose.lengthMm })
                  }
                  setDraftingPose(kind, pose)
                }}
                onCompassDraw={handleCompassDraw}
                onActivate={activateDraftingTool}
              />
            )}
            {(sections.length > 0 || sectionPlacing) && <div className="lw-ink-sections" aria-label="Abschnitte">
              {sections.map((section) => {
                const bodyEnd = section.collapsed ? section.bodyTop.y : (nextSectionTop(sections, section) ?? 1)
                const titled = titledSectionIds.has(section.id)
                const hiddenCount = section.hidden?.strokes.length ?? 0
                return (
                  <Fragment key={section.id}>
                    <div
                      className={`lw-ink-section-header ${section.collapsed ? 'is-collapsed' : ''}`}
                      style={{ top: `${section.top.y * 100}%`, height: `${(section.bodyTop.y - section.top.y) * 100}%` }}
                    >
                      <button
                        type="button"
                        className="lw-ink-section-control lw-ink-section-toggle"
                        aria-expanded={!section.collapsed}
                        aria-label={section.collapsed ? 'Abschnitt ausklappen' : 'Abschnitt einklappen'}
                        title={section.collapsed ? 'Abschnitt ausklappen' : 'Abschnitt einklappen'}
                        onClick={() => toggleSection(section.id)}
                      >
                        {section.collapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
                      </button>
                      {!titled && <span className="lw-ink-section-placeholder" aria-hidden="true">Titel</span>}
                      {section.collapsed && <span className="lw-ink-section-badge" title={`${hiddenCount} Striche`}>Eingeklappt</span>}
                      <button
                        type="button"
                        className="lw-ink-section-control lw-ink-section-remove"
                        aria-label="Abschnitt auflösen"
                        title="Abschnitt auflösen · die Tinte bleibt auf der Seite"
                        onClick={() => removeSection(section.id)}
                      >
                        <X size={13} />
                      </button>
                    </div>
                    {!section.collapsed && bodyEnd > section.bodyTop.y && <div
                      className="lw-ink-section-rail"
                      style={{ top: `${section.bodyTop.y * 100}%`, height: `${(bodyEnd - section.bodyTop.y) * 100}%` }}
                    />}
                  </Fragment>
                )
              })}
              {sectionPlacing && <div ref={sectionGuideRef} className="lw-ink-section-guide" style={{ top: '-9999px', opacity: 0 }}><span>Neuer Abschnitt</span></div>}
              {sectionPlacing && <div className="lw-selection-hint is-section"><ListCollapse size={18} /> Auf das Blatt tippen, wo der Abschnitt beginnen soll</div>}
            </div>}
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

        {settings.experimentalHandwritingToText && conversionOpen && (!inline || inputActive) && (inline ? (node: ReactNode) => createPortal(node, document.body) : (node: ReactNode) => node)(
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

      {notice && (!inline || inputActive) && (inline ? (node: ReactNode) => createPortal(node, document.body) : (node: ReactNode) => node)(
      <div className={`lw-draw-notice is-${notice.kind} ${inline ? 'is-viewport-chrome' : ''}`} role="status">
        {notice.kind === 'success' ? <Check size={15} /> : notice.kind === 'error' ? <CircleAlert size={15} /> : <Sparkles size={15} />}
        <span>{notice.text}</span>
        <button type="button" aria-label="Hinweis schließen" onClick={() => setNotice(applyInkNoticeOp({ notice, clearAt: null }, { type: 'close' }).notice)}><X size={14} /></button>
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
          {sectionsEnabled && inkMode === 'writing' && <button type="button" className={`lw-draw-subtle ${sectionPlacing ? 'is-active' : ''}`} aria-pressed={sectionPlacing} onClick={beginSectionPlacement} title="Abschnitt mit Titelzeile einfügen · der Pfeil am Rand klappt den Inhalt ein">
            <ListCollapse size={14} /> Abschnitt
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
.lw-ink-sections{position:absolute;inset:0;z-index:3;pointer-events:none}
.lw-drawing-board.is-inline .lw-ink-sections{inset:var(--paper-scroll-room,0px);width:calc(100% - 2 * var(--paper-scroll-room,0px));height:calc(100% - 2 * var(--paper-scroll-room,0px))}
.lw-ink-section-header{position:absolute;left:0;right:0;box-sizing:border-box;border-top:1px solid rgba(86,71,183,.3);border-bottom:1px solid rgba(86,71,183,.3);background:linear-gradient(90deg,rgba(104,85,217,.11),rgba(104,85,217,.045) 55%,rgba(104,85,217,.02));pointer-events:none}
.lw-ink-section-header.is-collapsed{border-bottom:2px dashed rgba(86,71,183,.45);background:linear-gradient(90deg,rgba(104,85,217,.16),rgba(104,85,217,.06) 55%,rgba(104,85,217,.03))}
.lw-ink-section-toggle{position:absolute;left:14px;top:50%;width:30px;height:30px;display:grid;place-items:center;transform:translateY(-50%);border:1px solid rgba(86,71,183,.36);border-radius:8px;color:#4a3fb0;background:rgba(255,255,255,.96);box-shadow:0 2px 8px rgba(39,31,85,.14);cursor:pointer;pointer-events:auto;transition:background .12s ease,transform .12s ease}
.lw-ink-section-toggle:hover{background:#efeafd}
.lw-ink-section-toggle:active{transform:translateY(-50%) scale(.94)}
.lw-ink-section-placeholder{position:absolute;left:12%;top:50%;transform:translateY(-50%);color:rgba(74,63,176,.34);font:600 22px/1 var(--ui-font,system-ui);letter-spacing:.02em;pointer-events:none;user-select:none}
.lw-ink-section-badge{position:absolute;right:48px;top:50%;transform:translateY(-50%);padding:3px 9px;border-radius:999px;color:#4a3fb0;background:rgba(104,85,217,.14);font:700 10px/1.3 var(--ui-font,system-ui);white-space:nowrap;pointer-events:none}
.lw-ink-section-remove{position:absolute;right:14px;top:50%;width:22px;height:22px;display:grid;place-items:center;transform:translateY(-50%);border:0;border-radius:6px;color:rgba(74,63,176,.6);background:transparent;cursor:pointer;pointer-events:auto;opacity:.65}
.lw-ink-section-remove:hover{color:#b3261e;background:rgba(220,60,60,.12);opacity:1}
.lw-ink-section-rail{position:absolute;left:28px;width:2px;border-radius:2px;background:linear-gradient(180deg,rgba(104,85,217,.36),rgba(104,85,217,.08));pointer-events:none}
.lw-ink-section-guide{position:absolute;left:0;right:0;height:0;border-top:2px dashed #6855d9;pointer-events:none;transition:opacity .12s ease}
.lw-ink-section-guide span{position:absolute;left:14px;top:4px;padding:2px 7px;border-radius:6px;color:#fff;background:#5f4bcf;font:700 10px/1.3 var(--ui-font,system-ui);white-space:nowrap}
.lw-ink-sections .lw-selection-hint{top:18px}
.lw-drawing-board.is-inline:not(.is-input-active) .lw-ink-section-toggle,.lw-drawing-board.is-inline:not(.is-input-active) .lw-ink-section-remove{opacity:.5;box-shadow:none}
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
.lw-drafting-layer.is-translucent .lw-drafting-body{fill:rgba(226,233,244,.62)}
.lw-drafting-tool.is-pinned .lw-drafting-body{cursor:default}
.lw-drafting-window{fill:#f7f9fc;stroke:#5b6578;stroke-width:.8;pointer-events:none}
.lw-drafting-arm{fill:#cfd6e2;stroke:#2a3348;stroke-width:1.1;cursor:grab;pointer-events:auto}
.lw-drafting-edge{stroke:#1e6fd6;stroke-width:2.2;stroke-linecap:round;pointer-events:none}
.lw-drafting-tick{stroke:#2a3348;stroke-width:.8;pointer-events:none}
.lw-drafting-tick.is-major{stroke:#151a24;stroke-width:1.2}
.lw-drafting-label{fill:#1d2433;font:600 9px/1 var(--ui-font,system-ui);text-anchor:middle;pointer-events:none}
.lw-drafting-label.is-inner{fill:#3f4a60}
.lw-drafting-label.is-faint{fill:#6a7488}
.lw-drafting-unit{fill:#4a5670;font:600 8px/1 var(--ui-font,system-ui);text-anchor:end;pointer-events:none}
.lw-drafting-protractor{fill:none;stroke:#2a3348;stroke-width:1;pointer-events:none}
.lw-drafting-midline{stroke:#2a3348;stroke-width:1;stroke-dasharray:4 3;pointer-events:none}
.lw-drafting-parallel{stroke:rgba(42,51,72,.35);stroke-width:.7;pointer-events:none}
.lw-drafting-parallel.is-major{stroke:rgba(42,51,72,.6);stroke-width:.9}
.lw-drafting-caption{fill:#31405c;font:700 10px/1 var(--ui-font,system-ui);text-anchor:middle;pointer-events:none}
.lw-drafting-rotate{fill:#3a6ee8;stroke:#fff;stroke-width:1.5;cursor:alias;pointer-events:auto}
.lw-drafting-length{cursor:ew-resize;pointer-events:auto}
.lw-drafting-length-bg{fill:#e0b23c;stroke:#fff;stroke-width:1.5}
.lw-drafting-length-icon{fill:none;stroke:#1a1f2a;stroke-width:1.5;stroke-linecap:round;pointer-events:none}
.lw-drafting-pin{pointer-events:none}
.lw-drafting-pin-bg{fill:#c45b2d;stroke:#fff;stroke-width:1.2}
.lw-drafting-pin-icon{fill:#fff}
.lw-drafting-compass-ghost{fill:none;stroke:#1e6fd6;stroke-width:1.35;stroke-dasharray:5 4;opacity:.5;pointer-events:none}
.lw-drafting-centre-mark{fill:none;stroke:#1e6fd6;stroke-width:1.2;opacity:.7;pointer-events:none}
.lw-drafting-compass-arc{fill:none;stroke:#1ea86a;stroke-width:2.6;stroke-linecap:round;pointer-events:none}
.lw-drafting-span{stroke:rgba(30,111,214,.35);stroke-width:1.1;stroke-dasharray:3 3;pointer-events:none}
.lw-drafting-needle{fill:none;stroke:#1a1f2a;stroke-width:1.6;cursor:grab;pointer-events:auto}
.lw-drafting-needle-dot{fill:#111;pointer-events:none}
.lw-drafting-radius{fill:#f3c14e;stroke:#fff;stroke-width:1.5;cursor:ew-resize;pointer-events:auto}
.lw-drafting-draw{fill:#1ea86a;stroke:#fff;stroke-width:1.6;cursor:alias;pointer-events:auto}
.lw-drafting-action{cursor:pointer;pointer-events:auto}
.lw-drafting-action-bg{fill:#3a6ee8;stroke:#fff;stroke-width:1.2}
.lw-drafting-action.is-locked .lw-drafting-action-bg{fill:#c45b2d}
.lw-drafting-action.is-circle .lw-drafting-action-bg{fill:#1e6fd6}
.lw-drafting-action.is-flip .lw-drafting-action-bg{fill:#5b6578}
.lw-drafting-action-icon{fill:#fff;pointer-events:none}
.lw-drafting-action-icon-stroke{fill:none;stroke:#fff;stroke-width:1.4;stroke-linejoin:round;pointer-events:none}
.lw-drafting-action-icon-ring{fill:none;stroke:#fff;stroke-width:1.6;pointer-events:none}
.lw-drafting-readout{pointer-events:none}
.lw-drafting-readout-bg{fill:rgba(21,48,90,.92);stroke:rgba(255,255,255,.7);stroke-width:1}
.lw-drafting-readout-text{fill:#fff;font:700 12px/1 var(--ui-font,system-ui);text-anchor:middle;font-variant-numeric:tabular-nums}
.lw-drafting-panel{position:relative;z-index:13;flex:0 0 auto;display:flex;flex-direction:column;gap:8px;margin:10px 14px 0;padding:11px;border:1px solid color-mix(in srgb,var(--draw-accent) 36%,var(--draw-border));border-radius:16px;background:linear-gradient(145deg,color-mix(in srgb,var(--background-secondary,#19191f) 96%,var(--draw-accent) 4%),color-mix(in srgb,var(--background,#111116) 94%,transparent));box-shadow:0 22px 65px rgba(0,0,0,.24),inset 0 1px rgba(255,255,255,.035);color:var(--text,#fff);font-size:11px;animation:lw-art-studio-in .24s cubic-bezier(.2,.8,.2,1)}
.lw-drafting-panel.is-viewport-chrome{position:fixed;z-index:79;top:78px;right:14px;left:auto;width:min(420px,calc(100vw - 28px));max-height:calc(100vh - 170px);margin:0;overflow:auto;background:color-mix(in srgb,var(--background-secondary,#17171d) 95%,transparent);backdrop-filter:blur(18px);pointer-events:auto}
.lw-drafting-panel-head{display:flex;align-items:center;gap:8px}
.lw-drafting-panel-head>span{width:29px;height:29px;display:grid;place-items:center;border-radius:9px;color:var(--on-accent,#111);background:var(--draw-accent)}
.lw-drafting-panel-head>div{display:flex;min-width:0;flex:1;flex-direction:column}
.lw-drafting-panel-head strong{font-size:11px}
.lw-drafting-panel-head small{color:var(--text-muted,#999);font-size:8px}
.lw-drafting-group{display:flex;flex-direction:column;gap:6px;padding:8px 9px;border:1px solid var(--draw-border);border-radius:12px;background:color-mix(in srgb,var(--background,#111116) 54%,transparent)}
.lw-drafting-group>header{display:flex;align-items:center;gap:7px;min-height:26px}
.lw-drafting-group>header>span{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;color:var(--draw-accent);background:color-mix(in srgb,var(--draw-accent) 14%,transparent)}
.lw-drafting-group>header strong{font-size:11px}
.lw-drafting-group>header small{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-muted,#999);font-size:9px}
.lw-drafting-group-actions{display:flex;gap:2px}
.lw-drafting-group-actions .lw-draw-icon{width:26px;height:26px;color:var(--text-muted,#999)}
.lw-drafting-group-actions .lw-draw-icon.is-active{color:#fff;background:#c45b2d}
.lw-drafting-rows{display:flex;flex-direction:column;gap:6px}
.lw-drafting-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px}
.lw-drafting-segment{display:flex;align-items:center;gap:6px}
.lw-drafting-segment>span,.lw-drafting-field>span{color:var(--text-muted,#9999a7);font-size:10px;white-space:nowrap}
.lw-drafting-panel .lw-segmented{display:flex;padding:2px;border-radius:9px}
.lw-drafting-panel .lw-segmented button{height:24px;padding:0 8px;font-size:10px;white-space:nowrap}
.lw-drafting-field{display:flex;align-items:center;gap:5px}
.lw-drafting-field input{width:64px;height:26px;padding:0 6px;border:1px solid var(--draw-border);border-radius:7px;background:color-mix(in srgb,var(--background-secondary,#17171d) 82%,transparent);color:var(--text,#fff);font:inherit;font-size:11px;font-variant-numeric:tabular-nums}
.lw-drafting-field input:focus{outline:2px solid color-mix(in srgb,var(--draw-accent) 55%,transparent);outline-offset:1px}
.lw-drafting-field small{color:var(--text-muted,#9999a7);font-size:10px}
.lw-drafting-toggle{display:flex;align-items:center;gap:6px;height:26px;padding:0 8px 0 5px;border:1px solid var(--draw-border);border-radius:8px;background:transparent;color:var(--text-muted,#9999a7);font:inherit;font-size:10px;white-space:nowrap;cursor:pointer}
.lw-drafting-toggle>i{position:relative;width:22px;height:12px;border-radius:7px;background:color-mix(in srgb,var(--text,#fff) 18%,transparent);transition:background .16s ease}
.lw-drafting-toggle>i::after{content:"";position:absolute;top:1px;left:1px;width:10px;height:10px;border-radius:50%;background:#fff;transition:transform .16s ease}
.lw-drafting-toggle.is-active{color:var(--text,#fff);border-color:color-mix(in srgb,var(--draw-accent) 45%,var(--draw-border))}
.lw-drafting-toggle.is-active>i{background:var(--draw-accent)}
.lw-drafting-toggle.is-active>i::after{transform:translateX(10px)}
.lw-drafting-panel .lw-draw-subtle{height:26px;padding:0 9px;font-size:10px}
.lw-drafting-direction-icon{display:grid;place-items:center;color:var(--text-muted,#9999a7)}
.lw-drafting-panel-foot{color:var(--text-muted,#8b8b99);font-size:9px;line-height:1.4}
.lw-drawing-board.is-inline:not(.is-input-active) .lw-drafting-panel{display:none!important}.lw-tablet-canvas-committed{z-index:1;pointer-events:none}.lw-tablet-canvas-live{z-index:2;pointer-events:auto}.lw-tablet-canvas.tool-pen,.lw-tablet-canvas.tool-select{cursor:crosshair}.lw-tablet-canvas.tool-eraser{cursor:cell}.lw-tablet-canvas:focus-visible{box-shadow:inset 0 0 0 2px var(--draw-accent)}.lw-selection-hint{position:absolute;z-index:3;top:18px;left:50%;display:flex;align-items:center;gap:7px;padding:8px 11px;transform:translateX(-50%);border:1px solid rgba(86,71,183,.32);border-radius:9px;color:#28233d;background:rgba(255,255,255,.92);box-shadow:0 8px 24px rgba(39,31,85,.18);font:700 11px/1.2 var(--ui-font,system-ui);pointer-events:none;white-space:nowrap}.lw-selection-rect{position:absolute;z-index:3;min-width:2px;min-height:2px;border:2px dashed #6855d9;background:rgba(104,85,217,.1);box-shadow:0 0 0 9999px rgba(38,35,55,.08);pointer-events:none}.lw-selection-rect.is-editable{pointer-events:auto;cursor:move;box-shadow:0 0 0 2px rgba(104,85,217,.2)}.lw-selection-scale{position:absolute;right:-6px;bottom:-6px;width:13px;height:13px;border-radius:3px;background:#5f4bcf;cursor:nwse-resize}.lw-selection-rect.is-selected{border-style:solid;background:rgba(104,85,217,.07);box-shadow:0 0 0 9999px rgba(38,35,55,.04),0 0 0 3px rgba(104,85,217,.14)}.lw-selection-rect span{position:absolute;bottom:calc(100% + 5px);left:-2px;padding:3px 7px;border-radius:6px;color:#fff;background:#5f4bcf;font:700 9px/1.3 var(--ui-font,system-ui);white-space:nowrap}.lw-canvas-meta{display:flex;align-items:center;justify-content:space-between;padding:7px 3px 0;color:var(--text-muted,#9292a0);font-size:10px}.lw-canvas-meta span{display:flex;align-items:center;gap:6px}.lw-pressure-dot{width:6px;height:6px;border-radius:50%;background:#4bd7a4;box-shadow:0 0 7px #4bd7a4}
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

.lw-drawing-board.is-inline{position:absolute;z-index:4;inset:calc(-1 * var(--paper-scroll-room, 0px));height:auto;min-height:100%;overflow:visible;background:transparent;pointer-events:none} /* extra paper around the write page */
.lw-drawing-board.is-inline:not(.is-input-active),.lw-drawing-board.is-inline:not(.is-input-active) *{pointer-events:none!important}
.lw-drawing-board.is-inline:not(.is-input-active) .lw-conversion-panel,.lw-drawing-board.is-inline:not(.is-input-active) .lw-draw-notice,.lw-drawing-board.is-inline:not(.is-input-active) .lw-art-studio{display:none!important}
.lw-drawing-board.is-inline.is-input-active{pointer-events:auto}
.lw-drawing-board.is-inline.is-input-active .lw-draw-workspace{pointer-events:auto}
.lw-drawing-board.is-inline.is-input-active .lw-canvas-shell{pointer-events:auto}
.lw-drawing-board.is-inline .lw-draw-header{display:none}
.lw-drawing-board.is-inline .lw-draw-footer{display:none}
.lw-drawing-board.is-inline .lw-draw-workspace{position:absolute;inset:0;display:block;min-height:100%;padding:0;pointer-events:none}
.lw-drawing-board.is-inline .lw-canvas-shell{position:absolute;inset:0;display:block;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;pointer-events:none}
.lw-drawing-board.is-inline .lw-canvas-glow,.lw-drawing-board.is-inline .lw-canvas-meta{display:none}
.lw-drawing-board.is-inline .lw-canvas-surface{position:absolute;inset:0;width:auto;height:auto;min-width:0;min-height:0;aspect-ratio:auto;margin:0;overflow:visible;border-radius:0;background:transparent;box-shadow:none;will-change:auto;pointer-events:none}
.lw-drawing-board.is-inline.is-input-active .lw-canvas-surface{pointer-events:auto}
.lw-drawing-board.is-inline .lw-tablet-canvas{position:absolute;inset:var(--paper-scroll-room, 0px);width:auto;height:auto;pointer-events:none}
.lw-drawing-board.is-inline .lw-tablet-canvas.is-input-active{pointer-events:none}
/* The tool layer shares the ink's box (the page, not the scroll room around it): pose 0–1 × page == pen 0–1 × page. Explicit size: svg is a replaced element. */
.lw-drawing-board.is-inline .lw-drafting-layer{inset:var(--paper-scroll-room, 0px);width:calc(100% - 2 * var(--paper-scroll-room, 0px));height:calc(100% - 2 * var(--paper-scroll-room, 0px))}
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
