// A release build on Windows is a GUI program without a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fanotes_tauri::run();
}
