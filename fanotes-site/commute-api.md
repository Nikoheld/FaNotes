# Pendelstrecken (commute routes) — API contract

Server: `fanotes-site/commute.mjs` (logic + provider + runtime), wired into the app API
(`/api/v1/schulnetz/commute…`, same auth as `/settings`) and the browser API
(`/api/v1/kanti-web/connections/:id/commute…`, session + CSRF like the other connection routes).
Routes are stored per Kanti+ identity on our server only (`accounts/<id>/commute.json`). They are
never sent to Schulnetz. Timetable data comes from the search.ch timetable API (no key; daily
budget 1000 route + 10080 board queries, shared and cached), transport.opendata.ch as fallback.

All times are ISO 8601 with offset (`2026-11-13T07:05:00+01:00`). Minutes are integers.

## Types

```ts
Stop = { id: string; name: string; type: 'train' | 'bus' | 'tram' | 'ship' | 'cableway' | 'other' }

Schedule = {
  mode: 'none' | 'times' | 'firstLesson' | 'lastLesson'
  times: string[]          // 'HH:MM' departure times, mode 'times' only (max 6)
  days: number[]           // 1 = Monday … 7 = Sunday; default [1,2,3,4,5]
  bufferMinutes: number    // firstLesson: arrive this many minutes early (0–60, default 10).
                           // lastLesson: WALKING TIME from school to the first stop (default 5 when missing; the apps offer 0–30):
                           // the target is the real end of the last held lesson + this. Stored values stay.
}

Route = {
  id: string               // 12 hex chars, made by the client
  name: string             // e.g. 'Schule', max 40 chars; '' → client shows "from → to"
  from: Stop; to: Stop
  vias: Stop[]             // 0–2 ordered via stops (search.ch via[] in order), kept exactly as entered: order, duplicates and vias equal to
                           // the origin or destination stay (loop routes, e.g. Brugg → Aarau via Aarau, Lenzburg). Only invalid stops are dropped.
  via: Stop | null         // = vias[0], read-only compatibility for clients older than two vias.
                           // PUT: `vias` wins; a body with only `via` (old client) is read as [via].
  schedule: Schedule
  pins: Pin[]              // the fixed connection(s) Fabio always takes; [] = no fixed connection
  delayThreshold: number | null   // minutes; null → settings.delayThreshold
  notify: boolean                  // alerts for this route
}

Pin = {                    // a fixed connection; copy Trip.pin and add the days
  days: number[]           // weekdays it is used (1 = Mon … 7 = Sun); disjoint across one route's pins,
                           // a later pin loses days an earlier one has. One pin for all days = days [1..5].
  line: string             // first ride leg's line, 'IR 16' / 'S 29' / '366'
  trainNo: string          // first ride leg's train or journey number ('' if unknown)
  stop: string; stopId: string   // boarding stop of the first ride leg
  departure: 'HH:MM'       // planned departure of the first ride leg
  arrival: 'HH:MM'         // planned arrival (display, and how long the target stays current)
  transfers: number        // display
}
// A route with pins is planned around them: on a weekday with a pin the target is that connection
// (Target.kind 'pinned'); weekdays without a pin are skipped. schedule.mode still matters for
// lesson-tied routes: days with all lessons cancelled are skipped, and a lesson change is reported
// (Target.lessonChange + changeAt) with RouteBoard.change as the suggested other trip.

CommuteSettings = {
  delayThreshold: number          // 2 | 3 | 5 | 10 (any 1–30 accepted), default 3
  hiddenLabels: string[]          // labels of lessons the user hid (HiddenLesson rules), lower-case eventLabel();
                                  // the client keeps this current. Max 200. Half-class choices are gone: a file
                                  // stored before version 2 reads with hiddenLabels [] until the client sends them.
}

Occupancy = { first: 1 | 2 | 3 | null; second: 1 | 2 | 3 | null }   // 1 low, 2 medium, 3 high, null unknown

Point = { name: string; stopId: string; time: string; planned: string; delay: number | null;
          platform: string; platformChanged: boolean }

Leg = {
  kind: 'ride' | 'walk'
  line: string             // 'S29', 'IR16', '366'; '' for walks
  category: string         // 'S', 'IR', 'B', …
  type: Stop['type']
  operator: string; direction: string
  fgColor: string; bgColor: string   // hex without '#', may be ''
  from: Point; to: Point
  occupancy: Occupancy
  cancelled: boolean
  notes: string[]          // disruption texts for this leg
  minutes: number          // running or walking time
  journeyId: string        // search.ch trip id of this vehicle ('' for walks / fallback provider)
  stopCount: number        // boards: number of intermediate stops (the stop list itself is only in /commute/trip)
  stops?: Stop[]           // /commute/trip only: intermediate stops in order (boarding and exit stop are from/to)
}

Stop = {                   // one intermediate stop of a ride leg (connection detail)
  name: string; stopId: string
  arrival: StopTime | null; departure: StopTime | null
  platform: string; platformChanged: boolean    // '' when no source has it (search.ch has none per stop)
  realtime: boolean        // false: no real-time data for this stop → show planned times only, marked
  cancelled: boolean       // the vehicle does not call here (search.ch 'X')
  occupancy: Occupancy     // forecast at this stop (search.ch), often null
}
StopTime = { planned: string; time: string; delay: number | null }   // delay null = no real-time value

Position = {               // where the trip is now (from real times; planned where a stop has none)
  state: 'notStarted' | 'atStop' | 'between' | 'transfer' | 'arrived'
  legIndex: number         // index into trip.legs (a ride leg)
  point: number            // 0 = leg.from, 1..n = leg.stops[point-1], n+1 = leg.to
                           // atStop: at that point; between: after `point`, before `point + 1`; transfer: left leg `legIndex` at its last point
  progress: number         // between: 0–1 of the way to the next point
  estimated: boolean       // a time it relies on has no real-time value
}

Transfer = {
  at: string               // the stop where the next ride leaves
  minutes: number          // gap minus footpath (older apps): the time beyond the walk
  plannedMinutes: number   // the same with planned times
  broken: boolean          // "Anschluss verpasst": shortfall > 2 min, a negative gap, or the next ride is cancelled
  tight: boolean           // "Anschluss gefährdet": below the official minimum by 1–2 min, still possible with a quick change
  gapMinutes: number       // next ride's departure − arrival (real times where known, else planned)
  plannedGapMinutes: number
  walkMinutes: number      // footpath minutes of the walk legs between the two rides (0 when none)
  requiredMinutes: number | null   // the official minimum change time; null when unknown (never guessed)
  requiredSource: 'timetable' | 'planned' | 'default' | 'unknown'
}
// Rule per change: required = footpath (walk legs, normal_time ?? runningtime) or the leaving ride's
// `normal_time` (Leg.changeMinutes, seconds → minutes; absent on a first leg). If plannedGap < required the
// timetable itself plans a shorter change: required = max(0, plannedGap), source 'planned'. shortfall = required − gap:
// ≤ 0 ok; 0 < shortfall ≤ 2 (TRANSFER_GRACE_MIN) and gap ≥ 0 tight; otherwise broken. Unknown minimum: only gap < 0 is broken.
// Chained trips (see Vias) use CHAIN_TRANSFER_MIN = 4 as a default ('default'). transport.opendata.ch has no
// normal_time: the footpath of a walk section, otherwise unknown. Push alerts: broken and cancelled push, tight does not.

Trip = {
  id: string               // stable for the same vehicles: first ride's line + planned departure + last arrival
  departure: string; arrival: string; plannedDeparture: string; plannedArrival: string
  depDelay: number | null; arrDelay: number | null
  minutes: number; transfers: number
  status: 'ok' | 'delayed' | 'cancelled' | 'broken'
  legs: Leg[]; changes: Transfer[]
  occupancy: Occupancy     // worst (highest) level over the ride legs, per class
  issues: { kind: 'cancelled' | 'missedTransfer' | 'platformChange' | 'delay' | 'disruption'; text: string }[]
  pin: Omit<Pin, 'days'> | null   // what to store to pin this trip (null for a walk-only trip)
  quietest: boolean        // least crowded (2nd class, then 1st) among the trips of this answer that are not worse by >10 min arrival
}

Target = {
  kind: 'now' | 'time' | 'firstLesson' | 'lastLesson' | 'pinned'
  at: string                // the moment the trips are planned around
  timeType: 'depart' | 'arrive'
  lesson: { start: string; end: string; label: string } | null   // the lesson it is tied to
  lessonChange: 'none' | 'lastCancelled' | 'firstCancelled'      // school ends earlier / starts later than planned
  plannedAt: string | null  // the moment before the change (for "statt 16:15")
  // kind 'pinned' only:
  pin?: Pin; day?: 'YYYY-MM-DD'          // the pin that applies and its travel day; `at` = its planned departure
  changeAt?: string | null; changeTimeType?: 'depart' | 'arrive' | null   // lesson change: the earlier/later moment
}

PinnedState = {
  status: 'ok'        // found as pinned
        | 'moved'     // same train number within 15 min (no numbers: same line within 3 min), a timetable change; show "neu HH:MM"
        | 'missing'   // not in the timetable that day: tell the user, offer `nearest`, let them re-pick
        | 'gone'      // seen earlier today, now gone: treated as cancelled (trip has status 'cancelled')
  day: string; pin: Pin
  trip: Trip | null         // the pinned connection live (also trips[0]); null when missing
  nearest: Trip | null      // missing only: the trip leaving closest to the pinned time
}

RouteBoard = {
  routeId: string
  target: Target
  trips: Trip[]             // up to 4 next usable trips for the target, best first
  alternatives: Trip[]      // when trips[0] is cancelled/broken: the next best trips (via kept if possible)
  viaDropped: boolean       // alternatives had to leave out the via stops
                            // lastLesson before lesson end + walking time: trips leaving earlier are not listed (unreachable from school)
  pinned: PinnedState | null    // pinned routes only; the UI focuses on pinned.trip, `trips` minus it = "andere Verbindungen"
  change: Trip | null       // pinned + lesson change: the earlier way home / later way to school
  updatedAt: string
  stale: boolean            // provider unavailable; data is the last good answer
}

Provider = { name: 'search.ch' | 'transport.opendata.ch'; occupancy: 'train-class'; formation: false }
```

## Endpoints (app prefix `/api/v1/schulnetz`, browser prefix `/api/v1/kanti-web/connections/:id`)

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET | `/commute` | – | `{ routes: Route[], settings: CommuteSettings, provider: Provider }` |
| PUT | `/commute` | `{ routes, settings }` (max 8 routes; invalid fields are dropped or reset) | same as GET |
| GET | `/commute/stops` | `?q=Scherz` (≥ 2 chars) | `{ stops: Stop[] }` (max 10, small bus stops included) |
| GET | `/commute/board` | `?route=<id>` optional | `{ boards: RouteBoard[], provider: Provider }` — live, for every route (or one) |
| GET | `/commute/connections` | `?from=<stop id or name>&to=…&via=…&via=…&at=<ISO>&timeType=depart\|arrive` | `{ trips: Trip[], stale }` — the connection picker (editor, works before saving): up to 8 trips from `at`, in planned departure order. Page with the last trip's plannedDeparture + 1 min. |
| GET | `/commute/trip` | `?route=<id>&trip=<Trip.id>&at=<Trip.plannedDeparture>` | `{ trip: Trip (with legs[].stops) \| null, position: Position, updatedAt, stale, gone, sources: { realtime: 'search.ch'\|'transport.opendata.ch', platforms: 'transport.opendata.ch'\|null, formation: null } }` — the connection detail. `gone: true` when the timetable no longer has that trip. Cached 30 s on the server; clients refresh every 30 s while the detail is visible (not in the background). Per-stop platforms and arrival forecasts come from transport.opendata.ch (own daily budget of 900 lookups; without it the stops show search.ch data only). Formation/sectors: no source without an opentransportdata.swiss key → always null. |
| GET | `/commute/trips` | `?route=<id>&at=<ISO>&timeType=depart\|arrive` | `{ trips: Trip[] }` — browse later/earlier |

`GET /commute/board` is what the app calls on open, on pull-to-refresh, and when a commute push
arrives (data push `event: 'commute'`), and what the widget shows. Answers are cached on the server
for 30 s per route; a client never needs to poll faster.

## Alerts (server-side, through the existing push path)

Category `commute`, target `commute`, `targetId` = route id, `date` = travel day. Titles (German, the
app localizes by title like the school alerts):
- `Verspätung` — first time a tracked trip's departure delay (first ride leg) or a transfer's delay
  reaches the threshold; again only if it grows by ≥ 5 more minutes. Body: `07:05 Bus 366 ab Scherz, Dorfplatz · +6 min · Gleis 4 → Aarau 07:41`.
- `Fällt aus` — a tracked trip or one of its legs is cancelled; body names the best alternative.
- `Anschluss verpasst` — a transfer breaks (delay > transfer time); body names the alternative.
- `Verbindung fehlt` — a pinned connection is not in the timetable on its day (from 75 min before it): names the nearest connection and asks to re-pick. Once per pin until it is found again (switch: cancelled).
- `Gleisänderung` — platform change of a tracked leg within 30 min of departure (fine switch shared with delay).
- `Früher nach Hause` — the last lesson(s) of a day are cancelled: `Letzte Stunde fällt aus – du kannst den Zug um 14:43 nehmen (S29 ab Aarau, an Scherz 15:20)`.
- `Später zur Schule` — the first lesson(s) are cancelled: later connection to school.

Notification preferences (in the existing settings object, `PUT /settings`): `commute` (parent),
`commuteDelay`, `commuteCancelled`, `commuteLessonEnd` (covers both lesson titles); default all true.
Dedup: one notice per (route, trip, kind[, delay step]); ids are stable, so an app and the server
never show the same alert twice.

A pinned route tracks only its pinned connection (no alerts about other trains); a pinned
connection that vanishes on its day after being seen is alerted as `Fällt aus`.
Tracked trip = the trip `/commute/board` would put first for a route's next target within its
travel window (from 75 minutes before departure until arrival). The server checks tracked trips
every 60 s in the last 20 minutes before departure, every 3 minutes before that, and once at
05:30 / when lessons change for the day's lesson-tied targets. Outside windows nothing is polled.

## Vias

The vias a client sends are stored and returned exactly as entered (up to 2; see `Route.vias`), so a
route Brugg → Aarau via Aarau and Lenzburg keeps both. The server passes them to search.ch as `via[]` in
order and, inside the provider (board, alternatives, pinned lookup, `/commute/trip`, `/commute/trips`,
`/commute/connections` and the background check), keeps only trips that pass the vias in order: the
trip's point sequence is its start, then every ride's boarding stop, intermediate stops and exit;
a via matches a point by stop id, else by case-insensitive name; vias must match at increasing indices
`0 < i1 < i2 < last`. If no trip survives (or the provider fails) and the vias contain a loop (a via equals
the start, the destination or the other via), the server chains segment searches from→via1, via1→via2,
via2→to (depart: each next segment leaves at or after the previous arrival + the minimum transfer time;
arrive: backward from the last segment) into one trip evaluated like any other (ids, pins, changes, status).
Each segment search counts against the route budget and is cached for 30 s. A route without a loop whose
trips the guard cannot verify keeps the provider's trips.

New leg field `changeMinutes: number | null` (official minimum change before this ride, or a walk leg's
footpath minutes). Chained trips set it to `CHAIN_TRANSFER_MIN` (4) on the first ride of each later
segment and `changeDefault: true`.
