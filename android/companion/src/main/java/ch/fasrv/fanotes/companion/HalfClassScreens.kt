package ch.fasrv.fanotes.companion

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.schulnetz.chosenLabels
import ch.fasrv.fanotes.schulnetz.detectGroupSets

/**
 * One row group per detected half-class set: a chip per course plus "show all". The choice is stored in
 * [ch.fasrv.fanotes.schulnetz.DeskPrefs.groupChoices] through the normal desk update, which also refreshes the widget.
 */
@Composable
fun HalfClassChoices(model: CompanionModel, compact: Boolean = false) {
    val sets = remember(model.snapshot.events) { detectGroupSets(model.snapshot.events) }
    if (sets.isEmpty()) {
        if (!compact) Text(t(R.string.half_class_none), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 16.dp))
        return
    }
    Column {
        if (compact) {
            Text(t(R.string.half_class_onboarding_title), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = Space.lg))
            Text(t(R.string.half_class_onboarding_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp, bottom = 8.dp))
        }
        sets.forEach { set ->
            val chosen = chosenLabels(set, model.desk.groupChoices)
            val selected = set.options.firstOrNull { it.label.trim().lowercase() in chosen }?.label ?: ""
            Group(Modifier.padding(top = if (compact) 8.dp else 12.dp)) {
                Column(Modifier.padding(16.dp)) {
                    Text(set.options.joinToString(" / ") { it.label }, style = MaterialTheme.typography.bodyLarge)
                    ChoiceRow(
                        set.options.map { it.label to it.label } + ("" to t(R.string.half_class_all)),
                        selected,
                        { pick ->
                            val next = if (pick.isEmpty()) model.desk.groupChoices - set.key else model.desk.groupChoices + (set.key to listOf(pick))
                            model.updateDesk(model.desk.copy(groupChoices = next))
                        },
                        Modifier.padding(top = 8.dp),
                    )
                    set.options.forEach { option ->
                        val detail = listOf(option.title.takeIf { it != option.label }, option.teacher.takeIf { it.isNotBlank() }).filterNotNull().joinToString(" · ")
                        Text(
                            listOf(option.label, detail.takeIf { it.isNotBlank() }, tp(R.plurals.half_class_per_week, option.lessonsPerWeek, option.lessonsPerWeek)).filterNotNull().joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp),
                        )
                    }
                }
            }
        }
    }
}
