# Companion: product audit and redesign specification

## Audit (before implementation)

Inspected `android/README.md`, `ARCHITECTURE.md`, all Companion screens, model,
graph, native ink view, login, transport, background refresh and widget; shared
vault, ink session, sync, calendar/homework, grade math, preferences, notification
routing and read-only school contracts; tablet presentation/storage seams; desktop
homework/calendar models and views, FAMD and sync architecture.

### Existing inventory and navigation

Five tabs: Heute (configurable stack of next lesson, today's lessons, exams,
grade/promotion summary, messages/events and five tasks), Plan (day/week lessons),
Noten (courses, marks, prediction, aliases/colors), Notizen (folder tree, create,
manual-save ink/text editor), Mehr (homework, personal calendar, absences, exams,
events/messages/vacations, account statement and settings).

Account login/registration gates the whole app. Settings mix seven themes, accent,
AMOLED, startup destination, dashboard visibility, timetable hours/weekends/density,
hidden lessons, grade precision/sort/promotion points, widget density, school URL
and Microsoft login, notification categories/background checks, local profile,
badges, launcher aliases, ntfy/UnifiedPush, diagnostics, sync and logout.
School homework and exams can be copied to the local managed notes. School data is
cached. An excuse deadline is informational, never an absence submission.

### Problems

- Daily homework and personal commitments are buried in More; two calendar-like
  screens do not tell a complete story. Grades occupy a root destination despite
  being a less frequent review activity.
- Diagnostics displace useful content on Today, timetable and grades.
- Every homework row contains a large editing form. Every course contains its
  calculator/configuration. Lists become impractical with hundreds of entries.
- No global search, note previews, clear screen chrome, Android back hierarchy,
  loading recovery or transient feedback. Fixed chip rows can overflow.
- Typography overrides lose Material's size hierarchy. Incomplete color schemes
  leave default container colors unrelated to the selected theme.
- All UI lives in one 871-line file and reads storage in composables. Manual note
  saving can lose edits; the editor divides a phone between ink and keyboard text.
- The original phone ink view uses page pixels rather than the shared 0–1 stroke
  contract. Remote vault changes do not trigger presentation reloads.

### Compatibility boundaries

Keep `:core` and `:app` behavior intact. Keep `.md`/`.famd`, original ink IDs,
unknown payload fields, worksheet links, sync encryption/Keystore, conflict copies,
managed `Hausaufgaben.md`/`Kalender.md`, published homework IDs, existing preferences,
hypothetical-grade files, launcher aliases, cached snapshots, school login gate,
notification IDs/highlights and read-only URL allowlist. No official grades,
attendance or school assignments are modified. Only explicit local imports write
FaNotes data. Do not display push URLs or credentials as interface metadata.

## Product specification (written before UI implementation)

### Philosophy

A quiet student field notebook: know what is next, finish what is due, capture an
idea, retrieve your work. Paper-toned surfaces, precise blue ink, disciplined rows
and fine rules. Use emphasis for urgency and current context, not for every box.
Work locally before connecting an account. Connection failures never replace the
last usable data with an empty screen.

### Information architecture

Four primary destinations with persistent state and a bottom bar on phones:

1. **Today** — immediate priorities and continuation.
2. **Planner** — Schedule and Tasks, two explicit modes of the same planning space.
3. **Notes** — searchable library, folders, recent work and contextual organization.
4. **School** — read-only records: grades, exams, absences, updates and statement.

A rail replaces the bottom bar on wide/landscape windows. Search and Settings are
consistent top-bar actions. Subscreens have a back arrow; Android Back dismisses
a sheet, returns to its caller, ascends a folder, then returns to Today before exit.
Notification routes adapt existing core route names to the new hierarchy.

Rejected five independent roots for calendar/homework/grades: they fragment the
same planning workflow. Rejected putting every school record on Today: most are
review material. Tasks remain one tap from Today and an explicit Planner mode;
this trades one mode selection for keeping the navigation legible.

### Screen composition, top to bottom

- **Welcome/account:** compact identity; clear value; email/password and keyboard
  actions; sign in or explicit registration mode; explain end-to-end encryption
  before creating an account; continue locally. Account connection remains optional.
- **Today:** date and personal greeting; a small connection warning only when
  actionable; one prominent next commitment; urgent tasks (bounded with View all);
  a few recent notes; optional school signals respecting dashboard preferences.
  Creation opens a reachable sheet with note/task/event choices. No diagnostic UI.
- **Planner / Schedule:** Schedule/Tasks mode switch; month and Today/date picker;
  numbered weekday strip; day/week agenda selector and source filters; chronological
  rows integrating visible lessons, local recurring/multiday events, exams and
  homework deadlines. A day is never compressed into seven tiny event columns.
  Event details open a sheet; hide-once/series actions only appear there for lessons.
- **Planner / Tasks:** search; Open/Done/School filters; compact grouped Overdue,
  Today, Upcoming, No date lists with subject, due date, priority and completion.
  Tap the row for notes/editing; tap the checkbox to finish. School tasks clearly
  identify their source and offer an explicit import, never an official completion.
- **Task form:** title first; subject; date/time pickers; priority and type; details;
  save. Local create/edit/delete use the existing desktop-compatible document.
- **Event form/details:** title; calendar and date/time; location/details; local
  save/delete. Existing recurrence metadata stays intact. School exams can be
  copied into FaNotes, and related notes can be opened from event details.
- **Notes:** first-class search; Recent/Library modes; folder breadcrumb; folders
  as compact rows, notes with title, real text/ink preview, location and modified
  date. Context menu handles rename/move/duplicate/trash. New note asks for a name
  and opens it. Folder creation and recoverable on-device trash are contextual.
- **Editor:** back/title/save state; Read/Text/Ink modes use the full remaining
  screen, rather than sharing a cramped split. Autosave and flush on lifecycle
  pause/back; failed saves remain recoverable. Ink gets a reachable tool dock,
  undo/redo, semantic selected states and swatches with accessible labels.
- **School:** connection identity and freshness; structured rows for Grades, Exams,
  Absences, Updates and Statement, with meaningful counts. Missing source data is
  explained. Connection management is linked directly.
- **Grades:** overall average/promotion summary; search/sort; compact subject rows.
  Subject detail has marks first, local scenarios and target-grade calculator
  second, with aliases/colors in contextual editing. Clearly label local scenarios.
- **Absences:** open/settled status, dates, reason and excuse deadline; no submission
  controls. **Exams:** date-grouped compact rows and details/import. **Updates:**
  messages, announcements, school events and vacations with readable expandable
  text. **Statement:** date/description/amount/balance, explicit unsupported state.
- **Settings:** categorized index: Account & sync; Appearance; Planning & grades;
  Notifications; Profile; Diagnostics. Subscreens contain short labeled groups,
  full-width controls, horizontally scrollable choices and descriptive switches.
  Account controls connection, school URL, refresh and sign out; appearance owns
  all themes/accent/AMOLED/icon; planning owns dashboard, start destination, hours,
  hidden lessons and grade display; diagnostics owns explicit sharing and timing.

### Design system

Inter with explicit 28/24/20/16 title hierarchy, 15/14 body, 12 metadata; line heights
and weights specified throughout. 4/8/12/16/24/32 spacing. Page inset 20dp; content
width capped at 840dp on wide windows. Mostly flat lists and subtle dividers;
12dp row selection, 16dp highlight surfaces, 24dp sheets. 48dp minimum actions.
Complete light/dark Material schemes and semantic success/warning tokens. Accent
adapted for readable contrast in both modes; every selected swatch has a check and
content description. Existing theme IDs and accent preferences continue to work.
Use system insets, edge-to-edge bars and keyboard padding; avoid fixed row heights
for text. Lazy lists, bounded previews, off-main storage/search, stable keys.
Native ripple, brief transitions only (platform animation scale respected), no
unnecessary looping/decorative animation. TalkBack labels on all icon actions;
selected/toggle semantics; readable loading/error/empty states with real recovery.

### Validation plan

Run `./gradlew :core:test :companion:assembleDebug`, Companion unit tests and lint.
Test the new pure route adapter, agenda merging/deduplication/recurrence and task
bucketing. Use Android tooling if a device can start; inspect light/dark, small and
wide screens, large fonts, populated and empty data, keyboard and Back behavior.
Record actual results and limitations separately; never imply live school login
or sync was tested without an authorized test account.


## Final implementation refinements

Device checks led to docked creation at larger font scales, a compact icon rail and
calendar toolbar in short windows, and a grade summary that collapses during
search. The final theme tokens are defined in `CompanionTheme.kt`: 6/10/14/18/24dp
shapes, 16/14/12sp body text and 28/24/20/16sp heading/title steps. These refine the
initial specification above. Actual checks and untested boundaries are recorded
in [VERIFICATION.md](VERIFICATION.md).
