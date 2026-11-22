package ch.fasrv.fanotes.desk

import kotlinx.coroutines.CancellationException

/** A cancelled coroutine is not a failure the user should see. */

fun userVisibleToast(message: String?): String? {
    val text = message?.trim().orEmpty()
    if (text.isEmpty()) return null
    if (isCancellationText(text)) return null
    return text
}

fun userVisibleFailure(error: Throwable, fallback: String): String? {
    if (isCancellation(error)) return null
    return userVisibleToast(friendlyFileError(error, fallback))
}

private fun isCancellation(error: Throwable?): Boolean {
    var current = error
    while (current != null) {
        if (current is CancellationException) return true
        if (isCancellationText(current.message)) return true
        current = current.cause
    }
    return false
}

internal fun isCancellationText(text: String?): Boolean {
    if (text.isNullOrBlank()) return false
    val lower = text.lowercase()
    return lower.contains("was cancelled") ||
        lower.contains("was canceled") ||
        lower.contains("cancellationexception") ||
        lower.contains("standalonecoroutine")
}

/** A toast with an undo action stays long enough to reach it. */
private const val TOAST_UNDO_MS = 8_000L

/**
 * How long a toast stays: 4 s plus 40 ms per character (so longer errors can be read), at most 12 s.
 * The ViewModel clears the message flow after this, so a toast never outlives its screen.
 */
fun toastLifetimeMs(message: String, hasAction: Boolean = false): Long {
    if (hasAction) return TOAST_UNDO_MS
    return (4_000L + message.length * 40L).coerceAtMost(12_000L)
}

/** A leftover toast is dropped when the user switches screens, unless it was raised just now. */
fun toastSurvivesNavigation(ageMs: Long): Boolean = ageMs < 1_500L
