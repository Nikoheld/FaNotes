package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify
import java.time.Instant
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class SchoolStatsTest {
    private fun resource(name: String): String = checkNotNull(javaClass.getResource("/schulnetz/$name")) { name }.readText()

    private fun num(value: Number) = jsonNumber(value.toDouble())
    private fun numOrNull(value: Double?): JsonValue = value?.let { jsonNumber(it) } ?: JsonValue.Null

    private fun counts(c: LessonCounts) = listOf(
        "total" to num(c.total), "cancelled" to num(c.cancelled), "substituted" to num(c.substituted),
        "moved" to num(c.moved), "changed" to num(c.changed), "added" to num(c.added), "rate" to jsonNumber(c.rate),
    )

    private fun toJson(stats: SchoolStats): JsonValue.Obj {
        val c = stats.cancellations
        val g = stats.grading
        return jsonObject(
            "cancellations" to jsonObject(
                "totals" to jsonObject(*counts(c.totals).toTypedArray()),
                "courses" to JsonValue.Arr(c.courses.map {
                    jsonObject("key" to jsonString(it.key), "title" to jsonString(it.title), "teacher" to jsonString(it.teacher), *counts(it.counts).toTypedArray()) as JsonValue
                }.toMutableList()),
                "weekdays" to JsonValue.Arr(c.weekdays.map { jsonObject("weekday" to num(it.weekday), "total" to num(it.total), "cancelled" to num(it.cancelled)) as JsonValue }.toMutableList()),
                "clocks" to JsonValue.Arr(c.clocks.map { jsonObject("clock" to jsonString(it.clock), "total" to num(it.total), "cancelled" to num(it.cancelled)) as JsonValue }.toMutableList()),
                "coverage" to jsonObject("firstDay" to jsonString(c.coverage.firstDay), "lastDay" to jsonString(c.coverage.lastDay), "weeks" to num(c.coverage.weeks)),
                "recent" to JsonValue.Arr(c.recent.map { jsonObject("day" to jsonString(it.day), "title" to jsonString(it.title), "clock" to jsonString(it.clock)) as JsonValue }.toMutableList()),
            ),
            "grading" to jsonObject(
                "count" to num(g.count), "median" to numOrNull(g.median), "mean" to numOrNull(g.mean),
                "courses" to JsonValue.Arr(g.courses.map {
                    jsonObject(
                        "key" to jsonString(it.key), "title" to jsonString(it.title), "teacher" to jsonString(it.teacher), "count" to num(it.count),
                        "median" to jsonNumber(it.median), "mean" to jsonNumber(it.mean), "fastest" to num(it.fastest), "slowest" to num(it.slowest),
                    ) as JsonValue
                }.toMutableList()),
                "recent" to JsonValue.Arr(g.recent.map {
                    jsonObject("title" to jsonString(it.title), "course" to jsonString(it.course), "testDay" to jsonString(it.testDay), "delay" to num(it.delay)) as JsonValue
                }.toMutableList()),
            ),
            "waiting" to JsonValue.Arr(stats.waiting.map {
                jsonObject("title" to jsonString(it.title), "course" to jsonString(it.course), "examDay" to jsonString(it.examDay), "daysWaiting" to num(it.daysWaiting)) as JsonValue
            }.toMutableList()),
            "gradeChanges" to jsonObject(
                "count" to num(stats.gradeChanges.count),
                "items" to JsonValue.Arr(stats.gradeChanges.items.map {
                    jsonObject("title" to jsonString(it.title), "course" to jsonString(it.course), "firstSeenDay" to jsonString(it.firstSeenDay), "versions" to num(it.versions)) as JsonValue
                }.toMutableList()),
            ),
            "examLoad" to jsonObject(
                "weeks" to JsonValue.Arr(stats.examLoad.weeks.map { jsonObject("monday" to jsonString(it.monday), "count" to num(it.count)) as JsonValue }.toMutableList()),
                "busiestMonday" to jsonString(stats.examLoad.busiestMonday), "busiestCount" to num(stats.examLoad.busiestCount), "next28" to num(stats.examLoad.next28),
            ),
            "absences" to JsonValue.Arr(stats.absences.map {
                jsonObject("subject" to jsonString(it.subject), "count" to num(it.count), "excused" to num(it.excused)) as JsonValue
            }.toMutableList()),
        )
    }

    /** Structural equality; numbers compare by value so 1 and 1.0 are the same. Returns the path of the first difference. */
    private fun diff(path: String, want: JsonValue?, got: JsonValue?): String? = when {
        want is JsonValue.Obj && got is JsonValue.Obj -> {
            val keys = want.fields.keys + got.fields.keys
            keys.firstNotNullOfOrNull { diff("$path.$it", want.fields[it], got.fields[it]) }
        }
        want is JsonValue.Arr && got is JsonValue.Arr ->
            if (want.items.size != got.items.size) "$path: size ${want.items.size} != ${got.items.size}"
            else want.items.indices.firstNotNullOfOrNull { diff("$path[$it]", want.items[it], got.items[it]) }
        want is JsonValue.Num && got is JsonValue.Num -> if (abs(want.value - got.value) < 1e-9) null else "$path: ${want.value} != ${got.value}"
        else -> if (want == got) null else "$path: $want != $got"
    }

    /** The same cases run in kanti-web/test/stats.test.ts, so the app and the browser show the same numbers. */
    @Test
    fun sharedCasesGiveTheSameStatistics() {
        val root = parseJson(resource("school-stats-cases.json")) as JsonValue.Obj
        val cases = root.array("cases")!!.items.map { it as JsonValue.Obj }
        assertTrue(cases.size >= 8)
        for (case in cases) {
            val name = case.string("name")!!
            val snapshot = assertNotNull(parseNormalizedSnapshot(case.obj("snapshot")!!.stringify()), name)
            val stats = schoolStats(snapshot, Instant.parse(case.string("now")!!))
            val difference = diff(name, case.obj("expected"), toJson(stats))
            assertEquals(null, difference, difference)
        }
    }

    @Test
    fun noMarkIsPartOfTheResult() {
        val root = parseJson(resource("school-stats-cases.json")) as JsonValue.Obj
        val snapshot = parseNormalizedSnapshot(root.array("cases")!!.items.map { it as JsonValue.Obj }.first { it.string("name")!!.startsWith("grading time: seed") }.obj("snapshot")!!.stringify())!!
        val text = toJson(schoolStats(snapshot, Instant.parse("2026-11-25T10:00:00Z"))).stringify()
        assertTrue(!text.contains("\"mark\""))
    }
}
