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
    val spoken = "${mark.label.ifBlank { t(R.string.school_mark) }}. ${if (longPressReveal) t(R.string.hidden_hold) else t(R.string.hidden_tap)}"
    Row(
        Modifier.fillMaxWidth().background(if (highlighted) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.background, MaterialTheme.shapes.small).then(gesture).then(if (hidden) Modifier.semantics { contentDescription = spoken } else Modifier).padding(vertical = 14.dp, horizontal = if (highlighted) 12.dp else 0.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(mark.label.ifBlank { t(R.string.school_mark) }, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                when {
                    hidden -> if (longPressReveal) t(R.string.hidden_hold) else t(R.string.hidden_tap)
                    mark.excluded -> t(R.string.excluded_school_mark_weight, uiMark(mark.displayMark, decimals), uiMark(mark.displayWeight))
                    mark.adjusted -> t(R.string.adjusted_school_weight, uiMark(mark.displayMark, decimals), uiMark(mark.displayWeight))
                    else -> t(R.string.weight, uiMark(mark.weight))
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if ((mark.adjusted || mark.excluded) && !hidden) TextButton(onClick = onRestore) { Text(t(R.string.restore)) }
        Text(if (hidden) "?" else uiMark(mark.mark, decimals), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
    }
    FineDivider()
}

@Composable
fun OwnMarkRow(grade: OwnGrade, decimals: Int, onEdit: () -> Unit, onDelete: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onEdit).padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(grade.title.ifBlank { t(R.string.own_mark) }, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Tag(t(R.string.own))
            }
            Text(t(R.string.weight_tap_to_edit, formatGradeDate(grade.date), uiMark(grade.weight)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(uiMark(grade.mark, decimals), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 8.dp))
        ActionIcon(Icons.Outlined.Close, t(R.string.delete_own_mark, grade.title), onClick = onDelete)
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
                    Tag(t(R.string.own))
                }
                Text(
                    if (value == null) t(R.string.add_at_least_two_partial_tests_before_this_count) else t(R.string.sammelnote_counts_as_one_mark_weight, formatGradeDate(grade.date), uiMark(grade.weight)),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(uiMark(value, decimals), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 8.dp))
            ActionIcon(Icons.Outlined.Close, t(R.string.delete_collective_grade, grade.title), onClick = onDelete)
        }
        grade.parts.forEach { part ->
            Text(t(R.string.weight_2, part.title.ifBlank { t(R.string.partial_test_name) }, uiMark(part.mark, decimals), uiMark(part.weight)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp, start = 8.dp))
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
            Text(t(R.string.archived_subjects), style = MaterialTheme.typography.headlineMedium)
            Text(t(R.string.hidden_from_your_list_overall_average_and_promot), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, bottom = 12.dp))
        }
        if (courses.isEmpty()) item { EmptyState(Icons.Outlined.Archive, t(R.string.nothing_archived), t(R.string.archive_a_finished_subject_from_its_page_you_can)) }
        items(courses, key = { it.courseId }) { course ->
            Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { model.focusCourseId = course.courseId; model.navigate(Page.Course) }.padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(courseAlias(course.label, model.desk.courseAliases), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(uiMark(course.average, model.desk.gradeDecimals), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                TextButton(onClick = { model.restoreCourse(course.courseId) }) { Text(t(R.string.restore)) }
                Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            FineDivider()
        }
    }
}

@Composable
fun OwnGradeDialog(courseId: String, existing: OwnGrade?, onDismiss: () -> Unit, onSave: (OwnGrade) -> Unit) {
    var title by rememberSaveable { mutableStateOf(existing?.title.orEmpty()) }
    var mark by rememberSaveable { mutableStateOf(existing?.mark?.let { uiMark(it, 3) }.orEmpty()) }
    var weight by rememberSaveable { mutableStateOf(existing?.weight?.let { uiMark(it, 3) } ?: "1") }
    var date by rememberSaveable { mutableStateOf(existing?.date?.ifBlank { LocalDate.now().toString() } ?: LocalDate.now().toString()) }
    val number = mark.replace(',', '.').toDoubleOrNull()
    val factor = weight.replace(',', '.').toDoubleOrNull()
    val iso = parseGradeDate(date)
    val ready = number != null && number.isFinite() && number in 1.0..6.0 && factor != null && factor.isFinite() && factor > 0.0 && iso != null
    AlertDialog(onDismissRequest = onDismiss, modifier = Modifier.imePadding(), title = { Text(if (existing == null) t(R.string.add_your_mark) else t(R.string.edit_your_mark)) }, text = {
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(t(R.string.counted_in_this_subject_your_promotion_points_an), style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(title, { title = it }, label = { Text(t(R.string.name)) }, singleLine = true)
            OutlinedTextField(mark, { mark = it }, label = { Text(t(R.string.mark_1_to_6)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            OutlinedTextField(weight, { weight = it }, label = { Text(t(R.string.weight_3)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            OutlinedTextField(date, { date = it }, label = { Text(t(R.string.date)) }, singleLine = true, supportingText = { Text(t(R.string.s_4_11_2026_or_2026_11_04)) })
        }
    }, confirmButton = {
        TextButton(onClick = {
            onSave(OwnGrade(existing?.id ?: UUID.randomUUID().toString(), courseId, title.trim().ifBlank { t(R.string.own_mark) }, number!!, factor!!, iso!!))
        }, enabled = ready) { Text(t(R.string.save)) }
    }, dismissButton = { TextButton(onClick = onDismiss) { Text(t(R.string.cancel)) } })
}

private data class PartDraft(val id: String, val title: String, val mark: String, val weight: String)

@Composable
fun CollectiveGradeDialog(courseId: String, existing: CollectiveGrade?, onDismiss: () -> Unit, onSave: (CollectiveGrade) -> Unit) {
    var title by rememberSaveable { mutableStateOf(existing?.title.orEmpty()) }
    var weight by rememberSaveable { mutableStateOf(existing?.weight?.let { uiMark(it, 3) } ?: "1") }
    var date by rememberSaveable { mutableStateOf(existing?.date?.ifBlank { LocalDate.now().toString() } ?: LocalDate.now().toString()) }
    val drafts = remember {
        mutableStateListOf<PartDraft>().apply {
            val seed = existing?.parts?.takeIf { it.isNotEmpty() }
            if (seed == null) {
                add(PartDraft(UUID.randomUUID().toString(), "", "", "1"))
                add(PartDraft(UUID.randomUUID().toString(), "", "", "1"))
            } else {
                seed.forEach { add(PartDraft(it.id.ifBlank { UUID.randomUUID().toString() }, it.title, uiMark(it.mark, 3), uiMark(it.weight, 3))) }
            }
        }
    }
    val parts = drafts.mapNotNull { draft ->
        val mark = draft.mark.replace(',', '.').toDoubleOrNull()
        val factor = draft.weight.replace(',', '.').toDoubleOrNull()
        if (mark == null || mark !in 1.0..6.0 || factor == null || factor <= 0.0) null else CollectivePart(draft.id, draft.title.trim().ifBlank { t(R.string.partial_test_name) }, mark, factor)
    }
    val factor = weight.replace(',', '.').toDoubleOrNull()
    val iso = parseGradeDate(date)
    val ready = title.isNotBlank() && parts.size >= 2 && parts.size == drafts.size && factor != null && factor > 0.0 && iso != null
    AlertDialog(onDismissRequest = onDismiss, modifier = Modifier.imePadding(), title = { Text(if (existing == null) t(R.string.collective_grade) else t(R.string.edit_collective_grade)) }, text = {
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(t(R.string.partial_tests_combine_into_one_sammelnote_only_t), style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(title, { title = it }, label = { Text(t(R.string.name)) }, singleLine = true)
            OutlinedTextField(date, { date = it }, label = { Text(t(R.string.date)) }, singleLine = true)
            OutlinedTextField(weight, { weight = it }, label = { Text(t(R.string.weight_in_the_subject)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            drafts.forEachIndexed { index, draft ->
                Text(t(R.string.partial_test, index + 1), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(draft.title, { drafts[index] = draft.copy(title = it) }, label = { Text(t(R.string.name)) }, singleLine = true)
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(draft.mark, { drafts[index] = draft.copy(mark = it) }, label = { Text(t(R.string.mark)) }, modifier = Modifier.weight(1f), singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                    OutlinedTextField(draft.weight, { drafts[index] = draft.copy(weight = it) }, label = { Text(t(R.string.weight_3)) }, modifier = Modifier.weight(1f), singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                }
                if (drafts.size > 2) TextButton(onClick = { drafts.removeAt(index) }) { Text(t(R.string.remove_partial_test)) }
            }
            TextButton(onClick = { drafts.add(PartDraft(UUID.randomUUID().toString(), "", "", "1")) }) { Text(t(R.string.add_partial_test)) }
            val value = collectiveValue(parts)
            if (value != null) Text(t(R.string.counts_as, uiMark(value)), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary)
        }
    }, confirmButton = {
        TextButton(onClick = {
            onSave(CollectiveGrade(existing?.id ?: UUID.randomUUID().toString(), courseId, title.trim(), iso!!, factor!!, parts))
        }, enabled = ready) { Text(t(R.string.save)) }
    }, dismissButton = { TextButton(onClick = onDismiss) { Text(t(R.string.cancel)) } })
}

@Composable
fun GradeAdjustmentDialog(mark: WeightedMark, decimals: Int, existing: GradeAdjustment?, onDismiss: () -> Unit, onSave: (GradeAdjustment) -> Unit, onRestore: () -> Unit) {
    var overrideMark by rememberSaveable { mutableStateOf(existing?.mark?.let { uiMark(it, 3) }.orEmpty()) }
    var overrideWeight by rememberSaveable { mutableStateOf(existing?.weight?.let { uiMark(it, 3) }.orEmpty()) }
    var excluded by rememberSaveable { mutableStateOf(existing?.excluded == true) }
    val parsedMark = overrideMark.replace(',', '.').toDoubleOrNull()
    val parsedWeight = overrideWeight.replace(',', '.').toDoubleOrNull()
    val markOk = overrideMark.isBlank() || (parsedMark != null && parsedMark in 1.0..6.0)
    val weightOk = overrideWeight.isBlank() || (parsedWeight != null && parsedWeight > 0.0)
    AlertDialog(onDismissRequest = onDismiss, modifier = Modifier.imePadding(), title = { Text(mark.label.ifBlank { t(R.string.school_mark) }, maxLines = 2, overflow = TextOverflow.Ellipsis) }, text = {
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(t(R.string.school_mark_weight_the_original_stays_visible_th, uiMark(mark.displayMark, decimals), uiMark(mark.displayWeight)), style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(overrideMark, { overrideMark = it }, label = { Text(t(R.string.your_mark)) }, placeholder = { Text(uiMark(mark.displayMark, decimals)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            OutlinedTextField(overrideWeight, { overrideWeight = it }, label = { Text(t(R.string.your_weight)) }, placeholder = { Text(uiMark(mark.displayWeight)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            ToggleRow(t(R.string.exclude_from_your_average), t(R.string.the_school_mark_stays_on_this_page), excluded) { excluded = it }
            if (existing != null) TextButton(onClick = onRestore) { Text(t(R.string.restore_school_mark)) }
        }
    }, confirmButton = {
        TextButton(onClick = {
            onSave(GradeAdjustment(mark.targetId, if (overrideMark.isBlank()) null else parsedMark, if (overrideWeight.isBlank()) null else parsedWeight, excluded))
        }, enabled = markOk && weightOk && mark.targetId.isNotBlank()) { Text(t(R.string.save)) }
    }, dismissButton = { TextButton(onClick = onDismiss) { Text(t(R.string.cancel)) } })
}
