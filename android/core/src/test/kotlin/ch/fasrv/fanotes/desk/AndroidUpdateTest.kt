package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AndroidUpdateTest {
    @Test
    fun versionOrderMatchesTheDesktopUpdater() {
        val nightly = "2026.10.2-nightly.20261011120000.abcdef0"
        assertTrue(compareReleaseVersions("2026.7.1-beta.2", "2026.7.1-beta.1") > 0)
        assertTrue(compareReleaseVersions("2026.7.1", "2026.7.1-beta.99") > 0)
        assertTrue(compareReleaseVersions("2026.7.2-beta.1", "2026.7.1") > 0)
        assertTrue(compareReleaseVersions(nightly, "2026.10.2") > 0)
        assertTrue(compareReleaseVersions("2026.10.2", "2026.10.2-beta.9") > 0)
        assertTrue(compareReleaseVersions("2026.10.3", nightly) > 0)
        assertTrue(compareReleaseVersions("2026.10.2-nightly.20261011120001.aaaaaaa", "2026.10.2-nightly.20261011120000.fffffff") > 0)
        assertTrue(compareReleaseVersions("2026.10.2-nightly.20261011120000.bbbbbbb", "2026.10.2-nightly.20261011120000.aaaaaaa") > 0)
        assertEquals(false, releaseVisibleOnChannel(nightly, "stable"))
        assertEquals(false, releaseVisibleOnChannel(nightly, "beta"))
        assertEquals(true, releaseVisibleOnChannel(nightly, "nightly"))
        assertEquals(true, releaseVisibleOnChannel("2026.10.2", "nightly"))
        assertEquals(false, releaseVisibleOnChannel("2026.10.2-beta.1", "nightly"))
        assertEquals(true, releaseVisibleOnChannel("2026.10.2-beta.1", "beta"))
        assertEquals(true, releaseVisibleOnChannel("2026.10.2", "stable"))
        assertEquals("stable", updateChannelId(null))
        assertEquals("stable", updateChannelId("nope"))
        assertEquals("beta", updateChannelId("beta"))
        assertFailsWith<IllegalArgumentException> { compareReleaseVersions("nope", "2026.10.2") }
        assertNull(parseReleaseVersion("2026.10.2-nightly.1.abcdef0"))
    }

    @Test
    fun theNewestApkOnTheChannelWinsAndStableHidesBetas() {
        val nightly = "2026.10.2-nightly.20261011120000.abcdef0"
        val releases = androidReleasesFromGithub(
            """
            [
              {"tag_name":"v$nightly","assets":[{"name":"FaNotes-$nightly-android.apk"}]},
              {"tag_name":"v2026.10.3-beta.1","assets":[{"name":"FaNotes-2026.10.3-beta.1-android.apk"}]},
              {"tag_name":"v2026.10.2","assets":[{"name":"notes.txt"},{"name":"FaNotes-2026.10.2-android.apk"}]},
              {"tag_name":"v2026.10.4","assets":[{"name":"FaNotes-2026.10.4-x86_64.AppImage"}]},
              {"tag_name":"not-a-version","assets":[{"name":"FaNotes-2026.10.9-android.apk"}]}
            ]
            """.trimIndent(),
        )
        assertEquals("2026.10.2", chooseAndroidUpdate("2026.10.1", "stable", releases)?.version)
        assertEquals(
            "https://github.com/Nikoheld/FaNotes/releases/download/v2026.10.2/FaNotes-2026.10.2-android.apk",
            chooseAndroidUpdate("2026.9.1", "stable", releases)?.url,
        )
        assertNull(chooseAndroidUpdate("2026.10.2", "stable", releases))
        assertEquals("2026.10.3-beta.1", chooseAndroidUpdate("2026.10.2", "beta", releases)?.version)
        assertEquals(nightly, chooseAndroidUpdate("2026.10.2", "nightly", releases)?.version)
        assertEquals("2026.10.3-beta.1", chooseAndroidUpdate("2026.10.2-beta.4", "beta", releases)?.version)
        assertEquals("Signierter Stable-Kanal", updateChannelCopy("stable").small)
        assertEquals("Signierter Beta-Kanal", updateChannelCopy("beta").small)
        assertTrue(androidReleasesFromGithub("{").isEmpty())
    }
}
