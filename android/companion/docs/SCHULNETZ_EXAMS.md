# Schulnetz exams: structure and the own-exams filter

All names below are invented. This document is based on the scraper code and the synthetic fixtures
only. No live page was requested. Section "What the fixtures do not show" lists what must be checked live.

## Where exams come from

| Source | Request (GET only) | Scope |
| --- | --- | --- |
| Personal timetable | scheduler `pageid=22202`, `ansicht=schueleransicht` | The student's own lessons, plus any exam the school puts into the timetable |
| Class overview / Prüfungsplan | scheduler `pageid=21312`, `ansicht=klassenuebersicht`, `showOnlyThisClass=-1` | Every exam of the whole Abteilung |
| Prüfungsplan page HTML | `index.php?pageid=21312` | Page shell with the semester range; Android also parses a drawn table as a fallback (`readExamsPage`) |
| iCal export | link found on the timetable page | Lessons and exam-like entries (`CATEGORIES`, title lead) |
| OAuth REST | `/rest/v1/me/exams` | Documented as "me", but the shape is not proven by a fixture |
| Terminliste | `pageid=22108` | School appointments; exam-like titles stay appointments and are not filtered |

`showOnlyThisClass=-1` is what the page itself sends; the response still contains the whole Abteilung.

## Scheduler XML fields

Both views return `<event id=...>` blocks parsed by `parseSchedulerXml` (server) and `parseSchedulerXml` in
`WebPages.kt`. The fields used:

- `start_date` / `end_date` (or `vdatum`+`vzeit`, `bdatum`+`bzeit`): the slot.
- `event_type`: `0_stp` is a lesson, `1_pru` (or any text containing Prüfung, Klausur, exam, test) is an exam,
  `5_trm` is a class appointment, `event` is an appointment. `examMarker` / `isExamLike` decide; an event whose
  title starts with Test, Prüfung or Klausur is exam-like too.
- `text`, `fachbezeichnung`, `kursbezeichnung`: title. `kurskuerzel` / `fachkuerzel`: course code. `AgendaEvent.courseName`
  is the code, falling back to the title.
- `kursid` -> `courseId`; `lehrerkuerzelname` -> teacher; `zimmerkuerzel` -> room.

Events from the overview that have no explicit type are labelled `exam` by the scraper.

## What identifies a course

Live data (counts and shapes only, reported by the maintainer) shows:

- Lessons have a numeric `courseId` and a `courseName` such as `Sub_G24a_Teach` (subject, class group, teacher),
  `Subj_G24a` or `Subj 2.3` (subject and a group number).
- Overview exams have no `courseId` and no teachers. `courseName`, `text` and `timetableText` start with the course
  code, followed by the exam title: `Sub_G24a_Teach Test 1`.
- Half-class and group courses are told apart by the group part (`G24a` versus `G24b`, `2.3` versus `2.4`), not by the
  subject. A teacher is part of the code only after `_`.

Because exams carry no `courseId`, the id cannot be the key.

## The key and the rule

`courseIdentity(label)` (server: `schulnetz-logic.mjs`, Kotlin: `OwnExams.kt`) splits the leading token on `_` or a
space into subject, group part and optional teacher (lower case). A group part is a class group (`G24a`,
letters, two digits, letters) or a dotted group number (`2.3`). A label without a group part has no course identity.

Two identities match when subject and group are equal and the teachers are equal or missing on one side.

`ownExams(exams, events)`:

1. No lesson in `events` (timetable not loaded): return everything and mark `examsUnfiltered`.
2. The own courses are the identities of all lessons in all loaded weeks (not only the exam week).
3. An exam is dropped only if it has a course identity and no own course matches. Entries without a group part
   (`Bio Test ...`, `5_trm` appointments) are kept, also when the student has several courses of that subject.

Exams inside the personal timetable need no extra rule: they are kept as before (`carryTimetableExams`). An exam in
both the timetable and the overview is merged into one (`distinctExams`: same id and time, or same label and slot).

## Exam length and lessons

An exam of one or two lessons is one entry from the first lesson's start to the last lesson's end. The timetable
replaces the covered lessons by the exam (`examsInLessonSlots`, `ExamSlots.kt`; `agenda.ts` in the web app). That
replacement reads the filtered list, so a foreign exam never replaces one of the student's lessons.

## Where the filter runs

- Server scraper (`schulnetz-web.mjs`) after all exam sources are merged; REST poll; `GET /snapshot` for snapshots
  stored before the filter existed (silent migration).
- `diffSnapshots` on both sides (`previous` and `next`), so a foreign exam is no news and its disappearance is silent.
- Android: device-mode read (`SchulnetzClient`), single page merge, REST keep-loaded (`CompanionGraph`),
  `adoptServerSnapshot`, snapshot decoding (stored snapshots), and `diffSnapshots`.
- Everything else (exam list, widget rows, planner, agenda, web `agenda.ts`, `Today.tsx`) reads the filtered snapshot.

## What the fixtures do not show

The committed HTML fixtures are page shells with no scheduler XML, so none of the following is proven by them:

1. The real `kurskuerzel` / `text` of overview exams and whether `kurskuerzel` equals the full `Sub_G24a_Teach Title`
   or only the code. Check: one `klassenuebersicht` week response, fields `kurskuerzel`, `fachkuerzel`, `text`, `kursid`.
2. Whether the lessons' `kurskuerzel` in `schueleransicht` uses exactly the same code as the overview (case, `_`, group).
3. Group-number and class-group shapes at other schools or departments (the group token pattern is derived from a
   small sample).
4. Whether `/rest/v1/me/exams` entries carry the same course label as the timetable. If not, the filter would hide
   own REST exams; check one `/rest/v1/me/exams` item next to `/rest/v1/me/events`.
5. Exams that the school puts into `schueleransicht` as `1_pru`: none were seen live.
6. Teacher spelling in the code versus `lehrerkuerzelname` (only the code part is used).
