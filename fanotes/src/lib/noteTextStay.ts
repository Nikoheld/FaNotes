/**
 * Whether a paper gesture may change note text.
 *
 * Pan, zoom, and erase never hide, unmount, or clear the text layer, and they
 * never rewrite the string. An insert touches only the edited span: the
 * characters before `from` and after `to` stay in order. Callers keep DOM
 * reads and writes; this function only decides.
 */
export type NoteTextLayer = {
  note: string
  anchorX: number
  anchorY: number
  mounted?: boolean
}

export type NoteTextGesture =
  | { kind: 'pan' }
  | { kind: 'zoom' }
  | { kind: 'insert'; from: number; to: number; insert: string }
  | { kind: 'erase' }

export type NoteTextDecision = {
  note: string
  prefix: string
  suffix: string
  anchorX: number
  anchorY: number
  signal: 'visible'
  hide: false
  unmount: false
  fullClear: false
  mounted: true
}

const clampIndex = (value: number, length: number) => {
  if (!Number.isFinite(value)) return 0
  return Math.min(length, Math.max(0, Math.trunc(value)))
}

const paperNotes = new WeakMap<object, string>()

/** Remember the note under a paper scroller. Gestures read this instead of the editor DOM. */
export const bindPaperNoteText = (root: object | null, note: string) => {
  if (root && typeof note === 'string') paperNotes.set(root, note)
}

export const paperNoteTextOf = (
  root: { closest?: (selector: string) => object | null } | null,
) => {
  if (!root) return ''
  const direct = paperNotes.get(root)
  if (direct !== undefined) return direct
  const scroller = root.closest?.('.paper-view, .unified-note-view') ?? null
  if (scroller) {
    const stored = paperNotes.get(scroller)
    if (stored !== undefined) return stored
  }
  return ''
}

export const decideNoteTextGesture = (
  layer: NoteTextLayer,
  gesture: NoteTextGesture,
): NoteTextDecision => {
  const note = typeof layer.note === 'string' ? layer.note : ''
  const anchorX = Number.isFinite(layer.anchorX) ? layer.anchorX : 0
  const anchorY = Number.isFinite(layer.anchorY) ? layer.anchorY : 0
  if (gesture.kind === 'insert') {
    const from = clampIndex(gesture.from, note.length)
    const to = Math.max(from, clampIndex(gesture.to, note.length))
    const insert = typeof gesture.insert === 'string' ? gesture.insert : ''
    const prefix = note.slice(0, from)
    const suffix = note.slice(to)
    return {
      note: prefix + insert + suffix,
      prefix,
      suffix,
      anchorX,
      anchorY,
      signal: 'visible',
      hide: false,
      unmount: false,
      fullClear: false,
      mounted: true,
    }
  }
  return {
    note,
    prefix: note,
    suffix: '',
    anchorX,
    anchorY,
    signal: 'visible',
    hide: false,
    unmount: false,
    fullClear: false,
    mounted: true,
  }
}

type PlainTextNode = {
  textContent: string | null
  style?: { visibility?: string; display?: string }
  querySelector?: (selector: string) => unknown
}

/**
 * Undo a blank or a hide on a plain text node. A CodeMirror surface owns
 * `.cm-line` children; writing `textContent` there would destroy them, so
 * this only clears a hide and restores a node that has no line children.
 */
export const retainPlainNoteText = (text: PlainTextNode | null, decision: NoteTextDecision) => {
  if (!text) return decision.note
  if (text.style) {
    if (text.style.visibility === 'hidden') text.style.visibility = ''
    if (text.style.display === 'none') text.style.display = ''
  }
  if (typeof text.querySelector === 'function' && text.querySelector('.cm-line')) {
    return text.textContent ?? decision.note
  }
  const current = text.textContent ?? ''
  if (current.length === 0 && decision.note.length > 0) text.textContent = decision.note
  return text.textContent ?? decision.note
}
