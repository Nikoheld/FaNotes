package ch.fasrv.fanotes.sync

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import java.util.concurrent.Executors
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class RunLimitedTest {
    private val single = Executors.newSingleThreadExecutor().asCoroutineDispatcher()

    @Test
    fun countStaysWithinTheLimitAndEveryItemRuns() = runBlocking(single) {
        var running = 0
        var peak = 0
        val seen = mutableListOf<Int>()
        runLimited((1..20).toList(), 4, 1_000L, { 1L }) { item ->
            running += 1
            peak = maxOf(peak, running)
            delay(5)
            running -= 1
            seen += item
        }
        assertEquals(4, peak)
        assertEquals((1..20).toSet(), seen.toSet())
    }

    @Test
    fun byteBudgetHoldsBackHeavyItemsAndAnOversizedItemRunsAlone() = runBlocking(single) {
        var bytes = 0L
        var peak = 0L
        var alone = true
        val weights = listOf(6L, 6L, 6L, 100L, 2L, 2L)
        runLimited(weights, 6, 10L, { it }) { weight ->
            val cost = weight.coerceAtMost(10L)
            bytes += cost
            peak = maxOf(peak, bytes)
            if (weight == 100L && bytes != cost) alone = false
            delay(5)
            bytes -= cost
        }
        assertTrue(peak <= 10L, "peak=$peak")
        assertTrue(alone)
    }

    @Test
    fun firstFailureCancelsTheRestAndIsRethrown() {
        val started = mutableListOf<Int>()
        assertFailsWith<IllegalStateException> {
            runBlocking(single) {
                runLimited((1..10).toList(), 2, 100L, { 1L }) { item ->
                    started += item
                    if (item == 2) error("boom")
                    delay(50)
                }
            }
        }
        assertTrue(started.size < 10)
    }
}
