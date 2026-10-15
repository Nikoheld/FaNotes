package ch.fasrv.fanotes.desk

/**
 * What Escape closes, in the desktop window order.
 * A dialog that sits on top of the note closes before a link, a palette,
 * or a full-screen destination. GlyphenWerk is not a surface here.
 * The pen closes back to the keyboard, and focus mode is last.
 */
data class EscapeLayer(
    val confirm: Boolean = false,
    val bugReport: Boolean = false,
    val gotoLine: Boolean = false,
    val math: Boolean = false,
    val textBox: Boolean = false,
    val firstRun: Boolean = false,
    val sync: Boolean = false,
    val createNote: Boolean = false,
    val createFolder: Boolean = false,
    val renaming: Boolean = false,
    val moving: Boolean = false,
    val placingLink: Boolean = false,
    val placingSection: Boolean = false,
    val selectedLink: Boolean = false,
    val worksheetImport: Boolean = false,
    val palette: Boolean = false,
    val destination: String = "notes",
    val selection: Boolean = false,
    val sheet: Boolean = false,
    val pen: Boolean = false,
    val focus: Boolean = false,
)

fun escapeDismisses(layer: EscapeLayer): String? {
    if (layer.confirm) return "confirm"
    if (layer.bugReport) return "bug-report"
    if (layer.gotoLine) return "goto-line"
    if (layer.math) return "math"
    if (layer.textBox) return "text-box"
    if (layer.firstRun) return "first-run"
    if (layer.sync) return "sync"
    if (layer.createNote) return "create-note"
    if (layer.createFolder) return "create-folder"
    if (layer.renaming) return "rename"
    if (layer.moving) return "move"
    if (layer.placingLink) return "placing-link"
    if (layer.placingSection) return "placing-section"
    if (layer.selectedLink) return "selected-link"
    if (layer.worksheetImport) return "worksheet"
    if (layer.palette) return "palette"
    when (layer.destination) {
        "search" -> return "search"
        "settings" -> return "settings"
        "ai" -> return "ai"
        "calendar" -> return "calendar"
        "tasks" -> return "tasks"
        "overview" -> return "overview"
    }
    if (layer.selection) return "selection"
    if (layer.sheet) return "sheet"
    if (layer.pen) return "pen"
    if (layer.focus) return "focus"
    return null
}
