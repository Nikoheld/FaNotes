import { Database, LoaderCircle, ShieldCheck, Upload, X } from 'lucide-react'
import { getUiLanguage } from '../i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MathLayoutExample } from '../../../src/lib/recognition'
import type { LabelDefinition, Sample, Stroke } from '../../../src/types'
import {
  loadRecognitionResources,
  putHandwritingLabels,
  putHandwritingSamples,
  removeHandwritingSamples,
  replaceManagedMathLayoutExamples,
} from '../lib/handwritingDb'

const SAMPLE_IDS_KEY = 'fanotes-glyphenwerk-sample-ids.v1'
const LAYOUT_IDS_KEY = 'fanotes-glyphenwerk-layout-ids.v1'
const MAX_SAMPLES_PER_MESSAGE = 12_000
const MAX_LAYOUTS_PER_MESSAGE = 50_000
const MAX_LABELS_PER_MESSAGE = 2_048

type GlyphenWerkMessage = {
  type?: unknown
  schemaVersion?: unknown
  samples?: unknown
  labels?: unknown
  layouts?: unknown
  ids?: unknown
  view?: unknown
  sampleCount?: unknown
  uniqueLabelCount?: unknown
  requestId?: unknown
  strokes?: unknown
  language?: unknown
  textCharacterCountHint?: unknown
  textCharacterHint?: unknown
}

const MAX_RECOGNITION_STROKES = 2_048
const MAX_RECOGNITION_POINTS = 80_000

const boundedNumber = (value: unknown, minimum: number, maximum: number) => (
  typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
)

const recognitionStrokes = (value: unknown): Stroke[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RECOGNITION_STROKES) return null
  let pointCount = 0
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const stroke = candidate as Partial<Stroke>
    if (
      !Array.isArray(stroke.points)
      || !stroke.points.length
      || stroke.points.length > 5_000
      || !boundedNumber(stroke.baseWidth, 0.25, 80)
      || typeof stroke.pressureEnabled !== 'boolean'
    ) return null
    pointCount += stroke.points.length
    if (pointCount > MAX_RECOGNITION_POINTS) return null
    for (const point of stroke.points) {
      if (
        !point
        || typeof point !== 'object'
        || !boundedNumber(point.x, -0.05, 1.05)
        || !boundedNumber(point.y, -0.05, 1.05)
        || !boundedNumber(point.pressure, 0, 1)
      ) return null
    }
  }
  return value as Stroke[]
}

const APPEARANCE_VARIABLES = [
  'bg',
  'bg-elevated',
  'panel',
  'panel-strong',
  'panel-hover',
  'border',
  'border-strong',
  'text',
  'text-soft',
  'text-muted',
  'danger',
  'success',
  'warning',
  'shadow',
  'accent',
  'accent-secondary',
  'accent-readable',
  'on-accent',
  'ui-font',
] as const

export type GlyphenWerkAppearance = {
  theme: 'dark' | 'light' | 'midnight' | 'forest' | 'aurora' | 'sepia'
  reduceMotion: boolean
}

export type GlyphenWerkView = 'capture' | 'test' | 'collection' | 'export'

export type GlyphenWerkWorkspaceProps = {
  activeView: GlyphenWerkView
  appearance: GlyphenWerkAppearance
  onClose: () => void
  onViewChange?: (view: GlyphenWerkView) => void
  onTrainingChanged?: (sampleCount: number) => void | Promise<void>
  onImportTraining?: (file: File) => Promise<void>
}

const isGlyphenWerkView = (value: unknown): value is GlyphenWerkView => value === 'capture' || value === 'test' || value === 'collection' || value === 'export'

const readManagedIds = (key: string, maximum: number) => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    if (!Array.isArray(parsed) || parsed.length > maximum) return []
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 160))]
  } catch {
    return []
  }
}

const writeManagedIds = (key: string, ids: string[]) => {
  localStorage.setItem(key, JSON.stringify([...new Set(ids)]))
}

const records = <T,>(value: unknown, maximum: number, label: string): T[] => {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} enthält ungültig viele Einträge.`)
  return value as T[]
}

const stringIds = (value: unknown) => {
  const ids = records<unknown>(value, MAX_SAMPLES_PER_MESSAGE, 'Die GlyphenWerk-Löschliste')
  if (ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 160)) {
    throw new Error('Die GlyphenWerk-Löschliste enthält eine ungültige ID.')
  }
  return [...new Set(ids as string[])]
}

export function GlyphenWerkWorkspace({ activeView, appearance, onClose, onViewChange, onTrainingChanged, onImportTraining }: GlyphenWerkWorkspaceProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const synchronizationRef = useRef<Promise<void>>(Promise.resolve())
  const [state, setState] = useState<'loading' | 'syncing' | 'ready' | 'error'>('loading')
  const [sampleCount, setSampleCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importBusy, setImportBusy] = useState(false)

  const recognizeTextRequest = useCallback(async (message: GlyphenWerkMessage) => {
    if (
      message.schemaVersion !== 1
      || message.type !== 'glyphenwerk:recognize-neural'
      || typeof message.requestId !== 'string'
      || message.requestId.length < 8
      || message.requestId.length > 100
      || (message.language !== 'de' && message.language !== 'en')
    ) return
    const strokes = recognitionStrokes(message.strokes)
    if (!strokes) return
    const textCharacterCountHint = Number.isSafeInteger(message.textCharacterCountHint)
      && Number(message.textCharacterCountHint) >= 1
      && Number(message.textCharacterCountHint) <= 320
      ? Number(message.textCharacterCountHint)
      : undefined
    const textCharacterHint = typeof message.textCharacterHint === 'string'
      && message.textCharacterHint.length <= 320
      && /^\p{L}{1,320}$/u.test(message.textCharacterHint)
      ? message.textCharacterHint
      : undefined
    const respond = (payload: Record<string, unknown>) => iframeRef.current?.contentWindow?.postMessage({
      type: 'glyphenwerk:neural-result',
      schemaVersion: 1,
      requestId: message.requestId,
      ...payload,
    }, '*')
    try {
      const [{ recognizeNeuralText }, resources] = await Promise.all([
        import('../lib/neuralTextRecognition'),
        loadRecognitionResources(),
      ])
      const neural = await recognizeNeuralText(strokes, message.language, 900, 560)
      const { recognizePersonalizedTextLine } = await import('../lib/personalizedLineRecognition')
      const personalized = await recognizePersonalizedTextLine(
        strokes,
        resources,
        neural,
        message.language,
        false,
        900,
        560,
        textCharacterCountHint,
        textCharacterHint,
      )
      respond({
        text: personalized.fusion.text.slice(0, 4_000),
        confidence: Math.max(neural.confidence, personalized.fusion.confidence),
        lineCount: neural.lines.length,
        wordCount: neural.wordCount ?? 0,
        knownWordRatio: neural.knownWordRatio ?? 0,
        personalizedCharacters: personalized.fusion.personalizedCharacters,
        classicalCharacters: personalized.fusion.classicalCharacters,
        personalizedSource: personalized.fusion.source,
        personalizedConfidence: personalized.fusion.confidence,
      })
    } catch (reason) {
      respond({
        text: '',
        confidence: 0,
        error: reason instanceof Error ? reason.message.slice(0, 300) : 'Neural recognition failed.',
      })
    }
  }, [])

  const sendNavigation = useCallback((view: GlyphenWerkView) => {
    iframeRef.current?.contentWindow?.postMessage({
      type: 'glyphenwerk:navigate',
      schemaVersion: 1,
      view,
    }, '*')
  }, [])

  const sendAppearance = useCallback(() => {
    const host = iframeRef.current?.closest<HTMLElement>('.app-shell')
    if (!host) return
    const computed = getComputedStyle(host)
    const palette = Object.fromEntries(APPEARANCE_VARIABLES.map((name) => [
      name,
      computed.getPropertyValue(`--${name}`).trim(),
    ]))
    iframeRef.current?.contentWindow?.postMessage({
      type: 'glyphenwerk:appearance',
      schemaVersion: 1,
      theme: appearance.theme,
      reduceMotion: appearance.reduceMotion,
      palette,
    }, '*')
  }, [appearance.reduceMotion, appearance.theme])

  useEffect(() => sendNavigation(activeView), [activeView, sendNavigation])
  useEffect(() => sendAppearance(), [sendAppearance])

  const finishSynchronization = useCallback(async () => {
    const resources = await loadRecognitionResources(true)
    setSampleCount(resources.sampleCount)
    setState('ready')
    setError(null)
    await onTrainingChanged?.(resources.sampleCount)
  }, [onTrainingChanged])

  const importZip = async (file: File | undefined) => {
    if (!file || !onImportTraining || importBusy) return
    setImportBusy(true)
    try {
      await onImportTraining(file)
      await finishSynchronization()
    } finally {
      setImportBusy(false)
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  const synchronize = useCallback(async (message: GlyphenWerkMessage) => {
    if (message.schemaVersion !== 1 || typeof message.type !== 'string') return
    setState('syncing')

    if (message.type === 'glyphenwerk:sync') {
      const samples = records<Sample>(message.samples, MAX_SAMPLES_PER_MESSAGE, 'Das GlyphenWerk-Training')
      const labels = records<LabelDefinition>(message.labels, MAX_LABELS_PER_MESSAGE, 'Die GlyphenWerk-Symbolklassen')
      const layouts = records<MathLayoutExample>(message.layouts, MAX_LAYOUTS_PER_MESSAGE, 'Das GlyphenWerk-Layouttraining')
      const previousSampleIds = readManagedIds(SAMPLE_IDS_KEY, MAX_SAMPLES_PER_MESSAGE)
      const incomingSampleIds = new Set(samples.map((sample) => sample?.id).filter((id): id is string => typeof id === 'string'))
      await removeHandwritingSamples(previousSampleIds.filter((id) => !incomingSampleIds.has(id)))
      await putHandwritingLabels(labels)
      const storedSampleIds = await putHandwritingSamples(samples)
      const retainedSampleIds = previousSampleIds.filter((id) => incomingSampleIds.has(id))
      writeManagedIds(SAMPLE_IDS_KEY, [...retainedSampleIds, ...storedSampleIds])

      const previousLayoutIds = readManagedIds(LAYOUT_IDS_KEY, MAX_LAYOUTS_PER_MESSAGE)
      const storedLayoutIds = await replaceManagedMathLayoutExamples(layouts, previousLayoutIds)
      writeManagedIds(LAYOUT_IDS_KEY, storedLayoutIds)
      await finishSynchronization()
      return
    }

    if (message.type === 'glyphenwerk:samples-added') {
      const samples = records<Sample>(message.samples, MAX_SAMPLES_PER_MESSAGE, 'Das GlyphenWerk-Training')
      const storedIds = await putHandwritingSamples(samples)
      writeManagedIds(SAMPLE_IDS_KEY, [
        ...readManagedIds(SAMPLE_IDS_KEY, MAX_SAMPLES_PER_MESSAGE),
        ...storedIds,
      ])
      await finishSynchronization()
      return
    }

    if (message.type === 'glyphenwerk:samples-removed') {
      const requestedIds = stringIds(message.ids)
      const managedIds = readManagedIds(SAMPLE_IDS_KEY, MAX_SAMPLES_PER_MESSAGE)
      const requestedSet = new Set(requestedIds)
      const removableIds = managedIds.filter((id) => requestedSet.has(id))
      await removeHandwritingSamples(removableIds)
      writeManagedIds(SAMPLE_IDS_KEY, managedIds.filter((id) => !requestedSet.has(id)))
      await finishSynchronization()
      return
    }

    if (message.type === 'glyphenwerk:labels-added') {
      await putHandwritingLabels(records<LabelDefinition>(message.labels, MAX_LABELS_PER_MESSAGE, 'Die GlyphenWerk-Symbolklassen'))
      await finishSynchronization()
      return
    }

    if (message.type === 'glyphenwerk:layouts-replaced') {
      const layouts = records<MathLayoutExample>(message.layouts, MAX_LAYOUTS_PER_MESSAGE, 'Das GlyphenWerk-Layouttraining')
      const storedIds = await replaceManagedMathLayoutExamples(
        layouts,
        readManagedIds(LAYOUT_IDS_KEY, MAX_LAYOUTS_PER_MESSAGE),
      )
      writeManagedIds(LAYOUT_IDS_KEY, storedIds)
      await finishSynchronization()
    }
  }, [finishSynchronization])

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== iframeRef.current?.contentWindow || !event.data || typeof event.data !== 'object') return
      const message = event.data as GlyphenWerkMessage
      if (message.schemaVersion === 1 && message.type === 'glyphenwerk:ready') {
        sendNavigation(activeView)
        sendAppearance()
        return
      }
      if (message.schemaVersion === 1 && message.type === 'glyphenwerk:view-changed' && isGlyphenWerkView(message.view)) {
        onViewChange?.(message.view)
        if (Number.isSafeInteger(message.sampleCount) && Number(message.sampleCount) >= 0) {
          setSampleCount(Number(message.sampleCount))
        }
        return
      }
      if (message.schemaVersion === 1 && message.type === 'glyphenwerk:recognize-neural') {
        void recognizeTextRequest(message)
        return
      }
      synchronizationRef.current = synchronizationRef.current
        .then(() => synchronize(message))
        .catch((reason: unknown) => {
          setState('error')
          setError(reason instanceof Error ? reason.message : 'GlyphenWerk konnte nicht synchronisiert werden.')
        })
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [activeView, onViewChange, recognizeTextRequest, sendAppearance, sendNavigation, synchronize])

  return <section className="glyphenwerk-workspace" aria-label="GlyphenWerk Training und Test">
    <header className="glyphenwerk-workspace-header">
      <div className="glyphenwerk-workspace-title">
        <span><Database size={18} /></span>
        <div><strong>GlyphenWerk</strong><small>Training · Live-Test · Datensatz · Export</small></div>
      </div>
      <div className={`glyphenwerk-sync-state is-${state}`} role="status">
        {state === 'loading' || state === 'syncing'
          ? <LoaderCircle className="spin" size={14} />
          : <ShieldCheck size={14} />}
        <span>{state === 'loading'
          ? 'Wird lokal geladen …'
          : state === 'syncing'
            ? 'Training wird übernommen …'
            : state === 'error'
              ? error ?? 'Synchronisierung fehlgeschlagen'
              : `${sampleCount ?? 0} Beispiele direkt in FaNotes aktiv`}</span>
      </div>
      {onImportTraining && <>
        <button type="button" className="glyphenwerk-import" disabled={importBusy} onClick={() => importInputRef.current?.click()} title="GlyphenWerk-ZIP importieren">
          {importBusy ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}<span>ZIP importieren</span>
        </button>
        <input ref={importInputRef} type="file" accept=".zip,application/zip" hidden onChange={(event) => void importZip(event.target.files?.[0])} />
      </>}
      <button type="button" className="glyphenwerk-close" onClick={onClose} aria-label="GlyphenWerk schließen" title="GlyphenWerk schließen"><X size={17} /></button>
    </header>
    <iframe
      ref={iframeRef}
      className="glyphenwerk-frame"
      src={`./glyphenwerk/index.html?embedded=1&lang=${getUiLanguage()}`}
      title="GlyphenWerk – Handschrift trainieren und testen"
      sandbox="allow-scripts allow-same-origin allow-downloads allow-modals"
      allow="clipboard-write"
      onLoad={() => {
        setState((current) => current === 'error' ? current : 'syncing')
        sendNavigation(activeView)
        sendAppearance()
      }}
    />
  </section>
}
