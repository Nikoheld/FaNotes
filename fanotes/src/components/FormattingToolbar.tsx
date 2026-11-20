import {
  Bold,
  Braces,
  Code,
  Heading,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListChecks,
  ListCollapse,
  ListOrdered,
  Minus,
  MoreHorizontal,
  Quote,
  Sigma,
  Strikethrough,
  Subscript,
  Superscript,
  Table2,
} from 'lucide-react'
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { operandsForButton, simpleLatexSnippet, type SimpleLatexButton, type SimpleLatexOperands } from '../lib/simpleLatex'
import type { MarkdownFormatAction } from './MarkdownEditor'
import { ToolbarMenu } from './ToolbarMenu'

type FormattingToolbarProps = {
  disabled?: boolean
  onFormat: (action: MarkdownFormatAction) => void
  onInsertLatex: (button: SimpleLatexButton, operands: SimpleLatexOperands) => void
  onLatexError?: (message: string) => void
  /** Text boxes on the sheet take plain markdown only: no formula inputs. */
  hideLatex?: boolean
  /** Settings toggle: hide every button whose action can simply be typed as Markdown. */
  hideTypeable?: boolean
  /** Extra controls at the end of the bar (the text-box bar adds size, colour and remove). */
  trailing?: ReactNode
  /** How many 24 px buttons `trailing` occupies, so the overflow menu can be computed. */
  trailingSlots?: number
  /** Open the "Mehr" menu on first paint (static markup checks). */
  defaultMoreOpen?: boolean
}

const LATEX_BUTTONS: Array<{ id: SimpleLatexButton; label: string; glyph: string }> = [
  { id: 'fraction', label: 'Bruch', glyph: 'a/b' },
  { id: 'sqrt', label: 'Quadratwurzel', glyph: '√' },
  { id: 'superscript', label: 'Hochgestellt', glyph: 'x²' },
  { id: 'subscript', label: 'Tiefgestellt', glyph: 'x₂' },
  { id: 'plus', label: 'Plus', glyph: '+' },
  { id: 'minus', label: 'Minus', glyph: '−' },
  { id: 'equals', label: 'Gleich', glyph: '=' },
  { id: 'pi', label: 'Pi', glyph: 'π' },
  { id: 'alpha', label: 'Alpha', glyph: 'α' },
]

type ActionEntry = {
  action: MarkdownFormatAction
  label: string
  shortcut?: string
  icon: typeof Bold
}

/** Heading levels live in one menu so the bar shows no digits. */
const HEADINGS: ActionEntry[] = [
  { action: 'heading1', label: 'Überschrift 1', icon: Heading1 },
  { action: 'heading2', label: 'Überschrift 2', icon: Heading2 },
  { action: 'heading3', label: 'Überschrift 3', icon: Heading3 },
]

/** Frequent actions in bar order; `group` draws a separator between neighbours. */
const PRIMARY: Array<ActionEntry & { group: number }> = [
  { action: 'bold', label: 'Fett', shortcut: 'Strg+B', icon: Bold, group: 1 },
  { action: 'italic', label: 'Kursiv', shortcut: 'Strg+I', icon: Italic, group: 1 },
  { action: 'strike', label: 'Durchgestrichen', icon: Strikethrough, group: 1 },
  { action: 'subscript', label: 'Text tiefgestellt', icon: Subscript, group: 1 },
  { action: 'superscript', label: 'Text hochgestellt', icon: Superscript, group: 1 },
  { action: 'inlineCode', label: 'Code', icon: Code, group: 1 },
  { action: 'link', label: 'Link', shortcut: 'Strg+K', icon: Link2, group: 1 },
  { action: 'bulletList', label: 'Aufzählung', icon: List, group: 2 },
  { action: 'numberedList', label: 'Nummerierte Liste', icon: ListOrdered, group: 2 },
  { action: 'checklist', label: 'Aufgabenliste', icon: ListChecks, group: 2 },
  { action: 'quote', label: 'Zitat', icon: Quote, group: 2 },
]

/** Rarely used blocks: always grouped in the "Mehr" menu. `typeable` ones are hidden by the settings toggle. */
const RARE: Array<ActionEntry & { typeable: boolean }> = [
  { action: 'table', label: 'Tabelle', icon: Table2, typeable: false },
  { action: 'mathBlock', label: 'Mathematikblock', icon: Sigma, typeable: false },
  { action: 'details', label: 'Einklappbarer Bereich', icon: ListCollapse, typeable: false },
  { action: 'codeBlock', label: 'Codeblock', icon: Braces, typeable: true },
  { action: 'horizontalRule', label: 'Trennlinie', icon: Minus, typeable: true },
]

/** Width of one button plus the gap, in px (matches the CSS). */
const UNIT = 26
const SEPARATOR_RESERVE = 20

export const FormattingToolbar = memo(function FormattingToolbar({
  disabled = false,
  onFormat,
  onInsertLatex,
  onLatexError,
  hideLatex = false,
  hideTypeable = false,
  trailing,
  trailingSlots = 0,
  defaultMoreOpen = false,
}: FormattingToolbarProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  // How many primary items fit; everything else moves into "Mehr". Vertical bars scroll, so they show all.
  const [fit, setFit] = useState(PRIMARY.length + 1)
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    const measure = () => {
      if (getComputedStyle(root).flexDirection === 'column') { setFit(PRIMARY.length + 1); return }
      const free = root.clientWidth - UNIT * (1 + trailingSlots) - SEPARATOR_RESERVE
      setFit(Math.max(0, Math.floor(free / UNIT)))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [trailingSlots])

  const [firstPiece, setFirstPiece] = useState('')
  const [secondPiece, setSecondPiece] = useState('')
  const insertLatex = (button: SimpleLatexButton) => {
    const operands = operandsForButton(button, firstPiece, secondPiece)
    try {
      simpleLatexSnippet(button, operands)
      onInsertLatex(button, operands)
    } catch (error) {
      onLatexError?.(error instanceof Error ? error.message : 'Nur Zahlen oder Wörter, kein LaTeX-Code.')
    }
  }

  // The heading menu is item 0, then PRIMARY. The settings toggle drops all of them.
  const showPrimary = !hideTypeable
  const visiblePrimary = showPrimary ? PRIMARY.filter((_, index) => index + 1 < fit) : []
  const headingVisible = showPrimary && fit >= 1
  const overflowPrimary = showPrimary ? PRIMARY.filter((_, index) => index + 1 >= fit) : []
  const rare = RARE.filter((entry) => !(hideTypeable && entry.typeable))

  const row = (entry: ActionEntry, key = entry.action) => {
    const Icon = entry.icon
    return (
      <button
        key={key}
        type="button"
        role="menuitem"
        className="ftb-row"
        data-menu-close
        aria-label={entry.label}
        disabled={disabled}
        onClick={() => onFormat(entry.action)}
      >
        <Icon aria-hidden="true" size={15} strokeWidth={2} />
        <span>{entry.label}</span>
        {entry.shortcut ? <kbd>{entry.shortcut}</kbd> : null}
      </button>
    )
  }

  const hasMore = (!headingVisible && showPrimary) || overflowPrimary.length > 0 || rare.length > 0 || !hideLatex

  let previousGroup = 0
  return (
    <div className="formatting-toolbar" ref={rootRef} aria-label="Markdown formatieren" role="toolbar">
      {headingVisible && (
        <ToolbarMenu label="Überschrift" icon={<Heading aria-hidden="true" size={14} strokeWidth={2} />} disabled={disabled}>
          {HEADINGS.map((entry) => row(entry))}
        </ToolbarMenu>
      )}
      {visiblePrimary.map(({ action, label, shortcut, icon: Icon, group }) => {
        const separated = previousGroup !== 0 && previousGroup !== group
        previousGroup = group
        return (
          <button
            aria-label={label}
            className={separated ? 'has-divider' : ''}
            disabled={disabled}
            key={action}
            onClick={() => onFormat(action)}
            title={shortcut ? `${label} (${shortcut})` : label}
            type="button"
          >
            <Icon aria-hidden="true" size={14} strokeWidth={2} />
          </button>
        )
      })}
      {hasMore && (
        <ToolbarMenu
          className="ftb-more"
          label="Mehr"
          icon={<MoreHorizontal aria-hidden="true" size={14} strokeWidth={2} />}
          disabled={disabled}
          defaultOpen={defaultMoreOpen}
        >
          {!headingVisible && showPrimary && HEADINGS.map((entry) => row(entry))}
          {overflowPrimary.map((entry) => row(entry))}
          {rare.length > 0 && (!headingVisible || overflowPrimary.length > 0) && showPrimary ? <hr className="ftb-rule" /> : null}
          {rare.map((entry) => row(entry))}
          {!hideLatex && (
            <div className="ftb-section simple-latex-tools" role="group" aria-label="Einfaches LaTeX" title="Zahlen oder Wörter. Die Schaltflächen setzen die Formel.">
              <span className="ftb-heading"><Sigma aria-hidden="true" size={13} /> Formel</span>
              <div className="ftb-latex-inputs">
                <input
                  aria-label="Erstes Stück"
                  disabled={disabled}
                  placeholder="Zahl oder Wort"
                  spellCheck={false}
                  value={firstPiece}
                  onChange={(event) => setFirstPiece(event.target.value)}
                />
                <input
                  aria-label="Zweites Stück"
                  disabled={disabled}
                  placeholder="Zahl oder Wort"
                  spellCheck={false}
                  value={secondPiece}
                  onChange={(event) => setSecondPiece(event.target.value)}
                />
              </div>
              <div className="ftb-latex-buttons">
                {LATEX_BUTTONS.map(({ id, label, glyph }) => (
                  <button
                    aria-label={label}
                    data-menu-close
                    disabled={disabled}
                    key={id}
                    onClick={() => insertLatex(id)}
                    title={label}
                    type="button"
                  >
                    {glyph}
                  </button>
                ))}
              </div>
            </div>
          )}
        </ToolbarMenu>
      )}
      {trailing ? <><i className="ftb-sep" aria-hidden="true" />{trailing}</> : null}
    </div>
  )
})
