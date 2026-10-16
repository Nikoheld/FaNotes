package ch.fasrv.fanotes.input

/**
 * Pen and pad buttons FaNotes can see, ported from `fanotes/src/lib/tabletButtons.ts`.
 *
 * Android reports the side button as [ANDROID_BUTTON_STYLUS_PRIMARY] and a flipped
 * S-Pen as tool type eraser. Those become the desktop barrel and eraser controls.
 */

data class TabletButtonControl(
    val id: String,
    val group: String,
    val label: String,
    val hint: String,
)

val TABLET_BUTTON_ACTIONS = listOf("ink", "eraser", "undo", "redo", "pan", "none", "os")

val TABLET_BUTTON_CONTROLS = listOf(
    TabletButtonControl("pen-tip", "pen", "Spitze", "Kontakt · Button 0"),
    TabletButtonControl("pen-barrel", "pen", "Seitliche Taste", "Barrel · Button 2"),
    TabletButtonControl("pen-upper", "pen", "Obere Taste", "Oft Mittelklick · Button 1"),
    TabletButtonControl("pen-eraser", "pen", "Radierer-Ende", "Button 5"),
    TabletButtonControl("tablet-1", "tablet", "Tablett-Taste 1", "Zurück · Button 3"),
    TabletButtonControl("tablet-2", "tablet", "Tablett-Taste 2", "Vor · Button 4"),
)

val TABLET_BUTTON_ACTION_LABELS = mapOf(
    "ink" to "Schreiben",
    "eraser" to "Radierer",
    "undo" to "Rückgängig",
    "redo" to "Wiederholen",
    "pan" to "Schwenken",
    "none" to "Keine Aktion",
    "os" to "System / Rechtsklick",
)

/** Button map inside the Grafiktablett card, from `.tablet-button-map`. */
const val TABLET_MAP_PAD_X_DP = 15
const val TABLET_MAP_PAD_TOP_DP = 12
const val TABLET_MAP_PAD_BOTTOM_DP = 14
const val TABLET_MAP_GAP_DP = 12
const val TABLET_MAP_WASH_ALPHA = 0.04f
const val TABLET_GROUP_RADIUS_DP = 10
const val TABLET_GROUP_PAD_DP = 8
const val TABLET_GROUP_GAP_DP = 6
const val TABLET_GROUP_FILL_ALPHA = 0.78f
const val TABLET_ROW_MIN_DP = 38
const val TABLET_ACTION_WIDTH_DP = 168
const val TABLET_MAP_NOTE = "Belegt die Tasten, die FaNotes vom Stift und vom Tablett wirklich empfängt. ExpressKeys, die nur der Wacom-Treiber sieht, stellst du weiter in Wacom Center ein."

val DEFAULT_TABLET_BUTTON_ACTIONS = mapOf(
    "pen-tip" to "ink",
    "pen-barrel" to "eraser",
    "pen-upper" to "pan",
    "pen-eraser" to "eraser",
    "tablet-1" to "undo",
    "tablet-2" to "redo",
)

private val ACTION_SET = TABLET_BUTTON_ACTIONS.toSet()
private val CONTROL_IDS = TABLET_BUTTON_CONTROLS.map { it.id }.toSet()

data class PointerButtonLike(
    val pointerType: String = "",
    val button: Int = -1,
    val buttons: Int = 0,
)

fun isTabletButtonAction(value: String?) = value != null && value in ACTION_SET

fun isTabletButtonId(value: String?) = value != null && value in CONTROL_IDS

fun sanitizeTabletButtonMap(value: Map<String, String>?): Map<String, String> {
    val next = DEFAULT_TABLET_BUTTON_ACTIONS.toMutableMap()
    if (value == null) return next
    for (control in TABLET_BUTTON_CONTROLS) {
        val action = value[control.id]
        if (action != null && isTabletButtonAction(action)) next[control.id] = action
    }
    return next
}

/**
 * Which listed control a Pointer Event is. Stylus-as-mouse is accepted when
 * [asStylus] is set. Pad keys (button 3/4) count even when the type is mouse.
 */
fun tabletButtonIdentityFromPointer(event: PointerButtonLike, asStylus: Boolean = false): String? {
    val pen = event.pointerType == "pen"
    val stylus = pen || asStylus
    val button = event.button
    val mask = event.buttons
    if (button == 5 || (mask and 32) != 0) return "pen-eraser"
    if (button == 3 || (mask and 8) != 0) return "tablet-1"
    if (button == 4 || (mask and 16) != 0) return "tablet-2"
    if (button == 2 || (stylus && (mask and 2) != 0)) return if (stylus) "pen-barrel" else null
    if (button == 1 || (stylus && (mask and 4) != 0)) return if (stylus) "pen-upper" else null
    if (pen && (button == 0 || button == -1 || (mask and 1) != 0)) return "pen-tip"
    return null
}

fun tabletButtonAction(assignments: Map<String, String>?, identity: String?): String {
    if (identity.isNullOrEmpty()) return "os"
    return sanitizeTabletButtonMap(assignments)[identity] ?: "os"
}

fun tabletButtonActionFromPointer(
    assignments: Map<String, String>?,
    event: PointerButtonLike,
    asStylus: Boolean = false,
) = tabletButtonAction(assignments, tabletButtonIdentityFromPointer(event, asStylus))

fun shouldInterceptTabletButton(action: String) = action != "os"

fun parseTabletButtonMap(raw: String?): Map<String, String> {
    if (raw.isNullOrBlank()) return sanitizeTabletButtonMap(null)
    val parsed = mutableMapOf<String, String>()
    for (part in raw.split(';')) {
        val cut = part.indexOf(':')
        if (cut <= 0) continue
        parsed[part.substring(0, cut).trim()] = part.substring(cut + 1).trim()
    }
    return sanitizeTabletButtonMap(parsed)
}

fun serializeTabletButtonMap(map: Map<String, String>): String {
    val clean = sanitizeTabletButtonMap(map)
    return TABLET_BUTTON_CONTROLS.joinToString(";") { "${it.id}:${clean[it.id]}" }
}

fun nextTabletButtonAction(current: String): String {
    val index = TABLET_BUTTON_ACTIONS.indexOf(current).let { if (it < 0) 0 else it }
    return TABLET_BUTTON_ACTIONS[(index + 1) % TABLET_BUTTON_ACTIONS.size]
}

/** MotionEvent tool and button values. Kept here so host tests do not need Android. */
const val ANDROID_TOOL_FINGER = 1
const val ANDROID_TOOL_STYLUS = 2
const val ANDROID_TOOL_MOUSE = 3
const val ANDROID_TOOL_ERASER = 4
const val ANDROID_BUTTON_PRIMARY = 1
const val ANDROID_BUTTON_SECONDARY = 2
const val ANDROID_BUTTON_TERTIARY = 4
const val ANDROID_BUTTON_BACK = 8
const val ANDROID_BUTTON_FORWARD = 16
const val ANDROID_BUTTON_STYLUS_PRIMARY = 32
const val ANDROID_BUTTON_STYLUS_SECONDARY = 64

/**
 * Translate an Android sample into the Pointer Event shape the desktop uses.
 * The side button becomes barrel. A flipped eraser tool becomes the eraser end.
 */
fun pointerButtonFromAndroid(toolType: Int, buttonState: Int): PointerButtonLike {
    val pen = toolType == ANDROID_TOOL_STYLUS || toolType == ANDROID_TOOL_ERASER
    var button = -1
    var mask = 0
    if (toolType == ANDROID_TOOL_ERASER) {
        button = 5
        mask = mask or 32
    }
    val side = (buttonState and ANDROID_BUTTON_STYLUS_PRIMARY) != 0 || (buttonState and ANDROID_BUTTON_STYLUS_SECONDARY) != 0
    if (side && button != 5) {
        button = 2
        mask = mask or 2
    }
    if ((buttonState and ANDROID_BUTTON_SECONDARY) != 0 && button != 5) {
        button = 2
        mask = mask or 2
    }
    if ((buttonState and ANDROID_BUTTON_TERTIARY) != 0) {
        if (button != 5 && button != 2 && button != 3 && button != 4) button = 1
        mask = mask or 4
    }
    if ((buttonState and ANDROID_BUTTON_BACK) != 0) {
        button = 3
        mask = mask or 8
    }
    if ((buttonState and ANDROID_BUTTON_FORWARD) != 0) {
        if (button != 3 && button != 5) button = 4
        mask = mask or 16
    }
    if ((buttonState and ANDROID_BUTTON_PRIMARY) != 0) {
        if (button == -1) button = 0
        mask = mask or 1
    }
    val pointerType = when {
        pen -> "pen"
        toolType == ANDROID_TOOL_FINGER -> "touch"
        else -> "mouse"
    }
    return PointerButtonLike(pointerType, button, mask)
}

fun tabletButtonIdentityFromAndroid(toolType: Int, buttonState: Int, asStylus: Boolean = false): String? {
    val like = pointerButtonFromAndroid(toolType, buttonState)
    return tabletButtonIdentityFromPointer(like, asStylus || toolType == ANDROID_TOOL_STYLUS || toolType == ANDROID_TOOL_ERASER)
}

fun rejectsUnmappedMouseButton(identity: String?, toolType: Int, buttonState: Int): Boolean {
    if (identity != null || toolType != ANDROID_TOOL_MOUSE) return false
    val nonPrimary = buttonState and (
        ANDROID_BUTTON_SECONDARY or ANDROID_BUTTON_TERTIARY or ANDROID_BUTTON_BACK or
            ANDROID_BUTTON_FORWARD or ANDROID_BUTTON_STYLUS_PRIMARY or ANDROID_BUTTON_STYLUS_SECONDARY
        )
    return nonPrimary != 0 && (buttonState and ANDROID_BUTTON_PRIMARY) == 0
}
