/**
 * Collapsible handwriting sections.
 *
 * A section is a horizontal band on the ink sheet: a header (where the title is
 * written by hand) followed by a body that reaches down to the next section's
 * header — or, for the last section, to the end of the page. Collapsing a
 * section lifts its body ink off the sheet and pulls everything below up by
 * the body's height; expanding puts it back. Ink stays a flat 0–1 stroke list
 * the whole time, so painting, erasing, selection and saving never learn about
 * sections: they only see the current layout.
 *
 * Section edges are `StrokePoint`s. The board remaps every tracked point when
 * the sheet grows, pads or rescales, and by being points the edges ride along.
 * Hidden body ink is stored normalised to its own box (width × height in sheet
 * px at collapse time) so a later sheet resize cannot make it stale.
 */
import type { StrokePoint } from '../../../src/types'
import { WRITE_MARGIN_X } from './noteCanvas'

/** Height of the title band in sheet px (≈ 17 mm on the A4 column). */
export const SECTION_HEADER_PX = 72
/** Room kept below the lowest stroke of a body so the pen never runs into the next header. */
export const SECTION_BODY_MARGIN_PX = WRITE_MARGIN_X
/** A body never becomes shorter than this when a header is inserted right above another one. */
export const SECTION_MIN_BODY_PX = 144

export type SectionStroke = { points: StrokePoint[] }

export type HiddenSectionInk<S extends SectionStroke> = {
  /** Sheet px the hidden strokes are normalised against. */
  widthPx: number
  heightPx: number
  /** Body ink, x 0–1 of `widthPx`, y 0–1 of `heightPx` measured from the body top. */
  strokes: S[]
}

export type InkSection<S extends SectionStroke = SectionStroke> = {
  id: string
  /** Header top edge, 0–1 of the sheet. */
  top: StrokePoint
  /** Header bottom edge = body top, 0–1 of the sheet. */
  bodyTop: StrokePoint
  collapsed: boolean
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

/** Next header's top, or `null` for the last section (its body runs to the page end). */
export const nextSectionTop = <S extends SectionStroke>(sections: readonly InkSection<S>[], section: InkSection<S>) => {
  let next: number | null = null
  for (const other of sections) {
    if (other === section || other.top.y < section.bodyTop.y) continue
    if (next === null || other.top.y < next) next = other.top.y
  }
  return next
}

/** Live strokes whose top lies in the section's body. */
export const bodyStrokes = <S extends SectionStroke>(strokes: readonly S[], sections: readonly InkSection<S>[], section: InkSection<S>) => {
  const end = nextSectionTop(sections, section) ?? Number.POSITIVE_INFINITY
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
  const next = nextSectionTop(sections, section)
  if (next !== null) return next
  let lowest = section.bodyTop.y
  for (const stroke of bodyStrokes(strokes, sections, section)) lowest = Math.max(lowest, strokeBottom(stroke))
  return lowest === section.bodyTop.y ? section.bodyTop.y : lowest + SECTION_BODY_MARGIN_PX / sheet.height
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
export const planInsertSection = <S extends SectionStroke>(sections: readonly InkSection<S>[], y: number, sheet: SheetPx, id: string): InsertSectionPlan<S> | null => {
  if (sections.some((section) => isInHeader(section, y))) return null
  const yPx = y * sheet.height
  let growPx = SECTION_HEADER_PX
  let nextPx: number | null = null
  for (const section of sections) {
    const topPx = section.top.y * sheet.height
    if (topPx >= yPx && (nextPx === null || topPx < nextPx)) nextPx = topPx
  }
  if (nextPx !== null) {
    const bodyPx = nextPx - yPx
    if (bodyPx < SECTION_MIN_BODY_PX) growPx += SECTION_MIN_BODY_PX - bodyPx
  }
  return {
    growPx,
    section: {
      id,
      top: sectionPoint(0, y),
      bodyTop: sectionPoint(0, y + SECTION_HEADER_PX / sheet.height),
      collapsed: false,
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
  section.hidden = {
    ...box,
    strokes: hiddenStrokes.map((stroke) => cloneStroke(stroke, stroke.points.map((point) => ({
      ...point,
      x: point.x,
      y: (point.y * sheet.height - bodyTopPx) / box.heightPx,
    })))),
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

export type SerializedSection = {
  id: string
  top: number
  bodyTop: number
  collapsed: boolean
  hidden: { widthPx: number; heightPx: number; strokes: unknown[] } | null
}

export const serializeSections = <S extends SectionStroke>(sections: readonly InkSection<S>[]): SerializedSection[] => (
  sortSections(sections).map((section) => ({
    id: section.id,
    top: section.top.y,
    bodyTop: section.bodyTop.y,
    collapsed: section.collapsed,
    hidden: section.hidden ? { widthPx: section.hidden.widthPx, heightPx: section.hidden.heightPx, strokes: section.hidden.strokes } : null,
  }))
)

/** Rebuilds sections from a saved document; `parseStrokes` sanitises hidden ink. */
export const deserializeSections = <S extends SectionStroke>(value: unknown, parseStrokes: (raw: unknown) => S[]): InkSection<S>[] => {
  if (!Array.isArray(value)) return []
  const sections: InkSection<S>[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Partial<SerializedSection>
    const top = Number(raw.top)
    const bodyTop = Number(raw.bodyTop)
    if (!Number.isFinite(top) || !Number.isFinite(bodyTop) || bodyTop <= top || top < 0 || bodyTop > 1.5) continue
    const id = typeof raw.id === 'string' && raw.id.length <= 64 ? raw.id : `section-${sections.length + 1}`
    let hidden: HiddenSectionInk<S> | null = null
    if (raw.hidden && typeof raw.hidden === 'object') {
      const widthPx = Number(raw.hidden.widthPx)
      const heightPx = Number(raw.hidden.heightPx)
      if (Number.isFinite(widthPx) && widthPx > 0 && Number.isFinite(heightPx) && heightPx > 0) {
        hidden = { widthPx, heightPx, strokes: parseStrokes(raw.hidden.strokes) }
      }
    }
    sections.push({ id, top: sectionPoint(0, top), bodyTop: sectionPoint(0, bodyTop), collapsed: raw.collapsed === true, hidden: raw.collapsed === true ? hidden : null })
  }
  return sortSections(sections)
}
