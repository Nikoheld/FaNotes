//! Thin Tauri commands. Each preload channel is its own command name.
//! The window loads the existing React bundle and installs `window.fanotes`
//! from `fanotes-api.js` before that bundle runs.

use std::sync::Mutex;

use fanotes_host::{find_channel, Host, CHANNELS};
use serde_json::Value;
use tauri::{Manager, State};

struct HostState(Mutex<Host>);

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
            tauri::generate_handler![$($name),*]
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
    open_subject_book_popout => "fanotes:open-subject-book-popout",
    close_subject_book_popout => "fanotes:close-subject-book-popout",
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
    export_note_pdf => "fanotes:export-note-pdf",
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
    reset_app_data => "fanotes:reset-app-data",
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
    confirm_close => "fanotes:confirm-close",
    cancel_close => "fanotes:cancel-close",
    request_close => "fanotes:request-close",
    sheet_zoom => "fanotes:sheet-zoom",
    capture_window => "fanotes:capture-window",
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = (find_channel, CHANNELS);
    tauri::Builder::default()
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("fanotes"));
            app.manage(HostState(Mutex::new(Host::open(app_data))));
            Ok(())
        })
        .invoke_handler(register())
        .append_invoke_initialization_script(include_str!("fanotes-api.js"))
        .run(tauri::generate_context!())
        .expect("FaNotes Tauri host failed");
}
