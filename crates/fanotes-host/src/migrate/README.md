# Electron → Tauri profile migration (WP7)

`migrate::run` moves a user's FaNotes Electron profile into the Tauri app data directory
(`de.fanotes.app`). The vault is shared by both hosts and is never touched.

## 1. What the Electron desktop keeps outside the vault

Profile: `~/.config/FaNotes` (Linux, `$XDG_CONFIG_HOME` honoured) or `%APPDATA%\FaNotes` (Windows).
Older names `Lernwerk Notes` / `lernwerk-notes` are found too. The renderer page is `file://`,
so its web storage is origin `file://` (`file__0`).

| Data | Where | Format | Migration |
| --- | --- | --- | --- |
| Settings, vault path | `config.json` | JSON `{version, vaultPath, settings, resourceLimits}` | → `settings.json` + `vault-path` (`profile::apply_config`), only when the Tauri profile has none |
| AI keys, OpenCode password, homework secret, Grok tokens (`SECRET_KEYS`) | `config.json` `settings.<key>` | `fanotes-secret-v1:` + base64(safeStorage ciphertext); legacy plaintext | decrypted in Rust → OS keyring (`secrets.rs` accounts); never written to disk |
| safeStorage key (Windows) | `Local State` `os_crypt.encrypted_key` | base64(`DPAPI` + DPAPI blob of a 32-byte key) | used to decrypt, not copied |
| Sync login | `sync/account.secret` (+ `sync/account.key`) | `safe1:` + base64(safeStorage), or `local1:` + base64(iv‖tag‖AES-256-GCM) with the 32-byte `account.key`; `plain1:` is discarded by Electron | → keyring account `sync-account` + `sync/account.secret` = `safe1:` (the Tauri layout) |
| Sync state per vault | `sync/state-<vaultId>.json` | `{version:1, accountId, cursor, lastSyncAt, files{path→{id,revision,sha256,size,mtimeMs,…}}, conflicts}`; `vaultId = sha256(path.resolve(vault))[0..32]` | copied byte for byte; both hosts compute the same id for the same (realpath) vault |
| Handwriting model (GlyphenWerk store) | IndexedDB `fanotes-handwriting` v1: `samples` (keyPath `id`, indexes `labelId`, `createdAt`), `layoutExamples` (`anchorLabelId`, `createdAt`), `labels` | Chromium LevelDB + Blink/V8 serialized values; large values Snappy-compressed (`ff 11 02`) and/or moved to blob files (`ff 11 01`) | renderer step, record by record |
| Legacy handwriting store | IndexedDB `lernwerk-notes-handwriting` | same schema | migrated like any database; the app's own legacy merge then runs |
| Ink personalization | IndexedDB `fanotes-ink-personal` v1: `lines` (`createdAt`), `meta` (keyPath `key`) | as above | renderer step |
| GlyphenWerk iframe (same origin) | IndexedDB `glyphenwerk-db` v1 `samples`; localStorage `glyphenwerk-*` | as above | renderer step |
| UI state, personal dictionary, view memory, drafting, tool memory, workspace/split layout, GlyphenWerk id lists | localStorage (`fanotes.uiLanguage`, `fanotes.spelling.personal.v1`, `fanotes.paperView.v1`, `fanotes.drafting.v1`, `fanotes.tool-memory.v1`, `fanotes.workspace.v1:*`, `fanotes.splitLayout.v1`, `fanotes.art-tools.v1`, `fanotes.math-solver-format.v1`, `fanotes-glyphenwerk-*-ids.v1`, …) | `Local Storage/leveldb`, key `_file://\0` + (1 Latin-1 \| 0 UTF-16LE) name | every key of the origin, renderer step |
| Add-ons | `addons/addons.json`, `addons/<id>/*` | files | copied when absent |
| Folder locations | `folder-locations.json` | JSON | copied when absent |
| Fine-tuned ink model | `ink-recognition/personal-model.onnx`, `personal-model.json` | files | copied when absent |
| Handwriting learning cache | `personal-handwriting-v2/<sha256(root)>/` | JSON | copied when absent (rebuildable, small) |
| Chromium bookkeeping | `Preferences`, `WebStorage/` (quota) | Chromium | backed up, not imported |

Left out of the backup (`backup::EXCLUDED`): Chromium caches and locks (`Cache`, `Code Cache`, `GPUCache`,
`Dawn*Cache`, `GrShaderCache`, `ShaderCache`, `Crashpad`, `blob_storage`, `Session Storage`,
`Shared Dictionary`, `Dictionaries`, `Service Worker`, `Network*`, `Cookies*`, `Trust Tokens*`, `DIPS*`,
`SharedStorage`, `TransportSecurity`, `Reporting and NEL`, `Singleton*`, `lockfile`, LevelDB `LOCK`),
re-downloadable model weights (`models/`: PosFormer GGUF, Qwen/OpenVINO runtime), the updater cache
(`updates/`), OneNote tool cache (`tool-cache/`) and the tree cache (`tree-cache-v1/`).
Cookies are encrypted with the same key but the app authenticates with bearer tokens, not cookies.

## 2. Order and guarantees

1. Find the profile (`profile::find_electron_profile`; `FANOTES_ELECTRON_PROFILE` overrides; unit tests never look at `$HOME`).
2. Refuse while Electron runs (`SingletonLock` → live `host-pid`; Windows `lockfile` held). Status `blocked`, retried next start.
3. **Backup first** to `migration-backup/<id>/files/`: streamed copy with SHA-256, source size/mtime checked before and after each file,
   `manifest.json` (path, size, sha256, exclusions), then every copy is read back and compared, then `VERIFIED`.
   A backup without `VERIFIED` is a crash leftover and is redone. Everything after this reads **only the verified copy**.
4. Phases `settings → secrets → sync → files → webstorage`, journalled in `migration/state.json`. A crash resumes at the next phase;
   each phase is idempotent on its own and never overwrites Tauri data (existing settings, keyring entries, sync state files and
   files are kept and reported as `keptExisting`).
5. `webstorage` exports IndexedDB and localStorage to `migration/export/` (manifest + JSONL per store). The renderer step
   (`fanotes/src/lib/desktopMigration.ts`, hooked in `main.tsx` before the app renders, Tauri only) pages through it with
   `fanotes-native:migration-page`, adds only missing records with the same schema (version, keyPath, autoIncrement, indexes),
   reads every record back and reports per store `{expected, equal, keptExisting, failed}` via `fanotes-native:migration-done`.
   The host refuses an incomplete confirmation; the status stays `pending` and the step reruns next start.
6. Only then `.fanotes-electron-migration-v2-complete` is written. A rerun is a no-op (tested: no file in the Tauri profile changes).

Report (`migration/report.json`, `fanotes-native:migration-status`): `status` (`nothing`, `blocked`, `failed`, `pending`,
`complete`, `complete-with-actions`), `backup`, `settings`, `secrets.{migrated, keptExisting, needsReentry[{name, reason}]}`,
`sync.{account, reason, states, stateForVault}`, `files`, `webstorage`, and `actions` for the UI
(`reenter-secret`, `sync-sign-in`, `webstorage-in-backup`). `migration/migration.log` has one line per step and never a secret value.

## 3. Why read Chromium's files in Rust

Users may never start Electron again and the Tauri webview (WebKitGTK / WebView2) cannot open a Chromium profile, so the
data has to be decoded without Chromium. The format is stable and small to implement read-only: LevelDB (`leveldb.rs`:
CURRENT → MANIFEST live tables → newer logs, CRC32C checked, Snappy), Chromium's IndexedDB key schema (`idb.rs`), Blink value
wrapping and V8 `ValueSerializer` v13+ (`v8.rs`, Electron 43 writes Blink v21 / V8 v16). Values become tagged JSON that keeps
everything structured clone can hold (undefined, NaN/±Infinity/−0, lone surrogates, Date, RegExp, Map, Set, sparse arrays,
typed arrays, BigInt, boxed primitives); shared references are copied, cycles and host objects (Blob, File) are reported as
unreadable records, never dropped. The exact same tag rules exist in JavaScript (renderer step and fixture generator).
`v8_date.rs` in `fanotes-famd` is a `Date.parse` port and does not decode serialized values.

## 4. safeStorage (Electron 43.1.0, Chromium 150, sync `OSCrypt`)

- Linux `v10`: AES-128-CBC, IV 16 × 0x20, key PBKDF2-HMAC-SHA1(`peanuts`, `saltysalt`, 1, 16). `v11`: same with the password from the
  Secret Service item (schema `chrome_libsecret_os_crypt_password_v2`, `application` = `FaNotes`; v1 schema also tried) or KWallet
  (`FaNotes Keys`/`FaNotes Safe Storage`, then `Chromium Keys`/`Chromium Safe Storage`). Both retry with the empty-password key.
  With `--password-store=basic`, Electron 43 reports encryption unavailable, so FaNotes stores no AI secrets and seals the sync login with `local1:`.
- Windows `v10`: AES-256-GCM (12-byte nonce, 16-byte tag) with the DPAPI-unwrapped key from `Local State`; no prefix = raw DPAPI.
- A value that cannot be opened (`keyring-unavailable`, `cannot-decrypt`, `invalid`, `target-keyring-unavailable`) is listed for
  re-entry; the rest of the migration continues.

## 5. Rollback

- The Electron profile is opened read-only (tested: byte-identical before/after). Rollback is: start the Electron app again.
- `restore_electron_profile(backup_id, empty_dir)` (`fanotes-native:migration-restore-electron`) re-verifies the backup and writes it back
  as a profile, e.g. to `~/.config/FaNotes` after the user removed it; refused for a non-empty destination or a damaged backup.
- `fanotes-native:migration-run [true]` imports again from a new verified backup (same no-overwrite rules).

## 6. Tests and fixtures

`cargo test -p fanotes-host --lib migrate`. `fixtures/linux-leveldb` is a real Electron 43.1.0 profile (two runs, so it has
overwritten and deleted records, blob-file values and Snappy values) written by `fixtures/make-electron-profile.cjs`; `expected.json`
is what Electron itself read back. `fixtures/linux-local1` covers the `local1:` sync seal. All data and secrets are made up.

Regenerate (Linux, `--password-store=basic`):

```sh
E=fanotes/node_modules/electron/dist/electron G=crates/fanotes-host/src/migrate/fixtures/make-electron-profile.cjs
xvfb-run -a $E --password-store=basic --no-sandbox $G --out /tmp/f1 --backend leveldb --plain-text-encryption --samples 60
xvfb-run -a $E --password-store=basic --no-sandbox $G --out /tmp/f1 --backend leveldb --plain-text-encryption --samples 60 --phase reopen
```

Renderer step in real Chromium: `FANOTES_MIGRATION_EXPORT_OUT=/tmp/x cargo test -p fanotes-host --lib -- --ignored write_export_for_renderer_check`,
then `xvfb-run -a $E --no-sandbox crates/fanotes-host/src/migrate/fixtures/check-renderer-step.cjs --export /tmp/x --out /tmp/y`.

Windows CI: `os_crypt::tests::windows_dpapi_round_trip` (real DPAPI) runs on the Windows runner; set `FANOTES_ELECTRON_FIXTURE` to a profile
generated there by `make-electron-profile.cjs` to run `a_freshly_generated_electron_profile` against real Windows Electron output.

## 7. Not covered yet

- Chromium's SQLite IndexedDB backend (`IndexedDB/file__0/`, off by default in Electron 43): backed up, reported as unsupported.
- Linux `v11` against a live Secret Service / KWallet, and the renderer step inside WebKitGTK / WebView2, are not exercised here.
- The migration runs synchronously in `Host::open` (one-time copy of the profile, without caches and models).
