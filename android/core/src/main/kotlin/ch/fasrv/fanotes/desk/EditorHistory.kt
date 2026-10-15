package ch.fasrv.fanotes.desk

/**
 * CodeMirror's note history for one editor buffer.
 * Typed characters and backspaces within 500 ms share one undo step.
 * A run of caret moves in that same window is one selection step.
 * Ctrl-Z undoes text. Ctrl-U steps back through selections.
 */
class EditorHistory(
    private val groupDelayMs: Long = 500,
    private val maxEvents: Int = 100,
) {
    private data class Event(
        val from: Int,
        val deleted: String,
        val inserted: String,
        val cursorBefore: Int,
        val cursorAfter: Int,
    )

    private data class Sel(val anchor: Int, val head: Int)

    private val done = ArrayDeque<Event>()
    private val undone = ArrayDeque<Event>()
    private val selectionDone = ArrayDeque<Sel>()
    private val selectionUndone = ArrayDeque<Sel>()
    private var currentSelection: Sel? = null
    private var previousAt = 0L
    private var selectionAt = Long.MIN_VALUE
    private var groupOpen = false

    fun record(before: String, after: String, cursorBefore: Int, cursorAfter: Int, now: Long) {
        if (before == after) return
        val change = minimalReplacement(before, after)
        val end = change.to.coerceIn(change.from, before.length)
        val deleted = before.substring(change.from, end)
        val inserted = change.insert
        if (deleted.isEmpty() && inserted.isEmpty()) return
        val event = Event(
            change.from,
            deleted,
            inserted,
            cursorBefore.coerceIn(0, before.length),
            cursorAfter.coerceIn(0, after.length),
        )
        val last = done.lastOrNull()
        if (groupOpen && last != null && now - previousAt in 0..groupDelayMs && joinable(last, event)) {
            done.removeLast()
            done.addLast(join(last, event))
        } else {
            done.addLast(event)
            while (done.size > maxEvents) done.removeFirst()
        }
        undone.clear()
        selectionUndone.clear()
        previousAt = now
        groupOpen = true
        val origin = Sel(cursorBefore.coerceIn(0, before.length), cursorBefore.coerceIn(0, before.length))
        val afterCaret = Sel(cursorAfter.coerceIn(0, after.length), cursorAfter.coerceIn(0, after.length))
        if (origin != afterCaret && selectionDone.lastOrNull() != origin) {
            selectionDone.addLast(origin)
            while (selectionDone.size > maxEvents) selectionDone.removeFirst()
            selectionAt = now
        }
        currentSelection = afterCaret
    }

    /**
     * A caret or range move. Moves of the same shape inside the group window
     * stay one step, so Ctrl-U returns to where the run started.
     */
    fun noteSelection(anchor: Int, head: Int, length: Int, now: Long) {
        rememberSelection(anchor, head, length, now, force = false)
    }

    fun undoSelection(anchor: Int, head: Int, length: Int): Pair<Int, Int>? =
        stepSelection(selectionDone, selectionUndone, anchor, head, length)

    fun redoSelection(anchor: Int, head: Int, length: Int): Pair<Int, Int>? =
        stepSelection(selectionUndone, selectionDone, anchor, head, length)

    fun undo(text: String): MarkdownEdit? = pop(done, undone, text, forward = false)

    fun redo(text: String): MarkdownEdit? = pop(undone, done, text, forward = true)

    fun reset() {
        done.clear()
        undone.clear()
        selectionDone.clear()
        selectionUndone.clear()
        currentSelection = null
        selectionAt = -1L
        groupOpen = false
    }

    private fun rememberSelection(anchor: Int, head: Int, length: Int, now: Long, force: Boolean) {
        val next = Sel(anchor.coerceIn(0, length.coerceAtLeast(0)), head.coerceIn(0, length.coerceAtLeast(0)))
        val previous = currentSelection
        if (previous == next) return
        currentSelection = next
        if (previous == null) return
        val sameShape = (previous.anchor == previous.head) == (next.anchor == next.head)
        if (!force && sameShape && selectionAt >= 0 && now - selectionAt in 0..groupDelayMs) return
        selectionDone.addLast(previous)
        while (selectionDone.size > maxEvents) selectionDone.removeFirst()
        selectionUndone.clear()
        selectionAt = now
    }

    private fun stepSelection(
        fromStack: ArrayDeque<Sel>,
        toStack: ArrayDeque<Sel>,
        anchor: Int,
        head: Int,
        length: Int,
    ): Pair<Int, Int>? {
        val target = fromStack.removeLastOrNull() ?: return null
        val safeLength = length.coerceAtLeast(0)
        toStack.addLast(Sel(anchor.coerceIn(0, safeLength), head.coerceIn(0, safeLength)))
        val restored = Sel(target.anchor.coerceIn(0, safeLength), target.head.coerceIn(0, safeLength))
        currentSelection = restored
        selectionAt = -1L
        return restored.anchor to restored.head
    }

    private fun pop(fromStack: ArrayDeque<Event>, toStack: ArrayDeque<Event>, text: String, forward: Boolean): MarkdownEdit? {
        val event = fromStack.lastOrNull() ?: return null
        val removed = if (forward) event.deleted else event.inserted
        val added = if (forward) event.inserted else event.deleted
        val end = event.from + removed.length
        if (event.from < 0 || end > text.length || text.substring(event.from, end) != removed) return null
        fromStack.removeLast()
        toStack.addLast(event)
        groupOpen = false
        val next = text.substring(0, event.from) + added + text.substring(end)
        val cursor = (if (forward) event.cursorAfter else event.cursorBefore).coerceIn(0, next.length)
        return MarkdownEdit(next, cursor, cursor)
    }

    private fun joinable(last: Event, next: Event): Boolean {
        val lastTyped = last.deleted.isEmpty() && last.inserted.isNotEmpty()
        val nextTyped = next.deleted.isEmpty() && next.inserted.isNotEmpty()
        if (lastTyped && nextTyped) return next.from == last.from + last.inserted.length
        val lastErased = last.inserted.isEmpty() && last.deleted.isNotEmpty()
        val nextErased = next.inserted.isEmpty() && next.deleted.isNotEmpty()
        if (!lastErased || !nextErased) return false
        if (next.from + next.deleted.length == last.from) return true
        return next.from == last.from
    }

    private fun join(last: Event, next: Event): Event {
        if (last.deleted.isEmpty()) {
            return last.copy(inserted = last.inserted + next.inserted, cursorAfter = next.cursorAfter)
        }
        return if (next.from + next.deleted.length == last.from) {
            last.copy(from = next.from, deleted = next.deleted + last.deleted, cursorAfter = next.cursorAfter)
        } else {
            last.copy(deleted = last.deleted + next.deleted, cursorAfter = next.cursorAfter)
        }
    }
}

/** Ctrl-U steps back through selections. Alt-U and Ctrl-Shift-U step forward. */
fun editorSelectionCommand(ctrl: Boolean, shift: Boolean, alt: Boolean, meta: Boolean, key: String): String? {
    if (key != "u") return null
    val mod = ctrl || meta
    if (mod && !shift && !alt) return "undo-selection"
    if (alt && !mod && !shift) return "redo-selection"
    if (mod && shift && !alt) return "redo-selection"
    return null
}

/** `undo` for Ctrl-Z, `redo` for Ctrl-Y and Ctrl-Shift-Z. */
fun editorHistoryCommand(ctrl: Boolean, shift: Boolean, alt: Boolean, meta: Boolean, key: String): String? {
    val mod = ctrl || meta
    if (!mod || alt) return null
    if (key == "z" && !shift) return "undo"
    if (key == "y" && !shift) return "redo"
    if (key == "z" && shift) return "redo"
    return null
}
