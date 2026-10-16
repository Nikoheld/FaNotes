package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

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
}