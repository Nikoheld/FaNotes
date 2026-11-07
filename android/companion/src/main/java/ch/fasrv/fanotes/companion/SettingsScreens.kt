package ch.fasrv.fanotes.companion

import android.Manifest
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.desk.THEME_CHOICES
import ch.fasrv.fanotes.schulnetz.*
import ch.fasrv.fanotes.sync.SyncStatus
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

@Composable
fun SettingsScreen(model: CompanionModel, page: Page) {
    val context = LocalContext.current
    val sync by model.graph.engine.state.collectAsStateWithLifecycle()
    var confirm by remember { mutableStateOf("") }
    if (page == Page.Diagnostics) {
        val owner = LocalLifecycleOwner.current
        DisposableEffect(owner) {
            val observer = LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_RESUME) model.bumpDiagnostics()
            }
            owner.lifecycle.addObserver(observer)
            onDispose { owner.lifecycle.removeObserver(observer) }
        }
        LaunchedEffect(model.diagnosticOn) {
            if (model.diagnosticOn) model.noteDiagnosticMemory()
        }
    }
    when (page) {
        Page.Settings -> ScreenList {
            item {
                Row(Modifier.fillMaxWidth().padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    Box(Modifier.size(48.dp).background(MaterialTheme.colorScheme.primaryContainer, CircleShape), contentAlignment = Alignment.Center) { Icon(if (model.notesAccount) Icons.Outlined.PersonOutline else Icons.Outlined.School, null, tint = MaterialTheme.colorScheme.primary) }
                    Column(Modifier.weight(1f)) {
                        Text(sync.account?.email ?: if (model.notesAccount) t(R.string.your_fanotes) else t(R.string.kanti), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(if (model.notesAccount) syncDescription(sync.status) else t(R.string.grades_timetable_and_school_updates), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                FineDivider()
            }
            item { SectionLabel(if (model.notesAccount) t(R.string.make_it_yours) else t(R.string.school)) }
            if (model.notesAccount) item { SettingRow(Icons.Outlined.ManageAccounts, t(R.string.account_sync), t(R.string.fanotes_schulnetz_and_offline_status)) { model.navigate(Page.Connections) } }
            else item { SettingRow(Icons.Outlined.School, t(R.string.schulnetz), t(R.string.connection_notifications_and_this_device)) { model.navigate(Page.Connections) } }
            if (!model.notesAccount) item { SectionLabel(t(R.string.make_it_yours)) }
            item { SettingRow(Icons.Outlined.Palette, t(R.string.appearance), t(R.string.theme_accent_and_app_icon)) { model.navigate(Page.Appearance) } }
            item {
                Text(t(R.string.language), style = MaterialTheme.typography.titleMedium)
                ChoiceRow(
                    listOf("system" to t(R.string.system), "de" to t(R.string.language_german), "en" to t(R.string.language_english)),
                    AppLanguage.selectedTag(),
                    onSelect = { tag ->
                        if (tag != AppLanguage.selectedTag()) {
                            AppLanguage.choose(tag)
                            CompanionAlerts.ensureChannels(context)
                            NextLessonWidget.update(context)
                            if (Build.VERSION.SDK_INT < 33) context.hostActivity()?.recreate()
                        }
                    },
                )
            }
            item { SettingRow(Icons.Outlined.ViewWeek, t(R.string.navigation_bar), t(R.string.choose_tabs_and_their_order)) { model.navigate(Page.Navigation) } }
            item { SettingRow(Icons.Outlined.Tune, t(R.string.planning_grades), t(R.string.today_timetable_and_grade_display)) { model.navigate(Page.Planning) } }
            item { SettingRow(Icons.Outlined.NotificationsNone, t(R.string.notifications), t(R.string.what_reaches_you_and_when)) { model.navigate(Page.Notifications) } }
            item { SectionLabel(if (model.notesAccount) t(R.string.about_kanti) else t(R.string.optional)) }
            if (model.notesAccount) item { SettingRow(Icons.Outlined.AutoGraph, t(R.string.your_activity), t(R.string.notes_habits_and_milestones)) { model.navigate(Page.Profile) } }
            else item { SettingRow(Icons.Outlined.EditNote, t(R.string.sync_notes_with_fanotes), t(R.string.optional_school_stays_available_either_way)) { model.navigate(Page.Auth) } }
            if (!model.notesAccount) item { SectionLabel(t(R.string.about_kanti)) }
            item { SettingRow(Icons.Outlined.BugReport, t(R.string.diagnostics), t(R.string.connection_checks_and_support_exports)) { model.navigate(Page.Diagnostics) } }
            item { Text(t(R.string.version_line, BuildConfig.VERSION_NAME), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 28.dp)) }
        }
        Page.Connections -> ScreenList {
            if (model.notesAccount) item { SectionLabel(t(R.string.fanotes_account)) }
            if (model.notesAccount) item {
                Text(sync.account?.email ?: t(R.string.work_on_this_device), style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(syncDescription(sync.status), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                Text(t(R.string.your_notes_stay_available_offline_a_connected_ac), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 16.dp))
                if (sync.account == null) Button(onClick = { model.navigate(Page.Auth) }, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.connect_an_account)) }
                else {
                    Text(t(R.string.last_sync, sync.lastSyncAt?.let(::updatedLabel) ?: t(R.string.not_yet)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Button(onClick = model::sync, enabled = !model.busy && sync.status != SyncStatus.SYNCING, modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) { Icon(Icons.Outlined.Sync, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(t(R.string.sync_now)) }
                    TextButton(onClick = { confirm = "logout" }) { Text(t(R.string.sign_out)) }
                    if (model.graph.plannerHold()) TextButton(onClick = model::acceptUpload) { Text(t(R.string.upload_tasks_and_calendar)) }
                }
                sync.error?.let { error -> InfoBanner(t(R.string.sync_needs_attention), shownText(error), t(R.string.try_again), true, model::sync) }
                if (sync.conflicts.isNotEmpty()) InfoBanner(t(R.string.conflict_copies_kept), tp(R.plurals.conflict_copies, sync.conflicts.size, sync.conflicts.size))
            }
            item { SectionLabel(t(R.string.school_connection)) }
            item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Icon(Icons.Outlined.School, null, tint = MaterialTheme.colorScheme.primary)
                    Text(t(R.string.schulnetz), style = MaterialTheme.typography.titleLarge)
                }
                Text(when { model.link.needsReauth -> t(R.string.sign_in_again_to_refresh); model.link.linked -> t(R.string.connected); else -> t(R.string.not_connected) }, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 4.dp))
                Text(t(R.string.read_your_school_information_here_manage_officia), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 16.dp))
                OutlinedTextField(model.baseUrl, { model.baseUrl = it }, Modifier.fillMaxWidth(), label = { Text(t(R.string.school_address)) }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
                Button(onClick = { model.requestVisibleLogin("connections") }, enabled = !model.busy, modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) { Text(if (model.link.needsReauth) t(R.string.sign_in_to_schulnetz_again) else if (model.link.linked) t(R.string.open_school_session) else t(R.string.connect_with_microsoft)) }
                if (model.link.linked) TextButton(onClick = { confirm = "unlink" }) { Text(t(R.string.disconnect_school)) }
                if (!model.notesAccount) {
                    TextButton(onClick = { model.navigate(Page.Auth) }, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.sync_notes_with_fanotes)) }
                    TextButton(onClick = { confirm = "delete-kanti" }) { Text(t(R.string.delete_my_kanti_data)) }
                }
                Text(t(R.string.school_data_updated, updatedLabel(model.snapshot.fetchedAt)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp))
                if (model.link.lastError.isNotBlank()) InfoBanner(t(R.string.school_connection_needs_attention), shownText(model.link.lastError), t(R.string.diagnostics), true) { model.navigate(Page.Diagnostics) }
            }
        }
        Page.Appearance -> ScreenList {
            item { SectionLabel(t(R.string.color_light)) }
            item {
                Text(t(R.string.theme), style = MaterialTheme.typography.titleMedium)
                ChoiceRow(THEME_CHOICES.map { it.id to when (it.id) { "light" -> t(R.string.paper); "dark" -> t(R.string.graphite); "midnight" -> t(R.string.midnight); "forest" -> t(R.string.forest); "aurora" -> t(R.string.aurora); "sepia" -> t(R.string.warm_paper); else -> t(R.string.system) } }, model.desk.theme, model::chooseTheme)
                ToggleRow(t(R.string.pure_black), t(R.string.use_a_black_background_in_dark_themes), model.desk.amoled) { model.updateDesk(model.desk.copy(amoled = it)) }
                SectionLabel(if (model.notesAccount) t(R.string.ink_accent) else t(R.string.accent))
                ColorChoices(listOf("#2a6f97", "#7f6df2", "#3d8bfd", "#2f9e6b", "#e15b64"), model.desk.accent) { model.updateDesk(model.desk.copy(accent = it)) }
                Text(t(R.string.accent_contrast_adjusts_to_your_theme), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item { SectionLabel(t(R.string.home_screen_icon)) }
            item { ChoiceRow(listOf("standard" to t(R.string.kanti), "schule" to t(R.string.school), "notiz" to t(R.string.notebook)), model.iconChoice, { model.chooseIcon(context, it) }) }
            item { SectionLabel(t(R.string.navigation)) }
            item { SettingRow(Icons.Outlined.ViewWeek, t(R.string.navigation_bar), t(R.string.choose_tabs_and_their_order)) { model.navigate(Page.Navigation) } }
        }
        Page.Navigation -> NavigationBarSettings(model)
        Page.Planning -> ScreenList {
            item { SectionLabel(t(R.string.when_you_open_kanti)) }
            item { ChoiceRow((if (model.notesAccount) NAV_BAR_IDS else NAV_BAR_IDS.filter { it != "notes" }).map { it to navBarLabel(it) }, startTabId(model.desk.startTab).let { if (!model.notesAccount && it == "notes") "today" else it }, { model.updateDesk(model.desk.copy(startTab = it)) }) }
            item { SectionLabel(t(R.string.on_today)) }
            items(TODAY_CARD_IDS, key = { it }) { id ->
                ToggleRow(when (id) { "lessons" -> t(R.string.next_commitment); "exam" -> t(R.string.upcoming_exam); "grades" -> t(R.string.grade_overview); "pluspunkte" -> t(R.string.promotion_points_2); "events" -> t(R.string.school_updates); else -> t(R.string.tasks) }, checked = id !in model.desk.hiddenCards) { show ->
                    model.updateDesk(model.desk.copy(hiddenCards = if (show) model.desk.hiddenCards - id else (model.desk.hiddenCards + id).distinct()))
                }
            }
            item { SectionLabel(t(R.string.timetable)) }
            item { ToggleRow(t(R.string.compact_rows), t(R.string.show_more_lessons_at_a_glance), model.desk.planCompact) { model.updateDesk(model.desk.copy(planCompact = it)) } }
            item { ToggleRow(t(R.string.include_weekends), t(R.string.show_empty_weekend_days_in_week_view), model.desk.showWeekend) { model.updateDesk(model.desk.copy(showWeekend = it)) } }
            item {
                Text(t(R.string.visible_school_hours), style = MaterialTheme.typography.titleMedium)
                ChoiceRow((0..23).map { it.toString() to "%02d:00".format(it) }, model.desk.dayStartHour.toString(), { model.updateDesk(model.desk.copy(dayStartHour = it.toInt(), dayEndHour = maxOf(model.desk.dayEndHour, it.toInt() + 1))) })
                Text(t(R.string.until), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                ChoiceRow(((model.desk.dayStartHour + 1)..24).map { it.toString() to "%02d:00".format(it) }, model.desk.dayEndHour.toString(), { model.updateDesk(model.desk.copy(dayEndHour = it.toInt())) })
            }
            if (model.hidden.isNotEmpty()) {
                item { SectionLabel(t(R.string.hidden_lessons)) }
                items(model.hidden, key = { it.id }) { rule ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) { Text(rule.subject, style = MaterialTheme.typography.bodyLarge); Text(if (rule.mode == "once") rule.date else t(R.string.text_2, runCatching { java.time.DayOfWeek.of(rule.weekday).getDisplayName(java.time.format.TextStyle.SHORT, AppLanguage.formatLocale()) }.getOrDefault(t(R.string.weekly)), rule.start), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        TextButton(onClick = { model.restoreLesson(rule.id) }) { Text(t(R.string.restore)) }
                    }
                }
            }
            item { SectionLabel(t(R.string.grades_widget)) }
            item { ToggleRow(t(R.string.promotion_points_2), t(R.string.show_the_calculated_points_balance), model.desk.showPluspunkte) { model.updateDesk(model.desk.copy(showPluspunkte = it)) } }
            item { Text(t(R.string.grade_precision), style = MaterialTheme.typography.titleMedium); ChoiceRow((0..3).map { it.toString() to tp(R.plurals.decimals_count, it, it) }, model.desk.gradeDecimals.toString(), { model.updateDesk(model.desk.copy(gradeDecimals = it.toInt())) }) }
            item { Text(t(R.string.subject_order), style = MaterialTheme.typography.titleMedium); ChoiceRow(listOf("name" to t(R.string.name), "average" to t(R.string.average), "pluspunkte" to t(R.string.points)), model.desk.gradeSort, { model.updateDesk(model.desk.copy(gradeSort = it)) }) }
            item { ToggleRow(t(R.string.compact_home_widget), t(R.string.use_a_smaller_next_lesson_summary), model.desk.widgetCompact) { model.updateDesk(model.desk.copy(widgetCompact = it)) } }
        }
        Page.Notifications -> NotificationSettings(model)
        Page.Diagnostics -> ScreenList {
            item { Text(t(R.string.connection_checks), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(vertical = 16.dp)) }
            item {
                Text(t(R.string.diagnostic_mode), style = MaterialTheme.typography.titleMedium)
                Text(t(R.string.diagnostic_mode_help), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, bottom = 8.dp))
                ToggleRow(t(R.string.diagnostic_mode), "", model.diagnosticOn) { model.setDiagnosticMode(it) }
            }
            item {
                DiagnosticLine(t(R.string.diagnostic_label_school), if (model.link.linked) t(R.string.diagnostic_value_linked) else t(R.string.diagnostic_value_separated))
                DiagnosticLine(t(R.string.diagnostic_label_push), if (model.graph.fcmToken().isNullOrBlank()) t(R.string.diagnostic_value_unregistered) else t(R.string.diagnostic_value_registered))
                DiagnosticLine(t(R.string.diagnostic_label_sync), t(diagnosticSyncRes(sync.status)))
                DiagnosticLine(t(R.string.diagnostic_label_build), "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            }
            if (model.diagnosticOn) {
                item { SectionLabel(t(R.string.diagnostic_preview)) }
                item {
                    Text(t(R.string.diagnostic_local_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
                    DiagnosticChoice(t(R.string.diagnostic_school), model.diagnosticScenario == DiagnosticScenario.SCHOOL) { model.selectDiagnosticScenario("school") }
                    DiagnosticChoice(t(R.string.diagnostic_states), model.diagnosticScenario == DiagnosticScenario.STATES) { model.selectDiagnosticScenario("states") }
                    DiagnosticChoice(t(R.string.diagnostic_malformed), model.diagnosticScenario == DiagnosticScenario.MALFORMED) { model.selectDiagnosticScenario("malformed") }
                }
                if (model.diagnosticScenario != DiagnosticScenario.OFF) {
                    val lines = diagnosticPreview(model.diagnosticScenario, ZoneId.of("Europe/Zurich"), LocalDate.now(ZoneId.of("Europe/Zurich")))
                    items(lines, key = { "sim:${it.title}:${it.detail}" }) { line ->
                        Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                            Text(line.title, style = MaterialTheme.typography.titleSmall)
                            Text(line.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                item { SectionLabel(t(R.string.delivery)) }
                item {
                    Text(t(R.string.diagnostic_remote_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
                    OutlinedButton(onClick = { model.probeDelivery(context, "standard") }, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.diagnostic_remote_standard)) }
                    OutlinedButton(onClick = { model.probeDelivery(context, "duplicate") }, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.diagnostic_remote_duplicate)) }
                    OutlinedButton(onClick = { model.probeDelivery(context, "reorder") }, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.diagnostic_remote_reorder)) }
                }
            }
            item {
                val tick = model.diagnosticTick
                val failures = if (tick >= 0) DiagnosticTrace.failures().takeLast(6) else emptyList()
                SectionLabel(t(R.string.diagnostic_failures))
                if (failures.isEmpty()) {
                    Text(t(R.string.diagnostic_no_failures), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    failures.forEach { entry ->
                        val parts = listOf(entry.category, entry.name, "${entry.durationMs}ms", entry.result)
                        val label = if (entry.detail.isBlank()) parts.joinToString(" ") else (parts + entry.detail).joinToString(" ")
                        Text(
                            label,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(bottom = 6.dp),
                        )
                    }
                }
                OutlinedButton(onClick = { model.diagnosticExport = model.prepareDiagnosticExport() }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text(t(R.string.diagnostic_export)) }
                OutlinedButton(onClick = { confirm = "diagnostic-reset" }, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.diagnostic_stop)) }
            }
            item {
                fun at(ms: Long) = if (ms <= 0L) t(R.string.not_yet) else formatSchoolStamp(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()), "d MMM yyyy · HH:mm")
                val delivery = deliveryModeLabel(firebaseConfigured(context), model.graph.lastPushAt(), System.currentTimeMillis())
                DiagnosticLine(t(R.string.delivery), if (delivery == "Instant via push") t(R.string.instant_via_push) else t(R.string.fallback_mode))
                DiagnosticLine(t(R.string.last_push), at(model.graph.lastPushAt()))
                DiagnosticLine(t(R.string.last_school_check), at(model.graph.lastCheckAt()))
                DiagnosticLine(t(R.string.next_scheduled_check), if (delivery == "Instant via push") t(R.string.not_scheduled_while_push_is_healthy) else at(model.graph.nextCheckAt()))
                DiagnosticLine(t(R.string.cached_school_data), updatedLabel(model.snapshot.fetchedAt))
                val error = model.graph.lastCheckError().ifBlank { model.link.lastError }
                if (error.isNotBlank()) InfoBanner(t(R.string.last_check), shownText(error), error = true)
            }
            if (model.snapshot.readErrors.isNotEmpty()) {
                item { SectionLabel(t(R.string.source_reports)) }
                itemsIndexed(model.snapshot.readErrors, key = { index, error -> "err:$index:$error" }) { _, error -> Text(shownText(error), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 8.dp)) }
            }
            item { SectionLabel(t(R.string.support_exports)) }
            item {
                Text(t(R.string.share_an_export_when_troubleshooting_a_school_co), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedButton(onClick = { model.shareDebug(context) }, modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) { Text(t(R.string.share_school_page)) }
                OutlinedButton(onClick = { model.shareLogs(context) }, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.share_diagnostic_archive)) }
                TextButton(onClick = { confirm = "logs-captures" }, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.include_saved_school_pages)) }
                if (model.notesAccount) OutlinedButton(onClick = model::sync, enabled = !model.busy, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.refresh_connections)) }
                else OutlinedButton(onClick = model::refreshSchool, enabled = !model.busy, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.refresh_school_data)) }
            }
        }
        Page.Profile -> ScreenList {
            item {
                Text(t(R.string.a_little_progress_every_day), style = MaterialTheme.typography.headlineMedium)
                Row(Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalArrangement = Arrangement.spacedBy(32.dp)) {
                    if (model.notesAccount) Column { Text(model.writtenNotes.toString(), style = MaterialTheme.typography.headlineLarge); Text(tp(R.plurals.profile_notes, model.writtenNotes), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    Column { Text(model.graph.streakDays().toString(), style = MaterialTheme.typography.headlineLarge); Text(t(R.string.days_in_a_row), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                SectionLabel(t(R.string.milestones))
            }
            items(companionBadges(model.writtenNotes, model.graph.streakDays(), highestVisibleMark(model.snapshot.grades, model.hiddenGradeIds(), model.settings.guessGrades)).filter { model.notesAccount || !it.id.startsWith("notes") }, key = { it.id }) { badge ->
                val title = when (badge.id) { "notes-1" -> t(R.string.badge_first_thought); "notes-10" -> t(R.string.badge_growing_notebook); "streak-3" -> t(R.string.badge_finding_rhythm); else -> t(R.string.badge_top_marks) }
                val body = when (badge.id) { "notes-1" -> t(R.string.badge_write_first); "notes-10" -> t(R.string.badge_keep_ten); "streak-3" -> t(R.string.badge_open_three); else -> t(R.string.badge_grade_six) }
                Row(Modifier.fillMaxWidth().padding(vertical = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Icon(if (badge.earned) Icons.Outlined.Verified else Icons.Outlined.RadioButtonUnchecked, if (badge.earned) t(R.string.achieved) else t(R.string.not_yet_achieved), tint = if (badge.earned) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                    Column { Text(title, style = MaterialTheme.typography.titleMedium); Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                FineDivider()
            }
        }
        else -> Unit
    }
    if (confirm.isNotBlank()) {
        val deleteKanti = confirm == "delete-kanti"
        ConfirmDialog(
            when (confirm) {
                "logout" -> t(R.string.sign_out_of_fanotes)
                "delete-kanti" -> t(R.string.delete_my_kanti_data_2)
                "logs-captures" -> t(R.string.include_saved_school_pages_2)
                "diagnostic-reset" -> t(R.string.diagnostic_stop)
                else -> t(R.string.disconnect_schulnetz)
            },
            when (confirm) {
                "logout" -> t(R.string.your_local_notes_stay_on_this_device_school_upda)
                "delete-kanti" -> t(R.string.school_data_stored_for_this_device_is_removed_fr)
                "logs-captures" -> t(R.string.these_pages_contain_grades_absences_and_names)
                "diagnostic-reset" -> t(R.string.diagnostic_stop_body)
                else -> t(R.string.your_last_school_snapshot_stays_available_you_ca)
            },
            when (confirm) {
                "logout" -> t(R.string.sign_out)
                "delete-kanti" -> t(R.string.delete)
                "logs-captures" -> t(R.string.include_pages)
                "diagnostic-reset" -> t(R.string.diagnostic_stop)
                else -> t(R.string.disconnect)
            },
            { confirm = "" },
        ) {
            when {
                confirm == "logout" -> model.logout()
                deleteKanti -> model.deleteKantiData()
                confirm == "logs-captures" -> model.shareLogs(context, includeCaptures = true)
                confirm == "diagnostic-reset" -> model.resetDiagnostics(context)
                else -> model.unlink()
            }
            confirm = ""
        }
    }
    val export = model.diagnosticExport
    if (export != null) {
        AlertDialog(
            onDismissRequest = { model.diagnosticExport = null },
            title = { Text(t(R.string.diagnostic_export)) },
            text = {
                Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                    Text(export, style = MaterialTheme.typography.bodySmall)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    model.diagnosticExport = null
                    model.shareDiagnosticReport(context, export)
                }) { Text(t(R.string.diagnostic_export_share)) }
            },
            dismissButton = { TextButton(onClick = { model.diagnosticExport = null }) { Text(t(R.string.cancel)) } },
        )
    }
}

@Composable
private fun NavigationBarSettings(model: CompanionModel) {
    val bar = presentedNavBar(model.desk.navBar, model.notesAccount)
    val fallback = if (model.notesAccount) DEFAULT_NAV_BAR else SCHOOL_NAV_BAR
    val available = remainingNavBar(bar).filter { model.notesAccount || it != "notes" }
    ScreenList {
        item {
            Text(t(R.string.shown_in_the_bar), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = Space.xl, bottom = Space.sm))
            Text(t(R.string.choose_2_to_5_destinations_settings_stays_availa), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        itemsIndexed(bar, key = { _, id -> "bar:$id" }) { index, id ->
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(navBarIcon(id), null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(22.dp))
                Column(Modifier.weight(1f)) {
                    Text(navBarLabel(id), style = MaterialTheme.typography.titleMedium)
                    Text(t(R.string.of, index + 1, bar.size), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                ActionIcon(Icons.Outlined.KeyboardArrowUp, t(R.string.move_up, navBarLabel(id)), enabled = index > 0) {
                    model.updateDesk(model.desk.copy(navBar = moveNavBarItem(bar, index, -1)))
                }
                ActionIcon(Icons.Outlined.KeyboardArrowDown, t(R.string.move_down, navBarLabel(id)), enabled = index < bar.lastIndex) {
                    model.updateDesk(model.desk.copy(navBar = moveNavBarItem(bar, index, 1)))
                }
                ActionIcon(Icons.Outlined.Close, t(R.string.remove, navBarLabel(id)), enabled = bar.size > NAV_BAR_MIN) {
                    model.updateDesk(model.desk.copy(navBar = removeNavBarItem(bar, id)))
                }
            }
            FineDivider()
        }
        if (available.isNotEmpty()) {
            item { SectionLabel(if (bar.size >= NAV_BAR_MAX) t(R.string.remove_a_tab_to_add_another) else t(R.string.add_a_destination)) }
            items(available, key = { "add:$it" }) { id ->
                val enabled = bar.size < NAV_BAR_MAX
                SettingRow(
                    navBarIcon(id),
                    navBarLabel(id),
                    if (enabled) t(R.string.add_to_the_navigation_bar) else t(R.string.maximum_of_5_tabs),
                ) { if (enabled) model.updateDesk(model.desk.copy(navBar = addNavBarItem(bar, id))) }
            }
        }
        item {
            TextButton(
                onClick = { model.updateDesk(model.desk.copy(navBar = fallback)) },
                enabled = bar != fallback,
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            ) { Text(t(R.string.reset_to_default)) }
        }
    }
}

@Composable
private fun NotificationSettings(model: CompanionModel) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    var allowed by remember { mutableStateOf(CompanionAlerts.notificationsAllowed(context)) }
    var probeTick by remember { mutableIntStateOf(0) }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = CompanionAlerts.notificationsAllowed(context) }
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) {
            allowed = CompanionAlerts.notificationsAllowed(context)
            probeTick += 1
        } }
        owner.lifecycle.addObserver(observer); onDispose { owner.lifecycle.removeObserver(observer) }
    }
    fun open(intent: Intent) { runCatching { context.startActivity(intent) }.onFailure { model.message = t(R.string.android_could_not_open_setting) } }
    ScreenList {
        item {
            SectionLabel(t(R.string.android_permission))
            Text(if (allowed) t(R.string.notifications_are_allowed) else t(R.string.choose_what_reaches_you), style = MaterialTheme.typography.titleMedium)
            Text(t(R.string.get_relevant_school_changes_and_excuse_deadlines), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedButton(onClick = { if (!allowed && Build.VERSION.SDK_INT >= 33) request.launch(Manifest.permission.POST_NOTIFICATIONS) else open(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }, modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) { Text(if (allowed) t(R.string.android_notification_settings) else t(R.string.allow_notifications)) }
            if (!allowed && Build.VERSION.SDK_INT >= 33) TextButton(onClick = { open(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }) { Text(t(R.string.open_android_settings)) }
        }
        item { SectionLabel(t(R.string.school_updates)) }
        item { ToggleRow(t(R.string.grades), t(R.string.new_or_changed_marks), model.settings.grades) { model.toggleSetting("grades") } }
        item { ToggleRow(t(R.string.guess_the_grade), t(R.string.hide_new_marks_until_you_reveal_them_notificatio), model.settings.guessGrades) { model.toggleSetting("guessGrades") } }
        item { ToggleRow(t(R.string.hold_to_reveal), t(R.string.with_guess_the_grade_a_long_press_opens_a_hidden), model.desk.revealLongPress) { model.updateDesk(model.desk.copy(revealLongPress = it)) } }
        item { ToggleRow(t(R.string.timetable_changes), t(R.string.room_changes_substitutions_and_cancellations), model.settings.timetable) { model.toggleSetting("timetable") } }
        item { ToggleRow(t(R.string.exams), checked = model.settings.exams) { model.toggleSetting("exams") } }
        item { ToggleRow(t(R.string.absences), checked = model.settings.absences) { model.toggleSetting("absences") } }
        item { ToggleRow(t(R.string.excuse_deadlines), checked = model.settings.deadlines) { model.toggleSetting("deadlines") } }
        item { ToggleRow(t(R.string.events_messages), checked = model.settings.events) { model.toggleSetting("events") } }
        item { SectionLabel(t(R.string.delivery)) }
        item {
            Text(
                when (deliveryModeLabel(firebaseConfigured(context), model.graph.lastPushAt(), System.currentTimeMillis())) {
                    "Instant via push" -> t(R.string.new_grades_arrive_instantly_no_background_check)
                    else -> if (firebaseConfigured(context)) t(R.string.push_has_been_quiet_kanti_checks_about_every_6_h)
                    else t(R.string.school_updates_are_checked_about_every_6_hours)
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(bottom = 12.dp),
            )
        }
        item { OutlinedButton(onClick = { model.testPush(context) }, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.send_a_test_notification)) } }
        item { OutlinedButton(onClick = { model.probeDelivery(context) }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) { Text(t(R.string.send_delivery_probe)) } }
        item {
            Text(
                t(R.string.delivery_probe_help),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 8.dp, bottom = 4.dp),
            )
        }
        val probeLines = probeTick.let { CompanionAlerts.probeSummaries(context) }
        if (probeLines.isNotEmpty()) {
            item { SectionLabel(t(R.string.delivery_times)) }
            item {
                Column(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                    probeLines.forEach { line ->
                        Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 6.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun DiagnosticChoice(label: String, selected: Boolean, onClick: () -> Unit) {
    if (selected) Button(onClick = onClick, modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)) { Text(label) }
    else OutlinedButton(onClick = onClick, modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)) { Text(label) }
}

private fun diagnosticSyncRes(status: SyncStatus): Int = when (status) {
    SyncStatus.UNAVAILABLE -> R.string.diagnostic_sync_unavailable
    SyncStatus.SIGNED_OUT -> R.string.diagnostic_sync_signed_out
    SyncStatus.IDLE -> R.string.diagnostic_sync_idle
    SyncStatus.SYNCING -> R.string.diagnostic_sync_syncing
    SyncStatus.OFFLINE -> R.string.diagnostic_sync_offline
    SyncStatus.ERROR -> R.string.diagnostic_sync_error
    SyncStatus.PAUSED -> R.string.diagnostic_sync_paused
}

@Composable
private fun DiagnosticLine(label: String, value: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
    FineDivider()
}
