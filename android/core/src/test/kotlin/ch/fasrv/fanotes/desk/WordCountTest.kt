package ch.fasrv.fanotes.desk

import java.util.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** [countWords] is the desktop's count, now in single linear scans instead of five regular expression copies. */
class WordCountTest {
    // The previous implementation, kept here as the reference the scans must agree with.
    private val strip = listOf(
        Regex("<!--[\\s\\S]*?-->") to " ",
        Regex("```[\\s\\S]*?```") to " ",
        Regex("!\\[[^\\]]*\\]\\([^)]*\\)") to " ",
        Regex("\\[([^\\]]*)\\]\\([^)]*\\)") to "$1",
        Regex("[#>*_`~|-]+") to " ",
    )
    private val word = Regex("[\\p{L}\\p{N}][\\p{L}\\p{N}'’]*")

    private fun reference(markdown: String): Int {
        var body = markdown
        for ((pattern, replacement) in strip) body = pattern.replace(body, replacement)
        return word.findAll(body).count()
    }

    @Test
    fun agreesWithTheRegularExpressionsOnHandWrittenCases() {
        val cases = listOf(
            "",
            "# Titel\n\n- eins **zwei** [drei](http://a.b/c) ![x](y.png)\n<!-- c w -->",
            "don’t stop me ```a b c```",
            "<!-- never closed words after",
            "words <!-- a --> between <!-- b --> comments <!-- c",
            "```fence``` text ``` unclosed fence and more words",
            "a ``` b ``` c ``` d ``` e",
            "[link text](url) and ![alt text](img.png) and [broken](no close and more",
            "[[nested](url)] and [a](b)(c)",
            "![![x](y)](z) trailing",
            "[x](y",
            "](",
            "[a]\n(b)",
            "[a](b)[c](d)[e](f)",
            "x [ y ] ( z ) w",
            "élève and naïve and 𝒜𝒷𝒸 and 日本語のテキスト",
            "1.5 und 2,5 und x_y und a-b und o'clock und l’été",
            "<!--\n-->words<!---->more<!-- --> done",
            "``````",
            "```\n```",
            "***bold*** ___under___ ~~strike~~ |a|b| > quote",
        )
        for (text in cases) assertEquals(reference(text), countWords(text), "differs for: ${text.replace("\n", "\\n")}")
        assertEquals(0, countWords(null))
        assertEquals(0, countWords(""))
    }

    @Test
    fun agreesWithTheRegularExpressionsOnRandomText() {
        val tokens = listOf(
            "<!--", "-->", "```", "``", "`", "![", "[", "]", "(", ")", "](", "[x]", "(y)", "word", "Wörter", "don't", "l’été", "x-y", "a_b",
            "#", ">", "*", "~", "|", "-", "\n", "\r\n", " ", "  ", "日本", "𝒜", "é", "1.5", "42", "http://a.b/c",
        )
        val random = Random(20261116)
        repeat(30_000) { round ->
            val text = buildString { repeat(random.nextInt(40)) { append(tokens[random.nextInt(tokens.size)]) } }
            assertEquals(reference(text), countWords(text), "round $round differs for: ${text.replace("\n", "\\n")}")
        }
    }

    @Test
    fun staysLinearWhenOpenersNeverClose() {
        val cases = mapOf(
            "unclosed comments" to "<!-- ".repeat(150_000) + "words",
            "unclosed fences" to "``` a ".repeat(150_000) + "words",
            "unclosed images" to "![ a ".repeat(150_000) + "](",
            "unclosed links" to "[a ".repeat(150_000) + "](",
            "links without a closing paren" to "[a](b ".repeat(100_000),
            "brackets only" to "[".repeat(600_000) + "](",
            "many openers, one closer" to "![".repeat(200_000) + "](x) done",
        )
        for ((label, text) in cases) {
            val started = System.nanoTime()
            countWords(text)
            val millis = (System.nanoTime() - started) / 1_000_000
            assertTrue(millis < 3_000, "$label took $millis ms")
        }
    }

    @Test
    fun aBigNoteIsCountedWithoutCopyingItFiveTimes() {
        val text = "Ein Wort, noch ein [Link](http://x.y/z) und <!-- nichts --> Text.\n".repeat(60_000) // about 4 MB
        val started = System.nanoTime()
        val count = countWords(text)
        val millis = (System.nanoTime() - started) / 1_000_000
        assertEquals(60_000 * 7, count)
        assertTrue(millis < 5_000, "took $millis ms")
    }
}
