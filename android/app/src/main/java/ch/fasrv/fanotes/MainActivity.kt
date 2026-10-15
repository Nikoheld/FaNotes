package ch.fasrv.fanotes

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
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
import androidx.compose.foundation.focusable
import androidx.compose.foundation.border
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
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
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
import ch.fasrv.fanotes.sync.localFolderAction
import ch.fasrv.fanotes.sync.pathIsSyncExcluded
import ch.fasrv.fanotes.sync.syncPrefixesFromSetting
import ch.fasrv.fanotes.desk.collectVaultTags
import ch.fasrv.fanotes.desk.filterVaultByTag
import ch.fasrv.fanotes.desk.TreeBox
import ch.fasrv.fanotes.desk.TreeRowBox
import ch.fasrv.fanotes.desk.breadcrumbsFor
import ch.fasrv.fanotes.desk.resolveTreeDrop
import ch.fasrv.fanotes.desk.canGoBack
import ch.fasrv.fanotes.desk.canGoForward
import ch.fasrv.fanotes.ink.InkTool
import ch.fasrv.fanotes.sync.SyncStatus
import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.VaultNode
import kotlin.math.abs
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull

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
    private var bookImportFolder: String? = null
    private var pdfNoteFolder: String? = null
    private val importPdf = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val bookFolder = bookImportFolder
        val noteFolder = pdfNoteFolder
        bookImportFolder = null
        pdfNoteFolder = null
        if (bookFolder != null) importBook(uri, bookFolder) else importPdfNote(uri, noteFolder)
    }
    private val importImage = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        import(uri, pdf = false)
    }
    private var sheetIntoCurrent = true
    private val importSheet = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@registerForActivityResult
        val name = uri.lastPathSegment?.substringAfterLast('/')?.ifBlank { null } ?: "Arbeitsblatt"
        val mime = contentResolver.getType(uri).orEmpty()
        val bytes = model.readUri(uri) ?: return@registerForActivityResult
        model.importWorksheetFile(name, bytes, mime, sheetIntoCurrent)
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
            var sheetDialog by remember { mutableStateOf(false) }
            val openForSheet by model.open.collectAsStateWithLifecycle()
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
                    onImportPdf = {
                        bookImportFolder = null
                        pdfNoteFolder = null
                        importPdf.launch(arrayOf("application/pdf"))
                    },
                    onImportPdfIn = { folder ->
                        bookImportFolder = null
                        pdfNoteFolder = folder
                        importPdf.launch(arrayOf("application/pdf"))
                    },
                    onImportBook = { folder ->
                        pdfNoteFolder = null
                        bookImportFolder = folder
                        importPdf.launch(arrayOf("application/pdf"))
                    },
                    onImportImage = { importImage.launch(arrayOf("image/*")) },
                    onImportIcs = { importIcs.launch(arrayOf("text/calendar", "text/plain", "*/*")) },
                    onExportIcs = { exportIcs.launch("fanotes.ics") },
                    onExportPdf = { exportNotePdf.launch(ch.fasrv.fanotes.desk.PDF_EXPORT_FILE_NAME) },
                    onImportSheet = { sheetDialog = true },
                    worksheetImport = sheetDialog,
                    onDismissWorksheet = { sheetDialog = false },
                    onDownload = {
                        val path = model.open.value?.path.orEmpty()
                        if (!ch.fasrv.fanotes.desk.noteCanDownload(path)) model.refuseNoteDownload()
                        else {
                            pendingDownload = path
                            downloadNote.launch(ch.fasrv.fanotes.desk.noteDownloadFileName(path))
                        }
                    },
                )
                if (sheetDialog) {
                    WorksheetImportDialog(
                        noteTitle = openForSheet?.title,
                        onCurrent = {
                            sheetDialog = false
                            sheetIntoCurrent = true
                            importSheet.launch(arrayOf("application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"))
                        },
                        onNew = {
                            sheetDialog = false
                            sheetIntoCurrent = false
                            importSheet.launch(arrayOf("application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"))
                        },
                        onDismiss = { sheetDialog = false },
                    )
                }
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

    private fun importPdfNote(uri: Uri?, folder: String?) {
        if (uri == null) return
        val name = uri.lastPathSegment?.substringAfterLast('/')?.ifBlank { null } ?: "PDF-Notiz.pdf"
        val bytes = model.readUri(uri) ?: return
        model.importPdfNote(folder, name, bytes)
    }

    private fun importBook(uri: Uri?, folder: String) {
        if (uri == null) return
        val name = uri.lastPathSegment?.substringAfterLast('/')?.ifBlank { null } ?: "Buch.pdf"
        val bytes = model.readUri(uri) ?: return
        model.importSubjectBook(folder, name, bytes)
    }

    private fun import(uri: Uri?, pdf: Boolean) {
        if (uri == null) return
        val name = uri.lastPathSegment?.substringAfterLast('/') ?: if (pdf) "Document.pdf" else "Image.jpg"
        val bytes = model.readUri(uri) ?: return
        model.importBytes(name, bytes, pdf, contentResolver.getType(uri).orEmpty())
    }
}

private fun VaultNode.toTreeKey(): ch.fasrv.fanotes.desk.TreeKeyNode =
    ch.fasrv.fanotes.desk.TreeKeyNode(path, kind == NoteKind.FOLDER, children.map { it.toTreeKey() })

private fun findVaultNode(nodes: List<VaultNode>, path: String): VaultNode? {
    for (node in nodes) {
        if (node.path == path) return node
        if (node.kind == NoteKind.FOLDER) findVaultNode(node.children, path)?.let { return it }
    }
    return null
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
    onImportPdfIn: (String) -> Unit = {},
    onImportBook: (String) -> Unit = {},
    onImportImage: () -> Unit,
    onImportIcs: () -> Unit,
    onExportIcs: () -> Unit,
    onExportPdf: () -> Unit,
    onImportSheet: () -> Unit,
    onDownload: () -> Unit,
    worksheetImport: Boolean = false,
    onDismissWorksheet: () -> Unit = {},
) {
    val tree by model.tree.collectAsStateWithLifecycle()
    val open by model.open.collectAsStateWithLifecycle()
    val tool by model.tool.collectAsStateWithLifecycle()
    val style by model.style.collectAsStateWithLifecycle()
    val finger by model.fingerDraws.collectAsStateWithLifecycle()
    val showText by model.showText.collectAsStateWithLifecycle()
    val showList by model.showList.collectAsStateWithLifecycle()
    val sidebarOpen by model.sidebarOpen.collectAsStateWithLifecycle()
    val inspectorOpen by model.inspectorOpen.collectAsStateWithLifecycle()
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
    val unsaved by model.unsaved.collectAsStateWithLifecycle()
    val splitUnsaved by model.splitUnsaved.collectAsStateWithLifecycle()
    val palette by model.paletteOpen.collectAsStateWithLifecycle()
    val paletteNotes by model.paletteNotes.collectAsStateWithLifecycle()
    val bugReportOpen by model.bugReportOpen.collectAsStateWithLifecycle()
    val confirm by model.confirmRequest.collectAsStateWithLifecycle()
    val linkPlacing by model.linkPlacing.collectAsStateWithLifecycle()
    val placingSection by model.placingSection.collectAsStateWithLifecycle()
    val linkSelected by model.linkSelected.collectAsStateWithLifecycle()
    val gotoLine by model.gotoLineInput.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var firstRun by remember { mutableStateOf(desk["welcomed"] != "yes") }
    var firstDraft by remember { mutableStateOf(ch.fasrv.fanotes.desk.firstRunStart()) }
    var editingBox by remember { mutableStateOf<String?>(null) }
    var boxText by remember { mutableStateOf("") }
    val editWorksheetBox = { id: String ->
        boxText = model.worksheetBoxes.value.firstOrNull { it.box.id == id }?.box?.text.orEmpty()
        editingBox = id
    }
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

    fun runDeskShortcut(id: String) {
        when (id) {
            "tab-next" -> model.cycleTabs(1)
            "tab-prev" -> model.cycleTabs(-1)
            "back" -> model.navigateHistory(-1)
            "forward" -> model.navigateHistory(1)
            "reopen-tab" -> model.reopenClosedTab()
            "quick-open" -> model.showPalette(notes = true)
            "palette" -> model.showPalette(notes = false)
            "split" -> model.toggleSplit()
            "split-swap" -> model.swapSplit()
            "close-tab" -> model.closeCurrentTab()
            "save" -> model.saveFromShortcut()
            "vault-search" -> model.showDestination("search")
            "ai" -> model.showDestination("ai")
            "worksheet" -> onImportSheet()
            "new-note" -> {
                createParent = model.defaultCreateFolder()
                createNote = true
            }
            "settings" -> model.showDestination("settings")
            "focus" -> model.toggleFocusMode()
            "pen" -> model.togglePen()
            else -> if (id.startsWith("tab-")) id.removePrefix("tab-").toIntOrNull()?.let(model::openTabByDigit)
        }
    }
    val focus = desk["focus"] == "on"
    val chromeBackground = ch.fasrv.fanotes.desk.workspaceBackground(desk["background"])
    val compact = ch.fasrv.fanotes.desk.compactChrome(desk["compact"])
    val glass = ch.fasrv.fanotes.desk.glassChrome(desk["glass"])
    Column(
        Modifier
            .fillMaxSize()
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                if (event.key == Key.Escape && !event.isCtrlPressed && !event.isAltPressed && !event.isMetaPressed) {
                    val target = ch.fasrv.fanotes.desk.escapeDismisses(
                        ch.fasrv.fanotes.desk.EscapeLayer(
                            confirm = confirm != null,
                            bugReport = bugReportOpen,
                            gotoLine = gotoLine != null,
                            math = mathOpen,
                            textBox = editingBox != null,
                            firstRun = firstRun,
                            sync = syncOpen,
                            createNote = createNote,
                            createFolder = createFolder,
                            renaming = renaming != null,
                            moving = moving != null,
                            placingLink = linkPlacing,
                            placingSection = placingSection,
                            selectedLink = linkSelected,
                            worksheetImport = worksheetImport,
                            palette = palette,
                            destination = destination,
                            selection = model.session.selection.isNotEmpty(),
                            pen = !showText,
                            focus = focus,
                        ),
                    ) ?: return@onPreviewKeyEvent false
                    when (target) {
                        "confirm" -> model.dismissConfirm()
                        "bug-report" -> model.closeBugReport()
                        "goto-line" -> model.closeGotoLine()
                        "math" -> mathOpen = false
                        "text-box" -> editingBox = null
                        "first-run" -> {
                            firstRun = false
                            model.updateDesk("welcomed", "yes")
                        }
                        "sync" -> syncOpen = false
                        "create-note" -> {
                            createNote = false
                            createParent = ""
                        }
                        "create-folder" -> {
                            createFolder = false
                            createParent = ""
                        }
                        "rename" -> renaming = null
                        "move" -> moving = null
                        "placing-link", "selected-link" -> model.requestClearLink()
                        "placing-section" -> model.setPlacingSection(false)
                        "worksheet" -> onDismissWorksheet()
                        "palette" -> model.paletteOpen.value = false
                        "search", "settings", "ai", "calendar", "tasks", "overview" -> model.showDestination("notes")
                        "selection" -> {
                            model.session.clearSelection()
                            model.message.value = ch.fasrv.fanotes.ink.SELECT_CLEARED_NOTICE
                        }
                        "pen" -> model.showText.value = true
                        "focus" -> model.updateDesk("focus", "off")
                    }
                    return@onPreviewKeyEvent true
                }
                val name = when (event.key) {
                    Key.Tab -> "tab"
                    Key.DirectionLeft -> "left"
                    Key.DirectionRight -> "right"
                    Key.T -> "t"
                    Key.O -> "o"
                    Key.Backslash -> "\\"
                    Key.W -> "w"
                    Key.S -> "s"
                    Key.P -> "p"
                    Key.F -> "f"
                    Key.A -> "a"
                    Key.I -> "i"
                    Key.N -> "n"
                    Key.Comma -> ","
                    Key.E -> "e"
                    Key.D -> "d"
                    Key.One -> "1"
                    Key.Two -> "2"
                    Key.Three -> "3"
                    Key.Four -> "4"
                    Key.Five -> "5"
                    Key.Six -> "6"
                    Key.Seven -> "7"
                    Key.Eight -> "8"
                    Key.Nine -> "9"
                    else -> return@onPreviewKeyEvent false
                }
                val command = ch.fasrv.fanotes.desk.deskShortcut(
                    event.isCtrlPressed,
                    event.isShiftPressed,
                    event.isAltPressed,
                    event.isMetaPressed,
                    name,
                ) ?: return@onPreviewKeyEvent false
                runDeskShortcut(command)
                true
            }
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
                onPalette = { model.showPalette(notes = false) },
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
                { model.openInSplit(it) },
                split,
                buildSet {
                    val active = open?.path
                    val right = split
                    tabs.forEach { path ->
                        if (ch.fasrv.fanotes.desk.tabShowsUnsaved(path, active, right, unsaved, splitUnsaved)) add(path)
                    }
                },
                { from, to, side -> model.moveOpenTab(from, to, side) },
                { model.togglePinTab(it) },
                { anchor, scope -> model.closeTabs(scope, anchor) },
                { path ->
                    val copied = runCatching {
                        context.getSystemService(ClipboardManager::class.java)
                            .setPrimaryClip(ClipData.newPlainText("Pfad", path))
                    }.isSuccess
                    model.message.value = if (copied) "Pfad kopiert." else "Der Pfad konnte nicht kopiert werden."
                },
                { path ->
                    if (!model.selectedFolderVault()) {
                        model.message.value = "Diese Notiz liegt im Tablet-Vault und hat keinen Ordner im Dateimanager."
                    } else {
                        val uri = model.revealInFolder(path)
                        if (uri == null) {
                            model.message.value = "Der Eintrag wurde nicht gefunden."
                        } else {
                            val intent = Intent(Intent.ACTION_VIEW).setData(uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            runCatching { context.startActivity(intent) }.onFailure {
                                model.message.value = "Der Dateimanager konnte den Eintrag nicht öffnen."
                            }
                        }
                    }
                },
            )
        } else {
            DeskRibbon(destination, true, { model.showDestination(it) }, { model.showPalette(notes = false) }, { model.updateDesk("focus", "off") }, { model.openDaily() })
        }
        val panels = ch.fasrv.fanotes.desk.noteWorkspacePanels(
            focus = focus,
            wide = wide,
            showList = showList,
            sidebarOpen = sidebarOpen,
            inspectorOpen = inspectorOpen,
            outlineEnabled = desk["outline"] != "off",
            notes = destination == "notes",
        )
        Row(Modifier.weight(1f).fillMaxWidth()) {
            if (panels.sidebar) {
                VaultPane(
                    modifier = Modifier.width((chrome.sidebarDp ?: ch.fasrv.fanotes.desk.sidebarWidthDp(desk["sidebar-width"])).dp).fillMaxHeight(),
                    tree = filterVaultByTag(tree, tagFilter, tagIndex),
                    tags = collectVaultTags(tagIndex.values.map { noteTags -> noteTags.joinToString(" ") { "#$it" } }),
                    tagFilter = tagFilter,
                    onToggleTag = { model.toggleTagFilter(it) },
                    selected = open?.path,
                    splitPath = split,
                    vaultLabel = vaultLabel,
                    syncLabel = syncText,
                    onOpen = { model.openPath(it) },
                    onSync = { requestSync() },
                    onCreateNote = { createParent = model.defaultCreateFolder(); createNote = true },
                    onCreateFolder = { createParent = ""; createFolder = true },
                    onImportPdf = onImportPdf,
                    onImportImage = onImportImage,
                    onImportSheet = onImportSheet,
                    onOpenVault = onOpenVault,
                    onPrivateVault = { model.usePrivateVault() },
                    onDelete = { path, folder, name -> model.askDelete(path, folder, name) },
                    onRename = { path, name -> renaming = path to name },
                    onMove = { moving = it },
                    onDrop = { path, folder, dest -> model.dropTreeEntry(path, folder, dest) },
                    localFolders = syncPrefixesFromSetting(desk["sync-excluded"]),
                    onToggleLocal = { model.toggleLocalFolder(it) },
                    colors = model.folderColors.collectAsStateWithLifecycle().value,
                    onFolderColor = { model.cycleFolderColor(it) },
                    expanded = model.expandedFolders.collectAsStateWithLifecycle().value,
                    onToggleFolder = { model.toggleFolder(it) },
                    onSetFolderExpanded = { path, open -> model.setFolderExpanded(path, open) },
                    onOpenSplit = { model.openInSplit(it) },
                    onCreateNoteIn = { model.createNoteIn(it) },
                    onCreateFolderIn = { model.createFolderIn(it) },
                    bookFolders = model.books.collectAsStateWithLifecycle().value.map { it.subjectPath }.toSet(),
                    onImportPdfIn = onImportPdfIn,
                    onImportBook = onImportBook,
                    onDetachBook = { model.detachSubjectBook(it) },
                    compact = compact,
                    rowHeightDp = chrome.rowHeightDp,
                    radiusDp = chrome.radiusDp ?: 10,
                    conflicts = sync.conflicts,
                    onResolve = { conflict, choice -> model.resolveConflict(conflict, choice) },
                    onCollapse = { model.setSidebarOpen(false) },
                )
            }
            if (focus || wide || !showList || destination != "notes") {
                if (destination != "notes") {
                    Box(Modifier.weight(1f).fillMaxHeight()) {
                        when (destination) {
                            "search" -> SearchScreen(model) { model.openPath(it); model.showDestination("notes") }
                            "tasks" -> HomeworkScreen(model)
                            "calendar" -> CalendarScreen(model, { model.openPath(it); model.showDestination("notes") }, onImportIcs, onExportIcs)
                            "overview" -> OverviewScreen(
                                model,
                                onOpen = { model.openPath(it); model.showDestination("notes") },
                                onCreate = { createParent = model.defaultCreateFolder(); createNote = true; model.showDestination("notes") },
                                onClose = { model.showDestination("notes") },
                            )
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
                    val bookShown by model.bookOpen.collectAsStateWithLifecycle()
                    val bookPlacement = desk["book-placement"].orEmpty().ifBlank { "rechts" }
                    val bookPolicy = ch.fasrv.fanotes.desk.subjectBookViewPolicy(book != null, bookShown, bookPlacement)
                    val showBook = bookPolicy.paneVisible && bookPlacement != "popout"
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
                                    syncPending || sync.status == SyncStatus.SYNCING, { requestSync() }, { model.setSidebarOpen(!(if (wide) sidebarOpen else showList)) },
                                    editWorksheetBox, { mathOpen = true }, it.clipToBounds(),
                                    showRelations = !panels.inspector,
                                    onExportPdf = onExportPdf,
                                    onImportSheet = onImportSheet,
                                    onDownload = onDownload,
                                    onDeskShortcut = ::runDeskShortcut,
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
                                syncPending || sync.status == SyncStatus.SYNCING, { requestSync() }, { model.setSidebarOpen(!(if (wide) sidebarOpen else showList)) },
                                editWorksheetBox, { mathOpen = true }, it.clipToBounds(),
                                showRelations = !panels.inspector,
                                onExportPdf = onExportPdf,
                                onImportSheet = onImportSheet,
                                onDownload = onDownload,
                                onDeskShortcut = ::runDeskShortcut,
                            )
                        }
                    }
                    if (showBook && bookPlacement == "rechts") {
                        BookPane(model, Modifier.width(280.dp).fillMaxHeight(), openBook)
                    }
                }
                if (panels.inspector) {
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
            onCrumb = {
                model.showList.value = true
                model.sidebarOpen.value = true
            },
            sidebarOpen = if (wide) sidebarOpen else showList,
            onToggleSidebar = { model.setSidebarOpen(!(if (wide) sidebarOpen else showList)) },
            notice = message,
            onDismissNotice = { model.message.value = null },
        )
    }
    if (palette) {
        AlertDialog(onDismissRequest = { model.paletteOpen.value = false }, confirmButton = {}, text = {
            CommandPalette(
                onDismiss = { model.paletteOpen.value = false },
                reduceMotion = ch.fasrv.fanotes.desk.reduceMotion(desk["reduce-motion"]),
                notesOnly = paletteNotes,
                rankNotes = { query, limit -> model.rankNotes(query, limit) },
                onOpenNote = { model.openPath(it); model.showDestination("notes") },
                onOpenNoteInSplit = { model.openInSplit(it); model.showDestination("notes") },
                splitOpen = split != null,
                penOpen = !showText,
                bookOpen = model.bookOpen.collectAsStateWithLifecycle().value,
            ) { id ->
                when (id) {
                    "new-note" -> {
                        createParent = model.defaultCreateFolder()
                        createNote = true
                    }
                    "import-pdf" -> onImportPdf()
                    "new-folder" -> {
                        createParent = ""
                        createFolder = true
                    }
                    "save" -> model.saveFromShortcut()
                    "pen" -> model.togglePen()
                    "note-link" -> model.requestPlaceLink()
                    "book" -> model.toggleBookView()
                    "worksheet" -> onImportSheet()
                    "daily" -> model.openDaily()
                    "split" -> model.toggleSplit()
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
                    "sidebar" -> model.setSidebarOpen(!(if (wide) sidebarOpen else showList))
                    "inspector" -> model.toggleInspector()
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
    if (bugReportOpen) BugReportDialog(model)
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
            text = {
                Column {
                    OutlinedTextField(boxText, { boxText = it }, label = { Text("Text") })
                    TextButton(onClick = { model.removeWorksheetBox(id); editingBox = null }) { Text("Textfeld entfernen") }
                }
            },
            confirmButton = {
                TextButton(onClick = { model.updateWorksheetBox(id, boxText); editingBox = null }) { Text("Speichern") }
            },
            dismissButton = { TextButton(onClick = { editingBox = null }) { Text("Abbrechen") } },
        )
    }
    if (firstRun) {
        FirstRunDialog(
            draft = firstDraft,
            onDraft = { firstDraft = it },
            onFinish = { draft ->
                firstRun = false
                model.applyProfile(draft.profile, draft.selected)
            },
            onDismiss = { firstRun = false; model.updateDesk("welcomed", "yes") },
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

private fun openFollowedLink(
    context: android.content.Context,
    model: FaNotesViewModel,
    target: String,
    web: Boolean,
    anchor: String? = null,
) {
    if (!web) {
        model.openWikiTarget(target, anchor)
        return
    }
    val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(target))
    runCatching { context.startActivity(intent) }.onFailure {
        model.message.value = "Der Link konnte nicht geöffnet werden."
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
    splitPath: String? = null,
    vaultLabel: String,
    syncLabel: String,
    onOpen: (String) -> Unit,
    onSync: () -> Unit,
    onCreateNote: () -> Unit,
    onCreateFolder: () -> Unit,
    onImportPdf: () -> Unit,
    onImportImage: () -> Unit,
    onImportSheet: () -> Unit,
    onOpenVault: () -> Unit,
    onPrivateVault: () -> Unit,
    onDelete: (String, Boolean, String) -> Unit,
    onRename: (String, String) -> Unit,
    onMove: (String) -> Unit,
    onDrop: (String, Boolean, String) -> Unit,
    localFolders: List<String> = emptyList(),
    onToggleLocal: (String) -> Unit = {},
    colors: Map<String, String>,
    onFolderColor: (String) -> Unit,
    expanded: Set<String>,
    onToggleFolder: (String) -> Unit,
    onSetFolderExpanded: (String, Boolean) -> Unit = { _, _ -> },
    onOpenSplit: (String) -> Unit,
    onCreateNoteIn: (String) -> Unit = {},
    onCreateFolderIn: (String) -> Unit = {},
    bookFolders: Set<String> = emptySet(),
    onImportPdfIn: (String) -> Unit = {},
    onImportBook: (String) -> Unit = {},
    onDetachBook: (String) -> Unit = {},
    conflicts: List<ch.fasrv.fanotes.sync.SyncConflict>,
    onResolve: (ch.fasrv.fanotes.sync.SyncConflict, String) -> Unit,
    compact: Boolean = false,
    rowHeightDp: Int? = null,
    radiusDp: Int = 10,
    onCollapse: () -> Unit = {},
) {
    Column(modifier.background(MaterialTheme.colorScheme.surface).padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("FaNotes", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                Text(vaultLabel, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
            }
            TextButton(onClick = onCollapse) { Text("Einklappen") }
        }
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
            TextButton(onClick = onImportSheet) { Text("Blatt") }
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
        var treeFocus by remember(selected) { mutableStateOf(selected) }
        val treeFocusRequester = remember { FocusRequester() }
        var dragPath by remember { mutableStateOf<String?>(null) }
        var dragFolder by remember { mutableStateOf(false) }
        var dropDest by remember { mutableStateOf<String?>(null) }
        val rowBounds = remember { androidx.compose.runtime.mutableStateMapOf<String, TreeRowBox>() }
        var listBounds by remember { mutableStateOf<TreeBox?>(null) }
        LazyColumn(
            Modifier
                .weight(1f)
                .padding(top = 8.dp)
                .focusRequester(treeFocusRequester)
                .focusable()
                .onPreviewKeyEvent { event ->
                    if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                    val command = when (event.key) {
                        Key.DirectionDown -> "down"
                        Key.DirectionUp -> "up"
                        Key.MoveHome -> "home"
                        Key.MoveEnd -> "end"
                        Key.DirectionLeft -> "left"
                        Key.DirectionRight -> "right"
                        Key.F2 -> "rename"
                        Key.Delete -> "delete"
                        Key.Enter, Key.NumPadEnter -> if (event.isShiftPressed) "split" else "open"
                        else -> return@onPreviewKeyEvent false
                    }
                    val step = ch.fasrv.fanotes.desk.applyTreeKey(tree.map { it.toTreeKey() }, expanded, treeFocus, command)
                    treeFocus = step.focus
                    (step.expanded - expanded).forEach { onSetFolderExpanded(it, true) }
                    (expanded - step.expanded).forEach { onSetFolderExpanded(it, false) }
                    val focused = step.focus?.let { path -> findVaultNode(tree, path) }
                    when (step.action) {
                        ch.fasrv.fanotes.desk.TreeKeyAction.OPEN -> step.focus?.let(onOpen)
                        ch.fasrv.fanotes.desk.TreeKeyAction.OPEN_SPLIT -> step.focus?.let(onOpenSplit)
                        ch.fasrv.fanotes.desk.TreeKeyAction.RENAME -> focused?.let { onRename(it.path, it.name) }
                        ch.fasrv.fanotes.desk.TreeKeyAction.DELETE -> focused?.let { onDelete(it.path, it.kind == NoteKind.FOLDER, it.name) }
                        null -> Unit
                    }
                    true
                }
                .onGloballyPositioned {
                    val bounds = it.boundsInRoot()
                    listBounds = TreeBox(bounds.left, bounds.top, bounds.right, bounds.bottom)
                }
                .background(if (dropDest == "") MaterialTheme.colorScheme.primary.copy(alpha = 0.08f) else Color.Transparent),
            userScrollEnabled = dragPath == null,
        ) {
            items(tree, key = { it.path }) { node ->
                NoteRow(
                    node, selected, splitPath, treeFocus, colors, expanded, onOpen, onDelete, onRename, onMove, onFolderColor, onToggleFolder, onOpenSplit,
                    onCreateNoteIn, onCreateFolderIn, bookFolders, onImportPdfIn, onImportBook, onDetachBook,
                    {
                        treeFocus = it
                        runCatching { treeFocusRequester.requestFocus() }
                    },
                    localFolders, onToggleLocal, compact, rowHeightDp, radiusDp,
                    dragPath = dragPath,
                    dropDest = dropDest,
                    onRowBounds = { box -> rowBounds[node.path] = box },
                    onDragStart = { path, folder ->
                        dragPath = path
                        dragFolder = folder
                        dropDest = null
                    },
                    onDrag = { path, folder, x, y ->
                        dropDest = resolveTreeDrop(path, folder, rowBounds.values.toList(), x, y, listBounds)
                    },
                    onDragEnd = {
                        val path = dragPath
                        val folder = dragFolder
                        val dest = dropDest
                        dragPath = null
                        dropDest = null
                        if (path != null && dest != null) onDrop(path, folder, dest)
                    },
                    onDragCancel = {
                        dragPath = null
                        dropDest = null
                    },
                    depth = 0,
                )
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
    splitPath: String?,
    treeFocus: String?,
    colors: Map<String, String>,
    expanded: Set<String>,
    onOpen: (String) -> Unit,
    onDelete: (String, Boolean, String) -> Unit,
    onRename: (String, String) -> Unit,
    onMove: (String) -> Unit,
    onFolderColor: (String) -> Unit,
    onToggleFolder: (String) -> Unit,
    onOpenSplit: (String) -> Unit,
    onCreateNoteIn: (String) -> Unit,
    onCreateFolderIn: (String) -> Unit,
    bookFolders: Set<String>,
    onImportPdfIn: (String) -> Unit,
    onImportBook: (String) -> Unit,
    onDetachBook: (String) -> Unit,
    onTreeFocus: (String) -> Unit,
    localFolders: List<String>,
    onToggleLocal: (String) -> Unit,
    compact: Boolean,
    rowHeightDp: Int?,
    radiusDp: Int,
    dragPath: String?,
    dropDest: String?,
    onRowBounds: (TreeRowBox) -> Unit,
    onDragStart: (String, Boolean) -> Unit,
    onDrag: (String, Boolean, Float, Float) -> Unit,
    onDragEnd: () -> Unit,
    onDragCancel: () -> Unit,
    depth: Int,
) {
    val folderColor = colors[node.path]
    val folder = node.kind == NoteKind.FOLDER
    val openFolder = folder && node.path in expanded
    val dragging = dragPath == node.path
    val dropHere = !dropDest.isNullOrEmpty() && folder && node.path == dropDest
    val handleOrigin = remember { floatArrayOf(0f, 0f) }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = (depth * 12).dp)
            .height(ch.fasrv.fanotes.desk.chromeRowHeightDp(compact, rowHeightDp).dp)
            .border(
                if (node.path == treeFocus) 1.dp else 0.dp,
                MaterialTheme.colorScheme.primary,
                RoundedCornerShape(radiusDp.dp),
            )
            .clip(RoundedCornerShape(radiusDp.dp))
            .background(
                when {
                    dropHere -> MaterialTheme.colorScheme.primary.copy(alpha = 0.28f)
                    dragging -> MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)
                    node.path == selected -> MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)
                    else -> Color.Transparent
                },
            )
            .onGloballyPositioned {
                val bounds = it.boundsInRoot()
                onRowBounds(TreeRowBox(node.path, folder, TreeBox(bounds.left, bounds.top, bounds.right, bounds.bottom)))
            }
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            if (!folder) "" else if (openFolder) "▾" else "▸",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
            modifier = Modifier.width(14.dp).clickable {
                onTreeFocus(node.path)
                if (folder) onToggleFolder(node.path) else onOpen(node.path)
            },
        )
        Icon(
            when (node.kind) {
                NoteKind.FOLDER -> Icons.Filled.Folder
                NoteKind.PDF -> Icons.Filled.PictureAsPdf
                NoteKind.MARKDOWN -> Icons.Filled.Description
            },
            contentDescription = if (folder) "Ordnerfarbe" else null,
            tint = folderColor?.let { Color(android.graphics.Color.parseColor(it)) } ?: MaterialTheme.colorScheme.primary,
            modifier = if (folder) Modifier.clickable(onClickLabel = "Ordnerfarbe") { onFolderColor(node.path) } else Modifier,
        )
        Text(
            node.name,
            maxLines = 1,
            color = if (ch.fasrv.fanotes.desk.rowIsSplitCompanion(node.path, selected, splitPath)) {
                MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f)
            } else {
                MaterialTheme.colorScheme.onSurface
            },
            modifier = Modifier
                .weight(1f)
                .padding(start = 8.dp)
                .onGloballyPositioned {
                    val bounds = it.boundsInRoot()
                    handleOrigin[0] = bounds.left
                    handleOrigin[1] = bounds.top
                }
                .pointerInput(node.path) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        val slop = viewConfiguration.touchSlop
                        val held = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                            while (true) {
                                val event = awaitPointerEvent()
                                val change = event.changes.firstOrNull { it.id == down.id } ?: return@withTimeoutOrNull "cancel"
                                val dx = change.position.x - down.position.x
                                val dy = change.position.y - down.position.y
                                if (dx * dx + dy * dy > slop * slop) return@withTimeoutOrNull "scroll"
                                if (!change.pressed) return@withTimeoutOrNull "tap"
                            }
                            "tap"
                        }
                        when (held) {
                            "tap" -> {
                                onTreeFocus(node.path)
                                if (folder) onToggleFolder(node.path) else onOpen(node.path)
                            }
                            "scroll", "cancel" -> Unit
                            else -> {
                                onDragStart(node.path, folder)
                                var moved = false
                                var ended = false
                                while (true) {
                                    val event = awaitPointerEvent()
                                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                    change.consume()
                                    onDrag(node.path, folder, handleOrigin[0] + change.position.x, handleOrigin[1] + change.position.y)
                                    if (abs(change.position.x - down.position.x) > slop || abs(change.position.y - down.position.y) > slop) moved = true
                                    if (!change.pressed) {
                                        ended = true
                                        break
                                    }
                                }
                                if (ended && moved) onDragEnd() else onDragCancel()
                            }
                        }
                    }
                },
        )
        if (node.kind != NoteKind.FOLDER) {
            Text(
                "Rechts",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .clickable(onClickLabel = "Rechts öffnen") { onOpenSplit(node.path) }
                    .padding(horizontal = 6.dp),
            )
        }
        if (folder) {
            Text(
                "+",
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .clickable(onClickLabel = "Neue Notiz in diesem Ordner") { onCreateNoteIn(node.path) }
                    .padding(horizontal = 6.dp),
            )
            Text(
                "PDF",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .clickable(onClickLabel = "PDF importieren") { onImportPdfIn(node.path) }
                    .padding(horizontal = 4.dp),
            )
            Text(
                "Buch",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .clickable(onClickLabel = "Buch hinzufügen") { onImportBook(node.path) }
                    .padding(horizontal = 4.dp),
            )
            if (node.path in bookFolders) {
                Text(
                    "Weg",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier
                        .clickable(onClickLabel = "Buch entfernen") { onDetachBook(node.path) }
                        .padding(horizontal = 4.dp),
                )
            }
            Icon(
                Icons.Filled.CreateNewFolder,
                contentDescription = "Unterordner anlegen",
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .size(18.dp)
                    .clickable(onClickLabel = "Unterordner anlegen") { onCreateFolderIn(node.path) },
            )
        }
        if (node.kind == NoteKind.FOLDER) {
            val local = pathIsSyncExcluded(node.path, localFolders)
            Text(
                localFolderAction(local),
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
    if (openFolder && node.children.isEmpty()) {
        Row(
            Modifier.padding(start = ((depth + 1) * 12).dp, top = 2.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Leer", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f))
            Text(
                "Unterordner anlegen",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .padding(start = 8.dp)
                    .clickable(onClickLabel = "Unterordner anlegen") { onCreateFolderIn(node.path) },
            )
        }
    }
    if (openFolder) {
        node.children.forEach {
            NoteRow(
                it, selected, splitPath, treeFocus, colors, expanded, onOpen, onDelete, onRename, onMove, onFolderColor, onToggleFolder, onOpenSplit,
                onCreateNoteIn, onCreateFolderIn, bookFolders, onImportPdfIn, onImportBook, onDetachBook,
                onTreeFocus,
                localFolders, onToggleLocal, compact, rowHeightDp, radiusDp,
                dragPath = dragPath,
                dropDest = dropDest,
                onRowBounds = onRowBounds,
                onDragStart = onDragStart,
                onDrag = onDrag,
                onDragEnd = onDragEnd,
                onDragCancel = onDragCancel,
                depth = depth + 1,
            )
        }
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
    val folded = model.splitFolded.collectAsStateWithLifecycle().value
    val visible = ch.fasrv.fanotes.desk.markdownWithFolds(markdown, folded)
    val splitUnsaved = model.splitUnsaved.collectAsStateWithLifecycle().value
    val title = path?.let { ch.fasrv.fanotes.vault.titleOf(it) }.orEmpty()
    var typing by remember(path) { mutableStateOf(false) }
    var splitEditor by remember(path) { mutableStateOf<SplitEditorView?>(null) }
    Column(modifier) {
        Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title.ifBlank { "Zweite Spalte" }, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 1)
            if (splitUnsaved) {
                Box(
                    Modifier
                        .padding(end = 6.dp)
                        .size(6.dp)
                        .clip(androidx.compose.foundation.shape.CircleShape)
                        .background(MaterialTheme.colorScheme.primary)
                        .semantics { contentDescription = "Noch nicht gespeichert" },
                )
            }
            TextButton(onClick = { typing = !typing }) { Text(if (typing) "Stift" else "Text") }
            if (typing) TextButton(onClick = { splitEditor?.selectNext() }) { Text("Nächstes") }
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
                if (view.markdown != visible) {
                    view.markdown = visible
                    view.invalidate()
                }
                view.showMarkdown = visible.isNotBlank() && !typing
                view.onToggleSection = { model.toggleSplitSection(it) }
                view.inkTool = tool
                view.style = style
                view.fingerDraws = finger
                view.onChanged = { model.splitChanged() }
                view.onTogglePaperTask = { line ->
                    val shown = view.markdown
                    val next = ch.fasrv.fanotes.desk.toggleTask(shown, line)
                    if (next != shown) model.updateSplitVisible(shown, next)
                }
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
            val metrics = ch.fasrv.fanotes.desk.editorMetrics(model.effectiveDesk())
            AndroidView(
                modifier = Modifier.fillMaxSize().background(Color(0xFFF7F6F3)).padding(16.dp),
                factory = { context ->
                    SplitEditorView(context).also { splitEditor = it }
                },
                update = { editor ->
                    splitEditor = editor
                    editor.onVisibleEdit = { previous, next -> model.updateSplitVisible(previous, next) }
                    editor.onFollowLink = { target, web, anchor -> openFollowedLink(editor.context, model, target, web, anchor) }
                    editor.accent = android.graphics.Color.parseColor(
                        ch.fasrv.fanotes.desk.normalizeAccent(model.effectiveDesk()["accent"]),
                    )
                    editor.typeface = loadEditorTypeface(editor.context, metrics.editorFontId)
                    editor.showLineNumbers = metrics.showLineNumbers
                    editor.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, metrics.fontSizePx.toFloat())
                    editor.setLineSpacing(0f, metrics.lineHeight.toFloat())
                    applyPaperCaret(editor, editor.accent, metrics.fontSizePx.toFloat())
                    editor.foldMarkers = ch.fasrv.fanotes.desk.foldMarkerGlyphs(markdown, folded)
                    editor.foldSource = markdown
                    editor.foldState = folded
                    editor.onToggleFold = { model.toggleSplitHeadingAtVisibleLine(it) }
                    editor.onEditorFold = { command, offset -> model.foldSplitCommand(command, offset) }
                    editor.show(visible)
                },
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
    onImportSheet: () -> Unit = {},
    onDownload: () -> Unit = {},
    onDeskShortcut: (String) -> Unit = {},
) {
    val noteKind = model.open.collectAsStateWithLifecycle().value?.kind
    val showGoto by model.showGotoLine.collectAsStateWithLifecycle()
    Column(modifier) {
            if (path != null) {
            Row(Modifier.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onExportPdf) { Text("Als PDF exportieren") }
                TextButton(onClick = onDownload) { Text("Herunterladen") }
                if (noteKind != NoteKind.PDF) {
                    TextButton(onClick = onImportSheet) { Text("Blatt") }
                    TextButton(onClick = { model.openGotoLine() }) { Text("Gehe zu Zeile") }
                }
            }
            val sheets = backdrop.filter { it.worksheetId.isNotEmpty() }.distinctBy { it.worksheetId }
            if (sheets.isNotEmpty()) {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    sheets.forEach { slice ->
                        Text(slice.label.ifBlank { "Arbeitsblatt" }, fontSize = 13.sp, maxLines = 1)
                        TextButton(onClick = { model.removeWorksheet(slice.worksheetId) }) { Text("Entfernen") }
                    }
                }
            }
            NoteTagBar(model)
            MarginTranscript(model)
            if (noteKind == NoteKind.PDF) {
                PdfPasswordPrompt(model)
                PdfSearchBar(model)
                PdfThumbStrip(model)
                PdfQuoteMarks(model)
            } else {
                NoteSearchBar(model)
            }
            if (showRelations) NoteRelations(model) { model.openPath(it); model.showDestination("notes") }
        }
        if (showGoto) {
            GotoLineDialog { input ->
                model.closeGotoLine()
                if (input != null) model.requestGotoLine(input)
            }
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
        onDeskShortcut = onDeskShortcut,
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
        onDeskShortcut: (String) -> Unit,
        modifier: Modifier,
) {
    var bound by remember { mutableStateOf("") }
    var inkNotice by remember { mutableStateOf<ch.fasrv.fanotes.ink.InkNotice?>(null) }
    val links by model.noteLinks.collectAsStateWithLifecycle()
    val boxes by model.worksheetBoxes.collectAsStateWithLifecycle()
    val highlights by model.worksheetHighlights.collectAsStateWithLifecycle()
    val outlineJump by model.outlineJump.collectAsStateWithLifecycle()
    val gotoLineInput by model.gotoLineInput.collectAsStateWithLifecycle()
    val foldedHeadings by model.foldedHeadings.collectAsStateWithLifecycle()
    val clearLink by model.clearLinkRequest.collectAsStateWithLifecycle()
    val placeLinkRequest by model.placeLinkRequest.collectAsStateWithLifecycle()
    var appliedClear by remember { mutableStateOf(0) }
    var appliedPlaceLink by remember { mutableStateOf(0) }
    val wasPlacingSection = remember { booleanArrayOf(false) }
    Box(modifier) {
    AndroidView(
        modifier = Modifier.matchParentSize(),
        factory = { context ->
            NotePageView(context).apply {
                attachSession(model.session)
                ink.onChanged = { model.noteChanged() }
                ink.onStroke = { model.recordFinishedStroke(it) }
                ink.onErased = { model.recordErasedStrokes(it) }
                ink.onInkNotice = { inkNotice = it }
                ink.onPageGrew = { prevWidth, prevHeight, nextWidth, nextHeight, padX, padY ->
                    model.pageGrew(prevWidth, prevHeight, nextWidth, nextHeight, padX, padY)
                }
                ink.onPenSample = { x, y -> model.recordPenSample(x, y) }
                ink.onSwipeNote = { model.swipe(it) }
                ink.onEdgeHistory = { model.navigateHistory(it) }
                onUnfoldHeading = { model.unfoldHeading(it) }
            }
        },
        update = { page ->
            page.attachSession(model.session)
            page.ink.onChanged = { model.noteChanged() }
            page.ink.onStroke = { model.recordFinishedStroke(it) }
            page.ink.onErased = { model.recordErasedStrokes(it) }
            page.ink.onInkNotice = { inkNotice = it }
            page.ink.onPageGrew = { prevWidth, prevHeight, nextWidth, nextHeight, padX, padY ->
                model.pageGrew(prevWidth, prevHeight, nextWidth, nextHeight, padX, padY)
            }
            page.ink.onPenSample = { x, y -> model.recordPenSample(x, y) }
            page.ink.onSwipeNote = { model.swipe(it) }
            page.ink.onEdgeHistory = { model.navigateHistory(it) }
            page.onUnfoldHeading = { model.unfoldHeading(it) }
            page.onToggleHeading = { model.toggleHeadingAtVisibleLine(it) }
            page.onEditorFold = { command, offset -> model.foldEditorCommand(command, offset) }
            page.onSearchCommand = { command, selected, offset ->
                when (command) {
                    "open" -> model.openNoteSearch(selected)
                    "next" -> model.findInNote(true, offset, selected)
                    "previous" -> model.findInNote(false, offset, selected)
                    "goto" -> model.openGotoLine()
                }
            }
            page.onDeskShortcut = onDeskShortcut
            if (page.ink.backdrop !== backdrop) page.ink.backdrop = backdrop
            page.onTool = {
                model.tool.value = it
                model.recordBugTool(it.name)
            }
            page.onSync = onSync
            page.onMarkdown = { model.updateMarkdown(it) }
            page.onPasteImage = { name, bytes, mime -> model.importBytes(name, bytes, pdf = false, mime = mime) }
            page.onFollowLink = { target, web, anchor -> openFollowedLink(page.context, model, target, web, anchor) }
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
            page.onBrush = {
                val brush = ch.fasrv.fanotes.ink.artBrush(it)
                model.style.value = style.copy(brush = brush.id, baseWidth = brush.defaultWidth, pressureEnabled = brush.pressure)
            }
            page.onEffect = {
                model.style.value = style.copy(colorEffect = it)
                model.updateDesk("ink-effect", it)
            }
            page.onToggleRail = onToggleRail
            page.onTextMode = { model.showText.value = it }
            page.onDeleteSelection = { model.deleteSelection() }
            page.onDuplicate = { model.duplicateSelection() }
            page.onClear = { model.clearInk() }
            val placing = model.placingSection.value
            if (wasPlacingSection[0] && !placing && page.ink.placingSection) {
                page.ink.onInkNotice(ch.fasrv.fanotes.ink.InkNotice("info", ch.fasrv.fanotes.ink.SECTION_PLACE_CANCELLED))
                page.ink.sectionGuideY = Float.NaN
                page.ink.invalidate()
            }
            wasPlacingSection[0] = placing
            page.ink.placingSection = placing
            page.ink.onSectionChrome = { model.setPlacingSection(it) }
            page.ink.onPlaceSection = { model.insertSection(it) }
            page.ink.onLinkChrome = { placing, selected -> model.reportLinkChrome(placing, selected) }
            if (placeLinkRequest != appliedPlaceLink) {
                appliedPlaceLink = placeLinkRequest
                page.ink.placingLink = model.linkPlacing.value
                page.ink.publishLinkChrome()
            }
            if (clearLink != appliedClear) {
                appliedClear = clearLink
                page.ink.placingLink = false
                page.ink.selectedLinkId = null
                page.ink.publishLinkChrome()
                page.ink.invalidate()
            }
            page.ink.onPlaceLink = { linkPage, x, y -> model.placeNoteLink(linkPage, x, y, page.ink.noteLinkStyle) }
            page.ink.onOpenLink = { model.openPath(it); model.showDestination("notes") }
            page.ink.onRemoveLink = { model.askRemoveNoteLink(it) }
            page.onRestyleLink = { id, linkStyle -> model.restylePlacedNoteLink(id, linkStyle) }
            page.ink.onToggleSection = { model.toggleInkSection(it) }
            page.ink.onEditBox = onEditBox
            page.onMath = onMath
            page.onPdfPage = { model.notePdfPage(it) }
            page.onSymbolSize = { model.setArtSymbolSize(it) }
            page.onSymbolRotation = { model.setArtSymbolRotation(it) }
            page.onSymbolOpacity = { model.setArtSymbolOpacity(it) }
            page.onSymbolCategory = { model.setArtSymbolCategory(it) }
            page.onSymbolPose = { model.canvasToken.value += 1 }
            page.ink.symbolSize = ch.fasrv.fanotes.ink.artSymbolSizeSetting(model.effectiveDesk()["symbol-size"])
            page.ink.symbolRotation = ch.fasrv.fanotes.ink.artSymbolRotationSetting(model.effectiveDesk()["symbol-rotation"])
            page.ink.symbolOpacity = ch.fasrv.fanotes.ink.artSymbolOpacitySetting(model.effectiveDesk()["symbol-opacity"])
            page.ink.symbolCategory = ch.fasrv.fanotes.ink.artSymbolCategorySetting(model.effectiveDesk()["symbol-category"])
            page.ink.linkMarks = links
            page.ink.worksheetBoxes = boxes
            page.ink.worksheetHighlights = highlights
            page.ink.pageFrames = backdrop.filter { it.worksheetId.isEmpty() }.mapIndexed { index, slice ->
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
            page.ink.onPlaceHighlight = { worksheetId, mark -> model.addWorksheetHighlight(worksheetId, mark) }
            page.ink.onPlaceBox = { worksheetId, pageNumber, x, y ->
                model.placeWorksheetBox(worksheetId, pageNumber, x, y, onEditBox)
            }
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
            val goto = gotoLineInput
            if (goto != null) {
                if (!page.gotoLine(goto)) model.message.value = "Das ist keine Zeile."
                model.consumeGotoLine()
            }
            model.takeNoteSearchSelection()?.let { (start, end) -> page.revealSourceRange(start, end) }
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
    InkNoticeBanner(inkNotice, { inkNotice = null }, Modifier.align(Alignment.TopCenter).fillMaxWidth())
    }
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
    var inkNotice by remember { mutableStateOf<ch.fasrv.fanotes.ink.InkNotice?>(null) }
    Box(modifier) {
    AndroidView(
        modifier = Modifier.matchParentSize(),
        factory = { context ->
            InkSurfaceView(context).apply {
                session = model.session
                onChanged = { model.noteChanged() }
                onStroke = { model.recordFinishedStroke(it) }
                onErased = { model.recordErasedStrokes(it) }
                onInkNotice = { inkNotice = it }
                onSwipeNote = { model.swipe(it) }
                onEdgeHistory = { model.navigateHistory(it) }
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
            view.onInkNotice = { inkNotice = it }
            view.onSwipeNote = { model.swipe(it) }
            view.onEdgeHistory = { model.navigateHistory(it) }
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
    InkNoticeBanner(inkNotice, { inkNotice = null }, Modifier.align(Alignment.TopCenter).fillMaxWidth())
    }
}

@Composable
private fun InkNoticeBanner(notice: ch.fasrv.fanotes.ink.InkNotice?, onClose: () -> Unit, modifier: Modifier = Modifier) {
    val current = notice ?: return
    androidx.compose.runtime.LaunchedEffect(current) {
        val wait = ch.fasrv.fanotes.ink.inkNoticeAutoClearDelayMs(current) ?: return@LaunchedEffect
        delay(wait)
        onClose()
    }
    Row(
        modifier.padding(12.dp).background(MaterialTheme.colorScheme.surface, androidx.compose.foundation.shape.RoundedCornerShape(8.dp)).padding(start = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(current.text, modifier = Modifier.weight(1f), fontSize = 13.sp)
        TextButton(onClick = onClose) { Text("Schließen") }
    }
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
private fun WorksheetImportDialog(
    noteTitle: String?,
    onCurrent: () -> Unit,
    onNew: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Arbeitsblatt importieren") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Bild oder PDF", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
                Text(
                    "Das Arbeitsblatt bleibt Teil deines Vaults. Anschließend kannst du direkt darauf Textfelder platzieren oder mit dem Grafiktablett schreiben.",
                    fontSize = 13.sp,
                )
                TextButton(onClick = onCurrent, enabled = noteTitle != null, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth()) {
                        Text("In aktuelle Notiz", fontWeight = FontWeight.SemiBold)
                        Text(noteTitle ?: "Keine Notiz geöffnet", fontSize = 12.sp)
                    }
                }
                TextButton(onClick = onNew, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.fillMaxWidth()) {
                        Text("Als neue Notiz", fontWeight = FontWeight.SemiBold)
                        Text("Dateiname wird zum Notiztitel", fontSize = 12.sp)
                    }
                }
                Text("PDF · Bilder", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Abbrechen") } },
    )
}

@Composable
private fun GotoLineDialog(onDone: (String?) -> Unit) {
    var value by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = { onDone(null) },
        title = { Text("Gehe zu Zeile") },
        text = {
            OutlinedTextField(
                value,
                { value = it },
                placeholder = { Text("12, +3, 50%, 8:4") },
                singleLine = true,
            )
        },
        confirmButton = { Button(onClick = { onDone(value) }) { Text("Gehe") } },
        dismissButton = { TextButton(onClick = { onDone(null) }) { Text("Abbrechen") } },
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

