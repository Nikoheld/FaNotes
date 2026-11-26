package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Passage splitting, the note profile, French handling and the autocorrect gate (desktop #1473). */
class LanguageDetectTest {
    private fun spans(text: String) = splitPassages(text).map { text.substring(it.from, it.to) to it.kind }

    @Test
    fun aLineSplitsIntoTheSidesOfAVocabularyPairAndTableCells() {
        assertEquals(
            listOf("le chien" to PassageKind.VOCABULARY, "der Hund" to PassageKind.VOCABULARY),
            spans("- le chien – der Hund"),
        )
        assertEquals(
            listOf("le livre" to PassageKind.CELL, "das Buch" to PassageKind.CELL),
            spans("| le livre | das Buch |"),
        )
        assertEquals(listOf("Ein ganz normaler Satz." to PassageKind.LINE), spans("Ein ganz normaler Satz."))
        val quote = spans("The teacher said: „Das ist ein wichtiges Datum für die Schweiz.“ and we wrote it down.")
        assertTrue(quote.any { it.second == PassageKind.QUOTE && it.first.startsWith("Das ist") })
    }

    @Test
    fun theNoteProfileNamesTheLanguagesInUse() {
        assertEquals("de", detectNoteLanguage("Der Satz ist auf dem Papier und die Klasse schreibt mit."))
        assertEquals("fr", detectNoteLanguage("Le chat est dans la maison avec les amis et la famille, nous sommes très contents."))
        assertEquals("mixed", detectNoteLanguage("Der Satz ist auf dem Papier und die Klasse schreibt mit.\nLe chat est dans la maison avec les amis et la famille, nous sommes très contents."))
        assertEquals(listOf("de", "fr"), detectNoteLanguages("Der Satz ist auf dem Papier und die Klasse schreibt mit und wir sind hier.\nLe chat est dans la maison avec les amis et la famille, nous sommes très contents.").sorted())
    }

    @Test
    fun frenchWordsAreKnownWithElisionAndHyphen() {
        val dictionaries = loadBundledSpelling()
        for (word in listOf("l'homme", "qu'il", "l’école", "peut-être", "aujourd'hui", "est-ce", "a-t-il")) {
            assertTrue(wordMembership(word, dictionaries).fr, word)
        }
        assertFalse(wordMembership("l'homem", dictionaries).fr)
        assertFalse(wordMembership("Bidlschirm", dictionaries).fr)
    }

    @Test
    fun italianIsNeitherUnderlinedNorCorrected() {
        val dictionaries = loadBundledSpelling(includeCandidates = true)
        val text = "Das ist ein Satz über den Unterricht und die Hausaufgaben.\nIl cane è molto grande e la casa è vicino al fiume."
        val result = checkNoteSpelling(text, emptyList(), dictionaries)
        val italianStart = text.indexOf("Il cane")
        assertTrue(result.errors.none { it.from >= italianStart }, result.errors.toString())
        val passage = result.passages.first { it.from >= italianStart }
        assertTrue(passage.language.unsupported)
    }

    @Test
    fun autocorrectActsOnlyOnAConfidentPassage() {
        val dictionaries = loadBundledSpelling(includeCandidates = true)
        val lexicon = SpellingLexicon(dictionaries)
        lexicon.loadFrench()
        fun fix(before: String): String? {
            val pass = checkNoteSpelling(before, listOf(before.length), dictionaries)
            return autocorrectTyping(
                before, "$before ", before.length, 0, lexicon, enabled = true, mark = null, declined = { false },
                passageAt = { paragraphPassageAt(before, it, pass.profile, dictionaries) },
            )?.mark?.replacement
        }
        assertEquals("Bildschirm", fix("Der Computer zeigt alles auf dem Bidlschirm"))
        assertEquals("pomme", fix("Hier, j'ai mangé une pomem"))
        // A lone word has no language of its own: underlined, never rewritten.
        assertEquals(null, fix("Bidlschirm"))
        // A word another dictionary knows is never rewritten ("soir" is French in a German line).
        assertEquals(null, fix("Der Lehrer hat gesagt, dass wir heute soir"))
        // Italian stays as typed.
        assertEquals(null, fix("Il cane è molto grande e la casa è vicino al fium"))
        assertNotNull(allowedLanguages(listOf("de"), "fr"))
        assertEquals(listOf("de", "en", "fr"), allowedLanguages(listOf("de"), "fr"))
        assertEquals(listOf("de", "en"), allowedLanguages(listOf("de"), "de"))
    }
}
