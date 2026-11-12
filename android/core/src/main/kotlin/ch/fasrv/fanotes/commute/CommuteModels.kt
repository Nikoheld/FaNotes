package ch.fasrv.fanotes.commute

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson

/*
 * Pendelstrecken (commute routes): the types of fanotes-site/commute-api.md and a lenient reader for
 * them. Unknown or missing fields fall back to defaults, so a newer server never breaks an older app.
 * Times stay ISO 8601 strings with offset; CommuteLogic.kt turns them into instants.
 */

enum class StopType(val wire: String) {
    TRAIN("train"), BUS("bus"), TRAM("tram"), SHIP("ship"), CABLEWAY("cableway"), OTHER("other");

    companion object {
        fun of(wire: String?): StopType = entries.firstOrNull { it.wire == wire } ?: OTHER
    }
}

data class Stop(val id: String = "", val name: String = "", val type: StopType = StopType.OTHER)

enum class ScheduleMode(val wire: String) {
    NONE("none"), TIMES("times"), FIRST_LESSON("firstLesson"), LAST_LESSON("lastLesson");

    companion object {
        fun of(wire: String?): ScheduleMode = entries.firstOrNull { it.wire == wire } ?: NONE
    }
}

const val MAX_ROUTES = 8
const val MAX_SCHEDULE_TIMES = 6
const val MAX_ROUTE_NAME = 40
const val MAX_BUFFER_MINUTES = 60
val DEFAULT_DAYS = listOf(1, 2, 3, 4, 5)
val DELAY_THRESHOLD_CHOICES = listOf(2, 3, 5, 10)
const val DEFAULT_DELAY_THRESHOLD = 3

data class Schedule(
    val mode: ScheduleMode = ScheduleMode.NONE,
    /** `HH:MM` departure times; mode [ScheduleMode.TIMES] only. */
    val times: List<String> = emptyList(),
    /** 1 = Monday ... 7 = Sunday. */
    val days: List<Int> = DEFAULT_DAYS,
    /** firstLesson: arrive this early; lastLesson: leave this long after the lesson ends. */
    val bufferMinutes: Int = 10,
)

const val MAX_VIAS = 2

/**
 * A fixed connection: a trip's [Trip.pin] plus the weekdays it is used on. [departure] and [arrival] are
 * `HH:MM` planned times of the first ride leg's boarding and of the end of the trip.
 */
data class Pin(
    val days: List<Int> = emptyList(),
    val line: String = "",
    val trainNo: String = "",
    val stop: String = "",
    val stopId: String = "",
    val departure: String = "",
    val arrival: String = "",
    val transfers: Int = 0,
)

data class Route(
    val id: String,
    val name: String = "",
    val from: Stop = Stop(),
    val to: Stop = Stop(),
    /** 0 to [MAX_VIAS] ordered via stops. */
    val vias: List<Stop> = emptyList(),
    val schedule: Schedule = Schedule(),
    /** Minutes; null follows [CommuteSettings.delayThreshold]. */
    val delayThreshold: Int? = null,
    val notify: Boolean = true,
    /** The fixed connections; empty shows the next connections. Weekdays are disjoint across pins. */
    val pins: List<Pin> = emptyList(),
) {
    /** The first via stop (the field older servers know). */
    val via: Stop? get() = vias.firstOrNull()
}

data class CommuteSettings(
    val delayThreshold: Int = DEFAULT_DELAY_THRESHOLD,
    /** Lower-case labels of lessons the user does not attend. The server leaves them out of lesson-tied targets. */
    val hiddenLabels: List<String> = emptyList(),
)

data class Occupancy(val first: Int? = null, val second: Int? = null)

data class Point(
    val name: String = "",
    val stopId: String = "",
    val time: String = "",
    val planned: String = "",
    val delay: Int? = null,
    val platform: String = "",
    val platformChanged: Boolean = false,
)

/** A time at one stop. [delay] null means the source has no real-time value: [time] is then only the planned time. */
data class StopTime(val planned: String = "", val time: String = "", val delay: Int? = null)

/** One intermediate stop of a ride leg (connection detail only). The boarding and exit stops are [Leg.from] and [Leg.to]. */
data class LegStop(
    val name: String = "",
    val stopId: String = "",
    val arrival: StopTime? = null,
    val departure: StopTime? = null,
    val platform: String = "",
    val platformChanged: Boolean = false,
    /** False: no real-time data for this stop, so only planned times may be shown. */
    val realtime: Boolean = true,
    /** The vehicle does not call here. */
    val cancelled: Boolean = false,
    val occupancy: Occupancy = Occupancy(),
)

data class Leg(
    /** "ride" or "walk". */
    val kind: String = "ride",
    val line: String = "",
    val category: String = "",
    val type: StopType = StopType.OTHER,
    val operator: String = "",
    val direction: String = "",
    /** Hex without '#', may be empty. */
    val fgColor: String = "",
    val bgColor: String = "",
    val from: Point = Point(),
    val to: Point = Point(),
    val occupancy: Occupancy = Occupancy(),
    val cancelled: Boolean = false,
    val notes: List<String> = emptyList(),
    val minutes: Int = 0,
    /** search.ch id of this vehicle; empty for walks and fallback providers. */
    val journeyId: String = "",
    /** Number of intermediate stops (the list itself is only in the connection detail). */
    val stopCount: Int = 0,
    /** Intermediate stops in order; empty outside the connection detail or on an older server. */
    val stops: List<LegStop> = emptyList(),
) {
    val walk: Boolean get() = kind == "walk"
}

data class Transfer(
    val at: String = "",
    val minutes: Int = 0,
    val plannedMinutes: Int = 0,
    val broken: Boolean = false,
    val tight: Boolean = false,
)

data class TripIssue(val kind: String = "", val text: String = "")

enum class TripStatus(val wire: String) {
    OK("ok"), DELAYED("delayed"), CANCELLED("cancelled"), BROKEN("broken");

    companion object {
        fun of(wire: String?): TripStatus = entries.firstOrNull { it.wire == wire } ?: OK
    }
}

data class Trip(
    val id: String = "",
    val departure: String = "",
    val arrival: String = "",
    val plannedDeparture: String = "",
    val plannedArrival: String = "",
    val depDelay: Int? = null,
    val arrDelay: Int? = null,
    val minutes: Int = 0,
    val transfers: Int = 0,
    val status: TripStatus = TripStatus.OK,
    val legs: List<Leg> = emptyList(),
    val changes: List<Transfer> = emptyList(),
    val occupancy: Occupancy = Occupancy(),
    val issues: List<TripIssue> = emptyList(),
    val quietest: Boolean = false,
    /** What to store to pin this trip; null for a walk-only trip or an older server. Its [Pin.days] are empty. */
    val pin: Pin? = null,
) {
    /** Cancelled or with a broken connection: the traveller needs another trip. */
    val unusable: Boolean get() = status == TripStatus.CANCELLED || status == TripStatus.BROKEN
}

data class TargetLesson(val start: String = "", val end: String = "", val label: String = "")

enum class LessonChange(val wire: String) {
    NONE("none"), LAST_CANCELLED("lastCancelled"), FIRST_CANCELLED("firstCancelled");

    companion object {
        fun of(wire: String?): LessonChange = entries.firstOrNull { it.wire == wire } ?: NONE
    }
}

data class TripTarget(
    /** "now", "time", "firstLesson" or "lastLesson". */
    val kind: String = "now",
    val at: String = "",
    /** "depart" or "arrive". */
    val timeType: String = "depart",
    val lesson: TargetLesson? = null,
    val lessonChange: LessonChange = LessonChange.NONE,
    val plannedAt: String? = null,
    /** Kind "pinned" only: the pin that applies, its travel day (`YYYY-MM-DD`) and, on a lesson change, the other moment. */
    val pin: Pin? = null,
    val day: String? = null,
    val changeAt: String? = null,
    val changeTimeType: String? = null,
)

enum class PinStatus(val wire: String) {
    OK("ok"), MOVED("moved"), MISSING("missing"), GONE("gone");

    companion object {
        fun of(wire: String?): PinStatus = entries.firstOrNull { it.wire == wire } ?: OK
    }
}

/** The live state of the pinned connection on its day. [trip] is null when it is missing. */
data class PinnedState(
    val status: PinStatus = PinStatus.OK,
    val day: String = "",
    val pin: Pin = Pin(),
    val trip: Trip? = null,
    /** Missing only: the trip leaving closest to the pinned time. */
    val nearest: Trip? = null,
)

data class RouteBoard(
    val routeId: String = "",
    val target: TripTarget = TripTarget(),
    val trips: List<Trip> = emptyList(),
    val alternatives: List<Trip> = emptyList(),
    val viaDropped: Boolean = false,
    val updatedAt: String = "",
    val stale: Boolean = false,
    val pinned: PinnedState? = null,
    /** Pinned route with a lesson change: the earlier way home or the later way to school. */
    val change: Trip? = null,
)

data class Provider(val name: String = "", val occupancy: String = "", val formation: Boolean = false)

/** `GET`/`PUT /commute`. */
data class CommuteState(
    val routes: List<Route> = emptyList(),
    val settings: CommuteSettings = CommuteSettings(),
    val provider: Provider = Provider(),
)

/** `GET /commute/board`. */
data class BoardAnswer(val boards: List<RouteBoard> = emptyList(), val provider: Provider = Provider())

// ── Reading ──────────────────────────────────────────────────────────────────

private fun JsonValue.Obj.str(key: String): String = string(key).orEmpty()
private fun JsonValue.Obj.int(key: String): Int? = double(key)?.takeIf { !it.isNaN() && !it.isInfinite() }?.toInt()
private fun JsonValue.Obj.objects(key: String): List<JsonValue.Obj> = array(key)?.items.orEmpty().mapNotNull { it as? JsonValue.Obj }
private fun JsonValue.Obj.strings(key: String): List<String> = array(key)?.items.orEmpty().mapNotNull { (it as? JsonValue.Str)?.value }

private fun parseOrNull(body: String): JsonValue.Obj? = runCatching { parseJson(body) as? JsonValue.Obj }.getOrNull()

fun parseStop(obj: JsonValue.Obj?): Stop = if (obj == null) Stop() else Stop(obj.str("id"), obj.str("name"), StopType.of(obj.string("type")))

/** `vias`, or the single `via` of a server that does not know two vias yet. */
private fun parseVias(obj: JsonValue.Obj): List<Stop> {
    val list = if (obj.array("vias") != null) obj.objects("vias").map(::parseStop) else listOfNotNull(obj.obj("via")?.let(::parseStop))
    return list.filter { it.name.isNotBlank() }.take(MAX_VIAS)
}

fun parseSchedule(obj: JsonValue.Obj?): Schedule {
    if (obj == null) return Schedule()
    val days = obj.array("days")?.items.orEmpty().mapNotNull { (it as? JsonValue.Num)?.value?.toInt() }.filter { it in 1..7 }.distinct().sorted()
    return Schedule(
        mode = ScheduleMode.of(obj.string("mode")),
        times = obj.strings("times").filter { isClockText(it) }.take(MAX_SCHEDULE_TIMES),
        days = if (obj.array("days") == null) DEFAULT_DAYS else days,
        bufferMinutes = (obj.int("bufferMinutes") ?: 10).coerceIn(0, MAX_BUFFER_MINUTES),
    )
}

/** `days` of a pin: valid weekdays only, sorted and distinct. */
private fun pinDays(obj: JsonValue.Obj): List<Int> =
    obj.array("days")?.items.orEmpty().mapNotNull { (it as? JsonValue.Num)?.value?.toInt() }.filter { it in 1..7 }.distinct().sorted()

fun parsePin(obj: JsonValue.Obj?): Pin? {
    if (obj == null) return null
    val pin = Pin(
        days = pinDays(obj), line = obj.str("line"), trainNo = obj.str("trainNo"), stop = obj.str("stop"), stopId = obj.str("stopId"),
        departure = obj.str("departure"), arrival = obj.str("arrival"), transfers = obj.int("transfers") ?: 0,
    )
    return pin.takeIf { isClockText(it.departure) }
}

fun parseRoute(obj: JsonValue.Obj): Route? {
    val id = obj.str("id")
    if (id.isBlank()) return null
    return Route(
        id = id,
        name = obj.str("name"),
        from = parseStop(obj.obj("from")),
        to = parseStop(obj.obj("to")),
        vias = parseVias(obj),
        schedule = parseSchedule(obj.obj("schedule")),
        pins = obj.objects("pins").mapNotNull { parsePin(it) }.filter { it.days.isNotEmpty() },
        delayThreshold = obj.int("delayThreshold"),
        notify = obj.bool("notify") != false,
    )
}

fun parseCommuteSettings(obj: JsonValue.Obj?): CommuteSettings = CommuteSettings(
    delayThreshold = (obj?.int("delayThreshold") ?: DEFAULT_DELAY_THRESHOLD).coerceIn(1, 30),
    hiddenLabels = obj?.strings("hiddenLabels").orEmpty(),
)

fun parseProvider(obj: JsonValue.Obj?): Provider =
    if (obj == null) Provider() else Provider(obj.str("name"), obj.str("occupancy"), obj.bool("formation") == true)

fun parseOccupancy(obj: JsonValue.Obj?): Occupancy {
    fun level(key: String) = obj?.int(key)?.takeIf { it in 1..3 }
    return Occupancy(level("first"), level("second"))
}

private fun parsePoint(obj: JsonValue.Obj?): Point = if (obj == null) Point() else Point(
    name = obj.str("name"), stopId = obj.str("stopId"), time = obj.str("time"), planned = obj.str("planned"),
    delay = obj.int("delay"), platform = obj.str("platform"), platformChanged = obj.bool("platformChanged") == true,
)

private fun parseLeg(obj: JsonValue.Obj): Leg = Leg(
    kind = obj.str("kind").ifBlank { "ride" },
    line = obj.str("line"), category = obj.str("category"), type = StopType.of(obj.string("type")),
    operator = obj.str("operator"), direction = obj.str("direction"),
    fgColor = obj.str("fgColor"), bgColor = obj.str("bgColor"),
    from = parsePoint(obj.obj("from")), to = parsePoint(obj.obj("to")),
    occupancy = parseOccupancy(obj.obj("occupancy")),
    cancelled = obj.bool("cancelled") == true,
    notes = obj.strings("notes"),
    minutes = obj.int("minutes") ?: 0,
    journeyId = obj.str("journeyId"),
    stopCount = obj.int("stopCount") ?: 0,
    stops = obj.objects("stops").map(::parseLegStop),
)

private fun parseStopTime(obj: JsonValue.Obj?): StopTime? =
    if (obj == null) null else StopTime(obj.str("planned"), obj.str("time"), obj.int("delay"))

private fun parseLegStop(obj: JsonValue.Obj): LegStop = LegStop(
    name = obj.str("name"), stopId = obj.str("stopId"),
    arrival = parseStopTime(obj.obj("arrival")), departure = parseStopTime(obj.obj("departure")),
    platform = obj.str("platform"), platformChanged = obj.bool("platformChanged") == true,
    realtime = obj.bool("realtime") != false, cancelled = obj.bool("cancelled") == true,
    occupancy = parseOccupancy(obj.obj("occupancy")),
)

fun parseTrip(obj: JsonValue.Obj): Trip = Trip(
    id = obj.str("id"),
    departure = obj.str("departure"), arrival = obj.str("arrival"),
    plannedDeparture = obj.str("plannedDeparture"), plannedArrival = obj.str("plannedArrival"),
    depDelay = obj.int("depDelay"), arrDelay = obj.int("arrDelay"),
    minutes = obj.int("minutes") ?: 0, transfers = obj.int("transfers") ?: 0,
    status = TripStatus.of(obj.string("status")),
    legs = obj.objects("legs").map(::parseLeg),
    changes = obj.objects("changes").map { Transfer(it.str("at"), it.int("minutes") ?: 0, it.int("plannedMinutes") ?: 0, it.bool("broken") == true, it.bool("tight") == true) },
    occupancy = parseOccupancy(obj.obj("occupancy")),
    issues = obj.objects("issues").map { TripIssue(it.str("kind"), it.str("text")) },
    quietest = obj.bool("quietest") == true,
    pin = parsePin(obj.obj("pin")),
)

private fun parseTarget(obj: JsonValue.Obj?): TripTarget {
    if (obj == null) return TripTarget()
    return TripTarget(
        kind = obj.str("kind").ifBlank { "now" },
        at = obj.str("at"),
        timeType = obj.str("timeType").ifBlank { "depart" },
        lesson = obj.obj("lesson")?.let { TargetLesson(it.str("start"), it.str("end"), it.str("label")) },
        lessonChange = LessonChange.of(obj.string("lessonChange")),
        plannedAt = obj.string("plannedAt"),
        pin = parsePin(obj.obj("pin")),
        day = obj.string("day"),
        changeAt = obj.string("changeAt"),
        changeTimeType = obj.string("changeTimeType"),
    )
}

private fun parsePinned(obj: JsonValue.Obj?): PinnedState? {
    if (obj == null) return null
    return PinnedState(
        status = PinStatus.of(obj.string("status")),
        day = obj.str("day"),
        pin = parsePin(obj.obj("pin")) ?: obj.obj("trip")?.let { parsePin(it.obj("pin")) } ?: Pin(),
        trip = obj.obj("trip")?.let(::parseTrip),
        nearest = obj.obj("nearest")?.let(::parseTrip),
    )
}

fun parseRouteBoard(obj: JsonValue.Obj): RouteBoard = RouteBoard(
    routeId = obj.str("routeId"),
    target = parseTarget(obj.obj("target")),
    trips = obj.objects("trips").map(::parseTrip),
    alternatives = obj.objects("alternatives").map(::parseTrip),
    viaDropped = obj.bool("viaDropped") == true,
    pinned = parsePinned(obj.obj("pinned")),
    change = obj.obj("change")?.let(::parseTrip),
    updatedAt = obj.str("updatedAt"),
    stale = obj.bool("stale") == true,
)

/** Null when [body] is not a JSON object at all; any object parses, with defaults for what is missing. */
fun parseCommuteState(body: String): CommuteState? {
    val root = parseOrNull(body) ?: return null
    return CommuteState(
        routes = root.objects("routes").mapNotNull(::parseRoute),
        settings = parseCommuteSettings(root.obj("settings")),
        provider = parseProvider(root.obj("provider")),
    )
}

fun parseBoardAnswer(body: String): BoardAnswer? {
    val root = parseOrNull(body) ?: return null
    return BoardAnswer(root.objects("boards").map(::parseRouteBoard), parseProvider(root.obj("provider")))
}

fun parseStops(body: String): List<Stop> =
    parseOrNull(body)?.objects("stops").orEmpty().map(::parseStop).filter { it.name.isNotBlank() }

fun parseTrips(body: String): List<Trip> = parseOrNull(body)?.objects("trips").orEmpty().map(::parseTrip)

/** Where the trip is now. [point]: 0 = leg.from, 1..n = leg.stops[point-1], n+1 = leg.to. */
enum class PositionState(val wire: String) {
    NOT_STARTED("notStarted"), AT_STOP("atStop"), BETWEEN("between"), TRANSFER("transfer"), ARRIVED("arrived");

    companion object {
        fun of(wire: String?): PositionState? = entries.firstOrNull { it.wire == wire }
    }
}

data class Position(
    val state: PositionState = PositionState.NOT_STARTED,
    val legIndex: Int = 0,
    val point: Int = 0,
    /** Between: 0-1 of the way to the next point. */
    val progress: Double = 0.0,
    /** A time the position relies on has no real-time value. */
    val estimated: Boolean = false,
)

data class DetailSources(val realtime: String = "", val platforms: String? = null, val formation: String? = null)

/** `GET /commute/trip`: one connection with every stop. [trip] is null when [gone]. */
data class TripDetail(
    val trip: Trip? = null,
    val position: Position? = null,
    val updatedAt: String = "",
    val stale: Boolean = false,
    val gone: Boolean = false,
    val sources: DetailSources = DetailSources(),
)

private fun parsePosition(obj: JsonValue.Obj?): Position? {
    val state = PositionState.of(obj?.string("state")) ?: return null
    return Position(
        state = state,
        legIndex = (obj?.int("legIndex") ?: 0).coerceAtLeast(0),
        point = (obj?.int("point") ?: 0).coerceAtLeast(0),
        progress = (obj?.double("progress") ?: 0.0).takeIf { !it.isNaN() && !it.isInfinite() }?.coerceIn(0.0, 1.0) ?: 0.0,
        estimated = obj?.bool("estimated") == true,
    )
}

/** Null when [body] is not a JSON object. A missing `trip` counts as gone. */
fun parseTripDetail(body: String): TripDetail? {
    val root = parseOrNull(body) ?: return null
    val trip = root.obj("trip")?.let(::parseTrip)
    val sources = root.obj("sources")
    return TripDetail(
        trip = trip,
        position = parsePosition(root.obj("position")),
        updatedAt = root.str("updatedAt"),
        stale = root.bool("stale") == true,
        gone = root.bool("gone") == true || trip == null,
        sources = DetailSources(sources?.str("realtime").orEmpty(), sources?.string("platforms")?.takeIf { it.isNotBlank() }, sources?.string("formation")?.takeIf { it.isNotBlank() }),
    )
}

/** Path of `GET /commute/trip` for [routeId], [tripId] and the trip's planned departure. */
fun tripDetailPath(routeId: String, tripId: String, plannedDeparture: String): String {
    fun q(value: String) = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    return "/commute/trip?route=${q(routeId)}&trip=${q(tripId)}&at=${q(plannedDeparture)}"
}

// ── Writing ──────────────────────────────────────────────────────────────────

private fun stopJson(stop: Stop): String =
    "{\"id\":${escapeJson(stop.id)},\"name\":${escapeJson(stop.name)},\"type\":${escapeJson(stop.type.wire)}}"

private fun scheduleJson(schedule: Schedule): String = buildString {
    append("{\"mode\":").append(escapeJson(schedule.mode.wire))
    append(",\"times\":[").append(schedule.times.joinToString(",") { escapeJson(it) }).append(']')
    append(",\"days\":[").append(schedule.days.joinToString(",")).append(']')
    append(",\"bufferMinutes\":").append(schedule.bufferMinutes)
    append('}')
}

private fun pinJson(pin: Pin): String = buildString {
    append("{\"days\":[").append(pin.days.joinToString(",")).append(']')
    append(",\"line\":").append(escapeJson(pin.line))
    append(",\"trainNo\":").append(escapeJson(pin.trainNo))
    append(",\"stop\":").append(escapeJson(pin.stop))
    append(",\"stopId\":").append(escapeJson(pin.stopId))
    append(",\"departure\":").append(escapeJson(pin.departure))
    append(",\"arrival\":").append(escapeJson(pin.arrival))
    append(",\"transfers\":").append(pin.transfers)
    append('}')
}

fun routeJson(route: Route): String = buildString {
    append("{\"id\":").append(escapeJson(route.id))
    append(",\"name\":").append(escapeJson(route.name))
    append(",\"from\":").append(stopJson(route.from))
    append(",\"to\":").append(stopJson(route.to))
    // `vias` for servers that know two vias, `via` (the first) for older ones.
    append(",\"vias\":[").append(route.vias.take(MAX_VIAS).joinToString(",") { stopJson(it) }).append(']')
    append(",\"via\":").append(route.vias.firstOrNull()?.let(::stopJson) ?: "null")
    append(",\"schedule\":").append(scheduleJson(route.schedule))
    append(",\"pins\":[").append(route.pins.joinToString(",") { pinJson(it) }).append(']')
    append(",\"delayThreshold\":").append(route.delayThreshold?.toString() ?: "null")
    append(",\"notify\":").append(route.notify)
    append('}')
}

/** Body of `PUT /commute`: the whole list. */
fun commuteBody(routes: List<Route>, settings: CommuteSettings): String = buildString {
    append("{\"routes\":[").append(routes.joinToString(",") { routeJson(it) }).append(']')
    append(",\"settings\":{\"delayThreshold\":").append(settings.delayThreshold)
    append(",\"hiddenLabels\":[").append(settings.hiddenLabels.joinToString(",") { escapeJson(it) }).append("]}")
    append('}')
}
