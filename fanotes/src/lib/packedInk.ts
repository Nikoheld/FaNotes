import { expandPackedInk, expandPackedStroke, frameBudgetOpen, INK_FRAME_BUDGET_MS, INK_PACK_POINTS } from '../../electron/famdPack.mjs'
import type { PackedInk } from '../types'

export { expandPackedInk, expandPackedStroke, frameBudgetOpen, INK_FRAME_BUDGET_MS, INK_PACK_POINTS }

/** Matches the companion limit in the desktop main process. */
const MAX_REWRITE_JSON_BYTES = 24 * 1024 * 1024

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength

/**
 * Full drawing JSON for a convert or a duplicate.
 * A packed open keeps samples out of `drawingJson`. Writing that slim string
 * would store a page with no points. Expanding past the save limit fails
 * the same way an unpacked page of that size already did.
 */
export const inkJsonForRewrite = (document: { drawingJson: string; packedInk?: PackedInk | null }): string => {
  if (!document.packedInk?.columns) return document.drawingJson
  const expanded = expandPackedInk(JSON.parse(document.drawingJson) as unknown, document.packedInk)
  const json = JSON.stringify(expanded)
  if (utf8Bytes(json) > MAX_REWRITE_JSON_BYTES) {
    throw new Error('Die Zeichnungsdaten sind ungültig oder zu groß.')
  }
  return json
}

/** True once the page has enough samples that one paint would freeze the window. */
export const inkPageIsHeavy = (strokes: readonly { points?: readonly unknown[] }[]) => {
  let count = 0
  for (const stroke of strokes) {
    count += stroke.points?.length ?? 0
    if (count >= INK_PACK_POINTS) return true
  }
  return false
}
