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
  bufferMinutes: number    // firstLesson: arrive this early; lastLesson: leave this long after the end (0–60, default 10)
}

Route = {
  id: string               // 12 hex chars, made by the client
  name: string             // e.g. 'Schule', max 40 chars; '' → client shows "from → to"
  from: Stop; to: Stop; via: Stop | null
  schedule: Schedule
  delayThreshold: number | null   // minutes; null → settings.delayThreshold
  notify: boolean                  // alerts for this route
}

CommuteSettings = {
  delayThreshold: number          // 2 | 3 | 5 | 10 (any 1–30 accepted), default 3
  hiddenLabels: string[]          // lesson labels the user does not attend (half-class choices + hidden lessons),
                                  // lower-case eventLabel(); the client keeps this current. Max 200.
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
}

Transfer = { at: string; minutes: number; plannedMinutes: number; broken: boolean; tight: boolean }

Trip = {
  id: string               // stable for the same vehicles: first ride's line + planned departure + last arrival
  departure: string; arrival: string; plannedDeparture: string; plannedArrival: string
  depDelay: number | null; arrDelay: number | null
  minutes: number; transfers: number
  status: 'ok' | 'delayed' | 'cancelled' | 'broken'
  legs: Leg[]; changes: Transfer[]
  occupancy: Occupancy     // worst (highest) level over the ride legs, per class
  issues: { kind: 'cancelled' | 'missedTransfer' | 'platformChange' | 'delay' | 'disruption'; text: string }[]
  quietest: boolean        // least crowded (2nd class, then 1st) among the trips of this answer that are not worse by >10 min arrival
}

Target = {
  kind: 'now' | 'time' | 'firstLesson' | 'lastLesson'
  at: string                // the moment the trips are planned around
  timeType: 'depart' | 'arrive'
  lesson: { start: string; end: string; label: string } | null   // the lesson it is tied to
  lessonChange: 'none' | 'lastCancelled' | 'firstCancelled'      // school ends earlier / starts later than planned
  plannedAt: string | null  // the moment before the change (for "statt 16:15")
}

RouteBoard = {
  routeId: string
  target: Target
  trips: Trip[]             // up to 4 next usable trips for the target, best first
  alternatives: Trip[]      // when trips[0] is cancelled/broken: the next best trips (via kept if possible)
  viaDropped: boolean       // alternatives had to leave out the via stop
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
- `Gleisänderung` — platform change of a tracked leg within 30 min of departure (fine switch shared with delay).
- `Früher nach Hause` — the last lesson(s) of a day are cancelled: `Letzte Stunde fällt aus – du kannst den Zug um 14:43 nehmen (S29 ab Aarau, an Scherz 15:20)`.
- `Später zur Schule` — the first lesson(s) are cancelled: later connection to school.

Notification preferences (in the existing settings object, `PUT /settings`): `commute` (parent),
`commuteDelay`, `commuteCancelled`, `commuteLessonEnd` (covers both lesson titles); default all true.
Dedup: one notice per (route, trip, kind[, delay step]); ids are stable, so an app and the server
never show the same alert twice.

Tracked trip = the trip `/commute/board` would put first for a route's next target within its
travel window (from 75 minutes before departure until arrival). The server checks tracked trips
every 60 s in the last 20 minutes before departure, every 3 minutes before that, and once at
05:30 / when lessons change for the day's lesson-tied targets. Outside windows nothing is polled.
