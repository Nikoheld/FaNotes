package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class HomeworkApiTest {
    @Test
    fun publishBodyMatchesTheDesktopPutContract() {
        val task = HomeworkTask(
            id = "a",
            title = "Lesen",
            subject = "Deutsch",
            dueDate = "2026-10-20",
            kind = "homework",
            createdAt = "t",
            updatedAt = "t",
        )
        val body = homeworkPublishBody(true, "secret-value-1", null, listOf(task))
        assertEquals(
            """{"enabled":true,"secret":"secret-value-1","tasks":[{"id":"a","title":"Lesen","notes":"","subject":"Deutsch","dueDate":"2026-10-20","dueTime":null,"done":false,"kind":"homework","priority":"normal","createdAt":"t","updatedAt":"t"}]}""",
            body,
        )
        assertEquals(
            """{"enabled":false,"secret":"new-secret-22","previousSecret":"old-secret-22","tasks":[]}""",
            homeworkPublishBody(false, "new-secret-22", "old-secret-22", listOf(task)),
        )
    }

    @Test
    fun channelIdIs32LowerHex() {
        val id = newHomeworkChannelId()
        assertTrue(homeworkChannelIdValid(id))
        assertEquals(32, id.length)
        assertFalse(homeworkChannelIdValid("abc"))
        assertTrue(homeworkSecretReady(newHomeworkSecret()))
        assertEquals("https://fanotes.fasrv.ch/api/v1/homework/$id", homeworkPublishUrl(id))
    }
}
