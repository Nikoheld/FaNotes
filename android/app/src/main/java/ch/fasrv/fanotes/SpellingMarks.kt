package ch.fasrv.fanotes

import android.content.Context
import android.text.Editable
import android.text.style.SuggestionSpan
import ch.fasrv.fanotes.desk.SpellingDictionary
import ch.fasrv.fanotes.desk.checkSpelling

/** Red underline owned by the spellchecker, so the next pass can replace it. */
private class SpellingMark(context: Context, suggestions: Array<String>) : SuggestionSpan(
    context,
    suggestions,
    FLAG_MISSPELLED,
)

fun applySpellingUnderlines(
    editable: Editable,
    text: String,
    cursor: Int,
    enabled: Boolean,
    context: Context,
    accepted: Set<String>,
) {
    editable.getSpans(0, editable.length, SpellingMark::class.java).forEach { editable.removeSpan(it) }
    if (!enabled || text.isEmpty() || !SpellingDictionary.ready()) return
    val errors = checkSpelling(text, cursor, accepted).errors.take(80)
    for (error in errors) {
        if (error.from < 0 || error.to > editable.length || error.from >= error.to) continue
        val suggestions = if (cursor in error.from..error.to) {
            SpellingDictionary.suggestions(error.word, error.language).toTypedArray()
        } else {
            emptyArray()
        }
        editable.setSpan(SpellingMark(context, suggestions), error.from, error.to, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
}
