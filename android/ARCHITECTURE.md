# FaNotes Android client — formats and protocol

This note is the compatibility contract for the tablet app. The desktop and web clients remain the source of truth; the files cited below are what the Kotlin code was checked against. Do not invent a second vault format.

## Layout

| Piece | Path | Role |
| --- | --- | --- |
| JVM core | `android/core` | FAMD, ink, palm policy, vault files, sync crypto, sync engine. Unit-tested on the host JDK. |
| App | `android/app` | Jetpack Compose shell, stylus surface, SAF vault, OkHttp transport, foreground sync. |
| Desktop codec | `fanotes/src/lib/famd.ts`, `fanotes/electron/famd.cjs` | `fanotes-famd-v1` |
| Ink | `fanotes/src/components/DrawingBoard.tsx`, `inkStrokePaint.ts`, `inkSampleMap.ts`, `paperGrow.ts` | Stroke document and pointer rules |
| Sync | `fanotes/docs/SYNC.md`, `fanotes/src/lib/sync/*`, `fanotes-site/sync-api.mjs` | Account, crypto, change feed |

## Vault files

A note is a pair of files that share a stem:

- `Name.md` — Markdown body, including the ink marker when the note has ink. The body ends with a newline.
- `Name.famd` — the same Markdown, then the companion payload described below.
- PDF notes keep the original PDF bytes at `Name.pdf`. Markdown and ink live only in `Name.famd`.
- Ink is also written to `.fanotes/assets/<ink-id>.json`, which is the same JSON object stored in `payload.ink`. A PNG preview is optional and not required to round-trip.

The ink marker is `<!-- fanotes-ink:ID -->`. `ID` matches `^[a-zA-Z0-9_-]{1,96}$` (UUIDs are valid). `attachNoteInk` adds it once.

Image worksheets follow the desktop layout:

- bytes at `.fanotes/worksheets/<id>.<ext>`
- record at `.fanotes/worksheets/<id>.json` (`schemaVersion` 1, `kind` `image`, `sourceRelativePath`, `dataRelativePath`, `textBoxes`, `highlights`)
- Markdown marker `<!-- fanotes-worksheet:ID -->`

Empty folders are not a sync concept. A folder exists because a note inside it exists. `.keep` is a dotfile and is not uploaded.

## `fanotes-famd-v1`

The file is the Markdown body, then a marker, then exactly N UTF-16 code units of JSON:

```text
<markdown>

<!-- fanotes-famd:v1 chars=N -->
<json of length N>
```

`chars` is a JavaScript string length. On the JVM that is `String.length` (UTF-16 code units), not UTF-8 bytes. The parser uses the last marker, rejects a length that runs past the file, and requires `"schema": "fanotes-famd-v1"`.

Serialization writes keys in this order: `schema`, `updatedAt`, `ink`, `worksheets`, then `paperStyle` when it is one of `blank`, `dots`, `squares`, `grid`, `lines`, `millimeter`. `noteLinks`, `noteBackups`, and `pageStats` are copied through when present so an Android save does not drop desktop page statistics or links. Unknown top-level payload keys are not rewritten; the desktop codec itself only emits the keys above.

`updatedAt` is an ISO-8601 instant (`DateTimeFormatter.ISO_INSTANT`).

## Ink document

Stored as `payload.ink` and as the asset JSON. `schemaVersion` is 1. A new page starts at 900×1273 (`noteCanvas.ts`). Samples are 0–1 of `sourceWidth` × `sourceHeight`.

A handwriting stroke written by this client matches the desktop pen object:

`points`, `baseWidth`, `pressureEnabled`, `color`, `purpose: "handwriting"`, `brush` (default `fineliner`), `opacity` (default 1), `colorEffect` (default `solid`).

Each point is `x`, `y`, `t`, `pressure` (0–1), `tiltX`, `tiltY`, `pointerType` (`pen`, `touch`, or `mouse`). Width under pressure is the desktop formula: `baseWidth * (0.4 + max(0.08, pressure) * 1.12)` when pressure is enabled (`inkStrokePaint.ts`).

`overlayQuality` is 1.75 and `overlayQualityZoom` is 6, the same constants as `paperGrow.ts`. Fields this client does not edit (including `sections` from `docs/INK_SECTIONS.md`) stay in `extras` and are written back.

Growing the page uses the desktop margins: 108×144, the same step, caps at 20× width and 40× height. Existing strokes are rescaled so their page-pixel position does not move.

The corridor filter (`inkSampleMap.ts`) drops a sample that jumps more than 0.08 in y or 0.12 in normalized distance, and treats a slam back into the top band as a leap. Stylus samples are dense, so a real stroke is a chain of short segments. A one-point ghost near y≈0 can be replaced by the next in-band sample.

Undo stores the stroke list before a gesture. An eraser gesture is one undo step: the first sample that hits pushes the checkpoint, later samples in that gesture do not. The eraser splits a stroke at points inside the nib radius and keeps the remaining pieces.

## Pointers

`MotionEvent.TOOL_TYPE_STYLUS` writes. `TOOL_TYPE_ERASER`, or a stylus with `BUTTON_STYLUS_PRIMARY` / `BUTTON_STYLUS_SECONDARY`, erases. A mouse may ink so an emulator or a Bluetooth mouse still works. A finger never inks unless **Finger zeichnet** is on.

Palm rejection matches `inkPointerPolicy.ts`: while a stylus is down, and for 850 ms after it lifts, finger contacts are ignored for both ink and navigation. Outside that window, fingers scroll, pinch-zoom (0.5–4 around the centroid), long-press to select a stroke, and fling horizontally between notes when zoom is at most 1.15.

Android reports tilt as radians off the screen normal (`AXIS_TILT`) plus a direction (`AXIS_ORIENTATION`). Pointer Events, and therefore the stored stroke, use degrees:

```text
tiltX = sin(orientation) * degrees
tiltY = cos(orientation) * degrees
```

Hover paints a ring and is not committed. On API 34+, `MotionPredictor.predict(uptimeNanos)` draws one frame ahead and those points are not stored. Historical samples in the same `MotionEvent` are committed. The view asks for unbuffered pen dispatch and, on API 35+, a 120 Hz frame rate.

The page scale is `(view width − padding) / 900 * zoom`. Growing `sourceWidth` lengthens the page; it does not shrink existing ink.

## Sync

The protocol is `fanotes/docs/SYNC.md`. Origin `https://fanotes.fasrv.ch`, path `/api/v1/sync`. This client implements the same cryptographic construction and was checked against WebCrypto vectors (PBKDF2-SHA256, 600 000 iterations, HKDF-SHA256 with salt `fanotes-sync-v1`, AES-256-GCM, HMAC file ids).

```text
password (NFKC) + salt ──PBKDF2-SHA256 / 600000 / 512 bits──▶ 64 bytes
  first 32: wrapping key, AES-256-GCM, never sent
  last 32:  auth key, standard Base64, the only secret the server sees
vault secret (32 bytes) wrapped with the wrapping key, no additional data
vault secret ──HKDF──▶ data key (info "data") and id key (info "id")
file id = lowercase hex HMAC-SHA256(id key, NFC path)
blob = 12-byte IV ‖ AES-GCM(plaintext), AAD = file id as UTF-8, 128-bit tag
```

`X-FaNotes-Meta` is Base64 of the encrypted JSON `{"path","mtimeMs","size","sha256"}` in that key order. `X-FaNotes-Sha256` is the hex SHA-256 of the ciphertext. `meta.sha256` is the plaintext hash. `If-Match` is the file's current revision, or 0 for a new file. A mismatch is HTTP 409. The changes page is 500 entries; `nextSince` is the last entry's revision, or the table revision when the page is empty.

The cursor advances with `max(cursor, min(since, holdCursor))`. A path that is busy (the open note, its `.famd`, and its asset JSON while the editor is dirty) is deferred and holds the cursor at `revision - 1`, so a remote edit cannot pass a note that has not been saved yet.

Local changes debounce for 2.5 s. A signed-in client also syncs every 60 s, and 30 s after an offline failure. A foreground data-sync service registers for the default network and calls `syncNow` when connectivity returns. GET and prelogin retry once. Mutations do not. HTTP 401 signs out and keeps the local files. HTTP 507 is logged and that file is skipped.

Conflicts match the desktop rule: the server copy wins the original path, and the local bytes are kept as `<stem> (Konflikt <device> <YYYY-MM-DD HH-MM>).<ext>` in local time, then uploaded. Markdown can also be merged by keeping the remote text and appending local paragraphs that are not already present (`markdownConflict.ts`); the engine's default for a byte conflict is the conflict copy, which is the same outcome as the desktop cycle.

The desktop engine transfers up to 3 files at once. This client transfers sequentially inside a cycle. That is slower and still protocol-correct: `If-Match` and the cursor do not depend on parallel workers. The engine thread is single-threaded so the file table is not mutated from two coroutines.

Secrets (`v`, `accountId`, `deviceId`, `token`, `expiresAt`, `email`, `vaultSecret`) are sealed with an Android Keystore AES-GCM key (`fanotes-sync`) and are not written into the vault. Per-vault state (`version`, `accountId`, `cursor`, `lastSyncAt`, `files`, `conflicts`) lives under the app's files directory, keyed by a hash of the vault path or tree URI.

Skip rules match the desktop: dot paths other than `.fanotes/` children, `.fanotes/history` unless history is included, `onboarding.json`, `tree-cache`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `*.tmp`, `.~lock.*`, `~$*`, the recognition model unless opted in, excluded prefixes, and files over 100 MB.

## Recognition, math, sections

GlyphenWerk is a Rust/WASM engine in the desktop build. It is not linked into this APK. `HandwritingRecognizer` is the seam: a later NDK build can implement it without changing the stroke JSON. Sections, math, and worksheet text boxes are preserved when they already exist in the JSON; this version does not edit them.

## Decisions that are easy to trip over

- Fingers navigate and the pen writes. That is stricter than a desktop setting that allows finger drawing, and it is the right default on a tablet with an S-Pen.
- The first vault is the app-private `filesDir/vault`, so the app works before the user picks a folder. **Vault-Ordner öffnen** uses the Storage Access Framework and persists the tree permission.
- Autosave waits 750 ms, flushes when the activity pauses, and will not let an older in-flight save replace a newer stroke.
- PDF pages are stacked at column width 900 with a 16px gap, matching `.pdf-note-page`. A new PDF note adopts that stack height. An existing ink document scales the stack into the stored `sourceHeight` so y fractions stay put. Rendering stops at 40 pages.
- Samsung-specific S-Pen APIs are not required. Pressure, tilt, orientation, eraser, hover, and the barrel button come from `MotionEvent`.
