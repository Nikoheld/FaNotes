import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import DrawingCanvas, { type DrawingCanvasHandle } from './components/DrawingCanvas'
import MathFormula from './components/MathFormula'
import { BASE_CATALOG, CATEGORIES, DEFAULT_LABEL_ID, categoryName } from './data/catalog'
import { getAllSamples, putSample, removeAllSamples, removeSample } from './lib/db'
import { exportDataset } from './lib/exportDataset'
import {
  buildRecognitionModel,
  createMathLayoutExamples,
  createEmptyRecognitionModel,
  isLargeMathOperator,
  recognizeAutomaticExpression,
  recognizeExpression,
  recognizedLatex,
  recognizedSentence,
  recognizedText,
  suggestMathLayoutAssignments,
  type AutomaticRecognitionResult,
  type MathLayoutAssignment,
  type MathLayoutExample,
  type RecognitionMode,
  type RecognitionModel,
  type RecognitionToken,
} from './lib/recognition'
import { containsGermanSharpS, isSupportedRecognitionLabel, normalizeGermanSharpS } from './lib/orthography'
import { hasStrongNeuralWordEvidence } from './lib/recognitionModeSelection'
import { createStandardRecognitionSamples } from './lib/standardRecognition'
import type { CanvasState, CategoryId, LabelDefinition, Sample, Stroke } from './types'
import { getGlyphenWerkLanguage, getGlyphenWerkLocale } from './i18n'

type ViewId = 'capture' | 'test' | 'collection' | 'export'

const EMBEDDED_IN_FANOTES = new URLSearchParams(window.location.search).get('embedded') === '1'
const isViewId = (value: unknown): value is ViewId => value === 'capture' || value === 'test' || value === 'collection' || value === 'export'
const FANOTES_THEMES = new Set(['dark', 'light', 'midnight', 'forest', 'aurora', 'sepia'])
const FANOTES_PALETTE_KEYS = new Set([
  'bg', 'bg-elevated', 'panel', 'panel-strong', 'panel-hover', 'border', 'border-strong',
  'text', 'text-soft', 'text-muted', 'danger', 'success', 'warning', 'shadow', 'accent',
  'accent-secondary', 'accent-readable', 'on-accent', 'ui-font',
])

const applyFaNotesAppearance = (message: { theme?: unknown; reduceMotion?: unknown; palette?: unknown }) => {
  if (typeof message.theme !== 'string' || !FANOTES_THEMES.has(message.theme)) return
  if (!message.palette || typeof message.palette !== 'object' || Array.isArray(message.palette)) return
  const root = document.documentElement
  root.dataset.fanotesTheme = message.theme
  root.dataset.fanotesReduceMotion = message.reduceMotion === true ? 'true' : 'false'
  Object.entries(message.palette).forEach(([key, rawValue]) => {
    if (!FANOTES_PALETTE_KEYS.has(key) || typeof rawValue !== 'string') return
    const value = rawValue.trim()
    if (!value || value.length > 240 || /[;{}<>]/u.test(value)) return
    root.style.setProperty(`--fanotes-${key}`, value)
  })
}

const notifyFaNotes = (payload: Record<string, unknown>) => {
  if (!EMBEDDED_IN_FANOTES || window.parent === window) return
  window.parent.postMessage({ ...payload, schemaVersion: 1 }, '*')
}

type NeuralTestResult = {
  requestId: string
  text: string
  confidence: number
  lineCount: number
  wordCount: number
  knownWordRatio: number
}
type IconName =
  | 'pen'
  | 'grid'
  | 'download'
  | 'undo'
  | 'redo'
  | 'trash'
  | 'search'
  | 'plus'
  | 'check'
  | 'database'
  | 'shield'
  | 'sparkle'
  | 'settings'
  | 'close'
  | 'archive'
  | 'info'
  | 'chevron'
  | 'scan'
  | 'copy'

const Icon = ({ name, size = 20 }: { name: IconName; size?: number }) => {
  const paths: Record<IconName, React.ReactNode> = {
    pen: <><path d="m14.7 6.3 3 3"/><path d="M4 20l4.1-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.1 16 4 20Z"/><path d="m13.5 6.5 3 3"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    download: <><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></>,
    undo: <><path d="m9 7-5 5 5 5"/><path d="M20 17a8 8 0 0 0-8-8H4"/></>,
    redo: <><path d="m15 7 5 5-5 5"/><path d="M4 17a8 8 0 0 1 8-8h8"/></>,
    trash: <><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m7 7 1 14h8l1-14"/><path d="M10 11v6M14 11v6"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></>,
    shield: <><path d="M12 3 5 6v5c0 4.7 2.7 8.2 7 10 4.3-1.8 7-5.3 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></>,
    sparkle: <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3Z"/><path d="m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14Z"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    archive: <><path d="M4 7h16v13H4z"/><path d="M3 3h18v4H3zM9 11h6"/></>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    scan: <><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M7 12h10M9 9l-2 3 2 3M15 9l2 3-2 3"/></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

const createUuid = () => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2).padEnd(20, '0').slice(0, 20)}`
}

const getOrCreateId = (storage: Storage, key: string, prefix: string) => {
  const existing = storage.getItem(key)
  if (existing) return existing
  const id = `${prefix}-${createUuid().slice(0, 8)}`
  storage.setItem(key, id)
  return id
}

const initialCanvasState: CanvasState = {
  hasInk: false,
  canUndo: false,
  canRedo: false,
  pointCount: 0,
}

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat(getGlyphenWerkLocale(), {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))

const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const layoutTrainingKey = (assignments: MathLayoutAssignment[]) => assignments
  .map((assignment) => `${assignment.tokenId}:${assignment.role}:${assignment.anchorId}`)
  .sort()
  .join('|')

type IncrementalTextRecognitionState = {
  strokes: Stroke[]
  characterCount: number
  text: string
  pendingStrokeIndex: number
  prefixText: string
}

const strokeExtent = (strokes: Stroke[]) => {
  const points = strokes.flatMap((stroke) => stroke.points)
  if (!points.length) return null
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  }
}

/**
 * Derives a character-count hint only from append-only pen input.  A new
 * stroke whose body starts at the right edge of the previous word is a new
 * glyph; a dot, crossbar or second loop inside the current glyph keeps the
 * previous count.  New lines and undo/erase deliberately disable the hint.
 */
const incrementalTextCharacterHint = (
  previous: IncrementalTextRecognitionState | null,
  current: Stroke[],
) => {
  if (
    !previous ||
    previous.characterCount < 1 ||
    previous.characterCount >= 24 ||
    current.length <= previous.strokes.length
  ) return undefined
  const before = strokeExtent(previous.strokes)
  const added = strokeExtent(current.slice(previous.strokes.length))
  if (!before || !added) return undefined
  const lineHeight = Math.max(0.012, before.maxY - before.minY)
  const overlapsLine = added.maxY >= before.minY - lineHeight * 0.35
    && added.minY <= before.maxY + lineHeight * 0.35
  if (!overlapsLine) return undefined
  const beginsAtRightEdge = added.minX >= before.maxX - Math.max(0.018, lineHeight * 0.34)
  const extendsWord = added.maxX >= before.maxX + Math.max(0.004, lineHeight * 0.035)
  const beginsNewGlyph = beginsAtRightEdge && extendsWord
  const pendingStrokeIndex = beginsNewGlyph
    ? previous.strokes.length
    : Math.max(0, Math.min(previous.pendingStrokeIndex, previous.strokes.length))
  return {
    characterCount: beginsNewGlyph ? previous.characterCount + 1 : previous.characterCount,
    beginsNewGlyph,
    addedStrokes: current.slice(pendingStrokeIndex),
    previousText: beginsNewGlyph ? previous.text : previous.prefixText,
    pendingStrokeIndex,
  }
}

const App = () => {
  const canvasRef = useRef<DrawingCanvasHandle>(null)
  const testCanvasRef = useRef<DrawingCanvasHandle>(null)
  const [view, setView] = useState<ViewId>(() => {
    const requestedView = new URLSearchParams(window.location.search).get('view')
    return isViewId(requestedView) ? requestedView : 'capture'
  })
  const [samples, setSamples] = useState<Sample[]>([])
  const [customLabels, setCustomLabels] = useState<LabelDefinition[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('glyphenwerk-custom-labels') ?? '[]')
      return Array.isArray(stored)
        ? stored.filter((label): label is LabelDefinition => (
          Boolean(label) && typeof label.char === 'string' && isSupportedRecognitionLabel(label.char, label.id)
        ))
        : []
    } catch {
      return []
    }
  })
  const [selectedCategory, setSelectedCategory] = useState<CategoryId>('math')
  const [selectedLabelId, setSelectedLabelId] = useState(DEFAULT_LABEL_ID)
  const [captureMode, setCaptureMode] = useState<'free' | 'balanced'>('free')
  const [canvasState, setCanvasState] = useState<CanvasState>(initialCanvasState)
  const [testCanvasState, setTestCanvasState] = useState<CanvasState>(initialCanvasState)
  const [testStrokes, setTestStrokes] = useState<Stroke[]>([])
  const [recognitionMode, setRecognitionMode] = useState<RecognitionMode>('text')
  const [automaticRecognition, setAutomaticRecognition] = useState<AutomaticRecognitionResult | null>(null)
  const [neuralTestResult, setNeuralTestResult] = useState<NeuralTestResult | null>(null)
  const [neuralTestText, setNeuralTestText] = useState('')
  const neuralRequestIdRef = useRef('')
  const recognitionFallbackRef = useRef<RecognitionMode>('text')
  const incrementalTextRecognitionRef = useRef<IncrementalTextRecognitionState | null>(null)
  const correctedRecognitionInputRef = useRef<Stroke[] | null>(null)
  const [recognitionModel, setRecognitionModel] = useState<RecognitionModel>(() => createEmptyRecognitionModel())
  const [standardModelSize, setStandardModelSize] = useState(0)
  const [recognitionTokens, setRecognitionTokens] = useState<RecognitionToken[]>([])
  const [mathLayoutExamples, setMathLayoutExamples] = useState<MathLayoutExample[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('glyphenwerk-math-layout-examples') ?? '[]')
      return Array.isArray(stored) ? stored : []
    } catch {
      return []
    }
  })
  const [mathLayoutAssignments, setMathLayoutAssignments] = useState<MathLayoutAssignment[]>([])
  const [learnedLayoutKeys, setLearnedLayoutKeys] = useState<Set<string>>(() => new Set())
  const [isModelLoading, setIsModelLoading] = useState(false)
  const [isRecognizing, setIsRecognizing] = useState(false)
  const [learnedTokenIds, setLearnedTokenIds] = useState<Set<string>>(() => new Set())
  const [brushSize, setBrushSize] = useState(6)
  const [pressureEnabled, setPressureEnabled] = useState(true)
  const [pickerSearch, setPickerSearch] = useState('')
  const [collectionSearch, setCollectionSearch] = useState('')
  const [collectionCategory, setCollectionCategory] = useState<'all' | CategoryId>('all')
  const [showCustomModal, setShowCustomModal] = useState(false)
  const [customChar, setCustomChar] = useState('')
  const [customName, setCustomName] = useState('')
  const [customLatex, setCustomLatex] = useState('')
  const [toast, setToast] = useState<{ id: number; message: string; tone: 'success' | 'error' } | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  const [storageUsage, setStorageUsage] = useState(0)
  const [writerId, setWriterId] = useState(() => getOrCreateId(localStorage, 'glyphenwerk-writer-id', 'person'))
  const sessionIdRef = useRef(getOrCreateId(sessionStorage, 'glyphenwerk-session-id', 'session'))

  const labels = useMemo(() => [...BASE_CATALOG, ...customLabels], [customLabels])
  const selectedLabel = labels.find((label) => label.id === selectedLabelId) ?? labels[0]

  const counts = useMemo(() => {
    const next = new Map<string, number>()
    samples.forEach((sample) => next.set(sample.labelId, (next.get(sample.labelId) ?? 0) + 1))
    return next
  }, [samples])

  const uniqueLabelCount = counts.size
  const sessionSampleCount = samples.filter((sample) => sample.sessionId === sessionIdRef.current).length

  useEffect(() => {
    if (!EMBEDDED_IN_FANOTES || window.parent === window) return
    const receiveNavigation = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return
      const message = event.data as { type?: unknown; schemaVersion?: unknown; view?: unknown; theme?: unknown; reduceMotion?: unknown; palette?: unknown; requestId?: unknown; text?: unknown; confidence?: unknown; lineCount?: unknown; wordCount?: unknown; knownWordRatio?: unknown }
      if (message.schemaVersion !== 1) return
      if (message.type === 'glyphenwerk:navigate' && isViewId(message.view)) setView(message.view)
      if (message.type === 'glyphenwerk:appearance') applyFaNotesAppearance(message)
      if (
        message.type === 'glyphenwerk:neural-result'
        && typeof message.requestId === 'string'
        && message.requestId === neuralRequestIdRef.current
        && typeof message.text === 'string'
        && message.text.length <= 4_000
        && typeof message.confidence === 'number'
        && Number.isFinite(message.confidence)
      ) {
        setNeuralTestResult({
          requestId: message.requestId,
          text: message.text,
          confidence: Math.max(0, Math.min(100, Math.round(message.confidence))),
          lineCount: typeof message.lineCount === 'number' && Number.isSafeInteger(message.lineCount)
            ? Math.max(0, message.lineCount)
            : 0,
          wordCount: typeof message.wordCount === 'number' && Number.isSafeInteger(message.wordCount)
            ? Math.max(0, message.wordCount)
            : 0,
          knownWordRatio: typeof message.knownWordRatio === 'number' && Number.isFinite(message.knownWordRatio)
            ? Math.max(0, Math.min(1, message.knownWordRatio))
            : 0,
        })
      }
    }
    window.addEventListener('message', receiveNavigation)
    notifyFaNotes({ type: 'glyphenwerk:ready' })
    return () => window.removeEventListener('message', receiveNavigation)
  }, [])

  useEffect(() => {
    notifyFaNotes({
      type: 'glyphenwerk:view-changed',
      view,
      sampleCount: samples.length,
      uniqueLabelCount,
    })
  }, [samples.length, uniqueLabelCount, view])

  const showToast = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    setToast({ id: Date.now(), message, tone })
  }, [])

  const updateStorageEstimate = useCallback(async () => {
    try {
      const estimate = await navigator.storage?.estimate()
      setStorageUsage(estimate?.usage ?? 0)
    } catch {
      setStorageUsage(0)
    }
  }, [])

  const handleTestStrokesChange = useCallback((strokes: Stroke[]) => {
    setTestStrokes(strokes)
    setLearnedTokenIds(new Set())
    setNeuralTestResult(null)
    setNeuralTestText('')
  }, [])

  useEffect(() => {
    let active = true
    getAllSamples()
      .then((storedSamples) => {
        if (!active) return
        const supportedSamples = storedSamples.filter((sample) => isSupportedRecognitionLabel(sample.label, sample.labelId))
        setSamples(supportedSamples)
        notifyFaNotes({
          type: 'glyphenwerk:sync',
          samples: supportedSamples,
          labels: customLabels,
          layouts: mathLayoutExamples,
        })
      })
      .catch(() => showToast('Der lokale Datenspeicher ist nicht verfügbar.', 'error'))
      .finally(() => {
        if (active) setIsLoading(false)
      })
    void updateStorageEstimate()
    return () => {
      active = false
    }
  }, [showToast, updateStorageEstimate])

  useEffect(() => {
    let active = true
    setIsModelLoading(true)
    createStandardRecognitionSamples(BASE_CATALOG)
      .then((standardSamples) => {
        if (active) setStandardModelSize(standardSamples.length)
        return buildRecognitionModel([...samples, ...standardSamples])
      })
      .then((model) => {
        if (active) setRecognitionModel(model)
      })
      .catch(() => {
        if (active) showToast('Das lokale Erkennungsmodell konnte nicht aktualisiert werden.', 'error')
      })
      .finally(() => {
        if (active) setIsModelLoading(false)
      })
    return () => {
      active = false
    }
  }, [samples, showToast])

  useEffect(() => {
    if (testStrokes.length === 0) {
      incrementalTextRecognitionRef.current = null
      correctedRecognitionInputRef.current = null
      setRecognitionTokens([])
      setMathLayoutAssignments([])
      setAutomaticRecognition(null)
      setNeuralTestResult(null)
      setNeuralTestText('')
      setIsRecognizing(false)
      return
    }
    // A user-confirmed correction owns this exact ink snapshot. Rebuilding the
    // model after storing the new example must not immediately run recognition
    // again and overwrite the correction on the unchanged canvas.
    if (correctedRecognitionInputRef.current === testStrokes) {
      setIsRecognizing(false)
      return
    }

    let active = true
    setIsRecognizing(true)
    const timer = window.setTimeout(() => {
      // Keep append-only text evidence available even if an unfinished new
      // letter made the immediately preceding preview flip to mathematics.
      // Strong operators and real formula layout are still decided by the
      // automatic recognizer, but the next pen stroke can now recover the
      // stable word prefix instead of inheriting the transient wrong mode.
      const incrementalHint = incrementalTextCharacterHint(
        incrementalTextRecognitionRef.current,
        testStrokes,
      )
      const addedCharacter = incrementalHint
        ? recognizedSentence(recognizeExpression(
            incrementalHint.addedStrokes,
            recognitionModel,
            labels,
            'text',
            mathLayoutExamples,
            getGlyphenWerkLanguage(),
          )).replace(/\s+/gu, '')
        : ''
      const textCharacterHint = incrementalHint
        ? /^\p{L}$/u.test(addedCharacter)
          ? `${incrementalHint.previousText}${addedCharacter}`
          : incrementalHint.previousText
        : undefined
      const recognition = recognizeAutomaticExpression(
        testStrokes,
        recognitionModel,
        labels,
        mathLayoutExamples,
        getGlyphenWerkLanguage(),
        recognitionFallbackRef.current,
        incrementalHint?.characterCount,
        textCharacterHint,
      )
      if (active) {
        recognitionFallbackRef.current = recognition.mode
        setRecognitionMode(recognition.mode)
        setAutomaticRecognition(recognition)
        setRecognitionTokens(recognition.tokens)
        setMathLayoutAssignments(
          recognition.mode === 'math' ? suggestMathLayoutAssignments(recognition.tokens, mathLayoutExamples) : [],
        )
        const compactText = recognition.textValue.replace(/\s+/gu, '')
        if (
          recognition.mode === 'text' &&
          /^\p{L}{1,24}$/u.test(compactText)
        ) {
          incrementalTextRecognitionRef.current = {
            strokes: testStrokes.slice(),
            characterCount: Array.from(compactText).length,
            text: compactText,
            pendingStrokeIndex: incrementalHint?.pendingStrokeIndex ?? 0,
            prefixText: incrementalHint?.previousText ?? '',
          }
        } else if (incrementalHint === undefined) {
          incrementalTextRecognitionRef.current = null
        }
        if (EMBEDDED_IN_FANOTES) {
          const requestId = `line-${createUuid()}`
          neuralRequestIdRef.current = requestId
          notifyFaNotes({
            type: 'glyphenwerk:recognize-neural',
            requestId,
            strokes: testStrokes,
            language: getGlyphenWerkLanguage(),
          })
        } else {
          setIsRecognizing(false)
        }
      }
    }, 180)
    const recognitionTimeout = window.setTimeout(() => {
      if (active) setIsRecognizing(false)
    }, 15_000)

    return () => {
      active = false
      window.clearTimeout(timer)
      window.clearTimeout(recognitionTimeout)
    }
  }, [labels, mathLayoutExamples, recognitionModel, testStrokes])

  useEffect(() => {
    if (!neuralTestResult || neuralTestResult.requestId !== neuralRequestIdRef.current || !testStrokes.length) return
    setIsRecognizing(false)
    const text = normalizeGermanSharpS(neuralTestResult.text)
      .normalize('NFC')
      .replace(/[ \t]{2,}/gu, ' ')
      .replace(/\s+([,.;:!?])/gu, '$1')
      .trim()
    if (!text) return
    const visible = Array.from(text).filter((char) => !/\s/u.test(char))
    const letters = visible.filter((char) => /^\p{L}$/u.test(char)).length
    const words = text.match(getGlyphenWerkLanguage() === 'de' ? /[A-Za-zÄÖÜäöü]{2,}/gu : /[A-Za-z]{2,}/gu) ?? []
    const letterRatio = letters / Math.max(1, visible.length)
    const explicitMath = /[=+×÷√∫∑Σ∏Π∞^_]/u.test(text)
    const strongKnownWord = hasStrongNeuralWordEvidence(
      neuralTestResult,
      letters,
      words.length >= 1,
    )
    const sentenceLike = (
      !explicitMath
      && neuralTestResult.confidence >= 38
      && letterRatio >= 0.68
      && (
        strongKnownWord
        ||
        (words.length >= 2 && letters >= 6)
        || (words.length >= 1 && letters >= 9 && /[aeiouyäöü]/iu.test(text))
      )
    )
    if (!sentenceLike) return
    const language = getGlyphenWerkLanguage()
    const textTokens = recognizeExpression(
      testStrokes,
      recognitionModel,
      labels,
      'text',
      mathLayoutExamples,
      language,
      visible.length,
      text,
    )
    recognitionFallbackRef.current = 'text'
    const compactNeuralText = text.replace(/\s+/gu, '')
    if (/^\p{L}{1,24}$/u.test(compactNeuralText)) {
      incrementalTextRecognitionRef.current = {
        strokes: testStrokes.slice(),
        characterCount: Array.from(compactNeuralText).length,
        text: compactNeuralText,
        pendingStrokeIndex: 0,
        prefixText: '',
      }
    }
    setRecognitionMode('text')
    setRecognitionTokens(textTokens)
    setMathLayoutAssignments([])
    setNeuralTestText(text)
    setAutomaticRecognition((current) => ({
      mode: 'text',
      tokens: textTokens,
      value: text,
      textValue: text,
      mathValue: current?.mathValue ?? '',
      confidence: Math.max(neuralTestResult.confidence, current?.confidence ?? 0),
      reason: neuralTestResult.lineCount > 1 ? 'neuronale Textzeilen' : 'neuronale Satzanalyse',
      textScore: Math.max(current?.textScore ?? 0, (current?.mathScore ?? 0) + 1.2),
      mathScore: current?.mathScore ?? 0,
    }))
  }, [labels, mathLayoutExamples, neuralTestResult, recognitionModel, testStrokes])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 3_400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const chooseCategory = (category: CategoryId) => {
    setSelectedCategory(category)
    setPickerSearch('')
    const first = labels.find((label) => label.category === category)
    if (first) setSelectedLabelId(first.id)
  }

  const handleSave = useCallback(async () => {
    if (isSaving || !canvasState.hasInk || !selectedLabel) return
    const exported = canvasRef.current?.exportSample()
    if (!exported) {
      showToast('Zeichne zuerst ein Zeichen auf die Fläche.', 'error')
      return
    }

    setIsSaving(true)
    const now = new Date().toISOString()
    const sample: Sample = {
      id: createUuid(),
      labelId: selectedLabel.id,
      label: selectedLabel.char,
      labelName: selectedLabel.name,
      latex: selectedLabel.latex,
      category: selectedLabel.category,
      writerId: writerId.trim() || 'person-unbekannt',
      sessionId: sessionIdRef.current,
      createdAt: now,
      imageData: exported.imageData,
      imageWidth: 256,
      imageHeight: 256,
      sourceCanvas: {
        width: exported.sourceWidth,
        height: exported.sourceHeight,
        devicePixelRatio: exported.devicePixelRatio,
      },
      bbox: exported.bbox,
      strokes: exported.strokes,
      strokeCount: exported.strokes.length,
      pointCount: exported.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0),
      schemaVersion: 1,
    }

    try {
      await putSample(sample)
      setSamples((current) => [sample, ...current])
      notifyFaNotes({ type: 'glyphenwerk:samples-added', samples: [sample] })
      canvasRef.current?.clear()
      showToast(`Beispiel für „${selectedLabel.char}“ gespeichert.`)

      if (captureMode === 'balanced') {
        const candidates = labels.filter((label) => label.category === selectedCategory)
        const projectedCounts = new Map(counts)
        projectedCounts.set(selectedLabel.id, (projectedCounts.get(selectedLabel.id) ?? 0) + 1)
        candidates.sort((a, b) =>
          (projectedCounts.get(a.id) ?? 0) - (projectedCounts.get(b.id) ?? 0) ||
          a.id.localeCompare(b.id),
        )
        if (candidates[0]) setSelectedLabelId(candidates[0].id)
      }
      void updateStorageEstimate()
    } catch {
      showToast('Das Beispiel konnte nicht lokal gespeichert werden.', 'error')
    } finally {
      setIsSaving(false)
    }
  }, [
    canvasState.hasInk,
    captureMode,
    counts,
    isSaving,
    labels,
    selectedCategory,
    selectedLabel,
    showToast,
    updateStorageEstimate,
    writerId,
  ])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement
      if (element.matches('input, textarea, select, [contenteditable="true"]')) return
      const command = event.metaKey || event.ctrlKey
      if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        const activeCanvas = view === 'test' ? testCanvasRef.current : canvasRef.current
        if (event.shiftKey) activeCanvas?.redo()
        else activeCanvas?.undo()
      }
      if (view === 'capture' && event.key === 'Enter') {
        event.preventDefault()
        void handleSave()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleSave, view])

  const handleAddCustom = (event: FormEvent) => {
    event.preventDefault()
    const char = customChar.trim()
    if (!char) return
    if (containsGermanSharpS(char)) {
      showToast('FaNotes verwendet Schweizer Rechtschreibung mit „ss“ statt „ß“.', 'error')
      return
    }
    const label: LabelDefinition = {
      id: `custom_${createUuid().slice(0, 12)}`,
      char: char.slice(0, 4),
      name: customName.trim() || `Eigenes Zeichen ${char}`,
      latex: customLatex.trim() || char,
      category: 'custom',
    }
    const next = [...customLabels, label]
    setCustomLabels(next)
    localStorage.setItem('glyphenwerk-custom-labels', JSON.stringify(next))
    notifyFaNotes({ type: 'glyphenwerk:labels-added', labels: [label] })
    setSelectedCategory('custom')
    setSelectedLabelId(label.id)
    setCustomChar('')
    setCustomName('')
    setCustomLatex('')
    setShowCustomModal(false)
    showToast(`„${label.char}“ wurde zum Katalog hinzugefügt.`)
  }

  const sampleFromRecognition = (token: RecognitionToken, label: LabelDefinition): Sample => ({
    id: createUuid(),
    labelId: label.id,
    label: label.char,
    labelName: label.name,
    latex: label.latex,
    category: label.category,
    writerId: writerId.trim() || 'person-unbekannt',
    sessionId: sessionIdRef.current,
    createdAt: new Date().toISOString(),
    imageData: token.imageData,
    imageWidth: 256,
    imageHeight: 256,
    sourceCanvas: {
      width: 900,
      height: 560,
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 3),
    },
    bbox: token.bbox,
    strokes: token.strokes,
    strokeCount: token.strokes.length,
    pointCount: token.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0),
    schemaVersion: 1,
  })

  const persistRecognitionExamples = async (
    entries: { token: RecognitionToken; label: LabelDefinition }[],
  ) => {
    const newSamples = entries.map(({ token, label }) => sampleFromRecognition(token, label))
    await Promise.all(newSamples.map((sample) => putSample(sample)))
    setSamples((current) => [...newSamples, ...current])
    notifyFaNotes({ type: 'glyphenwerk:samples-added', samples: newSamples })
    setLearnedTokenIds((current) => {
      const next = new Set(current)
      entries.forEach(({ token }) => next.add(token.id))
      return next
    })
    void updateStorageEstimate()
    return newSamples.length
  }

  const handleTokenCorrection = async (tokenId: string, labelId: string) => {
    const token = recognitionTokens.find((entry) => entry.id === tokenId)
    const label = labels.find((entry) => entry.id === labelId)
    if (!token || !label) return

    const correctedTokens = recognitionTokens.map((entry) =>
      entry.id === tokenId
        ? { ...entry, labelId: label.id, char: label.char, name: label.name, latex: label.latex, confidence: 100 }
        : entry
    )
    correctedRecognitionInputRef.current = testStrokes
    setNeuralTestText('')
    setRecognitionTokens(correctedTokens)
    const visible = correctedTokens.filter((entry) => !entry.isLayout)
    const correctedToSingleTextLetter = (
      visible.length === 1 &&
      (label.category === 'uppercase' || label.category === 'lowercase' || label.category === 'german')
    )
    const compactCorrectedText = recognizedSentence(correctedTokens).replace(/\s+/gu, '')
    if (
      (correctedToSingleTextLetter || recognitionMode === 'text') &&
      /^\p{L}{1,24}$/u.test(compactCorrectedText)
    ) {
      incrementalTextRecognitionRef.current = {
        strokes: testStrokes.slice(),
        characterCount: Array.from(compactCorrectedText).length,
        text: compactCorrectedText,
        pendingStrokeIndex: 0,
        prefixText: '',
      }
    }
    if (correctedToSingleTextLetter) {
      recognitionFallbackRef.current = 'text'
      setRecognitionMode('text')
      setMathLayoutAssignments([])
      setAutomaticRecognition((current) => current ? {
        ...current,
        mode: 'text',
        tokens: correctedTokens,
        value: recognizedSentence(correctedTokens),
        confidence: 100,
        reason: 'bestätigte manuelle Korrektur',
        textScore: Math.max(current.textScore, current.mathScore + 1),
      } : current)
    } else if (recognitionMode === 'math') {
      setMathLayoutAssignments(suggestMathLayoutAssignments(correctedTokens, mathLayoutExamples))
    }

    try {
      await persistRecognitionExamples([{ token, label }])
      showToast(`Korrektur „${label.char}“ gespeichert – das Modell wurde aktualisiert.`)
    } catch {
      showToast('Die Korrektur konnte nicht als Trainingsbeispiel gespeichert werden.', 'error')
    }
  }

  const handleLayoutAssignmentChange = (tokenId: string, value: string) => {
    setMathLayoutAssignments((current) => {
      const withoutToken = current.filter((assignment) => assignment.tokenId !== tokenId)
      if (!value) return withoutToken
      const separator = value.indexOf('|')
      if (separator < 0) return withoutToken
      const role = value.slice(0, separator) as MathLayoutAssignment['role']
      const anchorId = value.slice(separator + 1)
      if (!anchorId || anchorId === tokenId) return withoutToken
      return [...withoutToken, { tokenId, anchorId, role }]
    })
  }

  const handleConfirmRecognition = async () => {
    const entries = recognitionTokens.flatMap((token) => {
      if (learnedTokenIds.has(token.id)) return []
      const label = labels.find((candidate) => candidate.id === token.labelId)
      return label ? [{ token, label }] : []
    })
    const currentLayoutKey = layoutTrainingKey(mathLayoutAssignments)
    const shouldLearnLayout = (
      recognitionMode === 'math' &&
      mathLayoutAssignments.length > 0 &&
      !learnedLayoutKeys.has(currentLayoutKey)
    )
    if (entries.length === 0 && !shouldLearnLayout) {
      showToast('Alle erkannten Zeichen wurden bereits gelernt.')
      return
    }
    try {
      const count = entries.length ? await persistRecognitionExamples(entries) : 0
      let layoutCount = 0
      if (shouldLearnLayout) {
        const newLayoutExamples = createMathLayoutExamples(recognitionTokens, mathLayoutAssignments)
        layoutCount = newLayoutExamples.length
        if (layoutCount > 0) {
          const next = [...newLayoutExamples, ...mathLayoutExamples].slice(0, 800)
          localStorage.setItem('glyphenwerk-math-layout-examples', JSON.stringify(next))
          setMathLayoutExamples(next)
          notifyFaNotes({ type: 'glyphenwerk:layouts-replaced', layouts: next })
          setLearnedLayoutKeys((current) => new Set(current).add(currentLayoutKey))
        }
      }
      const glyphMessage = count ? `${count} ${count === 1 ? 'Zeichen' : 'Zeichen'}` : ''
      const layoutMessage = layoutCount ? `${layoutCount} ${layoutCount === 1 ? 'Positionsmuster' : 'Positionsmuster'}` : ''
      showToast(`${[glyphMessage, layoutMessage].filter(Boolean).join(' und ')} bestätigt und gelernt.`)
    } catch {
      showToast('Die Bestätigung konnte nicht gespeichert werden.', 'error')
    }
  }

  const copyToClipboard = async (value: string, description: string) => {
    if (!value) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = value
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        textarea.remove()
      }
      showToast(`${description} kopiert.`)
    } catch {
      showToast('Kopieren ist in diesem Browser nicht verfügbar.', 'error')
    }
  }

  const handleRemoveSample = async (sample: Sample) => {
    try {
      await removeSample(sample.id)
      setSamples((current) => current.filter((entry) => entry.id !== sample.id))
      notifyFaNotes({ type: 'glyphenwerk:samples-removed', ids: [sample.id] })
      showToast('Beispiel gelöscht.')
      void updateStorageEstimate()
    } catch {
      showToast('Das Beispiel konnte nicht gelöscht werden.', 'error')
    }
  }

  const handleClearDataset = async () => {
    if (!window.confirm(`Wirklich alle ${samples.length} Beispiele unwiderruflich löschen?`)) return
    try {
      const removedIds = samples.map((sample) => sample.id)
      await removeAllSamples()
      setSamples([])
      localStorage.removeItem('glyphenwerk-math-layout-examples')
      setMathLayoutExamples([])
      setMathLayoutAssignments([])
      setLearnedLayoutKeys(new Set())
      notifyFaNotes({ type: 'glyphenwerk:samples-removed', ids: removedIds })
      notifyFaNotes({ type: 'glyphenwerk:layouts-replaced', layouts: [] })
      showToast('Der lokale Datensatz wurde geleert.')
      void updateStorageEstimate()
    } catch {
      showToast('Der Datensatz konnte nicht geleert werden.', 'error')
    }
  }

  const handleResetLayoutExamples = () => {
    if (!window.confirm(`Wirklich alle ${mathLayoutExamples.length} gelernten Positionsmuster löschen?`)) return
    localStorage.removeItem('glyphenwerk-math-layout-examples')
    setMathLayoutExamples([])
    setLearnedLayoutKeys(new Set())
    setMathLayoutAssignments(suggestMathLayoutAssignments(recognitionTokens))
    notifyFaNotes({ type: 'glyphenwerk:layouts-replaced', layouts: [] })
    showToast('Gelernte Positionsmuster wurden zurückgesetzt.')
  }

  const handleExport = async () => {
    if (samples.length === 0 || isExporting) return
    setIsExporting(true)
    setExportProgress(1)
    try {
      await exportDataset(samples, labels, writerId, mathLayoutExamples, setExportProgress)
      showToast('ZIP-Datensatz wurde erstellt.')
    } catch {
      showToast('Der Export ist fehlgeschlagen.', 'error')
    } finally {
      setIsExporting(false)
      setExportProgress(0)
    }
  }

  const pickerLabels = labels.filter((label) => {
    const query = pickerSearch.trim().toLocaleLowerCase('de')
    return (
      label.category === selectedCategory &&
      (!query ||
        label.char.toLocaleLowerCase('de').includes(query) ||
        label.name.toLocaleLowerCase('de').includes(query) ||
        label.latex.toLocaleLowerCase('de').includes(query))
    )
  })

  const visibleSamples = samples.filter((sample) => {
    const query = collectionSearch.trim().toLocaleLowerCase('de')
    const categoryMatches = collectionCategory === 'all' || sample.category === collectionCategory
    const queryMatches =
      !query ||
      sample.label.toLocaleLowerCase('de').includes(query) ||
      sample.labelName.toLocaleLowerCase('de').includes(query) ||
      sample.latex.toLocaleLowerCase('de').includes(query)
    return categoryMatches && queryMatches
  })

  const previewLayoutExamples = useMemo(() => recognitionMode === 'math'
    ? [...createMathLayoutExamples(recognitionTokens, mathLayoutAssignments), ...mathLayoutExamples]
    : mathLayoutExamples,
  [mathLayoutAssignments, mathLayoutExamples, recognitionMode, recognitionTokens])
  const testText = recognitionMode === 'text'
    ? neuralTestText || recognizedSentence(recognitionTokens)
    : recognizedText(recognitionTokens, previewLayoutExamples)
  const testLatex = recognitionMode === 'math'
    ? recognizedLatex(recognitionTokens, previewLayoutExamples)
    : ''
  const reviewTokens = recognitionMode === 'text'
    ? recognitionTokens.filter((token) => !token.isLayout)
    : [...recognitionTokens.filter((token) => !token.isLayout)].sort((first, second) => {
      if (first.layout?.groupId && first.layout.groupId === second.layout?.groupId) {
        const roleOrder = { numerator: 0, denominator: 1, bar: 2 }
        const roleDifference = roleOrder[first.layout.role] - roleOrder[second.layout.role]
        if (roleDifference !== 0) return roleDifference
      }
      return first.bbox[0] - second.bbox[0]
    })
  const averageConfidence = reviewTokens.length
    ? Math.round(reviewTokens.reduce((sum, token) => sum + token.confidence, 0) / reviewTokens.length)
    : 0
  const currentLayoutKey = layoutTrainingKey(mathLayoutAssignments)
  const hasUnlearnedLayout = (
    recognitionMode === 'math' &&
    mathLayoutAssignments.length > 0 &&
    !learnedLayoutKeys.has(currentLayoutKey)
  )
  const hasUnlearnedGlyph = reviewTokens.some((token) => !learnedTokenIds.has(token.id) && token.labelId)
  const largeOperatorTokens = reviewTokens.filter((token) => isLargeMathOperator(token.labelId))

  const navItems: { id: ViewId; label: string; icon: IconName }[] = [
    { id: 'capture', label: 'Erfassen', icon: 'pen' },
    { id: 'test', label: 'Erkennung testen', icon: 'scan' },
    { id: 'collection', label: 'Sammlung', icon: 'grid' },
    { id: 'export', label: 'Exportieren', icon: 'download' },
  ]

  return (
    <div className={`app-shell ${EMBEDDED_IN_FANOTES ? 'is-fanotes-embedded' : ''}`}>
      <aside className="sidebar">
        <button className="brand" onClick={() => setView('capture')} aria-label="Zur Erfassung">
          <span className="brand-mark"><span>∫</span></span>
          <span className="brand-copy"><strong>GlyphenWerk</strong><small>Handschrift-Dataset</small></span>
        </button>

        <nav className="main-nav" aria-label="Hauptnavigation">
          <span className="nav-eyebrow">Arbeitsbereich</span>
          {navItems.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? 'nav-item active' : 'nav-item'}
              onClick={() => setView(item.id)}
            >
              <Icon name={item.icon} size={19} />
              <span>{item.label}</span>
              {item.id === 'collection' && samples.length > 0 && <em>{samples.length}</em>}
            </button>
          ))}
        </nav>

        <div className="sidebar-spacer" />
        <div className="dataset-mini-card">
          <div className="mini-card-heading">
            <span>Dein Datensatz</span>
            <Icon name="database" size={17} />
          </div>
          <strong>{samples.length}</strong>
          <small>Beispiele in {uniqueLabelCount} Klassen</small>
          <div className="mini-progress"><span style={{ width: `${Math.min(100, (samples.length / 250) * 100)}%` }} /></div>
          <p>{samples.length < 250 ? `${250 - samples.length} bis zum ersten Meilenstein` : 'Erster Meilenstein erreicht'}</p>
        </div>
        <div className="local-status"><span className="status-dot" /> <span>{EMBEDDED_IN_FANOTES ? 'Direkt mit FaNotes verbunden' : 'Nur lokal gespeichert'}</span></div>
      </aside>

      <main className="main-content">
        <header className="mobile-header">
          <button className="brand compact" onClick={() => setView('capture')}>
            <span className="brand-mark"><span>∫</span></span>
            <span className="brand-copy"><strong>GlyphenWerk</strong></span>
          </button>
          <div className="mobile-nav">
            {navItems.map((item) => (
              <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)} aria-label={item.label}>
                <Icon name={item.icon} size={19} />
              </button>
            ))}
          </div>
        </header>

        {view === 'capture' && (
          <section className="page capture-page">
            <div className="page-heading">
              <div>
                <span className="page-kicker">Datenerfassung</span>
                <h1>Handschrift erfassen</h1>
                <p>Wähle ein Zeichen, schreibe es natürlich und speichere beliebig viele Varianten.</p>
              </div>
              <div className="privacy-pill"><Icon name="shield" size={16} /> Lokal & privat</div>
            </div>

            <div className="capture-grid">
              <article className="panel capture-card">
                <div className="capture-card-header">
                  <div className="selected-label-lockup">
                    <span className="selected-glyph">{selectedLabel.char}</span>
                    <div>
                      <small>Aktives Zeichen</small>
                      <strong>{selectedLabel.name}</strong>
                      <code>{selectedLabel.latex}</code>
                    </div>
                  </div>
                  <div className="mode-switch" aria-label="Erfassungsmodus">
                    <button className={captureMode === 'free' ? 'active' : ''} onClick={() => setCaptureMode('free')}>Frei</button>
                    <button className={captureMode === 'balanced' ? 'active' : ''} onClick={() => setCaptureMode('balanced')}><Icon name="sparkle" size={14} /> Ausgewogen</button>
                  </div>
                </div>

                <div className={canvasState.hasInk ? 'canvas-stage has-ink' : 'canvas-stage'}>
                  <div className="canvas-paper-pattern" />
                  {!canvasState.hasInk && (
                    <div className="canvas-placeholder" aria-hidden="true">
                      <span><Icon name="pen" size={24} /></span>
                      <strong>Schreibe „{selectedLabel.char}“</strong>
                      <small>Mit Stift oder Maus · Trackpad scrollt</small>
                    </div>
                  )}
                  <DrawingCanvas
                    ref={canvasRef}
                    brushSize={brushSize}
                    pressureEnabled={pressureEnabled}
                    onStateChange={setCanvasState}
                  />
                  <span className="canvas-corner top-left" />
                  <span className="canvas-corner top-right" />
                  <span className="canvas-corner bottom-left" />
                  <span className="canvas-corner bottom-right" />
                </div>

                <div className="canvas-toolbar">
                  <div className="tool-group">
                    <button className="icon-button" disabled={!canvasState.canUndo} onClick={() => canvasRef.current?.undo()} title="Rückgängig (Strg/⌘ Z)"><Icon name="undo" size={18} /></button>
                    <button className="icon-button" disabled={!canvasState.canRedo} onClick={() => canvasRef.current?.redo()} title="Wiederholen (Strg/⌘ Umschalt Z)"><Icon name="redo" size={18} /></button>
                    <button className="text-tool" disabled={!canvasState.hasInk} onClick={() => canvasRef.current?.clear()}><Icon name="trash" size={17} /> Leeren</button>
                  </div>
                  <div className="tool-group brush-tools">
                    <span className="tool-label">Strich</span>
                    {[3, 6, 10].map((size) => (
                      <button key={size} className={brushSize === size ? 'brush-button active' : 'brush-button'} onClick={() => setBrushSize(size)} title={`Strichstärke ${size}`}>
                        <i style={{ width: size + 2, height: size + 2 }} />
                      </button>
                    ))}
                    <button className={pressureEnabled ? 'pressure-button active' : 'pressure-button'} onClick={() => setPressureEnabled((value) => !value)} title="Stiftdruck berücksichtigen">
                      Druck <span />
                    </button>
                  </div>
                </div>

                <div className="capture-footer">
                  <div className="keyboard-hint"><kbd>Enter</kbd> speichern <span>·</span> <kbd>⌘ Z</kbd> zurück</div>
                  <button className="primary-button save-button" disabled={!canvasState.hasInk || isSaving} onClick={() => void handleSave()}>
                    {isSaving ? 'Speichert …' : <><Icon name="check" size={19} /> Beispiel speichern</>}
                  </button>
                </div>
              </article>

              <aside className="panel picker-card">
                <div className="picker-heading">
                  <div><span className="step-number">1</span><div><small>Label festlegen</small><h2>Zeichen wählen</h2></div></div>
                  <button className="icon-button add-label-button" onClick={() => setShowCustomModal(true)} title="Eigenes Zeichen anlegen"><Icon name="plus" size={19} /></button>
                </div>

                <div className="category-tabs" role="tablist">
                  {CATEGORIES.map((category) => (
                    <button key={category.id} role="tab" aria-selected={selectedCategory === category.id} className={selectedCategory === category.id ? 'active' : ''} onClick={() => chooseCategory(category.id)}>
                      {category.id === 'german' ? <span data-i18n-ignore>{category.shortLabel}</span> : category.shortLabel}
                    </button>
                  ))}
                </div>

                <label className="search-field picker-search">
                  <Icon name="search" size={17} />
                  <input value={pickerSearch} onChange={(event) => setPickerSearch(event.target.value)} placeholder="Zeichen oder LaTeX suchen" />
                  {pickerSearch && <button onClick={() => setPickerSearch('')} aria-label="Suche leeren"><Icon name="close" size={15} /></button>}
                </label>

                <div className="symbol-grid">
                  {pickerLabels.map((label) => (
                    <button
                      key={label.id}
                      className={selectedLabelId === label.id ? 'symbol-button active' : 'symbol-button'}
                      onClick={() => setSelectedLabelId(label.id)}
                      title={`${label.name} · ${label.latex}`}
                    >
                      <span>{label.char}</span>
                      {(counts.get(label.id) ?? 0) > 0 && <em>{counts.get(label.id)}</em>}
                    </button>
                  ))}
                  {pickerLabels.length === 0 && (
                    <div className="picker-empty">
                      <span>∅</span>
                      <strong>{selectedCategory === 'custom' ? 'Noch keine eigenen Zeichen' : 'Nichts gefunden'}</strong>
                      {selectedCategory === 'custom' && <button onClick={() => setShowCustomModal(true)}>Zeichen anlegen</button>}
                    </div>
                  )}
                </div>

                <div className="picker-summary">
                  <div><strong>{counts.get(selectedLabel.id) ?? 0}</strong><span>für „{selectedLabel.char}“</span></div>
                  <div><strong>{sessionSampleCount}</strong><span>diese Sitzung</span></div>
                </div>
                {captureMode === 'balanced' && (
                  <div className="balanced-note"><Icon name="sparkle" size={16} /><span>Nach dem Speichern folgt automatisch die Klasse mit den wenigsten Beispielen.</span></div>
                )}
              </aside>
            </div>

            <section className="recent-section">
              <div className="section-heading-row">
                <div><h2>Zuletzt erfasst</h2><span>{samples.length > 0 ? 'Automatisch lokal gesichert' : 'Deine ersten Beispiele erscheinen hier'}</span></div>
                {samples.length > 0 && <button className="link-button" onClick={() => setView('collection')}>Alle ansehen <Icon name="chevron" size={15} /></button>}
              </div>
              <div className="recent-strip">
                {samples.slice(0, 7).map((sample) => (
                  <div className="recent-sample" key={sample.id}>
                    <img src={sample.imageData} alt={`Handschriftliches ${sample.label}`} />
                    <span>{sample.label}</span>
                  </div>
                ))}
                {samples.length === 0 && (
                  <div className="recent-empty"><Icon name="pen" size={21} /><span>Schreibe oben dein erstes Zeichen – es bleibt auf diesem Gerät.</span></div>
                )}
              </div>
            </section>
          </section>
        )}

        {view === 'test' && (
          <section className="page test-page">
            <div className="page-heading">
              <div>
                <span className="page-kicker">Gemeinsame adaptive Handschrifterkennung</span>
                <h1>Text &amp; Mathematik testen</h1>
                <p>Schreibe einen Satz, Term oder eine vollständige Gleichung. GlyphenWerk erkennt Inhalt und Layout gemeinsam und wählt den passenden Ausgabemodus automatisch.</p>
              </div>
              <div className="test-heading-actions">
                <div className={`automatic-mode-pill ${automaticRecognition ? `is-${recognitionMode}` : ''}`} role="status" aria-live="polite">
                  <span><Icon name="sparkle" size={16} /></span>
                  <div><small>Automatische Erkennung</small><strong>{automaticRecognition
                    ? `${recognitionMode === 'math' ? 'Mathematik' : 'Text'} erkannt`
                    : 'Text & Mathematik aktiv'}</strong></div>
                  {automaticRecognition && <em>{automaticRecognition.confidence}%</em>}
                </div>
                <div className={isModelLoading ? 'model-status-pill loading' : 'model-status-pill'}>
                  <span className="model-pulse" />
                  {isModelLoading
                    ? 'Standardmodell wird geladen …'
                    : samples.length
                      ? `Standardmodell + ${samples.length} persönliche Beispiele`
                      : 'Standardmodell aktiv · Training optional'}
                </div>
              </div>
            </div>

            <div className="test-grid">
              <article className="panel test-workspace">
                <div className="test-workspace-header">
                  <div>
                    <span className="test-header-icon"><Icon name="scan" size={20} /></span>
                    <div><small>Testfläche</small><h2>Text, Term oder Gleichung schreiben</h2></div>
                  </div>
                  <div className="live-indicator"><i className={isRecognizing ? 'active' : ''} /> {isRecognizing ? 'Analysiert …' : 'Live-Erkennung'}</div>
                </div>

                <div className={testCanvasState.hasInk ? 'canvas-stage test-canvas-stage has-ink' : 'canvas-stage test-canvas-stage'}>
                  <div className="canvas-paper-pattern" />
                  {!testCanvasState.hasInk && (
                    <div className="canvas-placeholder test-placeholder" aria-hidden="true">
                      <span><Icon name="pen" size={24} /></span>
                      <strong>z. B. Heute ist ein schöner Tag. oder ∑ i²</strong>
                      <small>Wortabstände, Brüche, Indizes und Integrationsgrenzen werden gemeinsam analysiert</small>
                    </div>
                  )}
                  <DrawingCanvas
                    ref={testCanvasRef}
                    brushSize={brushSize}
                    pressureEnabled={pressureEnabled}
                    onStateChange={setTestCanvasState}
                    onStrokesChange={handleTestStrokesChange}
                  />
                  <span className="canvas-corner top-left" />
                  <span className="canvas-corner top-right" />
                  <span className="canvas-corner bottom-left" />
                  <span className="canvas-corner bottom-right" />
                </div>

                <div className="canvas-toolbar test-toolbar">
                  <div className="tool-group">
                    <button className="icon-button" disabled={!testCanvasState.canUndo} onClick={() => testCanvasRef.current?.undo()} title="Rückgängig"><Icon name="undo" size={18} /></button>
                    <button className="icon-button" disabled={!testCanvasState.canRedo} onClick={() => testCanvasRef.current?.redo()} title="Wiederholen"><Icon name="redo" size={18} /></button>
                    <button className="text-tool" disabled={!testCanvasState.hasInk} onClick={() => testCanvasRef.current?.clear()}><Icon name="trash" size={17} /> Leeren</button>
                  </div>
                  <div className="tool-group brush-tools">
                    <span className="tool-label">Strich</span>
                    {[3, 6, 10].map((size) => (
                      <button key={size} className={brushSize === size ? 'brush-button active' : 'brush-button'} onClick={() => setBrushSize(size)} title={`Strichstärke ${size}`}><i style={{ width: size + 2, height: size + 2 }} /></button>
                    ))}
                    <button className={pressureEnabled ? 'pressure-button active' : 'pressure-button'} onClick={() => setPressureEnabled((value) => !value)} title="Stiftdruck berücksichtigen">Druck <span /></button>
                  </div>
                </div>

                <div className="recognition-output">
                  <div className="recognition-output-heading">
                    <div><span className="recognition-spark"><Icon name="sparkle" size={17} /></span><div><small>Erkanntes Ergebnis</small><strong>{reviewTokens.length ? `${reviewTokens.length} Zeichen · ${averageConfidence}% Sicherheit` : 'Wartet auf Eingabe'}</strong></div></div>
                    {isRecognizing && <span className="recognition-loader" />}
                  </div>

                  <div data-i18n-ignore={testText ? true : undefined} className={`${testText ? 'recognized-expression' : 'recognized-expression empty'}${recognitionMode === 'math' ? ' math-rendered' : ''}`}>
                    {recognitionMode === 'math' && testLatex
                      ? <MathFormula latex={testLatex} fallback={testText} />
                      : testText || 'Dein erkanntes Ergebnis erscheint hier'}
                  </div>

                  <div className="recognition-formats">
                    <div>
                      <span>Text</span>
                      <code data-i18n-ignore={testText ? true : undefined}>{testText || '—'}</code>
                      <button disabled={!testText} onClick={() => void copyToClipboard(testText, 'Text')} title="Text kopieren"><Icon name="copy" size={15} /></button>
                    </div>
                    {recognitionMode === 'math' ? (
                      <div>
                        <span>LaTeX</span>
                        <code data-i18n-ignore={testLatex ? true : undefined}>{testLatex || '—'}</code>
                        <button disabled={!testLatex} onClick={() => void copyToClipboard(testLatex, 'LaTeX')} title="LaTeX kopieren"><Icon name="copy" size={15} /></button>
                      </div>
                    ) : (
                      <div className="text-context-format">
                        <span>Erkannt als</span>
                        <code>{automaticRecognition ? `Text · ${automaticRecognition.reason}` : 'Automatisch · Text oder Mathematik'}</code>
                      </div>
                    )}
                  </div>
                </div>
              </article>

              <aside className="test-side-column">
                <article className="panel token-review-card">
                  <div className="token-review-heading">
                    <div><span className="step-number">2</span><div><small>Kontrolle & Lernen</small><h2>Erkannte Zeichen</h2></div></div>
                    {reviewTokens.length > 0 && <span>{reviewTokens.length}</span>}
                  </div>

                  {reviewTokens.length > 0 ? (
                    <>
                      <div className="token-list">
                        {reviewTokens.map((token, index) => {
                          const assignment = mathLayoutAssignments.find((entry) => entry.tokenId === token.id)
                          const assignmentValue = assignment ? `${assignment.role}|${assignment.anchorId}` : ''
                          const indexAnchors = reviewTokens.filter((anchor) => anchor.id !== token.id)
                          return (
                            <div className={learnedTokenIds.has(token.id) ? 'token-row learned' : 'token-row'} key={token.id}>
                              <span className="token-index">{index + 1}</span>
                              <img src={token.imageData} alt={`Segment ${index + 1}`} />
                              <div className="token-choice">
                                <select value={token.labelId} onChange={(event) => void handleTokenCorrection(token.id, event.target.value)} aria-label={`Erkanntes Zeichen ${index + 1} korrigieren`}>
                                  {!token.labelId && <option value="">Zeichen wählen …</option>}
                                  {CATEGORIES.map((category) => (
                                    <optgroup key={category.id} label={category.label}>
                                      {labels.filter((label) => label.category === category.id).map((label) => (
                                        <option key={label.id} value={label.id}>{label.char} · {label.name}</option>
                                      ))}
                                    </optgroup>
                                  ))}
                                </select>
                                {recognitionMode === 'math' && !token.isLayout && (
                                  <select
                                    className="layout-relation-select"
                                    value={assignmentValue}
                                    onChange={(event) => handleLayoutAssignmentChange(token.id, event.target.value)}
                                    aria-label={`Position von Zeichen ${index + 1} festlegen`}
                                  >
                                    <option value="">Grundlinie · keine Relation</option>
                                    {largeOperatorTokens.some((anchor) => anchor.id !== token.id) && (
                                      <optgroup label="Operatorgrenze">
                                        {largeOperatorTokens.filter((anchor) => anchor.id !== token.id).flatMap((anchor) => [
                                          <option key={`upper-${anchor.id}`} value={`upper_limit|${anchor.id}`}>Oben bei {anchor.char} · obere Grenze</option>,
                                          <option key={`lower-${anchor.id}`} value={`lower_limit|${anchor.id}`}>Unten bei {anchor.char} · untere Grenze</option>,
                                        ])}
                                      </optgroup>
                                    )}
                                    {indexAnchors.length > 0 && (
                                      <optgroup label="Index">
                                        {indexAnchors.flatMap((anchor) => [
                                          <option key={`sup-${anchor.id}`} value={`superscript|${anchor.id}`}>Hochindex von {anchor.char}</option>,
                                          <option key={`sub-${anchor.id}`} value={`subscript|${anchor.id}`}>Tiefindex von {anchor.char}</option>,
                                        ])}
                                      </optgroup>
                                    )}
                                  </select>
                                )}
                                <div className="confidence-line">
                                  <span><i style={{ width: `${token.confidence}%` }} /></span>
                                  <em>{learnedTokenIds.has(token.id) ? 'Form gelernt' : `${token.confidence}%`}</em>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                      <button
                        className="primary-button learn-button"
                        disabled={!hasUnlearnedGlyph && !hasUnlearnedLayout}
                        onClick={() => void handleConfirmRecognition()}
                      >
                        <Icon name="sparkle" size={18} /> Bestätigen & lernen
                      </button>
                      <p className="learn-caption">Zeichenform und ausgewählte Position werden getrennt gelernt. Korrigiere bei Bedarf „obere Grenze“, „untere Grenze“, „Hochindex“ oder „Tiefindex“ vor dem Bestätigen.</p>
                    </>
                  ) : (
                    <div className="token-empty">
                      <span><Icon name="scan" size={27} /></span>
                      <strong>{isModelLoading ? 'Standardmodell wird vorbereitet' : 'Noch keine Segmente'}</strong>
                      <p>{isModelLoading
                        ? 'FaNotes lädt den eingebauten Text- und Mathematikzeichensatz.'
                        : 'Schreibe links Text oder Mathematik. GlyphenWerk erkennt den passenden Modus automatisch.'}</p>
                    </div>
                  )}
                </article>

                <article className="panel adaptive-model-card">
                  <div className="adaptive-model-title"><span><Icon name="database" size={19} /></span><div><small>Lokales Hybridmodell</small><h3>Sofort bereit, passt sich dir an</h3></div><em>Engine v7</em></div>
                  <div className="model-metrics">
                    <div><strong>{standardModelSize}</strong><span>Standardformen</span></div>
                    <div><strong>{new Set(recognitionModel.map((entry) => entry.labelId)).size}</strong><span>erkennbare Klassen</span></div>
                    <div><strong>{samples.length}</strong><span>persönliche Formen</span></div>
                    <div><strong>{mathLayoutExamples.length}</strong><span>Positionsmuster</span></div>
                  </div>
                  <div className="model-learning-flow"><span>Schreiben</span><i /><span>Prüfen</span><i /><span>Lernen</span></div>
                  <p><Icon name="shield" size={14} /> Ohne Training erkennt das Standardmodell gedruckte Grundformen. Bestätigte Beispiele ersetzen sie schrittweise durch deine persönliche Zeichenform.</p>
                  {mathLayoutExamples.length > 0 && <button className="layout-reset-button" onClick={handleResetLayoutExamples}>Positionsmuster zurücksetzen</button>}
                </article>
              </aside>
            </div>

            <div className="test-limit-note"><Icon name="info" size={18} /><span><strong>Eine gemeinsame Engine erkennt deutsche und englische Wörter ebenso wie Terme, Gleichungen, Brüche, Wurzeln, Hoch-/Tiefstellungen sowie Ober- und Untergrenzen.</strong> Die Entscheidung basiert auf Zeichenform, Wortabständen und dem räumlichen mathematischen Layout; jede bestätigte Korrektur personalisiert dasselbe Modell.</span></div>
          </section>
        )}

        {view === 'collection' && (
          <section className="page collection-page">
            <div className="page-heading">
              <div><span className="page-kicker">Qualitätskontrolle</span><h1>Deine Sammlung</h1><p>Prüfe deine Beispiele und entferne Ausreißer, bevor du sie exportierst.</p></div>
              <button className="primary-button" onClick={() => setView('capture')}><Icon name="plus" size={18} /> Neue Beispiele</button>
            </div>

            <div className="stats-row">
              <div className="stat-card"><span className="stat-icon mint"><Icon name="pen" /></span><div><strong>{samples.length}</strong><span>Beispiele gesamt</span></div></div>
              <div className="stat-card"><span className="stat-icon peach"><span>∑</span></span><div><strong>{uniqueLabelCount}</strong><span>aktive Klassen</span></div></div>
              <div className="stat-card"><span className="stat-icon blue"><Icon name="grid" /></span><div><strong>{uniqueLabelCount ? (samples.length / uniqueLabelCount).toFixed(1) : '0'}</strong><span>Ø je Klasse</span></div></div>
              <div className="stat-card"><span className="stat-icon lilac"><Icon name="database" /></span><div><strong>{storageUsage ? formatBytes(storageUsage) : '—'}</strong><span>lokal belegt</span></div></div>
            </div>

            <div className="collection-toolbar panel">
              <label className="search-field collection-search"><Icon name="search" size={18} /><input value={collectionSearch} onChange={(event) => setCollectionSearch(event.target.value)} placeholder="Nach Zeichen, Name oder LaTeX suchen" /></label>
              <select value={collectionCategory} onChange={(event) => setCollectionCategory(event.target.value as 'all' | CategoryId)} aria-label="Kategorie filtern">
                <option value="all">Alle Kategorien</option>
                {CATEGORIES.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}
              </select>
              <span className="result-count">{visibleSamples.length} von {samples.length}</span>
              {samples.length > 0 && <button className="danger-link" onClick={() => void handleClearDataset()}><Icon name="trash" size={16} /> Alle löschen</button>}
            </div>

            {isLoading ? (
              <div className="loading-state">Sammlung wird geladen …</div>
            ) : visibleSamples.length > 0 ? (
              <div className="sample-gallery">
                {visibleSamples.map((sample) => (
                  <article className="sample-card" key={sample.id}>
                    <div className="sample-image-wrap">
                      <img src={sample.imageData} alt={`Handschriftliches Zeichen ${sample.label}`} />
                      <button onClick={() => void handleRemoveSample(sample)} title="Beispiel löschen"><Icon name="trash" size={16} /></button>
                      <span>{sample.strokeCount} {sample.strokeCount === 1 ? 'Strich' : 'Striche'}</span>
                    </div>
                    <div className="sample-meta">
                      <span className="sample-char">{sample.label}</span>
                      <div><strong>{sample.labelName}</strong><code>{sample.latex}</code></div>
                    </div>
                    <footer><span>{categoryName(sample.category)}</span><time>{formatDate(sample.createdAt)}</time></footer>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state panel">
                <span className="empty-symbol">∅</span>
                <h2>{samples.length === 0 ? 'Noch keine Beispiele' : 'Keine Treffer'}</h2>
                <p>{samples.length === 0 ? 'Beginne mit einem Zeichen – jedes gespeicherte Beispiel landet automatisch hier.' : 'Passe Suche oder Kategorie an.'}</p>
                {samples.length === 0 && <button className="primary-button" onClick={() => setView('capture')}><Icon name="pen" size={18} /> Erstes Zeichen schreiben</button>}
              </div>
            )}
          </section>
        )}

        {view === 'export' && (
          <section className="page export-page">
            <div className="page-heading">
              <div><span className="page-kicker">Trainingspaket</span><h1>Datensatz exportieren</h1><p>Lade Bilder, Labels und rohe Stiftinformationen als portables ZIP herunter.</p></div>
              <div className="privacy-pill"><Icon name="shield" size={16} /> Keine Cloud-Übertragung</div>
            </div>

            <div className="export-grid">
              <div className="export-main-column">
                <article className="export-hero panel">
                  <div className="export-hero-icon"><Icon name="archive" size={31} /></div>
                  <div className="export-hero-copy">
                    <span className="ready-badge"><i /> {samples.length > 0 ? 'Bereit zum Export' : 'Noch keine Daten'}</span>
                    <h2>GlyphenWerk Trainingspaket</h2>
                    <p>{samples.length > 0 ? `${samples.length} Beispiele aus ${uniqueLabelCount} Klassen, vollständig beschriftet und normalisiert.` : 'Erfasse zuerst mindestens ein handschriftliches Zeichen.'}</p>
                    <div className="export-facts"><span><strong>{samples.length}</strong> PNGs</span><span><strong>{uniqueLabelCount}</strong> Labels</span><span><strong>256²</strong> Pixel</span></div>
                  </div>
                  <button className="primary-button export-button" disabled={samples.length === 0 || isExporting} onClick={() => void handleExport()}>
                    {isExporting ? `${exportProgress}% erstellt` : <><Icon name="download" size={19} /> ZIP herunterladen</>}
                  </button>
                  {isExporting && <div className="export-progress"><span style={{ width: `${exportProgress}%` }} /></div>}
                </article>

                <article className="panel package-card">
                  <div className="card-title-row"><div><span className="step-number">i</span><div><small>Enthaltene Dateien</small><h2>Was steckt im Paket?</h2></div></div></div>
                  <div className="package-list">
                    <div><span className="file-icon image">PNG</span><div><strong>images/</strong><p>Zentrierte Einzelzeichen, schwarz auf weiß</p></div><em>{samples.length} Dateien</em></div>
                    <div><span className="file-icon json">{'{ }'}</span><div><strong>manifest.jsonl</strong><p>Druck, Neigung, Zeit und normalisierte Strichpunkte</p></div><Icon name="check" size={18} /></div>
                    <div><span className="file-icon csv">CSV</span><div><strong>labels.csv</strong><p>Direkte Zuordnung von Bild zu Trainingsklasse</p></div><Icon name="check" size={18} /></div>
                    <div><span className="file-icon json">XY</span><div><strong>layout_examples.jsonl</strong><p>Trainierte Ober-/Untergrenzen und Hoch-/Tiefindizes</p></div><em>{mathLayoutExamples.length} Muster</em></div>
                    <div><span className="file-icon txt">TXT</span><div><strong>README.txt</strong><p>Hinweise für Split und Weiterverarbeitung</p></div><Icon name="check" size={18} /></div>
                  </div>
                </article>

                <div className="formula-notice"><Icon name="info" size={20} /><div><strong>Zeichenformen und räumliche Relationen werden getrennt exportiert.</strong><p>Damit lassen sich sowohl ein Glyphenklassifikator als auch ein Layoutmodell für Grenzen und Indizes trainieren.</p></div></div>
              </div>

              <aside className="export-side-column">
                <article className="panel settings-card">
                  <div className="card-title-row"><div><Icon name="settings" size={19} /><div><small>Metadaten</small><h2>Export-Einstellungen</h2></div></div></div>
                  <label className="form-field"><span>Pseudonyme Schreiber-ID</span><input value={writerId} onChange={(event) => { setWriterId(event.target.value); localStorage.setItem('glyphenwerk-writer-id', event.target.value) }} /></label>
                  <div className="setting-row"><span>Bildformat<small>verlustfrei</small></span><strong>PNG</strong></div>
                  <div className="setting-row"><span>Bildgröße<small>automatisch zentriert</small></span><strong>256 × 256</strong></div>
                  <div className="setting-row"><span>Hintergrund<small>trainingsfreundlich</small></span><strong>Weiß</strong></div>
                </article>

                <article className="panel balance-card">
                  <div className="card-title-row"><div><Icon name="grid" size={19} /><div><small>Datenqualität</small><h2>Klassenverteilung</h2></div></div></div>
                  {uniqueLabelCount > 0 ? (
                    <div className="balance-list">
                      {[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([labelId, count]) => {
                        const label = labels.find((entry) => entry.id === labelId)
                        const max = Math.max(...counts.values())
                        return <div key={labelId}><span className="balance-char">{label?.char ?? '?'}</span><span className="balance-track"><i style={{ width: `${(count / max) * 100}%` }} /></span><strong>{count}</strong></div>
                      })}
                    </div>
                  ) : <p className="balance-empty">Sobald du Beispiele speicherst, erscheint hier ihre Verteilung.</p>}
                  {uniqueLabelCount > 1 && Math.max(...counts.values()) > Math.min(...counts.values()) * 2 && (
                    <div className="balance-warning"><Icon name="sparkle" size={15} /> Der Modus „Ausgewogen“ hilft gegen unterrepräsentierte Klassen.</div>
                  )}
                </article>

                <div className="privacy-card"><Icon name="shield" size={21} /><div><strong>Deine Handschrift bleibt bei dir</strong><p>Alle Beispiele liegen im lokalen Browserspeicher und verlassen das Gerät nur durch deinen Download.</p></div></div>
              </aside>
            </div>
          </section>
        )}
      </main>

      {showCustomModal && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCustomModal(false) }}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="custom-label-title">
            <button className="modal-close" onClick={() => setShowCustomModal(false)} aria-label="Schließen"><Icon name="close" /></button>
            <span className="modal-icon"><Icon name="plus" size={22} /></span>
            <span className="page-kicker">Klassenkatalog</span>
            <h2 id="custom-label-title">Eigenes Zeichen anlegen</h2>
            <p>Füge ein Symbol hinzu, das im vorbereiteten Katalog noch fehlt.</p>
            <form onSubmit={handleAddCustom}>
              <label className="form-field prominent"><span>Zeichen</span><input autoFocus maxLength={4} value={customChar} onChange={(event) => setCustomChar(event.target.value)} placeholder="z. B. ⊕" required /></label>
              <label className="form-field"><span>Name</span><input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="z. B. Direkte Summe" /></label>
              <label className="form-field"><span>LaTeX <em>optional</em></span><input value={customLatex} onChange={(event) => setCustomLatex(event.target.value)} placeholder="z. B. \\oplus" /></label>
              <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setShowCustomModal(false)}>Abbrechen</button><button className="primary-button" disabled={!customChar.trim()}><Icon name="plus" size={18} /> Hinzufügen</button></div>
            </form>
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.tone}`} key={toast.id}><span><Icon name={toast.tone === 'success' ? 'check' : 'info'} size={17} /></span>{toast.message}</div>}
    </div>
  )
}

export default App
