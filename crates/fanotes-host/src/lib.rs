#![recursion_limit = "512"]
//! Desktop host operations behind `FaNotesApi`.
//!
//! Tauri commands use the preload channel strings. Electron stays the release host:
//! update commands report `supported: false` and do not install a package.

mod addons;
mod channels;
mod dialogs;
mod drawings;
mod imports;
mod linux_runtime;
mod notes;
mod ocr;
mod onboarding;
mod onenote;
mod policy;
mod profile;
mod resources;
mod secrets;
mod settings;
mod vault;
mod worksheets;

mod ai;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use sha2::{Digest, Sha256};

use serde_json::{json, Map, Value};

pub use channels::{find_channel, ChannelKind, CHANNELS};
pub use dialogs::{pdf_export_dialog, subject_book_window_title};
pub use policy::{addon_request_allowed, local_ai_origin};
pub use secrets::SecretStore;

pub(crate) const SECRET_KEYS: &[&str] = &[
    "lmStudioApiToken",
    "ollamaApiToken",
    "openAiApiKey",
    "geminiApiKey",
    "anthropicApiKey",
    "openCodePassword",
    "homeworkApiSecret",
];

const APP_VERSION: &str = "2026.10.2";

#[derive(Debug)]
pub struct Host {
    pub vault: Option<PathBuf>,
    /// Absolute vault from `vault-path` or an imported profile.
    ///
    /// Desktop `readConfig` remembers this path before the folder is mounted.
    /// A missing folder must not be replaced by the documents vault.
    configured_vault: Option<PathBuf>,
    pub app_data: PathBuf,
    pub settings: Map<String, Value>,
    pub onboarding_required: bool,
    pub close_requested: bool,
    /// Set only after the page has saved and confirmed the window may close.
    pub allow_close: bool,
    /// Native file dialogs. The channel sweep turns this off so a picker cannot block the test.
    pub file_dialogs: bool,
    /// Overrides the documents directory used for a first-run vault.
    pub documents_dir: Option<PathBuf>,
    /// When set, link and file-manager actions are appended here instead of launched.
    pub open_log: Option<PathBuf>,
    /// When set, deleted notes go to this trash directory instead of the desktop trash.
    pub trash_dir: Option<PathBuf>,
    /// Where API keys and the sync login are kept. Tests can substitute memory.
    pub secret_store: SecretStore,
    /// True after this session has shown the stored API keys to the page.
    secrets_loaded: bool,
}

impl Host {
    pub fn open(app_data: PathBuf) -> Self {
        // `path.resolve` drops `..` before the profile directory is created.
        // A missing middle segment must not be created on the way there.
        let app_data = node_resolve(&app_data);
        complete_pending_app_data_reset(&app_data);
        // Desktop creates the profile with mode `0o700`.
        let _ = ensure_private_profile_dir(&app_data);
        let mut host = Self {
            vault: None,
            configured_vault: None,
            app_data,
            settings: default_settings(),
            onboarding_required: false,
            close_requested: false,
            allow_close: false,
            file_dialogs: true,
            documents_dir: None,
            open_log: None,
            trash_dir: None,
            secret_store: SecretStore::Keyring,
            secrets_loaded: false,
        };
        host.load_persisted();
        host
    }

    pub fn set_vault(&mut self, path: PathBuf) -> Result<(), String> {
        let canonical = validated_vault_directory(&path)?;
        self.vault = Some(canonical.clone());
        self.configured_vault = Some(canonical);
        self.refresh_onboarding();
        if let Some(root) = self.vault.clone() {
            onboarding::upgrade_welcome_notes(&root);
        }
        Ok(())
    }

    fn require_vault(&self) -> Result<&Path, String> {
        self.vault.as_deref().ok_or_else(|| {
            if self.configured_vault.is_some() {
                "Der gewählte Vault ist kein sicherer Ordner.".to_owned()
            } else {
                "Der Vault ist noch nicht initialisiert.".to_owned()
            }
        })
    }

    pub fn dispatch(&mut self, channel: &str, args: &[Value]) -> Result<Value, String> {
        self.try_attach_configured_vault();
        let binding =
            find_channel(channel).ok_or_else(|| format!("Unbekannter Kanal: {channel}"))?;
        match binding.kind {
            ChannelKind::Event => return Ok(Value::Null),
            ChannelKind::Message => return self.dispatch_message(channel),
            ChannelKind::Command => {}
        }
        // Desktop `ensureBootstrap` checks `fs.access(realpath, R_OK | W_OK)`
        // before the command body. A remembered read-only folder still opens
        // through the quick bootstrap. `write-file` and `complete-onboarding`
        // validate their arguments before that access check.
        if session_revalidates_vault(channel) {
            ensure_remembered_vault_writable(self)?;
        }
        // `write-file` checks the path and the note text before this gate.
        if self.onboarding_required
            && channel != "fanotes:write-file"
            && !onboarding_open(channel)
        {
            return Err("Bitte schließe zuerst die FaNotes-Ersteinrichtung ab.".to_owned());
        }
        match channel {
            "fanotes:bootstrap" => self.bootstrap(),
            "fanotes:complete-onboarding" => self.complete_onboarding(args),
            "fanotes:get-cached-tree" => self.cached_tree(),
            "fanotes:get-fast-tree" => self.tree(false),
            "fanotes:get-tree" => self.tree(true),
            "fanotes:select-vault" => self.select_vault(args),
            "fanotes:read-file" => {
                self.read_file(&arg_text(args, 0, "Ungültiger Markdown-Pfad.")?)
            }
            "fanotes:write-file" => self.write_file(
                args.first().unwrap_or(&Value::Null),
                args.get(1).unwrap_or(&Value::Null),
            ),
            "fanotes:read-recognition-model" => self.read_recognition_model(),
            "fanotes:write-recognition-model" => self.write_recognition_model(&arg_text(
                args,
                0,
                "Das Handschriftmodell ist ungültig oder zu groß.",
            )?),
            "fanotes:create-note" => {
                self.create_entry(&loose_string(args, 0), loose_string_opt(args, 1), true)
            }
            "fanotes:create-folder" => {
                self.create_entry(&folder_parent(args)?, loose_string_opt(args, 1), false)
            }
            "fanotes:set-folder-color" => self.set_folder_color(
                &arg_text(args, 0, "Ungültiger Vault-Pfad.")?,
                args.get(1),
            ),
            "fanotes:rename-entry" => self.rename_entry(
                &arg_text(args, 0, "Ungültiger Vault-Pfad.")?,
                &loose_string(args, 1),
            ),
            "fanotes:move-entry" => self.move_entry(
                &arg_text(args, 0, "Ungültiger Vault-Pfad.")?,
                &loose_string(args, 1),
            ),
            "fanotes:trash-entry" => self.trash_entry(&arg_text(args, 0, "Ungültiger Vault-Pfad.")?),
            "fanotes:search" => self.search(&arg_text(args, 0, "Ungültige Suchanfrage.")?),
            "fanotes:list-drawings" => drawings::list_drawings(self),
            "fanotes:save-drawing" => {
                drawings::save_drawing(self, args.first().unwrap_or(&Value::Null))
            }
            "fanotes:read-drawing" => {
                drawings::read_drawing(self, &arg_text(args, 0, "Ungültige Zeichnungs-ID.")?)
            }
            "fanotes:read-famd-ink" => {
                self.read_famd_ink(&arg_text(args, 0, "Ungültiger Notizpfad.")?)
            }
            "fanotes:read-note-page-stats" => {
                notes::read_page_stats(self, &arg_text(args, 0, "Ungültiger Notizpfad.")?)
            }
            "fanotes:read-note-paper-style" => {
                notes::read_paper_style(self, &arg_text(args, 0, "Ungültiger Notizpfad.")?)
            }
            "fanotes:set-note-paper-style" => notes::set_paper_style(
                self,
                args.first().unwrap_or(&Value::Null),
                args.get(1).unwrap_or(&Value::Null),
            ),
            "fanotes:read-note-links" => {
                notes::read_links(self, &arg_text(args, 0, "Ungültiger Notizpfad.")?)
            }
            "fanotes:write-note-links" => notes::write_links(
                self,
                &arg_text(args, 0, "Ungültiger Notizpfad.")?,
                args.get(1).unwrap_or(&Value::Null),
            ),
            "fanotes:read-note-backups" => {
                notes::read_backups(self, &arg_text(args, 0, "Ungültiger Notizpfad.")?)
            }
            "fanotes:write-note-backups" => notes::write_backups(
                self,
                &arg_text(args, 0, "Ungültiger Notizpfad.")?,
                args.get(1).unwrap_or(&Value::Null),
            ),
            "fanotes:read-subject-books" => notes::read_subject_books(self),
            "fanotes:write-subject-books" => {
                notes::write_subject_books(self, args.first().unwrap_or(&Value::Null))
            }
            "fanotes:import-subject-book" => imports::import_subject_book(self, args),
            "fanotes:import-worksheet" => imports::import_worksheet(self),
            "fanotes:import-worksheet-from-data" => {
                worksheets::import_from_data(self, args.first().unwrap_or(&Value::Null))
            }
            "fanotes:import-pdf-note" => imports::import_pdf_note(self, args),
            "fanotes:import-onenote" => onenote::import_onenote(self, args),
            "fanotes:open-subject-book-popout" => {
                self.open_subject_book(&arg_text(args, 0, "Ungültiger Buchpfad.")?)
            }
            "fanotes:close-subject-book-popout" => Ok(json!({ "open": false })),
            "fanotes:read-worksheet" => {
                worksheets::read_worksheet(self, &arg_text(args, 0, "Ungültige Arbeitsblatt-ID.")?)
            }
            "fanotes:save-worksheet" => {
                worksheets::save_worksheet(self, args.first().unwrap_or(&Value::Null))
            }
            "fanotes:delete-worksheet" => {
                worksheets::delete_worksheet(self, &arg_text(args, 0, "Ungültige Arbeitsblatt-ID.")?)
            }
            "fanotes:list-note-history" => {
                notes::list_history(self, &arg_text(args, 0, "Ungültiger Vault-Pfad.")?)
            }
            "fanotes:read-note-history" => notes::read_history(
                self,
                &arg_text(args, 0, "Ungültiger Vault-Pfad.")?,
                args.get(1),
            ),
            "fanotes:export-note-pdf" => {
                Err("Das Fenster ist nicht bereit für den PDF-Export.".to_owned())
            }
            "fanotes:read-asset-data-url" => {
                self.read_asset_data_url(&arg_text(args, 0, "Ungültiger Bildpfad.")?)
            }
            "fanotes:read-asset-bytes" => {
                self.read_asset_bytes(&arg_text(args, 0, "Ungültiger Dateipfad.")?)
            }
            "fanotes:load-spelling-resources" => resources::load_spelling(),
            "fanotes:load-spelling-word-candidates" => resources::load_spelling_candidates(
                args.first().and_then(Value::as_str).unwrap_or(""),
            ),
            "fanotes:load-handwriting-recognition-resources" => resources::load_handwriting(),
            "fanotes:recognize-native-handwriting-line" => {
                let configured = self
                    .settings
                    .get("ocrThreadLimit")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                ocr::recognize_line(
                    args.first().unwrap_or(&Value::Null),
                    configured,
                    self.settings.get("ocrModelKeepAliveSeconds"),
                )
            }
            "fanotes:enhanced-math-get-state" => Ok(enhanced_math_state()),
            "fanotes:enhanced-math-install" | "fanotes:enhanced-math-recognize" => {
                Err("PosFormer ist nicht installiert.".to_owned())
            }
            "fanotes:qwen-vision-get-state" => Ok(qwen_vision_state()),
            "fanotes:qwen-vision-install" | "fanotes:qwen-vision-recognize" => {
                Err("Qwen Vision ist nicht installiert.".to_owned())
            }
            "fanotes:lm-studio-list-models" => {
                ai::list_lm_studio(args.first(), args.get(1))
            }
            "fanotes:lm-studio-transform" => {
                ai::transform_lm_studio(args.first().unwrap_or(&Value::Null))
            }
            "fanotes:ai-list-models" => ai::list_models(args.first().unwrap_or(&Value::Null)),
            "fanotes:ai-transform" => ai::transform(args.first().unwrap_or(&Value::Null)),
            "fanotes:load-secure-settings" => Ok(self.load_secure_settings()),
            "fanotes:save-settings" => self.save_settings(
                args.first().cloned().unwrap_or(Value::Null),
                args.get(1).unwrap_or(&Value::Null),
            ),
            "fanotes:reset-app-data" => self.reset_app_data(),
            "fanotes:update-get-state"
            | "fanotes:update-check"
            | "fanotes:update-download"
            | "fanotes:update-install" => Ok(self.update_state()),
            "fanotes:reveal-in-folder" => {
                self.reveal_in_folder(&arg_text(args, 0, "Ungültiger Vault-Pfad.")?)
            }
            "fanotes:open-external" => {
                self.open_external(&arg_text(args, 0, "Ungültiger externer Link.")?)
            }
            "fanotes:addons-fetch" => addons::fetch_text(&js_argument_string(args, 0)),
            "fanotes:addons-list" => addons::list(self),
            "fanotes:addons-save" => addons::save(self, args.first().unwrap_or(&Value::Null)),
            "fanotes:addons-remove" => {
                addons::remove(self, &arg_text(args, 0, "Ungültige Add-on-ID.")?)
            }
            "fanotes:addons-read-file" => addons::read_file(
                self,
                args.first().unwrap_or(&Value::Null),
                args.get(1).unwrap_or(&Value::Null),
            ),
            "fanotes:addons-write-files" => addons::write_files(
                self,
                args.first().unwrap_or(&Value::Null),
                args.get(1).unwrap_or(&Value::Null),
            ),
            "fanotes:addons-read-data" => {
                addons::read_data(self, &arg_text(args, 0, "Ungültige Add-on-ID.")?)
            }
            "fanotes:addons-write-data" => addons::write_data(
                self,
                args.first().unwrap_or(&Value::Null),
                args.get(1).unwrap_or(&Value::Null),
            ),
            "fanotes:addons-net-fetch" => addons::net_fetch(
                &js_argument_string(args, 0),
                args.get(1).unwrap_or(&Value::Null),
            ),
            "fanotes:sync-vault-id" => Ok(Value::String(self.vault_id()?)),
            "fanotes:sync-scan" => self.sync_scan(),
            "fanotes:sync-read" => self.sync_read(&arg_text(args, 0, "Ungültiger Sync-Pfad.")?),
            "fanotes:sync-write" => self.sync_write(args),
            "fanotes:sync-remove" => {
                self.sync_remove(&arg_text(args, 0, "Ungültiger Sync-Pfad.")?)
            }
            "fanotes:sync-read-state" => {
                self.read_sync_state(args.first().and_then(Value::as_str).unwrap_or(""))
            }
            "fanotes:sync-write-state" => self.write_sync_state(args),
            "fanotes:sync-read-secrets" => self.read_sync_secrets(),
            "fanotes:sync-write-secrets" => self.write_sync_secrets(args.first()),
            "fanotes:capture-window" => Err("Das Fensterbild ist ungültig.".to_owned()),
            "fanotes:render-pdf-page" => self.render_pdf_page(args),
            _ => Err(format!("Unbekannter Kanal: {channel}")),
        }
    }

    fn render_pdf_page(&self, args: &[Value]) -> Result<Value, String> {
        let (path, job) = fanotes_pdf::parse_vault_request(args.first().unwrap_or(&Value::Null))
            .map_err(|error| error.to_string())?;
        let file = vault::resolve_existing_entry(self.require_vault()?, &path)?;
        let bytes = read_regular_limited(&file, PDF_ASSET_MAX)?;
        let bitmap =
            fanotes_pdf::render_pdf_page(&bytes, &job).map_err(|error| error.to_string())?;
        if bitmap.rgba.len() > MAX_PDF_BITMAP_BYTES {
            return Err("Die PDF-Seite ist für den Transport zu groß.".to_owned());
        }
        Ok(json!({
            "width": bitmap.width,
            "height": bitmap.height,
            "rgbaBase64": bitmap.rgba_base64(),
        }))
    }

    fn read_asset_bytes(&self, relative: &str) -> Result<Value, String> {
        let mime = asset_mime(relative)
            .ok_or_else(|| "Dieser Dateityp ist für die Vorschau nicht erlaubt.".to_owned())?;
        let bytes = self.read_asset(relative, asset_limit(mime))?;
        Ok(Value::String(
            base64::engine::general_purpose::STANDARD.encode(bytes),
        ))
    }

    fn read_asset_data_url(&self, relative: &str) -> Result<Value, String> {
        let mime = asset_mime(relative)
            .ok_or_else(|| "Dieser Bildtyp ist für die Vorschau nicht erlaubt.".to_owned())?;
        let bytes = self.read_asset(relative, asset_limit(mime))?;
        Ok(Value::String(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )))
    }

    fn read_asset(&self, relative: &str, max: u64) -> Result<Vec<u8>, String> {
        let file = vault::resolve_asset_entry(self.require_vault()?, relative)?;
        // Desktop preview returns an existing empty file. A missing file fails above.
        read_regular_limited(&file, max)
    }

    fn sync_read(&self, relative: &str) -> Result<Value, String> {
        let (file, _) = vault::resolve_sync_path(self.require_vault()?, relative, false)?;
        let meta = fs::symlink_metadata(&file)
            .map_err(|error| vault::node_lstat_error(&file, &error))?;
        if !meta.is_file() {
            return Err("Die Datei ist keine reguläre Datei.".to_owned());
        }
        if meta.len() > SYNC_MAX_BYTES {
            return Err("Die Datei ist zu groß für den Sync.".to_owned());
        }
        let bytes = read_regular_limited(&file, SYNC_MAX_BYTES)?;
        Ok(Value::String(
            base64::engine::general_purpose::STANDARD.encode(bytes),
        ))
    }

    fn sync_write(&mut self, args: &[Value]) -> Result<Value, String> {
        let bytes = sync_bytes(args.get(1).unwrap_or(&Value::Null))?;
        let relative = args
            .get(0)
            .and_then(Value::as_str)
            .ok_or_else(|| "Ungültiger Sync-Pfad.".to_owned())?;
        let root = self.require_vault()?.to_path_buf();
        let (path, normalized) = vault::resolve_sync_path(&root, &relative, true)?;
        create_sync_directories(&root, &path)?;
        let mtime = arg_mtime_ms(args.get(2)).and_then(system_time_from_millis);
        notes::atomic_write_with_mtime(&path, &bytes, 0o600, mtime, 8)?;
        let meta = fs::symlink_metadata(&path)
            .map_err(|error| vault::node_lstat_error(&path, &error))?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err("Die Datei ist keine reguläre Datei.".to_owned());
        }
        Ok(json!({
            "path": normalized,
            "size": meta.len(),
            "mtimeMs": mtime_millis(&meta),
        }))
    }

    fn sync_remove(&mut self, relative: &str) -> Result<Value, String> {
        let root = self.require_vault()?;
        let (path, _) = vault::resolve_sync_path(root, relative, true)?;
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
            Err(error) => Err(vault::node_lstat_error(&path, &error)),
            Ok(meta) if meta.file_type().is_symlink() => {
                Err("Symbolische Links sind im Vault nicht erlaubt.".to_owned())
            }
            Ok(meta) if !meta.is_file() => {
                Err("Nur Dateien können über den Sync entfernt werden.".to_owned())
            }
            Ok(_) => {
                if send_to_trash(self, &path).is_err() {
                    fs::remove_file(&path)
                        .map_err(|error| vault::node_unlink_error(&path, &error))?;
                }
                Ok(Value::Null)
            }
        }
    }

    fn sync_scan(&self) -> Result<Value, String> {
        let root = self.require_vault()?;
        let mut entries = Vec::new();
        scan_sync_directory(root, root, 0, &mut entries);
        Ok(Value::Array(entries))
    }

    fn read_sync_state(&self, vault_id: &str) -> Result<Value, String> {
        let path = self.sync_state_path(vault_id)?;
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
            // Desktop `readState` rethrows every `lstat` error except ENOENT.
            Err(error) => Err(vault::node_lstat_error(&path, &error)),
            Ok(meta)
                if meta.file_type().is_symlink()
                    || !meta.is_file()
                    || meta.len() > MAX_SYNC_STATE_BYTES =>
            {
                Ok(Value::Null)
            }
            Ok(_) => match fs::read(&path) {
                Ok(bytes) => Ok(Value::String(String::from_utf8_lossy(&bytes).into_owned())),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
                Err(error) => Err(notes::node_open_error(&path, &error)),
            },
        }
    }

    fn write_sync_state(&self, args: &[Value]) -> Result<Value, String> {
        let vault_id = args.first().and_then(Value::as_str).unwrap_or("");
        let path = self.sync_state_path(vault_id)?;
        // Desktop `json === null` clears the file. A missing argument is
        // `undefined` and is rejected before anything is deleted.
        match args.get(1) {
            Some(Value::Null) => {
                remove_force(&path)?;
                Ok(Value::Null)
            }
            Some(Value::String(json)) => {
                if json.len() > MAX_SYNC_STATE_BYTES as usize {
                    return Err("Der Sync-Zustand ist ungültig.".to_owned());
                }
                if let Some(parent) = path.parent() {
                    ensure_private_profile_dir(parent)?;
                }
                notes::atomic_write(&path, json.as_bytes(), 0o600)?;
                Ok(Value::Null)
            }
            _ => Err("Der Sync-Zustand ist ungültig.".to_owned()),
        }
    }

    fn read_sync_secrets(&self) -> Result<Value, String> {
        let path = self.sync_secrets_path();
        // `readFile(..., 'utf8')` replaces a bad byte and still sees the prefix.
        let loaded = match fs::read(&path) {
            Ok(bytes) => Some(decode_sync_secret(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(notes::node_open_error(&path, &error)),
        };
        let raw = loaded.as_ref().map(|(text, _)| text.as_str());
        let valid_utf8 = loaded.as_ref().is_none_or(|(_, valid)| *valid);
        if raw.is_some_and(|value| value.starts_with("plain1:")) {
            let _ = fs::remove_file(&path);
            let _ = secrets::delete(self.secret_store, &self.secret_account(SYNC_SECRET_ACCOUNT));
            return Ok(Value::Null);
        }
        match secrets::get(self.secret_store, &self.secret_account(SYNC_SECRET_ACCOUNT)) {
            Ok(Some(secret)) => {
                if raw.is_some_and(|value| !value.starts_with("safe1:")) {
                    let _ = notes::atomic_write(&path, b"safe1:", 0o600);
                }
                Ok(Value::String(secret))
            }
            Ok(None) => self.read_legacy_sync_secret(raw, valid_utf8, &path),
            Err(error) => {
                if raw.is_some_and(|value| value.starts_with("safe1:")) {
                    Err(error)
                } else {
                    Ok(Value::Null)
                }
            }
        }
    }

    fn read_legacy_sync_secret(
        &self,
        raw: Option<&str>,
        valid_utf8: bool,
        path: &Path,
    ) -> Result<Value, String> {
        let Some(raw) = raw else {
            return Ok(Value::Null);
        };
        if raw.starts_with("safe1:") {
            return Err(secrets::KEYRING_UNAVAILABLE.to_owned());
        }
        // A file of only JavaScript whitespace has no login. A bad byte is not
        // a legacy secret either: the desktop returns no login.
        if !valid_utf8 || vault::js_trim(raw).is_empty() {
            return Ok(Value::Null);
        }
        secrets::set(
            self.secret_store,
            &self.secret_account(SYNC_SECRET_ACCOUNT),
            raw,
        )?;
        notes::atomic_write(path, b"safe1:", 0o600)?;
        Ok(Value::String(raw.to_owned()))
    }

    fn write_sync_secrets(&self, incoming: Option<&Value>) -> Result<Value, String> {
        let path = self.sync_secrets_path();
        let account = self.secret_account(SYNC_SECRET_ACCOUNT);
        // Only an explicit null clears the login. A missing argument is undefined.
        match incoming {
            Some(Value::Null) => {
                secrets::delete(self.secret_store, &account)?;
                remove_force(&path)?;
                Ok(Value::Null)
            }
            Some(Value::String(json)) => {
                if vault::utf16_len(json) > 64 * 1024 {
                    return Err("Die Sync-Anmeldedaten sind ungültig.".to_owned());
                }
                secrets::set(self.secret_store, &account, json)?;
                if let Some(parent) = path.parent() {
                    ensure_private_profile_dir(parent)?;
                }
                notes::atomic_write(&path, b"safe1:", 0o600)?;
                Ok(Value::Null)
            }
            _ => Err("Die Sync-Anmeldedaten sind ungültig.".to_owned()),
        }
    }

    fn sync_state_path(&self, vault_id: &str) -> Result<PathBuf, String> {
        if !is_vault_id(vault_id) {
            return Err("Ungültige Vault-ID.".to_owned());
        }
        Ok(self
            .app_data
            .join("sync")
            .join(format!("state-{vault_id}.json")))
    }

    fn sync_secrets_path(&self) -> PathBuf {
        self.app_data.join("sync").join("account.secret")
    }

    fn read_recognition_model(&self) -> Result<Value, String> {
        let root = self.require_vault()?.to_path_buf();
        let path = recognition_model_path(&root)?;
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
            Err(error) => Err(vault::node_lstat_error(&path, &error)),
            Ok(_) => {
                // Desktop opens with `O_NOFOLLOW`, then checks the size on that handle.
                let mut options = fs::OpenOptions::new();
                options.read(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.custom_flags(libc::O_NOFOLLOW);
                }
                let mut file = options
                    .open(&path)
                    .map_err(|error| notes::node_open_error(&path, &error))?;
                let meta = file
                    .metadata()
                    .map_err(|error| notes::node_open_error(&path, &error))?;
                if meta.len() > MAX_RECOGNITION_MODEL_BYTES {
                    return Err("Die Datei ist zu groß.".to_owned());
                }
                let mut bytes = Vec::new();
                std::io::Read::read_to_end(&mut file, &mut bytes)
                    .map_err(|error| notes::node_open_error(&path, &error))?;
                Ok(Value::String(String::from_utf8_lossy(&bytes).into_owned()))
            }
        }
    }

    fn write_recognition_model(&mut self, content: &str) -> Result<Value, String> {
        if content.len() > MAX_RECOGNITION_MODEL_BYTES as usize {
            return Err("Das Handschriftmodell ist ungültig oder zu groß.".to_owned());
        }
        let root = self.require_vault()?.to_path_buf();
        let path = recognition_model_path(&root)?;
        // Desktop `mkdir` is recursive, creates a missing `.fanotes`, and
        // leaves a leftover `.lernwerk` folder. Any other failure is that mkdir.
        if let Some(parent) = path.parent() {
            match fs::create_dir(parent) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(vault::node_mkdir_error(parent, &error)),
            }
        }
        notes::atomic_write(&path, content.as_bytes(), 0o600)?;
        let modified = fs::symlink_metadata(&path)
            .ok()
            .and_then(|meta| meta.modified().ok())
            .map(notes::iso_from_system_time)
            .unwrap_or_else(notes::iso_now);
        Ok(json!({ "modifiedAt": modified }))
    }

    fn dispatch_message(&mut self, channel: &str) -> Result<Value, String> {
        if channel == "fanotes:confirm-close" {
            self.close_requested = true;
            self.allow_close = true;
        }
        if channel == "fanotes:request-close" {
            self.close_requested = true;
        }
        if channel == "fanotes:cancel-close" {
            self.close_requested = false;
            self.allow_close = false;
        }
        Ok(Value::Null)
    }

    fn bootstrap(&mut self) -> Result<Value, String> {
        self.try_attach_configured_vault();
        if self.vault.is_none() {
            if let Some(path) = self.configured_vault.clone() {
                // Desktop `path.resolve` drops `..` and a trailing slash before
                // the shell shows the vault or looks up its tree cache.
                return Ok(self.bootstrap_payload(&node_resolve(&path)));
            }
            self.ensure_default_vault()?;
        }
        let vault = self.require_vault()?.to_path_buf();
        Ok(self.bootstrap_payload(&vault))
    }

    fn bootstrap_payload(&self, vault: &Path) -> Value {
        json!({
            "vaultPath": vault,
            "vaultName": vault.file_name().and_then(|name| name.to_str()).unwrap_or("Vault"),
            "settings": self.settings,
            "onboardingRequired": self.onboarding_required,
            "starterSubjects": onboarding::starter_subjects(self.ui_language()),
            "linuxRuntime": linux_runtime::bootstrap_linux()
        })
    }

    /// Open a remembered vault once its folder exists.
    ///
    /// `readConfig` keeps the path while a network volume is absent. The
    /// documents folder is only created when no vault path is stored.
    /// Write access is checked later, on the commands that call `ensureBootstrap`.
    fn try_attach_configured_vault(&mut self) {
        if self.vault.is_some() {
            return;
        }
        let Some(path) = self.configured_vault.clone() else {
            return;
        };
        if path.is_dir() {
            let _ = self.set_vault(path);
        }
    }

    fn ensure_default_vault(&mut self) -> Result<(), String> {
        if self.vault.is_some() {
            return Ok(());
        }
        let documents = match self.documents_dir.clone() {
            Some(path) => path,
            None => default_documents_dir(),
        };
        let vault = documents.join("FaNotes");
        let created = match fs::symlink_metadata(&vault) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err(format!(
                    "Der Standard-Vault kann nicht unter {} angelegt werden.",
                    vault.display()
                ));
            }
            Ok(_) => false,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Desktop `mkdir` is recursive and rethrows that error.
                fs::create_dir_all(&vault)
                    .map_err(|error| vault::node_mkdir_error(&vault, &error))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(&vault, fs::Permissions::from_mode(0o700));
                }
                true
            }
            Err(error) => return Err(vault::node_lstat_error(&vault, &error)),
        };
        if created {
            let language = self.ui_language();
            let note = vault.join(onboarding::welcome_file_name(language));
            notes::atomic_write(&note, onboarding::welcome_note(language).as_bytes(), 0o600)?;
            onboarding::write_status(&vault, "pending")?;
        }
        // Desktop `persistConfig` runs before `setCurrentVaultPath`. A failed
        // write of the remembered path leaves the vault unset.
        let stored = validated_vault_directory(&vault)?;
        notes::atomic_write(
            &self.app_data.join("vault-path"),
            stored.to_string_lossy().as_bytes(),
            0o600,
        )?;
        self.set_vault(stored)?;
        Ok(())
    }

    fn tree(&self, stats: bool) -> Result<Value, String> {
        let root = self.require_vault()?;
        let colors = read_folder_colors(root)?;
        let entries = read_tree(root, root, &colors, 0, stats)?;
        write_tree_cache(&self.app_data, root, &entries);
        Ok(entries)
    }

    fn cached_tree(&self) -> Result<Value, String> {
        let root = self
            .vault
            .as_ref()
            .or(self.configured_vault.as_ref())
            .ok_or_else(|| "Der Vault ist noch nicht initialisiert.".to_owned())?;
        Ok(read_tree_cache(&self.app_data, root).unwrap_or(Value::Null))
    }

    fn complete_onboarding(&mut self, args: &[Value]) -> Result<Value, String> {
        let selected = onboarding::validate_selection(args.first().unwrap_or(&Value::Null))?;
        ensure_remembered_vault_writable(self)?;
        if !self.onboarding_required {
            return self.bootstrap();
        }
        let root = self.require_vault()?.to_path_buf();
        let language = self.ui_language();
        for (name, _) in onboarding::folders_to_create(language, &selected) {
            onboarding::ensure_folder(&root, name)?;
        }
        let mut colors = read_folder_colors(&root)?;
        for (name, color) in onboarding::folders_to_create(language, &selected) {
            colors.insert(name.to_owned(), color.to_owned());
        }
        write_folder_colors(&root, &colors)?;
        onboarding::write_status(&root, "complete")?;
        if language == "en" {
            if self.settings.get("defaultFolder").and_then(Value::as_str) == Some("Eingang") {
                self.settings
                    .insert("defaultFolder".to_owned(), json!("Inbox"));
            }
            if self
                .settings
                .get("dailyNotesFolder")
                .and_then(Value::as_str)
                == Some("Tagesnotizen")
            {
                self.settings
                    .insert("dailyNotesFolder".to_owned(), json!("Daily Notes"));
            }
            if self
                .settings
                .get("recognitionLanguage")
                .and_then(Value::as_str)
                == Some("de")
            {
                self.settings
                    .insert("recognitionLanguage".to_owned(), json!("en"));
            }
        }
        // Desktop `persistConfig` finishes before `currentOnboardingRequired`
        // becomes false. A failed settings write leaves setup open.
        self.persist_settings()?;
        self.onboarding_required = false;
        self.bootstrap()
    }

    pub fn ui_language(&self) -> &'static str {
        match self.settings.get("uiLanguage").and_then(Value::as_str) {
            Some("de") => "de",
            Some("en") => "en",
            _ => current_system_ui_language(),
        }
    }

    fn refresh_onboarding(&mut self) {
        self.onboarding_required =
            self.vault.as_deref().and_then(onboarding::read_status) == Some("pending");
    }

    fn read_file(&self, relative: &str) -> Result<Value, String> {
        // Desktop `assertMarkdownPath` runs on the raw path, before `normalizeRelativePath`.
        if !notes::is_note_text(relative) {
            return Err("Es dürfen nur Markdown-Dateien und FaNotes-Handschriftdateien (.famd) bearbeitet werden.".to_owned());
        }
        let normalized = vault::normalize_relative_path(relative, false, false)?;
        let path = vault::resolve_present_note_file(self.require_vault()?, &normalized)?;
        let limit = note_byte_limit(&normalized);
        let meta = fs::symlink_metadata(&path)
            .map_err(|error| vault::node_lstat_error(&path, &error))?;
        if meta.file_type().is_symlink() {
            return Err("Symbolische Links sind innerhalb des Vaults nicht erlaubt.".to_owned());
        }
        if !meta.is_file() {
            return Err("Die gewählte Datei ist keine reguläre Datei.".to_owned());
        }
        // Desktop `readRegularFileNoFollow` opens before the size check. An
        // unreadable oversized note is that open error.
        let bytes = notes::read_nofollow_limited(&path, limit)?;
        let text = String::from_utf8_lossy(&bytes);
        Ok(Value::String(fanotes_famd::strip_famd_payload(&text)))
    }

    fn write_file(&mut self, relative: &Value, content: &Value) -> Result<Value, String> {
        let relative = relative
            .as_str()
            .ok_or_else(|| "Ungültiger Vault-Pfad.".to_owned())?;
        let normalized = vault::normalize_relative_path(relative, false, false)?;
        if !notes::is_note_text(&normalized) {
            return Err("Es dürfen nur Markdown-Dateien und FaNotes-Handschriftdateien (.famd) bearbeitet werden.".to_owned());
        }
        let content = content
            .as_str()
            .ok_or_else(|| "Der Notizinhalt ist ungültig oder zu groß.".to_owned())?;
        if content.len() as u64 > note_byte_limit(&normalized) {
            return Err("Der Notizinhalt ist ungültig oder zu groß.".to_owned());
        }
        ensure_remembered_vault_writable(self)?;
        if self.onboarding_required {
            return Err("Bitte schließe zuerst die FaNotes-Ersteinrichtung ab.".to_owned());
        }
        let root = self.require_vault()?.to_path_buf();
        let path = vault::resolve_note_file(&root, &normalized)?;
        if notes::records_history(&normalized) {
            if let Some(text) = notes::read_lossy_string(&path) {
                let _ = notes::record_history(&root, &normalized, &text);
            }
        }
        let paper = self
            .settings
            .get("paperStyle")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let modified = notes::write_note_file(&root, &normalized, content, paper.as_deref())?;
        Ok(json!({ "modifiedAt": modified }))
    }

    fn create_entry(
        &mut self,
        parent: &str,
        preferred: Option<String>,
        note: bool,
    ) -> Result<Value, String> {
        let root = self.require_vault()?.to_path_buf();
        let parent_relative = if parent.is_empty() {
            String::new()
        } else {
            vault::normalize_relative_path(parent, true, false)?
        };
        // Desktop resolveVaultPath runs before safeEntryName.
        let parent_path = if parent_relative.is_empty() {
            root.clone()
        } else {
            vault::reject_symlinks(&root, &parent_relative)?;
            let path = vault::resolve_existing_entry(&root, &parent_relative)?;
            let meta = fs::symlink_metadata(&path)
                .map_err(|_| "Der Zielordner wurde nicht gefunden.".to_owned())?;
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err("Der gewählte Pfad ist kein Ordner.".to_owned());
            }
            path
        };
        let english = self.ui_language() == "en";
        let fallback = if note {
            if english {
                "Untitled note"
            } else {
                "Unbenannte Notiz"
            }
        } else if english {
            "New folder"
        } else {
            "Neuer Ordner"
        };
        let preferred = preferred
            .as_deref()
            .filter(|name| !vault::js_trim(name).is_empty())
            .unwrap_or(fallback);
        let mut desired = safe_entry_name(preferred)?;
        if note {
            let extension = entry_extension(&desired);
            if extension.is_empty() {
                desired = format!("{desired}.md");
            } else if !matches!(extension.as_str(), ".md" | ".markdown" | ".famd") {
                return Err("Neue Notizen müssen Markdown-Dateien sein.".to_owned());
            }
        }
        let paper = self
            .settings
            .get("paperStyle")
            .and_then(Value::as_str)
            .map(str::to_owned);
        for _attempt in 0..10_000 {
            let candidate = available_entry_name(&parent_path, &desired, note)?;
            let relative = if parent_relative.is_empty() {
                candidate.clone()
            } else {
                format!("{parent_relative}/{candidate}")
            };
            let path = parent_path.join(&candidate);
            if !vault::is_inside_root(&root, &path) {
                return Err("Der Pfad liegt außerhalb des Vaults.".to_owned());
            }
            let (title, _) = split_entry_name(&candidate);
            let markdown = format!("# {title}\n\n");
            let created = if note {
                create_exclusive_note(&path, &markdown)
            } else {
                create_exclusive_folder(&path)
            };
            match created {
                Ok(()) => {
                    if note {
                        let _ =
                            notes::attach_sidecar(&root, &relative, &markdown, paper.as_deref());
                    }
                    return Ok(created_entry(&relative, &path, note));
                }
                Err(CreateAttempt::Taken) => continue,
                Err(CreateAttempt::Failed(message)) => return Err(message),
            }
        }
        Err(if note {
            "Es konnte kein eindeutiger Notizname erzeugt werden.".to_owned()
        } else {
            "Es konnte kein eindeutiger Ordnername erzeugt werden.".to_owned()
        })
    }

    fn select_vault(&mut self, args: &[Value]) -> Result<Value, String> {
        let path = if let Some(text) = args.first().and_then(Value::as_str) {
            if text.is_empty() {
                return Err("Der Vault wurde unsicher verändert.".to_owned());
            }
            PathBuf::from(text)
        } else if !self.file_dialogs {
            return Ok(Value::Null);
        } else {
            let Some(path) = rfd::FileDialog::new()
                .set_title(crate::dialogs::vault_picker_title(self.ui_language()))
                .pick_folder()
            else {
                return Ok(Value::Null);
            };
            path
        };
        let stored = validated_vault_directory(&path)?;
        // Desktop `fs.access(realpath, R_OK | W_OK)` rejects a folder the
        // process cannot write. The thrown message is Node's EACCES text.
        // The profile write then has to succeed before the vault changes.
        if let Some(error) = vault_write_access_error(&stored) {
            return Err(error);
        }
        notes::atomic_write(
            &self.app_data.join("vault-path"),
            stored.to_string_lossy().as_bytes(),
            0o600,
        )?;
        self.set_vault(stored)?;
        self.bootstrap()
    }

    fn set_folder_color(
        &mut self,
        relative: &str,
        color: Option<&Value>,
    ) -> Result<Value, String> {
        let root = self.require_vault()?.to_path_buf();
        let normalized = vault::normalize_relative_path(relative, false, false)?;
        // Desktop checks the hex color after the path shape and before the folder exists.
        // Only an explicit null clears the color. A missing argument is undefined.
        let stored = match color {
            Some(Value::Null) => None,
            Some(Value::String(value)) if folder_color_hex(value) => {
                Some(value.to_ascii_lowercase())
            }
            _ => return Err("Ungültige Ordnerfarbe.".to_owned()),
        };
        let path = vault::resolve_existing_entry(&root, &normalized)?;
        let meta = fs::symlink_metadata(&path)
            .map_err(|_| "Der Ordner wurde nicht gefunden.".to_owned())?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err("Der gewählte Pfad ist kein Ordner.".to_owned());
        }
        let mut colors = read_folder_colors(&root)?;
        if let Some(color) = stored.clone() {
            colors.insert(normalized.clone(), color);
        } else {
            colors.remove(&normalized);
        }
        write_folder_colors(&root, &colors)?;
        Ok(json!({ "color": stored }))
    }

    fn open_subject_book(&self, relative: &str) -> Result<Value, String> {
        // The desktop opens the popout after the path shape and extension.
        // The window reads the file later, so a missing book still opens.
        self.require_vault()?;
        let path = vault::normalize_relative_path(relative, false, false)?;
        let extension = vault::posix_extname_en_us(&path);
        if !matches!(extension.as_str(), ".md" | ".markdown" | ".famd" | ".pdf") {
            return Err("Es dürfen nur Markdown-Dateien, PDF-Notizen und FaNotes-Handschriftdateien (.famd) bearbeitet werden.".to_owned());
        }
        if extension != ".pdf" {
            return Err("Nur ein PDF-Buch kann auspoppen.".to_owned());
        }
        Ok(json!({ "open": true, "bookPath": path }))
    }

    fn rename_entry(&mut self, relative: &str, next_name: &str) -> Result<Value, String> {
        let root = self.require_vault()?.to_path_buf();
        let source = vault::resolve_existing_entry(&root, relative)?;
        let normalized = vault::normalize_relative_path(relative, false, false)?;
        let meta = fs::symlink_metadata(&source)
            .map_err(|error| vault::node_lstat_error(&source, &error))?;
        if meta.file_type().is_symlink() || (!meta.is_file() && !meta.is_dir()) {
            return Err("Dieser Eintrag kann nicht umbenannt werden.".to_owned());
        }
        let was_dir = meta.is_dir();
        let current_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Ungültiger Name.".to_owned())?
            .to_owned();
        let name_input = if vault::js_trim(next_name).is_empty() {
            current_name.as_str()
        } else {
            next_name
        };
        let mut desired = safe_entry_name(name_input)?;
        if !was_dir {
            if entry_extension(&desired).is_empty() {
                desired.push_str(&entry_extension(&current_name));
            }
            let extension = entry_extension(&desired);
            if !tree_extension(extension.trim_start_matches('.')) {
                return Err("Dieser Dateityp wird nicht unterstützt.".to_owned());
            }
        }
        // Desktop returns the path the caller sent when the name does not change.
        if desired == current_name {
            return Ok(Value::String(relative.to_owned()));
        }
        let parent = source.parent().unwrap_or(&root).to_path_buf();
        // Desktop `availableName` ignores the companion. `Ziel.famd` does not
        // block `Ziel.md`; the companion rename replaces that file.
        let unique = unique_sibling_name(&parent, &desired, Some(current_name.as_str()), None)?;
        let destination = parent.join(&unique);
        if !vault::is_inside_root(&root, &destination) {
            return Err("Der Pfad liegt außerhalb des Vaults.".to_owned());
        }
        fs::rename(&source, &destination)
            .map_err(|error| vault::node_rename_error(&source, &destination, &error))?;
        let next = relative_from_root(&root, &destination);
        if !was_dir {
            move_note_companion(&root, &normalized, &next);
        }
        // Desktop rename always rewrites folder colors. That read creates
        // `.fanotes` or renames a leftover `.lernwerk` folder into place.
        let _ = retarget_folder_colors(&root, &normalized, &next);
        Ok(Value::String(next))
    }

    fn move_entry(&mut self, relative: &str, dest_folder: &str) -> Result<Value, String> {
        let root = self.require_vault()?.to_path_buf();
        let source = vault::resolve_existing_entry(&root, relative)?;
        let normalized = vault::normalize_relative_path(relative, false, false)?;
        let meta = fs::symlink_metadata(&source)
            .map_err(|error| vault::node_lstat_error(&source, &error))?;
        if meta.file_type().is_symlink() || (!meta.is_file() && !meta.is_dir()) {
            return Err("Dieser Eintrag kann nicht verschoben werden.".to_owned());
        }
        let was_dir = meta.is_dir();
        // A blank destination is the vault root. Any other path is normalized
        // without `allowRoot`, so `./` is the vault itself and is refused.
        let dest_relative = if vault::js_trim(dest_folder).is_empty() {
            String::new()
        } else {
            vault::normalize_relative_path(dest_folder, false, false)?
        };
        let folder = if dest_relative.is_empty() {
            root.clone()
        } else {
            let path = vault::resolve_existing_entry(&root, &dest_relative)?;
            let folder_meta = fs::symlink_metadata(&path)
                .map_err(|_| "Der Zielordner wurde nicht gefunden.".to_owned())?;
            if folder_meta.file_type().is_symlink() || !folder_meta.is_dir() {
                return Err("Der gewählte Pfad ist kein Ordner.".to_owned());
            }
            path
        };
        // Desktop resolves the destination before it rejects a move into itself.
        if was_dir
            && (dest_relative == normalized || dest_relative.starts_with(&format!("{normalized}/")))
        {
            return Err("Ein Ordner kann nicht in sich selbst verschoben werden.".to_owned());
        }
        if source.parent() == Some(folder.as_path()) {
            return Ok(Value::String(normalized));
        }
        let current_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Ungültiger Name.".to_owned())?;
        let unique = unique_sibling_name(
            &folder,
            current_name,
            None,
            companion_extension(was_dir, current_name),
        )?;
        let destination = folder.join(&unique);
        if !vault::is_inside_root(&root, &destination) {
            return Err("Das Verschiebeziel liegt außerhalb des Vaults.".to_owned());
        }
        fs::rename(&source, &destination)
            .map_err(|error| vault::node_rename_error(&source, &destination, &error))?;
        let next = relative_from_root(&root, &destination);
        if !was_dir {
            move_note_companion(&root, &normalized, &next);
        }
        let _ = retarget_folder_colors(&root, &normalized, &next);
        Ok(Value::String(next))
    }

    fn trash_entry(&mut self, relative: &str) -> Result<Value, String> {
        let root = self.require_vault()?.to_path_buf();
        let normalized = vault::normalize_relative_path(relative, false, false)?;
        let path = vault::resolve_existing_entry(&root, &normalized)?;
        let is_dir = fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir());
        send_to_trash(self, &path)?;
        if !is_dir {
            if let Some(companion) = note_companion_relative(&normalized) {
                if let Ok(companion_path) = vault::resolve_existing_entry(&root, &companion) {
                    if fs::symlink_metadata(&companion_path)
                        .is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink())
                    {
                        let _ = send_to_trash(self, &companion_path);
                    }
                }
            }
        }
        let _ = forget_folder_colors(&root, &normalized);
        Ok(Value::Null)
    }

    fn search(&self, query: &str) -> Result<Value, String> {
        let query = vault::js_trim(query);
        if query.is_empty() {
            return Ok(json!([]));
        }
        let query = vault::truncate_utf16(query, 500);
        let root = self.require_vault()?;
        let needle = vault::locale_lower_de(&query);
        let mut files = Vec::new();
        collect_search_files(root, root, &mut files, 0)?;
        let present: std::collections::HashSet<String> =
            files.iter().map(|file| file.relative.clone()).collect();
        let mut hits = Vec::new();
        let mut owners = std::collections::HashMap::new();
        for file in files {
            let relative = file.relative;
            let lower = relative.to_lowercase();
            if lower.ends_with(".famd") {
                let stem = fanotes_famd::note_stem(&relative);
                // The desktop hides a handwriting file beside `.md` or `.pdf`.
                // A `.markdown` note does not hide it.
                if present.contains(&format!("{stem}.md"))
                    || present.contains(&format!("{stem}.pdf"))
                {
                    continue;
                }
            }
            // The directory walk already has this file, matching the desktop read of absolutePath.
            let path = file.path;
            let raw = if lower.ends_with(".pdf") {
                String::new()
            } else {
                match notes::read_lossy_string(&path) {
                    Some(text) => text,
                    None => continue,
                }
            };
            let parsed = fanotes_famd::parse_famd(&raw);
            let mut content = if parsed.markdown.is_empty() {
                fanotes_famd::strip_famd_payload(&raw)
            } else {
                parsed.markdown
            };
            let mut ink = parsed
                .payload
                .as_ref()
                .and_then(|payload| payload.ink.clone());
            let mut transcript = ink_transcript(ink.as_ref());
            if !lower.ends_with(".famd") {
                let famd = fanotes_famd::companion_note_path(&relative, ".famd");
                if let Ok(companion_path) = vault::resolve_existing_entry(root, &famd) {
                    if let Some(companion) = read_search_companion(&companion_path) {
                        let parsed_companion = fanotes_famd::parse_famd(&companion);
                        if lower.ends_with(".pdf") && !parsed_companion.markdown.is_empty() {
                            content = parsed_companion.markdown;
                        }
                        if let Some(companion_ink) = parsed_companion
                            .payload
                            .as_ref()
                            .and_then(|payload| payload.ink.clone())
                        {
                            // The companion is the handwriting the note opens.
                            // A string transcript there replaces one embedded in
                            // the markdown file, including an empty string.
                            if let Some(text) = companion_ink
                                .get("searchTranscript")
                                .and_then(Value::as_str)
                            {
                                transcript = bounded_transcript(text);
                            }
                            ink = Some(companion_ink);
                        }
                    }
                }
            }
            remember_drawing_owner(&mut owners, &relative, &content, ink.as_ref());
            let haystack = vault::locale_lower_de(&format!("{relative}\n{content}\n{transcript}"));
            if !haystack.contains(&needle) {
                continue;
            }
            let matches = count_matches(&haystack, &needle);
            let content_index = vault::locale_lower_de(&content).find(&needle);
            let excerpt = if let Some(index) = content_index {
                let (start, _) = original_match_span(&content, &needle, index);
                excerpt(&content, start, vault::utf16_len(&query))
            } else {
                format!("Dateiname · {relative}")
            };
            let title = search_title(&relative);
            let mut hit = json!({
                "relativePath": relative,
                "title": title,
                "excerpt": excerpt,
                "matches": matches,
                "kind": "note",
            });
            if let Some(anchor) = ink_anchor(&transcript, &query) {
                hit["inkAnchor"] = json!({ "y": anchor });
            }
            hits.push(hit);
        }
        search_drawings(root, &needle, &query, &owners, &mut hits)?;
        hits.sort_by(|left, right| {
            right["matches"]
                .as_u64()
                .unwrap_or(0)
                .cmp(&left["matches"].as_u64().unwrap_or(0))
                .then_with(|| {
                    dictionary_order(
                        left["title"].as_str().unwrap_or(""),
                        right["title"].as_str().unwrap_or(""),
                    )
                })
        });
        hits.truncate(250);
        Ok(Value::Array(hits))
    }

    fn read_famd_ink(&self, relative: &str) -> Result<Value, String> {
        drawings::read_famd_ink(self, relative)
    }

    fn save_settings(&mut self, incoming: Value, options: &Value) -> Result<Value, String> {
        // Desktop sanitizeSettings keeps the current settings when the payload
        // is not a plain object. Clearing protected secrets still applies.
        let clear = options
            .get("clearProtectedSecrets")
            .and_then(Value::as_bool)
            == Some(true);
        let mut secrets = self.load_secrets();
        if clear {
            for key in SECRET_KEYS {
                secrets.insert((*key).to_owned(), Value::String(String::new()));
            }
        } else if let Some(object) = incoming.as_object() {
            for key in SECRET_KEYS {
                let Some(value) = object.get(*key).and_then(Value::as_str) else {
                    continue;
                };
                let limit = if *key == "homeworkApiSecret" {
                    256
                } else {
                    4096
                };
                if value.contains('\0') || vault::utf16_len(value) > limit {
                    continue;
                }
                if value.is_empty() && !self.secrets_loaded {
                    continue;
                }
                secrets.insert((*key).to_owned(), Value::String(value.to_owned()));
            }
        }
        // Desktop `persistConfig` finishes before `currentSettings` changes.
        // A failed atomic write leaves the previous settings in memory.
        let mut next = settings::sanitize(&incoming, &self.settings);
        for key in SECRET_KEYS {
            next.insert((*key).to_owned(), Value::String(String::new()));
        }
        settings::gate_experimental_handwriting(&mut next, APP_VERSION);
        persist_settings_file(&self.app_data, &next)?;
        // A missing keyring must not block the rest of the settings, and must
        // not leave the new key in the profile file.
        let _ = self.store_secrets(&secrets);
        self.settings = next;
        Ok(json!(self.settings))
    }

    fn load_secure_settings(&mut self) -> Value {
        self.secrets_loaded = true;
        self.secret_snapshot()
    }

    fn secret_snapshot(&self) -> Value {
        let secrets = self.load_secrets();
        let mut object = Map::new();
        for key in SECRET_KEYS {
            object.insert(
                (*key).to_owned(),
                secrets
                    .get(*key)
                    .cloned()
                    .unwrap_or(Value::String(String::new())),
            );
        }
        Value::Object(object)
    }

    fn reset_app_data(&mut self) -> Result<Value, String> {
        let Some(marker_path) = pending_reset_marker(&self.app_data) else {
            return Err("Die App-Daten konnten nicht zurückgesetzt werden.".to_owned());
        };
        if valid_reset_marker(&marker_path, &self.app_data) {
            self.allow_close = true;
            return Ok(json!({ "restarting": true }));
        }
        let user_data = node_resolve(&self.app_data);
        let marker = json!({
            "version": 1,
            "userDataPath": user_data.to_string_lossy(),
            "createdAt": notes::iso_now(),
        });
        let text = serde_json::to_string(&marker)
            .map_err(|_| "Die App-Daten konnten nicht zurückgesetzt werden.".to_owned())?;
        notes::atomic_write(&marker_path, format!("{text}\n").as_bytes(), 0o600)?;
        self.allow_close = true;
        Ok(json!({ "restarting": true }))
    }

    fn open_external(&self, url: &str) -> Result<Value, String> {
        let href = http_link(url)?;
        self.launch("open", &href)
    }

    fn reveal_in_folder(&self, relative: &str) -> Result<Value, String> {
        let root = self.require_vault()?.to_path_buf();
        let target = reveal_target(&root, relative)?;
        self.launch("reveal", &target.to_string_lossy())
    }

    fn launch(&self, kind: &str, target: &str) -> Result<Value, String> {
        if let Some(log) = &self.open_log {
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(log)
                .map_err(|_| "Der Link konnte nicht geöffnet werden.".to_owned())?;
            use std::io::Write;
            writeln!(file, "{kind} {target}")
                .map_err(|_| "Der Link konnte nicht geöffnet werden.".to_owned())?;
            return Ok(Value::Null);
        }
        match kind {
            "reveal" => reveal_on_desktop(Path::new(target)),
            _ => spawn_detached("xdg-open", &[target.to_owned()]),
        }
        .map(|()| Value::Null)
    }

    fn update_state(&self) -> Value {
        let enabled = |key| self.settings.get(key).and_then(Value::as_bool) != Some(false);
        let channel = if self.settings.get("updateChannel").and_then(Value::as_str) == Some("beta")
        {
            "beta"
        } else {
            "stable"
        };
        json!({
            "status": "idle",
            "supported": false,
            "currentVersion": APP_VERSION,
            "latestVersion": null,
            "publishedAt": null,
            "releaseNotes": [],
            "downloadedBytes": 0,
            "totalBytes": 0,
            "progress": 0,
            "error": null,
            "block": null,
            "checkedAt": null,
            "installationKind": installation_kind(),
            "autoCheckUpdates": enabled("autoCheckUpdates"),
            "autoDownloadUpdates": enabled("autoDownloadUpdates"),
            "installUpdatesOnQuit": enabled("installUpdatesOnQuit"),
            "updateChannel": channel,
            "releaseHost": "electron"
        })
    }

    fn vault_id(&self) -> Result<String, String> {
        let path = self.require_vault()?;
        Ok(vault_path_digest(path)[..32].to_owned())
    }

    fn persist_settings(&self) -> Result<(), String> {
        persist_settings_file(&self.app_data, &self.settings)
    }

    fn load_persisted(&mut self) {
        profile::import_electron_profile(&self.app_data, self.secret_store);
        if let Ok(bytes) = fs::read(self.app_data.join("settings.json")) {
            let text = String::from_utf8_lossy(&bytes);
            if let Ok(parsed) = serde_json::from_str::<Value>(&text) {
                self.settings = settings::sanitize(&parsed, &default_settings());
                for key in SECRET_KEYS {
                    self.settings
                        .insert((*key).to_owned(), Value::String(String::new()));
                }
                if settings::gate_experimental_handwriting(&mut self.settings, APP_VERSION) {
                    let _ = self.persist_settings();
                }
            }
        }
        if let Ok(text) = fs::read_to_string(self.app_data.join("vault-path")) {
            // The profile import appends one newline. A trailing space belongs
            // to the folder name, so this is not `String.prototype.trim`.
            let path = PathBuf::from(stored_vault_path(&text));
            if path.as_os_str().is_empty() {
                return;
            }
            // An absolute path is the configured vault even while it is missing.
            // A relative path is used only when that folder already exists.
            if path.is_absolute() {
                self.configured_vault = Some(path.clone());
            }
            if path.is_dir() {
                let _ = self.set_vault(path);
            }
        }
    }

    fn secret_account(&self, name: &str) -> String {
        secrets::account(&self.app_data, name)
    }

    fn load_secrets(&self) -> Map<String, Value> {
        self.migrate_plaintext_secrets();
        let mut object = Map::new();
        for key in SECRET_KEYS {
            if let Ok(Some(value)) = secrets::get(self.secret_store, &self.secret_account(key)) {
                object.insert((*key).to_owned(), Value::String(value));
            }
        }
        object
    }

    fn migrate_plaintext_secrets(&self) {
        let path = self.app_data.join("secrets.json");
        let Ok(text) = fs::read_to_string(&path) else {
            return;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
            return;
        };
        let Some(stored) = parsed.as_object() else {
            return;
        };
        for key in SECRET_KEYS {
            let Some(value) = stored.get(*key).and_then(Value::as_str) else {
                continue;
            };
            if value.is_empty() {
                continue;
            }
            if secrets::set(self.secret_store, &self.secret_account(key), value).is_err() {
                return;
            }
        }
        let _ = fs::remove_file(&path);
    }

    fn store_secrets(&self, secrets: &Map<String, Value>) -> Result<(), String> {
        for key in SECRET_KEYS {
            let value = secrets.get(*key).and_then(Value::as_str).unwrap_or("");
            let account = self.secret_account(key);
            if value.is_empty() {
                secrets::delete(self.secret_store, &account)?;
            } else {
                secrets::set(self.secret_store, &account, value)?;
            }
        }
        let _ = fs::remove_file(self.app_data.join("secrets.json"));
        Ok(())
    }
}

fn persist_settings_file(app_data: &Path, settings: &Map<String, Value>) -> Result<(), String> {
    let path = app_data.join("settings.json");
    let text = serde_json::to_string_pretty(settings)
        .map_err(|_| "Die Einstellungen sind ungültig.".to_owned())?;
    // Desktop `atomicWrite` reports the open error of `.settings.json.{pid}.{nonce}.tmp`.
    notes::atomic_write(&path, text.as_bytes(), 0o600)
}

const SYNC_SECRET_ACCOUNT: &str = "sync-account";
const APP_DATA_RESET_MARKER: &str = ".fanotes-reset-pending.json";
const APP_DATA_RESET_COMPLETE: &str = ".fanotes-reset-complete";
const RESET_MAX_BYTES: u64 = 4096;
const RESET_MAX_AGE_MS: u64 = 24 * 60 * 60 * 1000;

/// Node `readFile(..., 'utf8')`: a bad byte becomes U+FFFD and the prefix stays.
fn decode_sync_secret(bytes: Vec<u8>) -> (String, bool) {
    match String::from_utf8(bytes) {
        Ok(text) => (text, true),
        Err(error) => (
            String::from_utf8_lossy(error.as_bytes()).into_owned(),
            false,
        ),
    }
}

fn pending_reset_marker(app_data: &Path) -> Option<PathBuf> {
    Some(app_data.parent()?.join(APP_DATA_RESET_MARKER))
}

fn complete_pending_app_data_reset(app_data: &Path) {
    let Some(marker_path) = pending_reset_marker(app_data) else {
        return;
    };
    match classify_reset_marker(&marker_path, app_data) {
        ResetMarker::Absent | ResetMarker::Keep => return,
        ResetMarker::Discard => {
            let _ = fs::remove_file(&marker_path);
            return;
        }
        ResetMarker::Ready => {}
    }
    if fs::symlink_metadata(app_data).is_ok_and(|meta| meta.file_type().is_symlink()) {
        let _ = fs::remove_file(&marker_path);
        return;
    }
    let mut names = SECRET_KEYS.to_vec();
    names.push(SYNC_SECRET_ACCOUNT);
    secrets::forget_profile(app_data, &names);
    match fs::remove_dir_all(app_data) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return,
    }
    if fs::create_dir_all(app_data).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(app_data, fs::Permissions::from_mode(0o700));
    }
    let stamp = format!("{}\n", notes::iso_now());
    if notes::atomic_write(
        &app_data.join(APP_DATA_RESET_COMPLETE),
        stamp.as_bytes(),
        0o600,
    )
    .is_err()
    {
        return;
    }
    let _ = fs::remove_file(&marker_path);
}

enum ResetMarker {
    Absent,
    /// A symlink, a non-file, an oversized file, or JSON whose fields are wrong.
    Discard,
    /// `JSON.parse` threw. The desktop leaves that file for the next launch.
    Keep,
    Ready,
}

fn classify_reset_marker(marker_path: &Path, app_data: &Path) -> ResetMarker {
    let meta = match fs::symlink_metadata(marker_path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return ResetMarker::Absent,
        Err(_) => return ResetMarker::Keep,
    };
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > RESET_MAX_BYTES {
        return ResetMarker::Discard;
    }
    // `readFile(..., 'utf8')` replaces a bad byte and still parses the JSON.
    let text = match fs::read(marker_path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => return ResetMarker::Keep,
    };
    let marker = match serde_json::from_str::<Value>(&text) {
        Ok(marker) => marker,
        Err(_) => return ResetMarker::Keep,
    };
    if reset_marker_fields_match(&marker, app_data) {
        ResetMarker::Ready
    } else {
        ResetMarker::Discard
    }
}

fn valid_reset_marker(marker_path: &Path, app_data: &Path) -> bool {
    matches!(
        classify_reset_marker(marker_path, app_data),
        ResetMarker::Ready
    )
}

/// `path.resolve` for one path: make it absolute, then drop `.` and `..`.
///
/// The path is not opened, so a missing directory and a symlink stay as written
/// after the lexical cleanup. A trailing slash is not part of the result.
pub(crate) fn node_resolve(path: &Path) -> PathBuf {
    let absolute = if path.as_os_str().is_empty() {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            std::path::Component::RootDir => out.push(component.as_os_str()),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if matches!(
                    out.components().next_back(),
                    Some(std::path::Component::Normal(_))
                ) {
                    out.pop();
                }
            }
            std::path::Component::Normal(part) => out.push(part),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from("/")
    } else {
        out
    }
}

fn reset_marker_fields_match(marker: &Value, app_data: &Path) -> bool {
    // `marker.version !== 1` still accepts the JSON number `1.0`.
    if marker.get("version").and_then(Value::as_f64) != Some(1.0) {
        return false;
    }
    let Some(recorded) = marker.get("userDataPath").and_then(Value::as_str) else {
        return false;
    };
    // Desktop `path.resolve` drops `.` and `..` and a trailing slash.
    if node_resolve(Path::new(recorded)) != node_resolve(app_data) {
        return false;
    }
    let Some(created_at) = marker.get("createdAt").and_then(Value::as_str) else {
        return false;
    };
    marker_is_fresh(created_at)
}

fn marker_is_fresh(created_at: &str) -> bool {
    let Some(created_ms) = unix_millis_from_iso(created_at) else {
        return false;
    };
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return false;
    };
    let now_ms = now.as_millis() as u64;
    created_ms > now_ms || now_ms - created_ms <= RESET_MAX_AGE_MS
}

fn unix_millis_from_iso(value: &str) -> Option<u64> {
    let Some((date, time)) = value.split_once('T') else {
        // `Date.parse('YYYY-MM-DD')` is UTC midnight.
        return date_only_millis(value);
    };
    let mut date_parts = date.split('-');
    let year: i32 = date_parts.next()?.parse().ok()?;
    let month: u32 = date_parts.next()?.parse().ok()?;
    let day: u32 = date_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() {
        return None;
    }
    let (time, offset_ms) = split_time_zone(time)?;
    let (clock, millis) = match time.split_once('.') {
        // `Date.parse` keeps the first three fraction digits and ignores the rest.
        Some((clock, fraction))
            if !fraction.is_empty() && fraction.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            let digits = &fraction[..fraction.len().min(3)];
            let millis: u32 = digits.parse().ok()?;
            let scale = 10u32.pow(3 - digits.len() as u32);
            (clock, millis * scale)
        }
        None => (time, 0),
        Some(_) => return None,
    };
    let mut clock_parts = clock.split(':');
    let hour: u32 = clock_parts.next()?.parse().ok()?;
    let minute: u32 = clock_parts.next()?.parse().ok()?;
    // `Date.parse` treats `Thh:mmZ` as zero seconds.
    let second: u32 = match clock_parts.next() {
        Some(text) => text.parse().ok()?,
        None => 0,
    };
    if clock_parts.next().is_some()
        || hour > 23
        || minute > 59
        || second > 60
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
    {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    let local = (days as i64) * 86_400_000
        + i64::from(hour) * 3_600_000
        + i64::from(minute) * 60_000
        + i64::from(second) * 1000
        + i64::from(millis);
    // A positive offset is ahead of UTC, so the UTC instant is earlier.
    u64::try_from(local.checked_sub(offset_ms)?).ok()
}

/// `Z`, `z`, `+HH:MM`, `-HH:MM`, `+HHMM`, or `-HHMM` after the clock.
fn split_time_zone(time: &str) -> Option<(&str, i64)> {
    if let Some(clock) = time.strip_suffix(['Z', 'z']) {
        return Some((clock, 0));
    }
    let sign_at = time.rfind(['+', '-'])?;
    if sign_at == 0 {
        return None;
    }
    let (clock, zone) = time.split_at(sign_at);
    let (sign, rest) = if let Some(rest) = zone.strip_prefix('+') {
        (1i64, rest)
    } else {
        (-1i64, zone.strip_prefix('-')?)
    };
    let (hour_text, minute_text) = if let Some((hour, minute)) = rest.split_once(':') {
        if hour.len() != 2 || minute.len() != 2 {
            return None;
        }
        (hour, minute)
    } else if rest.len() == 4 && rest.bytes().all(|byte| byte.is_ascii_digit()) {
        (&rest[..2], &rest[2..])
    } else {
        return None;
    };
    let hour: i64 = hour_text.parse().ok()?;
    let minute: i64 = minute_text.parse().ok()?;
    if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) {
        return None;
    }
    Some((clock, sign * (hour * 3_600_000 + minute * 60_000)))
}

fn date_only_millis(value: &str) -> Option<u64> {
    let mut date_parts = value.split('-');
    let year: i32 = date_parts.next()?.parse().ok()?;
    let month: u32 = date_parts.next()?.parse().ok()?;
    let day: u32 = date_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || day == 0 {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    Some(days.saturating_mul(86_400_000))
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<u64> {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = (year - era * 400) as u64;
    let month_prime = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era =
        year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + u64::from(day_of_year);
    let days = era as i64 * 146_097 + day_of_era as i64 - 719_468;
    u64::try_from(days).ok()
}

const PDF_ASSET_MAX: u64 = 96 * 1024 * 1024;
const HTML_ASSET_MAX: u64 = 128 * 1024 * 1024;
const IMAGE_ASSET_MAX: u64 = 32 * 1024 * 1024;
const SYNC_MAX_BYTES: u64 = 100 * 1024 * 1024;
const MAX_SYNC_STATE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_SYNC_ENTRIES: usize = 100_000;
const MAX_SYNC_DEPTH: usize = 40;
const MAX_TEXT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_FAMD_BYTES: u64 = 40 * 1024 * 1024;
const MAX_RECOGNITION_MODEL_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TREE_CACHE_BYTES: u64 = 24 * 1024 * 1024;
const MAX_TREE_CACHE_ENTRIES: usize = 100_000;
const MAX_PDF_BITMAP_BYTES: usize = 48 * 1024 * 1024;

fn asset_mime(relative: &str) -> Option<&'static str> {
    match preview_extension(relative).as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "svg" => Some("image/svg+xml"),
        "pdf" => Some("application/pdf"),
        "html" => Some("text/html"),
        _ => None,
    }
}

fn preview_extension(relative: &str) -> String {
    // Desktop `path.extname` ignores trailing slashes and keeps a backslash in the name.
    vault::posix_extname_en_us(relative)
        .trim_start_matches('.')
        .to_owned()
}

/// Tree and search store the extension without its dot.
///
/// `Notiz.marKdown` is `markdown`, matching `toLocaleLowerCase('en-US')`.
fn extension_label(name: &str) -> String {
    vault::posix_extname_en_us(name)
        .trim_start_matches('.')
        .to_owned()
}

fn asset_limit(mime: &str) -> u64 {
    match mime {
        "application/pdf" => PDF_ASSET_MAX,
        "text/html" => HTML_ASSET_MAX,
        _ => IMAGE_ASSET_MAX,
    }
}

/// Node `fs.rm(path, { force: true })` without `recursive`.
fn remove_force(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(vault::node_lstat_error(path, &error)),
        Ok(meta) if meta.is_dir() => Err(format!(
            "Path is a directory: rm returned EISDIR (is a directory) {}",
            path.display()
        )),
        Ok(_) => fs::remove_file(path).map_err(|error| vault::node_unlink_error(path, &error)),
    }
}

fn read_regular_limited(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|_| "Die Datei konnte nicht gelesen werden.".to_owned())?;
    if meta.file_type().is_symlink() {
        return Err("Symbolische Links sind innerhalb des Vaults nicht erlaubt.".to_owned());
    }
    // A directory is refused before the open, matching `resolveVaultPath`
    // with `expected: 'file'`.
    if !meta.is_file() {
        return Err("Die gewählte Datei ist keine reguläre Datei.".to_owned());
    }
    // Desktop preview and PDF raster open with `O_NOFOLLOW` before the size
    // check. An unreadable oversized file is that open error. Sync rejects
    // an oversized file from `lstat` before it calls this.
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|error| notes::node_open_error(path, &error))?;
    let opened = file
        .metadata()
        .map_err(|error| notes::node_open_error(path, &error))?;
    if opened.len() > max {
        return Err("Die Datei ist zu groß.".to_owned());
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| notes::node_open_error(path, &error))?;
    Ok(bytes)
}

/// `String(value)` for an IPC argument. A missing argument is JavaScript `undefined`.
fn js_argument_string(args: &[Value], index: usize) -> String {
    match args.get(index) {
        Some(value) => notes::js_regexp_string(value),
        None => "undefined".to_owned(),
    }
}

fn arg_text(args: &[Value], index: usize, message: &str) -> Result<String, String> {
    args.get(index)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| message.to_owned())
}

fn default_settings() -> Map<String, Value> {
    let mut settings = settings::defaults();
    if settings::is_beta_release(APP_VERSION) {
        settings.insert("updateChannel".to_owned(), Value::String("beta".to_owned()));
    }
    settings
}

fn installation_kind() -> &'static str {
    if cfg!(windows) {
        "windows-installer"
    } else if std::env::var_os("APPIMAGE").is_some_and(|value| !value.is_empty()) {
        "appimage"
    } else {
        "managed-appimage"
    }
}

fn enhanced_math_state() -> Value {
    json!({
        "supported": false,
        "installed": false,
        "downloading": false,
        "modelId": "posformer-crohme-q4-k",
        "size": 10_316_032,
        "license": "CC-BY-NC-SA-3.0",
        "homepage": "https://huggingface.co/cstr/posformer-crohme-GGUF"
    })
}

fn qwen_vision_state() -> Value {
    json!({
        "supported": false,
        "installed": false,
        "downloading": false,
        "runtimeInstalling": false,
        "runtimeReady": false,
        "runtimePhase": "idle",
        "runtimeMessage": null,
        "npu": false,
        "genai": false,
        "devices": [],
        "npuDevice": null,
        "host": null,
        "openvinoVersion": null,
        "modelId": "qwen3-vl-2b-int4-npu",
        "label": "Empfohlen · Qwen3-VL 2B · OpenVINO INT4 · NPU",
        "recommended": true,
        "precision": "int4",
        "device": "NPU",
        "license": "Apache-2.0",
        "homepage": "https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct",
        "repo": "shawnxhong/Qwen3-VL-2B-Instruct-ov-int4",
        "error": "Qwen Vision ist in diesem Paket nicht enthalten.",
        "installHint": null
    })
}

fn loose_string(args: &[Value], index: usize) -> String {
    args.get(index)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// A missing folder parent is the vault root. Any other non-string is rejected.
///
/// The React bundle omits the parent with `undefined`. The Tauri bridge encodes
/// that as JSON `null`, which is the same root as a missing argument.
fn folder_parent(args: &[Value]) -> Result<String, String> {
    match args.first() {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(value)) => Ok(value.clone()),
        Some(_) => Err("Ungültiger Vault-Pfad.".to_owned()),
    }
}

fn loose_string_opt(args: &[Value], index: usize) -> Option<String> {
    args.get(index).and_then(Value::as_str).map(str::to_owned)
}

fn is_vault_id(value: &str) -> bool {
    (16..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// A vault directory the desktop would accept in `validateVaultRoot`.
fn validated_vault_directory(path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|_| "Der gewählte Vault ist kein sicherer Ordner.".to_owned())?;
    let meta = fs::symlink_metadata(&canonical)
        .map_err(|_| "Der gewählte Vault ist kein sicherer Ordner.".to_owned())?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("Der gewählte Vault ist kein sicherer Ordner.".to_owned());
    }
    Ok(canonical)
}

/// Node `fs.access(path, R_OK | W_OK)` for the chosen vault directory.
fn vault_write_access_error(path: &Path) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let mut bytes = path.as_os_str().as_bytes().to_vec();
        bytes.push(0);
        let allowed = unsafe {
            libc::access(
                bytes.as_ptr().cast::<libc::c_char>(),
                libc::R_OK | libc::W_OK,
            ) == 0
        };
        if allowed {
            return None;
        }
        let code = std::io::Error::last_os_error().raw_os_error();
        let (name, detail) = if code == Some(libc::EROFS) {
            ("EROFS", "read-only file system")
        } else {
            ("EACCES", "permission denied")
        };
        Some(format!("{name}: {detail}, access '{}'", path.display()))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

fn system_time_from_millis(millis: i64) -> Option<SystemTime> {
    if millis < 0 {
        return None;
    }
    let seconds = millis.div_euclid(1000);
    let nanos = (millis.rem_euclid(1000) as u32).saturating_mul(1_000_000);
    UNIX_EPOCH.checked_add(std::time::Duration::new(seconds as u64, nanos))
}

/// `mkdir` with mode `0o700` for a profile directory.
///
/// The desktop uses `fs.mkdir(directory, { recursive: true, mode: 0o700 })`
/// for the profile, `tree-cache-v1`, and `sync`. An existing directory keeps
/// its mode. A symlink to a directory is accepted. Any other failure is
/// Node's `mkdir` error for the directory that was requested.
fn ensure_private_profile_dir(path: &Path) -> Result<(), String> {
    mkdir_profile(path, path)
}

fn mkdir_profile(path: &Path, reported: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return match fs::metadata(path) {
                Ok(followed) if followed.is_dir() => Ok(()),
                Ok(_) => Err(profile_mkdir_errno(reported, libc::EEXIST)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Err(profile_mkdir_errno(reported, libc::ENOENT))
                }
                Err(error) => Err(vault::node_mkdir_error(reported, &error)),
            };
        }
        Ok(meta) if meta.is_dir() => return Ok(()),
        Ok(_) => return Err(profile_mkdir_errno(reported, libc::EEXIST)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(vault::node_mkdir_error(reported, &error)),
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && parent != path {
            match fs::symlink_metadata(parent) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    mkdir_profile(parent, reported)?;
                }
                Err(error) => return Err(vault::node_mkdir_error(reported, &error)),
                Ok(_) => {}
            }
        }
    }
    match fs::create_dir(path) {
        Ok(()) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| {
                    "Der Ordner konnte nicht angelegt werden.".to_owned()
                })?;
            }
            Ok(())
        }
        // A name that appeared while this call was creating parents.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            mkdir_profile(path, reported)
        }
        Err(error) => Err(vault::node_mkdir_error(reported, &error)),
    }
}

fn profile_mkdir_errno(path: &Path, code: i32) -> String {
    vault::node_mkdir_error(path, &std::io::Error::from_raw_os_error(code))
}

fn create_sync_directories(root: &Path, file: &Path) -> Result<(), String> {
    let Some(parent) = file.parent() else {
        return Ok(());
    };
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| "Der Pfad liegt außerhalb des Vaults.".to_owned())?;
    let mut cursor = root.to_path_buf();
    for component in relative.components() {
        cursor.push(component);
        match fs::symlink_metadata(&cursor) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err("Ein Pfadbestandteil ist kein Ordner.".to_owned());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Node's recursive `mkdir` reports the full directory it was
                // asked to create, even when an earlier missing piece fails.
                fs::create_dir(&cursor)
                    .map_err(|error| vault::node_mkdir_error(parent, &error))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&cursor, fs::Permissions::from_mode(0o700))
                        .map_err(|_| "Der Ordner konnte nicht angelegt werden.".to_owned())?;
                }
            }
            // Desktop `mkdir` does not lstat first. A parent that cannot be
            // searched fails that mkdir.
            Err(_) => {
                fs::create_dir(&cursor)
                    .map_err(|error| vault::node_mkdir_error(parent, &error))?;
            }
        }
    }
    Ok(())
}

/// Binary sync payload. A base64 string is the JSON bridge. A list is
/// `Uint8Array.from`, so a bare number does not become a zero-filled buffer.
fn sync_bytes(value: &Value) -> Result<Vec<u8>, String> {
    let invalid = || "Der Sync-Inhalt muss binär sein.".to_owned();
    let too_big = || "Die Datei ist zu groß für den Sync.".to_owned();
    match value {
        Value::String(encoded) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded.as_bytes())
                .map_err(|_| invalid())?;
            if bytes.len() as u64 > SYNC_MAX_BYTES {
                return Err(too_big());
            }
            Ok(bytes)
        }
        Value::Array(items) => {
            if items.len() as u64 > SYNC_MAX_BYTES {
                return Err(too_big());
            }
            Ok(items.iter().map(js_uint8).collect())
        }
        _ => Err(invalid()),
    }
}

/// `ToUint8`: truncate toward zero, then the positive remainder modulo 256.
fn js_uint8(value: &Value) -> u8 {
    let number = match value {
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => fanotes_famd::js_tonumber(text).unwrap_or(f64::NAN),
        Value::Bool(true) => 1.0,
        Value::Bool(false) => 0.0,
        Value::Null => 0.0,
        other => fanotes_famd::js_tonumber(&notes::js_regexp_string(other)).unwrap_or(f64::NAN),
    };
    if !number.is_finite() {
        return 0;
    }
    number.trunc().rem_euclid(256.0) as u8
}

fn arg_mtime_ms(value: Option<&Value>) -> Option<i64> {
    // Desktop `new Date(Number(mtimeMs))` truncates toward zero, then TimeClip.
    // `0.9` is still positive, so the file is stamped at the Unix epoch.
    // A time past ±8.64e15 ms is an invalid date and is left unset.
    // `Number([1600000000000])` is that one element. `Number([1, 2])` is NaN.
    let number = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => fanotes_famd::js_tonumber(text)?,
        Value::Bool(true) => 1.0,
        Value::Bool(false) => 0.0,
        Value::Null => 0.0,
        other => fanotes_famd::js_tonumber(&notes::js_regexp_string(other))?,
    };
    if !number.is_finite() || number <= 0.0 {
        return None;
    }
    let millis = number.trunc();
    if millis.abs() > 8_640_000_000_000_000.0 {
        return None;
    }
    Some(millis as i64)
}

fn mtime_millis(meta: &fs::Metadata) -> i64 {
    meta.modified().map(notes::mtime_millis_of).unwrap_or(0)
}

fn internal_directory(root: &Path) -> Result<PathBuf, String> {
    vault::ensure_internal_directory(root)
}

/// `resolveVaultPath` for `.fanotes/recognition-model.json` with `expected: 'file'`.
///
/// A missing `.fanotes` folder stays missing. This path does not rename a
/// leftover `.lernwerk` folder. The write creates `.fanotes` with `mkdir`.
fn recognition_model_path(root: &Path) -> Result<PathBuf, String> {
    let fanotes = root.join(".fanotes");
    match fs::symlink_metadata(&fanotes) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(vault::node_lstat_error(&fanotes, &error)),
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err("Symbolische Links sind innerhalb des Vaults nicht erlaubt.".to_owned());
        }
        Ok(meta) if !meta.is_dir() => {
            return Err("Ein Pfadbestandteil ist kein Ordner.".to_owned());
        }
        Ok(_) => {
            let root_real = fs::canonicalize(root)
                .map_err(|_| "Der Pfad verlässt den Vault über einen Link.".to_owned())?;
            let real = fs::canonicalize(&fanotes)
                .map_err(|_| "Der Pfad verlässt den Vault über einen Link.".to_owned())?;
            if !vault::is_inside_root(&root_real, &real) {
                return Err("Der Pfad verlässt den Vault über einen Link.".to_owned());
            }
        }
    }
    let path = fanotes.join("recognition-model.json");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(path),
        Err(error) => Err(vault::node_lstat_error(&path, &error)),
        Ok(meta) if meta.file_type().is_symlink() => {
            Err("Symbolische Links sind innerhalb des Vaults nicht erlaubt.".to_owned())
        }
        Ok(meta) if !meta.is_file() => {
            Err("Die gewählte Datei ist keine reguläre Datei.".to_owned())
        }
        Ok(_) => Ok(path),
    }
}

fn scan_sync_directory(root: &Path, directory: &Path, depth: usize, out: &mut Vec<Value>) {
    if depth > MAX_SYNC_DEPTH || out.len() >= MAX_SYNC_ENTRIES {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_SYNC_ENTRIES {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if name.starts_with('.') && !(depth == 0 && name == ".fanotes") {
            continue;
        }
        let relative = vault::relative_posix(root, &path);
        if depth == 1
            && relative.starts_with(".fanotes/")
            && matches!(name.as_str(), "history" | "tree-cache")
        {
            continue;
        }
        if meta.is_dir() {
            scan_sync_directory(root, &path, depth + 1, out);
            continue;
        }
        if !meta.is_file()
            || name.to_ascii_lowercase().ends_with(".tmp")
            || meta.len() > SYNC_MAX_BYTES
        {
            continue;
        }
        out.push(json!({
            "path": relative,
            "size": meta.len(),
            "mtimeMs": mtime_millis(&meta),
        }));
    }
}

enum CreateAttempt {
    Taken,
    Failed(String),
}

fn safe_entry_name(value: &str) -> Result<String, String> {
    safe_entry_name_or(value, "")
}

/// `safeEntryName` from the desktop host.
///
/// A blank name uses `fallback`. Windows device names and the characters
/// `<>:"|?*` are refused even when the title is not a vault file.
fn safe_entry_name_or(value: &str, fallback: &str) -> Result<String, String> {
    let trimmed = vault::js_trim(value);
    let name = if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    };
    if !entry_name_allowed(name) {
        return Err("Dieser Name ist nicht erlaubt.".to_owned());
    }
    let cleaned = vault::js_trim(name.trim_end_matches(['.', ' ']));
    if !entry_name_allowed(cleaned)
        || windows_device_name(cleaned)
        || cleaned.contains(['<', '>', ':', '"', '|', '?', '*'])
    {
        return Err("Dieser Name ist nicht erlaubt.".to_owned());
    }
    Ok(cleaned.to_owned())
}

fn entry_name_allowed(name: &str) -> bool {
    !name.is_empty()
        && vault::utf16_len(name) <= 180
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !vault::has_c0_or_del(name)
        && !matches!(
            vault::locale_lower_en_us(name).as_str(),
            ".fanotes" | ".lernwerk"
        )
}

fn windows_device_name(name: &str) -> bool {
    let label = name.split('.').next().unwrap_or(name);
    let label = vault::js_trim(label).to_ascii_lowercase();
    matches!(label.as_str(), "con" | "prn" | "aux" | "nul")
        || (label.len() == 4
            && (label.starts_with("com") || label.starts_with("lpt"))
            && label.as_bytes()[3].is_ascii_digit())
}

fn split_entry_name(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(index) if index > 0 => (&name[..index], &name[index..]),
        _ => (name, ""),
    }
}

fn entry_extension(name: &str) -> String {
    vault::locale_lower_en_us(split_entry_name(name).1)
}

fn numbered_entry_name(name: &str, number: u32) -> String {
    if number == 1 {
        return name.to_owned();
    }
    let (stem, extension) = split_entry_name(name);
    format!("{stem} {number}{extension}")
}

fn companion_extension(directory: bool, name: &str) -> Option<&'static str> {
    if directory {
        return None;
    }
    match entry_extension(name).as_str() {
        ".famd" => Some(".md"),
        ".md" | ".markdown" | ".pdf" => Some(".famd"),
        _ => None,
    }
}

fn relative_from_root(root: &Path, path: &Path) -> String {
    vault::relative_posix(root, path)
}

/// Node `fs.readdir`, whose failure is `scandir` in the thrown message.
pub(crate) fn read_sibling_dir(parent: &Path) -> Result<fs::ReadDir, String> {
    fs::read_dir(parent).map_err(|error| scandir_error(parent, &error))
}

fn scandir_error(path: &Path, error: &std::io::Error) -> String {
    #[cfg(unix)]
    let (name, detail) = match error.raw_os_error() {
        Some(libc::EACCES) => ("EACCES", "permission denied"),
        Some(libc::EPERM) => ("EPERM", "operation not permitted"),
        Some(libc::ENOENT) => ("ENOENT", "no such file or directory"),
        Some(libc::ENOTDIR) => ("ENOTDIR", "not a directory"),
        Some(libc::EIO) => ("EIO", "i/o error"),
        Some(libc::ELOOP) => ("ELOOP", "too many symbolic links encountered"),
        Some(libc::ENAMETOOLONG) => ("ENAMETOOLONG", "name too long"),
        Some(libc::EMFILE) => ("EMFILE", "too many open files"),
        Some(libc::ENFILE) => ("ENFILE", "file table overflow"),
        _ => ("EACCES", "permission denied"),
    };
    #[cfg(not(unix))]
    let (name, detail) = {
        let _ = error;
        ("EACCES", "permission denied")
    };
    format!("{name}: {detail}, scandir '{}'", path.display())
}

fn unique_sibling_name(
    parent: &Path,
    desired: &str,
    excluding: Option<&str>,
    companion_extension: Option<&str>,
) -> Result<String, String> {
    let mut occupied = std::collections::HashSet::new();
    // Desktop `readdir` throws before a rename or move can replace a file
    // the process is not allowed to list.
    for entry in read_sibling_dir(parent)?.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if excluding.is_some_and(|current| current == name) {
            continue;
        }
        occupied.insert(vault::entry_name_key(&name));
    }
    for number in 1..=10_000 {
        let candidate = numbered_entry_name(desired, number);
        if occupied.contains(&vault::entry_name_key(&candidate)) {
            continue;
        }
        if let Some(extension) = companion_extension {
            let (stem, _) = split_entry_name(&candidate);
            let companion = format!("{stem}{extension}");
            if occupied.contains(&vault::entry_name_key(&companion)) {
                continue;
            }
        }
        return Ok(candidate);
    }
    Err("Es konnte kein eindeutiger Name erzeugt werden.".to_owned())
}

fn available_entry_name(parent: &Path, desired: &str, note: bool) -> Result<String, String> {
    let mut occupied = std::collections::HashSet::new();
    for entry in read_sibling_dir(parent)?.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            occupied.insert(vault::entry_name_key(name));
        }
    }
    for number in 1..=10_000 {
        let candidate = numbered_entry_name(desired, number);
        if occupied.contains(&vault::entry_name_key(&candidate)) {
            continue;
        }
        // A free filename is enough. Creating the note rewrites the `.famd`
        // companion and keeps its handwriting.
        return Ok(candidate);
    }
    Err(if note {
        "Es konnte kein eindeutiger Notizname erzeugt werden.".to_owned()
    } else {
        "Es konnte kein eindeutiger Ordnername erzeugt werden.".to_owned()
    })
}

fn create_exclusive_note(path: &Path, markdown: &str) -> Result<(), CreateAttempt> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(CreateAttempt::Taken);
        }
        Err(error) => {
            return Err(CreateAttempt::Failed(notes::node_open_error(path, &error)));
        }
    };
    use std::io::Write;
    if file.write_all(markdown.as_bytes()).is_err() {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(CreateAttempt::Failed(
            "Die Notiz konnte nicht angelegt werden.".to_owned(),
        ));
    }
    let _ = file.sync_all();
    Ok(())
}

fn create_exclusive_folder(path: &Path) -> Result<(), CreateAttempt> {
    match fs::create_dir(path) {
        Ok(()) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(CreateAttempt::Taken)
        }
        Err(error) => Err(CreateAttempt::Failed(vault::node_mkdir_error(path, &error))),
    }
}

fn created_entry(relative: &str, path: &Path, note: bool) -> Value {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(relative);
    let meta = fs::symlink_metadata(path).ok();
    let modified = meta
        .as_ref()
        .and_then(|meta| meta.modified().ok())
        .map(notes::iso_from_system_time)
        .unwrap_or_else(notes::iso_now);
    if note {
        json!({
            "relativePath": relative,
            "entry": {
                "name": name,
                "relativePath": relative,
                "kind": "file",
                "extension": entry_extension(name).trim_start_matches('.'),
                "modifiedAt": modified,
                "size": meta.as_ref().map(fs::Metadata::len).unwrap_or(0),
            }
        })
    } else {
        json!({
            "relativePath": relative,
            "entry": {
                "name": name,
                "relativePath": relative,
                "kind": "folder",
                "modifiedAt": modified,
                "children": [],
            }
        })
    }
}

pub fn openable_http_url(raw: &str) -> Option<String> {
    http_link(raw).ok()
}

fn http_link(raw: &str) -> Result<String, String> {
    if raw.is_empty() || vault::utf16_len(raw) > 4096 {
        return Err("Ungültiger externer Link.".to_owned());
    }
    let mut parsed = url::Url::parse(raw).map_err(|_| "Ungültiger externer Link.".to_owned())?;
    let password = parsed.password().unwrap_or("");
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || !password.is_empty()
    {
        return Err("Nur sichere HTTP(S)-Links ohne Zugangsdaten sind erlaubt.".to_owned());
    }
    // An empty password is falsy in the desktop check, and `href` drops it.
    if parsed.password().is_some() {
        let _ = parsed.set_password(None);
    }
    Ok(parsed.to_string())
}

fn reveal_target(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let normalized = vault::normalize_relative_path(relative, true, true)?;
    if normalized.is_empty() {
        return Ok(root.to_path_buf());
    }
    let mut target = root.to_path_buf();
    for (index, segment) in normalized.split('/').enumerate() {
        target.push(segment);
        let meta = fs::symlink_metadata(&target)
            .map_err(|error| vault::node_lstat_error(&target, &error))?;
        if meta.file_type().is_symlink() {
            return Err("Symbolische Links sind innerhalb des Vaults nicht erlaubt.".to_owned());
        }
        let last = index + 1 == normalized.split('/').count();
        if !last && !meta.is_dir() {
            return Err("Ein Pfadbestandteil ist kein Ordner.".to_owned());
        }
        if last && !meta.is_file() && !meta.is_dir() {
            return Err("Der Eintrag wurde nicht gefunden.".to_owned());
        }
    }
    if !vault::is_inside_root(root, &target) {
        return Err("Der Pfad liegt außerhalb des Vaults.".to_owned());
    }
    Ok(target)
}

fn reveal_on_desktop(path: &Path) -> Result<(), String> {
    let uri = file_uri(path);
    if spawn_detached(
        "dbus-send",
        &[
            "--session".to_owned(),
            "--dest=org.freedesktop.FileManager1".to_owned(),
            "--type=method_call".to_owned(),
            "/org/freedesktop/FileManager1".to_owned(),
            "org.freedesktop.FileManager1.ShowItems".to_owned(),
            format!("array:string:{uri}"),
            "string:".to_owned(),
        ],
    )
    .is_ok()
    {
        return Ok(());
    }
    let folder = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent().unwrap_or(path).to_path_buf()
    };
    spawn_detached("xdg-open", &[folder.to_string_lossy().into_owned()])
}

fn spawn_detached(program: &str, args: &[String]) -> Result<(), String> {
    std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| "Der Link konnte nicht geöffnet werden.".to_owned())
}

fn file_uri(path: &Path) -> String {
    let mut uri = String::from("file://");
    for byte in path.to_string_lossy().as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                uri.push(*byte as char);
            }
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }
    uri
}

pub(crate) fn compare_names(left: &str, right: &str) -> std::cmp::Ordering {
    static COLLATOR: std::sync::OnceLock<Option<icu_collator::CollatorBorrowed<'static>>> =
        std::sync::OnceLock::new();
    let left = collation_text(left);
    let right = collation_text(right);
    if let Some(collator) = COLLATOR.get_or_init(german_numeric_base_collator).as_ref() {
        return collator.compare(left.as_ref(), right.as_ref());
    }
    compare_names_fallback(left.as_ref(), right.as_ref())
}

/// Characters whose primary weights in Node's German sort differ from ICU.
///
/// V8 keeps these case pairs distinct and orders them after Han characters.
/// ICU folds each pair together and sorts the pair before Han. The sentinels
/// are private-use characters in that desktop order.
fn collation_text(value: &str) -> std::borrow::Cow<'_, str> {
    if !value.chars().any(needs_collation_sentinel) {
        return std::borrow::Cow::Borrowed(value);
    }
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        if let Some(rank) = collation_sentinel_rank(character) {
            out.push(char::from_u32(0xF0000 + rank).expect("collation rank fits"));
        } else {
            out.push(character);
        }
    }
    std::borrow::Cow::Owned(out)
}

fn needs_collation_sentinel(character: char) -> bool {
    collation_sentinel_rank(character).is_some()
}

fn collation_sentinel_rank(character: char) -> Option<u32> {
    Some(match character {
        '\u{A7D3}' => 0,
        '\u{A7D5}' => 1,
        '\u{A7CE}' => 2,
        '\u{A7CF}' => 3,
        '\u{A7D2}' => 4,
        '\u{A7D4}' => 5,
        '\u{16EA0}'..='\u{16ED3}' => 6 + (u32::from(character) - 0x16EA0),
        _ => return None,
    })
}

fn compare_names_fallback(left: &str, right: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let left = sort_key(left);
    let right = sort_key(right);
    let mut left_index = 0;
    let mut right_index = 0;
    while left_index < left.len() && right_index < right.len() {
        if left[left_index].is_ascii_digit() && right[right_index].is_ascii_digit() {
            while left_index < left.len() && left[left_index] == '0' {
                left_index += 1;
            }
            while right_index < right.len() && right[right_index] == '0' {
                right_index += 1;
            }
            let left_start = left_index;
            let right_start = right_index;
            while left_index < left.len() && left[left_index].is_ascii_digit() {
                left_index += 1;
            }
            while right_index < right.len() && right[right_index].is_ascii_digit() {
                right_index += 1;
            }
            let order = (left_index - left_start)
                .cmp(&(right_index - right_start))
                .then_with(|| left[left_start..left_index].cmp(&right[right_start..right_index]));
            if order != Ordering::Equal {
                return order;
            }
            continue;
        }
        if left[left_index] != right[right_index] {
            return left[left_index].cmp(&right[right_index]);
        }
        left_index += 1;
        right_index += 1;
    }
    match (left_index == left.len(), right_index == right.len()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => Ordering::Equal,
    }
}

/// German base order: case and accents do not change the position, and `ß` sorts as `ss`.
fn sort_key(name: &str) -> Vec<char> {
    use unicode_normalization::UnicodeNormalization;
    let mut folded = String::new();
    for character in name.nfd() {
        for lower in character.to_lowercase() {
            match lower {
                'ß' => folded.push_str("ss"),
                'æ' => folded.push_str("ae"),
                'œ' => folded.push_str("oe"),
                'ø' => folded.push('o'),
                'ł' => folded.push('l'),
                character if is_combining_mark(character) => {}
                character => folded.push(character),
            }
        }
    }
    folded.chars().collect()
}

fn is_combining_mark(character: char) -> bool {
    matches!(
        character,
        '\u{0300}'..='\u{036F}'
            | '\u{1AB0}'..='\u{1AFF}'
            | '\u{1DC0}'..='\u{1DFF}'
            | '\u{20D0}'..='\u{20FF}'
            | '\u{FE20}'..='\u{FE2F}'
    )
}

fn german_dictionary_collator() -> Option<icu_collator::CollatorBorrowed<'static>> {
    icu_collator::Collator::try_new(
        icu_locale_core::locale!("de").into(),
        icu_collator::options::CollatorOptions::default(),
    )
    .ok()
}

/// German dictionary order, matching `localeCompare(name, 'de')`.
pub(crate) fn dictionary_order(left: &str, right: &str) -> std::cmp::Ordering {
    static COLLATOR: std::sync::OnceLock<Option<icu_collator::CollatorBorrowed<'static>>> =
        std::sync::OnceLock::new();
    compare_with(
        left,
        right,
        COLLATOR.get_or_init(german_dictionary_collator),
    )
}

/// German base order without numeric runs, matching `localeCompare(name, 'de', { sensitivity: 'base' })`.
pub(crate) fn base_dictionary_order(left: &str, right: &str) -> std::cmp::Ordering {
    static COLLATOR: std::sync::OnceLock<Option<icu_collator::CollatorBorrowed<'static>>> =
        std::sync::OnceLock::new();
    compare_with(left, right, COLLATOR.get_or_init(german_base_collator))
}

/// German dictionary order with numeric runs, matching `localeCompare(name, 'de', { numeric: true })`.
pub(crate) fn numeric_dictionary_order(left: &str, right: &str) -> std::cmp::Ordering {
    static COLLATOR: std::sync::OnceLock<Option<icu_collator::CollatorBorrowed<'static>>> =
        std::sync::OnceLock::new();
    compare_with(left, right, COLLATOR.get_or_init(german_numeric_collator))
}

fn compare_with(
    left: &str,
    right: &str,
    collator: &Option<icu_collator::CollatorBorrowed<'static>>,
) -> std::cmp::Ordering {
    let left = collation_text(left);
    let right = collation_text(right);
    if let Some(collator) = collator {
        collator.compare(left.as_ref(), right.as_ref())
    } else {
        left.cmp(&right)
    }
}

fn german_base_collator() -> Option<icu_collator::CollatorBorrowed<'static>> {
    let mut options = icu_collator::options::CollatorOptions::default();
    options.strength = Some(icu_collator::options::Strength::Primary);
    icu_collator::Collator::try_new(icu_locale_core::locale!("de").into(), options).ok()
}

fn german_numeric_collator() -> Option<icu_collator::CollatorBorrowed<'static>> {
    let mut prefs = icu_collator::CollatorPreferences::from(icu_locale_core::locale!("de"));
    prefs.numeric_ordering = Some(icu_collator::preferences::CollationNumericOrdering::True);
    icu_collator::Collator::try_new(prefs, icu_collator::options::CollatorOptions::default()).ok()
}

/// `localeCompare(name, 'de', { numeric: true, sensitivity: 'base' })`.
fn german_numeric_base_collator() -> Option<icu_collator::CollatorBorrowed<'static>> {
    let mut prefs = icu_collator::CollatorPreferences::from(icu_locale_core::locale!("de"));
    prefs.numeric_ordering = Some(icu_collator::preferences::CollationNumericOrdering::True);
    let mut options = icu_collator::options::CollatorOptions::default();
    options.strength = Some(icu_collator::options::Strength::Primary);
    icu_collator::Collator::try_new(prefs, options).ok()
}

fn entry_name_order(left: &Value, right: &Value) -> std::cmp::Ordering {
    let left_folder = left["kind"].as_str() == Some("folder");
    let right_folder = right["kind"].as_str() == Some("folder");
    right_folder.cmp(&left_folder).then_with(|| {
        compare_names(
            left["name"].as_str().unwrap_or(""),
            right["name"].as_str().unwrap_or(""),
        )
    })
}

fn send_to_trash(host: &Host, path: &Path) -> Result<(), String> {
    if let Some(dir) = &host.trash_dir {
        return place_in_trash(dir, path);
    }
    if gio_trash(path).is_ok() {
        return Ok(());
    }
    if let Some(dir) = xdg_trash_dir() {
        if place_in_trash(&dir, path).is_ok() {
            return Ok(());
        }
    }
    Err("Der Eintrag konnte nicht in den Papierkorb verschoben werden.".to_owned())
}

fn gio_trash(path: &Path) -> Result<(), ()> {
    let status = std::process::Command::new("gio")
        .args(["trash", &path.to_string_lossy()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|_| ())?;
    if status.success() {
        Ok(())
    } else {
        Err(())
    }
}

fn make_trash_private(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(directory)
            .map_err(|_| "Der Eintrag konnte nicht in den Papierkorb verschoben werden.".to_owned())?
            .permissions()
            .mode()
            & 0o777;
        if mode & 0o077 != 0 {
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(|_| {
                "Der Eintrag konnte nicht in den Papierkorb verschoben werden.".to_owned()
            })?;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = directory;
    }
    Ok(())
}

fn xdg_trash_dir() -> Option<PathBuf> {
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
        })?;
    Some(data.join("Trash"))
}

fn place_in_trash(trash_root: &Path, source: &Path) -> Result<(), String> {
    let files = trash_root.join("files");
    let info = trash_root.join("info");
    fs::create_dir_all(&files)
        .map_err(|_| "Der Eintrag konnte nicht in den Papierkorb verschoben werden.".to_owned())?;
    fs::create_dir_all(&info)
        .map_err(|_| "Der Eintrag konnte nicht in den Papierkorb verschoben werden.".to_owned())?;
    // The desktop trash and the freedesktop spec keep these folders private.
    // `create_dir_all` follows the umask, which would otherwise leave them listable.
    for directory in [trash_root, &files, &info] {
        make_trash_private(directory)?;
    }
    let base = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("datei");
    let mut stored = base.to_owned();
    for number in 2..10_000 {
        if !files.join(&stored).exists() && !info.join(format!("{stored}.trashinfo")).exists() {
            break;
        }
        stored = format!("{base}_{number}");
        if number == 9_999 {
            return Err("Der Eintrag konnte nicht in den Papierkorb verschoben werden.".to_owned());
        }
    }
    let destination = files.join(&stored);
    let original = std::path::absolute(source).unwrap_or_else(|_| source.to_path_buf());
    fs::rename(source, &destination)
        .map_err(|_| "Der Eintrag konnte nicht in den Papierkorb verschoben werden.".to_owned())?;
    let when = trash_deletion_date();
    let record = format!(
        "[Trash Info]\nPath={}\nDeletionDate={when}\n",
        percent_encode(&original)
    );
    if notes::atomic_write(
        &info.join(format!("{stored}.trashinfo")),
        record.as_bytes(),
        0o600,
    )
    .is_err()
    {
        let _ = fs::rename(&destination, source);
        return Err("Der Eintrag konnte nicht in den Papierkorb verschoben werden.".to_owned());
    }
    Ok(())
}

/// Freedesktop trash info wants the user's local clock, with no zone suffix.
static TRASH_CLOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn trash_deletion_date() -> String {
    let _lock = TRASH_CLOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    trash_deletion_date_unlocked()
}

fn trash_deletion_date_unlocked() -> String {
    #[cfg(unix)]
    if let Some(stamp) = unix_local_stamp() {
        return stamp;
    }
    #[cfg(windows)]
    if let Some(stamp) = windows_local_stamp() {
        return stamp;
    }
    let when = notes::iso_now();
    when.split('.').next().unwrap_or(when.as_str()).to_owned()
}

#[cfg(unix)]
fn unix_local_stamp() -> Option<String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
    let secs = libc::time_t::try_from(now.as_secs()).ok()?;
    let mut local: libc::tm = unsafe { std::mem::zeroed() };
    let ptr = unsafe { libc::localtime_r(&secs, &mut local) };
    if ptr.is_null() {
        return None;
    }
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        local.tm_year + 1900,
        local.tm_mon + 1,
        local.tm_mday,
        local.tm_hour,
        local.tm_min,
        local.tm_sec
    ))
}

#[cfg(windows)]
fn windows_local_stamp() -> Option<String> {
    #[repr(C)]
    struct SystemTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetLocalTime(out: *mut SystemTime);
    }
    let mut time = unsafe { std::mem::zeroed::<SystemTime>() };
    unsafe { GetLocalTime(&mut time) };
    if time.month == 0 || time.day == 0 {
        return None;
    }
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        time.year, time.month, time.day, time.hour, time.minute, time.second
    ))
}

fn percent_encode(path: &Path) -> String {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut encoded = String::new();
    for byte in absolute.to_string_lossy().as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

/// Commands whose desktop handler calls `ensureBootstrap` before reading arguments.
fn session_revalidates_vault(channel: &str) -> bool {
    !onboarding_open(channel) && channel != "fanotes:write-file"
}

/// Node `fs.access(path, R_OK | W_OK)` for a vault that is already attached.
///
/// A missing vault keeps the command's own error. The folder stays attached
/// when access fails, matching a thrown error from `ensureBootstrap`.
fn ensure_remembered_vault_writable(host: &Host) -> Result<(), String> {
    let Some(root) = host.vault.as_deref() else {
        return Ok(());
    };
    match vault_write_access_error(root) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn onboarding_open(channel: &str) -> bool {
    // The desktop answers these while the first-run screen is still open.
    // `complete-onboarding` is included here and calls `ensureBootstrap` only
    // after the subject selection has been validated.
    matches!(
        channel,
        "fanotes:bootstrap"
            | "fanotes:complete-onboarding"
            | "fanotes:select-vault"
            | "fanotes:get-cached-tree"
            | "fanotes:close-subject-book-popout"
            | "fanotes:load-spelling-resources"
            | "fanotes:load-spelling-word-candidates"
            | "fanotes:load-handwriting-recognition-resources"
            | "fanotes:recognize-native-handwriting-line"
            | "fanotes:enhanced-math-get-state"
            | "fanotes:enhanced-math-install"
            | "fanotes:enhanced-math-recognize"
            | "fanotes:qwen-vision-get-state"
            | "fanotes:qwen-vision-install"
            | "fanotes:qwen-vision-recognize"
            | "fanotes:load-secure-settings"
            | "fanotes:reset-app-data"
            | "fanotes:update-get-state"
            | "fanotes:update-check"
            | "fanotes:update-download"
            | "fanotes:update-install"
            | "fanotes:open-external"
            | "fanotes:capture-window"
            | "fanotes:addons-fetch"
            | "fanotes:addons-list"
            | "fanotes:addons-save"
            | "fanotes:addons-remove"
            | "fanotes:addons-read-file"
            | "fanotes:addons-write-files"
            | "fanotes:addons-read-data"
            | "fanotes:addons-write-data"
            | "fanotes:addons-net-fetch"
            | "fanotes:sync-vault-id"
            | "fanotes:sync-scan"
            | "fanotes:sync-read"
            | "fanotes:sync-write"
            | "fanotes:sync-remove"
            | "fanotes:sync-read-state"
            | "fanotes:sync-write-state"
            | "fanotes:sync-read-secrets"
            | "fanotes:sync-write-secrets"
    )
}

fn note_byte_limit(relative: &str) -> u64 {
    if vault::posix_extname_en_us(relative) == ".famd" {
        MAX_FAMD_BYTES
    } else {
        MAX_TEXT_BYTES
    }
}

/// Electron `app.getPath('documents')` uses Chromium's `xdg_user_dir_lookup`.
///
/// A missing or unquoted documents entry is the home directory. `$HOME/Documents`
/// is used only when the config file says so. The last matching line wins.
fn default_documents_dir() -> PathBuf {
    documents_directory(
        std::env::var_os("HOME").as_deref(),
        std::env::var_os("XDG_CONFIG_HOME").as_deref(),
    )
}

fn documents_directory(
    home: Option<&std::ffi::OsStr>,
    config_home: Option<&std::ffi::OsStr>,
) -> PathBuf {
    let Some(home) = home.filter(|home| !home.is_empty()) else {
        return PathBuf::from("/tmp");
    };
    strip_trailing_separators(
        xdg_documents_dir(home, config_home).unwrap_or_else(|| PathBuf::from(home)),
    )
}

fn xdg_documents_dir(
    home: &std::ffi::OsStr,
    config_home: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    let config = config_home
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home).join(".config"));
    let bytes = fs::read(config.join("user-dirs.dirs")).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let mut found = None;
    for line in text.split('\n') {
        if let Some(dir) = documents_dir_from_line(line, home) {
            found = Some(dir);
        }
    }
    found
}

fn documents_dir_from_line(line: &str, home: &std::ffi::OsStr) -> Option<PathBuf> {
    let mut rest = line;
    while rest.starts_with([' ', '\t']) {
        rest = &rest[1..];
    }
    let rest = rest.strip_prefix("XDG_DOCUMENTS_DIR")?;
    let mut rest = rest;
    while rest.starts_with([' ', '\t']) {
        rest = &rest[1..];
    }
    let rest = rest.strip_prefix('=')?;
    let mut rest = rest;
    while rest.starts_with([' ', '\t']) {
        rest = &rest[1..];
    }
    let rest = rest.strip_prefix('"')?;
    let (relative, rest) = if let Some(tail) = rest.strip_prefix("$HOME/") {
        (true, tail)
    } else if rest.starts_with('/') {
        (false, rest)
    } else {
        return None;
    };
    let bytes = rest.as_bytes();
    let mut index = 0;
    let mut copied = Vec::new();
    while index < bytes.len() && bytes[index] != b'"' {
        if bytes[index] == b'\\' && index + 1 < bytes.len() {
            index += 1;
        }
        copied.push(bytes[index]);
        index += 1;
    }
    let mut path = std::ffi::OsString::new();
    if relative {
        path.push(home);
        path.push("/");
    }
    path.push(String::from_utf8_lossy(&copied).as_ref());
    Some(PathBuf::from(path))
}

/// Drop one trailing newline from `vault-path`. A trailing space stays.
fn stored_vault_path(text: &str) -> &str {
    let Some(without_newline) = text.strip_suffix('\n') else {
        return text;
    };
    without_newline.strip_suffix('\r').unwrap_or(without_newline)
}

fn strip_trailing_separators(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if text.len() <= 1 || !text.ends_with('/') {
        return path;
    }
    PathBuf::from(text.trim_end_matches('/'))
}

fn vault_path_digest(path: &Path) -> String {
    // Sync ids and the tree cache use `path.resolve`, not a symlink lookup.
    let absolute = node_resolve(path);
    let digest = Sha256::digest(absolute.to_string_lossy().as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn german_locale(locale: &str) -> bool {
    let lower = locale.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("de") else {
        return false;
    };
    rest.is_empty() || rest.starts_with(['-', '_', '.', '@'])
}

/// `de` or `en` from the same environment Electron's `app.getLocale()` reads.
///
/// `LANGUAGE` wins, including over `LC_ALL`. Its first non-empty `:` item is
/// the locale. A list with no item, such as `:::`, does not fall through.
/// An empty `LANGUAGE` is unset, so `LC_ALL`, then `LC_MESSAGES`, then `LANG`.
pub fn system_ui_language(
    language: &str,
    lc_all: &str,
    lc_messages: &str,
    lang: &str,
) -> &'static str {
    let locale = language_list_choice(language).unwrap_or_else(|| {
        [lc_all, lc_messages, lang]
            .into_iter()
            .find(|value| !value.is_empty())
            .unwrap_or("")
    });
    if german_locale(locale) {
        "de"
    } else {
        "en"
    }
}

/// The first non-empty `LANGUAGE` item, or `Some("")` when the list is set
/// but every item is empty.
fn language_list_choice(language: &str) -> Option<&str> {
    if language.is_empty() {
        return None;
    }
    Some(
        language
            .split(':')
            .find(|item| !item.is_empty())
            .unwrap_or(""),
    )
}

fn current_system_ui_language() -> &'static str {
    system_ui_language(
        &std::env::var("LANGUAGE").unwrap_or_default(),
        &std::env::var("LC_ALL").unwrap_or_default(),
        &std::env::var("LC_MESSAGES").unwrap_or_default(),
        &std::env::var("LANG").unwrap_or_default(),
    )
}

/// `navigator.language` for the system UI. Electron reports `de` for every
/// German locale and `en-US` when the locale is not German.
pub fn desktop_navigator_language() -> &'static str {
    if current_system_ui_language() == "de" {
        "de"
    } else {
        "en-US"
    }
}

#[cfg(test)]
mod system_language_tests {
    use super::system_ui_language;

    #[test]
    fn the_language_list_selects_the_desktop_ui_language() {
        assert_eq!(
            system_ui_language("de_DE:de", "", "", "en_US.UTF-8"),
            "de"
        );
        assert_eq!(
            system_ui_language("en", "de_DE.UTF-8", "de_DE.UTF-8", "de_DE.UTF-8"),
            "en"
        );
        assert_eq!(system_ui_language(":de", "", "", "en_US.UTF-8"), "de");
        assert_eq!(
            system_ui_language("en_US:de", "", "", "de_DE.UTF-8"),
            "en"
        );
        assert_eq!(system_ui_language(":::", "", "", "de_DE.UTF-8"), "en");
        assert_eq!(system_ui_language(" ", "", "", "de_DE.UTF-8"), "en");
        assert_eq!(system_ui_language("", "", "de_CH.UTF-8", "en_US.UTF-8"), "de");
        assert_eq!(
            system_ui_language("", "en_US.UTF-8", "de_DE.UTF-8", "de_DE.UTF-8"),
            "en"
        );
        assert_eq!(system_ui_language("", "", "", "de_AT.UTF-8"), "de");
        assert_eq!(system_ui_language("", "", "", "C"), "en");
    }
}

fn write_tree_cache(app_data: &Path, root: &Path, entries: &Value) {
    let identity = vault_path_digest(root);
    let path = app_data
        .join("tree-cache-v1")
        .join(format!("{identity}.json"));
    let Ok(text) = serde_json::to_string(&json!({
        "version": 1,
        "vaultIdentity": identity,
        "updatedAt": notes::iso_now(),
        "entries": entries,
    })) else {
        return;
    };
    let snapshot = format!("{text}\n");
    if snapshot.len() as u64 > MAX_TREE_CACHE_BYTES {
        return;
    }
    // Desktop `mkdir` uses mode `0o700` for `tree-cache-v1` before the write.
    if let Some(directory) = path.parent() {
        if ensure_private_profile_dir(directory).is_err() {
            return;
        }
    }
    let _ = notes::atomic_write(&path, snapshot.as_bytes(), 0o600);
}

fn read_tree_cache(app_data: &Path, root: &Path) -> Option<Value> {
    let identity = vault_path_digest(root);
    let path = app_data
        .join("tree-cache-v1")
        .join(format!("{identity}.json"));
    let meta = fs::symlink_metadata(&path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_TREE_CACHE_BYTES {
        return None;
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        // Desktop discards a cache it cannot read, then returns nothing.
        Err(_) => {
            let _ = fs::remove_file(&path);
            return None;
        }
    };
    let text = String::from_utf8_lossy(&bytes);
    let parsed = match serde_json::from_str::<Value>(&text) {
        Ok(parsed) => parsed,
        Err(_) => {
            let _ = fs::remove_file(&path);
            return None;
        }
    };
    // A wrong version or vault identity returns nothing and leaves the file.
    // A damaged cache is removed, matching the desktop read error path.
    if parsed.get("version").and_then(Value::as_f64) != Some(1.0)
        || parsed.get("vaultIdentity").and_then(Value::as_str) != Some(identity.as_str())
    {
        return None;
    }
    // A missing entry list fails the same way as a value that is not an array.
    // The desktop removes that cache.
    let Some(entries) = parsed.get("entries") else {
        let _ = fs::remove_file(&path);
        return None;
    };
    match clean_cached_entries(entries, "", 0, &mut 0) {
        Ok(entries) => Some(Value::Array(entries)),
        Err(()) => {
            let _ = fs::remove_file(&path);
            None
        }
    }
}

/// `Number.isSafeInteger` for a cached file size, from 0 through 1 GiB.
/// A JSON number `12.0` counts; `12.5` does not.
fn cached_file_size(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    let max = (1024 * 1024 * 1024) as f64;
    if number.is_finite() && number.fract() == 0.0 && (0.0..=max).contains(&number) {
        Some(number as u64)
    } else {
        None
    }
}

fn clean_cached_entries(
    candidate: &Value,
    parent: &str,
    depth: usize,
    count: &mut usize,
) -> Result<Vec<Value>, ()> {
    if depth > 80 {
        return Err(());
    }
    let list = candidate.as_array().ok_or(())?;
    let mut cleaned = Vec::new();
    for entry in list {
        *count += 1;
        if *count > MAX_TREE_CACHE_ENTRIES {
            return Err(());
        }
        let name = entry.get("name").and_then(Value::as_str).ok_or(())?;
        if name.is_empty()
            || vault::utf16_len(name) > 255
            || name.starts_with('.')
            || name.contains('/')
            || name.contains('\\')
            || name.contains('\0')
        {
            return Err(());
        }
        let expected = if parent.is_empty() {
            name.to_owned()
        } else {
            format!("{parent}/{name}")
        };
        if entry.get("relativePath").and_then(Value::as_str) != Some(expected.as_str()) {
            return Err(());
        }
        match entry.get("kind").and_then(Value::as_str) {
            Some("folder") => {
                // `entry.color !== undefined` rejects null. A missing color stays absent.
                if entry.get("color").is_some_and(|color| {
                    color
                        .as_str()
                        .filter(|value| folder_color_hex(value))
                        .is_none()
                }) {
                    return Err(());
                }
                let empty_children = Value::Array(Vec::new());
                let children_source = match entry.get("children") {
                    Some(Value::Null) | None => &empty_children,
                    Some(value) => value,
                };
                let children = clean_cached_entries(children_source, &expected, depth + 1, count)?;
                let mut folder = json!({
                    "name": name,
                    "relativePath": expected,
                    "kind": "folder",
                    "children": children,
                });
                if let Some(color) = entry
                    .get("color")
                    .and_then(Value::as_str)
                    .filter(|value| folder_color_hex(value))
                {
                    folder["color"] = json!(color.to_ascii_lowercase());
                }
                cleaned.push(folder);
            }
            Some("file") => {
                let extension = extension_label(name);
                if extension.is_empty() || !tree_extension(&extension) {
                    return Err(());
                }
                let mut file = json!({
                    "name": name,
                    "relativePath": expected,
                    "kind": "file",
                    "extension": extension,
                });
                if let Some(modified) = entry.get("modifiedAt") {
                    let text = modified
                        .as_str()
                        .filter(|text| drawings::canonical_iso(text).is_some())
                        .ok_or(())?;
                    file["modifiedAt"] = json!(text);
                }
                if let Some(size) = entry.get("size") {
                    // `Number.isSafeInteger` keeps a whole size such as `12.0`.
                    let size = cached_file_size(size).ok_or(())?;
                    file["size"] = json!(size);
                }
                cleaned.push(file);
            }
            _ => return Err(()),
        }
    }
    // Desktop `cleanCachedTreeEntries` sorts every level with `compareEntries`.
    cleaned.sort_by(entry_name_order);
    Ok(cleaned)
}

fn read_tree(
    root: &Path,
    directory: &Path,
    colors: &BTreeMap<String, String>,
    depth: usize,
    stats: bool,
) -> Result<Value, String> {
    if depth > 80 {
        return Ok(json!([]));
    }
    let mut children = Vec::new();
    // Desktop `readdir` throws `scandir`. The fast tree omits that folder.
    let entries = read_sibling_dir(directory)?;
    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let relative = vault::relative_posix(root, &path);
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            let Ok(real) = fs::canonicalize(&path) else {
                continue;
            };
            let Ok(root_real) = fs::canonicalize(root) else {
                continue;
            };
            if !vault::is_inside_root(&root_real, &real) {
                continue;
            }
            let nested = if stats {
                read_tree(root, &path, colors, depth + 1, stats)?
            } else {
                match read_tree(root, &path, colors, depth + 1, stats) {
                    Ok(nested) => nested,
                    Err(_) => continue,
                }
            };
            let mut folder = json!({
                "name": name,
                "relativePath": relative,
                "kind": "folder",
                "children": nested,
            });
            if stats {
                if let Ok(modified) = meta.modified() {
                    folder["modifiedAt"] = Value::String(notes::iso_from_system_time(modified));
                }
            }
            if let Some(color) = colors.get(&relative) {
                folder["color"] = Value::String(color.clone());
            }
            children.push(folder);
        } else if meta.is_file() {
            let extension = extension_label(&name);
            if !tree_extension(&extension) {
                continue;
            }
            let mut file = json!({
                "name": name,
                "relativePath": relative,
                "kind": "file",
                "extension": extension,
            });
            if stats {
                file["size"] = json!(meta.len());
                if let Ok(modified) = meta.modified() {
                    file["modifiedAt"] = Value::String(notes::iso_from_system_time(modified));
                }
            }
            children.push(file);
        }
    }
    children = omit_famd_companions(children);
    children.sort_by(entry_name_order);
    Ok(Value::Array(children))
}

fn tree_extension(extension: &str) -> bool {
    matches!(
        extension,
        "md" | "markdown"
            | "famd"
            | "pdf"
            | "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "gif"
            | "svg"
            | "mp3"
            | "wav"
            | "ogg"
            | "m4a"
            | "mp4"
            | "webm"
    )
}

fn omit_famd_companions(entries: Vec<Value>) -> Vec<Value> {
    let mut stems = std::collections::HashSet::new();
    for entry in &entries {
        if entry["kind"].as_str() == Some("file")
            && matches!(entry["extension"].as_str(), Some("md" | "markdown" | "pdf"))
        {
            if let Some(name) = entry["name"].as_str() {
                let stem = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name);
                stems.insert(vault::entry_name_key(stem));
            }
        }
    }
    entries
        .into_iter()
        .filter(|entry| {
            if entry["extension"].as_str() != Some("famd") {
                return true;
            }
            let name = entry["name"].as_str().unwrap_or("");
            let stem = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name);
            !stems.contains(&vault::entry_name_key(stem))
        })
        .collect()
}

fn folder_color_hex(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit())
}

fn read_folder_colors(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let path = internal_directory(root)?.join("folder-colors.json");
    // Desktop reads this file with Buffer.toString('utf8') and checks the byte size.
    let text = match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(vault::node_lstat_error(&path, &error)),
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > 512 * 1024 => {
            return Err("Die Ordnerfarben sind ungültig oder zu groß.".to_owned());
        }
        Ok(_) => match fs::read(&path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BTreeMap::new());
            }
            // Desktop rethrows the `readFile` error. Invalid JSON stays empty.
            Err(error) => return Err(notes::node_open_error(&path, &error)),
        },
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return Ok(BTreeMap::new());
    };
    // A nested `colors` object is the current file. A flat map can also use
    // `colors` as a folder name, and that string is not the nested object.
    let source = if parsed.get("colors").is_some_and(Value::is_object) {
        &parsed["colors"]
    } else {
        &parsed
    };
    let Some(object) = source.as_object() else {
        return Ok(BTreeMap::new());
    };
    let mut colors = BTreeMap::new();
    for (path, color) in object.iter().take(5000) {
        let Some(color) = color.as_str().filter(|value| folder_color_hex(value)) else {
            continue;
        };
        let Ok(normalized) = vault::normalize_relative_path(path, false, false) else {
            continue;
        };
        colors.insert(normalized, color.to_ascii_lowercase());
    }
    Ok(colors)
}

fn write_folder_colors(root: &Path, colors: &BTreeMap<String, String>) -> Result<(), String> {
    let internal = internal_directory(root)?;
    let mut entries: Vec<_> = colors.iter().take(5000).collect();
    entries.sort_by(|left, right| dictionary_order(left.0, right.0));
    let colors_json = if entries.is_empty() {
        "{}".to_owned()
    } else {
        let mut body = String::from("{\n");
        for (index, (path, color)) in entries.iter().enumerate() {
            let comma = if index + 1 == entries.len() { "" } else { "," };
            body.push_str(&format!(
                "    {}: {}{comma}\n",
                serde_json::to_string(path).unwrap_or_else(|_| "\"\"".to_owned()),
                serde_json::to_string(color).unwrap_or_else(|_| "\"\"".to_owned()),
            ));
        }
        body.push_str("  }");
        body
    };
    let snapshot = format!("{{\n  \"version\": 1,\n  \"colors\": {colors_json}\n}}\n");
    if snapshot.len() > 512 * 1024 {
        return Err("Zu viele Ordnerfarben für diesen Vault.".to_owned());
    }
    notes::atomic_write(
        &internal.join("folder-colors.json"),
        snapshot.as_bytes(),
        0o600,
    )?;
    Ok(())
}

fn move_note_companion(root: &Path, old_relative: &str, new_relative: &str) {
    let Some(old_companion) = note_companion_relative(old_relative) else {
        return;
    };
    let Some(new_companion) = note_companion_relative(new_relative) else {
        return;
    };
    let Ok(source) = vault::resolve_existing_entry(root, &old_companion) else {
        return;
    };
    if !fs::symlink_metadata(&source)
        .is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink())
    {
        return;
    }
    let Ok(destination) = vault::resolve_note_file(root, &new_companion) else {
        return;
    };
    if let Some(parent) = destination.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::rename(source, destination);
}

fn note_companion_relative(relative: &str) -> Option<String> {
    let extension = vault::posix_extname_en_us(relative);
    let extension = match extension.as_str() {
        ".famd" => ".md",
        ".md" | ".markdown" | ".pdf" => ".famd",
        _ => return None,
    };
    Some(fanotes_famd::companion_note_path(relative, extension))
}

fn forget_folder_colors(root: &Path, relative: &str) -> Result<(), String> {
    let mut colors = read_folder_colors(root)?;
    let before = colors.len();
    colors.retain(|path, _| path != relative && !path.starts_with(&format!("{relative}/")));
    if colors.len() != before {
        write_folder_colors(root, &colors)?;
    }
    Ok(())
}

fn retarget_folder_colors(root: &Path, old: &str, new: &str) -> Result<(), String> {
    let mut colors = read_folder_colors(root)?;
    let keys: Vec<String> = colors.keys().cloned().collect();
    let mut changed = false;
    for key in keys {
        if key != old && !key.starts_with(&format!("{old}/")) {
            continue;
        }
        let Some(color) = colors.remove(&key) else {
            continue;
        };
        let next = if key == old {
            new.to_owned()
        } else {
            format!("{new}{}", &key[old.len()..])
        };
        colors.insert(next, color);
        changed = true;
    }
    if changed {
        write_folder_colors(root, &colors)?;
    }
    Ok(())
}

fn remember_drawing_owner(
    owners: &mut std::collections::HashMap<String, String>,
    note: &str,
    markdown: &str,
    ink: Option<&Value>,
) {
    if let Some(id) = drawings::note_ink_marker_id(markdown) {
        owners.entry(id).or_insert_with(|| note.to_owned());
    }
    let Some(id) = ink
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .filter(|id| is_drawing_id(id))
    else {
        return;
    };
    owners
        .entry(id.to_owned())
        .or_insert_with(|| note.to_owned());
}

fn is_drawing_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn search_drawings(
    root: &Path,
    needle: &str,
    query: &str,
    owners: &std::collections::HashMap<String, String>,
    hits: &mut Vec<Value>,
) -> Result<(), String> {
    // Desktop search calls `ensureInternalAssetsDirectory` before it lists drawings.
    let assets = drawings::assets_dir(root)?;
    let entries = read_sibling_dir(&assets)?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some((id, extension)) = name.rsplit_once('.') else {
            continue;
        };
        // Search opens `${id}.json`, so only a lowercase suffix is a drawing.
        if extension != "json" || !is_drawing_id(id) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > 24 * 1024 * 1024 {
            continue;
        }
        // Desktop search decodes drawing JSON with Buffer.toString('utf8').
        let Some(text) = notes::read_lossy_string(&path) else {
            continue;
        };
        let Ok(document) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let fallback = meta.modified().ok().map(notes::iso_from_system_time);
        let Ok(metadata) = drawings::library_metadata(&document, id, fallback.as_deref()) else {
            continue;
        };
        let title = metadata["title"].as_str().unwrap_or("");
        let transcript = bounded_transcript(
            document
                .get("searchTranscript")
                .and_then(Value::as_str)
                .unwrap_or(""),
        );
        let searchable = format!("{title}\n{transcript}");
        let haystack = vault::locale_lower_de(&searchable);
        let Some(first) = haystack.find(needle) else {
            continue;
        };
        let (start, _) = original_match_span(&searchable, needle, first);
        let mut hit = json!({
            "relativePath": format!(".fanotes/assets/{id}.json"),
            "title": title,
            "excerpt": excerpt(&searchable, start, vault::utf16_len(query)),
            "matches": count_matches(&haystack, needle),
            "kind": "drawing",
            "drawingId": id,
        });
        if let Some(note) = owners.get(id) {
            hit["notePath"] = Value::String(note.clone());
        }
        if let Some(anchor) = ink_anchor(&transcript, query) {
            hit["inkAnchor"] = json!({ "y": anchor });
        }
        hits.push(hit);
    }
    Ok(())
}

struct SearchFile {
    relative: String,
    path: PathBuf,
}

/// `splitName(path.basename(file)).stem` from the desktop search hit.
fn search_title(relative: &str) -> &str {
    let base = relative.rsplit('/').next().unwrap_or(relative);
    let extension = vault::posix_extname(base);
    if extension.is_empty() {
        base
    } else {
        &base[..base.len() - extension.len()]
    }
}

fn collect_search_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<SearchFile>,
    depth: usize,
) -> Result<(), String> {
    if depth > 80 {
        return Ok(());
    }
    // A nested folder that cannot be listed fails the search, as on the desktop.
    for entry in read_sibling_dir(directory)? {
        let Ok(entry) = entry else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            let Ok(real) = fs::canonicalize(&path) else {
                continue;
            };
            let Ok(root_real) = fs::canonicalize(root) else {
                continue;
            };
            if !vault::is_inside_root(&root_real, &real) {
                continue;
            }
            collect_search_files(root, &path, files, depth + 1)?;
            continue;
        }
        let extension = extension_label(&name);
        if !matches!(extension.as_str(), "md" | "markdown" | "famd" | "pdf") {
            continue;
        }
        let max = if extension == "pdf" {
            PDF_ASSET_MAX
        } else {
            MAX_TEXT_BYTES
        };
        if meta.len() > max {
            continue;
        }
        files.push(SearchFile {
            relative: vault::relative_posix(root, &path),
            path,
        });
    }
    Ok(())
}

fn bounded_transcript(value: &str) -> String {
    vault::truncate_utf16(value, 500_000)
}

fn ink_transcript(ink: Option<&Value>) -> String {
    bounded_transcript(
        ink.and_then(|value| value.get("searchTranscript"))
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
}

fn read_search_companion(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_FAMD_BYTES {
        return None;
    }
    notes::read_lossy_string(path)
}

fn count_matches(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut matches = 0;
    let mut cursor = 0;
    while let Some(index) = haystack[cursor..].find(needle) {
        matches += 1;
        cursor += index + needle.len().max(1);
        if cursor >= haystack.len() {
            break;
        }
    }
    matches
}

/// Maps a hit in `text.to_lowercase()` back onto `text`.
///
/// Some letters grow when folded (`İ` becomes `i` plus a combining dot). The
/// lowercase byte index is then past the original note, and `excerpt` must
/// not use it as a slice bound.
fn original_match_span(text: &str, needle: &str, folded_index: usize) -> (usize, usize) {
    let needle_len = needle.len();
    if needle_len == 0 {
        let start = floor_char_boundary(text, folded_index);
        return (start, 0);
    }
    let folded_end = folded_index.saturating_add(needle_len);
    if folded_end <= text.len()
        && text.is_char_boundary(folded_index)
        && text.is_char_boundary(folded_end)
        && vault::locale_lower_de(&text[folded_index..folded_end]) == needle
    {
        return (folded_index, needle_len);
    }
    let mut produced = 0usize;
    let mut start = None;
    for (offset, ch) in text.char_indices() {
        let folded_len = vault::locale_lower_de(ch.encode_utf8(&mut [0; 4])).len();
        let next = produced + folded_len;
        if start.is_none() && next > folded_index {
            start = Some(offset);
        }
        if start.is_some() && next >= folded_end {
            let start = start.unwrap_or(0);
            let end = offset + ch.len_utf8();
            return (start, end.saturating_sub(start));
        }
        produced = next;
    }
    let start = start.unwrap_or_else(|| floor_char_boundary(text, folded_index));
    (start, text.len().saturating_sub(start))
}

fn floor_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn excerpt(text: &str, match_byte: usize, query_units: usize) -> String {
    let match_units = utf16_units_before(text, match_byte);
    let total = vault::utf16_len(text);
    let start_units = match_units.saturating_sub(95);
    let end_units = match_units
        .saturating_add(query_units)
        .saturating_add(145)
        .min(total);
    let (start, end) = byte_range_for_utf16(text, start_units, end_units);
    let slice = collapse_js_whitespace(text.get(start..end).unwrap_or(""));
    format!(
        "{}{slice}{}",
        if start_units > 0 { "…" } else { "" },
        if end_units < total { "…" } else { "" }
    )
}

fn js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn collapse_js_whitespace(text: &str) -> String {
    let mut collapsed = String::new();
    let mut pending = false;
    let mut started = false;
    for character in text.chars() {
        if js_whitespace(character) {
            if started {
                pending = true;
            }
            continue;
        }
        if pending {
            collapsed.push(' ');
            pending = false;
        }
        started = true;
        collapsed.push(character);
    }
    collapsed
}

fn utf16_units_before(text: &str, byte_index: usize) -> usize {
    text.char_indices()
        .take_while(|(index, _)| *index < byte_index)
        .map(|(_, character)| character.len_utf16())
        .sum()
}

fn byte_range_for_utf16(text: &str, start_units: usize, end_units: usize) -> (usize, usize) {
    let mut units = 0usize;
    let mut start_byte = None;
    let mut end_byte = text.len();
    for (index, character) in text.char_indices() {
        if start_byte.is_none() && units >= start_units {
            start_byte = Some(index);
        }
        if units >= end_units {
            end_byte = index;
            break;
        }
        units += character.len_utf16();
        if units >= end_units {
            end_byte = index + character.len_utf8();
            break;
        }
    }
    (start_byte.unwrap_or(0), end_byte)
}

fn ink_anchor(transcript: &str, query: &str) -> Option<f64> {
    let needle = vault::locale_lower_de(vault::js_trim(query));
    if vault::utf16_len(&needle) < 2 || vault::js_trim(transcript).is_empty() {
        return None;
    }
    let lines: Vec<&str> = transcript
        .split('\n')
        .map(vault::js_trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return None;
    }
    let parsed: Vec<(Option<f64>, String)> = lines
        .iter()
        .map(|line| match transcript_position(line) {
            Some((y, text)) => (Some(y), text),
            None => (None, (*line).to_owned()),
        })
        .collect();
    let index = parsed
        .iter()
        .position(|(_, text)| vault::locale_lower_de(text).contains(&needle))?;
    parsed[index].0.or_else(|| {
        if parsed.len() == 1 {
            Some(0.15)
        } else {
            Some(index as f64 / (parsed.len() - 1) as f64)
        }
    })
}

/// `^(\d+(?:\.\d+)?)\t(.*)$` from the desktop handwriting search.
fn transcript_position(line: &str) -> Option<(f64, String)> {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        regex::Regex::new(r"^([0-9]+(?:\.[0-9]+)?)\t(.*)$").expect("transcript line pattern")
    });
    let caps = pattern.captures(line)?;
    let y: f64 = caps.get(1)?.as_str().parse().ok()?;
    if !y.is_finite() {
        return None;
    }
    Some((
        y.clamp(0.0, 1.0),
        vault::js_trim(caps.get(2)?.as_str()).to_owned(),
    ))
}

#[cfg(test)]
mod sort_tests {
    use super::compare_names;
    use std::cmp::Ordering;

    #[test]
    fn notebook_folders_use_base_order_without_numeric_runs() {
        use super::{base_dictionary_order, numeric_dictionary_order};
        assert_eq!(
            base_dictionary_order("Seite 2", "Seite 02"),
            Ordering::Greater
        );
        assert_eq!(
            base_dictionary_order("Mathematik", "mathematik"),
            Ordering::Equal
        );
        assert_eq!(base_dictionary_order("Straße", "Strasse"), Ordering::Equal);
        assert_eq!(base_dictionary_order("Apfel", "Äpfel"), Ordering::Equal);
        assert_eq!(
            base_dictionary_order("Kapitel 10", "Kapitel 2"),
            Ordering::Less
        );
        assert_eq!(
            numeric_dictionary_order("Kapitel 10", "Kapitel 2"),
            Ordering::Greater
        );
        assert_eq!(compare_names("Seite 2", "Seite 02"), Ordering::Equal);
        assert_eq!(compare_names("Apfel", "apfel"), Ordering::Equal);
        assert_eq!(compare_names("\u{A7D3}", "\u{A7CE}"), Ordering::Less);
        assert_eq!(compare_names("\u{A7CE}", "\u{A7CF}"), Ordering::Less);
        assert_eq!(compare_names("\u{A7CF}", "\u{A7D2}"), Ordering::Less);
        assert_eq!(compare_names("\u{A7D4}", "\u{16EA0}"), Ordering::Less);
        assert_eq!(compare_names("\u{16EA0}", "\u{16EBB}"), Ordering::Less);
        assert_eq!(compare_names("字", "\u{A7CE}"), Ordering::Less);
        assert_eq!(
            base_dictionary_order("\u{A7CE}", "\u{A7CF}"),
            Ordering::Less
        );
    }

    #[test]
    fn german_names_use_the_electron_base_order() {
        assert_eq!(compare_names("Äpfel", "Apfel"), Ordering::Equal);
        assert_eq!(compare_names("Straße", "Strasse"), Ordering::Equal);
        assert_eq!(compare_names("Mu\u{0308}he", "Mühe"), Ordering::Equal);
        assert_eq!(compare_names("02", "2"), Ordering::Equal);
        assert_eq!(compare_names("Seite 2", "Seite 10"), Ordering::Less);
        assert_eq!(compare_names("Äpfel", "Zen"), Ordering::Less);
        assert_eq!(compare_names("Über", "Zen"), Ordering::Less);
        assert_eq!(compare_names("ð", "d"), Ordering::Equal);
        assert_eq!(compare_names("ﬁle", "file"), Ordering::Equal);
        assert_eq!(compare_names("Note2", "Note 2"), Ordering::Greater);
        assert_eq!(compare_names("2.0", "2"), Ordering::Greater);
        assert_eq!(compare_names("2.0", "2.00"), Ordering::Equal);
        assert_eq!(compare_names("1,5", "1.5"), Ordering::Less);
        assert_eq!(compare_names("Þ", "Th"), Ordering::Greater);
        assert_eq!(compare_names("łódź", "lodz"), Ordering::Equal);
        assert_eq!(compare_names("a b", "ab"), Ordering::Less);
    }

    #[test]
    fn onenote_pages_use_numeric_german_dictionary_order() {
        let mut pages = [
            "Seite 10.html",
            "Seite 2.html",
            "apfel.html",
            "äpfel.html",
            "strasse.html",
            "straße.html",
            "ä.html",
        ];
        pages.sort_by(|left, right| super::numeric_dictionary_order(left, right));
        assert_eq!(
            pages,
            [
                "ä.html",
                "apfel.html",
                "äpfel.html",
                "Seite 2.html",
                "Seite 10.html",
                "strasse.html",
                "straße.html",
            ]
        );
    }
}

#[cfg(test)]
mod search_span_tests {
    use super::{excerpt, original_match_span};

    #[test]
    fn a_growing_case_fold_keeps_the_match_on_the_original_letters() {
        let city = "İstanbul";
        let needle = "stan";
        let index = city.to_lowercase().find(needle).unwrap();
        let (start, span) = original_match_span(city, needle, index);
        assert_eq!(&city[start..start + span], "stan");

        let note = format!("{}Zielwort", "İ".repeat(120));
        let word = "zielwort";
        let folded = note.to_lowercase().find(word).unwrap();
        assert!(folded > note.len());
        let (start, span) = original_match_span(&note, word, folded);
        assert_eq!(&note[start..start + span], "Zielwort");
        let window = excerpt(&note, start, span);
        assert!(window.contains("Zielwort"), "{window}");
        let _ = excerpt("kurz", 10_000, word.len());
    }

    #[test]
    fn a_search_excerpt_collapses_javascript_whitespace() {
        let text = "Hallo\u{FEFF}Welt\nZiel\u{0085}Wort";
        let index = text.find("Ziel").unwrap();
        assert_eq!(excerpt(text, index, 4), "Hallo Welt Ziel\u{0085}Wort");
    }

    #[test]
    fn a_handwriting_transcript_stops_at_500_000_utf16_units() {
        let transcript = format!("{}Ziel", "😀".repeat(250_000));
        let ink = serde_json::json!({ "searchTranscript": transcript });
        let kept = super::ink_transcript(Some(&ink));
        assert_eq!(crate::vault::utf16_len(&kept), 500_000);
        assert!(!kept.contains("Ziel"));
    }
}

#[cfg(test)]
mod ink_anchor_tests {
    use super::ink_anchor;

    #[test]
    fn a_handwriting_anchor_uses_the_desktop_line_pattern() {
        assert_eq!(ink_anchor("0.4200\tChlorophyll", "chlor"), Some(0.42));
        assert_eq!(ink_anchor("1e2\tChlorophyll", "chlor"), Some(0.15));
        assert_eq!(ink_anchor("1.\tHallo", "hallo"), Some(0.15));
        assert_eq!(
            ink_anchor("1e2\tChlorophyll\n0.2500\tBlattgrün", "chlor"),
            Some(0.0)
        );
        assert_eq!(
            ink_anchor("1e2\tChlorophyll\n0.2500\tBlattgrün", "blatt"),
            Some(0.25)
        );
        assert_eq!(
            ink_anchor("0.2000\twort\r0.8000\tanders", "anders"),
            Some(0.2)
        );
    }
}

#[cfg(all(test, unix))]
mod trash_date_tests {
    use super::TRASH_CLOCK;
    use std::ffi::OsString;
    use std::time::{SystemTime, UNIX_EPOCH};

    unsafe extern "C" {
        fn tzset();
    }

    struct RestoreTz(Option<OsString>);

    impl Drop for RestoreTz {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => unsafe { std::env::set_var("TZ", value) },
                None => unsafe { std::env::remove_var("TZ") },
            }
            unsafe { tzset() }
        }
    }

    fn stamp_epoch(stamp: &str) -> i64 {
        let mut time: libc::tm = unsafe { std::mem::zeroed() };
        time.tm_year = stamp[0..4].parse::<i32>().unwrap() - 1900;
        time.tm_mon = stamp[5..7].parse::<i32>().unwrap() - 1;
        time.tm_mday = stamp[8..10].parse::<i32>().unwrap();
        time.tm_hour = stamp[11..13].parse::<i32>().unwrap();
        time.tm_min = stamp[14..16].parse::<i32>().unwrap();
        time.tm_sec = stamp[17..19].parse::<i32>().unwrap();
        unsafe { libc::timegm(&mut time) }
    }

    #[test]
    fn the_trash_record_uses_the_local_clock() {
        let _lock = TRASH_CLOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let _restore = RestoreTz(std::env::var_os("TZ"));
        unsafe { std::env::set_var("TZ", "Pacific/Kiritimati") };
        unsafe { tzset() };
        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let stamp = super::trash_deletion_date_unlocked();
        let after = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        assert_eq!(stamp.len(), 19, "{stamp}");
        assert_eq!(&stamp[10..11], "T");
        assert!(!stamp.contains('Z'), "{stamp}");
        assert!(!stamp.contains('.'), "{stamp}");
        let local = stamp_epoch(&stamp);
        assert!(
            (13 * 3600..=15 * 3600).contains(&(local - before))
                && (13 * 3600..=15 * 3600).contains(&(local - after)),
            "{stamp} is not fourteen hours ahead of UTC ({before})"
        );
    }
}

#[cfg(test)]
mod documents_dir_tests {
    use super::documents_directory;
    use std::fs;
    use std::path::Path;

    fn config(home: &Path, body: &str) -> std::ffi::OsString {
        let dir = home.join("config");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("user-dirs.dirs"), body).unwrap();
        dir.into_os_string()
    }

    #[test]
    fn the_documents_folder_follows_xdg_user_dir_lookup() {
        let root = std::env::temp_dir().join(format!(
            "fanotes-docs-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let home_os = home.as_os_str();

        assert_eq!(
            documents_directory(Some(home_os), Some(root.join("missing").as_os_str())),
            home
        );
        assert_eq!(documents_directory(None, None), Path::new("/tmp"));

        let quoted = config(&home, "XDG_DOCUMENTS_DIR=\"$HOME/Documents\"\n");
        assert_eq!(
            documents_directory(Some(home_os), Some(quoted.as_os_str())),
            home.join("Documents")
        );

        let spaced = config(
            &home,
            "XDG_DOCUMENTS_DIR = \"$HOME/Notes\"\nXDG_DOCUMENTS_DIR=\"/absolute/Docs\"\n",
        );
        assert_eq!(
            documents_directory(Some(home_os), Some(spaced.as_os_str())),
            Path::new("/absolute/Docs")
        );

        let bare = config(
            &home,
            "XDG_DOCUMENTS_DIR=\"$HOME\"\nXDG_DOCUMENTS_DIR=$HOME/Nope\n",
        );
        assert_eq!(
            documents_directory(Some(home_os), Some(bare.as_os_str())),
            home
        );

        let escaped = config(&home, "XDG_DOCUMENTS_DIR=\"$HOME/My\\\"Docs\"\n");
        assert_eq!(
            documents_directory(Some(home_os), Some(escaped.as_os_str())),
            home.join("My\"Docs")
        );

        fs::create_dir_all(home.join(".config")).unwrap();
        fs::write(
            home.join(".config/user-dirs.dirs"),
            "XDG_DOCUMENTS_DIR=\"$HOME/Documents/\"\n",
        )
        .unwrap();
        assert_eq!(
            documents_directory(Some(home_os), Some(std::ffi::OsStr::new(""))),
            home.join("Documents")
        );
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod folder_color_order_tests {
    use super::read_folder_colors;
    use std::fs;

    #[test]
    fn folder_colors_keep_the_first_entries_in_file_order() {
        let root = std::env::temp_dir().join(format!(
            "fanotes-colors-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".fanotes")).unwrap();
        let mut body =
            String::from("{\n  \"version\": 1,\n  \"colors\": {\n    \"zzz\": \"#112233\"");
        for index in 0..5000 {
            body.push_str(&format!(",\n    \"a{index:04}\": \"#abcdef\""));
        }
        body.push_str("\n  }\n}\n");
        fs::write(root.join(".fanotes/folder-colors.json"), body).unwrap();
        let colors = read_folder_colors(&root).unwrap();
        assert_eq!(colors.get("zzz").map(String::as_str), Some("#112233"));
        assert!(colors.get("a4999").is_none());
        assert_eq!(colors.len(), 5000);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_flat_color_file_can_name_a_folder_colors() {
        let root = std::env::temp_dir().join(format!(
            "fanotes-colors-flat-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".fanotes")).unwrap();
        fs::write(
            root.join(".fanotes/folder-colors.json"),
            "{\n  \"colors\": \"#112233\",\n  \"Mathe\": \"#abcdef\"\n}\n",
        )
        .unwrap();
        let colors = read_folder_colors(&root).unwrap();
        assert_eq!(colors.get("colors").map(String::as_str), Some("#112233"));
        assert_eq!(colors.get("Mathe").map(String::as_str), Some("#abcdef"));

        fs::write(
            root.join(".fanotes/folder-colors.json"),
            "{\n  \"version\": 1,\n  \"colors\": {\n    \"Mathe\": \"#445566\"\n  }\n}\n",
        )
        .unwrap();
        let nested = read_folder_colors(&root).unwrap();
        assert_eq!(nested.get("Mathe").map(String::as_str), Some("#445566"));
        assert!(nested.get("version").is_none());
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod sync_mtime_tests {
    use super::arg_mtime_ms;
    use serde_json::json;

    #[test]
    fn a_positive_fraction_under_one_millisecond_is_the_epoch() {
        assert_eq!(arg_mtime_ms(Some(&json!(0.9))), Some(0));
        assert_eq!(arg_mtime_ms(Some(&json!("0.9"))), Some(0));
        assert_eq!(arg_mtime_ms(Some(&json!(1.9))), Some(1));
        assert_eq!(arg_mtime_ms(Some(&json!(0))), None);
        assert_eq!(arg_mtime_ms(Some(&json!(-1))), None);
        assert_eq!(
            arg_mtime_ms(Some(&json!(8_640_000_000_000_000.0_f64))),
            Some(8_640_000_000_000_000)
        );
        assert_eq!(arg_mtime_ms(Some(&json!(1.0e16_f64))), None);
    }
}

#[cfg(test)]
mod recognition_model_write_tests {
    use super::Host;

    #[cfg(unix)]
    #[test]
    fn an_unwritable_recognition_folder_reports_the_desktop_mkdir_error() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "fanotes-recognition-mkdir-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let locked = root.join("vault");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        struct Restore(std::path::PathBuf);
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o700));
                if let Some(parent) = self.0.parent() {
                    let _ = std::fs::remove_dir_all(parent);
                }
            }
        }
        let _restore = Restore(locked.clone());
        let mut host = Host::open(root.join("app"));
        host.vault = Some(locked.clone());
        assert_eq!(
            host.write_recognition_model("{}").unwrap_err(),
            format!(
                "EACCES: permission denied, mkdir '{}'",
                locked.join(".fanotes").display()
            )
        );
        assert!(!locked.join(".fanotes").exists());
    }
}
