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
| UI | `src/components/SyncSettingsSection.tsx`, `src/App.tsx` | Settings → Sync, status-bar item, palette commands, remote-change application. |
| Check | `scripts/check-sync.mjs` (`npm run check:sync`) | Crypto unit tests, path rules, transport retry, and a three-device end-to-end run against the real server module. |

## Keys

```
password + salt ──PBKDF2-SHA256 (600 000 rounds)──▶ 64 bytes
                                                     ├─ wrapping key (AES-256-GCM)  never leaves the device
                                                     └─ auth key                    the only secret the server sees
vault secret (32 random bytes) ──wrapped with the wrapping key──▶ stored on the server, opaque
vault secret ──HKDF-SHA256──▶ data key   AES-256-GCM for file contents and metadata
                           └─▶ id key     HMAC-SHA256 over the path = the file's server-side id
```

- **Register** creates the KDF salt, derives both halves, generates the vault secret, wraps it
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

Per account: e-mail address (needed to sign in), scrypt hash of the auth key, KDF salt and
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
| `POST /prelogin` | KDF parameters for an address (fake but stable salt for unknown ones). |
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

Skipped: the local history (`.fanotes/history`), tree cache, onboarding state, hidden files
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
