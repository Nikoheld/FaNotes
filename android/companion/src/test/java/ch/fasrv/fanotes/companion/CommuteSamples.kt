package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.commute.*
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/** Synthetic commute data for tests: invented stops, lines and times. */
object CommuteSamples {
    const val DAY = "2026-11-13"
    /** 06:50 on the sample day: a quarter of an hour before the first bus. */
    val NOW: Long = isoMillis("${DAY}T06:50:00+01:00")!!

    fun at(clock: String) = "${DAY}T$clock:00+01:00"

    val home = Stop("9000001", "Testdorf, Dorfplatz", StopType.BUS)
    val school = Stop("9000004", "Schulstadt", StopType.TRAIN)
    val hub = Stop("9000003", "Knoten", StopType.TRAIN)

    fun route(id: String = "a1b2c3d4e5f6", name: String = "Schule", mode: ScheduleMode = ScheduleMode.FIRST_LESSON, via: Stop? = null, notify: Boolean = true) =
        Route(id, name, home, school, listOfNotNull(via), Schedule(mode, if (mode == ScheduleMode.TIMES) listOf("07:05") else emptyList(), bufferMinutes = 10), null, notify)

    private fun point(name: String, clock: String, planned: String = clock, delay: Int? = null, platform: String = "", changed: Boolean = false) =
        Point(name, "", at(clock), at(planned), delay, platform, changed)

    fun bus(dep: String = "07:05", delay: Int = 0, line: String = "371", bg: String = "039") = Leg(
        kind = "ride", line = line, category = "B", type = StopType.BUS, direction = "Endstation", fgColor = "fff", bgColor = bg,
        from = point("Testdorf, Dorfplatz", clock(dep, delay), dep, delay), to = point("Knoten, Bahnhof", clock("07:21", delay), "07:21", delay), minutes = 16,
    )

    fun walk() = Leg(kind = "walk", from = point("Knoten, Bahnhof", "07:21"), to = point("Knoten", "07:25"), minutes = 4)

    fun train(dep: String = "07:30", platform: String = "5", changed: Boolean = false, occupancy: Occupancy = Occupancy(1, 2)) = Leg(
        kind = "ride", line = "S29", category = "S", type = StopType.TRAIN, direction = "Schulstadt", fgColor = "fff", bgColor = "e2001a",
        from = point("Knoten", dep, dep, 0, platform, changed), to = point("Schulstadt", "07:47", "07:47", 0, "7"), occupancy = occupancy, minutes = 17,
    )

    private fun clock(base: String, delay: Int): String {
        val (h, m) = base.split(':').map { it.toInt() }
        val total = h * 60 + m + delay
        return "%02d:%02d".format(total / 60, total % 60)
    }

    fun trip(
        dep: String = "07:05", delay: Int = 0, status: TripStatus = if (delay > 0) TripStatus.DELAYED else TripStatus.OK,
        quietest: Boolean = false, changed: Boolean = false, tight: Boolean = false, broken: Boolean = false, id: String = "t-$dep",
    ): Trip {
        val real = clock(dep, delay)
        return Trip(
            id = id, departure = at(real), arrival = at("07:47"), plannedDeparture = at(dep), plannedArrival = at("07:47"),
            depDelay = delay, arrDelay = 0, minutes = 42, transfers = 1, status = status,
            legs = listOf(bus(dep, delay), walk(), train(platform = "5", changed = changed)),
            changes = listOf(Transfer("Knoten", if (broken) 0 else if (tight) 2 else 5, 5, broken, tight)),
            occupancy = Occupancy(1, 2), issues = emptyList(), quietest = quietest,
        )
    }

    fun target(kind: String = "firstLesson", change: LessonChange = LessonChange.NONE, plannedAt: String? = null) = TripTarget(
        kind = kind, at = at(if (kind == "lastLesson") "15:05" else "07:50"), timeType = if (kind == "lastLesson") "depart" else "arrive",
        lesson = TargetLesson(at("08:00"), at("08:45"), "tst"), lessonChange = change, plannedAt = plannedAt,
    )

    fun board(vararg trips: Trip, alternatives: List<Trip> = emptyList(), target: TripTarget = target(), stale: Boolean = false, viaDropped: Boolean = false, routeId: String = "a1b2c3d4e5f6") =
        RouteBoard(routeId, target, trips.toList(), alternatives, viaDropped, at("06:48"), stale)

    fun ui(board: RouteBoard? = null, routes: List<Route> = listOf(route())) =
        CommuteUi(loaded = true, routes = routes, boards = listOfNotNull(board), boardAt = NOW - 120_000, provider = Provider("search.ch", "train-class", false))

    /** Routes and boards as the files the store keeps, with the first bus [minutes] from now. For the UI perf fixture. */
    fun fixtureFiles(now: ZonedDateTime, minutes: Long): Pair<String, String> {
        val iso = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssXXX")
        val dep = now.plusMinutes(minutes)
        val arr = dep.plusMinutes(42)
        fun stamp(t: ZonedDateTime) = "\"${t.format(iso)}\""
        val routes = commuteBody(listOf(route()), CommuteSettings())
        val leg = { line: String, from: String, to: String, d: ZonedDateTime, a: ZonedDateTime ->
            """{"kind":"ride","line":"$line","category":"S","type":"train","direction":"Endstation","fgColor":"fff","bgColor":"039",
               "from":{"name":"$from","stopId":"1","time":${stamp(d)},"planned":${stamp(d)},"delay":0,"platform":"4","platformChanged":false},
               "to":{"name":"$to","stopId":"2","time":${stamp(a)},"planned":${stamp(a)},"delay":0,"platform":"","platformChanged":false},
               "occupancy":{"first":1,"second":2},"cancelled":false,"notes":[],"minutes":20}"""
        }
        val trip = """{"id":"fixture-trip","departure":${stamp(dep)},"arrival":${stamp(arr)},"plannedDeparture":${stamp(dep)},"plannedArrival":${stamp(arr)},
            "depDelay":2,"arrDelay":2,"minutes":42,"transfers":1,"status":"delayed",
            "legs":[${leg("S29", "Testdorf, Dorfplatz", "Knoten", dep, dep.plusMinutes(20))},${leg("IR16", "Knoten", "Schulstadt", dep.plusMinutes(25), arr)}],
            "changes":[{"at":"Knoten","minutes":5,"plannedMinutes":5,"broken":false,"tight":false}],
            "occupancy":{"first":1,"second":2},"issues":[],"quietest":true}"""
        val board = """{"boards":[{"routeId":"a1b2c3d4e5f6","target":{"kind":"firstLesson","at":${stamp(arr)},"timeType":"arrive","lesson":null,"lessonChange":"none","plannedAt":null},
            "trips":[$trip],"alternatives":[],"viaDropped":false,"updatedAt":${stamp(now)},"stale":false}],"provider":{"name":"search.ch","occupancy":"train-class","formation":false}}"""
        return routes to board
    }
}
