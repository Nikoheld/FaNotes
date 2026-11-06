# Quiet week imports and exam move notifications

## Root cause

PR #1011 exposed additional future weeks, but the notification differ used the timetable's `weekFetched` map as proof that exams in those weeks were already known. Exam and lesson coverage are not equivalent. Both Android and server also tried to adopt any old lesson with the same subject/day as a newly discovered exam. A clock or room difference then became `Prüfung verschoben`. This could pair different events when the calendar UID and scheduler id differed. Raw start-string differences and room-only changes were also classified as exam moves; end-only changes were missed.

## Baselines and authority

Exam reads now carry an independent `examWeekFetched` map. Scheduler exam responses and valid calendar coverage stamp their own weeks; lesson coverage alone does not. Explicit scheduler exam weeks take priority over overlapping calendar imports. Invalid/blocked reads do not establish authority, and empty/incomplete exam results cannot replace a complete known baseline.

Notification history is stored per week in private `school-agenda-baseline.json` on Android and per-account `notification-baseline.json` on the server. The baseline is written atomically **before** generating diffs or dispatching notifications. First coverage seeds a quiet baseline, including when the timetable week was already fetched. Repeated or older fetch stamps remain quiet without advancing exam state. Normal session refresh does not reset history. Server account operations preserve this file with the other private school state.

Comparison uses the last authoritative exam baseline, not a display cache or an unrelated lesson. A unique known exam matches by stable id/calendar UID local part, or an unambiguous unchanged exam slot. Calendar/scheduler aliases are coalesced. Changes of complete, normalized start/end times produce `Prüfung verschoben`; room-only changes produce `Raum geändert`. New exams in an established empty exam week still produce `Neue Prüfung`. Empty and partial reads retain the last complete state for a later authoritative comparison. Ambiguous conflicting aliases are treated as partial data.

This migration deliberately initializes unknown notification weeks quietly. Missing authority from older clients cannot be treated as proof of a change. No user reset or login/logout is needed.

## Event dates and privacy

Notification bodies begin with the affected event's own date in `DD.MM.YYYY`, including moved exams and cancelled lessons. Offset timestamps use Europe/Zurich for the date. Each event gets its own date; the fetch/notification timestamp is never a substitute. Notification routing understands the date prefix and retains hidden-lesson filtering.

Only generated synthetic course/event data is used in regression tests. No screenshot, raw HTML export, real account data, student name or private URL is included. No new diagnostic content or Schulnetz write operation is introduced.

## Verification

`AgendaBaselineTest` and the server suite cover quiet new weeks, restart persistence, overlapping calendar/scheduler aliases, a subsequent single real move, missing/stale/empty/partial reads, retained new-exam behavior, end-only changes, room changes, and event-specific dates. The server integration test checks the durable baseline inside the mock push callback and verifies a repeated upload does not send a second notification.

Run `:core:test :companion:testDebugUnitTest :companion:assembleDebug` from `android`, plus the existing three Node test suites. Release testing is left to the standard GitHub Alpha workflow; no host emulator run is needed for this change.
