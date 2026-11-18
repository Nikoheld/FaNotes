package ch.fasrv.fanotes.ink

/**
 * Bookkeeping for the stroke under the pen. A pressure brush paints one short
 * segment per sample, so a long stroke costs hundreds of draw calls per frame.
 * Segments whose samples can no longer change are recorded once, in chunks of
 * [LIVE_INK_CHUNK]; each frame only repaints the open tail.
 */
const val LIVE_INK_CHUNK = 32

/**
 * How many leading segments of the live stroke are final. Segment `i` (1-based,
 * see [pencilGrainSegmentRange]) reads samples up to `i + 1`, so with
 * [realPoints] samples the last two segments may still move, and predicted
 * samples never count. The answer only grows in whole [chunk]s past [frozen].
 */
fun liveFrozenSegments(realPoints: Int, frozen: Int, chunk: Int = LIVE_INK_CHUNK): Int {
    if (chunk <= 0) return frozen.coerceAtLeast(0)
    val stable = realPoints - 2
    val base = frozen.coerceAtLeast(0)
    if (stable - base < chunk) return base
    return base + ((stable - base) / chunk) * chunk
}

/**
 * Read-only view of [head] followed by [tail], without copying. The live stroke
 * plus its predicted samples is drawn every frame; concatenating would copy
 * every sample each time.
 */
class JoinedList<T>(private val head: List<T>, private val tail: List<T>) : AbstractList<T>(), RandomAccess {
    override val size: Int get() = head.size + tail.size

    override fun get(index: Int): T {
        if (index < 0 || index >= size) throw IndexOutOfBoundsException("Index $index, size $size")
        val split = head.size
        return if (index < split) head[index] else tail[index - split]
    }
}

/** [head] + [tail] as a list, copying neither when one side is empty. */
fun <T> joinedPoints(head: List<T>, tail: List<T>): List<T> = when {
    tail.isEmpty() -> head
    head.isEmpty() -> tail
    else -> JoinedList(head, tail)
}
