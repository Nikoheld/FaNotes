@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ch.fasrv.fanotes.companion

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.automirrored.outlined.Assignment
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.schulnetz.*
import java.time.LocalDate

@Composable
fun SchoolScreen(model: CompanionModel) {
    val profile = model.snapshot.profile
    ScreenList {
        item {
            Text(profile?.displayName?.ifBlank { t(R.string.your_school_in_one_place) } ?: t(R.string.your_school_in_one_place), style = MaterialTheme.typography.headlineMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (!profile?.className.isNullOrBlank()) Text(profile!!.className, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
            Text(t(R.string.last_updated, updatedLabel(model.snapshot.fetchedAt)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp, bottom = 20.dp))
        }
        if (model.snapshot.fetchedAt.isBlank() || model.link.needsReauth) item {
            InfoBanner(if (model.link.needsReauth) t(R.string.sign_in_to_refresh_school_data) else t(R.string.connect_schulnetz), t(R.string.bring_your_timetable_and_school_records_into_kan), t(R.string.manage_connection), onAction = { model.navigate(Page.Connections) })
        }
        item { SectionLabel(t(R.string.school_records)) }
        item { SettingRow(Icons.Outlined.Insights, t(R.string.grades), t(R.string.marks_subject_averages_and_your_own_grades), "${remember(model.snapshot.grades, model.gradeBook, model.unrevealedIds, model.settings.guessGrades) { activeCourses(courseSummaries(model.snapshot.grades, hiddenTargetIds = model.hiddenGradeIds(), book = model.gradeBook)).size }}") { model.navigate(Page.Grades) }; FineDivider() }
        item { SettingRow(Icons.AutoMirrored.Outlined.Assignment, t(R.string.exams), t(R.string.prepare_for_what_s_coming), "${(model.snapshot.exams + model.snapshot.events.filter { it.isExamLike() }).distinctBy(::lessonTargetId).size}") { model.navigate(Page.Exams) }; FineDivider() }
        item { SettingRow(Icons.Outlined.EventBusy, t(R.string.absences), t(R.string.status_excuse_deadlines), t(R.string.open_2, model.snapshot.absences.count { !it.excused })) { model.navigate(Page.Absences) }; FineDivider() }
        item { SettingRow(Icons.Outlined.Forum, t(R.string.updates), t(R.string.messages_school_events_holidays), "${model.snapshot.messages.size + model.snapshot.startMessages.size}") { model.navigate(Page.Updates) }; FineDivider() }
        item { SettingRow(Icons.AutoMirrored.Outlined.ReceiptLong, t(R.string.school_account), t(R.string.read_your_available_account_statement)) { model.navigate(Page.Statement) } }
        item { SectionLabel(t(R.string.plan_with_your_school)) }
        item { SettingRow(Icons.Outlined.DateRange, t(R.string.timetable), t(R.string.lessons_alongside_your_own_commitments)) { model.openPlanner() } }
        item { SettingRow(Icons.Outlined.Checklist, t(R.string.school_assignments), t(R.string.copy_assignments_into_your_own_task_list)) { model.openPlanner(true); model.taskSource = "school" } }
        item { SectionLabel(t(R.string.connection)) }
        item { SettingRow(Icons.Outlined.Link, t(R.string.schulnetz_connection), if (model.link.needsReauth) t(R.string.sign_in_again_to_refresh) else if (model.link.linked || model.snapshot.fetchedAt.isNotBlank()) t(R.string.school_data_cached_on_this_device) else t(R.string.not_connected)) { model.navigate(Page.Connections) } }
    }
}

@Composable
fun GradesScreen(model: CompanionModel) {
    var query by rememberSaveable { mutableStateOf("") }
    val official = remember(model.snapshot.grades, model.gradeBook, model.unrevealedIds, model.settings.guessGrades) { activeCourses(courseSummaries(model.snapshot.grades, hiddenTargetIds = model.hiddenGradeIds(), book = model.gradeBook)) }
    val archived = remember(model.snapshot.grades, model.gradeBook, model.unrevealedIds, model.settings.guessGrades) { courseSummaries(model.snapshot.grades, hiddenTargetIds = model.hiddenGradeIds(), book = model.gradeBook).filter { it.archived } }
    val courses = remember(official, model.desk.gradeSort, model.highlightIds, query, model.desk.courseAliases) {
        sortCourses(official, model.desk.gradeSort).sortedBy { if (it.marks.any { mark -> mark.targetId in model.highlightIds }) 0 else 1 }.filter { courseAlias(it.label, model.desk.courseAliases).contains(query, true) }
    }
    val totals = remember(official) { promotionTotals(official) }
    ScreenList {
        item {
            if (query.isBlank()) {
            FlowRow(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.widthIn(min = 140.dp)) {
                    Text(t(R.string.overall_average), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(uiMark(overallAverage(official), model.desk.gradeDecimals), style = MaterialTheme.typography.displayLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                }
                if (model.desk.showPluspunkte) Column {
                    Text(t(R.string.promotion_points_2), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(uiPlus(totals.total), style = MaterialTheme.typography.headlineMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, color = if (totals.total >= 0) LocalCompanionSemantics.current.success else MaterialTheme.colorScheme.error)
                }
            }
            Text(t(R.string.school_marks_plus_your_own_grades_what_if_scenar), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 20.dp))
            }
            SearchField(query, { query = it }, t(R.string.find_a_subject))
            ChoiceRow(listOf("name" to t(R.string.subject), "average" to t(R.string.average), "pluspunkte" to t(R.string.points)), model.desk.gradeSort, { model.updateDesk(model.desk.copy(gradeSort = it)) })
        }
        if (courses.isEmpty() && query.isBlank() && model.busy && model.snapshot.fetchedAt.isBlank()) item {
            Row(Modifier.fillMaxWidth().padding(vertical = 28.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                Text(t(R.string.loading_grades), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 12.dp))
            }
        } else if (courses.isEmpty()) item { EmptyState(Icons.Outlined.Insights, if (query.isBlank()) t(R.string.no_grades_yet) else t(R.string.no_matching_subjects), if (query.isBlank()) t(R.string.your_available_marks_appear_after_connecting_and) else t(R.string.try_a_different_subject_name)) }
        items(courses, key = { it.courseId }) { course ->
            val highlighted = course.marks.any { it.targetId in model.highlightIds }
            Row(Modifier.fillMaxWidth().background(if (highlighted) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.background, MaterialTheme.shapes.small).clickable(role = Role.Button) { model.focusCourseId = course.courseId; model.navigate(Page.Course) }.padding(vertical = 18.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Box(Modifier.width(3.dp).height(36.dp).background(paletteColor(subjectColor(course.label, overrides = model.colors)), MaterialTheme.shapes.extraSmall))
                Column(Modifier.weight(1f)) {
                    Text(courseAlias(course.label, model.desk.courseAliases), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(buildList {
                        add(tp(R.plurals.marks_count, course.marks.size, course.marks.size))
                        if (course.marks.any { it.own }) add(t(R.string.includes_your_grades))
                        if (course.marks.any { it.adjusted || it.excluded }) add("adjusted")
                        if (model.hypothetical.any { it.courseId == course.courseId }) add(t(R.string.local_scenario_saved))
                    }.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                Text(if (course.marks.any { model.isUnrevealed(it.targetId) } && course.average == null) "?" else uiMark(course.average, model.desk.gradeDecimals), style = MaterialTheme.typography.titleLarge, color = if ((course.average ?: 4.0) < 4.0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
                Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            FineDivider()
        }
        if (archived.isNotEmpty() && query.isBlank()) item {
            SettingRow(Icons.Outlined.Archive, t(R.string.archived_subjects), t(R.string.hidden_from_this_list_and_your_averages), "${archived.size}") { model.navigate(Page.ArchivedSubjects) }
        }
        schoolError(model, "Noten:")
    }
}

@Composable
fun CourseScreen(model: CompanionModel) {
    val official = remember(model.snapshot.grades, model.gradeBook, model.unrevealedIds, model.settings.guessGrades) { courseSummaries(model.snapshot.grades, hiddenTargetIds = model.hiddenGradeIds(), book = model.gradeBook) }
    val course = official.firstOrNull { it.courseId == model.focusCourseId }
    if (course == null) { ScreenList { item { EmptyState(Icons.Outlined.Insights, t(R.string.subject_unavailable), t(R.string.it_is_no_longer_in_the_last_school_snapshot), t(R.string.all_subjects)) { model.back() } } }; return }
    val scenario = remember(model.snapshot.grades, model.hypothetical, model.gradeBook, course.courseId, model.unrevealedIds, model.settings.guessGrades) { courseSummaries(model.snapshot.grades, model.hypothetical, model.hiddenGradeIds(), model.gradeBook).first { it.courseId == course.courseId } }
    val decimals = model.desk.gradeDecimals
    val scenarioMarks = model.hypothetical.filter { it.courseId == course.courseId }
    val ownGrades = model.gradeBook.own.filter { it.courseId == course.courseId }
    val collectiveGrades = model.gradeBook.collective.filter { it.courseId == course.courseId }
    var calculator by rememberSaveable { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    var addingOwn by remember { mutableStateOf(false) }
    var editingOwn by remember { mutableStateOf<OwnGrade?>(null) }
    var addingCollective by remember { mutableStateOf(false) }
    var editingCollective by remember { mutableStateOf<CollectiveGrade?>(null) }
    var adjusting by remember { mutableStateOf<WeightedMark?>(null) }
    var customize by remember { mutableStateOf(false) }
    var confirmArchive by remember { mutableStateOf(false) }
    var target by rememberSaveable { mutableStateOf("5.0") }
    var weight by rememberSaveable { mutableStateOf("1") }
    ScreenList {
        item {
            Text(courseAlias(course.label, model.desk.courseAliases), style = MaterialTheme.typography.headlineMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
            if (course.archived) Text(t(R.string.archived_hidden_from_your_list_overall_average_a), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
            FlowRow(Modifier.fillMaxWidth().padding(vertical = 18.dp), horizontalArrangement = Arrangement.spacedBy(28.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Column { Text(t(R.string.average), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(uiMark(course.average, decimals), style = MaterialTheme.typography.headlineLarge) }
                Column { Text(t(R.string.rounded), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(uiMark(course.zeugnis, decimals), style = MaterialTheme.typography.headlineLarge) }
                if (model.desk.showPluspunkte) Column { Text(t(R.string.points), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(if (course.promotion) uiPlus(course.pluspunkte) else "—", style = MaterialTheme.typography.headlineLarge) }
            }
            TextButton(onClick = { customize = true }) { Text(t(R.string.subject_name_color)) }
            if (course.archived) TextButton(onClick = { model.restoreCourse(course.courseId) }) { Text(t(R.string.restore_subject)) }
            else TextButton(onClick = { confirmArchive = true }) { Text(t(R.string.archive_subject)) }
            SectionLabel(t(R.string.school_marks))
        }
        items(course.marks.filterNot { it.own }, key = { "${it.targetId}:${it.label}:${it.displayMark}" }) { mark ->
            SchoolMarkRow(
                mark = mark,
                decimals = decimals,
                hidden = model.isUnrevealed(mark.targetId),
                highlighted = mark.targetId in model.highlightIds,
                longPressReveal = model.desk.revealLongPress,
                onReveal = { model.openReveal(listOf(mark.targetId)) },
                onAdjust = { adjusting = mark },
                onRestore = { model.restoreGradeAdjustment(mark.targetId) },
            )
        }
        item { SectionLabel(t(R.string.your_marks), t(R.string.add)) { editingOwn = null; addingOwn = true } }
        item { Text(t(R.string.your_own_grades_count_in_this_average_promotion), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        items(ownGrades, key = { "own:${it.id}" }) { grade ->
            OwnMarkRow(grade, decimals, onEdit = { editingOwn = grade; addingOwn = true }, onDelete = { model.deleteOwnGrade(grade.id) })
        }
        item { SectionLabel(t(R.string.collective_grades), t(R.string.add)) { editingCollective = null; addingCollective = true } }
        item { Text(t(R.string.a_sammelnote_combines_partial_tests_into_one_mar), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        items(collectiveGrades, key = { "collective:${it.id}" }) { grade ->
            CollectiveMarkRow(grade, decimals, onEdit = { editingCollective = grade; addingCollective = true }, onDelete = { model.deleteCollectiveGrade(grade.id) })
        }
        item { SectionLabel(t(R.string.what_if), t(R.string.add_a_mark)) { adding = true } }
        item { Text(t(R.string.explore_a_local_scenario_your_school_records_sta), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (scenarioMarks.isNotEmpty()) {
            item {
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.padding(vertical = 12.dp)) {
                    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) { Text(t(R.string.projected_average), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium); Text(uiMark(scenario.average, decimals), style = MaterialTheme.typography.headlineMedium) }
                }
            }
            items(scenarioMarks, key = { it.id }) { extra ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) { Text(extra.title, style = MaterialTheme.typography.bodyLarge); Text(t(R.string.local_weight, uiMark(extra.mark, decimals), uiMark(extra.weight)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    ActionIcon(Icons.Outlined.Close, t(R.string.remove_local_mark, extra.title)) { model.removeHypothetical(extra.id) }
                }
            }
        }
        item {
            SettingRow(Icons.Outlined.Calculate, t(R.string.target_grade_calculator), if (calculator) t(R.string.tap_to_collapse) else t(R.string.what_mark_would_reach_your_target)) { calculator = !calculator }
            if (calculator) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(target, { target = it }, label = { Text(t(R.string.target_average)) }, modifier = Modifier.weight(1f), singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                    OutlinedTextField(weight, { weight = it }, label = { Text(t(R.string.next_weight)) }, modifier = Modifier.weight(1f), singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                }
                val goal = target.replace(',', '.').toDoubleOrNull()
                val factor = weight.replace(',', '.').toDoubleOrNull()
                if (goal != null && goal.isFinite() && goal in 1.0..6.0 && factor != null && factor.isFinite() && factor > 0) {
                    val result = wunschnote(countingMarks(scenario.marks), goal, factor)
                    Text(when { result.alreadyMet -> t(R.string.your_current_scenario_already_reaches_this_targe); !result.achievable -> t(R.string.this_target_cannot_be_reached_with_one_mark_at_t); else -> t(R.string.needed_next_half_mark, uiMark(result.needed, decimals), uiMark(result.neededHalf, decimals)) }, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(vertical = 16.dp))
                    if (model.desk.showPluspunkte && course.promotion && result.pluspunkteAfter != null) Text(t(R.string.promotion_points_3, uiPlus(result.pluspunkteBefore ?: 0.0), uiPlus(result.pluspunkteAfter ?: 0.0)), style = MaterialTheme.typography.bodySmall)
                } else Text(t(R.string.enter_an_average_from_1_6_and_a_positive_weight), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 12.dp))
            }
        }
    }
    if (addingOwn) OwnGradeDialog(course.courseId, editingOwn, { addingOwn = false; editingOwn = null }) { grade -> model.saveOwnGrade(grade); addingOwn = false; editingOwn = null }
    if (addingCollective) CollectiveGradeDialog(course.courseId, editingCollective, { addingCollective = false; editingCollective = null }) { grade -> model.saveCollectiveGrade(grade); addingCollective = false; editingCollective = null }
    adjusting?.let { mark ->
        GradeAdjustmentDialog(mark, decimals, model.gradeBook.adjustments.firstOrNull { it.targetId == mark.targetId }, { adjusting = null }, { model.saveGradeAdjustment(it); adjusting = null }, { model.restoreGradeAdjustment(mark.targetId); adjusting = null })
    }
    if (adding) {
        var title by rememberSaveable { mutableStateOf("") }; var mark by rememberSaveable { mutableStateOf("") }; var factor by rememberSaveable { mutableStateOf("1") }
        val number = mark.replace(',', '.').toDoubleOrNull(); val w = factor.replace(',', '.').toDoubleOrNull()
        AlertDialog(onDismissRequest = { adding = false }, modifier = Modifier.imePadding(), title = { Text(t(R.string.add_a_local_mark)) }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(t(R.string.only_used_for_your_scenario), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(title, { title = it }, label = { Text(t(R.string.label_optional)) }, singleLine = true)
                OutlinedTextField(mark, { mark = it }, label = { Text(t(R.string.mark_1_to_6)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                OutlinedTextField(factor, { factor = it }, label = { Text(t(R.string.weight_3)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            }
        }, confirmButton = { TextButton(onClick = { model.addHypothetical(course.courseId, title.ifBlank { t(R.string.local_mark) }, number!!, w!!); adding = false }, enabled = number != null && number.isFinite() && number in 1.0..6.0 && w != null && w.isFinite() && w > 0) { Text(t(R.string.add)) } }, dismissButton = { TextButton(onClick = { adding = false }) { Text(t(R.string.cancel)) } })
    }
    if (customize) {
        var alias by rememberSaveable { mutableStateOf(courseAlias(course.label, model.desk.courseAliases)) }
        var color by rememberSaveable { mutableStateOf(subjectColor(course.label, overrides = model.colors)) }
        AlertDialog(onDismissRequest = { customize = false }, modifier = Modifier.imePadding(), title = { Text(t(R.string.subject_appearance)) }, text = {
            Column { OutlinedTextField(alias, { alias = it }, label = { Text(t(R.string.display_name)) }); Spacer(Modifier.height(12.dp)); ColorChoices(SUBJECT_PALETTE.take(6), color, { color = it }) }
        }, confirmButton = { TextButton(onClick = { model.renameCourse(course.label, alias); model.paintSubject(course.label, color); customize = false }) { Text(t(R.string.save)) } }, dismissButton = { TextButton(onClick = { customize = false }) { Text(t(R.string.cancel)) } })
    }
    if (confirmArchive) ConfirmDialog(t(R.string.archive_this_subject), t(R.string.it_leaves_your_list_overall_average_and_promotio), t(R.string.archive), { confirmArchive = false }) {
        model.archiveCourse(course.courseId)
        confirmArchive = false
        model.back()
    }
}

@Composable
fun SchoolRecordScreen(model: CompanionModel, page: Page) {
    var query by rememberSaveable(page) { mutableStateOf("") }
    var filter by rememberSaveable(page) { mutableStateOf("all") }
    var selected by remember { mutableStateOf<AgendaEntry?>(null) }
    val today = LocalDate.now()
    ScreenList {
        item {
            Text(t(R.string.schulnetz_read_only), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(bottom = 8.dp))
            Text(t(R.string.last_updated, updatedLabel(model.snapshot.fetchedAt)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 16.dp))
            if (page != Page.Statement) SearchField(query, { query = it }, t(R.string.search_page, page.uiTitle()))
        }
        when (page) {
            Page.Exams -> {
                item { ChoiceRow(listOf("all" to t(R.string.all), "upcoming" to t(R.string.upcoming)), filter, { filter = it }) }
                val events = (model.snapshot.exams + model.snapshot.events.filter { it.isExamLike() }).distinctBy(::lessonTargetId).filter { "${it.label} ${it.comment}".contains(query, true) && (filter == "all" || (parseDisplayDate(it.start) ?: today) >= today) }.sortedWith(compareBy<AgendaEvent> { if (lessonTargetId(it) in model.highlightIds) 0 else 1 }.thenBy { it.start })
                if (events.isEmpty() && query.isBlank() && model.busy && model.snapshot.fetchedAt.isBlank()) item { SchoolLoading(t(R.string.loading_exams)) }
                else if (events.isEmpty()) item { EmptyState(Icons.AutoMirrored.Outlined.Assignment, t(R.string.no_exams_to_show), t(R.string.available_exam_dates_appear_after_your_school_is)) }
                items(events, key = { lessonTargetId(it) }) { event ->
                    val entry = AgendaEntry("exam:${lessonTargetId(event)}", event.label, AgendaKind.Exam, parseDisplayDate(event.start) ?: today, eventClock(event), detail = listOf(dueLabel(event.start), event.room).filter { it.isNotBlank() }.joinToString(" · "), school = event)
                    AgendaRow(model, entry) { selected = entry }
                }
                schoolError(model, "Prüfungen:")
            }
            Page.Absences -> {
                item { ChoiceRow(listOf("all" to t(R.string.all), "open" to t(R.string.open), "excused" to t(R.string.excused)), filter, { filter = it }) }
                val absences = model.snapshot.absences.filter { "${it.subject} ${it.reason} ${it.dateFrom}".contains(query, true) && when (filter) { "open" -> !it.excused; "excused" -> it.excused; else -> true } }.sortedWith(compareBy<SchoolAbsence> { if (absenceTargetId(it) in model.highlightIds) 0 else 1 }.thenByDescending { it.dateFrom })
                if (absences.isEmpty() && query.isBlank() && model.busy && model.snapshot.fetchedAt.isBlank()) item { SchoolLoading(t(R.string.loading_absences)) }
                else if (absences.isEmpty()) item { EmptyState(Icons.Outlined.EventAvailable, t(R.string.no_absences_to_show), t(R.string.your_available_absence_records_and_deadlines_wil)) }
                items(absences, key = { absenceTargetId(it) }) { absence ->
                    val highlighted = absenceTargetId(absence) in model.highlightIds
                    Column(Modifier.fillMaxWidth().background(if (highlighted) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.background, MaterialTheme.shapes.small).padding(vertical = 16.dp, horizontal = if (highlighted) 12.dp else 0.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) { Text(absence.subject.ifBlank { t(R.string.absence) }, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis); Tag(if (absence.excused) t(R.string.excused) else t(R.string.open), if (absence.excused) LocalCompanionSemantics.current.success else LocalCompanionSemantics.current.warning) }
                        Text(listOf(absence.dateFrom, absence.dateTo.takeIf { it != absence.dateFrom }.orEmpty(), absence.hourFrom, absence.hourTo).filter { it.isNotBlank() }.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (absence.reason.isNotBlank()) Text(absence.reason, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 8.dp))
                        if (absence.excuseUntil.isNotBlank() && !absence.excused) Text(t(R.string.excuse_by, absence.excuseUntil), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp))
                        if (absence.acknowledged) Text(t(R.string.acknowledged_by_school), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    FineDivider()
                }
                schoolError(model, "Absenzen:")
            }
            Page.Updates -> {
                val messages = model.snapshot.messages.filter { "${it.title} ${it.body}".contains(query, true) }.sortedBy { if (messageTargetId(it) in model.highlightIds) 0 else 1 }
                if (messages.isNotEmpty()) item { SectionLabel(t(R.string.messages)) }
                items(messages, key = { messageTargetId(it) }) { message -> ExpandableRecord(shownText(message.title).ifBlank { t(R.string.school_message) }, message.body, message.at, messageTargetId(message) in model.highlightIds) }
                val announcements = model.snapshot.startMessages.filter { it.contains(query, true) }
                if (announcements.isNotEmpty()) item { SectionLabel(t(R.string.announcements)) }
                itemsIndexed(announcements, key = { index, body -> "announcement:$index:${body.take(48)}" }) { _, body -> ExpandableRecord(t(R.string.announcement_item), body) }
                val events = model.snapshot.events.filter { !it.isLesson() && "${it.label} ${it.comment}".contains(query, true) }.sortedBy { it.start }
                if (events.isNotEmpty()) item { SectionLabel(t(R.string.school_events)) }
                items(events, key = { "update:${lessonTargetId(it)}" }) { event ->
                    val entry = AgendaEntry("school:${lessonTargetId(event)}", event.label, if (event.isExamLike()) AgendaKind.Exam else AgendaKind.Event, parseDisplayDate(event.start) ?: today, eventClock(event), detail = dueLabel(event.start), school = event)
                    AgendaRow(model, entry) { selected = entry }
                }
                val vacations = model.snapshot.vacations.filter { it.name.contains(query, true) }
                if (vacations.isNotEmpty()) item { SectionLabel(t(R.string.holidays)) }
                items(vacations, key = { "vacation:${it.id}" }) { vacation -> ExpandableRecord(vacation.name, "${vacation.start} – ${vacation.end}") }
                if (messages.isEmpty() && announcements.isEmpty() && events.isEmpty() && vacations.isEmpty()) item {
                    if (query.isBlank() && model.busy && model.snapshot.fetchedAt.isBlank()) SchoolLoading(t(R.string.loading_updates))
                    else EmptyState(Icons.Outlined.Forum, t(R.string.all_quiet_here), t(R.string.school_announcements_messages_and_dates_will_app))
                }
            }
            Page.Statement -> {
                if (model.snapshot.konto.isEmpty()) item {
                    if (model.busy && model.snapshot.fetchedAt.isBlank()) SchoolLoading(t(R.string.loading_statement))
                    else EmptyState(Icons.AutoMirrored.Outlined.ReceiptLong, t(R.string.no_statement_available), t(R.string.some_schools_do_not_provide_an_account_statement))
                }
                itemsIndexed(model.snapshot.konto, key = { index, line -> "konto:$index:${line.date}:${line.label}:${line.amount}" }) { _, line ->
                    Column(Modifier.padding(vertical = 16.dp)) {
                        Text(line.date, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) { Text(line.label, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge, maxLines = 3, overflow = TextOverflow.Ellipsis); Text(line.amount, style = MaterialTheme.typography.titleMedium, maxLines = 1) }
                        if (line.balance.isNotBlank()) Text(t(R.string.balance, line.balance), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    FineDivider()
                }
            }
            else -> Unit
        }
    }
    selected?.let { AgendaDetails(model, it) { selected = null } }
}

@Composable
private fun SchoolLoading(label: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 28.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 12.dp))
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.schoolError(model: CompanionModel, prefix: String) {
    model.snapshot.readErrors.firstOrNull { it.startsWith(prefix) }?.let { error -> item { Spacer(Modifier.height(16.dp)); InfoBanner(t(R.string.school_data_needs_attention), shownText(error), t(R.string.connection_details), true) { model.navigate(Page.Connections) } } }
}
@Composable
private fun ExpandableRecord(title: String, body: String, date: String = "", highlighted: Boolean = false) {
    var expanded by rememberSaveable(title, body) { mutableStateOf(highlighted) }
    Column(Modifier.fillMaxWidth().background(if (highlighted) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.background, MaterialTheme.shapes.small).clickable(role = Role.Button) { expanded = !expanded }.semantics { stateDescription = if (expanded) t(R.string.expanded) else t(R.string.collapsed) }.padding(vertical = 16.dp, horizontal = if (highlighted) 12.dp else 0.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f), maxLines = 3, overflow = TextOverflow.Ellipsis)
            Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, if (expanded) t(R.string.collapse) else t(R.string.expand), Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (date.isNotBlank()) Text(date.take(16).replace('T', ' '), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (body.isNotBlank()) {
            if (expanded) SelectionContainer { Text(body, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 8.dp)) }
            else Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
        }
    }
    FineDivider()
}
