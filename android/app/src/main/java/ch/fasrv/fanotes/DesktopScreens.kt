package ch.fasrv.fanotes

import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.requiredHeight
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Assignment
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.MenuBook
import androidx.compose.material.icons.filled.Accessibility
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Brush
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Alarm
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material.icons.filled.School
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Work
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Laptop
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Science
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Draw
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.PictureAsPdf
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.TextFields
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.material.icons.filled.ViewColumn
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.key
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.BaselineShift
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlin.math.abs
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import ch.fasrv.fanotes.desk.DeskTab
import ch.fasrv.fanotes.desk.measureDocument
import ch.fasrv.fanotes.desk.moveTab
import ch.fasrv.fanotes.desk.tabsToClose
import ch.fasrv.fanotes.desk.marginLinesFromTranscript
import ch.fasrv.fanotes.desk.readPdfMarks
import ch.fasrv.fanotes.desk.wikiTargets
import ch.fasrv.fanotes.desk.parseNoteTags
import ch.fasrv.fanotes.desk.Breadcrumb
import ch.fasrv.fanotes.desk.SwitcherNote
import ch.fasrv.fanotes.desk.dueCards
import ch.fasrv.fanotes.desk.fuzzyScore
import ch.fasrv.fanotes.desk.PendingConfirm
import ch.fasrv.fanotes.desk.confirmDialogKeyAction
import ch.fasrv.fanotes.desk.confirmDialogTabTarget
import ch.fasrv.fanotes.desk.CALENDAR_NOTE_PATH
import ch.fasrv.fanotes.desk.CalendarEvent
import ch.fasrv.fanotes.desk.LaidOutSpan
import ch.fasrv.fanotes.desk.allDaySpans
import ch.fasrv.fanotes.desk.calendarOccurrenceWindow
import ch.fasrv.fanotes.desk.dragCreateMinutes
import ch.fasrv.fanotes.desk.timedDayLayout
import ch.fasrv.fanotes.desk.parseNoteOutline
import ch.fasrv.fanotes.desk.taskLines
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.YearMonth
import kotlin.math.roundToInt

internal data class StatusInk(
    val muted: Color,
    val success: Color,
    val warning: Color,
    val soft: Color,
    val panelActive: Color,
    val panelStrong: Color,
)

internal val LocalStatusInk = staticCompositionLocalOf {
    StatusInk(Color(0xFF5E5C57), Color(0xFF1F7A48), Color(0xFF8A5A12), Color(0xFF4E4C47), Color(0xFFE3E2DE), Color(0xFFFFFFFF))
}

/** Resolved theme id from [ch.fasrv.fanotes.desk.themePalette], never the raw `system` token. */
internal val LocalDeskThemeId = staticCompositionLocalOf { "light" }

/** True when the settings viewport stacks each `.setting-row`. */
private val LocalSettingsContentStacks = staticCompositionLocalOf { false }

/** True when `.range-setting` is `width: 100%` at max-width 760px. The value box stays beside the track. */
private val LocalSettingsRangeFillsWidth = staticCompositionLocalOf { false }

/**
 * `.range-setting output` face. The settings page replaces this with the loaded
 * editor typeface. The fallback is the fenced-code monospace, not the UI face.
 */
private val LocalRangeSettingValueFont = staticCompositionLocalOf<FontFamily> { FontFamily.Monospace }

@Composable
fun DeskRibbon(
    destination: String,
    focus: Boolean,
    penOpen: Boolean,
    onDestination: (String) -> Unit,
    onPalette: () -> Unit,
    onFocus: () -> Unit,
    onDaily: () -> Unit,
    onPen: () -> Unit,
    aiOpen: Boolean = false,
) {
    var toolsOpen by remember { mutableStateOf(false) }
    val toolIds = ch.fasrv.fanotes.desk.RIBBON_TOOLS.map { it.id }.toSet()
    LaunchedEffect(destination, aiOpen) { if (aiOpen || destination in toolIds) toolsOpen = true }
    Row(
        Modifier.fillMaxWidth().height(ch.fasrv.fanotes.desk.RIBBON_HEIGHT_DP.dp).background(MaterialTheme.colorScheme.surface).horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("F", modifier = Modifier.padding(end = 8.dp), fontWeight = FontWeight.SemiBold)
        Text("FaNotes", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(end = 12.dp))
        if (focus) {
            RibbonButton("Fokus aus", active = false, onClick = onFocus)
            return@Row
        }
        ch.fasrv.fanotes.desk.RIBBON_PRIMARY.forEach { item ->
            val active = ch.fasrv.fanotes.desk.ribbonItemActive(item.id, destination, penOpen, aiOpen)
            RibbonButton(
                item.label,
                active,
                onClickLabel = if (item.id == "pen" && penOpen) "Zur Tastatur wechseln" else item.label,
            ) {
                if (item.id == "pen") onPen() else onDestination(item.id)
            }
        }
        RibbonButton(
            ch.fasrv.fanotes.desk.ribbonToolLabel(toolsOpen),
            toolsOpen,
            onClickLabel = if (toolsOpen) "Zusätzliche Werkzeuge einklappen" else "Zusätzliche Werkzeuge ausklappen",
        ) { toolsOpen = !toolsOpen }
        if (toolsOpen) {
            ch.fasrv.fanotes.desk.RIBBON_TOOLS.forEach { item ->
                val active = ch.fasrv.fanotes.desk.ribbonItemActive(item.id, destination, penOpen, aiOpen)
                val label = if (item.id == "focus") "Fokus" else item.label
                RibbonButton(
                    label,
                    active,
                    onClickLabel = if (item.id == "daily") "Heutige Tagesnotiz öffnen" else label,
                ) {
                    when (item.id) {
                        "daily" -> onDaily()
                        "commands" -> onPalette()
                        "focus" -> onFocus()
                        else -> onDestination(item.id)
                    }
                }
            }
        }
        RibbonButton("Einstellungen", destination == "settings") { onDestination("settings") }
    }
}

@Composable
private fun RibbonButton(
    label: String,
    active: Boolean,
    onClickLabel: String = label,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.RIBBON_BUTTON_RADIUS_DP.dp)
    Box(
        Modifier
            .padding(horizontal = 1.dp)
            .height(ch.fasrv.fanotes.desk.RIBBON_BUTTON_DP.dp)
            .clip(shape)
            .background(if (active) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
            .clickable(onClickLabel = onClickLabel, onClick = onClick)
            .padding(horizontal = ch.fasrv.fanotes.desk.RIBBON_BUTTON_PAD_DP.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            color = if (active) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.muted,
        )
    }
}

@Composable
fun FaNotesToast(message: String, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.TOAST_RADIUS_DP.dp)
    Row(
        modifier
            .widthIn(max = ch.fasrv.fanotes.desk.TOAST_MAX_DP.dp)
            .fillMaxWidth(0.8f)
            .heightIn(min = ch.fasrv.fanotes.desk.TOAST_MIN_DP.dp)
            .shadow(12.dp, shape)
            .clip(shape)
            .background(LocalStatusInk.current.panelStrong)
            .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA), shape)
            .padding(
                start = ch.fasrv.fanotes.desk.TOAST_PAD_START_DP.dp,
                top = ch.fasrv.fanotes.desk.TOAST_PAD_DP.dp,
                end = ch.fasrv.fanotes.desk.TOAST_PAD_DP.dp,
                bottom = ch.fasrv.fanotes.desk.TOAST_PAD_DP.dp,
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.TOAST_GAP_DP.dp),
    ) {
        Text(
            message,
            modifier = Modifier.weight(1f),
            fontSize = ch.fasrv.fanotes.desk.TOAST_FONT_SP.sp,
            lineHeight = 18.sp,
            color = LocalStatusInk.current.soft,
        )
        Box(
            Modifier
                .size(ch.fasrv.fanotes.desk.TOAST_CLOSE_DP.dp)
                .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.TOAST_CLOSE_RADIUS_DP.dp))
                .clickable(onClickLabel = "Schließen", onClick = onDismiss),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Close, contentDescription = "Schließen", modifier = Modifier.size(14.dp), tint = LocalStatusInk.current.muted)
        }
    }
}

@Composable
private fun StatusChip(
    label: String,
    idle: Color,
    onClick: () -> Unit,
    onClickLabel: String,
    radiusDp: Int = ch.fasrv.fanotes.desk.STATUS_BUTTON_RADIUS_DP,
    padDp: Int = ch.fasrv.fanotes.desk.STATUS_CRUMB_PAD_DP,
    maxWidthDp: Int? = null,
    badge: Int = 0,
) {
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val pressed by interaction.collectIsPressedAsState()
    val hot = hovered || pressed
    val ink = if (ch.fasrv.fanotes.desk.statusChipInk(hot, "inherit") == "text") MaterialTheme.colorScheme.onSurface else idle
    Row(
        Modifier
            .height(ch.fasrv.fanotes.desk.STATUS_BUTTON_DP.dp)
            .then(if (maxWidthDp != null) Modifier.widthIn(max = maxWidthDp.dp) else Modifier)
            .clip(RoundedCornerShape(radiusDp.dp))
            .background(if (hot) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
            .hoverable(interaction)
            .clickable(interactionSource = interaction, indication = null, onClickLabel = onClickLabel, onClick = onClick)
            .padding(horizontal = padDp.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            label,
            fontSize = 12.sp,
            color = ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = if (maxWidthDp != null) Modifier.weight(1f, fill = false) else Modifier,
        )
        if (badge > 0) {
            Box(
                Modifier
                    .height(ch.fasrv.fanotes.desk.STATUS_CONFLICT_HEIGHT_DP.dp)
                    .widthIn(min = ch.fasrv.fanotes.desk.STATUS_CONFLICT_MIN_DP.dp)
                    .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.STATUS_CONFLICT_RADIUS_DP.dp))
                    .background(MaterialTheme.colorScheme.error.copy(alpha = ch.fasrv.fanotes.desk.STATUS_CONFLICT_ALPHA))
                    .padding(horizontal = ch.fasrv.fanotes.desk.STATUS_CONFLICT_PAD_DP.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "$badge",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.error,
                    maxLines = 1,
                )
            }
        }
    }
}

@Composable
fun DeskStatusBar(
    words: Int,
    syncText: String,
    syncTone: String = "muted",
    language: String,
    showWords: Boolean,
    conflicts: Int = 0,
    onConflicts: () -> Unit = {},
    crumbs: List<Breadcrumb> = emptyList(),
    onCrumb: (String) -> Unit = {},
    notice: String? = null,
    onDismissNotice: () -> Unit = {},
    sidebarOpen: Boolean = true,
    onToggleSidebar: (() -> Unit)? = null,
    mode: String = "",
    worksheets: String? = null,
    saveLabel: String = "",
    onSave: () -> Unit = {},
) {
    val ink = LocalStatusInk.current
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(rule))
        Row(
            Modifier
                .fillMaxWidth()
                .height(ch.fasrv.fanotes.desk.STATUS_BAR_DP.dp)
                .padding(horizontal = ch.fasrv.fanotes.desk.STATUS_PAD_DP.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.STATUS_GROUP_GAP_DP.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onToggleSidebar != null) {
                StatusChip(
                    label = if (sidebarOpen) "Leiste zu" else "Leiste",
                    idle = ink.muted,
                    onClick = onToggleSidebar,
                    onClickLabel = if (sidebarOpen) "Seitenleiste einklappen" else "Seitenleiste einblenden",
                )
            }
            if (mode.isNotBlank()) {
                Text(mode, fontSize = 12.sp, color = ink.muted)
            }
            if (!worksheets.isNullOrBlank()) {
                Text(worksheets, fontSize = 12.sp, color = ink.muted)
            }
            if (!notice.isNullOrBlank()) {
                Text(
                    notice,
                    fontSize = 12.sp,
                    maxLines = 1,
                    color = ink.muted,
                    modifier = Modifier.clickable(onClick = onDismissNotice),
                )
            }
        }
        if (crumbs.isNotEmpty()) {
            Box(
                Modifier
                    .padding(start = ch.fasrv.fanotes.desk.STATUS_CRUMB_INSET_DP.dp)
                    .width(1.dp)
                    .height(16.dp)
                    .background(rule),
            )
            Row(
                Modifier
                    .weight(1f)
                    .padding(start = ch.fasrv.fanotes.desk.STATUS_CRUMB_INSET_DP.dp)
                    .horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.STATUS_CRUMB_GAP_DP.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                crumbs.forEachIndexed { index, crumb ->
                    if (index > 0) Text("›", fontSize = 12.sp, color = ink.muted.copy(alpha = 0.6f))
                    if (crumb.isNote) {
                        Text(
                            crumb.label,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = ink.soft,
                            maxLines = 1,
                            modifier = Modifier.widthIn(max = ch.fasrv.fanotes.desk.STATUS_NOTE_MAX_DP.dp),
                        )
                    } else {
                        StatusChip(
                            label = crumb.label,
                            idle = ink.muted,
                            onClick = { onCrumb(crumb.path) },
                            onClickLabel = "„${crumb.label}“ in der Dateileiste zeigen",
                            maxWidthDp = ch.fasrv.fanotes.desk.STATUS_FOLDER_MAX_DP,
                        )
                    }
                }
            }
        } else {
            Spacer(Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.STATUS_GROUP_GAP_DP.dp), verticalAlignment = Alignment.CenterVertically) {
            if (language.isNotBlank()) Text(language, fontSize = 12.sp, color = ink.muted)
            if (showWords) Text("$words Wörter", fontSize = 12.sp, color = ink.muted)
            val syncIdle = when (ch.fasrv.fanotes.desk.statusSyncTone(syncTone)) {
                "success" -> ink.success
                "danger" -> MaterialTheme.colorScheme.error
                else -> ink.muted
            }
            StatusChip(
                label = syncText,
                idle = syncIdle,
                onClick = onConflicts,
                onClickLabel = "Synchronisation",
                radiusDp = ch.fasrv.fanotes.desk.STATUS_SYNC_RADIUS_DP,
                padDp = ch.fasrv.fanotes.desk.STATUS_SYNC_PAD_DP,
                badge = conflicts,
            )
            if (saveLabel.isNotBlank()) {
                val saveColor = when (ch.fasrv.fanotes.desk.statusSaveTone(saveLabel)) {
                    "danger" -> MaterialTheme.colorScheme.error
                    "warning" -> ink.warning
                    else -> ink.success
                }
                StatusChip(
                    label = saveLabel,
                    idle = saveColor,
                    onClick = onSave,
                    onClickLabel = "Jetzt speichern",
                    padDp = ch.fasrv.fanotes.desk.STATUS_SAVE_PAD_DP,
                )
            }
            Text(ch.fasrv.fanotes.desk.STATUS_LOCAL_PRIVATE, fontSize = 12.sp, color = ink.muted)
        }
        }
    }
}

@Composable
fun NoteTabs(
    paths: List<String>,
    selected: String?,
    pinned: Set<String>,
    canBack: Boolean,
    canForward: Boolean,
    onOpen: (String) -> Unit,
    onClose: (String) -> Unit,
    onBack: () -> Unit,
    onForward: () -> Unit,
    onOpenSplit: (String) -> Unit = {},
    splitPath: String? = null,
    unsavedPaths: Set<String> = emptySet(),
    onMove: (String, String?, String) -> Unit = { _, _, _ -> },
    onTogglePin: (String) -> Unit = {},
    onCloseScope: (String, String) -> Unit = { _, _ -> },
    onCopyPath: (String) -> Unit = {},
    onReveal: (String) -> Unit = {},
) {
    if (paths.isEmpty() && !canBack && !canForward) return
    val scroll = rememberScrollState()
    var dragging by remember { mutableStateOf<String?>(null) }
    var dropOn by remember { mutableStateOf<Pair<String?, String>?>(null) }
    val bounds = remember { androidx.compose.runtime.mutableStateMapOf<String, androidx.compose.ui.geometry.Rect>() }
    val deskTabs = paths.map { DeskTab(it, it in pinned) }
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.NOTE_TAB_RULE_ALPHA)
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        NoteHistoryButton(back = true, enabled = canBack, onClick = onBack)
        NoteHistoryButton(back = false, enabled = canForward, onClick = onForward)
        Row(
            Modifier.weight(1f).horizontalScroll(scroll, enabled = dragging == null),
            verticalAlignment = Alignment.CenterVertically,
        ) {
        paths.forEach { path ->
            NoteTabChip(
                path = path,
                selected = path == selected,
                pinned = path in pinned,
                inSplit = path == splitPath,
                unsaved = path in unsavedPaths,
                dragging = dragging == path,
                dropSide = dropOn?.takeIf { it.first == path && dragging != null && dragging != path }?.second,
                canCloseOthers = tabsToClose(deskTabs, path, "others").isNotEmpty(),
                canCloseRight = tabsToClose(deskTabs, path, "right").isNotEmpty(),
                onOpen = { onOpen(path) },
                onClose = { onClose(path) },
                onOpenSplit = { onOpenSplit(path) },
                onTogglePin = { onTogglePin(path) },
                onCloseOthers = { onCloseScope(path, "others") },
                onCloseRight = { onCloseScope(path, "right") },
                onCopyPath = { onCopyPath(path) },
                onReveal = { onReveal(path) },
                onPosition = { bounds[path] = it },
                restartKey = paths to pinned,
                onDragStart = {
                    dragging = path
                    dropOn = null
                },
                onDrag = { rootX ->
                    val candidate = tabDropTarget(bounds, rootX)
                    val next = moveTab(deskTabs, path, candidate.first, candidate.second)
                    dropOn = if (next.map { it.path } == paths) null else candidate
                },
                onDragEnd = {
                    val from = dragging
                    val drop = dropOn
                    dragging = null
                    dropOn = null
                    if (from != null && drop != null) onMove(from, drop.first, drop.second)
                },
                onDragCancel = {
                    dragging = null
                    dropOn = null
                },
            )
        }
        }
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(rule))
    }
}

@Composable
private fun NoteHistoryButton(back: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val ink = LocalStatusInk.current
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val pressed by interaction.collectIsPressedAsState()
    val hot = enabled && (hovered || pressed)
    val color = if (hot) MaterialTheme.colorScheme.onSurface else ink.soft
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.noteNavRuleAlpha(back))
    Row(
        Modifier
            .height(ch.fasrv.fanotes.desk.NOTE_NAV_HEIGHT_DP.dp)
            .alpha(if (enabled) 1f else ch.fasrv.fanotes.desk.NOTE_NAV_DISABLED_ALPHA)
            .background(
                if (hot) MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.NOTE_NAV_HOVER_ALPHA) else Color.Transparent,
            )
            .hoverable(interaction)
            .clickable(interactionSource = interaction, indication = null, enabled = enabled, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier
                .fillMaxHeight()
                .then(
                    if (back) Modifier.padding(horizontal = ch.fasrv.fanotes.desk.NOTE_NAV_BACK_PAD_DP.dp)
                    else Modifier.width((ch.fasrv.fanotes.desk.NOTE_NAV_FORWARD_DP - 1).dp),
                ),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = if (back) {
                Arrangement.spacedBy(ch.fasrv.fanotes.desk.NOTE_NAV_GAP_DP.dp)
            } else {
                Arrangement.Center
            },
        ) {
            Icon(
                if (back) Icons.AutoMirrored.Filled.ArrowBack else Icons.AutoMirrored.Filled.ArrowForward,
                contentDescription = if (back) "Zurück" else "Vorwärts",
                modifier = Modifier.size(ch.fasrv.fanotes.desk.NOTE_NAV_ICON_DP.dp),
                tint = color,
            )
            if (back) {
                Text(
                    "Zurück",
                    fontSize = ch.fasrv.fanotes.desk.NOTE_NAV_FONT_SP.sp,
                    fontWeight = FontWeight(ch.fasrv.fanotes.desk.NOTE_NAV_WEIGHT),
                    color = color,
                )
            }
        }
        Box(Modifier.fillMaxHeight().width(1.dp).background(rule))
    }
}

private fun tabDropTarget(
    bounds: Map<String, androidx.compose.ui.geometry.Rect>,
    rootX: Float,
): Pair<String?, String> {
    val hit = bounds.entries.firstOrNull { rootX >= it.value.left && rootX <= it.value.right }
    if (hit != null) {
        val mid = (hit.value.left + hit.value.right) / 2f
        return hit.key to if (rootX < mid) "before" else "after"
    }
    val leftmost = bounds.minByOrNull { it.value.left } ?: return null to "after"
    return if (rootX < leftmost.value.left) leftmost.key to "before" else null to "after"
}

@Composable
private fun NoteTabChip(
    path: String,
    selected: Boolean,
    pinned: Boolean,
    inSplit: Boolean,
    unsaved: Boolean,
    dragging: Boolean,
    dropSide: String?,
    canCloseOthers: Boolean,
    canCloseRight: Boolean,
    onOpen: () -> Unit,
    onClose: () -> Unit,
    onOpenSplit: () -> Unit,
    onTogglePin: () -> Unit,
    onCloseOthers: () -> Unit,
    onCloseRight: () -> Unit,
    onCopyPath: () -> Unit,
    onReveal: () -> Unit,
    restartKey: Any,
    onPosition: (androidx.compose.ui.geometry.Rect) -> Unit,
    onDragStart: () -> Unit,
    onDrag: (Float) -> Unit,
    onDragEnd: () -> Unit,
    onDragCancel: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val textLeft = remember { floatArrayOf(0f) }
    val name = path.substringAfterLast('/').substringBeforeLast('.')
    val box = ch.fasrv.fanotes.desk.noteTabBox(pinned)
    val shape = RoundedCornerShape(box.radiusDp.dp)
    val tabInteraction = remember(path) { MutableInteractionSource() }
    val tabHovered by tabInteraction.collectIsHoveredAsState()
    val tabPressed by tabInteraction.collectIsPressedAsState()
    val hot = tabHovered || tabPressed
    val accent = Color(
        ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f),
    )
    val titleColor = when (ch.fasrv.fanotes.desk.noteTabInk(selected, inSplit)) {
        "text" -> MaterialTheme.colorScheme.onSurface
        "soft" -> LocalStatusInk.current.soft
        else -> if (hot) LocalStatusInk.current.soft else LocalStatusInk.current.muted
    }
    val fill = when {
        selected -> MaterialTheme.colorScheme.surfaceVariant
        hot -> MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.NOTE_TAB_HOVER_ALPHA)
        else -> Color.Transparent
    }
    val glyph = ch.fasrv.fanotes.desk.noteTabGlyph(path, pinned)
    Box {
        Box(
            Modifier
                .padding(horizontal = box.marginXDp.dp, vertical = box.marginYDp.dp)
                .height(box.heightDp.dp)
                .then(
                    if (box.basisDp > 0) {
                        Modifier.widthIn(min = box.minWidthDp.dp, max = box.maxWidthDp.dp).width(box.basisDp.dp)
                    } else {
                        Modifier.widthIn(max = box.maxWidthDp.dp)
                    },
                )
                .hoverable(tabInteraction)
                .onGloballyPositioned { onPosition(it.boundsInRoot()) }
                .semantics { if (dragging) contentDescription = "Wird verschoben" },
        ) {
        Row(
            Modifier
                .fillMaxHeight()
                .then(if (box.basisDp > 0) Modifier.fillMaxWidth() else Modifier)
                .clip(shape)
                .background(fill)
                .padding(start = box.padStartDp.dp, end = box.padEndDp.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                Modifier
                    .then(if (box.basisDp > 0) Modifier.weight(1f) else Modifier)
                    .padding(horizontal = ch.fasrv.fanotes.desk.NOTE_TAB_MAIN_PAD_DP.dp)
                    .onGloballyPositioned { textLeft[0] = it.boundsInRoot().left }
                    .pointerInput(path, restartKey) {
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
                            "tap" -> onOpen()
                            "scroll", "cancel" -> Unit
                            else -> {
                                onDragStart()
                                var moved = false
                                var ended = false
                                while (true) {
                                    val event = awaitPointerEvent()
                                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                    change.consume()
                                    onDrag(textLeft[0] + change.position.x)
                                    if (abs(change.position.x - down.position.x) > slop || abs(change.position.y - down.position.y) > slop) moved = true
                                    if (!change.pressed) {
                                        ended = true
                                        break
                                    }
                                }
                                if (ended && moved) onDragEnd() else if (ended) {
                                    onDragCancel()
                                    menu = true
                                } else onDragCancel()
                            }
                        }
                    }
                },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.NOTE_TAB_GAP_DP.dp),
            ) {
                Icon(
                    when (glyph) {
                        "pin" -> Icons.Filled.PushPin
                        "pdf" -> Icons.Filled.PictureAsPdf
                        else -> Icons.Filled.Description
                    },
                    contentDescription = null,
                    modifier = Modifier.size(
                        (if (glyph == "pin") ch.fasrv.fanotes.desk.NOTE_TAB_PIN_DP else ch.fasrv.fanotes.desk.NOTE_TAB_FILE_DP).dp,
                    ),
                    tint = if (glyph == "pin") accent else titleColor,
                )
                Text(
                    name,
                    fontSize = 12.sp,
                    color = titleColor,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = box.basisDp > 0),
                )
                if (inSplit) {
                    Icon(
                        Icons.Filled.ViewColumn,
                        contentDescription = "In der zweiten Spalte",
                        modifier = Modifier.size(ch.fasrv.fanotes.desk.NOTE_TAB_SPLIT_DP.dp),
                        tint = accent,
                    )
                }
                if (unsaved) {
                    Box(
                        Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.primary)
                            .semantics { contentDescription = "Noch nicht gespeichert" },
                    )
                }
            }
            if (!pinned) {
                val closeInteraction = remember(path) { MutableInteractionSource() }
                val closeHovered by closeInteraction.collectIsHoveredAsState()
                val closePressed by closeInteraction.collectIsPressedAsState()
                val showClose = ch.fasrv.fanotes.desk.noteTabShowsClose(selected, pinned, hot || closeHovered || closePressed)
                Box(
                    Modifier
                        .size(ch.fasrv.fanotes.desk.NOTE_TAB_CLOSE_DP.dp)
                        .alpha(if (showClose) 1f else 0f)
                        .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.NOTE_TAB_CLOSE_RADIUS_DP.dp))
                        .background(
                            if (showClose && (closeHovered || closePressed)) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent,
                        )
                        .hoverable(closeInteraction)
                        .clickable(
                            interactionSource = closeInteraction,
                            indication = null,
                            onClickLabel = "Tab schließen",
                            onClick = onClose,
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = "$name schließen",
                        modifier = Modifier.size(ch.fasrv.fanotes.desk.NOTE_TAB_CLOSE_ICON_DP.dp),
                        tint = titleColor,
                    )
                }
            }
        }
        if (dropSide == "before" || dropSide == "after") {
            val before = dropSide == "before"
            Box(
                Modifier
                    .align(if (before) Alignment.CenterStart else Alignment.CenterEnd)
                    .offset(x = (if (before) -1 else 1).dp)
                    .padding(vertical = ch.fasrv.fanotes.desk.NOTE_TAB_DROP_INSET_DP.dp)
                    .fillMaxHeight()
                    .width(ch.fasrv.fanotes.desk.NOTE_TAB_DROP_WIDTH_DP.dp)
                    .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.NOTE_TAB_DROP_RADIUS_DP.dp))
                    .background(MaterialTheme.colorScheme.primary),
            )
        }
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(
                text = { Text("Rechts öffnen") },
                enabled = !inSplit,
                onClick = { menu = false; onOpenSplit() },
            )
            DropdownMenuItem(
                text = { Text(if (pinned) "Lösen" else "Anheften") },
                onClick = { menu = false; onTogglePin() },
            )
            DropdownMenuItem(text = { Text("Pfad kopieren") }, onClick = { menu = false; onCopyPath() })
            DropdownMenuItem(text = { Text("Im Dateimanager zeigen") }, onClick = { menu = false; onReveal() })
            DropdownMenuItem(
                text = { Text("Schließen") },
                enabled = !pinned,
                onClick = { menu = false; onClose() },
            )
            DropdownMenuItem(
                text = { Text("Andere schließen") },
                enabled = canCloseOthers,
                onClick = { menu = false; onCloseOthers() },
            )
            DropdownMenuItem(
                text = { Text("Rechts davon schließen") },
                enabled = canCloseRight,
                onClick = { menu = false; onCloseRight() },
            )
        }
    }
}

@Composable
private fun VaultSearchField(query: String, onQuery: (String) -> Unit, keys: Modifier) {
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
            .padding(horizontal = ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_PAD_DP.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_GAP_DP.dp),
    ) {
        Icon(Icons.Filled.Search, contentDescription = null, modifier = Modifier.size(ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_ICON_DP.dp), tint = ink.muted)
        BasicTextField(
            value = query,
            onValueChange = onQuery,
            modifier = Modifier.weight(1f).onFocusChanged { focused = it.isFocused }.then(keys),
            singleLine = true,
            textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_SP.sp),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            decorationBox = { inner ->
                Box {
                    if (query.isEmpty()) Text(ch.fasrv.fanotes.desk.SEARCH_PLACEHOLDER, fontSize = ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_SP.sp, color = ink.muted, maxLines = 1)
                    inner()
                }
            },
        )
        if (query.isNotEmpty()) {
            Box(
                Modifier.size(ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_CLEAR_DP.dp).clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_CLEAR_RADIUS_DP.dp)).clickable(onClickLabel = "Suchbegriff löschen") { onQuery("") },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Close, contentDescription = "Suchbegriff löschen", modifier = Modifier.size(ch.fasrv.fanotes.desk.SIDEBAR_SEARCH_CLEAR_ICON_DP.dp), tint = ink.muted)
            }
        }
    }
}

@Composable
private fun SearchKbd(label: String) {
    Text(
        label,
        fontSize = 12.sp,
        color = LocalStatusInk.current.muted,
        modifier = Modifier
            .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SEARCH_KBD_RADIUS_DP.dp))
            .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA), RoundedCornerShape(ch.fasrv.fanotes.desk.SEARCH_KBD_RADIUS_DP.dp))
            .padding(horizontal = 5.dp, vertical = 1.dp),
    )
}

@Composable
fun SearchScreen(
    model: FaNotesViewModel,
    onOpen: (String) -> Unit,
    onClose: () -> Unit = {},
    modifier: Modifier = Modifier.fillMaxSize(),
) {
    val query by model.searchQuery.collectAsStateWithLifecycle()
    val hits by model.searchHits.collectAsStateWithLifecycle()
    var selected by remember(query) { mutableIntStateOf(-1) }
    val settings by model.deskSettings.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()
    androidx.compose.runtime.LaunchedEffect(selected, hits.size, settings["reduce-motion"]) {
        if (selected in hits.indices) {
            if (ch.fasrv.fanotes.desk.listFollowsSelection(ch.fasrv.fanotes.desk.reduceMotion(settings["reduce-motion"])) == "instant") {
                listState.scrollToItem(selected)
            } else {
                listState.animateScrollToItem(selected)
            }
        }
    }
    fun openSelected() {
        val hit = hits.getOrNull(selected) ?: return
        model.openSearchHit(hit)
        onOpen(hit.path)
    }
    val searchRule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    Box(modifier) {
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface)) {
        Row(
            Modifier.fillMaxWidth().padding(start = 12.dp, end = 8.dp, top = 14.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    ch.fasrv.fanotes.desk.SEARCH_EYEBROW,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.12.em,
                    color = MaterialTheme.colorScheme.primary,
                )
                Text(
                    "Notizen durchsuchen",
                    fontSize = ch.fasrv.fanotes.desk.SEARCH_TITLE_SP.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            Box(
                Modifier.size(30.dp).clip(RoundedCornerShape(6.dp)).clickable(onClick = onClose),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Close, contentDescription = ch.fasrv.fanotes.desk.SEARCH_CLOSE, modifier = Modifier.size(17.dp), tint = LocalStatusInk.current.muted)
            }
        }
        val searchKeys = Modifier.onPreviewKeyEvent { event ->
            if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
            when (event.key) {
                Key.DirectionDown -> {
                    selected = ch.fasrv.fanotes.desk.searchResultMove(selected, hits.size, true)
                    true
                }
                Key.DirectionUp -> {
                    selected = ch.fasrv.fanotes.desk.searchResultMove(selected, hits.size, false)
                    true
                }
                Key.Enter, Key.NumPadEnter -> {
                    if (selected in hits.indices) openSelected()
                    selected in hits.indices
                }
                else -> false
            }
        }
        VaultSearchField(query, { model.searchVaultText(it) }, searchKeys)
        Text(
            if (query.trim().length >= 2) "${hits.size} Treffer" else "Text und unsichtbare Handschrift",
            modifier = Modifier.padding(start = 14.dp, top = 8.dp, end = 14.dp, bottom = 7.dp),
            fontSize = 12.sp,
            color = LocalStatusInk.current.muted,
        )
        if (query.trim().length < 2) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(top = ch.fasrv.fanotes.desk.SEARCH_EMPTY_PAD_TOP_DP.dp, start = 18.dp, end = 18.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    ch.fasrv.fanotes.desk.SEARCH_EMPTY_TITLE,
                    fontSize = 12.sp,
                    color = LocalStatusInk.current.soft,
                    modifier = Modifier.padding(top = 8.dp),
                )
                Text(
                    ch.fasrv.fanotes.desk.SEARCH_EMPTY_HINT,
                    fontSize = 12.sp,
                    color = LocalStatusInk.current.muted,
                    textAlign = TextAlign.Center,
                    lineHeight = 18.sp,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        } else if (hits.isEmpty()) {
            Text(
                "Keine Treffer für „${query.trim()}“.",
                modifier = Modifier.padding(top = ch.fasrv.fanotes.desk.SEARCH_EMPTY_PAD_TOP_DP.dp, start = 18.dp, end = 18.dp),
                fontSize = 12.sp,
                color = LocalStatusInk.current.muted,
                textAlign = TextAlign.Center,
            )
        }
        LazyColumn(state = listState, modifier = Modifier.padding(horizontal = 7.dp).weight(1f)) {
            itemsIndexed(hits, key = { _, hit -> "${hit.kind}:${hit.path}:${hit.line}:${hit.anchorY}" }) { index, hit ->
                val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.SEARCH_RESULT_RADIUS_DP.dp)
                Column(Modifier.fillMaxWidth().padding(bottom = 2.dp)) {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = ch.fasrv.fanotes.desk.SEARCH_RESULT_MIN_DP.dp)
                            .clip(shape)
                            .background(if (index == selected) MaterialTheme.colorScheme.surfaceVariant else androidx.compose.ui.graphics.Color.Transparent)
                            .clickable {
                                selected = index
                                model.openSearchHit(hit)
                                onOpen(hit.path)
                            }
                            .padding(ch.fasrv.fanotes.desk.SEARCH_RESULT_PAD_DP.dp),
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SEARCH_RESULT_GAP_DP.dp),
                        ) {
                            Icon(
                                if (hit.kind == "drawing" || hit.anchorY != null) Icons.Filled.Draw else Icons.Filled.Description,
                                contentDescription = null,
                                modifier = Modifier.size(14.dp),
                                tint = LocalStatusInk.current.soft,
                            )
                            Text(
                                hit.title.ifBlank { hit.path.substringAfterLast('/') },
                                modifier = Modifier.weight(1f),
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = LocalStatusInk.current.soft,
                                maxLines = 1,
                            )
                            Text(
                                "${hit.matches}",
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SEARCH_BADGE_RADIUS_DP.dp))
                                    .background(LocalStatusInk.current.panelActive)
                                    .padding(
                                        horizontal = ch.fasrv.fanotes.desk.SEARCH_BADGE_PAD_X_DP.dp,
                                        vertical = ch.fasrv.fanotes.desk.SEARCH_BADGE_PAD_Y_DP.dp,
                                    ),
                            )
                        }
                        Text(
                            if (hit.kind == "drawing" || hit.anchorY != null) "Handschrift-Seite · unsichtbar transkribiert" else hit.path,
                            fontSize = 12.sp,
                            color = LocalStatusInk.current.muted,
                            maxLines = 1,
                            modifier = Modifier.padding(
                                start = ch.fasrv.fanotes.desk.SEARCH_PATH_INSET_DP.dp,
                                top = 3.dp,
                                bottom = 6.dp,
                            ),
                        )
                        Text(hit.text, maxLines = 2, fontSize = 12.sp, color = LocalStatusInk.current.muted, lineHeight = 17.sp)
                    }
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(1.dp)
                            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)),
                    )
                }
            }
        }
        Column(Modifier.fillMaxWidth()) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)),
            )
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = ch.fasrv.fanotes.desk.SEARCH_FOOTER_DP.dp)
                    .padding(horizontal = 10.dp, vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                SearchKbd("↑")
                SearchKbd("↓")
                Text(ch.fasrv.fanotes.desk.SEARCH_CHOOSE, fontSize = 12.sp, color = LocalStatusInk.current.muted, modifier = Modifier.padding(end = 7.dp))
                SearchKbd("Esc")
                Text(ch.fasrv.fanotes.desk.SEARCH_FOOTER_CLOSE, fontSize = 12.sp, color = LocalStatusInk.current.muted, modifier = Modifier.clickable(onClick = onClose))
            }
        }
    }
        Box(
            Modifier
                .align(Alignment.CenterEnd)
                .width(1.dp)
                .fillMaxHeight()
                .background(searchRule),
        )
    }
}

@Composable
fun HomeworkScreen(model: FaNotesViewModel) {
    val document by model.homework.collectAsStateWithLifecycle()
    val settings by model.deskSettings.collectAsStateWithLifecycle()
    val status by model.message.collectAsStateWithLifecycle()
    val tree by model.tree.collectAsStateWithLifecycle()
    val subjectChoices = ch.fasrv.fanotes.desk.homeworkSubjectOptions(
        tree.filter { it.kind == ch.fasrv.fanotes.vault.NoteKind.FOLDER }.map { it.name },
        document.tasks,
    )
    var title by remember { mutableStateOf("") }
    var subject by remember { mutableStateOf("") }
    var due by remember { mutableStateOf(ch.fasrv.fanotes.desk.HOMEWORK_DEFAULT_DUE) }
    var planner by remember { mutableStateOf("list") }
    var filter by remember { mutableStateOf("open") }
    var showDone by remember { mutableStateOf(false) }
    var cursor by remember { mutableStateOf(LocalDate.now()) }
    var dueTime by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf(ch.fasrv.fanotes.desk.HOMEWORK_DEFAULT_KIND) }
    var priority by remember { mutableStateOf(ch.fasrv.fanotes.desk.HOMEWORK_DEFAULT_PRIORITY) }
    val stats = ch.fasrv.fanotes.desk.homeworkStats(document.tasks)
    val shownTasks = ch.fasrv.fanotes.desk.visibleHomeworkTasks(document.tasks, filter)
    val offered = subjectChoices.filter { choice ->
        subject.isBlank() || choice.startsWith(subject, ignoreCase = true)
    }.take(8)
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val inset = ch.fasrv.fanotes.desk.HOMEWORK_SHELL_INSET_DP.dp
        val shell = (maxWidth - inset * 2)
            .coerceAtLeast(0.dp)
            .coerceAtMost(ch.fasrv.fanotes.desk.HOMEWORK_SHELL_MAX_DP.dp)
        val columns = ch.fasrv.fanotes.desk.homeworkComposerColumns(shell.value.roundToInt())
        Column(
            Modifier
                .align(Alignment.TopCenter)
                .width(shell)
                .fillMaxHeight()
                .verticalScroll(rememberScrollState())
                .padding(
                    top = ch.fasrv.fanotes.desk.HOMEWORK_SHELL_PAD_TOP_DP.dp,
                    bottom = ch.fasrv.fanotes.desk.HOMEWORK_SHELL_PAD_BOTTOM_DP.dp,
                )
                .pointerInput(planner) {
                    detectDeskSwipe { direction ->
                        if (planner == "list") return@detectDeskSwipe
                        val step = ch.fasrv.fanotes.desk.calendarSwipeStep(direction) ?: return@detectDeskSwipe
                        cursor = ch.fasrv.fanotes.desk.homeworkPlannerShift(cursor, planner, step)
                    }
                },
        ) {
            HomeworkHeader(
                narrow = columns < ch.fasrv.fanotes.desk.HOMEWORK_COMPOSER_WIDE_COLUMNS,
                onOpen = { model.openHomeworkNote() },
                onClose = { model.showDestination("notes") },
            )
            HomeworkStatsRow(stats)
            HomeworkComposer(
                columns = columns,
                title = title,
                onTitle = { title = it.take(ch.fasrv.fanotes.desk.HOMEWORK_TITLE_LIMIT) },
                kind = kind,
                onKind = { kind = it },
                subject = subject,
                onSubject = { subject = it.take(ch.fasrv.fanotes.desk.HOMEWORK_SUBJECT_LIMIT) },
                suggestions = offered,
                due = due,
                onDue = { due = it },
                dueTime = dueTime,
                onDueTime = { dueTime = it },
                priority = priority,
                onPriority = { priority = it },
                notes = notes,
                onNotes = { notes = it.take(ch.fasrv.fanotes.desk.HOMEWORK_NOTES_LIMIT) },
                onSubmit = {
                    val date = ch.fasrv.fanotes.desk.homeworkDueValue(due)
                    val clock = ch.fasrv.fanotes.desk.homeworkTimeValue(dueTime)
                    if (title.isNotBlank() && date != null && clock != null) {
                        model.addHomework(title, subject, date, kind, clock, notes, priority)
                        title = ""
                        notes = ""
                        due = date
                        dueTime = ""
                        priority = ch.fasrv.fanotes.desk.HOMEWORK_DEFAULT_PRIORITY
                    }
                },
            )
            HomeworkChoiceRow(
                listOf(
                    "list" to ch.fasrv.fanotes.desk.HOMEWORK_VIEW_LIST,
                    "week" to ch.fasrv.fanotes.desk.HOMEWORK_VIEW_WEEK,
                    "month" to ch.fasrv.fanotes.desk.HOMEWORK_VIEW_MONTH,
                ),
                planner,
            ) { planner = it }
            HomeworkChoiceRow(
                listOf(
                    "open" to ch.fasrv.fanotes.desk.HOMEWORK_FILTER_OPEN,
                    "homework" to ch.fasrv.fanotes.desk.HOMEWORK_FILTER_HOMEWORK,
                    "appointment" to ch.fasrv.fanotes.desk.HOMEWORK_FILTER_APPOINTMENTS,
                    "done" to ch.fasrv.fanotes.desk.HOMEWORK_FILTER_DONE,
                    "all" to ch.fasrv.fanotes.desk.HOMEWORK_FILTER_ALL,
                ),
                filter,
            ) { filter = it }
            Text("Freigabe", modifier = Modifier.padding(top = 12.dp), fontWeight = FontWeight.SemiBold)
            Text(
                "Dieselbe Schnittstelle wie der Desktop: PUT an fanotes.fasrv.ch, Kanal-ID und Geheimnis bleiben auf diesem Tablet.",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
            )
            OutlinedTextField(
                settings["homework-channel"].orEmpty(),
                { model.updateDesk("homework-channel", it.trim()) },
                label = { Text("Kanal-ID") },
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            )
            OutlinedTextField(
                settings["homework-secret"].orEmpty(),
                { model.updateDesk("homework-secret", it.trim()) },
                label = { Text("Geheimnis") },
                modifier = Modifier.fillMaxWidth(),
            )
            Row {
                TextButton(onClick = { model.generateHomeworkAccess() }) { Text("Kanal erzeugen") }
                TextButton(onClick = { model.publishHomework() }) { Text("Veröffentlichen") }
            }
            if (!status.isNullOrBlank()) Text(status.orEmpty(), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary)
            if (planner != "list") {
                val days = ch.fasrv.fanotes.desk.homeworkPlannerDays(cursor, planner)
                val byDate = shownTasks.filter { it.dueDate != null }.groupBy { it.dueDate }
                val calShape = RoundedCornerShape(ch.fasrv.fanotes.desk.HOMEWORK_CAL_RADIUS_DP.dp)
                val dayShape = RoundedCornerShape(ch.fasrv.fanotes.desk.HOMEWORK_DAY_RADIUS_DP.dp)
                val navShape = RoundedCornerShape(6.dp)
                val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
                val limit = ch.fasrv.fanotes.desk.homeworkDayLimit(planner)
                Column(
                    Modifier
                        .fillMaxWidth()
                        .padding(top = 4.dp, bottom = 18.dp)
                        .clip(calShape)
                        .border(1.dp, rule, calShape)
                        .background(LocalStatusInk.current.panelStrong.copy(alpha = 0.82f))
                        .padding(ch.fasrv.fanotes.desk.HOMEWORK_CAL_PAD_DP.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(
                            Modifier
                                .size(ch.fasrv.fanotes.desk.HOMEWORK_NAV_DP.dp)
                                .clip(navShape)
                                .border(1.dp, rule, navShape)
                                .background(MaterialTheme.colorScheme.surface)
                                .clickable(onClickLabel = ch.fasrv.fanotes.desk.HOMEWORK_PREVIOUS) {
                                    cursor = ch.fasrv.fanotes.desk.homeworkPlannerShift(cursor, planner, -1)
                                },
                            contentAlignment = Alignment.Center,
                        ) { Text("‹") }
                        Text(
                            ch.fasrv.fanotes.desk.homeworkPlannerLabel(cursor, planner),
                            modifier = Modifier.weight(1f),
                            textAlign = TextAlign.Center,
                            fontSize = 13.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Box(
                            Modifier
                                .size(ch.fasrv.fanotes.desk.HOMEWORK_NAV_DP.dp)
                                .clip(navShape)
                                .border(1.dp, rule, navShape)
                                .background(MaterialTheme.colorScheme.surface)
                                .clickable(onClickLabel = ch.fasrv.fanotes.desk.HOMEWORK_NEXT) {
                                    cursor = ch.fasrv.fanotes.desk.homeworkPlannerShift(cursor, planner, 1)
                                },
                            contentAlignment = Alignment.Center,
                        ) { Text("›") }
                        Text(
                            "Heute",
                            color = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f)),
                            fontSize = 12.sp,
                            fontWeight = FontWeight(700),
                            modifier = Modifier.clickable { cursor = LocalDate.now() },
                        )
                    }
                    Row(Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.HOMEWORK_DAY_GAP_DP.dp)) {
                        ch.fasrv.fanotes.desk.homeworkWeekdays().forEach { label ->
                            Text(
                                label.uppercase(java.util.Locale.GERMAN),
                                modifier = Modifier.weight(1f),
                                textAlign = TextAlign.Center,
                                fontSize = 12.sp,
                                fontWeight = FontWeight(720),
                                letterSpacing = 0.06.em,
                                color = LocalStatusInk.current.muted,
                            )
                        }
                    }
                    days.chunked(7).forEach { week ->
                        Row(Modifier.fillMaxWidth().padding(bottom = ch.fasrv.fanotes.desk.HOMEWORK_DAY_GAP_DP.dp), horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.HOMEWORK_DAY_GAP_DP.dp)) {
                            week.forEach { day ->
                                val items = byDate[day.date.toString()].orEmpty()
                                val today = day.date == LocalDate.now()
                                Column(
                                    Modifier
                                        .weight(1f)
                                        .heightIn(min = ch.fasrv.fanotes.desk.homeworkDayMinDp(planner).dp)
                                        .clip(dayShape)
                                        .border(1.dp, if (today) MaterialTheme.colorScheme.primary.copy(alpha = 0.55f) else rule, dayShape)
                                        .background(MaterialTheme.colorScheme.background.copy(alpha = 0.8f))
                                        .alpha(if (day.outside) 0.45f else 1f)
                                        .clickable { due = day.date.toString() }
                                        .padding(ch.fasrv.fanotes.desk.HOMEWORK_DAY_PAD_DP.dp),
                                ) {
                                    Text(day.date.dayOfMonth.toString(), fontSize = 12.sp, fontWeight = FontWeight(720))
                                    items.take(limit).forEach { task ->
                                        val clock = task.dueTime?.takeIf { it.isNotBlank() }
                                        val chip = ch.fasrv.fanotes.desk.homeworkDayChip(task.kind, task.priority)
                                        val chipFill = when (chip) {
                                            "high" -> LocalStatusInk.current.warning.copy(alpha = 0.22f)
                                            "appointment" -> MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)
                                            else -> MaterialTheme.colorScheme.primary.copy(alpha = 0.14f)
                                        }
                                        Text(
                                            if (clock == null) task.title else "$clock · ${task.title}",
                                            modifier = Modifier
                                                .padding(top = 3.dp)
                                                .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.HOMEWORK_CHIP_RADIUS_DP.dp))
                                                .background(chipFill)
                                                .padding(horizontal = 5.dp, vertical = 2.dp)
                                                .alpha(if (task.done) 0.55f else 1f),
                                            fontSize = 12.sp,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                            textDecoration = if (task.done) TextDecoration.LineThrough else null,
                                        )
                                    }
                                    val hidden = items.size - limit
                                    if (hidden > 0) Text("+$hidden", fontSize = 12.sp, color = LocalStatusInk.current.muted, modifier = Modifier.padding(top = 2.dp))
                                }
                            }
                        }
                    }
                }
            }
            val ordered = ch.fasrv.fanotes.desk.sortHomeworkTasks(shownTasks)
            if (ordered.isEmpty()) {
                HomeworkEmpty()
            }
            listOf("overdue", "today", "upcoming", "undated").forEach { bucket ->
                val items = ordered.filter { ch.fasrv.fanotes.desk.classifyHomeworkTask(it) == bucket }
                if (items.isNotEmpty()) HomeworkBucket(bucket, items, model)
            }
            if (ch.fasrv.fanotes.desk.homeworkDoneBucketVisible(filter, showDone)) {
                val finished = ordered.filter { ch.fasrv.fanotes.desk.classifyHomeworkTask(it) == "done" }
                if (finished.isNotEmpty()) {
                    HomeworkBucket(
                        "done",
                        finished,
                        model,
                        toggle = ch.fasrv.fanotes.desk.homeworkDoneToggleLabel(filter, showDone),
                        onToggle = { showDone = !showDone },
                    )
                }
            }
        }
    }
}

@Composable
private fun HomeworkHeader(narrow: Boolean, onOpen: () -> Unit, onClose: () -> Unit) {
    val gap = ch.fasrv.fanotes.desk.HOMEWORK_HEADER_GAP_DP.dp
    if (narrow) {
        Column(
            Modifier.fillMaxWidth().padding(bottom = ch.fasrv.fanotes.desk.HOMEWORK_HEADER_MARGIN_DP.dp),
            verticalArrangement = Arrangement.spacedBy(gap),
        ) {
            HomeworkHeading()
            HomeworkHeaderActions(onOpen, onClose)
        }
    } else {
        Row(
            Modifier.fillMaxWidth().padding(bottom = ch.fasrv.fanotes.desk.HOMEWORK_HEADER_MARGIN_DP.dp),
            horizontalArrangement = Arrangement.spacedBy(gap),
            verticalAlignment = Alignment.Top,
        ) {
            Column(Modifier.weight(1f)) { HomeworkHeading() }
            HomeworkHeaderActions(onOpen, onClose)
        }
    }
}

@Composable
private fun HomeworkHeading() {
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    Row(
        Modifier.padding(bottom = ch.fasrv.fanotes.desk.HOMEWORK_EYEBROW_MARGIN_DP.dp),
        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.HOMEWORK_EYEBROW_GAP_DP.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.AutoMirrored.Outlined.Assignment,
            contentDescription = null,
            modifier = Modifier.size(ch.fasrv.fanotes.desk.HOMEWORK_EYEBROW_ICON_DP.dp),
            tint = accent,
        )
        Text(
            ch.fasrv.fanotes.desk.HOMEWORK_EYEBROW.uppercase(java.util.Locale.GERMAN),
            color = accent,
            fontSize = ch.fasrv.fanotes.desk.HOMEWORK_EYEBROW_SP.sp,
            fontWeight = FontWeight(ch.fasrv.fanotes.desk.HOMEWORK_EYEBROW_WEIGHT),
            letterSpacing = ch.fasrv.fanotes.desk.HOMEWORK_EYEBROW_TRACKING.em,
        )
    }
    Text(
        ch.fasrv.fanotes.desk.HOMEWORK_TITLE,
        color = MaterialTheme.colorScheme.onSurface,
        fontSize = ch.fasrv.fanotes.desk.HOMEWORK_TITLE_SP.sp,
        fontWeight = FontWeight(ch.fasrv.fanotes.desk.HOMEWORK_TITLE_WEIGHT),
        letterSpacing = ch.fasrv.fanotes.desk.HOMEWORK_TITLE_TRACKING.em,
    )
    HomeworkIntro()
}

@Composable
private fun HomeworkIntro() {
    val ink = LocalStatusInk.current
    val density = LocalDensity.current
    val path = ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH
    val codeStyle = TextStyle(
        color = ink.muted,
        fontSize = ch.fasrv.fanotes.desk.HOMEWORK_CODE_SP.sp,
        fontFamily = FontFamily.Monospace,
    )
    val measured = rememberTextMeasurer().measure(path, style = codeStyle)
    val chipWidth = with(density) {
        measured.size.width.toDp() + (ch.fasrv.fanotes.desk.HOMEWORK_CODE_PAD_X_DP * 2).dp + 2.dp
    }
    val chipHeight = with(density) {
        measured.size.height.toDp() + (ch.fasrv.fanotes.desk.HOMEWORK_CODE_PAD_Y_DP * 2).dp
    }
    val chip = "homework-note"
    Text(
        text = buildAnnotatedString {
            append(ch.fasrv.fanotes.desk.HOMEWORK_INTRO)
            append(" ")
            appendInlineContent(chip, path)
            append(".")
        },
        modifier = Modifier
            .widthIn(max = ch.fasrv.fanotes.desk.HOMEWORK_INTRO_MAX_DP.dp)
            .padding(top = ch.fasrv.fanotes.desk.HOMEWORK_INTRO_GAP_DP.dp),
        color = ink.muted,
        fontSize = ch.fasrv.fanotes.desk.HOMEWORK_INTRO_SP.sp,
        lineHeight = (ch.fasrv.fanotes.desk.HOMEWORK_INTRO_SP * ch.fasrv.fanotes.desk.HOMEWORK_INTRO_LINE).sp,
        inlineContent = mapOf(
            chip to InlineTextContent(
                Placeholder(
                    width = with(density) { chipWidth.toSp() },
                    height = with(density) { chipHeight.toSp() },
                    placeholderVerticalAlign = PlaceholderVerticalAlign.TextCenter,
                ),
            ) {
                Box(
                    Modifier
                        .fillMaxSize()
                        .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.HOMEWORK_CODE_RADIUS_DP.dp))
                        .background(ink.panelStrong.copy(alpha = ch.fasrv.fanotes.desk.HOMEWORK_CODE_FILL)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(path, style = codeStyle, maxLines = 1)
                }
            },
        ),
    )
}

@Composable
private fun HomeworkHeaderActions(onOpen: () -> Unit, onClose: () -> Unit) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.HOMEWORK_ACTION_RADIUS_DP.dp)
    val ink = LocalStatusInk.current
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    val fill = ink.panelStrong.copy(alpha = ch.fasrv.fanotes.desk.HOMEWORK_SECONDARY_FILL)
    Row(
        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.HOMEWORK_ACTION_GAP_DP.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .height(ch.fasrv.fanotes.desk.HOMEWORK_ACTION_DP.dp)
                .clip(shape)
                .border(1.dp, rule, shape)
                .background(fill)
                .clickable(onClick = onOpen)
                .padding(horizontal = ch.fasrv.fanotes.desk.HOMEWORK_SECONDARY_PAD_X_DP.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                ch.fasrv.fanotes.desk.HOMEWORK_OPEN_NOTE,
                color = ink.soft,
                fontSize = 12.sp,
                fontWeight = FontWeight(ch.fasrv.fanotes.desk.HOMEWORK_SECONDARY_WEIGHT),
            )
        }
        Box(
            Modifier
                .size(ch.fasrv.fanotes.desk.HOMEWORK_ACTION_DP.dp)
                .clip(shape)
                .border(1.dp, rule, shape)
                .background(fill)
                .clickable(onClick = onClose),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Filled.Close,
                contentDescription = ch.fasrv.fanotes.desk.HOMEWORK_CLOSE,
                modifier = Modifier.size(ch.fasrv.fanotes.desk.HOMEWORK_CLOSE_ICON_DP.dp),
                tint = ink.soft,
            )
        }
    }
}

@Composable
private fun HomeworkStatsRow(stats: ch.fasrv.fanotes.desk.HomeworkStats) {
    FlowRow(
        Modifier.fillMaxWidth().padding(bottom = ch.fasrv.fanotes.desk.HOMEWORK_STATS_MARGIN_DP.dp),
        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.HOMEWORK_STATS_GAP_DP.dp),
        verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.HOMEWORK_STATS_GAP_DP.dp),
    ) {
        HomeworkStat(stats.open, ch.fasrv.fanotes.desk.HOMEWORK_STAT_OPEN, warn = false)
        HomeworkStat(stats.overdue, ch.fasrv.fanotes.desk.HOMEWORK_STAT_OVERDUE, warn = true)
        HomeworkStat(stats.today, ch.fasrv.fanotes.desk.HOMEWORK_STAT_TODAY, warn = false)
        HomeworkStat(stats.appointments, ch.fasrv.fanotes.desk.HOMEWORK_STAT_APPOINTMENTS, warn = false)
        HomeworkStat(stats.done, ch.fasrv.fanotes.desk.HOMEWORK_STAT_DONE, warn = false)
    }
}

@Composable
private fun HomeworkStat(count: Int, label: String, warn: Boolean) {
    val ink = LocalStatusInk.current
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    val border = if (warn) homeworkMix(rule, ink.warning, ch.fasrv.fanotes.desk.HOMEWORK_STAT_WARN_MIX) else rule
    val shape = RoundedCornerShape(999.dp)
    Row(
        Modifier
            .heightIn(min = ch.fasrv.fanotes.desk.HOMEWORK_STAT_MIN_DP.dp)
            .clip(shape)
            .border(1.dp, border, shape)
            .background(MaterialTheme.colorScheme.surface.copy(alpha = ch.fasrv.fanotes.desk.HOMEWORK_STAT_FILL))
            .padding(horizontal = ch.fasrv.fanotes.desk.HOMEWORK_STAT_PAD_X_DP.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.HOMEWORK_STAT_GAP_DP.dp),
    ) {
        Text(
            count.toString(),
            color = MaterialTheme.colorScheme.onSurface,
            fontSize = ch.fasrv.fanotes.desk.HOMEWORK_STAT_SP.sp,
            fontWeight = FontWeight(ch.fasrv.fanotes.desk.HOMEWORK_STAT_WEIGHT),
        )
        Text(
            label,
            color = if (warn) ink.warning else ink.muted,
            fontSize = ch.fasrv.fanotes.desk.HOMEWORK_STAT_SP.sp,
        )
    }
}

@Composable
private fun HomeworkComposer(
    columns: Int,
    title: String,
    onTitle: (String) -> Unit,
    kind: String,
    onKind: (String) -> Unit,
    subject: String,
    onSubject: (String) -> Unit,
    suggestions: List<String>,
    due: String,
    onDue: (String) -> Unit,
    dueTime: String,
    onDueTime: (String) -> Unit,
    priority: String,
    onPriority: (String) -> Unit,
    notes: String,
    onNotes: (String) -> Unit,
    onSubmit: () -> Unit,
) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.HOMEWORK_COMPOSER_RADIUS_DP.dp)
    val strong = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)
    val suggestionScroll = rememberScrollState()
    Column(
        Modifier
            .fillMaxWidth()
            .padding(bottom = ch.fasrv.fanotes.desk.HOMEWORK_COMPOSER_MARGIN_DP.dp)
            .shadow(
                elevation = ch.fasrv.fanotes.desk.HOMEWORK_COMPOSER_SHADOW_DP.dp,
                shape = shape,
                ambientColor = Color.Black.copy(alpha = ch.fasrv.fanotes.desk.HOMEWORK_COMPOSER_SHADOW_ALPHA),
                spotColor = Color.Black.copy(alpha = ch.fasrv.fanotes.desk.HOMEWORK_COMPOSER_SHADOW_ALPHA),
            )
            .clip(shape)
            .border(1.dp, strong, shape)
            .background(LocalStatusInk.current.panelStrong.copy(alpha = ch.fasrv.fanotes.desk.HOMEWORK_COMPOSER_FILL))
            .padding(ch.fasrv.fanotes.desk.HOMEWORK_COMPOSER_PAD_DP.dp),
        verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.HOMEWORK_COMPOSER_GAP_DP.dp),
    ) {
        HomeworkComposerFields(columns, title, onTitle, kind, onKind, subject, onSubject, due, onDue, dueTime, onDueTime, priority, onPriority)
        if (suggestions.isNotEmpty()) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(suggestionScroll),
                horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.HOMEWORK_CHIP_GAP_DP.dp),
            ) {
                suggestions.forEach { choice ->
                    HomeworkSuggestion(choice) { onSubject(choice) }
                }
            }
        }
        HomeworkTextField(
            ch.fasrv.fanotes.desk.HOMEWORK_NOTES_LABEL,
            notes,
            onNotes,
            ch.fasrv.fanotes.desk.HOMEWORK_NOTES_PLACEHOLDER,
            singleLine = false,
            minHeight = ch.fasrv.fanotes.desk.HOMEWORK_NOTES_MIN_DP.dp,
            textWeight = ch.fasrv.fanotes.desk.HOMEWORK_NOTES_WEIGHT,
            modifier = Modifier.fillMaxWidth(),
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            HomeworkAddButton(enabled = title.isNotBlank(), onClick = onSubmit)
        }
    }
}

@Composable
private fun HomeworkComposerFields(
    columns: Int,
    title: String,
    onTitle: (String) -> Unit,
    kind: String,
    onKind: (String) -> Unit,
    subject: String,
    onSubject: (String) -> Unit,
    due: String,
    onDue: (String) -> Unit,
    dueTime: String,
    onDueTime: (String) -> Unit,
    priority: String,
    onPriority: (String) -> Unit,
) {
    val gap = ch.fasrv.fanotes.desk.HOMEWORK_COMPOSER_ROW_GAP_DP.dp
    if (columns >= ch.fasrv.fanotes.desk.HOMEWORK_COMPOSER_WIDE_COLUMNS) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.Top) {
            HomeworkTextField(
                ch.fasrv.fanotes.desk.HOMEWORK_TASK_LABEL,
                title,
                onTitle,
                ch.fasrv.fanotes.desk.HOMEWORK_TASK_PLACEHOLDER,
                modifier = Modifier.weight(ch.fasrv.fanotes.desk.HOMEWORK_GROW_FR),
            )
            HomeworkSelect(
                ch.fasrv.fanotes.desk.HOMEWORK_KIND_FIELD,
                kind,
                listOf(
                    "homework" to ch.fasrv.fanotes.desk.HOMEWORK_KIND_HOMEWORK,
                    "appointment" to ch.fasrv.fanotes.desk.HOMEWORK_KIND_APPOINTMENT,
                ),
                onKind,
                Modifier.weight(ch.fasrv.fanotes.desk.HOMEWORK_TRACK_FR),
            )
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.Top) {
            HomeworkTextField(ch.fasrv.fanotes.desk.HOMEWORK_SUBJECT_LABEL, subject, onSubject, ch.fasrv.fanotes.desk.HOMEWORK_SUBJECT_PLACEHOLDER, modifier = Modifier.weight(ch.fasrv.fanotes.desk.HOMEWORK_GROW_FR))
            HomeworkTextField(ch.fasrv.fanotes.desk.HOMEWORK_DATE_LABEL, due, onDue, modifier = Modifier.weight(ch.fasrv.fanotes.desk.HOMEWORK_TRACK_FR))
            HomeworkTextField(ch.fasrv.fanotes.desk.HOMEWORK_TIME_LABEL, dueTime, onDueTime, modifier = Modifier.weight(ch.fasrv.fanotes.desk.HOMEWORK_TRACK_FR))
            HomeworkSelect(
                ch.fasrv.fanotes.desk.HOMEWORK_PRIORITY_FIELD,
                priority,
                listOf(
                    "normal" to ch.fasrv.fanotes.desk.HOMEWORK_PRIORITY_NORMAL,
                    "high" to ch.fasrv.fanotes.desk.HOMEWORK_PRIORITY_HIGH,
                ),
                onPriority,
                Modifier.weight(ch.fasrv.fanotes.desk.HOMEWORK_TRACK_FR),
            )
        }
    } else if (columns == 2) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(gap)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.Top) {
                HomeworkTextField(ch.fasrv.fanotes.desk.HOMEWORK_TASK_LABEL, title, onTitle, ch.fasrv.fanotes.desk.HOMEWORK_TASK_PLACEHOLDER, modifier = Modifier.weight(1f))
                HomeworkSelect(
                    ch.fasrv.fanotes.desk.HOMEWORK_KIND_FIELD,
                    kind,
                    listOf(
                        "homework" to ch.fasrv.fanotes.desk.HOMEWORK_KIND_HOMEWORK,
                        "appointment" to ch.fasrv.fanotes.desk.HOMEWORK_KIND_APPOINTMENT,
                    ),
                    onKind,
                    Modifier.weight(1f),
                )
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.Top) {
                HomeworkTextField(ch.fasrv.fanotes.desk.HOMEWORK_SUBJECT_LABEL, subject, onSubject, ch.fasrv.fanotes.desk.HOMEWORK_SUBJECT_PLACEHOLDER, modifier = Modifier.weight(1f))
                HomeworkTextField(ch.fasrv.fanotes.desk.HOMEWORK_DATE_LABEL, due, onDue, modifier = Modifier.weight(1f))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.Top) {
                HomeworkTextField(ch.fasrv.fanotes.desk.HOMEWORK_TIME_LABEL, dueTime, onDueTime, modifier = Modifier.weight(1f))
                HomeworkSelect(
                    ch.fasrv.fanotes.desk.HOMEWORK_PRIORITY_FIELD,
                    priority,
                    listOf(
                        "normal" to ch.fasrv.fanotes.desk.HOMEWORK_PRIORITY_NORMAL,
                        "high" to ch.fasrv.fanotes.desk.HOMEWORK_PRIORITY_HIGH,
                    ),
                    onPriority,
                    Modifier.weight(1f),
                )
            }
        }
    } else {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(gap)) {
            HomeworkTextField(ch.fasrv.fanotes.desk.HOMEWORK_TASK_LABEL, title, onTitle, ch.fasrv.fanotes.desk.HOMEWORK_TASK_PLACEHOLDER, modifier = Modifier.fillMaxWidth())
            HomeworkSelect(
                ch.fasrv.fanotes.desk.HOMEWORK_KIND_FIELD,
                kind,
                listOf(
                    "homework" to ch.fasrv.fanotes.desk.HOMEWORK_KIND_HOMEWORK,
                    "appointment" to ch.fasrv.fanotes.desk.HOMEWORK_KIND_APPOINTMENT,
                ),
                onKind,
                Modifier.fillMaxWidth(),
            )
            HomeworkTextField(ch.fasrv.fanotes.desk.HOMEWORK_SUBJECT_LABEL, subject, onSubject, ch.fasrv.fanotes.desk.HOMEWORK_SUBJECT_PLACEHOLDER, modifier = Modifier.fillMaxWidth())
            HomeworkTextField(ch.fasrv.fanotes.desk.HOMEWORK_DATE_LABEL, due, onDue, modifier = Modifier.fillMaxWidth())
            HomeworkTextField(ch.fasrv.fanotes.desk.HOMEWORK_TIME_LABEL, dueTime, onDueTime, modifier = Modifier.fillMaxWidth())
            HomeworkSelect(
                ch.fasrv.fanotes.desk.HOMEWORK_PRIORITY_FIELD,
                priority,
                listOf(
                    "normal" to ch.fasrv.fanotes.desk.HOMEWORK_PRIORITY_NORMAL,
                    "high" to ch.fasrv.fanotes.desk.HOMEWORK_PRIORITY_HIGH,
                ),
                onPriority,
                Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun HomeworkField(label: String, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.HOMEWORK_FIELD_GAP_DP.dp)) {
        Text(
            label.uppercase(java.util.Locale.GERMAN),
            color = LocalStatusInk.current.muted,
            fontSize = ch.fasrv.fanotes.desk.HOMEWORK_FIELD_SP.sp,
            fontWeight = FontWeight(ch.fasrv.fanotes.desk.HOMEWORK_FIELD_WEIGHT),
            letterSpacing = ch.fasrv.fanotes.desk.HOMEWORK_FIELD_TRACKING.em,
        )
        content()
    }
}

@Composable
private fun HomeworkTextField(
    label: String,
    value: String,
    onValue: (String) -> Unit,
    placeholder: String = "",
    singleLine: Boolean = true,
    minHeight: Dp = ch.fasrv.fanotes.desk.HOMEWORK_INPUT_MIN_DP.dp,
    textWeight: Int = ch.fasrv.fanotes.desk.HOMEWORK_INPUT_WEIGHT,
    modifier: Modifier = Modifier,
) {
    var focused by remember { mutableStateOf(false) }
    HomeworkField(label, modifier) {
        HomeworkChrome(focused = focused, minHeight = minHeight) {
            BasicTextField(
                value = value,
                onValueChange = onValue,
                singleLine = singleLine,
                textStyle = TextStyle(
                    color = MaterialTheme.colorScheme.onSurface,
                    fontSize = ch.fasrv.fanotes.desk.HOMEWORK_INPUT_SP.sp,
                    fontWeight = FontWeight(textWeight),
                    lineHeight = (ch.fasrv.fanotes.desk.HOMEWORK_INPUT_SP * ch.fasrv.fanotes.desk.HOMEWORK_INPUT_LINE).sp,
                ),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused },
                decorationBox = { inner ->
                    Box(Modifier.fillMaxWidth()) {
                        if (value.isEmpty() && placeholder.isNotEmpty()) {
                            Text(
                                placeholder,
                                color = LocalStatusInk.current.muted,
                                fontSize = ch.fasrv.fanotes.desk.HOMEWORK_INPUT_SP.sp,
                                fontWeight = FontWeight(textWeight),
                                maxLines = if (singleLine) 1 else Int.MAX_VALUE,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        inner()
                    }
                },
            )
        }
    }
}

@Composable
private fun HomeworkSelect(
    label: String,
    value: String,
    options: List<Pair<String, String>>,
    onPick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var open by remember { mutableStateOf(false) }
    val current = options.firstOrNull { it.first == value }?.second ?: options.firstOrNull()?.second.orEmpty()
    HomeworkField(label, modifier) {
        Box(Modifier.fillMaxWidth()) {
            HomeworkChrome(focused = open, minHeight = ch.fasrv.fanotes.desk.HOMEWORK_INPUT_MIN_DP.dp, onClick = { open = true }) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        current,
                        modifier = Modifier.weight(1f),
                        color = MaterialTheme.colorScheme.onSurface,
                        fontSize = ch.fasrv.fanotes.desk.HOMEWORK_INPUT_SP.sp,
                        fontWeight = FontWeight(ch.fasrv.fanotes.desk.HOMEWORK_INPUT_WEIGHT),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Icon(
                        Icons.Filled.ArrowDropDown,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                        tint = LocalStatusInk.current.muted,
                    )
                }
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                options.forEach { (id, name) ->
                    DropdownMenuItem(text = { Text(name) }, onClick = { onPick(id); open = false })
                }
            }
        }
    }
}

@Composable
private fun HomeworkChrome(
    focused: Boolean,
    minHeight: Dp,
    onClick: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.HOMEWORK_INPUT_RADIUS_DP.dp)
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    val primary = MaterialTheme.colorScheme.primary
    val border = if (focused) homeworkMix(rule, primary, ch.fasrv.fanotes.desk.HOMEWORK_FOCUS_BORDER) else rule
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = minHeight)
            .drawBehind {
                if (!focused) return@drawBehind
                val stroke = ch.fasrv.fanotes.desk.HOMEWORK_FOCUS_RING_DP.dp.toPx()
                drawRoundRect(
                    color = primary.copy(alpha = ch.fasrv.fanotes.desk.HOMEWORK_FOCUS_RING),
                    topLeft = Offset(-stroke / 2f, -stroke / 2f),
                    size = Size(size.width + stroke, size.height + stroke),
                    cornerRadius = CornerRadius(ch.fasrv.fanotes.desk.HOMEWORK_INPUT_RADIUS_DP.dp.toPx() + stroke / 2f),
                    style = Stroke(width = stroke),
                )
            }
            .clip(shape)
            .border(1.dp, border, shape)
            .background(MaterialTheme.colorScheme.surface)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(
                horizontal = ch.fasrv.fanotes.desk.HOMEWORK_INPUT_PAD_X_DP.dp,
                vertical = ch.fasrv.fanotes.desk.HOMEWORK_INPUT_PAD_Y_DP.dp,
            ),
        contentAlignment = Alignment.CenterStart,
    ) {
        content()
    }
}

@Composable
private fun HomeworkAddButton(enabled: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.HOMEWORK_INPUT_RADIUS_DP.dp)
    val ink = MaterialTheme.colorScheme.background
    val fill = MaterialTheme.colorScheme.onSurface
    Row(
        Modifier
            .heightIn(min = ch.fasrv.fanotes.desk.HOMEWORK_INPUT_MIN_DP.dp)
            .alpha(if (enabled) 1f else ch.fasrv.fanotes.desk.HOMEWORK_PRIMARY_DISABLED)
            .clip(shape)
            .border(1.dp, fill, shape)
            .background(fill)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = ch.fasrv.fanotes.desk.HOMEWORK_PRIMARY_PAD_X_DP.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.HOMEWORK_PRIMARY_GAP_DP.dp),
    ) {
        Icon(
            Icons.Filled.Add,
            contentDescription = null,
            modifier = Modifier.size(ch.fasrv.fanotes.desk.HOMEWORK_PRIMARY_ICON_DP.dp),
            tint = ink,
        )
        Text(
            ch.fasrv.fanotes.desk.HOMEWORK_ADD,
            color = ink,
            fontSize = 12.sp,
            fontWeight = FontWeight(ch.fasrv.fanotes.desk.HOMEWORK_PRIMARY_WEIGHT),
        )
    }
}

@Composable
private fun HomeworkSuggestion(label: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(999.dp)
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    Box(
        Modifier
            .heightIn(min = ch.fasrv.fanotes.desk.HOMEWORK_STAT_MIN_DP.dp)
            .clip(shape)
            .border(1.dp, rule, shape)
            .background(LocalStatusInk.current.panelStrong.copy(alpha = ch.fasrv.fanotes.desk.HOMEWORK_SECONDARY_FILL))
            .clickable(onClick = onClick)
            .padding(horizontal = ch.fasrv.fanotes.desk.HOMEWORK_STAT_PAD_X_DP.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = LocalStatusInk.current.muted, fontSize = 12.sp, fontWeight = FontWeight(650))
    }
}

@Composable
private fun HomeworkChoiceRow(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    FlowRow(
        Modifier.fillMaxWidth().padding(bottom = ch.fasrv.fanotes.desk.HOMEWORK_CHIP_MARGIN_DP.dp),
        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.HOMEWORK_CHIP_GAP_DP.dp),
        verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.HOMEWORK_CHIP_GAP_DP.dp),
    ) {
        options.forEach { (id, label) ->
            HomeworkChoice(label, active = selected == id) { onSelect(id) }
        }
    }
}

@Composable
private fun HomeworkChoice(label: String, active: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(999.dp)
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    val primary = MaterialTheme.colorScheme.primary
    val border = if (active) homeworkMix(rule, primary, ch.fasrv.fanotes.desk.HOMEWORK_CHIP_ACTIVE_BORDER) else rule
    val fill = if (active) {
        primary.copy(alpha = ch.fasrv.fanotes.desk.HOMEWORK_CHIP_ACTIVE_FILL)
    } else {
        LocalStatusInk.current.panelStrong.copy(alpha = ch.fasrv.fanotes.desk.HOMEWORK_SECONDARY_FILL)
    }
    val color = if (active) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.soft
    Box(
        Modifier
            .heightIn(min = ch.fasrv.fanotes.desk.HOMEWORK_CHIP_MIN_DP.dp)
            .clip(shape)
            .border(1.dp, border, shape)
            .background(fill)
            .clickable(onClick = onClick)
            .padding(horizontal = ch.fasrv.fanotes.desk.HOMEWORK_CHIP_PAD_X_DP.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            color = color,
            fontSize = ch.fasrv.fanotes.desk.HOMEWORK_CHIP_SP.sp,
            fontWeight = FontWeight(ch.fasrv.fanotes.desk.HOMEWORK_CHIP_WEIGHT),
        )
    }
}

@Composable
private fun HomeworkEmpty() {
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = 12.dp)
            .heightIn(min = ch.fasrv.fanotes.desk.HOMEWORK_EMPTY_MIN_DP.dp)
            .drawBehind {
                val stroke = 1.dp.toPx()
                val inset = stroke / 2f
                drawRoundRect(
                    color = rule,
                    topLeft = Offset(inset, inset),
                    size = Size(size.width - stroke, size.height - stroke),
                    cornerRadius = CornerRadius(ch.fasrv.fanotes.desk.HOMEWORK_CARD_RADIUS_DP.dp.toPx()),
                    style = Stroke(
                        width = stroke,
                        pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx())),
                    ),
                )
            }
            .padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
    ) {
        Text(ch.fasrv.fanotes.desk.HOMEWORK_EMPTY_TITLE, color = MaterialTheme.colorScheme.onSurface, fontSize = 14.sp, fontWeight = FontWeight.Bold)
        Text(
            ch.fasrv.fanotes.desk.HOMEWORK_EMPTY_BODY,
            modifier = Modifier.widthIn(max = 360.dp),
            color = LocalStatusInk.current.muted,
            fontSize = 12.sp,
            lineHeight = 18.6.sp,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun HomeworkBucket(
    bucket: String,
    items: List<ch.fasrv.fanotes.desk.HomeworkTask>,
    model: FaNotesViewModel,
    toggle: String? = null,
    onToggle: () -> Unit = {},
) {
    val ink = LocalStatusInk.current
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    Column(Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 16.dp)) {
        Row(
            Modifier.fillMaxWidth().padding(bottom = ch.fasrv.fanotes.desk.HOMEWORK_BUCKET_GAP_DP.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.HOMEWORK_BUCKET_GAP_DP.dp),
        ) {
            Text(
                ch.fasrv.fanotes.desk.homeworkBucketLabel(bucket).uppercase(java.util.Locale.GERMAN),
                color = ink.soft,
                fontSize = 12.sp,
                fontWeight = FontWeight(750),
                letterSpacing = 0.04.em,
            )
            Box(
                Modifier
                    .height(ch.fasrv.fanotes.desk.HOMEWORK_COUNT_DP.dp)
                    .widthIn(min = ch.fasrv.fanotes.desk.HOMEWORK_COUNT_DP.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
                    .padding(horizontal = 4.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(items.size.toString(), color = ink.muted, fontSize = 12.sp)
            }
            if (toggle != null) {
                Spacer(Modifier.weight(1f))
                Text(
                    toggle,
                    color = accent,
                    fontSize = 12.sp,
                    fontWeight = FontWeight(700),
                    modifier = Modifier.clickable(onClick = onToggle),
                )
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.HOMEWORK_CARDS_GAP_DP.dp)) {
            items.forEach { task ->
                HomeworkTaskCard(task, bucket, { model.toggleHomework(task.id) }, { model.removeHomework(task.id) })
            }
        }
    }
}

@Composable
private fun HomeworkTaskCard(
    task: ch.fasrv.fanotes.desk.HomeworkTask,
    bucket: String,
    onToggle: () -> Unit,
    onDelete: () -> Unit,
) {
    val ink = LocalStatusInk.current
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    val danger = MaterialTheme.colorScheme.error
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    val overdue = bucket == "overdue"
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.HOMEWORK_CARD_RADIUS_DP.dp)
    val actionShape = RoundedCornerShape(ch.fasrv.fanotes.desk.HOMEWORK_CARD_ACTION_RADIUS_DP.dp)
    val borderColor = if (overdue) homeworkMix(rule, danger, ch.fasrv.fanotes.desk.HOMEWORK_OVERDUE_BORDER) else rule
    val fill = if (overdue) {
        homeworkMix(ink.panelStrong, danger, ch.fasrv.fanotes.desk.HOMEWORK_OVERDUE_FILL)
    } else {
        ink.panelStrong.copy(alpha = ch.fasrv.fanotes.desk.HOMEWORK_CARD_FILL_ALPHA)
    }
    val inset = ch.fasrv.fanotes.desk.homeworkCardInset(task)
    val deleteHover = remember { MutableInteractionSource() }
    val deleteHovered by deleteHover.collectIsHoveredAsState()
    Box(
        Modifier
            .fillMaxWidth()
            .alpha(if (task.done) ch.fasrv.fanotes.desk.HOMEWORK_CARD_DONE_ALPHA else 1f)
            .clip(shape)
            .border(1.dp, borderColor, shape)
            .background(fill)
            .drawBehind {
                if (inset == "none") return@drawBehind
                drawRect(
                    color = if (inset == "accent") accent else ink.warning,
                    size = Size(ch.fasrv.fanotes.desk.HOMEWORK_CARD_INSET_DP.dp.toPx(), size.height),
                )
            },
    ) {
        Row(
            Modifier.fillMaxWidth().padding(ch.fasrv.fanotes.desk.HOMEWORK_CARD_PAD_DP.dp),
            horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.HOMEWORK_CARD_GAP_DP.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Box(
                Modifier
                    .size(ch.fasrv.fanotes.desk.HOMEWORK_CARD_ACTION_DP.dp)
                    .clip(actionShape)
                    .border(1.dp, rule, actionShape)
                    .clickable(onClick = onToggle),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (task.done) Icons.Filled.CheckCircle else Icons.Outlined.Circle,
                    contentDescription = if (task.done) ch.fasrv.fanotes.desk.HOMEWORK_MARK_OPEN else ch.fasrv.fanotes.desk.HOMEWORK_MARK_DONE,
                    modifier = Modifier.size(18.dp),
                    tint = accent,
                )
            }
            Column(Modifier.weight(1f).padding(top = 4.dp)) {
                Row(
                    Modifier.fillMaxWidth().padding(bottom = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        task.title,
                        modifier = Modifier.weight(1f),
                        color = if (task.done) ink.muted else MaterialTheme.colorScheme.onSurface,
                        fontSize = 13.sp,
                        fontWeight = FontWeight(700),
                        lineHeight = 16.9.sp,
                        textDecoration = if (task.done) TextDecoration.LineThrough else null,
                    )
                    Text(
                        ch.fasrv.fanotes.desk.homeworkKindLabel(task.kind).uppercase(java.util.Locale.GERMAN),
                        modifier = Modifier
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.07f))
                            .padding(horizontal = 7.dp, vertical = 2.dp),
                        color = ink.muted,
                        fontSize = 12.sp,
                        fontWeight = FontWeight(800),
                        letterSpacing = 0.05.em,
                    )
                }
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (task.subject.isNotBlank()) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Icon(Icons.AutoMirrored.Filled.MenuBook, contentDescription = null, modifier = Modifier.size(12.dp), tint = ink.muted)
                            Text(task.subject, color = ink.muted, fontSize = 12.sp)
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Icon(
                            if (task.kind == "appointment") Icons.Filled.Alarm else Icons.Filled.CalendarMonth,
                            contentDescription = null,
                            modifier = Modifier.size(12.dp),
                            tint = if (overdue) danger else ink.muted,
                        )
                        Text(
                            ch.fasrv.fanotes.desk.homeworkDueLabel(task),
                            color = if (overdue) danger else ink.muted,
                            fontSize = 12.sp,
                            fontWeight = if (overdue) FontWeight(700) else FontWeight.Normal,
                        )
                    }
                    if (task.priority == "high") {
                        Text(ch.fasrv.fanotes.desk.HOMEWORK_PRIORITY_HIGH, color = ink.warning, fontSize = 12.sp, fontWeight = FontWeight(800))
                    }
                }
                if (task.notes.isNotBlank()) {
                    Text(task.notes, modifier = Modifier.padding(top = 4.dp), color = ink.soft, fontSize = 12.sp, lineHeight = 18.sp)
                }
            }
            Box(
                Modifier
                    .size(ch.fasrv.fanotes.desk.HOMEWORK_CARD_ACTION_DP.dp)
                    .clip(actionShape)
                    .border(1.dp, rule, actionShape)
                    .hoverable(deleteHover)
                    .background(if (deleteHovered) danger.copy(alpha = 0.10f) else Color.Transparent)
                    .clickable(interactionSource = deleteHover, indication = null, onClick = onDelete),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Filled.Delete,
                    contentDescription = ch.fasrv.fanotes.desk.HOMEWORK_DELETE,
                    modifier = Modifier.size(15.dp),
                    tint = if (deleteHovered) danger else ink.muted,
                )
            }
        }
    }
}

private fun homeworkMix(base: Color, tint: Color, tintShare: Float): Color {
    val keep = 1f - tintShare
    return Color(
        red = base.red * keep + tint.red * tintShare,
        green = base.green * keep + tint.green * tintShare,
        blue = base.blue * keep + tint.blue * tintShare,
        alpha = base.alpha * keep + tint.alpha * tintShare,
    )
}

@Composable
fun CalendarScreen(model: FaNotesViewModel, onOpenNote: (String) -> Unit, onImportIcs: () -> Unit = {}, onExportIcs: () -> Unit = {}) {
    val document by model.calendar.collectAsStateWithLifecycle()
    val status by model.message.collectAsStateWithLifecycle()
    var dismissedReminders by remember { mutableStateOf(setOf<String>()) }
    val reminder = ch.fasrv.fanotes.desk.dueReminders(document, java.time.ZonedDateTime.now()).firstOrNull { it.key !in dismissedReminders }
    var month by remember { mutableStateOf(YearMonth.now()) }
    var title by remember { mutableStateOf("") }
    var time by remember { mutableStateOf("") }
    var anchor by remember { mutableStateOf(LocalDate.now()) }
    var view by remember { mutableStateOf("month") }
    var recurrence by remember { mutableStateOf("none") }
    var calendarQuery by remember { mutableStateOf("") }
    val calendarId = document.calendars.firstOrNull { it.visible }?.id ?: document.calendars.firstOrNull()?.id ?: "personal"
    val shown = document.copy(
        events = ch.fasrv.fanotes.desk.visibleCalendarEvents(document).filter { event ->
            val name = document.calendars.find { it.id == event.calendarId }?.name.orEmpty()
            ch.fasrv.fanotes.desk.calendarEventMatches(event, name, calendarQuery)
        },
    )
    var calendarName by remember { mutableStateOf("") }
    var editor by remember { mutableStateOf<CalendarDraft?>(null) }
    val day = anchor.toString()
    fun shiftCalendar(step: Int) {
        val next = ch.fasrv.fanotes.desk.calendarShift(view, anchor, step)
        anchor = next
        if (view == "month") month = YearMonth.from(next)
    }
    fun openNewEvent() {
        val now = java.time.LocalTime.now()
        val snapped = ch.fasrv.fanotes.desk.snapCalendarClock(now.hour, now.minute)
        val start = LocalDate.now().plusDays(snapped.dayOffset.toLong()).atTime(snapped.hour, snapped.minute)
        editor = draftForCreate(document, start.toLocalDate(), start, start.plusHours(1), false)
    }
    val calendarFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { calendarFocus.requestFocus() } }
    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .focusRequester(calendarFocus)
            .focusable()
            .onKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onKeyEvent false
                val name = when (event.key) {
                    Key.T -> "t"
                    Key.N -> "n"
                    Key.DirectionLeft -> "left"
                    Key.DirectionRight -> "right"
                    Key.One, Key.NumPad1 -> "1"
                    Key.Two, Key.NumPad2 -> "2"
                    Key.Three, Key.NumPad3 -> "3"
                    Key.Four, Key.NumPad4 -> "4"
                    Key.Five, Key.NumPad5 -> "5"
                    else -> return@onKeyEvent false
                }
                val action = ch.fasrv.fanotes.desk.calendarKeyAction(
                    name,
                    event.isCtrlPressed,
                    event.isAltPressed,
                    event.isMetaPressed,
                ) ?: return@onKeyEvent false
                when (action) {
                    "today" -> {
                        anchor = LocalDate.now()
                        month = YearMonth.now()
                    }
                    "new" -> openNewEvent()
                    "previous" -> shiftCalendar(-1)
                    "next" -> shiftCalendar(1)
                    "day", "three", "week", "month", "agenda" -> {
                        view = action
                        if (action == "month") month = YearMonth.from(anchor)
                    }
                }
                true
            },
    ) {
        val showSide = ch.fasrv.fanotes.desk.calendarShowsSide(maxWidth.value.toInt())
        val notePin = ch.fasrv.fanotes.desk.calendarNoteButtonPins(showSide)
        val sideListScroll = rememberScrollState()
        Row(Modifier.fillMaxSize()) {
            if (showSide) {
                Column(
                    Modifier
                        .width(ch.fasrv.fanotes.desk.CAL_SIDE_DP.dp)
                        .fillMaxHeight()
                        .background(MaterialTheme.colorScheme.surface)
                        .padding(start = 12.dp, end = 12.dp, top = 14.dp, bottom = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(notePin.gapDp.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Kalender", modifier = Modifier.weight(1f), fontSize = 15.sp, fontWeight = FontWeight(650), letterSpacing = (-0.01).em)
                        Box(
                            Modifier
                                .size(ch.fasrv.fanotes.desk.CAL_ICON_DP.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA), RoundedCornerShape(8.dp))
                                .clickable { model.showDestination("notes") },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(Icons.Filled.Close, contentDescription = "Schließen", modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurface)
                        }
                    }
                    CalendarMini(anchor, shown.events, onSelect = {
                        anchor = it
                        month = YearMonth.from(it)
                    }) { step ->
                        val next = ch.fasrv.fanotes.desk.calendarShift("month", anchor, step)
                        anchor = next
                        month = YearMonth.from(next)
                    }
                    val calendarList: @Composable () -> Unit = {
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .then(if (notePin.pins) Modifier.weight(1f).verticalScroll(sideListScroll) else Modifier),
                        ) {
                            CalendarLists(model, document, calendarName) { calendarName = it }
                        }
                    }
                    val openNote: @Composable () -> Unit = {
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA), RoundedCornerShape(8.dp))
                                .clickable { onOpenNote(CALENDAR_NOTE_PATH) }
                                .padding(horizontal = 10.dp, vertical = 8.dp),
                        ) { Text("Als Notiz öffnen", fontSize = 12.sp) }
                    }
                    if (notePin.lastChild) {
                        calendarList()
                        openNote()
                    } else {
                        openNote()
                        calendarList()
                    }
                }
                Box(Modifier.width(1.dp).fillMaxHeight().background(MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)))
            }
            val calendarHeader: @Composable () -> Unit = {
        if (!showSide) {
            Text("Kalender", style = MaterialTheme.typography.titleLarge)
            Text("Gespeichert in Kalender.md.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
            TextButton(onClick = { onOpenNote(CALENDAR_NOTE_PATH) }) { Text("Als Notiz öffnen") }
            CalendarLists(model, document, calendarName) { calendarName = it }
        }
        val calRule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
        val calShape = RoundedCornerShape(8.dp)
        Row(
            Modifier.fillMaxWidth().padding(bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.CAL_TOOLBAR_GAP_DP.dp),
        ) {
            Box(
                Modifier.height(ch.fasrv.fanotes.desk.CAL_TOOL_DP.dp).clip(calShape).border(1.dp, calRule, calShape).background(MaterialTheme.colorScheme.surface).clickable {
                    anchor = LocalDate.now()
                    month = YearMonth.now()
                }.padding(horizontal = 10.dp),
                contentAlignment = Alignment.Center,
            ) { Text("Heute", fontSize = 12.sp) }
            listOf(-1 to "‹", 1 to "›").forEach { (step, mark) ->
                Box(
                    Modifier.size(ch.fasrv.fanotes.desk.CAL_ICON_DP.dp).clip(calShape).border(1.dp, calRule, calShape).background(MaterialTheme.colorScheme.surface).clickable(onClickLabel = if (step < 0) "Vorheriger Zeitraum" else "Nächster Zeitraum") { shiftCalendar(step) },
                    contentAlignment = Alignment.Center,
                ) { Text(mark) }
            }
            Row(
                Modifier.weight(1f, fill = false),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    ch.fasrv.fanotes.desk.calendarHeading(view, anchor),
                    fontSize = 15.sp,
                    fontWeight = FontWeight(650),
                    letterSpacing = (-0.01).em,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (view == "week") {
                    val monday = ch.fasrv.fanotes.desk.calendarRange("week", anchor).first()
                    Text(
                        "${ch.fasrv.fanotes.desk.CAL_WEEK} ${ch.fasrv.fanotes.desk.calendarIsoWeek(monday)}",
                        fontSize = 12.sp,
                        fontWeight = FontWeight(550),
                        color = LocalStatusInk.current.muted,
                        maxLines = 1,
                    )
                }
            }
            Row(
                Modifier.weight(1f).height(ch.fasrv.fanotes.desk.CAL_TOOL_DP.dp).widthIn(min = ch.fasrv.fanotes.desk.CAL_SEARCH_MIN_DP.dp).clip(calShape).border(1.dp, calRule, calShape).padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Icons.Filled.Search, contentDescription = null, modifier = Modifier.size(14.dp), tint = LocalStatusInk.current.muted)
                BasicTextField(
                    calendarQuery,
                    { calendarQuery = it },
                    singleLine = true,
                    textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = 12.sp),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    modifier = Modifier.weight(1f),
                    decorationBox = { inner ->
                        Box(contentAlignment = Alignment.CenterStart) {
                            if (calendarQuery.isEmpty()) Text(ch.fasrv.fanotes.desk.CAL_SEARCH, color = LocalStatusInk.current.muted, fontSize = 12.sp)
                            inner()
                        }
                    },
                )
            }
            Row(
                Modifier.clip(RoundedCornerShape(ch.fasrv.fanotes.desk.CAL_VIEW_RADIUS_DP.dp)).border(1.dp, calRule, RoundedCornerShape(ch.fasrv.fanotes.desk.CAL_VIEW_RADIUS_DP.dp)).padding(2.dp),
            ) {
                listOf("day" to "Tag", "three" to "3 Tage", "week" to "Woche", "month" to "Monat", "agenda" to "Agenda").forEach { (id, label) ->
                    val active = view == id
                    Box(
                        Modifier.height(ch.fasrv.fanotes.desk.CAL_TOOL_DP.dp).clip(RoundedCornerShape(8.dp)).background(if (active) MaterialTheme.colorScheme.primary else Color.Transparent).clickable {
                            view = id
                            if (id == "month") month = YearMonth.from(anchor)
                        }.padding(horizontal = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(label, fontSize = 12.sp, color = if (active) MaterialTheme.colorScheme.background else MaterialTheme.colorScheme.onSurface)
                    }
                }
            }
            Row(
                Modifier
                    .height(ch.fasrv.fanotes.desk.CAL_TOOL_DP.dp)
                    .clip(calShape)
                    .background(MaterialTheme.colorScheme.primary)
                    .clickable { openNewEvent() }
                    .padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.background)
                Text(ch.fasrv.fanotes.desk.CAL_NEW_EVENT, fontSize = 12.sp, color = MaterialTheme.colorScheme.background)
            }
            ch.fasrv.fanotes.desk.CAL_TOOLBAR_FILE_ACTIONS.zip(listOf(onExportIcs, onImportIcs)).forEach { (label, action) ->
                Box(
                    Modifier.height(ch.fasrv.fanotes.desk.CAL_TOOL_DP.dp).clip(calShape).border(1.dp, calRule, calShape).background(MaterialTheme.colorScheme.surface).clickable(onClick = action).padding(horizontal = 10.dp),
                    contentAlignment = Alignment.Center,
                ) { Text(label, fontSize = 12.sp) }
            }
        }
        if (reminder != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "${reminder.title} beginnt ${if (reminder.minutesUntil == 0) "jetzt" else "in ${reminder.minutesUntil} min"}.",
                    color = MaterialTheme.colorScheme.error,
                    fontSize = 13.sp,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { dismissedReminders = dismissedReminders + reminder.key }) { Text("Schließen") }
            }
        }
        if (!status.isNullOrBlank()) Text(status.orEmpty(), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary)
            }
            val calendarTail: @Composable () -> Unit = {
        Text("Am $day", modifier = Modifier.padding(top = 8.dp), fontWeight = FontWeight.SemiBold)
        EventsOn(model, shown, anchor) { editor = draftFor(it, anchor) }
        editor?.let { current ->
            CalendarEventEditor(
                document = document,
                draft = current,
                onChange = { editor = it },
                onDismiss = { editor = null },
                onSave = {
                    model.saveCalendarOccurrence(if (current.creating) null else current.key, current.toEvent())
                    editor = null
                },
                onDuplicate = {
                    model.duplicateCalendarEvent(current.id)
                    editor = null
                },
                onDeleteOne = {
                    model.skipCalendarOccurrence(current.id, current.key.substringAfter('@'))
                    editor = null
                },
                onDeleteSeries = {
                    model.deleteCalendarEvent(current.id)
                    editor = null
                },
                onOpenNote = {
                    if (current.notePath.isNotBlank()) onOpenNote(current.notePath)
                    editor = null
                },
            )
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            listOf("none" to "Einmal", "daily" to "Täglich", "weekly" to "Wöchentlich", "monthly" to "Monatlich", "yearly" to "Jährlich").forEach { (id, label) ->
                TextButton(onClick = { recurrence = id }) {
                    Text(label, color = if (recurrence == id) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(title, { title = it }, label = { Text("Neuer Termin") }, modifier = Modifier.weight(1f))
            OutlinedTextField(time, { time = it }, label = { Text("Uhrzeit") }, modifier = Modifier.weight(0.5f))
            TextButton(onClick = {
                if (title.isNotBlank()) {
                    model.addCalendarEvent(title, day, calendarId, recurrence, time)
                    title = ""
                }
            }) { Text("Eintragen") }
        }
            }
            Column(
                Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .padding(16.dp)
                    .pointerInput(view) {
                        detectDeskSwipe { direction ->
                            ch.fasrv.fanotes.desk.calendarSwipeStep(direction)?.let(::shiftCalendar)
                        }
                    },
            ) {
                if (view == "month") {
                    FillingMonth(
                        Modifier.fillMaxSize(),
                        header = { calendarHeader() },
                        month = {
                            MonthGrid(
                                anchor,
                                shown,
                                onSelect = { day ->
                                    anchor = day
                                    month = java.time.YearMonth.from(day)
                                    view = "day"
                                },
                                onEdit = { event, date -> editor = draftFor(event, date) },
                                modifier = Modifier.fillMaxSize(),
                            )
                        },
                        tail = { calendarTail() },
                    )
                } else if (view == "agenda") {
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                        calendarHeader()
                        AgendaList(anchor, shown, { event, date -> editor = draftFor(event, date) }) { model.openDaily(it) }
                        CalendarRangeEmpty(view, anchor, shown)
                        calendarTail()
                    }
                } else {
                    FillingHours(
                        Modifier.fillMaxSize(),
                        header = { calendarHeader() },
                        grid = {
                            DayColumns(
                                ch.fasrv.fanotes.desk.calendarRange(view, anchor),
                                anchor,
                                shown,
                                { event, date -> editor = draftFor(event, date) },
                                { anchor = it },
                                { key, start -> model.moveCalendarOccurrence(key, start) },
                                { key, end -> model.resizeCalendarOccurrence(key, end) },
                                { date, start, end, allDay -> editor = draftForCreate(document, date, start, end, allDay) },
                                { model.openDaily(it) },
                            )
                        },
                        tail = {
                            CalendarRangeEmpty(view, anchor, shown)
                            calendarTail()
                        },
                    )
                }
            }
        }
    }
}


@Composable
private fun FillingMonth(
    modifier: Modifier,
    header: @Composable () -> Unit,
    month: @Composable () -> Unit,
    tail: @Composable () -> Unit,
) {
    val tailScroll = rememberScrollState()
    SubcomposeLayout(modifier) { constraints ->
        val width = if (constraints.hasBoundedWidth) constraints.maxWidth else 0
        val height = if (constraints.hasBoundedHeight) constraints.maxHeight else 0
        val headerPlaceable = subcompose("header") {
            Column(Modifier.fillMaxWidth()) { header() }
        }.first().measure(Constraints(maxWidth = width, maxHeight = height))
        val space = (height - headerPlaceable.height).coerceAtLeast(0)
        // Six minimum rows plus the weekday header. A taller quick-add scrolls
        // instead of shrinking the month below that floor.
        val floor = (ch.fasrv.fanotes.desk.CAL_MONTH_CELL_MIN_DP * ch.fasrv.fanotes.desk.CAL_MONTH_ROWS).dp.roundToPx() + 32.dp.roundToPx()
        val tailCap = if (space > floor) space - floor else (space * 2 / 5)
        val tailPlaceable = subcompose("tail") {
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = tailCap.toDp())
                    .verticalScroll(tailScroll),
            ) { tail() }
        }.first().measure(Constraints(maxWidth = width, maxHeight = space))
        val monthHeight = (space - tailPlaceable.height).coerceAtLeast(0)
        val monthPlaceable = subcompose("month") {
            Box(Modifier.fillMaxSize()) { month() }
        }.first().measure(Constraints.fixed(width, monthHeight))
        layout(width, height) {
            headerPlaceable.place(0, 0)
            monthPlaceable.place(0, headerPlaceable.height)
            tailPlaceable.place(0, headerPlaceable.height + monthHeight)
        }
    }
}

@Composable
private fun CalendarRangeEmpty(
    view: String,
    anchor: LocalDate,
    document: ch.fasrv.fanotes.desk.CalendarDocument,
) {
    val range = ch.fasrv.fanotes.desk.calendarRange(view, anchor)
    val occupied = range.count { date -> document.events.any { ch.fasrv.fanotes.desk.occurrencesOn(it, date) } }
    if (ch.fasrv.fanotes.desk.calendarRangeIsEmpty(view, occupied)) {
        Text(
            ch.fasrv.fanotes.desk.CAL_EMPTY,
            fontSize = 12.sp,
            color = LocalStatusInk.current.muted,
            modifier = Modifier.padding(vertical = 8.dp),
        )
    }
}

/**
 * Day, three-day, and week views. The toolbar and the quick-add stay put.
 * [grid] is the flexible remainder, the same split [FillingMonth] uses.
 */
@Composable
private fun FillingHours(
    modifier: Modifier,
    header: @Composable () -> Unit,
    grid: @Composable () -> Unit,
    tail: @Composable () -> Unit,
) {
    val tailScroll = rememberScrollState()
    SubcomposeLayout(modifier) { constraints ->
        val width = if (constraints.hasBoundedWidth) constraints.maxWidth else 0
        val height = if (constraints.hasBoundedHeight) constraints.maxHeight else 0
        val headerPlaceable = subcompose("header") {
            Column(Modifier.fillMaxWidth()) { header() }
        }.first().measure(Constraints(maxWidth = width, maxHeight = height))
        val space = (height - headerPlaceable.height).coerceAtLeast(0)
        // The grid still has to show the weekday headers, the 34dp all-day row, and one hour.
        // DayColumns measures the real header height and gives the scroller whatever is left.
        val floor = (DAY_CHROME_MIN_DP + ch.fasrv.fanotes.desk.CAL_HOUR_DP).dp.roundToPx()
        val tailCap = if (space > floor) space - floor else (space * 2 / 5)
        val tailPlaceable = subcompose("tail") {
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = tailCap.toDp())
                    .verticalScroll(tailScroll),
            ) { tail() }
        }.first().measure(Constraints(maxWidth = width, maxHeight = space))
        val gridHeight = (space - tailPlaceable.height).coerceAtLeast(0)
        val gridPlaceable = subcompose("grid") {
            Box(Modifier.fillMaxSize().clipToBounds()) { grid() }
        }.first().measure(Constraints.fixed(width, gridHeight))
        layout(width, height) {
            headerPlaceable.place(0, 0)
            gridPlaceable.place(0, headerPlaceable.height)
            tailPlaceable.place(0, headerPlaceable.height + gridHeight)
        }
    }
}

@Composable
private fun CalendarMini(
    anchor: LocalDate,
    events: List<ch.fasrv.fanotes.desk.CalendarEvent>,
    onSelect: (LocalDate) -> Unit,
    onShift: (Int) -> Unit,
) {
    val days = ch.fasrv.fanotes.desk.calendarRange("month", anchor)
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    val label = anchor.format(java.time.format.DateTimeFormatter.ofPattern("MMMM yyyy", java.util.Locale.GERMAN))
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("‹", modifier = Modifier.clickable(onClickLabel = "Vorheriger Zeitraum") { onShift(-1) }.padding(4.dp))
        Text(label, modifier = Modifier.weight(1f), textAlign = TextAlign.Center, fontSize = 12.sp, fontWeight = FontWeight(650))
        Text("›", modifier = Modifier.clickable(onClickLabel = "Nächster Zeitraum") { onShift(1) }.padding(4.dp))
    }
    Row(Modifier.fillMaxWidth().padding(top = 4.dp)) {
        listOf("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So").forEach { day ->
            Text(day.uppercase(java.util.Locale.GERMAN), modifier = Modifier.weight(1f), textAlign = TextAlign.Center, fontSize = 12.sp, fontWeight = FontWeight(700), letterSpacing = 0.04.em, color = LocalStatusInk.current.muted)
        }
    }
    days.chunked(7).forEach { week ->
        Row(Modifier.fillMaxWidth()) {
            week.forEach { date ->
                val outside = date.month != anchor.month
                val selected = date == anchor
                val today = date == LocalDate.now()
                val busy = events.any { ch.fasrv.fanotes.desk.occurrencesOn(it, date) }
                Box(
                    Modifier
                        .weight(1f)
                        .height(ch.fasrv.fanotes.desk.CAL_MINI_CELL_DP.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (selected) LocalStatusInk.current.panelActive else Color.Transparent)
                        .clickable { onSelect(date) },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        date.dayOfMonth.toString(),
                        fontSize = 12.sp,
                        color = when {
                            today -> accent
                            outside -> LocalStatusInk.current.muted
                            else -> MaterialTheme.colorScheme.onSurface
                        },
                        modifier = Modifier.alpha(if (outside) 0.55f else 1f),
                    )
                    if (busy) {
                        Box(
                            Modifier
                                .align(Alignment.BottomCenter)
                                .padding(bottom = 3.dp)
                                .size(ch.fasrv.fanotes.desk.CAL_MINI_DOT_DP.dp)
                                .clip(CircleShape)
                                .background(accent),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MonthGrid(
    anchor: LocalDate,
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    onSelect: (LocalDate) -> Unit,
    onEdit: (CalendarEvent, LocalDate) -> Unit,
    modifier: Modifier = Modifier,
) {
    val days = ch.fasrv.fanotes.desk.calendarRange("month", anchor)
    val weeks = days.chunked(7)
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    Column(modifier.fillMaxWidth().fillMaxHeight()) {
    Row(Modifier.fillMaxWidth()) {
        listOf("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So").forEach { label ->
            Text(
                label.uppercase(java.util.Locale.GERMAN),
                modifier = Modifier.weight(1f),
                textAlign = TextAlign.Center,
                fontSize = 12.sp,
                fontWeight = FontWeight(700),
                letterSpacing = 0.04.em,
                color = LocalStatusInk.current.muted,
            )
        }
    }
    BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
        val rowCount = weeks.size.coerceAtLeast(1)
        val availableDp = maxHeight.value.roundToInt().coerceAtLeast(0)
        val rowDp = ch.fasrv.fanotes.desk.monthRowHeightDp(availableDp, rowCount, ch.fasrv.fanotes.desk.CAL_MONTH_CELL_MIN_DP)
        val scrolls = with(LocalDensity.current) { (rowDp * rowCount).dp.roundToPx() > maxHeight.roundToPx() }
        val rowScroll = rememberScrollState()
        Column(
            Modifier
                .fillMaxWidth()
                .then(if (scrolls) Modifier.verticalScroll(rowScroll) else Modifier.fillMaxHeight()),
        ) {
    weeks.forEach { week ->
        Row(
            Modifier
                .fillMaxWidth()
                .then(if (scrolls) Modifier.height(rowDp.dp) else Modifier.weight(1f).heightIn(min = rowDp.dp)),
        ) {
            week.forEach { date ->
                val outside = date.month != anchor.month
                val today = date == LocalDate.now()
                val items = document.events.filter { ch.fasrv.fanotes.desk.occurrencesOn(it, date) }
                Column(
                    Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .drawBehind {
                            val stroke = 1.dp.toPx()
                            drawLine(rule, Offset(0f, 0f), Offset(size.width, 0f), stroke)
                            drawLine(rule, Offset(0f, 0f), Offset(0f, size.height), stroke)
                        }
                        .alpha(if (outside) 0.55f else 1f)
                        .padding(4.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Box(
                        Modifier
                            .size(ch.fasrv.fanotes.desk.CAL_MONTH_DAY_DP.dp)
                            .clip(CircleShape)
                            .clickable { onSelect(date) },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            date.dayOfMonth.toString(),
                            fontSize = 12.sp,
                            color = if (today) accent else if (outside) LocalStatusInk.current.muted else MaterialTheme.colorScheme.onSurface,
                        )
                    }
                    items.take(ch.fasrv.fanotes.desk.CAL_MONTH_LIMIT).forEach { event ->
                        val tint = document.calendars.find { it.id == event.calendarId }?.color ?: "#2a6f97"
                        Text(
                            ch.fasrv.fanotes.desk.monthEventLabel(event),
                            fontSize = 12.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            color = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.CAL_CHIP_RADIUS_DP.dp))
                                .background(calendarSwatch(tint).copy(alpha = ch.fasrv.fanotes.desk.CAL_CHIP_ALPHA))
                                .clickable { onEdit(event, date) }
                                .padding(horizontal = 6.dp, vertical = 2.dp),
                        )
                    }
                    val hidden = items.size - ch.fasrv.fanotes.desk.CAL_MONTH_LIMIT
                    if (hidden > 0) {
                        Text(ch.fasrv.fanotes.desk.calendarMoreLabel(hidden), fontSize = 12.sp, color = LocalStatusInk.current.muted)
                    }
                }
            }
        }
        }
        }
    }
    }
}

private const val HOUR_DP = ch.fasrv.fanotes.desk.CAL_HOUR_DP

/** Weekday header plus the all-day row minimum, reserved so the hour scroller can keep one row. */
private const val DAY_CHROME_MIN_DP = 46 + 34

@Composable
private fun DayColumns(
    days: List<LocalDate>,
    anchor: LocalDate,
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    onEdit: (CalendarEvent, LocalDate) -> Unit,
    onPick: (LocalDate) -> Unit,
    onMove: (String, LocalDateTime) -> Unit,
    onResize: (String, LocalDateTime) -> Unit,
    onCreate: (LocalDate, LocalDateTime, LocalDateTime, Boolean) -> Unit,
    onDaily: (LocalDate) -> Unit,
) {
    val scroll = rememberScrollState()
    val density = LocalDensity.current
    LaunchedEffect(days) {
        scroll.scrollTo(with(density) { (7 * HOUR_DP).dp.roundToPx() })
    }
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    val gutter = ch.fasrv.fanotes.desk.CAL_GUTTER_DP.dp
    // `.cal-scroll` is the flexible remainder under the weekday headers and the all-day row.
    // Day tracks are `56px repeat(n, minmax(0, 1fr))` and stay inside the pane.
    SubcomposeLayout(Modifier.fillMaxSize()) { constraints ->
        val bodyHeight = if (constraints.hasBoundedHeight) constraints.maxHeight else 0
        val panePx = if (constraints.hasBoundedWidth) constraints.maxWidth else 0
        val paneDp = panePx.toDp().value.roundToInt().coerceAtLeast(0)
        val column = ch.fasrv.fanotes.desk.calendarColumnDp(paneDp, days.size).dp
        val trackMax = if (constraints.hasBoundedWidth) panePx else Constraints.Infinity
        val chrome = subcompose("chrome") {
            Column {
                Row {
                    Box(Modifier.width(gutter))
                    days.forEach { date ->
                        val today = date == LocalDate.now()
                        Column(
                            Modifier
                                .width(column)
                                .clickable {
                                    onPick(date)
                                    onDaily(date)
                                }
                                .padding(bottom = 8.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            Text(
                                ch.fasrv.fanotes.desk.calendarWeekdayShort(date).uppercase(java.util.Locale.GERMAN),
                                fontSize = 12.sp,
                                color = LocalStatusInk.current.muted,
                                letterSpacing = 0.04.em,
                            )
                            Text(
                                date.dayOfMonth.toString(),
                                fontSize = ch.fasrv.fanotes.desk.CAL_HEAD_NUM_SP.sp,
                                fontWeight = FontWeight(650),
                                color = if (today) accent else MaterialTheme.colorScheme.onSurface,
                            )
                        }
                    }
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                    Box(Modifier.width(gutter).padding(top = 8.dp), contentAlignment = Alignment.CenterEnd) {
                        Text(ch.fasrv.fanotes.desk.CAL_ALL_DAY, fontSize = 12.sp, color = LocalStatusInk.current.muted, modifier = Modifier.padding(end = 8.dp))
                    }
                    days.forEach { date ->
                        Column(Modifier.width(column).padding(end = 4.dp).heightIn(min = 34.dp)) {
                            allDaySpans(document, date).forEach { span ->
                                val tint = document.calendars.find { it.id == span.event.calendarId }?.color ?: "#2a6f97"
                                Text(
                                    span.event.title,
                                    fontSize = 12.sp,
                                    maxLines = 1,
                                    color = MaterialTheme.colorScheme.onSurface,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(top = 2.dp)
                                        .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.CAL_CHIP_RADIUS_DP.dp))
                                        .background(calendarSwatch(tint).copy(alpha = ch.fasrv.fanotes.desk.CAL_CHIP_ALPHA))
                                        .clickable { onEdit(span.event, date) }
                                        .padding(horizontal = 6.dp, vertical = 2.dp),
                                )
                            }
                            Text(
                                "+",
                                fontSize = 12.sp,
                                color = LocalStatusInk.current.muted,
                                modifier = Modifier.clickable(onClickLabel = "Neuer Termin") {
                                    onCreate(date, date.atStartOfDay(), date.plusDays(1).atStartOfDay(), true)
                                }.padding(horizontal = 6.dp),
                            )
                        }
                    }
                }
            }
        }.first().measure(Constraints(maxWidth = trackMax, maxHeight = Constraints.Infinity))
        val availablePx = (bodyHeight - chrome.height).coerceAtLeast(0)
        val availableDp = availablePx.toDp().value.roundToInt().coerceAtLeast(0)
        val viewportDp = ch.fasrv.fanotes.desk.hourViewportDp(availableDp, ch.fasrv.fanotes.desk.CAL_HOUR_DP)
        val hourPx = if (viewportDp == availableDp) availablePx else viewportDp.dp.roundToPx()
        val hourHeight = hourPx.toDp()
        val hours = subcompose("hours") {
            Row(Modifier.height(hourHeight).verticalScroll(scroll)) {
                Column(Modifier.width(gutter)) {
                    for (hour in 0..23) {
                        Text(
                            "%02d:00".format(hour),
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.45f),
                            modifier = Modifier.height(HOUR_DP.dp),
                        )
                    }
                }
                days.forEach { date ->
                    HourColumn(date, timedDayLayout(document, date), document, column, onEdit, onMove, onResize, onCreate)
                }
            }
        }.first().measure(Constraints(maxWidth = trackMax, maxHeight = hourPx.coerceAtLeast(0)))
        val contentWidth = maxOf(chrome.width, hours.width)
        val layoutWidth = contentWidth.coerceIn(constraints.minWidth, constraints.maxWidth)
        val layoutHeight = if (constraints.hasBoundedHeight) {
            bodyHeight.coerceAtLeast(constraints.minHeight)
        } else {
            (chrome.height + hours.height).coerceAtLeast(constraints.minHeight)
        }
        layout(layoutWidth, layoutHeight) {
            chrome.place(0, 0)
            hours.place(0, chrome.height)
        }
    }
}

@Composable
private fun HourColumn(
    day: LocalDate,
    slices: List<LaidOutSpan>,
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    columnWidth: Dp,
    onEdit: (CalendarEvent, LocalDate) -> Unit,
    onMove: (String, LocalDateTime) -> Unit,
    onResize: (String, LocalDateTime) -> Unit,
    onCreate: (LocalDate, LocalDateTime, LocalDateTime, Boolean) -> Unit,
) {
    var draftRange by remember(day) { mutableStateOf<Pair<Int, Int>?>(null) }
    Box(Modifier.width(columnWidth).height((24 * HOUR_DP).dp).padding(end = 4.dp)) {
        for (hour in 0..23) {
            Box(
                Modifier.fillMaxWidth().height(1.dp).offset(y = (hour * HOUR_DP).dp).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f)),
            )
        }
        if (day == LocalDate.now()) {
            val now = java.time.LocalTime.now()
            val y = ch.fasrv.fanotes.desk.calendarNowOffsetDp(now.hour, now.minute, HOUR_DP).dp
            Box(Modifier.fillMaxWidth().height(2.dp).offset(y = y).background(MaterialTheme.colorScheme.error))
            Box(
                Modifier
                    .size(ch.fasrv.fanotes.desk.CAL_NOW_DOT_DP.dp)
                    .offset(x = (-4).dp, y = y - 3.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.error),
            )
        }
        BoxWithConstraints(
            Modifier.fillMaxWidth().height((24 * HOUR_DP).dp).pointerInput(day, slices) {
                val hourPx = HOUR_DP.dp.toPx()
                val minHeight = 18.dp.toPx()
                val slop = viewConfiguration.touchSlop
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    if (coversSlice(down.position.x, down.position.y, slices, size.width.toFloat(), hourPx, minHeight)) {
                        return@awaitEachGesture
                    }
                    val origin = ((down.position.y / hourPx) * 60f).toInt().coerceIn(0, 24 * 60 - 1)
                    var pointer = origin
                    var total = Offset.Zero
                    var moved = false
                    draftRange = dragCreateMinutes(origin, pointer, false)
                    val finished = drag(down.id) { change ->
                        total += change.positionChange()
                        pointer = (((down.position.y + total.y) / hourPx) * 60f).toInt()
                        if (total.getDistance() > slop) {
                            moved = true
                            change.consume()
                        }
                        draftRange = dragCreateMinutes(origin, pointer, moved)
                    }
                    val range = dragCreateMinutes(origin, pointer, finished && moved)
                    draftRange = null
                    if (!finished) return@awaitEachGesture
                    onCreate(day, minutesOn(day, range.first), minutesOn(day, range.second), false)
                }
            },
        ) {
            draftRange?.let { (startMin, endMin) ->
                val visualEnd = endMin.coerceAtMost(24 * 60)
                val top = startMin / 60f * HOUR_DP
                val block = ((visualEnd - startMin) / 60f * HOUR_DP).coerceAtLeast(18f)
                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = ch.fasrv.fanotes.desk.CAL_EVENT_INSET_DP.dp)
                        .offset(y = top.dp)
                        .height(block.dp)
                        .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.CAL_EVENT_RADIUS_DP.dp))
                        .background(LocalStatusInk.current.panelActive),
                )
            }
            slices.forEach { slice ->
                TimedBlock(slice, maxWidth, day, document, onEdit, onMove, onResize)
            }
        }
    }
}

@Composable
private fun TimedBlock(
    slice: LaidOutSpan,
    width: androidx.compose.ui.unit.Dp,
    day: LocalDate,
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    onEdit: (CalendarEvent, LocalDate) -> Unit,
    onMove: (String, LocalDateTime) -> Unit,
    onResize: (String, LocalDateTime) -> Unit,
) {
    val density = LocalDensity.current
    var dragOffset by remember(slice.key, slice.start, slice.end) { mutableStateOf(Offset.Zero) }
    var extraPx by remember(slice.key, slice.start, slice.end) { mutableFloatStateOf(0f) }
    val minutes = slice.start.hour * 60 + slice.start.minute
    val duration = java.time.Duration.between(slice.start, slice.end).toMinutes().coerceAtLeast(15)
    val top = minutes / 60f * HOUR_DP
    val height = (duration / 60f * HOUR_DP).coerceAtLeast(18f)
    val extra = with(density) { extraPx.toDp() }
    val inset = ch.fasrv.fanotes.desk.CAL_EVENT_INSET_DP.dp
    val columnWidth = width / slice.columns
    val tint = document.calendars.find { it.id == slice.event.calendarId }?.color ?: "#7f6df2"
    val eventShape = RoundedCornerShape(ch.fasrv.fanotes.desk.CAL_EVENT_RADIUS_DP.dp)
    Box(
        Modifier
            .offset { IntOffset((columnWidth * slice.column).roundToPx() + inset.roundToPx(), top.dp.roundToPx()) }
            .offset { IntOffset(dragOffset.x.roundToInt(), dragOffset.y.roundToInt()) }
            .width((columnWidth - inset * 2).coerceAtLeast(1.dp))
            .height((height.dp + extra).coerceAtLeast(18.dp))
            .clip(eventShape)
            .border(1.dp, calendarSwatch(tint), eventShape)
            .background(calendarSwatch(tint).copy(alpha = ch.fasrv.fanotes.desk.CAL_CHIP_ALPHA))
            .pointerInput(slice.key, slice.originStart, slice.originEnd) {
                val hourPx = HOUR_DP.dp.toPx()
                val columnPx = size.width.toFloat().coerceAtLeast(1f)
                val handlePx = ch.fasrv.fanotes.desk.CAL_RESIZE_DP.dp.toPx()
                val slop = viewConfiguration.touchSlop
                awaitEachGesture {
                    val down = awaitFirstDown()
                    val resizing = down.position.y >= size.height - handlePx
                    var total = Offset.Zero
                    var moved = false
                    val finished = drag(down.id) { change ->
                        total += change.positionChange()
                        if (total.getDistance() > slop) {
                            moved = true
                            if (resizing) extraPx = total.y else dragOffset = total
                            change.consume()
                        }
                    }
                    dragOffset = Offset.Zero
                    extraPx = 0f
                    if (!finished || !moved) {
                        if (!moved) onEdit(slice.event, day)
                        return@awaitEachGesture
                    }
                    val deltaMinutes = (total.y / hourPx * 60f).toInt()
                    if (resizing) {
                        val nextEnd = slice.originEnd.plusMinutes(deltaMinutes.toLong())
                        val earliest = slice.originStart.plusMinutes(15)
                        onResize(slice.key, if (nextEnd.isBefore(earliest)) earliest else nextEnd)
                    } else {
                        val dayDelta = (total.x / columnPx).roundToInt()
                        if (kotlin.math.abs(deltaMinutes) >= 15 || dayDelta != 0) {
                            onMove(slice.key, slice.originStart.plusDays(dayDelta.toLong()).plusMinutes(deltaMinutes.toLong()))
                        }
                    }
                }
            }
            .padding(horizontal = ch.fasrv.fanotes.desk.CAL_EVENT_PAD_X_DP.dp, vertical = ch.fasrv.fanotes.desk.CAL_EVENT_PAD_Y_DP.dp),
    ) {
        Text(slice.event.title, color = MaterialTheme.colorScheme.onSurface, fontSize = 12.sp, fontWeight = FontWeight(650), maxLines = 2)
        Text(
            "%02d:%02d".format(slice.originStart.hour, slice.originStart.minute),
            color = LocalStatusInk.current.muted,
            fontSize = 12.sp,
        )
    }
}

@Composable
private fun AgendaList(
    anchor: LocalDate,
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    onEdit: (CalendarEvent, LocalDate) -> Unit,
    onDaily: (LocalDate) -> Unit,
) {
    ch.fasrv.fanotes.desk.calendarRange("agenda", anchor).forEach { date ->
        val events = document.events.filter { ch.fasrv.fanotes.desk.occurrencesOn(it, date) }
        if (events.isNotEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(ch.fasrv.fanotes.desk.calendarHeading("day", date), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Text(
                    ch.fasrv.fanotes.desk.CAL_DAILY,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.clickable { onDaily(date) },
                )
            }
            events.forEach { event ->
                val color = calendarSwatch(document.calendars.find { it.id == event.calendarId }?.color ?: "#2a6f97")
                Row(
                    Modifier.fillMaxWidth().clickable { onEdit(event, date) }.padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
                    Text(ch.fasrv.fanotes.desk.agendaWhenLabel(event), fontSize = 12.sp, color = LocalStatusInk.current.muted)
                    Text(event.title, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.SemiBold)
                    ch.fasrv.fanotes.desk.agendaPlace(event)?.let { place ->
                        Text(place, fontSize = 12.sp, color = LocalStatusInk.current.muted, maxLines = 1)
                    }
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)))
            }
        }
    }
}

@Composable
private fun CalendarLists(
    model: FaNotesViewModel,
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    calendarName: String,
    onName: (String) -> Unit,
) {
    val focus = LocalFocusManager.current
    Column(
        Modifier.fillMaxWidth().padding(top = 8.dp).background(MaterialTheme.colorScheme.surfaceVariant).padding(8.dp),
    ) {
        Text("Kalender", fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        document.calendars.forEach { calendar ->
            var name by remember(calendar.id) { mutableStateOf(calendar.name) }
            var focused by remember(calendar.id) { mutableStateOf(false) }
            LaunchedEffect(calendar.name, focused) {
                if (!focused) name = calendar.name
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.padding(end = 8.dp).size(12.dp).clip(CircleShape).background(calendarSwatch(calendar.color)),
                )
                Checkbox(
                    checked = calendar.visible,
                    onCheckedChange = { model.toggleCalendarVisible(calendar.id) },
                )
                OutlinedTextField(
                    name,
                    { name = it.take(80) },
                    label = { Text("Umbenennen") },
                    modifier = Modifier.weight(1f).onFocusChanged { state ->
                        val wasFocused = focused
                        focused = state.isFocused
                        if (wasFocused && !state.isFocused) {
                            val clean = name.replace(Regex("""\s+"""), " ").trim()
                            if (clean.isEmpty()) name = calendar.name
                            else if (clean != calendar.name) model.renameCalendarList(calendar.id, clean)
                        }
                    },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
                )
                if (document.calendars.size > 1) {
                    TextButton(onClick = { model.deleteCalendarList(calendar.id) }) { Text("Entfernen") }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                calendarName,
                { onName(it.take(80)) },
                label = { Text("Neuer Kalender") },
                modifier = Modifier.weight(1f),
                singleLine = true,
            )
            TextButton(onClick = {
                if (calendarName.isNotBlank()) {
                    model.createCalendarList(calendarName)
                    onName("")
                }
            }) { Text("Hinzufügen") }
        }
    }
}

private fun calendarSwatch(hex: String): Color = runCatching {
    Color(android.graphics.Color.parseColor(hex))
}.getOrDefault(Color(0xFF2A6F97))

@Composable
private fun EventsOn(
    model: FaNotesViewModel,
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    day: LocalDate,
    onEdit: (CalendarEvent) -> Unit,
) {
    document.events.filter { ch.fasrv.fanotes.desk.occurrencesOn(it, day) }.forEach { event ->
        val repeat = when (event.recurrence) {
            "daily" -> " · täglich"
            "weekly" -> " · wöchentlich"
            "monthly" -> " · monatlich"
            "yearly" -> " · jährlich"
            else -> ""
        }
        val clock = ch.fasrv.fanotes.desk.eventClock(event)?.let { "$it " }.orEmpty()
        val swatch = document.calendars.find { it.id == event.calendarId }?.color
        Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (swatch != null) {
                    Box(Modifier.padding(end = 8.dp).size(10.dp).clip(CircleShape).background(calendarSwatch(swatch)))
                }
                Text(
                    clock + event.title + repeat + if (event.notePath.isNotBlank()) "  →" else "",
                    modifier = Modifier.weight(1f).clickable { onEdit(event) },
                )
            }
            Row(Modifier.horizontalScroll(rememberScrollState())) {
                TextButton(onClick = { onEdit(event) }) { Text("Bearbeiten") }
                TextButton(onClick = { model.shiftCalendarEvent(event.id, 1) }) { Text("+1 Tag") }
                TextButton(onClick = { model.duplicateCalendarEvent(event.id) }) { Text("Kopie") }
                if (event.recurrence != "none" && event.recurrence.isNotBlank()) {
                    TextButton(onClick = { model.skipCalendarOccurrence(event.id, day.toString()) }) { Text("Auslassen") }
                }
                TextButton(onClick = { model.deleteCalendarEvent(event.id) }) { Text("Löschen") }
            }
        }
    }
}

private data class CalendarDraft(
    val key: String,
    val id: String,
    val calendarId: String,
    val title: String,
    val startDate: String,
    val endDate: String,
    val startTime: String,
    val endTime: String,
    val allDay: Boolean,
    val location: String,
    val notes: String,
    val notePath: String,
    val recurrence: String,
    val recurrenceUntil: String,
    val exceptionDates: List<String>,
    val detaches: Boolean,
    val creating: Boolean = false,
)

private fun draftFor(event: CalendarEvent, day: LocalDate): CalendarDraft {
    val window = calendarOccurrenceWindow(event, day)
    val start = window.first
    val end = window.second
    val allDay = event.allDay || !start.contains('T')
    val repeating = event.recurrence == "daily" || event.recurrence == "weekly" || event.recurrence == "monthly" || event.recurrence == "yearly"
    return CalendarDraft(
        key = "${event.id}@$day",
        id = event.id,
        calendarId = event.calendarId,
        title = event.title,
        startDate = start.take(10),
        endDate = end.take(10),
        startTime = if (allDay) "09:00" else start.substringAfter('T').take(5).ifBlank { "09:00" },
        endTime = if (allDay) "10:00" else end.substringAfter('T').take(5).ifBlank { "10:00" },
        allDay = allDay,
        location = event.location,
        notes = event.notes,
        notePath = event.notePath,
        recurrence = if (repeating) event.recurrence else "none",
        recurrenceUntil = event.recurrenceUntil.orEmpty(),
        exceptionDates = event.exceptionDates,
        detaches = repeating && day.toString() != event.start.take(10),
    )
}

private fun draftForCreate(
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    day: LocalDate,
    start: LocalDateTime,
    end: LocalDateTime,
    allDay: Boolean,
): CalendarDraft {
    val calendarId = document.calendars.firstOrNull { it.visible }?.id ?: document.calendars.firstOrNull()?.id ?: "personal"
    val id = java.util.UUID.randomUUID().toString()
    return CalendarDraft(
        key = "$id@$day",
        id = id,
        calendarId = calendarId,
        title = "Neuer Termin",
        startDate = if (allDay) day.toString() else start.toLocalDate().toString(),
        endDate = if (allDay) day.toString() else end.toLocalDate().toString(),
        startTime = "%02d:%02d".format(start.hour, start.minute),
        endTime = "%02d:%02d".format(end.hour, end.minute),
        allDay = allDay,
        location = "",
        notes = "",
        notePath = "",
        recurrence = "none",
        recurrenceUntil = "",
        exceptionDates = emptyList(),
        detaches = false,
        creating = true,
    )
}

private fun minutesOn(day: LocalDate, minute: Int): LocalDateTime {
    val dayMinutes = 24 * 60
    val extra = minute.floorDiv(dayMinutes)
    val clock = minute.mod(dayMinutes)
    return day.plusDays(extra.toLong()).atStartOfDay().plusMinutes(clock.toLong())
}

private fun coversSlice(
    x: Float,
    y: Float,
    slices: List<LaidOutSpan>,
    widthPx: Float,
    hourPx: Float,
    minHeightPx: Float,
): Boolean {
    if (widthPx <= 0f || hourPx <= 0f) return false
    return slices.any { slice ->
        val startMin = slice.start.hour * 60 + slice.start.minute
        val top = startMin / 60f * hourPx
        val duration = java.time.Duration.between(slice.start, slice.end).toMinutes().coerceAtLeast(15)
        val height = (duration / 60f * hourPx).coerceAtLeast(minHeightPx)
        val column = widthPx / slice.columns
        val left = column * slice.column
        x in left..(left + column) && y in top..(top + height)
    }
}

private fun CalendarDraft.toEvent(): CalendarEvent {
    val cleanTitle = title.replace(Regex("""\s+"""), " ").trim().ifEmpty { "Neuer Termin" }
    return CalendarEvent(
        id = id,
        calendarId = calendarId,
        title = cleanTitle,
        start = if (allDay) startDate.trim() else "${startDate.trim()}T${startTime.trim()}",
        end = if (allDay) endDate.trim() else "${endDate.trim()}T${endTime.trim()}",
        allDay = allDay,
        location = location,
        notes = notes,
        notePath = notePath,
        recurrence = recurrence,
        recurrenceUntil = recurrenceUntil.trim().ifBlank { null },
        exceptionDates = exceptionDates,
    )
}

@Composable
private fun CalendarEventEditor(
    document: ch.fasrv.fanotes.desk.CalendarDocument,
    draft: CalendarDraft,
    onChange: (CalendarDraft) -> Unit,
    onDismiss: () -> Unit,
    onSave: () -> Unit,
    onDuplicate: () -> Unit,
    onDeleteOne: () -> Unit,
    onDeleteSeries: () -> Unit,
    onOpenNote: () -> Unit,
) {
    var error by remember(draft.key) { mutableStateOf("") }
    val calendarName = document.calendars.find { it.id == draft.calendarId }?.name ?: ch.fasrv.fanotes.desk.CAL_EDITOR_CALENDAR
    val save = {
        val dates = runCatching {
            LocalDate.parse(draft.startDate.trim())
            LocalDate.parse(draft.endDate.trim())
            if (!draft.allDay) {
                java.time.LocalTime.parse(draft.startTime.trim())
                java.time.LocalTime.parse(draft.endTime.trim())
            }
        }
        if (dates.isFailure) error = ch.fasrv.fanotes.desk.CAL_EDITOR_DATE_ERROR else onSave()
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val scrim = remember { MutableInteractionSource() }
        val card = remember { MutableInteractionSource() }
        val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.CAL_EDITOR_RADIUS_DP.dp)
        val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
        val ink = LocalStatusInk.current
        val screen = androidx.compose.ui.platform.LocalConfiguration.current
        val shadow = ch.fasrv.fanotes.desk.calEditorShadow(MaterialTheme.colorScheme.background.luminance() < 0.5f)
        Box(
            Modifier
                .fillMaxSize()
                .background(Color(ch.fasrv.fanotes.desk.CAL_EDITOR_SCRIM))
                .clickable(interactionSource = scrim, indication = null, onClick = onDismiss),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                Modifier
                    .padding(ch.fasrv.fanotes.desk.CAL_EDITOR_INSET_DP.dp)
                    .width(ch.fasrv.fanotes.desk.calEditorWidthDp(screen.screenWidthDp).dp)
                    .heightIn(max = (screen.screenHeightDp - ch.fasrv.fanotes.desk.CAL_EDITOR_INSET_DP * 2).coerceAtLeast(120).dp)
                    .clickable(interactionSource = card, indication = null, onClick = {})
                    .shadow(
                        elevation = shadow.yDp.dp,
                        shape = shape,
                        ambientColor = Color.Black.copy(alpha = shadow.alpha),
                        spotColor = Color.Black.copy(alpha = shadow.alpha),
                    )
                    .clip(shape)
                    .border(1.dp, rule, shape)
                    .background(ink.panelStrong)
                    .verticalScroll(rememberScrollState())
                    .padding(ch.fasrv.fanotes.desk.CAL_EDITOR_PAD_DP.dp),
                verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.CAL_EDITOR_GAP_DP.dp),
            ) {
                if (draft.detaches) {
                    Text(ch.fasrv.fanotes.desk.CAL_EDITOR_DETACH, fontSize = 12.sp, color = ink.muted)
                }
                CalEditorInput(
                    draft.title,
                    { onChange(draft.copy(title = it.take(240))) },
                    contentDescription = ch.fasrv.fanotes.desk.CAL_EDITOR_TITLE,
                    title = true,
                )
                CalEditorMenu(ch.fasrv.fanotes.desk.CAL_EDITOR_CALENDAR, calendarName, document.calendars.map { it.id to it.name }) {
                    onChange(draft.copy(calendarId = it))
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = draft.allDay, onCheckedChange = { onChange(draft.copy(allDay = it)) })
                    Text(ch.fasrv.fanotes.desk.CAL_EDITOR_ALL_DAY, fontSize = 12.sp, color = ink.muted)
                }
                if (draft.allDay) {
                    CalEditorField(ch.fasrv.fanotes.desk.CAL_EDITOR_START, draft.startDate, { onChange(draft.copy(startDate = it.take(10))) })
                    CalEditorField(ch.fasrv.fanotes.desk.CAL_EDITOR_END, draft.endDate, { onChange(draft.copy(endDate = it.take(10))) })
                } else {
                    CalEditorWhen(
                        ch.fasrv.fanotes.desk.CAL_EDITOR_START,
                        draft.startDate,
                        { onChange(draft.copy(startDate = it.take(10))) },
                        draft.startTime,
                        { onChange(draft.copy(startTime = it.take(5))) },
                    )
                    CalEditorWhen(
                        ch.fasrv.fanotes.desk.CAL_EDITOR_END,
                        draft.endDate,
                        { onChange(draft.copy(endDate = it.take(10))) },
                        draft.endTime,
                        { onChange(draft.copy(endTime = it.take(5))) },
                    )
                }
                if (!draft.detaches) {
                    CalEditorMenu(ch.fasrv.fanotes.desk.CAL_EDITOR_REPEAT, ch.fasrv.fanotes.desk.calEditorRepeatLabel(draft.recurrence), ch.fasrv.fanotes.desk.CAL_EDITOR_REPEATS) {
                        onChange(draft.copy(recurrence = it))
                    }
                    if (draft.recurrence != "none") {
                        CalEditorField(ch.fasrv.fanotes.desk.CAL_EDITOR_UNTIL, draft.recurrenceUntil, { onChange(draft.copy(recurrenceUntil = it.take(10))) })
                    }
                }
                CalEditorField(ch.fasrv.fanotes.desk.CAL_EDITOR_LOCATION, draft.location, { onChange(draft.copy(location = it.take(160))) })
                CalEditorField(ch.fasrv.fanotes.desk.CAL_EDITOR_NOTES, draft.notes, { onChange(draft.copy(notes = it.take(4000))) }, singleLine = false)
                CalEditorField(
                    ch.fasrv.fanotes.desk.CAL_EDITOR_NOTE,
                    draft.notePath,
                    { onChange(draft.copy(notePath = it.take(400))) },
                    placeholder = ch.fasrv.fanotes.desk.CAL_EDITOR_NOTE_HINT,
                )
                if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                FlowRow(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.CAL_EDITOR_ACTION_GAP_DP.dp),
                    verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.CAL_EDITOR_ACTION_GAP_DP.dp),
                ) {
                    if (!draft.creating) {
                        CalEditorAction(ch.fasrv.fanotes.desk.CAL_EDITOR_DUPLICATE, Icons.Filled.ContentCopy, onClick = onDuplicate)
                        if (draft.notePath.isNotBlank()) {
                            CalEditorAction(ch.fasrv.fanotes.desk.CAL_EDITOR_OPEN_NOTE, Icons.Filled.CalendarMonth, onClick = onOpenNote)
                        }
                        CalEditorAction(ch.fasrv.fanotes.desk.CAL_EDITOR_DELETE_ONE, Icons.Filled.Delete, danger = true, onClick = onDeleteOne)
                        if (draft.recurrence != "none") {
                            CalEditorAction(ch.fasrv.fanotes.desk.CAL_EDITOR_DELETE_SERIES, danger = true, onClick = onDeleteSeries)
                        }
                    }
                    Spacer(Modifier.weight(1f))
                    CalEditorAction(ch.fasrv.fanotes.desk.CAL_EDITOR_CANCEL, onClick = onDismiss)
                    CalEditorAction(ch.fasrv.fanotes.desk.CAL_EDITOR_SAVE, primary = true, onClick = save)
                }
            }
        }
    }
}

@Composable
private fun CalEditorField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    singleLine: Boolean = true,
    placeholder: String = "",
) {
    Column(verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.CAL_EDITOR_LABEL_GAP_DP.dp)) {
        Text(label, fontSize = ch.fasrv.fanotes.desk.CAL_EDITOR_LABEL_SP.sp, color = LocalStatusInk.current.muted)
        CalEditorInput(value, onChange, singleLine = singleLine, placeholder = placeholder)
    }
}

@Composable
private fun CalEditorWhen(
    label: String,
    date: String,
    onDate: (String) -> Unit,
    time: String,
    onTime: (String) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.CAL_EDITOR_WHEN_GAP_DP.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.CAL_EDITOR_LABEL_GAP_DP.dp)) {
            Text(label, fontSize = ch.fasrv.fanotes.desk.CAL_EDITOR_LABEL_SP.sp, color = LocalStatusInk.current.muted)
            CalEditorInput(date, onDate)
        }
        Box(Modifier.widthIn(min = 88.dp)) { CalEditorInput(time, onTime, contentDescription = label) }
    }
}

@Composable
private fun CalEditorMenu(label: String, value: String, options: List<Pair<String, String>>, onPick: (String) -> Unit) {
    var open by remember(value) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.CAL_EDITOR_LABEL_GAP_DP.dp)) {
        Text(label, fontSize = ch.fasrv.fanotes.desk.CAL_EDITOR_LABEL_SP.sp, color = LocalStatusInk.current.muted)
        Box {
            CalEditorInput(value, {}, readOnly = true, onClick = { if (options.isNotEmpty()) open = true })
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                options.forEach { (id, name) ->
                    DropdownMenuItem(text = { Text(name) }, onClick = { onPick(id); open = false })
                }
            }
        }
    }
}

@Composable
private fun CalEditorInput(
    value: String,
    onChange: (String) -> Unit,
    singleLine: Boolean = true,
    placeholder: String = "",
    contentDescription: String = "",
    title: Boolean = false,
    readOnly: Boolean = false,
    onClick: (() -> Unit)? = null,
) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.CAL_EDITOR_FIELD_RADIUS_DP.dp)
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = if (singleLine) 0.dp else 72.dp)
            .clip(shape)
            .border(1.dp, rule, shape)
            .background(MaterialTheme.colorScheme.background)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(
                horizontal = ch.fasrv.fanotes.desk.CAL_EDITOR_FIELD_PAD_X_DP.dp,
                vertical = ch.fasrv.fanotes.desk.CAL_EDITOR_FIELD_PAD_Y_DP.dp,
            )
            .then(if (contentDescription.isNotEmpty()) Modifier.semantics { this.contentDescription = contentDescription } else Modifier),
    ) {
        if (value.isEmpty() && placeholder.isNotEmpty()) {
            Text(placeholder, fontSize = 12.sp, color = LocalStatusInk.current.muted)
        }
        BasicTextField(
            value = value,
            onValueChange = onChange,
            readOnly = readOnly,
            singleLine = singleLine,
            textStyle = TextStyle(
                color = MaterialTheme.colorScheme.onSurface,
                fontSize = if (title) ch.fasrv.fanotes.desk.CAL_EDITOR_TITLE_SP.sp else 16.sp,
                fontWeight = if (title) FontWeight(650) else FontWeight.Normal,
            ),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun CalEditorAction(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null,
    danger: Boolean = false,
    primary: Boolean = false,
    onClick: () -> Unit,
) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.CAL_EDITOR_ACTION_RADIUS_DP.dp)
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    val ink = if (primary) MaterialTheme.colorScheme.background else if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    val fill = if (primary) MaterialTheme.colorScheme.onSurface else Color.Transparent
    val border = if (primary) MaterialTheme.colorScheme.onSurface else rule
    Row(
        Modifier
            .height(ch.fasrv.fanotes.desk.CAL_EDITOR_ACTION_DP.dp)
            .clip(shape)
            .background(fill)
            .border(1.dp, border, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = ch.fasrv.fanotes.desk.CAL_EDITOR_ACTION_PAD_DP.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (icon != null) Icon(icon, contentDescription = null, modifier = Modifier.size(ch.fasrv.fanotes.desk.CAL_EDITOR_ACTION_ICON_DP.dp), tint = ink)
        Text(label, fontSize = ch.fasrv.fanotes.desk.CAL_EDITOR_ACTION_SP.sp, color = ink)
    }
}

@Composable
fun BugReportDialog(model: FaNotesViewModel) {
    val status by model.bugReportMessage.collectAsStateWithLifecycle()
    val busy by model.bugReportBusy.collectAsStateWithLifecycle()
    var description by remember { mutableStateOf("") }
    val dismiss = { model.closeBugReport() }
    Dialog(onDismissRequest = dismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val scrim = remember { MutableInteractionSource() }
        val card = remember { MutableInteractionSource() }
        val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.BUG_REPORT_RADIUS_DP.dp)
        val fieldShape = RoundedCornerShape(ch.fasrv.fanotes.desk.BUG_REPORT_FIELD_RADIUS_DP.dp)
        val buttonShape = RoundedCornerShape(ch.fasrv.fanotes.desk.BUG_REPORT_BUTTON_RADIUS_DP.dp)
        val strong = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)
        val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
        val ink = LocalStatusInk.current
        val screen = androidx.compose.ui.platform.LocalConfiguration.current
        val canSend = ch.fasrv.fanotes.desk.bugReportCanSend(description, busy)
        Box(
            Modifier
                .fillMaxSize()
                .background(Color(ch.fasrv.fanotes.desk.PALETTE_SCRIM))
                .clickable(interactionSource = scrim, indication = null, onClick = dismiss),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                Modifier
                    .fillMaxWidth(ch.fasrv.fanotes.desk.BUG_REPORT_WIDTH_FRACTION)
                    .widthIn(max = ch.fasrv.fanotes.desk.BUG_REPORT_MAX_DP.dp)
                    .heightIn(max = ch.fasrv.fanotes.desk.bugReportMaxHeightDp(screen.screenHeightDp).dp)
                    .clickable(interactionSource = card, indication = null, onClick = {})
                    .directionalBugReportShade()
                    .clip(shape)
                    .border(1.dp, strong, shape)
                    .background(MaterialTheme.colorScheme.background),
            ) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(
                            start = ch.fasrv.fanotes.desk.BUG_REPORT_HEADER_PAD_X_DP.dp,
                            end = ch.fasrv.fanotes.desk.BUG_REPORT_HEADER_PAD_X_DP.dp,
                            top = ch.fasrv.fanotes.desk.BUG_REPORT_HEADER_PAD_TOP_DP.dp,
                            bottom = ch.fasrv.fanotes.desk.BUG_REPORT_HEADER_PAD_BOTTOM_DP.dp,
                        ),
                    horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.BUG_REPORT_HEADER_GAP_DP.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Row(
                        Modifier.weight(1f),
                        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.BUG_REPORT_HEADING_GAP_DP.dp),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Icon(
                            Icons.Filled.BugReport,
                            contentDescription = null,
                            modifier = Modifier.padding(top = ch.fasrv.fanotes.desk.BUG_REPORT_ICON_NUDGE_DP.dp).size(ch.fasrv.fanotes.desk.BUG_REPORT_ICON_DP.dp),
                            tint = MaterialTheme.colorScheme.onSurface,
                        )
                        Column {
                            Text(
                                ch.fasrv.fanotes.desk.BUG_REPORT_TITLE,
                                fontSize = ch.fasrv.fanotes.desk.BUG_REPORT_TITLE_SP.sp,
                                fontWeight = FontWeight(650),
                                letterSpacing = (-0.02).em,
                            )
                            Text(
                                ch.fasrv.fanotes.desk.BUG_REPORT_DETAIL,
                                fontSize = ch.fasrv.fanotes.desk.BUG_REPORT_DETAIL_SP.sp,
                                fontWeight = FontWeight.Medium,
                                lineHeight = 17.sp,
                                color = ink.muted,
                                modifier = Modifier.padding(top = ch.fasrv.fanotes.desk.BUG_REPORT_DETAIL_GAP_DP.dp),
                            )
                        }
                    }
                    Box(
                        Modifier
                            .size(ch.fasrv.fanotes.desk.BUG_REPORT_CLOSE_DP.dp)
                            .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.BUG_REPORT_CLOSE_RADIUS_DP.dp))
                            .clickable(onClick = dismiss),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = "Schließen",
                            modifier = Modifier.size(ch.fasrv.fanotes.desk.BUG_REPORT_CLOSE_ICON_DP.dp),
                            tint = ink.muted,
                        )
                    }
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(rule))
                Column(
                    Modifier
                        .weight(1f, fill = false)
                        .verticalScroll(rememberScrollState())
                        .padding(
                            start = ch.fasrv.fanotes.desk.BUG_REPORT_BODY_PAD_X_DP.dp,
                            end = ch.fasrv.fanotes.desk.BUG_REPORT_BODY_PAD_X_DP.dp,
                            top = ch.fasrv.fanotes.desk.BUG_REPORT_BODY_PAD_TOP_DP.dp,
                            bottom = ch.fasrv.fanotes.desk.BUG_REPORT_BODY_PAD_BOTTOM_DP.dp,
                        ),
                    verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.BUG_REPORT_BODY_GAP_DP.dp),
                ) {
                    Text(
                        ch.fasrv.fanotes.desk.BUG_REPORT_LABEL,
                        fontSize = ch.fasrv.fanotes.desk.BUG_REPORT_LABEL_SP.sp,
                        fontWeight = FontWeight.Bold,
                    )
                    BasicTextField(
                        value = description,
                        onValueChange = { description = it.take(ch.fasrv.fanotes.desk.BUG_REPORT_MAX_CHARS) },
                        textStyle = TextStyle(
                            color = MaterialTheme.colorScheme.onSurface,
                            fontSize = ch.fasrv.fanotes.desk.BUG_REPORT_FIELD_SP.sp,
                            fontWeight = FontWeight.Medium,
                            lineHeight = 19.sp,
                        ),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = ch.fasrv.fanotes.desk.BUG_REPORT_FIELD_MIN_DP.dp)
                            .border(1.dp, strong, fieldShape)
                            .clip(fieldShape)
                            .background(MaterialTheme.colorScheme.background)
                            .padding(
                                horizontal = ch.fasrv.fanotes.desk.BUG_REPORT_FIELD_PAD_X_DP.dp,
                                vertical = ch.fasrv.fanotes.desk.BUG_REPORT_FIELD_PAD_Y_DP.dp,
                            ),
                        decorationBox = { inner ->
                            Box {
                                if (description.isEmpty()) {
                                    Text(
                                        ch.fasrv.fanotes.desk.BUG_REPORT_PLACEHOLDER,
                                        color = ink.muted,
                                        fontSize = ch.fasrv.fanotes.desk.BUG_REPORT_FIELD_SP.sp,
                                        fontWeight = FontWeight.Medium,
                                        lineHeight = 19.sp,
                                    )
                                }
                                inner()
                            }
                        },
                    )
                    val reported = status
                    if (!reported.isNullOrBlank() && reported != "Bericht gesendet.") {
                        Text(reported, color = MaterialTheme.colorScheme.error, fontSize = 12.sp, lineHeight = 17.sp)
                    }
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.BUG_REPORT_ACTION_GAP_DP.dp, Alignment.End),
                    ) {
                        Box(
                            Modifier
                                .height(ch.fasrv.fanotes.desk.BUG_REPORT_BUTTON_DP.dp)
                                .alpha(if (busy) ch.fasrv.fanotes.desk.BUG_REPORT_DISABLED_ALPHA else 1f)
                                .clip(buttonShape)
                                .background(ink.panelStrong)
                                .border(1.dp, strong, buttonShape)
                                .clickable(enabled = !busy, onClick = dismiss)
                                .padding(horizontal = ch.fasrv.fanotes.desk.BUG_REPORT_BUTTON_PAD_DP.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                ch.fasrv.fanotes.desk.BUG_REPORT_CANCEL,
                                fontSize = ch.fasrv.fanotes.desk.BUG_REPORT_BUTTON_SP.sp,
                                fontWeight = FontWeight.Medium,
                                color = ink.soft,
                            )
                        }
                        Box(
                            Modifier
                                .height(ch.fasrv.fanotes.desk.BUG_REPORT_BUTTON_DP.dp)
                                .alpha(if (canSend) 1f else ch.fasrv.fanotes.desk.BUG_REPORT_DISABLED_ALPHA)
                                .clip(buttonShape)
                                .background(MaterialTheme.colorScheme.onSurface)
                                .clickable(enabled = canSend, onClick = { model.sendBugReport(description) })
                                .padding(horizontal = ch.fasrv.fanotes.desk.BUG_REPORT_BUTTON_PAD_DP.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.BUG_REPORT_BUTTON_GAP_DP.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                if (busy) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(ch.fasrv.fanotes.desk.BUG_REPORT_BUTTON_ICON_DP.dp),
                                        strokeWidth = 1.5.dp,
                                        color = MaterialTheme.colorScheme.background,
                                    )
                                } else {
                                    Icon(
                                        Icons.AutoMirrored.Filled.Send,
                                        contentDescription = null,
                                        modifier = Modifier.size(ch.fasrv.fanotes.desk.BUG_REPORT_BUTTON_ICON_DP.dp),
                                        tint = MaterialTheme.colorScheme.background,
                                    )
                                }
                                Text(
                                    ch.fasrv.fanotes.desk.bugReportSendLabel(busy),
                                    fontSize = ch.fasrv.fanotes.desk.BUG_REPORT_BUTTON_SP.sp,
                                    fontWeight = FontWeight.Medium,
                                    color = MaterialTheme.colorScheme.background,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun FaNotesConfirmDialog(request: PendingConfirm, onConfirm: () -> Unit, onDismiss: () -> Unit, glass: Boolean = false, radiusDp: Int? = null, themeId: String = "light") {
    val cancel = remember { FocusRequester() }
    val confirm = remember { FocusRequester() }
    var focused by remember(request.message) { mutableStateOf(0) }
    LaunchedEffect(request.message) { runCatching { cancel.requestFocus() } }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val scrim = remember { MutableInteractionSource() }
        val card = remember { MutableInteractionSource() }
        val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.CONFIRM_RADIUS_DP.dp)
        val buttonShape = RoundedCornerShape(ch.fasrv.fanotes.desk.CONFIRM_BUTTON_RADIUS_DP.dp)
        Box(
            Modifier
                .fillMaxSize()
                .clickable(interactionSource = scrim, indication = null, onClick = onDismiss),
            contentAlignment = Alignment.Center,
        ) {
        Surface(
            Modifier
                .widthIn(max = ch.fasrv.fanotes.desk.CONFIRM_MAX_DP.dp)
                .directionalConfirmShade(themeId)
                .clickable(interactionSource = card, indication = null, onClick = {})
                .onPreviewKeyEvent { event ->
            if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
            val keyName = when (event.key) {
                Key.Escape -> "Escape"
                else -> ""
            }
            if (confirmDialogKeyAction(keyName) == "cancel") {
                onDismiss()
                return@onPreviewKeyEvent true
            }
            if (event.key != Key.Tab) return@onPreviewKeyEvent false
            val next = confirmDialogTabTarget(2, focused, event.isShiftPressed) ?: return@onPreviewKeyEvent false
            focused = next
            if (next == 0) cancel.requestFocus() else confirm.requestFocus()
            true
        },
            color = if (glass) MaterialTheme.colorScheme.surface.copy(alpha = 0.88f) else MaterialTheme.colorScheme.surface,
            shape = shape,
            shadowElevation = 0.dp,
            tonalElevation = 0.dp,
            border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)),
        ) {
            Column(
                Modifier.padding(
                    start = ch.fasrv.fanotes.desk.CONFIRM_PAD_X_DP.dp,
                    end = ch.fasrv.fanotes.desk.CONFIRM_PAD_X_DP.dp,
                    top = ch.fasrv.fanotes.desk.CONFIRM_PAD_TOP_DP.dp,
                    bottom = ch.fasrv.fanotes.desk.CONFIRM_PAD_BOTTOM_DP.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.CONFIRM_GAP_DP.dp),
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.CONFIRM_HEADER_GAP_DP.dp), verticalAlignment = Alignment.Top) {
                    Box(
                        Modifier
                            .size(ch.fasrv.fanotes.desk.CONFIRM_ICON_DP.dp)
                            .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.CONFIRM_ICON_RADIUS_DP.dp))
                            .background(MaterialTheme.colorScheme.error),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Filled.Warning,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.background,
                        )
                    }
                    Column(Modifier.weight(1f)) {
                        Text(
                            ch.fasrv.fanotes.desk.CONFIRM_EYEBROW,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            letterSpacing = 0.12.em,
                            color = MaterialTheme.colorScheme.error,
                        )
                        Text(
                            request.title,
                            fontSize = ch.fasrv.fanotes.desk.CONFIRM_TITLE_SP.sp,
                            fontWeight = FontWeight.SemiBold,
                            letterSpacing = (-0.02).em,
                            lineHeight = 20.sp,
                        )
                    }
                }
                Text(
                    request.message,
                    fontSize = ch.fasrv.fanotes.desk.CONFIRM_BODY_SP.sp,
                    lineHeight = 19.sp,
                    color = LocalStatusInk.current.soft,
                    modifier = Modifier.padding(start = ch.fasrv.fanotes.desk.CONFIRM_BODY_INSET_DP.dp),
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                    Box(
                        Modifier
                            .height(ch.fasrv.fanotes.desk.CONFIRM_BUTTON_DP.dp)
                            .clip(buttonShape)
                            .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA), buttonShape)
                            .focusRequester(cancel)
                            .onFocusChanged { if (it.isFocused) focused = 0 }
                            .focusable()
                            .clickable(onClick = onDismiss)
                            .padding(horizontal = ch.fasrv.fanotes.desk.CONFIRM_BUTTON_PAD_DP.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(request.cancelLabel, fontSize = 12.sp, fontWeight = FontWeight.Medium, color = LocalStatusInk.current.soft)
                    }
                    Box(
                        Modifier
                            .height(ch.fasrv.fanotes.desk.CONFIRM_BUTTON_DP.dp)
                            .clip(buttonShape)
                            .background(MaterialTheme.colorScheme.error)
                            .focusRequester(confirm)
                            .onFocusChanged { if (it.isFocused) focused = 1 }
                            .focusable()
                            .clickable(onClick = onConfirm)
                            .padding(horizontal = ch.fasrv.fanotes.desk.CONFIRM_BUTTON_PAD_DP.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(request.confirmLabel, fontSize = 12.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.background)
                    }
                }
            }
        }
        }
    }
}

@Composable
fun OverviewScreen(
    model: FaNotesViewModel,
    onOpen: (String) -> Unit,
    onCreate: () -> Unit = {},
    onClose: () -> Unit = {},
) {
    val tree by model.tree.collectAsStateWithLifecycle()
    val colors by model.folderColors.collectAsStateWithLifecycle()
    val tabs by model.openTabs.collectAsStateWithLifecycle()
    val open by model.open.collectAsStateWithLifecycle()
    val unsaved by model.unsaved.collectAsStateWithLifecycle()
    val picture = ch.fasrv.fanotes.desk.vaultOverview(tree, colors)
    val recent = ch.fasrv.fanotes.desk.overviewRecent(tabs)
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Ordnerübersicht", style = MaterialTheme.typography.titleLarge)
                Text(
                    "Alle Ordner auf einen Blick. Tippe eine Zeile an, um die letzte Notiz zu öffnen.",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
                )
            }
            TextButton(onClick = onCreate) { Text("Neue Notiz") }
            TextButton(onClick = onClose) { Text("Schließen") }
        }
        Text(ch.fasrv.fanotes.desk.overviewStatsLine(picture.topFolders, picture.noteCount), modifier = Modifier.padding(top = 12.dp))
        Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(Modifier.weight(1.6f)) {
                Text("Deine Ordner", fontWeight = FontWeight.SemiBold)
                Text(ch.fasrv.fanotes.desk.overviewFolderCountLabel(picture.folders.size), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f))
                if (picture.folders.isEmpty()) {
                    Text("Noch keine Ordner", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp))
                    Text("Lege einen Fachordner an oder schreibe eine Notiz. Die Übersicht füllt sich automatisch.", fontSize = 13.sp)
                    TextButton(onClick = onCreate) { Text("Erste Notiz erstellen") }
                }
                picture.folders.forEach { folder ->
                    val tint = folder.color?.let { runCatching { Color(android.graphics.Color.parseColor(it)) }.getOrNull() }
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .padding(start = (folder.depth * 16).dp, top = 8.dp)
                            .clickable { folder.latestPath?.let(onOpen) ?: onCreate() }
                            .padding(vertical = 4.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                folder.name,
                                fontWeight = FontWeight.SemiBold,
                                color = tint ?: MaterialTheme.colorScheme.onSurface,
                                modifier = Modifier.weight(1f),
                            )
                            Text("${folder.noteCount}", fontSize = 13.sp)
                        }
                        ch.fasrv.fanotes.desk.overviewSubfolderLabel(folder.subfolders)?.let { Text(it, fontSize = 12.sp) }
                        Text(ch.fasrv.fanotes.desk.overviewLatestLabel(folder), fontSize = 13.sp)
                        Text(ch.fasrv.fanotes.desk.overviewModifiedLabel(folder.latestModifiedMs), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f))
                    }
                }
            }
            Column(Modifier.weight(1f)) {
                Text("Zuletzt geöffnet", fontWeight = FontWeight.SemiBold)
                Text(
                    if (recent.isEmpty()) "Noch leer" else "${recent.size} im Verlauf",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f),
                )
                if (recent.isEmpty()) {
                    Text("Noch keine offenen Notizen", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 12.dp))
                    Text("Geöffnete Dokumente bleiben hier griffbereit.", fontSize = 13.sp)
                }
                recent.forEach { path ->
                    Row(
                        Modifier.fillMaxWidth().clickable { onOpen(path) }.padding(vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(ch.fasrv.fanotes.desk.overviewRecentTitle(path), fontWeight = FontWeight.SemiBold)
                            Text(ch.fasrv.fanotes.desk.overviewPathParent(path), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f))
                        }
                        if (unsaved && open?.path == path) {
                            Text("●", color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 6.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun CardsScreen(model: FaNotesViewModel) {
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val today = LocalDate.now().toString()
    val cards = dueCards(model.cardsToday(), today).ifEmpty { model.cardsToday() }
    var index by remember(markdown) { mutableStateOf(0) }
    var showBack by remember(markdown, index) { mutableStateOf(false) }
    val card = cards.getOrNull(index)
    Column(
        Modifier.fillMaxSize().padding(24.dp).pointerInput(card?.id, showBack) {
            detectDeskSwipe { direction ->
                val current = card ?: return@detectDeskSwipe
                when (ch.fasrv.fanotes.desk.cardSwipeAction(showBack, direction)) {
                    "reveal" -> showBack = true
                    else -> {
                        val grade = ch.fasrv.fanotes.desk.cardSwipeAction(true, direction)
                        model.reviewFlashcard(current.id, grade)
                        showBack = false
                    }
                }
            }
        },
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Karteikarten", style = MaterialTheme.typography.titleLarge)
        Text("Fragen stehen unter ## Lernfragen, der Plan in fanotes-cards-v1.", fontSize = 13.sp)
        if (card == null) {
            Text("In dieser Notiz sind keine Karten fällig.")
        } else {
            Text(if (showBack) card.back.ifBlank { "Keine Antwort" } else card.front, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.clickable { showBack = !showBack }.padding(vertical = 24.dp))
            Row {
                listOf("again" to "Nochmal", "hard" to "Schwer", "good" to "Gut", "easy" to "Leicht").forEach { (grade, label) ->
                    TextButton(onClick = {
                        model.reviewFlashcard(card.id, grade)
                        showBack = false
                    }) { Text(label) }
                }
            }
        }
    }
}

@Composable
fun BooksScreen(model: FaNotesViewModel, onOpen: (String) -> Unit) {
    val books by model.books.collectAsStateWithLifecycle()
    val settings by model.deskSettings.collectAsStateWithLifecycle()
    var folder by remember { mutableStateOf("") }
    var pdf by remember { mutableStateOf("") }
    val placement = settings["book-placement"].orEmpty().ifBlank { "rechts" }
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())) {
        Text("Fachbuch", style = MaterialTheme.typography.titleLarge)
        Text("Dieselbe Liste wie .fanotes/subject-books.json. Die Seite bleibt erhalten.", fontSize = 13.sp)
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            listOf("links" to "Links", "rechts" to "Rechts", "oben" to "Oben", "unten" to "Unten", "popout" to "Auspoppen").forEach { (id, label) ->
                TextButton(onClick = { model.updateDesk("book-placement", id) }) {
                    Text(label, color = if (placement == id) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                }
            }
        }
        OutlinedTextField(folder, { folder = it }, label = { Text("Ordner") }, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(pdf, { pdf = it }, label = { Text("PDF") }, modifier = Modifier.fillMaxWidth())
        TextButton(onClick = {
            if (folder.isNotBlank() && pdf.isNotBlank()) {
                model.attachSubjectBook(folder, pdf)
                folder = ""
                pdf = ""
            }
        }) { Text("Verbinden") }
        books.forEach { book ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).clickable { onOpen(book.bookPath) }.padding(vertical = 10.dp)) {
                    Text(book.subjectPath, fontWeight = FontWeight.SemiBold)
                    Text("${book.bookPath} · Seite ${book.lastPage}", fontSize = 13.sp)
                }
                TextButton(onClick = { model.detachSubjectBook(book.subjectPath) }) { Text("Buch entfernen") }
            }
        }
        if (books.isEmpty()) Text("Noch kein Fachbuch mit einem Ordner verbunden.", modifier = Modifier.padding(top = 12.dp))
    }
}

@Composable
fun BookPane(model: FaNotesViewModel, modifier: Modifier = Modifier, onOpen: (String) -> Unit) {
    val pane by model.bookPane.collectAsStateWithLifecycle()
    val page = pane ?: return
    Column(modifier.padding(8.dp)) {
        Text(page.title, maxLines = 1, fontWeight = FontWeight.SemiBold)
        if (page.needsPassword) {
            val rejected by model.bookPasswordRejected.collectAsStateWithLifecycle()
            var draft by remember(page.bookPath) { mutableStateOf("") }
            val supported = ch.fasrv.fanotes.desk.pdfPasswordSupported(android.os.Build.VERSION.SDK_INT)
            Text(ch.fasrv.fanotes.desk.PDF_PASSWORD_TITLE, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 8.dp))
            if (!supported) {
                Text(ch.fasrv.fanotes.desk.PDF_PASSWORD_NEEDS_ANDROID_15, fontSize = 13.sp)
            } else {
                OutlinedTextField(
                    draft,
                    { draft = it },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
                    label = { Text("Passwort") },
                )
                if (rejected) Text(ch.fasrv.fanotes.desk.PDF_PASSWORD_WRONG, fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
                TextButton(onClick = { model.submitBookPassword(draft) }) { Text(ch.fasrv.fanotes.desk.PDF_PASSWORD_ACTION) }
            }
            return@Column
        }
        Text("Seite ${page.page} / ${page.pageCount}", fontSize = 12.sp)
        page.bitmap?.let { bitmap ->
            Image(
                bitmap.asImageBitmap(),
                contentDescription = page.title,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentScale = ContentScale.Fit,
            )
        }
        Row {
            TextButton(onClick = { model.turnBook(-1) }) { Text("‹") }
            TextButton(onClick = { model.turnBook(1) }) { Text("›") }
            TextButton(onClick = { onOpen(page.bookPath) }) { Text("Öffnen") }
        }
    }
}

@Composable
fun HistoryDialog(model: FaNotesViewModel, themeId: String) {
    val history by model.noteHistory.collectAsStateWithLifecycle()
    val busy by model.historyBusy.collectAsStateWithLifecycle()
    val dismiss = { model.closeHistory() }
    Dialog(onDismissRequest = dismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val scrim = remember { MutableInteractionSource() }
        val card = remember { MutableInteractionSource() }
        val shape = RoundedCornerShape(ch.fasrv.fanotes.vault.HISTORY_DIALOG_RADIUS_DP.dp)
        val rowShape = RoundedCornerShape(ch.fasrv.fanotes.vault.HISTORY_DIALOG_ROW_RADIUS_DP.dp)
        val buttonShape = RoundedCornerShape(ch.fasrv.fanotes.desk.BUG_REPORT_BUTTON_RADIUS_DP.dp)
        val strong = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)
        val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
        val ink = LocalStatusInk.current
        val screen = androidx.compose.ui.platform.LocalConfiguration.current
        Box(
            Modifier
                .fillMaxSize()
                .background(Color(ch.fasrv.fanotes.desk.PALETTE_SCRIM))
                .clickable(interactionSource = scrim, indication = null, onClick = dismiss),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                Modifier
                    .fillMaxWidth(ch.fasrv.fanotes.vault.HISTORY_DIALOG_WIDTH_FRACTION)
                    .widthIn(max = ch.fasrv.fanotes.vault.HISTORY_DIALOG_MAX_DP.dp)
                    .heightIn(max = ch.fasrv.fanotes.vault.historyDialogMaxHeightDp(screen.screenHeightDp).dp)
                    .directionalHistoryShade(themeId)
                    .clickable(interactionSource = card, indication = null, onClick = {})
                    .clip(shape)
                    .border(1.dp, strong, shape)
                    .background(MaterialTheme.colorScheme.surface)
                    .verticalScroll(rememberScrollState()),
            ) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(
                            start = ch.fasrv.fanotes.vault.HISTORY_DIALOG_HEADER_PAD_X_DP.dp,
                            end = ch.fasrv.fanotes.vault.HISTORY_DIALOG_HEADER_PAD_X_DP.dp,
                            top = ch.fasrv.fanotes.vault.HISTORY_DIALOG_HEADER_PAD_TOP_DP.dp,
                            bottom = ch.fasrv.fanotes.vault.HISTORY_DIALOG_HEADER_PAD_BOTTOM_DP.dp,
                        ),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.Top,
                ) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.vault.HISTORY_DIALOG_HEADER_GAP_DP.dp),
                        verticalAlignment = Alignment.Top,
                        modifier = Modifier.weight(1f),
                    ) {
                        Icon(
                            Icons.Filled.History,
                            contentDescription = null,
                            modifier = Modifier.size(ch.fasrv.fanotes.vault.HISTORY_DIALOG_ICON_DP.dp),
                            tint = MaterialTheme.colorScheme.onSurface,
                        )
                        Column {
                            Text(
                                ch.fasrv.fanotes.vault.HISTORY_EYEBROW,
                                fontSize = ch.fasrv.fanotes.vault.HISTORY_DIALOG_META_SP.sp,
                                color = ink.muted,
                            )
                            Text(
                                ch.fasrv.fanotes.vault.HISTORY_TITLE,
                                fontSize = ch.fasrv.fanotes.vault.HISTORY_DIALOG_TITLE_SP.sp,
                                fontWeight = FontWeight.Bold,
                            )
                        }
                    }
                    Box(
                        Modifier
                            .size(ch.fasrv.fanotes.desk.BUG_REPORT_CLOSE_DP.dp)
                            .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.BUG_REPORT_CLOSE_RADIUS_DP.dp))
                            .clickable(onClick = dismiss),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = "Schließen",
                            modifier = Modifier.size(ch.fasrv.fanotes.vault.HISTORY_DIALOG_CLOSE_ICON_DP.dp),
                            tint = ink.muted,
                        )
                    }
                }
                if (busy) {
                    Text(
                        ch.fasrv.fanotes.vault.HISTORY_LOADING,
                        fontSize = ch.fasrv.fanotes.vault.HISTORY_DIALOG_META_SP.sp,
                        color = ink.muted,
                        modifier = Modifier.padding(
                            start = ch.fasrv.fanotes.vault.HISTORY_DIALOG_LIST_PAD_DP.dp,
                            end = ch.fasrv.fanotes.vault.HISTORY_DIALOG_LIST_PAD_DP.dp,
                            top = ch.fasrv.fanotes.vault.HISTORY_DIALOG_EMPTY_PAD_TOP_DP.dp,
                            bottom = ch.fasrv.fanotes.vault.HISTORY_DIALOG_EMPTY_PAD_BOTTOM_DP.dp,
                        ),
                    )
                } else if (history.isEmpty()) {
                    Text(
                        ch.fasrv.fanotes.vault.HISTORY_EMPTY,
                        fontSize = ch.fasrv.fanotes.vault.HISTORY_DIALOG_META_SP.sp,
                        color = ink.muted,
                        modifier = Modifier.padding(
                            start = ch.fasrv.fanotes.vault.HISTORY_DIALOG_LIST_PAD_DP.dp,
                            end = ch.fasrv.fanotes.vault.HISTORY_DIALOG_LIST_PAD_DP.dp,
                            top = ch.fasrv.fanotes.vault.HISTORY_DIALOG_EMPTY_PAD_TOP_DP.dp,
                            bottom = ch.fasrv.fanotes.vault.HISTORY_DIALOG_EMPTY_PAD_BOTTOM_DP.dp,
                        ),
                    )
                }
                Column(
                    Modifier.padding(
                        start = ch.fasrv.fanotes.vault.HISTORY_DIALOG_LIST_PAD_DP.dp,
                        end = ch.fasrv.fanotes.vault.HISTORY_DIALOG_LIST_PAD_DP.dp,
                        bottom = ch.fasrv.fanotes.vault.HISTORY_DIALOG_LIST_PAD_DP.dp,
                    ),
                    verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.vault.HISTORY_DIALOG_LIST_GAP_DP.dp),
                ) {
                    history.forEach { snapshot ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clip(rowShape)
                                .border(1.dp, rule, rowShape)
                                .padding(ch.fasrv.fanotes.vault.HISTORY_DIALOG_ROW_PAD_DP.dp),
                            horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.vault.HISTORY_DIALOG_ROW_GAP_DP.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    ch.fasrv.fanotes.vault.historyStampLabel(snapshot.createdAt),
                                    fontSize = ch.fasrv.fanotes.vault.HISTORY_DIALOG_META_SP.sp,
                                    fontWeight = FontWeight.Bold,
                                )
                                Text(
                                    ch.fasrv.fanotes.vault.historySizeLabel(snapshot.bytes),
                                    fontSize = ch.fasrv.fanotes.vault.HISTORY_DIALOG_META_SP.sp,
                                    color = ink.muted,
                                )
                            }
                            Box(
                                Modifier
                                    .height(ch.fasrv.fanotes.desk.BUG_REPORT_BUTTON_DP.dp)
                                    .clip(buttonShape)
                                    .background(ink.panelStrong)
                                    .border(1.dp, strong, buttonShape)
                                    .clickable { model.restoreHistory(snapshot.id) }
                                    .padding(horizontal = ch.fasrv.fanotes.desk.BUG_REPORT_BUTTON_PAD_DP.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    ch.fasrv.fanotes.vault.HISTORY_RESTORE,
                                    fontSize = ch.fasrv.fanotes.desk.BUG_REPORT_BUTTON_SP.sp,
                                    fontWeight = FontWeight.Medium,
                                    color = ink.soft,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun HistoryScreen(model: FaNotesViewModel) {
    val history by model.noteHistory.collectAsStateWithLifecycle()
    val open by model.open.collectAsStateWithLifecycle()
    val comparison by model.historyComparison.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())) {
        Text("Versionsverlauf", style = MaterialTheme.typography.titleLarge)
        Text(open?.path ?: "Keine Notiz geöffnet.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        Text("Dieselbe Ablage wie auf dem Desktop: .fanotes/history, höchstens 30 Fassungen je Notiz.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        if (history.isEmpty()) {
            Text("Für diese Notiz liegt noch keine ältere Fassung vor. Sie entsteht, sobald die Notiz erneut gespeichert wird.", modifier = Modifier.padding(top = 12.dp))
        }
        NoteHistoryRows(model, history, comparison)
        val backupsOn = model.deskSettings.collectAsStateWithLifecycle().value["experimental-backup"] == "on"
        if (backupsOn && open != null) {
            val backups = ch.fasrv.fanotes.desk.parseNoteBackups(open?.payload?.array("noteBackups")).filter { it.notePath == open?.path }.asReversed()
            Text("Sicherungen", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 16.dp))
            Text("Liegen in der Notiz selbst, höchstens 40, wie auf dem Desktop.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
            TextButton(onClick = { model.snapshotNote() }) { Text("Sicherung anlegen") }
            backups.forEach { backup ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(backup.createdAt, modifier = Modifier.weight(1f), fontSize = 13.sp)
                    TextButton(onClick = { model.restoreNoteBackup(backup.id) }) { Text("Wiederherstellen") }
                }
            }
        }
    }
}

@Composable
fun FirstRunDialog(
    draft: ch.fasrv.fanotes.desk.FirstRunDraft,
    onDraft: (ch.fasrv.fanotes.desk.FirstRunDraft) -> Unit,
    onFinish: (ch.fasrv.fanotes.desk.FirstRunDraft) -> Unit,
    onDismiss: () -> Unit,
) {
    val folders = ch.fasrv.fanotes.desk.profileFolders(draft.profile)
    val chosen = ch.fasrv.fanotes.desk.firstRunChosenFolders(draft)
    val allSelected = folders.isNotEmpty() && folders.all { it.name in draft.selected }
    val profile = ch.fasrv.fanotes.desk.firstRunProfiles().firstOrNull { it.id == draft.profile }
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    val ink = LocalStatusInk.current
    val go = { step: Int -> onDraft(ch.fasrv.fanotes.desk.firstRunStep(draft, step)) }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background)
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                Modifier
                    .widthIn(max = ch.fasrv.fanotes.desk.FIRST_RUN_MAX_DP.dp)
                    .fillMaxWidth()
                    .padding(horizontal = ch.fasrv.fanotes.desk.FIRST_RUN_GUTTER_DP.dp, vertical = 25.dp),
            ) {
                FirstRunBrand(draft.step) { go(it) }
                Spacer(Modifier.height(31.dp))
                FirstRunEyebrow(ch.fasrv.fanotes.desk.firstRunEyebrow(draft.step), accent)
                when (draft.step) {
                    0 -> {
                        BoxWithConstraints(Modifier.fillMaxWidth()) {
                            val screenWidth = LocalConfiguration.current.screenWidthDp
                            val wide = ch.fasrv.fanotes.desk.firstRunPreviewColumns(screenWidth) == 2
                            val (copyWeight, panelWeight) = ch.fasrv.fanotes.desk.firstRunColumnWeights(0, screenWidth)
                            val gap = ch.fasrv.fanotes.desk.firstRunColumnGap(0, screenWidth).dp
                            if (wide) {
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(copyWeight)) { FirstRunWelcomeCopy(accent) { go(1) } }
                                    WelcomePreview(Modifier.weight(panelWeight))
                                }
                            } else {
                                FirstRunWelcomeCopy(accent) { go(1) }
                                WelcomePreview(Modifier.fillMaxWidth().padding(top = gap))
                            }
                        }
                    }
                    1 -> {
                        BoxWithConstraints(Modifier.fillMaxWidth()) {
                            val screenWidth = LocalConfiguration.current.screenWidthDp
                            val wide = ch.fasrv.fanotes.desk.firstRunPreviewColumns(screenWidth) == 2
                            val (copyWeight, panelWeight) = ch.fasrv.fanotes.desk.firstRunColumnWeights(1, screenWidth)
                            val gap = ch.fasrv.fanotes.desk.firstRunColumnGap(1, screenWidth).dp
                            val copy: @Composable () -> Unit = {
                                Text(ch.fasrv.fanotes.desk.FIRST_RUN_PROFILE_TITLE, fontSize = 34.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.055).em, lineHeight = 36.sp, modifier = Modifier.padding(top = 18.dp))
                                Text(ch.fasrv.fanotes.desk.FIRST_RUN_PROFILE_BODY, fontSize = 13.sp, lineHeight = 22.sp, color = ink.muted, modifier = Modifier.padding(top = 15.dp).widthIn(max = 480.dp))
                                Row(Modifier.padding(top = 25.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                                    FirstRunQuiet(ch.fasrv.fanotes.desk.FIRST_RUN_BACK, leading = true) { go(0) }
                                    FirstRunContinue(ch.fasrv.fanotes.desk.FIRST_RUN_NEXT) { go(2) }
                                }
                            }
                            if (wide) {
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(copyWeight)) { copy() }
                                    Column(Modifier.weight(panelWeight)) {
                                        FirstRunProfiles(draft.profile, besideCopy = true) { onDraft(ch.fasrv.fanotes.desk.firstRunChooseProfile(draft, it)) }
                                    }
                                }
                            } else {
                                copy()
                                FirstRunProfiles(draft.profile) { onDraft(ch.fasrv.fanotes.desk.firstRunChooseProfile(draft, it)) }
                            }
                        }
                    }
                    2 -> {
                        BoxWithConstraints(Modifier.fillMaxWidth()) {
                            val screenWidth = LocalConfiguration.current.screenWidthDp
                            val wide = ch.fasrv.fanotes.desk.firstRunPreviewColumns(screenWidth) == 2
                            val (copyWeight, panelWeight) = ch.fasrv.fanotes.desk.firstRunColumnWeights(2, screenWidth)
                            val gap = ch.fasrv.fanotes.desk.firstRunColumnGap(2, screenWidth).dp
                            if (wide) {
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(copyWeight)) { FirstRunWritingCopy(accent) { go(it) } }
                                    WritingPreview(Modifier.weight(panelWeight))
                                }
                            } else {
                                FirstRunWritingCopy(accent) { go(it) }
                                WritingPreview(Modifier.fillMaxWidth().padding(top = gap))
                            }
                        }
                    }
                    else -> {
                        BoxWithConstraints(Modifier.fillMaxWidth()) {
                            val screenWidth = LocalConfiguration.current.screenWidthDp
                            val wide = ch.fasrv.fanotes.desk.firstRunPreviewColumns(screenWidth) == 2
                            val (copyWeight, panelWeight) = ch.fasrv.fanotes.desk.firstRunColumnWeights(3, screenWidth)
                            val gap = ch.fasrv.fanotes.desk.firstRunColumnGap(3, screenWidth).dp
                            val intro: @Composable () -> Unit = {
                                Text(ch.fasrv.fanotes.desk.FIRST_RUN_FOLDER_TITLE, fontSize = 32.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.052).em, lineHeight = 34.sp, modifier = Modifier.padding(top = 18.dp))
                                Text(ch.fasrv.fanotes.desk.firstRunFolderIntro(profile?.title ?: "Schule"), fontSize = 12.sp, lineHeight = 21.sp, color = ink.muted, modifier = Modifier.padding(top = 13.dp).widthIn(max = 540.dp))
                                Row(
                                    Modifier.padding(top = 24.dp).heightIn(min = 67.dp).fillMaxWidth().clip(RoundedCornerShape(13.dp)).border(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.25f), RoundedCornerShape(13.dp)).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)).padding(horizontal = 13.dp, vertical = 10.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(11.dp),
                                ) {
                                    Box(Modifier.size(39.dp).clip(RoundedCornerShape(11.dp)).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.13f)), contentAlignment = Alignment.Center) {
                                        Icon(Icons.Filled.Inbox, contentDescription = null, modifier = Modifier.size(21.dp), tint = accent)
                                    }
                                    Column(Modifier.weight(1f)) {
                                        Text(ch.fasrv.fanotes.desk.FIRST_RUN_INBOX, fontSize = 12.sp)
                                        Text(ch.fasrv.fanotes.desk.FIRST_RUN_INBOX_DETAIL, fontSize = 12.sp, color = ink.muted, modifier = Modifier.padding(top = 4.dp))
                                    }
                                    Icon(Icons.Filled.Check, contentDescription = "Ausgewählt", modifier = Modifier.size(17.dp), tint = accent)
                                }
                                Text(ch.fasrv.fanotes.desk.FIRST_RUN_PREPARED, fontSize = 12.sp, color = ink.soft, modifier = Modifier.padding(top = 15.dp))
                                Text(ch.fasrv.fanotes.desk.FIRST_RUN_PREPARED_DETAIL, fontSize = 12.sp, color = ink.muted, lineHeight = 19.sp)
                                FirstRunQuiet(ch.fasrv.fanotes.desk.FIRST_RUN_BACK, leading = true) { go(2) }
                            }
                            val picker: @Composable () -> Unit = {
                                val pickerShape = RoundedCornerShape(ch.fasrv.fanotes.desk.FIRST_RUN_PICKER_RADIUS_DP.dp)
                                Column(
                                    Modifier.fillMaxWidth().clip(pickerShape).border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA), pickerShape).background(MaterialTheme.colorScheme.surface).padding(18.dp),
                                ) {
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                        Column(Modifier.weight(1f)) {
                                            Text(profile?.title ?: "Schule", fontSize = 13.sp)
                                            Text(ch.fasrv.fanotes.desk.firstRunSelectionLine(chosen.size, folders.size), fontSize = 12.sp, color = ink.muted, modifier = Modifier.padding(top = 3.dp))
                                        }
                                        FirstRunQuiet(if (allSelected) "Auswahl aufheben" else "Alle auswählen") { onDraft(ch.fasrv.fanotes.desk.firstRunToggleAll(draft)) }
                                    }
                                    Column(Modifier.padding(top = 11.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                                        folders.chunked(2).forEach { row ->
                                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                                                row.forEach { folder ->
                                                    val on = folder.name in draft.selected
                                                    val subject = Color(ch.fasrv.fanotes.desk.firstRunFolderArgb(folder.color))
                                                    val mark = Color(ch.fasrv.fanotes.desk.firstRunSubjectInk(folder.color, MaterialTheme.colorScheme.onSurface.toArgb()))
                                                    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.FIRST_RUN_SUBJECT_RADIUS_DP.dp)
                                                    val checkShape = RoundedCornerShape(6.dp)
                                                    Row(
                                                        Modifier.weight(1f).heightIn(min = 59.dp).clip(shape).border(1.dp, if (on) subject.copy(alpha = ch.fasrv.fanotes.desk.FIRST_RUN_SUBJECT_LINE) else MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA), shape).background(if (on) subject.copy(alpha = ch.fasrv.fanotes.desk.FIRST_RUN_SUBJECT_FILL) else MaterialTheme.colorScheme.surface).clickable { onDraft(ch.fasrv.fanotes.desk.firstRunToggleFolder(draft, folder.name)) }.padding(horizontal = 9.dp, vertical = 7.dp),
                                                        verticalAlignment = Alignment.CenterVertically,
                                                        horizontalArrangement = Arrangement.spacedBy(9.dp),
                                                    ) {
                                                        Box(Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(subject.copy(alpha = ch.fasrv.fanotes.desk.FIRST_RUN_SUBJECT_FILL)), contentAlignment = Alignment.Center) {
                                                            Text(ch.fasrv.fanotes.desk.firstRunFolderMark(folder.name), fontSize = 12.sp, fontWeight = FontWeight.Bold, color = mark)
                                                        }
                                                        Column(Modifier.weight(1f)) {
                                                            Text(folder.name, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                                            Text(ch.fasrv.fanotes.desk.firstRunFolderBlurb(folder.name), fontSize = 12.sp, color = ink.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                                                        }
                                                        Box(
                                                            Modifier.size(17.dp).clip(checkShape).border(1.dp, if (on) subject else MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA), checkShape).background(if (on) subject else Color.Transparent),
                                                            contentAlignment = Alignment.Center,
                                                        ) {
                                                            if (on) Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.background)
                                                        }
                                                    }
                                                }
                                                if (row.size == 1) Spacer(Modifier.weight(1f))
                                            }
                                        }
                                    }
                                    Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                        Text(ch.fasrv.fanotes.desk.firstRunPlanLine(chosen.size), fontSize = 12.sp, color = ink.muted, modifier = Modifier.weight(1f))
                                        FirstRunContinue(ch.fasrv.fanotes.desk.FIRST_RUN_FINISH) { onFinish(draft) }
                                    }
                                }
                            }
                            if (wide) {
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(gap), verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(copyWeight)) { intro() }
                                    Column(Modifier.weight(panelWeight)) { picker() }
                                }
                            } else {
                                intro()
                                Box(Modifier.padding(top = gap)) { picker() }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FirstRunBrand(step: Int, onStep: (Int) -> Unit) {
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    val ink = LocalStatusInk.current
    Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
        Box(
            Modifier.size(ch.fasrv.fanotes.desk.FIRST_RUN_LOGO_DP.dp).clip(RoundedCornerShape(ch.fasrv.fanotes.desk.FIRST_RUN_LOGO_RADIUS_DP.dp)).background(MaterialTheme.colorScheme.onSurface),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.AutoAwesome, contentDescription = null, modifier = Modifier.size(ch.fasrv.fanotes.desk.FIRST_RUN_LOGO_ICON_DP.dp), tint = MaterialTheme.colorScheme.background)
        }
        Column(Modifier.widthIn(min = 120.dp)) {
            Text(ch.fasrv.fanotes.desk.FIRST_RUN_BRAND, fontSize = 14.sp, letterSpacing = (-0.01).em)
            Text(ch.fasrv.fanotes.desk.FIRST_RUN_BRAND_DETAIL, fontSize = 12.sp, color = ink.muted, modifier = Modifier.padding(top = 2.dp))
        }
        Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
            ch.fasrv.fanotes.desk.FIRST_RUN_STEPS.forEachIndexed { index, label ->
                if (index > 0) {
                    Box(
                        Modifier.padding(end = 2.dp).width(22.dp).height(1.dp).background(
                            if (index <= step) MaterialTheme.colorScheme.primary.copy(alpha = 0.55f) else MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA),
                        ),
                    )
                }
                val active = index == step
                val complete = index < step
                val circle = if (active) MaterialTheme.colorScheme.primary else if (complete) MaterialTheme.colorScheme.primary.copy(alpha = 0.10f) else MaterialTheme.colorScheme.surface
                val ring = if (active) MaterialTheme.colorScheme.primary else if (complete) MaterialTheme.colorScheme.primary.copy(alpha = 0.55f) else MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)
                val number = if (active) MaterialTheme.colorScheme.onPrimary else if (complete) accent else ink.muted
                Row(
                    Modifier.padding(end = 10.dp).clickable { onStep(index) },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    Box(
                        Modifier.size(ch.fasrv.fanotes.desk.FIRST_RUN_STEP_DP.dp).clip(CircleShape).border(1.dp, ring, CircleShape).background(circle),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (complete) Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(12.dp), tint = number)
                        else Text("${index + 1}", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = number)
                    }
                    Text(label, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = if (active) MaterialTheme.colorScheme.onSurface else ink.muted, maxLines = 1)
                }
            }
        }
        Row(
            Modifier.padding(start = 9.dp).clip(RoundedCornerShape(99.dp)).border(1.dp, ink.success.copy(alpha = 0.25f), RoundedCornerShape(99.dp)).background(ink.success.copy(alpha = 0.07f)).padding(horizontal = 9.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Filled.Shield, contentDescription = null, modifier = Modifier.size(15.dp), tint = ink.success)
            Text(ch.fasrv.fanotes.desk.FIRST_RUN_LOCAL, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = ink.success)
        }
    }
}

@Composable
private fun FirstRunEyebrow(label: String, accent: Color) {
    Row(
        Modifier.clip(RoundedCornerShape(99.dp)).border(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.22f), RoundedCornerShape(99.dp)).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f)).padding(horizontal = 9.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(label.uppercase(java.util.Locale.GERMAN), fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.085.em, color = accent)
    }
}

@Composable
private fun FirstRunChip(label: String, accent: Color) {
    Row(
        Modifier.clip(RoundedCornerShape(9.dp)).border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA), RoundedCornerShape(9.dp)).background(MaterialTheme.colorScheme.surface.copy(alpha = 0.72f)).padding(horizontal = 9.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(Icons.Filled.AutoAwesome, contentDescription = null, modifier = Modifier.size(15.dp), tint = accent)
        Text(label, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = LocalStatusInk.current.soft)
    }
}

@Composable
private fun FirstRunWelcomeCopy(accent: Color, onContinue: () -> Unit) {
    val ink = LocalStatusInk.current
    Text(ch.fasrv.fanotes.desk.FIRST_RUN_TITLE_WELCOME, fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_TITLE_SP.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.058).em, lineHeight = 38.sp, modifier = Modifier.padding(top = 18.dp))
    Text(ch.fasrv.fanotes.desk.FIRST_RUN_TITLE_EMPHASIS, fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_TITLE_SP.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.058).em, lineHeight = 38.sp, color = accent)
    Text(ch.fasrv.fanotes.desk.FIRST_RUN_BODY_WELCOME, fontSize = 13.sp, lineHeight = 22.sp, color = ink.muted, modifier = Modifier.padding(top = 15.dp).widthIn(max = 500.dp))
    FlowRow(Modifier.padding(top = 25.dp), horizontalArrangement = Arrangement.spacedBy(7.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        ch.fasrv.fanotes.desk.FIRST_RUN_BENEFITS.forEach { benefit ->
            FirstRunChip(benefit, accent)
        }
    }
    Row(Modifier.padding(top = 28.dp), horizontalArrangement = Arrangement.spacedBy(15.dp), verticalAlignment = Alignment.CenterVertically) {
        FirstRunContinue(ch.fasrv.fanotes.desk.FIRST_RUN_GO) { onContinue() }
        FirstRunQuiet(ch.fasrv.fanotes.desk.FIRST_RUN_SKIP) { onContinue() }
    }
}

@Composable
private fun WelcomePreview(modifier: Modifier) {
    val ink = LocalStatusInk.current
    // Subject mark, formula, and hit count use `--accent`, not the readable label color.
    val accent = MaterialTheme.colorScheme.primary
    val screen = LocalConfiguration.current
    val screenWidth = screen.screenWidthDp
    val screenHeight = screen.screenHeightDp
    val aside = ch.fasrv.fanotes.desk.firstRunPreviewAsideDp(screenWidth).dp
    val asidePad = ch.fasrv.fanotes.desk.firstRunPreviewAsidePad(screenWidth)
    val bodyMin = ch.fasrv.fanotes.desk.firstRunPreviewBodyMinDp(screenWidth, screenHeight).dp
    val marks = ch.fasrv.fanotes.desk.firstRunPreviewMarkColors(accent.toArgb())
    val paperMin = ch.fasrv.fanotes.desk.firstRunPreviewPaperMinDp(screenWidth, screenHeight).dp
    val paperShape = RoundedCornerShape(
        topStart = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_RADIUS_TOP_DP.dp,
        topEnd = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_RADIUS_TOP_DP.dp,
        bottomEnd = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_RADIUS_BOTTOM_DP.dp,
        bottomStart = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_RADIUS_BOTTOM_DP.dp,
    )
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_RADIUS_DP.dp)
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val windowBorder = Color(ch.fasrv.fanotes.desk.firstRunPreviewWindowBorder(LocalDeskThemeId.current))
    val windowShadow = Color(ch.fasrv.fanotes.desk.firstRunPreviewWindowShadowColor())
    Box(modifier.semantics { contentDescription = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_LABEL }) {
        Box(Modifier.matchParentSize().welcomePreviewGlow(MaterialTheme.colorScheme.primary.toArgb()))
        Column(
            Modifier
                .fillMaxWidth()
                .shadow(
                    elevation = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_WINDOW_SHADOW_Y_DP.dp,
                    shape = shape,
                    clip = false,
                    ambientColor = windowShadow,
                    spotColor = windowShadow,
                )
                .drawBehind {
                    val stroke = 1.dp.toPx()
                    val radius = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_RADIUS_DP.dp.toPx()
                    drawRoundRect(
                        color = Color(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_WINDOW_RING),
                        topLeft = Offset(-stroke / 2f, -stroke / 2f),
                        size = Size(size.width + stroke, size.height + stroke),
                        cornerRadius = CornerRadius(radius + stroke / 2f, radius + stroke / 2f),
                        style = Stroke(width = stroke),
                    )
                }
                .clip(shape)
                .border(1.dp, windowBorder, shape)
                .background(ink.panelStrong),
        ) {
            val headerBorder = Color(ch.fasrv.fanotes.desk.firstRunPreviewBorder(LocalDeskThemeId.current))
            Column(Modifier.fillMaxWidth().height(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HEADER_DP.dp)) {
                Row(
                    Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .background(Color(ch.fasrv.fanotes.desk.firstRunPreviewHeaderFill(MaterialTheme.colorScheme.surface.toArgb())))
                        .padding(horizontal = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HEADER_PAD_DP.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HEADER_GAP_DP.dp),
                ) {
                    val dots = listOf(
                        Color(ch.fasrv.fanotes.desk.firstRunPreviewHeaderClose(MaterialTheme.colorScheme.error.toArgb(), headerBorder.toArgb())),
                        Color(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HEADER_MIDDLE_DOT),
                        ink.success,
                    )
                    dots.forEach { dot ->
                        Box(
                            Modifier
                                .size(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HEADER_DOT_DP.dp)
                                .clip(CircleShape)
                                .background(dot),
                        )
                    }
                    Text(
                        ch.fasrv.fanotes.desk.FIRST_RUN_BRAND,
                        modifier = Modifier.weight(1f),
                        textAlign = TextAlign.End,
                        fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HEADER_TITLE_SP.sp,
                        fontWeight = FontWeight(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HEADER_TITLE_WEIGHT),
                        color = ink.muted,
                    )
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(headerBorder))
            }
            // The body does not clip, so the sheet shadow can paint. The window clip above still cuts blur that leaves the window.
            Row(Modifier.fillMaxWidth().heightIn(min = bodyMin)) {
                Column(
                    Modifier.width(aside).fillMaxHeight().padding(
                        start = asidePad.start.dp,
                        top = asidePad.top.dp,
                        end = asidePad.end.dp,
                        bottom = asidePad.bottom.dp,
                    ),
                    verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_ASIDE_GAP_DP.dp),
                ) {
                    Row(
                        Modifier.padding(
                            start = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HEADING_MARGIN_INLINE_DP.dp,
                            end = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HEADING_MARGIN_INLINE_DP.dp,
                            bottom = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HEADING_MARGIN_BOTTOM_DP.dp,
                        ),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HEADING_ICON_GAP_DP.dp),
                    ) {
                        Icon(
                            Icons.AutoMirrored.Filled.MenuBook,
                            contentDescription = null,
                            modifier = Modifier.size(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HEADING_ICON_DP.dp),
                            tint = ink.soft,
                        )
                        Text(
                            ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SUBJECTS_HEADING,
                            fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HEADING_SP.sp,
                            fontWeight = FontWeight(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HEADING_WEIGHT),
                            color = ink.soft,
                        )
                    }
                    ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SUBJECTS.forEachIndexed { index, subject ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SUBJECT_RADIUS_DP.dp))
                                .background(if (index == 0) ink.panelActive else Color.Transparent)
                                .padding(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SUBJECT_PAD_DP.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SUBJECT_GAP_DP.dp),
                        ) {
                            Box(
                                Modifier
                                    .size(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_MARK_DP.dp)
                                    .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_MARK_RADIUS_DP.dp))
                                    .background(Color(marks[index])),
                            )
                            Text(
                                subject,
                                fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SUBJECT_SP.sp,
                                color = if (index == 0) MaterialTheme.colorScheme.onSurface else ink.muted,
                            )
                        }
                    }
                }
                Column(
                    Modifier
                        .weight(1f)
                        .padding(
                            start = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_MARGIN_INLINE_DP.dp,
                            top = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_MARGIN_TOP_DP.dp,
                            end = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_MARGIN_INLINE_DP.dp,
                            bottom = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_MARGIN_BOTTOM_DP.dp,
                        )
                        .heightIn(min = paperMin)
                        .welcomePreviewPaperShade()
                        .clip(paperShape)
                        .background(Color(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_FILL))
                        .padding(
                            horizontal = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_PAD_INLINE_DP.dp,
                            vertical = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_PAD_BLOCK_DP.dp,
                        ),
                ) {
                    Text(
                        ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_KICKER,
                        fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_KICKER_SP.sp,
                        fontWeight = FontWeight(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_KICKER_WEIGHT),
                        letterSpacing = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_KICKER_TRACKING_EM.em,
                        color = Color(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_KICKER_INK),
                    )
                    Text(
                        ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HEADING,
                        fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_TITLE_SP.sp,
                        fontWeight = FontWeight(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_TITLE_WEIGHT),
                        letterSpacing = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_TITLE_TRACKING_EM.em,
                        lineHeight = (ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_TITLE_SP * ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_TITLE_LINE).sp,
                        color = Color(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_INK),
                        modifier = Modifier.padding(
                            top = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_TITLE_MARGIN_TOP_DP.dp,
                            bottom = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_TITLE_MARGIN_BOTTOM_DP.dp,
                        ),
                    )
                    Text(
                        ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_TYPED,
                        fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_TYPED_SP.sp,
                        lineHeight = (ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_TYPED_SP * ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_TYPED_LINE).sp,
                        color = Color(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_TYPED_INK),
                        maxLines = 1,
                        softWrap = false,
                        overflow = TextOverflow.Clip,
                    )
                    val searchShape = RoundedCornerShape(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SEARCH_RADIUS_DP.dp)
                    Box(
                        Modifier
                            .padding(
                                top = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_RULE_MARGIN_TOP_DP.dp,
                                bottom = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_RULE_MARGIN_BOTTOM_DP.dp,
                            )
                            .fillMaxWidth()
                            .height(1.dp)
                            .background(Color(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_RULE_ARGB)),
                    )
                    Canvas(Modifier.fillMaxWidth().height(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_INK_HEIGHT_DP.dp).semantics { contentDescription = "Handschriftliche Formel" }) {
                        val meet = ch.fasrv.fanotes.desk.previewInkMeet(
                            size.width,
                            size.height,
                            ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_INK_VIEW_WIDTH.toFloat(),
                            ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_INK_VIEW_HEIGHT.toFloat(),
                        ) ?: return@Canvas
                        val stroke = androidx.compose.ui.graphics.drawscope.Stroke(
                            width = ch.fasrv.fanotes.desk.previewInkStrokePx(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_INK_WIDTH_DP, meet.scale),
                            cap = androidx.compose.ui.graphics.StrokeCap.Round,
                            join = androidx.compose.ui.graphics.StrokeJoin.Round,
                        )
                        fun mx(x: Float) = meet.offsetX + x * meet.scale
                        fun my(y: Float) = meet.offsetY + y * meet.scale
                        val path = androidx.compose.ui.graphics.Path().apply {
                            moveTo(mx(15f), my(58f))
                            cubicTo(mx(29f), my(50f), mx(33f), my(32f), mx(39f), my(26f))
                            cubicTo(mx(47f), my(18f), mx(41f), my(67f), mx(51f), my(70f))
                            cubicTo(mx(62f), my(72f), mx(69f), my(50f), mx(76f), my(40f))
                            moveTo(mx(61f), my(55f))
                            cubicTo(mx(75f), my(58f), mx(90f), my(55f), mx(103f), my(49f))
                            moveTo(mx(119f), my(62f))
                            cubicTo(mx(130f), my(49f), mx(134f), my(31f), mx(140f), my(27f))
                            cubicTo(mx(148f), my(22f), mx(143f), my(64f), mx(153f), my(66f))
                            cubicTo(mx(166f), my(68f), mx(173f), my(43f), mx(182f), my(40f))
                            cubicTo(mx(192f), my(37f), mx(191f), my(63f), mx(202f), my(62f))
                            moveTo(mx(220f), my(48f))
                            lineTo(mx(247f), my(48f))
                            moveTo(mx(234f), my(35f))
                            lineTo(mx(234f), my(63f))
                            moveTo(mx(267f), my(28f))
                            cubicTo(mx(290f), my(20f), mx(308f), my(30f), mx(308f), my(48f))
                            cubicTo(mx(308f), my(66f), mx(286f), my(72f), mx(268f), my(62f))
                        }
                        drawPath(path, Color(ch.fasrv.fanotes.desk.firstRunPreviewInkStroke(accent.toArgb())), style = stroke)
                    }
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .height(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SEARCH_HEIGHT_DP.dp)
                            .shadow(
                                elevation = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SEARCH_SHADOW_Y_DP.dp,
                                shape = searchShape,
                                ambientColor = Color.Black.copy(alpha = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SEARCH_SHADOW_ALPHA),
                                spotColor = Color.Black.copy(alpha = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SEARCH_SHADOW_ALPHA),
                            )
                            .clip(searchShape)
                            .border(1.dp, Color(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SEARCH_BORDER_ARGB), searchShape)
                            .background(Color(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SEARCH_FILL_ARGB))
                            .padding(horizontal = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SEARCH_PAD_DP.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SEARCH_GAP_DP.dp),
                    ) {
                        Icon(Icons.Filled.Search, contentDescription = null, modifier = Modifier.size(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SEARCH_ICON_DP.dp), tint = Color(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SEARCH_ARGB))
                        Text(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_QUERY, fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SEARCH_SP.sp, color = Color(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SEARCH_ARGB))
                        Text(
                            ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HITS,
                            fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_HITS_SP.sp,
                            fontWeight = FontWeight.Bold,
                            color = Color(ch.fasrv.fanotes.desk.firstRunPreviewSearchHits(accent.toArgb())),
                        )
                    }
                }
            }
        }
        BoxWithConstraints(Modifier.matchParentSize()) {
            val handwriting = ch.fasrv.fanotes.desk.firstRunPreviewFloatOffset(ch.fasrv.fanotes.desk.firstRunPreviewFloatOne(screenWidth))
            val found = ch.fasrv.fanotes.desk.firstRunPreviewFloatOffset(ch.fasrv.fanotes.desk.firstRunPreviewFloatTwo())
            WelcomePreviewFloat(
                ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_INK,
                Icons.Filled.Edit,
                dark,
                ink,
                Modifier.align(Alignment.TopEnd).offset(x = handwriting.xDp.dp, y = maxHeight * handwriting.yFraction + handwriting.yDp.dp),
            )
            WelcomePreviewFloat(
                ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_FOUND,
                Icons.Filled.Search,
                dark,
                ink,
                Modifier.align(Alignment.BottomEnd).offset(x = found.xDp.dp, y = maxHeight * found.yFraction + found.yDp.dp),
            )
        }
    }
}

@Composable
private fun WelcomePreviewFloat(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    dark: Boolean,
    ink: StatusInk,
    modifier: Modifier,
) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_FLOAT_RADIUS_DP.dp)
    val shadow = Color(ch.fasrv.fanotes.desk.firstRunPreviewFloatShadowColor())
    Row(
        modifier
            .shadow(
                elevation = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_FLOAT_SHADOW_Y_DP.dp,
                shape = shape,
                clip = false,
                ambientColor = shadow,
                spotColor = shadow,
            )
            .clip(shape)
            .border(1.dp, Color(ch.fasrv.fanotes.desk.firstRunPreviewFloatBorder(dark)), shape)
            .background(Color(ch.fasrv.fanotes.desk.firstRunPreviewFloatFill(ink.panelStrong.toArgb())))
            .padding(
                horizontal = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_FLOAT_PAD_INLINE_DP.dp,
                vertical = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_FLOAT_PAD_BLOCK_DP.dp,
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_FLOAT_GAP_DP.dp),
    ) {
        Icon(
            icon,
            contentDescription = null,
            modifier = Modifier.size(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_FLOAT_ICON_DP.dp),
            tint = Color(ch.fasrv.fanotes.desk.firstRunPreviewFloatIcon(dark)),
        )
        Text(
            label,
            fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_FLOAT_SP.sp,
            fontWeight = FontWeight(ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_FLOAT_WEIGHT),
            color = ink.soft,
        )
    }
}

@Composable
private fun FirstRunWritingCopy(accent: Color, onStep: (Int) -> Unit) {
    val ink = LocalStatusInk.current
    Text(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TITLE, fontSize = 34.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.055).em, lineHeight = 36.sp, modifier = Modifier.padding(top = 18.dp))
    Text(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_BODY, fontSize = 13.sp, lineHeight = 22.sp, color = ink.muted, modifier = Modifier.padding(top = 15.dp).widthIn(max = 490.dp))
    Column(Modifier.padding(top = 21.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        val icons = listOf(Icons.Filled.Keyboard, Icons.Filled.Edit, Icons.Filled.Search)
        ch.fasrv.fanotes.desk.FIRST_RUN_WRITING.forEachIndexed { index, (title, detail) ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
                Box(
                    Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.10f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(icons[index], contentDescription = null, modifier = Modifier.size(17.dp), tint = accent)
                }
                Column {
                    Text(title, fontSize = 12.sp, color = ink.soft)
                    Text(detail, fontSize = 12.sp, color = ink.muted, lineHeight = 17.sp, modifier = Modifier.padding(top = 3.dp))
                }
            }
        }
    }
    Row(Modifier.fillMaxWidth().padding(top = 21.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        FirstRunQuiet(ch.fasrv.fanotes.desk.FIRST_RUN_BACK, leading = true) { onStep(1) }
        FirstRunContinue(ch.fasrv.fanotes.desk.FIRST_RUN_CHOOSE_FOLDERS) { onStep(3) }
    }
}

@Composable
private fun WritingPreview(modifier: Modifier) {
    val ink = LocalStatusInk.current
    // Toolbar, ink, transcript, and selection use `--accent`, not the readable label color.
    val accent = MaterialTheme.colorScheme.primary
    val screen = LocalConfiguration.current
    val framePad = ch.fasrv.fanotes.desk.firstRunWritingFramePad(screen.screenWidthDp, screen.screenHeightDp)
    val sheetPad = ch.fasrv.fanotes.desk.firstRunWritingSheetPad(screen.screenWidthDp, screen.screenHeightDp)
    val sheetMin = ch.fasrv.fanotes.desk.firstRunWritingSheetMinDp(screen.screenWidthDp, screen.screenHeightDp).dp
    val inkHeight = ch.fasrv.fanotes.desk.firstRunWritingInkHeightDp(screen.screenWidthDp, screen.screenHeightDp).dp
    val frameShape = RoundedCornerShape(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_FRAME_RADIUS_DP.dp)
    val sheetShape = RoundedCornerShape(
        topStart = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SHEET_RADIUS_DP.dp,
        topEnd = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SHEET_RADIUS_DP.dp,
    )
    val transcriptShape = RoundedCornerShape(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_RADIUS_DP.dp)
    val labelShape = RoundedCornerShape(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SELECTION_LABEL_RADIUS_DP.dp)
    val strong = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    val panelWash = ink.panelStrong.copy(alpha = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_FRAME_PANEL_ALPHA)
    val elevatedWash = MaterialTheme.colorScheme.surface.copy(alpha = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_FRAME_ELEVATED_ALPHA)
    val accentArgb = accent.toArgb()
    Box(
        modifier
            .shadow(
                elevation = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_FRAME_SHADOW_Y_DP.dp,
                shape = frameShape,
                ambientColor = Color.Black.copy(alpha = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_FRAME_SHADOW_ALPHA),
                spotColor = Color.Black.copy(alpha = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_FRAME_SHADOW_ALPHA),
            )
            .clip(frameShape)
            .border(1.dp, strong, frameShape)
            .drawBehind {
                val radians = Math.toRadians(145.0)
                val dx = kotlin.math.sin(radians).toFloat()
                val dy = -kotlin.math.cos(radians).toFloat()
                val reach = size.maxDimension
                val center = androidx.compose.ui.geometry.Offset(size.width / 2f, size.height / 2f)
                drawRect(
                    Brush.linearGradient(
                        listOf(panelWash, elevatedWash),
                        start = center - androidx.compose.ui.geometry.Offset(dx, dy) * reach,
                        end = center + androidx.compose.ui.geometry.Offset(dx, dy) * reach,
                    ),
                )
            }
            .semantics { contentDescription = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_PREVIEW_LABEL },
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TOOLBAR_DP.dp)
                .drawBehind {
                    val y = size.height
                    drawLine(rule, androidx.compose.ui.geometry.Offset(0f, y), androidx.compose.ui.geometry.Offset(size.width, y), strokeWidth = 1.dp.toPx())
                }
                .padding(horizontal = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TOOLBAR_PAD_DP.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TOOLBAR_GAP_DP.dp), verticalAlignment = Alignment.CenterVertically) {
                val markShape = RoundedCornerShape(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TOOLBAR_MARK_RADIUS_DP.dp)
                Box(
                    Modifier.size(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TOOLBAR_MARK_DP.dp).clip(markShape).border(1.dp, rule, markShape).background(accent.copy(alpha = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TOOLBAR_DOT_ALPHA)),
                    contentAlignment = Alignment.Center,
                ) {
                    Box(Modifier.size(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TOOLBAR_DOT_DP.dp).clip(CircleShape).background(accent))
                }
                repeat(2) {
                    Box(Modifier.size(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TOOLBAR_MARK_DP.dp).clip(markShape).border(1.dp, rule, markShape))
                }
            }
            Spacer(Modifier.weight(1f))
            Text(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_FILE, fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_FILE_SP.sp, color = ink.muted)
        }
        Box(
            Modifier
                .padding(start = framePad.start.dp, top = framePad.top.dp, end = framePad.end.dp, bottom = framePad.bottom.dp)
                .fillMaxWidth()
                .heightIn(min = sheetMin)
                .shadow(
                    elevation = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SHEET_SHADOW_Y_DP.dp,
                    shape = sheetShape,
                    ambientColor = Color.Black.copy(alpha = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SHEET_SHADOW_ALPHA),
                    spotColor = Color.Black.copy(alpha = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SHEET_SHADOW_ALPHA),
                )
                .clip(sheetShape)
                .background(Color(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SHEET_FILL)),
        ) {
            Column(
                Modifier.padding(start = sheetPad.start.dp, top = sheetPad.top.dp, end = sheetPad.end.dp, bottom = sheetPad.bottom.dp),
            ) {
                Text(
                    ch.fasrv.fanotes.desk.firstRunWritingDateLabel(),
                    fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_DATE_SP.sp,
                    fontWeight = FontWeight(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_DATE_WEIGHT),
                    letterSpacing = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_DATE_TRACKING_EM.em,
                    color = Color(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_DATE_INK),
                )
                Text(
                    ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_HEADING,
                    fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TITLE_SP.sp,
                    fontWeight = FontWeight(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TITLE_WEIGHT),
                    letterSpacing = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TITLE_TRACKING_EM.em,
                    lineHeight = (ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TITLE_SP * ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TITLE_LINE).sp,
                    color = Color(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SHEET_INK),
                    modifier = Modifier.padding(
                        top = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TITLE_MARGIN_TOP_DP.dp,
                        bottom = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TITLE_MARGIN_BOTTOM_DP.dp,
                    ),
                )
                Text(
                    ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TYPED,
                    fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TYPED_SP.sp,
                    lineHeight = (ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TYPED_SP * ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TYPED_LINE).sp,
                    color = Color(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TYPED_INK),
                    maxLines = 1,
                    softWrap = false,
                    overflow = TextOverflow.Clip,
                )
                Canvas(
                    Modifier
                        .padding(top = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_INK_MARGIN_TOP_DP.dp)
                        .fillMaxWidth()
                        .height(inkHeight)
                        .semantics { contentDescription = "Handschriftliche Integralrechnung" },
                ) {
                    val meet = ch.fasrv.fanotes.desk.previewInkMeet(
                        size.width,
                        size.height,
                        ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_INK_VIEW_WIDTH.toFloat(),
                        ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_INK_VIEW_HEIGHT.toFloat(),
                    ) ?: return@Canvas
                    val stroke = androidx.compose.ui.graphics.drawscope.Stroke(
                        width = ch.fasrv.fanotes.desk.previewInkStrokePx(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_INK_WIDTH_DP, meet.scale),
                        cap = androidx.compose.ui.graphics.StrokeCap.Round,
                        join = androidx.compose.ui.graphics.StrokeJoin.Round,
                    )
                    fun mx(x: Float) = meet.offsetX + x * meet.scale
                    fun my(y: Float) = meet.offsetY + y * meet.scale
                    val integral = androidx.compose.ui.graphics.Path().apply {
                        moveTo(mx(36f), my(96f))
                        cubicTo(mx(51f), my(77f), mx(46f), my(38f), mx(65f), my(28f))
                        cubicTo(mx(77f), my(22f), mx(79f), my(36f), mx(68f), my(43f))
                        cubicTo(mx(52f), my(54f), mx(51f), my(98f), mx(35f), my(112f))
                        cubicTo(mx(28f), my(118f), mx(19f), my(113f), mx(23f), my(107f))
                    }
                    val terms = androidx.compose.ui.graphics.Path().apply {
                        moveTo(mx(81f), my(42f)); lineTo(mx(92f), my(42f))
                        moveTo(mx(79f), my(107f)); lineTo(mx(91f), my(107f))
                        moveTo(mx(111f), my(78f))
                        cubicTo(mx(126f), my(66f), mx(137f), my(67f), mx(145f), my(77f))
                        cubicTo(mx(152f), my(88f), mx(140f), my(99f), mx(124f), my(98f))
                        cubicTo(mx(110f), my(98f), mx(102f), my(87f), mx(111f), my(78f))
                        moveTo(mx(155f), my(72f)); lineTo(mx(183f), my(72f))
                        moveTo(mx(169f), my(58f)); lineTo(mx(169f), my(89f))
                        moveTo(mx(202f), my(48f))
                        cubicTo(mx(218f), my(38f), mx(239f), my(48f), mx(236f), my(67f))
                        cubicTo(mx(232f), my(88f), mx(213f), my(96f), mx(201f), my(88f))
                        moveTo(mx(258f), my(70f)); lineTo(mx(294f), my(70f))
                        moveTo(mx(314f), my(47f))
                        cubicTo(mx(331f), my(36f), mx(348f), my(47f), mx(345f), my(65f))
                        cubicTo(mx(342f), my(83f), mx(326f), my(93f), mx(312f), my(86f))
                        moveTo(mx(365f), my(82f))
                        cubicTo(mx(374f), my(68f), mx(385f), my(62f), mx(398f), my(64f))
                    }
                    val color = Color(ch.fasrv.fanotes.desk.firstRunWritingInkStroke(accentArgb))
                    drawPath(integral, color, style = stroke)
                    drawPath(terms, color, style = stroke)
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_MIN_DP.dp)
                        .shadow(
                            elevation = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_SHADOW_Y_DP.dp,
                            shape = transcriptShape,
                            ambientColor = Color.Black.copy(alpha = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_SHADOW_ALPHA),
                            spotColor = Color.Black.copy(alpha = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_SHADOW_ALPHA),
                        )
                        .clip(transcriptShape)
                        .border(1.dp, Color(ch.fasrv.fanotes.desk.firstRunWritingTranscriptBorder(accentArgb)), transcriptShape)
                        .background(Color(ch.fasrv.fanotes.desk.firstRunWritingTranscriptFill(accentArgb)))
                        .padding(
                            horizontal = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_PAD_INLINE_DP.dp,
                            vertical = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_PAD_BLOCK_DP.dp,
                        ),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_GAP_DP.dp),
                ) {
                    Box(Modifier.width(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_LEAD_DP.dp), contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.AutoAwesome, contentDescription = null, modifier = Modifier.size(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_ICON_DP.dp), tint = Color(ch.fasrv.fanotes.desk.firstRunWritingSparkle(accentArgb)))
                    }
                    Column(Modifier.weight(1f)) {
                        Text(
                            ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_RECOGNIZED,
                            fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_SP.sp,
                            fontWeight = FontWeight(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_WEIGHT),
                            lineHeight = (ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_SP * ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_LINE).sp,
                            color = Color(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TYPED_INK),
                        )
                        Text(
                            ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_FORMULA,
                            fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_SP.sp,
                            fontWeight = FontWeight(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_DETAIL_WEIGHT),
                            color = Color(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_DETAIL_INK),
                            modifier = Modifier.padding(top = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_DETAIL_GAP_DP.dp),
                        )
                    }
                    Box(Modifier.width(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_TRAIL_DP.dp), contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_CHECK_DP.dp), tint = Color(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_TRANSCRIPT_CHECK_INK))
                    }
                }
            }
            Box(
                Modifier
                    .padding(
                        start = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SELECTION_START_DP.dp,
                        end = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SELECTION_END_DP.dp,
                        top = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SELECTION_TOP_DP.dp,
                    )
                    .fillMaxWidth()
                    .height(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SELECTION_HEIGHT_DP.dp),
            ) {
                Canvas(Modifier.fillMaxSize()) {
                    drawRoundRect(
                        color = accent.copy(alpha = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SELECTION_ALPHA),
                        style = androidx.compose.ui.graphics.drawscope.Stroke(
                            width = 1.dp.toPx(),
                            pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx())),
                        ),
                        cornerRadius = androidx.compose.ui.geometry.CornerRadius(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SELECTION_RADIUS_DP.dp.toPx()),
                    )
                }
                val handle = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SELECTION_HANDLE_DP.dp
                val outset = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SELECTION_HANDLE_OUTSET_DP.dp
                val handleShape = RoundedCornerShape(1.dp)
                Box(Modifier.align(Alignment.TopStart).offset(x = -outset, y = -outset).size(handle).clip(handleShape).border(1.dp, accent, handleShape).background(Color.White))
                Box(Modifier.align(Alignment.BottomEnd).offset(x = outset, y = outset).size(handle).clip(handleShape).border(1.dp, accent, handleShape).background(Color.White))
                Text(
                    ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_CONVERT,
                    fontSize = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SELECTION_LABEL_SP.sp,
                    fontWeight = FontWeight(ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SELECTION_LABEL_WEIGHT),
                    color = Color.White,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .offset(y = -ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SELECTION_LABEL_RISE_DP.dp)
                        .clip(labelShape)
                        .background(Color(ch.fasrv.fanotes.desk.firstRunWritingSelectionLabel(accentArgb)))
                        .padding(
                            horizontal = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SELECTION_LABEL_PAD_INLINE_DP.dp,
                            vertical = ch.fasrv.fanotes.desk.FIRST_RUN_WRITING_SELECTION_LABEL_PAD_BLOCK_DP.dp,
                        ),
                )
            }
        }
    }
}

@Composable
private fun FirstRunContinue(label: String, onClick: () -> Unit) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.FIRST_RUN_CONTINUE_RADIUS_DP.dp)
    Row(
        Modifier.height(ch.fasrv.fanotes.desk.FIRST_RUN_CONTINUE_DP.dp).widthIn(min = 160.dp).clip(shape).background(MaterialTheme.colorScheme.onSurface).clickable(onClick = onClick).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
    ) {
        Text(label, fontSize = 12.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.background)
        Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null, modifier = Modifier.size(17.dp), tint = MaterialTheme.colorScheme.background)
    }
}

@Composable
private fun FirstRunQuiet(label: String, leading: Boolean = false, onClick: () -> Unit) {
    Row(
        Modifier.height(34.dp).clip(RoundedCornerShape(8.dp)).clickable(onClick = onClick).padding(horizontal = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (leading) Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null, modifier = Modifier.size(16.dp), tint = LocalStatusInk.current.muted)
        Text(label, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = LocalStatusInk.current.muted)
    }
}

@Composable
private fun FirstRunProfiles(selectedId: String, besideCopy: Boolean = false, onPick: (String) -> Unit) {
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    Column(
        Modifier.padding(top = if (besideCopy) 0.dp else 28.dp).fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        ch.fasrv.fanotes.desk.firstRunProfiles().chunked(2).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(11.dp), verticalAlignment = Alignment.Top) {
                row.forEach { profile ->
                    FirstRunProfileCard(profile, profile.id == selectedId, accent, Modifier.weight(1f)) { onPick(profile.id) }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun FirstRunProfileCard(
    profile: ch.fasrv.fanotes.desk.FirstRunProfile,
    selected: Boolean,
    accent: Color,
    modifier: Modifier,
    onPick: () -> Unit,
) {
    val icons = mapOf(
        "school" to Icons.AutoMirrored.Filled.MenuBook,
        "university" to Icons.Filled.School,
        "private" to Icons.Filled.Home,
        "work" to Icons.Filled.Work,
    )
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.FIRST_RUN_PROFILE_RADIUS_DP.dp)
    Row(
        modifier.heightIn(min = ch.fasrv.fanotes.desk.FIRST_RUN_PROFILE_MIN_DP.dp).clip(shape).border(1.dp, if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.7f) else MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA), shape).background(if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.14f) else MaterialTheme.colorScheme.surface).clickable(onClick = onPick).padding(21.dp),
        horizontalArrangement = Arrangement.spacedBy(13.dp),
    ) {
        Box(Modifier.size(45.dp).clip(RoundedCornerShape(13.dp)).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.11f)), contentAlignment = Alignment.Center) {
            Icon(icons[profile.id] ?: Icons.Filled.Folder, contentDescription = null, modifier = Modifier.size(23.dp), tint = accent)
        }
        Column(Modifier.weight(1f)) {
            Text(profile.title, fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.padding(top = 2.dp))
            Text(profile.description, fontSize = 12.sp, color = LocalStatusInk.current.muted, lineHeight = 19.sp, modifier = Modifier.padding(top = 8.dp))
        }
        Box(
            Modifier.size(20.dp).clip(CircleShape).border(1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA), CircleShape).background(if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface),
            contentAlignment = Alignment.Center,
        ) {
            if (selected) Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(12.dp), tint = MaterialTheme.colorScheme.onPrimary)
        }
    }
}

@Composable
fun StudyScreen(model: FaNotesViewModel) {
    val picture by model.study.collectAsStateWithLifecycle()
    val overview = picture
    Column(Modifier.fillMaxSize().padding(16.dp).verticalScroll(rememberScrollState())) {
        Text("Lernzeit", style = MaterialTheme.typography.titleLarge)
        Text("Aus den stillen Seitenstatistiken auf diesem Gerät. Nichts wird gesendet.", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
        if (overview == null) {
            Text("Wird gelesen …", modifier = Modifier.padding(top = 12.dp))
        } else {
            Text("${overview.notes} Seiten", modifier = Modifier.padding(top = 12.dp))
            Text("Auf Seiten  ${ch.fasrv.fanotes.desk.formatStudyDuration(overview.dwellMs)}", modifier = Modifier.padding(top = 8.dp))
            Text("Tippen  ${ch.fasrv.fanotes.desk.formatStudyDuration(overview.typingMs)}")
            Text("Handschrift  ${ch.fasrv.fanotes.desk.formatStudyDuration(overview.inkMs)}")
            Text("Tinte  ${kotlin.math.round(overview.inkMm).toInt()} mm")
            val peak = overview.dwellByWeekday.maxOrNull()?.coerceAtLeast(1) ?: 1L
            Row(Modifier.fillMaxWidth().padding(top = 16.dp).height(120.dp), verticalAlignment = Alignment.Bottom) {
                listOf("So", "Mo", "Di", "Mi", "Do", "Fr", "Sa").forEachIndexed { index, label ->
                    val value = overview.dwellByWeekday.getOrElse(index) { 0L }
                    val bar = (4 + (value.toFloat() / peak.toFloat()) * 88).dp
                    Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(Modifier.fillMaxWidth().padding(horizontal = 4.dp).height(bar).background(MaterialTheme.colorScheme.primary))
                        Text(label, fontSize = 11.sp)
                    }
                }
            }
            Text("Fächer", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 16.dp))
            if (overview.subjects.isEmpty()) Text("Noch keine Seitenstatistik.")
            overview.subjects.forEach { row ->
                Text(ch.fasrv.fanotes.desk.studySubjectSummary(row))
            }
        }
    }
}

@Composable
fun ConflictList(model: FaNotesViewModel) {
    val sync by model.sync.collectAsStateWithLifecycle()
    val review by model.conflictReview.collectAsStateWithLifecycle()
    if (sync.conflicts.isEmpty()) return
    SettingCard("Konfliktkopien", Icons.Filled.Warning, action = {
        SyncCardAction("Liste leeren") { model.clearSyncConflicts() }
    }) {
        sync.conflicts.asReversed().forEachIndexed { index, conflict ->
            val markdown = ch.fasrv.fanotes.desk.isMarkdownConflictPath(conflict.path)
            val current = review?.takeIf { it.copyPath == conflict.copyPath }
            SettingRow(conflict.path, "Lokale Fassung gesichert als „${conflict.copyPath}“", divider = index != sync.conflicts.lastIndex || current != null) {
                Row {
                    if (markdown) {
                        TextButton(onClick = { model.openConflictReview(conflict) }) { Text("Vergleichen") }
                    }
                    TextButton(onClick = { model.resolveConflict(conflict, "remote") }) { Text(ch.fasrv.fanotes.sync.conflictChoiceLabel("remote")) }
                    TextButton(onClick = { model.resolveConflict(conflict, "local") }) { Text(ch.fasrv.fanotes.sync.conflictChoiceLabel("local")) }
                    if (markdown) {
                        TextButton(onClick = { model.resolveConflict(conflict, "both") }) { Text(ch.fasrv.fanotes.sync.conflictChoiceLabel("both")) }
                    }
                }
            }
            if (current != null) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 15.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Markdown-Konflikt. Die Serverfassung behält den Pfad, die lokale Fassung liegt in der Kopie.", fontSize = 12.sp, color = LocalStatusInk.current.muted)
                    Column(Modifier.heightIn(max = 180.dp).verticalScroll(rememberScrollState())) {
                        ch.fasrv.fanotes.sync.conflictDiffRows(current.local, current.remote).forEach { row ->
                            val color = when (row.kind) {
                                "added" -> LocalStatusInk.current.success
                                "removed" -> MaterialTheme.colorScheme.error
                                else -> LocalStatusInk.current.soft
                            }
                            Text(
                                "${ch.fasrv.fanotes.sync.conflictDiffMark(row.kind)} ${row.text}",
                                fontSize = 12.sp,
                                fontFamily = FontFamily.Monospace,
                                color = color,
                            )
                        }
                    }
                    TextButton(onClick = { model.closeConflictReview() }) { Text("Schließen") }
                }
            }
        }
    }
}

@Composable
private fun SyncLogCard(log: List<ch.fasrv.fanotes.sync.SyncLogEntry>) {
    if (log.isEmpty()) return
    var open by remember { mutableStateOf(false) }
    SettingCard("Protokoll", Icons.Filled.Sync, action = {
        SyncCardAction(ch.fasrv.fanotes.sync.syncLogToggleLabel(log.size, open)) { open = !open }
    }) {
        if (open) {
            Column(
                Modifier
                    .heightIn(max = ch.fasrv.fanotes.sync.SYNC_LOG_MAX_DP.dp)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 15.dp, vertical = 6.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                ch.fasrv.fanotes.sync.visibleSyncLog(log).forEach { entry ->
                    val tone = when (ch.fasrv.fanotes.sync.syncLogTone(entry.level)) {
                        "danger" -> MaterialTheme.colorScheme.error
                        "warning" -> MaterialTheme.colorScheme.error.copy(alpha = 0.7f)
                        else -> LocalStatusInk.current.soft
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(
                            ch.fasrv.fanotes.sync.syncDeviceSeenLabel(entry.at),
                            modifier = Modifier.width(ch.fasrv.fanotes.sync.SYNC_LOG_TIME_DP.dp),
                            fontSize = 12.sp,
                            color = LocalStatusInk.current.muted,
                            maxLines = 1,
                        )
                        Text(entry.text, fontSize = 12.sp, color = tone, lineHeight = 17.sp, modifier = Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

@Composable
private fun SyncPasswordCards(model: FaNotesViewModel) {
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var repeatPassword by remember { mutableStateOf("") }
    var deleteOpen by remember { mutableStateOf(false) }
    var deletePassword by remember { mutableStateOf("") }
    val mask = PasswordVisualTransformation()
    SettingCard("Passwort ändern", Icons.Filled.Key) {
        SettingRow("Aktuelles Passwort") {
            OutlinedTextField(current, { current = it }, modifier = Modifier.widthIn(min = 170.dp), singleLine = true, visualTransformation = mask)
        }
        SettingRow("Neues Passwort") {
            OutlinedTextField(next, { next = it }, modifier = Modifier.widthIn(min = 170.dp), singleLine = true, visualTransformation = mask)
        }
        SettingRow("Neues Passwort wiederholen", "Der Vault-Schlüssel wird nur neu verpackt. Keine Datei muss neu hochgeladen werden.", divider = false) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(repeatPassword, { repeatPassword = it }, modifier = Modifier.widthIn(min = 170.dp), singleLine = true, visualTransformation = mask)
                TextButton(onClick = { model.changeSyncPassword(current, next, repeatPassword) }, enabled = current.isNotEmpty() && next.isNotEmpty()) {
                    Text("Passwort ändern")
                }
            }
        }
    }
    SettingCard("Konto löschen", Icons.Filled.Delete) {
        SettingRow("Konto und alle Daten auf dem Server löschen", "Die Notizen auf deinen Geräten bleiben erhalten. Andere Geräte werden abgemeldet.", divider = false) {
            if (!deleteOpen) {
                TextButton(onClick = { deleteOpen = true }) { Text("Konto löschen") }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Zur Bestätigung dein Passwort:", fontSize = 12.sp, color = LocalStatusInk.current.muted)
                    OutlinedTextField(deletePassword, { deletePassword = it }, modifier = Modifier.widthIn(min = 170.dp), singleLine = true, visualTransformation = mask)
                    Row {
                        TextButton(onClick = { deleteOpen = false; deletePassword = "" }) { Text("Abbrechen") }
                        TextButton(onClick = { model.deleteSyncAccount(deletePassword) }, enabled = deletePassword.isNotEmpty()) { Text("Endgültig löschen") }
                    }
                }
            }
        }
    }
}

@Composable
private fun SyncCardAction(label: String, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val pressed by interaction.collectIsPressedAsState()
    val hot = hovered || pressed
    Text(
        label,
        fontSize = 12.sp,
        fontWeight = FontWeight(600),
        color = if (hot) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.muted,
        modifier = Modifier
            .heightIn(min = 24.dp)
            .clip(RoundedCornerShape(6.dp))
            .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA), RoundedCornerShape(6.dp))
            .background(if (hot) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
            .hoverable(interaction)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick)
            .padding(horizontal = 9.dp)
            .wrapContentHeight(Alignment.CenterVertically),
    )
}

@Composable
private fun AiStep(number: Int, title: String, detail: String, content: @Composable () -> Unit) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.AI_STEP_RADIUS_DP.dp)
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    Column(
        Modifier.fillMaxWidth().clip(shape).border(1.dp, rule, shape).background(LocalStatusInk.current.panelStrong.copy(alpha = 0.76f)).padding(13.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp), modifier = Modifier.padding(bottom = 12.dp)) {
            Box(
                Modifier.size(25.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.onSurface),
                contentAlignment = Alignment.Center,
            ) {
                Text("$number", fontSize = 12.sp, color = MaterialTheme.colorScheme.background)
            }
            Column {
                Text(title, fontSize = 12.sp)
                Text(detail, fontSize = 12.sp, color = LocalStatusInk.current.muted, modifier = Modifier.padding(top = 2.dp))
            }
        }
        content()
    }
}

@Composable
private fun AiChoiceGrid(count: Int, minColumns: Int, forcedColumns: Int = 0, item: @Composable (Int) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val columns = when {
            maxWidth < 420.dp -> 1
            forcedColumns > 0 -> forcedColumns
            maxWidth < 720.dp && minColumns > 2 -> 2
            else -> minColumns
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            (0 until count).chunked(columns).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    row.forEach { index ->
                        Box(Modifier.weight(1f)) { item(index) }
                    }
                    repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

@Composable
private fun AiChoiceCard(title: String, detail: String, badge: String, selected: Boolean, minDp: Int, onClick: () -> Unit) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.AI_CARD_RADIUS_DP.dp)
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    val border = if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.52f) else MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    val fill = if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.17f) else MaterialTheme.colorScheme.background.copy(alpha = 0.63f)
    Column(
        Modifier.fillMaxWidth().heightIn(min = minDp.dp).clip(shape).border(1.dp, border, shape).background(fill).clickable(onClick = onClick).padding(horizontal = 7.dp, vertical = 9.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            Box(Modifier.size(27.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.11f)), contentAlignment = Alignment.Center) {
                if (selected) Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(14.dp), tint = accent) else Spacer(Modifier.size(14.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(title, fontSize = 12.sp, maxLines = 2, color = if (selected) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.soft)
                Text(detail, fontSize = 12.sp, color = LocalStatusInk.current.muted, maxLines = 2, modifier = Modifier.padding(top = 3.dp))
            }
        }
        if (badge.isNotEmpty()) {
            Text(badge.uppercase(java.util.Locale.GERMAN), fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.06.em, color = LocalStatusInk.current.muted, modifier = Modifier.padding(top = 6.dp))
        }
    }
}

@Composable
private fun AiPanelButton(label: String, primary: Boolean, enabled: Boolean = true, minWidth: Int = 0, onClick: () -> Unit) {
    val shape = RoundedCornerShape(6.dp)
    val fill = if (primary) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.panelStrong
    val ink = if (primary) MaterialTheme.colorScheme.background else LocalStatusInk.current.soft
    val border = if (primary) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)
    Box(
        Modifier
            .height(34.dp)
            .widthIn(min = minWidth.dp)
            .alpha(if (enabled) 1f else 0.45f)
            .clip(shape)
            .background(fill)
            .border(1.dp, border, shape)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, fontSize = 12.sp, fontWeight = FontWeight.Medium, color = ink, maxLines = 1)
    }
}

@Composable
private fun AiSegment(label: String, selected: Boolean, onClick: () -> Unit) {
    Text(
        label,
        fontSize = 12.sp,
        color = if (selected) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.muted,
        modifier = Modifier
            .height(27.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(if (selected) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp)
            .wrapContentHeight(Alignment.CenterVertically),
    )
}

@Composable
private fun AiField(
    label: String,
    value: String,
    onValue: (String) -> Unit,
    hint: String = "",
    password: Boolean = false,
    minLines: Int = 1,
) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.AI_FIELD_RADIUS_DP.dp)
    var focused by remember { mutableStateOf(false) }
    val border = if (focused) {
        MaterialTheme.colorScheme.primary
    } else {
        MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)
    }
    Column(Modifier.fillMaxWidth().padding(top = 9.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(label, fontSize = 12.sp, fontWeight = FontWeight(650), color = LocalStatusInk.current.soft)
        BasicTextField(
            value = value,
            onValueChange = onValue,
            singleLine = minLines == 1,
            minLines = minLines,
            visualTransformation = if (password) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
            textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = 12.sp, lineHeight = 17.4.sp),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            modifier = Modifier
                .fillMaxWidth()
                .then(
                    if (minLines > 1) Modifier.heightIn(min = ch.fasrv.fanotes.desk.AI_FIELD_AREA_DP.dp)
                    else Modifier.height(ch.fasrv.fanotes.desk.AI_FIELD_HEIGHT_DP.dp),
                )
                .clip(shape)
                .border(1.dp, border, shape)
                .background(MaterialTheme.colorScheme.background)
                .onFocusChanged { focused = it.isFocused }
                .padding(horizontal = 9.dp, vertical = if (minLines > 1) 8.dp else 0.dp),
            decorationBox = { inner ->
                Box(
                    Modifier.fillMaxWidth().then(if (minLines == 1) Modifier.fillMaxHeight() else Modifier),
                    contentAlignment = if (minLines == 1) Alignment.CenterStart else Alignment.TopStart,
                ) {
                    if (value.isEmpty() && hint.isNotEmpty()) {
                        Text(hint, color = LocalStatusInk.current.muted, fontSize = 12.sp, maxLines = if (minLines == 1) 1 else 4)
                    }
                    inner()
                }
            },
        )
    }
}

@Composable
fun AiScreen(model: FaNotesViewModel) {
    val settings by model.deskSettings.collectAsStateWithLifecycle()
    val status by model.aiStatus.collectAsStateWithLifecycle()
    val busy by model.aiBusy.collectAsStateWithLifecycle()
    val preview by model.aiPreview.collectAsStateWithLifecycle()
    val previewPictures by model.previewImages.collectAsStateWithLifecycle()
    val models by model.aiModels.collectAsStateWithLifecycle()
    val provider = settings["ai-provider"].orEmpty().ifBlank { "lmstudio" }
    val definition = ch.fasrv.fanotes.desk.AI_PROVIDERS.firstOrNull { it.id == provider } ?: ch.fasrv.fanotes.desk.AI_PROVIDERS.first()
    var actions by remember { mutableStateOf(setOf("spelling")) }
    var instruction by remember { mutableStateOf("") }
    var pretty by remember { mutableStateOf(true) }
    val note by model.open.collectAsStateWithLifecycle()
    val live by model.markdown.collectAsStateWithLifecycle()
    LaunchedEffect(preview, note?.path) { model.syncPreviewImages(preview.orEmpty()) }
    fun setting(field: String) = settings["ai-$provider-$field"].orEmpty()
    val pageScroll = rememberScrollState()
    val configScroll = rememberScrollState()
    val previewAnchors = remember { androidx.compose.runtime.mutableStateMapOf<Int, Int>() }
    val previewLayouts = remember { androidx.compose.runtime.mutableStateMapOf<Int, TextLayoutResult>() }
    val previewScope = rememberCoroutineScope()
    var previewColumnTop by remember { mutableIntStateOf(0) }
    val calmMotion = ch.fasrv.fanotes.desk.reduceMotion(settings["reduce-motion"])
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    val canRun = !busy && note != null && setting("model").isNotBlank() && actions.isNotEmpty()
    val dismiss = { if (!busy) model.closeAi() }
    Dialog(onDismissRequest = dismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val scrim = remember { MutableInteractionSource() }
        val card = remember { MutableInteractionSource() }
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val viewportWidth = maxWidth.value.toInt().coerceAtLeast(0)
            val viewportHeight = maxHeight.value.toInt().coerceAtLeast(0)
            val panel = ch.fasrv.fanotes.desk.aiPanelSize(viewportWidth, viewportHeight)
            val panelShape = RoundedCornerShape(panel.radiusDp.dp)
            val panelRule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color(ch.fasrv.fanotes.desk.PALETTE_SCRIM))
                    .clickable(interactionSource = scrim, indication = null, enabled = !busy, onClick = dismiss),
                contentAlignment = Alignment.Center,
            ) {
    Column(
        Modifier
            .width(panel.widthDp.dp)
            .requiredHeight(panel.heightDp.dp)
            .clickable(interactionSource = card, indication = null, onClick = {})
            .clip(panelShape)
            .then(
                if (panel.radiusDp == 0) Modifier
                else Modifier.border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA), panelShape),
            )
            .background(MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.fillMaxWidth().height(ch.fasrv.fanotes.desk.AI_HEADER_DP.dp).background(MaterialTheme.colorScheme.background)) {
        Row(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 18.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                Modifier.size(ch.fasrv.fanotes.desk.AI_MARK_DP.dp).clip(RoundedCornerShape(ch.fasrv.fanotes.desk.AI_MARK_RADIUS_DP.dp)).background(MaterialTheme.colorScheme.onSurface),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.AutoAwesome, contentDescription = null, modifier = Modifier.size(ch.fasrv.fanotes.desk.AI_MARK_ICON_DP.dp), tint = MaterialTheme.colorScheme.background)
            }
            Column(Modifier.weight(1f)) {
                Text(ch.fasrv.fanotes.desk.AI_PANEL_EYEBROW.uppercase(java.util.Locale.GERMAN), fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.12.em, color = accent, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(ch.fasrv.fanotes.desk.AI_PANEL_TITLE, fontSize = 18.sp, letterSpacing = (-0.035).em, maxLines = 1)
                Text(ch.fasrv.fanotes.desk.AI_PANEL_DETAIL, fontSize = 12.sp, color = LocalStatusInk.current.muted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp))
            }
            Box(
                Modifier.size(34.dp).clip(RoundedCornerShape(6.dp)).clickable(enabled = !busy, onClick = dismiss),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Close, contentDescription = ch.fasrv.fanotes.desk.AI_CLOSE, modifier = Modifier.size(18.dp), tint = LocalStatusInk.current.muted)
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(panelRule))
        }
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val panelWidth = viewportWidth
            val configPane: @Composable () -> Unit = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    AiStep(1, ch.fasrv.fanotes.desk.AI_STEP_PROVIDERS, ch.fasrv.fanotes.desk.AI_STEP_PROVIDERS_DETAIL) {
                        AiChoiceGrid(ch.fasrv.fanotes.desk.AI_PROVIDERS.size, minColumns = 3, forcedColumns = ch.fasrv.fanotes.desk.aiProviderColumns(panelWidth)) { index ->
                            val entry = ch.fasrv.fanotes.desk.AI_PROVIDERS[index]
                            AiChoiceCard(
                                entry.title,
                                entry.description,
                                ch.fasrv.fanotes.desk.aiProviderKind(entry.local),
                                entry.id == provider,
                                minDp = ch.fasrv.fanotes.desk.AI_PROVIDER_MIN_DP,
                            ) {
                                model.aiModels.value = emptyList()
                                model.updateDesk("ai-provider", entry.id)
                            }
                        }
                        Text(
                            "${definition.title} verbinden",
                            fontSize = 12.sp,
                            modifier = Modifier.padding(top = 12.dp),
                        )
                        Text(
                            if (definition.local) "Deine Notiz bleibt im lokalen Netzwerk." else "Die Notiz wird zur Verarbeitung an den gewählten Anbieter übertragen.",
                            fontSize = 12.sp,
                            color = LocalStatusInk.current.muted,
                        )
                        if (definition.local) {
                            AiField(
                                "Server-Adresse",
                                setting("url").ifBlank { ch.fasrv.fanotes.desk.defaultAiBaseUrl(provider) },
                                { model.updateDesk("ai-$provider-url", it) },
                                hint = ch.fasrv.fanotes.desk.defaultAiBaseUrl(provider),
                            )
                        }
                        if (provider == "opencode") {
                            AiField("Benutzername", setting("user").ifBlank { "opencode" }, { model.updateDesk("ai-$provider-user", it) })
                        }
                        AiField(
                            when {
                                provider == "opencode" -> "Server-Passwort"
                                definition.local -> "API-Token"
                                else -> "API-Schlüssel"
                            },
                            setting("key"),
                            { model.updateDesk("ai-$provider-key", it) },
                            hint = if (definition.local) "Nur bei aktivierter Authentifizierung" else "${definition.title}-Schlüssel eingeben",
                            password = true,
                        )
                        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                            Box(Modifier.weight(1f)) {
                                AiField("Modell", setting("model"), { model.updateDesk("ai-$provider-model", it) }, hint = "Modell auswählen …")
                            }
                            val refreshShape = RoundedCornerShape(ch.fasrv.fanotes.desk.AI_FIELD_RADIUS_DP.dp)
                            Box(
                                Modifier
                                    .padding(bottom = 0.dp)
                                    .size(width = 34.dp, height = ch.fasrv.fanotes.desk.AI_FIELD_HEIGHT_DP.dp)
                                    .clip(refreshShape)
                                    .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA), refreshShape)
                                    .background(MaterialTheme.colorScheme.background)
                                    .clickable { model.loadAiModels(provider, setting("url"), setting("key"), setting("user")) },
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(Icons.Filled.Sync, contentDescription = "Modelle laden", modifier = Modifier.size(16.dp), tint = accent)
                            }
                        }
                        models.forEach { listed ->
                            val chosen = setting("model") == listed.key
                            Column(
                                Modifier
                                    .fillMaxWidth()
                                    .padding(top = 9.dp)
                                    .heightIn(min = 43.dp)
                                    .clip(RoundedCornerShape(9.dp))
                                    .border(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = if (chosen) 0.14f else 0f), RoundedCornerShape(9.dp))
                                    .background(MaterialTheme.colorScheme.primary.copy(alpha = if (chosen) 0.085f else 0f))
                                    .clickable { model.updateDesk("ai-$provider-model", listed.key) }
                                    .padding(horizontal = 9.dp, vertical = 7.dp),
                            ) {
                                Text(listed.title, fontSize = 12.sp, fontWeight = if (chosen) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1)
                                if (listed.detail.isNotBlank()) Text(listed.detail, fontSize = 12.sp, color = LocalStatusInk.current.muted, maxLines = 1)
                            }
                        }
                    }
                    AiStep(2, ch.fasrv.fanotes.desk.AI_STEP_ACTIONS, ch.fasrv.fanotes.desk.aiActionCountLabel(actions.size)) {
                        AiChoiceGrid(ch.fasrv.fanotes.desk.AI_ACTIONS.size, minColumns = 2, forcedColumns = ch.fasrv.fanotes.desk.aiActionColumns(panelWidth)) { index ->
                            val action = ch.fasrv.fanotes.desk.AI_ACTIONS[index]
                            val selected = action.id in actions
                            AiChoiceCard(action.title, action.description, if (action.additive) "ergänzt" else "", selected, minDp = ch.fasrv.fanotes.desk.AI_ACTION_MIN_DP) {
                                actions = if (selected) actions - action.id else actions + action.id
                            }
                        }
                        if ("instruction" in actions) {
                            AiField(ch.fasrv.fanotes.desk.AI_INSTRUCTION_LABEL, instruction, { instruction = it }, hint = ch.fasrv.fanotes.desk.AI_INSTRUCTION_HINT, minLines = 4)
                        }
                        if ("facts" in actions) {
                            Text(ch.fasrv.fanotes.desk.AI_FACTS_WARNING, fontSize = 12.sp, lineHeight = 17.sp, color = LocalStatusInk.current.warning, modifier = Modifier.padding(top = 9.dp))
                        }
                    }
                }
            }
            val previewPane: @Composable () -> Unit = {
        Column(Modifier.fillMaxWidth().padding(horizontal = 15.dp, vertical = 12.dp)) {
        val result = preview
        if (result == null) {
            Text("Deine Notiz bleibt unverändert", fontWeight = FontWeight.SemiBold)
            Text(
                "FaNotes erstellt zuerst eine Vorschau. Erst „Ergebnis übernehmen“ ersetzt den Inhalt der geöffneten Markdown-Datei.",
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f),
            )
            if (note != null) {
                Text("Aktuelle Notiz", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                Text(note?.path.orEmpty(), fontWeight = FontWeight.SemiBold)
                Text("${live.length} Zeichen", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f))
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { pretty = true }) {
                    Text("Schön", fontWeight = if (pretty) FontWeight.SemiBold else FontWeight.Normal, color = if (pretty) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                }
                TextButton(onClick = { pretty = false }) {
                    Text("Markdown", fontWeight = if (!pretty) FontWeight.SemiBold else FontWeight.Normal, color = if (!pretty) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                }
            }
            val metrics = ch.fasrv.fanotes.desk.editorMetrics(settings)
            val base = metrics.previewFontPx
            val leading = metrics.lineHeight.toFloat()
            fun previewLeading(scale: Float, kind: String): TextUnit {
                val em = ch.fasrv.fanotes.desk.previewLineHeightEm(kind, leading.toDouble())
                return (base * scale * em).sp
            }
            if (!pretty) {
                Text(result, fontFamily = FontFamily.Monospace, fontSize = base.sp)
            } else {
                val link = MaterialTheme.colorScheme.primary
                val muted = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.72f)
                val palette = ch.fasrv.fanotes.desk.themePalette(settings["theme"], androidx.compose.foundation.isSystemInDarkTheme())
                val codeInk = Color(android.graphics.Color.parseColor(ch.fasrv.fanotes.desk.previewCodeInk(settings["accent-secondary"], palette.text)))
                val codeFill = Color(android.graphics.Color.parseColor(palette.panelStrong))
                val codeBorder = MaterialTheme.colorScheme.outline.copy(alpha = 0.55f)
                val lines = ch.fasrv.fanotes.desk.aiPreviewReading(result)
                fun jumpTo(target: Int) {
                    val y = previewAnchors[target] ?: return
                    previewScope.launch {
                        if (calmMotion) pageScroll.scrollTo(y) else pageScroll.animateScrollTo(y)
                    }
                }
                fun Modifier.previewAnchor(lineIndex: Int): Modifier = onGloballyPositioned { coords ->
                    previewAnchors[lineIndex] = (coords.positionInRoot().y.roundToInt() - previewColumnTop + pageScroll.value).coerceAtLeast(0)
                }
                fun Modifier.previewFootnote(lineIndex: Int): Modifier = previewAnchor(lineIndex).pointerInput(lines, lineIndex, calmMotion) {
                    detectTapGestures { offset ->
                        val layout = previewLayouts[lineIndex] ?: return@detectTapGestures
                        val line = lines[lineIndex]
                        val (expanded, expandedMarks) = ch.fasrv.fanotes.desk.expandFieldSeparators(line.text, line.inlines)
                        val display = ch.fasrv.fanotes.desk.previewCodeDisplay(expanded, expandedMarks)
                        val shown = layout.getOffsetForPosition(offset)
                        val source = if (expanded == line.text) ch.fasrv.fanotes.desk.previewSourceOffset(display.sourceAt, shown) else shown
                        val target = ch.fasrv.fanotes.desk.footnoteJumpIndex(lines, lineIndex, source) ?: return@detectTapGestures
                        jumpTo(target)
                    }
                }
                var index = 0
                while (index < lines.size) {
                    val line = lines[index]
                    if (line.kind == "table") {
                        val rows = ArrayList<ch.fasrv.fanotes.desk.DetailsReadingLine>()
                        val start = index
                        while (index < lines.size && lines[index].kind == "table") {
                            rows += lines[index]
                            index += 1
                        }
                        PreviewTable(rows, base, link, codeInk, codeFill, codeBorder, Modifier.previewAnchor(start), start == 0, leading) { number ->
                            ch.fasrv.fanotes.desk.footnoteDefinitionIndex(lines, number)?.let(::jumpTo)
                        }
                        continue
                    }
                    val lineIndex = index
                    index += 1
                    when (line.kind) {
                        "rule" -> {
                            val rule = ch.fasrv.fanotes.desk.previewRuleChrome()
                            Box(
                                Modifier
                                    .previewAnchor(lineIndex)
                                    .padding(
                                        top = (base * ch.fasrv.fanotes.desk.previewBlockTop(rule.marginEm, lineIndex == 0)).dp,
                                        bottom = (base * rule.marginEm).dp,
                                    )
                                    .fillMaxWidth()
                                    .height(rule.heightDp.dp)
                                    .background(MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_ALPHA)),
                            )
                        }
                        "quote" -> {
                            val quote = ch.fasrv.fanotes.desk.previewQuoteChrome()
                            val quoteShape = RoundedCornerShape(topEnd = quote.radiusDp.dp, bottomEnd = quote.radiusDp.dp)
                            Row(
                                Modifier
                                    .padding(
                                        top = (base * ch.fasrv.fanotes.desk.previewBlockTop(quote.marginEm, lineIndex == 0)).dp,
                                        bottom = (base * quote.marginEm).dp,
                                    )
                                    .fillMaxWidth()
                                    .height(IntrinsicSize.Min)
                                    .clip(quoteShape)
                                    .background(MaterialTheme.colorScheme.surface),
                                verticalAlignment = Alignment.Top,
                            ) {
                                Box(
                                    Modifier
                                        .width(quote.barDp.dp)
                                        .fillMaxHeight()
                                        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)),
                                )
                                PreviewRich(
                                    line.text,
                                    line.inlines,
                                    base,
                                    line.scale,
                                    link,
                                    codeInk,
                                    codeFill,
                                    codeBorder,
                                    line.kind,
                                    Modifier.previewFootnote(lineIndex).padding(
                                        horizontal = (base * quote.padXEm).dp,
                                        vertical = (base * quote.padYEm).dp,
                                    ),
                                    color = LocalStatusInk.current.soft,
                                    lineHeight = previewLeading(line.scale, "quote"),
                                    onTextLayout = { previewLayouts[lineIndex] = it },
                                )
                            }
                        }
                        "code" -> if (line.text.isNotEmpty()) {
                            key(lineIndex) {
                                val fence = ch.fasrv.fanotes.desk.previewFenceChrome()
                                val blockScroll = rememberScrollState()
                                val shape = RoundedCornerShape(fence.radiusDp.dp)
                                Box(
                                    Modifier
                                        .previewAnchor(lineIndex)
                                        .fillMaxWidth()
                                        .clip(shape)
                                        .background(MaterialTheme.colorScheme.surface)
                                        .border(
                                            fence.borderDp.dp,
                                            MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA),
                                            shape,
                                        )
                                        .horizontalScroll(blockScroll)
                                        .padding(horizontal = (base * fence.padXEm).dp, vertical = (base * fence.padYEm).dp),
                                ) {
                                    Text(
                                        previewAnnotated(line, base, link),
                                        color = MaterialTheme.colorScheme.onSurface,
                                        softWrap = false,
                                        fontSize = (base * ch.fasrv.fanotes.desk.PREVIEW_CODE_SCALE).sp,
                                        lineHeight = previewLeading(ch.fasrv.fanotes.desk.PREVIEW_CODE_SCALE, "code"),
                                        fontFamily = FontFamily.Monospace,
                                    )
                                }
                            }
                        }
                        "math" -> if (line.text.isNotEmpty()) {
                            key(lineIndex) {
                                val math = ch.fasrv.fanotes.desk.previewMathChrome()
                                val blockScroll = rememberScrollState()
                                val shape = RoundedCornerShape(math.radiusDp.dp)
                                Box(
                                    Modifier
                                        .previewAnchor(lineIndex)
                                        .padding(
                                            top = (base * ch.fasrv.fanotes.desk.previewBlockTop(math.marginEm, lineIndex == 0)).dp,
                                            bottom = (base * math.marginEm).dp,
                                        )
                                        .fillMaxWidth()
                                        .clip(shape)
                                        .background(
                                            Brush.linearGradient(
                                                listOf(
                                                    MaterialTheme.colorScheme.primary.copy(alpha = math.accentWash),
                                                    MaterialTheme.colorScheme.secondary.copy(alpha = math.secondaryWash),
                                                ),
                                            ),
                                        )
                                        .border(
                                            1.dp,
                                            MaterialTheme.colorScheme.primary.copy(alpha = math.borderAlpha),
                                            shape,
                                        )
                                        .horizontalScroll(blockScroll)
                                        .padding(math.padEm.let { (base * it).dp }),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        previewAnnotated(line, base, link),
                                        softWrap = false,
                                        fontSize = (base * line.scale).sp,
                                        lineHeight = previewLeading(line.scale, "math"),
                                        fontFamily = FontFamily.Monospace,
                                    )
                                }
                            }
                        }
                        "image" -> {
                            val bitmap = previewPictures[line.source]?.takeIf { !it.isRecycled }
                            val frame = ch.fasrv.fanotes.desk.previewImageChrome()
                            if (bitmap != null) {
                                val imageShape = RoundedCornerShape(frame.radiusDp.dp)
                                BoxWithConstraints(
                                    Modifier
                                        .previewAnchor(lineIndex)
                                        .fillMaxWidth()
                                        .padding(
                                            top = (base * ch.fasrv.fanotes.desk.previewBlockTop(frame.marginEm, lineIndex == 0)).dp,
                                            bottom = (base * frame.marginEm).dp,
                                        ),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Image(
                                        bitmap.asImageBitmap(),
                                        contentDescription = line.text.ifBlank { "Bild" },
                                        modifier = Modifier
                                            .widthIn(max = maxWidth)
                                            .shadow(
                                                elevation = frame.shadowBlurDp.dp,
                                                shape = imageShape,
                                                clip = false,
                                                ambientColor = Color.Black.copy(alpha = frame.shadowAlpha),
                                                spotColor = Color.Black.copy(alpha = frame.shadowAlpha),
                                            )
                                            .clip(imageShape)
                                            .border(
                                                frame.borderDp.dp,
                                                MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_ALPHA),
                                                imageShape,
                                            )
                                            .background(Color.White),
                                        contentScale = ContentScale.Fit,
                                    )
                                }
                            } else if (line.text.isNotEmpty()) {
                                PreviewRich(
                                    line.text,
                                    line.inlines,
                                    base,
                                    line.scale,
                                    link,
                                    codeInk,
                                    codeFill,
                                    codeBorder,
                                    line.kind,
                                    Modifier.previewFootnote(lineIndex),
                                    color = MaterialTheme.colorScheme.onSurface,
                                    lineHeight = previewLeading(line.scale, line.kind),
                                    onTextLayout = { previewLayouts[lineIndex] = it },
                                )
                            }
                        }
                        "task" -> {
                            val taskLine = ch.fasrv.fanotes.desk.previewTaskLine(line.text, line.inlines)
                            val taskChrome = ch.fasrv.fanotes.desk.previewTaskChrome()
                            if (taskLine == null) {
                                PreviewRich(
                                    line.text,
                                    line.inlines,
                                    base,
                                    line.scale,
                                    link,
                                    codeInk,
                                    codeFill,
                                    codeBorder,
                                    line.kind,
                                    Modifier.previewFootnote(lineIndex),
                                    color = MaterialTheme.colorScheme.onSurface,
                                    lineHeight = previewLeading(line.scale, "task"),
                                    onTextLayout = { previewLayouts[lineIndex] = it },
                                )
                            } else {
                                Row(
                                    Modifier.padding(
                                        start = (base * ch.fasrv.fanotes.desk.previewFlowStart("task")).dp,
                                        top = (base * ch.fasrv.fanotes.desk.previewFlowTop("task", lineIndex == 0)).dp,
                                        bottom = (base * ch.fasrv.fanotes.desk.previewFlowBottom("task")).dp,
                                    ),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    if (taskLine.indent.isNotEmpty()) {
                                        Text(taskLine.indent, fontSize = base.sp, color = MaterialTheme.colorScheme.onSurface)
                                    }
                                    Box(
                                        Modifier
                                            .size(taskChrome.boxDp.dp)
                                            .clip(RoundedCornerShape(3.dp))
                                            .background(if (taskLine.checked) link else Color.Transparent)
                                            .border(1.5.dp, link, RoundedCornerShape(3.dp)),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        if (taskLine.checked) {
                                            Text("✓", color = MaterialTheme.colorScheme.onPrimary, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                                        }
                                    }
                                    Spacer(Modifier.width((base * taskChrome.gapEm).dp))
                                    PreviewRich(
                                        taskLine.text,
                                        taskLine.inlines,
                                        base,
                                        line.scale,
                                        link,
                                        codeInk,
                                        codeFill,
                                        codeBorder,
                                        "paragraph",
                                        Modifier.previewFootnote(lineIndex).weight(1f, fill = false),
                                        color = MaterialTheme.colorScheme.onSurface,
                                        lineHeight = previewLeading(line.scale, "task"),
                                        onTextLayout = { previewLayouts[lineIndex] = it },
                                    )
                                }
                            }
                        }
                        else -> if (line.text.isNotEmpty()) {
                            val headingBox = if (line.kind == "heading") {
                                ch.fasrv.fanotes.desk.previewHeadingBox(line.scale, lineIndex == 0)
                            } else {
                                null
                            }
                            val flowTop = (base * line.scale) * (headingBox?.marginTopEm ?: 0f) +
                                base * ch.fasrv.fanotes.desk.previewFlowTop(line.kind, lineIndex == 0)
                            val flowBottom = (base * line.scale) * (headingBox?.marginBottomEm ?: 0f) +
                                base * ch.fasrv.fanotes.desk.previewFlowBottom(line.kind)
                            PreviewRich(
                                line.text,
                                line.inlines,
                                base,
                                line.scale,
                                link,
                                codeInk,
                                codeFill,
                                codeBorder,
                                line.kind,
                                Modifier
                                    .padding(
                                        start = (base * ch.fasrv.fanotes.desk.previewFlowStart(line.kind)).dp,
                                        top = flowTop.dp,
                                        bottom = flowBottom.dp,
                                    )
                                    .previewFootnote(lineIndex),
                                color = if (line.kind == "footnote") muted else MaterialTheme.colorScheme.onSurface,
                                fontWeight = if (line.heading) FontWeight.Bold else FontWeight.Normal,
                                fontFamily = if (line.kind == "code" || line.kind == "math") FontFamily.Monospace else FontFamily.Default,
                                letterSpacing = if (headingBox != null) headingBox.trackingEm.em else TextUnit.Unspecified,
                                lineHeight = previewLeading(line.scale, if (headingBox != null) "heading" else line.kind),
                                onTextLayout = { previewLayouts[lineIndex] = it },
                            )
                        }
                    }
                }
            }
        }
        }
            }
            val previewScroll = Modifier
                .onGloballyPositioned { previewColumnTop = it.positionInRoot().y.roundToInt() }
                .verticalScroll(pageScroll)
            val previewHeading = if (preview != null) "${definition.title} · Ergebnis" else note?.title?.ifBlank { null } ?: note?.path ?: "Keine Notiz geöffnet"
            val previewToolbar: @Composable () -> Unit = {
                Row(
                    Modifier.fillMaxWidth().height(ch.fasrv.fanotes.desk.AI_PREVIEW_TOOLBAR_DP.dp).padding(horizontal = 15.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(ch.fasrv.fanotes.desk.AI_PREVIEW_EYEBROW.uppercase(java.util.Locale.GERMAN), fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.12.em, color = accent, maxLines = 1)
                        Text(previewHeading, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (preview != null) {
                        Row(
                            Modifier.padding(start = 12.dp).clip(RoundedCornerShape(8.dp)).border(1.dp, panelRule, RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surface).padding(2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            AiSegment("Schön", pretty) { pretty = true }
                            AiSegment("Markdown", !pretty) { pretty = false }
                        }
                    }
                }
            }
            val previewFooter: @Composable () -> Unit = {
                Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)) {
                    if (status.isNotBlank()) {
                        Text(status, fontSize = 12.sp, color = LocalStatusInk.current.soft, modifier = Modifier.fillMaxWidth().padding(horizontal = 13.dp, vertical = 9.dp))
                    }
                    Box(Modifier.fillMaxWidth().height(1.dp).background(panelRule))
                    Row(
                        Modifier.fillMaxWidth().height(ch.fasrv.fanotes.desk.AI_FOOTER_DP.dp).padding(horizontal = 13.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                    ) {
                        if (preview != null) {
                            AiPanelButton(ch.fasrv.fanotes.desk.AI_RESET, primary = false) { model.aiPreview.value = null }
                            AiPanelButton(ch.fasrv.fanotes.desk.AI_APPLY, primary = true) { model.applyAiPreview() }
                        } else {
                            AiPanelButton(
                                ch.fasrv.fanotes.desk.AI_RUN,
                                primary = true,
                                enabled = canRun,
                                minWidth = ch.fasrv.fanotes.desk.AI_RUN_MIN_DP,
                            ) {
                                model.runAi(provider, setting("url"), setting("model"), setting("key"), setting("user"), actions.toList(), instruction)
                            }
                        }
                    }
                }
            }
            if (ch.fasrv.fanotes.desk.aiPanelStacks(panelWidth)) {
                Column(Modifier.fillMaxSize()) {
                    Column(Modifier.weight(1f).fillMaxWidth().then(previewScroll)) {
                        Column(Modifier.padding(15.dp)) { configPane() }
                        previewToolbar()
                        previewPane()
                    }
                    previewFooter()
                }
            } else {
                Row(Modifier.fillMaxSize()) {
                    Column(
                        Modifier
                            .width(ch.fasrv.fanotes.desk.aiConfigWidthDp(panelWidth).dp)
                            .fillMaxHeight()
                            .verticalScroll(configScroll)
                            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.84f))
                            .padding(15.dp),
                    ) { configPane() }
                    Box(Modifier.width(1.dp).fillMaxHeight().background(panelRule))
                    Column(Modifier.weight(1f).fillMaxHeight().background(MaterialTheme.colorScheme.background)) {
                        previewToolbar()
                        Box(Modifier.fillMaxWidth().height(1.dp).background(panelRule))
                        Column(Modifier.weight(1f).fillMaxWidth().then(previewScroll)) { previewPane() }
                        previewFooter()
                    }
                }
            }
        }
    }
            }
        }
    }
}

@Composable
private fun PreviewTable(
    rows: List<ch.fasrv.fanotes.desk.DetailsReadingLine>,
    base: Int,
    link: Color,
    codeInk: Color,
    codeFill: Color,
    codeBorder: Color,
    modifier: Modifier = Modifier,
    first: Boolean = false,
    leading: Float = 1.72f,
    onFootnote: (Int) -> Unit = {},
) {
    val chrome = ch.fasrv.fanotes.desk.previewTableChrome()
    val border = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_ALPHA)
    val frame = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)
    val shape = RoundedCornerShape(chrome.radiusDp.dp)
    val cellLayouts = remember { androidx.compose.runtime.mutableStateMapOf<String, TextLayoutResult>() }
    Column(
        modifier
            .padding(
                top = (base * ch.fasrv.fanotes.desk.previewBlockTop(chrome.marginEm, first)).dp,
                bottom = (base * chrome.marginEm).dp,
            )
            .fillMaxWidth()
            .clip(shape)
            .border(1.dp, frame, shape),
    ) {
        rows.forEachIndexed { rowIndex, row ->
            val cells = ch.fasrv.fanotes.desk.previewTableCells(row.text, row.inlines, row.source)
            val scale = if (row.heading) row.scale * ch.fasrv.fanotes.desk.PREVIEW_TABLE_HEAD else row.scale
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                cells.forEachIndexed { cellIndex, cell ->
                    val align = when (cell.align) {
                        ch.fasrv.fanotes.text.TableAlign.CENTER -> TextAlign.Center
                        ch.fasrv.fanotes.text.TableAlign.RIGHT -> TextAlign.End
                        ch.fasrv.fanotes.text.TableAlign.LEFT -> TextAlign.Start
                    }
                    Box(
                        Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .background(if (row.heading) codeFill else Color.Transparent),
                    ) {
                        val cellKey = "$rowIndex:$cellIndex"
                        PreviewRich(
                            cell.text,
                            cell.inlines,
                            base,
                            scale,
                            link,
                            codeInk,
                            codeFill,
                            codeBorder,
                            modifier = Modifier.fillMaxWidth().padding(
                                horizontal = (base * chrome.padXEm).dp,
                                vertical = (base * chrome.padYEm).dp,
                            ).pointerInput(cell.text, cell.inlines) {
                                detectTapGestures { offset ->
                                    val laid = cellLayouts[cellKey] ?: return@detectTapGestures
                                    val display = ch.fasrv.fanotes.desk.previewCodeDisplay(cell.text, cell.inlines)
                                    val source = ch.fasrv.fanotes.desk.previewSourceOffset(display.sourceAt, laid.getOffsetForPosition(offset))
                                    val number = ch.fasrv.fanotes.desk.footnoteNumberAtOffset(
                                        cell.text,
                                        cell.inlines,
                                        source,
                                    ) ?: return@detectTapGestures
                                    onFootnote(number)
                                }
                            },
                            textAlign = align,
                            fontWeight = if (row.heading) FontWeight.Bold else FontWeight.Normal,
                            lineHeight = (base * scale * leading).sp,
                            onTextLayout = { cellLayouts[cellKey] = it },
                        )
                        if (cellIndex < cells.lastIndex) {
                            Box(Modifier.align(Alignment.CenterEnd).fillMaxHeight().width(1.dp).background(border))
                        }
                    }
                }
            }
            if (rowIndex < rows.lastIndex) Box(Modifier.fillMaxWidth().height(1.dp).background(border))
        }
    }
}

@Composable
private fun PreviewRich(
    text: String,
    marks: List<ch.fasrv.fanotes.desk.DetailsInline>,
    base: Int,
    scale: Float,
    link: Color,
    codeInk: Color,
    codeFill: Color,
    codeBorder: Color,
    markerKind: String = "paragraph",
    modifier: Modifier = Modifier,
    color: Color = Color.Unspecified,
    fontWeight: FontWeight? = null,
    fontFamily: FontFamily? = null,
    textAlign: TextAlign = TextAlign.Start,
    letterSpacing: TextUnit = TextUnit.Unspecified,
    lineHeight: TextUnit = TextUnit.Unspecified,
    onTextLayout: (TextLayoutResult) -> Unit = {},
) {
    val (expanded, expandedMarks) = ch.fasrv.fanotes.desk.expandFieldSeparators(text, marks)
    val display = ch.fasrv.fanotes.desk.previewCodeDisplay(
        expanded,
        expandedMarks,
        ch.fasrv.fanotes.desk.previewMarkerEnd(expanded, markerKind),
    )
    val annotated = previewMarks(display.text, display.marks, base, scale, link, display.markerEnd)
    val box = ch.fasrv.fanotes.desk.previewCodeBox(base * scale)
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val chips = display.slots.associate { slot ->
        val measured = measurer.measure(
            slot.label,
            style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = box.textPx.sp),
        )
        val extraW = with(density) { (box.padX.dp * 2 + box.border.dp * 2).toPx() }
        val extraH = with(density) { (box.padY.dp * 2 + box.border.dp * 2).toPx() }
        slot.id to InlineTextContent(
            Placeholder(
                width = with(density) { (measured.size.width + extraW).toSp() },
                height = with(density) { (measured.size.height + extraH).toSp() },
                placeholderVerticalAlign = PlaceholderVerticalAlign.TextCenter,
            ),
        ) {
            Text(
                slot.label,
                color = codeInk,
                fontFamily = FontFamily.Monospace,
                fontSize = box.textPx.sp,
                modifier = Modifier
                    .border(box.border.dp, codeBorder, RoundedCornerShape(box.radius.dp))
                    .background(codeFill, RoundedCornerShape(box.radius.dp))
                    .padding(horizontal = box.padX.dp, vertical = box.padY.dp),
            )
        }
    }
    val shown = buildAnnotatedString {
        var slot = 0
        display.text.forEach { char ->
            if (char == '\uFFFC' && slot < display.slots.size) {
                appendInlineContent(display.slots[slot].id, "\uFFFC")
                slot += 1
            } else {
                append(char)
            }
        }
        annotated.spanStyles.forEach { addStyle(it.item, it.start, it.end) }
    }
    val laidState = remember { mutableStateOf<TextLayoutResult?>(null) }
    var hotLink by remember(text, marks) { mutableStateOf<Int?>(null) }
    val hot = hotLink
    Text(
        shown,
        modifier = modifier
            .pointerInput(text, marks) {
                awaitPointerEventScope {
                    while (true) {
                        val event = awaitPointerEvent(PointerEventPass.Main)
                        val change = event.changes.firstOrNull()
                        val position = change?.position
                        val result = laidState.value
                        if (change == null || position == null || result == null || event.type == PointerEventType.Exit) {
                            hotLink = null
                            continue
                        }
                        val hoverTool = change.type == PointerType.Mouse ||
                            change.type == PointerType.Stylus ||
                            change.type == PointerType.Eraser
                        val over = change.pressed || hoverTool
                        hotLink = if (over) previewLinkHotIndex(result, display.marks, position) else null
                    }
                }
            }
            .drawBehind {
                val result = laidState.value ?: return@drawBehind
                val stroke = ch.fasrv.fanotes.desk.PREVIEW_LINK_BORDER_DP.dp.toPx()
                display.marks.forEachIndexed { index, mark ->
                    if (mark.kind != "link") return@forEachIndexed
                    val ink = link.copy(alpha = ch.fasrv.fanotes.desk.previewLinkChrome(index == hot).alpha)
                    val start = mark.start.coerceIn(0, shown.length)
                    val end = mark.end.coerceIn(start, shown.length)
                    if (end <= start) return@forEachIndexed
                    val first = result.getLineForOffset(start)
                    val last = result.getLineForOffset((end - 1).coerceAtLeast(start))
                    for (line in first..last) {
                        val lineStart = maxOf(start, result.getLineStart(line))
                        val lineEnd = minOf(end, result.getLineEnd(line, true))
                        if (lineEnd <= lineStart) continue
                        val left = result.getHorizontalPosition(lineStart, true)
                        val right = result.getHorizontalPosition(lineEnd, true)
                        val y = result.getLineBottom(line) - stroke
                        drawLine(ink, Offset(left, y), Offset(right, y), stroke)
                    }
                }
            },
        color = color,
        fontSize = (base * scale).sp,
        fontWeight = fontWeight,
        fontFamily = fontFamily,
        letterSpacing = letterSpacing,
        lineHeight = lineHeight,
        textAlign = textAlign,
        inlineContent = chips,
        onTextLayout = {
            laidState.value = it
            onTextLayout(it)
        },
    )
}

private fun previewLinkHotIndex(
    result: TextLayoutResult,
    marks: List<ch.fasrv.fanotes.desk.DetailsInline>,
    position: Offset,
): Int? {
    if (position.y < 0f || position.y > result.size.height.toFloat()) return null
    val length = result.layoutInput.text.length
    if (length == 0) return null
    val offset = result.getOffsetForPosition(position).coerceIn(0, length)
    val index = ch.fasrv.fanotes.desk.previewLinkIndexAt(marks, offset)
        ?: ch.fasrv.fanotes.desk.previewLinkIndexAt(marks, offset - 1)
        ?: return null
    val mark = marks[index]
    val probe = offset.coerceIn(mark.start, (mark.end - 1).coerceAtLeast(mark.start))
    if (probe !in 0 until length) return null
    val line = result.getLineForOffset(probe)
    val lineStart = maxOf(mark.start, result.getLineStart(line))
    val lineEnd = minOf(mark.end, result.getLineEnd(line, true))
    if (lineEnd <= lineStart) return null
    val left = result.getHorizontalPosition(lineStart, true)
    val right = result.getHorizontalPosition(lineEnd, true)
    if (position.x < minOf(left, right) || position.x > maxOf(left, right)) return null
    if (position.y < result.getLineTop(line) || position.y > result.getLineBottom(line)) return null
    return index
}

private fun previewAnnotated(
    line: ch.fasrv.fanotes.desk.DetailsReadingLine,
    base: Int,
    link: Color,
): androidx.compose.ui.text.AnnotatedString {
    val (text, marks) = ch.fasrv.fanotes.desk.expandFieldSeparators(line.text, line.inlines)
    return previewMarks(text, marks, base, line.scale, link, ch.fasrv.fanotes.desk.previewMarkerEnd(text, line.kind))
}

private fun previewMarks(
    text: String,
    marks: List<ch.fasrv.fanotes.desk.DetailsInline>,
    base: Int,
    scale: Float,
    link: Color,
    markerEnd: Int = 0,
): androidx.compose.ui.text.AnnotatedString {
    val size = (base * scale).sp
    return buildAnnotatedString {
        append(text)
        if (markerEnd in 1..text.length) addStyle(SpanStyle(color = link), 0, markerEnd)
        for (mark in marks) {
            val start = mark.start.coerceIn(0, text.length)
            val end = mark.end.coerceIn(start, text.length)
            if (start == end) continue
            val style = when (mark.kind) {
                "strong" -> SpanStyle(fontWeight = FontWeight.Bold)
                "emphasis" -> SpanStyle(fontStyle = FontStyle.Italic)
                "strike" -> SpanStyle(textDecoration = TextDecoration.LineThrough)
                "code", "math" -> SpanStyle(fontFamily = FontFamily.Monospace)
                "link" -> SpanStyle(color = link)
                "footnote" -> SpanStyle(
                    color = link,
                    baselineShift = BaselineShift.Superscript,
                    fontSize = size * 0.7f,
                )
                "underline" -> SpanStyle(textDecoration = TextDecoration.Underline)
                "mark" -> SpanStyle(background = Color.Yellow, color = Color.Black)
                "sub" -> SpanStyle(baselineShift = BaselineShift.Subscript, fontSize = size * 0.75f)
                "sup" -> SpanStyle(baselineShift = BaselineShift.Superscript, fontSize = size * 0.75f)
                "kbd" -> SpanStyle(fontFamily = FontFamily.Monospace)
                "small" -> SpanStyle(fontSize = size * 0.83f)
                else -> null
            } ?: continue
            addStyle(style, start, end)
        }
    }
}

@Composable
private fun SettingSlider(value: Float, min: Float, max: Float, step: Float, suffix: String, onChange: (Float) -> Unit) {
    val shown = if (step < 1f) "%.2f".format(java.util.Locale.US, value) else value.toInt().toString()
    val width = if (LocalSettingsRangeFillsWidth.current) {
        Modifier.fillMaxWidth()
    } else {
        Modifier.width(ch.fasrv.fanotes.desk.RANGE_SETTING_WIDTH_DP.dp)
    }
    val valueShape = RoundedCornerShape(ch.fasrv.fanotes.desk.RANGE_SETTING_VALUE_RADIUS_DP.dp)
    Row(
        width,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.RANGE_SETTING_GAP_DP.dp),
    ) {
        Slider(
            value = value.coerceIn(min, max),
            onValueChange = { raw ->
                val steps = kotlin.math.round((raw - min) / step)
                onChange((min + steps * step).coerceIn(min, max))
            },
            modifier = Modifier
                .weight(1f)
                .widthIn(min = ch.fasrv.fanotes.desk.RANGE_SETTING_TRACK_MIN_DP.dp),
            valueRange = min..max,
        )
        Box(
            Modifier
                .width(ch.fasrv.fanotes.desk.RANGE_SETTING_VALUE_WIDTH_DP.dp)
                .height(ch.fasrv.fanotes.desk.RANGE_SETTING_VALUE_HEIGHT_DP.dp)
                .border(
                    ch.fasrv.fanotes.desk.RANGE_SETTING_VALUE_BORDER_DP.dp,
                    MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA),
                    valueShape,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                "$shown$suffix",
                fontSize = ch.fasrv.fanotes.desk.RANGE_SETTING_VALUE_SP.sp,
                fontFamily = LocalRangeSettingValueFont.current,
                color = if (ch.fasrv.fanotes.desk.rangeSettingValueInkRole() == "muted") {
                    LocalStatusInk.current.muted
                } else {
                    LocalStatusInk.current.soft
                },
                textAlign = TextAlign.Center,
                maxLines = 1,
                softWrap = false,
            )
        }
    }
}

@Composable
private fun EditorSlider(title: String, value: Float, min: Float, max: Float, step: Float, suffix: String, onChange: (Float) -> Unit) {
    val shown = if (step < 1f) "%.2f".format(java.util.Locale.US, value) else value.toInt().toString()
    Text("$title: $shown$suffix")
    Slider(
        value = value.coerceIn(min, max),
        onValueChange = { raw ->
            val steps = kotlin.math.round((raw - min) / step)
            onChange((min + steps * step).coerceIn(min, max))
        },
        valueRange = min..max,
    )
}

@Composable
private fun TabletButtonMap(raw: String?, modifier: Modifier = Modifier, onChange: (String) -> Unit) {
    val map = ch.fasrv.fanotes.input.parseTabletButtonMap(raw)
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    Column(
        modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.primary.copy(alpha = ch.fasrv.fanotes.input.TABLET_MAP_WASH_ALPHA))
            .padding(
                start = ch.fasrv.fanotes.input.TABLET_MAP_PAD_X_DP.dp,
                end = ch.fasrv.fanotes.input.TABLET_MAP_PAD_X_DP.dp,
                top = ch.fasrv.fanotes.input.TABLET_MAP_PAD_TOP_DP.dp,
                bottom = ch.fasrv.fanotes.input.TABLET_MAP_PAD_BOTTOM_DP.dp,
            ),
        verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.input.TABLET_MAP_GAP_DP.dp),
    ) {
        Text(ch.fasrv.fanotes.input.TABLET_MAP_NOTE, fontSize = 12.sp, color = LocalStatusInk.current.muted, lineHeight = 17.sp)
        listOf("pen" to "Stift", "tablet" to "Tablett").forEach { (group, title) ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(ch.fasrv.fanotes.input.TABLET_GROUP_RADIUS_DP.dp))
                    .border(1.dp, rule, RoundedCornerShape(ch.fasrv.fanotes.input.TABLET_GROUP_RADIUS_DP.dp))
                    .background(MaterialTheme.colorScheme.surface.copy(alpha = ch.fasrv.fanotes.input.TABLET_GROUP_FILL_ALPHA))
                    .padding(ch.fasrv.fanotes.input.TABLET_GROUP_PAD_DP.dp),
                verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.input.TABLET_GROUP_GAP_DP.dp),
            ) {
                Text(
                    title.uppercase(java.util.Locale.GERMAN),
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.05.em,
                    color = LocalStatusInk.current.soft,
                )
                ch.fasrv.fanotes.input.TABLET_BUTTON_CONTROLS.filter { it.group == group }.forEach { control ->
                    val action = map[control.id].orEmpty()
                    var open by remember(control.id) { mutableStateOf(false) }
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = ch.fasrv.fanotes.input.TABLET_ROW_MIN_DP.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(control.label, fontSize = 12.sp, fontWeight = FontWeight(600), color = MaterialTheme.colorScheme.onSurface)
                            Text(control.hint, fontSize = 12.sp, color = LocalStatusInk.current.muted)
                        }
                        Box {
                            Text(
                                ch.fasrv.fanotes.input.TABLET_BUTTON_ACTION_LABELS[action] ?: action,
                                fontSize = 12.sp,
                                color = LocalStatusInk.current.soft,
                                modifier = Modifier
                                    .width(ch.fasrv.fanotes.input.TABLET_ACTION_WIDTH_DP.dp)
                                    .height(31.dp)
                                    .clip(RoundedCornerShape(7.dp))
                                    .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA), RoundedCornerShape(7.dp))
                                    .background(MaterialTheme.colorScheme.surface)
                                    .clickable { open = true }
                                    .wrapContentHeight(Alignment.CenterVertically)
                                    .padding(horizontal = 8.dp),
                            )
                            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                                ch.fasrv.fanotes.input.TABLET_BUTTON_ACTIONS.forEach { choice ->
                                    DropdownMenuItem(
                                        text = { Text(ch.fasrv.fanotes.input.TABLET_BUTTON_ACTION_LABELS[choice] ?: choice) },
                                        onClick = {
                                            open = false
                                            onChange(ch.fasrv.fanotes.input.serializeTabletButtonMap(map + (control.id to choice)))
                                        },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(rule))
}

@Composable
private fun SettingCard(
    title: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.SETTING_CARD_RADIUS_DP.dp)
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    Column(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .border(1.dp, rule, shape)
            .background(LocalStatusInk.current.panelStrong.copy(alpha = ch.fasrv.fanotes.desk.SETTING_CARD_FILL_ALPHA)),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(ch.fasrv.fanotes.desk.SETTING_TITLE_DP.dp)
                .padding(horizontal = ch.fasrv.fanotes.desk.SETTING_TITLE_PAD_DP.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SETTING_TITLE_GAP_DP.dp),
        ) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(ch.fasrv.fanotes.desk.SETTING_TITLE_ICON_DP.dp), tint = accent)
            Text(
                title.uppercase(java.util.Locale.GERMAN),
                fontSize = 12.sp,
                fontWeight = FontWeight(ch.fasrv.fanotes.desk.SETTING_TITLE_WEIGHT),
                letterSpacing = ch.fasrv.fanotes.desk.SETTING_TITLE_TRACKING.em,
                color = LocalStatusInk.current.soft,
            )
            if (action != null) {
                Spacer(Modifier.weight(1f))
                action()
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(rule))
        content()
    }
}

@Composable
private fun SettingRow(
    title: String,
    description: String? = null,
    divider: Boolean = true,
    modifier: Modifier = Modifier,
    glyph: androidx.compose.ui.graphics.vector.ImageVector? = null,
    mark: String? = null,
    content: @Composable () -> Unit,
) {
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    val viewportStacks = LocalSettingsContentStacks.current
    Column(modifier.fillMaxWidth()) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val stacked = viewportStacks || maxWidth < 420.dp
            if (stacked) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = ch.fasrv.fanotes.desk.SETTING_ROW_MIN_DP.dp)
                        .padding(
                            horizontal = ch.fasrv.fanotes.desk.SETTING_ROW_PAD_X_DP.dp,
                            vertical = ch.fasrv.fanotes.desk.SETTING_ROW_PAD_Y_DP.dp,
                        ),
                    horizontalAlignment = Alignment.Start,
                    verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SETTING_ROW_STACK_GAP_DP.dp),
                ) {
                    SettingCopy(title, description, glyph = glyph, mark = mark)
                    if (viewportStacks) {
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) { content() }
                    } else {
                        content()
                    }
                }
            } else {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = ch.fasrv.fanotes.desk.SETTING_ROW_MIN_DP.dp)
                        .padding(
                            horizontal = ch.fasrv.fanotes.desk.SETTING_ROW_PAD_X_DP.dp,
                            vertical = ch.fasrv.fanotes.desk.SETTING_ROW_PAD_Y_DP.dp,
                        ),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SETTING_ROW_GAP_DP.dp),
                ) {
                    SettingCopy(title, description, Modifier.weight(1f), glyph, mark)
                    Box(Modifier.widthIn(max = 360.dp)) { content() }
                }
            }
        }
        if (divider) Box(Modifier.fillMaxWidth().height(1.dp).background(rule))
    }
}

@Composable
private fun SettingCopy(
    title: String,
    description: String?,
    modifier: Modifier = Modifier,
    glyph: androidx.compose.ui.graphics.vector.ImageVector? = null,
    mark: String? = null,
) {
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    Column(modifier) {
        if (glyph == null && mark == null) {
            Text(title, fontSize = 12.sp, fontWeight = FontWeight(ch.fasrv.fanotes.desk.SETTING_COPY_WEIGHT), color = MaterialTheme.colorScheme.onSurface)
        } else {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.sync.SYNC_DEVICE_ICON_GAP_DP.dp),
            ) {
                if (glyph != null) {
                    Icon(
                        glyph,
                        contentDescription = null,
                        modifier = Modifier.size(ch.fasrv.fanotes.sync.SYNC_DEVICE_ICON_DP.dp),
                        tint = MaterialTheme.colorScheme.onSurface,
                    )
                }
                Text(
                    buildAnnotatedString {
                        append(title)
                        if (!mark.isNullOrEmpty()) {
                            withStyle(
                                SpanStyle(
                                    color = accent,
                                    fontSize = ch.fasrv.fanotes.sync.SYNC_DEVICE_MARK_SP.sp,
                                    fontWeight = FontWeight(ch.fasrv.fanotes.sync.SYNC_DEVICE_MARK_WEIGHT),
                                ),
                            ) { append(mark) }
                        }
                    },
                    fontSize = 12.sp,
                    fontWeight = FontWeight(ch.fasrv.fanotes.desk.SETTING_COPY_WEIGHT),
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
        if (!description.isNullOrBlank()) {
            Text(description, fontSize = 12.sp, color = LocalStatusInk.current.muted, lineHeight = 17.sp, modifier = Modifier.padding(top = 3.dp))
        }
    }
}

@Composable
private fun ThemeChoiceGrid(settings: Map<String, String>, onPick: (String) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val columns = if (maxWidth >= 640.dp) 4 else 2
        Column(verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.THEME_CHOICE_GAP_DP.dp)) {
            ch.fasrv.fanotes.desk.THEME_CHOICES.chunked(columns).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.THEME_CHOICE_GAP_DP.dp)) {
                    row.forEach { choice ->
                        val selected = ch.fasrv.fanotes.desk.themeChoiceSelected(settings["theme"], choice.id)
                        ThemeChoiceButton(choice, selected, Modifier.weight(1f)) { onPick(choice.id) }
                    }
                    repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

@Composable
private fun ThemeChoiceButton(
    choice: ch.fasrv.fanotes.desk.ThemeChoice,
    selected: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val swatch = ch.fasrv.fanotes.desk.themeSwatch(choice.id)
    val accent = Color(android.graphics.Color.parseColor(ch.fasrv.fanotes.desk.DEFAULT_ACCENT))
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.THEME_CHOICE_RADIUS_DP.dp)
    val border = if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.48f) else MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    Row(
        modifier
            .heightIn(min = ch.fasrv.fanotes.desk.THEME_CHOICE_MIN_DP.dp)
            .clip(shape)
            .border(1.dp, border, shape)
            .background(MaterialTheme.colorScheme.surface)
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Box(
            Modifier
                .size(width = ch.fasrv.fanotes.desk.THEME_PREVIEW_W_DP.dp, height = ch.fasrv.fanotes.desk.THEME_PREVIEW_H_DP.dp)
                .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.THEME_PREVIEW_RADIUS_DP.dp))
                .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA), RoundedCornerShape(ch.fasrv.fanotes.desk.THEME_PREVIEW_RADIUS_DP.dp))
                .background(Color(android.graphics.Color.parseColor(swatch.background))),
        ) {
            if (swatch.split) {
                Box(Modifier.fillMaxHeight().fillMaxWidth(0.5f).align(Alignment.CenterEnd).background(Color(android.graphics.Color.parseColor(swatch.surface))))
            }
            Box(
                Modifier
                    .align(Alignment.CenterStart)
                    .padding(start = 4.dp)
                    .width(5.dp)
                    .height(18.dp)
                    .clip(RoundedCornerShape(3.dp))
                    .background(accent),
            )
        }
        Column(Modifier.weight(1f)) {
            Text(choice.label, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = if (selected) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.soft)
            Text(choice.detail, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, color = LocalStatusInk.current.muted)
        }
        if (selected) {
            Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(14.dp), tint = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f)))
        } else {
            Spacer(Modifier.size(14.dp))
        }
    }
}

@Composable
private fun AccentSwatches(selected: String, onPick: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SWATCH_GAP_DP.dp)) {
        ch.fasrv.fanotes.desk.ACCENT_COLORS.forEach { color ->
            val on = color == selected
            Box(
                Modifier
                    .size(ch.fasrv.fanotes.desk.SWATCH_DP.dp)
                    .clip(CircleShape)
                    .background(Color(android.graphics.Color.parseColor(color)))
                    .border(
                        if (on) 2.dp else 0.dp,
                        if (on) MaterialTheme.colorScheme.onSurface else Color.Transparent,
                        CircleShape,
                    )
                    .clickable { onPick(color) },
            )
        }
    }
}

@Composable
private fun SettingsSearchField(query: String, onQuery: (String) -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.SETTINGS_SEARCH_RADIUS_DP.dp)
    val accent = MaterialTheme.colorScheme.primary
    val readable = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 2.dp)
            .padding(bottom = 12.dp)
            .height(ch.fasrv.fanotes.desk.SETTINGS_SEARCH_DP.dp)
            .clip(shape)
            .border(
                1.dp,
                if (focused) accent.copy(alpha = ch.fasrv.fanotes.desk.SETTINGS_SEARCH_FOCUS_ALPHA)
                else MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA),
                shape,
            )
            .background(MaterialTheme.colorScheme.background.copy(alpha = ch.fasrv.fanotes.desk.SETTINGS_SEARCH_FILL_ALPHA))
            .drawBehind {
                if (!focused) return@drawBehind
                val stroke = 3.dp.toPx()
                val radius = ch.fasrv.fanotes.desk.SETTINGS_SEARCH_RADIUS_DP.dp.toPx() + stroke
                drawRoundRect(
                    color = accent.copy(alpha = ch.fasrv.fanotes.desk.SETTINGS_SEARCH_RING_ALPHA),
                    topLeft = Offset(-stroke / 2f, -stroke / 2f),
                    size = androidx.compose.ui.geometry.Size(size.width + stroke, size.height + stroke),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(radius, radius),
                    style = androidx.compose.ui.graphics.drawscope.Stroke(stroke),
                )
            }
            .padding(horizontal = ch.fasrv.fanotes.desk.SETTINGS_SEARCH_PAD_DP.dp)
            .semantics { contentDescription = ch.fasrv.fanotes.desk.SETTINGS_SEARCH_LABEL },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SETTINGS_SEARCH_GAP_DP.dp),
    ) {
        Icon(
            Icons.Filled.Search,
            contentDescription = null,
            modifier = Modifier.size(ch.fasrv.fanotes.desk.SETTINGS_SEARCH_ICON_DP.dp),
            tint = if (focused) readable else LocalStatusInk.current.muted,
        )
        BasicTextField(
            value = query,
            onValueChange = onQuery,
            modifier = Modifier.weight(1f).onFocusChanged { focused = it.isFocused },
            singleLine = true,
            textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = 12.sp),
            cursorBrush = SolidColor(accent),
            decorationBox = { inner ->
                Box {
                    if (query.isEmpty()) {
                        Text(ch.fasrv.fanotes.desk.SETTINGS_SEARCH_PLACEHOLDER, fontSize = 12.sp, color = LocalStatusInk.current.muted)
                    }
                    inner()
                }
            },
        )
        if (query.isNotEmpty()) {
            val clear = remember { MutableInteractionSource() }
            val hot by clear.collectIsHoveredAsState()
            Box(
                Modifier
                    .size(ch.fasrv.fanotes.desk.SETTINGS_SEARCH_CLEAR_DP.dp)
                    .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SETTINGS_SEARCH_CLEAR_RADIUS_DP.dp))
                    .background(if (hot) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
                    .hoverable(clear)
                    .clickable(interactionSource = clear, indication = null, onClickLabel = ch.fasrv.fanotes.desk.SETTINGS_SEARCH_CLEAR) { onQuery("") },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Filled.Close,
                    contentDescription = ch.fasrv.fanotes.desk.SETTINGS_SEARCH_CLEAR,
                    modifier = Modifier.size(ch.fasrv.fanotes.desk.SETTINGS_SEARCH_CLEAR_ICON_DP.dp),
                    tint = if (hot) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.muted,
                )
            }
        }
    }
}

private fun settingsSectionIcon(section: String) = when (section) {
    "appearance" -> Icons.Filled.Palette
    "editor" -> Icons.Filled.Description
    "drawing" -> Icons.Filled.Brush
    "files" -> Icons.Filled.Folder
    "sync" -> Icons.Filled.Cloud
    "addons" -> Icons.Filled.Extension
    "updates" -> Icons.Filled.SystemUpdate
    "accessibility" -> Icons.Filled.Accessibility
    "experimental" -> Icons.Filled.Science
    else -> Icons.Filled.Code
}

@Composable
private fun SettingsNavIconButton(
    icon: ImageVector,
    label: String,
    active: Boolean,
    iconDp: Int = ch.fasrv.fanotes.desk.SETTINGS_NAV_ICON_DP,
    onClick: () -> Unit,
) {
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = ch.fasrv.fanotes.desk.SETTINGS_NAV_ROW_DP.dp)
            .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SETTINGS_NAV_RADIUS_DP.dp))
            .background(if (active) LocalStatusInk.current.panelActive else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(ch.fasrv.fanotes.desk.SETTINGS_NAV_NARROW_BUTTON_PAD_DP.dp),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon,
            contentDescription = label,
            modifier = Modifier.size(iconDp.dp),
            tint = if (active) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.muted,
        )
    }
}

@Composable
private fun SyncAccountCallout(
    modifier: Modifier = Modifier,
    viewportWidth: Int,
    actions: (@Composable () -> Unit)? = null,
) {
    val accent = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f))
    val shape = RoundedCornerShape(ch.fasrv.fanotes.sync.SYNC_CALLOUT_RADIUS_DP.dp)
    val layout = ch.fasrv.fanotes.desk.settingCalloutLayout(viewportWidth)
    val cross = if (layout.alignItems == ch.fasrv.fanotes.desk.SETTING_CALLOUT_ALIGN_NARROW) {
        Alignment.Top
    } else {
        Alignment.CenterVertically
    }
    val actionsStart = if (layout.actionsFillWidth) layout.actionsPadStartDp.dp else 0.dp
    val chrome = modifier
        .fillMaxWidth()
        .clip(shape)
        .border(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.17f), shape)
        .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.13f))
        .padding(13.dp)
    if (layout.wraps) {
        Column(chrome, verticalArrangement = Arrangement.spacedBy(11.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(11.dp),
                verticalAlignment = cross,
            ) {
                SyncCalloutBody(accent)
            }
            if (actions != null) {
                Row(
                    Modifier.fillMaxWidth().padding(start = actionsStart),
                    horizontalArrangement = Arrangement.spacedBy(layout.actionsGapDp.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) { actions() }
            }
        }
    } else {
        Row(
            chrome,
            horizontalArrangement = Arrangement.spacedBy(11.dp),
            verticalAlignment = cross,
        ) {
            SyncCalloutBody(accent)
            if (actions != null) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(layout.actionsGapDp.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) { actions() }
            }
        }
    }
}

@Composable
private fun RowScope.SyncCalloutBody(accent: Color) {
    Box(
        Modifier.size(ch.fasrv.fanotes.sync.SYNC_CALLOUT_ICON_DP.dp).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Filled.Cloud, contentDescription = null, modifier = Modifier.size(18.dp), tint = accent)
    }
    Column(Modifier.weight(1f)) {
        Text(ch.fasrv.fanotes.sync.SYNC_ACCOUNT_CALLOUT, fontSize = 12.sp)
        Text(ch.fasrv.fanotes.sync.SYNC_ACCOUNT_CALLOUT_BODY, fontSize = 12.sp, lineHeight = 17.sp, color = LocalStatusInk.current.muted, modifier = Modifier.padding(top = 3.dp))
    }
}

@Composable
internal fun SyncModeSwitch(register: Boolean, onRegister: (Boolean) -> Unit) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.sync.SYNC_MODE_TRACK_RADIUS_DP.dp)
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    Row(
        Modifier.clip(shape).border(1.dp, rule, shape).background(MaterialTheme.colorScheme.surface).padding(2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        listOf(false to ch.fasrv.fanotes.sync.SYNC_ACCOUNT_LOGIN, true to ch.fasrv.fanotes.sync.SYNC_ACCOUNT_REGISTER).forEach { (flag, label) ->
            val on = register == flag
            val chip = RoundedCornerShape(ch.fasrv.fanotes.sync.SYNC_MODE_RADIUS_DP.dp)
            Box(
                Modifier.height(ch.fasrv.fanotes.sync.SYNC_MODE_DP.dp).clip(chip).background(if (on) LocalStatusInk.current.panelStrong else Color.Transparent).clickable { onRegister(flag) }.padding(horizontal = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(label, fontSize = 12.sp, fontWeight = FontWeight(650), color = if (on) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.muted)
            }
        }
    }
}

@Composable
internal fun SyncSignInFields(model: FaNotesViewModel, register: Boolean) {
    val busy by model.syncAccountBusy.collectAsStateWithLifecycle()
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var repeat by remember { mutableStateOf("") }
    var device by remember { mutableStateOf(model.syncDeviceName()) }
    var localError by remember { mutableStateOf<String?>(null) }
    val canSubmit = ch.fasrv.fanotes.sync.syncAccountCanSubmit(email, password, busy)
    Column(Modifier.fillMaxWidth().padding(horizontal = 15.dp, vertical = 13.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        SyncFormField(ch.fasrv.fanotes.sync.SYNC_ACCOUNT_EMAIL, email, { email = it }, ch.fasrv.fanotes.sync.SYNC_ACCOUNT_EMAIL_HINT)
        SyncFormField(
            ch.fasrv.fanotes.sync.SYNC_ACCOUNT_PASSWORD,
            password,
            { password = it },
            if (register) ch.fasrv.fanotes.sync.SYNC_ACCOUNT_PASSWORD_HINT else "",
            password = true,
        )
        if (register) {
            SyncFormField(ch.fasrv.fanotes.sync.SYNC_ACCOUNT_REPEAT, repeat, { repeat = it }, password = true)
        }
        SyncFormField(ch.fasrv.fanotes.sync.SYNC_ACCOUNT_DEVICE, device, {
            device = it.take(80)
            model.setSyncDeviceName(device)
        }, ch.fasrv.fanotes.sync.SYNC_ACCOUNT_DEVICE_HINT)
        val problem = localError
        if (!problem.isNullOrBlank()) Text(problem, fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
            val shape = RoundedCornerShape(6.dp)
            Box(
                Modifier.height(31.dp).alpha(if (canSubmit) 1f else 0.45f).clip(shape).background(MaterialTheme.colorScheme.onSurface).clickable(enabled = canSubmit) {
                    val error = ch.fasrv.fanotes.sync.syncAccountSubmitError(register, password, repeat)
                    if (error != null) {
                        localError = error
                    } else {
                        localError = null
                        model.login(email.trim(), password, register)
                    }
                }.padding(horizontal = 12.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(ch.fasrv.fanotes.sync.syncAccountButtonLabel(register, busy), fontSize = 12.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.background)
            }
            Text(
                if (register) ch.fasrv.fanotes.sync.SYNC_ACCOUNT_REGISTER_NOTE else ch.fasrv.fanotes.sync.SYNC_ACCOUNT_LOGIN_NOTE,
                fontSize = 12.sp,
                lineHeight = 17.sp,
                color = LocalStatusInk.current.muted,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun SyncFormField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    placeholder: String = "",
    password: Boolean = false,
) {
    val shape = RoundedCornerShape(ch.fasrv.fanotes.sync.SYNC_FORM_FIELD_RADIUS_DP.dp)
    val strong = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(label, fontSize = 12.sp, fontWeight = FontWeight(650), color = LocalStatusInk.current.soft)
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            visualTransformation = if (password) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
            textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = 12.sp),
            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
            modifier = Modifier.fillMaxWidth().height(ch.fasrv.fanotes.sync.SYNC_FORM_FIELD_DP.dp),
            decorationBox = { inner ->
                Box(
                    Modifier.fillMaxSize().clip(shape).border(1.dp, strong, shape).background(MaterialTheme.colorScheme.surface).padding(horizontal = ch.fasrv.fanotes.sync.SYNC_FORM_PAD_DP.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (value.isEmpty() && placeholder.isNotEmpty()) {
                        Text(placeholder, fontSize = 12.sp, color = LocalStatusInk.current.muted)
                    }
                    inner()
                }
            },
        )
    }
}

@Composable
fun SettingsScreen(model: FaNotesViewModel, onSync: () -> Unit, onOpenVault: () -> Unit, onPrivate: () -> Unit) {
    val dismiss = {
        model.closeSettings()
        if (model.destination.value == "settings") model.showDestination("notes")
    }
    Dialog(onDismissRequest = dismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val scrim = remember { MutableInteractionSource() }
        val card = remember { MutableInteractionSource() }
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val viewportWidth = maxWidth.value.roundToInt()
            val panel = ch.fasrv.fanotes.desk.settingsModalSize(viewportWidth, maxHeight.value.roundToInt())
            val shape = RoundedCornerShape(panel.radiusDp.dp)
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color(ch.fasrv.fanotes.desk.PALETTE_SCRIM))
                    .clickable(interactionSource = scrim, indication = null, onClick = dismiss),
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier
                        .width(panel.widthDp.dp)
                        .height(panel.heightDp.dp)
                        .clickable(interactionSource = card, indication = null, onClick = {})
                        .directionalBugReportShade()
                        .clip(shape)
                        .then(
                            if (panel.radiusDp == 0) Modifier
                            else Modifier.border(
                                1.dp,
                                MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA),
                                shape,
                            ),
                        )
                        .background(MaterialTheme.colorScheme.background),
                ) {
                    SettingsPage(model, onSync, onOpenVault, onPrivate, dismiss, viewportWidth)
                }
            }
        }
    }
}

@Composable
private fun SettingsPage(
    model: FaNotesViewModel,
    onSync: () -> Unit,
    onOpenVault: () -> Unit,
    onPrivate: () -> Unit,
    onClose: () -> Unit,
    viewportWidth: Int,
) {
    val navCollapsed = ch.fasrv.fanotes.desk.settingsNavCollapses(viewportWidth)
    val content = ch.fasrv.fanotes.desk.settingsContentLayout(viewportWidth)
    val settings by model.deskSettings.collectAsStateWithLifecycle()
    val sync by model.sync.collectAsStateWithLifecycle()
    val syncDeviceNote by model.syncDeviceNote.collectAsStateWithLifecycle()
    val css by model.customCss.collectAsStateWithLifecycle()
    val update by model.updateLabel.collectAsStateWithLifecycle()
    val sections = ch.fasrv.fanotes.desk.SETTINGS_NAV
    var section by remember { mutableStateOf("appearance") }
    LaunchedEffect(section, sync.account?.accountId) {
        if (section == "sync" && sync.account != null) model.refreshSyncDevices()
    }
    var settingsQuery by remember { mutableStateOf("") }
    var scrollTarget by remember { mutableStateOf<String?>(null) }
    val settingsResults = ch.fasrv.fanotes.desk.searchSettings(settingsQuery)
    val paneScroll = rememberScrollState()
    val anchorY = remember { androidx.compose.runtime.mutableStateMapOf<String, Int>() }
    LaunchedEffect(section, scrollTarget, anchorY["$section:$scrollTarget"]) {
        val id = scrollTarget ?: return@LaunchedEffect
        val y = anchorY["$section:$id"] ?: return@LaunchedEffect
        if (ch.fasrv.fanotes.desk.reduceMotion(settings["reduce-motion"])) paneScroll.scrollTo(y)
        else paneScroll.animateScrollTo(y)
        scrollTarget = null
    }
    val navPadX = if (navCollapsed) ch.fasrv.fanotes.desk.SETTINGS_NAV_NARROW_PAD_X_DP else ch.fasrv.fanotes.desk.SETTINGS_NAV_PAD_X_DP
    val rangeValueFontId = ch.fasrv.fanotes.desk.rangeSettingValueFontId(settings["editor-face"])
    val rangeValueContext = LocalContext.current
    val rangeValueFont = remember(rangeValueFontId) {
        FontFamily(loadEditorTypeface(rangeValueContext, rangeValueFontId))
    }
    CompositionLocalProvider(
        LocalSettingsContentStacks provides content.rowsStack,
        LocalSettingsRangeFillsWidth provides ch.fasrv.fanotes.desk.settingsRangeFillsWidth(viewportWidth),
        LocalRangeSettingValueFont provides rangeValueFont,
    ) {
    Row(Modifier.fillMaxSize()) {
        Column(
            (if (navCollapsed) Modifier.width(ch.fasrv.fanotes.desk.SETTINGS_NAV_NARROW_DP.dp) else Modifier.weight(0.38f))
                .verticalScroll(rememberScrollState())
                .padding(
                    start = navPadX.dp,
                    end = navPadX.dp,
                    top = ch.fasrv.fanotes.desk.SETTINGS_NAV_PAD_TOP_DP.dp,
                    bottom = ch.fasrv.fanotes.desk.SETTINGS_NAV_PAD_BOTTOM_DP.dp,
                ),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(bottom = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = if (navCollapsed) Arrangement.Center else Arrangement.spacedBy(ch.fasrv.fanotes.desk.SETTINGS_BRAND_GAP_DP.dp),
            ) {
                Box(
                    Modifier
                        .size(ch.fasrv.fanotes.desk.SETTINGS_BRAND_DP.dp)
                        .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SETTINGS_BRAND_RADIUS_DP.dp))
                        .background(MaterialTheme.colorScheme.onSurface),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Filled.Settings,
                        contentDescription = if (navCollapsed) ch.fasrv.fanotes.desk.SETTINGS_BRAND else null,
                        modifier = Modifier.size(17.dp),
                        tint = MaterialTheme.colorScheme.background,
                    )
                }
                if (!navCollapsed) {
                    Column(Modifier.weight(1f)) {
                        Text(ch.fasrv.fanotes.desk.SETTINGS_BRAND, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                        Text(ch.fasrv.fanotes.desk.SETTINGS_BRAND_DETAIL, fontSize = 12.sp, color = LocalStatusInk.current.muted, modifier = Modifier.padding(top = 2.dp))
                    }
                }
            }
            if (!navCollapsed) SettingsSearchField(settingsQuery, { settingsQuery = it })
            if (settingsQuery.isNotBlank()) {
                if (navCollapsed) {
                    Column(verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SETTINGS_RESULT_GAP_DP.dp)) {
                        settingsResults.forEach { item ->
                            SettingsNavIconButton(settingsSectionIcon(item.section), item.label, false, iconDp = ch.fasrv.fanotes.desk.SETTINGS_RESULT_ICON_DP) {
                                section = item.section
                                scrollTarget = item.target
                                settingsQuery = ""
                            }
                        }
                    }
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SETTINGS_RESULT_GAP_DP.dp)) {
                        Text(
                            ch.fasrv.fanotes.desk.settingsSearchCount(settingsResults.size).uppercase(java.util.Locale.GERMAN),
                            fontSize = 12.sp,
                            fontWeight = FontWeight(ch.fasrv.fanotes.desk.SETTINGS_NAV_GROUP_WEIGHT),
                            letterSpacing = ch.fasrv.fanotes.desk.SETTINGS_NAV_GROUP_TRACKING.em,
                            color = LocalStatusInk.current.muted,
                            modifier = Modifier.padding(start = 8.dp, top = 2.dp, end = 8.dp, bottom = 4.dp),
                        )
                        settingsResults.forEach { item ->
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .heightIn(min = ch.fasrv.fanotes.desk.SETTINGS_NAV_ROW_DP.dp)
                                    .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SETTINGS_NAV_RADIUS_DP.dp))
                                    .clickable {
                                        section = item.section
                                        scrollTarget = item.target
                                        settingsQuery = ""
                                    }
                                    .padding(horizontal = 8.dp, vertical = 5.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(9.dp),
                            ) {
                                Icon(settingsSectionIcon(item.section), contentDescription = null, modifier = Modifier.size(ch.fasrv.fanotes.desk.SETTINGS_RESULT_ICON_DP.dp), tint = LocalStatusInk.current.muted)
                                Column(Modifier.weight(1f)) {
                                    Text(item.label, fontSize = 12.sp, fontWeight = FontWeight(ch.fasrv.fanotes.desk.SETTINGS_NAV_LABEL_WEIGHT))
                                    Text(item.detail, fontSize = 12.sp, color = LocalStatusInk.current.muted)
                                }
                                Icon(
                                    Icons.AutoMirrored.Filled.KeyboardArrowRight,
                                    contentDescription = null,
                                    modifier = Modifier.size(14.dp),
                                    tint = LocalStatusInk.current.muted.copy(alpha = 0.45f),
                                )
                            }
                        }
                        if (settingsResults.isEmpty()) {
                            Text(
                                ch.fasrv.fanotes.desk.SETTINGS_SEARCH_HINT,
                                fontSize = 12.sp,
                                lineHeight = 18.sp,
                                color = LocalStatusInk.current.muted,
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 5.dp),
                            )
                        }
                    }
                }
            } else if (navCollapsed) {
                Column(verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SETTINGS_NAV_GROUP_GAP_DP.dp)) {
                    ch.fasrv.fanotes.desk.settingsNavGroups().forEach { (_, items) ->
                        Column(verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SETTINGS_NAV_ITEM_GAP_DP.dp)) {
                            items.forEach { item ->
                                SettingsNavIconButton(settingsSectionIcon(item.id), item.label, section == item.id) {
                                    section = item.id
                                }
                            }
                        }
                    }
                }
            } else {
                ch.fasrv.fanotes.desk.settingsNavGroups().forEach { (group, items) ->
                    Text(
                        group.uppercase(java.util.Locale.GERMAN),
                        fontSize = 12.sp,
                        fontWeight = FontWeight(ch.fasrv.fanotes.desk.SETTINGS_NAV_GROUP_WEIGHT),
                        letterSpacing = ch.fasrv.fanotes.desk.SETTINGS_NAV_GROUP_TRACKING.em,
                        color = LocalStatusInk.current.muted,
                        modifier = Modifier.padding(start = 8.dp, top = 9.dp, end = 8.dp, bottom = 4.dp),
                    )
                    items.forEach { item ->
                        val active = section == item.id
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .padding(bottom = 2.dp)
                                .heightIn(min = ch.fasrv.fanotes.desk.SETTINGS_NAV_ROW_DP.dp)
                                .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SETTINGS_NAV_RADIUS_DP.dp))
                                .background(if (active) LocalStatusInk.current.panelActive else Color.Transparent)
                                .clickable { section = item.id }
                                .padding(horizontal = 8.dp, vertical = 5.dp),
                            verticalArrangement = Arrangement.Center,
                        ) {
                            Text(
                                item.label,
                                fontSize = 12.sp,
                                fontWeight = FontWeight(ch.fasrv.fanotes.desk.SETTINGS_NAV_LABEL_WEIGHT),
                                color = if (active) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.muted,
                            )
                            Text(item.detail, fontSize = 12.sp, color = LocalStatusInk.current.muted)
                        }
                    }
                }
            }
        }
        Column(Modifier.weight(0.62f)) {
            val current = sections.first { it.id == section }
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(
                        start = content.headerPadXDp.dp,
                        end = content.headerPadXDp.dp,
                        top = ch.fasrv.fanotes.desk.SETTINGS_HEADER_PAD_TOP_DP.dp,
                        bottom = ch.fasrv.fanotes.desk.SETTINGS_HEADER_PAD_BOTTOM_DP.dp,
                    ),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = if (content.headingIconVisible) {
                    Arrangement.spacedBy(ch.fasrv.fanotes.desk.SETTINGS_HEADING_GAP_DP.dp)
                } else {
                    Arrangement.Start
                },
            ) {
                if (content.headingIconVisible) {
                    Box(
                        Modifier
                            .size(ch.fasrv.fanotes.desk.SETTINGS_HEADING_ICON_DP.dp)
                            .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.SETTINGS_HEADING_ICON_RADIUS_DP.dp))
                            .background(MaterialTheme.colorScheme.onSurface),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            settingsSectionIcon(current.id),
                            contentDescription = null,
                            modifier = Modifier.size(ch.fasrv.fanotes.desk.SETTINGS_HEADING_ICON_GLYPH_DP.dp),
                            tint = MaterialTheme.colorScheme.background,
                        )
                    }
                }
                Column(Modifier.weight(1f)) {
                    Text(
                        ch.fasrv.fanotes.desk.settingsEyebrow(current.count),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = ch.fasrv.fanotes.desk.SETTINGS_EYEBROW_TRACKING.em,
                        color = Color(ch.fasrv.fanotes.desk.noteTabAccentArgb(MaterialTheme.colorScheme.background.luminance() < 0.5f)),
                    )
                    Text(
                        current.label,
                        fontSize = ch.fasrv.fanotes.desk.SETTINGS_TITLE_SP.sp,
                        fontWeight = FontWeight.SemiBold,
                        letterSpacing = ch.fasrv.fanotes.desk.SETTINGS_TITLE_TRACKING.em,
                    )
                    Text(
                        current.detail,
                        fontSize = 12.sp,
                        color = LocalStatusInk.current.muted,
                        modifier = Modifier.padding(top = 3.dp),
                    )
                }
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)),
            )
            Column(
                Modifier.weight(1f).verticalScroll(paneScroll).padding(
                    start = content.scrollPadXDp.dp,
                    end = content.scrollPadXDp.dp,
                    top = content.scrollPadTopDp.dp,
                    bottom = content.scrollPadBottomDp.dp,
                ),
                verticalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SETTING_CARD_MARGIN_DP.dp),
            ) {
            when (section) {
                "appearance" -> {
                    val accent = ch.fasrv.fanotes.desk.normalizeAccent(settings["accent"])
                    val secondary = ch.fasrv.fanotes.desk.normalizeAccentSecondary(settings["accent-secondary"])
                    val background = ch.fasrv.fanotes.desk.workspaceBackground(settings["background"])
                    SettingCard(
                        "Oberfläche",
                        Icons.Filled.Palette,
                        Modifier.settingsAnchor("appearance", "settings-surface", anchorY),
                    ) {
                        SettingRow("Farbschema", "Kann automatisch dem System folgen.") {
                            ThemeChoiceGrid(settings) { model.updateDesk("theme", it) }
                        }
                        SettingRow("Arbeitsflächen-Design", "Dekoriert den Hintergrund dezent, ohne vom Inhalt abzulenken.") {
                            Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                                ch.fasrv.fanotes.desk.WORKSPACE_BACKGROUNDS.forEach { (id, label) ->
                                    val on = background == id
                                    Text(
                                        label,
                                        fontSize = 12.sp,
                                        color = if (on) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.muted,
                                        modifier = Modifier
                                            .clip(RoundedCornerShape(6.dp))
                                            .background(if (on) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
                                            .clickable { model.updateDesk("background", id) }
                                            .padding(horizontal = 10.dp, vertical = 6.dp),
                                    )
                                }
                            }
                        }
                        SettingRow("Akzentfarbe", "Färbt Auswahl, Fokus und interaktive Elemente.", modifier = Modifier.settingsAnchor("appearance", "settings-accent", anchorY)) {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                AccentSwatches(accent) { model.updateDesk("accent", it) }
                                var customAccent by remember(accent) { mutableStateOf(accent) }
                                OutlinedTextField(
                                    customAccent,
                                    { next ->
                                        customAccent = next
                                        ch.fasrv.fanotes.desk.parseAccent(next)?.let { model.updateDesk("accent", it) }
                                    },
                                    modifier = Modifier.widthIn(min = 170.dp),
                                    label = { Text("Eigene Akzentfarbe") },
                                    singleLine = true,
                                )
                            }
                        }
                        SettingRow("Zweite Akzentfarbe", "Für Verläufe und mathematische Auszeichnungen.") {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                AccentSwatches(secondary) { model.updateDesk("accent-secondary", it) }
                                var customSecondary by remember(secondary) { mutableStateOf(secondary) }
                                OutlinedTextField(
                                    customSecondary,
                                    { next ->
                                        customSecondary = next
                                        ch.fasrv.fanotes.desk.parseAccent(next)?.let { model.updateDesk("accent-secondary", it) }
                                    },
                                    modifier = Modifier.widthIn(min = 170.dp),
                                    label = { Text("Eigene zweite Akzentfarbe") },
                                    singleLine = true,
                                )
                            }
                        }
                        SettingRow("Kompakte Oberfläche", "Mehr Inhalt auf kleineren Displays.") {
                            Switch(
                                checked = ch.fasrv.fanotes.desk.compactChrome(settings["compact"]),
                                onCheckedChange = { model.updateDesk("compact", if (it) "on" else "off") },
                            )
                        }
                        SettingRow("Glas-Effekte", "Transparente Ebenen und weiche Unschärfe.", divider = false) {
                            Switch(
                                checked = ch.fasrv.fanotes.desk.glassChrome(settings["glass"]),
                                onCheckedChange = { model.updateDesk("glass", if (it) "on" else "off") },
                            )
                        }
                    }
                    val uiFont = ch.fasrv.fanotes.desk.uiFontId(settings["ui-font"])
                    val metrics = ch.fasrv.fanotes.desk.editorMetrics(settings)
                    SettingCard(
                        "Typografie",
                        Icons.Filled.TextFields,
                        Modifier.settingsAnchor("appearance", "settings-typography", anchorY),
                    ) {
                        SettingRow("Oberflächen-Schrift") {
                            Column {
                                ch.fasrv.fanotes.desk.UI_FONTS.forEach { face ->
                                    Text(
                                        face.label,
                                        fontSize = 12.sp,
                                        fontWeight = if (uiFont == face.id) FontWeight.SemiBold else FontWeight.Normal,
                                        color = if (uiFont == face.id) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.soft,
                                        modifier = Modifier.clickable { model.updateDesk("ui-font", face.stack) }.padding(vertical = 4.dp),
                                    )
                                }
                            }
                        }
                        SettingRow("Editor-Schrift", modifier = Modifier.settingsAnchor("appearance", "settings-type", anchorY)) {
                            Column {
                                ch.fasrv.fanotes.desk.EDITOR_FONTS.forEach { face ->
                                    Text(
                                        face.label,
                                        fontSize = 12.sp,
                                        fontWeight = if (metrics.editorFontId == face.id) FontWeight.SemiBold else FontWeight.Normal,
                                        color = if (metrics.editorFontId == face.id) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.soft,
                                        modifier = Modifier.clickable { model.updateDesk("editor-face", face.stack) }.padding(vertical = 4.dp),
                                    )
                                }
                            }
                        }
                        SettingRow("Editor-Schriftgröße") {
                            SettingSlider(metrics.fontSizePx.toFloat(), 12f, 26f, 1f, " px") { model.updateDesk("editor-font", it.toInt().toString()) }
                        }
                        SettingRow("KI-Vorschau-Schriftgröße") {
                            SettingSlider(metrics.previewFontPx.toFloat(), 13f, 28f, 1f, " px") { model.updateDesk("preview-font", it.toInt().toString()) }
                        }
                        SettingRow("Zeilenhöhe", divider = false) {
                            SettingSlider(metrics.lineHeight.toFloat(), 1.3f, 2.2f, 0.05f, "") { model.updateDesk("line-height", "%.2f".format(java.util.Locale.US, it)) }
                        }
                    }
                }
                "editor" -> {
                    val metrics = ch.fasrv.fanotes.desk.editorMetrics(settings)
                    SettingCard(
                        "Markdown-Arbeitsbereich",
                        Icons.Filled.Description,
                        Modifier.settingsAnchor("editor", "settings-editor", anchorY),
                    ) {
                        SettingRow("Live-Ansicht", "Markdown wird direkt auf der Seite bearbeitet und formatiert – ohne getrennte Vorschau.") {
                            Text("Immer aktiv", fontSize = 12.sp, color = LocalStatusInk.current.soft)
                        }
                        SettingRow("Lesbare Zeilenlänge", "Begrenzt lange Textzeilen für angenehmes Lesen.", modifier = Modifier.settingsAnchor("editor", "settings-width", anchorY)) {
                            Switch(
                                checked = metrics.readableLineLength,
                                onCheckedChange = { model.updateDesk("readable-lines", if (it) "on" else "off") },
                            )
                        }
                        SettingRow("Maximale Inhaltsbreite") {
                            SettingSlider(metrics.contentWidthPx.toFloat(), 560f, 1200f, 20f, " px") { model.updateDesk("content-width", it.toInt().toString()) }
                        }
                        SettingRow(
                            "Zoom-Geschwindigkeit",
                            "Wie weit Strg+Mausrad oder Trackpad-Pinch das Blatt verändert. 1 ist langsam, 5 normal, 10 schnell.",
                            modifier = Modifier.settingsAnchor("editor", "settings-zoom", anchorY),
                        ) {
                            SettingSlider(metrics.zoomSpeed.toFloat(), 1f, 10f, 1f, "") { model.updateDesk("zoom-speed", it.toInt().toString()) }
                        }
                        SettingRow("Zoom-Limit", "Wie weit du das Blatt hereinzoomen kannst. 50 % ist kaum näher, 325 % ist der bisherige Höchstwert, 600 % ist sehr nah.") {
                            SettingSlider((metrics.zoomMax * 100).toFloat(), 50f, 600f, 5f, " %") { model.updateDesk("zoom-max", it.toInt().toString()) }
                        }
                        SettingRow("Zeilennummern") {
                            Switch(
                                checked = metrics.showLineNumbers,
                                onCheckedChange = { model.updateDesk("line-numbers", if (it) "on" else "off") },
                            )
                        }
                        SettingRow(
                            "Rechtschreibprüfung",
                            "Unterstreicht Tippfehler lokal rot und erkennt Deutsch oder Englisch automatisch. Mathematik und Code bleiben unberührt. Ein langes Drücken oder Strg+. zeigt Vorschläge.",
                        ) {
                            Switch(
                                checked = settings["spellcheck"] != "off",
                                onCheckedChange = { model.updateDesk("spellcheck", if (it) "on" else "off") },
                            )
                        }
                        SettingRow(
                            "Autokorrektur",
                            "Ersetzt einen eindeutigen Tippfehler, sobald das Wort mit Leerzeichen oder Satzzeichen endet. Rückschritt direkt danach stellt das getippte Wort wieder her.",
                        ) {
                            Switch(
                                checked = settings["spellcheck"] != "off" && settings["autocorrect"] != "off",
                                enabled = settings["spellcheck"] != "off",
                                onCheckedChange = { model.updateDesk("autocorrect", if (it) "on" else "off") },
                            )
                        }
                        SettingRow("Wortzahl in Statusleiste") {
                            Switch(
                                checked = settings["words"] != "off",
                                onCheckedChange = { model.updateDesk("words", if (it) "on" else "off") },
                            )
                        }
                        SettingRow("Gliederung anzeigen", divider = false) {
                            Switch(
                                checked = settings["outline"] != "off",
                                onCheckedChange = { model.updateDesk("outline", if (it) "on" else "off") },
                            )
                        }
                    }
                }
                "drawing" -> {
                    val pen = ch.fasrv.fanotes.desk.penSettings(settings)
                    val penOnly = ch.fasrv.fanotes.input.penOnlyEnabled(settings["pen-only"])
                    SettingCard(
                        "Grafiktablett",
                        Icons.Filled.Brush,
                        Modifier.settingsAnchor("drawing", "settings-tablet", anchorY),
                    ) {
                        SettingRow("Papier", "Standard für neue Notizen. Jede Notiz kann ihren Hintergrund selbst wählen.") {
                            Column {
                                ch.fasrv.fanotes.desk.PAPER_STYLES.forEach { option ->
                                    val on = pen.paper == option.id
                                    Text(
                                        ch.fasrv.fanotes.desk.paperStyleSettingsLabel(option.id),
                                        fontSize = 12.sp,
                                        fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                                        color = if (on) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.soft,
                                        modifier = Modifier.clickable { model.updateDesk("paper", option.id) }.padding(vertical = 4.dp),
                                    )
                                }
                            }
                        }
                        SettingRow("Stiftfarbe") {
                            Row(horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.SWATCH_GAP_DP.dp)) {
                                listOf("#202333", "#2457d6", "#d23b4a", "#1f8a4c", "#e2a21b", "#7a4dd6").forEach { color ->
                                    val on = pen.color.equals(color, ignoreCase = true)
                                    Box(
                                        Modifier
                                            .size(ch.fasrv.fanotes.desk.SWATCH_DP.dp)
                                            .clip(CircleShape)
                                            .background(Color(android.graphics.Color.parseColor(color)))
                                            .border(if (on) 2.dp else 0.dp, if (on) MaterialTheme.colorScheme.onSurface else Color.Transparent, CircleShape)
                                            .clickable { model.setPenColor(color) },
                                    )
                                }
                            }
                        }
                        SettingRow("Stiftbreite") {
                            SettingSlider(pen.width.toFloat(), 1f, 18f, 0.5f, " px") { model.setPenWidth(it.toDouble()) }
                        }
                        SettingRow("Druckempfindlichkeit", "Nutzt den Druckwert deines Stifts.") {
                            Switch(checked = pen.pressure, onCheckedChange = { model.setPenPressure(it) })
                        }
                        SettingRow("Nur Stift", "Im Handschriftmodus schreiben nur echte Stifte. Finger, Handfläche und Maus zeichnen nicht. Zoom und Tasten bleiben nutzbar.") {
                            Switch(checked = penOnly, onCheckedChange = { model.updateDesk("pen-only", if (it) "on" else "off") })
                        }
                        TabletButtonMap(
                            settings["tablet-buttons"],
                            Modifier.settingsAnchor("drawing", "settings-tablet-buttons", anchorY),
                        ) { encoded -> model.updateDesk("tablet-buttons", encoded) }
                        SettingRow("Strichglättung") {
                            SettingSlider(pen.smoothing.toFloat(), 0f, 1f, 0.05f, "") { model.updateDesk("smoothing", "%.2f".format(java.util.Locale.US, it)) }
                        }
                        SettingRow("Durchkritzel-Empfindlichkeit", "Niedrig verlangt mehr Überkreuzungen; hoch löscht schon nach einem kürzeren, eindeutigen Durchkritzeln.") {
                            SettingSlider(pen.scribble.toFloat(), 0f, 100f, 5f, " %") { model.updateDesk("scribble", it.toInt().toString()) }
                        }
                        SettingRow(
                            "Form-Erkennung",
                            "Wie bereitwillig Stillhalten eine Linie, einen Kreis oder ein Vieleck glättet. Niedrig nur bei sehr klaren Figuren; hoch früher und auch bei unsaubereren Strichen.",
                        ) {
                            SettingSlider(pen.shapeSnap.toFloat(), 0f, 100f, 5f, " %") { model.updateDesk("shape-snap", it.toInt().toString()) }
                        }
                        val standardBusy by model.noteStandardBusy.collectAsStateWithLifecycle()
                        val standardStatus by model.noteStandardStatus.collectAsStateWithLifecycle()
                        SettingRow(
                            "Alte Notizen auf den aktuellen Standard",
                            "Bringt vorhandene Handschrift auf die aktuelle scharfe HiDPI-Anzeige. Markdown, Tinte, Arbeitsblätter und Seitenstatistik bleiben erhalten.",
                            divider = false,
                            modifier = Modifier.settingsAnchor("drawing", "settings-note-standard", anchorY),
                        ) {
                            Column(horizontalAlignment = Alignment.End) {
                                TextButton(onClick = { model.convertOldNotes() }, enabled = !standardBusy) {
                                    Text(if (standardBusy) "Aktualisiert …" else "Aktualisieren")
                                }
                                if (!standardStatus.isNullOrBlank()) {
                                    Text(standardStatus.orEmpty(), fontSize = 12.sp, color = LocalStatusInk.current.muted)
                                }
                            }
                        }
                    }
                }
                "files" -> {
                    val metrics = ch.fasrv.fanotes.desk.editorMetrics(settings)
                    SettingCard("Dateiverhalten", Icons.Filled.Tune, Modifier.settingsAnchor("files", "settings-save", anchorY)) {
                        SettingRow("Automatisch speichern") {
                            SettingSlider(metrics.autosaveMs.toFloat(), 250f, 3000f, 250f, " ms") { model.updateDesk("autosave", it.toInt().toString()) }
                        }
                        SettingRow("Standardordner") {
                            OutlinedTextField(
                                settings["default-folder"] ?: "Eingang",
                                { model.updateDesk("default-folder", it) },
                                modifier = Modifier.widthIn(min = 170.dp),
                                singleLine = true,
                            )
                        }
                        SettingRow("Tagesnotizen", modifier = Modifier.settingsAnchor("files", "settings-daily", anchorY)) {
                            OutlinedTextField(
                                settings["daily-folder"].orEmpty(),
                                { model.updateDesk("daily-folder", it) },
                                modifier = Modifier.widthIn(min = 170.dp),
                                placeholder = { Text("Tagesnotizen") },
                                singleLine = true,
                            )
                        }
                        SettingRow("Datumsformat", divider = false) {
                            OutlinedTextField(
                                settings["date-format"].orEmpty().ifBlank { "YYYY-MM-DD" },
                                { model.updateDesk("date-format", it) },
                                modifier = Modifier.widthIn(min = 170.dp),
                                singleLine = true,
                            )
                        }
                    }
                    SettingCard("Aktueller Vault", Icons.Filled.Folder, Modifier.settingsAnchor("files", "settings-vault", anchorY)) {
                        SettingRow("Ordner", "Notizen bleiben Markdown-Dateien in diesem Ordner.", divider = false) {
                            Column {
                                TextButton(onClick = onOpenVault) { Text("Vault-Ordner öffnen") }
                                TextButton(onClick = onPrivate) { Text("Tablet-Vault verwenden") }
                            }
                        }
                    }
                    SettingCard("Profil", Icons.Filled.Person) {
                        SettingRow("Arbeitsprofil", divider = false) {
                            Column {
                                listOf("school" to "Schule", "university" to "UNI", "private" to "Privat", "work" to "Arbeit").forEach { (id, label) ->
                                    val on = settings["profile"] == id
                                    Text(
                                        label,
                                        fontSize = 12.sp,
                                        fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                                        color = if (on) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.soft,
                                        modifier = Modifier.clickable { model.applyProfile(id) }.padding(vertical = 4.dp),
                                    )
                                }
                            }
                        }
                    }
                }
                "sync" -> {
                    var deviceName by remember { mutableStateOf(model.syncDeviceName()) }
                    var automatic by remember { mutableStateOf(model.syncAutomatic()) }
                    val historySync = settings["sync-history"] == "on"
                    val signedIn = sync.account != null
                    var registerMode by remember { mutableStateOf(false) }
                    SyncAccountCallout(Modifier.padding(bottom = 13.dp), viewportWidth)
                    SettingCard(
                        if (signedIn) "Konto & Status" else if (registerMode) ch.fasrv.fanotes.sync.SYNC_ACCOUNT_REGISTER else ch.fasrv.fanotes.sync.SYNC_ACCOUNT_LOGIN,
                        if (signedIn) Icons.Filled.Cloud else Icons.Filled.Key,
                        Modifier.settingsAnchor("sync", "settings-sync-account", anchorY),
                        action = if (signedIn) null else {
                            { SyncModeSwitch(registerMode) { registerMode = it } }
                        },
                    ) {
                        if (sync.account != null) {
                            Column(Modifier.fillMaxWidth().padding(15.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(sync.account?.email.orEmpty(), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(
                                    "${ch.fasrv.fanotes.sync.syncStatusLabel(sync)} · Zuletzt: ${ch.fasrv.fanotes.sync.syncDeviceSeenLabel(sync.lastSyncAt)}",
                                    fontSize = 12.sp,
                                    color = LocalStatusInk.current.muted,
                                )
                                if (!sync.error.isNullOrBlank()) {
                                    Text(sync.error.orEmpty(), fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                                }
                                val info = sync.info
                                if (info != null) {
                                    Text(
                                        ch.fasrv.fanotes.sync.syncUsageLabel(info.files, info.bytes, info.quotaBytes),
                                        fontSize = 12.sp,
                                        color = LocalStatusInk.current.muted,
                                    )
                                    val fraction = ch.fasrv.fanotes.sync.syncUsagePercent(info.bytes, info.quotaBytes) / 100f
                                    Box(
                                        Modifier
                                            .padding(top = 4.dp)
                                            .fillMaxWidth()
                                            .height(4.dp)
                                            .clip(RoundedCornerShape(2.dp))
                                            .background(LocalStatusInk.current.muted.copy(alpha = 0.2f)),
                                    ) {
                                        Box(
                                            Modifier
                                                .fillMaxWidth(fraction)
                                                .height(4.dp)
                                                .background(MaterialTheme.colorScheme.primary),
                                        )
                                    }
                                }
                            }
                            Box(Modifier.fillMaxWidth().height(1.dp).background(MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)))
                        }
                        if (sync.account == null) {
                            SyncSignInFields(model, registerMode)
                        } else {
                        SettingRow("Konto") {
                            Row {
                                TextButton(onClick = onSync, enabled = sync.status != ch.fasrv.fanotes.sync.SyncStatus.SYNCING) {
                                    Text("Jetzt synchronisieren")
                                }
                                TextButton(onClick = { model.logout() }) { Text("Abmelden") }
                            }
                        }
                        SettingRow("Automatisch synchronisieren", "Nach jedem Speichern und im Hintergrund. Aus: nur über „Jetzt synchronisieren“.") {
                            Switch(checked = automatic, onCheckedChange = {
                                automatic = it
                                model.setSyncAutomatic(it)
                            })
                        }
                        SettingRow("Versionsverlauf synchronisieren", "Die lokalen Sicherungen unter .fanotes/history mitnehmen. Aus: der Verlauf bleibt auf diesem Gerät.") {
                            Switch(checked = historySync, onCheckedChange = { model.updateDesk("sync-history", if (it) "on" else "off") })
                        }
                        SettingRow("Ordner nur auf diesem Gerät", "Ein Ordner je Zeile. Dateien darunter bleiben auf diesem Tablet.") {
                            OutlinedTextField(
                                settings["sync-excluded"].orEmpty(),
                                { model.updateDesk("sync-excluded", it) },
                                modifier = Modifier.widthIn(min = 170.dp),
                                minLines = 3,
                            )
                        }
                        SettingRow(
                            "Name dieses Geräts",
                            "Erscheint in der Geräteliste und im Namen von Konfliktkopien.",
                            divider = false,
                        ) {
                            OutlinedTextField(
                                deviceName,
                                {
                                    deviceName = it.take(80)
                                    model.setSyncDeviceName(it.take(80))
                                },
                                modifier = Modifier.widthIn(min = 170.dp),
                                singleLine = true,
                            )
                        }
                        }
                    }
                    SettingCard("Angemeldete Geräte", Icons.Filled.Laptop, Modifier.settingsAnchor("sync", "settings-sync-devices", anchorY)) {
                        val devices = sync.info?.devices.orEmpty()
                        when {
                            sync.account == null -> SettingRow("Nicht angemeldet", divider = false) {}
                            devices.isEmpty() && sync.info == null && syncDeviceNote != null -> SettingRow(
                                syncDeviceNote.orEmpty(),
                                divider = false,
                            ) {
                                TextButton(onClick = { model.refreshSyncDevices() }) { Text("Erneut laden") }
                            }
                            devices.isEmpty() && sync.info == null -> SettingRow("Geräteliste wird geladen …", divider = false) {}
                            devices.isEmpty() -> SettingRow("Keine weiteren Geräte", divider = false) {}
                            else -> devices.forEachIndexed { index, device ->
                                SettingRow(
                                    device.name.ifBlank { "Gerät" },
                                    "Zuletzt aktiv: ${ch.fasrv.fanotes.sync.syncDeviceSeenLabel(device.lastSeenAt)}",
                                    divider = index != devices.lastIndex,
                                    glyph = if (ch.fasrv.fanotes.sync.syncDeviceGlyph(device.platform) == "phone") Icons.Filled.Smartphone else Icons.Filled.Laptop,
                                    mark = if (device.current) ch.fasrv.fanotes.sync.SYNC_DEVICE_MARK else null,
                                ) {
                                    if (ch.fasrv.fanotes.sync.syncDeviceCanSignOut(device.current)) {
                                        TextButton(onClick = { model.removeSyncDevice(device.id, device.name) }) { Text("Abmelden") }
                                    }
                                }
                            }
                        }
                    }
                    if (sync.account != null) SyncPasswordCards(model)
                    Text("Ein Konflikt behält die Serverfassung auf dem ursprünglichen Pfad. Die Tablet-Fassung liegt daneben.", fontSize = 12.sp, color = LocalStatusInk.current.muted)
                    ConflictList(model)
                    SyncLogCard(sync.log)
                }
                "addons" -> SettingCard("Add-ons", Icons.Filled.Extension) {
                    SettingRow("Erweiterungen", "Add-ons des Desktops bleiben Dateien im Vault. Andere Erweiterungen werden nicht ausgeführt.", divider = false) {}
                }
                "updates" -> SettingCard("Updates", Icons.Filled.SystemUpdate, Modifier.settingsAnchor("updates", "settings-updates", anchorY)) {
                    SettingRow("Installiert", divider = false) {
                        Column {
                            Text("2026.10.7", fontSize = 12.sp)
                            Text(update, fontSize = 12.sp, color = LocalStatusInk.current.muted)
                            TextButton(onClick = { model.checkUpdate() }) { Text("Nach einem Release suchen") }
                        }
                    }
                }
                "accessibility" -> {
                    val calm = ch.fasrv.fanotes.desk.reduceMotion(settings["reduce-motion"])
                    SettingCard("Komfort & Fokus", Icons.Filled.Accessibility, Modifier.settingsAnchor("accessibility", "settings-comfort", anchorY)) {
                        SettingRow("Bewegung reduzieren", "Deaktiviert dekorative Übergänge und Animationen.") {
                            Switch(checked = calm, onCheckedChange = { model.updateDesk("reduce-motion", if (it) "on" else "off") })
                        }
                        SettingRow("Seitenleiste") {
                            SettingSlider(ch.fasrv.fanotes.desk.sidebarWidthDp(settings["sidebar-width"]).toFloat(), 210f, 430f, 10f, " px") {
                                model.updateDesk("sidebar-width", it.toInt().toString())
                            }
                        }
                        SettingRow("Informationsleiste", divider = false) {
                            SettingSlider(ch.fasrv.fanotes.desk.rightPanelWidthDp(settings["panel-width"]).toFloat(), 220f, 430f, 10f, " px") {
                                model.updateDesk("panel-width", it.toInt().toString())
                            }
                        }
                    }
                }
                "experimental" -> {
                    val backups = settings["experimental-backup"] == "on"
                    SettingCard("Experimentelle Funktionen", Icons.Filled.Science, Modifier.settingsAnchor("experimental", "settings-note-backup", anchorY)) {
                        SettingRow("Notiz-Sicherungen", "Legt Sicherungen in der Notiz ab und zeigt sie im Verlauf.", divider = false) {
                            Switch(checked = backups, onCheckedChange = { model.updateDesk("experimental-backup", if (it) "on" else "off") })
                        }
                    }
                }
                "advanced" -> {
                    SettingCard("Eigenes CSS", Icons.Filled.Code, Modifier.settingsAnchor("advanced", "settings-css", anchorY)) {
                        Column(Modifier.padding(horizontal = 15.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("Wird nur innerhalb der Oberfläche angewandt. Damit kannst du Abstände, Farben und Markdown-Elemente weiter personalisieren.", fontSize = 12.sp, color = LocalStatusInk.current.muted)
                            OutlinedTextField(
                                css,
                                { model.updateCustomCss(it) },
                                modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp),
                                placeholder = { Text(":root {\n  --radius: 14px;\n}") },
                            )
                            Text("Secrets liegen im Android-Keystore, nicht im Vault.", fontSize = 12.sp, color = LocalStatusInk.current.muted)
                        }
                    }
                }
            }
            TextButton(onClick = { model.openBugReport() }) { Text("Fehler melden") }
            Text("Die letzten fünf Minuten (Stift, Notiz, Werkzeug) werden an fanotes.fasrv.ch geschickt.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)),
            )
            Row(
                Modifier
                    .fillMaxWidth()
                    .height(ch.fasrv.fanotes.desk.SETTINGS_FOOTER_DP.dp)
                    .padding(start = 25.dp, end = 19.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    ch.fasrv.fanotes.desk.SETTINGS_SAVED,
                    fontSize = 12.sp,
                    color = LocalStatusInk.current.success,
                    modifier = Modifier.weight(1f),
                )
                Box(
                    Modifier
                        .height(31.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(MaterialTheme.colorScheme.onSurface)
                        .clickable(onClick = onClose)
                        .padding(horizontal = 12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(ch.fasrv.fanotes.desk.SETTINGS_DONE, fontSize = 12.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.background)
                }
            }
        }
    }
    }
}

private fun Modifier.settingsAnchor(section: String, id: String, positions: MutableMap<String, Int>): Modifier =
    onGloballyPositioned { positions["$section:$id"] = it.positionInParent().y.toInt().coerceAtLeast(0) }

@Composable
fun NoteTagBar(model: FaNotesViewModel) {
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val open by model.open.collectAsStateWithLifecycle()
    val token by model.canvasToken.collectAsStateWithLifecycle()
    val settings by model.deskSettings.collectAsStateWithLifecycle()
    val tags = parseNoteTags(markdown)
    val paper = remember(token, open?.path) { model.session.document.paperStyle }
    var draft by remember(open?.path) { mutableStateOf("") }
    val backups = ch.fasrv.fanotes.desk.parseNoteBackups(open?.payload?.array("noteBackups"))
        .filter { it.notePath == open?.path }
    val backupPolicy = ch.fasrv.fanotes.desk.noteBackupControlPolicy(
        settings["experimental-backup"] == "on" && open != null,
        backups.size,
    )
    var backupMenu by remember(open?.path) { mutableStateOf(false) }
    fun addTag() {
        if (draft.isBlank()) return
        model.setNoteTags(tags + draft)
        draft = ""
    }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier.weight(1f).horizontalScroll(rememberScrollState()),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            tags.forEach { tag ->
                Text(
                    "#$tag  ×",
                    fontSize = 12.sp,
                    modifier = Modifier
                        .padding(end = 6.dp)
                        .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.6f), androidx.compose.foundation.shape.RoundedCornerShape(99.dp))
                        .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.1f), androidx.compose.foundation.shape.RoundedCornerShape(99.dp))
                        .clickable(onClickLabel = "Tag entfernen") { model.setNoteTags(tags.filter { it != tag }) }
                        .padding(horizontal = 7.dp, vertical = 4.dp),
                )
            }
            OutlinedTextField(
                draft,
                { draft = it.take(40) },
                modifier = Modifier.width(160.dp),
                singleLine = true,
                label = { Text("Tag hinzufügen") },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { addTag() }),
            )
        }
        if (backupPolicy.visible) {
            Box {
                Text(
                    "Backup",
                    fontSize = 12.sp,
                    modifier = Modifier
                        .padding(end = 8.dp)
                        .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.7f), androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
                        .clickable(
                            onClickLabel = if (backupPolicy.restore) {
                                "Backup: weiteres Backup oder wiederherstellen"
                            } else {
                                "Backup der aktuellen Notiz"
                            },
                        ) {
                            if (backupPolicy.restore) backupMenu = true else model.snapshotNote()
                        }
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                )
                DropdownMenu(expanded = backupMenu && backupPolicy.restore, onDismissRequest = { backupMenu = false }) {
                    DropdownMenuItem(
                        text = {
                            Column {
                                Text("Weiteres Backup", fontWeight = FontWeight.SemiBold)
                                Text("Aktuelle Notiz so sichern, wie sie ist", fontSize = 12.sp)
                            }
                        },
                        onClick = {
                            backupMenu = false
                            model.snapshotNote()
                        },
                    )
                    backups.asReversed().forEach { snapshot ->
                        DropdownMenuItem(
                            text = {
                                Column {
                                    Text("Wiederherstellen", fontWeight = FontWeight.SemiBold)
                                    Text(ch.fasrv.fanotes.desk.noteBackupStamp(snapshot.createdAt), fontSize = 12.sp)
                                }
                            },
                            onClick = {
                                backupMenu = false
                                model.restoreNoteBackup(snapshot.id)
                            },
                        )
                    }
                }
            }
        }
        if (open?.kind != ch.fasrv.fanotes.vault.NoteKind.PDF) {
            PaperStylePicker(paper) { model.setPaper(it) }
        }
    }
}

@Composable
private fun PaperStylePicker(style: String, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val current = ch.fasrv.fanotes.desk.paperStyleLabel(style)
    Box {
        Text(
            current,
            fontSize = 12.sp,
            modifier = Modifier
                .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.7f), androidx.compose.foundation.shape.RoundedCornerShape(8.dp))
                .clickable(onClickLabel = "Notizhintergrund: $current") { open = true }
                .padding(horizontal = 8.dp, vertical = 6.dp),
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            Text(
                ch.fasrv.fanotes.desk.PAPER_PICKER_HINT.uppercase(),
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.55f),
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
            )
            ch.fasrv.fanotes.desk.PAPER_STYLES.forEach { option ->
                val selected = option.id == ch.fasrv.fanotes.desk.normalizePaperStyle(style, "")
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(option.label, fontWeight = if (selected) FontWeight.Bold else FontWeight.SemiBold, fontSize = 12.sp)
                            Text(option.detail, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
                        }
                    },
                    onClick = {
                        onSelect(option.id)
                        open = false
                    },
                )
            }
        }
    }
}

@Composable
fun MarginTranscript(model: FaNotesViewModel) {
    val token by model.canvasToken.collectAsStateWithLifecycle()
    val path = model.open.collectAsStateWithLifecycle().value?.path
    val transcript = remember(token, path) { model.session.document.extras.string("searchTranscript").orEmpty() }
    val lines = marginLinesFromTranscript(transcript)
    if (lines.isEmpty()) return
    var editing by remember(token, path) { mutableStateOf<String?>(null) }
    var draft by remember(token, path) { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
        Text("Randtranskript", fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
        lines.forEachIndexed { index, line ->
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
                line.text.split(Regex("""(\s+)""")).forEach { part ->
                    if (part.isBlank()) {
                        Text(part)
                    } else if (editing == "$index:$part") {
                        OutlinedTextField(
                            draft,
                            { draft = it },
                            modifier = Modifier.width(140.dp),
                            singleLine = true,
                            label = { Text("Wort korrigieren") },
                        )
                        TextButton(onClick = {
                            model.correctTranscriptWord(part, draft)
                            editing = null
                        }) { Text("OK") }
                    } else {
                        Text(
                            part,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.clickable {
                                editing = "$index:$part"
                                draft = part
                            }.padding(horizontal = 2.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun PdfThumbStrip(model: FaNotesViewModel) {
    val open by model.pdfThumbOpen.collectAsStateWithLifecycle()
    val thumbs by model.pdfThumbs.collectAsStateWithLifecycle()
    val active by model.pdfThumbPage.collectAsStateWithLifecycle()
    val total by model.pdfPageCount.collectAsStateWithLifecycle()
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp)) {
        TextButton(onClick = { model.togglePdfThumbs() }) { Text(if (open) "Miniaturen ●" else "Miniaturen") }
        if (open) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.Top,
            ) {
                thumbs.forEachIndexed { index, bitmap ->
                    if (bitmap.isRecycled) return@forEachIndexed
                    val page = index + 1
                    val selected = page == active
                    Column(
                        Modifier
                            .width(76.dp)
                            .border(if (selected) 2.dp else 1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline)
                            .clickable { model.showPdfThumb(page) }
                            .padding(2.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Image(
                            bitmap.asImageBitmap(),
                            contentDescription = "Seite $page",
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        )
                        Text("$page", fontSize = 11.sp)
                    }
                }
            }
            if (total > thumbs.size && thumbs.isNotEmpty()) {
                Text("Erste ${thumbs.size} Seiten", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f))
            }
        }
    }
}

@Composable
private fun SearchFlag(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked, onChange)
        Text(label, fontSize = 13.sp)
    }
}

@Composable
fun NoteSearchBar(model: FaNotesViewModel) {
    val query by model.noteSearchQuery.collectAsStateWithLifecycle()
    val hits by model.noteSearchHits.collectAsStateWithLifecycle()
    val index by model.noteSearchIndex.collectAsStateWithLifecycle()
    val caseSensitive by model.noteSearchCaseSensitive.collectAsStateWithLifecycle()
    val regexp by model.noteSearchRegexp.collectAsStateWithLifecycle()
    val wholeWord by model.noteSearchWholeWord.collectAsStateWithLifecycle()
    val focusToken by model.noteSearchFocus.collectAsStateWithLifecycle()
    val searchFocus = androidx.compose.runtime.remember { FocusRequester() }
    androidx.compose.runtime.LaunchedEffect(focusToken) {
        if (focusToken > 0) runCatching { searchFocus.requestFocus() }
    }
    var replacement by remember { mutableStateOf("") }
    val status = when {
        query.trim().isEmpty() -> ""
        hits.isEmpty() -> "Keine Treffer"
        else -> "${index + 1} / ${hits.size}"
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                query,
                { model.updateNoteSearch(it) },
                modifier = Modifier.weight(1f).focusRequester(searchFocus).onPreviewKeyEvent { event ->
                    if (event.type == KeyEventType.KeyDown && event.key == Key.Escape && query.isNotEmpty()) {
                        model.updateNoteSearch("")
                        true
                    } else {
                        false
                    }
                },
                singleLine = true,
                label = { Text("Im Text suchen …") },
            )
            if (status.isNotEmpty()) Text(status, fontSize = 12.sp, modifier = Modifier.padding(start = 8.dp))
        }
        if (query.isNotEmpty()) {
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = { model.stepNoteSearch(-1) }, enabled = hits.isNotEmpty()) { Text("Vorheriger Treffer") }
                TextButton(onClick = { model.stepNoteSearch(1) }, enabled = hits.isNotEmpty()) { Text("Nächster Treffer") }
                SearchFlag("Groß-/Kleinschreibung", caseSensitive, model::setNoteSearchCaseSensitive)
                SearchFlag("Regulärer Ausdruck", regexp, model::setNoteSearchRegexp)
                SearchFlag("Ganzes Wort", wholeWord, model::setNoteSearchWholeWord)
            }
            OutlinedTextField(
                replacement,
                { replacement = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text("Ersetzen") },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { model.replaceCurrentNoteSearch(replacement) }),
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { model.replaceCurrentNoteSearch(replacement) }, enabled = hits.isNotEmpty()) { Text("Ersetzen") }
                TextButton(onClick = { model.replaceAllNoteSearch(replacement) }, enabled = hits.isNotEmpty()) { Text("Alle ersetzen") }
            }
            val windowStart = (index - 2).coerceAtLeast(0)
            hits.drop(windowStart).take(6).forEachIndexed { offset, hit ->
                val hitIndex = windowStart + offset
                val selected = hitIndex == index
                Text(
                    hit.excerpt,
                    fontSize = 13.sp,
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                    maxLines = 2,
                    modifier = Modifier.fillMaxWidth().clickable { model.showNoteSearchHit(hitIndex) }.padding(vertical = 2.dp),
                )
            }
        }
    }
}

@Composable
fun PdfPasswordPrompt(model: FaNotesViewModel) {
    val needed by model.pdfNeedsPassword.collectAsStateWithLifecycle()
    val rejected by model.pdfPasswordRejected.collectAsStateWithLifecycle()
    if (!needed) return
    var draft by remember { mutableStateOf("") }
    val supported = ch.fasrv.fanotes.desk.pdfPasswordSupported(android.os.Build.VERSION.SDK_INT)
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
        Text(ch.fasrv.fanotes.desk.PDF_PASSWORD_TITLE, fontWeight = FontWeight.SemiBold)
        if (!supported) {
            Text(ch.fasrv.fanotes.desk.PDF_PASSWORD_NEEDS_ANDROID_15, fontSize = 13.sp)
            return@Column
        }
        OutlinedTextField(
            draft,
            { draft = it },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
            label = { Text("Passwort") },
        )
        if (rejected) Text(ch.fasrv.fanotes.desk.PDF_PASSWORD_WRONG, fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
        TextButton(onClick = { model.submitPdfPassword(draft) }) { Text(ch.fasrv.fanotes.desk.PDF_PASSWORD_ACTION) }
    }
}

@Composable
fun PdfNoteToolbar(model: FaNotesViewModel) {
    val open by model.open.collectAsStateWithLifecycle()
    val page by model.pdfThumbPage.collectAsStateWithLifecycle()
    val backdrop by model.backdrop.collectAsStateWithLifecycle()
    val zoom by model.pdfZoom.collectAsStateWithLifecycle()
    val mode by model.pdfZoomMode.collectAsStateWithLifecycle()
    val desk by model.deskSettings.collectAsStateWithLifecycle()
    val count = backdrop.count { it.bitmap != null && it.worksheetId.isEmpty() }
    val zoomMax = ch.fasrv.fanotes.desk.editorMetrics(desk).zoomMax
    var draft by remember(open?.path) { mutableStateOf(page.toString()) }
    androidx.compose.runtime.LaunchedEffect(page) { draft = page.toString() }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(open?.title ?: "PDF", fontWeight = FontWeight.SemiBold, maxLines = 1, modifier = Modifier.weight(1f))
            Text(ch.fasrv.fanotes.desk.pdfPageCountLabel(count), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f))
        }
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextButton(onClick = { model.goToPdfPage(page - 1) }, enabled = page > 1) { Text("Vorherige Seite") }
            OutlinedTextField(
                draft,
                { draft = it.filter { char -> char.isDigit() }.take(4) },
                modifier = Modifier.width(72.dp),
                singleLine = true,
                label = { Text("Seite") },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = {
                    draft.toIntOrNull()?.let(model::goToPdfPage)
                }),
            )
            Text("/ ${if (count > 0) count else "…"}", fontSize = 12.sp, modifier = Modifier.padding(horizontal = 6.dp))
            TextButton(onClick = { model.goToPdfPage(page + 1) }, enabled = count > 0 && page < count) { Text("Nächste Seite") }
            TextButton(onClick = { model.requestPdfCamera("out") }, enabled = zoom > 0.5 + 1e-4) { Text("Verkleinern") }
            Text(
                ch.fasrv.fanotes.desk.pdfZoomPercentLabel(zoom),
                fontSize = 12.sp,
                fontWeight = if (mode == "custom") FontWeight.SemiBold else FontWeight.Normal,
                modifier = Modifier.padding(horizontal = 4.dp),
            )
            TextButton(onClick = { model.requestPdfCamera("in") }, enabled = zoom < zoomMax - 1e-4) { Text("Vergrößern") }
            TextButton(onClick = { model.requestPdfCamera("fit-width") }) {
                Text("Breite", fontWeight = if (mode == "fit-width") FontWeight.Bold else FontWeight.Normal)
            }
            TextButton(onClick = { model.requestPdfCamera("fit-page") }) {
                Text("Ganze Seite", fontWeight = if (mode == "fit-page") FontWeight.Bold else FontWeight.Normal)
            }
            TextButton(onClick = { model.requestPdfCamera("rotate") }) { Text("Drehen") }
        }
    }
}

@Composable
fun PdfSearchBar(model: FaNotesViewModel) {
    val query by model.pdfSearchQuery.collectAsStateWithLifecycle()
    val hits by model.pdfSearchHits.collectAsStateWithLifecycle()
    val index by model.pdfSearchIndex.collectAsStateWithLifecycle()
    val busy by model.pdfSearchBusy.collectAsStateWithLifecycle()
    val focusToken by model.pdfSearchFocus.collectAsStateWithLifecycle()
    val searchFocus = remember { FocusRequester() }
    androidx.compose.runtime.LaunchedEffect(focusToken) {
        if (focusToken > 0) runCatching { searchFocus.requestFocus() }
    }
    val status = when {
        busy -> "Sucht …"
        query.trim().isEmpty() -> ""
        hits.isEmpty() -> "Keine Treffer"
        else -> "${index + 1} / ${hits.size}"
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                query,
                { model.updatePdfSearch(it) },
                modifier = Modifier.weight(1f).focusRequester(searchFocus),
                singleLine = true,
                label = { Text("Im PDF suchen …") },
            )
            if (status.isNotEmpty()) {
                Text(status, fontSize = 12.sp, modifier = Modifier.padding(start = 8.dp))
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { model.stepPdfSearch(-1) }, enabled = hits.isNotEmpty()) { Text("Vorheriger Treffer") }
            TextButton(onClick = { model.stepPdfSearch(1) }, enabled = hits.isNotEmpty()) { Text("Nächster Treffer") }
        }
        val windowStart = (index - 2).coerceAtLeast(0)
        hits.drop(windowStart).take(6).forEachIndexed { offset, hit ->
            val hitIndex = windowStart + offset
            val selected = hitIndex == index
            Text(
                "S. ${hit.page}  ${hit.excerpt}",
                fontSize = 13.sp,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                maxLines = 2,
                modifier = Modifier.fillMaxWidth().clickable { model.showPdfSearchHit(hitIndex) }.padding(vertical = 2.dp),
            )
        }
    }
}

@Composable
fun PdfQuoteMarks(model: FaNotesViewModel) {
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val marks = readPdfMarks(markdown)
    var page by remember { mutableStateOf("1") }
    var quote by remember { mutableStateOf("") }
    var underline by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
        Text("PDF-Markierungen", fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
        Text("Zitate bleiben in der Notiz, dieselbe Datei wie auf dem Desktop.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f))
        marks.forEach { mark ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "S. ${mark.page}  ${if (mark.kind == "underline") "Unterstrichen" else "Markiert"}  ${mark.quote}",
                    modifier = Modifier.weight(1f),
                    fontSize = 13.sp,
                    maxLines = 2,
                )
                TextButton(onClick = { model.removePdfQuote(mark.id) }) { Text("Entfernen") }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(page, { page = it.take(4) }, label = { Text("Seite") }, modifier = Modifier.width(88.dp), singleLine = true)
            OutlinedTextField(quote, { quote = it.take(400) }, label = { Text("Zitat") }, modifier = Modifier.weight(1f), singleLine = true)
        }
        Row {
            TextButton(onClick = { underline = !underline }) { Text(if (underline) "Unterstreichen" else "Markieren") }
            TextButton(onClick = {
                val number = page.toIntOrNull() ?: return@TextButton
                if (quote.isNotBlank()) {
                    model.addPdfQuote(number, quote, if (underline) "underline" else "highlight")
                    quote = ""
                }
            }) { Text("Hinzufügen") }
        }
    }
}

@Composable
fun NoteRelations(model: FaNotesViewModel, onOpen: (String) -> Unit) {
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val incoming by model.backlinks.collectAsStateWithLifecycle()
    val outgoing = wikiTargets(markdown)
    Column(Modifier.fillMaxWidth()) {
        if (outgoing.isNotEmpty()) {
            InspectorHeading("Verweise")
            outgoing.forEach { target ->
                Text(
                    "[[$target]]",
                    color = MaterialTheme.colorScheme.primary,
                    fontSize = 13.sp,
                    modifier = Modifier.clickable { model.openWikiTarget(target) }.padding(vertical = 2.dp),
                )
            }
        }
        InspectorHeading("Rückverweise")
        if (incoming.isEmpty()) {
            Text("Keine Wiki-Links auf diese Notiz.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f))
        }
        incoming.forEach { link ->
            Column(Modifier.fillMaxWidth().clickable { onOpen(link.path) }.padding(vertical = 4.dp)) {
                Text(link.title, fontSize = 13.sp)
                if (link.excerpt.isNotEmpty()) {
                    Text(link.excerpt, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.65f), maxLines = 2)
                }
            }
        }
    }
}

@Composable
private fun NoteHistoryRows(
    model: FaNotesViewModel,
    history: List<ch.fasrv.fanotes.vault.HistorySnapshot>,
    comparison: Pair<String, String>?,
) {
    history.forEach { snapshot ->
        Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(ch.fasrv.fanotes.vault.historyStampLabel(snapshot.createdAt), fontSize = 14.sp)
                    Text("${snapshot.bytes} Bytes", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
                }
                TextButton(onClick = { model.compareHistory(snapshot.id) }) { Text("Vergleichen") }
                TextButton(onClick = { model.restoreHistory(snapshot.id) }) { Text("Wiederherstellen") }
            }
            val shown = comparison
            if (shown != null && shown.first == snapshot.id) HistoryDiff(shown.second)
        }
    }
}

@Composable
private fun HistoryDiff(diff: String) {
    diff.lineSequence().forEach { line ->
        val color = when {
            line.startsWith("+") -> MaterialTheme.colorScheme.primary
            line.startsWith("-") -> MaterialTheme.colorScheme.error
            else -> MaterialTheme.colorScheme.onSurface
        }
        Text(line, color = color, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
    }
    if (ch.fasrv.fanotes.desk.timelineHasInk(diff)) {
        Text("Enthält Handschrift.", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f))
    }
}

@Composable
private fun InspectorHeading(title: String) {
    Text(
        title.uppercase(java.util.Locale.GERMAN),
        fontSize = 12.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = ch.fasrv.fanotes.desk.INSPECTOR_HEADING_TRACKING.em,
        color = LocalStatusInk.current.muted,
        modifier = Modifier.padding(start = 5.dp, top = 10.dp, end = 5.dp, bottom = 8.dp),
    )
}

@Composable
fun Inspector(model: FaNotesViewModel, onOpen: (String) -> Unit) {
    val markdown by model.markdown.collectAsStateWithLifecycle()
    val settings by model.deskSettings.collectAsStateWithLifecycle()
    val path = model.open.collectAsStateWithLifecycle().value?.path
    val history by model.noteHistory.collectAsStateWithLifecycle()
    val comparison by model.historyComparison.collectAsStateWithLifecycle()
    if (settings["outline"] == "off") return
    LaunchedEffect(path) { model.refreshNoteHistory() }
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .height(ch.fasrv.fanotes.desk.INSPECTOR_HEADER_DP.dp)
                    .padding(horizontal = 9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "Gliederung",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier
                        .height(ch.fasrv.fanotes.desk.INSPECTOR_TAB_DP.dp)
                        .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.INSPECTOR_TAB_RADIUS_DP.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                        .padding(horizontal = 7.dp)
                        .wrapContentHeight(Alignment.CenterVertically),
                )
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)),
            )
        }
        Column(Modifier.fillMaxSize().padding(horizontal = 10.dp, vertical = 8.dp).verticalScroll(rememberScrollState())) {
            val live = ch.fasrv.fanotes.desk.inspectorDocument(markdown)
            val stats = measureDocument(markdown)
            val muted = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f)
            InspectorHeading("Gliederung")
            val headings = parseNoteOutline(markdown)
            if (headings.isEmpty()) {
                Text("Überschriften erscheinen hier automatisch.", fontSize = 12.sp, color = muted)
            }
            headings.forEach { heading ->
                Text(
                    "› ${heading.title}",
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = ch.fasrv.fanotes.desk.INSPECTOR_OUTLINE_DP.dp)
                        .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.INSPECTOR_OUTLINE_RADIUS_DP.dp))
                        .clickable { model.jumpToOutline(heading.line) }
                        .padding(start = ch.fasrv.fanotes.desk.outlineIndentDp(heading.level).dp, end = 7.dp)
                        .wrapContentHeight(Alignment.CenterVertically),
                    fontSize = 12.sp,
                    color = LocalStatusInk.current.soft,
                    maxLines = 1,
                )
            }
            InspectorHeading("Dokument")
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                listOf(
                    "Wörter" to live.words.toString(),
                    "Zeichen" to live.characters.toString(),
                    "Lesezeit" to "~ ${live.readingMinutes} min",
                ).forEach { (label, value) ->
                    Column(
                        Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.INSPECTOR_STAT_RADIUS_DP.dp))
                            .background(LocalStatusInk.current.panelStrong.copy(alpha = 0.72f))
                            .border(
                                1.dp,
                                MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA),
                                RoundedCornerShape(ch.fasrv.fanotes.desk.INSPECTOR_STAT_RADIUS_DP.dp),
                            )
                            .padding(horizontal = 6.dp, vertical = 7.dp),
                    ) {
                        Text(label, fontSize = 12.sp, color = LocalStatusInk.current.muted)
                        Text(
                            value,
                            fontSize = 12.sp,
                            fontWeight = FontWeight(ch.fasrv.fanotes.desk.INSPECTOR_VALUE_WEIGHT),
                            modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                }
            }
            Text("${stats.headings} Überschriften · ${stats.tasksDone}/${stats.tasks} Aufgaben", fontSize = 12.sp, color = muted, modifier = Modifier.padding(top = 6.dp))
            if (path != null) Text(path, fontSize = 12.sp, color = muted, maxLines = 1, modifier = Modifier.padding(top = 6.dp))
            NoteRelations(model, onOpen)
            InspectorHeading("Versionen")
            TextButton(onClick = { model.openHistory() }) { Text("Verlauf laden") }
            history.forEach { snapshot ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        ch.fasrv.fanotes.vault.historyStampLabel(snapshot.createdAt),
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.weight(1f).clickable { model.compareHistory(snapshot.id) }.padding(vertical = 4.dp),
                    )
                    TextButton(onClick = { model.restoreHistory(snapshot.id) }) { Text("Wiederherstellen") }
                }
            }
            val shown = comparison
            if (shown != null) HistoryDiff(shown.second)
            InspectorHeading("Tags")
            val tags = parseNoteTags(markdown)
            if (tags.isEmpty()) {
                Text("Noch keine Tags.", fontSize = 12.sp, color = muted)
            } else {
                FlowRow(Modifier.fillMaxWidth().padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(5.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    tags.forEach { tag ->
                        Text(
                            "#$tag",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier
                                .background(LocalStatusInk.current.panelActive, androidx.compose.foundation.shape.RoundedCornerShape(99.dp))
                                .padding(horizontal = 7.dp, vertical = 4.dp),
                        )
                    }
                }
            }
            InspectorHeading("Aufgaben")
            taskLines(markdown).forEach { (index, done, text) ->
                Text("${if (done) "☑" else "☐"} $text", modifier = Modifier.clickable { model.updateMarkdown(ch.fasrv.fanotes.desk.toggleTask(markdown, index)) }.padding(vertical = 4.dp), fontSize = 13.sp)
            }
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(top = 14.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.surface)
                    .border(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.1f), RoundedCornerShape(10.dp))
                    .padding(10.dp),
            ) {
                Text("Local first", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = LocalStatusInk.current.soft)
                Text("Deine Inhalte bleiben als lesbare Dateien in deinem Vault.", fontSize = 12.sp, color = LocalStatusInk.current.muted, modifier = Modifier.padding(top = 3.dp))
            }
        }
    }
}

@Composable
fun CommandPalette(
    onDismiss: () -> Unit,
    rankNotes: (String, Int) -> List<SwitcherNote>,
    onOpenNote: (String) -> Unit,
    onOpenNoteInSplit: (String) -> Unit = {},
    splitOpen: Boolean = false,
    splitRows: Boolean = false,
    focus: Boolean = false,
    dailyFolder: String = "",
    notesOnly: Boolean = false,
    activePath: String? = null,
    reduceMotion: Boolean = false,
    penOpen: Boolean = false,
    bookOpen: Boolean = false,
    onRun: (String) -> Unit,
) {
    var query by remember(notesOnly) { mutableStateOf("") }
    var selected by remember { mutableIntStateOf(0) }
    val notes = if (notesOnly) rankNotes(query, 40) else if (query.isBlank()) emptyList() else rankNotes(query, 6)
    val actions = ch.fasrv.fanotes.desk.paletteCommands(penOpen, bookOpen, splitOpen, splitRows, focus, dailyFolder)
    val commands = if (notesOnly) emptyList() else actions.filter { ch.fasrv.fanotes.desk.paletteCommandMatches(it, query) }
    val rows = commands.map { PaletteRow.Command(it) } + notes.map { PaletteRow.Note(it.path, it.title, it.folder) }
    androidx.compose.runtime.LaunchedEffect(query, notesOnly) { selected = 0 }
    val listState = rememberLazyListState()
    androidx.compose.runtime.LaunchedEffect(selected, rows.size, reduceMotion) {
        if (rows.isNotEmpty()) {
            val index = selected.coerceIn(0, rows.lastIndex)
            if (ch.fasrv.fanotes.desk.listFollowsSelection(reduceMotion) == "instant") listState.scrollToItem(index)
            else listState.animateScrollToItem(index)
        }
    }
    fun openRow(index: Int, split: Boolean) {
        val row = rows.getOrNull(index) ?: return
        when (row) {
            is PaletteRow.Command -> {
                onRun(row.command.id)
                if (row.command.id == "quick-open") return
            }
            is PaletteRow.Note -> if (ch.fasrv.fanotes.desk.paletteOpensInSplit("note", split)) onOpenNoteInSplit(row.path) else onOpenNote(row.path)
        }
        onDismiss()
    }
    val shape = RoundedCornerShape(ch.fasrv.fanotes.desk.PALETTE_RADIUS_DP.dp)
    val rule = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.SEARCH_RULE_ALPHA)
    val strong = MaterialTheme.colorScheme.onSurface.copy(alpha = ch.fasrv.fanotes.desk.PREVIEW_BORDER_STRONG_ALPHA)
    Column(
        Modifier
            .widthIn(max = ch.fasrv.fanotes.desk.PALETTE_MAX_DP.dp)
            .fillMaxWidth()
            .heightIn(max = ch.fasrv.fanotes.desk.PALETTE_MAX_HEIGHT_DP.dp)
            .directionalPaletteShade()
            .clip(shape)
            .border(1.dp, strong, shape)
            .background(MaterialTheme.colorScheme.background),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(ch.fasrv.fanotes.desk.PALETTE_SEARCH_DP.dp)
                .padding(horizontal = ch.fasrv.fanotes.desk.PALETTE_SEARCH_PAD_DP.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.PALETTE_SEARCH_GAP_DP.dp),
        ) {
            Icon(
                Icons.Filled.Search,
                contentDescription = null,
                modifier = Modifier.size(19.dp),
                tint = if (notesOnly) LocalStatusInk.current.soft else MaterialTheme.colorScheme.primary,
            )
            BasicTextField(
                query,
                { query = it },
                singleLine = true,
                textStyle = TextStyle(
                    color = MaterialTheme.colorScheme.onSurface,
                    fontSize = ch.fasrv.fanotes.desk.PALETTE_SEARCH_SP.sp,
                ),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                modifier = Modifier.weight(1f).onPreviewKeyEvent { event ->
                    if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                    when (event.key) {
                        Key.DirectionDown -> {
                            selected = ch.fasrv.fanotes.desk.paletteMove(selected, rows.size, 1)
                            true
                        }
                        Key.DirectionUp -> {
                            selected = ch.fasrv.fanotes.desk.paletteMove(selected, rows.size, -1)
                            true
                        }
                        Key.PageDown -> {
                            selected = ch.fasrv.fanotes.desk.paletteMove(selected, rows.size, 8)
                            true
                        }
                        Key.PageUp -> {
                            selected = ch.fasrv.fanotes.desk.paletteMove(selected, rows.size, -8)
                            true
                        }
                        Key.Enter, Key.NumPadEnter -> {
                            openRow(selected, event.isShiftPressed)
                            true
                        }
                        else -> false
                    }
                },
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.CenterStart) {
                        if (query.isEmpty()) {
                            Text(
                                if (notesOnly) "Notiz öffnen …" else "Befehl suchen …",
                                color = LocalStatusInk.current.muted,
                                fontSize = ch.fasrv.fanotes.desk.PALETTE_SEARCH_SP.sp,
                            )
                        }
                        inner()
                    }
                },
            )
            Box(
                Modifier
                    .size(ch.fasrv.fanotes.desk.PALETTE_CLOSE_DP.dp)
                    .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.PALETTE_CLOSE_RADIUS_DP.dp))
                    .clickable(onClickLabel = "Schließen", onClick = onDismiss),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Close, contentDescription = "Schließen", modifier = Modifier.size(16.dp), tint = LocalStatusInk.current.muted)
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(rule))
        if (rows.isEmpty()) {
            Text(
                if (notesOnly) "Keine passende Notiz" else "Kein passender Befehl",
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = ch.fasrv.fanotes.desk.PALETTE_EMPTY_PAD_TOP_DP.dp, bottom = 20.dp),
                fontSize = 12.sp,
                color = LocalStatusInk.current.muted,
                textAlign = TextAlign.Center,
            )
        }
        LazyColumn(state = listState, modifier = Modifier.fillMaxWidth().heightIn(max = 360.dp).padding(6.dp)) {
            itemsIndexed(rows) { index, row ->
                val group = when (row) {
                    is PaletteRow.Command -> row.command.group
                    is PaletteRow.Note -> if (notesOnly && query.isBlank()) "Zuletzt geöffnet" else "Notizen"
                }
                val previous = rows.getOrNull(index - 1)
                val previousGroup = when (previous) {
                    is PaletteRow.Command -> previous.command.group
                    is PaletteRow.Note -> if (notesOnly && query.isBlank()) "Zuletzt geöffnet" else "Notizen"
                    null -> null
                }
                val note = row as? PaletteRow.Note
                val active = note != null && note.path == activePath
                val mark = if (note == null) "" else ch.fasrv.fanotes.desk.paletteNoteMark(active, index == selected)
                Column(Modifier.fillMaxWidth()) {
                    if (group != previousGroup) {
                        Text(
                            group.uppercase(java.util.Locale.GERMAN),
                            fontWeight = FontWeight.Bold,
                            fontSize = 12.sp,
                            letterSpacing = ch.fasrv.fanotes.desk.PALETTE_GROUP_TRACKING.em,
                            color = LocalStatusInk.current.muted,
                            modifier = Modifier.padding(start = 9.dp, top = 8.dp, end = 9.dp, bottom = 4.dp),
                        )
                    }
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = (if (note != null) ch.fasrv.fanotes.desk.PALETTE_NOTE_DP else ch.fasrv.fanotes.desk.PALETTE_ROW_DP).dp)
                            .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.PALETTE_ROW_RADIUS_DP.dp))
                            .background(if (index == selected) MaterialTheme.colorScheme.surfaceVariant else androidx.compose.ui.graphics.Color.Transparent)
                            .clickable { openRow(index, false) }
                            .padding(
                                horizontal = ch.fasrv.fanotes.desk.PALETTE_ROW_PAD_X_DP.dp,
                                vertical = ch.fasrv.fanotes.desk.PALETTE_ROW_PAD_Y_DP.dp,
                            ),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(ch.fasrv.fanotes.desk.PALETTE_ROW_GAP_DP.dp),
                    ) {
                        val icon = when {
                            note != null && note.path.endsWith(".pdf", ignoreCase = true) -> Icons.Filled.PictureAsPdf
                            note != null -> Icons.Filled.Description
                            group == "Navigation" -> Icons.Filled.Search
                            group == "Werkzeuge" -> Icons.Filled.Edit
                            group == "FaNotes" -> Icons.Filled.Settings
                            else -> Icons.Filled.Folder
                        }
                        Box(
                            Modifier
                                .size(ch.fasrv.fanotes.desk.PALETTE_ICON_DP.dp)
                                .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.PALETTE_ICON_RADIUS_DP.dp))
                                .background(MaterialTheme.colorScheme.surface)
                                .border(
                                    1.dp,
                                    if (active) MaterialTheme.colorScheme.primary.copy(alpha = 0.45f) else rule,
                                    RoundedCornerShape(ch.fasrv.fanotes.desk.PALETTE_ICON_RADIUS_DP.dp),
                                ),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(icon, contentDescription = null, modifier = Modifier.size(15.dp), tint = MaterialTheme.colorScheme.primary)
                        }
                        Column(Modifier.weight(1f)) {
                            val title = when (row) {
                                is PaletteRow.Command -> row.command.label
                                is PaletteRow.Note -> row.title
                            }
                            val detail = when (row) {
                                is PaletteRow.Command -> row.command.detail
                                is PaletteRow.Note -> row.folder
                            }
                            Text(
                                title,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = if (index == selected) MaterialTheme.colorScheme.onSurface else LocalStatusInk.current.soft,
                                maxLines = 1,
                            )
                            if (detail.isNotEmpty()) {
                                Text(detail, fontSize = 12.sp, color = LocalStatusInk.current.muted, modifier = Modifier.padding(top = 2.dp), maxLines = 1)
                            }
                        }
                        val shortcut = when (row) {
                            is PaletteRow.Command -> row.command.shortcut
                            is PaletteRow.Note -> mark
                        }
                        if (shortcut.isNotEmpty()) {
                            Text(
                                shortcut,
                                fontSize = 12.sp,
                                color = LocalStatusInk.current.muted,
                                modifier = Modifier
                                    .clip(RoundedCornerShape(ch.fasrv.fanotes.desk.PALETTE_KBD_RADIUS_DP.dp))
                                    .background(MaterialTheme.colorScheme.surface)
                                    .border(1.dp, strong, RoundedCornerShape(ch.fasrv.fanotes.desk.PALETTE_KBD_RADIUS_DP.dp))
                                    .padding(horizontal = 6.dp, vertical = 3.dp),
                            )
                        }
                    }
                }
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(rule))
        Row(
            Modifier
                .fillMaxWidth()
                .height(ch.fasrv.fanotes.desk.PALETTE_FOOTER_DP.dp)
                .padding(horizontal = 13.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("↑ ↓ auswählen", fontSize = 12.sp, color = LocalStatusInk.current.muted)
            Text("Enter öffnen", fontSize = 12.sp, color = LocalStatusInk.current.muted)
            if (notesOnly || notes.isNotEmpty()) {
                Text("⇧ Enter rechts", fontSize = 12.sp, color = LocalStatusInk.current.muted)
            }
            Text("Esc schließen", fontSize = 12.sp, color = LocalStatusInk.current.muted)
        }
    }
}

private suspend fun androidx.compose.ui.input.pointer.PointerInputScope.detectDeskSwipe(
    onSwipe: (ch.fasrv.fanotes.desk.SwipeDirection) -> Unit,
) {
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        var end = down.position
        val pointer = down.id
        while (true) {
            val event = awaitPointerEvent()
            val change = event.changes.firstOrNull { it.id == pointer } ?: break
            end = change.position
            if (!change.pressed) break
        }
        val direction = ch.fasrv.fanotes.desk.swipeDirection(end.x - down.position.x, end.y - down.position.y)
            ?: return@awaitEachGesture
        onSwipe(direction)
    }
}

private sealed class PaletteRow {
    data class Command(val command: ch.fasrv.fanotes.desk.PaletteCommand) : PaletteRow()
    data class Note(val path: String, val title: String, val folder: String) : PaletteRow()
}
