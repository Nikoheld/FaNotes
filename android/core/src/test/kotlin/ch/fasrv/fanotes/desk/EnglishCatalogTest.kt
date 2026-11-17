package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The English catalog is the desktop `en.json`, looked up by the exact German source text. */
class EnglishCatalogTest {
    private val raw: String = EnglishCatalogTest::class.java.classLoader!!.getResourceAsStream("en.json")!!
        .bufferedReader(Charsets.UTF_8).use { it.readText() }

    /** The quoted key at the start of a catalog line, or null. Scanned by hand: a regex over these long lines overflows the stack. */
    private fun keyToken(line: String): String? {
        val start = line.indexOf('"')
        if (start < 0 || line.substring(0, start).isNotBlank()) return null
        var i = start + 1
        while (i < line.length) {
            when (line[i]) {
                '\\' -> i += 2
                '"' -> return if (line.substring(i + 1).trimStart().startsWith(":")) line.substring(start, i + 1) else null
                else -> i++
            }
        }
        return null
    }

    /** A duplicate key silently keeps the last value when the file is parsed, so the text is scanned line by line. */
    @Test
    fun noKeyIsDefinedTwice() {
        val seen = HashMap<String, Int>()
        val duplicates = ArrayList<String>()
        raw.lines().forEachIndexed { index, line ->
            val token = keyToken(line) ?: return@forEachIndexed
            val text = (parseJson(token) as JsonValue.Str).value
            val first = seen.putIfAbsent(text, index + 1)
            if (first != null) duplicates += "${text.take(60)} (lines $first and ${index + 1})"
        }
        assertEquals(emptyList<String>(), duplicates)
        assertEquals(loadEnglishCatalog(raw).size, seen.size, "every catalog entry sits on its own line")
    }

    /** The palette shows `label` and `detail` through the catalog, so each study command needs both in English. */
    @Test
    fun studyCommandsHaveEnglishTitlesAndDetails() {
        val catalog = loadEnglishCatalog(raw)
        val study = paletteCommands().filter { it.group == "Lernwerkzeuge" }
        assertTrue(study.size >= 7, "study commands in the palette")
        for (command in study) {
            assertTrue(command.label in catalog, "no English title for: ${command.label}")
            if (command.detail.isNotBlank()) assertTrue(command.detail in catalog, "no English detail for: ${command.detail}")
        }
    }
}
