# Sync

Sync keeps a vault identical across devices through an account on `fanotes.fasrv.ch`. Every
file leaves the device encrypted; the server stores ciphertext under random-looking ids and
can neither read note contents nor file names. This document describes the design, the
guarantees and where the code lives. User-facing surfaces are listed in `USER_SURFACES.md`.

## Moving parts

| Piece | Location | Role |
| --- | --- | --- |
| Server | `fanotes-site/sync-api.mjs` | Accounts, sessions, encrypted blob store, change feed. Mounted by `server.mjs` under `/api/v1/sync`. |
| Crypto | `src/lib/sync/crypto.ts` | Key derivation, key wrapping, per-file AES-GCM, HMAC file ids. WebCrypto only. |
| API client | `src/lib/sync/api.ts` | Thin typed wrapper over the HTTP endpoints; resolves the origin per request. |
| Engine | `src/lib/sync/engine.ts` | Scan → pull → push cycle, conflict handling, cursors, an external store for React. |
| Host (desktop) | `electron/sync.cjs` + `preload.cjs` | Raw vault file access and `safeStorage`-encrypted secrets over IPC. |
| Host (web) | `src/lib/sync/browserSyncHost.ts` | Maps IndexedDB stores to a virtual file tree; secrets and state live in the `meta` store. |
| Host (Android) | `android/` | Native tablet client. Same account, crypto, and `/api/v1/sync` routes. The device platform token is `android`. |
| UI | `src/components/SyncSettingsSection.tsx`, `src/App.tsx` | Settings → Sync, status-bar item, palette commands, remote-change application. |
| Shares | `fanotes-site/user-shares.mjs`, `src/lib/sync/userShares.ts` | End-to-end encrypted shares to a username and the push channel (see "Accounts without e-mail" and "Shares between users"). |
| Check | `scripts/check-sync.mjs` (`npm run check:sync`) | Crypto unit tests, path rules, transport retry, and a three-device end-to-end run against the real server module. |
| Live co-editing | `fanotes-site/live-relay.mjs`, `src/lib/collab/` | Real-time text (Yjs), ink and presence for shared notes (see "Live co-editing"). |
| Check | `scripts/check-live-collab.mjs` (`npm run check:live-collab`), `fanotes-site/live-relay.test.mjs` | Two and three simulated devices against the real server: concurrent text and ink, presence, latency, idle silence, offline, permissions, ciphertext only. |
| Check | `scripts/check-account-share.mjs` (`npm run check:account-share`) | Username-only accounts, device-key sign-in, cloud sync off by default, username shares, push and revoke. |

## Keys

```
password + salt ──PBKDF2-SHA256 (600 000 rounds)──▶ 64 bytes
                                                     ├─ wrapping key (AES-256-GCM)  never leaves the device
                                                     └─ auth key                    the only secret the server sees
vault secret (32 random bytes) ──wrapped with the wrapping key──▶ stored on the server, opaque
vault secret ──HKDF-SHA256──▶ data key   AES-256-GCM for file contents and metadata
                           └─▶ id key     HMAC-SHA256 over the path = the file's server-side id
```

- **Register** (password account) creates the KDF salt, derives both halves, generates the vault secret, wraps it
  and sends `{ email, authKey, kdf, vaultKeyWrap }`. The server scrypt-hashes the auth key
  again before storing it, so a database leak yields neither the auth key nor the password.
- **Login** first calls `prelogin` for the account's KDF parameters, derives locally and sends
  the auth key. The response carries the wrapped vault secret, which only the wrapping key
  on the device can open. Unknown e-mail addresses get a deterministic fake salt (HMAC of
  the address) so the endpoint does not reveal which addresses have accounts.
- **Password change** re-derives, re-wraps the same vault secret under the new wrapping key
  and revokes every other device: they must sign in again. File blobs are not re-encrypted
  because the vault secret does not change.
- **Forgotten password** cannot be reset: without the password no key exists that unwraps
  the vault secret. The UI says so before an account is created.
- Every file blob is `12-byte IV ‖ AES-GCM(data key, plaintext, additional data = file id)`.
  Metadata (path, size, modification time) is encrypted the same way and travels in an
  `X-FaNotes-Meta` header. Contents are hashed (SHA-256 of plaintext) so devices can skip
  uploads and detect identical files without decrypting anything on the server.

Secrets on the device: the desktop stores the session token and the raw vault secret through
Electron `safeStorage` (OS keychain / DPAPI / libsecret) in the user-data directory; the web
build keeps them in the IndexedDB `meta` store of the vault database. Per-vault sync state
(cursor, known files with revision and hash) is stored next to them.

## What the server knows

Per account: username (optional on accounts made before usernames) and e-mail address (optional; either one signs in), the published sharing public key and its vault-secret-wrapped private half, scrypt hash of the auth key, KDF salt and
iteration count, the wrapped vault secret, device names and platforms, session token hashes
with timestamps, and a file table of `{ id, revision, size, sha256(plaintext), encrypted meta,
deleted, updatedAt, deviceId }`. Blobs live at `accounts/<id>/blobs/<fileId>`. File names,
folder structure and contents are never visible to the server; sizes and change times are.

Everything under `FANOTES_SYNC_DIR` (default `/var/lib/fanotes-sync`) belongs to `www-data`,
the systemd unit lists it as the only writable path besides the other data directories, and
nginx streams `/api/v1/sync/` bodies straight to Node with a 110 MB limit.

## Endpoints

All routes are under `/api/v1/sync`. Authenticated routes need `Authorization: Bearer <token>`
and `X-FaNotes-Account: <accountId>`.

| Route | Purpose |
| --- | --- |
| `POST /prelogin` | KDF parameters for a username or an address (fake but stable salt for unknown ones). |
| `POST /username` | Claim a username (accounts that have none) and publish the sharing key. |
| `POST /email` | Add or replace the optional e-mail; the current auth key is required. |
| `POST /userkey` | Publish the sharing key once for an account that has a username but no key. |
| `POST /register` | Create account + first device, returns session and revision 0. |
| `POST /login` | Verify auth key, create a device session, return the wrapped vault secret. |
| `GET /account` | Usage, quota, device list, session expiry. |
| `POST /logout` | Revoke the calling session and remove its device. |
| `DELETE /devices/:id` | Revoke another device's sessions. |
| `POST /password` | Rotate auth key and vault-secret wrap; revoke all other sessions. |
| `DELETE /account` | Remove the account and every blob (requires the auth key again). |
| `GET /changes?since=N` | Page of entries with revision > N (500 per page, `next` cursor). |
| `GET /files/:id` | Blob with `X-FaNotes-Revision`, `X-FaNotes-Meta`, `X-FaNotes-Sha256` headers; 204 for tombstones. |
| `PUT /files/:id` | Upload with `If-Match: <baseRevision>`; 409 with the current entry on a mismatch. |
| `DELETE /files/:id` | Tombstone with the same precondition. |

Limits: 100 MB per file, 4 GB and 50 000 files per account, 20 devices, sessions expire after
90 days without use. Rate limits per address and per account guard `prelogin`, `register`,
`login`, `password` and `delete`. All of them can be tuned through
`FANOTES_SYNC_MAX_FILE_BYTES`, `FANOTES_SYNC_QUOTA_BYTES` and `FANOTES_SYNC_MAX_FILES`.

## The sync cycle

The engine runs a cycle right after sign-in, 2.5 s after a local change is reported
(`syncEngine.notifyLocalChange()` from save and tree refresh), every 60 s while automatic
sync is on, when the window regains focus or comes back online, and on demand
(palette → "Jetzt synchronisieren", or the button in Settings → Sync).

1. **Pull.** Fetch `/changes` from the stored cursor. For each entry: look the id up in the
   local table; if unknown, download the blob to learn the path from its metadata. A remote
   change to a file that is currently open and dirty is *deferred* (the cursor is held back
   so it is retried next cycle) instead of overwriting unsaved work. A remote change that
   collides with a local change to the same path becomes a conflict copy (see below).
   Applied changes are written atomically (temp file + rename on desktop, single IndexedDB
   transaction on the web) and reported to the app, which refreshes the tree, reloads clean
   open tabs and closes tabs of removed files.
2. **Scan.** Walk the vault (up to 3 operations in parallel) and compare size + mtime with
   the last known state; hash the changed files.
3. **Push.** Upload changed files with `If-Match` on the revision the device last saw;
   delete remotely what disappeared locally. A 409 means someone else changed the same file
   in the meantime: the server's version wins the original path, the local bytes are kept
   as a conflict copy, and both end up on every device.

Skipped: the local history (`.fanotes/history`), the tablet trash (`.fanotes/trash`), tree cache, onboarding state, hidden files
other than `.fanotes/`, editor lock files (`.~lock.*`, `~$*`, `*.tmp`), `.DS_Store`,
`Thumbs.db`, `desktop.ini`, and anything above 100 MB (reported in the log).

Conflict copies are named `<name> (Konflikt <device> <YYYY-MM-DD HH-MM>).<ext>` next to the
original and are listed in Settings → Sync until dismissed.

## Failure behaviour

- A request that fails before any response is repeated once when repeating is side-effect
  free (all `GET`s and `prelogin`). Account creation, login, uploads, deletions and password
  changes are never repeated automatically so a lost response cannot become a duplicate.
- Network errors set the status to *offline* and retry after 30 s; server errors set
  *error* and retry with the regular interval. Both are visible in the status bar and the
  activity log.
- A 401 (revoked session, password changed elsewhere) signs the device out and keeps the
  local files.
- Switching vaults re-attaches the engine to the new vault's state; the account stays
  signed in.

## Web build and development

The web build talks to its own origin, which nginx proxies to Node. `vite.config.ts` proxies
`/api/v1/sync` to `FANOTES_SYNC_API` (default `https://fanotes.fasrv.ch`), so a local server
can be used with

```bash
FANOTES_SYNC_DIR=/tmp/fanotes-sync FANOTES_PUBLIC_ORIGIN=http://localhost:5173 node -e \
  "import('./fanotes-site/sync-api.mjs').then(({ handleSyncRequest }) => import('node:http').then(({ createServer }) => createServer(async (q, s) => { const u = new URL(q.url, 'http://x'); if (!(await handleSyncRequest(q, s, u))) { s.writeHead(404); s.end() } }).listen(18790)))"
FANOTES_SYNC_API=http://127.0.0.1:18790 npm run dev
```

`npm run check:sync` starts the server module on a random port, loads the client modules
through Vite SSR, and drives three fake devices through register, edit, sign-in, conflict,
deletion, password change and revocation.

## Accounts without e-mail or password

A new account needs a username only (3 to 32 ASCII letters, digits, `.`, `_`, `-`; unique ignoring
case; the server keeps `usernames/<sha256(lowercase name)>` as the uniqueness index, claimed with an
exclusive hard link like the e-mail index). E-mail and password are optional.

- **Without a password** the "password" the client feeds into the normal derivation is a random 32-byte
  *device key*. On the desktop it lives in its own `safeStorage` file (`device-keys.secret`) next to the
  session secrets and survives sign-out, so the account can sign in again on this device. Losing the
  device loses the account and its cloud data; the UI says so ("Ohne Passwort/E-Mail ist dein Konto weg,
  wenn du dieses Gerät verlierst."). The web build cannot protect a device key, so it always asks for a
  password. The server stores `credential: "device-key" | "password"` only to let clients present the
  right UI.
- **Adding a password later** uses the normal password change (the device key is the "current
  password"); the account becomes a password account and the device key is deleted. **Adding an e-mail
  later** uses `POST /email`. An e-mail never allows a password reset: only the password (or device key)
  opens the vault secret, so the data cannot be recovered without it.
- Existing accounts are unchanged: they keep e-mail sign-in and have `username: null` until the user
  claims one in Settings → Sync, which also creates their sharing key.
- **Cloud sync is off for new accounts** (`syncVaultEnabled`, default `true` only for settings that
  already existed). The account stays signed in for sharing; the engine skips pull, scan and push until
  the user turns the switch on. Existing users' setting is not changed.

## Shares between users

Sharing a note or folder with a FaNotes username keeps the end-to-end design:

```
account key pair   ECDH P-256, public half published at account creation (or when a username is claimed)
                   private half wrapped with a key derived from the vault secret -> every device opens it
share key K        random 32 bytes per share, made on the owner's device
K for the recipient  ephemeral ECDH with the recipient's public key + HKDF + AES-GCM   (keyWrap)
K for the owner      the same with the owner's own public key                          (ownerKeyWrap)
K ──HKDF──▶ data key and id key, exactly like the vault secret: file contents, encrypted metadata
            (path, size, mtime, hash) and the title all stay ciphertext on the server
```

The server only sees who shares with whom, the permission (`read` or `edit`), status, sizes, revisions
and times. Routes (all under `/api/v1/sync`, same bearer session):

| Route | Purpose |
| --- | --- |
| `POST /users/lookup` | Exact, complete username -> public key. No prefix search, no list; 30 per minute and 120 per hour per account, misses limited to 20 per hour. |
| `GET /shares`, `POST /shares` | List incoming and outgoing shares; create one (40 per hour, 15 per hour per recipient, 200 open per owner). |
| `POST /shares/:id/respond` | Recipient accepts or declines (optionally blocks the sender). |
| `PATCH /shares/:id` | Owner switches `read` and `edit`. |
| `DELETE /shares/:id` | Owner revokes (the ciphertext is deleted); recipient leaves or declines. |
| `GET /shares/:id/changes`, `GET/PUT/DELETE /shares/:id/files/:fileId` | Per-share change feed and blobs, same `If-Match` revision rule as vault files. |
| `POST /blocks`, `DELETE /blocks/:name` | Block or unblock a sender. |
| `GET /events` | Server-Sent Events push channel (below). |

Spam control: a recipient accepts or declines the first share from anyone. People whose share the
recipient accepted, and people the recipient shared with, are trusted and arrive already accepted. A
blocked sender gets a normal answer and the share is recorded as declined; the recipient sees nothing.
A recipient with 50 pending shares from unknown senders takes no more.

**Push channel.** `GET /events` is a long-lived `text/event-stream` response (nginx already runs
`/api/v1/sync/` with `proxy_buffering off` and a 300 s read timeout; the server sends a keep-alive
comment every 20 s and also sets `X-Accel-Buffering: no`). Events are small hints: `shares` (the list
changed: created, accepted, permission, revoked, left) and `files` (a share has new revisions). The
desktop app keeps it open while it runs and reacts by fetching, so a share, an acceptance, a change or a
revocation shows up at once; a missed event is repaired by a full listing on reconnect. Up to 4 streams
per account; a stream ends when its session is signed out. A later live-collaboration feature can use
the same channel and the per-share `seq` change feed without a format change.

**On the recipient's device** an accepted share is a folder `Mit mir geteilt/<person>/<name>` in the
vault (shown in the sidebar, which also has a "Mit mir geteilt" panel for pending requests). That folder
is never part of vault cloud sync. Revoking removes the local copy at once. With `edit` permission the
recipient's saves go back through the same share; on a clash the shared version takes the path and the
local one is kept as a "Konflikt" copy.

Limits: 50 MB per shared file, 3000 files and 512 MB per share. A shared note is its `.md` / `.famd` /
`.pdf` family; a shared folder is everything syncable below it. A share does not follow a rename of the
shared path on the owner's side.

## Live co-editing

An open shared note (accepted share; the owner always, a recipient read or edit) is edited live, desktop app only. Everything below is built on the share key of "Shares between users"; the server never sees plaintext.

**Documents.** One Yjs document per note and share: `text` (Y.Text, bound to CodeMirror with y-codemirror.next, undo per user through Y.UndoManager) and `strokes`/`dead` (ink). Ink strokes are a `Y.Map` keyed by stroke id; each entry is its own small map (`j` JSON, `o` order). Add = new entry, erase = delete entry and remember the id in `dead`, move = rewrite `j`. A move writes into the entry's own map, so an erase that races with it wins and nothing comes back half-alive. A stroke that is still being drawn is not part of the document until the pen lifts. Famd files keep their format; stroke ids derive from the stroke content when a file is loaded, random for new strokes, and never reach the file. Yjs and y-codemirror.next are loaded on demand (`import()`), only when a shared note opens.

**Transport.** `POST /shares/:id/live/:channel` sends, `GET /shares/:id/live/:channel?since=N` catches up, and the existing `GET /events` stream pushes a `live` event. The channel is an opaque 32-hex name (an HMAC of the note path under the share's id key). Message kinds: `u` update (buffered, ordered by one sequence per share), `p` presence (relayed, never stored), `i` init (first writer wins, 409 otherwise), `s` snapshot (replaces buffered updates up to `upTo`; the sender applies everything the server holds first). The payload is `base64(iv || AES-256-GCM)` with the share's data key and `live:<channel>:u|p` as associated data. Auth is the sync session; `authorize` runs inside the per-share lock, so a revoke or a downgrade to read wins over a queued message. A read-only user can fetch and receive but every `POST` (also presence) is 403.

**Limits.** 256 KiB per update, 8 KiB per presence message, 8 MiB per snapshot, 900 updates and 300 presence messages per account and 10 s, 32 notes per share, 4000 updates / 16 MiB buffered per note (then 413 with `compact`, the sender must send a snapshot; nothing is dropped silently). Updates above 48 KiB are not inlined in the push event; the client fetches them. The buffer is persisted per share (`live.json`, mode 0600) and removed with the share.

**Latency and idleness.** Local edits are batched per animation frame (fallback 32 ms) and sent as one merged update; while a request is in flight further edits coalesce. Presence goes out at most every 80 ms, only the newest state. Nothing is sent while idle: presence refreshes every 30 s while the note is visible and expires after 75 s, the SSE stream's keep-alive comment is every 30 s.

**Offline.** Unsent updates stay in an outbox (also persisted in the per-device cache) and go out on reconnect with backoff 1 s to 30 s. The push stream's reconnect triggers `resync()`: fetch since the last seen sequence number, apply (Yjs updates are idempotent), send the outbox. A device caches the document (`readState`), so edits made to the file while away are merged as a 3-way change on the cached lineage instead of overwriting.

**Persisting and the file sync.** The editor reports every change as usual, so autosave writes the merged text and ink to the normal shared file and the existing share path uploads it; people who are not online at the same time get it from there. While a note is live the file sync leaves that file alone for that share: pulls of it are deferred (no conflict copies), and an upload that finds a newer base takes the server's revision (nothing is uploaded when the server already holds the same text). When the session ends the normal sync runs again. A file that was edited outside a session and cannot be taken over by the live state is kept as a "(Konflikt …)" copy.

**Limits of the design.** A share has one owner and one recipient, so live state is per share. If the owner shares one note with several people, the owner's editor joins the first accepted share; the others keep the normal file sync. Edits made by the web or Android apps (no live support) reach a live session only through the shared file. Pen indicators show the other person's position as a fraction of the sheet.
