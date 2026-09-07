/**
 * Keyboard-mode note switches must stay clickable: the overlay is inert, holds
 * no global pointer lock, and is mounted only for notes with saved ink (report
 * 1788698537115: “Everything laggs, i can't press most of the things.”).
 * Saved handwriting itself always loads — a note switch in keyboard mode used
 * to skip the FAMD/ink read, and the handwriting looked deleted.
 */

export type OverlaySession<T = unknown> = { key: number; document: T | null }

/** An overlay session belongs to the note whose ink it was loaded for. */
export type NoteOverlaySession<T = unknown> = OverlaySession<T> & { path: string | null }

/**
 * The render right after a note switch still carries the previous note's
 * session while the active path is already the next note's — the switch
 * effect that replaces the session runs after that commit. Mounting the pair
 * put the previous note's ink on the next note's sheet; the sheet's different
 * size grew the page, marked the document dirty, and the unmount save then
 * wrote that ink under the next note (its marker, its `.famd`) and overwrote
 * the previous note's own record with the remapped strokes. A session renders
 * only for the note it belongs to.
 */
export const overlaySessionForNote = <T>(
  session: NoteOverlaySession<T>,
  notePath: string | null,
): NoteOverlaySession<T> => (
  session.path === notePath ? session : { key: 0, document: null, path: notePath }
)

export type OverlaySwitchState<T = unknown> = {
  drawingOpen: boolean
  session: OverlaySession<T>
}

/** Overlay / live canvas is a hit target only while Stift is on. */
export const overlayHitEnabled = (drawingOpen: boolean) => drawingOpen === true

/** Inline overlay is inert in keyboard mode so it cannot steal clicks or focus. */
export const overlayInert = (inline: boolean, inputActive: boolean) => (
  inline === true && inputActive !== true
)

/**
 * Capture-phase window pointer locks may run only while the inline overlay is
 * the input. Keyboard mode must not install them — leftover capture is what
 * makes ribbon/tab/note controls look dead.
 */
export const overlayGlobalPointerLockOn = (inline: boolean, inputActive: boolean) => (
  inline !== true || inputActive === true
)

/**
 * Keyboard mode unmounts the overlay on the switch itself (the previous note's
 * ink must not linger over the next note). Stift-on keeps a ready session so
 * the pen never waits for the FAMD/ink read.
 */
export const overlaySessionAfterNoteSwitch = <T>(
  switched: OverlaySwitchState<T>,
): OverlaySession<T> => (
  switched.drawingOpen === true
    ? switched.session
    : { key: 0, document: null }
)

/**
 * Saved handwriting is part of the note and shows in both input modes. Stift
 * mode always takes the ready session (an empty page is writable). Keyboard
 * mode mounts the overlay only for notes that actually have saved ink, inert
 * (`overlayInert`), so notes without handwriting stay as light as before and
 * chrome stays clickable — the 1788698537115 lag was a grow loop in the
 * overlay mount, not the mount itself.
 */
export const overlaySessionAfterInkReady = <T>(
  drawingOpen: boolean,
  loaded: OverlaySession<T>,
): OverlaySession<T> => (
  drawingOpen === true || loaded.document !== null
    ? loaded
    : { key: 0, document: null }
)

/** Ink stored inside the note's `.famd` companion carries no library id of its own. */
export const FAMD_INK_ID = 'famd-ink'

/**
 * A FAMD-embedded document takes the note's ink marker id, so its next save
 * updates that note's library record instead of one `famd-ink` record shared
 * by every note. Without a marker the id is cleared and Main assigns a fresh
 * one on save.
 */
export const noteInkDocument = <T extends { id: string }>(
  document: T,
  markerId: string | null,
): T => {
  if (document.id !== FAMD_INK_ID) return document
  return { ...document, id: markerId ?? '' }
}

export type InteractState = {
  drawingOpen: boolean
  sessionKey: number
  leftoverCapture: boolean
  globalLock: boolean
  inert: boolean
  overlayHits: boolean
  noteId: string | null
  loadGeneration: number
}

export const emptyInteractState = (): InteractState => ({
  drawingOpen: false,
  sessionKey: 0,
  leftoverCapture: false,
  globalLock: false,
  inert: true,
  overlayHits: false,
  noteId: null,
  loadGeneration: 0,
})

export const chromePressable = (state: InteractState) => (
  state.leftoverCapture === false
  && state.overlayHits === overlayHitEnabled(state.drawingOpen)
  && state.globalLock === overlayGlobalPointerLockOn(true, state.drawingOpen)
  && state.inert === overlayInert(true, state.drawingOpen)
  && (state.drawingOpen === true || state.overlayHits === false)
)

/** Keyboard mode keeps no overlay for a note without saved ink (the replayed bug events carry no ink). */
export const overlayIdleInKeyboardMode = (state: Pick<InteractState, 'drawingOpen' | 'sessionKey'>) => (
  state.drawingOpen === true || state.sessionKey === 0
)

export type InteractOp =
  | { type: 'session-start' }
  | { type: 'note-switch'; requestId: number; noteId?: string | null }
  | { type: 'ink-ready'; requestId: number }
  | { type: 'stift'; open: boolean }
  | { type: 'capture'; leftover: boolean }

const interactFromStift = (state: InteractState, drawingOpen: boolean): InteractState => ({
  ...state,
  drawingOpen,
  leftoverCapture: false,
  globalLock: overlayGlobalPointerLockOn(true, drawingOpen),
  inert: overlayInert(true, drawingOpen),
  overlayHits: overlayHitEnabled(drawingOpen),
  sessionKey: drawingOpen
    ? Math.max(1, state.sessionKey, state.loadGeneration)
    : state.sessionKey,
})

export const applyInteractOp = (state: InteractState, op: InteractOp): InteractState => {
  if (op.type === 'session-start') return emptyInteractState()
  if (op.type === 'capture') {
    return { ...state, leftoverCapture: op.leftover === true }
  }
  if (op.type === 'stift') return interactFromStift(state, op.open === true)
  if (op.type === 'note-switch') {
    const drawingOpen = state.drawingOpen
    const session = overlaySessionAfterNoteSwitch({
      drawingOpen,
      session: { key: Math.max(1, op.requestId), document: null },
    })
    return {
      drawingOpen,
      sessionKey: session.key,
      leftoverCapture: false,
      globalLock: overlayGlobalPointerLockOn(true, drawingOpen),
      inert: overlayInert(true, drawingOpen),
      overlayHits: overlayHitEnabled(drawingOpen),
      noteId: typeof op.noteId === 'string' ? op.noteId : null,
      loadGeneration: op.requestId,
    }
  }
  if (op.requestId !== state.loadGeneration) return state
  const session = overlaySessionAfterInkReady(
    state.drawingOpen,
    { key: Math.max(1, op.requestId), document: null },
  )
  return {
    ...state,
    leftoverCapture: false,
    sessionKey: session.key,
    globalLock: overlayGlobalPointerLockOn(true, state.drawingOpen),
    inert: overlayInert(true, state.drawingOpen),
    overlayHits: overlayHitEnabled(state.drawingOpen),
  }
}

export type BugInteractEvent = {
  kind?: string
  message?: string
  noteId?: string
}

/** Drive the stored bug-report note/app sequence. Stale ink-ready is ignored. */
export const interactOpsFromBugEvents = (events: BugInteractEvent[]): InteractOp[] => {
  const ops: InteractOp[] = []
  let requestId = 0
  for (const event of events) {
    if (event?.kind === 'app' && event.message === 'session-start') {
      ops.push({ type: 'session-start' })
      continue
    }
    if (event?.kind !== 'note') continue
    requestId += 1
    ops.push({
      type: 'note-switch',
      requestId,
      noteId: typeof event.noteId === 'string' ? event.noteId : null,
    })
  }
  return ops
}
