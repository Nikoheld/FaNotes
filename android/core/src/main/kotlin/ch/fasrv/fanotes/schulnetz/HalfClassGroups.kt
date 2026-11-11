package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import java.time.temporal.IsoFields

/** One selectable course inside a [GroupSet] (for example one half-class group). */
data class GroupOption(val label: String, val title: String, val lessonsPerWeek: Int, val teacher: String)

/** Courses that are alternatives of each other: a student attends one of them. [key] is stable across runs. */
data class GroupSet(val key: String, val options: List<GroupOption>)

private data class GroupFamily(val family: String)

/** Name families: `-Sem1`/`-Sem2`, `<name> <n>.<m>` and `spf`/`spm` (also `SPF_...`/`SPM_...`). */
private fun groupFamily(label: String): GroupFamily? {
    val text = label.trim().lowercase()
    Regex("""^(.+?)[-_]sem([12])$""").find(text)?.let { return GroupFamily(it.groupValues[1].trim() + "|sem") }
    Regex("""^(.+?)\s+(\d+)\.(\d+)$""").find(text)?.let { return GroupFamily(it.groupValues[1].trim() + " " + it.groupValues[2]) }
    if (Regex("""^sp[fm](?:[_\s-].*)?$""").matches(text)) return GroupFamily("sp")
    return null
}

private fun slotDate(event: AgendaEvent): LocalDate? = runCatching { LocalDate.parse(event.start.trim().take(10)) }.getOrNull()

/**
 * Finds sets of courses of which a student attends only one. Sources: courses taught in the same time
 * slot (at least twice and for at least half of the smaller course's lessons) and name families.
 * Cancelled lessons and non-lessons are ignored; sets with an option under two lessons are dropped.
 */
fun detectGroupSets(lessons: List<AgendaEvent>): List<GroupSet> {
    val byLabel = linkedMapOf<String, MutableList<AgendaEvent>>()
    val names = hashMapOf<String, String>()
    for (event in lessons) {
        if (!event.isLesson() || event.isCancelled()) continue
        val label = event.label.trim()
        if (label.isEmpty()) continue
        val id = label.lowercase()
        names.putIfAbsent(id, label)
        byLabel.getOrPut(id) { mutableListOf() }.add(event)
    }
    if (byLabel.size < 2) return emptyList()
    val parent = HashMap<String, String>()
    fun find(x: String): String {
        var r = x
        while ((parent[r] ?: r) != r) r = parent[r]!!
        parent[x] = r
        return r
    }
    fun union(a: String, b: String) { parent[find(a)] = find(b) }

    // Source a: slot overlap.
    val slots = HashMap<String, MutableList<String>>()
    byLabel.forEach { (id, events) -> events.map { it.start.trim() }.toSet().forEach { slots.getOrPut(it) { mutableListOf() }.add(id) } }
    val shared = HashMap<Pair<String, String>, Int>()
    for (ids in slots.values) {
        if (ids.size < 2) continue
        val sorted = ids.sorted()
        for (i in sorted.indices) for (j in i + 1 until sorted.size) shared.merge(sorted[i] to sorted[j], 1, Int::plus)
    }
    for ((pair, count) in shared) {
        val smaller = minOf(byLabel[pair.first]!!.size, byLabel[pair.second]!!.size)
        if (count >= 2 && count * 2 >= smaller) union(pair.first, pair.second)
    }
    // Source b: name families.
    val families = HashMap<String, MutableList<String>>()
    byLabel.keys.forEach { id -> groupFamily(names[id]!!)?.let { families.getOrPut(it.family) { mutableListOf() }.add(id) } }
    families.values.filter { it.size >= 2 }.forEach { members -> members.drop(1).forEach { union(members[0], it) } }

    val groups = byLabel.keys.groupBy { find(it) }.values.filter { it.size >= 2 }
    return groups.mapNotNull { ids ->
        if (ids.any { byLabel[it]!!.size < 2 }) return@mapNotNull null
        val sortedIds = ids.sorted()
        val options = sortedIds.map { id ->
            val events = byLabel[id]!!
            val weeks = events.mapNotNull { slotDate(it) }.map { it.get(IsoFields.WEEK_BASED_YEAR) * 100 + it.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR) }.toSet().size.coerceAtLeast(1)
            val teacher = events.map { it.teachers.filter(String::isNotBlank).joinToString(", ") }.filter { it.isNotBlank() }
                .groupingBy { it }.eachCount().maxByOrNull { it.value }?.key.orEmpty()
            GroupOption(names[id]!!, preferredEventTitle(events.first()), Math.round(events.size.toDouble() / weeks).toInt().coerceAtLeast(1), teacher)
        }
        GroupSet(sortedIds.joinToString("|"), options)
    }.sortedBy { it.key }
}

/**
 * True for a lesson of a course in a set where the student picked other courses. Sets without a choice
 * (or whose choice names no course of the set) hide nothing. Exams are never hidden.
 */
fun lessonHiddenByGroup(event: AgendaEvent, sets: List<GroupSet>, choices: Map<String, List<String>>): Boolean {
    if (choices.isEmpty() || sets.isEmpty() || !event.isLesson()) return false
    val label = event.label.trim().lowercase()
    for (set in sets) {
        if (set.options.none { it.label.trim().lowercase() == label }) continue
        val chosen = chosenLabels(set, choices)
        return chosen.isNotEmpty() && label !in chosen
    }
    return false
}

/** Lowercased chosen labels of [set] that really are options of it; empty means show all. */
fun chosenLabels(set: GroupSet, choices: Map<String, List<String>>): Set<String> {
    val valid = set.options.map { it.label.trim().lowercase() }.toSet()
    return choices[set.key].orEmpty().map { it.trim().lowercase() }.filter { it in valid }.toSet()
}

/** A timetable change that mentions only a course the student did not choose. */
fun changeHiddenByGroup(change: SchulnetzChange, sets: List<GroupSet>, choices: Map<String, List<String>>): Boolean {
    if (change.category != "timetable" || choices.isEmpty() || sets.isEmpty()) return false
    val body = (change.title + " " + change.body).lowercase()
    return sets.any { set ->
        val chosen = chosenLabels(set, choices)
        if (chosen.isEmpty()) return@any false
        val mentioned = set.options.map { it.label.trim().lowercase() }.filter { body.contains(it) }
        mentioned.isNotEmpty() && mentioned.none { it in chosen }
    }
}
