package ch.fasrv.fanotes

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.DriveFileMove
import androidx.compose.material.icons.automirrored.filled.Redo
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.CleaningServices
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.desk.solveMathExpression
import ch.fasrv.fanotes.sync.pathIsSyncExcluded
import ch.fasrv.fanotes.sync.syncPrefixesFromSetting
import ch.fasrv.fanotes.desk.collectVaultTags
import ch.fasrv.fanotes.desk.filterVaultByTag
import ch.fasrv.fanotes.desk.breadcrumbsFor
import ch.fasrv.fanotes.desk.canGoBack
import ch.fasrv.fanotes.desk.canGoForward
import ch.fasrv.fanotes.ink.InkTool
import ch.fasrv.fanotes.sync.SyncStatus
import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.VaultNode

class MainActivity : ComponentActivity() {
    private val model: FaNotesViewModel by viewModels()
    private val openTree = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        if (uri == null) return@registerForActivityResult
        contentResolver.takePersistableUriPermission(
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        model.useTree(uri)
    }
    private val importPdf = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        import(uri, pdf = true)
    }
    private val importImage = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        import(uri, pdf = false)
    }
    private val importIcs = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@registerForActivityResult
        val text = contentResolver.openInputStream(uri)?.use { it.readBytes() }?.toString(Charsets.UTF_8) ?: return@registerForActivityResult
        model.importCalendarIcs(text)
    }
    private val exportIcs = registerForActivityResult(ActivityResultContracts.CreateDocument("text/calendar")) { uri ->
        if (uri == null) return@registerForActivityResult
        contentResolver.openOutputStream(uri)?.use { stream ->
            stream.write(model.calendarIcs().toByteArray(Charsets.UTF_8))
        }
    }
    private val exportNotePdf = registerForActivityResult(ActivityResultContracts.CreateDocument("application/pdf")) { uri ->
        if (uri != null) model.exportOpenNotePdf(uri)
    }
    private var pendingDownload: String? = null
    private val downloadNote = registerForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        val path = pendingDownload
        pendingDownload = null
        if (uri != null && path != null) model.saveNoteCopy(path, uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 30) {
            val best = display?.supportedModes?.maxByOrNull { it.refreshRate }
            if (best != null) window.attributes = window.attributes.apply { preferredDisplayModeId = best.modeId }
        }
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 21)
        }
        setContent {
            val rawDesk by model.deskSettings.collectAsStateWithLifecycle()
            val css by model.customCss.collectAsStateWithLifecycle()
            val desk = ch.fasrv.fanotes.desk.deskWithCustomCss(rawDesk, css)
            FaNotesTheme(
                desk["theme"].orEmpty(),
                desk["accent"].orEmpty(),
                desk["accent-secondary"].orEmpty(),
                desk["ui-font"].orEmpty(),
                ch.fasrv.fanotes.desk.parseCustomChrome(css),
            ) {
                FaNotesScreen(
                    model = model,
                    onOpenVault = { openTree.launch(null) },
                    onImportPdf = { importPdf.launch(arrayOf("application/pdf")) },
                    onImportImage = { importImage.launch(arrayOf("image/*")) },
                    onImportIcs = { importIcs.launch(arrayOf("text/calendar", "text/plain", "*/*")) },
                    onExportIcs = { exportIcs.launch("fanotes.ics") },
                    onExportPdf = { exportNotePdf.launch(ch.fasrv.fanotes.desk.PDF_EXPORT_FILE_NAME) },
                    onDownload = {
                        val path = model.open.value?.path.orEmpty()
                        if (!ch.fasrv.fanotes.desk.noteCanDownload(path)) model.refuseNoteDownload()
                        else {
                            pendingDownload = path
                            downloadNote.launch(ch.fasrv.fanotes.desk.noteDownloadFileName(path))
                        }
                    },
                )
            }
        }
    }

    override fun onPause() {
        try {
            kotlinx.coroutines.runBlocking {
                kotlinx.coroutines.withTimeout(4_000) { model.saveNow() }
            }
        } catch (_: Exception) {
            // A slow disk must not take the activity down. The next edit saves again.
        }
        super.onPause()
    }

    private fun import(uri: Uri?, pdf: Boolean) {
        if (uri == null) return
        val name = uri.lastPathSegment?.substringAfterLast('/') ?: if (pdf) "Document.pdf" else "Image.jpg"
        val bytes = model.readUri(uri) ?: return
        model.importBytes(name, bytes, pdf)
    }
}

private val PenColors = listOf("#202333", "#2457D6", "#D23B4A", "#1F8A4C", "#E2A21B", "#7A4DD6")
private val Papers = listOf(
    "blank" to "Leer",
    "dots" to "Punkte",
    "squares" to "Häuschen",
    "grid" to "Kariert",
    "lines" to "Linien",
    "millimeter" to "mm",
)
private val Brushes = listOf(
    "fineliner" to "Fineliner",
    "pencil" to "Bleistift",
    "marker" to "Marker",
    "paintbrush" to "Pinsel",
    "calligraphy" to "Kalligrafie",
    "highlighter" to "Textmarker",
    "watercolor" to "Aquarell",
    "spray" to "Spray",
)

@Composable
fun FaNotesTheme(
    themeName: String,
    accentHex: String = ch.fasrv.fanotes.desk.DEFAULT_ACCENT,
    accentSecondaryHex: String = ch.fasrv.fanotes.desk.DEFAULT_ACCENT_SECONDARY,
    uiFont: String = "inter",
    chrome: ch.fasrv.fanotes.desk.CustomChrome = ch.fasrv.fanotes.desk.CustomChrome(),
    content: @Composable () -> Unit,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val family = androidx.compose.ui.text.font.FontFamily(loadUiTypeface(context, uiFont))
    val palette = ch.fasrv.fanotes.desk.themePalette(themeName, androidx.compose.foundation.isSystemInDarkTheme())
    val background = Color(android.graphics.Color.parseColor(palette.background))
    val surface = Color(android.graphics.Color.parseColor(palette.surface))
    val surfaceVariant = Color(android.graphics.Color.parseColor(palette.surfaceVariant))
    val onSurface = Color(android.graphics.Color.parseColor(palette.text))
    val danger = Color(android.graphics.Color.parseColor(palette.danger))
    val accent = Color(android.graphics.Color.parseColor(ch.fasrv.fanotes.desk.normalizeAccent(accentHex)))
    val onAccent = Color(android.graphics.Color.parseColor(ch.fasrv.fanotes.desk.accentInk(accentHex)))
    val secondary = Color(android.graphics.Color.parseColor(ch.fasrv.fanotes.desk.normalizeAccentSecondary(accentSecondaryHex)))
    val onSecondary = Color(android.graphics.Color.parseColor(ch.fasrv.fanotes.desk.accentInk(accentSecondaryHex)))
    val baseScheme = if (palette.dark) {
        darkColorScheme(primary = accent, onPrimary = onAccent, secondary = secondary, onSecondary = onSecondary, onSurface = onSurface, background = background, surface = surface, surfaceVariant = surfaceVariant, error = danger)
    } else {
        lightColorScheme(primary = accent, onPrimary = onAccent, secondary = secondary, onSecondary = onSecondary, onSurface = onSurface, background = background, surface = surface, surfaceVariant = surfaceVariant, error = danger)
    }
    val scheme = baseScheme.copy(
        background = chrome.background?.let { Color(android.graphics.Color.parseColor(it)) } ?: baseScheme.background,
        surface = chrome.surface?.let { Color(android.graphics.Color.parseColor(it)) } ?: baseScheme.surface,
        onSurface = chrome.text?.let { Color(android.graphics.Color.parseColor(it)) } ?: baseScheme.onSurface,
    )
    MaterialTheme(colorScheme = scheme, typography = chromeTypography(family), content = content)
}

private fun chromeTypography(family: androidx.compose.ui.text.font.FontFamily): androidx.compose.material3.Typography {
    val base = androidx.compose.material3.Typography()
    return base.copy(
        displayLarge = base.displayLarge.copy(fontFamily = family),
        displayMedium = base.displayMedium.copy(fontFamily = family),
        displaySmall = base.displaySmall.copy(fontFamily = family),
        headlineLarge = base.headlineLarge.copy(fontFamily = family),
        headlineMedium = base.headlineMedium.copy(fontFamily = family),
        headlineSmall = base.headlineSmall.copy(fontFamily = family),
        titleLarge = base.titleLarge.copy(fontFamily = family),
        titleMedium = base.titleMedium.copy(fontFamily = family),
        titleSmall = base.titleSmall.copy(fontFamily = family),
        bodyLarge = base.bodyLarge.copy(fontFamily = family),
        bodyMedium = base.bodyMedium.copy(fontFamily = family),
        bodySmall = base.bodySmall.copy(fontFamily = family),
        labelLarge = base.labelLarge.copy(fontFamily = family),
        labelMedium = base.labelMedium.copy(fontFamily = family),
        labelSmall = base.labelSmall.copy(fontFamily = family),
    )
}

@Composable
fun FaNotesScreen(
    model: FaNotesViewModel,
    onOpenVault: () -> Unit,
    onImportPdf: () -> Unit,
    onImportImage: () -> Unit,
    onImportIcs: () -> Unit,
    onExportIcs: () -> Unit,
    onExportPdf: () -> Unit,
    onDownload: () -> Unit,
) {
    val tree by model.tree.collectAsStateWithLifecycle()
    val open by model.open.collectAsStateWithLifecycle()
    val tool by model.tool.collectAsStateWithLifecycle()
    val style by model.style.collectAsStateWithLifecycle()
    val finger by model.fingerDraws.collectAsStateWithLifecycle()
    val showText by model.showText.collectAsStateWithLifecycle()
    val showList by model.showList.collectAsStateWithLifecycle()
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val sync by model.sync.collectAsStateWithLifecycle()
    val message by model.message.collectAsStateWithLifecycle()
    val backdrop by model.backdrop.collectAsStateWithLifecycle()
    val token by model.canvasToken.collectAsStateWithLifecycle()
    val vaultLabel by model.vaultLabel.collectAsStateWithLifecycle()
    val destination by model.destination.collectAsStateWithLifecycle()
    val tabs by model.openTabs.collectAsStateWithLifecycle()
    val tagIndex by model.tagIndex.collectAsStateWithLifecycle()
    val tagFilter by model.tagFilter.collectAsStateWithLifecycle()
    val pinned by model.pinnedTabs.collectAsStateWithLifecycle()
    val trail by model.noteTrail.collectAsStateWithLifecycle()
    val rawDesk by model.deskSettings.collectAsStateWithLifecycle()
    val css by model.customCss.collectAsStateWithLifecycle()
    val desk = ch.fasrv.fanotes.desk.deskWithCustomCss(rawDesk, css)
    val chrome = ch.fasrv.fanotes.desk.parseCustomChrome(css)
    val split by model.splitPath.collectAsStateWithLifecycle()
    val palette by model.paletteOpen.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var firstRun by remember { mutableStateOf(desk["welcomed"] != "yes") }
    var profile by remember { mutableStateOf(desk["profile"].orEmpty().ifBlank { "school" }) }
    var editingBox by remember { mutableStateOf<String?>(null) }
    var boxText by remember { mutableStateOf("") }
    var syncOpen by remember { mutableStateOf(false) }
    var createNote by remember { mutableStateOf(false) }
    var createFolder by remember { mutableStateOf(false) }
    var createParent by remember { mutableStateOf("") }
    var renaming by remember { mutableStateOf<Pair<String, String>?>(null) }
    var moving by remember { mutableStateOf<String?>(null) }
    var syncPending by remember { mutableStateOf(false) }
    var mathOpen by remember { mutableStateOf(false) }
    var mathInput by remember { mutableStateOf("") }
    var mathOutput by remember { mutableStateOf("") }
    var mathOk by remember { mutableStateOf(false) }
    val wide = LocalConfiguration.current.screenWidthDp >= 840
    val signedIn = sync.account != null
    val syncText = if (syncPending && sync.status != SyncStatus.SYNCING) "Startet…" else syncDetail(sync)
    LaunchedEffect(sync.status) {
        if (sync.status == SyncStatus.SYNCING) syncPending = false
    }

    LaunchedEffect(signedIn) {
        if (!signedIn) return@LaunchedEffect
        try {
            ContextCompat.startForegroundService(context, Intent(context, SyncService::class.java))
        } catch (_: Exception) {
            // Background limits can refuse a foreground service. Sync still runs while the app is open.
        }
    }

    fun requestSync() {
        if (sync.account == null) syncOpen = true
        else {
            syncPending = true
            model.syncNow()
        }
    }

    val focus = desk["focus"] == "on"
    val chromeBackground = ch.fasrv.fanotes.desk.workspaceBackground(desk["background"])
    val compact = ch.fasrv.fanotes.desk.compactChrome(desk["compact"])
    val glass = ch.fasrv.fanotes.desk.glassChrome(desk["glass"])
    Column(
        Modifier
            .fillMaxSize()
            .workspaceBackdrop(
                chromeBackground,
                MaterialTheme.colorScheme.background,
                MaterialTheme.colorScheme.primary,
                MaterialTheme.colorScheme.secondary,
            ),
    ) {
        if (!focus) {
            DeskRibbon(
                destination = destination,
                focus = false,
                onDestination = { model.showDestination(it) },
                onPalette = { model.paletteOpen.value = true },
                onFocus = { model.updateDesk("focus", "on") },
                onDaily = { model.openDaily() },
            )
            NoteTabs(
                tabs,
                open?.path,
                pinned,
                canGoBack(trail),
                canGoForward(trail),
                { model.openPath(it); model.showDestination("notes") },
                { model.closeTab(it) },
                { model.navigateHistory(-1) },
                { model.navigateHistory(1) },
            )
        } else {
            DeskRibbon(destination, true, { model.showDestination(it) }, { model.paletteOpen.value = true }, { model.updateDesk("focus", "off") }, { model.openDaily() })
        }
        Row(Modifier.weight(1f).fillMaxWidth()) {
            if (!focus && (wide || showList) && destination == "notes") {
                VaultPane(
                    modifier = Modifier.width((chrome.sidebarDp ?: ch.fasrv.fanotes.desk.sidebarWidthDp(desk["sidebar-width"])).dp).fillMaxHeight(),
                    tree = filterVaultByTag(tree, tagFilter, tagIndex),
                    tags = collectVaultTags(tagIndex.values.map { noteTags -> noteTags.joinToString(" ") { "#$it" } }),
                    tagFilter = tagFilter,
                    onToggleTag = { model.toggleTagFilter(it) },
                    selected = open?.path,
                    vaultLabel = vaultLabel,
                    syncLabel = syncText,
                    onOpen = { model.openPath(it) },
                    onSync = { requestSync() },
                    onCreateNote = { createParent = model.defaultCreateFolder(); createNote = true },
                    onCreateFolder = { createParent = ""; createFolder = true },
                    onImportPdf = onImportPdf,
                    onImportImage = onImportImage,
                    onOpenVault = onOpenVault,
                    onPrivateVault = { model.usePrivateVault() },
                    onDelete = { path, folder, name -> model.askDelete(path, folder, name) },
                    onRename = { path, name -> renaming = path to name },
                    onMove = { moving = it },
                    localFolders = syncPrefixesFromSetting(desk["sync-excluded"]),
                    onToggleLocal = { model.toggleLocalFolder(it) },
                    colors = model.folderColors.collectAsStateWithLifecycle().value,
                    onFolderColor = { model.cycleFolderColor(it) },
                    compact = compact,
                    rowHeightDp = chrome.rowHeightDp,
                    radiusDp = chrome.radiusDp ?: 10,
                    conflicts = sync.conflicts,
                    onResolve = { conflict, choice -> model.resolveConflict(conflict, choice) },
                )
            }
            if (focus || wide || !showList || destination != "notes") {
                if (destination != "notes") {
                    Box(Modifier.weight(1f).fillMaxHeight()) {
                        when (destination) {
                            "search" -> SearchScreen(model) { model.openPath(it); model.showDestination("notes") }
                            "tasks" -> HomeworkScreen(model)
                            "calendar" -> CalendarScreen(model, { model.openPath(it); model.showDestination("notes") }, onImportIcs, onExportIcs)
                            "overview" -> OverviewScreen(model) { model.openPath(it); model.showDestination("notes") }
                            "cards" -> CardsScreen(model)
                            "books" -> BooksScreen(model) { model.openPath(it); model.showDestination("notes") }
                            "history" -> HistoryScreen(model)
                            "study" -> StudyScreen(model)
                            "ai" -> AiScreen(model)
                            "settings" -> SettingsScreen(model, { requestSync() }, onOpenVault, { model.usePrivateVault() })
                        }
                    }
                } else {
                    val book by model.bookPane.collectAsStateWithLifecycle()
                    val bookPlacement = desk["book-placement"].orEmpty().ifBlank { "rechts" }
                    val showBook = book != null && bookPlacement != "popout"
                    val openBook = { path: String -> model.openPath(path); model.showDestination("notes") }
                    if (showBook && bookPlacement == "links") {
                        BookPane(model, Modifier.width(280.dp).fillMaxHeight(), openBook)
                    }
                    val splitRows = split != null && desk["split-orientation"] == "rows"
                    if (showBook && (bookPlacement == "oben" || bookPlacement == "unten")) {
                        Column(Modifier.weight(1f).fillMaxHeight()) {
                            if (bookPlacement == "oben") BookPane(model, Modifier.height(220.dp).fillMaxWidth(), openBook)
                            NoteWithSplit(
                            splitRows,
                            ch.fasrv.fanotes.desk.splitRatioFromSetting(desk["split-ratio"]),
                            { model.setSplitRatio(it) },
                            model, tool, style, finger, Modifier.weight(1f).fillMaxHeight(),
                        ) {
                                NotePage(
                                    model, tool, style, finger, showText, markdown, backdrop, token, open?.path, syncText,
                                    syncPending || sync.status == SyncStatus.SYNCING, { requestSync() }, { model.showList.value = !showList },
                                    { editingBox = it }, { mathOpen = true }, it.clipToBounds(),
                                    showRelations = !(wide && desk["outline"] != "off" && !focus),
                                    onExportPdf = onExportPdf,
                                    onDownload = onDownload,
                                )
                            }
                            if (bookPlacement == "unten") BookPane(model, Modifier.height(220.dp).fillMaxWidth(), openBook)
                        }
                    } else {
                        NoteWithSplit(
                            splitRows,
                            ch.fasrv.fanotes.desk.splitRatioFromSetting(desk["split-ratio"]),
                            { model.setSplitRatio(it) },
                            model, tool, style, finger, Modifier.weight(1f).fillMaxHeight(),
                        ) {
                            NotePage(
                                model, tool, style, finger, showText, markdown, backdrop, token, open?.path, syncText,
                                syncPending || sync.status == SyncStatus.SYNCING, { requestSync() }, { model.showList.value = !showList },
                                { editingBox = it }, { mathOpen = true }, it.clipToBounds(),
                                showRelations = !(wide && desk["outline"] != "off" && !focus),
                                onExportPdf = onExportPdf,
                                onDownload = onDownload,
                            )
                        }
                    }
                    if (showBook && bookPlacement == "rechts") {
                        BookPane(model, Modifier.width(280.dp).fillMaxHeight(), openBook)
                    }
                }
                if (destination == "notes" && wide && desk["outline"] != "off" && !focus) {
                    Box(Modifier.width(ch.fasrv.fanotes.desk.rightPanelWidthDp(desk["panel-width"]).dp).fillMaxHeight()) { Inspector(model) { model.openPath(it) } }
                }
            }
        }
        DeskStatusBar(
            model.wordCountNow(),
            syncText,
            if (markdown.contains(Regex("[äöüÄÖÜß]"))) "Deutsch" else "DE / EN",
            desk["words"] != "off",
            sync.conflicts.size,
            onConflicts = { model.showDestination("settings") },
            crumbs = if (destination == "notes" && open?.path != null) breadcrumbsFor(open?.path.orEmpty()) else emptyList(),
            onCrumb = { model.showList.value = true },
        )
    }
    if (palette) {
        AlertDialog(onDismissRequest = { model.paletteOpen.value = false }, confirmButton = {}, text = {
            CommandPalette(
                onDismiss = { model.paletteOpen.value = false },
                rankNotes = { model.rankNotes(it) },
                onOpenNote = { model.openPath(it); model.showDestination("notes") },
            ) { id ->
                when (id) {
                    "daily" -> model.openDaily()
                    "split" -> tabs.firstOrNull { it != open?.path }?.let { model.loadSplit(it) }
                    "split-orient" -> model.toggleSplitOrientation()
                    "split-swap" -> model.swapSplit()
                    "note-here" -> {
                        createParent = model.currentFolder()
                        createNote = true
                    }
                    "subfolder" -> {
                        createParent = model.currentFolder()
                        createFolder = true
                    }
                    "focus" -> model.updateDesk("focus", if (desk["focus"] == "on") "off" else "on")
                    "sync" -> requestSync()
                    "bug-report" -> model.openBugReport()
                    "export-pdf" -> onExportPdf()
                    "download-note" -> onDownload()
                    "nav-back" -> model.navigateHistory(-1)
                    "nav-forward" -> model.navigateHistory(1)
                    "reopen-tab" -> model.reopenClosedTab()
                    "pin-tab" -> model.togglePinTab()
                    "close-others" -> model.closeTabs("others")
                    "close-right" -> model.closeTabs("right")
                    "cycle-tab" -> model.cycleTabs(1)
                    else -> if (id.startsWith("template-")) model.createFromTemplate(id.removePrefix("template-")) else model.showDestination(id)
                }
            }
        }, title = { Text("Befehle") })
    }
    val bugReportOpen by model.bugReportOpen.collectAsStateWithLifecycle()
    if (bugReportOpen) BugReportDialog(model)
    val confirm by model.confirmRequest.collectAsStateWithLifecycle()
    confirm?.let { request ->
        FaNotesConfirmDialog(request, onConfirm = { model.acceptConfirm() }, onDismiss = { model.dismissConfirm() }, glass = glass, radiusDp = chrome.radiusDp)
    }
    if (mathOpen) {
        AlertDialog(
            onDismissRequest = { mathOpen = false },
            title = { Text("Mathe") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text("Ausrechnen, Vereinfachen, Ausmultiplizieren, Faktorisieren und Gleichungen bis Grad 2.", fontSize = 13.sp)
                    OutlinedTextField(mathInput, { mathInput = it }, label = { Text("Ausdruck") }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                    listOf(
                        "calculate" to "Ausrechnen",
                        "solve" to "Lösen",
                        "simplify" to "Vereinfachen",
                        "expand" to "Ausmultiplizieren",
                        "factor" to "Faktorisieren",
                    ).forEach { (action, label) ->
                        TextButton(onClick = {
                            runCatching { solveMathExpression(mathInput, action) }
                                .onSuccess { result ->
                                    mathOk = true
                                    mathOutput = result.steps.joinToString("\n") { it.display }
                                }
                                .onFailure { error ->
                                    mathOk = false
                                    mathOutput = error.message ?: "Der Ausdruck ist ungültig."
                                }
                        }) { Text(label) }
                    }
                    if (mathOutput.isNotBlank()) Text(mathOutput, modifier = Modifier.padding(top = 8.dp))
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    if (mathOk) model.insertMath(mathOutput)
                    mathOpen = false
                }, enabled = mathOk) { Text("In die Notiz") }
            },
            dismissButton = { TextButton(onClick = { mathOpen = false }) { Text("Schließen") } },
        )
    }
    editingBox?.let { id ->
        AlertDialog(
            onDismissRequest = { editingBox = null },
            title = { Text("Textfeld") },
            text = { OutlinedTextField(boxText, { boxText = it }, label = { Text("Text") }) },
            confirmButton = {
                TextButton(onClick = { model.updateWorksheetBox(id, boxText); editingBox = null }) { Text("Speichern") }
            },
            dismissButton = { TextButton(onClick = { editingBox = null }) { Text("Abbrechen") } },
        )
    }
    if (firstRun) {
        AlertDialog(
            onDismissRequest = { firstRun = false; model.updateDesk("welcomed", "yes") },
            title = { Text("FaNotes") },
            text = {
                Column {
                    Text("Welches Profil passt? Ordner und Vorlagen sind dieselben wie auf dem Desktop.")
                    listOf("school" to "Schule", "university" to "UNI", "private" to "Privat", "work" to "Arbeit").forEach { (id, label) ->
                        Text(
                            label,
                            modifier = Modifier.fillMaxWidth().clickable { profile = id }.padding(vertical = 6.dp),
                            fontWeight = if (profile == id) FontWeight.Bold else FontWeight.Normal,
                            color = if (profile == id) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    firstRun = false
                    model.applyProfile(profile)
                }) { Text("Einrichten") }
            },
        )
    }
    if (syncOpen) {
        SyncDialog(
            email = sync.account?.email,
            status = syncText,
            error = sync.error ?: message,
            onDismiss = { syncOpen = false },
            onLogin = { email, password, register -> model.login(email, password, register) },
            onLogout = { model.logout() },
            onSync = { model.syncNow() },
        )
    }
    if (createNote) NameDialog(if (createParent.isBlank()) "Neue Notiz" else "Notiz in diesem Ordner", "Vorlesung") { name ->
        createNote = false
        if (name != null) model.createNote(name, createParent)
        createParent = ""
    }
    if (createFolder) NameDialog(if (createParent.isBlank()) "Neuer Ordner" else "Unterordner", "Schule") { name ->
        createFolder = false
        if (name != null) model.createFolder(name, createParent)
        createParent = ""
    }
    renaming?.let { (path, current) ->
        NameDialog("Umbenennen", current, initial = current, confirm = "Umbenennen") { name ->
            renaming = null
            if (name != null && name.trim() != current) model.rename(path, name)
        }
    }
    moving?.let { path ->
        val folders = remember(tree, path) {
            ch.fasrv.fanotes.desk.movableFolderTargets(collectFolders(tree), path)
        }
        val atRoot = !path.contains('/')
        AlertDialog(
            onDismissRequest = { moving = null },
            title = { Text("Verschieben") },
            text = {
                Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                    Text(path.substringAfterLast('/'), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
                    if (!atRoot) {
                        TextButton(onClick = { model.moveEntry(path, ""); moving = null }) { Text("Vault-Wurzel") }
                    }
                    folders.forEach { folder ->
                        TextButton(onClick = { model.moveEntry(path, folder); moving = null }) { Text(folder) }
                    }
                    if (atRoot && folders.isEmpty()) {
                        Text("Es gibt noch keinen anderen Ordner.", fontSize = 13.sp)
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { moving = null }) { Text("Abbrechen") } },
        )
    }
}

private fun collectFolders(nodes: List<VaultNode>): List<String> {
    val found = mutableListOf<String>()
    fun walk(list: List<VaultNode>) {
        for (node in list) {
            if (node.kind != NoteKind.FOLDER) continue
            found += node.path
            walk(node.children)
        }
    }
    walk(nodes)
    return found
}

@Composable
private fun VaultPane(
    modifier: Modifier,
    tree: List<VaultNode>,
    tags: List<String> = emptyList(),
    tagFilter: String? = null,
    onToggleTag: (String) -> Unit = {},
    selected: String?,
    vaultLabel: String,
    syncLabel: String,
    onOpen: (String) -> Unit,
    onSync: () -> Unit,
    onCreateNote: () -> Unit,
    onCreateFolder: () -> Unit,
    onImportPdf: () -> Unit,
    onImportImage: () -> Unit,
    onOpenVault: () -> Unit,
    onPrivateVault: () -> Unit,
    onDelete: (String, Boolean, String) -> Unit,
    onRename: (String, String) -> Unit,
    onMove: (String) -> Unit,
    localFolders: List<String> = emptyList(),
    onToggleLocal: (String) -> Unit = {},
    colors: Map<String, String>,
    onFolderColor: (String) -> Unit,
    conflicts: List<ch.fasrv.fanotes.sync.SyncConflict>,
    onResolve: (ch.fasrv.fanotes.sync.SyncConflict, String) -> Unit,
    compact: Boolean = false,
    rowHeightDp: Int? = null,
    radiusDp: Int = 10,
) {
    Column(modifier.background(MaterialTheme.colorScheme.surface).padding(16.dp)) {
        Text("FaNotes", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Text(vaultLabel, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        Spacer(Modifier.height(12.dp))
        FilledTonalButton(onClick = onSync, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.Filled.Sync, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text("Sync")
        }
        Text(
            syncLabel,
            maxLines = 1,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
            modifier = Modifier.padding(top = 4.dp),
        )
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilledTonalButton(onClick = onCreateNote, modifier = Modifier.weight(1f)) { Text("Notiz") }
            FilledTonalButton(onClick = onCreateFolder, modifier = Modifier.weight(1f)) {
                Icon(Icons.Filled.CreateNewFolder, contentDescription = "New folder")
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
            TextButton(onClick = onImportPdf) { Text("PDF") }
            TextButton(onClick = onImportImage) { Text("Bild") }
        }
        if (conflicts.isNotEmpty()) {
            Text("Konflikte", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
            conflicts.forEach { conflict ->
                Column(Modifier.padding(vertical = 4.dp)) {
                    Text(conflict.path.substringAfterLast('/'), maxLines = 1, fontSize = 13.sp)
                    Row {
                        TextButton(onClick = { onResolve(conflict, "remote") }) { Text("Server") }
                        TextButton(onClick = { onResolve(conflict, "local") }) { Text("Tablet") }
                        if (ch.fasrv.fanotes.desk.isMarkdownConflictPath(conflict.path)) {
                            TextButton(onClick = { onResolve(conflict, "both") }) { Text("Beide") }
                        }
                    }
                }
            }
        }
        if (tags.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                tags.forEach { tag ->
                    val selectedTag = tag == tagFilter
                    Text(
                        "#$tag",
                        fontSize = 12.sp,
                        fontWeight = if (selectedTag) FontWeight.SemiBold else FontWeight.Normal,
                        color = if (selectedTag) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier
                            .padding(end = 4.dp)
                            .background(if (selectedTag) MaterialTheme.colorScheme.primary.copy(alpha = 0.15f) else MaterialTheme.colorScheme.surfaceVariant)
                            .clickable { onToggleTag(tag) }
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                    )
                }
                if (tagFilter != null) {
                    TextButton(onClick = { onToggleTag(tagFilter) }) { Text("Filter aus") }
                }
            }
        }
        LazyColumn(Modifier.weight(1f).padding(top = 8.dp)) {
            items(tree, key = { it.path }) { node ->
                NoteRow(node, selected, colors, onOpen, onDelete, onRename, onMove, onFolderColor, localFolders, onToggleLocal, compact, rowHeightDp, radiusDp, depth = 0)
            }
        }
        TextButton(onClick = onOpenVault) { Text("Vault-Ordner öffnen") }
        TextButton(onClick = onPrivateVault) { Text("Tablet-Vault verwenden") }
    }
}

@Composable
private fun NoteRow(
    node: VaultNode,
    selected: String?,
    colors: Map<String, String>,
    onOpen: (String) -> Unit,
    onDelete: (String, Boolean, String) -> Unit,
    onRename: (String, String) -> Unit,
    onMove: (String) -> Unit,
    onFolderColor: (String) -> Unit,
    localFolders: List<String>,
    onToggleLocal: (String) -> Unit,
    compact: Boolean,
    rowHeightDp: Int?,
    radiusDp: Int,
    depth: Int,
) {
    val folderColor = colors[node.path]
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = (depth * 12).dp)
            .height(ch.fasrv.fanotes.desk.chromeRowHeightDp(compact, rowHeightDp).dp)
            .clip(RoundedCornerShape(radiusDp.dp))
            .background(if (node.path == selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.15f) else Color.Transparent)
            .clickable { if (node.kind == NoteKind.FOLDER) onFolderColor(node.path) else onOpen(node.path) }
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            when (node.kind) {
                NoteKind.FOLDER -> Icons.Filled.Folder
                NoteKind.PDF -> Icons.Filled.PictureAsPdf
                NoteKind.MARKDOWN -> Icons.Filled.Description
            },
            contentDescription = null,
            tint = folderColor?.let { Color(android.graphics.Color.parseColor(it)) } ?: MaterialTheme.colorScheme.primary,
        )
        Text(node.name, modifier = Modifier.weight(1f).padding(start = 8.dp), maxLines = 1)
        if (node.kind == NoteKind.FOLDER) {
            val local = pathIsSyncExcluded(node.path, localFolders)
            Text(
                if (local) "Lokal" else "Nur hier",
                fontSize = 11.sp,
                color = if (local) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
                modifier = Modifier.clickable { onToggleLocal(node.path) }.padding(horizontal = 6.dp),
            )
        }
        IconButton(onClick = { onRename(node.path, node.name) }) {
            Icon(Icons.Filled.Edit, contentDescription = "Umbenennen")
        }
        IconButton(onClick = { onMove(node.path) }) {
            Icon(Icons.AutoMirrored.Filled.DriveFileMove, contentDescription = "Verschieben")
        }
        IconButton(onClick = { onDelete(node.path, node.kind == NoteKind.FOLDER, node.name) }) {
            Icon(Icons.Filled.Delete, contentDescription = "Löschen")
        }
    }
    if (node.kind == NoteKind.FOLDER) {
        node.children.forEach { NoteRow(it, selected, colors, onOpen, onDelete, onRename, onMove, onFolderColor, localFolders, onToggleLocal, compact, rowHeightDp, radiusDp, depth + 1) }
    }
}

@Composable
private fun EditorHeader(
    title: String,
    paper: String,
    style: ch.fasrv.fanotes.ink.StrokeStyle,
    fingerDraws: Boolean,
    showMenu: Boolean,
    onMenu: () -> Unit,
    onPaper: (String) -> Unit,
    onColor: (String) -> Unit,
    onWidth: (Float) -> Unit,
    onBrush: (String) -> Unit,
    onFinger: (Boolean) -> Unit,
    onDeleteSelection: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (showMenu) IconButton(onClick = onMenu) { Icon(Icons.Filled.Menu, contentDescription = "Notizen") }
            Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f), maxLines = 1)
            TextButton(onClick = onDeleteSelection) { Text("Auswahl löschen") }
            TextButton(onClick = { onFinger(!fingerDraws) }) { Text(if (fingerDraws) "Finger zeichnet" else "Finger blättert") }
        }
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            PenColors.forEach { color ->
                Box(
                    Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .background(Color(android.graphics.Color.parseColor(color)))
                        .clickable { onColor(color) },
                )
            }
            Slider(
                value = style.baseWidth.toFloat(),
                onValueChange = onWidth,
                valueRange = 1.2f..14f,
                modifier = Modifier.width(160.dp),
            )
            Brushes.forEach { (id, label) ->
                Text(
                    label,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (id == style.brush) MaterialTheme.colorScheme.primary.copy(alpha = 0.2f) else Color.Transparent)
                        .clickable { onBrush(id) }
                        .padding(horizontal = 6.dp, vertical = 4.dp),
                    style = MaterialTheme.typography.labelMedium,
                )
            }
            Papers.forEach { (id, label) ->
                Text(
                    label,
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (id == paper) MaterialTheme.colorScheme.primary.copy(alpha = 0.2f) else Color.Transparent)
                        .clickable { onPaper(id) }
                        .padding(horizontal = 6.dp, vertical = 4.dp),
                    style = MaterialTheme.typography.labelMedium,
                )
            }
        }
    }
}

@Composable
private fun EditorTools(
    tool: InkTool,
    onTool: (InkTool) -> Unit,
    canUndo: Boolean,
    canRedo: Boolean,
    onUndo: () -> Unit,
    onRedo: () -> Unit,
    onText: () -> Unit,
    textOn: Boolean,
) {
    NavigationBar {
        NavigationBarItem(selected = tool == InkTool.PEN, onClick = { onTool(InkTool.PEN) }, icon = { Icon(Icons.Filled.Edit, contentDescription = "Stift") }, label = { Text("Stift") })
        NavigationBarItem(selected = tool == InkTool.ERASER, onClick = { onTool(InkTool.ERASER) }, icon = { Icon(Icons.Filled.CleaningServices, contentDescription = "Radierer") }, label = { Text("Radierer") })
        NavigationBarItem(selected = tool == InkTool.SELECT, onClick = { onTool(InkTool.SELECT) }, icon = { Icon(Icons.AutoMirrored.Filled.DriveFileMove, contentDescription = "Auswahl") }, label = { Text("Auswahl") })
        NavigationBarItem(selected = false, onClick = onUndo, enabled = canUndo, icon = { Icon(Icons.AutoMirrored.Filled.Undo, contentDescription = "Rückgängig") }, label = { Text("Zurück") })
        NavigationBarItem(selected = false, onClick = onRedo, enabled = canRedo, icon = { Icon(Icons.AutoMirrored.Filled.Redo, contentDescription = "Wiederholen") }, label = { Text("Vor") })
        NavigationBarItem(selected = textOn, onClick = onText, icon = { Icon(Icons.Filled.Description, contentDescription = "Text") }, label = { Text("Text") })
    }
}

@Composable
private fun NoteWithSplit(
    rows: Boolean,
    ratio: Double,
    onRatio: (Double) -> Unit,
    model: FaNotesViewModel,
    tool: InkTool,
    style: ch.fasrv.fanotes.ink.StrokeStyle,
    finger: Boolean,
    modifier: Modifier,
    page: @Composable (Modifier) -> Unit,
) {
    val split = model.splitPath.collectAsStateWithLifecycle().value
    if (split == null) {
        page(modifier)
        return
    }
    var live by remember(ratio) { mutableStateOf(ratio) }
    val ratioNow = remember { object { var value: Double = ratio } }
    ratioNow.value = live
    BoxWithConstraints(modifier) {
        val density = LocalDensity.current
        val totalPx = if (rows) constraints.maxHeight.toDouble() else constraints.maxWidth.toDouble()
        val dividerPx = with(density) { 8.dp.toPx().toDouble() }
        val firstPx = ch.fasrv.fanotes.desk.splitFirstPaneSize(totalPx, dividerPx, live, density.density.toDouble())
        val first = with(density) { firstPx.toFloat().toDp() }
        var box by remember { mutableStateOf(androidx.compose.ui.unit.IntSize.Zero) }
        val positioned = Modifier.fillMaxSize().onGloballyPositioned { box = it.size }
        if (rows) {
            Column(positioned) {
                page(Modifier.height(first).fillMaxWidth())
                SplitDivider(true, box, live, { ratioNow.value = it; live = it }, { onRatio(ratioNow.value) }, { ratioNow.value = 0.5; live = 0.5; onRatio(0.5) })
                SplitPane(model, tool, style, finger, Modifier.weight(1f).fillMaxWidth())
            }
        } else {
            Row(positioned) {
                page(Modifier.width(first).fillMaxHeight())
                SplitDivider(false, box, live, { ratioNow.value = it; live = it }, { onRatio(ratioNow.value) }, { ratioNow.value = 0.5; live = 0.5; onRatio(0.5) })
                SplitPane(model, tool, style, finger, Modifier.weight(1f).fillMaxHeight())
            }
        }
    }
}

@Composable
private fun SplitDivider(
    rows: Boolean,
    box: androidx.compose.ui.unit.IntSize,
    ratio: Double,
    onLive: (Double) -> Unit,
    onCommit: () -> Unit,
    onReset: () -> Unit,
) {
    val liveChange = androidx.compose.runtime.rememberUpdatedState(onLive)
    val commitChange = androidx.compose.runtime.rememberUpdatedState(onCommit)
    val resetChange = androidx.compose.runtime.rememberUpdatedState(onReset)
    val ratioNow = androidx.compose.runtime.rememberUpdatedState(ratio)
    val boxState = androidx.compose.runtime.rememberUpdatedState(box)
    Box(
        Modifier
            .then(if (rows) Modifier.fillMaxWidth().height(8.dp) else Modifier.fillMaxHeight().width(8.dp))
            .background(MaterialTheme.colorScheme.outline.copy(alpha = 0.45f))
            .pointerInput(rows) {
                detectTapGestures(onDoubleTap = { resetChange.value() })
            }
            .pointerInput(rows) {
                var current = 0.5
                detectDragGestures(
                    onDragStart = { current = ratioNow.value },
                    onDragEnd = { commitChange.value() },
                    onDrag = { change, drag ->
                        val size = boxState.value
                        val total = (if (rows) size.height else size.width).coerceAtLeast(1)
                        val delta = if (rows) drag.y else drag.x
                        current = ch.fasrv.fanotes.desk.clampSplitRatio(current + delta / total.toDouble())
                        liveChange.value(current)
                        change.consume()
                    },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .then(if (rows) Modifier.width(28.dp).height(3.dp) else Modifier.width(3.dp).height(28.dp))
                .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)),
        )
    }
}

@Composable
private fun SplitPane(
    model: FaNotesViewModel,
    tool: InkTool,
    style: ch.fasrv.fanotes.ink.StrokeStyle,
    finger: Boolean,
    modifier: Modifier,
) {
    val path = model.splitPath.collectAsStateWithLifecycle().value
    val markdown = model.splitMarkdown.collectAsStateWithLifecycle().value
    val title = path?.let { ch.fasrv.fanotes.vault.titleOf(it) }.orEmpty()
    var typing by remember(path) { mutableStateOf(false) }
    Column(modifier) {
        Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title.ifBlank { "Zweite Spalte" }, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 1)
            TextButton(onClick = { typing = !typing }) { Text(if (typing) "Stift" else "Text") }
            TextButton(onClick = { model.swapSplit() }) { Text("Tauschen") }
            TextButton(onClick = { model.toggleSplitOrientation() }) { Text("Drehen") }
            TextButton(onClick = { model.promoteSplit() }) { Text("Einzeln") }
            TextButton(onClick = { model.closeSplit() }) { Text("Schließen") }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { context ->
                InkSurfaceView(context).apply {
                    session = model.splitSession
                    showMarkdown = true
                    onChanged = { model.splitChanged() }
                }
            },
            update = { view ->
                view.session = model.splitSession
                val metrics = ch.fasrv.fanotes.desk.editorMetrics(model.effectiveDesk())
                view.editorFontPx = metrics.fontSizePx.toFloat()
                view.editorLineHeight = metrics.lineHeight.toFloat()
                view.contentWidthPx = metrics.contentWidthPx.toFloat()
                view.readableLineLength = metrics.readableLineLength
                view.setEditorFont(metrics.editorFontId)
                view.applyWorkspaceKind(model.effectiveDesk()["background"].orEmpty())
                view.showLineNumbers = metrics.showLineNumbers
                view.accentSecondary = android.graphics.Color.parseColor(ch.fasrv.fanotes.desk.normalizeAccentSecondary(model.effectiveDesk()["accent-secondary"]))
                view.zoomMax = metrics.zoomMax.toFloat()
                view.zoomSpeed = metrics.zoomSpeed
                val pen = ch.fasrv.fanotes.desk.penSettings(model.effectiveDesk())
                view.shapeSnapSensitivity = pen.shapeSnap
                view.scribbleSensitivity = pen.scribble
                view.strokeSmoothing = pen.smoothing.toFloat()
                view.tabletButtons = model.effectiveDesk()["tablet-buttons"].orEmpty()
                view.penOnly = ch.fasrv.fanotes.input.penOnlyEnabled(model.effectiveDesk()["pen-only"])
                view.markdown = markdown
                view.showMarkdown = markdown.isNotBlank() && !typing
                view.inkTool = tool
                view.style = style
                view.fingerDraws = finger
                view.onChanged = { model.splitChanged() }
                view.onCamera = camera@{ _, _, _ ->
                    val current = path ?: return@camera
                    val sample = view.cameraSample() ?: return@camera
                    model.rememberPaperCamera(
                        current,
                        sample.zoom,
                        sample.rotation,
                        sample.centreX,
                        sample.centreY,
                        sample.pageWidth,
                        sample.pageHeight,
                        null,
                    )
                }
                if (view.tag != path) {
                    view.tag = path
                    val entry = path?.let { model.recallPaperCamera(it) }
                    if (entry != null) {
                        view.restoreCamera(
                            entry.zoom,
                            entry.rotation,
                            entry.centreX,
                            entry.centreY,
                            entry.pageWidth,
                            path.endsWith(".pdf", ignoreCase = true),
                        )
                    }
                }
            },
        )
        if (typing) {
            BasicTextField(
                value = markdown,
                onValueChange = { model.updateSplitMarkdown(it) },
                modifier = Modifier.fillMaxSize().background(Color(0xFFF7F6F3)).padding(16.dp),
                textStyle = TextStyle(color = Color(0xFF252630), fontSize = 16.sp, lineHeight = 24.sp),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            )
        }
        }
    }
}

@Composable
private fun NotePage(
    model: FaNotesViewModel,
    tool: InkTool,
    style: ch.fasrv.fanotes.ink.StrokeStyle,
    finger: Boolean,
    textMode: Boolean,
    markdown: String,
    backdrop: List<BackdropSlice>,
    token: Int,
    path: String?,
    syncText: String,
    syncBusy: Boolean,
    onSync: () -> Unit,
    onToggleRail: () -> Unit,
    onEditBox: (String) -> Unit,
    onMath: () -> Unit,
    modifier: Modifier,
    showRelations: Boolean = true,
    onExportPdf: () -> Unit = {},
    onDownload: () -> Unit = {},
) {
    val noteKind = model.open.collectAsStateWithLifecycle().value?.kind
    Column(modifier) {
        if (path != null) {
            Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onExportPdf) { Text("Als PDF exportieren") }
                TextButton(onClick = onDownload) { Text("Herunterladen") }
            }
            NoteTagBar(model)
            MarginTranscript(model)
            if (noteKind == NoteKind.PDF) PdfQuoteMarks(model)
            if (showRelations) NoteRelations(model) { model.openPath(it); model.showDestination("notes") }
        }
        PageSurface(
        model = model,
        tool = tool,
        style = style,
        finger = finger,
        textMode = textMode,
        markdown = markdown,
        backdrop = backdrop,
        token = token,
        path = path,
        paper = model.session.document.paperStyle,
        syncText = syncText,
        syncBusy = syncBusy,
        dark = ch.fasrv.fanotes.desk.themePalette(model.effectiveDesk()["theme"], isSystemInDarkTheme()).dark,
        onSync = onSync,
        onToggleRail = onToggleRail,
        onEditBox = onEditBox,
        onMath = onMath,
        modifier = Modifier.weight(1f).fillMaxWidth(),
    )
    }
}

@Composable
private fun PageSurface(
    model: FaNotesViewModel,
    tool: InkTool,
    style: ch.fasrv.fanotes.ink.StrokeStyle,
    finger: Boolean,
    textMode: Boolean,
    markdown: String,
    backdrop: List<BackdropSlice>,
    token: Int,
    path: String?,
    paper: String,
    syncText: String,
    syncBusy: Boolean,
    dark: Boolean,
    onSync: () -> Unit,
    onToggleRail: () -> Unit,
    onEditBox: (String) -> Unit,
    onMath: () -> Unit,
    modifier: Modifier,
) {
    var bound by remember { mutableStateOf("") }
    val links by model.noteLinks.collectAsStateWithLifecycle()
    val boxes by model.worksheetBoxes.collectAsStateWithLifecycle()
    val highlights by model.worksheetHighlights.collectAsStateWithLifecycle()
    val outlineJump by model.outlineJump.collectAsStateWithLifecycle()
    val foldedHeadings by model.foldedHeadings.collectAsStateWithLifecycle()
    AndroidView(
        modifier = modifier,
        factory = { context ->
            NotePageView(context).apply {
                attachSession(model.session)
                ink.onChanged = { model.noteChanged() }
                ink.onStroke = { model.recordFinishedStroke(it) }
                ink.onErased = { model.recordErasedStrokes(it) }
                ink.onPageGrew = { prevWidth, prevHeight, nextWidth, nextHeight, padX, padY ->
                    model.pageGrew(prevWidth, prevHeight, nextWidth, nextHeight, padX, padY)
                }
                ink.onPenSample = { x, y -> model.recordPenSample(x, y) }
                ink.onSwipeNote = { model.swipe(it) }
            }
        },
        update = { page ->
            page.attachSession(model.session)
            page.ink.onChanged = { model.noteChanged() }
            page.ink.onStroke = { model.recordFinishedStroke(it) }
            page.ink.onErased = { model.recordErasedStrokes(it) }
            page.ink.onPageGrew = { prevWidth, prevHeight, nextWidth, nextHeight, padX, padY ->
                model.pageGrew(prevWidth, prevHeight, nextWidth, nextHeight, padX, padY)
            }
            page.ink.onPenSample = { x, y -> model.recordPenSample(x, y) }
            page.ink.onSwipeNote = { model.swipe(it) }
            if (page.ink.backdrop !== backdrop) page.ink.backdrop = backdrop
            page.onTool = {
                model.tool.value = it
                model.recordBugTool(it.name)
            }
            page.onSync = onSync
            page.onMarkdown = { model.updateMarkdown(it) }
            page.onVisibleMarkdown = { previous, next -> model.updateVisibleMarkdown(previous, next) }
            page.onRememberCamera = { path, zoom, rotation, centreX, centreY, pageWidth, pageHeight, anchor ->
                model.rememberPaperCamera(path, zoom, rotation, centreX, centreY, pageWidth, pageHeight, anchor)
            }
            page.onRecallCamera = { model.recallPaperCamera(it) }
            page.onUndo = { model.undo() }
            page.onRedo = { model.redo() }
            page.onColor = { model.style.value = style.copy(color = it) }
            page.onWidth = { model.style.value = style.copy(baseWidth = it.toDouble()) }
            page.onPaper = { model.setPaper(it) }
            page.onBrush = { model.style.value = style.copy(brush = it) }
            page.onEffect = {
                model.style.value = style.copy(colorEffect = it)
                model.updateDesk("ink-effect", it)
            }
            page.onToggleRail = onToggleRail
            page.onTextMode = { model.showText.value = it }
            page.onDeleteSelection = { model.deleteSelection() }
            page.onDuplicate = { model.duplicateSelection() }
            page.onClear = { model.clearInk() }
            page.ink.onPlaceSection = { model.insertSection(it) }
            page.ink.onPlaceLink = { linkPage, x, y -> model.placeNoteLink(linkPage, x, y, page.ink.noteLinkStyle) }
            page.ink.onOpenLink = { model.openPath(it); model.showDestination("notes") }
            page.ink.onRemoveLink = { model.askRemoveNoteLink(it) }
            page.onRestyleLink = { id, linkStyle -> model.restylePlacedNoteLink(id, linkStyle) }
            page.ink.onToggleSection = { model.toggleInkSection(it) }
            page.ink.onEditBox = onEditBox
            page.onMath = onMath
            page.ink.linkMarks = links
            page.ink.worksheetBoxes = boxes
            page.ink.worksheetHighlights = highlights
            page.ink.pageFrames = backdrop.mapIndexed { index, slice ->
                ch.fasrv.fanotes.desk.PageFrame(index + 1, slice.topPagePx.toDouble(), slice.heightPagePx.toDouble(), slice.widthPagePx.toDouble())
            }
            val pen = ch.fasrv.fanotes.desk.penSettings(model.effectiveDesk())
            page.ink.accentColor = android.graphics.Color.parseColor(ch.fasrv.fanotes.desk.normalizeAccent(model.effectiveDesk()["accent"]))
            page.ink.shapeSnapSensitivity = pen.shapeSnap
            page.ink.scribbleSensitivity = pen.scribble
            page.ink.strokeSmoothing = pen.smoothing.toFloat()
            page.ink.tabletButtons = model.effectiveDesk()["tablet-buttons"].orEmpty()
            page.ink.penOnly = ch.fasrv.fanotes.input.penOnlyEnabled(model.effectiveDesk()["pen-only"])
            page.ink.accentSecondary = android.graphics.Color.parseColor(ch.fasrv.fanotes.desk.normalizeAccentSecondary(model.effectiveDesk()["accent-secondary"]))
            page.setWorkspace(model.effectiveDesk()["background"].orEmpty())
            page.ink.onPlaceHighlight = { model.addWorksheetHighlight(it) }
            page.ink.onRemoveHighlight = { model.removeWorksheetHighlight(it) }
            page.onFinger = { model.fingerDraws.value = it }
            page.apply(
                path = path ?: "",
                markdown = markdown,
                tool = tool,
                style = style,
                paper = paper,
                fingerDraws = finger,
                text = textMode,
                syncLabel = syncText,
                syncBusy = syncBusy,
                canUndo = model.session.canUndo,
                canRedo = model.session.canRedo,
                darkChrome = dark,
                folded = foldedHeadings,
                metrics = ch.fasrv.fanotes.desk.editorMetrics(model.effectiveDesk()),
            )
            val jump = outlineJump
            if (jump != null) {
                page.revealLine(jump)
                model.consumeOutlineJump()
            }
            val current = path ?: ""
            if (bound != current) {
                page.rememberCamera(bound)
                bound = current
                page.ink.tag = token
                page.ink.reload()
                page.restoreCamera(current, model.open.value?.kind == NoteKind.PDF)
            } else if (page.ink.tag != token) {
                page.ink.tag = token
                page.ink.refresh()
            }
            model.takeReveal(current)?.let { page.ink.revealY(it) }
        },
    )
}

private fun syncDetail(state: ch.fasrv.fanotes.sync.SyncPublicState): String {
    if (state.status == SyncStatus.SYNCING) {
        val progress = state.progress
        if (progress != null && progress.total > 0) {
            val verb = when (progress.phase) {
                "pull" -> "Laden"
                "push" -> "Senden"
                else -> "Prüfen"
            }
            return "$verb ${progress.done}/${progress.total}"
        }
        return "Synchronisiert…"
    }
    return when (state.status) {
        SyncStatus.IDLE -> "Synchron"
        SyncStatus.OFFLINE -> "Offline"
        SyncStatus.ERROR -> state.error?.take(42) ?: "Sync-Fehler"
        SyncStatus.SIGNED_OUT -> "Anmelden"
        SyncStatus.PAUSED -> "Pausiert"
        else -> "Sync"
    }
}

@Composable
private fun InkCanvas(
    model: FaNotesViewModel,
    tool: InkTool,
    style: ch.fasrv.fanotes.ink.StrokeStyle,
    finger: Boolean,
    backdrop: List<BackdropSlice>,
    token: Int,
    path: String?,
    modifier: Modifier,
) {
    var bound by remember { mutableStateOf("") }
    AndroidView(
        modifier = modifier,
        factory = { context ->
            InkSurfaceView(context).apply {
                session = model.session
                onChanged = { model.noteChanged() }
                onStroke = { model.recordFinishedStroke(it) }
                onErased = { model.recordErasedStrokes(it) }
                onSwipeNote = { model.swipe(it) }
            }
        },
        update = { view ->
            view.session = model.session
            view.inkTool = tool
            view.style = style
            view.fingerDraws = finger
            if (view.backdrop !== backdrop) view.backdrop = backdrop
            view.onChanged = { model.noteChanged() }
            view.onStroke = { model.recordFinishedStroke(it) }
            view.onErased = { model.recordErasedStrokes(it) }
            view.onSwipeNote = { model.swipe(it) }
            val current = path ?: ""
            if (bound != current) {
                bound = current
                view.tag = token
                view.reload()
            } else if (view.tag != token) {
                view.tag = token
                view.refresh()
            }
        },
    )
}

@Composable
private fun MarkdownPanel(text: String, onChange: (String) -> Unit, modifier: Modifier) {
    Surface(modifier, color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
        Column(Modifier.padding(16.dp)) {
            Text("Markdown", style = MaterialTheme.typography.titleMedium)
            Text("Getippter Text liegt in der Notiz. Die Tinte bleibt in der .famd-Datei.", style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(8.dp))
            BasicTextField(
                value = text,
                onValueChange = onChange,
                modifier = Modifier.fillMaxSize(),
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            )
        }
    }
}

@Composable
private fun SyncDialog(
    email: String?,
    status: String,
    error: String?,
    onDismiss: () -> Unit,
    onLogin: (String, String, Boolean) -> Unit,
    onLogout: () -> Unit,
    onSync: () -> Unit,
) {
    var address by remember { mutableStateOf(email ?: "") }
    var password by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Sync") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(status)
                Text("Notizen werden auf diesem Tablet verschlüsselt, bevor sie das Gerät verlassen. Ein vergessenes Passwort kann nicht wiederhergestellt werden.")
                if (error != null) Text(error, color = MaterialTheme.colorScheme.error)
                if (email == null) {
                    OutlinedTextField(address, { address = it }, label = { Text("Email") }, singleLine = true)
                    OutlinedTextField(password, { password = it }, label = { Text("Password") }, singleLine = true)
                } else {
                    Text(email)
                }
            }
        },
        confirmButton = {
            if (email == null) {
                Button(onClick = { onLogin(address, password, false) }) { Text("Anmelden") }
            } else {
                Button(onClick = onSync) { Text("Jetzt synchronisieren") }
            }
        },
        dismissButton = {
            if (email == null) {
                TextButton(onClick = { onLogin(address, password, true) }) { Text("Konto erstellen") }
            } else {
                TextButton(onClick = onLogout) { Text("Abmelden") }
            }
        },
    )
}

@Composable
private fun NameDialog(
    title: String,
    placeholder: String,
    initial: String = "",
    confirm: String = "Erstellen",
    onDone: (String?) -> Unit,
) {
    var name by remember(initial) { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = { onDone(null) },
        title = { Text(title) },
        text = { OutlinedTextField(name, { name = it }, placeholder = { Text(placeholder) }, singleLine = true) },
        confirmButton = { Button(onClick = { onDone(name) }, enabled = name.isNotBlank()) { Text(confirm) } },
        dismissButton = { TextButton(onClick = { onDone(null) }) { Text("Abbrechen") } },
    )
}

