package ch.fasrv.fanotes.desk

/** Which pointer owns a slider. A stylus that is down wins over a finger already down. */

enum class PointerKind { FINGER, STYLUS }

data class SliderPointer(
    val id: Int,
    val kind: PointerKind,
    val down: Boolean,
    val fraction: Float,
)

fun sliderValueFromPointers(min: Float, max: Float, pointers: List<SliderPointer>): Float? {
    val stylus = pointers.lastOrNull { it.kind == PointerKind.STYLUS && it.down }
    val owner = stylus ?: pointers.lastOrNull { it.down } ?: return null
    val span = max - min
    return min + owner.fraction.coerceIn(0f, 1f) * span
}
