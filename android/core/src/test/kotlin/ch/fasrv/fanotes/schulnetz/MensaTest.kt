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

    private fun day(date: String, closed: Boolean = false) = MensaDay(LocalDate.parse(date), closed, "", if (closed) emptyList() else listOf(MensaMenu("Dish", "", "Daily", 10.0, 8.0)))
    private val twoWeeks = listOf("2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20").map { day(it) }

    @Test
    fun weekSlotsCoverBothWeeksAndMarkNextWeek() {
        val slots = mensaWeekSlots(twoWeeks, LocalDate.parse("2026-11-11"))
        assertEquals(10, slots.size)
        assertEquals(LocalDate.parse("2026-11-09"), slots.first().date)
        assertEquals(5, slots.count { it.nextWeek })
        assertTrue(slots.all { it.day != null })
    }

    @Test
    fun missingNextWeekIsLeftOutAndMissingDaysStayAsEmptySlots() {
        val slots = mensaWeekSlots(listOf(day("2026-11-09"), day("2026-11-11")), LocalDate.parse("2026-11-11"))
        assertEquals(5, slots.size)
        assertTrue(slots.none { it.nextWeek })
        assertNull(slots[1].day)
        assertNotNull(slots[2].day)
    }

    @Test
    fun weekendKeepsTheFinishedWeekAndOldWeeksAreIgnored() {
        val slots = mensaWeekSlots(listOf(day("2026-11-02")) + twoWeeks, LocalDate.parse("2026-11-14"))
        assertEquals(LocalDate.parse("2026-11-09"), slots.first().date)
        assertEquals(10, slots.size)
    }

    @Test
    fun preselectsTodayOnAWeekdayMorning() {
        val slots = mensaWeekSlots(twoWeeks, LocalDate.parse("2026-11-11"))
        assertEquals(LocalDate.parse("2026-11-11"), mensaPreselectedDate(slots, LocalDateTime.parse("2026-11-11T09:30:00")))
    }

    @Test
    fun preselectsTheNextSchoolDayAfterServingTimeAndOnWeekends() {
        val slots = mensaWeekSlots(twoWeeks, LocalDate.parse("2026-11-13"))
        assertEquals(LocalDate.parse("2026-11-12"), mensaPreselectedDate(mensaWeekSlots(twoWeeks, LocalDate.parse("2026-11-11")), LocalDateTime.parse("2026-11-11T14:00:00")))
        assertEquals(LocalDate.parse("2026-11-16"), mensaPreselectedDate(slots, LocalDateTime.parse("2026-11-13T15:00:00")))
        assertEquals(LocalDate.parse("2026-11-16"), mensaPreselectedDate(mensaWeekSlots(twoWeeks, LocalDate.parse("2026-11-14")), LocalDateTime.parse("2026-11-14T10:00:00")))
        assertEquals(LocalDate.parse("2026-11-16"), mensaPreselectedDate(mensaWeekSlots(twoWeeks, LocalDate.parse("2026-11-15")), LocalDateTime.parse("2026-11-15T10:00:00")))
        assertEquals(pickMensaDay(twoWeeks, LocalDateTime.parse("2026-11-14T10:00:00"))?.date, LocalDate.parse("2026-11-16"))
    }

    @Test
    fun fallsBackWhenNextWeekIsMissing() {
        val thisWeek = twoWeeks.take(5)
        assertEquals(LocalDate.parse("2026-11-13"), mensaPreselectedDate(mensaWeekSlots(thisWeek, LocalDate.parse("2026-11-13")), LocalDateTime.parse("2026-11-13T15:00:00")))
        assertEquals(LocalDate.parse("2026-11-13"), mensaPreselectedDate(mensaWeekSlots(thisWeek, LocalDate.parse("2026-11-14")), LocalDateTime.parse("2026-11-14T10:00:00")))
        assertNull(mensaPreselectedDate(emptyList(), LocalDateTime.parse("2026-11-11T09:00:00")))
    }

    @Test
    fun aClosedDayIsStillASlotAndCanBePreselected() {
        val days = twoWeeks.map { if (it.date == LocalDate.parse("2026-11-11")) day("2026-11-11", closed = true) else it }
        val slots = mensaWeekSlots(days, LocalDate.parse("2026-11-11"))
        assertEquals(LocalDate.parse("2026-11-11"), mensaPreselectedDate(slots, LocalDateTime.parse("2026-11-11T08:00:00")))
        assertTrue(slots[2].day!!.closed)
    }
}
