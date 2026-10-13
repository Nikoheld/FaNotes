//! Print the visible page to a PDF file through WebKit, matching Electron's
//! `printToPDF` with background graphics and an A4 page.

use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use gtk::prelude::*;
use webkit2gtk::{PrintOperationExt, WebViewExt};

pub fn print_html_to_pdf(html: &str, destination: &Path) -> Result<(), String> {
    gtk::init().map_err(|_| "Das Fenster ist nicht bereit für den PDF-Export.".to_owned())?;
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    let view = webkit2gtk::WebView::new();
    window.add(&view);
    window.show_all();
    let (loaded, loaded_rx) = mpsc::channel();
    view.connect_load_changed(move |_view, event| {
        if event == webkit2gtk::LoadEvent::Finished {
            let _ = loaded.send(());
        }
    });
    view.load_html(html, None);
    wait_for(&loaded_rx, Duration::from_secs(15))?;
    print_view(&view, destination)?;
    window.close();
    Ok(())
}

pub fn print_view(view: &webkit2gtk::WebView, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|_| "Die PDF-Datei konnte nicht geschrieben werden.".to_owned())?;
        }
    }
    let settings = gtk::PrintSettings::new();
    settings.set("printer", Some("Print to File"));
    settings.set("output-file-format", Some("pdf"));
    settings.set("output-uri", Some(&file_uri(destination)));
    let page = note_pdf_page_setup();
    let operation = webkit2gtk::PrintOperation::new(view);
    operation.set_print_settings(&settings);
    operation.set_page_setup(&page);
    let (finished, finished_rx) = mpsc::channel();
    let (failed, failed_rx) = mpsc::channel();
    operation.connect_finished(move |_| {
        let _ = finished.send(());
    });
    operation.connect_failed(move |_, error| {
        let _ = failed.send(error.to_string());
    });
    operation.print();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        while gtk::events_pending() {
            gtk::main_iteration();
        }
        if failed_rx.try_recv().is_ok() {
            return Err("PDF-Export fehlgeschlagen.".to_owned());
        }
        if finished_rx.try_recv().is_ok() || pdf_ready(destination) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if pdf_ready(destination) {
        Ok(())
    } else {
        Err("PDF-Export fehlgeschlagen.".to_owned())
    }
}

fn wait_for(receiver: &mpsc::Receiver<()>, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        while gtk::events_pending() {
            gtk::main_iteration();
        }
        if receiver.try_recv().is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err("Das Fenster ist nicht bereit für den PDF-Export.".to_owned())
}

/// A4 page for a note PDF.
///
/// Electron 43 `printToPDF` reads `margins.top`, `bottom`, `left`, and `right`.
/// The desktop call only sets `marginType`, so each omitted edge is 0.4 inch.
fn note_pdf_page_setup() -> gtk::PageSetup {
    let page = gtk::PageSetup::new();
    page.set_paper_size(&gtk::PaperSize::new(Some("iso_a4")));
    let margin = 0.4;
    page.set_top_margin(margin, gtk::Unit::Inch);
    page.set_bottom_margin(margin, gtk::Unit::Inch);
    page.set_left_margin(margin, gtk::Unit::Inch);
    page.set_right_margin(margin, gtk::Unit::Inch);
    page
}

fn pdf_ready(path: &Path) -> bool {
    std::fs::read(path)
        .ok()
        .is_some_and(|bytes| bytes.starts_with(b"%PDF-") && bytes.len() > 8)
}

/// Run `script` and wait until WebKit finishes it.
///
/// `evaluate_javascript` returns before the script runs. Electron awaits
/// `executeJavaScript`, so the print class is on the page before `printToPDF`.
pub(crate) fn finish_script(view: &webkit2gtk::WebView, script: &str) -> Result<(), String> {
    let (done, done_rx) = mpsc::channel();
    view.evaluate_javascript(
        script,
        None::<&str>,
        None::<&str>,
        None::<&gio::Cancellable>,
        move |_| {
            let _ = done.send(());
        },
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        while gtk::events_pending() {
            gtk::main_iteration();
        }
        if done_rx.try_recv().is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Err("Das Fenster ist nicht bereit für den PDF-Export.".to_owned())
}

fn file_uri(path: &Path) -> String {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    // GTK print-to-file reads this URI. A raw `#` or `?` would cut the path off.
    let mut uri = String::from("file://");
    for byte in absolute.to_string_lossy().as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                uri.push(*byte as char);
            }
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }
    uri
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::mpsc;
    use std::time::Duration;

    use gtk::prelude::*;
    use webkit2gtk::WebViewExt;

    #[test]
    fn a_pdf_destination_encodes_the_file_uri() {
        assert_eq!(
            super::file_uri(Path::new("/tmp/Notiz #1.pdf")),
            "file:///tmp/Notiz%20%231.pdf"
        );
        assert_eq!(
            super::file_uri(Path::new("/tmp/Größe.pdf")),
            "file:///tmp/Gr%C3%B6%C3%9Fe.pdf"
        );
    }

    #[test]
    fn the_print_class_is_set_before_printing_can_start() {
        gtk::init().unwrap();
        // GTK allows initialization from one thread. This is that thread, so
        // the page margins are checked here rather than in a second test.
        let page = super::note_pdf_page_setup();
        assert_eq!(page.paper_size().name().as_deref(), Some("iso_a4"));
        for (edge, margin) in [
            ("top", page.top_margin(gtk::Unit::Inch)),
            ("bottom", page.bottom_margin(gtk::Unit::Inch)),
            ("left", page.left_margin(gtk::Unit::Inch)),
            ("right", page.right_margin(gtk::Unit::Inch)),
        ] {
            assert!(
                (margin - 0.4).abs() < 0.001,
                "{edge} margin is {margin} inch"
            );
        }
        let window = gtk::Window::new(gtk::WindowType::Toplevel);
        let view = webkit2gtk::WebView::new();
        window.add(&view);
        window.show_all();
        let (loaded, loaded_rx) = mpsc::channel();
        view.connect_load_changed(move |_view, event| {
            if event == webkit2gtk::LoadEvent::Finished {
                let _ = loaded.send(());
            }
        });
        view.load_html("<html><body>Notiz</body></html>", None);
        super::wait_for(&loaded_rx, Duration::from_secs(15)).unwrap();
        let (finished, finished_rx) = mpsc::channel();
        view.evaluate_javascript(
            "document.documentElement.classList.add('is-printing')",
            None::<&str>,
            None::<&str>,
            None::<&gio::Cancellable>,
            move |_| {
                let _ = finished.send(());
            },
        );
        assert!(
            finished_rx.try_recv().is_err(),
            "adding is-printing finished before printing could start"
        );
        super::finish_script(
            &view,
            "document.title = String(document.documentElement.classList.contains('is-printing'))",
        )
        .unwrap();
        assert_eq!(view.title().as_deref(), Some("true"));
        window.close();
    }
}
