package ch.fasrv.fanotes.desk

/**
 * Notes longer than this many characters are "large": per-keystroke work that needs the whole text (tags, word count,
 * outline, backlinks, page statistics, tag completion scans) runs after a typing pause instead (desktop #1418).
 */
const val LARGE_NOTE_CHARS = 100_000

/** Pause after the last keystroke before whole-note derived data is recomputed for a large note. */
const val LARGE_NOTE_SETTLE_MS = 600L

fun isLargeNote(length: Int): Boolean = length > LARGE_NOTE_CHARS
