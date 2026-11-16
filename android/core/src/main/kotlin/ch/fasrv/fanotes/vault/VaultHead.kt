package ch.fasrv.fanotes.vault

import java.io.InputStream

/**
 * The first bytes of a file. [complete] is false when the file is longer than what was asked for,
 * so the caller knows the bytes are only a head.
 */
class VaultHead(val bytes: ByteArray, val complete: Boolean)

/**
 * Reads at most [maxBytes] from [stream] and notices whether more follows. [sizeHint] (the listed
 * size, or -1) only sizes the buffer; the stream decides what is complete. Memory stays within
 * about [maxBytes] plus one growth step, however long the file is.
 */
fun readHeadFrom(stream: InputStream, maxBytes: Int, sizeHint: Long = -1L): VaultHead {
    val cap = maxBytes.coerceAtLeast(0)
    // One byte past the cap is read as a probe: getting it proves the file is longer.
    val want = minOf(cap.toLong() + 1, MAX_HEAD_ARRAY)
    val first = when {
        sizeHint in 0 until want -> sizeHint + 1
        else -> minOf(want, FIRST_CHUNK)
    }
    var buffer = ByteArray(first.toInt().coerceAtLeast(1))
    var length = 0
    while (length < want) {
        if (length == buffer.size) buffer = buffer.copyOf(minOf(want, buffer.size * 2L).toInt())
        val read = stream.read(buffer, length, buffer.size - length)
        if (read < 0) break
        length += read
    }
    if (length > cap) return VaultHead(buffer.copyOf(cap), complete = false)
    return VaultHead(if (length == buffer.size) buffer else buffer.copyOf(length), complete = true)
}

private const val FIRST_CHUNK = 64L * 1024
private const val MAX_HEAD_ARRAY = Int.MAX_VALUE - 16L
