package ch.fasrv.fanotes.ink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class InkEffectsTest {
    @Test
    fun specialInksUseTheDesktopStops() {
        assertEquals(8, INK_EFFECTS.size)
        assertEquals("solid", normalizeInkEffect(null))
        assertEquals("solid", normalizeInkEffect("sparkle"))
        assertEquals("Regenbogen", inkEffectLabel("rainbow"))
        assertEquals("rainbow", nextInkEffect("solid"))
        assertEquals("solid", nextInkEffect("neon"))
        assertNull(inkEffectGradient("solid"))
        val rainbow = inkEffectGradient("rainbow")!!
        assertEquals(7, rainbow.first.size)
        assertEquals(0f, rainbow.first.first())
        assertEquals(1f, rainbow.first.last())
        assertEquals(0xFFff4d6d.toInt(), rainbow.second.first())
        assertEquals(0xFFe84dba.toInt(), rainbow.second.last())
        assertTrue(inkEffectGradient("gold")!!.second.contains(0xFFfff0a8.toInt()))
    }
}
