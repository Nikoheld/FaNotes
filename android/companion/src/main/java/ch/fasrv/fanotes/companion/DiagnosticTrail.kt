package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.schulnetz.safeLogToken
import java.util.ArrayDeque

/** Last screen, refresh caller, and a few navigation tokens. Values are enum names, never typed text. */
class DiagnosticTrail {
    private val actions = ArrayDeque<String>()
    @Volatile var screen: String = "unknown"
        private set
    @Volatile var caller: String = "unspecified"
        private set

    fun screen(token: String) {
        screen = safeLogToken(token)
    }

    fun action(token: String) {
        val safe = safeLogToken(token)
        synchronized(actions) {
            actions.addLast(safe)
            while (actions.size > 6) actions.removeFirst()
        }
    }

    fun caller(token: String) {
        caller = safeLogToken(token)
        action(token)
    }

    fun snapshot(): String = synchronized(actions) {
        "screen=$screen caller=$caller actions=${actions.joinToString(",")}"
    }
}
