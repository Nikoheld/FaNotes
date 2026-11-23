# Send data ("Daten senden")

FaNotes sends anonymous diagnostic data so crashes, bugs and slow spots can be found and fixed. It is **on by
default** and can be switched off at any time in **Settings -> Daten senden** (English: "Send data"). Desktop
app only (Electron on Linux and Windows); the web build sends nothing automatically.

## Switches

One master switch and four categories. The master switch gates everything below it.

| Switch | Setting | What it covers |
| --- | --- | --- |
| Daten senden | `diagnosticsEnabled` | Master. Off: nothing is sent and the queue is deleted at once. |
| Absturzberichte | `diagnosticsCrashes` | Crashes of the main process, the renderer and helper processes. |
| Fehlerdiagnose | `diagnosticsLogs` | Errors shown in the app (class, code, code lines, hash). |
| Leistungsdaten | `diagnosticsPerf` | Startup time, pen latency percentiles, memory, freeze counts and durations. |
| Nutzungsstatistik | `diagnosticsUsage` | Feature counters, rough vault size, the anonymous launch counter. |

Turning anything off removes that category's queued data from memory and from disk
(`<userData>/diagnostics-queue.json`) immediately, and aborts a request that is in flight.

### Default on, and existing installs

`diagnosticsSettingsVersion` is `0` until a one-time migration (in `electron/diagnostics.cjs`,
`migrateDiagnosticsSettings`) switches every switch on and sets it to `1`. A fresh install and an update from
an older version both go through it exactly once. A later OFF choice has the version already set and is never
overwritten; a stale settings save cannot lower the version either (`keepDiagnosticsVersion`). After the
migration a one-time, non-blocking notice appears ("FaNotes sendet jetzt anonyme Diagnosedaten, um die App zu
verbessern") with the buttons "Ausschalten", "Einstellungen" and "OK" (`diagnosticsNoticeSeen`).

## What is sent

One JSON document, gzipped, `POST https://fanotes.fasrv.ch/api/v1/diagnostics` (schema 2, `kind: "batch"`):

- `installId`: 32 random hex characters, created on this device, not linked to a sync account, e-mail or
  device. Renewable in the settings ("ID erneuern"); "Meine Daten löschen" deletes the server copy and renews it.
- `app`: version, platform (`linux`/`windows`), architecture, UI language (two letters).
- `crashes` (Absturzberichte): for each distinct crash `type` (`uncaughtException`, `unhandledRejection`,
  `render-process-gone`, `child-process-gone`, `renderer-error`, `renderer-rejection`), `process` (main, renderer
  or the helper type such as GPU), error class from a fixed list, error code such as `ENOENT`, exit reason from a
  fixed list, exit code, up to four frames of the app's own code (`file`, `line`, function name), a 12 digit hash,
  a count and the last time (rounded to the minute).
- `logs` and `usage.errors` (Fehlerdiagnose): error class, code, up to four bundle lines (`index-AbCd1234.js:10`)
  and the hash. Never the message.
- `usage` (Nutzungsstatistik): counters named like `tool.pen`, `view.settings-open`; number of notes and vault
  size, each rounded down to a coarse step.
- `perf` (Leistungsdaten): startup time (median and maximum of the sessions since the last batch, rounded to
  50 ms), pen latency (sample count, median, 90th and 99th percentile, maximum, in ms, measured as event time
  stamp to handler time), memory (process count and working set in steps of 10 MB), `stalls` (main-thread tasks
  of 500 ms or more since the last batch: count, longest and 95th percentile in ms, a count per fixed phase word
  `sync`, `save`, `index`, `open`, `other` naming the background activity that was running, and the main
  process's event-loop delay maximum and 95th percentile). No names, paths, text, stacks or timestamps.

The in-app "Vorschau" shows the JSON of the next batch.

## What is never sent

Note content, titles, file names, folder names, vault paths, OCR text, handwriting/ink, user names, e-mail
addresses, tokens, keys, IP addresses (the application does not store them; the in-memory rate limiter keeps a
salted hash of the address that dies with the process), account IDs, exception message text.

How this is enforced:

- Exception messages are never part of a report. Reports carry class, code, frames and a hash. The hash is
  computed from class, code and frame positions, not from the message.
- Frames are cut down (`scrubStack`): only frames inside the app folder or `app.asar` stay, only the base name
  of the file stays (no directory, so no user name or vault path), function names must be plain identifiers. Node
  internals, add-on and vault scripts, and anything else are dropped.
- The renderer only describes events. The main process re-validates every field against fixed patterns and lists
  (counter names, error classes, hashes, bundle file names) before it queues anything.
- The server validates again and drops anything that does not match (`fanotes-site/diagnostics-api.mjs`).
- The free text of the explicit "Jetzt Logs senden" report goes through the shared scrubber
  (`scrubText`, identical in `src/lib/diagnostics.mjs` and the server; a check compares the two) that removes
  quotes, paths, URLs, e-mail addresses, IPs, tokens and the user and vault names. That report is sent only when
  the user clicks, even with every switch off.

The separate experimental "Send Data" channel (Settings -> Experimentell, off by default, Linux/Hyprland
debugging) is not part of this; it no longer includes note paths.

## When it is sent

- Batched: crashes, errors, counters and samples are collected locally and sent together, gzipped, at most once a
  day. A crash may trigger an earlier batch, at most once an hour, and then carries only the crash data.
- Only while the machine is idle (system idle for 30 s, or no focused FaNotes window) and online. A user who is
  never idle still gets the data sent after three days.
- No timers while idle: nothing runs periodically. A single short one-shot timer is armed only after an event
  has been recorded and something is due (about 20 s), and a 30 s write-behind timer after queue changes. Both
  are unref'd and never keep the process alive. Memory is sampled when a batch is built. Pen latency is sampled
  inside the existing 400 ms pen diagnostics sample, nothing is added to the input path.
- A failed send keeps the data and waits at least 30 minutes; a payload the server refuses (4xx other than 429)
  is dropped. The queue file is capped at 256 KB.
- Sending uses Electron's network stack from the main process; it never touches the UI thread.

## Server (`fanotes-site/diagnostics-api.mjs`)

- `POST /api/v1/diagnostics`: schema 1 (older apps: `daily`, `report`) and schema 2 (`batch`). Body limit 64 KB
  (compressed), gzip allowed (`Content-Encoding: gzip`) with a 192 KB inflate cap, other encodings get 415.
- Validation of every field, unknown fields are dropped; at most 12 payloads per install per day and 60 per
  address per hour (429); directory size cap (507); 90 days retention.
- Stored as one JSONL file per day without IP address, user agent or any request header.
- `DELETE /api/v1/diagnostics/<installId>`: removes everything stored for an ID.
- `node fanotes-site/scripts/diagnostics-report.mjs` summarizes crashes, errors, startup and pen latency.

## Checks

`npm run check:send-data` (scrubbing, migration, off switch, batching, idle/online rules, server compatibility),
`npm run check:diagnostics` (renderer client and shared scrubber) and
`node --test fanotes-site/diagnostics.test.mjs`.
