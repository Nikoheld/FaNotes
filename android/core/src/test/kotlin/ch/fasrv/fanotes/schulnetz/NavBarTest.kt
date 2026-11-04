package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class NavBarTest {
    @Test
    fun emptyOrUnknownFallsBackToDefault() {
        assertEquals(DEFAULT_NAV_BAR, validateNavBar(null))
        assertEquals(DEFAULT_NAV_BAR, validateNavBar(emptyList()))
        assertEquals(DEFAULT_NAV_BAR, validateNavBar(listOf("nope", " ", "HOME")))
        assertEquals(listOf("today", "planner", "notes", "school"), DEFAULT_NAV_BAR)
    }

    @Test
    fun knownItemsAreKeptWithinMaterialLimits() {
        assertEquals(listOf("grades", "today"), validateNavBar(listOf("grades")))
        assertEquals(listOf("today", "notes", "settings"), validateNavBar(listOf("today", "notes", "settings")))
        assertEquals(
            listOf("today", "planner", "notes", "school", "grades"),
            validateNavBar(listOf("today", "planner", "notes", "school", "grades", "exams")),
        )
        assertEquals(listOf("today", "notes"), validateNavBar(listOf("Today", "notes", "today", "mystery")))
    }

    @Test
    fun addRemoveAndMoveStayValid() {
        val start = DEFAULT_NAV_BAR
        assertEquals(start, addNavBarItem(start, "today"))
        val withGrades = addNavBarItem(start, "grades")
        assertEquals(listOf("today", "planner", "notes", "school", "grades"), withGrades)
        assertEquals(withGrades, addNavBarItem(withGrades, "exams"))
        assertEquals(listOf("today", "notes", "school", "grades"), removeNavBarItem(withGrades, "planner"))
        assertEquals(listOf("today", "notes"), removeNavBarItem(listOf("today", "notes"), "notes"))
        assertEquals(listOf("planner", "today", "notes", "school"), moveNavBarItem(start, 0, 1))
        assertEquals(start, moveNavBarItem(start, 0, -1))
        assertEquals(listOf("tasks", "grades", "exams", "absences", "updates", "statement", "settings"), remainingNavBar(start))
    }

    @Test
    fun startTabAliasesAndHomeFallback() {
        assertEquals("today", startTabId("Heute"))
        assertEquals("planner", startTabId("Plan"))
        assertEquals("notes", startTabId("Notizen"))
        assertEquals("school", startTabId("Mehr"))
        assertEquals("grades", startTabId("Noten"))
        assertEquals("tasks", startTabId("to-dos"))
        assertEquals("settings", startTabId("Einstellungen"))
        assertEquals("today", startTabId("unknown"))
        val bar = listOf("notes", "grades")
        assertEquals("grades", homeNavId("Noten", bar))
        assertEquals("notes", homeNavId("Heute", bar))
        assertEquals("today", homeNavId("Heute", DEFAULT_NAV_BAR))
    }

    @Test
    fun schoolModeDropsNotesAndKeepsACompleteBar() {
        assertEquals(listOf("today", "planner", "grades", "school"), SCHOOL_NAV_BAR)
        assertEquals(SCHOOL_NAV_BAR, presentedNavBar(null, notes = false))
        assertEquals(SCHOOL_NAV_BAR, presentedNavBar(DEFAULT_NAV_BAR, notes = false))
        assertEquals(DEFAULT_NAV_BAR, presentedNavBar(DEFAULT_NAV_BAR, notes = true))
        assertEquals(listOf("today", "grades", "school"), presentedNavBar(listOf("today", "notes", "grades", "school"), notes = false))
        assertEquals(listOf("grades", "today"), presentedNavBar(listOf("grades"), notes = false))
        assertEquals(false, presentedNavBar(listOf("today", "planner", "notes", "exams"), notes = false).contains("notes"))
    }

    @Test
    fun deskPrefsRoundTripNavBarAndKeepOlderFiles() {
        val stored = parseDeskPrefs(serializeDeskPrefs(DeskPrefs(startTab = "grades", navBar = listOf("grades", "notes", "settings"))))
        assertEquals(listOf("grades", "notes", "settings"), stored.navBar)
        assertEquals("grades", stored.startTab)
        val legacy = parseDeskPrefs("""{"accent":"#2a6f97","theme":"system","amoled":false,"todayCards":[],"hiddenCards":[],"startTab":"Noten"}""")
        assertEquals(DEFAULT_NAV_BAR, legacy.navBar)
        assertEquals("Noten", legacy.startTab)
        val reset = parseDeskPrefs(serializeDeskPrefs(DeskPrefs(navBar = listOf("bogus"))))
        assertEquals(DEFAULT_NAV_BAR, reset.navBar)
    }
}
