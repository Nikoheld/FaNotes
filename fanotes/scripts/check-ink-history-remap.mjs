// Undo after the page grew brings a stroke back where it was drawn.
//
// Strokes are stored 0–1 of the sheet. When the sheet grows, every point is
// remapped so the mark keeps its paper pixel. Undo/redo snapshots are shallow
// copies and share point objects with the live strokes — but a stroke that was
// erased (or undone) exists only in history. Remapping strokesRef alone left
// those points in pre-grow coordinates, so “erase a line, write further down,
// undo twice” put the line back 80–90 px lower than it had been.
//
// Browser reproduction (headless Chrome, pen events): stroke A at the top,
// erase it, stroke B at the sheet bottom (sheet grows 432 → 576 px), undo,
// undo → A returned at y 350 instead of 262 before the fix, at 262 after.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const board = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')

const section = (source, start, end, label) => {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `${label}: start not found`)
  const to = source.indexOf(end, from + start.length)
  assert.ok(to > from, `${label}: end not found`)
  return source.slice(from, to)
}

// One visitor reaches every point the board still holds, each point once.
const visitor = section(board, 'const forEachTrackedPoint = useCallback(', 'const scaleNormalizedSpace = useCallback(', 'forEachTrackedPoint')
assert.match(visitor, /const seen = new Set<StrokePoint>\(\)/, 'points shared between snapshots are visited once')
for (const holder of [
  'visitStrokes(strokesRef.current)',
  'visitStrokes([activeStrokeRef.current])',
  'for (const snapshot of undoRef.current) visitStrokes(snapshot)',
  'for (const snapshot of redoRef.current) visitStrokes(snapshot)',
  'visitStrokes(beforeGestureRef.current)',
  'visitStrokes(recognitionStrokesRef.current)',
  'visitStrokes(tap.snapshot)',
]) {
  assert.ok(visitor.includes(holder), `history holder not remapped: ${holder}`)
}

// Both remap paths go through the visitor — the grow remap and the painted-layout rescale.
const grow = section(board, 'const setPageExtent = useCallback(', 'const afterBox = scroller', 'setPageExtent remap')
assert.match(grow, /forEachTrackedPoint\(\(point\) => \{\s*point\.x = keepMarkOnPage\(point\.x, prevPaintW, nextPaintW, addX\)\s*point\.y = keepMarkOnPage\(point\.y, prevPaintH, nextPaintH, addY\)\s*\}\)/u)
assert.doesNotMatch(grow, /for \(const stroke of strokesRef\.current\)/u, 'the grow remap must not walk the live array alone')
const scale = section(board, 'const scaleNormalizedSpace = useCallback(', 'const catchUpPaintedLayout = useCallback(', 'scaleNormalizedSpace')
assert.match(scale, /forEachTrackedPoint\(\(point\) => \{\s*point\.x \*= scaleX\s*point\.y \*= scaleY\s*\}\)/u)
assert.doesNotMatch(scale, /for \(const stroke of strokesRef\.current\)/u, 'the rescale must not walk the live array alone')

// No other in-place point remap walks only the live strokes.
const liveOnlyWalks = [...board.matchAll(/for \(const stroke of strokesRef\.current\) \{\s*for \(const point of stroke\.points\) \{?\s*point\.[xy] [*=]/gu)]
assert.equal(liveOnlyWalks.length, 0, 'an in-place remap still walks only the live strokes')

console.log(JSON.stringify({ historyRemapped: true, growViaVisitor: true, rescaleViaVisitor: true }))
console.log('ink-history-remap ok')
