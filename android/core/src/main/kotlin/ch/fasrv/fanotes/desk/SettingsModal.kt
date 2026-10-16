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
 * `.settings-heading-icon { width: 38px; height: 38px; border-radius: 11px }`.
 * The mark is the section icon, `ActiveSectionIcon size={17}`.
 * `.settings-heading { gap: 11px }`.
 * The later chrome rule replaces the accent fill and does not change this size:
 * `color: var(--bg); background: var(--text); border-color: transparent; box-shadow: none`.
 */
const val SETTINGS_HEADING_ICON_DP = 38
const val SETTINGS_HEADING_ICON_RADIUS_DP = 11
const val SETTINGS_HEADING_ICON_GLYPH_DP = 17
const val SETTINGS_HEADING_GAP_DP = 11

/**
 * Same viewport as [settingsNavCollapses].
 * At 760 and below, `.settings-heading-icon` is `display: none`, the header
 * padding-inline is 16, the scroll padding is `15px 16px 28px`, and each
 * `.setting-row` stacks (`flex-direction: column`, `align-items: flex-start`,
 * gap 9) with `.setting-control { width: 100%; max-width: none; justify-content: flex-start }`.
 * The later heading-icon color rule does not set `display`, so `display: none` still wins.
 * At 761 the side-by-side row and the wide padding stay, and the heading icon is shown.
 */
fun settingsContentStacks(widthDp: Int): Boolean = settingsNavCollapses(widthDp)

/**
 * `.range-setting` above 760px:
 * `width: 220px; display: grid; grid-template-columns: minmax(90px, 1fr) 57px; align-items: center; gap: 10px`.
 * The value is
 * `.range-setting output { height: 27px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 6px; color: var(--text-soft); font-family: var(--editor-font); font-size: 12px }`.
 * `:root` sets `--editor-font: 'JetBrains Mono', ui-monospace, monospace`.
 * `button, input, select, textarea { font: inherit }` does not cover `output`.
 * No later rule changes this face, color, or these sizes. The 760px block only sets `width: 100%`.
 */
const val RANGE_SETTING_WIDTH_DP = 220
const val RANGE_SETTING_TRACK_MIN_DP = 90
const val RANGE_SETTING_VALUE_WIDTH_DP = 57
const val RANGE_SETTING_VALUE_HEIGHT_DP = 27
const val RANGE_SETTING_VALUE_RADIUS_DP = 6
const val RANGE_SETTING_VALUE_BORDER_DP = 1
const val RANGE_SETTING_VALUE_SP = 12
const val RANGE_SETTING_GAP_DP = 10

/** `.range-setting output` uses `font-family: var(--editor-font)`, not `--ui-font`. */
const val RANGE_SETTING_VALUE_USES_EDITOR_FONT = true

/** Face role for the value box. `"editor"` is `--editor-font`. `"ui"` would be the interface face. */
const val RANGE_SETTING_VALUE_FONT = "editor"

/** `color: var(--text-soft)`. The palette `soft` field, not `muted`. */
const val RANGE_SETTING_VALUE_INK = "soft"

/**
 * Editor-face id for the value box. A UI stack is not an editor face, so it
 * stays the default JetBrains Mono stack from `:root`.
 */
fun rangeSettingValueFontId(editorFace: String?): String =
    if (RANGE_SETTING_VALUE_USES_EDITOR_FONT && RANGE_SETTING_VALUE_FONT == "editor") {
        editorFontId(editorFace)
    } else {
        uiFontId(editorFace)
    }

/** Named soft-color role. `"muted"` is the quieter ink and is not this box. */
fun rangeSettingValueInkRole(): String = RANGE_SETTING_VALUE_INK

/**
 * `.range-setting { width: 100%; }` inside `@media (max-width: 760px)`.
 * That block is the last `.range-setting` rule. It widens the row and leaves
 * the two columns in place, so the value box stays beside the track.
 * Above 760 the row is [RANGE_SETTING_WIDTH_DP].
 */
fun settingsRangeFillsWidth(widthDp: Int): Boolean = widthDp <= SETTINGS_MODAL_FULL_DP

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
            headingIconVisible = true,
        )
    }
}

/**
 * `.setting-callout { align-items: center }` above 760.
 * `flex-wrap` is unset, so it stays `nowrap`.
 * Direct actions are `flex: none` with `gap: 7px` and no leading inset.
 */
const val SETTING_CALLOUT_ALIGN_WIDE = "center"
const val SETTING_CALLOUT_ACTIONS_GAP_DP = 7

/**
 * Last callout rules, inside `@media (max-width: 760px)`. Nothing after that block
 * sets callout alignment, wrap, or action padding:
 * `.setting-callout { align-items: flex-start; flex-wrap: wrap; }`
 * `.setting-callout > .setting-callout-actions { width: 100%; padding-left: 46px; }`
 * The copy stays `flex: 1; min-width: 0`, so wrap drops only a full-width actions row.
 */
const val SETTING_CALLOUT_ALIGN_NARROW = "flex-start"
const val SETTING_CALLOUT_ACTIONS_PAD_START_DP = 46

data class SettingCalloutLayout(
    val alignItems: String,
    val wraps: Boolean,
    val actionsFillWidth: Boolean,
    val actionsPadStartDp: Int,
    val actionsGapDp: Int,
)

/** Narrow values apply only while [settingsContentStacks] is true. */
fun settingCalloutLayout(widthDp: Int): SettingCalloutLayout {
    val stacks = settingsContentStacks(widthDp)
    return if (stacks) {
        SettingCalloutLayout(
            alignItems = SETTING_CALLOUT_ALIGN_NARROW,
            wraps = true,
            actionsFillWidth = true,
            actionsPadStartDp = SETTING_CALLOUT_ACTIONS_PAD_START_DP,
            actionsGapDp = SETTING_CALLOUT_ACTIONS_GAP_DP,
        )
    } else {
        SettingCalloutLayout(
            alignItems = SETTING_CALLOUT_ALIGN_WIDE,
            wraps = false,
            actionsFillWidth = false,
            actionsPadStartDp = 0,
            actionsGapDp = SETTING_CALLOUT_ACTIONS_GAP_DP,
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
