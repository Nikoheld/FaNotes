# Kanti+

A phone notebook and student planner built with Kotlin and Compose. The application
works on the device before account setup; connecting a FaNotes account enables encrypted sync
and the existing read-only Schulnetz integration. The launcher name is Kanti+. The
application id is `ch.fasrv.kantiplus`. The Kotlin namespace stays `ch.fasrv.fanotes.companion`.
Instant school updates use Firebase Cloud Messaging when `google-services.json` is present. A high-priority message is sent only for a grade or another change the user must see. Timetable-only refreshes are not pushed. Without Firebase, or if no push arrives for 12 hours, the app checks about every 6 hours while on the network and not on low battery.

## Product structure

- **Today:** the next relevant commitment, a bounded task list and recent notes.
- **Planner:** a shared schedule for lessons, exams, local events and task deadlines;
  a separate Tasks mode for overdue/today/upcoming/completed work and school imports.
- **Notes:** folder browsing, recent edits, full-library search, previews, contextual
  organization, recoverable deletion, and a full-screen Read/Text/Ink editor.
- **School:** grades and local scenarios, exams, absences, messages, holidays and
  available account statements. Official school records remain read-only.

Settings are divided into account/sync, appearance, planning/grades, notifications,
activity and diagnostics. School page/log sharing lives exclusively in diagnostics.

The [design system](docs/DESIGN_SYSTEM.md) describes the current visual language ("Stundentakt"),
tokens, themes including Snow, states, motion, onboarding and grade privacy. The earlier
[audit and specification](docs/REDESIGN.md) still records the placement decisions and compatibility
boundaries.

## Code map

| File | Responsibility |
| --- | --- |
| `CompanionPresentation.kt` | Routes, legacy push/preference adapter, agenda projection, dates and note excerpts |
| `PhoneScreens.kt` | Top bars, adaptive bottom bar/rail, direction-aware transitions, back hierarchy, creation and feedback |
| `KantiPalette.kt` | Pure, unit-tested colour resolution for every theme (including Snow) with WCAG contrast rules |
| `CompanionTheme.kt`, `CompanionComponents.kt` | Material mapping, Instrument Sans type scale, spacing/shapes, motion, grouped rows, pills, states |
| `Onboarding.kt`, `Snowfall.kt` | First-run onboarding with in-context permission, optional Snow-theme snowfall |
| `PlannerScreens.kt` | Today, day/week schedule, source filters, task buckets and contextual details |
| `NotesScreens.kt`, `NoteReading.kt`, `PdfReader.kt` | Library, note actions, lazy Markdown reading, local images/PDF and editor modes |
| `NoteEditorController.kt`, `InkEditor.kt` | Retained drafts, serialized autosave, lifecycle flush, shared normalized ink session |
| `SchoolScreens.kt` | Read-only school records, grade review and explicitly local scenarios |
| `SettingsScreens.kt`, `CompanionForms.kt` | Settings hierarchy, optional auth, task/event forms and date/time inputs |
| `CompanionModel.kt` | Presentation state and user actions; bounded search cache; serialized mutations |
| `CompanionGraph.kt` | Existing integration/storage boundary, managed-note writes and explicit school disconnection |
| `SchulnetzLoginActivity.kt` | Companion chrome around the existing allowlisted school/provider login |
| `Push.kt`, `res/layout/widget_next_lesson.xml` | Existing notifications/widget, connection guard, matching widget surfaces and deep link |

The shared `:core`, tablet `:app`, vault formats, crypto, Keystore and school URL
allowlists are unchanged. Legacy preference IDs and push payloads are translated at
the presentation boundary. Task writes retain `publishedIds`; calendar edits retain
recurrence, exceptions and linked-note metadata. Dirty note paths and companions
remain protected from remote replacement until saving completes.

## Build and verify

From `android/` with `ANDROID_HOME` configured:

```sh
./gradlew :core:test :companion:assembleDebug
./gradlew :companion:testDebugUnitTest :companion:lintDebug
```

A device regression test exercises the real local vault and native handwriting
view. Use a disposable, signed-out emulator (it creates a uniquely named test note):

```sh
./gradlew :companion:connectedDebugAndroidTest
```

The APK is `companion/build/outputs/apk/debug/companion-debug.apk`.

See [verification results](docs/VERIFICATION.md) for the actual device checks,
screenshots, environmental setup and untested boundaries for this implementation.
