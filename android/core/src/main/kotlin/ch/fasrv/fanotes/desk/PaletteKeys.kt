package ch.fasrv.fanotes.desk

/**
 * Arrow keys in the desktop command palette.
 * Up and down move one row. Page Up and Page Down move eight.
 * The index stays inside the list.
 */
fun paletteMove(selected: Int, count: Int, delta: Int): Int {
    if (count <= 0) return 0
    return (selected + delta).coerceIn(0, count - 1)
}

/** Enter on a note opens it. Shift-Enter opens it in the split column. A command just runs. */
fun paletteOpensInSplit(kind: String, shift: Boolean): Boolean = kind == "note" && shift
