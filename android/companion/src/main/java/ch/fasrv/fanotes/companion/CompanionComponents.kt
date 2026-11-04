@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ch.fasrv.fanotes.companion

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Assignment
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

fun navBarIcon(id: String): ImageVector = when (id) {
    "planner" -> Icons.Outlined.DateRange
    "tasks" -> Icons.Outlined.CheckCircleOutline
    "notes" -> Icons.Outlined.AutoStories
    "school" -> Icons.Outlined.School
    "grades" -> Icons.Outlined.Insights
    "exams" -> Icons.AutoMirrored.Outlined.Assignment
    "absences" -> Icons.Outlined.EventBusy
    "updates" -> Icons.Outlined.Forum
    "statement" -> Icons.AutoMirrored.Outlined.ReceiptLong
    "settings" -> Icons.Outlined.Settings
    else -> Icons.Outlined.Today
}

@Composable
fun ActionIcon(icon: ImageVector, label: String, enabled: Boolean = true, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)) {
        Icon(icon, contentDescription = label, modifier = Modifier.size(22.dp))
    }
}
val LocalPageBottomPadding = staticCompositionLocalOf { 24.dp }

/** Nav-bar plus IME so sheet content can scroll above the keyboard. */
@Composable
fun Modifier.sheetKeyboardPadding(): Modifier = windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))

@Composable
fun ScreenList(modifier: Modifier = Modifier, content: LazyListScope.() -> Unit) {
    LazyColumn(modifier.fillMaxSize().imePadding(), contentPadding = PaddingValues(start = Space.page, end = Space.page, top = 8.dp, bottom = LocalPageBottomPadding.current), content = content)
}
@Composable
fun SectionLabel(title: String, action: String? = null, onAction: () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().padding(top = Space.xl, bottom = Space.sm), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        if (action != null) TextButton(onClick = onAction, contentPadding = PaddingValues(horizontal = 8.dp)) { Text(action) }
    }
}
@Composable
fun EmptyState(icon: ImageVector, title: String, body: String, action: String? = null, onAction: () -> Unit = {}) {
    Column(Modifier.fillMaxWidth().padding(vertical = Space.xxl), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(56.dp).background(MaterialTheme.colorScheme.primaryContainer, MaterialTheme.shapes.large), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(26.dp))
        }
        Spacer(Modifier.height(Space.lg))
        Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 3, overflow = TextOverflow.Ellipsis, textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.widthIn(max = 320.dp))
        Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center, modifier = Modifier.padding(top = 6.dp).widthIn(max = 320.dp))
        if (action != null) TextButton(onClick = onAction, modifier = Modifier.padding(top = 8.dp)) { Text(action) }
    }
}
@Composable
fun LoadingState(label: String = "Loading…") {
    Column(Modifier.fillMaxSize().padding(Space.xl), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp)
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = Space.lg))
    }
}
@Composable
fun InfoBanner(title: String, body: String, action: String? = null, error: Boolean = false, onAction: () -> Unit = {}) {
    Surface(color = if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.medium) {
        Row(Modifier.fillMaxWidth().padding(Space.lg), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(if (error) Icons.Outlined.ErrorOutline else Icons.Outlined.Info, null, modifier = Modifier.size(20.dp), tint = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (action != null) TextButton(onClick = onAction, contentPadding = PaddingValues(top = 8.dp)) { Text(action) }
            }
        }
    }
}
@Composable
fun SearchField(query: String, onQuery: (String) -> Unit, hint: String, modifier: Modifier = Modifier) {
    OutlinedTextField(query, onQuery, modifier.fillMaxWidth().semantics { if (query.isEmpty()) contentDescription = hint }, placeholder = { Text(hint, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(20.dp)) },
        trailingIcon = { if (query.isNotEmpty()) ActionIcon(Icons.Outlined.Close, "Clear search") { onQuery("") } },
        singleLine = true, shape = MaterialTheme.shapes.medium,
        colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = MaterialTheme.colorScheme.surface, unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant),
        textStyle = MaterialTheme.typography.bodyMedium,
    )
}
@Composable
fun ChoiceRow(choices: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        choices.forEach { (id, label) -> FilterChip(selected = selected == id, onClick = { onSelect(id) }, label = { Text(label) },
            leadingIcon = if (selected == id) ({ Icon(Icons.Outlined.Check, null, Modifier.size(16.dp)) }) else null) }
    }
}
@Composable
fun SettingRow(icon: ImageVector, title: String, subtitle: String = "", trailing: String = "", onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.small).clickable(role = Role.Button, onClick = onClick).padding(vertical = 14.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(22.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (subtitle.isNotBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        if (trailing.isNotBlank()) Text(trailing, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
        Icon(Icons.Outlined.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
    }
}
@Composable
fun ToggleRow(title: String, subtitle: String = "", checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().toggleable(checked, role = Role.Switch, onValueChange = onChange).padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            if (subtitle.isNotBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Switch(checked, onCheckedChange = null)
    }
}
@Composable
fun FineDivider() { HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.65f)) }
@Composable
fun Tag(text: String, color: Color = MaterialTheme.colorScheme.primary) {
    Text(text, style = MaterialTheme.typography.labelSmall, color = color,
        modifier = Modifier.background(color.copy(alpha = 0.10f), MaterialTheme.shapes.extraSmall).padding(horizontal = 7.dp, vertical = 3.dp))
}
@Composable
fun ColorChoices(colors: List<String>, selected: String, onSelect: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        colors.forEach { color ->
            IconButton(onClick = { onSelect(color) }, modifier = Modifier.size(48.dp).semantics { contentDescription = "${colorName(color)}${if (selected == color) ", selected" else ""}" }) {
                Box(Modifier.size(30.dp).background(paletteColor(color), CircleShape)
                    .then(if (selected == color) Modifier.border(2.dp, MaterialTheme.colorScheme.onSurface, CircleShape) else Modifier), contentAlignment = Alignment.Center) {
                    if (selected == color) Icon(Icons.Outlined.Check, null, tint = if (paletteColor(color).luminanceCompat() > 0.4f) Color.Black else Color.White, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}
private fun Color.luminanceCompat() = (red * 0.2126f + green * 0.7152f + blue * 0.0722f)
@Composable
fun ConfirmDialog(title: String, body: String, confirm: String, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    val haptic = LocalHapticFeedback.current
    AlertDialog(onDismissRequest = onDismiss, title = { Text(title, maxLines = 3, overflow = TextOverflow.Ellipsis) }, text = { Text(body) },
        confirmButton = { TextButton(onClick = { haptic.performHapticFeedback(HapticFeedbackType.LongPress); onConfirm() }) { Text(confirm, color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}
@Composable
fun SheetTitle(title: String, onClose: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        ActionIcon(Icons.Outlined.Close, "Close") { onClose() }
    }
}

private fun colorName(color: String): String = when (color.lowercase()) {
    "#202333" -> "Ink"; "#2a6f97" -> "Ocean blue"; "#7f6df2" -> "Violet"; "#3d8bfd" -> "Blue"
    "#2f9e6b", "#0f7b6c" -> "Green"; "#e0ac39" -> "Gold"; "#e15b64", "#c4554d" -> "Coral"
    "#d06ad6" -> "Orchid"; else -> "Color $color"
}
