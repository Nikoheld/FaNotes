# Writing mode ("Schreiben") — design

Status: design, 2026-11-15. Owner: the writing-mode branch (`feature/writing-mode`).

A page-based editor for stories (short stories to 300+ page novels), in German and English, on desktop, web and Android, synced with the existing FaNotes sync. Not a canvas: real pages, like a word processor, with tools for fiction writers.

## 1. Decisions

| Question | Decision | Why |
|---|---|---|
| Layout engine | **Own layout engine** (paragraph → lines → pages) in TypeScript, rendering positioned lines in the DOM; input through a hidden, IME-capable text sink. | Live pagination, widows/orphans, headers/footers, drop caps and two-page spreads need full control over line breaking. The same layout drives PDF export, so the export equals the screen. `contenteditable`/CodeMirror/ProseMirror flow text continuously and cannot split a paragraph across pages. |
| Android | **Same engine in a WebView** inside the native app (`WritingActivity`), with a Kotlin bridge to the vault, sync and stylus/keyboard. | One implementation of layout, autocorrect and export, identical page breaks on every device. A second native engine would take months and would paginate differently. |
| Storage | A project is a folder `Name.story/` in the vault: `story.json` (manifest), `scenes/<id>.json` (one file per scene), `bible/` (characters, places, timeline, notes), `snapshots/`. | Sync uploads only the scenes that changed; a 300-page novel is ~100 small files instead of one 2 MB file. Each file goes through the existing sync guards. |
| Paragraph-level sync | Every paragraph has a stable id, an order key and a version vector `{device: n}`. Two devices that edited the same scene are merged paragraph by paragraph in the sync engine (desktop/web `engine.ts`, Android `SyncEngine.kt`); paragraphs changed on both sides are both kept, marked for review. Deleted paragraphs leave a tombstone. | No conflict copy for the common case (different paragraphs), never a silent loss when both changed the same paragraph. |
| Deliberate cuts | The editor tells the sync engine when the user cut a scene on purpose (`markShrunk`), so the server's shrink guard does not treat a large edit as a failed load. Anything else stays guarded. | A writer deletes pages; a failed load must still never replace a scene. |
| Server | **No server change.** All new data is ordinary encrypted vault files. | The sync server never sees plaintext; nothing to deploy, nothing to roll back. An online grammar service is not used. |
| Autocorrect | Offline, bundled: Hunspell dictionaries already in FaNotes (`nspell`, `dictionary-de`, `dictionary-en`, `dictionary-en-gb`) for spelling and suggestions; a new rule engine for typography, grammar, punctuation and style in DE (incl. de-CH `ss`, « ») and EN; trigram language detection per paragraph; personal dictionary per project and global; thesaurus from OpenThesaurus (DE, LGPL) and WordNet (EN), loaded on demand. | Works offline, private, same on all platforms. |
| Fonts | Bundled OFL fonts (Literata, EB Garamond, Source Serif 4, Courier Prime, Inter) as TTF for layout and PDF embedding. | The same metrics everywhere; PDF export embeds exactly what is on screen. |
| PDF | `pdf-lib` + `@pdf-lib/fontkit` (MIT) writing each laid-out line at its position, fonts subset-embedded. | Export matches the on-screen pages, on every platform, without a print dialog. |
| DOCX / EPUB | Written with `jszip` (already a dependency): OOXML with styles, sections, headers/footers, page fields, footnotes, comments; EPUB 3 with one XHTML per chapter, nav and CSS. Import of DOCX (styles, emphasis, footnotes, breaks), Markdown and text. | No new heavy dependency; full control over styles. |
| Hyphenation | `hyphen` (ISC) with TeX patterns for de / de-CH / en-US / en-GB, used for justified text. | German justified prose needs hyphenation. |

## 2. Document model

```
story.json   { format: "fanotes-story-v1", id, title, author, language ("de" | "de-CH" | "en-US" | "en-GB"),
               page: { size: "A4"|"A5"|"Letter"|"pocket"|"manuscript"|custom, margins, mirror, header, footer,
                       pageNumbers, firstPageDifferent, startNumber },
               styles: { body, firstParagraph, heading1..3, chapterTitle, quote, dialogue, sceneBreak, poem, … },
               binder: [{ id, kind: "part"|"chapter"|"scene"|"folder", title, children, status, label, synopsis,
                          goal, include }],
               goals: { project, deadline, session, daily }, settings, dictionary: [words] }
scenes/<id>.json { format: "fanotes-story-scene-v1", id, paragraphs: [
                   { id, key /* order */, v: {device: n}, style, lang?, align?, runs: [{ text, marks }],
                     footnotes?, comments?, deleted? }] }
bible/characters/<id>.json, bible/places/<id>.json, bible/events/<id>.json   (one file per entry: no sync conflicts between entries; archived, never deleted)
progress/<writerId>.json          (per device; goals and streak sum over all devices)
snapshots/<sceneId>/<UTCstamp>-<writer>.json   (immutable, synced, so a version taken on the laptop is on the tablet)
```

Marks: bold, italic, underline, strike, small caps, superscript, subscript, font, size, colour, highlight, link, footnote ref, comment range, language. Paragraph styles are named and editable per project; direct formatting is allowed but styles come first.

## 3. Layout and editing

- Text is measured with canvas `measureText` on the bundled fonts (cached per font/size/word). Line breaking: greedy with hyphenation for left-aligned text, Knuth–Plass-lite (best of a few breakpoints) for justified text. Pages take lines until the content box is full; widows/orphans (2 lines), keep-with-next for headings, chapter starts on a new (optionally right-hand) page, drop caps take N lines.
- Incremental: a paragraph is re-laid out only when its text, style or the page width changes; pagination re-flows from the first changed page and stops when page starts line up again. Only pages near the viewport are in the DOM.
- Views: print layout (pages), draft (continuous, no page chrome), two-page spread, zoom 50–300 %, focus mode (one paragraph or sentence lit, the rest dimmed), typewriter scrolling.
- Input: a hidden `textarea` receives keys, IME composition, dictation and pasting; selection and caret are drawn by the engine; mouse/touch/stylus hit-testing maps to (paragraph, offset). Undo/redo is transactional (typing coalesced per word, formatting and structure as one step), per scene, kept for the session.
- Find & replace across the project with case, whole word, regex and style filters; replace all as one undo step.
- Counts: words, characters (with/without spaces), pages, paragraphs, reading time (DE 230 wpm, EN 250 wpm), per scene/chapter/project and selection.

## 4. Writing assistance

- **Typing autocorrect** (per language, can be undone with one Ctrl+Z / Backspace): quotes „…“ ‚…‘ (de), «…» ‹…› (de-CH, configurable), “…” ‘…’ (en); apostrophes ’; ` - ` → ` – ` (de) / `—` (en, configurable); `...` → `…`; capital after sentence end; two initial capitals; `ß` → `ss` for de-CH; personal replacement list.
- **Spelling**: Hunspell with the project dictionary (character names, invented words) and the user's global dictionary; suggestions ranked by edit distance and frequency; ignore once/always, add to dictionary.
- **Grammar and punctuation rules** (each with id, language, category, message in both languages, examples that are unit tests): DE das/dass, seit/seid, wider/wieder (context), comma before subordinate clauses (dass, weil, obwohl, damit, nachdem, …) and before "aber/sondern/doch", noun capitalisation after articles and prepositions, nominalised verbs ("das Laufen"), "z. B."/"d. h." spacing, doubled words, missing/extra spaces, quote punctuation; EN a/an, its/it's, your/you're, their/there/they're (context), could of → could have, i → I, then/than, comma splice hint, doubled words.
- **Style hints** (off by default per category, never auto-applied): repeated words within a window, filler words, long sentences, adverb density, passive voice (EN), readability (Flesch–Amstad for DE, Flesch for EN), dialogue tag variety.
- Language: per project, overridable per paragraph and per selection; automatic detection per paragraph when "Automatisch" is chosen.
- Shown as quiet underlines (spelling red, grammar blue, style dotted), details in a side panel; nothing interrupts typing.

## 5. Story tools

Binder (parts, chapters, scenes, folders; drag to reorder; status, labels, include-in-export), corkboard (index cards with synopsis and label colours), outline (table with POV, status, words, goal), character and place sheets (fields + free text + image, linked to scenes), timeline (story-time events linked to scenes), notes linked to scenes, project/session/daily goals with streak calendar, snapshots per scene with side-by-side compare and restore, split view (manuscript + a note, character sheet or second scene), themes paper / sepia / dark / high contrast.

## 6. Export and import

PDF (from the layout; selectable page format; bookmarks per chapter; fonts embedded), DOCX (Word styles, section per chapter, headers/footers, page number fields, footnotes, comments), EPUB 3 (chapters, nav, cover, metadata, CSS), Markdown, plain text, manuscript format (Courier Prime 12 pt, double spaced, header "Name / Title / page"). Import DOCX, Markdown, text into a new project or a scene. Tests compare exported PDF page breaks with the on-screen layout and round-trip DOCX/Markdown.

## 7. FaNotes integration

A `.story` folder shows as one document in the tree, library and recent list, opens in writing mode, and can be created from "Neu → Geschichte". Full-text search indexes scenes (doc-search units per scene with the scene as the hit). Conflict page previews scene versions as text. Autosave after every pause (≤ 1 s) and on blur/close; a crash keeps the last typed text in a local journal that is replayed on open.

## 8. Quality bar and verification

- Unit tests: model, merge (version vectors, tombstones), layout (line breaks, page breaks, widows/orphans, drop caps), every autocorrect/grammar rule with DE and EN cases, language detection, export writers (DOCX XML, EPUB structure, PDF text positions), import.
- UI tests (Playwright on the web build and the Electron build): typing, IME, selection, undo, styles, pagination while typing, find/replace, binder drag, export downloads.
- Sync tests: two devices editing different and same paragraphs of one scene, offline cuts, deliberate shrink, failed load, stale device; Android `SyncEngineTest` mirrors.
- Performance: a generated 320-page novel (95k words): open-to-first-page, full layout, keystroke-to-paint p50/p95 at the start, middle and end, scroll frame times; budget p95 keystroke < 16 ms, full layout < 1.5 s. Numbers go into this file.

## 9. Milestones

1. Core: model, storage, layout engine, page editor (desktop and web), styles, views, find/replace, counts, undo.
2. Writing assistance: autocorrect, spelling, grammar/style rules, language detection, dictionaries, thesaurus.
3. Story tools: binder, corkboard, outline, bible, timeline, goals, focus, snapshots, split view.
4. Export and import with fidelity tests.
5. Sync and integration: scene merge in both engines, deliberate cuts, tree/library/search/conflict preview.
6. Android: WebView host, vault/sync bridge, touch/stylus/keyboard.
7. Performance proof, full test pass, beta for testers (desktop GitHub pre-release; Android APK/AAB for Play internal testing).

## 10. Status

### Milestone 1 (core) — 2026-11-15
Done: model and storage (`src/writing/model`, `storage.ts`), layout engine (`layout/`), editing commands, undo and saving (`editor/`), page editor UI (`ui/`), desktop channels `fanotes:story-read|write|list|create` (only inside `.story` folders), browser-vault storage, tree entry and "Neue Geschichte", crash journal.
Features: page/spread/draft views, zoom 50–300 %, paper/sepia/night, focus mode, paragraph styles (12 built in, editable), fonts, sizes, B/I/U/S, super/subscript, small caps, colour, highlight, alignment, first-line indent, drop caps, bullet lists, hyphenation (de, en-US, en-GB), widows/orphans, keep-with-next, chapter starts (optionally right-hand), manual page breaks, new scene/chapter at the caret, headers/footers with fields, footnotes at the page bottom, comments, find & replace (case, whole word, regex), word/character counts and reading time, binder with rename, page setup.
Not yet: endnotes (planned as an export option), numbered lists, table of contents, style editor for new styles (only the built-in ones), binder drag and drop (milestone 3).

Measured (web build in headless Chromium on the shared server; real fonts):
- 608-page A5 novel (184 000 words, 32 chapters): opens in 1.0–1.2 s.
- Typing in it (event timing, key to next paint, after warm-up): p50 16–40 ms, p95 40–56 ms at the start, middle and end, on a shared server (load 5–12) in headless Chromium with software rendering. Per keystroke the engine re-lays out one paragraph (about 1 ms) and, incrementally, one page (0.1 ms); the rest is the browser painting.
- Node, fixed-width measurer: 674 pages laid out from scratch in about 260 ms; one keystroke 1.9 ms including flow and layout (1 page re-paginated). 120 random edits re-paginated incrementally give exactly the pages of a full pass.

Tests: `node scripts/check-writing.mjs` (24: keys, runs, repair, merge convergence, tombstones, flow, line breaking, hyphenation, lists, drop caps, caret geometry, pagination rules, footnotes, cache, editing commands, undo grouping, saving); `node scripts/check-writing-desktop.mjs` (real Electron under Xvfb: channels refuse paths outside `.story`, files on disk, tree entry, reopen, footnote and comment); browser end-to-end on the web build (15 checks incl. the 608-page latency run).

### Milestone 2 (writing assistance) — 2026-11-15

Offline, German and English, per paragraph (a paragraph's own language wins; otherwise it is detected from stopwords, umlauts and endings, and falls back to the story language).

- **Autocorrect while typing** (each correction is its own undo step; Backspace right after it gives back what was typed): typographic quotes per language („…“ ‚…‘, «…» ‹…› for Swiss German, “…” ‘…’, British ‘…’ “…”), apostrophes (it’s, geht’s), ellipsis, dashes from ` - ` and `--` (en dash with spaces; em dash closed up in US English), sentence capitals (not after abbreviations, ordinals, ellipses), `DIe` → `Die`, `i` → `I`, Swiss `ß` → `ss`, unambiguous typos through the app's spelling lexicon (`decideAutocorrect`), the writer's own replacements. Words in the story dictionary are never touched.
- **Checks** with underlines (red spelling, blue grammar/punctuation/typography, purple style), computed only for paragraphs on visible pages and cached per paragraph: spelling with suggestions; German das/dass, seit/seid, wider/wieder, als/wie after comparatives, nominalised verbs (`beim lesen`), lower-case nouns after articles, commas before subordinate clauses and `sondern`, `z. B.`, genitive apostrophe, unclosed quotes; English a/an (with sound exceptions), its/it’s, your/you’re, their/there, could of, then/than, `i`; both: straight quotes, `...`, spaced hyphen, double spaces, space before/missing after punctuation, repeated words (German `die die` after a comma is allowed), lower-case sentence starts.
- **Style hints** (off by default): filler words, nearby repetitions, long sentences, English passive; readability (Flesch–Amstad / Flesch) per scene.
- **UI**: click an underlined word (or right-click, or Shift+F7 for any word) for a pop-up with the explanation, suggestions, "add to story dictionary", "ignore", "turn this rule off", and synonyms (OpenThesaurus, LGPL, 48 160 German groups; WordNet 3.1, 53 060 English groups; loaded on first use). F7 opens the "Prüfen" panel: switches per check and per autocorrect feature, paragraph language, all findings of the current scene with one-click fixes, the story dictionary and ignored findings (both stored in `story.json`, so they sync).

Tests: `node scripts/check-writing-assist.mjs` (11 groups, ~150 assertions: every rule with sentences it must flag and sentences it must leave alone, autocorrect sequences typed character by character in four languages, checker cache/dictionary/ignore, thesaurus inflections); browser end-to-end on the web build (11 checks: autocorrect, Backspace undo, underlines, pop-up, dictionary, applying a comma, synonyms, panel, English paragraph); the M1 suites still pass (26 unit, 11 desktop, 15 browser; typing p95 in the 608-page novel 24–32 ms with the checker on).

### Milestone 3 (story tools) — 2026-11-15

- **Binder**: drag and drop (before/after/inside, with kind and cycle checks), a menu per node (rename, status, label colour, exclude from manuscript, move to trash). The trash is a binder folder: trashed scenes leave the manuscript and exports but their files stay and they can be dragged back. Excluded scenes stay out of the page view so the screen always equals the export; opening one explains how to include it again.
- **Areas** (toolbar): Manuskript, Pinnwand (index cards per chapter: title, synopsis, status, POV, words; drag to reorder), Übersicht (outline table with synopsis, POV, status, words, chapter and scene goals with progress), Figuren and Orte (sheets with role, aliases, colour, free fields, notes, and "appears in": scenes that name the entry, have it as POV or link it), Zeitleiste (events in story time with "when", linked scenes, characters and places, reorder), Ziele (project goal and deadline with words per day needed, today on all devices, this session, streak and longest streak, 16-week calendar).
- **Scene tab** in the inspector: title, synopsis, status, label, POV, characters and places, word goal, include in manuscript, linked FaNotes notes (search the vault), and versions.
- **Versions (snapshots)**: saved by hand, and automatically before a restore and before "Replace all"; side-by-side comparison with word-level changes; restoring is an ordinary, undoable edit of the scene (paragraph ids kept, newer paragraphs become tombstones), so it merges with other devices.
- **Split view**: a scene, a bible entry or a linked note next to the manuscript. **Typewriter mode** keeps the current line at a fixed height. **High-contrast** page theme. Bible names count as correctly spelled.

Tests: `node scripts/check-writing-tools.mjs` (7: binder moves/refusals, trash survives reload, link sanitizing, bible round trip and hostile input, mentions as whole words, progress per device and day, streaks, deadline maths, calendar, snapshot stamps, paragraph/word diff, restore merged with a concurrent edit from another device); browser end-to-end (14: binder drag reorders the manuscript, corkboard ↔ outline, character sheet finds both scenes, timeline, goals, version → edit → compare → restore → undo, split view, trash, everything still there after reload). Earlier suites unchanged: 26 unit, 11 assistance, 11 desktop, 15 + 11 browser; typing p95 in the 608-page novel 32–40 ms.
