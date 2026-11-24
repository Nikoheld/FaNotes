package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class GradeHistoryTest {
    private fun resource(name: String): String = checkNotNull(javaClass.getResource("/schulnetz/$name")) { name }.readText()

    private fun grades(value: JsonValue?): List<SchoolGrade> = (value as JsonValue.Arr).items.map { item ->
        val g = item as JsonValue.Obj
        SchoolGrade(
            id = g.string("id").orEmpty(), course = g.string("course").orEmpty(), courseId = g.string("courseId").orEmpty(),
            subject = g.string("subject").orEmpty(), title = g.string("title").orEmpty(), date = g.string("date").orEmpty(),
            mark = g.double("mark"), weight = g.double("weight") ?: 1.0, confirmed = true, courseGrade = null, comment = "",
        )
    }

    private fun generated(count: Int): List<GradeTrack> = (1..count).map { n ->
        val seen = "2020-01-01T00:00:00.000Z"
        GradeTrack(
            id = "g$n", gradeId = "old-$n", courseId = "c", course = "C", title = "t $n", date = "2020-01-01", firstSeenAt = seen,
            versions = listOf(GradeVersion(4.0, 1.0, "t $n", "2020-01-01", seen)),
            removedAt = "2021-01-01T00:00:00.${n.toString().padStart(5, '0')}Z",
        )
    }

    /** The same cases run in fanotes-site/grade-history.test.mjs, so server and app keep one history alike. */
    @Test
    fun sharedCasesKeepTheSameHistory() {
        val root = parseJson(resource("grade-history-cases.json")) as JsonValue.Obj
        val cases = (root.fields["cases"] as JsonValue.Arr).items.map { it as JsonValue.Obj }
        assertTrue(cases.size >= 15)
        for (case in cases) {
            val name = case.string("name")!!
            var history = case.obj("generate")?.double("removed")?.toInt()?.let { generated(it) } ?: parseGradeTracks(case.fields["history"])
            for (step in (case.fields["steps"] as JsonValue.Arr).items.map { it as JsonValue.Obj }) {
                history = updateGradeHistory(
                    history, grades(step.fields["previous"]), grades(step.fields["next"]),
                    at = step.string("at")!!, trusted = step.bool("trusted") == true,
                )
            }
            (case.fields["expect"] as? JsonValue.Arr)?.let { assertEquals(parseGradeTracks(it), history, name) }
            case.obj("expectVersions")?.fields?.forEach { (id, want) ->
                want as JsonValue.Obj
                val versions = history.first { it.id == id }.versions
                assertEquals(want.double("count")!!.toInt(), versions.size, name)
                assertEquals(want.double("first"), versions.first().mark, name)
                assertEquals(want.double("second"), versions[1].mark, name)
                assertEquals(want.double("last"), versions.last().mark, name)
            }
            case.obj("expectTracks")?.let { want ->
                assertEquals(want.double("count")!!.toInt(), history.size, name)
                for (id in want.array("absent")!!.items) assertFalse(history.any { it.id == (id as JsonValue.Str).value }, name)
                for (id in want.array("present")!!.items) assertTrue(history.any { it.id == (id as JsonValue.Str).value }, name)
            }
        }
    }

    @Test
    fun tracksSurviveTheirJsonForm() {
        val tracks = generated(3) + GradeTrack("g9", "x", "c", "C", "T", "2026-01-05", "2026-01-10T08:00:00.000Z", listOf(GradeVersion(null, 2.0, "T", "2026-01-05", "2026-01-10T08:00:00.000Z")), hidden = true)
        val text = gradeTracksToJson(tracks).stringify()
        assertEquals(tracks, parseGradeTracks(parseJson(text)))
    }

    @Test
    fun aParserUpgradeBaseMakesNoVersionsAndNoRemovals() {
        fun row(id: String, title: String, mark: Double?) = SchoolGrade(id, "Mathematik", "MAT", "Mathematik", title, "2026-01-05", mark, 1.0, true, null, "")
        val seeded = updateGradeHistory(emptyList(), emptyList(), listOf(row("a", "Test", 5.0)), "2026-01-10T08:00:00.000Z", false)
        val base = listOf(row("a", "Test: Funktionen", 5.0), row("b", "Info", 4.0))
        val after = updateGradeHistory(seeded, base, base, "2026-01-11T08:00:00.000Z", true)
        assertEquals(2, after.size)
        assertEquals(1, after[0].versions.size)
        assertEquals(null, after[0].removedAt)
    }

    @Test
    fun theSnapshotCarriesTheHistoryButNeverUploadsIt() {
        val track = GradeTrack("g1", "a", "MAT", "Mathematik", "Test", "2026-01-05", "2026-01-10T08:00:00.000Z",
            listOf(GradeVersion(4.0, 1.0, "Test", "2026-01-05", "2026-01-10T08:00:00.000Z"), GradeVersion(4.5, 1.0, "Test", "2026-01-05", "2026-01-11T08:00:00.000Z")))
        val snapshot = SchulnetzSnapshot(fetchedAt = "2026-01-11T08:00:00Z", gradeHistory = listOf(track))
        assertEquals(listOf(track), parseNormalizedSnapshot(snapshot.toNormalizedJson())?.gradeHistory)
        assertFalse(snapshot.toNormalizedJson(withHistory = false).contains("gradeHistory"))
    }

    @Test
    fun aServerSnapshotBringsItsHistoryAndAnOlderServerKeepsTheOnesOnThePhone() {
        val mine = GradeTrack("g1", "a", "MAT", "Mathematik", "Test", "2026-01-05", "t", listOf(GradeVersion(4.0, 1.0, "Test", "2026-01-05", "t")))
        val theirs = mine.copy(id = "g7")
        val phone = SchulnetzSnapshot(gradeHistory = listOf(mine))
        assertEquals(listOf(theirs), adoptServerSnapshot(phone, SchulnetzSnapshot(gradeHistory = listOf(theirs))).gradeHistory)
        assertEquals(listOf(mine), adoptServerSnapshot(phone, SchulnetzSnapshot()).gradeHistory)
    }

    @Test
    fun courseHelpersFindChangedAndRemovedGrades() {
        val changed = GradeTrack("g1", "a", "MAT", "Mathematik", "Test", "2026-01-05", "t",
            listOf(GradeVersion(4.0, 1.0, "Test", "2026-01-05", "t"), GradeVersion(4.5, 1.0, "Test", "2026-01-05", "u")))
        val once = changed.copy(id = "g2", title = "Quiz", versions = changed.versions.take(1).map { it.copy(title = "Quiz") })
        val gone = changed.copy(id = "g3", removedAt = "2026-02-01T00:00:00Z")
        val history = listOf(changed, once, gone)
        assertEquals(changed, gradeTrackFor(history, changed.targetId()))
        assertEquals(null, gradeTrackFor(history, once.targetId()))
        assertEquals(listOf(gone), removedGradeTracks(history, "MAT"))
        assertEquals(emptyList(), removedGradeTracks(history, "OTHER"))
    }
}
