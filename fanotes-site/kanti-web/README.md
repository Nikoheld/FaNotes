# Kanti+ im Browser (schulnetz.fasrv.ch)

Kanti+ for laptops and desktops. The page is a static
single-page app (`kanti-web/`, Vite + React + TypeScript). It talks to one API on the same origin:
`/api/v1/kanti-web/`, served by `fanotes-site` (`kanti-web-api.mjs`) next to the app's own
`/api/v1/schulnetz/` routes. It reuses the server's Schulnetz runtime, so the browser shows exactly
the snapshot, change feed and alert settings the app uses. The browser parses nothing itself.

## Why the browser borrows a connection

A browser page cannot run the school sign-in the way the app does. AKSA rejects the mobile OAuth
redirect (see commit `5fc3efa0`). The app's WebView therefore keeps the Microsoft sign-in cookies
and hands them to the server. A web page on another origin can never read those cookies. TAM is
read on the phone only. So the browser borrows a connection the app already has, in one of two
ways:

1. **Pair with the app.** The browser shows an 8-character code. In Kanti+, open
   *Einstellungen → Kanti+ im Browser*, enter the code and pick the connections to share. The
   browser can then read exactly those connections. This covers anonymous connections, several
   Schulnetz connections and TAM. For TAM, the app uploads the TAM snapshot it reads anyway, so
   the browser can show it.
2. **Kanti+ / FaNotes account.** Email and password, derived in the browser exactly as in the apps
   (PBKDF2-SHA256, 512 bits; only the second half goes to the server as the auth key). The
   password never leaves the browser. This shows the school connection stored on that account.

There is also a **demo** with synthetic data. It needs no account and sends nothing.

## Own data from the account's vault (sign-in with the FaNotes password only)

A browser signed in with a FaNotes account can also open that account's vault, end to end encrypted
exactly like the apps do it. A browser paired by code has no password, so it shows a short hint instead.

- At sign-in the PBKDF2 output is split as in `fanotes/src/lib/sync/crypto.ts` (`deriveFromPassword`): the auth
  half goes to the server, the wrapping half stays. The page then calls `POST /api/v1/sync/login` on its own
  origin (device name `Kanti+ im Browser · <browser>`, platform `web`), unwraps the vault secret and derives the
  data and id keys with the same functions the desktop app uses (imported through the `@sync` alias, not copied).
- The password, the wrapping key and the raw vault secret never leave the page and are never stored. IndexedDB
  (`kanti-vault`) keeps only non-extractable `CryptoKey`s (data key, id key, and a key that seals the sync token),
  so a reload keeps access. Without IndexedDB the access lives in memory and the page asks for the password again
  after a reload ("Entsperren"). Sign-out calls the sync logout and deletes the database.
- Reads go through the changes feed and `GET /files/<id>`; writes use the revision that was read as `If-Match`.
  A stale rejection re-reads the file, applies the same change to the fresh content and retries (at most 3 times).
  A newer remote version is never overwritten. The files keep the app's JSON shapes and paths
  (`.fanotes/schulnetz/*.json`, `Hausaufgaben.md`, `Kalender.md`; see `src/vault/files.ts`).
- The first connection of the account uses the original paths; every further connection of the app has its own
  slot (`.fanotes/schulnetz/connections/<slot>/`), which the app keeps in a device-local registry. The browser
  cannot know it, so Settings lets the user pick the slot for each further connection.
- nginx must proxy `/api/v1/sync/` (only the routes the page uses) to the same Node service; the CSP stays
  `connect-src 'self'`. Local development: `vite.config.ts` proxies `/api` to `KANTI_WEB_DEV_API`.
- Notizen (`/notizen`): the library tree, recently edited first, search over titles and text, and readers for
  markdown (own sanitising renderer: raw HTML stays text, only http(s)/mailto links), handwriting (`.famd`, ported
  from `public/viewer`), PDFs (pdf.js, its worker is a file of the site, so `script-src`/`worker-src 'self'` hold),
  images (data: URLs), audio and video (blob: URLs, needs `media-src 'self' blob:`) and stories (read only). Markdown
  text can be edited; the save only goes through when the file is still what the edit started from (otherwise
  nothing is written). Ink editing is not available in the browser.
- The build imports `fanotes/src/lib/sync/{crypto,api}.ts`: a deploy that stages only `fanotes-site` must stage
  that directory too.

## Security

- One session cookie: `__Host-kanti`, with `HttpOnly; Secure; SameSite=Strict; Path=/` and 30
  days idle (90 days at most). The server stores only its SHA-256. The browser never holds a
  Schulnetz cookie or an app identity token. A FaNotes-account sign-in additionally keeps a sync token sealed with a
  non-extractable key in IndexedDB (see above).
- CSRF: every state-changing request needs `Content-Type: application/json`, an `Origin` equal
  to the web origin, and `X-Kanti-CSRF` equal to the session's synchronizer token from
  `GET /session`.
- A FaNotes-based session ends when the account's password changes or the account is deleted.
  A paired connection disappears from the session when the app removes it, when the app's
  identity is deleted, or when the app revokes this browser.
- Pairing codes are 40 random bits, valid for 10 minutes and single-use. Only an authenticated
  app identity can redeem one, and failed lookups are rate-limited. The app shows the browser's
  description before the user approves.
- Read-only towards the schools: the browser never reaches Schulnetz or TAM. The server reads
  Schulnetz with the GET-only allow-list it already uses.
- nginx: TLS, HSTS, a strict CSP (`script-src 'self'`), no framing, and only
  `/api/v1/kanti-web/` and `/api/health` are proxied to Node.
- Logs carry no codes, tokens, emails or school data.

## Browser API (`/api/v1/kanti-web`, session cookie)

| Method and path | Purpose |
| --- | --- |
| `POST /prelogin {email}` | KDF parameters (same answer shape as sync prelogin) |
| `POST /login {email, authKey}` | Start (or extend) a session with the FaNotes connection |
| `POST /pair` | New pairing: `{code, expiresAt}`, sets the `__Host-kanti-pair` cookie |
| `GET /pair` | `{status: waiting\|approved\|expired, browser, added}`; on approval sets the session cookie |
| `DELETE /pair` | Cancel the pairing |
| `GET /session` | `{csrf, kind, browser, createdAt, expiresAt, connections[]}` |
| `POST /logout` | End this browser's session |
| `PATCH /connections/:id {label}` | Rename (this browser only) |
| `DELETE /connections/:id` | Remove from this browser (the app keeps it) |
| `GET /connections/:id/snapshot` | Full snapshot, all timetable weeks |
| `GET /connections/:id/status` | Link status and alert settings (shared with the app) |
| `PUT /connections/:id/settings` | Change alert settings (shared with the app) |
| `GET /connections/:id/changes?since=N` | Change feed for browser notifications |
| `GET /connections/:id/reveals` | Hidden grades `{guessGrades, hidden[]}` |
| `POST /connections/:id/reveal {ids}` | Reveal hidden grades (shared with the app) |

## App API additions (`/api/v1/schulnetz`, app identity as today)

| Method and path | Purpose |
| --- | --- |
| `GET /web-pair?code=XXXX-XXXX` | `{browser, expiresAt, added}` or 404 |
| `POST /web-pair {code, connectionId, label, provider, finish, unrevealed[]}` | Add this identity to the pairing; `finish: true` approves it |
| `GET /web-sessions` | `{sessions:[{id, browser, createdAt, lastSeenAt}]}` for this identity |
| `DELETE /web-sessions/:id` | Revoke that browser's access to this identity |
| `PUT /link {mode: "device", provider: "tam", baseUrl, deviceId}` | Device-read link: no secret, never polled, filled by `PUT /snapshot` |
| `GET /reveals`, `PUT /reveals {hidden[], revealed[]}` | Union-merged hidden-grade ledger |

`GET /status` also returns `settingsUpdatedAt` (set by every `PUT /settings`) and `webSessions`
(the number of browsers that read this identity).

## Build and deploy

```sh
cd fanotes-site/kanti-web && npm ci && npm test && npm run build   # -> dist/
```

The `dist/` folder is deployed to `/opt/fanotes-site/kanti-web/`. nginx serves it for
`schulnetz.fasrv.ch` (see `fanotes-site/deploy/schulnetz-fasrv.conf`, which also proxies the sync routes the
vault needs and sends the CSP with `media-src 'self' blob:`).

**Staging for a build outside the repository** (for example `git archive HEAD fanotes-site ... | tar -x -C <dir>`):
the build also reads `android/companion/docs/brand`, `android/companion/src/main/res/font` and, for the vault,
`fanotes/src/lib/sync` (`crypto.ts` and `api.ts`, imported through the `@sync` alias). Include all of them next
to `fanotes-site`, otherwise `npm run build` cannot resolve its imports.
