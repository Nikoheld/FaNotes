package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SpellingAutocorrectTest {
    @Test
    fun aClearEnglishSlipBecomesTheEverydayWordAndBackspaceRestoresIt() {
        val before = "This is an teh"
        val next = "$before "
        val applied = autocorrectTyping(
            before,
            next,
            before.length,
            0,
            lexicon,
            enabled = true,
            mark = null,
            declined = { false },
            languageAt = { "en" },
        )
        assertEquals("This is an the ", applied?.text)
        assertEquals(applied?.text?.length, applied?.cursor)
        val mark = applied?.mark ?: error("missing mark")
        assertEquals("teh", mark.original)
        assertEquals("the", mark.replacement)

        val undone = autocorrectTyping(
            applied.text,
            applied.text.dropLast(1),
            mark.to,
            1,
            lexicon,
            enabled = true,
            mark = mark,
            declined = { false },
            languageAt = { "en" },
        )
        assertEquals(before, undone?.text)
        assertEquals("teh", undone?.declined)

        val again = autocorrectTyping(
            before,
            next,
            before.length,
            0,
            lexicon,
            enabled = true,
            mark = null,
            declined = { normalizeForDictionary(it) == "teh" },
            languageAt = { "en" },
        )
        assertNull(again)
    }

    @Test
    fun germanCaseIsRestoredAndNamesAtTheStartOfASentenceStay() {
        val hasu = autocorrectTyping(
            "Hasu",
            "Hasu ",
            4,
            0,
            lexicon,
            enabled = true,
            mark = null,
            declined = { false },
            languageAt = { "de" },
        )
        assertEquals("Haus ", hasu?.text)
        assertNull(
            autocorrectTyping(
                "Fabio",
                "Fabio ",
                5,
                0,
                lexicon,
                enabled = true,
                mark = null,
                declined = { false },
                languageAt = { "en" },
            ),
        )
        assertTrue(isCanonicalProperName("fabio"))
        assertFalse(isCanonicalProperName("teh"))
        assertTrue(autocorrectEnabled(emptyMap()))
        assertFalse(autocorrectEnabled(mapOf("autocorrect" to "off")))
        assertFalse(autocorrectEnabled(mapOf("spellcheck" to "off")))
    }

    private companion object {
        val lexicon by lazy { SpellingLexicon(loadBundledSpelling(includeCandidates = true)) }
    }
}
