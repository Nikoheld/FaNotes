// PDF export: every page of the manuscript layout drawn line by line, piece
// by piece, at the positions the layout computed (the same positions the
// page view uses), with the bundled fonts embedded as subsets. Kerning is
// written as TJ adjustments from fontkit's shaping, so glyphs sit where the
// screen's canvas measured them.
import { PDFDocument, PDFHexString, PDFName, PDFString, type PDFFont, type PDFPage, type PDFRef } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { isEndnoteBlock } from '../layout/endnotes'
import type { LineBox } from '../layout/linebreak'
import { fontFileFor, type FontSpec, type TextMeasurer } from '../layout/measure'
import type { ManuscriptLayout, Page } from '../layout/paginate'
import type { FontFiles } from './fonts'
import { ExportCancelled, sceneStarts, titleKind, yieldToUi, type Prepared } from './prepare'

export type PdfInput = {
  prepared: Prepared
  layout: ManuscriptLayout
  files: FontFiles
  measurer: TextMeasurer
  /** Add outline entries for scenes (parts and chapters always get one). */
  sceneBookmarks?: boolean
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  now?: Date
}

const PX = 0.75 // pt per CSS px
const TEXT = '#000000'
const HEADER_COLOR = '#73716e'
const RULE_COLOR = '#a5a4a1'
const HEADER_FONT: FontSpec = { family: 'literata', bold: false, italic: false, size: 12 }

const num = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000
  return Object.is(rounded, -0) ? '0' : String(rounded)
}
const rgb = (hex: string) => {
  const value = /^#?([0-9a-f]{6})$/iu.exec(hex)?.[1] ?? '000000'
  return [0, 2, 4].map((index) => num(parseInt(value.slice(index, index + 2), 16) / 255)).join(' ')
}

type FontkitFont = NonNullable<ReturnType<FontFiles['loaded']>>

type Embedded = {
  name: string
  pdf: PDFFont
  face: FontkitFont
  /** text → TJ operand and its natural width in em. */
  encoded: Map<string, { operand: string; em: number }>
  underline: { position: number; thickness: number }
  strike: { position: number; thickness: number }
}

class PageWriter {
  background: string[] = []
  text: string[] = []
  foreground: string[] = []
  links: Array<{ rect: number[]; url: string }> = []
  fonts = new Set<Embedded>()
  private font: Embedded | null = null
  private size = 0
  private color = ''
  private scale = 100

  constructor(private readonly height: number) {}

  y(px: number) {
    return this.height - px * PX
  }

  rect(target: string[], x: number, top: number, width: number, height: number, color: string) {
    target.push(`${rgb(color)} rg ${num(x * PX)} ${num(this.y(top + height))} ${num(width * PX)} ${num(height * PX)} re f`)
  }

  show(font: Embedded, sizePx: number, color: string, x: number, baseline: number, text: string, width?: number) {
    const encoded = encode(font, text)
    if (!encoded) return
    if (font !== this.font || sizePx !== this.size) {
      this.text.push(`/${font.name} ${num(sizePx * PX)} Tf`)
      this.font = font
      this.size = sizePx
    }
    if (color !== this.color) {
      this.text.push(`${rgb(color)} rg`)
      this.color = color
    }
    // A word the screen measured slightly differently is fitted to the measured width.
    let scale = 100
    const natural = encoded.em * sizePx
    if (width !== undefined && natural > 0) {
      const ratio = width / natural
      if (Math.abs(width - natural) > 0.05 && ratio > 0.97 && ratio < 1.03) scale = Math.round(ratio * 10000) / 100
    }
    if (scale !== this.scale) {
      this.text.push(`${num(scale)} Tz`)
      this.scale = scale
    }
    this.text.push(`1 0 0 1 ${num(x * PX)} ${num(this.y(baseline))} Tm ${encoded.operand} TJ`)
    this.fonts.add(font)
  }

  content() {
    const parts = []
    if (this.background.length) parts.push('q', ...this.background, 'Q')
    if (this.text.length) parts.push('BT', ...this.text, 'ET')
    if (this.foreground.length) parts.push('q', ...this.foreground, 'Q')
    return parts.join('\n')
  }
}

const encode = (font: Embedded, text: string) => {
  const cached = font.encoded.get(text)
  if (cached) return cached
  const hex = font.pdf.encodeText(text).toString().slice(1, -1)
  if (!hex) return null
  const run = font.face.layout(text)
  const scale = 1000 / font.face.unitsPerEm
  let operand = '['
  let em = 0
  if (hex.length === run.glyphs.length * 4) {
    let pending = ''
    run.glyphs.forEach((glyph, index) => {
      pending += hex.slice(index * 4, index * 4 + 4)
      const advance = run.positions[index].xAdvance
      em += advance
      const adjust = Math.round((glyph.advanceWidth - advance) * scale * 100) / 100
      if (adjust !== 0 && index < run.glyphs.length - 1) {
        operand += `<${pending}>${num(adjust)}`
        pending = ''
      }
    })
    if (pending) operand += `<${pending}>`
  } else {
    // Glyph sequences differ (should not happen): draw without kerning.
    operand += `<${hex}>`
    em = run.glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0)
  }
  const value = { operand: `${operand}]`, em: em / font.face.unitsPerEm }
  if (font.encoded.size < 300_000) font.encoded.set(text, value)
  return value
}

/** Font files a layout draws with. */
const filesUsed = (layout: ManuscriptLayout) => {
  const files = new Set<string>([fontFileFor(HEADER_FONT)])
  const addLine = (box: LineBox) => {
    // Hanging spaces and breaks are not drawn, so their fonts are not needed.
    for (const piece of box.pieces) if (piece.kind !== 'newline' && !piece.hang) files.add(fontFileFor(piece.font))
  }
  for (const paragraph of layout.layouts) {
    paragraph.lines.forEach(addLine)
    if (paragraph.dropCap) files.add(fontFileFor(paragraph.dropCap.font))
  }
  for (const page of layout.pages) for (const note of page.footnotes) note.layout.lines.forEach(addLine)
  return files
}

export const writePdf = async (input: PdfInput): Promise<Uint8Array> => {
  const { prepared, layout, files, measurer } = input
  const manifest = prepared.manifest
  const document = await PDFDocument.create({ updateMetadata: false })
  document.registerFontkit(fontkit)
  const now = input.now ?? new Date()
  document.setTitle(manifest.title, { showInWindowTitleBar: true })
  if (manifest.author) document.setAuthor(manifest.author)
  if (manifest.subtitle) document.setSubject(manifest.subtitle)
  document.setLanguage(manifest.language)
  document.setCreator('FaNotes')
  document.setProducer('FaNotes writing mode (pdf-lib)')
  document.setCreationDate(now)
  document.setModificationDate(now)

  const embedded = new Map<string, Embedded>()
  let fontIndex = 0
  for (const file of filesUsed(layout)) {
    const face = await files.font(file)
    const pdf = await document.embedFont(await files.load(file), { subset: true })
    const os2 = (face as unknown as { 'OS/2'?: { yStrikeoutPosition?: number; yStrikeoutSize?: number } })['OS/2']
    fontIndex += 1
    embedded.set(file, {
      name: `F${fontIndex}`,
      pdf,
      face,
      encoded: new Map(),
      underline: { position: face.underlinePosition / face.unitsPerEm, thickness: Math.max(face.underlineThickness, 20) / face.unitsPerEm },
      strike: { position: (os2?.yStrikeoutPosition || face.unitsPerEm * 0.3) / face.unitsPerEm, thickness: Math.max(os2?.yStrikeoutSize || face.underlineThickness, 20) / face.unitsPerEm },
    })
  }
  const fontFor = (font: FontSpec) => embedded.get(fontFileFor(font))!

  const widthPt = layout.pageWidth * PX
  const heightPt = layout.pageHeight * PX

  const drawLine = (writer: PageWriter, box: LineBox, x0: number, top: number, color: string) => {
    let link: { url: string; left: number; right: number } | null = null
    const flushLink = () => {
      if (link) writer.links.push({ rect: [link.left * PX, writer.y(top + box.height), link.right * PX, writer.y(top)], url: link.url })
      link = null
    }
    for (const piece of box.pieces) {
      if (piece.kind === 'newline' || piece.hang) continue
      const x = x0 + piece.x
      const marks = piece.marks
      const font = fontFor(piece.font)
      const baseline = top + box.baseline - piece.shift
      const hyphenWidth = piece.hyphen ? measurer.width('-', piece.font) : 0
      const width = piece.width + hyphenWidth
      if (marks?.hl) {
        const metrics = measurer.metrics(piece.font)
        const own = (box.height - (metrics.ascent + metrics.descent)) / 2 + metrics.ascent
        writer.rect(writer.background, x, top + box.baseline - own - piece.shift, width, box.height, marks.hl)
      }
      const pieceColor = marks?.color ?? color
      // One space glyph per typed space, so the text a viewer extracts is the text of the story.
      if (piece.kind === 'space') writer.show(font, piece.font.size, pieceColor, x, baseline, ' '.repeat(Math.max(1, piece.to - piece.from)))
      else if (piece.display) writer.show(font, piece.font.size, pieceColor, x, baseline, piece.display, piece.kind === 'word' ? piece.width : undefined)
      if (piece.hyphen) writer.show(font, piece.font.size, pieceColor, x + piece.width, baseline, '-')
      if (marks?.u || marks?.link) {
        const thickness = font.underline.thickness * piece.font.size
        writer.rect(writer.foreground, x, baseline - font.underline.position * piece.font.size - thickness / 2, width, thickness, pieceColor)
      }
      if (marks?.s) {
        const thickness = font.strike.thickness * piece.font.size
        writer.rect(writer.foreground, x, baseline - font.strike.position * piece.font.size - thickness / 2, width, thickness, pieceColor)
      }
      if (marks?.link) {
        if (link && link.url === marks.link) link.right = x + width
        else {
          flushLink()
          link = { url: marks.link, left: x, right: x + width }
        }
      } else flushLink()
    }
    flushLink()
  }

  const headerFont = fontFor(HEADER_FONT)
  const drawHeaderFooter = (writer: PageWriter, parts: Page['header'], top: number, page: Page) => {
    if (!parts) return
    const baseline = top + measurer.metrics(HEADER_FONT).ascent
    const { x, width } = page.content
    if (parts.left) writer.show(headerFont, HEADER_FONT.size, HEADER_COLOR, x, baseline, parts.left)
    if (parts.center) writer.show(headerFont, HEADER_FONT.size, HEADER_COLOR, x + (width - measurer.width(parts.center, HEADER_FONT)) / 2, baseline, parts.center)
    if (parts.right) writer.show(headerFont, HEADER_FONT.size, HEADER_COLOR, x + width - measurer.width(parts.right, HEADER_FONT), baseline, parts.right)
  }

  const pages: PDFPage[] = []
  for (const [index, page] of layout.pages.entries()) {
    if (input.signal?.aborted) throw new ExportCancelled()
    const pdfPage = document.addPage([widthPt, heightPt])
    pages.push(pdfPage)
    const writer = new PageWriter(heightPt)
    if (!page.blank) {
      drawHeaderFooter(writer, page.header, Math.max(4, page.content.y - 34), page)
      for (const placed of page.lines) {
        const paragraph = layout.layouts[placed.blockIndex]
        drawLine(writer, paragraph.lines[placed.lineIndex], placed.x, placed.y, paragraph.style.color ?? TEXT)
      }
      for (const drop of page.dropCaps) {
        const paragraph = layout.layouts[drop.blockIndex]
        const cap = paragraph.dropCap!
        writer.show(fontFor(cap.font), cap.font.size, paragraph.style.color ?? TEXT, drop.x, drop.y + cap.baseline, cap.text)
      }
      if (page.footnotes.length) {
        writer.rect(writer.background, page.content.x, page.footnotes[0].y - 6, page.content.width * 0.3, 1, RULE_COLOR)
        for (const note of page.footnotes) {
          let y = note.y
          for (const box of note.layout.lines) {
            drawLine(writer, box, page.content.x + box.x, y, TEXT)
            y += box.height
          }
        }
      }
      drawHeaderFooter(writer, page.footer, page.content.y + page.content.height + 14, page)
    }
    for (const font of writer.fonts) pdfPage.node.setFontDictionary(PDFName.of(font.name), font.pdf.ref)
    const content = writer.content()
    if (content) pdfPage.node.set(PDFName.of('Contents'), document.context.register(document.context.flateStream(content)))
    if (writer.links.length) {
      const annotations = writer.links.map((link) => document.context.register(document.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: link.rect.map((value) => Math.round(value * 100) / 100),
        Border: [0, 0, 0],
        A: { Type: 'Action', S: 'URI', URI: PDFString.of(link.url) },
      })))
      pdfPage.node.set(PDFName.of('Annots'), document.context.obj(annotations))
    }
    if (index % 16 === 15) {
      input.onProgress?.((index + 1) / layout.pages.length * 0.9)
      await yieldToUi()
    }
  }

  addOutline(document, pages, input, heightPt)
  if (manifest.page.pageNumberStart >= 1) {
    document.catalog.set(PDFName.of('PageLabels'), document.context.obj({ Nums: [0, { S: 'D', St: manifest.page.pageNumberStart }] }))
  }
  document.catalog.set(PDFName.of('ViewerPreferences'), document.context.obj({ DisplayDocTitle: true }))
  input.onProgress?.(0.92)
  const bytes = await document.save({ useObjectStreams: true })
  input.onProgress?.(1)
  return bytes
}

type OutlineItem = { title: string; page: number; top: number; children: OutlineItem[] }

/** Bookmarks for parts, chapters, scenes and the notes. */
export const outlineOf = (prepared: Prepared, layout: ManuscriptLayout, scenes: boolean): OutlineItem[] => {
  const top = (blockIndex: number) => {
    const pageIndex = layout.blockPages[blockIndex] ?? 0
    const line = layout.pages[pageIndex]?.lines.find((placed) => placed.blockIndex === blockIndex)
    return { page: pageIndex, top: line ? line.y : 0 }
  }
  const items: OutlineItem[] = []
  let part: OutlineItem | null = null
  let chapter: OutlineItem | null = null
  const starts = scenes ? sceneStarts({ ...prepared, flow: layout.blocks }) : new Map()
  layout.blocks.forEach((block, index) => {
    const kind = titleKind(prepared, block)
    if (kind) {
      const item = { title: prepared.nodes.get((block.ref as { nodeId: string }).nodeId)?.title || block.chapterTitle || '…', ...top(index), children: [] }
      if (kind === 'part') {
        items.push(item)
        part = item
        chapter = null
      } else {
        ;((part as OutlineItem | null)?.children ?? items).push(item)
        chapter = item
      }
      return
    }
    if (isEndnoteBlock(block) && block.chapterStart) {
      items.push({ title: block.runs[0]?.text ?? '', ...top(index), children: [] })
      part = null
      chapter = null
      return
    }
    const scene = starts.get(index)
    if (scene && scene.title) ((chapter as OutlineItem | null)?.children ?? (part as OutlineItem | null)?.children ?? items).push({ title: scene.title, ...top(index), children: [] })
  })
  return items
}

const addOutline = (document: PDFDocument, pages: PDFPage[], input: PdfInput, heightPt: number) => {
  const items = outlineOf(input.prepared, input.layout, input.sceneBookmarks ?? true)
  if (!items.length || !pages.length) return
  const context = document.context
  const root = context.nextRef()
  const build = (list: OutlineItem[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = list.map(() => context.nextRef())
    let count = list.length
    list.forEach((item, index) => {
      const page = pages[Math.min(item.page, pages.length - 1)]
      const dict = context.obj({
        Title: PDFHexString.fromText(item.title),
        Parent: parent,
        Dest: [page.ref, 'XYZ', null, Math.round((heightPt - Math.max(0, item.top - 6) * PX) * 100) / 100, null],
      })
      if (index > 0) dict.set(PDFName.of('Prev'), refs[index - 1])
      if (index < list.length - 1) dict.set(PDFName.of('Next'), refs[index + 1])
      if (item.children.length) {
        const inner = build(item.children, refs[index])
        dict.set(PDFName.of('First'), inner.first)
        dict.set(PDFName.of('Last'), inner.last)
        dict.set(PDFName.of('Count'), context.obj(inner.count))
        count += inner.count
      }
      context.assign(refs[index], dict)
    })
    return { first: refs[0], last: refs[refs.length - 1], count }
  }
  const top = build(items, root)
  context.assign(root, context.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.count }))
  document.catalog.set(PDFName.of('Outlines'), root)
  document.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
}

