package ch.fasrv.fanotes.schulnetz

/**
 * One device refreshes the Schulnetz token when the server is not holding it.
 * A lease names that device until [RefreshLease.untilEpochMs]. Other devices wait.
 * Server-linked accounts never refresh on a phone: the poller is the only writer.
 */
data class RefreshLease(val holderId: String, val untilEpochMs: Long)

const val REFRESH_LEASE_TTL_MS = 10 * 60 * 1000L

fun claimRefreshLease(existing: RefreshLease?, deviceId: String, nowMs: Long, ttlMs: Long = REFRESH_LEASE_TTL_MS): RefreshLease? {
    if (deviceId.isBlank() || ttlMs <= 0L) return null
    if (existing != null && existing.holderId != deviceId && existing.untilEpochMs > nowMs) return null
    return RefreshLease(deviceId, nowMs + ttlMs)
}

/** Null when this phone must not call token.php. */
fun localRefreshLease(serverLinked: Boolean, existing: RefreshLease?, deviceId: String, nowMs: Long, ttlMs: Long = REFRESH_LEASE_TTL_MS): RefreshLease? {
    if (serverLinked) return null
    return claimRefreshLease(existing, deviceId, nowMs, ttlMs)
}
