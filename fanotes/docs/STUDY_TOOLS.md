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
| `fanotes-plate` | Picture sheet | Auftrag 13 | `items` with label, note and a small image (data URL, at most about 220 KB each) |
| `fanotes-term` | Definition cards | Auftrag 7 | `terms` with term, definition, example, source |

Key and map diagrams export as PNG (copy, save, or place on the open sheet). Sort results insert as a Markdown table or list.
Picture sheets and definition cards feed the existing flashcards (`## Lernfragen` cards keep working):
cards get the ids `plate:<item id>` and `term:<term id>`, and the review schedule is kept per id in the note's `fanotes-cards-v1` comment (pictures are not copied there).

## PDFs: assignments and highlights

The companion note of a PDF carries `<!-- fanotes-tasks-v1 {...} -->` with the detected and edited assignments
(number, text, minutes, page, done, seconds spent). Detection reads the PDF text layer for lines starting with
Auftrag, Aufgabe, Task, Exercise or Übung (numbered, or followed by a colon), joins hyphenated line ends and reads time hints such as
"(ca. 20 Minuten)" or "1 Lektion". A re-scan keeps ticks, timers and manual edits.
The highlights overview reads the existing `fanotes-pdf-marks-v1` marks.

## Checks

- `npm run check:study-tools` parses, serialises, detects and lays out (no browser).
- `scripts/check-study-ui.mjs` is a Playwright smoke test against a web build (see its header).
