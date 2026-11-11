package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.schulnetz.SchoolProvider
import android.Manifest
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ch.fasrv.fanotes.schulnetz.*
import ch.fasrv.fanotes.sync.SyncStatus
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

fun themeLabel(id: String): String = when (id) {
    "light" -> t(R.string.paper); "dark" -> t(R.string.graphite); "midnight" -> t(R.string.midnight); "forest" -> t(R.string.forest)
    "aurora" -> t(R.string.aurora); "sepia" -> t(R.string.warm_paper); SNOW_THEME_ID -> t(R.string.snow_theme); else -> t(R.string.system)
}

@Composable
fun SettingsScreen(model: CompanionModel, page: Page) {
    val context = LocalContext.current
    val sync by model.graph.engine.state.collectAsStateWithLifecycle()
    var confirm by remember { mutableStateOf("") }
    var connectionMenu by remember { mutableStateOf<String?>(null) }
    var renameTarget by remember { mutableStateOf<String?>(null) }
    var renameDraft by remember { mutableStateOf("") }
    var addConnection by remember { mutableStateOf(false) }
    var deleteAccount by remember { mutableStateOf(false) }
    var deletePassword by remember { mutableStateOf("") }
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
    androidx.compose.runtime.key(page) {
    when (page) {
        Page.Settings -> ScreenList {
            item(key = "identity") {
                Group(Modifier.padding(top = 4.dp)) {
                    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        IconTile(if (model.notesAccount) Icons.Outlined.PersonOutline else Icons.Outlined.School, StateTone.Accent, 48.dp)
                        Column(Modifier.weight(1f)) {
                            Text(sync.account?.email ?: if (model.notesAccount) t(R.string.your_fanotes) else t(R.string.kanti), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(if (model.notesAccount) syncDescription(sync.status) else t(R.string.grades_timetable_and_school_updates), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            item(key = "school-head") { SectionLabel(t(R.string.settings_school_account)) }
            item(key = "school") {
                Group {
                    if (model.notesAccount) SettingRow(Icons.Outlined.ManageAccounts, t(R.string.account_sync), t(R.string.fanotes_schulnetz_and_offline_status)) { model.navigate(Page.Connections) }
                    else SettingRow(Icons.Outlined.School, t(R.string.schulnetz), t(R.string.connection_notifications_and_this_device)) { model.navigate(Page.Connections) }
                    FineDivider()
                    SettingRow(Icons.Outlined.NotificationsNone, t(R.string.notifications), t(R.string.what_reaches_you_and_when)) { model.navigate(Page.Notifications) }
                    FineDivider()
                    SettingRow(Icons.Outlined.DirectionsBus, t(R.string.commute_title), commuteSettingsSummary(model.commute)) { model.navigate(Page.Commute) }
                    FineDivider()
                    SettingRow(Icons.Outlined.Laptop, t(R.string.web_access), t(R.string.web_access_row)) { model.navigate(Page.WebAccess) }
                    if (!model.notesAccount) { FineDivider(); SettingRow(Icons.Outlined.EditNote, t(R.string.sync_notes_with_fanotes), t(R.string.optional_school_stays_available_either_way)) { model.navigate(Page.Auth) } }
                }
            }
            item(key = "look-head") { SectionLabel(t(R.string.make_it_yours)) }
            item(key = "look") {
                Group {
                    SettingRow(Icons.Outlined.Palette, t(R.string.appearance), themeLabel(model.desk.theme.ifBlank { "system" })) { model.navigate(Page.Appearance) }
                    FineDivider()
                    SettingRow(Icons.Outlined.ViewWeek, t(R.string.navigation_bar), t(R.string.choose_tabs_and_their_order)) { model.navigate(Page.Navigation) }
                    FineDivider()
                    SettingRow(Icons.Outlined.Tune, t(R.string.planning_grades), t(R.string.today_timetable_and_grade_display)) { model.navigate(Page.Planning) }
                    FineDivider()
                    Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            IconTile(Icons.Outlined.Translate)
                            Text(t(R.string.language), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = 14.dp))
                        }
                        ChoiceRow(
                            listOf("system" to t(R.string.system), "de" to t(R.string.language_german), "en" to t(R.string.language_english)),
                            AppLanguage.selectedTag(),
                            onSelect = { tag ->
                                if (tag != AppLanguage.selectedTag()) {
                                    AppLanguage.choose(tag)
                                    CompanionAlerts.ensureChannels(context)
                                    NextLessonWidget.update(context)
                                    context.hostActivity()?.recreate()
                                }
                            },
                            modifier = Modifier.padding(top = 4.dp),
                        )
                    }
                }
            }
            item(key = "about-head") { SectionLabel(t(R.string.about_kanti)) }
            item(key = "about") {
                Group {
                    if (model.notesAccount) { SettingRow(Icons.Outlined.AutoGraph, t(R.string.your_activity), t(R.string.notes_habits_and_milestones)) { model.navigate(Page.Profile) }; FineDivider() }
                    if (model.notesAccount) { SettingRow(Icons.Outlined.ManageSearch, t(R.string.doc_search_title), t(R.string.doc_search_row), if (model.docStatus.running) "${model.docStatus.progress.done}/${model.docStatus.progress.total}" else "") { model.navigate(Page.DocSearch) }; FineDivider() }
                    SettingRow(Icons.Outlined.AutoAwesome, t(R.string.replay_onboarding), t(R.string.replay_onboarding_body)) { model.replayOnboarding() }
                    FineDivider()
                    SettingRow(Icons.Outlined.BugReport, t(R.string.diagnostics), t(R.string.connection_checks_and_support_exports)) { model.navigate(Page.Diagnostics) }
                }
            }
            item(key = "version") { Text(t(R.string.version_line, BuildConfig.VERSION_NAME), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 28.dp)) }
        }
        Page.Connections -> ScreenList {
            if (model.notesAccount) {
                item(key = "fanotes-head") { SectionLabel(t(R.string.fanotes_account)) }
                item(key = "fanotes") {
                    Group {
                        Column(Modifier.padding(16.dp)) {
                            Text(sync.account?.email ?: t(R.string.work_on_this_device), style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            StatusLine(syncDescription(sync.status), when (sync.status) { SyncStatus.ERROR -> StateTone.Error; SyncStatus.OFFLINE -> StateTone.Offline; SyncStatus.IDLE -> StateTone.Accent; else -> StateTone.Neutral }, Modifier.padding(top = 6.dp))
                            Text(t(R.string.your_notes_stay_available_offline_a_connected_ac), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 14.dp))
                            if (sync.account == null) PrimaryButton(t(R.string.connect_an_account), { model.navigate(Page.Auth) }, Modifier.fillMaxWidth())
                            else {
                                Text(t(R.string.last_sync, sync.lastSyncAt?.let(::updatedLabel) ?: t(R.string.not_yet)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                PrimaryButton(t(R.string.sync_now), model::sync, Modifier.fillMaxWidth().padding(top = 14.dp), enabled = !model.busy && sync.status != SyncStatus.SYNCING, icon = Icons.Outlined.Sync)
                                if (model.graph.plannerHold()) SecondaryButton(t(R.string.upload_tasks_and_calendar), model::acceptUpload, Modifier.fillMaxWidth().padding(top = 10.dp))
                                TextButton(onClick = { confirm = "logout" }, modifier = Modifier.padding(top = 4.dp)) { Text(t(R.string.sign_out), color = MaterialTheme.colorScheme.error) }
                                TextButton(onClick = { deletePassword = ""; deleteAccount = true }, enabled = !model.busy) { Text(t(R.string.delete_fanotes_account), color = MaterialTheme.colorScheme.error) }
                            }
                        }
                    }
                }
                sync.error?.let { error -> item(key = "sync-error") { Spacer(Modifier.height(12.dp)); InfoBanner(t(R.string.sync_needs_attention), shownText(error), t(R.string.try_again), true, onAction = model::sync) } }
                if (sync.conflicts.isNotEmpty()) item(key = "conflicts") { Spacer(Modifier.height(12.dp)); InfoBanner(t(R.string.conflict_copies_kept), tp(R.plurals.conflict_copies, sync.conflicts.size, sync.conflicts.size), tone = StateTone.Warning) }
            }
            // Every connection: show it, rename it, sign in again or remove it; add another one.
            item(key = "connections-head") { SectionLabel(t(R.string.school_connections)) }
            item(key = "connections") {
                Group {
                    model.connections.connections.forEachIndexed { index, connection ->
                        if (index > 0) FineDivider()
                        val shown = connection.id == model.connections.active?.id
                        val provider = if (connection.provider == SchoolProvider.TAM) t(R.string.connection_provider_tam) else t(R.string.connection_provider_schulnetz)
                        SettingRow(Icons.Outlined.School, connection.label, if (shown) t(R.string.connection_row_shown, provider) else provider) { connectionMenu = connection.id }
                    }
                    if (model.connections.connections.isNotEmpty()) FineDivider()
                    SettingRow(Icons.Outlined.Add, t(R.string.add_connection), t(R.string.connection_add_body)) { addConnection = true }
                }
            }
            item(key = "school-head") { SectionLabel(model.connections.active?.label ?: t(R.string.school_connection)) }
            item(key = "school") {
                Group {
                    Column(Modifier.padding(16.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            IconTile(Icons.Outlined.School, StateTone.Accent, 44.dp)
                            Column {
                                Text(model.connections.active?.label ?: t(R.string.schulnetz), style = MaterialTheme.typography.titleLarge)
                                StatusLine(when { model.demo -> t(R.string.demo_active_title); model.link.needsReauth -> t(R.string.sign_in_again_to_refresh); model.link.linked -> t(R.string.connected); else -> t(R.string.not_connected) },
                                    when { model.demo -> StateTone.Warning; model.link.needsReauth -> StateTone.Warning; model.link.linked -> StateTone.Accent; else -> StateTone.Neutral })
                            }
                        }
                        Text(t(R.string.read_your_school_information_here_manage_officia), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 14.dp))
                        val tam = model.shownProvider == SchoolProvider.TAM
                        OutlinedTextField(model.baseUrl, { model.baseUrl = it }, Modifier.fillMaxWidth(), label = { Text(t(R.string.school_address)) }, singleLine = true, shape = MaterialTheme.shapes.small, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
                        PrimaryButton(
                            when {
                                tam && model.link.linked && !model.link.needsReauth -> t(R.string.sign_in_again)
                                tam -> t(R.string.connect_tam)
                                model.link.needsReauth -> t(R.string.sign_in_to_schulnetz_again)
                                model.link.linked -> t(R.string.open_school_session)
                                else -> t(R.string.connect_with_microsoft)
                            },
                            { model.requestVisibleLogin("connections") },
                            Modifier.fillMaxWidth().padding(top = 14.dp), enabled = !model.busy)
                        if (tam) {
                            // Appointments come from the user's own TAM calendar export, when they add it.
                            var link by remember(model.tamCalendarLink) { mutableStateOf(model.tamCalendarLink) }
                            Text(t(R.string.tam_calendar_link_body), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 14.dp))
                            OutlinedTextField(link, { link = it }, Modifier.fillMaxWidth().padding(top = 6.dp), label = { Text(t(R.string.tam_calendar_link)) }, singleLine = true, shape = MaterialTheme.shapes.small, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
                            SecondaryButton(t(R.string.save), { model.saveTamCalendarLink(link) }, Modifier.fillMaxWidth().padding(top = 8.dp), enabled = !model.busy)
                        }
                        Text(t(R.string.school_data_updated, updatedLabel(model.snapshot.fetchedAt)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp))
                    }
                    if (model.demo) {
                        FineDivider()
                        Box(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) { InfoBanner(t(R.string.demo_active_title), t(R.string.demo_active_body), tone = StateTone.Warning) }
                        SettingRow(Icons.Outlined.NotificationsActive, t(R.string.demo_sample_notice), "", chevron = false) { model.showDemoNotice(context) }
                        FineDivider()
                        SettingRow(Icons.Outlined.LinkOff, t(R.string.demo_end), "", chevron = false) { model.stopDemo() }
                    } else if (model.canStartDemo()) {
                        FineDivider()
                        SettingRow(Icons.Outlined.School, t(R.string.demo_view), t(R.string.demo_view_body)) { model.startDemo() }
                    }
                    if (!model.demo && (model.link.linked || !model.notesAccount)) FineDivider()
                    if (model.link.linked && !model.demo) SettingRow(Icons.Outlined.LinkOff, t(R.string.disconnect_school), "", chevron = false) { confirm = "unlink" }
                    if (!model.notesAccount && !model.demo) {
                        if (model.link.linked) FineDivider()
                        SettingRow(Icons.Outlined.EditNote, t(R.string.sync_notes_with_fanotes), "") { model.navigate(Page.Auth) }
                        FineDivider()
                        SettingRow(Icons.Outlined.DeleteOutline, t(R.string.delete_my_kanti_data), "", tone = StateTone.Error, chevron = false) { confirm = "delete-kanti" }
                    }
                }
                if (model.link.lastError.isNotBlank()) Box(Modifier.padding(top = 12.dp)) { InfoBanner(t(R.string.school_connection_needs_attention), shownText(model.link.lastError), t(R.string.diagnostics), true, onAction = { model.navigate(Page.Diagnostics) }) }
            }
        }
        Page.WebAccess -> WebAccessSettings(model)
        Page.Appearance -> AppearanceSettings(model)
        Page.Navigation -> NavigationBarSettings(model)
        Page.Planning -> ScreenList {
            item(key = "start-head") { SectionLabel(t(R.string.when_you_open_kanti)) }
            item(key = "start") { ChoiceRow((if (model.notesAccount) NAV_BAR_IDS else NAV_BAR_IDS.filter { it != "notes" }).map { it to navBarLabel(it) }, startTabId(model.desk.startTab).let { if (!model.notesAccount && it == "notes") "today" else it }, { model.updateDesk(model.desk.copy(startTab = it)) }) }
            item(key = "today-head") { SectionLabel(t(R.string.on_today)) }
            itemsIndexed(TODAY_CARD_IDS, key = { _, it -> "card:$it" }) { index, id ->
                GroupItem(index, TODAY_CARD_IDS.size) {
                    ToggleRow(when (id) { "lessons" -> t(R.string.next_commitment); "exam" -> t(R.string.upcoming_exam); "grades" -> t(R.string.grade_overview); "pluspunkte" -> t(R.string.promotion_points_2); "absences" -> t(R.string.absence_points); "events" -> t(R.string.school_updates); "commute" -> t(R.string.commute_title); else -> t(R.string.tasks) }, checked = id !in model.desk.hiddenCards) { show ->
                        model.updateDesk(model.desk.copy(hiddenCards = if (show) model.desk.hiddenCards - id else (model.desk.hiddenCards + id).distinct()))
                    }
                }
            }
            item(key = "mensa-toggle") {
                Group(Modifier.padding(top = 8.dp)) {
                    ToggleRow(t(R.string.mensa_setting), t(R.string.mensa_setting_body), model.desk.showMensa) { model.updateDesk(model.desk.copy(showMensa = it)); if (it) model.refreshMensa() }
                }
            }
            item(key = "timetable-head") { SectionLabel(t(R.string.timetable)) }
            item(key = "timetable") {
                Group {
                    ToggleRow(t(R.string.compact_rows), t(R.string.show_more_lessons_at_a_glance), model.desk.planCompact) { model.updateDesk(model.desk.copy(planCompact = it)) }
                    FineDivider()
                    ToggleRow(t(R.string.include_weekends), t(R.string.show_empty_weekend_days_in_week_view), model.desk.showWeekend) { model.updateDesk(model.desk.copy(showWeekend = it)) }
                    FineDivider()
                    Column(Modifier.padding(16.dp)) {
                        Text(t(R.string.visible_school_hours), style = MaterialTheme.typography.bodyLarge)
                        Text(t(R.string.from_label), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
                        ChoiceRow((0..23).map { it.toString() to "%02d:00".format(it) }, model.desk.dayStartHour.toString(), { model.updateDesk(model.desk.copy(dayStartHour = it.toInt(), dayEndHour = maxOf(model.desk.dayEndHour, it.toInt() + 1))) })
                        Text(t(R.string.until), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                        ChoiceRow(((model.desk.dayStartHour + 1)..24).map { it.toString() to "%02d:00".format(it) }, model.desk.dayEndHour.toString(), { model.updateDesk(model.desk.copy(dayEndHour = it.toInt())) })
                    }
                }
            }
            if (model.hidden.isNotEmpty()) {
                item(key = "hidden-head") { SectionLabel(t(R.string.hidden_lessons), count = model.hidden.size) }
                itemsIndexed(model.hidden, key = { _, it -> it.id }) { index, rule ->
                    GroupItem(index, model.hidden.size) {
                        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) { Text(rule.subject, style = MaterialTheme.typography.bodyLarge); Text(if (rule.mode == "once") rule.date else t(R.string.text_2, runCatching { java.time.DayOfWeek.of(rule.weekday).getDisplayName(java.time.format.TextStyle.SHORT, AppLanguage.formatLocale()) }.getOrDefault(t(R.string.weekly)), rule.start), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            TextButton(onClick = { model.restoreLesson(rule.id) }) { Text(t(R.string.restore)) }
                        }
                    }
                }
            }
            item(key = "grades-head") { SectionLabel(t(R.string.grades_widget)) }
            item(key = "grades") {
                Group {
                    ToggleRow(t(R.string.promotion_points_2), t(R.string.show_the_calculated_points_balance), model.desk.showPluspunkte) { model.updateDesk(model.desk.copy(showPluspunkte = it)) }
                    FineDivider()
                    Column(Modifier.padding(16.dp)) {
                        Text(t(R.string.grade_precision), style = MaterialTheme.typography.bodyLarge)
                        ChoiceRow((0..3).map { it.toString() to tp(R.plurals.decimals_count, it, it) }, model.desk.gradeDecimals.toString(), { model.updateDesk(model.desk.copy(gradeDecimals = it.toInt())) })
                        Text(t(R.string.subject_order), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 8.dp))
                        ChoiceRow(listOf("name" to t(R.string.name), "average" to t(R.string.average), "pluspunkte" to t(R.string.points)), model.desk.gradeSort, { model.updateDesk(model.desk.copy(gradeSort = it)) })
                    }
                    FineDivider()
                    ToggleRow(t(R.string.compact_home_widget), t(R.string.use_a_smaller_next_lesson_summary), model.desk.widgetCompact) { model.updateDesk(model.desk.copy(widgetCompact = it)) }
                }
            }
        }
        Page.Notifications -> NotificationSettings(model)
        Page.Diagnostics -> ScreenList {
            item(key = "mode") {
                Text(t(R.string.diagnostic_mode_help), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp, bottom = 12.dp))
                Group { ToggleRow(t(R.string.diagnostic_mode), "", model.diagnosticOn) { model.setDiagnosticMode(it) } }
            }
            item(key = "state-head") { SectionLabel(t(R.string.connection_checks)) }
            item(key = "state") {
                Group {
                    DiagnosticLine(t(R.string.diagnostic_label_school), if (model.link.linked) t(R.string.diagnostic_value_linked) else t(R.string.diagnostic_value_separated))
                    DiagnosticLine(t(R.string.diagnostic_label_push), if (model.graph.fcmToken().isNullOrBlank()) t(R.string.diagnostic_value_unregistered) else t(R.string.diagnostic_value_registered))
                    DiagnosticLine(t(R.string.diagnostic_label_sync), t(diagnosticSyncRes(sync.status)))
                    DiagnosticLine(t(R.string.diagnostic_label_build), "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", last = true)
                }
            }
            if (model.diagnosticOn) {
                item(key = "preview-head") { SectionLabel(t(R.string.diagnostic_preview)) }
                item(key = "preview") {
                    Text(t(R.string.diagnostic_local_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
                    ChoiceRow(listOf("school" to t(R.string.diagnostic_school), "states" to t(R.string.diagnostic_states), "malformed" to t(R.string.diagnostic_malformed), "alerts" to t(R.string.diagnostic_alerts)),
                        when (model.diagnosticScenario) { DiagnosticScenario.SCHOOL -> "school"; DiagnosticScenario.STATES -> "states"; DiagnosticScenario.MALFORMED -> "malformed"; DiagnosticScenario.ALERTS -> "alerts"; else -> "" },
                        { model.selectDiagnosticScenario(it) })
                }
                if (model.diagnosticScenario != DiagnosticScenario.OFF) {
                    val lines = diagnosticPreview(model.diagnosticScenario, ZoneId.of("Europe/Zurich"), LocalDate.now(ZoneId.of("Europe/Zurich")), model.settings)
                    itemsIndexed(lines, key = { _, it -> "sim:${it.title}:${it.detail}" }) { index, line ->
                        GroupItem(index, lines.size) {
                            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
                                Text(line.title, style = MaterialTheme.typography.titleSmall)
                                Text(line.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
                item(key = "delivery-head") { SectionLabel(t(R.string.delivery)) }
                item(key = "delivery") {
                    Text(t(R.string.diagnostic_remote_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 6.dp))
                    Text(t(R.string.diagnostic_remote_prefs), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 10.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SecondaryButton(t(R.string.diagnostic_remote_standard), { model.probeDelivery(context, "standard") }, Modifier.fillMaxWidth())
                        SecondaryButton(t(R.string.diagnostic_remote_duplicate), { model.probeDelivery(context, "duplicate") }, Modifier.fillMaxWidth())
                        SecondaryButton(t(R.string.diagnostic_remote_reorder), { model.probeDelivery(context, "reorder") }, Modifier.fillMaxWidth())
                        SecondaryButton(t(R.string.diagnostic_remote_delayed), { model.scheduleProbe(context, "standard") }, Modifier.fillMaxWidth())
                    }
                    Text(t(R.string.diagnostic_remote_delayed_body), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
                }
            }
            item(key = "failures") {
                val tick = model.diagnosticTick
                val failures = if (tick >= 0) DiagnosticTrace.failures().takeLast(6) else emptyList()
                SectionLabel(t(R.string.diagnostic_failures))
                if (failures.isEmpty()) {
                    StatusLine(t(R.string.diagnostic_no_failures), StateTone.Accent)
                } else Group {
                    Column(Modifier.padding(16.dp)) {
                        failures.forEach { entry ->
                            val parts = listOf(entry.category, entry.name, "${entry.durationMs}ms", entry.result)
                            val label = if (entry.detail.isBlank()) parts.joinToString(" ") else (parts + entry.detail).joinToString(" ")
                            Text(label, style = TimeSmallStyle, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 6.dp))
                        }
                    }
                }
                Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryButton(t(R.string.diagnostic_export), { model.diagnosticExport = model.prepareDiagnosticExport() }, Modifier.fillMaxWidth())
                    SecondaryButton(t(R.string.diagnostic_stop), { confirm = "diagnostic-reset" }, Modifier.fillMaxWidth())
                }
            }
            item(key = "timing-head") { SectionLabel(t(R.string.delivery)) }
            item(key = "timing") {
                fun at(ms: Long) = if (ms <= 0L) t(R.string.not_yet) else formatSchoolStamp(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()), "d MMM yyyy · HH:mm")
                val delivery = deliveryModeLabel(firebaseConfigured(context), model.graph.lastPushAt(), System.currentTimeMillis())
                Group {
                    DiagnosticLine(t(R.string.delivery), if (delivery == "Instant via push") t(R.string.instant_via_push) else t(R.string.fallback_mode))
                    DiagnosticLine(t(R.string.last_push), at(model.graph.lastPushAt()))
                    DiagnosticLine(t(R.string.last_school_check), at(model.graph.lastCheckAt()))
                    DiagnosticLine(t(R.string.next_scheduled_check), at(model.graph.nextCheckAt()))
                    DiagnosticLine(t(R.string.cached_school_data), updatedLabel(model.snapshot.fetchedAt), last = true)
                }
                val error = model.graph.lastCheckError().ifBlank { model.link.lastError }
                if (error.isNotBlank()) Box(Modifier.padding(top = 12.dp)) { InfoBanner(t(R.string.last_check), shownText(error), error = true) }
            }
            if (model.snapshot.readErrors.isNotEmpty()) {
                item(key = "reports-head") { SectionLabel(t(R.string.source_reports), count = model.snapshot.readErrors.size) }
                itemsIndexed(model.snapshot.readErrors, key = { index, error -> "err:$index:$error" }) { index, error ->
                    GroupItem(index, model.snapshot.readErrors.size) { Text(shownText(error), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) }
                }
            }
            item(key = "export-head") { SectionLabel(t(R.string.support_exports)) }
            item(key = "export") {
                Text(t(R.string.share_an_export_when_troubleshooting_a_school_co), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Column(Modifier.padding(top = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryButton(t(R.string.share_school_page), { model.shareDebug(context) }, Modifier.fillMaxWidth())
                    SecondaryButton(t(R.string.share_diagnostic_archive), { model.shareLogs(context) }, Modifier.fillMaxWidth())
                    TextButton(onClick = { confirm = "logs-captures" }, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.include_saved_school_pages)) }
                    if (model.notesAccount) SecondaryButton(t(R.string.refresh_connections), model::sync, Modifier.fillMaxWidth(), enabled = !model.busy)
                    else SecondaryButton(t(R.string.refresh_school_data), model::refreshSchool, Modifier.fillMaxWidth(), enabled = !model.busy)
                }
            }
        }
        Page.Profile -> ScreenList {
            item(key = "head") {
                Text(t(R.string.a_little_progress_every_day), style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(top = 4.dp))
                Group(Modifier.padding(top = 16.dp)) {
                    Row(Modifier.fillMaxWidth().padding(20.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                        if (model.notesAccount) MetricBlock(tp(R.plurals.profile_notes, model.writtenNotes), model.writtenNotes.toString(), Modifier.weight(1f))
                        MetricBlock(t(R.string.days_in_a_row), model.graph.streakDays().toString(), Modifier.weight(1f))
                    }
                }
                SectionLabel(t(R.string.milestones))
            }
            val badges = companionBadges(model.writtenNotes, model.graph.streakDays(), highestVisibleMark(model.snapshot.grades, model.hiddenGradeIds(), model.settings.guessGrades)).filter { model.notesAccount || !it.id.startsWith("notes") }
            itemsIndexed(badges, key = { _, it -> it.id }) { index, badge ->
                val title = when (badge.id) { "notes-1" -> t(R.string.badge_first_thought); "notes-10" -> t(R.string.badge_growing_notebook); "streak-3" -> t(R.string.badge_finding_rhythm); else -> t(R.string.badge_top_marks) }
                val body = when (badge.id) { "notes-1" -> t(R.string.badge_write_first); "notes-10" -> t(R.string.badge_keep_ten); "streak-3" -> t(R.string.badge_open_three); else -> t(R.string.badge_grade_six) }
                GroupItem(index, badges.size) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        IconTile(if (badge.earned) Icons.Outlined.Verified else Icons.Outlined.RadioButtonUnchecked, if (badge.earned) StateTone.Accent else StateTone.Neutral)
                        Column(Modifier.weight(1f)) { Text(title, style = MaterialTheme.typography.titleMedium); Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        Text(if (badge.earned) t(R.string.achieved) else t(R.string.not_yet_achieved), style = MaterialTheme.typography.labelMedium, color = if (badge.earned) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        else -> Unit
    }
    }
    connectionMenu?.let { id ->
        val connection = model.connections.byId(id)
        if (connection == null) { connectionMenu = null } else AlertDialog(
            onDismissRequest = { connectionMenu = null },
            shape = MaterialTheme.shapes.extraLarge,
            title = { Text(connection.label, style = MaterialTheme.typography.headlineSmall) },
            text = {
                Column {
                    if (connection.id != model.connections.active?.id) SettingRow(Icons.Outlined.Visibility, t(R.string.show_connection), "", chevron = false) { model.showConnection(id); connectionMenu = null }
                    SettingRow(Icons.Outlined.Edit, t(R.string.rename_connection), "", chevron = false) { renameDraft = connection.label; renameTarget = id; connectionMenu = null }
                    SettingRow(Icons.Outlined.Login, t(R.string.sign_in_again), "", chevron = false) { model.reloginConnection(id); connectionMenu = null }
                    SettingRow(Icons.Outlined.DeleteOutline, t(R.string.remove_connection), "", tone = StateTone.Error, chevron = false) { confirm = "remove:$id"; connectionMenu = null }
                }
            },
            confirmButton = { TextButton(onClick = { connectionMenu = null }) { Text(t(R.string.close)) } },
        )
    }
    renameTarget?.let { id ->
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            shape = MaterialTheme.shapes.extraLarge,
            title = { Text(t(R.string.rename_connection), style = MaterialTheme.typography.headlineSmall) },
            text = { OutlinedTextField(renameDraft, { renameDraft = it.take(40) }, Modifier.fillMaxWidth(), label = { Text(t(R.string.connection_name)) }, singleLine = true, shape = MaterialTheme.shapes.small) },
            confirmButton = { TextButton(onClick = { model.renameConnection(id, renameDraft); renameTarget = null }) { Text(t(R.string.save)) } },
            dismissButton = { TextButton(onClick = { renameTarget = null }) { Text(t(R.string.cancel)) } },
        )
    }
    if (addConnection) {
        var provider by remember { mutableStateOf(SchoolProvider.SCHULNETZ) }
        var address by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { addConnection = false },
            shape = MaterialTheme.shapes.extraLarge,
            title = { Text(t(R.string.add_connection), style = MaterialTheme.typography.headlineSmall) },
            text = {
                Column {
                    SegmentedTabs(listOf(SchoolProvider.SCHULNETZ.wire to t(R.string.connection_provider_schulnetz), SchoolProvider.TAM.wire to t(R.string.connection_provider_tam)), provider.wire, { provider = SchoolProvider.of(it) }, Modifier.fillMaxWidth())
                    OutlinedTextField(address, { address = it }, Modifier.fillMaxWidth().padding(top = 12.dp), singleLine = true, shape = MaterialTheme.shapes.small,
                        label = { Text(if (provider == SchoolProvider.TAM) t(R.string.connection_address_tam_hint) else t(R.string.connection_address_schulnetz_hint)) },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
                    Text(t(R.string.connection_add_body), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp))
                }
            },
            confirmButton = { TextButton(onClick = { addConnection = false; model.addConnection(provider, address) }, enabled = address.isNotBlank() && !model.busy) { Text(t(R.string.add_connection)) } },
            dismissButton = { TextButton(onClick = { addConnection = false }) { Text(t(R.string.cancel)) } },
        )
    }
    if (confirm.startsWith("remove:")) {
        val id = confirm.removePrefix("remove:")
        ConfirmDialog(
            model.connections.byId(id)?.label ?: t(R.string.remove_connection),
            t(R.string.remove_connection_body),
            t(R.string.remove_connection),
            { confirm = "" },
        ) {
            model.removeConnection(id)
            confirm = ""
        }
    } else if (confirm.isNotBlank()) {
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
    if (deleteAccount) {
        AlertDialog(
            onDismissRequest = { deleteAccount = false },
            shape = MaterialTheme.shapes.extraLarge,
            title = { Text(t(R.string.delete_fanotes_account), style = MaterialTheme.typography.headlineSmall) },
            text = {
                Column {
                    Text(t(R.string.delete_fanotes_account_body), style = MaterialTheme.typography.bodyMedium)
                    OutlinedTextField(deletePassword, { deletePassword = it }, Modifier.fillMaxWidth().padding(top = 12.dp), label = { Text(t(R.string.password)) }, singleLine = true,
                        visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                }
            },
            confirmButton = {
                TextButton(onClick = { model.deleteNotesAccount(deletePassword); deletePassword = ""; deleteAccount = false }, enabled = deletePassword.isNotBlank()) {
                    Text(t(R.string.delete), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { deletePassword = ""; deleteAccount = false }) { Text(t(R.string.cancel)) } },
        )
    }
    val export = model.diagnosticExport
    if (export != null) {
        AlertDialog(
            onDismissRequest = { model.diagnosticExport = null },
            shape = MaterialTheme.shapes.extraLarge,
            title = { Text(t(R.string.diagnostic_export), style = MaterialTheme.typography.headlineSmall) },
            text = {
                Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                    Text(export, style = TimeSmallStyle)
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

/** A miniature of a theme: background, a card, the accent and two text lines. */
@Composable
private fun ThemeTile(id: String, selected: Boolean, accent: String, amoled: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val systemDark = isSystemInDarkTheme()
    val previews = remember(id, accent, amoled, systemDark) {
        if (id == "system") listOf(kantiPalette("light", false, accent, amoled), kantiPalette("dark", true, accent, amoled)) else listOf(kantiPalette(id, systemDark, accent, amoled))
    }
    val label = themeLabel(id)
    val scheme = MaterialTheme.colorScheme
    Column(modifier.clip(MaterialTheme.shapes.large).selectable(selected, onClick = onClick, role = Role.RadioButton)
        .clearAndSetSemantics { contentDescription = label; this.selected = selected }
        .border(if (selected) 2.dp else 1.dp, if (selected) scheme.onSurface else LocalCompanionSemantics.current.hairline, MaterialTheme.shapes.large).padding(8.dp)) {
        Row(Modifier.fillMaxWidth().height(72.dp).clip(MaterialTheme.shapes.medium)) {
            previews.forEach { p ->
                Box(Modifier.weight(1f).fillMaxHeight().background(Color(p.background)).padding(8.dp)) {
                    Column(Modifier.fillMaxSize().background(Color(p.surface), RoundedCornerShape(8.dp)).padding(7.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        Box(Modifier.size(width = 22.dp, height = 6.dp).background(Color(p.accent), CircleShape))
                        Box(Modifier.fillMaxWidth(0.8f).height(5.dp).background(Color(p.text).copy(alpha = 0.8f), CircleShape))
                        Box(Modifier.fillMaxWidth(0.55f).height(5.dp).background(Color(p.muted).copy(alpha = 0.6f), CircleShape))
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 8.dp, start = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (selected) Icon(Icons.Outlined.CheckCircle, null, Modifier.size(18.dp), tint = scheme.onSurface)
            else if (id == SNOW_THEME_ID) Icon(Icons.Outlined.AcUnit, null, Modifier.size(16.dp), tint = scheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun AppearanceSettings(model: CompanionModel) {
    val context = LocalContext.current
    val current = model.desk.theme.ifBlank { "system" }.let { if (it in KANTI_THEME_IDS) it else "system" }
    val semantics = LocalCompanionSemantics.current
    val reduced = LocalKantiMotion.current.reduced
    ScreenList {
        item(key = "theme-head") { SectionLabel(t(R.string.theme)) }
        item(key = "themes") {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val columns = if (maxWidth >= 560.dp) 4 else 2
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    KANTI_THEME_IDS.chunked(columns).forEach { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            row.forEach { id -> ThemeTile(id, id == current, model.desk.accent, model.desk.amoled, Modifier.weight(1f)) { model.chooseTheme(id) } }
                            repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                }
            }
        }
        item(key = "theme-options") {
            Spacer(Modifier.height(12.dp))
            Group {
                ToggleRow(t(R.string.pure_black), t(R.string.use_a_black_background_in_dark_themes), model.desk.amoled) { model.updateDesk(model.desk.copy(amoled = it)) }
                if (current == SNOW_THEME_ID) {
                    FineDivider()
                    ToggleRow(t(R.string.snowfall), if (reduced) t(R.string.snowfall_reduced) else t(R.string.snowfall_body), model.snowfall && !reduced, enabled = !reduced) { model.chooseSnowfall(it) }
                }
            }
        }
        item(key = "accent-head") { SectionLabel(if (model.notesAccount) t(R.string.ink_accent) else t(R.string.accent)) }
        item(key = "accent") {
            Group {
                Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
                    ColorChoices(listOf("#2a6f97", "#7f6df2", "#3d8bfd", "#2f9e6b", "#e15b64"), model.desk.accent, enabled = !semantics.fixedAccent) { model.updateDesk(model.desk.copy(accent = it)) }
                    Text(if (semantics.fixedAccent) t(R.string.snow_accent_note) else t(R.string.accent_contrast_adjusts_to_your_theme), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 6.dp, top = 4.dp, bottom = 4.dp))
                }
            }
        }
        item(key = "icon-head") { SectionLabel(t(R.string.home_screen_icon)) }
        item(key = "icon") { ChoiceRow(listOf("standard" to t(R.string.kanti), "schule" to t(R.string.school), "notiz" to t(R.string.notebook)), model.iconChoice, { model.chooseIcon(context, it) }) }
        item(key = "nav-head") { SectionLabel(t(R.string.navigation)) }
        item(key = "nav") { Group { SettingRow(Icons.Outlined.ViewWeek, t(R.string.navigation_bar), t(R.string.choose_tabs_and_their_order)) { model.navigate(Page.Navigation) } } }
    }
}

@Composable
private fun NavigationBarSettings(model: CompanionModel) {
    val bar = presentedNavBar(model.desk.navBar, model.notesAccount)
    val fallback = if (model.notesAccount) DEFAULT_NAV_BAR else SCHOOL_NAV_BAR
    val available = remainingNavBar(bar).filter { model.notesAccount || it != "notes" }
    ScreenList {
        item(key = "help") {
            SectionLabel(t(R.string.shown_in_the_bar), count = bar.size)
            Text(t(R.string.choose_2_to_5_destinations_settings_stays_availa), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 10.dp))
        }
        itemsIndexed(bar, key = { _, id -> "bar:$id" }) { index, id ->
            GroupItem(index, bar.size) {
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    IconTile(navBarIcon(id))
                    Column(Modifier.weight(1f).padding(start = 10.dp)) {
                        Text(navBarLabel(id), style = MaterialTheme.typography.bodyLarge)
                        Text(t(R.string.of, index + 1, bar.size), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    ActionIcon(Icons.Outlined.KeyboardArrowUp, t(R.string.move_up, navBarLabel(id)), enabled = index > 0) {
                        model.updateDesk(model.desk.copy(navBar = moveNavBarItem(bar, index, -1)))
                    }
                    ActionIcon(Icons.Outlined.KeyboardArrowDown, t(R.string.move_down, navBarLabel(id)), enabled = index < bar.lastIndex) {
                        model.updateDesk(model.desk.copy(navBar = moveNavBarItem(bar, index, 1)))
                    }
                    ActionIcon(Icons.Outlined.RemoveCircleOutline, t(R.string.remove, navBarLabel(id)), enabled = bar.size > NAV_BAR_MIN) {
                        model.updateDesk(model.desk.copy(navBar = removeNavBarItem(bar, id)))
                    }
                }
            }
        }
        if (available.isNotEmpty()) {
            item(key = "add-head") { SectionLabel(if (bar.size >= NAV_BAR_MAX) t(R.string.remove_a_tab_to_add_another) else t(R.string.add_a_destination)) }
            itemsIndexed(available, key = { _, it -> "add:$it" }) { index, id ->
                val enabled = bar.size < NAV_BAR_MAX
                GroupItem(index, available.size) {
                    SettingRow(navBarIcon(id), navBarLabel(id), if (enabled) t(R.string.add_to_the_navigation_bar) else t(R.string.maximum_of_5_tabs), chevron = false) { if (enabled) model.updateDesk(model.desk.copy(navBar = addNavBarItem(bar, id))) }
                }
            }
        }
        item(key = "reset") {
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
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        allowed = CompanionAlerts.notificationsAllowed(context)
        if (granted) model.onNotificationsAllowed()
    }
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) {
            allowed = CompanionAlerts.notificationsAllowed(context)
            probeTick += 1
        } }
        owner.lifecycle.addObserver(observer); onDispose { owner.lifecycle.removeObserver(observer) }
    }
    fun open(intent: Intent) { runCatching { context.startActivity(intent) }.onFailure { model.message = t(R.string.android_could_not_open_setting) } }
    val on = model.settings.enabled
    ScreenList {
        item(key = "permission") {
            Group(Modifier.padding(top = 4.dp)) {
                Column(Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconTile(if (allowed) Icons.Outlined.NotificationsActive else Icons.Outlined.NotificationsOff, if (allowed) StateTone.Accent else StateTone.Warning, 44.dp)
                        Column(Modifier.padding(start = 14.dp)) {
                            Text(if (allowed) t(R.string.notifications_are_allowed) else t(R.string.choose_what_reaches_you), style = MaterialTheme.typography.titleMedium)
                            Text(t(R.string.android_permission), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    Text(t(R.string.get_relevant_school_changes_and_excuse_deadlines), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp))
                    if (!allowed && Build.VERSION.SDK_INT >= 33) {
                        PrimaryButton(t(R.string.allow_notifications), { request.launch(Manifest.permission.POST_NOTIFICATIONS) }, Modifier.fillMaxWidth().padding(top = 14.dp))
                        TextButton(onClick = { open(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }) { Text(t(R.string.open_android_settings)) }
                    } else SecondaryButton(t(R.string.android_notification_settings), { open(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) }, Modifier.fillMaxWidth().padding(top = 14.dp))
                }
            }
        }
        item(key = "master-head") { SectionLabel(t(R.string.school_updates)) }
        item(key = "master") { Group { ToggleRow(t(R.string.notify_master), t(R.string.notify_master_body), on) { model.toggleSetting("enabled") } } }
        item(key = "grades-head") { SectionLabel(t(R.string.grades)) }
        item(key = "grades") {
            Group {
                ToggleRow(t(R.string.notify_grade_new), t(R.string.notify_grade_new_body), model.settings.gradeNew, on) { model.toggleSetting("gradeNew") }
                FineDivider()
                ToggleRow(t(R.string.notify_grade_changed), t(R.string.notify_grade_changed_body), model.settings.gradeChanged, on) { model.toggleSetting("gradeChanged") }
                FineDivider()
                ToggleRow(t(R.string.guess_the_grade), t(R.string.hide_new_marks_until_you_reveal_them_notificatio), model.settings.guessGrades) { model.toggleSetting("guessGrades") }
                FineDivider()
                ToggleRow(t(R.string.hold_to_reveal), t(R.string.with_guess_the_grade_a_long_press_opens_a_hidden), model.desk.revealLongPress) { model.updateDesk(model.desk.copy(revealLongPress = it)) }
            }
        }
        item(key = "exams-head") { SectionLabel(t(R.string.exams)) }
        item(key = "exams") {
            Group {
                ToggleRow(t(R.string.notify_exam_new), t(R.string.notify_exam_new_body), model.settings.examNew, on) { model.toggleSetting("examNew") }
                FineDivider()
                ToggleRow(t(R.string.notify_exam_moved), t(R.string.notify_exam_moved_body), model.settings.examMoved, on) { model.toggleSetting("examMoved") }
                FineDivider()
                ToggleRow(t(R.string.notify_exam_cancelled), t(R.string.notify_exam_cancelled_body), model.settings.examCancelled, on) { model.toggleSetting("examCancelled") }
                FineDivider()
                ToggleRow(t(R.string.notify_exam_room), t(R.string.notify_exam_room_body), model.settings.examRoom, on) { model.toggleSetting("examRoom") }
            }
        }
        item(key = "lessons-head") { SectionLabel(t(R.string.notify_section_lessons)) }
        item(key = "lessons") {
            Group {
                ToggleRow(t(R.string.notify_lesson_cancelled), t(R.string.notify_lesson_cancelled_body), model.settings.lessonCancelled, on) { model.toggleSetting("lessonCancelled") }
                FineDivider()
                ToggleRow(t(R.string.notify_lesson_changed), t(R.string.notify_lesson_changed_body), model.settings.lessonChanged, on) { model.toggleSetting("lessonChanged") }
            }
        }
        item(key = "appointments-head") { SectionLabel(t(R.string.notify_section_appointments)) }
        item(key = "appointments") {
            Group {
                ToggleRow(t(R.string.notify_appointment_new), t(R.string.notify_appointment_new_body), model.settings.appointmentNew, on) { model.toggleSetting("appointmentNew") }
                FineDivider()
                ToggleRow(t(R.string.notify_message_new), t(R.string.notify_message_new_body), model.settings.messageNew, on) { model.toggleSetting("messageNew") }
                FineDivider()
                ToggleRow(t(R.string.absences), checked = model.settings.absences, enabled = on) { model.toggleSetting("absences") }
                FineDivider()
                ToggleRow(t(R.string.excuse_deadlines), checked = model.settings.deadlines, enabled = on) { model.toggleSetting("deadlines") }
            }
        }
        item(key = "commute-head") { SectionLabel(t(R.string.commute_notify_section)) }
        item(key = "commute") {
            val commuteOn = model.settings.commute
            Group {
                ToggleRow(t(R.string.commute_notify_master), t(R.string.commute_notify_master_body), commuteOn) { model.toggleSetting("commute") }
                FineDivider()
                ToggleRow(t(R.string.commute_notify_delay), t(R.string.commute_notify_delay_body), model.settings.commuteDelay, commuteOn) { model.toggleSetting("commuteDelay") }
                FineDivider()
                ToggleRow(t(R.string.commute_notify_cancelled), t(R.string.commute_notify_cancelled_body), model.settings.commuteCancelled, commuteOn) { model.toggleSetting("commuteCancelled") }
                FineDivider()
                ToggleRow(t(R.string.commute_notify_lesson), t(R.string.commute_notify_lesson_body), model.settings.commuteLessonEnd, commuteOn) { model.toggleSetting("commuteLessonEnd") }
            }
        }
        item(key = "background-head") { SectionLabel(t(R.string.background_refresh)) }
        item(key = "background") {
            ChoiceRow(listOf(BackgroundMode.NORMAL.wire to t(R.string.background_normal), BackgroundMode.SAVER.wire to t(R.string.background_saver)), model.backgroundRefresh.wire,
                { model.chooseBackgroundRefresh(BackgroundMode.of(it)) }, Modifier.padding(bottom = 6.dp))
            Text(t(R.string.background_refresh_body), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 4.dp))
        }
        item(key = "delivery-head") { SectionLabel(t(R.string.delivery)) }
        item(key = "delivery") {
            val minutes = remember(model.backgroundRefresh) { model.graph.backgroundCheckMinutesNow() }
            val every = if (minutes >= 120 && minutes % 60 == 0L) t(R.string.interval_hours, (minutes / 60).toInt()) else t(R.string.interval_minutes, minutes.toInt())
            StatusLine(
                if (model.graph.pushReadyNow()) t(R.string.delivery_push_ready, every) else t(R.string.delivery_no_push, every),
                StateTone.Neutral,
                Modifier.padding(bottom = 12.dp),
            )
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton(t(R.string.send_a_test_notification), { model.testPush(context) }, Modifier.fillMaxWidth())
                SecondaryButton(t(R.string.send_delivery_probe), { model.probeDelivery(context) }, Modifier.fillMaxWidth())
            }
            Text(t(R.string.delivery_probe_help), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, bottom = 4.dp))
        }
        val probeLines = probeTick.let { CompanionAlerts.probeSummaries(context) }
        if (probeLines.isNotEmpty()) {
            item(key = "times-head") { SectionLabel(t(R.string.delivery_times)) }
            item(key = "times") {
                Group {
                    Column(Modifier.fillMaxWidth().padding(16.dp)) {
                        probeLines.forEach { line ->
                            Text(line, style = TimeSmallStyle, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 6.dp))
                        }
                    }
                }
            }
        }
    }
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
private fun DiagnosticLine(label: String, value: String, last: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.End, modifier = Modifier.padding(start = 12.dp).weight(1f))
    }
    if (!last) FineDivider()
}

/** Kanti+ im Browser: enter the browser's code, choose what it may show, see and remove browsers. */
@Composable
private fun WebAccessSettings(model: CompanionModel) {
    var code by remember { mutableStateOf("") }
    LaunchedEffect(model.connections, model.demo) { model.loadWebBrowsers() }
    ScreenList {
        item(key = "intro") {
            Group(Modifier.padding(top = 4.dp)) {
                Column(Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        IconTile(Icons.Outlined.Laptop, StateTone.Accent, 44.dp)
                        Text(t(R.string.web_access), style = MaterialTheme.typography.titleLarge)
                    }
                    Text(t(R.string.web_access_body, WEB_APP_HOST), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 14.dp))
                    when {
                        model.demo -> Box(Modifier.padding(top = 14.dp)) { InfoBanner(t(R.string.demo_active_title), t(R.string.web_access_demo), tone = StateTone.Warning) }
                        !model.webAccessAvailable -> Box(Modifier.padding(top = 14.dp)) { InfoBanner(t(R.string.web_access), t(R.string.web_access_needs_connection), tone = StateTone.Neutral) }
                        else -> {
                            OutlinedTextField(
                                code,
                                { next -> code = next.uppercase().filter { it.isLetterOrDigit() || it == '-' || it == ' ' }.take(11) },
                                Modifier.fillMaxWidth().padding(top = 14.dp),
                                label = { Text(t(R.string.web_pair_code)) },
                                placeholder = { Text(t(R.string.web_pair_code_hint)) },
                                singleLine = true,
                                shape = MaterialTheme.shapes.small,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii, capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Characters),
                            )
                            PrimaryButton(t(R.string.web_pair_continue), { model.lookupWebPair(code) }, Modifier.fillMaxWidth().padding(top = 12.dp), enabled = !model.busy && normalizePairCode(code) != null)
                            TextButton(onClick = { model.startWebOffer() }, enabled = !model.busy, modifier = Modifier.fillMaxWidth().padding(top = 4.dp)) { Text(t(R.string.web_offer_show)) }
                            if (model.webPairWorking) WebPairProgress()
                        }
                    }
                }
            }
        }
        if (model.webAccessAvailable) {
            item(key = "browsers-head") { SectionLabel(t(R.string.web_browsers)) }
            item(key = "browsers") {
                Group {
                    model.connections.connections.forEachIndexed { index, connection ->
                        if (index > 0) FineDivider()
                        val browsers = model.webBrowsers[connection.id].orEmpty()
                        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 12.dp, bottom = 8.dp)) {
                            Text(connection.label, style = MaterialTheme.typography.titleMedium)
                            if (browsers.isEmpty()) Text(t(R.string.web_browsers_none), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp, bottom = 4.dp))
                            browsers.forEach { browser ->
                                Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(1f)) {
                                        Text(browser.browser.ifBlank { t(R.string.web_browser_unnamed) }, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        Text(t(R.string.web_browser_seen, updatedLabel(browser.lastSeenAt.ifBlank { browser.createdAt })), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    TextButton(onClick = { model.revokeWebBrowser(connection.id, browser.id) }, enabled = !model.busy) { Text(t(R.string.web_browser_remove), color = MaterialTheme.colorScheme.error) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    model.webPairPrompt?.let { prompt ->
        WebPairChooser(
            model,
            title = t(R.string.web_pair_title),
            intro = t(R.string.web_pair_browser, prompt.info.browser.ifBlank { t(R.string.web_browser_unnamed) }),
            warning = true,
            confirm = t(R.string.web_pair_approve),
            key = prompt,
            onConfirm = { ids -> model.approveWebPair(ids) },
            onDismiss = { model.dismissWebPair() },
        )
    }
    if (model.webOfferChoosing) {
        WebPairChooser(
            model,
            title = t(R.string.web_offer_title),
            intro = t(R.string.web_offer_intro),
            warning = false,
            confirm = t(R.string.web_offer_create),
            key = "offer",
            onConfirm = { ids -> model.offerWebPair(ids) },
            onDismiss = { model.dismissWebOfferChooser() },
        )
    }
    model.webPairOffer?.let { offer -> WebOfferDialog(model, offer) }
}

/** "Verbinde mit dem Kanti+-Server…" while a pairing request runs (it runs off the main thread). */
@Composable
private fun WebPairProgress() {
    Row(Modifier.fillMaxWidth().padding(top = 12.dp).semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        Text(t(R.string.web_pair_working), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** The connection chooser shared by both pairing directions. */
@Composable
private fun WebPairChooser(model: CompanionModel, title: String, intro: String, warning: Boolean, confirm: String, key: Any, onConfirm: (List<String>) -> Unit, onDismiss: () -> Unit) {
    var chosen by remember(key) { mutableStateOf(setOfNotNull(model.connections.active?.id)) }
    val tamChosen = model.connections.connections.any { it.id in chosen && it.provider == SchoolProvider.TAM }
    AlertDialog(
        onDismissRequest = onDismiss,
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text(title, style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState())) {
                Text(intro, style = MaterialTheme.typography.bodyLarge)
                if (warning) Box(Modifier.padding(top = 12.dp)) { InfoBanner(t(R.string.web_pair_warning), "", tone = StateTone.Warning) }
                Text(t(R.string.web_pair_choose), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 14.dp, bottom = 4.dp))
                model.connections.connections.forEach { connection ->
                    val on = connection.id in chosen
                    Row(
                        Modifier.fillMaxWidth().selectable(selected = on, role = Role.Checkbox) { chosen = if (on) chosen - connection.id else chosen + connection.id }.padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked = on, onCheckedChange = null)
                        Column(Modifier.padding(start = 8.dp)) {
                            Text(connection.label, style = MaterialTheme.typography.bodyLarge)
                            Text(if (connection.provider == SchoolProvider.TAM) t(R.string.connection_provider_tam) else t(R.string.connection_provider_schulnetz), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                if (tamChosen) Text(t(R.string.web_pair_tam_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 10.dp))
                if (model.webPairWorking) WebPairProgress()
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(model.connections.connections.map { it.id }.filter { it in chosen }) }, enabled = chosen.isNotEmpty() && !model.busy) { Text(confirm) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(t(R.string.cancel)) } },
    )
}

/** The code the app offers, big, with a countdown and a new-code button after expiry. */
@Composable
private fun WebOfferDialog(model: CompanionModel, offer: ch.fasrv.fanotes.schulnetz.WebPairOffer) {
    var left by remember(offer) { mutableStateOf(pairSecondsLeft(offer.expiresAt)) }
    LaunchedEffect(offer) {
        while (left > 0) {
            kotlinx.coroutines.delay(1000)
            left = pairSecondsLeft(offer.expiresAt)
        }
    }
    AlertDialog(
        onDismissRequest = { model.dismissWebOffer() },
        shape = MaterialTheme.shapes.extraLarge,
        title = { Text(t(R.string.web_offer_title), style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                Text(
                    displayPairCode(offer.code),
                    style = MaterialTheme.typography.displaySmall.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, letterSpacing = 2.sp),
                    color = if (left > 0) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 12.dp),
                )
                Text(t(R.string.web_offer_enter, WEB_APP_HOST), style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
                Text(
                    if (left > 0) t(R.string.web_offer_left, "%d:%02d".format(left / 60, left % 60)) else t(R.string.web_offer_expired),
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (left > 0) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
        },
        confirmButton = {
            if (left > 0) TextButton(onClick = { model.dismissWebOffer() }) { Text(t(R.string.web_offer_close)) }
            else TextButton(onClick = { model.dismissWebOffer(); model.startWebOffer() }) { Text(t(R.string.web_offer_new)) }
        },
        dismissButton = if (left > 0) null else ({ TextButton(onClick = { model.dismissWebOffer() }) { Text(t(R.string.web_offer_close)) } }),
    )
}
