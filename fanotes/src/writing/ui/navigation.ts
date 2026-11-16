// Caret movement and hit-testing over the laid-out manuscript.
import { graphemeStep, wordStep } from '../editor/commands'
import { blockLength, type Doc, type Pos } from '../editor/doc'
import { caretAtX, caretX, lineAt, lineEnd } from '../layout/linebreak'
import type { TextMeasurer } from '../layout/measure'
import type { ManuscriptLayout, Page, PlacedLine } from '../layout/paginate'
import { runsText } from '../model/runs'

export type CaretBox = { page: number; x: number; y: number; height: number }

const blockIndexes = new WeakMap<ManuscriptLayout, Map<string, number>>()
export const blockIndexOf = (layout: ManuscriptLayout, key: string) => {
  let map = blockIndexes.get(layout)
  if (!map) {
    map = new Map(layout.blocks.map((block, index) => [block.key, index]))
    blockIndexes.set(layout, map)
  }
  return map.get(key) ?? -1
}

/** Where a paragraph's line sits: found from the page the paragraph starts on. */
export const placedLine = (layout: ManuscriptLayout, blockIndex: number, line: number): { page: Page; placed: PlacedLine } | null => {
  for (let index = Math.max(0, layout.blockPages[blockIndex] ?? 0); index < layout.pages.length; index += 1) {
    const page = layout.pages[index]
    for (const placed of page.lines) {
      if (placed.blockIndex === blockIndex && placed.lineIndex === line) return { page, placed }
      if (placed.blockIndex > blockIndex) return null
    }
  }
  return null
}

/**
 * `index` is the document's block index (the layout's blocks are the document's flow). An `upstream` caret is drawn
 * at the end of its line where its offset also starts the next one (see `Selection.upstream`).
 */
export const caretBox = (layout: ManuscriptLayout, pos: Pos, measurer: TextMeasurer, index?: Map<string, number>, upstream = false): CaretBox | null => {
  const blockIndex = index?.get(pos.block) ?? blockIndexOf(layout, pos.block)
  if (blockIndex < 0) return null
  const paragraph = layout.layouts[blockIndex]
  const line = lineAt(paragraph, pos.offset, !upstream)
  const where = placedLine(layout, blockIndex, line)
  if (!where) return null
  const box = paragraph.lines[line]
  return { page: where.page.index, x: where.placed.x + caretX(paragraph, line, pos.offset, measurer), y: where.placed.y, height: box.height }
}

/** A caret position, and whether it is drawn at the end of its line (`Selection.upstream`). */
export type Caret = { pos: Pos; upstream: boolean }

/** The caret under a point on a page (page-local px): a click right of a wrapped line ends that line. */
export const hitTestCaret = (layout: ManuscriptLayout, pageIndex: number, x: number, y: number, measurer: TextMeasurer): Caret | null => {
  const page = layout.pages[pageIndex]
  if (!page) return null
  const candidates = page.lines.filter((placed) => layout.blocks[placed.blockIndex].editable || true)
  if (!candidates.length) {
    // An empty (blank) page: the nearest line on the pages around it.
    for (let distance = 1; distance < layout.pages.length; distance += 1) {
      const before = layout.pages[pageIndex - distance]
      if (before?.lines.length) {
        const last = before.lines[before.lines.length - 1]
        return endOfLine(layout, last)
      }
      const after = layout.pages[pageIndex + distance]
      if (after?.lines.length) return { pos: startOfLine(layout, after.lines[0]), upstream: false }
    }
    return null
  }
  let best = candidates[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const placed of candidates) {
    const height = layout.layouts[placed.blockIndex].lines[placed.lineIndex].height
    const distance = y < placed.y ? placed.y - y : y > placed.y + height ? y - placed.y - height : 0
    if (distance < bestDistance) {
      bestDistance = distance
      best = placed
    }
    if (distance === 0) break
  }
  const block = layout.blocks[best.blockIndex]
  const paragraph = layout.layouts[best.blockIndex]
  if (!block.editable) {
    // A click on a scene break goes to the start of the next paragraph.
    const next = layout.blocks.slice(best.blockIndex + 1).find((candidate) => candidate.editable)
    return next ? { pos: { block: next.key, offset: 0 }, upstream: false } : null
  }
  const hit = caretAtX(paragraph, best.lineIndex, x - best.x, measurer)
  return { pos: { block: block.key, offset: hit.offset }, upstream: hit.upstream }
}

/** The position under a point on a page (page-local px). */
export const hitTest = (layout: ManuscriptLayout, pageIndex: number, x: number, y: number, measurer: TextMeasurer): Pos | null => hitTestCaret(layout, pageIndex, x, y, measurer)?.pos ?? null

const startOfLine = (layout: ManuscriptLayout, placed: PlacedLine): Pos => ({ block: layout.blocks[placed.blockIndex].key, offset: layout.layouts[placed.blockIndex].lines[placed.lineIndex].from })
/** The end of a line as the End key sees it: before the spaces that hang at a soft wrap, after those typed before a break. */
const endOfLine = (layout: ManuscriptLayout, placed: PlacedLine): Caret => {
  const end = lineEnd(layout.layouts[placed.blockIndex], placed.lineIndex)
  return { pos: { block: layout.blocks[placed.blockIndex].key, offset: end.offset }, upstream: end.upstream }
}

/** A motion's result; `upstream` is there only when the caret ends at the end of its line. */
export type MoveResult = { pos: Pos; goalX: number | null; upstream?: true }

const withUpstream = (result: { pos: Pos; goalX: number | null }, upstream: boolean): MoveResult => (upstream ? { ...result, upstream: true } : result)

export type Motion = 'left' | 'right' | 'wordLeft' | 'wordRight' | 'up' | 'down' | 'lineStart' | 'lineEnd' | 'docStart' | 'docEnd' | 'pageUp' | 'pageDown' | 'paragraphUp' | 'paragraphDown'

/** All editable lines in reading order (for up/down movement). */
const flatLines = (layout: ManuscriptLayout) => {
  const out: Array<{ blockIndex: number; lineIndex: number; page: number; placed: PlacedLine }> = []
  for (const page of layout.pages) for (const placed of page.lines) if (layout.blocks[placed.blockIndex].editable) out.push({ blockIndex: placed.blockIndex, lineIndex: placed.lineIndex, page: page.index, placed })
  return out
}

let flatCache: { layout: ManuscriptLayout; lines: ReturnType<typeof flatLines> } | null = null
const linesOf = (layout: ManuscriptLayout) => {
  if (flatCache?.layout !== layout) flatCache = { layout, lines: flatLines(layout) }
  return flatCache.lines
}

/**
 * Moves the caret. `goalX` keeps the column during repeated up/down
 * (page-local px); the returned goalX is to be passed back. `upstream` says the
 * caret is drawn at the end of its line (see `Selection.upstream`); the result
 * has it set when the motion ends there.
 */
export const move = (doc: Doc, layout: ManuscriptLayout, pos: Pos, motion: Motion, measurer: TextMeasurer, goalX: number | null, upstream = false): MoveResult => {
  const blockIndex = doc.index.get(pos.block) ?? 0
  const block = doc.flow[blockIndex]
  const text = runsText(block.runs)
  const editableNeighbour = (from: number, direction: 1 | -1) => {
    for (let index = from + direction; index >= 0 && index < doc.flow.length; index += direction) if (doc.flow[index].editable) return index
    return -1
  }
  switch (motion) {
    case 'left': {
      if (pos.offset > 0) return { pos: { block: block.key, offset: graphemeStep(text, pos.offset, -1) }, goalX: null }
      const previous = editableNeighbour(blockIndex, -1)
      return { pos: previous < 0 ? pos : { block: doc.flow[previous].key, offset: blockLength(doc.flow[previous]) }, goalX: null }
    }
    case 'right': {
      if (pos.offset < text.length) return { pos: { block: block.key, offset: graphemeStep(text, pos.offset, 1) }, goalX: null }
      const next = editableNeighbour(blockIndex, 1)
      return { pos: next < 0 ? pos : { block: doc.flow[next].key, offset: 0 }, goalX: null }
    }
    case 'wordLeft': {
      if (pos.offset > 0) return { pos: { block: block.key, offset: wordStep(text, pos.offset, -1) }, goalX: null }
      return move(doc, layout, pos, 'left', measurer, null)
    }
    case 'wordRight': {
      if (pos.offset < text.length) return { pos: { block: block.key, offset: wordStep(text, pos.offset, 1) }, goalX: null }
      return move(doc, layout, pos, 'right', measurer, null)
    }
    case 'paragraphUp': {
      if (pos.offset > 0) return { pos: { block: block.key, offset: 0 }, goalX: null }
      const previous = editableNeighbour(blockIndex, -1)
      return { pos: previous < 0 ? pos : { block: doc.flow[previous].key, offset: 0 }, goalX: null }
    }
    case 'paragraphDown': {
      const next = editableNeighbour(blockIndex, 1)
      return { pos: next < 0 ? { block: block.key, offset: text.length } : { block: doc.flow[next].key, offset: 0 }, goalX: null }
    }
    case 'docStart': {
      const first = editableNeighbour(-1, 1)
      return { pos: first < 0 ? pos : { block: doc.flow[first].key, offset: 0 }, goalX: null }
    }
    case 'docEnd': {
      const last = editableNeighbour(doc.flow.length, -1)
      return { pos: last < 0 ? pos : { block: doc.flow[last].key, offset: blockLength(doc.flow[last]) }, goalX: null }
    }
    default:
      break
  }
  const paragraph = layout.layouts[blockIndex]
  if (!paragraph) return { pos, goalX }
  const line = lineAt(paragraph, pos.offset, !upstream)
  const all = linesOf(layout)
  const current = all.findIndex((entry) => entry.blockIndex === blockIndex && entry.lineIndex === line)
  if (current < 0) return { pos, goalX }
  const here = all[current]
  const x = goalX ?? here.placed.x + caretX(paragraph, line, pos.offset, measurer)
  const at = (entry: (typeof all)[number]): Caret => {
    const hit = caretAtX(layout.layouts[entry.blockIndex], entry.lineIndex, x - entry.placed.x, measurer)
    return { pos: { block: layout.blocks[entry.blockIndex].key, offset: hit.offset }, upstream: hit.upstream }
  }
  if (motion === 'lineStart') return { pos: startOfLine(layout, here.placed), goalX: null }
  if (motion === 'lineEnd') {
    const end = endOfLine(layout, here.placed)
    return withUpstream({ pos: end.pos, goalX: null }, end.upstream)
  }
  if (motion === 'up') {
    if (current <= 0) return { pos: { block: block.key, offset: 0 }, goalX: null }
    const target = at(all[current - 1])
    return withUpstream({ pos: target.pos, goalX: x }, target.upstream)
  }
  if (motion === 'down') {
    if (current >= all.length - 1) return { pos: { block: block.key, offset: text.length }, goalX: null }
    const target = at(all[current + 1])
    return withUpstream({ pos: target.pos, goalX: x }, target.upstream)
  }
  // Page up/down: the line at the same height on the previous/next page.
  const pageIndex = here.page + (motion === 'pageUp' ? -1 : 1)
  const page = layout.pages[Math.max(0, Math.min(layout.pages.length - 1, pageIndex))]
  const hit = hitTestCaret(layout, page.index, x, here.placed.y, measurer)
  return withUpstream({ pos: hit?.pos ?? pos, goalX: x }, hit ? hit.upstream : upstream)
}
