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

data class PendingConfirm(
    val title: String,
    val message: String,
    val confirmLabel: String,
    val cancelLabel: String = "Abbrechen",
)
