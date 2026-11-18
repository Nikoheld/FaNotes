package ch.fasrv.fanotes.desk

/**
 * Undo and redo for the text marks of a PDF note (a highlight the eraser or "Markierung entfernen" took off comes
 * back with "Rückgängig", like on the desktop). The marks live in the note's Markdown, the ink in [ch.fasrv.fanotes.ink.InkSession];
 * the two histories interleave by the ink history's newest entry ([ch.fasrv.fanotes.ink.InkSession.undoStamp]): a
 * mark change recorded while that entry was X is undone before X itself.
 *
 * An entry stores what the change removed and added, and undo applies the inverse to the current list, so marks
 * changed some other way in between (sync, the selection toolbar) are kept. Changes of one eraser gesture are
 * merged into one entry ([record] with `merge`).
 */
class PdfMarkHistory(private val limit: Int = 100, private val mergeMs: Long = 1_500) {
    private class Entry(
        var removed: List<PdfTextMark>,
        var added: List<PdfTextMark>,
        val inkStamp: Long,
        var at: Long,
        var inkChanges: Long = 0,
    )

    private val undo = ArrayDeque<Entry>()
    private val redo = ArrayDeque<Entry>()

    /** What the history belongs to (note path and ink history generation); another key starts it empty. */
    var key: String? = null
        private set

    fun reset(key: String?) {
        this.key = key
        undo.clear()
        redo.clear()
    }

    /**
     * Records a change from [before] to [after]. With [merge], a change within `mergeMs` of the previous one at the
     * same ink stamp joins it.
     */
    fun record(before: List<PdfTextMark>, after: List<PdfTextMark>, inkStamp: Long, now: Long, merge: Boolean = false) {
        if (before == after) return
        val removed = before.filter { it !in after }
        val added = after.filter { it !in before }
        if (removed.isEmpty() && added.isEmpty()) return
        redo.clear()
        val last = undo.lastOrNull()
        if (merge && last != null && last.inkStamp == inkStamp && now - last.at in 0..mergeMs) {
            last.removed = last.removed + removed.filter { it !in last.added }
            last.added = last.added.filter { it !in removed } + added
            last.at = now
            return
        }
        undo.addLast(Entry(removed, added, inkStamp, now))
        if (undo.size > limit) undo.removeFirst()
    }

    /** The newest mark change comes before the ink's newest entry. */
    fun canUndo(inkStamp: Long): Boolean = undo.lastOrNull()?.inkStamp == inkStamp

    /** Redo the mark change next, before the ink's; false once the ink changed since the undo. */
    fun canRedo(inkStamp: Long, inkChanges: Long): Boolean =
        redo.lastOrNull()?.let { it.inkStamp == inkStamp && it.inkChanges == inkChanges } == true

    /** The marks after undoing the newest change, or null when there is none. */
    fun undo(current: List<PdfTextMark>, inkChanges: Long): List<PdfTextMark>? {
        val entry = undo.removeLastOrNull() ?: return null
        entry.inkChanges = inkChanges
        redo.addLast(entry)
        return current.filter { it !in entry.added } + entry.removed.filter { it !in current }
    }

    /** The marks after redoing the newest undone change, or null when there is none. */
    fun redo(current: List<PdfTextMark>): List<PdfTextMark>? {
        val entry = redo.removeLastOrNull() ?: return null
        undo.addLast(entry)
        return current.filter { it !in entry.removed } + entry.added.filter { it !in current }
    }
}
