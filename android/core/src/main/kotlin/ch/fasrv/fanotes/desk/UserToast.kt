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
    val text = error.message?.takeIf { it.isNotBlank() && !isCancellationText(it) } ?: fallback
    return userVisibleToast(text)
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
