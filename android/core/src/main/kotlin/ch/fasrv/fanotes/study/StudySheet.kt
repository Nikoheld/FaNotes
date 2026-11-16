package ch.fasrv.fanotes.study

/**
 * Size rules of the Aufträge and Markierungen bottom sheet. The sheet leaves most of the window to the page it
 * jumps to; on small windows it also folds up after a jump so the page shows in full.
 */

/** Share of the window height the sheet may take. */
const val STUDY_SHEET_FRACTION = 0.4

/** The sheet always gets this much room (or the whole window when that is smaller), so its fields stay usable. */
const val STUDY_SHEET_MIN_DP = 240

/** The old fixed height of the panel; the sheet never grows past it. */
const val STUDY_SHEET_MAX_DP = 460

/** A window narrower than a small tablet, or shorter than a phone in landscape with the keyboard closed. */
const val STUDY_SHEET_COMPACT_WIDTH_DP = 600
const val STUDY_SHEET_COMPACT_HEIGHT_DP = 480

/** The widest the sheet gets; on wide windows it sits centred at the bottom. */
const val STUDY_SHEET_WIDTH_DP = 720

/** Tallest the open sheet may be in a window of [windowHeightDp]. */
fun studySheetMaxHeightDp(windowHeightDp: Int): Int {
    if (windowHeightDp <= 0) return STUDY_SHEET_MIN_DP
    val byShare = (windowHeightDp * STUDY_SHEET_FRACTION).toInt()
    return byShare.coerceAtLeast(minOf(windowHeightDp, STUDY_SHEET_MIN_DP)).coerceAtMost(STUDY_SHEET_MAX_DP)
}

/** Small windows (phone, landscape, split screen): the sheet folds after a jump. */
fun studySheetCompact(windowWidthDp: Int, windowHeightDp: Int): Boolean =
    windowWidthDp < STUDY_SHEET_COMPACT_WIDTH_DP || windowHeightDp < STUDY_SHEET_COMPACT_HEIGHT_DP
