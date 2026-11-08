# Kanti+ design system: "Stundentakt"

This note describes the November 2026 redesign of the Kanti+ phone app. It replaces the visual
layer described in [REDESIGN.md](REDESIGN.md). The information architecture, the shared `:core`
module, vault formats and school contracts are unchanged.

## Direction

Kanti+ is checked between lessons, often one-handed, by students of a Swiss Kantonsschule. Its
primary job is "where do I need to be next, what is due, what changed". The design treats the
school day as a measured line:

- **Time first.** Clock times, marks and counts use a condensed cut of Instrument Sans with
  tabular figures, so columns line up and times read at a glance.
- **One memorable element.** Heute leads with the next commitment: a large start time, the room
  as an outlined pill, a countdown, and the **day band** – one segment per lesson, past ones muted,
  the current or next one raised, cancelled ones in the danger tone.
- **A time rail.** Planer, exams, school events and search results hang on a thin vertical rail.
  Node shapes carry meaning without relying on colour: filled circle = lesson, diamond = exam,
  ring = personal event, square = task, hollow ring = cancelled.
- **Quiet everywhere else.** Paper background, white grouped surfaces, ink text, hairlines,
  one accent. Emphasis is reserved for urgency (overdue, cancelled, excuse deadlines).

Rejected defaults: generic card stacks with identical radii and shadows, all-caps eyebrow labels
(the old "ALS NÄCHSTES" is now sentence case), a monospace face for data, decorative gradients.

## Tokens

All colours come from one pure function, `kantiPalette(themeId, systemDark, accent, amoled)` in
`KantiPalette.kt`. It has no Android or Compose dependency and is unit-tested.

| Role | Light ("Papier") | Purpose |
| --- | --- | --- |
| background | `#F4F5F2` | page |
| surface | `#FFFFFF` | grouped rows, cards |
| sunken | `#E8EBE6` | search fields, pill tracks, icon tiles |
| raised | `#FFFFFF` | sheets, dialogs, menus |
| text | `#151C22` | ≥ 7:1 on every surface |
| muted | `#505B64` | ≥ 4.5:1 on every surface |
| hairline / outline | `#DCE0DA` / `#7F8991` | dividers / field borders (≥ 3:1) |
| accent | user choice, contrast-adjusted | links, selection, hero container tint |
| success / warning / danger | each with a soft container | status only |

Rules enforced by `DesignSystemTest` for every theme × every offered accent (plus extreme accents
and invalid input) × pure-black on/off: text ≥ 7:1, muted ≥ 4.5:1, accent ≥ 4.5:1 on background,
surface and its own container, on-accent ≥ 4.5:1, status tones ≥ 4.5:1 on their soft containers,
outlines ≥ 3:1. Accents that fail are moved towards black (light themes) or white (dark themes)
until they pass, so a user's accent choice never produces unreadable text.

Typography (`KantiTypography`): Instrument Sans (OFL, `licenses/InstrumentSans-OFL.txt`) as a
variable font with real 400–700 weights; the previous build only shipped Inter Regular, so every
bold was synthesised. Display styles use the condensed width (80) with `tnum`. Body text is 15–16 sp
and every text uses `sp`, so it follows the system font scale.

Spacing: 4 / 8 / 12 / 16 / 20 (page gutter) / 24 / 32 / 40 dp. Rows are at least 56 dp,
primary buttons 52 dp, every interactive element at least 48 × 48 dp.
Shapes: 8 / 12 / 16 / 22 / 28 dp; the hero and sheets use 28 dp, groups 22 dp, fields 16 dp.

## Themes

Stored theme ids are unchanged (`system`, `light`, `sepia`, `dark`, `midnight`, `forest`,
`aurora`), so existing selections, accents and pure black carry over without migration. Unknown
ids fall back to the system pair, as in the shared core.

**Snow** (`snow`) is a separate, phone-only choice: icy near-white surfaces (`#F0F5FA` page,
white cards), deep ink-blue text and its own restrained glacier blue (`#2766A0`). It stays light
in system dark mode and ignores the user accent while selected; the stored accent is kept for the
next theme. The tablet and desktop see an unknown id and use their system theme. Nothing changes
until the user taps the Snow tile.

**Snowfall** is off by default and only offered while Snow is active. It draws ~26 flakes over
the Heute card for 14 seconds each time Heute appears, at ~25 fps, and then stops. It never runs
with reduced motion or battery saver, pauses below `RESUMED`, is disposed when the card scrolls
away, and only invalidates drawing (no recomposition or layout per frame).

## Components (`CompanionComponents.kt`)

`Group` / `GroupItem` (rounded surfaces, also across lazy items), `SettingRow` with `IconTile`,
`ToggleRow`, `SectionLabel` (heading semantics, optional count and action), `Pill` / `ChoiceRow`
(single choice; the selected pill inverts and shows a check), `SegmentedTabs` (Tab role),
`SearchField`, `PrimaryButton` / `SecondaryButton`, `MetricBlock`, `Tag`, `StatusLine`,
`InfoBanner` and `EmptyState` with tones (neutral, accent, warning, error, offline),
`SkeletonRows` (static placeholders), `KantiSheet`, `SheetTitle`, `ConfirmDialog`,
`ColorChoices`. Screen chrome: `KantiTopBar` (large title on roots, back + title on sub-pages),
`KantiNavBar` / `KantiRail` (filled icon + pill indicator for the selected tab).

## States

- **Loading:** static skeleton rows; Heute and Planer wait for the cached snapshot
  (`CompanionGraph.snapshotReady`) instead of briefly showing "connect" or "free".
- **Empty:** an icon tile, a title, one sentence and, where useful, an action.
- **Unread timetable:** a warning-toned card on Heute ("Stundenplan noch nicht geladen") with a
  refresh action, warning rings in the week strip and a status line in day/week lists. A day is
  only "free" after its week was read (`lessonWeekCoverage`).
- **Offline:** a cloud-off status line with the last "Stand" on Heute, Schule and the school
  records; offline copy on the unread card. Connectivity comes from a validated default network.
- **Errors:** error-toned banners with a recovery action.

## Motion

Root tabs fade through (≈170 ms); sub-pages slide in by an eighth of the width with a fade
(≈240 ms) and reverse on Back. Pills, segments and expandable records animate colour or size
briefly. `systemReducesMotion()` (animator scale 0 or animators disabled) is observed live; when
true every transition becomes instant and snowfall never starts. The grade count-up already
honoured the animator scale and is unchanged.

## Onboarding

Four skippable pages (`Onboarding.kt`): value, Schulnetz connection (read-only, data stays on the
device), grade privacy (with the existing "cover new marks" switch), notifications. Permission is
requested only on the notification page, on the Mitteilungen settings page, or from a one-time
dismissible tip on Heute after the school is connected; the old prompt at every launch is gone.

Only a true first run sees it: `needsOnboarding()` is false when the user already has local access
or a FaNotes account, so updates never interrupt existing users or ask them to sign in again.
Completion is stored as `onboarding-version` in the app's private preferences. Settings → Über
Kanti+ → "Einführung erneut ansehen" replays it without touching accounts or connections.

## Privacy

Marks hidden by "Note erraten" stay hidden: rows show "?", averages exclude them (as before),
Noten shows only the count of hidden marks and a "Neue Note verdeckt" tag, and the onboarding
illustration uses a "?" placeholder. Badges use `highestVisibleMark`. The widget shows lessons only.

## Guidance used

No Android/Compose design skill was installed in this environment, and none exists in the
official Anthropic plugin catalogues; third-party candidates were unreviewed and were not installed.
The official `frontend-design` skill (read from the locally cached official marketplace) guided the
direction and the review against generic defaults. Implementation follows Material 3 for Compose,
Android accessibility guidance (48 dp targets, semantics, font scale) and WCAG 2.2 contrast, which
the unit tests check numerically.
