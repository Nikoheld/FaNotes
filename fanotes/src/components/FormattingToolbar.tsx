import {
  Bold,
  Braces,
  Code,
  Heading1,
  Heading2,
  Italic,
  Link2,
  List,
  ListChecks,
  ListCollapse,
  ListOrdered,
  Minus,
  Quote,
  Sigma,
  Strikethrough,
  Table2,
} from 'lucide-react'
import { memo, useState } from 'react'
import { operandsForButton, simpleLatexSnippet, type SimpleLatexButton, type SimpleLatexOperands } from '../lib/simpleLatex'
import type { MarkdownFormatAction } from './MarkdownEditor'

type FormattingToolbarProps = {
  disabled?: boolean
  onFormat: (action: MarkdownFormatAction) => void
  onInsertLatex: (button: SimpleLatexButton, operands: SimpleLatexOperands) => void
  onLatexError?: (message: string) => void
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

const ACTIONS: Array<{
  action: MarkdownFormatAction
  label: string
  shortcut?: string
  icon: typeof Bold
  divider?: boolean
}> = [
  { action: 'heading1', label: 'Überschrift 1', icon: Heading1 },
  { action: 'heading2', label: 'Überschrift 2', icon: Heading2 },
  { action: 'bold', label: 'Fett', shortcut: 'Strg+B', icon: Bold, divider: true },
  { action: 'italic', label: 'Kursiv', shortcut: 'Strg+I', icon: Italic },
  { action: 'strike', label: 'Durchgestrichen', icon: Strikethrough },
  { action: 'inlineCode', label: 'Code', icon: Code },
  { action: 'link', label: 'Link', shortcut: 'Strg+K', icon: Link2 },
  { action: 'bulletList', label: 'Aufzählung', icon: List, divider: true },
  { action: 'numberedList', label: 'Nummerierte Liste', icon: ListOrdered },
  { action: 'checklist', label: 'Aufgabenliste', icon: ListChecks },
  { action: 'quote', label: 'Zitat', icon: Quote },
  { action: 'table', label: 'Tabelle', icon: Table2, divider: true },
  { action: 'mathBlock', label: 'Mathematikblock', icon: Sigma },
  { action: 'codeBlock', label: 'Codeblock', icon: Braces },
  { action: 'details', label: 'Einklappbarer Bereich', icon: ListCollapse },
  { action: 'horizontalRule', label: 'Trennlinie', icon: Minus },
]

export const FormattingToolbar = memo(function FormattingToolbar({
  disabled = false,
  onFormat,
  onInsertLatex,
  onLatexError,
}: FormattingToolbarProps) {
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
  return (
    <div className="formatting-toolbar" aria-label="Markdown formatieren" role="toolbar">
      {ACTIONS.map(({ action, label, shortcut, icon: Icon, divider }) => (
        <button
          aria-label={label}
          className={divider ? 'has-divider' : ''}
          disabled={disabled}
          key={action}
          onClick={() => onFormat(action)}
          title={shortcut ? `${label} (${shortcut})` : label}
          type="button"
        >
          <Icon aria-hidden="true" size={14} strokeWidth={2} />
        </button>
      ))}
      <div className="simple-latex-tools" role="group" aria-label="Einfaches LaTeX" title="Zahlen oder Wörter. Die Schaltflächen setzen die Formel.">
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
        {LATEX_BUTTONS.map(({ id, label, glyph }) => (
          <button
            aria-label={label}
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
  )
})
