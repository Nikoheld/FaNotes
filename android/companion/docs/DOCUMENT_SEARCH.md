# Kanti+ document search

Branch `kanti-doc-search` (based on `kanti-redesign`). Not merged, not released, not installed on
any phone.

## Ownership and handoff

| Area | Owner | This branch |
| --- | --- | --- |
| Shared document-search / OCR / indexing foundation and its versioned interoperability contract | FaNotes main | **Not available yet.** No contract was found in the repository, its branches or the FaNotes docs on 8 November 2026. Nothing here defines one. |
| Desktop PDF OCR sidecars `.fanotes/pdf-ocr/<sha256(path)[0:32]>.json` (`fanotes-pdf-ocr-v1`, `fanotes/electron/pdf-ocr.cjs`) | FaNotes desktop | **Read only.** Used for a page when path, size and the desktop content stamp match. Kanti+ never writes, migrates or deletes them. |
| Vault formats, `NoteStore`, `:core` | Shared (`android/core`) | Unchanged. Imports use the existing `NoteStore.importUniquePdf` and `importImageWorksheet`. |
| Kanti+ search UI, the phone index, extraction and background work | Kanti+ (`android/companion`) | Implemented here. |
| `android/settings.gradle.kts` | Shared Android build | One addition: JitPack, limited by `exclusiveContent` to the group `com.github.adaptech-cz.Tesseract4Android`. Needs the build owners' consent before merge. |

The Kanti+ index is deliberately **not** a shared format: it lives in the app's private
`noBackupFilesDir/doc-search/`, is never written into the vault and never synced. When the shared
contract exists, the planned path is an adapter that reads its per-page text (like the desktop
sidecar adapter in `DocSearchFormats.kt`) and feeds the same `DocIndex`; the phone index can then
be rebuilt from it. Until then each client extracts on its own device.

Blockers and open decisions:

1. **Shared contract missing.** If the FaNotes main contract chooses a different page-text or OCR
   result format, `DocSearchFormats.kt` gains a reader for it; no phone data needs migrating.
2. **Notes need a FaNotes sign-in.** Kanti+ only shows notes, PDFs and worksheets after a FaNotes
   login (product decision of 4 November). Search works fully offline on the phone once
   documents are on it, with no FaNotes desktop, pairing or server running, but a school-only
   Kanti+ has no documents to search. Allowing local documents without an account would reverse
   that decision and is left to the product owner.
3. **JitPack dependency** for Tesseract (see table) and **APK size**: +7.5 MB native code per ABI
   (28.8 MB across the four ABIs in a universal APK) plus the 1.5 MB German model. Restricting
   release ABIs to arm64-v8a/armeabi-v7a would halve that; not changed here.

## What is searchable

| Source | How | Page in results |
| --- | --- | --- |
| Typed note text | Markdown without private markers | "Notiz" |
| Handwritten notes | Transcript stored by FaNotes on a computer or tablet (`searchTranscript`) | "Handschrift-Abschrift" |
| PDF with a text layer | Android PDF text API (Android 15, or system extension 13) | Seite N |
| Scanned PDF page | Desktop sidecar if present and current, otherwise on-device Tesseract | Seite N, with confidence |
| Image worksheets | Typed text boxes plus on-device Tesseract | "Arbeitsblatt N" |
| PDF annotations | Text of the PDF note's `.famd` companion | "Anmerkungen" |

A page counts as having a text layer at 20 characters, the desktop threshold. Up to 60 pages per
document are recognised by OCR per pass (desktop limit); later pages are listed as "Über den 60
erkannten Seiten". Only the first 500 pages are read. Files over 96 MB are not read.

**Handwriting:** Kanti+ does not recognise handwriting itself. Handwritten notes are found only
through a desktop/tablet transcript, and handwriting on scans is mostly not recognised by
Tesseract. This is stated in the app (Einstellungen → Dokumentsuche).

**Older Android:** without the text API (below Android 15 without extension 13) every PDF page is
read by OCR, which is slower and less exact. The app says so on the same settings page.

## Matching and results

- Case-insensitive, `ß` = `ss`, umlauts = base letter = `ae/oe/ue` spelling, ligatures and
  diacritics folded, words hyphenated across line breaks joined. Every term must appear; each
  term also matches as a prefix.
- Ranking: BM25-like term weight, exact words above prefixes, title matches boosted, text layers
  above OCR, OCR scaled by confidence. Identical page text in several files shows once with
  "auch in N weiteren Dateien"; repeated pages inside one file stay separate.
- A result shows title, folder, page (or worksheet / handwriting / annotations), a snippet of at
  most 160 characters with the matching words highlighted, and the OCR confidence.
- Opening a result goes to that page of the PDF. On Android 15 / extension 13 the words are
  marked on the rendered page; otherwise, and on OCR pages, the app shows the page and says that
  the exact spot cannot be marked. Note text highlights matches in the reader.

## Indexing, lifecycle and limits

- SQLite FTS4 (built into Android) with per-document fingerprints (size and mtime of the file, its
  companions and embedded worksheets), extractor version, resume page, attempts and next retry.
- Passes start on app start, after every library reload (edits, sync, imports, renames, deletes)
  and run on one background-priority thread, one document and one page bitmap (≤ 2400 px) at a
  time, committing every four pages. Cancellation, pause, a killed process or the WorkManager time
  limit lose at most one batch; the next pass resumes at the committed page.
- Sign-out stops a running pass first; the database is closed and the files are deleted under the index lock, so nothing writes to a closed database. A failing pass is recorded in diagnostics and never crashes the app.
- When the app leaves the foreground the in-process pass stops and a unique WorkManager job
  continues for up to 8 minutes per run, only when battery and storage are not low.
- Failures: encrypted, unreadable or too large documents are "unsupported" until the file changes;
  transient failures retry with backoff (1 min doubling, max 6 h). OCR without text, OCR errors and
  limits are recorded per page and listed with reasons under Einstellungen → Dokumentsuche, which
  also offers pause, retry and rebuild.
- Edited documents are read again from scratch (old text removed first); deleted, trashed or moved
  documents leave the index on the next pass; a stale schema or damaged database is rebuilt.

## Privacy and accounts

- One index per FaNotes account (file name derived from a SHA-256 of the account id). Opening
  another account deletes other accounts' indexes; signing out deletes all of them.
- Only documents the Notes library shows are indexed: `Hausaufgaben.md`, `Kalender.md`, trash,
  `.fanotes/` data and all Schulnetz data (grades included) are never read, so hidden grades
  cannot leak through snippets or index data.
- No network use: PDF text, OCR and the index all run on the phone. Originals, annotations and
  sessions are not modified; imports copy the picked file into the vault.

## Verification

JVM (`./gradlew :companion:testDebugUnitTest`, sqlite-jdbc with the same FTS4 SQL):
17 `DocSearchTest` cases, all passing — German folding and umlaut variants, snippets and
highlight ranges, FTS query safety, text/scan/mixed pages with an OCR failure, ranking,
duplicates, edits and deletions, unchanged documents not re-read, cancellation and resume
without lost or repeated pages, unsupported vs retryable failures with backoff, a failing page,
persistence across restart, stale schema rebuild, worksheet/handwriting labels, desktop sidecar
reuse (stamps match the desktop's own `pdfByteStamp` computed in Node), rotation choice, only
given documents indexed, and a 2,000-page library: built in 2.5 s, query p50 8.6 ms,
p95 15.8 ms, max 37.5 ms (JVM on the shared host, not a phone).

OCR engine measurement (host Tesseract 5.5 with the bundled `tessdata_fast` German model, the
same engine family and model the app ships; synthetic rendered pages, which are cleaner than
phone photos): 0 % character errors and 7/7 umlaut words at 300, 200 (8 pt) and 150 dpi, sans
serif, 3° skew and blur with low contrast; 7.9 % CER with 4 % salt-and-pepper noise; English text
0 % CER with the German model. Pages turned 90° or 180° read upright give 89 % CER at 0.16
confidence; the app's orientation retry recovered both to 0 %. About 0.3–0.45 s per page on the
host.

Not verified (no emulator or phone was used): `DocSearchDeviceTest` (Tesseract on Android,
PdfRenderer text layer, Android SQLite FTS4) compiles but did not run; no on-device timing,
memory or battery measurement; search UI, import, page opening and highlighting were not seen on
a screen; real scans, phone photos and handwriting were not tested.
