package ch.fasrv.fanotes

import android.content.Context
import ch.fasrv.fanotes.famd.FAMD_EXTENSION
import ch.fasrv.fanotes.famd.isoNow
import ch.fasrv.fanotes.famd.companionPath
import ch.fasrv.fanotes.share.PROFILE_SERVER_THEMES
import ch.fasrv.fanotes.share.ProfileException
import ch.fasrv.fanotes.share.ProfileNoteSource
import ch.fasrv.fanotes.share.PublicProfile
import ch.fasrv.fanotes.share.SHARE_MAX_NOTES
import ch.fasrv.fanotes.share.ShareException
import ch.fasrv.fanotes.share.ShareHttpRequest
import ch.fasrv.fanotes.share.ShareHttpResponse
import ch.fasrv.fanotes.share.ShareLinkRecord
import ch.fasrv.fanotes.share.ShareMode
import ch.fasrv.fanotes.share.ShareNote
import ch.fasrv.fanotes.share.ShareTransport
import ch.fasrv.fanotes.share.claimUsername
import ch.fasrv.fanotes.share.createProfileOwnerId
import ch.fasrv.fanotes.share.createShareId
import ch.fasrv.fanotes.share.fetchPublicProfile
import ch.fasrv.fanotes.share.liveSharesFor
import ch.fasrv.fanotes.share.markShareStopped
import ch.fasrv.fanotes.share.normalizeUsername
import ch.fasrv.fanotes.share.parseShareDirectory
import ch.fasrv.fanotes.share.profileViewUrl
import ch.fasrv.fanotes.share.publishProfile
import ch.fasrv.fanotes.share.publishShare
import ch.fasrv.fanotes.share.rememberShare
import ch.fasrv.fanotes.share.serializeShareDirectory
import ch.fasrv.fanotes.share.shareNoteFrom
import ch.fasrv.fanotes.share.shareStillActive
import ch.fasrv.fanotes.share.stopShare
import ch.fasrv.fanotes.share.unpublishProfile
import ch.fasrv.fanotes.share.usernameProblem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Blocking HTTP for the share and profile calls. Always called on an IO dispatcher. */
class OkHttpShareTransport(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build(),
) : ShareTransport {
    override fun exchange(request: ShareHttpRequest): ShareHttpResponse {
        val body = when (request.method) {
            "GET", "DELETE", "HEAD" -> null
            else -> request.body.toRequestBody("application/json; charset=utf-8".toMediaType())
        }
        val builder = Request.Builder().url(request.url).method(request.method, body).header("Cache-Control", "no-store")
        request.headers.forEach { (name, value) -> if (!name.equals("Content-Type", true)) builder.header(name, value) }
        try {
            client.newCall(builder.build()).execute().use { response ->
                return ShareHttpResponse(response.code, response.body?.string().orEmpty())
            }
        } catch (error: IOException) {
            throw ShareException("Der Freigabe-Server ist nicht erreichbar.")
        }
    }
}

/** What the share dialog shows. [rootPath] is a note or a folder of the vault. */
data class ShareDialogState(
    val rootPath: String,
    val isFolder: Boolean,
    val busy: Boolean = false,
    val error: String? = null,
    val created: ShareLinkRecord? = null,
)

data class ProfileState(
    val username: String = "",
    val claimed: Boolean = false,
    val public: Boolean = false,
    val busy: Boolean = false,
    val message: String? = null,
    val overview: PublicProfile? = null,
)

/**
 * Note links and the public profile, on top of the pure code in `ch.fasrv.fanotes.share`. Links are listed in a
 * private preferences file of this device: the server cannot list them (the link id is the capability).
 */
class ShareService(context: Context, private val graph: AppGraph) {
    private val prefs = context.getSharedPreferences("fanotes-share", Context.MODE_PRIVATE)
    private val transport = OkHttpShareTransport()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    val shares = MutableStateFlow(parseShareDirectory(prefs.getString("directory", null)))
    val dialog = MutableStateFlow<ShareDialogState?>(null)
    val profile = MutableStateFlow(
        ProfileState(
            username = prefs.getString("profile-name", "").orEmpty(),
            claimed = prefs.getBoolean("profile-claimed", false),
            public = prefs.getBoolean("profile-public", false),
        ),
    )

    private val liveJobs = HashMap<String, Job>()

    private fun saveShares(next: List<ShareLinkRecord>) {
        shares.value = next
        prefs.edit().putString("directory", serializeShareDirectory(next)).apply()
    }

    fun openDialog(rootPath: String, isFolder: Boolean = false) {
        dialog.value = ShareDialogState(rootPath.trim('/'), isFolder)
    }

    fun closeDialog() {
        dialog.value = null
    }

    /** The notes below [rootPath]: the note itself, or every Markdown note of the folder. */
    private fun collectNotes(rootPath: String, isFolder: Boolean): List<ShareNote> {
        val paths = if (!isFolder) {
            listOf(rootPath)
        } else {
            val prefix = rootPath.trim('/') + "/"
            graph.vault.walkFiles()
                .filter { !it.directory && !it.path.startsWith(".") && it.path.startsWith(prefix) && (it.path.endsWith(".md", true) || it.path.endsWith(".markdown", true)) }
                .map { it.path }
                .sorted()
                .take(SHARE_MAX_NOTES + 1)
        }
        return paths.mapNotNull { path -> runCatching { noteFor(path) }.getOrNull() }
    }

    private fun noteFor(path: String): ShareNote {
        val open = graph.store.readNote(path)
        val markdown = open.markdown.replace(Regex("<!--\\s*fanotes-ink:[a-zA-Z0-9_-]+\\s*-->\\n?"), "").trimEnd() + "\n"
        return shareNoteFrom(path, markdown, open.document, open.payload)
    }

    fun publish(mode: ShareMode) {
        val state = dialog.value ?: return
        if (state.busy) return
        dialog.value = state.copy(busy = true, error = null, created = null)
        scope.launch {
            val next = try {
                val notes = collectNotes(state.rootPath, state.isFolder)
                val record = publishShare(transport, createShareId(), mode, state.rootPath, notes, isoNow())
                saveShares(rememberShare(shares.value, record))
                state.copy(busy = false, created = record)
            } catch (error: ShareException) {
                state.copy(busy = false, error = error.message)
            } catch (error: Exception) {
                state.copy(busy = false, error = "Die Freigabe ist fehlgeschlagen.")
            }
            if (dialog.value?.rootPath == state.rootPath) dialog.value = next
        }
    }

    fun stop(id: String, onDone: (String) -> Unit = {}) {
        scope.launch {
            val text = try {
                stopShare(transport, id)
                saveShares(markShareStopped(shares.value, id))
                "Freigabe beendet."
            } catch (error: ShareException) {
                error.message ?: "Freigabe konnte nicht beendet werden."
            }
            if (dialog.value?.created?.id == id && text == "Freigabe beendet.") dialog.value = dialog.value?.copy(created = null)
            onDone(text)
        }
    }

    fun forget(id: String) {
        saveShares(shares.value.filter { it.id != id })
    }

    /** Asks the server which remembered links still answer, and marks the ended ones. */
    fun checkLinks() {
        scope.launch {
            var next = shares.value
            for (share in shares.value.filter { !it.stopped }.take(30)) {
                val active = runCatching { shareStillActive(transport, share.id) }.getOrNull()
                if (active == false) next = markShareStopped(next, share.id)
            }
            if (next != shares.value) saveShares(next)
        }
    }

    /** A note was saved: its live links are uploaded again, once for a burst of saves. */
    fun noteSaved(path: String) {
        if (shares.value.none { it.mode == ShareMode.LIVE && !it.stopped }) return
        val notePath = if (path.endsWith(FAMD_EXTENSION)) {
            listOf(companionPath(path, ".md"), path).firstOrNull { graph.vault.exists(it) } ?: path
        } else {
            path
        }
        val live = liveSharesFor(shares.value, notePath)
        for (share in live) {
            synchronized(liveJobs) {
                liveJobs[share.id]?.cancel()
                liveJobs[share.id] = scope.launch {
                    delay(8_000)
                    refreshLive(share)
                }
            }
        }
    }

    private fun refreshLive(share: ShareLinkRecord) {
        runCatching {
            val notes = collectNotes(share.rootPath, share.kind == "folder")
            if (notes.isEmpty()) return
            publishShare(transport, share.id, ShareMode.LIVE, share.rootPath, notes, isoNow())
        }.onFailure { error ->
            // 410: the link was stopped on another device. Remember it so the list is honest.
            if (error is ShareException && error.status == 410) saveShares(markShareStopped(shares.value, share.id))
        }
    }

    fun refreshAllLive() {
        scope.launch { shares.value.filter { it.mode == ShareMode.LIVE && !it.stopped }.take(10).forEach { refreshLive(it) } }
    }

    // ---- profile ----

    private fun ownerId(): String {
        val saved = prefs.getString("profile-owner", null)
        if (saved != null && ch.fasrv.fanotes.share.isProfileOwnerId(saved)) return saved
        return createProfileOwnerId().also { prefs.edit().putString("profile-owner", it).apply() }
    }

    private fun saveProfile(next: ProfileState) {
        profile.value = next
        prefs.edit()
            .putString("profile-name", next.username)
            .putBoolean("profile-claimed", next.claimed)
            .putBoolean("profile-public", next.public)
            .apply()
    }

    fun setUsernameDraft(value: String) {
        profile.value = profile.value.copy(username = value.take(40), message = null)
    }

    fun profileLink(): String? = normalizeUsername(profile.value.username)?.takeIf { profile.value.claimed }?.let { profileViewUrl(it) }

    private fun failure(error: Exception, fallback: String) = when (error) {
        is ProfileException, is ShareException -> error.message ?: fallback
        else -> fallback
    }

    fun claim() {
        val draft = profile.value
        usernameProblem(draft.username)?.let {
            profile.value = draft.copy(message = it)
            return
        }
        profile.value = draft.copy(busy = true, message = null)
        scope.launch {
            val next = try {
                val joined = isoNow()
                val claim = claimUsername(transport, draft.username, ownerId(), joined)
                saveProfile(ProfileState(claim.username, claimed = true, public = claim.public, message = "Benutzername gespeichert."))
                profile.value
            } catch (error: Exception) {
                draft.copy(busy = false, message = failure(error, "Der Benutzername konnte nicht gespeichert werden."))
            }
            profile.value = next.copy(busy = false)
        }
    }

    /** Switch on: publish the numbers. Switch off: take the page down. */
    fun setPublic(enabled: Boolean) {
        val draft = profile.value
        val name = normalizeUsername(draft.username)
        if (name == null || !draft.claimed) {
            profile.value = draft.copy(message = "Zuerst einen Benutzernamen festlegen.")
            return
        }
        profile.value = draft.copy(busy = true, message = null)
        scope.launch {
            val next = try {
                if (enabled) {
                    val overview = publishProfile(transport, name, ownerId(), loadNotes(), theme = theme(), accent = graph.readDesk()["accent"], accentSecondary = graph.readDesk()["accent-secondary"])
                    draft.copy(public = true, busy = false, overview = overview, message = "Profil ist öffentlich.")
                } else {
                    unpublishProfile(transport, name, ownerId())
                    draft.copy(public = false, busy = false, overview = null, message = "Profil ist nicht mehr öffentlich.")
                }
            } catch (error: Exception) {
                draft.copy(busy = false, message = failure(error, "Die Übersicht konnte nicht gespeichert werden."))
            }
            saveProfile(next)
        }
    }

    fun loadOverview() {
        val draft = profile.value
        val name = normalizeUsername(draft.username) ?: return
        if (!draft.claimed) return
        scope.launch {
            val overview = runCatching { fetchPublicProfile(transport, name) }.getOrNull()
            profile.value = profile.value.copy(overview = overview)
            if (overview == null && draft.public) saveProfile(profile.value.copy(public = false))
        }
    }

    private fun theme(): String? = graph.readDesk()["theme"]?.takeIf { it in PROFILE_SERVER_THEMES }

    /** Counts and dates of every Markdown note. Only the page statistics are read, never the text. */
    private fun loadNotes(): List<ProfileNoteSource> {
        val out = ArrayList<ProfileNoteSource>()
        for (entry in graph.vault.walkFiles()) {
            if (entry.directory || entry.path.startsWith(".")) continue
            if (!(entry.path.endsWith(".md", true) || entry.path.endsWith(".markdown", true))) continue
            val famd = companionPath(entry.path, FAMD_EXTENSION)
            val stats = runCatching {
                graph.vault.readHead(famd, 24 * 1024 * 1024)?.takeIf { it.complete }?.bytes?.decodeToString()
                    ?.let { ch.fasrv.fanotes.famd.parseFamd(it, unpackPoints = false).payload?.obj("pageStats") }
                    ?.let { ch.fasrv.fanotes.desk.parsePageStats(it) }
            }.getOrNull()
            out += ProfileNoteSource(
                createdAt = stats?.createdAt,
                modifiedAt = stats?.modifiedAt,
                firstOpenedAt = stats?.firstOpenedAt,
                lastOpenedAt = stats?.lastOpenedAt,
                lastSavedAt = stats?.lastSavedAt,
                dwellMs = stats?.dwellMs ?: 0,
                activeDays = stats?.activeDays.orEmpty(),
            )
        }
        return out
    }

    /** After a vault change the public numbers are refreshed when the page is public (at most once a day). */
    fun refreshPublicOverview() {
        val state = profile.value
        if (!state.public || !state.claimed) return
        val last = prefs.getLong("profile-refreshed", 0)
        if (System.currentTimeMillis() - last < 24 * 3_600_000L) return
        prefs.edit().putLong("profile-refreshed", System.currentTimeMillis()).apply()
        scope.launch {
            runCatching {
                val name = normalizeUsername(state.username) ?: return@launch
                val notes = loadNotes()
                if (notes.isNotEmpty()) publishProfile(transport, name, ownerId(), notes, theme = theme(), accent = graph.readDesk()["accent"], accentSecondary = graph.readDesk()["accent-secondary"])
            }
        }
    }
}
