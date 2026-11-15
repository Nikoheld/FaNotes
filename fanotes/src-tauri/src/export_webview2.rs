//! Print the visible page to a PDF file through WebView2, matching Electron's
//! `printToPDF` with background graphics and an A4 page.
//!
//! The same API as the WebKitGTK `export.rs`. WebView2 is Chromium, so this
//! is the closest match to Electron of the two.

use std::path::Path;
use std::time::Duration;

use crate::webview2::{self, Standalone, PDF_FAILED, PDF_NOT_READY};

const ADD_PRINT_CLASS: &str = "document.documentElement.classList.add('is-printing')";
const REMOVE_PRINT_CLASS: &str = "document.documentElement.classList.remove('is-printing')";

pub fn print_html_to_pdf(html: &str, destination: &Path) -> Result<(), String> {
    let view = Standalone::load(html, 640, 480, PDF_NOT_READY)?;
    view.finish(Duration::from_secs(20), PDF_FAILED, |view, done| {
        webview2::start_print(&view.core, &view.environment, destination, done)
    })
}

/// Electron awaits `executeJavaScript` before `printToPDF`, so the print
/// class is on the page before printing starts, and is removed afterwards
/// whether the PDF was written or not.
///
/// Call this from an async command, never on the UI thread.
pub fn print_window(window: &tauri::WebviewWindow, destination: &Path) -> Result<(), String> {
    run_script(window, ADD_PRINT_CLASS)?;
    let destination = destination.to_path_buf();
    let printed = webview2::on_ui_thread(
        window,
        Duration::from_secs(25),
        PDF_FAILED,
        move |controller, environment, done| {
            let core = unsafe { controller.CoreWebView2() }.map_err(|_| PDF_NOT_READY.to_owned())?;
            webview2::start_print(&core, environment, &destination, done)
        },
    );
    let _ = run_script(window, REMOVE_PRINT_CLASS);
    printed
}

fn run_script(window: &tauri::WebviewWindow, script: &'static str) -> Result<(), String> {
    webview2::on_ui_thread(
        window,
        Duration::from_secs(5),
        PDF_NOT_READY,
        move |controller, _, done| {
            let core = unsafe { controller.CoreWebView2() }.map_err(|_| PDF_NOT_READY.to_owned())?;
            webview2::start_script(
                &core,
                script,
                PDF_NOT_READY,
                Box::new(move |result| done(result.map(|_| ()))),
            )
        },
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_note_pdf_is_a4_with_electron_margins() {
        assert!((super::webview2::A4_WIDTH_INCHES - 8.2677).abs() < 0.001);
        assert!((super::webview2::A4_HEIGHT_INCHES - 11.6929).abs() < 0.001);
        assert!((super::webview2::NOTE_PDF_MARGIN_INCHES - 0.4).abs() < f64::EPSILON);
    }

    #[test]
    fn the_print_class_is_set_and_removed_around_printing() {
        let html = "<html><head><title>start</title></head><body>Notiz</body></html>";
        let view = super::Standalone::load(html, 640, 480, super::PDF_NOT_READY).unwrap();
        let run = |script: &'static str| {
            view.finish(
                std::time::Duration::from_secs(5),
                super::PDF_NOT_READY,
                move |view, done| {
                    super::webview2::start_script(&view.core, script, super::PDF_NOT_READY, done)
                },
            )
            .unwrap()
        };
        run(super::ADD_PRINT_CLASS);
        assert_eq!(
            run("document.documentElement.classList.contains('is-printing')"),
            "true"
        );
        let path = std::env::temp_dir().join(format!(
            "fanotes-export-class-{}.pdf",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        view.finish(
            std::time::Duration::from_secs(20),
            super::PDF_FAILED,
            |view, done| super::webview2::start_print(&view.core, &view.environment, &path, done),
        )
        .unwrap();
        run(super::REMOVE_PRINT_CLASS);
        assert_eq!(
            run("document.documentElement.classList.contains('is-printing')"),
            "false"
        );
        assert!(super::webview2::pdf_ready(&path));
        let _ = std::fs::remove_file(&path);
    }
}
