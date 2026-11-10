# Kanti+ im Browser (schulnetz.fasrv.ch)

Kanti+ for laptops and desktops. It holds only Kanti+, not FaNotes notes. The page is a static
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

## Security

- One session cookie: `__Host-kanti`, with `HttpOnly; Secure; SameSite=Strict; Path=/` and 30
  days idle (90 days at most). The server stores only its SHA-256. The browser never holds a
  Schulnetz cookie, a FaNotes token or an app identity token.
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
`schulnetz.fasrv.ch` (see `deploy/nginx/schulnetz-fasrv.conf`).
