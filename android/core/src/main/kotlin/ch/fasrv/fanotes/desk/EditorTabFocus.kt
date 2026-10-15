package ch.fasrv.fanotes.desk

/**
 * CodeMirror `toggleTabFocusMode`, bound to Ctrl-m (and Cmd-m).
 * While it is on, Tab and Shift-Tab leave the editor instead of indenting.
 */
fun togglesEditorTabFocus(ctrl: Boolean, shift: Boolean, alt: Boolean, meta: Boolean, key: String): Boolean {
    val mod = ctrl || meta
    return mod && !shift && !alt && key == "m"
}

/** Plain Tab and Shift-Tab indent. Ctrl-Tab and tab-focus mode do not. */
fun editorIndentsOnTab(tabFocus: Boolean, ctrl: Boolean, alt: Boolean, meta: Boolean): Boolean {
    if (tabFocus || ctrl || alt || meta) return false
    return true
}

fun editorTabFocusAnnouncement(enabled: Boolean): String =
    if (enabled) "Tab verlässt den Editor" else "Tab rückt die Zeile ein"
