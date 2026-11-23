package ch.fasrv.fanotes.companion

import java.time.Instant
import org.junit.Test
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull

class SignInExpiryTest {
    private val end = "2026-12-07T09:00:00Z"
    private fun at(iso: String) = Instant.parse(iso).toEpochMilli()

    @Test
    fun theDateShowsOnlyInTheLastThreeDays() {
        assertNull(signInExpiresSoon(end, at("2026-12-03T08:59:00Z")))
        assertEquals("7.12.", signInExpiresSoon(end, at("2026-12-04T09:00:00Z")))
        assertEquals("7.12.", signInExpiresSoon(end, at("2026-12-07T08:59:00Z")))
        assertNull("after the end the reauth state takes over", signInExpiresSoon(end, at("2026-12-07T09:00:01Z")))
        assertNull(signInExpiresSoon("", at("2026-12-07T08:00:00Z")))
        assertNull(signInExpiresSoon("not a time", at("2026-12-07T08:00:00Z")))
    }
}
