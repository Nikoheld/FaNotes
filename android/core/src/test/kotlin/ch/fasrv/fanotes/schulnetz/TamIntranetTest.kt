package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** TAM intranet parsing against synthetic fixtures in the documented shape (core/src/test/resources/tam). */
class TamIntranetTest {
    private fun fixture(name: String): String =
        requireNotNull(javaClass.classLoader.getResource("tam/$name")) { name }.readText()

    private val root = "https://intranet.tam.ch/bmz"

    @Test fun anyIntranetSchoolAddressBecomesItsRoot() {
        assertEquals(root, tamSchoolRoot("https://intranet.tam.ch/bmz"))
        assertEquals(root, tamSchoolRoot("intranet.tam.ch/bmz/timetable/classbook"))
        assertEquals(root, tamSchoolRoot("  BMZ "))
        assertEquals("https://intranet.tam.ch/kzo", tamSchoolRoot("https://intranet.tam.ch/kzo/"))
        // Not TAM, not https, not a school.
        for (bad in listOf("https://evil.example/bmz", "http://intranet.tam.ch/bmz", "https://intranet.tam.ch/", "https://intranet.tam.ch/auth/azure", "", "b", "../x")) {
            assertNull(tamSchoolRoot(bad), bad)
        }
        assertEquals("TAM BMZ", defaultConnectionLabel(SchoolProvider.TAM, root))
    }

    @Test fun signedInMeansNoPasswordFormAndACsrfToken() {
        // The login page has a csrfToken too, so the password form decides.
        assertFalse(tamSignedIn("https://intranet.tam.ch/bmz", fixture("login.html"), root))
        val page = fixture("signed-in.html")
        assertTrue(tamSignedIn("https://intranet.tam.ch/bmz/list/get-person-detail-list/list/30", page, root))
        // Another school's page or another host is not this connection.
        assertFalse(tamSignedIn("https://intranet.tam.ch/kzo", page, root))
        assertFalse(tamSignedIn("https://login.microsoftonline.com/common", page, root))
        assertEquals("9f8e7d6c5b4a39281706f5e4d3c2b1a0", tamCsrfToken(page))
        assertEquals("424242", tamPersonId(page))
        assertNull(tamPersonId(fixture("login.html")))
    }

    @Test fun onlyReadsAreAllowedTowardsTheSchool() {
        assertTrue(tamReadAllowed("GET", "$root/gradebook", root))
        assertTrue(tamReadAllowed("GET", "$root/list/index/list/112", root))
        assertTrue(tamReadAllowed("POST", "$root/timetable/ajax-get-timetable", root))
        // Every other POST, the sign-in form, logout, saves, another school, http.
        for ((method, url) in listOf(
            "POST" to root,
            "POST" to "$root/default/login/key",
            "POST" to "$root/timetable/ajax-save-lesson-home-work-data",
            "GET" to "$root/logout",
            "GET" to "$root/default/login/temporary-password",
            "GET" to "https://intranet.tam.ch/kzo/gradebook",
            "GET" to "http://intranet.tam.ch/bmz/gradebook",
            "PUT" to "$root/gradebook",
        )) assertFalse(tamReadAllowed(method, url, root), "$method $url")
        assertTrue(tamActionBlocked("$root/logout"))
        assertFalse(tamActionBlocked("$root/timetable/classbook"))
        // The sign-in page may pass through the identity providers, never plain http.
        assertTrue(tamLoginWebViewAllowed("https://login.microsoftonline.com/common/oauth2/v2.0/authorize"))
        assertFalse(tamLoginWebViewAllowed("http://intranet.tam.ch/bmz"))
    }

    @Test fun aTimetableWeekBecomesLessonsExamsAndHolidays() {
        val week = parseTamTimetable(fixture("timetable-week.json"))
        assertNotNull(week)
        assertEquals(5, week.lessons.size)
        val math = week.lessons.first { it.id == "tam-9001" }
        assertEquals("2026-11-16T07:40:00", math.start)
        assertEquals("2026-11-16T08:25:00", math.end)
        assertEquals("Mathematik", math.text)
        assertEquals("B101", math.room)
        assertEquals(listOf("Lehrperson Xa"), math.teachers)
        assertTrue(math.isLesson())
        assertEquals("2026-11-16", weekMondayKey(math.start))
        // Cancelled, room change, substitution: the app's own markers.
        assertTrue(week.lessons.first { it.id == "tam-9002" }.isCancelled())
        assertEquals("Raumänderung", week.lessons.first { it.id == "tam-9003" }.comment)
        assertEquals(listOf("Zc"), week.lessons.first { it.id == "tam-9003" }.teachers)
        assertTrue(week.lessons.first { it.id == "tam-9004" }.isSubstitution())
        assertEquals("2026-11-18T13:30:00", week.lessons.first { it.id == "tam-9004" }.start)
        // An exam lesson is a lesson and an exam.
        val exam = week.exams.single()
        assertTrue(exam.isExamLike())
        assertEquals("2026-11-19T07:40:00", exam.start)
        // An all-day holiday is not a lesson.
        assertEquals(listOf("2026-11-20"), week.holidays.map { it.start })
        // The request for that week: Monday 00:00 to Sunday 23:59:59.999 in Zurich, own id only.
        val form = tamTimetableForm("424242", LocalDate.parse("2026-11-16")).toMap()
        assertEquals("424242", form["studentId[]"])
        assertEquals("0", form["holidaysOnly"])
        assertEquals(7 * 24 * 3600 * 1000L - 1, form.getValue("endDate").toLong() - form.getValue("startDate").toLong())
        assertEquals(LocalDate.parse("2026-11-16"), tamWeekMonday(LocalDate.parse("2026-11-22")))
    }

    @Test fun anAnswerThatIsNotATimetableIsNotAFreeWeek() {
        assertNull(parseTamTimetable("<html>Anmelden</html>"))
        assertNull(parseTamTimetable("""{"status":0,"data":[]}"""))
        assertNull(parseTamTimetable("""{"message":"Session expired"}"""))
        // A real empty week is an empty week.
        assertEquals(0, parseTamTimetable("""{"status":1,"data":[]}""")?.lessons?.size)
    }

    @Test fun absencesComeFromTheListGrid() {
        val absences = parseTamAbsences(fixture("absences-list112.html"))
        assertNotNull(absences)
        assertEquals(3, absences.size)
        val first = absences.first()
        assertEquals("tam-abs-77001", first.id)
        assertEquals("2026-11-03", first.dateFrom)
        assertEquals("Mathematik MAT-BM2a", first.subject)
        assertEquals("Krankheit", first.reason)
        assertTrue(first.excused)
        assertFalse(absences[1].excused)
        assertFalse(absences[1].acknowledged)
        // Braces and quotes inside strings do not end the grid early.
        assertEquals("Sport {Halle}", absences[2].subject)
        assertFalse(absences[2].excused)
        assertNull(parseTamAbsences(fixture("login.html")))
    }

    @Test fun gradesComeFromTheRenderedGradebook() {
        val grades = parseTamGradebook(fixture("gradebook-rendered.html"))
        assertNotNull(grades)
        // Average rows (no date, no weight) are not grades; a course without grades adds none.
        assertEquals(4, grades.size)
        val algebra = grades.first { it.title == "Algebra Test" }
        assertEquals(5.0, algebra.mark)
        assertEquals("2026-10-02", algebra.date)
        assertEquals("MAT-BM2a Mathematik", algebra.course)
        assertEquals(4.5, grades.first { it.title == "Funktionen" }.mark)
        assertEquals(0.5, grades.first { it.title == "Funktionen" }.weight)
        assertNull(grades.first { it.title == "Geometrie" }.mark)
        assertEquals(2.0, grades.first { it.title == "Aufsatz" }.weight)
        assertNull(parseTamGradebook(fixture("signed-in.html")))
    }
}
