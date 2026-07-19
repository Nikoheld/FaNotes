import {
  Calculator,
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
  Save,
  ScanSearch,
  Shapes,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  forwardRef,
  memo,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { BASE_CATALOG } from '../../../src/data/catalog'
import type {
  AutomaticRecognitionResult,
  RecognitionToken,
} from '../../../src/lib/recognition'
import type { Stroke, StrokePoint } from '../../../src/types'
import type { AppSettings, DrawingAsset, PaperStyle } from '../types'
import { TextToHandwritingDialog } from './TextToHandwritingDialog'
import type {
  CorrectionLearningResult,
  RecognitionResources,
} from '../lib/handwritingDb'
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
const EXPORT_SCALE = 2
const MAX_DPR = 3

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
type SelectionPurpose = 'conversion' | 'math-correction'
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
}

export type DrawingBoardProps = {
  settings: Pick<
    AppSettings,
    | 'paperStyle'
    | 'penColor'
    | 'penWidth'
    | 'pressureEnabled'
    | 'smoothing'
    | 'scribbleEraseSensitivity'
    | 'recognitionMode'
    | 'lastRecognitionMode'
    | 'recognitionLanguage'
    | 'enhancedMathRecognition'
    | 'enhancedMathLicenseAccepted'
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
}

type Notice = { kind: 'success' | 'error' | 'info'; text: string }

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

const paperLabel: Record<PaperStyle, string> = {
  blank: 'Blanko',
  dots: 'Punkte',
  grid: 'Kariert',
  lines: 'Liniert',
}

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
  context.save()
  context.fillStyle = '#fbfcff'
  context.fillRect(0, 0, width, height)
  context.strokeStyle = 'rgba(103, 116, 147, .145)'
  context.fillStyle = 'rgba(92, 107, 142, .28)'
  context.lineWidth = Math.max(1, width / SOURCE_WIDTH * 0.7)
  const step = width / SOURCE_WIDTH * 32

  if (style === 'dots') {
    const radius = Math.max(0.8, width / SOURCE_WIDTH * 1.05)
    for (let y = step; y < height; y += step) {
      for (let x = step; x < width; x += step) {
        context.beginPath()
        context.arc(x, y, radius, 0, Math.PI * 2)
        context.fill()
      }
    }
  } else if (style === 'grid') {
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
  }
  context.restore()
}

const drawInkStroke = (
  context: CanvasRenderingContext2D,
  stroke: InkStroke,
  width: number,
  height: number,
  smoothing: number,
  startSegment = 1,
) => {
  if (stroke.points.length === 0) return
  const first = stroke.points[0]
  const scale = width / SOURCE_WIDTH
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
) => {
  const context = canvas.getContext('2d')
  if (!context) return
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  if (includePaper) drawPaper(context, width, height, paperStyle)
  strokes.forEach((stroke) => drawInkStroke(context, stroke, width, height, smoothing))
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

const isShortTapStroke = (stroke: InkStroke, sourceHeight: number) => {
  if (!stroke.points.length) return false
  const width = (Math.max(...stroke.points.map((point) => point.x)) - Math.min(...stroke.points.map((point) => point.x))) * SOURCE_WIDTH
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

const distanceToSegment = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) => {
  const dx = bx - ax
  const dy = by - ay
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay)
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

type StrokeBounds = { left: number; right: number; top: number; bottom: number }
const strokeBoundsCache = new WeakMap<InkStroke, StrokeBounds>()

const strokeBounds = (stroke: InkStroke, sourceHeight: number): StrokeBounds => {
  const cached = strokeBoundsCache.get(stroke)
  if (cached) return cached
  const padding = stroke.baseWidth / 2
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  stroke.points.forEach((point) => {
    const px = point.x * SOURCE_WIDTH
    const py = point.y * sourceHeight
    left = Math.min(left, px - padding)
    right = Math.max(right, px + padding)
    top = Math.min(top, py - padding)
    bottom = Math.max(bottom, py + padding)
  })
  const bounds = { left, right, top, bottom }
  strokeBoundsCache.set(stroke, bounds)
  return bounds
}

const strokeTouchesEraser = (stroke: InkStroke, x: number, y: number, radius: number, sourceHeight: number) => {
  const points = stroke.points
  if (!points.length) return false
  const bounds = strokeBounds(stroke, sourceHeight)
  if (
    x + radius < bounds.left || x - radius > bounds.right ||
    y + radius < bounds.top || y - radius > bounds.bottom
  ) return false
  if (points.length === 1) {
    return Math.hypot(points[0].x * SOURCE_WIDTH - x, points[0].y * sourceHeight - y) <= radius + stroke.baseWidth / 2
  }
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const point = points[index]
    if (distanceToSegment(
      x,
      y,
      previous.x * SOURCE_WIDTH,
      previous.y * sourceHeight,
      point.x * SOURCE_WIDTH,
      point.y * sourceHeight,
    ) <= radius + stroke.baseWidth / 2) return true
  }
  return false
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
}: DrawingBoardProps, forwardedRef) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const committedCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const committedCanvasKeyRef = useRef('')
  const committedCanvasDirtyRef = useRef(true)
  const canvasPixelSizeRef = useRef({ width: 0, height: 0 })
  const pointerBoundsRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null)
  const exportCacheRef = useRef<{ key: string; imageData: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const strokesRef = useRef<InkStroke[]>([])
  const activeStrokeRef = useRef<InkStroke | null>(null)
  const activePointerRef = useRef<number | null>(null)
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
  const lastPenContactRef = useRef(0)
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
  const [paperStyle, setPaperStyle] = useState(settings.paperStyle)
  const [sourceHeight, setSourceHeight] = useState(SOURCE_HEIGHT)
  const [eraserSize, setEraserSize] = useState(24)
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
    setPaperStyle(settings.paperStyle)
    setMode(settings.recognitionMode)
    if (settings.recognitionMode === 'auto') {
      if (!tokens.length) setRecognizedMode(settings.lastRecognitionMode)
    } else {
      setRecognizedMode(settings.recognitionMode)
      setAutomaticResult(null)
    }
  }, [settings.lastRecognitionMode, settings.paperStyle, settings.penColor, settings.penWidth, settings.recognitionMode, tokens.length])

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
      const sourceRatio = SOURCE_WIDTH / sourceHeight
      const width = Math.min(availableWidth, availableHeight * sourceRatio)
      const height = width / sourceRatio
      const cssWidth = `${Math.round(width)}px`
      const cssHeight = `${Math.round(height)}px`
      if (surface.style.width !== cssWidth) surface.style.width = cssWidth
      if (surface.style.height !== cssHeight) surface.style.height = cssHeight
    }
    if (measureLayout || !canvasPixelSizeRef.current.width) {
      const rect = surface.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      canvasPixelSizeRef.current = {
        width: Math.max(1, Math.round(rect.width * dpr)),
        height: Math.max(1, Math.round(rect.height * dpr)),
      }
    }
    const { width: pixelWidth, height: pixelHeight } = canvasPixelSizeRef.current
    if (!pixelWidth || !pixelHeight) return
    const liveCanvasResized = canvas.width !== pixelWidth || canvas.height !== pixelHeight
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight
    if (liveCanvasResized) {
      activeRenderedPointCountRef.current = 0
      liveCanvasHasInkRef.current = false
    }
    if (committedCanvas.width !== pixelWidth) committedCanvas.width = pixelWidth
    if (committedCanvas.height !== pixelHeight) committedCanvas.height = pixelHeight

    const cacheKey = [pixelWidth, pixelHeight, paperStyle, settings.smoothing, sourceHeight, inline].join(':')
    if (committedCanvasDirtyRef.current || committedCanvasKeyRef.current !== cacheKey) {
      renderDocument(committedCanvas, strokesRef.current, paperStyle, settings.smoothing, pixelWidth, pixelHeight, !inline)
      committedCanvasKeyRef.current = cacheKey
      committedCanvasDirtyRef.current = false
    }

    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(1, 0, 0, 1, 0, 0)
    const activeStroke = activeStrokeRef.current
    if (!activeStroke) {
      if (liveCanvasHasInkRef.current) context.clearRect(0, 0, pixelWidth, pixelHeight)
      activeRenderedPointCountRef.current = 0
      liveCanvasHasInkRef.current = false
      return
    }
    if (activeRenderedPointCountRef.current === 0 && liveCanvasHasInkRef.current) {
      context.clearRect(0, 0, pixelWidth, pixelHeight)
      liveCanvasHasInkRef.current = false
    }
    if (activeStroke.points.length > activeRenderedPointCountRef.current) {
      drawInkStroke(
        context,
        activeStroke,
        pixelWidth,
        pixelHeight,
        settings.smoothing,
        Math.max(1, activeRenderedPointCountRef.current),
      )
      activeRenderedPointCountRef.current = activeStroke.points.length
      liveCanvasHasInkRef.current = true
    }
  }, [inline, paperStyle, settings.smoothing, sourceHeight])

  const commitStrokeToCanvas = useCallback((stroke: InkStroke) => {
    const canvas = committedCanvasRef.current
    const { width, height } = canvasPixelSizeRef.current
    if (!canvas || !width || !height || committedCanvasDirtyRef.current) return
    const context = canvas.getContext('2d')
    if (!context) return
    drawInkStroke(context, stroke, width, height, settings.smoothing)
  }, [settings.smoothing])

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
    mountedRef.current = true
    const observer = new ResizeObserver(() => redraw(true))
    if (surfaceRef.current) observer.observe(surfaceRef.current)
    if (surfaceRef.current?.parentElement) observer.observe(surfaceRef.current.parentElement)
    redraw(true)
    return () => {
      mountedRef.current = false
      observer.disconnect()
      if (drawFrameRef.current !== null) cancelAnimationFrame(drawFrameRef.current)
      if (pendingSolverTapRef.current) window.clearTimeout(pendingSolverTapRef.current.timer)
    }
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
      if (raw.paperStyle && raw.paperStyle in paperLabel) setPaperStyle(raw.paperStyle)
      if (typeof raw.sourceHeight === 'number' && raw.sourceHeight >= 400 && raw.sourceHeight <= 2_000) {
        setSourceHeight(raw.sourceHeight)
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
      setNotice({ kind: 'error', text: 'Die gespeicherte Zeichnung konnte nicht gelesen werden.' })
    }
  }, [bumpInkRevision, clearRecognitionScope, drawingId, initialDrawingJson, setDirty, updateHistoryState])

  useEffect(() => {
    if (!initialDrawingJson && !mathSolverHistoryRef.current.length) {
      mathSolverHistoryRef.current = sharedMathSolverHistory()
    }
  }, [initialDrawingJson])

  const pointFromEvent = useCallback((event: PointerEvent): StrokePoint => {
    const rect = pointerBoundsRef.current ?? canvasRef.current!.getBoundingClientRect()
    const rawPressure = event.pressure > 0 ? event.pressure : event.pointerType === 'mouse' ? 0.55 : 0.35
    return {
      x: clamp((event.clientX - rect.left) / rect.width),
      y: clamp((event.clientY - rect.top) / rect.height),
      t: Math.round(event.timeStamp * 100) / 100,
      pressure: Math.round(clamp(rawPressure) * 1_000) / 1_000,
      tiltX: event.tiltX ?? 0,
      tiltY: event.tiltY ?? 0,
      pointerType: event.pointerType || 'mouse',
    }
  }, [])

  const eraseAt = useCallback((value: StrokePoint | StrokePoint[]) => {
    const before = strokesRef.current.length
    const points = Array.isArray(value) ? value : [value]
    const eraserPoints = points.map((point) => ({ x: point.x * SOURCE_WIDTH, y: point.y * sourceHeight }))
    strokesRef.current = strokesRef.current.filter((stroke) => !eraserPoints.some((point) => (
      strokeTouchesEraser(stroke, point.x, point.y, eraserSize, sourceHeight)
    )))
    if (strokesRef.current.length !== before) {
      gestureChangedRef.current = true
      committedCanvasDirtyRef.current = true
      scheduleRedraw()
    }
  }, [eraserSize, scheduleRedraw, sourceHeight])

  const appendPointerEvent = useCallback((event: PointerEvent) => {
    const point = pointFromEvent(event)
    if (gestureToolRef.current === 'eraser') {
      eraseAt(point)
      return
    }
    const stroke = activeStrokeRef.current
    if (!stroke) return
    const previous = stroke.points.at(-1)
    if (previous) {
      const distance = Math.hypot(
        (point.x - previous.x) * SOURCE_WIDTH,
        (point.y - previous.y) * sourceHeight,
      )
      if (distance < 0.35) return
    }
    stroke.points.push(point)
    gestureChangedRef.current = true
    scheduleRedraw()
  }, [eraseAt, pointFromEvent, scheduleRedraw, sourceHeight])

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
    const groups = groupMathInkLines(selectedStrokes, { width: SOURCE_WIDTH, height: sourceHeight })
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
      width: SOURCE_WIDTH,
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

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== null || (event.button !== 0 && event.pointerType !== 'pen')) return
    if (event.pointerType === 'touch' && performance.now() - lastPenContactRef.current < 850) return
    if (event.pointerType === 'pen') lastPenContactRef.current = performance.now()
    event.preventDefault()
    // User input always wins over cooperative background transcription.
    contextualLearningRunRef.current += 1
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
    activePointerRef.current = event.pointerId
    const pointerRect = event.currentTarget.getBoundingClientRect()
    pointerBoundsRef.current = {
      left: pointerRect.left,
      top: pointerRect.top,
      width: pointerRect.width,
      height: pointerRect.height,
    }
    const firstPoint = pointFromEvent(event.nativeEvent)
    const pointerEraser = event.pointerType === 'pen' && (event.button === 5 || (event.buttons & 32) !== 0)
    const pendingTap = pendingSolverTapRef.current
    if (pendingTap) {
      const elapsed = performance.now() - pendingTap.at
      const distance = Math.hypot(
        (firstPoint.x - pendingTap.point.x) * SOURCE_WIDTH,
        (firstPoint.y - pendingTap.point.y) * sourceHeight,
      )
      if (mathSolverEnabled && inkMode === 'writing' && !pointerEraser && tool === 'pen' && elapsed <= 430 && distance <= 34) {
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
      selectionStartRef.current = firstPoint
      recognitionStrokesRef.current = null
      setSelectionRect({ x: firstPoint.x, y: firstPoint.y, width: 0, height: 0 })
      return
    }
    if (inkMode === 'drawing' && tool === 'pen' && !pointerEraser && activeArtSymbol) {
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
      pointerBoundsRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      setNotice({ kind: 'success', text: `${activeArtSymbol.label} eingefügt · tippe erneut für weitere.` })
      scheduleRedraw()
      return
    }
    clearRecognitionScope()
    closeMathSolverSelection()
    closeMathCorrectionSession()
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
    }
    appendPointerEvent(event.nativeEvent)
  }, [activeArtBrush.pressure, activeArtSymbol, appendPointerEvent, artBrush, artColor, artEffect, artOpacity, artSymbolRotation, artSymbolSize, artWidth, bumpInkRevision, clearRecognitionScope, closeMathCorrectionSession, closeMathSolverSelection, commitPendingSolverTap, commitStrokeToCanvas, inkMode, mathSolverEnabled, penColor, penWidth, pointFromEvent, scheduleRedraw, selectionMode, setDirty, settings.pressureEnabled, sourceHeight, tool, updateHistoryState])

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== event.pointerId) return
    event.preventDefault()
    if (selectionStartRef.current) {
      setSelectionRect(selectionBetween(selectionStartRef.current, pointFromEvent(event.nativeEvent)))
      return
    }
    if (event.pointerType === 'pen') lastPenContactRef.current = performance.now()
    const events = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent]
    if (gestureToolRef.current === 'eraser') {
      eraseAt(events.map(pointFromEvent))
    } else {
      events.forEach(appendPointerEvent)
    }
  }, [appendPointerEvent, eraseAt, pointFromEvent])

  const finishPointer = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== event.pointerId) return
    event.preventDefault()
    const finalPoint = pointFromEvent(event.nativeEvent)
    pointerBoundsRef.current = null
    if (selectionStartRef.current) {
      const start = selectionStartRef.current
      const selection = selectionBetween(start, finalPoint)
      selectionStartRef.current = null
      activePointerRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
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
      activePointerRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      if (event.type !== 'pointercancel') void openMathSolverAtPoint(point)
      scheduleRedraw()
      return
    }
    appendPointerEvent(event.nativeEvent)
    const activeStroke = activeStrokeRef.current
    if (
      mathSolverEnabled
      && inkMode === 'writing'
      && gestureToolRef.current === 'pen'
      && event.type !== 'pointercancel'
      && activeStroke?.points.length
      && isShortTapStroke(activeStroke, sourceHeight)
    ) {
      const finalPoint = activeStroke.points.at(-1)!
      const pending: PendingSolverTap = {
        stroke: activeStroke,
        snapshot: beforeGestureRef.current,
        point: finalPoint,
        at: performance.now(),
        timer: 0,
      }
      activeStrokeRef.current = null
      activePointerRef.current = null
      gestureChangedRef.current = false
      pending.timer = window.setTimeout(commitPendingSolverTap, 420)
      pendingSolverTapRef.current = pending
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
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
        { width: SOURCE_WIDTH, height: sourceHeight },
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
    activePointerRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
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
      }
    }
    scheduleRedraw()
  }, [analyzeMathCorrectionSelection, appendPointerEvent, bumpInkRevision, commitPendingSolverTap, commitStrokeToCanvas, inkMode, mathSolverEnabled, mode, openMathSolverAtPoint, pointFromEvent, scheduleRedraw, selectionPurpose, setDirty, settings.scribbleEraseSensitivity, sourceHeight, updateHistoryState])

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
  }, [bumpInkRevision, clearRecognitionScope, closeMathCorrectionSession, closeMathSolverSelection, scheduleRedraw, setDirty, updateHistoryState])

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
  }, [bumpInkRevision, clearRecognitionScope, closeMathCorrectionSession, closeMathSolverSelection, setDirty, updateHistoryState])

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
  }, [bumpInkRevision, clearRecognitionScope, closeMathCorrectionSession, closeMathSolverSelection, setDirty, updateHistoryState])

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
  }, [bumpInkRevision, clearRecognitionScope, scheduleRedraw, setDirty, updateHistoryState])

  const drawingPayload = useCallback((includeImage = false): DrawingSavePayload => {
    let imageData: string | undefined
    if (includeImage) {
      const exportKey = [inkRevisionRef.current, paperStyle, settings.smoothing, sourceHeight].join(':')
      imageData = exportCacheRef.current?.key === exportKey ? exportCacheRef.current.imageData : undefined
      if (!imageData) {
      const exportCanvas = document.createElement('canvas')
      exportCanvas.width = SOURCE_WIDTH * EXPORT_SCALE
      exportCanvas.height = sourceHeight * EXPORT_SCALE
      renderDocument(
        exportCanvas,
        strokesRef.current,
        paperStyle,
        settings.smoothing,
        exportCanvas.width,
        exportCanvas.height,
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
      sourceWidth: SOURCE_WIDTH,
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
  }, [activeMode, mathSolverEnabled, mode, paperStyle, settings.smoothing, sourceHeight, title])

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
  }), [drawingPayload, onSaveDrawing, setDirty])

  useEffect(() => () => {
    if (dirtyRef.current && strokesRef.current.length) void saveLatestRef.current()
  }, [])

  const recognize = useCallback(async (
    requestedMode: RecognitionPreference = mode,
    scopedStrokes?: InkStroke[],
  ) => {
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

      if (requestedMode !== 'math') {
        try {
          const { recognizeNeuralText } = await import('../lib/neuralTextRecognition')
          const neural = await recognizeNeuralText(
            engineStrokes,
            settings.recognitionLanguage,
            SOURCE_WIDTH,
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
              SOURCE_WIDTH,
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
          const image = renderEnhancedMathImage(engineStrokes, SOURCE_WIDTH, sourceHeight)
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
      setTokens(enhancedMathUsed ? [] : recognized)
      setWholeFormulaResult(enhancedMathUsed)
      setCorrection(value)
      setConversionOpen(true)
      const contextChanges = recognized.filter((token) => token.context?.changed).length
      if (resolvedMode === 'text' && neuralTextFailure && !neuralTextUsed) {
        setNotice({
          kind: 'info',
          text: `${neuralTextFailure} FaNotes verwendet vorübergehend die klassische Erkennung.`,
        })
      } else if (resolvedMode === 'math' && enhancedMathFailure) {
        setNotice({
          kind: 'info',
          text: `${enhancedMathFailure} FaNotes verwendet für diese Eingabe die klassische lokale Mathematikerkennung.`,
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
  }, [mode, onSettingsChange, settings.enhancedMathLicenseAccepted, settings.enhancedMathRecognition, settings.lastRecognitionMode, settings.recognitionLanguage, sourceHeight])

  useEffect(() => {
    recognizeLatestRef.current = recognize
  }, [recognize])

  const recognizePage = useCallback(() => {
    closeMathSolverSelection()
    closeMathCorrectionSession()
    setMathCorrectorEnabled(false)
    recognitionStrokesRef.current = null
    setRecognitionScope('page')
    setSelectionMode(false)
    setSelectionRect(null)
    setConversionOpen(true)
    void recognize(mode, handwritingStrokes(strokesRef.current))
  }, [closeMathCorrectionSession, closeMathSolverSelection, mode, recognize])

  const beginSelectionRecognition = useCallback(() => {
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
    requestAnimationFrame(() => canvasRef.current?.focus())
  }, [closeMathCorrectionSession, closeMathSolverSelection])

  const updateHiddenTranscript = useCallback(async () => {
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
              SOURCE_WIDTH,
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
                SOURCE_WIDTH,
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
  }, [activeMode, mode, settings.lastRecognitionMode, settings.recognitionLanguage, sourceHeight])

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
      const selectionLeft = selection.rect.x * SOURCE_WIDTH
      const selectionRight = (selection.rect.x + selection.rect.width) * SOURCE_WIDTH
      const selectionTop = selection.rect.y * sourceHeight
      const selectionBottom = (selection.rect.y + selection.rect.height) * sourceHeight
      const estimatedResultWidth = continuationText(result, 'same-line').length * fontSize * 0.48
      let placement: Exclude<MathSolverPlacement, 'auto'> = mathSolverPlacement === 'auto'
        ? previousFormat?.placement
          ?? (action === 'solve' || result.normalizedInput.includes('=') || selectionRight + estimatedResultWidth + 52 > SOURCE_WIDTH
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
            ? synthesizeHandwriting(text, loaded.samples, options, { width: SOURCE_WIDTH, height: sourceHeight })
            : synthesizeHandwritingToFit(text, loaded.samples, options, { width: SOURCE_WIDTH, height: sourceHeight }, 18),
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
  }, [bumpRevision, clearRecognitionScope, closeMathCorrectionSession, closeMathSolverSelection, commitPendingSolverTap, mathSolverEnabled, selectionPurpose, setDirty])

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
    requestAnimationFrame(() => canvasRef.current?.focus())
  }, [bumpRevision, closeMathCorrectionSession, closeMathSolverSelection, commitPendingSolverTap, mathSolverEnabled, setDirty])

  const toggleMathCorrector = useCallback(() => {
    if (!mathCorrectorEnabled) {
      beginMathCorrectionSelection()
      return
    }
    setMathCorrectorEnabled(false)
    closeMathCorrectionSession()
    if (selectionPurpose === 'math-correction') clearRecognitionScope()
    setNotice({ kind: 'info', text: 'Mathematik-Korrigierer ausgeschaltet.' })
  }, [beginMathCorrectionSelection, clearRecognitionScope, closeMathCorrectionSession, mathCorrectorEnabled, selectionPurpose])

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
    onSettingsChange?.({ paperStyle: next })
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
    requestAnimationFrame(() => canvasRef.current?.focus())
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
    if (!(event.ctrlKey || event.metaKey)) return
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
    <section className={`lw-drawing-board ${inline ? 'is-inline' : ''} ${inputActive ? 'is-input-active' : ''} ${inkMode === 'drawing' ? 'is-art-mode' : 'is-writing-mode'} ${className}`} onKeyDown={handleKeyboard}>
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

      <div className="lw-draw-toolbar" aria-label="Zeichenwerkzeuge">
        <div className="lw-draw-toolgroup lw-segmented">
          <button type="button" className={tool === 'pen' && inkMode === 'writing' ? 'is-active' : ''} aria-pressed={tool === 'pen' && inkMode === 'writing'} title="Handschrift schreiben oder vorhandene Wörter mehrfach durchkritzeln" onClick={activateWriting}>
            <PenLine size={16} /> Schreiben
          </button>
          <button type="button" className={tool === 'pen' && inkMode === 'drawing' ? 'is-active' : ''} aria-pressed={tool === 'pen' && inkMode === 'drawing'} title="Zeichenstudio mit Pinseln und Spezialfarben öffnen" onClick={activateDrawing}>
            <Paintbrush size={16} /> Zeichnen
          </button>
          <button type="button" className={tool === 'eraser' ? 'is-active' : ''} aria-pressed={tool === 'eraser'} onClick={activateEraser}>
            <Eraser size={16} /> Radierer
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
            <Type size={16} /> Text → Handschrift
          </button>
          <button
            type="button"
            className={mathSolverEnabled ? 'is-active' : ''}
            aria-pressed={mathSolverEnabled}
            title="Mathematik-Löser ein- oder ausschalten; danach einen Ausdruck doppeltippen"
            onClick={toggleMathSolver}
          >
            <Calculator size={16} /> Mathe-Löser
          </button>
          <button
            type="button"
            className={mathCorrectorEnabled ? 'is-active' : ''}
            aria-pressed={mathCorrectorEnabled}
            title="Rechenweg auswählen und den ersten falschen Schritt markieren"
            onClick={toggleMathCorrector}
          >
            <ListChecks size={16} /> Mathe-Korrigierer
          </button>
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

        <div className="lw-draw-toolgroup lw-history">
          <button type="button" className="lw-draw-icon" aria-label="Rückgängig" title="Rückgängig (Strg+Z)" onClick={undo} disabled={!canUndo}><Undo2 size={17} /></button>
          <button type="button" className="lw-draw-icon" aria-label="Wiederholen" title="Wiederholen (Strg+Umschalt+Z)" onClick={redo} disabled={!canRedo}><Redo2 size={17} /></button>
          <button type="button" className="lw-draw-icon lw-danger" aria-label="Alles löschen" title="Alles löschen" onClick={clear} disabled={!inkCount}><Trash2 size={17} /></button>
        </div>
      </div>

      {inkMode === 'drawing' && tool === 'pen' && artPanelOpen && <aside className="lw-art-studio" aria-label="Zeichenstudio">
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
      </aside>}

      <div className={`lw-draw-workspace ${conversionOpen ? 'has-conversion' : ''}`}>
        <div className="lw-canvas-shell">
          <div className="lw-canvas-glow" />
          <div ref={surfaceRef} className="lw-canvas-surface">
            <canvas ref={committedCanvasRef} className="lw-tablet-canvas lw-tablet-canvas-committed" aria-hidden="true" />
            <canvas
              ref={canvasRef}
              className={`lw-tablet-canvas lw-tablet-canvas-live ${selectionMode ? 'tool-select' : tool === 'pen' && inkMode === 'drawing' ? activeArtSymbol ? 'tool-stamp' : 'tool-art' : `tool-${tool}`} ${inputActive ? 'is-input-active' : ''}`}
              tabIndex={inputActive ? 0 : -1}
              aria-label={selectionMode
                ? selectionPurpose === 'math-correction' ? 'Rechenweg zur mathematischen Korrektur auswählen' : 'Bereich für Handschrifterkennung auswählen'
                : inkMode === 'drawing' ? activeArtSymbol ? `Piktogramm ${activeArtSymbol.label} auf Seite platzieren` : `Zeichenfläche mit ${activeArtBrush.label}` : 'Druckempfindliche Handschriftfläche'}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishPointer}
              onPointerCancel={finishPointer}
              onLostPointerCapture={finishPointer}
              onContextMenu={(event) => event.preventDefault()}
            />
            {selectionMode && !selectionRect && <div className={`lw-selection-hint ${selectionPurpose === 'math-correction' ? 'is-correction' : ''}`}>
              {selectionPurpose === 'math-correction' ? <ListChecks size={18} /> : <ScanSearch size={18} />}
              {selectionPurpose === 'math-correction' ? 'Rechenweg mit mehreren Zeilen auswählen' : 'Bereich auf der Seite aufziehen'}
            </div>}
            {selectionRect && <div
              className={`lw-selection-rect ${selectionMode ? 'is-selecting' : 'is-selected'}`}
              style={{
                left: `${selectionRect.x * 100}%`,
                top: `${selectionRect.y * 100}%`,
                width: `${selectionRect.width * 100}%`,
                height: `${selectionRect.height * 100}%`,
              }}
            ><span>{selectionMode
                ? selectionPurpose === 'math-correction' ? 'Rechenweg auswählen' : 'Auswählen'
                : 'Wird konvertiert'}</span></div>}
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
            <span>{handwritingCount ? `${handwritingCount} Handschrift` : ''}{handwritingCount && artCount ? ' · ' : ''}{artCount ? `${artCount} Zeichnung` : ''}{!inkCount ? 'Noch leer' : ''} · {sourceHeight === SOURCE_HEIGHT ? 'A4-Seite' : 'Zeichenfläche'}</span>
          </div>
        </div>

        {conversionOpen && <aside className="lw-conversion-panel" aria-label="Handschrift konvertieren">
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
        </aside>}
      </div>

      {notice && <div className={`lw-draw-notice is-${notice.kind}`} role="status">
        {notice.kind === 'success' ? <Check size={15} /> : notice.kind === 'error' ? <CircleAlert size={15} /> : <Sparkles size={15} />}
        <span>{notice.text}</span>
        <button type="button" aria-label="Hinweis schließen" onClick={() => setNotice(null)}><X size={14} /></button>
      </div>}

      <footer className="lw-draw-footer">
        {inkMode === 'writing' && knownTrainingSampleCount === 0 && <div>
          <button type="button" className="lw-draw-subtle" onClick={requestTraining} disabled={isImporting || isResettingTraining}>
            {isImporting ? <LoaderCircle className="lw-spin" size={15} /> : <Sparkles size={15} />}
            GlyphenWerk öffnen
          </button>
        </div>}
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void importTraining(file) }}
        />
        <div className="lw-footer-actions">
          <button type="button" className="lw-draw-subtle" onClick={() => void saveDrawing(true)} disabled={!inkCount || isSaving}>
            <Save size={15} /> Seite als Bild einfügen
          </button>
          {inkMode === 'writing' && <button type="button" className={`lw-draw-subtle ${selectionMode ? 'is-active' : ''}`} onClick={beginSelectionRecognition} disabled={!handwritingCount || isRecognizing} title="Einen frei gewählten Bereich von Handschrift in Text oder Mathematik konvertieren">
            <ScanSearch size={16} /> Bereich konvertieren
          </button>}
          {inkMode === 'writing' && <button type="button" className="lw-convert-action" onClick={recognizePage} disabled={!handwritingCount || isRecognizing} title="Die gesamte Handschrift-Seite konvertieren">
            {isRecognizing ? <LoaderCircle className="lw-spin" size={16} /> : <Sparkles size={16} />}
            Seite konvertieren
          </button>}
          {inkMode === 'drawing' && <span className="lw-art-footer-note"><Paintbrush size={14} /> Zeichenstriche und Piktogramme werden nicht als Text interpretiert</span>}
        </div>
      </footer>

      <TextToHandwritingDialog
        open={textToHandwritingOpen}
        samples={resources?.samples ?? []}
        pageWidth={SOURCE_WIDTH}
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
.lw-draw-range{display:grid;grid-template-columns:auto minmax(64px,105px) 42px;align-items:center;gap:7px;color:var(--text-muted,#9999a7);white-space:nowrap}.lw-draw-range input{accent-color:var(--draw-accent);width:100%}.lw-draw-range output{text-align:right;font-size:11px;font-variant-numeric:tabular-nums}.lw-paper-select{position:relative;display:flex;align-items:center}.lw-paper-select select{height:34px;appearance:none;padding:0 30px 0 10px;border:1px solid var(--draw-border);border-radius:9px;color:var(--text,#fff);background:var(--background-secondary,#1a1a20);outline:none}.lw-paper-select svg{position:absolute;right:9px;pointer-events:none;color:var(--text-muted,#999)}.lw-history{margin-left:auto}
.lw-art-studio-trigger{height:38px;display:grid;grid-template-columns:19px minmax(68px,auto) 25px;align-items:center;gap:7px;padding:0 8px;border:1px solid color-mix(in srgb,var(--draw-accent) 32%,var(--draw-border));border-radius:10px;color:var(--text,#fff);background:linear-gradient(130deg,color-mix(in srgb,var(--draw-accent) 12%,var(--background-secondary,#18181f)),var(--background-secondary,#18181f));cursor:pointer}.lw-art-studio-trigger>svg{color:var(--accent-readable,var(--draw-accent))}.lw-art-studio-trigger>span{display:flex;min-width:0;flex-direction:column;text-align:left}.lw-art-studio-trigger strong{font-size:10px}.lw-art-studio-trigger small{max-width:92px;overflow:hidden;color:var(--text-muted,#999);font-size:7px;text-overflow:ellipsis;white-space:nowrap}.lw-art-studio-trigger>i{width:25px;height:25px;border:2px solid color-mix(in srgb,var(--text,#fff) 25%,transparent);border-radius:8px;background:var(--art-ink);box-shadow:inset 0 1px rgba(255,255,255,.25)}
.lw-art-studio{position:relative;z-index:13;flex:0 0 auto;margin:10px 14px 0;padding:11px;border:1px solid color-mix(in srgb,var(--draw-accent) 36%,var(--draw-border));border-radius:16px;background:linear-gradient(145deg,color-mix(in srgb,var(--background-secondary,#19191f) 96%,var(--draw-accent) 4%),color-mix(in srgb,var(--background,#111116) 94%,transparent));box-shadow:0 22px 65px rgba(0,0,0,.24),inset 0 1px rgba(255,255,255,.035);animation:lw-art-studio-in .24s cubic-bezier(.2,.8,.2,1)}.lw-art-studio>header{display:flex;align-items:center;gap:8px;margin-bottom:9px}.lw-art-studio>header>span{width:29px;height:29px;display:grid;place-items:center;border-radius:9px;color:var(--on-accent,#111);background:var(--draw-accent)}.lw-art-studio>header>div{display:flex;min-width:0;flex:1;flex-direction:column}.lw-art-studio>header strong{font-size:11px}.lw-art-studio>header small{color:var(--text-muted,#999);font-size:8px}.lw-art-studio-body{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) minmax(160px,.64fr);gap:10px}.lw-art-studio-body>section{min-width:0;padding:9px;border:1px solid var(--draw-border);border-radius:12px;background:color-mix(in srgb,var(--background,#111116) 43%,transparent)}.lw-art-section-head{height:23px;display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.lw-art-section-head strong{font-size:9px}.lw-art-section-head span{overflow:hidden;color:var(--text-muted,#999);font-size:7px;text-overflow:ellipsis;white-space:nowrap}.lw-art-brushes{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}.lw-art-brushes>button{min-width:0;height:49px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:3px;padding:3px;border:1px solid transparent;border-radius:8px;color:var(--text-muted,#999);background:transparent;cursor:pointer}.lw-art-brushes>button:hover{background:color-mix(in srgb,var(--text,#fff) 6%,transparent)}.lw-art-brushes>button.is-active{border-color:color-mix(in srgb,var(--draw-accent) 48%,var(--draw-border));color:var(--text,#fff);background:color-mix(in srgb,var(--draw-accent) 12%,transparent)}.lw-art-brushes small{max-width:100%;overflow:hidden;font-size:7px;text-overflow:ellipsis;white-space:nowrap}.lw-art-brush-preview{position:relative;width:42px;height:16px;display:grid;place-items:center;overflow:hidden}.lw-art-brush-preview i{display:block;width:37px;height:3px;border-radius:99px;background:currentColor;transform:rotate(-5deg)}.lw-art-brush-preview.is-fineliner i{height:2px}.lw-art-brush-preview.is-pencil i{height:2px;opacity:.65;background:repeating-linear-gradient(90deg,currentColor 0 3px,transparent 3px 4px)}.lw-art-brush-preview.is-marker i{height:6px;border-radius:2px;opacity:.88}.lw-art-brush-preview.is-paintbrush i{height:7px;border-radius:90% 15% 80% 20%;transform:rotate(-5deg) scaleX(1.02)}.lw-art-brush-preview.is-calligraphy i{height:7px;border-radius:1px;transform:rotate(-5deg) skewX(-28deg)}.lw-art-brush-preview.is-highlighter i{height:9px;border-radius:2px;opacity:.35}.lw-art-brush-preview.is-watercolor i{height:10px;opacity:.28;filter:blur(.45px);box-shadow:0 -2px currentColor,0 2px currentColor}.lw-art-brush-preview.is-spray i{height:13px;opacity:.75;background:radial-gradient(circle,currentColor 0 1px,transparent 1.3px) 0 0/5px 5px;transform:rotate(-5deg)}
.lw-art-solid-colors{display:flex;flex-wrap:wrap;gap:5px}.lw-art-solid-colors>button,.lw-art-custom-color{position:relative;width:20px;height:20px;flex:0 0 auto;border:2px solid color-mix(in srgb,var(--text,#fff) 8%,transparent);border-radius:7px;background:var(--art-ink);cursor:pointer}.lw-art-solid-colors>button.is-active{border-color:var(--text,#fff);box-shadow:0 0 0 2px color-mix(in srgb,var(--art-ink) 40%,transparent)}.lw-art-custom-color{display:block;overflow:hidden;background:conic-gradient(#e45,#fb3,#5d7,#4ce,#65f,#d5e,#e45)}.lw-art-custom-color input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}.lw-art-custom-color span{position:absolute;inset:5px;border-radius:3px}.lw-art-special-inks{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;margin-top:7px}.lw-art-special-inks>button{height:34px;display:flex;min-width:0;align-items:stretch;justify-content:center;flex-direction:column;gap:2px;padding:3px 4px;border:1px solid var(--draw-border);border-radius:7px;color:var(--text-muted,#999);background:transparent;cursor:pointer}.lw-art-special-inks>button:hover{background:color-mix(in srgb,var(--text,#fff) 5%,transparent)}.lw-art-special-inks>button.is-active{border-color:color-mix(in srgb,var(--draw-accent) 60%,var(--draw-border));color:var(--text,#fff);background:color-mix(in srgb,var(--draw-accent) 9%,transparent)}.lw-art-special-inks i{width:100%;height:12px;flex:0 0 auto;border-radius:4px;background:var(--art-ink);box-shadow:inset 0 1px rgba(255,255,255,.25)}.lw-art-special-inks span{overflow:hidden;font-size:7px;line-height:1;text-align:center;text-overflow:ellipsis;white-space:nowrap}.lw-art-control-section{display:flex;flex-direction:column;gap:7px}.lw-art-control-section>label{display:grid;grid-template-columns:minmax(65px,1fr) minmax(60px,1fr) 30px;align-items:center;gap:5px}.lw-art-control-section label>span{display:flex;min-width:0;flex-direction:column}.lw-art-control-section label strong{font-size:8px}.lw-art-control-section label small{overflow:hidden;color:var(--text-muted,#999);font-size:6px;text-overflow:ellipsis;white-space:nowrap}.lw-art-control-section input{width:100%;accent-color:var(--draw-accent)}.lw-art-control-section output{color:var(--text-muted,#999);font-size:7px;text-align:right;font-variant-numeric:tabular-nums}.lw-art-current-stroke{min-height:35px;display:flex;align-items:center;gap:7px;margin-top:auto;padding:4px 6px;border-radius:8px;background:color-mix(in srgb,var(--text,#fff) 4%,transparent)}.lw-art-current-stroke>span{height:var(--art-width);max-height:20px;min-height:2px;flex:1;border-radius:99px;background:var(--art-ink);opacity:var(--art-opacity)}.lw-art-current-stroke small{color:var(--text-muted,#999);font-size:7px;white-space:nowrap}.lw-art-footer-note{display:inline-flex;align-items:center;gap:6px;padding:0 7px;color:var(--text-muted,#999);font-size:8px}.lw-tablet-canvas.tool-art{cursor:crosshair}@keyframes lw-art-studio-in{from{opacity:0;transform:translateY(-7px) scale(.99)}}
.lw-draw-icon,.lw-draw-subtle,.lw-primary-action,.lw-convert-action,.lw-model-card button{border:0;cursor:pointer;transition:transform .16s ease,background .16s ease,opacity .16s ease}.lw-draw-icon{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;background:transparent}.lw-draw-icon:hover:not(:disabled){background:color-mix(in srgb,var(--text,#fff) 8%,transparent)}.lw-draw-icon.lw-danger:hover:not(:disabled){color:var(--danger,#d94b63);background:color-mix(in srgb,var(--danger,#d94b63) 10%,transparent)}.lw-drawing-board button:disabled{opacity:.5;cursor:not-allowed}.lw-draw-subtle{display:flex;align-items:center;justify-content:center;gap:7px;height:32px;padding:0 10px;border-radius:8px;background:color-mix(in srgb,var(--text,#fff) 6%,transparent)}.lw-draw-subtle:hover:not(:disabled){background:color-mix(in srgb,var(--text,#fff) 10%,transparent)}.lw-draw-subtle.is-active{color:var(--text,#fff);background:color-mix(in srgb,var(--draw-accent) 22%,var(--background-secondary,#17171d));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--draw-accent) 38%,transparent)}
.lw-draw-workspace{position:relative;display:grid;grid-template-columns:minmax(0,1fr);flex:1;min-height:0;padding:18px;gap:14px}.lw-draw-workspace.has-conversion{grid-template-columns:minmax(0,1fr) minmax(300px,370px)}.lw-canvas-shell{position:relative;display:flex;min-width:0;min-height:0;flex-direction:column;padding:10px 10px 7px;border:1px solid var(--draw-border);border-radius:17px;background:color-mix(in srgb,var(--background-secondary,#17171d) 84%,transparent);box-shadow:0 20px 55px rgba(0,0,0,.16)}.lw-canvas-glow{position:absolute;inset:-1px;border-radius:inherit;pointer-events:none;background:radial-gradient(circle at 15% 0,color-mix(in srgb,var(--draw-accent) 10%,transparent),transparent 36%)}.lw-canvas-surface{position:relative;z-index:1;flex:0 0 auto;min-width:220px;min-height:300px;aspect-ratio:210/297;margin:auto;overflow:hidden;border-radius:8px;background:#fbfcff;box-shadow:0 8px 32px rgba(0,0,0,.2),inset 0 0 0 1px rgba(30,42,65,.08)}.lw-tablet-canvas{position:absolute;inset:0;display:block;width:100%;height:100%;outline:none;touch-action:none;user-select:none;-webkit-user-select:none}.lw-tablet-canvas-committed{z-index:1;pointer-events:none}.lw-tablet-canvas-live{z-index:2;pointer-events:auto}.lw-tablet-canvas.tool-pen,.lw-tablet-canvas.tool-select{cursor:crosshair}.lw-tablet-canvas.tool-eraser{cursor:cell}.lw-tablet-canvas:focus-visible{box-shadow:inset 0 0 0 2px var(--draw-accent)}.lw-selection-hint{position:absolute;z-index:3;top:18px;left:50%;display:flex;align-items:center;gap:7px;padding:8px 11px;transform:translateX(-50%);border:1px solid rgba(86,71,183,.32);border-radius:9px;color:#28233d;background:rgba(255,255,255,.92);box-shadow:0 8px 24px rgba(39,31,85,.18);font:700 11px/1.2 var(--ui-font,system-ui);pointer-events:none;white-space:nowrap}.lw-selection-rect{position:absolute;z-index:3;min-width:2px;min-height:2px;border:2px dashed #6855d9;background:rgba(104,85,217,.1);box-shadow:0 0 0 9999px rgba(38,35,55,.08);pointer-events:none}.lw-selection-rect.is-selected{border-style:solid;background:rgba(104,85,217,.07);box-shadow:0 0 0 9999px rgba(38,35,55,.04),0 0 0 3px rgba(104,85,217,.14)}.lw-selection-rect span{position:absolute;bottom:calc(100% + 5px);left:-2px;padding:3px 7px;border-radius:6px;color:#fff;background:#5f4bcf;font:700 9px/1.3 var(--ui-font,system-ui);white-space:nowrap}.lw-canvas-meta{display:flex;align-items:center;justify-content:space-between;padding:7px 3px 0;color:var(--text-muted,#9292a0);font-size:10px}.lw-canvas-meta span{display:flex;align-items:center;gap:6px}.lw-pressure-dot{width:6px;height:6px;border-radius:50%;background:#4bd7a4;box-shadow:0 0 7px #4bd7a4}
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
.lw-drawing-board.is-inline{position:absolute;z-index:4;inset:0;height:auto;min-height:100%;overflow:visible;background:transparent;pointer-events:none}.lw-drawing-board.is-inline .lw-draw-header{display:none}.lw-drawing-board.is-inline .lw-draw-toolbar{position:sticky;z-index:12;top:12px;width:max-content;max-width:calc(100% - 24px);min-height:48px;margin:12px auto -60px;padding:6px 8px;border:1px solid var(--draw-border);border-radius:13px;background:color-mix(in srgb,var(--background-secondary,#17171d) 94%,transparent);box-shadow:0 14px 38px rgba(0,0,0,.22);backdrop-filter:blur(14px);pointer-events:auto;transition:opacity .14s,transform .14s}.lw-drawing-board.is-inline:not(.is-input-active) .lw-draw-toolbar{opacity:0;transform:translateY(-8px);pointer-events:none}.lw-drawing-board.is-inline .lw-draw-workspace{position:absolute;inset:0;display:block;min-height:100%;padding:0;pointer-events:none}.lw-drawing-board.is-inline .lw-canvas-shell{position:absolute;inset:0;display:block;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;pointer-events:none}.lw-drawing-board.is-inline .lw-canvas-glow,.lw-drawing-board.is-inline .lw-canvas-meta{display:none}.lw-drawing-board.is-inline .lw-canvas-surface{position:absolute;inset:0;width:100%!important;height:100%!important;min-width:0;min-height:0;aspect-ratio:auto;margin:0;border-radius:0;background:transparent;box-shadow:none}.lw-drawing-board.is-inline .lw-tablet-canvas{width:100%;height:100%;pointer-events:none}.lw-drawing-board.is-inline .lw-tablet-canvas.is-input-active{pointer-events:auto}.lw-drawing-board.is-inline .lw-conversion-panel{position:sticky;z-index:14;top:72px;float:right;width:min(370px,calc(100% - 28px));max-height:calc(100vh - 175px);margin:72px 14px 0 0;overflow:auto;pointer-events:auto;box-shadow:0 22px 70px rgba(0,0,0,.34)}.lw-drawing-board.is-inline .lw-draw-notice{position:sticky;z-index:15;top:72px;width:min(420px,calc(100% - 28px));margin:72px auto 0;pointer-events:auto;box-shadow:0 13px 34px rgba(0,0,0,.24)}.lw-drawing-board.is-inline .lw-draw-footer{position:fixed;z-index:45;bottom:38px;left:50%;width:max-content;max-width:calc(100vw - 84px);min-height:44px;margin:0;padding:5px;border:1px solid var(--draw-border);border-radius:12px;background:color-mix(in srgb,var(--background-secondary,#17171d) 94%,transparent);box-shadow:0 14px 38px rgba(0,0,0,.22);backdrop-filter:blur(14px);pointer-events:auto;transform:translateX(-50%)}.lw-drawing-board.is-inline:not(.is-input-active) .lw-draw-footer{display:none}.lw-drawing-board.is-inline .lw-footer-actions>button:first-child{display:none}
.lw-drawing-board.is-inline .lw-art-studio{position:sticky;z-index:13;top:72px;width:min(900px,calc(100% - 28px));max-height:calc(100vh - 170px);margin:72px auto 0;overflow:auto;background:color-mix(in srgb,var(--background-secondary,#17171d) 95%,transparent);backdrop-filter:blur(18px);pointer-events:auto}.lw-drawing-board.is-inline:not(.is-input-active) .lw-art-studio{display:none}
@media(max-width:900px){.lw-draw-workspace.has-conversion{grid-template-columns:1fr}.lw-conversion-panel{position:absolute;z-index:5;inset:10px;box-shadow:0 24px 80px rgba(0,0,0,.45)}.lw-draw-range span{display:none}.lw-draw-toolbar{gap:7px}.lw-canvas-surface{width:100%;height:auto}.lw-draw-workspace{padding:10px}}@media(max-width:640px){.lw-math-correction-popover{left:8px!important;width:calc(100% - 16px);max-height:82%;}.lw-math-correction-actions{grid-template-columns:1fr}}
@media(max-width:900px){.lw-art-studio-body{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.lw-art-control-section{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr minmax(140px,.7fr)}}
@media(max-width:640px){.lw-draw-header{padding:0 10px}.lw-draw-header-actions .lw-draw-subtle{font-size:0}.lw-draw-toolbar{min-height:54px;padding:7px 9px}.lw-segmented button{font-size:0;padding:0 9px}.lw-draw-range{grid-template-columns:70px 38px}.lw-colors>button:nth-of-type(n+5){display:none}.lw-drawing-board:not(.is-inline) .lw-draw-footer{align-items:stretch;flex-direction:column}.lw-drawing-board:not(.is-inline) .lw-draw-footer>div:first-child{display:none}.lw-drawing-board.is-inline .lw-draw-footer{width:calc(100vw - 72px);overflow-x:auto}.lw-footer-actions{display:grid;grid-template-columns:1fr 1fr}.lw-footer-actions button{width:100%}.lw-footer-actions>button:first-child{grid-column:1/-1}}
@media(max-width:640px){.lw-art-studio-body{grid-template-columns:1fr}.lw-art-control-section{grid-column:auto;display:flex}.lw-art-brushes{grid-template-columns:repeat(4,minmax(0,1fr))}.lw-art-special-inks{grid-template-columns:repeat(2,minmax(0,1fr))}.lw-art-quick-width{display:none}.lw-drawing-board.is-inline .lw-art-studio{width:calc(100% - 16px);margin-top:68px}}
.lw-tablet-canvas.tool-stamp{cursor:copy}.lw-art-studio-trigger>i.is-symbol{display:grid;place-items:center;color:var(--art-ink);background:color-mix(in srgb,var(--art-ink) 10%,var(--background,#111116))}.lw-art-studio-trigger>i.is-symbol svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.18))}.lw-art-symbol-section{grid-column:1/-1}.lw-art-symbol-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px}.lw-art-symbol-heading>.lw-art-section-head{height:auto;min-width:160px;flex:1}.lw-art-symbol-categories{display:flex;align-items:center;gap:3px;padding:3px;border-radius:9px;background:color-mix(in srgb,var(--text,#fff) 4%,transparent)}.lw-art-symbol-categories button{height:24px;padding:0 8px;border:1px solid transparent;border-radius:6px;color:var(--text-muted,#999);background:transparent;font:700 7px/1 var(--ui-font,system-ui);cursor:pointer}.lw-art-symbol-categories button:hover{color:var(--text,#fff)}.lw-art-symbol-categories button.is-active{border-color:color-mix(in srgb,var(--draw-accent) 35%,transparent);color:var(--text,#fff);background:color-mix(in srgb,var(--draw-accent) 15%,transparent)}.lw-art-symbols{display:grid;grid-template-columns:repeat(auto-fit,minmax(58px,1fr));gap:4px}.lw-art-symbols>button{height:48px;display:flex;min-width:0;align-items:center;justify-content:center;flex-direction:column;gap:2px;padding:3px;border:1px solid transparent;border-radius:8px;color:var(--text-muted,#999);background:transparent;cursor:pointer}.lw-art-symbols>button:hover{color:var(--text,#fff);background:color-mix(in srgb,var(--text,#fff) 6%,transparent);transform:translateY(-1px)}.lw-art-symbols>button.is-active{border-color:color-mix(in srgb,var(--draw-accent) 52%,var(--draw-border));color:var(--accent-readable,var(--draw-accent));background:color-mix(in srgb,var(--draw-accent) 13%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--draw-accent) 10%,transparent)}.lw-art-symbols small{max-width:100%;overflow:hidden;font-size:6.5px;text-overflow:ellipsis;white-space:nowrap}.lw-art-current-stroke>span.is-symbol{height:30px;max-height:none;display:grid;flex:1;place-items:center;border-radius:6px;color:var(--art-ink);background:transparent}
@media(max-width:640px){.lw-art-symbol-heading{align-items:stretch;flex-direction:column;gap:5px}.lw-art-symbol-categories{overflow-x:auto}.lw-art-symbol-categories button{flex:1}.lw-art-symbols{grid-template-columns:repeat(4,minmax(0,1fr))}}
.lw-art-studio-tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;margin:0 0 9px;padding:4px;border:1px solid var(--draw-border);border-radius:12px;background:color-mix(in srgb,var(--background,#111116) 54%,transparent)}.lw-art-studio-tabs>button{min-width:0;height:42px;display:flex;align-items:center;gap:8px;padding:0 10px;border:1px solid transparent;border-radius:9px;color:var(--text-muted,#999);background:transparent;cursor:pointer;text-align:left}.lw-art-studio-tabs>button:hover{color:var(--text,#fff);background:color-mix(in srgb,var(--text,#fff) 5%,transparent)}.lw-art-studio-tabs>button.is-active{border-color:color-mix(in srgb,var(--draw-accent) 42%,var(--draw-border));color:var(--text,#fff);background:linear-gradient(135deg,color-mix(in srgb,var(--draw-accent) 17%,transparent),color-mix(in srgb,var(--background-secondary,#18181f) 78%,transparent));box-shadow:0 5px 16px color-mix(in srgb,var(--draw-accent) 8%,transparent),inset 0 1px rgba(255,255,255,.04)}.lw-art-studio-tabs>button>svg{flex:0 0 auto;color:var(--accent-readable,var(--draw-accent))}.lw-art-studio-tabs>button>span{display:flex;min-width:0;flex-direction:column}.lw-art-studio-tabs strong{font-size:9px}.lw-art-studio-tabs small{overflow:hidden;color:var(--text-muted,#999);font-size:6.5px;text-overflow:ellipsis;white-space:nowrap}.lw-art-studio-body{grid-template-columns:minmax(0,1fr) minmax(190px,220px);align-items:stretch}.lw-art-studio-body>.lw-art-brush-section,.lw-art-studio-body>.lw-art-color-section,.lw-art-studio-body>.lw-art-symbol-section{grid-column:1;grid-row:1}.lw-art-studio-body>.lw-art-control-section{grid-column:2;grid-row:1}.lw-art-studio-body>.lw-art-symbol-section{grid-column:1}.lw-art-symbols{grid-template-columns:repeat(auto-fit,minmax(56px,1fr))}.lw-art-studio-body>section[role="tabpanel"]{animation:lw-art-tab-in .16s ease-out}@keyframes lw-art-tab-in{from{opacity:0;transform:translateY(3px)}}
.lw-art-studio-body>.lw-art-control-section{display:flex;flex-direction:column}
@media(max-width:640px){.lw-art-studio-tabs>button{height:38px;justify-content:center;padding:0 6px}.lw-art-studio-tabs>button>span small{display:none}.lw-art-studio-body{grid-template-columns:1fr}.lw-art-studio-body>.lw-art-brush-section,.lw-art-studio-body>.lw-art-color-section,.lw-art-studio-body>.lw-art-symbol-section,.lw-art-studio-body>.lw-art-control-section{grid-column:1;grid-row:auto}.lw-art-symbols{grid-template-columns:repeat(4,minmax(0,1fr))}}
@media(prefers-reduced-motion:reduce){.lw-drawing-board *{scroll-behavior:auto!important;transition:none!important;animation-duration:.001ms!important}}
`

export default DrawingBoard
