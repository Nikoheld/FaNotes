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

/**
 * Two-way merge used by file sync when both sides changed `Hausaufgaben.md`.
 * Tasks are united by id. For a task on both sides the newer `updatedAt` wins;
 * a tie prefers the done task, then the remote one. The file has no tombstones,
 * so a task missing on one side is kept (union). `publishedIds` is the union.
 */
fun mergeHomeworkDocuments(local: HomeworkDocument, remote: HomeworkDocument): HomeworkDocument {
    val localById = local.tasks.associateBy { it.id }
    val seen = HashSet<String>()
    val merged = ArrayList<HomeworkTask>(local.tasks.size + remote.tasks.size)
    for (theirs in remote.tasks) {
        if (!seen.add(theirs.id)) continue
        val ours = localById[theirs.id]
        merged.add(if (ours == null) theirs else pickNewerHomeworkTask(ours, theirs))
    }
    for (ours in local.tasks) {
        if (seen.add(ours.id)) merged.add(ours)
    }
    val published = sanitizePublishedHomeworkIds((remote.publishedIds + local.publishedIds).distinct())
    return HomeworkDocument(merged, published)
}

private fun pickNewerHomeworkTask(local: HomeworkTask, remote: HomeworkTask): HomeworkTask {
    val l = parseHomeworkInstant(local.updatedAt)
    val r = parseHomeworkInstant(remote.updatedAt)
    return when {
        l != null && r == null -> local
        l == null && r != null -> remote
        l != null && r != null && l.isAfter(r) -> local
        l != null && r != null && r.isAfter(l) -> remote
        local.done && !remote.done -> local
        else -> remote
    }
}

/**
 * Merges two `Hausaufgaben.md` files. Null when either side does not parse,
 * so the caller falls back to the ordinary conflict copy and loses nothing.
 */
fun mergeHomeworkMarkdownBytes(local: ByteArray, remote: ByteArray): ByteArray? {
    val ours = (loadHomeworkMarkdown(local.decodeToString()) as? NoteMarkdownLoad.Ready)?.document ?: return null
    val theirs = (loadHomeworkMarkdown(remote.decodeToString()) as? NoteMarkdownLoad.Ready)?.document ?: return null
    return serializeHomeworkMarkdown(mergeHomeworkDocuments(ours, theirs)).encodeToByteArray()
}
