package ch.fasrv.fanotes.commute

import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/*
 * Fixed connections (pins): the logic behind the editor's connection picker and behind what a route card,
 * the Heute card and the widget focus on. Pure functions, no I/O.
 */

// ── Picker ───────────────────────────────────────────────────────────────────

/** First time the picker offers: the first time of a times schedule, 12:00 for the last lesson, else 06:30. */
fun defaultPickerTime(schedule: Schedule): String = when (schedule.mode) {
    ScheduleMode.TIMES -> schedule.times.filter(::isClockText).minOrNull() ?: "06:30"
    ScheduleMode.LAST_LESSON -> "12:00"
    ScheduleMode.FIRST_LESSON, ScheduleMode.NONE -> "06:30"
}

/** The next date (today included) that falls on [weekday] (1 = Monday ... 7 = Sunday). */
fun nextDateWithWeekday(today: LocalDate, weekday: Int): LocalDate {
    val wanted = weekday.coerceIn(1, 7)
    val ahead = Math.floorMod(wanted - today.dayOfWeek.value, 7)
    return today.plusDays(ahead.toLong())
}

/** `2026-11-16T06:30:00+01:00` for a date and an `HH:MM` clock in [zone]. */
fun pickerAtIso(date: LocalDate, clock: String, zone: ZoneId = COMMUTE_ZONE): String {
    val time = runCatching { LocalTime.parse(clock) }.getOrDefault(LocalTime.of(6, 30))
    return date.atTime(time).atZone(zone).toOffsetDateTime().format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)
}

/**
 * The `at` for paging the picker. Later: the last trip's planned departure plus one minute. Earlier: the
 * first trip's planned departure minus 60 minutes. Null when no trip has a readable departure.
 */
fun pickerPageAt(trips: List<Trip>, later: Boolean, zone: ZoneId = COMMUTE_ZONE): String? {
    val times = trips.mapNotNull { isoMillis(it.plannedDeparture) }
    if (times.isEmpty()) return null
    val ms = if (later) times.max() + 60_000L else times.min() - 60 * 60_000L
    return Instant.ofEpochMilli(ms).atZone(zone).toOffsetDateTime().format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)
}

private fun stopRef(stop: Stop): String = stop.id.ifBlank { stop.name }

/** Path and query of `GET /commute/connections`: stop ids where known, else names. [encode] percent-encodes one value. */
fun connectionsPath(
    from: Stop,
    to: Stop,
    vias: List<Stop>,
    atIso: String,
    timeType: String = "depart",
    encode: (String) -> String = { java.net.URLEncoder.encode(it, "UTF-8") },
): String = buildString {
    append("/commute/connections?from=").append(encode(stopRef(from)))
    append("&to=").append(encode(stopRef(to)))
    vias.take(MAX_VIAS).filter { it.name.isNotBlank() }.forEach { append("&via=").append(encode(stopRef(it))) }
    append("&at=").append(encode(atIso))
    append("&timeType=").append(encode(timeType))
}

// ── Pin editing ──────────────────────────────────────────────────────────────

enum class PinMode { NONE, DAILY, PER_DAY }

/** One pin on several days is "every day the same"; any other pin set is per weekday. */
fun pinModeOf(pins: List<Pin>): PinMode = when {
    pins.isEmpty() -> PinMode.NONE
    pins.size == 1 && pins[0].days.size > 1 -> PinMode.DAILY
    else -> PinMode.PER_DAY
}

/** The days of a "same every day" pin: the schedule's days, else Monday to Friday. */
fun dailyPinDays(schedule: Schedule): List<Int> = schedule.days.filter { it in 1..7 }.distinct().sorted().ifEmpty { DEFAULT_DAYS }

/** [trip]'s pin for [days]; null when the trip has no pin (a walk-only trip) or no day is given. */
fun pinFromTrip(trip: Trip, days: List<Int>): Pin? {
    val base = trip.pin ?: return null
    val clean = days.filter { it in 1..7 }.distinct().sorted()
    return if (clean.isEmpty()) null else base.copy(days = clean)
}

/** Adds [pin]; every weekday it uses leaves the other pins, and pins left without a day are dropped. Sorted by first day. */
fun withPin(pins: List<Pin>, pin: Pin): List<Pin> {
    val taken = pin.days.toSet()
    val others = pins.map { it.copy(days = it.days.filter { d -> d !in taken }) }.filter { it.days.isNotEmpty() }
    return (others + pin).sortedBy { it.days.minOrNull() ?: 8 }
}

/** The pin used on [weekday], if any. */
fun pinForWeekday(pins: List<Pin>, weekday: Int): Pin? = pins.firstOrNull { weekday in it.days }

/** Removes [weekday] from its pin (per-weekday mode). */
fun withoutPinDay(pins: List<Pin>, weekday: Int): List<Pin> =
    pins.map { it.copy(days = it.days - weekday) }.filter { it.days.isNotEmpty() }

/** True when [a] and [b] describe a different journey (ends or via stops), so pins no longer fit. */
fun routeJourneyChanged(a: Route, b: Route): Boolean {
    fun key(stop: Stop) = stop.id.ifBlank { stop.name }
    return key(a.from) != key(b.from) || key(a.to) != key(b.to) || a.vias.map(::key) != b.vias.map(::key)
}

/** Text parts of [pinSummary], so the caller can localize them. */
class PinWords(val from: String, val arrive: String, val transfers: (Int) -> String)

/** `07:12 IR 16 ab Aarau · an 07:41 · 1 Umstieg`. Parts without data are left out. */
fun pinSummary(pin: Pin, words: PinWords): String {
    val head = buildString {
        append(pin.departure)
        if (pin.line.isNotBlank()) append(' ').append(pin.line.trim())
        if (pin.stop.isNotBlank()) append(' ').append(words.from).append(' ').append(pin.stop.trim())
    }
    return listOfNotNull(
        head.takeIf { it.isNotBlank() },
        pin.arrival.takeIf { it.isNotBlank() }?.let { "${words.arrive} $it" },
        words.transfers(pin.transfers).takeIf { it.isNotBlank() },
    ).joinToString(" · ")
}

// ── What a board focuses on ──────────────────────────────────────────────────

enum class FocusKind {
    /** No fixed connection: the board looks as before. */
    PLAIN,
    /** The pinned connection runs as planned (possibly late). */
    PINNED,
    /** The pinned connection runs at another time since the timetable changed. */
    MOVED,
    /** The pinned connection is not in the timetable on its day. */
    MISSING,
    /** The pinned connection is cancelled, broken or gone: the alternatives matter. */
    UNUSABLE,
}

/**
 * What a card, the detail page or the widget puts first. [main] is the trip to show large (the first trip of a
 * plain board, the pinned trip of a pinned one; null when missing or there is no trip). [others] are the further
 * trips that go behind "other connections" (for a plain board: the later trips shown as before).
 */
data class BoardFocus(
    val kind: FocusKind,
    val main: Trip?,
    val pin: Pin? = null,
    /** Travel day of the pin, `YYYY-MM-DD`. */
    val day: String = "",
    /** Moved only: the new `HH:mm` of the first ride. */
    val movedClock: String = "",
    /** Shown prominently when [main] is unusable. */
    val alternatives: List<Trip> = emptyList(),
    val others: List<Trip> = emptyList(),
    /** Missing only. */
    val nearest: Trip? = null,
    /** Lesson change on a pinned route: the other way. */
    val change: Trip? = null,
    val changeKind: LessonChange = LessonChange.NONE,
)

private fun Trip.sameAs(other: Trip?): Boolean = other != null && id.isNotBlank() && id == other.id

fun boardFocus(board: RouteBoard): BoardFocus {
    val pinned = board.pinned
    if (pinned == null) {
        val first = board.trips.firstOrNull()
        return BoardFocus(
            FocusKind.PLAIN, first,
            alternatives = if (first?.unusable == true) board.alternatives else emptyList(),
            others = board.trips.drop(1),
        )
    }
    val change = board.change
    val changeKind = if (change != null) board.target.lessonChange else LessonChange.NONE
    val trip = pinned.trip
    if (pinned.status == PinStatus.MISSING || trip == null) {
        return BoardFocus(
            FocusKind.MISSING, null, pinned.pin, pinned.day, nearest = pinned.nearest,
            others = board.trips.filterNot { it.sameAs(pinned.nearest) }, change = change, changeKind = changeKind,
        )
    }
    val others = board.trips.filterNot { it.sameAs(trip) }
    if (pinned.status == PinStatus.GONE || trip.unusable) {
        val alternatives = board.alternatives.filterNot { it.sameAs(trip) }
        return BoardFocus(
            FocusKind.UNUSABLE, trip, pinned.pin, pinned.day, alternatives = alternatives,
            others = others.filterNot { o -> alternatives.any { it.sameAs(o) } }, change = change, changeKind = changeKind,
        )
    }
    if (pinned.status == PinStatus.MOVED) {
        val clock = isoClock(trip.firstRide()?.from?.planned.orEmpty().ifBlank { trip.plannedDeparture })
        return BoardFocus(FocusKind.MOVED, trip, pinned.pin, pinned.day, movedClock = clock, others = others, change = change, changeKind = changeKind)
    }
    return BoardFocus(FocusKind.PINNED, trip, pinned.pin, pinned.day, others = others, change = change, changeKind = changeKind)
}

// ── Editor helpers ───────────────────────────────────────────────────────────

/**
 * Sets the via stop at [index] (0 or 1), or removes it when [stop] is null. Order is kept, at most [MAX_VIAS]
 * stay, and a stop that equals the start or the end is ignored.
 */
fun withViaAt(route: Route, index: Int, stop: Stop?): Route {
    val list = route.vias.toMutableList()
    if (stop == null) {
        if (index in list.indices) list.removeAt(index)
    } else if (index in list.indices) list[index] = stop
    else if (index == list.size && list.size < MAX_VIAS) list.add(stop)
    return route.copy(vias = list.take(MAX_VIAS))
}

/** [next] with its pins dropped when its start, end or via stops differ from [old]'s (a pinned trip would no longer fit). */
fun withPinsKeptOnlyIfJourneySame(old: Route, next: Route): Route =
    if (next.pins.isNotEmpty() && routeJourneyChanged(old, next)) next.copy(pins = emptyList()) else next
