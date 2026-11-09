package ch.fasrv.fanotes.schulnetz

/**
 * A grade is announced once per account. The identity is the mark itself
 * (course, date, title, value, weight), not the row id Schulnetz or the HTML
 * parser happened to assign. [ledger] null means the account has no seen-file
 * yet: every grade currently on file is marked seen and none are announced.
 */
data class GradeSettlement(
    val changes: List<SchulnetzChange>,
    val keys: Set<String>,
    val migrated: Boolean,
)

fun normalizeGradeDate(raw: String): String {
    val value = raw.trim()
    val iso = Regex("""^(\d{4})-(\d{2})-(\d{2})""").find(value)
    if (iso != null) return "${iso.groupValues[1]}-${iso.groupValues[2]}-${iso.groupValues[3]}"
    val de = Regex("""^(\d{1,2})\.(\d{1,2})\.(\d{4})""").find(value)
    if (de != null) {
        val day = de.groupValues[1].padStart(2, '0')
        val month = de.groupValues[2].padStart(2, '0')
        return "${de.groupValues[3]}-$month-$day"
    }
    return value.lowercase()
}

fun normalizeGradeText(raw: String): String = raw.trim().lowercase().replace(Regex("""\s+"""), " ")

internal fun gradeContentParts(grade: SchoolGrade): List<String> = listOf(
    normalizeGradeText(grade.courseKey),
    normalizeGradeDate(grade.date),
    normalizeGradeText(grade.title),
    numKey(grade.mark),
    numKey(grade.weight),
)

internal fun gradeLooseParts(grade: SchoolGrade): List<String> = listOf(
    normalizeGradeDate(grade.date),
    normalizeGradeText(grade.title),
    numKey(grade.mark),
    numKey(grade.weight),
)

private fun partKey(parts: List<String>): String = parts.joinToString("\u0000")

fun gradeContentHash(grade: SchoolGrade): String = notifyHash("c", *gradeContentParts(grade).toTypedArray())

fun gradeLooseHash(grade: SchoolGrade): String = notifyHash("l", *gradeLooseParts(grade).toTypedArray())

internal fun looseCounts(grades: List<SchoolGrade>): Map<String, Int> {
    val counts = mutableMapOf<String, Int>()
    for (grade in grades.withoutSummaryGrades()) {
        val key = partKey(gradeLooseParts(grade))
        counts[key] = (counts[key] ?: 0) + 1
    }
    return counts
}

fun gradeNotifyKeys(grade: SchoolGrade, uniqueLoose: Boolean): List<String> {
    val keys = mutableListOf("c:${gradeContentHash(grade)}")
    if (uniqueLoose) keys += "l:${gradeLooseHash(grade)}"
    return keys
}

fun gradeLedgerEntries(grades: List<SchoolGrade>): Set<String> {
    val keys = linkedSetOf<String>()
    for (grade in grades.withoutSummaryGrades()) {
        keys += "c:${gradeContentHash(grade)}"
        keys += "l:${gradeLooseHash(grade)}"
    }
    return keys
}

fun settleGradeNotifications(
    changes: List<SchulnetzChange>,
    grades: List<SchoolGrade>,
    ledger: Set<String>?,
): GradeSettlement {
    val pool = gradeLedgerEntries(grades)
    if (ledger == null) {
        return GradeSettlement(
            changes = changes.filter { it.category != "grade" || isNotificationProbe(it.id) },
            keys = pool,
            migrated = true,
        )
    }
    val known = ledger.toMutableSet()
    val fresh = mutableListOf<SchulnetzChange>()
    for (change in changes) {
        if (isNotificationProbe(change.id)) {
            fresh += change
            continue
        }
        if (change.category != "grade") {
            fresh += change
            continue
        }
        val keys = change.gradeKeys.filter { it.isNotBlank() }
        if (keys.isNotEmpty() && keys.any { it in known }) continue
        fresh += change
        known += keys
    }
    known += pool
    return GradeSettlement(fresh, known, migrated = false)
}

internal fun matchGradeChanges(previous: List<SchoolGrade>, next: List<SchoolGrade>): List<SchulnetzChange> {
    val consumed = mutableSetOf<Int>()
    val prevById = previous.mapIndexed { index, grade -> grade.id to index }.toMap()
    val prevByContent = mutableMapOf<String, MutableList<Int>>()
    val looseBuckets = mutableMapOf<String, MutableList<Int>>()
    previous.forEachIndexed { index, grade ->
        prevByContent.getOrPut(partKey(gradeContentParts(grade))) { mutableListOf() }.add(index)
        looseBuckets.getOrPut(partKey(gradeLooseParts(grade))) { mutableListOf() }.add(index)
    }
    val nextLoose = looseCounts(next)
    val changes = mutableListOf<SchulnetzChange>()
    for (grade in next) {
        val content = partKey(gradeContentParts(grade))
        val loose = partKey(gradeLooseParts(grade))
        var matchedIndex: Int? = prevById[grade.id]?.takeIf { it !in consumed }
        if (matchedIndex == null) {
            matchedIndex = prevByContent[content].orEmpty().firstOrNull { it !in consumed }
        }
        if (matchedIndex == null && nextLoose[loose] == 1) {
            val bucket = looseBuckets[loose].orEmpty()
            if (bucket.size == 1 && bucket[0] !in consumed) matchedIndex = bucket[0]
        }
        val matched = matchedIndex?.let { previous[it] }
        if (matchedIndex != null) consumed += matchedIndex
        if (matched != null) {
            val same = partKey(gradeContentParts(matched)) == content ||
                partKey(gradeLooseParts(matched)) == loose ||
                gradeKey(matched) == gradeKey(grade)
            if (same) continue
        }
        // A row still waiting for its mark is not news. Its mark arriving is a new grade.
        if (grade.mark == null) continue
        val key = gradeKey(grade)
        val course = grade.courseLabel.ifBlank { "Kurs" }
        val name = grade.title.ifBlank { "Note" }
        changes += linkedChange(
            id = "grade:${grade.id}:$key",
            category = "grade",
            title = if (matched == null || matched.mark == null) "Neue Note" else "Notenänderung",
            body = "$course · $name · ${formatMark(grade.mark)} · Gewicht ${formatMark(grade.weight)}",
            targetId = gradeTargetId(grade),
            courseId = grade.courseKey,
            date = grade.date,
            gradeKeys = gradeNotifyKeys(grade, nextLoose[loose] == 1),
        )
    }
    return changes
}
