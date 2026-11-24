package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonNull
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.jsonBool

/**
 * The version history of every grade, ported from updateGradeHistory in fanotes-site/schulnetz-logic.mjs.
 * Both run the cases in core/src/test/resources/schulnetz/grade-history-cases.json, so the server's
 * history and the history the app keeps for a device-only connection follow the same rules.
 */
const val GRADE_HISTORY_MAX_VERSIONS = 30
const val GRADE_HISTORY_MAX_TRACKS = 3000

/**
 * The previous grades as the history should see them (gradeDiffBase in schulnetz-logic.mjs): a snapshot
 * from an older grade parser must not make versions or removals, so the history starts from the new list.
 */
fun gradeHistoryBase(previous: SchulnetzSnapshot?, next: SchulnetzSnapshot): List<SchoolGrade> {
    if (previous == null) return emptyList()
    if (previous.gradeParser >= GRADE_PARSER_VERSION || next.grades.isEmpty()) return previous.grades
    return next.grades
}

/** One state of a grade. A hidden grade's marks are null when the server redacted them. */
data class GradeVersion(
    val mark: Double?,
    val weight: Double,
    val title: String,
    val date: String,
    val seenAt: String,
)

/** The history of one grade; [removedAt] is set when Schulnetz no longer lists it. */
data class GradeTrack(
    val id: String,
    val gradeId: String,
    val courseId: String,
    val course: String,
    val title: String,
    val date: String,
    val firstSeenAt: String,
    val versions: List<GradeVersion>,
    val removedAt: String? = null,
    val hidden: Boolean = false,
) {
    val courseKey: String get() = courseId.ifBlank { course }
    val latest: GradeVersion get() = versions.last()
    val changed: Boolean get() = versions.size > 1
}

private fun historyText(raw: String): String = raw.trim().replace(Regex("""\s+"""), " ")

private fun gradeVersion(grade: SchoolGrade, at: String) = GradeVersion(
    mark = grade.mark?.takeIf { it.isFinite() },
    weight = grade.weight.takeIf { it.isFinite() } ?: 1.0,
    title = grade.title,
    date = grade.date,
    seenAt = at,
)

private fun sameGradeVersion(a: GradeVersion, b: GradeVersion): Boolean =
    numKey(a.mark) == numKey(b.mark) && numKey(a.weight) == numKey(b.weight) &&
        historyText(a.title) == historyText(b.title) && normalizeGradeDate(a.date) == normalizeGradeDate(b.date)

/** A track as a grade row, so the shared matcher can match it. Its content is its newest version. */
private fun trackAsGrade(track: GradeTrack): SchoolGrade {
    val last = track.latest
    return SchoolGrade(
        id = track.gradeId, course = track.course, courseId = track.courseId, subject = "", title = last.title,
        date = last.date, mark = last.mark, weight = last.weight, confirmed = true, courseGrade = null, comment = "",
    )
}

private class MutableTrack(source: GradeTrack) {
    val id = source.id
    var gradeId = source.gradeId
    var courseId = source.courseId
    var course = source.course
    var title = source.title
    var date = source.date
    val firstSeenAt = source.firstSeenAt
    val versions = source.versions.toMutableList()
    var removedAt: String? = source.removedAt
    val hidden = source.hidden

    fun freeze() = GradeTrack(id, gradeId, courseId, course, title, date, firstSeenAt, versions.toList(), removedAt, hidden)
}

private fun trimHistory(tracks: MutableList<MutableTrack>): List<GradeTrack> {
    for (track in tracks) {
        if (track.versions.size > GRADE_HISTORY_MAX_VERSIONS) {
            val kept = listOf(track.versions.first()) + track.versions.takeLast(GRADE_HISTORY_MAX_VERSIONS - 1)
            track.versions.clear()
            track.versions.addAll(kept)
        }
    }
    var excess = tracks.size - GRADE_HISTORY_MAX_TRACKS
    if (excess <= 0) return tracks.map { it.freeze() }
    val entries = tracks.mapIndexed { index, track -> index to track }
    fun age(entry: Pair<Int, MutableTrack>) = entry.second.removedAt ?: entry.second.firstSeenAt
    val order = compareBy<Pair<Int, MutableTrack>>({ age(it) }, { it.first })
    val drop = mutableSetOf<Int>()
    for (entry in entries.filter { it.second.removedAt != null }.sortedWith(order)) {
        if (excess <= 0) break
        drop += entry.first
        excess--
    }
    for (entry in entries.filter { it.second.removedAt == null }.sortedWith(order)) {
        if (excess <= 0) break
        drop += entry.first
        excess--
    }
    return tracks.filterIndexed { index, _ -> index !in drop }.map { it.freeze() }
}

/**
 * Same rules as the server: a changed mark, weight, title or day appends a version, a row waiting for
 * its mark makes none, a grade that no longer comes back gets `removedAt` only when [trusted] (a complete
 * read that was taken over), and a removed grade that returns loses it again. The first call (no tracks)
 * seeds one version per grade and removes nothing. [previousGrades] is the list the notification diff
 * compared against.
 */
fun updateGradeHistory(
    history: List<GradeTrack>,
    previousGrades: List<SchoolGrade>,
    nextGrades: List<SchoolGrade>,
    at: String,
    trusted: Boolean,
): List<GradeTrack> {
    val tracks = history.filter { it.versions.isNotEmpty() }.map { MutableTrack(it) }.toMutableList()
    val next = nextGrades.withoutSummaryGrades()
    val prev = previousGrades.withoutSummaryGrades()
    var seq = tracks.maxOfOrNull { Regex("""^g(\d+)$""").find(it.id)?.groupValues?.get(1)?.toIntOrNull() ?: 0 } ?: 0
    fun addTrack(grade: SchoolGrade) {
        seq += 1
        tracks += MutableTrack(
            GradeTrack(
                id = "g$seq", gradeId = grade.id, courseId = grade.courseId, course = grade.course.ifBlank { grade.subject },
                title = grade.title, date = grade.date, firstSeenAt = at, versions = listOf(gradeVersion(grade, at)),
            ),
        )
    }
    if (tracks.isEmpty()) {
        for (grade in next) if (grade.mark != null) addTrack(grade)
        return trimHistory(tracks)
    }

    val live = tracks.filter { it.removedAt == null }
    val asGrade = { track: MutableTrack -> trackAsGrade(track.freeze()) }
    val prevToLive = matchGradeLists(live.map(asGrade), prev).matches
    val nextToPrev = matchGradeLists(prev, next).matches
    val claimed = mutableSetOf<MutableTrack>()
    val found = arrayOfNulls<MutableTrack>(next.size)
    next.indices.forEach { position ->
        val prevIndex = nextToPrev[position]
        val liveIndex = prevIndex?.let { prevToLive[it] }
        val track = liveIndex?.let { live[it] }
        if (track != null) {
            claimed += track
            found[position] = track
        }
    }
    fun direct(grade: SchoolGrade, pool: List<MutableTrack>): MutableTrack? {
        val candidates = pool.filter { it !in claimed }
        val index = matchGradeLists(candidates.map(asGrade), listOf(grade)).matches[0]
        return index?.let { candidates[it] }
    }
    val removed = tracks.filter { it.removedAt != null }
    next.forEachIndexed { position, grade ->
        if (found[position] != null || nextToPrev[position] != null) return@forEachIndexed
        val track = direct(grade, live) ?: direct(grade, removed)
        if (track != null) {
            found[position] = track
            claimed += track
        }
    }

    next.forEachIndexed { position, grade ->
        val track = found[position]
        if (track == null) {
            if (grade.mark != null) addTrack(grade)
            return@forEachIndexed
        }
        track.removedAt = null
        track.gradeId = grade.id
        if (grade.mark == null) return@forEachIndexed
        val prevIndex = nextToPrev[position]
        val changed = prevIndex == null || !sameGradeContent(prev[prevIndex], grade)
        val version = gradeVersion(grade, at)
        if (grade.courseId.isNotBlank()) track.courseId = grade.courseId
        grade.course.ifBlank { grade.subject }.takeIf { it.isNotBlank() }?.let { track.course = it }
        if (changed && !sameGradeVersion(track.versions.last(), version)) track.versions += version
        track.title = track.versions.last().title
        track.date = track.versions.last().date
    }

    if (trusted && next.isNotEmpty()) {
        for (track in live) if (track !in claimed) track.removedAt = at
    }
    return trimHistory(tracks)
}

// JSON as the server sends it (gradeHistory) and as the app stores it per connection.

fun GradeTrack.toJson(): JsonValue.Obj = jsonObject(
    "id" to jsonString(id),
    "gradeId" to jsonString(gradeId),
    "courseId" to jsonString(courseId),
    "course" to jsonString(course),
    "title" to jsonString(title),
    "date" to jsonString(date),
    "firstSeenAt" to jsonString(firstSeenAt),
    "versions" to JsonValue.Arr(versions.map { version ->
        jsonObject(
            "mark" to (version.mark?.let { jsonNumber(it) } ?: jsonNull()),
            "weight" to jsonNumber(version.weight),
            "title" to jsonString(version.title),
            "date" to jsonString(version.date),
            "seenAt" to jsonString(version.seenAt),
        )
    }.toMutableList()),
    "removedAt" to removedAt?.let { jsonString(it) },
    "hidden" to if (hidden) jsonBool(true) else null,
)

fun gradeTracksToJson(tracks: List<GradeTrack>): JsonValue.Arr = JsonValue.Arr(tracks.map { it.toJson() as JsonValue }.toMutableList())

/** Tracks from a server snapshot or the local file; anything not of the known shape is left out. */
fun parseGradeTracks(value: JsonValue?): List<GradeTrack> {
    val items = (value as? JsonValue.Arr)?.items ?: return emptyList()
    return items.mapNotNull { item ->
        val obj = item as? JsonValue.Obj ?: return@mapNotNull null
        val versions = obj.array("versions")?.items.orEmpty().mapNotNull { raw ->
            val version = raw as? JsonValue.Obj ?: return@mapNotNull null
            GradeVersion(
                mark = version.double("mark"),
                weight = version.double("weight") ?: 1.0,
                title = version.string("title").orEmpty(),
                date = version.string("date").orEmpty(),
                seenAt = version.string("seenAt").orEmpty(),
            )
        }
        val id = obj.string("id") ?: return@mapNotNull null
        if (versions.isEmpty()) return@mapNotNull null
        GradeTrack(
            id = id,
            gradeId = obj.string("gradeId").orEmpty(),
            courseId = obj.string("courseId").orEmpty(),
            course = obj.string("course").orEmpty(),
            title = obj.string("title").orEmpty(),
            date = obj.string("date").orEmpty(),
            firstSeenAt = obj.string("firstSeenAt").orEmpty(),
            versions = versions,
            removedAt = obj.string("removedAt")?.takeIf { it.isNotBlank() },
            hidden = obj.bool("hidden") == true,
        )
    }
}

// What the course page needs.

/** The target id of this grade (as gradeTargetId gives it) in one of its versions; the newest by default. */
fun GradeTrack.targetId(version: GradeVersion = latest): String = notifyHash(courseKey, version.date, version.title)

/** Every target id this grade ever had: a hidden (guess-the-grade) grade stays hidden while any is unrevealed. */
fun GradeTrack.targetIds(): Set<String> = (versions.map { targetId(it) } + targetId()).toSet()

/** The history of the listed grade with this target id, or null when it never changed. */
fun gradeTrackFor(history: List<GradeTrack>, targetId: String): GradeTrack? =
    history.firstOrNull { it.removedAt == null && it.changed && it.targetId() == targetId }

/** Grades of one subject Schulnetz no longer lists, most recently removed first. They are in no average. */
fun removedGradeTracks(history: List<GradeTrack>, courseId: String): List<GradeTrack> =
    history.filter { it.removedAt != null && it.courseKey == courseId }.sortedByDescending { it.removedAt }
