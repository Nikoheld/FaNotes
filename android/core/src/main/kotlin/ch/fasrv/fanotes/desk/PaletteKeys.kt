package ch.fasrv.fanotes.desk

import java.util.Locale
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.roundToInt

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

/** The mark on a palette note: the open note, otherwise the split hint while it is selected. */
fun paletteNoteMark(active: Boolean, selected: Boolean): String = when {
    active -> "geöffnet"
    selected -> "⇧↵"
    else -> ""
}

/** Command palette after the later chrome pass: 12px corners, a 51px search row, 43px commands. */
const val PALETTE_RADIUS_DP = 12
const val PALETTE_MAX_DP = 620
const val PALETTE_MAX_HEIGHT_DP = 570
const val PALETTE_SEARCH_DP = 51
const val PALETTE_SEARCH_SP = 15
const val PALETTE_SEARCH_PAD_DP = 13
const val PALETTE_SEARCH_GAP_DP = 9
const val PALETTE_CLOSE_DP = 25
const val PALETTE_CLOSE_RADIUS_DP = 6
const val PALETTE_ROW_DP = 43
const val PALETTE_NOTE_DP = 40
const val PALETTE_ROW_RADIUS_DP = 8
const val PALETTE_ROW_PAD_X_DP = 9
const val PALETTE_ROW_PAD_Y_DP = 5
const val PALETTE_ROW_GAP_DP = 9
const val PALETTE_ICON_DP = 29
const val PALETTE_ICON_RADIUS_DP = 8
const val PALETTE_FOOTER_DP = 30
const val PALETTE_EMPTY_PAD_TOP_DP = 50
const val PALETTE_KBD_RADIUS_DP = 5
const val PALETTE_GROUP_TRACKING = 0.1f

/** The palette sits 13% down the window. */
const val PALETTE_TOP_FRACTION = 0.13f

/**
 * Notion-like chrome `.command-palette` box-shadow: `0 16px 70px rgba(0, 0, 0, .16)`.
 * Nothing later replaces it. x is 0, y is down, then blur and black alpha.
 */
const val PALETTE_SHADOW_X_DP = 0
const val PALETTE_SHADOW_Y_DP = 16
const val PALETTE_SHADOW_BLUR_DP = 70
const val PALETTE_SHADOW_ALPHA = 0.16f
const val PALETTE_SCRIM = 0x590F0F0F

fun paletteTopDp(windowHeightDp: Int) = (windowHeightDp.coerceAtLeast(0) * PALETTE_TOP_FRACTION).roundToInt()

data class PalettePanelShadow(
    val xDp: Int,
    val yDp: Int,
    val blurDp: Int,
    val alpha: Float,
)

/** Desktop shadow for the command palette. */
fun palettePanelShadow() = PalettePanelShadow(
    PALETTE_SHADOW_X_DP,
    PALETTE_SHADOW_Y_DP,
    PALETTE_SHADOW_BLUR_DP,
    PALETTE_SHADOW_ALPHA,
)

/**
 * Nominal reach past each palette edge. CSS blur spreads `blur` around the shifted silhouette,
 * so a positive y reaches farther below than above.
 */
data class PaletteShadowReach(
    val leftDp: Int,
    val topDp: Int,
    val rightDp: Int,
    val bottomDp: Int,
)

fun paletteShadowReach(shadow: PalettePanelShadow = palettePanelShadow()): PaletteShadowReach {
    val blur = shadow.blurDp.coerceAtLeast(0)
    return PaletteShadowReach(
        leftDp = (blur - shadow.xDp).coerceAtLeast(0),
        topDp = (blur - shadow.yDp).coerceAtLeast(0),
        rightDp = (shadow.xDp + blur).coerceAtLeast(0),
        bottomDp = (shadow.yDp + blur).coerceAtLeast(0),
    )
}

/** Black at the desktop alpha, packed ARGB. */
fun paletteShadowColor(alpha: Float = PALETTE_SHADOW_ALPHA): Int {
    val channel = (alpha.coerceIn(0f, 1f) * 255f).roundToInt().coerceIn(0, 255)
    return channel shl 24
}

/**
 * Software-bitmap placement of the palette rectangle shifted by the desktop offset.
 * [padPx] is the bitmap inset of the unshifted palette origin, large enough for the blur.
 */
data class PaletteShadowFrame(
    val bitmapWidthPx: Int,
    val bitmapHeightPx: Int,
    val padPx: Float,
    val shapeLeftPx: Float,
    val shapeTopPx: Float,
    val shapeRightPx: Float,
    val shapeBottomPx: Float,
    val blurPx: Float,
    val color: Int,
)

fun paletteShadowFrame(widthPx: Float, heightPx: Float, density: Float): PaletteShadowFrame? {
    if (widthPx < 1f || heightPx < 1f || density <= 0f) return null
    val shadow = palettePanelShadow()
    if (shadow.blurDp <= 0) return null
    val blurPx = shadow.blurDp * density
    if (blurPx <= 0.5f) return null
    val offsetX = shadow.xDp * density
    val offsetY = shadow.yDp * density
    val pad = blurPx * 2f + abs(offsetX) + abs(offsetY) + 2f
    val bitmapWidth = ceil(widthPx + pad * 2f).toInt()
    val bitmapHeight = ceil(heightPx + pad * 2f).toInt()
    if (bitmapWidth < 1 || bitmapHeight < 1) return null
    return PaletteShadowFrame(
        bitmapWidthPx = bitmapWidth,
        bitmapHeightPx = bitmapHeight,
        padPx = pad,
        shapeLeftPx = pad + offsetX,
        shapeTopPx = pad + offsetY,
        shapeRightPx = pad + offsetX + widthPx,
        shapeBottomPx = pad + offsetY + heightPx,
        blurPx = blurPx,
        color = paletteShadowColor(shadow.alpha),
    )
}

/** True when the blurred shape passes the palette's bottom edge farther than its top edge. */
fun paletteShadowFavorsDown(frame: PaletteShadowFrame, heightPx: Float): Boolean {
    if (heightPx <= 0f) return false
    val panelTop = frame.padPx
    val panelBottom = panelTop + heightPx
    val bottomSpill = frame.shapeBottomPx + frame.blurPx - panelBottom
    val topSpill = panelTop - (frame.shapeTopPx - frame.blurPx)
    return frame.shapeTopPx > panelTop && bottomSpill > topSpill
}

/**
 * One command in the desktop palette: group, detail, shortcut, and the extra
 * words the search box matches besides the label.
 */
data class PaletteCommand(
    val id: String,
    val label: String,
    val group: String,
    val detail: String = "",
    val shortcut: String = "",
    val keywords: String = "",
)

fun paletteCommands(
    penOpen: Boolean = false,
    bookOpen: Boolean = false,
    splitOpen: Boolean = false,
    splitRows: Boolean = false,
    focus: Boolean = false,
    dailyFolder: String = "",
): List<PaletteCommand> {
    val commands = listOf(
        PaletteCommand("new-note", "Neue Notiz", "Dateien", "Markdown-Datei im Standardordner", "Ctrl N"),
        PaletteCommand("import-pdf", "PDF importieren", "Dateien", "PDF wird selbst zur Notiz — mit Handschrift und Viewer", keywords = "pdf import notiz viewer"),
        PaletteCommand("new-folder", "Neuer Ordner", "Dateien", "Fach auf oberster Ebene anlegen"),
        PaletteCommand("subfolder", "Unterordner anlegen", "Dateien", "Im Ordner der offenen Notiz", keywords = "unterordner ordner verschachteln fach"),
        PaletteCommand("note-here", "Notiz in diesem Ordner", "Dateien", "Neue Notiz neben der offenen Datei"),
        PaletteCommand("save", "Aktuelle Notiz speichern", "Dateien", "Text, Handschrift und Arbeitsblätter sichern", "Ctrl S"),
        PaletteCommand("daily", "Heutige Tagesnotiz", "Dateien", dailyFolder.ifBlank { "Tagesnotizen" }, keywords = "tagesnotiz daily"),
        PaletteCommand("daily-previous", "Vorherige Tagesnotiz", "Dateien", dailyFolder.ifBlank { "Tagesnotizen" }, keywords = "gestern tagesnotiz daily previous"),
        PaletteCommand("daily-next", "Nächste Tagesnotiz", "Dateien", dailyFolder.ifBlank { "Tagesnotizen" }, keywords = "morgen tagesnotiz daily next"),
        PaletteCommand("export-pdf", "Notiz als PDF exportieren", "Dateien", "Text, Handschrift und Arbeitsblatt drucken oder speichern", keywords = "pdf export drucken print"),
        PaletteCommand("download-note", "Notiz herunterladen", "Dateien", "Aktuelle Notiz exportieren", keywords = "download export"),
        PaletteCommand("reveal", "Im Dateimanager zeigen", "Dateien", "Speicherort der geöffneten Notiz öffnen", keywords = "ordner explorer finder dateimanager"),
        PaletteCommand("history", "Versionsverlauf", "Dateien", "Frühere Stände dieser Notiz ansehen und wiederherstellen", keywords = "history version wiederherstellen"),
        PaletteCommand("duplicate", "Notiz duplizieren", "Dateien", "Text, Handschrift und Verlinkungen als neue Notiz", keywords = "duplizieren kopie copy duplicate klonen"),
        PaletteCommand("copy-wiki-link", "Wiki-Link kopieren", "Dateien", "[[Titel]] in die Zwischenablage", keywords = "wiki link kopieren verweis"),
        PaletteCommand("trash", "Papierkorb", "Dateien", "Gelöschte Notizen wiederherstellen oder endgültig entfernen", keywords = "löschen trash wiederherstellen undo papierkorb"),
        PaletteCommand("insert-date", "Datum einfügen", "Werkzeuge", "Setzt das Datumsformat an der Schreibmarke ein", "Ctrl ⇧ D", keywords = "datum date stempel"),
        PaletteCommand("insert-date-time", "Datum und Uhrzeit einfügen", "Werkzeuge", "Datum plus Stunde und Minute", keywords = "datum uhrzeit date time stempel"),
        PaletteCommand("toggle-task", "Aufgabe umschalten", "Schreiben", "Die Aufgabe der aktuellen Zeile umschalten", "Ctrl Enter", keywords = "aufgabe checkbox todo erledigt task"),
        PaletteCommand("search", "Im Vault suchen", "Navigation", shortcut = "Ctrl ⇧ F"),
        PaletteCommand("quick-open", "Notiz öffnen …", "Navigation", "Schnell zu einer Notiz springen", "Ctrl O", "quick open switcher wechseln springen"),
        PaletteCommand("notes", "Notizen", "Navigation"),
        PaletteCommand("tasks", "Hausaufgaben & Termine", "Navigation", "To-dos, Hausaufgaben und Termine mit Fälligkeit", keywords = "todo hausaufgaben schule termin fällig aufgabe"),
        PaletteCommand("calendar", "Kalender", "Navigation", "Tag, 3 Tage, Woche, Monat und Agenda", keywords = "kalender termin woche monat agenda"),
        PaletteCommand("overview", "Vault-Übersicht", "Navigation", "Ordner und offene Notizen überblicken"),
        PaletteCommand("books", "Fachbuch", "Navigation", "PDF-Buch des Fachs"),
        PaletteCommand("nav-back", "Zurück", "Navigation", "Zur zuvor geöffneten Notiz", "Alt ←", "zurück verlauf history"),
        PaletteCommand("nav-forward", "Vorwärts", "Navigation", "Wieder zur nächsten Notiz im Verlauf", "Alt →", "vorwärts verlauf history"),
        PaletteCommand("reopen-tab", "Geschlossenen Tab wieder öffnen", "Navigation", shortcut = "Ctrl ⇧ T", keywords = "tab wieder öffnen geschlossen"),
        PaletteCommand("pin-tab", "Tab anheften", "Navigation"),
        PaletteCommand("close-others", "Andere Tabs schließen", "Navigation"),
        PaletteCommand("close-right", "Tabs rechts schließen", "Navigation"),
        PaletteCommand("cycle-tab", "Nächster Tab", "Navigation"),
        PaletteCommand("pen", if (penOpen) "Zur Tastatur wechseln" else "Mit Stift schreiben", "Werkzeuge", "Eingabeart auf derselben Notizseite wechseln", "Ctrl D", "tablet stift erkennen"),
        PaletteCommand("note-link", "Verlinkung setzen", "Werkzeuge", "Irgendwo auf der Seite eine neue Notiz verlinken", keywords = "verlinkung link notiz symbol text"),
        PaletteCommand("book", if (bookOpen) "Buch ausblenden" else "Buch einblenden", "Werkzeuge", "PDF-Buch des Fachs neben der Notiz", keywords = "buch pdf fach"),
        PaletteCommand("worksheet", "Bild oder PDF als Arbeitsblatt", "Werkzeuge", "In die aktuelle oder eine neue Notiz importieren und ausfüllen", "Ctrl ⇧ I", "pdf bild import arbeitsblatt"),
        PaletteCommand("ai", "AI-Assistent", "Werkzeuge", "LM Studio, Ollama, OpenAI, Gemini, Anthropic oder OpenCode nutzen", "Ctrl ⇧ A", "ki ai rechtschreibung fakten"),
        PaletteCommand("text-hand", "Text → Handschrift", "Werkzeuge", "Getippten Text mit trainierten Buchstaben auf die Seite setzen", keywords = "handschrift glyphenwerk schrift text"),
        PaletteCommand("cards", "Karteikarten", "Lernen", "Lernfragen dieser Notiz wiederholen", keywords = "flashcards karten spaced"),
        PaletteCommand("study", "Lernzeit", "Ansicht", "Zeit, Tippen und Handschrift je Fach, nur lokal", keywords = "statistik lernen heatmap"),
        PaletteCommand("split", if (splitOpen) "Geteilte Ansicht schließen" else "Geteilte Ansicht öffnen", "Ansicht", "Zwei Notizen nebeneinander oder untereinander", "Ctrl \\"),
        PaletteCommand("split-orient", if (splitRows) "Nebeneinander anordnen" else "Untereinander anordnen", "Ansicht", keywords = "split zeilen spalten anordnung"),
        PaletteCommand("split-swap", "Geteilte Ansicht tauschen", "Ansicht", "Linke und rechte Notiz wechseln die Seite", "Ctrl ⇧ \\"),
        PaletteCommand("focus", if (focus) "Fokusmodus verlassen" else "Fokusmodus starten", "Ansicht", "Blendet Seitenleisten für ungestörtes Schreiben aus", "Ctrl ⇧ E"),
        PaletteCommand("sidebar", "Dateileiste umschalten", "Ansicht"),
        PaletteCommand("inspector", "Gliederung umschalten", "Ansicht"),
        PaletteCommand("settings", "Einstellungen öffnen", "FaNotes", shortcut = "Ctrl ,"),
        PaletteCommand("sync", "Jetzt synchronisieren", "FaNotes", keywords = "sync synchronisieren cloud server geräte"),
        PaletteCommand("sync-settings", "Sync einrichten", "FaNotes", "Konto erstellen oder anmelden", keywords = "sync konto anmelden cloud geräte"),
        PaletteCommand("bug-report", "Fehler melden", "FaNotes", "Kurz beschreiben; die letzten fünf Minuten werden angehängt", keywords = "bug report fehler logs support"),
        PaletteCommand("import-pdf-note", "PDF importieren", "Dateien", "PDF wird selbst zur Notiz — mit Handschrift und Viewer", keywords = "pdf import notiz viewer"),
        PaletteCommand("new-subfolder", "Unterordner anlegen", "Dateien", "Im Ordner der offenen Notiz", keywords = "unterordner ordner verschachteln fach"),
        PaletteCommand("drawing", if (penOpen) "Zur Tastatur wechseln" else "Mit Stift schreiben", "Werkzeuge", "Eingabeart auf derselben Notizseite wechseln", "Ctrl D", "tablet stift erkennen"),
        PaletteCommand("text-field", "Textfeld einfügen", "Werkzeuge", "Irgendwo auf der Seite mit der Tastatur schreiben", keywords = "textfeld text tastatur pdf schreiben"),
        PaletteCommand("subject-book", if (bookOpen) "Buch ausblenden" else "Buch einblenden", "Werkzeuge", "PDF-Buch des Fachs neben der Notiz", keywords = "buch pdf fach"),
        PaletteCommand("onenote-import", "Microsoft OneNote importieren", "Dateien", "Notizbuch, Abschnitte, Layout, Ink und Anlagen sicher übernehmen", keywords = "one onetoc2 onepkg onedrive migration"),
        PaletteCommand("ai-assistant", "AI-Assistent", "Werkzeuge", "LM Studio, Ollama, OpenAI, Gemini, Anthropic oder OpenCode nutzen", "Ctrl ⇧ A", "ki ai rechtschreibung fakten"),
        PaletteCommand("glyphenwerk", "GlyphenWerk öffnen", "Werkzeuge", "Handschrift trainieren, live testen, korrigieren und verwalten", "Ctrl ⇧ G", "training erkennung symbole test datensatz"),
        PaletteCommand("flashcards", "Karteikarten", "Lernen", "Lernfragen dieser Notiz wiederholen", keywords = "flashcards karten spaced"),
        PaletteCommand("homework", "Hausaufgaben & Termine", "Navigation", "To-dos, Hausaufgaben und Termine mit Fälligkeit", keywords = "todo hausaufgaben schule termin fällig aufgabe"),
        PaletteCommand("duplicate-note", "Notiz duplizieren", "Dateien", "Text, Handschrift und Verlinkungen als neue Notiz", keywords = "duplizieren kopie copy duplicate klonen"),
        PaletteCommand("export-latex", "Notiz als LaTeX-Code exportieren", "Dateien", "LaTeX-Code der Notiz", keywords = "latex tex export formel"),
        PaletteCommand("split-orientation", if (splitRows) "Nebeneinander anordnen" else "Untereinander anordnen", "Ansicht", keywords = "split zeilen spalten anordnung"),
        PaletteCommand("sync-now", "Jetzt synchronisieren", "FaNotes", keywords = "sync synchronisieren cloud server geräte"),
        PaletteCommand("addon-store", "Add-on-Store", "FaNotes", "Add-ons aus GitHub entdecken, installieren und verwalten", keywords = "addon add-on plugin erweiterung store extension"),
    )
    val templates = NOTE_TEMPLATES.map { template ->
        PaletteCommand(
            "template-${template.id}",
            "Vorlage: ${template.title}",
            "Vorlagen",
            "In den aktuellen Ordner einfügen",
            keywords = "vorlage template ${template.profile} ${template.title}",
        )
    }
    return commands + templates
}

/** Every typed word must appear in the label, detail, group, or keywords. */
fun paletteCommandMatches(command: PaletteCommand, query: String): Boolean {
    val terms = query.trim().lowercase(Locale.GERMAN).split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (terms.isEmpty()) return true
    val haystack = "${command.label} ${command.detail} ${command.group} ${command.keywords}".lowercase(Locale.GERMAN)
    return terms.all { term -> haystack.contains(term) }
}
