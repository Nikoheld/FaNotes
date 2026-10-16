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
