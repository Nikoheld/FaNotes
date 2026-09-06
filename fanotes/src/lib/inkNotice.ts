export type InkNoticeKind = 'success' | 'error' | 'info'

export type InkNotice = {
  kind: InkNoticeKind
  text: string
}

export const SCRIBBLE_ERASE_NOTICE_TEXT = 'Durchkritzeln erkannt: Handschrift gelöscht. Mit Strg+Z kannst du sie sofort zurückholen.'
export const FORM_DETECT_NOTICE_TEXT = 'Form erkannt — halte still, um sie zu glätten.'

/** Transient ink hints must leave the screen on their own. Errors stay until dismissed. */
export const INK_TRANSIENT_NOTICE_MS = 4_000

const TRANSIENT_NOTICE_TEXT = new Set([
  SCRIBBLE_ERASE_NOTICE_TEXT,
  FORM_DETECT_NOTICE_TEXT,
])

export type InkNoticeState = {
  notice: InkNotice | null
  clearAt: number | null
}

export const emptyInkNoticeState = (): InkNoticeState => ({ notice: null, clearAt: null })

export const inkNoticeShouldAutoClear = (notice: InkNotice | null) => (
  Boolean(notice && TRANSIENT_NOTICE_TEXT.has(notice.text))
)

/** Milliseconds until auto-clear, or null if the notice stays until close/replace. */
export const inkNoticeAutoClearDelayMs = (notice: InkNotice | null): number | null => (
  inkNoticeShouldAutoClear(notice) ? INK_TRANSIENT_NOTICE_MS : null
)

export type InkNoticeOp =
  | { type: 'show'; notice: InkNotice; now: number }
  | { type: 'close' }
  | { type: 'tick'; now: number }

export const applyInkNoticeOp = (state: InkNoticeState, op: InkNoticeOp): InkNoticeState => {
  if (op.type === 'close') return emptyInkNoticeState()
  if (op.type === 'show') {
    const delay = inkNoticeAutoClearDelayMs(op.notice)
    return {
      notice: op.notice,
      clearAt: delay == null ? null : op.now + delay,
    }
  }
  if (state.clearAt != null && op.now >= state.clearAt) return emptyInkNoticeState()
  return state
}
