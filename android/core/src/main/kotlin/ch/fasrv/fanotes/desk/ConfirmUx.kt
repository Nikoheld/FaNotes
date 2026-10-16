package ch.fasrv.fanotes.desk

/**
 * The desktop confirm dialog answers Escape itself and keeps Enter from
 * confirming a delete the user has not looked at. Tab stays inside the buttons.
 * Matches `confirmUx.ts`.
 */
fun confirmDialogKeyAction(key: String): String? =
    if (key == "Escape" || key == "Esc") "cancel" else null

fun confirmDialogTabTarget(buttonCount: Int, focusedIndex: Int, backwards: Boolean): Int? {
    if (buttonCount <= 0) return null
    if (focusedIndex < 0) return if (backwards) buttonCount - 1 else 0
    return (focusedIndex + (if (backwards) buttonCount - 1 else 1)) % buttonCount
}

/** A vault file is deleted here. The desktop moves the same entry to the system trash. */
fun vaultDeleteMessage(folder: Boolean, name: String): String {
    val type = if (folder) "Ordner" else "Notiz"
    return "$type „$name“ wirklich löschen?"
}

fun noteLinkRemoveMessage(): String =
    "Verlinkung wirklich entfernen? Die verlinkte Notiz bleibt im Vault."

/** Confirm dialog after the later chrome pass: 12px corners, a 36px mark, 34px buttons. */
const val CONFIRM_RADIUS_DP = 12
const val CONFIRM_MAX_DP = 440
const val CONFIRM_ICON_DP = 36
const val CONFIRM_ICON_RADIUS_DP = 11
const val CONFIRM_GAP_DP = 14
const val CONFIRM_HEADER_GAP_DP = 12
const val CONFIRM_PAD_X_DP = 22
const val CONFIRM_PAD_TOP_DP = 20
const val CONFIRM_PAD_BOTTOM_DP = 18
const val CONFIRM_BODY_INSET_DP = 48
const val CONFIRM_TITLE_SP = 16
const val CONFIRM_BODY_SP = 12.5f
const val CONFIRM_BUTTON_DP = 34
const val CONFIRM_BUTTON_RADIUS_DP = 6
const val CONFIRM_BUTTON_PAD_DP = 14
const val CONFIRM_EYEBROW = "ACHTUNG"

data class PendingConfirm(
    val title: String,
    val message: String,
    val confirmLabel: String,
    val cancelLabel: String = "Abbrechen",
)
