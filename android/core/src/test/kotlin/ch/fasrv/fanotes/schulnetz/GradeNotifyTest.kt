package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class GradeNotifyTest {
    private val original = SchoolGrade(
        "web:MA-4a-He:20.10.2026:Probe:5.5", "MA-4a-He", "MA-4a-He", "MA-4a-He",
        "Probe", "2026-10-20", 5.5, 1.0, true, null, "",
    )
    private val reparsed = SchoolGrade(
        "api-99", "Mathematik", "math", "Mathematik",
        "Probe", "20.10.2026", 5.5, 1.0, true, null, "",
    )

    @Test
    fun redeploySeedsKnownGradesAndDoesNotAnnounceThem() {
        assertEquals("2026-10-20", normalizeGradeDate("20.10.2026"))
        assertEquals(gradeLooseHash(original), gradeLooseHash(reparsed))
        val hashed = SchoolGrade("g1", "Mathematik", "math", "Mathematik", "Probe", "2026-10-20", 5.5, 1.0, true, null, "")
        assertEquals("7a0eaaf2", gradeContentHash(hashed))
        assertEquals("38afa78f", gradeLooseHash(hashed))
        val lookedNew = diffSnapshots(SchulnetzSnapshot(), SchulnetzSnapshot(grades = listOf(reparsed)))
        assertEquals("Neue Note", lookedNew.single { it.category == "grade" }.title)
        val seeded = settleGradeNotifications(lookedNew, listOf(original, reparsed), null)
        assertTrue(seeded.migrated)
        assertTrue(seeded.changes.none { it.category == "grade" })
        assertTrue(seeded.keys.contains("l:${gradeLooseHash(original)}"))
    }

    @Test
    fun modelChangeWithANewRowIdIsNotANewGrade() {
        val quiet = diffSnapshots(
            SchulnetzSnapshot(grades = listOf(original)),
            SchulnetzSnapshot(grades = listOf(reparsed)),
        )
        assertTrue(quiet.none { it.category == "grade" })
        val wiped = diffSnapshots(SchulnetzSnapshot(), SchulnetzSnapshot(grades = listOf(reparsed)))
        val settled = settleGradeNotifications(wiped, listOf(reparsed), gradeLedgerEntries(listOf(original)))
        assertFalse(settled.migrated)
        assertTrue(settled.changes.none { it.category == "grade" })
    }

    @Test
    fun appUpdateSeedsTheLocalSnapshotAndSkipsTheIdChange() {
        val lookedNew = diffSnapshots(SchulnetzSnapshot(), SchulnetzSnapshot(grades = listOf(reparsed)))
        val update = settleGradeNotifications(lookedNew, listOf(reparsed), null)
        assertTrue(update.migrated)
        assertTrue(update.changes.none { it.category == "grade" })
        assertTrue(update.keys.isNotEmpty())
    }

    @Test
    fun bothDeliveryPathsAnnounceAChangedMarkOnce() {
        val edited = reparsed.copy(mark = 4.5)
        val changes = diffSnapshots(
            SchulnetzSnapshot(grades = listOf(reparsed)),
            SchulnetzSnapshot(grades = listOf(edited)),
        )
        assertEquals("Notenänderung", changes.single { it.category == "grade" }.title)
        val server = settleGradeNotifications(changes, listOf(edited), emptySet())
        assertEquals(1, server.changes.count { it.category == "grade" })
        val pushed = prepareGradeNotifications(server.changes, guessGrades = false, snapshot = SchulnetzSnapshot(grades = listOf(edited)))
        assertEquals(server.changes.single().gradeKeys, pushed.single().gradeKeys)
        val phone = settleGradeNotifications(pushed, listOf(edited), server.keys)
        assertTrue(phone.changes.none { it.category == "grade" })
        val again = settleGradeNotifications(changes, listOf(edited), server.keys)
        assertTrue(again.changes.none { it.category == "grade" })
        val payload = notifyPayload(pushed.single())
        val echoed = changeFromPayload(payload)
        assertEquals(pushed.single().gradeKeys, echoed?.gradeKeys)
        val fromPush = settleGradeNotifications(listOfNotNull(echoed), listOf(edited), server.keys)
        assertTrue(fromPush.changes.none { it.category == "grade" })
    }
}
