/** Button-built simple LaTeX for the text editor, plus note export to .tex and PDF. */

export const SIMPLE_LATEX_BUTTONS = [
  'fraction',
  'sqrt',
  'superscript',
  'subscript',
  'plus',
  'minus',
  'equals',
  'pi',
  'alpha',
] as const

export type SimpleLatexButton = (typeof SIMPLE_LATEX_BUTTONS)[number]

/** Plain numbers or words. The buttons add every TeX command. */
export type SimpleLatexOperands = {
  numerator?: string
  denominator?: string
  radicand?: string
  base?: string
  exponent?: string
  index?: string
}

const PLAIN_PIECE = /^[\p{L}\p{N}]+(?:[ .,][\p{L}\p{N}]+)*$/u

const requirePiece = (value: string | undefined, message: string) => {
  const piece = (value ?? '').trim()
  if (!PLAIN_PIECE.test(piece)) throw new Error(message)
  return piece
}

/** Maps the two plain toolbar fields onto the operands a button needs. */
export const operandsForButton = (button: SimpleLatexButton, first: string, second: string): SimpleLatexOperands => {
  switch (button) {
    case 'fraction': return { numerator: first, denominator: second }
    case 'sqrt': return { radicand: first }
    case 'superscript': return { base: first, exponent: second }
    case 'subscript': return { base: first, index: second }
    default: return {}
  }
}

/** One button plus plain operands becomes a math span the editor already renders. */
export function simpleLatexSnippet(button: SimpleLatexButton, operands: SimpleLatexOperands = {}): string {
  switch (button) {
    case 'fraction': {
      const message = 'Bruch braucht zwei Zahlen oder Wörter.'
      const numerator = requirePiece(operands.numerator, message)
      const denominator = requirePiece(operands.denominator, message)
      return `$\\frac{${numerator}}{${denominator}}$`
    }
    case 'sqrt': {
      const radicand = requirePiece(operands.radicand, 'Wurzel braucht eine Zahl oder ein Wort.')
      return `$\\sqrt{${radicand}}$`
    }
    case 'superscript': {
      const message = 'Hochgestellt braucht Basis und Exponent.'
      const base = requirePiece(operands.base, message)
      const exponent = requirePiece(operands.exponent, message)
      return '$' + '{' + base + '}^{' + exponent + '}$'
    }
    case 'subscript': {
      const message = 'Tiefgestellt braucht Basis und Index.'
      const base = requirePiece(operands.base, message)
      const index = requirePiece(operands.index, message)
      return '$' + '{' + base + '}_{' + index + '}$'
    }
    case 'plus': return '$+$'
    case 'minus': return '$-$'
    case 'equals': return '$=$'
    case 'pi': return '$\\pi$'
    case 'alpha': return '$\\alpha$'
    default: {
      const unknown: never = button
      throw new Error(`Unbekannte LaTeX-Schaltfläche: ${String(unknown)}`)
    }
  }
}

export function applySimpleLatexButton(
  note: string,
  button: SimpleLatexButton,
  operands: SimpleLatexOperands = {},
  cursor = note.length,
): { note: string; inserted: string } {
  const inserted = simpleLatexSnippet(button, operands)
  const at = Math.max(0, Math.min(note.length, Number.isFinite(cursor) ? cursor : note.length))
  const before = note.slice(0, at)
  const after = note.slice(at)
  const lead = before.length > 0 && !/\s$/u.test(before) ? ' ' : ''
  const trail = after.length > 0 && !/^\s/u.test(after) ? ' ' : ''
  return { note: `${before}${lead}${inserted}${trail}${after}`, inserted }
}

const MATH_SPAN = /\$\$[\s\S]*?\$\$|(?<!\$)\$(?!\$)(?:\\.|[^$\n])+?\$(?!\$)/gu

const escapeLatexText = (value: string) => value.replace(/[\\{}$%&#_^~]/gu, (character) => {
  switch (character) {
    case '\\': return '\\textbackslash{}'
    case '{': return '\\{'
    case '}': return '\\}'
    case '$': return '\\$'
    case '%': return '\\%'
    case '&': return '\\&'
    case '#': return '\\#'
    case '_': return '\\_'
    case '^': return '\\textasciicircum{}'
    case '~': return '\\textasciitilde{}'
    default: return character
  }
})

/** Keeps button-inserted math spans byte-for-byte and escapes the surrounding note text. */
export function exportNoteLatex(note: string, title = 'FaNotes'): string {
  const source = String(note ?? '')
  let body = ''
  let last = 0
  for (const match of source.matchAll(MATH_SPAN)) {
    const index = match.index ?? 0
    body += escapeLatexText(source.slice(last, index))
    body += match[0]
    last = index + match[0].length
  }
  body += escapeLatexText(source.slice(last))
  const safeTitle = escapeLatexText(title).replace(/\s+/gu, ' ').trim() || 'FaNotes'
  return `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath}
\\title{${safeTitle}}
\\begin{document}
${body}
\\end{document}
`
}

export function noteExportBaseName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return (cleaned || 'FaNotes').slice(0, 80)
}

const LINES_PER_PAGE = 46
const MAX_PDF_PAGES = 80

const WIN1252_EXTRA = new Map<number, number>([
  [0x20AC, 0x80],
  [0x201A, 0x82],
  [0x0192, 0x83],
  [0x201E, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02C6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8A],
  [0x2039, 0x8B],
  [0x0152, 0x8C],
  [0x017D, 0x8E],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201C, 0x93],
  [0x201D, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02DC, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9A],
  [0x203A, 0x9B],
  [0x0153, 0x9C],
  [0x017E, 0x9E],
  [0x0178, 0x9F],
])

const winAnsiByte = (code: number) => {
  if (code >= 32 && code <= 126) return code
  if (code >= 160 && code <= 255) return code
  return WIN1252_EXTRA.get(code) ?? 0x3F
}

const pdfLiteral = (value: string) => {
  let out = '('
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0x3F
    if (character === '\\' || character === '(' || character === ')') out += `\\${character}`
    else if (code === 10) out += '\\n'
    else if (code === 13) out += '\\r'
    else if (code < 32 || code > 126) out += `\\${winAnsiByte(code).toString(8).padStart(3, '0')}`
    else out += character
  }
  out += ')'
  return out
}

const wrapNoteLines = (note: string) => {
  const rows = note.replace(/\u0000/gu, '').replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').split('\n')
  const lines: string[] = []
  const width = 90
  for (const row of rows) {
    let rest = row
    if (rest.length <= width) {
      lines.push(rest)
      continue
    }
    while (rest.length > width) {
      let cut = rest.lastIndexOf(' ', width)
      if (cut < 1) cut = width
      lines.push(rest.slice(0, cut))
      rest = rest.slice(cut).replace(/^ /u, '')
    }
    lines.push(rest)
  }
  return lines.length > 0 ? lines : ['']
}

const pageStream = (lines: string[]) => {
  const commands = ['BT', '/F1 11 Tf', '14 TL', '50 800 Td']
  lines.forEach((line, index) => {
    if (index > 0) commands.push('T*')
    commands.push(`${pdfLiteral(line)} Tj`)
  })
  commands.push('ET')
  return commands.join('\n')
}

const encodePdf = (text: string) => {
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code > 255) throw new Error('PDF-Export hat ein Zeichen außerhalb von Latin-1 erzeugt.')
    bytes[index] = code
  }
  return bytes
}

const buildPdf = (objects: string[]) => {
  const chunks = ['%PDF-1.4\n%\xE2\xE3\xCF\xD3\n']
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(chunks.join('').length)
    chunks.push(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`)
  }
  const body = chunks.join('')
  const xrefLines = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f ']
  for (let index = 1; index <= objects.length; index += 1) {
    xrefLines.push(`${String(offsets[index]).padStart(10, '0')} 00000 n `)
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${body.length}\n%%EOF\n`
  return encodePdf(`${body}${xrefLines.join('\n')}\n${trailer}`)
}

/** Real PDF 1.4 bytes for a note. Node can call this without a window or a TeX install. */
export function exportNotePdf(note: string, title = 'FaNotes'): Uint8Array {
  const groups: string[][] = []
  const lines = wrapNoteLines(String(note ?? ''))
  for (let index = 0; index < lines.length; index += LINES_PER_PAGE) groups.push(lines.slice(index, index + LINES_PER_PAGE))
  if (groups.length > MAX_PDF_PAGES) {
    groups.length = MAX_PDF_PAGES
    groups[MAX_PDF_PAGES - 1].push('...')
  }
  const pageCount = groups.length
  const fontId = 3
  const firstPageId = 4
  const infoId = firstPageId + pageCount * 2
  const kids = groups.map((_, index) => `${firstPageId + index * 2} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]
  groups.forEach((group, index) => {
    const pageId = firstPageId + index * 2
    const stream = pageStream(group)
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`)
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })
  const safeTitle = title.replace(/\s+/gu, ' ').trim() || 'FaNotes'
  objects.push(`<< /Title ${pdfLiteral(safeTitle)} /Producer (FaNotes) /Creator (FaNotes) >>`)
  if (objects.length !== infoId) throw new Error('PDF-Export konnte die Seiten nicht nummerieren.')
  return buildPdf(objects)
}
