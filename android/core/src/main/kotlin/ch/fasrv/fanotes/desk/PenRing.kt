package ch.fasrv.fanotes.desk

/** The ring around the stylus tip. It follows hover and contact, and clears when the pen leaves. */

enum class StylusPhase { HOVER, DOWN, MOVE, UP, LEAVE, CANCEL }

data class StylusSample(
    val phase: StylusPhase,
    val x: Float,
    val y: Float,
    val stylus: Boolean = true,
)

data class PenRing(val x: Float, val y: Float)

fun nextPenRing(current: PenRing?, sample: StylusSample): PenRing? {
    if (!sample.stylus) return current
    return when (sample.phase) {
        StylusPhase.HOVER, StylusPhase.DOWN, StylusPhase.MOVE -> PenRing(sample.x, sample.y)
        StylusPhase.UP -> current
        StylusPhase.LEAVE, StylusPhase.CANCEL -> null
    }
}

fun penRing(samples: List<StylusSample>): PenRing? {
    var ring: PenRing? = null
    for (sample in samples) ring = nextPenRing(ring, sample)
    return ring
}
