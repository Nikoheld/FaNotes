package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class BundleMissingPageTest {
    @Test
    fun germanByDefaultAndEnglishOnRequest() {
        assertTrue("Nicht in diesem Build enthalten" in bundleMissingPage("de"))
        assertTrue("Nicht in diesem Build enthalten" in bundleMissingPage("fr"))
        assertTrue("Not included in this build" in bundleMissingPage("en"))
        assertFalse("ß" in bundleMissingPage("de"))
    }
}
