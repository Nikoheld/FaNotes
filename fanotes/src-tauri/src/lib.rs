//! Thin Tauri commands. Each preload channel is its own command name.
//! The window loads the existing React bundle and installs `window.fanotes`
//! from `fanotes-api.js` before that bundle runs.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use fanotes_host::{find_channel, Host, CHANNELS};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};
use webkit2gtk::{URIRequestExt, WebViewExt};

struct HostState(Mutex<Host>);

const CLOSE_WARNING_DELAY: Duration = Duration::from_secs(12);
const QUIT_WITHOUT_SAVING: &str = "Ohne Speichern beenden";
static CLOSE_WARNING_GENERATION: AtomicU64 = AtomicU64::new(0);
static CLOSE_WARNING_ARMED: AtomicBool = AtomicBool::new(false);

fn invalidate_close_warning() {
    CLOSE_WARNING_GENERATION.fetch_add(1, Ordering::Relaxed);
    CLOSE_WARNING_ARMED.store(false, Ordering::Relaxed);
}

fn close_warning_discards_changes(choice: &rfd::MessageDialogResult) -> bool {
    matches!(choice, rfd::MessageDialogResult::Custom(text) if text == QUIT_WITHOUT_SAVING)
}

fn arm_close_warning(handle: tauri::AppHandle) {
    if CLOSE_WARNING_ARMED.swap(true, Ordering::AcqRel) {
        return;
    }
    let generation = CLOSE_WARNING_GENERATION.load(Ordering::Relaxed);
    std::thread::spawn(move || {
        std::thread::sleep(CLOSE_WARNING_DELAY);
        if CLOSE_WARNING_GENERATION.load(Ordering::Relaxed) != generation {
            return;
        }
        let allow = handle
            .state::<HostState>()
            .0
            .lock()
            .map(|host| host.allow_close)
            .unwrap_or(true);
        if allow {
            CLOSE_WARNING_ARMED.store(false, Ordering::Relaxed);
            return;
        }
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if CLOSE_WARNING_GENERATION.load(Ordering::Relaxed) != generation {
                return;
            }
            let allow = app
                .state::<HostState>()
                .0
                .lock()
                .map(|host| host.allow_close)
                .unwrap_or(true);
            if allow {
                CLOSE_WARNING_ARMED.store(false, Ordering::Relaxed);
                return;
            }
            let choice = rfd::MessageDialog::new()
                .set_title("Speichern dauert länger als erwartet")
                .set_description(
                    "FaNotes wartet noch darauf, deine Änderungen sicher zu speichern.\n\nDu kannst weiter warten. Beende nur ohne Speichern, wenn du mögliche ungespeicherte Änderungen bewusst verwerfen möchtest.",
                )
                .set_level(rfd::MessageLevel::Warning)
                .set_buttons(rfd::MessageButtons::OkCancelCustom(
                    "Weiter warten".to_owned(),
                    QUIT_WITHOUT_SAVING.to_owned(),
                ))
                .show();
            CLOSE_WARNING_ARMED.store(false, Ordering::Relaxed);
            if CLOSE_WARNING_GENERATION.load(Ordering::Relaxed) != generation {
                return;
            }
            if close_warning_discards_changes(&choice) {
                if let Ok(mut host) = app.state::<HostState>().0.lock() {
                    host.allow_close = true;
                }
                invalidate_close_warning();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("fanotes:before-close", ());
                arm_close_warning(app);
            }
        });
    });
}

mod capture;
mod export;

pub use capture::capture_html;
pub use export::print_html_to_pdf;

#[tauri::command(rename = "fanotes:export-note-pdf")]
fn export_note_pdf(window: tauri::WebviewWindow, args: Vec<Value>) -> Result<Value, String> {
    let destination = if let Some(path) = args.first().and_then(Value::as_str) {
        std::path::PathBuf::from(path)
    } else {
        let Some(path) = rfd::FileDialog::new()
            .set_title("Notiz als PDF speichern")
            .set_file_name("FaNotes-Notiz.pdf")
            .add_filter("PDF", &["pdf"])
            .save_file()
        else {
            return Ok(Value::Null);
        };
        path
    };
    let file_path = destination.display().to_string();
    let _ = window.eval("document.documentElement.classList.add('is-printing')");
    let (started, started_rx) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| {
            let result = export::print_view(&webview.inner(), &destination);
            let _ = started.send(result);
        })
        .map_err(|_| "Das Fenster ist nicht bereit für den PDF-Export.".to_owned())?;
    let printed = started_rx
        .recv_timeout(std::time::Duration::from_secs(25))
        .map_err(|_| "PDF-Export fehlgeschlagen.".to_owned())?;
    let _ = window.eval("document.documentElement.classList.remove('is-printing')");
    printed?;
    Ok(json!({ "filePath": file_path }))
}

#[tauri::command(rename = "fanotes:open-subject-book-popout")]
fn open_subject_book_popout(
    app: tauri::AppHandle,
    state: State<'_, HostState>,
    args: Vec<Value>,
) -> Result<Value, String> {
    let result = {
        let mut host = state
            .0
            .lock()
            .map_err(|_| "Der Host ist belegt.".to_owned())?;
        host.dispatch("fanotes:open-subject-book-popout", &args)?
    };
    let book = result["bookPath"].as_str().unwrap_or("").to_owned();
    let fragment = format!("subject-book={}", encode_uri_component(&book));
    if let Some(existing) = app.get_webview_window("subject-book") {
        let _ = existing.eval(&format!("location.hash = '#{fragment}'"));
        let _ = existing.set_focus();
        return Ok(result);
    }
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "Das Fenster ist nicht bereit.".to_owned())?;
    let mut url = main
        .url()
        .map_err(|_| "Das Fenster ist nicht bereit.".to_owned())?;
    url.set_fragment(Some(&fragment));
    let window =
        tauri::WebviewWindowBuilder::new(&app, "subject-book", tauri::WebviewUrl::External(url))
            .title("Buch")
            .inner_size(980.0, 1080.0)
            .min_inner_size(420.0, 360.0)
            .background_color(paper_color())
            .build()
            .map_err(|_| "Das Buchfenster konnte nicht geöffnet werden.".to_owned())?;
    install_webview_guards(&window, false);
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = app_handle.emit("fanotes:subject-book-popout-closed", ());
        }
    });
    Ok(result)
}

#[tauri::command(rename = "fanotes:close-subject-book-popout")]
fn close_subject_book_popout(app: tauri::AppHandle) -> Result<Value, String> {
    if let Some(window) = app.get_webview_window("subject-book") {
        let _ = window.close();
    }
    Ok(json!({ "open": false }))
}

#[tauri::command(rename = "fanotes:request-close")]
fn request_close(
    window: tauri::WebviewWindow,
    state: State<'_, HostState>,
) -> Result<Value, String> {
    {
        let mut host = state
            .0
            .lock()
            .map_err(|_| "Der Host ist belegt.".to_owned())?;
        host.dispatch("fanotes:request-close", &[])?;
    }
    window
        .close()
        .map_err(|_| "Das Fenster konnte nicht geschlossen werden.".to_owned())?;
    Ok(Value::Null)
}

#[tauri::command(rename = "fanotes:confirm-close")]
fn confirm_close(
    window: tauri::WebviewWindow,
    state: State<'_, HostState>,
) -> Result<Value, String> {
    invalidate_close_warning();
    {
        let mut host = state
            .0
            .lock()
            .map_err(|_| "Der Host ist belegt.".to_owned())?;
        host.dispatch("fanotes:confirm-close", &[])?;
    }
    window
        .close()
        .map_err(|_| "Das Fenster konnte nicht geschlossen werden.".to_owned())?;
    Ok(Value::Null)
}

#[tauri::command(rename = "fanotes:reset-app-data")]
fn reset_app_data(app: tauri::AppHandle, state: State<'_, HostState>) -> Result<Value, String> {
    let result = {
        let mut host = state
            .0
            .lock()
            .map_err(|_| "Der Host ist belegt.".to_owned())?;
        host.dispatch("fanotes:reset-app-data", &[])?
    };
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(100));
        app.restart();
    });
    Ok(result)
}

#[tauri::command(rename = "fanotes:cancel-close")]
fn cancel_close(state: State<'_, HostState>) -> Result<Value, String> {
    invalidate_close_warning();
    let mut host = state
        .0
        .lock()
        .map_err(|_| "Der Host ist belegt.".to_owned())?;
    host.dispatch("fanotes:cancel-close", &[])
}

#[tauri::command(rename = "fanotes:capture-window")]
fn capture_window(window: tauri::WebviewWindow) -> Result<Value, String> {
    let (captured, captured_rx) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| {
            let result = capture::capture_view(&webview.inner());
            let _ = captured.send(result);
        })
        .map_err(|_| "Das Fensterbild ist ungültig.".to_owned())?;
    let image = captured_rx
        .recv_timeout(std::time::Duration::from_secs(20))
        .map_err(|_| "Das Fensterbild ist ungültig.".to_owned())??;
    Ok(Value::String(image))
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

macro_rules! fanotes_commands {
    ($($name:ident => $channel:literal),* $(,)?) => {
        $(
            #[tauri::command(rename = $channel)]
            fn $name(state: State<'_, HostState>, args: Vec<Value>) -> Result<Value, String> {
                let mut host = state.0.lock().map_err(|_| "Der Host ist belegt.".to_owned())?;
                host.dispatch($channel, &args)
            }
        )*

        pub fn register() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
            tauri::generate_handler![
                $($name),*,
                export_note_pdf,
                open_subject_book_popout,
                close_subject_book_popout,
                capture_window,
                request_close,
                confirm_close,
                cancel_close,
                reset_app_data
            ]
        }
    };
}

fanotes_commands! {
    bootstrap => "fanotes:bootstrap",
    renderer_ready => "fanotes:renderer-ready",
    complete_onboarding => "fanotes:complete-onboarding",
    get_cached_tree => "fanotes:get-cached-tree",
    get_fast_tree => "fanotes:get-fast-tree",
    select_vault => "fanotes:select-vault",
    get_tree => "fanotes:get-tree",
    read_file => "fanotes:read-file",
    write_file => "fanotes:write-file",
    read_recognition_model => "fanotes:read-recognition-model",
    write_recognition_model => "fanotes:write-recognition-model",
    create_note => "fanotes:create-note",
    create_folder => "fanotes:create-folder",
    set_folder_color => "fanotes:set-folder-color",
    rename_entry => "fanotes:rename-entry",
    move_entry => "fanotes:move-entry",
    trash_entry => "fanotes:trash-entry",
    search => "fanotes:search",
    save_drawing => "fanotes:save-drawing",
    list_drawings => "fanotes:list-drawings",
    read_drawing => "fanotes:read-drawing",
    read_famd_ink => "fanotes:read-famd-ink",
    read_note_page_stats => "fanotes:read-note-page-stats",
    read_note_paper_style => "fanotes:read-note-paper-style",
    set_note_paper_style => "fanotes:set-note-paper-style",
    read_note_links => "fanotes:read-note-links",
    write_note_links => "fanotes:write-note-links",
    read_note_backups => "fanotes:read-note-backups",
    write_note_backups => "fanotes:write-note-backups",
    read_subject_books => "fanotes:read-subject-books",
    write_subject_books => "fanotes:write-subject-books",
    import_subject_book => "fanotes:import-subject-book",
    subject_book_popout_closed => "fanotes:subject-book-popout-closed",
    import_worksheet => "fanotes:import-worksheet",
    import_worksheet_from_data => "fanotes:import-worksheet-from-data",
    import_pdf_note => "fanotes:import-pdf-note",
    import_onenote => "fanotes:import-onenote",
    read_worksheet => "fanotes:read-worksheet",
    save_worksheet => "fanotes:save-worksheet",
    delete_worksheet => "fanotes:delete-worksheet",
    list_note_history => "fanotes:list-note-history",
    read_note_history => "fanotes:read-note-history",
    read_asset_data_url => "fanotes:read-asset-data-url",
    read_asset_bytes => "fanotes:read-asset-bytes",
    load_spelling_resources => "fanotes:load-spelling-resources",
    load_spelling_word_candidates => "fanotes:load-spelling-word-candidates",
    load_handwriting_recognition_resources => "fanotes:load-handwriting-recognition-resources",
    recognize_native_handwriting_line => "fanotes:recognize-native-handwriting-line",
    enhanced_math_get_state => "fanotes:enhanced-math-get-state",
    enhanced_math_install => "fanotes:enhanced-math-install",
    enhanced_math_recognize => "fanotes:enhanced-math-recognize",
    qwen_vision_get_state => "fanotes:qwen-vision-get-state",
    qwen_vision_install => "fanotes:qwen-vision-install",
    qwen_vision_recognize => "fanotes:qwen-vision-recognize",
    lm_studio_list_models => "fanotes:lm-studio-list-models",
    lm_studio_transform => "fanotes:lm-studio-transform",
    ai_list_models => "fanotes:ai-list-models",
    ai_transform => "fanotes:ai-transform",
    load_secure_settings => "fanotes:load-secure-settings",
    save_settings => "fanotes:save-settings",
    update_get_state => "fanotes:update-get-state",
    update_check => "fanotes:update-check",
    update_download => "fanotes:update-download",
    update_install => "fanotes:update-install",
    update_state => "fanotes:update-state",
    reveal_in_folder => "fanotes:reveal-in-folder",
    open_external => "fanotes:open-external",
    addons_fetch => "fanotes:addons-fetch",
    addons_list => "fanotes:addons-list",
    addons_save => "fanotes:addons-save",
    addons_remove => "fanotes:addons-remove",
    addons_read_file => "fanotes:addons-read-file",
    addons_write_files => "fanotes:addons-write-files",
    addons_read_data => "fanotes:addons-read-data",
    addons_write_data => "fanotes:addons-write-data",
    addons_net_fetch => "fanotes:addons-net-fetch",
    sync_vault_id => "fanotes:sync-vault-id",
    sync_scan => "fanotes:sync-scan",
    sync_read => "fanotes:sync-read",
    sync_write => "fanotes:sync-write",
    sync_remove => "fanotes:sync-remove",
    sync_read_state => "fanotes:sync-read-state",
    sync_write_state => "fanotes:sync-write-state",
    sync_read_secrets => "fanotes:sync-read-secrets",
    sync_write_secrets => "fanotes:sync-write-secrets",
    before_close => "fanotes:before-close",
    sheet_zoom => "fanotes:sheet-zoom",
    render_pdf_page => "fanotes:render-pdf-page",
}

fn navigation_allowed(url: &tauri::Url) -> bool {
    match url.scheme() {
        "about" => url.as_str() == "about:blank" || url.path() == "blank",
        "tauri" | "asset" | "ipc" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("127.0.0.1") | Some("localhost") | Some("::1") | Some("tauri.localhost")
        ),
        _ => false,
    }
}

fn navigation_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("fanotes-navigation")
        .on_navigation(|_webview, url| navigation_allowed(url))
        .build()
}

fn sheet_zoom_direction(level: f64) -> Option<&'static str> {
    if !level.is_finite() || (level - 1.0).abs() < 0.001 {
        None
    } else if level > 1.0 {
        Some("in")
    } else {
        Some("out")
    }
}

fn paper_color() -> tauri::utils::config::Color {
    "#f7f6f3".parse().expect("paper color")
}

/// A second launch focuses the window that is already open.
fn focus_running_window(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn install_webview_guards(window: &tauri::WebviewWindow, emit_sheet_zoom: bool) {
    let emit_window = window.clone();
    let _ = window.with_webview(move |webview| {
        let view = webview.inner();
        view.set_zoom_level(1.0);
        view.connect_zoom_level_notify(move |view| {
            let Some(direction) = sheet_zoom_direction(view.zoom_level()) else {
                return;
            };
            view.set_zoom_level(1.0);
            if emit_sheet_zoom {
                let _ = emit_window.emit("fanotes:sheet-zoom", direction);
            }
        });
        view.connect_create(|_view, action| {
            if let Some(uri) = action.request().and_then(|request| request.uri()) {
                if let Some(href) = fanotes_host::openable_http_url(uri.as_str()) {
                    let _ = std::process::Command::new("xdg-open")
                        .arg(href)
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn();
                }
            }
            None
        });
    });
}

#[cfg(test)]
mod tests {
    use super::sheet_zoom_direction;

    #[test]
    fn quitting_without_saving_is_the_discard_choice() {
        assert!(super::close_warning_discards_changes(
            &rfd::MessageDialogResult::Custom(super::QUIT_WITHOUT_SAVING.to_owned())
        ));
        assert!(!super::close_warning_discards_changes(
            &rfd::MessageDialogResult::Custom("Weiter warten".to_owned())
        ));
        assert!(!super::close_warning_discards_changes(
            &rfd::MessageDialogResult::Cancel
        ));
    }

    #[test]
    fn pinch_becomes_a_sheet_zoom_direction() {
        assert_eq!(sheet_zoom_direction(1.0), None);
        assert_eq!(sheet_zoom_direction(1.25), Some("in"));
        assert_eq!(sheet_zoom_direction(0.8), Some("out"));
        assert_eq!(sheet_zoom_direction(f64::NAN), None);
    }

    #[test]
    fn only_the_app_origin_can_navigate() {
        let allowed = [
            "about:blank",
            "http://127.0.0.1:5174/",
            "http://127.0.0.1:5174/#subject-book=Mathe%2FBuch.pdf",
            "http://localhost:5174/index.html",
            "https://tauri.localhost/",
            "tauri://localhost",
            "asset://localhost/index.html",
        ];
        for url in allowed {
            assert!(
                super::navigation_allowed(&tauri::Url::parse(url).unwrap()),
                "{url}"
            );
        }
        let blocked = [
            "https://example.com/",
            "http://192.168.1.20/",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ];
        for url in blocked {
            let parsed = tauri::Url::parse(url);
            let allowed = parsed.is_ok_and(|url| super::navigation_allowed(&url));
            assert!(!allowed, "{url}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = (find_channel, CHANNELS);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                focus_running_window(&window);
            }
        }))
        .plugin(navigation_plugin())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("fanotes"));
            app.manage(HostState(Mutex::new(Host::open(app_data))));
            if let Some(window) = app.get_webview_window("main") {
                install_webview_guards(&window, true);
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        let allow = handle
                            .state::<HostState>()
                            .0
                            .lock()
                            .map(|host| host.allow_close)
                            .unwrap_or(true);
                        if !allow {
                            api.prevent_close();
                            if let Some(main) = handle.get_webview_window("main") {
                                let _ = main.emit("fanotes:before-close", ());
                            }
                            arm_close_warning(handle.clone());
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(register())
        .append_invoke_initialization_script(include_str!("fanotes-api.js"))
        .run(tauri::generate_context!())
        .expect("FaNotes Tauri host failed");
}
