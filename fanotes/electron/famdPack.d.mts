export const INK_PACK_POINTS: number
export const INK_FRAME_BUDGET_MS: number
export const INK_COLUMN_STRIDE: number
export const FAMD_ASYNC_CHARS: number

export function frameBudgetOpen(
  startedAt: number,
  now: number,
  finishedUnits: number,
  budgetMs?: number,
): boolean

export function packInk(ink: unknown): {
  slim: unknown
  pointCount: number
  packedInk: { stride: number; columns: Float64Array }
} | null

export function expandPackedInk<T>(ink: T, packed: { stride?: number; columns?: ArrayLike<number> } | null | undefined): T

export function expandPackedStroke<T>(stroke: T, packed: { stride?: number; columns?: ArrayLike<number> } | null | undefined): T

export function countWalkPoints(value: unknown): number
