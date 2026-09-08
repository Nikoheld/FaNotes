# Add-on system (host side)

How FaNotes discovers, installs, runs and contains third-party add-ons. The add-on author's view (API, manifest, publishing) lives in the registry repository [Nikoheld/FaNotes-Addons](https://github.com/Nikoheld/FaNotes-Addons); this file is for people working on FaNotes itself.

## Moving parts

| Layer | File | Job |
| --- | --- | --- |
| Manifest | `src/lib/addons/manifest.ts` | Schema, permission catalogue with German labels and risk levels, categories, version compare. Pure; mirrored 1:1 by `scripts/lib/manifest.mjs` in the registry repo so CI and app agree. |
| Registry | `src/lib/addons/registry.ts` | Parses the source setting (`owner/repo#branch` or an `https://…/index.json` URL), fetches `index.json`, falls back to listing `addons/` via the GitHub contents API when the index is missing or empty. Builds raw-file URLs. `sha256Hex` for install verification. |
| Index cache | `src/lib/addons/indexCache.ts` | One subscribable copy of the index shared by the store modal, the auto-updater and the palette. Stale after 10 minutes. |
| Protocol | `src/lib/addons/protocol.ts` | Wire types host ↔ worker, `ADDON_METHOD_PERMISSIONS` (the only methods a worker may call and what each needs), `ADDON_EVENTS`, `ADDON_LIMITS`. |
| Worker SDK | `src/lib/addons/workerBootstrap.ts` | The code inside every worker, shipped as a string and spawned from a `blob:` URL. Builds the `fanotes` global, does promise-based RPC, runs activate/deactivate/command/event/panel handlers, mirrors `console.*` to the host log. |
| Runtime | `src/lib/addons/runtime.ts` | Host side. Owns workers, validates every call, enforces rate/timeouts/quotas, pings for liveness, counts errors, restarts, tracks contributions (commands, panels, status items) in a `useSyncExternalStore`-friendly state. Install/update/uninstall with checksum checks. |
| Blocks | `src/lib/addons/blocks.ts` | Normalises untrusted panel block trees into a bounded, typed shape. |
| App bridge | `src/lib/addons/appBridge.ts` | Shapes `App.tsx` getters/actions into the `AddonHostBridge` the runtime dispatches to. `safeSettingsView` is the allow-list of settings an add-on may read. |
| Storage port | `src/lib/addons/storagePort.ts`, `browserAddonsApi.ts` | Installed records, files and per-add-on data. Electron: `<userData>/addons/`. Web: `localStorage` with a same-origin proxy for GitHub URLs. |
| Electron | `electron/addons.cjs` | IPC: fetch from GitHub hosts only (allow-list, 2 MB, 20 s, 3 redirects), on-disk store, and `netFetch` for add-ons with the `network` permission (https only, private ranges blocked, cookies never forwarded, 5 MB). |
| UI | `src/components/addons/*` | `AddonStoreModal` (Entdecken / Installiert / Entwickeln), `AddonPanelDock` + `AddonBlocks`, `AddonPromptDialog`. All lazy-loaded and wrapped in `SafeBoundary` from `App.tsx`. |

## Lifecycle

```
install(entry)      fetch main.js → size ≤ 1.5 MB → sha256 == index → re-parse manifest → minAppVersion
                    → write files + record → activate if enabled
activate(id)        read main.js → sha256 == record.mainSha256 → spawn Worker(bootstrap blob)
                    → postMessage init{codeUrl, addon, context} → worker import()s code → 'ready'
                    → invoke 'activate' (15 s) → state 'running' → ping every 5 s
handleCall(msg)     rate check → method in table → permission in manifest → validate args
                    → dispatch to bridge → race 30 s → reply (structured clone)
recordError()       log; 8 errors / 60 s → terminate('crashed') + setEnabled(false)
pong missing 8 s    terminate('crashed') → maybeRestart (≤ 3, then disabled)
deactivate(id)      invoke 'deactivate' (3 s) → terminate → contributions removed, blob URLs revoked
```

`App.tsx` starts the runtime after first paint (`requestIdleCallback`), then checks the index for updates of store-installed add-ons when `settings.addonsAutoUpdate` is on.

## Isolation guarantees

- Workers have no DOM, no `fetch` (CSP: `worker-src 'self' blob:`, `connect-src` same-origin), no Node. Static `import`/`importScripts` fail; the registry CI also rejects them.
- The worker never receives host object references; everything is cloned.
- Permissions are checked against the installed manifest on the host; the worker-side `hasPermission` is informational only.
- Panel content is data, not markup. `AddonBlocks` renders it with FaNotes components; Markdown goes through the same renderer as notes.
- Toasts, dialogs and palette groups are prefixed with the add-on name so an add-on cannot impersonate FaNotes.
- `settings.read()` returns only `SAFE_SETTING_KEYS`. Adding a key there is a review-worthy change.
- `notes.write` is `.md`-only and goes through the open editor when the note is open (undo-able, autosaved, `.famd` payload preserved).
- Network: host must match `networkHosts`; the main process re-checks https/private ranges and strips credential headers.

## Events emitted by App.tsx

`note:opened`, `note:changed` (debounced 400 ms), `note:saved`, `note:created`, `note:deleted`, `ink:stroke`, `mode:changed`, `vault:changed`, `settings:changed`. `addonRuntime.emit` is a no-op when nothing subscribed, so the emit sites cost nothing without add-ons. Adding an event: extend `ADDON_EVENTS`, add the permission mapping in `runtime.ts` (`events.subscribe`), document it in the registry repo (`docs/EVENTS.md`, `sdk/fanotes-addon.d.ts`).

## Adding an API method

1. `protocol.ts`: add `'ns.method': '<permission>' | null` to `ADDON_METHOD_PERMISSIONS`.
2. `runtime.ts` → `dispatch`: validate args with `asPath`/`asText`/`asOptionalText`, call the bridge, return plain data.
3. `runtime.ts` → `AddonHostBridge` and `appBridge.ts`: implement against `AppAddonDeps`; extend `App.tsx`'s `addonDeps` if new app state is needed.
4. `workerBootstrap.ts`: add the name to the `api(namespace, [...])` list (or a hand-written wrapper like `net.fetch`).
5. Registry repo: `sdk/fanotes-addon.d.ts` and `docs/API.md`.
6. `scripts/check-addons.mjs`: add an assertion.

Keep methods coarse and data-shaped; never hand a worker a callback or a live object.

## Settings

`addonSource` (default `Nikoheld/FaNotes-Addons#main`) and `addonsAutoUpdate` (default on), both in `src/defaults.ts`, the Electron `SETTINGS_SCHEMA` and the Add-ons section of `SettingsModal.tsx`. Changing the source resets the index cache.

## Web build

The renderer CSP is same-origin, so `browserAddonsApi.ts` rewrites `raw.githubusercontent.com` / `api.github.com` URLs to `/addons-registry/…` and `/addons-api/…`. Vite proxies them in dev (`vite.config.ts`), nginx in production (`fanotes-site/deploy/fanotes-fasrv.conf`, under `/notes/`). `net.fetch` is unavailable on the web (`fanotes.app.web === true`).

## Checks

`npm run check:addons` (`scripts/check-addons.mjs`) covers manifest parsing, source parsing, index parsing and fallback, block normalisation, permission table completeness against the worker SDK, and the App wiring needles. `check:surfaces` lists the add-on surfaces in `docs/USER_SURFACES.md`.
