package ch.fasrv.fanotes.sync

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import kotlinx.coroutines.runBlocking
import java.nio.charset.StandardCharsets
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SyncEngineTest {
    @Test
    fun passwordChangeKeepsNotesAndDeletingTheAccountSignsOut() = runBlocking {
        val server = MemorySyncServer()
        val host = MemoryHost("vault")
        val engine = engine(SyncApi(server), host, "Tablet")
        try {
            engine.register("ada@example.com", "correct horse")
            host.put("Notes/Hello.md", "Hello\n".encodeToByteArray(), 1_000)
            engine.syncNow()
            var rejected = false
            try {
                engine.changePassword("wrong password", "brand new secret")
            } catch (_: Exception) {
                rejected = true
            }
            assertTrue(rejected)
            assertEquals(SyncStatus.IDLE, engine.state.value.status)
            engine.changePassword("correct horse", "brand new secret")
            assertTrue(engine.state.value.log.any { it.text.contains("Passwort geändert") })
            val otherHost = MemoryHost("other")
            val other = engine(SyncApi(server), otherHost, "Other")
            try {
                var oldRejected = false
                try {
                    other.login("ada@example.com", "correct horse")
                } catch (_: Exception) {
                    oldRejected = true
                }
                assertTrue(oldRejected)
                other.login("ada@example.com", "brand new secret")
                other.syncNow()
                assertEquals("Hello\n", otherHost.read("Notes/Hello.md").decodeToString())
            } finally {
                other.close()
            }
            var deleteRejected = false
            try {
                engine.deleteAccount("correct horse")
            } catch (_: Exception) {
                deleteRejected = true
            }
            assertTrue(deleteRejected)
            assertEquals(SyncStatus.IDLE, engine.state.value.status)
            engine.deleteAccount("brand new secret")
            assertEquals(SyncStatus.SIGNED_OUT, engine.state.value.status)
            assertTrue(engine.state.value.log.any { it.text.contains("gelöscht") })
        } finally {
            engine.close()
        }
    }

    @Test
    fun twoDevicesRoundTripAndKeepBothSidesOfAConflict() = runBlocking {
        val server = MemorySyncServer()
        val apiA = SyncApi(server)
        val apiB = SyncApi(server)
        val hostA = MemoryHost("vault-a")
        val hostB = MemoryHost("vault-b")
        val engineA = engine(apiA, hostA, "Tablet A")
        val engineB = engine(apiB, hostB, "Tablet B")
        try {
            engineA.register("ada@example.com", "correct horse")
            hostA.put("Notes/Hello.md", "Hello from A\n".encodeToByteArray(), 1_000)
            engineA.syncNow()
            engineB.login("ada@example.com", "correct horse")
            engineB.syncNow()
            assertEquals("Hello from A\n", hostB.read("Notes/Hello.md").decodeToString())

            hostA.put("Notes/Hello.md", "Hello from A revised\n".encodeToByteArray(), 2_000)
            hostB.put("Notes/Hello.md", "Hello from B\n".encodeToByteArray(), 3_000)
            engineA.syncNow()
            engineB.syncNow()
            engineA.syncNow()

            assertEquals("Hello from A revised\n", hostB.read("Notes/Hello.md").decodeToString())
            assertTrue(hostB.files.keys.any { it.contains("Konflikt") && it.endsWith(".md") })
            assertTrue(hostA.files.keys.any { it.contains("Konflikt") })
            assertEquals(SyncStatus.IDLE, engineA.state.value.status)
            assertEquals(SyncStatus.IDLE, engineB.state.value.status)
        } finally {
            engineA.close()
            engineB.close()
        }
    }

    private fun engine(api: SyncApi, host: MemoryHost, name: String): SyncEngine {
        val engine = SyncEngine(api, SyncEngineOptions(platform = "android", deviceName = { name }, automatic = { true }))
        engine.attach(host)
        return engine
    }
}

private class MemoryHost(private val id: String) : SyncHost {
    val files = linkedMapOf<String, Pair<ByteArray, Long>>()
    private var secrets: String? = null
    private var state: String? = null

    fun put(path: String, bytes: ByteArray, mtime: Long) = synchronized(files) {
        files[path] = bytes to mtime
    }

    override suspend fun vaultId() = id
    override suspend fun scan() = synchronized(files) {
        files.map { (path, value) -> SyncScanEntry(path, value.first.size.toLong(), value.second) }
    }
    override suspend fun read(path: String) = synchronized(files) {
        files[path]?.first ?: throw NoSuchElementException(path)
    }
    override suspend fun write(path: String, bytes: ByteArray, mtimeMs: Long): SyncScanEntry = synchronized(files) {
        files[path] = bytes to mtimeMs
        SyncScanEntry(path, bytes.size.toLong(), mtimeMs)
    }
    override suspend fun remove(path: String) {
        synchronized(files) { files.remove(path) }
    }
    override suspend fun readState(vaultId: String) = state
    override suspend fun writeState(vaultId: String, json: String?) { state = json }
    override suspend fun readSecrets() = secrets
    override suspend fun writeSecrets(json: String?) { secrets = json }
}

/**
 * In-memory stand-in for `fanotes-site/sync-api.mjs`: revisions, If-Match and tombstones.
 * The auth key is compared directly; the real server scrypts it again, which does not change the client.
 */
private class MemorySyncServer : SyncTransport {
    private val accounts = linkedMapOf<String, Account>()
    private val sessions = linkedMapOf<String, String>()

    override suspend fun execute(request: SyncHttpRequest): SyncHttpResponse = synchronized(this) {
        val path = request.url.substringAfter("/api/v1/sync")
        val account = accountFor(request)
        try {
            when {
                path == "/prelogin" && request.method == "POST" -> prelogin(request)
                path == "/register" && request.method == "POST" -> register(request)
                path == "/login" && request.method == "POST" -> login(request)
                path == "/password" && request.method == "POST" -> changePassword(requireNotNull(account), request)
                path == "/account" && request.method == "DELETE" -> deleteAccount(requireNotNull(account), request)
                path == "/changes" || path.startsWith("/changes?") -> {
                    val since = path.substringAfter("since=", "0").toLong()
                    changes(requireNotNull(account), since)
                }
                path.startsWith("/files/") && request.method == "GET" -> download(requireNotNull(account), path.removePrefix("/files/"))
                path.startsWith("/files/") && request.method == "PUT" -> upload(requireNotNull(account), path.removePrefix("/files/"), request)
                path.startsWith("/files/") && request.method == "DELETE" -> remove(requireNotNull(account), path.removePrefix("/files/"), request)
                else -> json(404, """{"error":"not found"}""")
            }
        } catch (error: Exception) {
            json(500, """{"error":${ch.fasrv.fanotes.json.escapeJson(error.message ?: "error")}}""")
        }
    }

    private fun prelogin(request: SyncHttpRequest): SyncHttpResponse {
        val email = (parseJson(request.body!!.decodeToString()) as JsonValue.Obj).string("email")
        val account = accounts.values.firstOrNull { it.email == email }
        val kdf = account?.kdf ?: SyncKdf(KDF_ALGORITHM, 600_000, "BwcHBwcHBwcHBwcHBwcHBw==")
        return json(200, """{"kdf":{"algorithm":"${kdf.algorithm}","iterations":${kdf.iterations},"salt":${ch.fasrv.fanotes.json.escapeJson(kdf.salt)}}}""")
    }

    private fun register(request: SyncHttpRequest): SyncHttpResponse {
        val body = parseJson(request.body!!.decodeToString()) as JsonValue.Obj
        val email = body.string("email") ?: error("email")
        if (accounts.values.any { it.email == email }) return json(409, """{"error":"exists"}""")
        val kdf = body.obj("kdf")!!
        val wrap = body.obj("vaultKeyWrap")!!
        val account = Account(
            id = UUID.randomUUID().toString(),
            email = email,
            authKey = body.string("authKey")!!,
            kdf = SyncKdf(kdf.string("algorithm")!!, kdf.double("iterations")!!.toInt(), kdf.string("salt")!!),
            wrap = SyncKeyWrap(wrap.string("iv")!!, wrap.string("data")!!),
        )
        accounts[account.id] = account
        val device = openDevice(account, body.obj("device")?.string("name") ?: "device")
        return json(201, """{"accountId":"${account.id}","deviceId":"${device.id}","token":"${device.token}","expiresAt":"2099-01-01T00:00:00.000Z","revision":0}""")
    }

    private fun changePassword(account: Account, request: SyncHttpRequest): SyncHttpResponse {
        val body = parseJson(request.body!!.decodeToString()) as JsonValue.Obj
        if (body.string("authKey") != account.authKey) return json(401, """{"error":"unauthorized"}""")
        val kdf = body.obj("kdf") ?: return json(400, """{"error":"kdf"}""")
        val wrap = body.obj("vaultKeyWrap") ?: return json(400, """{"error":"wrap"}""")
        account.authKey = body.string("newAuthKey") ?: return json(400, """{"error":"auth"}""")
        account.kdf = SyncKdf(kdf.string("algorithm") ?: "", kdf.double("iterations")?.toInt() ?: 0, kdf.string("salt") ?: "")
        account.wrap = SyncKeyWrap(wrap.string("iv") ?: "", wrap.string("data") ?: "")
        return json(200, "{}")
    }

    private fun deleteAccount(account: Account, request: SyncHttpRequest): SyncHttpResponse {
        val body = parseJson(request.body!!.decodeToString()) as JsonValue.Obj
        if (body.string("authKey") != account.authKey) return json(401, """{"error":"unauthorized"}""")
        accounts.remove(account.id)
        sessions.entries.removeAll { it.value == account.id }
        return json(200, "{}")
    }

    private fun login(request: SyncHttpRequest): SyncHttpResponse {
        val body = parseJson(request.body!!.decodeToString()) as JsonValue.Obj
        val email = body.string("email")
        val account = accounts.values.firstOrNull { it.email == email && it.authKey == body.string("authKey") }
            ?: return json(401, """{"error":"unauthorized"}""")
        val device = openDevice(account, body.obj("device")?.string("name") ?: "device")
        return json(200, """{"accountId":"${account.id}","deviceId":"${device.id}","token":"${device.token}","expiresAt":"2099-01-01T00:00:00.000Z","kdf":{"algorithm":"${account.kdf.algorithm}","iterations":${account.kdf.iterations},"salt":${ch.fasrv.fanotes.json.escapeJson(account.kdf.salt)}},"vaultKeyWrap":{"iv":${ch.fasrv.fanotes.json.escapeJson(account.wrap.iv)},"data":${ch.fasrv.fanotes.json.escapeJson(account.wrap.data)}},"revision":${account.revision}}""")
    }

    private fun changes(account: Account, since: Long): SyncHttpResponse {
        val entries = account.files.values.filter { it.revision > since }.sortedBy { it.revision }
        val page = entries.take(500)
        val next = page.lastOrNull()?.revision ?: account.revision
        val body = page.joinToString(",", prefix = "[", postfix = "]") { entryJson(it).removePrefix("\"entry\":") }
        return json(200, """{"revision":${account.revision},"entries":$body,"more":${entries.size > page.size},"nextSince":$next}""")
    }

    private fun download(account: Account, id: String): SyncHttpResponse {
        val entry = account.files[id] ?: return json(404, """{"error":"missing"}""")
        if (entry.deleted) {
            return SyncHttpResponse(204, mapOf("x-fanotes-revision" to entry.revision.toString(), "x-fanotes-deleted" to "1"), ByteArray(0))
        }
        return SyncHttpResponse(
            200,
            mapOf(
                "x-fanotes-revision" to entry.revision.toString(),
                "x-fanotes-meta" to entry.meta.orEmpty(),
                "x-fanotes-sha256" to entry.sha256.orEmpty(),
            ),
            entry.blob,
        )
    }

    private fun upload(account: Account, id: String, request: SyncHttpRequest): SyncHttpResponse {
        val base = header(request, "If-Match")?.trim('"')?.toLongOrNull() ?: return json(428, """{"error":"if-match"}""")
        val current = account.files[id]
        val currentRevision = current?.revision ?: 0L
        if (currentRevision != base) return conflict(current, id)
        val declared = header(request, "X-FaNotes-Sha256") ?: return json(400, """{"error":"sha"}""")
        val body = request.body ?: ByteArray(0)
        if (sha256Hex(body) != declared) return json(400, """{"error":"checksum"}""")
        account.revision += 1
        val entry = FileEntry(id, account.revision, false, body.size.toLong(), declared, header(request, "X-FaNotes-Meta"), body)
        account.files[id] = entry
        return json(200, """{"revision":${entry.revision}}""")
    }

    private fun remove(account: Account, id: String, request: SyncHttpRequest): SyncHttpResponse {
        val base = header(request, "If-Match")?.trim('"')?.toLongOrNull() ?: return json(428, """{"error":"if-match"}""")
        val current = account.files[id]
        if ((current?.revision ?: 0L) != base) return conflict(current, id)
        account.revision += 1
        account.files[id] = FileEntry(id, account.revision, true, 0, null, null, ByteArray(0))
        return json(200, """{"revision":${account.revision}}""")
    }

    private fun conflict(current: FileEntry?, id: String): SyncHttpResponse {
        val entry = current ?: FileEntry(id, 0, true, 0, null, null, ByteArray(0))
        return json(409, """{"error":"conflict","entry":${entryJson(entry).removePrefix("\"entry\":")}}""")
    }

    private fun openDevice(account: Account, name: String): Device {
        val device = Device(UUID.randomUUID().toString(), name, UUID.randomUUID().toString())
        account.devices += device
        sessions[device.token] = account.id
        return device
    }

    private fun accountFor(request: SyncHttpRequest): Account? {
        val token = header(request, "Authorization")?.removePrefix("Bearer ")?.trim() ?: return null
        val id = sessions[token] ?: return null
        return accounts[id]
    }

    private fun entryJson(entry: FileEntry): String {
        val sha = entry.sha256?.let { ch.fasrv.fanotes.json.escapeJson(it) } ?: "null"
        val meta = entry.meta?.let { ch.fasrv.fanotes.json.escapeJson(it) } ?: "null"
        return """"entry":{"id":"${entry.id}","revision":${entry.revision},"deleted":${entry.deleted},"size":${entry.size},"sha256":$sha,"meta":$meta,"updatedAt":null,"deviceId":null}"""
    }

    private fun json(status: Int, body: String) = SyncHttpResponse(status, mapOf("content-type" to "application/json"), body.toByteArray(StandardCharsets.UTF_8))

    private fun header(request: SyncHttpRequest, name: String) =
        request.headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

    private class Account(
        val id: String,
        val email: String,
        var authKey: String,
        var kdf: SyncKdf,
        var wrap: SyncKeyWrap,
        var revision: Long = 0,
        val files: LinkedHashMap<String, FileEntry> = linkedMapOf(),
        val devices: MutableList<Device> = mutableListOf(),
    )

    private class Device(val id: String, val name: String, val token: String)
    private class FileEntry(
        val id: String,
        val revision: Long,
        val deleted: Boolean,
        val size: Long,
        val sha256: String?,
        val meta: String?,
        val blob: ByteArray,
    )
}
