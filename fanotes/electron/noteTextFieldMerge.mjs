// Per-box merge of note text boxes (the "Textfeld" tool on PDF and markdown notes).
//
// A note can be open in two windows, on a second device, or in a live share at
// the same time. The old save replaced the whole `textFields` array, so the
// last writer silently deleted every box the others had added or edited. The
// functions here decide box by box instead. They are pure and shared by the
// Electron main process (require), the renderer (import) and the checks.
//
// A box is the sanitised shape of `src/lib/noteTextField.ts`:
//   { id, page, x, y, width, fontSize, text, color?, bold?, updatedAt?, aspect? }
// `aspect` is the sheet height/width that `y` was written against (additive).
// `updatedAt` is the epoch millisecond of the last edit of that one box. A
// deleted box leaves a tombstone `{ id, deletedAt }` in the payload so a stale
// edit of it can be told apart from a box that never existed.

export const NOTE_TEXT_FIELD_LIMIT = 200
export const NOTE_TEXT_FIELD_TOMBSTONE_LIMIT = 200
/** A tombstone older than this is dropped; a stale window that old has long been reloaded. */
export const NOTE_TEXT_FIELD_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** A stamp this far ahead of the local clock is clamped, so one skewed device cannot win every conflict. */
export const NOTE_TEXT_FIELD_CLOCK_SKEW_MS = 5 * 60 * 1000

const stampOf = (box) => (box && Number.isFinite(box.updatedAt) ? box.updatedAt : 0)

const byId = (list) => {
  const map = new Map()
  for (const box of list ?? []) map.set(box.id, box)
  return map
}

/** Everything the user sees or edits, without the edit time. */
export const sameNoteTextFieldContent = (left, right) => (
  left.page === right.page
  && left.x === right.x
  && left.y === right.y
  && (left.aspect ?? null) === (right.aspect ?? null)
  && left.width === right.width
  && left.fontSize === right.fontSize
  && left.text === right.text
  && (left.color ?? null) === (right.color ?? null)
  && Boolean(left.bold) === Boolean(right.bold)
)

export const noteTextFieldsEqual = (left, right) => (
  left.length === right.length
  && left.every((box, index) => (
    box.id === right[index].id
    && stampOf(box) === stampOf(right[index])
    && sameNoteTextFieldContent(box, right[index])
  ))
)

/**
 * The boxes that belong on disk. A box that was only just placed and is still
 * empty stays in the window; it is written once it holds text, or when the
 * disk already knows it (a box another device placed empty must not be deleted).
 */
export const persistableNoteTextFields = (local, base) => {
  const known = new Set((base ?? []).map((box) => box.id))
  return local.filter((box) => box.text.trim() !== '' || known.has(box.id))
}

/**
 * What this window changed relative to the disk state it last saw (`base`).
 * Only changed boxes are sent: an untouched stale copy must never overwrite
 * an edit another window made in the meantime.
 */
export const diffNoteTextFields = (base, local, now) => {
  const baseById = byId(base)
  const localIds = new Set()
  const upserts = []
  for (const box of local) {
    localIds.add(box.id)
    const before = baseById.get(box.id)
    if (before && sameNoteTextFieldContent(before, box)) continue
    // A change always carries a stamp newer than the copy it replaces.
    const updatedAt = stampOf(box) > stampOf(before) ? box.updatedAt : Math.max(now, stampOf(before) + 1)
    upserts.push({ ...box, updatedAt })
  }
  const deletes = []
  for (const before of base ?? []) {
    if (localIds.has(before.id)) continue
    deletes.push({ id: before.id, deletedAt: Math.max(now, stampOf(before) + 1) })
  }
  return { upserts, deletes }
}

/**
 * Apply one window's changes to the boxes stored on disk (main process, inside
 * the per-file write queue). Per box the newer edit wins; a delete and an edit
 * of the same box are compared by time, so typed text is never lost to an older
 * delete and a delete is never undone by an older edit. At the very same
 * millisecond the box stays.
 *
 * @returns {{ fields: object[], tombstones: object[] }}
 */
export const applyNoteTextFieldOps = (current, tombstones, ops, now) => {
  const fields = byId(current)
  const dead = new Map((tombstones ?? []).map((entry) => [entry.id, entry.deletedAt]))
  // Stamps from a clock far ahead count as "a little ahead", on both sides of every comparison:
  // a box (or tombstone) written by such a device must not become impossible to edit here.
  const ceiling = now + NOTE_TEXT_FIELD_CLOCK_SKEW_MS
  const seen = (stamp) => Math.min(stamp, ceiling)
  for (const raw of ops?.upserts ?? []) {
    const updatedAt = seen(stampOf(raw) || now)
    const existing = fields.get(raw.id)
    if (existing && seen(stampOf(existing)) > updatedAt) continue
    const deletedAt = dead.get(raw.id)
    if (deletedAt !== undefined && updatedAt < seen(deletedAt)) continue
    fields.set(raw.id, { ...raw, updatedAt })
    dead.delete(raw.id)
  }
  for (const gone of ops?.deletes ?? []) {
    const deletedAt = seen(gone.deletedAt || now)
    const existing = fields.get(gone.id)
    if (existing && seen(stampOf(existing)) >= deletedAt) continue
    fields.delete(gone.id)
    dead.set(gone.id, Math.max(deletedAt, dead.get(gone.id) ?? 0))
  }
  const kept = [...dead]
    .filter(([, deletedAt]) => deletedAt > now - NOTE_TEXT_FIELD_TOMBSTONE_TTL_MS)
    .sort((left, right) => right[1] - left[1])
    .slice(0, NOTE_TEXT_FIELD_TOMBSTONE_LIMIT)
    .map(([id, deletedAt]) => ({ id, deletedAt }))
  return { fields: [...fields.values()].slice(0, NOTE_TEXT_FIELD_LIMIT), tombstones: kept }
}

const pickBox = (base, local, remote) => {
  if (sameNoteTextFieldContent(local, remote)) return remote
  if (base && sameNoteTextFieldContent(local, base)) return remote
  if (base && sameNoteTextFieldContent(remote, base)) return local
  // Both sides changed it (or nothing is known about the common state): the newer edit wins, a tie stays local.
  return stampOf(remote) > stampOf(local) ? remote : local
}

/**
 * Three-way merge of the boxes in this window (`local`) with the boxes now on
 * disk (`remote`), against the disk state this window last saw (`base`).
 * A box only one side has is an add, unless `base` knew it: then the other
 * side deleted it, and that stands unless this side edited it since.
 * Local boxes keep their order; boxes new from disk follow.
 */
export const mergeNoteTextFields = (base, local, remote) => {
  const baseById = byId(base)
  const remoteById = byId(remote)
  const merged = []
  const seen = new Set()
  for (const box of local) {
    seen.add(box.id)
    const before = baseById.get(box.id)
    const stored = remoteById.get(box.id)
    if (!stored) {
      if (before && sameNoteTextFieldContent(box, before)) continue
      merged.push(box)
      continue
    }
    merged.push(pickBox(before, box, stored))
  }
  for (const stored of remote) {
    if (seen.has(stored.id)) continue
    const before = baseById.get(stored.id)
    if (before && sameNoteTextFieldContent(stored, before)) continue
    merged.push(stored)
  }
  return merged.slice(0, NOTE_TEXT_FIELD_LIMIT)
}
