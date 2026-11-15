//! Shrink a WebView2 window capture into the JPEG data URL used by bug reports.
//!
//! The same API as the WebKitGTK `capture.rs`. WebView2 captures a PNG; the
//! size and quality budget lives in `window_capture.rs`.

use std::time::Duration;

use crate::webview2::{self, Standalone, CAPTURE_INVALID};
use crate::window_capture;

pub fn capture_html(html: &str) -> Result<String, String> {
    let view = Standalone::load(html, 640, 480, CAPTURE_INVALID)?;
    let png = view.finish(Duration::from_secs(15), CAPTURE_INVALID, |view, done| {
        webview2::start_capture(&view.core, done)
    })?;
    window_capture::png_to_data_url(&png)
}

/// Call this from an async command, never on the UI thread.
pub fn capture_window(window: &tauri::WebviewWindow) -> Result<String, String> {
    let png = webview2::on_ui_thread(
        window,
        Duration::from_secs(20),
        CAPTURE_INVALID,
        |controller, _, done| {
            let core =
                unsafe { controller.CoreWebView2() }.map_err(|_| CAPTURE_INVALID.to_owned())?;
            webview2::start_capture(&core, done)
        },
    )?;
    window_capture::png_to_data_url(&png)
}
