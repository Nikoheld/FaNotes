export const PAPER_SOURCE_WIDTH = 900
export const PAPER_SOURCE_HEIGHT = 1273

/** Empty paper kept below the pen — about half an A4, so growth starts earlier. */
export const WRITE_SLACK_HEIGHT = Math.round(PAPER_SOURCE_HEIGHT * 0.52)
/** Empty paper kept to the right of the pen. */
export const WRITE_SLACK_WIDTH = Math.round(PAPER_SOURCE_WIDTH * 0.4)
/** Grow in half-page chunks so the ruling is not resized every sample. */
export const PAGE_GROW_STEP_HEIGHT = Math.round(PAPER_SOURCE_HEIGHT * 0.5)
export const PAGE_GROW_STEP_WIDTH = Math.round(PAPER_SOURCE_WIDTH * 0.5)

export const neededWriteExtent = (
  normalized: number | undefined,
  current: number,
  slack: number,
  step: number,
) => {
  if (typeof normalized !== 'number' || !Number.isFinite(normalized)) return current
  const needed = normalized * current + slack
  if (needed <= current) return current
  return Math.max(current, Math.ceil(needed / step) * step)
}
