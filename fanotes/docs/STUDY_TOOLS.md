# Study tools (Lernwerkzeuge)

Structured helpers for worksheet work. They never solve a task; they hold the data a task needs.
Everything is stored as plain text inside the note, so it syncs like any other text and stays readable without FaNotes.

## Markdown notes: fenced blocks

A block is a fenced code block whose info string is `fanotes-<kind>` and whose body is JSON (`"v": 1`).
The live editor and the preview draw it as a table, diagram or card sheet; the source view shows the JSON.
Insert one from the toolbar button "Lernwerkzeuge" or from the command palette ("Lernwerkzeug: ...").
"Bearbeiten" on a rendered block opens its editor; every change is written straight back into the block.

| Kind | Block | Worksheet task | Content |
| --- | --- | --- | --- |
| `fanotes-key` | Table and identification key | Auftrag 5, 6 | feature table, key tree (`root`, `nodes` with `question`/`leaf`, `branches`), optional comparison image |
| `fanotes-sort` | Sorting board | Auftrag 11, any ordering | `cards`, `groups` (card ids), `mode` `groups` or `sequence` |
| `fanotes-map` | Concept map | Auftrag 12, hierarchies | `nodes`, `edges` with labels, `dir` `TB` or `LR`; layout is automatic |
| `fanotes-plate` | Picture sheet | Auftrag 13 | `items` with label, note and a picture stored as a file in the vault (`.fanotes/worksheets/<id>.jpg`, the folder the sheet import uses) and referenced by path; old notes with small data URLs still read |
| `fanotes-term` | Definition cards | Auftrag 7 | `terms` with term, definition, example, source |

Key and map diagrams export as PNG (copy, save, or place on the open sheet). Sort results insert as a Markdown table or list; a key inserts as a table or as numbered couplets ("1. Frage / a) ja → 2 / b) nein → Art").
Branch labels of a key hang on the drop line of their child and are wrapped to narrow lines. The width of a label is reserved in the span of its child, and the rows grow where labels need height, so long descriptive couplet texts never overlap each other, a box or a line.
Picture sheets and definition cards feed the existing flashcards (`## Lernfragen` cards keep working):
cards get the ids `plate:<item id>` and `term:<term id>`, and the review schedule is kept per id in the note's `fanotes-cards-v1` comment (pictures are not copied there; cards point at the same vault file).

## PDFs: assignments and highlights

The companion note of a PDF carries `<!-- fanotes-tasks-v1 {...} -->` with the detected and edited assignments
(number, text, minutes, page, done, seconds spent). Detection reads the PDF text layer for lines starting with
Auftrag, Aufgabe, Task, Exercise or Übung (numbered, or followed by a colon), joins hyphenated line ends and reads time hints such as
"(ca. 20 Minuten)" or "1 Lektion". A re-scan keeps ticks, timers and manual edits. A PDF without a text layer (a scan) or one that cannot be opened gets a notice that says so and points to adding assignments by hand.
The highlights overview reads the existing `fanotes-pdf-marks-v1` marks.

## Block safety rules

- Blocks are read strictly. Invalid JSON, a non-object, or a block the sanitiser would cut or rewrite (list caps, over-long text, rejected pictures, dropped nodes) is reported with the reason and shown as plain source in the editor and the preview. The block editor refuses to open such a block for writing, so nothing is silently lost.
- Unknown top-level fields of a block are kept on write-back; unknown nested fields are not.
- The editors only write what the reader accepts again. Every write goes through `normaliseStudyData` first (lists at their caps, texts at their lengths, no dangling references, no duplicate or self-pointing arrows, no branches under a result), so editing can never lock a block out of its own editor. The editors stop short of the caps instead (`KEY_LIMITS`, `MAP_LIMITS`, `SORT_LIMITS`, `PLATE_LIMITS`, `TERM_LIMITS`: add buttons disable, inputs carry `maxLength`, pasted cards that do not fit stay in the field); if something entered still did not fit, the editor says so. Switching a question with branches to "Ergebnis" (or deleting a branch with a subtree) asks first, because everything below goes with it.
- Cards without an id (hand-written or generated JSON) get an id made from their position and name, so it is the same on every read and the review schedule is found again. A block copied within a note shares its ids: an exact copy adds no second card, an edited copy gets an id of its own, the first block keeps the plain id.
- Block identity: the host remembers the block's offset and a fingerprint of its body, and re-locates it on every write (also for "insert table"). If the body changed meanwhile, or identical twin blocks make the position ambiguous, the editor locks read-only with a message instead of writing into another block.
- The `fanotes-tasks-v1` comment keeps exactly one live comment per note: the first valid one is replaced in place and valid duplicates are removed. A broken but closed comment is renamed `fanotes-tasks-v1-broken` (text stays recoverable, never wins on read); a later valid comment is read instead. A broken comment that never closes (or runs into the next marker) makes the write refuse with a message, because renaming it would not stop it swallowing the rest of the note. Clearing the list removes only the comment and its own line break.

## Annotations on PDFs and notes

The toolbar button "Lernen" opens the Lernwerkzeuge panel on PDF and plain notes. Unlike the blocks above, annotations are drawn over the page and stored in the `.famd` payload, not in Markdown.

- **Labels** (worksheet "beschrifte"): tap a point, drag a leader line, type the text. The label stays attached; drag the label or the anchor. Numbered mode (1, 2, 3) with renumbering and a legend. The **word bank** ("Begriffe") takes typed words or the current PDF text selection; tap a term and then the drawing, or drag it onto the drawing.
- **Stamps and legend**: ten stamps (gain, loss, event, red/green/yellow dot, H, V, A, check). A legend box lists the stamps in use with editable meanings. A thick translucent pen ("Ast markieren") marks tree branches.
- **Reference images**: from a file, the clipboard (Ctrl+V), the camera, or a cropped PDF region ("PDF-Ausschnitt"). Opacity, lock, and a side-by-side compare view.
- **Measures**: an angle (three points or between two lines) or a distance in cm (based on A4 width). The value stays as a label and follows moved points.
- The panel has its own undo/redo (panel buttons, Ctrl+Z / Ctrl+Y while it is open). After a sync that changes the note's companion file, the layer adopts the new annotations and clears its undo stack if there are no unsaved local edits; with unsaved edits it keeps the local state.
- Pen mode on PDFs already offers the ruler and Geodreieck drafting guides.

### `.famd` storage

An optional `annotations` array in the `.famd` payload (v1 and v2 encodings), sanitised by `electron/noteAnnotation.mjs`. Coordinates are page fractions (0..1), like `textFields`. Notes without the key are byte-compatible. Older app versions ignore the key and drop it when they re-save the note. A note with annotations counts as non-blank for sync. Android has the same sanitiser with the same key order.

| `kind` | Main fields |
| --- | --- |
| `callout` | `ax`, `ay` (anchor), `lx`, `ly` (label), `text` (max 120), `color`, optional `num` (1..999) |
| `stamp` | `x`, `y`, `stamp` (one of the ten ids, default `event`), `size` (12..64) |
| `legend` | `x`, `y`, `names` (stamp id to meaning, max 60 chars) |
| `image` | `x`, `y`, `w`, `aspect`, `opacity` (0.1..1), `locked`, `title`, `src` (PNG, JPEG or WebP data URL) |
| `stroke` | `pts` (max 600 points), `color`, `width` (2..60), `opacity` |
| `measure` | `mode` `angle` (3 points, or 4 for two lines) or `distance` (2 points), `pts`, `color` |
| `terms` | `list`: the word bank (max 80 terms, 60 chars each); a single entry with id `terms` |

Every item also has `id` and `page`. Unknown kinds are dropped and bad values are clamped. At most 600 annotations and 12 images are kept per note. An item without a valid id gets a stable `an-...` id: FNV-1a 32-bit hash of `kind|index|page|round(x*10000)|round(y*10000)|text`, base36 (the same rule on desktop and Android, pinned by test vectors).

**Image size caps.** New images are re-encoded to about 300 KB (max 1200 px edge; PNG only if small enough, else JPEG with stepped quality). A new image above 450 KB of encoded text is rejected. A note may hold 8 MB of image data in total; inserting beyond that shows a message with the used size and adds nothing. Older images up to 1.6 MB are still read. Images stay data URLs inside the note (no vault files).

### Support matrix

| Feature | Desktop / web | Android tablet |
| --- | --- | --- |
| Aufträge panel (detection, timer, edit) | yes | yes; detection reads the PDF text through Android 15, or Android 12 to 14 with SDK extension 13, or uses the text the computer synced; with none of them assignments are added by hand |
| Highlights overview | yes | yes |
| Blocks: draw | all five | all five, read-only except sort and term |
| Blocks: edit | all five | sorting board and definition cards; key, map and picture sheet are edited on the computer |
| Labels, numbering, word bank | yes | yes |
| Stamps, legend, branch pen | yes | yes |
| Measures (angle, distance) | yes | yes |
| Reference image from file | yes | yes (system picker) |
| Reference image from clipboard | yes | no |
| Reference image from camera | yes (device capture) | yes (#1220) |
| PDF crop as image | yes | yes (#1220) |
| Compare view | yes | yes (#1220; side panel in landscape, bottom in portrait) |
| Annotation undo/redo | yes | yes (own stack; ink undo unchanged) |

On Android, study gestures go through the normal ink path, so palm rejection, pen-only and "finger draws" apply; a plain finger still navigates. Stamps, legends and measure points are placed when the contact lifts without having moved, never when it lands, so a palm the system rejects or a cancelled contact leaves nothing behind. The open tool, selection, collected measure points, an unconfirmed crop and the label editor (with its typed text) survive a rotation or a restart of the activity. Android camera capture, PDF crop and the compare view came with #1220; images from every source are re-encoded to the same caps as desktop (≈300 KB, long edge 1200 px, 8 MB per note).

## Checks

- `npm run check:study-tools` parses, serialises, detects and lays out (no browser). It also runs a seeded property test on random keys with long German branch labels (no two boxes or labels overlap, no line runs through a label, nothing outside the drawing), the question-to-result toggle round trip, and the checks that every editor state reads back whole.
- `scripts/check-study-ui.mjs` is a Playwright smoke test against a web build (see its header).
- `node scripts/check-study-annotations.cjs` covers annotation geometry, sanitising, numbering, legend, undo, ids, image budget and the `.famd` round trip; `scripts/check-study-annotations-desktop.mjs` is the Electron smoke test (synthetic PDF).

## Android tablet

The Android app (`android/core/.../study`) reads and writes the same text, so a note edited on either side stays valid on the other.

- **Aufträge** (PDF notes, toolbar chip "Aufträge" or the command palette): the same detection rules, the same `fanotes-tasks-v1` comment, checkbox, timer, jump to page, add, edit, remove and progress. The ported rules are checked against the desktop results in `android/core/src/test/resources/study/vectors.json`, which `node scripts/generate-android-study-fixtures.mjs` regenerates from the desktop code.
  - **Panel.** A bottom sheet that takes at most 40 % of the window, so the page above stays readable. In small windows (phone, landscape, split screen) it folds up to its header after a jump, so the page it jumped to shows in full.
  - **Text for "Neu erkennen"**, in this order. (1) The device's PDF text API: `PdfRenderer` on Android 15 and newer, `PdfRendererPreV` on Android 12 to 14 once SDK extension 13 is installed (a Play system update; the platform's API list ships `framework-pdf` for the S, T, U and V extension chains, not for R, so Android 11 has none). (2) The text the computer synced next to the PDF: the page-text record `.fanotes/page-text/<hash>.json` (`fanotes-page-text-v1`) and the OCR transcript `.fanotes/pdf-ocr/<hash>.json` (`fanotes-pdf-ocr-v1`), each used only when its path, size and content stamp match the PDF. A page whose own text is nearly empty (a scan) takes the computer's text. The list the computer already detected is part of the note and shows on every device; only the scan needs text. Without any text the panel says so ("Scan ohne Text", or that the device lacks the PDF text function) and assignments are added by hand.
  - **Timer.** It runs until it is stopped, not only while the panel is open: closing or switching panels and leaving the app do not stop it, and a chip beside "Aufträge" in the toolbar shows the time and stops it. Moving to another note, ticking the task done or removing it stops it. The elapsed time goes into the note once a minute and whenever the app leaves or returns. The last checkpoint is also stored with the vault, so after the process is killed the timer continues when the note opens again. While the app lives the monotonic clock counts, so a clock change does not add or remove time; after a kill the stored wall-clock time is used. A stretch of more than two hours since the last checkpoint does not count and stops the timer (the list cannot take time back).
- **Markierungen** (PDF notes): highlights grouped by page with jump, remove and "Als Notiz kopieren". Android stores them in the same `fanotes-pdf-marks-v1` comment.
- **Blocks in Markdown notes**: all five kinds are drawn read-only (table, key tree, sorting groups, concept map with arrows, picture grid, definition cards) in the text editor and on the paper view; a block whose JSON cannot be read stays a raw code block. Tapping a drawn block opens the sorting board (drag cards between groups, or tap a card and pick the group) or the definition card editor; every change is written back into the block. Key tables, concept maps and picture sheets are created and edited on the computer; the tablet shows them and "Quelltext zeigen" reveals the JSON.
- **Flashcards**: `fanotes-plate` and `fanotes-term` feed the Android flashcards with the same `plate:<id>` / `term:<id>` ids; picture cards show the vault file.
