//! Shrink a WebKit window snapshot into the JPEG data URL used by bug reports.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use base64::Engine;
use gtk::prelude::*;
use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

const MAX_CAPTURE_BYTES: usize = 180 * 1024;
const MAX_CAPTURE_EDGE: i32 = 1280;

pub fn capture_html(html: &str) -> Result<String, String> {
    gtk::init().map_err(|_| "Das Fensterbild ist ungültig.".to_owned())?;
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    let view = webkit2gtk::WebView::new();
    window.add(&view);
    window.set_default_size(640, 480);
    window.show_all();
    let (loaded, loaded_rx) = mpsc::channel();
    view.connect_load_changed(move |_view, event| {
        if event == webkit2gtk::LoadEvent::Finished {
            let _ = loaded.send(());
        }
    });
    view.load_html(html, None);
    wait(&loaded_rx, Duration::from_secs(15))?;
    let (captured, captured_rx) = mpsc::channel();
    view.snapshot(
        SnapshotRegion::Visible,
        SnapshotOptions::NONE,
        None::<&gio::Cancellable>,
        move |result| {
            let encoded = match result {
                Ok(surface) => encode_surface(&surface),
                Err(_) => Err("Das Fensterbild ist ungültig.".to_owned()),
            };
            let _ = captured.send(encoded);
        },
    );
    let image = wait_result(&captured_rx, Duration::from_secs(15))?;
    window.close();
    Ok(image)
}

pub fn capture_view(view: &webkit2gtk::WebView) -> Result<String, String> {
    let (captured, captured_rx) = mpsc::channel();
    view.snapshot(
        SnapshotRegion::Visible,
        SnapshotOptions::NONE,
        None::<&gio::Cancellable>,
        move |result| {
            let encoded = match result {
                Ok(surface) => encode_surface(&surface),
                Err(_) => Err("Das Fensterbild ist ungültig.".to_owned()),
            };
            let _ = captured.send(encoded);
        },
    );
    wait_result(&captured_rx, Duration::from_secs(15))
}

fn encode_surface(surface: &cairo::Surface) -> Result<String, String> {
    let image = cairo::ImageSurface::try_from(surface.clone())
        .map_err(|_| "Das Fensterbild ist ungültig.".to_owned())?;
    let width = image.width();
    let height = image.height();
    if width < 1 || height < 1 {
        return Err("Das Fensterbild ist leer.".to_owned());
    }
    let mut pixbuf = gdk::pixbuf_get_from_surface(&image, 0, 0, width, height)
        .ok_or_else(|| "Das Fensterbild ist ungültig.".to_owned())?;
    let longest = width.max(height);
    if longest > MAX_CAPTURE_EDGE {
        let scale = MAX_CAPTURE_EDGE as f64 / longest as f64;
        pixbuf = pixbuf
            .scale_simple(
                ((width as f64) * scale).round().max(1.0) as i32,
                ((height as f64) * scale).round().max(1.0) as i32,
                gdk_pixbuf::InterpType::Bilinear,
            )
            .ok_or_else(|| "Das Fensterbild ist ungültig.".to_owned())?;
    }
    let mut quality = 55;
    let mut jpeg = save_jpeg(&pixbuf, quality)?;
    while jpeg.len() > MAX_CAPTURE_BYTES && quality > 25 {
        quality -= 10;
        jpeg = save_jpeg(&pixbuf, quality)?;
    }
    let mut guard = 0;
    while jpeg.len() > MAX_CAPTURE_BYTES && guard < 6 {
        let next = (jpeg.len() as f64 / MAX_CAPTURE_BYTES as f64)
            .sqrt()
            .recip()
            * 0.85;
        if !(next > 0.0 && next < 1.0) {
            break;
        }
        pixbuf = pixbuf
            .scale_simple(
                (pixbuf.width() as f64 * next).round().max(1.0) as i32,
                (pixbuf.height() as f64 * next).round().max(1.0) as i32,
                gdk_pixbuf::InterpType::Bilinear,
            )
            .ok_or_else(|| "Das Fensterbild ist ungültig.".to_owned())?;
        jpeg = save_jpeg(&pixbuf, quality.max(25))?;
        guard += 1;
    }
    if jpeg.is_empty() || jpeg.len() > MAX_CAPTURE_BYTES {
        return Err("Das Fensterbild ist zu groß für den Fehlerbericht.".to_owned());
    }
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(jpeg)
    ))
}

fn save_jpeg(pixbuf: &gdk_pixbuf::Pixbuf, quality: i32) -> Result<Vec<u8>, String> {
    pixbuf
        .save_to_bufferv("jpeg", &[("quality", &quality.to_string())])
        .map_err(|_| "Das Fensterbild ist ungültig.".to_owned())
}

fn wait(receiver: &mpsc::Receiver<()>, timeout: Duration) -> Result<(), String> {
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
    Err("Das Fensterbild ist ungültig.".to_owned())
}

fn wait_result(
    receiver: &mpsc::Receiver<Result<String, String>>,
    timeout: Duration,
) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        while gtk::events_pending() {
            gtk::main_iteration();
        }
        if let Ok(result) = receiver.try_recv() {
            return result;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err("Das Fensterbild ist ungültig.".to_owned())
}
