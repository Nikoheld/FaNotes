# FaNotes document search

Branch `feature/doc-search` (worktree `/srv/agents/fanotes/chats/doc-search/repo`), based on
`origin/main` d2d36ac1. Not merged, not released, not installed.

## Ownership and handoff boundaries (recorded before any shared change)

| Area | Owner | What this branch does |
| --- | --- | --- |
| Document-search / OCR / indexing layer: `src/lib/docSearch/**`, `src/components/docSearch.css`, `scripts/check-doc-search.mjs`, `scripts/fixtures/doc-search/**`, this file | **This branch (FaNotes document search)** | Owns and implements. |
| Interoperability contract `fanotes-page-text-v1` (`.fanotes/page-text/`) | **This branch** | Defines, versions and writes it (below). Readers in other apps are their owners' work. |
| Kanti+ (`android/companion/**`), its phone index and Tesseract | Kanti+ Companion chat | Not touched. Kanti+ already reads `fanotes-pdf-ocr-v1`; it can add a reader for `fanotes-page-text-v1`. |
| Desktop PDF OCR sidecar `fanotes-pdf-ocr-v1` (`electron/pdf-ocr.cjs`, `src/lib/pdfOcr.ts`, `src/lib/pdfOcrRun.ts`) | FaNotes desktop | Reused, not changed. The background indexer writes OCR text into this existing sidecar through the existing `writePdfOcr` IPC, so an opened PDF and Kanti+ reuse it instead of recognising again. |
| PDF viewer and rendering (`PdfNoteView.tsx`, `pdfDocument.ts`, `pdfPagePainter.ts`, PDFium) | FaNotes 6 (PDF performance redesign) | **One additive hook only** in `PdfNoteView.tsx`: a subscription that scrolls to a page and opens the in-document search with the query. No rendering or layout code is changed. `enqueuePdfRender` is only called, on the low-priority `thumbnail` lane. |
| Desktop UI (`App.tsx`, `SearchPanel.tsx`, `types.ts`, `styles.css`) | Desktop UI redesign | Additive changes only: optional fields on `SearchHit`, merging index results into the existing search, opening a result at its page, a status line in the search panel. `styles.css` is not edited; new styles live in `src/components/docSearch.css`. |
| Electron main/preload (`electron/main.cjs`, `electron/preload.cjs`) | FaNotes desktop | Two new IPC channels for the page-text sidecar (read/write), modelled on the existing `readPdfOcr`/`writePdfOcr`. Nothing existing is changed. |
| Website (`fanotes-site/**`) | Website redesign chat | Not touched. |

If a shared file above has moved on when this branch is merged, the additive hunks are small and
listed in the commit messages; nothing in another owner's code is reverted or reformatted.

## What the feature does

The vault search (Notizen → Suchen, `Strg+Umschalt+F`) now also searches the **content** of every
document the vault shows, not only file names and note text, and tells you **where** a match is:

| Source | How it is read | Shown as |
| --- | --- | --- |
| Typed note text (`.md`, `.famd`) | as written, in chunks of 6,000 chars | „Notiz“ |
| Handwriting in notes | the stored `searchTranscript` (FaNotes' own background recognition) | „Handschrift-Abschrift“; opening scrolls to the line |
| PDF pages with a text layer | pdf.js text content, line ends kept (hyphenated words are joined) | „Seite N“ |
| Scanned / image-only PDF pages (< 20 chars of text) | local OCR: bundled TrOCR line model, orientation detected first | „Seite N · Texterkennung ~xx %“ |
| PDF annotations | the PDF note's `.famd` companion text | „Anmerkungen“ |
| Image worksheets (PNG/JPEG/WebP/GIF) | typed text boxes + local OCR of the image | „Arbeitsblatt N“ |
| PDF worksheets | typed text boxes only | „Arbeitsblatt N“ (limitation listed in the UI) |

Results show title, page, a snippet of ≤ 160 characters with the matched words highlighted, the OCR
confidence estimate, and „Gleicher Text auch in N weiteren Dateien“ when identical page text exists
in several files. Opening a PDF result opens the PDF **at that page** and starts the in-document search
with the matched word (as written on the page), which marks it on text-layer pages. On OCR pages the
page is shown but the exact spot is not marked (the line model gives no word positions).

The existing vault search (`window.fanotes.search`) still runs and its results are merged in for
anything the index has not covered (drawings, documents not read yet). Nothing it found before is
dropped.

### Matching and ranking

Identical rules to Kanti+ (`DocSearchText.kt`), so both apps find the same things:
case-insensitive; `ß` = `ss`; umlauts = base letter = `ae/oe/ue`; ligatures and diacritics folded;
punctuation is a space; a word hyphenated across a line break is joined; every query term must
appear (AND), each also as a word prefix (`bewegung` finds `Bewegungsenergie`, `ergie` finds
nothing). Up to 8 terms. Ranking: BM25-style term weight, exact word above prefix, title/path
matches boosted, text layer above OCR, OCR scaled by its confidence estimate.

### Languages

German and English text (Latin script) are folded and matched. OCR uses the bundled bilingual
handwriting TrOCR model for printed scans as well; it reads German and English. Other scripts are
indexed if a PDF has a text layer, but OCR will not read them.

## Indexing lifecycle

- **Where:** `src/lib/docSearch/` runs in the renderer (desktop and web share one implementation).
  The index lives in the app's own IndexedDB, one database per vault (`fanotes-doc-search-<sha256(platform, vault path)>`),
  never in the vault and never synced.
- **When:** at vault open (2.5 s after start), after every note save, tree change (import, rename,
  move, trash, sync) — debounced 1.5 s — and from the search panel (Erneut versuchen / Index neu aufbauen).
- **Incremental:** each document has a fingerprint (size + modification time of the file and its
  `.famd` companion) and an extractor version. Unchanged documents are not read again; a changed one
  is read from scratch (old text removed first); deleted, moved or trashed documents leave the index
  on the next pass. A rename keeps the shared sidecars with the document.
- **Bounded:** one document at a time, one page bitmap at a time (≤ 1400 px wide, ≤ 4 MP), at most
  8 OCR pages per document per pass (round robin, so one scanned book cannot starve the rest),
  batches of 4 text pages or 1 OCR page committed to IndexedDB (a closed window loses at most one batch;
  the next pass resumes at the committed page). PDFs over 96 MB or 2,000 pages are reported, not read.
- **Out of the way:** before every page, render and OCR step the indexer waits while the user typed,
  clicked, scrolled or wrote with the pen in the last 1.5 s, then for an idle callback. OCR page
  preparation (turning, line finding, orientation) runs in a Web Worker; recognition runs in the existing
  TrOCR worker; PDF rendering for OCR uses the lowest-priority render lane, so a page the reader looks at
  always goes first.
- **Failures:** encrypted, damaged or too large files are „nicht lesbar“ until the file changes;
  transient errors retry with backoff (1 min doubling to 6 h). Pages without letters, failed OCR and
  skipped content are listed per document under „Hinweise“ in the search panel, never hidden.
- **No duplicates:** one pass at a time; extra triggers coalesce into one more pass; units have
  stable ids per document and page.

## Interoperability contract `fanotes-page-text-v1`

FaNotes writes the per-page text of every indexed PDF next to the existing OCR sidecar so other
FaNotes clients can reuse it instead of running OCR again. **Version 1, owned by this branch.**

- **Location:** `.fanotes/page-text/<first 32 hex chars of SHA-256(UTF-8 vault-relative POSIX path)>.json`
  (the same naming as `.fanotes/pdf-ocr/`). Desktop writes it into the vault; FaNotes sync carries
  `.fanotes/` end-to-end encrypted to the same account's devices only. The web app keeps it in its
  local IndexedDB (not synced).
- **Identity:** a reader uses a record **only** if `path`, `size` (bytes) and `stamp` match the PDF it
  has. `stamp` is `pdfByteStamp` (FNV-1a over the length bytes and every ⌊length/4096⌋-th byte plus
  the last byte, 8 lowercase hex chars) — the same function Kanti+ already implements for
  `fanotes-pdf-ocr-v1`. Modification times are not compared.
- **Schema** (all fields required unless marked optional; unknown fields must be ignored; a record
  with any invalid field is ignored as a whole):

```json
{
  "format": "fanotes-page-text-v1",
  "path": "Biologie/Scan Blatt 3.pdf",
  "size": 130349,
  "stamp": "1f0c9a2e",
  "pageCount": 3,
  "producer": "fanotes-electron/2026.11.2 doc-search/1",
  "ocrEngine": "fanotes-trocr-v1",
  "createdAt": "2026-11-09T07:12:00.000Z",
  "pages": [
    { "page": 1, "source": "ocr", "status": "ok", "text": "Arbeitsblatt Fotosynthese\nPflanzen brauchen Licht …", "confidence": 0.95 },
    { "page": 3, "source": "text-layer", "status": "ok", "text": "Seite drei …" }
  ]
}
```

| Field | Rule |
| --- | --- |
| `path` | vault-relative POSIX path, no empty/`.`/`..` segments, no `\`, ≤ 4,096 chars |
| `size` | 1 … 100,663,296 (96 MB) |
| `pageCount` | 0 … 100,000; every `pages[].page` is 1 … `pageCount`, unique, sorted ascending |
| `pages` | ≤ 2,000 entries; pages may be missing (not read yet) |
| `pages[].source` | `text-layer` (the PDF's own text) or `ocr` |
| `pages[].status` | `ok`, `empty` (OCR found no letters), `failed`, `skipped`; v1 writers only emit `ok` |
| `pages[].text` | ≤ 6,000 chars, original spelling (not folded), line ends kept |
| `pages[].confidence` | optional, 0–1; for TrOCR an *estimate* (share of word-like tokens), not an engine score |
| `pages[].rotation` | optional, 0/90/180/270 |
| `pages[].reason` | optional, ≤ 120 chars |
| whole file | ≤ 4 MiB UTF-8 |

Reference reader/writer: `src/lib/docSearch/pageText.ts` (renderer) and `electron/page-text.cjs`
(main process, re-validates everything the renderer sends). A new incompatible layout gets a new
`format` string; readers must not guess.

### Handoff to the Kanti+ (Android) owner

Nothing in `android/` was changed. To use the contract, Kanti+ can add one reader next to its
existing `desktopPdfOcrPages` adapter in `DocSearchFormats.kt`:

1. Read `.fanotes/page-text/<sha256(path)[0:32]>.json` (same digest as the pdf-ocr sidecar).
2. Accept it only if `format == "fanotes-page-text-v1"`, `path` equals the document's path and
   `size`/`stamp` equal its own `pdfFileStamp`. Validate the fields as in the table above.
3. Use `ok` pages; prefer `text-layer` pages over its own OCR, and `ocr` pages when its own OCR
   is not available or weaker. Kanti+ never writes, migrates or deletes these files.

The folding rules above are already identical; `scripts/check-doc-search.mjs` asserts them.
Kanti+ stays fully usable without FaNotes, desktop pairing or a running server: the contract only
adds an optional input. No document crosses accounts: the files travel only through the user's own
end-to-end-encrypted FaNotes sync.

## Privacy and scope

- Only documents of the open vault are indexed; each vault has its own database, so two vaults never
  share an index. Dot folders (`.fanotes` data, history, trash, sync state, Schulnetz data) and dot files
  are never read. `Hausaufgaben.md` and `Kalender.md` at the vault root stay out of the content index
  (same rule as Kanti+, they can hold imported school data); the existing search still finds them as before.
- Everything runs locally. No new network use, no uploads, no paid service, no new dependency.
  The end-to-end test recorded **zero requests** leaving localhost, also offline.
- Originals, annotations and school data are only read. The only files FaNotes writes are the existing
  `.fanotes/pdf-ocr/` sidecar (through the existing IPC) and the new `.fanotes/page-text/` sidecar.

## OCR capability and limits (measured, not assumed)

Synthetic German pages, word recall = share of real words a search can find
(details: `docs/doc-search-ocr-eval-2026-11-09.json`, harness `scripts/fixtures/doc-search/eval-ocr.mjs`):

| Page | TrOCR desktop model | TrOCR web model | Host Tesseract 5 `deu` (comparison only) |
| --- | --- | --- | --- |
| clean sans / serif / small / 2° skew | 83–90 %, 3.9–6.8 s/page | 74–88 %, 3.2–3.5 s/page | 100 %, 0.5–1.3 s/page |
| noise + low contrast | 81 % (extra garbage lines) | 78 % | 95 % |
| turned 90° / 180° / 270° | 0 % without, **90 % with** orientation detection | — | 0 % (no OSD) |

Real misreads seen in the browser test: „Vulkane“ → „Volkane“, „Moränen“ → „Möränen“,
„Quer eingescannt“ → „Quereinges cannot“. So OCR finds most words, not all; the UI says so.

- **Handwriting:** scanned handwriting on PDFs goes through the same handwriting-trained model, but
  was not measured with real samples. Handwriting written in FaNotes is found only through its stored
  transcript (FaNotes' existing background recognition); its accuracy is that recognizer's.
- **Recommendation (needs approval, not done):** for printed scans Tesseract (`tessdata_fast` deu, the
  engine Kanti+ ships) was clearly better and 4–7× faster on this host. Adding it to desktop/web is a new
  dependency (tesseract.js + WASM + 1.5 MB model, or a native binary) and was therefore not added.
- Worksheet edits that do not save the owning note are picked up at the next save or by „Index neu
  aufbauen“ (worksheet JSON lives in `.fanotes/`, outside the tree the index watches).
- PDF worksheets: typed boxes only, no OCR. Encrypted PDFs: reported, not read (no password prompt
  in the background).
- The Tauri host (`crates/fanotes-host`) does not implement `read/write-page-text`; the renderer treats
  both as optional. `check-tauri-channel-parity.mjs` already failed on `origin/main` (pdf-ocr,
  handwriting-learning, share-open, convert-famd-notes missing) and now lists these two as well.

## Verification

`node scripts/check-doc-search.mjs` (from `fanotes/`): 22 checks — folding, origin maps, query
parsing, snippets, AND/prefix/umlaut search with page numbers, ranking, duplicates, title-only
results, handwriting line positions, persistence round trip, the contract (valid and 9 invalid
records), orientation detection on a real glyph bitmap for 0/90/180/270° without extra recognition
calls, and the indexer lifecycle: text/scan/mixed PDFs with reported OCR issues, unchanged documents
not re-read, edits replacing text, moves and deletes removing it from index and store, OCR budget with
resume (30 pages, each recognised exactly once), pause + simulated restart without lost or duplicated
pages, backoff and unsupported files, no concurrent passes, damaged-store rebuild, and 2,000 pages
(build ~0.6 s, query p50 ~12 ms / p95 ~27 ms in Node on the shared host).

Browser end-to-end (real web app from this branch, Vite dev server, Chromium 156, synthetic vault,
harness outside the repo, run phase by phase on one fresh profile): 43 of 44 checks passed across
setup, search, page navigation (page 250 of 300 visibly on screen with the word marked), reload,
offline, rename, delete, edit, full rebuild and OCR-while-typing. The one failure: a 1.65 s main-thread
task during setup, while the app itself imported and opened seven PDFs; during an isolated full rebuild
the longest task was 191 ms. Typing (Event Timing, keydown): warm baseline p50 24 ms / p95 48 ms;
during a full rebuild p50 24 / p95 40 ms; while a fresh 6-page dense scan was recognised p50 16 /
p95 24 ms (indexing yields while typing). 6 dense scanned pages became searchable 98 s after import in
the web app (WASM TrOCR, shared host). Query-to-results in the panel 14–186 ms. Renderer JS heap after
indexing 79 MB. The first keystrokes after a page load are slow without any indexing (p95 2.4 s, editor
warm-up) — that is not caused by this feature. Not tested: the Electron desktop
build (its IPC was syntax-checked and mirrors the existing pdf-ocr handlers), Firefox/Safari, real
scans or phone photos, real handwriting, the Tauri host.
