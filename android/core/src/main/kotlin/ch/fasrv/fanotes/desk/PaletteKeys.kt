package ch.fasrv.fanotes.desk

import java.util.Locale

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
        PaletteCommand("export-pdf", "Notiz als PDF exportieren", "Dateien", "Text, Handschrift und Arbeitsblatt drucken oder speichern", keywords = "pdf export drucken print"),
        PaletteCommand("download-note", "Notiz herunterladen", "Dateien", "Aktuelle Notiz exportieren", keywords = "download export"),
        PaletteCommand("reveal", "Im Dateimanager zeigen", "Dateien", "Speicherort der geöffneten Notiz öffnen", keywords = "ordner explorer finder dateimanager"),
        PaletteCommand("history", "Versionsverlauf", "Dateien", "Frühere Stände dieser Notiz ansehen und wiederherstellen", keywords = "history version wiederherstellen"),
        PaletteCommand("search", "Im Vault suchen", "Navigation", shortcut = "Ctrl ⇧ F"),
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
