package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import java.time.LocalDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MensaTest {
    private val body = """{"fetchedAt":"2026-11-10T07:00:00.000Z","stale":false,"day":null,"days":[
        {"date":"2026-11-10","weekday":"Di","closed":false,"note":"","menus":[
          {"name":"Pouletgeschnetzeltes ( CH )","description":"Teigwaren","label":"Daily","price":13.5,"studentPrice":10.5},
          {"name":"Risotto","description":"","label":"Vegi","price":12.5,"studentPrice":null},{"name":""}]},
        {"date":"2026-11-13","weekday":"Fr","closed":true,"note":"Ferien","menus":[]},
        {"date":"bad"}, 7]}"""

    @Test
    fun parsesTheServerBodyAndSkipsOddParts() {
        val feed = assertNotNull(parseMensaFeed(body))
        assertEquals(2, feed.days.size)
        val menus = feed.days[0].menus
        assertEquals(2, menus.size)
        assertEquals(MensaMenu("Pouletgeschnetzeltes ( CH )", "Teigwaren", "Daily", 13.5, 10.5), menus[0])
        assertNull(menus[1].studentPrice)
        assertTrue(feed.days[1].closed)
        assertEquals("Ferien", feed.days[1].note)
        assertFalse(feed.stale)
    }

    @Test
    fun garbageIsNotAFeed() {
        assertNull(parseMensaFeed("nope"))
        assertNull(parseMensaFeed("""{"days":"x"}"""))
        assertEquals(0, parseMensaFeed("""{"days":[]}""")!!.days.size)
    }

    @Test
    fun picksTodayThenTheNextSchoolDay() {
        val days = parseMensaFeed(body)!!.days + MensaDay(LocalDate.parse("2026-11-16"), false, "", emptyList())
        assertEquals("2026-11-10", pickMensaDay(days, LocalDateTime.parse("2026-11-10T09:00"))?.date.toString())
        assertNull(pickMensaDay(days, LocalDateTime.parse("2026-11-10T15:00")))
        assertEquals("2026-11-16", pickMensaDay(days, LocalDateTime.parse("2026-11-13T15:00"))?.date.toString())
        assertEquals("2026-11-16", pickMensaDay(days, LocalDateTime.parse("2026-11-15T10:00"))?.date.toString())
    }

    @Test
    fun priceFormattingAndRefreshWindow() {
        assertEquals("10.50", mensaPrice(10.5))
        assertTrue(mensaRefreshDue(0, 1000))
        assertFalse(mensaRefreshDue(1_000_000, 1_000_000 + 3_600_000))
        assertTrue(mensaRefreshDue(1_000_000, 1_000_000 + 4 * 3_600_000))
    }
}
