package ch.fasrv.fanotes.commute

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Connection detail: parsing of `/commute/trip` and the pure row, position and transfer helpers. Synthetic data only. */
class CommuteDetailTest {
    private val day = "2026-11-13"
    private fun at(clock: String) = "${day}T$clock:00+01:00"

    private val body = """
    {"trip":{"id":"t1","departure":"${at("23:40")}","arrival":"${at("00:20").replace(day, "2026-11-14")}","plannedDeparture":"${at("23:40")}","plannedArrival":"2026-11-14T00:20:00+01:00",
      "depDelay":0,"arrDelay":2,"minutes":40,"transfers":1,"status":"delayed",
      "legs":[
        {"kind":"ride","line":"IR37","category":"IR","type":"train","operator":"SBB","direction":"Endstation","fgColor":"fff","bgColor":"e2001a",
         "from":{"name":"Start","stopId":"1","time":"${at("23:40")}","planned":"${at("23:40")}","delay":0,"platform":"3","platformChanged":false},
         "to":{"name":"Knoten","stopId":"9","time":"2026-11-14T00:02:00+01:00","planned":"2026-11-14T00:00:00+01:00","delay":2,"platform":"5","platformChanged":true},
         "journeyId":"j-1","stopCount":3,"minutes":22,
         "stops":[
          {"name":"Eins","stopId":"2","arrival":{"planned":"${at("23:45")}","time":"${at("23:45")}","delay":0},"departure":{"planned":"${at("23:46")}","time":"${at("23:46")}","delay":0},"platform":"","platformChanged":false,"realtime":true,"cancelled":false,"occupancy":{"first":1,"second":2}},
          {"name":"Muri AG","stopId":"3","arrival":{"planned":"${at("23:51")}","time":"${at("23:52")}","delay":1},"departure":{"planned":"${at("23:52")}","time":"${at("23:53")}","delay":1},"platform":"4","platformChanged":false,"realtime":true,"cancelled":false,"occupancy":{"first":null,"second":null}},
          {"name":"Drei","stopId":"4","arrival":{"planned":"${at("23:56")}","time":"${at("23:56")}","delay":null},"departure":null,"platform":"","platformChanged":false,"realtime":false,"cancelled":true}
         ]},
        {"kind":"walk","minutes":4,"from":{"name":"Knoten"},"to":{"name":"Knoten Bus"}},
        {"kind":"ride","line":"31","category":"B","type":"bus","direction":"Schule","from":{"name":"Knoten Bus","time":"2026-11-14T00:07:00+01:00","planned":"2026-11-14T00:07:00+01:00","delay":null},"to":{"name":"Schule","time":"2026-11-14T00:20:00+01:00","planned":"2026-11-14T00:18:00+01:00","delay":2},"stopCount":0,"minutes":13}
      ],
      "changes":[{"at":"Knoten","minutes":2,"plannedMinutes":7,"broken":false,"tight":true}]},
     "position":{"state":"between","legIndex":0,"point":1,"progress":0.4,"estimated":true},
     "updatedAt":"${at("23:48")}","stale":false,"gone":false,
     "sources":{"realtime":"search.ch","platforms":"transport.opendata.ch","formation":null}}
    """.trimIndent()

    private fun detail() = parseTripDetail(body)!!

    @Test fun detailIsReadWithStopsPositionAndSources() {
        val d = detail()
        val trip = d.trip!!
        val leg = trip.legs[0]
        assertEquals("j-1", leg.journeyId)
        assertEquals(3, leg.stopCount)
        assertEquals(3, leg.stops.size)
        assertEquals("Muri AG", leg.stops[1].name)
        assertEquals(1, leg.stops[1].arrival?.delay)
        assertNull(leg.stops[2].arrival?.delay)
        assertFalse(leg.stops[2].realtime)
        assertTrue(leg.stops[2].cancelled)
        assertNull(leg.stops[2].departure)
        assertEquals(2, leg.stops[0].occupancy.second)
        assertEquals(PositionState.BETWEEN, d.position?.state)
        assertEquals(0.4, d.position!!.progress)
        assertTrue(d.position!!.estimated)
        assertEquals("search.ch", d.sources.realtime)
        assertEquals("transport.opendata.ch", d.sources.platforms)
        assertNull(d.sources.formation)
        assertFalse(d.gone)
    }

    @Test fun olderServerWithoutStopsReadsAsEmptyAndCountZero() {
        val trip = parseTripDetail("""{"trip":{"id":"x","legs":[{"kind":"ride","line":"S1","from":{"name":"A"},"to":{"name":"B"}}]},"gone":false}""")!!.trip!!
        assertEquals(emptyList(), trip.legs[0].stops)
        assertEquals(0, trip.legs[0].stopCount)
        assertEquals("", trip.legs[0].journeyId)
        // The board answer (no stops key at all) parses the same way.
        val board = parseBoardAnswer(javaClass.getResource("/commute/board.json")!!.readText())!!
        assertTrue(board.boards.single().trips.single().legs.all { it.stops.isEmpty() })
    }

    @Test fun goneAndGarbageAnswers() {
        val gone = parseTripDetail("""{"trip":null,"position":null,"gone":true,"stale":true,"sources":{"realtime":"search.ch","platforms":null,"formation":null}}""")!!
        assertTrue(gone.gone); assertTrue(gone.stale); assertNull(gone.trip); assertNull(gone.position)
        assertTrue(parseTripDetail("""{"updatedAt":"x"}""")!!.gone)
        assertNull(parseTripDetail("not json"))
        assertNull(parseTripDetail("[]"))
        val odd = parseTripDetail("""{"trip":{"id":"x"},"position":{"state":"flying"}}""")!!
        assertNull(odd.position)
        assertEquals(1.0, parseTripDetail("""{"trip":{"id":"x"},"position":{"state":"between","progress":7}}""")!!.position!!.progress)
    }

    @Test fun pathEncodesTheTimeZoneSign() {
        assertEquals("/commute/trip?route=abc&trip=S29%7C07%3A05&at=2026-11-13T07%3A05%3A00%2B01%3A00", tripDetailPath("abc", "S29|07:05", "2026-11-13T07:05:00+01:00"))
    }

    @Test fun delayClassPerStopTimeReusesTheCommuteThresholds() {
        fun cls(delay: Int?) = stopDelayClass(StopTime("p", "t", delay))
        assertNull(cls(null))
        assertNull(stopDelayClass(null))
        assertEquals(DelayClass.ON_TIME, cls(0))
        assertEquals(DelayClass.ON_TIME, cls(-1))
        assertEquals(DelayClass.MINOR, cls(1))
        assertEquals(DelayClass.MINOR, cls(2))
        assertEquals(DelayClass.MODERATE, cls(3))
        assertEquals(DelayClass.MODERATE, cls(5))
        assertEquals(DelayClass.MAJOR, cls(6))
        assertEquals(DelayClass.CANCELLED, stopDelayClass(StopTime("p", "t", null), cancelled = true))
        for (d in listOf(0, 1, 2, 3, 5, 6, 30)) assertEquals(delayClass(d), cls(d))
    }

    @Test fun timeNeverInventsARealTimeWithoutDelayValue() {
        val none = timelineTime(StopTime(at("23:56"), at("23:57"), null))!!
        assertEquals("23:56", none.plannedClock)
        assertEquals("", none.realClock)
        assertEquals("23:56", none.shownClock)
        assertFalse(none.changed)
        assertNull(none.delayClass)
        val late = timelineTime(StopTime(at("23:51"), at("23:52"), 1))!!
        assertEquals("23:52", late.realClock)
        assertTrue(late.changed)
        assertEquals(DelayClass.MINOR, late.delayClass)
        assertNull(timelineTime(null))
    }

    @Test fun rowsRunFromBoardingThroughStopsToExit() {
        val leg = detail().trip!!.legs[0]
        val rows = legRows(leg)
        assertEquals(listOf(0, 1, 2, 3, 4), rows.map { it.point })
        assertEquals(listOf(RowRole.BOARD, RowRole.STOP, RowRole.STOP, RowRole.STOP, RowRole.EXIT), rows.map { it.role })
        assertEquals(listOf("Start", "Eins", "Muri AG", "Drei", "Knoten"), rows.map { it.name })
        val muri = rows[2]
        assertEquals("23:51", muri.arrival?.plannedClock); assertEquals("23:52", muri.arrival?.realClock)
        assertEquals("23:53", muri.departure?.realClock)
        assertEquals("4", muri.platform)
        assertEquals(1, muri.badgeDelay)
        assertEquals(DelayClass.MINOR, muri.badgeClass)
        val drei = rows[3]
        assertTrue(drei.cancelled); assertFalse(drei.realtime)
        assertEquals(DelayClass.CANCELLED, drei.badgeClass)
        assertNull(rows[0].arrival); assertEquals("23:40", rows[0].departure?.shownClock)
        assertEquals("00:02", rows[4].arrival?.realClock)
        assertTrue(rows[4].platformChanged)
        assertEquals(DelayClass.MINOR, rows[4].badgeClass)
    }

    @Test fun boardingAndExitWithoutDelayValueAreMarkedNoRealtime() {
        val bus = detail().trip!!.legs[2]
        val rows = legRows(bus)
        assertFalse(rows[0].realtime)
        assertEquals("", rows[0].departure?.realClock)
        assertTrue(rows[1].realtime)
        assertEquals(listOf(RowRole.BOARD, RowRole.EXIT), rows.map { it.role })
    }

    @Test fun collapsedKeepsBoardingToggleAndExitOnly() {
        val rows = legRows(detail().trip!!.legs[0])
        val entries = timelineEntries(rows, expanded = false)
        assertEquals(
            listOf("Start", "toggle:3:false", "Knoten"),
            entries.map { when (it) { is TimelineEntry.Stop -> it.row.name; is TimelineEntry.Toggle -> "toggle:${it.count}:${it.expanded}" } },
        )
    }

    @Test fun expandedShowsEveryStop() {
        val rows = legRows(detail().trip!!.legs[0])
        val entries = timelineEntries(rows, expanded = true)
        assertEquals(6, entries.size)
        assertEquals(TimelineEntry.Toggle(3, true), entries[1])
        assertEquals(listOf("Eins", "Muri AG", "Drei"), entries.filterIsInstance<TimelineEntry.Stop>().map { it.row.name }.drop(1).dropLast(1))
        assertEquals(1, entries.count { it is TimelineEntry.Toggle })
    }

    @Test fun stopsTheVehicleIsAtOrBetweenStayVisibleWhenCollapsed() {
        val rows = legRows(detail().trip!!.legs[0])
        fun names(marker: VehicleMarker?) = timelineEntries(rows, false, marker).filterIsInstance<TimelineEntry.Stop>().map { it.row.name }
        assertEquals(listOf("Start", "Muri AG", "Knoten"), names(VehicleMarker(2, true, 0.0, false)))
        assertEquals(listOf("Start", "Eins", "Muri AG", "Knoten"), names(VehicleMarker(1, false, 0.4, true)))
        assertEquals(listOf("Start", "Drei", "Knoten"), names(VehicleMarker(3, false, 0.5, false)))
        assertEquals(listOf("Start", "Knoten"), names(VehicleMarker(0, true, 0.0, false)))
        assertEquals(listOf("Start", "Eins", "Knoten"), names(VehicleMarker(0, false, 0.5, false)))
    }

    @Test fun everyHiddenRunGetsItsOwnToggleWithItsCount() {
        val rows = legRows(detail().trip!!.legs[0])
        val entries = timelineEntries(rows, false, VehicleMarker(2, true, 0.0, false))
        assertEquals(
            listOf("Start", "toggle:1", "Muri AG", "toggle:1", "Knoten"),
            entries.map { when (it) { is TimelineEntry.Stop -> it.row.name; is TimelineEntry.Toggle -> "toggle:${it.count}" } },
        )
        // Every stop shown by the marker: nothing is hidden, so there is no toggle.
        val all = timelineEntries(rows.filter { it.role != RowRole.STOP || it.point == 1 }, false, VehicleMarker(1, true, 0.0, false))
        assertTrue(all.none { it is TimelineEntry.Toggle })
    }

    @Test fun aLegWithoutStopListHasNoToggle() {
        val rows = legRows(detail().trip!!.legs[2])
        assertTrue(timelineEntries(rows, false).none { it is TimelineEntry.Toggle })
        val noList = legRows(detail().trip!!.legs[0].copy(stops = emptyList()))
        assertEquals(2, timelineEntries(noList, false).size)
    }

    @Test fun positionMapsToTheRowOrTheGapOfItsLeg() {
        val between = Position(PositionState.BETWEEN, 0, 1, 0.4, true)
        assertEquals(VehicleMarker(1, false, 0.4, true), vehicleMarker(between, 0))
        assertNull(vehicleMarker(between, 2))
        assertEquals(VehicleMarker(2, true, 0.0, false), vehicleMarker(Position(PositionState.AT_STOP, 0, 2), 0))
        assertNull(vehicleMarker(Position(PositionState.NOT_STARTED), 0))
        assertNull(vehicleMarker(Position(PositionState.TRANSFER, 0, 4), 0))
        assertNull(vehicleMarker(Position(PositionState.ARRIVED, 2, 2), 2))
        assertNull(vehicleMarker(null, 0))
    }

    @Test fun positionSummaryNamesTheStops() {
        val trip = detail().trip!!
        assertEquals(PositionSummary(PositionKind.BETWEEN, "Eins", "Muri AG", true), positionSummary(trip, Position(PositionState.BETWEEN, 0, 1, 0.4, true)))
        assertEquals(PositionSummary(PositionKind.AT_STOP, "Muri AG"), positionSummary(trip, Position(PositionState.AT_STOP, 0, 2)))
        assertEquals(PositionSummary(PositionKind.AT_STOP, "Start"), positionSummary(trip, Position(PositionState.AT_STOP, 0, 0)))
        assertEquals(PositionSummary(PositionKind.TRANSFER, "Knoten"), positionSummary(trip, Position(PositionState.TRANSFER, 0, 4)))
        assertEquals(PositionSummary(PositionKind.NOT_STARTED), positionSummary(trip, Position(PositionState.NOT_STARTED)))
        assertEquals(PositionSummary(PositionKind.ARRIVED, "Schule"), positionSummary(trip, Position(PositionState.ARRIVED, 2, 2)))
        assertNull(positionSummary(trip, null))
        assertNull(positionSummary(trip, Position(PositionState.AT_STOP, 9, 0)))
    }

    @Test fun transferWarningsBrokenBeatsTight() {
        assertEquals(TransferWarning.NONE, transferWarning(Transfer("A", 5, 5)))
        assertEquals(TransferWarning.TIGHT, transferWarning(Transfer("A", 2, 5, tight = true)))
        assertEquals(TransferWarning.BROKEN, transferWarning(Transfer("A", 0, 5, broken = true)))
        assertEquals(TransferWarning.BROKEN, transferWarning(Transfer("A", 0, 5, broken = true, tight = true)))
    }

    @Test fun itemsInterleaveWalksAndChangesBeforeTheNextRide() {
        val items = detailItems(detail().trip!!)
        assertEquals(4, items.size)
        assertTrue(items[0] is DetailItem.Ride)
        assertEquals(DetailItem.Walk(1, 4), items[1])
        val change = items[2] as DetailItem.Change
        assertEquals("Knoten", change.at)
        assertEquals(TransferWarning.TIGHT, transferWarning(change.transfer!!))
        assertEquals("31", change.next.line)
        assertEquals(2, (items[3] as DetailItem.Ride).legIndex)
    }

    @Test fun missingChangeDataStillGivesARowAtTheArrivalStop() {
        val trip = detail().trip!!.copy(changes = emptyList())
        val change = detailItems(trip).filterIsInstance<DetailItem.Change>().single()
        assertNull(change.transfer)
        assertEquals("Knoten", change.at)
    }

    @Test fun boardFindsTheTripEverywhereItIsListed() {
        val a = Trip(id = "a"); val b = Trip(id = "b"); val c = Trip(id = "c"); val d = Trip(id = "d")
        val board = RouteBoard(trips = listOf(a), alternatives = listOf(b), pinned = PinnedState(trip = c), change = d)
        assertEquals("b", board.findTrip("b")?.id)
        assertEquals("c", board.findTrip("c")?.id)
        assertEquals("d", board.findTrip("d")?.id)
        assertNull(board.findTrip("zz"))
        assertNull(board.findTrip(""))
        assertNotNull(board.findTrip("a"))
    }

    @Test fun chipLabelsCombineCategoryAndNumber() {
        fun label(line: String, category: String, type: StopType) = legLabel(Leg(line = line, category = category, type = type))
        assertEquals("IR 37", label("IR37", "IR", StopType.TRAIN))
        assertEquals("S 26", label("S26", "S", StopType.TRAIN))
        assertEquals("IR 16", label("IR 16", "IR", StopType.TRAIN))
        assertEquals("Bus 31", label("31", "B", StopType.BUS))
        assertEquals("Tram 6", label("6", "T", StopType.TRAM))
        assertEquals("RE", label("RE", "RE", StopType.TRAIN))
        assertEquals("", label("", "", StopType.OTHER))
        assertEquals("B", label("", "B", StopType.BUS))
    }
}
