package ch.fasrv.fanotes

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import ch.fasrv.fanotes.sync.SyncApi
import ch.fasrv.fanotes.sync.SyncEngine
import ch.fasrv.fanotes.sync.SyncEngineOptions
import ch.fasrv.fanotes.sync.syncPrefixesFromSetting
import ch.fasrv.fanotes.vault.DirectoryVault
import ch.fasrv.fanotes.vault.NoteStore
import ch.fasrv.fanotes.vault.VaultIo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.io.File
import java.security.MessageDigest

class FaNotesApplication : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        graph.handwritingLearning.attach()
        graph.installDiagnosticsHook()
        if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(SYNC_CHANNEL, "Sync", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Keeps the FaNotes vault in sync"
                },
            )
        }
    }

    companion object {
        const val SYNC_CHANNEL = "fanotes-sync"
    }
}

class AppGraph(context: Context) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val prefs = context.getSharedPreferences("fanotes", Context.MODE_PRIVATE)
    private val secrets = VaultSecrets(context)
    val defaultRoot: File = File(context.filesDir, "vault").apply { mkdirs() }
    var vault: VaultIo = DirectoryVault(defaultRoot.toPath())
    /** Opt-in diagnostics. Both toggles are off until the user switches them on in Settings → Statistik. */
    val diagnostics: ch.fasrv.fanotes.desk.DiagnosticsClient = ch.fasrv.fanotes.desk.DiagnosticsClient(
        PrefsDiagnosticsStorage(context.getSharedPreferences("fanotes-diagnostics", Context.MODE_PRIVATE)),
        OkHttpDiagnosticsTransport(),
        {
            ch.fasrv.fanotes.desk.DiagnosticsApp(
                version = installedAppVersion(context),
                platform = "android",
                arch = Build.SUPPORTED_ABIS.firstOrNull().orEmpty(),
                language = java.util.Locale.getDefault().language,
            )
        },
    )
    private val appContext = context.applicationContext

    /** The real vault path, the SAF tree URI and its display name, the device model and the device name, so none of them survives scrubbing. */
    private fun diagnosticsContext(): ch.fasrv.fanotes.desk.DiagnosticsContext {
        val tree = prefs.getString("vault-uri", null)?.takeIf { it.isNotBlank() }
        val treeName = tree?.let { treeDisplayName(it) }
        val deviceName = runCatching { android.provider.Settings.Global.getString(appContext.contentResolver, "device_name") }.getOrNull()
        return ch.fasrv.fanotes.desk.DiagnosticsContext(
            vaultPath = defaultRoot.absolutePath,
            homeDir = appContext.filesDir.parent.orEmpty(),
            extraPaths = listOfNotNull(tree),
            extraNames = listOfNotNull(treeName, Build.MODEL, Build.DEVICE, deviceName, prefs.getString("device-name", null))
                .map { it.trim() }.filter { it.length >= 3 },
        )
    }

    private fun treeDisplayName(tree: String): String? = runCatching {
        val uri = android.net.Uri.parse(tree)
        val doc = android.provider.DocumentsContract.buildDocumentUriUsingTree(uri, android.provider.DocumentsContract.getTreeDocumentId(uri))
        appContext.contentResolver.query(doc, arrayOf(android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        }
    }.getOrNull()

    fun configureDiagnostics(settings: Map<String, String> = readDesk()) {
        diagnostics.configure(
            ch.fasrv.fanotes.desk.DiagnosticsConsent(usage = settings["diagnostics-usage"] == "on", logs = settings["diagnostics-logs"] == "on"),
            diagnosticsContext(),
        )
    }

    /** Uncaught errors go to the diagnostics ring (class, code, app frames, hash only) and then on to the system handler. */
    fun installDiagnosticsHook() {
        configureDiagnostics()
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching {
                diagnostics.recordError(error)
                diagnostics.flush()
            }
            previous?.uncaughtException(thread, error)
        }
    }

    val handwritingLearning by lazy { HandwritingLearning(context.applicationContext, this) }
    var store: NoteStore = NoteStore(vault) { path -> handwritingLearning.changed(path) }
    var vaultId: String = fingerprint(defaultRoot.absolutePath)
    var initialVaultLabel: String = "Auf diesem Tablet"
    @Volatile var busyPaths: Set<String> = emptySet()
    /** Stories open in the writing mode: sync waits for their files as the gate says (OpenStoryGate). */
    @Volatile var openStories: Set<ch.fasrv.fanotes.sync.OpenStoryGate> = emptySet()
    val remoteListeners = mutableListOf<(List<String>, List<String>) -> Unit>()
    private val stateDir = File(context.filesDir, "sync-state").apply { mkdirs() }
    private val glyphFile = File(context.filesDir, "glyph-samples.json")

    val engine: SyncEngine

    init {
        val savedUri = prefs.getString("vault-uri", null)
        if (!savedUri.isNullOrBlank()) {
            val uri = android.net.Uri.parse(savedUri)
            val allowed = context.contentResolver.persistedUriPermissions.any { permission ->
                permission.uri == uri && permission.isReadPermission && permission.isWritePermission
            }
            if (allowed) {
                vault = SafVault(context, uri)
                store = NoteStore(vault) { path -> handwritingLearning.changed(path) }
                vaultId = fingerprint(savedUri)
                initialVaultLabel = "Ausgewählter Ordner"
            }
        }
        engine = SyncEngine(
            SyncApi(OkHttpSyncTransport()),
            SyncEngineOptions(
                platform = "android",
                deviceName = { prefs.getString("device-name", null)?.ifBlank { null } ?: android.os.Build.MODEL.ifBlank { "Android tablet" } },
                automatic = { prefs.getBoolean("sync-automatic", true) },
                isPathBusy = { path -> path in busyPaths || openStories.any { it.isBusy(path) } },
                excludedPrefixes = { syncPrefixesFromSetting(readDesk()["sync-excluded"]) },
                includeHistory = { readDesk()["sync-history"] == "on" },
                onApplied = { written, removed ->
                    synchronized(remoteListeners) { remoteListeners.toList() }.forEach { it(written, removed) }
                    handwritingLearning.changed(written + removed)
                },
            ),
        )
        engine.attach(host())
    }

    fun useDirectory(root: File) {
        vault = DirectoryVault(root.toPath())
        store = NoteStore(vault) { path -> handwritingLearning.changed(path) }
        vaultId = fingerprint(root.absolutePath)
        engine.attach(host())
        handwritingLearning.attach()
    }

    fun useSaf(io: VaultIo, id: String) {
        vault = io
        store = NoteStore(vault) { path -> handwritingLearning.changed(path) }
        vaultId = id
        engine.attach(host())
        handwritingLearning.attach()
    }

    /**
     * Where the Statistik page keeps what it read from each note of the open vault, so opening it again
     * (or after the app restarted) does not read the vault again. One file per vault, in private storage.
     */
    fun statsCache(): ch.fasrv.fanotes.desk.StatsCacheStore =
        ch.fasrv.fanotes.desk.FileStatsCacheStore(File(File(appContext.filesDir, "stats-cache"), fingerprint(vaultId) + ".jsonl"))

    fun rememberTree(uri: String?) {
        prefs.edit().putString("vault-uri", uri).apply()
    }

    fun savedTree(): String? = prefs.getString("vault-uri", null)

    fun setDeviceName(name: String) {
        prefs.edit().putString("device-name", name.take(80)).apply()
    }

    fun deviceName(): String = prefs.getString("device-name", null).orEmpty()

    fun setAutomatic(enabled: Boolean) {
        prefs.edit().putBoolean("sync-automatic", enabled).apply()
    }

    fun automatic(): Boolean = prefs.getBoolean("sync-automatic", true)

    fun readDesk(): Map<String, String> = prefs.getString("desk-settings", null).orEmpty()
        .lineSequence()
        .mapNotNull { line ->
            val cut = line.indexOf('=')
            if (cut <= 0) null else line.substring(0, cut) to line.substring(cut + 1)
        }
        .toMap()

    fun readCustomCss(): String = prefs.getString("custom-css", null).orEmpty()

    fun writeCustomCss(value: String) {
        prefs.edit().putString("custom-css", value.take(ch.fasrv.fanotes.desk.CUSTOM_CSS_MAX)).apply()
    }

    fun writeDesk(values: Map<String, String>) {
        val text = values.entries.joinToString("\n") { (key, value) -> "$key=${value.replace("\n", " ")}" }
        prefs.edit().putString("desk-settings", text).apply()
    }

    fun readWorkspace(vaultId: String): String? = prefs.getString("workspace-$vaultId", null)

    fun writeWorkspace(vaultId: String, json: String) {
        prefs.edit().putString("workspace-$vaultId", json).apply()
    }

    fun readExpandedFolders(vaultId: String): String? = prefs.getString("fanotes.treeExpanded.v1-$vaultId", null)

    fun writeExpandedFolders(vaultId: String, json: String) {
        prefs.edit().putString("fanotes.treeExpanded.v1-$vaultId", json).apply()
    }

    fun readPaperViews(): String? = prefs.getString(ch.fasrv.fanotes.desk.PAPER_VIEW_MEMORY_KEY, null)

    fun writePaperViews(json: String) {
        prefs.edit().putString(ch.fasrv.fanotes.desk.PAPER_VIEW_MEMORY_KEY, json).apply()
    }

    fun readGlyphLibrary(): String = if (glyphFile.isFile) glyphFile.readText() else ""

    fun writeGlyphLibrary(text: String) {
        if (text.isEmpty()) {
            glyphFile.delete()
        } else {
            glyphFile.writeText(text)
        }
    }

    private fun host() = IoSyncHost(
        io = { vault },
        currentVaultId = { vaultId },
        stateFile = { File(stateDir, fingerprint(it) + ".json") },
        secrets = secrets,
    )
}

private fun fingerprint(value: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
    return digest.joinToString("") { "%02x".format(it) }.take(32)
}
