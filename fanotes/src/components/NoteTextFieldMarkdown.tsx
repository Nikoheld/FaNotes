import { memo, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element as HastElement, ElementContent } from 'hast'
import { Check } from 'lucide-react'
import { translateUiText } from '../i18n'
import {
  openableNoteTextLink,
  remarkNoteTextDialect,
  remarkNoteTextScripts,
  remarkNoteTextSoftBreaks,
} from '../lib/noteTextMarkdown'

type NoteTextFieldMarkdownProps = {
  text: string
  /** Flip the task on a 1-based source line. */
  onToggleTask: (line: number) => void
  onOpenLink: (href: string) => void
}

const REMARK_PLUGINS = [remarkGfm, remarkNoteTextDialect, remarkNoteTextScripts, remarkNoteTextSoftBreaks]

const isElement = (node: ElementContent | undefined): node is HastElement => node?.type === 'element'

/** The GFM checkbox sits in the item itself (tight list) or in its first paragraph (loose list). */
const taskCheckbox = (item: HastElement | undefined): HastElement | null => {
  if (!item) return null
  for (const child of item.children) {
    if (!isElement(child)) continue
    if (child.tagName === 'input') return child
    if (child.tagName === 'p') {
      const nested = child.children.find((grand) => isElement(grand) && grand.tagName === 'input')
      return isElement(nested) ? nested : null
    }
    return null
  }
  return null
}

const keepFromSheet = (event: ReactPointerEvent<HTMLElement>) => {
  event.stopPropagation()
}

function NoteTextFieldMarkdownView({ text, onToggleTask, onOpenLink }: NoteTextFieldMarkdownProps) {
  const components: Components = {
    a: ({ href, children }) => {
      const target = openableNoteTextLink(href)
      return (
        <a
          href={target ?? undefined}
          title={target ?? undefined}
          rel="noreferrer noopener"
          onPointerDown={keepFromSheet}
          onMouseDown={(event) => { if (target) event.preventDefault() }}
          onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
            event.preventDefault()
            // An inert link behaves like the rest of the text: it opens the editor.
            if (!target) return
            event.stopPropagation()
            onOpenLink(target)
          }}
        >
          {children}
        </a>
      )
    },
    // Task checkboxes are drawn by the list item, so they can be toggled.
    input: () => null,
    li: ({ node, className, children }) => {
      const box = taskCheckbox(node)
      const line = node?.position?.start.line
      if (!box || !line) return <li className={className}>{children}</li>
      const checked = Boolean(box.properties?.checked)
      return (
        <li className={checked ? 'note-text-md-task is-done' : 'note-text-md-task'}>
          <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            // The rendered text is user content and skipped by the DOM translator.
            aria-label={translateUiText(checked ? 'Als offen markieren' : 'Als erledigt markieren')}
            className="note-text-md-check"
            onPointerDown={(event) => {
              event.stopPropagation()
              // Ticking a task must not open the box for typing.
              event.preventDefault()
            }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation()
              onToggleTask(line)
            }}
          >
            {checked && <Check aria-hidden="true" strokeWidth={3} />}
          </button>
          {children}
        </li>
      )
    },
    // Text boxes never load pictures: a remote image would also blank the canvas export.
    img: ({ alt }) => <span className="note-text-md-image">{alt || ''}</span>,
  }
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components} skipHtml>
      {text}
    </ReactMarkdown>
  )
}

/** Re-parses only when the text changes; callers pass callbacks that read current state. */
export const NoteTextFieldMarkdown = memo(NoteTextFieldMarkdownView, (before, after) => before.text === after.text)
