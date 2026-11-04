package ch.fasrv.fanotes.companion

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.items
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
    var loading by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<AgendaEntry?>(null) }
    var task by remember { mutableStateOf<HomeworkTask?>(null) }
    LaunchedEffect(model.notesAccount) { if (!model.notesAccount && scope == "notes") scope = "all" }
    LaunchedEffect(query, model.tree, model.notesAccount) {
        if (!model.notesAccount || query.trim().length < 2) { notes = emptyList(); loading = false; return@LaunchedEffect }
        loading = true; failed = false
        delay(250)
        try { notes = model.findNotes(query.trim()) } catch (error: Exception) { if (error is CancellationException) throw error; failed = true }
        loading = false
    }
    val needle = query.trim()
    val tasks = remember(needle, model.tasks) { if (needle.length < 2) emptyList() else model.tasks.filter { "${it.title} ${it.subject} ${it.notes}".contains(needle, true) } }
    val events = remember(needle, model.snapshot.events, model.snapshot.exams) { if (needle.length < 2) emptyList() else (model.snapshot.events + model.snapshot.exams).distinctBy(::lessonTargetId).filter { "${it.label} ${it.comment}".contains(needle, true) } }
    val messages = remember(needle, model.snapshot.messages) { if (needle.length < 2) emptyList() else model.snapshot.messages.filter { "${it.title} ${it.body}".contains(needle, true) } }
    val courses = remember(needle, model.snapshot.grades, model.gradeBook, model.desk.courseAliases, model.unrevealedIds, model.settings.guessGrades) { if (needle.length < 2) emptyList() else activeCourses(courseSummaries(model.snapshot.grades, hiddenTargetIds = model.hiddenGradeIds(), book = model.gradeBook)).filter { courseAlias(it.label, model.desk.courseAliases).contains(needle, true) } }
    val local = remember(needle, model.calendar.events) { if (needle.length < 2) emptyList() else model.calendar.events.filter { "${it.title} ${it.location} ${it.notes}".contains(needle, true) } }
    val recentNotes = remember(model.tree) { flattenNotes(model.tree).sortedByDescending { it.modifiedAt }.take(3) }
    Column {
        SearchField(query, { query = it }, if (model.notesAccount) "Notes, tasks, subjects, events…" else "Tasks, subjects, events…", Modifier.padding(horizontal = Space.page, vertical = 8.dp))
        ChoiceRow(listOf("all" to "All", "tasks" to "Tasks", "school" to "School") + if (model.notesAccount) listOf("notes" to "Notes") else emptyList(), scope, { scope = it }, Modifier.padding(horizontal = Space.page))
        ScreenList {
            if (needle.length < 2) {
                item {
                    if (model.notesAccount) EmptyState(Icons.Outlined.Search, "Find your next thought", "Search note text, existing handwriting transcripts, assignments, events and school records. Enter at least two characters.")
                    else EmptyState(Icons.Outlined.Search, "Find a class, task or grade", "Search tasks, subjects, events and school records. Enter at least two characters.")
                }
                if (model.notesAccount) {
                    item { SectionLabel("Jump back in") }
                    items(recentNotes, key = { it.path }) { note -> NoteRow(model, note) { model.openNote(note.path) } }
                }
            } else {
                if (loading) item { LinearProgressIndicator(Modifier.fillMaxWidth().padding(vertical = 12.dp)) }
                if (model.notesAccount && failed) item { InfoBanner("Note search needs attention", "Some notes could not be read. Your files have been kept unchanged.") }
                if (model.notesAccount && scope in listOf("all", "notes") && notes.isNotEmpty()) {
                    item { SectionLabel("Notes · ${notes.size}${if (notes.size == 200) "+" else ""}") }
                    items(notes, key = { "search-note:${it.node.path}" }) { result -> NoteRow(model, result.node) { model.openNote(result.node.path) } }
                }
                if (scope in listOf("all", "tasks") && tasks.isNotEmpty()) {
                    item { SectionLabel("Tasks · ${tasks.size}") }
                    items(tasks, key = { "search-task:${it.id}" }) { item -> TaskRow(item, LocalDate.now(), { model.toggleTask(item) }) { task = item } }
                }
                if (scope == "all" && local.isNotEmpty()) {
                    item { SectionLabel("Calendar") }
                    items(local, key = { "search-local:${it.id}" }) { event ->
                        val entry = AgendaEntry("local:${event.id}", event.title, AgendaKind.Event, parseDisplayDate(event.start) ?: LocalDate.now(), detail = dueLabel(event.start), local = event)
                        AgendaRow(model, entry) { selected = entry }
                    }
                }
                if (scope in listOf("all", "school")) {
                    if (courses.isNotEmpty()) item { SectionLabel("Subjects") }
                    items(courses, key = { "search-course:${it.courseId}" }) { course -> SettingRow(Icons.Outlined.Insights, courseAlias(course.label, model.desk.courseAliases), "${course.marks.size} marks") { model.focusCourseId = course.courseId; model.navigate(Page.Course) } }
                    if (events.isNotEmpty()) item { SectionLabel("School schedule") }
                    items(events, key = { "search-event:${lessonTargetId(it)}" }) { event ->
                        val entry = AgendaEntry("school:${lessonTargetId(event)}", event.label, if (event.isExamLike()) AgendaKind.Exam else if (event.isLesson()) AgendaKind.Lesson else AgendaKind.Event, parseDisplayDate(event.start) ?: LocalDate.now(), eventClock(event), detail = dueLabel(event.start), school = event)
                        AgendaRow(model, entry) { selected = entry }
                    }
                    if (messages.isNotEmpty()) item { SectionLabel("School messages") }
                    items(messages, key = { "search-message:${messageTargetId(it)}" }) { message -> SettingRow(Icons.Outlined.Forum, message.title.ifBlank { "School message" }, plainPreview(message.body).take(100)) { model.highlightIds = setOf(messageTargetId(message)); model.navigate(Page.Updates) } }
                }
                val empty = when (scope) {
                    "notes" -> !model.notesAccount || notes.isEmpty()
                    "tasks" -> tasks.isEmpty()
                    "school" -> events.isEmpty() && messages.isEmpty() && courses.isEmpty()
                    else -> (!model.notesAccount || notes.isEmpty()) && tasks.isEmpty() && events.isEmpty() && messages.isEmpty() && courses.isEmpty() && local.isEmpty()
                }
                if (!loading && empty) item { EmptyState(Icons.Outlined.SearchOff, "Nothing matches “$needle”", if (model.notesAccount) "Try fewer words, a subject, or a note title." else "Try fewer words, a subject, or a task.") }
            }
        }
    }
    selected?.let { AgendaDetails(model, it) { selected = null } }
    task?.let { TaskForm(model, it) { task = null } }
}
