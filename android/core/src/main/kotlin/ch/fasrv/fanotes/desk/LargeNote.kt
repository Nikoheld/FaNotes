package ch.fasrv.fanotes.desk

/**
 * Notes longer than this many characters are "large": per-keystroke work that needs the whole text (tags, word count,
 * outline, backlinks, page statistics, tag completion scans) runs after a typing pause instead (desktop #1418).
 */
const val LARGE_NOTE_CHARS = 100_000

/** Pause after the last keystroke before whole-note derived data is recomputed for a large note. */
const val LARGE_NOTE_SETTLE_MS = 600L

fun isLargeNote(length: Int): Boolean = length > LARGE_NOTE_CHARS

private const val COMPARE_BLOCK = 256

/** Length of the common prefix of [a] and [b], at most [limit]; whole blocks are compared natively first. */
internal fun commonPrefixLength(a: String, b: String, limit: Int = minOf(a.length, b.length)): Int {
    var index = 0
    while (index + COMPARE_BLOCK <= limit && a.regionMatches(index, b, index, COMPARE_BLOCK)) index += COMPARE_BLOCK
    while (index < limit && a[index] == b[index]) index += 1
    return index
}

/** Length of the common suffix of [a] and [b], at most [limit]. */
internal fun commonSuffixLength(a: String, b: String, limit: Int = minOf(a.length, b.length)): Int {
    var count = 0
    while (count + COMPARE_BLOCK <= limit &&
        a.regionMatches(a.length - count - COMPARE_BLOCK, b, b.length - count - COMPARE_BLOCK, COMPARE_BLOCK)
    ) count += COMPARE_BLOCK
    while (count < limit && a[a.length - 1 - count] == b[b.length - 1 - count]) count += 1
    return count
}
