package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SpellingTest {
    @Test
    fun bloomHashesMatchTheDesktopMixer() {
        assertEquals(2949673445L, spellingHash("test", 0x811c9dc5L))
        assertEquals(1771520201L, spellingHash("test", 0x9e3779b1L) or 1L)
        assertEquals(92381716L, spellingHash("strasse", 0x811c9dc5L))
        assertEquals(1262694567L, spellingHash("prüfung", 0x811c9dc5L))
        assertEquals(2875609948L, spellingHash("moustache", 0x811c9dc5L))
    }

    @Test
    fun germanEnglishMixedMarkdownAndTheCursorMatchTheDesktopChecker() {
        val dictionaries = bloom
        val german = check("Das ist ein Tset und die Strasse ist gross. Rechtschreibprüfung funktioniert.", dictionaries)
        assertEquals(listOf("Tset"), german.errors.map { it.word })
        assertEquals("de", german.detectedLanguage)

        val english = check("This is an exampel and the simple word is correct.", dictionaries)
        assertEquals(listOf("exampel"), english.errors.map { it.word })
        assertEquals("en", english.detectedLanguage)

        val british = check("The specialised enquiry noted a moustache before they deputise the officer at Chequers.", dictionaries)
        assertEquals(emptyList(), british.errors)

        val mixed = checkSpelling(
            listOf(
                SpellingSegment(0, "Das ist ein deutscher Satz."),
                SpellingSegment(30, "This is an English sentence."),
            ),
            dictionaries,
        )
        assertEquals("mixed", mixed.detectedLanguage)
        assertEquals(emptyList(), mixed.errors)

        val markdown = check("Formel \$exampel + Tset\$ und `exampel` bleibt korrekt.", dictionaries)
        assertEquals(emptyList(), markdown.errors)

        val cursor = check("Das ist ein Tset", dictionaries, cursorPositions = listOf(16))
        assertEquals(emptyList(), cursor.errors)

        val excluded = check("Das ist ein Tset.", dictionaries, ignoredRanges = listOf(SpellingRange(12, 16)))
        assertEquals(emptyList(), excluded.errors)

        val french = check("Das ist ein eleve im Text.", dictionaries)
        assertFalse(french.errors.any { it.word == "eleve" })
        assertTrue(spellcheckEnabled(emptyMap()))
        assertFalse(spellcheckEnabled(mapOf("spellcheck" to "off")))
    }

    @Test
    fun suggestionsRankTheSameSlipsAsTheDesktop() {
        val lexicon = testLexicon(full)
        assertTrue(suggestCorrections("Tset", listOf("de"), SpellingLexicon(full)).any { it.word == "Test" })
        val edits = editsAtDistanceOne("abc", "abc")
        assertTrue(edits.any { it.word == "bac" && it.kind == "transpose" })
        assertTrue(edits.any { it.word == "ab" && it.kind == "delete" })
        assertTrue(edits.any { it.word == "abbc" && it.kind == "double" })
        assertTrue(edits.any { it.word == "cbc" && it.kind == "replace" })

        assertEquals("the", suggestCorrections("teh", listOf("en"), lexicon).first().word)
        assertTrue(words("wiht", "en", lexicon).contains("with"))
        assertEquals("Haus", suggestCorrections("Hasu", listOf("de"), lexicon).first().word)
        assertEquals("HAUS", suggestCorrections("HASU", listOf("de"), lexicon).first().word)
        assertTrue(words("Schuler", "de", lexicon).contains("Schüler"))
        assertEquals("auch das", suggestCorrections("auchdas", listOf("de"), lexicon).first().word)
        assertTrue(words("Hausafgbaen", "de", lexicon).contains("Hausaufgaben"))
        assertFalse(
            suggestCorrections("Hausafgbaen", listOf("de"), lexicon, maxDistance = 1).any { it.word == "Hausaufgaben" },
        )
        assertTrue(suggestCorrections("hte", listOf("de", "en"), lexicon).any { it.word == "the" })
        assertEquals(emptyList(), suggestCorrections("qzxwv", listOf("de", "en"), lexicon))
        assertEquals(emptyList(), suggestCorrections("12ab", listOf("de"), lexicon))

        val context = AutocorrectContext("de", sentenceStart = false) { false }
        assertEquals("the", decide("teh", lexicon, context.copy(language = "en"))?.word)
        assertEquals("Haus", decide("Hasu", lexicon, context)?.word)
        assertEquals("with", decide("wiht", lexicon, context.copy(language = "en"))?.word)
        assertNull(decide("Jonas", lexicon, context.copy(language = "en")))
        assertNull(decide("Fabio", lexicon, context.copy(language = "en", sentenceStart = true, isProperName = { it == "fabio" })))
        assertNull(decide("iPhone", lexicon, context))
        assertNull(decide("NASA", lexicon, context))
        assertNull(decide("ab", lexicon, context))
        assertNull(
            decideAutocorrect(
                "haxs",
                listOf(SpellingSuggestion("haus", 1, 130, "de")),
                context,
            ),
        )
        assertNull(
            decideAutocorrect(
                "xyz",
                listOf(
                    SpellingSuggestion("abc", 1, 100, "de"),
                    SpellingSuggestion("abd", 1, 110, "de"),
                ),
                context,
            ),
        )
        assertEquals(
            "abc",
            decideAutocorrect(
                "xyz",
                listOf(
                    SpellingSuggestion("abc", 1, 100, "de"),
                    SpellingSuggestion("abd", 1, 125, "de"),
                ),
                context,
            )?.word,
        )
        assertNull(
            decideAutocorrect(
                "xyz",
                listOf(SpellingSuggestion("ab c", 1, 100, "de")),
                context,
            ),
        )
    }

    @Test
    fun personalWordsAndSessionIgnoresFoldCaseAndEszett() {
        assertEquals("nikoheld", addPersonalSpellWord(null, "Nikoheld"))
        val stored = addPersonalSpellWord(null, "Nikoheld")
        assertEquals(setOf("nikoheld"), personalSpellWords(stored))
        assertEquals(stored, addPersonalSpellWord(stored, "NIKOHELD"))
        val session = SpellingSession()
        assertFalse(session.accepts("Nikoheld", personalSpellWords(stored).let { emptySet() }))
        assertTrue(session.accepts("Nikoheld", personalSpellWords(stored)))
        assertTrue(session.ignore("Straßenbahnhaltestelle"))
        assertTrue(session.accepts("strassenbahnhaltestelle", emptySet()))
        val kept = check("Das ist ein Tset.", bloom, acceptedWords = setOf("tset"))
        assertEquals(emptyList(), kept.errors)
    }

    private fun check(
        text: String,
        dictionaries: SpellingDictionaries,
        cursorPositions: List<Int> = emptyList(),
        ignoredRanges: List<SpellingRange> = emptyList(),
        acceptedWords: Set<String> = emptySet(),
    ) = checkSpelling(listOf(SpellingSegment(0, text)), dictionaries, ignoredRanges, cursorPositions, acceptedWords)

    private fun testLexicon(dictionaries: SpellingDictionaries) = object : SuggestionLexicon {
        override fun hasWord(language: String, normalizedWord: String): Boolean {
            val list = if (language == "de") dictionaries.deWords else dictionaries.enWords
            if (list?.contains(normalizedWord) == true) return true
            if (language != "de" || normalizedWord.length < 8) return false
            val german = dictionaries.deWords ?: return false
            for (cut in 3..normalizedWord.length - 3) {
                if (german.contains(normalizedWord.substring(0, cut)) && german.contains(normalizedWord.substring(cut))) return true
            }
            return false
        }

        override fun candidatePenalty(language: String, normalizedWord: String): Int {
            val list = if (language == "de") dictionaries.deWords else dictionaries.enWords
            return if (list?.contains(normalizedWord) == true) 0 else 15
        }
    }

    private fun words(typed: String, language: String, lexicon: SuggestionLexicon) =
        suggestCorrections(typed, listOf(language), lexicon).map { it.word }

    private fun decide(typed: String, lexicon: SuggestionLexicon, context: AutocorrectContext): SpellingSuggestion? {
        val languages = listOf(context.language ?: "de")
        return decideAutocorrect(typed, suggestCorrections(typed, languages, lexicon, limit = 4, maxDistance = 1), context)
    }

    private companion object {
        val bloom by lazy { loadBundledSpelling(includeCandidates = false) }
        val full by lazy { loadBundledSpelling(includeCandidates = true) }
    }
}
