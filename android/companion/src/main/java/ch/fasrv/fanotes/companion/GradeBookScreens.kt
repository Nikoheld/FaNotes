@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
package ch.fasrv.fanotes.companion

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.schulnetz.*
import java.time.LocalDate
import java.util.UUID

@Composable
fun SchoolMarkRow(
    mark: WeightedMark,
    decimals: Int,
    hidden: Boolean,
    highlighted: Boolean,
    longPressReveal: Boolean,
    onReveal: () -> Unit,
    onAdjust: () -> Unit,
    onRestore: () -> Unit,
) {
    val haptic = LocalHapticFeedback.current
    val reveal = {
        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
        onReveal()
    }
    val gesture = when {
        hidden && longPressReveal -> Modifier.combinedClickable(role = Role.Button, onClick = {}, onLongClick = reveal)
        hidden -> Modifier.combinedClickable(role = Role.Button, onClick = reveal, onLongClick = reveal)
        else -> Modifier.clickable(role = Role.Button, onClick = onAdjust)
    }
    val spoken = "${mark.label.ifBlank { "School mark" }}. ${hiddenMarkHint(longPressReveal)}"
    Row(
        Modifier.fillMaxWidth().background(if (highlighted) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.background, MaterialTheme.shapes.small).then(gesture).then(if (hidden) Modifier.semantics { contentDescription = spoken } else Modifier).padding(vertical = 14.dp, horizontal = if (highlighted) 12.dp else 0.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(mark.label.ifBlank { "School mark" }, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                when {
                    hidden -> hiddenMarkHint(longPressReveal)
                    mark.excluded -> "Excluded · school mark ${formatMark(mark.displayMark, decimals)} · weight ${formatMark(mark.displayWeight)}"
                    mark.adjusted -> "Adjusted · school ${formatMark(mark.displayMark, decimals)} · weight ${formatMark(mark.displayWeight)}"
                    else -> "Weight ${formatMark(mark.weight)}"
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if ((mark.adjusted || mark.excluded) && !hidden) TextButton(onClick = onRestore) { Text("Restore") }
        Text(if (hidden) "?" else formatMark(mark.mark, decimals), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
    }
    FineDivider()
}

@Composable
fun OwnMarkRow(grade: OwnGrade, decimals: Int, onEdit: () -> Unit, onDelete: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onEdit).padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(grade.title.ifBlank { "Own mark" }, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Tag("Own")
            }
            Text("${formatGradeDate(grade.date)} · weight ${formatMark(grade.weight)} · tap to edit", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(formatMark(grade.mark, decimals), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 8.dp))
        ActionIcon(Icons.Outlined.Close, "Delete own mark ${grade.title}", onClick = onDelete)
    }
    FineDivider()
}

@Composable
fun CollectiveMarkRow(grade: CollectiveGrade, decimals: Int, onEdit: () -> Unit, onDelete: () -> Unit) {
    val value = collectiveValue(grade.parts)
    Column(Modifier.fillMaxWidth().clickable(onClick = onEdit).padding(vertical = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(grade.title, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Tag("Own")
                }
                Text(
                    if (value == null) "Add at least two partial tests before this counts" else "Sammelnote · ${formatGradeDate(grade.date)} · counts as one mark · weight ${formatMark(grade.weight)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(formatMark(value, decimals), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 8.dp))
            ActionIcon(Icons.Outlined.Close, "Delete collective grade ${grade.title}", onClick = onDelete)
        }
        grade.parts.forEach { part ->
            Text("${part.title.ifBlank { "Partial test" }} · ${formatMark(part.mark, decimals)} · weight ${formatMark(part.weight)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp, start = 8.dp))
        }
    }
    FineDivider()
}

@Composable
fun ArchivedSubjectsScreen(model: CompanionModel) {
    val courses = remember(model.snapshot.grades, model.gradeBook, model.unrevealedIds, model.settings.guessGrades) {
        courseSummaries(model.snapshot.grades, hiddenTargetIds = model.hiddenGradeIds(), book = model.gradeBook).filter { it.archived }
    }
    ScreenList {
        item {
            Text("Archived subjects", style = MaterialTheme.typography.headlineMedium)
            Text("Hidden from your list, overall average and promotion points. School marks stay on record.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, bottom = 12.dp))
        }
        if (courses.isEmpty()) item { EmptyState(Icons.Outlined.Archive, "Nothing archived", "Archive a finished subject from its page. You can restore it here.") }
        items(courses, key = { it.courseId }) { course ->
            Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { model.focusCourseId = course.courseId; model.navigate(Page.Course) }.padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(courseAlias(course.label, model.desk.courseAliases), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(formatMark(course.average, model.desk.gradeDecimals), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                TextButton(onClick = { model.restoreCourse(course.courseId) }) { Text("Restore") }
                Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            FineDivider()
        }
    }
}

@Composable
fun OwnGradeDialog(courseId: String, existing: OwnGrade?, onDismiss: () -> Unit, onSave: (OwnGrade) -> Unit) {
    var title by rememberSaveable { mutableStateOf(existing?.title.orEmpty()) }
    var mark by rememberSaveable { mutableStateOf(existing?.mark?.let { formatMark(it, 3) }.orEmpty()) }
    var weight by rememberSaveable { mutableStateOf(existing?.weight?.let { formatMark(it, 3) } ?: "1") }
    var date by rememberSaveable { mutableStateOf(existing?.date?.ifBlank { LocalDate.now().toString() } ?: LocalDate.now().toString()) }
    val number = mark.replace(',', '.').toDoubleOrNull()
    val factor = weight.replace(',', '.').toDoubleOrNull()
    val iso = parseGradeDate(date)
    val ready = number != null && number.isFinite() && number in 1.0..6.0 && factor != null && factor.isFinite() && factor > 0.0 && iso != null
    AlertDialog(onDismissRequest = onDismiss, modifier = Modifier.imePadding(), title = { Text(if (existing == null) "Add your mark" else "Edit your mark") }, text = {
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Counted in this subject, your promotion points and the target calculator. Marked as your own.", style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(title, { title = it }, label = { Text("Name") }, singleLine = true)
            OutlinedTextField(mark, { mark = it }, label = { Text("Mark · 1 to 6") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            OutlinedTextField(weight, { weight = it }, label = { Text("Weight") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            OutlinedTextField(date, { date = it }, label = { Text("Date") }, singleLine = true, supportingText = { Text("4.11.2026 or 2026-11-04") })
        }
    }, confirmButton = {
        TextButton(onClick = {
            onSave(OwnGrade(existing?.id ?: UUID.randomUUID().toString(), courseId, title.trim().ifBlank { "Own mark" }, number!!, factor!!, iso!!))
        }, enabled = ready) { Text("Save") }
    }, dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

private data class PartDraft(val id: String, val title: String, val mark: String, val weight: String)

@Composable
fun CollectiveGradeDialog(courseId: String, existing: CollectiveGrade?, onDismiss: () -> Unit, onSave: (CollectiveGrade) -> Unit) {
    var title by rememberSaveable { mutableStateOf(existing?.title.orEmpty()) }
    var weight by rememberSaveable { mutableStateOf(existing?.weight?.let { formatMark(it, 3) } ?: "1") }
    var date by rememberSaveable { mutableStateOf(existing?.date?.ifBlank { LocalDate.now().toString() } ?: LocalDate.now().toString()) }
    val drafts = remember {
        mutableStateListOf<PartDraft>().apply {
            val seed = existing?.parts?.takeIf { it.isNotEmpty() }
            if (seed == null) {
                add(PartDraft(UUID.randomUUID().toString(), "", "", "1"))
                add(PartDraft(UUID.randomUUID().toString(), "", "", "1"))
            } else {
                seed.forEach { add(PartDraft(it.id.ifBlank { UUID.randomUUID().toString() }, it.title, formatMark(it.mark, 3), formatMark(it.weight, 3))) }
            }
        }
    }
    val parts = drafts.mapNotNull { draft ->
        val mark = draft.mark.replace(',', '.').toDoubleOrNull()
        val factor = draft.weight.replace(',', '.').toDoubleOrNull()
        if (mark == null || mark !in 1.0..6.0 || factor == null || factor <= 0.0) null else CollectivePart(draft.id, draft.title.trim().ifBlank { "Partial test" }, mark, factor)
    }
    val factor = weight.replace(',', '.').toDoubleOrNull()
    val iso = parseGradeDate(date)
    val ready = title.isNotBlank() && parts.size >= 2 && parts.size == drafts.size && factor != null && factor > 0.0 && iso != null
    AlertDialog(onDismissRequest = onDismiss, modifier = Modifier.imePadding(), title = { Text(if (existing == null) "Collective grade" else "Edit collective grade") }, text = {
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Partial tests combine into one Sammelnote. Only that mark counts in the subject.", style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(title, { title = it }, label = { Text("Name") }, singleLine = true)
            OutlinedTextField(date, { date = it }, label = { Text("Date") }, singleLine = true)
            OutlinedTextField(weight, { weight = it }, label = { Text("Weight in the subject") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            drafts.forEachIndexed { index, draft ->
                Text("Partial test ${index + 1}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(draft.title, { drafts[index] = draft.copy(title = it) }, label = { Text("Name") }, singleLine = true)
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(draft.mark, { drafts[index] = draft.copy(mark = it) }, label = { Text("Mark") }, modifier = Modifier.weight(1f), singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                    OutlinedTextField(draft.weight, { drafts[index] = draft.copy(weight = it) }, label = { Text("Weight") }, modifier = Modifier.weight(1f), singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                }
                if (drafts.size > 2) TextButton(onClick = { drafts.removeAt(index) }) { Text("Remove partial test") }
            }
            TextButton(onClick = { drafts.add(PartDraft(UUID.randomUUID().toString(), "", "", "1")) }) { Text("Add partial test") }
            val value = collectiveValue(parts)
            if (value != null) Text("Counts as ${formatMark(value)}", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary)
        }
    }, confirmButton = {
        TextButton(onClick = {
            onSave(CollectiveGrade(existing?.id ?: UUID.randomUUID().toString(), courseId, title.trim(), iso!!, factor!!, parts))
        }, enabled = ready) { Text("Save") }
    }, dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

@Composable
fun GradeAdjustmentDialog(mark: WeightedMark, decimals: Int, existing: GradeAdjustment?, onDismiss: () -> Unit, onSave: (GradeAdjustment) -> Unit, onRestore: () -> Unit) {
    var overrideMark by rememberSaveable { mutableStateOf(existing?.mark?.let { formatMark(it, 3) }.orEmpty()) }
    var overrideWeight by rememberSaveable { mutableStateOf(existing?.weight?.let { formatMark(it, 3) }.orEmpty()) }
    var excluded by rememberSaveable { mutableStateOf(existing?.excluded == true) }
    val parsedMark = overrideMark.replace(',', '.').toDoubleOrNull()
    val parsedWeight = overrideWeight.replace(',', '.').toDoubleOrNull()
    val markOk = overrideMark.isBlank() || (parsedMark != null && parsedMark in 1.0..6.0)
    val weightOk = overrideWeight.isBlank() || (parsedWeight != null && parsedWeight > 0.0)
    AlertDialog(onDismissRequest = onDismiss, modifier = Modifier.imePadding(), title = { Text(mark.label.ifBlank { "School mark" }, maxLines = 2, overflow = TextOverflow.Ellipsis) }, text = {
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("School mark ${formatMark(mark.displayMark, decimals)} · weight ${formatMark(mark.displayWeight)}. The original stays visible. This changes only your averages.", style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(overrideMark, { overrideMark = it }, label = { Text("Your mark") }, placeholder = { Text(formatMark(mark.displayMark, decimals)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            OutlinedTextField(overrideWeight, { overrideWeight = it }, label = { Text("Your weight") }, placeholder = { Text(formatMark(mark.displayWeight)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            ToggleRow("Exclude from your average", "The school mark stays on this page.", excluded) { excluded = it }
            if (existing != null) TextButton(onClick = onRestore) { Text("Restore school mark") }
        }
    }, confirmButton = {
        TextButton(onClick = {
            onSave(GradeAdjustment(mark.targetId, if (overrideMark.isBlank()) null else parsedMark, if (overrideWeight.isBlank()) null else parsedWeight, excluded))
        }, enabled = markOk && weightOk && mark.targetId.isNotBlank()) { Text("Save") }
    }, dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}
