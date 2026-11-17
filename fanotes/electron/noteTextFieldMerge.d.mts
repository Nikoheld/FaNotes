/** The box fields the merge reads. `NoteTextField` and the main-process boxes both fit. */
export type MergeableTextField = {
  id: string
  page: number
  x: number
  y: number
  width: number
  fontSize: number
  text: string
  color?: string
  bold?: boolean
  updatedAt?: number
}

export type NoteTextFieldTombstone = { id: string; deletedAt: number }

export type NoteTextFieldOps<T extends MergeableTextField = MergeableTextField> = {
  upserts: T[]
  deletes: NoteTextFieldTombstone[]
}

export const NOTE_TEXT_FIELD_LIMIT: number
export const NOTE_TEXT_FIELD_TOMBSTONE_LIMIT: number
export const NOTE_TEXT_FIELD_TOMBSTONE_TTL_MS: number
export const NOTE_TEXT_FIELD_CLOCK_SKEW_MS: number

export function sameNoteTextFieldContent(left: MergeableTextField, right: MergeableTextField): boolean
export function noteTextFieldsEqual(left: readonly MergeableTextField[], right: readonly MergeableTextField[]): boolean
export function persistableNoteTextFields<T extends MergeableTextField>(local: readonly T[], base: readonly MergeableTextField[] | null | undefined): T[]
export function diffNoteTextFields<T extends MergeableTextField>(base: readonly T[] | null | undefined, local: readonly T[], now: number): NoteTextFieldOps<T>
export function applyNoteTextFieldOps<T extends MergeableTextField>(
  current: readonly T[] | null | undefined,
  tombstones: readonly NoteTextFieldTombstone[] | null | undefined,
  ops: Partial<NoteTextFieldOps<T>> | null | undefined,
  now: number,
): { fields: T[]; tombstones: NoteTextFieldTombstone[] }
export function mergeNoteTextFields<T extends MergeableTextField>(
  base: readonly T[] | null | undefined,
  local: readonly T[],
  remote: readonly T[],
): T[]
