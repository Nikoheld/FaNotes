package ch.fasrv.fanotes.commute

import ch.fasrv.fanotes.schulnetz.AgendaEvent
import ch.fasrv.fanotes.schulnetz.DerivedWorkProbe
import ch.fasrv.fanotes.schulnetz.HiddenLesson
import ch.fasrv.fanotes.schulnetz.isLesson
import ch.fasrv.fanotes.schulnetz.lessonHidden
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** The commute server and the school both run on Zurich time. */
val COMMUTE_ZONE: ZoneId = ZoneId.of("Europe/Zurich")
private val CLOCK_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
private val CLOCK_TEXT = Regex("""^([01]\d|2[0-3]):[0-5]\d$""")

fun isClockText(text: String): Boolean = CLOCK_TEXT.matches(text)

/** Epoch milliseconds of an ISO 8601 stamp with offset; null for blank or unreadable text. */
fun isoMillis(iso: String): Long? =
    if (iso.isBlank()) null else runCatching { OffsetDateTime.parse(iso).toInstant().toEpochMilli() }.getOrNull()

/** `HH:mm` of a stamp in [zone]; empty when it cannot be read. */
fun isoClock(iso: String, zone: ZoneId = COMMUTE_ZONE): String =
    if (iso.isBlank()) "" else runCatching { OffsetDateTime.parse(iso).atZoneSameInstant(zone).format(CLOCK_FORMAT) }.getOrDefault("")

/** Route ids are 12 random hex characters, made on the phone. */
fun newRouteId(random: java.util.Random = java.security.SecureRandom()): String =
    buildString { repeat(12) { append("0123456789abcdef"[random.nextInt(16)]) } }

/** The route's own name, or "from → to". */
fun routeTitle(route: Route): String = route.name.trim().ifBlank { "${route.from.name} → ${route.to.name}" }

/** A route the editor may save: both ends set and different, and times when the schedule asks for them. */
fun routeSavable(route: Route): Boolean {
    if (route.from.name.isBlank() || route.to.name.isBlank()) return false
    if (route.from.name == route.to.name && route.from.id == route.to.id) return false
    if (route.schedule.mode == ScheduleMode.TIMES && route.schedule.times.isEmpty()) return false
    if (route.schedule.mode != ScheduleMode.NONE && route.schedule.days.isEmpty()) return false
    return true
}

/** Sorted, distinct, valid `HH:mm` times; at most [MAX_SCHEDULE_TIMES]. */
fun normalizedTimes(times: List<String>): List<String> = times.filter(::isClockText).distinct().sorted().take(MAX_SCHEDULE_TIMES)

/** Moves the item at [from] to [to]; out-of-range moves leave the list as it is. */
fun <T> movedItem(list: List<T>, from: Int, to: Int): List<T> {
    if (from !in list.indices || to !in list.indices || from == to) return list
    return list.toMutableList().also { it.add(to, it.removeAt(from)) }
}

// ── Delays ───────────────────────────────────────────────────────────────────

enum class DelayClass { ON_TIME, MINOR, MODERATE, MAJOR, CANCELLED }

/** On time / +1-2 / +3-5 / more than 5 minutes / cancelled. A missing or early value counts as on time. */
fun delayClass(delay: Int?, cancelled: Boolean = false): DelayClass = when {
    cancelled -> DelayClass.CANCELLED
    delay == null || delay <= 0 -> DelayClass.ON_TIME
    // +1 subtle, +2 to +4 orange, +5 and more red (as Fabio specified for the connection detail).
    delay <= 1 -> DelayClass.MINOR
    delay <= 4 -> DelayClass.MODERATE
    else -> DelayClass.MAJOR
}

/** The delay the traveller feels first: the departure, or the arrival when the departure is unknown. */
fun tripDelayClass(trip: Trip): DelayClass = delayClass(trip.depDelay ?: trip.arrDelay, trip.unusable)

fun delayText(delay: Int?): String = if (delay == null || delay <= 0) "" else "+$delay"

/** Whole minutes from [nowMs] until [iso]; negative once it has left. Null when the stamp is unreadable. */
fun minutesUntil(iso: String, nowMs: Long): Int? {
    val at = isoMillis(iso) ?: return null
    return Math.floorDiv(at - nowMs, 60_000L).toInt()
}

fun Trip.firstRide(): Leg? = legs.firstOrNull { !it.walk }

fun Trip.lastRide(): Leg? = legs.lastOrNull { !it.walk }

/** Platform of the first ride's departure. */
fun Trip.departurePlatform(): Point? = firstRide()?.from

/** Distinct ride legs for the line chips. */
fun Trip.rides(): List<Leg> = legs.filter { !it.walk }

// ── Occupancy ────────────────────────────────────────────────────────────────

enum class OccupancyLevel { LOW, MEDIUM, HIGH }

fun occupancyLevel(value: Int?): OccupancyLevel? = when (value) {
    1 -> OccupancyLevel.LOW
    2 -> OccupancyLevel.MEDIUM
    3 -> OccupancyLevel.HIGH
    else -> null
}

/** What to show for a trip: second class first (most students ride 2nd class), else first class. */
fun Occupancy.known(): Boolean = first != null || second != null

fun Occupancy.worst(): Int? = listOfNotNull(first, second).maxOrNull()

// ── Which route to show ──────────────────────────────────────────────────────

/** The trip a board is about: the pinned connection of a pinned route, else the first trip. */
fun RouteBoard.headTrip(): Trip? = if (pinned != null) pinned.trip else trips.firstOrNull()

private fun RouteBoard.firstDepartureMs(): Long? = headTrip()?.let { isoMillis(it.departure) ?: isoMillis(it.plannedDeparture) }

/**
 * The route Heute shows now. Morning (before 12:00): the route tied to the first lesson, the way to
 * school. Afternoon: the route tied to the last lesson, the way home. Otherwise (or when that route's
 * next trip is more than 12 hours away, i.e. today's is over) the route whose next trip leaves soonest.
 * Routes without a board are skipped; null when there are no routes at all.
 */
fun relevantBoard(routes: List<Route>, boards: List<RouteBoard>, nowMs: Long, zone: ZoneId = COMMUTE_ZONE): RouteBoard? {
    val known = routes.map { it.id }.toSet()
    val byId = boards.filter { it.routeId in known }.associateBy { it.routeId }
    val ordered = routes.mapNotNull { byId[it.id] }
    if (ordered.isEmpty()) return null
    val live = ordered.filter { it.headTrip() != null }
    if (live.isEmpty()) return ordered.first()
    val hour = java.time.Instant.ofEpochMilli(nowMs).atZone(zone).hour
    val wanted = if (hour < 12) ScheduleMode.FIRST_LESSON else ScheduleMode.LAST_LESSON
    val modeOf = routes.associate { it.id to it.schedule.mode }
    val horizon = nowMs + 12 * 3_600_000L
    live.filter { modeOf[it.routeId] == wanted }
        .filter { (it.firstDepartureMs() ?: Long.MAX_VALUE) <= horizon }
        .minByOrNull { it.firstDepartureMs() ?: Long.MAX_VALUE }
        ?.let { return it }
    return live.minByOrNull { it.firstDepartureMs() ?: Long.MAX_VALUE }
}

/** The first departure of the board in the future-or-just-left window, for the refresh timer. */
fun departsWithin(board: RouteBoard?, nowMs: Long, minutes: Int = 30): Boolean {
    val trip = board?.headTrip() ?: return false
    val at = isoMillis(trip.departure) ?: isoMillis(trip.plannedDeparture) ?: return false
    return at - nowMs <= minutes * 60_000L && at - nowMs >= -5 * 60_000L
}

/** True when the board is older than [seconds]. Unreadable stamps count as old. */
fun boardOlderThan(updatedAt: String, nowMs: Long, seconds: Int = 30): Boolean {
    val at = isoMillis(updatedAt) ?: return true
    return nowMs - at > seconds * 1000L
}

// ── Lessons the user does not attend ─────────────────────────────────────────

/**
 * Lower-case labels of lessons the user does not attend, as the server wants them in
 * `settings.hiddenLabels`: a label counts when every lesson of it in [events] is hidden by a
 * hide rule (the "hide lesson" feature). A subject that is hidden on one weekday only stays visible
 * on the others, so it is not listed. Sorted and capped at 200.
 */
fun commuteHiddenLabels(
    events: List<AgendaEvent>,
    rules: List<HiddenLesson>,
    zone: ZoneId = COMMUTE_ZONE,
): List<String> {
    DerivedWorkProbe.hit("commuteHiddenLabels")
    val lessons = events.filter { it.isLesson() }
    if (lessons.isEmpty() || rules.isEmpty()) return emptyList()
    val hiddenAll = linkedMapOf<String, Boolean>()
    for (event in lessons) {
        val key = event.label.trim().lowercase()
        if (key.isEmpty()) continue
        val hidden = lessonHidden(event, rules, zone)
        hiddenAll[key] = (hiddenAll[key] ?: true) && hidden
    }
    return hiddenAll.filterValues { it }.keys.sorted().take(200)
}

/** True when the server's labels differ from [next] (order does not matter). */
fun hiddenLabelsChanged(current: List<String>, next: List<String>): Boolean =
    current.map { it.lowercase() }.toSet() != next.map { it.lowercase() }.toSet()

// ── Colours and rows ─────────────────────────────────────────────────────────

private val HEX_COLOR = Regex("""^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$""")

/** `039` or `0033aa` (with or without '#') as `#rrggbb`; null when it is not a colour. */
fun expandHexColor(raw: String): String? {
    val hex = HEX_COLOR.matchEntire(raw.trim())?.groupValues?.get(1) ?: return null
    val full = if (hex.length == 3) hex.map { "$it$it" }.joinToString("") else hex
    return "#" + full.lowercase()
}

/** How a trip reads in a compact list such as the widget: one row per trip. */
data class CommuteRow(
    val tripId: String,
    val departClock: String,
    val plannedClock: String,
    val delay: Int?,
    val delayClass: DelayClass,
    val line: String,
    val lineBg: String,
    val lineFg: String,
    val platform: String,
    val platformChanged: Boolean,
    val arriveClock: String,
    /** Worst occupancy level (1-3) of the second class, else the first; null when unknown. */
    val occupancy: Int?,
    val status: TripStatus,
    val transfers: Int,
    /** A replacement offered for a cancelled or broken first trip. */
    val alternative: Boolean = false,
    /** ISO planned departure of the trip, with [tripId] the key of the connection detail. */
    val plannedDeparture: String = "",
)

fun commuteRow(trip: Trip, alternative: Boolean = false, zone: ZoneId = COMMUTE_ZONE): CommuteRow {
    val ride = trip.firstRide()
    return CommuteRow(
        tripId = trip.id,
        departClock = isoClock(trip.departure.ifBlank { trip.plannedDeparture }, zone),
        plannedClock = isoClock(trip.plannedDeparture, zone),
        delay = trip.depDelay,
        delayClass = tripDelayClass(trip),
        line = ride?.line.orEmpty(),
        lineBg = ride?.bgColor.orEmpty(),
        lineFg = ride?.fgColor.orEmpty(),
        platform = ride?.from?.platform.orEmpty(),
        platformChanged = ride?.from?.platformChanged == true,
        arriveClock = isoClock(trip.arrival.ifBlank { trip.plannedArrival }, zone),
        occupancy = trip.occupancy.second ?: trip.occupancy.first,
        status = trip.status,
        transfers = trip.transfers,
        alternative = alternative,
        plannedDeparture = trip.plannedDeparture,
    )
}

/** The trips of a board for a list: its own, then (when the first is unusable) the offered alternatives. */
fun commuteRows(board: RouteBoard?, limit: Int = 8, zone: ZoneId = COMMUTE_ZONE): List<CommuteRow> {
    if (board == null) return emptyList()
    // A pinned route shows its fixed connection only (and the alternatives when that one fails).
    if (board.pinned != null) {
        val focus = boardFocus(board)
        val main = focus.main?.let { commuteRow(it, false, zone) }
        val extra = if (focus.kind == FocusKind.MISSING) listOfNotNull(focus.nearest) else focus.alternatives
        return (listOfNotNull(main) + extra.map { commuteRow(it, true, zone) }).take(limit)
    }
    val own = board.trips.map { commuteRow(it, false, zone) }
    val extra = if (board.trips.firstOrNull()?.unusable == true) board.alternatives.map { commuteRow(it, true, zone) } else emptyList()
    return (own + extra).take(limit)
}

/** Seconds-free "HH:mm" of a millisecond instant. */
fun clockOf(ms: Long, zone: ZoneId = COMMUTE_ZONE): String = java.time.Instant.ofEpochMilli(ms).atZone(zone).format(CLOCK_FORMAT)
