package ch.fasrv.fanotes.ink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class InkNoticeTest {
    @Test
    fun scribbleAndShapeHintsLeaveAndATakenShapeStays() {
        val scribble = InkNotice("success", scribbleEraseNotice(alreadyShown = false)!!)
        assertNull(scribbleEraseNotice(alreadyShown = true))
        val shown = applyInkNoticeOp(emptyInkNoticeState(), InkNoticeOp.Show(scribble, 1_000))
        assertEquals(1_000 + INK_TRANSIENT_NOTICE_MS, shown.clearAt)
        assertEquals(scribble, applyInkNoticeOp(shown, InkNoticeOp.Tick(4_999)).notice)
        assertNull(applyInkNoticeOp(shown, InkNoticeOp.Tick(5_000)).notice)
        val taken = applyInkNoticeOp(
            shown,
            InkNoticeOp.Show(InkNotice("success", FORM_TAKEN_NOTICE_TEXT), 2_000),
        )
        assertNull(taken.clearAt)
        assertEquals(FORM_TAKEN_NOTICE_TEXT, applyInkNoticeOp(taken, InkNoticeOp.Tick(99_000)).notice?.text)
        assertNull(applyInkNoticeOp(taken, InkNoticeOp.Close).notice)
        val hint = InkNotice("info", FORM_DETECT_NOTICE_TEXT)
        assertEquals(INK_TRANSIENT_NOTICE_MS, inkNoticeAutoClearDelayMs(hint))
    }
}
