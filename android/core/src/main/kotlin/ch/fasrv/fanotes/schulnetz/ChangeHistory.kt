package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson

/**
 * The "Änderungen" list: the last notices the server's change feed delivered to this install.
 * The feed itself is not consumed by a pull (only the local cursor moves), but pushes and cursors mean
 * the app sees each notice once, so it keeps the last [CHANGE_HISTORY_LIMIT] here.
 * With guess-the-grade on, grade notices are stored and shown redacted exactly like the notifications.
 */
const val CHANGE_HISTORY_LIMIT = 100

/** Merges [incoming] (any order) into [existing], newest first. A repeated id replaces the older row. */
fun recordChanges(
    existing: List<SchulnetzChange>,
    incoming: List<SchulnetzChange>,
    now: String,
    guessGrades: Boolean,
    snapshot: SchulnetzSnapshot,
    limit: Int = CHANGE_HISTORY_LIMIT,
): List<SchulnetzChange> {
    val fresh = incoming
        .filter { it.id.isNotBlank() && !isNotificationProbe(it.id) && it.category != "settings" }
        .map { change ->
            val stamped = if (change.at.isBlank()) change.copy(at = now) else change
            if (guessGrades) redactGradeChange(stamped, snapshot) else stamped
        }
    val ids = fresh.map { it.id }.toSet()
    return (fresh + existing.filter { it.id !in ids })
        .sortedByDescending { it.at }
        .take(limit)
}

/**
 * What the list shows. A grade notice whose mark is still hidden (or whose link is unknown) is redacted
 * while guess-the-grade is on, even when it was stored before the mark was hidden.
 */
fun historyForDisplay(
    history: List<SchulnetzChange>,
    guessGrades: Boolean,
    hiddenTargetIds: Set<String>,
    snapshot: SchulnetzSnapshot,
): List<SchulnetzChange> = history.map { change ->
    if (!guessGrades || change.category != "grade") return@map change
    val ids = change.linkIds()
    if (ids.isEmpty() || ids.any { it in hiddenTargetIds }) redactGradeChange(change, snapshot) else change
}

fun serializeChangeHistory(history: List<SchulnetzChange>): String = buildString {
    append("[")
    history.forEachIndexed { index, c ->
        if (index > 0) append(',')
        append("{\"id\":").append(escapeJson(c.id))
        append(",\"category\":").append(escapeJson(c.category))
        append(",\"title\":").append(escapeJson(c.title))
        append(",\"body\":").append(escapeJson(c.body))
        append(",\"target\":").append(escapeJson(c.target))
        append(",\"targetIds\":[").append(c.linkIds().joinToString(",") { escapeJson(it) }).append(']')
        append(",\"courseId\":").append(escapeJson(c.courseId))
        append(",\"date\":").append(escapeJson(c.date))
        append(",\"at\":").append(escapeJson(c.at))
        append('}')
    }
    append(']')
}

fun parseChangeHistory(json: String?): List<SchulnetzChange> {
    if (json.isNullOrBlank()) return emptyList()
    val array = runCatching { parseJson(json) as? JsonValue.Arr }.getOrNull() ?: return emptyList()
    return array.items.mapNotNull { item ->
        val row = item as? JsonValue.Obj ?: return@mapNotNull null
        val id = row.string("id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        val ids = row.array("targetIds")?.items.orEmpty().mapNotNull { (it as? JsonValue.Str)?.value }
        SchulnetzChange(
            id = id,
            category = row.string("category").orEmpty().ifBlank { "event" },
            title = row.string("title").orEmpty(),
            body = row.string("body").orEmpty(),
            target = row.string("target").orEmpty(),
            targetId = ids.joinToString(","),
            courseId = row.string("courseId").orEmpty(),
            date = row.string("date").orEmpty(),
            targetIds = ids,
            at = row.string("at").orEmpty(),
        )
    }.take(CHANGE_HISTORY_LIMIT)
}
