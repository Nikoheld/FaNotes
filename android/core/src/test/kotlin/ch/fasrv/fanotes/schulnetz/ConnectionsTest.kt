package ch.fasrv.fanotes.schulnetz

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ConnectionsTest {
    private val now = "2026-11-09T20:00:00Z"

    @Test fun anExistingInstallBecomesConnectionOneWithoutMovingAnything() {
        val migrated = migrateConnections(null, "https://www.schulnetz-ag.ch/aksa", legacyConnected = true, newId = "aaaaaa01", now = now)
        val one = migrated.connections.single()
        assertEquals(PRIMARY_SLOT, one.slot)
        assertEquals(SchoolProvider.SCHULNETZ, one.provider)
        assertEquals("https://www.schulnetz-ag.ch/aksa", one.baseUrl)
        assertEquals("Schulnetz AKSA", one.label)
        assertEquals(one, migrated.active)
        // The original keys, files, vault paths and cookie jar stay exactly where they were.
        assertEquals("web-session", slotKey(one.slot, "web-session"))
        assertEquals("schulnetz-snapshot.json", slotFileName(one.slot, "schulnetz-snapshot.json"))
        assertEquals(".fanotes/schulnetz/grade-book.json", slotVaultPath(one.slot, ".fanotes/schulnetz/grade-book.json"))
        assertNull(slotWebProfile(one.slot))
        assertEquals("grade:g1:x", slotChangeId(one.slot, "grade:g1:x"))
        // Migration runs once: a stored registry wins, also on later starts.
        assertEquals(migrated, migrateConnections(migrated.toJson(), "https://other.example/x", legacyConnected = true, newId = "bbbbbb02", now = now))
        // An install that never connected starts without connections.
        assertTrue(migrateConnections(null, null, legacyConnected = false, newId = "cccccc03", now = now).connections.isEmpty())
    }

    @Test fun furtherConnectionsGetTheirOwnStorageEverywhere() {
        val one = migrateConnections(null, "https://www.schulnetz-ag.ch/aksa", true, "aaaaaa01", now)
        val (two, bmz) = one.add(SchoolProvider.TAM, "", "https://intranet.tam.ch/bmz", "bbbbbb02", now)
        val (three, second) = two.add(SchoolProvider.SCHULNETZ, "Zweites Konto", "https://www.schulnetz-ag.ch/aksa", "cccccc03", now)
        assertEquals("TAM BMZ", bmz.label)
        assertEquals("cbbbbbb02", bmz.slot)
        assertEquals(second, three.active)
        val slots = three.connections.map { it.slot }
        assertEquals(slots.size, slots.toSet().size)
        // Two accounts at the same school: every key, file, vault path, cookie jar and change id differs.
        val first = three.connections.first()
        for ((a, b) in listOf(
            slotKey(first.slot, "web-session") to slotKey(second.slot, "web-session"),
            slotKey(first.slot, "notify-grades") to slotKey(second.slot, "notify-grades"),
            slotFileName(first.slot, "kanti-guest.json") to slotFileName(second.slot, "kanti-guest.json"),
            slotFileName(first.slot, "schulnetz-snapshot.json") to slotFileName(second.slot, "schulnetz-snapshot.json"),
            slotVaultPath(first.slot, ".fanotes/schulnetz/grade-book.json") to slotVaultPath(second.slot, ".fanotes/schulnetz/grade-book.json"),
            slotChangeId(first.slot, "grade:g1:x") to slotChangeId(second.slot, "grade:g1:x"),
        )) assertNotEquals(a, b)
        assertNotEquals(slotWebProfile(first.slot), slotWebProfile(second.slot))
        assertEquals("connections/ccccccc03/kanti-guest.json", slotFileName(second.slot, "kanti-guest.json"))
        assertEquals(".fanotes/schulnetz/connections/ccccccc03/colors.json", slotVaultPath(second.slot, ".fanotes/schulnetz/colors.json"))
        // App-wide vault files outside the school folder are not namespaced.
        assertEquals("Kalender.md", slotVaultPath(second.slot, "Kalender.md"))
    }

    @Test fun renameRemoveAndSwitchKeepTheRestIntact() {
        val (two, bmz) = migrateConnections(null, "https://www.schulnetz-ag.ch/aksa", true, "aaaaaa01", now)
            .add(SchoolProvider.TAM, "", "https://intranet.tam.ch/bmz", "bbbbbb02", now)
        val renamed = two.rename(bmz.id, "  Berufsmaturität\n BMZ  ")
        assertEquals("Berufsmaturität BMZ", renamed.byId(bmz.id)?.label)
        assertEquals(renamed, renamed.rename(bmz.id, "   "))
        val switched = renamed.activate("aaaaaa01")
        assertEquals("aaaaaa01", switched.active?.id)
        assertEquals(switched, switched.activate("missing0"))
        // Removing connection one frees the original slot; the next connection takes it again.
        val removed = switched.remove("aaaaaa01")
        assertEquals(listOf(bmz.id), removed.connections.map { it.id })
        assertEquals(bmz.id, removed.active?.id)
        val (again, fresh) = removed.add(SchoolProvider.SCHULNETZ, "", "https://www.schulnetz-ag.ch/kszofingen", "dddddd04", now)
        assertEquals(PRIMARY_SLOT, fresh.slot)
        assertEquals(2, again.connections.size)
        assertTrue(ConnectionRegistry().remove("x").connections.isEmpty())
    }

    @Test fun aDamagedOrHostileRegistryNeverMixesSlots() {
        assertNull(parseConnectionRegistry("not json"))
        assertNull(parseConnectionRegistry(""))
        val parsed = parseConnectionRegistry(
            """{"version":1,"active":"bbbbbb02","connections":[
               {"id":"aaaaaa01","provider":"schulnetz","label":"A","baseUrl":"https://www.schulnetz-ag.ch/aksa","slot":""},
               {"id":"bbbbbb02","provider":"tam","label":"B","baseUrl":"https://intranet.tam.ch/bmz","slot":""},
               {"id":"../etc","provider":"tam","label":"C","baseUrl":"x","slot":"c../etc"},
               {"id":"cccccc03","provider":"martian","label":"","baseUrl":"https://www.schulnetz-ag.ch/aksa","slot":"ccccccc03"}]}""",
        )!!
        // The second entry claims the original slot too and is dropped; a path in an id is dropped.
        assertEquals(listOf("aaaaaa01", "cccccc03"), parsed.connections.map { it.id })
        assertEquals(SchoolProvider.SCHULNETZ, parsed.byId("cccccc03")?.provider)
        assertEquals("Schulnetz AKSA", parsed.byId("cccccc03")?.label)
        // The stored active id is gone, so the first connection is shown.
        assertEquals("aaaaaa01", parsed.active?.id)
        val round = parseConnectionRegistry(parsed.toJson())
        assertEquals(parsed.connections, round?.connections)
    }

    @Test fun thereIsALimitAndIdsAreChecked() {
        var registry = ConnectionRegistry()
        for (index in 0 until MAX_CONNECTIONS) registry = registry.add(SchoolProvider.SCHULNETZ, "", "https://www.schulnetz-ag.ch/aksa", "conn${index}aaa", now).first
        assertFailsWith<IllegalArgumentException> { registry.add(SchoolProvider.TAM, "", "https://intranet.tam.ch/bmz", "connxxaaa", now) }
        assertFailsWith<IllegalArgumentException> { ConnectionRegistry().add(SchoolProvider.TAM, "", "https://intranet.tam.ch/bmz", "Bad/Id", now) }
    }

    @Test fun pushRouteKeysMatchTheServer() {
        // Shared test vector with fanotes-site fcm.mjs connectionRouteKey.
        assertEquals("b6df6a1c77130be8", connectionRouteKey("0123456789abcdef0123456789abcdef"))
        assertNotEquals(connectionRouteKey("0123456789abcdef0123456789abcdef"), connectionRouteKey("fedcba9876543210fedcba9876543210"))
    }
}
