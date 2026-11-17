package ch.fasrv.fanotes

import androidx.compose.runtime.saveable.Saver

/**
 * Holds the "Lernen" tools' transient state across a recreated activity (rotation, font scale, dark mode, process
 * death). The live view is asked for its state when the activity saves its instance state, so the value is always
 * current without the view reporting every change. [raw] is what a restored box starts from, and what is written
 * back if the view was never created before the save.
 */
class StudyStateBox {
    var raw: String = ""
    var provider: (() -> String)? = null

    fun current(): String = provider?.invoke() ?: raw

    companion object {
        val Saver: Saver<StudyStateBox, String> = Saver(
            save = { box -> box.current().ifEmpty { null } },
            restore = { text -> StudyStateBox().apply { raw = text } },
        )
    }
}
