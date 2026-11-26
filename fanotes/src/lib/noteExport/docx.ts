// Note Markdown -> DOCX. The Markdown is parsed to an mdast tree (CommonMark, GFM tables, task lists,
// strikethrough, `$ math $`) and written as raw OOXML zipped with JSZip: real Word heading styles,
// numbering.xml lists, tables, hyperlinks, embedded pictures and OMML equations.
import JSZip from 'jszip'
import type { Root, RootContent, PhrasingContent, TableRow, List, ListItem } from 'mdast'
import { collectImageSources, parseNoteMarkdown } from './ast'
import { latexToOmml, latexToOmmlPara, M_NS } from './omml'
import { parseSheetAlt } from './worksheetExport'
import { prepareNoteMarkdown, resolveNoteImages } from './prepare'
import { MARGINS_MM, PAGE_SIZES_MM, type NoteExportInput, type NoteExportOptions, type NoteImageData } from './types'

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const twips = (mm: number) => Math.round(mm * 1440 / 25.4)
const EMU_PER_TWIP = 635

// XML 1.0 has no room for most control characters or lone surrogates.
const cleanText = (value: string) => value
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/gu, '')
  .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, '�')
const esc = (value: string) => cleanText(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')

type Marks = { b?: boolean; i?: boolean; s?: boolean; code?: boolean; link?: boolean; sup?: boolean }

type Ctx = {
  source: string
  images: Map<string, NoteImageData>
  media: Map<string, { name: string; bytes: Uint8Array; rel: string }>
  relationships: Array<{ id: string; type: string; target: string; external?: boolean }>
  links: Map<string, string>
  numbering: string[]
  nextNumId: number
  drawingId: number
  footnotes: Map<string, RootContent[]>
  contentTwips: number
  maxHeightTwips: number
}

type ParaOptions = {
  style?: string
  numId?: number
  ilvl?: number
  indentLeft?: number
  hanging?: number
  jc?: 'center' | 'right' | 'left'
  keepNext?: boolean
  keepLines?: boolean
  spacingAfter?: number
  border?: 'bottom'
}

const pPr = (o: ParaOptions) => {
  const parts = [
    o.style ? `<w:pStyle w:val="${o.style}"/>` : '',
    o.keepNext ? '<w:keepNext/>' : '',
    o.keepLines ? '<w:keepLines/>' : '',
    o.numId ? `<w:numPr><w:ilvl w:val="${o.ilvl ?? 0}"/><w:numId w:val="${o.numId}"/></w:numPr>` : '',
    o.border === 'bottom' ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="AAAAAA"/></w:pBdr>' : '',
    o.spacingAfter !== undefined ? `<w:spacing w:after="${o.spacingAfter}"/>` : '',
    o.indentLeft !== undefined ? `<w:ind w:left="${o.indentLeft}"${o.hanging ? ` w:hanging="${o.hanging}"` : ''}/>` : '',
    o.jc ? `<w:jc w:val="${o.jc}"/>` : '',
  ].join('')
  return parts ? `<w:pPr>${parts}</w:pPr>` : ''
}

const rPr = (marks: Marks, extra = '') => {
  const parts = [
    marks.link ? '<w:rStyle w:val="Hyperlink"/>' : marks.code ? '<w:rStyle w:val="CodeChar"/>' : '',
    marks.b ? '<w:b/><w:bCs/>' : '',
    marks.i ? '<w:i/><w:iCs/>' : '',
    marks.s ? '<w:strike/>' : '',
    extra,
    marks.sup ? '<w:vertAlign w:val="superscript"/>' : '',
  ].join('')
  return parts ? `<w:rPr>${parts}</w:rPr>` : ''
}

const textRuns = (text: string, marks: Marks) => {
  // Tabs and line breaks need their own elements in OOXML.
  const pieces = cleanText(text).split(/(\t|\r?\n)/u)
  return pieces.map((piece) => {
    if (!piece) return ''
    if (piece === '\t') return `<w:r>${rPr(marks)}<w:tab/></w:r>`
    if (piece === '\n' || piece === '\r\n') return `<w:r>${rPr(marks)}<w:br/></w:r>`
    return `<w:r>${rPr(marks)}<w:t xml:space="preserve">${esc(piece)}</w:t></w:r>`
  }).join('')
}

const plainText = (node: RootContent | Root | PhrasingContent): string => {
  if ('value' in node && typeof node.value === 'string') return node.value
  if ('alt' in node && typeof node.alt === 'string' && node.type === 'image') return node.alt
  if ('children' in node) return (node.children as RootContent[]).map(plainText).join('')
  return ''
}

const addRelationship = (ctx: Ctx, type: string, target: string, external = false) => {
  const id = `rId${100 + ctx.relationships.length}`
  ctx.relationships.push({ id, type: `${REL}/${type}`, target, external })
  return id
}

const imageXml = (ctx: Ctx, source: string, alt: string, maxWidthTwips: number) => {
  const image = ctx.images.get(source)
  const sheet = parseSheetAlt(alt)
  if (!image) return sheet ? '' : textRuns(alt ? `[${alt}]` : '[Bild]', { i: true })
  let media = ctx.media.get(source)
  if (!media) {
    const extension = image.mime === 'image/jpeg' ? 'jpeg' : image.mime.split('/')[1]
    const name = `image${ctx.media.size + 1}.${extension}`
    media = { name, bytes: image.bytes, rel: addRelationship(ctx, 'image', `media/${name}`) }
    ctx.media.set(source, media)
  }
  // Pixels at 96 dpi -> EMU, scaled down to the page width (and a page height).
  let widthTwips = Math.max(1, image.width) * 15
  let heightTwips = Math.max(1, image.height) * 15
  // A picture of the sheet keeps its share of the text width (a pasted picture may be wider than its pixels).
  const scale = sheet
    ? Math.min(sheet.width * maxWidthTwips / widthTwips, ctx.maxHeightTwips / heightTwips)
    : Math.min(1, maxWidthTwips / widthTwips, ctx.maxHeightTwips / heightTwips)
  widthTwips *= scale
  heightTwips *= scale
  const cx = Math.max(1, Math.round(widthTwips * EMU_PER_TWIP))
  const cy = Math.max(1, Math.round(heightTwips * EMU_PER_TWIP))
  ctx.drawingId += 1
  const id = ctx.drawingId
  const name = esc(media.name)
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="${name}" descr="${esc(alt)}"/>`
    + '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
    + `<a:graphic><a:graphicData uri="${PIC_NS}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}" descr="${esc(alt)}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${media.rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
}

const isSafeLink = (url: string) => /^(?:https?:\/\/|mailto:)/iu.test(url.trim())

function inlines(nodes: PhrasingContent[], ctx: Ctx, marks: Marks, maxWidth: number): string {
  return nodes.map((node) => inline(node, ctx, marks, maxWidth)).join('')
}

function inline(node: PhrasingContent, ctx: Ctx, marks: Marks, maxWidth: number): string {
  switch (node.type) {
    case 'text': return textRuns(node.value.replace(/\n/gu, ' '), marks)
    case 'strong': return inlines(node.children, ctx, { ...marks, b: true }, maxWidth)
    case 'emphasis': return inlines(node.children, ctx, { ...marks, i: true }, maxWidth)
    case 'delete': return inlines(node.children, ctx, { ...marks, s: true }, maxWidth)
    case 'inlineCode': return textRuns(node.value, { ...marks, code: true })
    case 'break': return '<w:r><w:br/></w:r>'
    case 'inlineMath': return latexToOmml(node.value)
    case 'image': return imageXml(ctx, node.url, node.alt ?? '', maxWidth)
    case 'link': {
      if (!isSafeLink(node.url)) return inlines(node.children, ctx, marks, maxWidth)
      let id = ctx.links.get(node.url)
      if (!id) {
        id = addRelationship(ctx, 'hyperlink', node.url, true)
        ctx.links.set(node.url, id)
      }
      return `<w:hyperlink r:id="${id}" w:history="1">${inlines(node.children, ctx, { ...marks, link: true }, maxWidth)}</w:hyperlink>`
    }
    case 'linkReference': return inlines(node.children, ctx, marks, maxWidth)
    case 'footnoteReference': return textRuns(`[${node.identifier}]`, { ...marks, sup: true })
    case 'html': {
      if (/^<br\s*\/?>$/iu.test(node.value.trim())) return '<w:r><w:br/></w:r>'
      return ''
    }
    case 'imageReference': return textRuns(node.alt ?? '', marks)
    default: return ''
  }
}

type BlockState = { quote: number; maxWidth: number }

const paragraphXml = (content: string, o: ParaOptions) => `<w:p>${pPr(o)}${content}</w:p>`

function blocks(nodes: RootContent[], ctx: Ctx, state: BlockState, base: ParaOptions = {}): string[] {
  const out: string[] = []
  for (const node of nodes) out.push(...block(node, ctx, state, base))
  return out
}

const quoteOptions = (state: BlockState, base: ParaOptions): ParaOptions => (
  state.quote ? { style: 'Quote', ...(state.quote > 1 ? { indentLeft: 360 * state.quote } : {}), ...base } : base
)

function block(node: RootContent, ctx: Ctx, state: BlockState, base: ParaOptions): string[] {
  switch (node.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, node.depth))
      return [paragraphXml(inlines(node.children, ctx, {}, state.maxWidth), { ...base, style: `Heading${level}` })]
    }
    case 'paragraph': {
      const only = node.children.length === 1 ? node.children[0] : null
      // `$$ ... $$` on one line is parsed as inline math, but it means a display equation.
      if (only?.type === 'inlineMath' && only.position && ctx.source.startsWith('$$', only.position.start.offset ?? -1)) {
        return [paragraphXml(latexToOmmlPara(only.value), { ...quoteOptions(state, base), jc: 'center' })]
      }
      const alone = only?.type === 'image'
      // A picture placed on the sheet sits at its share of the text width instead of the centre.
      const sheet = only?.type === 'image' ? parseSheetAlt(only.alt ?? '') : null
      const sheetIndent = sheet ? Math.round(sheet.x * state.maxWidth) : 0
      const quoted = quoteOptions(state, base)
      return [paragraphXml(inlines(node.children, ctx, {}, state.maxWidth), sheet
        ? { ...quoted, indentLeft: (quoted.indentLeft ?? 0) + sheetIndent }
        : { ...quoted, ...(alone ? { jc: 'center' as const } : {}) })]
    }
    case 'math': return [paragraphXml(latexToOmmlPara(node.value), { ...quoteOptions(state, base), jc: 'center' })]
    case 'code': {
      const lines = cleanText(node.value).replace(/\s+$/u, '')
      return [paragraphXml(textRuns(lines || ' ', {}), { style: 'CodeBlock', ...(state.quote ? { indentLeft: 360 * state.quote } : {}) })]
    }
    case 'blockquote': return blocks(node.children, ctx, { ...state, quote: state.quote + 1 }, base)
    case 'thematicBreak': return [paragraphXml('', { border: 'bottom', spacingAfter: 160 })]
    case 'list': return listBlocks(node, ctx, state, 0)
    case 'table': return tableBlocks(node, ctx, state)
    case 'html': {
      const text = node.value.replace(/<!--[\s\S]*?-->/gu, '').replace(/<[^>]+>/gu, '').trim()
      return text ? [paragraphXml(textRuns(text, {}), quoteOptions(state, base))] : []
    }
    case 'footnoteDefinition': ctx.footnotes.set(node.identifier, node.children); return []
    case 'definition': case 'yaml': return []
    default: {
      const text = plainText(node).trim()
      return text ? [paragraphXml(textRuns(text, {}), quoteOptions(state, base))] : []
    }
  }
}

function listBlocks(list: List, ctx: Ctx, state: BlockState, level: number): string[] {
  const out: string[] = []
  const ilvl = Math.min(level, 8)
  let numId: number
  if (list.ordered) {
    numId = ctx.nextNumId
    ctx.nextNumId += 1
    ctx.numbering.push(`<w:num w:numId="${numId}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${list.start ?? 1}"/></w:lvlOverride></w:num>`)
  } else numId = 1
  for (const item of list.children as ListItem[]) {
    const task = item.checked === true || item.checked === false
    const marker = task ? `${item.checked ? '☑' : '☐'} ` : ''
    // Task items carry their box as text, so they get the list indent without a bullet.
    const options: ParaOptions = task
      ? { style: 'ListParagraph', indentLeft: 720 + 360 * ilvl, hanging: 360 }
      : { style: 'ListParagraph', numId, ilvl }
    let first = true
    for (const child of item.children) {
      if (child.type === 'list') { out.push(...listBlocks(child, ctx, state, level + 1)); continue }
      if (child.type === 'paragraph') {
        const content = (task && first ? textRuns(marker, {}) : '') + inlines(child.children, ctx, {}, state.maxWidth)
        out.push(paragraphXml(content, first ? options : { style: 'ListParagraph', indentLeft: 720 + 360 * ilvl }))
      } else {
        if (first) out.push(paragraphXml(task ? textRuns(marker, {}) : '', options))
        out.push(...block(child, ctx, state, { indentLeft: 720 + 360 * ilvl }))
      }
      first = false
    }
    if (first) out.push(paragraphXml(task ? textRuns(marker, {}) : '', options))
  }
  return out
}

const BORDER = '<w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="999999"/>'

function tableBlocks(table: Extract<RootContent, { type: 'table' }>, ctx: Ctx, state: BlockState): string[] {
  const columns = Math.max(1, ...table.children.map((row) => row.children.length))
  const available = state.maxWidth - 200
  const cellWidth = Math.floor(available / columns)
  const cellImageWidth = Math.max(600, cellWidth - 200)
  const rows = table.children.map((row: TableRow, rowIndex) => {
    const header = rowIndex === 0
    const cells = Array.from({ length: columns }, (_, column) => {
      const cell = row.children[column]
      const align = table.align?.[column]
      const jc = align === 'center' ? 'center' : align === 'right' ? 'right' : undefined
      const content = cell ? inlines(cell.children as PhrasingContent[], ctx, header ? { b: true } : {}, cellImageWidth) : ''
      return `<w:tc><w:tcPr><w:tcW w:w="${cellWidth}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>' : ''}</w:tcPr>`
        + `<w:p><w:pPr><w:pStyle w:val="TableText"/>${jc ? `<w:jc w:val="${jc}"/>` : ''}</w:pPr>${content}</w:p></w:tc>`
    }).join('')
    return `<w:tr><w:trPr><w:cantSplit/>${header ? '<w:tblHeader/>' : ''}</w:trPr>${cells}</w:tr>`
  }).join('')
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${cellWidth}"/>`).join('')
  return [
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${cellWidth * columns}" w:type="dxa"/><w:tblBorders>${BORDER}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`,
    // Word needs a paragraph after a table, and it keeps the next block from touching it.
    '<w:p><w:pPr><w:spacing w:after="0" w:line="120" w:lineRule="exact"/></w:pPr></w:p>',
  ]
}

const headingStyle = (level: number, size: number, before: number, after: number) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="${after}"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:b/><w:bCs/><w:color w:val="${level === 6 ? '555555' : '1F2937'}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`

const stylesXml = () => `${XML_HEAD}<w:styles xmlns:w="${W_NS}" xmlns:r="${R_NS}">`
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>'
  + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
  + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>'
  + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
  + '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="BBBBBB"/></w:pBdr><w:spacing w:before="0" w:after="240"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="111111"/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>'
  + headingStyle(1, 40, 360, 120) + headingStyle(2, 32, 300, 100) + headingStyle(3, 28, 260, 80) + headingStyle(4, 24, 220, 60) + headingStyle(5, 22, 200, 60) + headingStyle(6, 22, 200, 60)
  + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/></w:pPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="B8B8B8"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:color w:val="444444"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:customStyle="1" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepLines/><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="DDDDDD"/><w:left w:val="single" w:sz="4" w:space="4" w:color="DDDDDD"/><w:bottom w:val="single" w:sz="4" w:space="4" w:color="DDDDDD"/><w:right w:val="single" w:sz="4" w:space="4" w:color="DDDDDD"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/><w:spacing w:before="60" w:after="160" w:line="252" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:customStyle="1" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="0" w:line="252" w:lineRule="auto"/></w:pPr></w:style>'
  + '<w:style w:type="character" w:customStyle="1" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:uiPriority w:val="1"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="F0F0F0"/></w:rPr></w:style>'
  + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>'
  + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>' + BORDER + '</w:tblBorders></w:tblPr></w:style>'
  + '</w:styles>'

const bulletChars = ['•', '◦', '▪']
const orderedFormats = ['decimal', 'lowerLetter', 'lowerRoman']

const numberingXml = (instances: string[]) => {
  const levels = (kind: 'bullet' | 'ordered') => Array.from({ length: 9 }, (_, level) => {
    const left = 720 + 360 * level
    const format = kind === 'bullet' ? 'bullet' : orderedFormats[level % 3]
    const text = kind === 'bullet' ? bulletChars[level % 3] : `%${level + 1}.`
    const font = kind === 'bullet' ? '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:hint="default"/></w:rPr>' : ''
    return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr>${font}</w:lvl>`
  }).join('')
  return `${XML_HEAD}<w:numbering xmlns:w="${W_NS}">`
    + `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels('bullet')}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels('ordered')}</w:abstractNum>`
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    + `${instances.join('')}</w:numbering>`
}

/** Builds the .docx of a note. */
export async function noteToDocx(input: NoteExportInput, options: NoteExportOptions, now = new Date()): Promise<Uint8Array> {
  const markdown = prepareNoteMarkdown(input.markdown)
  const tree = parseNoteMarkdown(markdown)
  const images = await resolveNoteImages(collectImageSources(tree), input.resolveImage, input.signal)
  const page = PAGE_SIZES_MM[options.pageSize]
  const margin = twips(MARGINS_MM[options.margins])
  const pageWidth = twips(page.width)
  const pageHeight = twips(page.height)
  const contentTwips = pageWidth - 2 * margin
  const ctx: Ctx = {
    source: markdown,
    images,
    media: new Map(),
    relationships: [
      { id: 'rIdStyles', type: `${REL}/styles`, target: 'styles.xml' },
      { id: 'rIdNumbering', type: `${REL}/numbering`, target: 'numbering.xml' },
      { id: 'rIdSettings', type: `${REL}/settings`, target: 'settings.xml' },
    ],
    links: new Map(),
    numbering: [],
    nextNumId: 2,
    drawingId: 0,
    footnotes: new Map(),
    contentTwips,
    maxHeightTwips: Math.floor((pageHeight - 2 * margin) * 0.9),
  }
  const title = input.title.trim() || 'FaNotes'
  const body: string[] = []
  if (options.includeTitle) body.push(paragraphXml(textRuns(title, {}), { style: 'Title' }))
  body.push(...blocks(tree.children, ctx, { quote: 0, maxWidth: contentTwips }))
  if (ctx.footnotes.size) {
    body.push(paragraphXml('', { border: 'bottom' }))
    for (const [id, children] of ctx.footnotes) {
      const text = children.map(plainText).join(' ').trim()
      body.push(paragraphXml(textRuns(`[${id}] ${text}`, {}), {}))
    }
  }
  // A document body must not end with a table, and an empty note still needs one paragraph.
  if (!body.length || body[body.length - 1].startsWith('<w:tbl>')) body.push('<w:p/>')

  const sectPr = `<w:sectPr><w:pgSz w:w="${pageWidth}" w:h="${pageHeight}"/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="${Math.round(margin / 2)}" w:footer="${Math.round(margin / 2)}" w:gutter="0"/></w:sectPr>`
  const documentXml = `${XML_HEAD}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}" xmlns:m="${M_NS}"><w:body>${body.join('')}${sectPr}</w:body></w:document>`

  const extensions = new Set([...ctx.media.values()].map((media) => media.name.split('.').pop()!))
  const imageTypes = [...extensions].map((extension) => `<Default Extension="${extension}" ContentType="image/${extension === 'jpeg' ? 'jpeg' : extension}"/>`).join('')
  const created = now.toISOString().replace(/\.\d+Z$/u, 'Z')
  const zip = new JSZip()
  zip.file('[Content_Types].xml', `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${imageTypes}`
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>')
  zip.file('_rels/.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`)
  zip.file('word/document.xml', documentXml)
  zip.file('word/styles.xml', stylesXml())
  zip.file('word/numbering.xml', numberingXml(ctx.numbering))
  zip.file('word/settings.xml', `${XML_HEAD}<w:settings xmlns:w="${W_NS}" xmlns:m="${M_NS}"><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat><m:mathPr><m:mathFont m:val="Cambria Math"/></m:mathPr></w:settings>`)
  zip.file('word/_rels/document.xml.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${ctx.relationships.map((rel) => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${esc(rel.target)}"${rel.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`)
  for (const media of ctx.media.values()) zip.file(`word/media/${media.name}`, media.bytes)
  zip.file('docProps/core.xml', `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>FaNotes</dc:creator><cp:lastModifiedBy>FaNotes</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified></cp:coreProperties>`)
  zip.file('docProps/app.xml', `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>FaNotes</Application></Properties>`)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
}
