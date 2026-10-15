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

    private fun task(id: String, title: String, updatedAt: String) =
        HomeworkTask(id, title, updatedAt = updatedAt, createdAt = updatedAt)
}
