package ch.fasrv.fanotes.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class BackgroundWorkTest {
    @Test
    fun pushRetriesCoalescePerConnection() {
        // One unique name per connection: a newer push replaces a waiting try instead of adding another,
        // and two connections never cancel each other's try.
        assertEquals(SCHOOL_PUSH, pushWorkName(null))
        assertEquals(SCHOOL_PUSH, pushWorkName(""))
        assertEquals("$SCHOOL_PUSH-b6df6a1c77130be8", pushWorkName("b6df6a1c77130be8"))
        assertNotEquals(pushWorkName("aaaa"), pushWorkName("bbbb"))
        // The periodic check keeps the name earlier versions used, so an upgrade updates it in place.
        assertEquals("schulnetz-fallback", SCHOOL_FALLBACK)
    }
}
