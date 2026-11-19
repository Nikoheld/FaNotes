# fanotes-sync: design and invariants

`fanotes-sync` is a port of the desktop/web sync engine in `fanotes/src/lib/sync/engine.ts`
(and the modules it calls) to Rust. It speaks the same wire protocol to
`fanotes-site/sync-api.mjs`, uses the same key derivation and ciphertext layout, and reads
and writes the same per-vault state and account secrets through the same host contract
(`SyncHostApi` in `fanotes/src/types.ts`). A device can switch between the TypeScript and
the Rust engine in either direction without a resync and without spurious uploads or
conflict copies.

This file was written before the code. Section 11 lists what the port found in the
TypeScript engine (nothing was changed in either engine) and the few places where the
Rust engine cannot behave identically.

## 1. Scope

| TypeScript | Rust | Notes |
| --- | --- | --- |
| `sync/engine.ts` `SyncEngine` | `engine.rs` `SyncEngine` | cycle (pull, scan, push), account flows, conflict resolution |
| `sync/api.ts` | `api.rs` | HTTP client, retry rule, `SyncApiError` |
| `sync/crypto.ts` | `crypto.rs` | PBKDF2, key wrap, HKDF, HMAC ids, AES-GCM blobs and meta |
| `sync/folderSync.ts`, `isSyncablePath`, `conflictCopyPath` | `paths.rs` | path rules, excluded folders, conflict copy names |
| `sync/conflicts.ts` | `conflicts.rs` | copy-name parsing, grouping, `keptVersionPath`, `numberedVariant`, fingerprint |
| `lib/famd.ts` (sync subset), `electron/famdV2.mjs`, `noteLink`, `noteBackup`, `noteTextField`, `pageStats.parsePageStats` | `famd.rs`, `famd_v2.rs`, `jsjson.rs` | `noteSyncKind`, `canonicalSyncBytes`, `identitySyncBytes`, `withLocalPageStats` |
| `lib/homeworkStore.ts` (merge subset), `embeddedJsonComment.ts` | `homework.rs` | `Hausaufgaben.md` task merge |
| `SyncHostApi` | `host.rs` `SyncHost` | trait; `MemoryHost` (tests), `FsHost` (mirror of `electron/sync.cjs`) |

Not ported, because they are not part of the vault sync cycle and stay in the renderer:
`conflictPreview.ts`, `markdownConflict.ts` (preview/diff UI), `share*.ts` (public note
links, `/api/v1/share`), `profile.ts` (public profile, `/api/v1/profile`),
`recognitionModelBundle.ts` (builds the file the engine syncs as an ordinary path),
`status.ts` (labels), `browserSyncHost.ts` (web host), and the Grok connector calls in
`engine.ts` (`enableMcpConnector` and friends, `/api/v1/mcp`). The Rust engine keeps the
connector's `mcpReader` field when it reads secrets, and drops it on sign-in exactly as the
TypeScript engine does.

Scheduling (60 s timer, 2.5 s local-change debounce, 30 s offline retry, focus/online
kicks) is the app's job. `SyncEngine::sync_now` coalesces concurrent calls the way
`syncNow` does; the desktop hook keeps the TypeScript scheduler and asks the native engine
for one cycle at a time.

## 2. Wire protocol (unchanged)

All routes under `/api/v1/sync`; authenticated routes send `Authorization: Bearer <token>`
and `X-FaNotes-Account: <accountId>`.

- `POST /prelogin {email}` → `{kdf}`; `POST /register {email, authKey, kdf, vaultKeyWrap, device}`;
  `POST /login {email, authKey, device}`; `GET /account`; `POST /logout`; `DELETE /devices/:id`;
  `POST /password {authKey, newAuthKey, kdf, vaultKeyWrap}`; `DELETE /account {authKey}`.
- `GET /changes?since=N` → `{revision, entries[], more, nextSince}` (500 per page).
- `GET /files/:id` → body, `X-FaNotes-Revision`, `X-FaNotes-Meta`, `X-FaNotes-Sha256`; 204 or
  `X-FaNotes-Deleted: 1` for a tombstone.
- `PUT /files/:id` with `If-Match: <base>`, `Content-Length`, `X-FaNotes-Meta`,
  `X-FaNotes-Sha256` (of the ciphertext), `X-FaNotes-Blank: 1|0`, optional `X-FaNotes-Clear: 1`.
- `DELETE /files/:id` with `If-Match: <base>` and `X-FaNotes-Delete: 1`.
- Errors: JSON `{error, entry?, reason?}`; `X-FaNotes-Rejected: guard` marks a guard 409.
  The message of a failed request is the server's `error`, else
  `Der Sync-Server antwortete mit <status>.`
- Retry: a request that fails before any response is repeated once after 400 ms when it is a
  `GET` or `prelogin`. Register, login, uploads, deletes and password changes are never
  repeated. A transport failure is status 0 (`offline`).
- The Rust client sends no `Origin` and the `Accept-Language` the host gives it (the
  desktop webview's language), so server messages are localised as for the renderer.

## 3. Crypto (byte-compatible)

```
password.normalize(NFKC) + base64(salt) ── PBKDF2-SHA256(iterations) ──▶ 64 bytes
   bytes 0..32  = wrapping key (AES-256-GCM, never sent)
   bytes 32..64 = authKey (base64, sent)
vault secret (32 random bytes) ─ AES-256-GCM(wrapping key, iv 12) ─▶ {iv: b64, data: b64(ct‖tag)}
HKDF-SHA256(ikm = vault secret, salt = "fanotes-sync-v1", info "data") → 32-byte AES-256-GCM key
HKDF-SHA256(ikm = vault secret, salt = "fanotes-sync-v1", info "id")   → 32-byte HMAC-SHA256 key
fileId = hex(HMAC(id key, UTF-8(path.normalize(NFC))))
blob   = iv(12) ‖ AES-GCM(data key, plaintext, aad = UTF-8(fileId))   (ciphertext ‖ 16-byte tag)
meta   = base64(blob of JSON.stringify({path, mtimeMs, size, sha256}))
```

`sha256` in meta is the hex SHA-256 of the canonical plaintext (section 5). The upload's
`X-FaNotes-Sha256` is the hex SHA-256 of the blob. KDF defaults: `pbkdf2-sha256`, 600 000
iterations, 16-byte salt; a server KDF is accepted only with 100 000 ≤ iterations ≤ 5 000 000
and a salt string of at least 20 characters. Base64 decoding follows `atob` (forgiving).

## 4. Persisted state and secrets (same files, same JSON)

The engine never touches files itself; the host stores them. On the desktop that is
`<userData>/sync/state-<vaultId>.json` and `<userData>/sync/account.secret` (Electron
`safeStorage` / Tauri keyring). The JSON is the same in both engines:

```
state   = {version: 1, accountId, cursor, lastSyncAt, files: {path: LocalBase}, conflicts: [{path, copyPath, at}], pendingDeletes: [path], skipped: [SyncRemoteEntry]}
LocalBase = {id, revision, sha256, size, mtimeMs, contentSha256?, blank?}
secrets = {v: 1, accountId, deviceId, token, expiresAt, email, vaultSecret (base64), mcpReader?}
```

Reading is `parseState`: a wrong version or account id is an empty state; each file entry
needs a string `id` and `sha256`, and its path must pass `isSyncablePath(path)` with
*default* options; `conflicts` keeps the last 50, `pendingDeletes` the last 500 (1..1024
chars), `skipped` the last 200. Field order on write follows the TypeScript object order.

## 5. Content identity (decides "changed")

For `.md`, `.markdown` and `.famd` paths (case-insensitive) the engine never compares raw
bytes alone:

- `noteSyncKind`: empty bytes are `blank` for every path; other non-note paths are
  `present`. A note whose text carries a `fanotes-famd:v1|v2` marker but no parseable payload
  (truncated, bad CRC, bad JSON) is `unreadable`. A note with no prose (after trim), no ink
  marks (`inkHasMarks`, depth 6) and no non-empty text field is `blank`.
- `canonicalSyncBytes`: a note with page statistics is re-serialised without them (same
  v1/v2 encoding as the file); anything else is returned unchanged. Its SHA-256 is `sha256`
  in the state and in the meta.
- `identitySyncBytes`: the note re-serialised without page statistics and with
  `updatedAt` (payload and ink) set to `1970-01-01T00:00:00.000Z`. Its SHA-256 is
  `contentSha256`. Unreadable notes have no identity.
- `withLocalPageStats`: a downloaded note gets this device's page statistics back before it
  is written.

These functions run the renderer's `famd.ts` code paths: JSON is parsed and stringified
with JavaScript semantics (`jsjson.rs`: numbers are doubles printed like
`Number#toString`, integer-like keys first, UTF-16 strings with lone surrogates, insertion
order otherwise), text is decoded like `TextDecoder` (replacement characters, BOM removed),
string limits count UTF-16 units, and dates go through the V8 `Date.parse` port in
`fanotes-famd`. The v2 codec (base-85 point blocks, CRC-32, quantised coordinates,
canonical NaN) is ported bit for bit.

## 6. The cycle

`runCycle`: pull → push → (pull again if the push reported conflicts) → `lastSyncAt` →
persist. Any error persists the state first; 401 signs out (secrets and state removed,
files kept); status 0 is `offline`, everything else `error`.

**Pull.** Fetch `/changes` from `cursor`, up to 200 pages. Append every remembered skipped
entry whose id is not in the fetched set. Apply entries with 3 workers. Per entry:

1. Tombstone: unknown id → noop. Known path with `revision <= base.revision` → noop. Busy
   → deferred. Local file missing → forget the base. Local file equal to the base
   (`sha256` or raw hash) → remove it (desktop: system trash), forget the base. Otherwise the
   local edit wins: keep the file, set `base.revision = tombstone revision`, `sha256 = ''`
   (so it is re-uploaded on top of the tombstone).
2. Live entry without meta or sha → skipped. Meta that does not decrypt → skipped. A path
   this device does not sync → skipped. Same id with `revision <= base.revision` → noop.
   Busy → deferred.
3. Local file already equals the remote hash → adopt the remote revision (noop).
4. Download; ciphertext hash must equal `X-FaNotes-Sha256`; plaintext hash must equal
   `meta.sha256` (both throw → skipped). A download that turned into a tombstone → noop.
5. Same note up to page statistics/timestamps (canonical or identity hash) → adopt (noop).
6. `Hausaufgaben.md` changed on both sides and both parse → task merge, written with the
   remote revision as base so the next push uploads the merge.
7. Local file present and changed since the base (or untracked, or unreadable), or the
   remote is blank while the local is not → the local bytes are written to a conflict copy
   first. Then the remote bytes (with local page statistics for notes) are written.

Results: `deferred` holds the cursor at `revision - 1`; `skipped` goes on the skip list
(cap 200, retried every pull); anything else leaves the skip list. Sign-in, offline, 429
and 5xx errors end the cycle; any other error skips only that entry.
`cursor = max(cursor, min(nextSince, holdCursor))`. One `onApplied` with all written and
removed paths.

**Scan.** Host scan, filtered by `isSyncablePath` with the live options. A file is a
candidate when it has no base, or size or mtime differ, or mtime is 0, or the base `sha256`
is empty. Files above 100 MiB are skipped. Tracked paths that are missing (and not busy)
are a delete only when a pending delete mark covers them; otherwise the server copy is
written back (`restoreVanished`: download, write, rebase; a tombstone forgets the base;
any failure leaves everything as it is).

**Push.** Upload candidates with 3 workers, then deletes one by one, then settle delete
marks. Per upload (`uploadPath`):

1. Unreadable file (read error) → skipped. `unreadable` kind or no identity → with a non-blank
   base, `restoreInstead` (server copy back, local bytes to a conflict copy); otherwise skipped.
2. Same identity, or same canonical/raw hash as the base → `unchanged` (base refreshed).
3. Blank or severely shrunk (base ≥ 4096 bytes and new ≤ 1024 bytes or < ¼) while the base
   holds content, and the editor did not `markCleared` the path → `restoreInstead`.
4. Upload with `If-Match: base.revision` (0 when untracked). On 409:
   guard, or a current entry at the same revision → `restoreInstead` (why = guard);
   tombstone → blank file: track as blank and stop; otherwise upload once more on top of the
   tombstone; newer revision → `applyRemote(current)` now (local edit becomes a conflict
   copy); 507 → skipped with an error log line; anything else throws.

`restoreInstead` waits while the path is busy, downloads the server copy, and when that is
not `present` tracks the local file as blank instead. Otherwise it writes the local bytes to
a conflict copy, writes the server copy over the path, reports both as applied.

Deletes use `If-Match: base.revision` and `X-FaNotes-Delete: 1`; a 409 applies the server's
entry (the newer edit comes back). Delete marks considered in this cycle are dropped once
nothing tracked under them is missing.

## 7. Invariants (each has a parity fixture or a check-sync case)

1. **No stale overwrite on the server.** Every PUT and DELETE names the revision this device
   last saw; the server refuses anything else. A 409 is resolved in the same cycle from the
   entry in the response, never by waiting for a pull (the entry can be older than the
   cursor).
2. **No stale overwrite on the device.** A remote change is written over a local file only
   when the local file still equals the base the device last synced (identity or hash), or
   after the local bytes were written to a conflict copy. A busy (open, dirty) path is never
   written; the cursor is held so the change is fetched again.
3. **No empty overwrite.** A blank, unreadable, truncated or severely shrunk local file is
   never uploaded over a base with content unless the editor marked the clear. The server
   refuses blank/zero/collapse bodies without `X-FaNotes-Clear` and quarantines them; the
   client then keeps both versions instead of retrying.
4. **A missing file is not a delete.** Only paths covered by `markDeleted` become tombstones,
   and a mark ends once applied. An incomplete vault scan is an error, not deletions.
5. **A tombstone does not destroy an edit.** A local edit after a remote delete is kept and
   re-uploaded on top of the tombstone; a remote edit after a local delete is restored.
6. **Conflict copies never overwrite.** `<stem> (Konflikt <device> <YYYY-MM-DD HH-MM>)<ext>`
   in local time, device name sanitised (`\/:*?"<>|` and controls → space, 40 UTF-16 units,
   fallback `Gerät`), numbered ` 2`, ` 3` … inside the bracket when the name exists.
7. **One bad entry does not stall sync.** Undecryptable or corrupt entries go on the skip
   list and are retried every pull; only sign-in, offline, 429 and 5xx end a cycle.
8. **Integrity.** Ciphertext hash and plaintext hash are verified before anything is written.
   Writes go through the host (atomic temp file + fsync + rename on desktop).
9. **Cursor never moves past a deferred change**; it never moves backwards.
10. **Interrupted work is safe to retry.** State is persisted after pull, after push and on
    every error. An upload interrupted before the response is not repeated; the next cycle
    sends it again with the same base, and the server either accepts it or answers 409.
11. **Engine switch.** Both engines produce the same state JSON fields, hashes and secrets,
    so the other engine continues from the cursor with no uploads and no copies.

## 8. Concurrency model

The TypeScript engine runs three async workers that interleave at `await` points. The Rust
engine runs three OS threads over the same work list. Shared state (`files`, skip list,
conflicts, id index, scan cache, log) sits behind one mutex that is never held across host
I/O, hashing of file bodies or network calls, so the possible interleavings are the ones the
TypeScript engine has. Operations on the same file are never reordered. Across files the
order is not defined in either engine, so parity records compare per-file operation
sequences and normalise server revisions to per-file ordinals (section 10).

## 9. Desktop integration

`fanotes/src-tauri/src/native/sync.rs` exposes `fanotes-native:sync-cycle`,
`fanotes-native:sync-busy`, `fanotes-native:sync-enabled` and
`fanotes-native:sync-set-enabled`. The cycle reads and writes vault files, state and
secrets through the same `fanotes:sync-*` host channels the TypeScript engine uses on
Tauri, so both engines share one state file. The preference lives in
`<appData>/sync/native-engine.json` (default off). The renderer hook
(`src/lib/sync/nativeCycle.ts`) runs the TypeScript scheduler and, only when
`window.fanotes.nativeSync` exists and the preference is on, replaces the body of one cycle
with the native call and reloads the state afterwards. Busy paths (tracked and scanned
paths for which `isPathBusy` is true) are sent before the cycle and refreshed every
250 ms while it runs; until the first list arrives every path counts as busy. Applied,
conflict and log events stream as Tauri events and come back with the result, deduplicated
by sequence number. `markCleared` paths go in and the unused ones come back.

Story scenes (`X.story/scenes/*.json`): the engine treats them as ordinary files today
(conflict copy on concurrent edits). `EngineOptions::content_merge` is the extension point:
a `fanotes-story` scene merge can be set there and is consulted where the homework merge
is (pull step 6, both sides changed and present; `None` keeps the conflict copy). It is
unset by default and not implemented here. Its log line is still the homework wording and
should get its own text when a merge is plugged in.

## 10. Parity harness

`fanotes/scripts/sync-parity/` holds JSON scenarios. `run.mjs` starts the real
`sync-api.mjs` on a random port with a temporary `FANOTES_SYNC_DIR`, drives the TypeScript
engine (through Vite SSR) with an in-memory host, and records per scenario: the final local
files per device (hash and size), the server table decrypted with the account key (path,
deleted, plaintext hash, per-file revision count), the normalised state per device, sorted
log lines, applied/conflict events, and per-file request sequences. The Rust engine runs the
same interpreter (`harness.rs`) and must produce identical records; `cargo test -p
fanotes-sync` compares against the committed records, and `run.mjs --rust` runs both and
mixed-engine scenarios (one device TypeScript, one Rust, and devices that switch engines).

## 11. Findings

TypeScript engine (reported, not changed; the Rust engine does the same so both stay
interchangeable):

1. **A present but unreadable local file is overwritten without a copy.** `localSnapshot`
   returns `null` on any error (read failure such as `EACCES`, a file above 100 MiB that the
   host refuses to read, a throw while hashing). `applyRemote` then treats the file as absent:
   no conflict copy, and the remote version is written over it.
2. **Opt-in paths lose their base on every start.** `parseState` filters with
   `isSyncablePath(path)` without options, so `.fanotes/history/*` (history sync on) and
   `.fanotes/recognition-model.json` (model sync on) are dropped from the state each time it
   is loaded; the next push re-sends them and resolves the 409 (scenario `busy-skip`).
3. **A download rewrites note text encoding.** When a local copy exists, every downloaded
   `.md`/`.markdown`/`.famd` goes through `TextDecoder`/`TextEncoder` (the page-statistics
   splice), so a UTF-8 BOM is dropped and non-UTF-8 bytes (Latin-1 notes) become U+FFFD on
   that device.
4. **Blank copy of a note deleted elsewhere loops (by reading).** `restoreInstead` answers
   `conflict` for a tombstone without changing the base, so each cycle reports one conflict
   and pulls twice until the blank file is removed.
5. `deletePath` does not guard its `applyRemote` call: one failing entry ends the cycle.

Rust engine, where it cannot be identical:

- After a cycle-wide error (offline, 401, 429, 5xx) the TypeScript workers keep applying
  the remaining entries in the background after the cycle reported its failure; the Rust
  workers stop. The next cycle does the same work.
- JSON nested deeper than 4096 levels is treated as unparseable (V8 parses it, but its
  `JSON.stringify` overflows the stack on such input); such a note is not uploaded.
- Strings cut inside a UTF-16 surrogate pair where JavaScript keeps a lone surrogate in a
  path (a device name of exactly 40 units ending in an emoji) become U+FFFD.
- `localeCompare` (conflict group order) uses ICU4X German collation; error messages of
  non-API failures (malformed JSON from the server) differ in wording.
- Number printing matched V8 only after taking the correctly rounded shortest digits; the
  4,008 vectors in `expected/vectors.json` pin it.
