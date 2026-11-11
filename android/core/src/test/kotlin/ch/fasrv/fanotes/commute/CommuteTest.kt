package ch.fasrv.fanotes.commute

import ch.fasrv.fanotes.schulnetz.AgendaEvent
import ch.fasrv.fanotes.schulnetz.HiddenLesson
import ch.fasrv.fanotes.schulnetz.NotifySettings
import ch.fasrv.fanotes.schulnetz.SchulnetzChange
import ch.fasrv.fanotes.schulnetz.alertAllowed
import ch.fasrv.fanotes.schulnetz.aligned
import ch.fasrv.fanotes.schulnetz.notifyAlertKind
import ch.fasrv.fanotes.schulnetz.notifySettingsFromStored
import ch.fasrv.fanotes.schulnetz.routeNotify
import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import ch.fasrv.fanotes.schulnetz.notifyLinkOf
import ch.fasrv.fanotes.schulnetz.storedFields
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CommuteTest {
    private fun board(): BoardAnswer =
        parseBoardAnswer(javaClass.getResource("/commute/board.json")!!.readText())!!

    @Test
    fun boardAnswerIsReadWithEveryField() {
        val answer = board()
        assertEquals("search.ch", answer.provider.name)
        assertFalse(answer.provider.formation)
        val b = answer.boards.single()
        assertEquals("a1b2c3d4e5f6", b.routeId)
        assertEquals("firstLesson", b.target.kind)
        assertEquals("arrive", b.target.timeType)
        assertEquals(LessonChange.NONE, b.target.lessonChange)
        assertNull(b.target.plannedAt)
        val trip = b.trips.single()
        assertTrue(trip.quietest)
        assertEquals(TripStatus.DELAYED, trip.status)
        assertEquals(2, trip.arrDelay)
        assertEquals(1, trip.transfers)
        assertEquals(44, trip.minutes)
        assertEquals(3, trip.legs.size)
        val bus = trip.legs[0]
        assertEquals("371", bus.line)
        assertEquals(StopType.BUS, bus.type)
        assertEquals("039", bus.bgColor)
        assertEquals("Testdorf, Dorfplatz", bus.from.name)
        val walk = trip.legs[1]
        assertTrue(walk.walk)
        val train = trip.legs[2]
        assertEquals("S29", train.line)
        assertTrue(train.from.platformChanged)
        assertEquals("5", train.from.platform)
        assertEquals(1, train.occupancy.first)
        assertEquals(2, train.occupancy.second)
        assertEquals(Occupancy(1, 2), trip.occupancy)
        assertEquals(1, trip.changes.size)
        assertEquals("Knoten", trip.changes[0].at)
        assertTrue(trip.issues.any { it.kind == "platformChange" })
        assertEquals(1, b.alternatives.size)
        assertEquals("07:35", isoClock(b.alternatives[0].plannedDeparture))
        assertEquals("07:42", isoClock(b.alternatives[0].departure))
    }

    @Test
    fun parsingIsLenient() {
        assertNull(parseBoardAnswer("not json"))
        assertNull(parseCommuteState("[]"))
        val empty = parseCommuteState("{}")!!
        assertEquals(emptyList(), empty.routes)
        assertEquals(3, empty.settings.delayThreshold)
        val odd = parseBoardAnswer("""{"boards":[{"routeId":"x","trips":[{"status":"weird","legs":[{"type":"hovercraft","occupancy":{"first":9,"second":"2"}}]}],"future":1}]}""")!!
        val trip = odd.boards.single().trips.single()
        assertEquals(TripStatus.OK, trip.status)
        assertEquals(StopType.OTHER, trip.legs.single().type)
        assertEquals(Occupancy(null, null), trip.legs.single().occupancy)
        assertNull(trip.depDelay)
        val state = parseCommuteState("""{"routes":[{"name":"no id"},{"id":"abc","from":{"name":"A"},"schedule":{"mode":"sometimes","times":["07:05","7:5"],"bufferMinutes":999}}]}""")!!
        val route = state.routes.single()
        assertEquals("abc", route.id)
        assertEquals(ScheduleMode.NONE, route.schedule.mode)
        assertEquals(listOf("07:05"), route.schedule.times)
        assertEquals(MAX_BUFFER_MINUTES, route.schedule.bufferMinutes)
        assertEquals(DEFAULT_DAYS, route.schedule.days)
        assertTrue(route.notify)
        assertNull(route.delayThreshold)
    }

    @Test
    fun stopsAndTripsListsAreRead() {
        val stops = parseStops("""{"stops":[{"id":"9000001","name":"Testdorf, Dorfplatz","type":"bus"},{"id":"9000004","name":"Schulstadt","type":"train"},{"id":"","name":""}]}""")
        assertEquals(listOf("Testdorf, Dorfplatz", "Schulstadt"), stops.map { it.name })
        assertEquals(StopType.TRAIN, stops[1].type)
        assertEquals(1, parseTrips(javaClass.getResource("/commute/board.json")!!.readText().let { """{"trips":[{"id":"t1"}]}""" }).size)
    }

    @Test
    fun routesRoundTripThroughTheRequestBody() {
        val route = Route(
            id = "a1b2c3d4e5f6", name = "Schule \"früh\"",
            from = Stop("9000001", "Testdorf, Dorfplatz", StopType.BUS), to = Stop("9000004", "Schulstadt", StopType.TRAIN),
            vias = listOf(Stop("9000003", "Knoten", StopType.TRAIN), Stop("9000005", "Zwischen", StopType.BUS)),
            pins = listOf(Pin(listOf(1, 2, 3), "IR 16", "1234", "Testdorf", "9000001", "07:12", "07:41", 1)),
            schedule = Schedule(ScheduleMode.FIRST_LESSON, emptyList(), listOf(1, 2, 3), 15), delayThreshold = 5, notify = false,
        )
        val settings = CommuteSettings(5, listOf("informatik"))
        val parsed = parseCommuteState(commuteBody(listOf(route), settings))!!
        assertEquals(listOf(route), parsed.routes)
        assertEquals(settings, parsed.settings)
        // Both `vias` and the first `via` (older servers) go out.
        val body = commuteBody(listOf(route), settings)
        assertTrue(body.contains("\"vias\":[{"))
        assertTrue(body.contains("\"via\":{\"id\":\"9000003\""))
        assertTrue(body.contains("\"pins\":[{\"days\":[1,2,3],\"line\":\"IR 16\""))
        assertEquals("Knoten", route.via?.name)
        val plain = route.copy(vias = emptyList(), pins = emptyList(), delayThreshold = null)
        assertEquals(plain, parseCommuteState(commuteBody(listOf(plain), settings))!!.routes.single())
    }

    @Test
    fun delayColourClasses() {
        assertEquals(DelayClass.ON_TIME, delayClass(null))
        assertEquals(DelayClass.ON_TIME, delayClass(0))
        assertEquals(DelayClass.ON_TIME, delayClass(-1))
        assertEquals(DelayClass.MINOR, delayClass(1))
        assertEquals(DelayClass.MODERATE, delayClass(2))
        assertEquals(DelayClass.MODERATE, delayClass(4))
        assertEquals(DelayClass.MAJOR, delayClass(5))
        assertEquals(DelayClass.MAJOR, delayClass(6))
        assertEquals(DelayClass.MAJOR, delayClass(40))
        assertEquals(DelayClass.CANCELLED, delayClass(0, cancelled = true))
        assertEquals("+4", delayText(4))
        assertEquals("", delayText(0))
        assertEquals(DelayClass.CANCELLED, tripDelayClass(Trip(status = TripStatus.BROKEN)))
        assertEquals(DelayClass.MODERATE, tripDelayClass(Trip(depDelay = 4, status = TripStatus.DELAYED)))
        assertEquals(DelayClass.MINOR, tripDelayClass(Trip(arrDelay = 1)))
    }

    @Test
    fun minutesUntilFloorsAndGoesNegative() {
        val now = isoMillis("2026-11-13T07:00:30+01:00")!!
        assertEquals(4, minutesUntil("2026-11-13T07:05:00+01:00", now))
        assertEquals(0, minutesUntil("2026-11-13T07:00:59+01:00", now))
        assertEquals(-1, minutesUntil("2026-11-13T06:59:40+01:00", now))
        assertNull(minutesUntil("", now))
        assertEquals("07:05", isoClock("2026-11-13T06:05:00Z"))
    }

    private fun route(id: String, mode: ScheduleMode) = Route(id, id, Stop("1", "A"), Stop("2", "B"), schedule = Schedule(mode))
    private fun boardFor(id: String, departure: String?) = RouteBoard(routeId = id, trips = if (departure == null) emptyList() else listOf(Trip(id = "t-$id", departure = departure)))

    @Test
    fun relevantRouteFollowsTheTimeOfDay() {
        val routes = listOf(route("home", ScheduleMode.LAST_LESSON), route("school", ScheduleMode.FIRST_LESSON), route("free", ScheduleMode.TIMES))
        val boards = listOf(
            boardFor("home", "2026-11-13T15:20:00+01:00"),
            boardFor("school", "2026-11-13T07:05:00+01:00"),
            boardFor("free", "2026-11-13T09:00:00+01:00"),
        )
        val morning = isoMillis("2026-11-13T06:30:00+01:00")!!
        assertEquals("school", relevantBoard(routes, boards, morning)?.routeId)
        val afternoon = isoMillis("2026-11-13T14:00:00+01:00")!!
        assertEquals("home", relevantBoard(routes, boards, afternoon)?.routeId)
        // Late evening: the last-lesson trip of today is over, tomorrow's is far away; the soonest wins.
        val evening = isoMillis("2026-11-13T20:00:00+01:00")!!
        val next = listOf(boardFor("home", "2026-11-14T15:20:00+01:00"), boardFor("school", "2026-11-14T07:05:00+01:00"), boardFor("free", "2026-11-13T21:00:00+01:00"))
        assertEquals("free", relevantBoard(routes, next, evening)?.routeId)
        // Morning but the school route has nothing: fall back to the soonest one.
        val noSchool = listOf(boardFor("home", "2026-11-13T15:20:00+01:00"), boardFor("school", null), boardFor("free", "2026-11-13T09:00:00+01:00"))
        assertEquals("free", relevantBoard(routes, noSchool, morning)?.routeId)
        assertEquals("school", relevantBoard(routes, listOf(boardFor("school", null)), morning)?.routeId)
        assertNull(relevantBoard(routes, emptyList(), morning))
        assertNull(relevantBoard(emptyList(), boards, morning))
        // A board of a deleted route is ignored.
        assertEquals("free", relevantBoard(listOf(route("free", ScheduleMode.NONE)), boards, morning)?.routeId)
    }

    @Test
    fun refreshTimerOnlyRunsNearADeparture() {
        val now = isoMillis("2026-11-13T07:00:00+01:00")!!
        assertTrue(departsWithin(boardFor("a", "2026-11-13T07:25:00+01:00"), now))
        assertFalse(departsWithin(boardFor("a", "2026-11-13T07:31:00+01:00"), now))
        assertTrue(departsWithin(boardFor("a", "2026-11-13T06:57:00+01:00"), now))
        assertFalse(departsWithin(boardFor("a", "2026-11-13T06:50:00+01:00"), now))
        assertFalse(departsWithin(boardFor("a", null), now))
        assertFalse(departsWithin(null, now))
        assertTrue(boardOlderThan("2026-11-13T06:59:00+01:00", now))
        assertFalse(boardOlderThan("2026-11-13T06:59:45+01:00", now))
        assertTrue(boardOlderThan("", now))
    }

    private fun lesson(id: String, label: String, start: String, end: String = start.replace(Regex("""T(\d\d):(\d\d)"""), "T$1:59")) =
        AgendaEvent(id, start, end, label, "", "T01", emptyList(), "", label, "confirmed", "lesson", "", "")

    @Test
    fun hiddenLabelsComeFromHideRules() {
        val zone = ZoneId.of("Europe/Zurich")
        val events = listOf(
            lesson("a1", "Physik", "2026-11-02T08:15:00"), lesson("a2", "Physik", "2026-11-04T08:15:00"),
            lesson("b1", "Informatik", "2026-11-02T08:15:00"), lesson("b2", "Informatik", "2026-11-04T08:15:00"),
            lesson("m1", "Mathe", "2026-11-02T10:10:00"), lesson("m2", "Mathe", "2026-11-04T10:10:00"),
            lesson("z1", "Zeichnen", "2026-11-03T13:30:00"), lesson("z2", "Zeichnen", "2026-11-10T13:30:00"),
        )
        assertEquals(emptyList(), commuteHiddenLabels(events, emptyList(), zone))
        val info = HiddenLesson("series:informatik|1|08:15", "series", "b1", "", "Informatik", 1, "08:15")
        val info2 = HiddenLesson("series:informatik|3|08:15", "series", "b2", "", "Informatik", 3, "08:15")
        val rules = listOf(info, info2)
        assertEquals(listOf("informatik"), commuteHiddenLabels(events, rules, zone))
        // Mathe is hidden on Mondays only: Wednesday's lesson still counts, so it is not listed.
        val monday = HiddenLesson("series:mathe|1|10:10", "series", "m1", "", "Mathe", 1, "10:10")
        assertEquals(listOf("informatik"), commuteHiddenLabels(events, rules + monday, zone))
        // Zeichnen has one slot a week; hiding that slot hides the subject.
        val zeichnen = HiddenLesson("series:zeichnen|2|13:30", "series", "z1", "", "Zeichnen", 2, "13:30")
        assertEquals(listOf("informatik", "zeichnen"), commuteHiddenLabels(events, rules + zeichnen, zone))
        // A single hidden lesson of a series with more lessons hides nothing.
        val once = HiddenLesson("once:z1:2026-11-03", "once", "z1", "2026-11-03", "Zeichnen", 2, "13:30")
        assertEquals(listOf("informatik"), commuteHiddenLabels(events, rules + once, zone))
        assertTrue(hiddenLabelsChanged(listOf("a"), listOf("a", "b")))
        assertFalse(hiddenLabelsChanged(listOf("B", "a"), listOf("a", "b")))
    }

    @Test
    fun commuteAlertSwitchesSyncLikeTheOthers() {
        val defaults = NotifySettings()
        assertTrue(defaults.commute && defaults.commuteDelay && defaults.commuteCancelled && defaults.commuteLessonEnd)
        // The stored map round-trips, false included.
        val custom = NotifySettings(commute = true, commuteDelay = false, commuteCancelled = true, commuteLessonEnd = false)
        assertEquals(custom, notifySettingsFromStored(custom.storedFields()))
        assertTrue(custom.storedFields().keys.containsAll(listOf("commute", "commuteDelay", "commuteCancelled", "commuteLessonEnd")))
        // A server that sends only the parent switch turns the fine ones the same way.
        val parentOff = notifySettingsFromStored(mapOf("commute" to false))
        assertFalse(parentOff.commute || parentOff.commuteDelay || parentOff.commuteCancelled || parentOff.commuteLessonEnd)
        // A server without commute keys: everything on.
        assertTrue(notifySettingsFromStored(emptyMap()).commuteDelay)
        // The parent follows the fine switches.
        assertFalse(NotifySettings(commuteDelay = false, commuteCancelled = false, commuteLessonEnd = false).aligned().commute)
        assertTrue(NotifySettings(commuteDelay = false, commuteLessonEnd = true).aligned().commute)
    }

    private fun alert(title: String) = SchulnetzChange("commute:r1:$title", "commute", title, "07:05 Bus 371 ab Testdorf, Dorfplatz", "commute", "a1b2c3d4e5f6", date = "2026-11-13")

    @Test
    fun commuteAlertsFollowTheirSwitches() {
        assertEquals("commute-delay", notifyAlertKind(alert("Verspätung")))
        assertEquals("commute-delay", notifyAlertKind(alert("Gleisänderung")))
        assertEquals("commute-cancelled", notifyAlertKind(alert("Fällt aus")))
        assertEquals("commute-cancelled", notifyAlertKind(alert("Anschluss verpasst")))
        assertEquals("commute-lesson", notifyAlertKind(alert("Früher nach Hause")))
        assertEquals("commute-lesson", notifyAlertKind(alert("Später zur Schule")))
        val all = NotifySettings()
        assertTrue(listOf("Verspätung", "Fällt aus", "Früher nach Hause").all { alertAllowed(all, alert(it)) })
        assertFalse(alertAllowed(all.copy(commuteDelay = false), alert("Verspätung")))
        assertTrue(alertAllowed(all.copy(commuteDelay = false), alert("Fällt aus")))
        assertFalse(alertAllowed(all.copy(commuteCancelled = false), alert("Anschluss verpasst")))
        assertFalse(alertAllowed(all.copy(commuteLessonEnd = false), alert("Später zur Schule")))
        assertFalse(alertAllowed(all.copy(commute = false), alert("Verspätung")))
        // The school-updates master does not silence commute alerts, and commute switches do not touch school alerts.
        assertTrue(alertAllowed(all.copy(enabled = false), alert("Verspätung")))
        assertFalse(alertAllowed(all.copy(enabled = false), SchulnetzChange("g", "grade", "Neue Note", "")))
        assertTrue(alertAllowed(all.copy(commute = false), SchulnetzChange("g", "grade", "Neue Note", "")))
    }

    @Test
    fun commuteNoticeOpensTheRoute() {
        val link = notifyLinkOf(alert("Verspätung"))
        assertEquals("commute", link.kind)
        val route = routeNotify(link, SchulnetzSnapshot())
        assertEquals("Pendeln", route.section)
        assertEquals(listOf("a1b2c3d4e5f6"), route.highlightIds)
    }

    @Test
    fun routeHelpers() {
        assertEquals(12, newRouteId().length)
        assertTrue(newRouteId().all { it in "0123456789abcdef" })
        assertTrue(newRouteId() != newRouteId())
        val base = Route("x", "", Stop("1", "Testdorf, Dorfplatz"), Stop("2", "Schulstadt"))
        assertEquals("Testdorf, Dorfplatz → Schulstadt", routeTitle(base))
        assertEquals("Schule", routeTitle(base.copy(name = " Schule ")))
        assertTrue(routeSavable(base))
        assertFalse(routeSavable(base.copy(to = Stop())))
        assertFalse(routeSavable(base.copy(to = base.from)))
        assertFalse(routeSavable(base.copy(schedule = Schedule(ScheduleMode.TIMES))))
        assertTrue(routeSavable(base.copy(schedule = Schedule(ScheduleMode.TIMES, listOf("07:05")))))
        assertFalse(routeSavable(base.copy(schedule = Schedule(ScheduleMode.FIRST_LESSON, days = emptyList()))))
        assertEquals(listOf("07:05", "12:40"), normalizedTimes(listOf("12:40", "07:05", "07:05", "7:5")))
        assertEquals(listOf(1, 3, 2), movedItem(listOf(1, 2, 3), 1, 2))
        assertEquals(listOf(2, 1, 3), movedItem(listOf(1, 2, 3), 1, 0))
        assertEquals(listOf(1, 2, 3), movedItem(listOf(1, 2, 3), 1, 5))
        assertEquals(OccupancyLevel.HIGH, occupancyLevel(3))
        assertNull(occupancyLevel(null))
        assertEquals(2, Occupancy(1, 2).worst())
        assertNotNull(board().boards.single().trips.single().firstRide())
    }
}
