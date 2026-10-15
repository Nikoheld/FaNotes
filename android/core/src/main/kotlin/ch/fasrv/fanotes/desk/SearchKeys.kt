package ch.fasrv.fanotes.desk

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
