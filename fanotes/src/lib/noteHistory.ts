export {
  MAX_SNAPSHOT_BYTES,
  SHORT_INTERVAL_MS,
  SHORT_RETENTION_MS,
  WEEK_INTERVAL_MS,
  nextSnapshotTier,
  retainSnapshots,
  snapshotExtension,
} from '../../electron/noteHistoryPolicy.mjs'

export type { HistorySnapshotRecord, HistoryTier } from '../../electron/noteHistoryPolicy.mjs'

export type NoteHistorySnapshot = {
  id: string
  createdAt: string
  bytes: number
}
