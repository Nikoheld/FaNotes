/**
 * Collapsible handwriting sections.
 *
 * A section is a horizontal band on the ink sheet: a header (the title, typed
 * or written by hand) followed by a body that reaches down to the next section's
 * header — or, for the last section, to the end of the page. A subsection is
 * the same kind of band, nested one level inside a section. Collapsing a
 * section lifts its body ink off the sheet and pulls everything below up by
 * the body's height; expanding puts it back. Subsections of a collapsed
 * section are parked inside that hidden body and come back still collapsed
 * if they were collapsed. Ink stays a flat 0–1 stroke list the whole time, so
 * painting, erasing, selection and saving never learn about sections: they
 * only see the current layout.
 *
 * Section edges are `StrokePoint`s. The board remaps every tracked point when
 * the sheet grows, pads or rescales, and by being points the edges ride along.
 * Hidden body ink is stored normalised to its own box (width × height in sheet
 * px at collapse time) so a later sheet resize cannot make it stale. A
 * section's `left` and `width` are the band's left and right edges. Changing
 * either edge copies that pair onto every section. It does not move strokes
 * and does not change the page. Writing that falls outside the band stays
 * where it is.
 */
import type { StrokePoint } from '../../../src/types'
import { WRITE_MARGIN_X } from './noteCanvas'

/** Height of the title band in sheet px (≈ 17 mm on the A4 column). */
export const SECTION_HEADER_PX = 72
/** A subsection header is shorter so it reads as nested inside its section. */
export const SUBSECTION_HEADER_PX = 48
/** Room kept below the lowest stroke of a body so the pen never runs into the next header. */
export const SECTION_BODY_MARGIN_PX = WRITE_MARGIN_X
/** A body never becomes shorter than this when a header is inserted right above another one. */
export const SECTION_MIN_BODY_PX = 144
/** Shortest body kept when a subsection is inserted against the next header. */
export const SUBSECTION_MIN_BODY_PX = 96
/** Narrowest band, as a fraction of the sheet (`width` minus `left`). */
export const SUBSECTION_WIDTH_MIN = 0.28
export const SUBSECTION_WIDTH_MAX = 1
/** Typed title length. Longer text is cut; blank text is the same as no title. */
export const SECTION_TITLE_MAX = 120

export type SectionStroke = { points: StrokePoint[] }

export type HiddenSectionInk<S extends SectionStroke> = {
  /** Sheet px the hidden strokes are normalised against. */
  widthPx: number
  heightPx: number
  /** Body ink, x 0–1 of `widthPx`, y 0–1 of `heightPx` measured from the body top. */
  strokes: S[]
  /**
   * Subsections that lived in this body. Their edges are 0–1 of this box,
   * not of the sheet, so a resize while the parent is collapsed leaves them alone.
   */
  sections: InkSection<S>[]
}

export type InkSection<S extends SectionStroke = SectionStroke> = {
  id: string
  /** `null` for a section. A subsection names its section; one level only. */
  parentId: string | null
  /**
   * Left edge of the band, 0–1 of the sheet. A new band copies the edges the
   * other bands already share, or 0 when it is the first. Omitted from a save
   * when it is 0. Changing it does not move ink or the page.
   */
  left: number
  /**
   * Right edge of the band, 0–1 of the sheet. A new band copies the edges the
   * other bands already share, or 1 when it is the first. Omitted from a save
   * when it is 1. Changing it does not move ink or the page.
   */
  width: number
  /** Header top edge, 0–1 of the sheet (or of the parent body box while parked). */
  top: StrokePoint
  /** Header bottom edge = body top, 0–1 of the sheet (or of the parent body box while parked). */
  bodyTop: StrokePoint
  collapsed: boolean
  /** Typed title. Empty when the header is still the placeholder or only ink. */
  title: string
  hidden: HiddenSectionInk<S> | null
}

export type SheetPx = { width: number; height: number }

/** Visits every stroke the board tracks (live ink, undo/redo snapshots, gesture copies). */
export type TrackedStrokeVisitor<S extends SectionStroke> = (visit: (stroke: S) => void) => void

export const sectionPoint = (x: number, y: number): StrokePoint => ({ x, y, t: 0, pressure: 0, tiltX: 0, tiltY: 0, pointerType: 'section' })

export const strokeTop = (stroke: SectionStroke) => {
  let top = Number.POSITIVE_INFINITY
  for (const point of stroke.points) if (point.y < top) top = point.y
  return top
}

export const strokeBottom = (stroke: SectionStroke) => {
  let bottom = Number.NEGATIVE_INFINITY
  for (const point of stroke.points) if (point.y > bottom) bottom = point.y
  return bottom
}

export const sortSections = <S extends SectionStroke>(sections: readonly InkSection<S>[]) => (
  [...sections].sort((left, right) => left.top.y - right.top.y)
)

/** Index of the section whose header-or-body contains `y`; -1 above the first header. */
export const sectionIndexAt = <S extends SectionStroke>(sections: readonly InkSection<S>[], y: number) => {
  const sorted = sortSections(sections)
  let found = -1
  sorted.forEach((section, index) => { if (y >= section.top.y) found = index })
  return found < 0 ? -1 : sections.indexOf(sorted[found]!)
}

export const isInHeader = <S extends SectionStroke>(section: InkSection<S>, y: number) => y >= section.top.y && y < section.bodyTop.y

/** Next header's top, including a subsection inside this band, or `null` when nothing follows. */
export const nextSectionTop = <S extends SectionStroke>(sections: readonly InkSection<S>[], section: InkSection<S>) => {
  let next: number | null = null
  for (const other of sections) {
    if (other === section || other.top.y < section.bodyTop.y) continue
    if (next === null || other.top.y < next) next = other.top.y
  }
  return next
}

/**
 * Where this band's collapsible body ends: the next sibling, or the next
 * section. A section's own subsections sit inside the body, so they do not
 * end it.
 */
export const nextSpanTop = <S extends SectionStroke>(sections: readonly InkSection<S>[], section: InkSection<S>) => {
  const parentId = section.parentId
  let next: number | null = null
  for (const other of sections) {
    if (other === section || other.top.y < section.bodyTop.y) continue
    if (other.parentId === section.id) continue
    if (parentId === null) {
      if (other.parentId !== null) continue
    } else if (other.parentId !== null && other.parentId !== parentId) {
      continue
    }
    if (next === null || other.top.y < next) next = other.top.y
  }
  return next
}

/** Live strokes whose top lies in the section's body, including ink inside its subsections. */
export const bodyStrokes = <S extends SectionStroke>(strokes: readonly S[], sections: readonly InkSection<S>[], section: InkSection<S>) => {
  const end = nextSpanTop(sections, section) ?? Number.POSITIVE_INFINITY
  return strokes.filter((stroke) => { const top = strokeTop(stroke); return top >= section.bodyTop.y && top < end })
}

export const headerStrokeCount = <S extends SectionStroke>(strokes: readonly S[], section: InkSection<S>) => (
  strokes.reduce((count, stroke) => count + (isInHeader(section, strokeTop(stroke)) ? 1 : 0), 0)
)

/**
 * Where the body ends for a collapse, 0–1 of the sheet: the next header, or for
 * the last section the lowest body stroke plus the write margin. A last section
 * without ink has a zero-height body — collapsing it only flips the arrow.
 */
export const collapsibleBodyEnd = <S extends SectionStroke>(strokes: readonly S[], sections: readonly InkSection<S>[], section: InkSection<S>, sheet: SheetPx) => {
  const next = nextSpanTop(sections, section)
  if (next !== null) return next
  let lowest = section.bodyTop.y
  for (const stroke of bodyStrokes(strokes, sections, section)) lowest = Math.max(lowest, strokeBottom(stroke))
  for (const other of sections) {
    if (other.parentId !== section.id || other.top.y < section.bodyTop.y) continue
    lowest = Math.max(lowest, other.bodyTop.y)
  }
  return lowest === section.bodyTop.y ? section.bodyTop.y : lowest + SECTION_BODY_MARGIN_PX / sheet.height
}

/** Index among sections only. A subsection does not take a heading slot. */
export const topLevelSectionIndex = <S extends SectionStroke>(sections: readonly InkSection<S>[], id: string) => (
  sortSections(sections).filter((section) => section.parentId === null).findIndex((section) => section.id === id)
)

/** A saved or pasted title: no control characters, no surrounding space, capped. */
export const readSectionTitle = (value: unknown) => {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, SECTION_TITLE_MAX)
}

/** Keeps a right edge inside the limits. Anything else is the sheet's right edge. */
export const clampSectionWidth = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return 1
  return Math.min(SUBSECTION_WIDTH_MAX, Math.max(SUBSECTION_WIDTH_MIN, parsed))
}

/** Keeps a left edge on the sheet and at least the minimum span away from `right`. Anything else is the sheet's left edge. */
export const clampSectionLeft = (value: unknown, right: number) => {
  const edge = Number.isFinite(right) ? right : SUBSECTION_WIDTH_MAX
  const maxLeft = Math.max(0, edge - SUBSECTION_WIDTH_MIN)
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.min(maxLeft, Math.max(0, parsed))
}

const fitSectionRight = (left: number, requested: number) => {
  const minRight = left + SUBSECTION_WIDTH_MIN
  if (minRight >= SUBSECTION_WIDTH_MAX) return { left: SUBSECTION_WIDTH_MAX - SUBSECTION_WIDTH_MIN, width: SUBSECTION_WIDTH_MAX }
  return { left, width: Math.max(clampSectionWidth(requested), minRight) }
}

const fitSectionLeft = (requested: number, width: number) => {
  const right = clampSectionWidth(width)
  return { left: clampSectionLeft(requested, right), width: right }
}

/**
 * Sets one band's right edge. The left edge stays unless the span would
 * become shorter than the minimum. No stroke moves and the sheet size is
 * left untouched — the note text is not part of this.
 */
export const applySectionWidth = <S extends SectionStroke>(section: InkSection<S>, width: number) => {
  const fitted = fitSectionRight(Number.isFinite(section.left) ? section.left : 0, width)
  section.left = fitted.left
  section.width = fitted.width
  return section.width
}

const writeSectionEdges = <S extends SectionStroke>(section: InkSection<S>, left: number, width: number, changed: { value: boolean }) => {
  if (section.left !== left || section.width !== width) changed.value = true
  section.left = left
  section.width = width
  const nested = section.hidden?.sections
  if (nested) for (const child of nested) writeSectionEdges(child, left, width, changed)
}

/**
 * Copies one left edge and one right edge onto every section, including
 * bands parked inside a collapsed body. Strokes and the page stay put.
 * `width` is the right edge. Passing only one side keeps the other side of
 * `id` and stops at the minimum span.
 */
export const applySharedSectionEdges = <S extends SectionStroke>(
  sections: readonly InkSection<S>[],
  id: string,
  patch: { left?: number; width?: number },
) => {
  const sample = sections.find((section) => section.id === id)
  if (!sample) return { left: 0, width: 1, changed: false }
  let left = Number.isFinite(sample.left) ? sample.left : 0
  let width = clampSectionWidth(sample.width)
  if (patch.width !== undefined) {
    const fitted = fitSectionRight(left, patch.width)
    left = fitted.left
    width = fitted.width
  }
  if (patch.left !== undefined) {
    const fitted = fitSectionLeft(patch.left, width)
    left = fitted.left
    width = fitted.width
  }
  const changed = { value: false }
  for (const section of sections) writeSectionEdges(section, left, width, changed)
  return { left, width, changed: changed.value }
}

/**
 * Moves every tracked stroke whose top is at or below `boundary` by `delta`
 * (both 0–1 of the sheet) and every section edge at or below it. Points are
 * mutated in place exactly once even when live ink and history snapshots share
 * them, so undo after the move lands where the ink is now.
 */
export const shiftFrom = <S extends SectionStroke>(
  boundary: number,
  delta: number,
  sections: readonly InkSection<S>[],
  forEachTrackedStroke: TrackedStrokeVisitor<S>,
  skip: { strokes?: ReadonlySet<S>; edges?: ReadonlySet<StrokePoint> } = {},
) => {
  if (delta === 0) return
  const seen = new Set<StrokePoint>()
  forEachTrackedStroke((stroke) => {
    if (skip.strokes?.has(stroke) || strokeTop(stroke) < boundary) return
    for (const point of stroke.points) {
      if (seen.has(point)) continue
      seen.add(point)
      point.y += delta
    }
  })
  for (const section of sections) {
    for (const edge of [section.top, section.bodyTop]) {
      if (seen.has(edge) || skip.edges?.has(edge) || edge.y < boundary) continue
      seen.add(edge)
      edge.y += delta
    }
  }
}

export type InsertSectionPlan<S extends SectionStroke> = {
  /** The new section, on the sheet as it is before the grow. Track it before growing so its edges ride along. */
  section: InkSection<S>
  /** Sheet px the page has to grow by before the shift is applied. */
  growPx: number
}

/**
 * Plans a header at `y` (0–1 of the current sheet). The page grows by the header
 * height — plus whatever keeps the new body from being squeezed to nothing
 * against a header right below — and everything from `y` down moves by that.
 * Returns `null` when `y` lands inside an existing header.
 */
export const planInsertSection = <S extends SectionStroke>(
  sections: readonly InkSection<S>[],
  y: number,
  sheet: SheetPx,
  id: string,
  options?: { nested?: boolean },
): InsertSectionPlan<S> | null => {
  if (sections.some((section) => isInHeader(section, y))) return null
  const nested = options?.nested === true
  let parentId: string | null = null
  let headerPx = SECTION_HEADER_PX
  let minBodyPx = SECTION_MIN_BODY_PX
  if (nested) {
    const index = sectionIndexAt(sections, y)
    const host = index < 0 ? null : sections[index]
    if (!host) return null
    parentId = host.parentId ?? host.id
    const parent = sections.find((section) => section.id === parentId) ?? null
    if (!parent || parent.parentId !== null || parent.collapsed) return null
    if (y < parent.bodyTop.y) return null
    const spanEnd = nextSpanTop(sections, parent)
    if (spanEnd !== null && y >= spanEnd) return null
    headerPx = SUBSECTION_HEADER_PX
    minBodyPx = SUBSECTION_MIN_BODY_PX
  }
  const yPx = y * sheet.height
  let growPx = headerPx
  let nextPx: number | null = null
  for (const section of sections) {
    const topPx = section.top.y * sheet.height
    if (topPx >= yPx && (nextPx === null || topPx < nextPx)) nextPx = topPx
  }
  if (nextPx !== null) {
    const bodyPx = nextPx - yPx
    if (bodyPx < minBodyPx) growPx += minBodyPx - bodyPx
  }
  const adopted = (parentId ? sections.find((section) => section.id === parentId) : undefined) ?? sections[0]
  const width = adopted ? clampSectionWidth(adopted.width) : 1
  const left = adopted ? clampSectionLeft(adopted.left, width) : 0
  return {
    growPx,
    section: {
      id,
      parentId,
      left,
      width,
      top: sectionPoint(0, y),
      bodyTop: sectionPoint(0, y + headerPx / sheet.height),
      collapsed: false,
      title: '',
      hidden: null,
    },
  }
}

/**
 * Applies a planned insert on the grown sheet: everything from the new header
 * down (the new section's own edges excepted) moves by the grow. `sections`
 * must already contain the new section.
 */
export const insertSection = <S extends SectionStroke>(
  plan: InsertSectionPlan<S>,
  sections: readonly InkSection<S>[],
  sheet: SheetPx,
  forEachTrackedStroke: TrackedStrokeVisitor<S>,
) => {
  const { section } = plan
  shiftFrom(section.top.y, plan.growPx / sheet.height, sections, forEachTrackedStroke, { edges: new Set([section.top, section.bodyTop]) })
  if (section.parentId !== null) return
  // A section inserted through an existing body takes the subsections that
  // landed inside it, so they collapse and expand with their new parent.
  const spanEnd = nextSpanTop(sections, section)
  for (const other of sections) {
    if (other === section || other.parentId === null || other.top.y < section.bodyTop.y) continue
    if (spanEnd !== null && other.top.y >= spanEnd) continue
    other.parentId = section.id
  }
}

export type CollapsePlan<S extends SectionStroke> = {
  section: InkSection<S>
  hiddenStrokes: S[]
  /** Body height in sheet px; the page shrinks by this after the shift. */
  hiddenPx: number
  bodyEnd: number
}

export const planCollapse = <S extends SectionStroke>(strokes: readonly S[], sections: readonly InkSection<S>[], section: InkSection<S>, sheet: SheetPx): CollapsePlan<S> | null => {
  if (section.collapsed) return null
  const bodyEnd = collapsibleBodyEnd(strokes, sections, section, sheet)
  return {
    section,
    hiddenStrokes: bodyStrokes(strokes, sections, section),
    hiddenPx: Math.max(0, (bodyEnd - section.bodyTop.y) * sheet.height),
    bodyEnd,
  }
}

/**
 * Executes a collapse on the current sheet: body strokes are lifted into the
 * section (normalised to the body box), everything from the body end down moves
 * up. Returns the live strokes without the hidden ones. The caller shrinks the
 * page by `plan.hiddenPx` afterwards.
 */
export const collapseSection = <S extends SectionStroke>(
  plan: CollapsePlan<S>,
  strokes: readonly S[],
  sections: readonly InkSection<S>[],
  sheet: SheetPx,
  forEachTrackedStroke: TrackedStrokeVisitor<S>,
  cloneStroke: (stroke: S, points: StrokePoint[]) => S,
): S[] => {
  const { section, hiddenStrokes, hiddenPx, bodyEnd } = plan
  const hiddenSet = new Set(hiddenStrokes)
  const box = { widthPx: sheet.width, heightPx: Math.max(1, hiddenPx) }
  const bodyTopPx = section.bodyTop.y * sheet.height
  const live = sections as InkSection<S>[]
  const parked: InkSection<S>[] = []
  for (let index = live.length - 1; index >= 0; index -= 1) {
    const other = live[index]!
    if (other.parentId !== section.id || other.top.y < section.bodyTop.y || other.top.y >= bodyEnd) continue
    parked.push(other)
    live.splice(index, 1)
  }
  parked.reverse()
  for (const child of parked) {
    child.top = sectionPoint(0, (child.top.y * sheet.height - bodyTopPx) / box.heightPx)
    child.bodyTop = sectionPoint(0, (child.bodyTop.y * sheet.height - bodyTopPx) / box.heightPx)
  }
  section.hidden = {
    ...box,
    strokes: hiddenStrokes.map((stroke) => cloneStroke(stroke, stroke.points.map((point) => ({
      ...point,
      x: point.x,
      y: (point.y * sheet.height - bodyTopPx) / box.heightPx,
    })))),
    sections: parked,
  }
  section.collapsed = true
  // Edges sitting exactly on the body end (the next header) land exactly on this
  // body top, not a floating-point hair away: the expand shifts from that edge.
  const seam = sections.flatMap((other) => [other.top, other.bodyTop]).filter((edge) => edge !== section.bodyTop && edge.y === bodyEnd)
  shiftFrom(bodyEnd, -hiddenPx / sheet.height, sections, forEachTrackedStroke, { strokes: hiddenSet })
  for (const edge of seam) edge.y = section.bodyTop.y
  return strokes.filter((stroke) => !hiddenSet.has(stroke))
}

/**
 * Executes an expand on a sheet that the caller has already grown by
 * `section.hidden.heightPx`: everything from the body top down moves by that
 * height and the hidden ink returns to the body. Returns the live strokes with
 * the restored ones appended.
 */
export const expandSection = <S extends SectionStroke>(
  strokes: readonly S[],
  sections: readonly InkSection<S>[],
  section: InkSection<S>,
  sheet: SheetPx,
  forEachTrackedStroke: TrackedStrokeVisitor<S>,
  cloneStroke: (stroke: S, points: StrokePoint[]) => S,
): S[] => {
  const hidden = section.hidden
  const parked = hidden?.sections ?? []
  section.collapsed = false
  section.hidden = null
  if (!hidden) return [...strokes]
  // The body top itself sits on the boundary and stays; everything else from there down moves.
  shiftFrom(section.bodyTop.y, hidden.heightPx / sheet.height, sections, forEachTrackedStroke, { edges: new Set([section.bodyTop]) })
  const bodyTopPx = section.bodyTop.y * sheet.height
  const restored = hidden.strokes.map((stroke) => cloneStroke(stroke, stroke.points.map((point) => ({
    ...point,
    x: point.x * hidden.widthPx / sheet.width,
    y: (bodyTopPx + point.y * hidden.heightPx) / sheet.height,
  }))))
  const live = sections as InkSection<S>[]
  for (const child of parked) {
    const fromBox = (y: number) => (hidden.heightPx > 0 ? (bodyTopPx + y * hidden.heightPx) / sheet.height : section.bodyTop.y)
    child.top = sectionPoint(0, fromBox(child.top.y))
    child.bodyTop = sectionPoint(0, fromBox(child.bodyTop.y))
    live.push(child)
  }
  return [...strokes, ...restored]
}

export type RoomPlan<S extends SectionStroke> = {
  /** Sheet px the page grows by; everything from the next header down moves by it. */
  growPx: number
  /** The section right below; after the grow its `top` is the shift boundary. */
  next: InkSection<S>
}

/**
 * After a stroke lands in an expanded section that has another section below,
 * the body grows so the pen keeps a write margin before the next header.
 */
export const planBodyRoom = <S extends SectionStroke>(stroke: S, sections: readonly InkSection<S>[], sheet: SheetPx): RoomPlan<S> | null => {
  const top = strokeTop(stroke)
  const index = sectionIndexAt(sections, top)
  if (index < 0) return null
  const section = sections[index]!
  if (section.collapsed || top < section.bodyTop.y) return null
  const nextTop = nextSectionTop(sections, section)
  if (nextTop === null) return null
  const next = sections.find((other) => other !== section && other.top.y === nextTop)
  if (!next) return null
  const bottomPx = strokeBottom(stroke) * sheet.height
  const endPx = nextTop * sheet.height
  const growPx = Math.ceil(bottomPx + SECTION_BODY_MARGIN_PX - endPx)
  return growPx > 0 ? { growPx, next } : null
}

/** Applies a room plan on the grown sheet. */
export const growBodyRoom = <S extends SectionStroke>(
  plan: RoomPlan<S>,
  sections: readonly InkSection<S>[],
  sheet: SheetPx,
  forEachTrackedStroke: TrackedStrokeVisitor<S>,
) => {
  shiftFrom(plan.next.top.y, plan.growPx / sheet.height, sections, forEachTrackedStroke)
}

export type SectionSpan = { start: number; end: number }

const siblingBands = <S extends SectionStroke>(sections: readonly InkSection<S>[], parentId: string | null) => (
  sortSections(sections).filter((section) => section.parentId === parentId)
)

/**
 * The band this section occupies among its siblings. A section that has
 * another below it runs up to that header. The last one runs through its ink
 * and the write margin, not through the empty page under it.
 */
export const sectionBlockSpan = <S extends SectionStroke>(
  strokes: readonly S[],
  sections: readonly InkSection<S>[],
  section: InkSection<S>,
  sheet: SheetPx,
  nextTop: number | null,
): SectionSpan => {
  const start = section.top.y
  const end = nextTop === null
    ? Math.max(section.bodyTop.y, collapsibleBodyEnd(strokes, sections, section, sheet))
    : nextTop
  return { start, end: Math.max(end, section.bodyTop.y) }
}

/** Where `sectionId` sits among its siblings, and the span of each sibling. */
export const sectionMoveLayout = <S extends SectionStroke>(
  strokes: readonly S[],
  sections: readonly InkSection<S>[],
  sectionId: string,
  sheet: SheetPx,
) => {
  const section = sections.find((entry) => entry.id === sectionId)
  if (!section) return null
  const siblings = siblingBands(sections, section.parentId)
  const fromIndex = siblings.findIndex((entry) => entry.id === sectionId)
  if (fromIndex < 0) return null
  const spans = siblings.map((entry, index) => sectionBlockSpan(
    strokes,
    sections,
    entry,
    sheet,
    index + 1 < siblings.length ? siblings[index + 1]!.top.y : null,
  ))
  return { fromIndex, spans }
}

/**
 * Final sibling index while dragging. `y` is 0–1 of the sheet. Siblings whose
 * middle is above the pointer count as already passed.
 */
export const sectionDropIndex = (spans: readonly SectionSpan[], fromIndex: number, y: number) => {
  let index = 0
  for (let cursor = 0; cursor < spans.length; cursor += 1) {
    if (cursor === fromIndex) continue
    const span = spans[cursor]!
    if (y > (span.start + span.end) / 2) index += 1
  }
  return index
}

/** Sheet fraction where the moved band will start, or `null` when the order would not change. */
export const sectionReorderMark = (spans: readonly SectionSpan[], fromIndex: number, toIndex: number) => {
  if (toIndex === fromIndex || toIndex < 0 || toIndex >= spans.length) return null
  return toIndex < fromIndex ? spans[toIndex]!.start : spans[toIndex]!.end
}

const shiftOwnedPoints = (points: readonly StrokePoint[], delta: number, seen: Set<StrokePoint>) => {
  if (delta === 0) return
  for (const point of points) {
    if (seen.has(point)) continue
    seen.add(point)
    point.y += delta
  }
}

/**
 * Moves a section to `toIndex` among its siblings (0 is the top). The header,
 * the body ink, and any subsections move together. Ink above the group, and
 * the empty page below the last band, stay put. The sheet size does not change.
 * Returns false when the section is missing, alone, or already there.
 */
export const reorderSection = <S extends SectionStroke>(
  strokes: readonly S[],
  sections: readonly InkSection<S>[],
  sectionId: string,
  toIndex: number,
  sheet: SheetPx,
  forEachTrackedStroke: TrackedStrokeVisitor<S>,
) => {
  const layout = sectionMoveLayout(strokes, sections, sectionId, sheet)
  if (!layout || layout.spans.length < 2) return false
  const target = Math.max(0, Math.min(layout.spans.length - 1, Math.round(toIndex)))
  if (target === layout.fromIndex) return false
  const { spans, fromIndex } = layout
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!
    if (!(span.end > span.start)) return false
    if (index > 0 && span.start < spans[index - 1]!.end - 1e-6) return false
  }
  const section = sections.find((entry) => entry.id === sectionId)!
  const siblings = siblingBands(sections, section.parentId)
  const order = siblings.map((_, index) => index)
  const [moved] = order.splice(fromIndex, 1)
  order.splice(target, 0, moved!)
  let cursor = spans[0]!.start
  const deltas = spans.map(() => 0)
  for (const index of order) {
    deltas[index] = cursor - spans[index]!.start
    cursor += spans[index]!.end - spans[index]!.start
  }
  const seen = new Set<StrokePoint>()
  const deltaAt = (y: number) => {
    for (let index = 0; index < spans.length; index += 1) {
      const span = spans[index]!
      if (y >= span.start && y < span.end) return deltas[index]!
    }
    return 0
  }
  forEachTrackedStroke((stroke) => {
    shiftOwnedPoints(stroke.points, deltaAt(strokeTop(stroke)), seen)
  })
  for (let index = 0; index < siblings.length; index += 1) {
    const delta = deltas[index]!
    if (delta === 0) continue
    const span = spans[index]!
    const root = siblings[index]!
    for (const entry of sections) {
      if (entry !== root && (entry.top.y < span.start || entry.top.y >= span.end)) continue
      shiftOwnedPoints([entry.top, entry.bodyTop], delta, seen)
    }
  }
  return true
}

export type SerializedSection = {
  id: string
  top: number
  bodyTop: number
  collapsed: boolean
  parentId?: string
  /** Omitted when the band starts at the sheet's left edge, so older drawings stay valid. */
  left?: number
  width?: number
  /** Omitted when the band has no typed title, so older drawings stay valid. */
  title?: string
  hidden: { widthPx: number; heightPx: number; strokes: unknown[]; sections?: SerializedSection[] } | null
}

const serializeOne = <S extends SectionStroke>(section: InkSection<S>): SerializedSection => ({
  id: section.id,
  top: section.top.y,
  bodyTop: section.bodyTop.y,
  collapsed: section.collapsed,
  ...(section.parentId ? { parentId: section.parentId } : {}),
  ...(section.left ? { left: section.left } : {}),
  ...(section.width !== 1 ? { width: section.width } : {}),
  ...(section.title.trim() ? { title: section.title.trim().slice(0, SECTION_TITLE_MAX) } : {}),
  hidden: section.hidden ? {
    widthPx: section.hidden.widthPx,
    heightPx: section.hidden.heightPx,
    strokes: section.hidden.strokes,
    ...(section.hidden.sections.length ? { sections: sortSections(section.hidden.sections).map(serializeOne) } : {}),
  } : null,
})

export const serializeSections = <S extends SectionStroke>(sections: readonly InkSection<S>[]): SerializedSection[] => (
  sortSections(sections).map(serializeOne)
)

const readSectionList = <S extends SectionStroke>(value: unknown, parseStrokes: (raw: unknown) => S[], allowNested: boolean): { section: InkSection<S>; hadParent: boolean }[] => {
  if (!Array.isArray(value)) return []
  const sections: { section: InkSection<S>; hadParent: boolean }[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Partial<SerializedSection>
    const top = Number(raw.top)
    const bodyTop = Number(raw.bodyTop)
    if (!Number.isFinite(top) || !Number.isFinite(bodyTop) || bodyTop <= top || top < 0 || bodyTop > 1.5) continue
    const id = typeof raw.id === 'string' && raw.id.length <= 64 ? raw.id : `section-${sections.length + 1}`
    const hadParent = typeof raw.parentId === 'string' && raw.parentId.length > 0
    const parentId = hadParent && raw.parentId!.length <= 64 && raw.parentId !== id ? raw.parentId! : null
    const width = clampSectionWidth(raw.width)
    const left = clampSectionLeft(raw.left, width)
    let hidden: HiddenSectionInk<S> | null = null
    if (raw.hidden && typeof raw.hidden === 'object') {
      const widthPx = Number(raw.hidden.widthPx)
      const heightPx = Number(raw.hidden.heightPx)
      if (Number.isFinite(widthPx) && widthPx > 0 && Number.isFinite(heightPx) && heightPx > 0) {
        const nested = allowNested ? readSectionList(raw.hidden.sections, parseStrokes, false) : []
        hidden = {
          widthPx,
          heightPx,
          strokes: parseStrokes(raw.hidden.strokes),
          sections: nested.map((entry) => {
            entry.section.parentId = id
            entry.section.width = clampSectionWidth(entry.section.width)
            entry.section.left = clampSectionLeft(entry.section.left, entry.section.width)
            return entry.section
          }),
        }
      }
    }
    sections.push({
      hadParent,
      section: {
        id,
        parentId,
        left,
        width,
        top: sectionPoint(0, top),
        bodyTop: sectionPoint(0, bodyTop),
        collapsed: raw.collapsed === true,
        title: readSectionTitle(raw.title),
        hidden: raw.collapsed === true ? hidden : null,
      },
    })
  }
  return sections
}

/** Rebuilds sections from a saved document; `parseStrokes` sanitises hidden ink. */
export const deserializeSections = <S extends SectionStroke>(value: unknown, parseStrokes: (raw: unknown) => S[]): InkSection<S>[] => {
  const parsed = readSectionList(value, parseStrokes, true)
  const topLevel = new Set(parsed.filter((entry) => entry.section.parentId === null && !entry.hadParent).map((entry) => entry.section.id))
  const sections = parsed.filter((entry) => (
    entry.section.parentId === null ? !entry.hadParent : topLevel.has(entry.section.parentId)
  )).map((entry) => entry.section)
  return sortSections(sections)
}
