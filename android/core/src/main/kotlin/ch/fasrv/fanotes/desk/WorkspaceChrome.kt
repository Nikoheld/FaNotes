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

/**
 * Which note-workspace panels are on screen.
 * Focus hides both. A wide window uses the sidebar and outline toggles.
 * A narrow window keeps the existing list toggle and has no outline column.
 */
data class NoteWorkspacePanels(val sidebar: Boolean, val inspector: Boolean)

fun noteWorkspacePanels(
    focus: Boolean,
    wide: Boolean,
    showList: Boolean,
    sidebarOpen: Boolean,
    inspectorOpen: Boolean,
    outlineEnabled: Boolean,
    notes: Boolean,
): NoteWorkspacePanels {
    if (!notes || focus) return NoteWorkspacePanels(sidebar = false, inspector = false)
    return NoteWorkspacePanels(
        sidebar = if (wide) sidebarOpen else showList,
        inspector = wide && inspectorOpen && outlineEnabled,
    )
}

/** Desktop compact mode is off until the setting is turned on. */
fun compactChrome(raw: String?) = raw == "on"

data class RibbonItem(val id: String, val label: String)

/** Main ribbon, in the desktop order. Stift is a mode, not a screen. */
val RIBBON_PRIMARY = listOf(
    RibbonItem("notes", "Notizen"),
    RibbonItem("search", "Suchen"),
    RibbonItem("pen", "Stift"),
    RibbonItem("tasks", "Aufgaben"),
    RibbonItem("calendar", "Kalender"),
)

/** Extra tools behind Werkzeuge. GlyphenWerk stays out. */
val RIBBON_TOOLS = listOf(
    RibbonItem("daily", "Tagesnotiz"),
    RibbonItem("overview", "Übersicht"),
    RibbonItem("cards", "Karten"),
    RibbonItem("books", "Fachbuch"),
    RibbonItem("history", "Verlauf"),
    RibbonItem("study", "Lernzeit"),
    RibbonItem("ai", "AI"),
    RibbonItem("commands", "Befehle"),
    RibbonItem("focus", "Fokus"),
)

fun ribbonToolLabel(open: Boolean) = if (open) "Weniger" else "Werkzeuge"

fun ribbonItemActive(id: String, destination: String, penOpen: Boolean): Boolean = when (id) {
    "pen" -> penOpen && destination == "notes"
    "notes" -> destination == "notes" && !penOpen
    else -> destination == id
}

/** Desktop glass is off until the setting is turned on. */
fun glassChrome(raw: String?) = raw == "on"

/** Desktop „Bewegung reduzieren“ is off until the setting is turned on. */
fun reduceMotion(raw: String?) = raw == "on"

/** Palette and search follow the selection instantly when motion is reduced. */
fun listFollowsSelection(reduceMotion: Boolean): String = if (reduceMotion) "instant" else "animate"

/** File-tree row height from the desktop `--row-height`. */
fun chromeRowHeightDp(compact: Boolean, overrideDp: Int? = null) = overrideDp ?: if (compact) 27 else 31

/** Desktop sidebar range 210–430, default 286. */
fun sidebarWidthDp(raw: String?) = (raw?.toIntOrNull() ?: 286).coerceIn(210, 430)

/** Desktop info-panel range 220–430, default 286. */
fun rightPanelWidthDp(raw: String?) = (raw?.toIntOrNull() ?: 286).coerceIn(220, 430)
