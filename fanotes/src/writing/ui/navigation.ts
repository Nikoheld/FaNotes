// Caret movement and hit-testing over the laid-out manuscript.
import { graphemeStep, wordStep } from '../editor/commands'
import { blockLength, type Doc, type Pos } from '../editor/doc'
import { caretX, lineAt, offsetAtX } from '../layout/linebreak'
import type { TextMeasurer } from '../layout/measure'
import type { ManuscriptLayout, Page, PlacedLine } from '../layout/paginate'
import { runsText } from '../model/runs'

export type CaretBox = { page: number; x: number; y: number; height: number }

/** Where each (block, line) sits: page index and placement. */
export const lineIndex = (layout: ManuscriptLayout) => {
  const map = new Map<string, { page: Page; placed: PlacedLine }>()
  for (const page of layout.pages) for (const placed of page.lines) map.set(`${placed.blockIndex}:${placed.lineIndex}`, { page, placed })
  return map
}

export const caretBox = (layout: ManuscriptLayout, lines: ReturnType<typeof lineIndex>, pos: Pos, measurer: TextMeasurer): CaretBox | null => {
  const blockIndex = layout.blocks.findIndex((block) => block.key === pos.block)
  if (blockIndex < 0) return null
  const paragraph = layout.layouts[blockIndex]
  const line = lineAt(paragraph, pos.offset, true)
  const where = lines.get(`${blockIndex}:${line}`)
  if (!where) return null
  const box = paragraph.lines[line]
  return { page: where.page.index, x: where.placed.x + caretX(paragraph, line, pos.offset, measurer), y: where.placed.y, height: box.height }
}

/** The position under a point on a page (page-local px). */
export const hitTest = (layout: ManuscriptLayout, pageIndex: number, x: number, y: number, measurer: TextMeasurer): Pos | null => {
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
      if (after?.lines.length) return startOfLine(layout, after.lines[0])
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
    return next ? { block: next.key, offset: 0 } : null
  }
  return { block: block.key, offset: offsetAtX(paragraph, best.lineIndex, x - best.x, measurer) }
}

const startOfLine = (layout: ManuscriptLayout, placed: PlacedLine): Pos => ({ block: layout.blocks[placed.blockIndex].key, offset: layout.layouts[placed.blockIndex].lines[placed.lineIndex].from })
const endOfLine = (layout: ManuscriptLayout, placed: PlacedLine): Pos => {
  const line = layout.layouts[placed.blockIndex].lines[placed.lineIndex]
  const lastPiece = line.pieces[line.pieces.length - 1]
  return { block: layout.blocks[placed.blockIndex].key, offset: lastPiece?.kind === 'newline' ? lastPiece.from : line.to }
}

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
 * (page-local px); the returned goalX is to be passed back.
 */
export const move = (doc: Doc, layout: ManuscriptLayout, pos: Pos, motion: Motion, measurer: TextMeasurer, goalX: number | null): { pos: Pos; goalX: number | null } => {
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
  const line = lineAt(paragraph, pos.offset, true)
  const all = linesOf(layout)
  const current = all.findIndex((entry) => entry.blockIndex === blockIndex && entry.lineIndex === line)
  if (current < 0) return { pos, goalX }
  const here = all[current]
  const x = goalX ?? here.placed.x + caretX(paragraph, line, pos.offset, measurer)
  const at = (entry: (typeof all)[number]) => {
    const target = layout.layouts[entry.blockIndex]
    return { block: layout.blocks[entry.blockIndex].key, offset: offsetAtX(target, entry.lineIndex, x - entry.placed.x, measurer) }
  }
  if (motion === 'lineStart') return { pos: startOfLine(layout, here.placed), goalX: null }
  if (motion === 'lineEnd') return { pos: endOfLine(layout, here.placed), goalX: null }
  if (motion === 'up') return current > 0 ? { pos: at(all[current - 1]), goalX: x } : { pos: { block: block.key, offset: 0 }, goalX: null }
  if (motion === 'down') return current < all.length - 1 ? { pos: at(all[current + 1]), goalX: x } : { pos: { block: block.key, offset: text.length }, goalX: null }
  // Page up/down: the line at the same height on the previous/next page.
  const pageIndex = here.page + (motion === 'pageUp' ? -1 : 1)
  const page = layout.pages[Math.max(0, Math.min(layout.pages.length - 1, pageIndex))]
  const hit = hitTest(layout, page.index, x, here.placed.y, measurer)
  return { pos: hit ?? pos, goalX: x }
}
