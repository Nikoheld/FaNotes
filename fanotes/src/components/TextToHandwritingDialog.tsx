import { useModalFocus } from '../lib/useModalFocus'
import { CircleAlert, CircleCheck, Link2, PenLine, RefreshCw, Sparkles, Type, Unlink2, X, Maximize2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Sample } from '../../../src/types'
import type { PaperStyle } from '../types'
import { drawPaperBackground } from '../lib/paperStyles'
import { getUiLocale, uiText } from '../i18n'
import { fingerprint, type PersonalModel, type TrajectoryUnit } from '../lib/personalHandwriting.mjs'
import type { LearningState } from '../lib/personalHandwritingClient'
import * as legacyEngine from '../lib/textToHandwritingLegacy'
import { loadToolMemory, saveToolMemory } from '../lib/toolMemory'
import {
  createHandwritingSeed,
  synthesizeHandwriting,
  type HandwritingSynthesisResult,
  type SynthesizedInkStroke,
} from '../lib/textToHandwriting'

type TextToHandwritingDialogProps = {
  open: boolean
  samples: Sample[]
  /** False while the trained letters are still being read; the dialog is already open and says so. */
  samplesReady?: boolean
  pageWidth: number
  pageHeight: number
  suggestedStartY: number
  color: string
  baseWidth: number
  pressureEnabled: boolean
  paperStyle: PaperStyle
  squareMm?: number
  onClose: () => void
  onInsert: (strokes: SynthesizedInkStroke[], result: HandwritingSynthesisResult) => void
  onRequestTraining: () => void
}

type Placement = 'free-line' | 'page-start'

const MAX_TEXT = 8_000
const MAX_PREVIEW_ASPECT = 1.5

const previewPressureWidth = (stroke: SynthesizedInkStroke, pressure: number) => stroke.pressureEnabled
  ? stroke.baseWidth * (0.4 + Math.max(0.08, pressure) * 1.12)
  : stroke.baseWidth

const drawPreviewPaper = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  paperStyle: PaperStyle,
  squareMm = 0,
) => {
  drawPaperBackground(context, width, height, paperStyle, squareMm)
}

/** The part of the page worth showing: the text with a little air, or the top of the sheet while nothing is typed. */
const previewWindow = (result: HandwritingSynthesisResult, pageWidth: number, pageHeight: number) => {
  const bounds = result.bounds
  if (!bounds) return { top: 0, height: Math.min(pageHeight, Math.round(pageWidth * 0.55)) }
  const margin = Math.max(24, result.fontSizeUsed)
  const top = Math.max(0, Math.floor(bounds[1] - margin))
  const bottom = Math.min(pageHeight, Math.ceil(bounds[3] + margin))
  const minimum = Math.min(pageHeight - top, Math.round(pageWidth * 0.4))
  // A canvas as tall as a 13'000 px page would cost tens of MB; the preview shows its first stretch.
  return { top, height: Math.min(Math.max(minimum, bottom - top), Math.round(pageWidth * MAX_PREVIEW_ASPECT)) }
}

const HandwritingPreview = ({
  result,
  pageWidth,
  pageHeight,
  paperStyle,
  squareMm = 0,
}: {
  result: HandwritingSynthesisResult
  pageWidth: number
  pageHeight: number
  paperStyle: PaperStyle
  squareMm?: number
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const window_ = useMemo(() => previewWindow(result, pageWidth, pageHeight), [result, pageWidth, pageHeight])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    canvas.width = pageWidth
    canvas.height = window_.height
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, pageWidth, window_.height)
    context.translate(0, -window_.top)
    drawPreviewPaper(context, pageWidth, window_.top + window_.height, paperStyle, squareMm)
    context.lineCap = 'round'
    context.lineJoin = 'round'
    for (const stroke of result.strokes) {
      if (!stroke.points.length) continue
      context.strokeStyle = stroke.color
      context.fillStyle = stroke.color
      if (stroke.points.length === 1) {
        const point = stroke.points[0]
        context.beginPath()
        context.arc(point.x * pageWidth, point.y * pageHeight, previewPressureWidth(stroke, point.pressure) / 2, 0, Math.PI * 2)
        context.fill()
        continue
      }
      for (let index = 1; index < stroke.points.length; index += 1) {
        const previous = stroke.points[index - 1]
        const point = stroke.points[index]
        context.beginPath()
        context.moveTo(previous.x * pageWidth, previous.y * pageHeight)
        context.lineTo(point.x * pageWidth, point.y * pageHeight)
        context.lineWidth = previewPressureWidth(stroke, (previous.pressure + point.pressure) / 2)
        context.stroke()
      }
    }
  }, [pageHeight, pageWidth, paperStyle, result, squareMm, window_])

  return <canvas
    ref={canvasRef}
    className="tth-preview-canvas lw-tth-preview-canvas"
    style={{ aspectRatio: `${pageWidth} / ${window_.height}` }}
    role="img"
    aria-label="Vorschau der erzeugten Handschrift"
  />
}

const KNOWN_ALIASES: Record<string, string[]> = { '-': ['−', 'operator_minus'], "'": ['’', '‘', 'apostrophe'], '"': ['“', '”', '„', 'quote'] }
const UMLAUT_BASE: Record<string, string> = { ä: 'a', ö: 'o', ü: 'u', Ä: 'A', Ö: 'O', Ü: 'U' }

/** Which of the typed characters come from the trained letters, which fall back to the school script. */
const letterCoverage = (text: string, trained: Set<string>, missing: string[]) => {
  const personal: string[] = []
  const fallback: string[] = []
  const skipped = new Set(missing)
  for (const char of new Set([...text.normalize('NFC')])) {
    if (/\s/u.test(char) || skipped.has(char)) continue
    const known = trained.has(char) || (KNOWN_ALIASES[char] ?? []).some((alias) => trained.has(alias)) || (UMLAUT_BASE[char] !== undefined && trained.has(UMLAUT_BASE[char]))
    ;(known ? personal : fallback).push(char)
  }
  return { personal, fallback }
}

const formatList = (chars: string[], limit = 14) => chars.slice(0, limit)

export function TextToHandwritingDialog({
  open,
  samples,
  samplesReady = true,
  pageWidth,
  pageHeight,
  suggestedStartY,
  color,
  baseWidth,
  pressureEnabled,
  paperStyle,
  squareMm = 0,
  onClose,
  onInsert,
  onRequestTraining,
}: TextToHandwritingDialogProps) {
  const [initialHandwriting] = useState(() => loadToolMemory().handwriting)
  const [text, setText] = useState('')
  const [fontSize, setFontSize] = useState(initialHandwriting.fontSize)
  const [lineSpacing, setLineSpacing] = useState(initialHandwriting.lineSpacing)
  const [variation, setVariation] = useState(initialHandwriting.variation)
  const [connectLetters, setConnectLetters] = useState(initialHandwriting.connectLetters)
  const [fitToPage, setFitToPage] = useState(initialHandwriting.fitToPage)
  const [placement, setPlacement] = useState<Placement>(initialHandwriting.placement)

  useEffect(() => {
    saveToolMemory({
      handwriting: { fontSize, lineSpacing, variation, connectLetters, fitToPage, placement },
    })
  }, [connectLetters, fitToPage, fontSize, lineSpacing, placement, variation])
  const isDesktop = ['linux', 'win32'].includes(window.fanotes?.platform ?? '')
  const [learning, setLearning] = useState<LearningState | null>(null)
  const learningRef = useRef<LearningState | null>(null)
  useEffect(() => { learningRef.current = learning }, [learning])
  const cachedWorkerData = useRef<{ model?: PersonalModel; samples: Sample[]; units: TrajectoryUnit[] } | null>(null)
  const [preview, setPreview] = useState<HandwritingSynthesisResult | null>(null)
  const [generating, setGenerating] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [requestedUnits, setRequestedUnits] = useState<TrajectoryUnit[]>([])
  const [lookupPending, setLookupPending] = useState(false)
  const [learningError, setLearningError] = useState('')
  const [completedInput, setCompletedInput] = useState<unknown>(null)
  const workerRef = useRef<Worker | null>(null)
  const requestRef = useRef(0)
  const trajectorySamples = useMemo(() => samples.map(sample => ({ ...sample, imageData: '' })), [samples])
  const templateKey = useRef<string | null>(null)
  useEffect(() => {
    if (!isDesktop || !open || !text.trim()) { setRequestedUnits([]); setLookupPending(false); return }
    let cancelled = false
    setLookupPending(true)
    const timer = window.setTimeout(() => {
      const lookup = window.fanotes.handwritingLearning?.('retrieve', { text: text.slice(0, MAX_TEXT) }) ?? Promise.resolve(null)
      void lookup.then(result => {
        if (!cancelled) { setRequestedUnits(result?.requestedUnits ?? []); setLookupPending(false) }
      }).catch(() => { if (!cancelled) { setRequestedUnits([]); setLookupPending(false) } })
    }, 200)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [isDesktop, open, text, learning?.model.revision, learning?.vaultId])
  useEffect(() => {
    if (!isDesktop || !open) return
    let cancelled = false
    const refresh = async () => {
      try {
        const next = await window.fanotes.handwritingLearning?.('snapshot', { revision: learningRef.current?.model.revision, vaultId: learningRef.current?.vaultId })
        if (!cancelled && next) { setLearningError(''); setLearning(old => {
          const model = next.model ?? (old?.vaultId === next.vaultId ? old?.model : null)
          if (!model) return old
          return old && old.vaultId === next.vaultId && old.model.revision === model.revision && old.busy === next.busy && old.enabled === next.enabled && old.error === next.error ? old : { ...next, model }
        }) }
      } catch { if (!cancelled) setLearningError('Das automatische Lernen ist gerade nicht verfügbar. Deine Buchstaben bleiben nutzbar.') }
    }
    void refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [isDesktop, open])
  useEffect(() => {
    if (!isDesktop || !open) return
    const key = fingerprint(trajectorySamples.map(s => ({ id: s.id, label: s.label, strokes: s.strokes })))
    if (key === templateKey.current) return
    templateKey.current = key
    void window.fanotes.handwritingLearning?.('templates', trajectorySamples).catch(() => {})
  }, [isDesktop, open, trajectorySamples])
  useEffect(() => {
    if (!isDesktop || !open) return
    const worker = new Worker(new URL('../lib/handwritingSynthesisWorker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    cachedWorkerData.current = null
    return () => { worker.terminate(); workerRef.current = null }
  }, [isDesktop, open])
  const [seed, setSeed] = useState(createHandwritingSeed)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  // Focus goes into the dialog when it opens and back to the toolbar button when it closes. The hook has to
  // follow `open`: the dialog element only exists while it is open.
  useModalFocus(dialogRef, { active: open, onEscape: onClose })

  const insertClipboardText = (incoming: string, field: HTMLTextAreaElement) => {
    const start = field.selectionStart ?? text.length
    const end = field.selectionEnd ?? text.length
    const next = `${text.slice(0, start)}${incoming}${text.slice(end)}`.slice(0, MAX_TEXT)
    setText(next)
    const cursor = Math.min(MAX_TEXT, start + incoming.length)
    requestAnimationFrame(() => {
      try { field.setSelectionRange(cursor, cursor) } catch { /* ignore */ }
    })
  }

  const options = useMemo(() => ({
    fontSize,
    lineSpacing,
    variation,
    connectLetters,
    color,
    baseWidth,
    pressureEnabled,
    seed,
    startY: placement === 'free-line' ? suggestedStartY : undefined,
    model: learning?.model,
    desktopQuality: isDesktop,
  }), [baseWidth, color, connectLetters, fontSize, lineSpacing, isDesktop, learning?.model, placement, pressureEnabled, seed, suggestedStartY, variation])

  const generationInput = useMemo(() => ({ text, requestedUnits, samples: isDesktop ? trajectorySamples : samples, options, fit: fitToPage, page: { width: pageWidth, height: pageHeight } }), [text, requestedUnits, isDesktop, trajectorySamples, samples, options, fitToPage, pageWidth, pageHeight])
  const legacyResult = useMemo(() => {
    if (isDesktop || !open) return null
    return (fitToPage ? legacyEngine.synthesizeHandwritingToFit : legacyEngine.synthesizeHandwriting)(text, samples, options, { width: pageWidth, height: pageHeight })
  }, [isDesktop, open, fitToPage, options, pageHeight, pageWidth, samples, text])
  useEffect(() => {
    const worker = workerRef.current
    if (!isDesktop || !open || !worker || lookupPending || !samplesReady) return
    const id = ++requestRef.current
    setGenerating(true)
    const timer = window.setTimeout(() => {
      worker.onmessage = ({ data }) => {
        if (data.id !== requestRef.current) return
        setGenerating(false)
        if (data.result) { setPreview(data.result); setCompletedInput(generationInput); setPreviewError('') }
        else setPreviewError('Die Vorschau konnte nicht erstellt werden.')
      }
      worker.onerror = () => { setGenerating(false); setPreviewError('Die Vorschau konnte nicht erstellt werden.') }
      const { model, ...lightOptions } = generationInput.options
      const cached = cachedWorkerData.current
      if (!cached || cached.model !== model || cached.samples !== generationInput.samples || cached.units !== requestedUnits) {
        worker.postMessage({ op: 'model', model, samples: generationInput.samples, units: requestedUnits })
        cachedWorkerData.current = { model, samples: generationInput.samples, units: requestedUnits }
      }
      worker.postMessage({ op: 'synthesize', id, text, options: lightOptions, fit: fitToPage, page: generationInput.page })
    }, 100)
    return () => window.clearTimeout(timer)
  }, [isDesktop, open, lookupPending, generationInput, samplesReady])
  const empty = useMemo(() => synthesizeHandwriting('', [], { ...options, model: undefined }, { width: pageWidth, height: pageHeight }), [options, pageWidth, pageHeight])
  const result = isDesktop ? preview ?? empty : legacyResult ?? empty
  const trained = useMemo(() => new Set(samples.map((sample) => sample.label)), [samples])
  const trainedLetters = useMemo(() => [...trained].filter((label) => /\p{L}/u.test(label)).length, [trained])
  const coverage = useMemo(() => letterCoverage(text, trained, result.missingCharacters), [result.missingCharacters, text, trained])

  if (!open) return null

  const hasText = text.trim().length > 0
  const skipped = result.missingCharacters
  const busy = hasText && (generating || lookupPending)
  const ready = samplesReady && (!isDesktop || completedInput === generationInput)
  const canInsert = hasText && result.strokes.length > 0 && !result.overflow && !busy && !previewError && ready
  const previewWidth = result.pageWidth || pageWidth
  const previewHeight = result.pageHeight || pageHeight
  const lines = hasText ? result.lineCount : 0
  const insert = () => {
    if (!canInsert) return
    onInsert(result.strokes, result)
    // The text is spent: reopening the dialog starts empty instead of inviting a second, identical insert.
    setText('')
    setSeed(createHandwritingSeed())
  }
  // Keys typed in the dialog stay in the dialog: the app closes the whole handwriting page on Escape and the
  // board has single-letter tool shortcuts. The portal sits under <body>, so stopping the event here also keeps
  // it from the window-level handlers.
  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      insert()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((element) => element.getClientRects().length > 0)
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  const status = !hasText
    ? uiText('Schreibe oder füge einen Text ein.', 'Type or paste some text.')
    : busy
      ? uiText('Vorschau wird erstellt …', 'Preparing the preview …')
      : previewError
        ? previewError
        : result.overflow
          ? uiText('Der Text passt nicht auf diese Seite.', 'The text does not fit on this page.')
          : !result.strokes.length
            ? uiText('Kein Zeichen davon lässt sich schreiben.', 'None of these characters can be written.')
            : ''

  return createPortal(<div
    className="modal-backdrop confirm-backdrop tth-backdrop lw-tth-backdrop"
    role="presentation"
    data-fanotes-drawing-chrome="text-to-handwriting"
    onPointerDown={(event) => {
      event.stopPropagation()
      if (event.target === event.currentTarget) onClose()
    }}
    onPointerMove={(event) => event.stopPropagation()}
    onPointerUp={(event) => event.stopPropagation()}
    onPaste={(event) => event.stopPropagation()}
  >
    <section
      ref={dialogRef}
      className="confirm-dialog tth-dialog lw-tth-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lw-tth-title"
      aria-busy={busy}
      onKeyDown={onDialogKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="confirm-dialog-header">
        <span className="confirm-dialog-icon" aria-hidden="true"><Type size={18} /></span>
        <div>
          <p className="eyebrow">Handschrift</p>
          <h3 id="lw-tth-title">Text in deine Handschrift</h3>
        </div>
        <button type="button" className="icon-button tth-dialog__close" aria-label="Dialog schließen" onClick={onClose}><X size={16} /></button>
      </header>

      <div className="tth-dialog__body">
        <div className="tth-dialog__controls">
          <label className="tth-field">
            <span className="tth-field__label">Text</span>
            <textarea
              ref={textRef}
              data-tth-control="text"
              data-autofocus
              value={text}
              rows={6}
              maxLength={MAX_TEXT}
              spellCheck
              placeholder="Schreibe oder füge hier deinen Text ein …"
              onChange={(event) => setText(event.target.value)}
              onPaste={(event) => {
                const incoming = event.clipboardData?.getData('text')
                if (incoming == null) return
                event.preventDefault()
                event.stopPropagation()
                insertClipboardText(incoming, event.currentTarget)
              }}
            />
            <small className="tth-field__count" data-i18n-ignore>
              {uiText(`${text.length.toLocaleString(getUiLocale())} von ${MAX_TEXT.toLocaleString(getUiLocale())} Zeichen`, `${text.length.toLocaleString(getUiLocale())} of ${MAX_TEXT.toLocaleString(getUiLocale())} characters`)}
            </small>
          </label>

          <fieldset className="tth-group">
            <legend>Schrift</legend>
            <label className="tth-slider">
              <span>Schriftgröße</span>
              <output data-tth-output="font-size">{fontSize} px</output>
              <input type="range" data-tth-control="font-size" min="20" max="72" step="1" value={fontSize} onChange={(event) => setFontSize(Number(event.currentTarget.value))} />
            </label>
            <label className="tth-slider">
              <span>Zeilenabstand</span>
              <output data-tth-output="line-spacing">{lineSpacing.toFixed(2)}×</output>
              <input type="range" data-tth-control="line-spacing" min="1.05" max="2" step="0.01" value={lineSpacing} onChange={(event) => setLineSpacing(Number(event.currentTarget.value))} />
            </label>
            <label className="tth-slider">
              <span>Natürliche Variation</span>
              <output data-tth-output="variation">{Math.round(variation * 100)}%</output>
              <input type="range" data-tth-control="variation" min="0" max="1" step="0.01" value={variation} onChange={(event) => setVariation(Number(event.currentTarget.value))} />
            </label>
          </fieldset>

          <fieldset className="tth-group">
            <legend>Stil</legend>
            <div className="tth-choices">
              <button type="button" className={connectLetters ? 'is-active' : ''} aria-pressed={connectLetters} onClick={() => setConnectLetters((current) => !current)}>
                {connectLetters ? <Link2 size={15} /> : <Unlink2 size={15} />}
                Buchstaben verbinden
              </button>
              <button type="button" className={fitToPage ? 'is-active' : ''} aria-pressed={fitToPage} onClick={() => setFitToPage((current) => !current)}>
                <Maximize2 size={15} /> An Seite anpassen
              </button>
            </div>
          </fieldset>

          <fieldset className="tth-group">
            <legend>Einfügen</legend>
            <div className="tth-choices" role="radiogroup" aria-label="Einfügeposition">
              <button type="button" role="radio" aria-checked={placement === 'free-line'} className={placement === 'free-line' ? 'is-active' : ''} onClick={() => setPlacement('free-line')}>Nach der letzten Handschrift</button>
              <button type="button" role="radio" aria-checked={placement === 'page-start'} className={placement === 'page-start' ? 'is-active' : ''} onClick={() => setPlacement('page-start')}>Am Seitenanfang</button>
            </div>
          </fieldset>
        </div>

        <aside className="tth-dialog__preview" aria-label="Vorschau">
          <div
            className="tth-preview-head"
            data-tth-preview-options={JSON.stringify({
              fontSize,
              lineSpacing,
              variation,
              fontSizeUsed: result.fontSizeUsed,
              glyphCount: result.glyphCount,
              pageHeight: result.pageHeight,
            })}
          >
            <div>
              <strong>Live-Vorschau</strong>
              <small data-i18n-ignore>{uiText(
                `${result.glyphCount} Zeichen · ${lines} ${lines === 1 ? 'Zeile' : 'Zeilen'}`,
                `${result.glyphCount} characters · ${lines} ${lines === 1 ? 'line' : 'lines'}`,
              )}</small>
            </div>
            <button type="button" className="secondary-button" onClick={() => setSeed(createHandwritingSeed())} disabled={!hasText} title="Alle Zeichen mit neuen natürlichen Abweichungen erzeugen">
              <RefreshCw size={14} /> Neu variieren
            </button>
          </div>
          <div className={`tth-paper${busy ? ' is-busy' : ''}`}>
            <HandwritingPreview result={result} pageWidth={previewWidth} pageHeight={previewHeight} paperStyle={paperStyle} squareMm={squareMm} />
            {!hasText && <div className="tth-paper__empty"><PenLine size={24} /><span>Deine Vorschau erscheint hier</span></div>}
          </div>
          {fitToPage && hasText && result.fontSizeUsed < fontSize && <p className="tth-note" data-i18n-ignore>{uiText(`Für den verfügbaren Platz automatisch auf ${result.fontSizeUsed} px angepasst.`, `Automatically reduced to ${result.fontSizeUsed} px to fit the available space.`)}</p>}

          <div className="tth-letters" role="status" data-tth-letters={!samplesReady ? 'loading' : trainedLetters ? 'trained' : 'none'}>
            {!samplesReady ? (
              <div className="tth-card is-loading" aria-busy="true">
                <RefreshCw size={16} aria-hidden="true" />
                <div>
                  <strong data-i18n-ignore>{uiText('Deine Buchstaben werden geladen …', 'Loading your letters …')}</strong>
                  <span data-i18n-ignore>{uiText('Du kannst schon tippen, die Vorschau erscheint gleich in deiner Schrift.', 'You can already type; the preview appears in your handwriting in a moment.')}</span>
                </div>
              </div>
            ) : !trainedLetters ? (
              <div className="tth-card is-empty">
                <CircleAlert size={16} aria-hidden="true" />
                <div>
                  <strong>Noch keine Buchstaben trainiert</strong>
                  <span data-i18n-ignore>{isDesktop
                    ? uiText('Bis dahin schreibt FaNotes in Schulschrift und mit dem, was es aus deinen Notizen lernt. Trainiere deine Buchstaben im GlyphenWerk, damit es wie deine Handschrift aussieht.', 'Until then FaNotes writes in school script and with what it learns from your notes. Train your letters in GlyphenWerk to make it look like your handwriting.')
                    : uiText('Bis dahin schreibt FaNotes in Schulschrift. Trainiere deine Buchstaben im GlyphenWerk, damit es wie deine Handschrift aussieht.', 'Until then FaNotes writes in school script. Train your letters in GlyphenWerk to make it look like your handwriting.')}</span>
                </div>
                <button type="button" className="secondary-button" onClick={onRequestTraining}>Buchstaben trainieren</button>
              </div>
            ) : hasText && coverage.fallback.length > 0 ? (
              <div className="tth-card is-warning">
                <CircleAlert size={16} aria-hidden="true" />
                <div>
                  <strong data-i18n-ignore>{uiText(`${coverage.personal.length} von ${coverage.personal.length + coverage.fallback.length} Zeichen aus deiner Schrift`, `${coverage.personal.length} of ${coverage.personal.length + coverage.fallback.length} characters from your handwriting`)}</strong>
                  <span>Diese Zeichen fehlen im Training und erscheinen in Schulschrift:</span>
                  <span className="tth-chips" data-tth-fallback>{formatList(coverage.fallback).map((char) => <kbd key={char}>{char}</kbd>)}{coverage.fallback.length > 14 && <kbd>…</kbd>}</span>
                </div>
                <button type="button" className="secondary-button" onClick={onRequestTraining}>Buchstaben trainieren</button>
              </div>
            ) : (
              <div className="tth-card is-ok">
                <CircleCheck size={16} aria-hidden="true" />
                <div>
                  <strong>{hasText ? 'Alle Zeichen stammen aus deiner Schrift' : 'Deine Buchstaben sind bereit'}</strong>
                  <span data-i18n-ignore>{uiText(`${trainedLetters} trainierte Buchstaben`, `${trainedLetters} trained letters`)}</span>
                </div>
                <button type="button" className="secondary-button" onClick={onRequestTraining}>Training öffnen</button>
              </div>
            )}
            {skipped.length > 0 && hasText && <div className="tth-card is-warning" data-tth-skipped>
              <CircleAlert size={16} aria-hidden="true" />
              <div>
                <strong>Nicht schreibbare Zeichen</strong>
                <span>Diese Zeichen gibt es in keiner Schrift und bleiben als Lücke stehen:</span>
                <span className="tth-chips">{skipped.slice(0, 14).map((char) => <kbd key={char}>{char === ' ' ? '␣' : char}</kbd>)}</span>
              </div>
            </div>}
            {result.overflow && hasText && <div className="tth-card is-error" role="alert">
              <CircleAlert size={16} aria-hidden="true" />
              <div>
                <strong>Der Text passt nicht auf diese Seite</strong>
                <span data-i18n-ignore>{uiText(`${result.overflowCharacters} Zeichen haben keinen Platz. Wähle den Seitenanfang, verkleinere die Schrift oder kürze den Text.`, `${result.overflowCharacters} characters do not fit. Choose the top of the page, make the writing smaller or shorten the text.`)}</span>
              </div>
            </div>}
            {(learningError || (previewError && hasText)) && <p className="tth-note is-error" role="alert">{learningError || previewError}</p>}
            {isDesktop && learning && <label className="tth-learn">
              <input type="checkbox" checked={learning.enabled} onChange={event => {
                void window.fanotes.handwritingLearning?.('enabled', event.target.checked).then(next => { if (next?.model) setLearning({ ...next, model: next.model }) }).catch(() => setLearningError('Die Einstellung konnte nicht gespeichert werden.'))
              }} />
              <span>
                <b>Automatisch aus Notizen lernen</b>
                <small data-i18n-ignore>{learning.busy ? uiText('Lernt gerade aus deinen Notizen …', 'Learning from your notes …') : learning.observationCount ? uiText(`${learning.pageCount} Handschriftseiten ausgewertet, nur auf diesem Gerät.`, `${learning.pageCount} handwritten pages analysed, on this device only.`) : uiText('Schreibe wie gewohnt; FaNotes lernt lokal auf diesem Gerät.', 'Write as usual; FaNotes learns locally on this device.')}</small>
              </span>
            </label>}
          </div>
        </aside>
      </div>

      <footer className="confirm-dialog-actions tth-dialog__actions">
        <p className="tth-dialog__hint" role="status" data-i18n-ignore>{status || <><Sparkles size={13} aria-hidden="true" /> {uiText('Strg+Eingabe fügt ein', 'Ctrl+Enter inserts')}</>}</p>
        <button type="button" className="secondary-button" onClick={onClose}>Abbrechen</button>
        <button type="button" className="primary-button lw-tth-insert" disabled={!canInsert} onClick={insert}>
          <PenLine size={15} /> Als Handschrift einfügen
        </button>
      </footer>
    </section>
  </div>, document.body)
}
