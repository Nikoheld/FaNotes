package ch.fasrv.fanotes

import android.content.Context
import android.graphics.Typeface
import androidx.core.content.res.ResourcesCompat

/** Loads the desktop editor face. System Mono stays the platform monospace. */
fun loadEditorTypeface(context: Context, fontId: String): Typeface {
    val id = ch.fasrv.fanotes.desk.editorFontId(fontId)
    if (id == "system") return Typeface.MONOSPACE
    val res = when (id) {
        "fira" -> R.font.fira_code_regular
        "plex" -> R.font.ibm_plex_mono_regular
        else -> R.font.jetbrains_mono_regular
    }
    return ResourcesCompat.getFont(context, res) ?: Typeface.MONOSPACE
}
