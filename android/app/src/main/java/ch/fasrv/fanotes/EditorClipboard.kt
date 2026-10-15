package ch.fasrv.fanotes

import android.content.ClipboardManager
import android.content.Context

internal fun clipboardPlainText(context: Context): String? = runCatching {
    val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return@runCatching null
    val clip = manager.primaryClip ?: return@runCatching null
    if (clip.itemCount == 0) null else clip.getItemAt(0).coerceToText(context)?.toString()
}.getOrNull()
