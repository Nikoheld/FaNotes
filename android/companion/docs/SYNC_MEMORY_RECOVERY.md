# Bounded sync and trusted grade reads

The reported resume crash was in FAMD identity generation during `SyncEngine.applyRemote`, after a successful Schulnetz refresh. Sync previously unpacked v2 points and repeatedly deep-copied and repacked the expanded tree. It now reads the stored representation, validates packed blocks without allocating point maps, and copies only the root and ink metadata maps when changing timestamps or local statistics. Synchronous serialization borrows unmodified subtrees. The editable reader still expands points normally; v1/v2 formats, encryption and server hashes are unchanged.

## Memory boundaries

- Note transforms accept at most 16 MiB, 100,000 JSON nodes and 64 levels. Packed points remain strings and do not consume one node per point. Before allocation, the worker requires headroom of eight times the input size. If collectible garbage obscures that headroom, it requests one collection before checking again.
- General JSON parse, copy and stringify operations reject excessive depth, node counts, cycles and expanding alias graphs. Packing checks point block sizes before allocating buffers.
- Network response bodies have an available-heap budget, including unknown/chunked lengths. Callback allocation failures are returned to the engine, rather than escaping the OkHttp thread. Resource-limit failures are not retried as network failures.
- Remote validation, identity generation and statistics decoration finish before the original file is replaced. Memory failures unwind the document operation, release an emergency reserve, pause sync and leave the cursor pending. Automatic retries stay paused; an explicit manual sync can retry. No data is truncated or replaced with an empty note. The separate last good school cache stays available.

These are conservative safety limits. An oversized legacy note can pause sync until it is reduced or split on a device that can handle it. An application-wide exhaustion caused by another component cannot be prevented by a sync boundary.

## Grade provenance

Blocked start pages (including inactivity, IP rejection and login walls), zero successful pages, missing or failed grade pages, and incomplete ownership of dated exam rows cannot replace a previous grade book. Recent grades on the start page are no longer used as a complete list. The additive `gradesReadComplete` field survives normalized snapshot storage and uploads; old snapshots remain readable. Recognizable read errors from older clients are also checked.

Android and server parsers associate exam rows with their owning course table. Layout headings such as `Fach Kurs` are rejected as course names. Sibling course tables and nested exam groups are handled independently. The server retains its previous grades on failed scrapes and on partial or placeholder-course uploads. A later valid complete read can repair an already damaged cache.

## Diagnostics and regression coverage

Sync diagnostics contain fixed phase/reason tokens, byte sizes, node counts and depth. `deepCopyDepth=0` records that the sync document path no longer deep-copies ink. There are no document paths, note bodies, course labels, student names, marks or URLs in these records. Exception diagnostics retain class names and stack frames while omitting arbitrary exception messages. Folder census logs now contain counts only; logcat excerpts retain process/failure categories only. The existing separate, explicitly requested HTML capture export is not used for these diagnostics.

Fixtures `noten-multi-course.html` and `blocked-start-grades.html` are generated synthetic markup, not device exports. Tests cover 18 marks in three distinct courses, blocked/zero-page seven-mark replacements, unowned exam rows, sibling tables, server snapshot uploads, 100,000 packed points, cyclic/deep JSON, corrupt packed blocks, bounded HTTP responses and an injected OOM followed by a successful manual retry. The latter checks unchanged local note bytes, school snapshot and saved sync state.

Run from the repository root:

```sh
cd android
./gradlew :core:test :companion:assembleDebug :companion:testDebugUnitTest :companion:lintDebug
cd ..
node --test fanotes-site/schulnetz-logic.test.mjs fanotes-site/sync-guard.test.mjs fanotes-site/schulnetz-i18n.test.mjs
```

No live Schulnetz sessions, student data, registration, enrollment, confirmation, eSchool or logout actions are needed for these tests. The UI design is unchanged.
