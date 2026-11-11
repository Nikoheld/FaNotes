# Pendelstrecken (commute routes) in the Android app

Server contract: `fanotes-site/commute-api.md`. Routes, boards and alerts live on the Kanti+ server only; the app
never sends them to Schulnetz and never talks to a timetable provider itself.

## Pieces

| Where | What |
|---|---|
| `core/.../commute/CommuteModels.kt` | Types of the contract, lenient JSON reading, request body for `PUT /commute`. |
| `core/.../commute/CommuteLogic.kt` | Pure helpers: delay classes, minutes until, the route Heute shows now, hidden labels, widget rows. |
| `companion/.../SchulnetzClient.kt` | `commuteRaw`, `saveCommuteRaw`, `commuteStops`, `commuteBoardRaw`, `commuteTrips` (same identity headers as `/settings`). |
| `companion/.../CommuteStore.kt` | One store per graph: routes and boards as `StateFlow`, last answers in `filesDir/commute/`, all requests on IO. |
| `companion/.../CommuteScreens.kt`, `CommuteParts.kt`, `CommuteEditor.kt`, `CommutePages.kt` | Heute card, route detail, route list, editor with stop autocomplete. |
| `companion/.../CommuteWidget.kt` | Home-screen widget "Pendeln" (RemoteViews list), reads the files the store keeps. |

## Refresh policy (battery)

- Board on app open and resume when older than 30 s, on pull-to-refresh, on the silent `commute` data push.
- A 60 s timer runs only while a commute screen is resumed **and** the shown trip leaves within 30 minutes. Otherwise there is no timer.
- No background polling. The server pushes alerts (ordinary notices, category `commute`) and silent refresh pushes.
- The widget redraws from the files; its own update (`updatePeriodMillis`, 30 min) asks the server only when the saved boards are older than 5 minutes.
- An install that never linked a school and never added a route makes no commute request at all.

## Identity

Routes belong to the Kanti+ identity of the shown connection (`schoolAuth()`). Switching the shown connection clears the
local copy and loads the other identity's routes. When the identity changes silently (guest becomes a FaNotes account) and the
server has no routes for the new one, the saved local list is uploaded once.

## Hidden lessons

`settings.hiddenLabels` holds the lower-case labels of lessons the user does not attend, so lesson-tied targets skip them.
`commuteHiddenLabels` lists a label only when every lesson with that label is hidden (half-class choice or hide rule); a subject
hidden on one weekday only stays visible. It runs on `Dispatchers.Default`, debounced by 1.5 s, and is sent only when it changed and routes exist.
