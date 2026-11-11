@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ch.fasrv.fanotes.companion

import androidx.compose.foundation.horizontalScroll
import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Assignment
import androidx.compose.material.icons.automirrored.outlined.Notes
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.desk.*
import ch.fasrv.fanotes.schulnetz.*
import java.time.*
import java.time.temporal.IsoFields
import kotlinx.coroutines.delay

/** Times Heute and Planer on the main thread. Recording stays off until diagnostic mode is on. */
private inline fun <T> traceAgenda(name: String, block: () -> T): T {
    if (!DiagnosticTrace.enabled) return block()
    val main = android.os.Looper.myLooper() == android.os.Looper.getMainLooper()
    val started = System.nanoTime()
    return try {
        val value = DiagnosticTrace.span("tab", name, block)
        if (main) {
            val elapsed = (System.nanoTime() - started) / 1_000_000L
            if (elapsed >= DiagnosticTrace.STALL_MS) DiagnosticTrace.record("main", name, elapsed, "slow")
        }
        value
    } catch (error: Throwable) {
        if (main) DiagnosticTrace.record("main", name, (System.nanoTime() - started) / 1_000_000L, "error", error.javaClass.simpleName)
        throw error
    }
}

@Composable
fun rememberNow(): Instant {
    val now by produceState(Instant.now()) { while (true) { delay(30_000); value = Instant.now() } }
    return now
}

/** What leads Heute. Missing timetable data is never shown as a free day. */
enum class TodayLead { Next, Unread, Connect, Clear }

fun todayLead(next: AgendaEntry?, schoolKnown: Boolean, unreadAhead: Boolean): TodayLead = when {
    next != null -> TodayLead.Next
    unreadAhead -> TodayLead.Unread
    !schoolKnown -> TodayLead.Connect
    else -> TodayLead.Clear
}

/** School days from [from] up to [until] (exclusive) whose timetable week was not read. */
fun unreadSchoolDayBefore(snapshot: SchulnetzSnapshot, from: LocalDate, until: LocalDate, today: LocalDate): Boolean {
    if (snapshot.fetchedAt.isBlank() && snapshot.weekRead.isEmpty() && snapshot.events.isEmpty()) return false
    var day = from
    var guard = 0
    while (day < until && guard < 21) {
        if (day.dayOfWeek.value < 6 && lessonWeekCoverage(snapshot, day, today) == WeekCoverage.UNREAD) return true
        day = day.plusDays(1); guard++
    }
    return false
}

/** No usable timetable yet: weeks ahead unread, or connected but never fetched. Never a free day. */
fun timetableMissing(snapshot: SchulnetzSnapshot, linked: Boolean, today: LocalDate): Boolean =
    upcomingTimetableUnread(snapshot, today) || (linked && snapshot.fetchedAt.isBlank())

private fun clockMinutes(raw: String): Int? = runCatching { LocalTime.parse(raw.take(5)).let { it.hour * 60 + it.minute } }.getOrNull()

@Composable
fun TodayScreen(model: CompanionModel) {
    val now = rememberNow()
    val absenceTally = remember(model.snapshot) { absenceTally(model.snapshot) }
    val zone = ZoneId.systemDefault()
    val today = now.atZone(zone).toLocalDate()
    val sync by model.graph.engine.state.collectAsStateWithLifecycle()
    val online = LocalOnline.current
    val context = LocalContext.current
    val cards = shownTodayCards(model.desk)
    val agenda = remember(model.snapshot, model.calendar, model.tasks, model.hidden, today) {
        traceAgenda("today") {
            model.cachedAgenda((0L..14L).map { today.plusDays(it) }, zone).values.flatten()
        }
    }
    val next = if ("lessons" in cards) nextCommitment(agenda, now, zone) else null
    val schoolKnown = model.snapshot.fetchedAt.isNotBlank() || model.link.linked
    val unreadAhead = remember(model.snapshot, model.link.linked, today) { timetableMissing(model.snapshot, model.link.linked, today) }
    val lead = todayLead(next, schoolKnown, unreadAhead)
    val urgent = sortHomeworkTasks(model.tasks.filter { !it.done }).sortedBy { when (taskBucket(it, today)) { "Overdue" -> 0; "Today" -> 1; "Upcoming" -> 2; else -> 3 } }
    var selected by remember { mutableStateOf<AgendaEntry?>(null) }
    var task by remember { mutableStateOf<HomeworkTask?>(null) }
    val recent = remember(model.tree) { flattenNotes(model.tree).sortedByDescending { it.modifiedAt }.take(3) }
    var allowed by remember { mutableStateOf(CompanionAlerts.notificationsAllowed(context)) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        allowed = CompanionAlerts.notificationsAllowed(context)
        if (granted) model.onNotificationsAllowed()
        model.dismissNotifyTip()
    }
    androidx.compose.runtime.LaunchedEffect(model.desk.showMensa) { model.refreshMensa() }
    RefreshableScreenList(model.syncing, { model.pullRefresh() }) {
        // One item that is always first, so a status or banner that appears after the snapshot
        // loads is shown above the card instead of being inserted off-screen.
        item(key = "top") {
            Column(Modifier.fillMaxWidth()) {
                if (schoolKnown) {
                    val stamp = updatedLabel(model.snapshot.fetchedAt)
                    if (online) SyncStamp(model.syncing, model.lastSyncOk, stamp, Modifier.padding(bottom = 12.dp))
                    else StatusLine(t(R.string.offline_last_updated, stamp), StateTone.Offline, Modifier.padding(bottom = 12.dp))
                }
                val syncCopy = faNotesSyncCopy(sync.status, model.notesAccount)
                if (model.demo) Box(Modifier.padding(bottom = 12.dp)) { InfoBanner(t(R.string.demo_active_title), t(R.string.demo_active_body), t(R.string.demo_end), tone = StateTone.Warning, onAction = { model.stopDemo() }) }
                if (model.link.needsReauth) Box(Modifier.padding(bottom = 12.dp)) { InfoBanner(t(R.string.reconnect_your_school), t(R.string.your_last_school_data_is_still_here), t(R.string.sign_in), tone = StateTone.Warning, onAction = { model.navigate(Page.Connections) }) }
                else if (syncCopy != null) Box(Modifier.padding(bottom = 12.dp)) { InfoBanner(t(syncCopy.first), t(syncCopy.second), t(R.string.account_sync), error = syncCopy.third, tone = if (syncCopy.third) StateTone.Error else StateTone.Offline, onAction = { model.navigate(Page.Connections) }) }
                if (model.schoolReady && lead == TodayLead.Next && !model.notesAccount && !model.link.linked && model.snapshot.fetchedAt.isBlank() && !model.link.needsReauth) Box(Modifier.padding(bottom = 12.dp)) {
                    InfoBanner(t(R.string.your_school_day), t(R.string.connect_schulnetz_to_see_grades_the_timetable_ex), if (model.busy) null else t(R.string.connect_schulnetz), onAction = { model.requestVisibleLogin("today") })
                }
                if (model.link.linked && !allowed && !model.notifyTipDismissed && Build.VERSION.SDK_INT >= 33) Box(Modifier.padding(bottom = 12.dp)) {
                    InfoBanner(t(R.string.notify_tip_title), t(R.string.notify_tip_body), t(R.string.allow_notifications), onAction = { permission.launch(Manifest.permission.POST_NOTIFICATIONS) })
                }
            }
        }
        val ready = model.schoolReady && !model.loading
        if ("lessons" in cards) item(key = "lead") {
            if (!ready) Surface(color = MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.extraLarge, modifier = Modifier.fillMaxWidth()) {
                Box(Modifier.padding(horizontal = 20.dp, vertical = 8.dp)) { SkeletonRows(2) }
            } else when (lead) {
                TodayLead.Next -> {
                    val entry = next!!
                    val dayLessons = agenda.filter { it.day == entry.day && it.kind == AgendaKind.Lesson && it.start.isNotBlank() }
                    val gapUnread = remember(model.snapshot, today, entry.day) { unreadSchoolDayBefore(model.snapshot, today, entry.day, today) }
                    Box {
                        NextHero(model, entry, now, zone, dayLessons) { selected = entry }
                        if (LocalCompanionSemantics.current.snow && model.snowfall && !LocalKantiMotion.current.reduced) Snowfall(Modifier.matchParentSize().clip(MaterialTheme.shapes.extraLarge))
                    }
                    if (gapUnread) StatusLine(t(R.string.unread_before_next), StateTone.Warning, Modifier.padding(top = 10.dp, start = 4.dp))
                    val strip = remember(model.snapshot, model.hidden, now.epochSecond / 60) { widgetRows(model.snapshot.events, model.snapshot.exams, model.hidden, now, zone) }
                    if (strip.count { !it.heading } >= 2) LessonStrip(strip, today, Modifier.padding(top = 12.dp))
                }
                TodayLead.Unread -> LeadCard(Icons.Outlined.EventBusy, StateTone.Warning, t(R.string.timetable_not_loaded), if (online) t(R.string.timetable_not_loaded_body) else t(R.string.offline_waiting),
                    if (!model.busy) t(R.string.refresh_school_data) else null) { model.refreshSchool() }
                TodayLead.Connect -> LeadCard(Icons.Outlined.School, StateTone.Accent, t(R.string.your_school_day), t(R.string.connect_schulnetz_to_see_grades_the_timetable_ex),
                    if (!model.busy) t(R.string.connect_schulnetz) else null) { model.requestVisibleLogin("today") }
                TodayLead.Clear -> LeadCard(Icons.Outlined.WbSunny, StateTone.Neutral, t(R.string.room_to_breathe), t(R.string.no_upcoming_commitments_in_your_planner), null) {}
            }
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = { model.openPlanner() }) {
                    Text(t(R.string.open_today_s_schedule), style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Icon(Icons.Outlined.ChevronRight, null, Modifier.padding(start = 2.dp).size(18.dp))
                }
            }
        }
        if ("tasks" in cards) {
            item(key = "tasks-head") { SectionLabel(t(R.string.on_your_list), if (urgent.isEmpty()) t(R.string.tasks) else t(R.string.all_2, urgent.size)) { model.openPlanner(true) } }
            if (!ready) item(key = "tasks-loading") { SkeletonRows(2) }
            else if (urgent.isEmpty()) item(key = "tasks-empty") {
                Group { Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.CheckCircleOutline, null, tint = LocalCompanionSemantics.current.success)
                    Text(t(R.string.you_re_all_caught_up), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                } }
            }
            val shown = urgent.take(3)
            itemsIndexed(shown, key = { _, item -> "today-task:${item.id}" }) { index, item ->
                GroupItem(index, shown.size) { TaskRow(item, today, { model.toggleTask(item) }, colors = model.colors) { task = item } }
            }
            if (model.snapshot.homework.isNotEmpty()) item(key = "tasks-school") {
                TextButton(onClick = { model.openPlanner(true); model.taskSource = "school" }, modifier = Modifier.padding(top = 4.dp)) {
                    Icon(Icons.AutoMirrored.Outlined.Assignment, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp))
                    Text(tp(R.plurals.assignments_review, model.snapshot.homework.size, model.snapshot.homework.size), style = MaterialTheme.typography.labelLarge)
                }
            }
        }
        if ("exam" in cards) {
            val clockNow = now.atZone(zone).toLocalTime().let { "%02d:%02d".format(it.hour, it.minute) }
            val exams = agenda.filter { it.kind == AgendaKind.Exam && it.key != next?.key && it.school?.isCancelled() != true &&
                (it.day > today || (it.day == today && it.end.ifBlank { it.start.ifBlank { "23:59" } } >= clockNow)) }
                .sortedWith(compareBy<AgendaEntry> { it.day }.thenBy { it.start }).take(2)
            if (exams.isNotEmpty()) {
                item(key = "exam-head") { SectionLabel(t(R.string.coming_into_view)) }
                itemsIndexed(exams, key = { _, it -> "today-exam:${it.key}" }) { index, exam ->
                    AgendaRow(model, exam, railPosition(index, exams.size), showDay = true) { selected = exam }
                }
            }
        }
        if (model.desk.showMensa) {
            val mensaDay = model.mensa?.let { feed -> ch.fasrv.fanotes.schulnetz.pickMensaDay(feed.days, now.atZone(ZoneId.of("Europe/Zurich")).toLocalDateTime()) }
            if (mensaDay != null) item(key = "mensa") { MensaCard(mensaDay) }
        }
        val gradesShown = "grades" in cards && model.snapshot.grades.isNotEmpty()
        val pointsShown = "pluspunkte" in cards && model.desk.showPluspunkte && model.snapshot.grades.isNotEmpty()
        val updates = model.snapshot.messages.size + model.snapshot.startMessages.size
        val updatesShown = "events" in cards && updates > 0
        val absencesShown = "absences" in cards && absenceTally.quota != null && absenceTally.remaining != null
        if (gradesShown || pointsShown || updatesShown || absencesShown) {
            item(key = "school-head") { SectionLabel(t(R.string.from_school)) }
            item(key = "school-group") {
                val courses = remember(model.snapshot.grades, model.gradeBook, model.unrevealedIds, model.settings.guessGrades) { activeCourses(courseSummaries(model.snapshot.grades, hiddenTargetIds = model.hiddenGradeIds(), book = model.gradeBook)) }
                Group {
                    if (gradesShown) SettingRow(Icons.Outlined.Insights, t(R.string.your_grades), tp(R.plurals.subjects_review, courses.size, courses.size)) { model.navigate(Page.Grades) }
                    if (pointsShown) {
                        if (gradesShown) FineDivider()
                        val total = remember(courses) { promotionTotals(courses) }
                        SettingRow(Icons.Outlined.Balance, t(R.string.promotion_points_2), "", uiPlus(total.total), trailingColor = if (total.total >= 0) LocalCompanionSemantics.current.success else MaterialTheme.colorScheme.error) { model.navigate(Page.Grades) }
                    }
                    if (absencesShown) {
                        if (gradesShown || pointsShown) FineDivider()
                        val subtitle = if (absenceTally.estimated > 0) t(R.string.absence_points_summary, uiPoints(absenceTally.booked), "≈ ${absenceTally.estimated}") else t(R.string.absence_points_summary, uiPoints(absenceTally.booked), "0")
                        SettingRow(Icons.Outlined.EventBusy, t(R.string.absence_points), subtitle, absencePointsLeft(absenceTally).orEmpty(),
                            tone = if (absenceTally.estimated > 0) StateTone.Warning else StateTone.Neutral,
                            trailingColor = if ((absenceTally.remaining ?: 0.0) < 0) MaterialTheme.colorScheme.error else if (absenceTally.estimated > 0) LocalCompanionSemantics.current.warning else null) { model.navigate(Page.Absences) }
                    }
                    if (updatesShown) {
                        if (gradesShown || pointsShown || absencesShown) FineDivider()
                        SettingRow(Icons.Outlined.NotificationsNone, t(R.string.school_updates), tp(R.plurals.messages_announcements, updates, updates)) { model.navigate(Page.Updates) }
                    }
                }
            }
        }
        if (model.notesAccount) {
            item(key = "notes-head") { SectionLabel(t(R.string.pick_up_a_note), t(R.string.library)) { model.select(Destination.Notes) } }
            if (recent.isEmpty()) item(key = "notes-empty") { Text(t(R.string.your_notes_will_be_waiting_here_capture_an_idea), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp)) }
            itemsIndexed(recent, key = { _, it -> "recent:${it.path}" }) { index, node -> GroupItem(index, recent.size) { NoteRow(model, node) { model.openNote(node.path) } } }
        }
    }
    selected?.let { AgendaDetails(model, it) { selected = null } }
    task?.let { TaskForm(model, it) { task = null } }
}

/** Compact Mensa card: weekday and date, then each dish as label chip, name, short description and student price. */
@Composable
private fun MensaCard(day: ch.fasrv.fanotes.schulnetz.MensaDay) {
    val scheme = MaterialTheme.colorScheme
    val dayTitle = day.date.format(java.time.format.DateTimeFormatter.ofPattern("EEEE, d. MMMM", java.util.Locale.getDefault()))
    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        SectionLabel(t(R.string.mensa_title))
        Group {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(dayTitle, style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant, modifier = Modifier.semantics { heading() })
                if (day.closed) Text(day.note.ifBlank { t(R.string.mensa_closed) }, style = MaterialTheme.typography.bodyMedium)
                day.menus.forEach { menu ->
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                        Column(Modifier.weight(1f)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                if (menu.label.isNotBlank()) Surface(color = scheme.secondaryContainer, shape = MaterialTheme.shapes.small) {
                                    Text(menu.label, style = MaterialTheme.typography.labelSmall, color = scheme.onSecondaryContainer, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
                                }
                                Text(menu.name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f, fill = false))
                            }
                            if (menu.description.isNotBlank()) Text(menu.description, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
                        }
                        menu.studentPrice?.let { Text(t(R.string.mensa_student_price, ch.fasrv.fanotes.schulnetz.mensaPrice(it)), style = MaterialTheme.typography.labelMedium, color = scheme.onSurfaceVariant) }
                    }
                }
            }
        }
    }
}

@Composable
private fun LeadCard(icon: androidx.compose.ui.graphics.vector.ImageVector, tone: StateTone, title: String, body: String, action: String?, onAction: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.extraLarge, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(20.dp)) {
            IconTile(icon, tone, 44.dp)
            Text(title, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(top = 16.dp).semantics { heading() })
            Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
            if (action != null) PrimaryButton(action, onAction, Modifier.padding(top = 18.dp))
        }
    }
}

private fun entryRoom(entry: AgendaEntry): String = entry.school?.let { cleanSchulnetzText(it.room) } ?: entry.local?.location.orEmpty()
private fun entryPeople(entry: AgendaEntry): String = entry.school?.teachers?.joinToString(", ") { cleanSchulnetzText(it) }.orEmpty()

/** The one prominent block on Heute: the next commitment, its countdown and the day band. */
@Composable
private fun NextHero(model: CompanionModel, entry: AgendaEntry, now: Instant, zone: ZoneId, dayLessons: List<AgendaEntry>, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val s = LocalCompanionSemantics.current
    val today = now.atZone(zone).toLocalDate()
    val clock = now.atZone(zone).toLocalTime().let { it.hour * 60 + it.minute }
    val start = clockMinutes(entry.start)
    val end = clockMinutes(entry.end)
    val running = entry.day == today && start != null && start <= clock && (end == null || clock < end)
    val label = when {
        running -> t(R.string.now_label)
        entry.day == today -> t(R.string.up_next)
        else -> dueLabel(entry.day.toString())
    }
    val countdown = when {
        running && end != null -> t(R.string.ends_in_minutes, end - clock)
        entry.day == today && start != null && start > clock -> if (start - clock < 60) t(R.string.starts_in_minutes, start - clock) else t(R.string.starts_in_hours, (start - clock + 30) / 60)
        else -> ""
    }
    val room = entryRoom(entry)
    val people = entryPeople(entry)
    val cancelled = entry.school?.isCancelled() == true
    Surface(onClick = onClick, color = scheme.primaryContainer, shape = MaterialTheme.shapes.extraLarge,
        modifier = Modifier.fillMaxWidth().then(if (s.snow) Modifier.border(1.dp, scheme.primary.copy(alpha = 0.16f), MaterialTheme.shapes.extraLarge) else Modifier)) {
        Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (running) Box(Modifier.size(8.dp).background(scheme.primary, CircleShape))
                Text(label, style = MaterialTheme.typography.labelLarge, color = scheme.primary, modifier = Modifier.padding(start = if (running) 8.dp else 0.dp).weight(1f))
                if (countdown.isNotBlank()) Text(countdown, style = MaterialTheme.typography.labelLarge, color = scheme.onSurface)
            }
            FlowRow(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.SpaceBetween, itemVerticalAlignment = Alignment.Bottom) {
                Text(entry.start.ifBlank { t(R.string.all_day) }, style = if (entry.start.isBlank()) MaterialTheme.typography.headlineMedium else MaterialTheme.typography.displayLarge,
                    color = scheme.onSurface, maxLines = 1, softWrap = false, modifier = Modifier.padding(end = 12.dp))
                if (room.isNotBlank()) RoomPill(room, Modifier.padding(bottom = 8.dp))
            }
            Text(courseAlias(entry.title, model.desk.courseAliases), style = MaterialTheme.typography.headlineSmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
                textDecoration = if (cancelled) TextDecoration.LineThrough else TextDecoration.None, modifier = Modifier.padding(top = 2.dp))
            val meta = listOfNotNull(entry.end.takeIf { it.isNotBlank() && it != entry.start }?.let { t(R.string.until_time, it) }, people.takeIf { it.isNotBlank() }, if (entry.kind != AgendaKind.Lesson) entry.kind.uiLabel() else null)
            if (meta.isNotEmpty()) Text(meta.joinToString("  ·  "), style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
            if (cancelled || entry.school?.isSubstitution() == true) Row(Modifier.padding(top = 10.dp)) {
                if (cancelled) Tag(t(R.string.cancelled), scheme.error) else Tag(t(R.string.substitution), s.warning)
            }
            if (dayLessons.size >= 2) DayBand(dayLessons, if (entry.day == today) clock else -1, entry.key, Modifier.padding(top = 18.dp))
        }
    }
}

/** All remaining lessons of today, then the next school day, as one sideways scroll under the hero. */
@Composable
private fun LessonStrip(rows: List<WidgetRow>, today: LocalDate, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val s = LocalCompanionSemantics.current
    LazyRow(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        itemsIndexed(rows, key = { index, row -> "strip:$index:${row.day}:${row.event?.id.orEmpty()}" }) { _, row ->
            if (row.heading) {
                val heading = if (row.day == today.plusDays(1)) t(R.string.tomorrow) else row.day.dayOfWeek.getDisplayName(java.time.format.TextStyle.FULL, java.util.Locale.getDefault())
                Box(Modifier.height(64.dp).padding(horizontal = 4.dp), contentAlignment = Alignment.CenterStart) {
                    Text(heading, style = MaterialTheme.typography.labelLarge, color = scheme.primary, maxLines = 1)
                }
            } else {
                val accent = when { row.cancelled -> scheme.error; row.exam -> s.warning; else -> scheme.onSurfaceVariant }
                Surface(color = scheme.surfaceVariant.copy(alpha = 0.5f), shape = MaterialTheme.shapes.large) {
                    Column(Modifier.widthIn(min = 112.dp, max = 168.dp).padding(horizontal = 12.dp, vertical = 8.dp)) {
                        Text(row.clock.ifBlank { t(R.string.all_day) }, style = TimeStyle, color = accent, maxLines = 1)
                        Text(row.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            textDecoration = if (row.cancelled) TextDecoration.LineThrough else TextDecoration.None)
                        Text(listOf(row.room.takeIf { it.isNotBlank() }, if (row.exam) t(R.string.exam) else null).filterNotNull().joinToString(" · ").ifBlank { " " },
                            style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

@Composable
fun RoomPill(room: String, modifier: Modifier = Modifier) {
    Row(modifier.border(1.dp, MaterialTheme.colorScheme.outline, CircleShape).padding(horizontal = 12.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.MeetingRoom, null, Modifier.size(15.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(room, style = TimeStyle, color = MaterialTheme.colorScheme.onSurface, maxLines = 1, modifier = Modifier.padding(start = 6.dp).semantics { contentDescription = t(R.string.room_named, room) })
    }
}

/** The day as one measured line: one segment per lesson, past ones muted, the current or next one raised. */
@Composable
fun DayBand(lessons: List<AgendaEntry>, clock: Int, focusKey: String, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val sorted = lessons.sortedBy { it.start }
    val past = sorted.count { (clockMinutes(it.end) ?: clockMinutes(it.start) ?: 0) <= clock }
    val description = tp(R.plurals.day_band, sorted.size, sorted.size, past)
    Column(modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = description }) {
        Row(Modifier.fillMaxWidth().height(14.dp), horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
            sorted.forEach { lesson ->
                val end = clockMinutes(lesson.end) ?: clockMinutes(lesson.start) ?: 0
                val start = clockMinutes(lesson.start) ?: 0
                val done = end <= clock
                val focus = lesson.key == focusKey || (start <= clock && clock < end)
                val cancelled = lesson.school?.isCancelled() == true
                val color = when {
                    cancelled -> scheme.error.copy(alpha = 0.45f)
                    focus -> scheme.primary
                    done -> scheme.onSurface.copy(alpha = 0.22f)
                    else -> scheme.onSurface.copy(alpha = 0.09f)
                }
                Box(Modifier.weight(1f).height(if (focus) 14.dp else 8.dp).background(color, CircleShape))
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
            Text(sorted.first().start, style = TimeSmallStyle, color = scheme.onSurfaceVariant)
            Spacer(Modifier.weight(1f))
            Text(sorted.last().end.ifBlank { sorted.last().start }, style = TimeSmallStyle, color = scheme.onSurfaceVariant)
        }
    }
}

@Composable
fun PlannerScreen(model: CompanionModel) {
    Column(Modifier.fillMaxSize()) {
        SegmentedTabs(listOf("schedule" to t(R.string.schedule_tab), "tasks" to t(R.string.tasks)), if (model.plannerTasks) "tasks" else "schedule",
            { model.plannerTasks = it == "tasks" }, Modifier.padding(horizontal = Space.page, vertical = 6.dp))
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (model.plannerTasks) TasksScreen(model) else ScheduleScreen(model)
        }
    }
}

enum class RailPosition { Single, First, Middle, Last }
fun railPosition(index: Int, count: Int): RailPosition = when {
    count <= 1 -> RailPosition.Single
    index == 0 -> RailPosition.First
    index == count - 1 -> RailPosition.Last
    else -> RailPosition.Middle
}

private sealed interface DayItem {
    data class Entry(val entry: AgendaEntry, val position: RailPosition) : DayItem
    data class Gap(val key: String, val minutes: Int) : DayItem
    data class Now(val key: String, val clock: String) : DayItem
}

/** Adds free periods of 30 minutes or more and a now marker on today. Only between known lessons. */
private fun dayItems(entries: List<AgendaEntry>, today: Boolean, clock: Int): List<DayItem> {
    val out = mutableListOf<DayItem>()
    // A running lesson is already marked "Jetzt"; a second now line would repeat it.
    val running = today && entries.any { e -> val s = clockMinutes(e.start); val f = clockMinutes(e.end); s != null && f != null && clock in s until f }
    var nowPlaced = !today || running
    var lastEnd: Int? = null
    entries.forEachIndexed { index, entry ->
        val start = clockMinutes(entry.start)
        if (!nowPlaced && start != null && start > clock) {
            out += DayItem.Now("now:${entry.key}", "%02d:%02d".format(clock / 60, clock % 60)); nowPlaced = true
        }
        if (lastEnd != null && start != null && entry.kind == AgendaKind.Lesson && start - lastEnd!! >= 30) out += DayItem.Gap("gap:${entry.key}", start - lastEnd!!)
        out += DayItem.Entry(entry, railPosition(index, entries.size))
        if (entry.kind == AgendaKind.Lesson) clockMinutes(entry.end)?.let { lastEnd = maxOf(lastEnd ?: 0, it) }
    }
    return out
}

@Composable
private fun ScheduleScreen(model: CompanionModel) {
    var source by rememberSaveable { mutableStateOf("all") }
    var picker by remember { mutableStateOf(false) }
    var sourceMenu by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<AgendaEntry?>(null) }
    val zone = ZoneId.systemDefault()
    val now = rememberNow()
    val today = now.atZone(zone).toLocalDate()
    val clock = now.atZone(zone).toLocalTime().let { it.hour * 60 + it.minute }
    val days = schoolWeek(model.day, true)
    val agenda = remember(model.day, model.snapshot, model.calendar, model.tasks, model.hidden) {
        traceAgenda("schedule") {
            model.cachedAgenda(days, zone)
        }
    }
    // Coverage scans every event; compute it once per snapshot and week, not on each clock tick.
    val coverage = remember(model.snapshot, days, today) { days.associateWith { lessonWeekCoverage(model.snapshot, it, today) } }
    val listState = rememberLazyListState()
    val dayKey = model.day.toString()
    // The last selected day and its scroll position are restored on purpose.
    // Changing the day must not keep the previous day's offset, which clips the new top row.
    var scrolledDay by rememberSaveable { mutableStateOf(dayKey) }
    LaunchedEffect(dayKey) {
        if (scrolledDay != dayKey) {
            scrolledDay = dayKey
            listState.scrollToItem(0)
        }
    }
    val sources = listOf("all" to t(R.string.all), "school" to t(R.string.school), "personal" to t(R.string.personal), "due" to t(R.string.deadlines))
    BoxWithConstraints(Modifier.fillMaxSize()) {
    val compact = maxHeight < 350.dp
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = Space.page - 4.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).clip(MaterialTheme.shapes.small).clickable(role = Role.Button) { picker = true }.padding(horizontal = 4.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f, fill = false)) {
                    Text(formatSchoolDate(model.day, if (compact) "EEE, d MMM" else "MMMM yyyy"), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (!compact) Text(t(R.string.calendar_week_short, model.day.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Icon(Icons.Outlined.ExpandMore, t(R.string.go_to_date), Modifier.padding(start = 4.dp).size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (compact) Box {
                ActionIcon(Icons.Outlined.FilterList, t(R.string.schedule_sources, source)) { sourceMenu = true }
                DropdownMenu(sourceMenu, { sourceMenu = false }) {
                    listOf("all" to t(R.string.all_entries), "school" to t(R.string.school), "personal" to t(R.string.personal), "due" to t(R.string.deadlines)).forEach { (id, label) ->
                        DropdownMenuItem(text = { Text(label) }, leadingIcon = { if (source == id) Icon(Icons.Outlined.Check, null) }, onClick = { source = id; sourceMenu = false })
                    }
                }
            }
            ActionIcon(Icons.Outlined.ChevronLeft, if (compact) t(R.string.previous_day) else t(R.string.previous_week)) { model.day = if (compact) model.day.minusDays(1) else model.day.minusWeeks(1) }
            if (model.day != today) TextButton(onClick = { model.day = today; model.planWeek = false }) { Text(t(R.string.today), style = MaterialTheme.typography.labelLarge) }
            ActionIcon(Icons.Outlined.ChevronRight, if (compact) t(R.string.next_day) else t(R.string.next_week)) { model.day = if (compact) model.day.plusDays(1) else model.day.plusWeeks(1) }
        }
        if (!compact) {
            WeekStrip(days, model.day, today, agenda, coverage) { model.day = it; model.planWeek = false }
            ChoiceRow(sources, source, { source = it }, Modifier.padding(horizontal = Space.page))
        }
        HorizontalDivider(color = LocalCompanionSemantics.current.hairline)
        // weight keeps the list in the space under the week header. fillMaxSize alone
        // extends past the screen, so the bottom padding never clears "Neuer Termin".
        RefreshableScreenList(model.syncing, { model.pullRefresh() }, Modifier.weight(1f), listModifier = Modifier.pointerInput(compact, model.day) {
            var drag = 0f
            detectHorizontalDragGestures(
                onHorizontalDrag = { _, amount -> drag += amount },
                onDragEnd = {
                    val threshold = 72.dp.toPx()
                    if (drag <= -threshold) model.day = if (compact) model.day.plusDays(1) else model.day.plusWeeks(1)
                    else if (drag >= threshold) model.day = if (compact) model.day.minusDays(1) else model.day.minusWeeks(1)
                    drag = 0f
                },
                onDragCancel = { drag = 0f },
            )
        }, listState) {
            val weekDays = schoolWeek(model.day, true)
            val weekRange = formatSchoolDate(weekDays.first(), "d MMM") + " – " + formatSchoolDate(weekDays.last(), "d MMM")
            val heading = when {
                !model.planWeek -> dateLabel(model.day)
                plannerWeekIsCurrent(model.day, today) -> t(R.string.this_week)
                else -> weekRange
            }
            // Several school connections: switch the one shown here; each keeps syncing on its own.
            if (model.connections.connections.size > 1) item(key = "connection-switch") {
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    model.connections.connections.forEach { connection ->
                        Pill(connection.label, connection.id == model.connections.active?.id) { model.showConnection(connection.id) }
                    }
                }
            }
            item(key = "heading") { Row(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(heading, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f).padding(end = 8.dp).semantics { heading() }, maxLines = 2, overflow = TextOverflow.Ellipsis)
                SegmentedTabs(listOf("day" to t(R.string.seg_day), "week" to t(R.string.seg_week)), if (model.planWeek) "week" else "day", { model.planWeek = it == "week" }, Modifier.widthIn(min = 132.dp, max = 156.dp))
            } }
            if (!model.schoolReady) { item(key = "loading") { SkeletonRows(4) }; return@RefreshableScreenList }
            val shownDays = if (model.planWeek) days.filter { model.desk.showWeekend || it.dayOfWeek.value < 6 || agenda[it].orEmpty().isNotEmpty() } else listOf(model.day)
            shownDays.forEach { day ->
                val entries = agenda[day].orEmpty().filter { entry -> when (source) { "school" -> entry.school != null; "personal" -> entry.local != null; "due" -> entry.kind == AgendaKind.Task || entry.kind == AgendaKind.Exam; else -> true } }
                    .filter { it.school == null || !it.school.isLesson() || eventInHours(it.school, model.desk.dayStartHour, model.desk.dayEndHour, zone) }
                val unread = (source == "all" || source == "school") && (coverage[day] ?: lessonWeekCoverage(model.snapshot, day, today)) == WeekCoverage.UNREAD
                if (model.planWeek) item(key = "date:$day") {
                    Row(Modifier.fillMaxWidth().padding(top = 24.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(dateLabel(day), style = MaterialTheme.typography.titleMedium, color = if (day == today) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onBackground, modifier = Modifier.weight(1f).semantics { heading() })
                        if (day == today) Tag(t(R.string.today))
                    }
                }
                if (entries.isEmpty()) item(key = "empty:$day") {
                    if (model.planWeek) {
                        if (unread) StatusLine(t(R.string.timetable_not_loaded), StateTone.Warning, Modifier.padding(vertical = 12.dp))
                        else Text(t(R.string.no_commitments), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp))
                    }
                    else if (unread) EmptyState(Icons.Outlined.EventBusy, t(R.string.timetable_not_loaded), t(R.string.timetable_not_loaded_body), if (!model.busy) t(R.string.refresh_school_data) else null, StateTone.Warning) { model.refreshSchool() }
                    else EmptyState(Icons.Outlined.EventAvailable, t(R.string.a_clear_day), if (source == "school" && model.snapshot.fetchedAt.isBlank()) t(R.string.connect_schulnetz_in_settings_to_see_your_lesson) else when (source) { "school" -> t(R.string.no_school_entries_for_date); "personal" -> t(R.string.no_personal_entries_for_date); "due" -> t(R.string.no_deadline_entries_for_date); else -> t(R.string.no_entries_for_date) })
                } else {
                    if (unread && model.planWeek.not()) item(key = "partial:$day") { StatusLine(t(R.string.timetable_not_loaded), StateTone.Warning, Modifier.padding(vertical = 8.dp)) }
                    val rows = dayItems(entries, day == today && !model.planWeek, clock)
                    items(rows, key = { row -> when (row) { is DayItem.Entry -> row.entry.key; is DayItem.Gap -> row.key; is DayItem.Now -> row.key } }) { row ->
                        when (row) {
                            is DayItem.Entry -> AgendaRow(model, row.entry, row.position, now = if (day == today) clock else null) { selected = row.entry }
                            is DayItem.Gap -> GapRow(row.minutes)
                            is DayItem.Now -> NowRow(row.clock)
                        }
                    }
                }
            }
            if (model.snapshot.readErrors.any { it.startsWith("Stundenplan:") }) item(key = "read-error") { Spacer(Modifier.height(16.dp)); InfoBanner(t(R.string.timetable_unavailable), t(R.string.the_last_school_refresh_could_not_read_the_timet), t(R.string.connection_details), tone = StateTone.Warning, onAction = { model.navigate(Page.Connections) }) }
        }
    }
    }
    if (picker) {
        val state = rememberDatePickerState(initialSelectedDateMillis = model.day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(onDismissRequest = { picker = false }, confirmButton = { TextButton(onClick = { state.selectedDateMillis?.let { model.day = Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate() }; picker = false }) { Text(t(R.string.go_to_date)) } }, dismissButton = { TextButton(onClick = { picker = false }) { Text(t(R.string.cancel)) } }) { DatePicker(state) }
    }
    selected?.let { AgendaDetails(model, it) { selected = null } }
}

@Composable
private fun WeekStrip(days: List<LocalDate>, chosenDay: LocalDate, today: LocalDate, agenda: Map<LocalDate, List<AgendaEntry>>, coverage: Map<LocalDate, WeekCoverage>, onPick: (LocalDate) -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val warning = LocalCompanionSemantics.current.warning
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp).selectableGroup()) {
        days.forEach { day ->
            val chosen = day == chosenDay
            val count = agenda[day].orEmpty().size
            val unread = day.dayOfWeek.value < 6 && coverage[day] == WeekCoverage.UNREAD
            val label = buildString {
                append(dateLabel(day))
                if (day == today) append(", ").append(t(R.string.today))
                if (unread) append(", ").append(t(R.string.timetable_not_loaded))
                else if (count > 0) append(", ").append(tp(R.plurals.entries_count, count, count))
            }
            Column(Modifier.weight(1f).heightIn(min = 64.dp)
                .selectable(chosen, onClick = { onPick(day) }, role = Role.Tab)
                .clearAndSetSemantics { contentDescription = label; this.selected = chosen }
                .padding(horizontal = 2.dp).clip(MaterialTheme.shapes.medium)
                .background(if (chosen) scheme.onSurface else Color.Transparent)
                .then(if (day == today && !chosen) Modifier.border(1.5.dp, scheme.primary, MaterialTheme.shapes.medium) else Modifier)
                .padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(day.dayOfWeek.getDisplayName(java.time.format.TextStyle.SHORT, AppLanguage.formatLocale()).take(2), style = MaterialTheme.typography.labelMedium,
                    color = if (chosen) scheme.surface else if (day == today) scheme.primary else scheme.onSurfaceVariant)
                Text(day.dayOfMonth.toString(), style = TimeStyle.copy(fontSize = MaterialTheme.typography.titleLarge.fontSize), color = if (chosen) scheme.surface else if (day == today) scheme.primary else scheme.onSurface)
                Box(Modifier.padding(top = 3.dp).size(6.dp).then(when {
                    unread -> Modifier.border(1.5.dp, if (chosen) scheme.surface else warning, CircleShape)
                    count > 0 -> Modifier.background(if (chosen) scheme.surface else scheme.primary, CircleShape)
                    else -> Modifier
                }))
            }
        }
    }
}

@Composable
private fun GapRow(minutes: Int) {
    val line = LocalCompanionSemantics.current.hairline
    Row(Modifier.fillMaxWidth().heightIn(min = 36.dp), verticalAlignment = Alignment.CenterVertically) {
        Spacer(Modifier.width(52.dp + 12.dp))
        Box(Modifier.width(14.dp).fillMaxHeight().heightIn(min = 36.dp).drawBehind {
            drawLine(line, Offset(size.width / 2, 0f), Offset(size.width / 2, size.height), 2.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)))
        })
        Text(t(R.string.free_period, t(R.string.minutes_short, minutes)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 12.dp))
    }
}

@Composable
private fun NowRow(clock: String) {
    val accent = MaterialTheme.colorScheme.primary
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp).semantics { contentDescription = t(R.string.now_marker, clock) }, verticalAlignment = Alignment.CenterVertically) {
        Text(clock, style = TimeSmallStyle, color = accent, modifier = Modifier.width(52.dp))
        Spacer(Modifier.width(12.dp))
        Box(Modifier.size(14.dp).background(accent, CircleShape))
        Box(Modifier.weight(1f).height(2.dp).background(accent))
    }
}

@Composable
fun AgendaRow(model: CompanionModel, entry: AgendaEntry, position: RailPosition = RailPosition.Single, now: Int? = null, showDay: Boolean = false, onClick: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val s = LocalCompanionSemantics.current
    val highlighted = entry.school?.let { lessonTargetId(it) in model.highlightIds } == true
    val cancelled = entry.school?.isCancelled() == true
    val start = clockMinutes(entry.start)
    val end = clockMinutes(entry.end)
    val running = now != null && start != null && end != null && now in start until end
    val accent = when {
        cancelled -> scheme.error
        entry.kind == AgendaKind.Exam -> s.warning
        entry.kind == AgendaKind.Task || entry.kind == AgendaKind.Event -> scheme.primary
        else -> entry.school?.let { paletteColor(it.displayColor(model.colors)) } ?: scheme.primary
    }
    val line = s.hairline
    val room = entryRoom(entry)
    val people = entryPeople(entry)
    val highlight = if (highlighted || running) scheme.primaryContainer else Color.Transparent
    // The highlight bleeds 10 dp into the page gutter so the time rail never shifts sideways.
    val compactRows = model.desk.planCompact
    Row(Modifier.fillMaxWidth()
        .drawBehind {
            if (highlight != Color.Transparent) drawRoundRect(highlight, Offset(-10.dp.toPx(), 0f), Size(size.width + 20.dp.toPx(), size.height), androidx.compose.ui.geometry.CornerRadius(16.dp.toPx()))
            val x = (52 + 12 + 7).dp.toPx()
            val nodeY = (if (compactRows) 10.dp else 14.dp).toPx() + 11.dp.toPx()
            val stroke = 2.dp.toPx()
            if (position == RailPosition.Middle || position == RailPosition.Last) drawLine(line, Offset(x, 0f), Offset(x, nodeY), stroke)
            if (position == RailPosition.Middle || position == RailPosition.First) drawLine(line, Offset(x, nodeY), Offset(x, size.height), stroke)
            val r = 6.dp.toPx()
            when {
                cancelled -> drawCircle(accent, r - stroke / 2, Offset(x, nodeY), style = Stroke(stroke))
                entry.kind == AgendaKind.Exam -> {
                    val path = Path().apply { moveTo(x, nodeY - r - 1f); lineTo(x + r + 1f, nodeY); lineTo(x, nodeY + r + 1f); lineTo(x - r - 1f, nodeY); close() }
                    drawPath(path, accent)
                }
                entry.kind == AgendaKind.Event -> drawCircle(accent, r - stroke / 2, Offset(x, nodeY), style = Stroke(stroke + 0.5f))
                entry.kind == AgendaKind.Task -> drawRect(accent, Offset(x - r + 1f, nodeY - r + 1f), Size((r - 1f) * 2, (r - 1f) * 2))
                else -> drawCircle(accent, r, Offset(x, nodeY))
            }
        }
        .clickable(onClick = onClick).heightIn(min = Space.row),
        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.width(52.dp).padding(top = if (model.desk.planCompact) 10.dp else 14.dp), horizontalAlignment = Alignment.End) {
            if (showDay) {
                val dated = entry.school == null || examHasDate(entry.school.start)
                Text(if (!dated) "–" else formatSchoolDate(entry.day, if (entry.day.year == LocalDate.now().year) "d MMM" else "d.M.yy"), style = TimeSmallStyle, color = scheme.onSurfaceVariant, maxLines = 1)
            }
            Text(entry.start.ifBlank { if (entry.kind == AgendaKind.Task) t(R.string.due) else t(R.string.all_day_short) },
                style = if (entry.start.isBlank()) MaterialTheme.typography.labelMedium else TimeStyle, softWrap = entry.start.isNotBlank(), color = if (running) scheme.primary else scheme.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (entry.end.isNotBlank() && entry.end != entry.start) Text(entry.end, style = TimeSmallStyle, color = scheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f).padding(vertical = if (model.desk.planCompact) 10.dp else 14.dp)) {
            Text(courseAlias(entry.title, model.desk.courseAliases), style = MaterialTheme.typography.titleMedium,
                textDecoration = if (cancelled) TextDecoration.LineThrough else TextDecoration.None, color = if (cancelled) scheme.onSurfaceVariant else scheme.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
            val meta = when {
                entry.school != null -> listOf(room.takeIf { it.isNotBlank() }?.let { t(R.string.room_named, it) }, people.takeIf { it.isNotBlank() }).filterNotNull()
                entry.local != null -> listOf(entry.local.location).filter { it.isNotBlank() }
                else -> listOf(entry.detail).filter { it.isNotBlank() }
            }
            if (meta.isNotEmpty() && !model.desk.planCompact) Text(meta.joinToString("  ·  "), style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
            val tags = buildList {
                if (running) add(t(R.string.now_label) to scheme.primary)
                if (cancelled) add(t(R.string.cancelled) to scheme.error)
                else if (entry.school?.isSubstitution() == true) add(t(R.string.substitution) to s.warning)
                else if (entry.kind != AgendaKind.Lesson && (entry.kind != AgendaKind.Task || entry.start.isNotBlank())) add(entry.kind.uiLabel() to accent)
            }
            if (tags.isNotEmpty()) Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) { tags.forEach { (label, color) -> Tag(label, color) } }
        }
    }
}

@Composable
fun TaskRow(task: HomeworkTask, today: LocalDate, onToggle: () -> Unit, colors: Map<String, String> = emptyMap(), onOpen: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    val overdue = taskBucket(task, today) == "Overdue"
    val haptic = LocalHapticFeedback.current
    val inset = if (LocalInGroup.current) 4.dp else 0.dp
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable(role = Role.Button, onClick = onOpen).padding(start = inset, end = if (LocalInGroup.current) 12.dp else 0.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(48.dp).toggleable(task.done, role = Role.Checkbox, onValueChange = {
            haptic.performHapticFeedback(if (task.done) HapticFeedbackType.ToggleOff else HapticFeedbackType.ToggleOn)
            onToggle()
        }).semantics { contentDescription = t(R.string.text, if (task.done) t(R.string.reopen) else t(R.string.complete_action), task.title) }, contentAlignment = Alignment.Center) {
            Box(Modifier.size(22.dp).then(if (task.done) Modifier.background(scheme.primary, CircleShape) else Modifier.border(2.dp, if (overdue) scheme.error else scheme.outline, CircleShape)), contentAlignment = Alignment.Center) {
                if (task.done) Icon(Icons.Outlined.Check, null, Modifier.size(15.dp), tint = scheme.onPrimary)
            }
        }
        Column(Modifier.weight(1f).padding(start = 6.dp, end = 8.dp)) {
            Text(task.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, textDecoration = if (task.done) TextDecoration.LineThrough else TextDecoration.None, color = if (task.done) scheme.onSurfaceVariant else scheme.onSurface, maxLines = 3, overflow = TextOverflow.Ellipsis)
            Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                if (task.subject.isNotBlank()) {
                    Box(Modifier.size(8.dp).background(paletteColor(subjectColor(task.subject, overrides = colors)), CircleShape))
                    Text(task.subject, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 6.dp, end = 8.dp).weight(1f, fill = false))
                }
                Text(listOf(dueLabel(task.dueDate), task.dueTime.orEmpty()).filter { it.isNotBlank() }.joinToString(" "), style = MaterialTheme.typography.bodySmall, fontWeight = if (overdue) FontWeight.SemiBold else FontWeight.Normal, color = if (overdue) scheme.error else scheme.onSurfaceVariant, maxLines = 1)
            }
            if (task.notes.isNotBlank()) Text(plainPreview(task.notes), style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
        }
        if (task.priority == "high") Icon(Icons.Outlined.Flag, t(R.string.important), Modifier.size(20.dp), tint = LocalCompanionSemantics.current.warning)
    }
}

@Composable
private fun TasksScreen(model: CompanionModel) {
    var query by rememberSaveable { mutableStateOf("") }
    var task by remember { mutableStateOf<HomeworkTask?>(null) }
    var schoolTask by remember { mutableStateOf<SchoolHomework?>(null) }
    val today = rememberNow().atZone(ZoneId.systemDefault()).toLocalDate()
    Column(Modifier.fillMaxSize()) {
        SearchField(query, { query = it }, t(R.string.find_an_assignment), Modifier.padding(horizontal = Space.page, vertical = 6.dp))
        ChoiceRow(listOf("open" to t(R.string.open), "done" to t(R.string.completed), "school" to t(R.string.from_school)), model.taskSource, { model.taskSource = it }, Modifier.padding(horizontal = Space.page))
        ScreenList(Modifier.weight(1f)) {
            if (model.taskSource == "school") {
                item(key = "school-hint") { StatusLine(t(R.string.school_assignments_are_read_only_add_one_to_your), StateTone.Neutral, Modifier.padding(vertical = 12.dp)) }
                val tasks = model.snapshot.homework.filter { "${it.title} ${it.courseName} ${it.description}".contains(query, true) }.sortedBy { it.dueDate }
                if (tasks.isEmpty()) item(key = "school-empty") { EmptyState(Icons.AutoMirrored.Outlined.Assignment, t(R.string.no_school_assignments), if (query.isNotBlank()) t(R.string.try_another_search) else t(R.string.assignments_appear_after_a_school_refresh_when_y)) }
                itemsIndexed(tasks, key = { _, it -> "school-task:${it.id}" }) { index, item ->
                    val imported = model.tasks.any { it.title == item.title && it.subject == item.courseName && it.dueDate == parseDisplayDate(item.dueDate)?.toString() }
                    GroupItem(index, tasks.size) {
                        SettingRow(null, item.title, listOf(item.courseName, dueLabel(item.dueDate)).filter { it.isNotBlank() }.joinToString("  ·  "),
                            trailing = if (imported) t(R.string.added_to_tasks) else "", trailingColor = LocalCompanionSemantics.current.success) { schoolTask = item }
                    }
                }
            } else {
                val tasks = sortHomeworkTasks(model.tasks).filter { it.done == (model.taskSource == "done") && "${it.title} ${it.subject} ${it.notes}".contains(query, true) }
                if (tasks.isEmpty()) item(key = "empty") { EmptyState(Icons.Outlined.CheckCircleOutline, if (query.isNotBlank()) t(R.string.nothing_matches_2) else if (model.taskSource == "done") t(R.string.a_fresh_start) else t(R.string.nothing_left_on_your_list), if (query.isNotBlank()) t(R.string.try_a_subject_or_a_shorter_search) else if (model.taskSource == "done") t(R.string.finished_tasks_will_be_kept_here) else t(R.string.add_homework_with_new_task_or_review_assignments)) }
                listOf("Overdue", "Today", "Upcoming", "No due date", "Completed").forEach { bucket ->
                    val group = tasks.filter { taskBucket(it, today) == bucket }
                    if (group.isNotEmpty()) {
                        item(key = "bucket:$bucket") { SectionLabel(bucketLabel(bucket), count = group.size, tone = if (bucket == "Overdue") MaterialTheme.colorScheme.error else null) }
                        itemsIndexed(group, key = { _, it -> "task:${it.id}" }) { index, item -> GroupItem(index, group.size) { TaskRow(item, today, { model.toggleTask(item) }, colors = model.colors) { task = item } } }
                    }
                }
            }
        }
    }
    task?.let { TaskForm(model, it) { task = null } }
    schoolTask?.let { item ->
        KantiSheet(onDismiss = { schoolTask = null }) {
            SheetTitle(item.title) { schoolTask = null }
            Tag(t(R.string.schulnetz_read_only))
            Text(listOf(item.courseName, dueLabel(item.dueDate)).filter { it.isNotBlank() }.joinToString("  ·  "), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 14.dp))
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                if (item.description.isNotBlank()) Text(item.description, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 10.dp))
            }
            val imported = model.tasks.any { it.title == item.title && it.subject == item.courseName && it.dueDate == parseDisplayDate(item.dueDate)?.toString() }
            PrimaryButton(if (imported) t(R.string.already_in_your_tasks) else t(R.string.add_to_my_tasks), { model.importHomework(item.title, item.courseName, item.dueDate, item.description); schoolTask = null },
                Modifier.fillMaxWidth().padding(top = 24.dp), enabled = !imported, icon = if (imported) Icons.Outlined.Check else Icons.Outlined.Add)
        }
    }
}

@Composable
private fun DetailLine(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 7.dp), verticalAlignment = Alignment.Top) {
        Icon(icon, null, Modifier.padding(top = 2.dp).size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(text, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = 14.dp))
    }
}

@Composable
fun AgendaDetails(model: CompanionModel, entry: AgendaEntry, onDismiss: () -> Unit) {
    var edit by remember { mutableStateOf(false) }
    if (entry.task != null) { TaskForm(model, entry.task, onDismiss); return }
    if (edit && entry.local != null) { EventForm(model, entry.local, onDismiss); return }
    val scheme = MaterialTheme.colorScheme
    KantiSheet(onDismiss = onDismiss) {
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 6.dp)) {
                Tag(if (entry.school != null) t(R.string.schulnetz_kind, entry.kind.uiLabel()) else t(R.string.app_name), if (entry.kind == AgendaKind.Exam) LocalCompanionSemantics.current.warning else scheme.primary)
                if (entry.school?.isCancelled() == true) Tag(t(R.string.cancelled), scheme.error)
                else if (entry.school?.isSubstitution() == true) Tag(t(R.string.substitution), LocalCompanionSemantics.current.warning)
            }
            SheetTitle(courseAlias(entry.title, model.desk.courseAliases), onDismiss)
            val schoolStart = entry.school?.start.orEmpty()
            Text(if (entry.school != null && !examHasDate(schoolStart)) t(R.string.no_due_date) else dateLabel(entry.day), style = MaterialTheme.typography.bodyLarge, color = scheme.onSurfaceVariant)
            Text(entry.time, style = MaterialTheme.typography.displaySmall, modifier = Modifier.padding(top = 2.dp, bottom = 8.dp))
            val room = entryRoom(entry)
            if (room.isNotBlank()) DetailLine(if (entry.local != null) Icons.Outlined.Place else Icons.Outlined.MeetingRoom, if (entry.school != null) t(R.string.room_named, room) else room)
            val people = entryPeople(entry)
            if (people.isNotBlank()) DetailLine(Icons.Outlined.PersonOutline, people)
            val description = entry.school?.comment ?: entry.local?.notes.orEmpty()
            if (description.isNotBlank()) DetailLine(Icons.AutoMirrored.Outlined.Notes, description)
            if (entry.school?.isCancelled() == true) Box(Modifier.padding(top = 10.dp)) { InfoBanner(t(R.string.this_lesson_is_cancelled), "", tone = StateTone.Error) }
            if (entry.local != null) {
                PrimaryButton(t(R.string.edit_event), { edit = true }, Modifier.fillMaxWidth().padding(top = 20.dp), icon = Icons.Outlined.Edit)
                if (entry.local.notePath.isNotBlank()) SecondaryButton(t(R.string.open_linked_note), { onDismiss(); model.openNote(entry.local.notePath) }, Modifier.fillMaxWidth().padding(top = 10.dp))
            }
            if (entry.school != null && entry.kind == AgendaKind.Exam) {
                val imported = model.calendar.events.any { it.id == "schulnetz-${entry.school.id}" }
                PrimaryButton(if (imported) t(R.string.already_in_your_calendar) else t(R.string.add_to_my_calendar), { model.importExam(entry.school); onDismiss() },
                    Modifier.fillMaxWidth().padding(top = 20.dp), enabled = !imported, icon = if (imported) Icons.Outlined.Check else Icons.Outlined.EventAvailable)
            }
            if (entry.school?.isLesson() == true && entry.kind == AgendaKind.Lesson) {
                SectionLabel(t(R.string.personal_timetable))
                Text(t(R.string.hidden_lessons_can_be_restored_in_planning_setti), style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant)
                Column(Modifier.fillMaxWidth().padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryButton(t(R.string.hide_this_lesson), { model.hideLesson(entry.school, false); onDismiss() }, Modifier.fillMaxWidth(), icon = Icons.Outlined.VisibilityOff)
                    SecondaryButton(t(R.string.hide_this_weekly_lesson), { model.hideLesson(entry.school, true); onDismiss() }, Modifier.fillMaxWidth(), icon = Icons.Outlined.EventRepeat)
                }
            }
        }
    }
}

