package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ConfirmUxTest {
    @Test
    fun escapeCancelsAndEnterDoesNotConfirm() {
        assertEquals("cancel", confirmDialogKeyAction("Escape"))
        assertEquals("cancel", confirmDialogKeyAction("Esc"))
        assertNull(confirmDialogKeyAction("Enter"))
        assertNull(confirmDialogKeyAction(" "))
    }

    @Test
    fun tabStaysInsideTheDialogButtons() {
        assertNull(confirmDialogTabTarget(0, 0, false))
        assertEquals(0, confirmDialogTabTarget(2, -1, false))
        assertEquals(1, confirmDialogTabTarget(2, -1, true))
        assertEquals(1, confirmDialogTabTarget(2, 0, false))
        assertEquals(0, confirmDialogTabTarget(2, 1, false))
        assertEquals(1, confirmDialogTabTarget(2, 0, true))
    }

    @Test
    fun deleteAndLinkPromptsUseTheDesktopWording() {
        assertEquals("Notiz „Vorlesung“ wirklich löschen?", vaultDeleteMessage(folder = false, name = "Vorlesung"))
        assertEquals("Ordner „Schule“ wirklich löschen?", vaultDeleteMessage(folder = true, name = "Schule"))
        assertEquals(
            "Verlinkung wirklich entfernen? Die verlinkte Notiz bleibt im Vault.",
            noteLinkRemoveMessage(),
        )
        assertEquals(12, CONFIRM_RADIUS_DP)
        assertEquals(440, CONFIRM_MAX_DP)
        assertEquals(36, CONFIRM_ICON_DP)
        assertEquals(11, CONFIRM_ICON_RADIUS_DP)
        assertEquals(48, CONFIRM_BODY_INSET_DP)
        assertEquals(16, CONFIRM_TITLE_SP)
        assertEquals(34, CONFIRM_BUTTON_DP)
        assertEquals(6, CONFIRM_BUTTON_RADIUS_DP)
        assertEquals("ACHTUNG", CONFIRM_EYEBROW)
    }

    @Test
    fun theConfirmDialogShadowIsOffsetDownward() {
        assertEquals(0, CONFIRM_SHADOW_X_DP)
        assertEquals(12, CONFIRM_SHADOW_Y_DP)
        assertEquals(40, CONFIRM_SHADOW_BLUR_DP)
        assertEquals(0.08f, CONFIRM_SHADOW_ALPHA)
        val shadow = confirmDialogShadow()
        assertEquals(0, shadow.xDp)
        assertEquals(12, shadow.yDp)
        assertEquals(40, shadow.blurDp)
        assertEquals(0.08f, shadow.alpha)
        assertTrue(shadow.yDp != 0)
        val reach = confirmShadowReach(shadow)
        assertEquals(40, reach.leftDp)
        assertEquals(28, reach.topDp)
        assertEquals(40, reach.rightDp)
        assertEquals(52, reach.bottomDp)
        assertEquals(reach.leftDp, reach.rightDp)
        assertTrue(reach.bottomDp > reach.topDp)
        val frame = checkNotNull(confirmShadowFrame(400f, 200f, 2f))
        assertEquals(80f, frame.blurPx)
        assertEquals(0f, frame.shapeLeftPx - frame.padPx)
        assertEquals(24f, frame.shapeTopPx - frame.padPx)
        assertTrue(frame.shapeTopPx - frame.padPx != 0f)
        assertEquals(0x140F0F0F, frame.color)
        assertEquals(0x140F0F0F, confirmShadowColor(0.08f))
        assertTrue(frame.shapeBottomPx + frame.blurPx < frame.bitmapHeightPx)
        assertTrue(confirmShadowFavorsDown(frame, 200f))
        val flat = frame.copy(shapeTopPx = frame.padPx, shapeBottomPx = frame.padPx + 200f)
        assertTrue(!confirmShadowFavorsDown(flat, 200f))
        assertTrue(confirmShadowFrame(0f, 200f, 2f) == null)
    }
}