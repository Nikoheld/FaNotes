// Lays the manuscript out on pages. Paragraph layouts are cached by the
// identity of their runs, style and width, so typing re-measures one
// paragraph; pagination itself is a linear pass over the lines (a 320-page
// novel has ~11 000 lines) and runs on every change.
import type { FlowBlock } from '../model/flow'
import type { PageSetup, ParagraphStyle, Run, StoryManifest } from '../model/types'
import { layoutParagraph, resolveStyle, type ParagraphLayout } from './linebreak'
import { mmToPx, type Hyphenator, type TextMeasurer } from './measure'

export type PlacedLine = {
  blockKey: string
  blockIndex: number
  lineIndex: number
  /** Top-left of the line box on the page, in px from the page's top-left. */
  x: number
  y: number
}

export type PlacedFootnote = { id: string; number: string; layout: ParagraphLayout; x: number; y: number }

export type Page = {
  index: number
  /** Printed page number (as text). */
  number: string
  side: 'left' | 'right'
  lines: PlacedLine[]
  /** Drop caps whose first line is on this page. */
  dropCaps: Array<{ blockIndex: number; x: number; y: number }>
  footnotes: PlacedFootnote[]
  header: { left: string; center: string; right: string } | null
  footer: { left: string; center: string; right: string } | null
  chapterTitle: string
  /** Inserted so that a chapter starts on a right-hand page. */
  blank?: boolean
  /** Content box in px. */
  content: { x: number; y: number; width: number; height: number }
}

export type ManuscriptLayout = {
  pages: Page[]
  blocks: FlowBlock[]
  layouts: ParagraphLayout[]
  /** Where each block starts: page index and line index (for navigation). */
  blockPages: number[]
  pageWidth: number
  pageHeight: number
  contentWidth: number
  footnoteNumbers: Map<string, string>
  stats: { lines: number; layoutMs: number; paginateMs: number; measured: number }
}

export type LayoutOptions = {
  measurer: TextMeasurer
  hyphenators?: Partial<Record<string, Hyphenator | null>>
  /** Footnote bodies by id (scene footnotes merged). */
  footnoteRuns?: (id: string) => Run[] | null
}

type CacheEntry = { runs: Run[]; style: ParagraphStyle; width: number; afterBreak: boolean; align?: string; hyphenate: boolean; numbers: string; layout: ParagraphLayout }

/** Keeps paragraph layouts between passes. One per open project. */
export class LayoutCache {
  private entries = new Map<string, CacheEntry>()
  measured = 0

  get(block: FlowBlock, style: ParagraphStyle, width: number, hyphenate: boolean, numbers: string, compute: () => ParagraphLayout) {
    const entry = this.entries.get(block.key)
    if (entry && entry.runs === block.runs && entry.style === style && entry.width === width && entry.afterBreak === block.afterBreak && entry.align === block.align && entry.hyphenate === hyphenate && entry.numbers === numbers) return entry.layout
    const layout = compute()
    this.measured += 1
    this.entries.set(block.key, { runs: block.runs, style, width, afterBreak: block.afterBreak, align: block.align, hyphenate, numbers, layout })
    return layout
  }

  /** Drops layouts of blocks that no longer exist. */
  prune(keys: Set<string>) {
    for (const key of this.entries.keys()) if (!keys.has(key)) this.entries.delete(key)
  }

  clear() {
    this.entries.clear()
  }
}

const fillTemplate = (template: string, values: Record<string, string>) => template.replace(/\{(title|chapter|page|pages|author|subtitle)\}/gu, (_, name: string) => values[name] ?? '')

const pageGeometry = (page: PageSetup, index: number, firstNumber: number) => {
  const width = mmToPx(page.width)
  const height = mmToPx(page.height)
  const number = firstNumber + index
  const right = number % 2 === 1
  const inner = mmToPx(page.margins.inner)
  const outer = mmToPx(page.margins.outer)
  const left = page.mirror ? (right ? inner : outer) : inner
  const contentWidth = width - inner - outer
  return {
    width,
    height,
    side: (right ? 'right' : 'left') as Page['side'],
    content: { x: left, y: mmToPx(page.margins.top), width: contentWidth, height: height - mmToPx(page.margins.top) - mmToPx(page.margins.bottom) },
  }
}

export const layoutManuscript = (manifest: StoryManifest, blocks: FlowBlock[], cache: LayoutCache, options: LayoutOptions): ManuscriptLayout => {
  const started = performance.now()
  const measuredBefore = cache.measured
  const setup = manifest.page
  const first = pageGeometry(setup, 0, setup.pageNumberStart)
  const contentWidth = first.content.width
  // Footnotes are numbered through the manuscript in reading order.
  const footnoteNumbers = new Map<string, string>()
  for (const block of blocks) for (const run of block.runs) if (run.m?.fn && !footnoteNumbers.has(run.m.fn)) footnoteNumbers.set(run.m.fn, String(footnoteNumbers.size + 1))
  const fallbackStyle = manifest.styles.body
  const layouts = blocks.map((block) => {
    const style = manifest.styles[block.style] ?? fallbackStyle
    const language = block.lang ?? manifest.language
    const hyphenator = options.hyphenators?.[language] ?? null
    const hyphenate = setup.hyphenate && Boolean(hyphenator) && block.ref.kind === 'para'
    const numbers = block.runs.some((run) => run.m?.fn) ? block.runs.filter((run) => run.m?.fn).map((run) => footnoteNumbers.get(run.m!.fn!)).join(',') : ''
    return cache.get(block, style, contentWidth, hyphenate, numbers, () => layoutParagraph({
      runs: block.runs,
      style: resolveStyle(style, { align: block.align, afterBreak: block.afterBreak }),
      width: contentWidth,
      measurer: options.measurer,
      hyphenator,
      hyphenate,
      footnoteNumber: (id) => footnoteNumbers.get(id) ?? '*',
    }))
  })
  cache.prune(new Set(blocks.map((block) => block.key)))
  const layoutDone = performance.now()

  const footnoteStyle = manifest.styles.footnote ?? { ...fallbackStyle, size: Math.max(7, fallbackStyle.size - 2), lineHeight: 1.3, indentFirst: 0, spaceBefore: 0, spaceAfter: 2, align: 'left' as const }
  const footnoteLayouts = new Map<string, ParagraphLayout>()
  const footnoteLayout = (id: string) => {
    const cached = footnoteLayouts.get(id)
    if (cached) return cached
    const runs = options.footnoteRuns?.(id) ?? []
    const number = footnoteNumbers.get(id) ?? '*'
    const layout = layoutParagraph({ runs: [{ text: `${number} `, m: { sup: true } }, ...runs], style: resolveStyle(footnoteStyle), width: contentWidth, measurer: options.measurer })
    footnoteLayouts.set(id, layout)
    return layout
  }
  const footnoteSeparator = 10

  const pages: Page[] = []
  const blockPages: number[] = []
  let page: Page
  let y = 0
  let footnoteHeight = 0
  let chapterTitle = ''
  let chapterStartPage = -1

  const openPage = (blank = false) => {
    const geometry = pageGeometry(setup, pages.length, setup.pageNumberStart)
    page = { index: pages.length, number: String(setup.pageNumberStart + pages.length), side: geometry.side, lines: [], dropCaps: [], footnotes: [], header: null, footer: null, chapterTitle, content: geometry.content, ...(blank ? { blank: true } : {}) }
    pages.push(page)
    y = 0
    footnoteHeight = 0
  }
  openPage()
  const room = () => page.content.height - y - (footnoteHeight ? footnoteHeight + footnoteSeparator : 0)
  const pageEmpty = () => page.lines.length === 0

  const placeLines = (blockIndex: number, from: number, to: number) => {
    const layout = layouts[blockIndex]
    for (let line = from; line < to; line += 1) {
      const box = layout.lines[line]
      page.lines.push({ blockKey: blocks[blockIndex].key, blockIndex, lineIndex: line, x: page.content.x + box.x, y: page.content.y + y })
      if (line === 0 && layout.dropCap) page.dropCaps.push({ blockIndex, x: page.content.x + layout.dropCap.x, y: page.content.y + y })
      for (const note of layout.footnotes) {
        if (note.line !== line) continue
        const noteLayout = footnoteLayout(note.id)
        page.footnotes.push({ id: note.id, number: footnoteNumbers.get(note.id) ?? '*', layout: noteLayout, x: page.content.x, y: 0 })
        footnoteHeight += noteLayout.height + noteLayout.style.spaceAfter
      }
      y += box.height
    }
  }
  /** Height of lines plus the footnotes they bring along. */
  const linesHeight = (blockIndex: number, from: number, to: number) => {
    const layout = layouts[blockIndex]
    let height = 0
    let notes = 0
    for (let line = from; line < to; line += 1) {
      height += layout.lines[line].height
      for (const note of layout.footnotes) if (note.line === line) notes += footnoteLayout(note.id).height + 2
    }
    return { height, notes }
  }
  const fits = (blockIndex: number, from: number, to: number) => {
    const { height, notes } = linesHeight(blockIndex, from, to)
    const extraSeparator = notes && !footnoteHeight ? footnoteSeparator : 0
    return height + notes + extraSeparator <= room() + 0.5
  }

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex]
    const layout = layouts[blockIndex]
    const style = layout.style
    if (block.chapterStart) chapterTitle = block.chapterTitle
    const breakBefore = block.breakBefore === 'page' || style.pageBreakBefore || block.chapterStart
    if (breakBefore && !(pages.length === 1 && pageEmpty())) {
      if (!pageEmpty() || y > 0) openPage()
      if (block.chapterStart && setup.chapterStartsRight && page.side !== 'right') {
        page.blank = true
        openPage()
      }
    }
    if (block.chapterStart) {
      chapterStartPage = page.index
      page.chapterTitle = chapterTitle
    }
    // Space before collapses at the top of a page, except for a chapter title.
    const before = pageEmpty() && !block.chapterStart ? 0 : style.spaceBefore
    if (before) {
      if (before >= room()) openPage()
      else y += before
    }
    // Keep with next: the heading moves with the first two lines of what follows.
    if (style.keepWithNext && blockIndex + 1 < blocks.length && !pageEmpty()) {
      const next = layouts[blockIndex + 1]
      const needed = linesHeight(blockIndex, 0, layout.lines.length).height + style.spaceAfter + next.style.spaceBefore + linesHeight(blockIndex + 1, 0, Math.min(2, next.lines.length)).height
      if (needed > room()) openPage()
    }
    blockPages[blockIndex] = page.index
    let line = 0
    const total = layout.lines.length
    while (line < total) {
      let count = 0
      while (line + count < total && fits(blockIndex, line, line + count + 1)) count += 1
      if (line + count >= total) {
        placeLines(blockIndex, line, total)
        line = total
        break
      }
      if (setup.widowsOrphans && total >= 2) {
        // No single first line at the bottom (orphan), no single last line at the top (widow).
        if (line === 0 && count === 1 && !pageEmpty()) count = 0
        if (total - (line + count) === 1 && count >= 2 && total >= 3) count -= 1
      }
      if (count === 0 && pageEmpty()) count = 1
      if (count > 0) placeLines(blockIndex, line, line + count)
      line += count
      openPage()
      if (line === 0) blockPages[blockIndex] = page.index
    }
    y += style.spaceAfter
  }

  // Footnotes sit at the bottom of their page; headers and footers get their fields.
  const totalPages = String(pages.length + setup.pageNumberStart - 1)
  for (const current of pages) {
    let bottom = current.content.y + current.content.height
    for (let index = current.footnotes.length - 1; index >= 0; index -= 1) {
      const note = current.footnotes[index]
      bottom -= note.layout.height + note.layout.style.spaceAfter
      note.y = bottom
    }
    const chapterStart = pages.some((candidate) => candidate === current) && current.lines[0] && blocks[current.lines[0].blockIndex]?.chapterStart && current.lines[0].lineIndex === 0
    const hide = current.blank || (setup.hideOnChapterStart && chapterStart)
    const values = { title: manifest.title, subtitle: manifest.subtitle ?? '', author: manifest.author ?? '', chapter: current.chapterTitle, page: current.number, pages: totalPages }
    const mirror = setup.mirror && current.side === 'left'
    const fill = (part: PageSetup['header']) => {
      const filled = { left: fillTemplate(part.left, values), center: fillTemplate(part.center, values), right: fillTemplate(part.right, values) }
      return mirror ? { left: filled.right, center: filled.center, right: filled.left } : filled
    }
    current.header = hide ? null : fill(setup.header)
    current.footer = current.blank ? null : (setup.hideOnChapterStart && chapterStart ? { left: '', center: fillTemplate(setup.footer.center, values), right: '' } : fill(setup.footer))
  }
  void chapterStartPage
  const done = performance.now()
  return {
    pages,
    blocks,
    layouts,
    blockPages,
    pageWidth: first.width,
    pageHeight: first.height,
    contentWidth,
    footnoteNumbers,
    stats: { lines: layouts.reduce((sum, layout) => sum + layout.lines.length, 0), layoutMs: layoutDone - started, paginateMs: done - layoutDone, measured: cache.measured - measuredBefore },
  }
}
