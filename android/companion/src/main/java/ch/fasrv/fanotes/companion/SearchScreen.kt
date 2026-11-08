package ch.fasrv.fanotes.companion

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.desk.HomeworkTask
import ch.fasrv.fanotes.schulnetz.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import java.time.LocalDate

@Composable
fun CompanionSearchScreen(model: CompanionModel) {
    var query by rememberSaveable { mutableStateOf("") }
    var scope by rememberSaveable { mutableStateOf("all") }
    var notes by remember { mutableStateOf<List<NoteResult>>(emptyList()) }
    var docs by remember { mutableStateOf<List<DocHit>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<AgendaEntry?>(null) }
    var task by remember { mutableStateOf<HomeworkTask?>(null) }
    LaunchedEffect(model.notesAccount) { if (!model.notesAccount && scope == "notes") scope = "all" }
    LaunchedEffect(query, model.tree, model.notesAccount) {
        if (!model.notesAccount || query.trim().length < 2) { notes = emptyList(); docs = emptyList(); loading = false; return@LaunchedEffect }
        loading = true; failed = false
        delay(250)
        try {
            docs = model.searchDocuments(query.trim())
            // Until the index has read everything once, the plain note scan fills the gap.
            notes = if (model.docStatus.ready) emptyList() else model.findNotes(query.trim()).filter { result -> docs.none { it.path == result.node.path } }
        } catch (error: Exception) { if (error is CancellationException) throw error; failed = true }
        loading = false
    }
    val needle = query.trim()
    val tasks = remember(needle, model.tasks) { if (needle.length < 2) emptyList() else model.tasks.filter { "${it.title} ${it.subject} ${it.notes}".contains(needle, true) } }
    val events = remember(needle, model.snapshot.events, model.snapshot.exams) { if (needle.length < 2) emptyList() else (model.snapshot.events + model.snapshot.exams).distinctBy(::lessonTargetId).filter { "${it.label} ${it.comment}".contains(needle, true) } }
    val messages = remember(needle, model.snapshot.messages) { if (needle.length < 2) emptyList() else model.snapshot.messages.filter { "${it.title} ${it.body}".contains(needle, true) } }
    val courses = remember(needle, model.snapshot.grades, model.gradeBook, model.desk.courseAliases, model.unrevealedIds, model.settings.guessGrades) { if (needle.length < 2) emptyList() else activeCourses(courseSummaries(model.snapshot.grades, hiddenTargetIds = model.hiddenGradeIds(), book = model.gradeBook)).filter { courseAlias(it.label, model.desk.courseAliases).contains(needle, true) } }
    val local = remember(needle, model.calendar.events) { if (needle.length < 2) emptyList() else model.calendar.events.filter { "${it.title} ${it.location} ${it.notes}".contains(needle, true) } }
    val recentNotes = remember(model.tree) { flattenNotes(model.tree).sortedByDescending { it.modifiedAt }.take(3) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { if (query.isEmpty()) runCatching { focus.requestFocus() } }
    Column {
        SearchField(query, { query = it }, if (model.notesAccount) t(R.string.notes_tasks_subjects_events) else t(R.string.tasks_subjects_events), Modifier.padding(horizontal = Space.page, vertical = 6.dp).focusRequester(focus))
        ChoiceRow(listOf("all" to t(R.string.all), "tasks" to t(R.string.tasks), "school" to t(R.string.school)) + if (model.notesAccount) listOf("notes" to t(R.string.documents)) else emptyList(), scope, { scope = it }, Modifier.padding(horizontal = Space.page))
        if (model.notesAccount) DocIndexStatusLine(model.docStatus, Modifier.padding(horizontal = Space.page, vertical = 4.dp))
        ScreenList {
            if (needle.length < 2) {
                item(key = "hint") {
                    if (model.notesAccount) EmptyState(Icons.Outlined.Search, t(R.string.find_your_next_thought), t(R.string.search_note_text_existing_handwriting_transcript))
                    else EmptyState(Icons.Outlined.Search, t(R.string.find_a_class_task_or_grade), t(R.string.search_tasks_subjects_events_and_school_records))
                }
                if (model.notesAccount && recentNotes.isNotEmpty()) {
                    item(key = "recent-head") { SectionLabel(t(R.string.jump_back_in)) }
                    itemsIndexed(recentNotes, key = { _, it -> it.path }) { index, note -> GroupItem(index, recentNotes.size) { NoteRow(model, note) { model.openNote(note.path) } } }
                }
            } else {
                if (loading) item(key = "loading") { LinearProgressIndicator(Modifier.fillMaxWidth().padding(vertical = 12.dp), trackColor = LocalCompanionSemantics.current.sunken) }
                if (model.notesAccount && failed) item(key = "failed") { InfoBanner(t(R.string.note_search_needs_attention), t(R.string.some_notes_could_not_be_read_your_files_have_bee), error = true) }
                if (model.notesAccount && scope in listOf("all", "notes") && docs.isNotEmpty()) {
                    item(key = "docs-head") { SectionLabel(t(R.string.documents), count = docs.size) }
                    itemsIndexed(docs, key = { _, it -> "search-doc:${it.path}:${it.page}:${it.label}" }) { index, hit ->
                        GroupItem(index, docs.size) { DocHitRow(hit) { model.openNote(hit.path, DocTarget(hit.page, hit.label, query.trim())) } }
                    }
                }
                if (model.notesAccount && scope in listOf("all", "notes") && notes.isNotEmpty()) {
                    item(key = "notes-head") { SectionLabel(t(R.string.notes_2, notes.size, if (notes.size == 200) "+" else "")) }
                    itemsIndexed(notes, key = { _, it -> "search-note:${it.node.path}" }) { index, result -> GroupItem(index, notes.size) { NoteRow(model, result.node) { model.openNote(result.node.path) } } }
                }
                if (scope in listOf("all", "tasks") && tasks.isNotEmpty()) {
                    item(key = "tasks-head") { SectionLabel(t(R.string.tasks), count = tasks.size) }
                    itemsIndexed(tasks, key = { _, it -> "search-task:${it.id}" }) { index, item -> GroupItem(index, tasks.size) { TaskRow(item, LocalDate.now(), { model.toggleTask(item) }, colors = model.colors) { task = item } } }
                }
                if (scope == "all" && local.isNotEmpty()) {
                    item(key = "calendar-head") { SectionLabel(t(R.string.calendar), count = local.size) }
                    itemsIndexed(local, key = { _, it -> "search-local:${it.id}" }) { index, event ->
                        val entry = AgendaEntry("local:${event.id}", event.title, AgendaKind.Event, parseDisplayDate(event.start) ?: LocalDate.now(), detail = dueLabel(event.start), local = event)
                        AgendaRow(model, entry, railPosition(index, local.size), showDay = true) { selected = entry }
                    }
                }
                if (scope in listOf("all", "school")) {
                    if (courses.isNotEmpty()) item(key = "courses-head") { SectionLabel(t(R.string.subjects), count = courses.size) }
                    itemsIndexed(courses, key = { _, it -> "search-course:${it.courseId}" }) { index, course -> GroupItem(index, courses.size) { SettingRow(Icons.Outlined.Insights, courseAlias(course.label, model.desk.courseAliases), tp(R.plurals.marks_count, course.marks.size, course.marks.size)) { model.focusCourseId = course.courseId; model.navigate(Page.Course) } } }
                    if (events.isNotEmpty()) item(key = "events-head") { SectionLabel(t(R.string.school_schedule), count = events.size) }
                    itemsIndexed(events, key = { _, it -> "search-event:${lessonTargetId(it)}" }) { index, event ->
                        val entry = AgendaEntry("school:${lessonTargetId(event)}", preferredEventTitle(event), if (event.isExamLike()) AgendaKind.Exam else if (event.isLesson()) AgendaKind.Lesson else AgendaKind.Event, parseDisplayDate(event.start) ?: LocalDate.now(), eventClock(event), detail = dueLabel(event.start), school = event)
                        AgendaRow(model, entry, railPosition(index, events.size), showDay = true) { selected = entry }
                    }
                    if (messages.isNotEmpty()) item(key = "messages-head") { SectionLabel(t(R.string.school_messages), count = messages.size) }
                    itemsIndexed(messages, key = { _, it -> "search-message:${messageTargetId(it)}" }) { index, message -> GroupItem(index, messages.size) { SettingRow(Icons.Outlined.Forum, shownText(messageHeadline(message.title, message.body)).ifBlank { t(R.string.school_message) }, plainPreview(message.body).take(100)) { model.highlightIds = setOf(messageTargetId(message)); model.navigate(Page.Updates) } } }
                }
                val empty = when (scope) {
                    "notes" -> !model.notesAccount || (notes.isEmpty() && docs.isEmpty())
                    "tasks" -> tasks.isEmpty()
                    "school" -> events.isEmpty() && messages.isEmpty() && courses.isEmpty()
                    else -> (!model.notesAccount || (notes.isEmpty() && docs.isEmpty())) && tasks.isEmpty() && events.isEmpty() && messages.isEmpty() && courses.isEmpty() && local.isEmpty()
                }
                if (!loading && empty) item(key = "empty") { EmptyState(Icons.Outlined.SearchOff, t(R.string.nothing_matches, needle), if (model.notesAccount) t(R.string.try_fewer_words_a_subject_or_a_note_title) else t(R.string.try_fewer_words_a_subject_or_a_task)) }
            }
        }
    }
    selected?.let { AgendaDetails(model, it) { selected = null } }
    task?.let { TaskForm(model, it) { task = null } }
}
