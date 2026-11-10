package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull

class PushPayloadTest {
    // The same vector as fanotes-site/grade-sla.test.mjs: key 32 × 0x07, iv 12 × 0x09.
    private val key = java.util.Base64.getEncoder().encodeToString(ByteArray(32) { 7 })
    private val sealed = "CQkJCQkJCQkJCQkJXKfn/N+epgTTQPFjncjKu/aKQZRGj5OlVZ9kivcXYA62goixm3AQMhjBxHIhFs/2CD3q+He2lGwrCnTydlgV+gldpCzrSYja+trrOd6d7JBwiL9/wCcGCl2KeLN9+lAf4R8XRSRky5q4XgYZpTt+Ug=="

    @Test
    fun theAppOpensWhatTheServerSealed() {
        assertEquals("""{"changes":[{"id":"grade:1","category":"grade","title":"Neue Note","body":"Mathematik · 5.5"}]}""", openPushPayload(key, sealed))
    }

    @Test
    fun aWrongKeyOrATamperedPushOpensNothing() {
        val other = java.util.Base64.getEncoder().encodeToString(ByteArray(32) { 8 })
        assertNull(openPushPayload(other, sealed))
        val bytes = java.util.Base64.getDecoder().decode(sealed).also { it[20] = (it[20].toInt() xor 1).toByte() }
        assertNull(openPushPayload(key, java.util.Base64.getEncoder().encodeToString(bytes)))
        assertNull(openPushPayload(key, "not base64!"))
        assertNull(openPushPayload("short", sealed))
    }

    @Test
    fun everyInstallMakesItsOwnKey() {
        val first = newPushKey()
        assertEquals(44, first.length)
        assertEquals(32, java.util.Base64.getDecoder().decode(first).size)
        assertNotEquals(first, newPushKey())
    }
}
