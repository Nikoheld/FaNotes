package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The committed Schulnetz HTML is generated and synthetic.
 * Regenerate it with android/core/src/test/tools/make-fixtures.mjs.
 */
class FixtureGuardTest {
    @Test
    fun committedFixturesStaySynthetic() {
        val names = listOf(
            "absenzen.html",
            "agenda.html",
            "kontoauszug.html",
            "noten.html",
            "noten-multi-course.html",
            "blocked-start-grades.html",
            "pruefungsplan.html",
            "start.html",
            "stundenplan.html",
            "terminliste.html",
        )
        for (name in names) {
            val html = checkNotNull(javaClass.getResource("/schulnetz/$name")) { name }.readText()
            assertTrue(fixtureProblems(html).isEmpty(), "$name ${fixtureProblems(html)}")
        }
    }

    @Test
    fun guardRejectsARealAddressALongTeacherListAndAnUnknownClass() {
        assertTrue(fixtureProblems("<p>a@example.org</p>").isEmpty())
        assertTrue(fixtureProblems("<p>a@example.com</p>").isEmpty())
        assertFalse(fixtureProblems("<p>a@school.test</p>").isEmpty())
        assertFalse(fixtureProblems("class K99Z").isEmpty())
        assertTrue(fixtureProblems("class K26A").isEmpty())
        val longList = "var lehrerliste=" + (1..21).joinToString(prefix = "[", postfix = "];") { """{"kuerzel":"EX$it"}""" }
        assertEquals(listOf("lehrerliste"), fixtureProblems(longList))
    }
}

private val FIXTURE_EMAIL = Regex("""[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}""")
private val FIXTURE_CLASS = Regex("""\bK\d{2}[A-Za-z]\b""")
private val ALLOWED_CLASS_CODES = setOf("K26A", "K26B", "K25A", "K24A")
private val ALLOWED_EMAIL_HOSTS = setOf("example.com", "example.org")

internal fun fixtureProblems(html: String): List<String> {
    val problems = mutableListOf<String>()
    for (address in FIXTURE_EMAIL.findAll(html).map { it.value.lowercase() }) {
        val host = address.substringAfter('@')
        if (host !in ALLOWED_EMAIL_HOSTS) problems += "email"
    }
    for (code in FIXTURE_CLASS.findAll(html).map { it.value }) {
        if (code !in ALLOWED_CLASS_CODES) problems += "class"
    }
    for (raw in Regex("""var\s+lehrerliste\s*=\s*(\[.*?]);""").findAll(html).map { it.groupValues[1] }) {
        val entries = Regex("""\{""").findAll(raw).count()
        if (entries > 20) problems += "lehrerliste"
    }
    return problems.distinct()
}
