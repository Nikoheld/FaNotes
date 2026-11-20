// Test-only page for scripts/check-markdown-table.mjs: the real MarkdownEditor on a synthetic note.
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import '../../src/styles.css'
import '../../src/touch.css'
import { DEFAULT_SETTINGS } from '../../src/defaults'
import { FormattingToolbar } from '../../src/components/FormattingToolbar'
import { MarkdownEditor } from '../../src/components/MarkdownEditor'

const params = new URLSearchParams(location.search)
const theme = params.get('theme') ?? 'light'
document.documentElement.dataset.theme = theme
document.body.classList.add(`app-theme-${theme}`)
const initial = params.get('content') ?? ''
const changes: string[] = []
const view = () => EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!
const w = window as unknown as Record<string, unknown>
w.__text = () => view().state.doc.toString()
w.__changes = changes
w.__setSelection = (anchor: number) => view().dispatch({ selection: { anchor } })
w.__undo = () => document.execCommand('undo')

const formats: string[] = []
w.__formats = formats
createRoot(document.getElementById('root')!).render(
  <div className={`app-shell theme-${theme}`} style={{ width: 900, margin: '0 auto', padding: 24 }}>
    <FormattingToolbar defaultMoreOpen onFormat={(action) => { formats.push(action); (w.__editor as { format: (a: string) => boolean }).format(action) }} onInsertLatex={() => undefined} />
    <MarkdownEditor
      ref={(handle) => { w.__editor = handle }}
      content={initial}
      onChange={(content) => changes.push(content)}
      onSave={() => undefined}
      settings={{ ...DEFAULT_SETTINGS, theme: theme as never }}
      paperMode
    />
  </div>,
)
