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

/** Today's menu; after 14:00 or on a weekend the next school day's. null when that day is not known. */
fun pickMensaDay(days: List<MensaDay>, now: LocalDateTime): MensaDay? {
    var target = now.toLocalDate()
    if (target.dayOfWeek >= DayOfWeek.SATURDAY || now.hour >= 14) {
        do { target = target.plusDays(1) } while (target.dayOfWeek >= DayOfWeek.SATURDAY)
    }
    return days.firstOrNull { it.date == target }
}

/** "13.50" style amount for the student price; whole francs keep two decimals too. */
fun mensaPrice(value: Double): String = String.format(java.util.Locale.ROOT, "%.2f", value)

/** A cached feed is worth a new request after this long (3 hours on school mornings, else 12). */
fun mensaRefreshDue(fetchedAtMillis: Long, nowMillis: Long): Boolean = fetchedAtMillis <= 0 || nowMillis - fetchedAtMillis > 3 * 3_600_000L
