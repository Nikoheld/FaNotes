'use strict'

// Built-in Word renderer: a .docx package becomes one sanitized HTML document
// that Chromium prints to PDF. Covers headings, paragraph and run formatting,
// lists, tables, pictures, page breaks and the page size. Headers, footers,
// footnotes and floating-shape positions are not reproduced.
const { parseXml, child, childrenNamed, descendants } = require('./office-xml.cjs')
const { esc, hexColor, num, round, fontFamily, imageDataUrl, readRelationships, documentShell } = require('./office-html-common.cjs')

const HIGHLIGHT = { yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000' }
const ALIGN = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' }
const TRANSPARENT = new Set(['w:hyperlink', 'w:ins', 'w:smartTag', 'w:sdt', 'w:sdtContent', 'w:fldSimple', 'w:customXml', 'w:moveTo'])
const MAX_PARAGRAPHS = 60_000

const on = (node) => Boolean(node) && !['0', 'false', 'off', 'none'].includes(node.attrs['w:val'] ?? 'true')
const val = (node) => node?.attrs['w:val']
const twipsToPt = (twips) => round(num(twips) / 20)

function romanNumeral(value) {
  const table = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  let rest = value
  let out = ''
  for (const [amount, text] of table) while (rest >= amount) { out += text; rest -= amount }
  return out
}
function counterText(format, value) {
  switch (format) {
    case 'lowerLetter': return String.fromCharCode(96 + ((value - 1) % 26) + 1)
    case 'upperLetter': return String.fromCharCode(64 + ((value - 1) % 26) + 1)
    case 'lowerRoman': return romanNumeral(value)
    case 'upperRoman': return romanNumeral(value).toUpperCase()
    default: return String(value)
  }
}

function docxToHtml(zip, { title = 'Dokument' } = {}) {
  const documentXml = zip.readText('word/document.xml')
  if (!documentXml) throw new Error('Das Word-Dokument enthält keinen Text (word/document.xml fehlt).')
  const doc = parseXml(documentXml)
  const body = child(doc, 'w:body')
  if (!body) throw new Error('Das Word-Dokument ist leer oder beschädigt.')
  const rels = readRelationships(zip, parseXml, 'word/document.xml')
  const imageCache = new Map()

  // ---- styles ----
  const styles = new Map()
  let defaultRun = null
  const stylesText = zip.readText('word/styles.xml')
  if (stylesText) {
    const stylesRoot = parseXml(stylesText)
    defaultRun = child(child(child(stylesRoot, 'w:docDefaults'), 'w:rPrDefault'), 'w:rPr')
    for (const style of childrenNamed(stylesRoot, 'w:style')) {
      const id = style.attrs['w:styleId']
      if (!id) continue
      styles.set(id, { id, type: style.attrs['w:type'], name: val(child(style, 'w:name')) ?? id, basedOn: val(child(style, 'w:basedOn')), pPr: child(style, 'w:pPr'), rPr: child(style, 'w:rPr'), isDefault: style.attrs['w:default'] === '1' })
    }
  }
  const defaultParagraphStyle = [...styles.values()].find((style) => style.type === 'paragraph' && style.isDefault)
  const styleChain = (id) => {
    const chain = []
    const seen = new Set()
    let current = id ? styles.get(id) : null
    while (current && !seen.has(current.id) && chain.length < 12) {
      seen.add(current.id)
      chain.unshift(current)
      current = current.basedOn ? styles.get(current.basedOn) : null
    }
    return chain
  }
  const headingLevelOf = (style) => {
    for (const entry of styleChain(style?.id).reverse()) {
      const match = /^(?:heading|überschrift|titre|título|titolo)\s*(\d)$/iu.exec(entry.name.trim()) ?? /^heading(\d)$/iu.exec(entry.id)
      if (match) return Math.min(6, Math.max(1, Number(match[1])))
      if (/^title$|^titel$/iu.test(entry.name.trim())) return 1
    }
    return 0
  }

  // ---- numbering ----
  const abstractNums = new Map()
  const numToAbstract = new Map()
  const numberingText = zip.readText('word/numbering.xml')
  if (numberingText) {
    const numbering = parseXml(numberingText)
    for (const abstract of childrenNamed(numbering, 'w:abstractNum')) {
      const levels = new Map()
      for (const level of childrenNamed(abstract, 'w:lvl')) levels.set(num(level.attrs['w:ilvl']), level)
      abstractNums.set(abstract.attrs['w:abstractNumId'], levels)
    }
    for (const entry of childrenNamed(numbering, 'w:num')) {
      const abstractId = val(child(entry, 'w:abstractNumId'))
      if (abstractId !== undefined) numToAbstract.set(entry.attrs['w:numId'], abstractId)
    }
  }
  const counters = new Map()
  const listMarker = (numId, level) => {
    const levels = abstractNums.get(numToAbstract.get(numId))
    const definition = levels?.get(level)
    if (!definition) return { text: '•', indentPt: 18 * (level + 1) }
    const key = `${numId}`
    const state = counters.get(key) ?? []
    const start = num(val(child(definition, 'w:start')), 1)
    state.length = level + 1
    for (let index = 0; index < level; index += 1) state[index] ??= num(val(child(levels.get(index), 'w:start')), 1)
    state[level] = state[level] === undefined ? start : state[level] + 1
    counters.set(key, state)
    const format = val(child(definition, 'w:numFmt')) ?? 'decimal'
    const indentLeft = child(child(definition, 'w:pPr'), 'w:ind')?.attrs['w:left']
    const indentPt = indentLeft === undefined ? 18 * (level + 1) : twipsToPt(indentLeft)
    if (format === 'bullet') return { text: level % 2 ? '◦' : '•', indentPt }
    if (format === 'none') return { text: '', indentPt }
    const template = val(child(definition, 'w:lvlText')) ?? `%${level + 1}.`
    const text = template.replace(/%(\d)/gu, (_whole, digit) => {
      const index = Number(digit) - 1
      const levelFormat = val(child(levels.get(index), 'w:numFmt')) ?? 'decimal'
      return counterText(levelFormat, state[index] ?? 1)
    })
    return { text, indentPt }
  }

  // ---- run properties ----
  const mergeRun = (nodes) => {
    const out = {}
    for (const rPr of nodes) {
      if (!rPr) continue
      for (const [name, key] of [['w:b', 'b'], ['w:i', 'i'], ['w:strike', 'strike'], ['w:dstrike', 'strike'], ['w:smallCaps', 'smallCaps'], ['w:caps', 'caps']]) {
        const node = child(rPr, name)
        if (node) out[key] = on(node)
      }
      const underline = child(rPr, 'w:u')
      if (underline) out.u = val(underline) !== 'none'
      const fonts = child(rPr, 'w:rFonts')
      if (fonts) out.font = fonts.attrs['w:ascii'] ?? fonts.attrs['w:hAnsi'] ?? out.font
      const size = val(child(rPr, 'w:sz'))
      if (size) out.sz = num(size) / 2
      const color = val(child(rPr, 'w:color'))
      if (color) out.color = color === 'auto' ? null : hexColor(color)
      const highlight = val(child(rPr, 'w:highlight'))
      if (highlight) out.hl = HIGHLIGHT[highlight] ?? null
      const shade = child(rPr, 'w:shd')?.attrs['w:fill']
      if (shade && shade !== 'auto') out.hl = hexColor(shade) ?? out.hl
      const vert = val(child(rPr, 'w:vertAlign'))
      if (vert) out.vert = vert
    }
    return out
  }
  const runCss = (props) => {
    const css = []
    if (props.b) css.push('font-weight:700')
    if (props.i) css.push('font-style:italic')
    const decorations = [props.u ? 'underline' : '', props.strike ? 'line-through' : ''].filter(Boolean)
    if (decorations.length) css.push(`text-decoration:${decorations.join(' ')}`)
    if (props.smallCaps) css.push('font-variant:small-caps')
    if (props.caps) css.push('text-transform:uppercase')
    if (props.sz && props.sz >= 1 && props.sz <= 400) css.push(`font-size:${round(props.sz)}pt`)
    if (props.color) css.push(`color:${props.color}`)
    if (props.hl) css.push(`background:${props.hl}`)
    const family = fontFamily(props.font)
    if (family) css.push(`font-family:${family}`)
    if (props.vert === 'superscript') css.push('vertical-align:super;font-size:smaller')
    if (props.vert === 'subscript') css.push('vertical-align:sub;font-size:smaller')
    return css.join(';')
  }

  // ---- pictures ----
  const imageHtml = (drawing) => {
    const blip = descendants(drawing, 'a:blip')[0]
    const embed = blip?.attrs['r:embed']
    const target = embed ? rels.get(embed)?.target : null
    const url = target ? imageDataUrl(zip, target, imageCache) : null
    if (!url) return ''
    const extent = descendants(drawing, 'wp:extent')[0]
    const widthPt = extent ? round(num(extent.attrs.cx) / 12700) : 0
    const heightPt = extent ? round(num(extent.attrs.cy) / 12700) : 0
    if (widthPt > 0 && widthPt < 2 && heightPt < 2) return ''
    const size = widthPt > 0 && heightPt > 0 ? `width:${widthPt}pt;aspect-ratio:${widthPt}/${heightPt};` : ''
    return `<img src="${url}" alt="" style="${size}max-width:100%;height:auto;vertical-align:bottom">`
  }

  // ---- runs and paragraphs ----
  const runsToHtml = (container, paragraphRun, out) => {
    for (const node of container.children) {
      if (node.name === 'w:r') {
        const rPr = child(node, 'w:rPr')
        const props = mergeRun([...paragraphRun, ...characterStyleRuns(rPr), rPr])
        const css = runCss(props)
        let html = ''
        for (const part of node.children) {
          if (part.name === 'w:t' || part.name === 'w:delText') html += esc(part.text)
          else if (part.name === 'w:tab' || part.name === 'w:ptab') html += '<span style="display:inline-block;width:36pt"></span>'
          else if (part.name === 'w:br') html += part.attrs['w:type'] === 'page' ? '<span style="display:block;break-after:page"></span>' : '<br>'
          else if (part.name === 'w:cr') html += '<br>'
          else if (part.name === 'w:noBreakHyphen') html += '‑'
          else if (part.name === 'w:drawing') html += imageHtml(part)
          else if (part.name === 'mc:AlternateContent') {
            const choice = child(part, 'mc:Choice')
            for (const drawing of choice ? descendants(choice, 'w:drawing') : []) html += imageHtml(drawing)
          }
        }
        if (html) out.push(css ? `<span style="${css}">${html}</span>` : html)
      } else if (TRANSPARENT.has(node.name)) {
        runsToHtml(node, paragraphRun, out)
      }
    }
  }
  const characterStyleRuns = (rPr) => {
    const id = val(child(rPr, 'w:rStyle'))
    return id ? styleChain(id).map((style) => style.rPr) : []
  }

  const paragraphToHtml = (paragraph) => {
    const pPr = child(paragraph, 'w:pPr')
    const styleId = val(child(pPr, 'w:pStyle'))
    const chain = styleChain(styleId ?? defaultParagraphStyle?.id)
    const style = chain[chain.length - 1]
    const level = headingLevelOf(style)
    const pProps = [...chain.map((entry) => entry.pPr), pPr]
    const find = (name) => [...pProps].reverse().map((node) => child(node, name)).find(Boolean) ?? null
    const css = []
    const align = ALIGN[val(find('w:jc')) ?? '']
    if (align) css.push(`text-align:${align}`)
    const spacing = find('w:spacing')
    if (spacing) {
      if (spacing.attrs['w:before'] !== undefined) css.push(`margin-top:${twipsToPt(spacing.attrs['w:before'])}pt`)
      if (spacing.attrs['w:after'] !== undefined) css.push(`margin-bottom:${twipsToPt(spacing.attrs['w:after'])}pt`)
      const line = num(spacing.attrs['w:line'])
      if (line > 0 && (spacing.attrs['w:lineRule'] ?? 'auto') === 'auto') css.push(`line-height:${round(line / 240 * 1.15)}`)
    }
    const indent = find('w:ind')
    let leftPt = indent ? twipsToPt(indent.attrs['w:left'] ?? indent.attrs['w:start']) : 0
    let firstPt = indent ? (indent.attrs['w:hanging'] !== undefined ? -twipsToPt(indent.attrs['w:hanging']) : twipsToPt(indent.attrs['w:firstLine'])) : 0
    if (indent && indent.attrs['w:right'] !== undefined) css.push(`margin-right:${twipsToPt(indent.attrs['w:right'])}pt`)
    if (on(find('w:pageBreakBefore')) && child(pPr, 'w:pageBreakBefore')) css.push('break-before:page')
    if (on(find('w:keepNext'))) css.push('break-after:avoid')
    let marker = ''
    const numPr = find('w:numPr')
    const numId = val(child(numPr, 'w:numId'))
    if (numId && numId !== '0') {
      const result = listMarker(numId, num(val(child(numPr, 'w:ilvl'))))
      if (!indent) { leftPt = result.indentPt; firstPt = -18 }
      if (result.text) marker = `<span style="display:inline-block;min-width:${Math.max(12, -firstPt)}pt;text-indent:0">${esc(result.text)}</span>`
    }
    if (leftPt) css.push(`margin-left:${leftPt}pt`)
    if (firstPt) css.push(`text-indent:${firstPt}pt`)
    const base = mergeRun([defaultRun, ...chain.map((entry) => entry.rPr), child(pPr, 'w:rPr')])
    const inner = []
    runsToHtml(paragraph, [defaultRun, ...chain.map((entry) => entry.rPr)].filter(Boolean), inner)
    const content = inner.join('')
    const tag = level ? `h${level}` : 'p'
    const defaults = level ? `font-weight:700;${base.sz ? '' : `font-size:${[0, 20, 16, 14, 13, 12, 11][level]}pt;`}` : ''
    css.unshift(defaults.replace(/;$/u, ''))
    if (base.sz && !level) css.push(`font-size:${round(base.sz)}pt`)
    if (level && base.sz) css.push(`font-size:${round(base.sz)}pt`)
    if (base.color && !level) css.push(`color:${base.color}`)
    const family = fontFamily(base.font)
    if (family) css.push(`font-family:${family}`)
    const attributes = css.filter(Boolean).join(';')
    return `<${tag}${attributes ? ` style="${attributes}"` : ''}>${marker}${content || (marker ? '' : '<br>')}</${tag}>`
  }

  // ---- tables ----
  const tableToHtml = (table) => {
    const props = child(table, 'w:tblPr')
    const bordered = Boolean(child(props, 'w:tblBorders')) && !['nil', 'none'].includes(val(child(child(props, 'w:tblBorders'), 'w:top')) ?? 'single')
    const grid = childrenNamed(child(table, 'w:tblGrid'), 'w:gridCol').map((col) => num(col.attrs['w:w']))
    const gridTotal = grid.reduce((sum, width) => sum + width, 0)
    const rows = childrenNamed(table, 'w:tr')
    const matrix = rows.map((row) => {
      let column = 0
      return childrenNamed(row, 'w:tc').map((cell) => {
        const tcPr = child(cell, 'w:tcPr')
        const span = Math.max(1, num(val(child(tcPr, 'w:gridSpan')), 1))
        const merge = child(tcPr, 'w:vMerge')
        const entry = { cell, tcPr, span, column, vMerge: merge ? (val(merge) === 'restart' ? 'restart' : 'continue') : null, rowSpan: 1 }
        column += span
        return entry
      })
    })
    matrix.forEach((cells, rowIndex) => {
      for (const entry of cells) {
        if (entry.vMerge !== 'restart') continue
        for (let next = rowIndex + 1; next < matrix.length; next += 1) {
          const below = matrix[next].find((candidate) => candidate.column === entry.column)
          if (!below || below.vMerge !== 'continue') break
          entry.rowSpan += 1
        }
      }
    })
    let html = `<table style="border-collapse:collapse;width:100%;table-layout:fixed;margin:0 0 8pt">`
    if (gridTotal > 0) html += `<colgroup>${grid.map((width) => `<col style="width:${round(width / gridTotal * 100, 2)}%">`).join('')}</colgroup>`
    matrix.forEach((cells) => {
      html += '<tr>'
      for (const entry of cells) {
        if (entry.vMerge === 'continue') continue
        const fill = hexColor(child(entry.tcPr, 'w:shd')?.attrs['w:fill'])
        const inner = []
        for (const part of entry.cell.children) {
          if (part.name === 'w:p') inner.push(paragraphToHtml(part))
          else if (part.name === 'w:tbl') inner.push(tableToHtml(part))
        }
        const css = [`padding:2pt 4pt`, 'vertical-align:top', 'overflow-wrap:anywhere', bordered ? 'border:0.5pt solid #000' : '', fill ? `background:${fill}` : ''].filter(Boolean).join(';')
        html += `<td${entry.span > 1 ? ` colspan="${entry.span}"` : ''}${entry.rowSpan > 1 ? ` rowspan="${entry.rowSpan}"` : ''} style="${css}">${inner.join('') || '<p><br></p>'}</td>`
      }
      html += '</tr>'
    })
    return `${html}</table>`
  }

  let count = 0
  const blocks = []
  for (const node of body.children) {
    count += 1
    if (count > MAX_PARAGRAPHS) break
    if (node.name === 'w:p') blocks.push(paragraphToHtml(node))
    else if (node.name === 'w:tbl') blocks.push(tableToHtml(node))
    else if (node.name === 'w:sdt') {
      for (const inner of child(node, 'w:sdtContent')?.children ?? []) {
        if (inner.name === 'w:p') blocks.push(paragraphToHtml(inner))
        else if (inner.name === 'w:tbl') blocks.push(tableToHtml(inner))
      }
    }
  }

  // ---- page setup ----
  const section = childrenNamed(body, 'w:sectPr').pop()
  const pageSize = child(section, 'w:pgSz')
  const margins = child(section, 'w:pgMar')
  const mmOf = (twips) => round(num(twips) / 1440 * 25.4, 1)
  let widthMm = 210
  let heightMm = 297
  if (pageSize) {
    const w = mmOf(pageSize.attrs['w:w'])
    const h = mmOf(pageSize.attrs['w:h'])
    if (w >= 50 && w <= 1200 && h >= 50 && h <= 1200) { widthMm = w; heightMm = h }
  }
  const margin = (name, fallback) => {
    const value = margins ? mmOf(margins.attrs[name]) : fallback
    return value >= 0 && value <= 100 ? value : fallback
  }
  const pageMargin = `${margin('w:top', 20)}mm ${margin('w:right', 20)}mm ${margin('w:bottom', 20)}mm ${margin('w:left', 20)}mm`
  const baseFont = mergeRun([defaultRun])
  const css = `@page{size:${widthMm}mm ${heightMm}mm;margin:${pageMargin}}
html,body{margin:0;padding:0;background:#fff}
body{font-family:${fontFamily(baseFont.font) ?? 'Carlito, Calibri, "Liberation Sans", Arial, sans-serif'};font-size:${baseFont.sz ?? 11}pt;line-height:1.2;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
p,h1,h2,h3,h4,h5,h6{margin:0 0 8pt;overflow-wrap:anywhere}
h1,h2,h3,h4,h5,h6{break-after:avoid}
img{max-width:100%}
td p{margin-bottom:0}`
  return { html: documentShell({ title, css, body: blocks.join('\n') }), paragraphs: blocks.length, pageSize: { widthMm, heightMm } }
}

module.exports = { docxToHtml }
