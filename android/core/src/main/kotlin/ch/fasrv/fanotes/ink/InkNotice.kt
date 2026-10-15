package ch.fasrv.fanotes.ink

/**
 * Drawing-board notices from `fanotes/src/lib/inkNotice.ts`.
 * Scribble and the early shape hint leave on their own. A recognized figure
 * and errors stay until the next notice or an explicit close.
 */

data class InkNotice(val kind: String, val text: String)

const val SCRIBBLE_ERASE_NOTICE_TEXT =
    "Durchkritzeln erkannt: Handschrift gelöscht. Mit Strg+Z kannst du sie sofort zurückholen."
const val FORM_DETECT_NOTICE_TEXT = "Form erkannt — halte still, um sie zu glätten."
const val FORM_TAKEN_NOTICE_TEXT = "Form übernommen."
const val INK_TRANSIENT_NOTICE_MS = 4_000L

private val TRANSIENT_NOTICE_TEXT = setOf(SCRIBBLE_ERASE_NOTICE_TEXT, FORM_DETECT_NOTICE_TEXT)

data class InkNoticeState(val notice: InkNotice?, val clearAt: Long?)

fun emptyInkNoticeState() = InkNoticeState(notice = null, clearAt = null)

fun inkNoticeShouldAutoClear(notice: InkNotice?) = notice != null && notice.text in TRANSIENT_NOTICE_TEXT

fun inkNoticeAutoClearDelayMs(notice: InkNotice?): Long? =
    if (inkNoticeShouldAutoClear(notice)) INK_TRANSIENT_NOTICE_MS else null

sealed class InkNoticeOp {
    data class Show(val notice: InkNotice, val nowMs: Long) : InkNoticeOp()
    data object Close : InkNoticeOp()
    data class Tick(val nowMs: Long) : InkNoticeOp()
}

fun applyInkNoticeOp(state: InkNoticeState, op: InkNoticeOp): InkNoticeState = when (op) {
    InkNoticeOp.Close -> emptyInkNoticeState()
    is InkNoticeOp.Show -> {
        val delay = inkNoticeAutoClearDelayMs(op.notice)
        InkNoticeState(op.notice, if (delay == null) null else op.nowMs + delay)
    }
    is InkNoticeOp.Tick -> if (state.clearAt != null && op.nowMs >= state.clearAt) emptyInkNoticeState() else state
}

/** Desktop shows the scribble hint once per drawing session. */
fun scribbleEraseNotice(alreadyShown: Boolean): String? =
    if (alreadyShown) null else SCRIBBLE_ERASE_NOTICE_TEXT
