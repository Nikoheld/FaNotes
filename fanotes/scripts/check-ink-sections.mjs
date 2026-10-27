// Collapsible handwriting sections: header insert, body growth, collapse,
// expand and persistence keep every stroke on its paper pixel and never lose
// ink — including strokes that only live in undo history.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const {
  SECTION_BODY_MARGIN_PX,
  SECTION_HEADER_PX,
  SECTION_MIN_BODY_PX,
  SUBSECTION_HEADER_PX,
  SUBSECTION_WIDTH_MIN,
  applySectionWidth,
  applySharedSectionEdges,
  collapseSection,
  collapsibleBodyEnd,
  deserializeSections,
  expandSection,
  growBodyRoom,
  headerStrokeCount,
  insertSection,
  nextSectionTop,
  planBodyRoom,
  planCollapse,
  planInsertSection,
  planMergeSections,
  sectionsAfterMerge,
  reorderSection,
  sectionDropIndex,
  sectionReorderMark,
  sectionIndexAt,
  serializeSections,
  sortSections,
  topLevelSectionIndex,
} = await server.ssrLoadModule('/src/lib/inkSections.ts')

// ── A tiny model of the board ────────────────────────────────────────────────
// Strokes are 0–1 of the sheet; the page grows and shrinks by re-normalising
// every tracked point so that px positions stay put — exactly what
// DrawingBoard.setPageExtent does with keepMarkOnPage.
const WIDTH = 900
const point = (x, yPx, height) => ({ x: x / WIDTH, y: yPx / height, t: 0, pressure: .5, tiltX: 0, tiltY: 0, pointerType: 'pen' })
const strokeAt = (yPx, height, span = 20, x = 200) => ({
  color: '#000000',
  baseWidth: 4,
  pressureEnabled: true,
  points: [point(x, yPx, height), point(x + 40, yPx + span, height)],
})
const clone = (stroke, points) => ({ ...stroke, points })

const createBoard = (height) => {
  const board = {
    sheet: { width: WIDTH, height },
    strokes: [],
    history: [],
    sections: [],
    tracked(visit) {
      const seen = new Set()
      for (const list of [board.strokes, ...board.history]) {
        for (const stroke of list) {
          if (seen.has(stroke)) continue
          seen.add(stroke)
          visit(stroke)
        }
      }
    },
    /** setPageExtent: every tracked point (and every section edge) keeps its px. */
    resize(nextHeight) {
      const prev = board.sheet.height
      const next = Math.max(144, Math.round(nextHeight))
      if (next === prev) return
      const seen = new Set()
      board.tracked((stroke) => {
        for (const p of stroke.points) {
          if (seen.has(p)) continue
          seen.add(p)
          p.y = (p.y * prev) / next
        }
      })
      for (const section of board.sections) {
        for (const edge of [section.top, section.bodyTop]) {
          if (seen.has(edge)) continue
          seen.add(edge)
          edge.y = (edge.y * prev) / next
        }
      }
      board.sheet = { width: WIDTH, height: next }
    },
    px(value) { return value * board.sheet.height },
    topPx(stroke) { return Math.min(...stroke.points.map((p) => p.y)) * board.sheet.height },
    insert(yPx, id) {
      const plan = planInsertSection(board.sections, yPx / board.sheet.height, board.sheet, id)
      if (!plan) return null
      board.sections = sortSections([...board.sections, plan.section])
      board.resize(board.sheet.height + plan.growPx)
      insertSection(plan, board.sections, board.sheet, board.tracked)
      return plan.section
    },
    insertSub(yPx, id) {
      const plan = planInsertSection(board.sections, yPx / board.sheet.height, board.sheet, id, { nested: true })
      if (!plan) return null
      board.sections = sortSections([...board.sections, plan.section])
      board.resize(board.sheet.height + plan.growPx)
      insertSection(plan, board.sections, board.sheet, board.tracked)
      return plan.section
    },
    collapse(section) {
      const plan = planCollapse(board.strokes, board.sections, section, board.sheet)
      board.strokes = collapseSection(plan, board.strokes, board.sections, board.sheet, board.tracked, clone)
      if (plan.hiddenPx > 0) board.resize(board.sheet.height - plan.hiddenPx)
      return plan
    },
    expand(section) {
      board.resize(board.sheet.height + (section.hidden?.heightPx ?? 0))
      board.strokes = expandSection(board.strokes, board.sections, section, board.sheet, board.tracked, clone)
    },
    write(yPx, span) {
      const stroke = strokeAt(yPx, board.sheet.height, span)
      board.history.push(board.strokes.slice())
      board.strokes.push(stroke)
      const plan = planBodyRoom(stroke, board.sections, board.sheet)
      if (plan) {
        board.resize(board.sheet.height + plan.growPx)
        growBodyRoom(plan, board.sections, board.sheet, board.tracked)
      }
      return stroke
    },
  }
  return board
}

const near = (actual, expected, message, tolerance = 0.51) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} ≠ ${expected}`)

// ── Inserting a header pushes the page apart instead of covering ink ────────
{
  const board = createBoard(1273)
  const above = strokeAt(300, 1273)
  const below = strokeAt(600, 1273)
  board.strokes.push(above, below)
  const erased = strokeAt(700, 1273)
  board.history.push([above, below, erased])

  const section = board.insert(500, 'a')
  assert.ok(section, 'a header lands on free paper')
  assert.equal(section.parentId, null, 'a section has no parent')
  assert.equal(section.width, 1, 'a section is full width')
  assert.equal(section.left, 0, 'a section starts at the left edge')
  assert.equal(section.title, '', 'a new section starts without a typed title')
  near(board.sheet.height, 1273 + SECTION_HEADER_PX, 'the page grew by the header')
  near(board.topPx(above), 300, 'ink above the header stays')
  near(board.topPx(below), 600 + SECTION_HEADER_PX, 'ink below moved down by the header')
  near(board.topPx(erased), 700 + SECTION_HEADER_PX, 'ink that only lives in history moved too (undo lands where the page is now)')
  near(board.px(section.top.y), 500, 'header top is where the pen tapped')
  near(board.px(section.bodyTop.y), 500 + SECTION_HEADER_PX, 'header height')
  assert.equal(sectionIndexAt(board.sections, section.bodyTop.y + .01), 0, 'the body belongs to the section')
  assert.equal(sectionIndexAt(board.sections, .01), -1, 'ink above the first header is in no section')
  assert.equal(planInsertSection(board.sections, section.top.y + .001, board.sheet, 'x'), null, 'no header inside a header')

  // A header right above another one keeps a minimum body.
  const squeezed = board.insert(board.px(section.top.y) - 10, 'b')
  const bodyPx = board.px(nextSectionTop(board.sections, squeezed)) - board.px(squeezed.bodyTop.y)
  near(bodyPx, SECTION_MIN_BODY_PX, 'a body squeezed against the next header is padded to the minimum')
}

// ── Writing near the body end pushes the next section down ─────────────────
{
  const board = createBoard(1273)
  const first = board.insert(200, 'first')
  const second = board.insert(600 + SECTION_HEADER_PX, 'second')
  const secondTopBefore = board.px(second.top.y)
  const title = board.write(board.px(second.top.y) + 20, 20)
  assert.equal(headerStrokeCount(board.strokes, second), 1, 'a stroke in the header band is the title')
  assert.equal(planBodyRoom(title, board.sections, board.sheet), null, 'a title never grows the body')

  const deep = board.write(secondTopBefore - 30, 20)
  const secondTopAfter = board.px(second.top.y)
  const bottomPx = Math.max(...deep.points.map((p) => p.y)) * board.sheet.height
  near(secondTopAfter, bottomPx + SECTION_BODY_MARGIN_PX, 'the next header keeps a write margin below the stroke', 1.01)
  near(board.topPx(title), secondTopAfter + 20, 'the next title moved with its header')
  assert.ok(board.topPx(deep) < secondTopAfter, 'the stroke itself stays in the first body')
  assert.ok(planBodyRoom(strokeAt(board.px(first.bodyTop.y) + 5, board.sheet.height), board.sections, board.sheet) === null, 'ink high in the body needs no room')
  assert.equal(planBodyRoom(strokeAt(board.px(second.bodyTop.y) + 200, board.sheet.height), board.sections, board.sheet), null, 'the last section grows with the page, not by pushing')
}

// ── Collapse hides the body, lifts what follows, expand restores it exactly ──
{
  const board = createBoard(1273)
  const first = board.insert(100, 'first')
  const second = board.insert(700, 'second')
  const firstTitle = board.write(board.px(first.top.y) + 10, 30)
  const body1 = board.write(board.px(first.bodyTop.y) + 40, 30)
  const body2 = board.write(board.px(first.bodyTop.y) + 300, 60)
  const secondTitle = board.write(board.px(second.top.y) + 10, 30)
  const secondBody = board.write(board.px(second.bodyTop.y) + 50, 30)
  const snapshot = (stroke) => stroke.points.map((p) => [Math.round(p.x * board.sheet.width * 100) / 100, Math.round(p.y * board.sheet.height * 100) / 100])
  const before = {
    height: board.sheet.height,
    firstTitle: snapshot(firstTitle),
    body1: snapshot(body1),
    body2: snapshot(body2),
    secondTitle: snapshot(secondTitle),
    secondBody: snapshot(secondBody),
    secondTop: board.px(second.top.y),
  }
  const bodyHeight = board.px(second.top.y) - board.px(first.bodyTop.y)
  near(board.px(collapsibleBodyEnd(board.strokes, board.sections, first, board.sheet)), before.secondTop, 'a middle body ends at the next header')

  const plan = board.collapse(first)
  assert.ok(first.collapsed && first.hidden, 'collapsed with hidden ink')
  assert.equal(plan.hiddenStrokes.length, 2, 'both body strokes were lifted')
  assert.equal(first.hidden.strokes.length, 2)
  near(first.hidden.heightPx, bodyHeight, 'hidden height is the body height')
  assert.equal(board.strokes.length, 3, 'title strokes and the second section stay on the sheet')
  assert.ok(!board.strokes.includes(body1) && !board.strokes.includes(body2), 'body ink is off the sheet')
  near(board.sheet.height, before.height - bodyHeight, 'the page shrank by the body')
  assert.equal(second.top.y, first.bodyTop.y, 'the next header now sits exactly on the collapsed body top')
  near(board.topPx(secondTitle), before.secondTitle[0][1] - bodyHeight, 'the next title moved up by the body height')
  near(board.topPx(secondBody), before.secondBody[0][1] - bodyHeight, 'ink further down moved up as well')
  assert.deepEqual(snapshot(firstTitle), before.firstTitle, 'the collapsed section keeps its title')
  for (const hidden of first.hidden.strokes) {
    for (const p of hidden.points) assert.ok(p.y >= 0 && p.y <= 1 && p.x >= 0 && p.x <= 1, 'hidden ink is normalised to its own box')
  }

  // Writing below the collapsed header works on the compact layout.
  const later = board.write(board.px(second.bodyTop.y) + 400, 20)
  const laterPx = board.topPx(later)

  board.expand(first)
  assert.ok(!first.collapsed && first.hidden === null, 'expanded')
  near(board.sheet.height, before.height, 'the page is back to its height (plus nothing: the new stroke fit)', 1.01)
  assert.equal(board.strokes.length, 6, 'body ink is back')
  const restored = board.strokes.filter((stroke) => stroke !== firstTitle && stroke !== secondTitle && stroke !== secondBody && stroke !== later)
  assert.equal(restored.length, 2)
  const restoredSnapshots = restored.map(snapshot).sort((a, b) => a[0][1] - b[0][1])
  const expected = [before.body1, before.body2].sort((a, b) => a[0][1] - b[0][1])
  for (let index = 0; index < 2; index += 1) {
    for (let k = 0; k < 2; k += 1) {
      near(restoredSnapshots[index][k][0], expected[index][k][0], 'restored x', 0.05)
      near(restoredSnapshots[index][k][1], expected[index][k][1], 'restored y', 0.05)
    }
  }
  assert.deepEqual(snapshot(secondTitle), before.secondTitle, 'the second title is back where it was')
  near(board.px(second.top.y), before.secondTop, 'the second header is back where it was', 0.05)
  near(board.topPx(later), laterPx + bodyHeight, 'ink written while collapsed moved down with the rest')

  // Collapsing the last section hides down to its lowest stroke plus the margin.
  const lowest = Math.max(...board.strokes.filter((s) => board.topPx(s) >= board.px(second.bodyTop.y)).flatMap((s) => s.points.map((p) => p.y * board.sheet.height)))
  near(board.px(collapsibleBodyEnd(board.strokes, board.sections, second, board.sheet)), lowest + SECTION_BODY_MARGIN_PX, 'last body ends below its ink')
  const heightBefore = board.sheet.height
  const lastPlan = board.collapse(second)
  assert.equal(lastPlan.hiddenStrokes.length, 2, 'both strokes of the last body are hidden')
  near(board.sheet.height, heightBefore - lastPlan.hiddenPx, 'the page shrank by the last body')
  board.expand(second)
  assert.equal(board.strokes.length, 6)

  // An empty last section collapses to a flag only.
  const empty = board.insert(board.sheet.height - 50, 'empty')
  const emptyPlan = board.collapse(empty)
  assert.equal(emptyPlan.hiddenPx, 0)
  assert.ok(empty.collapsed)
  board.expand(empty)
  assert.ok(!empty.collapsed)
}

// ── Persistence round trip ─────────────────────────────────────────────────
{
  const board = createBoard(1273)
  const first = board.insert(100, 'first')
  board.insert(700, 'second')
  board.write(board.px(first.bodyTop.y) + 40, 30)
  board.collapse(first)
  const serialized = JSON.parse(JSON.stringify(serializeSections(board.sections)))
  assert.equal(serialized.length, 2)
  assert.equal(serialized[0].id, 'first')
  assert.equal(serialized[0].collapsed, true)
  assert.equal(serialized[0].hidden.strokes.length, 1)
  assert.equal(serialized[1].hidden, null)
  const restored = deserializeSections(serialized, (value) => Array.isArray(value) ? value : [])
  assert.equal(restored.length, 2)
  assert.equal(restored[0].top.y, serialized[0].top)
  assert.equal(restored[0].bodyTop.y, serialized[0].bodyTop)
  assert.equal(restored[0].hidden.heightPx, serialized[0].hidden.heightPx)
  assert.equal(restored[0].hidden.strokes.length, 1)
  assert.deepEqual(deserializeSections([{ top: .5, bodyTop: .4 }, null, 'x', { top: 'a' }], () => []), [], 'garbage is dropped')
  assert.equal(deserializeSections([{ top: .2, bodyTop: .25, collapsed: false, hidden: { widthPx: 900, heightPx: 100, strokes: [] } }], () => [])[0].hidden, null, 'an expanded section carries no hidden ink')
  const legacy = deserializeSections([{ id: 'old', top: .1, bodyTop: .2, collapsed: false, hidden: null }], () => [])
  assert.equal(legacy[0].parentId, null, 'an old section has no parent')
  assert.equal(legacy[0].width, 1, 'an old section is full width')
  assert.equal(legacy[0].left, 0, 'an old section starts at the left edge')
  assert.equal(legacy[0].title, '', 'an old section has no typed title')
  assert.equal(Object.hasOwn(serializeSections(legacy)[0], 'title'), false, 'an empty title is not stored')
  assert.equal(Object.hasOwn(serializeSections(legacy)[0], 'left'), false, 'a left edge of zero is not stored')
  const cleaned = deserializeSections([
    { id: 'p', top: .1, bodyTop: .16, collapsed: false },
    { id: 'c', top: .2, bodyTop: .25, parentId: 'p', width: .5, collapsed: false },
    { id: 'g', top: .28, bodyTop: .33, parentId: 'c', width: .4, collapsed: false },
    { id: 'm', top: .4, bodyTop: .46, parentId: 'missing', collapsed: false },
  ], () => [])
  assert.deepEqual(cleaned.map((section) => section.id), ['p', 'c'], 'a subsection of a subsection and an orphan are dropped')
  assert.equal(cleaned[1].parentId, 'p')
  assert.equal(cleaned[1].width, .5)
}

// ── Subsections nest one level; their width never moves ink or the page ────
{
  const board = createBoard(1273)
  const parent = board.insert(120, 'parent')
  const second = board.insert(980, 'second')
  const sub = board.insertSub(board.px(parent.bodyTop.y) + 120, 'sub')
  assert.ok(parent && second && sub, 'a subsection lands in a section body')
  assert.equal(sub.parentId, parent.id)
  assert.equal(sub.width, 1)
  near(board.px(sub.bodyTop.y) - board.px(sub.top.y), SUBSECTION_HEADER_PX, 'a subsection header is shorter than a section header')
  const sibling = board.insertSub(board.px(sub.bodyTop.y) + 36, 'sib')
  assert.ok(sibling, 'a tap inside a subsection adds a sibling')
  assert.equal(sibling.parentId, parent.id, 'the sibling stays under the same section')
  assert.ok(board.sections.every((section) => section.parentId !== sub.id), 'one level only')
  assert.equal(planInsertSection(board.sections, sub.top.y + 0.0002, board.sheet, 'in-header', { nested: true }), null, 'no subsection inside a header')
  assert.equal(planInsertSection(board.sections, 0.002, board.sheet, 'above', { nested: true }), null, 'a subsection needs a section')
  assert.equal(topLevelSectionIndex(board.sections, parent.id), 0, 'the first section still folds the first heading')
  assert.equal(topLevelSectionIndex(board.sections, second.id), 1, 'a subsection does not take a heading slot')
  assert.equal(topLevelSectionIndex(board.sections, sub.id), -1, 'a subsection does not fold a heading')

  const parentInk = board.write(board.px(parent.bodyTop.y) + 16, 18)
  const subTitle = board.write(board.px(sub.top.y) + 6, 12)
  const subBody = board.write(board.px(sub.bodyTop.y) + 16, 18)
  const secondInk = board.write(board.px(second.bodyTop.y) + 20, 16)
  const bodyX = subBody.points[0].x
  const bodyY = subBody.points[0].y
  const edgeBefore = sub.top.y
  const heightAtWidth = board.sheet.height
  applySectionWidth(sub, 0.4)
  assert.equal(sub.width, 0.4)
  assert.equal(subBody.points[0].x, bodyX, 'narrowing a subsection does not move ink x')
  assert.equal(subBody.points[0].y, bodyY, 'narrowing a subsection does not move ink y')
  assert.equal(sub.top.y, edgeBefore, 'narrowing a subsection does not move the band')
  assert.equal(board.sheet.height, heightAtWidth, 'narrowing a subsection does not resize the page')
  assert.equal(board.sheet.width, WIDTH, 'narrowing a subsection does not change the page width')
  const parentX = parentInk.points[0].x
  const parentY = parentInk.points[0].y
  const parentEdge = parent.top.y
  applySectionWidth(parent, 0.3)
  assert.equal(parent.width, 0.3, 'a section band can be narrowed')
  assert.equal(parentInk.points[0].x, parentX, 'narrowing a section does not move ink x')
  assert.equal(parentInk.points[0].y, parentY, 'narrowing a section does not move ink y')
  assert.equal(parent.top.y, parentEdge, 'narrowing a section does not move the band')
  assert.equal(board.sheet.height, heightAtWidth, 'narrowing a section does not resize the page')
  assert.equal(board.sheet.width, WIDTH, 'narrowing a section does not change the page width')
  assert.equal(applySectionWidth(parent, 0.01), SUBSECTION_WIDTH_MIN, 'a section width clamps at the narrow end')
  applySectionWidth(parent, 0.55)
  const savedParent = JSON.parse(JSON.stringify(serializeSections(board.sections))).find((section) => section.id === parent.id)
  assert.equal(savedParent.width, 0.55, 'a narrowed section keeps its width on disk')
  const restoredParent = deserializeSections(JSON.parse(JSON.stringify(serializeSections(board.sections))), (value) => Array.isArray(value) ? value : []).find((section) => section.id === parent.id)
  assert.equal(restoredParent.width, 0.55, 'a narrowed section comes back at that width')
  assert.equal(parentInk.points[0].x, parentX, 'saving a section width does not move ink')
  assert.equal(applySectionWidth(sub, 0.01), SUBSECTION_WIDTH_MIN, 'width clamps at the narrow end')
  applySectionWidth(sub, 0.62)
  assert.equal(applySectionWidth(sub, 4), 1, 'width clamps at the sheet edge')
  applySectionWidth(sub, 0.62)

  const snapshot = (stroke) => stroke.points.map((p) => [Math.round(p.x * board.sheet.width * 100) / 100, Math.round(p.y * board.sheet.height * 100) / 100])
  const before = {
    parentInk: snapshot(parentInk),
    subTitle: snapshot(subTitle),
    subBody: snapshot(subBody),
    secondInk: snapshot(secondInk),
    subTop: board.px(sub.top.y),
    secondTop: board.px(second.top.y),
    parentTop: board.px(parent.top.y),
  }
  const placed = (pixels) => board.strokes.some((stroke) => pixels.every((point, index) => (
    Math.abs(stroke.points[index].x * board.sheet.width - point[0]) < 0.8
    && Math.abs(stroke.points[index].y * board.sheet.height - point[1]) < 0.8
  )))

  board.collapse(sub)
  assert.ok(sub.collapsed && sub.hidden, 'a subsection collapses on its own')
  assert.equal(sub.width, 0.62, 'collapse keeps the width')
  assert.ok(!board.strokes.includes(subBody), 'subsection body ink leaves the sheet')
  assert.ok(board.strokes.includes(subTitle), 'the subsection title stays in the header')
  assert.ok(board.strokes.includes(parentInk), 'ink in the section, above the subsection, stays')
  near(board.topPx(parentInk), before.parentInk[0][1], 'that ink does not move up')
  board.expand(sub)
  assert.equal(sub.width, 0.62)
  assert.ok(!sub.collapsed)
  near(board.px(sub.top.y), before.subTop, 'the subsection header is back', 0.6)
  assert.ok(placed(before.subBody), 'subsection ink returns at the same pixels and the same x')

  board.collapse(sub)
  const whileSubCollapsed = board.px(second.top.y)
  board.collapse(parent)
  assert.ok(!board.sections.includes(sub) && !board.sections.includes(sibling), 'subsections leave the sheet with the section body')
  assert.ok(parent.hidden.sections.includes(sub) && parent.hidden.sections.includes(sibling))
  assert.ok(sub.collapsed, 'a collapsed subsection stays collapsed while parked')
  assert.equal(sub.width, 0.62)
  assert.equal(board.sheet.width, WIDTH)
  const saved = JSON.parse(JSON.stringify(serializeSections(board.sections)))
  const parked = saved.find((section) => section.id === 'parent')
  assert.equal(parked.hidden.sections.length, 2)
  assert.equal(parked.hidden.sections.find((section) => section.id === 'sub').width, 0.62)
  assert.ok(!saved.some((section) => section.id === 'sub'), 'a parked subsection is not a second heading')
  const loaded = deserializeSections(saved, (value) => Array.isArray(value) ? value : [])
  const loadedSub = loaded.find((section) => section.id === 'parent').hidden.sections.find((section) => section.id === 'sub')
  assert.equal(loaded.length, 2, 'the saved page has the two sections')
  assert.equal(loadedSub.width, 0.62)
  assert.equal(loadedSub.collapsed, true)
  assert.ok(loadedSub.hidden.strokes.length >= 1, 'the parked subsection keeps its own hidden ink')
  board.expand(parent)
  assert.ok(board.sections.includes(sub))
  assert.ok(sub.collapsed, 'expanding the section does not expand the subsection')
  assert.equal(sub.width, 0.62)
  near(board.px(sub.top.y), before.subTop, 'the parked subsection returns to its pixel', 0.8)
  near(board.px(parent.top.y), before.parentTop, 'the section header stayed', 0.8)
  near(board.px(second.top.y), whileSubCollapsed, 'the following section returns to the collapsed layout', 0.8)
  board.expand(sub)
  near(board.px(second.top.y), before.secondTop, 'expanding the subsection puts the following section back', 0.8)
  assert.ok(placed(before.subBody), 'subsection ink survived the section collapse, still at its x')
  assert.ok(placed(before.parentInk), 'section ink is back')
  assert.ok(placed(before.subTitle), 'subsection title is back')
  assert.ok(placed(before.secondInk), 'ink below the section is back')
  assert.equal(board.sheet.width, WIDTH)
}

// ── One edge moves every band, and neither edge moves the writing ──────────
{
  const board = createBoard(1273)
  const parent = board.insert(140, 'parent')
  const second = board.insert(700, 'second')
  const sub = board.insertSub(board.px(parent.bodyTop.y) + 80, 'sub')
  const ink = board.write(board.px(sub.bodyTop.y) + 20, 16)
  const outside = strokeAt(board.px(parent.bodyTop.y) + 24, board.sheet.height, 12, 30)
  const far = strokeAt(board.px(second.bodyTop.y) + 24, board.sheet.height, 12, 860)
  board.strokes.push(outside, far)
  const inkX = ink.points[0].x
  const inkY = ink.points[0].y
  const outsideX = outside.points.map((point) => point.x)
  const farX = far.points.map((point) => point.x)
  const edge = parent.top.y
  const heightAtEdges = board.sheet.height
  assert.equal(applySharedSectionEdges(board.sections, 'missing', { width: 0.4 }).changed, false, 'an unknown band changes nothing')
  assert.equal(parent.width, 1)
  const narrowed = applySharedSectionEdges(board.sections, sub.id, { width: 0.5 })
  assert.equal(narrowed.changed, true)
  assert.equal(narrowed.width, 0.5)
  assert.equal(narrowed.left, 0)
  for (const section of [parent, second, sub]) {
    assert.equal(section.width, 0.5, `${section.id} takes the same right edge`)
    assert.equal(section.left, 0, `${section.id} keeps the shared left edge`)
  }
  assert.equal(ink.points[0].x, inkX, 'a shared right edge does not move ink x')
  assert.equal(ink.points[0].y, inkY, 'a shared right edge does not move ink y')
  assert.deepEqual(outside.points.map((point) => point.x), outsideX, 'ink left of the band stays')
  assert.deepEqual(far.points.map((point) => point.x), farX, 'ink right of the band stays')
  assert.equal(parent.top.y, edge, 'a shared right edge does not move the band')
  assert.equal(board.sheet.height, heightAtEdges, 'a shared right edge does not resize the page')
  assert.equal(board.sheet.width, WIDTH, 'a shared right edge does not change the page width')
  const fromLeft = applySharedSectionEdges(board.sections, parent.id, { left: 0.18 })
  assert.equal(fromLeft.left, 0.18)
  assert.equal(fromLeft.width, 0.5, 'the left edge leaves the right edge')
  for (const section of [parent, second, sub]) {
    assert.equal(section.left, 0.18, `${section.id} takes the same left edge`)
    assert.equal(section.width, 0.5, `${section.id} keeps the shared right edge`)
  }
  assert.equal(ink.points[0].x, inkX, 'a shared left edge does not move ink x')
  assert.equal(ink.points[0].y, inkY, 'a shared left edge does not move ink y')
  assert.deepEqual(outside.points.map((point) => point.x), outsideX, 'ink outside the left edge stays')
  assert.deepEqual(far.points.map((point) => point.x), farX, 'ink outside the right edge stays')
  assert.equal(outside.points.length, 2, 'no ink point is removed')
  assert.equal(far.points.length, 2, 'no far ink point is removed')
  assert.equal(parent.top.y, edge, 'a shared left edge does not move the band')
  assert.equal(board.sheet.height, heightAtEdges, 'a shared left edge does not resize the page')
  assert.equal(board.sheet.width, WIDTH)
  assert.equal(applySharedSectionEdges(board.sections, second.id, { left: 0.9 }).left, 0.5 - SUBSECTION_WIDTH_MIN, 'the left edge stops at the minimum span')
  assert.equal(parent.left, second.left)
  assert.equal(sub.left, second.left)
  assert.equal(applySharedSectionEdges(board.sections, sub.id, { width: 0.1 }).width, sub.left + SUBSECTION_WIDTH_MIN, 'the right edge stops at the minimum span')
  assert.equal(parent.width, sub.width)
  assert.equal(ink.points[0].x, inkX, 'clamping an edge does not move ink')
  const fresh = board.insert(board.px(second.bodyTop.y) + 40, 'fresh')
  assert.equal(fresh.left, parent.left, 'a new section copies the shared left edge')
  assert.equal(fresh.width, parent.width, 'a new section copies the shared right edge')
  assert.equal(ink.points[0].x, inkX, 'inserting a synced section does not slide older ink')
  applySharedSectionEdges(board.sections, parent.id, { left: 0.12, width: 0.66 })
  const saved = JSON.parse(JSON.stringify(serializeSections(board.sections)))
  assert.equal(saved.find((section) => section.id === 'parent').left, 0.12, 'the left edge is saved')
  assert.equal(saved.find((section) => section.id === 'second').width, 0.66, 'every saved band has the shared right edge')
  const loaded = deserializeSections(saved, (value) => Array.isArray(value) ? value : [])
  assert.equal(loaded.find((section) => section.id === 'sub').left, 0.12, 'the left edge comes back')
  assert.equal(loaded.find((section) => section.id === 'fresh').width, 0.66, 'the shared right edge comes back')
  const parkedInkX = ink.points[0].x
  board.collapse(sub)
  board.collapse(parent)
  const parked = parent.hidden.sections.find((section) => section.id === 'sub')
  assert.equal(parked.left, 0.12, 'a parked band keeps the left edge')
  applySharedSectionEdges(board.sections, parent.id, { left: 0.08, width: 0.6 })
  assert.equal(parked.left, 0.08, 'a parked band takes the new left edge')
  assert.equal(parked.width, 0.6, 'a parked band takes the new right edge')
  assert.equal(second.left, 0.08)
  assert.equal(second.width, 0.6)
  const parkedStroke = parked.hidden.strokes[0]
  assert.equal(parkedStroke.points.length, 2, 'parked ink is not removed')
  assert.equal(parkedStroke.points[0].x, parkedInkX, 'syncing a parked band does not move its ink')
  assert.equal(ink.points[0].x, parkedInkX, 'the original stroke is not rewritten')
  assert.equal(board.sheet.width, WIDTH)
  const opened = applySharedSectionEdges(board.sections, second.id, { left: 0, width: 1 })
  assert.equal(opened.left, 0)
  assert.equal(opened.width, 1)
  assert.equal(Object.hasOwn(serializeSections([second])[0], 'left'), false, 'a restored left edge is not stored')
  assert.equal(Object.hasOwn(serializeSections([second])[0], 'width'), false, 'a restored right edge is not stored')
  const crooked = deserializeSections([{ id: 'crooked', top: .1, bodyTop: .2, collapsed: false, left: .9, width: .4 }], () => [])
  assert.equal(crooked[0].width, .4, 'a saved right edge stays')
  assert.equal(crooked[0].left, .4 - SUBSECTION_WIDTH_MIN, 'a left edge that would squash the band is pulled back')
}

{
  const board = createBoard(1273)
  const parent = board.insert(150, 'parent')
  const sub = board.insertSub(board.px(parent.bodyTop.y) + 220, 'sub')
  board.insert(board.px(sub.bodyTop.y) + 420, 'second')
  const before = board.px(sub.top.y)
  const written = board.write(before - 24, 30)
  assert.ok(board.px(sub.top.y) > before, 'writing toward a subsection pushes the subsection down')
  near(written.points[0].x * WIDTH, 200, 'the push does not move the stroke sideways')
  assert.equal(board.sheet.width, WIDTH)
  assert.equal(sub.width, 1)
}


// ── Reordering moves a band and its ink, and leaves the rest of the page ──
{
  const board = createBoard(1273)
  const above = board.write(40, 16)
  const first = board.insert(160, 'first')
  const second = board.insert(640, 'second')
  const third = board.insert(1040, 'third')
  const firstTitle = board.write(board.px(first.top.y) + 8, 16)
  const firstBody = board.write(board.px(first.bodyTop.y) + 30, 20)
  const secondTitle = board.write(board.px(second.top.y) + 8, 16)
  const secondBody = board.write(board.px(second.bodyTop.y) + 24, 18)
  const thirdBody = board.write(board.px(third.bodyTop.y) + 20, 16)
  const abovePx = board.topPx(above)
  const heightBefore = board.sheet.height
  const orderBefore = sortSections(board.sections).map((section) => section.id)
  assert.equal(reorderSection(board.strokes, board.sections, 'second', 1, board.sheet, board.tracked), false, 'dropping a section on itself does nothing')
  assert.deepEqual(sortSections(board.sections).map((section) => section.id), orderBefore)
  assert.equal(reorderSection(board.strokes, board.sections, 'missing', 0, board.sheet, board.tracked), false)

  assert.equal(reorderSection(board.strokes, board.sections, 'first', 2, board.sheet, board.tracked), true, 'the first section moves to the bottom')
  assert.equal(board.sheet.height, heightBefore, 'reordering does not resize the page')
  assert.equal(board.sheet.width, WIDTH, 'reordering does not change the page width')
  near(board.topPx(above), abovePx, 'ink above the sections stays')
  const tops = Object.fromEntries(board.sections.map((section) => [section.id, board.px(section.top.y)]))
  assert.ok(tops.second < tops.third && tops.third < tops.first, `order is second, third, first (${tops.second}, ${tops.third}, ${tops.first})`)
  assert.ok(board.topPx(secondTitle) > tops.second && board.topPx(secondTitle) < board.px(second.bodyTop.y), 'the second title stays in its header')
  assert.ok(board.topPx(secondBody) >= board.px(second.bodyTop.y) && board.topPx(secondBody) < tops.third, 'the second body stays above the next section')
  assert.ok(board.topPx(firstTitle) > tops.first && board.topPx(firstTitle) < board.px(first.bodyTop.y), 'the moved title stays in its header')
  assert.ok(board.topPx(firstBody) >= board.px(first.bodyTop.y), 'the moved body follows its header')
  assert.ok(board.topPx(thirdBody) >= board.px(third.bodyTop.y) && board.topPx(thirdBody) < tops.first, 'the middle section keeps its ink')
  assert.ok(firstBody.points.every((point) => point.x > 0 && point.x < 1), 'a moved stroke keeps its x')

  const spans = sortSections(board.sections).map((section) => [board.px(section.top.y), board.px(section.bodyTop.y)])
  assert.ok(spans.every(([top, body]) => body > top), 'every header still has a height')

  // A collapsed section carries its hidden ink to the new place.
  const hiddenPx = board.collapse(second).hiddenPx
  const parked = second.hidden.strokes[0].points[0].y
  assert.equal(reorderSection(board.strokes, board.sections, 'second', 2, board.sheet, board.tracked), true, 'a collapsed section moves below the others')
  assert.equal(second.hidden.strokes[0].points[0].y, parked, 'hidden ink stays in its own box')
  assert.ok(second.collapsed)
  assert.deepEqual(sortSections(board.sections).map((section) => section.id), ['third', 'first', 'second'])
  board.expand(second)
  assert.ok(!second.collapsed && second.hidden === null)
  const restored = board.strokes.find((stroke) => stroke !== above && stroke !== firstTitle && stroke !== firstBody && stroke !== secondTitle && stroke !== thirdBody && board.topPx(stroke) >= board.px(second.bodyTop.y))
  assert.ok(restored, 'the hidden body comes back under the moved header')
  assert.ok(hiddenPx > 0)

  const mark = [
    { start: 0.1, end: 0.3 },
    { start: 0.3, end: 0.5 },
    { start: 0.5, end: 0.9 },
  ]
  assert.equal(sectionDropIndex(mark, 0, 0.05), 0)
  assert.equal(sectionDropIndex(mark, 0, 0.42), 1)
  assert.equal(sectionDropIndex(mark, 0, 0.8), 2)
  assert.equal(sectionDropIndex(mark, 2, 0.05), 0)
  assert.equal(sectionReorderMark(mark, 0, 2), 0.9)
  assert.equal(sectionReorderMark(mark, 2, 0), 0.1)
  assert.equal(sectionReorderMark(mark, 1, 1), null)
}

{
  const board = createBoard(1273)
  const parent = board.insert(140, 'parent')
  const sub = board.insertSub(board.px(parent.bodyTop.y) + 80, 'sub')
  const sibling = board.insertSub(board.px(sub.bodyTop.y) + 40, 'sib')
  const parentTop = board.px(parent.top.y)
  const subInk = board.write(board.px(sub.bodyTop.y) + 12, 14)
  const siblingInk = board.write(board.px(sibling.bodyTop.y) + 12, 14)
  applySectionWidth(sub, 0.62)
  const width = sub.width
  const heightBefore = board.sheet.height
  assert.equal(reorderSection(board.strokes, board.sections, 'sib', 0, board.sheet, board.tracked), true, 'a subsection moves above its sibling')
  assert.ok(board.px(sibling.top.y) < board.px(sub.top.y), 'the subsection order changed')
  assert.equal(sibling.parentId, parent.id)
  assert.equal(sub.parentId, parent.id)
  near(board.px(parent.top.y), parentTop, 'the section header stays')
  assert.equal(sub.width, width, 'reordering does not change a subsection width')
  assert.equal(board.sheet.height, heightBefore, 'reordering a subsection does not resize the page')
  assert.equal(board.sheet.width, WIDTH)
  assert.ok(board.topPx(siblingInk) >= board.px(sibling.bodyTop.y) && board.topPx(siblingInk) < board.px(sub.top.y), 'subsection ink follows its header')
  assert.ok(board.topPx(subInk) >= board.px(sub.bodyTop.y), 'the other subsection keeps its ink')
  assert.equal(subInk.points[0].x, siblingInk.points[0].x, 'reordering does not slide ink sideways')
}

// ── A typed title is stored with the band and does not move ink ────────────
{
  const board = createBoard(1273)
  const section = board.insert(180, 'chapter')
  const sub = board.insertSub(board.px(section.bodyTop.y) + 48, 'task')
  const ink = board.write(board.px(sub.bodyTop.y) + 18, 14)
  const x = ink.points[0].x
  const y = ink.points[0].y
  const edge = section.top.y
  section.title = 'Kapitel'
  sub.title = 'Aufgabe 1'
  applySectionWidth(section, 0.46)
  assert.equal(ink.points[0].x, x, 'a typed title does not move ink x')
  assert.equal(ink.points[0].y, y, 'a typed title does not move ink y')
  assert.equal(section.top.y, edge, 'a typed title does not move the band')
  assert.equal(section.title, 'Kapitel')
  assert.equal(sub.title, 'Aufgabe 1')
  board.collapse(section)
  const saved = JSON.parse(JSON.stringify(serializeSections(board.sections)))
  assert.equal(saved[0].title, 'Kapitel', 'the section title is saved')
  const parked = saved[0].hidden.sections.find((entry) => entry.id === 'task')
  assert.equal(parked.title, 'Aufgabe 1', 'a subsection title is saved inside the collapsed body')
  const loaded = deserializeSections(saved, (value) => Array.isArray(value) ? value : [])
  assert.equal(loaded[0].title, 'Kapitel')
  assert.equal(loaded[0].hidden.sections.find((entry) => entry.id === 'task').title, 'Aufgabe 1', 'a parked subsection title comes back')
  assert.equal(ink.points[0].x, x, 'saving a title does not move ink')
  section.title = '   '
  assert.equal(Object.hasOwn(serializeSections(board.sections)[0], 'title'), false, 'whitespace is not a title')
  const blank = deserializeSections([{ id: 'blank', top: .1, bodyTop: .2, collapsed: false, title: '   \n  ' }], () => [])
  assert.equal(blank[0].title, '', 'a blank saved title loads as empty')
  const capped = deserializeSections([{ id: 'long', top: .1, bodyTop: .2, collapsed: false, title: ` ${'ä'.repeat(200)}` }], () => [])
  assert.equal(capped[0].title.length, 120, 'a typed title is capped')
  assert.equal(capped[0].title.startsWith('ä'), true)
}

// ── Merge keeps the top band and leaves every stroke where it is ───────────
{
  const board = createBoard(1600)
  const first = board.insert(120, 'first')
  const middle = board.insert(520, 'middle')
  const third = board.insert(900, 'third')
  const tail = board.insert(1280, 'tail')
  const sub = board.insertSub(board.px(first.bodyTop.y) + 36, 'sub')
  assert.ok(first && middle && third && tail && sub)
  first.title = 'Oben'
  middle.title = 'Mitte'
  const inFirst = board.write(board.px(first.bodyTop.y) + 8, 12)
  const inSub = board.write(board.px(sub.bodyTop.y) + 8, 12)
  const inMiddle = board.write(board.px(middle.top.y) + 6, 10)
  const inThird = board.write(board.px(third.bodyTop.y) + 8, 12)
  const inTail = board.write(board.px(tail.bodyTop.y) + 8, 12)
  applySharedSectionEdges(board.sections, first.id, { left: 0.08, width: 0.74 })
  const marks = [inFirst, inSub, inMiddle, inThird, inTail].map((stroke) => stroke.points.map((point) => [point.x, point.y]))
  const firstTop = first.top.y
  const tailTop = tail.top.y
  const heightAtMerge = board.sheet.height
  assert.equal(planMergeSections(board.sections, [first.id]), null, 'one band is not a merge')
  assert.equal(planMergeSections(board.sections, [first.id, 'missing']), null, 'an unknown band is not a second selection')
  const plan = planMergeSections(board.sections, [third.id, first.id])
  assert.equal(plan.keeperId, first.id, 'the top selected band is the one that stays')
  assert.deepEqual(plan.removeIds, [sub.id, middle.id, third.id])
  assert.ok(!plan.removeIds.includes(tail.id), 'a band below the selection stays')
  board.sections = sectionsAfterMerge(board.sections, plan.removeIds)
  assert.deepEqual(board.sections.map((section) => section.id), [first.id, tail.id])
  assert.equal(first.title, 'Oben', 'the top title stays')
  assert.equal(first.top.y, firstTop, 'merging does not move the top band')
  assert.equal(tail.top.y, tailTop, 'merging does not move the band below')
  assert.equal(first.left, 0.08, 'merging does not change the left edge')
  assert.equal(first.width, 0.74, 'merging does not change the right edge')
  assert.equal(tail.left, 0.08)
  assert.equal(tail.width, 0.74)
  assert.equal(board.sheet.height, heightAtMerge, 'merging does not resize the page')
  assert.equal(board.sheet.width, WIDTH, 'merging does not change the page width')
  ;[inFirst, inSub, inMiddle, inThird, inTail].forEach((stroke, index) => {
    assert.deepEqual(stroke.points.map((point) => [point.x, point.y]), marks[index], 'merging does not move ink')
    assert.equal(stroke.points.length, 2, 'merging does not remove ink')
    assert.ok(board.strokes.includes(stroke), 'ink from a removed band stays on the page')
  })

  const onlySubs = createBoard(1600)
  const parent = onlySubs.insert(160, 'parent')
  const upper = onlySubs.insertSub(onlySubs.px(parent.bodyTop.y) + 30, 'upper')
  const lower = onlySubs.insertSub(onlySubs.px(upper.bodyTop.y) + 30, 'lower')
  const after = onlySubs.insert(onlySubs.px(lower.bodyTop.y) + 200, 'after')
  const subInk = onlySubs.write(onlySubs.px(lower.bodyTop.y) + 10, 12)
  const subX = subInk.points[0].x
  const subY = subInk.points[0].y
  const subPlan = planMergeSections(onlySubs.sections, [lower.id, upper.id])
  assert.equal(subPlan.keeperId, upper.id, 'the upper subsection stays')
  assert.deepEqual(subPlan.removeIds, [lower.id])
  onlySubs.sections = sectionsAfterMerge(onlySubs.sections, subPlan.removeIds)
  assert.deepEqual(onlySubs.sections.map((section) => section.id), [parent.id, upper.id, after.id])
  assert.equal(subInk.points[0].x, subX, 'merging subsections does not move ink x')
  assert.equal(subInk.points[0].y, subY, 'merging subsections does not move ink y')
  assert.equal(onlySubs.sheet.width, WIDTH)

  const collapsed = createBoard(1600)
  const top = collapsed.insert(140, 'top')
  const folded = collapsed.insert(480, 'folded')
  const bottom = collapsed.insert(860, 'bottom')
  collapsed.collapse(folded)
  const foldedPlan = planMergeSections(collapsed.sections, [top.id, bottom.id])
  assert.ok(foldedPlan.removeIds.includes(folded.id), 'a collapsed band between the selection is part of the merge')
  assert.equal(folded.collapsed, true, 'planning a merge does not open the band')
  assert.equal(collapsed.strokes.length, 0)
}

// ── Board wiring ───────────────────────────────────────────────────────────
{
  const board = readFileSync(new URL('../src/components/DrawingBoard.tsx', import.meta.url), 'utf8')
  assert.match(board, /sections: sectionsRef\.current\.length \? serializeSections\(sectionsRef\.current\) : undefined/, 'sections are saved with the drawing')
  assert.match(board, /deserializeSections<InkStroke>\(raw\.sections/, 'sections are loaded with the drawing')
  assert.match(board, /for \(const section of sectionsRef\.current\) \{\s*for \(const edge of \[section\.top, section\.bodyTop\]\)/, 'section edges are tracked points: a grow remaps them with the ink')
  assert.match(board, /const roomGrown = activeStroke && gestureToolRef\.current === 'pen'/, 'a finished stroke can grow its body')
  assert.match(board, /afterSectionChange\(\{ resetHistory: true \}\)/, 'collapse and expand start the history afresh')
  const overlay = readFileSync(new URL('../src/lib/overlayInteract.ts', import.meta.url), 'utf8')
  assert.match(overlay, /hit\.closest\('\.lw-ink-section-control'\)/, 'a tap on a section arrow is a click, not a stroke')
  assert.match(board, /drawingChromeFromHit/, 'section arrows go through the shared chrome hit-test')
  assert.match(board, /sectionsEnabled && inkMode === 'writing' && <button[^\n]*Abschnitt/, 'the section tool is in the pen toolbar')
  assert.match(board, /\.lw-drawing-board\.is-inline \.lw-ink-sections\{inset:var\(--paper-scroll-room,0px\)/, 'the bands are laid over the sheet, not the scroll room')
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /sectionsEnabled=\{!isPdfActive\}/, 'PDF notes keep their ink on the page: no sections')
  assert.match(board, /Unterabschnitt/, 'the subsection tool is in the pen toolbar')
  assert.match(board, /lw-ink-section-width/, 'a subsection has a width handle')
  assert.match(board, /lw-ink-section-width is-left/, 'a section band has a left edge handle')
  assert.match(board, /data-edge="left"/, 'the left handle drags the left edge')
  assert.match(board, /aria-label=\{isSub \? 'Breite des Unterabschnitts' : 'Breite des Abschnitts'\}/, 'a section has the same width handle')
  assert.match(board, /lw-ink-section-move/, 'a section has a handle to change its order')
  assert.match(board, /reorderSection\(strokesRef\.current, sectionsRef\.current, id, toIndex/, 'the handle reorders the band and its ink')
  assert.match(board, /aria-label=\{isSub \? 'Unterabschnitt verschieben' : 'Abschnitt verschieben'\}/, 'the handle names the band it moves')
  const moveDrag = board.match(/const beginSectionReorderDrag = useCallback\(\(id: string, event: ReactPointerEvent<HTMLElement>\) => \{[\s\S]*?\n  \}, \[moveSectionTo/)
  assert.ok(moveDrag, 'reorder drag is a band gesture')
  assert.doesNotMatch(moveDrag[0], /onSectionFold|contentWidth|foldHeading/, 'reordering does not rewrite the note text')
  assert.match(board, /if \(section\.parentId === null\) onSectionFoldRef\.current\?\.\(topLevelSectionIndex\(sectionsRef\.current, id\), section\.collapsed\)/, 'only a section folds a heading')
  assert.match(board, /\.lw-ink-section-placeholder\{position:absolute;left:12%;top:50%;transform:translateY\(-50%\);color:rgba\(74,63,176,\.34\);font:600 22px\/1 var\(--ui-font,system-ui\)/, 'the title placeholder keeps its size when the band changes width')
  const drag = board.match(/const beginSubsectionWidthDrag = useCallback\(\(id: string, event: ReactPointerEvent<HTMLElement>\) => \{[\s\S]*?\n  \}, \[bumpRevision/)
  assert.ok(drag, 'width drag is a band gesture')
  assert.doesNotMatch(drag[0], /setPageExtent|shiftFrom|foldHeading|contentWidth|onSectionFold|growSheetBy|strokesRef/, 'dragging the width does not move ink, the page, or the note text')
  const setWidth = board.match(/const setSubsectionWidth = useCallback\(\(id: string, width: number\) => \{[\s\S]*?\n  \}, \[commitSections\]\)/)
  assert.ok(setWidth, 'width is stored on the subsection')
  assert.doesNotMatch(setWidth[0], /setPageExtent|shiftFrom|foldHeading|contentWidth|onSectionFold|strokesRef/, 'storing a width does not move ink or the note text')
  assert.match(setWidth[0], /applySharedSectionEdges\(sectionsRef\.current, id, \{ width \}\)/, 'the right edge is copied onto every section')
  const setLeft = board.match(/const setSubsectionLeft = useCallback\(\(id: string, left: number\) => \{[\s\S]*?\n  \}, \[commitSections\]\)/)
  assert.ok(setLeft, 'the left edge is stored on every section')
  assert.doesNotMatch(setLeft[0], /setPageExtent|shiftFrom|foldHeading|contentWidth|onSectionFold|strokesRef/, 'storing a left edge does not move ink or the note text')
  assert.match(setLeft[0], /applySharedSectionEdges\(sectionsRef\.current, id, \{ left \}\)/, 'the left edge is copied onto every section')
  assert.match(drag[0], /dataset\.edge === 'left'/, 'the drag follows the handle that was held')
  const setTitle = board.match(/const setSectionTitle = useCallback\(\(id: string, value: string\) => \{[\s\S]*?\n  \}, \[commitSections, setDirty\]\)/)
  assert.ok(setTitle, 'a typed title is stored on the section')
  assert.doesNotMatch(setTitle[0], /afterSectionChange|setPageExtent|shiftFrom|foldHeading|contentWidth|onSectionFold|growSheetBy|strokesRef/, 'typing a title does not move ink, the page, or the note text')
  assert.match(board, /inert=\{overlayInert\(inline, inputActive\) \|\| undefined\}/, 'keyboard mode keeps the ink board inert')
  assert.match(board, /closest\('\.unified-paper'\)/, 'the keyboard title is portaled onto the paper')
  assert.match(board, /inline && !inputActive && sectionTitleHost \? createPortal\(/, 'a typed title in keyboard mode is outside the inert board')
  assert.match(board, /className="lw-ink-section-titles"/, 'keyboard titles sit in their own layer')
  assert.match(board, /const forwardSectionTitlePointer = \(event: ReactPointerEvent<HTMLInputElement>\) => \{/, 'pen and touch on the title are forwarded')
  assert.match(board, /event\.pointerType !== 'pen' && event\.pointerType !== 'touch'/, 'only a pen or a finger passes through the title')
  assert.match(board, /input\.style\.pointerEvents = 'none'/, 'the title drops out of the hit test for the rest of the stroke')
  assert.match(board, /new PointerEvent\('pointerdown'/, 'the stroke starts on the sheet under the title')
  assert.match(board, /if \(inputActive && forwardSectionTitlePointer\(event\)\) return/, 'handwriting the title still reaches the sheet')
  const titleClass = board.match(/className=\{`lw-ink-section-title\$\{isSub \? ' is-subsection' : ''\}`\}/)
  assert.ok(titleClass, 'the title field is one input')
  assert.doesNotMatch(titleClass[0], /lw-ink-section-control/, 'the title field is not pen chrome')
  assert.match(board, /aria-label="Titel"/, 'the title field reuses the Titel label')
  assert.match(board, /\.lw-ink-section-title\{position:absolute;left:78px;/, 'the typed title starts after the section buttons and keeps a fixed size')
  assert.match(board, /title="Abschnitte antippen · der oberste bleibt und deckt die anderen ab"/, 'merge mode asks for the sections')
  assert.match(board, /Im obersten zusammenführen/, 'the merge confirms into the top section')
  assert.match(board, /aria-label="Abschnitt zum Zusammenführen auswählen"/, 'a section can be chosen for the merge')
  const mergeFn = board.match(/const commitMerge = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[afterSectionChange/)
  assert.ok(mergeFn, 'merge keeps the top section')
  assert.match(mergeFn[0], /planMergeSections\(sectionsRef\.current/)
  assert.match(mergeFn[0], /sectionsAfterMerge\(sectionsRef\.current/)
  assert.ok(mergeFn[0].indexOf('expandSection') < mergeFn[0].indexOf('sectionsAfterMerge'), 'a collapsed band is opened before it is dropped')
  assert.doesNotMatch(mergeFn[0], /foldHeading|contentWidth|shiftFrom/, 'merging does not rewrite the note text or slide the ink itself')
}

await server.close()
console.log('ink sections ok')
