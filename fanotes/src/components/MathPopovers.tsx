import { Calculator, Check, CircleAlert, ListChecks, LoaderCircle, ScanSearch, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, type CSSProperties } from 'react'
import { useMenuKeyboard } from '../lib/useMenuKeyboard'
import type { MathCheckResult } from '../lib/mathChecker'
import type { MathSolverAction } from '../lib/mathSolver'

// The two popovers of the handwriting page's math tools (solver and corrector). They open after an explicit
// action on the page, so focus moves in (the recognised expression first), Arrow keys walk the controls, Escape
// closes and focus goes back to the page. Styled by the shared popover tokens in styles.css (.math-popover).
const FIELDS = 'input:not(:disabled), select:not(:disabled), button:not(:disabled)'

/** Moves focus to the main field once recognition has finished, if focus is still inside the popover. */
function useFocusWhenReady(ref: React.RefObject<HTMLElement | null>, ready: boolean) {
  useEffect(() => {
    const node = ref.current
    if (!ready || !node || !node.contains(document.activeElement)) return
    node.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true })
  }, [ready, ref])
}

export function MathSolverPopover({ style, status, error, confidence, input, onInput, preview, validation, variables, variable, onVariable, placement, onPlacement, solving, actions, actionLabel, onRun, showTraining, onTraining, onClose }: {
  style: CSSProperties
  status: 'recognizing' | 'ready' | 'error'
  error?: string
  confidence: number
  input: string
  onInput: (value: string) => void
  /** KaTeX HTML of the recognised expression ('' when not available). */
  preview: string
  validation: string
  variables: string[]
  variable: string
  onVariable: (value: string) => void
  placement: string
  onPlacement: (value: string) => void
  solving: boolean
  actions: Array<{ action: MathSolverAction; disabled: boolean }>
  actionLabel: (action: MathSolverAction) => string
  onRun: (action: MathSolverAction) => void
  showTraining: boolean
  onTraining: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const onKeyDown = useMenuKeyboard(ref, true, onClose, { selector: FIELDS, tab: 'edge', initial: '[data-autofocus]' })
  useFocusWhenReady(ref, status !== 'recognizing')
  return (
    <div
      ref={ref}
      className="math-popover math-solver-popover"
      role="dialog"
      aria-label="Mathematischen Ausdruck bearbeiten"
      style={style}
      onKeyDown={(event) => {
        onKeyDown(event)
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      }}
    >
      <div className="math-popover__head">
        <span className="math-popover__icon"><Calculator size={15} /></span>
        <div><strong>Lokaler Mathematik-Löser</strong><small>offline · Ergebnis als deine Handschrift</small></div>
        <button type="button" className="math-popover__close" aria-label="Mathematik-Löser schließen" data-autofocus={status === 'recognizing' ? '' : undefined} onClick={onClose}><X size={15} /></button>
      </div>

      {status === 'recognizing' ? <div className="math-popover__state" role="status">
        <LoaderCircle className="lw-spin" size={20} /> Ausdruck und räumliches Layout werden gelesen …
      </div> : status === 'error' ? <div className="math-popover__state is-error" role="alert">
        <CircleAlert size={18} />
        <span>{error}</span>
        {showTraining && <button type="button" className="secondary-button" data-autofocus onClick={onTraining}><Sparkles size={14} /> GlyphenWerk öffnen</button>}
      </div> : <>
        <div className="math-popover__meter">
          <span>Erkennung</span>
          <i><b style={{ width: `${confidence}%` }} /></i>
          <strong>{confidence}%</strong>
        </div>
        {confidence < 62 && <p className="math-popover__note is-warning">Bitte prüfe den erkannten Ausdruck vor dem Rechnen.</p>}
        <label className="math-popover__field">
          <span>Erkannter Ausdruck</span>
          <input value={input} spellCheck={false} inputMode="text" data-autofocus onChange={(event) => onInput(event.target.value)} />
        </label>
        <div className="math-popover__preview">
          {preview ? <div dangerouslySetInnerHTML={{ __html: preview }} /> : <code>{input || 'Vorschau nicht verfügbar'}</code>}
        </div>
        {validation && <div className="math-popover__note is-error" role="alert"><CircleAlert size={13} /> {validation}</div>}
        <div className="math-popover__options">
          {variables.length ? <label className="math-popover__field">
            <span>Variable</span>
            <select value={variables.includes(variable) ? variable : variables[0]} onChange={(event) => onVariable(event.target.value)}>
              {variables.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label> : <span />}
          <label className="math-popover__field">
            <span>Fortsetzung</span>
            <select value={placement} onChange={(event) => onPlacement(event.target.value)}>
              <option value="auto">Automatisch gelernt</option>
              <option value="same-line">Rechts daneben</option>
              <option value="next-line">Nächste Zeile</option>
            </select>
          </label>
        </div>
        <div className="math-popover__actions">
          {actions.map(({ action, disabled }) => (
            <button
              type="button"
              key={action}
              disabled={disabled}
              className={action === 'step' || action === 'simplify' || action === 'solve' ? 'primary-button' : 'secondary-button'}
              onClick={() => onRun(action)}
            >
              {solving ? <LoaderCircle className="lw-spin" size={13} /> : <Calculator size={13} />}
              {actionLabel(action)}
            </button>
          ))}
        </div>
        <small className="math-popover__foot">Brüche, Wurzeln und Potenzen werden symbolisch verarbeitet. Die Anordnung orientiert sich an deinen bisherigen Lösungen.</small>
      </>}
    </div>
  )
}

export type MathCorrectionPopoverLine = { id: string; input: string; confidence: number }

const STATUS_LABEL: Record<string, string> = { start: 'Start', correct: 'Richtig', incorrect: 'Falsch', uncertain: 'Prüfen', unreadable: 'Unklar' }

export function MathCorrectionPopover({ style, status, error, lines, result, onLine, onRecheck, onReselect, showTraining, onTraining, onClose }: {
  style: CSSProperties
  status: 'recognizing' | 'checking' | 'editing' | 'ready' | 'error'
  error?: string
  lines: MathCorrectionPopoverLine[]
  result?: MathCheckResult
  onLine: (id: string, value: string) => void
  onRecheck: () => void
  onReselect: () => void
  showTraining: boolean
  onTraining: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const onKeyDown = useMenuKeyboard(ref, true, onClose, { selector: FIELDS, tab: 'edge', initial: '[data-autofocus]' })
  useFocusWhenReady(ref, status !== 'recognizing' && status !== 'checking')
  const busy = status === 'recognizing' || status === 'checking'
  return (
    <div
      ref={ref}
      className="math-popover math-correction-popover"
      role="dialog"
      aria-label="Mathematischen Rechenweg korrigieren"
      style={style}
      onKeyDown={(event) => {
        onKeyDown(event)
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      }}
    >
      <div className="math-popover__head">
        <span className="math-popover__icon"><ListChecks size={15} /></span>
        <div><strong>Mathematik-Korrigierer</strong><small>erster sicherer Fehler · vollständig lokal</small></div>
        <button type="button" className="math-popover__close" aria-label="Mathematik-Korrigierer schließen" data-autofocus={busy || status === 'error' ? '' : undefined} onClick={onClose}><X size={15} /></button>
      </div>

      {busy && <div className="math-popover__state" role="status">
        <LoaderCircle className="lw-spin" size={20} />
        {status === 'recognizing' ? 'Rechenzeilen, Brüche und Indizes werden räumlich gelesen …' : 'Alle Übergänge werden symbolisch bewiesen …'}
      </div>}

      {status === 'error' && <div className="math-popover__state is-error" role="alert">
        <CircleAlert size={18} />
        <span>{error}</span>
        {showTraining && <button type="button" className="secondary-button" onClick={onTraining}><Sparkles size={14} /> GlyphenWerk öffnen</button>}
      </div>}

      {lines.length > 0 && <>
        {result ? <div className={`math-popover__result is-${result.status}`} role="status">
          {result.status === 'correct' ? <Check size={16} /> : <CircleAlert size={16} />}
          <span><strong>{result.status === 'correct' ? 'Rechenweg konsistent' : result.status === 'incorrect' ? 'Fehler gefunden' : result.status === 'unreadable' ? 'Zeile nicht lesbar' : 'Manuelle Prüfung nötig'}</strong><small>{result.message}</small></span>
        </div> : status === 'editing' ? <div className="math-popover__result is-uncertain" role="status">
          <ListChecks size={16} /><span><strong>Erkennung geändert</strong><small>Prüfe die Eingaben und starte die Analyse erneut.</small></span>
        </div> : null}

        <div className="math-popover__steps">
          {lines.map((line, index) => {
            const resultLine = result?.lines[index]
            const lineStatus = resultLine?.status ?? 'unchecked'
            return <label key={line.id} className={`math-popover__step is-${lineStatus}`}>
              <span className="math-popover__step-number">{index + 1}</span>
              <span className="math-popover__step-input">
                <input
                  value={line.input}
                  spellCheck={false}
                  data-autofocus={index === 0 ? '' : undefined}
                  aria-label={`Erkannter mathematischer Schritt ${index + 1}`}
                  disabled={status === 'checking'}
                  onChange={(event) => onLine(line.id, event.target.value)}
                />
                <small>{resultLine?.message || `${line.confidence}% Erkennungssicherheit`}</small>
              </span>
              <strong className="math-popover__step-status">{STATUS_LABEL[lineStatus] ?? '–'}</strong>
            </label>
          })}
        </div>

        {result?.suggestion && <div className="math-popover__suggestion">
          <Sparkles size={14} /><span><strong>Mögliche korrekte Zielzeile</strong><code>{result.suggestion}</code></span>
        </div>}

        <div className="math-popover__actions is-two">
          <button type="button" className="primary-button" disabled={status === 'checking' || lines.some((line) => !line.input.trim())} onClick={onRecheck}>
            {status === 'checking' ? <LoaderCircle className="lw-spin" size={14} /> : <ListChecks size={14} />}
            Eingaben bestätigen &amp; neu prüfen
          </button>
          <button type="button" className="secondary-button" onClick={onReselect}><ScanSearch size={14} /> Anderen Bereich wählen</button>
        </div>
        <small className="math-popover__foot">Rot wird nur markiert, wenn die Algebra einen echten Widerspruch beweist. Unsichere Handschrift und nicht beweisbare Mehrvariablen-Schritte bleiben gelb.</small>
      </>}
    </div>
  )
}
