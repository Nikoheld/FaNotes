import { parseNoteTextFields, type NoteTextField } from './noteTextField'

/**
 * Browser only: a tab that closes while a text box save is still waiting for IndexedDB loses
 * that save, because the page is gone before the read inside the merge returns. While the page
 * goes away the open note's boxes are therefore also written here, synchronously, together with
 * the disk state they were compared with. The next open of the note folds them back in, and the
 * first save that reaches the disk afterwards removes the copy.
 */
const KEY = 'fanotes-text-field-rescue:'

export type NoteTextFieldRescue = { fields: NoteTextField[]; base: NoteTextField[]; at: number }

const storage = (): Storage | null => {
  try { return globalThis.localStorage ?? null } catch { return null }
}

export const writeNoteTextFieldRescue = (path: string, fields: readonly NoteTextField[], base: readonly NoteTextField[]): void => {
  try { storage()?.setItem(KEY + path, JSON.stringify({ fields, base, at: Date.now() })) } catch { /* storage full or blocked */ }
}

export const readNoteTextFieldRescue = (path: string): NoteTextFieldRescue | null => {
  try {
    const raw = storage()?.getItem(KEY + path)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<NoteTextFieldRescue>
    return { fields: parseNoteTextFields(value.fields), base: parseNoteTextFields(value.base), at: Number(value.at) || 0 }
  } catch { return null }
}

export const clearNoteTextFieldRescue = (path: string): void => {
  try { storage()?.removeItem(KEY + path) } catch { /* nothing to clear */ }
}
