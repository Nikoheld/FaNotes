/**
 * Keyboard-mode note switches must stay clickable and must not remount the
 * heavy ink overlay — including after that note's FAMD/ink load. Report
 * 1788698537115: “Everything laggs, i can't press most of the things.”
 */

export type OverlaySession<T = unknown> = { key: number; document: T | null }

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
 * FAMD/sidecar ink load on a note switch is only for Stift mode. Keyboard-mode
 * switches must not parse or remount the overlay — that remount is the remaining
 * 1788698537115 lag after leftover capture was dropped.
 */
export const overlayInkLoadOnNoteSwitch = (drawingOpen: boolean) => drawingOpen === true

/**
 * Keyboard mode unmounts the overlay on the switch itself. Stift-on keeps a
 * ready session.
 */
export const overlaySessionAfterNoteSwitch = <T>(
  switched: OverlaySwitchState<T>,
): OverlaySession<T> => (
  switched.drawingOpen === true
    ? switched.session
    : { key: 0, document: null }
)

/**
 * Ink-ready may remount only while Stift is on. Keyboard mode keeps key 0 so a
 * finished FAMD/ink read cannot put DrawingBoard back over the chrome.
 */
export const overlaySessionAfterInkReady = <T>(
  drawingOpen: boolean,
  loaded: OverlaySession<T>,
): OverlaySession<T> => (
  drawingOpen === true
    ? loaded
    : { key: 0, document: null }
)

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

/** Keyboard mode must not keep a mounted overlay — remounting it is the lag. */
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
