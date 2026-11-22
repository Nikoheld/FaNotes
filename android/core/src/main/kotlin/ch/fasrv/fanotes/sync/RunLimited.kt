package ch.fasrv.fanotes.sync

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/** Uploads in flight at once (desktop uses 6; a tablet holds less memory, so 4). */
const val PUSH_CONCURRENCY = 4

/** File bytes the uploads in flight may hold at once; each briefly holds the file, its canonical form and the encrypted copy. */
const val PUSH_BYTE_BUDGET = 16L * 1024 * 1024

/**
 * Runs [block] for every item with at most [concurrency] in flight and at most [budget] bytes of
 * [weight] in flight (an item heavier than the budget runs alone). Items start in order. The first
 * failure cancels the rest and is rethrown, like a sequential loop would.
 *
 * Children inherit the caller's dispatcher: on the single sync thread they interleave only at
 * suspension points, so the engine's file table needs no locking.
 */
suspend fun <T> runLimited(
    items: List<T>,
    concurrency: Int,
    budget: Long,
    weight: (T) -> Long,
    block: suspend (T) -> Unit,
) = coroutineScope {
    val finished = Channel<Unit>(Channel.UNLIMITED)
    var inFlight = 0
    var bytes = 0L
    for (item in items) {
        val cost = weight(item).coerceIn(0L, budget)
        while (inFlight >= concurrency.coerceAtLeast(1) || (inFlight > 0 && bytes + cost > budget)) finished.receive()
        inFlight += 1
        bytes += cost
        launch {
            try {
                block(item)
            } finally {
                inFlight -= 1
                bytes -= cost
                finished.trySend(Unit)
            }
        }
    }
}
