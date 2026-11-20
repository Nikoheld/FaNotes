/**
 * GFM pipe tables as a small editable model. The note file keeps plain pipe tables
 * (other platforms read them); this module only parses, edits and re-serializes them.
 * Cell text is stored exactly as written between the pipes (escapes like `\|` stay).
 */

export type TableAlign = 'left' | 'center' | 'right' | null

export type TableModel = {
  /** Leading whitespace of the first line, restored on serialization. */
  indent: string
  /** Row 0 is the header. */
  header: string[]
  align: TableAlign[]
  rows: string[][]
}

export type TableBlock = {
  /** Document offsets of the first character of the header line and the end of the last row. */
  from: number
  to: number
  /** 1-based line numbers, inclusive. */
  startLine: number
  endLine: number
  model: TableModel
  /** The block's text exactly as it stands in the document. */
  source: string
}

export type TableLine = { text: string; from: number; to: number }

const ROW_RE = /^\s*\|.*\|\s*$/u
const DELIMITER_CELL_RE = /^\s*:?-+:?\s*$/u
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/u

/** Splits one table line into raw cells. Unescaped pipes separate cells. */
export function splitTableRow(line: string): string[] | null {
  if (!ROW_RE.test(line) || line.trim().length < 2) return null
  const text = line.trim()
  const cells: string[] = []
  let current = ''
  let backslashes = 0
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index]
    if (char === '|' && backslashes % 2 === 0) {
      cells.push(current.trim())
      current = ''
      backslashes = 0
      continue
    }
    backslashes = char === '\\' ? backslashes + 1 : 0
    current += char
  }
  // The final pipe closes the row, so whatever remains is only trailing whitespace.
  if (current.trim()) cells.push(current.trim())
  return cells
}

const alignOf = (cell: string): TableAlign => {
  const text = cell.trim()
  const left = text.startsWith(':')
  const right = text.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

const delimiterCell = (align: TableAlign) => (align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---')

/** Parses the lines of one table. Returns null when the text is not a table the model can hold without loss. */
export function parseTableLines(lines: string[]): TableModel | null {
  if (lines.length < 2) return null
  const header = splitTableRow(lines[0])
  const delimiter = splitTableRow(lines[1])
  if (!header || !delimiter || header.length === 0 || header.length !== delimiter.length) return null
  if (!delimiter.every((cell) => DELIMITER_CELL_RE.test(cell))) return null
  const columns = header.length
  const rows: string[][] = []
  for (const line of lines.slice(2)) {
    const cells = splitTableRow(line)
    if (!cells || cells.length > columns) return null
    while (cells.length < columns) cells.push('')
    rows.push(cells)
  }
  return { indent: /^\s*/u.exec(lines[0])![0], header, align: delimiter.map(alignOf), rows }
}

export function serializeTable(model: TableModel): string {
  const row = (cells: string[]) => `${model.indent}| ${cells.join(' | ')} |`
  return [row(model.header), row(model.align.map(delimiterCell)), ...model.rows.map(row)].join('\n')
}

/** Finds the pipe tables of a document. Fenced code is skipped. */
export function findTableBlocks(lineCount: number, lineAt: (number: number) => TableLine): TableBlock[] {
  const blocks: TableBlock[] = []
  let fence: string | null = null
  let number = 1
  while (number <= lineCount) {
    const line = lineAt(number)
    const fenceMatch = FENCE_RE.exec(line.text)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (fence === null) fence = marker[0].repeat(marker.length)
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      number += 1
      continue
    }
    if (fence !== null || !ROW_RE.test(line.text) || number === lineCount || !ROW_RE.test(lineAt(number + 1).text)) {
      number += 1
      continue
    }
    let end = number
    while (end < lineCount && ROW_RE.test(lineAt(end + 1).text)) end += 1
    const texts: string[] = []
    for (let current = number; current <= end; current += 1) texts.push(lineAt(current).text)
    const model = parseTableLines(texts)
    if (model) {
      const last = lineAt(end)
      blocks.push({ from: line.from, to: last.to, startLine: number, endLine: end, model, source: texts.join('\n') })
    }
    number = end + 1
  }
  return blocks
}

/** Convenience for plain strings (checks, paste handling). */
export function findTableBlocksInText(text: string): TableBlock[] {
  const lines: TableLine[] = []
  let from = 0
  for (const value of text.split('\n')) {
    lines.push({ text: value, from, to: from + value.length })
    from += value.length + 1
  }
  return findTableBlocks(lines.length, (number) => lines[number - 1])
}

/** Cell text as it is stored: no line breaks, no bare pipes. */
export function escapeTableCell(text: string): string {
  let result = ''
  let backslashes = 0
  for (const char of text.replace(/\r?\n/gu, '<br>').trim()) {
    if (char === '|' && backslashes % 2 === 0) result += '\\|'
    else result += char
    backslashes = char === '\\' ? backslashes + 1 : 0
  }
  return result
}

export function makeTable(rows: number, columns: number, indent = ''): TableModel {
  const safeRows = Math.max(2, Math.min(50, Math.floor(rows) || 2))
  const safeColumns = Math.max(1, Math.min(20, Math.floor(columns) || 1))
  const blank = () => Array.from({ length: safeColumns }, () => '')
  return { indent, header: blank(), align: Array.from({ length: safeColumns }, () => null), rows: Array.from({ length: safeRows - 1 }, blank) }
}

export const tableRowCount = (model: TableModel) => model.rows.length + 1
export const tableColumnCount = (model: TableModel) => model.header.length

const clone = (model: TableModel): TableModel => ({
  indent: model.indent,
  header: [...model.header],
  align: [...model.align],
  rows: model.rows.map((row) => [...row]),
})

/** Reads a cell; row 0 is the header. */
export const getCell = (model: TableModel, row: number, column: number) => (row === 0 ? model.header : model.rows[row - 1])?.[column] ?? ''

export function setCell(model: TableModel, row: number, column: number, value: string): TableModel {
  const next = clone(model)
  if (row === 0) next.header[column] = value
  else if (next.rows[row - 1]) next.rows[row - 1][column] = value
  return next
}

/** Inserts a body row so it ends up at grid index `at` (1 = right below the header). */
export function insertRow(model: TableModel, at: number): TableModel {
  const next = clone(model)
  const index = Math.max(0, Math.min(next.rows.length, at - 1))
  next.rows.splice(index, 0, Array.from({ length: next.header.length }, () => ''))
  return next
}

/** Deletes a body row by grid index. The header row cannot be removed. */
export function deleteRow(model: TableModel, row: number): TableModel {
  if (row < 1 || row > model.rows.length) return model
  const next = clone(model)
  next.rows.splice(row - 1, 1)
  return next
}

export function insertColumn(model: TableModel, at: number): TableModel {
  const next = clone(model)
  const index = Math.max(0, Math.min(next.header.length, at))
  next.header.splice(index, 0, '')
  next.align.splice(index, 0, null)
  next.rows.forEach((row) => row.splice(index, 0, ''))
  return next
}

export function deleteColumn(model: TableModel, column: number): TableModel {
  if (model.header.length <= 1 || column < 0 || column >= model.header.length) return model
  const next = clone(model)
  next.header.splice(column, 1)
  next.align.splice(column, 1)
  next.rows.forEach((row) => row.splice(column, 1))
  return next
}

export function setColumnAlign(model: TableModel, column: number, align: TableAlign): TableModel {
  if (column < 0 || column >= model.header.length) return model
  const next = clone(model)
  next.align[column] = align
  return next
}

/** Writes a block of cells (for example pasted from a spreadsheet) starting at a cell, growing the table when needed. */
export function fillCells(model: TableModel, row: number, column: number, values: string[][]): TableModel {
  let next = clone(model)
  values.forEach((line, rowOffset) => {
    while (tableRowCount(next) <= row + rowOffset) next = insertRow(next, tableRowCount(next))
    line.forEach((value, columnOffset) => {
      while (tableColumnCount(next) <= column + columnOffset) next = insertColumn(next, tableColumnCount(next))
      next = setCell(next, row + rowOffset, column + columnOffset, escapeTableCell(value))
    })
  })
  return next
}

/** Plain pipe-table text for a new rows x columns table. `firstCell` fills the first header cell. */
export function newTableText(rows: number, columns: number, firstCell = ''): string {
  const model = makeTable(rows, columns)
  model.header[0] = escapeTableCell(firstCell)
  return serializeTable(model)
}
