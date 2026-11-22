package ch.fasrv.fanotes.desk

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Guards the English UI: a German literal that reaches the screen without `ui(...)` shows German with the
 * app set to English, and a `ui("...")` source missing from `en.json` falls back to German too.
 */
class ChromeLiteralsTest {
    private val catalog: Map<String, String> = loadEnglishCatalogResource()

    private val sources: List<File> by lazy {
        val roots = listOf(File("../app/src/main/java"), File("android/app/src/main/java"))
        val root = roots.firstOrNull { it.isDirectory } ?: return@lazy emptyList()
        root.walkTopDown().filter { it.isFile && it.extension == "kt" }.sortedBy { it.path }.toList()
    }

    private val germanHint = Regex(
        "[äöüÄÖÜß]|\\b(und|oder|der|die|das|nicht|kein|keine|noch|neue|alle|für|mit|zum|zur|wird|ist|sind|auf|von|aus|bei|" +
            "Fehler|Datei|Notiz|Ordner|Einstellungen|Speichern|Suche|Seite|Zeile|Aufgaben|Kalender|Karten|Weiter|Zurück|" +
            "Fertig|Konto|Farbe|Bild|Tabelle|Öffnen|Löschen|Abbrechen|Schliessen)\\b",
    )

    /** A string literal that is the direct argument of a text sink, i.e. shown as is. */
    private val sink = Regex(
        "(?:contentDescription\\s*=\\s*|onClickLabel\\s*=\\s*|" +
            "(?:setTitle|setMessage|setText|setHint|setContentDescription)\\(\\s*|Toast\\.makeText\\([^\"\\n]*)\"((?:[^\"\\\\\\n]|\\\\.)*)\"",
    )
    /** `ui("...")`, and a literal `Text("...")` in a file that uses the package's translating `Text`. */
    private val uiCall = Regex("\\bui\\(\\s*\"((?:[^\"\\\\\\n]|\\\\.)*)\"\\s*\\)")
    /** Settings rows: the title (first) and the explanation (second) literal go through the translating `Text`. */
    private val rowCall = Regex("\\b(?:SettingRow|ToggleRow)\\(\\s*\"((?:[^\"\\\\\\n]|\\\\.)*)\"(?:,\\s*\"((?:[^\"\\\\\\n]|\\\\.)*)\")?")
    private val textCall = Regex("(?<![A-Za-z.])Text\\(\\s*\"((?:[^\"\\\\\\n]|\\\\.)*)\"")

    private fun unescape(literal: String) = literal.replace("\\\"", "\"").replace("\\n", "\n").replace("\\\\", "\\")

    /** Intentional cases: text that stays as written (user data placeholders, brand names). Keep this list short. */
    private val allowedSinks = emptySet<String>()

    /** `ui("...")` sources that need no English entry (symbols, names, brand). */
    private val allowedUiSources = setOf("F", "FaNotes", "Name", "Local first", "Release", "GlyphenWerk", "Link")

    @Test
    fun noGermanTextLiteralBypassesUi() {
        assertTrue(sources.isNotEmpty(), "app sources not found")
        val offenders = ArrayList<String>()
        for (file in sources) {
            file.readLines().forEachIndexed { index, line ->
                if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return@forEachIndexed
                val plainText = file.readText().contains("import androidx.compose.material3.Text\n")
                val matches = if (plainText) sink.findAll(line) + textCall.findAll(line) else sink.findAll(line)
                for (match in matches) {
                    val literal = unescape(match.groupValues[1])
                    if (germanHint.containsMatchIn(literal) && "${file.name}: $literal" !in allowedSinks) {
                        offenders += "${file.name}:${index + 1}: $literal"
                    }
                }
            }
        }
        assertEquals(emptyList<String>(), offenders, "German text shown without ui(...)")
    }

    @Test
    fun everyUiSourceHasAnEnglishText() {
        assertTrue(catalog.size > 1000, "en.json did not load")
        val missing = ArrayList<String>()
        for (file in sources) {
            file.readLines().forEachIndexed { index, line ->
                val textFile = !file.readText().contains("import androidx.compose.material3.Text\n")
                val rows = rowCall.findAll(line).flatMap { m -> listOfNotNull(m.groups[1]?.value, m.groups[2]?.value).asSequence() }
                for (literal in rows) {
                    val source = unescape(literal)
                    if (source.none { it.isLetter() } || '$' in source || source in allowedUiSources) continue
                    if (translateChrome(source, "en", catalog) == swissSpelling(source) && source !in catalog && swissSpelling(source) !in catalog) {
                        missing += "${file.name}:${index + 1}: $source"
                    }
                }
                val calls = uiCall.findAll(line).map { it to true } + (if (textFile) textCall.findAll(line).map { it to false } else emptySequence())
                for ((match, isUi) in calls) {
                    val source = unescape(match.groupValues[1])
                    if (!isUi && !germanHint.containsMatchIn(source)) continue
                    if (source.none { it.isLetter() } || source in allowedUiSources || '$' in source) continue
                    if (translateChrome(source, "en", catalog) == swissSpelling(source) && source !in catalog && swissSpelling(source) !in catalog) {
                        missing += "${file.name}:${index + 1}: $source"
                    }
                }
            }
        }
        assertEquals(emptyList<String>(), missing, "ui(...) source without an English entry in en.json")
    }

    /** User data (names, paths, titles of notes and folders) is shown as written; it must never go through `ui(...)`. */
    @Test
    fun userDataNeverGoesThroughUi() {
        val userData = Regex("\\b(?:ui|ChromeText\\.ui)\\(\\s*(?:[A-Za-z_][\\w?]*\\.)*(?:name|path|email|subject|noteTitle|folderName|fileName|stem)\\s*\\)")
        val offenders = ArrayList<String>()
        for (file in sources) {
            file.readLines().forEachIndexed { index, line ->
                if (userData.containsMatchIn(line)) offenders += "${file.name}:${index + 1}: ${line.trim().take(100)}"
            }
        }
        assertEquals(emptyList<String>(), offenders, "user data passed through ui(...)")
    }

    @Test
    fun germanNeverShowsEszett() {
        for ((source, _) in catalog) {
            if ('ß' in source) assertTrue('ß' !in translateChrome(source, "de", catalog), "ß left in German UI: $source")
        }
        assertEquals("Schliessen", translateChrome("Schließen", "de", catalog))
    }

    @Test
    fun sentencesWithNamesAndCountsTranslate() {
        assertEquals("3 of 5 done", translateChrome("3 von 5 erledigt", "en", catalog))
        assertEquals("Page 4", translateChrome("Seite 4", "en", catalog))
        assertEquals("Permanently delete “Mathe”? This cannot be undone.", translateChrome("„Mathe“ endgültig löschen? Das kann nicht rückgängig gemacht werden.", "en", catalog))
        assertEquals("1 file imported. 2 not supported (PDF, images, Markdown).", translateChrome("1 Datei importiert. 2 nicht unterstützt (PDF, Bilder, Markdown).", "en", catalog))
        assertEquals(
            "Underlines typos in red locally and detects German or English automatically. Maths and code are left alone. A long press or Ctrl+. shows suggestions.",
            translateChrome("Unterstreicht Tippfehler lokal rot und erkennt Deutsch oder Englisch automatisch. Mathematik und Code bleiben unberührt. Ein langes Drücken oder Strg+. zeigt Vorschläge.", "en", catalog),
        )
        // User text is never rewritten, and German keeps the source.
        assertEquals("Meine Notizen", translateChrome("Meine Notizen", "en", catalog))
        assertEquals("3 von 5 erledigt", translateChrome("3 von 5 erledigt", "de", catalog))
    }
}
