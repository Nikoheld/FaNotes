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
            Text(profile?.displayName?.ifBlank { "Your school, in one place" } ?: "Your school, in one place", style = MaterialTheme.typography.headlineMedium)
            if (!profile?.className.isNullOrBlank()) Text(profile!!.className, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
            Text("Last updated ${updatedLabel(model.snapshot.fetchedAt)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp, bottom = 20.dp))
        }
        if (model.snapshot.fetchedAt.isBlank() || model.link.needsReauth) item {
            InfoBanner(if (model.link.needsReauth) "Sign in to refresh school data" else "Connect Schulnetz", "Bring your timetable and school records into FaNotes. School access stays read-only.", "Manage connection", onAction = { model.navigate(Page.Connections) })
        }
        item { SectionLabel("School records") }
        item { SettingRow(Icons.Outlined.Insights, "Grades", "Marks, subject averages & local scenarios", "${remember(model.snapshot.grades) { courseSummaries(model.snapshot.grades) }.size}") { model.navigate(Page.Grades) }; FineDivider() }
        item { SettingRow(Icons.AutoMirrored.Outlined.Assignment, "Exams", "Prepare for what's coming", "${(model.snapshot.exams + model.snapshot.events.filter { it.isExamLike() }).distinctBy(::lessonTargetId).size}") { model.navigate(Page.Exams) }; FineDivider() }
        item { SettingRow(Icons.Outlined.EventBusy, "Absences", "Status & excuse deadlines", "${model.snapshot.absences.count { !it.excused }} open") { model.navigate(Page.Absences) }; FineDivider() }
        item { SettingRow(Icons.Outlined.Forum, "Updates", "Messages, school events & holidays", "${model.snapshot.messages.size + model.snapshot.startMessages.size}") { model.navigate(Page.Updates) }; FineDivider() }
        item { SettingRow(Icons.AutoMirrored.Outlined.ReceiptLong, "School account", "Read your available account statement") { model.navigate(Page.Statement) } }
        item { SectionLabel("Plan with your school") }
        item { SettingRow(Icons.Outlined.DateRange, "Timetable", "Lessons alongside your own commitments") { model.openPlanner() } }
        item { SettingRow(Icons.Outlined.Checklist, "School assignments", "Copy assignments into your own task list") { model.openPlanner(true); model.taskSource = "school" } }
        item { SectionLabel("Connection") }
        item { SettingRow(Icons.Outlined.Link, "Schulnetz connection", if (model.link.needsReauth) "Sign in again to refresh" else if (model.link.linked || model.snapshot.fetchedAt.isNotBlank()) "School data cached on this device" else "Not connected") { model.navigate(Page.Connections) } }
    }
}

@Composable
fun GradesScreen(model: CompanionModel) {
    var query by rememberSaveable { mutableStateOf("") }
    val official = remember(model.snapshot.grades) { courseSummaries(model.snapshot.grades) }
    val courses = remember(official, model.desk.gradeSort, model.highlightIds, query, model.desk.courseAliases) {
        sortCourses(official, model.desk.gradeSort).sortedBy { if (it.marks.any { mark -> mark.targetId in model.highlightIds }) 0 else 1 }.filter { courseAlias(it.label, model.desk.courseAliases).contains(query, true) }
    }
    val totals = remember(official) { promotionTotals(official) }
    ScreenList {
        item {
            if (query.isBlank()) {
            Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                Column(Modifier.weight(1f)) {
                    Text("Overall average", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(formatMark(overallAverage(official), model.desk.gradeDecimals), style = MaterialTheme.typography.displayLarge, modifier = Modifier.padding(top = 4.dp))
                }
                if (model.desk.showPluspunkte) Column(horizontalAlignment = Alignment.End) {
                    Text("Promotion points", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(formatPluspunkte(totals.total), style = MaterialTheme.typography.headlineMedium, color = if (totals.total >= 0) LocalCompanionSemantics.current.success else MaterialTheme.colorScheme.error)
                }
            }
            Text("Calculated from your school marks. Local scenarios appear inside each subject.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 20.dp))
            }
            SearchField(query, { query = it }, "Find a subject")
            ChoiceRow(listOf("name" to "Subject", "average" to "Average", "pluspunkte" to "Points"), model.desk.gradeSort, { model.updateDesk(model.desk.copy(gradeSort = it)) })
        }
        if (courses.isEmpty()) item { EmptyState(Icons.Outlined.Insights, if (query.isBlank()) "No grades yet" else "No matching subjects", if (query.isBlank()) "Your available marks appear after connecting and refreshing Schulnetz." else "Try a different subject name.") }
        items(courses, key = { it.courseId }) { course ->
            val highlighted = course.marks.any { it.targetId in model.highlightIds }
            Row(Modifier.fillMaxWidth().background(if (highlighted) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.background, MaterialTheme.shapes.small).clickable { model.focusCourseId = course.courseId; model.navigate(Page.Course) }.padding(vertical = 18.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Box(Modifier.width(3.dp).height(36.dp).background(paletteColor(subjectColor(course.label, overrides = model.colors)), MaterialTheme.shapes.extraSmall))
                Column(Modifier.weight(1f)) {
                    Text(courseAlias(course.label, model.desk.courseAliases), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text("${course.marks.size} marks${if (model.hypothetical.any { it.courseId == course.courseId }) " · local scenario saved" else ""}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(formatMark(course.average, model.desk.gradeDecimals), style = MaterialTheme.typography.titleLarge, color = if ((course.average ?: 4.0) < 4.0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
                Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            FineDivider()
        }
        schoolError(model, "Noten:")
    }
}

@Composable
fun CourseScreen(model: CompanionModel) {
    val official = remember(model.snapshot.grades) { courseSummaries(model.snapshot.grades) }
    val course = official.firstOrNull { it.courseId == model.focusCourseId }
    if (course == null) { ScreenList { item { EmptyState(Icons.Outlined.Insights, "Subject unavailable", "It is no longer in the last school snapshot.", "All subjects") { model.back() } } }; return }
    val scenario = remember(model.snapshot.grades, model.hypothetical, course.courseId) { courseSummaries(model.snapshot.grades, model.hypothetical).first { it.courseId == course.courseId } }
    val decimals = model.desk.gradeDecimals
    val own = model.hypothetical.filter { it.courseId == course.courseId }
    var calculator by rememberSaveable { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    var customize by remember { mutableStateOf(false) }
    var target by rememberSaveable { mutableStateOf("5.0") }
    var weight by rememberSaveable { mutableStateOf("1") }
    ScreenList {
        item {
            Text(courseAlias(course.label, model.desk.courseAliases), style = MaterialTheme.typography.headlineMedium)
            FlowRow(Modifier.fillMaxWidth().padding(vertical = 18.dp), horizontalArrangement = Arrangement.spacedBy(28.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Column { Text("Average", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(formatMark(course.average, decimals), style = MaterialTheme.typography.headlineLarge) }
                Column { Text("Rounded", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(formatMark(course.zeugnis, decimals), style = MaterialTheme.typography.headlineLarge) }
                if (model.desk.showPluspunkte) Column { Text("Points", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(if (course.promotion) formatPluspunkte(course.pluspunkte) else "—", style = MaterialTheme.typography.headlineLarge) }
            }
            TextButton(onClick = { customize = true }) { Text("Subject name & color") }
            SectionLabel("School marks")
        }
        items(course.marks.filterNot { it.own }, key = { "${it.targetId}:${it.label}:${it.mark}" }) { mark ->
            val highlighted = mark.targetId in model.highlightIds
            Row(Modifier.fillMaxWidth().background(if (highlighted) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.background, MaterialTheme.shapes.small).padding(vertical = 14.dp, horizontal = if (highlighted) 12.dp else 0.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) { Text(mark.label.ifBlank { "School mark" }, style = MaterialTheme.typography.bodyLarge); Text("Weight ${formatMark(mark.weight)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                Text(formatMark(mark.mark, decimals), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            }
            FineDivider()
        }
        item { SectionLabel("What if?", "Add a mark") { adding = true } }
        item { Text("Explore a local scenario. Your school records stay unchanged.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (own.isNotEmpty()) {
            item {
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.padding(vertical = 12.dp)) {
                    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) { Text("Projected average", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium); Text(formatMark(scenario.average, decimals), style = MaterialTheme.typography.headlineMedium) }
                }
            }
            items(own, key = { it.id }) { extra ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) { Text(extra.title, style = MaterialTheme.typography.bodyLarge); Text("Local · ${formatMark(extra.mark, decimals)} · weight ${formatMark(extra.weight)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    ActionIcon(Icons.Outlined.Close, "Remove local mark ${extra.title}") { model.removeHypothetical(extra.id) }
                }
            }
        }
        item {
            SettingRow(Icons.Outlined.Calculate, "Target-grade calculator", if (calculator) "Tap to collapse" else "What mark would reach your target?") { calculator = !calculator }
            if (calculator) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(target, { target = it }, label = { Text("Target average") }, modifier = Modifier.weight(1f), singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                    OutlinedTextField(weight, { weight = it }, label = { Text("Next weight") }, modifier = Modifier.weight(1f), singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                }
                val goal = target.replace(',', '.').toDoubleOrNull()
                val factor = weight.replace(',', '.').toDoubleOrNull()
                if (goal != null && goal.isFinite() && goal in 1.0..6.0 && factor != null && factor.isFinite() && factor > 0) {
                    val result = wunschnote(scenario.marks, goal, factor)
                    Text(when { result.alreadyMet -> "Your current scenario already reaches this target."; !result.achievable -> "This target cannot be reached with one mark at this weight."; else -> "Needed next: ${formatMark(result.needed, decimals)} · half mark ${formatMark(result.neededHalf, decimals)}" }, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(vertical = 16.dp))
                    if (model.desk.showPluspunkte && course.promotion && result.pluspunkteAfter != null) Text("Promotion points ${formatPluspunkte(result.pluspunkteBefore ?: 0.0)} → ${formatPluspunkte(result.pluspunkteAfter ?: 0.0)}", style = MaterialTheme.typography.bodySmall)
                } else Text("Enter an average from 1–6 and a positive weight.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 12.dp))
            }
        }
    }
    if (adding) {
        var title by rememberSaveable { mutableStateOf("") }; var mark by rememberSaveable { mutableStateOf("") }; var factor by rememberSaveable { mutableStateOf("1") }
        val number = mark.replace(',', '.').toDoubleOrNull(); val w = factor.replace(',', '.').toDoubleOrNull()
        AlertDialog(onDismissRequest = { adding = false }, modifier = Modifier.imePadding(), title = { Text("Add a local mark") }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Only used for your scenario.", style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(title, { title = it }, label = { Text("Label (optional)") }, singleLine = true)
                OutlinedTextField(mark, { mark = it }, label = { Text("Mark · 1 to 6") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                OutlinedTextField(factor, { factor = it }, label = { Text("Weight") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
            }
        }, confirmButton = { TextButton(onClick = { model.addHypothetical(course.courseId, title.ifBlank { "Local mark" }, number!!, w!!); adding = false }, enabled = number != null && number.isFinite() && number in 1.0..6.0 && w != null && w.isFinite() && w > 0) { Text("Add") } }, dismissButton = { TextButton(onClick = { adding = false }) { Text("Cancel") } })
    }
    if (customize) {
        var alias by rememberSaveable { mutableStateOf(courseAlias(course.label, model.desk.courseAliases)) }
        var color by rememberSaveable { mutableStateOf(subjectColor(course.label, overrides = model.colors)) }
        AlertDialog(onDismissRequest = { customize = false }, modifier = Modifier.imePadding(), title = { Text("Subject appearance") }, text = {
            Column { OutlinedTextField(alias, { alias = it }, label = { Text("Display name") }); Spacer(Modifier.height(12.dp)); ColorChoices(SUBJECT_PALETTE.take(6), color, { color = it }) }
        }, confirmButton = { TextButton(onClick = { model.renameCourse(course.label, alias); model.paintSubject(course.label, color); customize = false }) { Text("Save") } }, dismissButton = { TextButton(onClick = { customize = false }) { Text("Cancel") } })
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
            Text("Schulnetz · read-only", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(bottom = 8.dp))
            Text("Last updated ${updatedLabel(model.snapshot.fetchedAt)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 16.dp))
            if (page != Page.Statement) SearchField(query, { query = it }, "Search ${page.title.lowercase()}")
        }
        when (page) {
            Page.Exams -> {
                item { ChoiceRow(listOf("all" to "All", "upcoming" to "Upcoming"), filter, { filter = it }) }
                val events = (model.snapshot.exams + model.snapshot.events.filter { it.isExamLike() }).distinctBy(::lessonTargetId).filter { "${it.label} ${it.comment}".contains(query, true) && (filter == "all" || (parseDisplayDate(it.start) ?: today) >= today) }.sortedWith(compareBy<AgendaEvent> { if (lessonTargetId(it) in model.highlightIds) 0 else 1 }.thenBy { it.start })
                if (events.isEmpty()) item { EmptyState(Icons.AutoMirrored.Outlined.Assignment, "No exams to show", "Available exam dates appear after your school is refreshed.") }
                items(events, key = { lessonTargetId(it) }) { event ->
                    val entry = AgendaEntry("exam:${lessonTargetId(event)}", event.label, AgendaKind.Exam, parseDisplayDate(event.start) ?: today, eventClock(event), detail = listOf(dueLabel(event.start), event.room).filter { it.isNotBlank() }.joinToString(" · "), school = event)
                    AgendaRow(model, entry) { selected = entry }
                }
                schoolError(model, "Prüfungen:")
            }
            Page.Absences -> {
                item { ChoiceRow(listOf("all" to "All", "open" to "Open", "excused" to "Excused"), filter, { filter = it }) }
                val absences = model.snapshot.absences.filter { "${it.subject} ${it.reason} ${it.dateFrom}".contains(query, true) && when (filter) { "open" -> !it.excused; "excused" -> it.excused; else -> true } }.sortedWith(compareBy<SchoolAbsence> { if (absenceTargetId(it) in model.highlightIds) 0 else 1 }.thenByDescending { it.dateFrom })
                if (absences.isEmpty()) item { EmptyState(Icons.Outlined.EventAvailable, "No absences to show", "Your available absence records and deadlines will appear here.") }
                items(absences, key = { absenceTargetId(it) }) { absence ->
                    val highlighted = absenceTargetId(absence) in model.highlightIds
                    Column(Modifier.fillMaxWidth().background(if (highlighted) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.background, MaterialTheme.shapes.small).padding(vertical = 16.dp, horizontal = if (highlighted) 12.dp else 0.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { Text(absence.subject.ifBlank { "Absence" }, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f)); Tag(if (absence.excused) "Excused" else "Open", if (absence.excused) LocalCompanionSemantics.current.success else LocalCompanionSemantics.current.warning) }
                        Text(listOf(absence.dateFrom, absence.dateTo.takeIf { it != absence.dateFrom }.orEmpty(), absence.hourFrom, absence.hourTo).filter { it.isNotBlank() }.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (absence.reason.isNotBlank()) Text(absence.reason, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 8.dp))
                        if (absence.excuseUntil.isNotBlank() && !absence.excused) Text("Excuse by ${absence.excuseUntil}", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp))
                        if (absence.acknowledged) Text("Acknowledged by school", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    FineDivider()
                }
                schoolError(model, "Absenzen:")
            }
            Page.Updates -> {
                val messages = model.snapshot.messages.filter { "${it.title} ${it.body}".contains(query, true) }.sortedBy { if (messageTargetId(it) in model.highlightIds) 0 else 1 }
                if (messages.isNotEmpty()) item { SectionLabel("Messages") }
                items(messages, key = { messageTargetId(it) }) { message -> ExpandableRecord(message.title.ifBlank { "School message" }, message.body, message.at, messageTargetId(message) in model.highlightIds) }
                val announcements = model.snapshot.startMessages.filter { it.contains(query, true) }
                if (announcements.isNotEmpty()) item { SectionLabel("Announcements") }
                itemsIndexed(announcements, key = { index, body -> "announcement:$index:${body.take(48)}" }) { _, body -> ExpandableRecord("Announcement", body) }
                val events = model.snapshot.events.filter { !it.isLesson() && "${it.label} ${it.comment}".contains(query, true) }.sortedBy { it.start }
                if (events.isNotEmpty()) item { SectionLabel("School events") }
                items(events, key = { "update:${lessonTargetId(it)}" }) { event ->
                    val entry = AgendaEntry("school:${lessonTargetId(event)}", event.label, if (event.isExamLike()) AgendaKind.Exam else AgendaKind.Event, parseDisplayDate(event.start) ?: today, eventClock(event), detail = dueLabel(event.start), school = event)
                    AgendaRow(model, entry) { selected = entry }
                }
                val vacations = model.snapshot.vacations.filter { it.name.contains(query, true) }
                if (vacations.isNotEmpty()) item { SectionLabel("Holidays") }
                items(vacations, key = { "vacation:${it.id}" }) { vacation -> ExpandableRecord(vacation.name, "${vacation.start} – ${vacation.end}") }
                if (messages.isEmpty() && announcements.isEmpty() && events.isEmpty() && vacations.isEmpty()) item { EmptyState(Icons.Outlined.Forum, "All quiet here", "School announcements, messages and dates will appear here.") }
            }
            Page.Statement -> {
                if (model.snapshot.konto.isEmpty()) item { EmptyState(Icons.AutoMirrored.Outlined.ReceiptLong, "No statement available", "Some schools do not provide an account statement through this integration. If available, it will appear after a refresh.") }
                itemsIndexed(model.snapshot.konto, key = { index, line -> "konto:$index:${line.date}:${line.label}:${line.amount}" }) { _, line ->
                    Column(Modifier.padding(vertical = 16.dp)) {
                        Text(line.date, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) { Text(line.label, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge); Text(line.amount, style = MaterialTheme.typography.titleMedium) }
                        if (line.balance.isNotBlank()) Text("Balance ${line.balance}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    FineDivider()
                }
            }
            else -> Unit
        }
    }
    selected?.let { AgendaDetails(model, it) { selected = null } }
}

private fun androidx.compose.foundation.lazy.LazyListScope.schoolError(model: CompanionModel, prefix: String) {
    model.snapshot.readErrors.firstOrNull { it.startsWith(prefix) }?.let { error -> item { Spacer(Modifier.height(16.dp)); InfoBanner("School data needs attention", error, "Connection details", true) { model.navigate(Page.Connections) } } }
}
@Composable
private fun ExpandableRecord(title: String, body: String, date: String = "", highlighted: Boolean = false) {
    var expanded by rememberSaveable(title, body) { mutableStateOf(highlighted) }
    Column(Modifier.fillMaxWidth().background(if (highlighted) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.background, MaterialTheme.shapes.small).clickable { expanded = !expanded }.padding(vertical = 16.dp, horizontal = if (highlighted) 12.dp else 0.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f), maxLines = 3, overflow = TextOverflow.Ellipsis)
            Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, if (expanded) "Collapse" else "Expand", Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (date.isNotBlank()) Text(date.take(16).replace('T', ' '), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (body.isNotBlank()) {
            if (expanded) SelectionContainer { Text(body, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 8.dp)) }
            else Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
        }
    }
    FineDivider()
}
