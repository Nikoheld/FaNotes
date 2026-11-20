/** DOM helpers for the table editor: inline Markdown rendering of a cell and HTML table paste. */
import { escapeTableCell, serializeTable, type TableAlign, type TableModel } from './markdownTable'

export type InlineRenderContext = {
  /** Fills `node` with the rendered formula (KaTeX is loaded lazily by the caller). */
  math: (node: HTMLElement, source: string) => void
}

const TOKEN = new RegExp([
  '(`+)([^`\\n]+?)\\1', // 1,2 code
  '(?<!\\$)\\$([^$\\n]+?)\\$(?!\\$)', // 3 math
  '\\[\\[([^\\]\\n|]+)(?:\\|([^\\]\\n]+))?\\]\\]', // 4,5 wikilink
  '\\[([^\\]\\n]+)\\]\\(([^)\\n]+)\\)', // 6,7 link
  '(\\*\\*|__)(?=\\S)(.+?\\S)\\8', // 8,9 strong
  '~~(?=\\S)(.+?\\S)~~', // 10 strike
  '(?<!\\*)\\*(?!\\*)(\\S(?:.*?\\S)?)\\*(?!\\*)', // 11 emphasis
  '(?<!_)_(?!_)(\\S(?:.*?\\S)?)_(?!_)', // 12 emphasis
  '<br\\s*\\/?>', // line break
  '\\\\([|\\\\*_`~\\[\\]$])', // 13 escaped character
].join('|'), 'gu')

/** Renders the inline Markdown of one cell into `parent` without touching innerHTML. */
export function renderInlineMarkdown(raw: string, parent: HTMLElement, context: InlineRenderContext): void {
  const doc = parent.ownerDocument
  let last = 0
  const text = (value: string) => { if (value) parent.append(doc.createTextNode(value)) }
  const wrap = (tag: string, className: string, inner: string) => {
    const node = doc.createElement(tag)
    if (className) node.className = className
    renderInlineMarkdown(inner, node, context)
    parent.append(node)
    return node
  }
  TOKEN.lastIndex = 0
  for (const match of raw.matchAll(TOKEN)) {
    text(raw.slice(last, match.index))
    last = match.index + match[0].length
    if (match[2] !== undefined) {
      const code = doc.createElement('code')
      code.className = 'cm-live-code'
      code.textContent = match[2]
      parent.append(code)
    } else if (match[3] !== undefined) {
      const math = doc.createElement('span')
      math.className = 'cm-live-math-inline'
      math.textContent = match[3]
      context.math(math, match[3])
      parent.append(math)
    } else if (match[4] !== undefined) {
      wrap('span', 'cm-live-link', match[5] || match[4])
    } else if (match[6] !== undefined) {
      wrap('span', 'cm-live-link', match[6]).title = match[7]
    } else if (match[9] !== undefined) {
      wrap('strong', 'cm-live-strong', match[9])
    } else if (match[10] !== undefined) {
      wrap('s', 'cm-live-strike', match[10])
    } else if (match[11] !== undefined || match[12] !== undefined) {
      wrap('em', 'cm-live-emphasis', match[11] ?? match[12])
    } else if (match[13] !== undefined) {
      text(match[13])
    } else {
      parent.append(doc.createElement('br'))
    }
  }
  text(raw.slice(last))
}

const inlineMarkdown = (node: Node): string => {
  if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s+/gu, ' ').replace(/([*_`~[\]$\\])/gu, '\\$1')
  if (node.nodeType !== 1) return ''
  const element = node as HTMLElement
  const tag = element.tagName.toLowerCase()
  if (tag === 'script' || tag === 'style') return ''
  if (tag === 'br') return '<br>'
  const inner = Array.from(element.childNodes).map(inlineMarkdown).join('')
  const style = element.getAttribute('style') ?? ''
  const bold = tag === 'b' || tag === 'strong' || /font-weight\s*:\s*(?:bold|[6-9]00)/iu.test(style)
  const italic = tag === 'i' || tag === 'em' || /font-style\s*:\s*italic/iu.test(style)
  const strike = tag === 's' || tag === 'del' || /line-through/iu.test(style)
  if (!inner.trim()) return inner
  if (tag === 'code' || tag === 'kbd') return `\`${element.textContent ?? ''}\``
  if (tag === 'a') {
    const href = element.getAttribute('href') ?? ''
    return /^(?:https?:|mailto:)/iu.test(href) ? `[${inner}](${href})` : inner
  }
  let out = inner
  const pad = /^(\s*)([\s\S]*?)(\s*)$/u.exec(out)!
  out = pad[2]
  if (strike) out = `~~${out}~~`
  if (italic) out = `*${out}*`
  if (bold) out = `**${out}**`
  const block = tag === 'p' || tag === 'div' || tag === 'li'
  return `${pad[1]}${out}${pad[3]}${block ? '<br>' : ''}`
}

const cellMarkdown = (cell: Element): string => {
  const raw = Array.from(cell.childNodes).map(inlineMarkdown).join('')
  return escapeTableCell(raw.replace(/(?:<br>\s*)+$/u, '').replace(/^(?:\s*<br>)+/u, '').replace(/\s+/gu, ' ').replace(/ ?<br> ?/gu, '<br>'))
}

const cellAlign = (cell: Element): TableAlign => {
  const value = `${cell.getAttribute('align') ?? ''} ${cell.getAttribute('style') ?? ''}`.toLowerCase()
  if (/text-align\s*:\s*center|align[ =]*center|^\s*center/u.test(value)) return 'center'
  if (/text-align\s*:\s*right|^\s*right/u.test(value)) return 'right'
  if (/text-align\s*:\s*left|^\s*left/u.test(value)) return 'left'
  return null
}

/**
 * Turns clipboard HTML that is one table (Word, Excel, a web page) into a pipe table.
 * Returns null when the HTML holds other content as well, so the normal paste runs.
 */
export function htmlTableToMarkdown(html: string): string | null {
  if (!/<table[\s>]/iu.test(html)) return null
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const tables = doc.body.querySelectorAll('table')
  if (tables.length !== 1) return null
  const table = tables[0]
  if (table.querySelector('table')) return null
  const rest = (doc.body.textContent ?? '').replace(/\s+/gu, '')
  const inside = (table.textContent ?? '').replace(/\s+/gu, '')
  if (rest !== inside || !inside) return null
  const rowElements = Array.from(table.querySelectorAll('tr'))
  const grid = rowElements.map((row) => Array.from(row.children).filter((cell) => /^t[dh]$/iu.test(cell.tagName)))
    .filter((cells) => cells.length > 0)
  if (grid.length === 0) return null
  const columns = Math.min(20, Math.max(...grid.map((cells) => cells.reduce((sum, cell) => sum + Math.max(1, Number(cell.getAttribute('colspan')) || 1), 0))))
  const lines = grid.map((cells) => {
    const values: string[] = []
    for (const cell of cells) {
      values.push(cellMarkdown(cell))
      for (let extra = 1; extra < (Number(cell.getAttribute('colspan')) || 1); extra += 1) values.push('')
    }
    while (values.length < columns) values.push('')
    return values.slice(0, columns)
  })
  const [header, ...rows] = lines
  const align = grid[0].flatMap((cell) => [cellAlign(cell), ...Array.from({ length: Math.max(0, (Number(cell.getAttribute('colspan')) || 1) - 1) }, () => null)])
  while (align.length < columns) align.push(null)
  const model: TableModel = { indent: '', header, align: align.slice(0, columns), rows }
  if (rows.length === 0) model.rows.push(Array.from({ length: columns }, () => ''))
  return serializeTable(model)
}

/** Tab- or line-separated clipboard text (spreadsheets) as a grid, or null for ordinary text. */
export function tabularText(text: string): string[][] | null {
  const lines = text.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '').split('\n')
  if (!lines.some((line) => line.includes('\t'))) return null
  return lines.map((line) => line.split('\t'))
}
