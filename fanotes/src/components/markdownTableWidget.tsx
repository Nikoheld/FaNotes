import type { ReactNode } from 'react'
import { translateUiText } from '../i18n'
import { createRoot, type Root as ReactRoot } from 'react-dom/client'
import { isolateHistory, redo, undo } from '@codemirror/commands'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers, WidgetType } from '@codemirror/view'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  FileCode2,
  Trash2,
} from 'lucide-react'
import {
  deleteColumn,
  deleteRow,
  escapeTableCell,
  fillCells,
  findTableBlocks,
  getCell,
  insertColumn,
  insertRow,
  parseTableLines,
  serializeTable,
  setCell,
  setColumnAlign,
  tableColumnCount,
  tableRowCount,
  type TableAlign,
  type TableBlock,
  type TableModel,
} from '../lib/markdownTable'
import { renderInlineMarkdown, tabularText, type InlineRenderContext } from '../lib/markdownTableDom'

const blockCache = new WeakMap<object, TableBlock[]>()

/** Pipe tables of the document, cached per document version. */
export function tableBlocksOf(state: EditorState): TableBlock[] {
  let blocks = blockCache.get(state.doc)
  if (!blocks) {
    blocks = state.doc.length > 4 && state.doc.toString().includes('|')
      ? findTableBlocks(state.doc.lines, (number) => {
        const line = state.doc.line(number)
        return { text: line.text, from: line.from, to: line.to }
      })
      : []
    blockCache.set(state.doc, blocks)
  }
  return blocks
}

type ControllerHost = HTMLElement & { __tableController?: TableController }

const COMMIT_DELAY_MS = 350

type ToolbarState = {
  row: number
  column: number
  rows: number
  columns: number
  align: TableAlign
  editable: boolean
}

type ToolbarActions = {
  rowAbove: () => void
  rowBelow: () => void
  columnLeft: () => void
  columnRight: () => void
  removeRow: () => void
  removeColumn: () => void
  align: (align: TableAlign) => void
  removeTable: () => void
  source: () => void
}

function TableToolbar({ state, actions }: { state: ToolbarState; actions: ToolbarActions }) {
  const off = !state.editable
  const button = (label: string, icon: ReactNode, run: () => void, options: { disabled?: boolean; pressed?: boolean; text?: string; danger?: boolean } = {}) => (
    <button
      type="button"
      aria-label={translateUiText(label)}
      title={translateUiText(label)}
      aria-pressed={options.pressed}
      className={options.danger ? 'cm-table-tool is-danger' : 'cm-table-tool'}
      disabled={off || options.disabled}
      onClick={run}
    >
      {icon}
      {options.text ? <span>{translateUiText(options.text)}</span> : null}
    </button>
  )
  const size = 15
  return (
    <div className="cm-table-toolbar" role="toolbar" aria-label={translateUiText('Tabelle bearbeiten')} onPointerDown={(event) => event.preventDefault()}>
      {button('Zeile oberhalb einfügen', <BetweenHorizontalStart size={size} />, actions.rowAbove, { disabled: state.row === 0 })}
      {button('Zeile unterhalb einfügen', <BetweenHorizontalEnd size={size} />, actions.rowBelow)}
      {button('Spalte links einfügen', <BetweenVerticalStart size={size} />, actions.columnLeft)}
      {button('Spalte rechts einfügen', <BetweenVerticalEnd size={size} />, actions.columnRight)}
      <i className="cm-table-tool-sep" aria-hidden="true" />
      {button('Links ausrichten', <AlignLeft size={size} />, () => actions.align('left'), { pressed: state.align === 'left' })}
      {button('Zentrieren', <AlignCenter size={size} />, () => actions.align('center'), { pressed: state.align === 'center' })}
      {button('Rechts ausrichten', <AlignRight size={size} />, () => actions.align('right'), { pressed: state.align === 'right' })}
      <i className="cm-table-tool-sep" aria-hidden="true" />
      {button('Zeile löschen', <Trash2 size={size} />, actions.removeRow, { disabled: state.row === 0 || state.rows <= 2, text: 'Zeile', danger: true })}
      {button('Spalte löschen', <Trash2 size={size} />, actions.removeColumn, { disabled: state.columns <= 1, text: 'Spalte', danger: true })}
      {button('Tabelle löschen', <Trash2 size={size} />, actions.removeTable, { text: 'Tabelle', danger: true })}
      <i className="cm-table-tool-sep" aria-hidden="true" />
      {button('Markdown-Quelltext bearbeiten', <FileCode2 size={size} />, actions.source)}
    </div>
  )
}

const caretOffset = (cell: HTMLElement) => {
  const selection = cell.ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0 || !cell.contains(selection.anchorNode)) return null
  const range = cell.ownerDocument.createRange()
  range.selectNodeContents(cell)
  range.setEnd(selection.anchorNode!, selection.anchorOffset)
  return range.toString().length
}

const placeCaret = (cell: HTMLElement, offset: number | 'end' | 'all') => {
  const doc = cell.ownerDocument
  const selection = doc.getSelection()
  if (!selection) return
  const range = doc.createRange()
  const text = cell.firstChild
  if (offset === 'all' || !text) {
    range.selectNodeContents(cell)
  } else if (offset === 'end') {
    range.selectNodeContents(cell)
    range.collapse(false)
  } else {
    range.setStart(text, Math.min(offset, text.textContent?.length ?? 0))
    range.collapse(true)
  }
  selection.removeAllRanges()
  selection.addRange(range)
}

class TableController {
  readonly dom: ControllerHost
  private readonly scroll: HTMLElement
  private readonly table: HTMLTableElement
  private readonly toolbarHost: HTMLElement
  private readonly root: ReactRoot
  private cells: HTMLTableCellElement[][] = []
  private timer: number | null = null
  private active = { row: 0, column: 0 }
  private editing: HTMLTableCellElement | null = null
  private destroyed = false

  constructor(
    private readonly view: EditorView,
    private model: TableModel,
    private docText: string,
    private readonly context: InlineRenderContext,
  ) {
    const doc = view.dom.ownerDocument
    this.dom = doc.createElement('div') as ControllerHost
    this.dom.className = 'cm-table-shell'
    this.dom.__tableController = this
    this.toolbarHost = doc.createElement('div')
    this.toolbarHost.className = 'cm-table-toolbar-host'
    this.scroll = doc.createElement('div')
    this.scroll.className = 'cm-table-scroll'
    this.table = doc.createElement('table')
    this.table.className = 'cm-table'
    this.table.setAttribute('role', 'grid')
    this.scroll.append(this.table)
    const addRow = doc.createElement('button')
    addRow.type = 'button'
    addRow.className = 'cm-table-add cm-table-add-row'
    addRow.setAttribute('aria-label', translateUiText('Zeile am Ende hinzufügen'))
    addRow.title = translateUiText('Zeile hinzufügen')
    addRow.textContent = '+'
    const addColumn = doc.createElement('button')
    addColumn.type = 'button'
    addColumn.className = 'cm-table-add cm-table-add-column'
    addColumn.setAttribute('aria-label', translateUiText('Spalte am Ende hinzufügen'))
    addColumn.title = translateUiText('Spalte hinzufügen')
    addColumn.textContent = '+'
    for (const add of [addRow, addColumn]) add.addEventListener('pointerdown', (event) => event.preventDefault())
    addRow.addEventListener('click', () => this.change(insertRow(this.model, tableRowCount(this.model)), { row: tableRowCount(this.model), column: 0 }))
    addColumn.addEventListener('click', () => this.change(insertColumn(this.model, tableColumnCount(this.model)), { row: 0, column: tableColumnCount(this.model) }))
    const body = doc.createElement('div')
    body.className = 'cm-table-body'
    body.append(this.scroll, addColumn)
    this.dom.append(this.toolbarHost, body, addRow)
    this.root = createRoot(this.toolbarHost)

    this.dom.addEventListener('focusin', (event) => this.onFocusIn(event))
    this.dom.addEventListener('focusout', (event) => this.onFocusOut(event))
    this.dom.addEventListener('input', (event) => this.onInput(event))
    this.dom.addEventListener('keydown', (event) => this.onKeyDown(event))
    this.dom.addEventListener('paste', (event) => this.onPaste(event))
    this.dom.addEventListener('dragstart', (event) => event.preventDefault())
    this.render()
  }

  private get editable() {
    return !this.view.state.readOnly && this.view.state.facet(EditorView.editable)
  }

  destroy() {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.destroyed = true
    const root = this.root
    // React refuses to unmount while it is rendering; defer to a task.
    window.setTimeout(() => root.unmount(), 0)
  }

  /** The document text changed from outside (undo, sync, source edit): adopt it. */
  sync(source: string) {
    if (source === this.docText) return
    const parsed = parseTableLines(source.split('\n'))
    if (!parsed) return
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null }
    const hadFocus = this.dom.contains(this.dom.ownerDocument.activeElement)
    this.docText = source
    this.model = parsed
    this.editing = null
    this.render()
    if (hadFocus) this.focusCell(Math.min(this.active.row, tableRowCount(parsed) - 1), Math.min(this.active.column, tableColumnCount(parsed) - 1), 'end')
  }

  // ---- rendering -----------------------------------------------------------

  private showRendered(cell: HTMLElement, row: number, column: number) {
    cell.replaceChildren()
    renderInlineMarkdown(getCell(this.model, row, column), cell, this.context)
  }

  private render() {
    const doc = this.dom.ownerDocument
    const editable = this.editable
    this.table.replaceChildren()
    this.cells = []
    const make = (row: number) => {
      const tr = doc.createElement('tr')
      const line: HTMLTableCellElement[] = []
      for (let column = 0; column < tableColumnCount(this.model); column += 1) {
        const cell = doc.createElement(row === 0 ? 'th' : 'td')
        cell.dataset.row = String(row)
        cell.dataset.column = String(column)
        cell.setAttribute('role', row === 0 ? 'columnheader' : 'gridcell')
        cell.setAttribute('contenteditable', editable ? 'plaintext-only' : 'false')
        cell.spellcheck = true
        const align = this.model.align[column]
        if (align) cell.style.textAlign = align
        this.showRendered(cell, row, column)
        tr.append(cell)
        line.push(cell)
      }
      this.cells.push(line)
      return tr
    }
    const thead = doc.createElement('thead')
    thead.append(make(0))
    const tbody = doc.createElement('tbody')
    for (let row = 1; row < tableRowCount(this.model); row += 1) tbody.append(make(row))
    this.table.append(thead, tbody)
    this.renderToolbar()
  }

  private renderToolbar() {
    if (this.destroyed) return
    const state: ToolbarState = {
      row: this.active.row,
      column: this.active.column,
      rows: tableRowCount(this.model),
      columns: tableColumnCount(this.model),
      align: this.model.align[this.active.column] ?? null,
      editable: this.editable,
    }
    const at = this.active
    const actions: ToolbarActions = {
      rowAbove: () => { if (at.row > 0) this.change(insertRow(this.model, at.row), { row: at.row, column: at.column }) },
      rowBelow: () => this.change(insertRow(this.model, at.row + 1), { row: at.row + 1, column: at.column }),
      columnLeft: () => this.change(insertColumn(this.model, at.column), { row: at.row, column: at.column }),
      columnRight: () => this.change(insertColumn(this.model, at.column + 1), { row: at.row, column: at.column + 1 }),
      removeRow: () => {
        if (at.row === 0 || tableRowCount(this.model) <= 2) return
        this.change(deleteRow(this.model, at.row), { row: Math.min(at.row, tableRowCount(this.model) - 2), column: at.column })
      },
      removeColumn: () => {
        if (tableColumnCount(this.model) <= 1) return
        this.change(deleteColumn(this.model, at.column), { row: at.row, column: Math.min(at.column, tableColumnCount(this.model) - 2) })
      },
      align: (align) => this.change(setColumnAlign(this.model, at.column, this.model.align[at.column] === align ? null : align), at),
      removeTable: () => this.removeTable(),
      source: () => this.editSource(),
    }
    this.root.render(<TableToolbar state={state} actions={actions} />)
  }

  // ---- document ------------------------------------------------------------

  private locate(): TableBlock | null {
    let position: number
    try { position = this.view.posAtDOM(this.dom) } catch { return null }
    return tableBlocksOf(this.view.state).find((block) => block.from === position) ?? null
  }

  /** Writes the model into the note as one transaction. */
  private commit(isolate: boolean) {
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null }
    if (!this.editable || this.destroyed) return
    const text = serializeTable(this.model)
    if (text === this.docText) return
    const block = this.locate()
    if (!block || block.source !== this.docText) return
    this.docText = text
    this.view.dispatch({
      changes: { from: block.from, to: block.to, insert: text },
      userEvent: 'table.edit',
      annotations: isolate ? isolateHistory.of('full') : undefined,
    })
  }

  /** Flush a pending cell edit now (before saving, undo or leaving). */
  flush() { this.commit(false) }

  private schedule() {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = window.setTimeout(() => { this.timer = null; this.commit(false) }, COMMIT_DELAY_MS)
  }

  /** A structural edit: one undo step of its own. */
  private change(next: TableModel, focus: { row: number; column: number } | null) {
    if (!this.editable) return
    this.commit(true)
    this.model = next
    this.editing = null
    this.render()
    this.commit(true)
    if (focus) this.focusCell(Math.max(0, Math.min(focus.row, tableRowCount(next) - 1)), Math.max(0, Math.min(focus.column, tableColumnCount(next) - 1)), 'all')
  }

  private removeTable() {
    this.commit(true)
    const block = this.locate()
    if (!block || !this.editable) return
    const to = Math.min(this.view.state.doc.length, block.to + 1)
    this.view.dispatch({
      changes: { from: block.from, to },
      selection: EditorSelection.cursor(block.from),
      userEvent: 'table.delete',
      annotations: isolateHistory.of('full'),
      scrollIntoView: true,
    })
    this.view.focus()
  }

  private editSource() {
    this.commit(true)
    const block = this.locate()
    if (!block) return
    this.view.dispatch({ selection: EditorSelection.cursor(block.from), scrollIntoView: true })
    this.view.focus()
  }

  private exit(direction: 'up' | 'down') {
    this.commit(false)
    const block = this.locate()
    if (!block) return
    const state = this.view.state
    if (direction === 'up') {
      if (block.from > 0) {
        this.view.dispatch({ selection: EditorSelection.cursor(block.from - 1), scrollIntoView: true })
      } else {
        this.view.dispatch({ changes: { from: 0, insert: '\n' }, selection: EditorSelection.cursor(0), scrollIntoView: true })
      }
    } else if (block.to < state.doc.length) {
      this.view.dispatch({ selection: EditorSelection.cursor(block.to + 1), scrollIntoView: true })
    } else {
      this.view.dispatch({ changes: { from: block.to, insert: '\n' }, selection: EditorSelection.cursor(block.to + 1), scrollIntoView: true })
    }
    this.view.focus()
  }

  // ---- focus & keyboard ----------------------------------------------------

  focusCell(row: number, column: number, where: 'end' | 'all' | number = 'end') {
    const cell = this.cells[row]?.[column]
    if (!cell) return
    this.active = { row, column }
    cell.focus({ preventScroll: false })
    if (this.editing !== cell) this.onFocusIn({ target: cell } as unknown as Event)
    placeCaret(cell, where)
  }

  private cellOf(target: EventTarget | null): { cell: HTMLTableCellElement; row: number; column: number } | null {
    const cell = (target as HTMLElement | null)?.closest?.('th, td') as HTMLTableCellElement | null
    if (!cell || !this.dom.contains(cell)) return null
    return { cell, row: Number(cell.dataset.row), column: Number(cell.dataset.column) }
  }

  private onFocusIn(event: Event) {
    const hit = this.cellOf(event.target)
    if (!hit) return
    this.active = { row: hit.row, column: hit.column }
    if (this.editing !== hit.cell && this.editable) {
      const raw = getCell(this.model, hit.row, hit.column)
      this.editing = hit.cell
      // Plain cells keep the caret where it was clicked; formatted ones switch to their Markdown source.
      if (hit.cell.textContent !== raw) {
        hit.cell.textContent = raw
        placeCaret(hit.cell, 'end')
      }
    }
    this.renderToolbar()
  }

  private onFocusOut(event: FocusEvent) {
    const hit = this.cellOf(event.target)
    if (!hit) return
    this.commit(false)
    if (this.editing === hit.cell) {
      this.editing = null
      if (this.cells[hit.row]?.[hit.column] === hit.cell) this.showRendered(hit.cell, hit.row, hit.column)
    }
  }

  private onInput(event: Event) {
    const hit = this.cellOf(event.target)
    if (!hit || !this.editable) return
    this.model = setCell(this.model, hit.row, hit.column, escapeTableCell(hit.cell.textContent ?? ''))
    this.schedule()
  }

  private replaceSelection(cell: HTMLElement, wrap: (selected: string) => string) {
    const selection = cell.ownerDocument.getSelection()
    const selected = selection?.toString() ?? ''
    cell.ownerDocument.execCommand('insertText', false, wrap(selected))
  }

  private onKeyDown(event: KeyboardEvent) {
    const hit = this.cellOf(event.target)
    if (!hit || event.isComposing) return
    const { cell, row, column } = hit
    const mod = event.ctrlKey || event.metaKey
    const key = event.key
    const rows = tableRowCount(this.model)
    const columns = tableColumnCount(this.model)
    const stop = () => { event.preventDefault(); event.stopPropagation() }
    if (mod && !event.altKey) {
      const lower = key.toLowerCase()
      if (lower === 'z' || lower === 'y') {
        stop()
        this.commit(true)
        if (lower === 'y' || event.shiftKey) redo(this.view)
        else undo(this.view)
        return
      }
      if (lower === 's') {
        this.commit(false)
        if (runScopeHandlers(this.view, event, 'editor')) event.preventDefault()
        return
      }
      if (lower === 'b') { stop(); this.replaceSelection(cell, (text) => `**${text || 'fett'}**`); return }
      if (lower === 'i') { stop(); this.replaceSelection(cell, (text) => `*${text || 'kursiv'}*`); return }
      return
    }
    if (key === 'Tab') {
      stop()
      if (event.shiftKey) {
        if (column > 0) this.focusCell(row, column - 1, 'all')
        else if (row > 0) this.focusCell(row - 1, columns - 1, 'all')
        return
      }
      if (column < columns - 1) this.focusCell(row, column + 1, 'all')
      else if (row < rows - 1) this.focusCell(row + 1, 0, 'all')
      else this.change(insertRow(this.model, rows), { row: rows, column: 0 })
      return
    }
    if (key === 'Enter') {
      stop()
      if (event.shiftKey) { cell.ownerDocument.execCommand('insertText', false, '<br>'); return }
      if (row < rows - 1) this.focusCell(row + 1, column, 'all')
      else this.change(insertRow(this.model, rows), { row: rows, column })
      return
    }
    if (key === 'Escape') { stop(); this.exit('down'); return }
    const selection = cell.ownerDocument.getSelection()
    if (!selection?.isCollapsed || event.shiftKey || event.altKey) return
    const offset = caretOffset(cell) ?? 0
    const length = cell.textContent?.length ?? 0
    if (key === 'ArrowLeft' && offset === 0) {
      if (column > 0) { stop(); this.focusCell(row, column - 1, 'end') }
      else if (row > 0) { stop(); this.focusCell(row - 1, columns - 1, 'end') }
      return
    }
    if (key === 'ArrowRight' && offset === length) {
      if (column < columns - 1) { stop(); this.focusCell(row, column + 1, 0) }
      else if (row < rows - 1) { stop(); this.focusCell(row + 1, 0, 0) }
      return
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const range = selection.rangeCount ? selection.getRangeAt(0) : null
      const caret = range?.getClientRects()[0] ?? range?.getBoundingClientRect()
      const box = cell.getBoundingClientRect()
      const slack = 22
      const edge = key === 'ArrowUp'
        ? !caret || caret.height === 0 || caret.top - box.top < slack
        : !caret || caret.height === 0 || box.bottom - caret.bottom < slack
      if (!edge) return
      stop()
      if (key === 'ArrowUp') {
        if (row > 0) this.focusCell(row - 1, column, 'end')
        else this.exit('up')
      } else if (row < rows - 1) {
        this.focusCell(row + 1, column, 'end')
      } else {
        this.exit('down')
      }
    }
  }

  private onPaste(event: ClipboardEvent) {
    const hit = this.cellOf(event.target)
    if (!hit || !this.editable) return
    event.preventDefault()
    event.stopPropagation()
    const text = event.clipboardData?.getData('text/plain') ?? ''
    const grid = tabularText(text)
    if (grid && (grid.length > 1 || grid[0].length > 1)) {
      const next = fillCells(this.model, hit.row, hit.column, grid)
      this.change(next, { row: hit.row, column: hit.column })
      return
    }
    hit.cell.ownerDocument.execCommand('insertText', false, text.replace(/\s*\r?\n\s*/gu, ' '))
  }
}

export type TableWidgetOptions = { math: InlineRenderContext['math'] }

/** A pipe table drawn as an editable grid. The note text stays a GFM pipe table. */
export class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly options: TableWidgetOptions) { super() }

  eq(other: TableWidget) { return other.source === this.source }

  toDOM(view: EditorView) {
    const model = parseTableLines(this.source.split('\n'))
    if (!model) return view.dom.ownerDocument.createElement('div')
    return new TableController(view, model, this.source, { math: this.options.math }).dom
  }

  updateDOM(dom: HTMLElement, view: EditorView) {
    void view
    const controller = (dom as ControllerHost).__tableController
    if (!controller) return false
    controller.sync(this.source)
    return true
  }

  destroy(dom: HTMLElement) {
    ;(dom as ControllerHost).__tableController?.destroy()
  }

  ignoreEvent() { return true }
}

const controllersOf = (view: EditorView) => Array.from(view.dom.querySelectorAll<ControllerHost>('.cm-table-shell'))
  .map((element) => element.__tableController)
  .filter((controller): controller is TableController => Boolean(controller))

/** Writes every pending cell edit into the document (before saving or switching notes). */
export function flushTableEdits(view: EditorView) {
  for (const controller of controllersOf(view)) controller.flush()
}

/** Moves the caret into a cell of the rendered table that starts at `from`. */
export function focusTableCell(view: EditorView, from: number, row: number | 'last', column = 0): boolean {
  for (const controller of controllersOf(view)) {
    let position = -1
    try { position = view.posAtDOM(controller.dom) } catch { continue }
    if (position !== from) continue
    const last = (controller as unknown as { model: TableModel }).model
    controller.focusCell(row === 'last' ? tableRowCount(last) - 1 : row, column, 'end')
    return true
  }
  return false
}
