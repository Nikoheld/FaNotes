package ch.fasrv.fanotes.schulnetz

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * One turn at a time for anything that touches a schulNetz session.
 * A login that arrives during a refresh waits; it does not run beside it.
 */
class SchulnetzGate {
    private val mutex = Mutex()

    @Volatile
    var holder: String? = null
        private set

    val isLocked: Boolean
        get() = mutex.isLocked

    suspend fun <T> exclusive(caller: String, block: suspend () -> T): T {
        return mutex.withLock {
            holder = caller
            try {
                block()
            } finally {
                if (holder == caller) holder = null
            }
        }
    }
}
