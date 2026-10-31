export const SHORT_INTERVAL_MS: number
export const SHORT_RETENTION_MS: number
export const WEEK_INTERVAL_MS: number
export const MAX_SNAPSHOT_BYTES: number

export type HistoryTier = 'week' | 'short'

export type HistorySnapshotRecord = {
  id: string
  createdAt: string
  bytes?: number
  tier?: HistoryTier | string | null
  ext?: string
  companion?: boolean | string
  content?: string
}

export function snapshotExtension(relativePath: string): '.md' | '.famd'

export function retainSnapshots<T extends HistorySnapshotRecord>(snapshots: readonly T[], nowMs: number): T[]

export function nextSnapshotTier(snapshots: readonly HistorySnapshotRecord[], nowMs: number): HistoryTier | null
