package ch.fasrv.fanotes.desk

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.roundToInt

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

/** Confirm dialog after the later chrome pass: 12px corners, a 36px mark, 34px buttons. */
const val CONFIRM_RADIUS_DP = 12
const val CONFIRM_MAX_DP = 440
const val CONFIRM_ICON_DP = 36
const val CONFIRM_ICON_RADIUS_DP = 11
const val CONFIRM_GAP_DP = 14
const val CONFIRM_HEADER_GAP_DP = 12
const val CONFIRM_PAD_X_DP = 22
const val CONFIRM_PAD_TOP_DP = 20
const val CONFIRM_PAD_BOTTOM_DP = 18
const val CONFIRM_BODY_INSET_DP = 48
const val CONFIRM_TITLE_SP = 16
const val CONFIRM_BODY_SP = 12.5f
const val CONFIRM_BUTTON_DP = 34
const val CONFIRM_BUTTON_RADIUS_DP = 6
const val CONFIRM_BUTTON_PAD_DP = 14
const val CONFIRM_EYEBROW = "ACHTUNG"

/**
 * `.confirm-dialog` keeps `box-shadow: var(--shadow)`.
 * The later "One dialog, button and type system" rule only sets `border-radius: 12px`.
 * Factory theme is light, so `.app-shell.theme-light` wins `--shadow` over `:root`:
 * `0 12px 40px rgba(15, 15, 15, .08)`. x is 0, y is down, then blur and alpha.
 */
const val CONFIRM_SHADOW_X_DP = 0
const val CONFIRM_SHADOW_Y_DP = 12
const val CONFIRM_SHADOW_BLUR_DP = 40
const val CONFIRM_SHADOW_ALPHA = 0.08f

data class ConfirmDialogShadow(
    val xDp: Int,
    val yDp: Int,
    val blurDp: Int,
    val alpha: Float,
)

/** Desktop shadow for the confirm dialog on the factory light shell. */
fun confirmDialogShadow() = ConfirmDialogShadow(
    CONFIRM_SHADOW_X_DP,
    CONFIRM_SHADOW_Y_DP,
    CONFIRM_SHADOW_BLUR_DP,
    CONFIRM_SHADOW_ALPHA,
)

/**
 * Nominal reach past each dialog edge. CSS blur spreads `blur` around the shifted silhouette,
 * so a positive y reaches farther below than above.
 */
data class ConfirmShadowReach(
    val leftDp: Int,
    val topDp: Int,
    val rightDp: Int,
    val bottomDp: Int,
)

fun confirmShadowReach(shadow: ConfirmDialogShadow = confirmDialogShadow()): ConfirmShadowReach {
    val blur = shadow.blurDp.coerceAtLeast(0)
    return ConfirmShadowReach(
        leftDp = (blur - shadow.xDp).coerceAtLeast(0),
        topDp = (blur - shadow.yDp).coerceAtLeast(0),
        rightDp = (shadow.xDp + blur).coerceAtLeast(0),
        bottomDp = (shadow.yDp + blur).coerceAtLeast(0),
    )
}

/** `rgba(15, 15, 15, alpha)` packed ARGB. */
fun confirmShadowColor(alpha: Float = CONFIRM_SHADOW_ALPHA): Int {
    val channel = (alpha.coerceIn(0f, 1f) * 255f).roundToInt().coerceIn(0, 255)
    return (channel shl 24) or (15 shl 16) or (15 shl 8) or 15
}

/**
 * Software-bitmap placement of the dialog rectangle shifted by the desktop offset.
 * [padPx] is the bitmap inset of the unshifted dialog origin, large enough for the blur.
 */
data class ConfirmShadowFrame(
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

fun confirmShadowFrame(widthPx: Float, heightPx: Float, density: Float): ConfirmShadowFrame? {
    if (widthPx < 1f || heightPx < 1f || density <= 0f) return null
    val shadow = confirmDialogShadow()
    if (shadow.blurDp <= 0) return null
    val blurPx = shadow.blurDp * density
    if (blurPx <= 0.5f) return null
    val offsetX = shadow.xDp * density
    val offsetY = shadow.yDp * density
    val pad = blurPx * 2f + abs(offsetX) + abs(offsetY) + 2f
    val bitmapWidth = ceil(widthPx + pad * 2f).toInt()
    val bitmapHeight = ceil(heightPx + pad * 2f).toInt()
    if (bitmapWidth < 1 || bitmapHeight < 1) return null
    return ConfirmShadowFrame(
        bitmapWidthPx = bitmapWidth,
        bitmapHeightPx = bitmapHeight,
        padPx = pad,
        shapeLeftPx = pad + offsetX,
        shapeTopPx = pad + offsetY,
        shapeRightPx = pad + offsetX + widthPx,
        shapeBottomPx = pad + offsetY + heightPx,
        blurPx = blurPx,
        color = confirmShadowColor(shadow.alpha),
    )
}

/** True when the blurred shape passes the dialog's bottom edge farther than its top edge. */
fun confirmShadowFavorsDown(frame: ConfirmShadowFrame, heightPx: Float): Boolean {
    if (heightPx <= 0f) return false
    val panelTop = frame.padPx
    val panelBottom = panelTop + heightPx
    val bottomSpill = frame.shapeBottomPx + frame.blurPx - panelBottom
    val topSpill = panelTop - (frame.shapeTopPx - frame.blurPx)
    return frame.shapeTopPx > panelTop && bottomSpill > topSpill
}

data class PendingConfirm(
    val title: String,
    val message: String,
    val confirmLabel: String,
    val cancelLabel: String = "Abbrechen",
)
