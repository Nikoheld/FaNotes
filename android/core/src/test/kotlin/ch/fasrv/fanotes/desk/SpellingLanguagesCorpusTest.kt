package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Document language detection for spellcheck and autocorrect on the same realistic corpus as the
 * desktop check `fanotes/scripts/check-spelling-languages.mjs` (#1473): the notes of a Swiss
 * Kantonsschule student in German, English and French, often mixed in one note. Keep the two lists in step.
 *
 * Marks: `⟦typo|fix⟧` is a typing slip and the word it should become, `⟦typo|fix|fr⟧` one in French.
 * A line with passages also states the expected language of the passages it contains
 * (`unsure` means: not confident). `unsupported` lines are in a language without dictionary.
 */
class SpellingLanguagesCorpusTest {
    private class CorpusLine(
        val text: String,
        val passages: List<Pair<String, String>> = emptyList(),
        val weak: Boolean = false,
        val unsupported: Boolean = false,
    )

    private class CorpusNote(val name: String, val lines: List<CorpusLine>)

    private class Typo(val from: Int, val to: Int, val typo: String, val fix: String, val language: String?)
    private class ExpectedPassage(val from: Int, val language: String, val text: String)
    private class PreparedNote(
        val name: String,
        val text: String,
        val typos: List<Typo>,
        val passages: List<ExpectedPassage>,
        val unsupported: List<IntRange>,
    )

    private val notes = listOf(
        CorpusNote(
            "German note with English terms",
            listOf(
                CorpusLine("# Informatik: Algorithmen"),
                CorpusLine("Ein Algorithmus ist eine Folge von Schritten, die ein Problem löst.", listOf("Ein Algorithmus" to "de")),
                CorpusLine("Der Computer führt jeden ⟦Befhel|Befehl⟧ nacheinander aus."),
                CorpusLine("Wichtige Begriffe sind Array, Loop, Software und Hardware."),
                CorpusLine("Die Variable speichert einen ⟦Wret|Wert⟧ im Arbeitsspeicher."),
                CorpusLine("Ein Programm mit einem ⟦Fehlr|Fehler⟧ liefert ein falsches Resultat.", listOf("Ein Programm" to "de")),
                CorpusLine("Der ⟦Bidlschirm|Bildschirm⟧ zeigt die Ausgabe an und die Maus steuert den Zeiger."),
                CorpusLine("Beim Debugging sucht man den Fehler im Code.", listOf("Beim Debugging" to "de")),
            ),
        ),
        CorpusNote(
            "French class note with German explanations",
            listOf(
                CorpusLine("# Französisch: Passé composé"),
                CorpusLine("Le passé composé se forme avec l'auxiliaire avoir ou être et le participe passé.", listOf("Le passé" to "fr")),
                CorpusLine("Hier, j'ai mangé une ⟦pomem|pomme|fr⟧ et mon frère a bu du lait.", listOf("Hier, j'ai" to "fr")),
                CorpusLine("Elle est allée à l'école avec ses ⟦amsi|amis|fr⟧ et ils ont joué dans le ⟦jadrin|jardin|fr⟧.", listOf("Elle est" to "fr")),
                CorpusLine("Hier soir nous avons regardé un film très ⟦intéressnt|intéressant|fr⟧.", listOf("Hier soir" to "fr")),
                CorpusLine("Erklärung: Bei Verben der Bewegung verwendet man être als Hilfsverb.", listOf("Bei Verben" to "de")),
                CorpusLine("Das Partizip richtet sich nach dem ⟦Subjket|Subjekt⟧ des Satzes.", listOf("Das Partizip" to "de")),
                CorpusLine("Les ⟦élvèes|élèves|fr⟧ ont fait leurs devoirs et le professeur a corrigé l'⟦ecole|école|fr⟧.", listOf("ont fait leurs devoirs" to "fr")),
                CorpusLine("Pourquoi est-ce que tu ⟦palres|parles|fr⟧ si vite aujourd'hui ?", listOf("Pourquoi" to "fr")),
            ),
        ),
        CorpusNote(
            "Vocabulary lists",
            listOf(
                CorpusLine("## Vokabeln Französisch"),
                CorpusLine("le chien – der Hund", listOf("le chien" to "fr", "der Hund" to "de")),
                CorpusLine("la maison – das Haus", listOf("la maison" to "fr", "das Haus" to "de")),
                CorpusLine("le chat – die Katze", listOf("le chat" to "fr", "die Katze" to "de")),
                CorpusLine("l'école = die Schule", listOf("l'école" to "fr", "die Schule" to "de")),
                CorpusLine("le ⟦chein|chien|fr⟧ – der Hund", listOf("der Hund" to "de"), weak = true),
                CorpusLine("- la ⟦maisno|maison|fr⟧ – das Haus", listOf("das Haus" to "de"), weak = true),
                CorpusLine("## Vocabulary English"),
                CorpusLine("the dog – der Hund", listOf("the dog" to "en", "der Hund" to "de")),
                CorpusLine("the house – das Haus", listOf("the house" to "en", "das Haus" to "de")),
                CorpusLine("to run = laufen", listOf("to run" to "en", "laufen" to "de")),
                CorpusLine("the ⟦hosue|house⟧ – das Haus", listOf("das Haus" to "de"), weak = true),
                CorpusLine("| le livre | das Buch |", listOf("le livre" to "fr", "das Buch" to "de")),
                CorpusLine("chien"),
                CorpusLine("Hund"),
            ),
        ),
        CorpusNote(
            "English note with a German quote",
            listOf(
                CorpusLine("# History: The Swiss Confederation"),
                CorpusLine("The Swiss Confederation was ⟦fonuded|founded⟧ in 1291 by three cantons.", listOf("The Swiss" to "en")),
                CorpusLine("The teacher said: „Das ist ein wichtiges Datum für die Schweiz.“ and we wrote it down.", listOf("The teacher said" to "en", "Das ist ein wichtiges" to "de")),
                CorpusLine("Students must learn the ⟦differnt|different⟧ treaties and their dates.", listOf("Students must" to "en")),
                CorpusLine("Der Bundesbrief ist das älteste Dokument der Schweiz.", listOf("Der Bundesbrief" to "de")),
                CorpusLine("The document is kept in a museum and many people visit it every year.", listOf("The document" to "en")),
            ),
        ),
        CorpusNote(
            "Single words and headings",
            listOf(
                CorpusLine("# Biologie"),
                CorpusLine("Zelle"),
                CorpusLine("Zellkern"),
                CorpusLine("## Aufbau"),
                CorpusLine("Die Zelle ist die kleinste Einheit des Lebens und besteht aus vielen Teilen."),
                CorpusLine("⟦Zelkern|Zellkern⟧"),
                CorpusLine("Der Zellkern enthält die Erbinformation der Zelle."),
                CorpusLine("Nucleus"),
            ),
        ),
        CorpusNote(
            "Italian line must stay untouched",
            listOf(
                CorpusLine("# Italienisch"),
                CorpusLine("Das ist ein Satz über den Unterricht und die Hausaufgaben."),
                CorpusLine("Il cane è molto grande e la casa è vicino al fiume.", unsupported = true),
                CorpusLine("Buongiorno, come stai oggi? Sto molto bene, grazie mille.", unsupported = true),
                CorpusLine("Der Lehrer hat gesagt, dass wir die Wörter lernen müssen."),
            ),
        ),
        CorpusNote(
            "Mixed German note with French vocabulary and English quote",
            listOf(
                CorpusLine("# Sprachen: Wochenplan"),
                CorpusLine("Am Montag haben wir Französisch und am Dienstag Englisch."),
                CorpusLine("Wir lernen die Wörter le lundi, le mardi und le mercredi.", listOf("Wir lernen" to "unsure")),
                CorpusLine("Les jours de la semaine sont très faciles à retenir.", listOf("Les jours" to "fr")),
                CorpusLine("Der Lehrer sagte: \"The weekend starts on Friday afternoon.\" und alle freuten sich.", listOf("Der Lehrer" to "de", "The weekend" to "en")),
                CorpusLine("Die ⟦Hausafugabe|Hausaufgabe⟧ ist bis Freitag abzugeben."),
            ),
        ),
    )

    private val mark = Regex("""⟦([^|⟧]+)\|([^|⟧]+)(?:\|([a-z]+))?⟧""")

    private fun prepare(note: CorpusNote): PreparedNote {
        val typos = ArrayList<Typo>()
        val passages = ArrayList<ExpectedPassage>()
        val unsupported = ArrayList<IntRange>()
        val text = StringBuilder()
        note.lines.forEachIndexed { index, line ->
            val start = text.length
            val plain = StringBuilder()
            var last = 0
            for (match in mark.findAll(line.text)) {
                plain.append(line.text, last, match.range.first)
                typos += Typo(start + plain.length, start + plain.length + match.groupValues[1].length, match.groupValues[1], match.groupValues[2], match.groupValues[3].ifEmpty { null })
                plain.append(match.groupValues[1])
                last = match.range.last + 1
            }
            plain.append(line.text, last, line.text.length)
            for ((needle, language) in line.passages) {
                val at = plain.indexOf(needle)
                assertTrue(at >= 0, "passage $needle is in $plain")
                passages += ExpectedPassage(start + at, language, needle)
            }
            if (line.unsupported) unsupported += start until start + plain.length
            text.append(plain)
            if (index < note.lines.size - 1) text.append('\n')
        }
        return PreparedNote(note.name, text.toString(), typos, passages, unsupported)
    }

    private fun segments(text: String): List<SpellingSegment> {
        var from = 0
        return text.split('\n').map { line -> SpellingSegment(from, line).also { from += line.length + 1 } }
    }

    private fun overlaps(from: Int, to: Int, other: IntRange) = from <= other.last && to > other.first

    @Test
    fun theCorpusGetsItsLanguagesRightWithoutFalseUnderlinesOrAutocorrects() {
        val dictionaries = loadBundledSpelling(includeCandidates = true)
        val lexicon = SpellingLexicon(dictionaries)
        assertTrue(dictionaries.hasFrench, "the French dictionary ships with the app")
        assertTrue(lexicon.loadFrench())

        var words = 0
        var falseFlags = 0
        var typosTotal = 0
        var typosCaught = 0
        var frenchTypos = 0
        var frenchTyposCaught = 0
        var fixed = 0
        var wrongFix = 0
        var falseAutocorrects = 0
        var unsafeAutocorrects = 0
        var unsupportedUnderlined = 0
        var passagesTotal = 0
        var passagesRight = 0
        val problems = ArrayList<String>()

        fun autocorrect(text: String, end: Int): String? {
            val typed = text.substring(0, end)
            val pass = checkSpelling(segments(typed), dictionaries, cursorPositions = listOf(end), documentLines = typed.split('\n'))
            val result = autocorrectTyping(
                typed, "$typed ", end, 0, lexicon, enabled = true, mark = null, declined = { false },
                passageAt = { offset -> paragraphPassageAt(typed, offset, pass.profile, dictionaries) },
            )
            return result?.mark?.replacement
        }

        for (note in this.notes.map(::prepare)) {
            val analysis = checkSpelling(segments(note.text), dictionaries, documentLines = note.text.split('\n'))
            val inUnsupported = { from: Int, to: Int -> note.unsupported.any { overlaps(from, to, it) } }
            for (match in Regex("""\p{L}[\p{L}\p{M}'’-]*""").findAll(note.text)) {
                val from = match.range.first
                val to = from + match.value.length
                if (note.typos.any { from < it.to && to > it.from }) continue
                if (match.value.length < 2) continue
                words += 1
                val flagged = analysis.errors.any { from < it.to && to > it.from }
                if (inUnsupported(from, to)) {
                    if (flagged) unsupportedUnderlined += 1
                    continue
                }
                if (flagged) {
                    falseFlags += 1
                    problems += "false flag ${note.name}: ${match.value}"
                }
            }
            for (typo in note.typos) {
                typosTotal += 1
                val caught = analysis.errors.any { typo.from < it.to && typo.to > it.from }
                if (caught) typosCaught += 1 else problems += "missed ${note.name}: ${typo.typo}"
                if (typo.language == "fr") {
                    frenchTypos += 1
                    if (caught) frenchTyposCaught += 1
                }
            }
            // Replay the typing: every word of the note, in order.
            for (match in Regex("""\p{L}+""").findAll(note.text)) {
                val start = match.range.first
                val end = start + match.value.length
                if (match.value.length < 2) continue
                val replacement = autocorrect(note.text, end)
                val typo = note.typos.firstOrNull { it.from == start && it.to == end }
                if (inUnsupported(start, end)) {
                    if (replacement != null) {
                        unsafeAutocorrects += 1
                        problems += "unsafe ${note.name}: ${match.value} -> $replacement (unsupported language)"
                    }
                    continue
                }
                if (typo != null) {
                    if (replacement == typo.fix) fixed += 1
                    else if (replacement != null) {
                        wrongFix += 1
                        problems += "wrong fix ${note.name}: ${typo.typo} -> $replacement (expected ${typo.fix})"
                    }
                } else if (replacement != null) {
                    falseAutocorrects += 1
                    problems += "false autocorrect ${note.name}: ${match.value} -> $replacement"
                }
            }
            // Language per annotated passage.
            for (passage in note.passages) {
                passagesTotal += 1
                val found = analysis.passages.firstOrNull { passage.from + 1 >= it.from && passage.from + 1 < it.to }
                val right = if (passage.language == "unsure") found?.language?.confident != true else found?.language?.language == passage.language
                if (right) passagesRight += 1
                else problems += "passage ${note.name}: \"${passage.text}\" is ${found?.language?.language ?: "unknown"}, expected ${passage.language}"
            }
        }

        val report = problems.joinToString("\n  ")
        assertTrue(words > 300, "the corpus holds its words ($words)")
        assertEquals(0, falseFlags, "no correct word is underlined:\n  $report")
        assertEquals(0, falseAutocorrects + unsafeAutocorrects, "no correct or foreign word is autocorrected:\n  $report")
        assertEquals(0, wrongFix, "autocorrect never picks a wrong word:\n  $report")
        assertEquals(typosTotal, typosCaught, "every typo is underlined:\n  $report")
        assertEquals(frenchTypos, frenchTyposCaught, "every French typo is underlined")
        assertTrue(frenchTypos >= 5, "the corpus holds French typos")
        assertEquals(passagesTotal, passagesRight, "every annotated passage gets its language:\n  $report")
        assertEquals(0, unsupportedUnderlined, "an unsupported language is not underlined")
        assertTrue(fixed >= 6, "confident passages still get their typos corrected ($fixed)")
    }
}
