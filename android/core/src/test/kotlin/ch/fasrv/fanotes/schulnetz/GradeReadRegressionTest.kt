package ch.fasrv.fanotes.schulnetz

import kotlin.test.*

class GradeReadRegressionTest {
    private fun fixture(name: String) = checkNotNull(javaClass.getResource("/schulnetz/$name")).readText()
    private fun grades() = readGradesPage(fixture("noten-multi-course.html")).value

    @Test fun layoutHeadingsNeverBecomeCoursesOrMergeExamLists() {
        val read = readGradesPage(fixture("noten-multi-course.html"))
        assertNull(read.error)
        assertEquals(18, read.value.size)
        assertEquals(setOf("Alpha-K26A-1", "Beta-K26A-1", "Gamma-K26A-1"), read.value.map { it.courseId }.toSet())
        assertEquals(listOf(6, 6, 6), read.value.groupBy { it.courseId }.values.map { it.size })
        for ((index, subject) in listOf("Alpha", "Beta", "Gamma").withIndex()) {
            val marks = read.value.filter { it.courseId == "$subject-K26A-1" }
            assertTrue(marks.all { it.title.startsWith("Exercise ${index + 1}-") })
            assertTrue(marks.all { it.mark == 3 + (index + 1) / 2.0 })
        }
        assertTrue(read.value.none { placeholderCourse(it.courseLabel) })
    }

    @Test fun blockedOrZeroSuccessfulPagesCannotReplaceEighteenGradesWithSevenMergedMarks() {
        val previous = SchulnetzSnapshot(grades = grades())
        val fake = previous.grades.take(7).map { it.copy(course = "Fach Kurs", courseId = "Fach Kurs", subject = "Fach Kurs") }
        val partial = previous.copy(grades = fake)
        for ((blocked, okPages) in listOf(true to 0, true to 3, false to 0)) {
            val kept = keepStoredRead(previous, partial, blocked, timetableFailed = false, okPages = okPages)
            assertEquals(previous.grades, kept.grades)
            assertFalse(kept.gradesReadComplete)
            assertEquals(previous.grades, assertNotNull(parseNormalizedSnapshot(kept.toNormalizedJson())).grades)
        }
        assertEquals(previous.grades, keepGradeRead(previous.grades, fake, complete = true))
        assertEquals(previous.grades, keepStoredRead(previous, previous.copy(grades = grades().take(7)), false, false, gradesComplete = false).grades)
    }

    @Test fun anUnownedExamMakesANonemptyParsePartialAndKeepsThePreviousGrades() {
        val source = fixture("noten-multi-course.html")
        val orphan = "<table><tr><td>07.11.2026</td><td>Unowned exercise</td><td>4.5</td><td>1</td></tr></table>"
        val read = readGradesPage(source.replace("</main>", "$orphan</main>"))
        assertNotNull(read.error)
        assertTrue(read.value.isEmpty())
        assertEquals(grades(), keepGradeRead(grades(), read.value, read.error == null))
    }

    @Test fun siblingCourseTablesDoNotLoseAllButTheFirstCourse() {
        val html = listOf("Alpha", "Beta", "Gamma").joinToString("", "<main>", "</main>") { course ->
            "<table><tr><td><b>$course-K26A-1</b></td><td>5</td></tr><tr><td><table>" +
                "<tr><td>01.11.2026</td><td>Exercise</td><td>5</td><td>1</td></tr></table></td></tr></table>"
        }
        val read = readGradesPage(html)
        assertNull(read.error)
        assertEquals(3, read.value.map { it.courseId }.toSet().size)
    }

    @Test fun inactivityIpRejectionAndLoginWallsCannotSupplyGrades() {
        val html = fixture("blocked-start-grades.html")
        for (body in listOf(html, html.replace("Inaktivitätslimit überschritten", "Ihre IP-Adresse wurde vom System zurückgewiesen"),
            "<html><body>ConvergedSignIn</body></html>")) {
            assertTrue(readGradesPage(body).value.isEmpty())
        }
        assertTrue(parseGradesByHeader("<table><tr><th>Datum</th><th>Note</th></tr><tr><td>01.11.2026</td><td>4</td></tr></table>").isEmpty())
    }
}
