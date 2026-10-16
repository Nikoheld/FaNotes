package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SpellingTest {
    @Test
    fun oneEditKeepsTheDesktopSlipKinds() {
        val edits = editsAtDistanceOne("abc", "abc")
        assertTrue(edits.any { it.first == "bac" && it.second == "transpose" })
        assertTrue(edits.any { it.first == "ab" && it.second == "delete" })
        assertTrue(edits.any { it.first == "abbc" && it.second == "double" })
        assertTrue(edits.any { it.first == "cbc" && it.second == "replace" })
    }

    @Test
    fun suggestionsMatchTheDesktopRanking() {
        val lexicon = SpellingDictionary.get()
        fun words(typed: String, languages: List<String>, distance: Int = 2) =
            suggestCorrections(typed, languages, lexicon, maxDistance = distance).map { it.word }
        assertEquals("the", words("teh", listOf("en")).first())
        assertTrue("with" in words("wiht", listOf("en")))
        assertEquals("Haus", words("Hasu", listOf("de")).first())
        assertEquals("HAUS", words("HASU", listOf("de")).first())
        assertTrue("Schüler" in words("Schuler", listOf("de")))
        assertEquals("auch das", words("auchdas", listOf("de")).first())
        assertFalse("Hausaufgaben" in words("Hausafgbaen", listOf("de"), distance = 1))
        assertTrue(SpellingDictionary.get().hasWord("de", "hausaufgaben"))
        assertFalse("Hausaufgaben" in words("Hausafgbaen", listOf("de"), distance = 1))
        assertTrue("the" in words("hte", listOf("de", "en")))
        assertTrue(words("qzxwv", listOf("de", "en")).isEmpty())
        assertTrue(words("12ab", listOf("de")).isEmpty())
    }

    @Test
    fun autocorrectStaysConservative() {
        val lexicon = SpellingDictionary.get()
        fun decide(typed: String, language: String? = "de", sentenceStart: Boolean = false, proper: (String) -> Boolean = { false }): SpellingSuggestion? {
            val languages = if (language != null) listOf(language) else listOf("de", "en")
            return decideAutocorrect(
                typed,
                suggestCorrections(typed, languages, lexicon, limit = 4, maxDistance = 1),
                AutocorrectContext(language, sentenceStart, proper),
            )
        }
        assertEquals("the", decide("teh", language = "en")?.word)
        assertEquals("Haus", decide("Hasu")?.word)
        assertEquals("with", decide("wiht", language = "en")?.word)
        assertNull(decide("Jonas", language = "en"))
        assertNull(decide("Fabio", language = "en", sentenceStart = true) { it == "fabio" })
        assertNull(decide("iPhone"))
        assertNull(decide("NASA"))
        assertNull(decide("ab"))
        val context = AutocorrectContext("de", false) { false }
        assertNull(decideAutocorrect("haxs", listOf(SpellingSuggestion("haus", 1, 130, "de")), context))
        assertNull(
            decideAutocorrect(
                "xyz",
                listOf(SpellingSuggestion("abc", 1, 100, "de"), SpellingSuggestion("abd", 1, 110, "de")),
                context,
            ),
        )
        assertEquals(
            "abc",
            decideAutocorrect(
                "xyz",
                listOf(SpellingSuggestion("abc", 1, 100, "de"), SpellingSuggestion("abd", 1, 125, "de")),
                context,
            )?.word,
        )
        assertNull(decideAutocorrect("xyz", listOf(SpellingSuggestion("ab c", 1, 100, "de")), context))
    }

    @Test
    fun knownWordsStayCleanAndTyposAreUnderlined() {
        val clean = checkSpelling("Das ist ein Haus.")
        assertTrue(clean.errors.none { it.word == "Haus" || it.word == "Das" })
        val typo = checkSpelling("Das ist ein Hauus.")
        assertTrue(typo.errors.any { it.word == "Hauus" })
        val code = checkSpelling("Siehe `Hauus` im Code.")
        assertTrue(code.errors.none { it.word == "Hauus" })
    }

    @Test
    fun aFinishedWordIsCorrectedAndBackspaceRestoresIt() {
        val edit = autocorrectBoundaryEdit("teh", "teh ", insertionAt = 3, deleted = 0)
        assertEquals("the ", edit?.text)
        assertEquals(4, edit?.cursor)
        val restored = revertAutocorrectEdit(edit!!.text, edit.cursor, edit.mark)
        assertEquals("teh" to 3, restored)
        assertNull(autocorrectBoundaryEdit("the", "the ", insertionAt = 3, deleted = 0))
    }
}
