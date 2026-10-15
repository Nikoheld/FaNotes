package ch.fasrv.fanotes.desk

import java.time.Instant
import java.time.OffsetDateTime

/**
 * Desktop `mergeHomeworkFromRemote`. A newer `updatedAt` wins. A task that
 * was published and is missing from the remote list was deleted on the other
 * side. A local task that was never published stays.
 */
fun mergeHomeworkFromRemote(local: HomeworkDocument, remoteTasks: List<HomeworkTask>): HomeworkDocument {
    val published = sanitizePublishedHomeworkIds(local.publishedIds).toSet()
    val localById = local.tasks.associateBy { it.id }
    val remoteIds = remoteTasks.map { it.id }.toSet()
    val merged = ArrayList<HomeworkTask>(remoteTasks.size + local.tasks.size)
    val seen = HashSet<String>()
    for (remote in remoteTasks) {
        seen.add(remote.id)
        val current = localById[remote.id]
        merged.add(
            if (current != null && homeworkLocalWins(current.updatedAt, remote.updatedAt)) current else remote,
        )
    }
    for (task in local.tasks) {
        if (task.id in seen) continue
        if (task.id in published && task.id !in remoteIds) continue
        merged.add(task)
    }
    return local.copy(tasks = merged)
}

/** Ids last sent to the homework API, so a later pull can tell a remote delete from a local-only task. */
fun rememberPublishedHomeworkIds(document: HomeworkDocument, ids: List<String>): HomeworkDocument =
    document.copy(publishedIds = sanitizePublishedHomeworkIds(ids))

fun sanitizePublishedHomeworkIds(ids: List<String>): List<String> =
    ids.map { it.trim().take(80) }.filter { it.isNotEmpty() }.take(2_000)

/** True when the local timestamp is present and at least as new as the remote one. */
fun homeworkLocalWins(localUpdatedAt: String, remoteUpdatedAt: String): Boolean {
    val local = parseHomeworkInstant(localUpdatedAt) ?: return false
    val remote = parseHomeworkInstant(remoteUpdatedAt) ?: return true
    return !local.isBefore(remote)
}

private fun parseHomeworkInstant(value: String): Instant? {
    val text = value.trim()
    if (text.isEmpty()) return null
    return runCatching { Instant.parse(text) }.getOrNull()
        ?: runCatching { OffsetDateTime.parse(text).toInstant() }.getOrNull()
}
