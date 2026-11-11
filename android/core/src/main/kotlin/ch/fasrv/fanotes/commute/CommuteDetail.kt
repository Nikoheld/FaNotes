package ch.fasrv.fanotes.commute

import java.time.ZoneId

/*
 * Connection detail (Verbindungsdetail): pure helpers that turn a [TripDetail] into the rows the screen draws.
 * Nothing here knows about Compose or texts; the companion maps the results to strings and colours.
 */

// ── Delay classes per stop time ──────────────────────────────────────────────

/**
 * The delay class of one stop time, with the same thresholds as everywhere in commute ([delayClass]).
 * Null when there is no real-time value ([StopTime.delay] null) or no time at all: never guess a class.
 */
fun stopDelayClass(time: StopTime?, cancelled: Boolean = false): DelayClass? = when {
    cancelled -> DelayClass.CANCELLED
    time == null || time.delay == null -> null
    else -> delayClass(time.delay)
}

/** One time shown in the timeline. [realClock] is empty when there is no real-time value (planned only). */
data class TimelineTime(
    val plannedClock: String,
    val realClock: String,
    val delay: Int?,
    /** Null without real time. */
    val delayClass: DelayClass?,
) {
    /** The planned time differs from the real one and should be struck through. */
    val changed: Boolean get() = realClock.isNotBlank() && plannedClock.isNotBlank() && plannedClock != realClock

    /** The time to read first: real when known, else planned. */
    val shownClock: String get() = realClock.ifBlank { plannedClock }
}

fun timelineTime(time: StopTime?, cancelled: Boolean = false, zone: ZoneId = COMMUTE_ZONE): TimelineTime? {
    if (time == null) return null
    val planned = isoClock(time.planned.ifBlank { time.time }, zone)
    val hasReal = time.delay != null && time.time.isNotBlank()
    return TimelineTime(planned, if (hasReal) isoClock(time.time, zone) else "", time.delay, stopDelayClass(time, cancelled))
}

// ── Timeline rows ────────────────────────────────────────────────────────────

enum class RowRole { BOARD, STOP, EXIT }

/** One stop on a leg's rail. [point] is the index of the API's `Position.point`. */
data class TimelineRow(
    val point: Int,
    val role: RowRole,
    val name: String,
    val stopId: String,
    val arrival: TimelineTime?,
    val departure: TimelineTime?,
    val platform: String,
    val platformChanged: Boolean,
    /** False: planned times only; the screen marks it "ohne Echtzeit". */
    val realtime: Boolean,
    val cancelled: Boolean,
) {
    /** The delay to badge: the later of departure and arrival, when real time is known. */
    val badgeDelay: Int? get() = departure?.delay ?: arrival?.delay
    val badgeClass: DelayClass? get() = if (cancelled) DelayClass.CANCELLED else departure?.delayClass ?: arrival?.delayClass
}

private fun pointTime(point: Point): StopTime? =
    if (point.planned.isBlank() && point.time.isBlank()) null else StopTime(point.planned, point.time, point.delay)

/** All rows of a ride leg in order: boarding stop, intermediate stops, exit stop. */
fun legRows(leg: Leg, zone: ZoneId = COMMUTE_ZONE): List<TimelineRow> {
    val rows = ArrayList<TimelineRow>(leg.stops.size + 2)
    rows += TimelineRow(
        0, RowRole.BOARD, leg.from.name, leg.from.stopId, null, timelineTime(pointTime(leg.from), leg.cancelled, zone),
        leg.from.platform, leg.from.platformChanged, leg.from.delay != null, leg.cancelled,
    )
    leg.stops.forEachIndexed { index, stop ->
        rows += TimelineRow(
            index + 1, RowRole.STOP, stop.name, stop.stopId,
            timelineTime(stop.arrival, stop.cancelled, zone), timelineTime(stop.departure, stop.cancelled, zone),
            stop.platform, stop.platformChanged, stop.realtime, stop.cancelled,
        )
    }
    rows += TimelineRow(
        leg.stops.size + 1, RowRole.EXIT, leg.to.name, leg.to.stopId, timelineTime(pointTime(leg.to), leg.cancelled, zone), null,
        leg.to.platform, leg.to.platformChanged, leg.to.delay != null, leg.cancelled,
    )
    return rows
}

/** What the timeline of one leg draws: a stop row or a "N Zwischenhalte" toggle. */
sealed interface TimelineEntry {
    data class Stop(val row: TimelineRow) : TimelineEntry
    /** [count] stops sit behind this toggle (collapsed: the run it replaces; expanded: all intermediate stops). */
    data class Toggle(val count: Int, val expanded: Boolean) : TimelineEntry
}

/**
 * Collapsed (default): boarding stop, the exit stop, and a toggle for every run of hidden intermediate stops. Any
 * stop the vehicle is at or between ([marker]) stays visible, so the marker always sits on or between two shown rows.
 * Expanded: every row, with one toggle after the boarding stop to fold them again. A leg without a stop list has no toggle.
 */
fun timelineEntries(rows: List<TimelineRow>, expanded: Boolean, marker: VehicleMarker? = null): List<TimelineEntry> {
    val inner = rows.count { it.role == RowRole.STOP }
    if (inner == 0) return rows.map { TimelineEntry.Stop(it) }
    val forced = buildSet {
        if (marker != null) { add(marker.point); if (!marker.atStop) add(marker.point + 1) }
    }
    val out = ArrayList<TimelineEntry>(rows.size + 1)
    var hidden = 0
    fun flush() { if (hidden > 0) { out += TimelineEntry.Toggle(hidden, false); hidden = 0 } }
    for (row in rows) {
        when {
            expanded -> { out += TimelineEntry.Stop(row); if (row.role == RowRole.BOARD) out += TimelineEntry.Toggle(inner, true) }
            row.role == RowRole.STOP && row.point !in forced -> hidden++
            else -> { flush(); out += TimelineEntry.Stop(row) }
        }
    }
    return out
}

// ── Vehicle position ─────────────────────────────────────────────────────────

/** The vehicle on one leg's rail: at [point], or [progress] of the way from [point] to the next one. */
data class VehicleMarker(val point: Int, val atStop: Boolean, val progress: Double, val estimated: Boolean)

/** The marker for leg [legIndex], or null when the vehicle is not on that leg's rail. */
fun vehicleMarker(position: Position?, legIndex: Int): VehicleMarker? {
    if (position == null || position.legIndex != legIndex) return null
    return when (position.state) {
        PositionState.AT_STOP -> VehicleMarker(position.point, true, 0.0, position.estimated)
        PositionState.BETWEEN -> VehicleMarker(position.point, false, position.progress.coerceIn(0.0, 1.0), position.estimated)
        else -> null
    }
}

/** Name of point [point] of [leg] (0 = boarding, n+1 = exit); empty when out of range. */
fun pointName(leg: Leg, point: Int): String = when {
    point == 0 -> leg.from.name
    point == leg.stops.size + 1 -> leg.to.name
    point in 1..leg.stops.size -> leg.stops[point - 1].name
    else -> ""
}

enum class PositionKind { NOT_STARTED, AT_STOP, BETWEEN, TRANSFER, ARRIVED }

/** The sentence the header shows, as data: [stop] / [next] are stop names where the kind uses them. */
data class PositionSummary(val kind: PositionKind, val stop: String = "", val next: String = "", val estimated: Boolean = false)

fun positionSummary(trip: Trip, position: Position?): PositionSummary? {
    position ?: return null
    val leg = trip.legs.getOrNull(position.legIndex)?.takeIf { !it.walk }
    return when (position.state) {
        PositionState.NOT_STARTED -> PositionSummary(PositionKind.NOT_STARTED, estimated = position.estimated)
        PositionState.ARRIVED -> PositionSummary(PositionKind.ARRIVED, trip.lastRide()?.to?.name.orEmpty(), estimated = position.estimated)
        PositionState.AT_STOP -> leg?.let { PositionSummary(PositionKind.AT_STOP, pointName(it, position.point), estimated = position.estimated) }
        PositionState.BETWEEN -> leg?.let { PositionSummary(PositionKind.BETWEEN, pointName(it, position.point), pointName(it, position.point + 1), position.estimated) }
        PositionState.TRANSFER -> leg?.let { PositionSummary(PositionKind.TRANSFER, it.to.name, estimated = position.estimated) }
    }
}

// ── Legs and transfers ───────────────────────────────────────────────────────

enum class TransferWarning { NONE, TIGHT, BROKEN }

/** Broken wins over tight: "Anschluss verpasst" beats "Anschluss gefährdet". */
fun transferWarning(transfer: Transfer): TransferWarning = when {
    transfer.broken -> TransferWarning.BROKEN
    transfer.tight -> TransferWarning.TIGHT
    else -> TransferWarning.NONE
}

/** What the detail lists, in order. */
sealed interface DetailItem {
    data class Ride(val legIndex: Int, val leg: Leg) : DetailItem
    data class Walk(val legIndex: Int, val minutes: Int) : DetailItem
    /** The change in front of [next]; [transfer] is null when the server sent fewer changes than rides. */
    data class Change(val transfer: Transfer?, val at: String, val next: Leg) : DetailItem
}

/** Rides and walks in order, with a change row in front of every ride that follows another ride. */
fun detailItems(trip: Trip): List<DetailItem> {
    val out = ArrayList<DetailItem>()
    var rideIndex = 0
    var previousRide: Leg? = null
    trip.legs.forEachIndexed { index, leg ->
        if (leg.walk) { out += DetailItem.Walk(index, leg.minutes); return@forEachIndexed }
        val before = previousRide
        if (before != null) {
            val transfer = trip.changes.getOrNull(rideIndex - 1)
            out += DetailItem.Change(transfer, transfer?.at?.takeIf { it.isNotBlank() } ?: before.to.name, leg)
        }
        out += DetailItem.Ride(index, leg)
        previousRide = leg
        rideIndex++
    }
    return out
}

/** The trip behind a board entry: any trip of the board with [tripId] (head, other trips, alternatives, pinned, change). */
fun RouteBoard.findTrip(tripId: String): Trip? {
    if (tripId.isBlank()) return null
    val all = sequenceOf(trips, alternatives, listOfNotNull(pinned?.trip, pinned?.nearest, change)).flatten()
    return all.firstOrNull { it.id == tripId }
}

/**
 * The chip text of a ride: category and number ("IR 37", "S 26"), or the type and number for a bus or tram line
 * that comes as a bare number ("Bus 31"). Falls back to the line as sent, then the category.
 */
fun legLabel(leg: Leg): String {
    val line = leg.line.trim()
    val category = leg.category.trim()
    if (line.isEmpty()) return category
    if (category.isNotEmpty() && line.length > category.length && line.startsWith(category, ignoreCase = true)) {
        val rest = line.substring(category.length).trim()
        if (rest.isNotEmpty() && rest[0].isDigit()) return "${category.uppercase()} $rest"
    }
    if (line[0].isDigit()) return when (leg.type) {
        StopType.BUS -> "Bus $line"
        StopType.TRAM -> "Tram $line"
        else -> line
    }
    return line
}
