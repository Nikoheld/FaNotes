package ch.fasrv.fanotes.companion

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.schulnetz.TeacherAbsenceDay
import java.time.LocalDate

/** The one line Heute shows: absent names, then the excursion names after a separator. */
fun teacherAbsenceLine(absences: TeacherAbsenceDay, excursionLabel: (String) -> String): String =
    listOfNotNull(
        absences.absent.takeIf { it.isNotEmpty() }?.joinToString(", "),
        absences.excursion.takeIf { it.isNotEmpty() }?.let { excursionLabel(it.joinToString(", ")) },
    ).joinToString("  ·  ")

/** Lines the collapsed card shows before "Alle anzeigen"; a busy day can list dozens of names. */
const val TEACHER_ABSENCE_COLLAPSED_LINES = 3

/**
 * Today card with the teachers the start page lists as absent or on an excursion. Shows nothing when the stored
 * read is not from [today]. A long list is cut to [TEACHER_ABSENCE_COLLAPSED_LINES] lines with "Alle anzeigen";
 * tapping the card shows every name.
 */
@Composable
fun TeacherAbsenceCard(absences: TeacherAbsenceDay?, today: LocalDate) {
    if (absences == null || absences.day != today.toString()) return
    val scheme = MaterialTheme.colorScheme
    val none = absences.absent.isEmpty() && absences.excursion.isEmpty()
    var expanded by rememberSaveable(absences.day) { mutableStateOf(false) }
    var overflowing by rememberSaveable(absences.day) { mutableStateOf(false) }
    val toggle = if (!none && (overflowing || expanded)) Modifier.clickable(role = Role.Button) { expanded = !expanded } else Modifier
    Group {
        Column(toggle.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(t(R.string.teacher_absences_row), style = MaterialTheme.typography.labelLarge, color = scheme.onSurfaceVariant)
            if (none) Text(t(R.string.teacher_absences_none), style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
            else {
                Text(
                    teacherAbsenceLine(absences) { t(R.string.teacher_absences_excursion_inline, it) },
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = if (expanded) Int.MAX_VALUE else TEACHER_ABSENCE_COLLAPSED_LINES,
                    overflow = TextOverflow.Ellipsis,
                    onTextLayout = { layout -> if (!expanded) overflowing = layout.hasVisualOverflow },
                )
                if (overflowing || expanded) {
                    val count = absences.absent.size + absences.excursion.size
                    Text(
                        if (expanded) t(R.string.teacher_absences_show_less) else t(R.string.teacher_absences_show_all, count),
                        style = MaterialTheme.typography.labelLarge,
                        color = scheme.primary,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        }
    }
}
