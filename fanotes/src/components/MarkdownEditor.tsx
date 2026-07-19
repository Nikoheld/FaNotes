import { forwardRef, lazy, Suspense, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
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
  indentWithTab,
} from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxTree,
  syntaxHighlighting,
} from '@codemirror/language'
import {
  Compartment,
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
import type { AppSettings, DetectedTextLanguage } from '../types'
import { createTrailingValueScheduler, type TrailingValueScheduler } from '../lib/trailingValueScheduler'

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
>

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
}

export type MarkdownFormatAction =
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'inlineCode'
  | 'link'
  | 'quote'
  | 'bulletList'
  | 'numberedList'
  | 'checklist'
  | 'codeBlock'
  | 'table'
  | 'mathBlock'
  | 'details'
  | 'horizontalRule'

export type MarkdownEditorHandle = {
  format: (action: MarkdownFormatAction) => boolean
  focus: () => void
  flushChanges: () => void
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

function stripBlockPrefix(line: string) {
  return line.replace(/^(\s*)(?:#{1,6}\s+|>\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/u, '$1')
}

export function applyMarkdownFormat(view: EditorView, action: MarkdownFormatAction) {
  if (view.state.readOnly) return false
  switch (action) {
    case 'heading1': return transformSelectedLines(view, (line) => `# ${stripBlockPrefix(line).trimStart()}`)
    case 'heading2': return transformSelectedLines(view, (line) => `## ${stripBlockPrefix(line).trimStart()}`)
    case 'heading3': return transformSelectedLines(view, (line) => `### ${stripBlockPrefix(line).trimStart()}`)
    case 'bold': return wrapSelection(view, '**', '**', 'fetter Text')
    case 'italic': return wrapSelection(view, '*', '*', 'kursiver Text')
    case 'strike': return wrapSelection(view, '~~', '~~', 'durchgestrichener Text')
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
    case 'table': return insertTemplate(view, '\n| Thema | Notiz |\n| --- | --- |\n| {{selection}} |  |\n', 'Eintrag')
    case 'mathBlock': return insertTemplate(view, '\n$$\n{{selection}}\n$$\n', 'f(x) = x^2')
    case 'details': return insertTemplate(view, '\n<details>\n<summary>Titel</summary>\n\n{{selection}}\n\n</details>\n', 'Einklappbarer Inhalt')
    case 'horizontalRule': return insertTemplate(view, '\n\n---\n\n{{selection}}', '')
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
        katex.render(this.source, node, { displayMode: this.display, output: 'htmlAndMathml', strict: false, throwOnError: false, trust: false })
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
  let mathStart: ReturnType<typeof view.state.doc.line> | null = null
  for (let number = 1; number <= view.state.doc.lines; number += 1) {
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
    for (const match of line.text.matchAll(/(?<!\$)\$([^$\n]+?)\$(?!\$)/gu)) {
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
        if (detailsLines.has(line.number)) {
          if (line.to >= visible.to || line.to >= view.state.doc.length) break
          position = line.to + 1
          continue
        }
        const active = activeLines.has(line.number)
        const metadata = /^\s*<!--\s*fanotes-(?:ink|worksheet):[a-zA-Z0-9_-]{1,96}\s*-->\s*$/u.exec(line.text)
        const heading = /^(\s*)(#{1,6})\s+/u.exec(line.text)
        const quote = /^(\s*)>\s?/u.exec(line.text)
        const rule = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line.text)

        if (metadata) {
          decorations.push(Decoration.line({ attributes: { class: 'cm-live-metadata' } }).range(line.from))
          if (line.to > line.from) decorations.push(Decoration.replace({}).range(line.from, line.to))
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

const livePreview = ViewPlugin.fromClass(class {
  decorations

  constructor(view: EditorView) {
    this.decorations = buildLivePreviewDecorations(view)
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
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
      if (update.docChanged) this.schedule(update.view, 360)
      else if (update.viewportChanged || update.selectionSet) this.schedule(update.view, 90)
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

function editorAppearance(
  settings: MarkdownEditorSettings,
  dark: boolean,
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
        overflow: 'auto',
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
      },
      '.cm-searchMatch': {
        backgroundColor: 'color-mix(in srgb, var(--warning) 32%, transparent)',
        outline: '1px solid color-mix(in srgb, var(--warning) 62%, transparent)',
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'color-mix(in srgb, var(--accent) 36%, transparent)',
      },
      '.cm-spelling-error': {
        textDecorationLine: 'underline',
        textDecorationStyle: 'wavy',
        textDecorationColor: '#e24f5f',
        textDecorationThickness: '1.5px',
        textUnderlineOffset: '3px',
        textDecorationSkipInk: 'none',
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
}: MarkdownEditorProps, forwardedRef) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const syncingExternalContent = useRef(false)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onLanguageDetectedRef = useRef(onLanguageDetected)
  const changeSchedulerRef = useRef<TrailingValueScheduler<() => string> | null>(null)
  const lastEmittedContentRef = useRef<string | null>(null)
  const initialConfigurationAppliedRef = useRef(false)
  const systemDark = useSystemDarkMode()
  const resolvedTheme = settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme
  const dark = !paperMode && resolvedTheme !== 'light' && resolvedTheme !== 'sepia'

  const compartments = useMemo(
    () => ({
      appearance: new Compartment(),
      lineNumbers: new Compartment(),
      contentAttributes: new Compartment(),
      editable: new Compartment(),
      spelling: new Compartment(),
    }),
    [],
  )

  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onLanguageDetectedRef.current = onLanguageDetected

  useImperativeHandle(forwardedRef, () => ({
    format: (action) => {
      const view = viewRef.current
      if (!view || readOnly) return false
      return applyMarkdownFormat(view, action)
    },
    focus: () => viewRef.current?.focus(),
    flushChanges: () => changeSchedulerRef.current?.flush(),
  }), [readOnly])

  useEffect(() => {
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

    const state = EditorState.create({
      doc: content,
      extensions: [
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        selectionDragAutoScroll,
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        markdown(),
        livePreview,
        EditorView.lineWrapping,
        saveKeymap,
        keymap.of([
          { key: 'Mod-b', preventDefault: true, run: (view) => applyMarkdownFormat(view, 'bold') },
          { key: 'Mod-i', preventDefault: true, run: (view) => applyMarkdownFormat(view, 'italic') },
          { key: 'Mod-k', preventDefault: true, run: (view) => applyMarkdownFormat(view, 'link') },
          indentWithTab,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
        ]),
        compartments.appearance.of(editorAppearance(settings, dark)),
        compartments.lineNumbers.of(lineNumberExtensions(settings.showLineNumbers)),
        compartments.contentAttributes.of(
          EditorView.contentAttributes.of({
            'aria-label': ariaLabel,
            autocapitalize: 'sentences',
            autocomplete: 'off',
            spellcheck: settings.spellcheck ? 'true' : 'false',
          }),
        ),
        compartments.editable.of([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        compartments.spelling.of(settings.spellcheck
          ? spellingExtensions((language) => onLanguageDetectedRef.current?.(language))
          : []),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !syncingExternalContent.current) {
            // CodeMirror paints immediately. React, word count, outline and
            // autosave receive one trailing snapshot per short typing burst.
            changeScheduler.push(() => update.state.doc.toString())
          }
        }),
      ],
    })

    const view = new EditorView({ state, parent: host })
    viewRef.current = view

    return () => {
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
        compartments.appearance.reconfigure(editorAppearance(settings, dark)),
        compartments.lineNumbers.reconfigure(
          lineNumberExtensions(settings.showLineNumbers),
        ),
        compartments.contentAttributes.reconfigure(
          EditorView.contentAttributes.of({
            'aria-label': ariaLabel,
            autocapitalize: 'sentences',
            autocomplete: 'off',
            spellcheck: settings.spellcheck ? 'true' : 'false',
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
  }, [ariaLabel, compartments, dark, readOnly, settings])

  useEffect(() => {
    const view = viewRef.current
    if (!view || lastEmittedContentRef.current === content) return
    if (view.state.doc.toString() === content) return

    const { anchor, head } = view.state.selection.main
    const nextLength = content.length
    changeSchedulerRef.current?.cancel()
    syncingExternalContent.current = true
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        selection: EditorSelection.single(
          Math.min(anchor, nextLength),
          Math.min(head, nextLength),
        ),
        // React owns this replacement. It must not become an undo step itself.
        annotations: Transaction.addToHistory.of(false),
      })
    } finally {
      syncingExternalContent.current = false
    }
  }, [content])

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
    <div
      className={`markdown-editor ${paperMode ? 'paper-mode' : ''} ${className}`.trim()}
      data-theme={dark ? 'dark' : 'light'}
      ref={hostRef}
    />
  )
})

export default MarkdownEditor
