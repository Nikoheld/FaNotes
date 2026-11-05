package ch.fasrv.fanotes.sync

import ch.fasrv.fanotes.famd.SyncDocumentLimitException
import java.io.ByteArrayOutputStream
import java.io.InputStream

/** Includes JSON responses and encrypted blobs. Unknown/chunked lengths have the same cap. */
fun readSyncResponseBody(input: InputStream, declaredBytes: Long, maxBytes: Long = syncResponseBudget()): ByteArray {
    if (declaredBytes > maxBytes || maxBytes < 0) throw SyncDocumentLimitException()
    val output = ByteArrayOutputStream(minOf(declaredBytes.coerceAtLeast(0), 64 * 1024L).toInt())
    val buffer = ByteArray(16 * 1024)
    var total = 0L
    while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        total += read
        if (total > maxBytes) throw SyncDocumentLimitException()
        output.write(buffer, 0, read)
    }
    return output.toByteArray()
}

private fun syncResponseBudget(): Long {
    val runtime = Runtime.getRuntime()
    val available = runtime.maxMemory() - (runtime.totalMemory() - runtime.freeMemory())
    return minOf(MAX_FILE_BYTES + 1024 * 1024, available / 4)
}
