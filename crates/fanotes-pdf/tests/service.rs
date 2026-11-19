//! The worker the Tauri shell talks to: document reuse, caching, cancellation.

mod common;

use std::sync::{mpsc, Arc};
use std::time::Duration;

use fanotes_pdf::service::PdfService;
use fanotes_pdf::{render_pdf_page, Error, PageBitmap, RenderRequest};

fn request(page_index: i32, width: i32, height: i32) -> RenderRequest {
    RenderRequest {
        page_index,
        pixel_width: width,
        pixel_height: height,
        page_pixel_width: width,
        page_pixel_height: height,
        origin_x: 0,
        origin_y: 0,
        rotation: 0,
        password: String::new(),
    }
}

fn write_fixture(name: &str, pages: usize) -> (std::path::PathBuf, Vec<u8>) {
    let streams: Vec<String> = (1..=pages).map(common::worksheet_stream).collect();
    let pdf = common::pdf_with_pages(300, 200, &streams);
    let dir =
        std::env::temp_dir().join(format!("fanotes-pdf-service-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{name}.pdf"));
    std::fs::write(&path, &pdf).unwrap();
    (path, pdf)
}

#[test]
fn an_open_document_is_reused_and_paints_like_the_one_shot_path() {
    let (path, pdf) = write_fixture("reuse", 3);
    let service = PdfService::start();
    let first = service.open_blocking(path.clone(), "").unwrap();
    assert_eq!(first.page_count, 3);
    assert!(!first.reused);
    let again = service.open_blocking(path.clone(), "").unwrap();
    assert_eq!(again.doc, first.doc);
    assert!(again.reused, "the same file is not read or parsed twice");

    let sizes = service.page_sizes_blocking(first.doc).unwrap();
    assert_eq!(sizes.len(), 3);
    assert!((sizes[2].0 - 300.0).abs() < 0.01 && (sizes[2].1 - 200.0).abs() < 0.01);

    let job = request(2, 450, 300);
    let native = service
        .render_blocking(first.doc, job.clone(), None)
        .unwrap();
    let direct = render_pdf_page(&pdf, &job).unwrap();
    assert_eq!(
        native.rgba, direct.rgba,
        "same pixels as fanotes:render-pdf-page"
    );

    let cached = service.render_blocking(first.doc, job, None).unwrap();
    assert!(
        Arc::ptr_eq(&native, &cached),
        "scrolling back is a cache hit"
    );
    let stats = service.stats();
    assert_eq!((stats.opened, stats.rendered, stats.cache_hits), (1, 1, 1));

    std::fs::write(
        &path,
        common::pdf_with_pages(300, 200, &[common::worksheet_stream(9)]),
    )
    .unwrap();
    let changed = service.open_blocking(path, "").unwrap();
    assert_ne!(changed.doc, first.doc, "a changed file is opened again");
    assert_eq!(changed.page_count, 1);
}

#[test]
fn a_newer_render_for_the_same_slot_supersedes_queued_ones() {
    let (path, _) = write_fixture("slots", 12);
    let service = PdfService::start();
    let doc = service.open_blocking(path, "").unwrap().doc;
    let (sender, receiver) = mpsc::channel::<(i32, Result<Arc<PageBitmap>, Error>)>();
    // Occupy the worker so the next ones queue up behind it.
    let busy = sender.clone();
    service.render(
        doc,
        request(0, 3000, 2000),
        None,
        Box::new(move |result| {
            let _ = busy.send((-1, result));
        }),
    );
    for page in 0..12 {
        let reply = sender.clone();
        service.render(
            doc,
            request(page, 600, 400),
            Some("painter-7:base".to_owned()),
            Box::new(move |result| {
                let _ = reply.send((page, result));
            }),
        );
    }
    drop(sender);
    let mut results: Vec<(i32, Result<Arc<PageBitmap>, Error>)> = receiver.iter().collect();
    results.sort_by_key(|(page, _)| *page);
    assert!(results[0].1.is_ok(), "an unslotted render is never dropped");
    for (page, result) in &results[1..] {
        if *page == 11 {
            assert!(result.is_ok(), "the newest window for the slot is painted");
        } else {
            assert!(
                matches!(result, Err(Error::Cancelled)),
                "page {page} was superseded"
            );
        }
    }
    assert_eq!(
        service.stats().rendered,
        2,
        "only the busy page and the newest window paint"
    );
}

#[test]
fn cancelling_a_slot_or_a_closed_document_drops_queued_work() {
    let (path, _) = write_fixture("cancel", 4);
    let service = PdfService::start();
    let doc = service.open_blocking(path, "").unwrap().doc;
    let (sender, receiver) = mpsc::channel::<(&'static str, Result<Arc<PageBitmap>, Error>)>();
    let busy = sender.clone();
    service.render(
        doc,
        request(0, 3000, 2000),
        None,
        Box::new(move |result| {
            let _ = busy.send(("busy", result));
        }),
    );
    let left = sender.clone();
    service.render(
        doc,
        request(1, 600, 400),
        Some("left".to_owned()),
        Box::new(move |result| {
            let _ = left.send(("left", result));
        }),
    );
    let other = sender.clone();
    service.render(
        doc,
        request(2, 600, 400),
        Some("other".to_owned()),
        Box::new(move |result| {
            let _ = other.send(("other", result));
        }),
    );
    assert_eq!(service.cancel_slot("left"), 1);
    service.close(doc);
    drop(sender);
    let results: Vec<_> = receiver.iter().collect();
    let by = |name: &str| {
        results
            .iter()
            .find(|(label, _)| *label == name)
            .map(|(_, result)| result)
            .unwrap()
    };
    assert!(matches!(by("left"), Err(Error::Cancelled)));
    assert!(
        matches!(by("other"), Err(Error::Cancelled)),
        "closing drops the view's queued windows"
    );
    let after = service.render_blocking(doc, request(1, 60, 40), None);
    assert!(matches!(after, Err(Error::NotOpen)));
}

#[test]
fn a_render_cancelled_while_painting_is_not_sent() {
    let (path, _) = write_fixture("inflight", 1);
    let service = PdfService::start();
    let doc = service.open_blocking(path, "").unwrap().doc;
    let (sender, receiver) = mpsc::channel();
    service.render(
        doc,
        request(0, 4000, 2666),
        Some("zoom".to_owned()),
        Box::new(move |result| {
            let _ = sender.send(result);
        }),
    );
    std::thread::sleep(Duration::from_millis(5));
    service.cancel_slot("zoom");
    let result = receiver.recv().unwrap();
    // Either it was still queued, or it painted into the cache and was not sent.
    assert!(matches!(result, Err(Error::Cancelled)), "{result:?}");
}

#[test]
fn a_missing_or_broken_file_fails_without_stopping_the_worker() {
    let service = PdfService::start();
    let missing = service.open_blocking(std::env::temp_dir().join("fanotes-no-such-file.pdf"), "");
    assert!(matches!(missing, Err(Error::Read(_))));
    let (path, _) = write_fixture("broken", 1);
    std::fs::write(&path, b"%PDF-1.4 not really").unwrap();
    assert!(matches!(
        service.open_blocking(path, ""),
        Err(Error::Open(_))
    ));
    let (good, _) = write_fixture("after-broken", 1);
    assert!(service.open_blocking(good, "").is_ok());
}
