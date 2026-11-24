/**
 * Handwriting and PDF notes → DOCX. Every exported page is one picture that
 * fills a Word page of the same size (rendered from the vector PDF, about
 * 200 dpi); the note's text boxes follow as editable paragraphs under the
 * heading "Textfelder". Minimal OOXML, written with jszip.
 */
import JSZip from 'jszip'
import { inlineRuns } from './textLayout'
import { NOTE_EXPORT_MARGIN_POINTS } from './pagePoints'
import type { NoteExportOptions } from './types'

export type DocxInkPage = {
  png: Uint8Array
  /** Page size in PDF points. */
  widthPt: number
  heightPt: number
  /** Text boxes of this page, Markdown source. */
  fields: readonly string[]
}

export const DOCX_FIELDS_HEADING = 'Textfelder'

const xmlText = (value: string) => value
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/gu, '')
  .replace(/&/gu, '&amp;')
  .replace(/</gu, '&lt;')
  .replace(/>/gu, '&gt;')

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'

const twips = (points: number) => Math.round(points * 20)
const emu = (points: number) => Math.round(points * 12700)

const runXml = (text: string, flags: { bold?: boolean; italic?: boolean; mono?: boolean; strike?: boolean; size?: number }) => {
  const props = [
    flags.bold ? '<w:b/>' : '',
    flags.italic ? '<w:i/>' : '',
    flags.strike ? '<w:strike/>' : '',
    flags.mono ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>' : '',
    flags.size ? `<w:sz w:val="${Math.round(flags.size * 2)}"/>` : '',
  ].join('')
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`
}

/** One Markdown line as a Word paragraph: headings, lists, bold, italic, code. */
const paragraphXml = (line: string) => {
  let rest = line
  let size: number | undefined
  let prefix = ''
  let bold = false
  const heading = /^\s{0,3}(#{1,6})\s+(.*)$/u.exec(rest)
  if (heading) {
    rest = heading[2]
    bold = true
    size = [18, 15, 13, 12, 12, 12][heading[1].length - 1]
  }
  const quote = /^\s{0,3}>\s?(.*)$/u.exec(rest)
  if (quote) rest = quote[1]
  const bullet = /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/u.exec(rest)
  if (bullet) {
    prefix = bullet[1] === undefined ? '• ' : bullet[1] === ' ' ? '[ ] ' : '[x] '
    rest = bullet[2]
  } else {
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/u.exec(rest)
    if (numbered) {
      prefix = `${numbered[1]}. `
      rest = numbered[2]
    }
  }
  const runs = inlineRuns(rest, { bold })
  const indent = bullet || /^\s*\d+[.)]\s/u.test(line) ? '<w:ind w:left="360" w:hanging="360"/>' : quote ? '<w:ind w:left="360"/>' : ''
  const body = [
    prefix ? runXml(prefix, { bold, size }) : '',
    ...runs.map((run) => runXml(run.text, { bold: run.bold, italic: run.italic || Boolean(quote), mono: run.mono, strike: run.strike, size })),
  ].join('')
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="80"/>${indent}</w:pPr>${body}</w:p>`
}

const sectionProps = (widthPt: number, heightPt: number, marginPt: number) => (
  `<w:sectPr><w:pgSz w:w="${twips(widthPt)}" w:h="${twips(heightPt)}"/><w:pgMar w:top="${twips(marginPt)}" w:right="${twips(marginPt)}" w:bottom="${twips(marginPt)}" w:left="${twips(marginPt)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`
)

const imageParagraph = (pageIndex: number, page: DocxInkPage, sectPr: string) => {
  const cx = emu(page.widthPt)
  // A hair shorter than the page so Word never starts an empty page after it.
  const cy = emu(Math.max(10, page.heightPt - 2))
  const name = `page${pageIndex + 1}.png`
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>${sectPr}</w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${pageIndex + 1}" name="${name}" descr="Page ${pageIndex + 1}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${pageIndex + 1}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg${pageIndex + 1}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style></w:styles>`

export const exportInkDocx = async (
  pages: readonly DocxInkPage[],
  options: Pick<NoteExportOptions, 'margins'>,
  title: string,
): Promise<Uint8Array> => {
  if (!pages.length) throw new Error('No pages to export.')
  const margin = NOTE_EXPORT_MARGIN_POINTS[options.margins] ?? NOTE_EXPORT_MARGIN_POINTS.normal
  // Each Word section ends with its own sectPr; the final one is the body's.
  const sections: Array<{ build: (sectPr: string) => string; props: string }> = []
  pages.forEach((page, index) => {
    sections.push({
      build: (sectPr) => imageParagraph(index, page, sectPr),
      props: sectionProps(page.widthPt, page.heightPt, 0),
    })
    const texts = page.fields.filter((field) => field.trim())
    if (texts.length) {
      const body = texts.flatMap((field) => field.replace(/\r\n?/gu, '\n').split('\n').filter((line) => line.trim() !== '')).map(paragraphXml)
      sections.push({
        build: (sectPr) => `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${runXml(DOCX_FIELDS_HEADING, {})}</w:p>${body.join('')}<w:p><w:pPr><w:spacing w:before="0" w:after="0"/>${sectPr}</w:pPr></w:p>`,
        props: sectionProps(page.widthPt, page.heightPt, margin),
      })
    }
  })
  const parts = sections.map((section, index) => {
    const last = index === sections.length - 1
    return section.build(last ? '' : section.props)
  })
  const finalProps = sections[sections.length - 1].props
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${parts.join('')}${finalProps}</w:body></w:document>`

  const zip = new JSZip()
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`)
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`)
  const imageRels = pages.map((_page, index) => `<Relationship Id="rIdImg${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/page${index + 1}.png"/>`).join('')
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${imageRels}</Relationships>`)
  zip.file('word/styles.xml', STYLES)
  zip.file('word/document.xml', documentXml)
  const now = new Date().toISOString().replace(/\.\d+Z$/u, 'Z')
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(title || 'FaNotes')}</dc:title><dc:creator>FaNotes</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`)
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>FaNotes</Application><Pages>${pages.length}</Pages></Properties>`)
  pages.forEach((page, index) => zip.file(`word/media/page${index + 1}.png`, page.png, { compression: 'STORE' }))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
}
