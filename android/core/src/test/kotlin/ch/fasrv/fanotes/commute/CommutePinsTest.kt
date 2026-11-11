package ch.fasrv.fanotes.commute

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CommutePinsTest {
    private fun at(clock: String) = "2026-11-16T$clock:00+01:00"
    private val pin = Pin(listOf(1, 2, 3, 4, 5), "IR 16", "1234", "Aarau", "8502113", "07:12", "07:41", 1)
    private val words = PinWords("ab", "an") { if (it <= 0) "direkt" else "$it Umstieg" }

    private fun trip(id: String, dep: String, status: TripStatus = TripStatus.OK, pinned: Boolean = true, plannedLegClock: String = dep) = Trip(
        id = id, departure = at(dep), plannedDeparture = at(dep), arrival = at("07:41"), plannedArrival = at("07:41"), status = status,
        legs = listOf(Leg(line = "IR 16", from = Point("Aarau", "8502113", at(dep), at(plannedLegClock)))),
        pin = if (pinned) pin.copy(days = emptyList(), departure = dep) else null,
    )

    private fun route(vias: List<Stop> = emptyList()) = Route("r1", from = Stop("1", "A"), to = Stop("2", "B"), vias = vias)

    // ── JSON ────────────────────────────────────────────────────────────────

    @Test
    fun viasPinsAndTripPinAreRead() {
        val state = parseCommuteState(
            """{"routes":[{"id":"r1","name":"S","from":{"id":"1","name":"A","type":"bus"},"to":{"id":"2","name":"B","type":"train"},
              "vias":[{"id":"3","name":"V1","type":"train"},{"id":"4","name":"V2","type":"bus"},{"id":"5","name":"V3","type":"bus"}],
              "via":{"id":"3","name":"V1","type":"train"},"schedule":{"mode":"none"},
              "pins":[{"days":[1,3,9],"line":"IR 16","trainNo":"1234","stop":"Aarau","stopId":"8502113","departure":"07:12","arrival":"07:41","transfers":1},{"days":[2],"departure":"bad"}]}]}""",
        )!!
        val route = state.routes.single()
        assertEquals(listOf("V1", "V2"), route.vias.map { it.name })
        assertEquals("V1", route.via?.name)
        assertEquals(listOf(Pin(listOf(1, 3), "IR 16", "1234", "Aarau", "8502113", "07:12", "07:41", 1)), route.pins)
    }

    @Test
    fun anOlderServerWithOnlyViaStillGivesOneVia() {
        val state = parseCommuteState("""{"routes":[{"id":"r1","from":{"name":"A"},"to":{"name":"B"},"via":{"id":"3","name":"Knoten","type":"train"}}]}""")!!
        assertEquals(listOf("Knoten"), state.routes.single().vias.map { it.name })
        assertTrue(state.routes.single().pins.isEmpty())
        val none = parseCommuteState("""{"routes":[{"id":"r1","via":null}]}""")!!
        assertTrue(none.routes.single().vias.isEmpty())
        // An empty `vias` wins over a stale `via`.
        val empty = parseCommuteState("""{"routes":[{"id":"r1","vias":[],"via":{"name":"X"}}]}""")!!
        assertTrue(empty.routes.single().vias.isEmpty())
    }

    @Test
    fun boardWithPinnedStateAndChangeIsReadAndOldBoardsStillParse() {
        val answer = parseBoardAnswer(
            """{"boards":[{"routeId":"r1","target":{"kind":"pinned","at":"${at("07:12")}","timeType":"depart","lessonChange":"lastCancelled","pin":{"days":[1],"departure":"07:12","line":"IR 16"},"day":"2026-11-16","changeAt":"${at("14:00")}","changeTimeType":"depart"},
              "trips":[{"id":"t1","pin":{"line":"IR 16","departure":"07:12","stop":"Aarau"}}],"alternatives":[],
              "pinned":{"status":"moved","day":"2026-11-16","pin":{"days":[1],"line":"IR 16","departure":"07:12"},"trip":{"id":"t1"},"nearest":null},
              "change":{"id":"c1"},"updatedAt":"${at("06:00")}","stale":false},
              {"routeId":"r2","target":{"kind":"now"},"trips":[]}]}""",
        )!!
        val board = answer.boards[0]
        assertEquals("pinned", board.target.kind)
        assertEquals("2026-11-16", board.target.day)
        assertEquals("07:12", board.target.pin?.departure)
        assertEquals(at("14:00"), board.target.changeAt)
        assertEquals(PinStatus.MOVED, board.pinned?.status)
        assertEquals("t1", board.pinned?.trip?.id)
        assertEquals("c1", board.change?.id)
        assertEquals("Aarau", board.trips.single().pin?.stop)
        val old = answer.boards[1]
        assertNull(old.pinned); assertNull(old.change); assertNull(old.target.pin)
        assertEquals(PinStatus.OK, PinStatus.of("unknown"))
    }

    // ── Picker helpers ──────────────────────────────────────────────────────

    @Test
    fun pickerStartsFromTheSchedule() {
        assertEquals("05:55", defaultPickerTime(Schedule(ScheduleMode.TIMES, listOf("07:05", "05:55"))))
        assertEquals("06:30", defaultPickerTime(Schedule(ScheduleMode.FIRST_LESSON)))
        assertEquals("12:00", defaultPickerTime(Schedule(ScheduleMode.LAST_LESSON)))
        assertEquals("06:30", defaultPickerTime(Schedule(ScheduleMode.NONE)))
        assertEquals("06:30", defaultPickerTime(Schedule(ScheduleMode.TIMES, emptyList())))
    }

    @Test
    fun nextDateWithWeekdayCountsTodayAndWrapsTheWeek() {
        val wednesday = LocalDate.parse("2026-11-11")
        assertEquals(LocalDate.parse("2026-11-11"), nextDateWithWeekday(wednesday, 3))
        assertEquals(LocalDate.parse("2026-11-16"), nextDateWithWeekday(wednesday, 1))
        assertEquals(LocalDate.parse("2026-11-15"), nextDateWithWeekday(wednesday, 7))
    }

    @Test
    fun pickerTimesCarryTheOffsetOfThatDate() {
        assertEquals("2026-11-16T06:30:00+01:00", pickerAtIso(LocalDate.parse("2026-11-16"), "06:30"))
        assertEquals("2026-07-13T06:30:00+02:00", pickerAtIso(LocalDate.parse("2026-07-13"), "06:30"))
    }

    @Test
    fun pagingUsesTheEdgesOfTheShownTrips() {
        val trips = listOf(trip("a", "07:12"), trip("b", "07:30"), trip("c", "07:50"))
        assertEquals("2026-11-16T07:51:00+01:00", pickerPageAt(trips, later = true))
        assertEquals("2026-11-16T06:12:00+01:00", pickerPageAt(trips, later = false))
        assertNull(pickerPageAt(emptyList(), later = true))
    }

    @Test
    fun connectionsPathUsesIdsThenNamesAndAllVias() {
        val path = connectionsPath(Stop("1", "A B"), Stop("", "Ziel"), listOf(Stop("3", "V1"), Stop("", "V 2"), Stop("5", "V3")), "2026-11-16T06:30:00+01:00")
        assertEquals("/commute/connections?from=1&to=Ziel&via=3&via=V+2&at=2026-11-16T06%3A30%3A00%2B01%3A00&timeType=depart", path)
    }

    // ── Pin editing ─────────────────────────────────────────────────────────

    @Test
    fun aWeekdayBelongsToOnePin() {
        val monday = pin.copy(days = listOf(1, 2, 3, 4, 5))
        val wed = pin.copy(days = listOf(3), departure = "07:30")
        val pins = withPin(listOf(monday), wed)
        assertEquals(listOf(listOf(1, 2, 4, 5), listOf(3)), pins.map { it.days })
        assertEquals("07:30", pinForWeekday(pins, 3)?.departure)
        assertEquals(listOf(1, 2, 4, 5), withoutPinDay(pins, 3).single().days)
        // A pin that loses every day disappears.
        assertEquals(listOf(wed), withPin(listOf(pin.copy(days = listOf(3))), wed))
        assertEquals(PinMode.PER_DAY, pinModeOf(pins))
        assertEquals(PinMode.DAILY, pinModeOf(listOf(monday)))
        assertEquals(PinMode.NONE, pinModeOf(emptyList()))
        assertEquals(PinMode.PER_DAY, pinModeOf(listOf(wed)))
    }

    @Test
    fun pinFromTripNeedsAPinAndDays() {
        val t = trip("a", "07:12")
        assertEquals(listOf(2, 4), pinFromTrip(t, listOf(4, 2, 4, 9))?.days)
        assertEquals("07:12", pinFromTrip(t, listOf(1))?.departure)
        assertNull(pinFromTrip(t, emptyList()))
        assertNull(pinFromTrip(trip("w", "07:12", pinned = false), listOf(1)))
        assertEquals(DEFAULT_DAYS, dailyPinDays(Schedule(days = emptyList())))
        assertEquals(listOf(1, 3), dailyPinDays(Schedule(days = listOf(3, 1))))
    }

    @Test
    fun viasKeepTheirOrderAndStopAtTwo() {
        val a = Stop("3", "V1"); val b = Stop("4", "V2"); val c = Stop("5", "V3")
        var r = route()
        r = withViaAt(r, 0, a); r = withViaAt(r, 1, b)
        assertEquals(listOf(a, b), r.vias)
        assertEquals(listOf(a, b), withViaAt(r, 2, c).vias)
        assertEquals(listOf(b), withViaAt(r, 0, null).vias)
        assertEquals(listOf(c, b), withViaAt(r, 0, c).vias)
        assertEquals(emptyList(), withViaAt(route(), 1, a).vias)
    }

    @Test
    fun changingTheJourneyClearsThePins() {
        val pinned = route().copy(pins = listOf(pin))
        assertEquals(listOf(pin), withPinsKeptOnlyIfJourneySame(pinned, pinned.copy(name = "x", notify = false)).pins)
        assertTrue(withPinsKeptOnlyIfJourneySame(pinned, pinned.copy(to = Stop("9", "C"))).pins.isEmpty())
        assertTrue(withPinsKeptOnlyIfJourneySame(pinned, pinned.copy(vias = listOf(Stop("3", "V1")))).pins.isEmpty())
        assertTrue(withPinsKeptOnlyIfJourneySame(pinned, pinned.copy(from = Stop())).pins.isEmpty())
    }

    @Test
    fun pinSummaryReadsLikeTheTimetable() {
        assertEquals("07:12 IR 16 ab Aarau · an 07:41 · 1 Umstieg", pinSummary(pin, words))
        assertEquals("07:12 IR 16 ab Aarau · an 07:41 · direkt", pinSummary(pin.copy(transfers = 0), words))
        assertEquals("07:12 · an 07:41 · direkt", pinSummary(pin.copy(line = "", stop = "", transfers = 0), words))
        assertEquals("07:12 366", pinSummary(Pin(departure = "07:12", line = "366"), PinWords("ab", "an") { "" }))
    }

    // ── What a board focuses on ─────────────────────────────────────────────

    private fun pinned(status: PinStatus, trip: Trip?, nearest: Trip? = null) = PinnedState(status, "2026-11-16", pin, trip, nearest)

    @Test
    fun aPlainBoardKeepsItsFirstTripAndAlternatives() {
        val broken = trip("a", "07:12", TripStatus.CANCELLED)
        val alt = trip("alt", "07:30")
        val focus = boardFocus(RouteBoard("r1", trips = listOf(broken, trip("b", "07:30")), alternatives = listOf(alt)))
        assertEquals(FocusKind.PLAIN, focus.kind)
        assertEquals("a", focus.main?.id)
        assertEquals(listOf(alt), focus.alternatives)
        assertEquals(listOf("b"), focus.others.map { it.id })
        assertEquals(FocusKind.PLAIN, boardFocus(RouteBoard("r1")).kind)
        assertNull(boardFocus(RouteBoard("r1")).main)
        assertTrue(boardFocus(RouteBoard("r1", trips = listOf(trip("a", "07:12")), alternatives = listOf(alt))).alternatives.isEmpty())
    }

    @Test
    fun aPinnedTripIsTheFocusAndTheRestMovesBehindTheExpander() {
        val p = trip("p", "07:12"); val other = trip("o", "07:30")
        val focus = boardFocus(RouteBoard("r1", trips = listOf(p, other), pinned = pinned(PinStatus.OK, p)))
        assertEquals(FocusKind.PINNED, focus.kind)
        assertEquals("p", focus.main?.id)
        assertEquals(listOf("o"), focus.others.map { it.id })
        assertEquals("2026-11-16", focus.day)
        assertEquals(pin, focus.pin)
    }

    @Test
    fun aMovedPinShowsTheNewTimeOfTheFirstRide() {
        val p = trip("p", "07:20", plannedLegClock = "07:17")
        val focus = boardFocus(RouteBoard("r1", trips = listOf(p), pinned = pinned(PinStatus.MOVED, p)))
        assertEquals(FocusKind.MOVED, focus.kind)
        assertEquals("07:17", focus.movedClock)
    }

    @Test
    fun aMissingPinOffersTheNearestTripAndKeepsTheOthers() {
        val near = trip("n", "07:20"); val other = trip("o", "07:50")
        val focus = boardFocus(RouteBoard("r1", trips = listOf(near, other), pinned = pinned(PinStatus.MISSING, null, near)))
        assertEquals(FocusKind.MISSING, focus.kind)
        assertNull(focus.main)
        assertEquals("n", focus.nearest?.id)
        assertEquals(listOf("o"), focus.others.map { it.id })
    }

    @Test
    fun aCancelledOrGonePinPutsTheAlternativesFirst() {
        val cancelled = trip("p", "07:12", TripStatus.CANCELLED); val alt = trip("alt", "07:30"); val other = trip("o", "07:50")
        val focus = boardFocus(RouteBoard("r1", trips = listOf(cancelled, alt, other), alternatives = listOf(alt), pinned = pinned(PinStatus.OK, cancelled)))
        assertEquals(FocusKind.UNUSABLE, focus.kind)
        assertEquals(listOf("alt"), focus.alternatives.map { it.id })
        assertEquals(listOf("o"), focus.others.map { it.id })
        val gone = boardFocus(RouteBoard("r1", trips = listOf(cancelled), alternatives = listOf(alt), pinned = pinned(PinStatus.GONE, cancelled)))
        assertEquals(FocusKind.UNUSABLE, gone.kind)
        // GONE without a cancelled status still counts as unusable.
        assertEquals(FocusKind.UNUSABLE, boardFocus(RouteBoard("r1", pinned = pinned(PinStatus.GONE, trip("p", "07:12")))).kind)
    }

    @Test
    fun aLessonChangeRidesAlongWithThePinnedFocus() {
        val p = trip("p", "13:12"); val early = trip("e", "12:30")
        val target = TripTarget(kind = "pinned", lessonChange = LessonChange.LAST_CANCELLED)
        val focus = boardFocus(RouteBoard("r1", target, trips = listOf(p), pinned = pinned(PinStatus.OK, p), change = early))
        assertEquals("e", focus.change?.id)
        assertEquals(LessonChange.LAST_CANCELLED, focus.changeKind)
        assertEquals(LessonChange.NONE, boardFocus(RouteBoard("r1", target, trips = listOf(p), pinned = pinned(PinStatus.OK, p))).changeKind)
    }

    @Test
    fun widgetRowsAndTimersFollowThePinnedTrip() {
        val p = trip("p", "07:12"); val other = trip("o", "07:01")
        val board = RouteBoard("r1", trips = listOf(other, p), pinned = pinned(PinStatus.OK, p))
        assertEquals(listOf("p"), commuteRows(board).map { it.tripId })
        assertEquals(p, board.headTrip())
        val missing = RouteBoard("r1", trips = listOf(other), pinned = pinned(PinStatus.MISSING, null, other))
        assertEquals(listOf(true), commuteRows(missing).map { it.alternative })
        val cancelled = trip("c", "07:12", TripStatus.CANCELLED); val alt = trip("alt", "07:40")
        assertEquals(listOf("c", "alt"), commuteRows(RouteBoard("r1", trips = listOf(cancelled), alternatives = listOf(alt), pinned = pinned(PinStatus.GONE, cancelled))).map { it.tripId })
        assertNotNull(board.pinned)
        assertFalse(board.pinned!!.trip == null)
    }

    @Test
    fun theMissingPinAlertFollowsTheCancelledSwitch() {
        val change = ch.fasrv.fanotes.schulnetz.SchulnetzChange("commute:r1:x", "commute", "Verbindung fehlt", "07:12 IR 16 ab Aarau", "commute", "r1", date = "2026-11-16")
        assertEquals("commute-cancelled", ch.fasrv.fanotes.schulnetz.notifyAlertKind(change))
    }
}
