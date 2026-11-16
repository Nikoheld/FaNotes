package ch.fasrv.fanotes.vault

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RescanPolicyTest {
    @Test fun startsAtSixtySeconds() {
        val policy = RescanPolicy()
        assertEquals(60_000L, policy.intervalMs)
        assertFalse(policy.resumeOnly)
    }

    @Test fun fastRescanKeepsInterval() {
        val policy = RescanPolicy()
        policy.record(1_999L)
        assertEquals(60_000L, policy.intervalMs)
        assertFalse(policy.resumeOnly)
    }

    @Test fun slowRescanDoublesUpToCapAndGoesResumeOnly() {
        val policy = RescanPolicy()
        policy.record(2_500L)
        assertEquals(120_000L, policy.intervalMs)
        assertTrue(policy.resumeOnly)
        repeat(6) { policy.record(5_000L) }
        assertEquals(600_000L, policy.intervalMs)
    }

    @Test fun fastRescanResets() {
        val policy = RescanPolicy()
        policy.record(3_000L)
        policy.record(100L)
        assertEquals(60_000L, policy.intervalMs)
        assertFalse(policy.resumeOnly)
    }
}
