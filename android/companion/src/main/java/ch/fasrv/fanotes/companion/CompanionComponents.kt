@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ch.fasrv.fanotes.companion

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Assignment
import androidx.compose.material.icons.automirrored.filled.ReceiptLong
import androidx.compose.material.icons.automirrored.outlined.Assignment
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.filled.AutoStories
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.EventBusy
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Insights
import androidx.compose.material.icons.filled.School
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Today
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

fun navBarIcon(id: String, selected: Boolean = false): ImageVector = when (id) {
    "planner" -> if (selected) Icons.Filled.DateRange else Icons.Outlined.DateRange
    "tasks" -> if (selected) Icons.Filled.CheckCircle else Icons.Outlined.CheckCircleOutline
    "notes" -> if (selected) Icons.Filled.AutoStories else Icons.Outlined.AutoStories
    "school" -> if (selected) Icons.Filled.School else Icons.Outlined.School
    "grades" -> if (selected) Icons.Filled.Insights else Icons.Outlined.Insights
    "exams" -> if (selected) Icons.AutoMirrored.Filled.Assignment else Icons.AutoMirrored.Outlined.Assignment
    "absences" -> if (selected) Icons.Filled.EventBusy else Icons.Outlined.EventBusy
    "updates" -> if (selected) Icons.Filled.Forum else Icons.Outlined.Forum
    "statement" -> if (selected) Icons.AutoMirrored.Filled.ReceiptLong else Icons.AutoMirrored.Outlined.ReceiptLong
    "settings" -> if (selected) Icons.Filled.Settings else Icons.Outlined.Settings
    else -> if (selected) Icons.Filled.Today else Icons.Outlined.Today
}

/** Tone for empty, error and notice surfaces. */
enum class StateTone { Neutral, Accent, Warning, Error, Offline }

@Composable
fun toneColors(tone: StateTone): Pair<Color, Color> {
    val s = LocalCompanionSemantics.current
    val scheme = MaterialTheme.colorScheme
    return when (tone) {
        StateTone.Neutral, StateTone.Offline -> s.sunken to scheme.onSurfaceVariant
        StateTone.Accent -> scheme.primaryContainer to scheme.primary
        StateTone.Warning -> s.warningSoft to s.warning
        StateTone.Error -> s.dangerSoft to scheme.error
    }
}

@Composable
fun ActionIcon(icon: ImageVector, label: String, enabled: Boolean = true, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)) {
        Icon(icon, contentDescription = label, modifier = Modifier.size(22.dp))
    }
}

val LocalPageBottomPadding = staticCompositionLocalOf { 24.dp }

/** True inside a [Group]; rows then add their own horizontal inset. */
val LocalInGroup = staticCompositionLocalOf { false }

/** Nav-bar plus IME so sheet content can scroll above the keyboard. */
@Composable
fun Modifier.sheetKeyboardPadding(): Modifier = windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))

@Composable
fun ScreenList(modifier: Modifier = Modifier, state: LazyListState = rememberLazyListState(), content: LazyListScope.() -> Unit) {
    LazyColumn(state = state, modifier = modifier.fillMaxSize().imePadding(), contentPadding = PaddingValues(start = Space.page, end = Space.page, top = 4.dp, bottom = LocalPageBottomPadding.current), content = content)
}

/** A rounded surface that holds related rows. Rows inside get a 16 dp inset and inset dividers. */
@Composable
fun Group(modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.surface, content: @Composable ColumnScope.() -> Unit) {
    Surface(color = color, shape = MaterialTheme.shapes.large, modifier = modifier.fillMaxWidth()) {
        CompositionLocalProvider(LocalInGroup provides true) { Column(content = content) }
    }
}

/** Shape for one item of a group that is split across lazy items. */
fun groupShape(index: Int, count: Int, radius: Dp = 22.dp): Shape = when {
    count <= 1 -> RoundedCornerShape(radius)
    index == 0 -> RoundedCornerShape(topStart = radius, topEnd = radius)
    index == count - 1 -> RoundedCornerShape(bottomStart = radius, bottomEnd = radius)
    else -> RectangleShape
}

/** Draws one lazy item as part of a rounded group surface. */
@Composable
fun GroupItem(index: Int, count: Int, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().clip(groupShape(index, count)).background(MaterialTheme.colorScheme.surface)) {
        CompositionLocalProvider(LocalInGroup provides true) {
            content()
            if (index < count - 1) FineDivider()
        }
    }
}

@Composable
fun SectionLabel(title: String, action: String? = null, count: Int? = null, tone: Color? = null, onAction: () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().padding(top = 22.dp, bottom = 6.dp).heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = MaterialTheme.typography.titleMedium, color = tone ?: MaterialTheme.colorScheme.onBackground,
                maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false).semantics { heading() })
            if (count != null) Text(count.toString(), style = TimeSmallStyle, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
        }
        if (action != null) TextButton(onClick = onAction, contentPadding = PaddingValues(horizontal = 10.dp)) {
            Text(action, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** Large heading that opens a sub-screen, below the top bar. */
@Composable
fun PageIntro(title: String, subtitle: String = "", detail: String = "") {
    Column(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 12.dp)) {
        Text(title, style = MaterialTheme.typography.headlineMedium, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() })
        if (subtitle.isNotBlank()) Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
        if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
    }
}

@Composable
fun IconTile(icon: ImageVector, tone: StateTone = StateTone.Neutral, size: Dp = 36.dp) {
    val (container, content) = toneColors(tone)
    Box(Modifier.size(size).background(container, RoundedCornerShape(size * 0.3f)), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = content, modifier = Modifier.size(size * 0.56f))
    }
}

@Composable
fun EmptyState(icon: ImageVector, title: String, body: String, action: String? = null, tone: StateTone = StateTone.Neutral, onAction: () -> Unit = {}) {
    Column(Modifier.fillMaxWidth().padding(vertical = Space.xxl, horizontal = Space.sm), horizontalAlignment = Alignment.CenterHorizontally) {
        IconTile(icon, tone, 56.dp)
        Spacer(Modifier.height(Space.lg))
        Text(title, style = MaterialTheme.typography.titleLarge, maxLines = 3, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 340.dp))
        Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center, modifier = Modifier.padding(top = 6.dp).widthIn(max = 340.dp))
        if (action != null) SecondaryButton(action, onAction, Modifier.padding(top = Space.lg))
    }
}

@Composable
fun LoadingState(label: String = t(R.string.loading)) {
    Column(Modifier.fillMaxSize().padding(Space.xl), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.5.dp)
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = Space.lg))
    }
}

/** Static placeholder rows while a list loads. No shimmer, so it costs nothing per frame. */
@Composable
fun SkeletonRows(count: Int = 3, label: String = t(R.string.loading)) {
    val block = LocalCompanionSemantics.current.sunken
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp).semantics { contentDescription = label }) {
        repeat(count) { index ->
            Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(40.dp).background(block, MaterialTheme.shapes.small))
                Column(Modifier.padding(start = 14.dp).weight(1f)) {
                    Box(Modifier.fillMaxWidth(if (index % 2 == 0) 0.7f else 0.55f).height(14.dp).background(block, CircleShape))
                    Spacer(Modifier.height(8.dp))
                    Box(Modifier.fillMaxWidth(0.4f).height(10.dp).background(block, CircleShape))
                }
            }
        }
    }
}

@Composable
fun InfoBanner(title: String, body: String, action: String? = null, error: Boolean = false, tone: StateTone? = null, onAction: () -> Unit = {}) {
    val shown = tone ?: if (error) StateTone.Error else StateTone.Accent
    val (container, content) = toneColors(shown)
    Surface(color = container, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 12.dp, top = 14.dp, bottom = if (action == null) 14.dp else 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(when (shown) {
                StateTone.Error -> Icons.Outlined.ErrorOutline
                StateTone.Warning -> Icons.Outlined.ReportProblem
                StateTone.Offline -> Icons.Outlined.CloudOff
                else -> Icons.Outlined.Info
            }, null, modifier = Modifier.padding(top = 1.dp).size(20.dp), tint = content)
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurface)
                if (body.isNotBlank()) Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp))
                if (action != null) TextButton(onClick = onAction, contentPadding = PaddingValues(horizontal = 0.dp, vertical = 8.dp)) {
                    Text(action, style = MaterialTheme.typography.labelLarge, color = if (shown == StateTone.Error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
                }
            }
        }
    }
}

/** One quiet line with a status dot: freshness, offline or connection state. */
@Composable
fun StatusLine(text: String, tone: StateTone = StateTone.Neutral, modifier: Modifier = Modifier) {
    val dot = when (tone) {
        StateTone.Warning -> LocalCompanionSemantics.current.warning
        StateTone.Error -> MaterialTheme.colorScheme.error
        StateTone.Accent -> LocalCompanionSemantics.current.success
        else -> MaterialTheme.colorScheme.outline
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        if (tone == StateTone.Offline) Icon(Icons.Outlined.CloudOff, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        else Box(Modifier.size(7.dp).background(dot, CircleShape))
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 7.dp))
    }
}

@Composable
fun SearchField(query: String, onQuery: (String) -> Unit, hint: String, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    BasicTextField(
        value = query,
        onValueChange = onQuery,
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = scheme.onSurface),
        cursorBrush = SolidColor(scheme.primary),
        modifier = modifier.fillMaxWidth().semantics { if (query.isEmpty()) contentDescription = hint },
        decorationBox = { field ->
            Row(Modifier.fillMaxWidth().heightIn(min = 50.dp).background(LocalCompanionSemantics.current.sunken, CircleShape).padding(start = 16.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Search, null, Modifier.size(20.dp), tint = scheme.onSurfaceVariant)
                Box(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                    if (query.isEmpty()) Text(hint, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    field()
                }
                if (query.isNotEmpty()) ActionIcon(Icons.Outlined.Close, t(R.string.clear_search)) { onQuery("") }
            }
        },
    )
}

/** Single choice as ink pills. Selected pills invert and carry a check, so state never relies on colour. */
@Composable
fun ChoiceRow(choices: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).selectableGroup(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        choices.forEach { (id, label) -> Pill(label, selected == id) { onSelect(id) } }
    }
}

@Composable
fun Pill(label: String, selected: Boolean, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val motion = LocalKantiMotion.current
    val container by animateColorAsState(if (selected) scheme.onSurface else LocalCompanionSemantics.current.sunken, motion.spec(motion.short), label = "pill")
    val content = if (selected) scheme.surface else scheme.onSurface
    Box(Modifier.heightIn(min = 48.dp).selectable(selected, onClick = onClick, role = Role.RadioButton), contentAlignment = Alignment.Center) {
        Row(Modifier.heightIn(min = 36.dp).background(container, CircleShape).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            if (selected) { Icon(Icons.Outlined.Check, null, Modifier.size(16.dp), tint = content); Spacer(Modifier.width(6.dp)) }
            Text(label, style = MaterialTheme.typography.labelLarge, color = content, maxLines = 1)
        }
    }
}

/** Two or three modes of one screen, such as Stundenplan and Aufgaben. */
@Composable
fun SegmentedTabs(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val motion = LocalKantiMotion.current
    Row(modifier.fillMaxWidth().heightIn(min = 48.dp).background(LocalCompanionSemantics.current.sunken, CircleShape).padding(horizontal = 2.dp).selectableGroup(), verticalAlignment = Alignment.CenterVertically) {
        options.forEach { (id, label) ->
            val chosen = id == selected
            val container by animateColorAsState(if (chosen) scheme.surface else Color.Transparent, motion.spec(motion.short), label = "segment")
            Box(Modifier.weight(1f).heightIn(min = 48.dp).selectable(chosen, onClick = { onSelect(id) }, role = Role.Tab).padding(vertical = 4.dp, horizontal = 2.dp)
                .background(container, CircleShape), contentAlignment = Alignment.Center) {
                Text(label, style = MaterialTheme.typography.labelLarge, color = if (chosen) scheme.onSurface else scheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 8.dp, vertical = 8.dp))
            }
        }
    }
}

@Composable
fun SettingRow(icon: ImageVector?, title: String, subtitle: String = "", trailing: String = "", tone: StateTone = StateTone.Neutral, trailingColor: Color? = null, chevron: Boolean = true, onClick: () -> Unit) {
    val inset = if (LocalInGroup.current) 16.dp else 0.dp
    Row(Modifier.fillMaxWidth().heightIn(min = Space.row).clickable(role = Role.Button, onClick = onClick).padding(horizontal = inset, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        if (icon != null) IconTile(icon, tone)
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (subtitle.isNotBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        if (trailing.isNotBlank()) Text(trailing, style = MaterialTheme.typography.labelLarge, color = trailingColor ?: MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        if (chevron) Icon(Icons.Outlined.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
    }
}

@Composable
fun ToggleRow(title: String, subtitle: String = "", checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    val inset = if (LocalInGroup.current) 16.dp else 0.dp
    Row(Modifier.fillMaxWidth().heightIn(min = Space.row).toggleable(checked, enabled = enabled, role = Role.Switch, onValueChange = onChange).padding(horizontal = inset, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
            if (subtitle.isNotBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp))
        }
        Switch(checked, onCheckedChange = null, enabled = enabled)
    }
}

@Composable
fun FineDivider(startInset: Dp? = null) {
    val start = startInset ?: if (LocalInGroup.current) 16.dp else 0.dp
    HorizontalDivider(Modifier.padding(start = start), color = LocalCompanionSemantics.current.hairline)
}

@Composable
fun Tag(text: String, color: Color = MaterialTheme.colorScheme.primary) {
    val alpha = if (LocalCompanionSemantics.current.dark) 0.2f else 0.12f
    Text(text, style = MaterialTheme.typography.labelSmall, color = color, maxLines = 1,
        modifier = Modifier.background(color.copy(alpha = alpha), MaterialTheme.shapes.extraSmall).padding(horizontal = 8.dp, vertical = 3.dp))
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, icon: ImageVector? = null) {
    Button(onClick = onClick, enabled = enabled, shape = MaterialTheme.shapes.medium, modifier = modifier.heightIn(min = Space.button),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp)) {
        if (icon != null) { Icon(icon, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)) }
        Text(text, style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
    }
}

@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, icon: ImageVector? = null, danger: Boolean = false) {
    FilledTonalButton(onClick = onClick, enabled = enabled, shape = MaterialTheme.shapes.medium, modifier = modifier.heightIn(min = Space.button),
        colors = ButtonDefaults.filledTonalButtonColors(containerColor = LocalCompanionSemantics.current.sunken,
            contentColor = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp)) {
        if (icon != null) { Icon(icon, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)) }
        Text(text, style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
    }
}

/** A labelled number: averages, points, counts. */
@Composable
fun MetricBlock(label: String, value: String, modifier: Modifier = Modifier, valueColor: Color = MaterialTheme.colorScheme.onSurface, large: Boolean = false) {
    Column(modifier) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
        Text(value, style = if (large) MaterialTheme.typography.displayMedium else MaterialTheme.typography.displaySmall, color = valueColor, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
fun SubjectBar(color: Color, height: Dp = 36.dp) {
    Box(Modifier.width(4.dp).height(height).background(color, CircleShape))
}

@Composable
fun ColorChoices(colors: List<String>, selected: String, enabled: Boolean = true, onSelect: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).selectableGroup(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        colors.forEach { color ->
            val chosen = selected.equals(color, ignoreCase = true)
            val swatch = paletteColor(color)
            Box(Modifier.size(52.dp).clip(CircleShape).selectable(chosen, enabled = enabled, role = Role.RadioButton, onClick = { onSelect(color) })
                .semantics { contentDescription = t(R.string.text_3, colorName(color), if (chosen) t(R.string.selected_suffix) else "") }, contentAlignment = Alignment.Center) {
                Box(Modifier.size(40.dp)
                    .then(if (chosen) Modifier.border(2.dp, MaterialTheme.colorScheme.onSurface, CircleShape) else Modifier)
                    .padding(if (chosen) 4.dp else 2.dp).background(if (enabled) swatch else swatch.copy(alpha = 0.35f), CircleShape), contentAlignment = Alignment.Center) {
                    if (chosen) Icon(Icons.Outlined.Check, null, tint = if (relativeLuminance(parseHexColor(color) ?: 0) > 0.4) Color.Black else Color.White, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}

@Composable
fun ConfirmDialog(title: String, body: String, confirm: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val haptic = LocalHapticFeedback.current
    AlertDialog(onDismissRequest = onDismiss, shape = MaterialTheme.shapes.extraLarge,
        title = { Text(title, style = MaterialTheme.typography.headlineSmall, maxLines = 3, overflow = TextOverflow.Ellipsis) },
        text = { Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) },
        confirmButton = { TextButton(onClick = { haptic.performHapticFeedback(HapticFeedbackType.LongPress); onConfirm() }) { Text(confirm, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelLarge) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(t(R.string.cancel), style = MaterialTheme.typography.labelLarge) } })
}

@Composable
fun SheetTitle(title: String, onClose: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.headlineSmall, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).semantics { heading() })
        ActionIcon(Icons.Outlined.Close, t(R.string.close)) { onClose() }
    }
}

/** Bottom sheet frame shared by every sheet: raised surface, generous radius, keyboard-safe. */
@Composable
fun KantiSheet(onDismiss: () -> Unit, full: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = full),
        containerColor = LocalCompanionSemantics.current.raised,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
    ) {
        Column(Modifier.fillMaxWidth().then(if (full) Modifier.fillMaxHeight(0.92f) else Modifier).sheetKeyboardPadding().padding(horizontal = Space.page).padding(bottom = if (full) 0.dp else Space.xl), content = content)
    }
}

fun colorName(color: String): String = when (color.lowercase()) {
    "#202333" -> t(R.string.color_ink); "#2a6f97" -> t(R.string.color_ocean); "#7f6df2" -> t(R.string.color_violet); "#3d8bfd" -> t(R.string.color_blue)
    "#2f9e6b", "#0f7b6c" -> t(R.string.color_green); "#e0ac39" -> t(R.string.color_gold); "#e15b64", "#c4554d" -> t(R.string.color_coral)
    "#d06ad6" -> t(R.string.color_orchid); else -> t(R.string.color_hex, color)
}
