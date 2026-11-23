import { forwardRef, lazy, Suspense, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root as ReactRoot } from 'react-dom/client'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-600.css'
import {
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import {
  defaultKeymap,
  history,
  historyKeymap,
  redo,
  indentWithTab,
} from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { foldKeysForLines, linesForFoldKeys, recallHeadingFolds, rememberHeadingFolds } from '../lib/headingFolds'
import {
  bracketMatching,
  defaultHighlightStyle,
  ensureSyntaxTree,
  foldEffect,
  foldGutter,
  foldKeymap,
  foldable,
  foldedRanges,
  unfoldEffect,
  indentOnInput,
  syntaxTree,
  syntaxHighlighting,
} from '@codemirror/language'
import {
  Compartment,
  Facet,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type Range,
} from '@codemirror/state'
import {
  crosshairCursor,
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  gutters,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { wikiLinkExtension } from '../lib/cmWikiLinkParser'
import { docFlags, primeDocFlags } from '../lib/cmDocFlags'
import { TableWidget, flushTableEdits, focusTableCell, tableBlocksOf } from './markdownTableWidget'
import { newTableText } from '../lib/markdownTable'
import { htmlTableToMarkdown } from '../lib/markdownTableDom'
import { htmlToMarkdown } from '../lib/htmlToMarkdown'
import { imageCandidates, isLocalImageSource } from '../lib/noteImagePaths'
import { createEditorFindPanel } from '../lib/editorFindBar'
import { touchSelection } from '../lib/cmTouchSelection'
import type { AppSettings, DetectedTextLanguage } from '../types'
import type { EditActivity } from '../lib/pageStats'
import { createTrailingValueScheduler, type TrailingValueScheduler } from '../lib/trailingValueScheduler'
import {
  captureGhostTextAroundLock,
  ghostTextDiagnosticFields,
  applyPaperArrowNavigation,
  handlePaperEditorScroll,
  invalidatePaperEditorScrollSeal,
  lockPaperEditorScrollIfNeeded,
  lockPaperViewportScrollStayPut,
  PAPER_EDITOR_FLING_HOLD_FRAMES,
  paperEditorScrollSealed,
  resolvePaperCaretScroller,
  sealNestedEditorScroll,
  tickPaperViewportEditorScrollHold,
  commitEditorTextInsert,
} from '../lib/paperCaretScroll'
import { bindPaperNoteText } from '../lib/noteTextStay'
import { buildTextMotionDiagnosticEvent, recordTextMotionDiagnostic } from '../lib/bugReport'
import { revealDocumentLine } from '../lib/noteOutline'
import { fenceIsOpen, isFenceLine, toggleTaskLine } from '../lib/noteEveryday'
import { clientYFromTextAnchor, registerPaperTextAnchorProvider, textAnchorFromView } from '../lib/paperTextAnchor'
import { minimalReplacement } from '../lib/textReplacement'
import { primeSpellingCorrections, rerunSpellingCheck, spellingCorrections } from '../lib/spellingCorrections'
import type { SpellingLanguage } from '../types'
import { findStudyBlocks, hashText, STUDY_KIND_LABELS, type StudyBlockRef, type StudyKind } from '../lib/study/blocks'
import { hydrateVaultImages } from '../lib/study/imageTools'
import { readStudyBlock, renderStudyBlockHtml } from '../lib/study/registry'

const LazyMarkdownPreview = lazy(() => import('./MarkdownPreview').then((module) => ({
  default: module.MarkdownPreview,
})))

let mathRendererPromise: Promise<typeof import('katex')> | null = null

function loadMathRenderer() {
  mathRendererPromise ??= Promise.all([
    import('katex'),
    import('katex/dist/katex.min.css'),
  ]).then(([module]) => module)
  return mathRendererPromise
}

export type MarkdownEditorSettings = Pick<
  AppSettings,
  | 'theme'
  | 'editorFont'
  | 'editorFontSize'
  | 'lineHeight'
  | 'showLineNumbers'
  | 'spellcheck'
  | 'autocorrect'
>

const WORD_CHARACTER = /[\p{L}\p{N}]/u
const WORD_BOUNDARY = /^[\s.,;:!?)\]}»“"'…]+$/u

const editActivityKind = (transaction: Transaction): EditActivity['kind'] | null => {
  if (transaction.isUserEvent('input.autocorrect')) return 'autocorrect'
  if (transaction.isUserEvent('input.complete')) return 'suggestion'
  if (transaction.isUserEvent('input.paste') || transaction.isUserEvent('input.drop')) return 'paste'
  if (transaction.isUserEvent('input')) return 'type'
  if (transaction.isUserEvent('delete')) return 'delete'
  if (transaction.isUserEvent('undo')) return 'undo'
  if (transaction.isUserEvent('redo')) return 'redo'
  if (transaction.isUserEvent('move') || transaction.isUserEvent('select')) return 'other'
  // Programmatic edits (formatting toolbar, inserted ink markdown) are not typing.
  return transaction.annotation(Transaction.userEvent) ? 'other' : null
}

/** Counts what one user transaction did to the document, for the page statistics. */
export const editActivityFromTransaction = (transaction: Transaction): EditActivity | null => {
  if (!transaction.docChanged) return null
  const kind = editActivityKind(transaction)
  if (!kind) return null
  let inserted = 0
  let deleted = 0
  let wordsCompleted = 0
  let lineBreaks = 0
  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
    inserted += text.length
    deleted += toA - fromA
    if (kind !== 'type') return
    const typed = text.toString()
    for (let index = 0; index < typed.length; index += 1) if (typed.charCodeAt(index) === 10) lineBreaks += 1
    // A boundary typed right behind a word character finishes that word.
    if (WORD_BOUNDARY.test(typed) && fromA > 0) {
      const before = transaction.startState.doc.sliceString(fromA - 1, fromA)
      if (WORD_CHARACTER.test(before)) wordsCompleted += 1
    }
  })
  return { kind, inserted, deleted, wordsCompleted, lineBreaks }
}

export type MarkdownEditorProps = {
  content: string
  onChange: (content: string) => void
  onSave: (content: string) => void | Promise<void>
  settings: MarkdownEditorSettings
  /** Changing this value requests focus without remounting the editor. */
  focusToken?: string | number
  className?: string
  ariaLabel?: string
  readOnly?: boolean
  /** Uses the single paper-like live editor instead of a theme-colored source pane. */
  paperMode?: boolean
  /** Reports the locally detected keyboard-text language. */
  onLanguageDetected?: (language: DetectedTextLanguage) => void
  /** Reports every user edit for the note's quiet statistics (typed, pasted, deleted, undone …). */
  onEditActivity?: (activity: EditActivity) => void
  /** Note path: folded headings are remembered under it (local profile data, not in the note) and restored on open. */
  foldKey?: string
  /** A shared note open for live co-editing: the text, the others' cursors and a per-user undo come from it. */
  liveNote?: import('../lib/collab/liveNotes').LiveNote | null
  /** Vault path of the note: relative image paths resolve against its folder. */
  notePath?: string
}

export type MarkdownFormatAction =
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'heading6'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'subscript'
  | 'superscript'
  | 'inlineCode'
  | 'link'
  | 'quote'
  | 'bulletList'
  | 'numberedList'
  | 'checklist'
  | 'codeBlock'
  | 'table'
  /** A new table of the given size: `table:<rows>x<columns>`. */
  | `table:${number}x${number}`
  | 'mathBlock'
  | 'details'
  | 'horizontalRule'

export type MarkdownEditorHandle = {
  format: (action: MarkdownFormatAction) => boolean
  focus: () => void
  flushChanges: () => void
  revealLine: (line: number) => boolean
  foldHeading: (line: number, collapsed: boolean) => boolean
  /** Ranges CodeMirror currently hides. A canvas PDF restores these after the sections open. */
  captureFolds: () => Array<{ from: number; to: number }>
  restoreFolds: (ranges: readonly { from: number; to: number }[]) => void
  /** Programmatic access used by add-ons; every call goes through a normal editor transaction. */
  getText: () => string | null
  /** Reads the coalescer and IME composition without flushing them. */
  changesPending: () => { coalescer: boolean; composing: boolean }
  getSelection: () => { from: number; to: number; text: string; line: number } | null
  insertText: (text: string, where: 'cursor' | 'start' | 'end' | 'line-end') => boolean
  replaceSelection: (text: string) => boolean
  setText: (text: string) => boolean
  /** Turn the selected lines into tasks, or tick the tasks that are already there. */
  toggleTasks: () => boolean
}

function commitEditorChange(
  view: EditorView,
  from: number,
  to: number,
  insert: string,
  selectionFrom: number,
  selectionTo = selectionFrom,
) {
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.single(selectionFrom, selectionTo),
    scrollIntoView: true,
  })
  view.focus()
  return true
}

function wrapSelection(view: EditorView, before: string, after: string, placeholder: string) {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  const body = selected || placeholder
  return commitEditorChange(
    view,
    from,
    to,
    `${before}${body}${after}`,
    from + before.length,
    from + before.length + body.length,
  )
}

function insertTemplate(view: EditorView, template: string, placeholder: string) {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  const body = selected || placeholder
  const insert = template.replace('{{selection}}', body)
  const selectionOffset = insert.indexOf(body)
  return commitEditorChange(
    view,
    from,
    to,
    insert,
    from + Math.max(0, selectionOffset),
    from + Math.max(0, selectionOffset) + body.length,
  )
}

function transformSelectedLines(
  view: EditorView,
  transform: (line: string, index: number) => string,
) {
  const { from, to } = view.state.selection.main
  const startLine = view.state.doc.lineAt(from)
  const effectiveEnd = to > from && to === view.state.doc.lineAt(to).from ? to - 1 : to
  const endLine = view.state.doc.lineAt(Math.max(from, effectiveEnd))
  const original = view.state.sliceDoc(startLine.from, endLine.to)
  const next = original.split('\n').map(transform).join('\n')
  return commitEditorChange(view, startLine.from, endLine.to, next, startLine.from, startLine.from + next.length)
}

function toggleTasksInView(view: EditorView) {
  if (view.state.readOnly) return false
  const { from, to } = view.state.selection.main
  const start = view.state.doc.lineAt(from)
  const endPos = to > from && to === view.state.doc.lineAt(to).from ? to - 1 : to
  const end = view.state.doc.lineAt(Math.max(from, endPos))
  const before: string[] = []
  for (let number = 1; number < start.number; number += 1) before.push(view.state.doc.line(number).text)
  let fence = fenceIsOpen(before)
  const changes: { from: number; to: number; insert: string }[] = []
  let cursor = end.to
  let delta = 0
  for (let number = start.number; number <= end.number; number += 1) {
    const line = view.state.doc.line(number)
    let next = line.text
    if (isFenceLine(line.text)) fence = !fence
    else if (!fence) next = toggleTaskLine(line.text)
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next })
    if (number === end.number) cursor = line.from + delta + next.length
    delta += next.length - line.text.length
  }
  if (!changes.length) return true
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(cursor),
    scrollIntoView: true,
  })
  view.focus()
  return true
}

function stripBlockPrefix(line: string) {
  return line.replace(/^(\s*)(?:#{1,6}\s+|>\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/u, '$1')
}

/** Inserts an empty pipe table at the selection, with a blank line on both sides, and moves into its first cell. */
export function insertTable(view: EditorView, rows: number, columns: number) {
  const { state } = view
  const { from, to } = state.selection.main
  const selected = state.sliceDoc(from, to).replace(/\s*\n\s*/gu, ' ').trim()
  const first = state.doc.lineAt(from)
  const last = state.doc.lineAt(to)
  const table = newTableText(rows, columns, selected)
  const atLineStart = from === first.from
  const before = from === 0 ? '' : atLineStart ? (state.doc.line(first.number - 1).text.trim() ? '\n' : '') : '\n\n'
  const restOfLine = state.sliceDoc(to, last.to).trim()
  const nextLine = last.number < state.doc.lines ? state.doc.line(last.number + 1).text : null
  const after = restOfLine ? '\n\n' : nextLine === null ? '\n' : nextLine.trim() ? '\n' : ''
  const insert = `${before}${table}${after}`
  const tableFrom = from + before.length
  const tableEnd = tableFrom + table.length
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(tableEnd + (restOfLine ? 2 : 1)),
    scrollIntoView: true,
    userEvent: 'table.edit',
  })
  window.requestAnimationFrame(() => { focusTableCell(view, tableFrom, 0, 0) })
  return true
}

export function applyMarkdownFormat(view: EditorView, action: MarkdownFormatAction) {
  const sized = /^table:(\d+)x(\d+)$/u.exec(action)
  if (sized) return insertTable(view, Number(sized[1]), Number(sized[2]))
  if (view.state.readOnly) return false
  switch (action) {
    case 'heading1': return transformSelectedLines(view, (line) => `# ${stripBlockPrefix(line).trimStart()}`)
    case 'heading2': return transformSelectedLines(view, (line) => `## ${stripBlockPrefix(line).trimStart()}`)
    case 'heading3': return transformSelectedLines(view, (line) => `### ${stripBlockPrefix(line).trimStart()}`)
    case 'heading4': return transformSelectedLines(view, (line) => `#### ${stripBlockPrefix(line).trimStart()}`)
    case 'heading5': return transformSelectedLines(view, (line) => `##### ${stripBlockPrefix(line).trimStart()}`)
    case 'heading6': return transformSelectedLines(view, (line) => `###### ${stripBlockPrefix(line).trimStart()}`)
    case 'bold': return wrapSelection(view, '**', '**', 'fetter Text')
    case 'italic': return wrapSelection(view, '*', '*', 'kursiver Text')
    case 'strike': return wrapSelection(view, '~~', '~~', 'durchgestrichener Text')
    case 'subscript': return wrapSelection(view, '<sub>', '</sub>', 'tiefgestellt')
    case 'superscript': return wrapSelection(view, '<sup>', '</sup>', 'hochgestellt')
    case 'inlineCode': {
      const { from, to } = view.state.selection.main
      return view.state.sliceDoc(from, to).includes('\n')
        ? insertTemplate(view, '\n```\n{{selection}}\n```\n', 'Code')
        : wrapSelection(view, '`', '`', 'Code')
    }
    case 'link': {
      const { from, to } = view.state.selection.main
      const label = view.state.sliceDoc(from, to) || 'Linktext'
      const url = 'https://'
      const insert = `[${label}](${url})`
      return commitEditorChange(view, from, to, insert, from + insert.length - url.length - 1, from + insert.length - 1)
    }
    case 'quote': return transformSelectedLines(view, (line) => `> ${stripBlockPrefix(line).trimStart()}`)
    case 'bulletList': return transformSelectedLines(view, (line) => `- ${stripBlockPrefix(line).trimStart()}`)
    case 'numberedList': return transformSelectedLines(view, (line, index) => `${index + 1}. ${stripBlockPrefix(line).trimStart()}`)
    case 'checklist': return transformSelectedLines(view, (line) => `- [ ] ${stripBlockPrefix(line).trimStart()}`)
    case 'codeBlock': return insertTemplate(view, '\n```\n{{selection}}\n```\n', 'Code')
    case 'table': return insertTable(view, 3, 3)
    case 'mathBlock': return insertTemplate(view, '\n$$\n{{selection}}\n$$\n', 'f(x) = x^2')
    case 'details': return insertTemplate(view, '\n<details>\n<summary>Titel</summary>\n\n{{selection}}\n\n</details>\n', 'Einklappbarer Inhalt')
    case 'horizontalRule': return insertTemplate(view, '\n\n---\n\n{{selection}}', '')
    default: return false
  }
}

function useSystemDarkMode() {
  const [isDark, setIsDark] = useState(() =>
    typeof window === 'undefined'
      ? true
      : window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (event: MediaQueryListEvent) => setIsDark(event.matches)
    setIsDark(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return isDark
}

class TextWidget extends WidgetType {
  constructor(readonly text: string, readonly className: string) { super() }
  eq(other: TextWidget) { return other.text === this.text && other.className === this.className }
  toDOM() {
    const node = document.createElement('span')
    node.className = this.className
    node.textContent = this.text
    return node
  }
}

/** A whole-line `![alt](vault/path.png)` drawn as the picture itself; the source shows while the caret is on the line. */
class ImageWidget extends WidgetType {
  constructor(readonly alt: string, readonly source: string, readonly notePath: string) { super() }
  eq(other: ImageWidget) { return other.alt === this.alt && other.source === this.source && other.notePath === this.notePath }
  toDOM(view: EditorView) {
    const frame = document.createElement('div')
    frame.className = 'cm-live-image'
    const image = document.createElement('img')
    image.alt = this.alt
    image.draggable = false
    image.decoding = 'async'
    image.addEventListener('load', () => view.requestMeasure())
    image.addEventListener('error', () => { frame.textContent = this.alt || 'Bild nicht gefunden'; frame.classList.add('is-missing'); view.requestMeasure() })
    frame.append(image)
    let relative = this.source
    try { relative = decodeURIComponent(relative) } catch { /* keep the raw path */ }
    const candidates = imageCandidates(relative, this.notePath)
    const tryNext = (index: number) => {
      if (index >= candidates.length) { image.dispatchEvent(new Event('error')); return }
      void window.fanotes.readAssetDataUrl(candidates[index]).then((url) => { image.src = url }).catch(() => tryNext(index + 1))
    }
    tryNext(0)
    return frame
  }
  ignoreEvent() { return false }
}

const vaultImageLine = (text: string) => {
  const match = /^\s*!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/u.exec(text)
  if (!match) return null
  const source = match[2]
  let decoded = source
  try { decoded = decodeURIComponent(source) } catch { /* keep the raw path */ }
  if (!isLocalImageSource(decoded)) return null
  return { alt: match[1], source }
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly changeFrom: number) { super() }
  eq(other: TaskWidget) { return other.checked === this.checked && other.changeFrom === this.changeFrom }
  toDOM(view: EditorView) {
    const wrapper = document.createElement('span')
    wrapper.className = 'cm-live-task'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = this.checked
    checkbox.ariaLabel = this.checked ? 'Aufgabe als offen markieren' : 'Aufgabe als erledigt markieren'
    checkbox.addEventListener('change', () => {
      view.dispatch({ changes: { from: this.changeFrom, to: this.changeFrom + 3, insert: this.checked ? '[ ]' : '[x]' } })
      view.focus()
    })
    wrapper.append(checkbox, document.createTextNode(' '))
    return wrapper
  }
  ignoreEvent() { return true }
}

const INLINE_MATH_SOURCE = String.raw`(?<!\$)\$([^$\n]+?)\$(?!\$)`

export const editorMathKatexOptions = (display: boolean, throwOnError: boolean) => ({
  displayMode: display,
  output: 'htmlAndMathml' as const,
  strict: false as const,
  throwOnError,
  trust: false as const,
  maxExpand: 1000,
})

/** The math span the live editor would hand to KaTeX, taken from stored note text. */
export function editorMathSource(stored: string): { source: string; display: boolean } {
  const trimmed = stored.trim()
  const display = /^\$\$\s*([\s\S]*?)\s*\$\$$/u.exec(trimmed)
  if (display && display[1].trim()) return { source: display[1].trim(), display: true }
  const inline = new RegExp(`^${INLINE_MATH_SOURCE}$`, 'u').exec(trimmed)
  if (!inline) throw new Error('Der Ausdruck ist kein Mathematikabschnitt des Editors.')
  return { source: inline[1], display: false }
}

export async function renderEditorMathHtml(source: string, display = false): Promise<string> {
  const { default: katex } = await loadMathRenderer()
  return katex.renderToString(source, editorMathKatexOptions(display, true))
}

/** Renders one stored math span with the editor's KaTeX options. Invalid LaTeX throws. */
export async function renderInsertedLatex(stored: string): Promise<string> {
  const parsed = editorMathSource(stored)
  return renderEditorMathHtml(parsed.source, parsed.display)
}

/** Fills an inline-math node of a table cell once KaTeX has loaded. */
const renderTableCellMath = (node: HTMLElement, source: string) => {
  void loadMathRenderer().then(({ default: katex }) => {
    if (!node.isConnected) return
    try {
      katex.render(source, node, editorMathKatexOptions(false, false))
    } catch {
      node.textContent = source
    }
  })
}
const tableWidgetOptions = { math: renderTableCellMath }

class MathWidget extends WidgetType {
  constructor(readonly source: string, readonly display: boolean) { super() }
  eq(other: MathWidget) { return other.source === this.source && other.display === this.display }
  toDOM() {
    const node = document.createElement('span')
    node.className = this.display ? 'cm-live-math-block' : 'cm-live-math-inline'
    node.textContent = this.source
    void loadMathRenderer().then(({ default: katex }) => {
      if (!node.isConnected) return
      try {
        katex.render(this.source, node, editorMathKatexOptions(this.display, false))
      } catch {
        node.textContent = this.source
      }
    })
    return node
  }
  ignoreEvent() { return false }
}

type DetailsBlock = {
  from: number
  to: number
  startLine: number
  endLine: number
  summary: string
  body: string
  open: boolean
}

const cleanSummary = (value: string) => value
  .replace(/<[^>]*>/gu, '')
  .replace(/^(?:\*\*|__)(.*)(?:\*\*|__)$/u, '$1')
  .trim() || 'Details'

export function findDetailsBlocks(state: EditorState): DetailsBlock[] {
  const blocks: DetailsBlock[] = []
  if (!docFlags(state.doc).details) return blocks
  for (let number = 1; number <= state.doc.lines; number += 1) {
    const line = state.doc.line(number)
    const inline = /^\s*<details(\s+open)?\s*>\s*<summary>(.*?)<\/summary>\s*(.*?)\s*<\/details>\s*$/iu.exec(line.text)
    if (inline) {
      blocks.push({
        from: line.from,
        to: line.to,
        startLine: number,
        endLine: number,
        summary: cleanSummary(inline[2]),
        body: inline[3].trim(),
        open: Boolean(inline[1]),
      })
      continue
    }

    const opener = /^\s*<details(\s+open)?\s*>\s*(?:<summary>(.*?)<\/summary>)?\s*$/iu.exec(line.text)
    if (!opener) continue
    let summary = opener[2] ? cleanSummary(opener[2]) : ''
    let summaryLine = number
    if (!summary && number < state.doc.lines) {
      const nextLine = state.doc.line(number + 1)
      const summaryMatch = /^\s*<summary>(.*?)<\/summary>\s*$/iu.exec(nextLine.text)
      if (!summaryMatch) continue
      summary = cleanSummary(summaryMatch[1])
      summaryLine = number + 1
    }

    let depth = 1
    let closingLine = 0
    for (let candidate = summaryLine + 1; candidate <= state.doc.lines; candidate += 1) {
      const candidateText = state.doc.line(candidate).text
      const opens = [...candidateText.matchAll(/<details(?:\s|>)/giu)].length
      const closes = [...candidateText.matchAll(/<\/details\s*>/giu)].length
      depth += opens - closes
      if (depth <= 0) {
        closingLine = candidate
        break
      }
    }
    if (!closingLine) continue

    const summaryDocumentLine = state.doc.line(summaryLine)
    const closeDocumentLine = state.doc.line(closingLine)
    const bodyFrom = Math.min(summaryDocumentLine.to + 1, closeDocumentLine.from)
    const bodyTo = Math.max(bodyFrom, closeDocumentLine.from - 1)
    blocks.push({
      from: line.from,
      to: closeDocumentLine.to,
      startLine: number,
      endLine: closingLine,
      summary,
      body: state.sliceDoc(bodyFrom, bodyTo).trim(),
      open: Boolean(opener[1]),
    })
    number = closingLine
  }
  return blocks
}

class DetailsWidget extends WidgetType {
  private root: ReactRoot | null = null

  constructor(
    readonly summary: string,
    readonly body: string,
    readonly open: boolean,
    readonly editPosition: number,
  ) { super() }

  eq(other: DetailsWidget) {
    return other.summary === this.summary && other.body === this.body && other.open === this.open && other.editPosition === this.editPosition
  }

  toDOM(view: EditorView) {
    const shell = document.createElement('div')
    shell.className = 'cm-live-details-shell'
    const details = document.createElement('details')
    details.className = 'cm-live-details'
    details.open = this.open
    const summary = document.createElement('summary')
    summary.textContent = this.summary
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'cm-live-details-edit'
    edit.textContent = 'Bearbeiten'
    edit.ariaLabel = `Klappbereich „${this.summary}“ als Markdown bearbeiten`
    edit.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      view.dispatch({ selection: EditorSelection.cursor(this.editPosition), scrollIntoView: true })
      view.focus()
    })
    const content = document.createElement('div')
    content.className = 'cm-live-details-content'
    details.append(summary, edit, content)
    details.addEventListener('toggle', () => view.requestMeasure())
    shell.append(details)
    this.root = createRoot(content)
    this.root.render(
      <Suspense fallback={<div className="cm-live-details-loading">Inhalt wird dargestellt …</div>}>
        <LazyMarkdownPreview content={this.body} emptyMessage="Dieser Klappbereich ist leer." />
      </Suspense>,
    )
    return shell
  }

  destroy() {
    this.root?.unmount()
    this.root = null
  }

  ignoreEvent() { return true }
}

class StudyBlockWidget extends WidgetType {
  constructor(readonly kind: StudyKind, readonly body: string, readonly from: number) { super() }
  eq(other: StudyBlockWidget) { return other.kind === this.kind && other.body === this.body && other.from === this.from }
  toDOM(view: EditorView) {
    const shell = document.createElement('div')
    shell.className = `cm-lw-shell lw-block lw-kind-${this.kind}`
    const content = document.createElement('div')
    content.className = 'lw-block-content'
    try { content.innerHTML = renderStudyBlockHtml(this.kind, this.body); hydrateVaultImages(content) } catch { content.textContent = 'Lernblock konnte nicht dargestellt werden.' }
    shell.append(content)
    return shell
  }
  ignoreEvent() { return true }
}

const readableCache = new Map<string, boolean>()
const studyBlockReadable = (block: StudyBlockRef) => {
  const key = `${block.kind}\u0000${block.body}`
  let ok = readableCache.get(key)
  if (ok === undefined) {
    ok = readStudyBlock(block.kind, block.body).ok
    if (readableCache.size > 200) readableCache.clear()
    readableCache.set(key, ok)
  }
  return ok
}

const studyBlockCache = new WeakMap<object, StudyBlockRef[]>()
const studyBlocksOf = (state: EditorView['state']) => {
  const key = state.doc as unknown as object
  let blocks = studyBlockCache.get(key)
  if (!blocks) {
    blocks = state.doc.length > 20 && docFlags(state.doc).study ? findStudyBlocks(state.doc.toString()) : []
    studyBlockCache.set(key, blocks)
  }
  return blocks
}

/** Vault path of the open note, so image references resolve against its folder. */
const notePathFacet = Facet.define<string, string>({ combine: (values) => values[0] ?? '' })

const buildLivePreviewDecorations = (view: EditorView) => {
  const decorations: Range<Decoration>[] = []
  const visited = new Set<number>()
  const activeLines = new Set<number>()
  for (const range of view.state.selection.ranges) {
    activeLines.add(view.state.doc.lineAt(range.from).number)
    activeLines.add(view.state.doc.lineAt(range.to).number)
  }

  const mathLines = new Set<number>()
  const detailsLines = new Set<number>()
  for (const block of findDetailsBlocks(view.state)) {
    const isEditing = view.state.selection.ranges.some((range) => range.empty
      ? range.from > block.from && range.from < block.to
      : range.from < block.to && range.to > block.from)
    if (isEditing) continue
    for (let number = block.startLine; number <= block.endLine; number += 1) detailsLines.add(number)
    const hostLine = view.state.doc.line(block.startLine)
    decorations.push(Decoration.line({ attributes: { class: 'cm-live-details-host' } }).range(hostLine.from))
    decorations.push(Decoration.replace({
      widget: new DetailsWidget(block.summary, block.body, block.open, Math.min(block.from + 1, block.to)),
    }).range(hostLine.from, hostLine.to))
    for (let number = block.startLine + 1; number <= block.endLine; number += 1) {
      const hiddenLine = view.state.doc.line(number)
      decorations.push(Decoration.line({ attributes: { class: 'cm-live-details-hidden' } }).range(hiddenLine.from))
      if (hiddenLine.to > hiddenLine.from) decorations.push(Decoration.replace({}).range(hiddenLine.from, hiddenLine.to))
    }
  }
  const studyLines = new Set<number>()
  studyBlocksOf(view.state).forEach((block) => {
    // A block that cannot be read safely stays as source text so nothing is hidden or rewritten.
    if (!studyBlockReadable(block)) {
      decorations.push(Decoration.line({ attributes: { class: 'cm-lw-broken', title: 'Dieser Lernblock ist beschädigt oder unvollständig lesbar' } }).range(view.state.doc.line(block.startLine).from))
      return
    }
    const isEditing = view.state.selection.ranges.some((range) => range.from <= block.to && range.to >= block.from)
    if (isEditing) return
    for (let number = block.startLine; number <= block.endLine; number += 1) studyLines.add(number)
    const hostLine = view.state.doc.line(block.startLine)
    decorations.push(Decoration.line({ attributes: { class: 'cm-lw-host' } }).range(hostLine.from))
    decorations.push(Decoration.replace({ widget: new StudyBlockWidget(block.kind, block.body, block.from) }).range(hostLine.from, hostLine.to))
    for (let number = block.startLine + 1; number <= block.endLine; number += 1) {
      const hidden = view.state.doc.line(number)
      decorations.push(Decoration.line({ attributes: { class: 'cm-lw-hidden' } }).range(hidden.from))
      if (hidden.to > hidden.from) decorations.push(Decoration.replace({}).range(hidden.from, hidden.to))
    }
  })
  let mathStart: ReturnType<typeof view.state.doc.line> | null = null
  const mathPossible = docFlags(view.state.doc).math
  for (let number = 1; mathPossible && number <= view.state.doc.lines; number += 1) {
    const line = view.state.doc.line(number)
    if (!/^\s*\$\$\s*$/u.test(line.text)) continue
    if (!mathStart) {
      mathStart = line
      continue
    }
    const open = mathStart
    const close = line
    mathStart = null
    const intersectsSelection = view.state.selection.ranges.some((range) => range.to >= open.from && range.from <= close.to)
    const visible = view.visibleRanges.some((range) => range.to >= open.from && range.from <= close.to)
    if (intersectsSelection || !visible) continue
    for (let covered = open.number; covered <= close.number; covered += 1) mathLines.add(covered)
    const sourceFrom = Math.min(open.to + 1, close.from)
    const sourceTo = Math.max(sourceFrom, close.from - 1)
    decorations.push(Decoration.line({ attributes: { class: 'cm-live-math-host' } }).range(open.from))
    decorations.push(Decoration.replace({ widget: new MathWidget(view.state.sliceDoc(sourceFrom, sourceTo).trim(), true) }).range(open.from, open.to))
    for (let covered = open.number + 1; covered <= close.number; covered += 1) {
      const coveredLine = view.state.doc.line(covered)
      decorations.push(Decoration.line({ attributes: { class: 'cm-live-math-hidden' } }).range(coveredLine.from))
      if (coveredLine.to > coveredLine.from) decorations.push(Decoration.replace({}).range(coveredLine.from, coveredLine.to))
    }
  }

  const tableLines = new Set<number>()
  for (const block of tableBlocksOf(view.state)) {
    let taken = false
    for (let number = block.startLine; number <= block.endLine && !taken; number += 1) {
      taken = mathLines.has(number) || detailsLines.has(number) || studyLines.has(number)
    }
    // The table the caret is in stays Markdown source, so every character stays editable.
    const isEditing = view.state.selection.ranges.some((range) => range.to >= block.from && range.from <= block.to)
    if (taken || isEditing) continue
    for (let number = block.startLine; number <= block.endLine; number += 1) tableLines.add(number)
    const head = view.state.doc.line(block.startLine)
    decorations.push(Decoration.line({ attributes: { class: 'cm-table-host' } }).range(head.from))
    decorations.push(Decoration.replace({ widget: new TableWidget(block.source, tableWidgetOptions) }).range(head.from, head.to))
    for (let number = block.startLine + 1; number <= block.endLine; number += 1) {
      const hidden = view.state.doc.line(number)
      decorations.push(Decoration.line({ attributes: { class: 'cm-table-hidden' } }).range(hidden.from))
      if (hidden.to > hidden.from) decorations.push(Decoration.replace({}).range(hidden.from, hidden.to))
    }
  }

  const addInlineDecorations = (line: ReturnType<typeof view.state.doc.line>, active: boolean) => {
    if (active || !line.text) return
    const occupied: Array<[number, number]> = []
    const available = (from: number, to: number) => !occupied.some(([start, end]) => from < end && to > start)
    const reserve = (from: number, to: number) => {
      if (!available(from, to)) return false
      occupied.push([from, to])
      return true
    }
    const replace = (from: number, to: number, widget?: WidgetType) => {
      if (to > from) decorations.push(Decoration.replace(widget ? { widget } : {}).range(line.from + from, line.from + to))
    }
    const mark = (from: number, to: number, className: string) => {
      if (to > from) decorations.push(Decoration.mark({ class: className }).range(line.from + from, line.from + to))
    }

    const task = /^(\s*)[-+*]\s+\[([ xX])\]\s+/u.exec(line.text)
    if (task) {
      const from = task[1].length
      const to = task[0].length
      if (reserve(from, to)) {
        const bracket = line.text.indexOf('[', from)
        replace(from, to, new TaskWidget(task[2].toLowerCase() === 'x', line.from + bracket))
      }
    } else {
      const bullet = /^(\s*)[-+*]\s+/u.exec(line.text)
      if (bullet && reserve(bullet[1].length, bullet[0].length)) {
        replace(bullet[1].length, bullet[0].length, new TextWidget('• ', 'cm-live-bullet'))
      }
    }

    for (const match of line.text.matchAll(/(`+)([^`\n]+?)\1/gu)) {
      const from = match.index
      const to = from + match[0].length
      if (!reserve(from, to)) continue
      replace(from, from + match[1].length)
      replace(to - match[1].length, to)
      mark(from + match[1].length, to - match[1].length, 'cm-live-code')
    }
    for (const match of line.text.matchAll(new RegExp(INLINE_MATH_SOURCE, 'gu'))) {
      const from = match.index
      const to = from + match[0].length
      if (reserve(from, to)) replace(from, to, new MathWidget(match[1], false))
    }
    for (const match of line.text.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/gu)) {
      const from = match.index
      const to = from + match[0].length
      if (!reserve(from, to)) continue
      replace(from, from + 1)
      replace(from + 1 + match[1].length, to)
      mark(from + 1, from + 1 + match[1].length, 'cm-live-link')
    }
    for (const match of line.text.matchAll(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/gu)) {
      const from = match.index
      const to = from + match[0].length
      if (!reserve(from, to)) continue
      const label = match[2] || match[1]
      const labelFrom = match[2] ? from + match[0].indexOf(match[2]) : from + 2
      replace(from, labelFrom)
      replace(labelFrom + label.length, to)
      mark(labelFrom, labelFrom + label.length, 'cm-live-link')
    }
    for (const match of line.text.matchAll(/(\*\*|__)(?=\S)(.+?\S)\1/gu)) {
      const from = match.index
      const to = from + match[0].length
      if (!reserve(from, to)) continue
      replace(from, from + 2)
      replace(to - 2, to)
      mark(from + 2, to - 2, 'cm-live-strong')
    }
    for (const match of line.text.matchAll(/~~(?=\S)(.+?\S)~~/gu)) {
      const from = match.index
      const to = from + match[0].length
      if (!reserve(from, to)) continue
      replace(from, from + 2)
      replace(to - 2, to)
      mark(from + 2, to - 2, 'cm-live-strike')
    }
    for (const expression of [/(?<!\*)\*(?!\*)(\S(?:.*?\S)?)\*(?!\*)/gu, /(?<!_)_(?!_)(\S(?:.*?\S)?)_(?!_)/gu]) {
      for (const match of line.text.matchAll(expression)) {
        const from = match.index
        const to = from + match[0].length
        if (!reserve(from, to)) continue
        replace(from, from + 1)
        replace(to - 1, to)
        mark(from + 1, to - 1, 'cm-live-emphasis')
      }
    }
  }

  for (const visible of view.visibleRanges) {
    let position = visible.from
    while (position <= visible.to) {
      const line = view.state.doc.lineAt(position)
      if (!visited.has(line.from)) {
        visited.add(line.from)
        if (mathLines.has(line.number)) {
          if (line.to >= visible.to || line.to >= view.state.doc.length) break
          position = line.to + 1
          continue
        }
        if (studyLines.has(line.number)) {
          if (line.to >= visible.to || line.to >= view.state.doc.length) break
          position = line.to + 1
          continue
        }
        if (tableLines.has(line.number)) {
          if (line.to >= visible.to || line.to >= view.state.doc.length) break
          position = line.to + 1
          continue
        }
        if (detailsLines.has(line.number)) {
          if (line.to >= visible.to || line.to >= view.state.doc.length) break
          position = line.to + 1
          continue
        }
        const active = activeLines.has(line.number)
        const metadata = /^\s*<!--\s*fanotes-(?:ink|worksheet):[a-zA-Z0-9_-]{1,96}\s*-->\s*$/u.exec(line.text)
          || /^\s*<!--\s*fanotes-famd:v1\b/u.test(line.text)
        const heading = /^(\s*)(#{1,6})\s+/u.exec(line.text)
        const quote = /^(\s*)>\s?/u.exec(line.text)
        const rule = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line.text)

        if (metadata) {
          decorations.push(Decoration.line({ attributes: { class: 'cm-live-metadata' } }).range(line.from))
          if (line.to > line.from) decorations.push(Decoration.replace({}).range(line.from, line.to))
        } else if (!active && vaultImageLine(line.text) && typeof window !== 'undefined' && typeof window.fanotes?.readAssetDataUrl === 'function') {
          const image = vaultImageLine(line.text)!
          decorations.push(Decoration.line({ attributes: { class: 'cm-live-image-line' } }).range(line.from))
          decorations.push(Decoration.replace({ widget: new ImageWidget(image.alt, image.source, view.state.facet(notePathFacet)) }).range(line.from, line.to))
        } else if (heading) {
          decorations.push(Decoration.line({ attributes: { class: `cm-live-heading cm-live-h${heading[2].length}` } }).range(line.from))
          if (!active) {
            const markerEnd = line.from + heading[0].length
            decorations.push(Decoration.replace({}).range(line.from + heading[1].length, markerEnd))
          }
        } else if (quote) {
          decorations.push(Decoration.line({ attributes: { class: 'cm-live-quote' } }).range(line.from))
          if (!active) decorations.push(Decoration.replace({}).range(line.from + quote[1].length, line.from + quote[0].length))
        } else if (rule) {
          decorations.push(Decoration.line({ attributes: { class: 'cm-live-rule' } }).range(line.from))
          if (!active && line.to > line.from) decorations.push(Decoration.replace({}).range(line.from, line.to))
        } else if (/^\s*\|.*\|\s*$/u.test(line.text)) {
          decorations.push(Decoration.line({ attributes: { class: /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$/u.test(line.text) ? 'cm-live-table-rule' : 'cm-live-table-row' } }).range(line.from))
        }
        addInlineDecorations(line, active)
      }
      if (line.to >= visible.to || line.to >= view.state.doc.length) break
      position = line.to + 1
    }
  }
  return Decoration.set(decorations, true)
}

/** Ctrl+Shift+V pastes the plain-text flavour: remembered from the key press to the paste event right after it. */
let plainPasteRequestedAt = 0

/** Pasting a table from Word, a spreadsheet or a web page writes a Markdown pipe table; other rich HTML becomes Markdown text. */
const tablePaste = EditorView.domEventHandlers({
  keydown(event) {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v') plainPasteRequestedAt = Date.now()
    return false
  },
  paste(event, view) {
    const html = event.clipboardData?.getData('text/html') ?? ''
    if (!html || view.state.readOnly) return false
    if (Date.now() - plainPasteRequestedAt < 1000) { plainPasteRequestedAt = 0; return false }
    const table = htmlTableToMarkdown(html)
    if (!table) {
      const markdown = htmlToMarkdown(html)
      if (!markdown) return false
      event.preventDefault()
      const { from, to } = view.state.selection.main
      view.dispatch({
        changes: { from, to, insert: markdown },
        selection: EditorSelection.cursor(from + markdown.length),
        scrollIntoView: true,
        userEvent: 'input.paste',
      })
      return true
    }
    event.preventDefault()
    const { from, to } = view.state.selection.main
    const line = view.state.doc.lineAt(from)
    const before = from === line.from ? '' : '\n\n'
    const tail = view.state.doc.lineAt(to)
    const after = to === tail.to && tail.number === view.state.doc.lines ? '\n' : '\n\n'
    const insert = `${before}${table}${after}`
    view.dispatch({
      changes: { from, to, insert },
      selection: EditorSelection.cursor(from + insert.length),
      scrollIntoView: true,
      userEvent: 'input.paste',
    })
    return true
  },
})

/**
 * A large insertion that arrives as typed text (dictation, remote input, automation) would make the
 * browser edit the DOM in one huge text node, which is slow and super-linear. CodeMirror takes it
 * as one transaction instead, like a paste (QA-003).
 */
const BULK_INSERT_CHARS = 4000
const bulkInsert = EditorView.domEventHandlers({
  beforeinput(event, view) {
    if (event.inputType !== 'insertText' || event.isComposing || view.state.readOnly) return false
    const data = event.data
    if (!data || data.length < BULK_INSERT_CHARS) return false
    event.preventDefault()
    view.dispatch(view.state.update(view.state.replaceSelection(data), { scrollIntoView: true, userEvent: 'input.type' }))
    return true
  },
})

/** Arrow keys step from the text above or below a rendered table into its first or last row. */
const enterTableByArrow = (direction: 1 | -1) => (view: EditorView) => {
  const selection = view.state.selection.main
  if (!selection.empty) return false
  const line = view.state.doc.lineAt(selection.head)
  const neighbour = line.number + direction
  if (neighbour < 1 || neighbour > view.state.doc.lines) return false
  const block = tableBlocksOf(view.state).find((entry) => neighbour >= entry.startLine && neighbour <= entry.endLine)
  if (!block) return false
  const target = view.moveVertically(selection, direction === 1)
  const landed = view.state.doc.lineAt(target.head).number
  if (landed !== neighbour && !(landed >= block.startLine && landed <= block.endLine)) return false
  return focusTableCell(view, block.from, direction === 1 ? 0 : 'last', 0)
}

const livePreview = ViewPlugin.fromClass(class {
  decorations

  constructor(view: EditorView) {
    this.decorations = buildLivePreviewDecorations(view)
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      if (update.docChanged) primeDocFlags(update.startState.doc, update.state.doc, update.changes)
      this.decorations = buildLivePreviewDecorations(update.view)
    }
  }
}, { decorations: (value) => value.decorations })

const setSpellingDecorations = StateEffect.define<DecorationSet>()
const spellingDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    let next = decorations.map(transaction.changes)
    for (const effect of transaction.effects) if (effect.is(setSpellingDecorations)) next = effect.value
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

/** The language the last spelling pass assigned to the line at `pos`, if any. */
const spellingLanguageAt = (state: EditorState, pos: number): SpellingLanguage | null => {
  const lineFrom = state.doc.lineAt(pos).from
  let language: SpellingLanguage | null = null
  state.field(spellingDecorations, false)?.between(lineFrom, lineFrom, (_from, _to, decoration) => {
    const value = decoration.spec.attributes?.['data-spelling-language']
    if (value === 'de' || value === 'en') {
      language = value
      return false
    }
    return undefined
  })
  return language
}

function spellingExtensions(onLanguageDetected: (language: DetectedTextLanguage) => void): Extension {
  const plugin = ViewPlugin.fromClass(class {
    private timer: number | null = null
    private idle: number | null = null
    private generation = 0
    private destroyed = false

    constructor(view: EditorView) {
      // Opening a note must stay inside the sub-three-second startup budget.
      // A real edit still checks after 360 ms; an untouched first page waits
      // until the app is interactive before loading and hashing dictionaries.
      this.schedule(view, 3200)
    }

    update(update: ViewUpdate) {
      if (update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(rerunSpellingCheck)))) this.schedule(update.view, 0)
      else if (update.docChanged) this.schedule(update.view, 360)
      else if (update.viewportChanged || update.selectionSet) this.schedule(update.view, 220)
    }

    private cancelScheduled() {
      if (this.timer !== null) window.clearTimeout(this.timer)
      if (this.idle !== null && 'cancelIdleCallback' in window) window.cancelIdleCallback(this.idle)
      this.timer = null
      this.idle = null
    }

    private schedule(view: EditorView, delay: number) {
      this.cancelScheduled()
      const generation = ++this.generation
      this.timer = window.setTimeout(() => {
        this.timer = null
        const run = () => { void this.check(view, generation) }
        if ('requestIdleCallback' in window) {
          this.idle = window.requestIdleCallback(() => {
            this.idle = null
            run()
          }, { timeout: 700 })
        } else run()
      }, delay)
    }

    private async check(view: EditorView, generation: number) {
      const doc = view.state.doc
      const segments = new Map<number, { from: number; text: string }>()
      for (const range of view.visibleRanges) {
        const first = doc.lineAt(range.from)
        const last = doc.lineAt(Math.max(range.from, range.to))
        for (let lineNumber = first.number; lineNumber <= last.number; lineNumber += 1) {
          const line = doc.line(lineNumber)
          segments.set(line.from, { from: line.from, text: line.text })
        }
      }
      const visibleSegments = [...segments.values()]
      const firstFrom = visibleSegments[0]?.from ?? 0
      const lastSegment = visibleSegments.at(-1)
      const lastTo = lastSegment ? lastSegment.from + lastSegment.text.length : 0
      const ignoredRanges: Array<{ from: number; to: number }> = []
      if (lastTo >= firstFrom) {
        syntaxTree(view.state).iterate({
          from: firstFrom,
          to: lastTo,
          enter: (node) => {
            if (/^(?:CodeBlock|FencedCode|InlineCode|CodeText|URL|LinkDestination|Autolink|HTMLBlock|HTMLTag|Comment)$/u.test(node.name)) {
              ignoredRanges.push({ from: node.from, to: node.to })
              return false
            }
            return undefined
          },
        })
        const visibleText = doc.sliceString(firstFrom, lastTo)
        for (const match of visibleText.matchAll(/\$\$[\s\S]*?\$\$/gu)) {
          const from = firstFrom + (match.index ?? 0)
          ignoredRanges.push({ from, to: from + match[0].length })
        }
      }
      const cursorPositions = view.state.selection.ranges.flatMap((range) => [range.anchor, range.head])
      const { checkSpelling } = await import('../lib/spelling')
      const result = await checkSpelling({ segments: visibleSegments, ignoredRanges, cursorPositions })
      if (this.destroyed || generation !== this.generation || view.state.doc !== doc) return

      const decorations: Range<Decoration>[] = []
      for (const line of result.lines) {
        decorations.push(Decoration.line({
          attributes: {
            lang: line.language === 'de' ? 'de-CH' : 'en',
            'data-spelling-language': line.language,
          },
        }).range(line.from))
      }
      for (const error of result.errors) {
        decorations.push(Decoration.mark({
          class: 'cm-spelling-error',
          attributes: {
            lang: error.language === 'de' ? 'de-CH' : 'en',
            'data-spelling-word': error.word,
            'data-spelling-language': error.language,
            title: `Möglicher Rechtschreibfehler · ${error.language === 'de' ? 'Deutsch' : 'Englisch'}`,
          },
        }).range(error.from, error.to))
      }
      view.dom.dataset.detectedLanguage = result.detectedLanguage
      view.contentDOM.lang = result.detectedLanguage === 'en' ? 'en' : 'de-CH'
      view.dispatch({ effects: setSpellingDecorations.of(Decoration.set(decorations, true)) })
      onLanguageDetected(result.detectedLanguage)
    }

    destroy() {
      this.destroyed = true
      this.generation += 1
      this.cancelScheduled()
    }
  })
  return [spellingDecorations, plugin]
}

/** Red squiggle under a misspelled word. Painted in the span's own box so the glyphs stay put. */
const spellingWave = (color: string) => {
  const stroke = color.replace('#', '%23')
  return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='3' viewBox='0 0 6 3'%3E%3Cpath d='M0 2.2Q1.5.4 3 2.2T6 2.2' fill='none' stroke='${stroke}' stroke-width='.7'/%3E%3C/svg%3E")`
}

function editorAppearance(
  settings: MarkdownEditorSettings,
  dark: boolean,
  paperMode = false,
): Extension {
  const surface = EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'transparent',
        color: 'var(--text-primary)',
        fontSize: `${settings.editorFontSize}px`,
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        overflow: paperMode ? 'clip' : 'auto',
        overscrollBehavior: paperMode ? 'none' : 'auto',
        fontFamily: settings.editorFont,
        lineHeight: String(settings.lineHeight),
      },
      '.cm-content': {
        minHeight: '100%',
        padding: '28px clamp(20px, 4vw, 64px) 42vh',
        caretColor: 'var(--accent)',
      },
      '.cm-line': { padding: '0 2px' },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--accent)',
        borderLeftWidth: '2px',
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
        backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)',
      },
      '.cm-activeLine': {
        backgroundColor: 'color-mix(in srgb, var(--accent) 5%, transparent)',
      },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        border: 'none',
        color: 'var(--text-faint)',
        paddingLeft: '8px',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: 'var(--text-muted)',
      },
      '.cm-foldGutter .cm-gutterElement': {
        cursor: 'pointer',
        opacity: '0.62',
      },
      '.cm-panels': {
        backgroundColor: 'var(--surface-elevated)',
        color: 'var(--text-primary)',
      },
      '.cm-panels.cm-panels-top': {
        borderBottom: '1px solid var(--border)',
      },
      '.cm-textfield': {
        backgroundColor: 'var(--surface-input)',
        border: '1px solid var(--border)',
        borderRadius: '6px',
        color: 'var(--text-primary)',
        outline: 'none',
      },
      '.cm-tooltip': {
        backgroundColor: 'var(--surface-elevated)',
        border: '1px solid var(--border)',
        borderRadius: '9px',
        boxShadow: 'var(--shadow-lg)',
        color: 'var(--text-primary)',
        overflow: 'hidden',
        // The host under the editor stage ignores hits so it cannot cover the note.
        pointerEvents: 'auto',
      },
      '.cm-searchMatch': {
        backgroundColor: 'color-mix(in srgb, var(--warning) 32%, transparent)',
        outline: '1px solid color-mix(in srgb, var(--warning) 62%, transparent)',
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'color-mix(in srgb, var(--accent) 36%, transparent)',
      },
      // A background wave, not text-decoration. Chrome's wavy underline is a
      // separate paint for that span and sits the word off the rest of the line.
      '.cm-spelling-error': {
        textDecoration: 'none',
        backgroundImage: spellingWave(dark ? '#ff8d90' : '#c03543'),
        backgroundRepeat: 'repeat-x',
        backgroundPosition: 'left bottom',
        backgroundSize: '6px 3px',
        display: 'inline',
        margin: '0',
        padding: '0',
        border: '0',
        verticalAlign: 'baseline',
        font: 'inherit',
        letterSpacing: 'inherit',
        lineHeight: 'inherit',
      },
      // A word autocorrect just changed: dotted accent underline until the next edit elsewhere.
      '.cm-autocorrected': {
        textDecoration: 'none',
        backgroundImage: 'radial-gradient(circle, var(--accent) 0.7px, transparent 0.85px)',
        backgroundRepeat: 'repeat-x',
        backgroundPosition: 'left bottom',
        backgroundSize: '5px 3px',
      },
      '.cm-tooltip:has(> .cm-spelling-menu)': {
        border: '1px solid var(--border)',
        borderRadius: '10px',
        boxShadow: 'var(--shadow-lg)',
        backgroundColor: 'var(--surface-elevated)',
      },
      '.cm-spelling-menu': {
        minWidth: '200px',
        maxWidth: '320px',
        padding: '6px',
        fontFamily: 'var(--font-ui, system-ui, sans-serif)',
        fontSize: '13px',
        lineHeight: '1.35',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      },
      '.cm-spelling-menu__word': {
        padding: '4px 8px 2px',
        color: 'var(--text-muted)',
        fontSize: '12px',
        textDecorationLine: 'underline',
        textDecorationStyle: 'wavy',
        textDecorationColor: 'var(--danger)',
        textUnderlineOffset: '3px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      '.cm-spelling-menu__suggestions, .cm-spelling-menu__actions': {
        display: 'flex',
        flexDirection: 'column',
      },
      '.cm-spelling-menu__actions': {
        borderTop: '1px solid var(--border)',
        paddingTop: '4px',
      },
      '.cm-spelling-menu__note': {
        padding: '5px 8px',
        color: 'var(--text-faint)',
        fontStyle: 'italic',
      },
      '.cm-spelling-menu__item': {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: 'var(--text-primary)',
        font: 'inherit',
        textAlign: 'left',
        padding: '5px 8px',
        borderRadius: '6px',
        cursor: 'pointer',
      },
      '.cm-spelling-menu__suggestion': {
        fontWeight: '600',
      },
      '.cm-spelling-menu__ignore, .cm-spelling-menu__learn, .cm-spelling-menu__revert': {
        color: 'var(--text-muted)',
      },
      '.cm-spelling-menu__item:hover, .cm-spelling-menu__item:focus-visible': {
        backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)',
        color: 'var(--text-primary)',
        outline: 'none',
      },
    },
    { dark },
  )

  return [syntaxHighlighting(defaultHighlightStyle), surface]
}

function lineNumberExtensions(enabled: boolean): Extension {
  if (!enabled) return []
  return [lineNumbers(), highlightActiveLineGutter()]
}

const selectionDragAutoScroll = ViewPlugin.fromClass(class {
  private activePointer: number | null = null
  private anchor: number | null = null
  private clientX = 0
  private clientY = 0
  private animationFrame = 0
  private readonly pointerSurface: HTMLElement

  constructor(private readonly view: EditorView) {
    // The paper editor contains generous page padding. A selection may start
    // there (especially when dragging back from the end of a long note), so
    // listening only on CodeMirror misses a legitimate upward drag. The
    // closest unified page scroller is still local to this note/editor.
    this.pointerSurface = view.dom.closest<HTMLElement>('.unified-note-view') ?? view.dom
    this.pointerSurface.addEventListener('pointerdown', this.pointerDown)
  }

  private pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.view.state.readOnly) return
    // A press on a text box (its move and resize handles) belongs to the box:
    // dragging it across the typed text must not start a selection there.
    if (event.target instanceof Element && event.target.closest('.note-text-field')) return
    this.activePointer = event.pointerId
    this.clientX = event.clientX
    this.clientY = event.clientY
    this.anchor = this.view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
      ?? this.view.state.selection.main.anchor
    window.addEventListener('pointermove', this.pointerMove, { passive: true })
    window.addEventListener('pointerup', this.pointerUp, { once: true })
    window.addEventListener('pointercancel', this.pointerUp, { once: true })
    this.schedule()
  }

  private pointerMove = (event: PointerEvent) => {
    if (event.pointerId !== this.activePointer) return
    if ((event.buttons & 1) === 0) {
      this.stop()
      return
    }
    this.clientX = event.clientX
    this.clientY = event.clientY
    this.schedule()
  }

  private pointerUp = (event: PointerEvent) => {
    if (event.pointerId === this.activePointer) this.stop()
  }

  private schedule = () => {
    if (!this.animationFrame) this.animationFrame = window.requestAnimationFrame(this.tick)
  }

  private scrollContainer = () => {
    const paper = resolvePaperCaretScroller(this.view.dom)
    if (paper) return paper
    let candidate: HTMLElement | null = this.view.scrollDOM
    while (candidate) {
      const overflowY = window.getComputedStyle(candidate).overflowY
      if (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        candidate.scrollHeight > candidate.clientHeight + 1
      ) return candidate
      candidate = candidate.parentElement
    }
    return this.view.scrollDOM
  }

  private tick = () => {
    this.animationFrame = 0
    if (this.activePointer === null) return
    const scroller = this.scrollContainer()
    const bounds = scroller.getBoundingClientRect()
    const edge = Math.min(84, Math.max(38, bounds.height * 0.14))
    const upperDistance = bounds.top + edge - this.clientY
    const lowerDistance = this.clientY - (bounds.bottom - edge)
    const direction = upperDistance > 0 ? -1 : lowerDistance > 0 ? 1 : 0
    if (direction) {
      const overflow = direction < 0 ? upperDistance : lowerDistance
      const velocity = direction * Math.min(32, Math.max(3, 3 + overflow / edge * 25))
      const previousTop = scroller.scrollTop
      scroller.scrollTop += velocity
      if (scroller.scrollTop !== previousTop) {
        const head = this.view.posAtCoords({
          x: Math.max(bounds.left + 3, Math.min(bounds.right - 3, this.clientX)),
          y: direction < 0 ? bounds.top + 3 : bounds.bottom - 3,
        }, false)
        const selection = this.view.state.selection.main
        const anchor = this.anchor ?? selection.anchor
        if (head !== null && head !== selection.head) {
          this.view.dispatch({ selection: EditorSelection.single(anchor, head) })
        }
      }
    }
    if (direction) this.schedule()
  }

  private stop = () => {
    this.activePointer = null
    this.anchor = null
    window.removeEventListener('pointermove', this.pointerMove)
    window.removeEventListener('pointerup', this.pointerUp)
    window.removeEventListener('pointercancel', this.pointerUp)
    if (this.animationFrame) window.cancelAnimationFrame(this.animationFrame)
    this.animationFrame = 0
  }

  destroy() {
    this.stop()
    this.pointerSurface.removeEventListener('pointerdown', this.pointerDown)
  }
})

/**
 * A blinking caret keeps the compositor and GPU process awake for as long as the editor
 * is focused. After a few seconds without typing or caret movement the caret stays solid
 * (like the Windows caret blink timeout); the next edit or selection change blinks again.
 */
const CARET_REST_MS = 8000
const caretRest = ViewPlugin.fromClass(class {
  private timer: number | undefined

  constructor(readonly view: EditorView) {
    this.arm()
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.focusChanged) this.arm()
  }

  private arm() {
    this.view.dom.classList.remove('fn-caret-rest')
    window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => this.view.dom.classList.add('fn-caret-rest'), CARET_REST_MS)
  }

  destroy() {
    window.clearTimeout(this.timer)
  }
})

const paperCaretLock = ViewPlugin.fromClass(class {
  private flingFrames = 0
  private flingId = 0
  private measureQueued = false
  private paper: HTMLElement | null = null

  constructor(readonly view: EditorView) {
    this.paper = resolvePaperCaretScroller(this.view.dom)
    this.view.scrollDOM.addEventListener('scroll', this.onEditorLayerScroll)
    this.paper?.addEventListener('scroll', this.onPaperScroll, { passive: true })
    if (this.view.dom.closest('.unified-paper, .paper-view')) {
      sealNestedEditorScroll(this.view.scrollDOM)
      lockPaperEditorScrollIfNeeded(this.view.dom)
    }
  }

  private holdFling = () => {
    const tick = tickPaperViewportEditorScrollHold(
      resolvePaperCaretScroller(this.view.dom) ?? this.paper,
      this.flingFrames,
    )
    this.flingFrames = tick.remainingFrames
    this.flingId = this.flingFrames > 0 ? requestAnimationFrame(this.holdFling) : 0
  }

  private stayPut = (paper: HTMLElement | null) => {
    const captured = captureGhostTextAroundLock(paper, this.view.dom)
    const now = Date.now()
    if (captured.slip.slip) {
      recordTextMotionDiagnostic(buildTextMotionDiagnosticEvent({
        at: now,
        ...ghostTextDiagnosticFields(captured.before, captured.slip),
      }), now)
    }
    if (captured.back.back) {
      recordTextMotionDiagnostic(buildTextMotionDiagnosticEvent({
        at: now + 1,
        ...ghostTextDiagnosticFields(captured.after, captured.back),
      }), now + 1)
    }
    this.flingFrames = PAPER_EDITOR_FLING_HOLD_FRAMES
    if (!this.flingId) this.flingId = requestAnimationFrame(this.holdFling)
  }

  private onEditorLayerScroll = () => {
    const paper = resolvePaperCaretScroller(this.view.dom) ?? this.paper
    if (paperEditorScrollSealed(paper)) return
    this.stayPut(paper)
  }

  private onPaperScroll = () => {
    // The paper view seals the same layers. A second walk on this event,
    // plus a fresh 16-frame hold, was the scroll hitch.
    if (paperEditorScrollSealed(this.paper)) return
    this.stayPut(this.paper)
  }

  update(update: ViewUpdate) {
    const paper = resolvePaperCaretScroller(update.view.dom) ?? this.paper
    if (paper && paper !== this.paper) {
      this.paper?.removeEventListener('scroll', this.onPaperScroll)
      this.paper = paper
      this.paper.addEventListener('scroll', this.onPaperScroll, { passive: true })
    }
    if (update.docChanged || update.geometryChanged) {
      invalidatePaperEditorScrollSeal(paper)
      this.stayPut(paper)
    } else if (!paperEditorScrollSealed(paper)) {
      this.stayPut(paper)
    }
    if (update.docChanged && !this.measureQueued && update.transactions.some((tr) => !tr.annotation(Transaction.userEvent))) {
      // A line the editor has not measured yet counts as one full text line
      // until its measure pass (next frame); the hidden fanotes-ink marker
      // line is 0 px high, so for one frame the text column, the sheet below
      // it and the ink page (which only ever grows) were 28 px too tall.
      // Programmatic edits (marker attach, sync pulls) settle before paint.
      this.measureQueued = true
      queueMicrotask(() => {
        this.measureQueued = false
        // `measure` is public at runtime but not in the typings.
        const view = this.view as EditorView & { measure?: () => void }
        if (view.dom.isConnected && typeof view.measure === 'function') view.measure()
      })
    }
    if (!update.docChanged && !update.selectionSet) return
    const followCaret = update.transactions.some((tr) => {
      const user = tr.annotation(Transaction.userEvent) ?? ''
      if (user.includes('pointer')) return false
      return user === 'select' || user.startsWith('select.') || user === 'input' || user.startsWith('input.')
    })
    update.view.requestMeasure({
      key: 'fanotes-paper-caret',
      read: (view) => view.coordsAtPos(view.state.selection.main.head),
      write: (caret, view) => {
        if (followCaret) applyPaperArrowNavigation(view.dom, caret)
        else lockPaperEditorScrollIfNeeded(view.dom, caret)
      },
    })
  }

  destroy() {
    if (this.flingId) cancelAnimationFrame(this.flingId)
    this.view.scrollDOM.removeEventListener('scroll', this.onEditorLayerScroll)
    this.paper?.removeEventListener('scroll', this.onPaperScroll)
  }
})

const paperScrollHandler = EditorView.scrollHandler.of((view, range) => (
  handlePaperEditorScroll(view, range)
))

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor({
  content,
  onChange,
  onSave,
  settings,
  focusToken,
  className = '',
  ariaLabel = 'Markdown-Editor',
  readOnly = false,
  paperMode = false,
  onLanguageDetected,
  onEditActivity,
  foldKey,
  liveNote = null,
  notePath = '',
}: MarkdownEditorProps, forwardedRef) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const syncingExternalContent = useRef(false)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const foldKeyRef = useRef(foldKey)
  foldKeyRef.current = foldKey
  const onLanguageDetectedRef = useRef(onLanguageDetected)
  const onEditActivityRef = useRef(onEditActivity)
  const changeSchedulerRef = useRef<TrailingValueScheduler<() => string> | null>(null)
  const lastEmittedContentRef = useRef<string | null>(null)
  const initialConfigurationAppliedRef = useRef(false)
  const autocorrectEnabled = settings.spellcheck && settings.autocorrect && !readOnly
  const autocorrectEnabledRef = useRef(autocorrectEnabled)
  autocorrectEnabledRef.current = autocorrectEnabled
  const systemDark = useSystemDarkMode()
  const resolvedTheme = settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme
  const dark = !paperMode && resolvedTheme !== 'light' && resolvedTheme !== 'sepia' && resolvedTheme !== 'snow'

  const compartments = useMemo(
    () => ({
      appearance: new Compartment(),
      lineNumbers: new Compartment(),
      contentAttributes: new Compartment(),
      editable: new Compartment(),
      spelling: new Compartment(),
      history: new Compartment(),
      live: new Compartment(),
    }),
    [],
  )

  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onLanguageDetectedRef.current = onLanguageDetected
  onEditActivityRef.current = onEditActivity

  useImperativeHandle(forwardedRef, () => ({
    format: (action) => {
      const view = viewRef.current
      if (!view || readOnly) return false
      return applyMarkdownFormat(view, action)
    },
    focus: () => viewRef.current?.focus(),
    flushChanges: () => {
      const view = viewRef.current
      if (view) flushTableEdits(view)
      changeSchedulerRef.current?.flush()
    },
    foldHeading: (line, collapsed) => {
      const view = viewRef.current
      if (!view) return false
      const lineInfo = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, Math.trunc(line))))
      const range = foldable(view.state, lineInfo.from, lineInfo.to)
      if (!range) return false
      view.dispatch({ effects: collapsed ? foldEffect.of(range) : unfoldEffect.of(range) })
      return true
    },
    captureFolds: () => {
      const view = viewRef.current
      if (!view) return []
      const ranges: Array<{ from: number; to: number }> = []
      foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
        ranges.push({ from, to })
      })
      return ranges
    },
    restoreFolds: (ranges) => {
      const view = viewRef.current
      if (!view) return
      const effects = []
      foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
        effects.push(unfoldEffect.of({ from, to }))
      })
      const length = view.state.doc.length
      for (const range of ranges) {
        if (range.from >= 0 && range.to <= length && range.from < range.to) {
          effects.push(foldEffect.of({ from: range.from, to: range.to }))
        }
      }
      if (effects.length) view.dispatch({ effects })
    },
    revealLine: (line) => {
      const view = viewRef.current
      if (!view) return false
      const target = revealDocumentLine(view.state.doc, line)
      if (!target) return false
      view.dispatch({
        selection: EditorSelection.cursor(target.from),
        effects: EditorView.scrollIntoView(target.from, { y: 'start', yMargin: 48 }),
      })
      view.focus()
      return true
    },
    getText: () => viewRef.current?.state.doc.toString() ?? null,
    changesPending: () => ({
      coalescer: changeSchedulerRef.current?.pending() ?? false,
      composing: viewRef.current?.composing ?? false,
    }),
    getSelection: () => {
      const view = viewRef.current
      if (!view) return null
      const { from, to } = view.state.selection.main
      return { from, to, text: view.state.sliceDoc(from, to), line: view.state.doc.lineAt(from).number }
    },
    insertText: (text, where) => {
      const view = viewRef.current
      if (!view || readOnly) return false
      const { doc } = view.state
      const head = view.state.selection.main.head
      const at = where === 'start' ? 0 : where === 'end' ? doc.length : where === 'line-end' ? doc.lineAt(head).to : head
      return commitEditorChange(view, at, at, text, at + text.length)
    },
    replaceSelection: (text) => {
      const view = viewRef.current
      if (!view || readOnly) return false
      const { from, to } = view.state.selection.main
      return commitEditorChange(view, from, to, text, from + text.length)
    },
    setText: (text) => {
      const view = viewRef.current
      if (!view || readOnly) return false
      const length = view.state.doc.length
      return commitEditorChange(view, 0, length, text, Math.min(text.length, view.state.selection.main.head))
    },
    toggleTasks: () => {
      const view = viewRef.current
      if (!view || readOnly) return false
      return toggleTasksInView(view)
    },
  }), [readOnly])

  // The note tab is visible in the same commit. CodeMirror's content node has
  // to exist before that commit yields, or the first keystrokes miss the editor.
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const changeScheduler = createTrailingValueScheduler((readContent: () => string) => {
      const nextContent = readContent()
      lastEmittedContentRef.current = nextContent
      onChangeRef.current(nextContent)
    })
    changeSchedulerRef.current = changeScheduler

    const saveKeymap = keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: (view) => {
          changeScheduler.flush()
          void Promise.resolve(onSaveRef.current(view.state.doc.toString())).catch(
            (error: unknown) => console.error('Markdown konnte nicht gespeichert werden.', error),
          )
          return true
        },
      },
    ])

    // Heading folds: restored once the document has text, saved (debounced) when a fold or the text changes.
    const foldPath = foldKeyRef.current
    const storedFolds = foldPath ? recallHeadingFolds(foldPath) : []
    let foldsReady = !storedFolds.length
    let foldTimer: number | null = null
    let foldView: EditorView | null = null
    const persistFolds = () => {
      foldTimer = null
      if (!foldPath || !foldView) return
      const { state: current } = foldView
      const lines: number[] = []
      foldedRanges(current).between(0, current.doc.length, (from) => { lines.push(current.doc.lineAt(from).number) })
      rememberHeadingFolds(foldPath, foldKeysForLines(current.doc.toString(), lines))
    }
    const applyStoredFolds = () => {
      if (foldsReady || !foldView || foldView.state.doc.length === 0) return
      foldsReady = true
      const target = foldView
      ensureSyntaxTree(target.state, target.state.doc.length, 300)
      const effects = linesForFoldKeys(target.state.doc.toString(), storedFolds).flatMap((line) => {
        const info = target.state.doc.line(line)
        const range = foldable(target.state, info.from, info.to)
        return range ? [foldEffect.of(range)] : []
      })
      if (effects.length) target.dispatch({ effects })
    }

    const state = EditorState.create({
      doc: content,
      extensions: [
        highlightSpecialChars(),
        compartments.history.of(history()),
        compartments.live.of([]),
        notePathFacet.of(notePath),
        // The paper scroller (not .cm-scroller) pans the sheet. "Fixed" gutters
        // are `position: sticky; left: 0` and would ride over the first glyphs
        // (82% white) whenever the zoomed sheet is scrolled sideways.
        gutters({ fixed: false }),
        foldGutter(),
        drawSelection(),
        caretRest,
        selectionDragAutoScroll,
        touchSelection,
        paperCaretLock,
        paperScrollHandler,
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true, createPanel: createEditorFindPanel }),
        markdown({ extensions: [wikiLinkExtension] }),
        livePreview,
        tablePaste,
        bulkInsert,
        EditorView.lineWrapping,
        saveKeymap,
        keymap.of([
          { key: 'Mod-Shift-z', preventDefault: true, run: redo },
          { key: 'Mod-b', preventDefault: true, run: (view) => applyMarkdownFormat(view, 'bold') },
          { key: 'Mod-i', preventDefault: true, run: (view) => applyMarkdownFormat(view, 'italic') },
          { key: 'Mod-k', preventDefault: true, run: (view) => applyMarkdownFormat(view, 'link') },
          { key: 'Mod-Enter', preventDefault: true, run: (view) => toggleTasksInView(view) },
          { key: 'ArrowDown', run: enterTableByArrow(1) },
          { key: 'ArrowUp', run: enterTableByArrow(-1) },
          indentWithTab,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
        ]),
        compartments.appearance.of(editorAppearance(settings, dark, paperMode)),
        compartments.lineNumbers.of(lineNumberExtensions(settings.showLineNumbers)),
        compartments.contentAttributes.of(
          EditorView.contentAttributes.of({
            'aria-label': ariaLabel,
            autocapitalize: 'sentences',
            autocomplete: 'off',
            // The browser's own spellcheck paints a second wave and can shift the word.
            spellcheck: 'false',
          }),
        ),
        compartments.editable.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        compartments.spelling.of(settings.spellcheck
          ? spellingExtensions((language) => onLanguageDetectedRef.current?.(language))
          : []),
        spellingCorrections({
          autocorrectEnabled: () => autocorrectEnabledRef.current,
          languageAt: spellingLanguageAt,
        }),
        EditorView.updateListener.of((update) => {
          if (foldPath) {
            if (!foldsReady) {
              if (update.docChanged) window.setTimeout(applyStoredFolds, 0)
            } else if (update.docChanged || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(foldEffect) || effect.is(unfoldEffect)))) {
              if (foldTimer !== null) window.clearTimeout(foldTimer)
              foldTimer = window.setTimeout(persistFolds, 400)
            }
          }
          if (update.docChanged && !syncingExternalContent.current) {
            // CodeMirror paints immediately. React, word count, outline and
            // autosave receive one trailing snapshot per short typing burst.
            changeScheduler.push(() => {
              const text = update.state.doc.toString()
              bindPaperNoteText(resolvePaperCaretScroller(update.view.dom), text)
              return text
            })
            const report = onEditActivityRef.current
            if (report) {
              for (const transaction of update.transactions) {
                const activity = editActivityFromTransaction(transaction)
                if (activity) report(activity)
              }
            }
          }
        }),
      ],
    })

    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    foldView = view
    applyStoredFolds()
    bindPaperNoteText(resolvePaperCaretScroller(host), state.doc.toString())
    // The paper camera remembers the text under the viewport edge, not a
    // pixel offset: CodeMirror only estimates the height of unrendered lines.
    const unregisterAnchor = registerPaperTextAnchorProvider(host, {
      anchorAtClientY: (clientY) => textAnchorFromView(view, clientY),
      clientYForAnchor: (anchor) => clientYFromTextAnchor(view, anchor),
    })

    return () => {
      unregisterAnchor()
      if (foldTimer !== null) { window.clearTimeout(foldTimer); persistFolds() }
      changeScheduler.flush()
      changeSchedulerRef.current = null
      viewRef.current = null
      view.destroy()
    }
    // Editor state is configured through compartments after initial creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compartments])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    // EditorState.create already received the current props above. Avoid an
    // immediate second full CodeMirror reconfiguration on the first mount;
    // this used to rebuild every compartment and spelling plugin before the
    // user could type a single character.
    if (!initialConfigurationAppliedRef.current) {
      initialConfigurationAppliedRef.current = true
      return
    }
    view.dispatch({
      effects: [
        compartments.appearance.reconfigure(editorAppearance(settings, dark, paperMode)),
        compartments.lineNumbers.reconfigure(
          lineNumberExtensions(settings.showLineNumbers),
        ),
        compartments.contentAttributes.reconfigure(
          EditorView.contentAttributes.of({
            'aria-label': ariaLabel,
            autocapitalize: 'sentences',
            autocomplete: 'off',
            spellcheck: 'false',
          }),
        ),
        compartments.editable.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        compartments.spelling.reconfigure(settings.spellcheck
          ? spellingExtensions((language) => onLanguageDetectedRef.current?.(language))
          : []),
      ],
    })
    if (!settings.spellcheck) onLanguageDetectedRef.current?.('unknown')
    // Only the settings the editor really uses: the whole settings object changes with every unrelated
    // switch (reduce motion, snow, ...), and reconfiguring the editor then costs time in a large note (QA-035).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ariaLabel, compartments, dark, readOnly, settings.editorFont, settings.editorFontSize, settings.lineHeight, settings.showLineNumbers, settings.spellcheck])

  useEffect(() => {
    const view = viewRef.current
    if (!view || lastEmittedContentRef.current === content) return
    const current = view.state.doc.toString()
    if (current === content) return

    // Keystrokes the app has not seen yet (still in the 90 ms coalescer or
    // mid-IME composition) outrank any replacement React wants to make. Hand
    // them to the app now and keep the editor's text; the stale prop is
    // reconciled by the change the flush emits.
    const scheduler = changeSchedulerRef.current
    const typedSinceEmit = lastEmittedContentRef.current !== null && current !== lastEmittedContentRef.current
    if (scheduler?.pending() || typedSinceEmit || view.composing) {
      scheduler?.flush()
      return
    }

    const span = minimalReplacement(current, content)
    const kept = commitEditorTextInsert(current, span.from, span.to, span.insert)
    if (kept.hide || kept.unmount || kept.fullClear) return
    if (!kept.note.startsWith(kept.prefix) || !kept.note.endsWith(kept.suffix)) return
    syncingExternalContent.current = true
    try {
      view.dispatch({
        // Replace only the span that differs. CodeMirror maps the selection
        // through the change, so a cursor after the edited span stays where it
        // is instead of being clamped to the new document length.
        changes: { from: span.from, to: span.to, insert: span.insert },
        // React owns this replacement. It must not become an undo step itself.
        annotations: Transaction.addToHistory.of(false),
      })
      bindPaperNoteText(resolvePaperCaretScroller(view.dom), kept.note)
      lastEmittedContentRef.current = content
    } finally {
      syncingExternalContent.current = false
    }
  }, [content])

  // Live co-editing: the editor takes the shared text over, then every edit and cursor goes through Yjs.
  useEffect(() => {
    const view = viewRef.current
    if (!view || !liveNote) return
    let cancelled = false
    void import('../lib/collab/liveEditor').then(({ liveEditorExtension }) => {
      if (cancelled || viewRef.current !== view) return
      const shared = liveNote.ytext.toString()
      const current = view.state.doc.toString()
      if (current !== shared) {
        const span = minimalReplacement(current, shared)
        // The shared text is the truth now; this is not an undo step. The editor reports it like any change,
        // so the app's copy and the autosave follow.
        view.dispatch({ changes: { from: span.from, to: span.to, insert: span.insert }, annotations: Transaction.addToHistory.of(false) })
      }
      view.dispatch({ effects: [compartments.history.reconfigure([]), compartments.live.reconfigure(liveEditorExtension(liveNote))] })
    })
    return () => {
      cancelled = true
      if (viewRef.current === view) {
        view.dispatch({ effects: [compartments.live.reconfigure([]), compartments.history.reconfigure(history())] })
      }
    }
  }, [compartments, liveNote])

  useEffect(() => {
    if (!autocorrectEnabled) return
    // The exact word lists (≈4.5 MB) load once, after the note is interactive,
    // so opening a note stays inside the startup budget. Until then the
    // spellchecker still underlines; autocorrect simply waits.
    let idle: number | null = null
    const timer = window.setTimeout(() => {
      const run = () => { primeSpellingCorrections().catch((error: unknown) => console.warn('Autokorrektur konnte die Wortlisten nicht laden:', error)) }
      if ('requestIdleCallback' in window) idle = window.requestIdleCallback(run, { timeout: 4_000 })
      else run()
    }, 2_500)
    return () => {
      window.clearTimeout(timer)
      if (idle !== null && 'cancelIdleCallback' in window) window.cancelIdleCallback(idle)
    }
  }, [autocorrectEnabled])

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.hidden) changeSchedulerRef.current?.flush()
    }
    document.addEventListener('visibilitychange', flushWhenHidden)
    return () => document.removeEventListener('visibilitychange', flushWhenHidden)
  }, [])

  useEffect(() => {
    if (focusToken === undefined) return
    const frame = window.requestAnimationFrame(() => viewRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [focusToken])

  return (
    <>
      <div
        className={`markdown-editor ${paperMode ? 'paper-mode' : ''} ${className}`.trim()}
        data-theme={dark ? 'dark' : 'light'}
        ref={hostRef}
      />
    </>
  )
})

export default MarkdownEditor
