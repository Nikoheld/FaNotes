# Diagnostic mode

Diagnostic mode is off until the user turns it on under Settings → Diagnostics. It is stored in the private `diagnostic-mode` preference. Another account cannot call the delivery routes: they use the same bearer as the other Schulnetz routes, and the body token must already be in that account's `fcmTokens`.

Local scenarios are a preview on that screen. They are built in memory, labelled Simulation, and are not written into the school snapshot, the widget cache, uploads, or the saved school cache. Choosing a scenario does not sign out, clear tokens, or run sync.

Remote scenarios use `POST /api/v1/schulnetz/push/probe`. The app does not post a local notification for them. Each batch carries one correlation id, `probe:` plus the digits of the server clock, and one `serverAt` on every row. The device stores receipt when the Firebase message arrives and display when the notice is shown.

## Scenarios

| Control | What it does |
|---|---|
| School preview | Simulated new grade without a mark, appointment, moved exam, cancelled exam, cancelled lesson, a lesson ten days ahead, a 23:30 Europe/Zurich time that stays on that day, and `23:30Z` which falls on the next Zurich day in winter. |
| States | Copy for empty, error, loading, offline, reconnect, expired session, and sync conflict. The real session stays signed in. |
| Malformed rows | Drops a blank id and an undated row, and keeps the first copy of a duplicate id. The input list is not rewritten. |
| Standard delivery | The six remote notices: new grade, changed grade, moved exam, cancelled exam, cancelled lesson, changed appointment. |
| Duplicate event | Appends the first notice again with the same id. The app drops the second one and can record `duplicate dropped`. |
| Out of order | Reverses the list. `serverAt` stays the same on every row, so the receipt clock still matches. |
| Alert switches | Local preview of the saved school-alert switches. Each real kind is marked on or off. It does not post a notice and does not write the snapshot. Changed and cancelled appointments are not listed, because the diff does not emit them. |

The alert preview reads the same switches as Settings → Notifications. Remote push, an open app, and the six-hour fallback use that decision before a notice is posted. A disabled kind is not shown and then cancelled. Delivery probes stay available when a school switch is off, so a delivery measurement is still possible. The Android notification permission is separate: a denied permission posts nothing and does not clear the switches. Hidden grades follow their own switch.

## Limits

- Firebase is not asked to hold a message. Delivery latency is the existing Server, Empfangen, and Angezeigt clocks. Foreground and background delivery use the same data message and the same filter. This repository cannot measure that path on a phone.
- Until `schulnetz-logic.mjs` and `schulnetz-api.mjs` from this change are deployed, the live poller does not know `enabled` or the fine switches. It still honours the older category booleans. A master switch that is off while those categories stay on does not stop server push until that deploy. The phone still filters before display. An older server that drops unknown settings keys behaves the same way.
- Turning alerts off does not stop the school snapshot. The poller and the phone still save it. The change list and the push are what get skipped.
- The local preview is not the live Heute, Planer, or Noten screen.
- Reset on the phone clears the local trace, the chosen scenario, the delivery-time list, and probe ids in the seen set. It then asks `POST /push/probe/clear` to delete `probe:` rows for this device only. The row stores a 32-character hash of the push token, not the token. A failure sets `failed` and the phone says the server step failed. Revision, snapshot, grade ledger, and notification baseline stay. A missing changes file removes nothing and is not a failure.
- Probe and clear each allow 5 calls per account per hour. The two counters are separate. The probe and clear responses include `probeRemaining` and `clearRemaining`. An unknown scenario uses a probe slot and returns 400.
- `GET /changes` returns a probe row only when the query `device` equals that row's hash. Polling and the fallback use the same filter, so another signed-in device does not show the test notices. A probe row written before this field existed is not returned.
- Send in 25 seconds schedules `ProbeDeliveryWorker` on the phone. The server does not sleep. The app can stay open, move to the background, or be removed from Recents before the worker runs. The worker does nothing when diagnostic mode is off or the school link or token is missing, and it does not retry after an error.
- The startup row is the time from process start to the first frame. It is not the process uptime read later. While diagnostic mode is on, a main-thread frame of at least 100 ms is recorded at most once every two seconds, together with one heap sample. The sample stores used megabytes and the rise since the previous sample. A rise is not a leak verdict. This repository cannot measure 60 Hz or 120 Hz, or frame time on a phone.
- The trace keeps 60 entries and records nothing while the mode is off. Tab samples are kept only at 32 ms or more, or on an error. Network samples are kept only for failures or calls of at least 500 ms. A sync conflict is recorded once per set of conflict paths, not on every later sync with the same copies. Entries store a category, a short name, a duration, and a result. They do not store passwords, tokens, note text, or raw school payloads.
- The export is shown before it is shared. Marks, bearer tokens, JWTs, email addresses, and `password=` / `token=` values are removed. Hidden grades and note bodies are not included.

## Safe use

1. Link the school, allow notifications, and open Kanti+ once on the network so the push token is registered.
2. Settings → Diagnostics → turn diagnostic mode on.
3. Use a local preview to read simulated rows, or one remote button to send a real delivery test. Leave Kanti+ open, background it, or remove it from Recents.
4. Read Zustellzeiten under Notifications. Each remote notice starts with Test and includes Datum DD.MM.YYYY.
5. Review the diagnostic report, then share it only if it looks right.
6. Stop and reset when finished. Diagnostic mode turns off. To remove it again later, open Diagnostics and use Stop and reset even if the switch is already off.
