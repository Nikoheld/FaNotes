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
import androidx.compose.foundation.hoverable
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
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.DriveFileMove
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.automirrored.filled.MenuBook
import androidx.compose.material.icons.automirrored.filled.NoteAdd
import androidx.compose.material.icons.automirrored.filled.Redo
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.CleaningServices
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.FileCopy
import androidx.compose.material.icons.filled.FileUpload
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.ViewColumn
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.DropdownMenu
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
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
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
private val Papers = ch.fasrv.fanotes.desk.PAPER_STYLES.map { it.id to it.label }
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
    val danger = Color(android.graphics.Color.parseColor(chrome.danger ?: palette.danger))
    val statusInk = StatusInk(
        muted = Color(android.graphics.Color.parseColor(chrome.muted ?: palette.muted)),
        success = Color(android.graphics.Color.parseColor(chrome.success ?: palette.success)),
        warning = Color(android.graphics.Color.parseColor(chrome.warning ?: palette.warning)),
        soft = Color(android.graphics.Color.parseColor(chrome.soft ?: palette.soft)),
        panelActive = Color(android.graphics.Color.parseColor(palette.panelActive)),
        panelStrong = Color(android.graphics.Color.parseColor(palette.panelStrong)),
    )
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
        error = danger,
    )
    CompositionLocalProvider(LocalStatusInk provides statusInk) {
        MaterialTheme(colorScheme = scheme, typography = chromeTypography(family), content = content)
    }
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
    val savePhase by model.savePhase.collectAsStateWithLifecycle()
    val splitUnsaved by model.splitUnsaved.collectAsStateWithLifecycle()
    val palette by model.paletteOpen.collectAsStateWithLifecycle()
    val paletteNotes by model.paletteNotes.collectAsStateWithLifecycle()
    val bugReportOpen by model.bugReportOpen.collectAsStateWithLifecycle()
    val historyOpen by model.historyOpen.collectAsStateWithLifecycle()
    val confirm by model.confirmRequest.collectAsStateWithLifecycle()
    val linkPlacing by model.linkPlacing.collectAsStateWithLifecycle()
    val placingSection by model.placingSection.collectAsStateWithLifecycle()
    val linkSelected by model.linkSelected.collectAsStateWithLifecycle()
    val gotoLine by model.gotoLineInput.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var firstRun by remember { mutableStateOf(desk["welcomed"] != "yes") }
    var firstDraft by remember { mutableStateOf(ch.fasrv.fanotes.desk.firstRunStart()) }
    var editingBox by remember { mutableStateOf<String?>(null) }
    val editWorksheetBox = { id: String ->
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
                            history = historyOpen,
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
                            sheet = model.sheetAdjusted.value && !showText,
                            pen = !showText,
                            focus = focus,
                        ),
                    ) ?: return@onPreviewKeyEvent false
                    when (target) {
                        "confirm" -> model.dismissConfirm()
                        "bug-report" -> model.closeBugReport()
                        "history" -> model.closeHistory()
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
                        "sheet" -> model.resetSheet()
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
                penOpen = !showText,
                onDestination = { model.showDestination(it) },
                onPalette = { model.showPalette(notes = false) },
                onFocus = { model.updateDesk("focus", "on") },
                onDaily = { model.openDaily() },
                onPen = { model.togglePen(); model.showDestination("notes") },
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
            DeskRibbon(
                destination,
                true,
                penOpen = !showText,
                onDestination = { model.showDestination(it) },
                onPalette = { model.showPalette(notes = false) },
                onFocus = { model.updateDesk("focus", "off") },
                onDaily = { model.openDaily() },
                onPen = { model.togglePen(); model.showDestination("notes") },
            )
        }
        val panels = ch.fasrv.fanotes.desk.noteWorkspacePanels(
            focus = focus,
            wide = wide,
            showList = showList,
            sidebarOpen = sidebarOpen,
            inspectorOpen = inspectorOpen,
            outlineEnabled = desk["outline"] != "off",
            notes = ch.fasrv.fanotes.desk.workspaceKeepsNoteChrome(destination),
        )
        Box(Modifier.weight(1f).fillMaxWidth()) {
        Row(Modifier.fillMaxSize()) {
            if (panels.sidebar) {
                VaultPane(
                    modifier = Modifier.width((chrome.sidebarDp ?: ch.fasrv.fanotes.desk.sidebarWidthDp(desk["sidebar-width"])).dp).fillMaxHeight(),
                    tree = filterVaultByTag(tree, tagFilter, tagIndex),
                    tags = collectVaultTags(tagIndex.values.map { noteTags -> noteTags.joinToString(" ") { "#$it" } }),
                    tagFilter = tagFilter,
                    onToggleTag = { model.toggleTagFilter(it) },
                    searchQuery = model.searchQuery.collectAsStateWithLifecycle().value,
                    onSearchQuery = { model.searchVaultText(it) },
                    onOpenSearch = { model.showDestination("search") },
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
                    renamingPath = renaming?.first,
                    onCommitRename = { path, name ->
                        renaming = null
                        model.rename(path, name)
                    },
                    onCancelRename = { renaming = null },
                    onMove = { moving = it },
                    onDrop = { path, folder, dest -> model.dropTreeEntry(path, folder, dest) },
                    localFolders = syncPrefixesFromSetting(desk["sync-excluded"]),
                    onToggleLocal = { model.toggleLocalFolder(it) },
                    colors = model.folderColors.collectAsStateWithLifecycle().value,
                    onFolderColor = { path, color -> model.setFolderColor(path, color) },
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
                if (destination != "notes" && destination != "search") {
                    Box(Modifier.weight(1f).fillMaxHeight()) {
                        when (destination) {
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
                                    editWorksheetBox, editingBox, { editingBox = null }, { mathOpen = true }, it.clipToBounds(),
                                    showRelations = !panels.inspector,
                                    onExportPdf = onExportPdf,
                                    onImportSheet = onImportSheet,
                                    onImportPdf = onImportPdf,
                                    onCreateNote = { createParent = model.defaultCreateFolder(); createNote = true },
                                    onPalette = { model.showPalette(notes = false) },
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
                                editWorksheetBox, editingBox, { editingBox = null }, { mathOpen = true }, it.clipToBounds(),
                                showRelations = !panels.inspector,
                                onExportPdf = onExportPdf,
                                onImportSheet = onImportSheet,
                                onImportPdf = onImportPdf,
                                onCreateNote = { createParent = model.defaultCreateFolder(); createNote = true },
                                onPalette = { model.showPalette(notes = false) },
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
                    Box(Modifier.width((chrome.panelDp ?: ch.fasrv.fanotes.desk.rightPanelWidthDp(desk["panel-width"])).dp).fillMaxHeight()) { Inspector(model) { model.openPath(it) } }
                }
            }
        }
        if (destination == "search") {
            val shadow = Color.Black.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_SHADOW_ALPHA)
            SearchScreen(
                model,
                { model.openPath(it); model.showDestination("notes") },
                { model.showDestination("notes") },
                Modifier
                    .align(Alignment.CenterStart)
                    .width((chrome.sidebarDp ?: ch.fasrv.fanotes.desk.searchPanelWidthDp(desk["sidebar-width"])).dp)
                    .fillMaxHeight()
                    .shadow(
                        ch.fasrv.fanotes.desk.SEARCH_SHADOW_X_DP.dp,
                        clip = false,
                        ambientColor = shadow,
                        spotColor = shadow,
                    ),
            )
        }
            val toast = message
            if (!toast.isNullOrBlank()) {
                FaNotesToast(
                    toast,
                onDismiss = { model.message.value = null },
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(
                        end = ch.fasrv.fanotes.desk.TOAST_INSET_END_DP.dp,
                        bottom = ch.fasrv.fanotes.desk.TOAST_INSET_BOTTOM_DP.dp,
                    ),
            )
        }
        }
        val sheetCount = backdrop.filter { it.worksheetId.isNotEmpty() }.distinctBy { it.worksheetId }.size
        DeskStatusBar(
            model.wordCountNow(),
            syncText,
            sync.status.name.lowercase(),
            ch.fasrv.fanotes.desk.statusLanguageLabel(ch.fasrv.fanotes.desk.detectNoteLanguage(markdown)).orEmpty(),
            desk["words"] != "off",
            sync.conflicts.size,
            onConflicts = { model.showDestination("settings") },
            crumbs = if (ch.fasrv.fanotes.desk.statusShowsPath(destination) && open?.path != null) breadcrumbsFor(open?.path.orEmpty()) else emptyList(),
            onCrumb = {
                model.showList.value = true
                model.sidebarOpen.value = true
            },
            sidebarOpen = if (wide) sidebarOpen else showList,
            onToggleSidebar = { model.setSidebarOpen(!(if (wide) sidebarOpen else showList)) },
            notice = null,
            onDismissNotice = { model.message.value = null },
            mode = ch.fasrv.fanotes.desk.statusModeLabel(
                destination,
                noteOpen = open != null,
                penOpen = !showText,
                pdf = open?.kind == NoteKind.PDF,
                worksheets = sheetCount,
            ),
            worksheets = ch.fasrv.fanotes.desk.statusWorksheetLabel(sheetCount),
            saveLabel = ch.fasrv.fanotes.desk.statusSaveLabel(savePhase),
            onSave = { model.saveFromShortcut() },
        )
    }
    if (palette) {
        val dismissPalette = { model.paletteOpen.value = false }
        androidx.compose.ui.window.Dialog(
            onDismissRequest = dismissPalette,
            properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
        ) {
            val scrim = remember { MutableInteractionSource() }
            val card = remember { MutableInteractionSource() }
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color(ch.fasrv.fanotes.desk.PALETTE_SCRIM))
                    .clickable(interactionSource = scrim, indication = null, onClick = dismissPalette),
                contentAlignment = Alignment.TopCenter,
            ) {
            Box(
                Modifier
                    .padding(top = ch.fasrv.fanotes.desk.paletteTopDp(LocalConfiguration.current.screenHeightDp).dp)
                    .fillMaxWidth(0.9f)
                    .widthIn(max = ch.fasrv.fanotes.desk.PALETTE_MAX_DP.dp)
                    .clickable(interactionSource = card, indication = null, onClick = {}),
            ) {
            CommandPalette(
                onDismiss = { model.paletteOpen.value = false },
                reduceMotion = ch.fasrv.fanotes.desk.reduceMotion(desk["reduce-motion"]),
                notesOnly = paletteNotes,
                activePath = open?.path,
                rankNotes = { query, limit -> model.rankNotes(query, limit) },
                onOpenNote = { model.openPath(it); model.showDestination("notes") },
                onOpenNoteInSplit = { model.openInSplit(it); model.showDestination("notes") },
                splitOpen = split != null,
                splitRows = desk["split-orientation"] == "rows",
                focus = desk["focus"] == "on",
                dailyFolder = desk["daily-folder"].orEmpty(),
                penOpen = !showText,
                bookOpen = model.bookOpen.collectAsStateWithLifecycle().value,
            ) { id ->
                when (id) {
                    "quick-open" -> model.showPalette(notes = true)
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
                    "sync-settings" -> model.showDestination("settings")
                    "reveal" -> {
                        val path = open?.path
                        if (path == null) {
                            model.message.value = "Öffne zuerst eine Notiz."
                        } else if (!model.selectedFolderVault()) {
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
                    }
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
            }
            }
        }
    }
    if (bugReportOpen) BugReportDialog(model)
    if (historyOpen) HistoryDialog(model)
    confirm?.let { request ->
        FaNotesConfirmDialog(request, onConfirm = { model.acceptConfirm() }, onDismiss = { model.dismissConfirm() }, glass = glass, radiusDp = chrome.radiusDp)
    }
    if (mathOpen) {
        PromptCard(
            "Mathe",
            onDismiss = { mathOpen = false },
            confirmLabel = "In die Notiz",
            confirmEnabled = mathOk,
            dismissLabel = "Schließen",
            onConfirm = {
                if (mathOk) model.insertMath(mathOutput)
                mathOpen = false
            },
        ) {
            Text("Ausrechnen, Vereinfachen, Ausmultiplizieren, Faktorisieren und Gleichungen bis Grad 2.", fontSize = 12.sp, color = LocalStatusInk.current.muted, lineHeight = 17.sp)
            PromptField(mathInput, { mathInput = it }, "Ausdruck", onDone = {})
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf(
                    "calculate" to "Ausrechnen",
                    "solve" to "Lösen",
                    "simplify" to "Vereinfachen",
                    "expand" to "Ausmultiplizieren",
                    "factor" to "Faktorisieren",
                ).forEach { (action, label) ->
                    PromptChoice(label) {
                        runCatching { solveMathExpression(mathInput, action) }
                            .onSuccess { result ->
                                mathOk = true
                                mathOutput = result.steps.joinToString("\n") { it.display }
                            }
                            .onFailure { error ->
                                mathOk = false
                                mathOutput = error.message ?: "Der Ausdruck ist ungültig."
                            }
                    }
                }
            }
            if (mathOutput.isNotBlank()) {
                Text(mathOutput, fontSize = 13.sp, color = if (mathOk) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.error)
            }
        }
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
    if (syncOpen && sync.account == null) {
        SyncDialog(model) { syncOpen = false }
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
    moving?.let { path ->
        val folders = remember(tree, path) {
            ch.fasrv.fanotes.desk.movableFolderTargets(collectFolders(tree), path)
        }
        val atRoot = !path.contains('/')
        PromptCard(ch.fasrv.fanotes.desk.PROMPT_MOVE, onDismiss = { moving = null }, confirmLabel = null, onConfirm = {}) {
            Text(path.substringAfterLast('/'), fontSize = 12.sp, color = LocalStatusInk.current.muted)
            if (!atRoot) {
                PromptChoice(ch.fasrv.fanotes.desk.PROMPT_ROOT) { model.moveEntry(path, ""); moving = null }
            }
            folders.forEach { folder ->
                PromptChoice(folder) { model.moveEntry(path, folder); moving = null }
            }
            if (atRoot && folders.isEmpty()) {
                Text(ch.fasrv.fanotes.desk.PROMPT_NO_FOLDER, fontSize = 12.sp, color = LocalStatusInk.current.muted)
            }
        }
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
private fun SidebarIconButton(label: String, onClick: () -> Unit, icon: @Composable () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val pressed by interaction.collectIsPressedAsState()
    val hot = hovered || pressed
    Box(
        Modifier
            .size(ch.fasrv.fanotes.desk.SIDEBAR_ACTION_DP.dp)
            .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SIDEBAR_ACTION_RADIUS_DP.dp))
            .background(if (hot) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
            .hoverable(interaction)
            .clickable(interactionSource = interaction, indication = null, onClickLabel = label, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.runtime.CompositionLocalProvider(
            androidx.compose.material3.LocalContentColor provides if (hot) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.muted,
        ) {
            icon()
        }
    }
}

@Composable
private fun SidebarLabelButton(label: String, onClick: () -> Unit, wide: Boolean = false, description: String = label) {
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val pressed by interaction.collectIsPressedAsState()
    val hot = hovered || pressed
    Box(
        Modifier
            .height(ch.fasrv.fanotes.desk.SIDEBAR_ACTION_DP.dp)
            .then(
                if (wide) Modifier.widthIn(min = ch.fasrv.fanotes.desk.SIDEBAR_PDF_MIN_DP.dp)
                else Modifier
            )
            .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SIDEBAR_ACTION_RADIUS_DP.dp))
            .background(if (hot) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
            .hoverable(interaction)
            .clickable(interactionSource = interaction, indication = null, onClickLabel = description, onClick = onClick)
            .padding(horizontal = ch.fasrv.fanotes.desk.SIDEBAR_PDF_PAD_DP.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 12.sp,
            fontWeight = if (wide) FontWeight.ExtraBold else FontWeight.Medium,
            letterSpacing = if (wide) ch.fasrv.fanotes.desk.SIDEBAR_PDF_TRACKING.em else 0.em,
            color = if (hot) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.muted,
            maxLines = 1,
        )
    }
}

@Composable
private fun SidebarSearchField(query: String, onQuery: (String) -> Unit, onFocus: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    var focused by remember { mutableStateOf(false) }
    val hot = hovered || focused
    val ink = LocalStatusInk.current
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_MARGIN_X_DP.dp)
            .padding(bottom = ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_MARGIN_BOTTOM_DP.dp)
            .height(ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_DP.dp)
            .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_RADIUS_DP.dp))
            .background(if (hot) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
            .hoverable(interaction)
            .padding(horizontal = ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_PAD_DP.dp)
            .semantics { contentDescription = "Notizen suchen" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_GAP_DP.dp),
    ) {
        Icon(
            Icons.Filled.Search,
            contentDescription = null,
            modifier = Modifier.size(ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_ICON_DP.dp),
            tint = ink.muted,
        )
        BasicTextField(
            value = query,
            onValueChange = {
                onQuery(it)
                onFocus()
            },
            modifier = Modifier.weight(1f).onFocusChanged {
                focused = it.isFocused
                if (it.isFocused) onFocus()
            },
            singleLine = true,
            textStyle = TextStyle(
                color = MaterialTheme.colorScheme.onSurface,
                fontSize = ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_SP.sp,
            ),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            decorationBox = { inner ->
                Box {
                    if (query.isEmpty()) {
                        Text("Suchen …", fontSize = ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_SP.sp, color = ink.muted)
                    }
                    inner()
                }
            },
        )
        if (query.isNotEmpty()) {
            val clearInteraction = remember { MutableInteractionSource() }
            val clearHot by clearInteraction.collectIsHoveredAsState()
            Box(
                Modifier
                    .size(ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_CLEAR_DP.dp)
                    .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_CLEAR_RADIUS_DP.dp))
                    .background(if (clearHot) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
                    .hoverable(clearInteraction)
                    .clickable(interactionSource = clearInteraction, indication = null, onClickLabel = "Suche leeren") { onQuery("") },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Filled.Close,
                    contentDescription = "Suche leeren",
                    modifier = Modifier.size(ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_CLEAR_ICON_DP.dp),
                    tint = if (clearHot) MaterialTheme.colorScheme.onSurface else ink.muted,
                )
            }
        }
    }
}

@Composable
private fun TagFilterChip(label: String, active: Boolean, onClick: () -> Unit) {
    val borderAlpha = if (active) {
        ch.fasrv.fanotes.desk.TAG_FILTER_ACTIVE_BORDER_ALPHA
    } else {
        ch.fasrv.fanotes.desk.TAG_FILTER_BORDER_ALPHA
    }
    Text(
        label,
        fontSize = 12.sp,
        color = if (active) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.muted,
        modifier = Modifier
            .height(ch.fasrv.fanotes.desk.TAG_FILTER_HEIGHT_DP.dp)
            .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = borderAlpha), RoundedCornerShape(99.dp))
            .background(if (active) LocalStatusInk.current.panelActive else MaterialTheme.colorScheme.surface, RoundedCornerShape(99.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = ch.fasrv.fanotes.desk.TAG_FILTER_PAD_H_DP.dp)
            .wrapContentHeight(Alignment.CenterVertically),
    )
}

@Composable
private fun VaultPane(
    modifier: Modifier,
    tree: List<VaultNode>,
    tags: List<String> = emptyList(),
    tagFilter: String? = null,
    onToggleTag: (String) -> Unit = {},
    searchQuery: String = "",
    onSearchQuery: (String) -> Unit = {},
    onOpenSearch: () -> Unit = {},
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
    renamingPath: String? = null,
    onCommitRename: (String, String) -> Unit = { _, _ -> },
    onCancelRename: () -> Unit = {},
    onMove: (String) -> Unit,
    onDrop: (String, Boolean, String) -> Unit,
    localFolders: List<String> = emptyList(),
    onToggleLocal: (String) -> Unit = {},
    colors: Map<String, String>,
    onFolderColor: (String, String?) -> Unit,
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
    Column(modifier.background(MaterialTheme.colorScheme.surface)) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(
                    start = ch.fasrv.fanotes.desk.SIDEBAR_HEADER_PAD_X_DP.dp,
                    end = ch.fasrv.fanotes.desk.SIDEBAR_HEADER_PAD_X_DP.dp,
                    top = ch.fasrv.fanotes.desk.SIDEBAR_HEADER_PAD_TOP_DP.dp,
                    bottom = ch.fasrv.fanotes.desk.SIDEBAR_HEADER_PAD_BOTTOM_DP.dp,
                ),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SIDEBAR_HEADER_GAP_DP.dp),
        ) {
            Text(
                vaultLabel,
                modifier = Modifier
                    .weight(1f)
                    .padding(
                        horizontal = ch.fasrv.fanotes.desk.SIDEBAR_VAULT_PAD_X_DP.dp,
                        vertical = ch.fasrv.fanotes.desk.SIDEBAR_VAULT_PAD_Y_DP.dp,
                    ),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                fontSize = ch.fasrv.fanotes.desk.SIDEBAR_VAULT_SP.sp,
                fontWeight = FontWeight(ch.fasrv.fanotes.desk.SIDEBAR_VAULT_WEIGHT),
                letterSpacing = ch.fasrv.fanotes.desk.SIDEBAR_VAULT_TRACKING.em,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SIDEBAR_ACTION_GAP_DP.dp)) {
                SidebarIconButton("Neue Notiz", onCreateNote) {
                    Icon(Icons.AutoMirrored.Filled.NoteAdd, contentDescription = null, modifier = Modifier.size(ch.fasrv.fanotes.desk.SIDEBAR_ACTION_ICON_DP.dp))
                }
                SidebarIconButton("Neuer Ordner", onCreateFolder) {
                    Icon(Icons.Filled.CreateNewFolder, contentDescription = null, modifier = Modifier.size(ch.fasrv.fanotes.desk.SIDEBAR_ACTION_ICON_DP.dp))
                }
                SidebarLabelButton("PDF", onImportPdf, wide = true)
                SidebarIconButton("Seitenleiste einklappen", onCollapse) {
                    Icon(Icons.Filled.Menu, contentDescription = null, modifier = Modifier.size(ch.fasrv.fanotes.desk.SIDEBAR_ACTION_ICON_DP.dp))
                }
            }
        }
        SidebarSearchField(searchQuery, onSearchQuery, onOpenSearch)
        Row(
            Modifier
                .padding(horizontal = ch.fasrv.fanotes.desk.SIDEBAR_HEADER_PAD_X_DP.dp)
                .padding(bottom = ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_MARGIN_BOTTOM_DP.dp),
            horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SIDEBAR_ACTION_GAP_DP.dp),
        ) {
            SidebarLabelButton("Sync", onSync, description = syncLabel.ifBlank { "Sync" })
            SidebarLabelButton("Bild", onImportImage)
            SidebarLabelButton("Blatt", onImportSheet)
        }
        if (conflicts.isNotEmpty()) {
            Text("Konflikte", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(start = 12.dp, top = 8.dp, end = 12.dp))
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
            FlowRow(
                Modifier
                    .fillMaxWidth()
                    .padding(
                        start = ch.fasrv.fanotes.desk.TAG_FILTER_PAD_X_DP.dp,
                        end = ch.fasrv.fanotes.desk.TAG_FILTER_PAD_X_DP.dp,
                        top = ch.fasrv.fanotes.desk.TAG_FILTER_PAD_TOP_DP.dp,
                    ),
                horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.TAG_FILTER_GAP_DP.dp),
                verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.TAG_FILTER_GAP_DP.dp),
            ) {
                tags.forEach { tag ->
                    TagFilterChip("#$tag", tag == tagFilter) { onToggleTag(tag) }
                }
                if (tagFilter != null) {
                    TagFilterChip("Filter aus", false) { onToggleTag(tagFilter) }
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
        if (tree.isEmpty()) {
            Column(
                Modifier.weight(1f).fillMaxWidth().padding(top = 28.dp, start = ch.fasrv.fanotes.desk.TREE_WRAP_PAD_X_DP.dp, end = ch.fasrv.fanotes.desk.TREE_WRAP_PAD_X_DP.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    ch.fasrv.fanotes.desk.EMPTY_VAULT_MESSAGE,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                )
                TextButton(onClick = onCreateNote) { Text(ch.fasrv.fanotes.desk.EMPTY_VAULT_ACTION) }
            }
        } else LazyColumn(
            Modifier
                .weight(1f)
                .padding(
                    start = ch.fasrv.fanotes.desk.TREE_WRAP_PAD_X_DP.dp,
                    end = ch.fasrv.fanotes.desk.TREE_WRAP_PAD_X_DP.dp,
                    top = ch.fasrv.fanotes.desk.TREE_WRAP_PAD_TOP_DP.dp,
                    bottom = ch.fasrv.fanotes.desk.TREE_WRAP_PAD_BOTTOM_DP.dp,
                )
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
                    node, selected, splitPath, treeFocus, colors, expanded, onOpen, onDelete, onRename, renamingPath, onCommitRename, onCancelRename, onMove, onFolderColor, onToggleFolder, onOpenSplit,
                    onCreateNoteIn, onCreateFolderIn, bookFolders, onImportPdfIn, onImportBook, onDetachBook,
                    {
                        treeFocus = it
                        runCatching { treeFocusRequester.requestFocus() }
                    },
                    localFolders, onToggleLocal, compact, rowHeightDp, radiusDp,
                    dragPath = dragPath,
                    dropDest = dropDest,
                    onRowBounds = { box -> rowBounds[node.path] = box },
                    onEmptyBounds = { path, box ->
                        val key = "\u0000empty:$path"
                        if (box == null) rowBounds.remove(key) else rowBounds[key] = box
                    },
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
        Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)),
        )
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = ch.fasrv.fanotes.desk.SIDEBAR_FOOTER_DP.dp)
                .padding(
                    horizontal = ch.fasrv.fanotes.desk.SIDEBAR_FOOTER_PAD_X_DP.dp,
                    vertical = ch.fasrv.fanotes.desk.SIDEBAR_FOOTER_PAD_Y_DP.dp,
                ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                ch.fasrv.fanotes.desk.sidebarFileLabel(ch.fasrv.fanotes.desk.sidebarFileCount(tree)),
                fontSize = 12.sp,
                color = LocalStatusInk.current.muted,
            )
        }
    }
}

@Composable
private fun TreeMenuLabel(label: String) {
    Text(
        label.uppercase(java.util.Locale.GERMAN),
        fontSize = 12.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = 0.09.em,
        color = LocalStatusInk.current.muted,
        modifier = Modifier.padding(start = 8.dp, top = 5.dp, end = 8.dp, bottom = 3.dp),
    )
}

@Composable
private fun treeMenuImage(id: String) = when (id) {
    "plus" -> Icons.Filled.Add
    "file" -> Icons.AutoMirrored.Filled.InsertDriveFile
    "file-text" -> Icons.Filled.Description
    "close" -> Icons.Filled.Close
    "folder-plus" -> Icons.Filled.CreateNewFolder
    "columns" -> Icons.Filled.ViewColumn
    "pencil" -> Icons.Filled.Edit
    "move" -> Icons.AutoMirrored.Filled.DriveFileMove
    "trash" -> Icons.Filled.Delete
    else -> Icons.Filled.Folder
}

@Composable
private fun TreeMenuItem(label: String, danger: Boolean = false, onClick: () -> Unit) {
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    val tint = if (danger) MaterialTheme.colorScheme.error else accent
    Row(
        Modifier
            .fillMaxWidth()
            .height(ch.fasrv.fanotes.desk.TREE_MENU_ROW_DP.dp)
            .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.TREE_MENU_ROW_RADIUS_DP.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.TREE_MENU_ICON_GAP_DP.dp),
    ) {
        Icon(
            treeMenuImage(ch.fasrv.fanotes.desk.treeMenuIcon(label)),
            contentDescription = null,
            modifier = Modifier.size(ch.fasrv.fanotes.desk.TREE_MENU_ICON_DP.dp),
            tint = tint,
        )
        Text(
            label,
            fontSize = 12.sp,
            color = if (danger) MaterialTheme.colorScheme.error else LocalStatusInk.current.soft,
        )
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
    renamingPath: String? = null,
    onCommitRename: (String, String) -> Unit = { _, _ -> },
    onCancelRename: () -> Unit = {},
    onMove: (String) -> Unit,
    onFolderColor: (String, String?) -> Unit,
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
    onEmptyBounds: (String, TreeRowBox?) -> Unit,
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
    val treeShape = RoundedCornerShape(ch.fasrv.fanotes.desk.TREE_ROW_RADIUS_DP.dp)
    val inSplit = splitPath != null && node.path == splitPath && node.path != selected
    val rowInteraction = remember(node.path) { MutableInteractionSource() }
    val rowHovered by rowInteraction.collectIsHoveredAsState()
    val actionsOpen = ch.fasrv.fanotes.desk.treeRowShowsActions(rowHovered, node.path == treeFocus)
    val accentHex = "#%06x".format(MaterialTheme.colorScheme.primary.toArgb() and 0xFFFFFF)
    val textHex = "#%06x".format(MaterialTheme.colorScheme.onSurface.toArgb() and 0xFFFFFF)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = (depth * ch.fasrv.fanotes.desk.TREE_DEPTH_DP).dp)
            .height(ch.fasrv.fanotes.desk.chromeRowHeightDp(compact, rowHeightDp).dp)
            .alpha(if (dragging) ch.fasrv.fanotes.desk.TREE_DRAG_ALPHA else 1f)
            .hoverable(rowInteraction)
            .border(
                if (dropHere || node.path == treeFocus) 1.dp else 0.dp,
                if (dropHere) MaterialTheme.colorScheme.primary.copy(alpha = ch.fasrv.fanotes.desk.TREE_DROP_BORDER_ALPHA)
                else MaterialTheme.colorScheme.primary,
                treeShape,
            )
            .clip(treeShape)
            .then(
                when {
                    dropHere -> Modifier.background(
                        MaterialTheme.colorScheme.primary.copy(alpha = ch.fasrv.fanotes.desk.TREE_DROP_ALPHA),
                    )
                    node.path == selected -> Modifier.background(LocalStatusInk.current.panelActive)
                    rowHovered -> Modifier.background(
                        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = ch.fasrv.fanotes.desk.treeHoverAlpha(folder)),
                    )
                    else -> Modifier
                },
            )
            .onGloballyPositioned {
                val bounds = it.boundsInRoot()
                onRowBounds(TreeRowBox(node.path, folder, TreeBox(bounds.left, bounds.top, bounds.right, bounds.bottom)))
            }
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (ch.fasrv.fanotes.desk.treeRowShowsMark() && (node.path == selected || inSplit)) {
            Box(
                Modifier
                    .padding(end = 4.dp)
                    .width(ch.fasrv.fanotes.desk.TREE_MARK_WIDTH_DP.dp)
                    .height(ch.fasrv.fanotes.desk.TREE_MARK_HEIGHT_DP.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(
                        if (node.path == selected) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.primary.copy(alpha = ch.fasrv.fanotes.desk.TREE_SPLIT_MARK_ALPHA),
                    ),
            )
        }
        Text(
            if (!folder) "" else if (openFolder) "▾" else "▸",
            fontSize = 12.sp,
            color = LocalStatusInk.current.muted,
            modifier = Modifier.width(ch.fasrv.fanotes.desk.TREE_CHEVRON_DP.dp).clickable {
                onTreeFocus(node.path)
                if (folder) onToggleFolder(node.path) else onOpen(node.path)
            },
        )
        if (folder) {
            var colorMenu by remember(node.path) { mutableStateOf(false) }
            Box {
                Icon(
                    Icons.Filled.Folder,
                    contentDescription = "Ordnerfarbe",
                    tint = Color(
                        android.graphics.Color.parseColor(
                            ch.fasrv.fanotes.desk.folderIconInk(folderColor, accentHex, textHex),
                        ),
                    ),
                    modifier = Modifier
                        .size(ch.fasrv.fanotes.desk.TREE_ICON_DP.dp)
                        .clickable(onClickLabel = "Ordnerfarbe wählen") { colorMenu = true },
                )
                DropdownMenu(expanded = colorMenu, onDismissRequest = { colorMenu = false }) {
                    Text(
                        ch.fasrv.fanotes.desk.FOLDER_COLOR_MENU,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                    FlowRow(
                        Modifier.width(196.dp).padding(horizontal = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        ch.fasrv.fanotes.desk.FOLDER_COLOR_CHOICES.forEach { color ->
                            val selectedColor = folderColor == color
                            Box(
                                Modifier
                                    .size(22.dp)
                                    .clip(CircleShape)
                                    .background(Color(android.graphics.Color.parseColor(color)))
                                    .clickable(onClickLabel = "Ordnerfarbe $color") {
                                        onFolderColor(node.path, color)
                                        colorMenu = false
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                if (selectedColor) {
                                    Text("✓", fontSize = 12.sp, color = Color(android.graphics.Color.parseColor(ch.fasrv.fanotes.desk.accentInk(color))))
                                }
                            }
                        }
                    }
                    TextButton(onClick = {
                        onFolderColor(node.path, null)
                        colorMenu = false
                    }) { Text(ch.fasrv.fanotes.desk.FOLDER_COLOR_CLEAR) }
                }
            }
        } else {
            Icon(
                when (node.kind) {
                    NoteKind.PDF -> Icons.Filled.PictureAsPdf
                    else -> Icons.Filled.Description
                },
                contentDescription = null,
                tint = LocalStatusInk.current.muted,
                modifier = Modifier.size(ch.fasrv.fanotes.desk.TREE_ICON_DP.dp),
            )
        }
        val nameInk = when {
            folder -> Color(
                android.graphics.Color.parseColor(
                    ch.fasrv.fanotes.desk.folderNameInk(
                        folderColor,
                        "#%06x".format(MaterialTheme.colorScheme.primary.toArgb() and 0xFFFFFF),
                        "#%06x".format(MaterialTheme.colorScheme.onSurface.toArgb() and 0xFFFFFF),
                    ),
                ),
            )
            ch.fasrv.fanotes.desk.rowIsSplitCompanion(node.path, selected, splitPath) ->
                LocalStatusInk.current.soft
            else -> MaterialTheme.colorScheme.onSurface
        }
        if (renamingPath == node.path) {
            var draft by remember(node.path, node.name) { mutableStateOf(node.name) }
            var canceling by remember(node.path) { mutableStateOf(false) }
            val renameFocus = remember(node.path) { FocusRequester() }
            fun finish() {
                if (canceling) return
                val next = ch.fasrv.fanotes.desk.treeRenameCommit(node.name, draft)
                if (next == null) onCancelRename() else onCommitRename(node.path, next)
            }
            LaunchedEffect(node.path) { runCatching { renameFocus.requestFocus() } }
            BasicTextField(
                value = draft,
                onValueChange = { draft = it },
                singleLine = true,
                textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = ch.fasrv.fanotes.desk.TREE_RENAME_SP.sp),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { finish() }),
                modifier = Modifier
                    .weight(1f)
                    .padding(start = 8.dp)
                    .height(ch.fasrv.fanotes.desk.TREE_RENAME_DP.dp)
                    .focusRequester(renameFocus)
                    .onFocusChanged { if (!it.isFocused) finish() }
                    .onPreviewKeyEvent { event ->
                        if (event.type == KeyEventType.KeyDown && event.key == Key.Escape) {
                            canceling = true
                            onCancelRename()
                            true
                        } else false
                    }
                    .border(2.dp, MaterialTheme.colorScheme.primary.copy(alpha = ch.fasrv.fanotes.desk.TREE_RENAME_RING), RoundedCornerShape(ch.fasrv.fanotes.desk.TREE_RENAME_RADIUS_DP.dp))
                    .padding(1.dp)
                    .border(1.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(ch.fasrv.fanotes.desk.TREE_RENAME_RADIUS_DP.dp))
                    .background(MaterialTheme.colorScheme.background)
                    .padding(horizontal = ch.fasrv.fanotes.desk.TREE_RENAME_PAD_DP.dp),
            )
            Icon(
                Icons.Filled.Check,
                contentDescription = "Namen übernehmen",
                modifier = Modifier.size(ch.fasrv.fanotes.desk.TREE_RENAME_ACTION_DP.dp).clickable { finish() },
                tint = LocalStatusInk.current.muted,
            )
            Icon(
                Icons.Filled.Close,
                contentDescription = "Umbenennen abbrechen",
                modifier = Modifier.size(ch.fasrv.fanotes.desk.TREE_RENAME_ACTION_DP.dp).clickable {
                    canceling = true
                    onCancelRename()
                },
                tint = LocalStatusInk.current.muted,
            )
        } else Text(
            node.name,
            maxLines = 1,
            fontSize = ch.fasrv.fanotes.desk.TREE_LABEL_SP.sp,
            fontWeight = if (folder) androidx.compose.ui.text.font.FontWeight(ch.fasrv.fanotes.desk.FOLDER_NAME_WEIGHT) else FontWeight.Normal,
            color = nameInk,
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
        if (ch.fasrv.fanotes.desk.treeFolderShowsDot(folder, actionsOpen)) {
            Box(
                Modifier
                    .padding(end = ch.fasrv.fanotes.desk.TREE_FOLDER_DOT_INSET_DP.dp)
                    .size(ch.fasrv.fanotes.desk.TREE_FOLDER_DOT_DP.dp)
                    .clip(CircleShape)
                    .background(
                        Color(
                            android.graphics.Color.parseColor(
                                ch.fasrv.fanotes.desk.folderDotInk(folderColor, accentHex),
                            ),
                        ).copy(alpha = ch.fasrv.fanotes.desk.TREE_FOLDER_DOT_ALPHA),
                    ),
            )
        }
        if (actionsOpen) {
            var menu by remember(node.path) { mutableStateOf(false) }
            val local = pathIsSyncExcluded(node.path, localFolders)
            Box {
                Icon(
                    Icons.Filled.MoreVert,
                    contentDescription = "Aktionen für ${node.name}",
                    tint = LocalStatusInk.current.muted,
                    modifier = Modifier.size(22.dp).clickable { menu = true },
                )
                DropdownMenu(
                    expanded = menu,
                    onDismissRequest = { menu = false },
                    modifier = Modifier.width(ch.fasrv.fanotes.desk.TREE_MENU_WIDTH_DP.dp),
                    shape = RoundedCornerShape(ch.fasrv.fanotes.desk.TREE_MENU_RADIUS_DP.dp),
                    containerColor = LocalStatusInk.current.panelStrong,
                    tonalElevation = 0.dp,
                    shadowElevation = 20.dp,
                    border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)),
                ) {
                    Column(Modifier.padding(ch.fasrv.fanotes.desk.TREE_MENU_PAD_DP.dp)) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.TREE_MENU_HEAD_GAP_DP.dp),
                            modifier = Modifier.padding(start = 5.dp, end = 5.dp, top = 3.dp, bottom = 8.dp),
                        ) {
                            val headAccent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
                            val headTint = folderColor?.let { runCatching { Color(android.graphics.Color.parseColor(it)) }.getOrNull() } ?: headAccent
                            Box(
                                Modifier
                                    .size(ch.fasrv.fanotes.desk.TREE_MENU_HEAD_DP.dp)
                                    .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.TREE_MENU_HEAD_RADIUS_DP.dp))
                                    .background(LocalStatusInk.current.panelActive),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    treeMenuImage(ch.fasrv.fanotes.desk.treeMenuHeadIcon(folder, node.kind == NoteKind.PDF)),
                                    contentDescription = null,
                                    modifier = Modifier.size(ch.fasrv.fanotes.desk.TREE_MENU_HEAD_ICON_DP.dp),
                                    tint = if (folder) headTint else headAccent,
                                )
                            }
                            Column(Modifier.weight(1f)) {
                                Text(
                                    ch.fasrv.fanotes.desk.treeMenuKind(folder, node.kind == NoteKind.PDF).uppercase(java.util.Locale.GERMAN),
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight(750),
                                    letterSpacing = 0.07.em,
                                    color = LocalStatusInk.current.muted,
                                )
                                Text(node.name, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface)
                            }
                        }
                        Box(Modifier.fillMaxWidth().height(1.dp).background(MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)))
                        if (folder) {
                            TreeMenuLabel(ch.fasrv.fanotes.desk.TREE_MENU_CREATE)
                            TreeMenuItem(ch.fasrv.fanotes.desk.TREE_MENU_NOTE) { menu = false; onCreateNoteIn(node.path) }
                            TreeMenuItem(ch.fasrv.fanotes.desk.TREE_MENU_PDF) { menu = false; onImportPdfIn(node.path) }
                            TreeMenuItem(ch.fasrv.fanotes.desk.TREE_MENU_BOOK) { menu = false; onImportBook(node.path) }
                            if (node.path in bookFolders) TreeMenuItem(ch.fasrv.fanotes.desk.TREE_MENU_DETACH, danger = true) { menu = false; onDetachBook(node.path) }
                            TreeMenuItem(localFolderAction(local)) { menu = false; onToggleLocal(node.path) }
                            TreeMenuItem(ch.fasrv.fanotes.desk.TREE_MENU_SUBFOLDER) { menu = false; onCreateFolderIn(node.path) }
                        } else {
                            TreeMenuLabel(ch.fasrv.fanotes.desk.TREE_MENU_OPEN)
                            TreeMenuItem(ch.fasrv.fanotes.desk.TREE_MENU_SPLIT) { menu = false; onOpenSplit(node.path) }
                        }
                        TreeMenuLabel(ch.fasrv.fanotes.desk.TREE_MENU_MANAGE)
                        TreeMenuItem(ch.fasrv.fanotes.desk.TREE_MENU_RENAME) { menu = false; onRename(node.path, node.name) }
                        TreeMenuItem(ch.fasrv.fanotes.desk.TREE_MENU_MOVE) { menu = false; onMove(node.path) }
                        TreeMenuItem(ch.fasrv.fanotes.desk.TREE_MENU_DELETE, danger = true) { menu = false; onDelete(node.path, folder, node.name) }
                    }
                }
            }
        }
    }
    if (openFolder && node.children.isEmpty()) {
        val actionInteraction = remember(node.path) { androidx.compose.foundation.interaction.MutableInteractionSource() }
        val actionHot by actionInteraction.collectIsHoveredAsState()
        val actionPressed by actionInteraction.collectIsPressedAsState()
        val actionActive = actionHot || actionPressed
        androidx.compose.runtime.DisposableEffect(node.path) {
            onDispose { onEmptyBounds(node.path, null) }
        }
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = ch.fasrv.fanotes.desk.TREE_EMPTY_MIN_DP.dp)
                .then(
                    if (dropHere) {
                        Modifier.border(
                            1.dp,
                            MaterialTheme.colorScheme.primary.copy(alpha = ch.fasrv.fanotes.desk.TREE_DROP_BORDER_ALPHA),
                        )
                    } else {
                        Modifier
                    },
                )
                .background(
                    if (dropHere) MaterialTheme.colorScheme.primary.copy(alpha = ch.fasrv.fanotes.desk.TREE_DROP_ALPHA)
                    else Color.Transparent,
                )
                .onGloballyPositioned {
                    val bounds = it.boundsInRoot()
                    onEmptyBounds(
                        node.path,
                        TreeRowBox(node.path, true, TreeBox(bounds.left, bounds.top, bounds.right, bounds.bottom)),
                    )
                }
                .padding(start = ch.fasrv.fanotes.desk.treeEmptyIndentDp(depth).dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.TREE_EMPTY_GAP_DP.dp),
        ) {
            Text(
                "Leer",
                fontSize = 12.sp,
                fontStyle = FontStyle.Italic,
                color = LocalStatusInk.current.muted,
            )
            Box(
                Modifier
                    .height(ch.fasrv.fanotes.desk.TREE_EMPTY_ACTION_DP.dp)
                    .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.TREE_EMPTY_ACTION_RADIUS_DP.dp))
                    .background(if (actionActive) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
                    .clickable(
                        interactionSource = actionInteraction,
                        indication = null,
                        onClickLabel = "Unterordner anlegen",
                    ) { onCreateFolderIn(node.path) }
                    .padding(horizontal = ch.fasrv.fanotes.desk.TREE_EMPTY_ACTION_PAD_DP.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "Unterordner anlegen",
                    fontSize = 12.sp,
                    fontStyle = FontStyle.Normal,
                    color = if (actionActive) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.soft,
                )
            }
        }
    }
    if (openFolder) {
        node.children.forEach {
            NoteRow(
                it, selected, splitPath, treeFocus, colors, expanded, onOpen, onDelete, onRename, renamingPath, onCommitRename, onCancelRename, onMove, onFolderColor, onToggleFolder, onOpenSplit,
                onCreateNoteIn, onCreateFolderIn, bookFolders, onImportPdfIn, onImportBook, onDetachBook,
                onTreeFocus,
                localFolders, onToggleLocal, compact, rowHeightDp, radiusDp,
                dragPath = dragPath,
                dropDest = dropDest,
                onRowBounds = onRowBounds,
                onEmptyBounds = onEmptyBounds,
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
            .semantics { contentDescription = "Teilung anpassen" }
            .focusable()
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val name = when (event.key) {
                    Key.DirectionLeft -> "left"
                    Key.DirectionRight -> "right"
                    Key.DirectionUp -> "up"
                    Key.DirectionDown -> "down"
                    Key.MoveHome -> "home"
                    Key.MoveEnd -> "end"
                    Key.Enter, Key.NumPadEnter -> "enter"
                    else -> return@onPreviewKeyEvent false
                }
                val next = ch.fasrv.fanotes.desk.splitDividerRatio(rows, name, ratioNow.value) ?: return@onPreviewKeyEvent false
                liveChange.value(next)
                commitChange.value()
                true
            }
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
    val splitImages by model.splitPaperImages.collectAsStateWithLifecycle()
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
                view.onFollowMarkdown = { target, web, anchor ->
                    openFollowedLink(view.context, model, target, web, anchor)
                }
                if (view.paperImages !== splitImages) view.paperImages = splitImages
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
                    if (editor.paperImages !== splitImages) editor.paperImages = splitImages
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
private fun EmptyEditor(
    onCreate: () -> Unit,
    onPdf: () -> Unit,
    onSheet: () -> Unit,
    onPalette: () -> Unit,
    modifier: Modifier,
) {
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    val ink = LocalStatusInk.current
    Box(modifier, contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = ch.fasrv.fanotes.desk.PLACEHOLDER_MAX_DP.dp).padding(ch.fasrv.fanotes.desk.PLACEHOLDER_PAD_DP.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(
                Modifier.size(ch.fasrv.fanotes.desk.PLACEHOLDER_GLYPH_DP.dp).clip(RoundedCornerShape(ch.fasrv.fanotes.desk.PLACEHOLDER_GLYPH_RADIUS_DP.dp)).background(MaterialTheme.colorScheme.onSurface),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.AutoMirrored.Filled.MenuBook, contentDescription = null, modifier = Modifier.size(ch.fasrv.fanotes.desk.PLACEHOLDER_GLYPH_ICON_DP.dp), tint = MaterialTheme.colorScheme.background)
            }
            Text(
                ch.fasrv.fanotes.desk.PLACEHOLDER_EYEBROW.uppercase(java.util.Locale.GERMAN),
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 0.08.em,
                color = accent,
                modifier = Modifier.padding(top = 20.dp, bottom = 7.dp),
            )
            Text(
                ch.fasrv.fanotes.desk.PLACEHOLDER_TITLE,
                fontSize = ch.fasrv.fanotes.desk.PLACEHOLDER_TITLE_SP.sp,
                letterSpacing = (-0.03).em,
                color = MaterialTheme.colorScheme.onSurface,
                textAlign = TextAlign.Center,
            )
            Text(
                ch.fasrv.fanotes.desk.PLACEHOLDER_BODY,
                fontSize = ch.fasrv.fanotes.desk.PLACEHOLDER_BODY_SP.sp,
                lineHeight = 21.sp,
                color = ink.muted,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 8.dp, bottom = 20.dp),
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                EmptyEditorButton(ch.fasrv.fanotes.desk.PLACEHOLDER_NOTE, Icons.AutoMirrored.Filled.NoteAdd, primary = true, onClick = onCreate)
                EmptyEditorButton(ch.fasrv.fanotes.desk.PLACEHOLDER_PDF, Icons.Filled.Description, primary = false, onClick = onPdf)
                EmptyEditorButton(ch.fasrv.fanotes.desk.PLACEHOLDER_SHEET, Icons.Filled.FileUpload, primary = false, onClick = onSheet)
            }
            Row(
                Modifier.padding(top = 16.dp).clip(RoundedCornerShape(7.dp)).clickable(onClick = onPalette).padding(horizontal = 7.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Icons.Filled.Search, contentDescription = null, modifier = Modifier.size(13.dp), tint = ink.muted)
                Text(ch.fasrv.fanotes.desk.PLACEHOLDER_COMMAND, fontSize = 12.sp, color = ink.muted)
            }
        }
    }
}

@Composable
private fun EmptyEditorButton(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    primary: Boolean,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(6.dp)
    val fill = if (primary) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.panelStrong
    val ink = if (primary) MaterialTheme.colorScheme.background else LocalStatusInk.current.soft
    val border = if (primary) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)
    Row(
        Modifier.height(31.dp).clip(shape).background(fill).border(1.dp, border, shape).clickable(onClick = onClick).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(14.dp), tint = ink)
        Text(label, fontSize = 12.sp, fontWeight = FontWeight.Medium, color = ink)
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
    editingBox: String?,
    onCloseBox: () -> Unit,
    onMath: () -> Unit,
    modifier: Modifier,
    showRelations: Boolean = true,
    onExportPdf: () -> Unit = {},
    onImportSheet: () -> Unit = {},
    onImportPdf: () -> Unit = {},
    onCreateNote: () -> Unit = {},
    onPalette: () -> Unit = {},
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
                PdfNoteToolbar(model)
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
        if (path == null) {
            EmptyEditor(onCreateNote, onImportPdf, onImportSheet, onPalette, Modifier.weight(1f).fillMaxWidth())
            return@Column
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
        theme = model.effectiveDesk()["theme"].orEmpty(),
        systemDark = isSystemInDarkTheme(),
        onSync = onSync,
        onToggleRail = onToggleRail,
        onEditBox = onEditBox,
        editingBox = editingBox,
        onCloseBox = onCloseBox,
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
    theme: String,
    systemDark: Boolean,
    onSync: () -> Unit,
    onToggleRail: () -> Unit,
    onEditBox: (String) -> Unit,
    editingBox: String?,
    onCloseBox: () -> Unit,
    onMath: () -> Unit,
        onDeskShortcut: (String) -> Unit,
        modifier: Modifier,
) {
    var bound by remember { mutableStateOf("") }
    var inkNotice by remember { mutableStateOf<ch.fasrv.fanotes.ink.InkNotice?>(null) }
    val links by model.noteLinks.collectAsStateWithLifecycle()
    val paperImages by model.paperImages.collectAsStateWithLifecycle()
    val boxes by model.worksheetBoxes.collectAsStateWithLifecycle()
    val highlights by model.worksheetHighlights.collectAsStateWithLifecycle()
    val outlineJump by model.outlineJump.collectAsStateWithLifecycle()
    val gotoLineInput by model.gotoLineInput.collectAsStateWithLifecycle()
    val foldedHeadings by model.foldedHeadings.collectAsStateWithLifecycle()
    val clearLink by model.clearLinkRequest.collectAsStateWithLifecycle()
    val placeLinkRequest by model.placeLinkRequest.collectAsStateWithLifecycle()
    val pdfCamera by model.pdfCameraCommand.collectAsStateWithLifecycle()
    val sheetReset by model.sheetReset.collectAsStateWithLifecycle()
    var appliedClear by remember { mutableStateOf(0) }
    var appliedPlaceLink by remember { mutableStateOf(0) }
    var appliedPdfCamera by remember { mutableStateOf(0) }
    var appliedSheetReset by remember { mutableStateOf(0) }
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
                ink.onDismissInkNotice = { inkNotice = null }
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
            page.ink.onDismissInkNotice = { inkNotice = null }
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
            if (page.ink.paperImages !== paperImages) page.ink.paperImages = paperImages
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
            page.pdfNote = model.open.value?.kind == NoteKind.PDF
            page.onPdfKey = { action ->
                when (action) {
                    "next" -> model.goToPdfPage(model.pdfThumbPage.value + 1)
                    "previous" -> model.goToPdfPage(model.pdfThumbPage.value - 1)
                    "first" -> model.goToPdfPage(1)
                    "last" -> model.goToPdfPage(Int.MAX_VALUE)
                    "search" -> model.focusPdfSearch()
                }
            }
            page.onPdfPage = { model.notePdfPage(it) }
            page.ink.onPdfZoom = { zoom, zoomMode -> model.notePdfZoom(zoom, zoomMode) }
            page.ink.onSheetActive = { model.noteSheetAdjusted(it) }
            if (sheetReset != appliedSheetReset) {
                appliedSheetReset = sheetReset
                if (sheetReset > 0) page.ink.resetView()
            }
            val camera = pdfCamera
            if (camera != null && camera.first != appliedPdfCamera) {
                appliedPdfCamera = camera.first
                page.ink.applyPdfCamera(camera.second)
            }
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
            page.onWorksheetBoxText = { id, text -> model.updateWorksheetBox(id, text) }
            page.onWorksheetBoxRemove = { id ->
                model.removeWorksheetBox(id)
                onCloseBox()
            }
            page.onWorksheetBoxClosed = onCloseBox
            page.syncWorksheetField(editingBox)
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
                theme = theme,
                systemDark = systemDark,
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
private fun SyncDialog(model: FaNotesViewModel, onDismiss: () -> Unit) {
    var register by remember { mutableStateOf(false) }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val scrim = remember { MutableInteractionSource() }
        val card = remember { MutableInteractionSource() }
        val shape = RoundedCornerShape(12.dp)
        val strong = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)
        Box(
            Modifier.fillMaxSize().background(Color(ch.fasrv.fanotes.desk.PALETTE_SCRIM)).clickable(interactionSource = scrim, indication = null, onClick = onDismiss),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                Modifier.widthIn(max = 560.dp).fillMaxWidth(0.92f).heightIn(max = 640.dp).clickable(interactionSource = card, indication = null, onClick = {}).clip(shape).border(1.dp, strong, shape).background(LocalStatusInk.current.panelStrong).verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(if (register) ch.fasrv.fanotes.sync.SYNC_ACCOUNT_REGISTER else ch.fasrv.fanotes.sync.SYNC_ACCOUNT_LOGIN, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    SyncModeSwitch(register) { register = it }
                }
                SyncSignInFields(model, register)
            }
        }
    }
}

@Composable
private fun WorksheetImportDialog(
    noteTitle: String?,
    onCurrent: () -> Unit,
    onNew: () -> Unit,
    onDismiss: () -> Unit,
) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val scrim = remember { MutableInteractionSource() }
        val card = remember { MutableInteractionSource() }
        val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.SHEET_IMPORT_RADIUS_DP.dp)
        val strong = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)
        val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
        val ink = LocalStatusInk.current
        val screen = LocalConfiguration.current
        val shadow = ch.fasrv.fanotes.desk.sheetImportShadow(MaterialTheme.colorScheme.background.luminance() < 0.5f)
        val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
        val stacked = ch.fasrv.fanotes.desk.sheetImportColumns(screen.screenWidthDp) == 1
        Box(
            Modifier
                .fillMaxSize()
                .background(Color(ch.fasrv.fanotes.desk.PALETTE_SCRIM))
                .clickable(interactionSource = scrim, indication = null, onClick = onDismiss),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                Modifier
                    .fillMaxWidth(ch.fasrv.fanotes.desk.SHEET_IMPORT_WIDTH_FRACTION)
                    .widthIn(max = ch.fasrv.fanotes.desk.SHEET_IMPORT_MAX_DP.dp)
                    .clickable(interactionSource = card, indication = null, onClick = {})
                    .shadow(
                        elevation = shadow.yDp.dp,
                        shape = shape,
                        ambientColor = Color.Black.copy(alpha = shadow.alpha),
                        spotColor = Color.Black.copy(alpha = shadow.alpha),
                    )
                    .clip(shape)
                    .border(1.dp, strong, shape)
                    .background(MaterialTheme.colorScheme.surface),
            ) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .height(ch.fasrv.fanotes.desk.SHEET_IMPORT_HEADER_DP.dp)
                        .background(MaterialTheme.colorScheme.background)
                        .padding(horizontal = ch.fasrv.fanotes.desk.SHEET_IMPORT_HEADER_PAD_DP.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SHEET_IMPORT_HEADER_GAP_DP.dp),
                ) {
                    Box(
                        Modifier
                            .size(ch.fasrv.fanotes.desk.SHEET_IMPORT_MARK_DP.dp)
                            .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SHEET_IMPORT_MARK_RADIUS_DP.dp))
                            .background(MaterialTheme.colorScheme.onSurface),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Filled.FileUpload,
                            contentDescription = null,
                            modifier = Modifier.size(ch.fasrv.fanotes.desk.SHEET_IMPORT_MARK_ICON_DP.dp),
                            tint = MaterialTheme.colorScheme.background,
                        )
                    }
                    Column(Modifier.weight(1f)) {
                        Text(
                            ch.fasrv.fanotes.desk.SHEET_IMPORT_EYEBROW.uppercase(java.util.Locale.GERMAN),
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = 0.09.em,
                            color = accent,
                        )
                        Text(
                            ch.fasrv.fanotes.desk.SHEET_IMPORT_TITLE,
                            fontSize = 16.sp,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                    }
                    Box(
                        Modifier
                            .size(ch.fasrv.fanotes.desk.SHEET_IMPORT_CLOSE_DP.dp)
                            .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SHEET_IMPORT_CLOSE_RADIUS_DP.dp))
                            .clickable(onClick = onDismiss),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = "Schließen",
                            modifier = Modifier.size(ch.fasrv.fanotes.desk.SHEET_IMPORT_CLOSE_ICON_DP.dp),
                            tint = ink.muted,
                        )
                    }
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(rule))
                Text(
                    ch.fasrv.fanotes.desk.SHEET_IMPORT_BODY,
                    fontSize = 12.sp,
                    lineHeight = 19.sp,
                    color = ink.muted,
                    modifier = Modifier.padding(
                        start = ch.fasrv.fanotes.desk.SHEET_IMPORT_BODY_PAD_X_DP.dp,
                        end = ch.fasrv.fanotes.desk.SHEET_IMPORT_BODY_PAD_X_DP.dp,
                        top = ch.fasrv.fanotes.desk.SHEET_IMPORT_BODY_PAD_TOP_DP.dp,
                        bottom = ch.fasrv.fanotes.desk.SHEET_IMPORT_BODY_PAD_BOTTOM_DP.dp,
                    ),
                )
                Column(
                    Modifier.padding(
                        start = ch.fasrv.fanotes.desk.SHEET_IMPORT_BODY_PAD_X_DP.dp,
                        end = ch.fasrv.fanotes.desk.SHEET_IMPORT_BODY_PAD_X_DP.dp,
                        top = 4.dp,
                        bottom = 20.dp,
                    ),
                    verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SHEET_IMPORT_OPTION_GAP_DP.dp),
                ) {
                    if (stacked) {
                        SheetImportChoice(Icons.Filled.FileCopy, ch.fasrv.fanotes.desk.SHEET_IMPORT_CURRENT, noteTitle ?: ch.fasrv.fanotes.desk.SHEET_IMPORT_NONE, noteTitle != null, onCurrent)
                        SheetImportChoice(Icons.AutoMirrored.Filled.NoteAdd, ch.fasrv.fanotes.desk.SHEET_IMPORT_NEW, ch.fasrv.fanotes.desk.SHEET_IMPORT_NEW_DETAIL, true, onNew)
                    } else {
                        Row(horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SHEET_IMPORT_OPTION_GAP_DP.dp)) {
                            SheetImportChoice(Icons.Filled.FileCopy, ch.fasrv.fanotes.desk.SHEET_IMPORT_CURRENT, noteTitle ?: ch.fasrv.fanotes.desk.SHEET_IMPORT_NONE, noteTitle != null, onCurrent, Modifier.weight(1f))
                            SheetImportChoice(Icons.AutoMirrored.Filled.NoteAdd, ch.fasrv.fanotes.desk.SHEET_IMPORT_NEW, ch.fasrv.fanotes.desk.SHEET_IMPORT_NEW_DETAIL, true, onNew, Modifier.weight(1f))
                        }
                    }
                    SheetImportChoice(
                        Icons.AutoMirrored.Filled.MenuBook,
                        ch.fasrv.fanotes.desk.SHEET_IMPORT_ONENOTE,
                        ch.fasrv.fanotes.desk.SHEET_IMPORT_ONENOTE_DETAIL,
                        enabled = false,
                        onClick = {},
                        wide = true,
                    )
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(rule))
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = ch.fasrv.fanotes.desk.SHEET_IMPORT_FOOTER_DP.dp)
                        .padding(horizontal = ch.fasrv.fanotes.desk.SHEET_IMPORT_FOOTER_PAD_X_DP.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        ch.fasrv.fanotes.desk.SHEET_IMPORT_FORMATS,
                        fontSize = 12.sp,
                        color = ink.muted,
                        modifier = Modifier.weight(1f),
                    )
                    val buttonShape = RoundedCornerShape(ch.fasrv.fanotes.desk.SHEET_IMPORT_BUTTON_RADIUS_DP.dp)
                    Box(
                        Modifier
                            .height(ch.fasrv.fanotes.desk.SHEET_IMPORT_BUTTON_DP.dp)
                            .clip(buttonShape)
                            .background(ink.panelStrong)
                            .border(1.dp, strong, buttonShape)
                            .clickable(onClick = onDismiss)
                            .padding(horizontal = ch.fasrv.fanotes.desk.SHEET_IMPORT_BUTTON_PAD_DP.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            ch.fasrv.fanotes.desk.SHEET_IMPORT_CANCEL,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium,
                            color = ink.soft,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SheetImportChoice(
    icon: ImageVector,
    title: String,
    detail: String,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    wide: Boolean = false,
) {
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val hot = enabled && hovered
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.SHEET_IMPORT_OPTION_RADIUS_DP.dp)
    val border = if (hot) MaterialTheme.colorScheme.primary.copy(alpha = ch.fasrv.fanotes.desk.SHEET_IMPORT_HOVER_BORDER) else MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    val fill = if (hot) LocalStatusInk.current.panelActive else MaterialTheme.colorScheme.surface
    val frame = modifier
        .fillMaxWidth()
        .heightIn(min = (if (wide) ch.fasrv.fanotes.desk.SHEET_IMPORT_ONENOTE_MIN_DP else ch.fasrv.fanotes.desk.SHEET_IMPORT_OPTION_MIN_DP).dp)
        .alpha(if (enabled) 1f else ch.fasrv.fanotes.desk.SHEET_IMPORT_DISABLED_ALPHA)
        .clip(shape)
        .border(1.dp, border, shape)
        .background(fill)
        .hoverable(interaction)
        .clickable(interactionSource = interaction, indication = null, enabled = enabled, onClick = onClick)
        .padding(ch.fasrv.fanotes.desk.SHEET_IMPORT_OPTION_PAD_DP.dp)
    val glyph = @Composable {
        Box(
            Modifier
                .size(ch.fasrv.fanotes.desk.SHEET_IMPORT_OPTION_ICON_DP.dp)
                .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SHEET_IMPORT_OPTION_ICON_RADIUS_DP.dp))
                .background(MaterialTheme.colorScheme.primary.copy(alpha = ch.fasrv.fanotes.desk.SHEET_IMPORT_GLYPH_ALPHA)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(ch.fasrv.fanotes.desk.SHEET_IMPORT_OPTION_ICON_SIZE_DP.dp), tint = accent)
        }
    }
    val copy = @Composable {
        Text(title, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface)
        Text(detail, fontSize = 12.sp, color = LocalStatusInk.current.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
    }
    if (wide) {
        Row(frame, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SHEET_IMPORT_ONENOTE_GAP_DP.dp)) {
            glyph()
            Column(Modifier.weight(1f)) { copy() }
        }
    } else {
        Column(frame) {
            Box(Modifier.padding(bottom = 11.dp)) { glyph() }
            copy()
        }
    }
}

@Composable
private fun GotoLineDialog(onDone: (String?) -> Unit) {
    var value by remember { mutableStateOf("") }
    PromptCard("Gehe zu Zeile", onDismiss = { onDone(null) }, confirmLabel = ch.fasrv.fanotes.desk.PROMPT_GO, confirmEnabled = value.isNotBlank(), onConfirm = { onDone(value) }) {
        PromptField(value, { value = it }, ch.fasrv.fanotes.desk.GOTO_PLACEHOLDER, onDone = { if (value.isNotBlank()) onDone(value) })
    }
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
    PromptCard(title, onDismiss = { onDone(null) }, confirmLabel = confirm, confirmEnabled = name.isNotBlank(), onConfirm = { onDone(name) }) {
        PromptField(name, { name = it }, placeholder, onDone = { if (name.isNotBlank()) onDone(name) })
    }
}

@Composable
private fun PromptCard(
    title: String,
    onDismiss: () -> Unit,
    confirmLabel: String?,
    onConfirm: () -> Unit,
    confirmEnabled: Boolean = true,
    dismissLabel: String = ch.fasrv.fanotes.desk.PROMPT_CANCEL,
    content: @Composable () -> Unit,
) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val scrim = remember { MutableInteractionSource() }
        val card = remember { MutableInteractionSource() }
        val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.PROMPT_RADIUS_DP.dp)
        val screen = LocalConfiguration.current
        val shadow = ch.fasrv.fanotes.desk.calEditorShadow(MaterialTheme.colorScheme.background.luminance() < 0.5f)
        val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
        Box(
            Modifier.fillMaxSize().background(Color(ch.fasrv.fanotes.desk.PALETTE_SCRIM)).clickable(interactionSource = scrim, indication = null, onClick = onDismiss),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                Modifier
                    .padding(ch.fasrv.fanotes.desk.PROMPT_INSET_DP.dp)
                    .width(ch.fasrv.fanotes.desk.promptWidthDp(screen.screenWidthDp).dp)
                    .clickable(interactionSource = card, indication = null, onClick = {})
                    .shadow(shadow.yDp.dp, shape, ambientColor = Color.Black.copy(alpha = shadow.alpha), spotColor = Color.Black.copy(alpha = shadow.alpha))
                    .clip(shape)
                    .border(1.dp, rule, shape)
                    .background(LocalStatusInk.current.panelStrong)
                    .padding(ch.fasrv.fanotes.desk.PROMPT_PAD_DP.dp),
                verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.PROMPT_GAP_DP.dp),
            ) {
                Text(title, fontSize = ch.fasrv.fanotes.desk.PROMPT_TITLE_SP.sp, fontWeight = FontWeight(650), letterSpacing = (-0.02).em)
                content()
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                    PromptButton(dismissLabel, primary = false, onClick = onDismiss)
                    if (confirmLabel != null) PromptButton(confirmLabel, primary = true, enabled = confirmEnabled, onClick = onConfirm)
                }
            }
        }
    }
}

@Composable
private fun PromptField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    onDone: () -> Unit,
    singleLine: Boolean = true,
    minHeightDp: Int = 0,
    radiusDp: Int = ch.fasrv.fanotes.desk.PROMPT_FIELD_RADIUS_DP,
) {
    val shape = RoundedCornerShape(radiusDp.dp)
    val strong = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)
    BasicTextField(
        value = value,
        onValueChange = onChange,
        singleLine = singleLine,
        textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = 16.sp, lineHeight = 22.sp),
        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
        keyboardOptions = KeyboardOptions(imeAction = if (singleLine) ImeAction.Done else ImeAction.Default),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        modifier = Modifier.fillMaxWidth().heightIn(min = minHeightDp.dp),
        decorationBox = { inner ->
            Box(
                Modifier.fillMaxWidth().heightIn(min = minHeightDp.dp).border(1.dp, strong, shape).clip(shape).background(MaterialTheme.colorScheme.background).padding(horizontal = ch.fasrv.fanotes.desk.PROMPT_FIELD_PAD_X_DP.dp, vertical = ch.fasrv.fanotes.desk.PROMPT_FIELD_PAD_Y_DP.dp),
            ) {
                if (value.isEmpty()) Text(placeholder, fontSize = 16.sp, color = LocalStatusInk.current.muted)
                inner()
            }
        },
    )
}

@Composable
private fun PromptChoice(label: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.PROMPT_ROW_RADIUS_DP.dp)
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    Box(
        Modifier.fillMaxWidth().heightIn(min = ch.fasrv.fanotes.desk.PROMPT_ROW_DP.dp).clip(shape).border(1.dp, rule, shape).clickable(onClick = onClick).padding(horizontal = 10.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(label, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface)
    }
}

@Composable
private fun PromptButton(label: String, primary: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.PROMPT_BUTTON_RADIUS_DP.dp)
    val fill = if (primary) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.panelStrong
    val ink = if (primary) MaterialTheme.colorScheme.background else LocalStatusInk.current.soft
    val border = if (primary) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)
    Box(
        Modifier.height(ch.fasrv.fanotes.desk.PROMPT_BUTTON_DP.dp).alpha(if (enabled) 1f else 0.45f).clip(shape).background(fill).border(1.dp, border, shape).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, fontSize = 12.sp, fontWeight = FontWeight.Medium, color = ink)
    }
}

