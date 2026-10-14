package ch.fasrv.fanotes.desk

import java.security.SecureRandom
import java.util.Base64

/** Homework publish contract shared with `fanotes/src/lib/homeworkApi.ts`. */
const val HOMEWORK_API_ORIGIN = "https://fanotes.fasrv.ch"
const val HOMEWORK_API_MIN_SECRET_LENGTH = 12
private val HOMEWORK_CHANNEL_ID = Regex("^[a-f0-9]{32}$")

fun homeworkChannelIdValid(channelId: String) = HOMEWORK_CHANNEL_ID.matches(channelId)

fun homeworkSecretReady(secret: String) = secret.trim().length >= HOMEWORK_API_MIN_SECRET_LENGTH

fun homeworkPublishUrl(channelId: String, origin: String = HOMEWORK_API_ORIGIN) =
    "${origin.trimEnd('/')}/api/v1/homework/$channelId"

fun newHomeworkChannelId(): String {
    val bytes = ByteArray(16)
    SecureRandom().nextBytes(bytes)
    return bytes.joinToString("") { "%02x".format(it) }
}

fun newHomeworkSecret(): String {
    val bytes = ByteArray(24)
    SecureRandom().nextBytes(bytes)
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}

/**
 * PUT body for `/api/v1/homework/:channelId`. Key order matches
 * `JSON.stringify` in the desktop client. `previousSecret` is omitted when
 * the channel secret did not change.
 */
fun homeworkPublishBody(enabled: Boolean, secret: String, previousSecret: String?, tasks: List<HomeworkTask>): String {
    val previous = previousSecret?.trim().orEmpty()
    val taskJson = if (enabled) tasks.joinToString(",") { homeworkTaskJson(it) } else ""
    val previousField = if (previous.isEmpty()) "" else ""","previousSecret":${homeworkJson(previous)}"""
    return """{"enabled":$enabled,"secret":${homeworkJson(secret.trim())}$previousField,"tasks":[$taskJson]}"""
}

private fun homeworkTaskJson(task: HomeworkTask): String = buildString {
    append("""{"id":${homeworkJson(task.id)},"title":${homeworkJson(task.title)},"notes":${homeworkJson(task.notes)}""")
    append(""","subject":${homeworkJson(task.subject)},"dueDate":${task.dueDate?.let(::homeworkJson) ?: "null"}""")
    append(""","dueTime":${task.dueTime?.let(::homeworkJson) ?: "null"},"done":${task.done}""")
    append(""","kind":${homeworkJson(task.kind)},"priority":${homeworkJson(task.priority)}""")
    append(""","createdAt":${homeworkJson(task.createdAt)},"updatedAt":${homeworkJson(task.updatedAt)}}""")
}

private fun homeworkJson(value: String) = buildString {
    append('"')
    for (char in value) {
        when (char) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            else -> append(char)
        }
    }
    append('"')
}
