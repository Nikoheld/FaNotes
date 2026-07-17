import type { RecognitionToken } from '../../../src/lib/recognition'
import type { InkSelectionRect } from './mathInkSelection'

const usable = (tokens: RecognitionToken[]) => tokens.filter((token) => !token.isLayout && token.char.trim())

/** Returns the smallest current-line rectangle containing characters changed since the preceding step. */
export const changedMathTokenRect = (
  previousTokens: RecognitionToken[],
  currentTokens: RecognitionToken[],
  fallback: InkSelectionRect,
): InkSelectionRect => {
  const previous = usable(previousTokens)
  const current = usable(currentTokens)
  if (!current.length) return fallback
  const rows = previous.length + 1
  const columns = current.length + 1
  const table = Array.from({ length: rows }, () => Array<number>(columns).fill(0))
  for (let left = 1; left < rows; left += 1) {
    for (let right = 1; right < columns; right += 1) {
      table[left][right] = previous[left - 1].char === current[right - 1].char
        ? table[left - 1][right - 1] + 1
        : Math.max(table[left - 1][right], table[left][right - 1])
    }
  }
  const unchangedCurrent = new Set<number>()
  let left = previous.length
  let right = current.length
  while (left > 0 && right > 0) {
    if (previous[left - 1].char === current[right - 1].char) {
      unchangedCurrent.add(right - 1)
      left -= 1
      right -= 1
    } else if (table[left - 1][right] >= table[left][right - 1]) {
      left -= 1
    } else {
      right -= 1
    }
  }
  const changed = current.filter((_, index) => !unchangedCurrent.has(index))
  if (!changed.length) return fallback
  const padding = 0.006
  const x = Math.max(0, Math.min(...changed.map((token) => token.bbox[0])) - padding)
  const y = Math.max(0, Math.min(...changed.map((token) => token.bbox[1])) - padding)
  const endX = Math.min(1, Math.max(...changed.map((token) => token.bbox[0] + token.bbox[2])) + padding)
  const endY = Math.min(1, Math.max(...changed.map((token) => token.bbox[1] + token.bbox[3])) + padding)
  return { x, y, width: endX - x, height: endY - y }
}

