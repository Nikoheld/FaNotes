@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ch.fasrv.fanotes.companion

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Assignment
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.schulnetz.*
import java.time.LocalDate

@Composable
fun SchoolScreen(model: CompanionModel) {
    val profile = model.snapshot.profile
    val online = LocalOnline.current
    val courses = remember(model.snapshot.grades, model.gradeBook, model.unrevealedIds, model.settings.guessGrades) { activeCourses(courseSummaries(model.snapshot.grades, hiddenTargetIds = model.hiddenGradeIds(), book = model.gradeBook)).size }
    val exams = remember(model.snapshot.exams, model.snapshot.events) { (model.snapshot.exams + model.snapshot.events.filter { it.isExamLike() }).distinctBy(::lessonTargetId).size }
    val openAbsences = model.snapshot.absences.count { it.isOpen() }
    val absencePoints = remember(model.snapshot) { model.absencePoints() }
    val updates = model.snapshot.messages.size + model.snapshot.startMessages.size
    val fetched = model.snapshot.fetchedAt.isNotBlank()
    RefreshableScreenList(model.syncing, { model.pullRefresh() }) {
        item(key = "identity") {
            Row(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                val initials = listOfNotNull(profile?.firstName?.firstOrNull(), profile?.lastName?.firstOrNull()).joinToString("").uppercase()
                Box(Modifier.size(52.dp).background(MaterialTheme.colorScheme.primaryContainer, CircleShape), contentAlignment = Alignment.Center) {
                    if (initials.isNotBlank()) Text(initials, style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary)
                    else Icon(Icons.Outlined.School, null, tint = MaterialTheme.colorScheme.primary)
                }
                Column(Modifier.padding(start = 14.dp).weight(1f)) {
                    Text(profile?.displayName?.ifBlank { t(R.string.your_school_in_one_place) } ?: t(R.string.your_school_in_one_place), style = MaterialTheme.typography.headlineSmall, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() })
                    if (!profile?.className.isNullOrBlank()) Text(profile!!.className, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            val stamp = updatedLabel(model.snapshot.fetchedAt)
            StatusLine(
                when {
                    model.link.needsReauth -> t(R.string.sign_in_again_to_refresh)
                    !online && fetched -> t(R.string.offline_last_updated, stamp)
                    model.link.linked -> t(R.string.connected_last_updated, stamp)
                    fetched -> t(R.string.cached_last_updated, stamp)
                    else -> t(R.string.not_connected)
                },
                when {
                    model.link.needsReauth -> StateTone.Warning
                    !online -> StateTone.Offline
                    model.link.linked -> StateTone.Accent
                    else -> StateTone.Neutral
                },
                Modifier.padding(top = 4.dp, bottom = 8.dp),
            )
        }
        if (!fetched || model.link.needsReauth) item(key = "connect") {
            Box(Modifier.padding(vertical = 8.dp)) {
                InfoBanner(if (model.link.needsReauth) t(R.string.sign_in_to_refresh_school_data) else t(R.string.connect_schulnetz), t(R.string.bring_your_timetable_and_school_records_into_kan), t(R.string.manage_connection),
                    tone = if (model.link.needsReauth) StateTone.Warning else StateTone.Accent, onAction = { model.navigate(Page.Connections) })
            }
        }
        item(key = "records-head") { SectionLabel(t(R.string.school_records)) }
        item(key = "records") {
            Group {
                SettingRow(Icons.Outlined.Insights, t(R.string.grades), t(R.string.marks_subject_averages_and_your_own_grades), if (fetched) courses.toString() else "") { model.navigate(Page.Grades) }
                FineDivider()
                SettingRow(Icons.AutoMirrored.Outlined.Assignment, t(R.string.exams), t(R.string.prepare_for_what_s_coming), if (fetched) exams.toString() else "") { model.navigate(Page.Exams) }
                FineDivider()
                SettingRow(Icons.Outlined.EventBusy, t(R.string.absences), t(R.string.status_excuse_deadlines), if (!fetched) "" else absencePointsLeft(absencePoints) ?: t(R.string.open_2, openAbsences),
                    tone = if (openAbsences > 0) StateTone.Warning else StateTone.Neutral, trailingColor = if (openAbsences > 0) LocalCompanionSemantics.current.warning else null) { model.navigate(Page.Absences) }
                FineDivider()
                SettingRow(Icons.Outlined.Forum, t(R.string.updates), t(R.string.messages_school_events_holidays), if (fetched) updates.toString() else "") { model.navigate(Page.Updates) }
                FineDivider()
                SettingRow(Icons.AutoMirrored.Outlined.ReceiptLong, t(R.string.school_account), t(R.string.read_your_available_account_statement)) { model.navigate(Page.Statement) }
            }
        }
        item(key = "plan-head") { SectionLabel(t(R.string.plan_with_your_school)) }
        item(key = "plan") {
            Group {
                SettingRow(Icons.Outlined.DateRange, t(R.string.timetable), t(R.string.lessons_alongside_your_own_commitments)) { model.openPlanner() }
                FineDivider()
                SettingRow(Icons.Outlined.Checklist, t(R.string.school_assignments), t(R.string.copy_assignments_into_your_own_task_list), if (model.snapshot.homework.isNotEmpty()) "${model.snapshot.homework.size}" else "") { model.openPlanner(true); model.taskSource = "school" }
            }
        }
        item(key = "connection-head") { SectionLabel(t(R.string.connection)) }
        item(key = "connection") {
            Group {
                SettingRow(Icons.Outlined.Link, t(R.string.schulnetz_connection), if (model.link.needsReauth) t(R.string.sign_in_again_to_refresh) else if (model.link.linked || fetched) t(R.string.school_data_cached_on_this_device) else t(R.string.not_connected),
                    tone = if (model.link.needsReauth) StateTone.Warning else StateTone.Neutral) { model.navigate(Page.Connections) }
            }
        }
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
    val hiddenCount = remember(model.snapshot.grades, model.unrevealedIds, model.settings.guessGrades) { model.snapshot.grades.count { model.isUnrevealed(gradeTargetId(it)) } }
    RefreshableScreenList(model.syncing, { model.pullRefresh() }) {
        item(key = "summary") {
            if (query.isBlank()) {
                Surface(color = MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.extraLarge, modifier = Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 16.dp)) {
                    Column(Modifier.padding(20.dp)) {
                        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(28.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            MetricBlock(t(R.string.overall_average), uiMark(overallAverage(official), model.desk.gradeDecimals), large = true)
                            if (model.desk.showPluspunkte) MetricBlock(t(R.string.promotion_points_2), uiPlus(totals.total), large = true,
                                valueColor = if (totals.total >= 0) LocalCompanionSemantics.current.success else MaterialTheme.colorScheme.error)
                        }
                        Text(t(R.string.school_marks_plus_your_own_grades_what_if_scenar), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp))
                        if (hiddenCount > 0) StatusLine(tp(R.plurals.hidden_marks_waiting, hiddenCount, hiddenCount), StateTone.Neutral, Modifier.padding(top = 10.dp))
                    }
                }
            }
            SearchField(query, { query = it }, t(R.string.find_a_subject))
            ChoiceRow(listOf("name" to t(R.string.subject), "average" to t(R.string.average), "pluspunkte" to t(R.string.points)), model.desk.gradeSort, { model.updateDesk(model.desk.copy(gradeSort = it)) }, Modifier.padding(top = 6.dp, bottom = 6.dp))
        }
        if (courses.isEmpty() && query.isBlank() && model.busy && model.snapshot.fetchedAt.isBlank()) item(key = "loading") { SkeletonRows(4, t(R.string.loading_grades)) }
        else if (courses.isEmpty()) item(key = "empty") { EmptyState(Icons.Outlined.Insights, if (query.isBlank()) t(R.string.no_grades_yet) else t(R.string.no_matching_subjects), if (query.isBlank()) t(R.string.your_available_marks_appear_after_connecting_and) else t(R.string.try_a_different_subject_name)) }
        itemsIndexed(courses, key = { _, it -> it.courseId }) { index, course ->
            val highlighted = course.marks.any { it.targetId in model.highlightIds }
            val waiting = course.marks.any { model.isUnrevealed(it.targetId) }
            GroupItem(index, courses.size) {
                Row(Modifier.fillMaxWidth().background(if (highlighted) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                    .clickable(role = Role.Button) { model.focusCourseId = course.courseId; model.navigate(Page.Course) }.heightIn(min = 68.dp).padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    SubjectBar(paletteColor(subjectColor(course.label, overrides = model.colors)), 40.dp)
                    Column(Modifier.weight(1f)) {
                        Text(courseAlias(course.label, model.desk.courseAliases), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(buildList {
                            add(tp(R.plurals.marks_count, course.marks.size, course.marks.size))
                            if (course.marks.any { it.own }) add(t(R.string.includes_your_grades))
                            if (course.marks.any { it.adjusted || it.excluded }) add(t(R.string.adjusted_short))
                            if (model.hypothetical.any { it.courseId == course.courseId }) add(t(R.string.local_scenario_saved))
                        }.joinToString("  ·  "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        if (waiting) Row(Modifier.padding(top = 6.dp)) { Tag(t(R.string.new_mark_hidden)) }
                    }
                    Text(if (waiting && course.average == null) "?" else uiMark(course.average, model.desk.gradeDecimals), style = MaterialTheme.typography.displaySmall.copy(fontSize = MaterialTheme.typography.headlineMedium.fontSize),
                        color = if ((course.average ?: 4.0) < 4.0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
                    Icon(Icons.Outlined.ChevronRight, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        if (archived.isNotEmpty() && query.isBlank()) item(key = "archived") {
            Spacer(Modifier.height(16.dp))
            Group { SettingRow(Icons.Outlined.Archive, t(R.string.archived_subjects), t(R.string.hidden_from_this_list_and_your_averages), "${archived.size}") { model.navigate(Page.ArchivedSubjects) } }
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
    val schoolMarks = course.marks.filterNot { it.own }
    var calculator by rememberSaveable { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    var addingOwn by remember { mutableStateOf(false) }
    var editingOwn by remember { mutableStateOf<OwnGrade?>(null) }
    var addingCollective by remember { mutableStateOf(false) }
    var editingCollective by remember { mutableStateOf<CollectiveGrade?>(null) }
    var adjusting by remember { mutableStateOf<WeightedMark?>(null) }
    var customize by remember { mutableStateOf(false) }
    var confirmArchive by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var target by rememberSaveable { mutableStateOf("5.0") }
    var weight by rememberSaveable { mutableStateOf("1") }
    val color = paletteColor(subjectColor(course.label, overrides = model.colors))
    ScreenList {
        item(key = "head") {
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.Top) {
                SubjectBar(color, 48.dp)
                Column(Modifier.weight(1f).padding(start = 14.dp)) {
                    Text(courseAlias(course.label, model.desk.courseAliases), style = MaterialTheme.typography.headlineMedium, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.semantics { heading() })
                    if (course.archived) Text(t(R.string.archived_hidden_from_your_list_overall_average_a), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                }
                Box {
                    ActionIcon(Icons.Outlined.MoreVert, t(R.string.subject_options)) { menu = true }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem(text = { Text(t(R.string.subject_name_color)) }, leadingIcon = { Icon(Icons.Outlined.Palette, null) }, onClick = { menu = false; customize = true })
                        if (course.archived) DropdownMenuItem(text = { Text(t(R.string.restore_subject)) }, leadingIcon = { Icon(Icons.Outlined.Unarchive, null) }, onClick = { menu = false; model.restoreCourse(course.courseId) })
                        else DropdownMenuItem(text = { Text(t(R.string.archive_subject)) }, leadingIcon = { Icon(Icons.Outlined.Archive, null) }, onClick = { menu = false; confirmArchive = true })
                    }
                }
            }
            Surface(color = MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.extraLarge, modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) {
                Row(Modifier.fillMaxWidth().padding(20.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    MetricBlock(t(R.string.average), uiMark(course.average, decimals), Modifier.weight(1f))
                    MetricBlock(t(R.string.rounded), uiMark(course.zeugnis, decimals), Modifier.weight(1f))
                    if (model.desk.showPluspunkte) MetricBlock(t(R.string.points), if (course.promotion) uiPlus(course.pluspunkte) else "–", Modifier.weight(1f))
                }
            }
        }
        item(key = "school-head") { SectionLabel(t(R.string.school_marks), count = schoolMarks.size.takeIf { it > 0 }) }
        if (schoolMarks.isEmpty()) item(key = "school-empty") { Text(t(R.string.no_school_marks_yet), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        itemsIndexed(schoolMarks, key = { _, it -> "${it.targetId}:${it.label}:${it.displayMark}" }) { index, mark ->
            GroupItem(index, schoolMarks.size) {
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
        }
        item(key = "own-head") { SectionLabel(t(R.string.your_marks), t(R.string.add)) { editingOwn = null; addingOwn = true } }
        item(key = "own-help") { Text(t(R.string.your_own_grades_count_in_this_average_promotion), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp)) }
        itemsIndexed(ownGrades, key = { _, it -> "own:${it.id}" }) { index, grade ->
            GroupItem(index, ownGrades.size) { OwnMarkRow(grade, decimals, onEdit = { editingOwn = grade; addingOwn = true }, onDelete = { model.deleteOwnGrade(grade.id) }) }
        }
        item(key = "collective-head") { SectionLabel(t(R.string.collective_grades), t(R.string.add)) { editingCollective = null; addingCollective = true } }
        item(key = "collective-help") { Text(t(R.string.a_sammelnote_combines_partial_tests_into_one_mar), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp)) }
        itemsIndexed(collectiveGrades, key = { _, it -> "collective:${it.id}" }) { index, grade ->
            GroupItem(index, collectiveGrades.size) { CollectiveMarkRow(grade, decimals, onEdit = { editingCollective = grade; addingCollective = true }, onDelete = { model.deleteCollectiveGrade(grade.id) }) }
        }
        item(key = "whatif-head") { SectionLabel(t(R.string.what_if), t(R.string.add_a_mark)) { adding = true } }
        item(key = "whatif-help") { Text(t(R.string.explore_a_local_scenario_your_school_records_sta), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp)) }
        if (scenarioMarks.isNotEmpty()) {
            item(key = "projected") {
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.large, modifier = Modifier.padding(bottom = 10.dp)) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(t(R.string.projected_average), style = MaterialTheme.typography.titleMedium)
                            Row(Modifier.padding(top = 4.dp)) { Tag(t(R.string.local_only), LocalCompanionSemantics.current.warning) }
                        }
                        Text(uiMark(scenario.average, decimals), style = MaterialTheme.typography.displaySmall)
                    }
                }
            }
            itemsIndexed(scenarioMarks, key = { _, it -> it.id }) { index, extra ->
                GroupItem(index, scenarioMarks.size) {
                    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) { Text(extra.title, style = MaterialTheme.typography.bodyLarge); Text(t(R.string.local_weight, uiMark(extra.mark, decimals), uiMark(extra.weight)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        ActionIcon(Icons.Outlined.Close, t(R.string.remove_local_mark, extra.title)) { model.removeHypothetical(extra.id) }
                    }
                }
            }
        }
        item(key = "calculator") {
            Spacer(Modifier.height(16.dp))
            Group {
                SettingRow(Icons.Outlined.Calculate, t(R.string.target_grade_calculator), if (calculator) t(R.string.tap_to_collapse) else t(R.string.what_mark_would_reach_your_target), chevron = false) { calculator = !calculator }
                if (calculator) Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp).animateContentSize(LocalKantiMotion.current.spec(LocalKantiMotion.current.medium))) {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        OutlinedTextField(target, { target = it }, label = { Text(t(R.string.target_average)) }, modifier = Modifier.weight(1f), singleLine = true, shape = MaterialTheme.shapes.small, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                        OutlinedTextField(weight, { weight = it }, label = { Text(t(R.string.next_weight)) }, modifier = Modifier.weight(1f), singleLine = true, shape = MaterialTheme.shapes.small, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                    }
                    val goal = target.replace(',', '.').toDoubleOrNull()
                    val factor = weight.replace(',', '.').toDoubleOrNull()
                    if (goal != null && goal.isFinite() && goal in 1.0..6.0 && factor != null && factor.isFinite() && factor > 0) {
                        val result = wunschnote(countingMarks(scenario.marks), goal, factor)
                        Text(when { result.alreadyMet -> t(R.string.your_current_scenario_already_reaches_this_targe); !result.achievable -> t(R.string.this_target_cannot_be_reached_with_one_mark_at_t); else -> t(R.string.needed_next_half_mark, uiMark(result.needed, decimals), uiMark(result.neededHalf, decimals)) }, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 16.dp))
                        if (model.desk.showPluspunkte && course.promotion && result.pluspunkteAfter != null) Text(t(R.string.promotion_points_3, uiPlus(result.pluspunkteBefore ?: 0.0), uiPlus(result.pluspunkteAfter ?: 0.0)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                    } else Text(t(R.string.enter_an_average_from_1_6_and_a_positive_weight), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 12.dp))
                }
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
        AlertDialog(onDismissRequest = { adding = false }, modifier = Modifier.imePadding(), shape = MaterialTheme.shapes.extraLarge, title = { Text(t(R.string.add_a_local_mark), style = MaterialTheme.typography.headlineSmall) }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(t(R.string.only_used_for_your_scenario), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(title, { title = it }, label = { Text(t(R.string.label_optional)) }, singleLine = true, shape = MaterialTheme.shapes.small)
                OutlinedTextField(mark, { mark = it }, label = { Text(t(R.string.mark_1_to_6)) }, singleLine = true, shape = MaterialTheme.shapes.small, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                OutlinedTextField(factor, { factor = it }, label = { Text(t(R.string.weight_3)) }, singleLine = true, shape = MaterialTheme.shapes.small, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            }
        }, confirmButton = { TextButton(onClick = { model.addHypothetical(course.courseId, title.ifBlank { t(R.string.local_mark) }, number!!, w!!); adding = false }, enabled = number != null && number.isFinite() && number in 1.0..6.0 && w != null && w.isFinite() && w > 0) { Text(t(R.string.add)) } }, dismissButton = { TextButton(onClick = { adding = false }) { Text(t(R.string.cancel)) } })
    }
    if (customize) {
        var alias by rememberSaveable { mutableStateOf(courseAlias(course.label, model.desk.courseAliases)) }
        var chosen by rememberSaveable { mutableStateOf(subjectColor(course.label, overrides = model.colors)) }
        AlertDialog(onDismissRequest = { customize = false }, modifier = Modifier.imePadding(), shape = MaterialTheme.shapes.extraLarge, title = { Text(t(R.string.subject_appearance), style = MaterialTheme.typography.headlineSmall) }, text = {
            Column { OutlinedTextField(alias, { alias = it }, label = { Text(t(R.string.display_name)) }, shape = MaterialTheme.shapes.small); Spacer(Modifier.height(12.dp)); ColorChoices(SUBJECT_PALETTE.take(6), chosen) { chosen = it } }
        }, confirmButton = { TextButton(onClick = { model.renameCourse(course.label, alias); model.paintSubject(course.label, chosen); customize = false }) { Text(t(R.string.save)) } }, dismissButton = { TextButton(onClick = { customize = false }) { Text(t(R.string.cancel)) } })
    }
    if (confirmArchive) ConfirmDialog(t(R.string.archive_this_subject), t(R.string.it_leaves_your_list_overall_average_and_promotio), t(R.string.archive), { confirmArchive = false }) {
        model.archiveCourse(course.courseId)
        confirmArchive = false
        model.back()
    }
}

@Composable
fun SchoolRecordScreen(model: CompanionModel, page: Page) {
    val tally = remember(model.snapshot) { model.absencePoints() }
    val provisional = remember(model.snapshot, model.plannedAbsences) { model.provisionalPoints(LocalDate.now()) }
    var query by rememberSaveable(page) { mutableStateOf("") }
    var filter by rememberSaveable(page) { mutableStateOf("all") }
    var selected by remember { mutableStateOf<AgendaEntry?>(null) }
    val today = LocalDate.now()
    val online = LocalOnline.current
    RefreshableScreenList(model.syncing, { model.pullRefresh() }) {
        item(key = "head") {
            val stamp = updatedLabel(model.snapshot.fetchedAt)
            StatusLine(if (online) t(R.string.read_only_last_updated, stamp) else t(R.string.offline_last_updated, stamp), if (online) StateTone.Neutral else StateTone.Offline, Modifier.padding(bottom = 12.dp))
            if (page != Page.Statement) SearchField(query, { query = it }, t(R.string.search_page, page.uiTitle()))
        }
        when (page) {
            Page.Exams -> {
                item(key = "filter") { ChoiceRow(listOf("all" to t(R.string.all), "upcoming" to t(R.string.upcoming)), filter, { filter = it }, Modifier.padding(vertical = 6.dp)) }
                val events = (model.snapshot.exams + model.snapshot.events.filter { it.isExamLike() }).distinctBy(::lessonTargetId).filter { "${it.label} ${preferredEventTitle(it)} ${it.comment}".contains(query, true) && (filter == "all" || examHasDate(it.start).not() || (parseDisplayDate(it.start) ?: today) >= today) }.sortedWith(compareBy<AgendaEvent> { if (lessonTargetId(it) in model.highlightIds) 0 else 1 }.thenBy { examAlleKey(it.start) })
                if (events.isEmpty() && query.isBlank() && model.busy && model.snapshot.fetchedAt.isBlank()) item(key = "loading") { SkeletonRows(3, t(R.string.loading_exams)) }
                else if (events.isEmpty()) item(key = "empty") { EmptyState(Icons.AutoMirrored.Outlined.Assignment, t(R.string.no_exams_to_show), t(R.string.available_exam_dates_appear_after_your_school_is)) }
                itemsIndexed(events, key = { _, it -> lessonTargetId(it) }) { index, event ->
                    val entry = AgendaEntry("exam:${lessonTargetId(event)}", preferredEventTitle(event), AgendaKind.Exam, parseDisplayDate(event.start) ?: today, eventClock(event), detail = cleanSchulnetzText(event.room), school = event)
                    AgendaRow(model, entry, railPosition(index, events.size), showDay = true) { selected = entry }
                }
                schoolError(model, "Prüfungen:")
            }
            Page.Absences -> {
                val withPoints = tally.quota != null || model.snapshot.absences.any { it.points != null || it.pending }
                if (tally.shown && query.isBlank()) item(key = "points") { AbsencePointsSummary(tally, provisional) }
                if (query.isBlank() && provisional.items.any { it.state != PlannedState.Matched }) {
                    val listed = provisional.items.filter { it.state != PlannedState.Matched }.sortedBy { it.absence.date + it.absence.start }
                    item(key = "planned-head") { SectionLabel(t(R.string.planned_absences), count = listed.size) }
                    itemsIndexed(listed, key = { _, it -> "planned:${it.absence.id}" }) { index, item ->
                        val semantics = LocalCompanionSemantics.current
                        GroupItem(index, listed.size) {
                            Row(Modifier.fillMaxWidth().padding(start = 16.dp, top = 8.dp, bottom = 8.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(item.absence.subject.ifBlank { t(R.string.absence) }, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                    val day = runCatching { LocalDate.parse(item.absence.date) }.getOrNull()
                                    Text(listOf(day?.let { formatSchoolDate(it, "EEE, d MMM yyyy") } ?: item.absence.date, listOf(item.absence.start, item.absence.end).filter { it.isNotBlank() }.joinToString("–")).filter { it.isNotBlank() }.joinToString("  ·  "),
                                        style = TimeSmallStyle, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    if (item.state == PlannedState.NotEntered) Text(t(R.string.planned_absence_not_entered), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                                    else provisional.blockPoints(item.absence)?.let { Text(t(R.string.absence_points_estimate_value, it), style = MaterialTheme.typography.labelLarge, color = semantics.warning) }
                                }
                                IconButton(onClick = { model.removePlannedAbsence(item.absence.id) }) { Icon(Icons.Outlined.Close, t(R.string.planned_absence_remove)) }
                            }
                        }
                    }
                    item(key = "planned-gap") { Spacer(Modifier.height(8.dp)) }
                }
                item(key = "filter") { ChoiceRow(listOf("all" to t(R.string.all), "open" to t(R.string.open), "excused" to if (withPoints) t(R.string.absence_booked_tag) else t(R.string.excused)), filter, { filter = it }, Modifier.padding(vertical = 6.dp)) }
                val absences = model.snapshot.absences.filter { "${it.subject} ${it.reason} ${it.dateFrom}".contains(query, true) && when (filter) { "open" -> it.isOpen(); "excused" -> !it.isOpen(); else -> true } }
                    .sortedWith(compareBy<SchoolAbsence> { if (absenceTargetId(it) in model.highlightIds) 0 else 1 }.thenByDescending { parseDisplayDate(it.dateFrom) ?: java.time.LocalDate.MIN }.thenBy { it.hourFrom })
                // Older reads could give two reports of a double lesson the same id; keys stay unique.
                val keyed = absences.withIndex().groupBy { absenceTargetId(it.value) }.flatMap { (key, rows) -> rows.mapIndexed { at, row -> row.index to if (at == 0) key else "$key:$at" } }.sortedBy { it.first }.map { it.second }
                if (absences.isEmpty() && query.isBlank() && model.busy && model.snapshot.fetchedAt.isBlank()) item(key = "loading") { SkeletonRows(3, t(R.string.loading_absences)) }
                else if (absences.isEmpty()) item(key = "empty") { EmptyState(Icons.Outlined.EventAvailable, t(R.string.no_absences_to_show), t(R.string.your_available_absence_records_and_deadlines_wil)) }
                itemsIndexed(absences, key = { index, _ -> keyed[index] }) { index, absence ->
                    val highlighted = absenceTargetId(absence) in model.highlightIds
                    val estimate = tally.estimates[absence.id]
                    val semantics = LocalCompanionSemantics.current
                    GroupItem(index, absences.size) {
                        Column(Modifier.fillMaxWidth().background(if (highlighted) MaterialTheme.colorScheme.primaryContainer else Color.Transparent).padding(horizontal = 16.dp, vertical = 14.dp)) {
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(absence.subject.ifBlank { absence.reason.ifBlank { t(R.string.absence) } }, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                                when {
                                    absence.pending -> Tag(t(R.string.absence_estimated_open), semantics.warning)
                                    absence.points != null -> Tag(t(R.string.absence_booked_tag), MaterialTheme.colorScheme.primary)
                                    else -> Tag(if (absence.excused) t(R.string.excused) else t(R.string.open), if (absence.excused) semantics.success else semantics.warning)
                                }
                            }
                            Row(Modifier.fillMaxWidth().padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(listOf(absence.dateFrom, absence.dateTo.takeIf { it != absence.dateFrom }.orEmpty(), listOf(absence.hourFrom, absence.hourTo).filter { it.isNotBlank() }.joinToString("–")).filter { it.isNotBlank() }.joinToString("  ·  "),
                                    style = TimeSmallStyle, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                                val points = when {
                                    absence.pending && estimate != null && estimate.rule != "booked" -> t(R.string.absence_points_estimate_value, estimate.points)
                                    else -> absence.points?.let { t(R.string.absence_points_value, uiPoints(it)) }.orEmpty()
                                }
                                if (points.isNotBlank()) Text(points, style = MaterialTheme.typography.labelLarge, color = if (absence.pending) semantics.warning else MaterialTheme.colorScheme.onSurface)
                            }
                            if (absence.reason.isNotBlank() && absence.subject.isNotBlank()) Text(absence.reason, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp))
                            if (absence.pending && estimate != null) {
                                Text(estimateRuleText(estimate), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
                                if (estimate.reports > 1) Text(tp(R.plurals.absence_same_block, estimate.reports - 1, estimate.reports - 1), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (absence.excuseUntil.isNotBlank() && !absence.excused) Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(Icons.Outlined.Schedule, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.error)
                                Text(t(R.string.excuse_by, absence.excuseUntil), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(start = 6.dp))
                            }
                            if (absence.acknowledged && absence.points == null) Text(t(R.string.acknowledged_by_school), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                        }
                    }
                }
                schoolError(model, "Absenzen:")
            }
            Page.Updates -> {
                val messages = model.snapshot.messages.filter { "${it.title} ${it.body}".contains(query, true) }.sortedBy { if (messageTargetId(it) in model.highlightIds) 0 else 1 }
                if (messages.isNotEmpty()) item(key = "messages-head") { SectionLabel(t(R.string.messages), count = messages.size) }
                itemsIndexed(messages, key = { _, it -> messageTargetId(it) }) { index, message ->
                    val headline = messageHeadline(message.title, message.body)
                    val body = if (genericAppointmentTitle(message.title) && cleanSchulnetzText(message.body) == headline) "" else message.body
                    GroupItem(index, messages.size) { ExpandableRecord(shownText(headline).ifBlank { t(R.string.school_message) }, body, message.at, messageTargetId(message) in model.highlightIds) }
                }
                val announcements = model.snapshot.startMessages.filter { it.contains(query, true) }
                if (announcements.isNotEmpty()) item(key = "announcements-head") { SectionLabel(t(R.string.announcements), count = announcements.size) }
                itemsIndexed(announcements, key = { index, body -> "announcement:$index:${body.take(48)}" }) { index, body -> GroupItem(index, announcements.size) { ExpandableRecord(t(R.string.announcement_item), body) } }
                val events = model.snapshot.events.filter { !it.isLesson() && "${it.label} ${it.comment}".contains(query, true) }.sortedBy { it.start }
                if (events.isNotEmpty()) item(key = "events-head") { SectionLabel(t(R.string.school_events), count = events.size) }
                itemsIndexed(events, key = { _, it -> "update:${lessonTargetId(it)}" }) { index, event ->
                    val entry = AgendaEntry("school:${lessonTargetId(event)}", preferredEventTitle(event), if (event.isExamLike()) AgendaKind.Exam else AgendaKind.Event, parseDisplayDate(event.start) ?: today, eventClock(event), detail = dueLabel(event.start), school = event)
                    AgendaRow(model, entry, railPosition(index, events.size), showDay = true) { selected = entry }
                }
                val vacations = model.snapshot.vacations.filter { it.name.contains(query, true) }
                if (vacations.isNotEmpty()) item(key = "vacations-head") { SectionLabel(t(R.string.holidays), count = vacations.size) }
                itemsIndexed(vacations, key = { _, it -> "vacation:${it.id}" }) { index, vacation -> GroupItem(index, vacations.size) { ExpandableRecord(vacation.name, "${vacation.start} – ${vacation.end}") } }
                if (messages.isEmpty() && announcements.isEmpty() && events.isEmpty() && vacations.isEmpty()) item(key = "empty") {
                    if (query.isBlank() && model.busy && model.snapshot.fetchedAt.isBlank()) SkeletonRows(3, t(R.string.loading_updates))
                    else EmptyState(Icons.Outlined.Forum, t(R.string.all_quiet_here), t(R.string.school_announcements_messages_and_dates_will_app))
                }
            }
            Page.Statement -> {
                if (model.snapshot.konto.isEmpty()) item(key = "empty") {
                    if (model.busy && model.snapshot.fetchedAt.isBlank()) SkeletonRows(3, t(R.string.loading_statement))
                    else EmptyState(Icons.AutoMirrored.Outlined.ReceiptLong, t(R.string.no_statement_available), t(R.string.some_schools_do_not_provide_an_account_statement))
                }
                itemsIndexed(model.snapshot.konto, key = { index, line -> "konto:$index:${line.date}:${line.label}:${line.amount}" }) { index, line ->
                    GroupItem(index, model.snapshot.konto.size) {
                        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(line.label, style = MaterialTheme.typography.bodyLarge, maxLines = 3, overflow = TextOverflow.Ellipsis)
                                Text(line.date, style = TimeSmallStyle, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Column(horizontalAlignment = Alignment.End) {
                                Text(line.amount, style = TimeStyle, maxLines = 1)
                                if (line.balance.isNotBlank()) Text(t(R.string.balance, line.balance), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
            else -> Unit
        }
    }
    selected?.let { AgendaDetails(model, it) { selected = null } }
}

private fun androidx.compose.foundation.lazy.LazyListScope.schoolError(model: CompanionModel, prefix: String) {
    model.snapshot.readErrors.firstOrNull { it.startsWith(prefix) }?.let { error -> item(key = "error:$prefix") { Spacer(Modifier.height(16.dp)); InfoBanner(t(R.string.school_data_needs_attention), shownText(error), t(R.string.connection_details), true, onAction = { model.navigate(Page.Connections) }) } }
}

@Composable
private fun ExpandableRecord(title: String, body: String, date: String = "", highlighted: Boolean = false) {
    var expanded by rememberSaveable(title, body) { mutableStateOf(highlighted) }
    val motion = LocalKantiMotion.current
    Column(Modifier.fillMaxWidth().background(if (highlighted) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
        .clickable(role = Role.Button, enabled = body.isNotBlank()) { expanded = !expanded }
        .semantics { if (body.isNotBlank()) stateDescription = if (expanded) t(R.string.expanded) else t(R.string.collapsed) }
        .animateContentSize(motion.spec(motion.medium))
        .padding(horizontal = 16.dp, vertical = 14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f), maxLines = 3, overflow = TextOverflow.Ellipsis)
            if (body.isNotBlank()) Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, if (expanded) t(R.string.collapse) else t(R.string.expand), Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (date.isNotBlank()) Text(date.take(16).replace('T', ' '), style = TimeSmallStyle, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp))
        if (body.isNotBlank()) {
            if (expanded) SelectionContainer { Text(body, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 8.dp)) }
            else Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
        }
    }
}

/** "27 of 30 left" when Schulnetz shows a quota; the estimate for open reports is already subtracted. */
@Composable
fun absencePointsLeft(tally: AbsenceTally): String? {
    val quota = tally.quota ?: return null
    val remaining = tally.remaining ?: return null
    return t(R.string.absence_points_left, uiPoints(remaining), uiPoints(quota))
}

@Composable
private fun estimateRuleText(estimate: AbsenceEstimate): String = when (estimate.rule) {
    "exam" -> if (estimate.points < 10) t(R.string.absence_rule_exam_capped) else t(R.string.absence_rule_exam)
    "instrument" -> t(R.string.absence_rule_instrument)
    "special" -> if (estimate.points >= 9) t(R.string.absence_rule_special_full) else t(R.string.absence_rule_special_half)
    "fallback" -> t(R.string.absence_rule_fallback, estimate.lessons, estimate.points)
    "booked" -> t(R.string.absence_rule_booked)
    else -> if (estimate.lessons == 1) t(R.string.absence_rule_lesson, estimate.points) else t(R.string.absence_rule_lessons, estimate.lessons, estimate.points)
}

@Composable
private fun AbsencePointsSummary(tally: AbsenceTally, provisional: ProvisionalTally? = null) {
    val semantics = LocalCompanionSemantics.current
    Surface(color = MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.extraLarge, modifier = Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 12.dp)) {
        Column(Modifier.padding(20.dp)) {
            Text(t(R.string.absence_points), style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
            FlowRow(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(28.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                val quota = tally.quota
                val remaining = tally.remaining
                if (quota != null && remaining != null) MetricBlock(t(R.string.absence_points_remaining), "${uiPoints(remaining)} / ${uiPoints(quota)}", large = true,
                    valueColor = when { remaining < 0 -> MaterialTheme.colorScheme.error; tally.estimated > 0 -> semantics.warning; else -> MaterialTheme.colorScheme.onSurface })
                MetricBlock(t(R.string.absence_points_booked), uiPoints(tally.booked))
                MetricBlock(t(R.string.absence_points_estimated), if (tally.estimated > 0) "≈ ${tally.estimated}" else "0", valueColor = if (tally.estimated > 0) semantics.warning else MaterialTheme.colorScheme.onSurface)
                if (provisional != null && provisional.upcoming.isNotEmpty()) {
                    MetricBlock(t(R.string.absence_points_provisional), uiPoints(provisional.tally.total), valueColor = semantics.warning)
                    val left = provisional.tally.remaining
                    if (quota != null && left != null) MetricBlock(t(R.string.absence_points_provisional_remaining), "${uiPoints(left)} / ${uiPoints(quota)}",
                        valueColor = if (left < 0) MaterialTheme.colorScheme.error else semantics.warning)
                }
            }
            if (tally.openReports > 0) StatusLine(tp(R.plurals.absence_open_reports, tally.openReports, tally.openReports) + " · " + t(R.string.absence_points_estimate_value, tally.estimated), StateTone.Warning, Modifier.padding(top = 12.dp))
            Text(t(R.string.absence_points_explain), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp))
        }
    }
}
