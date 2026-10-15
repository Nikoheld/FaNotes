package ch.fasrv.fanotes.desk

/**
 * Window shortcuts from the desktop app. GlyphenWerk (Ctrl-Shift-G) and quit
 * are left out. Ctrl-D toggles the pen, which is the ribbon shortcut.
 */
fun deskShortcut(ctrl: Boolean, shift: Boolean, alt: Boolean, meta: Boolean, key: String): String? {
    val mod = ctrl || meta
    if (mod && !alt && key == "tab") return if (shift) "tab-prev" else "tab-next"
    if (alt && !mod && !shift && key == "left") return "back"
    if (alt && !mod && !shift && key == "right") return "forward"
    if (mod && !shift && !alt && key.length == 1 && key[0] in '1'..'9') return "tab-$key"
    if (mod && shift && !alt && key == "t") return "reopen-tab"
    if (mod && !shift && !alt && key == "o") return "quick-open"
    if (mod && !alt && key == "\\") return if (shift) "split-swap" else "split"
    if (mod && !shift && !alt && key == "w") return "close-tab"
    if (mod && !shift && !alt && key == "s") return "save"
    if (mod && !shift && !alt && key == "p") return "palette"
    if (mod && shift && !alt && key == "f") return "vault-search"
    if (mod && shift && !alt && key == "a") return "ai"
    if (mod && shift && !alt && key == "i") return "worksheet"
    if (mod && !shift && !alt && key == "n") return "new-note"
    if (mod && !shift && !alt && key == ",") return "settings"
    if (mod && shift && !alt && key == "e") return "focus"
    if (mod && !shift && !alt && key == "d") return "pen"
    return null
}
