# Statistik and opt-in diagnostics

Two separate things live in Settings: the **Statistik** page (local, read-only, nothing leaves the device) and the **Diagnose & Verbesserung** card (opt-in, off by default).

## 1. Statistik page

Settings, section "Statistik". Desktop and the web build (`StatisticsPage.tsx`, pure logic in `src/lib/vaultStats.mjs`, loader in `vaultStatsLoader.ts`); the Android tablet has the same page (`android/core`: `VaultStats.kt`, `VaultStatsLoader.kt`, mirroring `vaultStats.mjs`).

Shown:

- Vault: notes by kind, subjects with their folder colours, total size, largest, newest and recently changed notes.
- Activity heatmap: up to 53 weeks, from file modification times, page-stats active days and note history (Android also counts story progress).
- Streaks.
- Words: words in notes, words typed (page stats), words written in writing-mode stories (`progress/*.json`). Markdown syntax, comments, code blocks and the `.famd` payload do not count as words.
- Study time per weekday and per subject (existing local page stats). Android also shows strokes and pen time.
- Homework done/open/overdue and upcoming exams (Android reads `Hausaufgaben.md`; exams are recognised by words such as Klausur, Prüfung, exam, Test).
- Flashcards: due, reviewed, retention.
- Sync state, including the server usage the sync status reports.

Not shown, because the data does not exist: data uploaded (the sync engine does not expose it), and per-day app time (only per-note totals are kept; no new tracking was added).

How it is computed: in the renderer in small slices (four file reads in flight, yielding about every 10 ms), cached per file mtime and size, and aborted when the page is closed. A progress bar and skeletons show while it loads. On Android it runs on `Dispatchers.IO` with the same limits and is cancelled when the page is left. The charts are plain SVG/CSS with theme tokens, dark mode and aria labels. Everything is derived from the vault and local stats; no request is made.

Checks: `node fanotes/scripts/check-vault-stats.mjs`; Android `:core:test` (`VaultStatsTest`).

## 2. Opt-in diagnostics

Card "Diagnose & Verbesserung" in Settings. Code: `src/lib/diagnostics.mjs` (pure helpers), `src/lib/diagnosticsClient.ts`, server `fanotes-site/diagnostics-api.mjs`, report script `fanotes-site/scripts/diagnostics-report.mjs`. Android has a Kotlin port with the same schema (v1) and rules; desktop test vectors run in its JUnit tests.

### Controls

- Two toggles, both **off by default**: anonymous usage statistics, and logs. While a toggle is off nothing for it is counted or sent.
- "Vorschau" shows the exact JSON that would be sent.
- "Jetzt Logs senden": a manual report of the scrubbed recent errors plus an optional comment. This is the only place with free text.
- "Meine Daten löschen": deletes everything stored on the server for this install id, then renews the id.
- "ID erneuern": a new random install id without deleting server data.
- At most one automatic send per 24 hours.

### What is sent

The payload (`schemaVersion` 1, `kind` `daily` or `report`) holds:

- `installId`: 32 random hex characters, created on the device and kept in local storage. It is not derived from the user, device or vault.
- `app`: version, platform, architecture, UI language.
- With usage consent: feature counters (names like `tool.<name>`, `view.statistics`, `view.settings-<section>`; counts only), error counts by key, startup time rounded to 100 ms, and the vault size as buckets (note count and MB, for example 100, 250, 500), never the exact number.
- With logs consent: up to 60 entries of error class (from an allow-list), an optional uppercase code, up to three app-bundle `file:line` frames (bundle file names only) and a 12-hex hash for grouping.
- The comment of a manual report, scrubbed (max 1000 characters).

### What is not sent

Note content, titles, file names, vault paths, subject names, the user name, IP addresses in the payload, or error message text. Errors are reduced to class, code, bundle frames and a hash; the message is used only to compute the hash (digits and quoted parts are normalised first). The existing bug-report path is unchanged and separate.

### Scrubbing

`scrubText` runs on the client and is repeated on the server (the two copies are compared by a check). It URI-decodes, then replaces tokens and secrets, URLs, e-mail addresses, IPv4/IPv6 addresses, pairing codes, every quoted segment, absolute and relative paths (including the home and vault directory), file names with known extensions, long hex hashes and long mixed tokens, plus the user name and vault folder words, with placeholders such as `<url>`, `<path>`, `<name>`. It over-redacts on purpose.

### Server

`POST /api/v1/diagnostics` (64 KB cap; payload re-validated and re-scrubbed; 12 per install per day and 60 per IP per hour, answered with 429) and `DELETE /api/v1/diagnostics/<install id>`. Records are appended to one JSONL file per day in the data dir (mode 0600, writes serialised), with a 1 GB data-dir cap and 90-day retention. The server keeps no IP address in the record. Frames of the Android package `ch.fasrv.fanotes.*` are accepted only after the server version that includes PR #1211 is deployed; until then Android frames are dropped and nothing else changes.

Read the data with `node fanotes-site/scripts/diagnostics-report.mjs [--dir /var/lib/fanotes-diagnostics] [--days 30] [--json]`. It aggregates installs, versions, platforms, errors, feature usage, startup times and note-count buckets.

### Deploy (from PR #1203; an operator step, not done by merging)

1. Create `/var/lib/fanotes-diagnostics`, owned by the user of the site service.
2. Install the updated `fanotes-site/deploy/fanotes-site.service` (it sets `FANOTES_DIAGNOSTICS_DIR` and adds the `ReadWritePaths`) and run `systemctl daemon-reload`.
3. Install the new `location` for the endpoint and the `limit_req` zone from `fanotes-site/deploy/fanotes-fasrv.conf`, then `nginx -t` and reload nginx. The same change makes `$fanotes_client_ip` trust `CF-Connecting-IP` only from Cloudflare ranges: verify the list against cloudflare.com/ips.
4. Restart the site service.
5. Optional: `FANOTES_DIAGNOSTICS_MAX_BYTES` changes the 1 GB cap.

### Checks

`node fanotes/scripts/check-diagnostics.mjs`, `node --test fanotes-site/diagnostics.test.mjs`; Android `:core:test` (`DiagnosticsTest`).
