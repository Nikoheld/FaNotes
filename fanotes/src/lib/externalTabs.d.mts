export const WATCH_LIST_LIMIT: number
export const OWN_WRITE_MEMORY: number
export const BLIND_RENAME_LIMIT: number

export function normalizeNoteText(text: unknown): string
export function sameNoteText(left: unknown, right: unknown): boolean
export function noteTextFingerprint(text: unknown): string
export function rememberOwnWrite(list: readonly string[] | undefined | null, body: unknown): string[]
export function isOwnWrite(list: readonly string[] | undefined | null, text: unknown): boolean

export type NormalizedVaultChange = {
  added: string[]
  removed: string[]
  changed: string[]
  /** A list reached the watcher's cap, the payload said `truncated`, or it was malformed: the lists may be incomplete. */
  unreliable: boolean
}
export function normalizeVaultChange(raw: unknown): NormalizedVaultChange

export type NoteFamily = 'md' | 'famd' | 'pdf' | ''
export function noteStemOf(path: string): string
export function noteFamily(path: string): NoteFamily
export function tabVaultPaths(path: string): string[]
export function implicatedTabPaths(tabPaths: readonly string[], change: NormalizedVaultChange | null | undefined): string[]

export type TabDiskState = { exists: false } | { exists: true; content: string } | null
export type TabHoldKind = 'deleted' | 'conflict'
export type TabReconcileFacts = {
  /** The text the editor holds, typed text not yet saved included. */
  content: string
  /** The text last read from or written to the file. */
  savedContent: string
  /** Fingerprints of what this app wrote to the file lately. */
  ownWrites?: readonly string[]
  /** What the file holds now; null when it could not be read. */
  disk: TabDiskState
  /** Why the tab was paused by an earlier pass, if it was. */
  hold?: TabHoldKind | null
  /** The file's text when the pause for a conflict began. */
  heldExternal?: string | null
}
export type TabReconcileDecision =
  | { action: 'none' }
  | { action: 'reload'; content: string }
  | { action: 'adopt' }
  | { action: 'release' }
  | { action: 'deleted' }
  | { action: 'conflict'; external: string }
export function decideTabReconcile(facts: TabReconcileFacts): TabReconcileDecision

export type FileSignature = { modifiedAt?: string; size?: number }
export function renameCandidates(input: {
  from: string
  added: readonly string[]
  before?: FileSignature | null
  after?: ReadonlyMap<string, FileSignature>
  taken?: readonly string[]
}): string[]
export function companionToFollow(input: { from: string; to: string }): { from: string; to: string } | null

export function conflictCopyBase(path: string): string
export function conflictDeviceName(configured: unknown, platform: unknown): string
