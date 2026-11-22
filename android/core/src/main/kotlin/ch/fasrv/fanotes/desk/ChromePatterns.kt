package ch.fasrv.fanotes.desk

/**
 * English for chrome sentences that embed a number or a name (user data), which the exact-text catalog
 * cannot hold. The German side is the full sentence with `{name}` for each variable part; the matched
 * parts are copied into the English template unchanged, so names and paths are never translated.
 */
private class ChromePattern(german: String, val english: String) {
    val regex: Regex = run {
        val out = StringBuilder()
        var cursor = 0
        for (match in PLACEHOLDER.findAll(german)) {
            out.append(Regex.escape(german.substring(cursor, match.range.first)))
            val name = match.groupValues[1]
            out.append("(?<").append(name).append(">").append(if (name in NUMERIC) "\\d+" else ".+?").append(")")
            cursor = match.range.last + 1
        }
        out.append(Regex.escape(german.substring(cursor)))
        Regex(out.toString(), RegexOption.DOT_MATCHES_ALL)
    }
    val names: List<String> = PLACEHOLDER.findAll(german).map { it.groupValues[1] }.toList()

    fun apply(source: String): String? {
        val match = regex.matchEntire(source) ?: return null
        var result = english
        for (name in names) result = result.replace("{$name}", match.groups[name]?.value ?: "")
        return result
    }

    companion object {
        val PLACEHOLDER = Regex("\\{([a-z]+)\\}")

        /** Placeholders named n, m and k are counts: digits only, so a pattern never swallows a user's title. */
        val NUMERIC = setOf("n", "m", "k")
    }
}

private fun p(german: String, english: String) = ChromePattern(german, english)

private val CHROME_PATTERNS: List<ChromePattern> = listOf(
    p("{n} von {m} erledigt", "{n} of {m} done"),
    p(" · noch ca. {n} von {m} Min.", " · about {n} of {m} min left"),
    p("{n} Markierungen auf {m} Seiten", "{n} marks on {m} pages"),
    p("{n} Striche im ausgewählten Bereich · vollständig lokal", "{n} strokes in the selected area · fully local"),
    p("Erkannt mit {n} % Sicherheit. Korrigiere den Ausdruck, falls nötig.", "Recognised with {n} % confidence. Correct the expression if needed."),
    p("{n} von {m} Beispielen", "{n} of {m} samples"),
    p("{n} eigene Zeichen gespeichert. Sie bleiben auf diesem Gerät und fliessen in Text zu Handschrift ein.", "{n} own characters saved. They stay on this device and feed Text to handwriting."),
    p("Farbe {c}", "Colour {c}"),
    p("Eigene Farbe {c}", "Custom colour {c}"),
    p("Noch nicht trainierte Zeichen: {c}", "Characters not trained yet: {c}"),
    p("Der Text passt nicht auf diese Seite. {n} Zeichen haben keinen Platz.", "The text does not fit on this page. {n} characters have no room."),
    p("Für den verfügbaren Platz automatisch auf {n} px angepasst.", "Adjusted automatically to {n} px for the available space."),
    p("{n} Dateien · {a} von {b}", "{n} files · {a} of {b}"),
    p("{n} Dateien mit Konflikt", "{n} files with a conflict"),
    p("Beschädigt · {s}", "Damaged · {s}"),
    p("{n} Wörter", "{n} words"),
    p("{n} Wörter · {m} Einträge · {s}", "{n} words · {m} entries · {s}"),
    p("Bild · {s}", "Image · {s}"),
    p("Binärdatei · {s}", "Binary file · {s}"),
    p("{n} Arbeitsblätter", "{n} worksheets"),
    p("Bitte gib einen Titel an (höchstens {n} Zeichen).", "Please enter a title (at most {n} characters)."),
    p("Bitte beschreibe die Anfrage (höchstens {n} Zeichen).", "Please describe the request (at most {n} characters)."),
    p("Der Server antwortete mit {n}.", "The server responded with {n}."),
    p("{n} Ordner + Eingang wird angelegt.", "{n} folders + Inbox will be created."),
    p("{n} von {m} ausgewählt", "{n} of {m} selected"),
    p("{n} Notizen aktualisiert, {m} schon aktuell, {k} übersprungen.", "{n} notes updated, {m} already up to date, {k} skipped."),
    p("{t} · Notiz", "{t} · Note"),
    p("Tagesnotiz {t} ist bereit.", "Daily note {t} is ready."),
    p("Tagesnotiz {t} geöffnet.", "Daily note {t} opened."),
    p("PDF „{t}“ ist jetzt eine Notiz.", "PDF “{t}” is now a note."),
    p("Fällig heute um {t}", "Due today at {t}"),
    p("Suchindex wird aufgebaut · {n} von {m}", "Building search index · {n} of {m}"),
    p("Suchindex unvollständig · {n} offen", "Search index incomplete · {n} pending"),
    p("Die eingebettete OneNote-Komponente {t} ist beschädigt.", "The embedded OneNote component {t} is damaged."),
    p("{t} ist fehlgeschlagen: {e}", "{t} failed: {e}"),
    p("{n} ausgewählt · Mehrfachauswahl möglich", "{n} selected · multiple selection possible"),
    p("Die {t}-Adresse ist ungültig.", "The {t} address is invalid."),
    p("{t} darf aus Datenschutzgründen nur auf localhost oder im privaten LAN liegen.", "For privacy, {t} may only be on localhost or the private LAN."),
    p("Die {t}-Adresse darf keinen zusätzlichen Pfad enthalten.", "The {t} address must not contain an extra path."),
    p("Gib eine vollständige {t}-Adresse ein.", "Enter a complete {t} address."),
    p("{a} Ordner · {b} {c}", "{a} folders · {b} {c}"),
    p("{n} Einträge", "{n} entries"),
    p("{f}: {t} öffnen", "{f}: open {t}"),
    p("{f}: erste Notiz erstellen", "{f}: create first note"),
    p("Seite {n}", "Page {n}"),
    p("Der Exponent ist für die Zwischenrechnung zu gross (höchstens {n}).", "The exponent is too large for the intermediate calculation (at most {n})."),
    p("{t} erkannt · Stift heben übernimmt die saubere Form.", "{t} recognised · lift the pen to apply the clean shape."),
    p("Zeile {n}: Datensatz ist zu gross.", "Line {n}: record is too large."),
    p("Zeile {n}: kein JSON-Objekt.", "Line {n}: not a JSON object."),
    p("Zeile {n}: Zeichen oder Stiftpunkte sind ungültig.", "Line {n}: character or pen points are invalid."),
    p("{t} eingefügt · tippe erneut für weitere.", "{t} inserted · tap again for more."),
    p("Ein Link kann höchstens {n} Notizen enthalten.", "A link can contain at most {n} notes."),
    p("„{t}“ ist für einen Link zu gross.", "“{t}” is too large for a link."),
    p("Der Pfad von „{t}“ ist zu lang.", "The path of “{t}” is too long."),
    p("Freigabe wurde nicht angenommen ({n}).", "The share was not accepted ({n})."),
    p("Freigabe konnte nicht beendet werden ({n}).", "The share could not be stopped ({n})."),
    p("Die Funktion „{t}“ ist im sicheren Mathematikmodus nicht erlaubt.", "The function “{t}” is not allowed in safe maths mode."),
    p("Die Gleichung ist für jedes {t} wahr.", "The equation is true for every {t}."),
    p("„{t}“ endgültig löschen? Das kann nicht rückgängig gemacht werden.", "Permanently delete “{t}”? This cannot be undone."),
    p("{n} Einträge endgültig löschen?", "Permanently delete {n} entries?"),
    p("{n} Dateien importiert.", "{n} files imported."),
    p("{n} neue Dateien", "{n} new files"),
    p("1 neue Datei in {t}", "1 new file in {t}"),
    p("{n} neue Dateien in {t}", "{n} new files in {t}"),
    p("{n} zu gross.", "{n} too large."),
    p("{n} Aufträge erkannt.", "{n} assignments found."),
    p("„{t}“ liegt auf dem Blatt.", "“{t}” is on the sheet."),
    p("Arbeitsblatt „{t}“ wurde in die Notiz eingefügt.", "Worksheet “{t}” was inserted into the note."),
    p("Arbeitsblatt „{t}“ wurde als neue Notiz angelegt.", "Worksheet “{t}” was created as a new note."),
    p("„{t}“ wirklich aus dieser Notiz entfernen? Die PDF-/Bilddatei wird aus dem Vault gelöscht.", "Really remove “{t}” from this note? The PDF/image file is deleted from the vault."),
    p("„{t}“ wurde aus der Notiz entfernt.", "“{t}” was removed from the note."),
    p("Nicht genug Speicher für alle Seiten: Es werden die ersten {n} von {m} Seiten gezeigt.", "Not enough memory for all pages: showing the first {n} of {m} pages."),
    p("{n} Einträge übersprungen.", "{n} entries skipped."),
    p("{n} nicht unterstützt (PDF, Bilder, Markdown).", "{n} not supported (PDF, images, Markdown)."),
    p("{n} GlyphenWerk-Zeichen übernommen.", "{n} GlyphenWerk characters imported."),
    p("{n} Zeichen als {k} eingefügt.", "{n} characters inserted as {k}."),
    p("Veröffentlichen fehlgeschlagen ({n}).", "Publishing failed ({n})."),
    p("Keine Notiz für [[{t}]].", "No note for [[{t}]]."),
    p("Der Anbieter antwortete mit HTTP {n}.", "The provider responded with HTTP {n}."),
    p("Der Anbieter antwortete mit {n}.", "The provider responded with {n}."),
    p("{t} ist aktuell", "{t} is up to date"),
    p("Neu: {t}", "New: {t}"),
    p("Kalender-Optionen für {t}", "Calendar options for {t}"),
    p("„{t}“ in der Dateileiste zeigen", "Show “{t}” in the file bar"),
    p("Keine Treffer für „{t}“.", "No results for “{t}”."),
    p("{n} im Verlauf", "{n} in history"),
    p("{n} fällig · {m} Karten in {k} Notizen", "{n} due · {m} cards in {k} notes"),
    p("{n} Karten in dieser Notiz", "{n} cards in this note"),
    p("{t} · Seite {n}", "{t} · page {n}"),
    p("Seite {n} / {m}", "Page {n} / {m}"),
    p("{t}-Schlüssel eingeben", "Enter {t} key"),
    p("{n} Überschriften · {m}/{k} Aufgaben", "{n} headings · {m}/{k} tasks"),
    p("Dasselbe Deutsch-Englisch-Zeilenmodell wie in der Desktop-App, mit Sprachmodellen ({t}).", "The same German-English line model as the desktop app, with language models ({t})."),
    p("Anpassung · {n} Optionen", "Customization · {n} options"),
    p("Ordnerfarbe {c}", "Folder colour {c}"),
    p("{n} Dateien", "{n} files"),
    p("{n} Notizen", "{n} notes"),
)

/** The English sentence for a German chrome sentence with variable parts, or null when no pattern fits. */
fun translateChromePattern(source: String): String? {
    if (source.length < 6) return null
    for (pattern in CHROME_PATTERNS) pattern.apply(source)?.let { return it }
    return null
}
