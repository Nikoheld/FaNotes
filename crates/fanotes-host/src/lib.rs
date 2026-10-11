//! Desktop host operations behind `FaNotesApi`.
//!
//! Tauri commands use the preload channel strings. Electron stays the release host:
//! update commands report `supported: false` and do not install a package.

mod addons;
mod channels;
mod drawings;
mod imports;
mod notes;
mod ocr;
mod onenote;
mod policy;
mod vault;
mod worksheets;

mod ai;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::Engine;
use filetime::{set_file_mtime, FileTime};

use serde_json::{json, Map, Value};

pub use channels::{find_channel, ChannelKind, CHANNELS};
pub use policy::{addon_request_allowed, local_ai_origin};

const SECRET_KEYS: &[&str] = &[
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
    pub app_data: PathBuf,
    pub settings: Map<String, Value>,
    pub onboarding_required: bool,
    pub close_requested: bool,
    /// Native file dialogs. The channel sweep turns this off so a picker cannot block the test.
    pub file_dialogs: bool,
}

impl Host {
    pub fn open(app_data: PathBuf) -> Self {
        fs::create_dir_all(&app_data).ok();
        let mut host = Self {
            vault: None,
            app_data,
            settings: default_settings(),
            onboarding_required: false,
            close_requested: false,
            file_dialogs: true,
        };
        host.load_persisted();
        host
    }

    pub fn set_vault(&mut self, path: PathBuf) -> Result<(), String> {
        let meta =
            fs::metadata(&path).map_err(|_| "Der Vault wurde unsicher verändert.".to_owned())?;
        if !meta.is_dir() {
            return Err("Der Vault wurde unsicher verändert.".to_owned());
        }
        self.vault = Some(path);
        Ok(())
    }

    fn require_vault(&self) -> Result<&Path, String> {
        self.vault
            .as_deref()
            .ok_or_else(|| "Der Vault ist noch nicht initialisiert.".to_owned())
    }

    pub fn dispatch(&mut self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let binding =
            find_channel(channel).ok_or_else(|| format!("Unbekannter Kanal: {channel}"))?;
        match binding.kind {
            ChannelKind::Event => return Ok(Value::Null),
            ChannelKind::Message => return self.dispatch_message(channel),
            ChannelKind::Command => {}
        }
        match channel {
            "fanotes:bootstrap" => self.bootstrap(),
            "fanotes:complete-onboarding" => {
                self.onboarding_required = false;
                self.persist_settings()?;
                self.bootstrap()
            }
            "fanotes:get-cached-tree" | "fanotes:get-fast-tree" | "fanotes:get-tree" => self.tree(),
            "fanotes:select-vault" => self.select_vault(args),
            "fanotes:read-file" => self.read_file(&arg_string(args, 0)?),
            "fanotes:write-file" => self.write_file(&arg_string(args, 0)?, &arg_string(args, 1)?),
            "fanotes:read-recognition-model" => {
                self.read_internal(".fanotes/recognition-model.json")
            }
            "fanotes:write-recognition-model" => {
                self.write_internal(".fanotes/recognition-model.json", &arg_string(args, 0)?)
            }
            "fanotes:create-note" => self.create_entry(
                &arg_string(args, 0)?,
                arg_string(args, 1).ok().as_deref(),
                true,
            ),
            "fanotes:create-folder" => self.create_entry(
                &arg_string(args, 0)?,
                arg_string(args, 1).ok().as_deref(),
                false,
            ),
            "fanotes:set-folder-color" => {
                self.set_folder_color(&arg_string(args, 0)?, args.get(1).unwrap_or(&Value::Null))
            }
            "fanotes:rename-entry" => {
                self.rename_entry(&arg_string(args, 0)?, &arg_string(args, 1)?)
            }
            "fanotes:move-entry" => self.move_entry(&arg_string(args, 0)?, &arg_string(args, 1)?),
            "fanotes:trash-entry" => self.trash_entry(&arg_string(args, 0)?),
            "fanotes:search" => self.search(&arg_string(args, 0)?),
            "fanotes:list-drawings" => drawings::list_drawings(self),
            "fanotes:save-drawing" => {
                drawings::save_drawing(self, args.first().unwrap_or(&Value::Null))
            }
            "fanotes:read-drawing" => drawings::read_drawing(self, &arg_string(args, 0)?),
            "fanotes:read-famd-ink" => self.read_famd_ink(&arg_string(args, 0)?),
            "fanotes:read-note-page-stats" => notes::read_page_stats(self, &arg_string(args, 0)?),
            "fanotes:read-note-paper-style" => notes::read_paper_style(self, &arg_string(args, 0)?),
            "fanotes:set-note-paper-style" => {
                notes::set_paper_style(self, &arg_string(args, 0)?, &arg_string(args, 1)?)
            }
            "fanotes:read-note-links" => notes::read_links(self, &arg_string(args, 0)?),
            "fanotes:write-note-links" => notes::write_links(
                self,
                &arg_string(args, 0)?,
                args.get(1).unwrap_or(&Value::Null),
            ),
            "fanotes:read-note-backups" => notes::read_backups(self, &arg_string(args, 0)?),
            "fanotes:write-note-backups" => notes::write_backups(
                self,
                &arg_string(args, 0)?,
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
            "fanotes:open-subject-book-popout" => self.open_subject_book(&arg_string(args, 0)?),
            "fanotes:close-subject-book-popout" => Ok(json!({ "open": false })),
            "fanotes:read-worksheet" => worksheets::read_worksheet(self, &arg_string(args, 0)?),
            "fanotes:save-worksheet" => {
                worksheets::save_worksheet(self, args.first().unwrap_or(&Value::Null))
            }
            "fanotes:delete-worksheet" => worksheets::delete_worksheet(self, &arg_string(args, 0)?),
            "fanotes:list-note-history" => notes::list_history(self, &arg_string(args, 0)?),
            "fanotes:read-note-history" => {
                notes::read_history(self, &arg_string(args, 0)?, &arg_string(args, 1)?)
            }
            "fanotes:export-note-pdf" => {
                Err("Das Fenster ist nicht bereit für den PDF-Export.".to_owned())
            }
            "fanotes:read-asset-data-url" => self.read_asset_data_url(&arg_string(args, 0)?),
            "fanotes:read-asset-bytes" => self.read_asset_bytes(&arg_string(args, 0)?),
            "fanotes:load-spelling-resources"
            | "fanotes:load-spelling-word-candidates"
            | "fanotes:load-handwriting-recognition-resources" => Err(
                "Die Ressourcen liegen im Anwendungsbundle und werden vom Renderer geladen."
                    .to_owned(),
            ),
            "fanotes:recognize-native-handwriting-line" => {
                ocr::recognize_line(args.first().unwrap_or(&Value::Null))
            }
            "fanotes:enhanced-math-get-state" => {
                Ok(feature_state("posformer-crohme-q4-k", "CC-BY-NC-SA-3.0"))
            }
            "fanotes:enhanced-math-install" | "fanotes:enhanced-math-recognize" => {
                Err("PosFormer ist nicht installiert.".to_owned())
            }
            "fanotes:qwen-vision-get-state" => Ok(feature_state("qwen-vision", "Apache-2.0")),
            "fanotes:qwen-vision-install" | "fanotes:qwen-vision-recognize" => {
                Err("Qwen Vision ist nicht installiert.".to_owned())
            }
            "fanotes:lm-studio-list-models" => ai::list_lm_studio(
                &arg_string(args, 0)?,
                args.get(1).and_then(Value::as_str).unwrap_or(""),
            ),
            "fanotes:lm-studio-transform" => {
                ai::transform_lm_studio(args.first().unwrap_or(&Value::Null))
            }
            "fanotes:ai-list-models" => ai::list_models(args.first().unwrap_or(&Value::Null)),
            "fanotes:ai-transform" => ai::transform(args.first().unwrap_or(&Value::Null)),
            "fanotes:load-secure-settings" => Ok(self.secret_snapshot()),
            "fanotes:save-settings" => {
                self.save_settings(args.first().cloned().unwrap_or(Value::Null))
            }
            "fanotes:reset-app-data" => self.reset_app_data(),
            "fanotes:update-get-state"
            | "fanotes:update-check"
            | "fanotes:update-download"
            | "fanotes:update-install" => Ok(self.update_state()),
            "fanotes:reveal-in-folder" => {
                let _ = vault::resolve_inside(self.require_vault()?, &arg_string(args, 0)?)?;
                Ok(Value::Null)
            }
            "fanotes:open-external" => self.open_external(&arg_string(args, 0)?),
            "fanotes:addons-fetch" => addons::fetch_text(&arg_string(args, 0)?),
            "fanotes:addons-list" => addons::list(self),
            "fanotes:addons-save" => addons::save(self, args.first().unwrap_or(&Value::Null)),
            "fanotes:addons-remove" => addons::remove(self, &arg_string(args, 0)?),
            "fanotes:addons-read-file" => {
                addons::read_file(self, &arg_string(args, 0)?, &arg_string(args, 1)?)
            }
            "fanotes:addons-write-files" => addons::write_files(
                self,
                &arg_string(args, 0)?,
                args.get(1).unwrap_or(&Value::Null),
            ),
            "fanotes:addons-read-data" => addons::read_data(self, &arg_string(args, 0)?),
            "fanotes:addons-write-data" => addons::write_data(
                self,
                &arg_string(args, 0)?,
                args.get(1).unwrap_or(&Value::Null),
            ),
            "fanotes:addons-net-fetch" => {
                addons::net_fetch(&arg_string(args, 0)?, args.get(1).unwrap_or(&Value::Null))
            }
            "fanotes:sync-vault-id" => Ok(json!(self.vault_id())),
            "fanotes:sync-scan" => self.tree(),
            "fanotes:sync-read" => self.sync_read(&arg_string(args, 0)?),
            "fanotes:sync-write" => self.sync_write(args),
            "fanotes:sync-remove" => self.sync_remove(&arg_string(args, 0)?),
            "fanotes:sync-read-state" => self.read_internal(".fanotes/sync-state.json"),
            "fanotes:sync-write-state" => {
                self.write_internal(".fanotes/sync-state.json", &arg_string(args, 1)?)
            }
            "fanotes:sync-read-secrets" => Ok(self.secret_snapshot()),
            "fanotes:sync-write-secrets" => {
                self.write_secrets(args.first().cloned().unwrap_or(Value::Null))
            }
            "fanotes:capture-window" => Err("Das Fensterbild ist ungültig.".to_owned()),
            "fanotes:render-pdf-page" => self.render_pdf_page(args),
            _ => Err(format!("Unbekannter Kanal: {channel}")),
        }
    }

    fn render_pdf_page(&self, args: &[Value]) -> Result<Value, String> {
        let (path, job) = fanotes_pdf::parse_vault_request(args.first().unwrap_or(&Value::Null))
            .map_err(|error| error.to_string())?;
        let file = vault::resolve_inside(self.require_vault()?, &path)?;
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
        let mime = asset_mime(relative)?;
        let bytes = self.read_asset(relative, asset_limit(mime))?;
        Ok(Value::String(
            base64::engine::general_purpose::STANDARD.encode(bytes),
        ))
    }

    fn read_asset_data_url(&self, relative: &str) -> Result<Value, String> {
        let mime = asset_mime(relative)?;
        let bytes = self.read_asset(relative, asset_limit(mime))?;
        Ok(Value::String(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )))
    }

    fn read_asset(&self, relative: &str, max: u64) -> Result<Vec<u8>, String> {
        let file = vault::resolve_inside(self.require_vault()?, relative)?;
        let bytes = read_regular_limited(&file, max)?;
        if bytes.is_empty() {
            return Err("Die Datei ist leer oder fehlt im Vault.".to_owned());
        }
        Ok(bytes)
    }

    fn sync_read(&self, relative: &str) -> Result<Value, String> {
        let file = vault::resolve_inside(self.require_vault()?, relative)?;
        let bytes = read_regular_limited(&file, SYNC_MAX_BYTES)?;
        Ok(Value::String(
            base64::engine::general_purpose::STANDARD.encode(bytes),
        ))
    }

    fn sync_write(&mut self, args: &[Value]) -> Result<Value, String> {
        let relative = arg_string(args, 0)?;
        let encoded = arg_string(args, 1)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded.as_bytes())
            .map_err(|_| "Der Sync-Inhalt muss binär sein.".to_owned())?;
        if bytes.len() as u64 > SYNC_MAX_BYTES {
            return Err("Die Datei ist zu groß für den Sync.".to_owned());
        }
        let path = vault::resolve_inside(self.require_vault()?, &relative)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|_| "Der Ordner konnte nicht angelegt werden.".to_owned())?;
        }
        fs::write(&path, &bytes)
            .map_err(|_| "Die Datei konnte nicht geschrieben werden.".to_owned())?;
        if let Some(mtime_ms) = args.get(2).and_then(Value::as_i64) {
            let seconds = mtime_ms.div_euclid(1000);
            let nanos = (mtime_ms.rem_euclid(1000) as u32).saturating_mul(1_000_000);
            let _ = set_file_mtime(&path, FileTime::from_unix_time(seconds, nanos));
        }
        let meta = fs::symlink_metadata(&path)
            .map_err(|_| "Die Datei konnte nicht gelesen werden.".to_owned())?;
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_millis() as i64)
            .unwrap_or(0);
        Ok(json!({
            "path": relative,
            "size": bytes.len(),
            "mtimeMs": mtime_ms,
        }))
    }

    fn sync_remove(&mut self, relative: &str) -> Result<Value, String> {
        let path = vault::resolve_inside(self.require_vault()?, relative)?;
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
            Err(_) => Err("Die Datei konnte nicht gelesen werden.".to_owned()),
            Ok(meta) if meta.file_type().is_symlink() => {
                Err("Symbolische Links sind innerhalb des Vaults nicht erlaubt.".to_owned())
            }
            Ok(meta) if !meta.is_file() => {
                Err("Nur Dateien können über den Sync entfernt werden.".to_owned())
            }
            Ok(_) => {
                fs::remove_file(&path)
                    .map_err(|_| "Der Eintrag konnte nicht entfernt werden.".to_owned())?;
                Ok(Value::Null)
            }
        }
    }

    fn dispatch_message(&mut self, channel: &str) -> Result<Value, String> {
        if channel == "fanotes:request-close" || channel == "fanotes:confirm-close" {
            self.close_requested = true;
        }
        if channel == "fanotes:cancel-close" {
            self.close_requested = false;
        }
        Ok(Value::Null)
    }

    fn bootstrap(&self) -> Result<Value, String> {
        let vault = self.require_vault()?;
        Ok(json!({
            "vaultPath": vault,
            "vaultName": vault.file_name().and_then(|name| name.to_str()).unwrap_or("Vault"),
            "settings": self.settings,
            "onboardingRequired": self.onboarding_required,
            "starterSubjects": [],
            "linuxRuntime": {
                "platform": std::env::consts::OS,
                "ozone": "",
                "sessionType": std::env::var("XDG_SESSION_TYPE").unwrap_or_default(),
                "desktop": std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(),
                "hyprland": std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some(),
                "hyprlandInstance": std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some(),
                "display": std::env::var("DISPLAY").unwrap_or_default(),
                "waylandDisplay": std::env::var("WAYLAND_DISPLAY").unwrap_or_default(),
                "hyprlandZeroScaling": false,
                "deviceScaleFactor": null,
                "deviceScaleSource": null,
                "monitorScale": null
            }
        }))
    }

    fn tree(&self) -> Result<Value, String> {
        let root = self.require_vault()?;
        let colors = read_folder_colors(root)?;
        read_tree(root, root, &colors, 0)
    }

    fn read_file(&self, relative: &str) -> Result<Value, String> {
        let path = vault::resolve_inside(self.require_vault()?, relative)?;
        let bytes =
            fs::read(&path).map_err(|_| "Die Datei konnte nicht gelesen werden.".to_owned())?;
        let text = String::from_utf8(bytes).map_err(|_| "Die Datei ist kein Text.".to_owned())?;
        Ok(Value::String(text))
    }

    fn write_file(&mut self, relative: &str, content: &str) -> Result<Value, String> {
        let root = self.require_vault()?.to_path_buf();
        let normalized = vault::normalize_relative_path(relative, false, false)?;
        let path = vault::resolve_inside(&root, &normalized)?;
        if notes::records_history(&normalized) {
            if let Ok(previous) = fs::read(&path) {
                if let Ok(text) = String::from_utf8(previous) {
                    let _ = notes::record_history(&root, &normalized, &text);
                }
            }
        }
        if notes::is_note_text(&normalized) {
            let paper = self
                .settings
                .get("paperStyle")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let modified = notes::write_note_file(&root, &normalized, content, paper.as_deref())?;
            return Ok(json!({ "modifiedAt": modified }));
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|_| "Der Ordner konnte nicht angelegt werden.".to_owned())?;
        }
        fs::write(&path, content)
            .map_err(|_| "Die Datei konnte nicht geschrieben werden.".to_owned())?;
        Ok(Value::Null)
    }

    fn read_internal(&self, relative: &str) -> Result<Value, String> {
        let root = self.require_vault()?;
        let normalized = vault::normalize_relative_path(relative, false, true)?;
        let path = root.join(&normalized);
        match fs::read_to_string(&path) {
            Ok(text) => Ok(Value::String(text)),
            Err(_) => Ok(Value::Null),
        }
    }

    fn write_internal(&mut self, relative: &str, content: &str) -> Result<Value, String> {
        let root = self.require_vault()?;
        let normalized = vault::normalize_relative_path(relative, false, true)?;
        let path = root.join(&normalized);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|_| "Der Ordner konnte nicht angelegt werden.".to_owned())?;
        }
        fs::write(path, content)
            .map_err(|_| "Die Datei konnte nicht geschrieben werden.".to_owned())?;
        Ok(Value::Null)
    }

    fn create_entry(
        &mut self,
        parent: &str,
        preferred: Option<&str>,
        note: bool,
    ) -> Result<Value, String> {
        let root = self.require_vault()?.to_path_buf();
        let parent_relative = if parent.is_empty() {
            String::new()
        } else {
            vault::normalize_relative_path(parent, true, false)?
        };
        let name = preferred.unwrap_or(if note { "Unbenannt" } else { "Ordner" });
        if name.contains('/') || name.contains('\\') || name.contains('\0') {
            return Err("Ungültiger Name.".to_owned());
        }
        let stem = if note {
            name.trim_end_matches(".md")
        } else {
            name
        };
        let relative = if parent_relative.is_empty() {
            if note {
                format!("{stem}.md")
            } else {
                stem.to_owned()
            }
        } else if note {
            format!("{parent_relative}/{stem}.md")
        } else {
            format!("{parent_relative}/{stem}")
        };
        let path = vault::resolve_inside(&root, &relative)?;
        if note {
            if let Some(folder) = path.parent() {
                fs::create_dir_all(folder)
                    .map_err(|_| "Der Ordner konnte nicht angelegt werden.".to_owned())?;
            }
            fs::write(&path, "")
                .map_err(|_| "Die Notiz konnte nicht angelegt werden.".to_owned())?;
        } else {
            fs::create_dir_all(&path)
                .map_err(|_| "Der Ordner konnte nicht angelegt werden.".to_owned())?;
        }
        Ok(
            json!({ "relativePath": relative, "name": path.file_name().and_then(|n| n.to_str()).unwrap_or(stem) }),
        )
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
                .set_title("FaNotes-Vault auswählen")
                .pick_folder()
            else {
                return Ok(Value::Null);
            };
            path
        };
        self.set_vault(path.clone())?;
        fs::write(
            self.app_data.join("vault-path"),
            path.to_string_lossy().as_bytes(),
        )
        .map_err(|_| "Die Einstellungen konnten nicht gespeichert werden.".to_owned())?;
        self.bootstrap()
    }

    fn set_folder_color(&mut self, relative: &str, color: &Value) -> Result<Value, String> {
        let root = self.require_vault()?.to_path_buf();
        let normalized = vault::normalize_relative_path(relative, false, false)?;
        let path = vault::resolve_inside(&root, &normalized)?;
        let meta = fs::symlink_metadata(&path)
            .map_err(|_| "Der Ordner wurde nicht gefunden.".to_owned())?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err("Der Ordner wurde nicht gefunden.".to_owned());
        }
        let stored = match color {
            Value::Null => None,
            Value::String(value) if folder_color_hex(value) => Some(value.to_ascii_lowercase()),
            _ => return Err("Ungültige Ordnerfarbe.".to_owned()),
        };
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
        if relative.is_empty() {
            return Err("Ungültiger Buchpfad.".to_owned());
        }
        let root = self.require_vault()?;
        let path = vault::normalize_relative_path(relative, false, false)?;
        if !path.to_ascii_lowercase().ends_with(".pdf") {
            return Err("Nur ein PDF-Buch kann auspoppen.".to_owned());
        }
        let file = vault::resolve_inside(root, &path)?;
        let meta = fs::symlink_metadata(&file).map_err(|_| "Ungültiger Buchpfad.".to_owned())?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err("Nur ein PDF-Buch kann auspoppen.".to_owned());
        }
        Ok(json!({ "open": true, "bookPath": path }))
    }

    fn rename_entry(&mut self, relative: &str, next_name: &str) -> Result<Value, String> {
        let root = self.require_vault()?.to_path_buf();
        let source = vault::resolve_inside(&root, relative)?;
        let normalized = vault::normalize_relative_path(relative, false, false)?;
        let was_dir = fs::symlink_metadata(&source).is_ok_and(|meta| meta.is_dir());
        if next_name.contains('/') || next_name.contains('\\') || next_name.is_empty() {
            return Err("Ungültiger Name.".to_owned());
        }
        let destination = source.parent().unwrap_or(&root).join(next_name);
        if !vault::is_inside_root(&root, &destination) {
            return Err("Der Pfad liegt außerhalb des Vaults.".to_owned());
        }
        fs::rename(&source, &destination)
            .map_err(|_| "Der Eintrag konnte nicht umbenannt werden.".to_owned())?;
        if was_dir {
            let next = destination
                .strip_prefix(&root)
                .unwrap_or(&destination)
                .to_string_lossy()
                .replace('\\', "/");
            let _ = retarget_folder_colors(&root, &normalized, &next);
        }
        Ok(Value::Null)
    }

    fn move_entry(&mut self, relative: &str, dest_folder: &str) -> Result<Value, String> {
        let root = self.require_vault()?.to_path_buf();
        let source = vault::resolve_inside(&root, relative)?;
        let normalized = vault::normalize_relative_path(relative, false, false)?;
        let was_dir = fs::symlink_metadata(&source).is_ok_and(|meta| meta.is_dir());
        let folder = if dest_folder.is_empty() {
            root.clone()
        } else {
            vault::resolve_inside(&root, dest_folder)?
        };
        let name = source
            .file_name()
            .ok_or_else(|| "Ungültiger Name.".to_owned())?;
        let destination = folder.join(name);
        fs::rename(&source, &destination)
            .map_err(|_| "Der Eintrag konnte nicht verschoben werden.".to_owned())?;
        if was_dir {
            let next = destination
                .strip_prefix(&root)
                .unwrap_or(&destination)
                .to_string_lossy()
                .replace('\\', "/");
            let _ = retarget_folder_colors(&root, &normalized, &next);
        }
        Ok(Value::Null)
    }

    fn trash_entry(&mut self, relative: &str) -> Result<Value, String> {
        let path = vault::resolve_inside(self.require_vault()?, relative)?;
        if path.is_dir() {
            fs::remove_dir_all(&path)
                .map_err(|_| "Der Eintrag konnte nicht entfernt werden.".to_owned())?;
        } else {
            fs::remove_file(&path)
                .map_err(|_| "Der Eintrag konnte nicht entfernt werden.".to_owned())?;
        }
        Ok(Value::Null)
    }

    fn search(&self, query: &str) -> Result<Value, String> {
        let root = self.require_vault()?;
        let needle = query.to_lowercase();
        let mut hits = Vec::new();
        walk_files(root, root, &mut |relative, text| {
            if text.to_lowercase().contains(&needle) {
                hits.push(json!({ "relativePath": relative }));
            }
        })?;
        Ok(Value::Array(hits))
    }

    fn read_famd_ink(&self, relative: &str) -> Result<Value, String> {
        let note = vault::normalize_relative_path(relative, false, false)?;
        let famd = if let Some(stem) = note.strip_suffix(".md") {
            format!("{stem}.famd")
        } else {
            format!("{note}.famd")
        };
        let path = vault::resolve_inside(self.require_vault()?, &famd).or_else(|_| {
            let root = self.require_vault()?;
            let normalized = vault::normalize_relative_path(&famd, false, true)?;
            Ok::<_, String>(root.join(normalized))
        })?;
        let Ok(source) = fs::read_to_string(&path) else {
            return Ok(Value::Null);
        };
        let parsed = fanotes_famd::parse_famd(&source);
        let Some(payload) = parsed.payload else {
            return Ok(Value::Null);
        };
        let Some(ink) = payload.ink else {
            return Ok(Value::Null);
        };
        Ok(json!({
            "updatedAt": payload.updated_at,
            "drawingJson": ink.to_string(),
            "dataRelativePath": famd,
        }))
    }

    fn save_settings(&mut self, incoming: Value) -> Result<Value, String> {
        let Some(object) = incoming.as_object() else {
            return Err("Die Einstellungen sind ungültig.".to_owned());
        };
        let mut secrets = self.load_secrets();
        for key in SECRET_KEYS {
            if let Some(value) = object.get(*key).and_then(Value::as_str) {
                secrets.insert((*key).to_owned(), Value::String(value.to_owned()));
            }
        }
        self.store_secrets(&secrets)?;
        for (key, value) in object {
            if SECRET_KEYS.contains(&key.as_str()) {
                self.settings
                    .insert(key.clone(), Value::String(String::new()));
            } else {
                self.settings.insert(key.clone(), value.clone());
            }
        }
        self.persist_settings()?;
        Ok(json!(self.settings))
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

    fn write_secrets(&mut self, incoming: Value) -> Result<Value, String> {
        let mut secrets = self.load_secrets();
        if let Some(object) = incoming.as_object() {
            for key in SECRET_KEYS {
                if let Some(value) = object.get(*key).and_then(Value::as_str) {
                    secrets.insert((*key).to_owned(), Value::String(value.to_owned()));
                }
            }
        }
        self.store_secrets(&secrets)?;
        Ok(self.secret_snapshot())
    }

    fn reset_app_data(&mut self) -> Result<Value, String> {
        let _ = fs::remove_file(self.app_data.join("settings.json"));
        let _ = fs::remove_file(self.app_data.join("secrets.json"));
        self.settings = default_settings();
        Ok(Value::Null)
    }

    fn open_external(&self, url: &str) -> Result<Value, String> {
        addon_request_allowed(url).or_else(|_| {
            if url.starts_with("https://")
                || url.starts_with("http://127.0.0.1")
                || url.starts_with("http://localhost")
            {
                Ok(())
            } else {
                Err("Nur https-Adressen können geöffnet werden.".to_owned())
            }
        })?;
        Ok(Value::Null)
    }

    fn update_state(&self) -> Value {
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
            "installationKind": "managed-appimage",
            "autoCheckUpdates": true,
            "autoDownloadUpdates": false,
            "installUpdatesOnQuit": false,
            "updateChannel": "stable",
            "releaseHost": "electron"
        })
    }

    fn vault_id(&self) -> String {
        self.vault
            .as_ref()
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_owned()
    }

    fn persist_settings(&self) -> Result<(), String> {
        let path = self.app_data.join("settings.json");
        let text = serde_json::to_string_pretty(&self.settings)
            .map_err(|_| "Die Einstellungen sind ungültig.".to_owned())?;
        fs::write(path, text)
            .map_err(|_| "Die Einstellungen konnten nicht gespeichert werden.".to_owned())
    }

    fn load_persisted(&mut self) {
        if let Ok(text) = fs::read_to_string(self.app_data.join("settings.json")) {
            if let Ok(Value::Object(object)) = serde_json::from_str(&text) {
                for (key, value) in object {
                    if !SECRET_KEYS.contains(&key.as_str()) {
                        self.settings.insert(key, value);
                    }
                }
            }
        }
        if let Ok(text) = fs::read_to_string(self.app_data.join("vault-path")) {
            let path = PathBuf::from(text.trim());
            if path.is_dir() {
                self.vault = Some(path);
            }
        }
    }

    fn load_secrets(&self) -> Map<String, Value> {
        fs::read_to_string(self.app_data.join("secrets.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default()
    }

    fn store_secrets(&self, secrets: &Map<String, Value>) -> Result<(), String> {
        let text = serde_json::to_string(secrets)
            .map_err(|_| "Die Geheimnisse sind ungültig.".to_owned())?;
        fs::write(self.app_data.join("secrets.json"), text)
            .map_err(|_| "Die Geheimnisse konnten nicht gespeichert werden.".to_owned())
    }
}

const PDF_ASSET_MAX: u64 = 96 * 1024 * 1024;
const HTML_ASSET_MAX: u64 = 128 * 1024 * 1024;
const IMAGE_ASSET_MAX: u64 = 32 * 1024 * 1024;
const SYNC_MAX_BYTES: u64 = 100 * 1024 * 1024;
const MAX_PDF_BITMAP_BYTES: usize = 48 * 1024 * 1024;

fn asset_mime(relative: &str) -> Result<&'static str, String> {
    let extension = relative
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(relative)
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "webp" => Ok("image/webp"),
        "gif" => Ok("image/gif"),
        "pdf" => Ok("application/pdf"),
        "html" | "htm" => Ok("text/html"),
        _ => Err("Dieser Dateityp ist für die Vorschau nicht erlaubt.".to_owned()),
    }
}

fn asset_limit(mime: &str) -> u64 {
    match mime {
        "application/pdf" => PDF_ASSET_MAX,
        "text/html" => HTML_ASSET_MAX,
        _ => IMAGE_ASSET_MAX,
    }
}

fn read_regular_limited(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|_| "Die Datei konnte nicht gelesen werden.".to_owned())?;
    if meta.file_type().is_symlink() {
        return Err("Symbolische Links sind innerhalb des Vaults nicht erlaubt.".to_owned());
    }
    if !meta.is_file() {
        return Err("Die gewählte Datei ist keine reguläre Datei.".to_owned());
    }
    if meta.len() > max {
        return Err("Die Datei ist zu groß.".to_owned());
    }
    fs::read(path).map_err(|_| "Die Datei konnte nicht gelesen werden.".to_owned())
}

fn arg_string(args: &[Value], index: usize) -> Result<String, String> {
    args.get(index)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "Ungültiges Argument.".to_owned())
}

fn default_settings() -> Map<String, Value> {
    json!({
        "uiLanguage": "system",
        "theme": "light",
        "paperStyle": "dots",
        "recognitionLanguage": "de",
        "recognitionMode": "auto",
        "updateChannel": "stable",
        "autoCheckUpdates": true
    })
    .as_object()
    .cloned()
    .unwrap_or_default()
}

fn feature_state(model_id: &str, license: &str) -> Value {
    json!({
        "supported": false,
        "installed": false,
        "downloading": false,
        "modelId": model_id,
        "size": 0,
        "license": license,
        "homepage": ""
    })
}

fn read_tree(
    root: &Path,
    directory: &Path,
    colors: &BTreeMap<String, String>,
    depth: usize,
) -> Result<Value, String> {
    if depth > 80 {
        return Ok(json!([]));
    }
    let mut children = Vec::new();
    let entries =
        fs::read_dir(directory).map_err(|_| "Der Vault konnte nicht gelesen werden.".to_owned())?;
    for entry in entries {
        let entry = entry.map_err(|_| "Der Vault konnte nicht gelesen werden.".to_owned())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let meta = fs::symlink_metadata(&path)
            .map_err(|_| "Der Vault konnte nicht gelesen werden.".to_owned())?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            let mut folder = json!({
                "name": name,
                "relativePath": relative,
                "kind": "folder",
                "children": read_tree(root, &path, colors, depth + 1)?
            });
            if let Some(color) = colors.get(&relative) {
                folder["color"] = Value::String(color.clone());
            }
            children.push(folder);
        } else if meta.is_file() {
            let extension = name
                .rsplit_once('.')
                .map(|(_, extension)| extension.to_ascii_lowercase())
                .unwrap_or_default();
            if !tree_extension(&extension) {
                continue;
            }
            children.push(json!({
                "name": name,
                "relativePath": relative,
                "kind": "file",
                "extension": extension,
                "size": meta.len()
            }));
        }
    }
    children = omit_famd_companions(children);
    children.sort_by(|left, right| {
        let left_folder = left["kind"].as_str() == Some("folder");
        let right_folder = right["kind"].as_str() == Some("folder");
        right_folder.cmp(&left_folder).then_with(|| {
            left["name"]
                .as_str()
                .unwrap_or("")
                .to_lowercase()
                .cmp(&right["name"].as_str().unwrap_or("").to_lowercase())
        })
    });
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
                stems.insert(stem.to_lowercase());
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
            !stems.contains(&stem.to_lowercase())
        })
        .collect()
}

fn folder_color_hex(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit())
}

fn read_folder_colors(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let path = root.join(".fanotes").join("folder-colors.json");
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(_) => return Err("Die Ordnerfarben sind ungültig oder zu groß.".to_owned()),
    };
    if text.len() > 512 * 1024 {
        return Err("Die Ordnerfarben sind ungültig oder zu groß.".to_owned());
    }
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return Ok(BTreeMap::new());
    };
    let source = parsed.get("colors").unwrap_or(&parsed);
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
    let internal = root.join(".fanotes");
    fs::create_dir_all(&internal)
        .map_err(|_| "Der Ordner konnte nicht angelegt werden.".to_owned())?;
    let mut entries: Vec<_> = colors.iter().take(5000).collect();
    entries.sort_by(|left, right| left.0.cmp(right.0));
    let mut object = Map::new();
    for (path, color) in entries {
        object.insert(path.clone(), Value::String(color.clone()));
    }
    let snapshot = format!(
        "{}\n",
        serde_json::to_string_pretty(&json!({ "version": 1, "colors": object }))
            .unwrap_or_default()
    );
    if snapshot.len() > 512 * 1024 {
        return Err("Zu viele Ordnerfarben für diesen Vault.".to_owned());
    }
    fs::write(internal.join("folder-colors.json"), snapshot)
        .map_err(|_| "Die Ordnerfarbe konnte nicht gespeichert werden.".to_owned())
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

fn walk_files(
    root: &Path,
    directory: &Path,
    visit: &mut dyn FnMut(String, String),
) -> Result<(), String> {
    for entry in
        fs::read_dir(directory).map_err(|_| "Der Vault konnte nicht gelesen werden.".to_owned())?
    {
        let entry = entry.map_err(|_| "Der Vault konnte nicht gelesen werden.".to_owned())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            walk_files(root, &path, visit)?;
        } else if name.ends_with(".md") {
            if let Ok(text) = fs::read_to_string(&path) {
                let relative = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                visit(relative, text);
            }
        }
    }
    Ok(())
}
