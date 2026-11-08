# Kanti+ verification

## November 2026 redesign ("Stundentakt")

Branch `kanti-redesign`, 8 November 2026. Not merged, not released, not installed on any phone.
The November 3 record below is kept unchanged as history.

### Automated (host JVM, Gradle)

| Check | Result |
| --- | --- |
| `:companion:assembleDebug`, `:companion:assembleDebugAndroidTest` | Build successful |
| `:companion:testDebugUnitTest` | 27 tests, 0 failures (16 existing presentation tests, 11 new design-system tests) |
| `:companion:lintDebug` | 0 errors; warnings are dependency versions, `UseKtx`, unused resources and intentional Swiss "ss" spellings |
| `check-user-strings.py` (runs on every preBuild) | 932 strings and 15 plurals; German and English catalogs match; no hard-coded UI copy |

`DesignSystemTest` checks WCAG contrast for every theme × offered accent × extreme and invalid
accents × pure black, that stored theme ids resolve to themselves, Snow's fixed accent and light
mode, onboarding only on a true first run, that an unread timetable leads Heute instead of a
free-day message, unread-day detection before the next commitment, rail positions, and that
snowflakes stay inside the card, and that a connected school without a first fetch is not a free day.

An independent read-only code review of the branch found a LazyColumn duplicate-key crash in
Planung und Noten, a free-day case right after connecting, and several smaller issues (dates
without month on exam rows, cancelled exams in "Kommt in Sicht", week-strip cells under 48 dp,
rail gaps, clipping at 200 % font, one animation ignoring reduced motion). All were fixed in
commit "Fix redesign regressions found in device checks and review."

### Emulator (isolated AVD, API 35, synthetic data only)

All screens use invented data seeded through `run-as` (`Alex Muster`, class `G3b`); the school
link was marked disconnected so the emulator never contacted Schulnetz or the FaNotes server.
Device clock set to Monday 9 November 2026, 10:05, Europe/Zurich, to show a school day in progress.

Checked on the emulator: German light theme on Heute, Planer (day and week), Aufgaben, lesson
sheet, Noten, Fach with a hidden mark ("?", excluded from the average), Schule, Prüfungen,
Absenzen, Mitteilungen, Einstellungen, Darstellung, Benachrichtigungen, Suche, creation sheet
and task form; dark theme on Heute, Noten, Planer and Darstellung; Snow theme with snowfall on
Heute, Noten, Planer and Darstellung. Device checks led to the fixes listed above (clipped hero
time, rail shift under the highlight, duplicate "Fällig", a status line inserted off-screen,
a loading flash, truncated sheet buttons, "Ganztägig" breaking in the time column).

Captures from the final build: `screenshots/2026-11-redesign/b0*` (dark) and `e0*` (Snow). The
`a*` light captures are from the build just before the final review fixes; the fixes do not change
those screens except the week strip, exam dates and the hero layout at large font sizes.

### Not verified

The emulator was repeatedly aborted by its own hang detector while other workloads drove the
shared host to a load average of 50–150, and emulator use was then stopped on request. Therefore:

- No frame-time or transition profiling was recorded. `tools`-style `dumpsys gfxinfo` runs were
  prepared but not executed; nothing here claims smoothness. Design-level measures: snowfall only
  invalidates drawing, timetable coverage is memoised per snapshot and week, skeletons are static,
  transitions are 90–240 ms and collapse to instant with reduced motion.
- Not inspected on a device: large text (1.6×) at 320 dp, landscape rail, onboarding pages,
  unread-timetable state, English UI, the widget and the Notes area (needs a FaNotes account).
- Instrumentation tests (`OnboardingPersistenceTest`, updated `OfflineEditorTest`) compile but were
  not run. `OfflineEditorTest` also needs a signed-in FaNotes account since guest mode hides Notes.
- No real phone, real Schulnetz login, push delivery or TalkBack session was used.

## November 3 redesign verification (history)

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
