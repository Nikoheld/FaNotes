package ch.fasrv.fanotes.desk

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.roundToInt

/**
 * Arrow keys in the desktop vault search.
 * Down from the field selects the first hit. Down on the last hit wraps.
 * Up from the first hit returns to the field, which is index -1.
 */
fun searchResultMove(selected: Int, count: Int, forward: Boolean): Int {
    if (count <= 0) return -1
    if (selected < 0) return if (forward) 0 else -1
    if (!forward && selected == 0) return -1
    val index = selected.coerceIn(0, count - 1)
    return if (forward) (index + 1) % count else index - 1
}

/** Vault search panel from `.search-panel` and `.empty-mini`. */
const val SEARCH_TITLE_SP = 14
const val SEARCH_EYEBROW = "IM GESAMTEN VAULT"
const val SEARCH_EMPTY_TITLE = "Finde alles wieder"
const val SEARCH_EMPTY_HINT = "Tippe mindestens zwei Zeichen. Auch noch nicht konvertierte Handschrift wird durchsucht."
const val SEARCH_RESULT_MIN_DP = 70
const val SEARCH_RESULT_RADIUS_DP = 7
const val SEARCH_RESULT_PAD_DP = 9
const val SEARCH_RESULT_GAP_DP = 6
const val SEARCH_BADGE_RADIUS_DP = 8
const val SEARCH_BADGE_PAD_X_DP = 5
const val SEARCH_BADGE_PAD_Y_DP = 2
const val SEARCH_PATH_INSET_DP = 20
const val SEARCH_EMPTY_PAD_TOP_DP = 50
const val SEARCH_FOOTER_DP = 34
const val SEARCH_RULE_ALPHA = 0.09f
const val SEARCH_CLOSE = "Suche schließen"
const val SEARCH_PLACEHOLDER = "Text, Dateinamen, Handschrift …"
const val SEARCH_CHOOSE = "Ergebnis wählen"
const val SEARCH_FOOTER_CLOSE = "Schließen"
const val SEARCH_KBD_RADIUS_DP = 5

/**
 * `.search-panel` box-shadow: `16px 0 32px rgba(0,0,0,.14)`.
 * Later rules do not replace it. x is to the right, y is 0, then blur and black alpha.
 */
const val SEARCH_SHADOW_X_DP = 16
const val SEARCH_SHADOW_Y_DP = 0
const val SEARCH_SHADOW_BLUR_DP = 32
const val SEARCH_SHADOW_ALPHA = 0.14f

data class SearchPanelShadow(
    val xDp: Int,
    val yDp: Int,
    val blurDp: Int,
    val alpha: Float,
)

/** Desktop shadow for the floating vault search panel. */
fun searchPanelShadow() = SearchPanelShadow(
    SEARCH_SHADOW_X_DP,
    SEARCH_SHADOW_Y_DP,
    SEARCH_SHADOW_BLUR_DP,
    SEARCH_SHADOW_ALPHA,
)

/**
 * Nominal reach past each panel edge. CSS blur spreads `blur` around the shifted silhouette,
 * so a positive x reaches farther right than left.
 */
data class SearchShadowReach(
    val leftDp: Int,
    val topDp: Int,
    val rightDp: Int,
    val bottomDp: Int,
)

fun searchShadowReach(shadow: SearchPanelShadow = searchPanelShadow()): SearchShadowReach {
    val blur = shadow.blurDp.coerceAtLeast(0)
    return SearchShadowReach(
        leftDp = (blur - shadow.xDp).coerceAtLeast(0),
        topDp = (blur - shadow.yDp).coerceAtLeast(0),
        rightDp = (shadow.xDp + blur).coerceAtLeast(0),
        bottomDp = (shadow.yDp + blur).coerceAtLeast(0),
    )
}

/** Black at the desktop alpha, packed ARGB. */
fun searchShadowColor(alpha: Float = SEARCH_SHADOW_ALPHA): Int {
    val channel = (alpha.coerceIn(0f, 1f) * 255f).roundToInt().coerceIn(0, 255)
    return channel shl 24
}

/**
 * Software-bitmap placement of the panel rectangle shifted by the desktop offset.
 * [padPx] is the bitmap inset of the unshifted panel origin, large enough for the blur.
 */
data class SearchShadowFrame(
    val bitmapWidthPx: Int,
    val bitmapHeightPx: Int,
    val padPx: Float,
    val shapeLeftPx: Float,
    val shapeTopPx: Float,
    val shapeRightPx: Float,
    val shapeBottomPx: Float,
    val blurPx: Float,
    val color: Int,
)

fun searchShadowFrame(widthPx: Float, heightPx: Float, density: Float): SearchShadowFrame? {
    if (widthPx < 1f || heightPx < 1f || density <= 0f) return null
    val shadow = searchPanelShadow()
    if (shadow.blurDp <= 0) return null
    val blurPx = shadow.blurDp * density
    if (blurPx <= 0.5f) return null
    val offsetX = shadow.xDp * density
    val offsetY = shadow.yDp * density
    val pad = blurPx * 2f + abs(offsetX) + abs(offsetY) + 2f
    val bitmapWidth = ceil(widthPx + pad * 2f).toInt()
    val bitmapHeight = ceil(heightPx + pad * 2f).toInt()
    if (bitmapWidth < 1 || bitmapHeight < 1) return null
    return SearchShadowFrame(
        bitmapWidthPx = bitmapWidth,
        bitmapHeightPx = bitmapHeight,
        padPx = pad,
        shapeLeftPx = pad + offsetX,
        shapeTopPx = pad + offsetY,
        shapeRightPx = pad + offsetX + widthPx,
        shapeBottomPx = pad + offsetY + heightPx,
        blurPx = blurPx,
        color = searchShadowColor(shadow.alpha),
    )
}

/** True when the blurred shape passes the panel's right edge farther than its left edge. */
fun searchShadowFavorsRight(frame: SearchShadowFrame, widthPx: Float): Boolean {
    if (widthPx <= 0f) return false
    val panelLeft = frame.padPx
    val panelRight = panelLeft + widthPx
    val rightSpill = frame.shapeRightPx + frame.blurPx - panelRight
    val leftSpill = panelLeft - (frame.shapeLeftPx - frame.blurPx)
    return frame.shapeLeftPx > panelLeft && rightSpill > leftSpill
}

/** The vault search panel is as wide as the file tree and floats over the left of the workspace. */
fun searchPanelWidthDp(raw: String?) = sidebarWidthDp(raw)
