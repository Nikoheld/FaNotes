import { CircleAlert, Link2, PenLine, RefreshCw, Sparkles, Type, Unlink2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Sample } from '../../../src/types'
import type { PaperStyle } from '../types'
import { getUiLocale } from '../i18n'
import {
  createHandwritingSeed,
  synthesizeHandwriting,
  synthesizeHandwritingToFit,
  type HandwritingSynthesisResult,
  type SynthesizedInkStroke,
} from '../lib/textToHandwriting'

type TextToHandwritingDialogProps = {
  open: boolean
  samples: Sample[]
  pageWidth: number
  pageHeight: number
  suggestedStartY: number
  color: string
  baseWidth: number
  pressureEnabled: boolean
  paperStyle: PaperStyle
  onClose: () => void
  onInsert: (strokes: SynthesizedInkStroke[], result: HandwritingSynthesisResult) => void
  onRequestTraining: () => void
}

type Placement = 'free-line' | 'page-start'

const previewPressureWidth = (stroke: SynthesizedInkStroke, pressure: number) => stroke.pressureEnabled
  ? stroke.baseWidth * (0.4 + Math.max(0.08, pressure) * 1.12)
  : stroke.baseWidth

const drawPreviewPaper = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  paperStyle: PaperStyle,
) => {
  context.fillStyle = '#fbfcff'
  context.fillRect(0, 0, width, height)
  context.strokeStyle = 'rgba(92,107,142,.15)'
  context.fillStyle = 'rgba(92,107,142,.27)'
  context.lineWidth = 0.8
  const step = 32
  if (paperStyle === 'dots') {
    for (let y = step; y < height; y += step) {
      for (let x = step; x < width; x += step) {
        context.beginPath()
        context.arc(x, y, 1.05, 0, Math.PI * 2)
        context.fill()
      }
    }
  } else if (paperStyle === 'grid') {
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
  } else if (paperStyle === 'lines') {
    context.beginPath()
    for (let y = step; y < height; y += step) {
      context.moveTo(0, y)
      context.lineTo(width, y)
    }
    context.stroke()
  }
}

const HandwritingPreview = ({
  result,
  pageWidth,
  pageHeight,
  paperStyle,
}: {
  result: HandwritingSynthesisResult
  pageWidth: number
  pageHeight: number
  paperStyle: PaperStyle
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    canvas.width = pageWidth
    canvas.height = pageHeight
    context.clearRect(0, 0, pageWidth, pageHeight)
    drawPreviewPaper(context, pageWidth, pageHeight, paperStyle)
    context.lineCap = 'round'
    context.lineJoin = 'round'
    for (const stroke of result.strokes) {
      if (!stroke.points.length) continue
      context.strokeStyle = stroke.color
      context.fillStyle = stroke.color
      if (stroke.points.length === 1) {
        const point = stroke.points[0]
        context.beginPath()
        context.arc(
          point.x * pageWidth,
          point.y * pageHeight,
          previewPressureWidth(stroke, point.pressure) / 2,
          0,
          Math.PI * 2,
        )
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
  }, [pageHeight, pageWidth, paperStyle, result])

  return <canvas ref={canvasRef} className="lw-tth-preview-canvas" aria-label="Vorschau der erzeugten Handschrift" />
}

export function TextToHandwritingDialog({
  open,
  samples,
  pageWidth,
  pageHeight,
  suggestedStartY,
  color,
  baseWidth,
  pressureEnabled,
  paperStyle,
  onClose,
  onInsert,
  onRequestTraining,
}: TextToHandwritingDialogProps) {
  const [text, setText] = useState('')
  const [fontSize, setFontSize] = useState(42)
  const [lineSpacing, setLineSpacing] = useState(1.42)
  const [variation, setVariation] = useState(0.62)
  const [connectLetters, setConnectLetters] = useState(true)
  const [fitToPage, setFitToPage] = useState(true)
  const [placement, setPlacement] = useState<Placement>('free-line')
  const [seed, setSeed] = useState(createHandwritingSeed)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    const timeout = window.setTimeout(() => textRef.current?.focus(), 40)
    return () => {
      window.clearTimeout(timeout)
    }
  }, [open])

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((element) => !element.hidden && element.getClientRects().length > 0)
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
  }), [baseWidth, color, connectLetters, fontSize, lineSpacing, placement, pressureEnabled, seed, suggestedStartY, variation])

  const result = useMemo(() => {
    if (!text.trim() || !samples.length) {
      return synthesizeHandwriting('', samples, options, { width: pageWidth, height: pageHeight })
    }
    return fitToPage
      ? synthesizeHandwritingToFit(text, samples, options, { width: pageWidth, height: pageHeight })
      : synthesizeHandwriting(text, samples, options, { width: pageWidth, height: pageHeight })
  }, [fitToPage, options, pageHeight, pageWidth, samples, text])

  if (!open) return null

  const unavailable = result.missingCharacters.length > 0
  const canInsert = result.strokes.length > 0 && !unavailable && !result.overflow

  return <div className="lw-tth-backdrop" role="presentation" onPointerDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <style>{textToHandwritingStyles}</style>
    <section ref={dialogRef} className="lw-tth-dialog" role="dialog" aria-modal="true" aria-labelledby="lw-tth-title" onKeyDown={handleDialogKeyDown}>
      <header className="lw-tth-head">
        <span className="lw-tth-symbol"><Type size={20} /></span>
        <div>
          <h2 id="lw-tth-title">Text in deine Handschrift</h2>
          <p>FaNotes setzt jedes Zeichen neu aus deinen eigenen GlyphenWerk-Strichen zusammen.</p>
        </div>
        <button type="button" className="lw-tth-icon" aria-label="Dialog schließen" onClick={onClose}><X size={19} /></button>
      </header>

      <div className="lw-tth-body">
        <div className="lw-tth-controls">
          <label className="lw-tth-text-field">
            <span>Text</span>
            <textarea
              ref={textRef}
              value={text}
              rows={8}
              maxLength={8_000}
              spellCheck
              placeholder="Schreibe oder füge hier deinen Text ein …"
              onChange={(event) => setText(event.target.value)}
            />
            <small>{text.length.toLocaleString(getUiLocale())} / 8'000 Zeichen</small>
          </label>

          <div className="lw-tth-option-grid">
            <label>
              <span>Schriftgröße <output>{fontSize} px</output></span>
              <input type="range" min="20" max="72" step="1" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} />
            </label>
            <label>
              <span>Zeilenabstand <output>{lineSpacing.toFixed(2)}×</output></span>
              <input type="range" min="1.05" max="2" step="0.01" value={lineSpacing} onChange={(event) => setLineSpacing(Number(event.target.value))} />
            </label>
            <label>
              <span>Natürliche Variation <output>{Math.round(variation * 100)}%</output></span>
              <input type="range" min="0" max="1" step="0.01" value={variation} onChange={(event) => setVariation(Number(event.target.value))} />
            </label>
          </div>

          <div className="lw-tth-choice-row">
            <button type="button" className={connectLetters ? 'is-active' : ''} aria-pressed={connectLetters} onClick={() => setConnectLetters((current) => !current)}>
              {connectLetters ? <Link2 size={16} /> : <Unlink2 size={16} />}
              Buchstaben verbinden
            </button>
            <button type="button" className={fitToPage ? 'is-active' : ''} aria-pressed={fitToPage} onClick={() => setFitToPage((current) => !current)}>
              <Sparkles size={16} /> An Seite anpassen
            </button>
          </div>

          <label className="lw-tth-select">
            <span>Einfügeposition</span>
            <select value={placement} onChange={(event) => setPlacement(event.target.value as Placement)}>
              <option value="free-line">Nach der letzten Handschrift</option>
              <option value="page-start">Am Seitenanfang</option>
            </select>
          </label>

          {!samples.length && <div className="lw-tth-message is-warning">
            <CircleAlert size={18} />
            <div><strong>Deine Schrift fehlt noch</strong><span>Importiere dein GlyphenWerk-Training. Nur so entsteht wirklich deine persönliche Handschrift.</span></div>
            <button type="button" onClick={onRequestTraining}>GlyphenWerk öffnen</button>
          </div>}
          {unavailable && <div className="lw-tth-message is-warning">
            <CircleAlert size={18} />
            <div><strong>Noch nicht trainierte Zeichen</strong><span>{result.missingCharacters.map((char) => char === ' ' ? 'Leerzeichen' : char).join(' · ')}</span></div>
          </div>}
          {result.overflow && <div className="lw-tth-message is-error">
            <CircleAlert size={18} />
            <div><strong>Der Text passt nicht auf diese Seite</strong><span>{result.overflowCharacters} Zeichen haben keinen Platz. Wähle den Seitenanfang, verkleinere die Schrift oder kürze den Text.</span></div>
          </div>}
        </div>

        <aside className="lw-tth-preview">
          <div className="lw-tth-preview-head">
            <div><strong>Live-Vorschau</strong><small>{result.glyphCount} Zeichen · {result.lineCount} Zeilen · {result.connectionCount} Verbindungen</small></div>
            <button type="button" onClick={() => setSeed(createHandwritingSeed())} disabled={!text.trim()} title="Alle Zeichen mit neuen natürlichen Abweichungen erzeugen">
              <RefreshCw size={15} /> Neu variieren
            </button>
          </div>
          <div className="lw-tth-paper-wrap">
            <HandwritingPreview result={result} pageWidth={pageWidth} pageHeight={pageHeight} paperStyle={paperStyle} />
            {!text.trim() && <div className="lw-tth-preview-empty"><PenLine size={27} /><span>Deine Vorschau erscheint hier</span></div>}
          </div>
          {fitToPage && result.fontSizeUsed < fontSize && <p className="lw-tth-fit-note">Für den verfügbaren Platz automatisch auf {result.fontSizeUsed} px angepasst.</p>}
        </aside>
      </div>

      <footer className="lw-tth-footer">
        <p><Sparkles size={14} /> Jede Erzeugung variiert Form, Neigung, Grundlinie, Druck und Strichbreite behutsam.</p>
        <div>
          <button type="button" className="lw-tth-cancel" onClick={onClose}>Abbrechen</button>
          <button type="button" className="lw-tth-insert" disabled={!canInsert} onClick={() => onInsert(result.strokes, result)}>
            <PenLine size={17} /> Als Handschrift einfügen
          </button>
        </div>
      </footer>
    </section>
  </div>
}

const textToHandwritingStyles = `
.lw-tth-backdrop{position:fixed;z-index:1000;inset:0;display:grid;place-items:center;padding:24px;background:rgba(8,9,16,.67);backdrop-filter:blur(9px);pointer-events:auto;animation:lw-tth-fade .16s ease-out}.lw-tth-dialog{display:flex;width:min(1080px,calc(100vw - 34px));max-height:min(820px,calc(100vh - 34px));flex-direction:column;overflow:hidden;border:1px solid var(--border-strong,rgba(255,255,255,.17));border-radius:22px;color:var(--text,#ededf3);background:color-mix(in srgb,var(--background,#111116) 94%,var(--accent,#7654d6) 6%);box-shadow:0 34px 120px rgba(0,0,0,.48);font:500 13px/1.45 var(--ui-font,Inter,system-ui,sans-serif);animation:lw-tth-rise .2s cubic-bezier(.2,.75,.25,1)}.lw-tth-dialog *{box-sizing:border-box}.lw-tth-dialog button,.lw-tth-dialog input,.lw-tth-dialog select,.lw-tth-dialog textarea{font:inherit}.lw-tth-head{display:flex;align-items:center;gap:12px;padding:18px 20px;border-bottom:1px solid var(--border,rgba(255,255,255,.1));background:color-mix(in srgb,var(--background-secondary,#18181f) 88%,transparent)}.lw-tth-symbol{display:grid;width:42px;height:42px;flex:0 0 auto;place-items:center;border-radius:13px;color:var(--on-accent,#11131a);background:linear-gradient(145deg,var(--accent,#7654d6),color-mix(in srgb,var(--accent,#7654d6) 65%,#fff));box-shadow:0 10px 28px color-mix(in srgb,var(--accent,#7654d6) 30%,transparent)}.lw-tth-head>div{min-width:0;flex:1}.lw-tth-head h2{margin:0;font-size:18px;line-height:1.3}.lw-tth-head p{margin:3px 0 0;color:var(--text-muted,#9898a8);font-size:12px}.lw-tth-icon{display:grid;width:34px;height:34px;place-items:center;border:0;border-radius:9px;color:inherit;background:transparent;cursor:pointer}.lw-tth-icon:hover{background:color-mix(in srgb,var(--text,#fff) 8%,transparent)}
.lw-tth-body{display:grid;grid-template-columns:minmax(360px,1fr) minmax(330px,440px);min-height:0;overflow:auto}.lw-tth-controls{display:flex;min-width:0;flex-direction:column;gap:15px;padding:20px}.lw-tth-text-field{display:grid;gap:7px}.lw-tth-text-field>span,.lw-tth-select>span{font-weight:750}.lw-tth-text-field textarea{width:100%;min-height:154px;resize:vertical;padding:12px 13px;border:1px solid var(--border-strong,rgba(255,255,255,.16));border-radius:12px;outline:none;color:var(--text,#fff);background:var(--background-secondary,#191920);line-height:1.55}.lw-tth-text-field textarea:focus{border-color:var(--accent,#7654d6);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent,#7654d6) 18%,transparent)}.lw-tth-text-field small{justify-self:end;color:var(--text-muted,#999);font-size:10px}.lw-tth-option-grid{display:grid;gap:12px;padding:13px;border:1px solid var(--border,rgba(255,255,255,.1));border-radius:13px;background:color-mix(in srgb,var(--background-secondary,#191920) 70%,transparent)}.lw-tth-option-grid label{display:grid;grid-template-columns:1fr minmax(110px,42%);align-items:center;gap:12px}.lw-tth-option-grid label>span{display:flex;justify-content:space-between;gap:10px;color:var(--text-muted,#aaa);font-size:11px}.lw-tth-option-grid output{color:var(--text,#fff);font-variant-numeric:tabular-nums}.lw-tth-option-grid input{width:100%;accent-color:var(--accent,#7654d6)}.lw-tth-choice-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.lw-tth-choice-row button{display:flex;min-height:38px;align-items:center;justify-content:center;gap:7px;border:1px solid var(--border,rgba(255,255,255,.11));border-radius:10px;color:var(--text-muted,#aaa);background:var(--background-secondary,#191920);cursor:pointer}.lw-tth-choice-row button.is-active{border-color:color-mix(in srgb,var(--accent,#7654d6) 55%,transparent);color:var(--text,#fff);background:color-mix(in srgb,var(--accent,#7654d6) 20%,var(--background-secondary,#191920))}.lw-tth-select{display:grid;grid-template-columns:auto 1fr;align-items:center;gap:12px}.lw-tth-select select{height:38px;padding:0 11px;border:1px solid var(--border-strong,rgba(255,255,255,.16));border-radius:10px;outline:none;color:var(--text,#fff);background:var(--background-secondary,#191920)}
.lw-tth-message{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;padding:11px 12px;border:1px solid;border-radius:11px}.lw-tth-message>div{display:flex;min-width:0;flex-direction:column}.lw-tth-message strong{font-size:11px}.lw-tth-message span{overflow-wrap:anywhere;font-size:10px;opacity:.84}.lw-tth-message button{padding:6px 9px;border:0;border-radius:7px;color:inherit;background:rgba(255,255,255,.09);cursor:pointer}.lw-tth-message.is-warning{border-color:color-mix(in srgb,#e2a83c 38%,transparent);color:#e4b654;background:color-mix(in srgb,#e2a83c 8%,transparent)}.lw-tth-message.is-error{border-color:color-mix(in srgb,var(--danger,#e05469) 38%,transparent);color:var(--danger,#e86b7e);background:color-mix(in srgb,var(--danger,#e05469) 8%,transparent)}
.lw-tth-preview{display:flex;min-height:0;flex-direction:column;padding:20px;border-left:1px solid var(--border,rgba(255,255,255,.1));background:color-mix(in srgb,var(--background-secondary,#191920) 72%,transparent)}.lw-tth-preview-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:11px}.lw-tth-preview-head>div{display:flex;min-width:0;flex-direction:column}.lw-tth-preview-head small{color:var(--text-muted,#999);font-size:10px}.lw-tth-preview-head button{display:flex;height:32px;align-items:center;gap:6px;padding:0 9px;border:1px solid var(--border,rgba(255,255,255,.12));border-radius:8px;color:inherit;background:color-mix(in srgb,var(--text,#fff) 5%,transparent);cursor:pointer}.lw-tth-preview-head button:disabled{opacity:.45;cursor:not-allowed}.lw-tth-paper-wrap{position:relative;display:grid;min-height:310px;flex:1;place-items:center;overflow:hidden;border-radius:12px;background:#282832;box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)}.lw-tth-preview-canvas{display:block;width:auto;max-width:calc(100% - 24px);height:auto;max-height:calc(100% - 24px);aspect-ratio:210/297;background:#fbfcff;box-shadow:0 12px 36px rgba(0,0,0,.3)}.lw-tth-preview-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:9px;color:#8f91a0;font-size:11px;pointer-events:none}.lw-tth-fit-note{margin:9px 0 0;color:var(--text-muted,#999);font-size:10px;text-align:center}
.lw-tth-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 20px;border-top:1px solid var(--border,rgba(255,255,255,.1));background:color-mix(in srgb,var(--background-secondary,#18181f) 88%,transparent)}.lw-tth-footer p{display:flex;align-items:center;gap:6px;margin:0;color:var(--text-muted,#999);font-size:10px}.lw-tth-footer>div{display:flex;gap:8px}.lw-tth-footer button{height:38px;padding:0 13px;border:0;border-radius:10px;cursor:pointer}.lw-tth-cancel{color:var(--text,#fff);background:color-mix(in srgb,var(--text,#fff) 7%,transparent)}.lw-tth-insert{display:flex;align-items:center;gap:7px;font-weight:750;color:var(--on-accent,#11131a);background:var(--accent,#7654d6);box-shadow:0 8px 22px color-mix(in srgb,var(--accent,#7654d6) 25%,transparent)}.lw-tth-insert:disabled{opacity:.42;cursor:not-allowed;box-shadow:none}
@keyframes lw-tth-fade{from{opacity:0}}@keyframes lw-tth-rise{from{opacity:0;transform:translateY(10px) scale(.985)}}
@media(max-width:780px){.lw-tth-backdrop{padding:10px}.lw-tth-dialog{width:calc(100vw - 12px);max-height:calc(100vh - 12px);border-radius:16px}.lw-tth-body{display:block}.lw-tth-preview{min-height:420px;border-top:1px solid var(--border,rgba(255,255,255,.1));border-left:0}.lw-tth-footer{align-items:stretch;flex-direction:column}.lw-tth-footer>div{display:grid;grid-template-columns:1fr 1fr}.lw-tth-footer button{justify-content:center}.lw-tth-option-grid label{grid-template-columns:1fr}.lw-tth-choice-row{grid-template-columns:1fr}}
`
