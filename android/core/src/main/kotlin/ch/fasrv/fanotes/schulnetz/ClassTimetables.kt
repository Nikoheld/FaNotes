package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson

/**
 * Other classes' and rooms' timetables of the Alte Kantonsschule, read by the server from the
 * school's own PDF. The app only lists them and shows one class page or one room week.
 */
data class TimetableClass(val code: String, val teacher: String)

data class ClassTimetableSummary(
    val available: Boolean = false,
    val uploadedAt: String = "",
    val semester: String = "",
    val classes: List<TimetableClass> = emptyList(),
    val rooms: List<String> = emptyList(),
)

/** One lesson of a room: [day] 1 = Monday ... 5 = Friday, [start]/[end] as HH:MM. */
data class RoomLesson(val day: Int, val start: String, val end: String, val schoolClass: String, val subject: String, val teacher: String)

data class RoomWeek(val room: String, val lessons: List<RoomLesson>)

private val CLASS_CODE = Regex("^G\\d{2}[A-Z]{1,2}$")
private val ROOM_NAME = Regex("^[A-Za-z0-9_.\\- ]{1,24}$")

fun isClassCode(value: String): Boolean = CLASS_CODE.matches(value)
fun isRoomName(value: String): Boolean = ROOM_NAME.matches(value)

/** True for a Schulnetz link of the Alte Kanti (base URL path /aksa). */
fun isAksaBase(baseUrl: String): Boolean {
    val withoutScheme = baseUrl.substringAfter("://", "")
    if (withoutScheme.isEmpty()) return false
    val path = withoutScheme.substringBefore('?').substringBefore('#').let { if (it.contains('/')) "/" + it.substringAfter('/') else "" }
    return path.trimEnd('/').equals("/aksa", ignoreCase = true)
}

/** The server's summary; anything unreadable counts as "not available", entries with odd names are dropped. */
fun parseClassTimetableSummary(json: String): ClassTimetableSummary {
    val obj = runCatching { parseJson(json) as? JsonValue.Obj }.getOrNull() ?: return ClassTimetableSummary()
    if ((obj.fields["available"] as? JsonValue.Bool)?.value != true) return ClassTimetableSummary()
    val classes = obj.array("classes")?.items.orEmpty().mapNotNull { item ->
        val entry = item as? JsonValue.Obj ?: return@mapNotNull null
        val code = entry.string("code").orEmpty()
        if (isClassCode(code)) TimetableClass(code, entry.string("teacher").orEmpty().take(40)) else null
    }
    val rooms = obj.array("rooms")?.items.orEmpty().mapNotNull { (it as? JsonValue.Str)?.value }.filter(::isRoomName)
    if (classes.isEmpty() && rooms.isEmpty()) return ClassTimetableSummary()
    return ClassTimetableSummary(true, obj.string("uploadedAt").orEmpty(), obj.string("semester").orEmpty().take(40), classes, rooms)
}

fun parseRoomWeek(json: String): RoomWeek? {
    val obj = runCatching { parseJson(json) as? JsonValue.Obj }.getOrNull() ?: return null
    val room = obj.string("room")?.takeIf(::isRoomName) ?: return null
    val lessons = obj.array("entries")?.items.orEmpty().mapNotNull { item ->
        val entry = item as? JsonValue.Obj ?: return@mapNotNull null
        val day = entry.double("day")?.toInt()?.takeIf { it in 1..5 } ?: return@mapNotNull null
        val start = entry.string("start")?.takeIf { it.matches(Regex("^\\d{2}:\\d{2}$")) } ?: return@mapNotNull null
        RoomLesson(day, start, entry.string("end").orEmpty(), entry.string("class").orEmpty(), entry.string("subject").orEmpty(), entry.string("teacher").orEmpty())
    }
    return RoomWeek(room, lessons)
}

/** A room's lessons that share one start time and subject, with the classes folded into one row. */
data class RoomSlot(val start: String, val end: String, val subject: String, val teacher: String, val classes: List<String>)

/** Monday to Friday, each day's lessons by start time; classes sharing subject and teacher become one slot. */
fun roomWeekByDay(week: RoomWeek): List<Pair<Int, List<RoomSlot>>> = (1..5).map { day ->
    val slots = week.lessons.filter { it.day == day }
        .groupBy { Triple(it.start, it.subject, it.teacher) }
        .map { (key, group) -> RoomSlot(key.first, group.first().end, key.second, key.third, group.map { it.schoolClass }.filter { it.isNotBlank() }.distinct().sorted()) }
        .sortedWith(compareBy({ it.start }, { it.subject }))
    day to slots
}

/** A file name for a cached class PDF that changes with each upload, so an old page is never shown. */
fun classPdfCacheName(code: String, uploadedAt: String): String {
    require(isClassCode(code))
    val stamp = uploadedAt.filter { it.isLetterOrDigit() }.takeLast(16).ifEmpty { "x" }
    return "$stamp-$code.pdf"
}
