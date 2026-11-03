# Companion redesign verification

Implementation verified on 3 November 2026. Screenshots use synthetic school and
vault data on an isolated Android emulator; no live student account was used.

## Build and automated checks

From `android/`:

```sh
./gradlew :core:test :companion:assembleDebug \
  :companion:testDebugUnitTest :companion:lintDebug \
  :companion:assembleDebugAndroidTest --no-daemon --max-workers=2
```

Result: **BUILD SUCCESSFUL**.

| Check | Result |
| --- | --- |
| Shared core | 425 tests passed; 0 failed or skipped |
| Companion presentation | 9 tests passed; 0 failed or skipped |
| Companion debug APK | Assembled and installed successfully |
| Android lint | Passed with no errors; platform/dependency/style warnings remain |
| Device editor regression | 1 instrumentation test passed on API 35 |
| Whitespace/diff check | `git diff --check` passed |

The instrumentation APK was installed and executed using an isolated ADB server:

```sh
adb -P 5041 -s emulator-5580 shell am instrument -w -r \
  ch.fasrv.fanotes.companion.test/androidx.test.runner.AndroidJUnitRunner
```

`OfflineEditorTest` opens the real application without an account, creates a note,
edits text, opens the native ink mode, injects a drawing gesture, waits for disk
persistence, checks normalized coordinates through the shared codec, undoes/redoes,
and saves back to the library. A pixel assertion checks that the native canvas
does not paint over the Ink mode label. It regresses the nested horizontal-scroll crash
found and fixed during this implementation.

Presentation tests cover legacy push/start-page adaptation; merged chronological
agendas; imported-exam/homework deduplication; hidden lessons/calendars; completed
tasks; clamped monthly repeats, exceptions and inclusive spans; midnight end
semantics; task buckets; private marker exclusion from previews/search; and timed
commitment priority over all-day entries.

## Device workflow checks

Executed against the real local vault with synthetic fixtures:

- Empty-state navigation through Today, Planner, Tasks, Notes, School and settings.
- Populated day navigation, cancellations/substitutions, tasks, note previews,
  school overview, grades/subject details, absences and updates.
- Task creation and completion, including saving while the keyboard is open.
- Task edits/imports retain the document's `publishedIds` metadata.
- Local calendar event creation retains the pre-existing weekly event and metadata.
- School homework and exam import create local records; the cached school snapshot
  remains byte-for-byte unchanged.
- Imported task/calendar records remain after force-stopping and restarting the app.
- Full-text search retrieves the correct body-text match in a 200-note archive.
- Light and dark system themes inspected on a 393dp phone viewport.
- 320dp width with 1.6 font scale inspected for Today, Tasks, grade search and subject
  details. Large-text creation is docked so it does not cover list content.
- Wide, short landscape viewport inspected. The compact rail keeps all four roots
  reachable; schedule controls reduce to day navigation and a source menu.
- Keyboard/inset handling, readable wrapping, scroll access and creation labels
  inspected. Accessibility assertions also run in the editor device test.

These are workflow and layout checks, not a frame-time or battery benchmark.

## Refinements made during verification

- Removed the nested horizontal scrolling container that crashed ink mode.
- Clipped the native paper view and bounded its background paint so it cannot
  cover the editor header.
- Kept the text field's own scrolling and editable accessibility semantics.
- Exposed the creation action's accessible label explicitly.
- Consumed scaffold insets before applying keyboard padding.
- Docked creation for larger fonts and compacted short-window navigation/calendar
  controls; grade summaries yield space while searching.
- Removed repeated note headings from excerpts and private markers from search.
- Preserved current preference edits during asynchronous reloads.
- Guarded unreadable managed documents instead of replacing them with empty data.
- Disabled the exam-import action once the exam is already in the local calendar.

## Environment

JDK 21, existing Android SDK platform 37.0/build tools 36, API 35 Google APIs x86_64
emulator, Kotlin/Compose versions already selected by the repository. The shared
host's `/tmp` had no free inodes, so temporary files, Gradle caches and emulator
state used this chat's workspace. The local Gradle JVM override used a 4GB heap and
1GB metaspace after the default 384MB metaspace caused excessive GC. This override
is not a repository requirement or a versioned Gradle change.

## Boundaries and remaining limitations

Live FaNotes authentication/synchronization, Microsoft/Schulnetz authentication,
remote push delivery and network handover were not exercised with real accounts.
The existing transports, crypto and school read-only allowlists remain in place;
the core tests cover their shared format/protocol behavior.

Physical stylus pressure/palm behavior, home-widget placement and a broad corpus of
PDF/worksheet files were not visually tested on physical hardware. Emulator drawing
and the shared ink tests passed. The new reader preserves advanced content through
the shared store; it does not add the tablet's full math/worksheet editing tools.

`android/core` and `android/app` sources are unchanged. The only change outside the
Companion module is the Android README's Companion description/link.

## Review captures

All captures below are real emulator renders using synthetic data.

| Screen | Capture |
| --- | --- |
| Today, light | [today-light.png](screenshots/today-light.png) |
| Today, dark | [today-dark.png](screenshots/today-dark.png) |
| Planner | [planner.png](screenshots/planner.png) |
| Notes | [notes.png](screenshots/notes.png) |
| School | [school.png](screenshots/school.png) |
| Large text on a narrow phone | [large-text-tasks.png](screenshots/large-text-tasks.png) |
| Landscape schedule | [landscape-planner.png](screenshots/landscape-planner.png) |
| Ink editor | [ink-editor.png](screenshots/ink-editor.png) |
| Note reader | [note-reader.png](screenshots/note-reader.png) |
| Settings | [settings.png](screenshots/settings.png) |

## Built artifact

`companion/build/outputs/apk/debug/companion-debug.apk` (77368908 bytes).

SHA-256: `460cf161ce597839bd8896ddb479450de37af1f344ac14aa2dc8c355dc623d2f`.
