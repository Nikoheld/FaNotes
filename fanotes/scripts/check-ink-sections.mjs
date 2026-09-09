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
  sectionIndexAt,
  serializeSections,
  sortSections,
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
}

await server.close()
console.log('ink sections ok')
