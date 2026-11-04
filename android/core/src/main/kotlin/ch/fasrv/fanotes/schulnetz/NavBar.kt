package ch.fasrv.fanotes.schulnetz

const val NAV_BAR_MIN = 2
const val NAV_BAR_MAX = 5

val NAV_BAR_IDS = listOf(
    "today",
    "planner",
    "tasks",
    "notes",
    "school",
    "grades",
    "exams",
    "absences",
    "updates",
    "statement",
    "settings",
)

val DEFAULT_NAV_BAR = listOf("today", "planner", "notes", "school")

private val NAV_BAR_KNOWN = NAV_BAR_IDS.toSet()

fun validateNavBar(raw: List<String>?): List<String> {
    val cleaned = raw.orEmpty().map { it.trim().lowercase() }.filter { it in NAV_BAR_KNOWN }.distinct()
    if (cleaned.isEmpty()) return DEFAULT_NAV_BAR
    if (cleaned.size > NAV_BAR_MAX) return cleaned.take(NAV_BAR_MAX)
    if (cleaned.size < NAV_BAR_MIN) {
        val fill = (DEFAULT_NAV_BAR + NAV_BAR_IDS).filter { it !in cleaned }
        return (cleaned + fill).take(NAV_BAR_MIN)
    }
    return cleaned
}

fun addNavBarItem(current: List<String>, id: String): List<String> {
    val bar = validateNavBar(current)
    val next = id.trim().lowercase()
    if (bar.size >= NAV_BAR_MAX || next !in NAV_BAR_KNOWN || next in bar) return bar
    return bar + next
}

fun removeNavBarItem(current: List<String>, id: String): List<String> {
    val bar = validateNavBar(current)
    if (bar.size <= NAV_BAR_MIN) return bar
    val next = bar.filter { it != id.trim().lowercase() }
    return if (next.size < NAV_BAR_MIN) bar else next
}

fun moveNavBarItem(current: List<String>, index: Int, delta: Int): List<String> {
    val bar = validateNavBar(current).toMutableList()
    val target = index + delta
    if (index !in bar.indices || target !in bar.indices) return bar
    val item = bar.removeAt(index)
    bar.add(target, item)
    return bar
}

fun remainingNavBar(current: List<String>): List<String> {
    val bar = validateNavBar(current).toSet()
    return NAV_BAR_IDS.filter { it !in bar }
}

fun startTabId(raw: String): String = when (raw.trim().lowercase()) {
    "", "heute", "today" -> "today"
    "plan", "planner" -> "planner"
    "aufgaben", "tasks", "todos", "to-dos", "to-do" -> "tasks"
    "notizen", "notes" -> "notes"
    "mehr", "school" -> "school"
    "noten", "grades" -> "grades"
    "pruefungen", "prüfungen", "exams" -> "exams"
    "absenzen", "absences" -> "absences"
    "termine", "updates", "agenda" -> "updates"
    "konto", "statement", "account" -> "statement"
    "einstellungen", "settings" -> "settings"
    else -> raw.trim().lowercase().takeIf { it in NAV_BAR_KNOWN } ?: "today"
}

/** Back-stack home: the start tab when it is still on the bar, otherwise the first bar item. */
fun homeNavId(startTab: String, bar: List<String>): String {
    val shown = validateNavBar(bar)
    val start = startTabId(startTab)
    return if (start in shown) start else shown.first()
}
