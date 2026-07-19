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
import { memo } from 'react'
import type { MarkdownFormatAction } from './MarkdownEditor'

type FormattingToolbarProps = {
  disabled?: boolean
  onFormat: (action: MarkdownFormatAction) => void
}

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

export const FormattingToolbar = memo(function FormattingToolbar({ disabled = false, onFormat }: FormattingToolbarProps) {
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
    </div>
  )
})
