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

/** One radial glow from the desktop shell background. [stop] is where it fades out. */
data class BackdropOrb(
    val x: Float,
    val y: Float,
    val alpha: Float,
    val stop: Float,
    val secondary: Boolean = false,
)

/** Paper rules are 24px apart at 2.7% of the accent. The workspace dots sit on an 18px grid. */
const val PAPER_LINE_STEP = 24f
const val PAPER_LINE_ALPHA = 0.027f
const val PAPER_DOT_STEP = 18f
const val PAPER_DOT_ALPHA = 0.12f
const val PAPER_DOT_RADIUS = 0.65f

fun backdropOrbs(kind: String): List<BackdropOrb> = when (kind) {
    "gradient" -> listOf(BackdropOrb(0.82f, -0.2f, 0.09f, 0.35f))
    "mesh" -> listOf(
        BackdropOrb(0.09f, 0.04f, 0.14f, 0.30f),
        BackdropOrb(0.88f, 0.86f, 0.13f, 0.32f, secondary = true),
    )
    else -> emptyList()
}

/** Distance to the farthest corner, the default size of a CSS radial gradient. */
fun farthestCorner(width: Float, height: Float, x: Float, y: Float): Float {
    if (width <= 0f || height <= 0f) return 0f
    val corners = arrayOf(0f to 0f, width to 0f, 0f to height, width to height)
    var best = 0f
    for ((cornerX, cornerY) in corners) {
        val dx = cornerX - x
        val dy = cornerY - y
        val distance = kotlin.math.sqrt(dx * dx + dy * dy)
        if (distance > best) best = distance
    }
    return best
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

/** The file tree stays beside vault search, the same way the desktop sidebar does. */
fun workspaceKeepsNoteChrome(destination: String): Boolean =
    destination == "notes" || destination == "search"

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

/**
 * Note tab after the later chrome pass. The bar itself is `--bg`. Each tab is
 * 28px tall with 6px corners and a 4×2px margin. An open tab prefers 168px.
 * A pinned tab shrinks to its label, up to 150px, and drops the close control.
 */
data class NoteTabBox(
    val heightDp: Int,
    val radiusDp: Int,
    val marginXDp: Int,
    val marginYDp: Int,
    val minWidthDp: Int,
    val maxWidthDp: Int,
    val basisDp: Int,
    val padStartDp: Int,
    val padEndDp: Int,
)

fun noteTabBox(pinned: Boolean): NoteTabBox = if (pinned) {
    NoteTabBox(28, 6, 2, 4, 0, 150, 0, 8, 8)
} else {
    NoteTabBox(28, 6, 2, 4, 118, 196, 168, 8, 5)
}

/** The later pass paints the tab bar with `--bg`, not the elevated surface. */
const val NOTE_TAB_BAR_FILL = "bg"

const val NOTE_TAB_GAP_DP = 7
const val NOTE_TAB_MAIN_PAD_DP = 3
const val NOTE_TAB_FILE_DP = 13
const val NOTE_TAB_PIN_DP = 12
const val NOTE_TAB_SPLIT_DP = 11
const val NOTE_TAB_CLOSE_DP = 21
const val NOTE_TAB_CLOSE_RADIUS_DP = 5
const val NOTE_TAB_CLOSE_ICON_DP = 12
const val NOTE_TAB_HOVER_ALPHA = 0.04f
const val NOTE_TAB_DROP_WIDTH_DP = 2
const val NOTE_TAB_DROP_INSET_DP = 5
const val NOTE_TAB_DROP_RADIUS_DP = 2

/** History buttons keep the 33px row. The later pass sets both labels to weight 500. */
const val NOTE_NAV_HEIGHT_DP = 33
const val NOTE_NAV_BACK_PAD_DP = 10
const val NOTE_NAV_GAP_DP = 5
const val NOTE_NAV_FORWARD_DP = 30
const val NOTE_NAV_ICON_DP = 14
const val NOTE_NAV_FONT_SP = 12
const val NOTE_NAV_WEIGHT = 500
const val NOTE_NAV_DISABLED_ALPHA = 0.38f
const val NOTE_NAV_HOVER_ALPHA = 0.05f

/** `--border` is the body ink at 9%. The back button's right rule is 55% of that, because Vorwärts follows it. */
const val NOTE_TAB_RULE_ALPHA = 0.09f
const val NOTE_NAV_RULE_MIX = 0.55f

const val NOTE_TAB_ACCENT_DARK = 0xFF8EC4E0.toInt()
const val NOTE_TAB_ACCENT_LIGHT = 0xFF1A6690.toInt()

fun noteTabAccentArgb(dark: Boolean) = if (dark) NOTE_TAB_ACCENT_DARK else NOTE_TAB_ACCENT_LIGHT

fun noteNavRuleAlpha(back: Boolean): Float =
    if (back) NOTE_TAB_RULE_ALPHA * NOTE_NAV_RULE_MIX else NOTE_TAB_RULE_ALPHA

/** Pin, PDF file, or note file. A pin replaces the file glyph. */
fun noteTabGlyph(path: String, pinned: Boolean): String = when {
    pinned -> "pin"
    path.endsWith(".pdf", ignoreCase = true) -> "pdf"
    else -> "note"
}

/** Active tabs use body text. A split companion uses `--text-soft`. */
fun noteTabInk(selected: Boolean, inSplit: Boolean): String = when {
    selected -> "text"
    inSplit -> "soft"
    else -> "muted"
}

/** The close control is in the layout for every unpinned tab, and visible on the active tab or on hover. */
fun noteTabShowsClose(selected: Boolean, pinned: Boolean, hovered: Boolean = false): Boolean =
    !pinned && (selected || hovered)

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

/**
 * File-tree row after the later chrome pass: 4px corners and a 14px label.
 * The earlier 7px radius and the accent mark are replaced there.
 */
const val TREE_ROW_RADIUS_DP = 4
const val TREE_LABEL_SP = 14
const val TREE_DEPTH_DP = 13
const val TREE_MARK_WIDTH_DP = 2
const val TREE_MARK_HEIGHT_DP = 17
const val TREE_DRAG_ALPHA = 0.42f
const val TREE_SPLIT_MARK_ALPHA = 0.45f
const val TREE_DROP_ALPHA = 0.16f
const val TREE_DROP_BORDER_ALPHA = 0.55f
const val TREE_ICON_DP = 17
const val TREE_CHEVRON_DP = 14

/** Folder color pip from `.file-tree__row[data-kind="folder"]::after`. */
const val TREE_FOLDER_DOT_DP = 3
const val TREE_FOLDER_DOT_INSET_DP = 5
const val TREE_FOLDER_DOT_ALPHA = 0.72f

/** A note hover is 74% of `--panel-hover`. A folder hover is the solid panel color. */
const val TREE_HOVER_ALPHA = 0.74f

fun treeHoverAlpha(folder: Boolean) = if (folder) 1f else TREE_HOVER_ALPHA

/** Inline actions appear on hover or keyboard focus, the same as the desktop row. */
fun treeRowShowsActions(hovered: Boolean, focused: Boolean) = hovered || focused

/** The later chrome pass sets the folder pip to 0×0, so a folder never shows it. */
fun treeFolderShowsDot(folder: Boolean, actionsOpen: Boolean): Boolean {
    if (folder && actionsOpen) return false
    return false
}

/** The later chrome pass removes the active and split accent bars. */
fun treeRowShowsMark() = false

/** Empty expanded folder from `.file-tree__folder-empty` and `.file-tree__empty-subfolder`. */
const val TREE_EMPTY_MIN_DP = 26
const val TREE_EMPTY_GAP_DP = 8
const val TREE_EMPTY_ACTION_DP = 20
const val TREE_EMPTY_ACTION_RADIUS_DP = 5
const val TREE_EMPTY_ACTION_PAD_DP = 6

/** The empty line sits two levels past the folder row: `(depth + 2) * 13`. */
fun treeEmptyIndentDp(depth: Int) = (depth + 2) * TREE_DEPTH_DP

/** The shell grid row is 44px. Ribbon buttons are 30px tall with 6px corners and 8px of side padding. */
const val RIBBON_HEIGHT_DP = 44
const val RIBBON_BUTTON_DP = 30
const val RIBBON_BUTTON_RADIUS_DP = 6
const val RIBBON_BUTTON_PAD_DP = 8

/** Editor toolbar is 36px. Format buttons are 28px with 7px corners. The mode switch is 28px with 24px buttons. */
const val EDITOR_TOOLBAR_DP = 36
const val EDITOR_TOOLBAR_PAD_DP = 10
const val FORMAT_BUTTON_GAP_DP = 2
const val FORMAT_BUTTON_DP = 28
const val FORMAT_BUTTON_RADIUS_DP = 7
const val MODE_SWITCH_DP = 28
const val MODE_SWITCH_RADIUS_DP = 8
const val MODE_BUTTON_DP = 24
const val MODE_BUTTON_RADIUS_DP = 6
const val MODE_ACTIVE_RING = 0.34f
const val FORMAT_DISABLED_ALPHA = 0.48f

/** Mode switch track is `--panel`. The active segment is `--panel-active`. */
fun modeSwitchTrackColor(dark: Boolean): Int = if (dark) 0xFF202020.toInt() else 0xFFF7F6F3.toInt()

fun modeSwitchActiveColor(dark: Boolean): Int = if (dark) 0xFF3A3A3A.toInt() else 0xFFE3E2DE.toInt()

/** Inactive labels are muted. The active label is the body text. */
fun modeSwitchInk(dark: Boolean, selected: Boolean): Int = when {
    selected && dark -> 0xFFEDEDEC.toInt()
    selected -> 0xFF37352F.toInt()
    dark -> 0xFFB3B3AE.toInt()
    else -> 0xFF5E5C57.toInt()
}

/** Format chips use `--text-soft`. */
fun formatChipInk(dark: Boolean): Int = if (dark) 0xFFCFCFCA.toInt() else 0xFF4E4C47.toInt()

/** Toolbar fill is `--bg`. The bottom rule is `--border` at 9%. */
fun editorToolbarColor(dark: Boolean): Int = if (dark) 0xFF191919.toInt() else 0xFFFFFFFF.toInt()

fun editorToolbarRule(dark: Boolean): Int {
    val alpha = kotlin.math.round(255f * 0.09f).toInt().coerceIn(0, 255)
    val rgb = if (dark) 0xFFFFFF else 0x37352F
    return (alpha shl 24) or rgb
}

/** Inset ring: 34% of the accent over transparency. */
fun modeSwitchRing(accent: Int): Int {
    val alpha = kotlin.math.round(255f * MODE_ACTIVE_RING).toInt().coerceIn(0, 255)
    return (alpha shl 24) or (accent and 0x00FFFFFF)
}

/** Desktop sidebar range 210–430, default 286. */
fun sidebarWidthDp(raw: String?) = (raw?.toIntOrNull() ?: 286).coerceIn(210, 430)

/** Desktop info-panel range 220–430, default 286. */
fun rightPanelWidthDp(raw: String?) = (raw?.toIntOrNull() ?: 286).coerceIn(220, 430)

/**
 * Left status label from the desktop footer.
 * Kalender, Hausaufgaben and the vault overview win. An open note is then
 * Stiftmodus, PDF-Notiz, Notiz mit Arbeitsblatt, or Schreibmodus.
 */
fun statusModeLabel(
    destination: String,
    noteOpen: Boolean,
    penOpen: Boolean,
    pdf: Boolean,
    worksheets: Int,
): String = when (destination) {
    "calendar" -> "Kalender"
    "tasks" -> "Hausaufgaben & Termine"
    "overview" -> "Vault-Übersicht"
    else -> when {
        !noteOpen -> "Bereit"
        penOpen -> "Stiftmodus"
        pdf -> "PDF-Notiz"
        worksheets > 0 -> "Notiz mit Arbeitsblatt"
        else -> "Schreibmodus"
    }
}

/** Breadcrumbs stay with the note except on the three full-screen surfaces. */
fun statusShowsPath(destination: String): Boolean =
    destination != "calendar" && destination != "tasks" && destination != "overview"

/** Extra status chip for the open worksheet stack. */
fun statusWorksheetLabel(count: Int): String? = when {
    count <= 0 -> null
    count == 1 -> "1 Arbeitsblatt"
    else -> "$count Arbeitsblätter"
}

/** Save chip: Gespeichert, Speichert …, Speicherfehler. */
fun statusSaveLabel(phase: String): String = when (phase) {
    "saving" -> "Speichert …"
    "error" -> "Speicherfehler"
    else -> "Gespeichert"
}

/** Which theme ink the save chip uses: danger, warning, or success. */
fun statusSaveTone(label: String): String = when (label) {
    "Speicherfehler" -> "danger"
    "Speichert …" -> "warning"
    else -> "success"
}

/**
 * Sync chip from `.sync-status-item`. Idle is success, an error is danger,
 * and offline stays muted. Hover replaces that ink with the body text.
 */
fun statusSyncTone(status: String): String = when (status) {
    "idle" -> "success"
    "error" -> "danger"
    else -> "muted"
}

fun statusChipInk(hot: Boolean, idle: String) = if (hot) "text" else idle

const val STATUS_LOCAL_PRIVATE = "Lokal & privat"

/** Status bar from `.statusbar`: 28px row, 11px groups, and 20px crumb buttons. */
const val STATUS_BAR_DP = 28
const val STATUS_GROUP_GAP_DP = 11
const val STATUS_PAD_DP = 12
const val STATUS_BUTTON_DP = 20
const val STATUS_BUTTON_RADIUS_DP = 5
const val STATUS_SAVE_PAD_DP = 5
const val STATUS_SYNC_RADIUS_DP = 6
const val STATUS_SYNC_PAD_DP = 6
const val STATUS_CONFLICT_MIN_DP = 14
const val STATUS_CONFLICT_HEIGHT_DP = 14
const val STATUS_CONFLICT_RADIUS_DP = 7
const val STATUS_CONFLICT_PAD_DP = 4
const val STATUS_CONFLICT_ALPHA = 0.18f
const val STATUS_CRUMB_GAP_DP = 1
const val STATUS_CRUMB_INSET_DP = 11
const val STATUS_CRUMB_PAD_DP = 5
const val STATUS_FOLDER_MAX_DP = 160
const val STATUS_NOTE_MAX_DP = 220

/** Floating notice from `.toast` after the later chrome pass. */
const val TOAST_MIN_DP = 44
const val TOAST_RADIUS_DP = 8
const val TOAST_MAX_DP = 360
const val TOAST_FONT_SP = 13
const val TOAST_CLOSE_DP = 25
const val TOAST_CLOSE_RADIUS_DP = 7
const val TOAST_GAP_DP = 9
const val TOAST_PAD_START_DP = 11
const val TOAST_PAD_DP = 8
const val TOAST_INSET_END_DP = 14
const val TOAST_INSET_BOTTOM_DP = 12
