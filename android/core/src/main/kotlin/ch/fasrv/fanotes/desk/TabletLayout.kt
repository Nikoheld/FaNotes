package ch.fasrv.fanotes.desk

/**
 * Tablet layer beside the pinned desktop chrome constants in WorkspaceChrome.kt.
 * Nothing here changes a desktop value; the app picks these when the touch layer
 * is on or the window is narrower than a desktop window.
 */

/** Material window-size classes by width in dp. */
enum class WidthClass { COMPACT, MEDIUM, EXPANDED }

const val WIDTH_MEDIUM_MIN_DP = 600
const val WIDTH_EXPANDED_MIN_DP = 840

fun widthClass(widthDp: Int): WidthClass = when {
    widthDp >= WIDTH_EXPANDED_MIN_DP -> WidthClass.EXPANDED
    widthDp >= WIDTH_MEDIUM_MIN_DP -> WidthClass.MEDIUM
    else -> WidthClass.COMPACT
}

/** Smallest comfortable finger target (Android guideline). */
const val TOUCH_MIN_DP = 48

/**
 * Setting "touch-large": explicit "on"/"off". Unset, it follows the input hardware, not the window
 * width: a device with a touchscreen is finger-navigated (a tablet in landscape is 840 dp or wider
 * and still needs 48 dp targets), so the large layer is on; a touchless device keeps the compact one.
 */
fun touchLarge(raw: String?, touchscreen: Boolean): Boolean = when (raw) {
    "on" -> true
    "off" -> false
    else -> touchscreen
}

/**
 * Chrome dimensions for one layer. With [large] off every value is the pinned
 * desktop constant; with it on, hit areas are at least [TOUCH_MIN_DP] while the
 * drawn visuals keep their compact size (the app draws the visual inside the
 * larger hit box).
 */
data class TouchMetrics(val large: Boolean) {
    val ribbonHeightDp: Int get() = if (large) 56 else RIBBON_HEIGHT_DP
    val ribbonButtonDp: Int get() = if (large) TOUCH_MIN_DP else RIBBON_BUTTON_DP
    /** Drawn height of a ribbon button; stays compact in both layers. */
    val ribbonButtonVisualDp: Int get() = RIBBON_BUTTON_DP
    val navHeightDp: Int get() = if (large) TOUCH_MIN_DP else NOTE_NAV_HEIGHT_DP
    val tabCloseHitDp: Int get() = if (large) TOUCH_MIN_DP else NOTE_TAB_CLOSE_DP
    val tabMinHeightDp: Int get() = if (large) TOUCH_MIN_DP else 0
    val statusBarDp: Int get() = if (large) 52 else STATUS_BAR_DP
    val statusChipDp: Int get() = if (large) TOUCH_MIN_DP else STATUS_BUTTON_DP
    val treeRowDp: Int get() = TOUCH_MIN_DP.takeIf { large } ?: 0
    val menuRowDp: Int get() = if (large) TOUCH_MIN_DP else TREE_MENU_ROW_DP
    val sidebarActionDp: Int get() = if (large) TOUCH_MIN_DP else 30
    val settingRowMinDp: Int get() = if (large) 56 else 0
    /** Hit box of a round colour swatch; the drawn dot keeps its compact size. */
    val swatchHitDp: Int get() = if (large) TOUCH_MIN_DP else SWATCH_HIT_DP
    /** Hit height of a chip or text link (tags, sidebar links, segment options). */
    val chipHitDp: Int get() = if (large) TOUCH_MIN_DP else 0
    /** Hit target of the split divider; Compose extends a narrower layout box to this for touch. */
    val dividerHitDp: Int get() = if (large) TOUCH_MIN_DP else SPLIT_DIVIDER_DP
    /** Layout thickness of the divider; the drawn strip stays [dividerVisualDp]. */
    val dividerLayoutDp: Int get() = if (large) 24 else SPLIT_DIVIDER_DP
    val dividerVisualDp: Int get() = SPLIT_DIVIDER_DP

    /** Tree row height: the desktop row height, raised to the touch minimum in the large layer. */
    fun treeRowHeightDp(desktopDp: Int): Int = if (large) maxOf(desktopDp, TOUCH_MIN_DP) else desktopDp
}

const val SPLIT_DIVIDER_DP = 8

/**
 * Below this window width the ribbon's extra tools (Tagesnotiz ... Einstellungen) open in a popup menu;
 * inline they would run past the screen edge. Landscape tablets (>= 1000 dp) keep them inline like the desktop.
 */
const val RIBBON_TOOLS_POPUP_BELOW_DP = 1000

/** Compact swatch hit box (the drawn dot is SWATCH_DP = 23 plus its gap). */
const val SWATCH_HIT_DP = 23

/**
 * A settings row puts the label beside the control only when the content column is at least this wide;
 * narrower, it stacks. The modal on an 800 dp portrait tablet leaves ~470 dp, where a 360 dp control
 * squeezed the label to one letter per line (the old 420 dp limit was too low).
 */
const val SETTING_ROW_STACK_BELOW_DP = 560

/** How the sidebar is shown for a window. */
enum class SidebarMode { PINNED, DRAWER }

data class AdaptivePanels(
    val sidebarMode: SidebarMode,
    /** PINNED: user's sidebar choice. DRAWER: whether the overlay is open. */
    val sidebarVisible: Boolean,
    val inspectorInline: Boolean,
    val inspectorOverlay: Boolean,
    /** The note stays visible beside or below the sidebar/inspector overlay. */
    val noteVisible: Boolean,
)

/**
 * Expanded width keeps the desktop layout (sidebar beside the note, inspector inline).
 * Compact and medium keep the note on screen and slide the sidebar (and the inspector)
 * over it as a drawer.
 */
fun adaptivePanels(
    width: WidthClass,
    focus: Boolean,
    notes: Boolean,
    sidebarOpen: Boolean,
    drawerOpen: Boolean,
    inspectorOpen: Boolean,
    outlineEnabled: Boolean,
): AdaptivePanels {
    val expanded = width == WidthClass.EXPANDED
    if (!notes || focus) {
        return AdaptivePanels(
            if (expanded) SidebarMode.PINNED else SidebarMode.DRAWER,
            sidebarVisible = false,
            inspectorInline = false,
            inspectorOverlay = false,
            noteVisible = true,
        )
    }
    val inspector = inspectorOpen && outlineEnabled
    return AdaptivePanels(
        sidebarMode = if (expanded) SidebarMode.PINNED else SidebarMode.DRAWER,
        sidebarVisible = if (expanded) sidebarOpen else drawerOpen,
        inspectorInline = expanded && inspector,
        inspectorOverlay = !expanded && inspector,
        noteVisible = true,
    )
}

/** Drawer width: the user's sidebar width, never wider than 85% of the window and at least 240. */
fun drawerWidthDp(windowWidthDp: Int, sidebarDp: Int): Int {
    val cap = (windowWidthDp * 0.85f).toInt().coerceAtLeast(1)
    return sidebarDp.coerceAtLeast(240).coerceAtMost(cap)
}

const val SPLIT_COLUMN_MIN_PANE_DP = 360

/**
 * Split orientation. An explicit "rows"/"columns" setting wins; otherwise the
 * available space decides: rows when two columns would be narrower than
 * [SPLIT_COLUMN_MIN_PANE_DP] each, or when the area is clearly taller than wide.
 */
fun splitRowsFor(setting: String?, availableWidthDp: Int, availableHeightDp: Int): Boolean = when (setting) {
    "rows" -> true
    "columns" -> false
    else -> availableWidthDp < 2 * SPLIT_COLUMN_MIN_PANE_DP + SPLIT_DIVIDER_DP ||
        availableHeightDp > availableWidthDp * 1.25f
}

/** Sidebar/inspector width while dragging, clamped to the range of the settings sliders. */
fun clampSidebarDp(widthDp: Float): Int = widthDp.toInt().coerceIn(210, 430)

fun clampPanelDp(widthDp: Float): Int = widthDp.toInt().coerceIn(220, 430)

/** Drag handle hit width on a panel edge: wide enough for a finger without covering much of the page. */
fun panelHandleHitDp(large: Boolean): Int = if (large) 40 else 16
