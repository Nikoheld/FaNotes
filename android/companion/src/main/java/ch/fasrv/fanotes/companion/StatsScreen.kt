package ch.fasrv.fanotes.companion

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.schulnetz.*
import java.time.Instant
import java.time.LocalDate
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/*
 * The Statistik screen: numbers computed on the phone from the snapshot it already holds (schoolStats).
 * Nothing is read from Schulnetz and nothing is sent. No mark appears here, so guess-the-grade stays intact.
 */

private fun day(iso: String, pattern: String = "d.M."): String =
    runCatching { formatSchoolDate(LocalDate.parse(iso), pattern) }.getOrDefault(iso)

private fun decimal(value: Double): String =
    localizedNumber(if (value == Math.floor(value)) value.toInt().toString() else "%.1f".format(java.util.Locale.ROOT, value))

private fun percent(part: Int, whole: Int): Int = if (whole == 0) 0 else Math.round(part * 100f / whole)

/** A horizontal bar: [fraction] of the width is filled. */
@Composable
private fun RateBar(fraction: Float, color: Color, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(6.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceVariant)) {
        Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).fillMaxHeight().background(color, CircleShape))
    }
}

@Composable
private fun StatRow(title: String, subtitle: String = "", trailing: String = "", bar: Float? = null, barColor: Color = MaterialTheme.colorScheme.primary) {
    Column(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 16.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (subtitle.isNotBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
            if (trailing.isNotBlank()) Text(trailing, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 12.dp), maxLines = 1)
        }
        if (bar != null) RateBar(bar, barColor, Modifier.padding(top = 8.dp))
    }
}

@Composable
private fun StatList(rows: List<@Composable () -> Unit>) {
    Group { rows.forEachIndexed { index, row -> row(); if (index < rows.size - 1) FineDivider(16.dp) } }
}

@Composable
private fun EmptyLine(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 8.dp))
}

private fun LazyListScope.section(key: String, title: String, content: @Composable () -> Unit) {
    item(key = "$key-head") { SectionLabel(title) }
    item(key = key) { content() }
}

@Composable
fun StatsScreen(model: CompanionModel) {
    val snapshot = model.snapshot
    val stats by produceState<SchoolStats?>(null, snapshot) {
        // A snapshot can hold many weeks of lessons: compute off the main thread.
        value = withContext(Dispatchers.Default) { schoolStats(snapshot, Instant.now()) }
    }
    val result = stats
    ScreenList {
        item(key = "intro") { PageIntro(t(R.string.stats_title), t(R.string.stats_subtitle)) }
        if (result == null) {
            item(key = "loading") { LoadingState() }
            return@ScreenList
        }
        item(key = "coverage") {
            val coverage = result.cancellations.coverage
            Text(
                if (coverage.weeks == 0) t(R.string.stats_coverage_none)
                else tp(R.plurals.stats_coverage, coverage.weeks, coverage.weeks, day(coverage.firstDay, "dd.MM."), day(coverage.lastDay, "dd.MM.")),
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(t(R.string.stats_note), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
        }
        section("cancellations", t(R.string.stats_cancellations)) { CancellationSection(result.cancellations) }
        section("grading", t(R.string.stats_grading)) { GradingSection(result.grading) }
        section("waiting", t(R.string.stats_waiting)) { WaitingSection(result.waiting) }
        section("changed", t(R.string.stats_changed)) { ChangedSection(result.gradeChanges) }
        section("exams", t(R.string.stats_exam_load)) { ExamLoadSection(result.examLoad) }
        section("absences", t(R.string.absences)) { AbsenceSection(result.absences) }
    }
}

@Composable
private fun CancellationSection(stats: CancellationStats) {
    val totals = stats.totals
    if (totals.total == 0) { EmptyLine(t(R.string.stats_cancelled_none)); return }
    val danger = MaterialTheme.colorScheme.error
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Group {
            StatRow(
                t(R.string.stats_cancelled_summary, totals.cancelled, totals.total, percent(totals.cancelled, totals.total)),
                t(R.string.stats_cancelled_extra, totals.substituted, totals.moved, totals.changed),
                bar = totals.rate.toFloat(), barColor = danger,
            )
        }
        StatList(stats.courses.map { course ->
            {
                StatRow(
                    course.title.ifBlank { course.key },
                    listOf(course.teacher, t(R.string.stats_course_counts, course.counts.cancelled, course.counts.total),
                        if (course.counts.substituted > 0) t(R.string.stats_course_substituted, course.counts.substituted) else "").filter { it.isNotBlank() }.joinToString(" · "),
                    "${percent(course.counts.cancelled, course.counts.total)}%", course.counts.rate.toFloat(), danger,
                )
            }
        })
        Text(t(R.string.stats_by_weekday), style = MaterialTheme.typography.titleSmall)
        StatList(stats.weekdays.map { weekday ->
            {
                StatRow(
                    formatSchoolDate(LocalDate.of(2024, 1, 1).plusDays(weekday.weekday - 1L), "EEEE"),
                    trailing = "${weekday.cancelled}/${weekday.total}",
                    bar = if (weekday.total == 0) 0f else weekday.cancelled.toFloat() / weekday.total, barColor = danger,
                )
            }
        })
        if (stats.clocks.isNotEmpty()) {
            Text(t(R.string.stats_by_time), style = MaterialTheme.typography.titleSmall)
            StatList(stats.clocks.map { slot ->
                {
                    StatRow(
                        slot.clock, trailing = "${slot.cancelled}/${slot.total}",
                        bar = if (slot.total == 0) 0f else slot.cancelled.toFloat() / slot.total, barColor = danger,
                    )
                }
            })
        }
        if (stats.recent.isNotEmpty()) {
            Text(t(R.string.stats_latest_cancelled), style = MaterialTheme.typography.titleSmall)
            StatList(stats.recent.map { item -> { StatRow(item.title, trailing = listOf(day(item.day, "EEE d.M."), item.clock).filter { it.isNotBlank() }.joinToString(" ")) } })
        }
    }
}

@Composable
private fun GradingSection(stats: GradingStats) {
    val median = stats.median
    val mean = stats.mean
    if (median == null || mean == null) { EmptyLine(t(R.string.stats_grading_none)); return }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Group {
            Column(Modifier.fillMaxWidth().padding(16.dp)) {
                Text(tp(R.plurals.stats_median_days, if (median == Math.floor(median)) median.toInt() else 2, decimal(median)), style = MaterialTheme.typography.headlineSmall)
                Text(t(R.string.stats_grading_overall, decimal(mean), stats.count), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        StatList(stats.courses.map { course ->
            {
                StatRow(
                    course.title.ifBlank { course.key },
                    listOf(course.teacher, t(R.string.stats_course_delay, decimal(course.median), decimal(course.mean), course.fastest, course.slowest, course.count)).filter { it.isNotBlank() }.joinToString("\n"),
                    "${decimal(course.median)}",
                )
            }
        })
        if (stats.recent.isNotEmpty()) {
            Text(t(R.string.stats_latest_graded), style = MaterialTheme.typography.titleSmall)
            StatList(stats.recent.map { item ->
                { StatRow(item.title, listOf(item.course, t(R.string.stats_graded_row, day(item.testDay), item.delay)).filter { it.isNotBlank() }.joinToString("\n"), "${item.delay}") }
            })
        }
    }
}

@Composable
private fun WaitingSection(items: List<WaitingExam>) {
    if (items.isEmpty()) { EmptyLine(t(R.string.stats_waiting_none)); return }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(t(R.string.stats_waiting_help), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        StatList(items.map { item ->
            { StatRow(item.title, listOf(item.course, day(item.examDay, "EEE d.M.")).filter { it.isNotBlank() }.joinToString(" · "), tp(R.plurals.stats_waiting_days, item.daysWaiting, item.daysWaiting)) }
        })
    }
}

@Composable
private fun ChangedSection(stats: GradeChangeStats) {
    if (stats.count == 0) { EmptyLine(t(R.string.stats_changed_none)); return }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(t(R.string.stats_changed_help), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        StatList(stats.items.map { item ->
            { StatRow(item.title, listOf(item.course, t(R.string.stats_changed_row, day(item.firstSeenDay), item.versions)).filter { it.isNotBlank() }.joinToString("\n")) }
        })
    }
}

@Composable
private fun ExamLoadSection(load: ExamLoad) {
    if (load.weeks.isEmpty()) { EmptyLine(t(R.string.stats_exam_none)); return }
    val peak = load.weeks.maxOf { it.count }.coerceAtLeast(1)
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Group {
            StatRow(t(R.string.stats_exam_busiest, day(load.busiestMonday, "d.M."), load.busiestCount), tp(R.plurals.stats_exam_next, load.next28, load.next28))
        }
        StatList(load.weeks.map { week ->
            { StatRow(t(R.string.stats_exam_week, day(week.monday, "d.M.")), trailing = week.count.toString(), bar = week.count.toFloat() / peak, barColor = MaterialTheme.colorScheme.tertiary) }
        })
    }
}

@Composable
private fun AbsenceSection(items: List<AbsenceSubject>) {
    if (items.isEmpty()) { EmptyLine(t(R.string.stats_absence_none)); return }
    val peak = items.maxOf { it.count }.coerceAtLeast(1)
    StatList(items.map { item ->
        { StatRow(item.subject.ifBlank { t(R.string.stats_no_subject) }, t(R.string.stats_absence_row, item.count, item.excused), item.count.toString(), item.count.toFloat() / peak) }
    })
}
