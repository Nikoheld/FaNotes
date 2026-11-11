package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class KontoauszugTest {
    // Synthetic copy of the real structure: rows and cells are never closed.
    private val unclosed = """
        <h3>Test Klassenkasse</h3> <br/> <table border=0> <tr><td width=100>Name: <td>Muster <tr><td>Klasse: <td>1a </table> <br/><br/>
        <table border=0 cellpadding=4> <tr bgcolor="#eeeeee"> <td width=100><b>Datum</b> <td width=250><b>Text</b> <td width=100 align=right><b>Betrag</b> <td width=100 align=right><b>Saldo</b>
        <tr bgcolor="#d0d0d0"> <td>12.08.2026 <td>Some text <td align=right> <span class="redft"> -12.50 CHF </span> <td align=right> <span class="greenft"> 87.50 CHF </span>
        <tr bgcolor="#eeeeee"> <td>20.08.2026 <td>Other text <td align=right> <span class="greenft"> 100.00 CHF </span> <td align=right> <span class="greenft"> 187.50 CHF </span>
        <tr bgcolor="#eeeeee"> <td colspan=3><b>Saldo</b><td align=right><b>5.40 CHF</b> </table>
        <p> <br>Saldo der Klassenkasse <a href="javascript:decision('x')">bestätigen</a> </div>
    """.trimIndent()

    @Test
    fun parsesUnclosedRowsAndSaldo() {
        assertEquals(
            listOf(
                KontoLine("12.08.2026", "Some text", "-12.50 CHF", "87.50 CHF"),
                KontoLine("20.08.2026", "Other text", "100.00 CHF", "187.50 CHF"),
            ),
            parseKontoauszug(unclosed),
        )
        assertEquals("5.40 CHF", parseKontoSaldo(unclosed))
    }

    @Test
    fun closedMarkupStillWorks() {
        val html = "<table><tr><td>01.11.2026</td><td>Essen</td><td>-1.00</td><td>9.00</td></tr><tr><td colspan=\"3\">Saldo</td><td>9.00 CHF</td></tr></table>"
        assertEquals(1, parseKontoauszug(html).size)
        assertEquals("9.00 CHF", parseKontoSaldo(html))
        assertEquals("", parseKontoSaldo(""))
    }

    @Test
    fun snapshotJsonKeepsSaldoAndMissingKeyIsEmpty() {
        val snapshot = SchulnetzSnapshot(konto = parseKontoauszug(unclosed), kontoSaldo = "5.40 CHF")
        val back = parseNormalizedSnapshot(snapshot.toNormalizedJson())
        assertEquals("5.40 CHF", back?.kontoSaldo)
        assertEquals("", parseNormalizedSnapshot("{\"revision\":1}")?.kontoSaldo)
    }

    @Test
    fun parsesChfAmounts() {
        assertEquals(-12.5, parseChfAmount("-12.50 CHF"))
        assertEquals(1234.5, parseChfAmount("1'234.50 CHF"))
        assertEquals(12.5, parseChfAmount("12,50"))
        assertNull(parseChfAmount("n/a"))
    }

    @Test
    fun footerPicksSchulnetzThenRunningThenCalculated() {
        val lines = parseKontoauszug(unclosed)
        assertEquals(KontoFooter(KontoFooterKind.Schulnetz, "5.40 CHF"), kontoFooter(lines, "5.40 CHF"))
        assertEquals(KontoFooter(KontoFooterKind.RunningSaldo, "187.50 CHF"), kontoFooter(lines, ""))
        val bare = listOf(KontoLine("1.1.2026", "a", "-12.50 CHF", ""), KontoLine("2.1.2026", "b", "1'000.00", ""))
        assertEquals(KontoFooter(KontoFooterKind.Calculated, "987.50 CHF"), kontoFooter(bare, ""))
        assertNull(kontoFooter(emptyList(), ""))
    }
}
