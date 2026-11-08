package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate

/**
 * Diff fixtures are dated around early November 2026. Pin "today" so a lesson or exam in them is
 * not dropped as already over once the machine clock passes that week. Calls that pass a day keep it.
 */
val FIXTURE_DAY: LocalDate = LocalDate.parse("2026-11-01")

fun fixtureDiff(
    previous: SchulnetzSnapshot?,
    next: SchulnetzSnapshot,
    settings: NotifySettings = NotifySettings(),
    today: LocalDate = FIXTURE_DAY,
): List<SchulnetzChange> = diffSnapshots(previous, next, settings, today)
