package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class HomeworkSyncTest {
    @Test
    fun remoteEditsAndDeletesMergeTheWayTheDesktopDoes() {
        val local = HomeworkDocument(
            tasks = listOf(
                task("keep", "Lokal", "2026-10-15T12:00:00Z"),
                task("old", "Alt", "2026-10-14T08:00:00Z"),
                task("gone", "Weg", "2026-10-13T08:00:00Z"),
                task("mine", "Nur hier", "2026-10-15T09:00:00Z"),
            ),
            publishedIds = listOf("keep", "old", "gone"),
        )
        val remote = listOf(
            task("keep", "Lokal", "2026-10-15T11:00:00Z"),
            task("old", "Neu", "2026-10-15T18:00:00Z"),
            task("extra", "Vom Tablet", "2026-10-15T10:00:00Z"),
        )
        val merged = mergeHomeworkFromRemote(local, remote)
        assertEquals(listOf("keep", "old", "extra", "mine"), merged.tasks.map { it.id })
        assertEquals("Lokal", merged.tasks[0].title)
        assertEquals("Neu", merged.tasks[1].title)
        assertEquals(listOf("keep", "old", "gone"), merged.publishedIds)
        val remembered = rememberPublishedHomeworkIds(merged, merged.tasks.map { it.id })
        assertEquals(listOf("keep", "old", "extra", "mine"), remembered.publishedIds)
        val longId = "c".repeat(90)
        assertEquals(listOf("ab", "c".repeat(80)), sanitizePublishedHomeworkIds(listOf("  ab  ", "", " $longId")))
    }

    @Test
    fun apiPayloadBecomesTheSameTasksTheNoteParserKeeps() {
        val tasks = homeworkTasksFromApiJson(
            """{"schemaVersion":1,"tasks":[{"id":"a","title":"  Lesen  ","notes":"Seite","subject":"Deutsch","dueDate":"2026-10-20","dueTime":"08:00","done":true,"kind":"appointment","priority":"high","createdAt":"t","updatedAt":"2026-10-15T12:00:00Z"},{"title":"  "}]}""",
        )
        assertEquals(listOf("a"), tasks?.map { it.id })
        assertEquals("Lesen", tasks?.single()?.title)
        assertEquals("appointment", tasks?.single()?.kind)
        assertEquals(true, tasks?.single()?.done)
        assertNull(homeworkTasksFromApiJson("""{"ok":true}"""))
        assertNull(homeworkTasksFromApiJson("not-json"))
        assertEquals(false, homeworkLocalWins("", "2026-10-15T12:00:00Z"))
        assertEquals(true, homeworkLocalWins("2026-10-15T12:00:00Z", "nope"))
    }

    @Test
    fun documentMergeTakesTheNewerTaskInBothDirections() {
        val older = "2026-10-15T10:00:00Z"
        val newer = "2026-10-15T11:00:00Z"
        // Kanti+ ticked later: done reaches the remote document.
        val kantiNewer = mergeHomeworkDocuments(
            HomeworkDocument(listOf(task("a", "A", newer).copy(done = true))),
            HomeworkDocument(listOf(task("a", "A", older))),
        )
        assertEquals(true, kantiNewer.tasks.single().done)
        // FaNotes ticked later: done reaches Kanti+.
        val faNotesNewer = mergeHomeworkDocuments(
            HomeworkDocument(listOf(task("a", "A", older))),
            HomeworkDocument(listOf(task("a", "A", newer).copy(done = true))),
        )
        assertEquals(true, faNotesNewer.tasks.single().done)
        // A later untick wins too.
        val untick = mergeHomeworkDocuments(
            HomeworkDocument(listOf(task("a", "A", newer))),
            HomeworkDocument(listOf(task("a", "A", older).copy(done = true))),
        )
        assertEquals(false, untick.tasks.single().done)
    }

    @Test
    fun documentMergeKeepsTheUnionAndResolvesTies() {
        val at = "2026-10-15T10:00:00Z"
        val merged = mergeHomeworkDocuments(
            HomeworkDocument(
                listOf(task("t", "Tie", at).copy(done = true), task("mine", "Nur hier", at), task("bad", "Lokal", "")),
                listOf("p1"),
            ),
            HomeworkDocument(
                listOf(task("t", "Tie", at), task("theirs", "Nur dort", at), task("bad", "Remote", "")),
                listOf("p2", "p1"),
            ),
        )
        assertEquals(setOf("t", "mine", "theirs", "bad"), merged.tasks.map { it.id }.toSet())
        assertEquals(4, merged.tasks.size)
        assertEquals(true, merged.tasks.first { it.id == "t" }.done)
        assertEquals("Remote", merged.tasks.first { it.id == "bad" }.title)
        assertEquals(listOf("p2", "p1"), merged.publishedIds)
        val tieRemoteDone = mergeHomeworkDocuments(
            HomeworkDocument(listOf(task("t", "Lokal", at))),
            HomeworkDocument(listOf(task("t", "Remote", at))),
        )
        assertEquals("Remote", tieRemoteDone.tasks.single().title)
    }

    @Test
    fun markdownMergeRoundTripsAndRefusesUnreadableFiles() {
        val a = serializeHomeworkMarkdown(HomeworkDocument(listOf(task("a", "A", "2026-10-15T10:00:00Z"))))
        val b = serializeHomeworkMarkdown(HomeworkDocument(listOf(task("b", "B", "2026-10-15T10:00:00Z"))))
        val merged = mergeHomeworkMarkdownBytes(a.encodeToByteArray(), b.encodeToByteArray())!!
        assertEquals(setOf("a", "b"), parseHomeworkMarkdown(merged.decodeToString()).tasks.map { it.id }.toSet())
        assertNull(mergeHomeworkMarkdownBytes(a.encodeToByteArray(), "<!-- fanotes-homework-v1 {".encodeToByteArray()))
    }

    private fun task(id: String, title: String, updatedAt: String) =
        HomeworkTask(id, title, updatedAt = updatedAt, createdAt = updatedAt)
}
