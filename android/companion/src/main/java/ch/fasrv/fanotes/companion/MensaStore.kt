package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.schulnetz.MensaFeed
import ch.fasrv.fanotes.schulnetz.mensaRefreshDue
import ch.fasrv.fanotes.schulnetz.parseMensaFeed
import java.io.File

/** Keeps the last good Mensa response on disk; its modification time is the time it was fetched. */
class MensaStore(private val file: File, private val client: SchulnetzClient) {
    /** The cached feed, or null when there is none. */
    fun cached(): MensaFeed? = runCatching { file.takeIf { it.isFile }?.readText()?.let(::parseMensaFeed) }.getOrNull()

    /** Fetches when the cache is older than a few hours (or [force]); any failure keeps the cache. */
    fun refresh(force: Boolean = false): MensaFeed? {
        val age = file.takeIf { it.isFile }?.lastModified() ?: 0L
        if (!force && !mensaRefreshDue(age, System.currentTimeMillis())) return cached()
        runCatching {
            val body = client.mensa() ?: return@runCatching
            val feed = parseMensaFeed(body)
            // An empty answer (the page could not be read) never replaces a good cache.
            if (feed != null && feed.days.isNotEmpty()) {
                val temporary = File(file.parentFile, file.name + ".tmp")
                temporary.writeText(body)
                if (!temporary.renameTo(file)) { file.writeText(body); temporary.delete() }
            }
        }
        return cached()
    }
}
