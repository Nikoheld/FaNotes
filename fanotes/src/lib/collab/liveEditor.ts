// CodeMirror binding for a live note (loaded on demand by MarkdownEditor).
import { Prec, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import type * as Y from 'yjs'
import type { LiveAwareness } from './liveAwareness'

/**
 * Text sync, remote cursors and selections (with the person's name and colour) and per-user undo:
 * Ctrl+Z only takes back this person's own edits, never the other person's.
 */
export const liveEditorExtension = (note: { ytext: Y.Text; awareness: LiveAwareness }): Extension => [
  yCollab(note.ytext, note.awareness),
  Prec.high(keymap.of(yUndoManagerKeymap)),
]
