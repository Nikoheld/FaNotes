package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The app side of "Kanti+ im Browser": pairing codes, request bodies, settings and hidden grades. */
class WebPairingTest {
    @Test fun aCodeIsReadTheWayPeopleTypeIt() {
        assertEquals("7K3QM9XR", normalizePairCode("7K3Q-M9XR"))
        assertEquals("7K3QM9XR", normalizePairCode(" 7k3q m9xr "))
        // O reads as zero, I and L as one.
        assertEquals("70310M11", normalizePairCode("7o3I-0mlL"))
        assertEquals("7K3Q-M9XR", displayPairCode("7K3QM9XR"))
        // Too short, too long, or a letter the browser never shows (U).
        for (bad in listOf(null, "", "7K3Q", "7K3QM9XRA", "7K3Q-M9XU", "7K3Q_M9XR", "Ä7K3QM9X")) assertNull(normalizePairCode(bad), bad)
    }

    @Test fun thePairingRequestNamesOneConnectionAndOnlyTheLastFinishes() {
        val body = parseJson(webPairBody("7K3QM9XR", "aabbccddeeff", "AKSA \"Klasse\"", SchoolProvider.TAM, finish = false, unrevealed = listOf("g2", "g1", "", "g1"))) as JsonValue.Obj
        assertEquals("7K3Q-M9XR", body.string("code"))
        assertEquals("aabbccddeeff", body.string("connectionId"))
        assertEquals("AKSA \"Klasse\"", body.string("label"))
        assertEquals("tam", body.string("provider"))
        assertEquals(false, body.bool("finish"))
        assertEquals(listOf("g1", "g2"), body.array("unrevealed")!!.items.map { (it as JsonValue.Str).value })
        val last = parseJson(webPairBody("7K3QM9XR", "x", "y", SchoolProvider.SCHULNETZ, finish = true, unrevealed = emptyList())) as JsonValue.Obj
        assertEquals(true, last.bool("finish"))
        assertEquals("schulnetz", last.string("provider"))
    }

    @Test fun aDeviceLinkCarriesNoSecret() {
        val body = parseJson(deviceLinkBody("https://intranet.tam.ch/bmz", "0123456789abcdef01234567", "TAM BMZ")) as JsonValue.Obj
        assertEquals("device", body.string("mode"))
        assertEquals("tam", body.string("provider"))
        assertEquals("https://intranet.tam.ch/bmz", body.string("baseUrl"))
        assertEquals(setOf("mode", "provider", "baseUrl", "deviceId", "displayName"), body.fields.keys)
    }

    @Test fun answersAndFailuresAreRead() {
        val info = parseWebPairInfo("""{"browser":"Firefox · Linux","expiresAt":"2026-11-10T12:10:00Z","added":1}""")
        assertNotNull(info)
        assertEquals("Firefox · Linux", info.browser)
        assertEquals(1, info.added)
        assertNull(parseWebPairInfo("<html>"))
        val sessions = parseWebSessions("""{"sessions":[{"id":"ab12cd34ef56ab78","browser":"Chrome · Windows","createdAt":"a","lastSeenAt":"b"},{"id":"../x","browser":"bad"}]}""")
        assertEquals(listOf("ab12cd34ef56ab78"), sessions.map { it.id })
        assertEquals(WebPairFailure.UNKNOWN_CODE, webPairFailure(404))
        assertEquals(WebPairFailure.ALREADY_FINISHED, webPairFailure(409))
        assertEquals(WebPairFailure.TOO_MANY_TRIES, webPairFailure(429))
        assertEquals(WebPairFailure.OFFLINE, webPairFailure(0))
        assertEquals(WebPairFailure.OTHER, webPairFailure(500))
    }

    @Test fun settingsChangedInTheBrowserAreTakenOverOnlyWhenTheAppHasNothingPending() {
        val mine = "2026-11-10T10:00:00Z"
        val browser = "2026-11-10T11:00:00Z"
        // A newer server stamp: the browser changed them.
        assertEquals(SettingsSync.ADOPT, settingsSyncAction(dirty = false, localStamp = mine, serverStamp = browser))
        // The app's own unconfirmed change wins and is sent again.
        assertEquals(SettingsSync.PUSH, settingsSyncAction(dirty = true, localStamp = mine, serverStamp = browser))
        // Same or older stamp, or a server without the field: nothing to do.
        assertEquals(SettingsSync.NONE, settingsSyncAction(dirty = false, localStamp = browser, serverStamp = browser))
        assertEquals(SettingsSync.NONE, settingsSyncAction(dirty = false, localStamp = browser, serverStamp = mine))
        assertEquals(SettingsSync.NONE, settingsSyncAction(dirty = false, localStamp = mine, serverStamp = ""))
        // First status after the update: no local stamp yet, the server's settings are the shared ones.
        assertEquals(SettingsSync.ADOPT, settingsSyncAction(dirty = false, localStamp = "", serverStamp = browser))
    }

    @Test fun hiddenGradesMergeBothWaysAndARevealIsNeverUndone() {
        val server = parseRevealLedger("""{"hidden":["g1","g2","g3"],"revealed":["g3"]}""")!!
        // The phone hides g4 the server lacks; g2 came from the browser's side; g3 was revealed in the browser.
        val merged = mergeReveals(local = setOf("g1", "g3", "g4"), pendingRevealed = emptySet(), server = server)
        assertEquals(setOf("g1", "g2", "g4"), merged.local)
        assertEquals(setOf("g4"), merged.pushHidden)
        assertTrue(merged.pushRevealed.isEmpty())
        // Revealed on the phone while offline: it stays revealed and is sent again.
        val offline = mergeReveals(local = setOf("g1"), pendingRevealed = setOf("g2"), server = server)
        assertEquals(setOf("g1"), offline.local)
        assertEquals(setOf("g2"), offline.pushRevealed)
        assertTrue(offline.needsPush)
        // Nothing new on either side.
        val settled = mergeReveals(local = setOf("g1", "g2"), pendingRevealed = emptySet(), server = server)
        assertFalse(settled.needsPush)
        assertNull(parseRevealLedger("nope"))
        // First sync after the app update: g2 was already on this phone and shown, so it stays shown;
        // g3 is new to this phone (a fresh install), so the server's hiding applies.
        val first = mergeReveals(local = setOf("g1"), pendingRevealed = emptySet(), server = RevealLedger(hidden = setOf("g1", "g2", "g3")), firstSync = true, known = setOf("g1", "g2"))
        assertEquals(setOf("g1", "g3"), first.local)
        assertEquals(setOf("g2"), first.pushRevealed)
        assertTrue(first.pushHidden.isEmpty())
        // A fresh install knows no grade yet: everything the server hides stays hidden.
        assertEquals(setOf("g1", "g2", "g3"), mergeReveals(emptySet(), emptySet(), RevealLedger(hidden = setOf("g1", "g2", "g3")), firstSync = true, known = emptySet()).local)
        val body = parseJson(revealsBody(listOf("b", "a", "a"), listOf("c"))) as JsonValue.Obj
        assertEquals(listOf("a", "b"), body.array("hidden")!!.items.map { (it as JsonValue.Str).value })
        assertEquals(listOf("c"), body.array("revealed")!!.items.map { (it as JsonValue.Str).value })
    }

    @Test
    fun parsesAnOffer() {
        val offer = parseWebPairOffer("""{"code":"7k3qm9xr","expiresAt":"2026-01-01T10:10:00Z"}""")
        assertEquals(WebPairOffer("7K3QM9XR", "2026-01-01T10:10:00Z"), offer)
        assertEquals("7K3Q-M9XR", displayPairCode(offer!!.code))
        assertNull(parseWebPairOffer("""{"code":"short"}"""))
        assertNull(parseWebPairOffer("not json"))
    }

    @Test
    fun countsSecondsLeft() {
        val now = java.time.Instant.parse("2026-01-01T10:00:00Z")
        assertEquals(600, pairSecondsLeft("2026-01-01T10:10:00Z", now))
        assertEquals(0, pairSecondsLeft("2026-01-01T09:00:00Z", now))
        assertEquals(0, pairSecondsLeft("", now))
    }

    @Test
    fun errorTextShowsTheRealReason() {
        assertEquals("Failed\nBad code (HTTP 404)", webPairErrorText("Failed", 404, "Bad code", false, "offline"))
        assertEquals("Failed\nHTTP 500", webPairErrorText("Failed", 500, " ", false, "offline"))
        assertEquals("Failed\nno server", webPairErrorText("Failed", 0, "x", true, "no server"))
        assertEquals("Failed\nboom", webPairErrorText("Failed", 0, "boom", false, "offline"))
        assertEquals("Failed", webPairErrorText("Failed", 0, null, false, "offline"))
    }
}
