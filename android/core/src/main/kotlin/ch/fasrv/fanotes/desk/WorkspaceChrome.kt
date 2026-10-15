package ch.fasrv.fanotes.desk

/**
 * Desktop shell chrome: workspace background, compact rows, glass panels, and the UI font.
 * Defaults match `defaults.ts`: clean, compact off, glass off, Inter.
 */

data class UiFontChoice(val id: String, val label: String, val stack: String)

val UI_FONTS = listOf(
    UiFontChoice("dm", "DM Sans", "'DM Sans', ui-sans-serif, system-ui"),
    UiFontChoice("inter", "Inter / System", "Inter, ui-sans-serif, system-ui"),
    UiFontChoice("plex", "IBM Plex Sans", "'IBM Plex Sans', ui-sans-serif, system-ui"),
    UiFontChoice("source", "Source Sans 3", "'Source Sans 3', ui-sans-serif, system-ui"),
    UiFontChoice("atkinson", "Atkinson Hyperlegible", "Atkinson Hyperlegible, ui-sans-serif, system-ui"),
)

val WORKSPACE_BACKGROUNDS = listOf(
    "clean" to "Klar",
    "gradient" to "Verlauf",
    "mesh" to "Aurora",
    "paper" to "Papier",
)

fun workspaceBackground(raw: String?): String = when (raw) {
    "gradient", "mesh", "paper" -> raw
    else -> "clean"
}

fun uiFontId(raw: String?): String {
    val value = raw?.trim().orEmpty()
    if (value.isEmpty()) return "inter"
    return UI_FONTS.firstOrNull { it.id == value || it.stack == value || it.label.equals(value, ignoreCase = true) }?.id
        ?: "inter"
}

/** Desktop compact mode is off until the setting is turned on. */
fun compactChrome(raw: String?) = raw == "on"

/** Desktop glass is off until the setting is turned on. */
fun glassChrome(raw: String?) = raw == "on"

/** File-tree row height from the desktop `--row-height`. */
fun chromeRowHeightDp(compact: Boolean, overrideDp: Int? = null) = overrideDp ?: if (compact) 27 else 31

/** Desktop sidebar range 210–430, default 286. */
fun sidebarWidthDp(raw: String?) = (raw?.toIntOrNull() ?: 286).coerceIn(210, 430)

/** Desktop info-panel range 220–430, default 286. */
fun rightPanelWidthDp(raw: String?) = (raw?.toIntOrNull() ?: 286).coerceIn(220, 430)
