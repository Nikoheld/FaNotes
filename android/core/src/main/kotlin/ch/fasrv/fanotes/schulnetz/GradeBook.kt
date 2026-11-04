package ch.fasrv.fanotes.schulnetz

/**
 * Per-account grade tools. School marks stay as Schulnetz sent them.
 * This book only changes the averages, Pluspunkte and target calculator
 * the student sees. It syncs with the vault like the other local school files.
 */
data class OwnGrade(
    val id: String,
    val courseId: String,
    val title: String,
    val mark: Double,
    val weight: Double,
    val date: String,
)

data class CollectivePart(
    val id: String,
    val title: String,
    val mark: Double,
    val weight: Double,
)

/** One counted mark. Its value is the weighted average of [parts]. */
data class CollectiveGrade(
    val id: String,
    val courseId: String,
    val title: String,
    val date: String,
    val weight: Double,
    val parts: List<CollectivePart>,
)

/**
 * A private override of one school mark, keyed by [gradeTargetId].
 * A null mark or weight keeps the school value. [excluded] drops it from
 * the student's averages only.
 */
data class GradeAdjustment(
    val targetId: String,
    val mark: Double? = null,
    val weight: Double? = null,
    val excluded: Boolean = false,
)

data class GradeBook(
    val own: List<OwnGrade> = emptyList(),
    val collective: List<CollectiveGrade> = emptyList(),
    val adjustments: List<GradeAdjustment> = emptyList(),
    val archivedCourseIds: List<String> = emptyList(),
)

fun GradeBook.normalized(): GradeBook = GradeBook(
    own = own.filter { grade ->
        grade.id.isNotBlank() && grade.courseId.isNotBlank() && grade.date.isNotBlank() &&
            grade.mark.isFinite() && grade.mark in 1.0..6.0 && grade.weight.isFinite() && grade.weight > 0.0
    },
    collective = collective.mapNotNull { grade ->
        val parts = grade.parts.filter { part ->
            part.id.isNotBlank() && part.mark.isFinite() && part.mark in 1.0..6.0 && part.weight.isFinite() && part.weight > 0.0
        }
        if (grade.id.isBlank() || grade.courseId.isBlank() || grade.date.isBlank() || !grade.weight.isFinite() || grade.weight <= 0.0 || parts.isEmpty()) {
            null
        } else {
            grade.copy(title = grade.title.ifBlank { "Collective grade" }, parts = parts)
        }
    },
    adjustments = adjustments.mapNotNull { it.cleaned() },
    archivedCourseIds = archivedCourseIds.map { it.trim() }.filter { it.isNotEmpty() }.distinct(),
)

fun GradeAdjustment.cleaned(): GradeAdjustment? {
    if (targetId.isBlank()) return null
    val mark = mark?.takeIf { it.isFinite() && it in 1.0..6.0 }
    val weight = weight?.takeIf { it.isFinite() && it > 0.0 }
    if (mark == null && weight == null && !excluded) return null
    return copy(mark = mark, weight = weight)
}

fun parseGradeDate(raw: String): String? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null
    runCatching { java.time.LocalDate.parse(trimmed.take(10)) }.getOrNull()?.let { return it.toString() }
    return parseSchoolDate(trimmed)?.toString()
}

fun formatGradeDate(iso: String): String {
    val date = runCatching { java.time.LocalDate.parse(iso.take(10)) }.getOrNull() ?: return iso
    return date.format(java.time.format.DateTimeFormatter.ofPattern("d.M.yyyy"))
}

fun parseGradeBook(json: String): GradeBook {
    val obj = runCatching { ch.fasrv.fanotes.json.parseJson(json) as? ch.fasrv.fanotes.json.JsonValue.Obj }.getOrNull() ?: return GradeBook()
    return GradeBook(
        own = obj.array("own")?.items.orEmpty().mapNotNull { parseOwnGrade(it) },
        collective = obj.array("collective")?.items.orEmpty().mapNotNull { parseCollectiveGrade(it) },
        adjustments = obj.array("adjustments")?.items.orEmpty().mapNotNull { parseGradeAdjustment(it) },
        archivedCourseIds = obj.array("archived")?.items.orEmpty().mapNotNull { (it as? ch.fasrv.fanotes.json.JsonValue.Str)?.value?.takeIf { id -> id.isNotBlank() } },
    ).normalized()
}

fun serializeGradeBook(book: GradeBook): String {
    val clean = book.normalized()
    return buildString {
        append("{\"version\":1,\"own\":[")
        clean.own.forEachIndexed { index, grade ->
            if (index > 0) append(',')
            append("{\"id\":").append(ch.fasrv.fanotes.json.escapeJson(grade.id))
            append(",\"courseId\":").append(ch.fasrv.fanotes.json.escapeJson(grade.courseId))
            append(",\"title\":").append(ch.fasrv.fanotes.json.escapeJson(grade.title))
            append(",\"mark\":").append(grade.mark)
            append(",\"weight\":").append(grade.weight)
            append(",\"date\":").append(ch.fasrv.fanotes.json.escapeJson(grade.date))
            append('}')
        }
        append("],\"collective\":[")
        clean.collective.forEachIndexed { index, grade ->
            if (index > 0) append(',')
            append("{\"id\":").append(ch.fasrv.fanotes.json.escapeJson(grade.id))
            append(",\"courseId\":").append(ch.fasrv.fanotes.json.escapeJson(grade.courseId))
            append(",\"title\":").append(ch.fasrv.fanotes.json.escapeJson(grade.title))
            append(",\"date\":").append(ch.fasrv.fanotes.json.escapeJson(grade.date))
            append(",\"weight\":").append(grade.weight)
            append(",\"parts\":[")
            grade.parts.forEachIndexed { partIndex, part ->
                if (partIndex > 0) append(',')
                append("{\"id\":").append(ch.fasrv.fanotes.json.escapeJson(part.id))
                append(",\"title\":").append(ch.fasrv.fanotes.json.escapeJson(part.title))
                append(",\"mark\":").append(part.mark)
                append(",\"weight\":").append(part.weight)
                append('}')
            }
            append("]}")
        }
        append("],\"adjustments\":[")
        clean.adjustments.forEachIndexed { index, adjustment ->
            if (index > 0) append(',')
            append("{\"targetId\":").append(ch.fasrv.fanotes.json.escapeJson(adjustment.targetId))
            if (adjustment.mark != null) append(",\"mark\":").append(adjustment.mark)
            if (adjustment.weight != null) append(",\"weight\":").append(adjustment.weight)
            append(",\"excluded\":").append(adjustment.excluded)
            append('}')
        }
        append("],\"archived\":[")
        clean.archivedCourseIds.forEachIndexed { index, id ->
            if (index > 0) append(',')
            append(ch.fasrv.fanotes.json.escapeJson(id))
        }
        append("]}")
    }
}

private fun parseOwnGrade(item: ch.fasrv.fanotes.json.JsonValue): OwnGrade? {
    val row = item as? ch.fasrv.fanotes.json.JsonValue.Obj ?: return null
    val mark = row.double("mark") ?: return null
    return OwnGrade(
        id = row.string("id") ?: return null,
        courseId = row.string("courseId").orEmpty(),
        title = row.string("title").orEmpty(),
        mark = mark,
        weight = row.double("weight") ?: 1.0,
        date = row.string("date").orEmpty(),
    )
}

private fun parseCollectiveGrade(item: ch.fasrv.fanotes.json.JsonValue): CollectiveGrade? {
    val row = item as? ch.fasrv.fanotes.json.JsonValue.Obj ?: return null
    val parts = row.array("parts")?.items.orEmpty().mapNotNull { partItem ->
        val part = partItem as? ch.fasrv.fanotes.json.JsonValue.Obj ?: return@mapNotNull null
        val mark = part.double("mark") ?: return@mapNotNull null
        CollectivePart(
            id = part.string("id") ?: return@mapNotNull null,
            title = part.string("title").orEmpty(),
            mark = mark,
            weight = part.double("weight") ?: 1.0,
        )
    }
    return CollectiveGrade(
        id = row.string("id") ?: return null,
        courseId = row.string("courseId").orEmpty(),
        title = row.string("title").orEmpty(),
        date = row.string("date").orEmpty(),
        weight = row.double("weight") ?: 1.0,
        parts = parts,
    )
}

private fun parseGradeAdjustment(item: ch.fasrv.fanotes.json.JsonValue): GradeAdjustment? {
    val row = item as? ch.fasrv.fanotes.json.JsonValue.Obj ?: return null
    return GradeAdjustment(
        targetId = row.string("targetId") ?: return null,
        mark = row.double("mark"),
        weight = row.double("weight"),
        excluded = row.bool("excluded") == true,
    )
}
