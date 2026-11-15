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
bible/characters/<id>.json, bible/places/<id>.json, bible/timeline.json, bible/notes/<id>.md
snapshots/<sceneId>/<iso>.json   (synced, so a version taken on the laptop is on the tablet)
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
