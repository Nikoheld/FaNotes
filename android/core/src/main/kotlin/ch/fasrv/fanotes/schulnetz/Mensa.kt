package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalDateTime

/** One dish of the Mensa menu. Prices are CHF, null when the page did not give one. */
data class MensaMenu(val name: String, val description: String, val label: String, val price: Double?, val studentPrice: Double?)

data class MensaDay(val date: LocalDate, val closed: Boolean, val note: String, val menus: List<MensaMenu>)

data class MensaFeed(val fetchedAt: String, val stale: Boolean, val days: List<MensaDay>)

private fun JsonValue.Obj.number(key: String): Double? = double(key)?.takeIf { it.isFinite() && it >= 0 }

/** Reads the server's /mensa body. Odd or missing parts are skipped; null when it is not a Mensa body at all. */
fun parseMensaFeed(json: String): MensaFeed? {
    val root = runCatching { parseJson(json) as? JsonValue.Obj }.getOrNull() ?: return null
    val rows = root.array("days") ?: return null
    val days = rows.items.mapNotNull { row ->
        val day = row as? JsonValue.Obj ?: return@mapNotNull null
        val date = runCatching { LocalDate.parse(day.string("date").orEmpty()) }.getOrNull() ?: return@mapNotNull null
        val menus = day.array("menus")?.items.orEmpty().mapNotNull { item ->
            val menu = item as? JsonValue.Obj ?: return@mapNotNull null
            val name = menu.string("name").orEmpty().trim()
            if (name.isEmpty()) null
            else MensaMenu(name, menu.string("description").orEmpty().trim(), menu.string("label").orEmpty().trim(), menu.number("price"), menu.number("studentPrice"))
        }
        MensaDay(date, day.bool("closed") == true || menus.isEmpty(), day.string("note").orEmpty().trim(), menus)
    }
    return MensaFeed(root.string("fetchedAt").orEmpty(), root.bool("stale") == true, days.sortedBy { it.date })
}

/** The day [pickMensaDay] aims at: today, or the next school day after 14:00 and on weekends. */
fun mensaTargetDate(now: LocalDateTime): LocalDate {
    var target = now.toLocalDate()
    if (target.dayOfWeek >= DayOfWeek.SATURDAY || now.hour >= 14) {
        do { target = target.plusDays(1) } while (target.dayOfWeek >= DayOfWeek.SATURDAY)
    }
    return target
}

/** Today's menu; after 14:00 or on a weekend the next school day's. null when that day is not known. */
fun pickMensaDay(days: List<MensaDay>, now: LocalDateTime): MensaDay? {
    val target = mensaTargetDate(now)
    return days.firstOrNull { it.date == target }
}

/** One slot of the week screen. [day] is null when the feed has nothing for that school day. */
data class MensaWeekSlot(val date: LocalDate, val day: MensaDay?, val nextWeek: Boolean)

/**
 * The school days (Monday to Friday) the week screen offers: all of the current week, then next week's
 * when the feed knows at least one day of it. Days of other weeks are left out. On a weekend the
 * "current" week is the one that just ended.
 */
fun mensaWeekSlots(days: List<MensaDay>, today: LocalDate): List<MensaWeekSlot> {
    val monday = today.with(DayOfWeek.MONDAY)
    val byDate = days.associateBy { it.date }
    fun week(start: LocalDate, next: Boolean) = (0L..4L).map { start.plusDays(it) }.map { MensaWeekSlot(it, byDate[it], next) }
    val nextMonday = monday.plusWeeks(1)
    val nextWeek = week(nextMonday, true)
    return week(monday, false) + if (nextWeek.any { it.day != null }) nextWeek else emptyList()
}

/**
 * The date to select first: the one [pickMensaDay] would show. When the feed does not offer it (for example
 * Friday afternoon without next week), today if listed, else the closest earlier listed day, else the first.
 */
fun mensaPreselectedDate(slots: List<MensaWeekSlot>, now: LocalDateTime): LocalDate? {
    if (slots.isEmpty()) return null
    val target = mensaTargetDate(now)
    val dates = slots.map { it.date }
    return when {
        target in dates -> target
        now.toLocalDate() in dates -> now.toLocalDate()
        else -> dates.lastOrNull { it < target } ?: dates.first()
    }
}

/** "13.50" style amount for the student price; whole francs keep two decimals too. */
fun mensaPrice(value: Double): String = String.format(java.util.Locale.ROOT, "%.2f", value)

/** A cached feed is worth a new request after this long (3 hours on school mornings, else 12). */
fun mensaRefreshDue(fetchedAtMillis: Long, nowMillis: Long): Boolean = fetchedAtMillis <= 0 || nowMillis - fetchedAtMillis > 3 * 3_600_000L
