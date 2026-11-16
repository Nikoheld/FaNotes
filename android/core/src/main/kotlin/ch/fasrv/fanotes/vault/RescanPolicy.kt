package ch.fasrv.fanotes.vault

/**
 * Pacing of the foreground tree rescan. Base interval is 60 s. When a rescan took longer than
 * [slowMs] (e.g. a large SAF vault), the interval doubles up to [maxMs] and the periodic timer
 * stops: rescans then only run on resume. A fast rescan resets the interval.
 */
class RescanPolicy(
    private val baseMs: Long = 60_000L,
    private val maxMs: Long = 600_000L,
    private val slowMs: Long = 2_000L,
) {
    var intervalMs: Long = baseMs
        private set

    /** True after a slow rescan: only resume triggers a rescan. */
    var resumeOnly: Boolean = false
        private set

    fun record(durationMs: Long) {
        if (durationMs > slowMs) {
            intervalMs = (intervalMs * 2).coerceAtMost(maxMs)
            resumeOnly = true
        } else {
            intervalMs = baseMs
            resumeOnly = false
        }
    }
}
