package ch.fasrv.fanotes

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ch.fasrv.fanotes.desk.ChromeText

/**
 * Building blocks of the study editors for the tablet: every control is at least 48 dp so a finger or a pen tip hits
 * it, and letters are entered with an on-screen pad instead of the keyboard (the pad works the same with a pen).
 */

internal val TouchTarget: Dp = 48.dp

internal fun ui(text: String) = ChromeText.ui(text)

internal val OkGreen = Color(0xFF2E7D32)

/** A single choice of a group (mode, direction, language); the selected one is filled. */
@Composable
internal fun StudyChoice(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        shape = RoundedCornerShape(24.dp),
        color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface,
        border = BorderStroke(if (selected) 2.dp else 1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline),
        modifier = modifier.heightIn(min = TouchTarget).clickable(role = Role.RadioButton, onClick = onClick),
    ) {
        Box(Modifier.padding(horizontal = 16.dp).heightIn(min = TouchTarget), contentAlignment = Alignment.Center) {
            Text(label, fontSize = 14.sp, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal)
        }
    }
}

/** A button with a 48 dp high touch target. */
@Composable
internal fun ActionButton(label: String, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, enabled = enabled, modifier = modifier.defaultMinSize(minWidth = TouchTarget, minHeight = TouchTarget)) {
        Text(label, fontSize = 14.sp)
    }
}

@Composable
internal fun Muted(text: String, modifier: Modifier = Modifier) {
    Text(text, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f), modifier = modifier.padding(vertical = 4.dp))
}

@Composable
internal fun ErrorText(text: String) {
    Text(text, fontSize = 13.sp, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 4.dp))
}

@Composable
internal fun SectionTitle(text: String) {
    Text(text, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, modifier = Modifier.padding(top = 14.dp, bottom = 4.dp))
}

enum class CellVerdict { OK, BAD, OPEN }

/** One cell of a strip or table the student fills in: tap to select it, then use the pad. */
@Composable
internal fun PadCell(
    text: String,
    verdict: CellVerdict = CellVerdict.OPEN,
    selected: Boolean = false,
    width: Dp = TouchTarget,
    description: String = "",
    onClick: () -> Unit,
) {
    val color = when {
        verdict == CellVerdict.OK -> OkGreen
        verdict == CellVerdict.BAD -> MaterialTheme.colorScheme.error
        selected -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.outline
    }
    Box(
        Modifier
            .padding(1.dp)
            .size(width = width, height = TouchTarget)
            .border(BorderStroke(if (selected || verdict != CellVerdict.OPEN) 2.dp else 1.dp, color), RoundedCornerShape(6.dp))
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, fontFamily = FontFamily.Monospace, color = color, textAlign = TextAlign.Center)
        if (verdict != CellVerdict.OPEN) {
            Text(if (verdict == CellVerdict.OK) "✓" else "✗", fontSize = 10.sp, color = color, modifier = Modifier.align(Alignment.TopEnd).padding(end = 3.dp))
        }
    }
}

/** On-screen keys for letters or bits. [dim] keys stay usable; they only look used. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun Pad(keys: String, dim: Set<Char> = emptySet(), onKey: (Char) -> Unit, onClear: () -> Unit) {
    FlowRow(Modifier.padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        keys.forEach { key ->
            Surface(
                shape = RoundedCornerShape(8.dp),
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = if (key in dim) 0.35f else 1f),
                modifier = Modifier.size(TouchTarget).clickable(role = Role.Button) { onKey(key) },
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(key.toString(), fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (key in dim) 0.45f else 1f))
                }
            }
        }
        Surface(
            shape = RoundedCornerShape(8.dp),
            color = MaterialTheme.colorScheme.errorContainer,
            modifier = Modifier.size(width = 72.dp, height = TouchTarget).clickable(role = Role.Button, onClick = onClear),
        ) {
            Box(contentAlignment = Alignment.Center) { Text("⌫", fontSize = 18.sp) }
        }
    }
}

/**
 * A text field of an editor. The editors keep their model in state that is updated synchronously when a key is typed,
 * so the field is simply controlled by [value]; [key] only tells fields apart for accessibility and recycling.
 */
@Composable
internal fun SyncField(
    key: String,
    value: String,
    label: String,
    modifier: Modifier = Modifier,
    numeric: Boolean = false,
    mono: Boolean = false,
    minLines: Int = 1,
    maxChars: Int = Int.MAX_VALUE,
    onChange: (String) -> Unit,
) {
    androidx.compose.runtime.key(key) {
        OutlinedTextField(
            value = value,
            onValueChange = { onChange(it.take(maxChars)) },
            label = if (label.isEmpty()) null else ({ Text(label) }),
            modifier = modifier.defaultMinSize(minHeight = TouchTarget),
            singleLine = minLines <= 1,
            minLines = minLines,
            textStyle = if (mono) TextStyle(fontFamily = FontFamily.Monospace, fontSize = 16.sp) else TextStyle(fontSize = 16.sp),
            keyboardOptions = if (numeric) KeyboardOptions(keyboardType = KeyboardType.Number) else KeyboardOptions.Default,
        )
    }
}

/** A spacer row height used between editor sections. */
@Composable
internal fun Gap(size: Dp = 8.dp) = androidx.compose.foundation.layout.Spacer(Modifier.height(size).width(size))
