// Lays the manuscript out on pages. Paragraph layouts are cached by the
// identity of their runs, style and width, so typing re-measures one
// paragraph; pagination itself is a linear pass over the lines (a 320-page
// novel has ~11 000 lines) and runs on every change.
import type { FlowBlock } from '../model/flow'
import type { PageSetup, ParagraphStyle, Run, StoryManifest } from '../model/types'
import { insertEndnotes, numberFootnotes, type EndnoteOptions } from './endnotes'
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
  /** The page setup this layout was made with (incremental reuse needs the same one). */
  setup: PageSetup
  /** Title, subtitle, author and page count the headers were filled with. */
  headerKey: string
  /** Footnote bodies this layout was made with (an edited footnote re-paginates its page). */
  footnoteBodies: Map<string, Run[] | null>
  stats: { lines: number; layoutMs: number; paginateMs: number; measured: number; repaginatedPages: number }
}

export type LayoutOptions = {
  measurer: TextMeasurer
  hyphenators?: Partial<Record<string, Hyphenator | null>>
  /** Footnote bodies by id (scene footnotes merged). */
  footnoteRuns?: (id: string) => Run[] | null
  /**
   * Export only: footnotes become endnotes after each chapter or at the end of
   * the book (added to `blocks`, see endnotes.ts) instead of sitting at the
   * bottom of their page. Unset (the editor): footnotes at the page bottom.
   */
  endnotes?: EndnoteOptions
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

export const layoutManuscript = (manifest: StoryManifest, flow: FlowBlock[], cache: LayoutCache, options: LayoutOptions, previous?: ManuscriptLayout | null): ManuscriptLayout => {
  const started = performance.now()
  const measuredBefore = cache.measured
  const setup = manifest.page
  const first = pageGeometry(setup, 0, setup.pageNumberStart)
  const contentWidth = first.content.width
  // Footnotes are numbered through the manuscript in reading order (endnotes per chapter restart).
  const endnotes = options.endnotes ?? null
  const footnoteNumbers = numberFootnotes(flow, endnotes?.placement === 'chapter')
  const blocks = endnotes ? insertEndnotes(flow, footnoteNumbers, endnotes, (id) => options.footnoteRuns?.(id) ?? null) : flow
  const fallbackStyle = manifest.styles.body
  const footnoteStyle = manifest.styles.footnote ?? { ...fallbackStyle, size: Math.max(7, fallbackStyle.size - 2), lineHeight: 1.3, indentFirst: 0, spaceBefore: 0, spaceAfter: 2, align: 'left' as const }
  const layouts = blocks.map((block) => {
    const style = manifest.styles[block.style] ?? (block.style === 'footnote' ? footnoteStyle : fallbackStyle)
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

  const footnoteBodies = new Map([...footnoteNumbers.keys()].map((id) => [id, options.footnoteRuns?.(id) ?? null] as const))
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

  // Incremental: pages before the first changed paragraph are kept, and as soon
  // as a new page starts where the previous layout had one (same paragraph and
  // line, nothing changed after it) the rest of the old pages are reused. Typing
  // in a paragraph usually re-paginates one page.
  const changedAt = (index: number) => {
    const before = previous?.blocks[index]
    const now = blocks[index]
    return !before || before.key !== now.key || previous!.layouts[index] !== layouts[index] || before.chapterStart !== now.chapterStart || before.breakBefore !== now.breakBefore || before.chapterTitle !== now.chapterTitle
      || now.runs.some((run) => run.m?.fn !== undefined && previous!.footnoteBodies?.get(run.m.fn) !== footnoteBodies.get(run.m.fn))
  }
  const incremental = Boolean(previous && previous.setup === setup && previous.pages.length && previous.blockPages.length === previous.blocks.length)
  const delta = blocks.length - (previous?.blocks.length ?? 0)
  let firstChanged = 0
  if (incremental) {
    const limit = Math.min(blocks.length, previous!.blocks.length)
    while (firstChanged < limit && !changedAt(firstChanged)) firstChanged += 1
  }
  let lastChanged = blocks.length - 1
  if (incremental && delta === 0) while (lastChanged >= firstChanged && !changedAt(lastChanged)) lastChanged -= 1

  const pages: Page[] = []
  const blockPages: number[] = []
  let page!: Page
  let y = 0
  let footnoteHeight = 0
  let chapterTitle = ''
  let resumeBlock = 0
  let resumeLine = 0
  let rebuiltFrom = 0
  let reusedFrom = -1
  const unchanged = incremental && delta === 0 && firstChanged === blocks.length

  if (incremental && !unchanged) {
    // Restart at the page holding the paragraph before the change (a heading kept with it may move).
    const anchor = Math.max(0, Math.min(firstChanged, previous!.blocks.length) - 1)
    let startPage = Math.min(previous!.blockPages[anchor] ?? 0, previous!.blockPages[Math.min(firstChanged, previous!.blockPages.length - 1)] ?? 0)
    while (startPage > 0 && (previous!.pages[startPage].blank || !previous!.pages[startPage].lines.length)) startPage -= 1
    const firstLine = previous!.pages[startPage]?.lines[0]
    if (firstLine && firstLine.blockIndex <= firstChanged) {
      pages.push(...previous!.pages.slice(0, startPage))
      // A paragraph resumed in the middle started on an earlier (kept) page.
      const kept = firstLine.blockIndex + (firstLine.lineIndex > 0 ? 1 : 0)
      for (let index = 0; index < kept; index += 1) blockPages[index] = previous!.blockPages[index]
      resumeBlock = firstLine.blockIndex
      resumeLine = firstLine.lineIndex
      chapterTitle = previous!.pages[startPage].chapterTitle
      rebuiltFrom = startPage
    }
  }

  const openPage = (blank = false) => {
    const geometry = pageGeometry(setup, pages.length, setup.pageNumberStart)
    page = { index: pages.length, number: String(setup.pageNumberStart + pages.length), side: geometry.side, lines: [], dropCaps: [], footnotes: [], header: null, footer: null, chapterTitle, content: geometry.content, ...(blank ? { blank: true } : {}) }
    pages.push(page)
    y = 0
    footnoteHeight = 0
  }
  const room = () => page.content.height - y - (footnoteHeight ? footnoteHeight + footnoteSeparator : 0)
  const pageEmpty = () => page.lines.length === 0

  const placeLines = (blockIndex: number, from: number, to: number) => {
    const layout = layouts[blockIndex]
    for (let line = from; line < to; line += 1) {
      const box = layout.lines[line]
      page.lines.push({ blockKey: blocks[blockIndex].key, blockIndex, lineIndex: line, x: page.content.x + box.x, y: page.content.y + y })
      if (line === 0 && layout.dropCap) page.dropCaps.push({ blockIndex, x: page.content.x + layout.dropCap.x, y: page.content.y + y })
      for (const note of layout.footnotes) {
        if (note.line !== line || endnotes) continue
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
      for (const note of layout.footnotes) if (note.line === line && !endnotes) notes += footnoteLayout(note.id).height + 2
    }
    return { height, notes }
  }
  const fits = (blockIndex: number, from: number, to: number) => {
    const { height, notes } = linesHeight(blockIndex, from, to)
    const extraSeparator = notes && !footnoteHeight ? footnoteSeparator : 0
    return height + notes + extraSeparator <= room() + 0.5
  }
  /** After opening a page for (block, line): the old layout from here on is still right. */
  const aligned = (blockIndex: number, line: number) => {
    if (!incremental || delta !== 0 || blockIndex <= lastChanged || page.blank) return false
    const old = previous!.pages[page.index]
    const first = old?.lines[0]
    if (!old || old.blank || !first || first.blockIndex !== blockIndex || first.lineIndex !== line || old.chapterTitle !== page.chapterTitle) return false
    pages.pop()
    reusedFrom = pages.length
    pages.push(...previous!.pages.slice(page.index))
    for (let index = line === 0 ? blockIndex : blockIndex + 1; index < blocks.length; index += 1) blockPages[index] = previous!.blockPages[index]
    return true
  }

  if (unchanged) {
    pages.push(...previous!.pages)
    blockPages.push(...previous!.blockPages)
    reusedFrom = 0
  } else {
    openPage()
    let first = true
    outer: for (let blockIndex = resumeBlock; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex]
      const layout = layouts[blockIndex]
      const style = layout.style
      if (block.chapterStart) chapterTitle = block.chapterTitle
      const resuming = first && resumeLine > 0
      first = false
      if (!resuming) {
        const breakBefore = block.breakBefore === 'page' || style.pageBreakBefore || block.chapterStart
        if (breakBefore && !(pages.length === 1 && pageEmpty())) {
          if (!pageEmpty() || y > 0) {
            openPage()
            if (aligned(blockIndex, 0)) break outer
          }
          if (block.chapterStart && setup.chapterStartsRight && page.side !== 'right') {
            page.blank = true
            openPage()
            if (aligned(blockIndex, 0)) break outer
          }
        }
        if (block.chapterStart) page.chapterTitle = chapterTitle
        // Space before collapses at the top of a page, except for a chapter title.
        const before = pageEmpty() && !block.chapterStart ? 0 : style.spaceBefore
        if (before) {
          if (before >= room()) {
            openPage()
            if (aligned(blockIndex, 0)) break outer
          } else y += before
        }
        // Keep with next: the heading moves with the first two lines of what follows.
        if (style.keepWithNext && blockIndex + 1 < blocks.length && !pageEmpty()) {
          const next = layouts[blockIndex + 1]
          const needed = linesHeight(blockIndex, 0, layout.lines.length).height + style.spaceAfter + next.style.spaceBefore + linesHeight(blockIndex + 1, 0, Math.min(2, next.lines.length)).height
          if (needed > room()) {
            openPage()
            if (aligned(blockIndex, 0)) break outer
          }
        }
        blockPages[blockIndex] = page.index
      }
      let line = resuming ? resumeLine : 0
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
        if (aligned(blockIndex, line)) break outer
      }
      y += style.spaceAfter
    }
  }

  // Footnotes sit at the bottom of their page; headers and footers get their fields.
  const totalPages = String(pages.length + setup.pageNumberStart - 1)
  const headerKey = `${manifest.title}\u0000${manifest.subtitle ?? ''}\u0000${manifest.author ?? ''}\u0000${totalPages}`
  const refillAll = !incremental || previous!.headerKey !== headerKey
  const rebuiltTo = reusedFrom >= 0 ? reusedFrom : pages.length
  for (let index = 0; index < pages.length; index += 1) {
    const rebuilt = index >= (unchanged ? pages.length : rebuiltFrom) && index < rebuiltTo
    if (!rebuilt && !refillAll) continue
    const current = rebuilt ? pages[index] : { ...pages[index] }
    if (rebuilt) {
      let bottom = current.content.y + current.content.height
      for (let note = current.footnotes.length - 1; note >= 0; note -= 1) {
        const placed = current.footnotes[note]
        bottom -= placed.layout.height + placed.layout.style.spaceAfter
        placed.y = bottom
      }
    }
    const chapterStart = Boolean(current.lines[0] && blocks[current.lines[0].blockIndex]?.chapterStart && current.lines[0].lineIndex === 0)
    const hide = current.blank || (setup.hideOnChapterStart && chapterStart)
    const values = { title: manifest.title, subtitle: manifest.subtitle ?? '', author: manifest.author ?? '', chapter: current.chapterTitle, page: current.number, pages: totalPages }
    const mirror = setup.mirror && current.side === 'left'
    const fill = (part: PageSetup['header']) => {
      const filled = { left: fillTemplate(part.left, values), center: fillTemplate(part.center, values), right: fillTemplate(part.right, values) }
      return mirror ? { left: filled.right, center: filled.center, right: filled.left } : filled
    }
    current.header = hide ? null : fill(setup.header)
    current.footer = current.blank ? null : (setup.hideOnChapterStart && chapterStart ? { left: '', center: fillTemplate(setup.footer.center, values), right: '' } : fill(setup.footer))
    pages[index] = current
  }
  const done = performance.now()
  return {
    pages,
    blocks,
    layouts,
    blockPages,
    footnoteBodies,
    pageWidth: first.width,
    pageHeight: first.height,
    contentWidth,
    footnoteNumbers,
    setup,
    headerKey,
    stats: {
      lines: layouts.reduce((sum, layout) => sum + layout.lines.length, 0),
      layoutMs: layoutDone - started,
      paginateMs: done - layoutDone,
      measured: cache.measured - measuredBefore,
      repaginatedPages: unchanged ? 0 : rebuiltTo - rebuiltFrom,
    },
  }
}
