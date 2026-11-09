package ch.fasrv.fanotes.companion

import android.content.SharedPreferences
import ch.fasrv.fanotes.schulnetz.NotifyPrefs
import ch.fasrv.fanotes.schulnetz.PRIMARY_SLOT
import ch.fasrv.fanotes.schulnetz.SchoolProvider
import ch.fasrv.fanotes.schulnetz.migrateConnections
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Two connections in one app must never read, overwrite or delete each other's stored state. */
class ConnectionIsolationTest {
    /** The app's preferences file, in memory. */
    private class MemoryPrefs : SharedPreferences {
        val values = linkedMapOf<String, Any?>()
        override fun getAll(): MutableMap<String, *> = values.toMutableMap()
        override fun getString(key: String, defValue: String?): String? = values[key] as? String ?: defValue
        @Suppress("UNCHECKED_CAST")
        override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? = (values[key] as? Set<String>)?.toMutableSet() ?: defValues
        override fun getInt(key: String, defValue: Int): Int = values[key] as? Int ?: defValue
        override fun getLong(key: String, defValue: Long): Long = values[key] as? Long ?: defValue
        override fun getFloat(key: String, defValue: Float): Float = values[key] as? Float ?: defValue
        override fun getBoolean(key: String, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue
        override fun contains(key: String): Boolean = values.containsKey(key)
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            val pending = linkedMapOf<String, Any?>()
            val removed = mutableSetOf<String>()
            override fun putString(key: String, value: String?) = apply { pending[key] = value }
            override fun putStringSet(key: String, values: MutableSet<String>?) = apply { pending[key] = values?.toSet() }
            override fun putInt(key: String, value: Int) = apply { pending[key] = value }
            override fun putLong(key: String, value: Long) = apply { pending[key] = value }
            override fun putFloat(key: String, value: Float) = apply { pending[key] = value }
            override fun putBoolean(key: String, value: Boolean) = apply { pending[key] = value }
            override fun remove(key: String) = apply { removed += key; pending.remove(key) }
            override fun clear() = apply { removed += values.keys }
            override fun commit(): Boolean { apply(); return true }
            override fun apply() { removed.forEach { values.remove(it) }; values.putAll(pending) }
        }
    }

    @Test fun anInstallFromBeforeMultiConnectionKeepsReadingItsOwnKeys() {
        val prefs = MemoryPrefs()
        // What a single-connection install stored.
        prefs.edit().putString("web-session", "{\"id\":\"abc\"}").putBoolean("school-linked", true).putLong("change-cursor", 41L)
            .putBoolean(NotifyPrefs.GRADES, false).putString("schulnetz-base", "https://www.schulnetz-ag.ch/aksa").apply()
        val registry = migrateConnections(null, prefs.getString("schulnetz-base", null), legacyConnected = prefs.getBoolean("school-linked", false), newId = "aaaaaa01", now = "2026-11-09T20:00:00Z")
        val one = registry.connections.single()
        assertEquals(PRIMARY_SLOT, one.slot)
        val primary = SlotPrefs(prefs, one.slot)
        // Signed in, same cursor, same alert settings: nothing moved, nothing logged out.
        assertEquals("{\"id\":\"abc\"}", primary.getString("web-session", null))
        assertTrue(primary.getBoolean("school-linked", false))
        assertEquals(41L, primary.getLong("change-cursor", 0L))
        assertFalse(primary.getBoolean(NotifyPrefs.GRADES, true))
    }

    @Test fun twoConnectionsNeverShareOrOverwriteTheirState() {
        val prefs = MemoryPrefs()
        val (registry, second) = migrateConnections(null, "https://www.schulnetz-ag.ch/aksa", true, "aaaaaa01", "2026-11-09T20:00:00Z")
            .add(SchoolProvider.SCHULNETZ, "Zweites Konto", "https://www.schulnetz-ag.ch/aksa", "bbbbbb02", "2026-11-09T20:00:00Z")
        val first = SlotPrefs(prefs, registry.connections.first().slot)
        val other = SlotPrefs(prefs, second.slot)
        first.edit().putString("web-session", "first").putLong("change-cursor", 7L).putBoolean(NotifyPrefs.GRADES, false)
            .putStringSet("seen-changes", setOf("grade:g1:x")).apply()
        other.edit().putString("web-session", "second").putLong("change-cursor", 99L).apply()
        assertEquals("first", first.getString("web-session", null))
        assertEquals("second", other.getString("web-session", null))
        assertEquals(7L, first.getLong("change-cursor", 0L))
        assertEquals(99L, other.getLong("change-cursor", 0L))
        // Settings and shown notices of one connection are not the other's.
        assertTrue(other.getBoolean(NotifyPrefs.GRADES, true))
        assertNull(other.getStringSet("seen-changes", null))
        // Removing the second connection's keys leaves the first one untouched.
        val keys = other.keys()
        assertEquals(setOf("web-session@${second.slot}", "change-cursor@${second.slot}"), keys)
        keys.forEach { prefs.edit().remove(it).apply() }
        assertNull(other.getString("web-session", null))
        assertEquals("first", first.getString("web-session", null))
        assertEquals(7L, first.getLong("change-cursor", 0L))
        // The original slot never lists another connection's keys as its own.
        assertTrue(first.keys().isEmpty())
    }
}
