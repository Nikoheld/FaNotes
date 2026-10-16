package ch.fasrv.fanotes.desk

import kotlin.math.roundToInt

/**
 * Centered `.settings-modal`.
 * Above 760: `min(1080px, 95vw)` by `min(760px, 92vh)`, radius 12 from the later rule.
 * At 760 and below: `100vw` by `100vh`, radius 0, border cleared.
 * The shadow is the later `0 24px 80px rgba(0, 0, 0, .16)`, already [bugReportPanelShadow].
 */
const val SETTINGS_MODAL_MAX_WIDTH_DP = 1080
const val SETTINGS_MODAL_MAX_HEIGHT_DP = 760
const val SETTINGS_MODAL_WIDTH_PERCENT = 95
const val SETTINGS_MODAL_HEIGHT_PERCENT = 92
const val SETTINGS_MODAL_RADIUS_DP = 12
const val SETTINGS_MODAL_FULL_DP = 760

/** `.settings-modal { grid-template-columns: 76px minmax(0, 1fr) }` at max-width 760px. */
const val SETTINGS_NAV_NARROW_DP = 76
/** `.settings-nav { padding-inline: 8px }` at that breakpoint. */
const val SETTINGS_NAV_NARROW_PAD_X_DP = 8
/** `.settings-nav nav button { padding: 5px }` at that breakpoint. */
const val SETTINGS_NAV_NARROW_BUTTON_PAD_DP = 5

/**
 * True when the viewport is 760dp or below, where [settingsModalSize] returns radius 0.
 * At 761 the centered card keeps labels. Pass the same width as [settingsModalSize].
 * Brand text, group headings, row labels, and the search field hide; each row keeps its icon.
 * The later active-row rule clears the media query's bottom accent, so the wash stays.
 */
fun settingsNavCollapses(widthDp: Int): Boolean = widthDp <= SETTINGS_MODAL_FULL_DP

/**
 * `.settings-content > header { padding-inline: 16px }` at max-width 760px.
 * Top and bottom stay 18 and 15.
 */
const val SETTINGS_HEADER_NARROW_PAD_X_DP = 16

/** `.settings-scroll { padding: 15px 16px 28px }` — top, horizontal, bottom. */
const val SETTINGS_SCROLL_NARROW_PAD_TOP_DP = 15
const val SETTINGS_SCROLL_NARROW_PAD_X_DP = 16
const val SETTINGS_SCROLL_NARROW_PAD_BOTTOM_DP = 28

/** `.setting-row { gap: 9px }` once the row stacks. */
const val SETTING_ROW_STACK_GAP_DP = 9

/**
 * Same viewport as [settingsNavCollapses].
 * At 760 and below, `.settings-heading-icon` is `display: none`, the header
 * padding-inline is 16, the scroll padding is `15px 16px 28px`, and each
 * `.setting-row` stacks (`flex-direction: column`, `align-items: flex-start`,
 * gap 9) with `.setting-control { width: 100%; max-width: none; justify-content: flex-start }`.
 * The later heading-icon color rule does not set `display`, so `display: none` still wins.
 * At 761 the side-by-side row, the wide padding, and the absent wide heading icon stay.
 */
fun settingsContentStacks(widthDp: Int): Boolean = settingsNavCollapses(widthDp)

data class SettingsContentLayout(
    val headerPadXDp: Int,
    val scrollPadTopDp: Int,
    val scrollPadXDp: Int,
    val scrollPadBottomDp: Int,
    val rowsStack: Boolean,
    val rowGapDp: Int,
    val headingIconVisible: Boolean,
)

fun settingsContentLayout(widthDp: Int): SettingsContentLayout {
    val stacks = settingsContentStacks(widthDp)
    return if (stacks) {
        SettingsContentLayout(
            headerPadXDp = SETTINGS_HEADER_NARROW_PAD_X_DP,
            scrollPadTopDp = SETTINGS_SCROLL_NARROW_PAD_TOP_DP,
            scrollPadXDp = SETTINGS_SCROLL_NARROW_PAD_X_DP,
            scrollPadBottomDp = SETTINGS_SCROLL_NARROW_PAD_BOTTOM_DP,
            rowsStack = true,
            rowGapDp = SETTING_ROW_STACK_GAP_DP,
            headingIconVisible = false,
        )
    } else {
        SettingsContentLayout(
            headerPadXDp = SETTINGS_HEADER_PAD_X_DP,
            scrollPadTopDp = SETTINGS_SCROLL_PAD_TOP_DP,
            scrollPadXDp = SETTINGS_SCROLL_PAD_X_DP,
            scrollPadBottomDp = SETTINGS_SCROLL_PAD_BOTTOM_DP,
            rowsStack = false,
            rowGapDp = SETTING_ROW_GAP_DP,
            headingIconVisible = false,
        )
    }
}

data class SettingsModalSize(
    val widthDp: Int,
    val heightDp: Int,
    val radiusDp: Int,
)

fun settingsModalSize(widthDp: Int, heightDp: Int): SettingsModalSize {
    val width = widthDp.coerceAtLeast(0)
    val height = heightDp.coerceAtLeast(0)
    if (width <= SETTINGS_MODAL_FULL_DP) return SettingsModalSize(width, height, 0)
    return SettingsModalSize(
        minOf(SETTINGS_MODAL_MAX_WIDTH_DP, settingsModalShare(width, SETTINGS_MODAL_WIDTH_PERCENT)).coerceAtMost(width),
        minOf(SETTINGS_MODAL_MAX_HEIGHT_DP, settingsModalShare(height, SETTINGS_MODAL_HEIGHT_PERCENT)).coerceAtMost(height),
        SETTINGS_MODAL_RADIUS_DP,
    )
}

private fun settingsModalShare(viewportDp: Int, percent: Int): Int =
    (viewportDp.toLong() * percent / 100.0).roundToInt()
