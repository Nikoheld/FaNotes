package ch.fasrv.fanotes.input

/**
 * "Keep erasing while the eraser button is held", ported from `fanotes/src/lib/penEraserHold.ts`.
 *
 * Android reports the held side button on hover samples and on the touch-down of each contact. Some
 * drivers drop the button bit on the contact itself even though it is still pressed; a latch fed by
 * hover samples bridges that, so every contact made while the eraser button stays down erases.
 * The latch ends when a hover sample no longer has the bit, or on cancel. Hover exit does not end it:
 * Android sends one right before every touch-down. The view also ignores a latch whose last hover
 * sample is old (the pen left and came back).
 * Masks use the desktop `buttons` bits: 2 barrel, 4 upper, 32 eraser end.
 */
private val HOLDABLE_PEN_BUTTONS = listOf("pen-barrel" to 2, "pen-upper" to 4, "pen-eraser" to 32)

/** Desktop bits of held pen controls that are assigned to the eraser. */
fun penEraserButtonMask(assignments: Map<String, String>?, buttons: Int): Int {
    var held = 0
    for ((id, bit) in HOLDABLE_PEN_BUTTONS) {
        if ((buttons and bit) != 0 && tabletButtonAction(assignments, id) == "eraser") held = held or bit
    }
    return held
}

/**
 * Next latch (a desktop button mask, 0 = none) after an Android stylus sample.
 * [hovering] is true for hover samples, false for contact samples; [left] for a cancel.
 * Finger and mouse samples leave the latch alone.
 */
fun nextPenEraserHold(
    hold: Int,
    toolType: Int,
    buttonState: Int,
    assignments: Map<String, String>?,
    hovering: Boolean,
    left: Boolean = false,
): Int {
    if (toolType != ANDROID_TOOL_STYLUS && toolType != ANDROID_TOOL_ERASER) return hold
    if (left) return 0
    // The flipped eraser end is its own tool type; it erases without a latch.
    if (toolType == ANDROID_TOOL_ERASER) return hold
    val mask = penEraserButtonMask(assignments, pointerButtonFromAndroid(toolType, buttonState).buttons)
    if (mask != 0) return mask
    // A hover sample without the bit means the button was let go; a contact sample may just have dropped it.
    return if (hovering) 0 else hold
}

/** The tip touched down while the latch is set: erase even though this sample lost the bit. */
fun penEraserHeld(hold: Int, identity: String?): Boolean = hold != 0 && (identity == null || identity == "pen-tip")
